// utils/telegramListener.js - Fixed to only log parse failures from target group

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const { parseSignal } = require('./signalParser');
const { executeTrade } = require('../tradeExecutor');
const { logSignal } = require('./signalAuditor'); // ← Import at top

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

async function startTelegramListener() {
  console.log('🚀 Starting Telegram userbot...');

  await client.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE,
    phoneCode: async () => await input.text('Enter verification code: '),
    onError: (err) => console.error('Login error:', err),
  });

  const savedSession = client.session.save();
  if (!process.env.TELEGRAM_SESSION) {
    console.log('\n=== LOGIN SUCCESS ===');
    console.log('Add to .env:');
    console.log(`TELEGRAM_SESSION=${savedSession}`);
    console.log('Restart after saving!\n');
  } else {
    console.log('✅ Reconnected');
  }

  console.log('👂 Listening with NewMessage event...\n');

  client.addEventHandler(async (event) => {
    const message = event.message;

    let text = message.text || message.message || '';
    text = text.trim();

    let chatIdStr = 'unknown';
    let chatTitle = 'unknown';

    try {
      const peer = message.peerId;
      if (peer) {
        if (peer.channelId) {
          chatIdStr = `-100${peer.channelId.toString()}`;
        } else if (peer.chatId) {
          chatIdStr = `-${peer.chatId.toString()}`;
        } else if (peer.userId) {
          chatIdStr = peer.userId.toString();
        }

        const entity = await client.getEntity(peer);
        chatTitle = entity.title || entity.username || entity.firstName || 'Private';
      }
    } catch (e) {
      console.log('Entity error:', e.message);
    }

    console.log('\n📨 NEW MESSAGE');
    console.log(`   Chat: ${chatTitle} (ID: ${chatIdStr})`);
    console.log(`   Text: ${text || '(empty)'}`);

    // If a specific chat is configured, ignore all others early
    if (process.env.TELEGRAM_CHAT_ID && chatIdStr !== process.env.TELEGRAM_CHAT_ID) {
      console.log(`Ignored — wrong chat (target: ${process.env.TELEGRAM_CHAT_ID})`);
      return;
    }

    if (text.length === 0) {
      console.log('No text — skip');
      return;
    }

    const signal = await parseSignal(text);

    if (signal) {
      console.log('🎯 SIGNAL!');
      console.log(JSON.stringify(signal, null, 2));
      await logSignal(signal, 'received', { reason: 'parsed_successfully' });
      await executeTrade(signal);
    } else {
      console.log('No signal parsed');

      // Only log parse failure if:
      // - No filter set, OR
      // - Message is from the exact target chat ID (string comparison)
      const targetId = process.env.TELEGRAM_CHAT_ID;
      if (!targetId || chatIdStr === targetId) {
        await logSignal(null, 'failed', {
          rawText: text,
          reason: 'parse_failed_no_pattern_match',
          chatId: chatIdStr,
          chatTitle
        });
      } else {
        console.log('Parse failure ignored — not from target chat');
      }}
  }, new NewMessage({}));
}

module.exports = { startTelegramListener };