function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function normalizePhone(number = '') {
  return String(number).replace(/\D/g, '');
}

function cleanNameCandidate(name = '') {
  return String(name)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(soy|me llamo|mi nombre es|nombre es)\s+/i, '')
    .trim();
}

function isLikelyFullName(name = '') {
  const raw = cleanNameCandidate(name);
  if (raw.length < 6 || raw.length > 80) return false;
  if (/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-\s]/u.test(raw)) return false;

  const normalized = normalizeText(raw);
  const rejected = new Set(['MAMA', 'PAPA', 'MI NEGOCIO', 'CLIENTE', 'YO', 'MI NOMBRE', 'BUENAS TARDES', 'BUENOS DIAS']);
  if (rejected.has(normalized)) return false;

  const parts = raw.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return false;

  return parts.every((part) => {
    const normalizedPart = normalizeText(part);
    if (normalizedPart.length < 2) return false;
    if (['MAMA', 'PAPA', 'CLIENTE', 'NEGOCIO'].includes(normalizedPart)) return false;
    return /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]+$/u.test(part);
  });
}

module.exports = {
  normalizeText,
  normalizePhone,
  cleanNameCandidate,
  isLikelyFullName
};
