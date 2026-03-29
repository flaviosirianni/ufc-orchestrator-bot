import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadBotManifestFromFile, validateBotManifest } from '../src/platform/manifest.js';

export async function runManifestTests() {
  const tests = [];

  tests.push(async () => {
    const manifest = validateBotManifest({
      bot_id: 'nutrition',
      domain_pack: {},
      credit_policy: {},
      storage: {},
    });

    assert.equal(manifest.bot_id, 'nutrition');
    assert.equal(manifest.display_name, 'nutrition');
    assert.equal(manifest.interaction_mode, 'guided_strict');
    assert.equal(manifest.telegram_token_env, 'TELEGRAM_BOT_TOKEN');
    assert.equal(manifest.risk_policy, 'general_safe_advice');
    assert.match(manifest.storage.db_path, /nutrition\/bot\.db$/);
  });

  tests.push(async () => {
    const manifest = validateBotManifest({
      bot_id: 'ufc',
      interaction_mode: 'hybrid',
      domain_pack: { prompt_file: 'x.md' },
      credit_policy: { costs: { analysis: 1 } },
      risk_policy: 'medical_non_diagnostic',
      storage: { db_path: '/tmp/ufc.db' },
    });

    assert.equal(manifest.interaction_mode, 'hybrid');
    assert.equal(manifest.domain_pack.prompt_file, 'x.md');
    assert.equal(manifest.risk_policy, 'medical_non_diagnostic');
    assert.equal(manifest.storage.db_path, '/tmp/ufc.db');
  });

  tests.push(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
    const manifestPath = path.join(dir, 'bot.manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          bot_id: 'medical_reader',
          domain_pack: { prompt_file: 'src/bots/medical_reader/prompt.md' },
          credit_policy: { costs: { analysis: 1 } },
          storage: { db_path: '/tmp/medical.db' },
        },
        null,
        2
      )
    );

    const loaded = loadBotManifestFromFile(manifestPath);
    assert.equal(loaded.bot_id, 'medical_reader');
    assert.equal(loaded.storage.db_path, '/tmp/medical.db');
  });

  tests.push(async () => {
    assert.throws(
      () =>
        validateBotManifest({
          domain_pack: {},
          credit_policy: {},
          storage: {},
        }),
      /falta bot_id/i
    );
  });

  for (const test of tests) {
    await test();
  }

  console.log('All manifest tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runManifestTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
