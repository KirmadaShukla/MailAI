const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { authCategories, emailLabels } = require('../controllers/email');

router.post('/categories', authMiddleware,authCategories );

// Get existing Gmail labels
router.get('/labels', authMiddleware,emailLabels);

module.exports = router;