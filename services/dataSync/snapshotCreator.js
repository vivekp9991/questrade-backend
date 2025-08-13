const { PortfolioSnapshot } = require('../../models');
const logger = require('../../utils/logger');

class SnapshotCreator {
  constructor(userId) {
    this.userId = userId;
  }

  /**
   * Create a complete portfolio snapshot
   */
  async createSnapshot(accounts, positions) {
    try {
      logger.info(`Creating portfolio snapshot for user ${this.userId}`);

      const snapshotData = this.calculateSnapshotMetrics(accounts, positions);
      
      const snapshot = await PortfolioSnapshot.create({
        userId: this.userId,
        totalValue: snapshotData.totalValue,
        totalCash: snapshotData.totalCash,
        totalEquity: snapshotData.totalEquity,
        totalGainLoss: snapshotData.totalGainLoss,
        totalGainLossPercent: snapshotData.totalGainLossPercent,
        accountsCount: snapshotData.accountsCount,
        positionsCount: snapshotData.positionsCount,
        topHoldings: snapshotData.topHoldings,
        sectorAllocation: snapshotData.sectorAllocation,
        createdAt: new Date()
      });

      logger.info(`Portfolio snapshot created with ID: ${snapshot.id}`);
      return snapshot;

    } catch (error) {
      logger.error('Error creating portfolio snapshot:', error);
      throw error;
    }
  }

  /**
   * Calculate comprehensive portfolio metrics
   */
  calculateSnapshotMetrics(accounts, positions) {
    const metrics = {
      totalValue: 0,
      totalCash: 0,
      totalEquity: 0,
      totalGainLoss: 0,
      totalGainLossPercent: 0,
      accountsCount: accounts.length,
      positionsCount: positions.length,
      topHoldings: [],
      sectorAllocation: {}
    };

    // Calculate totals from accounts
    accounts.forEach(account => {
      metrics.totalValue += parseFloat(account.totalValue || 0);
      metrics.totalCash += parseFloat(account.cashBalance || 0);
      metrics.totalEquity += parseFloat(account.totalEquity || 0);
    });

    // Calculate position metrics
    const positionsBySymbol = this.groupPositionsBySymbol(positions);
    const holdingsData = [];

    Object.entries(positionsBySymbol).forEach(([symbol, symbolPositions]) => {
      const totalShares = symbolPositions.reduce((sum, pos) => sum + parseFloat(pos.quantity || 0), 0);
      const totalValue = symbolPositions.reduce((sum, pos) => sum + parseFloat(pos.marketValue || 0), 0);
      const totalCostBasis = symbolPositions.reduce((sum, pos) => sum + parseFloat(pos.costBasis || 0), 0);
      const gainLoss = totalValue - totalCostBasis;

      if (totalShares > 0) {
        holdingsData.push({
          symbol,
          quantity: totalShares,
          marketValue: totalValue,
          costBasis: totalCostBasis,
          gainLoss,
          gainLossPercent: totalCostBasis > 0 ? (gainLoss / totalCostBasis) * 100 : 0,
          weight: metrics.totalEquity > 0 ? (totalValue / metrics.totalEquity) * 100 : 0
        });

        metrics.totalGainLoss += gainLoss;
      }
    });

    // Calculate overall gain/loss percentage
    const totalCostBasis = holdingsData.reduce((sum, holding) => sum + holding.costBasis, 0);
    metrics.totalGainLossPercent = totalCostBasis > 0 ? (metrics.totalGainLoss / totalCostBasis) * 100 : 0;

    // Get top 10 holdings by market value
    metrics.topHoldings = holdingsData
      .sort((a, b) => b.marketValue - a.marketValue)
      .slice(0, 10)
      .map(holding => ({
        symbol: holding.symbol,
        marketValue: holding.marketValue,
        weight: holding.weight,
        gainLossPercent: holding.gainLossPercent
      }));

    // Calculate sector allocation (simplified - you might want to integrate with a sector mapping service)
    metrics.sectorAllocation = this.calculateSectorAllocation(holdingsData);

    return metrics;
  }

