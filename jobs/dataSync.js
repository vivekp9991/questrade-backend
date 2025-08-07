// jobs/dataSync.js
const cron = require('node-cron');
const dataSync = require('../services/dataSync');
const logger = require('../utils/logger');

// Sync data every hour during market hours (9:30 AM - 4:00 PM ET)
const dataSyncJob = cron.schedule('0 30-59 9-15 * * 1-5', async () => {
  try {
    logger.info('Starting scheduled data sync...');
    await dataSync.fullSync();
    logger.info('Data sync completed successfully');
  } catch (error) {
    logger.error('Scheduled data sync failed:', error);
  }
}, {
  scheduled: false,
  timezone: 'America/Toronto'
});

// Daily snapshot at market close
const snapshotJob = cron.schedule('30 16 * * 1-5', async () => {
  try {
    logger.info('Creating daily portfolio snapshot...');
    await dataSync.createPortfolioSnapshot();
    logger.info('Portfolio snapshot created successfully');
  } catch (error) {
    logger.error('Failed to create portfolio snapshot:', error);
  }
}, {
  scheduled: false,
  timezone: 'America/Toronto'
});

module.exports = { dataSyncJob, snapshotJob };