// utils/equityAllocationManager.js

const { loadHistory, saveHistory } = require('../storage/googleDriveStorage');
const { getCurrentEquity } = require('./getAccountBalance');

const REALIZED_DRAWDOWN_THRESHOLD = 0.05; // 5%

let cache = null;

async function refreshCache() {
  const history = await loadHistory();
  const currentEquity = await getCurrentEquity();

  // Update peak if higher
  if (currentEquity > (history.peakEquity || 0)) {
    history.peakEquity = currentEquity;
    await saveHistory(history);
  }

  cache = {
    ...history,
    currentEquity,
    unrealizedPnL: currentEquity - (history.initialBalance + (history.closedPositions.reduce((sum, p) => sum + p.realizedPNL, 0))),
    realizedEquity: history.initialBalance + history.closedPositions.reduce((sum, p) => sum + p.realizedPNL, 0)
  };

  return cache;
}

async function getRiskReference() {
  await refreshCache();
  
  if (cache.riskBaseMode === 'protective') {
    return cache.initialBalance; // User accepted lower base
  }

  // Aggressive mode: use peak
  return Math.max(cache.initialBalance || 0, cache.peakEquity || 0);
}

async function getCapitalStatus() {
  await refreshCache();

  const realizedDD = (cache.realizedEquity - cache.initialBalance) / cache.initialBalance;
  const showAcceptButton = !cache.realizedDrawdownAccepted && realizedDD <= -REALIZED_DRAWDOWN_THRESHOLD;

  return {
    initialCapital: cache.initialBalance,
    peakEquity: cache.peakEquity,
    currentEquity: cache.currentEquity,
    realizedEquity: cache.realizedEquity,
    unrealizedPnL: cache.unrealizedPnL,
    realizedDrawdownPercent: (realizedDD * 100).toFixed(2),
    riskReference: await getRiskReference(),
    riskMode: cache.riskBaseMode,
    showAcceptDrawdownButton: showAcceptButton && cache.featureEnabledAt
  };
}

async function acceptRealizedDrawdown() {
  const history = await loadHistory();
  const currentRealized = history.initialBalance + history.closedPositions.reduce((s, p) => s + p.realizedPNL, 0);

  history.initialBalance = currentRealized;
  history.peakEquity = Math.max(currentRealized, history.peakEquity || 0);
  history.realizedDrawdownAccepted = true;
  history.riskBaseMode = 'protective'; // or keep aggressive? your call

  await saveHistory(history);
  cache = null; // invalidate
  console.log(`[RISK MANAGER] User accepted realized drawdown. New initialCapital = $${currentRealized.toFixed(2)}`);
}

async function forceAggressiveMode() {
  const history = await loadHistory();
  history.riskBaseMode = 'aggressive';
  history.realizedDrawdownAccepted = false;
  await saveHistory(history);
  cache = null;
  console.log('[RISK MANAGER] Forced aggressive mode — using peak equity');
}

module.exports = {
  getRiskReference,
  getCapitalStatus,
  acceptRealizedDrawdown,
  forceAggressiveMode
};