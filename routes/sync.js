// routes/sync.js
const express = require('express');
const router = express.Router();
const dataSync = require('../services/dataSync');
const Person = require('../models/Person');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Sync data for specific person
router.post('/person/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  const { fullSync = false } = req.body;
  
  try {
    const result = await dataSync.syncPersonData(personName, {
      fullSync: fullSync === true || fullSync === 'true'
    });
    
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
router.post('/all-persons', asyncHandler(async (req, res) => {
  const { fullSync = false } = req.body;
  
  try {
    const result = await dataSync.syncAllPersons({
      fullSync: fullSync === true || fullSync === 'true'
    });
    
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

// Get sync status for specific person
router.get('/status/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  try {
    const status = await dataSync.getSyncStatus(personName);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Person not found'
      });
    }
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error(`Error getting sync status for ${personName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to get sync status'
    });
  }
}));

// Get sync status for all persons
router.get('/status', asyncHandler(async (req, res) => {
  try {
    const statuses = await dataSync.getAllSyncStatuses();
    
    res.json({
      success: true,
      data: statuses
    });
  } catch (error) {
    logger.error('Error getting all sync statuses:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get sync statuses'
    });
  }
}));

// Stop sync for specific person (emergency stop)
router.post('/stop/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  try {
    await dataSync.stopSync(personName);
    
    res.json({
      success: true,
      message: `Sync stopped for ${personName}`
    });
  } catch (error) {
    logger.error(`Error stopping sync for ${personName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop sync'
    });
  }
}));

module.exports = router;