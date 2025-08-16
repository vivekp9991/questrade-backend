// scripts/refreshBalances.js - Force refresh account balances from Questrade
const mongoose = require('mongoose');
const Person = require('../models/Person');
const Account = require('../models/Account');
const AccountSync = require('../services/dataSync/accountSync');
const logger = require('../utils/logger');
require('dotenv').config();

// CLI argument parsing
const args = process.argv.slice(2);
const options = {
  person: null,
  account: null,
  all: false,
  help: false,
  verbose: false
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
    case '--account':
    case '-a':
      options.account = args[i + 1];
      i++; // Skip next argument as it's the value
      break;
    case '--all':
      options.all = true;
      break;
    case '--verbose':
    case '-v':
      options.verbose = true;
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
Balance Refresh Tool

Usage: node scripts/refreshBalances.js [options]

Options:
  -p, --person <name>    Refresh balances for specific person
  -a, --account <id>     Refresh balance for specific account ID
  --all                  Refresh balances for all persons
  -v, --verbose          Show detailed output
  -h, --help             Show this help message

Examples:
  node scripts/refreshBalances.js --person "Vivek"
  node scripts/refreshBalances.js --account "40058790"
  node scripts/refreshBalances.js --all --verbose
  node scripts/refreshBalances.js "Vivek" --verbose
  
This tool will fetch the latest cash balances from Questrade API and update the database.
`);
}

async function connectDatabase() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error.message);
    process.exit(1);
  }
}

async function refreshBalancesForPerson(personName, verbose = false) {
  try {
    console.log(`\n🔄 Refreshing balances for person: ${personName}`);
    
    // Check if person exists
    const person = await Person.findOne({ personName });
    if (!person) {
      console.error(`❌ Person "${personName}" not found.`);
      
      // Show available persons
      const allPersons = await Person.find({}, { personName: 1 });
      if (allPersons.length > 0) {
        console.log('\nAvailable persons:');
        allPersons.forEach(p => console.log(`  - ${p.personName}`));
      }
      return false;
    }

    if (!person.isActive) {
      console.error(`❌ Person "${personName}" is not active.`);
      return false;
    }

    // Get current accounts before refresh
    const accountsBefore = await Account.find({ personName }).lean();
    console.log(`📊 Found ${accountsBefore.length} accounts for ${personName}`);

    if (verbose) {
      console.log('\nCurrent cash balances:');
      accountsBefore.forEach(account => {
        const cashBalance = account.balances?.combinedBalances?.cash || 0;
        const currency = account.balances?.combinedBalances?.currency || 'CAD';
        console.log(`  ${account.accountId} (${account.type}): ${currency} $${cashBalance.toFixed(2)}`);
      });
    }

    // Refresh balances using AccountSync
    const accountSync = new AccountSync();
    const startTime = Date.now();
    
    const result = await accountSync.refreshAllAccountBalances(personName);
    
    const duration = Date.now() - startTime;
    
    // Get updated accounts
    const accountsAfter = await Account.find({ personName }).lean();
    
    console.log('\n✅ Balance refresh completed!');
    console.log(`⏱️  Duration: ${(duration / 1000).toFixed(2)} seconds`);
    console.log(`📈 Updated: ${result.updated} accounts`);
    
    if (result.errors.length > 0) {
      console.log(`❌ Errors: ${result.errors.length}`);
      result.errors.forEach(error => {
        console.log(`   - Account ${error.accountId}: ${error.error}`);
      });
    }

    // Show updated balances
    console.log('\nUpdated cash balances:');
    let totalCashCAD = 0;
    let totalCashUSD = 0;
    
    accountsAfter.forEach(account => {
      const balances = account.balances;
      if (balances && balances.perCurrencyBalances) {
        console.log(`\n  Account: ${account.accountId} (${account.type})`);
        balances.perCurrencyBalances.forEach(balance => {
          console.log(`    ${balance.currency}: Cash=$${balance.cash?.toFixed(2) || 0}, Market=$${balance.marketValue?.toFixed(2) || 0}, Total=$${balance.totalEquity?.toFixed(2) || 0}`);
          
          // Add to totals
          if (balance.currency === 'CAD') {
            totalCashCAD += balance.cash || 0;
          } else if (balance.currency === 'USD') {
            totalCashUSD += balance.cash || 0;
          }
        });
      } else {
        const cashBalance = account.balances?.combinedBalances?.cash || 0;
        const currency = account.balances?.combinedBalances?.currency || 'CAD';
        console.log(`  ${account.accountId} (${account.type}): ${currency} $${cashBalance.toFixed(2)}`);
        
        if (currency === 'CAD') {
          totalCashCAD += cashBalance;
        } else if (currency === 'USD') {
          totalCashUSD += cashBalance;
        }
      }
    });

    console.log('\n💰 Total Cash Balances:');
    if (totalCashCAD !== 0) console.log(`   CAD: $${totalCashCAD.toFixed(2)}`);
    if (totalCashUSD !== 0) console.log(`   USD: $${totalCashUSD.toFixed(2)}`);

    return true;
  } catch (error) {
    console.error(`❌ Error refreshing balances for ${personName}:`, error.message);
    if (verbose) {
      console.error('Stack trace:', error.stack);
    }
    return false;
  }
}

async function refreshBalancesForAccount(accountId, verbose = false) {
  try {
    console.log(`\n🔄 Refreshing balance for account: ${accountId}`);
    
    // Find the account
    const account = await Account.findOne({ accountId });
    if (!account) {
      console.error(`❌ Account "${accountId}" not found.`);
      return false;
    }

    console.log(`📊 Account belongs to: ${account.personName} (${account.type})`);

    // Show current balance
    if (verbose) {
      const currentBalance = account.balances?.combinedBalances?.cash || 0;
      const currency = account.balances?.combinedBalances?.currency || 'CAD';
      console.log(`Current balance: ${currency} $${currentBalance.toFixed(2)}`);
    }

    // Refresh balance using AccountSync
    const accountSync = new AccountSync();
    const startTime = Date.now();
    
    const result = await accountSync.refreshAccountBalances(account.personName, accountId);
    
    const duration = Date.now() - startTime;
    
    // Get updated account
    const updatedAccount = await Account.findOne({ accountId });
    
    console.log('\n✅ Balance refresh completed!');
    console.log(`⏱️  Duration: ${(duration / 1000).toFixed(2)} seconds`);
    
    if (result.errors.length > 0) {
      console.log(`❌ Errors: ${result.errors.length}`);
      result.errors.forEach(error => {
        console.log(`   - ${error.error}`);
      });
    } else {
      // Show updated balance
      const balances = updatedAccount.balances;
      if (balances && balances.perCurrencyBalances) {
        console.log('\nUpdated balances:');
        balances.perCurrencyBalances.forEach(balance => {
          console.log(`  ${balance.currency}: Cash=$${balance.cash?.toFixed(2) || 0}, Market=$${balance.marketValue?.toFixed(2) || 0}, Total=$${balance.totalEquity?.toFixed(2) || 0}`);
        });
      } else {
        const cashBalance = balances?.combinedBalances?.cash || 0;
        const currency = balances?.combinedBalances?.currency || 'CAD';
        console.log(`Updated balance: ${currency} $${cashBalance.toFixed(2)}`);
      }
    }

    return result.errors.length === 0;
  } catch (error) {
    console.error(`❌ Error refreshing balance for account ${accountId}:`, error.message);
    if (verbose) {
      console.error('Stack trace:', error.stack);
    }
    return false;
  }
}

async function refreshAllBalances(verbose = false) {
  try {
    console.log('\n🔄 Refreshing balances for all persons...');
    
    const persons = await Person.find({ isActive: true });
    if (persons.length === 0) {
      console.log('❌ No active persons found.');
      return false;
    }

    console.log(`📊 Found ${persons.length} active persons:`);
    persons.forEach(person => console.log(`   - ${person.personName}`));
    
    let totalSuccess = 0;
    let totalErrors = 0;
    const startTime = Date.now();
    
    for (const person of persons) {
      console.log(`\n${'='.repeat(50)}`);
      const success = await refreshBalancesForPerson(person.personName, verbose);
      if (success) {
        totalSuccess++;
      } else {
        totalErrors++;
      }
    }
    
    const totalDuration = Date.now() - startTime;
    
    console.log(`\n${'='.repeat(50)}`);
    console.log('🎉 All balance refresh completed!');
    console.log(`⏱️  Total duration: ${(totalDuration / 1000).toFixed(2)} seconds`);
    console.log(`✅ Successful: ${totalSuccess}/${persons.length} persons`);
    if (totalErrors > 0) {
      console.log(`❌ Failed: ${totalErrors}/${persons.length} persons`);
    }

    return totalErrors === 0;
  } catch (error) {
    console.error('❌ Error during bulk balance refresh:', error.message);
    return false;
  }
}

async function main() {
  // Show help if requested or no arguments provided
  if (options.help) {
    showHelp();
    return;
  }

  // Connect to database
  await connectDatabase();

  try {
    if (options.all) {
      await refreshAllBalances(options.verbose);
    } else if (options.account) {
      await refreshBalancesForAccount(options.account, options.verbose);
    } else if (options.person) {
      await refreshBalancesForPerson(options.person, options.verbose);
    } else {
      console.error('❌ Please specify --person <name>, --account <id>, or --all');
      console.log('Use --help for more information.');
      process.exit(1);
    }
  } finally {
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n⏹️  Balance refresh interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Balance refresh terminated');
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
    console.error('❌ Script failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  refreshBalancesForPerson,
  refreshBalancesForAccount,
  refreshAllBalances
};