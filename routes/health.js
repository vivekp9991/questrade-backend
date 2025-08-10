// routes/health.js
const express = require('express');
const router = express.Router();
const tokenManager = require('../services/tokenManager');
const questradeApi = require('../services/questradeApi');
const dataSync = require('../services/dataSync');
const Person = require('../models/Person');
const Token = require('../models/Token');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const logger = require('../services/logger');

/**
 * GET /api/health/tokens
 * Health check for all tokens
 */
router.get('/tokens', async (req, res) => {
  try {
    const persons = await Person.find({ isActive: true });
    const tokenHealth = [];

    for (const person of persons) {
      const token = await Token.findOne({ personName: person.name });
      
      if (!token) {
        tokenHealth.push({
          personName: person.name,
          status: 'missing',
          hasRefreshToken: false,
          hasAccessToken: false,
          accessTokenExpiry: null,
          lastRefreshed: null,
          isHealthy: false,
          error: 'No token found'
        });
        continue;
      }

      const now = new Date();
      const isAccessTokenValid = token.accessTokenExpiry && new Date(token.accessTokenExpiry) > now;
      const hasValidRefreshToken = !!token.refreshToken;
      
      const health = {
        personName: person.name,
        status: isAccessTokenValid ? 'healthy' : (hasValidRefreshToken ? 'needs_refresh' : 'invalid'),
        hasRefreshToken: hasValidRefreshToken,
        hasAccessToken: !!token.accessToken,
        accessTokenExpiry: token.accessTokenExpiry,
        lastRefreshed: token.lastRefreshed,
        isHealthy: isAccessTokenValid || hasValidRefreshToken,
        error: null
      };

      // Try to refresh token if needed and possible
      if (!isAccessTokenValid && hasValidRefreshToken) {
        try {
          await tokenManager.refreshAccessToken(person.name);
          health.status = 'refreshed';
          health.isHealthy = true;
        } catch (refreshError) {
          health.status = 'refresh_failed';
          health.error = refreshError.message;
          health.isHealthy = false;
        }
      }

      tokenHealth.push(health);
    }

    const overallHealth = {
      healthy: tokenHealth.filter(t => t.isHealthy).length,
      total: tokenHealth.length,
      unhealthy: tokenHealth.filter(t => !t.isHealthy).length,
      needsRefresh: tokenHealth.filter(t => t.status === 'needs_refresh').length
    };

    res.json({
      success: true,
      overall: overallHealth,
      tokens: tokenHealth,
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('Token health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check token health',
      details: error.message
    });
  }
});

/**
 * GET /api/health/connections
 * Test Questrade API connections for all persons
 */
router.get('/connections', async (req, res) => {
  try {
    const persons = await Person.find({ isActive: true });
    const connectionTests = [];

    for (const person of persons) {
      const testResult = {
        personName: person.name,
        status: 'unknown',
        responseTime: null,
        serverTime: null,
        error: null,
        isConnected: false
      };

      try {
        const startTime = Date.now();
        
        // Test connection with server time endpoint (lightweight)
        const serverTime = await questradeApi.getServerTime(person.name);
        const endTime = Date.now();
        
        testResult.status = 'connected';
        testResult.responseTime = endTime - startTime;
        testResult.serverTime = serverTime;
        testResult.isConnected = true;

      } catch (connectionError) {
        testResult.status = 'failed';
        testResult.error = connectionError.message;
        testResult.isConnected = false;

        // Categorize error types
        if (connectionError.message.includes('401') || connectionError.message.includes('Unauthorized')) {
          testResult.status = 'unauthorized';
        } else if (connectionError.message.includes('timeout') || connectionError.message.includes('ECONNREFUSED')) {
          testResult.status = 'network_error';
        } else if (connectionError.message.includes('token')) {
          testResult.status = 'token_error';
        }
      }

      connectionTests.push(testResult);
    }

    const overallStatus = {
      connected: connectionTests.filter(t => t.isConnected).length,
      total: connectionTests.length,
      failed: connectionTests.filter(t => !t.isConnected).length,
      averageResponseTime: connectionTests
        .filter(t => t.responseTime)
        .reduce((sum, t, _, arr) => sum + t.responseTime / arr.length, 0)
    };

    res.json({
      success: true,
      overall: overallStatus,
      connections: connectionTests,
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('Connection health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check connections',
      details: error.message
    });
  }
});

/**
 * GET /api/health/database
 * Database health and statistics
 */
router.get('/database', async (req, res) => {
  try {
    const stats = {
      collections: {},
      persons: {},
      lastUpdates: {},
      dataIntegrity: {}
    };

    // Get collection counts
    stats.collections = {
      persons: await Person.countDocuments(),
      tokens: await Token.countDocuments(),
      accounts: await Account.countDocuments(),
      positions: await Position.countDocuments(),
      activities: await Activity.countDocuments(),
      snapshots: await PortfolioSnapshot.countDocuments()
    };

    // Get per-person statistics
    const persons = await Person.find({ isActive: true });
    for (const person of persons) {
      const personStats = {
        accounts: await Account.countDocuments({ personName: person.name }),
        positions: await Position.countDocuments({ personName: person.name }),
        activities: await Activity.countDocuments({ personName: person.name }),
        snapshots: await PortfolioSnapshot.countDocuments({ personName: person.name }),
        lastSyncTime: person.lastSyncTime,
        lastSyncStatus: person.lastSyncStatus
      };

      stats.persons[person.name] = personStats;
    }

    // Get last update times
    const lastPosition = await Position.findOne({}, { lastUpdated: 1 }).sort({ lastUpdated: -1 });
    const lastActivity = await Activity.findOne({}, { lastUpdated: 1 }).sort({ lastUpdated: -1 });
    const lastAccount = await Account.findOne({}, { lastUpdated: 1 }).sort({ lastUpdated: -1 });

    stats.lastUpdates = {
      positions: lastPosition?.lastUpdated,
      activities: lastActivity?.lastUpdated,
      accounts: lastAccount?.lastUpdated
    };

    // Basic data integrity checks
    stats.dataIntegrity = {
      orphanedPositions: await Position.countDocuments({
        accountId: { $nin: await Account.distinct('accountId') }
      }),
      orphanedActivities: await Activity.countDocuments({
        accountId: { $nin: await Account.distinct('accountId') }
      }),
      personsWithoutTokens: await Person.countDocuments({
        name: { $nin: await Token.distinct('personName') }
      }),
      personsWithoutAccounts: await Person.countDocuments({
        name: { $nin: await Account.distinct('personName') }
      })
    };

    // Calculate health score
    const totalIssues = Object.values(stats.dataIntegrity).reduce((sum, count) => sum + count, 0);
    const healthScore = Math.max(0, 100 - (totalIssues * 5)); // 5 points per issue

    res.json({
      success: true,
      healthScore,
      statistics: stats,
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('Database health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check database health',
      details: error.message
    });
  }
});

/**
 * GET /api/health/sync-status
 * Get sync status for all persons
 */
router.get('/sync-status', async (req, res) => {
  try {
    const syncStatuses = await dataSync.getAllSyncStatuses();
    
    const overview = {
      totalPersons: syncStatuses.length,
      activeSyncs: syncStatuses.filter(s => s.isInProgress).length,
      recentlySuccessful: syncStatuses.filter(s => 
        s.lastSyncStatus === 'success' && 
        s.lastSyncTime && 
        (Date.now() - new Date(s.lastSyncTime)) < 24 * 60 * 60 * 1000 // Last 24 hours
      ).length,
      failedSyncs: syncStatuses.filter(s => s.lastSyncStatus === 'failed').length
    };

    res.json({
      success: true,
      overview,
      statuses: syncStatuses,
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('Sync status check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get sync status',
      details: error.message
    });
  }
});

/**
 * POST /api/health/repair/:personName
 * Attempt to repair issues for a specific person
 */
router.post('/repair/:personName', async (req, res) => {
  try {
    const { personName } = req.params;
    const { repairType = 'all' } = req.body;

    const person = await Person.findOne({ name: personName });
    if (!person) {
      return res.status(404).json({
        success: false,
        error: 'Person not found'
      });
    }

    const repairResults = {
      tokenRefresh: null,
      dataSync: null,
      integrityFix: null
    };

    // Repair token issues
    if (repairType === 'all' || repairType === 'token') {
      try {
        await tokenManager.refreshAccessToken(personName);
        repairResults.tokenRefresh = { success: true, message: 'Token refreshed successfully' };
      } catch (tokenError) {
        repairResults.tokenRefresh = { success: false, error: tokenError.message };
      }
    }

    // Repair data sync issues
    if (repairType === 'all' || repairType === 'sync') {
      try {
        const syncResult = await dataSync.syncPersonData(personName, { fullSync: true });
        repairResults.dataSync = { success: true, result: syncResult };
      } catch (syncError) {
        repairResults.dataSync = { success: false, error: syncError.message };
      }
    }

    // Fix data integrity issues
    if (repairType === 'all' || repairType === 'integrity') {
      try {
        // Remove orphaned data
        const orphanedPositions = await Position.deleteMany({
          personName,
          accountId: { $nin: await Account.distinct('accountId', { personName }) }
        });

        const orphanedActivities = await Activity.deleteMany({
          personName,
          accountId: { $nin: await Account.distinct('accountId', { personName }) }
        });

        repairResults.integrityFix = {
          success: true,
          removedOrphanedPositions: orphanedPositions.deletedCount,
          removedOrphanedActivities: orphanedActivities.deletedCount
        };
      } catch (integrityError) {
        repairResults.integrityFix = { success: false, error: integrityError.message };
      }
    }

    res.json({
      success: true,
      personName,
      repairResults,
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('Repair operation failed:', error);
    res.status(500).json({
      success: false,
      error: 'Repair operation failed',
      details: error.message
    });
  }
});

/**
 * GET /api/health/system
 * Overall system health summary
 */
router.get('/system', async (req, res) => {
  try {
    // Get all health metrics
    const [tokenHealth, connectionHealth, dbHealth, syncHealth] = await Promise.allSettled([
      // Token health
      (async () => {
        const persons = await Person.find({ isActive: true });
        const tokens = await Token.find({});
        return {
          totalPersons: persons.length,
          personsWithTokens: tokens.length,
          healthyTokens: tokens.filter(t => 
            t.accessTokenExpiry && new Date(t.accessTokenExpiry) > new Date()
          ).length
        };
      })(),
      
      // Connection health (simplified)
      (async () => {
        const persons = await Person.find({ isActive: true });
        let connected = 0;
        for (const person of persons.slice(0, 3)) { // Test only first 3 to avoid timeout
          try {
            await questradeApi.getServerTime(person.name);
            connected++;
          } catch (error) {
            // Connection failed
          }
        }
        return { connected, tested: Math.min(persons.length, 3) };
      })(),
      
      // Database health
      (async () => {
        const totalRecords = 
          await Person.countDocuments() +
          await Account.countDocuments() +
          await Position.countDocuments() +
          await Activity.countDocuments();
        
        return { totalRecords };
      })(),
      
      // Sync health
      (async () => {
        const persons = await Person.find({ isActive: true });
        const recentlySuccessful = persons.filter(p => 
          p.lastSyncStatus === 'success' && 
          p.lastSyncTime && 
          (Date.now() - new Date(p.lastSyncTime)) < 24 * 60 * 60 * 1000
        ).length;
        
        return { recentlySuccessful, total: persons.length };
      })()
    ]);

    // Calculate overall health score
    let healthScore = 100;
    let issues = [];

    // Token health (30% weight)
    if (tokenHealth.status === 'fulfilled') {
      const tokenRatio = tokenHealth.value.healthyTokens / tokenHealth.value.totalPersons || 0;
      if (tokenRatio < 0.8) {
        healthScore -= (1 - tokenRatio) * 30;
        issues.push(`${Math.round((1 - tokenRatio) * 100)}% of tokens need attention`);
      }
    } else {
      healthScore -= 30;
      issues.push('Unable to check token health');
    }

    // Connection health (25% weight)
    if (connectionHealth.status === 'fulfilled') {
      const connectionRatio = connectionHealth.value.connected / connectionHealth.value.tested || 0;
      if (connectionRatio < 1) {
        healthScore -= (1 - connectionRatio) * 25;
        issues.push(`${Math.round((1 - connectionRatio) * 100)}% of connections failed`);
      }
    } else {
      healthScore -= 25;
      issues.push('Unable to test connections');
    }

    // Database health (20% weight)
    if (dbHealth.status === 'fulfilled') {
      if (dbHealth.value.totalRecords === 0) {
        healthScore -= 20;
        issues.push('No data in database');
      }
    } else {
      healthScore -= 20;
      issues.push('Unable to check database');
    }

    // Sync health (25% weight)
    if (syncHealth.status === 'fulfilled') {
      const syncRatio = syncHealth.value.recentlySuccessful / syncHealth.value.total || 0;
      if (syncRatio < 0.8) {
        healthScore -= (1 - syncRatio) * 25;
        issues.push(`${Math.round((1 - syncRatio) * 100)}% of syncs are stale`);
      }
    } else {
      healthScore -= 25;
      issues.push('Unable to check sync status');
    }

    healthScore = Math.max(0, Math.round(healthScore));

    let status = 'healthy';
    if (healthScore < 50) status = 'critical';
    else if (healthScore < 80) status = 'warning';

    res.json({
      success: true,
      healthScore,
      status,
      issues,
      components: {
        tokens: tokenHealth.status === 'fulfilled' ? tokenHealth.value : { error: tokenHealth.reason?.message },
        connections: connectionHealth.status === 'fulfilled' ? connectionHealth.value : { error: connectionHealth.reason?.message },
        database: dbHealth.status === 'fulfilled' ? dbHealth.value : { error: dbHealth.reason?.message },
        sync: syncHealth.status === 'fulfilled' ? syncHealth.value : { error: syncHealth.reason?.message }
      },
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('System health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'System health check failed',
      details: error.message
    });
  }
});

module.exports = router;