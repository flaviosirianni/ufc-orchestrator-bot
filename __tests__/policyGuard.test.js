import assert from 'node:assert/strict';
import { enforcePolicyPack } from '../src/platform/policy/policyGuard.js';

export async function runPolicyGuardTests() {
  const tests = [];

  tests.push(async () => {
    const out = enforcePolicyPack({
      text: 'Te recomiendo hidratarte y ajustar calorias gradualmente.',
      policyPackId: 'nutrition_guidance_non_clinical',
    });
    assert.equal(out, 'Te recomiendo hidratarte y ajustar calorias gradualmente.');
  });

  tests.push(async () => {
    const out = enforcePolicyPack({
      text: 'Te diagnostico con una lesion y te doy receta medica.',
      policyPackId: 'medical_non_diagnostic',
    });
    assert.match(out, /no reemplaza consulta m[eé]dica/i);
    assert.match(out, /diagn[oó]stico/i);
  });

  tests.push(async () => {
    const out = enforcePolicyPack({
      text: 'Esta guia es educativa. ⚠️ Esta guía es educativa y no reemplaza evaluación clínica personalizada por profesional matriculado.',
      policyPackId: 'nutrition_guidance_non_clinical',
    });
    const count = (out.match(/no reemplaza evaluación clínica/gi) || []).length;
    assert.equal(count, 1);
  });

  for (const test of tests) {
    await test();
  }

  console.log('All policyGuard tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPolicyGuardTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
