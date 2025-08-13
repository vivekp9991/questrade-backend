/**
 * DataSync Service Configuration
 * Centralized configuration for all sync operations
 */

module.exports = {
  // Sync operation intervals (in milliseconds)
  SYNC_INTERVALS: {
    ACCOUNTS: 30 * 60 * 1000,      // 30 minutes
    POSITIONS: 15 * 60 * 1000,     // 15 minutes  
    ACTIVITIES: 60 * 60 * 1000,    // 1 hour
    DIVIDENDS: 24 * 60 * 60 * 1000, // 24 hours
    MARKET_DATA: 5 * 60 * 1000,    // 5 minutes
    FULL_SYNC: 6 * 60 * 60 * 1000  // 6 hours
  },

  // Batch processing sizes
  BATCH_SIZES: {
    ACTIVITIES: 100,
    POSITIONS: 50,
    ACCOUNTS: 20,
    DIVIDENDS: 25,
    SNAPSHOTS: 10
  },

  // Retry configuration
  RETRY_CONFIG: {
    MAX_RETRIES: 3,
    BACKOFF_MULTIPLIER: 2,
    INITIAL_DELAY: 1000,
    MAX_DELAY: 30000
  },

  // Cache TTL settings (in milliseconds)
  CACHE_TTL: {
    MARKET_DATA: 5 * 60 * 1000,      // 5 minutes
    ACCOUNT_DATA: 10 * 60 * 1000,    // 10 minutes
    PORTFOLIO_SNAPSHOT: 30 * 60 * 1000, // 30 minutes
    DIVIDEND_DATA: 60 * 60 * 1000,   // 1 hour
    SECTOR_MAPPING: 24 * 60 * 60 * 1000 // 24 hours
  },

  // Rate limiting
  RATE_LIMITS: {
    REQUESTS_PER_MINUTE: 60,
    REQUESTS_PER_HOUR: 1000,
    CONCURRENT_REQUESTS: 5
  },

  // Data validation rules
  VALIDATION: {
    MIN_ACCOUNT_VALUE: 0,
    MAX_ACCOUNT_VALUE: 1000000000, // $1B
    MIN_POSITION_QUANTITY: 0,
    MAX_SYMBOL_LENGTH: 10,
    REQUIRED_ACCOUNT_FIELDS: ['accountId', 'accountType', 'totalValue'],
    REQUIRED_POSITION_FIELDS: ['symbol', 'quantity', 'marketValue']
  },

  // Sync status timeouts
  TIMEOUTS: {
    SYNC_OPERATION: 5 * 60 * 1000,   // 5 minutes
    API_REQUEST: 30 * 1000,          // 30 seconds
    DATABASE_QUERY: 15 * 1000,       // 15 seconds
    EXTERNAL_API: 45 * 1000          // 45 seconds
  },

  // Pagination settings
  PAGINATION: {
    DEFAULT_PAGE_SIZE: 50,
    MAX_PAGE_SIZE: 200,
    ACTIVITIES_PAGE_SIZE: 100,
    POSITIONS_PAGE_SIZE: 50
  },

  // Dividend calculation settings
  DIVIDEND_CONFIG: {
    LOOKBACK_MONTHS: 12,
    FORWARD_PROJECTION_MONTHS: 12,
    MIN_DIVIDEND_AMOUNT: 0.01,
    FREQUENCY_MAPPING: {
      'monthly': 12,
      'quarterly': 4,
      'semi-annually': 2,
      'annually': 1
    }
  },

  // Portfolio snapshot settings
  SNAPSHOT_CONFIG: {
    TOP_HOLDINGS_COUNT: 10,
    SECTOR_ALLOCATION_THRESHOLD: 1, // 1% minimum to include
    CLEANUP_DAYS: 30,
    MAX_SNAPSHOTS_PER_USER: 100
  },

  // Error handling
  ERROR_HANDLING: {
    LOG_LEVEL: process.env.NODE_ENV === 'production' ? 'error' : 'debug',
    RETRY_ON_ERRORS: [
      'NETWORK_ERROR',
      'RATE_LIMITED', 
      'TEMPORARY_UNAVAILABLE'
    ],
    FATAL_ERRORS: [
      'INVALID_TOKEN',
      'UNAUTHORIZED',
      'ACCOUNT_SUSPENDED'
    ]
  },

  // Environment-specific settings
  ENVIRONMENT: {
    DEVELOPMENT: {
      SYNC_INTERVALS: {
        ACCOUNTS: 5 * 60 * 1000,     // 5 minutes (faster for dev)
        POSITIONS: 3 * 60 * 1000,    // 3 minutes
        ACTIVITIES: 10 * 60 * 1000,  // 10 minutes
        DIVIDENDS: 60 * 60 * 1000    // 1 hour
      },
      ENABLE_DETAILED_LOGGING: true,
      MOCK_API_CALLS: false
    },
    
    PRODUCTION: {
      ENABLE_DETAILED_LOGGING: false,
      STRICT_VALIDATION: true,
      PERFORMANCE_MONITORING: true
    },

    TEST: {
      SYNC_INTERVALS: {
        ACCOUNTS: 1000,              // 1 second
        POSITIONS: 1000,
        ACTIVITIES: 2000,
        DIVIDENDS: 5000
      },
      MOCK_API_CALLS: true,
      DISABLE_EXTERNAL_CALLS: true
    }
  },

  // Feature flags
  FEATURES: {
    ENABLE_DIVIDEND_CALCULATION: true,
    ENABLE_PORTFOLIO_SNAPSHOTS: true,
    ENABLE_SECTOR_ALLOCATION: true,
    ENABLE_PERFORMANCE_TRACKING: true,
    ENABLE_AUTOMATIC_CLEANUP: true,
    ENABLE_CONCURRENT_SYNC: true,
    ENABLE_INCREMENTAL_SYNC: true
  },

  // Database settings
  DATABASE: {
    TRANSACTION_TIMEOUT: 30000,      // 30 seconds
    BULK_INSERT_BATCH_SIZE: 1000,
    CONNECTION_POOL_SIZE: 10,
    QUERY_TIMEOUT: 15000
  },

  // Monitoring and alerts
  MONITORING: {
    SYNC_DURATION_THRESHOLD: 5 * 60 * 1000,  // 5 minutes
    ERROR_RATE_THRESHOLD: 0.05,               // 5%
    MEMORY_USAGE_THRESHOLD: 500 * 1024 * 1024, // 500MB
    ALERT_ON_CONSECUTIVE_FAILURES: 3
  }
};

// Environment-specific overrides
const currentEnv = process.env.NODE_ENV || 'development';
if (module.exports.ENVIRONMENT[currentEnv.toUpperCase()]) {
  Object.assign(module.exports, module.exports.ENVIRONMENT[currentEnv.toUpperCase()]);
}