const mongoose = require('mongoose');

const marketQuoteSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    index: true
  },
  symbolId: {
    type: Number,
    required: true
  },
  
  // Quote data
  bidPrice: Number,
  bidSize: Number,
  askPrice: Number,
  askSize: Number,
  lastTradePrice: Number,
  lastTradeSize: Number,
  lastTradeTick: String,
  lastTradeTime: Date,
  volume: Number,
  openPrice: Number,
  highPrice: Number,
  lowPrice: Number,
  delay: Number,
  isHalted: Boolean,
  
  // VWAP
  VWAP: Number,
  
  // Snap quote tracking
  isSnapQuote: Boolean,
  snapQuoteTime: Date,
  
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// TTL index for automatic cleanup of old quotes (7 days)
marketQuoteSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('MarketQuote', marketQuoteSchema);