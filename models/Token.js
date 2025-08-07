const mongoose = require('mongoose');
const crypto = require('crypto');

const tokenSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['refresh', 'access'],
    required: true
  },
  token: {
    type: String,
    required: true
  },
  encryptedToken: String,
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
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Encrypt token before saving
tokenSchema.pre('save', function(next) {
  if (this.isModified('token')) {
    const algorithm = 'aes-256-cbc';
    const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default_key_32_chars_long_here!!', 'utf8');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    let encrypted = cipher.update(this.token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    this.encryptedToken = iv.toString('hex') + ':' + encrypted;
    this.token = undefined; // Don't store plain token
  }
  this.updatedAt = Date.now();
  next();
});

// Decrypt token method
tokenSchema.methods.getDecryptedToken = function() {
  if (!this.encryptedToken) return null;
  
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default_key_32_chars_long_here!!', 'utf8');
  const parts = this.encryptedToken.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
};

module.exports = mongoose.model('Token', tokenSchema);