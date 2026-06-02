import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function runRuntimeHealthTelemetryTests() {
  const ovidiusRuntime = fs.readFileSync('src/bots/ovidius_medibot/runtime.js', 'utf8');
  const healthStart = ovidiusRuntime.indexOf('const healthServer = createHealthServer');
  assert.ok(healthStart >= 0, 'ovidius runtime debe crear health server');
  const healthBlock = ovidiusRuntime.slice(healthStart, healthStart + 900);
  assert.match(healthBlock, /statusProvider\s*:/);
  assert.match(healthBlock, /getRuntimeStatus/);

  console.log('All runtime health telemetry tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRuntimeHealthTelemetryTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
