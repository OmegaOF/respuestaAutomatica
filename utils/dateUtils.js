function getNowInTimeZone(timezone = 'America/La_Paz') {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return formatter.format(date).replace(' ', 'T');
}

module.exports = {
  getNowInTimeZone
};
