// scripts/syncData.js
const mongoose = require('mongoose');
const dataSync = require('../services/dataSync');
const questradeApi = require('../services/questradeApi');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const logger = require('../utils/logger');
require('dotenv').config();

async function syncAllData() {
  console.log('\n=== Questrade Data Sync ===\n');
  
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB\n');

    // First ensure we have a valid token
    console.log('1. Checking API connection...');
    try {
      await questradeApi.testConnection();
      console.log('✅ API connection successful\n');
    } catch (error) {
      console.log('⚠️  API connection failed, attempting to refresh token...');
      await questradeApi.refreshAccessToken();
      console.log('✅ Token refreshed\n');
    }

    // Sync accounts
    console.log('2. Syncing accounts...');
    const accounts = await dataSync.syncAccounts();
    console.log(`✅ Synced ${accounts.length} account(s)\n`);

    // Sync data for each account
    for (const account of accounts) {
      console.log(`\n=== Processing Account: ${account.number} (${account.type}) ===`);
      
      // Sync balances
      console.log('  Syncing balances...');
      try {
        await dataSync.syncAccountBalances(account.number);
        console.log('  ✅ Balances synced');
      } catch (error) {
        console.log(`  ❌ Error syncing balances: ${error.message}`);
      }

      // Sync positions
      console.log('  Syncing positions...');
      try {
        const positions = await dataSync.syncPositions(account.number);
        console.log(`  ✅ Synced ${positions.length} position(s)`);
        
        // Show sample positions
        if (positions.length > 0) {
          console.log('\n  Top positions:');
          const topPositions = positions
            .sort((a, b) => b.currentMarketValue - a.currentMarketValue)
            .slice(0, 5);
          
          for (const pos of topPositions) {
            const value = pos.currentMarketValue || 0;
            const qty = pos.openQuantity || 0;
            const price = pos.currentPrice || 0;
            console.log(`    ${pos.symbol}: ${qty} shares @ $${price.toFixed(2)} = $${value.toFixed(2)}`);
          }
        }
      } catch (error) {
        console.log(`  ❌ Error syncing positions: ${error.message}`);
      }

      // Sync activities (last 90 days)
      console.log('\n  Syncing activities (last 90 days)...');
      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 90);
        
        const activities = await dataSync.syncActivities(
          account.number,
          startDate.toISOString(),
          endDate.toISOString()
        );
        console.log(`  ✅ Synced ${activities.length} activities`);
        
        // Count activity types
        const activityTypes = {};
        for (const activity of activities) {
          activityTypes[activity.type] = (activityTypes[activity.type] || 0) + 1;
        }
        
        if (Object.keys(activityTypes).length > 0) {
          console.log('  Activity breakdown:');
          for (const [type, count] of Object.entries(activityTypes)) {
            console.log(`    ${type}: ${count}`);
          }
        }
      } catch (error) {
        console.log(`  ❌ Error syncing activities: ${error.message}`);
      }

      // Create portfolio snapshot
      console.log('\n  Creating portfolio snapshot...');
      try {
        const snapshot = await dataSync.createPortfolioSnapshot(account.number);
        if (snapshot) {
          console.log('  ✅ Portfolio snapshot created');
          console.log(`    Total Investment: $${snapshot.totalInvestment.toFixed(2)}`);
          console.log(`    Current Value: $${snapshot.currentValue.toFixed(2)}`);
          console.log(`    Total Return: $${snapshot.totalReturnValue.toFixed(2)} (${snapshot.totalReturnPercent.toFixed(2)}%)`);
          
          if (snapshot.annualProjectedDividend > 0) {
            console.log(`    Annual Dividends: $${snapshot.annualProjectedDividend.toFixed(2)}`);
            console.log(`    Yield on Cost: ${snapshot.yieldOnCostPercent.toFixed(2)}%`);
          }
        }
      } catch (error) {
        console.log(`  ❌ Error creating snapshot: ${error.message}`);
      }
    }

    // Summary
    console.log('\n\n=== Sync Complete ===');
    const accountCount = await Account.countDocuments();
    const positionCount = await Position.countDocuments();
    const activityCount = await Activity.countDocuments();
    
    console.log(`\nDatabase Summary:`);
    console.log(`  Accounts: ${accountCount}`);
    console.log(`  Positions: ${positionCount}`);
    console.log(`  Activities: ${activityCount}`);
    
    if (positionCount > 0) {
      console.log('\n✅ Data sync successful! Your portfolio data is now available.');
      console.log('\nYou can now:');
      console.log('  - Start the server: npm start');
      console.log('  - Access the API at: http://localhost:4000');
      console.log('  - Get portfolio summary: GET /api/portfolio/summary');
    } else {
      console.log('\n⚠️  No positions found. This could mean:');
      console.log('  - Your account has no open positions');
      console.log('  - There was an issue with the API connection');
      console.log('  - The account number format is incorrect');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Sync failed:', error);
    console.error('\nTroubleshooting:');
    console.error('1. Check your MongoDB connection');
    console.error('2. Verify your refresh token is valid');
    console.error('3. Run: npm run diagnose');
    process.exit(1);
  }
}

// Run sync
syncAllData();