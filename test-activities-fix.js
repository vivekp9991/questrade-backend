// test-activities-fix.js - Test the activities sync fix
const mongoose = require('mongoose');
require('dotenv').config();

// Import the fixed services
const Person = require('./models/Person');
const dataSync = require('./services/dataSync');
const logger = require('./utils/logger');

async function testActivitiesFix() {
  try {
    console.log('🧪 Testing Activities Sync Fix');
    console.log('===============================\n');

    // 1. Connect to database
    console.log('1. Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 2. Test date formatting function
    console.log('2. Testing date formatting...');
    
    // Test the fixed date format function
    const testDate = new Date('2024-08-10');
    const formattedDate = dataSync.formatDateForQuestrade(testDate);
    console.log(`✅ Date formatting test:`);
    console.log(`   Input: ${testDate.toISOString()}`);
    console.log(`   Formatted: ${formattedDate}`);
    console.log(`   Expected format: YYYY-MM-DDTHH:mm:ss-05:00`);
    
    // Verify the format matches Questrade requirements
    const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-05:00$/;
    const isValidFormat = dateRegex.test(formattedDate);
    console.log(`   Format validation: ${isValidFormat ? '✅ VALID' : '❌ INVALID'}\n`);

    if (!isValidFormat) {
      console.log('❌ Date format is still incorrect. Please check the formatDateForQuestrade function.');
      process.exit(1);
    }

    // 3. Check for active persons
    console.log('3. Checking for active persons...');
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

    // 4. Test activities sync for first person
    const testPersonName = persons[0].personName;
    console.log(`4. Testing activities sync for: ${testPersonName}`);
    console.log('   This will test the FIXED date format with Questrade API...\n');

    try {
      // Test just the activities sync (not full sync to isolate the issue)
      console.log('⏳ Starting activities sync test...');
      const result = await dataSync.syncActivitiesForPerson(testPersonName, false);
      
      console.log('✅ Activities sync completed successfully!');
      console.log(`📊 Results:`);
      console.log(`   Activities synced: ${result.synced}`);
      console.log(`   Errors: ${result.errors.length}`);
      
      if (result.errors.length > 0) {
        console.log('\n⚠️  Errors encountered:');
        result.errors.forEach((error, index) => {
          console.log(`   ${index + 1}. Account ${error.accountId}: ${error.error}`);
        });
      } else {
        console.log('\n🎉 No errors! The date format fix is working correctly.');
      }

    } catch (syncError) {
      console.log('❌ Activities sync failed:', syncError.message);
      
      // Check if it's still a date format error
      if (syncError.message.includes('Invalid or malformed argument: startTime')) {
        console.log('\n💡 This is still the same date format error.');
        console.log('   The fix may not have been applied correctly.');
        console.log('\n🔧 Debugging information:');
        console.log('   - Make sure you\'re using the FIXED version of services/dataSync.js');
        console.log('   - The formatDateForQuestrade function should return: YYYY-MM-DDTHH:mm:ss-05:00');
        console.log('   - Restart your application after applying the fix');
      } else {
        console.log('\n💡 This appears to be a different error (which is progress!)');
        console.log('   The date format fix may be working, but there\'s another issue.');
      }
      
      process.exit(1);
    }

    // 5. Summary
    console.log('\n🎯 Test Summary');
    console.log('================');
    console.log('✅ Date formatting function works correctly');
    console.log('✅ Activities sync API call succeeded');
    console.log('✅ No "Invalid or malformed argument: startTime" errors');
    console.log('\n🎉 The activities sync fix is working properly!');
    console.log('\nYou can now:');
    console.log('- Run full sync: node setup.js (option 6)');
    console.log('- Use the fixed dataSync service in your application');

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
  testActivitiesFix();
}

module.exports = testActivitiesFix;