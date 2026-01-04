// utils/signalAuditor.js

const { loadAudit, saveAudit } = require('../storage/signalAuditStorage');

let cache = { signals: [], failures: [] }; // In-memory cache

async function logSignal(signal, outcome, details = {}) {
  const timestamp = new Date().toISOString();

  // Always log minimal signal row
  const signalRow = {
    timestamp,
    symbol: signal?.symbol || 'UNKNOWN',
    direction: signal?.direction || 'UNKNOWN',
    entries: signal?.entries?.join(', ') || '',
    sl: signal?.sl || '',
    outcome, // 'success' | 'skipped' | 'failed'
    reason: details.reason || (outcome === 'success' ? 'Executed' : 'Unknown')
  };

  cache.signals.unshift(signalRow); // Newest first
  if (cache.signals.length > 500) cache.signals.pop(); // Limit total

  // Only store detailed failure if not success
  if (outcome !== 'success') {
    const failureDetail = {
      timestamp,
      outcome,
      signal: signal || null,
      rawText: details.rawText || null,
      error: details.error || null,
      apiResponse: details.apiResponse || null,
      stack: details.stack || new Error().stack,
      ...details
    };
    cache.failures.unshift(failureDetail);
    if (cache.failures.length > 100) cache.failures.pop();
  }

  // Save to Drive every time (lightweight)
  await saveAudit(cache);
}

module.exports = { logSignal };