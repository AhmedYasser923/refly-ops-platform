const express = require('express');
const multer = require('multer');
const router = express.Router();
const analyzerV2Controller = require('../controllers/analyzerV2Controller');
const { protect } = require('../middleware/auth');
const userRateLimit = require('../middleware/userRateLimit');
const { validateTicketFiles } = require('../middleware/validateUploads');

// A specialist working a case uploads more than a passenger does: a booking
// confirmation, an e-ticket, and a boarding pass per leg per traveller adds up
// fast. Matched to the old analyzer's limits rather than the intake tool's 5.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10,
    fieldSize: 1024 * 1024,
    parts: 25
  }
});

// Staff-only, and staying that way - unlike the claim intake tool, this one has
// no public future to design around.
router.use('/api/analyzer-v2', protect);

router.post(
  '/api/analyzer-v2/analyze',
  userRateLimit,
  upload.array('document', 10),
  validateTicketFiles,
  analyzerV2Controller.analyzeDocuments
);

module.exports = router;
