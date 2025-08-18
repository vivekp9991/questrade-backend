// services/dataSync/positionSync.js - FIXED VERSION - Position Synchronization with Enhanced Dividend Calculation
const questradeApi = require('../questradeApi');
const Account = require('../../models/Account');
const Position = require('../../models/Position');
const Symbol = require('../../models/Symbol');
const DividendCalculator = require('./dividendCalculator');
const SyncUtils = require('./syncUtils');
const logger = require('../../utils/logger');

class PositionSync {
  constructor() {
    this.utils = new SyncUtils();
    this.dividendCalculator = new DividendCalculator();
  }

  /**
   * Sync positions for a specific person with FIXED dividend calculations
   */
  async syncPositionsForPerson(personName, fullSync = false) {
    const result = this.utils.createSyncResult();
    
    try {
      // Validate person and token
      await this.utils.validatePersonForSync(personName);

      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping position sync`);
        return this.utils.finalizeSyncResult(result);
      }
      
      this.utils.logSyncOperation('Position sync started', personName, { 
        accountCount: accounts.length,
        fullSync 
      });
      
      for (const account of accounts) {
        try {
          const accountResult = await this.syncPositionsForAccount(account, personName, fullSync);
          result.synced += accountResult.synced;
          result.errors.push(...accountResult.errors);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          this.utils.logSyncError('Position sync for account', personName, accountError, {
            accountId: account.accountId
          });
        }
      }

    } catch (error) {
      result.errors.push({
        type: 'POSITIONS_SYNC_ERROR',
        error: error.message
      });
      this.utils.logSyncError('Position sync', personName, error);
      throw error;
    }

    this.utils.logSyncOperation('Position sync completed', personName, {
      synced: result.synced,
      errors: result.errors.length
    });

    return this.utils.finalizeSyncResult(result);
  }

  /**
   * Sync positions for a single account
   */
  async syncPositionsForAccount(account, personName, fullSync) {
    const result = { synced: 0, errors: [] };

    try {
      const positionsData = await questradeApi.getAccountPositions(account.accountId, personName);
      
      if (!positionsData || !positionsData.positions) {
        logger.info(`Processing 0 positions for account ${account.accountId}`);
        return result;
      }

      // Clear existing positions for this account if full sync
      if (fullSync) {
        await Position.deleteMany({ accountId: account.accountId, personName });
        logger.debug(`Cleared existing positions for account ${account.accountId} (full sync)`);
      }

      logger.info(`Processing ${positionsData.positions.length} positions for account ${account.accountId}`);

      // Get all symbol IDs for batch symbol lookup
      const symbolIds = positionsData.positions.map(p => p.symbolId);
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      // Process each position
      for (const positionData of positionsData.positions) {
        try {
          const savedPosition = await this.syncSinglePosition(
            positionData, 
            account, 
            personName, 
            symbolMap[positionData.symbolId]
          );
          
          if (savedPosition) {
            result.synced++;
          }
        } catch (positionError) {
          result.errors.push({
            accountId: account.accountId,
            symbol: positionData.symbol,
            error: positionError.message
          });
          logger.error(`Failed to save position ${positionData.symbol}:`, positionError);
        }
      }

      // Update account statistics after processing positions
      try {
        await this.utils.updateAccountStatistics(account.accountId, personName);
      } catch (statErr) {
        logger.error(`Failed to update stats for account ${account.accountId}:`, statErr);
      }

    } catch (error) {
      logger.error(`Failed to sync positions for account ${account.accountId}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Sync a single position with FIXED dividend calculation
   */
  async syncSinglePosition(positionData, account, personName, symbolInfo) {
    try {
      // Calculate additional metrics
      const totalReturnValue = (positionData.openPnl || 0);
      const totalReturnPercent = positionData.totalCost > 0 ? 
        (totalReturnValue / positionData.totalCost) * 100 : 0;
      const capitalGainPercent = positionData.totalCost > 0 ? 
        ((positionData.openPnl || 0) / positionData.totalCost) * 100 : 0;

      // FIXED: Calculate dividend data with proper yield on cost calculation
      const dividendData = await this.dividendCalculator.calculateDividendData(
        account.accountId, 
        personName, 
        positionData.symbolId, 
        positionData.symbol,
        positionData.openQuantity,
        positionData.averageEntryPrice,
        symbolInfo
      );

      // Validate dividend data
      const validation = this.dividendCalculator.validateDividendData(dividendData, positionData.symbol);
      if (!validation.isValid) {
        logger.warn(`Dividend data validation failed for ${positionData.symbol}:`, validation.warnings);
      }

      // FIXED: Determine if this is a dividend stock based on actual dividends
      const isDividendStock = (dividendData.annualDividend > 0) || 
                             (dividendData.totalReceived > 0) ||
                             (symbolInfo?.dividendPerShare > 0);

      // FIXED: Calculate dividendPerShare properly
      let dividendPerShare = 0;
      
      // First try to use calculated annual dividend per share
      if (dividendData.annualDividendPerShare > 0) {
        dividendPerShare = dividendData.annualDividendPerShare;
      }
      // Fallback to symbol data if available
      else if (symbolInfo) {
        const freq = symbolInfo.dividendFrequency?.toLowerCase();
        if (freq === 'monthly') {
          dividendPerShare = (symbolInfo.dividendPerShare || 0) * 12;
        } else if (freq === 'quarterly') {
          dividendPerShare = (symbolInfo.dividendPerShare || 0) * 4;
        } else if (freq === 'semi-annually') {
          dividendPerShare = (symbolInfo.dividendPerShare || 0) * 2;
        } else if (freq === 'annually') {
          dividendPerShare = symbolInfo.dividendPerShare || 0;
        }
      }

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
        
        // FIXED: Use properly calculated dividend data
        dividendData,
        
        // FIXED: Position-level dividend fields
        dividendPerShare, // Annual dividend per share
        isDividendStock,
        currency: symbolInfo?.currency || (positionData.symbol?.includes('.TO') ? 'CAD' : 'USD'),
        securityType: symbolInfo?.securityType || 'Stock',
        industrySector: symbolInfo?.industrySector,
        industryGroup: symbolInfo?.industryGroup,
        
        // Market data cache (if available)
        marketData: this.extractMarketData(positionData),
        
        syncedAt: new Date(),
        updatedAt: new Date()
      };

      const savedPosition = await Position.findOneAndUpdate(
        { 
          accountId: account.accountId,
          symbolId: positionData.symbolId,
          personName 
        },
        positionDoc,
        { upsert: true, new: true }
      );

      // FIXED: Log dividend info for debugging
      if (dividendData.yieldOnCost > 0) {
        logger.debug(`Position ${positionData.symbol} synced:`, {
          symbol: positionData.symbol,
          shares: positionData.openQuantity,
          avgCost: positionData.averageEntryPrice.toFixed(2),
          totalCost: positionData.totalCost.toFixed(2),
          annualDividend: dividendData.annualDividend.toFixed(2),
          annualDividendPerShare: dividendData.annualDividendPerShare.toFixed(3),
          yieldOnCost: dividendData.yieldOnCost.toFixed(2) + '%'
        });
      }
      
      return savedPosition;
    } catch (error) {
      logger.error(`Error syncing position ${positionData.symbol}:`, error);
      throw error;
    }
  }

  /**
   * Extract market data from position data
   */
  extractMarketData(positionData) {
    return {
      lastPrice: positionData.currentPrice,
      lastUpdated: new Date(),
      isRealTime: positionData.isRealTime
    };
  }

  /**
   * Get position sync statistics for a person
   */
  async getPositionSyncStats(personName) {
    try {
      const positions = await Position.find({ personName });
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const stats = {
        total: positions.length,
        recentlySynced: positions.filter(pos => pos.syncedAt > oneDayAgo).length,
        totalValue: 0,
        totalCost: 0,
        totalPnL: 0,
        totalDividendsReceived: 0,
        totalAnnualDividend: 0, // FIXED: Track annual dividend projection
        dividendStocks: 0,
        byCurrency: {},
        lastSyncTime: null
      };

      positions.forEach(position => {
        stats.totalValue += position.currentMarketValue || 0;
        stats.totalCost += position.totalCost || 0;
        stats.totalPnL += position.openPnl || 0;

        // FIXED: Track dividend metrics properly
        if (position.dividendData) {
          stats.totalDividendsReceived += position.dividendData.totalReceived || 0;
          stats.totalAnnualDividend += position.dividendData.annualDividend || 0;
          
          // Count as dividend stock if it pays dividends or has received dividends
          if (position.dividendData.annualDividend > 0 || position.dividendData.totalReceived > 0) {
            stats.dividendStocks++;
          }
        }

        // Group by currency
        const currency = position.currency || 'CAD';
        if (!stats.byCurrency[currency]) {
          stats.byCurrency[currency] = { count: 0, value: 0 };
        }
        stats.byCurrency[currency].count++;
        stats.byCurrency[currency].value += position.currentMarketValue || 0;

        // Track latest sync time
        if (position.syncedAt && (!stats.lastSyncTime || position.syncedAt > stats.lastSyncTime)) {
          stats.lastSyncTime = position.syncedAt;
        }
      });

      // FIXED: Calculate portfolio-wide yield on cost
      stats.portfolioYieldOnCost = stats.totalCost > 0 ? (stats.totalAnnualDividend / stats.totalCost) * 100 : 0;
      stats.returnPercent = stats.totalCost > 0 ? (stats.totalPnL / stats.totalCost) * 100 : 0;

      return stats;
    } catch (error) {
      logger.error(`Error getting position sync stats for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Recalculate dividends for all positions of a person - FIXED VERSION
   */
  async recalculateDividends(personName, symbol = null) {
    try {
      let query = { personName };
      if (symbol) {
        query.symbol = symbol;
      }

      const positions = await Position.find(query);
      const updated = [];
      const errors = [];

      // Get symbols data for batch lookup
      const symbolIds = positions.map(p => p.symbolId);
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      logger.info(`Starting dividend recalculation for ${positions.length} positions${symbol ? ` for symbol ${symbol}` : ''} for ${personName}`);

      for (const position of positions) {
        try {
          const symbolInfo = symbolMap[position.symbolId];
          
          const newDividendData = await this.dividendCalculator.calculateDividendData(
            position.accountId,
            position.personName,
            position.symbolId,
            position.symbol,
            position.openQuantity,
            position.averageEntryPrice,
            symbolInfo
          );

          // FIXED: Update position-level dividend fields
          const isDividendStock = (newDividendData.annualDividend > 0) || 
                                 (newDividendData.totalReceived > 0) ||
                                 (symbolInfo?.dividendPerShare > 0);

          let dividendPerShare = newDividendData.annualDividendPerShare || 0;
          
          // Fallback to symbol data if needed
          if (dividendPerShare === 0 && symbolInfo) {
            const freq = symbolInfo.dividendFrequency?.toLowerCase();
            if (freq === 'monthly') {
              dividendPerShare = (symbolInfo.dividendPerShare || 0) * 12;
            } else if (freq === 'quarterly') {
              dividendPerShare = (symbolInfo.dividendPerShare || 0) * 4;
            } else if (freq === 'semi-annually') {
              dividendPerShare = (symbolInfo.dividendPerShare || 0) * 2;
            } else if (freq === 'annually') {
              dividendPerShare = symbolInfo.dividendPerShare || 0;
            }
          }

          await Position.findByIdAndUpdate(position._id, {
            dividendData: newDividendData,
            isDividendStock,
            dividendPerShare,
            updatedAt: new Date()
          });

          updated.push({
            symbol: position.symbol,
            oldYieldOnCost: position.dividendData?.yieldOnCost || 0,
            newYieldOnCost: newDividendData.yieldOnCost,
            oldAnnualDividend: position.dividendData?.annualDividend || 0,
            newAnnualDividend: newDividendData.annualDividend
          });

          if (newDividendData.yieldOnCost > 0) {
            logger.debug(`Updated ${position.symbol}: YoC = ${newDividendData.yieldOnCost.toFixed(2)}%, Annual = ${newDividendData.annualDividend.toFixed(2)}`);
          }

        } catch (error) {
          errors.push({
            symbol: position.symbol,
            error: error.message
          });
          logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        }
      }

      logger.info(`Dividend recalculation completed for ${personName}: ${updated.length} updated, ${errors.length} errors`);
      
      return {
        updated: updated.length,
        errors: errors.length,
        updatedPositions: updated,
        errorDetails: errors
      };
    } catch (error) {
      logger.error(`Error recalculating dividends for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get positions with stale dividend data
   */
  async getStalePositions(personName, daysOld = 7) {
    try {
      const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      
      const stalePositions = await Position.find({
        personName,
        $or: [
          { syncedAt: { $lt: cutoffDate } },
          { syncedAt: { $exists: false } },
          { 'dividendData.lastUpdated': { $lt: cutoffDate } },
          { 'dividendData.lastUpdated': { $exists: false } }
        ]
      }).select('symbol accountId syncedAt dividendData.lastUpdated');

      return stalePositions.map(pos => ({
        symbol: pos.symbol,
        accountId: pos.accountId,
        lastSync: pos.syncedAt,
        lastDividendUpdate: pos.dividendData?.lastUpdated
      }));
    } catch (error) {
      logger.error(`Error getting stale positions for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get dividend summary for a person
   */
  async getDividendSummary(personName) {
    try {
      const positions = await Position.find({ personName });
      
      const summary = {
        totalDividendsReceived: 0,
        annualProjectedDividends: 0,
        monthlyProjectedDividends: 0,
        portfolioYieldOnCost: 0, // FIXED: Portfolio-wide yield on cost
        totalCost: 0, // FIXED: Track total cost for yield calculation
        dividendStocks: 0,
        totalPositions: positions.length,
        averageYield: 0,
        topDividendPayers: []
      };

      const dividendPositions = [];
      let totalAnnualDividend = 0;
      let totalCost = 0;

      positions.forEach(position => {
        // FIXED: Include all positions in total cost calculation
        totalCost += position.totalCost || 0;
        
        if (position.dividendData) {
          const divData = position.dividendData;
          
          summary.totalDividendsReceived += divData.totalReceived || 0;
          summary.annualProjectedDividends += divData.annualDividend || 0;
          summary.monthlyProjectedDividends += divData.monthlyDividend || 0;
          
          // FIXED: Track total annual dividend for portfolio yield calculation
          totalAnnualDividend += divData.annualDividend || 0;
          
          if (divData.annualDividend > 0 || divData.totalReceived > 0) {
            summary.dividendStocks++;
            
            dividendPositions.push({
              symbol: position.symbol,
              totalReceived: divData.totalReceived || 0,
              annualDividend: divData.annualDividend || 0,
              yieldOnCost: divData.yieldOnCost || 0,
              currentValue: position.currentMarketValue || 0,
              totalCost: position.totalCost || 0
            });
          }
        }
      });

      // FIXED: Calculate portfolio-wide yield on cost
      // Portfolio YoC = (Sum of all annual dividends / Sum of all total costs) * 100
      summary.portfolioYieldOnCost = totalCost > 0 ? (totalAnnualDividend / totalCost) * 100 : 0;
      summary.totalCost = totalCost;

      // Calculate average yield
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentMarketValue || 0), 0);
      summary.averageYield = totalValue > 0 ? (summary.annualProjectedDividends / totalValue) * 100 : 0;

      // Get top dividend payers
      summary.topDividendPayers = dividendPositions
        .sort((a, b) => b.annualDividend - a.annualDividend)
        .slice(0, 10);

      return summary;
    } catch (error) {
      logger.error(`Error getting dividend summary for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Validate position data integrity
   */
  async validatePositionData(personName) {
    try {
      const positions = await Position.find({ personName });
      const issues = [];

      for (const position of positions) {
        // Check for missing required fields
        if (!position.symbol) {
          issues.push({ positionId: position._id, issue: 'Missing symbol' });
        }

        if (!position.symbolId) {
          issues.push({ symbol: position.symbol, issue: 'Missing symbolId' });
        }

        if (position.openQuantity === undefined || position.openQuantity === null) {
          issues.push({ symbol: position.symbol, issue: 'Missing openQuantity' });
        }

        // Check for unrealistic values
        if (position.currentPrice && position.currentPrice < 0) {
          issues.push({ symbol: position.symbol, issue: 'Negative current price' });
        }

        if (position.openQuantity && position.openQuantity < 0) {
          issues.push({ symbol: position.symbol, issue: 'Negative quantity' });
        }

        // Check for stale data
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (!position.syncedAt || position.syncedAt < weekAgo) {
          issues.push({ 
            symbol: position.symbol, 
            issue: 'Stale sync data',
            lastSync: position.syncedAt 
          });
        }

        // FIXED: Check dividend data consistency
        if (position.dividendData) {
          const divData = position.dividendData;
          
          if (divData.annualDividend < 0) {
            issues.push({ symbol: position.symbol, issue: 'Negative annual dividend' });
          }
          
          if (divData.yieldOnCost > 50) {
            issues.push({ symbol: position.symbol, issue: 'Unrealistic yield on cost (>50%)' });
          }
          
          // FIXED: Check for missing yield on cost when there should be dividends
          if (divData.annualDividend > 0 && divData.yieldOnCost === 0) {
            issues.push({ symbol: position.symbol, issue: 'Missing yield on cost for dividend stock' });
          }
        }
      }

      return {
        positionCount: positions.length,
        issues,
        isValid: issues.length === 0
      };
    } catch (error) {
      logger.error(`Error validating position data for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = PositionSync;