// routes/market.js
const express = require('express');
const router = express.Router();
const questradeApi = require('../services/questradeApi');
const MarketQuote = require('../models/MarketQuote');
const Symbol = require('../models/Symbol');
const logger = require('../utils/logger');

// Get market quote (snap quote)
router.get('/quote/:symbols', async (req, res) => {
  try {
    const { symbols } = req.params;
    const symbolList = symbols.split(',');
    
    // Get symbol IDs
    const symbolDocs = await Symbol.find({
      symbol: { $in: symbolList }
    });
    
    if (symbolDocs.length === 0) {
      // Try to fetch from API
      const symbolsData = await questradeApi.getSymbols(null, symbols);
      
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
    }
    
    const symbolIds = symbolDocs.map(s => s.symbolId);
    
    // Get snap quotes
    const quotes = await questradeApi.getSnapQuote(symbolIds);
    
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
      data: quotes
    });
  } catch (error) {
    logger.error('Error getting market quote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get market quote'
    });
  }
});

// Get symbol information
router.get('/symbols/:symbols', async (req, res) => {
  try {
    const { symbols } = req.params;
    const symbolList = symbols.split(',');
    
    // Try to get from database first
    let symbolDocs = await Symbol.find({
      symbol: { $in: symbolList }
    });
    
    // If not all found, fetch from API
    if (symbolDocs.length < symbolList.length) {
      const symbolsData = await questradeApi.getSymbols(null, symbols);
      
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
      data: symbolDocs
    });
  } catch (error) {
    logger.error('Error getting symbols:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get symbols'
    });
  }
});

// Get market candles (historical data)
router.get('/candles/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { startTime, endTime, interval = 'OneDay' } = req.query;
    
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
      interval
    );
    
    res.json({
      success: true,
      data: candles
    });
  } catch (error) {
    logger.error('Error getting market candles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get market candles'
    });
  }
});

module.exports = router;