// models/Position.js - Updated with comprehensive dividend field definitions
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Sub-schema for dividend data
const DividendDataSchema = new Schema({
  // Core dividend amounts
  totalReceived: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Total dividends received for this position'
  },
  annualDividend: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Expected annual dividend amount for current shares'
  },
  monthlyDividend: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Expected monthly dividend amount'
  },
  quarterlyDividend: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Expected quarterly dividend amount'
  },
  
  // Per-share dividend amounts
  annualDividendPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Annual dividend per share'
  },
  monthlyDividendPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Monthly dividend per share'
  },
  quarterlyDividendPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Quarterly dividend per share'
  },
  
  // Last dividend information
  lastDividendAmount: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Amount of the last dividend payment'
  },
  lastDividendDate: {
    type: Date,
    description: 'Date of the last dividend payment'
  },
  lastDividendPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Per-share amount of the last dividend'
  },
  
  // Next dividend information
  nextDividendDate: {
    type: Date,
    description: 'Expected date of next dividend payment'
  },
  nextDividendAmount: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Expected amount of next dividend payment'
  },
  exDividendDate: {
    type: Date,
    description: 'Next ex-dividend date'
  },
  
  // Yield calculations
  yieldOnCost: {
    type: Number,
    default: 0,
    min: 0,
    max: 1000, // Cap at 1000% to catch calculation errors
    description: 'Yield on cost percentage based on original purchase price'
  },
  currentYield: {
    type: Number,
    default: 0,
    min: 0,
    max: 100, // Cap at 100% for current yield
    description: 'Current yield percentage based on current market price'
  },
  dividendReturnPercent: {
    type: Number,
    default: 0,
    description: 'Total dividend return as percentage of original investment'
  },
  
  // Dividend-adjusted cost basis
  dividendAdjustedCost: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Total cost basis adjusted for dividends received'
  },
  dividendAdjustedCostPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Cost per share adjusted for dividends received'
  },
  dividendAdjustedYield: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Yield based on dividend-adjusted cost basis'
  },
  
  // Dividend frequency and timing
  dividendFrequency: {
    type: Number,
    default: 0,
    min: 0,
    max: 12,
    description: 'Number of dividend payments per year (1=annual, 4=quarterly, 12=monthly)'
  },
  dividendSchedule: {
    type: String,
    enum: ['monthly', 'quarterly', 'semi-annual', 'annual', 'irregular', 'unknown'],
    default: 'unknown',
    description: 'Dividend payment schedule'
  },
  
  // Dividend growth and history
  dividendGrowthRate: {
    type: Number,
    default: 0,
    description: 'Annual dividend growth rate percentage'
  },
  dividendHistory: [{
    date: Date,
    amount: Number,
    perShare: Number,
    type: {
      type: String,
      enum: ['regular', 'special', 'return_of_capital', 'stock_dividend'],
      default: 'regular'
    }
  }],
  
  // Calculation metadata
  lastCalculated: {
    type: Date,
    default: Date.now,
    description: 'When dividend calculations were last updated'
  },
  calculationMethod: {
    type: String,
    enum: ['activity_based', 'symbol_based', 'hybrid', 'manual'],
    default: 'activity_based',
    description: 'Method used to calculate dividend data'
  },
  dataSource: {
    type: String,
    enum: ['questrade', 'yahoo', 'symbol_table', 'manual', 'calculated'],
    default: 'calculated',
    description: 'Source of dividend data'
  }
}, {
  _id: false // Don't create separate _id for subdocument
});

// Sub-schema for market data
const MarketDataSchema = new Schema({
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  change: {
    type: Number,
    default: 0
  },
  changePercent: {
    type: Number,
    default: 0
  },
  volume: {
    type: Number,
    default: 0,
    min: 0
  },
  marketCap: {
    type: Number,
    default: 0,
    min: 0
  },
  peRatio: {
    type: Number,
    default: 0
  },
  dividend: {
    type: Number,
    default: 0,
    min: 0
  },
  yield: {
    type: Number,
    default: 0,
    min: 0
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  _id: false
});

// Sub-schema for balance information
const BalanceSchema = new Schema({
  openQuantity: {
    type: Number,
    default: 0,
    description: 'Current open position quantity'
  },
  closedQuantity: {
    type: Number,
    default: 0,
    description: 'Total closed position quantity'
  },
  currentMarketValue: {
    type: Number,
    default: 0,
    description: 'Current market value of open position'
  },
  totalCost: {
    type: Number,
    default: 0,
    description: 'Total cost basis of open position'
  },
  averageEntryPrice: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Average entry price per share'
  },
  currentPrice: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Current market price per share'
  }
}, {
  _id: false
});

