import '../../core/env.js';
import { getDb } from '../../core/sqliteStore.js';

let initialized = false;

export function ensureMedicalSchema() {
  if (initialized) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS med_patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'self',
      first_name TEXT,
      last_name TEXT,
      date_of_birth TEXT,
      biological_sex TEXT,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_med_patients_user ON med_patients(telegram_user_id);

    CREATE TABLE IF NOT EXISTS med_patient_profile (
      patient_id INTEGER PRIMARY KEY,
      height_cm REAL,
      weight_kg REAL,
      blood_type TEXT,
      location TEXT,
      chronic_conditions TEXT,
      allergies TEXT,
      current_medications TEXT,
      family_history TEXT,
      surgeries TEXT,
      hospitalizations TEXT,
      habits TEXT,
      vaccines TEXT,
      pregnancy_status TEXT,
      notes TEXT,
      onboarding_complete INTEGER DEFAULT 0,
      onboarding_step TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES med_patients(id)
    );

    CREATE TABLE IF NOT EXISTS med_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      start_date TEXT,
      recorded_at TEXT NOT NULL,
      chief_complaint TEXT NOT NULL,
      symptoms TEXT,
      symptom_duration TEXT,
      severity TEXT,
      associated_signs TEXT,
      relevant_negatives TEXT,
      context_triggers TEXT,
      bot_hypotheses TEXT,
      urgency_level TEXT DEFAULT 'non_urgent',
      advice_given TEXT,
      physician_evaluation_recommended INTEGER DEFAULT 0,
      physician_confirmed_diagnosis TEXT,
      confirmed_at TEXT,
      status TEXT DEFAULT 'active',
      follow_up_note TEXT,
      related_document_ids TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES med_patients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_med_episodes_patient ON med_episodes(patient_id);
    CREATE INDEX IF NOT EXISTS idx_med_episodes_user ON med_episodes(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_med_episodes_status ON med_episodes(patient_id, status);

    CREATE TABLE IF NOT EXISTS med_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      document_type TEXT NOT NULL DEFAULT 'other',
      title TEXT NOT NULL,
      study_date TEXT,
      recorded_at TEXT NOT NULL,
      source_message_id TEXT,
      raw_text TEXT,
      summary TEXT,
      key_findings TEXT,
      abnormal_values TEXT,
      analysis_json TEXT,
      file_telegram_id TEXT,
      related_episode_id INTEGER,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES med_patients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_med_documents_patient ON med_documents(patient_id);
    CREATE INDEX IF NOT EXISTS idx_med_documents_type ON med_documents(patient_id, document_type);

    CREATE TABLE IF NOT EXISTS med_clinical_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'inferred',
      confidence TEXT DEFAULT 'medium',
      source_episode_id INTEGER,
      source_document_id INTEGER,
      is_active INTEGER DEFAULT 1,
      confirmed_by_user INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES med_patients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_med_insights_patient ON med_clinical_insights(patient_id);
    CREATE INDEX IF NOT EXISTS idx_med_insights_type ON med_clinical_insights(patient_id, insight_type);

    CREATE TABLE IF NOT EXISTS med_followup_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      description TEXT NOT NULL,
      episode_id INTEGER,
      document_id INTEGER,
      due_note TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES med_patients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_med_followup_patient ON med_followup_items(patient_id, status);

    CREATE TABLE IF NOT EXISTS med_user_state (
      telegram_user_id TEXT PRIMARY KEY,
      active_patient_id INTEGER,
      active_module TEXT,
      onboarding_state TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS med_user_settings (
      telegram_user_id TEXT PRIMARY KEY,
      response_length TEXT DEFAULT 'detailed',
      explanation_depth TEXT DEFAULT 'standard',
      default_patient_behavior TEXT DEFAULT 'ask',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS med_operation_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      payload_hash TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      result_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (telegram_user_id, operation_type, source_message_id)
    );

    CREATE TABLE IF NOT EXISTS med_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      guided_action TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      created_at TEXT NOT NULL,
      raw_usage_json TEXT
    );

    CREATE TABLE IF NOT EXISTS med_bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      chat_id TEXT,
      source_message_id TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL
    );
  `);

  const profileMigrations = [
    ['pregnancy_status', 'TEXT'],
    ['notes', 'TEXT'],
  ];
  for (const [col, colType] of profileMigrations) {
    try {
      db.exec(`ALTER TABLE med_patient_profile ADD COLUMN ${col} ${colType}`);
    } catch {
      // column already exists
    }
  }

  initialized = true;
}

function now() {
  return new Date().toISOString();
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function hydratePatient(row) {
  if (!row) return null;
  return { ...row };
}

function hydrateProfile(row) {
  if (!row) return null;
  return {
    ...row,
    chronic_conditions: parseJson(row.chronic_conditions),
    allergies: parseJson(row.allergies),
    current_medications: parseJson(row.current_medications),
    family_history: parseJson(row.family_history),
    surgeries: parseJson(row.surgeries),
    hospitalizations: parseJson(row.hospitalizations),
    habits: parseJson(row.habits),
    vaccines: parseJson(row.vaccines),
  };
}

function hydrateEpisode(row) {
  if (!row) return null;
  return {
    ...row,
    symptoms: parseJson(row.symptoms),
    associated_signs: parseJson(row.associated_signs),
    relevant_negatives: parseJson(row.relevant_negatives),
    bot_hypotheses: parseJson(row.bot_hypotheses),
    related_document_ids: parseJson(row.related_document_ids),
  };
}

function hydrateDocument(row) {
  if (!row) return null;
  return {
    ...row,
    key_findings: parseJson(row.key_findings),
    abnormal_values: parseJson(row.abnormal_values),
    analysis_json: parseJson(row.analysis_json),
    tags: parseJson(row.tags),
  };
}

function hydrateInsight(row) {
  if (!row) return null;
  return { ...row };
}

// ──────────────────────────────────────────────
// PATIENTS
// ──────────────────────────────────────────────

export function createPatient(userId, data = {}) {
  const db = getDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO med_patients
       (telegram_user_id, label, relationship, first_name, last_name, date_of_birth, biological_sex, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      String(userId),
      String(data.label || 'Yo'),
      String(data.relationship || 'self'),
      data.first_name || null,
      data.last_name || null,
      data.date_of_birth || null,
      data.biological_sex || null,
      data.is_default ? 1 : 0,
      ts,
      ts
    );
  const patientId = result.lastInsertRowid;

  db.prepare(
    `INSERT OR IGNORE INTO med_patient_profile
     (patient_id, onboarding_complete, onboarding_step, created_at, updated_at)
     VALUES (?, 0, 'basic', ?, ?)`
  ).run(patientId, ts, ts);

  return getPatient(patientId);
}

export function listPatients(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM med_patients WHERE telegram_user_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC`
    )
    .all(String(userId));
  return rows.map(hydratePatient);
}

