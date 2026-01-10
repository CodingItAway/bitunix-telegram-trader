// scripts/migrate-google-drive-to-mongo.js
// One-time migration script: Google Drive JSON files → MongoDB
// Run this BEFORE switching your application to mongoStorage.js

require('dotenv').config();
const mongoose = require('mongoose');  
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────
// Load from OLD Google Drive storage files
// ─────────────────────────────────────────────────────────────
const {
  loadPositions: loadPositionsFromDrive,
  loadHistory: loadHistoryFromDrive
} = require('./storage/googleDriveStorage');

const {
  loadAudit: loadAuditFromDrive
} = require('./storage/signalAuditStorage');

// ─────────────────────────────────────────────────────────────
// MongoDB Models (same as in your application)
// ─────────────────────────────────────────────────────────────
const Position = require('./models/Position');
const History = require('./models/History');
const SignalAudit = require('./models/SignalAudit');

// ─────────────────────────────────────────────────────────────
// MongoDB connection
// ─────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set in .env file');
  process.exit(1);
}

async function migrate() {
  console.log('=== Google Drive → MongoDB Migration ===');
  console.log('Date:', new Date().toISOString(), '\n');

  // 1. Connect to MongoDB
  console.log('1. Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 20000
  });
  console.log('MongoDB connection established ✓\n');

  // 2. Clear target collections (BE CAREFUL - destructive!)
  console.log('2. Clearing existing collections...');
  await Position.deleteMany({});
  await History.deleteMany({});
  await SignalAudit.deleteMany({});
  console.log('Collections cleared ✓\n');

  // ─────────────────────────────────────────────────────────────
  // 3. Migrate POSITIONS
  // ─────────────────────────────────────────────────────────────
  console.log('3. Migrating positions...');
  const drivePositions = await loadPositionsFromDrive();
  console.log(`Found ${drivePositions.length} position records`);

  if (drivePositions.length > 0) {
    // Ensure dates are proper Date objects
    const prepared = drivePositions.map(p => ({
      ...p,
      createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      lastUpdated: p.lastUpdated ? new Date(p.lastUpdated) : new Date()
    }));

    await Position.insertMany(prepared);
    console.log(`→ ${prepared.length} positions successfully migrated\n`);
  } else {
    console.log('→ No positions to migrate\n');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Migrate HISTORY
  // ─────────────────────────────────────────────────────────────
  console.log('4. Migrating history...');
  const driveHistory = await loadHistoryFromDrive();
  console.log('History document loaded from Drive');

  // Convert closeTime to Date where present
  if (driveHistory.closedPositions?.length) {
    driveHistory.closedPositions = driveHistory.closedPositions.map(p => ({
      ...p,
      closeTime: p.closeTime ? new Date(p.closeTime) : undefined
    }));
  }

  await History.create(driveHistory);
  console.log(`→ History migrated (${driveHistory.closedPositions?.length || 0} closed positions)\n`);

  // ─────────────────────────────────────────────────────────────
  // 5. Migrate SIGNAL AUDIT LOG
  // ─────────────────────────────────────────────────────────────
  console.log('5. Migrating signal audit...');
  const driveAudit = await loadAuditFromDrive();
  const signalsCount = driveAudit.signals?.length || 0;
  const failuresCount = driveAudit.failures?.length || 0;

  if (signalsCount > 0 || failuresCount > 0) {
    await SignalAudit.create(driveAudit);
    console.log(`→ Audit migrated (${signalsCount} signals + ${failuresCount} failures)\n`);
  } else {
    console.log('→ No audit records found\n');
  }

  // ─────────────────────────────────────────────────────────────
  // Final summary
  // ─────────────────────────────────────────────────────────────
  console.log('═'.repeat(50));
  console.log('🎉 MIGRATION COMPLETED SUCCESSFULLY 🎉');
  console.log('Positions:     ', await Position.countDocuments());
  console.log('History docs:  ', await History.countDocuments());
  console.log('Audit signals: ', (await SignalAudit.findOne())?.signals?.length || 0);
  console.log('═'.repeat(50));
}

migrate()
  .catch(err => {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    mongoose.connection.close()
      .then(() => console.log('MongoDB connection closed'))
      .catch(() => console.log('Connection already closed'));
  });