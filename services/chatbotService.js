const { interpretMessage } = require('./ollamaService');
const { getNowInTimeZone } = require('../utils/dateUtils');
const { parseSolicitudesString, mergeSolicitudes, toSolicitudesString, hasClearSolicitudes } = require('../utils/solicitudesUtils');
const { analyzeMessageByRules } = require('./ruleFallbackService');
const { appendObservationLimited } = require('../utils/observationUtils');

const RESPONSES = {
  REGISTRADO: 'Gracias por escribirnos. Registré tu solicitud y será revisada por un asesor.',
  FALTA_NOMBRE: 'Con gusto te ayudamos. ¿Podrías indicarme tu nombre completo para registrar tu solicitud?',
  FALTA_MONTO: 'Gracias. ¿Podrías indicarme el monto aproximado que deseas solicitar?',
  REVISION_HUMANA: 'Gracias por escribirnos. Tu mensaje será revisado por un asesor para ayudarte correctamente.',
  SALUDO: 'Hola, gracias por escribirnos. ¿En qué podemos ayudarte con tu solicitud?',
  FALTA_TELEFONO: 'Gracias. Para registrar correctamente tu solicitud, por favor indícanos tu número de celular.',
  FALTA_TIPO: 'Gracias. ¿Tu solicitud es por deuda general, aguinaldo o algún bono disponible?',
  PEDIR_NOMBRE: 'Con gusto te ayudamos. ¿Podrías indicarme tu nombre completo para registrar tu solicitud?',
  PEDIR_TELEFONO: 'Gracias. Para registrar correctamente tu solicitud, por favor indícanos tu número de celular.',
  PEDIR_TIPO: 'Gracias. ¿Tu solicitud es por deuda general, aguinaldo o algún bono disponible?',
  PEDIR_MONTO: 'Gracias. ¿Podrías indicarme el monto aproximado que deseas solicitar?'
};

function resolveStatus(iaResult) {
  const hasMissingAmount = Array.isArray(iaResult.solicitudes) && iaResult.solicitudes.some((item) => String(item?.monto || '').trim() === 'NO_INDICADO');
  if (['FALTA_NOMBRE', 'FALTA_TELEFONO', 'FALTA_TIPO', 'PEDIR_NOMBRE', 'PEDIR_TELEFONO', 'PEDIR_TIPO'].includes(iaResult.respuesta_tipo)) return 'PENDIENTE_DATOS';
  if (['FALTA_MONTO', 'PEDIR_MONTO'].includes(iaResult.respuesta_tipo) || hasMissingAmount) return 'PENDIENTE_DATOS';
  if (iaResult.accion === 'ACLARAR') return 'PENDIENTE_DATOS';
  if (iaResult.requiere_humano === 'SI' || iaResult.accion === 'NO_ENTENDIDO') return 'EN_REVISION';
  return 'NUEVO';
}

function hasRealLoanRequest(iaResult) {
  return ['AGREGAR', 'REEMPLAZAR', 'ACTUALIZAR_MONTO', 'CANCELAR'].includes(iaResult.accion) && hasClearSolicitudes(iaResult);
}

function appendObservation(...observations) {
  return appendObservationLimited(...observations);
}

