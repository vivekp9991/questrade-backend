// fix-duplicate-token.js - Fix the duplicate token issue
const mongoose = require('mongoose');
require('dotenv').config();

const Token = require('./models/Token');
const Person = require('./models/Person');

async function fixDuplicateToken() {
  try {
    console.log('🔧 Fix Duplicate Token Issue');
    console.log('=============================\n');

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current tokens
    console.log('1. Checking current tokens...');
    const tokens = await Token.find({});
    console.log(`Found ${tokens.length} token(s):`);
    
    tokens.forEach((token, index) => {
      console.log(`   Token ${index + 1}:`);
      console.log(`     personName: ${token.personName}`);
      console.log(`     type: ${token.type}`);
      console.log(`     isActive: ${token.isActive}`);
      console.log(`     created: ${token.createdAt?.toLocaleString()}`);
      console.log(`     expires: ${token.expiresAt?.toLocaleString()}`);
      if (token.lastError) {
        console.log(`     lastError: ${token.lastError}`);
      }
      console.log();
    });

    // 2. Check for Vivek's tokens specifically
    console.log('2. Checking Vivek\'s tokens...');
    const vivekTokens = await Token.find({ personName: 'Vivek' });
    console.log(`Found ${vivekTokens.length} token(s) for Vivek:`);
    
    vivekTokens.forEach((token, index) => {
      console.log(`   Vivek Token ${index + 1}:`);
      console.log(`     _id: ${token._id}`);
      console.log(`     type: ${token.type}`);
      console.log(`     isActive: ${token.isActive}`);
      console.log(`     created: ${token.createdAt?.toLocaleString()}`);
      console.log(`     expires: ${token.expiresAt?.toLocaleString()}`);
    });

    // 3. Clean up old/inactive tokens for Vivek
    console.log('3. Cleaning up old tokens for Vivek...');
    const deleteResult = await Token.deleteMany({ 
      personName: 'Vivek'
    });
    console.log(`✅ Deleted ${deleteResult.deletedCount} old token(s) for Vivek`);

    // 4. Update Person record to reset token status
    console.log('4. Resetting Person token status...');
    await Person.findOneAndUpdate(
      { personName: 'Vivek' },
      { 
        hasValidToken: false,
        lastTokenRefresh: null,
        lastSyncError: 'Token cleared - needs refresh'
      }
    );
    console.log('✅ Reset Vivek\'s token status');

    console.log('\n🎉 Token cleanup completed!');
    console.log('\nNext steps:');
    console.log('1. Run setup.js again');
    console.log('2. Choose option 2 (Update existing person\'s token)');
    console.log('3. Select Vivek and enter your refresh token');
    console.log('4. The duplicate key error should be resolved');

  } catch (error) {
    console.error('❌ Fix failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Run the fix
if (require.main === module) {
  fixDuplicateToken();
}

module.exports = fixDuplicateToken;