const { google } = require('googleapis');
const config = require('../config/config');

// Create a function to get authenticated Gmail client
function getGmailClient(userAuth = null) {
  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );

  if (userAuth && userAuth.accessToken && userAuth.refreshToken) {
    // Use user-specific tokens if available
    oauth2Client.setCredentials({
      access_token: userAuth.accessToken,
      refresh_token: userAuth.refreshToken
    });
  } else {
    // Fallback to global refresh token
    oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
  }

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Cache for labels to avoid repeated API calls
let labelsCache = null;
let labelsCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getEmails(userId, maxResults = 50, userAuth = null, pageToken = null) {
  try {
    const gmail = getGmailClient(userAuth);

    const listParams = {
      userId: 'me',
      maxResults,
    };

    if (pageToken && pageToken !== 'next') {
      listParams.pageToken = pageToken;
    }

    const response = await gmail.users.messages.list(listParams);
    const messages = response.data.messages || [];
    const emails = [];

    console.log(`   Fetching details for ${messages.length} emails...`);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      try {
        const email = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full',
        });
        emails.push(email.data);

        // Small delay between requests to avoid rate limits
        if (i < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (emailError) {
        console.log(`   Warning: Could not fetch email ${message.id}: ${emailError.message}`);
      }
    }

    // Return emails with pagination info
    return {
      emails,
      nextPageToken: response.data.nextPageToken,
      totalEmails: emails.length
    };
  } catch (error) {
    console.error('Error fetching emails:', error);
    throw error;
  }
}

// Function to get all labels with caching
async function getAllLabels(userAuth = null) {
  const now = Date.now();

  // Return cached labels if still valid
  if (labelsCache && labelsCacheTime && (now - labelsCacheTime) < CACHE_DURATION) {
    return labelsCache;
  }

  try {
    const gmail = getGmailClient(userAuth);
    const response = await gmail.users.labels.list({ userId: 'me' });
    labelsCache = response.data.labels || [];
    labelsCacheTime = now;
    return labelsCache;
  } catch (error) {
    console.error('Error fetching labels:', error);
    throw error;
  }
}

// Function to sanitize label names for Gmail with Maily prefix
function sanitizeLabelName(labelName) {
  if (!labelName || typeof labelName !== 'string') {
    return 'Maily/Personal';
  }

  // Remove leading/trailing whitespace
  let sanitized = labelName.trim();

  // Replace invalid characters with underscores
  // Gmail allows letters, numbers, spaces, and some special characters
  sanitized = sanitized.replace(/[^\w\s\-\.]/g, '_');

  // Ensure it's not empty after sanitization
  if (!sanitized) {
    sanitized = 'Personal';
  }

  // Add Maily prefix if not already present
  if (!sanitized.startsWith('Maily/')) {
    sanitized = `Maily/${sanitized}`;
  }

  // Gmail label names can't be longer than 100 characters
  if (sanitized.length > 100) {
    sanitized = sanitized.substring(0, 100);
  }

  return sanitized;
}

// Function to find existing label by name (case-insensitive)
function findExistingLabel(labels, labelName) {
  const sanitizedName = sanitizeLabelName(labelName);

  // First try exact match with Maily prefix
  let existingLabel = labels.find((l) => l.name === sanitizedName);

  // If no exact match, try case-insensitive match
  if (!existingLabel) {
    existingLabel = labels.find((l) =>
      l.name.toLowerCase() === sanitizedName.toLowerCase()
    );
  }

  // For nested labels, we prefer creating our own Maily/* labels
  // rather than using system labels, but we can still fall back to them
  // if the user specifically wants to use system labels

  return existingLabel;
}

async function applyLabel(emailId, labelName, userAuth = null) {
  try {
    // Sanitize the label name
    const sanitizedLabelName = sanitizeLabelName(labelName);
    // Get all labels
    const labels = await getAllLabels(userAuth);

    // Find existing label
    const existingLabel = findExistingLabel(labels, sanitizedLabelName);

    let labelId;
    const gmail = getGmailClient(userAuth);

    if (existingLabel) {
      labelId = existingLabel.id;
    } else {
      // Only create new label if it's a user-defined category (not a system label)
      try {
        const newLabel = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: sanitizedLabelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          },
        });
        labelId = newLabel.data.id;

        // Clear cache to include the new label
        labelsCache = null;
        labelsCacheTime = null;
      } catch (createError) {

        // If label creation fails, it might already exist - refresh labels and try again
        labelsCache = null;
        labelsCacheTime = null;
        const refreshedLabels = await getAllLabels(userAuth);

        // Try to find the label with exact name match
        const existingAfterRefresh = refreshedLabels.find(label =>
          label.name === sanitizedLabelName
        );

        if (existingAfterRefresh) {
          labelId = existingAfterRefresh.id;
        } else {
          // If we can't create the label, skip this email and log the error
          console.error(`Unable to create or find label "${sanitizedLabelName}" - skipping email ${emailId}`);
          throw new Error(`Unable to create or find suitable label for "${labelName}"`);
        }
      }
    }

    // Apply label to email
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: { addLabelIds: [labelId] },
    });


  } catch (error) {
    console.error(`Error applying label "${labelName}" to email ${emailId}:`, error.message);

    // Log more details for debugging
    if (error.response && error.response.data) {
      console.error('API Error Details:', error.response.data);
    }

    throw error;
  }
}

module.exports = { getEmails, applyLabel, getAllLabels };