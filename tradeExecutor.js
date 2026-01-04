// tradeExecutor.js - DYNAMIC POSITION SIZING UPGRADE
const fetch = require('node-fetch');
const BitunixClient = require('./utils/openNewPositions');
const { loadPositions, savePositions } = require('./storage/googleDriveStorage');
const { calculatePositionSize } = require('./positionSizer'); // NEW: Dynamic sizing
const { logSignal } = require('./utils/signalAuditor');

// === ADAPTIVE ENTRY CONFIG ===
const USE_POST_ONLY = process.env.USE_POST_ONLY !== 'false';
const LATE_MARKET_PERCENT = parseFloat(process.env.LATE_MARKET_PERCENT || '35') / 100;
const LATE_E1_PERCENT = parseFloat(process.env.LATE_E1_PERCENT || '35') / 100;
const LATE_E2_PERCENT = parseFloat(process.env.LATE_E2_PERCENT || '30') / 100;
const NORMAL_E1_PERCENT = parseFloat(process.env.NORMAL_E1_PERCENT || '50') / 100;
const NORMAL_E2_PERCENT = parseFloat(process.env.NORMAL_E2_PERCENT || '50') / 100;

const client = new BitunixClient(process.env.BITUNIX_API_KEY, process.env.BITUNIX_API_SECRET);

