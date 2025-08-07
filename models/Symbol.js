const mongoose = require('mongoose');

const symbolSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  symbolId: {
    type: Number,
    required: true,
    unique: true
  },
  
  // Basic info
  description: String,
  securityType: String,
  listingExchange: String,
  currency: String,
  isTradable: Boolean,
  isQuotable: Boolean,
  
  // Market data
  prevDayClosePrice: Number,
  highPrice52: Number,
  lowPrice52: Number,
  averageVol3Months: Number,
  averageVol20Days: Number,
  outstandingShares: Number,
  marketCap: Number,
  
  // Dividend info
  dividend: Number,
  yield: Number,
  exDate: Date,
  dividendDate: Date,
  dividendFrequency: String, // Annual, Quarterly, Monthly
  
  // Financial metrics
  eps: Number,
  pe: Number,
  beta: Number,
  
  // Options info
  hasOptions: Boolean,
  optionType: String,
  optionRoot: String,
  
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Symbol', symbolSchema);