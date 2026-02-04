import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';

const routerPrompt = PromptTemplate.fromTemplate(`
  You are the UFC Orchestrator.
  Your job is to decide which agent should handle the user's request.
  Available agents:
  - "bettingWizard": Handles fight analysis and betting strategies.
  - "sheetOps": Handles reading/writing UFC fight data in Google Sheets.
  - "fightsScalper": Fetches new fight data after events.

  User message: {input}

  Respond with only one of: bettingWizard, sheetOps, fightsScalper.
`);

function classifyWithRules(message = '') {
  const text = String(message || '').toLowerCase();
  const hasDateHint =
    /\b(\d{1,2}[\/-]\d{1,2}|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\s+de\s+[a-zñ]+)\b/.test(
      text
    );

  if (!text.trim()) {
    return null;
  }

  // Deterministic routing for common intents; avoids misroutes from LLM.
  if (
    /\b(write|append|update|set|sheet|google sheets|leer|read|escrib|agrega|agregar)\b/.test(
      text
    )
  ) {
    return 'sheetops';
  }

  if (/\b(historial|fight history|record|records|vs|versus|\bv\b)\b/.test(text)) {
    return 'fightsscalper';
  }

  if (
    /\b(main card|main event|evento|analiz|predic|pronost|quien gana|opina|estrategia|apuesta)\b/.test(
      text
    )
  ) {
    return 'bettingwizard';
  }

  if (hasDateHint && /\b(main|cartelera|evento|quien pelea)\b/.test(text)) {
    return 'bettingwizard';
  }

  return null;
}

export function createRouterChain({
  sheetOps,
  fightsScalper,
  bettingWizard,
  chain: providedChain,
} = {}) {
  const chain =
    providedChain ??
    routerPrompt.pipe(
      new ChatOpenAI({
        model: 'gpt-4o-mini',
        temperature: 0.4,
      })
    );

  async function routeMessage(message = '') {
    console.log('[routerChain] Incoming message:', message);
    console.log('[routerChain] Agent availability snapshot:', {
      bettingWizardType: bettingWizard && typeof bettingWizard,
      bettingWizardHasHandler: typeof bettingWizard?.handleMessage === 'function',
      sheetOpsHasHandler: typeof sheetOps?.handleMessage === 'function',
      fightsScalperHasHandler: typeof fightsScalper?.handleMessage === 'function',
    });

    let target = classifyWithRules(message) || 'unknown';

    if (target === 'unknown') {
      try {
        const response = await chain.invoke({ input: message });
        target = response.content?.trim().toLowerCase() || 'unknown';
      } catch (error) {
        console.error('❌ Router failed to invoke the language model.', error);
        return 'No pude decidir qué agente usar por un error interno.';
      }
    }

    console.log(`🤖 Router decided: ${target}`);

    try {
      switch (target) {
        case 'bettingwizard':
          if (!bettingWizard?.handleMessage) {
            console.error('❌ Betting Wizard agent missing or invalid.', bettingWizard);
            return 'Betting Wizard agent is unavailable.';
          }
          return await bettingWizard.handleMessage(message);
        case 'sheetops':
          if (!sheetOps?.handleMessage) {
            console.error('❌ SheetOps agent missing or invalid.', sheetOps);
            return 'Sheet Ops agent is unavailable.';
          }
          return await sheetOps.handleMessage(message);
        case 'fightsscalper':
          if (!fightsScalper?.handleMessage) {
            console.error('❌ FightsScalper agent missing or invalid.', fightsScalper);
            return 'Fights Scalper agent is unavailable.';
          }
          return await fightsScalper.handleMessage(message);
        default:
          console.warn('⚠️ Router could not determine target agent.');
          return "I'm not sure which agent to use for that.";
      }
    } catch (error) {
      console.error(`❌ Agent "${target}" threw an error.`, error);
      return 'El agente seleccionado falló al procesar tu solicitud.';
    }
  }

  return { routeMessage };
}
