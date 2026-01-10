// utils/bitunixClient.js - 100% MATCHES YOUR WORKING STANDALONE SCRIPT

const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://fapi.bitunix.com';
this.symbolPrecisionCache = {};

class BitunixClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async getSymbolPrecision(symbol) {
  if (this.symbolPrecisionCache[symbol]) {
    return this.symbolPrecisionCache[symbol];
  }

  try {
    const data = await this.signedRequest('GET', '/api/v1/futures/market/trading_pairs', { symbols: symbol });
    if (data && data.length > 0) {
      const precision = data[0].quotePrecision || 2;  // fallback to 2
      this.symbolPrecisionCache[symbol] = precision;
      console.log(`Fetched precision for ${symbol}: ${precision} decimals`);
      return precision;
    }
  } catch (e) {
    console.error(`Failed to fetch precision for ${symbol}:`, e.message);
  }

  // Fallback
  this.symbolPrecisionCache[symbol] = 4;
  return 4;
}

  async signedRequest(method, path, params = {}, body = null) {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const queryString = new URLSearchParams(params).toString();
    const queryParams = queryString ? '?' + queryString : '';

    // CRITICAL: signQueryString WITHOUT the '?' (exact from your script)
    const signQueryString = queryString;

    const bodyStr = body ? JSON.stringify(body) : '';

    // EXACT DIGEST FROM YOUR WORKING SCRIPT
    const digestInput = nonce + timestamp + this.apiKey + signQueryString + bodyStr;
    const digest = crypto.createHash('sha256').update(digestInput).digest('hex');
    const sign = crypto.createHash('sha256').update(digest + this.apiSecret).digest('hex');

    const url = `${BASE_URL}${path}${queryParams}`;

    const headers = {
      'api-key': this.apiKey,
      'timestamp': timestamp,
      'nonce': nonce,
      'sign': sign,
      'Content-Type': 'application/json',
      'language': 'en-US'
    };

    try {
      const response = await axios({
        method,
        url,
        headers,
        data: bodyStr || undefined,
        timeout: 15000
      });

      if (response.data.code !== 0) {
        console.error('Bitunix API Error:');
        console.error('Code:', response.data.code);
        console.error('Message:', response.data.msg);
        console.error('Full Response:', JSON.stringify(response.data, null, 2));
        throw new Error(response.data.msg || 'API error');
      }

      return response.data.data;
    } catch (error) {
      if (error.response) {
        console.error('Bitunix Request Failed:');
        console.error('Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('Network error:', error.message);
      }
      throw error;
    }
  }

  async cancelOrders(orderIds, symbol) {
  if (orderIds.length === 0) return true;

  console.log(`[CANCEL ORDERS] Batch canceling ${orderIds.length} order(s) for ${symbol}`);

  const orderList = orderIds.map(id => ({ orderId: id.toString() }));

  const body = {
    symbol,
    orderList
  };

  try {
    const result = await this.signedRequest('POST', '/api/v1/futures/trade/cancel_orders', {}, body);

    if (result && result.successList) {
      const successCount = result.successList.length;
      const failCount = result.failureList?.length || 0;

      console.log(`✅ [CANCEL ORDERS] Batch success: ${successCount} succeeded, ${failCount} failed`);

      if (failCount > 0) {
        console.warn(`   Failed orders:`, result.failureList);
      }

      return successCount === orderIds.length;
    }

    return false;
  } catch (error) {
    console.error(`❌ [CANCEL ORDERS] Batch failed: ${error.message}`);
    if (error.response?.data) {
      console.error('   API Response:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

  async changeLeverage(symbol, leverage) {
  // Detect if inverse (Coin-M) or linear (USDT-margined)
  const isInverse = symbol.endsWith('USD');  // e.g., ETHUSD, BTCUSD
  const marginCoin = isInverse ? symbol.replace('USD', '') : 'USDT';  // 'ETH' for ETHUSD, 'USDT' for ETHUSDT

  const body = { symbol, leverage, marginCoin };
  return this.signedRequest('POST', '/api/v1/futures/account/change_leverage', {}, body);
}



  async placeOrder(orderParams) {
    const body = {
      reduceOnly: false,
      effect: 'GTC',
      tradeSide: 'OPEN',
      ...orderParams
    };
    return this.signedRequest('POST', '/api/v1/futures/trade/place_order', {}, body);
  }

  async getAccountOverview() {
    return this.signedRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
  }

}

module.exports = BitunixClient;