  /**
   * Group positions by symbol across all accounts
   */
  groupPositionsBySymbol(positions) {
    return positions.reduce((grouped, position) => {
      const symbol = position.symbol;
      if (!grouped[symbol]) {
        grouped[symbol] = [];
      }
      grouped[symbol].push(position);
      return grouped;
    }, {});
  }

  /**
   * Calculate sector allocation
   * Note: This is a simplified implementation. In production, you'd want to
   * integrate with a data provider that maps symbols to sectors.
   */
  calculateSectorAllocation(holdingsData) {
    const sectorMap = {
      // Technology
      'AAPL': 'Technology', 'MSFT': 'Technology', 'GOOGL': 'Technology', 'GOOG': 'Technology',
      'AMZN': 'Technology', 'TSLA': 'Technology', 'META': 'Technology', 'NVDA': 'Technology',
      
      // Healthcare
      'JNJ': 'Healthcare', 'PFE': 'Healthcare', 'UNH': 'Healthcare', 'ABBV': 'Healthcare',
      
      // Financial
      'JPM': 'Financial', 'BAC': 'Financial', 'WFC': 'Financial', 'GS': 'Financial',
      'MS': 'Financial', 'C': 'Financial',
      
      // Consumer
      'WMT': 'Consumer Discretionary', 'HD': 'Consumer Discretionary', 'MCD': 'Consumer Discretionary',
      'COST': 'Consumer Staples', 'PG': 'Consumer Staples', 'KO': 'Consumer Staples',
      
      // Energy
      'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy',
      
      // Utilities
      'NEE': 'Utilities', 'DUK': 'Utilities', 'SO': 'Utilities'
    };

    const sectorTotals = {};
    let totalValue = holdingsData.reduce((sum, holding) => sum + holding.marketValue, 0);

    holdingsData.forEach(holding => {
      const sector = sectorMap[holding.symbol] || 'Other';
      if (!sectorTotals[sector]) {
        sectorTotals[sector] = 0;
      }
      sectorTotals[sector] += holding.marketValue;
    });

    // Convert to percentages
    const sectorAllocation = {};
    Object.entries(sectorTotals).forEach(([sector, value]) => {
      sectorAllocation[sector] = totalValue > 0 ? (value / totalValue) * 100 : 0;
    });

    return sectorAllocation;
  }

  /**
   * Create a lightweight snapshot for quick access
   */
  async createLightSnapshot(accounts, positions) {
    try {
      const totalValue = accounts.reduce((sum, acc) => sum + parseFloat(acc.totalValue || 0), 0);
      const totalCash = accounts.reduce((sum, acc) => sum + parseFloat(acc.cashBalance || 0), 0);
      const positionsCount = positions.length;

      return {
        userId: this.userId,
        totalValue,
        totalCash,
        accountsCount: accounts.length,
        positionsCount,
        timestamp: new Date()
      };

    } catch (error) {
      logger.error('Error creating light snapshot:', error);
      throw error;
    }
  }

  /**
   * Get the latest snapshot for comparison
   */
  async getLatestSnapshot() {
    try {
      return await PortfolioSnapshot.findOne({
        where: { userId: this.userId },
        order: [['createdAt', 'DESC']]
      });
    } catch (error) {
      logger.error('Error fetching latest snapshot:', error);
      return null;
    }
  }

  /**
   * Clean old snapshots (keep only last 30 days)
   */
  async cleanOldSnapshots() {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const deletedCount = await PortfolioSnapshot.destroy({
        where: {
          userId: this.userId,
          createdAt: {
            [require('sequelize').Op.lt]: thirtyDaysAgo
          }
        }
      });

      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} old snapshots for user ${this.userId}`);
      }

      return deletedCount;
    } catch (error) {
      logger.error('Error cleaning old snapshots:', error);
      throw error;
    }
  }
}

module.exports = SnapshotCreator;