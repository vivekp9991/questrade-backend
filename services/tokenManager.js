// services/tokenManager.js
const Token = require('../models/Token');
const Person = require('../models/Person');
const logger = require('../utils/logger');
const axios = require('axios');

class TokenManager {
  constructor() {
    this.authUrl = process.env.QUESTRADE_AUTH_URL || 'https://login.questrade.com';
  }

  // Get valid access token for a specific person
  async getValidAccessToken(personName) {
    try {
      // Check for valid access token in database
      const accessToken = await Token.findOne({
        personName,
        type: 'access',
        isActive: true,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      if (accessToken) {
        await accessToken.markAsUsed();
        return {
          accessToken: accessToken.getDecryptedToken(),
          apiServer: accessToken.apiServer,
          personName
        };
      }

      // Need to refresh token
      logger.info(`Access token expired for ${personName}, refreshing...`);
      return await this.refreshAccessToken(personName);
    } catch (error) {
      logger.error(`Error getting valid access token for ${personName}:`, error);
      throw error;
    }
  }

  // Refresh access token for a specific person
  async refreshAccessToken(personName) {
    try {
      const refreshTokenDoc = await Token.findOne({
        personName,
        type: 'refresh',
        isActive: true
      }).sort({ createdAt: -1 });

      if (!refreshTokenDoc) {
        throw new Error(`No active refresh token found for ${personName}`);
      }

      const refreshToken = refreshTokenDoc.getDecryptedToken();
      
      logger.info(`Attempting to refresh access token for ${personName}...`);
      
      const response = await axios.post(`${this.authUrl}/oauth2/token`, null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const { access_token, refresh_token: newRefreshToken, api_server, expires_in } = response.data;

      if (!access_token || !newRefreshToken) {
        throw new Error('Invalid response from Questrade API - missing tokens');
      }

      // Deactivate old tokens for this person
      await Token.updateMany({ 
        personName, 
        isActive: true 
      }, { 
        isActive: false 
      });

      // Save new access token
      await Token.create({
        type: 'access',
        personName,
        token: access_token,
        apiServer: api_server,
        expiresAt: new Date(Date.now() + (expires_in * 1000)),
        isActive: true
      });

      // Save new refresh token
      await Token.create({
        type: 'refresh',
        personName,
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)), // 7 days
        isActive: true
      });

      // Update person record
      await Person.findOneAndUpdate(
        { personName },
        { 
          hasValidToken: true,
          lastTokenRefresh: new Date(),
          lastSyncError: null
        }
      );

      logger.info(`Token refreshed successfully for ${personName}`);
      
      return {
        accessToken: access_token,
        apiServer: api_server,
        personName
      };
    } catch (error) {
      // Record error in token and person records
      await this.recordTokenError(personName, error.message);
      
      if (error.response) {
        logger.error(`Questrade API error for ${personName}:`, {
          status: error.response.status,
          data: error.response.data
        });
        
        if (error.response.status === 400) {
          throw new Error(`Invalid or expired refresh token for ${personName}. Please update the refresh token.`);
        }
      }
      
      logger.error(`Error refreshing access token for ${personName}:`, error.message);
      throw error;
    }
  }

  // Add or update refresh token for a person
  async setupPersonToken(personName, refreshToken) {
    try {
      // Validate the refresh token by trying to get an access token
      const testResponse = await axios.post(`${this.authUrl}/oauth2/token`, null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (!testResponse.data.access_token) {
        throw new Error('Invalid refresh token - could not obtain access token');
      }

      // Deactivate old tokens for this person
      await Token.updateMany({ 
        personName, 
        isActive: true 
      }, { 
        isActive: false 
      });

      // Save the validated refresh token
      await Token.create({
        type: 'refresh',
        personName,
        token: refreshToken,
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)), // 7 days
        isActive: true
      });

      // Create or update person record
      await Person.findOneAndUpdate(
        { personName },
        { 
          personName,
          hasValidToken: true,
          lastTokenRefresh: new Date(),
          lastSyncError: null,
          isActive: true
        },
        { upsert: true }
      );

      logger.info(`Refresh token setup successfully for ${personName}`);
      return { success: true, personName };
    } catch (error) {
      logger.error(`Error setting up token for ${personName}:`, error);
      throw new Error(`Failed to setup token for ${personName}: ${error.message}`);
    }
  }

  // Get token status for a person
  async getTokenStatus(personName) {
    try {
      const refreshToken = await Token.findOne({
        personName,
        type: 'refresh',
        isActive: true
      }).sort({ createdAt: -1 });

      const accessToken = await Token.findOne({
        personName,
        type: 'access',
        isActive: true,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      return {
        personName,
        refreshToken: {
          exists: !!refreshToken,
          expiresAt: refreshToken ? refreshToken.expiresAt : null,
          lastUsed: refreshToken ? refreshToken.lastUsed : null,
          errorCount: refreshToken ? refreshToken.errorCount : 0
        },
        accessToken: {
          exists: !!accessToken,
          expiresAt: accessToken ? accessToken.expiresAt : null,
          lastUsed: accessToken ? accessToken.lastUsed : null,
          apiServer: accessToken ? accessToken.apiServer : null
        }
      };
    } catch (error) {
      logger.error(`Error getting token status for ${personName}:`, error);
      throw error;
    }
  }

  // Get token status for all persons
  async getAllTokenStatus() {
    try {
      const persons = await Person.find({ isActive: true });
      const statusPromises = persons.map(p => this.getTokenStatus(p.personName));
      return await Promise.all(statusPromises);
    } catch (error) {
      logger.error('Error getting all token status:', error);
      throw error;
    }
  }

  // Test connection for a person
  async testConnection(personName) {
    try {
      const { accessToken, apiServer } = await this.getValidAccessToken(personName);
      
      const response = await axios.get(`${apiServer}v1/time`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      return {
        success: true,
        serverTime: response.data.time,
        personName
      };
    } catch (error) {
      await this.recordTokenError(personName, error.message);
      throw error;
    }
  }

  // Record token error
  async recordTokenError(personName, errorMessage) {
    try {
      // Update token error count
      await Token.findOneAndUpdate(
        { personName, type: 'refresh', isActive: true },
        { 
          $inc: { errorCount: 1 },
          lastError: errorMessage,
          lastUsed: new Date()
        }
      );

      // Update person record
      await Person.findOneAndUpdate(
        { personName },
        { 
          hasValidToken: false,
          lastSyncError: errorMessage
        }
      );
    } catch (error) {
      logger.error(`Error recording token error for ${personName}:`, error);
    }
  }

  // Remove person and all their tokens
  async removePerson(personName) {
    try {
      // Deactivate all tokens
      await Token.updateMany(
        { personName, isActive: true },
        { isActive: false }
      );

      // Deactivate person
      await Person.findOneAndUpdate(
        { personName },
        { 
          isActive: false,
          hasValidToken: false
        }
      );

      logger.info(`Person ${personName} and their tokens have been deactivated`);
      return { success: true };
    } catch (error) {
      logger.error(`Error removing person ${personName}:`, error);
      throw error;
    }
  }

  // Validate refresh token without saving
  async validateRefreshToken(refreshToken) {
    try {
      const response = await axios.post(`${this.authUrl}/oauth2/token`, null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        valid: !!response.data.access_token,
        apiServer: response.data.api_server,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      return {
        valid: false,
        error: error.response?.data?.error_description || error.message
      };
    }
  }
}

module.exports = new TokenManager();