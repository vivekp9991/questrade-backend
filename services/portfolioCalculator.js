// services/portfolioCalculator.js
const logger = require('../utils/logger');
const AccountAggregator = require('./accountAggregator');

class PortfolioCalculatorService {
  constructor(dbManager, queueManager) {
    this.dbManager = dbManager;
    this.queueManager = queueManager;
    this.accountAggregator = new AccountAggregator(dbManager);
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
      filter.includeClosedPositions = includeClosedPositions;

      // Get positions from database
      let positions = await this.dbManager.getPositions(filter);

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
        const accounts = await this.dbManager.getAccounts({ accountId });
        const account = accounts[0] || {};

        // Get cash balances for the specific account
        const cashBalances = await this.dbManager.getCashBalances({ accountId });
        
        // Calculate total cash from all currencies for this account
        let totalCash = 0;
        let cashByCurrency = {};
        
        if (cashBalances && cashBalances.length > 0) {
          cashBalances.forEach(balance => {
            const currency = balance.currency || 'CAD';
            const cashAmount = balance.cash || 0;
            
            if (!cashByCurrency[currency]) {
              cashByCurrency[currency] = 0;
            }
            cashByCurrency[currency] += cashAmount;
            totalCash += cashAmount;
          });
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
          accountName: account.displayName || account.name || account.accountId,
          accountType: account.type,
          personName: account.personName || personName,
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
          dayPnLPercent: 0, // Would need previous day's value
          dividendStocks: dividendPositions.length,
          totalDividendsReceived,
          annualDividendProjected,
          lastUpdated: new Date().toISOString()
        };
      } else if (viewMode === 'person' && personName) {
        // Person view
        if (!aggregate) {
          // Individual positions for person
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
        const accounts = await this.dbManager.getAccounts({ personName });
        
        // Get cash balances for the person
        const cashBalances = await this.dbManager.getCashBalances({ personName });
        let totalCash = 0;
        let cashByCurrency = {};
        
        if (cashBalances && cashBalances.length > 0) {
          cashBalances.forEach(balance => {
            const currency = balance.currency || 'CAD';
            const cashAmount = balance.cash || 0;
            
            if (!cashByCurrency[currency]) {
              cashByCurrency[currency] = 0;
            }
            cashByCurrency[currency] += cashAmount;
            totalCash += cashAmount;
          });
        }

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
            accountName: a.displayName || a.name || a.accountId,
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
      } else if (viewMode === 'type') {
        // Grouped by type view
        return {
          viewMode,
          types: positions,
          totalTypes: positions.length,
          grandTotalValue: positions.reduce((sum, t) => sum + (t.totalValue || 0), 0),
          grandTotalCost: positions.reduce((sum, t) => sum + (t.totalCost || 0), 0),
          grandTotalPnL: positions.reduce((sum, t) => sum + (t.totalPnL || 0), 0),
          lastUpdated: new Date().toISOString()
        };
      } else {
        // Default 'all' view - aggregated across everything
        if (!aggregate) {
          // Return individual positions
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
        const accounts = await this.dbManager.getAccounts();
        
        // Get all cash balances
        const cashBalances = await this.dbManager.getCashBalances();
        let totalCash = 0;
        let cashByCurrency = {};
        
        if (cashBalances && cashBalances.length > 0) {
          cashBalances.forEach(balance => {
            const currency = balance.currency || 'CAD';
            const cashAmount = balance.cash || 0;
            
            if (!cashByCurrency[currency]) {
              cashByCurrency[currency] = 0;
            }
            cashByCurrency[currency] += cashAmount;
            totalCash += cashAmount;
          });
        }

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
      // Filter positions that have dividend data
      return positions.filter(p => {
        // Check if position is marked as dividend stock
        if (p.isDividendStock) return true;
        
        // Check if position has dividend data with actual dividends
        if (p.dividendData) {
          if (p.dividendData.totalReceived > 0) return true;
          if (p.dividendData.annualDividend > 0) return true;
          if (p.dividendData.annualDividendPerShare > 0) return true;
        }
        
        // Check if position has dividendPerShare
        if (p.dividendPerShare > 0) return true;
        
        return false;
      });
    } catch (error) {
      logger.error('Error filtering dividend stocks:', error);
      return positions; // Return all positions if error
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
      filter.includeClosedPositions = includeClosedPositions;

      let positions = await this.dbManager.getPositions(filter);

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
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;
      if (startDate) filter.startDate = startDate;
      if (endDate) filter.endDate = endDate;

      // Get positions to know which symbols to check
      const positions = await this.dbManager.getPositions(filter);
      const symbols = [...new Set(positions.map(p => p.symbol))];

      // Get dividend info
      const dividendInfo = await this.dbManager.getDividendInfo(symbols);
      
      // Get historical dividends
      const historicalDividends = await this.dbManager.getDividends(filter);

      // Build calendar
      const calendar = this.buildDividendCalendar(
        positions,
        dividendInfo,
        historicalDividends,
        { startDate, endDate, groupBy }
      );

      return {
        viewMode,
        accountId,
        personName,
        calendar,
        summary: {
          totalAnnualDividends: this.calculateAnnualDividends(positions, dividendInfo),
          averageYield: this.calculateAverageYield(positions, dividendInfo),
          dividendStockCount: dividendInfo.filter(d => d.isDividendStock).length
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
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      };
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;

      // Get snapshots for the period
      const snapshots = await this.dbManager.getPortfolioSnapshots(filter);

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
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;
      if (startDate) filter.startDate = startDate;
      if (endDate) filter.endDate = endDate;

      const dividends = await this.dbManager.getDividends(filter);

      // Group dividends
      const grouped = this.groupDividendData(dividends, groupBy);
      
      // Calculate summary
      const totalDividends = dividends.reduce((sum, d) => sum + (d.amount || 0), 0);
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

      const positions = await this.dbManager.getPositions(filter);
      
      // Get additional data based on groupBy
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

      const accounts = await this.dbManager.getAccounts(filter);
      const snapshots = [];

      for (const account of accounts) {
        const positions = await this.dbManager.getPositions({ 
          accountId: account.accountId 
        });

        const totalValue = positions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = totalValue - totalCost;
        const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

        // Get cash balances
        const cashBalances = await this.dbManager.getCashBalances({ 
          accountId: account.accountId 
        });
        const totalCash = cashBalances.reduce((sum, b) => sum + (b.cash || 0), 0);

        const snapshot = {
          accountId: account.accountId,
          accountName: account.name,
          accountType: account.type,
          personName: account.personName,
          snapshotDate: new Date().toISOString(),
          totalValue,
          totalCost,
          totalPnL,
          totalPnLPercent,
          totalCash,
          totalAccountValue: totalValue + totalCash,
          positionCount: positions.length,
          positions: positions.map(p => ({
            symbol: p.symbol,
            quantity: p.openQuantity,
            marketValue: p.currentMarketValue,
            cost: p.totalCost,
            unrealizedPnL: p.currentMarketValue - p.totalCost
          }))
        };

        await this.dbManager.savePortfolioSnapshot(snapshot);
        snapshots.push(snapshot);
      }

      return snapshots;
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
      const date = new Date(snapshot.snapshotDate);
      
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
      group.totalValue += snapshot.totalValue || 0;
      group.totalCost += snapshot.totalCost || 0;
      group.totalPnL += snapshot.totalPnL || 0;
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

    // Sort by date
    const sorted = [...snapshots].sort((a, b) => 
      new Date(a.snapshotDate) - new Date(b.snapshotDate)
    );

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalReturn = last.totalValue - first.totalValue;
    const totalReturnPercent = first.totalValue > 0 
      ? (totalReturn / first.totalValue) * 100 
      : 0;

    // Calculate daily returns for volatility
    const dailyReturns = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevValue = sorted[i - 1].totalValue;
      const currValue = sorted[i].totalValue;
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
          key = dividend.paymentDate ? dividend.paymentDate.substring(0, 7) : 'Unknown';
          break;
        case 'quarter':
          if (dividend.paymentDate) {
            const date = new Date(dividend.paymentDate);
            key = `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
          } else {
            key = 'Unknown';
          }
          break;
        case 'year':
          key = dividend.paymentDate ? dividend.paymentDate.substring(0, 4) : 'Unknown';
          break;
        case 'symbol':
          key = dividend.symbol;
          break;
        case 'account':
          key = `${dividend.accountId}-${dividend.accountName || 'Unknown'}`;
          break;
        case 'person':
          key = dividend.personName || 'Unknown';
          break;
        default:
          key = dividend.paymentDate ? dividend.paymentDate.substring(0, 7) : 'Unknown';
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          period: key,
          totalAmount: 0,
          count: 0,
          symbols: new Set(),
          accounts: new Set(),
          persons: new Set()
        });
      }

      const group = grouped.get(key);
      group.totalAmount += dividend.amount || 0;
      group.count += 1;
      group.symbols.add(dividend.symbol);
      if (dividend.accountId) group.accounts.add(dividend.accountId);
      if (dividend.personName) group.persons.add(dividend.personName);
    });

    return Array.from(grouped.values()).map(g => ({
      ...g,
      symbols: Array.from(g.symbols),
      symbolCount: g.symbols.size,
      accounts: Array.from(g.accounts),
      accountCount: g.accounts.size,
      persons: Array.from(g.persons),
      personCount: g.persons.size
    })).sort((a, b) => b.period.localeCompare(a.period));
  }

  buildDividendCalendar(positions, dividendInfo, historicalDividends, options) {
    const { startDate, endDate, groupBy } = options;
    const calendar = [];

    // Build calendar entries from dividend info and positions
    dividendInfo.forEach(info => {
      if (!info.isDividendStock) return;

      const relevantPositions = positions.filter(p => p.symbol === info.symbol);
      if (relevantPositions.length === 0) return;

      const totalShares = relevantPositions.reduce((sum, p) => sum + (p.openQuantity || 0), 0);
      const estimatedAmount = totalShares * (info.dividendPerShare || 0);

      calendar.push({
        symbol: info.symbol,
        exDividendDate: info.exDividendDate,
        paymentDate: info.paymentDate,
        dividendPerShare: info.dividendPerShare,
        dividendYield: info.dividendYield,
        frequency: info.dividendFrequency,
        totalShares,
        estimatedAmount,
        accounts: relevantPositions.map(p => ({
          accountId: p.accountId,
          accountName: p.accountName,
          personName: p.personName,
          shares: p.openQuantity
        }))
      });
    });

    // Add historical dividends
    historicalDividends.forEach(dividend => {
      calendar.push({
        symbol: dividend.symbol,
        paymentDate: dividend.paymentDate,
        dividendPerShare: dividend.dividendPerShare,
        amount: dividend.amount,
        accountId: dividend.accountId,
        accountName: dividend.accountName,
        personName: dividend.personName,
        isHistorical: true
      });
    });

    // Sort by payment date
    calendar.sort((a, b) => {
      const dateA = new Date(a.paymentDate || a.exDividendDate);
      const dateB = new Date(b.paymentDate || b.exDividendDate);
      return dateA - dateB;
    });

    return calendar;
  }

  calculateAnnualDividends(positions, dividendInfo) {
    let totalAnnual = 0;

    dividendInfo.forEach(info => {
      if (!info.isDividendStock) return;

      const relevantPositions = positions.filter(p => p.symbol === info.symbol);
      const totalShares = relevantPositions.reduce((sum, p) => sum + (p.openQuantity || 0), 0);
      
      // Calculate based on frequency
      let paymentsPerYear = 4; // Default quarterly
      if (info.dividendFrequency === 'Monthly') paymentsPerYear = 12;
      else if (info.dividendFrequency === 'Annual') paymentsPerYear = 1;
      else if (info.dividendFrequency === 'Semi-Annual') paymentsPerYear = 2;

      totalAnnual += totalShares * (info.dividendPerShare || 0) * paymentsPerYear;
    });

    return totalAnnual;
  }

  calculateAverageYield(positions, dividendInfo) {
    let totalValue = 0;
    let totalDividendValue = 0;

    positions.forEach(position => {
      const info = dividendInfo.find(d => d.symbol === position.symbol);
      if (info && info.isDividendStock) {
        const positionValue = position.currentMarketValue || 0;
        totalValue += positionValue;
        totalDividendValue += positionValue * (info.dividendYield || 0) / 100;
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
      const accountKey = `${position.accountId}-${position.accountName}`;
      if (!groups.has(accountKey)) {
        groups.set(accountKey, {
          name: position.accountName || position.accountId,
          accountId: position.accountId,
          accountType: position.accountType,
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
      // This would require fetching sector data for each symbol
      // For now, using a mock implementation
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
      // Fallback to type allocation
      return this.allocateByType(positions);
    }
  }
}

module.exports = PortfolioCalculatorService;