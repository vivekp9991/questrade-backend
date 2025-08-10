// services/accountAggregator.js
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Account = require('../models/Account');
const Symbol = require('../models/Symbol');
const logger = require('../utils/logger');

class AccountAggregator {
  
  // Aggregate positions across accounts
  async aggregatePositions(viewMode, personName = null, accountId = null) {
    try {
      let query = {};
      
      // Build query based on view mode
      switch (viewMode) {
        case 'all':
          // No additional filters - get all positions
          break;
        case 'person':
          if (personName) {
            query.personName = personName;
          }
          break;
        case 'account':
          if (accountId) {
            query.accountId = accountId;
          }
          break;
        default:
          throw new Error('Invalid view mode');
      }

      const positions = await Position.find(query).lean();
      
      if (positions.length === 0) {
        return [];
      }

      // If single account view, return positions as-is
      if (viewMode === 'account') {
        return await this.enrichPositions(positions);
      }

      // Group positions by symbol for aggregation
      const symbolGroups = {};
      
      positions.forEach(position => {
        const symbol = position.symbol;
        if (!symbolGroups[symbol]) {
          symbolGroups[symbol] = [];
        }
        symbolGroups[symbol].push(position);
      });

      // Aggregate each symbol group
      const aggregatedPositions = [];
      
      for (const [symbol, positions] of Object.entries(symbolGroups)) {
        if (positions.length === 1) {
          // Single position, no aggregation needed
          aggregatedPositions.push(positions[0]);
        } else {
          // Multiple positions for same symbol, aggregate them
          const aggregated = await this.aggregateSymbolPositions(symbol, positions);
          aggregatedPositions.push(aggregated);
        }
      }

      return await this.enrichPositions(aggregatedPositions);
    } catch (error) {
      logger.error('Error aggregating positions:', error);
      throw error;
    }
  }

  // Aggregate multiple positions of the same symbol
  async aggregateSymbolPositions(symbol, positions) {
    try {
      // Get symbol info for the aggregated position
      const symbolInfo = await Symbol.findOne({ symbol }).lean();
      
      // Initialize aggregated values
      let totalShares = 0;
      let totalCost = 0;
      let totalMarketValue = 0;
      let totalDividendsReceived = 0;
      let totalMonthlyDividend = 0;
      let totalAnnualDividend = 0;
      let totalOpenPnl = 0;
      let totalDayPnl = 0;
      
      const sourceAccounts = [];
      const personNames = new Set();
      let latestPrice = 0;
      let latestMarketData = null;
      let latestSyncedAt = null;

      // Aggregate values from all positions
      positions.forEach(position => {
        totalShares += position.openQuantity || 0;
        totalCost += position.totalCost || 0;
        totalMarketValue += position.currentMarketValue || 0;
        totalOpenPnl += position.openPnl || 0;
        totalDayPnl += position.dayPnl || 0;
        
        sourceAccounts.push(position.accountId);
        personNames.add(position.personName);
        
        // Use the most recent price and market data
        if (!latestSyncedAt || position.syncedAt > latestSyncedAt) {
          latestPrice = position.currentPrice || 0;
          latestMarketData = position.marketData;
          latestSyncedAt = position.syncedAt;
        }
        
        // Aggregate dividend data
        if (position.dividendData) {
          totalDividendsReceived += position.dividendData.totalReceived || 0;
          totalMonthlyDividend += position.dividendData.monthlyDividend || 0;
          totalAnnualDividend += position.dividendData.annualDividend || 0;
        }
      });

      // Calculate aggregated metrics
      const weightedAverageCost = totalShares > 0 ? totalCost / totalShares : 0;
      const totalReturnValue = totalOpenPnl + totalDividendsReceived;
      const totalReturnPercent = totalCost > 0 ? (totalReturnValue / totalCost) * 100 : 0;
      const capitalGainPercent = totalCost > 0 ? (totalOpenPnl / totalCost) * 100 : 0;
      
      // Dividend metrics
      const dividendReturnPercent = totalCost > 0 ? (totalDividendsReceived / totalCost) * 100 : 0;
      const yieldOnCost = weightedAverageCost > 0 && totalShares > 0
        ? ((totalAnnualDividend / totalShares) / weightedAverageCost) * 100
        : 0;
      const currentYield = latestPrice > 0 && totalShares > 0
        ? ((totalAnnualDividend / totalShares) / latestPrice) * 100
        : 0;
       // When no dividends have been received, keep original cost values
      // rather than subtracting zero or returning confusing numbers.
      // If dividends exist, adjust the cost accordingly.
      let dividendAdjustedCostPerShare;
      let dividendAdjustedCost;

      if (totalDividendsReceived > 0 && totalShares > 0) {
        dividendAdjustedCostPerShare = weightedAverageCost - (totalDividendsReceived / totalShares);
        dividendAdjustedCost = dividendAdjustedCostPerShare * totalShares;
      } else {
        dividendAdjustedCostPerShare = totalShares > 0 ? weightedAverageCost : null;
        dividendAdjustedCost = totalCost > 0 ? totalCost : null;
      }

      // Create aggregated position
      return {
        symbol,
        symbolId: positions[0].symbolId, // Same for all positions of this symbol
        personName: personNames.size === 1 ? Array.from(personNames)[0] : 'Multiple',
        accountId: 'AGGREGATED',
        
        // Aggregated quantities and values
        openQuantity: totalShares,
        closedQuantity: 0,
        currentMarketValue: totalMarketValue,
        currentPrice: latestPrice,
        averageEntryPrice: weightedAverageCost,
        totalCost: totalCost,
        
        // Aggregated P&L
        openPnl: totalOpenPnl,
        dayPnl: totalDayPnl,
        closedPnl: 0,
        
        // Calculated fields
        totalReturnPercent,
        totalReturnValue,
        capitalGainPercent,
        capitalGainValue: totalOpenPnl,
        
        // Aggregated dividend data
        dividendData: {
          totalReceived: totalDividendsReceived,
          dividendReturnPercent,
          yieldOnCost,
          dividendAdjustedCost,
          dividendAdjustedCostPerShare,
          monthlyDividend: totalMonthlyDividend,
          monthlyDividendPerShare: totalShares > 0 ? totalMonthlyDividend / totalShares : 0,
          annualDividend: totalAnnualDividend,
          annualDividendPerShare: totalShares > 0 ? totalAnnualDividend / totalShares : 0,
          lastDividendDate: this.getLatestDividendDate(positions),
          lastDividendAmount: this.getLatestDividendAmount(positions)
        },
        
        // Market data (use latest)
        marketData: latestMarketData,
        
        // Aggregation metadata
        isAggregated: true,
        sourceAccounts,
        numberOfAccounts: sourceAccounts.length,
        
        // Timestamps
        syncedAt: latestSyncedAt,
        updatedAt: new Date(),
        
        // Additional symbol info
        industrySector: symbolInfo?.industrySector,
        industryGroup: symbolInfo?.industryGroup,
        currency: symbolInfo?.currency,
        isDividendStock: totalAnnualDividend > 0
      };
    } catch (error) {
      logger.error(`Error aggregating positions for symbol ${symbol}:`, error);
      throw error;
    }
  }

