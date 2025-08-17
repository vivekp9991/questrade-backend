// services/accountAggregator.js - FIXED VERSION - Properly handles totalReceived in dividend aggregation
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Account = require('../models/Account');
const Symbol = require('../models/Symbol');
const logger = require('../utils/logger');
const Person = require('../models/Person');

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

      // If single account view, return positions as-is but enriched
      if (viewMode === 'account') {
        return await this.enrichPositions(positions);
      }

      // Build account map for quick lookup of account details
      const accountIds = [...new Set(positions.map(p => p.accountId))];
      const accounts = await Account.find({ accountId: { $in: accountIds } }).lean();
      const accountMap = {};
      accounts.forEach(acc => { accountMap[acc.accountId] = acc; });

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
          // Single position, no aggregation needed - but still enrich
          const enriched = await this.enrichPositions([positions[0]]);
          aggregatedPositions.push(enriched[0]);
        } else {
          // Multiple positions for same symbol, aggregate them
          const aggregated = await this.aggregateSymbolPositions(symbol, positions, accountMap);
          aggregatedPositions.push(aggregated);
        }
      }

      return aggregatedPositions;
    } catch (error) {
      logger.error('Error aggregating positions:', error);
      throw error;
    }
  }

  // FIXED: Aggregate multiple positions of the same symbol with proper totalReceived calculation
  async aggregateSymbolPositions(symbol, positions, accountMap = {}) {
    try {
      // Get symbol info for the aggregated position
      const symbolInfo = await Symbol.findOne({ symbol }).lean();
      
      // Initialize aggregated values
      let totalShares = 0;
      let totalCost = 0;
      let totalMarketValue = 0;
      let totalDividendsReceived = 0; // FIXED: Initialize properly
      let totalMonthlyDividend = 0;
      let totalAnnualDividend = 0;
      let totalOpenPnl = 0;
      let totalDayPnl = 0;
      
      const sourceAccounts = [];
      const personNames = new Set();
      let latestPrice = 0;
      let latestMarketData = null;
      let latestSyncedAt = null;

      // FIXED: Track dividend per share from positions (use the most common/recent value)
      const dividendPerShareValues = [];

      // FIXED: Aggregate values from all positions including totalReceived
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
        
        // FIXED: Aggregate dividend data including totalReceived
        if (position.dividendData) {
          totalDividendsReceived += position.dividendData.totalReceived || 0; // FIXED: Properly aggregate totalReceived
          totalMonthlyDividend += position.dividendData.monthlyDividend || 0;
          totalAnnualDividend += position.dividendData.annualDividend || 0;
        }

        // FIXED: Collect dividendPerShare values from positions
        if (position.dividendPerShare && position.dividendPerShare > 0) {
          dividendPerShareValues.push(position.dividendPerShare);
        }
      });

      // Calculate aggregated metrics
      const weightedAverageCost = totalShares > 0 ? totalCost / totalShares : 0;
      const totalReturnValue = totalOpenPnl + totalDividendsReceived; // FIXED: Use actual totalDividendsReceived
      const totalReturnPercent = totalCost > 0 ? (totalReturnValue / totalCost) * 100 : 0;
      const capitalGainPercent = totalCost > 0 ? (totalOpenPnl / totalCost) * 100 : 0;
      
      // FIXED: Dividend metrics using actual totalDividendsReceived
      const dividendReturnPercent = totalCost > 0 ? (totalDividendsReceived / totalCost) * 100 : 0;
      const yieldOnCost = weightedAverageCost > 0 && totalShares > 0
        ? ((totalAnnualDividend / totalShares) / weightedAverageCost) * 100
        : 0;

      // FIXED: Calculate dividendPerShare more intelligently
      let aggregatedDividendPerShare = 0;
      
      // First, try to use values from positions
      if (dividendPerShareValues.length > 0) {
        // Use the most common value, or if tied, the highest value
        const valueCount = {};
        dividendPerShareValues.forEach(val => {
          valueCount[val] = (valueCount[val] || 0) + 1;
        });
        
        // Get the most frequent value
        const sortedValues = Object.entries(valueCount)
          .sort((a, b) => {
            // Sort by frequency first, then by value (descending)
            if (b[1] !== a[1]) return b[1] - a[1];
            return parseFloat(b[0]) - parseFloat(a[0]);
          });
        
        aggregatedDividendPerShare = parseFloat(sortedValues[0][0]);
      }
      
      // If no dividendPerShare from positions, try symbol data
      if (aggregatedDividendPerShare === 0 && symbolInfo) {
        const freq = symbolInfo.dividendFrequency?.toLowerCase();
        if (freq === 'monthly' || freq === 'quarterly') {
          aggregatedDividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
        } else {
          aggregatedDividendPerShare = 0;
        }
      }

      // FIXED: When dividends have been received, adjust cost appropriately
      let dividendAdjustedCostPerShare;
      let dividendAdjustedCost;

      if (totalDividendsReceived > 0 && totalShares > 0) {
        dividendAdjustedCostPerShare = Math.max(0, weightedAverageCost - (totalDividendsReceived / totalShares));
        dividendAdjustedCost = dividendAdjustedCostPerShare * totalShares;
      } else {
        dividendAdjustedCostPerShare = totalShares > 0 ? weightedAverageCost : null;
        dividendAdjustedCost = totalCost > 0 ? totalCost : null;
      }

      // Map each account's individual position for client display
      const individualPositions = positions.map(pos => {
        const account = accountMap[pos.accountId] || {};
        return {
          accountId: pos.accountId,
          accountName: account.displayName || account.nickname || `Account ${pos.accountId}`,
          accountType: account.type || account.clientAccountType,
          shares: pos.openQuantity,
          avgCost: pos.averageEntryPrice,
          marketValue: pos.currentMarketValue,
          totalCost: pos.totalCost,
          openPnl: pos.openPnl
        };
      });

      // FIXED: Determine if this is actually a dividend stock based on regular dividends
      const isDividendStock = totalAnnualDividend > 0 ||
                             aggregatedDividendPerShare > 0 ||
                             totalDividendsReceived > 0; // FIXED: Also check if dividends have been received

      // Create aggregated position
      const aggregatedPosition = {
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
        
        // FIXED: Aggregated dividend data with proper totalReceived
        dividendData: {
          totalReceived: totalDividendsReceived, // FIXED: Use aggregated totalDividendsReceived
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
        individualPositions,
        
        // Timestamps
        syncedAt: latestSyncedAt,
        updatedAt: new Date(),
        
        // FIXED: Use properly calculated dividend per share
        dividendPerShare: aggregatedDividendPerShare,
        industrySector: symbolInfo?.industrySector,
        industryGroup: symbolInfo?.industryGroup,
        currency: symbolInfo?.currency || positions[0]?.currency,
        securityType: symbolInfo?.securityType,
        isDividendStock
      };

      // FIXED: Log aggregation details for debugging
      if (totalDividendsReceived > 0) {
        logger.debug(`Aggregated ${symbol}: totalReceived=${totalDividendsReceived.toFixed(2)}, positions=${positions.length}`);
      }

      return aggregatedPosition;
    } catch (error) {
      logger.error(`Error aggregating positions for symbol ${symbol}:`, error);
      throw error;
    }
  }

