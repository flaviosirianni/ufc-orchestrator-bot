import crypto from 'node:crypto';
import fs from 'node:fs';
import OpenAI from 'openai';
import '../../core/env.js';
import { startTelegramBot } from '../../core/telegramBot.js';
import { upsertUser, upsertChat, getCreditState, listCreditTransactions, spendCredits, addCredits, getUsageCounters } from '../../core/sqliteStore.js';
import { createBillingApiClient } from '../../platform/billing/billingApiClient.js';
import { createBillingUserStoreBridge } from '../../platform/billing/billingBridge.js';
import { createHealthServer } from '../../platform/runtime/healthServer.js';
import { createDisabledTelegramRuntime, resolveManifestTelegramToken } from '../../platform/runtime/telegramRuntime.js';
import { enforcePolicyPack } from '../../platform/policy/policyGuard.js';
import {
  ensureMedicalSchema,
  createPatient,
  listPatients,
  getPatient,
  getDefaultPatient,
  setDefaultPatient,
  setActivePatient,
  updatePatient,
  deactivatePatient,
  getPatientProfile,
  upsertPatientProfile,
  setOnboardingStep,
  completeOnboarding,
  getMedUserState,
  setMedUserState,
  createEpisode,
  getEpisode,
  listEpisodesByStatus,
  listRecentEpisodes,
  listAllActiveEpisodes,
  updateEpisode,
  confirmEpisodeDiagnosis,
  resolveEpisode,
  createDocument,
  listDocuments,
  searchDocuments,
  getDocument,
  linkDocumentToEpisode,
  findComparableDocuments,
  saveInsight,
  listInsights,
  confirmInsight,
  dismissInsight,
  createFollowupItem,
  listOpenFollowups,
  listAllOpenFollowups,
  resolveFollowupItem,
  getMedUserSettings,
  upsertMedUserSettings,
  recordMedUsage,
  withMedOperationReceipt,
  addMedBugReport,
  addMedFeatureRequest,
} from './medicalStore.js';
import { startMedicalDbReliabilityLoop } from './medicalReliability.js';
import {
  buildPatientContextString,
  formatEpisodeCard,
  formatDocumentSummary,
  formatSummaryCard,
  formatFollowupList,
  formatPatientList,
  buildConsultPrepContext,
  extractEpisodeData,
  extractStructuredInsights,
  extractFollowupItems,
  parsePatientOnboardingTurn,
  parseDocumentAnalysis,
  resolveUrgencyLabel,
  resolveRelationshipLabel,
  resolveDocumentTypeLabel,
  resolveStatusLabel,
  estimateDocumentType,
  parseFeedbackPayload,
} from './medicalDomain.js';

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────

