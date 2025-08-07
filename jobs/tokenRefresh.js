// jobs/tokenRefresh.js
const cron = require('node-cron');
const questradeApi = require('../services/questradeApi');
const logger = require('../utils/logger');

// Refresh token every 6 days (tokens expire in 7 days)
const tokenRefreshJob = cron.schedule('0 0 */6 * *', async () => {
  try {
    logger.info('Starting scheduled token refresh...');
    await questradeApi.refreshAccessToken();
    logger.info('Token refresh completed successfully');
  } catch (error) {
    logger.error('Scheduled token refresh failed:', error);
  }
}, {
  scheduled: false
});

module.exports = tokenRefreshJob;