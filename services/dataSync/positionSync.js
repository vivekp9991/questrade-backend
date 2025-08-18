// services/dataSync/positionSync.js - FIXED VERSION - Properly saves and enriches dividend data
const questradeApi = require('../questradeApi');
const Account = require('../../models/Account');
const Position = require('../../models/Position');
const Symbol = require('../../models/Symbol');
const DividendCalculator = require('./dividendCalculator');
const SyncUtils = require('./syncUtils');
const logger = require('../../utils/logger');

class PositionSync {
  constructor() {
    this.utils = new SyncUtils();
    this.dividendCalculator = new DividendCalculator();
  }

  /**
   * Sync positions for a specific person - ENHANCED WITH DIVIDEND CALCULATION
   */
  async syncPositionsForPerson(personName, fullSync = false) {
    const result = this.utils.createSyncResult();
    
    try {
      // Validate person and token
      await this.utils.validatePersonForSync(personName);

      const accounts = await Account.find({ personName });
      
      if (accounts.length === 0) {
        logger.warn(`No accounts found for ${personName}, skipping position sync`);
        return this.utils.finalizeSyncResult(result);
      }
      
      this.utils.logSyncOperation('Position sync started', personName, { 
        accountCount: accounts.length,
        fullSync 
      });
      
      for (const account of accounts) {
        try {
          const accountResult = await this.syncPositionsForAccount(account, personName, fullSync);
          result.synced += accountResult.synced;
          result.errors.push(...accountResult.errors);
        } catch (accountError) {
          result.errors.push({
            accountId: account.accountId,
            error: accountError.message
          });
          this.utils.logSyncError('Position sync for account', personName, accountError, {
            accountId: account.accountId
          });
        }
      }

      // After syncing all positions, ensure symbol data is up to date
      await this.updateSymbolDataForPerson(personName);

    } catch (error) {
      result.errors.push({
        type: 'POSITIONS_SYNC_ERROR',
        error: error.message
      });
      this.utils.logSyncError('Position sync', personName, error);
      throw error;
    }

    this.utils.logSyncOperation('Position sync completed', personName, {
      synced: result.synced,
      errors: result.errors.length
    });

    return this.utils.finalizeSyncResult(result);
  }

  /**
   * Sync positions for a single account
   */
  async syncPositionsForAccount(account, personName, fullSync) {
    const result = { synced: 0, errors: [] };

    try {
      const positionsData = await questradeApi.getAccountPositions(account.accountId, personName);
      
      if (!positionsData || !positionsData.positions) {
        logger.info(`Processing 0 positions for account ${account.accountId}`);
        return result;
      }

      // Clear existing positions for this account if full sync
      if (fullSync) {
        await Position.deleteMany({ accountId: account.accountId, personName });
        logger.debug(`Cleared existing positions for account ${account.accountId} (full sync)`);
      }

      logger.info(`Processing ${positionsData.positions.length} positions for account ${account.accountId}`);

      // First, fetch and update all symbol data
      const symbolIds = positionsData.positions.map(p => p.symbolId);
      const symbolMap = await this.fetchAndUpdateSymbols(symbolIds, personName);

      // Process each position
      for (const positionData of positionsData.positions) {
        try {
          const savedPosition = await this.syncSinglePosition(
            positionData, 
            account, 
            personName, 
            symbolMap[positionData.symbolId]
          );
          
          if (savedPosition) {
            result.synced++;
          }
        } catch (positionError) {
          result.errors.push({
            accountId: account.accountId,
            symbol: positionData.symbol,
            error: positionError.message
          });
          logger.error(`Failed to save position ${positionData.symbol}:`, positionError);
        }
      }

      // Update account statistics after processing positions
      try {
        await this.utils.updateAccountStatistics(account.accountId, personName);
      } catch (statErr) {
        logger.error(`Failed to update stats for account ${account.accountId}:`, statErr);
      }

    } catch (error) {
      logger.error(`Failed to sync positions for account ${account.accountId}:`, error);
      throw error;
    }

    return result;
  }

