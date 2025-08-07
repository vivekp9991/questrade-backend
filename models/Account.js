const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    unique: true
  },
  type: String,
  number: String,
  status: String,
  isPrimary: Boolean,
  isBilling: Boolean,
  clientAccountType: String,
  
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

module.exports = mongoose.model('Account', accountSchema);