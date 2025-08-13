// services/dataSync/index.js - Main DataSync Service
const AccountSync = require('./accountSync');
const PositionSync = require('./positionSync');
const ActivitySync = require('./activitySync');
const SnapshotCreator = require('./snapshotCreator');
const SyncUtils = require('./syncUtils');
const Person = require('../../models/Person');
const Token = require('../../models/Token');
const logger = require('../../utils/logger');

class DataSyncService {
  constructor() {
    this.syncInProgress = new Map(); // Track sync status per person
    this.accountSync = new AccountSync();
    this.positionSync = new PositionSync();
    this.activitySync = new ActivitySync();
    this.snapshotCreator = new SnapshotCreator();
    this.utils = new SyncUtils();
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
      logger.info(`Syncing accounts for ${personName}...`);
      const accountsResult = await this.accountSync.syncAccountsForPerson(personName, fullSync);
      syncResults.accounts = accountsResult;
      
      logger.info(`Account sync completed for ${personName}: ${accountsResult.synced} synced, ${accountsResult.errors.length} errors`);

      // If accounts sync was successful, sync positions and activities
      if (accountsResult.synced > 0 || accountsResult.errors.length === 0) {
        logger.info(`Syncing positions for ${personName}...`);
        const positionsResult = await this.positionSync.syncPositionsForPerson(personName, fullSync);
        syncResults.positions = positionsResult;
        
        logger.info(`Position sync completed for ${personName}: ${positionsResult.synced} synced, ${positionsResult.errors.length} errors`);

        // Sync activities (with enhanced 6-month pagination)
        logger.info(`Syncing activities for ${personName}...`);
        const activitiesResult = await this.activitySync.syncActivitiesForPerson(personName, fullSync);
        syncResults.activities = activitiesResult;
        
        logger.info(`Activity sync completed for ${personName}: ${activitiesResult.synced} synced, ${activitiesResult.errors.length} errors`);

        // Create portfolio snapshot if requested
        if (fullSync || forceRefresh) {
          try {
            logger.info(`Creating portfolio snapshot for ${personName}...`);
            const snapshot = await this.snapshotCreator.createPortfolioSnapshot(personName);
            syncResults.snapshots.created = true;
            
            logger.info(`Created portfolio snapshot for ${personName}: $${snapshot.currentValue.toFixed(2)}`);
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
   * Get sync status for a person
   */
  async getSyncStatus(personName) {
    return this.utils.getSyncStatus(personName, this.syncInProgress);
  }

  /**
   * Get sync status for all persons
   */
  async getAllSyncStatuses() {
    return this.utils.getAllSyncStatuses(this.syncInProgress);
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
    return this.activitySync.getActivityStatistics(personName);
  }

  /**
   * Bulk sync activities for multiple accounts
   */
  async bulkSyncActivities(personNames = null, options = {}) {
    return this.activitySync.bulkSyncActivities(personNames, options);
  }

  /**
   * Clean up old activities
   */
  async cleanupOldActivities(personName, retentionMonths = 24) {
    return this.activitySync.cleanupOldActivities(personName, retentionMonths);
  }

  // Backward compatibility methods
  async syncAccountsForPerson(personName, fullSync = false) {
    return this.accountSync.syncAccountsForPerson(personName, fullSync);
  }

  async syncPositionsForPerson(personName, fullSync = false) {
    return this.positionSync.syncPositionsForPerson(personName, fullSync);
  }

  async syncActivitiesForPerson(personName, fullSync = false) {
    return this.activitySync.syncActivitiesForPerson(personName, fullSync);
  }

  async createPortfolioSnapshot(personName) {
    return this.snapshotCreator.createPortfolioSnapshot(personName);
  }
}

module.exports = new DataSyncService();