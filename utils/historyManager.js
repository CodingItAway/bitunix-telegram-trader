// utils/historyManager.js

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

const { getCurrentEquity } = require('./getAccountBalance');
const { loadHistory, saveHistory } = require('../storage/googleDriveStorage');

const API_BASE = 'https://fapi.bitunix.com';

async function signedGet(endpoint, params = {}) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  // Sort params alphabetically and concatenate key+value (NO separators)
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => key + params[key])
    .join('');

  const queryString = new URLSearchParams(params).toString();
  const queryParams = queryString ? '?' + queryString : '';

  // Digest: nonce + timestamp + apiKey + sortedParams (no ?/=) + empty body
  const digestInput = nonce + timestamp + process.env.BITUNIX_API_KEY + sortedParams + '';
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + process.env.BITUNIX_API_SECRET).toString();

  const url = API_BASE + endpoint + queryParams;

  const headers = {
    'api-key': process.env.BITUNIX_API_KEY,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  try {
    const response = await fetch(url, { method: 'GET', headers });
    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`API Error ${data.code}: ${data.msg || 'Unknown'}`);
    }

    return data;
  } catch (err) {
    console.error('[signedGet] Error:', err.message);
    throw err;
  }
}

async function fetchClosedPositionsSince(checkpointMs) {
  const now = Date.now();
  const params = {
    startTime: checkpointMs.toString(),
    endTime: now.toString(),
    pageSize: 100
  };

  try {
    const data = await signedGet('/api/v1/futures/position/get_history_positions', params);
    return data.data?.positionList || [];
  } catch (err) {
    console.error('[History] Fetch error:', err.message);
    return [];
  }
}

async function updateHistory() {
  const history = await loadHistory();
  if (!history.featureEnabledAt) return; // feature off

  const newPositions = await fetchClosedPositionsSince(history.lastHistoryCheckpoint);
  if (newPositions.length === 0) {
    // === NEW: Even with no new closes, advance checkpoint to now ===
    const now = Date.now();
    if (now > history.lastHistoryCheckpoint) {
      history.lastHistoryCheckpoint = now;
      console.log('[History] No new closed positions — advancing checkpoint to current time');
      await saveHistory(history);
    }
    return;
  }

  const existingIds = new Set(history.closedPositions.map(p => p.positionId));
  const newUnique = newPositions.filter(p => !existingIds.has(p.positionId));

  if (newUnique.length > 0) {
    console.log(`[History] Found ${newUnique.length} new closed positions`);

newUnique.forEach(p => {
  const positionId = p.positionId?.toString();
  let closeSource = 'manual_or_liquidated';

  if (positionId && history.pendingCloseIntents?.[positionId]) {
    closeSource = history.pendingCloseIntents[positionId].source;
    delete history.pendingCloseIntents[positionId]; // cleanup
  }

  history.closedPositions.push({
    positionId: p.positionId,
    symbol: p.symbol,
    side: p.side,
    qty: parseFloat(p.qty),
    entryPrice: parseFloat(p.entryPrice),
    closePrice: parseFloat(p.closePrice),
    realizedPNL: parseFloat(p.realizedPNL || p.realizedPnl || 0),
    fee: parseFloat(p.fee || 0),
    funding: parseFloat(p.funding || 0),
    leverage: p.leverage,
    closeTime: parseInt(p.mtime || p.ctime || 0),
    closeReason: p.closeReason || 'Unknown',
    closeSource // ← NEW FIELD
  });
});

await saveHistory(history);


    // Sort by closeTime (oldest to newest)
    history.closedPositions.sort((a, b) => a.closeTime - b.closeTime);

    // Update checkpoint to the latest closeTime from new data
    const latestTime = Math.max(...newUnique.map(p => parseInt(p.mtime || p.ctime || 0)));
    if (latestTime > history.lastHistoryCheckpoint) {
      history.lastHistoryCheckpoint = latestTime;
    }

    await saveHistory(history);
  } else {
    // === NEW: No duplicates/new positions — still advance checkpoint ===
    const now = Date.now();
    if (now > history.lastHistoryCheckpoint) {
      history.lastHistoryCheckpoint = now;
      console.log('[History] No new closed positions — advancing checkpoint to current time');
      await saveHistory(history);
    }
  }
}

async function getEquityCurve() {
  const history = await loadHistory();
  if (!history.featureEnabledAt) return { enabled: false };

  const curve = [];
  let runningEquity = history.initialBalance;

  curve.push({
    timestamp: new Date(history.featureEnabledAt).getTime(),
    equity: runningEquity,
    label: 'Start'
  });

  for (const pos of history.closedPositions) {
    runningEquity += pos.realizedPNL;
    curve.push({
      timestamp: pos.closeTime,
      equity: runningEquity,
      label: `${pos.symbol} ${pos.side} PNL: ${pos.realizedPNL.toFixed(4)}`
    });
  }

  return {
    enabled: true,
    initialBalance: history.initialBalance,
    currentEquity: runningEquity,
    curve,
    closedPositions: history.closedPositions
  };
}

module.exports = {
  updateHistory,
  getEquityCurve
};