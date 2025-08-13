// services/dataSync/snapshotCreator.js - Portfolio Snapshot Creation
const PortfolioSnapshot = require('../../models/PortfolioSnapshot');
const Position = require('../../models/Position');
const Account = require('../../models/Account');
const logger = require('../../utils/logger');

class SnapshotCreator {
  constructor() {
    // No constructor parameters needed for the new design
  }

  /**
   * Create a complete portfolio snapshot for a person
   */
  async createPortfolioSnapshot(personName) {
    try {
      logger.info(`Creating portfolio snapshot for person ${personName}`);

      const positions = await Position.find({ personName }).lean();
      const accounts = await Account.find({ personName }).lean();

      const snapshotData = this.calculateSnapshotMetrics(accounts, positions);
      
      const snapshot = await PortfolioSnapshot.create({
        personName,
        viewMode: 'person',
        date: new Date(),
        totalInvestment: snapshotData.totalInvestment,
        currentValue: snapshotData.currentValue,
        totalReturnValue: snapshotData.totalReturnValue,
        totalReturnPercent: snapshotData.totalReturnPercent,
        unrealizedPnl: snapshotData.unrealizedPnl,
        totalDividends: snapshotData.totalDividends,
        numberOfPositions: snapshotData.numberOfPositions,
        numberOfAccounts: snapshotData.numberOfAccounts,
        numberOfDividendStocks: snapshotData.numberOfDividendStocks,
        assetAllocation: snapshotData.assetAllocation,
        sectorAllocation: snapshotData.sectorAllocation,
        currencyBreakdown: snapshotData.currencyBreakdown,
        createdAt: new Date()
      });

      logger.info(`Portfolio snapshot created with ID: ${snapshot._id} for ${personName}`);
      return snapshot;

    } catch (error) {
      logger.error(`Error creating portfolio snapshot for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Calculate comprehensive portfolio metrics
   */
  calculateSnapshotMetrics(accounts, positions) {
    const metrics = {
      totalInvestment: 0,
      currentValue: 0,
      unrealizedPnl: 0,
      totalDividends: 0,
      totalReturnValue: 0,
      totalReturnPercent: 0,
      numberOfAccounts: accounts.length,
      numberOfPositions: positions.length,
      numberOfDividendStocks: 0,
      assetAllocation: [],
      sectorAllocation: [],
      currencyBreakdown: []
    };

    // Calculate totals from positions
    positions.forEach(position => {
      metrics.totalInvestment += position.totalCost || 0;
      metrics.currentValue += position.currentMarketValue || 0;
      metrics.unrealizedPnl += position.openPnl || 0;
      
      if (position.dividendData) {
        metrics.totalDividends += position.dividendData.totalReceived || 0;
      }

      // Count dividend stocks
      if (position.dividendData && position.dividendData.annualDividend > 0) {
        metrics.numberOfDividendStocks++;
      }
    });

    // Calculate return metrics
    metrics.totalReturnValue = metrics.unrealizedPnl + metrics.totalDividends;
    metrics.totalReturnPercent = metrics.totalInvestment > 0 ? 
      (metrics.totalReturnValue / metrics.totalInvestment) * 100 : 0;

    // Calculate allocations
    metrics.sectorAllocation = this.calculateSectorAllocation(positions, metrics.currentValue);
    metrics.currencyBreakdown = this.calculateCurrencyBreakdown(positions, metrics.currentValue);
    metrics.assetAllocation = this.calculateAssetAllocation(positions, metrics.currentValue);

    return metrics;
  }

  /**
   * Calculate sector allocation
   */
  calculateSectorAllocation(positions, totalValue) {
    const sectorMap = {
      // Technology
      'AAPL': 'Technology', 'MSFT': 'Technology', 'GOOGL': 'Technology', 'GOOG': 'Technology',
      'AMZN': 'Technology', 'TSLA': 'Technology', 'META': 'Technology', 'NVDA': 'Technology',
      
      // Healthcare
      'JNJ': 'Healthcare', 'PFE': 'Healthcare', 'UNH': 'Healthcare', 'ABBV': 'Healthcare',
      
      // Financial
      'JPM': 'Financial', 'BAC': 'Financial', 'WFC': 'Financial', 'GS': 'Financial',
      'MS': 'Financial', 'C': 'Financial', 'RY': 'Financial', 'TD': 'Financial',
      
      // Consumer
      'WMT': 'Consumer Discretionary', 'HD': 'Consumer Discretionary', 'MCD': 'Consumer Discretionary',
      'COST': 'Consumer Staples', 'PG': 'Consumer Staples', 'KO': 'Consumer Staples',
      
      // Energy
      'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'ENB': 'Energy',
      
      // Utilities
      'NEE': 'Utilities', 'DUK': 'Utilities', 'SO': 'Utilities',
      
      // Real Estate & REITs
      'REI': 'Real Estate', 'VNQ': 'Real Estate'
    };

    const sectorTotals = {};

    positions.forEach(position => {
      const sector = position.industrySector || 
                    sectorMap[position.symbol] || 
                    (position.symbol && position.symbol.includes('.TO') ? 'Canadian Equity' : 'Other');
      
      const value = position.currentMarketValue || 0;
      sectorTotals[sector] = (sectorTotals[sector] || 0) + value;
    });

    // Convert to array format with percentages
    return Object.entries(sectorTotals)
      .map(([sector, value]) => ({
        sector,
        value,
        percentage: totalValue > 0 ? (value / totalValue) * 100 : 0
      }))
      .filter(item => item.percentage > 0.5) // Only include sectors > 0.5%
      .sort((a, b) => b.value - a.value);
  }

  /**
   * Calculate currency breakdown
   */
  calculateCurrencyBreakdown(positions, totalValue) {
    const currencyTotals = {};

    positions.forEach(position => {
      const currency = position.currency || 
                      (position.symbol && position.symbol.includes('.TO') ? 'CAD' : 'USD');
      
      const value = position.currentMarketValue || 0;
      currencyTotals[currency] = (currencyTotals[currency] || 0) + value;
    });

    return Object.entries(currencyTotals)
      .map(([currency, value]) => ({
        currency,
        value,
        percentage: totalValue > 0 ? (value / totalValue) * 100 : 0
      }))
      .sort((a, b) => b.value - a.value);
  }

  /**
   * Calculate asset allocation (stocks vs bonds vs other)
   */
  calculateAssetAllocation(positions, totalValue) {
    const assetTotals = {
      'Stocks': 0,
      'ETFs': 0,
      'Bonds': 0,
      'Other': 0
    };

    positions.forEach(position => {
      const value = position.currentMarketValue || 0;
      const symbol = position.symbol || '';
      
      // Simple classification based on symbol patterns
      if (symbol.includes('ETF') || symbol.includes('.TO') && symbol.length <= 6) {
        assetTotals['ETFs'] += value;
      } else if (symbol.includes('BOND') || symbol.includes('TDB')) {
        assetTotals['Bonds'] += value;
      } else if (position.securityType === 'Stock') {
        assetTotals['Stocks'] += value;
      } else {
        assetTotals['Other'] += value;
      }
    });

    return Object.entries(assetTotals)
      .map(([category, value]) => ({
        category,
        value,
        percentage: totalValue > 0 ? (value / totalValue) * 100 : 0
      }))
      .filter(item => item.value > 0)
      .sort((a, b) => b.value - a.value);
  }

  /**
   * Create a lightweight snapshot for quick access
   */
  async createLightSnapshot(personName) {
    try {
      const positions = await Position.find({ personName });
      const accounts = await Account.find({ personName });
      
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentMarketValue || 0), 0);
      const totalCost = positions.reduce((sum, pos) => sum + (pos.totalCost || 0), 0);
      const positionsCount = positions.length;

      return {
        personName,
        totalValue,
        totalCost,
        accountsCount: accounts.length,
        positionsCount,
        timestamp: new Date()
      };

    } catch (error) {
      logger.error(`Error creating light snapshot for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get the latest snapshot for comparison
   */
  async getLatestSnapshot(personName) {
    try {
      return await PortfolioSnapshot.findOne({
        personName,
        viewMode: 'person'
      }).sort({ createdAt: -1 });
    } catch (error) {
      logger.error(`Error fetching latest snapshot for ${personName}:`, error);
      return null;
    }
  }

  /**
   * Clean old snapshots (keep only last 30 days)
   */
  async cleanOldSnapshots(personName) {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const deleteResult = await PortfolioSnapshot.deleteMany({
        personName,
        createdAt: { $lt: thirtyDaysAgo }
      });

      if (deleteResult.deletedCount > 0) {
        logger.info(`Cleaned up ${deleteResult.deletedCount} old snapshots for ${personName}`);
      }

      return deleteResult.deletedCount;
    } catch (error) {
      logger.error(`Error cleaning old snapshots for ${personName}:`, error);
      throw error;
    }
  }

  /**
   * Get snapshot history for a person
   */
  async getSnapshotHistory(personName, days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      return await PortfolioSnapshot.find({
        personName,
        viewMode: 'person',
        date: { $gte: startDate }
      }).sort({ date: -1 });
    } catch (error) {
      logger.error(`Error getting snapshot history for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = SnapshotCreator;