require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGO_URI,
  redisUrl: process.env.REDIS_URL,
  oauth: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
};
