const { normalizePhone } = require('./textUtils');

function normalizeBolivianPhone(value = '') {
  const digits = normalizePhone(value);
  if (/^[67]\d{7}$/.test(digits)) return digits;
  if (/^591[67]\d{7}$/.test(digits)) return digits;
  return '';
}

function isWhatsappInternalId(value = '') {
  const raw = String(value || '').toLowerCase();
  const digits = normalizePhone(raw);
  if (raw.includes('@lid')) return true;
  if (digits.length > 11) return true;
  return false;
}

function validateRealPhone(value = '') {
  const normalizedPhone = normalizeBolivianPhone(value);
  return {
    isRealPhone: Boolean(normalizedPhone),
    normalizedPhone,
    observation: normalizedPhone ? '' : 'Valor descartado como celular real.'
  };
}

function extractRealPhoneFromText(text = '') {
  const candidates = String(text).match(/(?:\+?\d[\d\s-]{5,}\d)/g) || [];
  for (const candidate of candidates) {
    const validated = validateRealPhone(candidate);
    if (validated.isRealPhone) return validated.normalizedPhone;
  }
  return '';
}

module.exports = {
  normalizeBolivianPhone,
  isWhatsappInternalId,
  validateRealPhone,
  extractRealPhoneFromText
};
