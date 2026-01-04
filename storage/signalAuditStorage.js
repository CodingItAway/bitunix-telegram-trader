// storage/signalAuditStorage.js
// Reuses the same Google Drive authentication and logic as positions/history
require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

// Same folder and file name as your other storage
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const AUDIT_FILE_NAME = 'bitunix-signal-audit.json';

let drive = null;

// Reuse exact same auth logic as googleDriveStorage.js
async function authenticate() {
  if (drive) return drive;

  if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    console.warn('GOOGLE_CREDENTIALS_BASE64 not set — Signal audit will not save to Drive');
    return null;
  }

  try {
    const jsonString = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    const credentials = JSON.parse(jsonString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    drive = google.drive({ version: 'v3', auth });
    console.log('✅ Signal Audit: Google Drive authenticated');
    return drive;
  } catch (error) {
    console.error('Signal Audit: Google Drive auth failed:', error.message);
    drive = null;
    return null;
  }
}

async function loadAudit() {
  const authenticatedDrive = await authenticate();
  if (!authenticatedDrive) {
    return { signals: [], failures: [] };
  }

  try {
    const res = await authenticatedDrive.files.list({
      q: `name='${AUDIT_FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (res.data.files.length === 0) {
      console.log('Signal audit file not found — starting fresh');
      return { signals: [], failures: [] };
    }

    const fileId = res.data.files[0].id;
    const content = await authenticatedDrive.files.get({
      fileId,
      alt: 'media'
    });

    let rawData = content.data;
    if (Buffer.isBuffer(rawData)) {
      rawData = rawData.toString('utf-8');
    } else if (typeof rawData === 'object') {
      rawData = JSON.stringify(rawData);
    }

    return JSON.parse(rawData);
  } catch (err) {
    console.error('Error loading signal audit:', err.message);
    return { signals: [], failures: [] };
  }
}

async function saveAudit(auditData) {
  const authenticatedDrive = await authenticate();
  if (!authenticatedDrive) {
    console.warn('Drive not available — signal audit not saved');
    return;
  }

  const media = {
    mimeType: 'application/json',
    body: JSON.stringify(auditData, null, 2)
  };

  try {
    const listRes = await authenticatedDrive.files.list({
      q: `name='${AUDIT_FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id)'
    });

    if (listRes.data.files.length > 0) {
      const fileId = listRes.data.files[0].id;
      await authenticatedDrive.files.update({
        fileId,
        media,
        supportsAllDrives: true
      });
      console.log('📊 Signal audit updated on Drive');
    } else {
      await authenticatedDrive.files.create({
        requestBody: {
          name: AUDIT_FILE_NAME,
          mimeType: 'application/json',
          parents: [FOLDER_ID]
        },
        media,
        fields: 'id',
        supportsAllDrives: true
      });
      console.log('📊 Signal audit file created on Drive');
    }
  } catch (err) {
    console.error('Error saving signal audit:', err.message);
  }
}

module.exports = { loadAudit, saveAudit };