// utils/closeRunningTrade.js - FINAL VERSION with all functions (Bitunix-compatible)

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

async function signedPost(endpoint, bodyParams = {}) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  const bodyStr = JSON.stringify(bodyParams);

  const digestInput = nonce + timestamp + API_KEY + '' + bodyStr;
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + API_SECRET).toString();

  const url = API_BASE + endpoint;

  const headers = {
    'api-key': API_KEY,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  try {
    const response = await fetch(url, { method: 'POST', headers, body: bodyStr });
    const data = await response.json();

    if (data.code !== 0) {
      console.error(`[CLOSE TRADE] API Error ${data.code}: ${data.msg || 'Unknown'}`);
      throw new Error(data.msg || 'API error');
    }

    return data.data;
  } catch (error) {
    console.error(`[CLOSE TRADE] Request failed: ${error.message}`);
    throw error;
  }
}

/**
 * Close a single position (or all for a symbol)
 */
async function closeRunningTrade(symbol, direction = null) { // direction: 'LONG' or 'SHORT' or null
  console.log(`\n🔴 [CLOSE TRADE] Initiating market close for ${symbol}${direction ? ` (${direction})` : ''}`);

  if (!symbol) throw new Error('Symbol required');

  try {
    const { getOpenPositions } = require('./getOpenPositions');
    const positions = await getOpenPositions();

    const targetPositions = positions.filter(pos =>
      pos.symbol === symbol &&
      (!direction || pos.side === direction)
    );

    if (targetPositions.length === 0) {
      console.log(`[CLOSE TRADE] No open positions found for ${symbol}`);
      return { success: true, closedQty: 0, message: 'No positions to close' };
    }

    console.log(`[CLOSE TRADE] Found ${targetPositions.length} position(s) to close`);
    let totalClosed = 0;
    let results = [];

    for (const pos of targetPositions) {
      const qty = parseFloat(pos.qty || 0);
      if (qty <= 0) continue;

      const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';

      console.log(`   → Closing ${pos.side} ${pos.symbol} | Qty: ${qty} | Entry: ${pos.avgOpenPrice || 'N/A'}`);

      const closeParams = {
        symbol: pos.symbol,
        side: closeSide,
        qty: qty.toFixed(8).replace(/\.?0+$/, ''),
        orderType: 'MARKET',
        tradeSide: 'CLOSE',
        reduceOnly: true,
        effect: 'IOC'
      };

      if (pos.positionId) closeParams.positionId = pos.positionId.toString();

      try {
        const result = await signedPost('/api/v1/futures/trade/place_order', closeParams);
        console.log(`✅ Closed ${qty} contracts (Order ID: ${result.orderId || 'N/A'})`);
        totalClosed += qty;
        results.push({ status: 'success', qty });
      } catch (err) {
        console.error(`❌ Failed to close ${pos.side} ${pos.symbol}: ${err.message}`);
        results.push({ status: 'failed', error: err.message });
      }
    }

    const allSuccess = results.every(r => r.status === 'success');
    return {
      success: allSuccess,
      closedQty: totalClosed,
      message: allSuccess
        ? `Successfully closed ${totalClosed} contracts`
        : `Closed ${totalClosed} contracts with some failures`
    };

  } catch (error) {
    console.error(`[CLOSE TRADE] Fatal error: ${error.message}`);
    return { success: false, closedQty: 0, message: error.message };
  }
}

/**
 * Emergency: Close ALL open positions across all symbols
 */
async function closeAllPositions() {
  console.warn('\n🚨 [EMERGENCY CLOSE ALL] Closing EVERY open position on the account...');

  try {
    const { getOpenPositions } = require('./getOpenPositions');
    const positions = await getOpenPositions();

    if (positions.length === 0) {
      console.log('[CLOSE ALL] No open positions found');
      return { success: true, closedQty: 0, message: 'No positions to close' };
    }

    console.log(`[CLOSE ALL] Found ${positions.length} open positions`);

    let totalClosed = 0;
    let symbolResults = {};

    // Group by symbol to avoid rate limits and log cleanly
    const symbols = [...new Set(positions.map(p => p.symbol))];

    for (const sym of symbols) {
      console.log(`\n→ Closing all positions for ${sym}`);
      const result = await closeRunningTrade(sym);
      symbolResults[sym] = result;
      if (result.success) totalClosed += result.closedQty;

      // Small delay between symbols to be gentle on API
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const allSuccess = Object.values(symbolResults).every(r => r.success);

    return {
      success: allSuccess,
      closedQty: totalClosed,
      details: symbolResults,
      message: allSuccess
        ? `EMERGENCY CLOSE COMPLETE: ${totalClosed} contracts closed`
        : `Emergency close partial: ${totalClosed} contracts closed`
    };

  } catch (error) {
    console.error(`[CLOSE ALL] Fatal error: ${error.message}`);
    return { success: false, closedQty: 0, message: error.message };
  }
}

/**
 * Batch close multiple symbols
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
    await new Promise(resolve => setTimeout(resolve, 300)); // rate limit safety
  }

  const successful = results.filter(r => r.success);
  console.log(`[BATCH CLOSE] Complete: ${successful.length}/${symbols.length} successful`);

  return results;
}

// Export everything
module.exports = {
  closeRunningTrade,
  closeAllPositions,
  batchClosePositions
};