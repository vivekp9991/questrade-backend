// services/dataSync/syncUtils.js - Common Utilities and Helpers
const Person = require('../../models/Person');
const Account = require('../../models/Account');
const Position = require('../../models/Position');
const Activity = require('../../models/Activity');
const logger = require('../../utils/logger');

class SyncUtils {
  constructor() {
    // Questrade API limits and pagination settings
    this.QUESTRADE_LIMITS = {
      MAX_DAYS_PER_REQUEST: 31,        // Questrade limit: max 31 days per request
      MAX_ACTIVITIES_PER_REQUEST: 1000, // Estimated limit per request
      REQUEST_DELAY_MS: 100,           // Delay between requests to avoid rate limiting
      MAX_RETRIES: 3                   // Max retries for failed requests
    };
  }

  /**
   * Format date for Questrade API - FIXED VERSION
   * Questrade requires ISO 8601 format with timezone: YYYY-MM-DDTHH:mm:ss-05:00
   */
  formatDateForQuestrade(date) {
    const d = new Date(date);
    
    // Get date components
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    // For activities, Questrade expects date-only format with Eastern timezone
    // Format: YYYY-MM-DDTHH:mm:ss-05:00 (Eastern Time)
    return `${year}-${month}-${day}T00:00:00-05:00`;
  }

  /**
   * Split date range into chunks that respect Questrade's 31-day limit
   */
  splitDateRangeIntoChunks(startDate, endDate, maxDaysPerChunk = 31) {
    const chunks = [];
    let currentStart = new Date(startDate);
    const finalEnd = new Date(endDate);

    while (currentStart <= finalEnd) {
      let currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() + maxDaysPerChunk - 1);
      
      // Don't exceed the final end date
      if (currentEnd > finalEnd) {
        currentEnd = new Date(finalEnd);
      }

      chunks.push({
        startDate: new Date(currentStart),
        endDate: new Date(currentEnd),
        startFormatted: this.formatDateForQuestrade(currentStart),
        endFormatted: this.formatDateForQuestrade(currentEnd)
      });

      // Move to next chunk
      currentStart = new Date(currentEnd);
      currentStart.setDate(currentStart.getDate() + 1);
    }

