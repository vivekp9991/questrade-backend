// services/portfolioCalculator.js
const logger = require('../utils/logger');
const Position = require('../models/Position');
const Account = require('../models/Account');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const Symbol = require('../models/Symbol');
const Person = require('../models/Person');
const AccountAggregator = require('./accountAggregator');

class PortfolioCalculatorService {
  constructor() {
    this.accountAggregator = new AccountAggregator();
  }

  /**
   * Get comprehensive portfolio summary
   */
  async getPortfolioSummary(options = {}) {
    try {
      const {
        viewMode = 'all',
        accountId,
        personName,
        aggregate = true,
        dividendStocksOnly = false,
        includeClosedPositions = false
      } = options;

      logger.info('Calculating portfolio summary', { viewMode, accountId, personName, aggregate, dividendStocksOnly });

      // Build filter
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;
      if (!includeClosedPositions) {
        filter.openQuantity = { $gt: 0 };
      }

      // Get positions from database
      let positions = await Position.find(filter).lean();

      // Filter for dividend stocks if requested
      if (dividendStocksOnly) {
        positions = await this.filterDividendStocks(positions);
      }

      // Aggregate positions based on view mode
      const aggregatedPositions = this.accountAggregator.aggregatePositions(
        positions, 
        viewMode, 
        { accountId, personName, aggregate }
      );

      // Calculate portfolio-level metrics
      const summary = await this.calculateSummaryMetrics(
        aggregatedPositions, 
        viewMode, 
        { accountId, personName, aggregate }
      );

      return summary;
    } catch (error) {
      logger.error('Error calculating portfolio summary:', error);
      throw error;
    }
  }

