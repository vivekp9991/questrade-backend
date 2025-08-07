const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  accountId: {
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
    enum: ['Trade', 'Dividend', 'Interest', 'Deposit', 'Withdrawal', 'Transfer', 'Other'],
    index: true
  },
  
  // Additional fields for dividends
  isDividend: Boolean,
  dividendPerShare: Number,
  
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient queries
activitySchema.index({ accountId: 1, type: 1, transactionDate: -1 });
activitySchema.index({ symbol: 1, type: 1, transactionDate: -1 });

module.exports = mongoose.model('Activity', activitySchema);