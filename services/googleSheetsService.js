const { google } = require('googleapis');
const { normalizeText, normalizePhone } = require('../utils/textUtils');
const { getNowInTimeZone } = require('../utils/dateUtils');

const CHATBOT_COLUMNS = [
  'NUMERO_WHATSAPP',
  'ULTIMO_MENSAJE',
  'SOLICITUD_ACTUAL',
  'SOLICITUDES_DETECTADAS',
  'ESTADO_CHATBOT',
  'FECHA_ULTIMO_CONTACTO',
  'REQUIERE_HUMANO'
];

const ALLOWED_WRITE_COLUMNS = ['OBSERVACIONES', 'NOMBRE DE CLIENTE', ...CHATBOT_COLUMNS];
const PROTECTED_COLUMNS = ['CUOTA', 'Deuda General', 'BONO ABRIL', 'BONO JUNIO', 'AGUI', 'TOTAL'];
const ACTIVE_STATES = ['NUEVO', 'PENDIENTE_DATOS', 'EN_REVISION'];
const FINAL_STATES = ['APROBADO', 'RECHAZADO', 'CERRADO'];
const NAME_HEADER_CANDIDATES = ['NOMBRE DE CLIENTE', 'NOMBRE CLIENTE', 'CLIENTE', 'NOMBRE'];
const OBSERVATIONS_HEADER_CANDIDATES = ['OBSERVACIONES', 'OBSERVACION'];
const FIRST_PROTECTED_HEADER = 'CUOTA';


