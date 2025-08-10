// models/PortfolioSnapshot.js
const mongoose = require('mongoose');

const portfolioSnapshotSchema = new mongoose.Schema({
  accountId: String,
  personName: {
    type: String,
    index: true
  },
  viewMode: {
    type: String,
    enum: ['all', 'person', 'account'],
    default: 'account'
  },
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
  numberOfAccounts: Number, // For aggregated views
  
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
  
  // Person breakdown (for "all" view)
  personBreakdown: [{
    personName: String,
    value: Number,
    percentage: Number,
    numberOfPositions: Number
  }],
  
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient historical queries
portfolioSnapshotSchema.index({ accountId: 1, date: -1 });
portfolioSnapshotSchema.index({ personName: 1, date: -1 });
portfolioSnapshotSchema.index({ viewMode: 1, date: -1 });

module.exports = mongoose.model('PortfolioSnapshot', portfolioSnapshotSchema);