async function analyzeIncomingMessage({ messageText, contactName, rowData, mensajesRecientes = [] }) {
  console.log('[BOT] Mensaje combinado a analizar:', messageText);
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const iaResult = await interpretMessage({
    message: messageText,
    mensaje_combinado: messageText,
    mensajes_recientes: mensajesRecientes.length ? mensajesRecientes : [messageText],
    contactName,
    previousSolicitudes: prevSolicitudes,
    estado_actual: rowData?.estadoActual || '',
    observaciones: rowData?.observaciones || '',
    falta_nombre: rowData?.faltaNombre || false,
    falta_telefono: rowData?.faltaTelefono || false,
    falta_monto: rowData?.faltaMonto || false,
    falta_tipo: rowData?.faltaTipo || false
  });
  const shouldUseRules = iaResult.error_tipo || iaResult.accion === 'NO_ENTENDIDO';
  if (shouldUseRules) {
    const ruleResult = analyzeMessageByRules({ messageText, previousSolicitudes: prevSolicitudes });
    if (ruleResult.matched) {
      console.log('[BOT] Fallback por reglas detectó:', ruleResult.solicitud_actual);
      return {
        ...ruleResult,
        observacion: appendObservation(iaResult.observacion, ruleResult.observacion),
        error_tipo: iaResult.error_tipo || '',
        fallback_reglas: true
      };
    }
  }

  console.log('[BOT] nombre_detectado por IA:', iaResult.nombre_detectado || '(vacío)');
  console.log('[BOT] Acción detectada por IA:', iaResult.accion);
  return iaResult;
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

function buildSafeReply(iaResult) {
  if (iaResult.respuesta_cliente && !hasDangerousReply(iaResult.respuesta_cliente)) return iaResult.respuesta_cliente;
  const solicitud = describeSolicitudes(iaResult.solicitudes);
  switch (iaResult.respuesta_tipo) {
    case 'PEDIR_NOMBRE':
    case 'FALTA_NOMBRE':
      return `Con gusto te ayudamos. Registré tu solicitud por ${solicitud}; para continuar, por favor indícanos tu nombre completo.`;
    case 'PEDIR_TELEFONO':
    case 'FALTA_TELEFONO':
      return `Gracias por escribirnos. Registré tu solicitud por ${solicitud}; para continuar, por favor indícanos tu número de celular.`;
    case 'PEDIR_TIPO':
    case 'FALTA_TIPO':
      return RESPONSES.FALTA_TIPO;
    case 'PEDIR_MONTO':
    case 'FALTA_MONTO':
      return `Gracias. Registré tu consulta por ${solicitud}; ¿podrías indicarme el monto aproximado que deseas solicitar?`;
    case 'REGISTRADO':
      return RESPONSES.REGISTRADO;
    case 'SALUDO':
      return RESPONSES.SALUDO;
    default:
      return RESPONSES.REVISION_HUMANA;
  }
}

function buildUpdatesFromIA({ iaResult, messageText, phoneNumber, timezone, rowData, observations, forceHumanReview = false }) {
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const prevMap = parseSolicitudesString(prevSolicitudes);

  if (iaResult.error_tipo === 'TIMEOUT_IA' && !iaResult.fallback_reglas) {
    iaResult.accion = 'NO_ENTENDIDO';
    iaResult.requiere_humano = 'SI';
    iaResult.respuesta_tipo = 'REVISION_HUMANA';
    iaResult.observacion = appendObservation(iaResult.observacion, 'IA no respondió y no se pudo interpretar por reglas.');
  } else if (iaResult.accion === 'NO_ENTENDIDO' && !iaResult.fallback_reglas && !['FALTA_NOMBRE', 'FALTA_TELEFONO', 'FALTA_TIPO', 'PEDIR_NOMBRE', 'PEDIR_TELEFONO', 'PEDIR_TIPO', 'PEDIR_MONTO'].includes(iaResult.respuesta_tipo)) {
    iaResult.requiere_humano = 'SI';
    iaResult.respuesta_tipo = 'REVISION_HUMANA';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Solicitud no entendida. Revisar manualmente.');
  }

  if (['FALTA_NOMBRE', 'PEDIR_NOMBRE'].includes(iaResult.respuesta_tipo)) {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta nombre completo. Se solicitó al cliente.');
  }

  if (['FALTA_TELEFONO', 'PEDIR_TELEFONO'].includes(iaResult.respuesta_tipo)) {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta número real de celular. Se solicitó al cliente.');
  }

  if (['FALTA_TIPO', 'PEDIR_TIPO'].includes(iaResult.respuesta_tipo)) {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta tipo de solicitud. Se solicitó aclaración al cliente.');
  }

  if (['FALTA_MONTO', 'PEDIR_MONTO'].includes(iaResult.respuesta_tipo)) {
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta monto aproximado.');
  }

  if (iaResult.accion === 'REEMPLAZAR' && !hasClearSolicitudes(iaResult)) {
    iaResult.accion = 'NO_ENTENDIDO';
    iaResult.requiere_humano = 'SI';
    iaResult.respuesta_tipo = 'REVISION_HUMANA';
    iaResult.observacion = appendObservation(
      iaResult.observacion,
      'La IA no pudo reemplazar la solicitud con seguridad; no se borraron solicitudes previas.'
    );
    console.log('[BOT] Enviado a revisión humana por REEMPLAZAR inválido.');
  }

  const requiereHumano = forceHumanReview ? 'SI' : iaResult.requiere_humano || 'NO';

  const merged = mergeSolicitudes(prevMap, iaResult);
  const updates = {
    NUMERO_WHATSAPP: phoneNumber,
    ULTIMO_MENSAJE: messageText,
    SOLICITUD_ACTUAL: iaResult.solicitud_actual || 'Solicitud recibida. Pendiente de revisión.',
    SOLICITUDES_DETECTADAS: toSolicitudesString(merged),
    ESTADO_CHATBOT: resolveStatus(iaResult),
    FECHA_ULTIMO_CONTACTO: getNowInTimeZone(timezone),
    REQUIERE_HUMANO: requiereHumano,
    OBSERVACIONES: appendObservation(observations, iaResult.observacion)
  };

  if (updates.REQUIERE_HUMANO === 'SI' || updates.ESTADO_CHATBOT === 'EN_REVISION') {
    console.log('[BOT] Enviado a revisión humana.');
  }

  const reply = buildSafeReply(iaResult);
  return { updates, reply, iaResult };
}

module.exports = {
  analyzeIncomingMessage,
  buildUpdatesFromIA,
  hasRealLoanRequest,
  RESPONSES,
  appendObservation,
  buildSafeReply
};
