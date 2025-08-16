// services/dataSync/accountSync.js - FIXED VERSION - Properly extracts cash balances
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
   * Sync a single account with balance information - FIXED VERSION
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

    // FIXED: Fetch and properly store account balances
    try {
      const balancesData = await questradeApi.getAccountBalances(accountData.number, personName);
      
      if (balancesData) {
        logger.debug(`Raw balance data for account ${accountData.number}:`, {
          perCurrencyBalances: balancesData.perCurrencyBalances,
          combinedBalances: balancesData.combinedBalances
        });

        // FIXED: Properly extract cash balances from perCurrencyBalances array
        const processedBalances = {
          perCurrencyBalances: balancesData.perCurrencyBalances || [],
          lastUpdated: new Date()
        };

        // FIXED: Process combinedBalances correctly
        // Questrade sometimes returns combinedBalances as an array, sometimes as object
        let combinedBalances = {};
        
        if (balancesData.combinedBalances) {
          if (Array.isArray(balancesData.combinedBalances) && balancesData.combinedBalances.length > 0) {
            // If it's an array, take the first element
            combinedBalances = balancesData.combinedBalances[0];
          } else if (typeof balancesData.combinedBalances === 'object' && !Array.isArray(balancesData.combinedBalances)) {
            // If it's already an object, use it directly
            combinedBalances = balancesData.combinedBalances;
          }
        }

        // FIXED: If no combinedBalances, calculate from perCurrencyBalances
        if (!combinedBalances.currency && balancesData.perCurrencyBalances && balancesData.perCurrencyBalances.length > 0) {
          // Find the primary currency balance (usually CAD for Canadian accounts)
          const primaryBalance = balancesData.perCurrencyBalances.find(b => b.currency === 'CAD') || 
                                balancesData.perCurrencyBalances[0];
          
          combinedBalances = {
            currency: primaryBalance.currency,
            cash: primaryBalance.cash,
            marketValue: primaryBalance.marketValue,
            totalEquity: primaryBalance.totalEquity,
            buyingPower: primaryBalance.buyingPower,
            maintenanceExcess: primaryBalance.maintenanceExcess,
            isRealTime: primaryBalance.isRealTime
          };
        }

        processedBalances.combinedBalances = combinedBalances;
        accountDoc.balances = processedBalances;

        // FIXED: Log the extracted cash balance for debugging
        const cashBalance = combinedBalances.cash || 0;
        const currency = combinedBalances.currency || 'CAD';
        
        logger.info(`Account ${accountData.number} balance extracted:`, {
          personName,
          accountId: accountData.number,
          accountType: accountData.type,
          cashBalance: cashBalance,
          currency: currency,
          totalEquity: combinedBalances.totalEquity,
          marketValue: combinedBalances.marketValue
        });

        // Log individual currency balances for transparency
        if (balancesData.perCurrencyBalances) {
          balancesData.perCurrencyBalances.forEach(balance => {
            logger.debug(`  ${balance.currency}: Cash=${balance.cash}, Market=${balance.marketValue}, Total=${balance.totalEquity}`);
          });
        }
      }
    } catch (balanceErr) {
      logger.error(`Failed to fetch balances for account ${accountData.number}:`, {
        error: balanceErr.message,
        personName,
        accountId: accountData.number
      });
      // Continue without balances rather than failing completely
      accountDoc.balances = {
        perCurrencyBalances: [],
        combinedBalances: {
          currency: 'CAD',
          cash: 0,
          marketValue: 0,
          totalEquity: 0,
          buyingPower: 0,
          maintenanceExcess: 0,
          isRealTime: false
        },
        lastUpdated: new Date(),
        syncError: balanceErr.message
      };
    }

    // Save or update account
    const savedAccount = await Account.findOneAndUpdate(
      { accountId: accountData.number, personName },
      accountDoc,
      { upsert: true, new: true }
    );

    logger.debug(`Account ${accountData.number} (${accountData.type}) synced successfully with cash balance: ${savedAccount.balances?.combinedBalances?.cash || 0}`);
    
    return savedAccount;
  }

  /**
   * Force refresh account balances for all accounts of a person
   */
  async refreshAllAccountBalances(personName) {
    const result = { updated: 0, errors: [] };

    try {
      const accounts = await Account.find({ personName });

      for (const account of accounts) {
        try {
          logger.info(`Refreshing balance for account ${account.accountId}...`);
          
          const balancesData = await questradeApi.getAccountBalances(account.accountId, personName);
          
          if (balancesData) {
            // FIXED: Use the same balance processing logic as syncSingleAccount
            const processedBalances = {
              perCurrencyBalances: balancesData.perCurrencyBalances || [],
              lastUpdated: new Date()
            };

            let combinedBalances = {};
            
            if (balancesData.combinedBalances) {
              if (Array.isArray(balancesData.combinedBalances) && balancesData.combinedBalances.length > 0) {
                combinedBalances = balancesData.combinedBalances[0];
              } else if (typeof balancesData.combinedBalances === 'object' && !Array.isArray(balancesData.combinedBalances)) {
                combinedBalances = balancesData.combinedBalances;
              }
            }

            if (!combinedBalances.currency && balancesData.perCurrencyBalances && balancesData.perCurrencyBalances.length > 0) {
              const primaryBalance = balancesData.perCurrencyBalances.find(b => b.currency === 'CAD') || 
                                    balancesData.perCurrencyBalances[0];
              
              combinedBalances = {
                currency: primaryBalance.currency,
                cash: primaryBalance.cash,
                marketValue: primaryBalance.marketValue,
                totalEquity: primaryBalance.totalEquity,
                buyingPower: primaryBalance.buyingPower,
                maintenanceExcess: primaryBalance.maintenanceExcess,
                isRealTime: primaryBalance.isRealTime
              };
            }

            processedBalances.combinedBalances = combinedBalances;

            await Account.findOneAndUpdate(
              { accountId: account.accountId, personName },
              {
                balances: processedBalances,
                syncedAt: new Date(),
                updatedAt: new Date()
              }
            );

            logger.info(`Account ${account.accountId} balance updated: ${combinedBalances.currency} $${combinedBalances.cash}`);
            result.updated++;
          }
        } catch (balanceError) {
          result.errors.push({
            accountId: account.accountId,
            error: balanceError.message
          });
          logger.error(`Failed to refresh balance for account ${account.accountId}:`, balanceError);
        }
      }

      logger.info(`Balance refresh completed for ${personName}: ${result.updated} updated, ${result.errors.length} errors`);
      return result;
    } catch (error) {
      logger.error(`Error refreshing balances for ${personName}:`, error);
      throw error;
    }
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
        totalCash: 0,
        byCurrency: {},
        lastSyncTime: null
      };

      accounts.forEach(account => {
        // Count by type
        const type = account.type || 'Unknown';
        stats.byType[type] = (stats.byType[type] || 0) + 1;

        // Count by status
        const status = account.status || 'Unknown';
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

        // FIXED: Calculate total equity and cash properly
        if (account.balances) {
          // Add per-currency balances
          if (account.balances.perCurrencyBalances) {
            account.balances.perCurrencyBalances.forEach(balance => {
              const currency = balance.currency;
              if (!stats.byCurrency[currency]) {
                stats.byCurrency[currency] = {
                  cash: 0,
                  marketValue: 0,
                  totalEquity: 0
                };
              }
              stats.byCurrency[currency].cash += balance.cash || 0;
              stats.byCurrency[currency].marketValue += balance.marketValue || 0;
              stats.byCurrency[currency].totalEquity += balance.totalEquity || 0;
            });
          }

          // Add combined balances to totals (converted to CAD equivalent for summary)
          if (account.balances.combinedBalances) {
            const balance = account.balances.combinedBalances;
            stats.totalEquity += balance.totalEquity || 0;
            stats.totalCash += balance.cash || 0;
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

        // FIXED: Check for missing or invalid balance data
        if (!account.balances) {
          issues.push({ accountId: account.accountId, issue: 'Missing balance data' });
        } else {
          if (!account.balances.combinedBalances) {
            issues.push({ accountId: account.accountId, issue: 'Missing combined balance data' });
          } else {
            const cb = account.balances.combinedBalances;
            if (cb.cash === undefined || cb.cash === null) {
              issues.push({ accountId: account.accountId, issue: 'Missing cash balance' });
            }
            if (!cb.currency) {
              issues.push({ accountId: account.accountId, issue: 'Missing currency information' });
            }
          }
          
          if (!account.balances.perCurrencyBalances || account.balances.perCurrencyBalances.length === 0) {
            issues.push({ accountId: account.accountId, issue: 'Missing per-currency balance data' });
          }
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
   * Force refresh account balances - legacy method
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