  // Get portfolio summary with aggregation
  async getAggregatedSummary(viewMode, personName = null, accountId = null) {
    try {
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      
      if (positions.length === 0) {
        return null;
      }

      // Calculate summary metrics
      let totalInvestment = 0;
      let currentValue = 0;
      let unrealizedPnl = 0;
      let totalDividends = 0;
      let monthlyDividendIncome = 0;
      let annualProjectedDividend = 0;
      
      const sectorMap = {};
      const currencyMap = {};
      const personMap = {};

      positions.forEach(position => {
        totalInvestment += position.totalCost || 0;
        currentValue += position.currentMarketValue || 0;
        unrealizedPnl += position.openPnl || 0;
        
        if (position.dividendData) {
          totalDividends += position.dividendData.totalReceived || 0;
          monthlyDividendIncome += position.dividendData.monthlyDividend || 0;
          annualProjectedDividend += position.dividendData.annualDividend || 0;
        }
        
        // Sector allocation
        const sector = position.industrySector || position.securityType || 'Other';
        sectorMap[sector] = (sectorMap[sector] || 0) + (position.currentMarketValue || 0);
        
        // Currency allocation
        const currency = position.currency || 'CAD';
        currencyMap[currency] = (currencyMap[currency] || 0) + (position.currentMarketValue || 0);
        
        // Person allocation (for "all" view)
        if (viewMode === 'all' && position.personName !== 'Multiple') {
          personMap[position.personName] = (personMap[position.personName] || 0) + (position.currentMarketValue || 0);
        }
      });

      const totalReturnValue = unrealizedPnl + totalDividends;
      const totalReturnPercent = totalInvestment > 0 ? (totalReturnValue / totalInvestment) * 100 : 0;
      const averageYieldPercent = currentValue > 0 ? (annualProjectedDividend / currentValue) * 100 : 0;
      const yieldOnCostPercent = totalInvestment > 0 ? (annualProjectedDividend / totalInvestment) * 100 : 0;

      // Format allocations
      const sectorAllocation = Object.entries(sectorMap).map(([sector, value]) => ({
        sector,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
      }));

      const currencyBreakdown = Object.entries(currencyMap).map(([currency, value]) => ({
        currency,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
      }));

      const personBreakdown = Object.entries(personMap).map(([person, value]) => ({
        personName: person,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0,
        numberOfPositions: positions.filter(p => p.personName === person).length
      }));

      // Get account count
      const accountIds = new Set();
      positions.forEach(position => {
        if (position.isAggregated) {
          position.sourceAccounts?.forEach(acc => accountIds.add(acc));
        } else {
          accountIds.add(position.accountId);
        }
      });

      return {
        viewMode,
        personName,
        accountId,
        totalInvestment,
        currentValue,
        totalReturnValue,
        totalReturnPercent,
        unrealizedPnl,
        totalDividends,
        monthlyDividendIncome,
        annualProjectedDividend,
        averageYieldPercent,
        yieldOnCostPercent,
        numberOfPositions: positions.length,
        numberOfAccounts: accountIds.size,
        numberOfDividendStocks: positions.filter(p => 
          p.dividendData && p.dividendData.annualDividend > 0
        ).length,
        sectorAllocation,
        currencyBreakdown,
        personBreakdown: viewMode === 'all' ? personBreakdown : [],
        aggregationInfo: {
          hasAggregatedPositions: positions.some(p => p.isAggregated),
          totalAggregatedSymbols: positions.filter(p => p.isAggregated).length
        }
      };
    } catch (error) {
      logger.error('Error getting aggregated summary:', error);
      throw error;
    }
  }

