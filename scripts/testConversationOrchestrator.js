const assert = require('assert');
const {
  orchestrateConversation,
  buildCurrentRowContext,
  CLEAN_STATES,
  PROTECTED_COLUMNS
} = require('../services/conversationOrchestrator');
const { normalizeText, normalizePhone } = require('../utils/textUtils');
const { appendObservationLimited } = require('../utils/observationUtils');
const { validateRealPhone } = require('../utils/phoneUtils');

const HEADERS = [
  'OBSERVACIONES',
  'NOMBRE DE CLIENTE',
  'NUMERO_WHATSAPP',
  'ULTIMO_MENSAJE',
  'SOLICITUD_ACTUAL',
  'SOLICITUDES_DETECTADAS',
  'ESTADO_CHATBOT',
  'FECHA_ULTIMO_CONTACTO',
  'REQUIERE_HUMANO',
  'CUOTA',
  'Deuda General',
  'BONO ABRIL',
  'BONO JUNIO',
  'AGUI',
  'TOTAL'
];

function rowFrom(values = {}) {
  const row = new Array(HEADERS.length).fill('');
  Object.entries(values).forEach(([key, value]) => {
    row[HEADERS.indexOf(key)] = value;
  });
  return row;
}

class FakeSheetsService {
  constructor(rows = []) {
    this.headers = [...HEADERS];
    this.rows = rows;
  }

  getRowName(headers, row) {
    return String(row[headers.indexOf('NOMBRE DE CLIENTE')] || '').trim();
  }

  getRowPhone(headers, row) {
    return normalizePhone(row[headers.indexOf('NUMERO_WHATSAPP')] || '');
  }

  getRowState(headers, row) {
    return normalizeText(row[headers.indexOf('ESTADO_CHATBOT')] || '');
  }

  getRowObservations(headers, row) {
    return String(row[headers.indexOf('OBSERVACIONES')] || '').trim();
  }

  async findNameMatch(name) {
    const normalized = normalizeText(name);
    const matches = this.rows
      .map((row, index) => ({ row, index, officialName: this.getRowName(this.headers, row) }))
      .filter((item) => normalizeText(item.officialName) === normalized);
    if (!matches.length) return { found: false, ambiguous: false, headers: this.headers };
    return { found: true, ambiguous: false, headers: this.headers, officialName: matches[0].officialName };
  }

  findActiveRowByPhone(phoneNumber) {
    const normalizedPhone = normalizePhone(phoneNumber);
    const matches = this.rows
      .map((row, index) => ({ row, index, state: this.getRowState(this.headers, row) }))
      .filter((item) => normalizedPhone && this.getRowPhone(this.headers, item.row) === normalizedPhone);
    const active = matches.find((item) => !['APROBADO', 'RECHAZADO', 'CERRADO'].includes(item.state));
    return active || matches[matches.length - 1] || null;
  }

  findActiveRowByTechnicalReference(identifier) {
    const normalizedIdentifier = normalizePhone(identifier);
    return this.rows
      .map((row, index) => ({ row, index, state: this.getRowState(this.headers, row) }))
      .find((item) => normalizedIdentifier
        && !['APROBADO', 'RECHAZADO', 'CERRADO'].includes(item.state)
        && this.getRowObservations(this.headers, item.row).includes(`Referencia técnica WhatsApp: ${normalizedIdentifier}`));
  }

  async upsertMinimalAttentionByPhone({ phoneNumber, messageText, timezone, observations = '', lookupIdentifiers = [] }) {
    let found = this.findActiveRowByPhone(phoneNumber);
    if (!found) {
      for (const identifier of lookupIdentifiers) {
        found = this.findActiveRowByTechnicalReference(identifier);
        if (found) break;
      }
    }

    let row;
    let created = false;
    if (found && !['APROBADO', 'RECHAZADO', 'CERRADO'].includes(found.state)) {
      row = found.row;
    } else {
      row = rowFrom({});
      this.rows.push(row);
      found = { row, index: this.rows.length - 1 };
      created = true;
    }

    const updates = {
      ULTIMO_MENSAJE: messageText,
      ESTADO_CHATBOT: 'NUEVO',
      FECHA_ULTIMO_CONTACTO: timezone,
      REQUIERE_HUMANO: 'NO',
      OBSERVACIONES: appendObservationLimited(this.getRowObservations(this.headers, row), observations)
    };
    const validPhone = validateRealPhone(phoneNumber);
    if (validPhone.isRealPhone) updates.NUMERO_WHATSAPP = validPhone.normalizedPhone;
    await this.updateAllowedColumns({ headers: this.headers, rowIndex: found.index + 2, currentRow: row, updates });

    return {
      found: true,
      created,
      headers: this.headers,
      rowIndex: found.index + 2,
      currentRow: row,
      state: this.getRowState(this.headers, row),
      officialName: this.getRowName(this.headers, row)
    };
  }