// Main Position Schema
const PositionSchema = new Schema({
  // Core identification - FIXED: positionId is NOT required, can be generated
  positionId: {
    type: String,
    // REMOVED required: true - this field can be auto-generated or optional
    index: true,
    description: 'Unique position identifier from broker or generated'
  },
  accountId: {
    type: String,
    required: true,
    index: true,
    description: 'Account identifier'
  },
  symbolId: {
    type: String,
    required: true,
    index: true,
    description: 'Symbol identifier'
  },
  symbol: {
    type: String,
    required: true,
    index: true,
    uppercase: true,
    description: 'Trading symbol (e.g., AAPL, TD.TO)'
  },
  personName: {
    type: String,
    required: true,
    index: true,
    description: 'Person who owns this position'
  },
  
  // Position quantities and values
  openQuantity: {
    type: Number,
    default: 0,
    description: 'Current open position quantity'
  },
  closedQuantity: {
    type: Number,
    default: 0,
    description: 'Total closed position quantity'
  },
  currentMarketValue: {
    type: Number,
    default: 0,
    description: 'Current market value of open position'
  },
  totalCost: {
    type: Number,
    default: 0,
    description: 'Total cost basis of open position'
  },
  averageEntryPrice: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Average entry price per share'
  },
  currentPrice: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Current market price per share'
  },
  
  // P&L calculations
  openPnl: {
    type: Number,
    default: 0,
    description: 'Unrealized profit/loss on open position'
  },
  dayPnl: {
    type: Number,
    default: 0,
    description: 'Day profit/loss'
  },
  closedPnl: {
    type: Number,
    default: 0,
    description: 'Realized profit/loss from closed positions'
  },
  totalReturnValue: {
    type: Number,
    default: 0,
    description: 'Total return including dividends'
  },
  totalReturnPercent: {
    type: Number,
    default: 0,
    description: 'Total return percentage including dividends'
  },
  capitalGainValue: {
    type: Number,
    default: 0,
    description: 'Capital gain/loss value (excluding dividends)'
  },
  capitalGainPercent: {
    type: Number,
    default: 0,
    description: 'Capital gain/loss percentage (excluding dividends)'
  },
  
  // Dividend-specific fields (top-level for easy access)
  dividendPerShare: {
    type: Number,
    default: 0,
    min: 0,
    description: 'Annual dividend per share (most commonly used)'
  },
  currentYield: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
    description: 'Current dividend yield percentage'
  },
  isDividendStock: {
    type: Boolean,
    default: false,
    index: true,
    description: 'Whether this stock pays dividends'
  },
  
  // Comprehensive dividend data
  dividendData: {
    type: DividendDataSchema,
    default: () => ({}),
    description: 'Comprehensive dividend information'
  },
  
  // Market data
  marketData: {
    type: MarketDataSchema,
    default: () => ({}),
    description: 'Current market data'
  },
  
  // Symbol classification
  industrySector: {
    type: String,
    index: true,
    description: 'Industry sector classification'
  },
  industryGroup: {
    type: String,
    description: 'Industry group classification'
  },
  industrySubGroup: {
    type: String,
    description: 'Industry sub-group classification'
  },
  // FIXED: securityType enum now includes both cases and normalizes input
  securityType: {
    type: String,
    enum: ['stock', 'etf', 'mutual_fund', 'bond', 'option', 'other', 
           'Stock', 'ETF', 'Mutual_Fund', 'Bond', 'Option', 'Other'], // Added capitalized versions
    default: 'stock',
    lowercase: true, // Automatically convert to lowercase before saving
    description: 'Type of security'
  },
  currency: {
    type: String,
    default: 'CAD',
    uppercase: true,
    description: 'Currency of the position'
  },
  exchange: {
    type: String,
    uppercase: true,
    description: 'Exchange where security is traded'
  },
  
  // Aggregation metadata (for aggregated positions)
  isAggregated: {
    type: Boolean,
    default: false,
    index: true,
    description: 'Whether this is an aggregated position across multiple accounts'
  },
  sourceAccounts: [{
    type: String,
    description: 'Source account IDs for aggregated positions'
  }],
  numberOfAccounts: {
    type: Number,
    default: 1,
    min: 1,
    description: 'Number of accounts contributing to this position'
  },
  individualPositions: [{
    accountId: String,
    accountName: String,
    accountType: String,
    shares: Number,
    avgCost: Number,
    marketValue: Number,
    totalCost: Number,
    openPnl: Number,
    dividendsReceived: Number,
    annualDividend: Number
  }],
  
  // Data synchronization
  syncedAt: {
    type: Date,
    default: Date.now,
    index: true,
    description: 'When this position was last synced from broker'
  },
  dataSource: {
    type: String,
    enum: ['questrade', 'manual', 'calculated', 'aggregated'],
    default: 'questrade',
    description: 'Source of position data'
  },
  lastDividendCalculation: {
    type: Date,
    description: 'When dividend calculations were last performed'
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  collection: 'positions'
});

