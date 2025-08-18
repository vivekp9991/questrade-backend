// scripts/recalculateYieldOnCost.js - COMPLETE SCRIPT - Recalculate yield on cost for all positions
const mongoose = require('mongoose');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const Person = require('../models/Person');
const Symbol = require('../models/Symbol');
const DividendCalculator = require('../services/dataSync/dividendCalculator');
const logger = require('../utils/logger');
require('dotenv').config();

// CLI argument parsing
const args = process.argv.slice(2);
const options = {
  person: null,
  symbol: null,
  dryRun: false,
  verbose: false,
  help: false
};

// Parse command line arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  switch (arg) {
    case '--person':
    case '-p':
      options.person = args[i + 1];
      i++; // Skip next argument as it's the value
      break;
    case '--symbol':
    case '-s':
      options.symbol = args[i + 1];
      i++; // Skip next argument as it's the value
      break;
    case '--dry-run':
    case '-d':
      options.dryRun = true;
      break;
    case '--verbose':
    case '-v':
      options.verbose = true;
      break;
    case '--help':
    case '-h':
      options.help = true;
      break;
    default:
      if (!arg.startsWith('-')) {
        // Assume it's a person name if no flag specified
        options.person = arg;
      }
      break;
  }
}

// Help text
function showHelp() {
  console.log(`
Yield on Cost Recalculation Script

This script fixes the yield on cost calculation issue where YoC shows 0.00% 
for dividend stocks. It properly calculates:

Portfolio-wide Yield on Cost = (Sum of all annual dividends / Sum of all total costs) * 100

Where:
- Total Cost = number of shares * average cost per share
- Annual Dividend = dividend per share * frequency * number of shares

Usage: node scripts/recalculateYieldOnCost.js [options]

Options:
  -p, --person <name>    Recalculate for specific person only
  -s, --symbol <symbol>  Recalculate for specific symbol only  
  -d, --dry-run          Show what would be updated without making changes
  -v, --verbose          Show detailed output for each position
  -h, --help             Show this help message

Examples:
  node scripts/recalculateYieldOnCost.js --person "Vivek"
  node scripts/recalculateYieldOnCost.js --symbol "TD.TO" --verbose
  node scripts/recalculateYieldOnCost.js --dry-run --verbose
  node scripts/recalculateYieldOnCost.js "Vivek" --dry-run

This script will:
1. Find all positions with dividend activities or symbol dividend info
2. Recalculate annual dividend per share based on frequency  
3. Recalculate yield on cost: (annual dividend per share / avg cost per share) * 100
4. Update position and portfolio-wide calculations
`);
}

async function connectDatabase() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error.message);
    process.exit(1);
  }
}

