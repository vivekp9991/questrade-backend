// services/portfolioCalculator.js
const Position = require('../models/Position');
const Account = require('../models/Account');
const Activity = require('../models/Activity');
const Person = require('../models/Person');
const accountAggregator = require('./accountAggregator');
const logger = require('./logger');

class PortfolioCalculatorService {
  
  /**
   * Get portfolio summary with person/account filtering
   */
  async getPortfolioSummary(options = {}) {
    const { viewMode = 'all', personName, accountId, aggregate = true } = options;
    
    try {
      let positions;
      let accounts;

      // Get positions and accounts based on view mode
      switch (viewMode) {
        case 'person':
          if (!personName) throw new Error('Person name required for person view mode');
          positions = await Position.find({ personName });
          accounts = await Account.find({ personName });
          break;
          
        case 'account':
          if (!accountId) throw new Error('Account ID required for account view mode');
          positions = await Position.find({ accountId });
          accounts = await Account.find({ accountId });
          break;
          
        case 'all':
        default:
          positions = await Position.find({});
          accounts = await Account.find({});
          break;
      }

      // Aggregate positions if requested and there are multiple accounts
      if (aggregate && viewMode !== 'account') {
        positions = await accountAggregator.aggregatePositions(positions, { groupBy: 'symbol' });
      }

      const summary = this.calculateSummaryMetrics(positions, accounts);
      
      // Add view mode context to response
      summary.viewMode = viewMode;
      summary.personName = personName;
      summary.accountId = accountId;
      summary.isAggregated = aggregate && viewMode !== 'account';

      return summary;

    } catch (error) {
      logger.error('Error calculating portfolio summary:', error);
      throw error;
    }
  }

  /**
   * Calculate summary metrics from positions and accounts
   */
  calculateSummaryMetrics(positions, accounts) {
    const summary = {
      totalValue: 0,
      totalCost: 0,
      totalPnL: 0,
      totalDividends: 0,
      positionCount: positions.length,
      accountCount: accounts.length,
      topHoldings: [],
      sectorBreakdown: {},
      performanceMetrics: {}
    };

    // Calculate totals
    positions.forEach(position => {
      summary.totalValue += position.currentMarketValue || 0;
      summary.totalCost += position.totalCost || 0;
      summary.totalPnL += position.openPnl || 0;
    });

    // Calculate percentage returns
    summary.totalReturnPercent = summary.totalCost > 0 ? 
      (summary.totalPnL / summary.totalCost) * 100 : 0;

    // Get top 5 holdings by value
    summary.topHoldings = positions
      .sort((a, b) => (b.currentMarketValue || 0) - (a.currentMarketValue || 0))
      .slice(0, 5)
      .map(position => ({
        symbol: position.symbol,
        value: position.currentMarketValue,
        percentage: summary.totalValue > 0 ? 
          (position.currentMarketValue / summary.totalValue) * 100 : 0,
        pnl: position.openPnl,
        pnlPercent: position.totalCost > 0 ? 
          (position.openPnl / position.totalCost) * 100 : 0
      }));

    return summary;
  }

  /**
   * Get detailed positions with filtering and aggregation
   */
  async getDetailedPositions(options = {}) {
    const { viewMode = 'all', personName, accountId, aggregate = true, includeMetadata = false } = options;
    
    try {
      let query = {};
      
      // Build query based on view mode
      switch (viewMode) {
        case 'person':
          if (!personName) throw new Error('Person name required for person view mode');
          query.personName = personName;
          break;
          
        case 'account':
          if (!accountId) throw new Error('Account ID required for account view mode');
          query.accountId = accountId;
          break;
          
        case 'all':
        default:
          // No additional filters
          break;
      }

      let positions = await Position.find(query).lean();

      // Aggregate positions if requested
      if (aggregate && viewMode !== 'account') {
        positions = await accountAggregator.aggregatePositions(positions, {
          groupBy: 'symbol',
          includeAccountDetails: true
        });
      }

      // Add metadata if requested
      if (includeMetadata) {
        positions = await this.enrichPositionsWithMetadata(positions);
      }

      // Sort by market value descending
      positions.sort((a, b) => (b.currentMarketValue || 0) - (a.currentMarketValue || 0));

      return positions;

    } catch (error) {
      logger.error('Error getting detailed positions:', error);
      throw error;
    }
  }

  /**
   * Enrich positions with additional metadata
   */
  async enrichPositionsWithMetadata(positions) {
    const enrichedPositions = [];

    for (const position of positions) {
      const enriched = { ...position };

      // Calculate additional metrics
      enriched.percentOfPortfolio = 0; // Will be calculated at portfolio level
      enriched.dayChange = 0; // Would need market data
      enriched.dayChangePercent = 0;
      
      // Calculate return percentages
      if (position.totalCost && position.totalCost > 0) {
        enriched.returnPercent = (position.openPnl / position.totalCost) * 100;
      } else {
        enriched.returnPercent = 0;
      }

      // Add position metrics
      enriched.averageCost = position.openQuantity > 0 ? 
        position.averageEntryPrice : 0;
      
      enriched.unrealizedGainLoss = position.openPnl || 0;
      enriched.marketValue = position.currentMarketValue || 0;

      enrichedPositions.push(enriched);
    }

    return enrichedPositions;
  }

