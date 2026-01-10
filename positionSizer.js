// positionSizer.js - Fixed import + Enhanced logging for debugging
const axios = require('axios'); // already required in server.js, but safe to add
const { getCurrentEquity } = require('./utils/getAccountBalance');
const { logSignal } = require('./utils/signalAuditor');
const { loadPositions } = require('./storage/mongoStorage');
const CryptoJS = require('crypto-js');
const { getRiskReference } = require('./utils/equityAllocationManager');
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

  // === FETCH SYMBOL SPECS DIRECTLY FROM BITUNIX API (public, no auth) ===
  let symbolInfo = { minQty: 0.01, qtyPrecision: 2 }; // safe fallback

  try {
    const response = await axios.get(`https://fapi.bitunix.com/api/v1/futures/market/trading_pairs?symbols=${signal.symbol}`, { timeout: 5000 });
    if (response.data.code === 0 && response.data.data && response.data.data.length > 0) {
      const info = response.data.data[0];
      symbolInfo = {
        minQty: parseFloat(info.minTradeVolume || '0.01'),
        qtyPrecision: parseInt(info.basePrecision || 2)
      };
      console.log(`[POSITION SIZER] Fetched ${signal.symbol} specs: minQty=${symbolInfo.minQty}, qtyPrecision=${symbolInfo.qtyPrecision}`);
    } else {
      console.warn(`[POSITION SIZER] Unexpected response for ${signal.symbol} specs — using fallback`);
    }
  } catch (err) {
    console.warn(`[POSITION SIZER] Failed to fetch specs for ${signal.symbol} — using fallback minQty=0.01`, err.message);
  }

  console.log('[POSITION SIZER] Fetching open positions...');
  const positions = await loadPositions();
  const openCount = positions.filter(p => p.isMaster && p.status === 'open').length;
  console.log(`[POSITION SIZER] Found ${openCount} open position(s)`);

  // === CALCULATE USED MARGIN ===

  const account = await signedGet('/api/v1/futures/account', { marginCoin: 'USDT' });
  let usedMargin = parseFloat(account?.margin || 0);

  // SAFE toFixed wrapper
  let usedMarginStr = 'N/A';
  try {
    usedMarginStr = usedMargin.toFixed(2);
    console.log(`[POSITION SIZER] Total used margin: $${usedMarginStr} USDT`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] usedMargin.toFixed(2) failed — usedMargin is:', usedMargin);
    throw e;
  }

  // NEW: Use standalone balance fetch
  console.log('[POSITION SIZER] Fetching current equity...');
  
  const riskReference = await getRiskReference();
  const currentEquityForLog = await getCurrentEquity(); // only for logging
  console.log(`[POSITION SIZER] Using Risk Reference: $${riskReference} (instead of live equity $${currentEquityForLog})`);

  const usedMarginPercent = (parseFloat(usedMargin || 0) / riskReference) * 100;

  // SAFE toFixed wrapper
  let usedMarginPercentStr = 'N/A';
  try {
    usedMarginPercentStr = usedMarginPercent.toFixed(2);
    console.log(`[POSITION SIZER] Used margin percent: ${usedMarginPercentStr}%`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] usedMarginPercent.toFixed(2) failed — usedMarginPercent is:', usedMarginPercent);
    throw e;
  }

  if (openCount >= parseInt(process.env.MAX_CONCURRENT_POSITIONS)) {
    // SAFE toFixed in skip log
    let skipPercentStr = 'N/A';
    try {
      skipPercentStr = usedMarginPercent.toFixed(2);
    } catch (e) {
      console.error('[TOFIXED CULPRIT] usedMarginPercent in skip log failed');
    }
    console.log(`[POSITION SIZER] Max concurrent positions reached (${openCount} >= ${process.env.MAX_CONCURRENT_POSITIONS}), skipping trade`);
    await require('../utils/signalAuditor').logSignal(signal, 'skipped', {
      reason: 'max_concurrent_reached',
      openCount
    });
    return null;
  }
  if (usedMarginPercent > parseFloat(process.env.MAX_MARGIN_USAGE_PERCENT)) {
    let skipPercentStr = 'N/A';
    try {
      skipPercentStr = usedMarginPercent.toFixed(2);
    } catch (e) {
      console.error('[TOFIXED CULPRIT] usedMarginPercent in margin skip log failed');
    }
    console.log(`[POSITION SIZER] Max margin usage exceeded (${skipPercentStr}% > ${process.env.MAX_MARGIN_USAGE_PERCENT}%), skipping trade`);
    await require('../utils/signalAuditor').logSignal(signal, 'skipped', {
      reason: 'max_margin_usage_reached',
      usedMarginPercent
    });
    return null;
  }

  if (riskReference === 0) {
    console.log('[POSITION SIZER] Failed to fetch equity (returned 0), skipping dynamic sizing');
    return null;
  }

  const avgEntry = entries.reduce((a, b) => a + b, 0) / entries.length;

  // SAFE toFixed
  let avgEntryStr = 'N/A';
  try {
    avgEntryStr = avgEntry.toFixed(8);
    console.log(`[POSITION SIZER] Average entry price: $${avgEntryStr}`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] avgEntry.toFixed(8) failed — avgEntry is:', avgEntry);
    throw e;
  }

  const distance = direction === 'BUY' ? (avgEntry - sl) : (sl - avgEntry);

  // SAFE toFixed
  let distanceStr = 'N/A';
  try {
    distanceStr = distance.toFixed(8);
    console.log(`[POSITION SIZER] Raw distance to SL: ${distanceStr}`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] distance.toFixed(8) failed — distance is:', distance);
    throw e;
  }

  const riskDistance = distance / avgEntry;

  // SAFE toFixed
  let riskDistanceStr = 'N/A';
  try {
    riskDistanceStr = (riskDistance * 100).toFixed(4);
    console.log(`[POSITION SIZER] Risk distance %: ${riskDistanceStr}%`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] riskDistance.toFixed(4) failed — riskDistance is:', riskDistance);
    throw e;
  }

  const riskAmount = riskReference * (parseFloat(process.env.RISK_PER_TRADE_PERCENT) / 100);

  // SAFE toFixed
  let riskAmountStr = 'N/A';
  try {
    riskAmountStr = riskAmount.toFixed(2);
    console.log(`[POSITION SIZER] Risk amount: $${riskAmountStr} (${process.env.RISK_PER_TRADE_PERCENT}% of equity)`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] riskAmount.toFixed(2) failed — riskAmount is:', riskAmount);
    throw e;
  }

  let notional = Math.abs(riskAmount / riskDistance);

  // SAFE toFixed
  let notionalPreStr = 'N/A';
  try {
    notionalPreStr = notional.toFixed(2);
    console.log(`[POSITION SIZER] Calculated notional (pre-cap): $${notionalPreStr}`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] notional pre-cap toFixed failed — notional is:', notional);
    throw e;
  }

  // Safeguards
  if (notional < parseFloat(process.env.MIN_NOTIONAL_USDT)) {
    let smallNotionalStr = 'N/A';
    try {
      smallNotionalStr = notional.toFixed(2);
    } catch (e) {
      console.error('[TOFIXED CULPRIT] notional in min check failed');
    }
    console.log(`[POSITION SIZER] Notional too small ($${smallNotionalStr} < $${process.env.MIN_NOTIONAL_USDT}), skipping`);
    await logSignal(signal, 'skipped', {
      reason: 'notional_too_small',
      calculatedNotional: notional
    });
    return null;
  }
  
  // SAFE toFixed
  let notionalFinalStr = 'N/A';
  try {
    notionalFinalStr = notional.toFixed(2);
    console.log(`[POSITION SIZER] Final notional after cap: $${notionalFinalStr}`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] notional final toFixed failed');
    throw e;
  }

  // Split equally across entry levels
  const notionalPerEntry = notional / entries.length;

  // SAFE toFixed
  let notionalPerStr = 'N/A';
  try {
    notionalPerStr = notionalPerEntry.toFixed(2);
    console.log(`[POSITION SIZER] Notional per entry: $${notionalPerStr} (across ${entries.length} entries)`);
  } catch (e) {
    console.error('[TOFIXED CULPRIT] notionalPerEntry.toFixed(2) failed — notionalPerEntry is:', notionalPerEntry);
    throw e;
  }

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

  // === CALCULATE QTY WITH EXCHANGE RULES ===
  console.log('[POSITION SIZER] Calculating qty per entry with Bitunix rules...');
  const qtyPerEntry = entries.map((entry, i) => {
    let rawQty = (notionalPerEntry / entry) / multiplier;

    // Enforce minimum qty per order
    if (rawQty < symbolInfo.minQty) {
      // SAFE toFixed
      let rawQtyLog = 'N/A';
      try {
        rawQtyLog = rawQty.toFixed(6);
      } catch (e) {
        console.error('[TOFIXED CULPRIT] rawQty in boost log failed — rawQty is:', rawQty);
      }
      console.log(`   → Raw qty ${rawQtyLog} below exchange min ${symbolInfo.minQty} — boosting to min`);
      rawQty = symbolInfo.minQty;
    }

    // SAFE toFixed for rounding
    let roundedQtyStr = 'N/A';
    try {
      roundedQtyStr = rawQty.toFixed(symbolInfo.qtyPrecision);
    } catch (e) {
      console.error('[TOFIXED CULPRIT] rawQty.toFixed(qtyPrecision) failed — rawQty is:', rawQty, 'precision:', symbolInfo.qtyPrecision);
      throw e;
    }
    const qty = Number(roundedQtyStr);

    // SAFE toFixed for log
    let rawQtyFinalLog = 'N/A';
    try {
      rawQtyFinalLog = rawQty.toFixed(6);
    } catch (e) {
      console.error('[TOFIXED CULPRIT] rawQty in final log failed');
    }
    console.log(`   → Entry ${i+1} @ $${entry}: raw ${rawQtyFinalLog} → final ${qty}`);
    return qty;
  });

  // Final total check
  const totalPlannedQty = qtyPerEntry.reduce((a, b) => a + parseFloat(b), 0);
  if (totalPlannedQty === 0 || totalPlannedQty < symbolInfo.minQty * entries.length) {
    console.log(`[POSITION SIZER] Total qty ${totalPlannedQty} invalid after adjustment — skipping trade`);
    return null;
  }

  console.log(`[POSITION SIZER] Sizing complete → returning result`);
  return {
    qtyPerEntry,
    notional,
    riskAmount,
    riskReference
  };
}

module.exports = { calculatePositionSize };