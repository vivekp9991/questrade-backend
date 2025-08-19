// services/accountAggregator.js - Fixed to properly aggregate totalReceived from dividend data
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

  // Aggregate multiple positions of the same symbol - FIXED to properly sum totalReceived
  async aggregateSymbolPositions(symbol, positions, accountMap = {}) {
    try {
      // Get symbol info for the aggregated position
      const symbolInfo = await Symbol.findOne({ symbol }).lean();
      
      // Initialize aggregated values
      let totalShares = 0;
      let totalCost = 0;
      let totalMarketValue = 0;
      let totalDividendsReceived = 0; // IMPORTANT: Initialize to 0
      let totalMonthlyDividend = 0;
      let totalAnnualDividend = 0;
      let totalOpenPnl = 0;
      let totalDayPnl = 0;
      let totalClosedPnl = 0;
      
      const sourceAccounts = [];
      const personNames = new Set();
      let latestPrice = 0;
      let latestMarketData = null;
      let latestSyncedAt = null;

      // Track dividend information
      let lastDividendDate = null;
      let lastDividendAmount = 0;
      const dividendPerShareValues = [];

      // Aggregate values from all positions
      positions.forEach(position => {
        totalShares += position.openQuantity || 0;
        totalCost += position.totalCost || 0;
        totalMarketValue += position.currentMarketValue || 0;
        totalOpenPnl += position.openPnl || 0;
        totalDayPnl += position.dayPnl || 0;
        totalClosedPnl += position.closedPnl || 0;
        
        sourceAccounts.push(position.accountId);
        personNames.add(position.personName);
        
        // Use the most recent price and market data
        if (!latestSyncedAt || position.syncedAt > latestSyncedAt) {
          latestPrice = position.currentPrice || 0;
          latestMarketData = position.marketData;
          latestSyncedAt = position.syncedAt;
        }
        
        // CRITICAL FIX: Properly aggregate dividend data including totalReceived
        if (position.dividendData) {
          // Sum up the actual dividends received
          totalDividendsReceived += position.dividendData.totalReceived || 0;
          totalMonthlyDividend += position.dividendData.monthlyDividend || 0;
          totalAnnualDividend += position.dividendData.annualDividend || 0;
          
          // Track last dividend info (use most recent)
          if (position.dividendData.lastDividendDate) {
            if (!lastDividendDate || new Date(position.dividendData.lastDividendDate) > new Date(lastDividendDate)) {
              lastDividendDate = position.dividendData.lastDividendDate;
              lastDividendAmount = position.dividendData.lastDividendAmount || 0;
            }
          }
        }

        // Collect dividendPerShare values from positions
        if (position.dividendPerShare && position.dividendPerShare > 0) {
          dividendPerShareValues.push(position.dividendPerShare);
        }
      });

      // Log aggregation for debugging
      if (totalDividendsReceived > 0) {
        logger.info(`Aggregating ${symbol}: ${positions.length} positions, totalReceived: $${totalDividendsReceived.toFixed(2)}`);
      }

      // Calculate aggregated metrics
      const weightedAverageCost = totalShares > 0 ? totalCost / totalShares : 0;
      const totalReturnValue = totalOpenPnl + totalDividendsReceived; // Include actual dividends received
      const totalReturnPercent = totalCost > 0 ? (totalReturnValue / totalCost) * 100 : 0;
      const capitalGainPercent = totalCost > 0 ? (totalOpenPnl / totalCost) * 100 : 0;
      const capitalGainValue = totalOpenPnl;
      
      // Dividend metrics using actual totalDividendsReceived
      const dividendReturnPercent = totalCost > 0 ? (totalDividendsReceived / totalCost) * 100 : 0;
      const yieldOnCost = totalCost > 0 && totalAnnualDividend > 0 
        ? (totalAnnualDividend / totalCost) * 100 
        : 0;

      // Calculate dividend-adjusted cost
      let dividendAdjustedCostPerShare = weightedAverageCost;
      let dividendAdjustedCost = totalCost;
      
      if (totalDividendsReceived > 0 && totalShares > 0) {
        dividendAdjustedCostPerShare = Math.max(0, weightedAverageCost - (totalDividendsReceived / totalShares));
        dividendAdjustedCost = dividendAdjustedCostPerShare * totalShares;
      }

      // Calculate aggregated dividendPerShare
      let aggregatedDividendPerShare = 0;
      
      if (dividendPerShareValues.length > 0) {
        // Use the most common value, or if tied, the highest value
        const valueCount = {};
        dividendPerShareValues.forEach(val => {
          valueCount[val] = (valueCount[val] || 0) + 1;
        });
        
        const sortedValues = Object.entries(valueCount)
          .sort((a, b) => {
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
        }
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
          openPnl: pos.openPnl,
          // Include dividend info for transparency
          dividendsReceived: pos.dividendData?.totalReceived || 0
        };
      });

      // Determine if this is a dividend stock
      const isDividendStock = totalAnnualDividend > 0 ||
                             aggregatedDividendPerShare > 0 ||
                             totalDividendsReceived > 0;

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
        closedPnl: totalClosedPnl,
        
        // Calculated fields
        totalReturnPercent,
        totalReturnValue,
        capitalGainPercent,
        capitalGainValue,
        
        // CRITICAL: Properly aggregated dividend data with actual totalReceived
        dividendData: {
          totalReceived: totalDividendsReceived, // This is now the sum of all actual dividends received
          lastDividendAmount: lastDividendAmount,
          lastDividendDate: lastDividendDate,
          dividendReturnPercent,
          yieldOnCost,
          dividendAdjustedCost,
          dividendAdjustedCostPerShare,
          monthlyDividend: totalMonthlyDividend,
          monthlyDividendPerShare: totalShares > 0 ? totalMonthlyDividend / totalShares : 0,
          annualDividend: totalAnnualDividend,
          annualDividendPerShare: totalShares > 0 ? totalAnnualDividend / totalShares : 0,
          dividendFrequency: this.estimateDividendFrequency(positions)
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
        
        // Additional fields
        dividendPerShare: aggregatedDividendPerShare,
        industrySector: symbolInfo?.industrySector || positions[0]?.industrySector,
        industryGroup: symbolInfo?.industryGroup || positions[0]?.industryGroup,
        currency: symbolInfo?.currency || positions[0]?.currency || 'CAD',
        securityType: symbolInfo?.securityType || positions[0]?.securityType || 'Stock',
        isDividendStock
      };

      return aggregatedPosition;
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
        return {
          viewMode,
          personName,
          accountId,
          totalInvestment: 0,
          currentValue: 0,
          totalReturnValue: 0,
          totalReturnPercent: 0,
          unrealizedPnl: 0,
          totalDividends: 0,
          monthlyDividendIncome: 0,
          annualProjectedDividend: 0,
          averageYieldPercent: 0,
          yieldOnCostPercent: 0,
          numberOfPositions: 0,
          numberOfAccounts: 0,
          numberOfDividendStocks: 0,
          sectorAllocation: [],
          currencyBreakdown: [],
          personBreakdown: [],
          accounts: []
        };
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
      let totalDividends = 0; // This will be actual dividends received
      let monthlyDividendIncome = 0;
      let annualProjectedDividend = 0;
      
      const sectorMap = {};
      const currencyMap = {};
      const personMap = {};

      positions.forEach(position => {
        totalInvestment += position.totalCost || 0;
        currentValue += position.currentMarketValue || 0;
        unrealizedPnl += position.openPnl || 0;
        
        // CRITICAL FIX: Use totalReceived for actual dividends received
        if (position.dividendData) {
          totalDividends += position.dividendData.totalReceived || 0; // Actual dividends received
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

      // Log summary for debugging
      if (totalDividends > 0) {
        logger.info(`Portfolio summary: ${positions.length} positions, totalDividends: $${totalDividends.toFixed(2)}`);
      }

      const totalReturnValue = unrealizedPnl + totalDividends; // Include actual dividends in total return
      const totalReturnPercent = totalInvestment > 0 ? (totalReturnValue / totalInvestment) * 100 : 0;
      const averageYieldPercent = currentValue > 0 ? (annualProjectedDividend / currentValue) * 100 : 0;
      const yieldOnCostPercent = totalInvestment > 0 ? (annualProjectedDividend / totalInvestment) * 100 : 0;

      // Format allocations
      const sectorAllocation = Object.entries(sectorMap).map(([sector, value]) => ({
        sector,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
      })).sort((a, b) => b.value - a.value);

      const currencyBreakdown = Object.entries(currencyMap).map(([currency, value]) => ({
        currency,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
      })).sort((a, b) => b.value - a.value);

      const personBreakdown = Object.entries(personMap).map(([person, value]) => ({
        personName: person,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0,
        numberOfPositions: positions.filter(p => p.personName === person).length
      })).sort((a, b) => b.value - a.value);

      // Enhanced accounts summary
      const accountsSummary = accounts.map(account => {
        const accountPositions = positions.filter(p => 
          p.isAggregated ? p.sourceAccounts?.includes(account.accountId) : p.accountId === account.accountId
        );
        
        const accountValue = accountPositions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const accountInvestment = accountPositions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const accountPnl = accountPositions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
        const accountDividends = accountPositions.reduce((sum, p) => sum + (p.dividendData?.totalReceived || 0), 0);
        
        return {
          accountId: account.accountId,
          accountName: account.displayName || `${account.type} - ${account.accountId}`,
          accountType: account.type,
          totalInvestment: accountInvestment,
          currentValue: accountValue,
          unrealizedPnl: accountPnl,
          dividendsReceived: accountDividends,
          numberOfPositions: accountPositions.length,
          returnPercent: accountInvestment > 0 ? ((accountPnl + accountDividends) / accountInvestment) * 100 : 0
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

      return {
        viewMode,
        personName,
        accountId,
        totalInvestment,
        currentValue,
        totalReturnValue,
        totalReturnPercent,
        unrealizedPnl,
        totalDividends, // Now properly shows actual dividends received
        monthlyDividendIncome,
        annualProjectedDividend,
        averageYieldPercent,
        yieldOnCostPercent,
        numberOfPositions: positions.length,
        numberOfAccounts: accountIds.size,
        numberOfDividendStocks: positions.filter(p => 
          p.dividendData && (p.dividendData.annualDividend > 0 || p.dividendData.totalReceived > 0)
        ).length,
        sectorAllocation,
        currencyBreakdown,
        personBreakdown: viewMode === 'all' ? personBreakdown : [],
        accounts: accountsSummary,
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

      return positions.map(position => {
        const symbolInfo = symbolMap[position.symbolId];
        
        // Keep all existing dividend data intact
        const actualDividendData = position.dividendData || {};
        
        // Determine dividendPerShare
        let dividendPerShare = position.dividendPerShare || 0;
        
        if (dividendPerShare === 0 && symbolInfo) {
          const freq = symbolInfo.dividendFrequency?.toLowerCase();
          if (freq === 'monthly' || freq === 'quarterly') {
            dividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
          }
        }
        
        // Check if this is a dividend stock based on actual data
        const isDividendStock = (actualDividendData.annualDividend > 0) ||
                               (actualDividendData.totalReceived > 0) ||
                               dividendPerShare > 0;
        
        return {
          ...position,
          dividendPerShare: isDividendStock ? dividendPerShare : 0,
          industrySector: position.industrySector || symbolInfo?.industrySector,
          industryGroup: position.industryGroup || symbolInfo?.industryGroup,
          industrySubGroup: symbolInfo?.industrySubGroup,
          currency: position.currency || symbolInfo?.currency || 'CAD',
          securityType: symbolInfo?.securityType || position.securityType,
          isDividendStock,
          // Preserve the actual dividend data
          dividendData: actualDividendData
        };
      });
    } catch (error) {
      logger.error('Error enriching positions:', error);
      return positions;
    }
  }

  // Helper method to estimate dividend frequency
  estimateDividendFrequency(positions) {
    const frequencies = positions
      .map(p => p.dividendData?.dividendFrequency)
      .filter(f => f && f > 0);
    
    if (frequencies.length === 0) return 0;
    
    // Return the most common frequency
    const frequencyCount = {};
    frequencies.forEach(f => {
      frequencyCount[f] = (frequencyCount[f] || 0) + 1;
    });
    
    const sortedFrequencies = Object.entries(frequencyCount)
      .sort((a, b) => b[1] - a[1]);
    
    return parseInt(sortedFrequencies[0][0]);
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