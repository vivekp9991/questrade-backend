// setup-fixed.js - Fixed version with proper token input and field names
const mongoose = require('mongoose');
const readline = require('readline');
require('dotenv').config();

// Import models and services
const Person = require('./models/Person');
const tokenManager = require('./services/tokenManager');
const questradeApi = require('./services/questradeApi');
const dataSync = require('./services/dataSync');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Fixed utility function for prompting user input
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// FIXED: Secure password input without extra characters
function questionHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    let input = '';
    let isComplete = false;
    
    const originalListener = process.stdin.listeners('data')[0];
    process.stdin.removeAllListeners('data');
    
    process.stdin.on('data', function dataHandler(char) {
      if (isComplete) return;
      
      char = char.toString();
      
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          isComplete = true;
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', dataHandler);
          if (originalListener) {
            process.stdin.on('data', originalListener);
          }
          process.stdout.write('\n');
          resolve(input.trim()); // Trim whitespace
          break;
        case '\u0003': // Ctrl+C
          process.exit();
          break;
        case '\u007f': // Backspace
        case '\b': // Backspace (alternative)
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          // Only add printable characters
          if (char >= ' ' && char <= '~') {
            input += char;
            process.stdout.write('*');
          }
          break;
      }
    });
  });
}

class PortfolioSetup {
  constructor() {
    this.mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
  }

  async connectDatabase() {
    try {
      await mongoose.connect(this.mongoUri);
      console.log('✅ Connected to MongoDB');
    } catch (error) {
      console.error('❌ Failed to connect to MongoDB:', error.message);
      console.log('\nTroubleshooting:');
      console.log('1. Make sure MongoDB is running');
      console.log('2. Check your MONGODB_URI in .env file');
      console.log('3. Verify MongoDB is accessible');
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
      console.log('❌ Person name cannot be empty');
      return;
    }

    const cleanPersonName = personName.trim();

    // Check if person already exists
    const existingPerson = await Person.findOne({ personName: cleanPersonName });
    if (existingPerson) {
      console.log(`❌ Person "${cleanPersonName}" already exists`);
      const update = await question('Do you want to update their token instead? (y/n): ');
      if (update.toLowerCase() === 'y') {
        return this.updatePersonToken(cleanPersonName);
      }
      return;
    }

    // Get refresh token with clear instructions
    console.log('\n📋 To get your refresh token:');
    console.log('1. Go to: https://login.questrade.com/APIAccess/UserApps.aspx');
    console.log('2. Log in to your Questrade account');
    console.log('3. Click "Generate Token" (create a new manual token)');
    console.log('4. Copy the ENTIRE refresh token (usually starts with letters/numbers)');
    console.log('5. Make sure you copy the complete token without any extra spaces');
    console.log('\n⚠️  Important: The token input will be hidden for security');
    
    const refreshToken = await questionHidden('Enter Questrade refresh token (hidden): ');
    
    if (!refreshToken || refreshToken.length < 10) {
      console.log('❌ Refresh token appears to be invalid or too short');
      console.log('   Please make sure you copied the complete token from Questrade');
      return;
    }

    try {
      console.log('\n⏳ Validating token and setting up person...');

      // First validate the token
      console.log('🔍 Validating token format...');
      if (refreshToken.length < 20) {
        throw new Error('Token appears too short. Please ensure you copied the complete token.');
      }

      // Create person record first
      console.log('👤 Creating person record...');
      const person = new Person({
        personName: cleanPersonName,
        displayName: cleanPersonName,
        isActive: true,
        hasValidToken: false, // Will be set to true after token validation
        createdAt: new Date(),
        preferences: {
          defaultView: 'person',
          currency: 'CAD',
          notifications: {
            enabled: true,
            dividendAlerts: true,
            syncErrors: true
          }
        }
      });

      await person.save();
      console.log('✅ Person record created');

      // Now set up the token
      console.log('🔐 Setting up authentication token...');
      await tokenManager.setupPersonToken(cleanPersonName, refreshToken);
      console.log('✅ Token validated and saved securely');

      // Test API connection
      console.log('🌐 Testing API connection...');
      try {
        const connectionTest = await tokenManager.testConnection(cleanPersonName);
        console.log('✅ API connection successful');
        console.log(`   Server: ${connectionTest.apiServer}`);
        console.log(`   Server time: ${connectionTest.serverTime}`);
      } catch (apiError) {
        console.log('⚠️  API connection test failed, but token was saved');
        console.log(`   Error: ${apiError.message}`);
        
        if (apiError.message.includes('401') || apiError.message.includes('400')) {
          throw new Error('Token validation failed. Please check the token and try again.');
        }
      }

      // Update person record to mark token as valid
      await Person.findOneAndUpdate(
        { personName: cleanPersonName },
        { 
          hasValidToken: true,
          lastTokenRefresh: new Date(),
          lastSyncError: null
        }
      );

      // Ask if user wants to sync data immediately
      const syncNow = await question('\n📊 Would you like to sync account data now? (y/n): ');
      if (syncNow.toLowerCase() === 'y') {
        await this.syncPersonData(cleanPersonName, true);
      }

      console.log(`\n🎉 Successfully set up person: ${cleanPersonName}`);
      console.log('\n✅ Setup completed! You can now:');
      console.log(`   - Start the server: npm start`);
      console.log(`   - Sync data: option 6 in this menu`);
      console.log(`   - Test API: option 5 in this menu`);

    } catch (error) {
      console.log('❌ Setup failed:', error.message);
      
      // Provide specific guidance based on error type
      if (error.message.includes('400') || error.message.includes('Invalid refresh token')) {
        console.log('\n💡 Token Issue Solutions:');
        console.log('   1. Generate a new refresh token from Questrade');
        console.log('   2. Make sure you copied the COMPLETE token');
        console.log('   3. Check that the token hasn\'t expired');
      } else if (error.message.includes('connection') || error.message.includes('network')) {
        console.log('\n💡 Connection Issue Solutions:');
        console.log('   1. Check your internet connection');
        console.log('   2. Verify Questrade API is accessible');
        console.log('   3. Try again in a few minutes');
      }
      
      // Cleanup on failure
      try {
        await Person.deleteOne({ personName: cleanPersonName });
        // tokenManager.setupPersonToken handles its own cleanup
        console.log('✅ Cleaned up partial setup');
      } catch (cleanupError) {
        console.log('⚠️  Warning: Failed to cleanup partial setup:', cleanupError.message);
      }
    }
  }

