// scripts/recalculateDividends.js - Script to fix totalReceived calculation for all positions
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
Dividend Recalculation Script

This script fixes the issue where totalReceived in dividend data shows 0 
instead of the actual total dividends received for each position.

Usage: node scripts/recalculateDividends.js [options]

Options:
  -p, --person <name>    Recalculate for specific person only
  -s, --symbol <symbol>  Recalculate for specific symbol only  
  -d, --dry-run          Show what would be updated without making changes
  -v, --verbose          Show detailed output for each position
  -h, --help             Show this help message

Examples:
  node scripts/recalculateDividends.js --person "Vivek"
  node scripts/recalculateDividends.js --symbol "KILO.TO" --verbose
  node scripts/recalculateDividends.js --dry-run --verbose
  node scripts/recalculateDividends.js "Vivek" --dry-run

This script will:
1. Find all positions with dividend activities
2. Recalculate totalReceived from actual dividend activities  
3. Update the dividendData.totalReceived field
4. Recalculate related metrics (dividendReturnPercent, etc.)
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

async function getDividendActivitiesForPosition(position) {
  // Get all dividend activities for this position
  const activities = await Activity.find({
    $and: [
      { accountId: position.accountId },
      { personName: position.personName },
      { symbol: position.symbol },
      { 
        $or: [
          { type: 'Dividend' },
          { isDividend: true },
          { rawType: { $regex: /dividend/i } }
        ]
      }
    ]
  }).sort({ transactionDate: -1 });

  return activities;
}

async function calculateActualTotalReceived(activities) {
  // Sum all dividend amounts received
  const totalReceived = activities.reduce((sum, activity) => {
    // Handle different amount fields and ensure positive values
    const amount = Math.abs(activity.netAmount || activity.grossAmount || 0);
    return sum + amount;
  }, 0);
  
  return totalReceived;
}

async function recalculatePosition(position, verbose = false) {
  try {
    // Get dividend activities for this position
    const activities = await getDividendActivitiesForPosition(position);
    
    if (activities.length === 0) {
      if (verbose) {
        console.log(`  ${position.symbol}: No dividend activities found`);
      }
      return { updated: false, reason: 'No dividend activities' };
    }

    // Calculate actual total received
    const actualTotalReceived = await calculateActualTotalReceived(activities);
    const currentTotalReceived = position.dividendData?.totalReceived || 0;
    
    if (verbose || Math.abs(actualTotalReceived - currentTotalReceived) > 0.01) {
      console.log(`  ${position.symbol}:`);
      console.log(`    Activities found: ${activities.length}`);
      console.log(`    Current totalReceived: $${currentTotalReceived.toFixed(2)}`);
      console.log(`    Actual totalReceived: $${actualTotalReceived.toFixed(2)}`);
      console.log(`    Difference: $${(actualTotalReceived - currentTotalReceived).toFixed(2)}`);
    }

    // Check if update is needed
    if (Math.abs(actualTotalReceived - currentTotalReceived) < 0.01) {
      if (verbose) {
        console.log(`    ✅ Already correct`);
      }
      return { updated: false, reason: 'Already correct' };
    }

    // Get symbol info for full calculation
    const symbol = await Symbol.findOne({ symbolId: position.symbolId });
    
    // Use DividendCalculator for full recalculation
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
    
    if (verbose) {
      console.log(`    New totalReceived: $${newDividendData.totalReceived.toFixed(2)}`);
      console.log(`    New dividendReturnPercent: ${newDividendData.dividendReturnPercent.toFixed(2)}%`);
      console.log(`    New yieldOnCost: ${newDividendData.yieldOnCost.toFixed(2)}%`);
    }

    return {
      updated: true,
      position,
      oldData: position.dividendData,
      newData: newDividendData,
      actualTotalReceived
    };

  } catch (error) {
    console.error(`    ❌ Error calculating for ${position.symbol}:`, error.message);
    return { updated: false, reason: `Error: ${error.message}` };
  }
}

async function main() {
  // Show help if requested
  if (options.help) {
    showHelp();
    return;
  }

  console.log('\n🔄 Dividend Recalculation Script');
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

    // Get positions to process
    const positions = await Position.find(query);
    console.log(`📈 Found ${positions.length} positions to check\n`);

    if (positions.length === 0) {
      console.log('No positions found matching criteria');
      return;
    }

    // Process positions
    let processed = 0;
    let updated = 0;
    let errors = 0;
    const updates = [];

    for (const position of positions) {
      processed++;
      
      if (options.verbose) {
        console.log(`\n[${processed}/${positions.length}] Processing ${position.symbol} (${position.accountId})`);
      } else if (processed % 10 === 0) {
        console.log(`Processed ${processed}/${positions.length} positions...`);
      }

      const result = await recalculatePosition(position, options.verbose);
      
      if (result.updated) {
        updated++;
        updates.push(result);
        
        if (!options.dryRun) {
          try {
            await Position.findByIdAndUpdate(position._id, {
              dividendData: result.newData,
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
        if (options.verbose && result.reason !== 'Already correct') {
          console.log(`    ⏭️  Skipped: ${result.reason}`);
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 RECALCULATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total positions checked: ${processed}`);
    console.log(`Positions needing update: ${updated}`);
    console.log(`Errors encountered: ${errors}`);
    
    if (options.dryRun && updated > 0) {
      console.log(`\n🧪 DRY RUN: ${updated} positions would be updated`);
      console.log('   Run without --dry-run to apply changes');
    } else if (updated > 0) {
      console.log(`\n✅ Successfully updated ${updated} positions`);
    } else {
      console.log('\n✅ All positions already have correct dividend data');
    }

    // Show top updates if verbose
    if (options.verbose && updates.length > 0) {
      console.log('\n📈 TOP DIVIDEND CORRECTIONS:');
      updates
        .sort((a, b) => b.actualTotalReceived - a.actualTotalReceived)
        .slice(0, 10)
        .forEach(update => {
          const oldTotal = update.oldData?.totalReceived || 0;
          const newTotal = update.actualTotalReceived;
          console.log(`  ${update.position.symbol}: $${oldTotal.toFixed(2)} → $${newTotal.toFixed(2)} (+$${(newTotal - oldTotal).toFixed(2)})`);
        });
    }

    // Recommend next steps
    if (!options.dryRun && updated > 0) {
      console.log('\n💡 NEXT STEPS:');
      console.log('   - Test the API endpoint: curl "http://localhost:4000/api/portfolio/positions?viewMode=all&aggregate=true"');
      console.log('   - Verify totalReceived values are now showing correctly');
      console.log('   - Consider running portfolio snapshot creation to update summaries');
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
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Script terminated');
  await mongoose.connection.close();
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
  calculateActualTotalReceived,
  getDividendActivitiesForPosition
};