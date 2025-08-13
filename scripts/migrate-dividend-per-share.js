// scripts/migrate-dividend-per-share.js - Update positions with dividendPerShare data
const mongoose = require('mongoose');
require('dotenv').config();

async function migrateDividendPerShare() {
  try {
    console.log('🔄 Migrating dividendPerShare data for existing positions...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    const Position = require('../models/Position');
    const Symbol = require('../models/Symbol');

    // Get all positions that don't have dividendPerShare set
    console.log('1. Finding positions needing dividendPerShare update...');
    const positions = await Position.find({
      $or: [
        { dividendPerShare: { $exists: false } },
        { dividendPerShare: 0 },
        { dividendPerShare: null }
      ]
    });

    console.log(`📊 Found ${positions.length} positions to update\n`);

    if (positions.length === 0) {
      console.log('✅ All positions already have dividendPerShare data!');
      return;
    }

    // Get unique symbol IDs for batch symbol lookup
    const symbolIds = [...new Set(positions.map(p => p.symbolId))];
    console.log('2. Loading symbol data...');
    const symbols = await Symbol.find({ symbolId: { $in: symbolIds } });
    
    const symbolMap = {};
    symbols.forEach(sym => { 
      symbolMap[sym.symbolId] = sym; 
    });
    console.log(`📊 Loaded ${symbols.length} symbols\n`);

    // Update positions in batches
    console.log('3. Updating positions...');
    let updated = 0;
    let skipped = 0;
    const batchSize = 50;

    for (let i = 0; i < positions.length; i += batchSize) {
      const batch = positions.slice(i, i + batchSize);
      console.log(`   Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(positions.length/batchSize)}...`);

      const bulkOps = [];

      for (const position of batch) {
        const symbol = symbolMap[position.symbolId];
        let dividendPerShare = 0;
        let isDividendStock = false;
        let updateFields = {};

        // Determine dividendPerShare from various sources
        if (symbol) {
          dividendPerShare = symbol.dividendPerShare || symbol.dividend || 0;
        }

        // Check if position has dividend data
        if (position.dividendData) {
          const divData = position.dividendData;
          
          // If position has annual dividend data, calculate per share
          if (divData.annualDividendPerShare && divData.annualDividendPerShare > 0) {
            dividendPerShare = Math.max(dividendPerShare, divData.annualDividendPerShare);
          }
          
          // Check if this is actually a dividend stock
          isDividendStock = (divData.annualDividend || 0) > 0 || 
                           (divData.totalReceived || 0) > 0 || 
                           dividendPerShare > 0;
        } else {
          isDividendStock = dividendPerShare > 0;
        }

        // Prepare update
        updateFields.dividendPerShare = dividendPerShare;
        updateFields.isDividendStock = isDividendStock;
        updateFields.updatedAt = new Date();

        // Add currency and sector info if missing
        if (symbol) {
          if (!position.currency && symbol.currency) {
            updateFields.currency = symbol.currency;
          }
          if (!position.industrySector && symbol.industrySector) {
            updateFields.industrySector = symbol.industrySector;
          }
          if (!position.industryGroup && symbol.industryGroup) {
            updateFields.industryGroup = symbol.industryGroup;
          }
          if (!position.securityType && symbol.securityType) {
            updateFields.securityType = symbol.securityType;
          }
        }

        if (Object.keys(updateFields).length > 2) { // More than just updatedAt
          bulkOps.push({
            updateOne: {
              filter: { _id: position._id },
              update: { $set: updateFields }
            }
          });
          updated++;
        } else {
          skipped++;
        }
      }

      // Execute bulk update
      if (bulkOps.length > 0) {
        await Position.bulkWrite(bulkOps);
      }
    }

    console.log(`\n✅ Migration completed!`);
    console.log(`   Updated: ${updated} positions`);
    console.log(`   Skipped: ${skipped} positions (no changes needed)`);

    // Show summary of dividend stocks
    console.log('\n4. Dividend stock summary...');
    const dividendStockCount = await Position.countDocuments({ isDividendStock: true });
    const totalPositions = await Position.countDocuments();
    
    console.log(`📊 Dividend stocks: ${dividendStockCount}/${totalPositions} positions`);

    // Show top dividend stocks by dividendPerShare
    const topDividendStocks = await Position.find({ 
      dividendPerShare: { $gt: 0 } 
    })
    .sort({ dividendPerShare: -1 })
    .limit(10)
    .select('symbol dividendPerShare currentPrice');

    if (topDividendStocks.length > 0) {
      console.log('\n📈 Top dividend payers:');
      topDividendStocks.forEach(pos => {
        const yieldPercent = pos.currentPrice > 0 ? 
          ((pos.dividendPerShare / pos.currentPrice) * 100).toFixed(2) : 0;
        console.log(`   ${pos.symbol}: $${pos.dividendPerShare.toFixed(3)}/share (${yieldPercent}% yield)`);
      });
    }

    console.log('\n🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (process.env.NODE_ENV === 'development') {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n⏹️  Migration interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the migration
if (require.main === module) {
  migrateDividendPerShare();
}

module.exports = migrateDividendPerShare;