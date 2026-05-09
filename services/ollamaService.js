const fs = require('fs');
const path = require('path');
const axios = require('axios');

const tiposPath = path.join(__dirname, '..', 'config', 'tiposSolicitud.json');
const ALLOWED_ACCIONES = ['AGREGAR', 'REEMPLAZAR', 'CANCELAR', 'ACTUALIZAR_MONTO', 'ACLARAR', 'NO_ENTENDIDO'];
const ALLOWED_REQUIERE = ['SI', 'NO'];
const ALLOWED_RESPUESTA = ['PEDIR_NOMBRE', 'PEDIR_TELEFONO', 'PEDIR_TIPO', 'PEDIR_MONTO', 'REGISTRADO', 'REVISION_HUMANA', 'SALUDO', 'FALTA_NOMBRE', 'FALTA_MONTO', 'FALTA_TELEFONO', 'FALTA_TIPO'];
const ALLOWED_DATO_FALTANTE = ['NOMBRE', 'TELEFONO', 'TIPO_SOLICITUD', 'MONTO', 'NINGUNO', 'AMBIGUO'];
const ALLOWED_CONFIANZA = ['ALTA', 'MEDIA', 'BAJA'];

function buildPrompt(input) {
  const config = JSON.parse(fs.readFileSync(tiposPath, 'utf-8'));
  const mensajesRecientes = Array.isArray(input.mensajes_recientes) ? input.mensajes_recientes : [input.message || ''].filter(Boolean);
  const mensajeCombinado = input.mensaje_combinado || input.message || mensajesRecientes.join(' ');

  return `Eres un parser administrativo para solicitudes de préstamos por WhatsApp.\n` +
    `NO decides aprobaciones, deudas reales, cuotas reales, desembolsos ni condiciones financieras.\n` +
    `Interpreta el contexto completo de conversación, no solo el último mensaje.\n` +
    `Los clientes escriben por partes; une mensajes recientes para inferir tipo y monto.\n` +
    `Si mensajes_recientes son ["Quisiera por la deuda general", "3000"], interpreta 3000 como monto probable de DEUDA_GENERAL.\n` +
    `No uses el nombre visible de WhatsApp como nombre oficial; solo extrae nombre si el cliente lo escribió.\n` +
    `Usa NO_INDICADO como monto cuando detectes tipo de solicitud pero falte monto.\n` +
    `Devuelve SOLO JSON válido, sin markdown.\n` +
    `Tipos activos: ${JSON.stringify(config.tiposSolicitudActivos)}\n` +
    `Sinónimos: ${JSON.stringify(config.sinonimos)}\n` +
    `Nombre visible del contacto SOLO REFERENCIA: ${input.contactName || ''}\n` +
    `Mensajes recientes: ${JSON.stringify(mensajesRecientes)}\n` +
    `Mensaje combinado: ${mensajeCombinado}\n` +
    `Solicitudes detectadas previas: ${input.previousSolicitudes || ''}\n` +
    `Estado actual: ${input.estado_actual || ''}\n` +
    `Observaciones relevantes: ${input.observaciones || ''}\n` +
    `Falta nombre: ${input.falta_nombre ? 'SI' : 'NO'}\n` +
    `Falta celular real: ${input.falta_telefono ? 'SI' : 'NO'}\n` +
    `Falta monto: ${input.falta_monto ? 'SI' : 'NO'}\n` +
    `Falta tipo: ${input.falta_tipo ? 'SI' : 'NO'}\n` +
    `respuesta_cliente debe ser educada, clara, profesional y máximo 2 frases cortas.\n` +
    `respuesta_cliente NO puede prometer aprobación, desembolso, cobro, derechos, deuda real ni cuota real.\n` +
    `Formato estricto:\n` +
    JSON.stringify({
      nombre_detectado: '',
      telefono_detectado: '',
      accion: 'AGREGAR | REEMPLAZAR | CANCELAR | ACTUALIZAR_MONTO | ACLARAR | NO_ENTENDIDO',
      solicitudes: [{ tipo: 'DEUDA_GENERAL', monto: '3000' }],
      dato_faltante: 'NOMBRE | TELEFONO | TIPO_SOLICITUD | MONTO | NINGUNO | AMBIGUO',
      confianza: 'ALTA | MEDIA | BAJA',
      solicitud_actual: '',
      observacion: '',
      requiere_humano: 'SI | NO',
      respuesta_tipo: 'PEDIR_NOMBRE | PEDIR_TELEFONO | PEDIR_TIPO | PEDIR_MONTO | REGISTRADO | REVISION_HUMANA | SALUDO',
      respuesta_cliente: ''
    });
}

