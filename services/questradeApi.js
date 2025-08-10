// services/questradeApi.js - FIXED VERSION
const axios = require('axios');
const tokenManager = require('./tokenManager');
const logger = require('../utils/logger');

class QuestradeAPI {
  constructor() {
    this.authUrl = process.env.QUESTRADE_AUTH_URL || 'https://login.questrade.com';
    // Cache for storing person-specific API servers and tokens
    this.personCache = new Map();
  }

  // Legacy refresh access token (uses first person or specified person)
  async refreshAccessToken(personName = null) {
    try {
      if (!personName) {
        // For backward compatibility, find first active person
        const Person = require('../models/Person');
        const firstPerson = await Person.findOne({ isActive: true });
        if (!firstPerson) {
          throw new Error('No active persons found. Please add a person first.');
        }
        personName = firstPerson.personName;
      }

      return await tokenManager.refreshAccessToken(personName);
    } catch (error) {
      logger.error(`Error in legacy refreshAccessToken:`, error);
      throw error;
    }
  }

  // Get valid access token for specific person
  async getValidAccessToken(personName) {
    try {
      return await tokenManager.getValidAccessToken(personName);
    } catch (error) {
      logger.error(`Error getting valid access token for ${personName}:`, error);
      throw error;
    }
  }

  // Make authenticated API request with person context
  async makeRequest(endpoint, personName, method = 'GET', data = null, retryCount = 0) {
    try {
      const { accessToken, apiServer } = await this.getValidAccessToken(personName);
      
      if (!apiServer || !accessToken) {
        throw new Error(`Unable to get valid API credentials for ${personName}`);
      }
      
      const config = {
        method,
        url: `${apiServer}v1${endpoint}`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      };

      if (data) {
        config.data = data;
      }

      logger.debug(`Making ${method} request to ${endpoint} for ${personName}`);
      const response = await axios(config);
      
      return response.data;
    } catch (error) {
      if (error.response) {
        logger.error(`API request failed for ${endpoint} (${personName}):`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        // If unauthorized and haven't retried yet, try refreshing token once
        if (error.response.status === 401 && retryCount === 0) {
          logger.info(`Received 401 for ${personName}, attempting to refresh token and retry...`);
          await tokenManager.refreshAccessToken(personName);
          return this.makeRequest(endpoint, personName, method, data, retryCount + 1);
        }
        
        // Record error in token manager
        await tokenManager.recordTokenError(personName, error.response.data?.message || error.response.statusText);
        
        // Throw more descriptive error
        const errorMessage = error.response.data?.message || error.response.statusText;
        throw new Error(`Questrade API error (${error.response.status}): ${errorMessage}`);
      }
      
      logger.error(`Network or other error for ${endpoint} (${personName}):`, error.message);
      throw error;
    }
  }

  // Test connection for specific person
  async testConnection(personName) {
    try {
      const result = await this.makeRequest('/time', personName);
      logger.info(`API connection test successful for ${personName}:`, result);
      return result;
    } catch (error) {
      logger.error(`API connection test failed for ${personName}:`, error);
      throw error;
    }
  }

  // Get server time (useful for testing)
  async getServerTime(personName) {
    try {
      const result = await this.makeRequest('/time', personName);
      return result.time;
    } catch (error) {
      logger.error(`Error getting server time for ${personName}:`, error);
      throw error;
    }
  }

  // Account endpoints with person context
  async getAccounts(personName) {
    return this.makeRequest('/accounts', personName);
  }

  async getAccountPositions(accountId, personName) {
    return this.makeRequest(`/accounts/${accountId}/positions`, personName);
  }

  async getAccountBalances(accountId, personName) {
    return this.makeRequest(`/accounts/${accountId}/balances`, personName);
  }

  // FIXED: Corrected parameter order for getAccountActivities
  async getAccountActivities(accountId, personName, startTime, endTime) {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    
    const queryString = params.toString();
    const endpoint = `/accounts/${accountId}/activities${queryString ? '?' + queryString : ''}`;
    return this.makeRequest(endpoint, personName);
  }

  async getAccountOrders(accountId, personName, stateFilter = null) {
    const params = stateFilter ? `?stateFilter=${stateFilter}` : '';
    return this.makeRequest(`/accounts/${accountId}/orders${params}`, personName);
  }

  // Market data endpoints with person context
  async getSymbol(symbolId, personName) {
    return this.makeRequest(`/symbols/${symbolId}`, personName);
  }

  async getSymbols(ids = null, names = null, personName) {
    // Ensure we have either ids or names
    if (!ids && !names) {
      throw new Error('Either ids or names must be provided');
    }
    
    const params = new URLSearchParams();
    if (ids) params.append('ids', ids);
    if (names) params.append('names', names);
    
    const queryString = params.toString();
    return this.makeRequest(`/symbols${queryString ? '?' + queryString : ''}`, personName);
  }

  async getMarketQuote(symbolIds, personName) {
    const ids = Array.isArray(symbolIds) ? symbolIds.join(',') : symbolIds;
    return this.makeRequest(`/markets/quotes?ids=${ids}`, personName);
  }

  // Snap quote for real-time price (counts against limit)
  async getSnapQuote(symbolIds, personName) {
    const ids = Array.isArray(symbolIds) ? symbolIds.join(',') : symbolIds;
    const quotes = await this.makeRequest(`/markets/quotes?ids=${ids}`, personName);
    
    // Mark as snap quote
    if (quotes && quotes.quotes) {
      quotes.quotes.forEach(quote => {
        quote.isSnapQuote = true;
        quote.snapQuoteTime = new Date();
      });
    }
    
    return quotes;
  }

  async getMarkets(personName) {
    return this.makeRequest('/markets', personName);
  }

  async getMarketCandles(symbolId, startTime, endTime, interval, personName) {
    const params = new URLSearchParams({
      startTime,
      endTime,
      interval
    });
    
    return this.makeRequest(`/markets/candles/${symbolId}?${params.toString()}`, personName);
  }

  // Helper to search for a symbol
  async searchSymbol(symbol, personName) {
    try {
      const result = await this.getSymbols(null, symbol, personName);
      if (result.symbols && result.symbols.length > 0) {
        return result.symbols[0];
      }
      return null;
    } catch (error) {
      logger.error(`Error searching for symbol ${symbol} (${personName}):`, error);
      return null;
    }
  }

  // Legacy methods for backward compatibility (use first active person)
  async legacyGetAccounts() {
    const Person = require('../models/Person');
    const firstPerson = await Person.findOne({ isActive: true });
    if (!firstPerson) {
      throw new Error('No active persons found');
    }
    return this.getAccounts(firstPerson.personName);
  }

  async legacyGetAccountPositions(accountId) {
    const Account = require('../models/Account');
    const account = await Account.findOne({ accountId });
    if (!account) {
      throw new Error('Account not found');
    }
    return this.getAccountPositions(accountId, account.personName);
  }

  async legacyGetAccountBalances(accountId) {
    const Account = require('../models/Account');
    const account = await Account.findOne({ accountId });
    if (!account) {
      throw new Error('Account not found');
    }
    return this.getAccountBalances(accountId, account.personName);
  }

  async legacyGetAccountActivities(accountId, startTime, endTime) {
    const Account = require('../models/Account');
    const account = await Account.findOne({ accountId });
    if (!account) {
      throw new Error('Account not found');
    }
    return this.getAccountActivities(accountId, account.personName, startTime, endTime);
  }

  // Multi-person operations
  async getAllAccountsForAllPersons() {
    const Person = require('../models/Person');
    const persons = await Person.find({ isActive: true });
    
    const results = {};
    
    for (const person of persons) {
      try {
        const accounts = await this.getAccounts(person.personName);
        results[person.personName] = {
          success: true,
          accounts: accounts.accounts || []
        };
      } catch (error) {
        logger.error(`Error getting accounts for ${person.personName}:`, error);
        results[person.personName] = {
          success: false,
          error: error.message
        };
      }
    }
    
    return results;
  }

  async getPositionsForAllPersons() {
    const Person = require('../models/Person');
    const Account = require('../models/Account');
    const persons = await Person.find({ isActive: true });
    
    const results = {};
    
    for (const person of persons) {
      try {
        const accounts = await Account.find({ personName: person.personName });
        const personPositions = {};
        
        for (const account of accounts) {
          try {
            const positions = await this.getAccountPositions(account.accountId, person.personName);
            personPositions[account.accountId] = {
              success: true,
              positions: positions.positions || []
            };
          } catch (error) {
            logger.error(`Error getting positions for ${account.accountId} (${person.personName}):`, error);
            personPositions[account.accountId] = {
              success: false,
              error: error.message
            };
          }
        }
        
        results[person.personName] = personPositions;
      } catch (error) {
        logger.error(`Error processing positions for ${person.personName}:`, error);
        results[person.personName] = {
          error: error.message
        };
      }
    }
    
    return results;
  }

  // Get person name from account ID
  async getPersonNameFromAccount(accountId) {
    const Account = require('../models/Account');
    const account = await Account.findOne({ accountId });
    return account ? account.personName : null;
  }

  // Helper methods for data sync operations
  async getPositions(accountId, personName) {
    return this.getAccountPositions(accountId, personName);
  }

  async getActivities(accountId, startTime, endTime, personName) {
    return this.getAccountActivities(accountId, personName, startTime, endTime);
  }
}

module.exports = new QuestradeAPI();