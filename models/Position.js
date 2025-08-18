// models/Position.js - FIXED VERSION - Enhanced Position model with proper dividend fields
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
  
  // FIXED: Store annual dividendPerShare at position level (calculated from frequency)
  dividendPerShare: {
    type: Number,
    default: 0,
    description: 'Annual dividend per share (calculated from frequency)'
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
  
  // FIXED: Enhanced dividend tracking with proper yield on cost
  dividendData: {
    totalReceived: {
      type: Number,
      default: 0,
      description: 'Total dividends actually received from activities'
    },
    lastDividendAmount: {
      type: Number,
      default: 0
    },
    lastDividendDate: Date,
    dividendReturnPercent: {
      type: Number,
      default: 0,
      description: 'Total dividends received as % of total cost'
    },
    yieldOnCost: {
      type: Number,
      default: 0,
      description: 'Annual dividend per share / average cost per share * 100'
    },
    dividendAdjustedCost: Number,
    dividendAdjustedCostPerShare: Number,
    monthlyDividend: {
      type: Number,
      default: 0,
      description: 'Projected monthly dividend for entire position'
    },
    monthlyDividendPerShare: {
      type: Number,
      default: 0,
      description: 'Projected monthly dividend per share'
    },
    annualDividend: {
      type: Number,
      default: 0,
      description: 'Projected annual dividend for entire position'
    },
    annualDividendPerShare: {
      type: Number,
      default: 0,
      description: 'Projected annual dividend per share'
    },
    dividendFrequency: {
      type: Number,
      default: 0,
      description: 'Number of dividend payments per year (12=monthly, 4=quarterly, etc.)'
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

// FIXED: Virtual property to calculate portfolio yield on cost contribution
positionSchema.virtual('portfolioYieldContribution').get(function() {
  if (!this.totalCost || !this.dividendData?.annualDividend) return 0;
  return {
    totalCost: this.totalCost,
    annualDividend: this.dividendData.annualDividend,
    yieldOnCost: this.dividendData.yieldOnCost
  };
});

// FIXED: Method to validate dividend calculations
positionSchema.methods.validateDividendCalculations = function() {
  const errors = [];
  
  if (this.isDividendStock) {
    // Check if yield on cost is calculated when there should be dividends
    if (this.dividendData?.annualDividend > 0 && this.dividendData?.yieldOnCost === 0) {
      errors.push('Missing yield on cost calculation for dividend stock');
    }
    
    // Check if annual dividend per share matches dividendPerShare
    if (this.dividendPerShare > 0 && this.dividendData?.annualDividendPerShare > 0) {
      const diff = Math.abs(this.dividendPerShare - this.dividendData.annualDividendPerShare);
      if (diff > 0.01) { // Allow small rounding differences
        errors.push(`Dividend per share mismatch: ${this.dividendPerShare} vs ${this.dividendData.annualDividendPerShare}`);
      }
    }
    
    // Check yield on cost calculation
    if (this.averageEntryPrice > 0 && this.dividendData?.annualDividendPerShare > 0) {
      const expectedYoC = (this.dividendData.annualDividendPerShare / this.averageEntryPrice) * 100;
      const actualYoC = this.dividendData.yieldOnCost || 0;
      const diff = Math.abs(expectedYoC - actualYoC);
      if (diff > 0.1) { // Allow small rounding differences
        errors.push(`Yield on cost calculation error: expected ${expectedYoC.toFixed(2)}%, got ${actualYoC.toFixed(2)}%`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// FIXED: Static method to calculate portfolio-wide yield on cost
positionSchema.statics.calculatePortfolioYieldOnCost = async function(query = {}) {
  const positions = await this.find(query);
  
  let totalCost = 0;
  let totalAnnualDividend = 0;
  let dividendStockCount = 0;
  
  positions.forEach(position => {
    totalCost += position.totalCost || 0;
    
    if (position.dividendData?.annualDividend > 0) {
      totalAnnualDividend += position.dividendData.annualDividend;
      dividendStockCount++;
    }
  });
  
  const portfolioYieldOnCost = totalCost > 0 ? (totalAnnualDividend / totalCost) * 100 : 0;
  
  return {
    portfolioYieldOnCost,
    totalCost,
    totalAnnualDividend,
    dividendStockCount,
    totalPositions: positions.length
  };
};

// FIXED: Static method to get dividend summary
positionSchema.statics.getDividendSummary = async function(query = {}) {
  const positions = await this.find(query);
  
  const summary = {
    totalDividendsReceived: 0,
    totalAnnualDividend: 0,
    totalCost: 0,
    portfolioYieldOnCost: 0,
    dividendStocks: 0,
    topPerformers: []
  };
  
  const dividendPositions = [];
  
  positions.forEach(position => {
    summary.totalCost += position.totalCost || 0;
    
    if (position.dividendData) {
      summary.totalDividendsReceived += position.dividendData.totalReceived || 0;
      summary.totalAnnualDividend += position.dividendData.annualDividend || 0;
      
      if (position.dividendData.annualDividend > 0) {
        summary.dividendStocks++;
        dividendPositions.push({
          symbol: position.symbol,
          yieldOnCost: position.dividendData.yieldOnCost || 0,
          annualDividend: position.dividendData.annualDividend || 0,
          totalCost: position.totalCost || 0
        });
      }
    }
  });
  
  summary.portfolioYieldOnCost = summary.totalCost > 0 ? 
    (summary.totalAnnualDividend / summary.totalCost) * 100 : 0;
  
  summary.topPerformers = dividendPositions
    .sort((a, b) => b.yieldOnCost - a.yieldOnCost)
    .slice(0, 10);
  
  return summary;
};

// Compound indexes for efficient queries
positionSchema.index({ accountId: 1, symbol: 1 }, { unique: true });
positionSchema.index({ personName: 1, symbol: 1 });
positionSchema.index({ personName: 1, accountId: 1 });
positionSchema.index({ symbol: 1, isDividendStock: 1 });
positionSchema.index({ isAggregated: 1, personName: 1 });
positionSchema.index({ 'dividendData.yieldOnCost': 1 }); // FIXED: Index for yield on cost queries
positionSchema.index({ 'dividendData.annualDividend': 1 }); // FIXED: Index for dividend queries

module.exports = mongoose.model('Position', positionSchema);