// positionManager.js - FIXED: Remove closed record from JSON properly

const BitunixClient = require('./utils/openNewPositions');
const { getPendingOrders } = require('./utils/getPendingOrders');
const { getOpenPositions } = require('./utils/getOpenPositions');
const { placeNextTpLevel } = require('./utils/tpslManager');
const { loadPositions, savePositions } = require('./storage/googleDriveStorage');
const { updateHistory } = require('./utils/historyManager');
require('dotenv').config();

const client = new BitunixClient(process.env.BITUNIX_API_KEY, process.env.BITUNIX_API_SECRET);

// Configurable TP allocation (sums to ~100%)
const TP_ALLOCATION_PERCENT = [30, 30, 20, 10, 5, 5];


async function managePositions() {
  const cycleStart = new Date();
  console.log(`\n[MANAGER CYCLE] ${cycleStart.toISOString()} - Starting position check...`);

  try {
    // Fetch live data
    const apiPositions = await getOpenPositions();
    const apiPendingOrders = await getPendingOrders();

    console.log(`[MANAGER] Fetched ${apiPositions.length} open positions and ${apiPendingOrders.length} pending orders from Bitunix`);

    let tracked = await loadPositions();
    tracked = tracked.filter(p => p.isMaster);
    console.log(`[MANAGER] Loaded ${tracked.length} master records from storage`);
    console.log(`[DEBUG] Records after removal: ${tracked.length} (should be 0)`);
    console.log('[DEBUG MASTER LOADED]', tracked.length, 'masters');
    if (tracked.length > 0) {
      console.log('[DEBUG] First master keys:', Object.keys(tracked[0]));
      console.log('[DEBUG] originalTargets type:', Array.isArray(tracked[0].originalTargets) ? 'array' : typeof tracked[0].originalTargets);
      console.log('[DEBUG] originalTargets content:', tracked[0].originalTargets);
    }

    let hasChanges = false;

    for (const master of tracked) {
  try {
    console.log(`[MANAGER] Checking ${master.symbol} ${master.direction} | Status: ${master.status} | Expected Total Qty: ${master.totalQty?.toFixed(6)}`);
    let shouldRemove = false;
    // Find matching open position
    const apiPos = apiPositions.find(p =>
      p.symbol === master.symbol &&
      p.side === master.direction
    );

    const positionId = apiPos?.positionId || apiPos?.id || null;

    if (!positionId && (master.status === 'open' || master.currentQty > 0)) {
        console.warn('[MANAGER] Warning: No positionId found despite filled qty — cannot place TP/SL');
        shouldRemove = true;
      }

    // Robust qty parsing
    const currentQty = apiPos
      ? parseFloat(
          apiPos.qty ||
          apiPos.positionQty ||
          apiPos.holdQty ||
          apiPos.positionAmt ||
          apiPos.availQty ||
          apiPos.positionSize ||
          0
        )
      : 0;

    master.currentQty = currentQty;
    master.lastUpdated = new Date().toISOString();

    console.log(`  → Detected current qty: ${currentQty.toFixed(6)}`);

    // === Pending entry orders filter ===
    const pendingEntries = apiPendingOrders.filter(o =>
      o.symbol === master.symbol &&
      o.side === master.direction &&
      o.orderType === 'LIMIT' &&
      o.reduceOnly === false &&
      o.status === 'NEW_' &&
      o.tradeQty === '0'
    );

    if (pendingEntries.length > 0) {
      console.log(`  → Found ${pendingEntries.length} pending entry orders:`);
      pendingEntries.forEach((order, idx) => {
        console.log(`     #${idx + 1}: ${order.qty} @ ${order.price} | Status: ${order.status} | TradeQty: ${order.tradeQty} | Order ID: ${order.orderId}`);
      });
    } else {
      console.log(`  → No pending entry orders found for this master`);
    }

    // === Fill progress ===
    console.log(`  → Fill progress: ${currentQty.toFixed(6)} filled / ${master.totalQty?.toFixed(6)} expected`);

          // === CLOSE LOGIC - Only when truly closed/canceled ===
    const wasActive = master.status === 'open' || master.status === 'pending_fill';
    const hasNoQuantity = currentQty < 0.001;
    const hasNoPendingEntries = pendingEntries.length === 0;

    let isTrulyClosed = wasActive && hasNoQuantity && hasNoPendingEntries;
    if(shouldRemove)
    {
      isTrulyClosed = true; // Force removal if no positionId
    }

    if (isTrulyClosed) {
      master.status = 'closed';
      master.closedAt = new Date().toISOString();
      console.log(`❌ [MANAGER] Position fully closed/canceled: ${master.symbol} ${master.direction} (no qty, no pending orders)`);
      master._remove = true;
      hasChanges = true;

        // === JOIN ALERT: TRADE CLOSED ===
const { sendJoinNotification } = require('./utils/joinNotification');
await sendJoinNotification(
  `Trade Closed`,
  `${master.symbol}`
);

  // === CANCEL STALE ENTRY ORDERS ===
if (pendingEntries.length > 0) {
console.log(`🧹 [CLEANUP] Canceling ${pendingEntries.length} stale entry orders via batch`);

const orderIds = pendingEntries.map(o => o.orderId);

const allCanceled = await client.cancelOrders(orderIds, master.symbol);

if (allCanceled) {
  console.log(`🧹 [CLEANUP] All ${pendingEntries.length} stale orders canceled successfully`);
} else {
  console.warn(`⚠️ [CLEANUP] Some stale orders failed to cancel — manual review recommended`);
}
} else {
console.log(`🧹 [CLEANUP] No stale entry orders to cancel`);
}

    } else if (wasActive && hasNoQuantity && !hasNoPendingEntries) {
      // This is normal — still waiting for limit orders to fill
      console.log(`⏳ [MANAGER] Still waiting for entry orders to fill: ${pendingEntries.length} pending`);
    }

    // === Transition to open ===
    if (master.status === 'pending_fill' && currentQty >= 0.0001) {
      master.status = 'open';
      console.log(`✅ [MANAGER] Position filled: ${master.symbol} ${master.direction} | Qty ${currentQty.toFixed(6)}`);
      hasChanges = true;
    }

// === BOMB MODE: RE-PLACE ALL TP LEVELS EVERY CYCLE ===
if (master.status === 'open' && master.originalTargets) {
for (let tpIndex = 0; tpIndex < master.originalTargets.length; tpIndex++) {
  const tpPrice = master.originalTargets[tpIndex];
  const allocation = TP_ALLOCATION_PERCENT[tpIndex];
  const qtyRaw = master.currentQty * allocation / 100;
  const qty = qtyRaw.toFixed(6).replace(/\.?0+$/, '');

  if (parseFloat(qty) <= 0) continue;

  const tpslParams = {
    symbol: master.symbol,
    side: master.direction === 'BUY' ? 'SELL' : 'BUY',
    qty: qty,
    tpPrice: tpPrice.toString(),
    tpTriggerType: 'MARK',
    tpOrderType: 'LIMIT',
    tpLimitPrice: master.direction === 'BUY'
      ? (tpPrice * 1.001).toString()
      : (tpPrice * 0.999).toString(),
    reduceOnly: true,
    marginCoin: 'USDT',
    positionMode: 'HEDGE',
    marginMode: 'ISOLATION',
    clientOrderId: `bomb_tp_${master.symbol}_${tpIndex}_${Date.now()}`
  };

  try {
    console.log(`[BOMB TP] Attempting TP${tpIndex + 1} @ ${tpPrice} | Qty: ${qty} | ${master.symbol}`);
    const success = await placeNextTpLevel(master, apiPos);
  } catch (e) {
    console.warn(`[BOMB TP] Failed (expected on duplicates): ${e.message}`);
  }
}
}
    // === DETECT DCA FILL VIA PENDING ENTRY COUNT DROP ===
const currentPendingCount = pendingEntries.length;
const previousPendingCount = master.pendingEntryCount ?? currentPendingCount;

// Calculate new fill qty upfront (safe even if no DCA)
const newFillQty = currentQty - (master.currentQty || 0);

if (currentPendingCount < previousPendingCount) {
const filledCount = previousPendingCount - currentPendingCount;
console.log(`🔄 [DCA FILL DETECTED] ${filledCount} entry order(s) filled — position grew (+${newFillQty.toFixed(6)})`);
console.log(`🔄 [LADDER REBUILD] Refreshing full TP ladder + SL for new total qty: ${currentQty.toFixed(6)}`);

  // === JOIN ALERT ===
  const { sendJoinNotification } = require('./utils/joinNotification');
  await sendJoinNotification(
    `Ladder Executed`,
    `Ladder ${filledCount + 1} executed for ${master.symbol}\n` +
    `+${newFillQty.toFixed(0)} contracts\n` +
    `Total: ${currentQty.toFixed(0)}`
  );

  // Reset for rebuild
  master.nextTpIndex = 0;
  master.tpSetCount = 0;
  master.slPlaced = false;
  hasChanges = true;
}

master.pendingEntryCount = currentPendingCount;

    // === PLACE STOP LOSS (self-contained) ===
    if (!master.slPlaced && master.currentQty > 0 && positionId) {
      console.log(`[MANAGER] Placing Stop Loss @ ${master.sl} for ${master.currentQty} contracts`);

      const fetch = require('node-fetch');
      const CryptoJS = require('crypto-js');

      const slParams = {
        symbol: master.symbol,
        positionId: positionId.toString(),
        slPrice: master.sl.toString(),
        slStopType: 'MARK_PRICE',
        slOrderType: 'MARKET',
        slQty: master.currentQty.toFixed(6).replace(/\.?0+$/, '')
      };

      const timestamp = Date.now().toString();
      const nonce = CryptoJS.lib.WordArray.random(16).toString();
      const bodyStr = JSON.stringify(slParams);
      const digestInput = nonce + timestamp + process.env.BITUNIX_API_KEY + '' + bodyStr;
      const digest = CryptoJS.SHA256(digestInput).toString();
      const sign = CryptoJS.SHA256(digest + process.env.BITUNIX_API_SECRET).toString();

      try {
        const response = await fetch('https://fapi.bitunix.com/api/v1/futures/tpsl/place_order', {
          method: 'POST',
          headers: {
            'api-key': process.env.BITUNIX_API_KEY,
            'nonce': nonce,
            'timestamp': timestamp,
            'sign': sign,
            'Content-Type': 'application/json',
            'language': 'en-US'
          },
          body: bodyStr
        });

        const data = await response.json();
        if (data.code !== 0) throw new Error(data.msg || 'SL failed');

        console.log(`🛡️ [MANAGER] Stop Loss successfully placed @ ${master.sl}`);
        master.slPlaced = true;
        hasChanges = true;
      } catch (e) {
        console.error(`❌ [MANAGER] SL placement failed: ${e.message}`);
      }
    }

  } catch (assetError) {
    console.error(`[MANAGER] Error processing ${master.symbol} ${master.direction} — skipping to next asset:`, assetError.message);
    if (assetError.stack) console.error(assetError.stack);
    continue; // ← This ensures the loop moves to the next master
  }
}

          // === Final cleanup: remove truly closed masters ===
    const closedMasters = tracked.filter(p => p._remove);
    if (closedMasters.length > 0) {
      tracked = tracked.filter(p => !p._remove);
      console.log(`[MANAGER] Removed ${closedMasters.length} closed position record(s) from storage`);
      hasChanges = true;
    }

    // Fetch historical closed positions only if we detected closures
    if (closedMasters.length > 0) {
      console.log(`[MANAGER] Detected ${closedMasters.length} newly closed positions → checking history API`);
      await updateHistory();
    }

    if (hasChanges) {
      await savePositions(tracked);
      console.log(`[MANAGER] Changes detected — saved updated positions to Drive`);
    } else {
      console.log(`[MANAGER] No changes — nothing saved`);
    }

    const cycleDuration = Date.now() - cycleStart.getTime();
    console.log(`[MANAGER CYCLE] Completed in ${cycleDuration}ms`);
  } catch (error) {
    console.error(`[MANAGER ERROR] Cycle failed: ${error.message}`);
    if (error.response) {
      console.error('API Response:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Run every 30 seconds
setInterval(managePositions, 30 * 1000);
managePositions(); // Initial run

module.exports = { managePositions };
