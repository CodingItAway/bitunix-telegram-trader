// utils/closeRunningTrade.js - FINAL: No fallback, only bot-managed trades using stored positionId

require('dotenv').config();
const { loadPositions } = require('../storage/googleDriveStorage');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

const client = require('../utils/openNewPositions'); // your BitunixClient with flashClosePosition method

/**
 * Close a single symbol using ONLY the local master record (no fallback)
 */
async function closeRunningTrade(symbol) {
  if (!symbol) {
    return { success: false, message: 'Symbol required' };
  }

  console.log(`[CLOSE] Attempting to close ${symbol} (bot-managed only)`);

  try {
    // Load local positions — source of truth
    const positions = await loadPositions();
    const master = positions.find(p => p.isMaster && p.symbol === symbol && p.status === 'open');

    if (!master) {
      return { success: false, message: `No bot-managed open position found for ${symbol}` };
    }

    if (!master.positionId) {
      return { success: false, message: `No positionId stored for ${symbol}` };
    }

    // Flash close using stored positionId — fastest and most reliable
    await client.flashClosePosition({
      positionId: master.positionId.toString()
    });

    console.log(`[CLOSE] Successfully flash closed ${symbol} using positionId ${master.positionId}`);
    return { success: true, positionId: master.positionId, message: `Closed ${symbol}` };

  } catch (error) {
    console.error(`[CLOSE] Failed to close ${symbol}: ${error.message}`);
    return { success: false, message: error.message };
  }
}

/**
 * Close ALL bot-managed open positions
 */
async function closeAllPositions() {
  console.log('[CLOSE ALL] Starting emergency close of all bot-managed positions');

  try {
    const positions = await loadPositions();
    const openMasters = positions.filter(p => p.isMaster && p.status === 'open');

    if (openMasters.length === 0) {
      return { success: true, closedQty: 0, message: 'No bot-managed positions to close' };
    }

    let totalClosed = 0;
    const details = {};

    for (const master of openMasters) {
      const result = await closeRunningTrade(master.symbol);
      details[master.symbol] = result;
      if (result.success) totalClosed++;
      await new Promise(r => setTimeout(r, 200)); // rate safety
    }

    const allSuccess = totalClosed === openMasters.length;

    return {
      success: allSuccess,
      closedQty: totalClosed,
      details,
      message: allSuccess
        ? `EMERGENCY CLOSE COMPLETE: ${totalClosed} positions closed`
        : `Emergency close partial: ${totalClosed}/${openMasters.length} closed`
    };

  } catch (error) {
    console.error(`[CLOSE ALL] Fatal error: ${error.message}`);
    return { success: false, closedQty: 0, message: error.message };
  }
}

/**
 * Batch close multiple symbols (only bot-managed)
 */
async function batchClosePositions(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { success: false, message: 'Provide array of symbols' };
  }

  console.log(`[BATCH CLOSE] Closing ${symbols.length} symbols: ${symbols.join(', ')}`);

  const results = [];
  for (const sym of symbols) {
    const result = await closeRunningTrade(sym);
    results.push({ symbol: sym, ...result });
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  const successful = results.filter(r => r.success);
  console.log(`[BATCH CLOSE] Complete: ${successful.length}/${symbols.length} successful`);

  return results;
}

module.exports = {
  closeRunningTrade,
  closeAllPositions,
  batchClosePositions
};