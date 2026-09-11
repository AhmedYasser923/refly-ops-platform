const mongoose = require('mongoose');

const usageLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  userName: {
    type: String,
    required: true
  },
  operationType: {
    type: String,
    required: true,
    enum: [
      'ticket_analysis',
      'email_translation',
      'poa_standard',
      'poa_lufthansa',
      'poa_aerlingus',
      'text_autofill',
      'barcode_decode',
      'sig_processing',
      'email_translation_sync',
      'email_refinement',
      'announcement_format',
      'announcement_label',
      'announcement_ask',
      'tracker_search',
      'doc_check',
      'iata_lookup',
      'jurisdiction_check',
      'ec261_calc',
      'claim_intake_extract'
    ]
  },
  model: {
    type: String,
    default: null
  },
  inputTokens: {
    type: Number,
    default: 0
  },
  outputTokens: {
    type: Number,
    default: 0
  },
  costUSD: {
    type: Number,
    default: 0
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  year: {
    type: Number,
    required: true
  },
  month: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { versionKey: false });

usageLogSchema.index({ userId: 1, year: 1, month: 1 });
usageLogSchema.index({ year: 1, month: 1 });
usageLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('UsageLog', usageLogSchema);
