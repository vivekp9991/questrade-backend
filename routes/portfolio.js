// routes/portfolio.js
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const PortfolioCalculatorService = require('../services/portfolioCalculator');
const DatabaseManager = require('../services/databaseManager');
const QueueManager = require('../services/queueManager');
const AccountAggregator = require('../services/accountAggregator');

// Initialize services
const dbManager = new DatabaseManager();
const queueManager = new QueueManager();
const portfolioCalculator = new PortfolioCalculatorService(dbManager, queueManager);
const accountAggregator = new AccountAggregator(dbManager);

/**
 * GET /api/portfolio/summary
 * Get portfolio summary with various view modes
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { 
      viewMode = 'all', 
      accountId, 
      personName,
      aggregate = 'true',
      dividendStocksOnly = false,
      includeClosedPositions = false 
    } = req.query;

    logger.info('Getting portfolio summary', { viewMode, accountId, personName, aggregate, dividendStocksOnly });

    // Validate required parameters
    if (viewMode === 'person' && !personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required when viewMode is "person"'
      });
    }

    const summary = await portfolioCalculator.getPortfolioSummary({
      viewMode,
      accountId,
      personName,
      aggregate: aggregate === 'true',
      dividendStocksOnly: dividendStocksOnly === 'true',
      includeClosedPositions: includeClosedPositions === 'true'
    });

    res.json({
      success: true,
      data: summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting portfolio summary:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/positions
 * Get all positions with optional filters
 */
