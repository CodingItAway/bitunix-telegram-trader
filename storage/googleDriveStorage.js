// storage/googleDriveStorage.js - Final version for personal Google Drive with shared folder

const { google } = require('googleapis');

// REPLACE THIS with your shared folder ID from Google Drive
// How to get it: Open the folder → URL is https://drive.google.com/drive/folders/THIS_IS_THE_ID
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const HISTORY_FILE_NAME = 'bitunix-history.json';
const FILE_NAME = 'bitunix-positions.json';

let drive;

async function authGoogle() {
  if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    console.warn('GOOGLE_CREDENTIALS_BASE64 not set — Google Drive disabled');
    return false;
  }

  try {
    const jsonString = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    const credentials = JSON.parse(jsonString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    drive = google.drive({ version: 'v3', auth });
    console.log('✅ Google Drive authenticated successfully');
    return true;
  } catch (error) {
    console.error('Google Drive auth failed:', error.message);
    return false;
  }
}

async function loadPositions() {
  if (!drive && !(await authGoogle())) {
    console.log('Drive not available — starting with empty positions');
    return [];
  }

  try {
    // Search for the file inside the shared folder
    const res = await drive.files.list({
      q: `name='${FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (res.data.files.length === 0) {
      console.log('Positions file not found — starting with empty list');
      return [];
    }

    const fileId = res.data.files[0].id;

    // Fetch file content
    const content = await drive.files.get({
      fileId,
      alt: 'media'
    });

    // Safely extract raw JSON string from response
    let rawData = content.data;

    if (Buffer.isBuffer(rawData)) {
      rawData = rawData.toString('utf-8');
    } else if (typeof rawData === 'object') {
      rawData = JSON.stringify(rawData);
    } else if (typeof rawData !== 'string') {
      throw new Error('Unexpected response format from Google Drive');
    }

    // Parse JSON
    let positions = [];
    try {
      positions = JSON.parse(rawData);
      if (!Array.isArray(positions)) {
        console.warn('Positions data is not an array — resetting to empty');
        positions = [];
      }
    } catch (parseErr) {
      console.error('Failed to parse positions JSON:', parseErr.message);
      console.error('Raw content received:', rawData.substring(0, 500)); // Log first 500 chars
      positions = [];
    }
    return positions;
  } catch (error) {
    console.error('Error loading positions from Drive:', error.message);
    return [];
  }
}

async function savePositions(positions) {
  if (!drive && !(await authGoogle())) {
    console.warn('Drive not available — skipping save');
    return;
  }

  const media = {
    mimeType: 'application/json',
    body: JSON.stringify(positions, null, 2)  // Save even if empty
  };

  try {
    const listRes = await drive.files.list({
      q: `name='${FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id)'
    });

    if (listRes.data.files.length > 0) {
      const fileId = listRes.data.files[0].id;
      await drive.files.update({
        fileId,
        media,
        supportsAllDrives: true
      });
      console.log(`Saved ${positions.length} position(s) to Drive (fileId: ${fileId})`);
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: FILE_NAME,
          mimeType: 'application/json',
          parents: [FOLDER_ID]
        },
        media,
        fields: 'id',
        supportsAllDrives: true
      });
      console.log(`Created and saved ${positions.length} position(s) to Drive (fileId: ${createRes.data.id})`);
    }
  } catch (error) {
    console.error('[SAVE ERROR] Failed to save positions to Drive:', error.message);
    if (error.response?.data) {
      console.error('Google Drive API response:', JSON.stringify(error.response.data, null, 2));
    }
  }
}



async function loadHistory() {
  if (!drive && !(await authGoogle())) {
    console.log('Drive not available — starting fresh');
    return { closedPositions: [], lastHistoryCheckpoint: 0 };
  }

  try {
    const res = await drive.files.list({
      q: `name='${HISTORY_FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (res.data.files.length === 0) {
      console.log('No history file found — starting fresh');
      return { closedPositions: [], lastHistoryCheckpoint: 0 };
    }

    const fileId = res.data.files[0].id;
    const response = await drive.files.get({ fileId, alt: 'media' });

    let rawData = '';
    if (Buffer.isBuffer(response.data)) {
      rawData = response.data.toString('utf-8');
    } else if (typeof response.data === 'string') {
      rawData = response.data;
    } else {
      // Fallback: stringify if object (rare but seen)
      rawData = JSON.stringify(response.data || {});
    }

    let parsedData = {};
    try {
      parsedData = JSON.parse(rawData);
    } catch (parseErr) {
      console.error('History JSON parse error:', parseErr.message);
      console.error('Full raw content:', rawData);
      // Optional: auto-delete corrupted file
      await drive.files.delete({ fileId }).catch(() => {});
      console.log('Corrupted history file deleted — starting fresh');
      return { closedPositions: [], lastHistoryCheckpoint: 0 };
    }

    return {
      featureEnabledAt: parsedData.featureEnabledAt || null,
      initialBalance: parsedData.initialBalance || 0,
      closedPositions: parsedData.closedPositions || [],
      lastHistoryCheckpoint: parsedData.lastHistoryCheckpoint || 0,
      pendingCloseIntents: parsedData.pendingCloseIntents || {},
      peakEquity: parsedData.peakEquity || parsedData.initialBalance || 0,
      riskBaseMode: parsedData.riskBaseMode || 'aggressive', // 'aggressive' or 'protective'
      realizedDrawdownAccepted: parsedData.realizedDrawdownAccepted || false, // ← ADD
    };

  } catch (err) {
    console.error('Error loading history:', err.message);
    return { closedPositions: [], lastHistoryCheckpoint: 0 };
  }
}

async function saveHistory(historyData) {
  if (!drive && !(await authGoogle())) return;

  const media = {
    mimeType: 'application/json',
    body: JSON.stringify(historyData, null, 2)
  };

  try {
    const listRes = await drive.files.list({
      q: `name='${HISTORY_FILE_NAME}' and '${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`
    });

    if (listRes.data.files.length > 0) {
      const fileId = listRes.data.files[0].id;
      await drive.files.update({ fileId, media, supportsAllDrives: true });
    } else {
      await drive.files.create({
        requestBody: { name: HISTORY_FILE_NAME, mimeType: 'application/json', parents: [FOLDER_ID] },
        media,
        fields: 'id',
        supportsAllDrives: true
      });
    }
  } catch (err) {
    console.error('Error saving history:', err.message);
  }
}


module.exports = { loadPositions, savePositions, loadHistory, saveHistory};
