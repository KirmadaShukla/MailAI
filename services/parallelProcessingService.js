const { applyLabel, getAllLabels } = require('./gmailService');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const { google } = require('googleapis');
const { RateLimiter } = require('limiter');

// Initialize global rate limiter (200 API calls per second, fast processing)
const apiLimiter = new RateLimiter({ tokensPerInterval: 200, interval: 'second' });

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

• **Work**: Business and professional communications
• **Meetings**: Calendar invites and meeting-related communications
• **Promotions**: Marketing and promotional content
• **Important**: Critical notifications and urgent communications
• **Social**: Social media and community-related content
• **Travel**: Travel bookings and trip-related communications
• **Transactions**: Purchase confirmations and payment-related emails
• **Personal**: Personal communications and private matters
• **Finance**: Banking and financial-related communications
• **Shopping**: E-commerce and shopping-related emails
• **News**: News articles and journalistic content
• **Updates**: Software and service update notifications

STRICT RULES:
1. Read the subject line AND content carefully
2. Choose the MOST SPECIFIC category that fits
3. If unsure between categories, choose the more specific one
4. News category is ONLY for actual news content, newsletters, or journalistic articles
5. Work category is for professional/business communications
6. Return ONLY the category name, nothing else
7. One category per line, in the same order as emails

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
- Use deep contextual understanding to analyze both subject and content
- Apply semantic reasoning to understand the true intent and purpose
- Consider sender context, tone, and communication patterns
- Use advanced language comprehension to avoid keyword-only matching
- Apply nuanced understanding to distinguish between similar categories
- Leverage enhanced reasoning capabilities for edge cases
- Prioritize semantic meaning over surface-level indicators

RESPONSE FORMAT:
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

  const CONCURRENT_LIMIT = 10; // High concurrency for speed
  const emails = [];

  for (let i = 0; i < emailIds.length; i += CONCURRENT_LIMIT) {
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
        addLog(`❌ Batch ${batchNumber}: Failed to fetch email ${emailId}: ${error.message}`);
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    emails.push(...batchResults.filter(email => email !== null));

    if (i + CONCURRENT_LIMIT < emailIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Minimal delay
    }
  }

  addLog(`✅ Batch ${batchNumber}: Fetched ${emails.length} emails`);
  return emails;
}

// Apply labels with fast processing and detailed failure tracking
async function batchApplyLabels(emailCategoryPairs, batchNumber, gmail) {
  const LABEL_BATCH_SIZE = 10; // High batch size for speed
  let successful = 0;
  let failed = 0;
  const failedEmails = [];

  for (let i = 0; i < emailCategoryPairs.length; i += LABEL_BATCH_SIZE) {
    const batch = emailCategoryPairs.slice(i, i + LABEL_BATCH_SIZE);

    const promises = batch.map(async ({ emailId, category }, index) => {
      try {
        await new Promise(resolve => setTimeout(resolve, index * 25)); // Minimal stagger
        await withBackoff(() => applyLabel(emailId, category, gmail));

        processingStatus.categories[category] = (processingStatus.categories[category] || 0) + 1;
        return { success: true, emailId, category };
      } catch (error) {
        addLog(`❌ Batch ${batchNumber}: Failed to apply label "${category}" to ${emailId}: ${error.message}`);
        return { success: false, error: error.message, emailId, category };
      }
    });

    const results = await Promise.all(promises);
    successful += results.filter(r => r.success).length;
    failed += results.filter(r => !r.success).length;

    // Track failed emails for retry
    failedEmails.push(...results.filter(r => !r.success));

    processingStatus.processedEmails += results.filter(r => r.success).length;
    processingStatus.errors += results.filter(r => !r.success).length;

    if (i + LABEL_BATCH_SIZE < emailCategoryPairs.length) {
      await new Promise(resolve => setTimeout(resolve, 50)); // Minimal delay
    }
  }

  addLog(`✅ Batch ${batchNumber}: Applied ${successful} labels (${failed} failed)`);
  return { successful, failed, failedEmails };
}

