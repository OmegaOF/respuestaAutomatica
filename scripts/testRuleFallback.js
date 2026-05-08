const assert = require('assert');
const { analyzeMessageByRules } = require('../services/ruleFallbackService');
const { buildUpdatesFromIA } = require('../services/chatbotService');

function assertRule(messageText, expected, previousSolicitudes = '') {
  const result = analyzeMessageByRules({ messageText, previousSolicitudes });
  assert.strictEqual(result.matched, true, `No se detectó regla para: ${messageText}`);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'solicitudes') {
      assert.deepStrictEqual(result.solicitudes, value, messageText);
    } else {
      assert.strictEqual(result[key], value, `${messageText} -> ${key}`);
    }
  }
  const { updates } = buildUpdatesFromIA({
    iaResult: result,
    messageText,
    phoneNumber: '70000000',
    timezone: 'America/La_Paz',
    rowData: { solicitudesDetectadas: previousSolicitudes },
    observations: 'Mensaje recibido. Pendiente de análisis.'
  });
  assert(['NUEVO', 'PENDIENTE_DATOS', 'EN_REVISION'].includes(updates.ESTADO_CHATBOT), `Estado inválido: ${updates.ESTADO_CHATBOT}`);
  for (const column of ['CUOTA', 'Deuda General', 'BONO ABRIL', 'BONO JUNIO', 'AGUI', 'TOTAL']) {
    assert(!Object.prototype.hasOwnProperty.call(updates, column), `No debe escribir columna protegida ${column}`);
  }
  return updates;
}

assertRule('Quisiera 3000 bs por la deuda general', {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: '3000' }],
  respuesta_tipo: 'REGISTRADO'
});

let updates = assertRule('Quisiera por la deuda general', {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: 'NO_INDICADO' }],
  respuesta_tipo: 'FALTA_MONTO'
});
assert.strictEqual(updates.SOLICITUDES_DETECTADAS, 'DEUDA_GENERAL=NO_INDICADO');

updates = assertRule('3000', {
  solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: '3000' }],
  accion: 'ACTUALIZAR_MONTO',
  respuesta_tipo: 'REGISTRADO'
}, 'DEUDA_GENERAL=NO_INDICADO');
assert.strictEqual(updates.SOLICITUDES_DETECTADAS, 'DEUDA_GENERAL=3000');

assertRule('quiero aguinaldo', {
  solicitudes: [{ tipo: 'AGUINALDO', monto: 'NO_INDICADO' }],
  respuesta_tipo: 'FALTA_MONTO'
});

assertRule('bono abril 2000', {
  solicitudes: [{ tipo: 'BONO_ABRIL', monto: '2000' }],
  respuesta_tipo: 'REGISTRADO'
});

const hello = analyzeMessageByRules({ messageText: 'hola', previousSolicitudes: '' });
assert.strictEqual(hello.matched, false);

const withName = analyzeMessageByRules({ messageText: 'soy Juan Pérez, quiero 3000 por aguinaldo', previousSolicitudes: '' });
assert.strictEqual(withName.nombre_detectado, 'Juan Pérez');
assert.deepStrictEqual(withName.solicitudes, [{ tipo: 'AGUINALDO', monto: '3000' }]);

const timeoutFallback = analyzeMessageByRules({ messageText: 'bono junio 2500', previousSolicitudes: '' });
assert.strictEqual(timeoutFallback.matched, true);
assert.deepStrictEqual(timeoutFallback.solicitudes, [{ tipo: 'BONO_JUNIO', monto: '2500' }]);

console.log('Fallback por reglas OK');