  async updateAllowedColumns({ headers, rowIndex, currentRow, updates }) {
    const allowed = new Set(['OBSERVACIONES', 'NOMBRE DE CLIENTE', 'NUMERO_WHATSAPP', 'ULTIMO_MENSAJE', 'SOLICITUD_ACTUAL', 'SOLICITUDES_DETECTADAS', 'ESTADO_CHATBOT', 'FECHA_ULTIMO_CONTACTO', 'REQUIERE_HUMANO']);
    Object.entries(updates).forEach(([key, value]) => {
      if (!allowed.has(key) || PROTECTED_COLUMNS.includes(key) || value === undefined) return;
      const idx = headers.indexOf(key);
      if (idx >= 0) currentRow[idx] = value;
    });
    return { rowIndex, currentRow };
  }
}

const iaNoEntendido = async () => ({
  nombre_detectado: '',
  telefono_detectado: '',
  accion: 'NO_ENTENDIDO',
  solicitudes: [],
  dato_faltante: 'AMBIGUO',
  confianza: 'BAJA',
  solicitud_actual: 'No entendido por IA.',
  observacion: 'IA no interpretó.',
  requiere_humano: 'SI',
  respuesta_tipo: 'REVISION_HUMANA',
  respuesta_cliente: '',
  error_tipo: 'ERROR_IA'
});

function get(row, header) {
  return row[HEADERS.indexOf(header)];
}

async function runBlock({ sheet, attention, messages, whatsappIdentity, contactName = 'Nombre Visible' }) {
  const combinedMessage = messages.join(' ');
  const currentRowContext = buildCurrentRowContext(sheet, attention);
  const decision = await orchestrateConversation({
    sheetsService: sheet,
    combinedMessage,
    messages,
    whatsappIdentity,
    currentRowContext,
    timezone: 'America/La_Paz',
    contactName,
    interpretFn: iaNoEntendido
  });
  await sheet.updateAllowedColumns({ headers: attention.headers, rowIndex: attention.rowIndex, currentRow: attention.currentRow, updates: decision.updates });
  return decision;
}

