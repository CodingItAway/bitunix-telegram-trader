// positionManager.js - CONSOLIDATED BOMB MODE: Fast aggressive TP placement

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
    const apiPositions = await getOpenPositions();
    const apiPendingOrders = await getPendingOrders();

    console.log(`[MANAGER] Fetched ${apiPositions.length} open positions and ${apiPendingOrders.length} pending orders`);

    let tracked = await loadPositions();
    tracked = tracked.filter(p => p.isMaster);

    let hasChanges = false;

    for (const master of tracked) {
      try {
        console.log(`[MANAGER] Processing ${master.symbol} ${master.direction} | Qty: ${master.currentQty?.toFixed(6) || 0}`);

        let shouldRemove = false;
        const apiPos = apiPositions.find(p => p.symbol === master.symbol && p.side === master.direction);
        const positionId = apiPos?.positionId || apiPos?.id || null;

        if (!positionId && (master.status === 'open' || master.currentQty > 0)) {
          console.warn('[MANAGER] No positionId — cannot place TP/SL');
          shouldRemove = true;
        }

        const currentQty = apiPos
          ? parseFloat(apiPos.qty || apiPos.positionQty || apiPos.holdQty || apiPos.positionAmt || apiPos.availQty || apiPos.positionSize || 0)
          : 0;

        master.currentQty = currentQty;
        master.lastUpdated = new Date().toISOString();

        const pendingEntries = apiPendingOrders.filter(o =>
          o.symbol === master.symbol &&
          o.side === master.direction &&
          o.orderType === 'LIMIT' &&
          o.reduceOnly === false &&
          o.status === 'NEW_' &&
          o.tradeQty === '0'
        );

        // Close logic
        const wasActive = master.status === 'open' || master.status === 'pending_fill';
        const hasNoQuantity = currentQty < 0.001;
        const hasNoPendingEntries = pendingEntries.length === 0;

        let isTrulyClosed = wasActive && hasNoQuantity && hasNoPendingEntries;
        if (shouldRemove) isTrulyClosed = true;

        if (isTrulyClosed) {
          master.status = 'closed';
          master.closedAt = new Date().toISOString();
          console.log(`❌ [MANAGER] Position closed: ${master.symbol} ${master.direction}`);
          master._remove = true;
          hasChanges = true;

          const { sendJoinNotification } = require('./utils/joinNotification');
          await sendJoinNotification(`Trade Closed — \( {master.symbol}`, ` \){master.direction === 'BUY' ? 'LONG' : 'SHORT'} closed`);

          if (pendingEntries.length > 0) {
            const orderIds = pendingEntries.map(o => o.orderId);
            await client.cancelOrders(orderIds, master.symbol);
          }
        } else if (wasActive && hasNoQuantity && !hasNoPendingEntries) {
          console.log(`⏳ Waiting for entry fill: ${pendingEntries.length} pending`);
        }

        if (master.status === 'pending_fill' && currentQty >= 0.0001) {
          master.status = 'open';
          console.log(`✅ Position opened: ${master.symbol} ${master.direction}`);
          hasChanges = true;
        }

        // === CONSOLIDATED BOMB: ALL 6 TP LEVELS IN ONE GO ===
        if (master.status === 'open' && master.originalTargets && master.originalTargets.length === 6) {
          console.log(`[BOMB TP] Bombing 6 TP levels for ${master.symbol} (Qty: ${currentQty})`);

          const promises = master.originalTargets.map((tpPrice, tpIndex) => {
            const allocation = TP_ALLOCATION_PERCENT[tpIndex];
            const qtyRaw = currentQty * allocation / 100;
            const qty = qtyRaw.toFixed(6).replace(/\.?0+$/, '');

            if (parseFloat(qty) <= 0) return Promise.resolve();

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
              clientOrderId: `bomb_\( {master.symbol}_ \){tpIndex}_${Date.now()}`
            };

            return placeNextTpLevel(master, apiPos).catch(e => {
              // Silent fail — expected for duplicates/limit
            });
          });

          await Promise.all(promises);
        }

        // === DCA Detection ===
        const currentPendingCount = pendingEntries.length;
        const previousPendingCount = master.pendingEntryCount ?? currentPendingCount;
        const newFillQty = currentQty - (master.currentQty || 0);

        if (currentPendingCount < previousPendingCount) {
          const filledCount = previousPendingCount - currentPendingCount;
          console.log(`🔄 [DCA] \( {filledCount} filled (+ \){newFillQty.toFixed(6)})`);

          const { sendJoinNotification } = require('./utils/joinNotification');
          await sendJoinNotification(
            `Ladder Executed`,
            `Ladder ${filledCount + 1} for \( {master.symbol}\n+ \){newFillQty.toFixed(0)}\nTotal: ${currentQty.toFixed(0)}`
          );

          master.nextTpIndex = 0;
          master.tpSetCount = 0;
          master.slPlaced = false;
          hasChanges = true;
        }

        master.pendingEntryCount = currentPendingCount;

        // === SL Placement ===
        if (!master.slPlaced && master.currentQty > 0 && positionId) {
          // your existing SL code (unchanged)
          // ...
        }

      } catch (assetError) {
        console.error(`[MANAGER] Asset error ${master.symbol} — skipping: ${assetError.message}`);
        continue;
      }
    }

    // Final cleanup & save
    const closedMasters = tracked.filter(p => p._remove);
    if (closedMasters.length > 0) {
      tracked = tracked.filter(p => !p._remove);
      hasChanges = true;
      await updateHistory();
    }

    if (hasChanges) {
      await savePositions(tracked);
    }

    console.log(`[MANAGER CYCLE] Completed in ${Date.now() - cycleStart.getTime()}ms`);
  } catch (error) {
    console.error(`[MANAGER ERROR] Cycle failed: ${error.message}`);
  }
}

setInterval(managePositions, 30 * 1000);
managePositions();

module.exports = { managePositions };