// Pre-save middleware to handle field initialization and normalization
PositionSchema.pre('save', function(next) {
  // FIXED: Generate positionId if not provided
  if (!this.positionId) {
    // Generate a unique positionId based on account and symbol
    this.positionId = `${this.accountId}_${this.symbolId}_${Date.now()}`;
  }
  
  // FIXED: Normalize securityType to lowercase
  if (this.securityType) {
    this.securityType = this.securityType.toLowerCase();
  }
  
  // Ensure dividend calculations are current
  if (this.isModified('openQuantity') || this.isModified('dividendData') || this.isModified('averageEntryPrice')) {
    this.calculateTotalReturn();
  }
  
  // Update isDividendStock flag
  if (this.isModified('dividendData') || this.isModified('dividendPerShare')) {
    this.isDividendStock = (this.dividendData?.annualDividend > 0) || 
                          (this.dividendData?.totalReceived > 0) || 
                          (this.dividendPerShare > 0);
  }
  
  // Update timestamps
  this.updatedAt = new Date();
  
  next();
});

// Pre-validate middleware to handle field normalization before validation
PositionSchema.pre('validate', function(next) {
  // FIXED: Generate positionId if missing before validation
  if (!this.positionId) {
    this.positionId = `${this.accountId}_${this.symbolId}_${Date.now()}`;
  }
  
  // FIXED: Normalize securityType before validation
  if (this.securityType) {
    const normalizedType = this.securityType.toLowerCase();
    // Map common variations to valid enum values
    const typeMapping = {
      'stock': 'stock',
      'stocks': 'stock',
      'equity': 'stock',
      'etf': 'etf',
      'etfs': 'etf',
      'mutual_fund': 'mutual_fund',
      'mutual fund': 'mutual_fund',
      'mutualfund': 'mutual_fund',
      'bond': 'bond',
      'bonds': 'bond',
      'option': 'option',
      'options': 'option',
      'other': 'other'
    };
    
    this.securityType = typeMapping[normalizedType] || 'other';
  }
  
  next();
});

// Indexes for performance
PositionSchema.index({ accountId: 1, symbol: 1 });
PositionSchema.index({ personName: 1, symbol: 1 });
PositionSchema.index({ symbol: 1, syncedAt: -1 });
PositionSchema.index({ isDividendStock: 1, symbol: 1 });
PositionSchema.index({ 'dividendData.lastDividendDate': -1 });
PositionSchema.index({ isAggregated: 1, symbol: 1 });
// FIXED: Compound index for positionId queries
PositionSchema.index({ positionId: 1, accountId: 1, personName: 1 });

// Virtual fields
PositionSchema.virtual('marketValueCAD').get(function() {
  // Could include currency conversion logic here
  return this.currentMarketValue;
});

PositionSchema.virtual('totalCostCAD').get(function() {
  // Could include currency conversion logic here
  return this.totalCost;
});

PositionSchema.virtual('dividendYieldFormatted').get(function() {
  return `${(this.currentYield || 0).toFixed(2)}%`;
});

PositionSchema.virtual('totalReturnFormatted').get(function() {
  return `${(this.totalReturnPercent || 0).toFixed(2)}%`;
});

