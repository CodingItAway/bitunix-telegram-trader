// storage/mongoStorage.js
// Patched version - January 2026 - Safe against connection race conditions
// NEVER creates empty documents automatically on load failure

const mongoose = require('mongoose');
const Position = require('../models/Position');
const History = require('../models/History');
const SignalAudit = require('../models/SignalAudit');

// Helper to check if mongoose is connected
function isConnected() {
  return mongoose.connection.readyState === 1; // 1 = connected
}

async function loadPositions() {
  if (!isConnected()) {
    console.warn('[mongoStorage] MongoDB not connected yet → returning empty positions array');
    return [];
  }

  try {
    return await Position.find({}).lean();
  } catch (err) {
    console.error('[mongoStorage] Failed to load positions:', err.message);
    return []; // safe fallback - do NOT create anything
  }
}

async function savePositions(positions) {
  if (!isConnected()) {
    console.error('[mongoStorage] Cannot save positions - MongoDB not connected');
    return;
  }

  try {
    // For small datasets this is still fine, but we could optimize later
    await Position.deleteMany({});
    if (positions?.length > 0) {
      await Position.insertMany(positions, { ordered: false });
      console.log(`[mongoStorage] Saved ${positions.length} positions`);
    } else {
      console.log('[mongoStorage] No positions to save');
    }
  } catch (err) {
    console.error('[mongoStorage] Failed to save positions:', err.message);
  }
}

async function loadHistory() {
  if (!isConnected()) {
    console.warn('[mongoStorage] MongoDB not connected → returning default history object');
    return getHistoryDefaults();
  }

  try {
    const doc = await History.findOne().lean();
    if (doc) return doc;

    console.log('[mongoStorage] No history document found - returning defaults (no auto-create)');
    return getHistoryDefaults();
  } catch (err) {
    console.error('[mongoStorage] Failed to load history:', err.message);
    return getHistoryDefaults();
  }
}

function getHistoryDefaults() {
  return {
    featureEnabledAt: null,
    initialBalance: 0,
    peakEquity: 0,
    closedPositions: [],
    lastHistoryCheckpoint: 0,
    pendingCloseIntents: {},
    riskBaseMode: 'aggressive',
    realizedDrawdownAccepted: false
  };
}

async function saveHistory(data) {
  if (!isConnected()) {
    console.error('[mongoStorage] Cannot save history - MongoDB not connected');
    return;
  }

  try {
    const result = await History.findOneAndUpdate(
      {}, // single document strategy
      { $set: data },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true
      }
    );

    console.log('[mongoStorage] History document updated');
    return result;
  } catch (err) {
    console.error('[mongoStorage] Failed to save history:', err.message);
  }
}

async function loadAudit() {
  if (!isConnected()) {
    console.warn('[mongoStorage] MongoDB not connected → returning empty audit');
    return { signals: [], failures: [] };
  }

  try {
    const doc = await SignalAudit.findOne().lean();
    if (doc) return doc;

    console.log('[mongoStorage] No audit document found - returning empty (no auto-create)');
    return { signals: [], failures: [] };
  } catch (err) {
    console.error('[mongoStorage] Failed to load audit:', err.message);
    return { signals: [], failures: [] };
  }
}

async function saveAudit(data) {
  if (!isConnected()) {
    console.error('[mongoStorage] Cannot save audit - MongoDB not connected');
    return;
  }

  try {
    await SignalAudit.findOneAndUpdate(
      {},
      { $set: data },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );
    console.log('[mongoStorage] Audit saved successfully');
  } catch (err) {
    console.error('[mongoStorage] Failed to save audit:', err.message);
  }
}

module.exports = {
  loadPositions,
  savePositions,
  loadHistory,
  saveHistory,
  loadAudit,
  saveAudit
};