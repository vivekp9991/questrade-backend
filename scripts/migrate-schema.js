const mongoose = require('mongoose');

async function migrateSchema() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
  await mongoose.connect(mongoUri);
  
  // Drop existing collections to start fresh
  const collections = await mongoose.connection.db.collections();
  
  for (let collection of collections) {
    await collection.drop();
    console.log(`Dropped ${collection.collectionName}`);
  }
  
  console.log('Database reset complete');
  await mongoose.connection.close();
}

migrateSchema().catch(console.error);