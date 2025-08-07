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
        throw new Error('No active refresh token found');
      }

      const refreshToken = refreshTokenDoc.getDecryptedToken();
      
      const response = await axios.post(`${this.authUrl}/oauth2/token`, null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }
      });

      const { access_token, refresh_token: newRefreshToken, api_server, expires_in } = response.data;

      // Deactivate old tokens
      await Token.updateMany({ isActive: true }, { isActive: false });

      // Save new access token
      await Token.create({
        type: 'access',
        token: access_token,
        apiServer: api_server,
        expiresAt: new Date(Date.now() + (expires_in * 1000)),
        isActive: true
      });

      // Save new refresh token (expires in 7 days)
      await Token.create({
        type: 'refresh',
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)),
        isActive: true
      });

      this.apiServer = api_server;
      this.accessToken = access_token;
      this.tokenExpiry = new Date(Date.now() + (expires_in * 1000));

      logger.info('Access token refreshed successfully');
      return { accessToken: access_token, apiServer: api_server };
    } catch (error) {
      logger.error('Error refreshing access token:', error);
      throw error;
    }
  }

  // Get valid access token (refresh if needed)
  async getValidAccessToken() {
    // Check if current token is still valid
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
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
      return { accessToken: this.accessToken, apiServer: this.apiServer };
    }

    // Need to refresh
    return await this.refreshAccessToken();
  }

  // Make authenticated API request
  async makeRequest(endpoint, method = 'GET', data = null) {
    try {
      const { accessToken, apiServer } = await this.getValidAccessToken();
      
      const config = {
        method,
        url: `${apiServer}/v1${endpoint}`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      };

      if (data) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      logger.error(`API request failed for ${endpoint}:`, error);
      
      // If unauthorized, try refreshing token once
      if (error.response && error.response.status === 401) {
        logger.info('Unauthorized, attempting to refresh token...');
        await this.refreshAccessToken();
        return this.makeRequest(endpoint, method, data);
      }
      
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
    
    return this.makeRequest(`/accounts/${accountId}/activities?${params.toString()}`);
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
    const params = new URLSearchParams();
    if (ids) params.append('ids', ids);
    if (names) params.append('names', names);
    
    return this.makeRequest(`/symbols?${params.toString()}`);
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
}

module.exports = new QuestradeAPI();