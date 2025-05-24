const express = require('express');
const router = express.Router();
const { emailQueue } = require('../services/queueService');
const { getAllLabels } = require('../services/gmailService');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');

router.post('/categorize', authMiddleware, async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    await emailQueue.add({ userId });
    res.json({ message: 'Email categorization queued' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to queue categorization' });
  }
});

router.post('/categories', authMiddleware, async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { category } = req.body;
    const user = await User.findOneAndUpdate(
      { userId },
      { $addToSet: { customCategories: category } },
      { new: true }
    );
    res.json({ customCategories: user.customCategories });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add category' });
  }
});

// Get existing Gmail labels
router.get('/labels', authMiddleware, async (req, res) => {
  try {
    const labels = await getAllLabels();

    // Filter out system labels and return user-friendly format
    const userLabels = labels
      .filter(label => label.type === 'user' || label.type === 'system')
      .map(label => ({
        id: label.id,
        name: label.name,
        type: label.type,
        messagesTotal: label.messagesTotal || 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ labels: userLabels });
  } catch (error) {
    console.error('Error fetching labels:', error);
    res.status(500).json({ error: 'Failed to fetch labels' });
  }
});

module.exports = router;