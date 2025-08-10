// models/Activity.js
const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
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
  
  tradeDate: Date,
  transactionDate: Date,
  settlementDate: Date,
  action: String,
  symbol: String,
  symbolId: Number,
  description: String,
  currency: String,
  quantity: Number,
  price: Number,
  grossAmount: Number,
  commission: Number,
  netAmount: Number,
  type: {
    type: String,
    enum: [
      'Trade',      // Buy/Sell trades
      'Dividend',   // Dividend payments
      'Interest',   // Interest payments
      'Deposit',    // Money deposits
      'Withdrawal', // Money withdrawals
      'Transfer',   // Transfers between accounts
      'Fee',        // Account fees
      'Tax',        // Tax withholdings
      'FX',         // Foreign exchange
      'Other'       // Catch-all for unknown types
    ],
    default: 'Other',
    index: true
  },
  
  // Additional fields for dividends
  isDividend: Boolean,
  dividendPerShare: Number,
  
  // Raw type from Questrade (for debugging)
  rawType: String,
  
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient queries
activitySchema.index({ accountId: 1, type: 1, transactionDate: -1 });
activitySchema.index({ personName: 1, type: 1, transactionDate: -1 });
activitySchema.index({ symbol: 1, type: 1, transactionDate: -1 });
activitySchema.index({ personName: 1, symbol: 1, type: 1 });

module.exports = mongoose.model('Activity', activitySchema);