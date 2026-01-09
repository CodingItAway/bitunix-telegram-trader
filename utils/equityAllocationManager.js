// utils/equityAllocationManager.js - HEAVY DEBUG VERSION

const { loadHistory, saveHistory } = require('../storage/googleDriveStorage');
const { getCurrentEquity } = require('./getAccountBalance');

const REALIZED_DRAWDOWN_THRESHOLD = 0.05; // 5%

let cache = null;

console.log('[EQUITY MANAGER] Module loaded — starting with clean cache');

async function refreshCache() {
  console.log('[EQUITY MANAGER] refreshCache() called');

  let history;
  let currentEquity = null;

  try {
    console.log('[EQUITY MANAGER] Attempting to load history from Drive...');
    history = await loadHistory();
    console.log('[EQUITY MANAGER] History loaded successfully:', JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[EQUITY MANAGER] FAILED to load history:', err.message);
    console.error('[EQUITY MANAGER] Stack:', err.stack);
    throw err; // Let it fail loud — we want to know
  }

  if (!history) {
    console.error('[EQUITY MANAGER] History is null or undefined after load!');
    throw new Error('History load returned null/undefined');
  }

  try {
    console.log('[EQUITY MANAGER] Fetching current equity from Bitunix...');
    currentEquity = await getCurrentEquity();
    console.log('[EQUITY MANAGER] getCurrentEquity() returned:', currentEquity);
  } catch (err) {
    console.error('[EQUITY MANAGER] getCurrentEquity() THREW ERROR:', err.message);
    console.error('[EQUITY MANAGER] Stack:', err.stack);
    throw err;
  }

  if (currentEquity === null || currentEquity === undefined) {
    console.error('[EQUITY MANAGER] currentEquity is null or undefined!');
    throw new Error('currentEquity is invalid');
  }

  // Peak update
  const currentPeak = history.peakEquity || 0;
  console.log(`[EQUITY MANAGER] Current peakEquity from history: ${currentPeak}`);
  console.log(`[EQUITY MANAGER] Current live equity: ${currentEquity}`);

  if (currentEquity > currentPeak) {
    console.log(`[EQUITY MANAGER] New high water mark! Updating peakEquity from ${currentPeak} → ${currentEquity}`);
    history.peakEquity = currentEquity;
    try {
      await saveHistory(history);
      console.log('[EQUITY MANAGER] Peak updated and saved to Drive');
    } catch (err) {
      console.error('[EQUITY MANAGER] Failed to save updated peak:', err.message);
    }
  } else {
    console.log('[EQUITY MANAGER] No new peak — currentEquity not higher than stored peak');
  }

  // Safe closed PnL sum
  let closedPnlSum = 0;
  if (Array.isArray(history.closedPositions)) {
    console.log(`[EQUITY MANAGER] closedPositions is array with ${history.closedPositions.length} entries`);
    closedPnlSum = history.closedPositions.reduce((sum, p) => {
      const pnl = p.realizedPNL || 0;
      console.log(`   → Adding PNL: ${pnl} (from position)`);
      return sum + pnl;
    }, 0);
    console.log(`[EQUITY MANAGER] Total realized PnL from closed positions: ${closedPnlSum}`);
  } else {
    console.warn('[EQUITY MANAGER] closedPositions is NOT an array:', history.closedPositions);
  }

  const initial = history.initialBalance || 0;
  console.log(`[EQUITY MANAGER] initialBalance: ${initial}`);

  const realizedEquity = initial + closedPnlSum;
  const unrealizedPnL = currentEquity - realizedEquity;

  console.log(`[EQUITY MANAGER] Calculated realizedEquity: ${realizedEquity}`);
  console.log(`[EQUITY MANAGER] Calculated unrealizedPnL: ${unrealizedPnL}`);

  cache = {
    ...history,
    currentEquity,
    unrealizedPnL,
    realizedEquity
  };

  console.log('[EQUITY MANAGER] Cache refreshed successfully');
  console.log('[EQUITY MANAGER] Final cache state:', JSON.stringify({
    initialBalance: cache.initialBalance,
    peakEquity: cache.peakEquity,
    currentEquity: cache.currentEquity,
    realizedEquity: cache.realizedEquity,
    unrealizedPnL: cache.unrealizedPnL,
    riskBaseMode: cache.riskBaseMode
  }, null, 2));

  return cache;
}

async function getRiskReference() {
  console.log('[EQUITY MANAGER] getRiskReference() called');

  try {
    await refreshCache();
  } catch (err) {
    console.error('[EQUITY MANAGER] refreshCache failed in getRiskReference:', err.message);
    return 0; // Fail safe — but loud in logs
  }

  if (!cache) {
    console.error('[EQUITY MANAGER] Cache is null after refresh!');
    return 0;
  }

  if (cache.riskBaseMode === 'protective') {
    console.log(`[EQUITY MANAGER] Risk mode: protective → using initialBalance = ${cache.initialBalance}`);
    return cache.initialBalance || 0;
  }

  const ref = Math.max(cache.initialBalance || 0, cache.peakEquity || 0);
  console.log(`[EQUITY MANAGER] Risk mode: aggressive → using MAX(initial=${cache.initialBalance}, peak=${cache.peakEquity}) = ${ref}`);
  return ref;
}

async function getCapitalStatus() {
  console.log('[EQUITY MANAGER] getCapitalStatus() called');
  await refreshCache();

  if (!cache) {
    console.error('[EQUITY MANAGER] Cache null in getCapitalStatus');
    return {};
  }

  const realizedDD = cache.realizedEquity && cache.initialBalance
    ? (cache.realizedEquity - cache.initialBalance) / cache.initialBalance
    : 0;

  const showAcceptButton = !cache.realizedDrawdownAccepted && realizedDD <= -REALIZED_DRAWDOWN_THRESHOLD;

  console.log(`[EQUITY MANAGER] Realized drawdown: ${(realizedDD * 100).toFixed(2)}% → show button: ${showAcceptButton}`);

  return {
    initialCapital: cache.initialBalance || 0,
    peakEquity: cache.peakEquity || 0,
    currentEquity: cache.currentEquity || 0,
    realizedEquity: cache.realizedEquity || 0,
    unrealizedPnL: cache.unrealizedPnL || 0,
    realizedDrawdownPercent: (realizedDD * 100).toFixed(2),
    riskReference: await getRiskReference(),
    riskMode: cache.riskBaseMode || 'aggressive',
    showAcceptDrawdownButton: showAcceptButton && !!cache.featureEnabledAt
  };
}

async function acceptRealizedDrawdown() {
  console.log('[EQUITY MANAGER] acceptRealizedDrawdown() called by user');

  const history = await loadHistory();
  const closedPnlSum = Array.isArray(history.closedPositions)
    ? history.closedPositions.reduce((s, p) => s + (p.realizedPNL || 0), 0)
    : 0;

  const currentRealized = (history.initialBalance || 0) + closedPnlSum;

  console.log(`[EQUITY MANAGER] Accepting drawdown: new base = ${currentRealized}`);

  history.initialBalance = currentRealized;
  history.peakEquity = Math.max(currentRealized, history.peakEquity || 0);
  history.realizedDrawdownAccepted = true;
  history.riskBaseMode = 'protective';

  await saveHistory(history);
  cache = null;

  console.log('[EQUITY MANAGER] Drawdown accepted and saved');
}

async function forceAggressiveMode() {
  console.log('[EQUITY MANAGER] forceAggressiveMode() called by user');
  const history = await loadHistory();
  history.riskBaseMode = 'aggressive';
  history.realizedDrawdownAccepted = false;
  await saveHistory(history);
  cache = null;
  console.log('[EQUITY MANAGER] Forced aggressive mode');
}

module.exports = {
  getRiskReference,
  getCapitalStatus,
  acceptRealizedDrawdown,
  forceAggressiveMode
};