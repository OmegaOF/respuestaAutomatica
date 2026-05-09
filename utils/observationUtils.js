const CRITICAL_PATTERNS = [
  /Referencia WhatsApp visible:/i,
  /Identificador WhatsApp interno:/i,
  /WhatsApp no entregó número real/i,
  /Nombre detectado:.*No coincide/i,
  /IA no respondió/i,
  /timeout/i
];

function splitObservationParts(value = '') {
  return String(value || '')
    .split(/(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function appendObservationLimited(...observations) {
  const unique = [];
  observations.flatMap(splitObservationParts).forEach((part) => {
    if (!unique.includes(part)) unique.push(part);
  });

  const critical = unique.filter((part) => CRITICAL_PATTERNS.some((pattern) => pattern.test(part)));
  const regular = unique.filter((part) => !critical.includes(part));
  const slotsForRegular = Math.max(0, 5 - critical.length);
  return [...critical, ...regular.slice(-slotsForRegular)].slice(0, 5).join(' ');
}

module.exports = {
  appendObservationLimited
};
