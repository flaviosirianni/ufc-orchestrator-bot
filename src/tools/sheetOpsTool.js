import '../core/env.js';
import { google } from 'googleapis';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
let sheetsClient;
const DEFAULT_RANGE = 'Fights!A:E';
const MAX_PREVIEW_ROWS = 15;

function getCredentials() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Google Sheets credentials are missing. Ensure GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY are set.'
    );
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n'),
  };
}

async function getSheetsClient() {
  if (sheetsClient) {
    return sheetsClient;
  }

  const scopes = process.env.GOOGLE_SCOPES
    ? process.env.GOOGLE_SCOPES.split(',').map((scope) => scope.trim()).filter(Boolean)
    : DEFAULT_SCOPES;

  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes,
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

export async function readRange(sheetId, range) {
  if (!sheetId) {
    throw new Error('A sheetId is required to read from Google Sheets.');
  }

  const sheets = await getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  return data.values || [];
}

function extractRange(message = '', fallback = DEFAULT_RANGE) {
  const rangeMatch = message.match(
    /\b(?:[A-Za-z0-9_]+!)?(?:[A-Z]+[0-9]+(?::[A-Z]+[0-9]+)?|[A-Z]+:[A-Z]+)\b/
  );
  return rangeMatch?.[0] || fallback;
}

function parseValuesPayload(payload = '') {
  const trimmed = payload.trim();

  if (!trimmed) {
    return null;
  }

  // Supports JSON payloads, e.g. [["A","B"],["C","D"]]
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.some((row) => !Array.isArray(row))
    ) {
      throw new Error('Payload JSON must be a two-dimensional array.');
    }
    return parsed;
  }

  // Supports compact syntax:
  // value1,value2;value3,value4
  return trimmed
    .split(';')
    .map((row) => row.split(',').map((cell) => cell.trim()))
    .filter((row) => row.length && row.some(Boolean));
}

function formatRows(rows, range) {
  if (!rows.length) {
    return `No encontré datos en el rango ${range}.`;
  }

  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines = preview.map((row, index) => `${index + 1}. ${row.join(' | ')}`);
  const hasMore = rows.length > MAX_PREVIEW_ROWS;

  return [
    `Leí ${rows.length} fila(s) de ${range}:`,
    ...lines,
    hasMore ? `... y ${rows.length - MAX_PREVIEW_ROWS} fila(s) más.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseWriteInstruction(message = '') {
  // Expected format:
  // write A1:B2 :: value1,value2;value3,value4
  // append Fights!A:E :: [["a","b"]]
  const [commandPart, payloadPart] = message.split('::');
  if (!payloadPart) {
    return null;
  }

  return {
    range: extractRange(commandPart),
    values: parseValuesPayload(payloadPart),
    append: /\b(append|agrega|agregar|anadir|añadir)\b/i.test(commandPart),
  };
}

export async function writeRange(
  sheetId,
  range,
  values,
  { append = false, valueInputOption = 'RAW', insertDataOption = 'OVERWRITE' } = {}
) {
  if (!sheetId) {
    throw new Error('A sheetId is required to write to Google Sheets.');
  }

  if (!Array.isArray(values)) {
    throw new Error('Values passed to writeRange must be a two-dimensional array.');
  }

  const sheets = await getSheetsClient();

  if (append) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range,
      valueInputOption,
      insertDataOption,
      requestBody: {
        values,
      },
    });
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption,
    requestBody: {
      values,
    },
  });
}

export async function handleMessage(message = '', deps = {}) {
  const text = String(message || '').trim();
  const sheetId = deps.sheetId ?? process.env.SHEET_ID;
  const readRangeImpl = deps.readRangeImpl ?? readRange;
  const writeRangeImpl = deps.writeRangeImpl ?? writeRange;

  if (!sheetId) {
    return '⚠️ Falta SHEET_ID. Configuralo en tu .env para usar Sheet Ops.';
  }

  if (!text) {
    return [
      'Sheet Ops disponible.',
      `- Leer: "leer ${DEFAULT_RANGE}"`,
      '- Escribir: "write Fights!A1:B1 :: Conor McGregor,1.75"',
      '- Append: "append Fights!A:E :: Jon Jones,win"',
    ].join('\n');
  }

  const wantsWrite = /\b(write|escrib|update|set|append|agrega|agregar|anadir|añadir)\b/i.test(
    text
  );
  const wantsRead = /\b(read|leer|muestra|mostrar|ver|get|consulta)\b/i.test(
    text
  );

  try {
    if (wantsWrite) {
      const instruction = parseWriteInstruction(text);
      if (!instruction || !instruction.values?.length) {
        return [
          'No pude interpretar la escritura.',
          'Usá este formato:',
          '- write Fights!A1:B2 :: valor1,valor2;valor3,valor4',
          '- append Fights!A:E :: [["valor1","valor2"]]',
        ].join('\n');
      }

      await writeRangeImpl(sheetId, instruction.range, instruction.values, {
        append: instruction.append,
      });

      return instruction.append
        ? `✅ Agregué ${instruction.values.length} fila(s) en ${instruction.range}.`
        : `✅ Actualicé ${instruction.values.length} fila(s) en ${instruction.range}.`;
    }

    if (wantsRead) {
      const range = extractRange(text);
      const rows = await readRangeImpl(sheetId, range);
      return formatRows(rows, range);
    }

    return [
      'No entendí la acción de Sheet Ops.',
      `Probá: "leer ${DEFAULT_RANGE}" o "write Fights!A1:B1 :: dato1,dato2".`,
    ].join('\n');
  } catch (error) {
    console.error('❌ Sheet Ops error:', error);
    return '⚠️ Sheet Ops falló al procesar la solicitud.';
  }
}

export default {
  readRange,
  writeRange,
  handleMessage,
};
