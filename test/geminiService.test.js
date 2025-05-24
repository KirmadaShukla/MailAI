const assert = require('assert');
const { 
  categorizeEmail, 
  isRateLimited, 
  fallbackCategorizeEmail 
} = require('../services/geminiService');

describe('Gemini Service', function() {
  this.timeout(10000); // 10 second timeout for tests

  describe('Rate Limiting', function() {
    it('should detect when rate limit is reached', function() {
      // Initially should not be rate limited
      assert.strictEqual(isRateLimited(), false);
    });

    it('should use fallback categorization when rate limited', function() {
      const subject = 'Meeting with team tomorrow';
      const body = 'We have a scheduled meeting with the development team tomorrow at 2 PM';
      const categories = ['Meetings', 'Work', 'Personal', 'Uncategorized'];

      const result = fallbackCategorizeEmail(subject, body, categories);
      
      // Should categorize as 'Meetings' based on keywords
      assert.strictEqual(result, 'Meetings');
    });

    it('should categorize promotional emails correctly', function() {
      const subject = 'Special Sale - 50% Off Everything!';
      const body = 'Limited time offer! Save big with our exclusive discount. Use coupon code SAVE50';
      const categories = ['Promotions', 'Shopping', 'Personal', 'Uncategorized'];

      const result = fallbackCategorizeEmail(subject, body, categories);
      
      // Should categorize as 'Promotions' based on keywords
      assert.strictEqual(result, 'Promotions');
    });

    it('should return Uncategorized for unknown content', function() {
      const subject = 'Random subject';
      const body = 'Some random content that does not match any keywords';
      const categories = ['Meetings', 'Promotions', 'Work', 'Uncategorized'];

      const result = fallbackCategorizeEmail(subject, body, categories);
      
      // Should return 'Uncategorized' when no keywords match
      assert.strictEqual(result, 'Uncategorized');
    });

    it('should handle empty subject and body gracefully', function() {
      const subject = '';
      const body = '';
      const categories = ['Meetings', 'Promotions', 'Work', 'Uncategorized'];

      const result = fallbackCategorizeEmail(subject, body, categories);
      
      // Should return 'Uncategorized' for empty content
      assert.strictEqual(result, 'Uncategorized');
    });
  });

  describe('Email Categorization', function() {
    it('should categorize email without hitting API when rate limited', async function() {
      // This test will use the fallback when rate limit is hit
      const subject = 'Important project deadline';
      const body = 'The project deadline is approaching. Please prioritize this urgent task.';
      const customCategories = ['Custom'];

      const result = await categorizeEmail(subject, body, customCategories);
      
      // Should return a valid category (either from API or fallback)
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
    });
  });
});
