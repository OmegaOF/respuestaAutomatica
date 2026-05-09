const fs = require('fs');
const path = require('path');
const { interpretMessage } = require('./ollamaService');
const { analyzeMessageByRules, buildSolicitudActualFromSolicitudes } = require('./ruleFallbackService');
const { getNowInTimeZone } = require('../utils/dateUtils');
const { isLikelyFullName } = require('../utils/textUtils');
const { validateRealPhone } = require('../utils/phoneUtils');
const { parseSolicitudesString, mergeSolicitudes, toSolicitudesString } = require('../utils/solicitudesUtils');
const { appendObservationLimited } = require('../utils/observationUtils');

const tiposPath = path.join(__dirname, '..', 'config', 'tiposSolicitud.json');
const CLEAN_STATES = ['NUEVO', 'PENDIENTE_DATOS', 'EN_REVISION', 'APROBADO', 'RECHAZADO', 'CERRADO'];
const ALLOWED_ACTIONS = ['AGREGAR', 'REEMPLAZAR', 'CANCELAR', 'ACTUALIZAR_MONTO', 'ACLARAR', 'NO_ENTENDIDO'];
const ALLOWED_MISSING = ['NOMBRE', 'TELEFONO', 'TIPO_SOLICITUD', 'MONTO', 'NINGUNO', 'AMBIGUO'];
const ALLOWED_CONFIDENCE = ['ALTA', 'MEDIA', 'BAJA'];
const ALLOWED_RESPONSE_TYPES = ['PEDIR_NOMBRE', 'PEDIR_TELEFONO', 'PEDIR_TIPO', 'PEDIR_MONTO', 'REGISTRADO', 'REVISION_HUMANA', 'SALUDO'];
const RESPONSE_TYPE_ALIASES = {
  FALTA_NOMBRE: 'PEDIR_NOMBRE',
  FALTA_TELEFONO: 'PEDIR_TELEFONO',
  FALTA_TIPO: 'PEDIR_TIPO',
  FALTA_MONTO: 'PEDIR_MONTO'
};
const PROTECTED_COLUMNS = ['CUOTA', 'Deuda General', 'BONO ABRIL', 'BONO JUNIO', 'AGUI', 'TOTAL'];

function loadTiposConfig() {
  return JSON.parse(fs.readFileSync(tiposPath, 'utf-8'));
}

function appendObservation(...observations) {
  return appendObservationLimited(...observations);
}

function getSolicitudesFromRow(headers, row) {
  const solicitudesIdx = headers.indexOf('SOLICITUDES_DETECTADAS');
  return solicitudesIdx >= 0 ? row[solicitudesIdx] || '' : '';
}

function hasDangerousReply(reply = '') {
  return /aprobado|pr[eé]stamo aprobado|desembolso confirmado|garantizado|ya puede cobrar|se le dar[aá]|tiene derecho|su deuda real es|su cuota real es/i.test(String(reply));
}

function describeSolicitudes(solicitudes = []) {
  if (!solicitudes.length) return 'tu solicitud';
  const labels = {
    DEUDA_GENERAL: 'deuda general',
    AGUINALDO: 'aguinaldo',
    BONO_ABRIL: 'bono abril',
    BONO_JUNIO: 'bono junio'
  };
  return solicitudes.map((item) => {
    const label = labels[item.tipo] || String(item.tipo || '').toLowerCase();
    return item.monto && item.monto !== 'NO_INDICADO' ? `${label} de ${item.monto} Bs` : label;
  }).join('; ');
}

