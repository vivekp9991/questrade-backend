// diagnose-data-mismatch.js - Find exactly where your data is
const mongoose = require('mongoose');
require('dotenv').config();

async function diagnoseDataMismatch() {
  try {
    console.log('🔍 Diagnosing Data Mismatch Issue');
    console.log('==================================\n');

    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check all collections that exist
    console.log('1. Checking all collections in database...');
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`📊 Found ${collections.length} collections:`);
    
    for (const collection of collections) {
      const count = await mongoose.connection.db.collection(collection.name).countDocuments();
      console.log(`   - ${collection.name}: ${count} documents`);
    }
    console.log();

    // 2. Detailed analysis of each collection
    const targetCollections = ['persons', 'people', 'accounts', 'positions', 'activities', 'tokens'];
    
    for (const collectionName of targetCollections) {
      try {
        console.log(`2.${targetCollections.indexOf(collectionName) + 1} Analyzing ${collectionName} collection...`);
        const collection = mongoose.connection.db.collection(collectionName);
        const count = await collection.countDocuments();
        
        if (count === 0) {
          console.log(`   ❌ ${collectionName}: Empty collection\n`);
          continue;
        }

        console.log(`   📊 ${collectionName}: ${count} documents`);
        
        // Get a sample document to see the structure
        const sampleDoc = await collection.findOne({});
        if (sampleDoc) {
          console.log(`   🔍 Sample document structure:`);
          console.log(`     Fields: ${Object.keys(sampleDoc).join(', ')}`);
          
          // Check for person identification fields
          const personFields = [];
          if (sampleDoc.personName) personFields.push(`personName: "${sampleDoc.personName}"`);
          if (sampleDoc.name) personFields.push(`name: "${sampleDoc.name}"`);
          if (sampleDoc.person) personFields.push(`person: "${sampleDoc.person}"`);
          
          if (personFields.length > 0) {
            console.log(`     Person fields: ${personFields.join(', ')}`);
          } else {
            console.log(`     ⚠️  No person identification fields found`);
          }
        }

        // Search for "Vivek" in multiple possible fields
        console.log(`   🔍 Searching for "Vivek" in ${collectionName}...`);
        
        const queries = [
          { personName: "Vivek" },
          { name: "Vivek" },
          { person: "Vivek" },
          { $text: { $search: "Vivek" } } // Text search if there's a text index
        ];

        for (const query of queries) {
          try {
            const results = await collection.find(query).limit(5).toArray();
            if (results.length > 0) {
              console.log(`     ✅ Found ${results.length} documents with query: ${JSON.stringify(query)}`);
              
              // Show first result details
              const first = results[0];
              console.log(`     📝 First result:`);
              if (first.accountId) console.log(`       accountId: ${first.accountId}`);
              if (first.symbol) console.log(`       symbol: ${first.symbol}`);
              if (first.type) console.log(`       type: ${first.type}`);
              if (first.currentMarketValue) console.log(`       value: $${first.currentMarketValue}`);
              if (first.netAmount) console.log(`       amount: $${first.netAmount}`);
            }
          } catch (queryError) {
            // Skip queries that fail (like text search without index)
          }
        }
        console.log();

      } catch (collectionError) {
        console.log(`   ❌ Error accessing ${collectionName}: ${collectionError.message}\n`);
      }
    }

    // 3. Cross-reference data
    console.log('3. Cross-referencing data relationships...');
    
    try {
      // Get person from database
      const personsCollection = mongoose.connection.db.collection('persons');
      const vivekPerson = await personsCollection.findOne({ personName: "Vivek" });
      
      if (vivekPerson) {
        console.log(`✅ Found Vivek in persons collection`);
        console.log(`   Created: ${vivekPerson.createdAt}`);
        console.log(`   Active: ${vivekPerson.isActive}`);
        console.log(`   hasValidToken: ${vivekPerson.hasValidToken}`);
        
        // Now search for related data
        const accountsCollection = mongoose.connection.db.collection('accounts');
        const positionsCollection = mongoose.connection.db.collection('positions');
        const activitiesCollection = mongoose.connection.db.collection('activities');
        
        // Try different field name variations
        const searchVariations = [
          { personName: "Vivek" },
          { name: "Vivek" },
          { personName: vivekPerson.personName },
          { name: vivekPerson.personName }
        ];
        
        for (const searchQuery of searchVariations) {
          console.log(`\n   🔍 Testing query: ${JSON.stringify(searchQuery)}`);
          
          try {
            const accounts = await accountsCollection.find(searchQuery).toArray();
            const positions = await positionsCollection.find(searchQuery).toArray();
            const activities = await activitiesCollection.find(searchQuery).toArray();
            
            console.log(`     Accounts: ${accounts.length}`);
            console.log(`     Positions: ${positions.length}`);
            console.log(`     Activities: ${activities.length}`);
            
            if (accounts.length > 0 || positions.length > 0 || activities.length > 0) {
              console.log(`     ✅ FOUND DATA with this query!`);
              
              if (accounts.length > 0) {
                console.log(`     📝 Sample account: ${accounts[0].accountId} (${accounts[0].type})`);
              }
              if (positions.length > 0) {
                console.log(`     📝 Sample position: ${positions[0].symbol} - $${positions[0].currentMarketValue}`);
              }
              if (activities.length > 0) {
                console.log(`     📝 Sample activity: ${activities[0].type} - $${activities[0].netAmount}`);
              }
            }
          } catch (queryError) {
            console.log(`     ❌ Query failed: ${queryError.message}`);
          }
        }
      } else {
        console.log(`❌ Could not find Vivek in persons collection`);
      }
    } catch (crossRefError) {
      console.log(`❌ Cross-reference failed: ${crossRefError.message}`);
    }

    // 4. Test the actual API models
    console.log('\n4. Testing API models...');
    
    try {
      const Person = require('./models/Person');
      const Account = require('./models/Account');
      const Position = require('./models/Position');
      const Activity = require('./models/Activity');
      
      console.log('✅ All models loaded successfully');
      
      // Test queries that the API would use
      const apiPersons = await Person.find({ isActive: true });
      console.log(`📊 Person.find({ isActive: true }): ${apiPersons.length} results`);
      
      if (apiPersons.length > 0) {
        const firstPerson = apiPersons[0];
        console.log(`   First person: ${firstPerson.personName}`);
        
        const apiAccounts = await Account.find({ personName: firstPerson.personName });
        const apiPositions = await Position.find({ personName: firstPerson.personName });
        const apiActivities = await Activity.find({ personName: firstPerson.personName });
        
        console.log(`📊 API Model Results for "${firstPerson.personName}":`);
        console.log(`   Accounts: ${apiAccounts.length}`);
        console.log(`   Positions: ${apiPositions.length}`);
        console.log(`   Activities: ${apiActivities.length}`);
        
        if (apiAccounts.length === 0 && apiPositions.length === 0 && apiActivities.length === 0) {
          console.log(`   ❌ API models return empty - there's a field name mismatch!`);
        } else {
          console.log(`   ✅ API models working correctly`);
        }
      }
      
    } catch (modelError) {
      console.log(`❌ Model test failed: ${modelError.message}`);
    }

    // 5. Generate fix commands
    console.log('\n5. Recommended fixes based on findings:');
    console.log('=====================================');
    
    // This will be filled in based on what we find above
    console.log('Run the specific fix commands based on the analysis above.');
    console.log('The issue is most likely one of these:');
    console.log('1. Data stored with "name" field but API expects "personName"');
    console.log('2. Data stored with "personName" but API expects "name"'); 
    console.log('3. Person name case sensitivity ("Vivek" vs "vivek")');
    console.log('4. Data in different collection names than expected');

  } catch (error) {
    console.error('❌ Diagnosis failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n⏹️  Diagnosis interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the diagnosis
if (require.main === module) {
  diagnoseDataMismatch();
}

module.exports = diagnoseDataMismatch;