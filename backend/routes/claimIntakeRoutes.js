const express = require('express');
const multer = require('multer');
const router = express.Router();
const claimIntakeController = require('../controllers/claimIntakeController');
const { protect } = require('../middleware/auth');
const userRateLimit = require('../middleware/userRateLimit');
const { validateTicketFiles } = require('../middleware/validateUploads');

// A passenger uploads fewer documents than an agent does.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
    fieldSize: 1024 * 1024,
    parts: 15
  }
});

// Behind auth while this lives in the ops tools suite. Going public later means
// dropping this line and swapping userRateLimit for an IP-based limiter —
// nothing else in the flow assumes a session.
router.use('/api/claim-intake', protect);

router.post(
  '/api/claim-intake/extract',
  userRateLimit,
  upload.array('document', 5),
  validateTicketFiles,
  claimIntakeController.extractClaimIntake
);

// Manual entry: the same deterministic build, no upload and no model call.
router.post(
  '/api/claim-intake/itinerary',
  userRateLimit,
  claimIntakeController.buildManualItinerary
);

module.exports = router;
