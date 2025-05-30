#!/usr/bin/env node

/**
 * Debug script to check processed emails status
 * Usage: node debug-emails.js
 */

const { debugProcessedEmails } = require('./services/parallelProcessingService');
const config = require('./config/config');

async function runDebug() {
  try {
    console.log('🔍 Starting email processing debug...');
    console.log('📧 This will check how many emails are already processed vs total emails');
    console.log('');

    // Use global refresh token for debugging (you can modify this for specific user)
    const userAuth = {
      refreshToken: config.gmail.refreshToken
    };

    const result = await debugProcessedEmails(userAuth);
    
    console.log('');
    console.log('🎯 DEBUG RESULTS:');
    console.log('================');
    console.log(`📧 Total emails in account: ${result.totalEmails}`);
    console.log(`✅ Total processed emails: ${result.totalProcessed}`);
    console.log(`🆕 Unprocessed emails: ${result.unprocessed}`);
    console.log('');
    
    if (result.unprocessed === 0) {
      console.log('🎉 ALL EMAILS ARE ALREADY PROCESSED!');
      console.log('   This is why the API shows "No new emails to process"');
    } else {
      console.log('⚠️  THERE ARE UNPROCESSED EMAILS!');
      console.log('   The system should process these emails.');
    }
    
    console.log('');
    console.log('📊 Breakdown by category:');
    console.log('========================');
    
    Object.entries(result.labelStats).forEach(([label, count]) => {
      console.log(`   ${label}: ${count} emails`);
    });
    
    console.log('');
    console.log('💡 TROUBLESHOOTING TIPS:');
    console.log('========================');
    
    if (result.unprocessed === 0) {
      console.log('✅ All emails are processed. This is expected behavior.');
      console.log('   - If you want to reprocess emails, you would need to remove the Maily/ labels first');
      console.log('   - Or modify the code to process emails with different criteria');
    } else {
      console.log('🔧 There are unprocessed emails. Check:');
      console.log('   - Are there any errors in the processing logs?');
      console.log('   - Are the Gmail API quotas being hit?');
      console.log('   - Are the Maily/ labels being applied correctly?');
    }

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
    console.error('');
    console.error('🔧 Common issues:');
    console.error('   - Check your .env file has correct Gmail credentials');
    console.error('   - Ensure Gmail API is enabled');
    console.error('   - Verify refresh token is valid');
  }
}

// Run the debug
runDebug();
