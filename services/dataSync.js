// services/dataSync.js - ENHANCED VERSION - 6 Months Activities with Pagination
const questradeApi = require('./questradeApi');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const Person = require('../models/Person');
const Token = require('../models/Token');
const Symbol = require('../models/Symbol');
const logger = require('../utils/logger');

class DataSyncService {
  constructor() {
    this.syncInProgress = new Map(); // Track sync status per person
    
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
   * Fetch activities with pagination and chunking
   */
  async fetchActivitiesWithPagination(accountId, personName, startDate, endDate, maxRetries = 3) {
    const allActivities = [];
    let totalFetched = 0;
    let totalErrors = 0;

    // Split the date range into manageable chunks
    const dateChunks = this.splitDateRangeIntoChunks(
      startDate, 
      endDate, 
      this.QUESTRADE_LIMITS.MAX_DAYS_PER_REQUEST
    );

    logger.info(`Fetching activities for account ${accountId} in ${dateChunks.length} date chunks`, {
      service: "questrade-portfolio",
      personName,
      accountId,
      dateRange: `${this.formatDateForQuestrade(startDate)} to ${this.formatDateForQuestrade(endDate)}`,
      chunks: dateChunks.length,
      timestamp: new Date().toISOString()
    });

    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i];
      let retryCount = 0;
      let chunkSuccess = false;

      while (retryCount < maxRetries && !chunkSuccess) {
        try {
          logger.info(`Fetching chunk ${i + 1}/${dateChunks.length} for account ${accountId}: ${chunk.startFormatted} to ${chunk.endFormatted}`, {
            service: "questrade-portfolio",
            personName,
            accountId,
            chunkIndex: i + 1,
            totalChunks: dateChunks.length,
            retryCount: retryCount + 1,
            timestamp: new Date().toISOString()
          });

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

            logger.info(`Retrieved ${chunkActivities.length} activities from chunk ${i + 1}/${dateChunks.length}`, {
              service: "questrade-portfolio",
              personName,
              accountId,
              chunkActivities: chunkActivities.length,
              totalSoFar: totalFetched,
              timestamp: new Date().toISOString()
            });

            chunkSuccess = true;

            // Add delay between requests to avoid rate limiting
            if (i < dateChunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, this.QUESTRADE_LIMITS.REQUEST_DELAY_MS));
            }
          } else {
            logger.warn(`No activities data received for chunk ${i + 1}/${dateChunks.length}`, {
              service: "questrade-portfolio",
              personName,
              accountId,
              timestamp: new Date().toISOString()
            });
            chunkSuccess = true; // Consider empty response as success
          }

        } catch (error) {
          retryCount++;
          totalErrors++;

          logger.error(`Error fetching chunk ${i + 1}/${dateChunks.length}, attempt ${retryCount}/${maxRetries}:`, {
            service: "questrade-portfolio",
            personName,
            accountId,
            error: error.message,
            chunkIndex: i + 1,
            retryCount,
            timestamp: new Date().toISOString()
          });

          if (retryCount >= maxRetries) {
            logger.error(`Failed to fetch chunk ${i + 1}/${dateChunks.length} after ${maxRetries} attempts`, {
              service: "questrade-portfolio",
              personName,
              accountId,
              error: error.message,
              timestamp: new Date().toISOString()
            });
            
            // Continue with next chunk instead of failing completely
            break;
          } else {
            // Exponential backoff for retries
            const delayMs = Math.pow(2, retryCount) * 1000;
            logger.info(`Retrying chunk ${i + 1} in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }
    }

    logger.info(`Completed activities fetch for account ${accountId}: ${totalFetched} activities in ${dateChunks.length} chunks with ${totalErrors} errors`, {
      service: "questrade-portfolio",
      personName,
      accountId,
      totalActivities: totalFetched,
      totalChunks: dateChunks.length,
      totalErrors,
      timestamp: new Date().toISOString()
    });

    return allActivities;
  }

  /**
   * Sync all data for a specific person
   */
  async syncPersonData(personName, options = {}) {
    const { fullSync = false, forceRefresh = false } = options;
    
    if (this.syncInProgress.get(personName)) {
      throw new Error(`Sync already in progress for ${personName}`);
    }

    this.syncInProgress.set(personName, true);
    
    try {
      logger.info(`Starting sync for person: ${personName}`, {
        service: "questrade-portfolio",
        timestamp: new Date().toISOString()
      });
      
      // Verify person exists and has valid token
      const person = await Person.findOne({ personName });
      if (!person) {
        throw new Error(`Person ${personName} not found`);
      }

      const token = await Token.findOne({ personName, type: 'refresh', isActive: true });
      if (!token) {
        throw new Error(`No active refresh token found for person ${personName}`);
      }

      const syncResults = {
        personName,
        startTime: new Date(),
        accounts: { synced: 0, errors: [] },
        positions: { synced: 0, errors: [] },
        activities: { synced: 0, errors: [] },
        snapshots: { created: false, error: null },
        service: "questrade-portfolio"
      };

      // Sync accounts first
      logger.info(`Syncing accounts for ${personName}...`, {
        service: "questrade-portfolio",
        timestamp: new Date().toISOString()
      });
      
      const accountsResult = await this.syncAccountsForPerson(personName, fullSync);
      syncResults.accounts = accountsResult;
      
      logger.info(`Account sync completed for ${personName}: ${accountsResult.synced} synced, ${accountsResult.errors.length} errors`, {
        service: "questrade-portfolio",
        timestamp: new Date().toISOString()
      });

      // If accounts sync was successful, sync positions and activities
      if (accountsResult.synced > 0 || accountsResult.errors.length === 0) {
        logger.info(`Syncing positions for ${personName}...`, {
          service: "questrade-portfolio",
          timestamp: new Date().toISOString()
        });
        
        const positionsResult = await this.syncPositionsForPerson(personName, fullSync);
        syncResults.positions = positionsResult;
        
        logger.info(`Position sync completed for ${personName}: ${positionsResult.synced} synced, ${positionsResult.errors.length} errors`, {
          service: "questrade-portfolio",
          timestamp: new Date().toISOString()
        });

        // Sync activities (with enhanced 6-month pagination)
        logger.info(`Syncing activities for ${personName}...`, {
          service: "questrade-portfolio",
          timestamp: new Date().toISOString()
        });
        
        const activitiesResult = await this.syncActivitiesForPerson(personName, fullSync);
        syncResults.activities = activitiesResult;
        
        logger.info(`Activity sync completed for ${personName}: ${activitiesResult.synced} synced, ${activitiesResult.errors.length} errors`, {
          service: "questrade-portfolio",
          timestamp: new Date().toISOString()
        });

        // Create portfolio snapshot if requested
        if (fullSync || forceRefresh) {
          try {
            logger.info(`Creating portfolio snapshot for ${personName}...`, {
              service: "questrade-portfolio",
              timestamp: new Date().toISOString()
            });
            
            const snapshot = await this.createPortfolioSnapshot(personName);
            syncResults.snapshots.created = true;
            
            logger.info(`Created portfolio snapshot for ${personName}: $${snapshot.currentValue.toFixed(2)}`, {
              service: "questrade-portfolio",
              timestamp: new Date().toISOString()
            });
          } catch (snapshotError) {
            syncResults.snapshots.error = snapshotError.message;
            logger.error(`Snapshot creation failed for ${personName}:`, snapshotError);
          }
        }
      }

      // Update person's last sync time
      await Person.findOneAndUpdate(
        { personName },
        { 
          lastSyncTime: new Date(),
          lastSyncStatus: 'success',
          lastSyncResults: syncResults,
          lastSyncError: null
        }
      );

      syncResults.endTime = new Date();
      syncResults.duration = syncResults.endTime - syncResults.startTime;
      
      logger.info(`Sync completed for person: ${personName}`, {
        ...syncResults,
        service: "questrade-portfolio",
        timestamp: new Date().toISOString()
      });
      
      return syncResults;

    } catch (error) {
      logger.error(`Sync failed for person: ${personName}`, error);
      
      // Update person's sync status
      await Person.findOneAndUpdate(
        { personName },
        { 
          lastSyncTime: new Date(),
          lastSyncStatus: 'failed',
          lastSyncError: error.message
        }
      );

      throw error;
    } finally {
      this.syncInProgress.set(personName, false);
    }
  }

  /**
   * Sync data for all persons
   */
  async syncAllPersons(options = {}) {
    const { fullSync = false, continueOnError = true } = options;
    
    const persons = await Person.find({ isActive: true });
    const allResults = [];

    for (const person of persons) {
      try {
        const result = await this.syncPersonData(person.personName, { fullSync });
        allResults.push(result);
      } catch (error) {
        const errorResult = {
          personName: person.personName,
          error: error.message,
          success: false
        };
        allResults.push(errorResult);
        
        if (!continueOnError) {
          throw error;
        }
      }
    }

    return allResults;
  }

  /**
   * Sync accounts for a specific person
   */
  async syncAccountsForPerson(personName, fullSync = false) {
    const result = { synced: 0, errors: [] };
    
    try {
      const accountsData = await questradeApi.getAccounts(personName);
      
      if (!accountsData || !accountsData.accounts) {
        throw new Error('No accounts data received from API');
      }

      logger.info(`Found ${accountsData.accounts.length} accounts for ${personName}`, {
        service: "questrade-portfolio",
        timestamp: new Date().toISOString()
      });
      
      for (const accountData of accountsData.accounts) {
        try {
          const accountDoc = {
            personName,
            accountId: accountData.number,
            type: accountData.type,
            number: accountData.number,
            status: accountData.status,
            isPrimary: accountData.isPrimary,
            isBilling: accountData.isBilling,
            clientAccountType: accountData.clientAccountType,
            syncedAt: new Date()
          };

          await Account.findOneAndUpdate(
            { accountId: accountData.number, personName },
            accountDoc,
            { upsert: true, new: true }
          );

          result.synced++;
        } catch (accountError) {
          result.errors.push({
            accountId: accountData.number,
            error: accountError.message
          });
          logger.error(`Failed to sync account ${accountData.number}:`, accountError);
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'API_ERROR',
        error: error.message
      });
      logger.error(`Account sync failed for ${personName}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Sync positions for a specific person
   */
  async syncPositionsForPerson(personName, fullSync = false) {
    const result = { synced: 0, errors: [] };
    
    try {
      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping position sync`);
        return result;
      }
      
      for (const account of accounts) {
        try {
          const positionsData = await questradeApi.getAccountPositions(account.accountId, personName);
          
          if (!positionsData || !positionsData.positions) {
            logger.info(`Processing 0 positions for account ${account.accountId}`, {
              service: "questrade-portfolio",
              timestamp: new Date().toISOString()
            });
            continue;
          }

          // Clear existing positions for this account if full sync
          if (fullSync) {
            await Position.deleteMany({ accountId: account.accountId, personName });
          }

          logger.info(`Processing ${positionsData.positions.length} positions for account ${account.accountId}`, {
            service: "questrade-portfolio",
            timestamp: new Date().toISOString()
          });

          for (const positionData of positionsData.positions) {
            try {
              // Calculate additional metrics
              const totalReturnValue = (positionData.openPnl || 0);
              const totalReturnPercent = positionData.totalCost > 0 ? 
                (totalReturnValue / positionData.totalCost) * 100 : 0;
              const capitalGainPercent = positionData.totalCost > 0 ? 
                ((positionData.openPnl || 0) / positionData.totalCost) * 100 : 0;

              const positionDoc = {
                personName,
                accountId: account.accountId,
                symbolId: positionData.symbolId,
                symbol: positionData.symbol,
                openQuantity: positionData.openQuantity,
                closedQuantity: positionData.closedQuantity || 0,
                currentMarketValue: positionData.currentMarketValue,
                currentPrice: positionData.currentPrice,
                averageEntryPrice: positionData.averageEntryPrice,
                dayPnl: positionData.dayPnl || 0,
                closedPnl: positionData.closedPnl || 0,
                openPnl: positionData.openPnl || 0,
                totalCost: positionData.totalCost,
                isRealTime: positionData.isRealTime,
                isUnderReorg: positionData.isUnderReorg || false,
                
                // Calculated fields
                totalReturnPercent,
                totalReturnValue,
                capitalGainPercent,
                capitalGainValue: positionData.openPnl || 0,
                
                // Initialize dividend data (will be calculated later)
                dividendData: {
                  totalReceived: 0,
                  lastDividendAmount: 0,
                  lastDividendDate: null,
                  dividendReturnPercent: 0,
                  yieldOnCost: 0,
                  dividendAdjustedCost: positionData.totalCost || 0,
                  dividendAdjustedCostPerShare: positionData.averageEntryPrice || 0,
                  monthlyDividend: 0,
                  monthlyDividendPerShare: 0,
                  annualDividend: 0,
                  annualDividendPerShare: 0,
                  dividendFrequency: 0
                },
                
                syncedAt: new Date(),
                updatedAt: new Date()
              };

              await Position.findOneAndUpdate(
                { 
                  accountId: account.accountId,
                  symbolId: positionData.symbolId,
                  personName 
                },
                positionDoc,
                { upsert: true, new: true }
              );

              result.synced++;
            } catch (positionError) {
              result.errors.push({
                accountId: account.accountId,
                symbol: positionData.symbol,
                error: positionError.message
              });
              logger.error(`Failed to save position ${positionData.symbol}:`, positionError);
            }
          }
          
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          logger.error(`Failed to sync positions for account ${account.accountId}:`, accountError);
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'POSITIONS_SYNC_ERROR',
        error: error.message
      });
      logger.error(`Position sync failed for ${personName}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Sync activities for a specific person - ENHANCED WITH 6-MONTH PAGINATION
   */
  async syncActivitiesForPerson(personName, fullSync = false) {
    const result = { synced: 0, errors: [] };
    
    try {
      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping activity sync`);
        return result;
      }
      
      for (const account of accounts) {
        try {
          // ENHANCED: Calculate date range - 6 months for full sync, 1 month for incremental
          const endDate = new Date();
          const startDate = new Date();
          
          if (fullSync) {
            startDate.setMonth(startDate.getMonth() - 6); // Last 6 months for full sync
          } else {
            startDate.setMonth(startDate.getMonth() - 1); // Last 1 month for incremental
          }
          
          logger.info(`Syncing ${fullSync ? '6 months' : '1 month'} of activities for account ${account.accountId}`, {
            service: "questrade-portfolio",
            personName,
            accountId: account.accountId,
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0],
            fullSync,
            timestamp: new Date().toISOString()
          });

          // ENHANCED: Use pagination-enabled fetch
          const allActivities = await this.fetchActivitiesWithPagination(
            account.accountId,
            personName,
            startDate,
            endDate
          );

          if (allActivities.length === 0) {
            logger.info(`No activities found for account ${account.accountId} in the specified date range`, {
              service: "questrade-portfolio",
              timestamp: new Date().toISOString()
            });
            continue;
          }

          logger.info(`Processing ${allActivities.length} activities for account ${account.accountId}`, {
            service: "questrade-portfolio",
            timestamp: new Date().toISOString()
          });

          // Process activities with deduplication
          let newActivitiesCount = 0;
          let duplicateActivitiesCount = 0;

          for (const activityData of allActivities) {
            try {
              // Determine activity type
              let activityType = 'Other';
              const rawType = activityData.type || '';
              
              if (rawType.toLowerCase().includes('trade')) {
                activityType = 'Trade';
              } else if (rawType.toLowerCase().includes('dividend')) {
                activityType = 'Dividend';
              } else if (rawType.toLowerCase().includes('deposit')) {
                activityType = 'Deposit';
              } else if (rawType.toLowerCase().includes('withdrawal')) {
                activityType = 'Withdrawal';
              } else if (rawType.toLowerCase().includes('interest')) {
                activityType = 'Interest';
              } else if (rawType.toLowerCase().includes('transfer')) {
                activityType = 'Transfer';
              } else if (rawType.toLowerCase().includes('fee')) {
                activityType = 'Fee';
              } else if (rawType.toLowerCase().includes('tax')) {
                activityType = 'Tax';
              } else if (rawType.toLowerCase().includes('fx') || rawType.toLowerCase().includes('exchange')) {
                activityType = 'FX';
              }

              const activityDoc = {
                personName,
                accountId: account.accountId,
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
                rawType: rawType,
                isDividend: activityType === 'Dividend',
                dividendPerShare: activityType === 'Dividend' && activityData.quantity > 0 ? 
                  Math.abs(activityData.netAmount) / activityData.quantity : 0,
                createdAt: new Date()
              };

              // Enhanced deduplication - check if activity already exists
              const existingActivity = await Activity.findOne({
                personName,
                accountId: account.accountId,
                transactionDate: activityData.transactionDate,
                symbol: activityData.symbol || null,
                netAmount: activityData.netAmount,
                type: activityType,
                description: activityData.description // Add description to make matching more precise
              });

              if (!existingActivity) {
                await Activity.create(activityDoc);
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

          logger.info(`Activity processing completed for account ${account.accountId}: ${newActivitiesCount} new, ${duplicateActivitiesCount} duplicates`, {
            service: "questrade-portfolio",
            personName,
            accountId: account.accountId,
            newActivities: newActivitiesCount,
            duplicates: duplicateActivitiesCount,
            totalProcessed: allActivities.length,
            timestamp: new Date().toISOString()
          });
          
        } catch (accountError) {
          // IMPROVED ERROR HANDLING: Log specific error details
          const errorMessage = accountError.message || 'Unknown error';
          
          logger.error(`Failed to sync activities for account ${account.accountId}: ${errorMessage}`, {
            service: "questrade-portfolio",
            personName,
            accountId: account.accountId,
            stack: accountError.stack,
            timestamp: new Date().toISOString()
          });
          
          result.errors.push({
            accountId: account.accountId,
            error: errorMessage
          });
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'ACTIVITIES_SYNC_ERROR',
        error: error.message
      });
      logger.error(`Activity sync failed for ${personName}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Create portfolio snapshot for a person
   */
  async createPortfolioSnapshot(personName) {
    try {
      const positions = await Position.find({ personName });
      const accounts = await Account.find({ personName });
      
      const totalInvestment = positions.reduce((sum, pos) => sum + (pos.totalCost || 0), 0);
      const currentValue = positions.reduce((sum, pos) => sum + (pos.currentMarketValue || 0), 0);
      const unrealizedPnl = positions.reduce((sum, pos) => sum + (pos.openPnl || 0), 0);
      const totalDividends = positions.reduce((sum, pos) => 
        sum + (pos.dividendData?.totalReceived || 0), 0);
      
      const totalReturnValue = unrealizedPnl + totalDividends;
      const totalReturnPercent = totalInvestment > 0 ? 
        (totalReturnValue / totalInvestment) * 100 : 0;

      const snapshot = new PortfolioSnapshot({
        personName,
        viewMode: 'person',
        date: new Date(),
        totalInvestment,
        currentValue,
        totalReturnValue,
        totalReturnPercent,
        unrealizedPnl,
        totalDividends,
        numberOfPositions: positions.length,
        numberOfAccounts: accounts.length,
        numberOfDividendStocks: positions.filter(p => 
          p.dividendData && p.dividendData.annualDividend > 0
        ).length,
        createdAt: new Date()
      });

      await snapshot.save();
      
      return snapshot;
    } catch (error) {
      logger.error(`Failed to create portfolio snapshot for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get sync status for a person
   */
  async getSyncStatus(personName) {
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
      isInProgress: this.syncInProgress.get(personName) || false,
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
  async getAllSyncStatuses() {
    const persons = await Person.find({});
    const statuses = [];

    for (const person of persons) {
      const status = await this.getSyncStatus(person.personName);
      statuses.push(status);
    }

    return statuses;
  }

  /**
   * Force stop sync for a person (emergency stop)
   */
  async stopSync(personName) {
    this.syncInProgress.set(personName, false);
    logger.warn(`Force stopped sync for person: ${personName}`);
    
    // Update person status
    await Person.findOneAndUpdate(
      { personName },
      { 
        lastSyncStatus: 'stopped',
        lastSyncError: 'Manually stopped'
      }
    );
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
      maxConcurrent,
      timestamp: new Date().toISOString()
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
        await new Promise(resolve => setTimeout(resolve, 1000));
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
      summary,
      timestamp: new Date().toISOString()
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
        cutoffDate: cutoffDate.toISOString(),
        timestamp: new Date().toISOString()
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
}

module.exports = new DataSyncService();