// Instance methods
PositionSchema.methods.calculateTotalReturn = function() {
  const capitalGain = this.openPnl || 0;
  const dividendReturn = this.dividendData?.totalReceived || 0;
  const totalReturn = capitalGain + dividendReturn;
  const totalCost = this.totalCost || 0;
  
  this.totalReturnValue = totalReturn;
  this.totalReturnPercent = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;
  this.capitalGainValue = capitalGain;
  this.capitalGainPercent = totalCost > 0 ? (capitalGain / totalCost) * 100 : 0;
  
  return {
    totalReturnValue: this.totalReturnValue,
    totalReturnPercent: this.totalReturnPercent,
    capitalGainValue: this.capitalGainValue,
    capitalGainPercent: this.capitalGainPercent,
    dividendReturnValue: dividendReturn,
    dividendReturnPercent: totalCost > 0 ? (dividendReturn / totalCost) * 100 : 0
  };
};

PositionSchema.methods.updateDividendMetrics = function(dividendData) {
  if (!dividendData) return;
  
  // Update main dividend fields
  this.dividendPerShare = dividendData.annualDividendPerShare || dividendData.dividendPerShare || 0;
  this.currentYield = dividendData.currentYield || 0;
  this.isDividendStock = dividendData.annualDividend > 0 || dividendData.totalReceived > 0 || this.dividendPerShare > 0;
  
  // Update comprehensive dividend data
  this.dividendData = {
    ...this.dividendData.toObject(),
    ...dividendData,
    lastCalculated: new Date()
  };
  
  this.lastDividendCalculation = new Date();
  
  // Recalculate total returns
  this.calculateTotalReturn();
};

PositionSchema.methods.isDividendEligible = function() {
  return this.isDividendStock && 
         this.openQuantity > 0 && 
         (this.dividendData?.annualDividendPerShare > 0 || this.dividendPerShare > 0);
};

PositionSchema.methods.getMonthlyDividendIncome = function() {
  const annualDividend = this.dividendData?.annualDividend || 0;
  return annualDividend / 12;
};

PositionSchema.methods.getQuarterlyDividendIncome = function() {
  const annualDividend = this.dividendData?.annualDividend || 0;
  return annualDividend / 4;
};

// Static methods
PositionSchema.statics.findDividendStocks = function(query = {}) {
  return this.find({
    ...query,
    isDividendStock: true,
    openQuantity: { $gt: 0 }
  });
};

PositionSchema.statics.findByPersonAndSymbol = function(personName, symbol) {
  return this.find({ personName, symbol, openQuantity: { $gt: 0 } });
};

PositionSchema.statics.getPortfolioSummary = function(personName) {
  return this.aggregate([
    { $match: { personName, openQuantity: { $gt: 0 } } },
    {
      $group: {
        _id: null,
        totalValue: { $sum: '$currentMarketValue' },
        totalCost: { $sum: '$totalCost' },
        totalDividends: { $sum: '$dividendData.totalReceived' },
        totalAnnualDividend: { $sum: '$dividendData.annualDividend' },
        positionCount: { $sum: 1 },
        dividendStockCount: {
          $sum: { $cond: ['$isDividendStock', 1, 0] }
        }
      }
    }
  ]);
};

// FIXED: Static method to handle updates without positionId
PositionSchema.statics.findOneAndUpdateSafe = function(filter, update, options) {
  // If updating and positionId is missing, generate one
  if (!filter.positionId && filter.accountId && filter.symbolId) {
    filter.positionId = `${filter.accountId}_${filter.symbolId}_${Date.now()}`;
  }
  
  // Ensure securityType is normalized in updates
  if (update.$set && update.$set.securityType) {
    update.$set.securityType = update.$set.securityType.toLowerCase();
  }
  if (update.securityType) {
    update.securityType = update.securityType.toLowerCase();
  }
  
  return this.findOneAndUpdate(filter, update, options);
};

// Post-save middleware for logging
PositionSchema.post('save', function(doc) {
  if (doc.isDividendStock && doc.dividendData?.annualDividend > 0) {
    console.log(`Updated dividend stock ${doc.symbol}: Annual dividend $${doc.dividendData.annualDividend}, Yield ${doc.currentYield}%`);
  }
});

module.exports = mongoose.model('Position', PositionSchema);