const mongoose = require('mongoose');

const closedPositionSchema = new mongoose.Schema({
  positionId: String,
  symbol: String,
  side: String,
  qty: Number,
  entryPrice: Number,
  closePrice: Number,
  realizedPNL: Number,
  fee: Number,
  funding: Number,
  leverage: Number,
  closeTime: Number,
  closeReason: String,
  closeSource: String
});

const historySchema = new mongoose.Schema({
  featureEnabledAt: Date,
  initialBalance: Number,
  peakEquity: Number,
  closedPositions: [closedPositionSchema],
  lastHistoryCheckpoint: Number,
  pendingCloseIntents: { type: Map, of: Object },
  riskBaseMode: { 
    type: String, 
    enum: ['aggressive', 'protective'],
    default: 'aggressive'
  },
  realizedDrawdownAccepted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('History', historySchema);