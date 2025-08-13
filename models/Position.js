// models/Position.js - Updated to ensure dividendPerShare is properly stored
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
  
  // IMPORTANT: Store dividendPerShare at position level
  dividendPerShare: {
    type: Number,
    default: 0
  },
  
  // Additional symbol information stored at position level
  industrySector: String,
  industryGroup: String,
  currency: String,
  securityType: String,
  isDividendStock: {
    type: Boolean,
    default: false
  },
  
  // Dividend tracking
  dividendData: {
    totalReceived: {
      type: Number,
      default: 0
    },
    lastDividendAmount: {
      type: Number,
      default: 0
    },
    lastDividendDate: Date,
    dividendReturnPercent: {
      type: Number,
      default: 0
    },
    yieldOnCost: {
      type: Number,
      default: 0
    },
    dividendAdjustedCost: Number,
    dividendAdjustedCostPerShare: Number,
    monthlyDividend: {
      type: Number,
      default: 0
    },
    monthlyDividendPerShare: {
      type: Number,
      default: 0
    },
    annualDividend: {
      type: Number,
      default: 0
    },
    annualDividendPerShare: {
      type: Number,
      default: 0
    },
    dividendFrequency: {
      type: Number,
      default: 0
    }
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
  numberOfAccounts: Number,
  individualPositions: [{
    accountId: String,
    accountName: String,
    accountType: String,
    shares: Number,
    avgCost: Number,
    marketValue: Number,
    totalCost: Number,
    openPnl: Number
  }],
  
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
positionSchema.index({ symbol: 1, isDividendStock: 1 });
positionSchema.index({ isAggregated: 1, personName: 1 });

module.exports = mongoose.model('Position', positionSchema);