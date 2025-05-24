const express = require('express');
const cors = require('cors');
const winston = require('winston');
const config = require('./config/config');

// Import routes
const processingRoutes = require('./routes/processing');

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
      'POST /api/process': 'Start parallel email processing',
      'GET /api/status': 'Get real-time processing status',
      'GET /api/logs': 'View processing logs',
      'GET /api/labels': 'Get Gmail labels and statistics',
      'GET /api/stats': 'Get comprehensive statistics',
      'POST /api/stop': 'Stop current processing'
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

// Start server
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log('🚀 Maily Parallel Processing API Server');
  console.log(`📡 Running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📧 Process emails: POST http://localhost:${PORT}/api/process`);
  console.log(`📈 Check status: GET http://localhost:${PORT}/api/status`);
  console.log('⚡ ORGANIZED MODULAR ARCHITECTURE');
  console.log('🎯 PARALLEL PROCESSING ONLY - No background queue system');
  logger.info(`Maily API Server started on port ${PORT}`);
});

module.exports = app;
