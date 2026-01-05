// utils/joinNotification.js
require('dotenv').config();
const fetch = require('node-fetch');

async function sendJoinNotification(title, text) {
  if (!process.env.JOIN_API_KEY) {
    console.warn('[JOIN] API key not set — skipping notification');
    return;
  }

  const url = 'https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush';

  const params = new URLSearchParams({
    apikey: process.env.JOIN_API_KEY,
    title: title,
    text: text,
    deviceId: process.env.JOIN_DEVICE_ID || '',  // empty = all devices
    icon: 'https://i.imgur.com/4pRZq.png'        // optional nice icon
  });

  try {
    await fetch(`${url}?${params}`);
    console.log(`[JOIN] 📱 Notification sent: ${title}`);
  } catch (e) {
    console.warn('[JOIN] Failed to send notification:', e.message);
  }
}

module.exports = { sendJoinNotification };