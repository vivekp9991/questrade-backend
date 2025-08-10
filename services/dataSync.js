// services/dataSync.js
const questradeApi = require('./questradeApi');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const Person = require('../models/Person');
const Token = require('../models/Token');
const logger = require('./logger');

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
      
      // Verify person exists and has valid token
      const person = await Person.findOne({ name: personName });
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

        const activitiesResult = await this.syncActivitiesForPerson(personName, fullSync);
        syncResults.activities = activitiesResult;

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

      // Update person's last sync time
      await Person.findOneAndUpdate(
        { name: personName },
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
      
      // Update person's sync status
      await Person.findOneAndUpdate(
        { name: personName },
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
        const result = await this.syncPersonData(person.name, { fullSync });
        allResults.push(result);
      } catch (error) {
        const errorResult = {
          personName: person.name,
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
            lastUpdated: new Date()
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
    } catch (error) {
      result.errors.push({
        type: 'API_ERROR',
        error: error.message
      });
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
      
      for (const account of accounts) {
        try {
          const positionsData = await questradeApi.getPositions(account.accountId, personName);
          
          // Clear existing positions for this account if full sync
          if (fullSync) {
            await Position.deleteMany({ accountId: account.accountId, personName });
          }

          for (const positionData of positionsData.positions) {
            const positionDoc = {
              personName,
              accountId: account.accountId,
              symbolId: positionData.symbolId,
              symbol: positionData.symbol,
              openQuantity: positionData.openQuantity,
              currentMarketValue: positionData.currentMarketValue,
              currentPrice: positionData.currentPrice,
              averageEntryPrice: positionData.averageEntryPrice,
              closedPnl: positionData.closedPnl,
              openPnl: positionData.openPnl,
              totalCost: positionData.totalCost,
              isRealTime: positionData.isRealTime,
              isUnderReorg: positionData.isUnderReorg,
              lastUpdated: new Date()
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
          }
          
          logger.debug(`Synced ${positionsData.positions.length} positions for account ${account.accountId}`);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
        }
      }
    } catch (error) {
      result.errors.push({
        type: 'POSITIONS_SYNC_ERROR',
        error: error.message
      });
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
      const accounts = await Account.find({ personName });
      
      for (const account of accounts) {
        try {
          // Get activities for the last 30 days or all if fullSync
          const startTime = fullSync ? 
            new Date('2020-01-01') : 
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          
          const activitiesData = await questradeApi.getActivities(
            account.accountId, 
            startTime.toISOString().split('T')[0],
            new Date().toISOString().split('T')[0],
            personName
          );

          for (const activityData of activitiesData.activities) {
            const activityDoc = {
              personName,
              accountId: account.accountId,
              activityId: `${account.accountId}_${activityData.tradeDate}_${activityData.transactionDate}_${activityData.settlementDate}_${activityData.symbol || 'CASH'}`,
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
              type: activityData.type,
              lastUpdated: new Date()
            };

            await Activity.findOneAndUpdate(
              { activityId: activityDoc.activityId, personName },
              activityDoc,
              { upsert: true, new: true }
            );

            result.synced++;
          }
          
          logger.debug(`Synced ${activitiesData.activities.length} activities for account ${account.accountId}`);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
        }
      }
    } catch (error) {
      result.errors.push({
        type: 'ACTIVITIES_SYNC_ERROR',
        error: error.message
      });
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
      
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentMarketValue || 0), 0);
      const totalPnL = positions.reduce((sum, pos) => sum + (pos.openPnl || 0), 0);
      
      const snapshot = new PortfolioSnapshot({
        personName,
        date: new Date(),
        totalValue,
        totalPnL,
        positionCount: positions.length,
        accountCount: accounts.length,
        positions: positions.map(pos => ({
          symbol: pos.symbol,
          quantity: pos.openQuantity,
          value: pos.currentMarketValue,
          pnl: pos.openPnl
        }))
      });

      await snapshot.save();
      logger.info(`Created portfolio snapshot for ${personName}: $${totalValue.toFixed(2)}`);
      
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
    const person = await Person.findOne({ name: personName });
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
      const status = await this.getSyncStatus(person.name);
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
      { name: personName },
      { 
        lastSyncStatus: 'stopped',
        lastSyncError: 'Manually stopped'
      }
    );
  }
}

module.exports = new DataSyncService();