function appendObservation(...observations) {
  const parts = observations.map((part) => String(part || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' ');
}

function columnToLetter(index) {
  let letter = '';
  let value = index + 1;
  while (value > 0) {
    const mod = (value - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    value = Math.floor((value - mod) / 26);
  }
  return letter;
}

class GoogleSheetsService {
  constructor() {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
    this.sheetName = process.env.GOOGLE_SHEET_NAME;
    this.sheetId = null;
  }

  async getSheetId() {
    if (this.sheetId !== null) return this.sheetId;
    const { data } = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const sheet = data.sheets.find((item) => item.properties.title === this.sheetName);
    if (!sheet) throw new Error(`No existe la pestaña ${this.sheetName}`);
    this.sheetId = sheet.properties.sheetId;
    return this.sheetId;
  }

  async getSheetValues() {
    const range = `${this.sheetName}!A:ZZ`;
    const { data } = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    return data.values || [];
  }

  findHeaderIndex(headers, candidates) {
    const normalizedHeaders = headers.map((h) => normalizeText(h));
    for (const candidate of candidates) {
      const idx = normalizedHeaders.indexOf(normalizeText(candidate));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  findNameColumnIndex(headers) {
    return this.findHeaderIndex(headers, NAME_HEADER_CANDIDATES);
  }

  findObservationsColumnIndex(headers) {
    return this.findHeaderIndex(headers, OBSERVATIONS_HEADER_CANDIDATES);
  }

  async insertColumns(startIndex, count) {
    if (count <= 0) return;
    const sheetId = await this.getSheetId();
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex: startIndex + count },
            inheritFromBefore: startIndex > 0
          }
        }]
      }
    });
  }

  async updateHeaderRow(headers) {
    const endColumn = columnToLetter(Math.max(headers.length - 1, 0));
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A1:${endColumn}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }

  async ensureRequiredColumns(headers) {
    let updatedHeaders = [...headers];

    if (this.findObservationsColumnIndex(updatedHeaders) === -1) {
      await this.insertColumns(0, 1);
      updatedHeaders.splice(0, 0, 'OBSERVACIONES');
    }

    if (this.findNameColumnIndex(updatedHeaders) === -1) {
      const insertAt = Math.min(this.findObservationsColumnIndex(updatedHeaders) + 1, updatedHeaders.length);
      await this.insertColumns(insertAt, 1);
      updatedHeaders.splice(insertAt, 0, 'NOMBRE DE CLIENTE');
    }

    const missingChatbotColumns = CHATBOT_COLUMNS.filter((column) => !updatedHeaders.includes(column));
    if (missingChatbotColumns.length) {
      const nameIndex = this.findNameColumnIndex(updatedHeaders);
      const cuotaIndex = updatedHeaders.indexOf(FIRST_PROTECTED_HEADER);
      const insertAt = cuotaIndex >= 0 ? cuotaIndex : nameIndex + 1;
      await this.insertColumns(insertAt, missingChatbotColumns.length);
      updatedHeaders.splice(insertAt, 0, ...missingChatbotColumns);
      console.log('[SHEETS] Columnas del chatbot insertadas después de NOMBRE DE CLIENTE y antes de CUOTA:', missingChatbotColumns.join(', '));
    }

    await this.updateHeaderRow(updatedHeaders);
    return updatedHeaders;
  }

  async getNormalizedData() {
    const values = await this.getSheetValues();
    const headers = await this.ensureRequiredColumns(values[0] || []);
    const refreshedValues = await this.getSheetValues();
    return { headers, rows: refreshedValues.slice(1) };
  }

  getRowName(headers, row) {
    const nameCol = this.findNameColumnIndex(headers);
    return nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
  }

  getRowState(headers, row) {
    const stateCol = headers.indexOf('ESTADO_CHATBOT');
    return stateCol >= 0 ? normalizeText(row[stateCol] || '') : '';
  }

  getRowPhone(headers, row) {
    const phoneCol = headers.indexOf('NUMERO_WHATSAPP');
    return phoneCol >= 0 ? normalizePhone(row[phoneCol] || '') : '';
  }

  getRowObservations(headers, row) {
    const observationsCol = this.findObservationsColumnIndex(headers);
    return observationsCol >= 0 ? String(row[observationsCol] || '').trim() : '';
  }

  rowToMatch(headers, row, rowIndex) {
    return {
      row,
      rowIndex,
      name: this.getRowName(headers, row),
      normalizedName: normalizeText(this.getRowName(headers, row)),
      state: this.getRowState(headers, row),
      phone: this.getRowPhone(headers, row)
    };
  }

  selectActiveOrLatest(matches) {
    const activeMatches = matches.filter((match) => ACTIVE_STATES.includes(match.state) || !FINAL_STATES.includes(match.state));
    if (activeMatches.length) {
      const selected = activeMatches[activeMatches.length - 1];
      console.log('[SHEETS] Atención activa encontrada en fila', selected.rowIndex);
      return selected;
    }
    const selected = matches[matches.length - 1] || null;
    if (selected) console.log('[SHEETS] Atención finalizada detectada en fila', selected.rowIndex);
    return selected;
  }

  async findAttentionByPhone(phoneNumber) {
    const { headers, rows } = await this.getNormalizedData();
    const normalizedPhone = normalizePhone(phoneNumber);
    const matches = rows
      .map((row, idx) => this.rowToMatch(headers, row, idx + 2))
      .filter((match) => normalizedPhone && match.phone === normalizedPhone);

    if (!matches.length) return { found: false, headers, ambiguous: false, reason: 'telefono_sin_coincidencia' };
    const selected = this.selectActiveOrLatest(matches);
    return { found: true, headers, rowIndex: selected.rowIndex, currentRow: selected.row, state: selected.state, officialName: selected.name, reason: 'telefono' };
  }

  async findNameMatch(name) {
    const { headers, rows } = await this.getNormalizedData();
    const normalizedName = normalizeText(name);
    const candidates = rows
      .map((row, idx) => this.rowToMatch(headers, row, idx + 2))
      .filter((match) => match.normalizedName);

    const exactMatches = candidates.filter((match) => match.normalizedName === normalizedName);
    if (exactMatches.length) {
      const selected = this.selectActiveOrLatest(exactMatches);
      console.log('[SHEETS] Cliente encontrado por nombre exacto:', selected.name);
      return { found: true, headers, matchType: 'exacta', officialName: selected.name, matches: exactMatches, selected };
    }

    const partialMatches = normalizedName.length >= 3
      ? candidates.filter((match) => match.normalizedName.includes(normalizedName) || normalizedName.includes(match.normalizedName))
      : [];
    const uniqueNames = [...new Set(partialMatches.map((match) => match.normalizedName))];

    if (uniqueNames.length === 1) {
      const selected = this.selectActiveOrLatest(partialMatches);
      console.log('[SHEETS] Cliente encontrado por nombre parcial único:', selected.name);
      return { found: true, headers, matchType: 'parcial', officialName: selected.name, matches: partialMatches, selected };
    }

    if (uniqueNames.length > 1) {
      console.log('[SHEETS] Coincidencia ambigua por nombre. Requiere revisión humana.');
      return { found: false, headers, ambiguous: true, reason: 'nombre_ambiguo' };
    }

    return { found: false, headers, ambiguous: false, reason: 'nombre_no_coincide' };
  }

  async findAttentionByOfficialName(officialName) {
    const { headers, rows } = await this.getNormalizedData();
    const normalizedName = normalizeText(officialName);
    const matches = rows
      .map((row, idx) => this.rowToMatch(headers, row, idx + 2))
      .filter((match) => match.normalizedName === normalizedName);

    if (!matches.length) return { found: false, headers, ambiguous: false, reason: 'sin_atencion' };
    const selected = this.selectActiveOrLatest(matches);
    return { found: true, headers, rowIndex: selected.rowIndex, currentRow: selected.row, state: selected.state, officialName: selected.name, reason: 'nombre' };
  }

  async createAttentionRow({ headers, whatsappNumber, officialName = '', observations = '' }) {
    const row = new Array(headers.length).fill('');
    const phoneCol = headers.indexOf('NUMERO_WHATSAPP');
    const nameCol = this.findNameColumnIndex(headers);
    const observationsCol = this.findObservationsColumnIndex(headers);

    if (phoneCol >= 0) row[phoneCol] = normalizePhone(whatsappNumber);
    if (nameCol >= 0 && officialName) row[nameCol] = officialName;
    if (observationsCol >= 0 && observations) row[observationsCol] = observations;

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A:ZZ`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    const updated = await this.getSheetValues();
    const rowIndex = updated.length;
    if (officialName) {
      console.log('[SHEETS] Nueva línea creada para atención de', officialName, 'en fila', rowIndex);
    } else {
      console.log('[SHEETS] Nueva línea creada con NOMBRE DE CLIENTE vacío en fila', rowIndex);
    }
    return { rowIndex, currentRow: updated[rowIndex - 1] || row };
  }

  async upsertMinimalAttentionByPhone({ phoneNumber, messageText, timezone, observations = 'Mensaje recibido. Pendiente de análisis.' }) {
    const phoneAttention = await this.findAttentionByPhone(phoneNumber);
    let headers = phoneAttention.headers;
    let rowIndex;
    let currentRow;
    let created = false;

    if (phoneAttention.found && !FINAL_STATES.includes(phoneAttention.state)) {
      rowIndex = phoneAttention.rowIndex;
      currentRow = phoneAttention.currentRow;
    } else {
      if (phoneAttention.found && FINAL_STATES.includes(phoneAttention.state)) {
        console.log('[BOT] Atención finalizada detectada. Se crea nueva atención.');
      }
      const createdRow = await this.createAttentionRow({ headers, whatsappNumber: phoneNumber });
      rowIndex = createdRow.rowIndex;
      currentRow = createdRow.currentRow;
      created = true;
    }

    const previousObservations = this.getRowObservations(headers, currentRow);
    const updates = {
      NUMERO_WHATSAPP: normalizePhone(phoneNumber),
      ULTIMO_MENSAJE: messageText,
      ESTADO_CHATBOT: 'NUEVO',
      FECHA_ULTIMO_CONTACTO: getNowInTimeZone(timezone),
      REQUIERE_HUMANO: 'NO',
      OBSERVACIONES: appendObservation(previousObservations, observations)
    };

    const updated = await this.updateAllowedColumns({ headers, rowIndex, currentRow, updates });
    currentRow = updated?.currentRow || currentRow;

    if (created) {
      console.log(`[SHEETS] Registro mínimo creado para NUMERO_WHATSAPP=${normalizePhone(phoneNumber)} fila=${rowIndex}`);
    } else {
      console.log(`[SHEETS] Registro mínimo actualizado para NUMERO_WHATSAPP=${normalizePhone(phoneNumber)} fila=${rowIndex}`);
    }

    return {
      found: true,
      created,
      headers,
      rowIndex,
      currentRow,
      state: 'NUEVO',
      officialName: this.getRowName(headers, currentRow),
      reason: created ? 'registro_minimo_creado' : 'registro_minimo_actualizado'
    };
  }

  async updateAllowedColumns({ headers, rowIndex, currentRow, updates }) {
    const safeEntries = Object.entries(updates).filter(([key, value]) => {
      if (!ALLOWED_WRITE_COLUMNS.includes(key)) return false;
      if (PROTECTED_COLUMNS.includes(key)) return false;
      return value !== undefined;
    });

    if (!safeEntries.length) return { rowIndex, currentRow };

    safeEntries.forEach(([key, value]) => {
      const colIndex = key === 'OBSERVACIONES'
        ? this.findObservationsColumnIndex(headers)
        : key === 'NOMBRE DE CLIENTE'
          ? this.findNameColumnIndex(headers)
          : headers.indexOf(key);
      if (colIndex >= 0) currentRow[colIndex] = value;
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A${rowIndex}:ZZ${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [currentRow] }
    });

    console.log('[SHEETS] Fila actualizada', rowIndex);
    return { rowIndex, currentRow };
  }
}

module.exports = {
  GoogleSheetsService,
  CHATBOT_COLUMNS,
  ALLOWED_WRITE_COLUMNS,
  PROTECTED_COLUMNS,
  ACTIVE_STATES,
  FINAL_STATES
};
