// cleanup-tokens.js - Clean up invalid tokens and reset for fresh start
const mongoose = require('mongoose');
require('dotenv').config();

async function cleanupTokens() {
  try {
    console.log('🧹 Cleaning up Token Database');
    console.log('===============================\n');

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current state
    console.log('1. Checking current database state...');
    const tokensCollection = mongoose.connection.db.collection('tokens');
    const personsCollection = mongoose.connection.db.collection('persons');
    
    const totalTokens = await tokensCollection.countDocuments();
    const totalPersons = await personsCollection.countDocuments();
    
    console.log(`📊 Current state:`);
    console.log(`   Total tokens: ${totalTokens}`);
    console.log(`   Total persons: ${totalPersons}`);
    
    // 2. Show all current tokens to understand the issue
    console.log('\n2. Current token documents:');
    const allTokens = await tokensCollection.find({}).toArray();
    allTokens.forEach((token, index) => {
      console.log(`   Token ${index + 1}:`);
      console.log(`     _id: ${token._id}`);
      console.log(`     personName: ${token.personName}`);
      console.log(`     type: ${token.type}`);
      console.log(`     hasToken: ${!!token.token}`);
      console.log(`     hasEncryptedToken: ${!!token.encryptedToken}`);
      console.log(`     createdAt: ${token.createdAt}`);
      console.log();
    });

    // 3. Clean up all invalid tokens
    console.log('3. Cleaning up all tokens (fresh start)...');
    const deleteResult = await tokensCollection.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} token(s)`);

    // 4. Reset all person records
    console.log('\n4. Resetting person token status...');
    const updateResult = await personsCollection.updateMany(
      {},
      { 
        $set: {
          hasValidToken: false,
          lastTokenRefresh: null,
          lastSyncError: 'Database cleaned - token needs refresh'
        }
      }
    );
    console.log(`✅ Updated ${updateResult.modifiedCount} person record(s)`);

    // 5. Show final state
    console.log('\n5. Final state:');
    const finalTokens = await tokensCollection.countDocuments();
    const finalPersons = await personsCollection.countDocuments();
    
    console.log(`📊 After cleanup:`);
    console.log(`   Total tokens: ${finalTokens}`);
    console.log(`   Total persons: ${finalPersons}`);

    console.log('\n🎉 Cleanup completed successfully!');
    console.log('\n✅ Database is now ready for fresh token setup');
    console.log('\nNext steps:');
    console.log('1. Replace models/Token.js with the fixed version');
    console.log('2. Replace services/tokenManager.js with the fixed version');
    console.log('3. Run: node setup.js');
    console.log('4. Choose option 2 to update existing person\'s token');
    console.log('5. Enter your Questrade refresh token');
    
    console.log('\n💡 The error was caused by the Token model trying to save both');
    console.log('   a "token" field and an "encryptedToken" field, but setting');
    console.log('   token to undefined after encryption. The fixed version only');
    console.log('   stores the encryptedToken field in the database.');

  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Run the cleanup
if (require.main === module) {
  cleanupTokens();
}

module.exports = cleanupTokens;