  async updatePersonToken(personName) {
    if (!personName) {
      console.log('\n=== Update Person Token ===');
      const persons = await Person.find({}, { personName: 1 }).sort({ personName: 1 });
      
      if (persons.length === 0) {
        console.log('❌ No persons found. Please add a person first.');
        return;
      }

      console.log('\nExisting persons:');
      persons.forEach((person, index) => {
        console.log(`${index + 1}. ${person.personName}`);
      });

      const choice = await question('\nSelect person number: ');
      const personIndex = parseInt(choice) - 1;
      
      if (personIndex < 0 || personIndex >= persons.length) {
        console.log('❌ Invalid selection');
        return;
      }
      
      personName = persons[personIndex].personName;
    }

    try {
      const person = await Person.findOne({ personName });
      if (!person) {
        console.log(`❌ Person "${personName}" not found`);
        return;
      }

      console.log(`\n🔄 Updating token for: ${personName}`);
      console.log('\n📋 Get your refresh token from: https://login.questrade.com/APIAccess/UserApps.aspx');
      console.log('⚠️  Make sure to copy the COMPLETE token');
      
      const refreshToken = await questionHidden('Enter new Questrade refresh token (hidden): ');

      if (!refreshToken || refreshToken.length < 10) {
        console.log('❌ Refresh token appears to be invalid or too short');
        return;
      }

      console.log('\n⏳ Validating and updating token...');

      // Update token using tokenManager
      await tokenManager.setupPersonToken(personName, refreshToken);
      console.log('✅ Token updated and validated successfully');

      // Test connection
      console.log('🌐 Testing API connection...');
      try {
        const connectionTest = await tokenManager.testConnection(personName);
        console.log('✅ API connection successful');
        console.log(`   Server time: ${connectionTest.serverTime}`);
      } catch (apiError) {
        console.log('⚠️  API connection test failed');
        console.log(`   Error: ${apiError.message}`);
      }

      console.log(`\n🎉 Successfully updated token for: ${personName}`);

    } catch (error) {
      console.log('❌ Token update failed:', error.message);
      
      if (error.message.includes('Invalid refresh token')) {
        console.log('\n💡 Please generate a new token from Questrade and try again');
      }
    }
  }