async function recalculatePosition(position, verbose = false) {
  try {
    // Get symbol info
    const symbol = await Symbol.findOne({ symbolId: position.symbolId });
    
    // Use DividendCalculator for proper calculation
    const dividendCalculator = new DividendCalculator();
    const newDividendData = await dividendCalculator.calculateDividendData(
      position.accountId,
      position.personName,
      position.symbolId,
      position.symbol,
      position.openQuantity,
      position.averageEntryPrice,
      symbol
    );
    
    // Calculate position-level dividend per share (annual)
    let dividendPerShare = newDividendData.annualDividendPerShare || 0;
    
    // Fallback to symbol data if needed
    if (dividendPerShare === 0 && symbol) {
      const freq = symbol.dividendFrequency?.toLowerCase();
      if (freq === 'monthly') {
        dividendPerShare = (symbol.dividendPerShare || 0) * 12;
      } else if (freq === 'quarterly') {
        dividendPerShare = (symbol.dividendPerShare || 0) * 4;
      } else if (freq === 'semi-annually') {
        dividendPerShare = (symbol.dividendPerShare || 0) * 2;
      } else if (freq === 'annually') {
        dividendPerShare = symbol.dividendPerShare || 0;
      }
    }
    
    const isDividendStock = (newDividendData.annualDividend > 0) || 
                           (newDividendData.totalReceived > 0) ||
                           (dividendPerShare > 0);

    const currentData = position.dividendData || {};
    
    if (verbose) {
      console.log(`  ${position.symbol}:`);
      console.log(`    Shares: ${position.openQuantity}`);
      console.log(`    Avg Cost: $${position.averageEntryPrice?.toFixed(2) || 0}`);
      console.log(`    Total Cost: $${position.totalCost?.toFixed(2) || 0}`);
      console.log(`    Symbol Dividend Per Share: $${symbol?.dividendPerShare || 0}`);
      console.log(`    Symbol Frequency: ${symbol?.dividendFrequency || 'N/A'}`);
      console.log(`    Calculated Annual DPS: $${dividendPerShare.toFixed(3)}`);
      console.log(`    Annual Dividend (Total): $${newDividendData.annualDividend.toFixed(2)}`);
      console.log(`    Old Yield on Cost: ${currentData.yieldOnCost?.toFixed(2) || 0}%`);
      console.log(`    New Yield on Cost: ${newDividendData.yieldOnCost.toFixed(2)}%`);
      console.log(`    Is Dividend Stock: ${isDividendStock}`);
    }

    // Check if update is needed
    const oldYoC = currentData.yieldOnCost || 0;
    const newYoC = newDividendData.yieldOnCost || 0;
    const significantChange = Math.abs(newYoC - oldYoC) > 0.01;
    
    if (!significantChange && !options.verbose) {
      return { updated: false, reason: 'No significant change' };
    }

    return {
      updated: true,
      position,
      oldData: currentData,
      newData: newDividendData,
      dividendPerShare,
      isDividendStock,
      yieldChange: newYoC - oldYoC
    };

  } catch (error) {
    console.error(`    ❌ Error calculating for ${position.symbol}:`, error.message);
    return { updated: false, reason: `Error: ${error.message}` };
  }
}

async function showPortfolioSummary(query = {}) {
  try {
    console.log('\n📊 CURRENT PORTFOLIO SUMMARY:');
    console.log('─'.repeat(50));
    
    const positions = await Position.find(query);
    
    let totalPositions = 0;
    let dividendPositions = 0;
    let totalCost = 0;
    let totalValue = 0;
    let totalAnnualDividend = 0;
    let totalDividendsReceived = 0;
    
    const topYieldStocks = [];
    
    positions.forEach(position => {
      totalPositions++;
      totalCost += position.totalCost || 0;
      totalValue += position.currentMarketValue || 0;
      
      if (position.dividendData) {
        totalDividendsReceived += position.dividendData.totalReceived || 0;
        totalAnnualDividend += position.dividendData.annualDividend || 0;
        
        if (position.dividendData.annualDividend > 0) {
          dividendPositions++;
          topYieldStocks.push({
            symbol: position.symbol,
            yieldOnCost: position.dividendData.yieldOnCost || 0,
            annualDividend: position.dividendData.annualDividend || 0
          });
        }
      }
    });
    
    const portfolioYoC = totalCost > 0 ? (totalAnnualDividend / totalCost) * 100 : 0;
    const currentYield = totalValue > 0 ? (totalAnnualDividend / totalValue) * 100 : 0;
    
    console.log(`  Total Positions: ${totalPositions}`);
    console.log(`  Dividend-Paying Positions: ${dividendPositions}`);
    console.log(`  Total Cost: $${totalCost.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Total Value: $${totalValue.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Total Annual Dividend: $${totalAnnualDividend.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Total Dividends Received: $${totalDividendsReceived.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Portfolio Yield on Cost: ${portfolioYoC.toFixed(2)}%`);
    console.log(`  Current Yield: ${currentYield.toFixed(2)}%`);
    
    if (topYieldStocks.length > 0) {
      console.log('\n  Top 5 Yield on Cost Performers:');
      topYieldStocks
        .sort((a, b) => b.yieldOnCost - a.yieldOnCost)
        .slice(0, 5)
        .forEach((stock, index) => {
          console.log(`    ${index + 1}. ${stock.symbol}: ${stock.yieldOnCost.toFixed(2)}% (${stock.annualDividend.toFixed(2)}/year)`);
        });
    }
    
    return {
      totalPositions,
      dividendPositions,
      portfolioYoC,
      totalCost,
      totalAnnualDividend
    };
  } catch (error) {
    console.error('Error showing portfolio summary:', error);
    return null;
  }
}