(async () => {
  const existingComplete = rowFrom({
    'NOMBRE DE CLIENTE': 'Juan Perez',
    NUMERO_WHATSAPP: '76543210',
    ESTADO_CHATBOT: 'NUEVO',
    CUOTA: 'PROTEGIDA',
    'Deuda General': 'PROTEGIDA',
    'BONO ABRIL': 'PROTEGIDA',
    'BONO JUNIO': 'PROTEGIDA',
    AGUI: 'PROTEGIDA',
    TOTAL: 'PROTEGIDA'
  });
  const sheet = new FakeSheetsService([existingComplete]);
  const attention = { headers: HEADERS, rowIndex: 2, currentRow: existingComplete, state: 'NUEVO', officialName: 'Juan Perez' };

  const partsDecision = await runBlock({
    sheet,
    attention,
    messages: ['Quiero por la deuda general', '3000'],
    whatsappIdentity: { hasRealPhone: true, realPhone: '76543210', phoneNumber: '76543210', technicalReference: '' }
  });
  assert.strictEqual(partsDecision.interpretation.dato_faltante, 'NINGUNO', 'mensajes por partes deben completar tipo y monto');
  assert.strictEqual(get(existingComplete, 'SOLICITUDES_DETECTADAS'), 'DEUDA_GENERAL=3000', 'deuda general con monto debe guardarse');

  const aguinaldoRow = rowFrom({ 'NOMBRE DE CLIENTE': 'Juan Perez', NUMERO_WHATSAPP: '76543210', ESTADO_CHATBOT: 'NUEVO' });
  const aguinaldoSheet = new FakeSheetsService([aguinaldoRow]);
  await runBlock({
    sheet: aguinaldoSheet,
    attention: { headers: HEADERS, rowIndex: 2, currentRow: aguinaldoRow, state: 'NUEVO', officialName: 'Juan Perez' },
    messages: ['Necesito aguinaldo de 1500'],
    whatsappIdentity: { hasRealPhone: true, realPhone: '76543210', phoneNumber: '76543210', technicalReference: '' }
  });
  assert.strictEqual(get(aguinaldoRow, 'SOLICITUDES_DETECTADAS'), 'AGUINALDO=1500', 'aguinaldo con monto debe guardarse');

  const bonosRow = rowFrom({ 'NOMBRE DE CLIENTE': 'Juan Perez', NUMERO_WHATSAPP: '76543210', ESTADO_CHATBOT: 'NUEVO' });
  const bonosSheet = new FakeSheetsService([bonosRow]);
  await runBlock({
    sheet: bonosSheet,
    attention: { headers: HEADERS, rowIndex: 2, currentRow: bonosRow, state: 'NUEVO', officialName: 'Juan Perez' },
    messages: ['Quiero bono abril 1000 y bono junio 1200'],
    whatsappIdentity: { hasRealPhone: true, realPhone: '76543210', phoneNumber: '76543210', technicalReference: '' }
  });
  assert.strictEqual(get(bonosRow, 'SOLICITUDES_DETECTADAS'), 'BONO_ABRIL=1000; BONO_JUNIO=1200', 'bono abril y junio con montos deben guardarse');

  const missingNameRow = rowFrom({ NUMERO_WHATSAPP: '76543210', ESTADO_CHATBOT: 'NUEVO' });
  const missingNameSheet = new FakeSheetsService([missingNameRow]);
  const missingNameDecision = await runBlock({
    sheet: missingNameSheet,
    attention: { headers: HEADERS, rowIndex: 2, currentRow: missingNameRow, state: 'NUEVO', officialName: '' },
    messages: ['Quiero deuda general de 3000'],
    whatsappIdentity: { hasRealPhone: true, realPhone: '76543210', phoneNumber: '76543210', technicalReference: '' },
    contactName: 'Maria Visible'
  });
  assert.strictEqual(missingNameDecision.interpretation.dato_faltante, 'NOMBRE', 'falta de nombre debe marcar NOMBRE');
  assert.strictEqual(get(missingNameRow, 'NOMBRE DE CLIENTE'), '', 'nombre visible de WhatsApp no debe guardarse como cliente');
  assert.match(missingNameDecision.reply, /nombre completo/i, 'debe pedir nombre completo');

  const missingPhoneRow = rowFrom({ 'NOMBRE DE CLIENTE': 'Juan Perez', ESTADO_CHATBOT: 'NUEVO' });
  const missingPhoneSheet = new FakeSheetsService([missingPhoneRow]);
  const missingPhoneDecision = await runBlock({
    sheet: missingPhoneSheet,
    attention: { headers: HEADERS, rowIndex: 2, currentRow: missingPhoneRow, state: 'NUEVO', officialName: 'Juan Perez' },
    messages: ['Quiero aguinaldo de 1500'],
    whatsappIdentity: { hasRealPhone: false, realPhone: '', phoneNumber: '', technicalReference: '999999999999999' }
  });
  assert.strictEqual(missingPhoneDecision.interpretation.dato_faltante, 'TELEFONO', 'falta de celular real debe marcar TELEFONO');
  assert.strictEqual(get(missingPhoneRow, 'NUMERO_WHATSAPP'), '', 'sin celular real no debe escribirse NUMERO_WHATSAPP');
  assert.match(get(missingPhoneRow, 'OBSERVACIONES'), /Referencia técnica WhatsApp: 999999999999999/, 'ID interno debe quedar solo en observaciones');

  const internalSheet = new FakeSheetsService([]);
  const internalAttention = await internalSheet.upsertMinimalAttentionByPhone({
    phoneNumber: '',
    messageText: 'Quiero bono abril 1000',
    timezone: 'America/La_Paz',
    lookupIdentifiers: ['123456789012345'],
    observations: 'Referencia WhatsApp visible: Cliente Visible. Referencia técnica WhatsApp: 123456789012345.'
  });
  assert.strictEqual(get(internalAttention.currentRow, 'NUMERO_WHATSAPP'), '', 'ID interno no debe guardarse como NUMERO_WHATSAPP');
  assert.match(get(internalAttention.currentRow, 'OBSERVACIONES'), /Referencia técnica WhatsApp: 123456789012345/, 'ID interno debe conservarse como referencia técnica');

  const closedRow = rowFrom({ 'NOMBRE DE CLIENTE': 'Juan Perez', NUMERO_WHATSAPP: '76543210', ESTADO_CHATBOT: 'CERRADO' });
  const closedSheet = new FakeSheetsService([closedRow]);
  const newAttention = await closedSheet.upsertMinimalAttentionByPhone({
    phoneNumber: '76543210',
    messageText: 'Necesito deuda general 3000',
    timezone: 'America/La_Paz',
    observations: 'Mensaje recibido. Pendiente de análisis.'
  });
  assert.strictEqual(newAttention.created, true, 'atención cerrada debe crear nueva línea');
  assert.strictEqual(closedSheet.rows.length, 2, 'debe existir una nueva fila además de la cerrada');

  const cleanStates = [partsDecision, missingNameDecision, missingPhoneDecision]
    .map((decision) => decision.updates.ESTADO_CHATBOT);
  cleanStates.forEach((state) => assert.ok(CLEAN_STATES.includes(state), `estado limpio esperado, recibido ${state}`));

  await sheet.updateAllowedColumns({
    headers: HEADERS,
    rowIndex: 2,
    currentRow: existingComplete,
    updates: {
      CUOTA: 'ALTERADA',
      'Deuda General': 'ALTERADA',
      'BONO ABRIL': 'ALTERADA',
      'BONO JUNIO': 'ALTERADA',
      AGUI: 'ALTERADA',
      TOTAL: 'ALTERADA'
    }
  });
  PROTECTED_COLUMNS.forEach((column) => {
    assert.strictEqual(get(existingComplete, column), 'PROTEGIDA', `columna protegida ${column} no debe modificarse`);
  });

  console.log('OK: pruebas integrales de conversationOrchestrator superadas.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