function buildSafeReply(interpretation) {
  if (interpretation.respuesta_cliente && !hasDangerousReply(interpretation.respuesta_cliente)) return interpretation.respuesta_cliente;
  const solicitud = describeSolicitudes(interpretation.solicitudes);
  switch (interpretation.respuesta_tipo) {
    case 'PEDIR_NOMBRE':
      return `Con gusto te ayudamos. Registré tu solicitud por ${solicitud}; para continuar, por favor indícanos tu nombre completo.`;
    case 'PEDIR_TELEFONO':
      return `Gracias por escribirnos. Registré tu solicitud por ${solicitud}; para continuar, por favor indícanos tu número de celular.`;
    case 'PEDIR_TIPO':
      return 'Gracias. ¿Tu solicitud es por deuda general, aguinaldo o algún bono disponible?';
    case 'PEDIR_MONTO':
      return `Gracias. Registré tu consulta por ${solicitud}; ¿podrías indicarme el monto aproximado que deseas solicitar?`;
    case 'REGISTRADO':
      return 'Gracias. Registré tu solicitud y será revisada por un asesor.';
    case 'SALUDO':
      return 'Hola, gracias por escribirnos. ¿En qué podemos ayudarte con tu solicitud?';
    default:
      return 'Gracias por escribirnos. Para ayudarte correctamente, un asesor revisará tu mensaje.';
  }
}

function normalizeResponseType(value) {
  const normalized = RESPONSE_TYPE_ALIASES[value] || value;
  return ALLOWED_RESPONSE_TYPES.includes(normalized) ? normalized : 'REVISION_HUMANA';
}

function sanitizeInterpretation(raw = {}, config = loadTiposConfig()) {
  const action = ALLOWED_ACTIONS.includes(raw.accion) ? raw.accion : 'NO_ENTENDIDO';
  const responseType = normalizeResponseType(raw.respuesta_tipo);
  const allowedTypes = new Set(config.tiposSolicitudActivos || []);
  const solicitudes = Array.isArray(raw.solicitudes)
    ? raw.solicitudes
      .filter((item) => item && allowedTypes.has(String(item.tipo || '').trim()))
      .map((item) => ({
        tipo: String(item.tipo).trim(),
        monto: /^\d{3,7}$/.test(String(item.monto || '').trim()) ? String(item.monto).trim() : 'NO_INDICADO'
      }))
    : [];

  return {
    nombre_detectado: String(raw.nombre_detectado || '').trim(),
    telefono_detectado: String(raw.telefono_detectado || '').trim(),
    accion: action,
    solicitudes,
    dato_faltante: ALLOWED_MISSING.includes(raw.dato_faltante) ? raw.dato_faltante : 'NINGUNO',
    confianza: ALLOWED_CONFIDENCE.includes(raw.confianza) ? raw.confianza : 'MEDIA',
    solicitud_actual: String(raw.solicitud_actual || ''),
    observacion: String(raw.observacion || ''),
    requiere_humano: raw.requiere_humano === 'SI' ? 'SI' : 'NO',
    respuesta_tipo: responseType,
    respuesta_cliente: String(raw.respuesta_cliente || ''),
    error_tipo: raw.error_tipo || '',
    fallback_reglas: Boolean(raw.fallback_reglas)
  };
}

function resolvePhone({ whatsappIdentity = {}, interpretation = {}, currentRowContext = {} }) {
  const fromIA = validateRealPhone(interpretation.telefono_detectado || '');
  const fromWhatsApp = validateRealPhone(whatsappIdentity.realPhone || whatsappIdentity.phoneNumber || '');
  const fromCurrentRow = validateRealPhone(currentRowContext.phoneNumber || '');

  if (fromIA.isRealPhone) {
    return { phone: fromIA.normalizedPhone, shouldWritePhone: true, hasRealPhone: true, observation: 'Celular informado por el cliente.' };
  }
  if (fromWhatsApp.isRealPhone) {
    return { phone: fromWhatsApp.normalizedPhone, shouldWritePhone: true, hasRealPhone: true, observation: '' };
  }
  if (fromCurrentRow.isRealPhone) {
    return { phone: fromCurrentRow.normalizedPhone, shouldWritePhone: false, hasRealPhone: true, observation: '' };
  }

  return {
    phone: '',
    shouldWritePhone: false,
    hasRealPhone: false,
    observation: appendObservation(
      whatsappIdentity.technicalReference ? `Referencia técnica WhatsApp: ${whatsappIdentity.technicalReference}.` : '',
      'WhatsApp no entregó número real; se solicitó celular al cliente.'
    )
  };
}