  /**
   * Fetch and update symbol data from Questrade API - NEW METHOD
   */
  async fetchAndUpdateSymbols(symbolIds, personName) {
    const symbolMap = {};
    
    try {
      // Get existing symbols from database
      const existingSymbols = await Symbol.find({ symbolId: { $in: symbolIds } }).lean();
      existingSymbols.forEach(sym => { 
        symbolMap[sym.symbolId] = sym; 
      });

      // Check which symbols need updating (older than 24 hours or missing dividend data)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const symbolsToUpdate = symbolIds.filter(id => {
        const sym = symbolMap[id];
        return !sym || 
               !sym.lastUpdated || 
               sym.lastUpdated < oneDayAgo ||
               (sym.dividendPerShare === undefined && sym.dividend === undefined);
      });

      if (symbolsToUpdate.length > 0) {
        logger.info(`Fetching updated data for ${symbolsToUpdate.length} symbols from Questrade`);
        
        // Fetch from Questrade API in batches
        const batchSize = 100;
        for (let i = 0; i < symbolsToUpdate.length; i += batchSize) {
          const batch = symbolsToUpdate.slice(i, i + batchSize);
          const idsString = batch.join(',');
          
          try {
            const symbolsData = await questradeApi.getSymbols(idsString, null, personName);
            
            if (symbolsData && symbolsData.symbols) {
              for (const symData of symbolsData.symbols) {
                // Enrich and save symbol data
                const enrichedSymbol = await this.enrichAndSaveSymbol(symData, personName);
                symbolMap[enrichedSymbol.symbolId] = enrichedSymbol;
              }
            }
          } catch (batchError) {
            logger.error(`Error fetching symbol batch: ${batchError.message}`);
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching and updating symbols:', error);
    }

    return symbolMap;
  }

  /**
   * Enrich and save symbol data - NEW METHOD
   */
  async enrichAndSaveSymbol(symbolData, personName) {
    try {
      // Try to get additional market data for dividend info
      let marketQuote = null;
      try {
        const quoteData = await questradeApi.getMarketQuote([symbolData.symbolId], personName);
        if (quoteData && quoteData.quotes && quoteData.quotes.length > 0) {
          marketQuote = quoteData.quotes[0];
        }
      } catch (quoteError) {
        logger.debug(`Could not fetch market quote for ${symbolData.symbol}: ${quoteError.message}`);
      }

      // Create comprehensive symbol document
      const symbolDoc = {
        symbol: symbolData.symbol,
        symbolId: symbolData.symbolId,
        description: symbolData.description,
        securityType: symbolData.securityType,
        listingExchange: symbolData.listingExchange,
        currency: symbolData.currency,
        isTradable: symbolData.isTradable,
        isQuotable: symbolData.isQuotable,
        
        // Market data
        prevDayClosePrice: symbolData.prevDayClosePrice || marketQuote?.lastTradePrice,
        highPrice52: symbolData.highPrice52,
        lowPrice52: symbolData.lowPrice52,
        averageVol3Months: symbolData.averageVol3Months,
        averageVol20Days: symbolData.averageVol20Days,
        outstandingShares: symbolData.outstandingShares,
        marketCap: symbolData.marketCap,
        
        // Dividend info - ENHANCED
        dividend: symbolData.dividend || 0,
        dividendPerShare: symbolData.dividendPerShare || symbolData.dividend || 0,
        yield: symbolData.yield || 0,
        exDate: symbolData.exDate,
        dividendDate: symbolData.dividendDate,
        dividendFrequency: this.determineDividendFrequency(symbolData),
        annualDividend: this.calculateAnnualDividend(symbolData),
        
        // Industry classification
        industrySector: symbolData.industrySector || this.mapSectorFromSymbol(symbolData.symbol),
        industryGroup: symbolData.industryGroup,
        industrySubGroup: symbolData.industrySubGroup,
        
        // Financial metrics
        eps: symbolData.eps,
        pe: symbolData.pe,
        beta: symbolData.beta,
        
        // Options info
        hasOptions: symbolData.hasOptions,
        optionType: symbolData.optionType,
        optionRoot: symbolData.optionRoot,
        
        // Market quote data if available
        lastTradePrice: marketQuote?.lastTradePrice,
        bidPrice: marketQuote?.bidPrice,
        askPrice: marketQuote?.askPrice,
        volume: marketQuote?.volume,
        
        lastUpdated: new Date()
      };

      // Save or update symbol
      const savedSymbol = await Symbol.findOneAndUpdate(
        { symbolId: symbolData.symbolId },
        symbolDoc,
        { upsert: true, new: true }
      );

      return savedSymbol;
    } catch (error) {
      logger.error(`Error enriching symbol ${symbolData.symbol}:`, error);
      return symbolData;
    }
  }

  /**
   * Determine dividend frequency from symbol data - NEW METHOD
   */
  determineDividendFrequency(symbolData) {
    // Check if frequency is explicitly provided
    if (symbolData.dividendFrequency) {
      return symbolData.dividendFrequency;
    }

    // Try to infer from dividend amount and yield
    if (symbolData.dividend > 0 && symbolData.yield > 0 && symbolData.prevDayClosePrice > 0) {
      const annualDividend = (symbolData.yield / 100) * symbolData.prevDayClosePrice;
      const ratio = annualDividend / symbolData.dividend;
      
      if (Math.abs(ratio - 12) < 1) return 'Monthly';
      if (Math.abs(ratio - 4) < 0.5) return 'Quarterly';
      if (Math.abs(ratio - 2) < 0.5) return 'Semi-Annually';
      if (Math.abs(ratio - 1) < 0.5) return 'Annually';
    }

    // Default for dividend-paying stocks
    if (symbolData.dividend > 0) {
      return 'Quarterly'; // Most common
    }

    return null;
  }

  /**
   * Calculate annual dividend from symbol data - NEW METHOD
   */
  calculateAnnualDividend(symbolData) {
    // If annual dividend is provided
    if (symbolData.annualDividend) {
      return symbolData.annualDividend;
    }

    // Calculate from yield and price
    if (symbolData.yield > 0 && symbolData.prevDayClosePrice > 0) {
      return (symbolData.yield / 100) * symbolData.prevDayClosePrice;
    }

    // Calculate from dividend and frequency
    if (symbolData.dividend > 0 && symbolData.dividendFrequency) {
      const freq = symbolData.dividendFrequency.toLowerCase();
      if (freq === 'monthly') return symbolData.dividend * 12;
      if (freq === 'quarterly') return symbolData.dividend * 4;
      if (freq === 'semi-annually') return symbolData.dividend * 2;
      if (freq === 'annually') return symbolData.dividend;
    }

    return 0;
  }

  /**
   * Map sector from symbol - NEW METHOD
   */
  mapSectorFromSymbol(symbol) {
    if (!symbol) return null;

    // Canadian ETF mappings
    const etfSectorMap = {
      'HDIV': 'Diversified ETF',
      'HYLD': 'High Yield ETF',
      'HMAX': 'High Yield ETF',
      'HDIF': 'Diversified ETF',
      'KILO': 'Gold ETF',
      'AMAX': 'Technology ETF',
      'EMAX': 'Energy ETF',
      'FMAX': 'Financial ETF',
      'LMAX': 'Materials ETF',
      'UMAX': 'Utilities ETF',
      'BMAX': 'Healthcare ETF',
      'SMAX': 'Consumer ETF',
      'QMAX': 'Technology ETF',
      'HTAE': 'Technology ETF',
      'HHIS': 'Healthcare ETF',
      'HBIE': 'Technology ETF',
      'USCL': 'US Equity ETF',
      'QQCL': 'Technology ETF',
      'ENCL': 'Energy ETF',
      'EQCL': 'Equity ETF',
      'CNCL': 'Canadian Equity ETF',
      'UTES': 'Utilities ETF',
      'VFV': 'S&P 500 ETF',
      'GLD': 'Gold ETF'
    };

    // Remove .TO suffix for checking
    const baseSymbol = symbol.replace('.TO', '');
    
    return etfSectorMap[baseSymbol] || null;
  }

  /**
   * Sync a single position with enhanced dividend calculation - FIXED VERSION
   */
  async syncSinglePosition(positionData, account, personName, symbolInfo) {
    try {
      // Calculate additional metrics
      const totalReturnValue = (positionData.openPnl || 0);
      const totalReturnPercent = positionData.totalCost > 0 ? 
        (totalReturnValue / positionData.totalCost) * 100 : 0;
      const capitalGainPercent = positionData.totalCost > 0 ? 
        ((positionData.openPnl || 0) / positionData.totalCost) * 100 : 0;

      // ENHANCED: Calculate comprehensive dividend data
      const dividendData = await this.dividendCalculator.calculateDividendData(
        account.accountId, 
        personName, 
        positionData.symbolId, 
        positionData.symbol,
        positionData.openQuantity,
        positionData.averageEntryPrice,
        symbolInfo
      );

      // Validate dividend data
      const validation = this.dividendCalculator.validateDividendData(dividendData, positionData.symbol);
      if (!validation.isValid) {
        logger.warn(`Dividend data validation failed for ${positionData.symbol}:`, validation.warnings);
      }

      // Determine if this is a dividend stock
      const isDividendStock = (dividendData.annualDividend > 0) || 
                             (dividendData.totalReceived > 0) ||
                             (dividendData.dividendPerShare > 0) ||
                             (symbolInfo?.dividendPerShare > 0);

      // Extract dividend per share for position level
      const dividendPerShare = dividendData.dividendPerShare || 
                              symbolInfo?.dividendPerShare || 
                              symbolInfo?.dividend || 
                              0;

      // Extract current yield
      const currentYield = dividendData.currentYield || symbolInfo?.yield || 0;

      const positionDoc = {
        personName,
        accountId: account.accountId,
        symbolId: positionData.symbolId,
        symbol: positionData.symbol,
        openQuantity: positionData.openQuantity,
        closedQuantity: positionData.closedQuantity || 0,
        currentMarketValue: positionData.currentMarketValue,
        currentPrice: positionData.currentPrice,
        averageEntryPrice: positionData.averageEntryPrice,
        dayPnl: positionData.dayPnl || 0,
        closedPnl: positionData.closedPnl || 0,
        openPnl: positionData.openPnl || 0,
        totalCost: positionData.totalCost,
        isRealTime: positionData.isRealTime,
        isUnderReorg: positionData.isUnderReorg || false,
        
        // Calculated fields
        totalReturnPercent,
        totalReturnValue,
        capitalGainPercent,
        capitalGainValue: positionData.openPnl || 0,
        
        // ENHANCED: Comprehensive dividend data
        dividendData,
        
        // Position-level dividend fields
        dividendPerShare,
        currentYield,
        isDividendStock,
        
        // Symbol information
        currency: symbolInfo?.currency || (positionData.symbol?.includes('.TO') ? 'CAD' : 'USD'),
        securityType: symbolInfo?.securityType || 'Stock',
        industrySector: symbolInfo?.industrySector,
        industryGroup: symbolInfo?.industryGroup,
        
        // Market data cache
        marketData: {
          lastPrice: positionData.currentPrice,
          lastTradePrice: symbolInfo?.lastTradePrice,
          bidPrice: symbolInfo?.bidPrice,
          askPrice: symbolInfo?.askPrice,
          volume: symbolInfo?.volume,
          dayHigh: positionData.dayHigh,
          dayLow: positionData.dayLow,
          fiftyTwoWeekHigh: symbolInfo?.highPrice52,
          fiftyTwoWeekLow: symbolInfo?.lowPrice52,
          lastUpdated: new Date(),
          isRealTime: positionData.isRealTime
        },
        
        syncedAt: new Date(),
        updatedAt: new Date()
      };

      const savedPosition = await Position.findOneAndUpdate(
        { 
          accountId: account.accountId,
          symbolId: positionData.symbolId,
          personName 
        },
        positionDoc,
        { upsert: true, new: true }
      );

      // Log dividend info if significant
      if (dividendData.totalReceived > 0 || dividendData.annualDividend > 0) {
        logger.info(`Position ${positionData.symbol} synced with dividends:`, {
          shares: positionData.openQuantity,
          totalReceived: dividendData.totalReceived.toFixed(2),
          annualDividend: dividendData.annualDividend.toFixed(2),
          dividendPerShare: dividendPerShare.toFixed(3),
          yieldOnCost: dividendData.yieldOnCost.toFixed(2),
          currentYield: currentYield.toFixed(2)
        });
      } else {
        logger.debug(`Position ${positionData.symbol} synced: ${positionData.openQuantity} shares @ ${positionData.currentPrice}`);
      }
      
      return savedPosition;
    } catch (error) {
      logger.error(`Error syncing position ${positionData.symbol}:`, error);
      throw error;
    }
  }

  /**
   * Update symbol data for all positions of a person - NEW METHOD
   */
  async updateSymbolDataForPerson(personName) {
    try {
      // Get unique symbols for this person
      const positions = await Position.find({ personName }).distinct('symbolId');
      
      if (positions.length === 0) {
        return;
      }

      logger.info(`Updating symbol data for ${positions.length} unique symbols for ${personName}`);
      
      // Fetch and update symbols
      await this.fetchAndUpdateSymbols(positions, personName);
      
    } catch (error) {
      logger.error(`Error updating symbol data for ${personName}:`, error);
    }
  }

  /**
   * Recalculate dividends for all positions of a person
   */
  async recalculateDividends(personName, symbol = null) {
    try {
      let query = { personName };
      if (symbol) {
        query.symbol = symbol;
      }

      const positions = await Position.find(query);
      const updated = [];
      const errors = [];

      logger.info(`Starting dividend recalculation for ${positions.length} positions${symbol ? ` for symbol ${symbol}` : ''} for ${personName}`);

      for (const position of positions) {
        try {
          // Get latest symbol info
          const symbolInfo = await Symbol.findOne({ symbolId: position.symbolId });
          
          // If no symbol info, try to fetch it
          if (!symbolInfo || !symbolInfo.lastUpdated || 
              new Date(symbolInfo.lastUpdated) < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
            try {
              const symbolsData = await questradeApi.getSymbols(position.symbolId.toString(), null, personName);
              if (symbolsData && symbolsData.symbols && symbolsData.symbols.length > 0) {
                const enrichedSymbol = await this.enrichAndSaveSymbol(symbolsData.symbols[0], personName);
                Object.assign(symbolInfo || {}, enrichedSymbol);
              }
            } catch (fetchError) {
              logger.debug(`Could not fetch updated symbol data for ${position.symbol}`);
            }
          }
          
          // Recalculate dividend data
          const newDividendData = await this.dividendCalculator.calculateDividendData(
            position.accountId,
            position.personName,
            position.symbolId,
            position.symbol,
            position.openQuantity,
            position.averageEntryPrice,
            symbolInfo
          );

          // Update position fields
          const isDividendStock = (newDividendData.annualDividend > 0) || 
                                 (newDividendData.totalReceived > 0) ||
                                 (newDividendData.dividendPerShare > 0);

          const dividendPerShare = newDividendData.dividendPerShare || 
                                  symbolInfo?.dividendPerShare || 
                                  0;

          const currentYield = newDividendData.currentYield || symbolInfo?.yield || 0;

          await Position.findByIdAndUpdate(position._id, {
            dividendData: newDividendData,
            isDividendStock,
            dividendPerShare,
            currentYield,
            updatedAt: new Date()
          });

          updated.push({
            symbol: position.symbol,
            oldTotalReceived: position.dividendData?.totalReceived || 0,
            newTotalReceived: newDividendData.totalReceived,
            oldYieldOnCost: position.dividendData?.yieldOnCost || 0,
            newYieldOnCost: newDividendData.yieldOnCost
          });

          if (newDividendData.totalReceived > 0 || newDividendData.annualDividend > 0) {
            logger.info(`Updated ${position.symbol}:`, {
              totalReceived: newDividendData.totalReceived.toFixed(2),
              annualDividend: newDividendData.annualDividend.toFixed(2),
              yieldOnCost: newDividendData.yieldOnCost.toFixed(2),
              currentYield: currentYield.toFixed(2)
            });
          }

        } catch (error) {
          errors.push({
            symbol: position.symbol,
            error: error.message
          });
          logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        }
      }

      logger.info(`Dividend recalculation completed for ${personName}: ${updated.length} updated, ${errors.length} errors`);
      
      return {
        updated: updated.length,
        errors: errors.length,
        updatedPositions: updated,
        errorDetails: errors
      };
    } catch (error) {
      logger.error(`Error recalculating dividends for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = PositionSync;