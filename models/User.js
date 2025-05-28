// models/User.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  gmailTokens: {
    accessToken: { type: String },
    refreshToken: { type: String },
    expiryDate: { type: Date },
  },
});

userSchema.pre('save', function (next) {
  if (this.gmailTokens?.refreshToken && this.isModified('gmailTokens.refreshToken')) {
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(this.gmailTokens.refreshToken);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    this.gmailTokens.refreshToken = iv.toString('hex') + ':' + encrypted.toString('hex');
  }
  next();
});

userSchema.methods.getDecryptedRefreshToken = function () {
  if (!this.gmailTokens?.refreshToken) return null;
  try {
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
    }
    const [iv, encryptedText] = this.gmailTokens.refreshToken.split(':').map(part => Buffer.from(part, 'hex'));
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error('Decryption error:', error.message);
    throw new Error('Failed to decrypt refresh token');
  }
};

module.exports = mongoose.model('User', userSchema);