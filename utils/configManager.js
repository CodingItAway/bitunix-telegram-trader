// utils/configManager.js - Persistent config stored on Google Drive

const { saveToDrive, loadFromDrive } = require('../storage/googleDriveStorage');

const CONFIG_FILE_NAME = 'config.json';
let config = { tp_sl_disabled: false };

async function loadConfig() {
  try {
    const fileContent = await loadFromDrive(CONFIG_FILE_NAME);
    if (fileContent) {
      config = JSON.parse(fileContent);
      console.log('[CONFIG] Loaded from GDrive:', config);
    } else {
      await saveConfig(); // create default
    }
  } catch (err) {
    console.error('[CONFIG] Failed to load from GDrive, using default:', err.message);
    await saveConfig();
  }
}

async function saveConfig() {
  try {
    await saveToDrive(CONFIG_FILE_NAME, JSON.stringify(config, null, 2));
    console.log('[CONFIG] Saved to GDrive:', config);
  } catch (err) {
    console.error('[CONFIG] Failed to save to GDrive:', err.message);
  }
}

function isTpSlDisabled() {
  return config.tp_sl_disabled || false;
}

async function setTpSlDisabled(disabled) {
  config.tp_sl_disabled = !!disabled;
  await saveConfig();
}

// Load on startup
loadConfig();

module.exports = {
  isTpSlDisabled,
  setTpSlDisabled
};