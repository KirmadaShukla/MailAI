const express = require('express');
const cors = require('cors');
const winston = require('winston');
const mongoose = require('mongoose');
const config = require('./config/config');

// Import routes
const processingRoutes = require('./routes/processing');
const authRoutes = require('./routes/auth');
const emailRoutes = require('./routes/email');

const app = express();

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'maily-parallel-api' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Routes
app.use('/api', processingRoutes);
app.use('/api', authRoutes);
app.use('/api/email', emailRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Maily Parallel Processing API Server',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    features: [
      'Ultimate Parallel Email Processing',
      'Real-time Status Monitoring',
      'Batch Processing (200 emails per batch)',
      'Intelligent AI Categorization',
      'No Queue System - Pure API Control',
      'Organized Modular Architecture'
    ],
    endpoints: {
      'GET /api/auth/url': 'Get Gmail OAuth authentication URL',
      'POST /api/auth/callback': 'Complete OAuth authentication',
      'GET /api/auth/status/:userId': 'Check user authentication status',
      'DELETE /api/auth/revoke/:userId': 'Revoke user authentication',
      'POST /api/process': 'Start parallel email processing (requires auth)',
      'GET /api/status': 'Get real-time processing status (requires auth)',
      'GET /api/logs': 'View processing logs (requires auth)',
      'GET /api/labels': 'Get Gmail labels and statistics (requires auth)',
      'GET /api/stats': 'Get comprehensive statistics (requires auth)',
      'POST /api/stop': 'Stop current processing (requires auth)',
      'GET /api/email/labels': 'Get user Gmail labels (requires auth)',
      'POST /api/email/categorize': 'Queue email categorization (requires auth)',
      'POST /api/email/categories': 'Add custom category (requires auth)'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to Maily Parallel Processing API',
    version: '2.0.0',
    documentation: {
      health: 'GET /health',
      api: 'All endpoints under /api/*'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    requestedPath: req.path,
    availableEndpoints: {
      'GET /': 'API information',
      'GET /health': 'Health check',
      'POST /api/process': 'Start email processing',
      'GET /api/status': 'Processing status',
      'GET /api/logs': 'Processing logs',
      'GET /api/labels': 'Gmail labels',
      'GET /api/stats': 'Statistics',
      'POST /api/stop': 'Stop processing'
    }
  });
});

// Connect to MongoDB
async function connectDatabase() {
  try {
    if (config.mongoUri) {
      await mongoose.connect(config.mongoUri);
      console.log('📦 Connected to MongoDB');
      logger.info('MongoDB connection established');
    } else {
      console.log('⚠️ MongoDB URI not provided - running without database');
      logger.warn('MongoDB URI not configured');
    }
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    logger.error('MongoDB connection failed:', error);
    // Continue without database for backward compatibility
  }
}

// Start server
const PORT = process.env.PORT || 3003;

async function startServer() {
  await connectDatabase();

  app.listen(PORT, () => {
    console.log('🚀 Maily Multi-User Email Processing API Server');
    console.log(`📡 Running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🔐 Authentication: GET http://localhost:${PORT}/api/auth/url`);
    console.log(`📧 Process emails: POST http://localhost:${PORT}/api/process`);
    console.log(`📈 Check status: GET http://localhost:${PORT}/api/status`);
    console.log('⚡ MULTI-USER ARCHITECTURE');
    console.log('🎯 PARALLEL PROCESSING WITH USER AUTHENTICATION');
    logger.info(`Maily API Server started on port ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  logger.error('Server startup failed:', error);
  process.exit(1);
});

module.exports = app;
