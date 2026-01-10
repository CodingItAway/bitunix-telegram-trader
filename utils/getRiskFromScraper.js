// utils/getRiskFromScraper.js
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;

async function getCurrentRiskLevel(symbol) {
  if (!MONGO_URI) {
    console.warn('[RISK LOOKUP] MONGO_URI missing → fallback to medium');
    return 'medium';
  }

  let client;
  try {
    client = new MongoClient(MONGO_URI, {
      family: 4,                          // Render compatibility
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 3,
    });

    await client.connect();
    const db = client.db('mrd_bot');      // ← same DB as your scraper project

    const doc = await db.collection('state').findOne({ id: 'active' });

    if (!doc?.data?.signals?.length) {
      console.log('[RISK] No active signals found → medium');
      return 'medium';
    }

    const signal = doc.data.signals.find(s => s.symbol === symbol);

    if (!signal?.risk) {
      console.log(`[RISK] No risk field for ${symbol} → medium`);
      return 'medium';
    }

    const risk = signal.risk.toLowerCase();
    const level = risk === 'low' ? 'low' : 'medium'; // your current logic only differentiates low vs others

    console.log(`[RISK] ${symbol}: "${signal.risk}" → using "${level}"`);

    return level;

  } catch (err) {
    console.error(`[RISK LOOKUP] Failed for ${symbol}: ${err.message} → medium`);
    return 'medium';
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

module.exports = { getCurrentRiskLevel };