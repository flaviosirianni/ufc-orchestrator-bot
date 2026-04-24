// Domain helpers for ovidius_medibot — formatting, parsing, context building

const URGENCY_LABELS = {
  non_urgent: null,
  seek_soon: '📅 Se recomienda consultar con un médico en los próximos días.',
  seek_today: '⚠️ Se recomienda buscar atención médica el día de hoy.',
  urgent: '🚨 Esta situación puede requerir atención médica urgente.',
};

const RELATIONSHIP_LABELS = {
  self: 'yo',
  child: 'hijo/a',
  partner: 'pareja',
  parent: 'padre/madre',
  grandparent: 'abuelo/a',
  other: 'otro',
};

const DOCUMENT_TYPE_LABELS = {
  laboratory: 'Laboratorio',
  imaging: 'Imagen / Radiología',
  prescription: 'Receta / Prescripción',
  discharge: 'Epicrisis / Alta',
  consultation: 'Nota de consulta',
  pathology: 'Anatomía patológica',
  vaccination: 'Vacunación',
  symptom_photo: 'Foto de síntoma',
  monitoring: 'Automonitoreo',
  other: 'Documento médico',
};

const STATUS_LABELS = {
  active: 'Activo',
  improving: 'En mejora',
  resolved: 'Resuelto',
  escalated: 'Derivado a médico',
};

export function resolveUrgencyLabel(level) {
  return URGENCY_LABELS[level] || null;
}

export function resolveRelationshipLabel(rel) {
  return RELATIONSHIP_LABELS[rel] || rel || 'persona';
}

export function resolveDocumentTypeLabel(type) {
  return DOCUMENT_TYPE_LABELS[type] || DOCUMENT_TYPE_LABELS.other;
}

export function resolveStatusLabel(status) {
  return STATUS_LABELS[status] || status || 'Activo';
}

// ──────────────────────────────────────────────
// PATIENT CONTEXT FOR AI PROMPTS
// ──────────────────────────────────────────────

