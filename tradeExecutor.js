// tradeExecutor.js - FINAL: Risk + Timeliness Aware Allocation (mrd-specific)

const fetch = require('node-fetch');
const BitunixClient = require('./utils/openNewPositions');
const { loadPositions, savePositions } = require('./storage/googleDriveStorage');
const { calculatePositionSize } = require('./positionSizer');
const { logSignal } = require('./utils/signalAuditor');
const { google } = require('googleapis'); // Add this if not already there
// === CONFIG ===
const USE_POST_ONLY = process.env.USE_POST_ONLY !== 'false';
const LATE_MARKET_PERCENT = parseFloat(process.env.LATE_MARKET_PERCENT || '35') / 100;

// === RISK & TIMELINESS BASED ALLOCATION ===
// onTime: always 2-way split (2 limit orders)
// late: always 3-way split (market + 2 limits)
const ENTRY_ALLOCATION = {
  medium: {
    onTime: [50, 50],     // balanced
    late:   [35, 35, 30]  // market 35%, E1 35%, E2 30%
  },
  low: {
    onTime: [80, 20],     // aggressive immediate fill
    late:   [50, 30, 20]  // market 50%, E1 30%, E2 20%
  }
};

const client = new BitunixClient(process.env.BITUNIX_API_KEY, process.env.BITUNIX_API_SECRET);

