// reset-vivek.js - Completely reset Vivek's data
const mongoose = require('mongoose');
require('dotenv').config();

async function resetVivek() {
  try {
    console.log('🔄 Reset Vivek Completely');
    console.log('=========================\n');

    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // 1. Delete all Vivek data
    console.log('1. Deleting all Vivek data...');
    const collections = ['tokens', 'accounts', 'positions', 'activities', 'portfoliosnapshots'];
    
    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const deleteResult = await collection.deleteMany({ personName: 'Vivek' });
        console.log(`   ${collectionName}: deleted ${deleteResult.deletedCount} records`);
      } catch (error) {
        console.log(`   ${collectionName}: collection not found (OK)`);
      }
    }

    // 2. Delete Vivek person record
    console.log('\n2. Deleting Vivek person record...');
    const personsCollection = mongoose.connection.db.collection('persons');
    const deletePersonResult = await personsCollection.deleteMany({ personName: 'Vivek' });
    console.log(`✅ Deleted ${deletePersonResult.deletedCount} person record(s)`);

    // 3. Create fresh Vivek person record
    console.log('\n3. Creating fresh Vivek person record...');
    const newPerson = {
      personName: 'Vivek',
      displayName: 'Vivek',
      isActive: true,
      hasValidToken: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      preferences: {
        defaultView: 'person',
        currency: 'CAD',
        notifications: {
          enabled: true,
          dividendAlerts: true,
          syncErrors: true
        }
      }
    };

    await personsCollection.insertOne(newPerson);
    console.log('✅ Created fresh Vivek person record');

    console.log('\n🎉 Vivek reset completed!');
    console.log('\nNext steps:');
    console.log('1. Run: node setup.js');
    console.log('2. Choose option 2 (Update existing person\'s token)');
    console.log('3. Select Vivek and enter your Questrade refresh token');
    console.log('4. Should work without any duplicate key errors');

  } catch (error) {
    console.error('❌ Reset failed:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

if (require.main === module) {
  resetVivek();
}

module.exports = resetVivek;