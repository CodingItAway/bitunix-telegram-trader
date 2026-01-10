const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema({
  isMaster: { type: Boolean, default: false },
  symbol: { type: String, required: true, index: true },
  direction: { type: String, enum: ['BUY', 'SELL'], required: true },
  avgEntryPrice: Number,
  totalQty: Number,
  currentQty: Number,
  sl: Number,
  originalTargets: [Number],
  tpSetCount: { type: Number, default: 0 },
  nextTpIndex: { type: Number, default: 0 },
  allocatedTpQty: [Number],
  pendingEntryCount: Number,
  slPlaced: { type: Boolean, default: false },
  status: { 
    type: String, 
    enum: ['pending_fill', 'open', 'closed', 'error'],
    default: 'pending_fill' 
  },
  createdAt: { type: Date, default: Date.now },
  lastUpdated: Date,
  note: String,
  _remove: { type: Boolean, default: false } // temporary flag during cleanup
}, {
  timestamps: true
});

positionSchema.index({ symbol: 1, direction: 1, status: 1 });

module.exports = mongoose.model('Position', positionSchema);