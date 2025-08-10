// quick-fix.js - Fix current issues and test sync
const mongoose = require('mongoose');
require('dotenv').config();

const Person = require('./models/Person');
const Token = require('./models/Token');

async function quickFix() {
  try {
    console.log('🔧 Quick Fix Script');
    console.log('===================\n');

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Check current persons and their field names
    console.log('1. Checking existing persons...');
    const persons = await Person.find({});
    
    if (persons.length === 0) {
      console.log('❌ No persons found. Please run setup.js first.');
      process.exit(1);
    }

    console.log(`Found ${persons.length} person(s):`);
    persons.forEach(person => {
      console.log(`   - ${person.personName || person.name || 'UNNAMED'}`);
      console.log(`     Fields: ${Object.keys(person.toObject()).join(', ')}`);
    });
    console.log();

    // 2. Fix person field names if needed
    console.log('2. Checking for field name issues...');
    let fixedCount = 0;
    
    for (const person of persons) {
      if (person.name && !person.personName) {
        console.log(`   Fixing field name for: ${person.name}`);
        person.personName = person.name;
        person.name = undefined;
        await person.save();
        fixedCount++;
      }
    }
    
    if (fixedCount > 0) {
      console.log(`✅ Fixed ${fixedCount} person records`);
    } else {
      console.log('✅ No field name issues found');
    }
    console.log();

    // 3. Check tokens
    console.log('3. Checking tokens...');
    const tokens = await Token.find({});
    console.log(`Found ${tokens.length} token(s):`);
    
    for (const token of tokens) {
      console.log(`   - ${token.personName}: ${token.type} token`);
      if (token.type === 'refresh') {
        console.log(`     Created: ${token.createdAt?.toLocaleString()}`);
        console.log(`     Expires: ${token.expiresAt?.toLocaleString()}`);
        console.log(`     Active: ${token.isActive}`);
        if (token.lastError) {
          console.log(`     Last Error: ${token.lastError}`);
        }
      }
    }
    console.log();

    // 4. Test the dataSync import
    console.log('4. Testing dataSync service...');
    try {
      const dataSync = require('./services/dataSync');
      console.log('✅ dataSync service loaded successfully');
      
      // Test with first person
      if (persons.length > 0) {
        const testPersonName = persons[0].personName || persons[0].name;
        console.log(`   Testing getSyncStatus for: ${testPersonName}`);
        
        const status = await dataSync.getSyncStatus(testPersonName);
        if (status) {
          console.log('✅ getSyncStatus working correctly');
          console.log(`   Status: ${JSON.stringify(status, null, 2)}`);
        } else {
          console.log('❌ getSyncStatus returned null');
        }
      }
    } catch (dataSyncError) {
      console.log(`❌ dataSync service error: ${dataSyncError.message}`);
    }
    console.log();

    // 5. Test tokenManager
    console.log('5. Testing tokenManager service...');
    try {
      const tokenManager = require('./services/tokenManager');
      console.log('✅ tokenManager service loaded successfully');
      
      if (persons.length > 0) {
        const testPersonName = persons[0].personName || persons[0].name;
        const tokenStatus = await tokenManager.getTokenStatus(testPersonName);
        console.log('✅ getTokenStatus working correctly');
        console.log(`   Healthy: ${tokenStatus.isHealthy}`);
      }
    } catch (tokenError) {
      console.log(`❌ tokenManager service error: ${tokenError.message}`);
    }
    console.log();

    // 6. Test questradeApi
    console.log('6. Testing questradeApi service...');
    try {
      const questradeApi = require('./services/questradeApi');
      console.log('✅ questradeApi service loaded successfully');
    } catch (apiError) {
      console.log(`❌ questradeApi service error: ${apiError.message}`);
    }
    console.log();

    console.log('🎉 Quick fix completed!');
    console.log('\nNext steps:');
    console.log('1. Try running the sync again: node setup.js (option 6)');
    console.log('2. Or test with: node test-sync.js');
    console.log('3. If issues persist, check the error messages above');

  } catch (error) {
    console.error('❌ Quick fix failed:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Run the quick fix
if (require.main === module) {
  quickFix();
}

module.exports = quickFix;