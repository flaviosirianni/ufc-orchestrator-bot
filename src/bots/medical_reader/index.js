import { bootstrapScaffoldedBot } from '../../platform/runtime/scaffoldedBotRuntime.js';

export async function bootstrapBot({ manifest } = {}) {
  return bootstrapScaffoldedBot({
    manifest,
    templateId: 'document_reader',
  });
}
