# Bitunix Futures Trading Bot

A fully automated, production-grade cryptocurrency futures trading bot for the **Bitunix** exchange.  
It receives trading signals (currently via AutoInput/Tasker using mrD popup format), executes them with dynamic risk-based position sizing, manages entries/take-profits/stop-loss, tracks performance, and provides a real-time web dashboard.

## Features

- **Signal Input**  
  - Parses mrD-style popup signals (from Tasker/AutoInput `%aitext()` dumps) via `mrdParser.js`.
  - Detects symbol, direction (LONG/SHORT), multiple entry levels, stop-loss, targets, and **risk level** (Low/Medium).

- **Dynamic Position Sizing**  
  - Risk-based sizing using `%` of account equity per trade.
  - Calculates notional from distance to stop-loss.
  - Supports standard and multiplier contracts (1000x, 1000000x symbols).
  - Minimum notional and max concurrent positions safeguards.

- **Adaptive Entry Allocation**  
  - Smart splitting of position size across entry levels:
    - **Low Risk**:
      - On-time: 80% on E1, remainder split equally
      - Late (≥3 entries): 50% / 30% / 20%
    - **Medium Risk** (default):
      - On-time: 50% / 50%
      - Late: 35% / 35% / 30%

- **Trade Execution & Management**  
  - Places limit entry orders (post-only optional).
  - Tracks partial fills and creates master position record.
  - Progressively sets take-profit levels (30/30/20/10/5/5% allocation).
  - Places stop-loss when position is sufficiently filled.
  - Automatic cleanup of closed positions.

- **Performance Tracking**  
  - Optional equity curve with realized PNL from closed trades.
  - Fetches historical closed positions from Bitunix API.
  - Initial balance + running equity calculation.

- **Signal Auditing**  
  - Logs every signal: received, success, skipped, failed.
  - Detailed failure logs (raw text, errors, stack traces).

- **Persistence**  
  - All data stored in **Google Drive** (JSON files):
    - Open positions
    - Trade history
    - Signal audit log

- **Web Dashboard**[](http://localhost:3000)
  - Real-time positions table
  - Equity curve & closed trades history with Chart.js
  - Full signal audit viewer with expandable details
  - Health check endpoint

- **Safety Tools**
  - Emergency close single/all positions
  - Comprehensive logging throughout

## Requirements

- Node.js ≥ 18
- Bitunix Futures API keys
- Google Drive service account (for persistence)

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd bitunix-trading-bot

Install dependencies:

Bashnpm install

Create .env file (see .env.example below).
Start the bot:

Bashnode server.js
.env Configuration
env# Bitunix API
BITUNIX_API_KEY=your_api_key
BITUNIX_API_SECRET=your_api_secret

# Google Drive (base64-encoded service account JSON)
GOOGLE_DRIVE_FOLDER_ID=your_shared_folder_id
GOOGLE_CREDENTIALS_BASE64=base64_encoded_credentials_json

# Risk & Position Settings
RISK_PER_TRADE_PERCENT=1          # % of equity to risk per trade
LEVERAGE=15                       # Default leverage
MIN_NOTIONAL_USDT=10              # Skip if notional too small
MAX_CONCURRENT_POSITIONS=5

# Entry Behavior
USE_POST_ONLY=true                # false to allow market orders on late entries

# Dashboard
PORT=3000
Project Structure
text├── server.js                  # Express + Socket.IO server, symbol refresh
├── tradeExecutor.js           # Main trade logic, dynamic allocation
├── positionSizer.js           # Risk-based size calculation
├── positionManager.js         # Monitors fills, sets TP/SL, cleanup
├── utils/
│   ├── mrdParser.js           # Parses mrD popup signals + risk detection
│   ├── openNewPositions.js    # Bitunix API client
│   ├── getAccountBalance.js   # Accurate equity fetch
│   ├── getOpenPositions.js
│   ├── getPendingOrders.js
│   ├── tpslManager.js         # TP/SL placement
│   ├── symbolValidator.js
│   ├── historyManager.js
│   ├── signalAuditor.js
│   └── closeRunningTrade.js   # Emergency close functions
├── storage/
│   ├── googleDriveStorage.js
│   └── signalAuditStorage.js
├── public/
│   ├── index.html             # Dashboard - live positions
│   ├── history.html           # Equity curve + closed trades
│   └── audit.html             # Signal audit log viewer
└── .env.example
Dashboard URLs

Dashboard: http://localhost:3000
History: http://localhost:3000/history
Signal Audit: http://localhost:3000/audit (create link if needed)
Health: http://localhost:3000/health

Disclaimer
This bot is for educational and personal use only. Trading futures involves significant risk. Use at your own risk. The author is not responsible for any losses.