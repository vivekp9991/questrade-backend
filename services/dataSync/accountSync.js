// services/dataSync/accountSync.js - Account Synchronization
const questradeApi = require('../questradeApi');
const Account = require('../../models/Account');
const SyncUtils = require('./syncUtils');
const logger = require('../../utils/logger');

class AccountSync {
  constructor() {
    this.utils = new SyncUtils();
  }

  /**
   * Sync accounts for a specific person
   */
  async syncAccountsForPerson(personName, fullSync = false) {
    const result = this.utils.createSyncResult();
    
    try {
      // Validate person and token
      await this.utils.validatePersonForSync(personName);

      this.utils.logSyncOperation('Account sync started', personName, { fullSync });

      const accountsData = await questradeApi.getAccounts(personName);
      
      if (!accountsData || !accountsData.accounts) {
        throw new Error('No accounts data received from API');
      }

      this.utils.logSyncOperation('Accounts fetched from API', personName, {
        accountCount: accountsData.accounts.length
      });
      
      for (const accountData of accountsData.accounts) {
        try {
          await this.syncSingleAccount(accountData, personName);
          result.synced++;
        } catch (accountError) {
          result.errors.push({
            accountId: accountData.number,
            error: accountError.message
          });
          this.utils.logSyncError('Single account sync', personName, accountError, {
            accountId: accountData.number
          });
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'API_ERROR',
        error: error.message
      });
      this.utils.logSyncError('Account sync', personName, error);
      throw error;
    }

    this.utils.logSyncOperation('Account sync completed', personName, {
      synced: result.synced,
      errors: result.errors.length
    });

    return this.utils.finalizeSyncResult(result);
  }

  /**
   * Sync a single account with balance information
   */
  async syncSingleAccount(accountData, personName) {
    const accountDoc = {
      personName,
      accountId: accountData.number,
      type: accountData.type,
      number: accountData.number,
      status: accountData.status,
      isPrimary: accountData.isPrimary,
      isBilling: accountData.isBilling,
      clientAccountType: accountData.clientAccountType,
      syncedAt: new Date(),
      updatedAt: new Date()
    };

    // Fetch and store account balances
    try {
      const balancesData = await questradeApi.getAccountBalances(accountData.number, personName);
      if (balancesData) {
        accountDoc.balances = {
          perCurrencyBalances: balancesData.perCurrencyBalances || [],
          combinedBalances: balancesData.combinedBalances || {},
          lastUpdated: new Date()
        };

        // Log balance information
        if (balancesData.combinedBalances && balancesData.combinedBalances.length > 0) {
          const primaryBalance = balancesData.combinedBalances[0];
          logger.debug(`Account ${accountData.number} balance: ${primaryBalance.currency} $${primaryBalance.totalEquity}`);
        }
      }
    } catch (balanceErr) {
      logger.error(`Failed to fetch balances for account ${accountData.number}:`, balanceErr);
      // Continue without balances rather than failing completely
    }

    // Save or update account
    await Account.findOneAndUpdate(
      { accountId: accountData.number, personName },
      accountDoc,
      { upsert: true, new: true }
    );

    logger.debug(`Account ${accountData.number} (${accountData.type}) synced successfully`);
  }

  /**
   * Get account sync statistics
   */
  async getAccountSyncStats(personName) {
    try {
      const accounts = await Account.find({ personName });
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const stats = {
        total: accounts.length,
        recentlySynced: accounts.filter(acc => acc.syncedAt > oneDayAgo).length,
        byType: {},
        byStatus: {},
        totalEquity: 0,
        lastSyncTime: null
      };

      accounts.forEach(account => {
        // Count by type
        const type = account.type || 'Unknown';
        stats.byType[type] = (stats.byType[type] || 0) + 1;

        // Count by status
        const status = account.status || 'Unknown';
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

        // Calculate total equity
        if (account.balances && account.balances.combinedBalances) {
          const balance = account.balances.combinedBalances[0];
          if (balance && balance.totalEquity) {
            stats.totalEquity += balance.totalEquity;
          }
        }

        // Track latest sync time
        if (account.syncedAt && (!stats.lastSyncTime || account.syncedAt > stats.lastSyncTime)) {
          stats.lastSyncTime = account.syncedAt;
        }
      });

      return stats;
    } catch (error) {
      logger.error(`Error getting account sync stats for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Validate account data integrity
   */
  async validateAccountData(personName) {
    try {
      const accounts = await Account.find({ personName });
      const issues = [];

      for (const account of accounts) {
        // Check for missing required fields
        if (!account.accountId) {
          issues.push({ accountId: account._id, issue: 'Missing accountId' });
        }

        if (!account.type) {
          issues.push({ accountId: account.accountId, issue: 'Missing account type' });
        }

        if (!account.status) {
          issues.push({ accountId: account.accountId, issue: 'Missing account status' });
        }

        // Check for stale sync data (older than 7 days)
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (!account.syncedAt || account.syncedAt < weekAgo) {
          issues.push({ 
            accountId: account.accountId, 
            issue: 'Stale sync data',
            lastSync: account.syncedAt 
          });
        }

        // Check for missing balance data
        if (!account.balances || !account.balances.combinedBalances) {
          issues.push({ accountId: account.accountId, issue: 'Missing balance data' });
        }
      }

      return {
        accountCount: accounts.length,
        issues,
        isValid: issues.length === 0
      };
    } catch (error) {
      logger.error(`Error validating account data for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Force refresh account balances
   */
  async refreshAccountBalances(personName, accountId = null) {
    const result = { updated: 0, errors: [] };

    try {
      let accounts;
      if (accountId) {
        accounts = await Account.find({ personName, accountId });
      } else {
        accounts = await Account.find({ personName });
      }

      for (const account of accounts) {
        try {
          const balancesData = await questradeApi.getAccountBalances(account.accountId, personName);
          
          if (balancesData) {
            await Account.findOneAndUpdate(
              { accountId: account.accountId, personName },
              {
                balances: {
                  perCurrencyBalances: balancesData.perCurrencyBalances || [],
                  combinedBalances: balancesData.combinedBalances || {},
                  lastUpdated: new Date()
                },
                syncedAt: new Date(),
                updatedAt: new Date()
              }
            );
            result.updated++;
          }
        } catch (balanceError) {
          result.errors.push({
            accountId: account.accountId,
            error: balanceError.message
          });
        }
      }

      logger.info(`Balance refresh completed for ${personName}: ${result.updated} updated, ${result.errors.length} errors`);
      return result;
    } catch (error) {
      logger.error(`Error refreshing balances for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = AccountSync;