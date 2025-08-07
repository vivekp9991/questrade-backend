const mongoose = require('mongoose');

const portfolioSnapshotSchema = new mongoose.Schema({
  accountId: String,
  date: {
    type: Date,
    required: true,
    index: true
  },
  
  // Portfolio metrics
  totalInvestment: Number,
  currentValue: Number,
  totalReturnValue: Number,
  totalReturnPercent: Number,
  unrealizedPnl: Number,
  realizedPnl: Number,
  
  // Dividend metrics
  totalDividends: Number,
  monthlyDividendIncome: Number,
  annualProjectedDividend: Number,
  averageYieldPercent: Number,
  yieldOnCostPercent: Number,
  
  // Position counts
  numberOfPositions: Number,
  numberOfDividendStocks: Number,
  
  // Asset allocation
  assetAllocation: [{
    category: String,
    value: Number,
    percentage: Number
  }],
  
  // Sector allocation
  sectorAllocation: [{
    sector: String,
    value: Number,
    percentage: Number
  }],
  
  // Currency breakdown
  currencyBreakdown: [{
    currency: String,
    value: Number,
    percentage: Number
  }],
  
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient historical queries
portfolioSnapshotSchema.index({ accountId: 1, date: -1 });
