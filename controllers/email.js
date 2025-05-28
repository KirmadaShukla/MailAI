const { getAllLabels } = require('../services/gmailService');
const User = require('../models/User');

const emailLabels=async(req,res)=>{
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
}

const authCategories=async(req,res)=>{
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
}

module.exports={emailLabels,authCategories};