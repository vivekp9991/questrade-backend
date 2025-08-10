// scripts/syncData.js
const mongoose = require('mongoose');
const dataSync = require('../services/dataSync');
const Person = require('../models/Person');
const logger = require('../services/logger');

// CLI argument parsing
const args = process.argv.slice(2);
const options = {
  person: null,
  fullSync: false,
  force: false,
  help: false,
  all: false,
  status: false
};

// Parse command line arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  switch (arg) {
    case '--person':
    case '-p':
      options.person = args[i + 1];
      i++; // Skip next argument as it's the value
      break;
    case '--full':
    case '-f':
      options.fullSync = true;
      break;
    case '--force':
      options.force = true;
      break;
    case '--all':
    case '-a':
      options.all = true;
      break;
    case '--status':
    case '-s':
      options.status = true;
      break;
    case '--help':
    case '-h':
      options.help = true;
      break;
    default:
      if (!arg.startsWith('-')) {
        // Assume it's a person name if no flag specified
        options.person = arg;
      }
      break;
  }
}

// Help text
function showHelp() {
  console.log(`
Portfolio Data Sync Tool

Usage: node scripts/syncData.js [options]

Options:
  -p, --person <name>    Sync data for specific person
  -a, --all             Sync data for all persons
  -f, --full            Perform full sync (default: incremental)
  -s, --status          Show sync status for all persons
  --force               Force sync even if already in progress
  -h, --help            Show this help message

Examples:
  node scripts/syncData.js --person "Vicky" --full
  node scripts/syncData.js --all
  node scripts/syncData.js --status
  node scripts/syncData.js "DV" --full
  
Environment Variables:
  MONGODB_URI           MongoDB connection string
  LOG_LEVEL            Logging level (debug, info, warn, error)
`);
}

async function connectDatabase() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    process.exit(1);
  }
}

async function showSyncStatus() {
  try {
    console.log('\n=== Sync Status Report ===\n');
    
    const statuses = await dataSync.getAllSyncStatuses();
    
    if (statuses.length === 0) {
      console.log('No persons found in the system.');
      return;
    }

    statuses.forEach(status => {
      console.log(`Person: ${status.personName}`);
      console.log(`  Last Sync: ${status.lastSyncTime ? new Date(status.lastSyncTime).toLocaleString() : 'Never'}`);
      console.log(`  Status: ${status.lastSyncStatus || 'Unknown'}`);
      console.log(`  In Progress: ${status.isInProgress ? 'Yes' : 'No'}`);
      
      if (status.lastSyncError) {
        console.log(`  Last Error: ${status.lastSyncError}`);
      }
      
      if (status.counts) {
        console.log(`  Data Counts:`);
        console.log(`    Accounts: ${status.counts.accounts}`);
        console.log(`    Positions: ${status.counts.positions}`);
        console.log(`    Activities: ${status.counts.activities}`);
      }
      
      console.log('');
    });

    // Summary
    const successfulSyncs = statuses.filter(s => s.lastSyncStatus === 'success').length;
    const failedSyncs = statuses.filter(s => s.lastSyncStatus === 'failed').length;
    const inProgress = statuses.filter(s => s.isInProgress).length;
    
    console.log('=== Summary ===');
    console.log(`Total Persons: ${statuses.length}`);
    console.log(`Successful Syncs: ${successfulSyncs}`);
    console.log(`Failed Syncs: ${failedSyncs}`);
    console.log(`In Progress: ${inProgress}`);

  } catch (error) {
    console.error('Failed to get sync status:', error.message);
    process.exit(1);
  }
}

