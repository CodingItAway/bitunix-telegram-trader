// utils/symbolValidator.js

const axios = require('axios');
const BASE_URL = 'https://fapi.bitunix.com';

let symbolCache = [];
let lastRefresh = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function refreshSymbols() {
  try {
    const response = await axios.get(`${BASE_URL}/api/v1/futures/market/tickers`, { timeout: 10000 });
    if (response.data.code !== 0) throw new Error(response.data.msg || 'API error');

    const allSymbols = response.data.data.map(t => t.symbol);
    symbolCache = allSymbols.filter(sym => sym.endsWith('USDT')); // Only USDT perpetuals
    lastRefresh = Date.now();
    console.log(`[SYMBOL VALIDATOR] Refreshed ${symbolCache.length} USDT perpetual symbols`);
  } catch (error) {
    console.error('[SYMBOL VALIDATOR] Failed to refresh symbols:', error.message);
    // Keep old cache on failure
  }
}

async function getValidSymbol(requestedBase) {
  const now = Date.now();
  if (!lastRefresh || now - lastRefresh > CACHE_DURATION) {
    await refreshSymbols();
  }
  if (symbolCache.length === 0) {
    await refreshSymbols(); // Force refresh if empty
  }

  const baseUpper = requestedBase.toUpperCase();

  // Priority 1: Exact match (e.g., BONKUSDT)
  let symbol = `${baseUpper}USDT`;
  if (symbolCache.includes(symbol)) {
    console.log(`[SYMBOL VALIDATOR] Exact match found: ${symbol}`);
    return symbol;
  }

  // Priority 2: 1000 multiplier (most common for meme coins)
  symbol = `1000${baseUpper}USDT`;
  if (symbolCache.includes(symbol)) {
    console.log(`[SYMBOL VALIDATOR] Fallback to 1000x multiplier: ${symbol}`);
    return symbol;
  }

  // Priority 3: 1000000 multiplier (rare, but check just in case)
  symbol = `1000000${baseUpper}USDT`;
  if (symbolCache.includes(symbol)) {
    console.log(`[SYMBOL VALIDATOR] Fallback to 1000000x multiplier: ${symbol}`);
    return symbol;
  }

  console.log(`[SYMBOL VALIDATOR] No valid symbol found for base ${baseUpper}`);
  return null;
}

module.exports = { getValidSymbol };