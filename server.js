// server.js - FIXED VERSION
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const logger = require('./utils/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');

// Import all route modules
const authRoutes = require('./routes/auth');
const portfolioRoutes = require('./routes/portfolio');
const marketRoutes = require('./routes/market');
const accountRoutes = require('./routes/accounts');
const personsRoutes = require('./routes/persons');  // ADDED: Missing persons routes
const settingsRoutes = require('./routes/settings'); // ADDED: Missing settings routes
const healthRoutes = require('./routes/health');     // ADDED: Missing health routes

// Import job schedulers
const tokenRefreshJob = require('./jobs/tokenRefresh');
const { dataSyncJob, snapshotJob } = require('./jobs/dataSync');

const app = express();
const PORT = process.env.PORT || 4000; // Changed from 3000 to 4000 to match your curl

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});

const snapQuoteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit snap quotes to 10 per minute
  message: {
    error: 'Too many snap quote requests, please try again later.'
  }
});

app.use('/api/', limiter);
app.use('/api/market/quote', snapQuoteLimiter);

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });
  next();
});

// Routes - FIXED: Added all missing routes
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/persons', personsRoutes);        // ADDED: Persons routes
app.use('/api/settings', settingsRoutes);      // ADDED: Settings routes
app.use('/api/health', healthRoutes);          // ADDED: Health routes

// Sync routes (from portfolio routes but can be separate)
const syncRoutes = require('./routes/sync');
app.use('/api/sync', syncRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Portfolio Manager API',
    version: '2.0.0',
    description: 'Multi-person portfolio management with Questrade integration',
    endpoints: {
      auth: '/api/auth',
      persons: '/api/persons',
      accounts: '/api/accounts', 
      portfolio: '/api/portfolio',
      market: '/api/market',
      sync: '/api/sync',
      settings: '/api/settings',
      health: '/api/health'
    },
    docs: 'See README.md for API documentation'
  });
});

// 404 handler
app.use(notFound);

// Error handling middleware
app.use(errorHandler);

// Database connection and server startup
async function startServer() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    logger.info('Connected to MongoDB');
    
    // Start cron jobs only in production or when explicitly enabled
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_JOBS === 'true') {
      tokenRefreshJob.start();
      dataSyncJob.start();
      snapshotJob.start();
      logger.info('Cron jobs started');
    } else {
      logger.info('Cron jobs disabled in development mode');
    }
    
    // Start server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📊 API available at: http://localhost:${PORT}/api`);
      logger.info(`❤️  Health check: http://localhost:${PORT}/health`);
      
      // Log available routes
      logger.info('Available API endpoints:');
      logger.info(`  - GET  /api/persons           - List all persons`);
      logger.info(`  - POST /api/persons           - Add new person`);
      logger.info(`  - GET  /api/accounts          - List accounts`);
      logger.info(`  - GET  /api/portfolio/summary - Portfolio summary`);
      logger.info(`  - GET  /api/health/system     - System health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown(server));
    process.on('SIGINT', () => gracefulShutdown(server));
    
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown function
async function gracefulShutdown(server) {
  logger.info('Received shutdown signal, shutting down gracefully...');
  
  // Stop accepting new requests
  server.close(async () => {
    logger.info('HTTP server closed');
    
    try {
      // Stop cron jobs
      if (tokenRefreshJob) tokenRefreshJob.stop();
      if (dataSyncJob) dataSyncJob.stop(); 
      if (snapshotJob) snapshotJob.stop();
      logger.info('Cron jobs stopped');
      
      // Close database connection
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
      
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the server
startServer();