const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // Google user ID
  email: { type: String, required: true },
  customCategories: [{ type: String }], // User-defined categories
  accessToken: { type: String }, // Store access token
  refreshToken: { type: String }, // Store refresh token
});

module.exports = mongoose.model('User', userSchema);