  async listPersons() {
    console.log('\n=== Persons and Status ===');
    
    const persons = await Person.find({}).sort({ personName: 1 });
    if (persons.length === 0) {
      console.log('No persons found.');
      return;
    }

    for (const person of persons) {
      console.log(`\n📊 ${person.personName}`);
      console.log(`   Created: ${person.createdAt?.toLocaleDateString() || 'Unknown'}`);
      console.log(`   Active: ${person.isActive ? 'Yes' : 'No'}`);
      console.log(`   Last Sync: ${person.lastSuccessfulSync ? person.lastSuccessfulSync.toLocaleString() : 'Never'}`);
      console.log(`   Sync Status: ${person.lastSyncStatus || 'Unknown'}`);

      // Get token status using tokenManager
      try {
        const tokenStatus = await tokenManager.getTokenStatus(person.personName);
        console.log(`   Token: ${tokenStatus.isHealthy ? '✅ Healthy' : '⚠️ Needs attention'}`);
        
        if (tokenStatus.refreshToken.exists) {
          console.log(`   Token expires: ${tokenStatus.refreshToken.expiresAt?.toLocaleString() || 'Unknown'}`);
        }
        
        if (tokenStatus.refreshToken.lastError) {
          console.log(`   Last error: ${tokenStatus.refreshToken.lastError}`);
        }
      } catch (tokenError) {
        console.log(`   Token: ❌ Error checking status - ${tokenError.message}`);
      }

      // Data counts
      try {
        const Account = require('./models/Account');
        const Position = require('./models/Position');
        const Activity = require('./models/Activity');

        const [accountCount, positionCount, activityCount] = await Promise.all([
          Account.countDocuments({ personName: person.personName }),
          Position.countDocuments({ personName: person.personName }),
          Activity.countDocuments({ personName: person.personName })
        ]);

        console.log(`   Data: ${accountCount} accounts, ${positionCount} positions, ${activityCount} activities`);
      } catch (dataError) {
        console.log(`   Data: Error loading counts`);
      }

      if (person.lastSyncError) {
        console.log(`   Last Error: ${person.lastSyncError}`);
      }
    }
  }

