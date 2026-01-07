// positionSizer.js - Fixed import + Enhanced logging for debugging

const { getCurrentEquity } = require('./utils/getAccountBalance');
const { logSignal } = require('./utils/signalAuditor');
const { loadPositions } = require('./storage/googleDriveStorage');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error('BITUNIX_API_KEY and BITUNIX_API_SECRET must be set in .env');
}

async function signedGet(endpoint, params = {}) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  // Sort params alphabetically (no = or ? in signature)
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}${params[key]}`)
    .join('');

  const queryString = new URLSearchParams(params).toString();
  const queryParams = queryString ? '?' + queryString : '';

  // Signature: nonce + timestamp + apiKey + sortedParams + body (empty)
  const digestInput = nonce + timestamp + API_KEY + sortedParams;
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + API_SECRET).toString();

  const url = API_BASE + endpoint + queryParams;

  const headers = {
    'api-key': API_KEY,
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
      console.error('[getAccountBalance] API Error:', data.code, data.msg);
      return null;
    }

    return data.data;
  } catch (err) {
    console.error('[getAccountBalance] Network error:', err.message);
    return null;
  }
}

async function calculatePositionSize(signal) {
  console.log(`\n[POSITION SIZER] Starting sizing calculation for ${signal.symbol} ${signal.direction}`);
  console.log(`[POSITION SIZER] Raw signal entries: ${signal.entries.join(', ')} | SL: ${signal.sl} | Targets count: ${signal.targets?.length || 0}`);

  const { entries, sl, direction } = signal;
  if (entries.length === 0) {
    console.log('[POSITION SIZER] No entries in signal — skipping');
    return null;
  }

  // NEW: Use standalone balance fetch
  console.log('[POSITION SIZER] Fetching current equity...');
  const currentEquity = await getCurrentEquity();
  console.log(`[POSITION SIZER] Current equity fetched: $${currentEquity.toFixed(2)} USDT`);

  if (currentEquity === 0) {
    console.log('[POSITION SIZER] Failed to fetch equity (returned 0), skipping dynamic sizing');
    return null;
  }

  console.log('[POSITION SIZER] Fetching open positions...');
  const positions = await loadPositions();
  const openCount = positions.filter(p => p.isMaster && p.status === 'open').length;
  console.log(`[POSITION SIZER] Found ${openCount} open position(s)`);

  // === CALCULATE USED MARGIN ===

  const account = await signedGet('/api/v1/futures/account', { marginCoin: 'USDT' });
  let usedMargin = parseFloat(account.margin || 0);

  console.log(`[POSITION SIZER] Total used margin: $${usedMargin.toFixed(2)} USDT`);

  const usedMarginPercent = (parseFloat(usedMargin || 0) / currentEquity) * 100;
  console.log(`[POSITION SIZER] Used margin percent: ${usedMarginPercent.toFixed(2)}%`);

  if (openCount >= parseInt(process.env.MAX_CONCURRENT_POSITIONS)) {
    console.log(`[POSITION SIZER] Max concurrent positions reached (${openCount} >= ${process.env.MAX_CONCURRENT_POSITIONS}), skipping trade`);
    await require('../utils/signalAuditor').logSignal(signal, 'skipped', {
      reason: 'max_concurrent_reached',
      openCount
    });
    return null;
  }
  if (usedMarginPercent > parseFloat(process.env.MAX_MARGIN_USAGE_PERCENT)) {
    console.log(`[POSITION SIZER] Max margin usage exceeded (${usedMarginPercent.toFixed(2)}% > ${process.env.MAX_MARGIN_USAGE_PERCENT}%), skipping trade`);
    await require('../utils/signalAuditor').logSignal(signal, 'skipped', {
      reason: 'max_margin_usage_reached',
      usedMarginPercent
    });
    return null;
  }

  const avgEntry = entries.reduce((a, b) => a + b, 0) / entries.length;
  console.log(`[POSITION SIZER] Average entry price: $${avgEntry.toFixed(8)}`);

  const distance = direction === 'BUY' ? (avgEntry - sl) : (sl - avgEntry);
  console.log(`[POSITION SIZER] Raw distance to SL: ${distance.toFixed(8)}`);

  const riskDistance = distance / avgEntry;
  console.log(`[POSITION SIZER] Risk distance %: ${(riskDistance * 100).toFixed(4)}%`);

  const riskAmount = currentEquity * (parseFloat(process.env.RISK_PER_TRADE_PERCENT) / 100);
  console.log(`[POSITION SIZER] Risk amount: $${riskAmount.toFixed(2)} (${process.env.RISK_PER_TRADE_PERCENT}% of equity)`);

  let notional = Math.abs(riskAmount / riskDistance);
  console.log(`[POSITION SIZER] Calculated notional (pre-cap): $${notional.toFixed(2)}`);

  // Safeguards
  if (notional < parseFloat(process.env.MIN_NOTIONAL_USDT)) {
    console.log(`[POSITION SIZER] Notional too small ($${notional.toFixed(2)} < $${process.env.MIN_NOTIONAL_USDT}), skipping`);
    await logSignal(signal, 'skipped', {
      reason: 'notional_too_small',
      calculatedNotional: notional
    });
    return null;
  }
  
  console.log(`[POSITION SIZER] Final notional after cap: $${notional.toFixed(2)}`);

  // Split equally across entry levels
  const notionalPerEntry = notional / entries.length;
  console.log(`[POSITION SIZER] Notional per entry: $${notionalPerEntry.toFixed(2)} (across ${entries.length} entries)`);

  // Detect multiplier (1000x or 1000000x)
  let multiplier = 1;
  if (signal.symbol.startsWith('1000')) {
    multiplier = 1000;
    console.log('[POSITION SIZER] Detected 1000x symbol — applying multiplier 1000');
  } else if (signal.symbol.startsWith('1000000')) {
    multiplier = 1000000;
    console.log('[POSITION SIZER] Detected 1000000x symbol — applying multiplier 1000000');
  } else {
    console.log('[POSITION SIZER] Standard symbol — multiplier = 1');
  }

  console.log('[POSITION SIZER] Calculating qty per entry...');
  const qtyPerEntry = entries.map((entry, i) => {
    const rawQty = (notionalPerEntry / entry) / multiplier;
    const qty = rawQty.toFixed(0);
    console.log(`   → Entry ${i+1} @ $${entry}: raw qty = ${rawQty.toFixed(6)} → rounded to ${qty}`);
    return qty;
  });

  const totalPlannedQty = qtyPerEntry.reduce((a, b) => a + parseFloat(b), 0);
  console.log(`[POSITION SIZER] Total planned qty: ${totalPlannedQty} contracts`);

  console.log(`[POSITION SIZER] Sizing complete → returning result`);
  return {
    qtyPerEntry,
    notional,
    riskAmount,
    currentEquity
  };
}

module.exports = { calculatePositionSize };