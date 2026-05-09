const { normalizeText, normalizePhone, cleanNameCandidate, isLikelyFullName } = require('../utils/textUtils');
const { parseSolicitudesString } = require('../utils/solicitudesUtils');

const REQUEST_TYPES = [
  { tipo: 'DEUDA_GENERAL', label: 'deuda general', patterns: ['DEUDA GENERAL', 'MI DEUDA', 'DEUDA', 'SALDO'] },
  { tipo: 'AGUINALDO', label: 'aguinaldo', patterns: ['AGUINALDO', 'AGUI'] },
  { tipo: 'BONO_ABRIL', label: 'bono abril', patterns: ['BONO ABRIL', 'ABRIL'] },
  { tipo: 'BONO_JUNIO', label: 'bono junio', patterns: ['BONO JUNIO', 'JUNIO'] }
];

function extractAmount(message = '') {
  const matches = String(message).match(/(?:bs\.?\s*)?(\d{3,7})(?:\s*bs\.?)?/gi) || [];
  for (const match of matches) {
    const amount = (match.match(/\d{3,7}/) || [''])[0];
    if (amount) return amount;
  }
  return '';
}

function extractPhone(message = '') {
  const candidates = String(message).match(/(?:\+?\d[\d\s-]{5,}\d)/g) || [];
  for (const candidate of candidates) {
    const digits = normalizePhone(candidate);
    if (digits.length >= 7 && digits.length <= 15) return digits;
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

function findTypeSpecificAmount(message, tipo) {
  const config = REQUEST_TYPES.find((item) => item.tipo === tipo);
  if (!config) return '';
  for (const pattern of [...config.patterns].sort((a, b) => a.length - b.length)) {
    const normalizedPattern = pattern.toLowerCase().replace(/\s+/g, '\\s+');
    const afterRegex = new RegExp(`${normalizedPattern}[^0-9]{0,40}(?:bs\\.?\\s*)?(\\d{3,7})(?:\\s*bs\\.?)?`, 'gi');
    const matches = [...String(message).matchAll(afterRegex)];
    if (matches.length) return matches[matches.length - 1][1];
  }

  for (const pattern of [...config.patterns].sort((a, b) => a.length - b.length)) {
    const normalizedPattern = pattern.toLowerCase().replace(/\s+/g, '\\s+');
    const beforeRegex = new RegExp(`(?:bs\\.?\\s*)?(\\d{3,7})(?:\\s*bs\\.?)?[^a-zA-Z0-9]{0,40}${normalizedPattern}`, 'gi');
    const matches = [...String(message).matchAll(beforeRegex)];
    if (matches.length) return matches[matches.length - 1][1];
  }
  return '';
}

function buildSolicitudActualFromSolicitudes(solicitudes) {
  if (!solicitudes.length) return 'No se pudo interpretar la solicitud.';
  if (solicitudes.length > 1) {
    return `Cliente solicita: ${solicitudes.map((item) => {
      const label = REQUEST_TYPES.find((type) => type.tipo === item.tipo)?.label || item.tipo.toLowerCase();
      return item.monto && item.monto !== 'NO_INDICADO' ? `${label} de ${item.monto} Bs` : `${label} pendiente de monto`;
    }).join('; ')}.`;
  }

  const item = solicitudes[0];
  const label = REQUEST_TYPES.find((type) => type.tipo === item.tipo)?.label || item.tipo.toLowerCase();
  if (item.monto && item.monto !== 'NO_INDICADO') return `Cliente solicita préstamo por ${label} de ${item.monto} Bs.`;
  return `Cliente solicita préstamo por ${label}, pendiente de monto aproximado.`;
}

function resolveResponseType({ solicitudes, ambiguous }) {
  if (ambiguous) return 'REVISION_HUMANA';
  if (!solicitudes.length) return 'PEDIR_TIPO';
  if (solicitudes.some((item) => item.monto === 'NO_INDICADO')) return 'PEDIR_MONTO';
  return 'REGISTRADO';
}

function analyzeMessageByRules({ messageText, previousSolicitudes = '' }) {
  const prevMap = parseSolicitudesString(previousSolicitudes);
  const genericAmount = extractAmount(messageText);
  let detectedTypes = detectTypes(messageText);
  let accion = 'AGREGAR';

  if (!detectedTypes.length && genericAmount) {
    const pendingTypes = Object.entries(prevMap)
      .filter(([, monto]) => !monto || monto === 'NO_INDICADO')
      .map(([tipo]) => tipo);
    if (pendingTypes.length === 1) {
      detectedTypes = pendingTypes;
      accion = 'ACTUALIZAR_MONTO';
    }
  }

  if (!detectedTypes.length) {
    return {
      matched: false,
      nombre_detectado: extractFullName(messageText),
      telefono_detectado: extractPhone(messageText),
      accion: 'NO_ENTENDIDO',
      solicitudes: [],
      dato_faltante: 'TIPO_SOLICITUD',
      confianza: 'BAJA',
      solicitud_actual: 'No se pudo interpretar la solicitud por reglas.',
      observacion: 'Reglas locales no detectaron tipo de solicitud.',
      requiere_humano: 'SI',
      respuesta_tipo: 'REVISION_HUMANA',
      respuesta_cliente: '',
      fallback_reglas: true
    };
  }

  const solicitudes = detectedTypes.map((tipo) => ({
    tipo,
    monto: findTypeSpecificAmount(messageText, tipo) || (detectedTypes.length === 1 ? genericAmount : '') || 'NO_INDICADO'
  }));
  const hasMissingAmount = solicitudes.some((item) => item.monto === 'NO_INDICADO');
  const ambiguous = detectedTypes.length > 1 && hasMissingAmount;
  const respuestaTipo = resolveResponseType({ solicitudes, ambiguous });

  return {
    matched: true,
    nombre_detectado: extractFullName(messageText),
    telefono_detectado: extractPhone(messageText),
    accion,
    solicitudes,
    dato_faltante: hasMissingAmount ? 'MONTO' : 'NINGUNO',
    confianza: ambiguous ? 'MEDIA' : 'ALTA',
    solicitud_actual: buildSolicitudActualFromSolicitudes(solicitudes),
    observacion: 'Solicitud interpretada por reglas locales por timeout o respuesta no entendida de IA.',
    requiere_humano: ambiguous ? 'SI' : 'NO',
    respuesta_tipo: respuestaTipo,
    respuesta_cliente: '',
    fallback_reglas: true
  };
}

module.exports = {
  analyzeMessageByRules,
  extractAmount,
  extractPhone,
  extractFullName,
  detectTypes,
  buildSolicitudActualFromSolicitudes
};
