// routes/auth.js
const express = require('express');
const router = express.Router();
const questradeApi = require('../services/questradeApi');
const Token = require('../models/Token');
const logger = require('../utils/logger');

// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
  try {
    const result = await questradeApi.refreshAccessToken();
    res.json({
      success: true,
      message: 'Token refreshed successfully',
      expiresIn: 1800
    });
  } catch (error) {
    logger.error('Error refreshing token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh token',
      message: error.message
    });
  }
});

// Get token status
router.get('/token-status', async (req, res) => {
  try {
    const accessToken = await Token.findOne({
      type: 'access',
      isActive: true,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    
    const refreshToken = await Token.findOne({
      type: 'refresh',
      isActive: true
    }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      accessToken: {
        exists: !!accessToken,
        expiresAt: accessToken ? accessToken.expiresAt : null,
        isValid: accessToken && new Date() < accessToken.expiresAt
      },
      refreshToken: {
        exists: !!refreshToken,
        expiresAt: refreshToken ? refreshToken.expiresAt : null,
        isValid: refreshToken && new Date() < refreshToken.expiresAt
      }
    });
  } catch (error) {
    logger.error('Error getting token status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get token status'
    });
  }
});

// Manual token update endpoint
router.post('/update-refresh-token', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }
    
    // Deactivate old tokens
    await Token.updateMany({ type: 'refresh', isActive: true }, { isActive: false });
    
    // Save new refresh token
    await Token.create({
      type: 'refresh',
      token: token,
      expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)),
      isActive: true
    });
    
    res.json({
      success: true,
      message: 'Refresh token updated successfully'
    });
  } catch (error) {
    logger.error('Error updating refresh token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update refresh token'
    });
  }
});

module.exports = router;