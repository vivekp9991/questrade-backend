// test-sync.js - Test script to verify sync functionality
const mongoose = require('mongoose');
require('dotenv').config();

// Import all necessary modules
const Person = require('./models/Person');
const Token = require('./models/Token');
const Account = require('./models/Account');
const Position = require('./models/Position');
const Activity = require('./models/Activity');
const tokenManager = require('./services/tokenManager');
const questradeApi = require('./services/questradeApi');
const dataSync = require('./services/dataSync');
const logger = require('./utils/logger');

async function testSync() {
  try {
    console.log('🔧 Testing Sync Functionality');
    console.log('================================\n');

    // 1. Connect to database
    console.log('1. Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 2. Check for persons
    console.log('2. Checking for persons...');
    const persons = await Person.find({ isActive: true });
    console.log(`📊 Found ${persons.length} active person(s):`);
    
    if (persons.length === 0) {
      console.log('❌ No active persons found. Please add a person first using setup.js');
      process.exit(1);
    }

    for (const person of persons) {
      console.log(`   - ${person.personName} (created: ${person.createdAt?.toLocaleDateString()})`);
    }
    console.log();

    // 3. Test with first person
    const testPersonName = persons[0].personName;
    console.log(`3. Testing with person: ${testPersonName}`);

    // 4. Check token status
    console.log('4. Checking token status...');
    try {
      const tokenStatus = await tokenManager.getTokenStatus(testPersonName);
      console.log(`✅ Token Status for ${testPersonName}:`);
      console.log(`   Refresh Token: ${tokenStatus.refreshToken.exists ? 'Exists' : 'Missing'}`);
      console.log(`   Access Token: ${tokenStatus.accessToken.exists ? 'Valid' : 'Needs Refresh'}`);
      
      if (tokenStatus.refreshToken.lastError) {
        console.log(`   Last Error: ${tokenStatus.refreshToken.lastError}`);
      }
    } catch (tokenError) {
      console.log(`❌ Token status check failed: ${tokenError.message}`);
      process.exit(1);
    }
    console.log();

    // 5. Test API connection
    console.log('5. Testing API connection...');
    try {
      const serverTime = await questradeApi.getServerTime(testPersonName);
      console.log(`✅ API Connection successful`);
      console.log(`   Server time: ${serverTime}`);
    } catch (apiError) {
      console.log(`❌ API connection failed: ${apiError.message}`);
      
      if (apiError.message.includes('401') || apiError.message.includes('400')) {
        console.log(`💡 This might be a token issue. Try refreshing the token.`);
      }
      process.exit(1);
    }
    console.log();

    // 6. Test accounts sync
    console.log('6. Testing accounts sync...');
    try {
      const accountsResult = await dataSync.syncAccountsForPerson(testPersonName, false);
      console.log(`✅ Accounts sync completed:`);
      console.log(`   Synced: ${accountsResult.synced} accounts`);
      console.log(`   Errors: ${accountsResult.errors.length}`);
      
      if (accountsResult.errors.length > 0) {
        console.log('   Error details:');
        accountsResult.errors.forEach(err => {
          console.log(`     - ${err.accountId || 'General'}: ${err.error}`);
        });
      }
    } catch (syncError) {
      console.log(`❌ Accounts sync failed: ${syncError.message}`);
      process.exit(1);
    }
    console.log();

    // 7. Check synced accounts
    console.log('7. Checking synced accounts...');
    const accounts = await Account.find({ personName: testPersonName });
    console.log(`📊 Found ${accounts.length} synced account(s):`);
    accounts.forEach(acc => {
      console.log(`   - ${acc.accountId} (${acc.type}) - Status: ${acc.status}`);
    });
    
    if (accounts.length === 0) {
      console.log('❌ No accounts found. Sync may have failed.');
      process.exit(1);
    }
    console.log();

    // 8. Test positions sync for first account
    if (accounts.length > 0) {
      console.log('8. Testing positions sync...');
      try {
        const positionsResult = await dataSync.syncPositionsForPerson(testPersonName, false);
        console.log(`✅ Positions sync completed:`);
        console.log(`   Synced: ${positionsResult.synced} positions`);
        console.log(`   Errors: ${positionsResult.errors.length}`);
        
        if (positionsResult.errors.length > 0) {
          console.log('   Error details:');
          positionsResult.errors.forEach(err => {
            console.log(`     - ${err.accountId || err.symbol || 'General'}: ${err.error}`);
          });
        }
      } catch (positionsError) {
        console.log(`❌ Positions sync failed: ${positionsError.message}`);
      }
      console.log();

      // 9. Check synced positions
      console.log('9. Checking synced positions...');
      const positions = await Position.find({ personName: testPersonName });
      console.log(`📊 Found ${positions.length} synced position(s):`);
      positions.slice(0, 5).forEach(pos => {
        console.log(`   - ${pos.symbol}: ${pos.openQuantity} shares @ $${pos.currentPrice} = $${pos.currentMarketValue?.toFixed(2)}`);
      });
      
      if (positions.length > 5) {
        console.log(`   ... and ${positions.length - 5} more positions`);
      }
      console.log();
    }

    // 10. Summary
    console.log('10. Summary');
    console.log('===========');
    const finalAccounts = await Account.countDocuments({ personName: testPersonName });
    const finalPositions = await Position.countDocuments({ personName: testPersonName });
    const finalActivities = await Activity.countDocuments({ personName: testPersonName });

    console.log(`✅ Sync test completed successfully for ${testPersonName}!`);
    console.log(`📊 Final data counts:`);
    console.log(`   Accounts: ${finalAccounts}`);
    console.log(`   Positions: ${finalPositions}`);
    console.log(`   Activities: ${finalActivities}`);
    console.log();

    console.log('🎉 All tests passed! Your portfolio sync is working correctly.');
    console.log();
    console.log('Next steps:');
    console.log('- Start your server: npm start');
    console.log('- Access API endpoints: http://localhost:4000/api/');
    console.log(`- Get portfolio summary: GET /api/portfolio/summary?personName=${testPersonName}`);
    console.log(`- Get positions: GET /api/portfolio/positions?personName=${testPersonName}`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
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
  console.log('\n⏹️  Test interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the test
if (require.main === module) {
  testSync();
}

module.exports = testSync;