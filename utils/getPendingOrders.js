// utils/getPendingOrders.js  (or keep in root)

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://fapi.bitunix.com';

async function signedGet(endpoint, params = {}) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  const queryString = new URLSearchParams(params).toString();
  const queryParams = queryString ? '?' + queryString : '';

  const digestInput = nonce + timestamp + process.env.BITUNIX_API_KEY + queryParams + '';
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + process.env.BITUNIX_API_SECRET).toString();

  const url = API_BASE + endpoint + queryParams;

  const headers = {
    'api-key': process.env.BITUNIX_API_KEY,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  const response = await fetch(url, { method: 'GET', headers });
  return await response.json();
}

async function getPendingOrders(symbol = null) {
  const params = symbol ? { symbol } : {};
  const data = await signedGet('/api/v1/futures/trade/get_pending_orders', params);

  if (data.code === 0) {
    return data.data?.orderList || [];
  } else {
    console.warn(`[getPendingOrders] API error: ${data.msg || 'Unknown'} (code ${data.code})`);
    return [];
  }
}

module.exports = { getPendingOrders };