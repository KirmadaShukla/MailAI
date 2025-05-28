
const { google } = require('googleapis');
const User = require('../models/User');
const config = require('../config/config');

const oauth2Client = new google.auth.OAuth2(
  config.gmail.clientId,
  config.gmail.clientSecret,
  config.gmail.redirectUri
);


const authGmail=(req,res)=>{
 const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'User ID required' });
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
    ],
    state: userId,
    prompt: 'consent',
  });
  res.json({ success: true, authUrl });
}

const authCallback=async(req,res)=>{
      const { code,  userId } = req.body;

  console.log('OAuth callback received:', {
    code: code ? 'present' : 'missing',
    userId: userId || 'missing',
    fullQuery: req.query
  });

  if (!code) {
    console.error('Missing authorization code in callback');
    return res.status(400).json({
      success: false,
      error: 'Missing authorization code',
      details: 'The OAuth callback did not include the required authorization code'
    });
  }

  if (!userId) {
    console.error('Missing userId (state parameter) in callback');
    return res.status(400).json({
      success: false,
      error: 'Missing userId',
      details: 'The OAuth callback did not include the required state parameter (userId)'
    });
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Tokens received:', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ? 'present' : 'not present',
      expiryDate: tokens.expiry_date,
    });

    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, email: `user-${userId}@example.com` });
    }

    user.gmailTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
    };
    await user.save();
    console.log(`Tokens saved for user ${userId}`);

    res.json({ success: true, message: 'Authentication successful' });
  } catch (error) {
    console.error('OAuth callback error:', {
      message: error.message,
      code: error.code,
      details: error.response?.data,
    });
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      details: error.response?.data?.error || error.message,
    });
  }
}

const authUser=async(req,res)=>{
     try {
    const users = await User.find({});
    res.json({
      success: true,
      users: users.map(user => ({
        userId: user.userId,
        email: user.email,
        hasTokens: !!user.gmailTokens,
        accessToken: user.gmailTokens?.accessToken ? 'present' : 'not present',
        refreshToken: user.gmailTokens?.refreshToken ? 'present' : 'not present'
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
module.exports={authGmail,authCallback,authUser};