    return chunks;
  }

  /**
   * Get sync status for a person
   */
  async getSyncStatus(personName, syncInProgressMap) {
    const person = await Person.findOne({ personName });
    if (!person) {
      return null;
    }

    const accountCount = await Account.countDocuments({ personName });
    const positionCount = await Position.countDocuments({ personName });
    const activityCount = await Activity.countDocuments({ personName });

    return {
      personName,
      lastSyncTime: person.lastSyncTime,
      lastSyncStatus: person.lastSyncStatus,
      lastSyncError: person.lastSyncError,
      lastSyncResults: person.lastSyncResults,
      isInProgress: syncInProgressMap.get(personName) || false,
      counts: {
        accounts: accountCount,
        positions: positionCount,
        activities: activityCount
      }
    };
  }

  /**
   * Get sync status for all persons
   */
  async getAllSyncStatuses(syncInProgressMap) {
    const persons = await Person.find({});
    const statuses = [];

    for (const person of persons) {
      const status = await this.getSyncStatus(person.personName, syncInProgressMap);
      statuses.push(status);
    }

    return statuses;
  }

  /**
   * Sleep for specified milliseconds
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry a function with exponential backoff
   */
  async retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (attempt === maxRetries) {
          break;
        }
        
        const delay = initialDelay * Math.pow(2, attempt - 1);
        logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`, { error: error.message });
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Validate person and token before sync
   */
  async validatePersonForSync(personName) {
    const person = await Person.findOne({ personName });
    if (!person) {
      throw new Error(`Person ${personName} not found`);
    }

    if (!person.isActive) {
      throw new Error(`Person ${personName} is inactive`);
    }

    const Token = require('../../models/Token');
    const token = await Token.findOne({ 
      personName, 
      type: 'refresh', 
      isActive: true 
    });
    
    if (!token) {
      throw new Error(`No active refresh token found for person ${personName}`);
    }

    return { person, token };
  }

  /**
   * Log sync operation with standard format
   */
  logSyncOperation(operation, personName, details = {}) {
    logger.info(`${operation} for ${personName}`, {
      service: "questrade-portfolio",
      personName,
      operation,
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  /**
   * Log sync error with standard format
   */
  logSyncError(operation, personName, error, details = {}) {
    logger.error(`${operation} failed for ${personName}`, {
      service: "questrade-portfolio",
      personName,
      operation,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  /**
   * Create standard sync result object
   */
  createSyncResult() {
    return {
      synced: 0,
      errors: [],
      startTime: new Date()
    };
  }

  /**
   * Finalize sync result with timing
   */
  finalizeSyncResult(result) {
    result.endTime = new Date();
    result.duration = result.endTime - result.startTime;
    return result;
  }

  /**
   * Determine activity type from raw Questrade type
   */
  determineActivityType(rawType) {
    const type = (rawType || '').toLowerCase();
    
    if (type.includes('trade')) return 'Trade';
    if (type.includes('dividend')) return 'Dividend';
    if (type.includes('deposit')) return 'Deposit';
    if (type.includes('withdrawal')) return 'Withdrawal';
    if (type.includes('interest')) return 'Interest';
    if (type.includes('transfer')) return 'Transfer';
    if (type.includes('fee')) return 'Fee';
    if (type.includes('tax')) return 'Tax';
    if (type.includes('fx') || type.includes('exchange')) return 'FX';
    
    return 'Other';
  }

  /**
   * Check if activity already exists (for deduplication)
   */
  async activityExists(activityData, personName, accountId) {
    return await Activity.findOne({
      personName,
      accountId,
      transactionDate: activityData.transactionDate,
      symbol: activityData.symbol || null,
      netAmount: activityData.netAmount,
      type: this.determineActivityType(activityData.type),
      description: activityData.description
    });
  }

  /**
   * Calculate date range for sync operation
   */
  calculateSyncDateRange(fullSync = false) {
    const endDate = new Date();
    const startDate = new Date();
    
    if (fullSync) {
      startDate.setMonth(startDate.getMonth() - 6); // Last 6 months for full sync
    } else {
      startDate.setMonth(startDate.getMonth() - 1); // Last 1 month for incremental
    }
    
    return { startDate, endDate };
  }

  /**
   * Update account statistics after position sync
   */
  async updateAccountStatistics(accountId, personName) {
    try {
      const accountPositions = await Position.find({ accountId, personName });
      const numberOfPositions = accountPositions.length;
      const totalInvestment = accountPositions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
      const currentValue = accountPositions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
      const dayPnl = accountPositions.reduce((sum, p) => sum + (p.dayPnl || 0), 0);
      const openPnl = accountPositions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
      const closedPnl = accountPositions.reduce((sum, p) => sum + (p.closedPnl || 0), 0);
      const totalPnl = openPnl + closedPnl;

      // Calculate net deposits from activities
      const depositAgg = await Activity.aggregate([
        { $match: { accountId, personName, type: 'Deposit' } },
        { $group: { _id: null, total: { $sum: '$netAmount' } } }
      ]);
      const withdrawalAgg = await Activity.aggregate([
        { $match: { accountId, personName, type: 'Withdrawal' } },
        { $group: { _id: null, total: { $sum: '$netAmount' } } }
      ]);
      const netDeposits = (depositAgg[0]?.total || 0) - (withdrawalAgg[0]?.total || 0);

      await Account.findOneAndUpdate(
        { accountId, personName },
        {
          numberOfPositions,
          totalInvestment,
          currentValue,
          dayPnl,
          openPnl,
          closedPnl,
          totalPnl,
          netDeposits,
          updatedAt: new Date()
        }
      );

      return {
        numberOfPositions,
        totalInvestment,
        currentValue,
        netDeposits
      };
    } catch (error) {
      logger.error(`Failed to update stats for account ${accountId}:`, error);
      throw error;
    }
  }
}

module.exports = SyncUtils;