async function executeTrade(signal) {
  try {
    const { symbol, direction, entries, targets, sl } = signal;

// === FETCH LIVE RISK FROM MRD_ACTIVE_SIGNALS.JSON (READ-ONLY MIRROR) ===
let actualRiskLevel = 'medium'; // safe fallback

try {
  if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    console.warn('[LIVE RISK MIRROR] GOOGLE_CREDENTIALS_BASE64 not set — defaulting to medium');
  } else if (!process.env.MRD_ACTIVE_SIGNALS_FOLDER_ID) {
    console.warn('[LIVE RISK MIRROR] MRD_ACTIVE_SIGNALS_FOLDER_ID not set — defaulting to medium');
  } else {
    // Direct authentication — same pattern as googleDriveStorage.js
    const jsonString = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    const credentials = JSON.parse(jsonString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.list({
      q: `name='mrd_active_signals.json' and '${process.env.MRD_ACTIVE_SIGNALS_FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive'
    });

    if (res.data.files.length === 0) {
      console.log('[LIVE RISK MIRROR] mrd_active_signals.json not found in folder — defaulting to medium');
    } else {
      const fileId = res.data.files[0].id;
      const content = await drive.files.get({ fileId, alt: 'media' });

      let rawData = content.data;
      if (Buffer.isBuffer(rawData)) rawData = rawData.toString('utf-8');
      else if (typeof rawData === 'object') rawData = JSON.stringify(rawData);

      const data = JSON.parse(rawData);
      const activeSignal = data.signals.find(s => s.symbol === symbol);

      if (activeSignal?.risk) {
        actualRiskLevel = activeSignal.risk.toLowerCase() === 'low' ? 'low' : 'medium';
        console.log(`[LIVE RISK MIRROR] ${symbol}: "${activeSignal.risk}" → using "${actualRiskLevel}" risk`);
      } else {
        console.log(`[LIVE RISK MIRROR] No risk field for ${symbol} — defaulting to medium`);
      }
    }
  }
} catch (e) {
  console.warn(`[LIVE RISK MIRROR] Error fetching risk for ${symbol}: ${e.message} — using medium`);
}

    if (!symbol || !direction || entries.length === 0 || !sl) {
      console.log('Invalid signal — skipping');
      return;
    }

    // === DYNAMIC LEVERAGE CALCULATION ===
      const plannedAvgEntry = entries.reduce((a, b) => a + b, 0) / entries.length;
      const slDistancePct = Math.abs(plannedAvgEntry - sl) / plannedAvgEntry;

      let leverage = Math.floor(1 / (slDistancePct));

      // Bump +1 if low risk
      if (actualRiskLevel.toLowerCase() === 'low') {
        leverage += 1;
      }

      // Caps
      leverage = Math.max(11, Math.min(leverage, 20));

console.log(`[DYNAMIC LEVERAGE] Avg entry: ${plannedAvgEntry.toFixed(6)} | SL distance: ${(slDistancePct*100).toFixed(2)}% | Risk: ${actualRiskLevel} → Using ${leverage}x`);

    // === DYNAMIC SIZING ===
    let sizeResult;
    let TOTAL_NOTIONAL, LEVERAGE;

    try {
      sizeResult = await calculatePositionSize(signal);
      if (!sizeResult) throw new Error('Sizing returned null');

      const { notional, riskAmount, currentEquity } = sizeResult;
      LEVERAGE = leverage;
      TOTAL_NOTIONAL = notional;

      console.log(`DYNAMIC SIZING: ${direction} ${symbol}`);
      console.log(`   Equity: $${currentEquity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)}`);
      console.log(`   Notional: $${TOTAL_NOTIONAL.toFixed(2)} @ ${LEVERAGE}x`);
    } catch (e) {
      console.log(`Dynamic sizing failed — skipping: ${e.message}`);
      await logSignal(signal, 'failed', { 
  reason: 'dynamic_sizing_failed',
  note: 'Sizing returned null or threw error'
});
      return;
    }

    // Set leverage
    try {
      await client.changeLeverage(symbol, LEVERAGE);
      console.log(`Leverage set to ${LEVERAGE}x`);
    } catch (e) {
      console.error('Failed to set leverage:', e.message);
      await logSignal(signal, 'failed', { reason: 'leverage_setting_failed' });
      return;
    }

    // === FETCH CURRENT PRICE ===
    let currentPrice = entries.reduce((a, b) => a + b, 0) / entries.length;
    try {
      const res = await fetch(`https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=${symbol}`, { timeout: 10000 });
      const data = await res.json();
      if (data.code === 0 && data.data[0]) {
        currentPrice = parseFloat(data.data[0].markPrice || data.data[0].lastPrice);
      }
      console.log(`Current mark price: $${currentPrice.toFixed(6)}`);
    } catch (e) {
      console.warn('Price fetch failed, using avg entry');
    }

    // === DETERMINE TIMELINESS (NEW RULE: price beyond best entry = late) ===
let isLate = false;

if (direction === 'BUY') {
  // LONG: late if price is above the highest (best) entry → chasing
  const highestEntry = Math.max(...entries);
  isLate = currentPrice > highestEntry;
} else {
  // SHORT: late if price is below the lowest (best) entry → chasing
  const lowestEntry = Math.min(...entries);
  isLate = currentPrice < lowestEntry;
}

const timing = isLate ? 'late' : 'onTime';

console.log(`[TIMELINESS] ${direction} | Current: $${currentPrice.toFixed(6)} | ${isLate ? 'LATE (beyond best entry)' : 'ON-TIME'}`);

    // === ALLOCATION PERCENTAGES ===
    const percentages = ENTRY_ALLOCATION[actualRiskLevel][timing];

    console.log(`SIGNAL TYPE: ${actualRiskLevel.toUpperCase()} | ${isLate ? 'LATE' : 'ON-TIME'} → Allocation: ${percentages.join(' / ')}%`);

    // === CALCULATE QUANTITIES ===
    const multiplier = symbol.startsWith('1000') ? 1000 : symbol.startsWith('1000000') ? 1000000 : 1;
    const qtyNumbers = percentages.map((pct, idx) => {
      const notionalThis = TOTAL_NOTIONAL * (pct / 100);
      const price = isLate && idx === 0 ? currentPrice : entries[Math.min(idx - (isLate ? 1 : 0), entries.length - 1)];
      const rawQty = (notionalThis / price) / multiplier;
      return parseFloat(rawQty.toFixed(0));
    });

    console.log(`Quantities: ${qtyNumbers.join(' / ')} contracts`);

    let successfulOrders = 0;

    if (isLate) {
      // LATE: Market + 2 limits
      // qtyNumbers[0] → market
      // qtyNumbers[1] → limit at entries[0]
      // qtyNumbers[2] → limit at entries[1]

      if (qtyNumbers[0] > 0) {
        try {
          await client.placeOrder({
            symbol,
            side: direction,
            qty: qtyNumbers[0].toFixed(6),
            orderType: 'MARKET',
            tradeSide: 'OPEN',
            reduceOnly: false,
          });
          successfulOrders++;
          console.log(`Market entry: ${qtyNumbers[0]} @ market`);
        } catch (err) {
          console.error(`Market entry failed: ${err.message}`);
        }
      }

      for (let i = 1; i < qtyNumbers.length; i++) {
        const qty = qtyNumbers[i];
        const price = entries[i - 1];
        if (qty <= 0) continue;

        try {
          await client.placeOrder({
            symbol,
            side: direction,
            price: price.toString(),
            qty: qty.toFixed(6),
            orderType: 'LIMIT',
            effect: USE_POST_ONLY ? 'POST_ONLY' : 'GTC',
            tradeSide: 'OPEN',
            reduceOnly: false,
          });
          successfulOrders++;
          console.log(`Late limit E${i}: ${qty} @ ${price}`);
        } catch (err) {
          console.log(`Late limit E${i} rejected: ${err.message}`);
        }
      }
    } else {
      // ON-TIME: 2 post-only limits
      for (let i = 0; i < qtyNumbers.length; i++) {
        const qty = qtyNumbers[i];
        const price = entries[i];
        if (qty <= 0) continue;

        try {
          const result = await client.placeOrder({
            symbol,
            side: direction,
            price: price.toString(),
            qty: qty.toString(),
            orderType: 'LIMIT',
            postOnly: true,
            effect: 'GTC',
            tradeSide: 'OPEN',
            reduceOnly: false,
          });
          console.log(`Post-only E${i+1}: ${qty} @ ${price} (ID: ${result.orderId || 'unknown'})`);
          successfulOrders++;
        } catch (err) {
          console.error(`Post-only E${i+1} failed: ${err.message}`);
        }
      }
    }

    if (successfulOrders === 0) {
      console.log('No orders placed — aborting');
      await logSignal(signal, 'failed', { reason: 'no_orders_placed' });
      return;
    }

    // === MASTER RECORD ===
    const positions = await loadPositions();
    let master = positions.find(p => p.symbol === symbol && p.direction === direction && p.isMaster);

    if (!master) {
      const totalQty = qtyNumbers.reduce((a, b) => a + b, 0);
      const weightedSum = entries.reduce((sum, price, idx) => {
        const qtyIdx = isLate ? idx + 1 : idx;
        return sum + price * (qtyNumbers[qtyIdx] || 0);
      }, isLate ? currentPrice * qtyNumbers[0] : 0);
      const avgEntryPrice = weightedSum / totalQty;

      master = {
        symbol,
        direction,
        avgEntryPrice: parseFloat(avgEntryPrice.toFixed(6)),
        totalQty,
        currentQty: 0,
        sl: parseFloat(sl),
        originalTargets: targets.map(t => parseFloat(t)),
        tpSetCount: 0,
        nextTpIndex: 0,
        allocatedTpQty: new Array(targets.length).fill(0),
        pendingEntryCount: entries.length + (isLate ? 1 : 0),
        slPlaced: false,
        status: 'pending_fill',
        isMaster: true,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        note: `${successfulOrders} entries placed | ${actualRiskLevel} risk | ${isLate ? 'late' : 'on-time'} | Notional $${TOTAL_NOTIONAL.toFixed(2)}`
      };

      positions.push(master);
      await savePositions(positions);
      console.log(`Master record created — Avg Entry ≈ $${avgEntryPrice.toFixed(6)}`);
    }

    await logSignal(signal, 'success', {
      reason: 'entry_success',
      successfulOrders,
      note: `${actualRiskLevel}_${timing}`
    });

  } catch (err) {
    console.error('Executor crash:', err);
    await logSignal(signal, 'failed', { reason: 'executor_crash', error: err.message, stack: err.stack });
  }
}

module.exports = { executeTrade };