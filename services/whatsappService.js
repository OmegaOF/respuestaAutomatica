const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleSheetsService, FINAL_STATES } = require('./googleSheetsService');
const { analyzeIncomingMessage, buildUpdatesFromIA, hasRealLoanRequest, RESPONSES } = require('./chatbotService');
const { normalizeText, isLikelyFullName, cleanNameCandidate } = require('../utils/textUtils');

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const pendingByPhone = new Map();

function buildPhoneNumber(msg) {
  const raw = msg.from || '';
  return raw.split('@')[0].replace(/\D/g, '');
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
  pendingByPhone.forEach((pending, phoneNumber) => {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingByPhone.delete(phoneNumber);
      console.log('[BOT] Pendiente vencido eliminado para número', phoneNumber);
    }
  });
}

function savePending(phoneNumber, messageTextOriginal, iaResultOriginal) {
  pendingByPhone.set(phoneNumber, { messageTextOriginal, iaResultOriginal, createdAt: Date.now() });
  console.log('[BOT] Pendiente guardado por número', phoneNumber);
}

function getSolicitudesFromRow(headers, row) {
  const solicitudesIdx = headers.indexOf('SOLICITUDES_DETECTADAS');
  return solicitudesIdx >= 0 ? row[solicitudesIdx] || '' : '';
}

function isFinalState(state) {
  return FINAL_STATES.includes(normalizeText(state || ''));
}

function buildNameMismatchObservation(name, reason = 'No coincide con la lista interna') {
  return `Nombre detectado: ${name}. ${reason}. Revisar manualmente.`;
}

async function resolveAttentionForKnownName({ sheetsService, phoneNumber, detectedName }) {
  const nameMatch = await sheetsService.findNameMatch(detectedName);
  if (nameMatch.ambiguous) {
    console.log('[BOT] Enviado a revisión humana por nombre ambiguo.');
    return {
      headers: nameMatch.headers,
      officialName: '',
      forceHumanReview: true,
      observations: buildNameMismatchObservation(detectedName, 'Tiene múltiples coincidencias posibles en la lista interna'),
      createBlankName: true
    };
  }

  if (!nameMatch.found) {
    console.log('[BOT] Nombre no coincide con lista interna:', detectedName);
    return {
      headers: nameMatch.headers,
      officialName: '',
      forceHumanReview: true,
      observations: buildNameMismatchObservation(detectedName),
      createBlankName: true
    };
  }

  const attention = await sheetsService.findAttentionByOfficialName(nameMatch.officialName);
  if (attention.found && !isFinalState(attention.state)) {
    return { ...attention, officialName: nameMatch.officialName, forceHumanReview: false, observations: sheetsService.getRowObservations(attention.headers, attention.currentRow) };
  }

  if (attention.found && isFinalState(attention.state)) {
    console.log('[BOT] Atención finalizada detectada. Se creará nueva línea por atención finalizada.');
  }

  return {
    headers: attention.headers || nameMatch.headers,
    officialName: nameMatch.officialName,
    forceHumanReview: false,
    observations: attention.found ? `Nueva atención creada por atención finalizada (${attention.state}).` : ''
  };
}

async function persistAttention({ sheetsService, phoneNumber, messageText, iaResult, timezone, detectedName, existingAttention }) {
  let target = existingAttention;
  let headers = target?.headers;
  let rowIndex = target?.rowIndex;
  let currentRow = target?.currentRow;
  let rowData = target ? { solicitudesDetectadas: getSolicitudesFromRow(headers, currentRow) } : { solicitudesDetectadas: '' };
  let observations = target ? sheetsService.getRowObservations(headers, currentRow) : '';
  let forceHumanReview = false;

  if (target && isLikelyFullName(detectedName)) {
    const officialName = sheetsService.getRowName(headers, currentRow);
    if (officialName && normalizeText(officialName) !== normalizeText(detectedName)) {
      observations = `${observations ? `${observations} ` : ''}${buildNameMismatchObservation(detectedName, `No coincide con NOMBRE DE CLIENTE (${officialName})`)}`;
      forceHumanReview = true;
      console.log('[BOT] Nombre detectado no coincide con NOMBRE DE CLIENTE.');
    }
  }

  if (!target) {
    const resolved = await resolveAttentionForKnownName({ sheetsService, phoneNumber, detectedName });
    headers = resolved.headers;
    forceHumanReview = resolved.forceHumanReview;
    observations = resolved.observations || '';

    if (resolved.rowIndex && resolved.currentRow && !isFinalState(resolved.state)) {
      rowIndex = resolved.rowIndex;
      currentRow = resolved.currentRow;
      rowData = { solicitudesDetectadas: getSolicitudesFromRow(headers, currentRow) };
    } else {
      const created = await sheetsService.createAttentionRow({
        headers,
        whatsappNumber: phoneNumber,
        officialName: resolved.createBlankName ? '' : resolved.officialName,
        observations
      });
      rowIndex = created.rowIndex;
      currentRow = created.currentRow;
      rowData = { solicitudesDetectadas: '' };
      if (resolved.createBlankName) console.log('[BOT] Nueva línea creada con NOMBRE DE CLIENTE vacío.');
      if (resolved.officialName && observations.includes('atención finalizada')) console.log('[BOT] Nueva línea creada por atención finalizada.');
    }
  }

  const { updates, reply } = buildUpdatesFromIA({
    iaResult,
    messageText,
    phoneNumber,
    timezone,
    rowData,
    observations,
    forceHumanReview
  });

  await sheetsService.updateAllowedColumns({ headers, rowIndex, currentRow, updates });
  return reply;
}

