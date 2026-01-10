// server.js - Final, robust version

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const { loadPositions, savePositions } = require('./storage/mongoStorage');
const { getEquityCurve } = require('./utils/historyManager');
require('./positionManager'); // Auto-starts manager with setInterval
const { parseMrdSignal } = require('./utils/mrdParser');
const { executeTrade } = require('./tradeExecutor'); // adjust path if needed
const { getCurrentEquity, getCurrentMarginUsed } = require('./utils/getAccountBalance');
const { batchClosePositions, closeAllPositions, closeRunningTrade } = require('./utils/closeRunningTrade');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const { getCapitalStatus, acceptRealizedDrawdown, forceAggressiveMode } = require('./utils/equityAllocationManager');
const { connectToDatabase } = require('./db/mongoConnection');


const BASE_URL = 'https://fapi.bitunix.com';

// Global symbol cache
let availableSymbols = [];
global.lastSymbolRefresh = null;

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get capital status for dashboard
app.get('/capital-status', async (req, res) => {
  try {
    const status = await getCapitalStatus();
    res.json(status);
  } catch (err) {
    console.error('Capital status error:', err);
    res.status(500).json({});
  }
});

// User accepts drawdown
app.post('/accept-drawdown', async (req, res) => {
  await acceptRealizedDrawdown();
  res.json({ success: true });
});

