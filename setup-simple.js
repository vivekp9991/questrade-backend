// setup-simple.js
const mongoose = require('mongoose');
const readline = require('readline');
const crypto = require('crypto');

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

// Utility function for secure password input (hidden)
function questionHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    let input = '';
    process.stdin.on('data', function(char) {
      char = char + '';
      
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '\u0003':
          process.exit();
          break;
        case '\u007f': // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          input += char;
          process.stdout.write('*');
          break;
      }
    });
  });
}

// Simple models without complex dependencies
const PersonSchema = new mongoose.Schema({
  personName: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastSyncTime: Date,
  lastSyncStatus: String,
  lastSyncError: String,
  settings: {
    currency: { type: String, default: 'CAD' },
    timezone: { type: String, default: 'America/Toronto' }
  }
});

const TokenSchema = new mongoose.Schema({
  personName: { type: String, required: true, unique: true },
  refreshToken: { type: String, required: true },
  accessToken: String,
  accessTokenExpiry: Date,
  lastRefreshed: Date,
  createdAt: { type: Date, default: Date.now }
});

// Fixed encryption for tokens
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
const IV_LENGTH = 16;
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = textParts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Pre-save hook to encrypt refresh token
TokenSchema.pre('save', function(next) {
  if (this.isModified('refreshToken')) {
    this.refreshToken = encrypt(this.refreshToken);
  }
  next();
});

// Method to decrypt refresh token when needed
TokenSchema.methods.getDecryptedRefreshToken = function() {
  return decrypt(this.refreshToken);
};

const Person = mongoose.model('Person', PersonSchema);
const Token = mongoose.model('Token', TokenSchema);

class SimpleSetup {
  constructor() {
    this.mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
  }

  async connectDatabase() {
    try {
      await mongoose.connect(this.mongoUri);
      console.log('✓ Connected to MongoDB');
    } catch (error) {
      console.error('✗ Failed to connect to MongoDB:', error.message);
      console.log('\nMake sure MongoDB is running:');
      console.log('- Install MongoDB: https://www.mongodb.com/try/download/community');
      console.log('- Start MongoDB service');
      console.log('- Or use MongoDB Atlas cloud database');
      throw error;
    }
  }

