console.log("🟢 Test iniciado");

import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID } = process.env;

if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !SHEET_ID) {
  console.error("❌ Faltan variables de entorno de Google en .env");
  process.exit(1);
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  console.log("📖 Leyendo A1:D5...");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A1:D5",
  });

  console.log("🧾 Valores actuales:", res.data.values || "(vacío)");

  console.log("✏️ Escribiendo en celda A1...");
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "A1",
    valueInputOption: "RAW",
    requestBody: { values: [["✅ Conexión exitosa desde el bot"]] },
  });

  console.log("✅ Test completado: lectura y escritura exitosas.");
}

main().catch((err) => console.error("❌ Error Sheets:", err.message));