export function buildPatientContextString(patient, profile, recentEpisodes = [], insights = [], openFollowups = []) {
  if (!patient) return '';

  const parts = [];

  parts.push(`=== CONTEXTO DEL PACIENTE ===`);
  parts.push(`Nombre / Etiqueta: ${patient.label}`);
  if (patient.first_name) parts.push(`Nombre: ${patient.first_name}${patient.last_name ? ' ' + patient.last_name : ''}`);
  if (patient.date_of_birth) parts.push(`Fecha de nacimiento / edad aprox: ${patient.date_of_birth}`);
  if (patient.biological_sex) parts.push(`Sexo biológico: ${patient.biological_sex}`);
  if (patient.relationship && patient.relationship !== 'self') {
    parts.push(`Relación con el usuario: ${resolveRelationshipLabel(patient.relationship)}`);
  }

  if (profile) {
    if (profile.height_cm) parts.push(`Talla: ${profile.height_cm} cm`);
    if (profile.weight_kg) parts.push(`Peso: ${profile.weight_kg} kg`);
    if (profile.blood_type) parts.push(`Grupo sanguíneo: ${profile.blood_type}`);
    if (profile.pregnancy_status) parts.push(`Estado gestacional: ${profile.pregnancy_status}`);
    if (profile.chronic_conditions?.length) {
      parts.push(`Condiciones crónicas conocidas: ${formatJsonList(profile.chronic_conditions)}`);
    }
    if (profile.allergies?.length) {
      parts.push(`Alergias y reacciones adversas: ${formatJsonList(profile.allergies)}`);
    }
    if (profile.current_medications?.length) {
      parts.push(`Medicación actual: ${formatJsonList(profile.current_medications)}`);
    }
    if (profile.surgeries?.length) {
      parts.push(`Antecedentes quirúrgicos: ${formatJsonList(profile.surgeries)}`);
    }
    if (profile.family_history) {
      const fh = typeof profile.family_history === 'object' ? JSON.stringify(profile.family_history) : String(profile.family_history);
      if (fh && fh !== '{}' && fh !== 'null') parts.push(`Antecedentes familiares: ${fh}`);
    }
    if (profile.habits) {
      const h = typeof profile.habits === 'object' ? JSON.stringify(profile.habits) : String(profile.habits);
      if (h && h !== '{}' && h !== 'null') parts.push(`Hábitos / estilo de vida: ${h}`);
    }
    if (profile.notes) parts.push(`Notas adicionales del perfil: ${profile.notes}`);
  }

  if (insights?.length) {
    const insightLines = insights
      .filter(i => i.is_active)
      .map(i => `  - [${i.insight_type}] ${i.content} (fuente: ${i.provenance}${i.confirmed_by_user ? ', confirmado por usuario' : ''})`)
      .join('\n');
    if (insightLines) parts.push(`\nInformación clínica estructurada:\n${insightLines}`);
  }

  if (recentEpisodes?.length) {
    parts.push(`\nEpisodios clínicos recientes (últimos ${recentEpisodes.length}):`);
    for (const ep of recentEpisodes) {
      const status = resolveStatusLabel(ep.status);
      const diag = ep.physician_confirmed_diagnosis ? ` → Diagnóstico confirmado: ${ep.physician_confirmed_diagnosis}` : '';
      parts.push(`  - [${ep.recorded_at?.slice(0,10)}] ${ep.title} (${status})${diag}`);
      if (ep.chief_complaint) parts.push(`    Motivo: ${ep.chief_complaint}`);
      if (ep.follow_up_note) parts.push(`    Seguimiento: ${ep.follow_up_note}`);
    }
  }

  if (openFollowups?.length) {
    parts.push(`\nTemas de seguimiento abiertos:`);
    for (const f of openFollowups) {
      parts.push(`  - [${f.domain}] ${f.description}`);
    }
  }

  parts.push(`=== FIN CONTEXTO DEL PACIENTE ===`);
  return parts.join('\n');
}

