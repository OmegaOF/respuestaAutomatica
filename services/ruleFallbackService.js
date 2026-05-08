const { normalizeText, cleanNameCandidate, isLikelyFullName } = require('../utils/textUtils');
const { parseSolicitudesString } = require('../utils/solicitudesUtils');

const REQUEST_TYPES = [
  {
    tipo: 'DEUDA_GENERAL',
    label: 'deuda general',
    patterns: ['DEUDA GENERAL', 'MI DEUDA', 'DEUDA', 'SALDO']
  },
  {
    tipo: 'AGUINALDO',
    label: 'aguinaldo',
    patterns: ['AGUINALDO', 'AGUI']
  },
  {
    tipo: 'BONO_ABRIL',
    label: 'bono abril',
    patterns: ['BONO ABRIL', 'ABRIL']
  },
  {
    tipo: 'BONO_JUNIO',
    label: 'bono junio',
    patterns: ['BONO JUNIO', 'JUNIO']
  }
];

function extractAmount(message = '') {
  const matches = String(message).match(/(?:bs\.?\s*)?(\d{3,7})(?:\s*bs\.?)?/gi) || [];
  for (const match of matches) {
    const amount = (match.match(/\d{3,7}/) || [''])[0];
    if (amount) return amount;
  }
  return '';
}

function extractFullName(message = '') {
  const raw = String(message || '');
  const match = raw.match(/\b(?:soy|me llamo|mi nombre es|nombre es)\s+([^,.;\n]+?)(?=\s+(?:quiero|quisiera|necesito|por|para|solicito|consultar)\b|[,.;\n]|$)/i);
  if (!match) return '';

  const candidate = cleanNameCandidate(match[1]);
  return isLikelyFullName(candidate) ? candidate : '';
}

function detectTypes(message = '') {
  const normalized = normalizeText(message);
  return REQUEST_TYPES
    .filter(({ patterns }) => patterns.some((pattern) => normalized.includes(pattern)))
    .map(({ tipo }) => tipo);
}

function buildSolicitudActual(tipo, monto) {
  const config = REQUEST_TYPES.find((item) => item.tipo === tipo);
  const label = config?.label || tipo.toLowerCase();
  if (monto && monto !== 'NO_INDICADO') return `Cliente solicita préstamo por ${label} de ${monto} Bs.`;
  return `Cliente solicita préstamo por ${label}, pendiente de monto aproximado.`;
}

function analyzeMessageByRules({ messageText, previousSolicitudes = '' }) {
  const prevMap = parseSolicitudesString(previousSolicitudes);
  const amount = extractAmount(messageText);
  let detectedTypes = detectTypes(messageText);
  let accion = 'AGREGAR';

  if (!detectedTypes.length && amount) {
    const pendingTypes = Object.entries(prevMap)
      .filter(([, monto]) => !monto || monto === 'NO_INDICADO')
      .map(([tipo]) => tipo);
    if (pendingTypes.length === 1) {
      detectedTypes = pendingTypes;
      accion = 'ACTUALIZAR_MONTO';
    }
  }

  if (!detectedTypes.length) {
    return { matched: false };
  }

  const solicitudes = detectedTypes.map((tipo) => ({ tipo, monto: amount || 'NO_INDICADO' }));
  const hasMissingAmount = solicitudes.some((item) => item.monto === 'NO_INDICADO');
  const ambiguous = detectedTypes.length > 1 && !amount;
  const first = solicitudes[0];

  return {
    matched: true,
    nombre_detectado: extractFullName(messageText),
    accion,
    solicitudes,
    solicitud_actual: detectedTypes.length === 1
      ? buildSolicitudActual(first.tipo, first.monto)
      : 'Cliente mencionó múltiples tipos de solicitud. Revisar o aclarar detalle.',
    observacion: 'Solicitud interpretada por reglas locales por timeout o respuesta no entendida de IA.',
    requiere_humano: ambiguous ? 'SI' : 'NO',
    respuesta_tipo: ambiguous ? 'REVISION_HUMANA' : hasMissingAmount ? 'FALTA_MONTO' : 'REGISTRADO',
    fallback_reglas: true
  };
}

module.exports = {
  analyzeMessageByRules,
  extractAmount,
  extractFullName,
  detectTypes
};
