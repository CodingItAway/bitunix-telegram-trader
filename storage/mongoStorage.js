// storage/mongoStorage.js
const Position = require('../models/Position');
const History = require('../models/History');
const SignalAudit = require('../models/SignalAudit');

async function loadPositions() {
  return await Position.find({}).lean();
}

async function savePositions(positions) {
  // For simplicity we delete & re-insert (since it's small dataset)
  await Position.deleteMany({});
  if (positions.length > 0) {
    await Position.insertMany(positions);
  }
}

async function loadHistory() {
  let doc = await History.findOne().lean();
  if (!doc) {
    doc = await History.create({
      featureEnabledAt: null,
      initialBalance: 0,
      peakEquity: 0,
      closedPositions: [],
      lastHistoryCheckpoint: 0,
      pendingCloseIntents: {},
      riskBaseMode: 'aggressive',
      realizedDrawdownAccepted: false
    });
  }
  return doc;
}

async function saveHistory(data) {
  await History.findOneAndUpdate(
    {}, // single document strategy
    data,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function loadAudit() {
  let doc = await SignalAudit.findOne().lean();
  if (!doc) {
    doc = await SignalAudit.create({
      signals: [],
      failures: []
    });
  }
  return doc;
}

async function saveAudit(data) {
  await SignalAudit.findOneAndUpdate(
    {},
    data,
    { upsert: true, new: true }
  );
}

module.exports = {
  loadPositions,
  savePositions,
  loadHistory,
  saveHistory,
  loadAudit,
  saveAudit
};