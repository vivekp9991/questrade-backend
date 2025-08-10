// fix-token-encryption.js - Fix token decryption issues
const mongoose = require('mongoose');
require('dotenv').config();

async function fixTokenEncryption() {
  try {
    console.log('🔧 Fixing Token Encryption Issues');
    console.log('==================================\n');

    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current token situation
    console.log('1. Checking current tokens...');
    const tokensCollection = mongoose.connection.db.collection('tokens');
    const allTokens = await tokensCollection.find({}).toArray();
    
    console.log(`📊 Found ${allTokens.length} token(s):`);
    allTokens.forEach((token, index) => {
      console.log(`   Token ${index + 1}:`);
      console.log(`     _id: ${token._id}`);
      console.log(`     personName: ${token.personName}`);
      console.log(`     type: ${token.type}`);
      console.log(`     hasEncryptedToken: ${!!token.encryptedToken}`);
      console.log(`     encryptedToken length: ${token.encryptedToken ? token.encryptedToken.length : 0}`);
      console.log(`     createdAt: ${token.createdAt}`);
    });

    // 2. The issue: tokens are encrypted but can't be decrypted
    console.log('\n2. Diagnosis: Token decryption failing');
    console.log('   This usually means:');
    console.log('   - Tokens were encrypted with a different ENCRYPTION_KEY');
    console.log('   - The .env file has a different ENCRYPTION_KEY than when tokens were saved');
    console.log('   - Node.js crypto version differences');

    // 3. Solution: Delete bad tokens and require re-entry
    console.log('\n3. SOLUTION: Delete corrupted tokens and refresh');
    console.log('   This is the safest approach when encryption keys don\'t match.\n');

    const confirm = await askUser('Do you want to delete the corrupted tokens and require fresh token entry? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y') {
      console.log('❌ Operation cancelled. Tokens remain unchanged.');
      process.exit(0);
    }

    // 4. Delete the corrupted tokens
    console.log('\n4. Deleting corrupted tokens...');
    const deleteResult = await tokensCollection.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} corrupted token(s)`);

    // 5. Update person record to reflect token status
    console.log('\n5. Updating person records...');
    const personsCollection = mongoose.connection.db.collection('people');
    const updateResult = await personsCollection.updateMany(
      {},
      { 
        $set: {
          hasValidToken: false,
          lastTokenRefresh: null,
          lastSyncError: 'Tokens cleared due to encryption issues - please update refresh token'
        }
      }
    );
    console.log(`✅ Updated ${updateResult.modifiedCount} person record(s)`);

    // 6. Provide next steps
    console.log('\n🎯 Next Steps:');
    console.log('==============');
    console.log('1. Go to Questrade and generate a NEW refresh token:');
    console.log('   https://login.questrade.com/APIAccess/UserApps.aspx');
    console.log('');
    console.log('2. Run the setup script to add the new token:');
    console.log('   node setup.js');
    console.log('   Choose option 2: "Update existing person\'s token"');
    console.log('   Select Vivek and enter your NEW refresh token');
    console.log('');
    console.log('3. Test the API again:');
    console.log('   npm run dev');
    console.log('');
    console.log('⚠️  IMPORTANT: Use a FRESH token from Questrade');
    console.log('   Old tokens may have expired or been invalidated');

    console.log('\n✅ Token cleanup completed!');
    console.log('Your system is ready for fresh token setup.');

  } catch (error) {
    console.error('❌ Fix failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Simple input function for confirmation
function askUser(question) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n⏹️  Fix interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the fix
if (require.main === module) {
  fixTokenEncryption();
}

module.exports = fixTokenEncryption;