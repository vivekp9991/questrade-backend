// services/questradeApi.js
const axios = require('axios');
const Token = require('../models/Token');
const logger = require('../utils/logger');

class QuestradeAPI {
  constructor() {
    this.authUrl = process.env.QUESTRADE_AUTH_URL || 'https://login.questrade.com';
    this.apiServer = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Refresh access token using refresh token
  async refreshAccessToken() {
    try {
      // Get the latest refresh token from database
      const refreshTokenDoc = await Token.findOne({ 
        type: 'refresh', 
        isActive: true 
      }).sort({ createdAt: -1 });

      if (!refreshTokenDoc) {
        throw new Error('No active refresh token found. Please run setup again or update refresh token via API.');
      }

      const refreshToken = refreshTokenDoc.getDecryptedToken();
      
      logger.info('Attempting to refresh access token...');
      
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

      // IMPORTANT: Deactivate ALL old tokens
      await Token.updateMany({ isActive: true }, { isActive: false });

      // Save new access token
      const newAccessToken = await Token.create({
        type: 'access',
        token: access_token,
        apiServer: api_server,
        expiresAt: new Date(Date.now() + (expires_in * 1000)),
        isActive: true
      });

      // CRITICAL: Save the NEW refresh token (Questrade provides a new one each time)
      const newRefreshTokenDoc = await Token.create({
        type: 'refresh',
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)), // 7 days
        isActive: true
      });

      // Update instance variables
      this.apiServer = api_server;
      this.accessToken = access_token;
      this.tokenExpiry = new Date(Date.now() + (expires_in * 1000));

      logger.info('Access token refreshed successfully');
      logger.info(`New API server: ${api_server}`);
      logger.info(`Access token expires at: ${this.tokenExpiry}`);
      logger.info('New refresh token saved for next use');
      
      return { 
        accessToken: access_token, 
        apiServer: api_server,
        expiresAt: this.tokenExpiry
      };
    } catch (error) {
      if (error.response) {
        logger.error('Questrade API error:', {
          status: error.response.status,
          data: error.response.data,
          headers: error.response.headers
        });
        
        if (error.response.status === 400) {
          throw new Error('Invalid or expired refresh token. Please get a new refresh token from Questrade and run setup again.');
        }
      }
      
      logger.error('Error refreshing access token:', error.message);
      throw error;
    }
  }

  // Get valid access token (refresh if needed)
  async getValidAccessToken() {
    try {
      // Check if current in-memory token is still valid
      if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
        logger.debug('Using cached access token');
        return { accessToken: this.accessToken, apiServer: this.apiServer };
      }

      // Try to get from database
      const accessTokenDoc = await Token.findOne({
        type: 'access',
        isActive: true,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      if (accessTokenDoc) {
        this.accessToken = accessTokenDoc.getDecryptedToken();
        this.apiServer = accessTokenDoc.apiServer;
        this.tokenExpiry = accessTokenDoc.expiresAt;
        
        logger.debug('Using access token from database');
        return { accessToken: this.accessToken, apiServer: this.apiServer };
      }

      // Need to refresh
      logger.info('Access token expired or not found, refreshing...');
      return await this.refreshAccessToken();
    } catch (error) {
      logger.error('Error getting valid access token:', error);
      throw error;
    }
  }

  // Make authenticated API request with retry logic
  async makeRequest(endpoint, method = 'GET', data = null, retryCount = 0) {
    try {
      const { accessToken, apiServer } = await this.getValidAccessToken();
      
      if (!apiServer || !accessToken) {
        throw new Error('Unable to get valid API credentials');
      }
      
      const config = {
        method,
        url: `${apiServer}v1${endpoint}`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      };

      if (data) {
        config.data = data;
      }

      logger.debug(`Making ${method} request to ${endpoint}`);
      const response = await axios(config);
      
      return response.data;
    } catch (error) {
      if (error.response) {
        logger.error(`API request failed for ${endpoint}:`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        // If unauthorized and haven't retried yet, try refreshing token once
        if (error.response.status === 401 && retryCount === 0) {
          logger.info('Received 401, attempting to refresh token and retry...');
          await this.refreshAccessToken();
          return this.makeRequest(endpoint, method, data, retryCount + 1);
        }
        
        // Throw more descriptive error
        const errorMessage = error.response.data?.message || error.response.statusText;
        throw new Error(`Questrade API error (${error.response.status}): ${errorMessage}`);
      }
      
      logger.error(`Network or other error for ${endpoint}:`, error.message);
      throw error;
    }
  }

  // Test connection and get server time
  async testConnection() {
    try {
      const result = await this.makeRequest('/time');
      logger.info('API connection test successful:', result);
      return result;
    } catch (error) {
      logger.error('API connection test failed:', error);
      throw error;
    }
  }

  // Account endpoints
  async getAccounts() {
    return this.makeRequest('/accounts');
  }

  async getAccountPositions(accountId) {
    return this.makeRequest(`/accounts/${accountId}/positions`);
  }

  async getAccountBalances(accountId) {
    return this.makeRequest(`/accounts/${accountId}/balances`);
  }

  async getAccountActivities(accountId, startTime, endTime) {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    
    const queryString = params.toString();
    const endpoint = `/accounts/${accountId}/activities${queryString ? '?' + queryString : ''}`;
    return this.makeRequest(endpoint);
  }

  async getAccountOrders(accountId, stateFilter = null) {
    const params = stateFilter ? `?stateFilter=${stateFilter}` : '';
    return this.makeRequest(`/accounts/${accountId}/orders${params}`);
  }

  // Market data endpoints
  async getSymbol(symbolId) {
    return this.makeRequest(`/symbols/${symbolId}`);
  }

  async getSymbols(ids = null, names = null) {
    // Ensure we have either ids or names
    if (!ids && !names) {
      throw new Error('Either ids or names must be provided');
    }
    
    const params = new URLSearchParams();
    if (ids) params.append('ids', ids);
    if (names) params.append('names', names);
    
    const queryString = params.toString();
    return this.makeRequest(`/symbols${queryString ? '?' + queryString : ''}`);
  }

  async getMarketQuote(symbolIds) {
    const ids = Array.isArray(symbolIds) ? symbolIds.join(',') : symbolIds;
    return this.makeRequest(`/markets/quotes?ids=${ids}`);
  }

  // Snap quote for real-time price (counts against limit)
  async getSnapQuote(symbolIds) {
    const ids = Array.isArray(symbolIds) ? symbolIds.join(',') : symbolIds;
    const quotes = await this.makeRequest(`/markets/quotes?ids=${ids}`);
    
    // Mark as snap quote
    if (quotes && quotes.quotes) {
      quotes.quotes.forEach(quote => {
        quote.isSnapQuote = true;
        quote.snapQuoteTime = new Date();
      });
    }
    
    return quotes;
  }

  async getMarkets() {
    return this.makeRequest('/markets');
  }

  async getMarketCandles(symbolId, startTime, endTime, interval) {
    const params = new URLSearchParams({
      startTime,
      endTime,
      interval
    });
    
    return this.makeRequest(`/markets/candles/${symbolId}?${params.toString()}`);
  }

  // Helper to search for a symbol
  async searchSymbol(symbol) {
    try {
      const result = await this.getSymbols(null, symbol);
      if (result.symbols && result.symbols.length > 0) {
        return result.symbols[0];
      }
      return null;
    } catch (error) {
      logger.error(`Error searching for symbol ${symbol}:`, error);
      return null;
    }
  }
}

module.exports = new QuestradeAPI();