  async showWelcome() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    Portfolio Manager Setup                     ║
║                                                                ║
║  This setup wizard will help you configure your first         ║
║  Questrade account for portfolio management.                  ║
║                                                                ║
║  You'll need a Questrade refresh token. Get it from:          ║
║  https://login.questrade.com/APIAccess/UserApps.aspx          ║
╚════════════════════════════════════════════════════════════════╝
`);
  }

  async validateRefreshToken(refreshToken) {
    // Simple validation - check if it looks like a valid token
    if (!refreshToken || refreshToken.length < 20) {
      throw new Error('Refresh token appears to be invalid (too short)');
    }
    
    // Additional validation could be added here
    return true;
  }

  async addFirstPerson() {
    console.log('\n=== Add First Person ===');
    
    // Check if any persons already exist
    const existingPersons = await Person.find({});
    if (existingPersons.length > 0) {
      console.log('Existing persons found:');
      existingPersons.forEach(person => {
        console.log(`  - ${person.personName} (created: ${person.createdAt.toLocaleDateString()})`);
      });
      console.log('\nIf you want to add another person, use the full setup.js script.');
      
      const addAnother = await question('Do you want to add another person anyway? (y/n): ');
      if (addAnother.toLowerCase() !== 'y') {
        return false;
      }
    }

    // Get person name
    const personName = await question('Enter person name: ');
    if (!personName.trim()) {
      console.log('✗ Person name cannot be empty');
      return false;
    }

    // Check if person already exists
    const existingPerson = await Person.findOne({ personName: personName.trim() });
    if (existingPerson) {
      console.log(`✗ Person "${personName}" already exists`);
      const update = await question('Do you want to update their token instead? (y/n): ');
      if (update.toLowerCase() === 'y') {
        return this.updatePersonToken(personName.trim());
      }
      return false;
    }

    // Get refresh token
    console.log('\nTo get your refresh token:');
    console.log('1. Go to: https://login.questrade.com/APIAccess/UserApps.aspx');
    console.log('2. Log in to your Questrade account');
    console.log('3. Click "Generate Token"');
    console.log('4. Copy the refresh token\n');
    
    const refreshToken = await questionHidden('Enter Questrade refresh token (hidden): ');
    
    if (!refreshToken.trim()) {
      console.log('✗ Refresh token cannot be empty');
      return false;
    }

    try {
      console.log('\n⏳ Setting up person and token...');

      // Validate token format
      await this.validateRefreshToken(refreshToken);
      console.log('✓ Token format looks valid');

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

      // Create token record (will be automatically encrypted)
      const token = new Token({
        personName: personName.trim(),
        refreshToken: refreshToken.trim(),
        createdAt: new Date()
      });

      await token.save();
      console.log('✓ Token saved and encrypted securely');

      console.log(`\n✅ Successfully set up: ${personName}`);
      console.log('\n🎉 Next steps:');
      console.log('1. Start your backend server: npm start');
      console.log('2. Test the connection: curl http://localhost:4000/health');
      console.log('3. Test API endpoints with Postman');
      console.log(`4. Sync your data: POST /api/sync/person/${personName}`);
      console.log('\nOr run the full setup script: node setup.js');

      return true;

    } catch (error) {
      console.log('✗ Setup failed:', error.message);
      
      // Cleanup on failure
      try {
        await Person.deleteOne({ personName: personName });
        await Token.deleteOne({ personName: personName });
        console.log('✓ Cleaned up partial setup');
      } catch (cleanupError) {
        console.log('⚠ Failed to cleanup partial setup:', cleanupError.message);
      }
      
      return false;
    }
  }

  async updatePersonToken(personName) {
    try {
      const person = await Person.findOne({ personName });
      if (!person) {
        console.log(`✗ Person "${personName}" not found`);
        return false;
      }

      console.log(`\nUpdating token for: ${personName}`);
      console.log('Get your refresh token from: https://login.questrade.com/APIAccess/UserApps.aspx');
      const refreshToken = await questionHidden('Enter new Questrade refresh token (hidden): ');

      if (!refreshToken.trim()) {
        console.log('✗ Refresh token cannot be empty');
        return false;
      }

      console.log('\n⏳ Validating and updating token...');

      // Validate token format
      await this.validateRefreshToken(refreshToken);

      // Update or create token
      const existingToken = await Token.findOne({ personName });
      if (existingToken) {
        existingToken.refreshToken = refreshToken.trim();
        existingToken.lastRefreshed = new Date();
        await existingToken.save();
      } else {
        const newToken = new Token({
          personName,
          refreshToken: refreshToken.trim(),
          createdAt: new Date()
        });
        await newToken.save();
      }

      console.log('✓ Token updated and encrypted successfully');
      console.log(`\n✅ Successfully updated token for: ${personName}`);

      return true;

    } catch (error) {
      console.log('✗ Token update failed:', error.message);
      return false;
    }
  }

  async showStatus() {
    console.log('\n=== Current Status ===');
    
    try {
      const persons = await Person.find({});
      const tokens = await Token.find({});
      
      if (persons.length === 0) {
        console.log('No persons configured yet.');
        return;
      }

      console.log(`Found ${persons.length} person(s):`);
      
      for (const person of persons) {
        const token = tokens.find(t => t.personName === person.personName);
        console.log(`\n📊 ${person.personName}`);
        console.log(`   Created: ${person.createdAt.toLocaleDateString()}`);
        console.log(`   Active: ${person.isActive ? 'Yes' : 'No'}`);
        console.log(`   Token: ${token ? '✓ Present (encrypted)' : '✗ Missing'}`);
        
        if (person.lastSyncTime) {
          console.log(`   Last Sync: ${person.lastSyncTime.toLocaleString()}`);
          console.log(`   Sync Status: ${person.lastSyncStatus || 'Unknown'}`);
        } else {
          console.log(`   Last Sync: Never`);
        }

        if (person.lastSyncError) {
          console.log(`   Last Error: ${person.lastSyncError}`);
        }
      }

      // Summary
      const personsWithTokens = persons.filter(p => 
        tokens.some(t => t.personName === p.personName)
      ).length;
      
      console.log('\n=== Summary ===');
      console.log(`Total Persons: ${persons.length}`);
      console.log(`With Tokens: ${personsWithTokens}`);
      console.log(`Ready for Sync: ${personsWithTokens}`);
      
    } catch (error) {
      console.log('✗ Failed to get status:', error.message);
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

      const personCount = await Person.countDocuments();
      const tokenCount = await Token.countDocuments();

      await Person.deleteMany({});
      await Token.deleteMany({});
      
      console.log(`✓ Deleted ${personCount} persons`);
      console.log(`✓ Deleted ${tokenCount} tokens`);
      console.log('✓ Database cleared successfully');

    } catch (error) {
      console.log('✗ Failed to clear data:', error.message);
    }
  }

  async testTokenDecryption() {
    console.log('\n=== Test Token Encryption/Decryption ===');
    
    try {
      const tokens = await Token.find({});
      
      if (tokens.length === 0) {
        console.log('No tokens found to test.');
        return;
      }

      for (const token of tokens) {
        try {
          const decryptedToken = token.getDecryptedRefreshToken();
          console.log(`✓ ${token.personName}: Token encryption/decryption working`);
          console.log(`   Encrypted length: ${token.refreshToken.length} chars`);
          console.log(`   Decrypted length: ${decryptedToken.length} chars`);
        } catch (decryptError) {
          console.log(`✗ ${token.personName}: Decryption failed - ${decryptError.message}`);
        }
      }
      
    } catch (error) {
      console.log('✗ Test failed:', error.message);
    }
  }

  async showMainMenu() {
    console.log('\n=== Simple Setup Menu ===');
    console.log('1. Add first person and token');
    console.log('2. Update existing person\'s token');
    console.log('3. Show current status');
    console.log('4. Test token encryption');
    console.log('5. Clear all data (DANGEROUS)');
    console.log('6. Exit');
    
    const choice = await question('\nSelect an option (1-6): ');
    return choice.trim();
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
              await this.addFirstPerson();
              break;
            case '2':
              const persons = await Person.find({}, { personName: 1 });
              if (persons.length === 0) {
                console.log('No persons found. Please add a person first.');
              } else {
                console.log('\nExisting persons:');
                persons.forEach((person, index) => {
                  console.log(`${index + 1}. ${person.personName}`);
                });
                const choice = await question('\nSelect person number: ');
                const personIndex = parseInt(choice) - 1;
                if (personIndex >= 0 && personIndex < persons.length) {
                  await this.updatePersonToken(persons[personIndex].personName);
                } else {
                  console.log('✗ Invalid selection');
                }
              }
              break;
            case '3':
              await this.showStatus();
              break;
            case '4':
              await this.testTokenDecryption();
              break;
            case '5':
              await this.clearAllData();
              break;
            case '6':
              running = false;
              break;
            default:
              console.log('Invalid choice. Please select 1-6.');
              break;
          }

          if (running) {
            await question('\nPress Enter to continue...');
          }

        } catch (error) {
          console.log('\n✗ An error occurred:', error.message);
          console.log('Stack trace:', error.stack);
          await question('\nPress Enter to continue...');
        }
      }

      console.log('\n👋 Setup completed!');
      console.log('\n🚀 Ready to start your portfolio manager!');
      console.log('Run: npm start');

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
  const setup = new SimpleSetup();
  setup.run().catch(error => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

module.exports = SimpleSetup;