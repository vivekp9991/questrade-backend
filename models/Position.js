// models/Position.js
const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    index: true
  },
  personName: {
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
    dividendAdjustedCostPerShare: Number,
    monthlyDividend: Number,
    monthlyDividendPerShare: Number,
    annualDividend: Number,
    annualDividendPerShare: Number,
    dividendFrequency: Number
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
  
  // Aggregation support
  isAggregated: {
    type: Boolean,
    default: false
  },
  sourceAccounts: [String], // List of account IDs that contributed to this aggregated position
  
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

// Update the updatedAt field before saving
positionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Compound indexes for efficient queries
positionSchema.index({ accountId: 1, symbol: 1 }, { unique: true });
positionSchema.index({ personName: 1, symbol: 1 });
positionSchema.index({ personName: 1, accountId: 1 });

module.exports = mongoose.model('Position', positionSchema);