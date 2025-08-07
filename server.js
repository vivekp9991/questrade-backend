// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const logger = require('./utils/logger');
const authRoutes = require('./routes/auth');
const portfolioRoutes = require('./routes/portfolio');
const marketRoutes = require('./routes/market');
const tokenRefreshJob = require('./jobs/tokenRefresh');
const { dataSyncJob, snapshotJob } = require('./jobs/dataSync');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

const snapQuoteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10 // limit snap quotes to 10 per minute
});

app.use('/api/', limiter);
app.use('/api/market/quote', snapQuoteLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market', marketRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB');
  
  // Start cron jobs
  tokenRefreshJob.start();
  dataSyncJob.start();
  snapshotJob.start();
  logger.info('Cron jobs started');
  
  // Start server
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
})
.catch(err => {
  logger.error('MongoDB connection error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  
  // Stop cron jobs
  tokenRefreshJob.stop();
  dataSyncJob.stop();
  snapshotJob.stop();
  
  // Close database connection
  await mongoose.connection.close();
  
  process.exit(0);
});