  /**
   * Get performance metrics for a person or account
   */
  async getPerformanceMetrics(options = {}) {
    const { viewMode = 'all', personName, accountId, timeframe = '1Y' } = options;
    
    try {
      let query = {};
      
      switch (viewMode) {
        case 'person':
          if (!personName) throw new Error('Person name required');
          query.personName = personName;
          break;
        case 'account':
          if (!accountId) throw new Error('Account ID required');
          query.accountId = accountId;
          break;
      }

      const positions = await Position.find(query);
      const activities = await Activity.find(query);

      const metrics = {
        totalReturn: 0,
        totalReturnPercent: 0,
        realizedGains: 0,
        unrealizedGains: 0,
        totalDividends: 0,
        totalCommissions: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        timeframe
      };

      // Calculate from positions
      positions.forEach(position => {
        metrics.unrealizedGains += position.openPnl || 0;
        metrics.totalReturn += position.openPnl || 0;
      });

      // Calculate from activities
      let totalInvested = 0;
      let totalDividends = 0;
      let totalCommissions = 0;
      let wins = 0;
      let losses = 0;
      let winAmount = 0;
      let lossAmount = 0;

      activities.forEach(activity => {
        if (activity.type === 'Trades') {
          totalCommissions += Math.abs(activity.commission || 0);
          
          if (activity.action === 'Buy') {
            totalInvested += Math.abs(activity.netAmount || 0);
          } else if (activity.action === 'Sell') {
            const profit = activity.netAmount - activity.grossAmount;
            if (profit > 0) {
              wins++;
              winAmount += profit;
            } else if (profit < 0) {
              losses++;
              lossAmount += Math.abs(profit);
            }
          }
        } else if (activity.type === 'Dividends') {
          totalDividends += activity.netAmount || 0;
        }
      });

      metrics.totalDividends = totalDividends;
      metrics.totalCommissions = totalCommissions;
      metrics.realizedGains = winAmount - lossAmount;
      
      if (totalInvested > 0) {
        metrics.totalReturnPercent = (metrics.totalReturn / totalInvested) * 100;
      }

      if (wins + losses > 0) {
        metrics.winRate = (wins / (wins + losses)) * 100;
      }
      
      if (wins > 0) {
        metrics.avgWin = winAmount / wins;
      }
      
      if (losses > 0) {
        metrics.avgLoss = lossAmount / losses;
      }

      return metrics;

    } catch (error) {
      logger.error('Error calculating performance metrics:', error);
      throw error;
    }
  }

  /**
   * Get dividend calendar with person/account filtering
   */
  async getDividendCalendar(options = {}) {
    const { viewMode = 'all', personName, accountId, startDate, endDate } = options;
    
    try {
      let query = { type: 'Dividends' };
      
      switch (viewMode) {
        case 'person':
          if (!personName) throw new Error('Person name required');
          query.personName = personName;
          break;
        case 'account':
          if (!accountId) throw new Error('Account ID required');
          query.accountId = accountId;
          break;
      }

      if (startDate || endDate) {
        query.transactionDate = {};
        if (startDate) query.transactionDate.$gte = new Date(startDate);
        if (endDate) query.transactionDate.$lte = new Date(endDate);
      }

      const dividends = await Activity.find(query)
        .sort({ transactionDate: -1 })
        .lean();

      // Group by month for calendar view
      const calendar = {};
      
      dividends.forEach(dividend => {
        const monthKey = dividend.transactionDate.toISOString().substring(0, 7); // YYYY-MM
        
        if (!calendar[monthKey]) {
          calendar[monthKey] = {
            month: monthKey,
            totalAmount: 0,
            dividends: []
          };
        }
        
        calendar[monthKey].totalAmount += dividend.netAmount || 0;
        calendar[monthKey].dividends.push({
          symbol: dividend.symbol,
          date: dividend.transactionDate,
          amount: dividend.netAmount,
          quantity: dividend.quantity,
          description: dividend.description
        });
      });

      return Object.values(calendar);

    } catch (error) {
      logger.error('Error getting dividend calendar:', error);
      throw error;
    }
  }

  /**
   * Get account allocation breakdown
   */
  async getAccountAllocation(personName) {
    try {
      const accounts = await Account.find({ personName });
      const allocation = [];

      for (const account of accounts) {
        const positions = await Position.find({ accountId: account.accountId });
        const totalValue = positions.reduce((sum, pos) => sum + (pos.currentMarketValue || 0), 0);
        
        allocation.push({
          accountId: account.accountId,
          accountType: account.type,
          accountNumber: account.number,
          totalValue,
          positionCount: positions.length,
          positions: positions.map(pos => ({
            symbol: pos.symbol,
            value: pos.currentMarketValue,
            percentage: totalValue > 0 ? (pos.currentMarketValue / totalValue) * 100 : 0
          }))
        });
      }

      return allocation;

    } catch (error) {
      logger.error('Error getting account allocation:', error);
      throw error;
    }
  }

  /**
   * Get portfolio comparison between persons
   */
  async getPersonComparison(personNames) {
    try {
      const comparison = [];

      for (const personName of personNames) {
        const summary = await this.getPortfolioSummary({ 
          viewMode: 'person', 
          personName 
        });
        
        comparison.push({
          personName,
          ...summary
        });
      }

      return comparison;

    } catch (error) {
      logger.error('Error getting person comparison:', error);
      throw error;
    }
  }
}

module.exports = new PortfolioCalculatorService();