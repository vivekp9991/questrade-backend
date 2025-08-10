// routes/accounts.js
const express = require('express');
const router = express.Router();
const Account = require('../models/Account');
const Person = require('../models/Person');
const accountAggregator = require('../services/accountAggregator');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Get all accounts
router.get('/', asyncHandler(async (req, res) => {
  const { personName, includeInactive = false } = req.query;
  
  let query = {};
  if (personName) {
    query.personName = personName;
  }
  
  const accounts = await Account.find(query)
    .sort({ personName: 1, type: 1 });
  
  res.json({
    success: true,
    data: accounts
  });
}));

// Get accounts grouped by person
router.get('/by-person', asyncHandler(async (req, res) => {
  const { includeInactive = false } = req.query;
  
  // Get all active persons
  const persons = await Person.find({ isActive: true })
    .sort({ personName: 1 });
  
  const result = {};
  
  for (const person of persons) {
    const accounts = await Account.find({ 
      personName: person.personName 
    }).sort({ type: 1, accountId: 1 });
    
    result[person.personName] = {
      person: {
        personName: person.personName,
        displayName: person.displayName,
        hasValidToken: person.hasValidToken,
        lastSuccessfulSync: person.lastSuccessfulSync
      },
      accounts: accounts.map(account => ({
        accountId: account.accountId,
        type: account.type,
        displayName: account.displayName || `${account.type} - ${account.accountId}`,
        status: account.status,
        isPrimary: account.isPrimary,
        balances: account.balances,
        numberOfPositions: account.numberOfPositions,
        totalInvestment: account.totalInvestment,
        currentValue: account.currentValue,
        syncedAt: account.syncedAt
      }))
    };
  }
  
  res.json({
    success: true,
    data: result
  });
}));

// Get account dropdown options for UI
router.get('/dropdown-options', asyncHandler(async (req, res) => {
  try {
    const options = await accountAggregator.getAccountDropdownOptions();
    
    res.json({
      success: true,
      data: options
    });
  } catch (error) {
    logger.error('Error getting dropdown options:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get account options'
    });
  }
}));

// Get account summary statistics
router.get('/summary', asyncHandler(async (req, res) => {
  const totalAccounts = await Account.countDocuments();
  const totalPersons = await Person.countDocuments({ isActive: true });
  
  // Group accounts by type
  const accountsByType = await Account.aggregate([
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        totalValue: { $sum: '$currentValue' }
      }
    }
  ]);
  
  // Group accounts by person
  const accountsByPerson = await Account.aggregate([
    {
      $group: {
        _id: '$personName',
        count: { $sum: 1 },
        totalValue: { $sum: '$currentValue' },
        totalInvestment: { $sum: '$totalInvestment' }
      }
    }
  ]);
  
  res.json({
    success: true,
    data: {
      summary: {
        totalAccounts,
        totalPersons,
        averageAccountsPerPerson: totalPersons > 0 ? totalAccounts / totalPersons : 0
      },
      byType: accountsByType,
      byPerson: accountsByPerson
    }
  });
}));

// Create a new account
router.post('/', asyncHandler(async (req, res) => {
  try {
    const account = await Account.create(req.body);
    
    // Update person's account count
    if (account.personName) {
      await Person.findOneAndUpdate(
        { personName: account.personName },
        { $inc: { numberOfAccounts: 1 } }
      );
    }
    
    res.status(201).json({
      success: true,
      data: account
    });
  } catch (error) {
    logger.error('Error creating account:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create account'
    });
  }
}));

// Update account information
router.put('/:accountId', asyncHandler(async (req, res) => {
  const { accountId } = req.params;
  const updateData = req.body;
  
  // Remove sensitive fields that shouldn't be updated directly
  delete updateData.accountId;
  delete updateData.balances;
  delete updateData.syncedAt;
  
  const account = await Account.findOneAndUpdate(
    { accountId },
    { ...updateData, updatedAt: new Date() },
    { new: true }
  );
  
  if (!account) {
    return res.status(404).json({
      success: false,
      error: 'Account not found'
    });
  }
  
  res.json({
    success: true,
    data: account
  });
}));

// Delete account
router.delete('/:accountId', asyncHandler(async (req, res) => {
  const { accountId } = req.params;
  
  const account = await Account.findOne({ accountId });
  
  if (!account) {
    return res.status(404).json({
      success: false,
      error: 'Account not found'
    });
  }
  
  await Account.deleteOne({ accountId });
  
  // Update person's account count
  if (account.personName) {
    await Person.findOneAndUpdate(
      { personName: account.personName },
      { $inc: { numberOfAccounts: -1 } }
    );
  }
  
  logger.info(`Account deleted: ${accountId}`);
  
  res.json({
    success: true,
    message: 'Account deleted successfully'
  });
}));

// Get specific account details
router.get('/:accountId', asyncHandler(async (req, res) => {
  const { accountId } = req.params;
  
  const account = await Account.findOne({ accountId });
  
  if (!account) {
    return res.status(404).json({
      success: false,
      error: 'Account not found'
    });
  }
  
  // Get person information
  const person = await Person.findOne({ 
    personName: account.personName 
  }).select('personName displayName hasValidToken lastSuccessfulSync');
  
  res.json({
    success: true,
    data: {
      ...account.toObject(),
      person
    }
  });
}));

module.exports = router;