async function syncPersonData(personName) {
  try {
    console.log(`\nStarting sync for person: ${personName}`);
    console.log(`Full sync: ${options.fullSync ? 'Yes' : 'No'}`);
    console.log(`Force: ${options.force ? 'Yes' : 'No'}`);
    
    // Check if person exists
    const person = await Person.findOne({ name: personName });
    if (!person) {
      console.error(`Person "${personName}" not found.`);
      console.log('\nAvailable persons:');
      const allPersons = await Person.find({}, { name: 1 });
      allPersons.forEach(p => console.log(`  - ${p.name}`));
      process.exit(1);
    }

    // Check if sync is already in progress
    const currentStatus = await dataSync.getSyncStatus(personName);
    if (currentStatus?.isInProgress && !options.force) {
      console.error(`Sync already in progress for ${personName}. Use --force to override.`);
      process.exit(1);
    }

    if (options.force && currentStatus?.isInProgress) {
      console.log('Force stopping current sync...');
      await dataSync.stopSync(personName);
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const startTime = Date.now();
    
    const result = await dataSync.syncPersonData(personName, {
      fullSync: options.fullSync,
      forceRefresh: options.force
    });

    const duration = Date.now() - startTime;
    
    console.log('\n=== Sync Results ===');
    console.log(`Duration: ${(duration / 1000).toFixed(2)} seconds`);
    console.log(`Accounts synced: ${result.accounts.synced}`);
    console.log(`Positions synced: ${result.positions.synced}`);
    console.log(`Activities synced: ${result.activities.synced}`);
    console.log(`Snapshot created: ${result.snapshots.created ? 'Yes' : 'No'}`);
    
    if (result.accounts.errors.length > 0) {
      console.log('\nAccount Errors:');
      result.accounts.errors.forEach(error => {
        console.log(`  - ${error.accountId || 'General'}: ${error.error}`);
      });
    }
    
    if (result.positions.errors.length > 0) {
      console.log('\nPosition Errors:');
      result.positions.errors.forEach(error => {
        console.log(`  - ${error.accountId || 'General'}: ${error.error}`);
      });
    }
    
    if (result.activities.errors.length > 0) {
      console.log('\nActivity Errors:');
      result.activities.errors.forEach(error => {
        console.log(`  - ${error.accountId || 'General'}: ${error.error}`);
      });
    }

    if (result.snapshots.error) {
      console.log(`\nSnapshot Error: ${result.snapshots.error}`);
    }

    console.log('\nSync completed successfully!');

  } catch (error) {
    console.error('\nSync failed:', error.message);
    
    if (error.message.includes('token') || error.message.includes('401')) {
      console.log('\nToken-related error detected. Possible solutions:');
      console.log('1. Check if refresh token is valid');
      console.log('2. Run setup script to update tokens');
      console.log('3. Verify Questrade API access');
    }
    
    process.exit(1);
  }
}

async function syncAllPersons() {
  try {
    console.log('\nStarting sync for all persons...');
    console.log(`Full sync: ${options.fullSync ? 'Yes' : 'No'}`);
    
    const persons = await Person.find({ isActive: true });
    
    if (persons.length === 0) {
      console.log('No active persons found.');
      return;
    }

    console.log(`Found ${persons.length} active persons:`);
    persons.forEach(person => console.log(`  - ${person.name}`));
    
    const startTime = Date.now();
    
    const results = await dataSync.syncAllPersons({
      fullSync: options.fullSync,
      continueOnError: true
    });

    const duration = Date.now() - startTime;
    
    console.log('\n=== Overall Results ===');
    console.log(`Total duration: ${(duration / 1000).toFixed(2)} seconds`);
    console.log(`Persons processed: ${results.length}`);
    
    const successful = results.filter(r => r.success !== false);
    const failed = results.filter(r => r.success === false);
    
    console.log(`Successful: ${successful.length}`);
    console.log(`Failed: ${failed.length}`);
    
    if (successful.length > 0) {
      console.log('\n=== Successful Syncs ===');
      successful.forEach(result => {
        console.log(`${result.personName}:`);
        console.log(`  Accounts: ${result.accounts?.synced || 0}`);
        console.log(`  Positions: ${result.positions?.synced || 0}`);
        console.log(`  Activities: ${result.activities?.synced || 0}`);
      });
    }
    
    if (failed.length > 0) {
      console.log('\n=== Failed Syncs ===');
      failed.forEach(result => {
        console.log(`${result.personName}: ${result.error}`);
      });
    }

    console.log('\nAll syncs completed!');

  } catch (error) {
    console.error('\nBatch sync failed:', error.message);
    process.exit(1);
  }
}

async function main() {
  // Show help if requested or no arguments provided
  if (options.help || args.length === 0) {
    showHelp();
    return;
  }

  // Connect to database
  await connectDatabase();

  try {
    if (options.status) {
      await showSyncStatus();
    } else if (options.all) {
      await syncAllPersons();
    } else if (options.person) {
      await syncPersonData(options.person);
    } else {
      console.error('Please specify either --person <name>, --all, or --status');
      showHelp();
      process.exit(1);
    }
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Cleaning up...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM. Cleaning up...');
  await mongoose.connection.close();
  process.exit(0);
});

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

module.exports = {
  syncPersonData,
  syncAllPersons,
  showSyncStatus,
  options
};