  /**
   * Calculate portfolio summary metrics
   */
  async calculateSummaryMetrics(positions, viewMode, options = {}) {
    try {
      const { accountId, personName, aggregate } = options;

      // Handle different view modes
      if (viewMode === 'account' && accountId) {
        // Single account view
        const totalValue = positions.reduce((sum, p) => sum + (p.marketValue || p.currentMarketValue || 0), 0);
        const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = totalValue - totalCost;
        const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

        // Get account info
        const account = await Account.findOne({ accountId }).lean();
        
        // Extract cash balances
        let totalCash = 0;
        let cashByCurrency = {};
        
        if (account?.balances?.combinedBalances) {
          totalCash = account.balances.combinedBalances.cash || 0;
          cashByCurrency[account.balances.combinedBalances.currency || 'CAD'] = totalCash;
        }

        // Get dividend information
        const dividendPositions = positions.filter(p => 
          p.isDividendStock || (p.dividendData && p.dividendData.annualDividend > 0)
        );
        
        const totalDividendsReceived = positions.reduce((sum, p) => 
          sum + (p.dividendData?.totalReceived || 0), 0
        );
        
        const annualDividendProjected = positions.reduce((sum, p) => 
          sum + (p.dividendData?.annualDividend || 0), 0
        );

        return {
          viewMode,
          accountId,
          accountName: account?.displayName || account?.accountId,
          accountType: account?.type,
          personName: account?.personName || personName,
          totalValue,
          totalCost,
          totalPnL,
          totalPnLPercent,
          totalCash,
          cashByCurrency,
          totalAccountValue: totalValue + totalCash,
          positionCount: positions.length,
          positions,
          dayPnL: positions.reduce((sum, p) => sum + (p.dayPnL || 0), 0),
          dayPnLPercent: 0,
          dividendStocks: dividendPositions.length,
          totalDividendsReceived,
          annualDividendProjected,
          lastUpdated: new Date().toISOString()
        };
      } else if (viewMode === 'person' && personName) {
        // Person view
        if (!aggregate) {
          return {
            viewMode,
            personName,
            aggregate: false,
            positions,
            positionCount: positions.length,
            lastUpdated: new Date().toISOString()
          };
        }

        // Aggregated view for person
        const totalValue = positions.reduce((sum, p) => sum + (p.totalMarketValue || 0), 0);
        const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = totalValue - totalCost;
        const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

        // Get person's accounts
        const accounts = await Account.find({ personName }).lean();
        
        // Calculate total cash
        let totalCash = 0;
        let cashByCurrency = {};
        
        accounts.forEach(account => {
          if (account?.balances?.combinedBalances) {
            const currency = account.balances.combinedBalances.currency || 'CAD';
            const cash = account.balances.combinedBalances.cash || 0;
            cashByCurrency[currency] = (cashByCurrency[currency] || 0) + cash;
            totalCash += cash;
          }
        });

        // Get dividend information
        const dividendPositions = positions.filter(p => 
          p.isDividendStock || (p.dividendData && p.dividendData.annualDividend > 0)
        );
        
        const totalDividendsReceived = positions.reduce((sum, p) => 
          sum + ((p.dividendData?.totalReceived || 0) + (p.totalReceived || 0)), 0
        );
        
        const annualDividendProjected = positions.reduce((sum, p) => 
          sum + ((p.dividendData?.annualDividend || 0) + (p.annualDividend || 0)), 0
        );

        return {
          viewMode,
          personName,
          aggregate: true,
          totalValue,
          totalCost,
          totalPnL,
          totalPnLPercent,
          totalCash,
          cashByCurrency,
          totalAccountValue: totalValue + totalCash,
          accountCount: accounts.length,
          accounts: accounts.map(a => ({
            accountId: a.accountId,
            accountName: a.displayName || a.accountId,
            accountType: a.type
          })),
          positionCount: positions.length,
          uniqueSymbols: positions.length,
          positions,
          dayPnL: positions.reduce((sum, p) => sum + (p.dayPnL || 0), 0),
          dayPnLPercent: 0,
          dividendStocks: dividendPositions.length,
          totalDividendsReceived,
          annualDividendProjected,
          lastUpdated: new Date().toISOString()
        };
      } else {
        // Default 'all' view
        if (!aggregate) {
          return {
            viewMode,
            aggregate: false,
            positions,
            positionCount: positions.length,
            lastUpdated: new Date().toISOString()
          };
        }

        const totalValue = positions.reduce((sum, p) => sum + (p.totalMarketValue || 0), 0);
        const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = totalValue - totalCost;
        const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

        // Get all accounts
        const accounts = await Account.find({}).lean();
        
        // Calculate total cash
        let totalCash = 0;
        let cashByCurrency = {};
        
        accounts.forEach(account => {
          if (account?.balances?.combinedBalances) {
            const currency = account.balances.combinedBalances.currency || 'CAD';
            const cash = account.balances.combinedBalances.cash || 0;
            cashByCurrency[currency] = (cashByCurrency[currency] || 0) + cash;
            totalCash += cash;
          }
        });

        // Get unique persons
        const uniquePersons = new Set(accounts.map(a => a.personName).filter(p => p));

        // Get top gainers and losers
        const sortedByPnL = [...positions].sort((a, b) => b.unrealizedPnLPercent - a.unrealizedPnLPercent);
        const topGainers = sortedByPnL.slice(0, 5);
        const topLosers = sortedByPnL.slice(-5).reverse();

        // Get dividend information
        const dividendPositions = positions.filter(p => 
          p.isDividendStock || (p.dividendData && p.dividendData.annualDividend > 0)
        );
        
        const totalDividendsReceived = positions.reduce((sum, p) => 
          sum + ((p.dividendData?.totalReceived || 0) + (p.totalReceived || 0)), 0
        );
        
        const annualDividendProjected = positions.reduce((sum, p) => 
          sum + ((p.dividendData?.annualDividend || 0) + (p.annualDividend || 0)), 0
        );

        return {
          viewMode,
          aggregate: true,
          totalValue,
          totalCost,
          totalPnL,
          totalPnLPercent,
          totalCash,
          cashByCurrency,
          totalAccountValue: totalValue + totalCash,
          positionCount: positions.length,
          uniqueSymbols: positions.length,
          totalAccounts: accounts.length,
          totalPersons: uniquePersons.size,
          persons: Array.from(uniquePersons),
          positions,
          topGainers,
          topLosers,
          dayPnL: positions.reduce((sum, p) => sum + (p.dayPnL || 0), 0),
          dayPnLPercent: 0,
          dividendStocks: dividendPositions.length,
          totalDividendsReceived,
          annualDividendProjected,
          lastUpdated: new Date().toISOString()
        };
      }
    } catch (error) {
      logger.error('Error calculating summary metrics:', error);
      throw error;
    }
  }