async function executeTrade(signal) {

  try{
  const { symbol, direction, entries, targets, sl } = signal;

  // Validate signal (UNCHANGED)
  if (!symbol || !direction || entries.length === 0 || !sl) {
    console.log('Invalid signal — skipping');
    return;
  }

  // === DYNAMIC POSITION SIZING (NEW) ===
  // Try dynamic sizing first, fallback to test mode if env vars missing
  let sizeResult;
  let isTestMode = false;
  let TOTAL_NOTIONAL, LEVERAGE, notionalPerEntry, qtyNumbers;

  try {
    sizeResult = await calculatePositionSize(signal);
    if (sizeResult) {
      // Dynamic sizing succeeded
      const { qtyPerEntry, notional, riskAmount, currentEquity } = sizeResult;
      LEVERAGE = parseInt(process.env.LEVERAGE || '15'); // Default 15x
      TOTAL_NOTIONAL = notional;
      notionalPerEntry = TOTAL_NOTIONAL / entries.length;
      qtyNumbers = qtyPerEntry.map(q => parseFloat(q));

      console.log(`🚀 DYNAMIC SIZING: ${direction} ${symbol}`);
      console.log(`   Equity: $${currentEquity.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} (${process.env.RISK_PER_TRADE_PERCENT || 1}%)`);
      console.log(`   Notional: $${TOTAL_NOTIONAL.toFixed(2)} @ ${LEVERAGE}x | Avg Entry: $${entries.reduce((a, b) => a + b, 0) / entries.length}`);
    } else {
      throw new Error('Sizing returned null');
    }
  } catch (e) {
    // Fallback to test mode (preserves existing behavior if env vars missing)
    console.log(`⚠️ Dynamic sizing failed, using TEST MODE: ${e.message}`);
    await logSignal(signal, 'warning', { reason: 'dynamic_sizing_failed', error: e.message });
    return;
  }

  // Set leverage (UNCHANGED logic, just uses dynamic LEVERAGE)
  try {
    await client.changeLeverage(symbol, LEVERAGE);
    console.log(`✅ Leverage set to ${LEVERAGE}x${isTestMode ? ' (TEST MODE)' : ''}`);
  } catch (e) {
    console.error('❌ Failed to set leverage:', e.message);
    if (e.response?.data) console.error('   Response:', JSON.stringify(e.response.data));
    await logSignal(signal, 'failed', { reason: 'leverage_setting_failed', error: e.message });
    return;
  }

  const firstTp = targets.length > 0 ? targets[0] : null; // UNCHANGED
  let successfulOrders = 0;

  // === FETCH CURRENT MARK PRICE (PUBLIC ENDPOINT - NO SIGNING) ===
let currentPrice = 0;

try {
  const url = `https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=${symbol}`;
  const response = await fetch(url, { timeout: 10000 });
  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`API error ${data.code}: ${data.msg || 'Unknown'}`);
  }

  const ticker = data.data[0];
  if (!ticker) {
    throw new Error('No ticker data returned');
  }

  currentPrice = parseFloat(ticker.markPrice || ticker.lastPrice || 0);

  if (currentPrice <= 0) {
    throw new Error('Invalid mark price (0 or negative)');
  }

  console.log(`[PRICE VALIDATION] Current mark price ${symbol}: $${currentPrice.toFixed(6)}`);
} catch (e) {
  console.error(`[PRICE VALIDATION] Failed to fetch current price: ${e.message}`);
  await logSignal(signal, 'skipped', { 
    reason: 'failed_fetch_public_mark_price',
    error: e.message 
  });
  return; // Abort trade safely
}

   // === ADAPTIVE ENTRY LOGIC ===
  const isLong = direction === 'BUY';
  const e1 = entries[0]; // higher entry
  const e2 = entries[1]; // lower entry (assume 2 entries — add check if needed)

  // Detect if both entries are already crossed
  const bothCrossed = isLong ? (currentPrice > e1) : (currentPrice < e1);

  const totalQty = qtyNumbers.reduce((a, b) => a + b, 0);

  if (bothCrossed) {
    console.log(`[LATE SIGNAL] Both entries crossed (CMP: ${currentPrice.toFixed(6)}) — using market + post-only limits`);

    // 35% market order at current price
    const marketQty = totalQty * LATE_MARKET_PERCENT;
    if (marketQty > 0) {
      try {
        const marketParams = {
          symbol,
          side: direction,
          qty: marketQty.toFixed(6),
          orderType: 'MARKET',
          tradeSide: 'OPEN',
          reduceOnly: false,
          slPrice: sl.toString(),
          slStopType: 'MARK',
          slOrderType: 'MARKET',
        };
        await client.placeOrder(marketParams);
        successfulOrders++;
        console.log(`✅ Market entry placed: ${marketQty.toFixed(6)} @ market (~${currentPrice.toFixed(6)})`);
      } catch (err) {
        console.error(`❌ Market entry failed: ${err.message}`);
        await logSignal(signal, 'failed', { reason: 'market_entry_failed', error: err.message });
      }
    }

    // 35% post-only limit at E1
    const limitE1Qty = totalQty * LATE_E1_PERCENT;
    if (limitE1Qty > 0) {
      try {
        const params = {
          symbol,
          side: direction,
          price: e1.toString(),
          qty: limitE1Qty.toFixed(6),
          orderType: 'LIMIT',
          tradeSide: 'OPEN',
          effect: USE_POST_ONLY ? 'POST_ONLY' : 'GTC',
          reduceOnly: false,
          slPrice: sl.toString(),
          slStopType: 'MARK',
          slOrderType: 'MARKET',
        };
        await client.placeOrder(params);
        successfulOrders++;
        console.log(`✅ Post-only limit E1: ${limitE1Qty.toFixed(6)} @ ${e1}`);
      } catch (err) {
        console.log(`[ENTRY] Post-only E1 rejected (likely crossed): ${err.message}`);
      }
    }

    // 30% post-only limit at E2
    const limitE2Qty = totalQty * LATE_E2_PERCENT;
    if (limitE2Qty > 0) {
      try {
        const params = {
          symbol,
          side: direction,
          price: e2.toString(),
          qty: limitE2Qty.toFixed(6),
          orderType: 'LIMIT',
          tradeSide: 'OPEN',
          effect: USE_POST_ONLY ? 'POST_ONLY' : 'GTC',
          reduceOnly: false,
          slPrice: sl.toString(),
          slStopType: 'MARK',
          slOrderType: 'MARKET',
        };
        await client.placeOrder(params);
        successfulOrders++;
        console.log(`✅ Post-only limit E2: ${limitE2Qty.toFixed(6)} @ ${e2}`);
      } catch (err) {
        console.log(`[ENTRY] Post-only E2 rejected: ${err.message}`);
      }
    }
  }  else {
  // ON-TIME SIGNAL: Use individual entry prices with post-only limits
  console.log('[ON-TIME SIGNAL] Using individual post-only limit prices');

  for (let i = 0; i < entries.length; i++) {
    const entryPrice = entries[i];
    const qtyForThisEntry = qtyNumbers[i];

    if (parseFloat(qtyForThisEntry) <= 0) {
      console.log(`[ENTRY] Skipping E${i+1} — zero quantity`);
      continue;
    }

    const orderParams = {
      symbol,
      side: direction,
      qty: qtyForThisEntry.toString(),
      orderType: 'LIMIT',
      price: entryPrice.toString(),     // ← NOW CORRECT: uses actual entry level price
      postOnly: true,
      effect: 'GTC',
      tradeSide: 'OPEN',
      reduceOnly: false
    };

    try {
      const result = await client.placeOrder(orderParams);
      const orderId = result.orderId || 'unknown';
      console.log(`✅ Post-only limit E${i+1} placed: ${qtyForThisEntry} @ ${entryPrice} (ID: ${orderId})`);
      successfulOrders++;
    } catch (err) {
      console.error(`❌ [ENTRY] Post-only E${i+1} failed at $${entryPrice}: ${err.message}`);
      if (err.response?.data) {
        console.error('   API Response:', JSON.stringify(err.response.data, null, 2));
      }
      // Optionally continue trying others
    }
  }
}

  if (successfulOrders === 0) {
    console.log('No entry orders placed — aborting');
    return;
  }

  // === CREATE MASTER RECORD (UNCHANGED logic, just enhanced note) ===
  const positions = await loadPositions();

  let master = positions.find(p => 
    p.symbol === symbol && 
    p.direction === direction && 
    p.isMaster
  );

  if (!master) {
    const totalQty = qtyNumbers.reduce((a, b) => a + b, 0);

    const weightedSum = entries.reduce((sum, price, idx) => sum + price * qtyNumbers[idx], 0);
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
      pendingEntryCount: entries.length,
      slPlaced: false,
      status: 'pending_fill',
      isMaster: true,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      note: isTestMode 
        ? `${successfulOrders}/${entries.length} entries placed | TEST $${TOTAL_NOTIONAL} MODE`
        : `${successfulOrders}/${entries.length} entries | Risk $${(sizeResult.riskAmount || 0).toFixed(2)} | Notional $${TOTAL_NOTIONAL.toFixed(2)} @ ${LEVERAGE}x`
    };

    positions.push(master);
    await savePositions(positions);
    console.log(`📌 Master record created & saved for ${symbol} ${direction}`);
    console.log(`   Avg Entry ≈ $${avgEntryPrice.toFixed(6)} | Total Qty ≈ ${totalQty.toFixed(6)}`);
  } else {
    console.log(`Master already exists for ${symbol} ${direction}`);
  }
  
  if (successfulOrders > 0) {
      await logSignal(signal, 'success', { 
        reason: 'partial_or_full_entry_success',
        successfulOrders,
        note: isTestMode ? 'test_mode_fallback' : 'dynamic_live'
      });
    } else {
      await logSignal(signal, 'failed', { reason: 'no_orders_placed' });
    }
}

catch (err) {
    await logSignal(signal, 'failed', {
      reason: 'executor_crash',
      error: err.message,
      stack: err.stack
    });
  }
}
module.exports = { executeTrade };