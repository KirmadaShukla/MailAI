const { applyLabel, getAllLabels } = require('./gmailService');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const { google } = require('googleapis');
const { RateLimiter } = require('limiter');

// Helper function to identify Google quota errors
function isGoogleQuotaError(error) {
  if (!error) return false;

  // Handle cases where error might not have a response (e.g. network issues before API call)
  const response = error.response || error; // Sometimes the error itself is the response for certain libraries/errors
  const status = response.status || response.code; // HTTP status code might be 'status' or 'code'
  const data = response.data || (response.error ? response.error : {}); // Error details

  if (status === 429) return true; // Too Many Requests is always a rate/quota issue

  if (status === 403) { // Forbidden can be for various reasons, check details
    const googleError = data.error || data; // Google error object might be nested
    const errors = googleError.errors || [];
    const reasons = errors.map(e => e.reason);
    if (reasons.includes('rateLimitExceeded') ||
        reasons.includes('userRateLimitExceeded') ||
        reasons.includes('dailyLimitExceeded') || // Added dailyLimitExceeded
        reasons.includes('quotaExceeded') ||
        reasons.includes('usageLimitExceeded')) {
      return true;
    }
  }
  // Check for specific messages if structure isn't as expected
  const message = (error.message || '').toLowerCase();
  if (message.includes('quota') || message.includes('rate limit') || message.includes('usage limit')) {
      return true;
  }

  return false;
}

// Initialize global rate limiter (200 API calls per second, fast processing)
const apiLimiter = new RateLimiter({ tokensPerInterval: 50, interval: 'second' });

// Initialize Gemini with the latest model
const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash-exp', // Latest Gemini 2.0 Flash
  generationConfig: {
    temperature: 0.03, // Low temperature for consistency
    topP: 0.95,
    topK: 15,
    maxOutputTokens: 8192,
  },
});

const predefinedCategories = [
  'Meetings', 'Promotions', 'Important', 'Social', 'Travel', 'Work',
  'Transactions', 'Personal', 'Finance', 'Shopping', 'News', 'Updates',
];

// Global processing status
let processingStatus = {
  isProcessing: false,
  totalEmails: 0,
  processedEmails: 0,
  errors: 0,
  startTime: null,
  currentBatch: 0,
  totalBatches: 0,
  completedBatches: 0,
  progressPercentage: 0,
  categories: {},
  logs: [],
  retryAttempts: 0,
  maxRetryAttempts: 3,
  failedBatches: [],
  retryingBatches: false,
  stoppedDueToQuota: false,
  errorDetails: null,
  lastGoogleError: null,
};

// Helper function to add logs
function addLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  processingStatus.logs.push(logEntry);
  console.log(logEntry);

  // Keep only last 100 logs
  if (processingStatus.logs.length > 100) {
    processingStatus.logs = processingStatus.logs.slice(-100);
  }
}

// Helper function to update progress
function updateProgress() {
  if (processingStatus.totalBatches > 0) {
    const percentage = Math.round((processingStatus.completedBatches / processingStatus.totalBatches) * 100);
    processingStatus.progressPercentage = percentage;

    const elapsed = Math.round((Date.now() - processingStatus.startTime) / 1000);
    const rate = elapsed > 0 ? Math.round(processingStatus.processedEmails / elapsed * 60) : 0;

    addLog(`📊 PROGRESS: ${percentage}% (${processingStatus.completedBatches}/${processingStatus.totalBatches} batches) | ${processingStatus.processedEmails} emails processed | ${rate} emails/min`);
  }
}

