// fix-questrade-token.js - Recovery script for invalid token issues
const mongoose = require('mongoose');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function questionHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    let input = '';
    let isComplete = false;
    
    const originalListeners = process.stdin.listeners('data');
    process.stdin.removeAllListeners('data');
    
    function dataHandler(char) {
      if (isComplete) return;
      
      char = char.toString();
      
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          isComplete = true;
          cleanup();
          resolve(input.trim());
          break;
          
        case '\u0003':
          cleanup();
          process.exit();
          break;
          
        case '\u007f':
        case '\b':
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
          
        default:
          const charCode = char.charCodeAt(0);
          if (charCode >= 32 && charCode <= 126) {
            input += char;
            process.stdout.write('*');
          }
          break;
      }
    }
    
    function cleanup() {
      process.stdin.removeListener('data', dataHandler);
      process.stdin.setRawMode(false);
      originalListeners.forEach(listener => {
        process.stdin.on('data', listener);
      });
      process.stdout.write('\n');
    }
    
    process.stdin.on('data', dataHandler);
  });
}

async function testRefreshToken(token) {
  try {
    console.log('\n🔍 Testing refresh token with Questrade API...');
    
    // Clean the token
    const cleanToken = token.trim();
    console.log(`   Token length: ${cleanToken.length} characters`);
    console.log(`   First 4 chars: ${cleanToken.substring(0, 4)}...`);
    console.log(`   Last 4 chars: ...${cleanToken.substring(cleanToken.length - 4)}`);
    
    // Make the API call using GET (as per Questrade documentation)
    const response = await axios.get('https://login.questrade.com/oauth2/token', {
      params: {
        grant_type: 'refresh_token',
        refresh_token: cleanToken
      },
      timeout: 15000,
      validateStatus: function (status) {
        return status < 500; // Don't throw on 4xx errors
      }
    });
    
    console.log(`\n📡 API Response Status: ${response.status}`);
    
    if (response.status === 200) {
      console.log('✅ Token is VALID!');
      console.log(`   Access Token: ${response.data.access_token.substring(0, 10)}...`);
      console.log(`   API Server: ${response.data.api_server}`);
      console.log(`   Expires in: ${response.data.expires_in} seconds`);
      console.log(`   New Refresh Token: ${response.data.refresh_token.substring(0, 10)}...`);
      
      return {
        valid: true,
        accessToken: response.data.access_token,
        newRefreshToken: response.data.refresh_token,
        apiServer: response.data.api_server,
        expiresIn: response.data.expires_in
      };
    } else if (response.status === 400) {
      console.log('❌ Token is INVALID (400 Bad Request)');
      console.log('   This usually means:');
      console.log('   1. The token has already been used');
      console.log('   2. The token has expired');
      console.log('   3. The token was copied incorrectly');
      
      if (response.data) {
        console.log(`\n   API Error: ${JSON.stringify(response.data, null, 2)}`);
      }
      
      return { valid: false, error: 'Invalid token' };
    } else if (response.status === 401) {
      console.log('❌ Token is UNAUTHORIZED (401)');
      console.log('   The token format may be incorrect');
      return { valid: false, error: 'Unauthorized' };
    } else {
      console.log(`❌ Unexpected response: ${response.status}`);
      return { valid: false, error: `HTTP ${response.status}` };
    }
    
  } catch (error) {
    console.log('❌ API call failed:', error.message);
    
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.log('   Unable to connect to Questrade API');
      console.log('   Check your internet connection');
    } else if (error.code === 'ECONNABORTED') {
      console.log('   Request timed out');
    }
    
    return { valid: false, error: error.message };
  }
}

