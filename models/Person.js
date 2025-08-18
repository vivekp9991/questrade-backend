// models/Person.js - ENHANCED VERSION - Portfolio calculation preferences
const mongoose = require('mongoose');

const personSchema = new mongoose.Schema({
  personName: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    trim: true
  },
  email: String,
  phoneNumber: String,
  
  // Settings and preferences
  preferences: {
    defaultView: {
      type: String,
      enum: ['all', 'person', 'account'],
      default: 'person'
    },
    currency: {
      type: String,
      default: 'CAD'
    },
    notifications: {
      enabled: {
        type: Boolean,
        default: true
      },
      dividendAlerts: {
        type: Boolean,
        default: true
      },
      syncErrors: {
        type: Boolean,
        default: true
      }
    },
    // ADDED: Portfolio calculation preferences
    portfolio: {
      yieldOnCostDividendOnly: {
        type: Boolean,
        default: true,
        description: 'Calculate yield on cost using only dividend-paying stocks'
      },
      includeClosedPositions: {
        type: Boolean,
        default: false,
        description: 'Include closed positions in portfolio calculations'
      },
      // Future extension possibilities
      currencyConversion: {
        type: Boolean,
        default: true,
        description: 'Convert multi-currency positions to base currency'
      }
    }
  },
  
  // Status tracking
  isActive: {
    type: Boolean,
    default: true
  },
  hasValidToken: {
    type: Boolean,
    default: false
  },
  lastTokenRefresh: Date,
  lastSuccessfulSync: Date,
  lastSyncError: String,
  
  // Statistics
  numberOfAccounts: {
    type: Number,
    default: 0
  },
  totalInvestment: {
    type: Number,
    default: 0
  },
  totalValue: {
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
personSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index for efficient queries
personSchema.index({ personName: 1, isActive: 1 });

// ADDED: Helper methods for portfolio preferences
personSchema.methods.getPortfolioPreferences = function() {
  return this.preferences?.portfolio || {
    yieldOnCostDividendOnly: true,
    includeClosedPositions: false,
    currencyConversion: true
  };
};

personSchema.methods.updatePortfolioPreferences = async function(newPreferences) {
  if (!this.preferences) {
    this.preferences = {};
  }
  if (!this.preferences.portfolio) {
    this.preferences.portfolio = {};
  }
  
  // Update only provided preferences
  Object.assign(this.preferences.portfolio, newPreferences);
  this.markModified('preferences.portfolio');
  return await this.save();
};

module.exports = mongoose.model('Person', personSchema);