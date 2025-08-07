// scripts/syncActivities.js
const mongoose = require('mongoose');
const questradeApi = require('../services/questradeApi');
const Activity = require('../models/Activity');
const Account = require('../models/Account');
const logger = require('../utils/logger');
require('dotenv').config();

// Format date for Questrade API (ISO format with timezone)
function formatDate(date) {
  const d = new Date(date);
  // Questrade expects ISO format with timezone like: 2011-02-01T00:00:00.000000-05:00
  // We'll use a simpler version that works: 2011-02-01T00:00:00-05:00
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  
  // Use Eastern Time zone offset
  return `${year}-${month}-${day}T00:00:00-05:00`;
}

async function syncAccountActivities(accountId, days = 30) {
  try {
    console.log(`\nSyncing activities for account ${accountId}...`);
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const formattedStartDate = formatDate(startDate);
    const formattedEndDate = formatDate(endDate);
    
    console.log(`  Date range: ${formattedStartDate} to ${formattedEndDate}`);
    
    try {
      const response = await questradeApi.getAccountActivities(
        accountId,
        formattedStartDate,
        formattedEndDate
      );
      
      const activities = response.activities || [];
      console.log(`  Found ${activities.length} activities`);
      
      // Group activities by type
      const activityTypes = {};
      let newActivities = 0;
      
      for (const activity of activities) {
        // Normalize activity type (Questrade returns plural, we store singular)
        let normalizedType = 'Other';
        const rawType = activity.type || '';
        
        // Map Questrade types to our types
        if (rawType.toLowerCase().includes('trade')) {
          normalizedType = 'Trade';
        } else if (rawType.toLowerCase().includes('dividend')) {
          normalizedType = 'Dividend';
        } else if (rawType.toLowerCase().includes('deposit')) {
          normalizedType = 'Deposit';
        } else if (rawType.toLowerCase().includes('withdrawal')) {
          normalizedType = 'Withdrawal';
        } else if (rawType.toLowerCase().includes('interest')) {
          normalizedType = 'Interest';
        } else if (rawType.toLowerCase().includes('transfer')) {
          normalizedType = 'Transfer';
        } else if (rawType.toLowerCase().includes('fee')) {
          normalizedType = 'Fee';
        } else if (rawType.toLowerCase().includes('tax')) {
          normalizedType = 'Tax';
        } else if (rawType.toLowerCase().includes('fx') || rawType.toLowerCase().includes('exchange')) {
          normalizedType = 'FX';
        }
        
        // Count by type
        activityTypes[normalizedType] = (activityTypes[normalizedType] || 0) + 1;
        
        // Check if activity already exists
        const exists = await Activity.findOne({
          accountId,
          transactionDate: activity.transactionDate,
          symbol: activity.symbol || null,
          type: normalizedType,
          netAmount: activity.netAmount
        });
        
        if (!exists) {
          try {
            await Activity.create({
              accountId,
              tradeDate: activity.tradeDate,
              transactionDate: activity.transactionDate,
              settlementDate: activity.settlementDate,
              action: activity.action,
              symbol: activity.symbol,
              symbolId: activity.symbolId,
              description: activity.description,
              currency: activity.currency,
              quantity: activity.quantity,
              price: activity.price,
              grossAmount: activity.grossAmount,
              commission: activity.commission,
              netAmount: activity.netAmount,
              type: normalizedType,
              rawType: rawType,  // Store original type for debugging
              isDividend: normalizedType === 'Dividend',
              dividendPerShare: normalizedType === 'Dividend' && activity.quantity > 0 
                ? Math.abs(activity.netAmount) / activity.quantity 
                : 0
            });
            newActivities++;
          } catch (error) {
            console.log(`    Warning: Could not save activity - ${error.message}`);
            console.log(`    Raw type was: "${rawType}", normalized to: "${normalizedType}"`);
          }
        }
      }
      
      console.log(`  ✅ Synced ${newActivities} new activities`);
      
      // Show breakdown
      if (Object.keys(activityTypes).length > 0) {
        console.log('\n  Activity breakdown:');
        for (const [type, count] of Object.entries(activityTypes)) {
          console.log(`    ${type}: ${count}`);
        }
      }
      
      // Show dividend summary if any
      const dividends = activities.filter(a => a.type === 'Dividend');
      if (dividends.length > 0) {
        const totalDividends = dividends.reduce((sum, d) => sum + Math.abs(d.netAmount), 0);
        console.log(`\n  Dividend Summary:`);
        console.log(`    Total dividends: $${totalDividends.toFixed(2)}`);
        console.log(`    Number of payments: ${dividends.length}`);
        
        // Show recent dividends
        const recentDividends = dividends
          .sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate))
          .slice(0, 5);
        
        if (recentDividends.length > 0) {
          console.log(`\n  Recent dividends:`);
          for (const div of recentDividends) {
            const date = new Date(div.transactionDate).toLocaleDateString();
            console.log(`    ${date}: ${div.symbol || 'N/A'} - $${Math.abs(div.netAmount).toFixed(2)}`);
          }
        }
      }
      
      return activities;
    } catch (error) {
      if (error.message.includes('Argument length exceeds')) {
        console.log(`  ⚠️  Date range too large, trying smaller range...`);
        
        // Try with just last 7 days
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        
        const formattedStartDate = formatDate(startDate);
        const formattedEndDate = formatDate(endDate);
        
        console.log(`  Retrying with: ${formattedStartDate} to ${formattedEndDate}`);
        
        const response = await questradeApi.getAccountActivities(
          accountId,
          formattedStartDate,
          formattedEndDate
        );
        
        const activities = response.activities || [];
        console.log(`  ✅ Found ${activities.length} activities (last 7 days)`);
        return activities;
      }
      throw error;
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return [];
  }
}

