const DIAGNOSIS_TERMS = [
  'diagnostico',
  'diagnóstico',
  'te diagnostico',
  'te diagnostico con',
  'te diagnostico de',
  'diagnosis',
  'prescripcion',
  'prescripción',
  'receta medica',
  'receta médica',
  'suspende tu medicacion',
  'suspende tu medicación',
  'debes tomar este medicamento',
];

const CLINICAL_NUTRITION_TERMS = [
  'plan clinico',
  'plan clínico',
  'tratamiento nutricional',
  'prescripcion dietetica',
  'prescripción dietética',
  'prescribo',
];

export const POLICY_PACKS = Object.freeze({
  medical_guidance_companion: {
    id: 'medical_guidance_companion',
    description:
      'Asistente médico de acompañamiento. Siempre agrega aviso de no-reemplazo al final de la respuesta.',
    alwaysAppendNotice: true,
    escalationNotice:
      '---\n_Este asistente no reemplaza la consulta médica profesional. Ante cualquier urgencia o duda importante, consultá a tu médico._',
  },
  general_safe_advice: {
    id: 'general_safe_advice',
    description: 'Consejos generales sin afirmaciones medicas o legales absolutas.',
  },
  medical_non_diagnostic: {
    id: 'medical_non_diagnostic',
    description:
      'No diagnosticar ni prescribir. Debe escalar a consulta con profesional de salud.',
    restrictedTerms: DIAGNOSIS_TERMS,
    escalationNotice:
      '⚠️ Esto es orientativo y no reemplaza consulta médica. Para diagnóstico/tratamiento, consultá a un profesional de salud.',
  },
  nutrition_guidance_non_clinical: {
    id: 'nutrition_guidance_non_clinical',
    description:
      'Guias de nutricion no clinica sin prescripcion medica ni dietoterapia clinica.',
    restrictedTerms: CLINICAL_NUTRITION_TERMS,
    escalationNotice:
      '⚠️ Esta guía es educativa y no reemplaza evaluación clínica personalizada por profesional matriculado.',
  },
});

export function getPolicyPack(policyId = '') {
  const key = String(policyId || '').trim();
  return POLICY_PACKS[key] || POLICY_PACKS.general_safe_advice;
}