async function resolveOfficialName({ sheetsService, currentRowContext, detectedName }) {
  const currentName = currentRowContext.officialName || '';
  if (currentName) return { officialName: currentName, requiresHuman: false, observation: '' };
  if (!isLikelyFullName(detectedName)) return { officialName: '', requiresHuman: false, observation: '' };

  const nameMatch = await sheetsService.findNameMatch(detectedName);
  if (nameMatch.ambiguous) {
    return {
      officialName: '',
      requiresHuman: true,
      observation: `Nombre detectado: ${detectedName}. Tiene múltiples coincidencias posibles en la lista interna. Revisar manualmente.`
    };
  }
  if (!nameMatch.found) {
    return {
      officialName: '',
      requiresHuman: true,
      observation: `Nombre detectado: ${detectedName}. No coincide con la lista interna. Revisar manualmente.`
    };
  }
  return { officialName: nameMatch.officialName, requiresHuman: false, observation: '' };
}

function determineNextQuestion({ interpretation, mergedSolicitudes, hasName, hasRealPhone, requiresHuman }) {
  if (requiresHuman || interpretation.dato_faltante === 'AMBIGUO' || interpretation.confianza === 'BAJA') {
    return { respuesta_tipo: 'REVISION_HUMANA', estado: 'EN_REVISION', requiere_humano: 'SI', dato_faltante: 'AMBIGUO' };
  }
  if (!hasName) return { respuesta_tipo: 'PEDIR_NOMBRE', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'NOMBRE' };
  if (!hasRealPhone) return { respuesta_tipo: 'PEDIR_TELEFONO', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'TELEFONO' };
  if (!Object.keys(mergedSolicitudes).length) return { respuesta_tipo: 'PEDIR_TIPO', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'TIPO_SOLICITUD' };
  if (Object.values(mergedSolicitudes).some((monto) => !monto || monto === 'NO_INDICADO')) {
    return { respuesta_tipo: 'PEDIR_MONTO', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'MONTO' };
  }
  return { respuesta_tipo: 'REGISTRADO', estado: 'NUEVO', requiere_humano: 'NO', dato_faltante: 'NINGUNO' };
}

async function getInterpretation({ combinedMessage, messages, rowData, contactName, interpretFn = interpretMessage, ruleAnalyzeFn = analyzeMessageByRules }) {
  const iaResult = await interpretFn({
    message: combinedMessage,
    mensaje_combinado: combinedMessage,
    mensajes_recientes: messages,
    contactName,
    previousSolicitudes: rowData.solicitudesDetectadas,
    estado_actual: rowData.estadoActual,
    observaciones: rowData.observaciones,
    falta_nombre: rowData.faltaNombre,
    falta_telefono: rowData.faltaTelefono,
    falta_monto: rowData.faltaMonto,
    falta_tipo: rowData.faltaTipo
  });

  if (iaResult.error_tipo || iaResult.accion === 'NO_ENTENDIDO') {
    const ruleResult = ruleAnalyzeFn({ messageText: combinedMessage, previousSolicitudes: rowData.solicitudesDetectadas });
    if (ruleResult.matched) {
      return {
        ...ruleResult,
        observacion: appendObservation(iaResult.observacion, ruleResult.observacion),
        error_tipo: iaResult.error_tipo || '',
        fallback_reglas: true
      };
    }
  }
  return iaResult;
}

