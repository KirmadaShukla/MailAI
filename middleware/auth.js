const { google } = require('googleapis');
const config = require('../config/config');
const User = require('../models/User');

const oauth2Client = new google.auth.OAuth2(
  config.gmail.clientId,
  config.gmail.clientSecret,
  config.gmail.redirectUri
);

async function authMiddleware(req, res, next) {
  try {
    const userId = req.headers['x-user-id']; // Sent from Chrome extension
    const user = await User.findOne({ userId });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
    req.oauth2Client = oauth2Client;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = authMiddleware;