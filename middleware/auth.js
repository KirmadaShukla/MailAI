// middleware/auth.js
const { google } = require("googleapis");
const config = require("../config/config");
const User = require("../models/User");

const oauth2Client = new google.auth.OAuth2(
  config.oauth.clientId,
  config.oauth.clientSecret,
  config.oauth.redirectUri,
);

async function authMiddleware(req, res, next) {
  try {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, error: "User ID not provided" });
    }

    const user = await User.findOne({ userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: No Gmail authentication found",
      });
    }

    oauth2Client.setCredentials({
      access_token: user.gmailTokens.accessToken,
      refresh_token: user.getDecryptedRefreshToken(),
      expiry_date: user.gmailTokens.expiryDate,
    });

    oauth2Client.on("tokens", async (tokens) => {
      console.log("New tokens:", { accessToken: tokens.access_token });
      if (tokens.access_token) {
        user.gmailTokens.accessToken = tokens.access_token;
        user.gmailTokens.expiryDate = tokens.expiry_date;
        if (tokens.refresh_token) {
          user.gmailTokens.refreshToken = tokens.refresh_token;
        }
        await user.save();
      }
    });

    try {
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      await gmail.users.getProfile({ userId: "me" });
      req.gmailClient = gmail;
      req.userId = userId;
      next();
    } catch (apiError) {
      console.error("Token error:", {
        message: apiError.message,
        details: apiError.response?.data,
      });
      if (apiError.response?.data?.error === "invalid_grant") {
        user.gmailTokens = null;
        await user.save();
        return res.status(401).json({
          success: false,
          error: "Invalid grant: Re-authentication required",
          details: "Please reconnect your Gmail account",
        });
      }
      return res.status(401).json({
        success: false,
        error: "Authentication failed",
        details: apiError.response?.data?.error || apiError.message,
      });
    }
  } catch (error) {
    console.error("Auth error:", {
      message: error.message,
      details: error.response?.data,
    });
    res.status(401).json({
      success: false,
      error: "Authentication failed",
      details: error.response?.data?.error || error.message,
    });
  }
}

module.exports = authMiddleware;