function formatJsonList(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ──────────────────────────────────────────────
// FORMATTING HELPERS
// ──────────────────────────────────────────────

export function formatEpisodeCard(episode) {
  if (!episode) return '';
  const lines = [];
  lines.push(`📋 *${episode.title}*`);
  lines.push(`Estado: ${resolveStatusLabel(episode.status)}`);
  if (episode.recorded_at) lines.push(`Registrado: ${episode.recorded_at.slice(0, 10)}`);
  if (episode.chief_complaint) lines.push(`Motivo: ${episode.chief_complaint}`);
  if (episode.symptoms?.length) lines.push(`Síntomas: ${formatJsonList(episode.symptoms)}`);
  if (episode.severity) lines.push(`Severidad: ${episode.severity}`);
  if (episode.symptom_duration) lines.push(`Duración: ${episode.symptom_duration}`);
  if (episode.urgency_level && episode.urgency_level !== 'non_urgent') {
    lines.push(resolveUrgencyLabel(episode.urgency_level));
  }
  if (episode.physician_confirmed_diagnosis) {
    lines.push(`✅ Diagnóstico confirmado: ${episode.physician_confirmed_diagnosis}`);
  }
  if (episode.follow_up_note) lines.push(`Seguimiento: ${episode.follow_up_note}`);
  return lines.filter(Boolean).join('\n');
}

export function formatDocumentSummary(doc) {
  if (!doc) return '';
  const lines = [];
  lines.push(`📄 *${doc.title}*`);
  lines.push(`Tipo: ${resolveDocumentTypeLabel(doc.document_type)}`);
  if (doc.study_date) lines.push(`Fecha del estudio: ${doc.study_date}`);
  else if (doc.recorded_at) lines.push(`Cargado: ${doc.recorded_at.slice(0, 10)}`);
  if (doc.summary) lines.push(`\nResumen: ${doc.summary}`);
  if (doc.key_findings?.length) lines.push(`\nHallazgos clave:\n${formatList(doc.key_findings)}`);
  if (doc.abnormal_values?.length) lines.push(`\nValores anormales / llamativos:\n${formatList(doc.abnormal_values)}`);
  return lines.filter(Boolean).join('\n');
}

function formatList(arr) {
  if (!arr?.length) return '';
  return arr.map(item => `  • ${item}`).join('\n');
}

export function formatSummaryCard(patient, profile, episodes = [], diagnoses = [], openFollowups = []) {
  if (!patient) return 'No hay perfil activo.';
  const lines = [];

  lines.push(`🗂 *Resumen médico — ${patient.label}*`);
  if (patient.date_of_birth) lines.push(`Edad / nacimiento: ${patient.date_of_birth}`);
  if (patient.biological_sex) lines.push(`Sexo: ${patient.biological_sex}`);

  if (profile) {
    if (profile.height_cm || profile.weight_kg) {
      const body = [profile.height_cm ? `${profile.height_cm} cm` : null, profile.weight_kg ? `${profile.weight_kg} kg` : null].filter(Boolean).join(' | ');
      lines.push(`Talla / peso: ${body}`);
    }
    if (profile.blood_type) lines.push(`Grupo sanguíneo: ${profile.blood_type}`);
    if (profile.chronic_conditions?.length) lines.push(`\nCondiciones crónicas:\n${formatList(profile.chronic_conditions)}`);
    if (profile.allergies?.length) lines.push(`\nAlergias:\n${formatList(profile.allergies)}`);
    if (profile.current_medications?.length) lines.push(`\nMedicación actual:\n${formatList(profile.current_medications)}`);
    if (profile.surgeries?.length) lines.push(`\nAntecedentes quirúrgicos:\n${formatList(profile.surgeries)}`);
  }

  const activeEps = episodes.filter(e => e.status === 'active');
  if (activeEps.length) {
    lines.push(`\n🔴 Episodios activos (${activeEps.length}):`);
    for (const ep of activeEps) lines.push(`  • ${ep.title} (${ep.recorded_at?.slice(0,10)})`);
  }

  if (diagnoses.length) {
    lines.push(`\n✅ Diagnósticos confirmados por médico:`);
    for (const ep of diagnoses) lines.push(`  • ${ep.physician_confirmed_diagnosis} — ${ep.title}`);
  }

  if (openFollowups.length) {
    lines.push(`\n📌 Seguimientos pendientes:`);
    for (const f of openFollowups) lines.push(`  • ${f.description}`);
  }

  return lines.join('\n');
}

export function formatFollowupList(items) {
  if (!items?.length) return 'No hay temas de seguimiento abiertos.';
  return items.map((item, i) => `${i + 1}. [${item.domain}] ${item.description}${item.patient_label ? ` (${item.patient_label})` : ''}`).join('\n');
}

export function formatPatientList(patients) {
  if (!patients?.length) return 'No hay perfiles creados.';
  return patients.map((p, i) => `${i + 1}. ${p.label}${p.relationship !== 'self' ? ` (${resolveRelationshipLabel(p.relationship)})` : ''}${p.is_default ? ' ✓' : ''}`).join('\n');
}

// ──────────────────────────────────────────────
// CONSULTATION PREP
// ──────────────────────────────────────────────

export function buildConsultPrepContext(patient, profile, episode, recentDocs = []) {
  const parts = [];

  if (patient) {
    parts.push(`PACIENTE: ${patient.label}`);
    if (patient.date_of_birth) parts.push(`Edad/nacimiento: ${patient.date_of_birth}`);
    if (patient.biological_sex) parts.push(`Sexo: ${patient.biological_sex}`);
  }

  if (profile) {
    if (profile.chronic_conditions?.length) parts.push(`Condiciones crónicas: ${formatJsonList(profile.chronic_conditions)}`);
    if (profile.allergies?.length) parts.push(`Alergias: ${formatJsonList(profile.allergies)}`);
    if (profile.current_medications?.length) parts.push(`Medicación actual: ${formatJsonList(profile.current_medications)}`);
  }

  if (episode) {
    parts.push(`\nEPISODIO PRINCIPAL:`);
    parts.push(`Motivo: ${episode.chief_complaint}`);
    if (episode.symptoms?.length) parts.push(`Síntomas: ${formatJsonList(episode.symptoms)}`);
    if (episode.symptom_duration) parts.push(`Duración: ${episode.symptom_duration}`);
    if (episode.severity) parts.push(`Severidad: ${episode.severity}`);
    if (episode.context_triggers) parts.push(`Contexto/desencadenantes: ${episode.context_triggers}`);
  }

  if (recentDocs.length) {
    parts.push(`\nESTUDIOS RELEVANTES:`);
    for (const doc of recentDocs) {
      parts.push(`- ${doc.title} (${doc.study_date || doc.recorded_at?.slice(0,10)}): ${doc.summary || ''}`);
    }
  }

  return parts.join('\n');
}

// ──────────────────────────────────────────────
// AI OUTPUT PARSING
// ──────────────────────────────────────────────

export function extractEpisodeData(aiOutput) {
  if (!aiOutput) return null;
  const json = safeParseJson(aiOutput);
  if (!json?.episode) return null;
  return json.episode;
}

export function extractStructuredInsights(aiOutput) {
  if (!aiOutput) return [];
  const json = safeParseJson(aiOutput);
  if (!Array.isArray(json?.insights)) return [];
  return json.insights.filter(i => i && i.insight_type && i.content);
}

export function extractFollowupItems(aiOutput) {
  if (!aiOutput) return [];
  const json = safeParseJson(aiOutput);
  if (!Array.isArray(json?.followup_items)) return [];
  return json.followup_items.filter(f => f && f.description);
}

export function parsePatientOnboardingTurn(aiOutput) {
  if (!aiOutput) return null;
  const json = safeParseJson(aiOutput);
  return json?.patient_data || null;
}

export function parseDocumentAnalysis(aiOutput) {
  if (!aiOutput) return null;
  const json = safeParseJson(aiOutput);
  return json || null;
}

function safeParseJson(raw) {
  if (!raw) return null;
  const str = String(raw);
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/) || str.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? match[1] : str;
  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
}

