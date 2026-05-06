const { interpretMessage } = require('./ollamaService');
const { getNowInTimeZone } = require('../utils/dateUtils');
const { parseSolicitudesString, mergeSolicitudes, toSolicitudesString, hasClearSolicitudes } = require('../utils/solicitudesUtils');

const RESPONSES = {
  REGISTRADO: 'Gracias por escribirnos. Registré tu solicitud y será revisada por un asesor.',
  FALTA_NOMBRE: 'Con gusto te ayudamos. ¿Podrías indicarme tu nombre completo para registrar tu solicitud?',
  FALTA_MONTO: 'Gracias. ¿Podrías indicarme el monto aproximado que deseas solicitar?',
  REVISION_HUMANA: 'Gracias por escribirnos. Tu mensaje será revisado por un asesor para ayudarte correctamente.',
  SALUDO: 'Hola, gracias por escribirnos. ¿En qué podemos ayudarte con tu solicitud?'
};

function resolveStatus(iaResult) {
  const hasMissingAmount = Array.isArray(iaResult.solicitudes) && iaResult.solicitudes.some((item) => String(item?.monto || '').trim() === 'NO_INDICADO');
  if (iaResult.respuesta_tipo === 'FALTA_MONTO' || hasMissingAmount) return 'PENDIENTE_DATOS';
  if (iaResult.accion === 'ACLARAR') return 'PENDIENTE_DATOS';
  if (iaResult.requiere_humano === 'SI' || iaResult.accion === 'NO_ENTENDIDO') return 'EN_REVISION';
  return 'NUEVO';
}

function hasRealLoanRequest(iaResult) {
  return ['AGREGAR', 'REEMPLAZAR', 'ACTUALIZAR_MONTO', 'CANCELAR'].includes(iaResult.accion) && hasClearSolicitudes(iaResult);
}

function appendObservation(...observations) {
  return observations.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

async function analyzeIncomingMessage({ messageText, contactName, rowData }) {
  console.log('[BOT] Mensaje recibido:', messageText);
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const iaResult = await interpretMessage({ message: messageText, contactName, previousSolicitudes: prevSolicitudes });
  console.log('[BOT] nombre_detectado por IA:', iaResult.nombre_detectado || '(vacío)');
  console.log('[BOT] Acción detectada por IA:', iaResult.accion);
  return iaResult;
}

function buildUpdatesFromIA({ iaResult, messageText, phoneNumber, timezone, rowData, observations, forceHumanReview = false }) {
  const prevSolicitudes = rowData?.solicitudesDetectadas || '';
  const prevMap = parseSolicitudesString(prevSolicitudes);

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
  RESPONSES
};
