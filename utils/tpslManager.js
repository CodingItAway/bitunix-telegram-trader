// utils/tpslManager.js - Standalone TP/SL placement (no BitunixClient dependency)

require('dotenv').config();
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://fapi.bitunix.com';
const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;

const TP_ALLOCATION_PERCENT = [30, 30, 20, 10, 5, 5];

async function signedPost(path, bodyParams) {
  const timestamp = Date.now().toString();
  const nonce = CryptoJS.lib.WordArray.random(16).toString();

  const queryString = ''; // No query params for POST
  const bodyStr = JSON.stringify(bodyParams);

  // Same signing logic as getPendingOrders
  const digestInput = nonce + timestamp + API_KEY + queryString + bodyStr;
  const digest = CryptoJS.SHA256(digestInput).toString();
  const sign = CryptoJS.SHA256(digest + API_SECRET).toString();

  const url = API_BASE + path;

  const headers = {
    'api-key': API_KEY,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyStr
  });

  const data = await response.json();

  if (data.code !== 0) {
    console.error('[TPSL] API Error:', data.msg || 'Unknown error', '(code', data.code, ')');
    throw new Error(data.msg || 'TP/SL placement failed');
  }

  return data.data;
}

// utils/tpslManager.js - FIXED for Bitunix TP/SL endpoint

// ... (keep the rest of the file unchanged: imports, signedPost, etc.)

async function placeNextTpLevel(master, apiPos) {  // ← Add apiPos parameter
  if (master.nextTpIndex >= master.originalTargets.length) {
    console.log(`[TPSL] All TPs already set for ${master.symbol} ${master.direction}`);
    return false;
  }

  const tpIndex = master.nextTpIndex;
  const tpPrice = master.originalTargets[tpIndex];
  const allocation = TP_ALLOCATION_PERCENT[tpIndex] || Math.round(100 / (master.originalTargets.length - tpIndex));
  const partialQty = (master.currentQty * allocation / 100).toFixed(6).replace(/\.?0+$/, '');

  console.log(`[TPSL] Attempting to set TP${tpIndex + 1} @ ${tpPrice} (${allocation}%, ${partialQty} qty)`);

  // Extract positionId from the live position data (critical!)
  const positionId = apiPos?.positionId || apiPos?.id || null;
  if (!positionId) {
    console.error('[TPSL] Cannot place TP: positionId not found in API response!');
    return false;
  }

  const tpslParams = {
    symbol: master.symbol,
    positionId: positionId.toString(),           // ← REQUIRED
    tpPrice: tpPrice.toString(),
    tpStopType: 'MARK_PRICE',                    // ← Correct field name, use MARK_PRICE or LAST_PRICE
    tpOrderType: 'LIMIT',
    tpOrderPrice: master.direction === 'BUY'
      ? (tpPrice * 1.001).toFixed(6)             // Slight offset for longs
      : (tpPrice * 0.999).toFixed(6),            // Slight offset for shorts
    tpQty: partialQty,                           // ← Use tpQty, not qty
    // removeOnly: true,                         // ← Not needed here (TP/SL orders are inherently reduce-only)
    // marginCoin, positionMode, marginMode → not required for this endpoint
  };

  try {
    await signedPost('/api/v1/futures/tpsl/place_order', tpslParams);
    console.log(`🎯 [TPSL] TP${tpIndex + 1} successfully set @ ${tpPrice}`);

     // Update allocated qty for this TP level
    // Use the index we just placed (before increment)
     master.allocatedTpQty[tpIndex] = 
    (master.allocatedTpQty[tpIndex] || 0) + parseFloat(partialQty);

    master.nextTpIndex++;
    master.tpSetCount++;
    return true;
  } catch (e) {
    console.error(`❌ [TPSL] Failed to set TP${tpIndex + 1}: ${e.message}`);
    return false;
  }
}

module.exports = { placeNextTpLevel };

module.exports = { placeNextTpLevel };