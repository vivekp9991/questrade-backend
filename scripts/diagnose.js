// scripts/diagnose.js
const mongoose = require('mongoose');
const questradeApi = require('../services/questradeApi');
const dataSync = require('../services/dataSync');
const Token = require('../models/Token');
const Account = require('../models/Account');
const Position = require('../models/Position');
const logger = require('../utils/logger');
require('dotenv').config();

async function diagnose() {
  console.log('\n=== Questrade API Diagnostic Tool ===\n');
  
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB\n');

    // Check for tokens
    console.log('1. Checking tokens...');
    const refreshToken = await Token.findOne({ 
      type: 'refresh', 
      isActive: true 
    }).sort({ createdAt: -1 });
    
    const accessToken = await Token.findOne({ 
      type: 'access', 
      isActive: true,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!refreshToken) {
      console.log('❌ No active refresh token found!');
      console.log('   Please run: npm run setup');
      process.exit(1);
    }
    
    console.log('✅ Refresh token found');
    console.log(`   Expires: ${refreshToken.expiresAt}`);
    
    if (accessToken) {
      console.log('✅ Access token found');
      console.log(`   API Server: ${accessToken.apiServer}`);
      console.log(`   Expires: ${accessToken.expiresAt}`);
    } else {
      console.log('⚠️  No valid access token found (will refresh)');
    }

    // Test API connection
    console.log('\n2. Testing API connection...');
    try {
      const timeResult = await questradeApi.testConnection();
      console.log('✅ API connection successful');
      console.log(`   Server time: ${timeResult.time}`);
    } catch (error) {
      console.log('❌ API connection failed:', error.message);
      
      // Try to refresh token
      console.log('\n3. Attempting to refresh access token...');
      try {
        const result = await questradeApi.refreshAccessToken();
        console.log('✅ Token refreshed successfully');
        console.log(`   API Server: ${result.apiServer}`);
        console.log(`   Expires at: ${result.expiresAt}`);
      } catch (refreshError) {
        console.log('❌ Token refresh failed:', refreshError.message);
        console.log('\nPossible solutions:');
        console.log('1. Get a new refresh token from Questrade');
        console.log('2. Run: npm run setup');
        console.log('3. Check your .env file for correct QUESTRADE_AUTH_URL');
        process.exit(1);
      }
    }

    // Get accounts
    console.log('\n4. Fetching accounts...');
    try {
      const accountsData = await questradeApi.getAccounts();
      console.log(`✅ Found ${accountsData.accounts.length} account(s)`);
      
      for (const account of accountsData.accounts) {
        console.log(`\n   Account: ${account.number}`);
        console.log(`   Type: ${account.type}`);
        console.log(`   Status: ${account.status}`);
        console.log(`   Primary: ${account.isPrimary}`);
        
        // Save to database
        await Account.findOneAndUpdate(
          { accountId: account.number },
          {
            accountId: account.number,
            type: account.type,
            number: account.number,
            status: account.status,
            isPrimary: account.isPrimary,
            isBilling: account.isBilling,
            clientAccountType: account.clientAccountType,
            syncedAt: new Date()
          },
          { upsert: true }
        );
      }

      // Get positions for first account
      if (accountsData.accounts.length > 0) {
        const firstAccount = accountsData.accounts[0];
        console.log(`\n5. Fetching positions for account ${firstAccount.number}...`);
        
        try {
          const positionsData = await questradeApi.getAccountPositions(firstAccount.number);
          console.log(`✅ Found ${positionsData.positions.length} position(s)`);
          
          if (positionsData.positions.length > 0) {
            console.log('\n   Sample positions:');
            for (let i = 0; i < Math.min(3, positionsData.positions.length); i++) {
              const pos = positionsData.positions[i];
              console.log(`   - ${pos.symbol}: ${pos.openQuantity} shares @ $${pos.currentPrice}`);
            }
          }

          // Get account balances
          console.log(`\n6. Fetching balances for account ${firstAccount.number}...`);
          const balances = await questradeApi.getAccountBalances(firstAccount.number);
          
          if (balances.combinedBalances) {
            const cb = balances.combinedBalances[0];
            console.log('✅ Account balances:');
            console.log(`   Currency: ${cb.currency}`);
            console.log(`   Cash: $${cb.cash}`);
            console.log(`   Market Value: $${cb.marketValue}`);
            console.log(`   Total Equity: $${cb.totalEquity}`);
          }

          // Offer to sync all data
          console.log('\n7. Ready to sync all data');
          console.log('   Run the following command to sync all positions and activities:');
          console.log('   npm run sync-data\n');
          
        } catch (posError) {
          console.log('❌ Error fetching positions:', posError.message);
        }
      }

    } catch (accountError) {
      console.log('❌ Error fetching accounts:', accountError.message);
    }

    // Check database status
    console.log('\n8. Database status:');
    const accountCount = await Account.countDocuments();
    const positionCount = await Position.countDocuments();
    const tokenCount = await Token.countDocuments({ isActive: true });
    
    console.log(`   Active tokens: ${tokenCount}`);
    console.log(`   Accounts: ${accountCount}`);
    console.log(`   Positions: ${positionCount}`);

    console.log('\n=== Diagnostic Complete ===\n');
    
    if (positionCount === 0) {
      console.log('⚠️  No positions in database. Run: npm run sync-data');
    } else {
      console.log('✅ System appears to be working correctly');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Diagnostic failed:', error);
    process.exit(1);
  }
}

// Run diagnostic
diagnose();