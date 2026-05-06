function parseSolicitudesString(raw = '') {
  if (!raw || typeof raw !== 'string') return {};

  return raw
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [tipo, monto] = pair.split('=').map((v) => (v || '').trim());
      if (tipo) acc[tipo] = monto || 'NO_INDICADO';
      return acc;
    }, {});
}

function toSolicitudesString(map = {}) {
  return Object.entries(map)
    .map(([tipo, monto]) => `${tipo}=${monto || 'NO_INDICADO'}`)
    .join('; ');
}

function hasClearSolicitudes(iaResult) {
  return Array.isArray(iaResult?.solicitudes) && iaResult.solicitudes.some((s) => s?.tipo && s?.monto);
}

function mergeSolicitudes(currentMap, iaResult) {
  const nextMap = { ...currentMap };
  const solicitudes = Array.isArray(iaResult.solicitudes) ? iaResult.solicitudes : [];

  switch (iaResult.accion) {
    case 'REEMPLAZAR':
      if (!hasClearSolicitudes(iaResult)) {
        return { ...currentMap };
      }
      return solicitudes.reduce((acc, item) => {
        if (!item?.tipo) return acc;
        acc[item.tipo] = item.monto || 'NO_INDICADO';
        return acc;
      }, {});
    case 'CANCELAR':
      solicitudes.forEach((item) => {
        if (item?.tipo) delete nextMap[item.tipo];
      });
      return nextMap;
    case 'ACTUALIZAR_MONTO':
    case 'AGREGAR':
    default:
      solicitudes.forEach((item) => {
        if (!item?.tipo) return;
        nextMap[item.tipo] = item.monto || nextMap[item.tipo] || 'NO_INDICADO';
      });
      return nextMap;
  }
}

module.exports = {
  parseSolicitudesString,
  toSolicitudesString,
  mergeSolicitudes,
  hasClearSolicitudes
};
