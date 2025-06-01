const { google } = require("googleapis");
const { spawn } = require("child_process");
const User = require("../models/User");
const config = require("../config/config");

const oauth2Client = new google.auth.OAuth2(
  config.oauth.clientId,
  config.oauth.clientSecret,
  config.oauth.redirectUri,
);

const authGmail = async (req, res) => {
  const userIdAsEmail = req.query.userId; // This is the email for login_hint
  if (!userIdAsEmail) {
    return res
      .status(400)
      .json({ success: false, error: "User ID (email) required in query" });
  }

  try {
    // No need to fetch user here for login_hint. userIdAsEmail IS the hint.
    // State will also carry userIdAsEmail.
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.labels",
      ],
      state: userIdAsEmail,
      login_hint: userIdAsEmail,
      prompt: "consent",
    });
    // Open in default browser
    spawn("open", [authUrl]);
    res.json({ success: true, authUrl });
  } catch (error) {
    console.error("Error generating auth URL:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to generate authentication URL" });
  }
};

const authCallback = async (req, res) => {
  const { code, state } = req.query; // Renamed userId from body to state for clarity, as it is the state param
  const userIdFromState = state; // This is the email we expect

  console.log("OAuth callback received:", {
    code: code ? "present" : "missing",
    userIdFromState: userIdFromState || "missing",
  });

  if (!code) {
    console.error("Missing authorization code in callback");
    return res.status(400).json({
      success: false,
      error: "Missing authorization code",
      details:
        "The OAuth callback did not include the required authorization code",
    });
  }

  if (!userIdFromState) {
    console.error("Missing userId (state parameter) in callback");
    return res.status(400).json({
      success: false,
      error: "Missing userId in state",
      details:
        "The OAuth callback did not include the required state parameter (userId/email)",
    });
  }

  try {
    // The userIdFromState is the primary key and the expected email.
    let user = await User.findOne({ userId: userIdFromState });

    if (!user) {
      // If user does not exist, create them with their email as userId and email field.
      console.log(`User ${userIdFromState} not found. Creating new user.`);
      user = new User({ userId: userIdFromState, email: userIdFromState });
    } else if (user.email !== userIdFromState) {
      // If user exists but email field is incorrect (e.g., old placeholder), correct it.
      console.warn(
        `User ${userIdFromState} found, but email field was incorrect: ${user.email}. Correcting to ${userIdFromState}.`,
      );
      user.email = userIdFromState;
      // No need to save here, will be saved later with tokens.
    }

    const { tokens } = await oauth2Client.getToken(code);
    console.log("Tokens received for", userIdFromState, {
      accessToken: tokens.access_token ? "present" : "missing",
      refreshToken: tokens.refresh_token ? "present" : "not present",
      expiryDate: tokens.expiry_date,
    });

    oauth2Client.setCredentials(tokens);

    console.log("Tokens set for", userIdFromState);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    console.log("Gmail client initialized");
    const profile = await gmail.users.getProfile({ userId: "me" });
    const authenticatedEmail = profile.data.emailAddress;

    console.log("Authenticated email:", authenticatedEmail);

    if (authenticatedEmail.toLowerCase() !== userIdFromState.toLowerCase()) {
      console.warn(
        `Email mismatch for user ${userIdFromState}: Expected ${userIdFromState}, but authenticated with ${authenticatedEmail}`,
      );
      try {
        if (tokens.access_token) {
          // Only try to revoke if there's an access token
          await verificationClient.revokeToken(tokens.access_token);
          console.log(
            `Token revoked for ${authenticatedEmail} due to email mismatch.`,
          );
        }
      } catch (revokeError) {
        console.error(
          `Failed to revoke token for ${authenticatedEmail}:`,
          revokeError.message,
        );
      }
      return res.status(403).json({
        success: false,
        error: "Authentication email mismatch",
        details: `Authenticated with ${authenticatedEmail}, but authentication was initiated for ${userIdFromState}. Please use the Google account for ${userIdFromState}.`,
      });
    }

    // Email matches, proceed to save tokens
    user.gmailTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.gmailTokens?.refreshToken,
      expiryDate: tokens.expiry_date,
    };
    await user.save();
    console.log(
      `Tokens saved for user ${userIdFromState} (email: ${user.email})`,
    );

    res.json({ success: true, message: "Authentication successful" });
  } catch (error) {
    console.error("OAuth callback error for user", userIdFromState, {
      message: error.message,
      code: error.code,
      details: error.response?.data,
    });
    res.status(401).json({
      success: false,
      error: "Authentication failed",
      details: error.response?.data?.error || error.message,
    });
  }
};

const authUser = async (req, res) => {
  try {
    const users = await User.find({});
    res.json({
      success: true,
      users: users.map((user) => ({
        userId: user.userId,
        email: user.email,
        hasTokens: !!user.gmailTokens,
        accessToken: user.gmailTokens?.accessToken ? "present" : "not present",
        refreshToken: user.gmailTokens?.refreshToken
          ? "present"
          : "not present",
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
module.exports = { authGmail, authCallback, authUser };
