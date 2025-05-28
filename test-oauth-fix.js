// Test script to verify OAuth callback encryption fix
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

async function testOAuthFix() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Test user data
    const testUserId = 'test-user-oauth-fix';
    const testTokens = {
      accessToken: 'test-access-token-12345',
      refreshToken: 'test-refresh-token-67890',
      expiryDate: new Date(Date.now() + 3600000) // 1 hour from now
    };

    // Clean up any existing test user
    await User.deleteOne({ userId: testUserId });
    console.log('🧹 Cleaned up existing test user');

    // Create new user with tokens
    const user = new User({
      userId: testUserId,
      email: `${testUserId}@example.com`,
      gmailTokens: testTokens
    });

    // Save user (this will trigger encryption)
    await user.save();
    console.log('✅ User saved successfully with encrypted refresh token');

    // Retrieve user and decrypt token
    const retrievedUser = await User.findOne({ userId: testUserId });
    const decryptedToken = retrievedUser.getDecryptedRefreshToken();
    
    console.log('✅ Token decrypted successfully');
    console.log('Original refresh token:', testTokens.refreshToken);
    console.log('Decrypted refresh token:', decryptedToken);
    console.log('Tokens match:', testTokens.refreshToken === decryptedToken);

    if (testTokens.refreshToken === decryptedToken) {
      console.log('🎉 OAuth encryption/decryption fix is working correctly!');
    } else {
      console.log('❌ OAuth encryption/decryption fix failed');
    }

    // Clean up
    await User.deleteOne({ userId: testUserId });
    console.log('🧹 Test user cleaned up');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Error details:', error);
  } finally {
    await mongoose.disconnect();
    console.log('📦 Disconnected from MongoDB');
  }
}

testOAuthFix();
