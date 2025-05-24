const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: {
    temperature: 0.1, // Lower temperature for more consistent categorization
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 10, // We only need one word response
  }
});

const predefinedCategories = [
  'Meetings',
  'Promotions',
  'Important',
  'Social',
  'Travel',
  'Work',
  'Transactions',
  'Personal',
  'Finance',
  'Shopping',
  'News',
  'Updates'
];

// Rate limiting configuration
const RATE_LIMIT = {
  maxRequests: 14, // Slightly below the 15/minute limit for safety
  windowMs: 60 * 1000, // 1 minute
  requests: [],
};

// Simple rate limiter
function isRateLimited() {
  const now = Date.now();
  // Remove requests older than the window
  RATE_LIMIT.requests = RATE_LIMIT.requests.filter(
    timestamp => now - timestamp < RATE_LIMIT.windowMs
  );

  return RATE_LIMIT.requests.length >= RATE_LIMIT.maxRequests;
}

function addRequest() {
  RATE_LIMIT.requests.push(Date.now());
}

// Sleep function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Removed keyword-based fallback - using only Gemini AI for categorization

async function categorizeEmail(subject, body, customCategories = []) {
  const categories = [...predefinedCategories, ...customCategories];

  try {
    // Check rate limit
    if (isRateLimited()) {
      console.log('Rate limit reached, waiting for reset...');
      await waitForRateLimit();
    }

    const prompt = `You are an expert email categorization AI. Categorize this email into EXACTLY ONE category from the list below.

AVAILABLE CATEGORIES: ${categories.join(', ')}

EMAIL TO CATEGORIZE:
Subject: ${subject}
Content: ${body.substring(0, 1500)}

INSTRUCTIONS:
1. Analyze the email content carefully
2. Choose the MOST APPROPRIATE category from the list above
3. Return ONLY the category name
4. Do not include any explanation or additional text
5. If the email could fit multiple categories, choose the PRIMARY purpose

RESPONSE (category name only):`;

    // Add request to rate limiter
    addRequest();

    const result = await model.generateContent(prompt);
    let category = result.response.text().trim();

    // Clean up the response - remove any extra text
    category = category.replace(/^Category:\s*/i, '').replace(/[^\w\s]/g, '').trim();
    console.log(`Category name: ${category}`)
    // Find exact match (case-insensitive)
    const exactMatch = categories.find(cat =>
      cat.toLowerCase() === category.toLowerCase()
    );

    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try partial matching
    const partialMatch = categories.find(cat =>
      category.toLowerCase().includes(cat.toLowerCase()) ||
      cat.toLowerCase().includes(category.toLowerCase())
    );

    if (partialMatch) {
      console.log(`Partial match found: "${category}" -> "${partialMatch}"`);
      return partialMatch;
    }

    // If still no match, retry with a simpler prompt
    console.log(`No match found for "${category}", retrying with simpler prompt...`);

    const simplePrompt = `Categorize this email into one word from: ${categories.join(', ')}.

Subject: ${subject}
Content: ${body.substring(0, 500)}

Choose the best category and respond with only that word:`;

    try {
      const retryResult = await model.generateContent(simplePrompt);
      const retryCategory = retryResult.response.text().trim().replace(/[^\w]/g, '');

      const retryMatch = categories.find(cat =>
        cat.toLowerCase() === retryCategory.toLowerCase()
      );

      if (retryMatch) {
        console.log(`Retry successful: "${retryCategory}" -> "${retryMatch}"`);
        return retryMatch;
      }
    } catch (retryError) {
      console.log('Retry failed:', retryError.message);
    }

    // Final fallback to Personal if all else fails
    console.log('All categorization attempts failed, defaulting to Personal');
    return 'Personal';

  } catch (error) {
    console.error('Error categorizing email:', error);

    // Check if it's a rate limit error
    if (error.message && error.message.includes('429')) {
      console.log('Rate limit error detected, waiting and retrying...');
      await waitForRateLimit();

      // Retry once after waiting
      try {
        const retryPrompt = `Categorize this email: "${subject}" into one of: ${categories.join(', ')}. Respond with only the category name.`;
        const retryResult = await model.generateContent(retryPrompt);
        const retryCategory = retryResult.response.text().trim().replace(/[^\w]/g, '');

        const match = categories.find(cat =>
          cat.toLowerCase() === retryCategory.toLowerCase()
        );

        return match || 'Personal';
      } catch (retryError) {
        console.log('Retry after rate limit failed, defaulting to Personal');
        return 'Personal';
      }
    }

    // For other errors, default to Personal
    console.log('Categorization failed, defaulting to Personal');
    return 'Personal';
  }
}

// Function to wait for rate limit reset
async function waitForRateLimit() {
  if (isRateLimited()) {
    const oldestRequest = Math.min(...RATE_LIMIT.requests);
    const waitTime = RATE_LIMIT.windowMs - (Date.now() - oldestRequest) + 1000; // Add 1 second buffer

    if (waitTime > 0) {
      console.log(`Waiting ${Math.ceil(waitTime / 1000)} seconds for rate limit reset...`);
      await sleep(waitTime);
    }
  }
}

module.exports = {
  categorizeEmail,
  waitForRateLimit,
  isRateLimited
};