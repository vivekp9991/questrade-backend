// routes/portfolio.js - FIXED VERSION - Enhanced cash balance and dividend recalculation endpoints
const express = require('express');
const router = express.Router();
const portfolioCalculator = require('../services/portfolioCalculator');
const accountAggregator = require('../services/accountAggregator');
const dataSync = require('../services/dataSync');
const Position = require('../models/Position');
const Account = require('../models/Account');
const Symbol = require('../models/Symbol');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const DividendCalculator = require('../services/dataSync/dividendCalculator');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Get portfolio summary with aggregation support
router.get('/summary', asyncHandler(async (req, res) => {
  const { viewMode = 'account', personName, accountId, aggregate = 'false' } = req.query;

  try {
    let summary;

    if (aggregate === 'true' || viewMode !== 'account') {
      // Use aggregation service
      summary = await accountAggregator.getAggregatedSummary(viewMode, personName, accountId);
    } else {
      // Use legacy calculator for single account
      summary = await portfolioCalculator.getPortfolioSummary(accountId);
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    logger.error('Error getting portfolio summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get portfolio summary'
    });
  }
}));

// Get positions with aggregation support
router.get('/positions', asyncHandler(async (req, res) => {
  const { viewMode = 'account', personName, accountId, aggregate = 'false' } = req.query;

  try {
    let positions;
    let accountInfo = null;

    if (aggregate === 'true' || viewMode !== 'account') {
      // Use aggregation service
      positions = await accountAggregator.aggregatePositions(viewMode, personName, accountId);
    } else {
      // Legacy single account query
      const query = accountId ? { accountId } : {};

      positions = await Position.find(query)
        .sort({ currentMarketValue: -1 })
        .lean();

      // Enrich with symbol data and currency information
      const symbolIds = positions.map(p => p.symbolId);
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      positions = positions.map(p => {
        const sym = symbolMap[p.symbolId];
        const freq = sym?.dividendFrequency?.toLowerCase();
        const dividendPerShare = (freq === 'monthly' || freq === 'quarterly')
          ? (sym?.dividendPerShare ?? sym?.dividend)
          : 0;

        return {
          ...p,
          dividendPerShare,
          industrySector: sym?.industrySector,
          industryGroup: sym?.industryGroup,
          industrySubGroup: sym?.industrySubGroup,
          currency: sym?.currency || (p.symbol?.includes('.TO') ? 'CAD' : 'USD'), // Enhanced currency detection
          securityType: sym?.securityType,
          // Enhanced dividend data with currency
          dividendData: p.dividendData ? {
            ...p.dividendData,
            currency: sym?.currency || (p.symbol?.includes('.TO') ? 'CAD' : 'USD')
          } : undefined
        };
      });
    }

    if (viewMode === 'account' && accountId) {
      accountInfo = await Account.findOne({ accountId }).lean();
      
      // Add currency info to account
      if (accountInfo && accountInfo.balances && accountInfo.balances.combinedBalances) {
        accountInfo.currency = accountInfo.balances.combinedBalances.currency || 'CAD';
      }
    }

    // Calculate currency summary for positions
    const currencySummary = {};
    positions.forEach(position => {
      const currency = position.currency || 'CAD';
      if (!currencySummary[currency]) {
        currencySummary[currency] = {
          currency,
          totalValue: 0,
          totalCost: 0,
          positionCount: 0
        };
      }
      currencySummary[currency].totalValue += position.currentMarketValue || 0;
      currencySummary[currency].totalCost += position.totalCost || 0;
      currencySummary[currency].positionCount += 1;
    });

    res.json({
      success: true,
      data: positions,
      meta: {
        viewMode,
        personName,
        accountId,
        aggregated: aggregate === 'true' || viewMode !== 'account',
        count: positions.length,
        currencySummary: Object.values(currencySummary)
      },
      account: accountInfo
    });
  } catch (error) {
    logger.error('Error getting positions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get positions'
    });
  }
}));