  /**
   * Filter positions to only include dividend-paying stocks
   */
  async filterDividendStocks(positions) {
    try {
      return positions.filter(p => {
        if (p.isDividendStock) return true;
        if (p.dividendData) {
          if (p.dividendData.totalReceived > 0) return true;
          if (p.dividendData.annualDividend > 0) return true;
          if (p.dividendData.annualDividendPerShare > 0) return true;
        }
        if (p.dividendPerShare > 0) return true;
        return false;
      });
    } catch (error) {
      logger.error('Error filtering dividend stocks:', error);
      return positions;
    }
  }

  /**
   * Get positions with optional filters
   */
  async getPositions(options = {}) {
    try {
      const {
        viewMode = 'all',
        accountId,
        personName,
        symbol,
        aggregate = true,
        includeClosedPositions = false,
        sortBy = 'marketValue',
        sortOrder = 'desc'
      } = options;

      // Build filter
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;
      if (symbol) filter.symbol = symbol;
      if (!includeClosedPositions) {
        filter.openQuantity = { $gt: 0 };
      }

      let positions = await Position.find(filter).lean();

      // Aggregate based on view mode
      positions = this.accountAggregator.aggregatePositions(
        positions,
        viewMode,
        { accountId, personName, aggregate }
      );

      // Sort positions
      positions.sort((a, b) => {
        let aVal = a[sortBy] || 0;
        let bVal = b[sortBy] || 0;
        
        if (typeof aVal === 'string') {
          return sortOrder === 'desc' 
            ? bVal.localeCompare(aVal)
            : aVal.localeCompare(bVal);
        }
        
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });

      return positions;
    } catch (error) {
      logger.error('Error getting positions:', error);
      throw error;
    }
  }

  /**
   * Enrich a single position with calculated fields
   */
  enrichPosition(position) {
    return {
      symbol: position.symbol,
      symbolId: position.symbolId,
      accountId: position.accountId,
      personName: position.personName,
      quantity: position.openQuantity || 0,
      averageEntryPrice: position.averageEntryPrice || 0,
      currentPrice: position.currentPrice || 0,
      totalCost: position.totalCost || 0,
      marketValue: position.currentMarketValue || 0,
      unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
      unrealizedPnLPercent: position.totalCost > 0 
        ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
        : 0,
      dayPnL: position.dayPnL || 0,
      dayPnLPercent: position.dayPnLPercent || 0,
      currency: position.currency,
      securityType: position.securityType,
      isDividendStock: position.isDividendStock || false,
      dividendYield: position.dividendYield || 0,
      annualDividend: position.annualDividend || 0,
      dividendData: position.dividendData,
      lastUpdated: position.updatedAt
    };
  }

