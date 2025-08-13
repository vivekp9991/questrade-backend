// services/dataSync/activitySync.js - Activity Synchronization with Pagination
const questradeApi = require('../questradeApi');
const Account = require('../../models/Account');
const Activity = require('../../models/Activity');
const Person = require('../../models/Person');
const SyncUtils = require('./syncUtils');
const logger = require('../../utils/logger');

class ActivitySync {
  constructor() {
    this.utils = new SyncUtils();
  }

  /**
   * Sync activities for a specific person - ENHANCED WITH 6-MONTH PAGINATION
   */
  async syncActivitiesForPerson(personName, fullSync = false) {
    const result = this.utils.createSyncResult();
    
    try {
      // Validate person and token
      await this.utils.validatePersonForSync(personName);

      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping activity sync`);
        return this.utils.finalizeSyncResult(result);
      }
      
      this.utils.logSyncOperation('Activity sync started', personName, { 
        accountCount: accounts.length,
        fullSync 
      });
      
      for (const account of accounts) {
        try {
          const accountResult = await this.syncActivitiesForAccount(account, personName, fullSync);
          result.synced += accountResult.synced;
          result.errors.push(...accountResult.errors);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          this.utils.logSyncError('Activity sync for account', personName, accountError, {
            accountId: account.accountId
          });
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'ACTIVITIES_SYNC_ERROR',
        error: error.message
      });
      this.utils.logSyncError('Activity sync', personName, error);
      throw error;
    }

    this.utils.logSyncOperation('Activity sync completed', personName, {
      synced: result.synced,
      errors: result.errors.length
    });

    return this.utils.finalizeSyncResult(result);
  }

  /**
   * Sync activities for a single account
   */
  async syncActivitiesForAccount(account, personName, fullSync) {
    const result = { synced: 0, errors: [] };

    try {
      // Calculate date range
      const { startDate, endDate } = this.utils.calculateSyncDateRange(fullSync);
      
      this.utils.logSyncOperation('Account activity sync', personName, {
        accountId: account.accountId,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        fullSync
      });

      // Use pagination-enabled fetch
      const allActivities = await this.fetchActivitiesWithPagination(
        account.accountId,
        personName,
        startDate,
        endDate
      );

      if (allActivities.length === 0) {
        logger.info(`No activities found for account ${account.accountId} in the specified date range`);
        return result;
      }

      logger.info(`Processing ${allActivities.length} activities for account ${account.accountId}`);

      // Process activities with deduplication
      let newActivitiesCount = 0;
      let duplicateActivitiesCount = 0;

      for (const activityData of allActivities) {
        try {
          const processed = await this.processActivity(activityData, account.accountId, personName);
          
          if (processed.isNew) {
            newActivitiesCount++;
            result.synced++;
          } else {
            duplicateActivitiesCount++;
          }
        } catch (activityError) {
          result.errors.push({
            accountId: account.accountId,
            activityType: activityData.type,
            error: activityError.message
          });
          logger.error(`Failed to save activity:`, activityError);
        }
      }

      this.utils.logSyncOperation('Account activity processing completed', personName, {
        accountId: account.accountId,
        newActivities: newActivitiesCount,
        duplicates: duplicateActivitiesCount,
        totalProcessed: allActivities.length
      });

    } catch (error) {
      logger.error(`Failed to sync activities for account ${account.accountId}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Fetch activities with pagination and chunking
   */
  async fetchActivitiesWithPagination(accountId, personName, startDate, endDate, maxRetries = 3) {
    const allActivities = [];
    let totalFetched = 0;
    let totalErrors = 0;

    // Split the date range into manageable chunks
    const dateChunks = this.utils.splitDateRangeIntoChunks(
      startDate, 
      endDate, 
      this.utils.QUESTRADE_LIMITS.MAX_DAYS_PER_REQUEST
    );

    logger.info(`Fetching activities for account ${accountId} in ${dateChunks.length} date chunks`, {
      service: "questrade-portfolio",
      personName,
      accountId,
      dateRange: `${this.utils.formatDateForQuestrade(startDate)} to ${this.utils.formatDateForQuestrade(endDate)}`,
      chunks: dateChunks.length
    });

    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i];
      let retryCount = 0;
      let chunkSuccess = false;

      while (retryCount < maxRetries && !chunkSuccess) {
        try {
          logger.info(`Fetching chunk ${i + 1}/${dateChunks.length} for account ${accountId}: ${chunk.startFormatted} to ${chunk.endFormatted}`);

          const activitiesData = await questradeApi.getAccountActivities(
            accountId,
            personName,
            chunk.startFormatted,
            chunk.endFormatted
          );

          if (activitiesData && activitiesData.activities) {
            const chunkActivities = activitiesData.activities;
            allActivities.push(...chunkActivities);
            totalFetched += chunkActivities.length;

            logger.info(`Retrieved ${chunkActivities.length} activities from chunk ${i + 1}/${dateChunks.length}`);
            chunkSuccess = true;

            // Add delay between requests to avoid rate limiting
            if (i < dateChunks.length - 1) {
              await this.utils.sleep(this.utils.QUESTRADE_LIMITS.REQUEST_DELAY_MS);
            }
          } else {
            logger.warn(`No activities data received for chunk ${i + 1}/${dateChunks.length}`);
            chunkSuccess = true; // Consider empty response as success
          }

        } catch (error) {
          retryCount++;
          totalErrors++;

          logger.error(`Error fetching chunk ${i + 1}/${dateChunks.length}, attempt ${retryCount}/${maxRetries}:`, {
            error: error.message,
            accountId,
            personName
          });

          if (retryCount >= maxRetries) {
            logger.error(`Failed to fetch chunk ${i + 1}/${dateChunks.length} after ${maxRetries} attempts`);
            // Continue with next chunk instead of failing completely
            break;
          } else {
            // Exponential backoff for retries
            const delayMs = Math.pow(2, retryCount) * 1000;
            logger.info(`Retrying chunk ${i + 1} in ${delayMs}ms...`);
            await this.utils.sleep(delayMs);
          }
        }
      }
    }

    logger.info(`Completed activities fetch for account ${accountId}: ${totalFetched} activities in ${dateChunks.length} chunks with ${totalErrors} errors`);

    return allActivities;
  }

