const { applyLabel, getAllLabels } = require('./gmailService');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const { google } = require('googleapis');

// Initialize Gemini with the latest and most advanced model
const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash-exp',  // Latest Gemini 2.0 Flash - most advanced model available
  generationConfig: {
    temperature: 0.03,  // Very low temperature for maximum consistency
    topP: 0.95,
    topK: 15,
    maxOutputTokens: 8192,
  }
});

const predefinedCategories = [
  'Meetings', 'Promotions', 'Important', 'Social', 'Travel', 'Work',
  'Transactions', 'Personal', 'Finance', 'Shopping', 'News', 'Updates'
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
  categories: {},
  logs: []
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

// Batch categorize multiple emails with Gemini 2.0 advanced accuracy
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
    addLog(`� Batch ${batchNumber}: Sending ${emailBatch.length} emails to Gemini 2.0 Flash...`);
    const result = await model.generateContent(batchPrompt);
    const response = result.response.text().trim();

    const categories = response
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').trim())
      .slice(0, emailBatch.length);

    // addLog(`✅ Batch ${batchNumber}: Received ${categories.length} categorizations`);

    // Validate and clean categories with better fallback logic
    const validatedCategories = categories.map((category, index) => {
      // Clean the category response
      const cleanCategory = category.replace(/[^\w\s]/g, '').trim();

      // Find exact match first
      const exactMatch = predefinedCategories.find(cat =>
        cat.toLowerCase() === cleanCategory.toLowerCase()
      );

      if (exactMatch) {
        return exactMatch;
      }

      // Find partial match
      const partialMatch = predefinedCategories.find(cat =>
        cat.toLowerCase().includes(cleanCategory.toLowerCase()) ||
        cleanCategory.toLowerCase().includes(cat.toLowerCase())
      );

      if (partialMatch) {
        addLog(`📝 Batch ${batchNumber}: Mapped "${category}" to "${partialMatch}"`);
        return partialMatch;
      }

      // Intelligent fallback based on email content
      const email = emailBatch[index];
      const subject = (email.subject || '').toLowerCase();
      const snippet = (email.snippet || '').toLowerCase();

      // Smart fallback logic
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

// Get emails efficiently with rate limiting
async function batchGetEmails(gmail, emailIds, batchNumber) {
  addLog(`📦 Batch ${batchNumber}: Fetching ${emailIds.length} emails...`);

  const CONCURRENT_LIMIT = 8; // Reduced for rate limiting
  const emails = [];

  for (let i = 0; i < emailIds.length; i += CONCURRENT_LIMIT) {
    const batch = emailIds.slice(i, i + CONCURRENT_LIMIT);

    const promises = batch.map(async (emailId, index) => {
      try {
        // Stagger requests to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, index * 50));

        const response = await gmail.users.messages.get({
          userId: 'me',
          id: emailId,
          format: 'metadata',
          metadataHeaders: ['Subject']
        });

        return {
          id: response.data.id,
          subject: response.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject',
          snippet: response.data.snippet || ''
        };
      } catch (error) {
        if (error.code === 429) {
          addLog(`⚠️ Rate limit hit for email ${emailId}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            const response = await gmail.users.messages.get({
              userId: 'me',
              id: emailId,
              format: 'metadata',
              metadataHeaders: ['Subject']
            });
            return {
              id: response.data.id,
              subject: response.data.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject',
              snippet: response.data.snippet || ''
            };
          } catch (retryError) {
            addLog(`❌ Failed to fetch email ${emailId} after retry`);
            return null;
          }
        }
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    const validEmails = batchResults.filter(email => email !== null);
    emails.push(...validEmails);

    // Rate limiting delay between batches
    if (i + CONCURRENT_LIMIT < emailIds.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  addLog(`✅ Batch ${batchNumber}: Fetched ${emails.length} emails`);
  return emails;
}

// Apply labels in controlled batches with rate limiting
async function batchApplyLabels(emailCategoryPairs, batchNumber) {

  const LABEL_BATCH_SIZE = 5; // Reduced to avoid rate limits
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < emailCategoryPairs.length; i += LABEL_BATCH_SIZE) {
    const batch = emailCategoryPairs.slice(i, i + LABEL_BATCH_SIZE);

    const promises = batch.map(async ({ emailId, category }, index) => {
      try {
        // Stagger label applications to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, index * 200));

        await applyLabel(emailId, category);

        // Update category count
        if (!processingStatus.categories[category]) {
          processingStatus.categories[category] = 0;
        }
        processingStatus.categories[category]++;

        return { success: true, emailId, category };
      } catch (error) {
        if (error.message && error.message.includes('429')) {
          addLog(`⚠️ Rate limit hit applying label to ${emailId}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          try {
            await applyLabel(emailId, category);
            if (!processingStatus.categories[category]) {
              processingStatus.categories[category] = 0;
            }
            processingStatus.categories[category]++;
            return { success: true, emailId, category };
          } catch (retryError) {
            addLog(`❌ Failed to apply label to ${emailId} after retry: ${retryError.message}`);
            return { success: false, error: retryError.message, emailId };
          }
        }
        addLog(`❌ Error applying label to ${emailId}: ${error.message}`);
        return { success: false, error: error.message, emailId };
      }
    });

    const results = await Promise.all(promises);

    const batchSuccessful = results.filter(r => r.success).length;
    const batchFailed = results.filter(r => !r.success).length;

    successful += batchSuccessful;
    failed += batchFailed;

    // Update global status
    processingStatus.processedEmails += batchSuccessful;
    processingStatus.errors += batchFailed;

    // Rate limiting delay between label batches
    if (i + LABEL_BATCH_SIZE < emailCategoryPairs.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  addLog(`✅ Batch ${batchNumber}: Applied ${successful} labels (${failed} failed)`);
  return { successful, failed };
}

// Main processing function
async function processEmailsParallel() {
  try {
    processingStatus.isProcessing = true;
    processingStatus.startTime = Date.now();
    processingStatus.logs = [];
    processingStatus.categories = {};
    processingStatus.processedEmails = 0;
    processingStatus.errors = 0;
    processingStatus.currentBatch = 0;

    addLog('🚀 Starting ULTIMATE PARALLEL email processing...');

    // Setup Gmail client
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      config.gmail.redirectUri
    );
    oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get already processed emails
    addLog('📊 Finding already processed emails...');
    const currentLabels = await getAllLabels();
    const mailyLabels = currentLabels.filter(label => label.name.startsWith('Maily/'));

    const processedEmailIds = new Set();
    for (const label of mailyLabels) {
      try {
        const response = await gmail.users.messages.list({
          userId: 'me',
          labelIds: [label.id],
          maxResults: 500
        });
        const messages = response.data.messages || [];
        messages.forEach(msg => processedEmailIds.add(msg.id));
      } catch (error) {
        // Continue silently
      }
    }

    addLog(`✅ Found ${processedEmailIds.size} already processed emails`);

    // Get all email IDs
    addLog('📧 Getting all email IDs...');
    let allEmailIds = [];
    let pageToken = null;

    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 500,
        pageToken: pageToken
      });

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

    // Create batches for rate-limited processing
    const BATCH_SIZE = 200; // Reduced batch size to avoid rate limits
    const batches = [];

    for (let i = 0; i < unprocessedEmailIds.length; i += BATCH_SIZE) {
      const batchIds = unprocessedEmailIds.slice(i, i + BATCH_SIZE);
      batches.push(batchIds);
    }

    processingStatus.totalBatches = batches.length;

    addLog(`📦 Created ${batches.length} batches of ~${BATCH_SIZE} emails each`);
    addLog(`⚡ Processing batches with rate limiting to avoid API limits...`);

    // Process batches with controlled concurrency (max 2 at a time)
    const MAX_CONCURRENT_BATCHES = 2;
    const batchResults = [];

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);

      const batchPromises = currentBatches.map(async (batchIds, localIndex) => {
        const batchNumber = i + localIndex + 1;

        try {
          addLog(`🚀 Starting batch ${batchNumber}/${batches.length}`);

          const emails = await batchGetEmails(gmail, batchIds, batchNumber);
          const categories = await batchCategorizeEmails(emails, batchNumber);

          const emailCategoryPairs = emails.map((email, index) => ({
            emailId: email.id,
            category: categories[index] || 'Personal'
          }));

          const { successful, failed } = await batchApplyLabels(emailCategoryPairs, batchNumber);

          processingStatus.currentBatch = Math.max(processingStatus.currentBatch, batchNumber);

          return { batchNumber, successful, failed, total: emails.length };

        } catch (batchError) {
          addLog(`❌ Batch ${batchNumber} failed: ${batchError.message}`);
          return { batchNumber, successful: 0, failed: batchIds.length, total: batchIds.length };
        }
      });

      const currentResults = await Promise.all(batchPromises);
      batchResults.push(...currentResults);

      // Delay between batch groups to respect rate limits
      if (i + MAX_CONCURRENT_BATCHES < batches.length) {
        addLog(`⏳ Waiting before next batch group to respect rate limits...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Final results
    const totalTime = Math.round((Date.now() - processingStatus.startTime) / 1000);
    const avgRate = totalTime > 0 ? Math.round(processingStatus.processedEmails / totalTime * 60) : 0;

    addLog('🎉 ULTIMATE PARALLEL PROCESSING COMPLETE!');
    addLog(`✅ Successfully processed: ${processingStatus.processedEmails} emails`);
    addLog(`❌ Errors: ${processingStatus.errors} emails`);
    addLog(`⏱️ Total time: ${Math.floor(totalTime / 60)}m ${totalTime % 60}s`);
    addLog(`🚀 Average rate: ${avgRate} emails/minute`);

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
    categories: {},
    logs: []
  };
}

module.exports = {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  addLog
};
