// routes/accounts.js
const express = require('express');
const router = express.Router();
const Account = require('../models/Account');
const logger = require('../utils/logger');

// Get all accounts
router.get('/', async (req, res) => {
  try {
    const accounts = await Account.find({});
    res.json({
      success: true,
      data: accounts
    });
  } catch (error) {
    logger.error('Error getting accounts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get accounts'
    });
  }
});

// Create a new account
router.post('/', async (req, res) => {
  try {
    const account = await Account.create(req.body);
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
});

module.exports = router;