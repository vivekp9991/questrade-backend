// services/tokenManager.js - FIXED VERSION with correct Questrade API call
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

  // Refresh access token for a specific person - FIXED
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
      
      // Validate refresh token format before making API call
      if (!refreshToken || refreshToken.length < 20) {
        throw new Error(`Invalid refresh token format for ${personName}`);
      }
      
      logger.info(`Attempting to refresh access token for ${personName}...`);
      
      // FIXED: Use GET request with query parameters as per Questrade API documentation
      const response = await axios.get(`${this.authUrl}/oauth2/token`, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        },
        timeout: 15000 // 15 second timeout
      });

      const { access_token, refresh_token: newRefreshToken, api_server, expires_in } = response.data;

      if (!access_token || !newRefreshToken) {
        throw new Error('Invalid response from Questrade API - missing tokens');
      }

      // Delete all old tokens for this person to avoid duplicates
      await Token.deleteMany({ personName });

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
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        if (error.response.status === 400) {
          throw new Error(`Invalid or expired refresh token for ${personName}. Please update the refresh token.`);
        } else if (error.response.status === 401) {
          throw new Error(`Unauthorized access for ${personName}. Token may be invalid.`);
        } else if (error.response.status >= 500) {
          throw new Error(`Questrade server error. Please try again later.`);
        }
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(`Unable to connect to Questrade API. Please check your internet connection.`);
      } else if (error.code === 'ECONNABORTED') {
        throw new Error(`Request to Questrade API timed out. Please try again.`);
      }
      
      logger.error(`Error refreshing access token for ${personName}:`, error.message);
      throw error;
    }
  }

  // Add or update refresh token for a person - FIXED
  async setupPersonToken(personName, refreshToken) {
    try {
      // Validate refresh token format
      if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length < 20) {
        throw new Error('Invalid refresh token format. Please ensure you have copied the complete token from Questrade.');
      }

      // Clean the token (remove any whitespace)
      const cleanToken = refreshToken.trim();
      
      logger.info(`Setting up token for ${personName}...`);
      
      // FIXED: Validate the refresh token by trying to get an access token using GET request
      const testResponse = await axios.get(`${this.authUrl}/oauth2/token`, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: cleanToken
        },
        timeout: 15000 // 15 second timeout for initial validation
      });

      if (!testResponse.data.access_token) {
        throw new Error('Invalid refresh token - could not obtain access token');
      }

      // Delete all old tokens for this person (to avoid duplicate key errors)
      await Token.deleteMany({ personName });

      // Save the validated refresh token
      await Token.create({
        type: 'refresh',
        personName,
        token: cleanToken,
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)), // 7 days
        isActive: true
      });

      // Also save the access token we just received
      await Token.create({
        type: 'access',
        personName,
        token: testResponse.data.access_token,
        apiServer: testResponse.data.api_server,
        expiresAt: new Date(Date.now() + (testResponse.data.expires_in * 1000)),
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
      return { 
        success: true, 
        personName,
        apiServer: testResponse.data.api_server
      };
    } catch (error) {
      logger.error(`Error setting up token for ${personName}:`, error);
      
      // Provide more specific error messages
      if (error.response) {
        const { status, data } = error.response;
        if (status === 400) {
          throw new Error(`Invalid refresh token for ${personName}. Please verify the token is correct and not expired.`);
        } else if (status === 401) {
          throw new Error(`Unauthorized. The refresh token for ${personName} may be invalid or expired.`);
        } else if (status >= 500) {
          throw new Error(`Questrade server error (${status}). Please try again later.`);
        } else {
          throw new Error(`Questrade API error (${status}): ${data?.error_description || data?.message || 'Unknown error'}`);
        }
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(`Unable to connect to Questrade API. Please check your internet connection and try again.`);
      } else if (error.code === 'ECONNABORTED') {
        throw new Error(`Connection to Questrade API timed out. Please try again.`);
      }
      
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
          errorCount: refreshToken ? refreshToken.errorCount : 0,
          lastError: refreshToken ? refreshToken.lastError : null
        },
        accessToken: {
          exists: !!accessToken,
          expiresAt: accessToken ? accessToken.expiresAt : null,
          lastUsed: accessToken ? accessToken.lastUsed : null,
          apiServer: accessToken ? accessToken.apiServer : null
        },
        isHealthy: !!refreshToken && (!!accessToken || !refreshToken.lastError)
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

  // Test connection for a person - FIXED
  async testConnection(personName) {
    try {
      const { accessToken, apiServer } = await this.getValidAccessToken(personName);
      
      const response = await axios.get(`${apiServer}/v1/time`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 10000 // 10 second timeout
      });

      // Update last successful use
      await Token.findOneAndUpdate(
        { personName, type: 'refresh', isActive: true },
        { 
          lastSuccessfulUse: new Date(),
          errorCount: 0,
          lastError: null
        }
      );

      return {
        success: true,
        serverTime: response.data.time,
        personName,
        apiServer
      };
    } catch (error) {
      await this.recordTokenError(personName, error.message);
      
      // Provide specific error messages for connection testing
      if (error.response && error.response.status === 401) {
        throw new Error(`Authentication failed for ${personName}. Token may be expired or invalid.`);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(`Unable to connect to Questrade API. Please check your internet connection.`);
      } else if (error.code === 'ECONNABORTED') {
        throw new Error(`Connection to Questrade API timed out.`);
      }
      
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

  // Validate refresh token without saving - FIXED
  async validateRefreshToken(refreshToken) {
    try {
      // Basic format validation
      if (!refreshToken || typeof refreshToken !== 'string') {
        return {
          valid: false,
          error: 'Refresh token must be a non-empty string'
        };
      }

      const cleanToken = refreshToken.trim();
      
      if (cleanToken.length < 20) {
        return {
          valid: false,
          error: 'Refresh token appears to be too short. Please ensure you copied the complete token from Questrade.'
        };
      }

      // FIXED: Test with Questrade API using GET request
      const response = await axios.get(`${this.authUrl}/oauth2/token`, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: cleanToken
        },
        timeout: 15000 // 15 second timeout
      });

      return {
        valid: !!response.data.access_token,
        apiServer: response.data.api_server,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      logger.error('Token validation failed:', error);
      
      if (error.response) {
        const { status, data } = error.response;
        if (status === 400) {
          return {
            valid: false,
            error: 'Invalid or expired refresh token'
          };
        } else if (status === 401) {
          return {
            valid: false,
            error: 'Unauthorized - token may be invalid'
          };
        } else if (status >= 500) {
          return {
            valid: false,
            error: 'Questrade server error - please try again later'
          };
        } else {
          return {
            valid: false,
            error: data?.error_description || data?.message || `API error (${status})`
          };
        }
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        return {
          valid: false,
          error: 'Unable to connect to Questrade API'
        };
      } else if (error.code === 'ECONNABORTED') {
        return {
          valid: false,
          error: 'Request timed out'
        };
      }
      
      return {
        valid: false,
        error: error.message || 'Unknown validation error'
      };
    }
  }
}

module.exports = new TokenManager();