// utils/tpSlControl.js - In-memory only TP/SL toggle (NO persistence)

let tpSlDisabled = true;  // ← Default: DISABLED on every startup

function isTpSlDisabled() {
  return tpSlDisabled;
}

function setTpSlDisabled(disabled) {
  tpSlDisabled = !!disabled;
  console.log(`[TP/SL CONTROL] TP/SL management now ${tpSlDisabled ? 'DISABLED' : 'ENABLED'}`);
}

module.exports = {
  isTpSlDisabled,
  setTpSlDisabled
};