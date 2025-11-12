/**
 * Test OpenAI para claves sk-proj (100% compatible)
 */
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

// Cargamos el SDK moderno
import { OpenAI } from "openai";

console.log("🟢 Test iniciado");
console.log("🔑 Clave detectada:", process.env.OPENAI_API_KEY?.slice(0, 15) + "...");
console.log("🏢 Org:", process.env.OPENAI_ORG_ID || "(no definida)");
console.log("📁 Project:", process.env.OPENAI_PROJECT_ID || "(no definido)");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
});

(async () => {
  try {
    console.log("💬 Probando conexión con OpenAI...");
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Probando conexión de API. Decime 'OK'." }],
    });

    console.log("✅ Conexión exitosa. Respuesta:", response.choices[0].message.content);
  } catch (err) {
    console.error("❌ Error OpenAI:", err.message);
    if (err.code) console.error("Código:", err.code);
    if (err.status) console.error("Status:", err.status);
  }
})();