// Retry failed batches with exponential backoff
async function retryFailedBatches(gmail) {
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
      const emails = await batchGetEmails(gmail, batchIds, `${batchNumber}-retry-${processingStatus.retryAttempts}`);

      // Send to Gemini
      const categories = await batchCategorizeEmails(emails, `${batchNumber}-retry-${processingStatus.retryAttempts}`);

      const emailCategoryPairs = emails.map((email, idx) => ({
        emailId: email.id,
        category: categories[idx] || 'Personal',
      }));

      const { successful, failed, failedEmails } = await batchApplyLabels(emailCategoryPairs, `${batchNumber}-retry-${processingStatus.retryAttempts}`, gmail);

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
    await retryFailedBatches(gmail);
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

    // Get already processed emails
    addLog('📊 Finding already processed emails...');
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

    // Get all email IDs
    addLog('📧 Getting all email IDs...');
    let allEmailIds = [];
    let pageToken = null;

    do {
      const response = await withBackoff(() =>
        gmail.users.messages.list({
          userId: 'me',
          maxResults: 500,
          pageToken: pageToken,
        })
      );

      const messages = response.data.messages || [];
      allEmailIds = allEmailIds.concat(messages.map(msg => msg.id));
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    // Filter unprocessed email IDs
    const unprocessedEmailIds = allEmailIds.filter(id => !processedEmailIds.has(id));
    processingStatus.totalEmails = unprocessedEmailIds.length;

    addLog(`📊 Total emails: ${allEmailIds.length}`);
    addLog(`✅ Already processed: ${allEmailIds.length - unprocessedEmailIds.length}`);
    addLog(`⏳ Need processing: ${unprocessedEmailIds.length}`);

    if (unprocessedEmailIds.length === 0) {
      addLog('🎉 ALL EMAILS ARE ALREADY PROCESSED!');
      processingStatus.isProcessing = false;
      return;
    }

    // Create batches
    const BATCH_SIZE = 200; // Large batch size for maximum speed
    const batches = [];

    for (let i = 0; i < unprocessedEmailIds.length; i += BATCH_SIZE) {
      const batchIds = unprocessedEmailIds.slice(i, i + BATCH_SIZE);
      batches.push(batchIds);
    }

    processingStatus.totalBatches = batches.length;
    addLog(`📦 Created ${batches.length} batches of ~${BATCH_SIZE} emails each`);

    // ULTIMATE FIRE-AND-FORGET: Send ALL batches to Gemini immediately, apply labels as responses arrive
    addLog(`🚀 ULTIMATE FIRE-AND-FORGET: Sending ALL ${batches.length} batches to Gemini immediately!`);

    let completedBatches = 0;
    const totalBatches = batches.length;

    // Start all batches immediately - no waiting, no sequential processing
    const allBatchPromises = batches.map(async (batchIds, index) => {
      const batchNumber = index + 1;

      try {
        addLog(`📤 Batch ${batchNumber}/${totalBatches}: Fetching emails...`);

        // Get emails first
        const emails = await batchGetEmails(gmail, batchIds, batchNumber);

        addLog(`🧠 Batch ${batchNumber}: Sending ${emails.length} emails to Gemini...`);

        // Send to Gemini and process response immediately when it arrives
        const categories = await batchCategorizeEmails(emails, batchNumber);
        addLog(`✅ Batch ${batchNumber}: Got Gemini response! Applying labels immediately...`);

        const emailCategoryPairs = emails.map((email, idx) => ({
          emailId: email.id,
          category: categories[idx] || 'Personal',
        }));

        const { successful, failed, failedEmails } = await batchApplyLabels(emailCategoryPairs, batchNumber, gmail);

        // Track failed emails for retry if any
        if (failed > 0) {
          processingStatus.failedBatches.push({
            batchNumber: batchNumber,
            batchIds: failedEmails.map(f => f.emailId),
            originalError: `Initial processing failure: ${failed} emails failed`,
            failedEmails: failedEmails
          });
        }

        // Update progress tracking
        completedBatches++;
        processingStatus.completedBatches = completedBatches;
        processingStatus.currentBatch = Math.max(processingStatus.currentBatch, batchNumber);

        // Update progress percentage and show progress
        updateProgress();

        return { batchNumber, successful, failed, total: emails.length, status: 'fulfilled' };

      } catch (batchError) {
        addLog(`❌ Batch ${batchNumber}: Failed: ${batchError.message}`);

        // Track completely failed batch for retry
        processingStatus.failedBatches.push({
          batchNumber: batchNumber,
          batchIds: batchIds,
          originalError: batchError.message,
          failedEmails: []
        });

        return { batchNumber, successful: 0, failed: batchIds.length, total: batchIds.length, status: 'rejected', error: batchError.message };
      }
    });

    addLog(`🔥 All ${batches.length} batches sent! Processing responses as they arrive with retry logic...`);

    // Wait for all batches to complete (but they process independently)
    const allResults = await Promise.allSettled(allBatchPromises);

    // Process final results
    allResults.forEach((result, index) => {
      const batchNumber = index + 1;
      if (result.status === 'fulfilled') {
        const { successful, failed, total } = result.value;
        addLog(`✅ Batch ${batchNumber} completed: ${successful} successful, ${failed} failed, ${total} total`);
      } else {
        addLog(`❌ Batch ${batchNumber} failed completely: ${result.reason}`);
        processingStatus.errors += batches[index].length;
      }
    });

    // RETRY LOGIC: Process any failed batches
    if (processingStatus.failedBatches.length > 0) {
      addLog(`🔄 STARTING RETRY PHASE: ${processingStatus.failedBatches.length} batches need retry...`);
      await retryFailedBatches(gmail);
    } else {
      addLog(`🎉 NO RETRIES NEEDED: All batches processed successfully on first attempt!`);
    }

    // Final results
    const totalTime = Math.round((Date.now() - processingStatus.startTime) / 1000);
    const avgRate = totalTime > 0 ? Math.round(processingStatus.processedEmails / totalTime * 60) : 0;

    // Final progress update
    processingStatus.progressPercentage = 100;
    addLog(`🎉 100% COMPLETE! ULTIMATE PARALLEL PROCESSING WITH RETRY LOGIC FINISHED!`);
    addLog(`✅ Successfully processed: ${processingStatus.processedEmails} emails`);
    addLog(`❌ Final errors: ${processingStatus.errors} emails`);
    addLog(`🔄 Retry attempts made: ${processingStatus.retryAttempts}/${processingStatus.maxRetryAttempts}`);
    addLog(`📦 Failed batches remaining: ${processingStatus.failedBatches.length}`);
    addLog(`⏱️ Total time: ${Math.floor(totalTime / 60)}m ${totalTime % 60}s`);
    addLog(`🚀 Average rate: ${avgRate} emails/minute`);
    addLog(`📊 Category distribution: ${JSON.stringify(processingStatus.categories)}`);

    processingStatus.isProcessing = false;

  } catch (error) {
    addLog(`❌ Processing failed: ${error.message}`);
    processingStatus.isProcessing = false;
    throw error;
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
  };
}

module.exports = {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  addLog,
};