router.get('/positions', async (req, res, next) => {
  try {
    const { 
      viewMode = 'all',
      accountId, 
      personName,
      symbol,
      aggregate = 'true',
      includeClosedPositions = false,
      sortBy = 'marketValue',
      sortOrder = 'desc' 
    } = req.query;

    // Validate required parameters
    if (viewMode === 'person' && !personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required when viewMode is "person"'
      });
    }

    const positions = await portfolioCalculator.getPositions({
      viewMode,
      accountId,
      personName,
      symbol,
      aggregate: aggregate === 'true',
      includeClosedPositions: includeClosedPositions === 'true',
      sortBy,
      sortOrder
    });

    res.json({
      success: true,
      data: positions,
      count: positions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting positions:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/positions/:symbol
 * Get details for a specific position
 */
router.get('/positions/:symbol', async (req, res, next) => {
  try {
    const { symbol } = req.params;
    const { accountId, personName } = req.query;

    logger.info('Getting position details', { symbol, accountId, personName });

    // Build filter
    const filter = { symbol: symbol.toUpperCase() };
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;

    // Get position details from database
    const positions = await dbManager.getPositions(filter);

    if (!positions || positions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Position not found for symbol: ${symbol}`,
        timestamp: new Date().toISOString()
      });
    }

    // If specific account/person requested, return single position
    if (accountId && positions.length === 1) {
      const position = positions[0];
      const enrichedPosition = {
        symbol: position.symbol,
        symbolId: position.symbolId,
        accountId: position.accountId,
        accountName: position.accountName,
        accountType: position.accountType,
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
        lastUpdated: position.lastUpdated
      };

      return res.json({
        success: true,
        data: enrichedPosition,
        timestamp: new Date().toISOString()
      });
    }

    // Otherwise, return aggregated position across accounts
    const aggregatedPosition = {
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
      lastUpdated: positions[0].lastUpdated
    };

    positions.forEach(position => {
      aggregatedPosition.totalQuantity += position.openQuantity || 0;
      aggregatedPosition.totalCost += position.totalCost || 0;
      aggregatedPosition.totalMarketValue += position.currentMarketValue || 0;
      
      if (position.personName) {
        aggregatedPosition.persons.add(position.personName);
      }
      
      aggregatedPosition.accounts.push({
        accountId: position.accountId,
        accountName: position.accountName,
        accountType: position.accountType,
        personName: position.personName,
        quantity: position.openQuantity,
        cost: position.totalCost,
        marketValue: position.currentMarketValue,
        averageEntryPrice: position.averageEntryPrice,
        unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
        unrealizedPnLPercent: position.totalCost > 0 
          ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
          : 0
      });

      // Update price if more recent
      if (position.lastUpdated > aggregatedPosition.lastUpdated) {
        aggregatedPosition.currentPrice = position.currentPrice;
        aggregatedPosition.lastUpdated = position.lastUpdated;
      }
    });

    // Calculate aggregate metrics
    aggregatedPosition.averageEntryPrice = aggregatedPosition.totalQuantity > 0 
      ? aggregatedPosition.totalCost / aggregatedPosition.totalQuantity 
      : 0;
    aggregatedPosition.unrealizedPnL = aggregatedPosition.totalMarketValue - aggregatedPosition.totalCost;
    aggregatedPosition.unrealizedPnLPercent = aggregatedPosition.totalCost > 0 
      ? (aggregatedPosition.unrealizedPnL / aggregatedPosition.totalCost) * 100 
      : 0;
    aggregatedPosition.accountCount = aggregatedPosition.accounts.length;
    aggregatedPosition.personCount = aggregatedPosition.persons.size;
    aggregatedPosition.persons = Array.from(aggregatedPosition.persons);
    aggregatedPosition.totalAnnualDividend = aggregatedPosition.isDividendStock 
      ? aggregatedPosition.totalQuantity * aggregatedPosition.annualDividend 
      : 0;

    res.json({
      success: true,
      data: aggregatedPosition,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting position details:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/cash-balances
 * Get cash balances with various view modes
 */
router.get('/cash-balances', async (req, res, next) => {
  try {
    const { 
      viewMode = 'all',
      accountId,
      personName,
      currency
    } = req.query;

    logger.info('Getting cash balances', { viewMode, accountId, personName, currency });

    // Build filter
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;
    if (currency) filter.currency = currency;

    // Get cash balances from database
    const balances = await dbManager.getCashBalances(filter);

    // Aggregate based on view mode
    const aggregatedBalances = await accountAggregator.aggregateCashBalances(
      balances,
      viewMode,
      { accountId, personName, currency }
    );

    res.json({
      success: true,
      data: aggregatedBalances,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting cash balances:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/dividends/calendar
 * Get dividend calendar
 */
router.get('/dividends/calendar', async (req, res, next) => {
  try {
    const { 
      viewMode = 'all',
      accountId,
      personName,
      startDate,
      endDate,
      groupBy = 'month' 
    } = req.query;

    logger.info('Getting dividend calendar', { viewMode, accountId, personName, startDate, endDate });

    const dividends = await portfolioCalculator.getDividendCalendar({
      viewMode,
      accountId,
      personName,
      startDate,
      endDate,
      groupBy
    });

    res.json({
      success: true,
      data: dividends,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting dividend calendar:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/performance
 * Get portfolio performance metrics
 */
router.get('/performance', async (req, res, next) => {
  try {
    const { 
      accountId,
      personName,
      period = '1M',
      groupBy = 'day' 
    } = req.query;

    const performance = await portfolioCalculator.getPerformanceMetrics({
      accountId,
      personName,
      period,
      groupBy
    });

    res.json({
      success: true,
      data: performance,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting performance metrics:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/dividends
 * Get dividend information
 */
router.get('/dividends', async (req, res, next) => {
  try {
    const { 
      accountId,
      personName,
      startDate,
      endDate,
      groupBy = 'month' 
    } = req.query;

    const dividends = await portfolioCalculator.getDividendSummary({
      accountId,
      personName,
      startDate,
      endDate,
      groupBy
    });

    res.json({
      success: true,
      data: dividends,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting dividend summary:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/snapshots
 * Get portfolio snapshots
 */
router.get('/snapshots', async (req, res, next) => {
  try {
    const { 
      viewMode = 'all',
      accountId,
      personName,
      startDate,
      endDate,
      limit = 30 
    } = req.query;

    logger.info('Getting portfolio snapshots', { viewMode, accountId, personName, limit });

    // Build filter
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    filter.limit = parseInt(limit);

    // Get snapshots from database
    const snapshots = await dbManager.getPortfolioSnapshots(filter);

    // Process snapshots based on view mode
    let processedSnapshots = snapshots;
    
    if (viewMode === 'account' && accountId) {
      // Filter for specific account (already done in query)
      processedSnapshots = snapshots;
    } else if (viewMode === 'person' && personName) {
      // Filter for specific person (already done in query)
      processedSnapshots = snapshots;
    } else if (viewMode === 'all') {
      // Aggregate snapshots across all accounts by date
      const aggregatedByDate = new Map();
      
      snapshots.forEach(snapshot => {
        const dateKey = snapshot.snapshotDate;
        
        if (!aggregatedByDate.has(dateKey)) {
          aggregatedByDate.set(dateKey, {
            snapshotDate: dateKey,
            totalValue: 0,
            totalCost: 0,
            totalPnL: 0,
            totalPnLPercent: 0,
            dayPnL: 0,
            dayPnLPercent: 0,
            accounts: [],
            persons: new Set()
          });
        }
        
        const agg = aggregatedByDate.get(dateKey);
        agg.totalValue += snapshot.totalValue || 0;
        agg.totalCost += snapshot.totalCost || 0;
        agg.totalPnL += snapshot.totalPnL || 0;
        agg.dayPnL += snapshot.dayPnL || 0;
        agg.accounts.push({
          accountId: snapshot.accountId,
          accountName: snapshot.accountName,
          personName: snapshot.personName,
          value: snapshot.totalValue
        });
        if (snapshot.personName) {
          agg.persons.add(snapshot.personName);
        }
      });
      
      // Calculate percentages
      aggregatedByDate.forEach(agg => {
        agg.totalPnLPercent = agg.totalCost > 0 
          ? (agg.totalPnL / agg.totalCost) * 100 
          : 0;
        agg.dayPnLPercent = (agg.totalValue - agg.dayPnL) > 0
          ? (agg.dayPnL / (agg.totalValue - agg.dayPnL)) * 100
          : 0;
        agg.personCount = agg.persons.size;
        agg.persons = Array.from(agg.persons);
      });
      
      processedSnapshots = Array.from(aggregatedByDate.values())
        .sort((a, b) => new Date(b.snapshotDate) - new Date(a.snapshotDate))
        .slice(0, parseInt(limit));
    }

    res.json({
      success: true,
      data: processedSnapshots,
      count: processedSnapshots.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting portfolio snapshots:', error);
    next(error);
  }
});

/**
 * POST /api/portfolio/snapshot
 * Create a new portfolio snapshot
 */
router.post('/snapshot', async (req, res, next) => {
  try {
    const { accountId, personName } = req.body;

    const snapshot = await portfolioCalculator.createSnapshot({ accountId, personName });

    res.json({
      success: true,
      data: snapshot,
      message: 'Portfolio snapshot created successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error creating portfolio snapshot:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/allocation
 * Get portfolio allocation breakdown
 */
router.get('/allocation', async (req, res, next) => {
  try {
    const { 
      accountId,
      personName,
      groupBy = 'sector' // sector, type, currency, account
    } = req.query;

    const allocation = await portfolioCalculator.getAllocation({
      accountId,
      personName,
      groupBy
    });

    res.json({
      success: true,
      data: allocation,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting portfolio allocation:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/transactions
 * Get recent transactions
 */
router.get('/transactions', async (req, res, next) => {
  try {
    const { 
      accountId,
      personName,
      symbol,
      type,
      startDate,
      endDate,
      limit = 100 
    } = req.query;

    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;
    if (symbol) filter.symbol = symbol;
    if (type) filter.type = type;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    filter.limit = parseInt(limit);

    const transactions = await dbManager.getTransactions(filter);

    res.json({
      success: true,
      data: transactions,
      count: transactions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting transactions:', error);
    next(error);
  }
});

/**
 * POST /api/portfolio/sync
 * Trigger portfolio data sync
 */
router.post('/sync', async (req, res, next) => {
  try {
    const { personName, accountId, fullSync = false } = req.body;

    // Add sync job to queue
    await queueManager.addJob('portfolio.sync', {
      personName,
      accountId,
      fullSync
    });

    res.json({
      success: true,
      message: 'Portfolio sync initiated',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error initiating portfolio sync:', error);
    next(error);
  }
});

/**
 * POST /api/portfolio/refresh
 * Trigger portfolio data refresh (legacy endpoint)
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { accountId, force = false } = req.body;

    await queueManager.addJob('portfolio.refresh', {
      accountId,
      force
    });

    res.json({
      success: true,
      message: 'Portfolio refresh initiated',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error initiating portfolio refresh:', error);
    next(error);
  }
});

/**
 * GET /api/portfolio/watchlist
 * Get watchlist
 */
router.get('/watchlist', async (req, res, next) => {
  try {
    const { personName } = req.query;

    const watchlist = await dbManager.getWatchlist(personName);

    res.json({
      success: true,
      data: watchlist,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting watchlist:', error);
    next(error);
  }
});

/**
 * POST /api/portfolio/watchlist
 * Add symbol to watchlist
 */
router.post('/watchlist', async (req, res, next) => {
  try {
    const { personName, symbol, notes } = req.body;

    const result = await dbManager.addToWatchlist({
      personName,
      symbol,
      notes
    });

    res.json({
      success: true,
      data: result,
      message: 'Symbol added to watchlist',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error adding to watchlist:', error);
    next(error);
  }
});

/**
 * DELETE /api/portfolio/watchlist/:symbol
 * Remove symbol from watchlist
 */
router.delete('/watchlist/:symbol', async (req, res, next) => {
  try {
    const { symbol } = req.params;
    const { personName } = req.query;

    await dbManager.removeFromWatchlist({
      personName,
      symbol
    });

    res.json({
      success: true,
      message: 'Symbol removed from watchlist',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error removing from watchlist:', error);
    next(error);
  }
});

module.exports = router;