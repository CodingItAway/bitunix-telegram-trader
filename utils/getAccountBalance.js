// utils/getAccountBalance.js
// Fixed & accurate version using real Bitunix response fields

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error('BITUNIX_API_KEY and BITUNIX_API_SECRET must be set in .env');
}

async function signedGet(endpoint, params = {}) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  // Sort params alphabetically (no = or ? in signature)
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}${params[key]}`)
    .join('');

  const queryString = new URLSearchParams(params).toString();
  const queryParams = queryString ? '?' + queryString : '';

  // Signature: nonce + timestamp + apiKey + sortedParams + body (empty)
  const digestInput = nonce + timestamp + API_KEY + sortedParams;
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + API_SECRET).toString();

  const url = API_BASE + endpoint + queryParams;

  const headers = {
    'api-key': API_KEY,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  try {
    const response = await fetch(url, { method: 'GET', headers });
    const data = await response.json();

    if (data.code !== 0) {
      console.error('[getAccountBalance] API Error:', data.code, data.msg);
      return null;
    }

    return data.data;
  } catch (err) {
    console.error('[getAccountBalance] Network error:', err.message);
    return null;
  }
}

async function getCurrentEquity() {
  const account = await signedGet('/api/v1/futures/account', { marginCoin: 'USDT' });

  if (!account) {
    console.log('[EQUITY] Failed to fetch account data');
    return 0;
  }

  const available = parseFloat(account.available || 0);
  const margin = parseFloat(account.margin || 0);
  const unrealizedPnl = parseFloat(account.crossUnrealizedPNL || account.isolationUnrealizedPNL || 0);

  const totalEquity = available + margin + unrealizedPnl;

  console.log('[EQUITY] Bitunix Futures Account Summary');
  console.log('────────────────────────────────────');
  console.log(`Available Balance : $${available.toFixed(2)} USDT`);
  console.log(`Position Margin   : $${margin.toFixed(2)} USDT`);
  console.log(`Unrealized PnL    : $${unrealizedPnl.toFixed(2)} USDT`);
  console.log(`Total Equity      : $${totalEquity.toFixed(2)} USDT`);
  console.log('────────────────────────────────────');

  return totalEquity;
}

module.exports = { getCurrentEquity };

// Optional: Run directly if file is executed
if (require.main === module) {
  getCurrentEquity();
}