// FIXED: Enhanced cash balances endpoint with proper balance extraction
router.get('/cash-balances', asyncHandler(async (req, res) => {
  const { personName, accountId, viewMode = 'all' } = req.query;

  try {
    let accountQuery = {};
    
    // Build query based on view mode and filters
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

    // Get accounts with balance data
    const accounts = await Account.find(accountQuery)
      .sort({ personName: 1, type: 1 })
      .lean();

    const cashBalanceAccounts = [];
    const currencyTotals = {};
    const personSet = new Set();

    for (const account of accounts) {
      let cashBalances = [];
      let combinedCashBalance = 0;
      let primaryCurrency = 'CAD';
      
      // FIXED: Extract cash balance from account balances properly
      if (account.balances) {
        // Process per-currency balances
        if (account.balances.perCurrencyBalances && Array.isArray(account.balances.perCurrencyBalances)) {
          cashBalances = account.balances.perCurrencyBalances.map(balance => ({
            currency: balance.currency,
            cash: Number((balance.cash || 0).toFixed(2)),
            marketValue: Number((balance.marketValue || 0).toFixed(2)),
            totalEquity: Number((balance.totalEquity || 0).toFixed(2)),
            isRealTime: balance.isRealTime || false
          }));
        }

        // Get combined balance or primary currency balance
        if (account.balances.combinedBalances) {
          const cb = account.balances.combinedBalances;
          combinedCashBalance = cb.cash || 0;
          primaryCurrency = cb.currency || 'CAD';
        } else if (cashBalances.length > 0) {
          // If no combined balance, use the first currency balance or find CAD
          const primaryBalance = cashBalances.find(b => b.currency === 'CAD') || cashBalances[0];
          combinedCashBalance = primaryBalance.cash;
          primaryCurrency = primaryBalance.currency;
        }
      }

      // Create account entry with enhanced balance information
      const accountEntry = {
        accountId: account.accountId,
        accountName: account.displayName || `${account.type} - ${account.accountId}`,
        accountType: account.type || 'Unknown',
        personName: account.personName,
        cashBalance: Number(combinedCashBalance.toFixed(2)),
        currency: primaryCurrency,
        cashBalances: cashBalances, // ADDED: Include all currency balances
        lastUpdated: account.balances?.lastUpdated || account.syncedAt,
        syncError: account.balances?.syncError || null
      };

      cashBalanceAccounts.push(accountEntry);

      // Track currency totals from all balances
      cashBalances.forEach(balance => {
        if (!currencyTotals[balance.currency]) {
          currencyTotals[balance.currency] = 0;
        }
        currencyTotals[balance.currency] += balance.cash;
      });

      // If no per-currency balances, add the combined balance to totals
      if (cashBalances.length === 0 && combinedCashBalance !== 0) {
        if (!currencyTotals[primaryCurrency]) {
          currencyTotals[primaryCurrency] = 0;
        }
        currencyTotals[primaryCurrency] += combinedCashBalance;
      }

      // Track unique persons
      personSet.add(account.personName);
    }

    // FIXED: Build summary with proper currency totals
    const summary = {
      totalAccounts: cashBalanceAccounts.length,
      totalPersons: personSet.size,
      ...Object.entries(currencyTotals).reduce((acc, [currency, total]) => {
        acc[`total${currency}`] = Number(total.toFixed(2));
        return acc;
      }, {})
    };

    // Get the most recent update time
    const lastUpdated = cashBalanceAccounts.reduce((latest, account) => {
      const accountTime = new Date(account.lastUpdated || 0);
      return accountTime > latest ? accountTime : latest;
    }, new Date(0));

    // FIXED: Add additional debug information
    logger.debug('Cash balances extracted:', {
      accountCount: cashBalanceAccounts.length,
      currencyTotals,
      viewMode,
      personName,
      accountId
    });

    res.json({
      success: true,
      data: {
        accounts: cashBalanceAccounts,
        summary,
        currencyBreakdown: Object.entries(currencyTotals).map(([currency, total]) => ({
          currency,
          total: Number(total.toFixed(2)),
          percentage: Object.values(currencyTotals).reduce((sum, val) => sum + val, 0) > 0 
            ? (total / Object.values(currencyTotals).reduce((sum, val) => sum + val, 0)) * 100 
            : 0
        })),
        lastUpdated: lastUpdated.toISOString(),
        viewMode,
        personName,
        accountId
      }
    });

  } catch (error) {
    logger.error('Error getting cash balances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cash balances',
      details: error.message
    });
  }
}));

