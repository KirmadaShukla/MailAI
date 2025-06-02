const { getAllLabels } = require("./gmailService");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const config = require("../config/config");
const { RateLimiter } = require("limiter");

// Initialize rate limiter (50 calls/second)
const apiLimiter = new RateLimiter({ tokensPerInterval: 50, interval: "second" });

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  generationConfig: { temperature: 0.03, topP: 0.95, topK: 15, maxOutputTokens: 8192 },
});

// Multi-user processing manager
class ProcessingManager {
  constructor() {
    this.userSessions = new Map(); // userId -> processingStatus
    this.cleanupInterval = setInterval(() => this.cleanupOldSessions(), 30 * 60 * 1000); // Cleanup every 30 minutes
  }

  createDefaultStatus() {
    return {
      isProcessing: false,
      userRequestedStop: false,
      totalEmails: 0,
      processedEmails: 0,
      errors: 0,
      startTime: null,
      totalBatches: 0,
      completedBatches: 0,
      totalTasks: 0,
      completedTasks: 0,
      progressPercentage: 0,
      categories: {},
      logs: [],
      retryAttempts: 0,
      maxRetryAttempts: 3,
      failedBatches: [],
      stoppedDueToQuota: false,
      lastActivity: Date.now(),
    };
  }

  getStatus(userId) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, this.createDefaultStatus());
    }
    const status = this.userSessions.get(userId);
    status.lastActivity = Date.now();
    return status;
  }

  resetStatus(userId) {
    const newStatus = this.createDefaultStatus();
    this.userSessions.set(userId, newStatus);
    return newStatus;
  }

  cleanupOldSessions() {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours

    for (const [userId, status] of this.userSessions.entries()) {
      if (!status.isProcessing && (now - status.lastActivity) > maxAge) {
        console.log(`🧹 Cleaning up old session for user: ${userId}`);
        this.userSessions.delete(userId);
      }
    }
  }

  getAllActiveSessions() {
    return Array.from(this.userSessions.entries()).map(([userId, status]) => ({
      userId,
      isProcessing: status.isProcessing,
      lastActivity: status.lastActivity,
      processedEmails: status.processedEmails,
      totalEmails: status.totalEmails,
    }));
  }
}

// Global processing manager instance
const processingManager = new ProcessingManager();

// Task Scheduler Class
class TaskScheduler {
  constructor(maxConcurrency = 4, maxRetries = 4, baseDelay = 300) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
  }

  async runTask(taskFn, debugInfo = '') {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject, retries: 0, debugInfo });
      this.processQueue();
    });
  }

  async processQueue() {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const { taskFn, resolve, reject, debugInfo } = this.queue.shift();
      this.running++;
      addLog(`📋 Dequeuing task: ${debugInfo} (Running: ${this.running}, Queue: ${this.queue.length})`);

      const execute = async (attempt = 1, delay = this.baseDelay) => {
        try {
          addLog(`Starting ${debugInfo} (Attempt ${attempt})`);
          const result = await taskFn();
          addLog(`Completed ${debugInfo}`);
          resolve(result);
        } catch (err) {
          const message = err.message || err.toString();
          if (
            message.includes('429') ||
            message.includes('quota') ||
            message.includes('rate limit') ||
            message.includes('ResourceExhausted')
          ) {
            if (attempt <= this.maxRetries) {
              const retryDelay = message.includes('retryDelay') ? parseInt(message.match(/retryDelay":"(\d+)s"/)?.[1] || delay) * 1000 : delay;
              addLog(`Transient error for ${debugInfo}: ${message}. Retrying in ${retryDelay}ms`);
              setTimeout(() => execute(attempt + 1, Math.min(retryDelay * 2, 4000)), retryDelay);
              return;
            }
          }
          addLog(`Failed ${debugInfo}: ${message}`);
          reject(err);
        } finally {
          this.running--;
          addLog(`🛠️ Task ${debugInfo} finished (Running: ${this.running}, Queue: ${this.queue.length})`);
          this.processQueue();
        }
      };

      execute();
    }
  }
}

