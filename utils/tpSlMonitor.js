// utils/priceMonitor.js - Real-time TP/SL monitoring via WS last price ('la')

const WebSocket = require('ws');
const BitunixClient = require('./openNewPositions'); // Your existing client
const { loadPositions, savePositions } = require('../storage/mongoStorage');
const { sendJoinNotification } = require('./joinNotification');
const { logSignal } = require('./signalAuditor');
require('dotenv').config();

const WS_URL = 'wss://fapi.bitunix.com/public/';
const RECONNECT_DELAY = 5000; // ms
const TRIGGER_DEBOUNCE = 5000; // ms to avoid rapid triggers
const TP_ALLOCATION_PERCENT = [30, 30, 20, 10, 5, 5];
let ws = null;
let activeSymbols = new Set(); // Dynamic list of symbols to subscribe
let positions = []; // Cached masters (reload on changes)
let lastTriggerTimes = new Map(); // positionId → timestamp for debounce

const client = new BitunixClient(process.env.BITUNIX_API_KEY, process.env.BITUNIX_API_SECRET);

// Connect and subscribe
function connectWs() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[PRICE MONITOR] WS Connected');
    subscribeToSymbols();
  });

  ws.on('message', handleMessage);

  ws.on('close', () => {
    console.log('[PRICE MONITOR] WS Closed — Reconnecting in 5s...');
    setTimeout(connectWs, RECONNECT_DELAY);
  });

  ws.on('error', err => console.error('[PRICE MONITOR] WS Error:', err.message));
}

// Dynamic subscribe (only active symbols)
function subscribeToSymbols() {
  if (ws.readyState !== WebSocket.OPEN) return;

  const subs = Array.from(activeSymbols).map(symbol => ({ ch: 'ticker', symbol }));
  if (subs.length === 0) return;

  const payload = { op: 'subscribe', args: subs };
  ws.send(JSON.stringify(payload));
  console.log(`[PRICE MONITOR] Subscribed to ${subs.length} symbols`);
}

// Handle incoming ticker (check TP/SL)
async function handleMessage(data) {
  const msg = JSON.parse(data.toString());
  if (msg.ch !== 'ticker' || !msg.data || !msg.symbol) return;

  const lastPrice = parseFloat(msg.data.la);
  console.log(`[MONITOR] ${msg.symbol} Last Price: ${lastPrice}`);

  // Filter positions for this symbol
  const relevantPositions = positions.filter(p => p.symbol === msg.symbol && p.status === 'open' && p.currentQty > 0);

  for (const pos of relevantPositions) {
    const now = Date.now();
    const lastTrigger = lastTriggerTimes.get(pos._id) || 0; // Assume positions have unique _id from Mongo
    if (now - lastTrigger < TRIGGER_DEBOUNCE) continue; // Debounce

    const isLong = pos.direction === 'BUY';
    const nextTp = pos.originalTargets[pos.nextTpIndex];
    const allocationPct = TP_ALLOCATION_PERCENT[pos.nextTpIndex] || 0;
    const partialQty = Math.floor(pos.currentQty * (allocationPct / 100)); // Or your precise calc

    // TP Check
    if (nextTp && 
        ((isLong && lastPrice >= nextTp) || (!isLong && lastPrice <= nextTp)) &&
        partialQty > 0
    ) {
      console.log(`[TP HIT] ${pos.symbol} TP${pos.nextTpIndex + 1} @ ${lastPrice} (target: ${nextTp})`);
      lastTriggerTimes.set(pos._id, now);
      await triggerPartialClose(pos, partialQty, 'TP');
    }

    // SL Check
    if (pos.sl && 
        ((isLong && lastPrice <= pos.sl) || (!isLong && lastPrice >= pos.sl))
    ) {
      console.log(`[SL HIT] ${pos.symbol} @ ${lastPrice}`);
      lastTriggerTimes.set(pos._id, now);
      await triggerFullClose(pos, 'SL');
    }
  }
}

// Place partial reduce-only market order
async function triggerPartialClose(pos, qty, type) {
  try {
    const orderParams = {
      symbol: pos.symbol,
      side: pos.direction === 'BUY' ? 'SELL' : 'BUY', // Opposite for close
      type: 'MARKET',
      qty,
      reduceOnly: true,
      tradeSide: 'CLOSE'
    };
    const result = await client.placeOrder(orderParams);

    if (result.success) { // Adjust based on your client's response
      pos.currentQty -= qty;
      pos.allocatedTpQty[pos.nextTpIndex] += qty;
      pos.tpSetCount++;
      pos.nextTpIndex++;
      pos.lastUpdated = new Date().toISOString();

      await savePositions(positions); // Save updated
      sendJoinNotification('TP Hit', `${pos.symbol} ${type} closed ${qty} @ ${result.price || 'market'}`);
      logSignal({ symbol: pos.symbol }, 'tp_hit', { details: `Index ${pos.nextTpIndex}` });
    }
  } catch (err) {
    console.error('[TP CLOSE ERROR]', err);
  }
}

// Place full reduce-only market order
async function triggerFullClose(pos, type) {
  try {
    const qty = pos.currentQty; // Full remaining
    const orderParams = {
      symbol: pos.symbol,
      side: pos.direction === 'BUY' ? 'SELL' : 'BUY',
      type: 'MARKET',
      qty,
      reduceOnly: true,
      tradeSide: 'CLOSE'
    };
    const result = await client.placeOrder(orderParams);

    if (result.success) {
      pos.currentQty = 0;
      pos.status = 'closed';
      pos.lastUpdated = new Date().toISOString();

      await savePositions(positions); // Will be cleaned up in positionManager
      sendJoinNotification(`${type} Hit`, `${pos.symbol} fully closed @ ${result.price || 'market'}`);
      logSignal({ symbol: pos.symbol }, `${type.toLowerCase()}_hit`, {});
    }
  } catch (err) {
    console.error(`[${type} CLOSE ERROR]`, err);
  }
}

// Public functions for integration
async function startMonitor() {
  connectWs();
  positions = await loadPositions(); // Initial load
  updateActiveSymbols();
}

function updateActiveSymbols() {
  activeSymbols.clear();
  positions.forEach(p => {
    if (p.status === 'open' && p.currentQty > 0) activeSymbols.add(p.symbol);
  });
  subscribeToSymbols(); // Resubscribe if WS open
}

function addSymbol(symbol) {
  activeSymbols.add(symbol);
  subscribeToSymbols();
}

function removeSymbol(symbol) {
  activeSymbols.delete(symbol);
  // Optional: Unsubscribe if needed, but Bitunix WS auto-handles
}

module.exports = { startMonitor, updateActiveSymbols, addSymbol, removeSymbol };