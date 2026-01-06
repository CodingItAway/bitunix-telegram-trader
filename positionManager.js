// positionManager.js - BOMB MODE: Aggressive TP re-placement every cycle

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

    let hasChanges = false;

    // === RESILIENT PER-ASSET LOOP ===
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

        // === CLOSE LOGIC ===
        const wasActive = master.status === 'open' || master.status === 'pending_fill';
        const hasNoQuantity = currentQty < 0.001;
        const hasNoPendingEntries = pendingEntries.length === 0;

        let isTrulyClosed = wasActive && hasNoQuantity && hasNoPendingEntries;
        if (shouldRemove) {
          isTrulyClosed = true;
        }

        if (isTrulyClosed) {
          master.status = 'closed';
          master.closedAt = new Date().toISOString();
          console.log(`❌ [MANAGER] Position fully closed/canceled: ${master.symbol} ${master.direction}`);
          master._remove = true;
          hasChanges = true;

          // === JOIN ALERT: TRADE CLOSED ===
          const { sendJoinNotification } = require('./utils/joinNotification');
          await sendJoinNotification(
            `Trade Closed — ${master.symbol}`,
            `${master.direction === 'BUY' ? 'LONG' : 'SHORT'} closed\nQty: ${master.totalQty.toFixed(0)}`
          );

          // Cancel stale entry orders
          if (pendingEntries.length > 0) {
            console.log(`🧹 [CLEANUP] Canceling ${pendingEntries.length} stale entry orders`);
            const orderIds = pendingEntries.map(o => o.orderId);
            const allCanceled = await client.cancelOrders(orderIds, master.symbol);
            console.log(allCanceled ? 'All canceled' : 'Some failed');
          }
        } else if (wasActive && hasNoQuantity && !hasNoPendingEntries) {
          console.log(`⏳ [MANAGER] Still waiting for entry orders to fill: ${pendingEntries.length} pending`);
        }

        // === Transition to open ===
        if (master.status === 'pending_fill' && currentQty >= 0.0001) {
          master.status = 'open';
          console.log(`✅ [MANAGER] Position filled: ${master.symbol} ${master.direction} | Qty ${currentQty.toFixed(6)}`);
          hasChanges = true;
        }

        // === BOMB MODE: PLACE ALL 6 TP LEVELS EVERY CYCLE ===
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
                ? (tpPrice * 1.001).toString()  // slightly worse for fill
                : (tpPrice * 0.999).toString(),
              reduceOnly: true,
              marginCoin: 'USDT',
              positionMode: 'HEDGE',
              marginMode: 'ISOLATION',
              clientOrderId: `bomb_tp_\( {master.symbol}_ \){tpIndex}_\( {Date.now()}_ \){Math.random().toString(36).substr(2, 5)}`
            };

            try {
              console.log(`[BOMB TP] Sending TP${tpIndex + 1} @ ${tpPrice} | Qty: ${qty} | ${master.symbol}`);
              await placeNextTpLevel(master, apiPos); // your function — ignore success/fail
            } catch (e) {
              console.warn(`[BOMB TP] Failed (normal for duplicates/limit): ${e.message}`);
            }
          }
        }

        // === DCA FILL DETECTION ===
        const currentPendingCount = pendingEntries.length;
        const previousPendingCount = master.pendingEntryCount ?? currentPendingCount;
        const newFillQty = currentQty - (master.currentQty || 0);

        if (currentPendingCount < previousPendingCount) {
          const filledCount = previousPendingCount - currentPendingCount;
          console.log(`🔄 [DCA FILL DETECTED] \( {filledCount} entry order(s) filled (+ \){newFillQty.toFixed(6)})`);
          console.log(`🔄 [LADDER REBUILD] Triggering rebuild for ${master.symbol}`);

          const { sendJoinNotification } = require('./utils/joinNotification');
          await sendJoinNotification(
            `Ladder Executed`,
            `Ladder ${filledCount + 1} executed for \( {master.symbol}\n+ \){newFillQty.toFixed(0)} contracts\nTotal: ${currentQty.toFixed(0)}`
          );

          master.nextTpIndex = 0;
          master.tpSetCount = 0;
          master.slPlaced = false;
          hasChanges = true;
        }

        master.pendingEntryCount = currentPendingCount;

        // === STOP LOSS (keep existing logic) ===
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

            console.log(`🛡️ [MANAGER] Stop Loss placed @ ${master.sl}`);
            master.slPlaced = true;
            hasChanges = true;
          } catch (e) {
            console.error(`❌ [MANAGER] SL placement failed: ${e.message}`);
          }
        }

      } catch (assetError) {
        console.error(`[MANAGER] Error processing ${master.symbol} — skipping to next: ${assetError.message}`);
        continue; // Critical: never let one asset crash the whole cycle
      }
    }

    // === Final cleanup ===
    const closedMasters = tracked.filter(p => p._remove);
    if (closedMasters.length > 0) {
      tracked = tracked.filter(p => !p._remove);
      console.log(`[MANAGER] Removed ${closedMasters.length} closed positions`);
      hasChanges = true;
    }

    if (closedMasters.length > 0) {
      await updateHistory();
    }

    if (hasChanges) {
      await savePositions(tracked);
      console.log(`[MANAGER] Changes detected — saved positions to Drive`);
    } else {
      console.log(`[MANAGER] No changes — nothing saved`);
    }

    const cycleDuration = Date.now() - cycleStart.getTime();
    console.log(`[MANAGER CYCLE] Completed in ${cycleDuration}ms`);
  } catch (error) {
    console.error(`[MANAGER ERROR] Cycle failed: ${error.message}`);
  }
}

// Run every 30 seconds
setInterval(managePositions, 30 * 1000);
managePositions();

module.exports = { managePositions };
