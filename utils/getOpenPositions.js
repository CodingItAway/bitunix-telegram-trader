// utils/getOpenPositions.js
// Reusable module to fetch all open positions from Bitunix Futures
// Works exactly like getPendingOrders.js but for positions

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
  const data = await response.json();
  
  if (data.code === 0) {
    return data.data?.positionList || data.data || []; // Return array of positions
  } else {
    console.warn(`[getOpenPositions] API error: ${data.msg || 'Unknown'} (code ${data.code})`);
    return [];
  }
}

async function getOpenPositions() {
  return await signedGet('/api/v1/futures/position/get_pending_positions');
}

module.exports = { getOpenPositions };