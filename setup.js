// setup.js
const mongoose = require('mongoose');
const readline = require('readline');
require('dotenv').config();

const Token = require('./models/Token');
const logger = require('./utils/logger');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setup() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    console.log('Connected to MongoDB');
    console.log('\n=== Questrade Portfolio Tracker Setup ===\n');
    
    // Get refresh token
    const refreshToken = await new Promise((resolve) => {
      rl.question('Enter your Questrade refresh token: ', resolve);
    });
    
    if (!refreshToken) {
      console.error('Refresh token is required!');
      process.exit(1);
    }
    
    // Save refresh token
    await Token.updateMany({ type: 'refresh', isActive: true }, { isActive: false });
    
    await Token.create({
      type: 'refresh',
      token: refreshToken,
      expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)),
      isActive: true
    });
    
    console.log('\n✅ Refresh token saved successfully');
    console.log('\n=== Setup Complete ===');
    console.log('\nYou can now start the server with: npm start');
    console.log('The server will automatically refresh the token and sync your data.');
    
    process.exit(0);
  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

setup();