function buildUpdates({ combinedMessage, timezone, currentRowContext, interpretation, mergedSolicitudes, phone, name, next }) {
  const updates = {
    ULTIMO_MENSAJE: combinedMessage,
    SOLICITUD_ACTUAL: interpretation.solicitud_actual,
    SOLICITUDES_DETECTADAS: toSolicitudesString(mergedSolicitudes),
    ESTADO_CHATBOT: next.estado,
    FECHA_ULTIMO_CONTACTO: getNowInTimeZone(timezone),
    REQUIERE_HUMANO: next.requiere_humano,
    OBSERVACIONES: appendObservation(currentRowContext.observations, interpretation.observacion)
  };

  if (phone.shouldWritePhone) updates.NUMERO_WHATSAPP = phone.phone;
  if (name.officialName && !currentRowContext.officialName) updates['NOMBRE DE CLIENTE'] = name.officialName;

  PROTECTED_COLUMNS.forEach((column) => delete updates[column]);
  return updates;
}

async function orchestrateConversation({ sheetsService, combinedMessage, messages, whatsappIdentity, currentRowContext, timezone, contactName, interpretFn, ruleAnalyzeFn }) {
  const rowData = {
    solicitudesDetectadas: currentRowContext.solicitudesDetectadas || '',
    estadoActual: currentRowContext.state || '',
    observaciones: currentRowContext.observations || '',
    faltaNombre: !currentRowContext.officialName,
    faltaTelefono: !validateRealPhone(currentRowContext.phoneNumber || whatsappIdentity?.realPhone || whatsappIdentity?.phoneNumber || '').isRealPhone,
    faltaMonto: false,
    faltaTipo: !currentRowContext.solicitudesDetectadas
  };
  const rawInterpretation = await getInterpretation({ combinedMessage, messages, rowData, contactName, interpretFn, ruleAnalyzeFn });
  let interpretation = sanitizeInterpretation(rawInterpretation);
  const phone = resolvePhone({ whatsappIdentity, interpretation, currentRowContext });
  const name = await resolveOfficialName({ sheetsService, currentRowContext, detectedName: interpretation.nombre_detectado });
  const prevMap = parseSolicitudesString(currentRowContext.solicitudesDetectadas || '');
  const mergedSolicitudes = mergeSolicitudes(prevMap, interpretation);
  const solicitudesList = Object.entries(mergedSolicitudes).map(([tipo, monto]) => ({ tipo, monto }));
  const hasName = Boolean(name.officialName);
  const next = determineNextQuestion({ interpretation, mergedSolicitudes, hasName, hasRealPhone: phone.hasRealPhone, requiresHuman: name.requiresHuman });

  interpretation = {
    ...interpretation,
    solicitudes: solicitudesList,
    respuesta_tipo: next.respuesta_tipo,
    dato_faltante: next.dato_faltante,
    requiere_humano: next.requiere_humano,
    solicitud_actual: buildSolicitudActualFromSolicitudes(solicitudesList),
    observacion: appendObservation(interpretation.observacion, phone.observation, name.observation)
  };

  const updates = buildUpdates({ combinedMessage, timezone, currentRowContext, interpretation, mergedSolicitudes, phone, name, next });

  return {
    interpretation,
    updates,
    reply: buildSafeReply(interpretation),
    shouldSavePendingName: next.respuesta_tipo === 'PEDIR_NOMBRE',
    phone,
    name,
    next
  };
}

function buildCurrentRowContext(sheetsService, attention) {
  return {
    headers: attention.headers,
    rowIndex: attention.rowIndex,
    currentRow: attention.currentRow,
    state: CLEAN_STATES.includes(attention.state) ? attention.state : '',
    officialName: attention.officialName || sheetsService.getRowName(attention.headers, attention.currentRow),
    phoneNumber: sheetsService.getRowPhone(attention.headers, attention.currentRow),
    observations: sheetsService.getRowObservations(attention.headers, attention.currentRow),
    solicitudesDetectadas: getSolicitudesFromRow(attention.headers, attention.currentRow)
  };
}

module.exports = {
  orchestrateConversation,
  buildCurrentRowContext,
  sanitizeInterpretation,
  determineNextQuestion,
  buildSafeReply,
  buildUpdates,
  resolvePhone,
  appendObservation,
  CLEAN_STATES,
  PROTECTED_COLUMNS
};
