// models/Account.js
const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    unique: true
  },
  personName: {
    type: String,
    required: true,
    index: true
  },
  type: String,
  number: String,
  status: String,
  isPrimary: Boolean,
  isBilling: Boolean,
  clientAccountType: String,
  
  // Display information
  displayName: String, // Custom name for the account
  nickname: String,    // Short nickname
  
  // Balances
  balances: {
    perCurrencyBalances: [{
      currency: String,
      cash: Number,
      marketValue: Number,
      totalEquity: Number,
      buyingPower: Number,
      maintenanceExcess: Number,
      isRealTime: Boolean
    }],
    combinedBalances: {
      currency: String,
      cash: Number,
      marketValue: Number,
      totalEquity: Number,
      buyingPower: Number,
      maintenanceExcess: Number,
      isRealTime: Boolean
    },
    lastUpdated: Date
  },
  
  // Sync tracking
  syncedAt: {
    type: Date,
    default: Date.now
  },
  lastSyncError: String,
  syncErrorCount: {
    type: Number,
    default: 0
  },
  
  // Account statistics
  numberOfPositions: {
    type: Number,
    default: 0
  },
  totalInvestment: {
    type: Number,
    default: 0
  },
  currentValue: {
    type: Number,
    default: 0
  },
  dayPnl: {
    type: Number,
    default: 0
  },
  openPnl: {
    type: Number,
    default: 0
  },
  closedPnl: {
    type: Number,
    default: 0
  },
  totalPnl: {
    type: Number,
    default: 0
  },
  netDeposits: {
    type: Number,
    default: 0
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
accountSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Compound indexes for efficient queries
accountSchema.index({ personName: 1, accountId: 1 });
accountSchema.index({ personName: 1, type: 1 });

module.exports = mongoose.model('Account', accountSchema);