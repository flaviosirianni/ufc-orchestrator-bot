import assert from 'node:assert/strict';
import { toTelegramHtml, toTelegramPlainText } from '../src/core/messageFormatter.js';

export async function runMessageFormatterTests() {
  const tests = [];

  tests.push(async () => {
    const input = '**Receipt**\n- **bet_id:** 31\n- **Pick:** Under 2.5 @1.64';
    const html = toTelegramHtml(input);
    assert.match(html, /<b>Receipt<\/b>/);
    assert.match(html, /• <b>bet_id:<\/b> 31/);
    assert.match(html, /• <b>Pick:<\/b> Under 2.5 @1.64/);
  });

  tests.push(async () => {
    const input = '## Seccion\nTexto con `bet_id` y **negrita**';
    const plain = toTelegramPlainText(input);
    assert.doesNotMatch(plain, /##/);
    assert.doesNotMatch(plain, /\*\*/);
    assert.match(plain, /Seccion/);
    assert.match(plain, /bet_id/);
  });

  tests.push(async () => {
    const input = '```json\n{"ok":true}\n```';
    const html = toTelegramHtml(input);
    assert.match(html, /<pre>\{"ok":true\}<\/pre>/);
  });

  for (const test of tests) {
    await test();
  }

  console.log('All messageFormatter tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMessageFormatterTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