  /**
   * Process a single activity with deduplication
   */
  async processActivity(activityData, accountId, personName) {
    // Determine activity type
    const activityType = this.utils.determineActivityType(activityData.type);

    const activityDoc = {
      personName,
      accountId,
      tradeDate: activityData.tradeDate,
      transactionDate: activityData.transactionDate,
      settlementDate: activityData.settlementDate,
      action: activityData.action,
      symbol: activityData.symbol,
      symbolId: activityData.symbolId,
      description: activityData.description,
      currency: activityData.currency,
      quantity: activityData.quantity,
      price: activityData.price,
      grossAmount: activityData.grossAmount,
      commission: activityData.commission,
      netAmount: activityData.netAmount,
      type: activityType,
      rawType: activityData.type,
      isDividend: activityType === 'Dividend',
      dividendPerShare: activityType === 'Dividend' && activityData.quantity > 0 ? 
        Math.abs(activityData.netAmount) / activityData.quantity : 0,
      createdAt: new Date()
    };

    // Enhanced deduplication - check if activity already exists
    const existingActivity = await this.utils.activityExists(activityData, personName, accountId);

    if (!existingActivity) {
      await Activity.create(activityDoc);
      return { isNew: true, activity: activityDoc };
    } else {
      return { isNew: false, activity: existingActivity };
    }
  }

