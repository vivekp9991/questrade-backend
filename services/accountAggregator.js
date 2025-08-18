// services/accountAggregator.js - FIXED VERSION - Properly aggregates dividend data
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Account = require('../models/Account');
const Symbol = require('../models/Symbol');
const Person = require('../models/Person');
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

  // FIXED: Aggregate multiple positions of the same symbol with proper dividend calculation
  async aggregateSymbolPositions(symbol, positions, accountMap = {}) {
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
      let totalClosedPnl = 0;
      
      const sourceAccounts = [];
      const personNames = new Set();
      let latestPrice = 0;
      let latestMarketData = null;
      let latestSyncedAt = null;

      // Track dividend per share values from positions
      const dividendPerShareValues = [];
      let maxYieldOnCost = 0;
      let totalDividendReturnValue = 0;
      let lastDividendDate = null;
      let lastDividendAmount = 0;
      let dividendFrequency = 0;
      let currentYield = 0;

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
          currentYield = position.currentYield || 0;
        }
        
        // FIXED: Properly aggregate dividend data
        if (position.dividendData) {
          const divData = position.dividendData;
          totalDividendsReceived += divData.totalReceived || 0;
          totalMonthlyDividend += divData.monthlyDividend || 0;
          totalAnnualDividend += divData.annualDividend || 0;
          
          // Track dividend return value
          totalDividendReturnValue += divData.totalReceived || 0;
          
          // Keep the latest dividend info
          if (divData.lastDividendDate && (!lastDividendDate || divData.lastDividendDate > lastDividendDate)) {
            lastDividendDate = divData.lastDividendDate;
            lastDividendAmount = divData.lastDividendAmount || 0;
          }
          
          // Keep the highest yield on cost
          if (divData.yieldOnCost > maxYieldOnCost) {
            maxYieldOnCost = divData.yieldOnCost;
          }
          
          // Track dividend frequency (use most common or highest)
          if (divData.dividendFrequency > dividendFrequency) {
            dividendFrequency = divData.dividendFrequency;
          }
        }

        // Collect dividend per share values
        if (position.dividendPerShare && position.dividendPerShare > 0) {
          dividendPerShareValues.push(position.dividendPerShare);
        }
      });

      // Calculate aggregated metrics
      const weightedAverageCost = totalShares > 0 ? totalCost / totalShares : 0;
      const totalReturnValue = totalOpenPnl + totalDividendsReceived;
      const totalReturnPercent = totalCost > 0 ? (totalReturnValue / totalCost) * 100 : 0;
      const capitalGainPercent = totalCost > 0 ? (totalOpenPnl / totalCost) * 100 : 0;
      
      // FIXED: Calculate proper dividend metrics
      const dividendReturnPercent = totalCost > 0 ? (totalDividendsReceived / totalCost) * 100 : 0;
      
      // Calculate yield on cost for aggregated position
      let yieldOnCost = 0;
      let annualDividendPerShare = 0;
      let monthlyDividendPerShare = 0;
      
      if (totalShares > 0) {
        annualDividendPerShare = totalAnnualDividend / totalShares;
        monthlyDividendPerShare = totalMonthlyDividend / totalShares;
        
        if (weightedAverageCost > 0) {
          yieldOnCost = (annualDividendPerShare / weightedAverageCost) * 100;
        }
      }

      // Calculate dividend per share - use most common value or calculate from annual dividend
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
      } else if (annualDividendPerShare > 0 && dividendFrequency > 0) {
        // Calculate from annual dividend and frequency
        aggregatedDividendPerShare = annualDividendPerShare / dividendFrequency;
      } else if (symbolInfo) {
        // Fallback to symbol data
        aggregatedDividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
      }

      // Calculate dividend-adjusted metrics
      let dividendAdjustedCostPerShare = weightedAverageCost;
      let dividendAdjustedCost = totalCost;
      let dividendAdjustedYield = yieldOnCost;
      
      if (totalDividendsReceived > 0 && totalShares > 0) {
        dividendAdjustedCostPerShare = Math.max(0, weightedAverageCost - (totalDividendsReceived / totalShares));
        dividendAdjustedCost = dividendAdjustedCostPerShare * totalShares;
        
        if (dividendAdjustedCostPerShare > 0 && annualDividendPerShare > 0) {
          dividendAdjustedYield = (annualDividendPerShare / dividendAdjustedCostPerShare) * 100;
        }
      }

      // Calculate current yield if not available
      if (currentYield === 0 && latestPrice > 0 && annualDividendPerShare > 0) {
        currentYield = (annualDividendPerShare / latestPrice) * 100;
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
          dividendsReceived: pos.dividendData?.totalReceived || 0,
          annualDividend: pos.dividendData?.annualDividend || 0
        };
      });

      // Determine if this is a dividend stock
      const isDividendStock = totalAnnualDividend > 0 ||
                             aggregatedDividendPerShare > 0 ||
                             totalDividendsReceived > 0;

      // Create aggregated position with complete dividend data
      const aggregatedPosition = {
        symbol,
        symbolId: positions[0].symbolId,
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
        capitalGainValue: totalOpenPnl,
        
        // FIXED: Complete dividend data
        dividendData: {
          totalReceived: totalDividendsReceived,
          lastDividendAmount: lastDividendAmount,
          lastDividendDate: lastDividendDate,
          dividendReturnPercent,
          yieldOnCost,
          dividendAdjustedCost,
          dividendAdjustedCostPerShare,
          dividendAdjustedYield,
          monthlyDividend: totalMonthlyDividend,
          monthlyDividendPerShare,
          annualDividend: totalAnnualDividend,
          annualDividendPerShare,
          dividendFrequency,
          dividendPerShare: aggregatedDividendPerShare,
          currentYield
        },
        
        // Market data
        marketData: latestMarketData,
        
        // Aggregation metadata
        isAggregated: true,
        sourceAccounts,
        numberOfAccounts: sourceAccounts.length,
        individualPositions,
        
        // Timestamps
        syncedAt: latestSyncedAt,
        updatedAt: new Date(),
        
        // Position-level fields
        dividendPerShare: aggregatedDividendPerShare,
        currentYield,
        industrySector: symbolInfo?.industrySector || positions[0]?.industrySector,
        industryGroup: symbolInfo?.industryGroup || positions[0]?.industryGroup,
        currency: symbolInfo?.currency || positions[0]?.currency,
        securityType: symbolInfo?.securityType || positions[0]?.securityType,
        isDividendStock
      };

      // Log aggregation details for debugging
      if (totalDividendsReceived > 0 || totalAnnualDividend > 0) {
        logger.debug(`Aggregated ${symbol}:`, {
          positions: positions.length,
          totalReceived: totalDividendsReceived.toFixed(2),
          annualDividend: totalAnnualDividend.toFixed(2),
          dividendPerShare: aggregatedDividendPerShare.toFixed(3),
          yieldOnCost: yieldOnCost.toFixed(2),
          currentYield: currentYield.toFixed(2)
        });
      }

      return aggregatedPosition;
    } catch (error) {
      logger.error(`Error aggregating positions for symbol ${symbol}:`, error);
      throw error;
    }
  }

  // ENHANCED: Get portfolio summary with proper dividend calculations
  async getAggregatedSummary(viewMode, personName = null, accountId = null, options = {}) {
    try {
      const { dividendStocksOnly = null } = options;
      
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      
      if (positions.length === 0) {
        return this.getEmptySummary(viewMode, personName, accountId);
      }

      // Get user preferences for yield calculation if not explicitly specified
      let useDividendStocksOnly = dividendStocksOnly;
      if (useDividendStocksOnly === null && personName) {
        const person = await Person.findOne({ personName });
        useDividendStocksOnly = person?.preferences?.portfolio?.yieldOnCostDividendOnly ?? true;
      } else if (useDividendStocksOnly === null) {
        useDividendStocksOnly = true;
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
          break;
      }

      const accounts = await Account.find(accountQuery).lean();

      // Calculate summary metrics
      let totalInvestment = 0;
      let currentValue = 0;
      let unrealizedPnl = 0;
      let totalDividends = 0;
      let monthlyDividendIncome = 0;
      let annualProjectedDividend = 0;
      let totalClosedPnl = 0;
      
      // For yield calculation
      let yieldCalculationInvestment = 0;
      let yieldCalculationDividends = 0;
      
      // For current yield calculation
      let currentYieldWeightedSum = 0;
      let currentYieldTotalValue = 0;
      
      const sectorMap = {};
      const currencyMap = {};
      const personMap = {};
      const dividendStocks = [];

      positions.forEach(position => {
        const positionValue = position.currentMarketValue || 0;
        const positionCost = position.totalCost || 0;
        const positionPnl = position.openPnl || 0;
        
        totalInvestment += positionCost;
        currentValue += positionValue;
        unrealizedPnl += positionPnl;
        totalClosedPnl += position.closedPnl || 0;
        
        // FIXED: Properly aggregate dividend data
        if (position.dividendData) {
          const divData = position.dividendData;
          totalDividends += divData.totalReceived || 0;
          monthlyDividendIncome += divData.monthlyDividend || 0;
          annualProjectedDividend += divData.annualDividend || 0;
          
          // Track dividend stocks
          if (divData.annualDividend > 0 || divData.totalReceived > 0) {
            dividendStocks.push({
              symbol: position.symbol,
              annualDividend: divData.annualDividend,
              totalReceived: divData.totalReceived,
              yieldOnCost: divData.yieldOnCost,
              currentYield: divData.currentYield || position.currentYield || 0,
              marketValue: positionValue
            });
          }
          
          // Calculate weighted current yield
          const posCurrentYield = divData.currentYield || position.currentYield || 0;
          if (posCurrentYield > 0 && positionValue > 0) {
            currentYieldWeightedSum += posCurrentYield * positionValue;
            currentYieldTotalValue += positionValue;
          }
        }
        
        // Calculate yield basis based on preference
        if (useDividendStocksOnly) {
          if (position.isDividendStock && position.dividendData && position.dividendData.annualDividend > 0) {
            yieldCalculationInvestment += positionCost;
            yieldCalculationDividends += position.dividendData.annualDividend || 0;
          }
        } else {
          yieldCalculationInvestment += positionCost;
          yieldCalculationDividends += position.dividendData?.annualDividend || 0;
        }
        
        // Sector allocation
        const sector = position.industrySector || position.securityType || 'Other';
        sectorMap[sector] = (sectorMap[sector] || 0) + positionValue;
        
        // Currency allocation
        const currency = position.currency || 'CAD';
        currencyMap[currency] = (currencyMap[currency] || 0) + positionValue;
        
        // Person allocation (for "all" view)
        if (viewMode === 'all' && position.personName !== 'Multiple') {
          personMap[position.personName] = (personMap[position.personName] || 0) + positionValue;
        }
      });

      const totalReturnValue = unrealizedPnl + totalDividends;
      const totalReturnPercent = totalInvestment > 0 ? (totalReturnValue / totalInvestment) * 100 : 0;
      
      // Calculate portfolio-wide current yield (weighted average)
      const averageYieldPercent = currentYieldTotalValue > 0 ? 
        currentYieldWeightedSum / currentYieldTotalValue : 0;
      
      // Calculate yield on cost based on preference
      const yieldOnCostPercent = yieldCalculationInvestment > 0 ? 
        (yieldCalculationDividends / yieldCalculationInvestment) * 100 : 0;

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
      }));

      // Enhanced accounts summary
      const accountsSummary = accounts.map(account => {
        const accountPositions = positions.filter(p => 
          p.isAggregated ? p.sourceAccounts?.includes(account.accountId) : p.accountId === account.accountId
        );
        
        const accountValue = accountPositions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const accountInvestment = accountPositions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const accountPnl = accountPositions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
        const accountDividends = accountPositions.reduce((sum, p) => 
          sum + (p.dividendData?.totalReceived || 0), 0);
        
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
          totalDividends: accountDividends,
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

      // Top dividend payers
      const topDividendPayers = dividendStocks
        .sort((a, b) => b.annualDividend - a.annualDividend)
        .slice(0, 10)
        .map(stock => ({
          symbol: stock.symbol,
          annualDividend: stock.annualDividend,
          totalReceived: stock.totalReceived,
          yieldOnCost: stock.yieldOnCost,
          currentYield: stock.currentYield,
          marketValue: stock.marketValue
        }));

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
        realizedPnl: totalClosedPnl,
        totalDividends,
        monthlyDividendIncome,
        annualProjectedDividend,
        averageYieldPercent,
        yieldOnCostPercent,
        numberOfPositions: positions.length,
        numberOfAccounts: accountIds.size,
        numberOfDividendStocks: dividendStocks.length,
        sectorAllocation,
        currencyBreakdown,
        personBreakdown: viewMode === 'all' ? personBreakdown : [],
        accounts: accountsSummary,
        topDividendPayers,
        aggregationInfo: {
          hasAggregatedPositions: positions.some(p => p.isAggregated),
          totalAggregatedSymbols: positions.filter(p => p.isAggregated).length
        },
        yieldCalculationInfo: {
          useDividendStocksOnly,
          yieldCalculationInvestment,
          yieldCalculationDividends,
          dividendStockCount: dividendStocks.length,
          totalPositionCount: positions.length
        }
      };
    } catch (error) {
      logger.error('Error getting aggregated summary:', error);
      throw error;
    }
  }

  // Get empty summary structure
  getEmptySummary(viewMode, personName, accountId) {
    return {
      viewMode,
      personName,
      accountId,
      currency: 'CAD',
      totalInvestment: 0,
      currentValue: 0,
      totalReturnValue: 0,
      totalReturnPercent: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
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
      accounts: [],
      topDividendPayers: [],
      aggregationInfo: {
        hasAggregatedPositions: false,
        totalAggregatedSymbols: 0
      },
      yieldCalculationInfo: {
        useDividendStocksOnly: true,
        yieldCalculationInvestment: 0,
        yieldCalculationDividends: 0,
        dividendStockCount: 0,
        totalPositionCount: 0
      }
    };
  }

  // FIXED: Enrich positions with additional symbol information and dividend data
  async enrichPositions(positions) {
    try {
      const symbolIds = [...new Set(positions.map(p => p.symbolId))];
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      return positions.map(position => {
        const symbolInfo = symbolMap[position.symbolId];
        const actualDividendData = position.dividendData || {};
        
        // Get dividend per share from position or symbol
        let dividendPerShare = position.dividendPerShare || 0;
        
        if (dividendPerShare === 0 && symbolInfo) {
          dividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
        }
        
        // Get current yield from position data or calculate
        let currentYield = position.currentYield || actualDividendData.currentYield || 0;
        
        if (currentYield === 0 && symbolInfo && symbolInfo.yield) {
          currentYield = symbolInfo.yield;
        } else if (currentYield === 0 && position.currentPrice > 0 && actualDividendData.annualDividendPerShare > 0) {
          currentYield = (actualDividendData.annualDividendPerShare / position.currentPrice) * 100;
        }
        
        // Check if it's a dividend stock
        const isDividendStock = (actualDividendData.annualDividend > 0) ||
                               (actualDividendData.totalReceived > 0) ||
                               (dividendPerShare > 0) ||
                               position.isDividendStock;
        
        return {
          ...position,
          dividendPerShare,
          currentYield,
          industrySector: position.industrySector || symbolInfo?.industrySector,
          industryGroup: position.industryGroup || symbolInfo?.industryGroup,
          industrySubGroup: symbolInfo?.industrySubGroup,
          currency: position.currency || symbolInfo?.currency || 'CAD',
          securityType: position.securityType || symbolInfo?.securityType,
          isDividendStock,
          // Ensure dividend data has all required fields
          dividendData: {
            ...actualDividendData,
            currentYield: currentYield
          }
        };
      });
    } catch (error) {
      logger.error('Error enriching positions:', error);
      return positions;
    }
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
      if (position.dividendData?.lastDividendDate && position.dividendData?.lastDividendAmount) {
        if (!latestDate || position.dividendData.lastDividendDate > latestDate) {
          latestDate = position.dividendData.lastDividendDate;
          latestAmount = position.dividendData.lastDividendAmount;
        }
      }
    });
    return latestAmount;
  }

  // Helper method to calculate weighted average dividend frequency
  getWeightedDividendFrequency(positions) {
    let totalShares = 0;
    let weightedFrequency = 0;
    
    positions.forEach(position => {
      const shares = position.openQuantity || 0;
      const frequency = position.dividendData?.dividendFrequency || 0;
      
      if (shares > 0 && frequency > 0) {
        totalShares += shares;
        weightedFrequency += frequency * shares;
      }
    });
    
    return totalShares > 0 ? Math.round(weightedFrequency / totalShares) : 0;
  }

  // Helper method to calculate dividend-adjusted cost basis
  calculateDividendAdjustedCost(totalCost, totalShares, totalDividendsReceived) {
    if (totalShares <= 0) return { adjustedCost: totalCost, adjustedCostPerShare: 0 };
    
    const originalCostPerShare = totalCost / totalShares;
    const dividendsPerShare = totalDividendsReceived / totalShares;
    const adjustedCostPerShare = Math.max(0, originalCostPerShare - dividendsPerShare);
    const adjustedCost = adjustedCostPerShare * totalShares;
    
    return {
      adjustedCost,
      adjustedCostPerShare
    };
  }

  // Enhanced method to get dividend stock statistics
  async getDividendStockStatistics(viewMode, personName = null, accountId = null) {
    try {
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      
      const dividendStocks = positions.filter(position => 
        position.isDividendStock || 
        (position.dividendData && 
         (position.dividendData.annualDividend > 0 || position.dividendData.totalReceived > 0))
      );
      
      if (dividendStocks.length === 0) {
        return {
          totalDividendStocks: 0,
          totalAnnualDividend: 0,
          totalDividendsReceived: 0,
          averageYieldOnCost: 0,
          averageCurrentYield: 0,
          topPerformers: [],
          highestYielders: [],
          monthlyIncome: 0,
          estimatedMonthlyIncome: []
        };
      }

      let totalAnnualDividend = 0;
      let totalDividendsReceived = 0;
      let totalInvestment = 0;
      let yieldWeightedSum = 0;
      let currentYieldWeightedSum = 0;
      let totalMarketValue = 0;

      const stockStats = dividendStocks.map(stock => {
        const annualDiv = stock.dividendData?.annualDividend || 0;
        const totalReceived = stock.dividendData?.totalReceived || 0;
        const yieldOnCost = stock.dividendData?.yieldOnCost || 0;
        const currentYield = stock.dividendData?.currentYield || stock.currentYield || 0;
        const marketValue = stock.currentMarketValue || 0;
        const cost = stock.totalCost || 0;

        totalAnnualDividend += annualDiv;
        totalDividendsReceived += totalReceived;
        totalInvestment += cost;
        totalMarketValue += marketValue;

        if (marketValue > 0) {
          yieldWeightedSum += yieldOnCost * marketValue;
          currentYieldWeightedSum += currentYield * marketValue;
        }

        return {
          symbol: stock.symbol,
          annualDividend: annualDiv,
          totalReceived: totalReceived,
          yieldOnCost: yieldOnCost,
          currentYield: currentYield,
          marketValue: marketValue,
          dividendReturnPercent: cost > 0 ? (totalReceived / cost) * 100 : 0,
          monthlyDividend: stock.dividendData?.monthlyDividend || 0,
          dividendPerShare: stock.dividendPerShare || 0,
          shares: stock.openQuantity || 0
        };
      });

      // Calculate averages
      const averageYieldOnCost = totalMarketValue > 0 ? yieldWeightedSum / totalMarketValue : 0;
      const averageCurrentYield = totalMarketValue > 0 ? currentYieldWeightedSum / totalMarketValue : 0;

      // Top performers by total dividend received
      const topPerformers = stockStats
        .sort((a, b) => b.totalReceived - a.totalReceived)
        .slice(0, 10);

      // Highest yielders by yield on cost
      const highestYielders = stockStats
        .filter(stock => stock.yieldOnCost > 0)
        .sort((a, b) => b.yieldOnCost - a.yieldOnCost)
        .slice(0, 10);

      // Estimate monthly income distribution
      const monthlyIncome = totalAnnualDividend / 12;
      const estimatedMonthlyIncome = Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        let monthlyAmount = 0;
        
        // Rough estimation based on dividend frequency and timing
        stockStats.forEach(stock => {
          const frequency = stock.dividendData?.dividendFrequency || 4;
          if (frequency === 12) {
            monthlyAmount += stock.annualDividend / 12;
          } else if (frequency === 4) {
            // Quarterly - assume March, June, September, December
            if ([3, 6, 9, 12].includes(month)) {
              monthlyAmount += stock.annualDividend / 4;
            }
          } else if (frequency === 2) {
            // Semi-annual - assume June and December
            if ([6, 12].includes(month)) {
              monthlyAmount += stock.annualDividend / 2;
            }
          } else if (frequency === 1) {
            // Annual - assume December
            if (month === 12) {
              monthlyAmount += stock.annualDividend;
            }
          }
        });

        return {
          month,
          monthName: new Date(2024, month - 1, 1).toLocaleString('default', { month: 'long' }),
          estimatedIncome: monthlyAmount
        };
      });

      return {
        totalDividendStocks: dividendStocks.length,
        totalAnnualDividend,
        totalDividendsReceived,
        averageYieldOnCost,
        averageCurrentYield,
        topPerformers,
        highestYielders,
        monthlyIncome,
        estimatedMonthlyIncome,
        dividendGrowthRate: 0, // Would need historical data to calculate
        totalInvestmentInDividendStocks: totalInvestment,
        dividendCoverage: totalInvestment > 0 ? (totalDividendsReceived / totalInvestment) * 100 : 0
      };
    } catch (error) {
      logger.error('Error getting dividend stock statistics:', error);
      throw error;
    }
  }

  // Method to get positions with activity data
  async getPositionsWithActivities(viewMode, personName = null, accountId = null) {
    try {
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      
      // Get all symbol IDs to fetch activities
      const symbolIds = positions.map(p => p.symbolId).filter(Boolean);
      
      if (symbolIds.length === 0) {
        return positions.map(p => ({ ...p, activities: [] }));
      }

      // Build activity query based on view mode
      let activityQuery = { symbolId: { $in: symbolIds } };
      
      switch (viewMode) {
        case 'person':
          if (personName) activityQuery.personName = personName;
          break;
        case 'account':
          if (accountId) activityQuery.accountId = accountId;
          break;
        case 'all':
        default:
          break;
      }

      const activities = await Activity.find(activityQuery)
        .sort({ activityDate: -1 })
        .lean();

      // Group activities by symbol
      const activitiesBySymbol = {};
      activities.forEach(activity => {
        const symbolId = activity.symbolId;
        if (!activitiesBySymbol[symbolId]) {
          activitiesBySymbol[symbolId] = [];
        }
        activitiesBySymbol[symbolId].push(activity);
      });

      // Add activities to positions
      return positions.map(position => ({
        ...position,
        activities: activitiesBySymbol[position.symbolId] || [],
        recentActivities: (activitiesBySymbol[position.symbolId] || []).slice(0, 5),
        activityCount: (activitiesBySymbol[position.symbolId] || []).length
      }));
    } catch (error) {
      logger.error('Error getting positions with activities:', error);
      throw error;
    }
  }

  // Method to validate aggregated data integrity
  async validateAggregation(positions) {
    const issues = [];
    
    positions.forEach(position => {
      // Check for negative values that shouldn't be negative
      if (position.openQuantity < 0) {
        issues.push(`${position.symbol}: Negative quantity (${position.openQuantity})`);
      }
      
      if (position.currentPrice < 0) {
        issues.push(`${position.symbol}: Negative price (${position.currentPrice})`);
      }
      
      // Check for unrealistic yield values
      if (position.dividendData?.yieldOnCost > 100) {
        issues.push(`${position.symbol}: Unrealistic yield on cost (${position.dividendData.yieldOnCost}%)`);
      }
      
      // Check for missing dividend data on dividend stocks
      if (position.isDividendStock && (!position.dividendData || position.dividendData.annualDividend === 0)) {
        issues.push(`${position.symbol}: Marked as dividend stock but missing dividend data`);
      }
      
      // Check market value calculation
      const calculatedValue = (position.openQuantity || 0) * (position.currentPrice || 0);
      const reportedValue = position.currentMarketValue || 0;
      const valueDifference = Math.abs(calculatedValue - reportedValue);
      
      if (valueDifference > 0.01 && calculatedValue > 0) {
        const percentDiff = (valueDifference / calculatedValue) * 100;
        if (percentDiff > 1) { // More than 1% difference
          issues.push(`${position.symbol}: Market value mismatch - calculated: ${calculatedValue.toFixed(2)}, reported: ${reportedValue.toFixed(2)}`);
        }
      }
    });
    
    if (issues.length > 0) {
      logger.warn('Data integrity issues found:', issues);
    }
    
    return {
      isValid: issues.length === 0,
      issues,
      positionsChecked: positions.length
    };
  }

  // Method to get performance metrics over time periods
  async getPerformanceMetrics(viewMode, personName = null, accountId = null, timePeriods = ['1D', '1W', '1M', '3M', '6M', '1Y']) {
    try {
      // This would require historical data - placeholder for now
      const currentSummary = await this.getAggregatedSummary(viewMode, personName, accountId);
      
      const metrics = {
        current: currentSummary,
        historical: {}
      };
      
      // Placeholder for historical performance calculation
      timePeriods.forEach(period => {
        metrics.historical[period] = {
          returnPercent: 0,
          dividendReturn: 0,
          capitalGainReturn: 0,
          // This would be calculated from historical position data
        };
      });
      
      return metrics;
    } catch (error) {
      logger.error('Error getting performance metrics:', error);
      throw error;
    }
  }

  // Helper method to format currency values
  formatCurrency(amount, currency = 'CAD', decimals = 2) {
    try {
      return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }).format(amount || 0);
    } catch (error) {
      return `${currency} ${(amount || 0).toFixed(decimals)}`;
    }
  }

  // Helper method to format percentage values
  formatPercentage(percent, decimals = 2) {
    return `${(percent || 0).toFixed(decimals)}%`;
  }

  // Method to export aggregated data for reporting
  async exportAggregatedData(viewMode, personName = null, accountId = null, format = 'json') {
    try {
      const summary = await this.getAggregatedSummary(viewMode, personName, accountId);
      const positions = await this.aggregatePositions(viewMode, personName, accountId);
      const dividendStats = await this.getDividendStockStatistics(viewMode, personName, accountId);
      
      const exportData = {
        metadata: {
          exportDate: new Date(),
          viewMode,
          personName,
          accountId,
          format
        },
        summary,
        positions,
        dividendStats,
        validation: await this.validateAggregation(positions)
      };
      
      if (format === 'csv') {
        // Convert to CSV format (simplified)
        return this.convertToCSV(positions);
      }
      
      return exportData;
    } catch (error) {
      logger.error('Error exporting aggregated data:', error);
      throw error;
    }
  }

  // Helper method to convert positions to CSV format
  convertToCSV(positions) {
    const headers = [
      'Symbol', 'Shares', 'Avg Cost', 'Current Price', 'Market Value', 
      'Total Cost', 'Unrealized P&L', 'Total Return %', 'Dividends Received',
      'Annual Dividend', 'Yield on Cost %', 'Current Yield %', 'Sector'
    ];
    
    const rows = positions.map(pos => [
      pos.symbol,
      pos.openQuantity || 0,
      pos.averageEntryPrice || 0,
      pos.currentPrice || 0,
      pos.currentMarketValue || 0,
      pos.totalCost || 0,
      pos.openPnl || 0,
      pos.totalReturnPercent || 0,
      pos.dividendData?.totalReceived || 0,
      pos.dividendData?.annualDividend || 0,
      pos.dividendData?.yieldOnCost || 0,
      pos.dividendData?.currentYield || pos.currentYield || 0,
      pos.industrySector || ''
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    return csvContent;
  }
}

module.exports = new AccountAggregator();