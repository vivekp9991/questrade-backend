// routes/settings.js
const express = require('express');
const router = express.Router();
const Person = require('../models/Person');
const Token = require('../models/Token');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const tokenManager = require('../services/tokenManager');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Get comprehensive settings dashboard data
router.get('/dashboard', asyncHandler(async (req, res) => {
  // Get all persons with their token status
  const persons = await Person.find({ isActive: true });
  const personData = await Promise.all(
    persons.map(async (person) => {
      const tokenStatus = await tokenManager.getTokenStatus(person.personName);
      const accountCount = await Account.countDocuments({ 
        personName: person.personName 
      });
      
      return {
        ...person.toObject(),
        tokenStatus,
        accountCount
      };
    })
  );

  // Get system statistics
  const systemStats = {
    totalPersons: await Person.countDocuments({ isActive: true }),
    totalAccounts: await Account.countDocuments(),
    totalPositions: await Position.countDocuments(),
    totalActivities: await Activity.countDocuments(),
    activeTokens: await Token.countDocuments({ 
      isActive: true, 
      type: 'refresh' 
    })
  };

  // Get recent errors
  const recentErrors = await Token.find({
    lastError: { $exists: true, $ne: null },
    lastUsed: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
  })
  .sort({ lastUsed: -1 })
  .limit(10)
  .select('personName type lastError lastUsed errorCount');

  res.json({
    success: true,
    data: {
      persons: personData,
      systemStats,
      recentErrors
    }
  });
}));

// Validate refresh token without saving
router.post('/validate-token', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Refresh token is required'
    });
  }

  try {
    const validation = await tokenManager.validateRefreshToken(refreshToken);
    
    res.json({
      success: true,
      data: validation
    });
  } catch (error) {
    logger.error('Error validating token:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}));

// Get error logs for troubleshooting
router.get('/error-logs', asyncHandler(async (req, res) => {
  const { personName, days = 7 } = req.query;
  const daysInt = parseInt(days);
  
  let query = {
    lastError: { $exists: true, $ne: null },
    lastUsed: { $gte: new Date(Date.now() - daysInt * 24 * 60 * 60 * 1000) }
  };
  
  if (personName) {
    query.personName = personName;
  }

  const errorLogs = await Token.find(query)
    .sort({ lastUsed: -1 })
    .limit(50)
    .select('personName type lastError lastUsed errorCount createdAt');

  // Get person-specific sync errors
  const personErrors = await Person.find({
    lastSyncError: { $exists: true, $ne: null }
  }).select('personName lastSyncError updatedAt');

  res.json({
    success: true,
    data: {
      tokenErrors: errorLogs,
      syncErrors: personErrors
    }
  });
}));

// Clear error states for a person
router.post('/clear-errors/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  // Clear token errors
  await Token.updateMany(
    { personName },
    { 
      $unset: { lastError: 1 },
      errorCount: 0
    }
  );

  // Clear person sync errors
  await Person.findOneAndUpdate(
    { personName },
    { 
      $unset: { lastSyncError: 1 }
    }
  );

  logger.info(`Cleared errors for person: ${personName}`);
  
  res.json({
    success: true,
    message: `Errors cleared for ${personName}`
  });
}));

// Get all token statuses
router.get('/token-status/all', asyncHandler(async (req, res) => {
  try {
    const allTokenStatus = await tokenManager.getAllTokenStatus();
    
    res.json({
      success: true,
      data: allTokenStatus
    });
  } catch (error) {
    logger.error('Error getting all token status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

// Test connections for all persons
router.post('/test-connections/all', asyncHandler(async (req, res) => {
  const persons = await Person.find({ isActive: true });
  
  const results = await Promise.allSettled(
    persons.map(async (person) => {
      try {
        const result = await tokenManager.testConnection(person.personName);
        return {
          personName: person.personName,
          status: 'success',
          data: result
        };
      } catch (error) {
        return {
          personName: person.personName,
          status: 'error',
          error: error.message
        };
      }
    })
  );

  const connectionResults = results.map(result => result.value);
  
  res.json({
    success: true,
    data: connectionResults
  });
}));

// Refresh tokens for all persons
router.post('/refresh-tokens/all', asyncHandler(async (req, res) => {
  const persons = await Person.find({ isActive: true });
  
  const results = await Promise.allSettled(
    persons.map(async (person) => {
      try {
        const result = await tokenManager.refreshAccessToken(person.personName);
        return {
          personName: person.personName,
          status: 'success',
          data: result
        };
      } catch (error) {
        return {
          personName: person.personName,
          status: 'error',
          error: error.message
        };
      }
    })
  );

  const refreshResults = results.map(result => result.value);
  
  res.json({
    success: true,
    data: refreshResults
  });
}));

// Get system health status
router.get('/health', asyncHandler(async (req, res) => {
  const health = {
    database: 'healthy',
    tokens: [],
    lastCheck: new Date()
  };

  try {
    // Check database connectivity
    const dbTest = await Person.countDocuments();
    health.database = 'healthy';
  } catch (error) {
    health.database = 'error';
    health.databaseError = error.message;
  }

  // Check token health for each person
  const persons = await Person.find({ isActive: true });
  for (const person of persons) {
    try {
      const tokenStatus = await tokenManager.getTokenStatus(person.personName);
      health.tokens.push({
        personName: person.personName,
        status: tokenStatus.refreshToken.exists ? 'healthy' : 'missing',
        ...tokenStatus
      });
    } catch (error) {
      health.tokens.push({
        personName: person.personName,
        status: 'error',
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    data: health
  });
}));

// Export system configuration
router.get('/export', asyncHandler(async (req, res) => {
  const { includeTokens = false } = req.query;
  
  const persons = await Person.find({ isActive: true }).lean();
  const accounts = await Account.find({}).lean();
  
  const exportData = {
    version: '1.0',
    exportDate: new Date(),
    persons: persons.map(p => ({
      personName: p.personName,
      displayName: p.displayName,
      preferences: p.preferences,
      createdAt: p.createdAt
    })),
    accounts: accounts.map(a => ({
      accountId: a.accountId,
      personName: a.personName,
      type: a.type,
      displayName: a.displayName
    }))
  };

  // Include token info if requested (without actual tokens)
  if (includeTokens === 'true') {
    const tokens = await Token.find({ isActive: true })
      .select('personName type expiresAt lastUsed errorCount')
      .lean();
    
    exportData.tokenInfo = tokens;
  }

  res.json({
    success: true,
    data: exportData
  });
}));

module.exports = router;