#!/usr/bin/env node

/**
 * Script to clean up duplicate Maily/ labels from emails
 * Usage: node cleanup-duplicates.js
 */

const {
  cleanupDuplicateLabels,
} = require("./services/parallelProcessingService");
const config = require("./config/config");

async function runCleanup() {
  try {
    console.log("🧹 Starting cleanup of duplicate Maily/ labels...");
    console.log(
      "📧 This will remove extra Maily/ labels from emails that have multiple ones",
    );
    console.log(
      "✅ Each email will keep only ONE Maily/ label (the first one found)",
    );
    console.log("");

    const result = await cleanupDuplicateLabels(userAuth);

    console.log("");
    console.log("🎯 CLEANUP RESULTS:");
    console.log("==================");
    console.log(
      `🔍 Emails with duplicate labels found: ${result.duplicatesFound}`,
    );
    console.log(`🧹 Emails cleaned (duplicates removed): ${result.cleaned}`);
    console.log("");

    if (result.cleaned > 0) {
      console.log("✅ SUCCESS! Duplicate labels have been removed.");
      console.log("   Each email now has only ONE Maily/ label.");
      console.log("");
      console.log("💡 What happened:");
      console.log("   - Found emails with multiple Maily/ labels");
      console.log("   - Kept the first label on each email");
      console.log("   - Removed all additional Maily/ labels");
      console.log("");
      console.log(
        "🔄 You can now run processing again and it should work correctly!",
      );
    } else if (result.duplicatesFound === 0) {
      console.log("🎉 GREAT! No duplicate labels found.");
      console.log("   Your emails are already properly organized.");
    } else {
      console.log("⚠️  Some duplicates were found but couldn't be cleaned.");
      console.log("   Check the logs above for any error messages.");
    }

    console.log("");
    console.log("📊 Next Steps:");
    console.log("==============");
    console.log("1. Run debug script: node debug-emails.js");
    console.log("2. Check if processing works: POST /api/process");
    console.log("3. Monitor with: GET /api/status");
  } catch (error) {
    console.error("❌ Cleanup failed:", error.message);
    console.error("");
    console.error("🔧 Common issues:");
    console.error("   - Check your .env file has correct Gmail credentials");
    console.error("   - Ensure Gmail API is enabled");
    console.error("   - Verify refresh token is valid");
    console.error("   - Make sure you have permission to modify labels");
  }
}

// Run the cleanup
runCleanup();