  async testConnections() {
    console.log('\n=== Test Connections ===');
    
    const persons = await Person.find({ isActive: true }).sort({ personName: 1 });
    if (persons.length === 0) {
      console.log('❌ No active persons found.');
      return;
    }

    for (const person of persons) {
      console.log(`\n🔍 Testing ${person.personName}...`);
      
      try {
        const startTime = Date.now();
        const connectionTest = await tokenManager.testConnection(person.personName);
        const responseTime = Date.now() - startTime;
        
        console.log(`   ✅ Connection successful`);
        console.log(`   Server time: ${connectionTest.serverTime}`);
        console.log(`   Response time: ${responseTime}ms`);

        // Try to get accounts as well
        try {
          const accounts = await questradeApi.getAccounts(person.personName);
          console.log(`   ✅ Account access successful (${accounts.accounts?.length || 0} accounts)`);
        } catch (accountError) {
          console.log(`   ⚠️ Account access failed: ${accountError.message}`);
        }

      } catch (error) {
        console.log(`   ❌ Connection failed: ${error.message}`);
        
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          console.log(`   💡 Try updating the refresh token for ${person.personName}`);
        } else if (error.message.includes('400')) {
          console.log(`   💡 Token may be invalid - generate a new one from Questrade`);
        }
      }
    }
  }

  async syncPersonData(personName, skipPrompt = false) {
    if (!personName && !skipPrompt) {
      console.log('\n=== Sync Person Data ===');
      
      const persons = await Person.find({ isActive: true }).sort({ personName: 1 });
      if (persons.length === 0) {
        console.log('❌ No active persons found.');
        return;
      }

      console.log('\nActive persons:');
      persons.forEach((person, index) => {
        console.log(`${index + 1}. ${person.personName}`);
      });

      const choice = await question('\nSelect person number: ');
      const personIndex = parseInt(choice) - 1;
      
      if (personIndex < 0 || personIndex >= persons.length) {
        console.log('❌ Invalid selection');
        return;
      }
      
      personName = persons[personIndex].personName;
    }

    try {
      let isFullSync = true;
      
      if (!skipPrompt) {
        const syncType = await question('Perform full sync? (y/n): ');
        isFullSync = syncType.toLowerCase() === 'y';
      }

      console.log(`\n⏳ Starting ${isFullSync ? 'full' : 'incremental'} sync for ${personName}...`);

      const result = await dataSync.syncPersonData(personName, {
        fullSync: isFullSync
      });

      console.log('\n✅ Sync completed successfully!');
      console.log(`📊 Results:`);
      console.log(`   Accounts synced: ${result.accounts.synced}`);
      console.log(`   Positions synced: ${result.positions.synced}`);
      console.log(`   Activities synced: ${result.activities.synced}`);
      
      if (result.snapshots) {
        console.log(`   Snapshot created: ${result.snapshots.created ? 'Yes' : 'No'}`);
      }

      // Show errors if any
      const totalErrors = result.accounts.errors.length + 
                         result.positions.errors.length + 
                         result.activities.errors.length;

      if (totalErrors > 0) {
        console.log(`\n⚠️  ${totalErrors} error(s) occurred during sync:`);
        
        [...result.accounts.errors, ...result.positions.errors, ...result.activities.errors]
          .slice(0, 5) // Show first 5 errors
          .forEach(error => console.log(`   - ${error.error}`));
          
        if (totalErrors > 5) {
          console.log(`   ... and ${totalErrors - 5} more errors`);
        }
      }

    } catch (error) {
      console.log('❌ Sync failed:', error.message);
      
      if (error.message.includes('token')) {
        console.log('💡 This appears to be a token issue. Try updating the refresh token.');
      } else if (error.message.includes('connection')) {
        console.log('💡 This appears to be a connection issue. Check your internet connection.');
      }
    }
  }

  // ... (other methods remain the same)

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
              // await this.removePerson(); // Not implemented in this snippet
              console.log('Remove person feature - use original setup.js');
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
              // await this.databaseUtilities(); // Not implemented in this snippet
              console.log('Database utilities - use original setup.js');
              break;
            case '8':
              running = false;
              break;
            default:
              console.log('❌ Invalid choice. Please select 1-8.');
              break;
          }

          if (running) {
            await question('\nPress Enter to continue...');
          }

        } catch (error) {
          console.log('\n❌ An error occurred:', error.message);
          console.log('Stack trace:', error.stack);
          await question('\nPress Enter to continue...');
        }
      }

      console.log('\n👋 Setup completed!');
      console.log('🚀 Your portfolio manager is ready to use!');
      console.log('\nNext steps:');
      console.log('- Start your server: npm start');
      console.log('- Test with: npm run health');

    } catch (error) {
      console.error('❌ Setup failed:', error.message);
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
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n⏹️  Setup interrupted by user');
    rl.close();
    await mongoose.connection.close();
    process.exit(0);
  });
  
  setup.run().catch(error => {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  });
}

module.exports = PortfolioSetup;