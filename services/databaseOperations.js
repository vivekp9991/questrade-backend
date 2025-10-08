// services/databaseOperations.js
const Position = require('../models/Position');
const Account = require('../models/Account');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const Symbol = require('../models/Symbol');
const Person = require('../models/Person');
const logger = require('../utils/logger');

/**
 * Simple database operations helper
 * This is a lightweight alternative to DatabaseManager
 */
class DatabaseOperations {
  /**
   * Get positions with filters
   */
  async getPositions(filter = {}) {
    try {
      return await Position.find(filter).lean();
    } catch (error) {
      logger.error('Error getting positions:', error);
      throw error;
    }
  }

  /**
   * Get accounts with filters
   */
  async getAccounts(filter = {}) {
    try {
      return await Account.find(filter).lean();
    } catch (error) {
      logger.error('Error getting accounts:', error);
      throw error;
    }
  }

  /**
   * Get activities with filters
   */
  async getActivities(filter = {}) {
    try {
      return await Activity.find(filter).lean();
    } catch (error) {
      logger.error('Error getting activities:', error);
      throw error;
    }
  }

  /**
   * Get portfolio snapshots with filters
   */
  async getPortfolioSnapshots(filter = {}) {
    try {
      const query = PortfolioSnapshot.find(filter);
      
      if (filter.limit) {
        query.limit(filter.limit);
        delete filter.limit;
      }
      
      if (filter.startDate || filter.endDate) {
        query.date = {};
        if (filter.startDate) {
          query.date.$gte = new Date(filter.startDate);
          delete filter.startDate;
        }
        if (filter.endDate) {
          query.date.$lte = new Date(filter.endDate);
          delete filter.endDate;
        }
      }
      
      return await query.sort({ date: -1 }).lean();
    } catch (error) {
      logger.error('Error getting portfolio snapshots:', error);
      throw error;
    }
  }

  /**
   * Get cash balances from accounts
   */
  async getCashBalances(filter = {}) {
    try {
      const accounts = await Account.find(filter).lean();
      const balances = [];
      
      accounts.forEach(account => {
        if (account?.balances?.perCurrencyBalances) {
          account.balances.perCurrencyBalances.forEach(balance => {
            balances.push({
              accountId: account.accountId,
              accountName: account.displayName || account.accountId,
              accountType: account.type,
              personName: account.personName,
              currency: balance.currency,
              cash: balance.cash,
              marketValue: balance.marketValue,
              totalEquity: balance.totalEquity,
              buyingPower: balance.buyingPower
            });
          });
        } else if (account?.balances?.combinedBalances) {
          balances.push({
            accountId: account.accountId,
            accountName: account.displayName || account.accountId,
            accountType: account.type,
            personName: account.personName,
            currency: account.balances.combinedBalances.currency || 'CAD',
            cash: account.balances.combinedBalances.cash || 0,
            marketValue: account.balances.combinedBalances.marketValue || 0,
            totalEquity: account.balances.combinedBalances.totalEquity || 0,
            buyingPower: account.balances.combinedBalances.buyingPower || 0
          });
        }
      });
      
      return balances;
    } catch (error) {
      logger.error('Error getting cash balances:', error);
      throw error;
    }
  }

  /**
   * Get dividend information
   */
  async getDividends(filter = {}) {
    try {
      const activityFilter = { type: 'Dividend' };
      
      if (filter.accountId) activityFilter.accountId = filter.accountId;
      if (filter.personName) activityFilter.personName = filter.personName;
      if (filter.symbol) activityFilter.symbol = filter.symbol;
      
      if (filter.startDate || filter.endDate) {
        activityFilter.transactionDate = {};
        if (filter.startDate) activityFilter.transactionDate.$gte = new Date(filter.startDate);
        if (filter.endDate) activityFilter.transactionDate.$lte = new Date(filter.endDate);
      }
      
      const dividends = await Activity.find(activityFilter)
        .sort({ transactionDate: -1 })
        .lean();
      
      return dividends.map(d => ({
        symbol: d.symbol,
        accountId: d.accountId,
        accountName: d.accountId,
        personName: d.personName,
        paymentDate: d.transactionDate,
        amount: Math.abs(d.netAmount || 0),
        dividendPerShare: d.dividendPerShare || 0,
        quantity: d.quantity
      }));
    } catch (error) {
      logger.error('Error getting dividends:', error);
      throw error;
    }
  }

  /**
   * Get dividend info from symbols
   */
  async getDividendInfo(symbols) {
    try {
      const symbolDocs = await Symbol.find({ 
        symbol: { $in: symbols } 
      }).lean();
      
      return symbolDocs.map(s => ({
        symbol: s.symbol,
        isDividendStock: s.dividend > 0 || s.dividendPerShare > 0,
        dividendPerShare: s.dividendPerShare || s.dividend || 0,
        dividendYield: s.yield || 0,
        dividendFrequency: s.dividendFrequency,
        exDividendDate: s.exDate,
        paymentDate: s.dividendDate
      }));
    } catch (error) {
      logger.error('Error getting dividend info:', error);
      throw error;
    }
  }

  /**
   * Get transactions (activities)
   */
  async getTransactions(filter = {}) {
    try {
      const query = {};
      
      if (filter.accountId) query.accountId = filter.accountId;
      if (filter.personName) query.personName = filter.personName;
      if (filter.symbol) query.symbol = filter.symbol;
      if (filter.type) query.type = filter.type;
      
      if (filter.startDate || filter.endDate) {
        query.transactionDate = {};
        if (filter.startDate) query.transactionDate.$gte = new Date(filter.startDate);
        if (filter.endDate) query.transactionDate.$lte = new Date(filter.endDate);
      }
      
      const limit = filter.limit || 100;
      
      return await Activity.find(query)
        .sort({ transactionDate: -1 })
        .limit(limit)
        .lean();
    } catch (error) {
      logger.error('Error getting transactions:', error);
      throw error;
    }
  }

  /**
   * Save portfolio snapshot
   */
  async savePortfolioSnapshot(snapshotData) {
    try {
      const snapshot = new PortfolioSnapshot(snapshotData);
      return await snapshot.save();
    } catch (error) {
      logger.error('Error saving portfolio snapshot:', error);
      throw error;
    }
  }

  /**
   * Get watchlist (placeholder)
   */
  async getWatchlist(personName) {
    try {
      // Watchlist feature not implemented yet
      return [];
    } catch (error) {
      logger.error('Error getting watchlist:', error);
      throw error;
    }
  }

  /**
   * Add to watchlist (placeholder)
   */
  async addToWatchlist(data) {
    try {
      // Watchlist feature not implemented yet
      return { success: true, message: 'Watchlist feature not implemented' };
    } catch (error) {
      logger.error('Error adding to watchlist:', error);
      throw error;
    }
  }

  /**
   * Remove from watchlist (placeholder)
   */
  async removeFromWatchlist(data) {
    try {
      // Watchlist feature not implemented yet
      return { success: true, message: 'Watchlist feature not implemented' };
    } catch (error) {
      logger.error('Error removing from watchlist:', error);
      throw error;
    }
  }
}

module.exports = DatabaseOperations;