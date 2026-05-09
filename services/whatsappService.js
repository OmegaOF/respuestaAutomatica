const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleSheetsService } = require('./googleSheetsService');
const { RESPONSES } = require('./chatbotService');
const { orchestrateConversation, buildCurrentRowContext, appendObservation } = require('./conversationOrchestrator');
const { normalizePhone } = require('../utils/textUtils');
const { extractRealPhoneFromText, validateRealPhone } = require('../utils/phoneUtils');

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESPONSE_DELAY_MS = 45000;
const DEFAULT_MAX_RESPONSE_DELAY_MS = 60000;
const DEFAULT_MAX_BUFFER_MESSAGES = 8;
const pendingByPhone = new Map();
const conversationBufferByPhone = new Map();

function readSerializedId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value._serialized || value.user || '';
}

function extractDigitsFromWid(value) {
  const serialized = readSerializedId(value);
  return serialized.split('@')[0].replace(/\D/g, '');
}

function buildPhoneNumber(msg) {
  return extractDigitsFromWid(msg?.from || '');
}

function isLikelyRealPhoneFromWid(value) {
  const serialized = readSerializedId(value);
  const server = typeof value === 'object' ? value.server || '' : serialized.split('@')[1] || '';
  const digits = extractDigitsFromWid(value);
  if (!validateRealPhone(digits).isRealPhone) return false;
  if (server.includes('lid')) return false;
  return server.includes('c.us') || !server;
}

function buildWhatsappIdentity({ msg, contact, chat, messageText }) {
  const internalIdentifier = extractDigitsFromWid(msg.from)
    || extractDigitsFromWid(contact?.id)
    || extractDigitsFromWid(chat?.id)
    || buildPhoneNumber(msg);
  const textPhone = extractRealPhoneFromText(messageText);
  const candidates = [
    { source: 'mensaje_cliente', value: textPhone, isReal: Boolean(textPhone) },
    { source: 'contact.number', value: normalizePhone(contact?.number || ''), isReal: Boolean(contact?.number) },
    { source: 'contact.id', value: extractDigitsFromWid(contact?.id), isReal: isLikelyRealPhoneFromWid(contact?.id) },
    { source: 'msg.from', value: extractDigitsFromWid(msg.from), isReal: isLikelyRealPhoneFromWid(msg.from) },
    { source: 'msg.author', value: extractDigitsFromWid(msg.author), isReal: isLikelyRealPhoneFromWid(msg.author) },
    { source: 'chat.id', value: extractDigitsFromWid(chat?.id), isReal: isLikelyRealPhoneFromWid(chat?.id) }
  ];
  const selected = candidates.find((candidate) => candidate.isReal && validateRealPhone(candidate.value).isRealPhone);
  const phoneNumber = selected ? validateRealPhone(selected.value).normalizedPhone : '';
  const hasRealPhone = Boolean(phoneNumber);

  if (process.env.DEBUG_WHATSAPP_IDS === 'true') {
    console.log('[WHATSAPP][DEBUG_IDS]', {
      msgFrom: msg.from,
      msgAuthor: msg.author || '',
      contactId: readSerializedId(contact?.id),
      contactNumber: contact?.number || '',
      contactName: contact?.name || '',
      contactPushname: contact?.pushname || '',
      contactShortName: contact?.shortName || '',
      chatId: readSerializedId(chat?.id),
      chatName: chat?.name || '',
      selectedSource: selected?.source || 'identificador_interno'
    });
  }

  return {
    phoneNumber,
    realPhone: phoneNumber,
    hasRealPhone,
    internalIdentifier,
    lookupIdentifiers: internalIdentifier ? [internalIdentifier] : [],
    source: selected?.source || 'identificador_interno',
    technicalReference: internalIdentifier,
    missingPhoneObservation: hasRealPhone ? '' : 'WhatsApp no entregó número real; se solicitó celular al cliente.',
    internalObservation: internalIdentifier ? `Referencia técnica WhatsApp: ${internalIdentifier}.` : ''
  };
}

function createWhatsappClient() {
  const authPath = process.env.WHATSAPP_SESSION_PATH || './.wwebjs_auth';
  return new Client({
    authStrategy: new LocalAuth({ dataPath: path.resolve(authPath) }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });
}

function cleanupOldPending() {
  const now = Date.now();
  pendingByPhone.forEach((pending, key) => {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingByPhone.delete(key);
      console.log('[BOT] Pendiente vencido eliminado para referencia', key);
    }
  });
}