  /**
   * Aggregate positions by symbol
   */
  aggregatePositionsBySymbol(positions, symbol) {
    const aggregated = {
      symbol: positions[0].symbol,
      symbolId: positions[0].symbolId,
      totalQuantity: 0,
      totalCost: 0,
      totalMarketValue: 0,
      currentPrice: positions[0].currentPrice,
      currency: positions[0].currency,
      securityType: positions[0].securityType,
      isDividendStock: positions[0].isDividendStock || false,
      dividendYield: positions[0].dividendYield || 0,
      annualDividend: positions[0].annualDividend || 0,
      accounts: [],
      persons: new Set(),
      lastUpdated: positions[0].updatedAt
    };

    positions.forEach(position => {
      aggregated.totalQuantity += position.openQuantity || 0;
      aggregated.totalCost += position.totalCost || 0;
      aggregated.totalMarketValue += position.currentMarketValue || 0;
      
      if (position.personName) {
        aggregated.persons.add(position.personName);
      }
      
      aggregated.accounts.push({
        accountId: position.accountId,
        personName: position.personName,
        quantity: position.openQuantity,
        cost: position.totalCost,
        marketValue: position.currentMarketValue,
        averageEntryPrice: position.averageEntryPrice,
        unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
        unrealizedPnLPercent: position.totalCost > 0 
          ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
          : 0,
        dividendData: position.dividendData
      });

      // Update price if more recent
      if (position.updatedAt > aggregated.lastUpdated) {
        aggregated.currentPrice = position.currentPrice;
        aggregated.lastUpdated = position.updatedAt;
      }
    });

    // Calculate aggregate metrics
    aggregated.averageEntryPrice = aggregated.totalQuantity > 0 
      ? aggregated.totalCost / aggregated.totalQuantity 
      : 0;
    aggregated.unrealizedPnL = aggregated.totalMarketValue - aggregated.totalCost;
    aggregated.unrealizedPnLPercent = aggregated.totalCost > 0 
      ? (aggregated.unrealizedPnL / aggregated.totalCost) * 100 
      : 0;
    aggregated.accountCount = aggregated.accounts.length;
    aggregated.personCount = aggregated.persons.size;
    aggregated.persons = Array.from(aggregated.persons);
    aggregated.totalAnnualDividend = aggregated.isDividendStock 
      ? aggregated.totalQuantity * aggregated.annualDividend 
      : 0;

    return aggregated;
  }

