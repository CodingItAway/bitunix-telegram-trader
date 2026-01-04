// utils/mrdParser.js
// Robust parser for raw AutoInput %aitext() dump from mrD popup

/**
 * Parses raw popup text from Tasker (full of %aitextX placeholders)
 * @param {string} rawText - The full text from AutoInput UI Query / Value
 * @returns {object|null} Parsed signal or null if invalid
 */
function parseMrdSignal(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    console.log('[MRD PARSER] No or invalid raw text received');
    return null;
  }

  console.log('[MRD PARSER] Received raw text (first 300 chars):');
  console.log(rawText.substring(0, 300) + '...');

  // Step 1: Remove all %aitextX placeholders
  let clean = rawText.replace(/%aitext\d+/g, '').trim();

  // Step 2: Remove excessive commas and clean up
  clean = clean.replace(/,+/g, ',').replace(/^,|,$/g, '').trim();

  console.log('[MRD PARSER] Cleaned text (first 300 chars):');
  console.log(clean.substring(0, 300) + '...');

  // Step 3: Extract Symbol (e.g., WAXPUSDT)
  const symbolMatch = clean.match(/([A-Z0-9]+USDT)/);
  if (!symbolMatch) {
    console.log('[MRD PARSER] Failed to find symbol');
    return null;
  }
  const symbol = symbolMatch[1];
  console.log(`[MRD PARSER] Symbol: ${symbol}`);

  // Step 4: Extract Direction (LONG or SHORT)
  let direction = null;
  if (clean.includes('LONG')) direction = 'BUY';
  if (clean.includes('SHORT')) direction = 'SELL';
  if (!direction) {
    console.log('[MRD PARSER] Failed to detect direction (LONG/SHORT)');
    return null;
  }
  console.log(`[MRD PARSER] Direction: ${direction}`);

  // Step 5: Extract Entries
  const entriesMatch = clean.match(/Entries:\s*\$([^S]+?)(Stoploss|Targets)/i);
  if (!entriesMatch) {
    console.log('[MRD PARSER] Failed to find Entries line');
    return null;
  }
  const entriesStr = entriesMatch[1].trim();
  const entries = entriesStr
    .split('-')
    .map(e => parseFloat(e.trim().replace(/[^0-9.]/g, '')))
    .filter(e => !isNaN(e));

  if (entries.length < 2) {
    console.log('[MRD PARSER] Less than 2 entries found');
    return null;
  }
  console.log(`[MRD PARSER] Entries: $${entries.join(' - $')}`);

  // Step 6: Extract Stoploss
  const slMatch = clean.match(/Stoploss:\s*\$([\d.]+)/i);
  if (!slMatch) {
    console.log('[MRD PARSER] Failed to find Stoploss');
    return null;
  }
  const sl = parseFloat(slMatch[1]);
  console.log(`[MRD PARSER] Stoploss: $${sl}`);

  // Step 7: Extract Targets
  const targetsMatch = clean.match(/Targets:[\s,$]*([^M]+?)(Max Profit|ROI)/i);
  if (!targetsMatch) {
    console.log('[MRD PARSER] Failed to find Targets');
    return null;
  }
  const targetsStr = targetsMatch[1].trim();
  const targets = targetsStr
    .split('-')
    .map(t => parseFloat(t.trim().replace(/[^0-9.]/g, '')))
    .filter(t => !isNaN(t));

  console.log(`[MRD PARSER] Targets: $${targets.join(' - $')}`);

  // Final signal object
  const signal = {
    symbol,
    direction,
    entries,
    targets,
    sl
  };

  console.log('[MRD PARSER] SUCCESSFULLY PARSED SIGNAL');
  console.log(JSON.stringify(signal, null, 2));

  return signal;
}

module.exports = { parseMrdSignal };