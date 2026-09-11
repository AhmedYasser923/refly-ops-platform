const express = require('express');
const router = express.Router();

let dbReady = false;

router.get('/api/health', (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ status: 'unavailable', reason: 'database not connected' });
  }

  res.json({ status: 'ok' });
});

// Lightweight version check - clients poll this to detect deploys
router.get('/api/version', (req, res) => {
  res.json({ version: req.app.get('appVersion') });
});

router.use('/', require('./authRoutes'));
router.use('/', require('./userRoutes'));
router.use('/', require('./adminRoutes'));
router.use('/', require('./toolsRoutes'));
router.use('/', require('./poaRoutes'));
router.use('/', require('./ticketRoutes'));
router.use('/', require('./barcodeRoutes'));
router.use('/', require('./claimIntakeRoutes'));
router.use('/', require('./analyzerV2Routes'));

router.setDbReady = (ready = true) => {
  dbReady = ready;
};

module.exports = router;