// Get portfolio summary with aggregation and enhanced currency support
  async getAggregatedSummary(viewMode, personName = null, accountId = null) {
    try {
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      
      if (positions.length === 0) {
        return null;
      }

      // Get accounts for additional data
      let accountQuery = {};
      switch (viewMode) {
        case 'person':
          if (personName) accountQuery.personName = personName;
          break;
        case 'account':
          if (accountId) accountQuery.accountId = accountId;
          break;
        case 'all':
        default:
          // No additional filters
          break;
      }

      const accounts = await Account.find(accountQuery).lean();

      // Calculate summary metrics
      let totalInvestment = 0;
      let currentValue = 0;
      let unrealizedPnl = 0;
      let totalDividends = 0; // FIXED: This should be total dividends received
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
          totalDividends += position.dividendData.totalReceived || 0; // FIXED: Use totalReceived for actual dividends received
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

      const totalReturnValue = unrealizedPnl + totalDividends; // FIXED: totalDividends is now actual dividends received
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

      // Enhanced accounts summary with currency information
      const accountsSummary = accounts.map(account => {
        const accountPositions = positions.filter(p => 
          p.isAggregated ? p.sourceAccounts?.includes(account.accountId) : p.accountId === account.accountId
        );
        
        const accountValue = accountPositions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const accountInvestment = accountPositions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const accountPnl = accountPositions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
        
        // Get cash balance and currency from account
        let cashBalance = 0;
        let currency = 'CAD';
        
        if (account.balances && account.balances.combinedBalances) {
          const balance = account.balances.combinedBalances;
          cashBalance = balance.cash || 0;
          currency = balance.currency || 'CAD';
        }

        return {
          accountId: account.accountId,
          accountName: account.displayName || `${account.type} - ${account.accountId}`,
          accountType: account.type,
          currency: currency,
          totalInvestment: accountInvestment,
          currentValue: accountValue,
          unrealizedPnl: accountPnl,
          cashBalance: cashBalance,
          numberOfPositions: accountPositions.length,
          returnPercent: accountInvestment > 0 ? (accountPnl / accountInvestment) * 100 : 0,
          lastUpdated: account.syncedAt
        };
      });

      // Get account count
      const accountIds = new Set();
      positions.forEach(position => {
        if (position.isAggregated) {
          position.sourceAccounts?.forEach(acc => accountIds.add(acc));
        } else {
          accountIds.add(position.accountId);
        }
      });

      // Determine primary currency (most common currency in positions)
      const primaryCurrency = Object.entries(currencyMap).sort((a, b) => b[1] - a[1])[0]?.[0] || 'CAD';

      return {
        viewMode,
        personName,
        accountId,
        currency: primaryCurrency,
        totalInvestment,
        currentValue,
        totalReturnValue,
        totalReturnPercent,
        unrealizedPnl,
        totalDividends, // FIXED: This is now actual dividends received
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
        accounts: accountsSummary, // Enhanced accounts array with currency info
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


  // Enrich positions with additional symbol information - FIXED
  async enrichPositions(positions) {
    try {
      const symbolIds = [...new Set(positions.map(p => p.symbolId))];
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      return positions.map(position => {
        const symbolInfo = symbolMap[position.symbolId];
        const actualDividendData = position.dividendData || {};
        
        // FIXED: Prioritize existing dividendPerShare from position data
        let dividendPerShare = position.dividendPerShare || 0;
        
        // If position doesn't have dividendPerShare, try symbol data
        if (dividendPerShare === 0 && symbolInfo) {
          const freq = symbolInfo.dividendFrequency?.toLowerCase();
          if (freq === 'monthly' || freq === 'quarterly') {
            dividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
          }
        }
        
        // Check for regular dividend payments or if dividends have been received
        const hasRegularDividends =
          (actualDividendData.dividendFrequency === 12 || actualDividendData.dividendFrequency === 4) &&
          ((actualDividendData.annualDividend || 0) > 0 ||
           (actualDividendData.monthlyDividend || 0) > 0);

        const hasActualDividends = hasRegularDividends || 
                                  dividendPerShare > 0 || 
                                  (actualDividendData.totalReceived || 0) > 0; // FIXED: Check if dividends have been received

        
        // Enhanced logic for isDividendStock
        const isDividendStock = hasActualDividends;
        
        return {
          ...position,
          // FIXED: Always preserve the calculated dividendPerShare value
          dividendPerShare: isDividendStock ? dividendPerShare : 0,
          industrySector: position.industrySector || symbolInfo?.industrySector,
          industryGroup: position.industryGroup || symbolInfo?.industryGroup,
          industrySubGroup: symbolInfo?.industrySubGroup,
          currency: position.currency || symbolInfo?.currency,
          securityType: symbolInfo?.securityType,
          isDividendStock
        };
      });
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