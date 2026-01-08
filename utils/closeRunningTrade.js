// utils/closeRunningTrade.js - FINAL WORKING VERSION (Fixed signature for POST requests)

require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('node:crypto');
const { loadPositions } = require('../storage/googleDriveStorage');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error('BITUNIX_API_KEY and BITUNIX_API_SECRET must be set in .env');
}

/**
 * Signed POST request with CORRECT body inclusion in signature (Bitunix requirement)
 */
async function signedPost(endpoint, bodyObj = {}) {
  // Canonical JSON string: no whitespace, sorted keys implicitly via JSON.stringify
  const bodyStr = JSON.stringify(bodyObj, null, 0); // equivalent to separators=(',', ':')

  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex'); // 32-char hex

  // Critical: Include exact bodyStr in digest
  const digestInput = nonce + timestamp + API_KEY + bodyStr;
  const digest = crypto.createHash('sha256').update(digestInput).digest('hex');
  const sign = crypto.createHash('sha256').update(digest + API_SECRET).digest('hex');

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
      body: bodyStr
    });

    const data = await response.json();

    if (data.code !== '0' && data.code !== 0) {
      throw new Error(`API Error ${data.code}: ${data.msg || 'Unknown error'}`);
    }

    return { success: true, data: data.data || data, raw: data };
  } catch (err) {
    console.error(`[CLOSE API] Request failed for ${endpoint}: ${err.message}`);
    throw err;
  }
}

/**
 * Close all positions for a single symbol (official Bitunix method)
 */
async function closeRunningTrade(symbol) {
  if (!symbol) {
    return { success: false, message: 'Symbol required' };
  }

  const upperSymbol = symbol.toUpperCase();
  console.log(`[CLOSE] Closing all positions for ${upperSymbol}...`);

  try {
    const result = await signedPost('/api/v1/futures/trade/close_all_position', {
      symbol: upperSymbol
    });

    console.log(`[CLOSE] ✅ Successfully closed all positions for ${upperSymbol}`);
    return {
      success: true,
      method: 'symbol_close',
      symbol: upperSymbol,
      message: `Closed all positions for ${upperSymbol}`
    };

  } catch (error) {
    console.error(`[CLOSE] ❌ Failed to close ${upperSymbol}: ${error.message}`);

    // Optional: Check if bot thinks it has a position (for better logging)
    try {
      const positions = await loadPositions();
      const master = positions.find(p => p.isMaster && p.symbol === upperSymbol && p.status === 'open');
      if (master) {
        console.log(`[CLOSE] Local record exists for ${upperSymbol}, but API close failed.`);
      }
    } catch (_) {
      // Ignore storage errors
    }

    return { success: false, symbol: upperSymbol, message: error.message };
  }
}

/**
 * Close ALL bot-managed open positions (one symbol at a time)
 */
async function closeAllPositions() {
  console.log('[CLOSE ALL] Starting emergency close of all bot-managed positions');

  try {
    const positions = await loadPositions();
    const openMasters = positions.filter(p => p.isMaster && p.status === 'open');

    if (openMasters.length === 0) {
      console.log('[CLOSE ALL] No open bot-managed positions found');
      return { success: true, closedQty: 0, message: 'No open positions to close' };
    }

    const uniqueSymbols = [...new Set(openMasters.map(p => p.symbol))];
    console.log(`[CLOSE ALL] Found ${uniqueSymbols.length} unique symbol(s): ${uniqueSymbols.join(', ')}`);

    let closedCount = 0;
    const details = {};

    for (const sym of uniqueSymbols) {
      const result = await closeRunningTrade(sym);
      details[sym] = result;
      if (result.success) closedCount++;
      await new Promise(r => setTimeout(r, 300)); // Rate safety
    }

    const allSuccess = closedCount === uniqueSymbols.length;

    console.log(allSuccess
      ? `[CLOSE ALL] ✅ EMERGENCY CLOSE COMPLETE: ${closedCount} symbols closed`
      : `[CLOSE ALL] ⚠️ Partial close: ${closedCount}/${uniqueSymbols.length} successful`
    );

    return {
      success: allSuccess,
      closedQty: closedCount,
      totalSymbols: uniqueSymbols.length,
      details,
      message: allSuccess ? 'All positions closed' : 'Some positions failed to close'
    };

  } catch (error) {
    console.error(`[CLOSE ALL] Fatal error: ${error.message}`);
    return { success: false, closedQty: 0, message: error.message };
  }
}

/**
 * Batch close specific symbols
 */
async function batchClosePositions(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { success: false, message: 'Provide non-empty array of symbols' };
  }

  const normalized = symbols.map(s => s.toUpperCase());
  console.log(`[BATCH CLOSE] Closing ${normalized.length} symbols: ${normalized.join(', ')}`);

  const results = [];
  for (const sym of normalized) {
    const result = await closeRunningTrade(sym);
    results.push({ symbol: sym, ...result });
    await new Promise(r => setTimeout(r, 300));
  }

  const successful = results.filter(r => r.success).length;
  console.log(`[BATCH CLOSE] Complete: ${successful}/${normalized.length} closed`);

  return results;
}

module.exports = {
  closeRunningTrade,
  closeAllPositions,
  batchClosePositions
};