// Helper function for fast processing with minimal backoff
async function withBackoff(fn, maxRetries = 3, baseDelay = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await apiLimiter.removeTokens(1); // Consume one token per API call
      return await fn();
    } catch (error) {
      if (error.code === 429 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt); // Fast exponential backoff
        addLog(`⚠️ Rate limit hit, quick retry after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

// Batch categorize multiple emails with Gemini 2.0
async function batchCategorizeEmails(emailBatch, batchNumber) {
  let batchPrompt = `You are an advanced Gemini 2.0 email categorization AI with exceptional accuracy and understanding. Analyze each email with deep contextual comprehension and categorize it into EXACTLY ONE category from the list below.

CATEGORY DEFINITIONS (be very precise):

• **Work**: Business and professional communications, project updates, internal company announcements.
• **Meetings**: Calendar invites, meeting agendas, scheduling confirmations, and post-meeting summaries.
• **Promotions**: Marketing emails, sales offers, discount codes, newsletters from businesses, product advertisements. (e.g., "20% off sale!", "New product launch newsletter")
• **Important**: Truly critical notifications and urgent, time-sensitive communications that demand immediate attention and are not better suited to another specific category. (e.g., security alerts, final payment reminders if not 'Finance', critical system outage notifications). Avoid overusing; most emails fit other categories.
• **Social**: Notifications from social media platforms (Facebook, Twitter, LinkedIn, etc.), forum discussions, community engagement.
• **Travel**: Flight confirmations, hotel bookings, rental car reservations, trip itineraries, travel-related inquiries.
• **Transactions**: Purchase confirmations, receipts, shipping notifications, order updates, subscription confirmations. (e.g., "Your order has shipped", "Thank you for your payment")
• **Personal**: Direct communications between individuals for personal matters, family updates, friendly conversations. This is a good fallback if no other category is a strong fit.
• **Finance**: Banking alerts, credit card statements, investment updates, bills, loan information, insurance-related emails. (e.g., "Your monthly statement is ready", "Payment due for your utility bill")
• **Shopping**: Emails related to the broader shopping experience NOT covered by 'Promotions' or 'Transactions'. (e.g., abandoned cart reminders, product recommendations based on browsing, wishlist updates, "items you viewed").
• **News**: News articles, newsletters from news organizations, journalistic content, press releases from news outlets. (Distinguish from company 'Updates' about their own products/services).
• **Updates**: Notifications about software or service updates, terms of service changes, account activity summaries (if not 'Transactions' or 'Finance'), general announcements from services you use. (e.g., "New features added to our app", "Your data processing agreement has been updated")

STRICT RULES:
1. Read the subject line AND content preview carefully for full context.
2. Choose the MOST SPECIFIC and RELEVANT category that fits.
3. If an email could technically fit multiple categories, choose the one that represents its primary purpose or the most actionable information. For example, a bill (Finance) might be important, but 'Finance' is more specific.
4. News category is ONLY for actual news content or journalistic articles.
5. Work category is for professional/business communications.
6. Return ONLY the category name from the list above. No extra words, no numbers, no explanations.
7. Provide one category per line, in the same order as the input emails.

EXAMPLES OF CORRECT CATEGORIZATION:

EMAIL EXAMPLE 1:
Subject: "Your Tuesday Morning Flight to SFO is Confirmed"
Content Preview: "Dear Valued Customer, This email confirms your booking for flight UA 235 from JFK to SFO on Tuesday..."
---
CATEGORY: Travel

EMAIL EXAMPLE 2:
Subject: "Project Phoenix - Weekly Sync & Action Items"
Content Preview: "Hi Team, Reminder about our weekly sync for Project Phoenix today at 3 PM. Please find attached the agenda and last week's action items."
---
CATEGORY: Work

EMAIL EXAMPLE 3:
Subject: "Flash Sale! ⚡ Up to 50% off everything this weekend!"
Content Preview: "Don't miss out on our biggest sale of the season! Get up to 50% off all items, this weekend only. Shop now!"
---
CATEGORY: Promotions

EMAILS TO CATEGORIZE:
`;

  emailBatch.forEach((email, index) => {
    const subject = email.subject || 'No Subject';
    const snippet = email.snippet || '';

    batchPrompt += `
EMAIL ${index + 1}:
Subject: "${subject}"
Content Preview: "${snippet}"
---`;
  });

  batchPrompt += `

GEMINI 2.0 ADVANCED ANALYSIS INSTRUCTIONS:
- Use deep contextual understanding to analyze both subject and content.
- Apply semantic reasoning to understand the true intent and purpose.
- Consider sender context, tone, and communication patterns.
- Use advanced language comprehension to avoid keyword-only matching.
- Apply nuanced understanding to distinguish between similar categories based on their definitions.
- Leverage enhanced reasoning capabilities for edge cases.
- Prioritize semantic meaning over surface-level indicators.

RESPONSE FORMAT (REMINDER):
Return exactly ${emailBatch.length} category names, one per line, in the same order as the emails above.
Use ONLY these exact category names: ${predefinedCategories.join(', ')}

CATEGORIES:`;

  try {
    addLog(`📡 Batch ${batchNumber}: Sending ${emailBatch.length} emails to Gemini 2.0 Flash...`);
    const result = await model.generateContent(batchPrompt);
    const response = result.response.text().trim();

    const categories = response
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').trim())
      .slice(0, emailBatch.length);

    // Validate and clean categories
    const validatedCategories = categories.map((category, index) => {
      const cleanCategory = category.replace(/[^\w\s]/g, '').trim();
      const exactMatch = predefinedCategories.find(cat =>
        cat.toLowerCase() === cleanCategory.toLowerCase()
      );

      if (exactMatch) {
        return exactMatch;
      }

      const partialMatch = predefinedCategories.find(cat =>
        cat.toLowerCase().includes(cleanCategory.toLowerCase()) ||
        cleanCategory.toLowerCase().includes(cat.toLowerCase())
      );

      if (partialMatch) {
        addLog(`📝 Batch ${batchNumber}: Mapped "${category}" to "${partialMatch}"`);
        return partialMatch;
      }

      // Fallback logic based on content
      const email = emailBatch[index];
      const subject = (email.subject || '').toLowerCase();
      const snippet = (email.snippet || '').toLowerCase();

      if (subject.includes('meeting') || subject.includes('calendar') || snippet.includes('meeting')) {
        addLog(`📝 Batch ${batchNumber}: Auto-categorized email ${index + 1} as "Meetings" based on content`);
        return 'Meetings';
      }
      if (subject.includes('order') || subject.includes('purchase') || snippet.includes('receipt')) {
        addLog(`📝 Batch ${batchNumber}: Auto-categorized email ${index + 1} as "Transactions" based on content`);
        return 'Transactions';
      }
      if (subject.includes('promotion') || subject.includes('sale') || snippet.includes('discount')) {
        addLog(`📝 Batch ${batchNumber}: Auto-categorized email ${index + 1} as "Promotions" based on content`);
        return 'Promotions';
      }

      addLog(`⚠️ Batch ${batchNumber}: Unknown category "${category}" for email ${index + 1}, using "Personal"`);
      return 'Personal';
    });

    return validatedCategories;

  } catch (error) {
    addLog(`❌ Batch ${batchNumber} AI failed: ${error.message}`);
    return emailBatch.map(() => 'Personal');
  }
}

// Get emails with fast processing
async function batchGetEmails(gmail, emailIds, batchNumber) {
  addLog(`📦 Batch ${batchNumber}: Fetching ${emailIds.length} emails...`);

  const CONCURRENT_LIMIT = 10;
  const emails = [];
  let encounteredQuotaError = false;
  let quotaErrorDetails = null;

  for (let i = 0; i < emailIds.length; i += CONCURRENT_LIMIT) {
    if (encounteredQuotaError) break;

    const batch = emailIds.slice(i, i + CONCURRENT_LIMIT);

    const promises = batch.map(async (emailId, index) => {
      try {
        await new Promise(resolve => setTimeout(resolve, index * 50)); // Minimal stagger
        const response = await withBackoff(() =>
          gmail.users.messages.get({
            userId: 'me',
            id: emailId,
            format: 'metadata',
            metadataHeaders: ['Subject'],
          })
        );

        return {
          id: response.data.id,
          subject: response.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject',
          snippet: response.data.snippet || '',
        };
      } catch (error) {
        if (isGoogleQuotaError(error)) {
          encounteredQuotaError = true;
          quotaErrorDetails = error.response?.data?.error || error.message;
          addLog(`‼️ Batch ${batchNumber}: Google API Quota Limit hit while fetching email ${emailId}. Details: ${JSON.stringify(quotaErrorDetails)}. Further fetches in this batch will be stopped.`);
          return null;
        }
        addLog(`❌ Batch ${batchNumber}: Failed to fetch email ${emailId}: ${error.message}`);
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    emails.push(...batchResults.filter(email => email !== null));
    
    if (encounteredQuotaError) {
        addLog(`‼️ Batch ${batchNumber}: Halting email fetching for this batch due to Google Quota Error.`);
        break; 
    }

    if (i + CONCURRENT_LIMIT < emailIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Minimal delay
    }
  }
  return { emails, quotaErrorHit: encounteredQuotaError, errorDetails: quotaErrorDetails };
}

// Apply labels with fast processing and detailed failure tracking
async function batchApplyLabels(emailCategoryPairs, batchNumber, gmail, categoryToLabelIdMap) {
  let successful = 0;
  let failed = 0;
  const failedEmails = [];
  let encounteredQuotaError = false;
  let quotaErrorDetails = null;

  addLog(`🏷️ Batch ${batchNumber}: Preparing to apply labels using batchModify...`);

  // Group emails by the label ID they need
  const emailsByLabelId = {};
  for (const { emailId, category } of emailCategoryPairs) {
    const labelId = categoryToLabelIdMap[category];
    if (!labelId) {
      addLog(`⚠️ Batch ${batchNumber}: No label ID found for category "${category}" for email ${emailId}. Skipping.`);
      failed++;
      failedEmails.push({ emailId, category, error: `No label ID for category ${category}` });
      continue;
    }
    if (!emailsByLabelId[labelId]) {
      emailsByLabelId[labelId] = [];
    }
    emailsByLabelId[labelId].push(emailId);
  }

  const BATCH_MODIFY_CHUNK_SIZE = 100; // Max 100 IDs per batchModify call

  for (const labelId in emailsByLabelId) {
    const emailIdsForThisLabel = emailsByLabelId[labelId];
    const categoryName = Object.keys(categoryToLabelIdMap).find(key => categoryToLabelIdMap[key] === labelId); // For logging

    for (let i = 0; i < emailIdsForThisLabel.length; i += BATCH_MODIFY_CHUNK_SIZE) {
      if (encounteredQuotaError) break; // Stop if quota error hit within this function

      const chunkOfEmailIds = emailIdsForThisLabel.slice(i, i + BATCH_MODIFY_CHUNK_SIZE);

      try {
        addLog(`🏷️ Batch ${batchNumber}: Applying label "${categoryName || labelId}" to ${chunkOfEmailIds.length} emails via batchModify...`);
        // Minimal stagger might not be needed as much here, but withBackoff handles retries
        await withBackoff(() =>
          gmail.users.messages.batchModify({
            userId: 'me',
            resource: {
              ids: chunkOfEmailIds,
              addLabelIds: [labelId],
              // removeLabelIds: [] // Optional: if you need to remove other labels
            },
          })
        );
        successful += chunkOfEmailIds.length;
        // Update processingStatus.categories for successfully labeled emails
        if (categoryName && processingStatus.categories[categoryName]) {
            processingStatus.categories[categoryName] += chunkOfEmailIds.length;
        } else if (categoryName) {
            processingStatus.categories[categoryName] = chunkOfEmailIds.length;
        }

      } catch (error) {
        failed += chunkOfEmailIds.length;
        const errorMsg = error.message || 'Unknown batchModify error';
        if (isGoogleQuotaError(error)) {
          encounteredQuotaError = true;
          quotaErrorDetails = error.response?.data?.error || errorMsg;
          addLog(`‼️ Batch ${batchNumber}: Google API Quota Limit hit during batchModify for label "${categoryName || labelId}". Details: ${JSON.stringify(quotaErrorDetails)}`);
          // Mark all emails in this chunk as failed due to quota
          chunkOfEmailIds.forEach(emailId => {
            failedEmails.push({ emailId, category: categoryName || 'Unknown', error: `Quota limit during batchModify: ${quotaErrorDetails}` });
          });
        } else {
          addLog(`❌ Batch ${batchNumber}: Failed batchModify for label "${categoryName || labelId}" for ${chunkOfEmailIds.length} emails: ${errorMsg}`);
          chunkOfEmailIds.forEach(emailId => {
            failedEmails.push({ emailId, category: categoryName || 'Unknown', error: errorMsg });
          });
        }
      }
    }
    if (encounteredQuotaError) break; // Stop outer loop if quota error was hit
  }

  processingStatus.processedEmails += successful; // Count only successfully labeled ones toward main "processed" count
  processingStatus.errors += failed;

  addLog(`✅ Batch ${batchNumber}: batchModify results - Applied to ${successful} emails, ${failed} failed.`);
  return { successful, failed, failedEmails, quotaErrorHit: encounteredQuotaError, errorDetails: quotaErrorDetails };
}

// Retry failed batches with exponential backoff
async function retryFailedBatches(gmail, categoryToLabelIdMap) {
  if (processingStatus.failedBatches.length === 0) {
    addLog('✅ No failed batches to retry');
    return;
  }

  processingStatus.retryingBatches = true;
  processingStatus.retryAttempts++;

  const retryDelay = Math.min(1000 * Math.pow(2, processingStatus.retryAttempts - 1), 30000); // Max 30 seconds
  addLog(`🔄 RETRY ATTEMPT ${processingStatus.retryAttempts}/${processingStatus.maxRetryAttempts}: Retrying ${processingStatus.failedBatches.length} failed batches after ${retryDelay}ms delay...`);

  await new Promise(resolve => setTimeout(resolve, retryDelay));

  const batchesToRetry = [...processingStatus.failedBatches];
  processingStatus.failedBatches = []; // Clear failed batches for this retry attempt

  let retrySuccessful = 0;
  let retryFailed = 0;
  const stillFailedBatches = [];

  // Process retry batches with same parallel approach
  const retryPromises = batchesToRetry.map(async (failedBatch) => {
    const { batchNumber, batchIds, originalError } = failedBatch;

    try {
      addLog(`🔄 Retry Batch ${batchNumber}: Attempting to process ${batchIds.length} emails...`);

      // Get emails first
      const { emails, quotaErrorHit, errorDetails } = await batchGetEmails(gmail, batchIds, `${batchNumber}-retry-${processingStatus.retryAttempts}`);

      // Send to Gemini
      const categories = await batchCategorizeEmails(emails, `${batchNumber}-retry-${processingStatus.retryAttempts}`);

      const emailCategoryPairs = emails.map((email, idx) => ({
        emailId: email.id,
        category: categories[idx] || 'Personal',
      }));

      const { successful, failed, failedEmails } = await batchApplyLabels(emailCategoryPairs, `${batchNumber}-retry-${processingStatus.retryAttempts}`, gmail, categoryToLabelIdMap);

      retrySuccessful += successful;
      retryFailed += failed;

      // If there are still failures in this batch, track them for next retry
      if (failed > 0 && processingStatus.retryAttempts < processingStatus.maxRetryAttempts) {
        stillFailedBatches.push({
          batchNumber: `${batchNumber}-retry-${processingStatus.retryAttempts}`,
          batchIds: failedEmails.map(f => f.emailId),
          originalError: `Retry ${processingStatus.retryAttempts} partial failure: ${failed} emails failed`,
          failedEmails: failedEmails
        });
      }

      addLog(`✅ Retry Batch ${batchNumber}: ${successful} successful, ${failed} failed`);
      return { success: true, batchNumber, successful, failed };

    } catch (error) {
      addLog(`❌ Retry Batch ${batchNumber}: Still failing: ${error.message}`);
      retryFailed += batchIds.length;

      // Track for next retry if we haven't exceeded max attempts
      if (processingStatus.retryAttempts < processingStatus.maxRetryAttempts) {
        stillFailedBatches.push({
          batchNumber: `${batchNumber}-retry-${processingStatus.retryAttempts}`,
          batchIds: batchIds,
          originalError: error.message,
          failedEmails: []
        });
      }

      return { success: false, batchNumber, error: error.message };
    }
  });

  // Wait for all retry attempts to complete
  const retryResults = await Promise.allSettled(retryPromises);

  // Update failed batches for next retry attempt
  processingStatus.failedBatches = stillFailedBatches;

  addLog(`🔄 Retry attempt ${processingStatus.retryAttempts} completed: ${retrySuccessful} successful, ${retryFailed} failed`);

  // If we still have failures and haven't exceeded max retries, schedule another retry
  if (processingStatus.failedBatches.length > 0 && processingStatus.retryAttempts < processingStatus.maxRetryAttempts) {
    addLog(`⏳ ${processingStatus.failedBatches.length} batches still failing, will retry again...`);
    await retryFailedBatches(gmail, categoryToLabelIdMap);
  } else if (processingStatus.failedBatches.length > 0) {
    addLog(`❌ FINAL FAILURE: ${processingStatus.failedBatches.length} batches failed after ${processingStatus.maxRetryAttempts} retry attempts`);
    processingStatus.failedBatches.forEach(batch => {
      addLog(`❌ Permanently failed batch ${batch.batchNumber}: ${batch.batchIds.length} emails - ${batch.originalError}`);
    });
  } else {
    addLog(`🎉 ALL RETRY ATTEMPTS SUCCESSFUL! No more failed batches.`);
  }

  processingStatus.retryingBatches = false;
}

// Main processing function
async function processEmailsParallel(userAuth = null) {
  try {
    processingStatus.isProcessing = true;
    processingStatus.startTime = Date.now();
    processingStatus.logs = [];
    processingStatus.categories = {};
    processingStatus.processedEmails = 0;
    processingStatus.errors = 0;
    processingStatus.currentBatch = 0;
    processingStatus.completedBatches = 0;
    processingStatus.progressPercentage = 0;
    processingStatus.retryAttempts = 0;
    processingStatus.failedBatches = [];
    processingStatus.retryingBatches = false;
    processingStatus.stoppedDueToQuota = false;
    processingStatus.errorDetails = null;

    addLog('🚀 Starting ULTIMATE PARALLEL email processing...');

    // Setup Gmail client with user authentication
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.redirectUri
    );

    if (userAuth && userAuth.accessToken && userAuth.refreshToken) {
      // Use user-specific tokens
      oauth2Client.setCredentials({
        access_token: userAuth.accessToken,
        refresh_token: userAuth.refreshToken,
      });
    } else {
      // Fallback to global refresh token (for backward compatibility)
      oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // --- Ensure all Maily labels exist and get their IDs ---
    addLog('🏷️ Ensuring all "Maily/" labels exist and fetching their IDs...');
    const categoryToLabelIdMap = {};
    const existingGmailLabels = await getAllLabels(gmail, 'INIT'); // Get all labels once

    for (const category of predefinedCategories) {
      const labelName = `Maily/${category}`;
      let foundLabel = existingGmailLabels.find(l => l.name === labelName);

      if (foundLabel) {
        categoryToLabelIdMap[category] = foundLabel.id;
      } else {
        addLog(`🏷️ Label "${labelName}" not found, creating it...`);
        try {
          const newLabel = await withBackoff(() => gmail.users.labels.create({
            userId: 'me',
            resource: {
              name: labelName,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
            },
          }));
          categoryToLabelIdMap[category] = newLabel.data.id;
          addLog(`🏷️ Created label "${labelName}" with ID ${newLabel.data.id}`);
        } catch (error) {
          if (isGoogleQuotaError(error)) {
             addLog(`‼️ Google API Quota Limit hit while trying to create label "${labelName}". Processing cannot continue safely without all labels.`);
             processingStatus.errorDetails = `Stopped due to Google API Quota Limit during label creation for "${labelName}".`;
             processingStatus.stoppedDueToQuota = true;
             processingStatus.lastGoogleError = {
                 code: error.response?.status || error.code,
                 reason: error.response?.data?.error?.errors?.[0]?.reason || 'quotaExceeded',
                 message: error.response?.data?.error?.message || error.message
             };
             throw error; // Propagate to main catch
          }
          addLog(`❌ Failed to create label "${labelName}": ${error.message}. This category will be skipped for labeling if it was critical.`);
          // Decide if you want to throw an error here or continue without this label
          // For now, we'll log and continue, emails for this category won't be labeled.
        }
      }
    }
    addLog('✅ All necessary "Maily/" labels verified/created.');
    // --- End of label creation ---

    // Get already processed emails
    addLog('📊 Finding already processed emails and fetching all message IDs...');
    const currentLabels = await getAllLabels(gmail, 'parallel-processing');
    const mailyLabels = currentLabels.filter(label => label.name.startsWith('Maily/'));

    const processedEmailIds = new Set();
    for (const label of mailyLabels) {
      try {
        const response = await withBackoff(() =>
          gmail.users.messages.list({
            userId: 'me',
            labelIds: [label.id],
            maxResults: 500,
          })
        );
        const messages = response.data.messages || [];
        messages.forEach(msg => processedEmailIds.add(msg.id));
      } catch (error) {
        addLog(`⚠️ Failed to fetch messages for label ${label.name}: ${error.message}`);
      }
    }

    addLog(`✅ Found ${processedEmailIds.size} already processed emails`);

    // Fetch all message IDs (Example - replace with your actual logic for fetching all IDs)
    // This is a critical point for potential quota errors.
    let allMessageIds = [];
    let nextPageToken = null;
    let attempts = 0;
    const MAX_ID_FETCH_ATTEMPTS = 5;
    do {
      try {
        attempts++;
        const listResponse = await gmail.users.messages.list({
          userId: 'me',
          // q: '-in:chats -label:MailyProcessed', // Example query: not chats, not already MailyProcessed
          maxResults: 500, // Max per page
          pageToken: nextPageToken,
        });
        if (listResponse.data.messages) {
          allMessageIds.push(...listResponse.data.messages.map(m => m.id));
        }
        nextPageToken = listResponse.data.nextPageToken;
        if (attempts > 1) addLog(`Fetched page ${attempts} of email IDs.`);
        await new Promise(resolve => setTimeout(resolve, 200 * attempts)); // Basic delay between pages
      } catch (e) {
        if (isGoogleQuotaError(e) && attempts >= MAX_ID_FETCH_ATTEMPTS) {
          throw e; // Re-throw to be caught by main try-catch if max attempts reached
        }
        if (isGoogleQuotaError(e)){
            addLog(`Quota issue fetching page ${attempts} of IDs, retrying after delay... Error: ${e.message}`)
            await new Promise(resolve => setTimeout(resolve, 5000 * attempts)); // Longer delay for quota issues
            nextPageToken = nextPageToken; // retry current page
            continue;
        }
        throw e; // Re-throw other errors immediately
      }
    } while (nextPageToken && allMessageIds.length < 25000); // Safety cap, adjust as needed

    // Filter out already processed, etc. (your existing logic)
    const unprocessedEmailIds = allMessageIds.filter(id => !processedEmailIds.has(id));
    processingStatus.totalEmails = unprocessedEmailIds.length;
    addLog(`Total emails to process: ${processingStatus.totalEmails}`);
    if (processingStatus.totalEmails === 0) {
      addLog('✅ No new emails to process.');
      processingStatus.isProcessing = false;
      return; // Exit if no emails
    }

    const BATCH_SIZE = 200; // Or your configured batch size
    processingStatus.totalBatches = Math.ceil(processingStatus.totalEmails / BATCH_SIZE);

    // Main batch processing loop
    const CONCURRENT_MAIN_BATCHES = 10; // Number of full batches to process concurrently
    let batchPromises = [];

    for (let i = 0; i < unprocessedEmailIds.length; i += BATCH_SIZE) {
      if (processingStatus.stoppedDueToQuota) {
        addLog('🛑 Main processing loop halted due to prior Google Quota Error.');
        break;
      }

      const currentBatchNumberForDisplay = Math.floor(i / BATCH_SIZE) + 1;
      const emailIdBatchForThisPromise = unprocessedEmailIds.slice(i, i + BATCH_SIZE);

      // Define the task for processing one full batch
      const task = async (batchNum, idBatch) => {
        addLog(`🚀 Starting processing for Batch ${batchNum}/${processingStatus.totalBatches}`);
        // processingStatus.currentBatch = batchNum; // Less accurate with concurrency, log batchNum instead

        try {
          const emailFetchResult = await batchGetEmails(gmail, idBatch, batchNum);
          if (emailFetchResult.quotaErrorHit) {
            const quotaError = new Error(`Google API Quota Limit encountered during email fetching in Batch ${batchNum}.`);
            quotaError.details = emailFetchResult.errorDetails;
            quotaError.isQuotaError = true;
            processingStatus.lastGoogleError = {
                code: 429, 
                reason: 'quotaExceededFetching',
                message: typeof emailFetchResult.errorDetails === 'string' ? emailFetchResult.errorDetails : JSON.stringify(emailFetchResult.errorDetails)
            };
            throw quotaError;
          }
          const emailsForCategorization = emailFetchResult.emails;

          if (emailsForCategorization.length === 0) {
            if (idBatch.length > 0) {
              addLog(`⚠️ Batch ${batchNum}: No emails were fetched for ${idBatch.length} IDs (non-quota failure or all filtered). These IDs will be marked as errors for this batch.`);
              // These are effectively errors for this batch attempt.
              // They won't be retried unless the whole batch is retried due to another issue.
              return { batchNum, success: true, quotaHit: false, processedCount: 0, errorCount: idBatch.length, fullyProcessedInTask: 0 };
            } else {
              addLog(`Batch ${batchNum}: Skipped as no email IDs were provided for this task.`);
              return { batchNum, success: true, quotaHit: false, processedCount: 0, errorCount: 0, fullyProcessedInTask: 0 };
            }
          }

          const categories = await batchCategorizeEmails(emailsForCategorization, batchNum);

          const emailCategoryPairs = emailsForCategorization.map((email, idx) => ({
            emailId: email.id,
            category: categories[idx] || 'Personal'
          }));

          const labelApplyResult = await batchApplyLabels(emailCategoryPairs, batchNum, gmail, categoryToLabelIdMap);
          
          // `processedEmails` and `errors` are updated *within* batchApplyLabels directly into processingStatus.
          // We need to return the counts for this specific task for logging/summary if needed,
          // but the global status is already updated by batchApplyLabels.

          if (labelApplyResult.quotaErrorHit) {
            const quotaError = new Error(`Google API Quota Limit encountered during label application in Batch ${batchNum}.`);
            quotaError.details = labelApplyResult.errorDetails;
            quotaError.isQuotaError = true;
             processingStatus.lastGoogleError = {
                code: 429,
                reason: 'quotaExceededLabeling',
                message: typeof labelApplyResult.errorDetails === 'string' ? labelApplyResult.errorDetails : JSON.stringify(labelApplyResult.errorDetails)
            };
            // batchApplyLabels already adds its failedEmails to a list it returns.
            // If quota, these are likely all emails in its attempt.
            // Add to processingStatus.failedBatches if a retry mechanism should handle these.
             processingStatus.failedBatches.push({
                batchNumber: batchNum,
                batchIds: emailCategoryPairs.map(pair => pair.emailId), // The IDs that were attempted for labeling
                originalError: `Quota limit during label application: ${JSON.stringify(labelApplyResult.errorDetails)}`,
                failedEmails: labelApplyResult.failedEmails || emailCategoryPairs.map(pair => ({ ...pair, error: 'Quota during labeling' }))
            });
            throw quotaError;
          }

          // Handle non-quota failures from batchApplyLabels being added to failedBatches
          if (labelApplyResult.failedEmails && labelApplyResult.failedEmails.length > 0) {
            const nonQuotaFailedLabeling = labelApplyResult.failedEmails.filter(f => {
                const errMsg = (f.error || '').toLowerCase();
                // A simple check; isGoogleQuotaError might be more robust if f.error is an error object
                return !isGoogleQuotaError({ message: errMsg, response: { data: { error: { message: errMsg } } } });
            });

            if (nonQuotaFailedLabeling.length > 0) {
                processingStatus.failedBatches.push({
                    batchNumber: batchNum,
                    batchIds: nonQuotaFailedLabeling.map(f => f.emailId),
                    originalError: `Batch ${batchNum} had ${nonQuotaFailedLabeling.length} non-quota labeling failures.`,
                    failedEmails: nonQuotaFailedLabeling
                });
                addLog(`📝 Batch ${batchNum}: ${nonQuotaFailedLabeling.length} emails from labeling (non-quota) added to retry queue.`);
            }
          }
          
          addLog(`✅ Batch ${batchNum} completed its task (fetch, categorize, label). Successful labels: ${labelApplyResult.successful}, Failed labels: ${labelApplyResult.failed}.`);
          return { batchNum, success: true, quotaHit: false, processedCount: labelApplyResult.successful, errorCount: labelApplyResult.failed, fullyProcessedInTask: labelApplyResult.successful };

        } catch (error) {
          if (error.isQuotaError) {
            addLog(`‼️🛑 Quota error in Batch ${batchNum} task: ${error.message}.`);
            processingStatus.stoppedDueToQuota = true; // Critical: Signal main loop and other tasks
            return { batchNum, success: false, quotaHit: true, error, processedCount: 0, errorCount: idBatch.length, fullyProcessedInTask: 0 };
          }
          // Non-quota critical error for this task (e.g. unexpected issue in categorizeEmails not caught internally)
          addLog(`❌ Batch ${batchNum} task failed critically (non-quota): ${error.message}. Adding entire ID batch to retries.`);
          processingStatus.failedBatches.push({
            batchNumber: batchNum,
            batchIds: idBatch,
            originalError: error.message,
            failedEmails: idBatch.map(id => ({ emailId: id, category: 'Unknown', error: error.message }))
          });
          return { batchNum, success: false, quotaHit: false, error, processedCount: 0, errorCount: idBatch.length, fullyProcessedInTask: 0 };
        }
      };

      batchPromises.push(task(currentBatchNumberForDisplay, emailIdBatchForThisPromise));

      if (batchPromises.length >= CONCURRENT_MAIN_BATCHES || (i + BATCH_SIZE) >= unprocessedEmailIds.length) {
        addLog(`🔷 Processing a set of ${batchPromises.length} batches concurrently...`);
        const results = await Promise.allSettled(batchPromises);
        let anyQuotaErrorInSet = false;

        results.forEach(result => {
          processingStatus.completedBatches++; // Each task attempt counts as one completed batch for progress
          if (result.status === 'fulfilled') {
            const data = result.value;
            if (data.quotaHit) {
              anyQuotaErrorInSet = true;
              processingStatus.stoppedDueToQuota = true; // Ensure this is set if any task reported it
            }
            // Note: `processingStatus.processedEmails` and `processingStatus.errors` are globally updated
            // by `batchApplyLabels` or by the task's error handling for full batch failures.
            // `data.fullyProcessedInTask` reflects emails that made it all the way through labeling in this task.
          } else { // 'rejected' - task function should catch its own errors and always fulfill
            addLog(`💥 Critical unhandled rejection for a batch task (Batch Num unknown from here): ${result.reason}. This indicates a flaw in the task's error handling.`);
            // This is bad, means an error wasn't caught by the task.
            // We should assume a general failure and try to stop.
            anyQuotaErrorInSet = true; // Treat as a critical stop condition
            processingStatus.stoppedDueToQuota = true; // Treat as critical
            processingStatus.errorDetails = `Unhandled rejection in concurrent task: ${result.reason}`;
          }
        });
        
        updateProgress(); // Update overall progress after a set of batches
        batchPromises = []; // Reset for the next set of tasks

        if (anyQuotaErrorInSet) {
          addLog('🛑 Quota error detected in the processed set of batches. Halting further batch scheduling.');
          break; 
        }
      }
    }
    // The loop structure ensures all batches are pushed and awaited if CONCURRENT_MAIN_BATCHES is not a clean divisor.

    if (processingStatus.failedBatches.length > 0 && !processingStatus.stoppedDueToQuota) {
      await retryFailedBatches(gmail, categoryToLabelIdMap);
    }

    if (!processingStatus.stoppedDueToQuota) {
      addLog('✅🎉 Ultimate parallel email processing completed successfully!');
      processingStatus.errorDetails = null; // Clear any previous minor errors if successfully completed
    }

  } catch (error) {
    if (isGoogleQuotaError(error)) {
      const errDetail = error.details || error.response?.data?.error || error.message;
      const reason = (typeof errDetail === 'string' ? errDetail : (errDetail?.errors?.[0]?.reason || errDetail?.message || 'Unknown quota issue'));
      addLog(`‼️🛑 HALTED: Google API Quota Limit encountered: ${reason}. Processing stopped.`);
      addLog(`Full Google error details: ${typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail)}`);
      processingStatus.errorDetails = `Stopped due to Google API Quota Limit (${reason}). Please wait (potentially several hours or until tomorrow) and then re-initiate processing.`;
      processingStatus.stoppedDueToQuota = true;
      processingStatus.lastGoogleError = {
          code: error.response?.status || error.code || (error.details?.code),
          reason: reason,
          message: typeof errDetail === 'string' ? errDetail : (errDetail?.message || error.message)
      };
    } else {
      addLog(`❌ Processing failed critically: ${error.message}`);
      processingStatus.errorDetails = error.message; // Generic error for non-quota critical failures
    }
  } finally {
    processingStatus.isProcessing = false;
    addLog(processingStatus.stoppedDueToQuota ? 'Processing stopped due to Google Quota limits.' : 'Processing run finished.');
    // Any other cleanup
  }
}

// Get current processing status
function getProcessingStatus() {
  return processingStatus;
}

// Reset processing status
function resetProcessingStatus() {
  processingStatus = {
    isProcessing: false,
    totalEmails: 0,
    processedEmails: 0,
    errors: 0,
    startTime: null,
    currentBatch: 0,
    totalBatches: 0,
    completedBatches: 0,
    progressPercentage: 0,
    categories: {},
    logs: [],
    retryAttempts: 0,
    maxRetryAttempts: 3,
    failedBatches: [],
    retryingBatches: false,
    stoppedDueToQuota: false,
    errorDetails: null,
    lastGoogleError: null,
  };
}

module.exports = {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  addLog,
};