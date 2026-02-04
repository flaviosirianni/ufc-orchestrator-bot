import assert from 'node:assert/strict';
import { handleMessage as handleSheetMessage } from '../src/tools/sheetOpsTool.js';
import {
  handleMessage as handleFightsMessage,
  extractFighterNamesFromMessage,
} from '../src/tools/fightsScalperTool.js';

export async function runToolsHandlersTests() {
  const tests = [];

  tests.push(async () => {
    const response = await handleSheetMessage('leer Fights!A1:B2', {
      sheetId: 'sheet-test',
      readRangeImpl: async (sheetId, range) => {
        assert.equal(sheetId, 'sheet-test');
        assert.equal(range, 'Fights!A1:B2');
        return [
          ['Name', 'Odds'],
          ['Pereira', '1.80'],
        ];
      },
    });

    assert.match(response, /Leí 2 fila\(s\) de Fights!A1:B2/);
    assert.match(response, /Pereira \| 1\.80/);
  });

  tests.push(async () => {
    let captured;
    const response = await handleSheetMessage(
      'append Fights!A:B :: Alex Pereira,1.75;Magomed Ankalaev,2.15',
      {
        sheetId: 'sheet-test',
        writeRangeImpl: async (sheetId, range, values, opts) => {
          captured = { sheetId, range, values, opts };
        },
      }
    );

    assert.equal(captured.sheetId, 'sheet-test');
    assert.equal(captured.range, 'Fights!A:B');
    assert.deepEqual(captured.values, [
      ['Alex Pereira', '1.75'],
      ['Magomed Ankalaev', '2.15'],
    ]);
    assert.equal(captured.opts.append, true);
    assert.match(response, /Agregué 2 fila\(s\)/);
  });

  tests.push(async () => {
    const names = extractFighterNamesFromMessage('Hola amiguito, como estas?');
    assert.deepEqual(names, []);
  });

  tests.push(async () => {
    const names = extractFighterNamesFromMessage(
      'me gustaria saber que opinas de la pelea de bautista vs oliveira'
    );

    assert.deepEqual(names, ['Bautista', 'Oliveira']);
  });

  tests.push(async () => {
    const response = await handleFightsMessage('historial de Pereira vs Ankalaev', {
      sheetId: 'sheet-test',
      getFighterHistoryImpl: async ({ sheetId, message }) => {
        assert.equal(sheetId, 'sheet-test');
        assert.match(message, /Pereira vs Ankalaev/);
        return {
          fighters: ['Alex Pereira', 'Magomed Ankalaev'],
          rows: [
            ['Alex Pereira', 'Win', 'KO', 'Round 2'],
            ['Magomed Ankalaev', 'Win', 'Decision', 'Round 3'],
          ],
        };
      },
    });

    assert.match(response, /Encontré 2 fila\(s\)/);
    assert.match(response, /Alex Pereira \| Win \| KO \| Round 2/);
  });

  tests.push(async () => {
    const response = await handleFightsMessage('actualizar cartelera', {
      sheetId: 'sheet-test',
      syncFightHistoryCacheImpl: async ({ sheetId, range }) => {
        assert.equal(sheetId, 'sheet-test');
        assert.equal(range, 'Fight History!A:Z');
        return { rowCount: 128, updated: true };
      },
    });

    assert.match(response, /Sync de Fight History completado/);
    assert.match(response, /Cache actualizado/);
  });

  tests.push(async () => {
    const response = await handleFightsMessage('actualizar upcoming fights', {
      sheetId: 'sheet-test',
      fetchAndStoreUpcomingFightsImpl: async () => 'refresh ok',
    });

    assert.equal(response, 'refresh ok');
  });

  for (const test of tests) {
    await test();
  }

  console.log('All tools handlers tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runToolsHandlersTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