const scheduler = new TaskScheduler(4);

// Helper: Log with timestamp, keep last 50 logs
function addLog(message, userId = null) {
  const logEntry = `[${new Date().toISOString()}] ${message}`;
  console.log(logEntry);

  if (userId) {
    const status = processingManager.getStatus(userId);
    status.logs.push(logEntry);
    if (status.logs.length > 50) status.logs = status.logs.slice(-50);
  }
}

// Helper: Exponential backoff for API calls
async function withBackoff(fn, maxRetries = 3, baseDelay = 300) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await apiLimiter.removeTokens(1);
      return await fn();
    } catch (error) {
      if (error.code === 429 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        addLog(`⚠️ Rate limit hit, retry after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

// Helper: Check for Google quota errors
function isGoogleQuotaError(error) {
  if (!error) return false;
  const status = error.response?.status || error.code;
  const data = error.response?.data?.error || error;
  const message = (error.message || "").toLowerCase();
  return (
    status === 429 ||
    (status === 403 && data.errors?.some((e) => ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(e.reason))) ||
    message.includes("quota") || message.includes("rate limit")
  );
}

// Count total emails and categorize processed/unprocessed
async function countEmails(userAuth = null, userId = null) {
  try {
    addLog("📊 Fetching email IDs to count emails...", userId);
    const oauth2Client = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret, config.oauth.redirectUri);
    oauth2Client.setCredentials(userAuth?.accessToken ? { access_token: userAuth.accessToken, refresh_token: userAuth.refreshToken } : { refresh_token: config.oauth.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Get all labels
    addLog("🏷️ Fetching all Gmail labels...", userId);
    const labels = await withBackoff(() => getAllLabels(gmail, "count-emails"));
    const mailyLabels = labels.filter((l) => l.name.startsWith("Maily/"));
    addLog(`🏷️ Found ${mailyLabels.length} Maily labels`, userId);

    // Count processed emails and collect all email IDs
    const processedEmailIds = new Set();
    const allMessageIds = [];
    const labelCounts = {};

    // Fetch processed emails concurrently
    addLog("📥 Fetching processed email IDs...", userId);
    const labelPromises = mailyLabels.map(async (label) => {
      let nextPageToken = null;
      let count = 0;
      do {
        const res = await withBackoff(() =>
          gmail.users.messages.list({ userId: "me", labelIds: [label.id], maxResults: 500, pageToken: nextPageToken })
        );
        res.data.messages?.forEach((m) => processedEmailIds.add(m.id));
        count += res.data.messages?.length || 0;
        nextPageToken = res.data.nextPageToken;
      } while (nextPageToken);
      addLog(`🏷️ Label ${label.name}: ${count} emails`, userId);
      return { name: label.name, count };
    });
    const labelResults = await Promise.all(labelPromises);
    labelResults.forEach(({ name, count }) => { labelCounts[name] = count; });

    // Count all emails
    addLog("📬 Fetching all email IDs...", userId);
    let nextPageToken = null;
    do {
      const res = await withBackoff(() =>
        gmail.users.messages.list({ userId: "me", maxResults: 500, pageToken: nextPageToken })
      );
      allMessageIds.push(...(res.data.messages || []).map((m) => m.id));
      nextPageToken = res.data.nextPageToken;
      addLog(`📬 Fetched ${allMessageIds.length} email IDs so far`, userId);
    } while (nextPageToken && allMessageIds.length < 25000);

    const totalEmails = allMessageIds.length;
    const unprocessedEmailIds = allMessageIds.filter((id) => !processedEmailIds.has(id));
    const unprocessedEmails = unprocessedEmailIds.length;

    // Log count immediately after fetching
    addLog("📈 Pre-Processing Email Count:", userId);
    addLog(`   📧 Total emails fetched: ${totalEmails}`, userId);
    addLog(`   ✅ Processed emails: ${processedEmailIds.size}`, userId);
    addLog(`   🆕 Unprocessed emails: ${unprocessedEmails}`, userId);

    return {
      totalEmails,
      processedEmails: processedEmailIds.size,
      unprocessedEmails,
      labelCounts,
      allMessageIds,
      unprocessedEmailIds,
      labels,
    };
  } catch (error) {
    addLog(`❌ Email count failed: ${error.message}`, userId);
    throw error;
  }
}

// Categorize emails with Gemini
async function categorizeEmails(emails, batchNumber, userId) {
  const processingStatus = processingManager.getStatus(userId);
  if (processingStatus.userRequestedStop || !emails.length) {
    addLog(`🚫 Batch ${batchNumber}: Skipping categorization (${!emails.length ? "No emails" : "User stopped"})`, userId);
    return { categories: [], cancelled: !emails.length };
  }

  const chunkSize = 50;
  const categories = [];
  addLog(`🤖 Categorizing ${emails.length} emails in batch ${batchNumber} (chunk size: ${chunkSize})`, userId);
  const improvedPrompt = `Classify each email into EXACTLY ONE category based on its subject and content preview. Follow these rules:
1. Choose a single, concise category name (1-2 words, e.g., "Meetings", "Travel", "Promotions", "Finance", "Personal", "Work").
2. Use the subject and content preview to determine the most relevant category.
3. Avoid special characters or punctuation in category names.
4. If the email's content is unclear or doesn't fit a specific category, use "Miscellaneous".
5. Return only the category name for each email, one per line, in the same order as the input emails.
6. Do not include explanations or additional text beyond the category names.
7. Examples:
   - Subject: "Meeting with Team Tomorrow", Snippet: "Please join us for..." -> Meetings
   - Subject: "Flight Confirmation", Snippet: "Your flight to..." -> Travel
   - Subject: "50% Off Sale", Snippet: "Exclusive offer..." -> Promotions
   - Subject: "Bank Statement", Snippet: "Your monthly statement..." -> Finance

EMAILS:
${chunk.map((e, idx) => `EMAIL ${idx + 1}:\nSubject: "${e.subject || "No Subject"}"\nContent Preview: "${e.snippet || ""}"\n---`).join("\n")}
CATEGORIES:`;

  for (let i = 0; i < emails.length; i += chunkSize) {
    const chunk = emails.slice(i, i + chunkSize);
    const prompt = improvedPrompt.replace(
      "${chunk.map(...)}",
      chunk.map((e, idx) => `EMAIL ${idx + 1}:\nSubject: "${e.subject || "No Subject"}"\nContent Preview: "${e.snippet || ""}"\n---`).join("\n")
    );
    addLog(`📤 Sending Gemini API request for batch ${batchNumber}, chunk ${i / chunkSize + 1} (${chunk.length} emails)`, userId);

    try {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Throttle Gemini calls
      const result = await model.generateContent(prompt);
      const chunkCategories = result.response.text().trim().split("\n").slice(0, chunk.length).map((cat) => {
        const cleanCat = cat.replace(/[^\w\s]/g, "").trim();
        return cleanCat || "Miscellaneous";
      });
      categories.push(...chunkCategories);
      addLog(`📥 Received categories for batch ${batchNumber}, chunk ${i / chunkSize + 1}: ${chunkCategories.join(", ")}`, userId);
    } catch (error) {
      addLog(`❌ Batch ${batchNumber} chunk ${i / chunkSize + 1} categorization failed: ${error.message}`, userId);
      categories.push(...Array(chunk.length).fill("Miscellaneous"));
      if (processingStatus.userRequestedStop) {
        addLog(`🛑 Batch ${batchNumber}: Cancelled during categorization`, userId);
        return { categories, cancelled: true };
      }
    }
  }
  addLog(`✅ Batch ${batchNumber}: Categorized ${categories.length} emails`, userId);
  return { categories, cancelled: false };
}

// Fetch and process email batch
async function processBatch(gmail, emailIds, batchNumber, categoryToLabelIdMap, userId) {
  const processingStatus = processingManager.getStatus(userId);
  if (processingStatus.userRequestedStop) {
    addLog(`🛑 Batch ${batchNumber}: Cancelled`, userId);
    return { successful: 0, failed: emailIds.length, cancelled: true };
  }

  addLog(`📥 Processing batch ${batchNumber} with ${emailIds.length} emails`, userId);
  const emails = [];
  for (let i = 0; i < emailIds.length; i += 10) {
    const batch = emailIds.slice(i, i + 10);
    addLog(`📬 Fetching ${batch.length} emails for batch ${batchNumber}, sub-batch ${i / 10 + 1}`, userId);
    try {
      const promises = batch.map((id) => withBackoff(() =>
        gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["Subject"] })
          .then((res) => ({
            id: res.data.id,
            subject: res.data.payload.headers.find((h) => h.name === "Subject")?.value || "No Subject",
            snippet: res.data.snippet || "",
          }))
      ));
      emails.push(...(await Promise.all(promises)));
      addLog(`✅ Fetched ${batch.length} emails for batch ${batchNumber}, sub-batch ${i / 10 + 1}`, userId);
    } catch (error) {
      if (isGoogleQuotaError(error)) {
        processingStatus.stoppedDueToQuota = true;
        addLog(`‼️ Batch ${batchNumber}: Quota error: ${error.message}`, userId);
        return { successful: 0, failed: emailIds.length, cancelled: false, quotaError: true };
      }
      addLog(`❌ Batch ${batchNumber}: Fetch error: ${error.message}`, userId);
      return { successful: 0, failed: emailIds.length, cancelled: false };
    }
  }

  const { categories, cancelled } = await categorizeEmails(emails, batchNumber, userId);
  if (cancelled || processingStatus.userRequestedStop) {
    addLog(`🛑 Batch ${batchNumber}: Cancelled during categorization`, userId);
    return { successful: 0, failed: emails.length, cancelled: true };
  }

  const newCategories = [...new Set(categories)];
  addLog(`🏷️ Creating/applying labels for categories: ${newCategories.join(", ")}`, userId);
  const labelPromises = newCategories.map(async (category) => {
    const normalizedCategory = category.toLowerCase();
    const existingCategory = Object.keys(categoryToLabelIdMap).find((k) => k.toLowerCase() === normalizedCategory);
    if (existingCategory) {
      addLog(`🏷️ Using existing label for ${category}: ${categoryToLabelIdMap[existingCategory]}`, userId);
      return { category, id: categoryToLabelIdMap[existingCategory] };
    }
    const labelName = `Maily/${category}`;
    try {
      const label = await withBackoff(() => gmail.users.labels.create({
        userId: "me",
        resource: { name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }
      }));
      addLog(`🏷️ Created new label ${labelName}: ${label.data.id}`, userId);
      return { category, id: label.data.id };
    } catch (error) {
      addLog(`❌ Failed to create label ${labelName}: ${error.message}`, userId);
      return { category, id: null };
    }
  });
  const labelResults = await Promise.all(labelPromises);
  labelResults.forEach(({ category, id }) => {
    if (id) categoryToLabelIdMap[category] = id;
  });

  const emailCategoryPairs = emails.map((email, idx) => ({
    emailId: email.id,
    category: categories[idx] || "Miscellaneous",
  }));

  const emailsByLabel = {};
  emailCategoryPairs.forEach(({ emailId, category }) => {
    const labelId = categoryToLabelIdMap[category];
    if (labelId) {
      emailsByLabel[labelId] = emailsByLabel[labelId] || [];
      emailsByLabel[labelId].push(emailId);
    }
  });

  let successful = 0, failed = 0;
  for (const labelId in emailsByLabel) {
    const emailIds = emailsByLabel[labelId];
    const category = Object.keys(categoryToLabelIdMap).find((k) => categoryToLabelIdMap[k] === labelId);
    addLog(`📌 Applying label ${category} (${labelId}) to ${emailIds.length} emails`, userId);
    try {
      await withBackoff(() =>
        gmail.users.messages.batchModify({
          userId: "me",
          resource: { ids: emailIds, addLabelIds: [labelId] },
        })
      );
      successful += emailIds.length;
      processingStatus.categories[category] = (processingStatus.categories[category] || 0) + emailIds.length;
      addLog(`✅ Labeled ${emailIds.length} emails with ${category}`, userId);
    } catch (error) {
      failed += emailIds.length;
      if (isGoogleQuotaError(error)) {
        processingStatus.stoppedDueToQuota = true;
        addLog(`‼️ Batch ${batchNumber}: Quota error: ${error.message}`, userId);
        return { successful, failed, cancelled: false, quotaError: true };
      }
      addLog(`❌ Batch ${batchNumber}: Labeling error for ${category}: ${error.message}`, userId);
    }
  }

  processingStatus.processedEmails += successful;
  processingStatus.errors += failed;
  processingStatus.completedBatches++;
  processingStatus.completedTasks++;
  processingStatus.progressPercentage = Math.round((processingStatus.completedBatches / processingStatus.totalBatches) * 100);
  addLog(`📊 Progress: ${processingStatus.progressPercentage}% (${processingStatus.completedBatches}/${processingStatus.totalBatches})`, userId);

  if (processingStatus.completedTasks >= processingStatus.totalTasks && !processingStatus.userRequestedStop && !processingStatus.stoppedDueToQuota) {
    if (processingStatus.failedBatches.length) {
      addLog(`🔄 Scheduling retry for ${processingStatus.failedBatches.length} failed batches`, userId);
      await retryFailedBatches(gmail, categoryToLabelIdMap, userId);
    }
    addLog(`✅ Processing complete: ${processingStatus.processedEmails} emails labeled, ${processingStatus.errors} errors`, userId);
    processingStatus.isProcessing = false;
    addLog(`⏱️ Took ${Math.round((Date.now() - processingStatus.startTime) / 1000)}s`, userId);
  }

  return { successful, failed, cancelled: false };
}

// Retry failed batches
async function retryFailedBatches(gmail, categoryToLabelIdMap, userId) {
  const processingStatus = processingManager.getStatus(userId);
  if (processingStatus.userRequestedStop || !processingStatus.failedBatches.length) {
    addLog(`🚫 Retry skipped: ${processingStatus.userRequestedStop ? "User stopped" : "No failed batches"}`, userId);
    return;
  }

  processingStatus.retryAttempts++;
  const delay = Math.min(1000 * Math.pow(2, processingStatus.retryAttempts - 1), 30000);
  addLog(`🔄 Retry ${processingStatus.retryAttempts}/${processingStatus.maxRetryAttempts}: ${processingStatus.failedBatches.length} batches, delay ${delay}ms`, userId);

  await new Promise((resolve) => setTimeout(resolve, delay));
  const batchesToRetry = [...processingStatus.failedBatches];
  processingStatus.failedBatches = [];
  processingStatus.totalTasks += batchesToRetry.length;

  for (const { batchNumber, batchIds, originalError } of batchesToRetry) {
    addLog(`🔄 Retrying batch ${batchNumber} (${batchIds.length} emails, original error: ${originalError})`, userId);
    const taskFn = () => processBatch(gmail, batchIds, `${batchNumber}-retry-${processingStatus.retryAttempts}`, categoryToLabelIdMap, userId);
    scheduler.runTask(taskFn, `Retry Batch ${batchNumber}`)
      .catch((error) => {
        if (!isGoogleQuotaError(error) && processingStatus.retryAttempts < processingStatus.maxRetryAttempts) {
          processingStatus.failedBatches.push({ batchNumber, batchIds, originalError: error.message });
          addLog(`❌ Retry failed for batch ${batchNumber}: ${error.message}`, userId);
        }
      });
  }
}

// Main processing function
async function processEmailsParallel(userAuth = null, userId = null) {
  try {
    if (!userId) {
      throw new Error("userId is required for processing");
    }

    const processingStatus = processingManager.resetStatus(userId);
    processingStatus.isProcessing = true;
    processingStatus.startTime = Date.now();

    addLog("🚀 Starting email processing...", userId);
    const oauth2Client = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret, config.oauth.redirectUri);
    oauth2Client.setCredentials(userAuth?.accessToken ? { access_token: userAuth.accessToken, refresh_token: userAuth.refreshToken } : { refresh_token: config.oauth.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    addLog("🔑 Gmail client initialized", userId);

    const emailCount = await countEmails(userAuth, userId);
    processingStatus.totalEmails = emailCount.totalEmails;
    const unprocessedEmailIds = emailCount.unprocessedEmailIds;

    if (!unprocessedEmailIds.length) {
      addLog("🎉 No new emails to process!", userId);
      processingStatus.isProcessing = false;
      return;
    }

    const categoryToLabelIdMap = {};
    emailCount.labels
      .filter((l) => l.name.startsWith("Maily/"))
      .forEach((l) => {
        const category = l.name.replace("Maily/", "");
        categoryToLabelIdMap[category] = l.id;
      });
    addLog(`🏷️ Loaded ${Object.keys(categoryToLabelIdMap).length} existing Maily labels`, userId);

    addLog("📢 Starting email categorization and labeling...", userId);
    processingStatus.totalBatches = Math.ceil(unprocessedEmailIds.length / 100);
    processingStatus.totalTasks = processingStatus.totalBatches;
    addLog(`📅 Scheduling ${processingStatus.totalBatches} batches for ${unprocessedEmailIds.length} unprocessed emails`, userId);

    for (let i = 0; i < unprocessedEmailIds.length; i += 100) {
      if (processingStatus.userRequestedStop || processingStatus.stoppedDueToQuota) {
        addLog(`🚫 Stopped scheduling at batch ${Math.floor(i / 100) + 1}`, userId);
        break;
      }
      const batchNumber = Math.floor(i / 100) + 1;
      const batchIds = unprocessedEmailIds.slice(i, i + 100);
      addLog(`📦 Scheduling batch ${batchNumber} with ${batchIds.length} emails`, userId);
      const taskFn = () => processBatch(gmail, batchIds, batchNumber, categoryToLabelIdMap, userId);
      scheduler.runTask(taskFn, `Batch ${batchNumber}`)
        .catch((error) => {
          if (isGoogleQuotaError(error)) {
            processingStatus.stoppedDueToQuota = true;
            addLog(`‼️ Batch ${batchNumber}: Quota error: ${error.message}`, userId);
          } else if (!processingStatus.userRequestedStop) {
            processingStatus.failedBatches.push({ batchNumber, batchIds, originalError: error.message });
            addLog(`❌ Batch ${batchNumber} failed: ${error.message}`, userId);
          }
        });
    }
  } catch (error) {
    const processingStatus = processingManager.getStatus(userId);
    addLog(`❌ Processing failed: ${error.message}`, userId);
    processingStatus.stoppedDueToQuota = isGoogleQuotaError(error);
    processingStatus.failedBatches.push({ batchNumber: "Main", batchIds: [], originalError: error.message });
    processingStatus.isProcessing = false;
    addLog(`⏱️ Took ${Math.round((Date.now() - processingStatus.startTime) / 1000)}s`, userId);
  }
}

module.exports = {
  processEmailsParallel,
  countEmails,
  addLog,
  getProcessingStatus: (userId) => {
    if (!userId) {
      throw new Error("userId is required to get processing status");
    }
    return processingManager.getStatus(userId);
  },
  resetProcessingStatus: (userId) => {
    if (!userId) {
      throw new Error("userId is required to reset processing status");
    }
    return processingManager.resetStatus(userId);
  },
  getAllActiveSessions: () => processingManager.getAllActiveSessions(),
  // Legacy support - returns first active session or default status
  getLegacyProcessingStatus: () => {
    const sessions = processingManager.getAllActiveSessions();
    if (sessions.length > 0) {
      return processingManager.getStatus(sessions[0].userId);
    }
    return processingManager.createDefaultStatus();
  },
};