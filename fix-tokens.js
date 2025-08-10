// fix-tokens.js - Script to fix corrupted tokens and test encryption
const mongoose = require('mongoose');
require('dotenv').config();

async function fixTokens() {
  try {
    console.log('🔧 Fixing Token Encryption Issues');
    console.log('==================================\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('✅ Connected to MongoDB\n');

    // Load the fixed Token model
    const Token = require('./models/Token');
    const Person = require('./models/Person');

    // 1. Test encryption functionality first
    console.log('1. Testing encryption functionality...');
    const encryptionTest = Token.testEncryption();
    
    if (!encryptionTest.success) {
      console.log('❌ Encryption test failed. Check your ENCRYPTION_KEY environment variable.');
      console.log('   Current ENCRYPTION_KEY length:', process.env.ENCRYPTION_KEY ? process.env.ENCRYPTION_KEY.length : 'NOT SET');
      console.log('   Required: 32 characters for AES-256');
      
      if (!process.env.ENCRYPTION_KEY) {
        console.log('\n💡 To fix this, add to your .env file:');
        console.log('   ENCRYPTION_KEY=your_32_character_key_here_123456');
      }
      process.exit(1);
    }
    console.log('✅ Encryption test passed\n');

    // 2. Check current token situation
    console.log('2. Analyzing current tokens...');
    const allTokens = await Token.find({});
    console.log(`📊 Found ${allTokens.length} total token(s)\n`);

    if (allTokens.length === 0) {
      console.log('📝 No tokens found. This is normal for a fresh setup.');
      console.log('   Run setup.js to add your first person and token.');
      process.exit(0);
    }

    // Group tokens by status
    const tokenStats = {
      active: 0,
      inactive: 0,
      oldFormat: 0,
      corrupted: 0,
      valid: 0
    };

    const problemTokens = [];

    for (const token of allTokens) {
      if (token.isActive) {
        tokenStats.active++;
      } else {
        tokenStats.inactive++;
      }

      // Check if token is in old format (missing IV)
      if (!token.iv) {
        tokenStats.oldFormat++;
        problemTokens.push({
          token,
          issue: 'Old format (missing IV)'
        });
        continue;
      }

      // Check if token can be decrypted
      if (!token.validateDecryption()) {
        tokenStats.corrupted++;
        problemTokens.push({
          token,
          issue: 'Decryption failed'
        });
      } else {
        tokenStats.valid++;
      }
    }

    console.log('📊 Token Analysis:');
    console.log(`   Active: ${tokenStats.active}`);
    console.log(`   Inactive: ${tokenStats.inactive}`);
    console.log(`   Valid: ${tokenStats.valid}`);
    console.log(`   Old Format: ${tokenStats.oldFormat}`);
    console.log(`   Corrupted: ${tokenStats.corrupted}`);
    console.log(`   Problem Tokens: ${problemTokens.length}\n`);

    // 3. Show problem tokens
    if (problemTokens.length > 0) {
      console.log('3. Problem tokens found:');
      problemTokens.forEach((pt, index) => {
        console.log(`   ${index + 1}. ${pt.token.personName} (${pt.token.type}) - ${pt.issue}`);
        if (pt.token.lastError) {
          console.log(`      Last Error: ${pt.token.lastError}`);
        }
      });
      console.log();

      // 4. Fix the problems
      console.log('4. Fixing problem tokens...');
      
      // Ask for confirmation
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise((resolve) => {
        rl.question('Do you want to deactivate corrupted tokens? (y/n): ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() === 'y') {
        let fixedCount = 0;

        for (const pt of problemTokens) {
          try {
            await Token.findByIdAndUpdate(pt.token._id, {
              isActive: false,
              lastError: `Token fixed on ${new Date().toISOString()}: ${pt.issue}`,
              updatedAt: new Date()
            });
            fixedCount++;
          } catch (error) {
            console.log(`   ❌ Failed to fix token for ${pt.token.personName}: ${error.message}`);
          }
        }

        console.log(`✅ Deactivated ${fixedCount} problem tokens\n`);

        // Update person records
        console.log('5. Updating person records...');
        const affectedPersons = [...new Set(problemTokens.map(pt => pt.token.personName))];
        
        for (const personName of affectedPersons) {
          try {
            await Person.findOneAndUpdate(
              { personName },
              {
                hasValidToken: false,
                lastSyncError: 'Tokens were corrupted and deactivated. Please update refresh token.',
                updatedAt: new Date()
              }
            );
            console.log(`   ✅ Updated person record: ${personName}`);
          } catch (error) {
            console.log(`   ❌ Failed to update person ${personName}: ${error.message}`);
          }
        }

      } else {
        console.log('❌ Fix cancelled by user.');
      }
    } else {
      console.log('3. ✅ No problem tokens found! All tokens are valid.\n');
    }

    // 6. Final status
    console.log('6. Final Status:');
    const finalTokens = await Token.find({ isActive: true });
    const validFinalTokens = finalTokens.filter(t => t.validateDecryption());
    
    console.log(`   Active tokens: ${finalTokens.length}`);
    console.log(`   Valid tokens: ${validFinalTokens.length}`);
    
    if (validFinalTokens.length === 0) {
      console.log('\n🔧 Next Steps:');
      console.log('   1. All tokens need to be refreshed');
      console.log('   2. Run: node setup.js');
      console.log('   3. Choose option 2: "Update existing person\'s token"');
      console.log('   4. Enter a fresh refresh token from Questrade');
      console.log('   5. Get fresh tokens from: https://login.questrade.com/APIAccess/UserApps.aspx');
    } else {
      console.log('\n✅ You have valid tokens! Your system should work correctly now.');
    }

    // 7. Test with a valid token if available
    if (validFinalTokens.length > 0) {
      console.log('\n7. Testing token functionality...');
      const testToken = validFinalTokens[0];
      const decrypted = testToken.getDecryptedToken();
      
      if (decrypted && decrypted.length > 0) {
        console.log(`✅ Token decryption test passed for ${testToken.personName}`);
        console.log(`   Token type: ${testToken.type}`);
        console.log(`   Token length: ${decrypted.length} characters`);
        console.log(`   Expires: ${testToken.expiresAt}`);
      } else {
        console.log(`❌ Token decryption test failed for ${testToken.personName}`);
      }
    }

  } catch (error) {
    console.error('❌ Token fix failed:', error.message);
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
  console.log('\n⏹️  Token fix interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the fix
if (require.main === module) {
  fixTokens();
}

module.exports = fixTokens;