  /**
   * Extract cash balances from accounts
   */
  extractCashBalances(accounts) {
    const balances = [];
    
    accounts.forEach(account => {
      if (account?.balances?.perCurrencyBalances) {
        account.balances.perCurrencyBalances.forEach(balance => {
          balances.push({
            accountId: account.accountId,
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
  }

  /**
   * Get dividend calendar
   */
  async getDividendCalendar(options = {}) {
    try {
      const {
        viewMode = 'all',
        accountId,
        personName,
        startDate,
        endDate,
        groupBy = 'month'
      } = options;

      // Build filter
      const positionFilter = {};
      if (accountId) positionFilter.accountId = accountId;
      if (personName) positionFilter.personName = personName;

      // Get positions
      const positions = await Position.find(positionFilter).lean();
      const symbols = [...new Set(positions.map(p => p.symbol))];

      // Get dividend activities
      const activityFilter = {
        type: 'Dividend',
        symbol: { $in: symbols }
      };
      if (accountId) activityFilter.accountId = accountId;
      if (personName) activityFilter.personName = personName;
      if (startDate || endDate) {
        activityFilter.transactionDate = {};
        if (startDate) activityFilter.transactionDate.$gte = new Date(startDate);
        if (endDate) activityFilter.transactionDate.$lte = new Date(endDate);
      }

      const dividendActivities = await Activity.find(activityFilter)
        .sort({ transactionDate: -1 })
        .lean();

      // Build calendar
      const calendar = this.buildDividendCalendar(
        positions,
        dividendActivities,
        { startDate, endDate, groupBy }
      );

      return {
        viewMode,
        accountId,
        personName,
        calendar,
        summary: {
          totalAnnualDividends: this.calculateAnnualDividends(positions),
          averageYield: this.calculateAverageYield(positions),
          dividendStockCount: positions.filter(p => p.isDividendStock).length
        }
      };
    } catch (error) {
      logger.error('Error getting dividend calendar:', error);
      throw error;
    }
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(options = {}) {
    try {
      const {
        accountId,
        personName,
        period = '1M',
        groupBy = 'day'
      } = options;

      // Calculate date range based on period
      const endDate = new Date();
      const startDate = this.getStartDateForPeriod(period);

      // Build filter
      const filter = {
        date: { 
          $gte: startDate,
          $lte: endDate
        }
      };
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;

      // Get snapshots for the period
      const snapshots = await PortfolioSnapshot.find(filter)
        .sort({ date: 1 })
        .lean();

      if (snapshots.length === 0) {
        return {
          period,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          metrics: [],
          summary: {
            totalReturn: 0,
            totalReturnPercent: 0,
            averageDailyReturn: 0,
            volatility: 0,
            sharpeRatio: 0
          }
        };
      }

      // Group and calculate metrics
      const metrics = this.groupPerformanceData(snapshots, groupBy);
      const summary = this.calculatePerformanceSummary(snapshots);

      return {
        period,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        metrics,
        summary
      };
    } catch (error) {
      logger.error('Error getting performance metrics:', error);
      throw error;
    }
  }

  /**
   * Get dividend summary
   */
  async getDividendSummary(options = {}) {
    try {
      const {
        accountId,
        personName,
        startDate,
        endDate,
        groupBy = 'month'
      } = options;

      // Build filter
      const filter = { type: 'Dividend' };
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;
      if (startDate || endDate) {
        filter.transactionDate = {};
        if (startDate) filter.transactionDate.$gte = new Date(startDate);
        if (endDate) filter.transactionDate.$lte = new Date(endDate);
      }

      const dividends = await Activity.find(filter)
        .sort({ transactionDate: -1 })
        .lean();

      // Group dividends
      const grouped = this.groupDividendData(dividends, groupBy);
      
      // Calculate summary
      const totalDividends = dividends.reduce((sum, d) => sum + Math.abs(d.netAmount || 0), 0);
      const uniqueSymbols = new Set(dividends.map(d => d.symbol)).size;
      const uniqueAccounts = new Set(dividends.map(d => d.accountId)).size;
      const uniquePersons = new Set(dividends.map(d => d.personName).filter(p => p)).size;
      
      return {
        totalDividends,
        dividendCount: dividends.length,
        uniqueSymbols,
        uniqueAccounts,
        uniquePersons,
        averagePerDividend: dividends.length > 0 ? totalDividends / dividends.length : 0,
        grouped,
        dividends
      };
    } catch (error) {
      logger.error('Error getting dividend summary:', error);
      throw error;
    }
  }

  /**
   * Get portfolio allocation
   */
  async getAllocation(options = {}) {
    try {
      const {
        accountId,
        personName,
        groupBy = 'sector'
      } = options;

      // Build filter
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;

      const positions = await Position.find(filter).lean();
      
      let allocation = [];
      
      switch (groupBy) {
        case 'sector':
          allocation = await this.allocateBySector(positions);
          break;
        case 'type':
          allocation = this.allocateByType(positions);
          break;
        case 'currency':
          allocation = this.allocateByCurrency(positions);
          break;
        case 'account':
          allocation = this.allocateByAccount(positions);
          break;
        case 'person':
          allocation = this.allocateByPerson(positions);
          break;
        default:
          allocation = this.allocateByType(positions);
      }

      // Calculate percentages
      const totalValue = allocation.reduce((sum, a) => sum + a.value, 0);
      allocation = allocation.map(a => ({
        ...a,
        percentage: totalValue > 0 ? (a.value / totalValue) * 100 : 0
      }));

      // Sort by value descending
      allocation.sort((a, b) => b.value - a.value);

      return {
        groupBy,
        totalValue,
        allocation
      };
    } catch (error) {
      logger.error('Error getting portfolio allocation:', error);
      throw error;
    }
  }

  /**
   * Create portfolio snapshot
   */
  async createSnapshot(options = {}) {
    try {
      const { accountId, personName } = options;

      // Build filter
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;

      const positions = await Position.find(filter).lean();
      const accounts = await Account.find(filter).lean();

      const totalValue = positions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
      const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
      const unrealizedPnl = positions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
      const totalDividends = positions.reduce((sum, p) => 
        sum + (p.dividendData?.totalReceived || 0), 0);
      
      const totalReturnValue = unrealizedPnl + totalDividends;
      const totalReturnPercent = totalCost > 0 ? 
        (totalReturnValue / totalCost) * 100 : 0;

      const snapshot = new PortfolioSnapshot({
        accountId,
        personName,
        viewMode: accountId ? 'account' : (personName ? 'person' : 'all'),
        date: new Date(),
        totalInvestment: totalCost,
        currentValue: totalValue,
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
      
      return snapshot;
    } catch (error) {
      logger.error('Error creating portfolio snapshot:', error);
      throw error;
    }
  }

  // Helper methods
  getStartDateForPeriod(period) {
    const date = new Date();
    switch (period) {
      case '1D': date.setDate(date.getDate() - 1); break;
      case '1W': date.setDate(date.getDate() - 7); break;
      case '1M': date.setMonth(date.getMonth() - 1); break;
      case '3M': date.setMonth(date.getMonth() - 3); break;
      case '6M': date.setMonth(date.getMonth() - 6); break;
      case '1Y': date.setFullYear(date.getFullYear() - 1); break;
      case 'YTD': 
        date.setMonth(0); 
        date.setDate(1); 
        date.setHours(0, 0, 0, 0);
        break;
      case 'ALL': date.setFullYear(2000); break;
      default: date.setMonth(date.getMonth() - 1);
    }
    return date;
  }

  groupPerformanceData(snapshots, groupBy) {
    const grouped = new Map();
    
    snapshots.forEach(snapshot => {
      let key;
      const date = new Date(snapshot.date);
      
      switch (groupBy) {
        case 'day':
          key = date.toISOString().split('T')[0];
          break;
        case 'week':
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          key = weekStart.toISOString().split('T')[0];
          break;
        case 'month':
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
        default:
          key = date.toISOString().split('T')[0];
      }
      
      if (!grouped.has(key)) {
        grouped.set(key, {
          date: key,
          totalValue: 0,
          totalCost: 0,
          totalPnL: 0,
          count: 0
        });
      }
      
      const group = grouped.get(key);
      group.totalValue += snapshot.currentValue || 0;
      group.totalCost += snapshot.totalInvestment || 0;
      group.totalPnL += snapshot.unrealizedPnl || 0;
      group.count++;
    });
    
    return Array.from(grouped.values()).map(g => ({
      date: g.date,
      value: g.totalValue / g.count,
      pnl: g.totalPnL / g.count,
      pnlPercent: g.totalCost > 0 ? (g.totalPnL / g.totalCost) * 100 : 0
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  calculatePerformanceSummary(snapshots) {
    if (snapshots.length < 2) {
      return {
        totalReturn: 0,
        totalReturnPercent: 0,
        averageDailyReturn: 0,
        volatility: 0,
        sharpeRatio: 0
      };
    }

    const sorted = [...snapshots].sort((a, b) => 
      new Date(a.date) - new Date(b.date)
    );

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalReturn = last.currentValue - first.currentValue;
    const totalReturnPercent = first.currentValue > 0 
      ? (totalReturn / first.currentValue) * 100 
      : 0;

    // Calculate daily returns for volatility
    const dailyReturns = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevValue = sorted[i - 1].currentValue;
      const currValue = sorted[i].currentValue;
      if (prevValue > 0) {
        dailyReturns.push((currValue - prevValue) / prevValue);
      }
    }

    const averageDailyReturn = dailyReturns.length > 0
      ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      : 0;

    // Calculate volatility (standard deviation)
    const variance = dailyReturns.length > 0
      ? dailyReturns.reduce((sum, r) => sum + Math.pow(r - averageDailyReturn, 2), 0) / dailyReturns.length
      : 0;
    const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized

    // Calculate Sharpe ratio (assuming risk-free rate of 2%)
    const riskFreeRate = 0.02;
    const annualizedReturn = averageDailyReturn * 252;
    const sharpeRatio = volatility > 0 
      ? (annualizedReturn - riskFreeRate) / (volatility / 100)
      : 0;

    return {
      totalReturn,
      totalReturnPercent,
      averageDailyReturn: averageDailyReturn * 100,
      volatility,
      sharpeRatio
    };
  }

  groupDividendData(dividends, groupBy) {
    const grouped = new Map();
    
    dividends.forEach(dividend => {
      let key;
      switch (groupBy) {
        case 'month':
          key = dividend.transactionDate ? 
            new Date(dividend.transactionDate).toISOString().substring(0, 7) : 'Unknown';
          break;
        case 'quarter':
          if (dividend.transactionDate) {
            const date = new Date(dividend.transactionDate);
            key = `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
          } else {
            key = 'Unknown';
          }
          break;
        case 'year':
          key = dividend.transactionDate ? 
            new Date(dividend.transactionDate).getFullYear().toString() : 'Unknown';
          break;
        case 'symbol':
          key = dividend.symbol;
          break;
        default:
          key = dividend.transactionDate ? 
            new Date(dividend.transactionDate).toISOString().substring(0, 7) : 'Unknown';
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          period: key,
          totalAmount: 0,
          count: 0,
          symbols: new Set()
        });
      }

      const group = grouped.get(key);
      group.totalAmount += Math.abs(dividend.netAmount || 0);
      group.count += 1;
      group.symbols.add(dividend.symbol);
    });

    return Array.from(grouped.values()).map(g => ({
      ...g,
      symbols: Array.from(g.symbols),
      symbolCount: g.symbols.size
    })).sort((a, b) => b.period.localeCompare(a.period));
  }

  buildDividendCalendar(positions, dividendActivities, options) {
    const calendar = [];

    // Add historical dividends
    dividendActivities.forEach(dividend => {
      calendar.push({
        symbol: dividend.symbol,
        paymentDate: dividend.transactionDate,
        amount: Math.abs(dividend.netAmount || 0),
        accountId: dividend.accountId,
        personName: dividend.personName,
        isHistorical: true
      });
    });

    // Sort by payment date
    calendar.sort((a, b) => {
      const dateA = new Date(a.paymentDate);
      const dateB = new Date(b.paymentDate);
      return dateA - dateB;
    });

    return calendar;
  }

  calculateAnnualDividends(positions) {
    return positions.reduce((sum, position) => {
      if (position.dividendData) {
        return sum + (position.dividendData.annualDividend || 0);
      }
      return sum;
    }, 0);
  }

  calculateAverageYield(positions) {
    let totalValue = 0;
    let totalDividendValue = 0;

    positions.forEach(position => {
      if (position.isDividendStock && position.dividendData) {
        const positionValue = position.currentMarketValue || 0;
        totalValue += positionValue;
        const annualDividend = position.dividendData.annualDividend || 0;
        totalDividendValue += annualDividend;
      }
    });

    return totalValue > 0 ? (totalDividendValue / totalValue) * 100 : 0;
  }

  allocateByType(positions) {
    const groups = new Map();
    
    positions.forEach(position => {
      const type = position.securityType || 'Unknown';
      if (!groups.has(type)) {
        groups.set(type, {
          name: type,
          value: 0,
          cost: 0,
          positions: [],
          symbols: new Set()
        });
      }
      
      const group = groups.get(type);
      group.value += position.currentMarketValue || 0;
      group.cost += position.totalCost || 0;
      group.positions.push(position.symbol);
      group.symbols.add(position.symbol);
    });

    return Array.from(groups.values()).map(g => ({
      ...g,
      symbolCount: g.symbols.size,
      symbols: Array.from(g.symbols)
    }));
  }

  allocateByCurrency(positions) {
    const groups = new Map();
    
    positions.forEach(position => {
      const currency = position.currency || 'USD';
      if (!groups.has(currency)) {
        groups.set(currency, {
          name: currency,
          value: 0,
          cost: 0,
          positions: [],
          symbols: new Set()
        });
      }
      
      const group = groups.get(currency);
      group.value += position.currentMarketValue || 0;
      group.cost += position.totalCost || 0;
      group.positions.push(position.symbol);
      group.symbols.add(position.symbol);
    });

    return Array.from(groups.values()).map(g => ({
      ...g,
      symbolCount: g.symbols.size,
      symbols: Array.from(g.symbols)
    }));
  }

  allocateByAccount(positions) {
    const groups = new Map();
    
    positions.forEach(position => {
      const accountKey = position.accountId;
      if (!groups.has(accountKey)) {
        groups.set(accountKey, {
          name: position.accountId,
          accountId: position.accountId,
          personName: position.personName,
          value: 0,
          cost: 0,
          positions: [],
          symbols: new Set()
        });
      }
      
      const group = groups.get(accountKey);
      group.value += position.currentMarketValue || 0;
      group.cost += position.totalCost || 0;
      group.positions.push(position.symbol);
      group.symbols.add(position.symbol);
    });

    return Array.from(groups.values()).map(g => ({
      ...g,
      symbolCount: g.symbols.size,
      symbols: Array.from(g.symbols)
    }));
  }

  allocateByPerson(positions) {
    const groups = new Map();
    
    positions.forEach(position => {
      const person = position.personName || 'Unknown';
      if (!groups.has(person)) {
        groups.set(person, {
          name: person,
          value: 0,
          cost: 0,
          positions: [],
          symbols: new Set(),
          accounts: new Set()
        });
      }
      
      const group = groups.get(person);
      group.value += position.currentMarketValue || 0;
      group.cost += position.totalCost || 0;
      group.positions.push(position.symbol);
      group.symbols.add(position.symbol);
      group.accounts.add(position.accountId);
    });

    return Array.from(groups.values()).map(g => ({
      ...g,
      symbolCount: g.symbols.size,
      symbols: Array.from(g.symbols),
      accountCount: g.accounts.size,
      accounts: Array.from(g.accounts)
    }));
  }

  async allocateBySector(positions) {
    try {
      const sectorMap = {
        'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA'],
        'Financial': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'TD.TO', 'RY.TO', 'BNS.TO'],
        'Healthcare': ['JNJ', 'PFE', 'UNH', 'CVS', 'ABBV'],
        'Consumer': ['AMZN', 'WMT', 'HD', 'NKE', 'MCD'],
        'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
        'Industrial': ['BA', 'CAT', 'GE', 'MMM', 'HON'],
        'Materials': ['GOLD', 'NEM', 'FCX', 'KILO.TO'],
        'Utilities': ['NEE', 'DUK', 'SO', 'D', 'AEP'],
        'Real Estate': ['AMT', 'PLD', 'CCI', 'EQIX', 'PSA'],
        'ETF': ['SPY', 'QQQ', 'VTI', 'IWM', 'GLD', 'VFV.TO', 'HMAX.TO']
      };

      const groups = new Map();

      positions.forEach(position => {
        let sector = 'Other';
        
        // Find sector for symbol
        for (const [sectorName, symbols] of Object.entries(sectorMap)) {
          if (symbols.includes(position.symbol)) {
            sector = sectorName;
            break;
          }
        }

        if (!groups.has(sector)) {
          groups.set(sector, {
            name: sector,
            value: 0,
            cost: 0,
            positions: [],
            symbols: new Set()
          });
        }

        const group = groups.get(sector);
        group.value += position.currentMarketValue || 0;
        group.cost += position.totalCost || 0;
        group.positions.push(position.symbol);
        group.symbols.add(position.symbol);
      });

      return Array.from(groups.values()).map(g => ({
        ...g,
        symbolCount: g.symbols.size,
        symbols: Array.from(g.symbols)
      }));
    } catch (error) {
      logger.error('Error allocating by sector:', error);
      return this.allocateByType(positions);
    }
  }
}

module.exports = PortfolioCalculatorService;