async function saveValidToken(personName, tokenData) {
  try {
    console.log('\n💾 Saving valid token to database...');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio');
    console.log('   Connected to MongoDB');
    
    // Import models
    const Token = require('./models/Token');
    const Person = require('./models/Person');
    
    // Clean up old tokens
    await Token.deleteMany({ personName });
    console.log('   Cleaned up old tokens');
    
    // Save new refresh token
    const refreshToken = Token.createWithToken({
      type: 'refresh',
      personName,
      token: tokenData.newRefreshToken,
      expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)),
      isActive: true
    });
    await refreshToken.save();
    console.log('   Saved new refresh token');
    
    // Save access token
    const accessToken = Token.createWithToken({
      type: 'access',
      personName,
      token: tokenData.accessToken,
      apiServer: tokenData.apiServer,
      expiresAt: new Date(Date.now() + (tokenData.expiresIn * 1000)),
      isActive: true
    });
    await accessToken.save();
    console.log('   Saved access token');
    
    // Update person record
    await Person.findOneAndUpdate(
      { personName },
      { 
        hasValidToken: true,
        lastTokenRefresh: new Date(),
        lastSyncError: null
      }
    );
    console.log('   Updated person record');
    
    console.log('\n✅ Token saved successfully!');
    return true;
    
  } catch (error) {
    console.log('❌ Failed to save token:', error.message);
    return false;
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  Questrade Token Recovery Tool                   ║
║                                                                  ║
║  This tool will help you fix invalid refresh token issues.      ║
║                                                                  ║
║  IMPORTANT: Refresh tokens are SINGLE-USE!                      ║
║  Once used, you get a new refresh token for next time.          ║
╚══════════════════════════════════════════════════════════════════╝
`);

  try {
    console.log('📋 Steps to get a NEW refresh token:');
    console.log('1. Go to: https://login.questrade.com/APIAccess/UserApps.aspx');
    console.log('2. Log in to your Questrade account');
    console.log('3. Find your existing app or create a new one');
    console.log('4. Click "Generate new token" or "REGENERATE"');
    console.log('5. Copy the ENTIRE new token (should be 30+ characters)');
    console.log('6. Paste it here immediately (tokens expire quickly!)\n');
    
    const continueChoice = await question('Have you generated a NEW token? (y/n): ');
    if (continueChoice.toLowerCase() !== 'y') {
      console.log('\n⚠️  Please generate a new token first, then run this script again.');
      process.exit(0);
    }
    
    // Get the new token
    console.log('\n⚠️  IMPORTANT: Enter the token carefully. Each character will show as *');
    const newToken = await questionHidden('Enter your NEW refresh token (hidden): ');
    
    if (!newToken || newToken.length < 20) {
      console.log('❌ Token appears too short. Tokens are usually 30+ characters.');
      process.exit(1);
    }
    
    // Test the token
    const testResult = await testRefreshToken(newToken);
    
    if (testResult.valid) {
      console.log('\n🎉 SUCCESS! Your token is valid!');
      
      // Ask if they want to save it
      const saveChoice = await question('\nDo you want to save this token for Vivek? (y/n): ');
      if (saveChoice.toLowerCase() === 'y') {
        const saved = await saveValidToken('Vivek', testResult);
        
        if (saved) {
          console.log('\n✅ Everything is fixed! You can now:');
          console.log('1. Run: node setup.js');
          console.log('2. Choose option 6 to sync data');
          console.log('3. Or start the server: npm start');
        }
      } else {
        console.log('\n⚠️  Token not saved. You\'ll need to manually update it.');
        console.log(`\n📝 Your NEW refresh token for next use:`);
        console.log(`   ${testResult.newRefreshToken}`);
        console.log('\n⚠️  SAVE THIS TOKEN! The old one is now invalid!');
      }
    } else {
      console.log('\n❌ Token validation failed!');
      console.log('\n💡 Solutions:');
      console.log('1. Make sure you generated a BRAND NEW token (not reusing an old one)');
      console.log('2. Copy the COMPLETE token without any spaces');
      console.log('3. Use the token immediately (they can expire quickly)');
      console.log('4. Try creating a new Personal App in Questrade if issues persist');
      console.log('\n🔄 Run this script again with a fresh token.');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    rl.close();
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed.');
  }
}

// Run the recovery tool
if (require.main === module) {
  main();
}

module.exports = { testRefreshToken };