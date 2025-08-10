// find-correct-database.js - Find which database has your data
const mongoose = require('mongoose');
require('dotenv').config();

async function findCorrectDatabase() {
  try {
    console.log('🔍 Finding Your Actual Data Location');
    console.log('====================================\n');

    // Connect without specifying a database
    await mongoose.connect(process.env.MONGODB_URI.replace(/\/\w+$/, '') || 'mongodb://localhost:27017');
    console.log('✅ Connected to MongoDB server\n');

    // 1. List all databases
    console.log('1. Listing all databases...');
    const admin = mongoose.connection.db.admin();
    const databases = await admin.listDatabases();
    
    console.log(`📊 Found ${databases.databases.length} database(s):`);
    databases.databases.forEach(db => {
      console.log(`   - ${db.name} (${(db.sizeOnDisk / (1024*1024)).toFixed(2)} MB)`);
    });
    console.log();

    // 2. Check each database for portfolio data
    console.log('2. Searching for portfolio data in each database...');
    
    for (const dbInfo of databases.databases) {
      const dbName = dbInfo.name;
      
      // Skip system databases
      if (['admin', 'local', 'config'].includes(dbName)) {
        console.log(`   ⏭️  Skipping system database: ${dbName}`);
        continue;
      }

      console.log(`\n   🔍 Checking database: ${dbName}`);
      
      try {
        // Switch to this database
        const db = mongoose.connection.useDb(dbName);
        
        // List collections in this database
        const collections = await db.db.listCollections().toArray();
        console.log(`     Collections: ${collections.map(c => c.name).join(', ')}`);
        
        // Look for portfolio-related collections
        const portfolioCollections = collections.filter(c => 
          ['persons', 'people', 'accounts', 'positions', 'activities', 'tokens'].includes(c.name)
        );
        
        if (portfolioCollections.length > 0) {
          console.log(`     🎯 Found portfolio collections: ${portfolioCollections.map(c => c.name).join(', ')}`);
          
          // Check for Vivek in each collection
          for (const collection of portfolioCollections) {
            const coll = db.db.collection(collection.name);
            const count = await coll.countDocuments();
            console.log(`       - ${collection.name}: ${count} documents`);
            
            if (count > 0) {
              // Search for Vivek
              const vivekQueries = [
                { personName: "Vivek" },
                { name: "Vivek" },
                { $or: [{ personName: "Vivek" }, { name: "Vivek" }] }
              ];
              
              for (const query of vivekQueries) {
                try {
                  const results = await coll.find(query).limit(1).toArray();
                  if (results.length > 0) {
                    console.log(`         ✅ FOUND VIVEK with query: ${JSON.stringify(query)}`);
                    console.log(`         📝 Sample data: ${JSON.stringify(results[0], null, 2).substring(0, 200)}...`);
                  }
                } catch (queryError) {
                  // Skip failed queries
                }
              }
            }
          }
        } else {
          console.log(`     ❌ No portfolio collections found`);
        }
        
      } catch (dbError) {
        console.log(`     ❌ Error accessing database ${dbName}: ${dbError.message}`);
      }
    }

    // 3. Provide specific fix based on findings
    console.log('\n3. SOLUTION:');
    console.log('============');
    console.log('Based on the search above, your data is in a different database than expected.');
    console.log('\nTo fix this:');
    console.log('1. Update your .env file MONGODB_URI to point to the correct database');
    console.log('2. OR move your data to the expected database');
    console.log('\nCurrent MONGODB_URI in your .env:');
    console.log(`   ${process.env.MONGODB_URI || 'Not set'}`);
    console.log('\nIf your data is in database "questrade" instead of "portfolio", change to:');
    console.log('   MONGODB_URI=mongodb://localhost:27017/questrade');

  } catch (error) {
    console.error('❌ Search failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n⏹️  Search interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the search
if (require.main === module) {
  findCorrectDatabase();
}

module.exports = findCorrectDatabase;