// ADDED: Force refresh cash balances endpoint
router.post('/cash-balances/refresh', asyncHandler(async (req, res) => {
  const { personName, accountId } = req.body;

  try {
    if (!personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required for balance refresh'
      });
    }

    logger.info(`Starting balance refresh for ${personName}${accountId ? ` account ${accountId}` : ''}`);

    // Use the AccountSync service to refresh balances
    const AccountSync = require('../services/dataSync/accountSync');
    const accountSync = new AccountSync();
    
    let result;
    if (accountId) {
      // Refresh specific account
      result = await accountSync.refreshAccountBalances(personName, accountId);
    } else {
      // Refresh all accounts for person
      result = await accountSync.refreshAllAccountBalances(personName);
    }

    res.json({
      success: true,
      message: `Balance refresh completed for ${personName}`,
      data: result
    });

  } catch (error) {
    logger.error('Error refreshing cash balances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh cash balances',
      details: error.message
    });
  }
}));

// NEW: Recalculate dividends endpoint
router.post('/dividends/recalculate', asyncHandler(async (req, res) => {
  const { personName, symbol, dryRun = false } = req.body;

  try {
    logger.info(`Starting dividend recalculation${personName ? ` for ${personName}` : ''}${symbol ? ` for symbol ${symbol}` : ''}`);

    const dividendCalculator = new DividendCalculator();
    let query = {};
    
    if (personName) {
      query.personName = personName;
    }
    
    if (symbol) {
      query.symbol = symbol;
    }

    // Get positions to recalculate
    const positions = await Position.find(query);
    
    if (positions.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No positions found matching criteria'
      });
    }

    logger.info(`Found ${positions.length} positions to recalculate`);

    let updated = 0;
    let errors = [];
    const updates = [];

    // Get symbols data for batch lookup
    const symbolIds = [...new Set(positions.map(p => p.symbolId))];
    const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
    const symbolMap = {};
    symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

    for (const position of positions) {
      try {
        const symbolInfo = symbolMap[position.symbolId];
        
        // Recalculate dividend data
        const newDividendData = await dividendCalculator.calculateDividendData(
          position.accountId,
          position.personName,
          position.symbolId,
          position.symbol,
          position.openQuantity,
          position.averageEntryPrice,
          symbolInfo
        );

        // Check if update is needed
        const oldTotal = position.dividendData?.totalReceived || 0;
        const newTotal = newDividendData.totalReceived || 0;
        
        if (Math.abs(newTotal - oldTotal) > 0.01) {
          updates.push({
            symbol: position.symbol,
            accountId: position.accountId,
            oldTotalReceived: oldTotal,
            newTotalReceived: newTotal,
            difference: newTotal - oldTotal
          });

          if (!dryRun) {
            // Update position with new dividend data
            await Position.findByIdAndUpdate(position._id, {
              dividendData: newDividendData,
              updatedAt: new Date()
            });
            updated++;
          }
        }

        logger.debug(`Recalculated ${position.symbol}: old=$${oldTotal.toFixed(2)}, new=$${newTotal.toFixed(2)}`);

      } catch (error) {
        logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        errors.push({
          symbol: position.symbol,
          error: error.message
        });
      }
    }

    const response = {
      success: true,
      message: dryRun ? 'Dry run completed' : 'Dividend recalculation completed',
      data: {
        positionsProcessed: positions.length,
        positionsUpdated: dryRun ? updates.length : updated,
        errors: errors.length,
        dryRun,
        updates: updates.slice(0, 20), // Limit response size
        errorDetails: errors
      }
    };

    if (updates.length > 0) {
      response.data.totalDifferenceAmount = updates.reduce((sum, u) => sum + u.difference, 0);
    }

    logger.info(`Dividend recalculation completed: ${updated} positions updated, ${errors.length} errors`);

    res.json(response);

  } catch (error) {
    logger.error('Error recalculating dividends:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to recalculate dividends',
      details: error.message
    });
  }
}));

