const express = require("express");
const router = express.Router();
const {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  addLog,
  debugProcessedEmails,
  cleanupDuplicateLabels,
  getAllActiveSessions,
} = require("../services/parallelProcessingService");

const authMiddleware = require("../middleware/auth");

// GET /api/status - Get current processing status
router.get("/status", authMiddleware, (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const processingStatus = getProcessingStatus(userId);
    const currentTime = Date.now();
    const elapsedTime = processingStatus.startTime
      ? Math.round((currentTime - processingStatus.startTime) / 1000)
      : 0;

    const progress =
      processingStatus.totalEmails > 0
        ? Math.round(
            (processingStatus.processedEmails / processingStatus.totalEmails) *
              100,
          )
        : 0;

    const rate =
      elapsedTime > 0
        ? Math.round((processingStatus.processedEmails / elapsedTime) * 60)
        : 0;

    res.json({
      success: true,
      data: {
        isProcessing: processingStatus.isProcessing,
        progress: {
          totalEmails: processingStatus.totalEmails,
          processedEmails: processingStatus.processedEmails,
          errors: processingStatus.errors,
          percentage: progress,
          currentBatch: processingStatus.currentBatch,
          totalBatches: processingStatus.totalBatches,
        },
        timing: {
          startTime: processingStatus.startTime,
          elapsedSeconds: elapsedTime,
          estimatedRemainingSeconds:
            rate > 0
              ? Math.round(
                  (processingStatus.totalEmails -
                    processingStatus.processedEmails) /
                    (rate / 60),
                )
              : null,
          emailsPerMinute: rate,
        },
        categories: processingStatus.categories,
        recentLogs: processingStatus.logs.slice(-10), // Last 10 logs
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/process - Start email processing
router.get("/process", authMiddleware, async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const processingStatus = getProcessingStatus(userId);

    // Get user from database to access tokens
    const User = require("../models/User");
    const user = await User.findOne({ userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: "User authentication not found",
      });
    }

    const userAuth = {
      accessToken: user.gmailTokens.accessToken,
      refreshToken: user.getDecryptedRefreshToken(),
    };

    if (processingStatus.isProcessing) {
      return res.status(400).json({
        success: false,
        error: "Email processing is already in progress for this user",
        data: {
          currentProgress: Math.round(
            (processingStatus.processedEmails / processingStatus.totalEmails) *
              100,
          ),
          processedEmails: processingStatus.processedEmails,
          totalEmails: processingStatus.totalEmails,
        },
      });
    }

    // Reset status before starting
    resetProcessingStatus(userId);
    addLog(
      `🎯 API request received to start parallel processing for user: ${userId}`,
      userId
    );

    // Start processing in background with user authentication
    processEmailsParallel(userAuth, userId).catch((error) => {
      addLog(`❌ Processing failed: ${error.message}`, userId);
      const status = getProcessingStatus(userId);
      status.isProcessing = false;
    });

    res.json({
      success: true,
      message: "Ultimate parallel email processing started successfully",
      data: {
        message:
          "Processing started in background. Use GET /api/status to monitor progress.",
        features: [
          "Parallel batch processing (200 emails per batch)",
          "All batches process simultaneously",
          "Real-time progress monitoring",
          "Intelligent email categorization",
        ],
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/logs - Get all processing logs
router.get("/logs", authMiddleware, (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const processingStatus = getProcessingStatus(userId);

    res.json({
      success: true,
      data: {
        logs: processingStatus.logs,
        totalLogs: processingStatus.logs.length,
        isProcessing: processingStatus.isProcessing,
        lastUpdate:
          processingStatus.logs.length > 0
            ? processingStatus.logs[processingStatus.logs.length - 1]
            : null,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/stop - Stop current processing (if needed)
router.post("/stop", authMiddleware, (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const currentStatus = getProcessingStatus(userId); // Get the live status object

    if (!currentStatus.isProcessing) {
      return res.status(400).json({
        success: false,
        error: "No processing is currently running for this user",
      });
    }

    addLog("🛑 User requested STOP via API. Halting processing...", userId);
    currentStatus.isProcessing = false;
    currentStatus.userRequestedStop = true; // Set the new flag

    res.json({
      success: true,
      message:
        "Stop signal received. Processing will halt. Already active operations might complete.",
      data: {
        note: "Processing will stop. Any operations already sent to external APIs (like Gmail or Gemini) might still complete.",
      },
    });
  } catch (error) {
    console.error("[API /stop] Error processing stop request:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/debug - Debug processed emails status
router.get("/debug", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "userId parameter is required",
      });
    }

    // Get user from database to access tokens
    const User = require("../models/User");
    const user = await User.findOne({ userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: "User authentication not found",
      });
    }

    const userAuth = {
      accessToken: user.gmailTokens.accessToken,
      refreshToken: user.getDecryptedRefreshToken(),
    };

    const debugInfo = await debugProcessedEmails(userAuth);

    res.json({
      success: true,
      message: "Debug information retrieved successfully",
      data: debugInfo,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/cleanup - Clean up duplicate Maily/ labels
router.post("/cleanup", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "userId parameter is required",
      });
    }

    // Get user from database to access tokens
    const User = require("../models/User");
    const user = await User.findOne({ userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: "User authentication not found",
      });
    }

    const userAuth = {
      accessToken: user.gmailTokens.accessToken,
      refreshToken: user.getDecryptedRefreshToken(),
    };

    const result = await cleanupDuplicateLabels(userAuth);

    res.json({
      success: true,
      message: "Duplicate labels cleanup completed",
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/sessions - Get all active processing sessions (admin/debug endpoint)
router.get("/sessions", authMiddleware, (req, res) => {
  try {
    const activeSessions = getAllActiveSessions();

    res.json({
      success: true,
      message: "Active processing sessions retrieved successfully",
      data: {
        totalActiveSessions: activeSessions.length,
        sessions: activeSessions,
        serverInfo: {
          timestamp: new Date().toISOString(),
          note: "This endpoint shows all users currently processing emails"
        }
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
