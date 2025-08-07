// routes/portfolio.js
const express = require('express');
const router = express.Router();
const portfolioCalculator = require('../services/portfolioCalculator');
const dataSync = require('../services/dataSync');
const Position = require('../models/Position');
const Account = require('../models/Account');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const logger = require('../utils/logger');

// Get portfolio summary
router.get('/summary', async (req, res) => {
  try {
    const { accountId } = req.query;
    console.log(`req :- ${req} , res :- ${res} , accountId :- ${accountId} `);
    const summary = await portfolioCalculator.getPortfolioSummary(accountId);
    
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
});

// Get positions
router.get('/positions', async (req, res) => {
  try {
    const { accountId } = req.query;
    const query = accountId ? { accountId } : {};
    
    const positions = await Position.find(query)
      .sort({ currentMarketValue: -1 });
    
    res.json({
      success: true,
      data: positions
    });
  } catch (error) {
    logger.error('Error getting positions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get positions'
    });
  }
});

// Get single position details
router.get('/positions/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { accountId } = req.query;
    
    const query = { symbol };
    if (accountId) query.accountId = accountId;
    
    const position = await Position.findOne(query);
    
    if (!position) {
      return res.status(404).json({
        success: false,
        error: 'Position not found'
      });
    }
    
    res.json({
      success: true,
      data: position
    });
  } catch (error) {
    logger.error('Error getting position:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get position'
    });
  }
});

// Get dividend calendar
router.get('/dividends/calendar', async (req, res) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    const query = { type: 'Dividend' };
    
    if (accountId) query.accountId = accountId;
    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }
    
    const dividends = await Activity.find(query)
      .sort({ transactionDate: -1 })
      .limit(100);
    
    res.json({
      success: true,
      data: dividends
    });
  } catch (error) {
    logger.error('Error getting dividend calendar:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dividend calendar'
    });
  }
});

// Get portfolio snapshots (historical data)
router.get('/snapshots', async (req, res) => {
  try {
    const { accountId, startDate, endDate, limit = 30 } = req.query;
    const query = {};
    
    if (accountId) query.accountId = accountId;
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
});

// Sync portfolio data
router.post('/sync', async (req, res) => {
  try {
    const { accountId, fullSync = false } = req.body;
    
    let result;
    if (fullSync) {
      result = await dataSync.fullSync(accountId);
    } else {
      // Quick sync - just positions and recent activities
      const accounts = await dataSync.syncAccounts();
      for (const account of accounts) {
        if (!accountId || accountId === account.number) {
          await dataSync.syncPositions(account.number);
        }
      }
      result = { success: true, accountsSynced: accounts.length };
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
      error: 'Failed to sync portfolio'
    });
  }
});

module.exports = router;