  // Enrich positions with additional symbol information
  async enrichPositions(positions) {
    try {
      const symbolIds = [...new Set(positions.map(p => p.symbolId))];
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      return positions.map(position => ({
        ...position,
        dividendPerShare: symbolMap[position.symbolId]?.dividendPerShare ?? symbolMap[position.symbolId]?.dividend,
        industrySector: position.industrySector || symbolMap[position.symbolId]?.industrySector,
        industryGroup: position.industryGroup || symbolMap[position.symbolId]?.industryGroup,
        industrySubGroup: symbolMap[position.symbolId]?.industrySubGroup,
        currency: position.currency || symbolMap[position.symbolId]?.currency,
        securityType: symbolMap[position.symbolId]?.securityType
      }));
    } catch (error) {
      logger.error('Error enriching positions:', error);
      return positions;
    }
  }

  // Helper method to get latest dividend date from positions
  getLatestDividendDate(positions) {
    let latestDate = null;
    positions.forEach(position => {
      if (position.dividendData?.lastDividendDate) {
        if (!latestDate || position.dividendData.lastDividendDate > latestDate) {
          latestDate = position.dividendData.lastDividendDate;
        }
      }
    });
    return latestDate;
  }

  // Helper method to get latest dividend amount from positions
  getLatestDividendAmount(positions) {
    let latestAmount = 0;
    let latestDate = null;
    positions.forEach(position => {
      if (position.dividendData?.lastDividendDate) {
        if (!latestDate || position.dividendData.lastDividendDate > latestDate) {
          latestDate = position.dividendData.lastDividendDate;
          latestAmount = position.dividendData.lastDividendAmount || 0;
        }
      }
    });
    return latestAmount;
  }

  // Get account dropdown options
  async getAccountDropdownOptions() {
    try {
      const persons = await Person.find({ isActive: true }).lean();
      const accounts = await Account.find({}).lean();
      
      const options = [];
      
      // Add "All Accounts" option
      options.push({
        value: 'all',
        label: 'All Accounts',
        type: 'all',
        personName: null,
        accountId: null
      });
      
      // Add person-specific options
      for (const person of persons) {
        const personAccounts = accounts.filter(acc => acc.personName === person.personName);
        
        if (personAccounts.length > 0) {
          // Add "All Accounts - PersonName" option
          options.push({
            value: `person-${person.personName}`,
            label: `All Accounts - ${person.personName}`,
            type: 'person',
            personName: person.personName,
            accountId: null
          });
          
          // Add individual account options
          personAccounts.forEach(account => {
            options.push({
              value: `account-${account.accountId}`,
              label: `${person.personName} ${account.type} - ${account.accountId}`,
              type: 'account',
              personName: person.personName,
              accountId: account.accountId
            });
          });
        }
      }
      
      return options;
    } catch (error) {
      logger.error('Error getting account dropdown options:', error);
      throw error;
    }
  }
}

module.exports = new AccountAggregator();