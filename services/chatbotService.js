const { interpretMessage } = require('./ollamaService');
const { getNowInTimeZone } = require('../utils/dateUtils');
const { parseSolicitudesString, mergeSolicitudes, toSolicitudesString, hasClearSolicitudes } = require('../utils/solicitudesUtils');
const { analyzeMessageByRules } = require('./ruleFallbackService');

const RESPONSES = {
  REGISTRADO: 'Gracias por escribirnos. Registré tu solicitud y será revisada por un asesor.',
  FALTA_NOMBRE: 'Con gusto te ayudamos. ¿Podrías indicarme tu nombre completo para registrar tu solicitud?',
  FALTA_MONTO: 'Gracias. ¿Podrías indicarme el monto aproximado que deseas solicitar?',
  REVISION_HUMANA: 'Gracias por escribirnos. Tu mensaje será revisado por un asesor para ayudarte correctamente.',
  SALUDO: 'Hola, gracias por escribirnos. ¿En qué podemos ayudarte con tu solicitud?',
  FALTA_TELEFONO: 'Gracias. Para registrar correctamente tu solicitud, por favor indícanos tu número de celular.',
  FALTA_TIPO: 'Gracias. ¿Tu solicitud es por deuda general, aguinaldo o algún bono disponible?'
};

function resolveStatus(iaResult) {
  const hasMissingAmount = Array.isArray(iaResult.solicitudes) && iaResult.solicitudes.some((item) => String(item?.monto || '').trim() === 'NO_INDICADO');
  if (['FALTA_NOMBRE', 'FALTA_TELEFONO', 'FALTA_TIPO'].includes(iaResult.respuesta_tipo)) return 'PENDIENTE_DATOS';
  if (iaResult.respuesta_tipo === 'FALTA_MONTO' || hasMissingAmount) return 'PENDIENTE_DATOS';
  if (iaResult.accion === 'ACLARAR') return 'PENDIENTE_DATOS';
  if (iaResult.requiere_humano === 'SI' || iaResult.accion === 'NO_ENTENDIDO') return 'EN_REVISION';
  return 'NUEVO';
}

function hasRealLoanRequest(iaResult) {
  return ['AGREGAR', 'REEMPLAZAR', 'ACTUALIZAR_MONTO', 'CANCELAR'].includes(iaResult.accion) && hasClearSolicitudes(iaResult);
}

function appendObservation(...observations) {
  const parts = observations.map((part) => String(part || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' ');
}

async function analyzeIncomingMessage({ messageText, contactName, rowData }) {
  console.log('[BOT] Mensaje recibido:', messageText);
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const iaResult = await interpretMessage({ message: messageText, contactName, previousSolicitudes: prevSolicitudes });
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

function buildUpdatesFromIA({ iaResult, messageText, phoneNumber, timezone, rowData, observations, forceHumanReview = false }) {
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const prevMap = parseSolicitudesString(prevSolicitudes);

  if (iaResult.error_tipo === 'TIMEOUT_IA' && !iaResult.fallback_reglas) {
    iaResult.accion = 'NO_ENTENDIDO';
    iaResult.requiere_humano = 'SI';
    iaResult.respuesta_tipo = 'REVISION_HUMANA';
    iaResult.observacion = appendObservation(iaResult.observacion, 'IA no respondió y no se pudo interpretar por reglas.');
  } else if (iaResult.accion === 'NO_ENTENDIDO' && !iaResult.fallback_reglas && !['FALTA_NOMBRE', 'FALTA_TELEFONO', 'FALTA_TIPO'].includes(iaResult.respuesta_tipo)) {
    iaResult.requiere_humano = 'SI';
    iaResult.respuesta_tipo = 'REVISION_HUMANA';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Solicitud no entendida. Revisar manualmente.');
  }

  if (iaResult.respuesta_tipo === 'FALTA_NOMBRE') {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta nombre completo. Se solicitó al cliente.');
  }

  if (iaResult.respuesta_tipo === 'FALTA_TELEFONO') {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta número real de celular. Se solicitó al cliente.');
  }

  if (iaResult.respuesta_tipo === 'FALTA_TIPO') {
    iaResult.requiere_humano = 'NO';
    iaResult.observacion = appendObservation(iaResult.observacion, 'Falta tipo de solicitud. Se solicitó aclaración al cliente.');
  }

  if (iaResult.respuesta_tipo === 'FALTA_MONTO') {
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

  const reply = RESPONSES[iaResult.respuesta_tipo] || RESPONSES.REVISION_HUMANA;
  return { updates, reply, iaResult };
}

module.exports = {
  analyzeIncomingMessage,
  buildUpdatesFromIA,
  hasRealLoanRequest,
  RESPONSES,
  appendObservation
};