async function main() {
  // Show help if requested
  if (options.help) {
    showHelp();
    return;
  }

  console.log('\n🔄 Yield on Cost Recalculation Script');
  console.log('='.repeat(50));
  
  if (options.dryRun) {
    console.log('🧪 DRY RUN MODE - No changes will be made');
  }
  
  // Connect to database
  await connectDatabase();

  try {
    // Build query for positions to update
    let query = {};
    
    if (options.person) {
      query.personName = options.person;
      console.log(`📊 Processing positions for person: ${options.person}`);
    }
    
    if (options.symbol) {
      query.symbol = options.symbol;
      console.log(`📊 Processing positions for symbol: ${options.symbol}`);
    }
    
    if (!options.person && !options.symbol) {
      console.log('📊 Processing ALL positions');
    }

    // Show current portfolio summary
    const beforeSummary = await showPortfolioSummary(query);

    // Get positions to process
    const positions = await Position.find(query);
    console.log(`\n📈 Found ${positions.length} positions to check\n`);

    if (positions.length === 0) {
      console.log('No positions found matching criteria');
      return;
    }

    // Process positions
    let processed = 0;
    let updated = 0;
    let errors = 0;
    const updates = [];
    
    // Portfolio-wide totals for verification
    let totalCostBefore = 0;
    let totalAnnualDividendBefore = 0;
    let totalCostAfter = 0;
    let totalAnnualDividendAfter = 0;

    for (const position of positions) {
      processed++;
      
      if (options.verbose) {
        console.log(`\n[${processed}/${positions.length}] Processing ${position.symbol} (${position.accountId})`);
      } else if (processed % 10 === 0) {
        console.log(`Processed ${processed}/${positions.length} positions...`);
      }

      // Track before values
      totalCostBefore += position.totalCost || 0;
      totalAnnualDividendBefore += position.dividendData?.annualDividend || 0;

      const result = await recalculatePosition(position, options.verbose);
      
      if (result.updated) {
        updated++;
        updates.push(result);
        
        // Track after values
        totalCostAfter += position.totalCost || 0;
        totalAnnualDividendAfter += result.newData.annualDividend || 0;
        
        if (!options.dryRun) {
          try {
            await Position.findByIdAndUpdate(position._id, {
              dividendData: result.newData,
              isDividendStock: result.isDividendStock,
              dividendPerShare: result.dividendPerShare,
              updatedAt: new Date()
            });
            
            if (options.verbose) {
              console.log(`    ✅ Updated in database`);
            }
          } catch (updateError) {
            console.error(`    ❌ Failed to update database:`, updateError.message);
            errors++;
          }
        } else {
          if (options.verbose) {
            console.log(`    🧪 Would update (dry run)`);
          }
        }
      } else {
        // Still track totals for positions not updated
        totalCostAfter += position.totalCost || 0;
        totalAnnualDividendAfter += position.dividendData?.annualDividend || 0;
        
        if (options.verbose && result.reason !== 'No significant change') {
          console.log(`    ⏭️  Skipped: ${result.reason}`);
        }
      }
    }

    // Calculate portfolio-wide yield on cost
    const portfolioYoCBefore = totalCostBefore > 0 ? (totalAnnualDividendBefore / totalCostBefore) * 100 : 0;
    const portfolioYoCAfter = totalCostAfter > 0 ? (totalAnnualDividendAfter / totalCostAfter) * 100 : 0;

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 YIELD ON COST RECALCULATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total positions checked: ${processed}`);
    console.log(`Positions needing update: ${updated}`);
    console.log(`Errors encountered: ${errors}`);
    
    // Portfolio-wide metrics
    console.log('\n💰 PORTFOLIO-WIDE YIELD ON COST:');
    console.log(`  Total Cost: $${totalCostAfter.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Total Annual Dividend: $${totalAnnualDividendAfter.toLocaleString('en-US', {minimumFractionDigits: 2})}`);
    console.log(`  Portfolio Yield on Cost: ${portfolioYoCAfter.toFixed(2)}%`);
    
    if (Math.abs(portfolioYoCAfter - portfolioYoCBefore) > 0.01) {
      console.log(`  Change from: ${portfolioYoCBefore.toFixed(2)}% → ${portfolioYoCAfter.toFixed(2)}%`);
    }
    
    if (options.dryRun && updated > 0) {
      console.log(`\n🧪 DRY RUN: ${updated} positions would be updated`);
      console.log('   Run without --dry-run to apply changes');
    } else if (updated > 0) {
      console.log(`\n✅ Successfully updated ${updated} positions`);
    } else {
      console.log('\n✅ All positions already have correct yield on cost calculations');
    }

    // Show top yield improvements if verbose or significant updates
    if ((options.verbose || updated >= 5) && updates.length > 0) {
      console.log('\n📈 TOP YIELD ON COST IMPROVEMENTS:');
      updates
        .filter(update => update.yieldChange > 0.1) // Only show significant improvements
        .sort((a, b) => b.newData.yieldOnCost - a.newData.yieldOnCost)
        .slice(0, 10)
        .forEach(update => {
          const oldYoC = update.oldData?.yieldOnCost || 0;
          const newYoC = update.newData.yieldOnCost;
          console.log(`  ${update.position.symbol}: ${oldYoC.toFixed(2)}% → ${newYoC.toFixed(2)}% (+${(newYoC - oldYoC).toFixed(2)}%)`);
        });
    }

    // Show dividend stocks summary
    const dividendStocks = updates.filter(u => u.isDividendStock);
    if (dividendStocks.length > 0) {
      console.log(`\n🎯 DIVIDEND STOCKS SUMMARY:`);
      console.log(`  Total dividend-paying positions: ${dividendStocks.length}`);
      const avgYoC = dividendStocks.reduce((sum, u) => sum + u.newData.yieldOnCost, 0) / dividendStocks.length;
      console.log(`  Average yield on cost: ${avgYoC.toFixed(2)}%`);
      
      const highYieldStocks = dividendStocks.filter(u => u.newData.yieldOnCost > 5);
      if (highYieldStocks.length > 0) {
        console.log(`  High-yield positions (>5%): ${highYieldStocks.length}`);
      }
    }

    // Show updated portfolio summary if changes were made
    if (!options.dryRun && updated > 0) {
      await showPortfolioSummary(query);
    }

    // Recommend next steps
    if (!options.dryRun && updated > 0) {
      console.log('\n💡 NEXT STEPS:');
      console.log('   1. Test the portfolio summary API:');
      console.log('      curl "http://localhost:4000/api/portfolio/summary?viewMode=all&aggregate=true"');
      console.log('   2. Verify yield on cost values are now showing correctly');
      console.log('   3. Check individual position endpoints for updated YoC calculations');
      console.log('   4. Consider running a portfolio snapshot to capture the updated metrics');
    }

    // Formula explanation
    if (options.verbose || updated > 0) {
      console.log('\n📚 YIELD ON COST CALCULATION:');
      console.log('   Individual Position YoC = (Annual Dividend Per Share / Average Cost Per Share) × 100');
      console.log('   Portfolio-wide YoC = (Sum of All Annual Dividends / Sum of All Total Costs) × 100');
      console.log('   Where:');
      console.log('     • Total Cost = Number of Shares × Average Cost Per Share');
      console.log('     • Annual Dividend = Dividend Per Share × Frequency × Number of Shares');
      console.log('     • Frequency: Monthly=12, Quarterly=4, Semi-annual=2, Annual=1');
    }

    // Debug info for developers
    if (options.verbose && errors > 0) {
      console.log('\n🐛 DEBUG INFORMATION:');
      console.log(`   If you encountered errors, check:`)
      console.log(`   • MongoDB connection and permissions`);
      console.log(`   • Position and Symbol model consistency`);
      console.log(`   • DividendCalculator service availability`);
      console.log(`   • Activity data for dividend history`);
    }

  } catch (error) {
    console.error('\n❌ Script failed:', error.message);
    if (options.verbose) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n⏹️  Script interrupted by user');
  try {
    await mongoose.connection.close();
  } catch (error) {
    // Ignore connection close errors during shutdown
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Script terminated');
  try {
    await mongoose.connection.close();
  } catch (error) {
    // Ignore connection close errors during shutdown
  }
  process.exit(0);
});

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Script failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  recalculatePosition,
  showPortfolioSummary,
  main
};