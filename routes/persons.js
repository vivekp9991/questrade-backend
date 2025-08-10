// routes/persons.js
const express = require('express');
const router = express.Router();
const Person = require('../models/Person');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Token = require('../models/Token');
const tokenManager = require('../services/tokenManager');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Get all persons
router.get('/', asyncHandler(async (req, res) => {
  const persons = await Person.find({ isActive: true })
    .sort({ personName: 1 });
  
  // Enrich with account counts and token status
  const enrichedPersons = await Promise.all(
    persons.map(async (person) => {
      const accountCount = await Account.countDocuments({ 
        personName: person.personName 
      });
      
      const positionCount = await Position.countDocuments({ 
        personName: person.personName 
      });

      const tokenStatus = await tokenManager.getTokenStatus(person.personName);
      
      return {
        ...person.toObject(),
        accountCount,
        positionCount,
        tokenStatus
      };
    })
  );

  res.json({
    success: true,
    data: enrichedPersons
  });
}));

// Get specific person details
router.get('/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  const person = await Person.findOne({ 
    personName, 
    isActive: true 
  });
  
  if (!person) {
    return res.status(404).json({
      success: false,
      error: 'Person not found'
    });
  }

  // Get detailed information
  const accounts = await Account.find({ personName });
  const tokenStatus = await tokenManager.getTokenStatus(personName);
  const positionCount = await Position.countDocuments({ personName });
  const activityCount = await Activity.countDocuments({ personName });

  res.json({
    success: true,
    data: {
      ...person.toObject(),
      accounts,
      tokenStatus,
      statistics: {
        positionCount,
        activityCount,
        accountCount: accounts.length
      }
    }
  });
}));

// Create new person
router.post('/', asyncHandler(async (req, res) => {
  const { personName, refreshToken, displayName, email, phoneNumber } = req.body;
  
  if (!personName || !refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Person name and refresh token are required'
    });
  }

  // Check if person already exists
  const existingPerson = await Person.findOne({ personName });
  if (existingPerson) {
    return res.status(400).json({
      success: false,
      error: 'Person already exists'
    });
  }

  // Setup token and create person
  try {
    await tokenManager.setupPersonToken(personName, refreshToken);
    
    const person = await Person.create({
      personName,
      displayName: displayName || personName,
      email,
      phoneNumber,
      hasValidToken: true,
      lastTokenRefresh: new Date()
    });

    logger.info(`Person created: ${personName}`);
    
    res.status(201).json({
      success: true,
      data: person,
      message: 'Person created successfully'
    });
  } catch (error) {
    logger.error(`Error creating person ${personName}:`, error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}));

// Update person information
router.put('/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  const { newPersonName, displayName, email, phoneNumber, preferences } = req.body;
  
  const person = await Person.findOne({ personName, isActive: true });
  
  if (!person) {
    return res.status(404).json({
      success: false,
      error: 'Person not found'
    });
  }

  // If changing person name, update related records
  if (newPersonName && newPersonName !== personName) {
    // Check if new name already exists
    const existingPerson = await Person.findOne({ personName: newPersonName });
    if (existingPerson) {
      return res.status(400).json({
        success: false,
        error: 'Person name already exists'
      });
    }

    // Update person name in all related collections
    await Promise.all([
      Token.updateMany({ personName }, { personName: newPersonName }),
      Account.updateMany({ personName }, { personName: newPersonName }),
      Position.updateMany({ personName }, { personName: newPersonName }),
      Activity.updateMany({ personName }, { personName: newPersonName })
    ]);
    
    person.personName = newPersonName;
  }

  // Update other fields
  if (displayName) person.displayName = displayName;
  if (email) person.email = email;
  if (phoneNumber) person.phoneNumber = phoneNumber;
  if (preferences) person.preferences = { ...person.preferences, ...preferences };

  await person.save();

  logger.info(`Person updated: ${personName} -> ${person.personName}`);
  
  res.json({
    success: true,
    data: person,
    message: 'Person updated successfully'
  });
}));

// Delete person (soft delete)
router.delete('/:personName', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  const { permanent = false } = req.query;
  
  const person = await Person.findOne({ personName });
  
  if (!person) {
    return res.status(404).json({
      success: false,
      error: 'Person not found'
    });
  }

  if (permanent === 'true') {
    // Permanent deletion - remove all related data
    await Promise.all([
      Token.deleteMany({ personName }),
      Account.deleteMany({ personName }),
      Position.deleteMany({ personName }),
      Activity.deleteMany({ personName }),
      Person.deleteOne({ personName })
    ]);
    
    logger.info(`Person permanently deleted: ${personName}`);
    
    res.json({
      success: true,
      message: 'Person and all related data permanently deleted'
    });
  } else {
    // Soft delete - deactivate person and tokens
    await tokenManager.removePerson(personName);
    
    logger.info(`Person soft deleted: ${personName}`);
    
    res.json({
      success: true,
      message: 'Person deactivated successfully'
    });
  }
}));

// Add or update refresh token for person
router.post('/:personName/token', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Refresh token is required'
    });
  }

  try {
    const result = await tokenManager.setupPersonToken(personName, refreshToken);
    
    res.json({
      success: true,
      data: result,
      message: 'Refresh token updated successfully'
    });
  } catch (error) {
    logger.error(`Error updating token for ${personName}:`, error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}));

// Get token status for person
router.get('/:personName/token-status', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  try {
    const tokenStatus = await tokenManager.getTokenStatus(personName);
    
    res.json({
      success: true,
      data: tokenStatus
    });
  } catch (error) {
    logger.error(`Error getting token status for ${personName}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

// Test connection for person
router.post('/:personName/test-connection', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  try {
    const result = await tokenManager.testConnection(personName);
    
    res.json({
      success: true,
      data: result,
      message: 'Connection test successful'
    });
  } catch (error) {
    logger.error(`Connection test failed for ${personName}:`, error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}));

// Get person statistics
router.get('/:personName/statistics', asyncHandler(async (req, res) => {
  const { personName } = req.params;
  
  const person = await Person.findOne({ personName, isActive: true });
  if (!person) {
    return res.status(404).json({
      success: false,
      error: 'Person not found'
    });
  }

  // Calculate statistics
  const accountCount = await Account.countDocuments({ personName });
  const positionCount = await Position.countDocuments({ personName });
  const activityCount = await Activity.countDocuments({ personName });
  const dividendCount = await Activity.countDocuments({ 
    personName, 
    type: 'Dividend' 
  });

  // Calculate portfolio values
  const positions = await Position.find({ personName });
  const totalInvestment = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
  const currentValue = positions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
  const totalDividends = positions.reduce((sum, p) => 
    sum + (p.dividendData?.totalReceived || 0), 0
  );

  const statistics = {
    accounts: {
      total: accountCount,
      active: accountCount // Assuming all are active
    },
    positions: {
      total: positionCount,
      withDividends: positions.filter(p => 
        p.dividendData && p.dividendData.annualDividend > 0
      ).length
    },
    activities: {
      total: activityCount,
      dividends: dividendCount
    },
    portfolio: {
      totalInvestment,
      currentValue,
      totalDividends,
      unrealizedGain: currentValue - totalInvestment,
      totalReturn: (currentValue - totalInvestment) + totalDividends
    },
    lastSync: person.lastSuccessfulSync,
    tokenStatus: await tokenManager.getTokenStatus(personName)
  };

  res.json({
    success: true,
    data: statistics
  });
}));

module.exports = router;