#!/usr/bin/env node

// scripts/recalculateDividends.js - Utility script to fix existing dividend data
const mongoose = require('mongoose');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Symbol = require('../models/Symbol');
const Account = require('../models/Account');
const Person = require('../models/Person');
const DividendCalculator = require('../services/dataSync/dividendCalculator');
const logger = require('../utils/logger');
require('dotenv').config();

class DividendRecalculator {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      batchSize: options.batchSize || 100,
      maxConcurrent: options.maxConcurrent || 5,
      forceRecalculate: options.forceRecalculate || false,
      personName: options.personName || null,
      symbol: options.symbol || null,
      accountId: options.accountId || null,
      onlyProblematic: options.onlyProblematic || false,
      verbose: options.verbose || false,
      backupBeforeRun: options.backupBeforeRun || true,
      ...options
    };
    
    this.stats = {
      total: 0,
      processed: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
      fixed: 0,
      created: 0,
      issues: []
    };
    
    this.dividendCalculator = new DividendCalculator();
  }

  async run() {
    try {
      console.log('🔄 Starting Dividend Recalculation Script');
      console.log(`📊 Mode: ${this.options.dryRun ? 'DRY RUN' : 'LIVE RUN'}`);
      console.log(`⚙️  Options:`, JSON.stringify(this.options, null, 2));
      
      // Connect to database
      await this.connectDatabase();
      
      // Create backup if requested
      if (this.options.backupBeforeRun && !this.options.dryRun) {
        await this.createBackup();
      }
      
      // Get positions to process
      const positions = await this.getPositionsToProcess();
      this.stats.total = positions.length;
      
      console.log(`📈 Found ${positions.length} positions to process`);
      
      if (positions.length === 0) {
        console.log('✅ No positions found to process');
        return this.stats;
      }
      
      // Process positions in batches
      await this.processPositionsInBatches(positions);
      
      // Generate summary report
      await this.generateReport();
      
      console.log('✅ Dividend recalculation completed');
      return this.stats;
      
    } catch (error) {
      console.error('❌ Error in dividend recalculation:', error);
      throw error;
    } finally {
      await mongoose.disconnect();
    }
  }

  async connectDatabase() {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/questrade_portfolio';
      await mongoose.connect(mongoUri);
      console.log('📊 Connected to MongoDB');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  async createBackup() {
    try {
      console.log('💾 Creating backup of positions collection...');
      const backupName = `positions_backup_${Date.now()}`;
      
      // Create backup collection
      await mongoose.connection.db.collection('positions').aggregate([
        { $out: backupName }
      ]).toArray();
      
      console.log(`✅ Backup created: ${backupName}`);
      this.backupCollectionName = backupName;
    } catch (error) {
      console.error('❌ Backup creation failed:', error);
      throw error;
    }
  }

  async getPositionsToProcess() {
    try {
      let query = { openQuantity: { $gt: 0 } };
      
      // Apply filters based on options
      if (this.options.personName) {
        query.personName = this.options.personName;
      }
      
      if (this.options.symbol) {
        query.symbol = this.options.symbol.toUpperCase();
      }
      
      if (this.options.accountId) {
        query.accountId = this.options.accountId;
      }
      
      if (this.options.onlyProblematic) {
        // Only process positions with potential issues
        query.$or = [
          { isDividendStock: true, 'dividendData.annualDividend': { $lte: 0 } },
          { isDividendStock: true, dividendPerShare: { $lte: 0 } },
          { 'dividendData.yieldOnCost': { $gt: 100 } }, // Unrealistic yield
          { 'dividendData.currentYield': { $gt: 50 } }, // Unrealistic current yield
          { dividendData: { $exists: false } },
          { 'dividendData.lastCalculated': { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, // Older than 7 days
          { $expr: { $gt: ['$dividendData.annualDividend', { $multiply: ['$currentMarketValue', 0.5] }] } } // Dividend > 50% of market value
        ];
      }
      
      if (!this.options.forceRecalculate) {
        // Skip recently calculated positions unless forced
        const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
        query.$or = query.$or || [];
        query.$or.push(
          { 'dividendData.lastCalculated': { $lt: cutoffDate } },
          { 'dividendData.lastCalculated': { $exists: false } }
        );
      }
      
      const positions = await Position.find(query)
        .sort({ symbol: 1, personName: 1, accountId: 1 })
        .lean();
      
      if (this.options.verbose) {
        console.log('🔍 Query used:', JSON.stringify(query, null, 2));
      }
      
      return positions;
    } catch (error) {
      console.error('❌ Error getting positions:', error);
      throw error;
    }
  }

  async processPositionsInBatches(positions) {
    const batches = this.chunkArray(positions, this.options.batchSize);
    
    console.log(`📦 Processing ${batches.length} batches of ${this.options.batchSize} positions each`);
    
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`\n🔄 Processing batch ${i + 1}/${batches.length} (${batch.length} positions)`);
      
      try {
        await this.processBatch(batch);
      } catch (error) {
        console.error(`❌ Error processing batch ${i + 1}:`, error);
        this.stats.errors += batch.length;
      }
      
      // Progress update
      const progress = ((i + 1) / batches.length * 100).toFixed(1);
      console.log(`📊 Progress: ${progress}% (${this.stats.processed}/${this.stats.total})`);
    }
  }

  async processBatch(batch) {
    const promises = batch.map(position => 
      this.processPosition(position).catch(error => {
        console.error(`❌ Error processing ${position.symbol}:`, error.message);
        this.stats.errors++;
        this.stats.issues.push({
          symbol: position.symbol,
          accountId: position.accountId,
          error: error.message
        });
      })
    );
    
    await Promise.all(promises);
  }

  async processPosition(position) {
    try {
      this.stats.processed++;
      
      if (this.options.verbose) {
        console.log(`🔍 Processing ${position.symbol} (${position.accountId})`);
      }
      
      // Get current position data
      const currentPosition = await Position.findById(position._id);
      if (!currentPosition) {
        this.stats.skipped++;
        return;
      }
      
      // Store original data for comparison
      const originalDividendData = JSON.parse(JSON.stringify(currentPosition.dividendData || {}));
      const originalIsDividendStock = currentPosition.isDividendStock;
      const originalDividendPerShare = currentPosition.dividendPerShare;
      
      // Detect and fix issues
      const issues = await this.detectIssues(currentPosition);
      
      if (issues.length > 0 && this.options.verbose) {
        console.log(`⚠️  Issues found for ${position.symbol}:`, issues);
      }
      
      // Recalculate dividend data
      const newDividendData = await this.recalculateDividendData(currentPosition);
      
      if (!newDividendData) {
        this.stats.skipped++;
        return;
      }
      
      // Update position with new dividend data
      currentPosition.updateDividendMetrics(newDividendData);
      
      // Check if data actually changed
      const hasChanges = this.hasSignificantChanges(originalDividendData, currentPosition.dividendData);
      
      if (!hasChanges && !this.options.forceRecalculate) {
        this.stats.skipped++;
        if (this.options.verbose) {
          console.log(`⏭️  Skipping ${position.symbol} - no significant changes`);
        }
        return;
      }
      
      // Validate the new data
      const validation = this.validateDividendData(currentPosition);
      if (!validation.isValid) {
        console.warn(`⚠️  Validation failed for ${position.symbol}:`, validation.errors);
        this.stats.issues.push({
          symbol: position.symbol,
          accountId: position.accountId,
          validation: validation.errors
        });
      }
      
      // Save or log changes
      if (this.options.dryRun) {
        console.log(`🔍 DRY RUN - Would update ${position.symbol}:`);
        console.log('  Original:', this.formatDividendSummary(originalDividendData));
        console.log('  New:', this.formatDividendSummary(currentPosition.dividendData));
        this.stats.updated++;
      } else {
        await currentPosition.save();
        this.stats.updated++;
        
        if (this.options.verbose) {
          console.log(`✅ Updated ${position.symbol}`);
        }
      }
      
      // Track fixes
      if (issues.length > 0) {
        this.stats.fixed++;
      }
      
    } catch (error) {
      console.error(`❌ Error processing position ${position.symbol}:`, error);
      this.stats.errors++;
      throw error;
    }
  }

  async recalculateDividendData(position) {
    try {
      // Method 1: Calculate from activities (most accurate)
      let dividendData = await this.calculateFromActivities(position);
      
      // Method 2: If no activity data, use symbol data
      if (!dividendData || dividendData.totalReceived === 0) {
        dividendData = await this.calculateFromSymbolData(position);
      }
      
      // Method 3: Fallback to API or manual calculation
      if (!dividendData) {
        dividendData = await this.calculateFromAPI(position);
      }
      
      return dividendData;
    } catch (error) {
      console.error(`Error recalculating dividend data for ${position.symbol}:`, error);
      return null;
    }
  }

  async calculateFromActivities(position) {
    try {
      const activities = await Activity.find({
        symbolId: position.symbolId,
        accountId: position.accountId,
        type: { $in: ['Dividend', 'Dividends'] }
      }).sort({ transactionDate: 1 });
      
      if (activities.length === 0) {
        return null;
      }
      
      // Get symbol info for additional data
      const symbol = await Symbol.findOne({ symbolId: position.symbolId });
      
      return await this.dividendCalculator.calculateDividendData(
        position.accountId,
        position.personName,
        position.symbolId,
        position.symbol,
        position.openQuantity,
        position.averageEntryPrice,
        symbol
      );
    } catch (error) {
      console.error(`Error calculating from activities for ${position.symbol}:`, error);
      return null;
    }
  }

  async calculateFromSymbolData(position) {
    try {
      const symbol = await Symbol.findOne({ symbolId: position.symbolId });
      if (!symbol || !symbol.dividend) {
        return null;
      }
      
      const shares = position.openQuantity || 0;
      const currentPrice = position.currentPrice || 0;
      const avgCost = position.averageEntryPrice || 0;
      
      const annualDividendPerShare = symbol.dividend || symbol.dividendPerShare || 0;
      const annualDividend = annualDividendPerShare * shares;
      
      const currentYield = currentPrice > 0 ? (annualDividendPerShare / currentPrice) * 100 : 0;
      const yieldOnCost = avgCost > 0 ? (annualDividendPerShare / avgCost) * 100 : 0;
      
      return {
        annualDividend,
        annualDividendPerShare,
        monthlyDividend: annualDividend / 12,
        monthlyDividendPerShare: annualDividendPerShare / 12,
        quarterlyDividend: annualDividend / 4,
        quarterlyDividendPerShare: annualDividendPerShare / 4,
        currentYield,
        yieldOnCost,
        dividendFrequency: symbol.dividendFrequency || 4,
        dividendSchedule: symbol.dividendSchedule || 'quarterly',
        totalReceived: 0, // Can't determine from symbol data alone
        calculationMethod: 'symbol_based',
        dataSource: 'symbol_table',
        lastCalculated: new Date()
      };
    } catch (error) {
      console.error(`Error calculating from symbol data for ${position.symbol}:`, error);
      return null;
    }
  }

  async calculateFromAPI(position) {
    try {
      // Placeholder for API-based calculation
      // This would integrate with external APIs like Yahoo Finance, Alpha Vantage, etc.
      console.log(`📡 API calculation not implemented for ${position.symbol}`);
      return null;
    } catch (error) {
      console.error(`Error calculating from API for ${position.symbol}:`, error);
      return null;
    }
  }

  detectIssues(position) {
    const issues = [];
    const divData = position.dividendData || {};
    
    // Check for missing dividend data on stocks that should have it
    if (position.isDividendStock && (!divData.annualDividend || divData.annualDividend === 0)) {
      issues.push('MISSING_DIVIDEND_DATA');
    }
    
    // Check for unrealistic yield values
    if (divData.yieldOnCost > 100) {
      issues.push('UNREALISTIC_YIELD_ON_COST');
    }
    
    if (divData.currentYield > 50) {
      issues.push('UNREALISTIC_CURRENT_YIELD');
    }
    
    // Check for dividend amount greater than market value
    if (divData.annualDividend > position.currentMarketValue) {
      issues.push('DIVIDEND_EXCEEDS_MARKET_VALUE');
    }
    
    // Check for negative values
    if (divData.totalReceived < 0 || divData.annualDividend < 0) {
      issues.push('NEGATIVE_DIVIDEND_VALUES');
    }
    
    // Check for inconsistent per-share calculations
    const shares = position.openQuantity || 0;
    if (shares > 0 && divData.annualDividend > 0) {
      const calculatedPerShare = divData.annualDividend / shares;
      const reportedPerShare = divData.annualDividendPerShare || 0;
      
      if (Math.abs(calculatedPerShare - reportedPerShare) > 0.01) {
        issues.push('INCONSISTENT_PER_SHARE_CALCULATION');
      }
    }
    
    // Check for old calculation timestamp
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!divData.lastCalculated || divData.lastCalculated < oneWeekAgo) {
      issues.push('STALE_CALCULATION');
    }
    
    return issues;
  }

  hasSignificantChanges(oldData, newData) {
    const threshold = 0.01; // 1 cent threshold
    
    const oldAnnual = oldData.annualDividend || 0;
    const newAnnual = newData.annualDividend || 0;
    
    const oldReceived = oldData.totalReceived || 0;
    const newReceived = newData.totalReceived || 0;
    
    const oldYield = oldData.yieldOnCost || 0;
    const newYield = newData.yieldOnCost || 0;
    
    return Math.abs(oldAnnual - newAnnual) > threshold ||
           Math.abs(oldReceived - newReceived) > threshold ||
           Math.abs(oldYield - newYield) > 0.1; // 0.1% threshold for yield
  }

  validateDividendData(position) {
    const errors = [];
    const divData = position.dividendData || {};
    
    // Validate yield ranges
    if (divData.yieldOnCost > 100) {
      errors.push(`Yield on cost too high: ${divData.yieldOnCost}%`);
    }
    
    if (divData.currentYield > 50) {
      errors.push(`Current yield too high: ${divData.currentYield}%`);
    }
    
    // Validate per-share consistency
    const shares = position.openQuantity || 0;
    if (shares > 0 && divData.annualDividend > 0) {
      const calculatedPerShare = divData.annualDividend / shares;
      const difference = Math.abs(calculatedPerShare - (divData.annualDividendPerShare || 0));
      
      if (difference > 0.01) {
        errors.push(`Per-share calculation inconsistent: ${calculatedPerShare} vs ${divData.annualDividendPerShare}`);
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  formatDividendSummary(divData) {
    return {
      annual: (divData.annualDividend || 0).toFixed(2),
      received: (divData.totalReceived || 0).toFixed(2),
      yieldOnCost: (divData.yieldOnCost || 0).toFixed(2) + '%',
      currentYield: (divData.currentYield || 0).toFixed(2) + '%'
    };
  }

  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  async generateReport() {
    console.log('\n📊 DIVIDEND RECALCULATION REPORT');
    console.log('=====================================');
    console.log(`Total positions found: ${this.stats.total}`);
    console.log(`Positions processed: ${this.stats.processed}`);
    console.log(`Positions updated: ${this.stats.updated}`);
    console.log(`Positions skipped: ${this.stats.skipped}`);
    console.log(`Issues fixed: ${this.stats.fixed}`);
    console.log(`Errors encountered: ${this.stats.errors}`);
    
    if (this.stats.issues.length > 0) {
      console.log('\n⚠️  ISSUES ENCOUNTERED:');
      this.stats.issues.forEach((issue, index) => {
        console.log(`${index + 1}. ${issue.symbol} (${issue.accountId}): ${issue.error || issue.validation}`);
      });
    }
    
    if (this.backupCollectionName) {
      console.log(`\n💾 Backup collection: ${this.backupCollectionName}`);
    }
    
    console.log('\n✅ Report generation completed');
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];
    
    switch (key) {
      case 'dry-run':
        options.dryRun = true;
        i--; // No value for this flag
        break;
      case 'force':
        options.forceRecalculate = true;
        i--; // No value for this flag
        break;
      case 'verbose':
        options.verbose = true;
        i--; // No value for this flag
        break;
      case 'only-problematic':
        options.onlyProblematic = true;
        i--; // No value for this flag
        break;
      case 'no-backup':
        options.backupBeforeRun = false;
        i--; // No value for this flag
        break;
      case 'person':
        options.personName = value;
        break;
      case 'symbol':
        options.symbol = value;
        break;
      case 'account':
        options.accountId = value;
        break;
      case 'batch-size':
        options.batchSize = parseInt(value);
        break;
      case 'max-concurrent':
        options.maxConcurrent = parseInt(value);
        break;
      default:
        if (key !== value) { // Skip if no value provided
          console.warn(`Unknown option: --${key}`);
        }
    }
  }
  
  // Show help if needed
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🔄 Dividend Recalculation Script

Usage: node scripts/recalculateDividends.js [options]

Options:
  --dry-run              Run in dry-run mode (no actual changes)
  --force                Force recalculation even for recent data
  --verbose              Show detailed processing information
  --only-problematic     Only process positions with detected issues
  --no-backup            Skip creating backup before running
  --person <name>        Only process positions for specific person
  --symbol <symbol>      Only process specific symbol
  --account <accountId>  Only process specific account
  --batch-size <number>  Number of positions to process per batch (default: 100)
  --max-concurrent <n>   Maximum concurrent operations (default: 5)
  --help, -h            Show this help message

Examples:
  # Dry run on all positions
  node scripts/recalculateDividends.js --dry-run

  # Fix only problematic positions
  node scripts/recalculateDividends.js --only-problematic

  # Force recalculation for specific person
  node scripts/recalculateDividends.js --force --person "John Doe"

  # Recalculate specific symbol with verbose output
  node scripts/recalculateDividends.js --symbol AAPL --verbose
    `);
    process.exit(0);
  }
  
  try {
    const recalculator = new DividendRecalculator(options);
    const stats = await recalculator.run();
    
    process.exit(stats.errors > 0 ? 1 : 0);
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = DividendRecalculator;