export function estimateDocumentType(filename = '', mimeType = '', rawText = '') {
  const text = `${filename} ${mimeType} ${rawText}`.toLowerCase();
  if (text.includes('laboratorio') || text.includes('hematología') || text.includes('bioquím') || text.includes('hemograma') || text.includes('glucosa') || text.includes('colesterol')) return 'laboratory';
  if (text.includes('radiolog') || text.includes('ecog') || text.includes('tomog') || text.includes('resonan') || text.includes('imagen') || text.includes('rx ')) return 'imaging';
  if (text.includes('receta') || text.includes('prescri')) return 'prescription';
  if (text.includes('epicrisis') || text.includes('alta') || text.includes('discharge')) return 'discharge';
  if (text.includes('anatomía patológ') || text.includes('biopsia') || text.includes('citolog')) return 'pathology';
  if (text.includes('vacun') || text.includes('inmuniz')) return 'vaccination';
  return 'other';
}

export function parseFeedbackPayload(rawMessage = '', { minLength = 10 } = {}) {
  const normalizedMessage = String(rawMessage || '').replace(/\s+/g, ' ').trim();
  if (!normalizedMessage) return { ok: false, error: 'empty_feedback_payload' };
  if (normalizedMessage.length < Math.max(1, Number(minLength) || 1)) {
    return { ok: false, error: 'feedback_too_short' };
  }
  return { ok: true, messageText: normalizedMessage };
}
