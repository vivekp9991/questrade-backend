// services/dataSync.js - FIXED VERSION
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
      logger.info(`Starting sync for person: ${personName}`);
      
      // Verify person exists and has valid token - FIXED
      const person = await Person.findOne({ personName }); // Changed from name to personName
      if (!person) {
        throw new Error(`Person ${personName} not found`);
      }

      const token = await Token.findOne({ personName });
      if (!token) {
        throw new Error(`No token found for person ${personName}`);
      }

      const syncResults = {
        personName,
        startTime: new Date(),
        accounts: { synced: 0, errors: [] },
        positions: { synced: 0, errors: [] },
        activities: { synced: 0, errors: [] },
        snapshots: { created: false, error: null }
      };

      // Sync accounts first
      const accountsResult = await this.syncAccountsForPerson(personName, fullSync);
      syncResults.accounts = accountsResult;

      // If accounts sync was successful, sync positions and activities
      if (accountsResult.synced > 0 || !accountsResult.errors.length) {
        const positionsResult = await this.syncPositionsForPerson(personName, fullSync);
        syncResults.positions = positionsResult;

        if (fullSync) {
          const activitiesResult = await this.syncActivitiesForPerson(personName, fullSync);
          syncResults.activities = activitiesResult;
        }

        // Create portfolio snapshot if requested
        if (fullSync || forceRefresh) {
          try {
            await this.createPortfolioSnapshot(personName);
            syncResults.snapshots.created = true;
          } catch (snapshotError) {
            syncResults.snapshots.error = snapshotError.message;
            logger.error(`Snapshot creation failed for ${personName}:`, snapshotError);
          }
        }
      }

      // Update person's last sync time - FIXED
      await Person.findOneAndUpdate(
        { personName }, // Changed from name to personName
        { 
          lastSyncTime: new Date(),
          lastSyncStatus: 'success',
          lastSyncResults: syncResults
        }
      );

      syncResults.endTime = new Date();
      syncResults.duration = syncResults.endTime - syncResults.startTime;
      
      logger.info(`Sync completed for person: ${personName}`, syncResults);
      return syncResults;

    } catch (error) {
      logger.error(`Sync failed for person: ${personName}`, error);
      
      // Update person's sync status - FIXED
      await Person.findOneAndUpdate(
        { personName }, // Changed from name to personName
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
        const result = await this.syncPersonData(person.personName, { fullSync }); // Changed from name
        allResults.push(result);
      } catch (error) {
        const errorResult = {
          personName: person.personName, // Changed from name
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
      logger.info(`Syncing accounts for ${personName}...`);
      const accountsData = await questradeApi.getAccounts(personName);
      
      if (!accountsData || !accountsData.accounts) {
        throw new Error('No accounts data received from API');
      }

      logger.info(`Found ${accountsData.accounts.length} accounts for ${personName}`);
      
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
          logger.debug(`Synced account ${accountData.number} for ${personName}`);
        } catch (accountError) {
          result.errors.push({
            accountId: accountData.number,
            error: accountError.message
          });
          logger.error(`Failed to sync account ${accountData.number}:`, accountError);
        }
      }

      logger.info(`Account sync completed for ${personName}: ${result.synced} synced, ${result.errors.length} errors`);
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
      logger.info(`Syncing positions for ${personName}...`);
      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping position sync`);
        return result;
      }
      
      for (const account of accounts) {
        try {
          const positionsData = await questradeApi.getAccountPositions(account.accountId, personName);
          
          if (!positionsData || !positionsData.positions) {
            logger.warn(`No positions data for account ${account.accountId}`);
            continue;
          }

          // Clear existing positions for this account if full sync
          if (fullSync) {
            await Position.deleteMany({ accountId: account.accountId, personName });
            logger.debug(`Cleared existing positions for account ${account.accountId}`);
          }

          logger.info(`Processing ${positionsData.positions.length} positions for account ${account.accountId}`);

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
          
          logger.debug(`Synced ${positionsData.positions.length} positions for account ${account.accountId}`);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          logger.error(`Failed to sync positions for account ${account.accountId}:`, accountError);
        }
      }

      logger.info(`Position sync completed for ${personName}: ${result.synced} synced, ${result.errors.length} errors`);
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
   * Sync activities for a specific person
   */
  async syncActivitiesForPerson(personName, fullSync = false) {
    const result = { synced: 0, errors: [] };
    
    try {
      logger.info(`Syncing activities for ${personName}...`);
      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping activity sync`);
        return result;
      }
      
      for (const account of accounts) {
        try {
          // Get activities for the last 30 days or longer if fullSync
          const endDate = new Date();
          const startDate = new Date();
          if (fullSync) {
            startDate.setFullYear(startDate.getFullYear() - 1); // Last year for full sync
          } else {
            startDate.setDate(startDate.getDate() - 30); // Last 30 days for incremental
          }
          
          // Format dates for Questrade API
          const formatDate = (date) => date.toISOString().split('T')[0];
          
          const activitiesData = await questradeApi.getAccountActivities(
            account.accountId,
            personName,
            formatDate(startDate),
            formatDate(endDate)
          );

          if (!activitiesData || !activitiesData.activities) {
            logger.warn(`No activities data for account ${account.accountId}`);
            continue;
          }

          logger.info(`Processing ${activitiesData.activities.length} activities for account ${account.accountId}`);

          for (const activityData of activitiesData.activities) {
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

              // Create unique identifier for the activity
              const activityId = `${account.accountId}_${activityData.transactionDate}_${activityData.symbol || 'CASH'}_${activityData.netAmount}_${activityData.type}`;

              const existingActivity = await Activity.findOne({
                personName,
                accountId: account.accountId,
                transactionDate: activityData.transactionDate,
                symbol: activityData.symbol || null,
                netAmount: activityData.netAmount,
                type: activityType
              });

              if (!existingActivity) {
                await Activity.create(activityDoc);
                result.synced++;
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
          
          logger.debug(`Synced activities for account ${account.accountId}`);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          logger.error(`Failed to sync activities for account ${account.accountId}:`, accountError);
        }
      }

      logger.info(`Activity sync completed for ${personName}: ${result.synced} synced, ${result.errors.length} errors`);
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
      logger.info(`Creating portfolio snapshot for ${personName}...`);
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
      logger.info(`Created portfolio snapshot for ${personName}: $${currentValue.toFixed(2)}`);
      
      return snapshot;
    } catch (error) {
      logger.error(`Failed to create portfolio snapshot for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get sync status for a person - FIXED
   */
  async getSyncStatus(personName) {
    const person = await Person.findOne({ personName }); // Changed from name
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
   * Get sync status for all persons - FIXED
   */
  async getAllSyncStatuses() {
    const persons = await Person.find({});
    const statuses = [];

    for (const person of persons) {
      const status = await this.getSyncStatus(person.personName); // Changed from name
      statuses.push(status);
    }

    return statuses;
  }

  /**
   * Force stop sync for a person (emergency stop) - FIXED
   */
  async stopSync(personName) {
    this.syncInProgress.set(personName, false);
    logger.warn(`Force stopped sync for person: ${personName}`);
    
    // Update person status
    await Person.findOneAndUpdate(
      { personName }, // Changed from name
      { 
        lastSyncStatus: 'stopped',
        lastSyncError: 'Manually stopped'
      }
    );
  }
}

module.exports = new DataSyncService();