// Get dividend calendar with person filtering and currency information
router.get('/dividends/calendar', asyncHandler(async (req, res) => {
  const { personName, viewMode, accountId, startDate, endDate } = req.query;

  try {
    let query = { type: 'Dividend' };

    // Apply filters based on view mode
    switch (viewMode) {
      case 'all':
        // No additional filters
        break;
      case 'person':
        if (personName) query.personName = personName;
        break;
      case 'account':
        if (accountId) query.accountId = accountId;
        break;
      default:
        // Backward compatibility
        if (accountId) query.accountId = accountId;
        if (personName) query.personName = personName;
    }

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    const dividends = await Activity.find(query)
      .sort({ transactionDate: -1 })
      .limit(100)
      .lean();

    // Get symbol information for currency data
    const symbolsInDividends = [...new Set(dividends.map(d => d.symbol).filter(Boolean))];
    const symbols = await Symbol.find({ symbol: { $in: symbolsInDividends } }).lean();
    const symbolMap = {};
    symbols.forEach(sym => { symbolMap[sym.symbol] = sym; });

    // Enhance dividends with currency information
    const enhancedDividends = dividends.map(dividend => {
      const symbol = symbolMap[dividend.symbol];
      const currency = symbol?.currency || 
                      dividend.currency ||
                      (dividend.symbol?.includes('.TO') ? 'CAD' : 'USD');

      return {
        ...dividend,
        currency,
        amount: dividend.netAmount,
        dividendPerShare: dividend.dividendPerShare || 
                         (dividend.quantity > 0 ? Math.abs(dividend.netAmount) / dividend.quantity : 0)
      };
    });

    // Calculate currency summary
    const currencySummary = {};
    enhancedDividends.forEach(dividend => {
      const currency = dividend.currency;
      if (!currencySummary[currency]) {
        currencySummary[currency] = {
          currency,
          totalAmount: 0,
          count: 0
        };
      }
      currencySummary[currency].totalAmount += Math.abs(dividend.netAmount || 0);
      currencySummary[currency].count += 1;
    });

    // Group by month for additional summary
    const monthlyBreakdown = {};
    enhancedDividends.forEach(dividend => {
      const monthKey = dividend.transactionDate.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyBreakdown[monthKey]) {
        monthlyBreakdown[monthKey] = {
          month: monthKey,
          currencies: {}
        };
      }
      
      const currency = dividend.currency;
      if (!monthlyBreakdown[monthKey].currencies[currency]) {
        monthlyBreakdown[monthKey].currencies[currency] = {
          currency,
          amount: 0,
          count: 0
        };
      }
      
      monthlyBreakdown[monthKey].currencies[currency].amount += Math.abs(dividend.netAmount || 0);
      monthlyBreakdown[monthKey].currencies[currency].count += 1;
    });

    res.json({
      success: true,
      data: enhancedDividends,
      meta: {
        viewMode,
        personName,
        accountId,
        count: enhancedDividends.length,
        currencySummary: Object.values(currencySummary),
        monthlyBreakdown: Object.values(monthlyBreakdown).sort((a, b) => b.month.localeCompare(a.month))
      }
    });
  } catch (error) {
    logger.error('Error getting dividend calendar:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dividend calendar'
    });
  }
}));

// Get portfolio snapshots with person filtering
router.get('/snapshots', asyncHandler(async (req, res) => {
  const { personName, viewMode, accountId, startDate, endDate, limit = 30 } = req.query;

  try {
    let query = {};

    // Apply filters based on view mode
    switch (viewMode) {
      case 'all':
        query.viewMode = 'all';
        break;
      case 'person':
        if (personName) {
          query.personName = personName;
          query.viewMode = 'person';
        }
        break;
      case 'account':
        if (accountId) {
          query.accountId = accountId;
          query.viewMode = 'account';
        }
        break;
      default:
        // Backward compatibility
        if (accountId) query.accountId = accountId;
        if (personName) query.personName = personName;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const snapshots = await PortfolioSnapshot.find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: snapshots
    });
  } catch (error) {
    logger.error('Error getting snapshots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get snapshots'
    });
  }
}));

