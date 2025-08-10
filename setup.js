// setup.js
const mongoose = require('mongoose');
const readline = require('readline');
const crypto = require('crypto');

// Import models and services with error handling
let Person, Token, Account, Position, Activity, PortfolioSnapshot;
let tokenManager, questradeApi, dataSync;

try {
  Person = require('./models/Person');
  Token = require('./models/Token');
} catch (error) {
  console.warn('Core models not found, using simple schemas');
}

try {
  Account = require('./models/Account');
  Position = require('./models/Position');
  Activity = require('./models/Activity');
  PortfolioSnapshot = require('./models/PortfolioSnapshot');
} catch (error) {
  console.warn('Extended models not found, some features will be limited');
}

try {
  tokenManager = require('./services/tokenManager');
  questradeApi = require('./services/questradeApi');
  dataSync = require('./services/dataSync');
} catch (error) {
  console.warn('Services not found, some features will be limited');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Utility function for prompting user input
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// Utility function for token input (visible for reliability)
function questionToken(prompt) {
  return question(prompt);
}

// Fallback schemas if models not found
if (!Person) {
  const PersonSchema = new mongoose.Schema({
    personName: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastSyncTime: Date,
    lastSyncStatus: String,
    lastSyncError: String,
    lastSyncResults: mongoose.Schema.Types.Mixed,
    settings: {
      currency: { type: String, default: 'CAD' },
      timezone: { type: String, default: 'America/Toronto' }
    }
  });
  Person = mongoose.model('Person', PersonSchema);
}

if (!Token) {
  const TokenSchema = new mongoose.Schema({
    personName: { type: String, required: true, unique: true },
    refreshToken: { type: String, required: true },
    accessToken: String,
    accessTokenExpiry: Date,
    lastRefreshed: Date,
    createdAt: { type: Date, default: Date.now }
  });
  Token = mongoose.model('Token', TokenSchema);
}

class PortfolioSetup {
  constructor() {
    this.mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
  }

  async connectDatabase() {
    try {
      await mongoose.connect(this.mongoUri);
      console.log('✓ Connected to MongoDB');
    } catch (error) {
      console.error('✗ Failed to connect to MongoDB:', error.message);
      throw error;
    }
  }

  async showWelcome() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    Portfolio Manager Setup                     ║
║                                                                ║
║  This setup wizard will help you configure your Questrade     ║
║  accounts and set up multi-person portfolio management.       ║
║                                                                ║
║  You'll need Questrade refresh tokens for each person you     ║
║  want to track. Get these from:                               ║
║  https://login.questrade.com/APIAccess/UserApps.aspx          ║
╚════════════════════════════════════════════════════════════════╝
`);
  }

  async showMainMenu() {
    console.log('\n=== Main Setup Menu ===');
    console.log('1. Add new person and token');
    console.log('2. Update existing person\'s token');
    console.log('3. Remove person and data');
    console.log('4. List all persons and status');
    console.log('5. Test connections');
    console.log('6. Sync data for person');
    console.log('7. Database utilities');
    console.log('8. Exit');
    
    const choice = await question('\nSelect an option (1-8): ');
    return choice.trim();
  }

  async addNewPerson() {
    console.log('\n=== Add New Person ===');
    
    // Get person name
    const personName = await question('Enter person name: ');
    if (!personName.trim()) {
      console.log('✗ Person name cannot be empty');
      return;
    }

    // Check if person already exists
    const existingPerson = await Person.findOne({ personName: personName.trim() });
    const existingToken = await Token.findOne({ personName: personName.trim() });
    
    if (existingPerson || existingToken) {
      console.log(`✗ Person "${personName}" already exists`);
      const update = await question('Do you want to update their token instead? (y/n): ');
      if (update.toLowerCase() === 'y') {
        return this.updatePersonToken(personName.trim());
      }
      return;
    }

    // Get refresh token
    console.log('\nGet your refresh token from: https://login.questrade.com/APIAccess/UserApps.aspx');
    const refreshToken = await questionToken('Enter Questrade refresh token: ');
    
    if (!refreshToken.trim()) {
      console.log('✗ Refresh token cannot be empty');
      return;
    }

    try {
      console.log('\n⏳ Validating token and setting up person...');

      // Create person record
      const person = new Person({
        personName: personName.trim(),
        isActive: true,
        createdAt: new Date(),
        settings: {
          currency: 'CAD',
          timezone: 'America/Toronto'
        }
      });

      await person.save();
      console.log('✓ Person record created');

      // Set up token
      if (tokenManager && tokenManager.setupPersonToken) {
        await tokenManager.setupPersonToken(personName.trim(), refreshToken.trim());
        console.log('✓ Token validated and saved');
      } else {
        // Fallback token creation with upsert to handle duplicates
        await Token.findOneAndUpdate(
          { personName: personName.trim() },
          {
            personName: personName.trim(),
            refreshToken: refreshToken.trim(),
            createdAt: new Date()
          },
          { upsert: true, new: true }
        );
        console.log('✓ Token saved (basic mode)');
      }

      // Test API connection
      if (questradeApi && questradeApi.getServerTime) {
        try {
          const serverTime = await questradeApi.getServerTime(personName.trim());
          console.log(`✓ API connection successful (Server time: ${serverTime})`);
        } catch (apiError) {
          console.log('⚠ API connection test failed, but token was saved');
          console.log(`  Error: ${apiError.message}`);
        }
      } else {
        console.log('⚠ API testing not available (services not loaded)');
      }

      // Ask if user wants to sync data immediately
      if (dataSync && dataSync.syncPersonData) {
        const syncNow = await question('\nWould you like to sync account data now? (y/n): ');
        if (syncNow.toLowerCase() === 'y') {
          await this.syncPersonData(personName.trim(), true);
        }
      } else {
        console.log('⚠ Data sync not available (services not loaded)');
      }

      console.log(`\n✓ Successfully set up person: ${personName}`);

    } catch (error) {
      console.log('✗ Setup failed:', error.message);
      
      // Cleanup on failure
      try {
        await Person.deleteOne({ personName: personName.trim() });
        await Token.deleteOne({ personName: personName.trim() });
        console.log('✓ Cleaned up partial setup');
      } catch (cleanupError) {
        console.log('⚠ Failed to cleanup partial setup:', cleanupError.message);
        console.log('You may need to manually remove the person record and try again.');
      }
    }
  }

  async updatePersonToken(personName) {
    if (!personName) {
      console.log('\n=== Update Person Token ===');
      const persons = await Person.find({}, { personName: 1 });
      
      if (persons.length === 0) {
        console.log('No persons found. Please add a person first.');
        return;
      }

      console.log('\nExisting persons:');
      persons.forEach((person, index) => {
        console.log(`${index + 1}. ${person.personName}`);
      });

      const choice = await question('\nSelect person number: ');
      const personIndex = parseInt(choice) - 1;
      
      if (personIndex < 0 || personIndex >= persons.length) {
        console.log('✗ Invalid selection');
        return;
      }
      
      personName = persons[personIndex].personName;
    }

    try {
      const person = await Person.findOne({ personName });
      if (!person) {
        console.log(`✗ Person "${personName}" not found`);
        return;
      }

      console.log(`\nUpdating token for: ${personName}`);
      console.log('Get your refresh token from: https://login.questrade.com/APIAccess/UserApps.aspx');
      const refreshToken = await questionToken('Enter new Questrade refresh token: ');

      if (!refreshToken.trim()) {
        console.log('✗ Refresh token cannot be empty');
        return;
      }

      console.log('\n⏳ Validating and updating token...');

      if (tokenManager && tokenManager.setupPersonToken) {
        await tokenManager.setupPersonToken(personName, refreshToken.trim());
        console.log('✓ Token updated successfully');
      } else {
        // Fallback token update
        await Token.findOneAndUpdate(
          { personName },
          { 
            refreshToken: refreshToken.trim(),
            lastRefreshed: new Date()
          },
          { upsert: true }
        );
        console.log('✓ Token updated (basic mode)');
      }

      // Test connection
      if (questradeApi && questradeApi.getServerTime) {
        try {
          const serverTime = await questradeApi.getServerTime(personName);
          console.log(`✓ API connection successful (Server time: ${serverTime})`);
        } catch (apiError) {
          console.log('⚠ API connection test failed');
          console.log(`  Error: ${apiError.message}`);
        }
      }

      console.log(`\n✓ Successfully updated token for: ${personName}`);

    } catch (error) {
      console.log('✗ Token update failed:', error.message);
    }
  }

  async removePerson() {
    console.log('\n=== Remove Person ===');
    
    const persons = await Person.find({}, { personName: 1 });
    if (persons.length === 0) {
      console.log('No persons found.');
      return;
    }

    console.log('\nExisting persons:');
    persons.forEach((person, index) => {
      console.log(`${index + 1}. ${person.personName}`);
    });

    const choice = await question('\nSelect person number to remove: ');
    const personIndex = parseInt(choice) - 1;
    
    if (personIndex < 0 || personIndex >= persons.length) {
      console.log('✗ Invalid selection');
      return;
    }
    
    const personName = persons[personIndex].personName;

    console.log(`\n⚠ WARNING: This will permanently delete ALL data for "${personName}"`);
    console.log('This includes:');
    console.log('- Person record');
    console.log('- Authentication tokens');
    console.log('- Account information');
    console.log('- Position data');
    console.log('- Activity history');
    console.log('- Portfolio snapshots');

    const confirm1 = await question(`\nType "${personName}" to confirm deletion: `);
    if (confirm1 !== personName) {
      console.log('✗ Confirmation failed. Deletion cancelled.');
      return;
    }

    const confirm2 = await question('Are you absolutely sure? (yes/no): ');
    if (confirm2.toLowerCase() !== 'yes') {
      console.log('✗ Deletion cancelled.');
      return;
    }

    try {
      console.log('\n⏳ Removing person and all associated data...');

      // Delete in order (foreign key considerations)
      const results = await Promise.allSettled([
        PortfolioSnapshot ? PortfolioSnapshot.deleteMany({ personName }) : Promise.resolve({ deletedCount: 0 }),
        Activity ? Activity.deleteMany({ personName }) : Promise.resolve({ deletedCount: 0 }),
        Position ? Position.deleteMany({ personName }) : Promise.resolve({ deletedCount: 0 }),
        Account ? Account.deleteMany({ personName }) : Promise.resolve({ deletedCount: 0 }),
        Token.deleteMany({ personName }),
        Person.deleteOne({ personName })
      ]);

      // Report results
      console.log('✓ Deletion completed:');
      const [snapshots, activities, positions, accounts, tokens, person] = results;
      
      if (snapshots.status === 'fulfilled') console.log(`  - Snapshots: ${snapshots.value.deletedCount} removed`);
      if (activities.status === 'fulfilled') console.log(`  - Activities: ${activities.value.deletedCount} removed`);
      if (positions.status === 'fulfilled') console.log(`  - Positions: ${positions.value.deletedCount} removed`);
      if (accounts.status === 'fulfilled') console.log(`  - Accounts: ${accounts.value.deletedCount} removed`);
      if (tokens.status === 'fulfilled') console.log(`  - Tokens: ${tokens.value.deletedCount} removed`);
      if (person.status === 'fulfilled') console.log(`  - Person: ${person.value.deletedCount} removed`);

      console.log(`\n✓ Successfully removed all data for: ${personName}`);

    } catch (error) {
      console.log('✗ Deletion failed:', error.message);
    }
  }

  async listPersons() {
    console.log('\n=== Persons and Status ===');
    
    const persons = await Person.find({});
    if (persons.length === 0) {
      console.log('No persons found.');
      return;
    }

    for (const person of persons) {
      console.log(`\n📊 ${person.personName}`);
      console.log(`   Created: ${person.createdAt?.toLocaleDateString() || 'Unknown'}`);
      console.log(`   Active: ${person.isActive ? 'Yes' : 'No'}`);
      console.log(`   Last Sync: ${person.lastSyncTime ? person.lastSyncTime.toLocaleString() : 'Never'}`);
      console.log(`   Sync Status: ${person.lastSyncStatus || 'Unknown'}`);

      // Token status
      const token = await Token.findOne({ personName: person.personName });
      if (token) {
        const now = new Date();
        const isValid = token.accessTokenExpiry && new Date(token.accessTokenExpiry) > now;
        console.log(`   Token: ${isValid ? '✓ Valid' : '⚠ Needs refresh'}`);
        if (token.accessTokenExpiry) {
          console.log(`   Expires: ${new Date(token.accessTokenExpiry).toLocaleString()}`);
        }
      } else {
        console.log(`   Token: ✗ Not found`);
      }

      // Data counts
      try {
        const [accountCount, positionCount, activityCount] = await Promise.all([
          Account ? Account.countDocuments({ personName: person.personName }) : 0,
          Position ? Position.countDocuments({ personName: person.personName }) : 0,
          Activity ? Activity.countDocuments({ personName: person.personName }) : 0
        ]);

        console.log(`   Data: ${accountCount} accounts, ${positionCount} positions, ${activityCount} activities`);
      } catch (error) {
        console.log(`   Data: Error loading counts - ${error.message}`);
      }

      if (person.lastSyncError) {
        console.log(`   Last Error: ${person.lastSyncError}`);
      }
    }
  }

  async testConnections() {
    console.log('\n=== Test Connections ===');
    
    if (!questradeApi || !questradeApi.getServerTime) {
      console.log('⚠ Connection testing not available (questradeApi service not loaded)');
      return;
    }

    const persons = await Person.find({ isActive: true });
    if (persons.length === 0) {
      console.log('No active persons found.');
      return;
    }

    for (const person of persons) {
      console.log(`\n🔍 Testing ${person.personName}...`);
      
      try {
        const startTime = Date.now();
        const serverTime = await questradeApi.getServerTime(person.personName);
        const responseTime = Date.now() - startTime;
        
        console.log(`   ✓ Connection successful`);
        console.log(`   Server time: ${serverTime}`);
        console.log(`   Response time: ${responseTime}ms`);

        // Try to get accounts as well
        if (questradeApi.getAccounts) {
          try {
            const accounts = await questradeApi.getAccounts(person.personName);
            console.log(`   ✓ Account access successful (${accounts.accounts?.length || 0} accounts)`);
          } catch (accountError) {
            console.log(`   ⚠ Account access failed: ${accountError.message}`);
          }
        }

      } catch (error) {
        console.log(`   ✗ Connection failed: ${error.message}`);
        
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          console.log(`   💡 Try refreshing the token for ${person.personName}`);
        }
      }
    }
  }

  async syncPersonData(personName, skipPrompt = false) {
    if (!dataSync || !dataSync.syncPersonData) {
      console.log('⚠ Data sync not available (dataSync service not loaded)');
      console.log('Make sure all service files are properly installed.');
      return;
    }

    if (!personName && !skipPrompt) {
      console.log('\n=== Sync Person Data ===');
      
      const persons = await Person.find({ isActive: true });
      if (persons.length === 0) {
        console.log('No active persons found.');
        return;
      }

      console.log('\nActive persons:');
      persons.forEach((person, index) => {
        console.log(`${index + 1}. ${person.personName}`);
      });

      const choice = await question('\nSelect person number: ');
      const personIndex = parseInt(choice) - 1;
      
      if (personIndex < 0 || personIndex >= persons.length) {
        console.log('✗ Invalid selection');
        return;
      }
      
      personName = persons[personIndex].personName;
    }

    try {
      if (!skipPrompt) {
        const fullSync = await question('Perform full sync? (y/n): ');
        const isFullSync = fullSync.toLowerCase() === 'y';
        console.log(`\n⏳ Starting ${isFullSync ? 'full' : 'incremental'} sync for ${personName}...`);
      } else {
        console.log(`\n⏳ Starting sync for ${personName}...`);
      }

      const result = await dataSync.syncPersonData(personName, {
        fullSync: !skipPrompt ? undefined : true
      });

      console.log('\n✓ Sync completed successfully!');
      console.log(`   Accounts synced: ${result.accounts.synced}`);
      console.log(`   Positions synced: ${result.positions.synced}`);
      console.log(`   Activities synced: ${result.activities.synced}`);
      console.log(`   Snapshot created: ${result.snapshots.created ? 'Yes' : 'No'}`);

      if (result.accounts.errors.length > 0 || 
          result.positions.errors.length > 0 || 
          result.activities.errors.length > 0) {
        console.log('\n⚠ Some errors occurred during sync:');
        [...result.accounts.errors, ...result.positions.errors, ...result.activities.errors]
          .forEach(error => console.log(`   - ${error.error}`));
      }

    } catch (error) {
      console.log('✗ Sync failed:', error.message);
    }
  }

  async databaseUtilities() {
    console.log('\n=== Database Utilities ===');
    console.log('1. Clear all data (DANGEROUS)');
    console.log('2. Reset database schema');
    console.log('3. Export data');
    console.log('4. Show database statistics');
    console.log('5. Back to main menu');

    const choice = await question('\nSelect option (1-5): ');

    switch (choice) {
      case '1':
        await this.clearAllData();
        break;
      case '2':
        await this.resetSchema();
        break;
      case '3':
        await this.exportData();
        break;
      case '4':
        await this.showDatabaseStats();
        break;
      case '5':
        return;
      default:
        console.log('Invalid choice');
        break;
    }
  }

  async clearAllData() {
    console.log('\n⚠ WARNING: This will delete ALL data in the database!');
    console.log('This action cannot be undone.');
    
    const confirm1 = await question('Type "DELETE ALL DATA" to confirm: ');
    if (confirm1 !== 'DELETE ALL DATA') {
      console.log('✗ Confirmation failed. Operation cancelled.');
      return;
    }

    const confirm2 = await question('Are you absolutely sure? (yes/no): ');
    if (confirm2.toLowerCase() !== 'yes') {
      console.log('✗ Operation cancelled.');
      return;
    }

    try {
      console.log('\n⏳ Clearing all data...');

      const collections = mongoose.connection.collections;
      for (const key in collections) {
        await collections[key].deleteMany({});
        console.log(`✓ Cleared ${key} collection`);
      }

      console.log('\n✓ All data cleared successfully');

    } catch (error) {
      console.log('✗ Failed to clear data:', error.message);
    }
  }

  async showDatabaseStats() {
    console.log('\n=== Database Statistics ===');

    try {
      const stats = {
        persons: await Person.countDocuments(),
        tokens: await Token.countDocuments(),
        accounts: Account ? await Account.countDocuments() : 0,
        positions: Position ? await Position.countDocuments() : 0,
        activities: Activity ? await Activity.countDocuments() : 0,
        snapshots: PortfolioSnapshot ? await PortfolioSnapshot.countDocuments() : 0
      };

      console.log('\nCollection counts:');
      Object.entries(stats).forEach(([collection, count]) => {
        console.log(`  ${collection}: ${count.toLocaleString()}`);
      });

      // Database size
      try {
        const dbStats = await mongoose.connection.db.stats();
        console.log(`\nDatabase size: ${(dbStats.dataSize / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`Storage size: ${(dbStats.storageSize / (1024 * 1024)).toFixed(2)} MB`);
      } catch (statsError) {
        console.log('\nDatabase size: Unable to retrieve');
      }

    } catch (error) {
      console.log('✗ Failed to get database stats:', error.message);
    }
  }

  async resetSchema() {
    console.log('\n⚠ This will drop and recreate all database indexes');
    const confirm = await question('Continue? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y') {
      console.log('Operation cancelled.');
      return;
    }

    try {
      console.log('\n⏳ Resetting database schema...');

      // Drop existing indexes
      const collections = mongoose.connection.collections;
      for (const key in collections) {
        try {
          await collections[key].dropIndexes();
          console.log(`✓ Dropped indexes for ${key}`);
        } catch (error) {
          // Ignore errors for collections without indexes
        }
      }

      // Recreate indexes by ensuring models
      await Person.ensureIndexes();
      await Token.ensureIndexes();
      if (Account) await Account.ensureIndexes();
      if (Position) await Position.ensureIndexes();
      if (Activity) await Activity.ensureIndexes();
      if (PortfolioSnapshot) await PortfolioSnapshot.ensureIndexes();
      
      console.log('✓ Schema reset completed');

    } catch (error) {
      console.log('✗ Schema reset failed:', error.message);
    }
  }

  async exportData() {
    console.log('\n⏳ Exporting data...');
    
    try {
      const fs = require('fs');
      const path = require('path');
      
      const exportDir = path.join(__dirname, 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFile = path.join(exportDir, `portfolio-export-${timestamp}.json`);

      const data = {
        exportDate: new Date(),
        persons: await Person.find({}),
        tokens: await Token.find({}).select('-refreshToken -accessToken'), // Exclude sensitive data
      };

      fs.writeFileSync(exportFile, JSON.stringify(data, null, 2));
      console.log(`✓ Data exported to: ${exportFile}`);

    } catch (error) {
      console.log('✗ Export failed:', error.message);
    }
  }

  async run() {
    try {
      await this.connectDatabase();
      await this.showWelcome();

      let running = true;
      while (running) {
        try {
          const choice = await this.showMainMenu();

          switch (choice) {
            case '1':
              await this.addNewPerson();
              break;
            case '2':
              await this.updatePersonToken();
              break;
            case '3':
              await this.removePerson();
              break;
            case '4':
              await this.listPersons();
              break;
            case '5':
              await this.testConnections();
              break;
            case '6':
              await this.syncPersonData();
              break;
            case '7':
              await this.databaseUtilities();
              break;
            case '8':
              running = false;
              break;
            default:
              console.log('Invalid choice. Please select 1-8.');
              break;
          }

          if (running) {
            await question('\nPress Enter to continue...');
          }

        } catch (error) {
          console.log('\n✗ An error occurred:', error.message);
          if (process.env.NODE_ENV === 'development') {
            console.log('Stack trace:', error.stack);
          }
          await question('\nPress Enter to continue...');
        }
      }

      console.log('\n👋 Goodbye!');
      console.log('🚀 Your portfolio manager is ready to use!');

    } catch (error) {
      console.error('Setup failed:', error.message);
      process.exit(1);
    } finally {
      rl.close();
      await mongoose.connection.close();
    }
  }
}

// Run setup if called directly
if (require.main === module) {
  const setup = new PortfolioSetup();
  setup.run().catch(error => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

module.exports = PortfolioSetup;