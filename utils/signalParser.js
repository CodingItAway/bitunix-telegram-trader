const { getValidSymbol } = require('./symbolValidator'); // ← ADD THIS

async function parseSignal(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  // Find the line with symbol (supports #XXXUSD or #XXXUSDT)
  const symbolLine = lines.find(l => l.includes('#') && (l.includes('USD') || l.includes('USDT')));
  if (!symbolLine) {
    console.log('No symbol line found (missing #XXXUSD or #XXXUSDT)');
    return null;
  }

  // Extract base currency (e.g., AVA, ETH, BTC) and force USDT perpetual
  const baseMatch = symbolLine.match(/#([A-Z]+)(?:USD|USDT)/);
  if (!baseMatch) {
    console.log('Failed to extract base symbol from:', symbolLine);
    return null;
  }

  const base = baseMatch[1];                    // e.g., "AVA", "ETH", "BTC"
  const symbol = await getValidSymbol(base);
  if (!symbol) {
    console.log(`🚫 Symbol ${base} (or variants) not supported on Bitunix — skipping trade`);
    return null;
  }

  const direction = symbolLine.includes('#BUY') ? 'BUY' : 
                   symbolLine.includes('#SELL') ? 'SELL' : null;
  if (!direction) {
    console.log('No direction found (missing #BUY or #SELL)');
    return null;
  }

  // Parse entry levels (lines starting with • and containing $)
  const entryLines = lines.filter(l => l.startsWith('•') && l.includes('$'));
  const entries = entryLines.map(l => {
    const match = l.match(/\$[\s]*([0-9.,]+)/);
    if (match) {
      return parseFloat(match[1].replace(/,/g, ''));
    }
    return null;
  }).filter(v => v !== null && !isNaN(v));

  if (entries.length === 0) {
    console.log('No valid entry levels found');
    return null;
  }

  // Parse targets (everything after "TARGETS:")
  const targetsLine = lines.find(l => l.includes('TARGETS:'));
  if (!targetsLine) {
    console.log('No TARGETS line found');
    return null;
  }

  const targetsStr = targetsLine.split('TARGETS:')[1].trim();
  const targets = targetsStr.split('-').map(t => {
    const cleaned = t.trim().replace(/[^0-9.]/g, '');  // Remove $, commas, spaces, etc.
    return parseFloat(cleaned);
  }).filter(n => !isNaN(n));

  if (targets.length === 0) {
    console.log('No valid targets parsed');
    return null;
  }

  // Parse stop loss
  const slLine = lines.find(l => l.includes('STOP LOSS:'));
  if (!slLine) {
    console.log('No STOP LOSS line found');
    return null;
  }

  const slMatch = slLine.match(/STOP LOSS:[\s]*\$?([\d.,]+)/);
  if (!slMatch) {
    console.log('Failed to parse stop loss from:', slLine);
    return null;
  }

  const sl = parseFloat(slMatch[1].replace(/,/g, ''));

  if (isNaN(sl)) {
    console.log('Invalid stop loss value');
    return null;
  }

  console.log(`🎯 Parsed Signal: ${direction} ${symbol} | Entries: ${entries.join(', ')} | SL: ${sl} | Targets: ${targets.join(' - ')}`);

  return {
    symbol,       // e.g., "AVAUSDT", "ETHUSDT"
    direction,    // "BUY" or "SELL"
    entries,      // array of numbers
    targets,      // array of numbers (no nulls)
    sl            // number
  };
}

module.exports = { parseSignal };