// Sync portfolio data with person support
router.post('/sync', asyncHandler(async (req, res) => {
  const { personName, viewMode, accountId, fullSync = false } = req.body;

  try {
    let result;

    if (personName) {
      // Sync for specific person
      if (fullSync) {
        result = await dataSync.fullSyncForPerson(personName);
      } else {
        result = await dataSync.quickSyncForPerson(personName);
      }
    } else if (accountId) {
      // Sync for specific account
      if (fullSync) {
        result = await dataSync.fullSync(accountId);
      } else {
        const accounts = await dataSync.syncAccounts();
        const targetAccount = accounts.find(acc => acc.number === accountId);
        if (targetAccount) {
          await dataSync.syncPositions(accountId);
          result = { success: true, accountsSynced: 1 };
        } else {
          throw new Error('Account not found');
        }
      }
    } else {
      // Sync all data
      if (fullSync) {
        result = await dataSync.fullSync();
      } else {
        const accounts = await dataSync.syncAccounts();
        for (const account of accounts) {
          await dataSync.syncPositions(account.number);
        }
        result = { success: true, accountsSynced: accounts.length };
      }
    }

    res.json({
      success: true,
      message: 'Sync completed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error syncing portfolio:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync portfolio',
      message: error.message
    });
  }
}));

// Sync data for specific person
router.post('/sync/person/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  const { fullSync = false } = req.body;

  try {
    let result;
    if (fullSync) {
      result = await dataSync.fullSyncForPerson(personName);
    } else {
      result = await dataSync.quickSyncForPerson(personName);
    }

    res.json({
      success: true,
      message: `Sync completed for ${personName}`,
      data: result
    });
  } catch (error) {
    logger.error(`Error syncing data for ${personName}:`, error);
    res.status(500).json({
      success: false,
      error: `Failed to sync data for ${personName}`,
      message: error.message
    });
  }
}));

// Sync data for all persons
router.post('/sync/all-persons', asyncHandler(async (req, res) => {
  const { fullSync = false } = req.body;

  try {
    const result = await dataSync.syncAllPersons(fullSync);

    res.json({
      success: true,
      message: 'Sync completed for all persons',
      data: result
    });
  } catch (error) {
    logger.error('Error syncing all persons:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync all persons',
      message: error.message
    });
  }
}));

// Get sync status
router.get('/sync/status', asyncHandler(async (req, res) => {
  const { personName } = req.query;

  try {
    let result;

    if (personName) {
      // Get status for specific person
      const Person = require('../models/Person');
      const person = await Person.findOne({ personName });
      if (!person) {
        return res.status(404).json({
          success: false,
          error: 'Person not found'
        });
      }

      const accounts = await Account.find({ personName });
      const positionCount = await Position.countDocuments({ personName });
      const activityCount = await Activity.countDocuments({ personName });

      result = {
        personName,
        lastSuccessfulSync: person.lastSuccessfulSync,
        lastSyncError: person.lastSyncError,
        hasValidToken: person.hasValidToken,
        accounts: accounts.length,
        positions: positionCount,
        activities: activityCount
      };
    } else {
      // Get status for all persons
      const Person = require('../models/Person');
      const persons = await Person.find({ isActive: true });
      const results = await Promise.all(
        persons.map(async (person) => {
          const accounts = await Account.countDocuments({ personName: person.personName });
          const positions = await Position.countDocuments({ personName: person.personName });
          const activities = await Activity.countDocuments({ personName: person.personName });

          return {
            personName: person.personName,
            lastSuccessfulSync: person.lastSuccessfulSync,
            lastSyncError: person.lastSyncError,
            hasValidToken: person.hasValidToken,
            accounts,
            positions,
            activities
          };
        })
      );

      result = results;
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get sync status'
    });
  }
}));

module.exports = router;