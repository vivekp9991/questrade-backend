// routes/portfolio.js
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
    
    if (aggregate === 'true' || viewMode !== 'account') {
      // Use aggregation service
      positions = await accountAggregator.aggregatePositions(viewMode, personName, accountId);
    } else {
      // Legacy single account query
      const query = accountId ? { accountId } : {};
      
      positions = await Position.find(query)
        .sort({ currentMarketValue: -1 })
        .lean();

      // Enrich with symbol data
      const symbolIds = positions.map(p => p.symbolId);
      const symbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      const symbolMap = {};
      symbols.forEach(sym => { symbolMap[sym.symbolId] = sym; });

      positions = positions.map(p => ({
        ...p,
        dividendPerShare: symbolMap[p.symbolId]?.dividendPerShare ?? symbolMap[p.symbolId]?.dividend,
        industrySector: symbolMap[p.symbolId]?.industrySector,
        industryGroup: symbolMap[p.symbolId]?.industryGroup,
        industrySubGroup: symbolMap[p.symbolId]?.industrySubGroup
      }));
    }

    res.json({
      success: true,
      data: positions,
      meta: {
        viewMode,
        personName,
        accountId,
        aggregated: aggregate === 'true' || viewMode !== 'account',
        count: positions.length
      }
    });
  } catch (error) {
    logger.error('Error getting positions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get positions'
    });
  }
}));

// Get single position details
router.get('/positions/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { viewMode = 'account', personName, accountId } = req.query;
  
  try {
    let query = { symbol };
    
    // Build query based on view mode
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
    }
    
    const positions = await Position.find(query).lean();
    
    if (positions.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Position not found'
      });
    }
    
    // If multiple positions for same symbol, aggregate them
    let result;
    if (positions.length === 1) {
      result = positions[0];
    } else {
      // Use aggregation service for multiple positions
      const aggregated = await accountAggregator.aggregateSymbolPositions(symbol, positions);
      result = aggregated;
    }
    
    // Enrich with symbol information
    const symbolInfo = await Symbol.findOne({ symbolId: result.symbolId }).lean();
    const enrichedPosition = {
      ...result,
      dividendPerShare: symbolInfo?.dividendPerShare ?? symbolInfo?.dividend,
      industrySector: symbolInfo?.industrySector,
      industryGroup: symbolInfo?.industryGroup,
      industrySubGroup: symbolInfo?.industrySubGroup
    };
    
    res.json({
      success: true,
      data: enrichedPosition
    });
  } catch (error) {
    logger.error('Error getting position:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get position'
    });
  }
}));

// Get dividend calendar with person filtering
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