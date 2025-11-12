import '../core/env.js';
import { google } from 'googleapis';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
let sheetsClient;

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

export default {
  readRange,
  writeRange,
};