// User forces aggressive
app.post('/force-aggressive', async (req, res) => {
  await forceAggressiveMode();
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// API: Get current positions (safe)
app.get('/positions', async (req, res) => {
  try {
    const positions = await loadPositions();
    // Only send master records to UI
    const masters = positions.filter(p => p.isMaster);
    res.json(masters);
  } catch (err) {
    console.error('Error serving /positions:', err.message);
    res.status(500).json([]);
  }
});

// API: Get symbol list
app.get('/symbols', (req, res) => {
  res.json({
    symbols: availableSymbols,
    count: availableSymbols.length,
    lastRefresh: global.lastSymbolRefresh
  });
});

// NEW: In-memory toggle
app.post('/toggle-tp-sl', (req, res) => {
  const { disabled } = req.body;
  const { setTpSlDisabled } = require('./utils/tpSlControl');
  setTpSlDisabled(disabled);
  res.json({ 
    success: true, 
    disabled: require('./utils/tpSlControl').isTpSlDisabled()
  });
});

app.get('/tp-sl-status', (req, res) => {
  const { isTpSlDisabled } = require('./utils/tpSlControl');
  res.json({ disabled: isTpSlDisabled() });
});

// Serve history data for chart & table
app.get('/history-data', async (req, res) => {
  try {
    // Get historical curve data (your existing function)
    const historyData = await getEquityCurve();

    // Get real-time account info from Bitunix
    const accountInfo = await getCurrentEquity(); // your working function from getAccountBalance.js

    if (!accountInfo) {
      return res.status(500).json({ error: 'Failed to fetch account info' });
    }

    // Extract real values
    const usedMargin = parseFloat(accountInfo.usedMargin || accountInfo.margin || 0);
    const totalEquity = accountInfo.totalEquity;

    // Send everything the frontend needs
    res.json({
      ...historyData,
      currentEquity: totalEquity,
      usedMargin: usedMargin,
      availableBalance: accountInfo.availableBalance || 0,
      unrealizedPnl: accountInfo.unrealizedPnl || 0
    });

  } catch (err) {
    console.error('[history-data] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const { loadAudit } = require('./storage/mongoStorage');

app.get('/audit-data', async (req, res) => {
  try {
    const data = await loadAudit();
    res.json(data);
  } catch (err) {
    res.status(500).json({ signals: [], failures: [] });
  }
});

app.get('/audit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'audit.html'));
});



// In server.js (replace your current /api/mrd-signal)

app.post('/api/mrd-signal', express.text({ type: '*/*' }), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'string') {
      return res.status(400).json({ error: 'Invalid or empty body' });
    }

    const rawText = req.body.trim();
    if (rawText.length < 100) {
      return res.status(400).json({ error: 'Signal text too short' });
    }

    const signal = parseMrdSignal(rawText);
    if (!signal) {
      return res.status(400).json({ error: 'Failed to parse signal' });
    }

    // === FINAL TELEGRAM FORMAT LOG (exact same as your bot expects) ===
    const directionSymbol = signal.direction === 'BUY' ? '#LONG' : '#SHORT';
    const entry1 = signal.entries[0].toFixed(6);
    const entry2 = signal.entries[1].toFixed(6);
    const sl = signal.sl.toFixed(6);
    const targets = signal.targets.map(t => t.toFixed(6)).join(' - $');

    const tgMessage = `#${signal.symbol} ${directionSymbol}
• $${entry1}
• $${entry2}
TARGETS:
- $${targets}
STOP LOSS: $${sl}`;

    console.log('\n[MRD SIGNAL RECEIVED & PARSED]');
    console.log(tgMessage);
    console.log('────────────────────────────────────');

    // Execute the trade using your existing pipeline
    await executeTrade(signal);

    res.json({ success: true, message: 'Signal processed and trade executed' });
  } catch (err) {
    console.error('[MRD SIGNAL ERROR]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// API: Delete a position by index (for dashboard manual cleanup)
// API: Delete a position by index (for dashboard manual cleanup) - FINAL WORKING
app.post('/delete-position', async (req, res) => {
  try {
    const { index } = req.body;

    if (typeof index !== 'number' || index < 0) {
      console.log('Delete attempt with invalid index:', req.body);
      return res.status(400).json({ error: 'Invalid index' });
    }

    const positions = await loadPositions();

    // EXACT MATCH TO DASHBOARD: all master records (including closed)
    const displayedMasters = positions.filter(p => p.isMaster);

    if (index >= displayedMasters.length) {
      console.log('Delete attempt with out-of-range index:', index, 'available:', displayedMasters.length);
      return res.status(400).json({ error: 'Index out of range' });
    }

    const masterToDelete = displayedMasters[index];
    console.log(`🗑️ Deleting position at index ${index}: ${masterToDelete.symbol} ${masterToDelete.direction}`);

    // Remove the master record
    const newPositions = positions.filter(p => 
      !(p.isMaster && p.symbol === masterToDelete.symbol && p.direction === masterToDelete.direction)
    );

    await savePositions(newPositions);
    console.log(`🗑️ Successfully deleted and saved: ${masterToDelete.symbol} ${masterToDelete.direction}`);

    // Immediate broadcast
    const updatedMasters = newPositions.filter(p => p.isMaster);
    io.emit('positions', updatedMasters);

    // Success response
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete position error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// Add this endpoint for dashboard control
app.post('/close-all', async (req, res) => {
  try {
    const { closeAllPositions } = require('./utils/closeRunningTrade');
    const result = await closeAllPositions();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/close-symbol', async (req, res) => {
  try {
    const { symbol, side } = req.body;
    const { closeRunningTrade } = require('./utils/closeRunningTrade');
    const result = await closeRunningTrade(symbol, side);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === BULK CLOSE POSITIONS API ===
app.post('/api/bulk-close', async (req, res) => {
  const { symbols } = req.body; // Expect array of symbols, e.g., ["ACHUSDT", "STRKUSDT"]

  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'Provide "symbols" as array of strings' });
  }

  try {
    console.log(`[API] Bulk close requested for ${symbols.length} symbols: ${symbols.join(', ')}`);
    const results = await batchClosePositions(symbols);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[API] Bulk close failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// In server.js — add this route
app.get('/api/live-equity', async (req, res) => {
  try {
    const equity = await getCurrentEquity(); // your existing function from getAccountBalance.js
    if (equity === null || equity === 0) {
      return res.status(500).json({ error: 'Failed to fetch equity' });
    }

    const marginUsed = await getCurrentMarginUsed();
    if (marginUsed === null || marginUsed === 0) {
      return res.status(500).json({ error: 'Failed to get margin used' });
    }

    res.json({
      timestamp: Date.now(),
      equity: parseFloat(equity.toFixed(2)),
      formatted: equity.toFixed(2),
      margin: marginUsed.toFixed(2)
    });
  } catch (err) {
    console.error('Live equity fetch error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve history.html directly at /history (no new tab)
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

// Root: serve dashboard (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Optional: any other route → dashboard (keeps old behavior for direct links)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io real-time updates
io.on('connection', (socket) => {
  socket.emit('welcome', 'Connected to trading bot dashboard');
});

// Safe broadcast function
async function broadcastPositions() {
  try {
    const positions = await loadPositions();
    const masters = positions.filter(p => p.isMaster);
    io.emit('positions', masters);
  } catch (err) {
    console.error('Broadcast error:', err.message);
  }
}

// Broadcast every 10 seconds
setInterval(broadcastPositions, 10000);
// Initial broadcast
broadcastPositions();

// Refresh symbols
async function refreshSymbols() {
  try {
    console.log('Refreshing Bitunix perpetual symbols...');
    const response = await axios.get(`${BASE_URL}/api/v1/futures/market/tickers`, { timeout: 10000 });

    if (response.data.code !== 0) {
      throw new Error(response.data.msg || 'API error');
    }

    const allSymbols = response.data.data.map(t => t.symbol);
    availableSymbols = allSymbols.filter(sym => sym.endsWith('USDT'));

    global.lastSymbolRefresh = new Date().toISOString();
    console.log(`✅ Symbols refreshed: ${availableSymbols.length} USDT perpetuals`);
  } catch (error) {
    console.error('❌ Symbol refresh failed:', error.message);
    // Keep old list on failure
  }
}

// Initial refresh
refreshSymbols();

// Auto-enable history tracking on every bot start
(async () => {
  try {
    await connectToDatabase();
    console.log('MongoDB connection ready → starting server...');
  } catch (err) {
    console.error('[STARTUP] Failed to auto-enable history tracking:', err.message);
  }
})();

// Daily refresh
setInterval(refreshSymbols, 24 * 60 * 60 * 1000);


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Symbols: http://localhost:${PORT}/symbols`);
});