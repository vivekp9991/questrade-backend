// scripts/healthCheck.js
const mongoose = require('mongoose');
const axios = require('axios');
const questradeApi = require('../services/questradeApi');
const Token = require('../models/Token');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Activity = require('../models/Activity');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const BASE_URL = `http://localhost:${PORT}/api`;

async function checkDatabase() {
  console.log('\n📊 Database Status:');
  console.log('─'.repeat(40));
  
  const counts = {
    tokens: await Token.countDocuments({ isActive: true }),
    accounts: await Account.countDocuments(),
    positions: await Position.countDocuments(),
    activities: await Activity.countDocuments(),
    snapshots: await PortfolioSnapshot.countDocuments()
  };
  
  console.log(`  Active Tokens: ${counts.tokens}`);
  console.log(`  Accounts: ${counts.accounts}`);
  console.log(`  Positions: ${counts.positions}`);
  console.log(`  Activities: ${counts.activities}`);
  console.log(`  Snapshots: ${counts.snapshots}`);
  
  return counts;
}

async function checkQuestradeAPI() {
  console.log('\n🔌 Questrade API Status:');
  console.log('─'.repeat(40));
  
  try {
    // Check token status
    const accessToken = await Token.findOne({
      type: 'access',
      isActive: true,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    
    if (accessToken) {
      console.log(`  ✅ Access token valid until: ${accessToken.expiresAt.toLocaleString()}`);
    } else {
      console.log('  ⚠️  No valid access token (will refresh on next call)');
    }
    
    // Test API connection
    const timeResult = await questradeApi.testConnection();
    console.log(`  ✅ API connected - Server time: ${timeResult.time}`);
    
    // Test account access
    const accounts = await questradeApi.getAccounts();
    console.log(`  ✅ Account access working - ${accounts.accounts.length} account(s) found`);
    
    // Test market data access
    try {
      // Try to get a quote for a popular symbol
      const testSymbol = await questradeApi.searchSymbol('TD.TO');
      if (testSymbol) {
        await questradeApi.getMarketQuote([testSymbol.symbolId]);
        console.log('  ✅ Market data access enabled');
      }
    } catch (error) {
      if (error.message.includes('OAuth scopes')) {
        console.log('  ⚠️  Market data access NOT enabled (enable in Questrade app)');
      } else {
        console.log(`  ⚠️  Market data test failed: ${error.message}`);
      }
    }
    
    // Test activities endpoint with proper date format
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 1); // Just yesterday
      
      const formatDate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}T00:00:00-05:00`;
      };
      
      if (accounts.accounts.length > 0) {
        const testAccount = accounts.accounts[0].number;
        await questradeApi.getAccountActivities(
          testAccount,
          formatDate(startDate),
          formatDate(endDate)
        );
        console.log('  ✅ Activities endpoint working');
      }
    } catch (error) {
      console.log(`  ⚠️  Activities endpoint issue: ${error.message}`);
    }
    
    return true;
  } catch (error) {
    console.log(`  ❌ API Error: ${error.message}`);
    return false;
  }
}

async function checkAPIEndpoints() {
  console.log('\n🌐 API Endpoints Status:');
  console.log('─'.repeat(40));
  
  const endpoints = [
    { method: 'GET', path: '/auth/token-status', name: 'Token Status' },
    { method: 'GET', path: '/accounts', name: 'Accounts List' },
    { method: 'GET', path: '/portfolio/summary', name: 'Portfolio Summary' },
    { method: 'GET', path: '/portfolio/positions', name: 'Positions List' },
    { method: 'GET', path: '/portfolio/dividends/calendar', name: 'Dividend Calendar' },
    { method: 'GET', path: '/portfolio/snapshots', name: 'Portfolio Snapshots' }
  ];
  
  let working = 0;
  let failed = 0;
  
  for (const endpoint of endpoints) {
    try {
      const response = await axios({
        method: endpoint.method,
        url: `${BASE_URL}${endpoint.path}`,
        timeout: 5000
      });
      
      if (response.status === 200 && response.data.success) {
        console.log(`  ✅ ${endpoint.name}: Working`);
        working++;
      } else {
        console.log(`  ⚠️  ${endpoint.name}: Response issue`);
        failed++;
      }
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log(`  ❌ ${endpoint.name}: Server not running`);
      } else {
        console.log(`  ❌ ${endpoint.name}: ${error.response?.status || error.code}`);
      }
      failed++;
    }
  }
  
  console.log(`\n  Summary: ${working}/${endpoints.length} endpoints working`);
  
  return { working, failed };
}

async function showPortfolioSummary() {
  console.log('\n💼 Portfolio Overview:');
  console.log('─'.repeat(40));
  
  try {
    const accounts = await Account.find({});
    
    for (const account of accounts) {
      console.log(`\n  Account: ${account.accountId} (${account.type})`);
      
      // Get positions
      const positions = await Position.find({ accountId: account.accountId });
      console.log(`    Positions: ${positions.length}`);
      
      if (positions.length > 0) {
        const totalValue = positions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const totalCost = positions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = positions.reduce((sum, p) => sum + (p.openPnl || 0), 0);
        
        console.log(`    Total Value: $${totalValue.toFixed(2)}`);
        console.log(`    Total Cost: $${totalCost.toFixed(2)}`);
        console.log(`    Unrealized P&L: $${totalPnL.toFixed(2)}`);
        
        if (totalCost > 0) {
          const returnPercent = ((totalValue - totalCost) / totalCost * 100).toFixed(2);
          console.log(`    Return: ${returnPercent}%`);
        }
      }
      
      // Get recent activities
      const recentActivities = await Activity.find({ 
        accountId: account.accountId 
      }).sort({ transactionDate: -1 }).limit(3);
      
      if (recentActivities.length > 0) {
        console.log(`    Recent activities: ${recentActivities.length}`);
      }
      
      // Get balance
      if (account.balances && account.balances.combinedBalances) {
        const balance = account.balances.combinedBalances[0];
        if (balance) {
          console.log(`    Cash Balance: $${balance.cash?.toFixed(2) || '0.00'}`);
        }
      }
    }
  } catch (error) {
    console.log(`  Error: ${error.message}`);
  }
}

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('   QUESTRADE PORTFOLIO TRACKER - HEALTH CHECK');
  console.log('='.repeat(50));
  
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    // Run all checks
    const dbStatus = await checkDatabase();
    const apiStatus = await checkQuestradeAPI();
    await showPortfolioSummary();
    
    // Try to check API endpoints if server is running
    console.log('\n🔍 Checking if server is running...');
    try {
      const endpoints = await checkAPIEndpoints();
      if (endpoints.failed > 0) {
        console.log('\n⚠️  Some endpoints are not working properly');
      }
    } catch (error) {
      console.log('  Server is not running. Start it with: npm start');
    }
    
    // Final recommendations
    console.log('\n' + '='.repeat(50));
    console.log('   RECOMMENDATIONS');
    console.log('='.repeat(50));
    
    if (dbStatus.positions === 0) {
      console.log('⚠️  No positions found - Run: npm run sync-data');
    }
    if (dbStatus.activities === 0) {
      console.log('⚠️  No activities found - Run: npm run sync-activities 7');
    }
    if (!apiStatus) {
      console.log('⚠️  API issues detected - Check your refresh token');
    }
    
    if (dbStatus.positions > 0 && apiStatus) {
      console.log('✅ System is healthy and ready to use!');
      console.log('\nYou can:');
      console.log('  - Start the server: npm start');
      console.log('  - Access API at: http://localhost:' + PORT);
      console.log('  - View portfolio: GET /api/portfolio/summary');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Health check failed:', error.message);
    process.exit(1);
  }
}

// Run the health check
main();