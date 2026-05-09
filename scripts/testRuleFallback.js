const assert = require('assert');
const { analyzeMessageByRules } = require('../services/ruleFallbackService');
const { buildUpdatesFromIA, buildSafeReply, appendObservation } = require('../services/chatbotService');

const allowedStates = ['NUEVO', 'PENDIENTE_DATOS', 'EN_REVISION'];
const protectedColumns = ['CUOTA', 'Deuda General', 'BONO ABRIL', 'BONO JUNIO', 'AGUI', 'TOTAL'];

function buildUpdates(result, messageText, previousSolicitudes = '', observations = 'Mensaje recibido. Pendiente de análisis.') {
  const { updates, reply } = buildUpdatesFromIA({
    iaResult: result,
    messageText,
    phoneNumber: '70000000',
    timezone: 'America/La_Paz',
    rowData: { solicitudesDetectadas: previousSolicitudes },
    observations
  });
  assert(allowedStates.includes(updates.ESTADO_CHATBOT), `Estado inválido: ${updates.ESTADO_CHATBOT}`);
  for (const column of protectedColumns) {
    assert(!Object.prototype.hasOwnProperty.call(updates, column), `No debe escribir columna protegida ${column}`);
  }
  return { updates, reply };
}

function assertRule(messages, expected, previousSolicitudes = '') {
  const messageText = Array.isArray(messages) ? messages.join(' ') : messages;
  const result = analyzeMessageByRules({ messageText, previousSolicitudes });
  assert.strictEqual(result.matched, true, `No se detectó regla para: ${messageText}`);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'solicitudes') assert.deepStrictEqual(result.solicitudes, value, messageText);
    else assert.strictEqual(result[key], value, `${messageText} -> ${key}`);
  }
  return { result, ...buildUpdates(result, messageText, previousSolicitudes) };
}

// A) Mensajes rápidos agrupados: una sola interpretación sobre el bloque combinado.
let out = assertRule(['Buenas tardes', 'Quisiera', 'por la deuda general', '3000 bs'], {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: '3000' }],
  respuesta_tipo: 'REGISTRADO'
});
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'DEUDA_GENERAL=3000');

// B) Solicitud parcial + monto posterior.
out = assertRule('Quisiera por la deuda general', {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: 'NO_INDICADO' }],
  respuesta_tipo: 'PEDIR_MONTO'
});
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'DEUDA_GENERAL=NO_INDICADO');
out = assertRule('3000', {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: '3000' }],
  accion: 'ACTUALIZAR_MONTO',
  respuesta_tipo: 'REGISTRADO'
}, 'DEUDA_GENERAL=NO_INDICADO');
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'DEUDA_GENERAL=3000');

// C) Aguinaldo + monto posterior.
out = assertRule(['quiero aguinaldo', '5000'], {
  solicitudes: [{ tipo: 'AGUINALDO', monto: '5000' }],
  respuesta_tipo: 'REGISTRADO'
});
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'AGUINALDO=5000');

// D) Dos bonos con montos específicos.
out = assertRule(['bono abril y bono junio', 'abril 1000 junio 2000'], {
  solicitudes: [{ tipo: 'BONO_ABRIL', monto: '1000' }, { tipo: 'BONO_JUNIO', monto: '2000' }],
  respuesta_tipo: 'REGISTRADO'
});
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'BONO_ABRIL=1000; BONO_JUNIO=2000');

// E) Nombre + solicitud + monto.
out = assertRule('soy Juan Pérez, quiero 3000 por aguinaldo', {
  nombre_detectado: 'Juan Pérez',
  solicitudes: [{ tipo: 'AGUINALDO', monto: '3000' }]
});
assert.strictEqual(out.result.nombre_detectado, 'Juan Pérez');

// F) Falta nombre pero solicitud clara: se guarda solicitud y respuesta segura pide nombre.
const missingName = { ...out.result, nombre_detectado: '', respuesta_tipo: 'PEDIR_NOMBRE' };
assert(buildSafeReply(missingName).includes('nombre completo'));

// G) Falta celular real: respuesta segura pide celular sin borrar solicitud.
const missingPhone = { ...out.result, respuesta_tipo: 'PEDIR_TELEFONO' };
assert(buildSafeReply(missingPhone).includes('número de celular'));
assert.deepStrictEqual(missingPhone.solicitudes, [{ tipo: 'AGUINALDO', monto: '3000' }]);

// H) Timeout + mensaje entendible: reglas responden específico.
out = assertRule('bono junio 2500', {
  solicitudes: [{ tipo: 'BONO_JUNIO', monto: '2500' }],
  respuesta_tipo: 'REGISTRADO'
});
assert.strictEqual(out.updates.SOLICITUDES_DETECTADAS, 'BONO_JUNIO=2500');

// I) Timeout + mensaje no entendible: queda EN_REVISION.
const unknown = {
  nombre_detectado: '', telefono_detectado: '', accion: 'NO_ENTENDIDO', solicitudes: [], dato_faltante: 'AMBIGUO', confianza: 'BAJA',
  solicitud_actual: 'No se pudo interpretar la solicitud.', observacion: 'IA no respondió y no se pudo interpretar por reglas.', requiere_humano: 'SI', respuesta_tipo: 'REVISION_HUMANA'
};
out = buildUpdates(unknown, 'hola');
assert.strictEqual(out.updates.ESTADO_CHATBOT, 'EN_REVISION');

// Observaciones limitadas y críticas.
const obs = appendObservation(
  'Referencia WhatsApp visible: José Pedro.',
  'Identificador WhatsApp interno: 204625177276515.',
  'Uno.', 'Dos.', 'Tres.', 'Cuatro.', 'Cinco.', 'IA no respondió y no se pudo interpretar por reglas.'
);
assert(obs.includes('Referencia WhatsApp visible'));
assert(obs.includes('Identificador WhatsApp interno'));
assert(obs.split(/(?<=\.)\s+/).length <= 5);

console.log('Fallback por reglas y contrato conversacional OK');