function savePending(bufferKey, messageTextOriginal, interpretationOriginal) {
  pendingByPhone.set(bufferKey, { messageTextOriginal, interpretationOriginal, createdAt: Date.now() });
  console.log('[BOT] Pendiente guardado por referencia', bufferKey);
}

function normalizeResponseDelay(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildBufferKey(phoneInfo, phoneNumber) {
  return phoneInfo.internalIdentifier || phoneNumber;
}

async function markHumanReviewAfterError({ sheetsService, minimalAttention, combinedMessage }) {
  if (!minimalAttention) return;
  await sheetsService.updateAllowedColumns({
    headers: minimalAttention.headers,
    rowIndex: minimalAttention.rowIndex,
    currentRow: minimalAttention.currentRow,
    updates: {
      ULTIMO_MENSAJE: combinedMessage,
      ESTADO_CHATBOT: 'EN_REVISION',
      REQUIERE_HUMANO: 'SI',
      OBSERVACIONES: appendObservation(
        sheetsService.getRowObservations(minimalAttention.headers, minimalAttention.currentRow),
        'Error general del bot después del registro mínimo. Revisar manualmente.'
      )
    }
  });
}

async function processConversationBuffer({ bufferKey, sheetsService, timezone }) {
  const entry = conversationBufferByPhone.get(bufferKey);
  if (!entry) return;
  conversationBufferByPhone.delete(bufferKey);
  if (entry.timer) clearTimeout(entry.timer);

  const messages = entry.messages.map((item) => item.text).filter(Boolean);
  const combinedMessage = messages.join(' ').replace(/\s+/g, ' ').trim();
  const latestMessage = entry.messages[entry.messages.length - 1];
  const minimalAttention = entry.minimalAttention;

  try {
    const currentRowContext = buildCurrentRowContext(sheetsService, minimalAttention);
    const decision = await orchestrateConversation({
      sheetsService,
      combinedMessage,
      messages,
      whatsappIdentity: entry.phoneInfo,
      currentRowContext,
      timezone,
      contactName: entry.visibleName
    });

    const updated = await sheetsService.updateAllowedColumns({
      headers: minimalAttention.headers,
      rowIndex: minimalAttention.rowIndex,
      currentRow: minimalAttention.currentRow,
      updates: decision.updates
    });
    if (updated?.currentRow) minimalAttention.currentRow = updated.currentRow;
    minimalAttention.state = decision.updates.ESTADO_CHATBOT;

    if (decision.shouldSavePendingName) {
      savePending(bufferKey, combinedMessage, decision.interpretation);
    }

    await latestMessage.msg.reply(decision.reply);
  } catch (error) {
    console.error('[BOT] Error procesando buffer conversacional:', error.message);
    try {
      await markHumanReviewAfterError({ sheetsService, minimalAttention, combinedMessage });
      await latestMessage.msg.reply(RESPONSES.REVISION_HUMANA);
    } catch (replyError) {
      console.error('[BOT] No se pudo responder tras error de buffer:', replyError.message);
    }
  }
}

function scheduleConversationBuffer({ bufferKey, msg, messageText, phoneNumber, phoneInfo, visibleName, minimalAttention, sheetsService, timezone, responseDelayMs, maxResponseDelayMs, maxBufferMessages }) {
  const now = Date.now();
  const existing = conversationBufferByPhone.get(bufferKey);
  const entry = existing || {
    messages: [],
    timer: null,
    createdAt: now,
    lastMessageAt: now,
    minimalAttention,
    phoneNumber,
    phoneInfo,
    visibleName
  };

  if (entry.timer) clearTimeout(entry.timer);
  entry.messages.push({ text: messageText, msg, receivedAt: now });
  if (entry.messages.length > maxBufferMessages) entry.messages = entry.messages.slice(-maxBufferMessages);
  entry.lastMessageAt = now;
  entry.minimalAttention = minimalAttention;
  entry.phoneNumber = phoneNumber;
  entry.phoneInfo = phoneInfo;
  entry.visibleName = visibleName;

  const elapsed = now - entry.createdAt;
  const remainingMax = Math.max(0, maxResponseDelayMs - elapsed);
  const waitMs = Math.min(responseDelayMs, remainingMax);
  conversationBufferByPhone.set(bufferKey, entry);

  console.log(`[BOT] Mensaje agregado al buffer ${bufferKey}. Total=${entry.messages.length}. Espera=${waitMs}ms`);
  entry.timer = setTimeout(() => {
    processConversationBuffer({ bufferKey, sheetsService, timezone });
  }, waitMs);
}

function startWhatsappBot() {
  const sheetsService = new GoogleSheetsService();
  const client = createWhatsappClient();
  const timezone = process.env.TIMEZONE || 'America/La_Paz';
  const responseDelayMs = normalizeResponseDelay(process.env.BOT_RESPONSE_DELAY_MS, DEFAULT_RESPONSE_DELAY_MS);
  const maxResponseDelayMs = normalizeResponseDelay(process.env.BOT_MAX_RESPONSE_DELAY_MS, DEFAULT_MAX_RESPONSE_DELAY_MS);
  const maxBufferMessages = normalizeResponseDelay(process.env.BOT_MAX_BUFFER_MESSAGES, DEFAULT_MAX_BUFFER_MESSAGES);

  client.on('qr', (qr) => {
    console.log('[WHATSAPP] Escanea este QR para autenticar:');
    qrcode.generate(qr, { small: true });
  });
  client.on('ready', () => console.log('[WHATSAPP] Cliente listo.'));
  client.on('authenticated', () => console.log('[WHATSAPP] Autenticado correctamente.'));
  client.on('disconnected', (reason) => console.log('[WHATSAPP] Desconectado:', reason));

  client.on('message', async (msg) => {
    let minimalAttention = null;
    let messageText = '';
    try {
      if (msg.from.includes('@g.us') || msg.fromMe) return;
      cleanupOldPending();

      const chat = await msg.getChat();
      const contact = await msg.getContact();
      if (!chat || !contact) return;

      const visibleName = contact.pushname || contact.name || contact.shortName || '';
      messageText = (msg.body || '').trim();
      const phoneInfo = buildWhatsappIdentity({ msg, contact, chat, messageText });
      const phoneNumber = phoneInfo.phoneNumber;
      console.log('[BOT] Referencia WhatsApp visible:', visibleName || '(sin nombre visible)');
      if (!phoneInfo.hasRealPhone) console.log('[BOT] WhatsApp no entregó número real; se pedirá celular real y no se escribirá identificador interno en NUMERO_WHATSAPP.');

      minimalAttention = await sheetsService.upsertMinimalAttentionByPhone({
        phoneNumber,
        messageText,
        timezone,
        lookupIdentifiers: phoneInfo.lookupIdentifiers,
        observations: appendObservation(
          'Mensaje recibido. Pendiente de análisis.',
          visibleName ? `Referencia WhatsApp visible: ${visibleName}.` : '',
          phoneInfo.missingPhoneObservation,
          phoneInfo.internalObservation
        )
      });

      const bufferKey = buildBufferKey(phoneInfo, phoneNumber);
      scheduleConversationBuffer({
        bufferKey,
        msg,
        messageText,
        phoneNumber,
        phoneInfo,
        visibleName,
        minimalAttention,
        sheetsService,
        timezone,
        responseDelayMs,
        maxResponseDelayMs,
        maxBufferMessages
      });
    } catch (error) {
      console.error('[BOT] Error general:', error.message);
      try {
        await markHumanReviewAfterError({ sheetsService, minimalAttention, combinedMessage: messageText });
      } catch (sheetError) {
        console.error('[BOT] No se pudo marcar revisión humana tras error general:', sheetError.message);
      }
      try {
        await msg.reply(RESPONSES.REVISION_HUMANA);
      } catch (_) {}
    }
  });

  client.initialize();
  return client;
}

module.exports = {
  startWhatsappBot,
  pendingByPhone,
  conversationBufferByPhone,
  scheduleConversationBuffer,
  processConversationBuffer,
  buildWhatsappIdentity,
  buildBufferKey,
  readSerializedId,
  extractDigitsFromWid,
  isLikelyRealPhoneFromWid
};
