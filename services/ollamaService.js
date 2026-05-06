const fs = require('fs');
const path = require('path');
const axios = require('axios');

const tiposPath = path.join(__dirname, '..', 'config', 'tiposSolicitud.json');
const ALLOWED_ACCIONES = ['AGREGAR', 'REEMPLAZAR', 'CANCELAR', 'ACTUALIZAR_MONTO', 'ACLARAR', 'NO_ENTENDIDO'];
const ALLOWED_REQUIERE = ['SI', 'NO'];
const ALLOWED_RESPUESTA = ['REGISTRADO', 'FALTA_NOMBRE', 'FALTA_MONTO', 'REVISION_HUMANA', 'SALUDO'];

function buildPrompt({ message, contactName, previousSolicitudes }) {
  const config = JSON.parse(fs.readFileSync(tiposPath, 'utf-8'));

  return `Eres un parser administrativo para solicitudes de préstamos.\n` +
    `NO decides aprobaciones ni condiciones financieras.\n` +
    `Interpreta lenguaje natural libre, abreviaciones, errores y frases incompletas; no dependas de coincidencias exactas.\n` +
    `Si el cliente dice su nombre, extraelo en nombre_detectado; no inventes nombres si no aparecen en el mensaje.\n` +
    `Usa NO_INDICADO como monto cuando detectes tipo de solicitud pero falte monto.\n` +
    `Si falta nombre para registrar, usa respuesta_tipo FALTA_NOMBRE. Si falta monto, usa FALTA_MONTO.\n` +
    `Devuelve SOLO JSON válido, sin markdown.\n` +
    `Tipos activos: ${JSON.stringify(config.tiposSolicitudActivos)}\n` +
    `Sinónimos: ${JSON.stringify(config.sinonimos)}\n` +
    `Nombre visible del contacto: ${contactName || ''}\n` +
    `Solicitudes previas: ${previousSolicitudes || ''}\n` +
    `Mensaje cliente: ${message}\n` +
    `Formato estricto:\n` +
    JSON.stringify({
      nombre_detectado: '',
      accion: 'AGREGAR | REEMPLAZAR | CANCELAR | ACTUALIZAR_MONTO | ACLARAR | NO_ENTENDIDO',
      solicitudes: [{ tipo: 'AGUINALDO', monto: '3000' }],
      solicitud_actual: '',
      observacion: '',
      requiere_humano: 'SI | NO',
      respuesta_tipo: 'REGISTRADO | FALTA_NOMBRE | FALTA_MONTO | REVISION_HUMANA | SALUDO'
    });
}

function fallbackResult() {
  return {
    nombre_detectado: '',
    accion: 'NO_ENTENDIDO',
    solicitudes: [],
    solicitud_actual: 'No se pudo interpretar la solicitud.',
    observacion: 'Mensaje ambiguo o formato inválido de IA. Requiere revisión manual.',
    requiere_humano: 'SI',
    respuesta_tipo: 'REVISION_HUMANA'
  };
}

function sanitizeIAResult(parsed) {
  const fallback = fallbackResult();
  if (!parsed || typeof parsed !== 'object') return fallback;

  const accion = ALLOWED_ACCIONES.includes(parsed.accion) ? parsed.accion : null;
  const requiereHumano = ALLOWED_REQUIERE.includes(parsed.requiere_humano) ? parsed.requiere_humano : null;
  const respuestaTipo = ALLOWED_RESPUESTA.includes(parsed.respuesta_tipo) ? parsed.respuesta_tipo : null;
  if (!accion || !requiereHumano || !respuestaTipo || !Array.isArray(parsed.solicitudes)) {
    return fallback;
  }

  const solicitudes = parsed.solicitudes
    .filter((item) => item && typeof item === 'object' && item.tipo !== undefined && item.monto !== undefined)
    .map((item) => ({ tipo: String(item.tipo).trim(), monto: String(item.monto).trim() }))
    .filter((item) => item.tipo.length > 0 && item.monto.length > 0);

  if ((accion === 'AGREGAR' || accion === 'REEMPLAZAR' || accion === 'CANCELAR' || accion === 'ACTUALIZAR_MONTO') && solicitudes.length === 0) {
    return fallback;
  }

  return {
    nombre_detectado: String(parsed.nombre_detectado || ''),
    accion,
    solicitudes,
    solicitud_actual: String(parsed.solicitud_actual || fallback.solicitud_actual),
    observacion: String(parsed.observacion || ''),
    requiere_humano: requiereHumano,
    respuesta_tipo: respuestaTipo
  };
}

async function interpretMessage(input) {
  const ollamaUrl = process.env.OLLAMA_URL;
  const model = process.env.OLLAMA_MODEL || 'mistral';

  const payload = {
    model,
    prompt: buildPrompt(input),
    stream: false,
    format: 'json'
  };

  try {
    const response = await axios.post(ollamaUrl, payload, { timeout: 45000 });
    const raw = response.data?.response || '{}';
    const parsed = JSON.parse(raw);
    return sanitizeIAResult(parsed);
  } catch (error) {
    console.error('[OLLAMA] Error:', error.message);
    return fallbackResult();
  }
}

module.exports = {
  interpretMessage
};