export function getPatient(patientId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_patients WHERE id = ?`).get(Number(patientId));
  return hydratePatient(row);
}

export function getDefaultPatient(userId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM med_patients WHERE telegram_user_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1`
    )
    .get(String(userId));
  return hydratePatient(row);
}

export function setDefaultPatient(userId, patientId) {
  const db = getDb();
  const ts = now();
  db.prepare(
    `UPDATE med_patients SET is_default = 0, updated_at = ? WHERE telegram_user_id = ?`
  ).run(ts, String(userId));
  db.prepare(
    `UPDATE med_patients SET is_default = 1, updated_at = ? WHERE id = ? AND telegram_user_id = ?`
  ).run(ts, Number(patientId), String(userId));
}

export function updatePatient(patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const fields = [];
  const vals = [];
  const allowed = ['label', 'relationship', 'first_name', 'last_name', 'date_of_birth', 'biological_sex'];
  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      vals.push(data[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(ts, Number(patientId));
  db.prepare(`UPDATE med_patients SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deactivatePatient(patientId) {
  const db = getDb();
  db.prepare(`UPDATE med_patients SET is_active = 0, is_default = 0, updated_at = ? WHERE id = ?`).run(
    now(),
    Number(patientId)
  );
}

// ──────────────────────────────────────────────
// PATIENT PROFILE
// ──────────────────────────────────────────────

export function getPatientProfile(patientId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_patient_profile WHERE patient_id = ?`).get(Number(patientId));
  return hydrateProfile(row);
}

export function upsertPatientProfile(patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const existing = db.prepare(`SELECT patient_id FROM med_patient_profile WHERE patient_id = ?`).get(Number(patientId));
  if (!existing) {
    db.prepare(
      `INSERT INTO med_patient_profile (patient_id, created_at, updated_at) VALUES (?, ?, ?)`
    ).run(Number(patientId), ts, ts);
  }
  const allowed = [
    'height_cm', 'weight_kg', 'blood_type', 'location', 'pregnancy_status', 'notes',
    'onboarding_complete', 'onboarding_step',
  ];
  const jsonFields = ['chronic_conditions', 'allergies', 'current_medications', 'family_history', 'surgeries', 'hospitalizations', 'habits', 'vaccines'];
  const fields = [];
  const vals = [];
  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      vals.push(data[key]);
    }
  }
  for (const key of jsonFields) {
    if (key in data) {
      fields.push(`${key} = ?`);
      vals.push(safeJson(data[key]));
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(ts, Number(patientId));
  db.prepare(`UPDATE med_patient_profile SET ${fields.join(', ')} WHERE patient_id = ?`).run(...vals);
}

export function setOnboardingStep(patientId, step) {
  upsertPatientProfile(patientId, { onboarding_step: step });
}

export function completeOnboarding(patientId) {
  upsertPatientProfile(patientId, { onboarding_complete: 1, onboarding_step: null });
}

// ──────────────────────────────────────────────
// USER STATE
// ──────────────────────────────────────────────

export function getMedUserState(userId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_user_state WHERE telegram_user_id = ?`).get(String(userId));
  if (!row) return null;
  return { ...row, onboarding_state: parseJson(row.onboarding_state) };
}

export function setMedUserState(userId, data = {}) {
  const db = getDb();
  const ts = now();
  const existing = db.prepare(`SELECT telegram_user_id FROM med_user_state WHERE telegram_user_id = ?`).get(String(userId));
  if (!existing) {
    db.prepare(
      `INSERT INTO med_user_state (telegram_user_id, active_patient_id, active_module, onboarding_state, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(String(userId), data.active_patient_id ?? null, data.active_module ?? null, safeJson(data.onboarding_state ?? null), ts);
    return;
  }
  const fields = [];
  const vals = [];
  if ('active_patient_id' in data) { fields.push('active_patient_id = ?'); vals.push(data.active_patient_id); }
  if ('active_module' in data) { fields.push('active_module = ?'); vals.push(data.active_module); }
  if ('onboarding_state' in data) { fields.push('onboarding_state = ?'); vals.push(safeJson(data.onboarding_state)); }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(ts, String(userId));
  db.prepare(`UPDATE med_user_state SET ${fields.join(', ')} WHERE telegram_user_id = ?`).run(...vals);
}

export function setActivePatient(userId, patientId) {
  setMedUserState(userId, { active_patient_id: patientId });
  setDefaultPatient(userId, patientId);
}

// ──────────────────────────────────────────────
// EPISODES
// ──────────────────────────────────────────────

export function createEpisode(userId, patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO med_episodes
       (patient_id, telegram_user_id, title, start_date, recorded_at, chief_complaint, symptoms, symptom_duration, severity, associated_signs, relevant_negatives, context_triggers, bot_hypotheses, urgency_level, advice_given, physician_evaluation_recommended, status, follow_up_note, related_document_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(patientId),
      String(userId),
      String(data.title || data.chief_complaint || 'Episodio'),
      data.start_date || null,
      ts,
      String(data.chief_complaint || ''),
      safeJson(data.symptoms),
      data.symptom_duration || null,
      data.severity || null,
      safeJson(data.associated_signs),
      safeJson(data.relevant_negatives),
      data.context_triggers || null,
      safeJson(data.bot_hypotheses),
      data.urgency_level || 'non_urgent',
      data.advice_given || null,
      data.physician_evaluation_recommended ? 1 : 0,
      data.status || 'active',
      data.follow_up_note || null,
      safeJson(data.related_document_ids),
      ts,
      ts
    );
  return Number(result.lastInsertRowid);
}

export function getEpisode(episodeId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_episodes WHERE id = ?`).get(Number(episodeId));
  return hydrateEpisode(row);
}

export function listEpisodesByStatus(patientId, status = 'active') {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM med_episodes WHERE patient_id = ? AND status = ? ORDER BY recorded_at DESC`)
    .all(Number(patientId), status);
  return rows.map(hydrateEpisode);
}

export function listRecentEpisodes(patientId, limit = 10) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM med_episodes WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT ?`)
    .all(Number(patientId), limit);
  return rows.map(hydrateEpisode);
}

export function listAllActiveEpisodes(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.*, p.label AS patient_label FROM med_episodes e
       JOIN med_patients p ON p.id = e.patient_id
       WHERE e.telegram_user_id = ? AND e.status = 'active'
       ORDER BY e.recorded_at DESC LIMIT 20`
    )
    .all(String(userId));
  return rows.map(hydrateEpisode);
}

