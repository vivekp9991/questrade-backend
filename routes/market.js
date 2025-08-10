// routes/market.js - FIXED VERSION - Auto-detect personName
const express = require('express');
const router = express.Router();
const questradeApi = require('../services/questradeApi');
const MarketQuote = require('../models/MarketQuote');
const Symbol = require('../models/Symbol');
const Person = require('../models/Person');
const logger = require('../utils/logger');

// Helper function to get default person name
async function getDefaultPersonName() {
  try {
    const firstActivePerson = await Person.findOne({ isActive: true }).sort({ createdAt: 1 });
    return firstActivePerson ? firstActivePerson.personName : null;
  } catch (error) {
    logger.error('Error getting default person:', error);
    return null;
  }
}

// Get market quote (snap quote)
router.get('/quote/:symbols', async (req, res) => {
  try {
    const { symbols } = req.params;
    let { personName } = req.query;
    
    // Auto-detect personName if not provided
    if (!personName) {
      personName = await getDefaultPersonName();
      if (!personName) {
        return res.status(400).json({
          success: false,
          error: 'No active persons found. Please add a person first or specify personName in query.'
        });
      }
      logger.info(`Auto-detected personName: ${personName} for market quote request`);
    }
    
    const symbolList = symbols.split(',');
    
    // Get symbol IDs
    const symbolDocs = await Symbol.find({
      symbol: { $in: symbolList }
    });
    
    if (symbolDocs.length === 0) {
      // Try to fetch from API
      try {
        const symbolsData = await questradeApi.getSymbols(null, symbols, personName);
        
        if (!symbolsData.symbols || symbolsData.symbols.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Symbols not found'
          });
        }
        
        // Save symbols
        for (const sym of symbolsData.symbols) {
          await Symbol.findOneAndUpdate(
            { symbolId: sym.symbolId },
            sym,
            { upsert: true }
          );
        }
        
        symbolDocs.push(...symbolsData.symbols);
      } catch (symbolError) {
        logger.error('Error fetching symbols from API:', symbolError);
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch symbols from Questrade API',
          details: symbolError.message
        });
      }
    }
    
    const symbolIds = symbolDocs.map(s => s.symbolId);
    
    // Get snap quotes
    const quotes = await questradeApi.getSnapQuote(symbolIds, personName);
    
    // Save quotes to database
    if (quotes.quotes) {
      for (const quote of quotes.quotes) {
        await MarketQuote.create({
          symbol: quote.symbol,
          symbolId: quote.symbolId,
          bidPrice: quote.bidPrice,
          bidSize: quote.bidSize,
          askPrice: quote.askPrice,
          askSize: quote.askSize,
          lastTradePrice: quote.lastTradePrice,
          lastTradeSize: quote.lastTradeSize,
          lastTradeTick: quote.lastTradeTick,
          lastTradeTime: quote.lastTradeTime,
          volume: quote.volume,
          openPrice: quote.openPrice,
          highPrice: quote.highPrice,
          lowPrice: quote.lowPrice,
          delay: quote.delay,
          isHalted: quote.isHalted,
          VWAP: quote.VWAP,
          isSnapQuote: true,
          snapQuoteTime: new Date()
        });
      }
    }
    
    res.json({
      success: true,
      data: quotes,
      personName // Include which person was used
    });
  } catch (error) {
    logger.error('Error getting market quote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get market quote',
      details: error.message
    });
  }
});

// Get symbol information
router.get('/symbols/:symbols', async (req, res) => {
  try {
    const { symbols } = req.params;
    let { personName } = req.query;
    
    // Auto-detect personName if not provided
    if (!personName) {
      personName = await getDefaultPersonName();
      if (!personName) {
        return res.status(400).json({
          success: false,
          error: 'No active persons found. Please add a person first or specify personName in query.'
        });
      }
    }
    
    const symbolList = symbols.split(',');
    
    // Try to get from database first
    let symbolDocs = await Symbol.find({
      symbol: { $in: symbolList }
    });
    
    // If not all found, fetch from API
    if (symbolDocs.length < symbolList.length) {
      const symbolsData = await questradeApi.getSymbols(null, symbols, personName);
      
      if (symbolsData.symbols) {
        for (const sym of symbolsData.symbols) {
          const saved = await Symbol.findOneAndUpdate(
            { symbolId: sym.symbolId },
            sym,
            { upsert: true, new: true }
          );
          
          // Add if not already in list
          if (!symbolDocs.find(s => s.symbolId === saved.symbolId)) {
            symbolDocs.push(saved);
          }
        }
      }
    }
    
    res.json({
      success: true,
      data: symbolDocs,
      personName
    });
  } catch (error) {
    logger.error('Error getting symbols:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get symbols',
      details: error.message
    });
  }
});

// Get market candles (historical data)
router.get('/candles/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { startTime, endTime, interval = 'OneDay' } = req.query;
    let { personName } = req.query;
    
    // Auto-detect personName if not provided
    if (!personName) {
      personName = await getDefaultPersonName();
      if (!personName) {
        return res.status(400).json({
          success: false,
          error: 'No active persons found. Please add a person first or specify personName in query.'
        });
      }
    }
    
    // Get symbol ID
    const symbolDoc = await Symbol.findOne({ symbol });
    
    if (!symbolDoc) {
      return res.status(404).json({
        success: false,
        error: 'Symbol not found'
      });
    }
    
    const candles = await questradeApi.getMarketCandles(
      symbolDoc.symbolId,
      startTime,
      endTime,
      interval,
      personName
    );
    
    res.json({
      success: true,
      data: candles,
      personName
    });
  } catch (error) {
    logger.error('Error getting market candles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get market candles',
      details: error.message
    });
  }
});

module.exports = router;