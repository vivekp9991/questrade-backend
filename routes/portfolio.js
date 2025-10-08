// routes/portfolio.js
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Position = require('../models/Position');
const Account = require('../models/Account');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const Symbol = require('../models/Symbol');
const Person = require('../models/Person');
const PortfolioCalculatorService = require('../services/portfolioCalculator');
const AccountAggregator = require('../services/accountAggregator');
const dataSync = require('../services/dataSync');
const { asyncHandler } = require('../middleware/errorHandler');

// Initialize services
const portfolioCalculator = new PortfolioCalculatorService();
const accountAggregator = new AccountAggregator();

/**
 * GET /api/portfolio/summary
 * Get portfolio summary with various view modes
 */
router.get('/summary', asyncHandler(async (req, res) => {
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

    // Validate required parameters based on viewMode
    if (viewMode === 'person' && !personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required when viewMode is "person"'
      });
    }

    if (viewMode === 'account' && !accountId) {
      return res.status(400).json({
        success: false,
        error: 'accountId is required when viewMode is "account"'
      });
    }

    const summary = await portfolioCalculator.getPortfolioSummary({
      viewMode,
      accountId,
      personName,
      aggregate: aggregate === 'true',
      dividendStocksOnly: dividendStocksOnly === 'true' || dividendStocksOnly === true,
      includeClosedPositions: includeClosedPositions === 'true' || includeClosedPositions === true
    });

    res.json({
      success: true,
      data: summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting portfolio summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get portfolio summary',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/positions
 * Get all positions with optional filters
 */
router.get('/positions', asyncHandler(async (req, res) => {
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

    // Validate required parameters based on viewMode
    if (viewMode === 'person' && !personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required when viewMode is "person"'
      });
    }

    if (viewMode === 'account' && !accountId) {
      return res.status(400).json({
        success: false,
        error: 'accountId is required when viewMode is "account"'
      });
    }

    const positions = await portfolioCalculator.getPositions({
      viewMode,
      accountId,
      personName,
      symbol,
      aggregate: aggregate === 'true',
      includeClosedPositions: includeClosedPositions === 'true' || includeClosedPositions === true,
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
    res.status(500).json({
      success: false,
      error: 'Failed to get positions',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/positions/:symbol
 * Get details for a specific position
 */
router.get('/positions/:symbol', asyncHandler(async (req, res) => {
  try {
    const { symbol } = req.params;
    const { accountId, personName } = req.query;

    logger.info('Getting position details', { symbol, accountId, personName });

    // Build filter
    const filter = { symbol: symbol.toUpperCase() };
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;

    // Get position details from database
    const positions = await Position.find(filter).lean();

    if (!positions || positions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Position not found for symbol: ${symbol}`,
        timestamp: new Date().toISOString()
      });
    }

    // If specific account requested, return single position
    if (accountId && positions.length === 1) {
      const position = positions[0];
      const enrichedPosition = portfolioCalculator.enrichPosition(position);
      
      return res.json({
        success: true,
        data: enrichedPosition,
        timestamp: new Date().toISOString()
      });
    }

    // Otherwise, aggregate positions across accounts
    const aggregatedPosition = portfolioCalculator.aggregatePositionsBySymbol(positions, symbol);

    res.json({
      success: true,
      data: aggregatedPosition,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting position details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get position details',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/cash-balances
 * Get cash balances with various view modes
 */
router.get('/cash-balances', asyncHandler(async (req, res) => {
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

    // Get accounts with balances
    const accounts = await Account.find(filter).lean();

    // Extract and aggregate cash balances
    const cashBalances = portfolioCalculator.extractCashBalances(accounts);
    const aggregatedBalances = accountAggregator.aggregateCashBalances(
      cashBalances,
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
    res.status(500).json({
      success: false,
      error: 'Failed to get cash balances',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/dividends/calendar
 * Get dividend calendar
 */
router.get('/dividends/calendar', asyncHandler(async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Failed to get dividend calendar',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/performance
 * Get portfolio performance metrics
 */
router.get('/performance', asyncHandler(async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Failed to get performance metrics',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/dividends
 * Get dividend information
 */
router.get('/dividends', asyncHandler(async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Failed to get dividend summary',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/snapshots
 * Get portfolio snapshots
 */
router.get('/snapshots', asyncHandler(async (req, res) => {
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
    const filter = { viewMode };
    if (accountId) filter.accountId = accountId;
    if (personName) filter.personName = personName;
    if (startDate) filter.date = { $gte: new Date(startDate) };
    if (endDate) {
      filter.date = filter.date || {};
      filter.date.$lte = new Date(endDate);
    }

    // Get snapshots from database
    const snapshots = await PortfolioSnapshot.find(filter)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: snapshots,
      count: snapshots.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting portfolio snapshots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get portfolio snapshots',
      message: error.message
    });
  }
}));

/**
 * POST /api/portfolio/snapshot
 * Create a new portfolio snapshot
 */
router.post('/snapshot', asyncHandler(async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Failed to create portfolio snapshot',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/allocation
 * Get portfolio allocation breakdown
 */
router.get('/allocation', asyncHandler(async (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Failed to get portfolio allocation',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/transactions
 * Get recent transactions
 */
router.get('/transactions', asyncHandler(async (req, res) => {
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
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const transactions = await Activity.find(filter)
      .sort({ transactionDate: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: transactions,
      count: transactions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get transactions',
      message: error.message
    });
  }
}));

/**
 * POST /api/portfolio/sync
 * Trigger portfolio data sync
 */
router.post('/sync', asyncHandler(async (req, res) => {
  try {
    const { personName, accountId, fullSync = false } = req.body;

    if (!personName) {
      return res.status(400).json({
        success: false,
        error: 'personName is required for sync'
      });
    }

    // Use dataSync service directly
    logger.info(`Initiating sync for ${personName}`, { fullSync });
    
    // Run sync asynchronously
    dataSync.syncPersonData(personName, { fullSync })
      .then(result => {
        logger.info(`Sync completed for ${personName}`, result);
      })
      .catch(error => {
        logger.error(`Sync failed for ${personName}:`, error);
      });

    res.json({
      success: true,
      message: 'Portfolio sync initiated',
      personName,
      fullSync,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error initiating portfolio sync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate portfolio sync',
      message: error.message
    });
  }
}));

/**
 * POST /api/portfolio/refresh
 * Trigger portfolio data refresh (legacy endpoint)
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  try {
    const { accountId, force = false } = req.body;

    if (!accountId) {
      return res.status(400).json({
        success: false,
        error: 'accountId is required for refresh'
      });
    }

    // Get account to find personName
    const account = await Account.findOne({ accountId });
    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Account not found'
      });
    }

    // Use dataSync service
    dataSync.syncPersonData(account.personName, { fullSync: force })
      .then(result => {
        logger.info(`Refresh completed for account ${accountId}`, result);
      })
      .catch(error => {
        logger.error(`Refresh failed for account ${accountId}:`, error);
      });

    res.json({
      success: true,
      message: 'Portfolio refresh initiated',
      accountId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error initiating portfolio refresh:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate portfolio refresh',
      message: error.message
    });
  }
}));

/**
 * GET /api/portfolio/watchlist
 * Get watchlist
 */
router.get('/watchlist', asyncHandler(async (req, res) => {
  try {
    const { personName } = req.query;

    const filter = {};
    if (personName) filter.personName = personName;

    // For now, return empty watchlist as this feature isn't implemented
    const watchlist = [];

    res.json({
      success: true,
      data: watchlist,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting watchlist:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get watchlist',
      message: error.message
    });
  }
}));

/**
 * POST /api/portfolio/watchlist
 * Add symbol to watchlist
 */
router.post('/watchlist', asyncHandler(async (req, res) => {
  try {
    const { personName, symbol, notes } = req.body;

    // For now, return success without actually implementing watchlist
    res.json({
      success: true,
      message: 'Watchlist feature not yet implemented',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error adding to watchlist:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add to watchlist',
      message: error.message
    });
  }
}));

/**
 * DELETE /api/portfolio/watchlist/:symbol
 * Remove symbol from watchlist
 */
router.delete('/watchlist/:symbol', asyncHandler(async (req, res) => {
  try {
    const { symbol } = req.params;
    const { personName } = req.query;

    // For now, return success without actually implementing watchlist
    res.json({
      success: true,
      message: 'Watchlist feature not yet implemented',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error removing from watchlist:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove from watchlist',
      message: error.message
    });
  }
}));

module.exports = router;