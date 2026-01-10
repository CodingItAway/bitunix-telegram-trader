const mongoose = require('mongoose');

const signalSchema = new mongoose.Schema({
  timestamp: Date,
  symbol: String,
  direction: String,
  entries: String,
  sl: String,
  outcome: String,
  reason: String
});

const failureSchema = new mongoose.Schema({
  timestamp: Date,
  outcome: String,
  signal: Object,
  rawText: String,
  error: String,
  stack: String,
  // ... any other fields you log in failures
});

const auditSchema = new mongoose.Schema({
  signals: [signalSchema],
  failures: [failureSchema],
  lastPruned: Date
}, { timestamps: true });

module.exports = mongoose.model('SignalAudit', auditSchema);