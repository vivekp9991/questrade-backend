// models/Person.js
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

module.exports = mongoose.model('Person', personSchema);