function fallbackResult(errorTipo = '') {
  return {
    nombre_detectado: '',
    telefono_detectado: '',
    accion: 'NO_ENTENDIDO',
    solicitudes: [],
    dato_faltante: 'AMBIGUO',
    confianza: 'BAJA',
    solicitud_actual: 'No se pudo interpretar la solicitud.',
    observacion: errorTipo === 'TIMEOUT_IA'
      ? 'IA no respondió a tiempo. Revisar manualmente.'
      : 'Mensaje ambiguo o formato inválido de IA. Requiere revisión manual.',
    requiere_humano: 'SI',
    respuesta_tipo: 'REVISION_HUMANA',
    respuesta_cliente: '',
    error_tipo: errorTipo
  };
}

function normalizeRespuestaTipo(value) {
  const map = {
    FALTA_NOMBRE: 'PEDIR_NOMBRE',
    FALTA_TELEFONO: 'PEDIR_TELEFONO',
    FALTA_TIPO: 'PEDIR_TIPO',
    FALTA_MONTO: 'PEDIR_MONTO'
  };
  return map[value] || value;
}

function sanitizeIAResult(parsed) {
  const fallback = fallbackResult();
  if (!parsed || typeof parsed !== 'object') return fallback;

  const accion = ALLOWED_ACCIONES.includes(parsed.accion) ? parsed.accion : null;
  const requiereHumano = ALLOWED_REQUIERE.includes(parsed.requiere_humano) ? parsed.requiere_humano : null;
  const respuestaTipo = normalizeRespuestaTipo(parsed.respuesta_tipo);
  const datoFaltante = ALLOWED_DATO_FALTANTE.includes(parsed.dato_faltante) ? parsed.dato_faltante : 'NINGUNO';
  const confianza = ALLOWED_CONFIANZA.includes(parsed.confianza) ? parsed.confianza : 'MEDIA';
  if (!accion || !requiereHumano || !ALLOWED_RESPUESTA.includes(parsed.respuesta_tipo) || !Array.isArray(parsed.solicitudes)) {
    return fallback;
  }

  const solicitudes = parsed.solicitudes
    .filter((item) => item && typeof item === 'object' && item.tipo !== undefined && item.monto !== undefined)
    .map((item) => ({ tipo: String(item.tipo).trim(), monto: String(item.monto).trim() || 'NO_INDICADO' }))
    .filter((item) => item.tipo.length > 0);

  if ((accion === 'AGREGAR' || accion === 'REEMPLAZAR' || accion === 'CANCELAR' || accion === 'ACTUALIZAR_MONTO') && solicitudes.length === 0) {
    return fallback;
  }

  return {
    nombre_detectado: String(parsed.nombre_detectado || ''),
    telefono_detectado: String(parsed.telefono_detectado || ''),
    accion,
    solicitudes,
    dato_faltante: datoFaltante,
    confianza,
    solicitud_actual: String(parsed.solicitud_actual || fallback.solicitud_actual),
    observacion: String(parsed.observacion || ''),
    requiere_humano: requiereHumano,
    respuesta_tipo: respuestaTipo,
    respuesta_cliente: String(parsed.respuesta_cliente || '')
  };
}

async function interpretMessage(input) {
  const ollamaUrl = process.env.OLLAMA_URL;
  const model = process.env.OLLAMA_MODEL || 'mistral';
  const timeout = Number(process.env.OLLAMA_TIMEOUT_MS || 45000);

  const payload = {
    model,
    prompt: buildPrompt(input),
    stream: false,
    format: 'json'
  };

  try {
    const response = await axios.post(ollamaUrl, payload, { timeout });
    const raw = response.data?.response || '{}';
    const parsed = JSON.parse(raw);
    return sanitizeIAResult(parsed);
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || String(error.message || '').includes('timeout');
    if (isTimeout) {
      console.error('[OLLAMA] Timeout controlado. Se marca EN_REVISION:', error.message);
      return fallbackResult('TIMEOUT_IA');
    }

    console.error('[OLLAMA] Error:', error.message);
    return fallbackResult('ERROR_IA');
  }
}

module.exports = {
  interpretMessage
};
