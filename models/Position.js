const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    index: true
  },
  symbol: {
    type: String,
    required: true,
    index: true
  },
  symbolId: {
    type: Number,
    required: true
  },
  
  // Position details
  openQuantity: Number,
  closedQuantity: Number,
  currentMarketValue: Number,
  currentPrice: Number,
  averageEntryPrice: Number,
  dayPnl: Number,
  closedPnl: Number,
  openPnl: Number,
  totalCost: Number,
  isRealTime: Boolean,
  isUnderReorg: Boolean,
  
  // Calculated fields
  totalReturnPercent: Number,
  totalReturnValue: Number,
  capitalGainPercent: Number,
  capitalGainValue: Number,
  
  // Dividend tracking
  dividendData: {
    totalReceived: Number,
    lastDividendAmount: Number,
    lastDividendDate: Date,
    dividendReturnPercent: Number,
    yieldOnCost: Number,
    dividendAdjustedCost: Number,
    monthlyDividend: Number,
    annualDividend: Number
  },
  
  // Market data cache
  marketData: {
    lastPrice: Number,
    bidPrice: Number,
    askPrice: Number,
    volume: Number,
    dayHigh: Number,
    dayLow: Number,
    fiftyTwoWeekHigh: Number,
    fiftyTwoWeekLow: Number,
    lastUpdated: Date
  },
  
  syncedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for account and symbol
positionSchema.index({ accountId: 1, symbol: 1 }, { unique: true });

module.exports = mongoose.model('Position', positionSchema);