async function handlePendingNameReply({ sheetsService, phoneNumber, messageText, timezone }) {
  const pending = pendingByPhone.get(phoneNumber);
  if (!pending) return null;

  console.log('[BOT] Pendiente encontrado por número', phoneNumber);
  if (!isLikelyFullName(messageText)) {
    console.log('[BOT] Falta nombre completo válido para pendiente.');
    return RESPONSES.FALTA_NOMBRE;
  }

  const cleanedName = cleanNameCandidate(messageText);
  console.log('[BOT] Nombre recibido después:', cleanedName);
  const iaResult = {
    ...pending.iaResultOriginal,
    nombre_detectado: cleanedName,
    respuesta_tipo: pending.iaResultOriginal.respuesta_tipo === 'FALTA_NOMBRE' ? 'REGISTRADO' : pending.iaResultOriginal.respuesta_tipo
  };

  const reply = await persistAttention({
    sheetsService,
    phoneNumber,
    messageText: pending.messageTextOriginal,
    iaResult,
    timezone,
    detectedName: cleanedName
  });

  pendingByPhone.delete(phoneNumber);
  return reply;
}

function startWhatsappBot() {
  const sheetsService = new GoogleSheetsService();
  const client = createWhatsappClient();
  const timezone = process.env.TIMEZONE || 'America/La_Paz';

  client.on('qr', (qr) => {
    console.log('[WHATSAPP] Escanea este QR para autenticar:');
    qrcode.generate(qr, { small: true });
  });
  client.on('ready', () => console.log('[WHATSAPP] Cliente listo.'));
  client.on('authenticated', () => console.log('[WHATSAPP] Autenticado correctamente.'));
  client.on('disconnected', (reason) => console.log('[WHATSAPP] Desconectado:', reason));

  client.on('message', async (msg) => {
    try {
      if (msg.from.includes('@g.us') || msg.fromMe) return;
      cleanupOldPending();

      const chat = await msg.getChat();
      const contact = await msg.getContact();
      if (!chat || !contact) return;

      const phoneNumber = buildPhoneNumber(msg);
      const visibleName = contact.pushname || contact.name || contact.shortName || '';
      const messageText = (msg.body || '').trim();
      console.log('[BOT] Referencia WhatsApp visible:', visibleName || '(sin nombre visible)');

      const pendingReply = await handlePendingNameReply({ sheetsService, phoneNumber, messageText, timezone });
      if (pendingReply) {
        await msg.reply(pendingReply);
        return;
      }

      const phoneAttention = await sheetsService.findAttentionByPhone(phoneNumber);
      const canUpdateByPhone = phoneAttention.found && !isFinalState(phoneAttention.state);
      const rowData = canUpdateByPhone
        ? { solicitudesDetectadas: getSolicitudesFromRow(phoneAttention.headers, phoneAttention.currentRow) }
        : { solicitudesDetectadas: '' };
      const iaResult = await analyzeIncomingMessage({ messageText, contactName: visibleName, rowData });
      const detectedName = String(iaResult.nombre_detectado || '').trim();

      if (canUpdateByPhone) {
        const reply = await persistAttention({
          sheetsService,
          phoneNumber,
          messageText,
          iaResult,
          timezone,
          detectedName,
          existingAttention: phoneAttention
        });
        await msg.reply(reply);
        return;
      }

      if (phoneAttention.found && isFinalState(phoneAttention.state)) {
        console.log('[BOT] Atención finalizada detectada para este número.');
        const nameFromFinalAttention = phoneAttention.officialName;
        if (!detectedName && nameFromFinalAttention && hasRealLoanRequest(iaResult)) {
          const reply = await persistAttention({
            sheetsService,
            phoneNumber,
            messageText,
            iaResult: { ...iaResult, nombre_detectado: nameFromFinalAttention },
            timezone,
            detectedName: nameFromFinalAttention
          });
          await msg.reply(reply);
          return;
        }
      }

      if (!isLikelyFullName(detectedName)) {
        console.log('[BOT] Falta nombre completo.');
        if (hasRealLoanRequest(iaResult) || iaResult.respuesta_tipo === 'FALTA_NOMBRE') {
          savePending(phoneNumber, messageText, iaResult);
          await msg.reply(RESPONSES.FALTA_NOMBRE);
          return;
        }

        console.log('[BOT] Enviado a revisión humana sin registrar porque no hay solicitud clara ni nombre completo.');
        await msg.reply(RESPONSES.REVISION_HUMANA);
        return;
      }

      const reply = await persistAttention({
        sheetsService,
        phoneNumber,
        messageText,
        iaResult,
        timezone,
        detectedName
      });
      await msg.reply(reply);
    } catch (error) {
      console.error('[BOT] Error general:', error.message);
      try {
        await msg.reply(RESPONSES.REVISION_HUMANA);
      } catch (_) {}
    }
  });

  client.initialize();
  return client;
}

module.exports = { startWhatsappBot, pendingByPhone };
