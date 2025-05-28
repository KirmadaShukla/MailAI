const express = require('express');
const router = express.Router();
const {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  addLog
} = require('../services/parallelProcessingService');
const { getAllLabels } = require('../services/gmailService');
const authMiddleware = require('../middleware/auth');

// GET /api/status - Get current processing status
router.get('/status', authMiddleware, (req, res) => {
  try {
    const processingStatus = getProcessingStatus();
    const currentTime = Date.now();
    const elapsedTime = processingStatus.startTime ?
      Math.round((currentTime - processingStatus.startTime) / 1000) : 0;

    const progress = processingStatus.totalEmails > 0 ?
      Math.round((processingStatus.processedEmails / processingStatus.totalEmails) * 100) : 0;

    const rate = elapsedTime > 0 ?
      Math.round(processingStatus.processedEmails / elapsedTime * 60) : 0;

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
          totalBatches: processingStatus.totalBatches
        },
        timing: {
          startTime: processingStatus.startTime,
          elapsedSeconds: elapsedTime,
          estimatedRemainingSeconds: rate > 0 ?
            Math.round((processingStatus.totalEmails - processingStatus.processedEmails) / (rate / 60)) : null,
          emailsPerMinute: rate
        },
        categories: processingStatus.categories,
        recentLogs: processingStatus.logs.slice(-10) // Last 10 logs
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/process - Start email processing
router.post('/process', authMiddleware, async (req, res) => {
  try {
    const processingStatus = getProcessingStatus();
    const {userId} = req.body;
console.log("reqboyddd:",req.body)
    // Get user from database to access tokens
    const User = require('../models/User');
    const user = await User.findOne({ userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: 'User authentication not found'
      });
    }

    const userAuth = {
      accessToken: user.gmailTokens.accessToken,
      refreshToken: user.getDecryptedRefreshToken()
    };

    if (processingStatus.isProcessing) {
      return res.status(400).json({
        success: false,
        error: 'Email processing is already in progress',
        data: {
          currentProgress: Math.round((processingStatus.processedEmails / processingStatus.totalEmails) * 100),
          processedEmails: processingStatus.processedEmails,
          totalEmails: processingStatus.totalEmails
        }
      });
    }

    // Reset status before starting
    resetProcessingStatus();
    addLog(`🎯 API request received to start parallel processing for user: ${userId}`);

    // Start processing in background with user authentication
    processEmailsParallel(userAuth).catch(error => {
      addLog(`❌ Processing failed: ${error.message}`);
      const status = getProcessingStatus();
      status.isProcessing = false;
    });

    res.json({
      success: true,
      message: 'Ultimate parallel email processing started successfully',
      data: {
        message: 'Processing started in background. Use GET /api/status to monitor progress.',
        features: [
          'Parallel batch processing (200 emails per batch)',
          'All batches process simultaneously',
          'Real-time progress monitoring',
          'Intelligent email categorization'
        ]
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/logs - Get all processing logs
router.get('/logs', authMiddleware, (req, res) => {
  try {
    const processingStatus = getProcessingStatus();

    res.json({
      success: true,
      data: {
        logs: processingStatus.logs,
        totalLogs: processingStatus.logs.length,
        isProcessing: processingStatus.isProcessing,
        lastUpdate: processingStatus.logs.length > 0 ?
          processingStatus.logs[processingStatus.logs.length - 1] : null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/labels - Get current Gmail labels
router.get('/labels', authMiddleware, async (req, res) => {
  try {
    // Get user from database to access tokens
    const User = require('../models/User');
    const user = await User.findOne({ userId: req.userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: 'User authentication not found'
      });
    }

    const userAuth = {
      accessToken: user.gmailTokens.accessToken,
      refreshToken: user.getDecryptedRefreshToken()
    };
    const labels = await getAllLabels(req);
    const mailyLabels = labels.filter(label => label.name.startsWith('Maily/'));

    // Calculate total emails organized
    const totalOrganized = mailyLabels.reduce((sum, label) =>
      sum + (label.messagesTotal || 0), 0);

    res.json({
      success: true,
      data: {
        totalLabels: labels.length,
        mailyLabels: mailyLabels.length,
        totalOrganizedEmails: totalOrganized,
        labels: mailyLabels
          .sort((a, b) => (b.messagesTotal || 0) - (a.messagesTotal || 0))
          .map(label => ({
            id: label.id,
            name: label.name,
            messagesTotal: label.messagesTotal || 0,
            messagesUnread: label.messagesUnread || 0,
            category: label.name.replace('Maily/', '')
          }))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/stop - Stop current processing (if needed)
router.post('/stop', authMiddleware, (req, res) => {
  try {
    const processingStatus = getProcessingStatus();

    if (!processingStatus.isProcessing) {
      return res.status(400).json({
        success: false,
        error: 'No processing is currently running'
      });
    }

    // Note: This is a soft stop - batches already started will continue
    addLog('🛑 Stop request received via API');
    processingStatus.isProcessing = false;

    res.json({
      success: true,
      message: 'Stop signal sent. Current batches will complete.',
      data: {
        processedEmails: processingStatus.processedEmails,
        totalEmails: processingStatus.totalEmails,
        note: 'Parallel batches already started will continue to completion'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/stats - Get processing statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const processingStatus = getProcessingStatus();

    // Get user from database to access tokens
    const User = require('../models/User');
    const user = await User.findOne({ userId: req.userId });
    if (!user || !user.gmailTokens) {
      return res.status(401).json({
        success: false,
        error: 'User authentication not found'
      });
    }

    const labels = await getAllLabels(req);
    const mailyLabels = labels.filter(label => label.name.startsWith('Maily/'));

    const totalOrganized = mailyLabels.reduce((sum, label) =>
      sum + (label.messagesTotal || 0), 0);

    const categoryStats = mailyLabels.map(label => ({
      category: label.name.replace('Maily/', ''),
      count: label.messagesTotal || 0,
      percentage: totalOrganized > 0 ?
        Math.round(((label.messagesTotal || 0) / totalOrganized) * 100) : 0
    })).sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        processing: {
          isActive: processingStatus.isProcessing,
          totalEmails: processingStatus.totalEmails,
          processedEmails: processingStatus.processedEmails,
          errors: processingStatus.errors,
          currentBatch: processingStatus.currentBatch,
          totalBatches: processingStatus.totalBatches
        },
        organization: {
          totalOrganizedEmails: totalOrganized,
          totalCategories: mailyLabels.length,
          categoryBreakdown: categoryStats
        },
        performance: {
          startTime: processingStatus.startTime,
          elapsedSeconds: processingStatus.startTime ?
            Math.round((Date.now() - processingStatus.startTime) / 1000) : 0,
          emailsPerMinute: processingStatus.startTime && processingStatus.processedEmails > 0 ?
            Math.round(processingStatus.processedEmails / ((Date.now() - processingStatus.startTime) / 1000) * 60) : 0
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
