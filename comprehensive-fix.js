// comprehensive-fix.js - Fix all current issues
const mongoose = require('mongoose');
require('dotenv').config();

async function comprehensiveFix() {
  try {
    console.log('🔧 Comprehensive Database Fix');
    console.log('=============================\n');

    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current state
    console.log('1. Analyzing current database state...');
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`📊 Found ${collections.length} collections:`);
    
    for (const collection of collections) {
      const count = await mongoose.connection.db.collection(collection.name).countDocuments();
      console.log(`   - ${collection.name}: ${count} documents`);
    }
    console.log();

    // 2. Fix Person collection issues
    console.log('2. Fixing Person collection...');
    const personsCollection = mongoose.connection.db.collection('persons');
    
    // Find all person documents
    const allPersons = await personsCollection.find({}).toArray();
    console.log(`📊 Found ${allPersons.length} person record(s)`);
    
    let fixedPersons = 0;
    for (const person of allPersons) {
      console.log(`\n   Checking person: ${JSON.stringify(person, null, 2)}`);
      
      let needsUpdate = false;
      const setUpdates = {};
      const unsetUpdates = {};
      
      // Fix field name issues (name -> personName)
      if (person.name && !person.personName) {
        setUpdates.personName = person.name;
        unsetUpdates.name = 1;
        needsUpdate = true;
        console.log(`     🔧 Will fix field name: "${person.name}" -> personName`);
      }
      
      // Ensure required fields exist
      if (!person.personName && !person.name) {
        console.log(`     ⚠️  Person has no name field, skipping...`);
        continue;
      }
      
      const personName = person.personName || person.name;
      
      // Set default values for missing fields
      if (person.isActive === undefined) {
        setUpdates.isActive = true;
        needsUpdate = true;
        console.log(`     🔧 Setting isActive = true`);
      }
      
      if (person.hasValidToken === undefined) {
        setUpdates.hasValidToken = false;
        needsUpdate = true;
        console.log(`     🔧 Setting hasValidToken = false`);
      }
      
      if (!person.createdAt) {
        setUpdates.createdAt = new Date();
        needsUpdate = true;
        console.log(`     🔧 Setting createdAt`);
      }
      
      if (!person.updatedAt) {
        setUpdates.updatedAt = new Date();
        needsUpdate = true;
        console.log(`     🔧 Setting updatedAt`);
      }
      
      // Add default preferences if missing
      if (!person.preferences) {
        setUpdates.preferences = {
          defaultView: 'person',
          currency: 'CAD',
          notifications: {
            enabled: true,
            dividendAlerts: true,
            syncErrors: true
          }
        };
        needsUpdate = true;
        console.log(`     🔧 Adding default preferences`);
      }
      
      if (needsUpdate) {
        // Build the update document with proper MongoDB operators
        const updateDoc = {};
        
        if (Object.keys(setUpdates).length > 0) {
          updateDoc.$set = setUpdates;
        }
        
        if (Object.keys(unsetUpdates).length > 0) {
          updateDoc.$unset = unsetUpdates;
        }
        
        await personsCollection.updateOne(
          { _id: person._id },
          updateDoc
        );
        fixedPersons++;
        console.log(`     ✅ Updated person record`);
      } else {
        console.log(`     ✅ Person record is OK`);
      }
    }
    
    console.log(`\n✅ Fixed ${fixedPersons} person record(s)`);

    // 3. Clean up invalid tokens
    console.log('\n3. Cleaning up token collection...');
    const tokensCollection = mongoose.connection.db.collection('tokens');
    
    // Find all tokens
    const allTokens = await tokensCollection.find({}).toArray();
    console.log(`📊 Found ${allTokens.length} token record(s)`);
    
    // Remove tokens with invalid personName
    const invalidTokens = await tokensCollection.find({
      $or: [
        { personName: { $exists: false } },
        { personName: null },
        { personName: '' },
        { personName: undefined }
      ]
    }).toArray();
    
    if (invalidTokens.length > 0) {
      console.log(`   🗑️  Removing ${invalidTokens.length} invalid token(s)...`);
      await tokensCollection.deleteMany({
        $or: [
          { personName: { $exists: false } },
          { personName: null },
          { personName: '' },
          { personName: undefined }
        ]
      });
      console.log(`   ✅ Removed invalid tokens`);
    }
    
    // Check for duplicate tokens
    const tokensByPerson = {};
    const remainingTokens = await tokensCollection.find({}).toArray();
    
    for (const token of remainingTokens) {
      const key = `${token.personName}-${token.type}`;
      if (!tokensByPerson[key]) {
        tokensByPerson[key] = [];
      }
      tokensByPerson[key].push(token);
    }
    
    // Remove duplicates (keep newest)
    for (const [key, tokens] of Object.entries(tokensByPerson)) {
      if (tokens.length > 1) {
        console.log(`   🔍 Found ${tokens.length} duplicate tokens for ${key}`);
        
        // Sort by createdAt, keep newest
        tokens.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        const tokensToRemove = tokens.slice(1); // Remove all but the first (newest)
        
        for (const tokenToRemove of tokensToRemove) {
          await tokensCollection.deleteOne({ _id: tokenToRemove._id });
          console.log(`   🗑️  Removed duplicate token: ${tokenToRemove._id}`);
        }
      }
    }

    // 4. Verify person-token relationships
    console.log('\n4. Verifying person-token relationships...');
    const finalPersons = await personsCollection.find({}).toArray();
    const finalTokens = await tokensCollection.find({}).toArray();
    
    console.log('\n📊 Final status:');
    for (const person of finalPersons) {
      const personName = person.personName;
      const personTokens = finalTokens.filter(t => t.personName === personName);
      
      console.log(`\n   👤 ${personName}:`);
      console.log(`      Tokens: ${personTokens.length}`);
      
      const refreshTokens = personTokens.filter(t => t.type === 'refresh');
      const accessTokens = personTokens.filter(t => t.type === 'access');
      
      console.log(`      Refresh tokens: ${refreshTokens.length}`);
      console.log(`      Access tokens: ${accessTokens.length}`);
      
      if (refreshTokens.length === 0) {
        console.log(`      ⚠️  No refresh token - will need to add one`);
      } else if (refreshTokens.length > 1) {
        console.log(`      ⚠️  Multiple refresh tokens - this shouldn't happen`);
      } else {
        console.log(`      ✅ Has valid refresh token`);
      }
    }

    // 5. Test the fixed models
    console.log('\n5. Testing fixed models...');
    try {
      const Person = require('./models/Person');
      const Token = require('./models/Token');
      
      console.log('   📝 Testing Person model...');
      const testPersons = await Person.find({});
      console.log(`   ✅ Person model working - found ${testPersons.length} person(s)`);
      
      console.log('   📝 Testing Token model...');
      const testTokens = await Token.find({});
      console.log(`   ✅ Token model working - found ${testTokens.length} token(s)`);
      
      // Test tokenManager
      console.log('   📝 Testing tokenManager...');
      const tokenManager = require('./services/tokenManager');
      
      if (testPersons.length > 0) {
        const firstPerson = testPersons[0];
        try {
          const tokenStatus = await tokenManager.getTokenStatus(firstPerson.personName);
          console.log(`   ✅ TokenManager working for ${firstPerson.personName}`);
          console.log(`      Healthy: ${tokenStatus.isHealthy}`);
          console.log(`      Refresh token exists: ${tokenStatus.refreshToken.exists}`);
        } catch (tokenError) {
          console.log(`   ⚠️  TokenManager issue: ${tokenError.message}`);
        }
      }
      
    } catch (modelError) {
      console.log(`   ❌ Model testing failed: ${modelError.message}`);
    }

    // 6. Create indexes to prevent future issues
    console.log('\n6. Creating proper indexes...');
    try {
      // Create unique index on personName for persons
      await personsCollection.createIndex({ personName: 1 }, { unique: true });
      console.log('   ✅ Created unique index on persons.personName');
      
      // Create compound index on tokens to prevent duplicates
      await tokensCollection.createIndex(
        { personName: 1, type: 1, createdAt: 1 }, 
        { unique: true }
      );
      console.log('   ✅ Created compound index on tokens');
      
    } catch (indexError) {
      console.log(`   ⚠️  Index creation warning: ${indexError.message}`);
    }

    // 7. Summary and recommendations
    console.log('\n7. Summary and Recommendations');
    console.log('===============================');
    
    const finalPersonCount = await personsCollection.countDocuments();
    const finalTokenCount = await tokensCollection.countDocuments();
    const finalValidPersons = await personsCollection.countDocuments({ 
      personName: { $exists: true, $ne: null, $ne: '' }
    });
    
    console.log(`\n📊 Final Statistics:`);
    console.log(`   Total persons: ${finalPersonCount}`);
    console.log(`   Valid persons: ${finalValidPersons}`);
    console.log(`   Total tokens: ${finalTokenCount}`);
    
    if (finalValidPersons > 0) {
      console.log(`\n✅ Database is now in a good state!`);
      console.log(`\n🎯 Next Steps:`);
      console.log(`   1. Run the fixed setup script: node setup-fixed.js`);
      console.log(`   2. Choose option 4 to see person status`);
      console.log(`   3. If tokens need refresh, use option 2`);
      console.log(`   4. Test connections with option 5`);
      console.log(`   5. Sync data with option 6`);
      
      console.log(`\n🔧 Available Commands:`);
      console.log(`   - Test sync: node test-sync.js`);
      console.log(`   - Health check: node scripts/healthCheck.js`);
      console.log(`   - Start server: npm start`);
    } else {
      console.log(`\n⚠️  No valid persons found. You'll need to add a person:`);
      console.log(`   1. Run: node setup-fixed.js`);
      console.log(`   2. Choose option 1 to add a new person`);
      console.log(`   3. Get a fresh refresh token from Questrade`);
    }

    // 8. Check for additional data cleanup needed
    console.log('\n8. Checking for additional cleanup...');
    
    try {
      const Account = require('./models/Account');
      const Position = require('./models/Position');
      const Activity = require('./models/Activity');
      
      // Check for orphaned accounts
      const validPersonNames = finalPersons.map(p => p.personName);
      const orphanedAccounts = await Account.countDocuments({ 
        personName: { $nin: validPersonNames }
      });
      
      const orphanedPositions = await Position.countDocuments({ 
        personName: { $nin: validPersonNames }
      });
      
      const orphanedActivities = await Activity.countDocuments({ 
        personName: { $nin: validPersonNames }
      });
      
      if (orphanedAccounts > 0 || orphanedPositions > 0 || orphanedActivities > 0) {
        console.log(`\n🧹 Found orphaned data:`);
        console.log(`   Orphaned accounts: ${orphanedAccounts}`);
        console.log(`   Orphaned positions: ${orphanedPositions}`);
        console.log(`   Orphaned activities: ${orphanedActivities}`);
        console.log(`\n   Run this script again with --cleanup flag to remove orphaned data`);
      } else {
        console.log(`   ✅ No orphaned data found`);
      }
      
    } catch (dataError) {
      console.log(`   ⚠️  Could not check for orphaned data: ${dataError.message}`);
    }

    console.log(`\n🎉 Comprehensive fix completed!`);
    console.log(`\n💡 Troubleshooting Tips:`);
    console.log(`   - If you still have token issues, generate a NEW refresh token from Questrade`);
    console.log(`   - Make sure to copy the COMPLETE token without extra characters`);
    console.log(`   - The fixed setup script has better error handling`);
    console.log(`   - Use the test scripts to verify everything is working`);

  } catch (error) {
    console.error('❌ Fix failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Handle command line arguments
const args = process.argv.slice(2);
const shouldCleanup = args.includes('--cleanup');

if (shouldCleanup) {
  console.log('🧹 Cleanup mode enabled - will remove orphaned data');
}

// Run the fix
if (require.main === module) {
  comprehensiveFix();
}

module.exports = comprehensiveFix;