// utils/closeRunningTrade.js - UPDATED: Close by SYMBOL directly (no positionId needed)

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');
const { loadPositions } = require('../storage/googleDriveStorage');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error('BITUNIX_API_KEY and BITUNIX_API_SECRET must be set in .env');
}

// Reusable signed POST request (for closing)
async function signedPost(endpoint, body = {}) {
  const timestamp = Date.now();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  // Sort params and concat keyvalue (no =)
  const sortedParams = Object.keys(body)
    .sort()
    .map(key => `${key}${body[key] || ''}`)
    .join('');

  const bodyStr = ''; // POST body is sent separately, signature uses empty body string
  const digestInput = nonce + timestamp + API_KEY + sortedParams + bodyStr;
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + API_SECRET).toString();

  const url = `${API_BASE}${endpoint}`;

  const headers = {
    'api-key': API_KEY,
    'nonce': nonce,
    'timestamp': timestamp.toString(),
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.code !== '0' && data.code !== 0) {
      throw new Error(`API Error ${data.code}: ${data.msg || 'Unknown'}`);
    }

    return { success: true, data: data.data || data };
  } catch (err) {
    console.error(`[CLOSE API] Request failed: ${err.message}`);
    throw err;
  }
}

/**
 * Close a single position using SYMBOL (official Bitunix method)
 */
async function closeRunningTrade(symbol) {
  if (!symbol) {
    return { success: false, message: 'Symbol required' };
  }

  const upperSymbol = symbol.toUpperCase();
  console.log(`[CLOSE] Attempting to close all positions for ${upperSymbol}`);

  try {
    // First: Try direct symbol-based close (works regardless of positionId)
    const result = await signedPost('/api/v1/futures/trade/close_all_position', {
      symbol: upperSymbol
    });

    console.log(`[CLOSE] Successfully closed ${upperSymbol} via symbol-based API`);
    return { success: true, method: 'symbol_close', message: `Closed all positions for ${upperSymbol}` };

  } catch (error) {
    console.error(`[CLOSE] Failed to close ${upperSymbol}: ${error.message}`);

    // Optional: Fallback check if position exists locally (for logging)
    try {
      const positions = await loadPositions();
      const master = positions.find(p => p.isMaster && p.symbol === upperSymbol && p.status === 'open');
      if (!master) {
        return { success: false, message: `No open position found for ${upperSymbol} (and API close failed)` };
      }
    } catch (_) {
      // Ignore storage errors
    }

    return { success: false, message: error.message };
  }
}

/**
 * Close ALL open bot-managed positions (using symbol-based close)
 */
async function closeAllPositions() {
  console.log('[CLOSE ALL] Starting emergency close of all positions (symbol-based)');

  try {
    const positions = await loadPositions();
    const openMasters = positions.filter(p => p.isMaster && p.status === 'open');

    if (openMasters.length === 0) {
      console.log('[CLOSE ALL] No bot-managed positions found');
      return { success: true, closedQty: 0, message: 'No open positions to close' };
    }

    const uniqueSymbols = [...new Set(openMasters.map(p => p.symbol))];
    console.log(`[CLOSE ALL] Found ${uniqueSymbols.length} unique symbols to close: ${uniqueSymbols.join(', ')}`);

    let totalClosed = 0;
    const details = {};

    for (const sym of uniqueSymbols) {
      const result = await closeRunningTrade(sym);
      details[sym] = result;
      if (result.success) totalClosed++;
      await new Promise(r => setTimeout(r, 300)); // Rate limit safety
    }

    const allSuccess = totalClosed === uniqueSymbols.length;

    return {
      success: allSuccess,
      closedQty: totalClosed,
      totalSymbols: uniqueSymbols.length,
      details,
      message: allSuccess
        ? `EMERGENCY CLOSE COMPLETE: All ${totalClosed} symbols closed`
        : `Partial close: ${totalClosed}/${uniqueSymbols.length} symbols closed`
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
    return { success: false, message: 'Provide non-empty array of symbols' };
  }

  console.log(`[BATCH CLOSE] Closing ${symbols.length} symbols: ${symbols.join(', ')}`);

  const results = [];
  for (const sym of symbols) {
    const result = await closeRunningTrade(sym);
    results.push({ symbol: sym, ...result });
    await new Promise(r => setTimeout(r, 300));
  }

  const successful = results.filter(r => r.success).length;
  console.log(`[BATCH CLOSE] Complete: ${successful}/${symbols.length} successful`);

  return results;
}

module.exports = {
  closeRunningTrade,
  closeAllPositions,
  batchClosePositions
};