export function updateEpisode(episodeId, data = {}) {
  const db = getDb();
  const ts = now();
  const allowed = ['title', 'status', 'urgency_level', 'advice_given', 'follow_up_note', 'physician_evaluation_recommended', 'physician_confirmed_diagnosis', 'confirmed_at', 'symptom_duration', 'severity', 'context_triggers'];
  const jsonFields = ['symptoms', 'associated_signs', 'relevant_negatives', 'bot_hypotheses', 'related_document_ids'];
  const fields = [];
  const vals = [];
  for (const key of allowed) {
    if (key in data) { fields.push(`${key} = ?`); vals.push(data[key]); }
  }
  for (const key of jsonFields) {
    if (key in data) { fields.push(`${key} = ?`); vals.push(safeJson(data[key])); }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(ts, Number(episodeId));
  db.prepare(`UPDATE med_episodes SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function confirmEpisodeDiagnosis(episodeId, diagnosis) {
  updateEpisode(episodeId, {
    physician_confirmed_diagnosis: String(diagnosis),
    confirmed_at: now(),
    status: 'active',
  });
}

export function resolveEpisode(episodeId) {
  updateEpisode(episodeId, { status: 'resolved' });
}

// ──────────────────────────────────────────────
// DOCUMENTS
// ──────────────────────────────────────────────

export function createDocument(userId, patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO med_documents
       (patient_id, telegram_user_id, document_type, title, study_date, recorded_at, source_message_id, raw_text, summary, key_findings, abnormal_values, analysis_json, file_telegram_id, related_episode_id, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(patientId),
      String(userId),
      String(data.document_type || 'other'),
      String(data.title || 'Documento médico'),
      data.study_date || null,
      ts,
      data.source_message_id || null,
      data.raw_text || null,
      data.summary || null,
      safeJson(data.key_findings),
      safeJson(data.abnormal_values),
      safeJson(data.analysis_json),
      data.file_telegram_id || null,
      data.related_episode_id || null,
      safeJson(data.tags),
      ts,
      ts
    );
  return Number(result.lastInsertRowid);
}

export function listDocuments(patientId, { type, limit = 20 } = {}) {
  const db = getDb();
  if (type) {
    const rows = db
      .prepare(`SELECT * FROM med_documents WHERE patient_id = ? AND document_type = ? ORDER BY recorded_at DESC LIMIT ?`)
      .all(Number(patientId), type, limit);
    return rows.map(hydrateDocument);
  }
  const rows = db
    .prepare(`SELECT * FROM med_documents WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT ?`)
    .all(Number(patientId), limit);
  return rows.map(hydrateDocument);
}

export function searchDocuments(patientId, query) {
  const db = getDb();
  const q = `%${String(query || '').toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT * FROM med_documents WHERE patient_id = ?
       AND (lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(raw_text) LIKE ? OR lower(document_type) LIKE ?)
       ORDER BY recorded_at DESC LIMIT 10`
    )
    .all(Number(patientId), q, q, q, q);
  return rows.map(hydrateDocument);
}

export function getDocument(documentId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_documents WHERE id = ?`).get(Number(documentId));
  return hydrateDocument(row);
}

export function linkDocumentToEpisode(documentId, episodeId) {
  const db = getDb();
  db.prepare(`UPDATE med_documents SET related_episode_id = ?, updated_at = ? WHERE id = ?`).run(
    Number(episodeId),
    now(),
    Number(documentId)
  );
}

export function findComparableDocuments(patientId, documentType, limit = 5) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM med_documents WHERE patient_id = ? AND document_type = ? ORDER BY recorded_at DESC LIMIT ?`
    )
    .all(Number(patientId), documentType, limit);
  return rows.map(hydrateDocument);
}

// ──────────────────────────────────────────────
// CLINICAL INSIGHTS
// ──────────────────────────────────────────────

export function saveInsight(userId, patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO med_clinical_insights
       (patient_id, telegram_user_id, insight_type, content, provenance, confidence, source_episode_id, source_document_id, is_active, confirmed_by_user, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
    )
    .run(
      Number(patientId),
      String(userId),
      String(data.insight_type || 'other'),
      String(data.content || ''),
      String(data.provenance || 'inferred'),
      String(data.confidence || 'medium'),
      data.source_episode_id || null,
      data.source_document_id || null,
      ts,
      ts
    );
  return Number(result.lastInsertRowid);
}

export function listInsights(patientId, { type } = {}) {
  const db = getDb();
  if (type) {
    const rows = db
      .prepare(`SELECT * FROM med_clinical_insights WHERE patient_id = ? AND insight_type = ? AND is_active = 1 ORDER BY created_at DESC`)
      .all(Number(patientId), type);
    return rows.map(hydrateInsight);
  }
  const rows = db
    .prepare(`SELECT * FROM med_clinical_insights WHERE patient_id = ? AND is_active = 1 ORDER BY insight_type, created_at DESC`)
    .all(Number(patientId));
  return rows.map(hydrateInsight);
}

export function confirmInsight(insightId) {
  const db = getDb();
  db.prepare(`UPDATE med_clinical_insights SET confirmed_by_user = 1, updated_at = ? WHERE id = ?`).run(now(), Number(insightId));
}

export function dismissInsight(insightId) {
  const db = getDb();
  db.prepare(`UPDATE med_clinical_insights SET is_active = 0, updated_at = ? WHERE id = ?`).run(now(), Number(insightId));
}

// ──────────────────────────────────────────────
// FOLLOW-UP ITEMS
// ──────────────────────────────────────────────

export function createFollowupItem(userId, patientId, data = {}) {
  const db = getDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO med_followup_items
       (patient_id, telegram_user_id, domain, description, episode_id, document_id, due_note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(
      Number(patientId),
      String(userId),
      String(data.domain || 'symptom'),
      String(data.description || ''),
      data.episode_id || null,
      data.document_id || null,
      data.due_note || null,
      ts,
      ts
    );
  return Number(result.lastInsertRowid);
}

export function listOpenFollowups(patientId) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM med_followup_items WHERE patient_id = ? AND status = 'open' ORDER BY created_at DESC`)
    .all(Number(patientId));
  return rows;
}

