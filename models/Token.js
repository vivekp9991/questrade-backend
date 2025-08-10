// models/Token.js - FIXED VERSION - Resolves token decryption issues
const mongoose = require('mongoose');
const crypto = require('crypto');

const tokenSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['refresh', 'access'],
    required: true
  },
  personName: {
    type: String,
    required: true,
    index: true
  },
  // Store encrypted token data
  encryptedToken: {
    type: String,
    required: true
  },
  // Store the IV separately for better security
  iv: {
    type: String,
    required: true
  },
  apiServer: String,
  expiresAt: {
    type: Date,
    required: true
  },
  lastUsed: Date,
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Error tracking
  lastError: String,
  errorCount: {
    type: Number,
    default: 0
  },
  lastSuccessfulUse: Date,
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Get encryption key with proper validation
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  
  // Ensure key is exactly 32 bytes for AES-256
  if (key.length < 32) {
    // Pad key if too short
    return Buffer.from(key.padEnd(32, '0'), 'utf8');
  } else if (key.length > 32) {
    // Truncate key if too long
    return Buffer.from(key.substring(0, 32), 'utf8');
  }
  
  return Buffer.from(key, 'utf8');
}

// Static method to create encrypted token - FIXED
tokenSchema.statics.createWithToken = function(tokenData) {
  const { token, ...otherData } = tokenData;
  
  if (!token) {
    throw new Error('Token is required');
  }
  
  try {
    // Use AES-256-CBC encryption
    const algorithm = 'aes-256-cbc';
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16); // Generate random IV
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Create the document with encrypted token and separate IV
    return new this({
      ...otherData,
      encryptedToken: encrypted,
      iv: iv.toString('hex')
    });
  } catch (error) {
    console.error('Token encryption failed:', error);
    throw new Error(`Failed to encrypt token: ${error.message}`);
  }
};

// Method to decrypt token - FIXED
tokenSchema.methods.getDecryptedToken = function() {
  if (!this.encryptedToken || !this.iv) {
    console.error('Missing encrypted token or IV');
    return null;
  }
  
  try {
    const algorithm = 'aes-256-cbc';
    const key = getEncryptionKey();
    const iv = Buffer.from(this.iv, 'hex');
    
    // Validate IV length
    if (iv.length !== 16) {
      console.error('Invalid IV length:', iv.length);
      return null;
    }
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(this.encryptedToken, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Token decryption failed:', {
      error: error.message,
      personName: this.personName,
      type: this.type,
      hasEncryptedToken: !!this.encryptedToken,
      hasIV: !!this.iv,
      ivLength: this.iv ? Buffer.from(this.iv, 'hex').length : 0
    });
    return null;
  }
};

// Method to validate token can be decrypted
tokenSchema.methods.validateDecryption = function() {
  try {
    const decrypted = this.getDecryptedToken();
    return !!decrypted && decrypted.length > 0;
  } catch (error) {
    return false;
  }
};

// Method to mark token as used successfully
tokenSchema.methods.markAsUsed = function() {
  this.lastUsed = new Date();
  this.lastSuccessfulUse = new Date();
  this.errorCount = 0;
  this.lastError = null;
  this.updatedAt = new Date();
  return this.save();
};

// Method to record error
tokenSchema.methods.recordError = function(errorMessage) {
  this.lastError = errorMessage;
  this.errorCount = (this.errorCount || 0) + 1;
  this.lastUsed = new Date();
  this.updatedAt = new Date();
  return this.save();
};

// Update timestamp before saving
tokenSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Compound indexes for efficient queries
tokenSchema.index({ personName: 1, type: 1, isActive: 1 });
tokenSchema.index({ type: 1, isActive: 1, expiresAt: 1 });

// Unique index to prevent duplicates - more flexible than before
tokenSchema.index({ personName: 1, type: 1 }, { 
  unique: true,
  partialFilterExpression: { isActive: true }
});

// Static method to safely migrate old tokens
tokenSchema.statics.migrateOldTokens = async function() {
  try {
    console.log('Checking for old token format...');
    
    // Find tokens that might be in old format (missing IV field)
    const oldTokens = await this.find({ 
      iv: { $exists: false },
      encryptedToken: { $exists: true }
    });
    
    if (oldTokens.length > 0) {
      console.log(`Found ${oldTokens.length} tokens in old format. These will need to be re-created.`);
      
      // Mark old tokens as inactive instead of trying to migrate
      await this.updateMany(
        { iv: { $exists: false } },
        { 
          isActive: false,
          lastError: 'Token format migration required - please update refresh token'
        }
      );
      
      console.log('Old tokens marked as inactive. Please update refresh tokens.');
      return {
        migrated: 0,
        deactivated: oldTokens.length,
        requiresUpdate: true
      };
    }
    
    return {
      migrated: 0,
      deactivated: 0,
      requiresUpdate: false
    };
  } catch (error) {
    console.error('Token migration failed:', error);
    throw error;
  }
};

// Static method to cleanup invalid tokens
tokenSchema.statics.cleanupInvalidTokens = async function() {
  try {
    console.log('Cleaning up invalid tokens...');
    
    const allTokens = await this.find({ isActive: true });
    let invalidCount = 0;
    
    for (const token of allTokens) {
      if (!token.validateDecryption()) {
        await this.findByIdAndUpdate(token._id, {
          isActive: false,
          lastError: 'Token decryption validation failed'
        });
        invalidCount++;
      }
    }
    
    if (invalidCount > 0) {
      console.log(`Deactivated ${invalidCount} invalid tokens`);
    }
    
    return {
      total: allTokens.length,
      invalid: invalidCount,
      valid: allTokens.length - invalidCount
    };
  } catch (error) {
    console.error('Token cleanup failed:', error);
    throw error;
  }
};

// Static method to test encryption/decryption
tokenSchema.statics.testEncryption = function(testString = 'test-token-12345') {
  try {
    console.log('Testing token encryption/decryption...');
    
    // Create a test token
    const testToken = this.createWithToken({
      type: 'access',
      personName: 'test',
      token: testString,
      expiresAt: new Date(Date.now() + 3600000) // 1 hour
    });
    
    // Try to decrypt it
    const decrypted = testToken.getDecryptedToken();
    
    const success = decrypted === testString;
    console.log(`Encryption test: ${success ? 'PASSED' : 'FAILED'}`);
    
    if (!success) {
      console.log(`Expected: "${testString}", Got: "${decrypted}"`);
    }
    
    return {
      success,
      original: testString,
      decrypted: decrypted
    };
  } catch (error) {
    console.error('Encryption test failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = mongoose.model('Token', tokenSchema);