const {
  buildSafeReply: buildOrchestratedSafeReply,
  sanitizeInterpretation,
  buildUpdates,
  appendObservation
} = require('./conversationOrchestrator');
const { parseSolicitudesString, mergeSolicitudes } = require('../utils/solicitudesUtils');
const { validateRealPhone } = require('../utils/phoneUtils');

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

function resolveCompatNext(interpretation, mergedSolicitudes) {
  if (interpretation.requiere_humano === 'SI' || interpretation.accion === 'NO_ENTENDIDO' || interpretation.confianza === 'BAJA') {
    return { respuesta_tipo: 'REVISION_HUMANA', estado: 'EN_REVISION', requiere_humano: 'SI', dato_faltante: 'AMBIGUO' };
  }

  if (['PEDIR_NOMBRE', 'PEDIR_TELEFONO', 'PEDIR_TIPO', 'PEDIR_MONTO'].includes(interpretation.respuesta_tipo)) {
    return {
      respuesta_tipo: interpretation.respuesta_tipo,
      estado: 'PENDIENTE_DATOS',
      requiere_humano: 'NO',
      dato_faltante: interpretation.dato_faltante || 'NINGUNO'
    };
  }

  if (!Object.keys(mergedSolicitudes).length) {
    return { respuesta_tipo: 'PEDIR_TIPO', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'TIPO_SOLICITUD' };
  }

  if (Object.values(mergedSolicitudes).some((monto) => !monto || monto === 'NO_INDICADO')) {
    return { respuesta_tipo: 'PEDIR_MONTO', estado: 'PENDIENTE_DATOS', requiere_humano: 'NO', dato_faltante: 'MONTO' };
  }

  return { respuesta_tipo: 'REGISTRADO', estado: 'NUEVO', requiere_humano: 'NO', dato_faltante: 'NINGUNO' };
}

function buildSafeReply(iaResult) {
  return buildOrchestratedSafeReply(sanitizeInterpretation(iaResult));
}

function buildUpdatesFromIA({ iaResult, messageText, phoneNumber, timezone, rowData, observations }) {
  const interpretation = sanitizeInterpretation(iaResult);
  const prevMap = parseSolicitudesString(rowData?.solicitudesDetectadas || '');
  const mergedSolicitudes = mergeSolicitudes(prevMap, interpretation);
  const next = resolveCompatNext(interpretation, mergedSolicitudes);
  const phone = validateRealPhone(phoneNumber || '');
  const orchestratedInterpretation = {
    ...interpretation,
    respuesta_tipo: next.respuesta_tipo,
    dato_faltante: next.dato_faltante,
    requiere_humano: next.requiere_humano
  };

  const updates = buildUpdates({
    combinedMessage: messageText,
    timezone,
    currentRowContext: { observations: observations || '', officialName: rowData?.officialName || '' },
    interpretation: orchestratedInterpretation,
    mergedSolicitudes,
    phone: {
      phone: phone.normalizedPhone,
      shouldWritePhone: phone.isRealPhone,
      hasRealPhone: phone.isRealPhone,
      observation: ''
    },
    name: { officialName: rowData?.officialName || '', requiresHuman: false, observation: '' },
    next
  });

  return { updates, reply: buildOrchestratedSafeReply(orchestratedInterpretation), iaResult: orchestratedInterpretation };
}

module.exports = {
  RESPONSES,
  appendObservation,
  buildSafeReply,
  buildUpdatesFromIA
};
