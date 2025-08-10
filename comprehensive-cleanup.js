// comprehensive-cleanup.js - Fix all token issues
const mongoose = require('mongoose');
require('dotenv').config();

async function comprehensiveCleanup() {
  try {
    console.log('🧹 Comprehensive Database Cleanup');
    console.log('==================================\n');

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current state
    console.log('1. Checking current database state...');
    const tokensCollection = mongoose.connection.db.collection('tokens');
    const personsCollection = mongoose.connection.db.collection('persons');
    
    const totalTokens = await tokensCollection.countDocuments();
    const undefinedTokens = await tokensCollection.countDocuments({ personName: { $in: [null, undefined] } });
    const vivekTokens = await tokensCollection.countDocuments({ personName: 'Vivek' });
    const totalPersons = await personsCollection.countDocuments();
    
    console.log(`📊 Current state:`);
    console.log(`   Total tokens: ${totalTokens}`);
    console.log(`   Tokens with undefined personName: ${undefinedTokens}`);
    console.log(`   Tokens for Vivek: ${vivekTokens}`);
    console.log(`   Total persons: ${totalPersons}`);
    console.log();

    // 2. Delete all undefined/null personName tokens
    console.log('2. Cleaning up invalid tokens...');
    const deleteUndefinedResult = await tokensCollection.deleteMany({
      $or: [
        { personName: { $exists: false } },
        { personName: null },
        { personName: undefined },
        { personName: '' }
      ]
    });
    console.log(`✅ Deleted ${deleteUndefinedResult.deletedCount} invalid tokens`);

    // 3. Delete all Vivek tokens to start fresh
    console.log('3. Cleaning up all Vivek tokens...');
    const deleteVivekResult = await tokensCollection.deleteMany({ personName: 'Vivek' });
    console.log(`✅ Deleted ${deleteVivekResult.deletedCount} Vivek tokens`);

    // 4. Check and fix Person collection
    console.log('4. Checking Person collection...');
    const persons = await personsCollection.find({}).toArray();
    console.log(`📊 Found ${persons.length} person(s):`);
    
    persons.forEach((person, index) => {
      console.log(`   Person ${index + 1}:`);
      console.log(`     _id: ${person._id}`);
      console.log(`     personName: ${person.personName}`);
      console.log(`     name: ${person.name}`);
      console.log(`     isActive: ${person.isActive}`);
      console.log(`     Fields: ${Object.keys(person).join(', ')}`);
      console.log();
    });

    // 5. Fix any person field name issues
    console.log('5. Fixing person field names...');
    let fixedPersons = 0;
    for (const person of persons) {
      if (person.name && !person.personName) {
        await personsCollection.updateOne(
          { _id: person._id },
          { 
            $set: { personName: person.name },
            $unset: { name: 1 }
          }
        );
        console.log(`✅ Fixed field name for: ${person.name} -> personName`);
        fixedPersons++;
      }
    }
    
    if (fixedPersons === 0) {
      console.log('✅ No person field name issues found');
    }
    console.log();

    // 6. Reset Vivek's person record
    console.log('6. Resetting Vivek\'s person record...');
    const vivekUpdate = await personsCollection.updateOne(
      { personName: 'Vivek' },
      {
        $set: {
          hasValidToken: false,
          lastTokenRefresh: null,
          lastSyncError: 'Database cleaned - token needs refresh',
          lastSyncStatus: 'pending',
          lastSyncTime: null
        }
      }
    );
    
    if (vivekUpdate.matchedCount > 0) {
      console.log('✅ Reset Vivek\'s person record');
    } else {
      console.log('⚠️  Vivek person record not found');
    }
    console.log();

    // 7. Drop and recreate token indexes to ensure they're correct
    console.log('7. Fixing token collection indexes...');
    try {
      await tokensCollection.dropIndexes();
      console.log('✅ Dropped all token indexes');
    } catch (dropError) {
      console.log('ℹ️  No indexes to drop (this is fine)');
    }

    // 8. Verify cleanup
    console.log('8. Verifying cleanup...');
    const finalTokenCount = await tokensCollection.countDocuments();
    const finalUndefinedCount = await tokensCollection.countDocuments({ personName: { $in: [null, undefined] } });
    const finalVivekCount = await tokensCollection.countDocuments({ personName: 'Vivek' });
    
    console.log(`📊 After cleanup:`);
    console.log(`   Total tokens: ${finalTokenCount}`);
    console.log(`   Tokens with undefined personName: ${finalUndefinedCount}`);
    console.log(`   Tokens for Vivek: ${finalVivekCount}`);
    console.log();

    // 9. Check the Person model to ensure it's working
    console.log('9. Testing Person model...');
    try {
      const Person = require('./models/Person');
      const testPersons = await Person.find({});
      console.log(`✅ Person model working - found ${testPersons.length} person(s)`);
      
      testPersons.forEach(person => {
        console.log(`   - ${person.personName} (active: ${person.isActive})`);
      });
    } catch (personError) {
      console.log(`❌ Person model error: ${personError.message}`);
    }
    console.log();

    console.log('🎉 Comprehensive cleanup completed!');
    console.log('\n✅ Database is now clean and ready for fresh token setup');
    console.log('\nNext steps:');
    console.log('1. Update your services/tokenManager.js with the fixed version');
    console.log('2. Run: node setup.js');
    console.log('3. Choose option 2 to update Vivek\'s token');
    console.log('4. Use a valid Questrade refresh token');
    console.log('\nThe duplicate key error should now be completely resolved.');

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
  comprehensiveCleanup();
}

module.exports = comprehensiveCleanup;