export function listAllOpenFollowups(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.*, p.label AS patient_label FROM med_followup_items f
       JOIN med_patients p ON p.id = f.patient_id
       WHERE f.telegram_user_id = ? AND f.status = 'open'
       ORDER BY f.created_at DESC LIMIT 20`
    )
    .all(String(userId));
  return rows;
}

export function resolveFollowupItem(id) {
  const db = getDb();
  db.prepare(`UPDATE med_followup_items SET status = 'resolved', updated_at = ? WHERE id = ?`).run(now(), Number(id));
}

// ──────────────────────────────────────────────
// USER SETTINGS
// ──────────────────────────────────────────────

export function getMedUserSettings(userId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM med_user_settings WHERE telegram_user_id = ?`).get(String(userId));
  return row || { response_length: 'detailed', explanation_depth: 'standard', default_patient_behavior: 'ask' };
}

export function upsertMedUserSettings(userId, data = {}) {
  const db = getDb();
  const ts = now();
  const existing = db.prepare(`SELECT telegram_user_id FROM med_user_settings WHERE telegram_user_id = ?`).get(String(userId));
  if (!existing) {
    db.prepare(
      `INSERT INTO med_user_settings (telegram_user_id, response_length, explanation_depth, default_patient_behavior, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(
      String(userId),
      data.response_length || 'detailed',
      data.explanation_depth || 'standard',
      data.default_patient_behavior || 'ask',
      ts
    );
    return;
  }
  const fields = [];
  const vals = [];
  for (const key of ['response_length', 'explanation_depth', 'default_patient_behavior']) {
    if (key in data) { fields.push(`${key} = ?`); vals.push(data[key]); }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(ts, String(userId));
  db.prepare(`UPDATE med_user_settings SET ${fields.join(', ')} WHERE telegram_user_id = ?`).run(...vals);
}

// ──────────────────────────────────────────────
// USAGE RECORDS
// ──────────────────────────────────────────────

export function recordMedUsage(userId, data = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO med_usage_records
     (telegram_user_id, guided_action, model, input_tokens, output_tokens, total_tokens, reasoning_tokens, cached_tokens, created_at, raw_usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(userId),
    data.guided_action || null,
    data.model || null,
    data.input_tokens || 0,
    data.output_tokens || 0,
    data.total_tokens || 0,
    data.reasoning_tokens || 0,
    data.cached_tokens || 0,
    new Date().toISOString(),
    data.raw_usage_json ? JSON.stringify(data.raw_usage_json) : null
  );
}

// ──────────────────────────────────────────────
// IDEMPOTENCY
// ──────────────────────────────────────────────

export function withMedOperationReceipt({ userId, operationType, sourceMessageId, applyMutation }) {
  const db = getDb();
  const ts = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, status, result_json FROM med_operation_receipts WHERE telegram_user_id = ? AND operation_type = ? AND source_message_id = ?`
    )
    .get(String(userId), String(operationType), String(sourceMessageId));

  if (existing) {
    return {
      ok: true,
      idempotencyStatus: 'replayed',
      result: existing.result_json ? JSON.parse(existing.result_json) : null,
    };
  }

  const result = applyMutation();

  try {
    db.prepare(
      `INSERT INTO med_operation_receipts (telegram_user_id, operation_type, source_message_id, status, result_json, created_at) VALUES (?, ?, ?, 'ok', ?, ?)`
    ).run(String(userId), String(operationType), String(sourceMessageId), result ? JSON.stringify(result) : null, ts);
  } catch {
    // concurrent insert race — ignore
  }

  return { ok: true, idempotencyStatus: 'new', result };
}

// ──────────────────────────────────────────────
// BUG REPORTS
// ──────────────────────────────────────────────

export function addMedBugReport(userId, chatId, sourceMessageId, messageText) {
  const db = getDb();
  db.prepare(
    `INSERT INTO med_bug_reports (telegram_user_id, chat_id, source_message_id, message_text, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`
  ).run(String(userId), String(chatId || ''), String(sourceMessageId), String(messageText), new Date().toISOString());
}
