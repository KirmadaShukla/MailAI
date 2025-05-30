// services/gmail.js

const { google } = require('googleapis');
const { RateLimiter } = require('limiter');

// Rate limiter for Gmail API calls (250 quota units per user per second)
const gmailLimiter = new RateLimiter({ tokensPerInterval: 200, interval: 'second', burst: 50 });

// Helper function for rate-limited API calls with exponential backoff
async function withRateLimit(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await gmailLimiter.removeTokens(1);
      return await fn();
    } catch (error) {
      if (error.code === 429 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`[gmailService] Rate limit hit, retrying after ${delay}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function getEmails(req, maxResults = 50, pageToken = null) {
  try {
    const gmail = req.gmailClient;
    const userId = req.userId;

    const listParams = {
      userId: 'me',
      maxResults,
    };

    if (pageToken && pageToken !== 'next') {
      listParams.pageToken = pageToken;
    }

    const response = await withRateLimit(() => gmail.users.messages.list(listParams));
    const messages = response.data.messages || [];
    const emails = [];

    console.log(`Fetching details for ${messages.length} emails for user ${userId}`);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      try {
        const email = await withRateLimit(() => gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full',
        }));
        emails.push(email.data);

        if (i < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (emailError) {
        console.log(`Warning: Could not fetch email ${message.id}: ${emailError.message}`);
      }
    }

    return {
      emails,
      nextPageToken: response.data.nextPageToken,
      totalEmails: emails.length,
    };
  } catch (error) {
    console.error('Error fetching emails:', error);
    throw error;
  }
}

async function getAllLabels(authClientOrGmail, context = 'DEFAULT') {
  let gmail;
  if (authClientOrGmail && typeof authClientOrGmail.users === 'object' && typeof authClientOrGmail.users.labels === 'object' && typeof authClientOrGmail.users.labels.list === 'function') {
    // It's already a Gmail API object
    console.log(`[gmailService - getAllLabels - ${context}] Using pre-initialized gmail client. Type: ${typeof authClientOrGmail}`);
    gmail = authClientOrGmail;
  } else {
    // It's an auth client or something else, create Gmail API object
    console.log(`[gmailService - getAllLabels - ${context}] authClientOrGmail is NOT a pre-initialized gmail client. Type: ${typeof authClientOrGmail}. Value:`, authClientOrGmail);
    // THE ERROR IS LIKELY HERE if authClientOrGmail is not a valid auth client instance for google.gmail
    gmail = google.gmail({ version: 'v1', auth: authClientOrGmail });
  }

  try {
    console.log(`[gmailService - getAllLabels - ${context}] Attempting to list labels...`);
    const response = await withRateLimit(() => gmail.users.labels.list({ userId: 'me' }));
    console.log(`[gmailService - getAllLabels - ${context}] Labels listed successfully.`);
    return response.data.labels || [];
  } catch (error) {
    console.error(`[gmailService - getAllLabels - ${context}] Error fetching labels. Auth object type was ${typeof authClientOrGmail}. Error:`, error);
    throw error; // Re-throw to allow caller to handle
  }
}

async function applyLabel(emailId, category, authClientOrGmail) {
  let gmail;
  // Ensure context is passed if applyLabel calls getAllLabels
  const callContext = `applyLabel-${category}`; 
  if (authClientOrGmail && typeof authClientOrGmail.users === 'object' && typeof authClientOrGmail.users.labels === 'object' && typeof authClientOrGmail.users.labels.list === 'function') {
    // It's already a Gmail API object from parallelProcessingService
    console.log(`[gmailService - applyLabel] Using pre-initialized gmail client for applyLabel.`);
    gmail = authClientOrGmail;
  } else {
    // It's an auth client, create Gmail API object
    console.log(`[gmailService - applyLabel] Initializing new gmail client for applyLabel. authClientOrGmail type: ${typeof authClientOrGmail}. Value:`, authClientOrGmail);
    gmail = google.gmail({ version: 'v1', auth: authClientOrGmail });
  }

  const fullLabelName = `Maily/${category}`; // e.g., "Maily/Work"
  let labelId = null;

  try {
    // 1. Get all labels
    const labels = await getAllLabels(gmail, callContext); // Pass the 'gmail' instance and context
    const existingLabel = labels.find(label => label.name === fullLabelName);

    if (existingLabel) {
      labelId = existingLabel.id;
    } else {
      // 2. Create the label if it doesn't exist
      console.log(`[gmailService] Label "${fullLabelName}" not found, creating it...`);
      try {
        const newLabelResponse = await withRateLimit(() => gmail.users.labels.create({
          userId: 'me',
          resource: {
            name: fullLabelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'hide', // Use 'hide' instead of 'show' - valid values are 'hide' or 'show'
          },
        }));
        labelId = newLabelResponse.data.id;
        console.log(`[gmailService] Label "${fullLabelName}" created with ID: ${labelId}`);
      } catch (createError) {
        // Log the detailed error for label creation
        const errorMessage = createError.errors && createError.errors.length > 0 ? createError.errors[0].message : createError.message;
        console.error(`[gmailService] Error creating label "${fullLabelName}": ${errorMessage}`, createError);
        throw new Error(`Failed to create label "${fullLabelName}": ${errorMessage}`);
      }
    }

    // 3. Apply the label to the email message
    if (labelId) {
      await withRateLimit(() => gmail.users.messages.modify({
        userId: 'me',
        id: emailId,
        resource: {
          addLabelIds: [labelId],
          // removeLabelIds: [], // Optional: add if you need to remove other labels
        },
      }));
      // console.log(`[gmailService] Successfully applied label "${fullLabelName}" to email ${emailId}`);
    } else {
      // This should ideally not be reached if creation is successful or label exists
      console.error(`[gmailService] Could not find or create a label ID for "${fullLabelName}" for email ${emailId}.`);
      throw new Error(`Could not find or create label ID for "${fullLabelName}"`);
    }
  } catch (error) {
    // Log and re-throw to be caught by the calling function in parallelProcessingService.js
    // The error message might already be detailed from label creation step
    const message = error.message || 'Unknown error in applyLabel';
    console.error(`[gmailService] Error applying label "${fullLabelName}" to email ${emailId}: ${message}`);
    if (!error.alreadyLogged) { // Avoid double logging if error came from createLabel
      error.alreadyLogged = true;
    }
    throw error;
  }
}

module.exports = { getEmails, applyLabel, getAllLabels };