  /**
   * Get activity statistics for a person
   */
  async getActivityStatistics(personName) {
    try {
      const activities = await Activity.aggregate([
        { $match: { personName } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$netAmount' },
            avgAmount: { $avg: '$netAmount' },
            earliestDate: { $min: '$transactionDate' },
            latestDate: { $max: '$transactionDate' }
          }
        },
        { $sort: { count: -1 } }
      ]);

      const totalActivities = await Activity.countDocuments({ personName });
      const dividendActivities = await Activity.countDocuments({ 
        personName, 
        type: 'Dividend' 
      });

      // Get date range of activities
      const dateRange = await Activity.aggregate([
        { $match: { personName } },
        {
          $group: {
            _id: null,
            earliestDate: { $min: '$transactionDate' },
            latestDate: { $max: '$transactionDate' }
          }
        }
      ]);

      return {
        personName,
        totalActivities,
        dividendActivities,
        dateRange: dateRange[0] || null,
        byType: activities,
        lastUpdated: new Date()
      };
    } catch (error) {
      logger.error(`Failed to get activity statistics for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Bulk sync activities for multiple accounts with enhanced progress tracking
   */
  async bulkSyncActivities(personNames = null, options = {}) {
    const { 
      fullSync = true, 
      maxConcurrent = 2,
      progressCallback = null 
    } = options;

    let persons;
    if (personNames) {
      persons = await Person.find({ 
        personName: { $in: personNames }, 
        isActive: true 
      });
    } else {
      persons = await Person.find({ isActive: true });
    }

    const results = [];
    let completed = 0;

    logger.info(`Starting bulk activities sync for ${persons.length} person(s)`, {
      service: "questrade-portfolio",
      personCount: persons.length,
      fullSync,
      maxConcurrent
    });

    // Process persons in batches to avoid overwhelming the API
    for (let i = 0; i < persons.length; i += maxConcurrent) {
      const batch = persons.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async (person) => {
        try {
          const startTime = Date.now();
          const result = await this.syncActivitiesForPerson(person.personName, fullSync);
          const duration = Date.now() - startTime;
          
          completed++;
          
          const personResult = {
            personName: person.personName,
            success: true,
            duration,
            ...result
          };

          if (progressCallback) {
            progressCallback({
              completed,
              total: persons.length,
              current: person.personName,
              result: personResult
            });
          }

          return personResult;
        } catch (error) {
          completed++;
          
          const errorResult = {
            personName: person.personName,
            success: false,
            error: error.message,
            duration: 0
          };

          if (progressCallback) {
            progressCallback({
              completed,
              total: persons.length,
              current: person.personName,
              result: errorResult
            });
          }

          return errorResult;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Add delay between batches
      if (i + maxConcurrent < persons.length) {
        await this.utils.sleep(1000);
      }
    }

    const summary = {
      totalPersons: persons.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      totalActivitiesSynced: results
        .filter(r => r.success)
        .reduce((sum, r) => sum + (r.synced || 0), 0),
      totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
      results
    };

    logger.info(`Bulk activities sync completed`, {
      service: "questrade-portfolio",
      summary
    });

    return summary;
  }

  /**
   * Clean up old activities (optional maintenance function)
   */
  async cleanupOldActivities(personName, retentionMonths = 24) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

      const deleteResult = await Activity.deleteMany({
        personName,
        transactionDate: { $lt: cutoffDate }
      });

      logger.info(`Cleaned up old activities for ${personName}`, {
        service: "questrade-portfolio",
        personName,
        deletedCount: deleteResult.deletedCount,
        cutoffDate: cutoffDate.toISOString()
      });

      return {
        deletedCount: deleteResult.deletedCount,
        cutoffDate
      };
    } catch (error) {
      logger.error(`Failed to cleanup old activities for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get activity sync status for a person
   */
  async getActivitySyncStatus(personName) {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const totalActivities = await Activity.countDocuments({ personName });
      const recentActivities = await Activity.countDocuments({
        personName,
        createdAt: { $gte: oneDayAgo }
      });

      // Get latest activity
      const latestActivity = await Activity.findOne({ personName })
        .sort({ transactionDate: -1 })
        .select('transactionDate type symbol netAmount');

      // Get activity breakdown by type
      const breakdown = await Activity.aggregate([
        { $match: { personName } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      // Check for stale data
      const staleActivities = await Activity.countDocuments({
        personName,
        createdAt: { $lt: oneWeekAgo }
      });

      return {
        personName,
        totalActivities,
        recentActivities,
        staleActivities,
        latestActivity,
        breakdown,
        lastChecked: now
      };
    } catch (error) {
      logger.error(`Error getting activity sync status for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Validate activity data integrity
   */
  async validateActivityData(personName) {
    try {
      const activities = await Activity.find({ personName });
      const issues = [];

      for (const activity of activities) {
        // Check for missing required fields
        if (!activity.transactionDate) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Missing transaction date' 
          });
        }

        if (!activity.type) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Missing activity type' 
          });
        }

        if (activity.netAmount === undefined || activity.netAmount === null) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Missing net amount' 
          });
        }

        // Check for data consistency
        if (activity.type === 'Dividend' && (!activity.symbol || !activity.symbolId)) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Dividend missing symbol information' 
          });
        }

        if (activity.type === 'Trade' && !activity.action) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Trade missing action (Buy/Sell)' 
          });
        }

        // Check for unrealistic values
        if (activity.commission && activity.commission < 0) {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Negative commission' 
          });
        }

        if (activity.quantity && activity.quantity < 0 && activity.type !== 'Withdrawal') {
          issues.push({ 
            activityId: activity._id, 
            issue: 'Unexpected negative quantity' 
          });
        }
      }

      return {
        activityCount: activities.length,
        issues,
        isValid: issues.length === 0
      };
    } catch (error) {
      logger.error(`Error validating activity data for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = ActivitySync;