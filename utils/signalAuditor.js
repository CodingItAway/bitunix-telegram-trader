// utils/signalAuditor.js - Persistent 30-day audit with append + prune

const { loadAudit, saveAudit } = require('../storage/mongoStorage');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let audit = { signals: [], failures: [] }; // Full persistent audit

async function initAudit() {
  try {
    const loaded = await loadAudit();
    audit = loaded || { signals: [], failures: [] };
    pruneOldEntries();
    console.log(`[AUDIT] Loaded ${audit.signals.length} signals and ${audit.failures.length} failures from Drive`);
  } catch (e) {
    console.warn('[AUDIT] Failed to load audit — starting fresh:', e.message);
    audit = { signals: [], failures: [] };
  }
}

function pruneOldEntries() {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  audit.signals = audit.signals.filter(s => new Date(s.timestamp).getTime() > cutoff);
  audit.failures = audit.failures.filter(f => new Date(f.timestamp).getTime() > cutoff);
  console.log(`[AUDIT] Pruned old entries — kept ${audit.signals.length} signals, ${audit.failures.length} failures`);
}

async function logSignal(signal, outcome, details = {}) {
  const timestamp = new Date().toISOString();

  const signalRow = {
    timestamp,
    symbol: signal?.symbol || 'UNKNOWN',
    direction: signal?.direction || 'UNKNOWN',
    entries: signal?.entries?.join(', ') || '',
    sl: signal?.sl || '',
    outcome,
    reason: details.reason || (outcome === 'success' ? 'Executed' : 'Unknown')
  };

  audit.signals.unshift(signalRow); // newest first

  if (outcome !== 'success') {
    const failureDetail = {
      timestamp,
      outcome,
      signal: signal || null,
      rawText: details.rawText || null,
      error: details.error || null,
      stack: details.stack || new Error().stack,
      ...details
    };
    audit.failures.unshift(failureDetail);
  }

  // Prune and save
  pruneOldEntries();
  await saveAudit(audit);
}

// Load on startup
initAudit();

module.exports = { logSignal };