const DEFAULT_MODEL = process.env.OVIDIUS_MEDIBOT_MODEL || process.env.BOT_MODEL || 'gpt-4.1-mini';
const DEFAULT_SMART_MODELS = process.env.OVIDIUS_MEDIBOT_SMART_MODELS || 'gpt-4.1,gpt-4.1-mini';
const CREDIT_ENFORCE = String(process.env.CREDIT_ENFORCE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_USER_TIMEZONE = process.env.DEFAULT_USER_TIMEZONE || 'America/Argentina/Buenos_Aires';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const DEFAULT_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';

// ──────────────────────────────────────────────
// AI HELPERS
// ──────────────────────────────────────────────

function parseModelCandidates(raw = '') {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isUnavailableModelError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 404 || status === 400;
}

async function createSmartResponse({ openai, modelCandidates = [], instructions = '', input }) {
  const candidates = modelCandidates.length ? modelCandidates : [DEFAULT_MODEL];
  let lastError = null;
  for (const model of candidates) {
    try {
      const response = await openai.responses.create({ model, instructions, input });
      return { ok: true, response, model };
    } catch (error) {
      if (isUnavailableModelError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('No available model');
}

function extractOutputText(response) {
  if (!response) return '';
  if (typeof response.output_text === 'string') return response.output_text;
  const outputs = response.output || [];
  for (const item of outputs) {
    if (item?.type === 'message') {
      const content = item.content || [];
      for (const c of content) {
        if (c?.type === 'output_text' && c.text) return c.text;
        if (c?.type === 'text' && c.text) return c.text;
      }
    }
  }
  return '';
}

function extractUsageSnapshot(response) {
  const u = response?.usage || {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    totalTokens: u.total_tokens || 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens || 0,
    cachedTokens: u.input_tokens_details?.cached_tokens || 0,
    rawUsage: u,
  };
}

function extractJsonObject(text = '') {
  const str = String(text || '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/) || str.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? match[1] : str;
  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// INPUT NORMALIZATION
// ──────────────────────────────────────────────

function normalizeRouteInput(input) {
  if (typeof input === 'string') {
    return { message: input, metadata: {} };
  }
  return {
    message: String(input?.message ?? ''),
    metadata: input ?? {},
  };
}

function buildSpendIdempotencyKey(userId, guidedAction, sourceMessageId) {
  const raw = `med:${userId}:${guidedAction}:${sourceMessageId}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function formatFeedbackWriteFailure(action = '', errorCode = '') {
  const suffix = errorCode ? ` (detalle: ${errorCode})` : '';
  if (action === 'report_bug') return `❌ No pude guardar tu reporte de bug${suffix}. Reintentá con una descripción breve en texto.`;
  if (action === 'submit_feature_request') return `❌ No pude guardar tu feature request${suffix}. Reintentá con una descripción breve en texto.`;
  return `❌ No pude guardar el registro en la DB${suffix}.`;
}

function formatIdempotencyNotice(idempotencyStatus = '') {
  const normalized = String(idempotencyStatus || '').toLowerCase();
  if (normalized === 'replayed' || normalized === 'replayed_payload_mismatch') {
    return 'ℹ️ Ese mensaje ya estaba procesado; no dupliqué datos.';
  }
  return '';
}

// ──────────────────────────────────────────────
// CREDITS REPLY
// ──────────────────────────────────────────────

function buildCreditsReply({ state, usage, transactions, topupUrl, packs }) {
  const available = state?.availableCredits ?? 0;
  const paid = state?.paidCredits ?? 0;
  const free = state?.freeCredits ?? 0;
  const lines = [
    `💳 *Tus créditos*`,
    ``,
    `Disponibles: *${available}* (${paid} pagos + ${free} gratuitos)`,
  ];
  if (topupUrl) lines.push(`\n🔗 Recargar: ${topupUrl}`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────
// COST ESTIMATION
// ──────────────────────────────────────────────

function estimateRequestCost(manifest, mediaStats = {}) {
  const costs = manifest?.credit_policy?.costs || {};
  const base = costs.analysis ?? 1.0;
  const imgCost = costs.image ?? 0.5;
  const audioCost = costs.audio_minute ?? 0.2;
  return base + (mediaStats.imageCount || 0) * imgCost + ((mediaStats.audioSeconds || 0) / 60) * audioCost;
}

// ──────────────────────────────────────────────
// ONBOARDING HELPERS
// ──────────────────────────────────────────────

async function runOnboardingTurn(openai, modelCandidates, userId, userState, message, inputItems) {
  const state = userState?.onboarding_state ? (typeof userState.onboarding_state === 'string' ? JSON.parse(userState.onboarding_state) : userState.onboarding_state) : {};
  const step = state.step || 'welcome';

  if (step === 'welcome') {
    await setMedUserState(userId, {
      onboarding_state: JSON.stringify({ step: 'ask_name' }),
    });
    return {
      reply: `¡Hola! Soy *Ovidius*, tu asistente médico de acompañamiento.\n\nVoy a ayudarte a llevar un registro médico organizado y a entender mejor tu salud.\n\nPrimero, ¿este perfil es para vos o para alguien más (hijo/a, familiar, etc.)?`,
      done: false,
    };
  }

  const instructions = [
    'Sos un extractor de datos de perfil médico.',
    'El usuario está en el proceso de crear su primer perfil de paciente.',
    `Paso actual: ${step}`,
    'Extraé los datos que el usuario proporcionó y devolvé JSON puro con este schema:',
    JSON.stringify({
      patient_data: {
        label: 'string — nombre o etiqueta del paciente (ej: Yo, Juan, Mi hijo Mateo)',
        relationship: 'self|child|partner|parent|grandparent|other',
        first_name: 'string|null',
        date_of_birth: 'string|null — año o fecha aproximada',
        biological_sex: 'male|female|other|null',
        chronic_conditions: 'array of strings|null',
        allergies: 'array of strings|null',
        current_medications: 'array of strings|null',
      },
      next_step: 'done|ask_conditions',
      reply: 'string — respuesta natural al usuario para continuar o confirmar',
    }),
    'Reglas:',
    '- Si el usuario dice "yo", "para mí", "mi perfil" → relationship=self, label="Yo"',
    '- Si menciona a otra persona, capturá el nombre y la relación',
    '- Si no dio condiciones/alergias/medicamentos todavía, next_step=ask_conditions y preguntale',
    '- Si ya dio suficiente info básica, next_step=done',
    '- Solo JSON, sin texto adicional',
  ].join('\n');

  const content = [{ type: 'input_text', text: message || '(sin texto)' }];
  for (const item of inputItems || []) {
    if (item.type === 'image') content.push(item);
  }

  const { response, model } = await createSmartResponse({
    openai, modelCandidates,
    instructions,
    input: [{ role: 'user', content }],
  });

  const outputText = extractOutputText(response);
  const parsed = extractJsonObject(outputText);

  if (!parsed) {
    return { reply: 'Entendido. ¿Podés contarme un poco más para crear tu perfil?', done: false };
  }

  const patientData = parsed.patient_data || {};
  const nextStep = parsed.next_step || 'done';
  const replyText = parsed.reply || 'Perfil creado. ¡Ya podés empezar a usar el asistente!';

  if (patientData.label || patientData.first_name) {
    const patient = await createPatient(userId, {
      label: patientData.label || patientData.first_name || 'Yo',
      relationship: patientData.relationship || 'self',
      first_name: patientData.first_name || null,
      date_of_birth: patientData.date_of_birth || null,
      biological_sex: patientData.biological_sex || null,
      is_default: 1,
    });

    if (patient?.id) {
      await setActivePatient(userId, patient.id);
      if (patientData.chronic_conditions || patientData.allergies || patientData.current_medications) {
        await upsertPatientProfile(patient.id, {
          chronic_conditions: patientData.chronic_conditions || null,
          allergies: patientData.allergies || null,
          current_medications: patientData.current_medications || null,
          onboarding_complete: nextStep === 'done' ? 1 : 0,
          onboarding_step: nextStep === 'done' ? null : nextStep,
        });
      }
    }
  }

  if (nextStep === 'done') {
    await setMedUserState(userId, { onboarding_state: JSON.stringify({ step: 'complete' }) });
  } else {
    await setMedUserState(userId, { onboarding_state: JSON.stringify({ step: nextStep }) });
  }

  return { reply: replyText, done: nextStep === 'done' };
}

// ──────────────────────────────────────────────
// HANDLERS
// ──────────────────────────────────────────────

async function handleFreeChat({ openai, modelCandidates, userId, patient, profile, recentEpisodes, insights, openFollowups, message, inputItems, guidedAction, conversationHistory, systemPrompt }) {
  const patientContext = patient
    ? buildPatientContextString(patient, profile, recentEpisodes, insights, openFollowups)
    : '';

  const modeHint = {
    med_free_chat: 'El usuario describe un síntoma o problema médico. Orientá con detalle clínico.',
    med_new_episode: 'El usuario quiere reportar un nuevo episodio o problema de salud.',
    med_general_question: 'El usuario hace una pregunta médica general. Respondé de forma educativa y clara.',
    med_followup_episode: 'El usuario quiere continuar o actualizar un episodio anterior.',
  }[guidedAction] || 'Consulta médica general.';

  const instructions = [
    systemPrompt,
    '',
    patientContext,
    '',
    `Modo actual: ${modeHint}`,
    '',
    'Después de tu respuesta al usuario, si la consulta tiene contenido clínicamente relevante para guardar,',
    'adjuntá al final un bloque JSON (separado con "---JSON---") con:',
    JSON.stringify({
      episode: {
        title: 'string|null — título breve del episodio (null si no aplica)',
        chief_complaint: 'string|null',
        symptoms: 'array of strings|null',
        severity: 'mild|moderate|severe|null',
        symptom_duration: 'string|null',
        context_triggers: 'string|null',
        bot_hypotheses: 'array of strings — hipótesis/diferenciales|null',
        urgency_level: 'non_urgent|seek_soon|seek_today|urgent',
        advice_given: 'string|null — resumen del consejo dado',
        physician_evaluation_recommended: 'boolean',
        follow_up_note: 'string|null',
      },
      insights: [
        { insight_type: 'allergy|chronic_condition|medication|diagnosis|lab_finding|surgery|family_history|habit|other', content: 'string', provenance: 'inferred|user_stated' }
      ],
      followup_items: [
        { domain: 'symptom|pending_study|treatment|physician_visit|test_repetition', description: 'string' }
      ],
    }),
    'Reglas para el JSON:',
    '- Solo incluí el bloque JSON si hay información relevante para guardar (síntoma claro, insight nuevo, etc.)',
    '- Si la pregunta es puramente educativa/hipotética, omití el bloque JSON completamente',
    '- El JSON va DESPUÉS de tu respuesta al usuario, separado con "---JSON---"',
  ].join('\n');

  const contentParts = [];
  if (conversationHistory?.length) {
    const historyText = conversationHistory.map(t => `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.content}`).join('\n');
    contentParts.push({ type: 'input_text', text: `Conversación previa:\n${historyText}\n\nMensaje actual del usuario: ${message || '(adjunto)'}` });
  } else {
    contentParts.push({ type: 'input_text', text: message || '(adjunto)' });
  }

  for (const item of inputItems || []) {
    if (item.type === 'image') contentParts.push(item);
  }

  const { response, model } = await createSmartResponse({
    openai, modelCandidates, instructions,
    input: [{ role: 'user', content: contentParts }],
  });

  const fullOutput = extractOutputText(response);
  const usage = extractUsageSnapshot(response);

  const separator = '---JSON---';
  let replyText = fullOutput;
  let structuredJson = null;

  if (fullOutput.includes(separator)) {
    const parts = fullOutput.split(separator);
    replyText = parts[0].trim();
    structuredJson = extractJsonObject(parts[1] || '');
  }

  return { replyText, structuredJson, usage, model };
}

async function handleDocumentInterpretation({ openai, modelCandidates, userId, patient, profile, recentEpisodes, message, inputItems, systemPrompt }) {
  if (!inputItems?.length && !message) {
    return { replyText: 'Por favor, adjuntá el documento o imagen que querés que interprete.', structuredJson: null, usage: null };
  }

  const patientContext = patient
    ? buildPatientContextString(patient, profile, recentEpisodes, [], [])
    : '';

  const instructions = [
    systemPrompt,
    '',
    patientContext,
    '',
    'El usuario quiere que interpretes un documento médico, estudio o imagen clínica.',
    '',
    'Primero, respondé al usuario con:',
    '1. Tipo de documento identificado',
    '2. Resumen en lenguaje claro',
    '3. Hallazgos principales',
    '4. Valores anormales o llamativos (si los hay)',
    '5. Qué puede significar en contexto general',
    '6. Si hay historial del paciente, cómo se relaciona con su contexto',
    '7. Preguntas sugeridas para hacerle al médico',
    '',
    'Después, adjuntá un bloque JSON separado con "---JSON---":',
    JSON.stringify({
      document_type: 'laboratory|imaging|prescription|discharge|consultation|pathology|vaccination|symptom_photo|monitoring|other',
      title: 'string — título descriptivo del documento',
      study_date: 'string|null — YYYY-MM-DD si es detectable',
      summary: 'string — resumen breve en español',
      key_findings: 'array of strings',
      abnormal_values: 'array of strings — valores fuera de rango o llamativos',
      tags: 'array of strings',
      episode_title: 'string|null — título de episodio a crear si corresponde',
      urgency_level: 'non_urgent|seek_soon|seek_today|urgent',
    }),
  ].join('\n');

  const contentParts = [{ type: 'input_text', text: message || 'Por favor interpretá este documento.' }];
  for (const item of inputItems || []) {
    if (item.type === 'image') contentParts.push(item);
  }

  const { response, model } = await createSmartResponse({
    openai, modelCandidates, instructions,
    input: [{ role: 'user', content: contentParts }],
  });

  const fullOutput = extractOutputText(response);
  const usage = extractUsageSnapshot(response);

  const separator = '---JSON---';
  let replyText = fullOutput;
  let structuredJson = null;

  if (fullOutput.includes(separator)) {
    const parts = fullOutput.split(separator);
    replyText = parts[0].trim();
    structuredJson = extractJsonObject(parts[1] || '');
  }

  return { replyText, structuredJson, usage, model };
}

async function handleConsultPrep({ openai, modelCandidates, userId, patient, profile, recentEpisodes, recentDocs, message, systemPrompt }) {
  if (!patient) return { replyText: 'Primero necesito saber para qué paciente preparar el resumen. ¿Para quién es la consulta?', usage: null };

  const consultContext = buildConsultPrepContext(patient, profile, recentEpisodes?.[0], recentDocs?.slice(0, 3));

  const instructions = [
    systemPrompt,
    '',
    consultContext,
    '',
    'El usuario quiere preparar un resumen para una consulta médica real.',
    'Generá un documento estructurado con:',
    '1. Motivo principal de la consulta',
    '2. Cronología de síntomas (si aplica)',
    '3. Lo que ya se hizo/probó',
    '4. Medicación y estudios relevantes',
    '5. Antecedentes importantes del paciente',
    '6. 3-5 preguntas concretas para hacerle al médico',
    '',
    'Si el usuario especificó un problema en su mensaje, centrá el resumen en ese problema.',
    'Si no especificó, usá el episodio activo más reciente o los temas de seguimiento abiertos.',
  ].join('\n');

  const { response, model } = await createSmartResponse({
    openai, modelCandidates, instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: message || 'Preparame el resumen para la consulta.' }] }],
  });

  return { replyText: extractOutputText(response), usage: extractUsageSnapshot(response), model };
}

async function handlePostConsult({ openai, modelCandidates, userId, patient, profile, message, inputItems, systemPrompt }) {
  const patientContext = patient ? buildPatientContextString(patient, profile, [], [], []) : '';

  const instructions = [
    systemPrompt,
    '',
    patientContext,
    '',
    'El usuario quiere entender algo que le dijo/recetó/indicó su médico.',
    'Explicá con claridad:',
    '- El diagnóstico o procedimiento en lenguaje accesible',
    '- Cada medicamento: para qué es, cómo tomarlo, efectos esperados y precauciones',
    '- Los próximos pasos y qué significa cada uno',
    '- Qué señales de alarma seguir monitoreando',
  ].join('\n');

  const contentParts = [{ type: 'input_text', text: message || '(documento adjunto)' }];
  for (const item of inputItems || []) {
    if (item.type === 'image') contentParts.push(item);
  }

  const { response, model } = await createSmartResponse({
    openai, modelCandidates, instructions,
    input: [{ role: 'user', content: contentParts }],
  });

  return { replyText: extractOutputText(response), usage: extractUsageSnapshot(response), model };
}

async function handleProfileEdit({ openai, modelCandidates, patient, profile, message, systemPrompt }) {
  const instructions = [
    'Sos un extractor de datos de perfil clínico.',
    'El usuario quiere actualizar el perfil de un paciente.',
    `Perfil actual: ${JSON.stringify({ label: patient?.label, biological_sex: patient?.biological_sex, date_of_birth: patient?.date_of_birth })}`,
    `Datos clínicos actuales: ${JSON.stringify({ chronic_conditions: profile?.chronic_conditions, allergies: profile?.allergies, current_medications: profile?.current_medications, height_cm: profile?.height_cm, weight_kg: profile?.weight_kg })}`,
    '',
    'Extraé los datos que el usuario quiere actualizar y devolvé JSON puro:',
    JSON.stringify({
      patient_updates: { label: 'string|null', biological_sex: 'male|female|other|null', date_of_birth: 'string|null', first_name: 'string|null' },
      profile_updates: { height_cm: 'number|null', weight_kg: 'number|null', blood_type: 'string|null', pregnancy_status: 'string|null', chronic_conditions: 'array|null', allergies: 'array|null', current_medications: 'array|null', surgeries: 'array|null', habits: 'object|null', notes: 'string|null' },
      reply: 'string — confirmación de lo que se actualizó',
    }),
    'Solo devolvé los campos que el usuario mencionó explícitamente. No inventes datos.',
  ].join('\n');

  const { response, model } = await createSmartResponse({
    openai, modelCandidates, instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
  });

  const outputText = extractOutputText(response);
  const parsed = extractJsonObject(outputText);
  return { parsed, replyText: parsed?.reply || 'Perfil actualizado.', usage: extractUsageSnapshot(response), model };
}

// ──────────────────────────────────────────────
// BOOTSTRAP
// ──────────────────────────────────────────────

export async function bootstrapOvidiusMedibot({ manifest = {} } = {}) {
  ensureMedicalSchema();

  const botId = manifest?.bot_id || 'ovidius_medibot';
  const policyPackId = manifest?.risk_policy || 'medical_guidance_companion';
  const dbPath = manifest?.storage?.db_path || process.env.DB_PATH || '';
  const port = Number(process.env.PORT || 3002);
  const creditFreeWeekly = Number(process.env.CREDIT_FREE_WEEKLY || 5);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const modelCandidates = parseModelCandidates(DEFAULT_SMART_MODELS);

  const billingClient = createBillingApiClient({ botId });
  const billingBridge = createBillingUserStoreBridge({
    billingClient,
    fallbackUserStore: {
      getCreditState,
      listCreditTransactions,
      spendCredits,
      addCredits,
      getUsageCounters,
    },
  });

  const reliabilityLoop = startMedicalDbReliabilityLoop({ dbPath });

  let systemPrompt = '';
  try {
    const promptFile = manifest?.domain_pack?.prompt_file || 'src/bots/ovidius_medibot/prompt.md';
    systemPrompt = fs.readFileSync(promptFile, 'utf-8');
  } catch {
    systemPrompt = 'Sos un asistente médico de acompañamiento. Respondé en español.';
  }

  const router = {
    async routeMessage(input = '') {
      const { message, metadata } = normalizeRouteInput(input);
      const userId = String(metadata?.user?.id || '');
      const chatId = String(metadata?.chat?.id || '');
      const guidedAction = metadata?.guidedAction || '';
      const sourceMessageId = String(metadata?.sourceMessageId || metadata?.message_id || Date.now());
      const inputItems = metadata?.inputItems || [];
      const mediaStats = metadata?.mediaStats || { imageCount: 0, audioSeconds: 0 };

      if (!userId) return 'Error: usuario no identificado.';

      try {
        await upsertUser({ userId, username: metadata?.user?.username, firstName: metadata?.user?.first_name, lastName: metadata?.user?.last_name });
        await upsertChat({ chatId, type: metadata?.chat?.type || 'private', title: metadata?.chat?.title });
      } catch { /* non-fatal */ }

      // Credits gate
      const isNonBillableAction =
        guidedAction === 'view_credits' ||
        guidedAction === 'report_bug' ||
        guidedAction === 'submit_feature_request' ||
        guidedAction === 'med_settings';
      if (CREDIT_ENFORCE && !isNonBillableAction) {
        try {
          await billingBridge.refreshCreditState(userId);
          const state = billingBridge.getCreditState(userId, creditFreeWeekly);
          const cost = estimateRequestCost(manifest, mediaStats);
          if ((state?.availableCredits ?? 0) < cost) {
            const topupUrl = CREDIT_TOPUP_URL || (APP_PUBLIC_URL ? `${APP_PUBLIC_URL}/topup` : '');
            return `⚠️ Créditos insuficientes para esta operación.\n\nNecesitás ${cost} crédito(s) y tenés ${state?.availableCredits ?? 0}.\n\n${topupUrl ? `🔗 Recargá aquí: ${topupUrl}` : 'Contactá al administrador para recargar créditos.'}`;
          }
        } catch { /* billing unavailable — allow */ }
      }

      // View credits
      if (guidedAction === 'view_credits') {
        try {
          await billingBridge.refreshCreditState(userId);
          await billingBridge.refreshCreditTransactions(userId, { limit: 5 });
          const state = billingBridge.getCreditState(userId, creditFreeWeekly);
          const transactions = billingBridge.getUsageCounters({ userId });
          const topupUrl = CREDIT_TOPUP_URL || (APP_PUBLIC_URL ? `${APP_PUBLIC_URL}/topup` : '');
          return buildCreditsReply({ state, usage: null, transactions, topupUrl, packs: DEFAULT_TOPUP_PACKS });
        } catch {
          return '💳 No se pudo obtener el saldo de créditos en este momento.';
        }
      }

      // Bug report + Feature request
      if (guidedAction === 'report_bug' || guidedAction === 'submit_feature_request') {
        const cleanFeedback = String(message || '').trim();
        if (!cleanFeedback) {
          return [
            'Necesito un mensaje de texto para guardar tu feedback.',
            guidedAction === 'report_bug'
              ? 'Ejemplo: `Al interpretar un estudio, el bot no respondió y se quedó cargando.`'
              : 'Ejemplo: `Me gustaría poder exportar el resumen médico en PDF para llevarlo al médico.`',
          ].join('\n');
        }
        const parsedFeedback = parseFeedbackPayload(cleanFeedback, { minLength: 10 });
        if (!parsedFeedback.ok) {
          if (parsedFeedback.error === 'feedback_too_short') {
            return 'Tu mensaje es muy corto. Sumá un poco más de detalle para poder revisarlo bien.';
          }
          return 'No pude leer tu feedback. Reintentá con un mensaje de texto.';
        }
        const feedbackSourceMessageId =
          String(sourceMessageId || '').trim() || `feedback_${crypto.randomUUID()}`;
        const userTimeZone = String(DEFAULT_USER_TIMEZONE);
        const now = new Date().toLocaleString('es-AR', { timeZone: userTimeZone });
        if (guidedAction === 'report_bug') {
          const saved = addMedBugReport(
            userId,
            { chatId, messageText: parsedFeedback.messageText },
            { idempotency: { sourceMessageId: feedbackSourceMessageId, operationType: 'report_bug' } }
          );
          if (!saved?.ok) return formatFeedbackWriteFailure('report_bug', saved?.error || 'db_write_failed');
          const idempotencyNotice = formatIdempotencyNotice(saved.idempotencyStatus);
          return [
            '✅ Gracias, guardé tu reporte de bug.',
            `- ID: ${saved.reportId || 'N/D'}`,
            `- Fecha: ${now} (${userTimeZone})`,
            idempotencyNotice,
          ].filter(Boolean).join('\n');
        } else {
          const saved = addMedFeatureRequest(
            userId,
            { chatId, messageText: parsedFeedback.messageText },
            { idempotency: { sourceMessageId: feedbackSourceMessageId, operationType: 'submit_feature_request' } }
          );
          if (!saved?.ok) return formatFeedbackWriteFailure('submit_feature_request', saved?.error || 'db_write_failed');
          const idempotencyNotice = formatIdempotencyNotice(saved.idempotencyStatus);
          return [
            '✅ Gracias, guardé tu feature request.',
            `- ID: ${saved.requestId || 'N/D'}`,
            `- Fecha: ${now} (${userTimeZone})`,
            idempotencyNotice,
          ].filter(Boolean).join('\n');
        }
      }

      // Settings
      if (guidedAction === 'med_settings') {
        const settings = getMedUserSettings(userId);
        return `⚙️ *Ajustes*\n\nLongitud de respuesta: ${settings.response_length}\nProfundidad de explicación: ${settings.explanation_depth}\nSelección de paciente por defecto: ${settings.default_patient_behavior}\n\nPodés decirme qué querés cambiar (ej: "quiero respuestas más breves").`;
      }

      // Onboarding: usuario sin pacientes
      const patients = listPatients(userId);
      if (!patients.length) {
        const userState = getMedUserState(userId);
        const onboardingState = userState?.onboarding_state
          ? (typeof userState.onboarding_state === 'string' ? JSON.parse(userState.onboarding_state) : userState.onboarding_state)
          : {};

        if (!userState) {
          await setMedUserState(userId, { onboarding_state: JSON.stringify({ step: 'welcome' }) });
        }

        const { reply: onboardingReply, done } = await runOnboardingTurn(
          openai, modelCandidates, userId, userState, message, inputItems
        );
        return onboardingReply;
      }

      // Resolver paciente activo
      let patient = getDefaultPatient(userId);
      const patientSelectMatch = guidedAction?.match(/^med_select_patient:(\d+)$/);
      if (patientSelectMatch) {
        const pid = Number(patientSelectMatch[1]);
        await setActivePatient(userId, pid);
        patient = getPatient(pid);
        return `✅ Perfil activo: *${patient?.label}*. ¿Qué querés consultar?`;
      }

      const profile = patient ? getPatientProfile(patient.id) : null;
      const recentEpisodes = patient ? listRecentEpisodes(patient.id, 5) : [];
      const insights = patient ? listInsights(patient.id) : [];
      const openFollowups = patient ? listOpenFollowups(patient.id) : [];

      // View profiles
      if (guidedAction === 'med_view_profiles') {
        const allPatients = listPatients(userId);
        const list = formatPatientList(allPatients);
        return `👤 *Perfiles médicos*\n\n${list}\n\nPodés agregar una persona nueva desde el menú Perfiles → Agregar persona.`;
      }

      // Add patient
      if (guidedAction === 'med_add_patient') {
        await setMedUserState(userId, { onboarding_state: JSON.stringify({ step: 'ask_name', adding_extra: true }) });
        return `➕ *Agregar persona*\n\n¿Cómo se llama la persona y qué relación tiene con vos? (ej: "Mi hija Valentina, tiene 8 años")`;
      }

      // Edit profile
      if (guidedAction === 'med_edit_profile') {
        if (!patient) return 'No hay perfil activo.';
        const profileSummary = formatSummaryCard(patient, profile, [], [], []);
        return `✏️ *Editar perfil — ${patient.label}*\n\n${profileSummary}\n\nDecime qué querés actualizar.`;
      }

      // Handle mid-edit (text coming in after edit_profile)
      if (guidedAction === 'med_edit_profile' || (message && getActiveMedModule(userId) === 'editing_profile')) {
        if (patient && message) {
          const { parsed, replyText } = await handleProfileEdit({ openai, modelCandidates, patient, profile, message, systemPrompt });
          if (parsed?.patient_updates) await updatePatient(patient.id, parsed.patient_updates);
          if (parsed?.profile_updates) await upsertPatientProfile(patient.id, parsed.profile_updates);
          return replyText;
        }
      }

      // Summary card
      if (guidedAction === 'med_summary_card') {
        if (!patient) return 'No hay perfil activo.';
        const allEpisodes = listRecentEpisodes(patient.id, 20);
        const diagnoses = allEpisodes.filter(e => e.physician_confirmed_diagnosis);
        const summary = formatSummaryCard(patient, profile, allEpisodes, diagnoses, openFollowups);
        return summary;
      }

      // History views
      if (guidedAction === 'med_view_history_active' || guidedAction === 'med_view_history_resolved') {
        if (!patient) return 'No hay perfil activo.';
        const status = guidedAction === 'med_view_history_active' ? 'active' : 'resolved';
        const episodes = listEpisodesByStatus(patient.id, status);
        if (!episodes.length) {
          return guidedAction === 'med_view_history_active'
            ? 'No hay episodios activos registrados.'
            : 'No hay episodios resueltos registrados.';
        }
        const label = guidedAction === 'med_view_history_active' ? '🔴 Episodios activos' : '✅ Episodios resueltos';
        return `${label} — ${patient.label}\n\n${episodes.map(e => formatEpisodeCard(e)).join('\n\n---\n\n')}`;
      }

      // Confirmed diagnoses
      if (guidedAction === 'med_view_diagnoses') {
        if (!patient) return 'No hay perfil activo.';
        const allEps = listRecentEpisodes(patient.id, 50);
        const withDiag = allEps.filter(e => e.physician_confirmed_diagnosis);
        if (!withDiag.length) return `No hay diagnósticos confirmados por médico registrados para ${patient.label}.`;
        return `🩺 *Diagnósticos confirmados — ${patient.label}*\n\n${withDiag.map(e => `• ${e.physician_confirmed_diagnosis} (${e.confirmed_at?.slice(0,10) || 'fecha desconocida'})`).join('\n')}`;
      }

      // Documents
      if (guidedAction === 'med_view_documents') {
        if (!patient) return 'No hay perfil activo.';
        const docs = listDocuments(patient.id, { limit: 10 });
        if (!docs.length) return `No hay documentos cargados para ${patient.label}.`;
        return `📁 *Documentos recientes — ${patient.label}*\n\n${docs.map(d => `• ${d.title} (${d.document_type}) — ${d.recorded_at?.slice(0,10)}`).join('\n')}`;
      }

      // Search documents
      if (guidedAction === 'med_search_document') {
        if (!patient) return 'No hay perfil activo.';
        if (!message) return '🔍 ¿Qué estudio o resultado querés buscar? (ej: "mi último colesterol", "radiografía de tórax")';
        const results = searchDocuments(patient.id, message);
        if (!results.length) return `No encontré documentos que coincidan con "${message}" para ${patient.label}.`;
        return `🔍 *Resultados para "${message}"*\n\n${results.map(d => formatDocumentSummary(d)).join('\n\n---\n\n')}`;
      }

      // Compare studies
      if (guidedAction === 'med_compare_studies') {
        if (!patient) return 'No hay perfil activo.';
        if (!message && !inputItems?.length) return '📊 Para comparar, adjuntá el nuevo estudio o describí qué tipo de estudio querés comparar (ej: "comparar mi nuevo laboratorio").';
        const docType = estimateDocumentType('', '', message || '');
        const priorDocs = findComparableDocuments(patient.id, docType, 3);

        const instructions = [
          systemPrompt,
          '',
          buildPatientContextString(patient, profile, recentEpisodes, insights, []),
          '',
          'El usuario quiere comparar un nuevo estudio con estudios previos.',
          priorDocs.length
            ? `Estudios previos comparables encontrados:\n${priorDocs.map(d => `[${d.recorded_at?.slice(0,10)}] ${d.title}: ${d.summary || ''}\nHallazgos: ${JSON.stringify(d.key_findings)}\nValores anormales: ${JSON.stringify(d.abnormal_values)}`).join('\n\n')}`
            : 'No hay estudios previos comparables guardados.',
          '',
          'Analizá el nuevo estudio y compará con los anteriores si existen. Identificá qué mejoró, empeoró, se mantuvo, o es nuevo.',
        ].join('\n');

        const contentParts = [{ type: 'input_text', text: message || 'Comparar con estudios previos.' }];
        for (const item of inputItems || []) {
          if (item.type === 'image') contentParts.push(item);
        }

        const { response, model } = await createSmartResponse({
          openai, modelCandidates, instructions,
          input: [{ role: 'user', content: contentParts }],
        });
        return extractOutputText(response);
      }

      // Consultation prep
      if (guidedAction === 'med_consult_prep') {
        const recentDocs = patient ? listDocuments(patient.id, { limit: 5 }) : [];
        const { replyText } = await handleConsultPrep({ openai, modelCandidates, userId, patient, profile, recentEpisodes, recentDocs, message, systemPrompt });
        return replyText;
      }

      // Post-consultation clarification
      if (guidedAction === 'med_post_consult') {
        const { replyText, structuredJson, usage, model } = await handleDocumentInterpretation({ openai, modelCandidates, userId, patient, profile, recentEpisodes, message, inputItems, systemPrompt });

        if (structuredJson && patient) {
          try {
            const docId = createDocument(userId, patient.id, {
              document_type: structuredJson.document_type || 'consultation',
              title: structuredJson.title || 'Nota de consulta médica',
              study_date: structuredJson.study_date,
              summary: structuredJson.summary,
              key_findings: structuredJson.key_findings,
              abnormal_values: structuredJson.abnormal_values,
              tags: structuredJson.tags,
              source_message_id: sourceMessageId,
            });
            if (structuredJson.physician_confirmed_diagnosis && recentEpisodes[0]) {
              confirmEpisodeDiagnosis(recentEpisodes[0].id, structuredJson.physician_confirmed_diagnosis);
            }
          } catch { /* non-fatal */ }
        }

        const finalReply = enforcePolicyPack({ text: replyText, policyPackId });
        return finalReply;
      }

      // Follow-up views
      if (guidedAction === 'med_view_followup') {
        const allFollowups = listAllOpenFollowups(userId);
        return `📌 *Seguimiento abierto*\n\n${formatFollowupList(allFollowups)}`;
      }

      if (guidedAction === 'med_update_followup') {
        if (!message) {
          const allFollowups = listAllOpenFollowups(userId);
          if (!allFollowups.length) return 'No hay temas de seguimiento abiertos.';
          return `📌 *Actualizar seguimiento*\n\n${formatFollowupList(allFollowups)}\n\nDecime el número del tema y el nuevo estado (ej: "el 2 está resuelto").`;
        }

        const match = message.match(/\b(\d+)\b.*(resuel|listo|ok|cerr|mejor|ya no)/i);
        if (match) {
          const allFollowups = listAllOpenFollowups(userId);
          const idx = Number(match[1]) - 1;
          if (allFollowups[idx]) {
            resolveFollowupItem(allFollowups[idx].id);
            return `✅ Tema ${Number(match[1])} marcado como resuelto: "${allFollowups[idx].description}"`;
          }
        }
        return 'Decime el número del tema que querés marcar como resuelto (ej: "el 1 está resuelto").';
      }

      // Document upload / interpretation
      if (guidedAction === 'med_upload_document' || guidedAction === 'med_interpret_study') {
        if (!inputItems?.length && !message) {
          return '📤 Por favor, adjuntá el documento o imagen que querés interpretar. Podés enviar una foto, PDF, o describir el resultado.';
        }

        const { replyText, structuredJson, usage, model } = await handleDocumentInterpretation({
          openai, modelCandidates, userId, patient, profile, recentEpisodes, message, inputItems, systemPrompt,
        });

        if (structuredJson && patient) {
          try {
            const docId = createDocument(userId, patient.id, {
              document_type: structuredJson.document_type || 'other',
              title: structuredJson.title || 'Estudio médico',
              study_date: structuredJson.study_date,
              summary: structuredJson.summary,
              key_findings: structuredJson.key_findings,
              abnormal_values: structuredJson.abnormal_values,
              tags: structuredJson.tags,
              source_message_id: sourceMessageId,
              analysis_json: structuredJson,
            });

            if (structuredJson.episode_title) {
              const episodeId = createEpisode(userId, patient.id, {
                title: structuredJson.episode_title,
                chief_complaint: `Resultado de ${resolveDocumentTypeLabel(structuredJson.document_type)}`,
                urgency_level: structuredJson.urgency_level || 'non_urgent',
                physician_evaluation_recommended: structuredJson.urgency_level === 'urgent' || structuredJson.urgency_level === 'seek_today',
              });
              linkDocumentToEpisode(docId, episodeId);
            }

            if (usage) {
              try { recordMedUsage(userId, { guided_action: guidedAction, model, ...usage, raw_usage_json: usage.rawUsage }); } catch { /* ignore */ }
            }
          } catch { /* non-fatal */ }
        }

        const urgencyNote = structuredJson?.urgency_level ? resolveUrgencyLabel(structuredJson.urgency_level) : null;
        const finalReply = urgencyNote
          ? `${replyText}\n\n${urgencyNote}`
          : replyText;

        const withPolicy = enforcePolicyPack({ text: finalReply, policyPackId });

        // Charge credits
        if (CREDIT_ENFORCE) {
          try {
            const cost = estimateRequestCost(manifest, mediaStats);
            await billingBridge.spendCredits(userId, cost, {
              reason: 'analysis',
              idempotencyKey: buildSpendIdempotencyKey(userId, guidedAction, sourceMessageId),
              metadata: { guidedAction, model, mediaStats },
            });
          } catch { /* non-fatal */ }
        }

        return withPolicy;
      }

      // Free chat, new episode, general question, followup episode
      const isChatAction = ['med_free_chat', 'med_new_episode', 'med_general_question', 'med_followup_episode'].includes(guidedAction)
        || (!guidedAction && (message || inputItems?.length));

      if (isChatAction) {
        // Build minimal conversation history from recent episodes
        const conversationHistory = [];

        const { replyText, structuredJson, usage, model } = await handleFreeChat({
          openai, modelCandidates, userId,
          patient: guidedAction === 'med_general_question' ? null : patient,
          profile: guidedAction === 'med_general_question' ? null : profile,
          recentEpisodes: guidedAction === 'med_general_question' ? [] : recentEpisodes,
          insights: guidedAction === 'med_general_question' ? [] : insights,
          openFollowups: guidedAction === 'med_general_question' ? [] : openFollowups,
          message, inputItems, guidedAction, conversationHistory, systemPrompt,
        });

        // Persist episode and insights
        if (structuredJson && patient && guidedAction !== 'med_general_question') {
          try {
            if (structuredJson.episode?.chief_complaint) {
              const epData = structuredJson.episode;
              const episodeId = createEpisode(userId, patient.id, {
                title: epData.title || epData.chief_complaint,
                chief_complaint: epData.chief_complaint,
                symptoms: epData.symptoms,
                severity: epData.severity,
                symptom_duration: epData.symptom_duration,
                context_triggers: epData.context_triggers,
                bot_hypotheses: epData.bot_hypotheses,
                urgency_level: epData.urgency_level || 'non_urgent',
                advice_given: epData.advice_given,
                physician_evaluation_recommended: epData.physician_evaluation_recommended ? 1 : 0,
                follow_up_note: epData.follow_up_note,
              });
            }

            if (structuredJson.insights?.length) {
              for (const insight of structuredJson.insights) {
                if (insight.content) {
                  saveInsight(userId, patient.id, insight);
                }
              }
            }

            if (structuredJson.followup_items?.length) {
              for (const fi of structuredJson.followup_items) {
                if (fi.description) {
                  createFollowupItem(userId, patient.id, fi);
                }
              }
            }

            if (usage) {
              try { recordMedUsage(userId, { guided_action: guidedAction, model, ...usage, raw_usage_json: usage.rawUsage }); } catch { /* ignore */ }
            }
          } catch { /* non-fatal */ }
        }

        const urgencyLevel = structuredJson?.episode?.urgency_level;
        const urgencyNote = urgencyLevel ? resolveUrgencyLabel(urgencyLevel) : null;
        const withUrgency = urgencyNote ? `${replyText}\n\n${urgencyNote}` : replyText;
        const withPolicy = enforcePolicyPack({ text: withUrgency, policyPackId });

        // Charge credits
        if (CREDIT_ENFORCE) {
          try {
            const cost = estimateRequestCost(manifest, mediaStats);
            await billingBridge.spendCredits(userId, cost, {
              reason: 'analysis',
              idempotencyKey: buildSpendIdempotencyKey(userId, guidedAction, sourceMessageId),
              metadata: { guidedAction, model, mediaStats },
            });
          } catch { /* non-fatal */ }
        }

        return withPolicy;
      }

      return 'Seleccioná una opción del menú para comenzar.';
    },
  };

  const { token: telegramToken, tokenEnvName } = resolveManifestTelegramToken(manifest);
  const telegram = telegramToken
    ? startTelegramBot(router, {
        interactionMode: manifest?.interaction_mode || 'guided_strict',
        guidedMenuId: manifest?.domain_pack?.guided_menu || 'ovidius_v1',
        guidedLedgerEnabled: false,
        token: telegramToken,
      })
    : createDisabledTelegramRuntime({ botId, tokenEnvName });

  const healthServer = createHealthServer(port, {
    botId,
    onTopupApplied: async (event = {}) => {
      try {
        const telegramUserId = String(event.user_id || '');
        if (!telegramUserId || !telegram?.sendSystemMessage) return;
        const credits = event.credits || 0;
        await billingBridge.refreshCreditState(telegramUserId);
        const state = billingBridge.getCreditState(telegramUserId, creditFreeWeekly);
        const newBalance = state?.availableCredits ?? credits;
        await telegram.sendSystemMessage({
          userId: telegramUserId,
          text: `✅ Recarga acreditada\n+${credits} créditos\nSaldo actual: ${newBalance} créditos`,
        });
      } catch { /* non-fatal */ }
    },
  });

  return { ok: true, botId };
}

// Helper for tracking active module (lightweight, no DB call)
function getActiveMedModule(userId) {
  return null; // could be extended with in-memory Map if needed
}