async function main() {
  console.log('\n=== Activity Sync Tool ===\n');
  
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB\n');
    
    // Check API connection
    console.log('Checking API connection...');
    await questradeApi.testConnection();
    console.log('✅ API connected\n');
    
    // Get accounts
    const accounts = await Account.find({});
    console.log(`Found ${accounts.length} account(s)`);
    
    // Process arguments
    const args = process.argv.slice(2);
    const days = args[0] ? parseInt(args[0]) : 30;
    const specificAccount = args[1];
    
    console.log(`\nFetching activities for last ${days} days`);
    
    if (specificAccount) {
      console.log(`Processing only account: ${specificAccount}`);
      await syncAccountActivities(specificAccount, days);
    } else {
      // Sync all accounts
      for (const account of accounts) {
        await syncAccountActivities(account.accountId, days);
      }
    }
    
    // Summary
    const totalActivities = await Activity.countDocuments();
    const dividendCount = await Activity.countDocuments({ type: 'Dividend' });
    const tradeCount = await Activity.countDocuments({ type: 'Trade' });
    
    console.log('\n=== Summary ===');
    console.log(`Total activities in database: ${totalActivities}`);
    console.log(`Dividends: ${dividendCount}`);
    console.log(`Trades: ${tradeCount}`);
    
    // Calculate total dividends
    const allDividends = await Activity.find({ type: 'Dividend' });
    const totalDividendAmount = allDividends.reduce((sum, d) => sum + Math.abs(d.netAmount), 0);
    
    if (totalDividendAmount > 0) {
      console.log(`\nTotal dividend income: $${totalDividendAmount.toFixed(2)}`);
      
      // Group by symbol
      const dividendsBySymbol = {};
      for (const div of allDividends) {
        const symbol = div.symbol || 'Other';
        if (!dividendsBySymbol[symbol]) {
          dividendsBySymbol[symbol] = { count: 0, total: 0 };
        }
        dividendsBySymbol[symbol].count++;
        dividendsBySymbol[symbol].total += Math.abs(div.netAmount);
      }
      
      console.log('\nDividends by symbol:');
      const sortedSymbols = Object.entries(dividendsBySymbol)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10);
      
      for (const [symbol, data] of sortedSymbols) {
        console.log(`  ${symbol}: $${data.total.toFixed(2)} (${data.count} payments)`);
      }
    }
    
    console.log('\n✅ Activity sync complete!');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
main();