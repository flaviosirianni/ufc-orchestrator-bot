import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';

const routerPrompt = PromptTemplate.fromTemplate(`
  You are the UFC Orchestrator.
  Your job is to decide which agent should handle the user's request.
  Available agents:
  - "bettingWizard": Handles fight analysis and betting strategies.
  - "sheetOps": Handles reading/writing UFC fight data in Google Sheets.
  - "fightsScalper": Handles explicit requests for raw historical rows.

  User message: {input}

  Respond with only one of: bettingWizard, sheetOps, fightsScalper.
`);

const ENABLE_LLM_ROUTER = process.env.ENABLE_LLM_ROUTER === 'true';

function parseRouteInput(input) {
  if (typeof input === 'string') {
    return {
      chatId: 'default',
      message: input,
      metadata: {},
    };
  }

  if (input && typeof input === 'object') {
    return {
      chatId: String(input.chatId ?? 'default'),
      message: String(input.message ?? ''),
      metadata: input,
    };
  }

  return {
    chatId: 'default',
    message: '',
    metadata: {},
  };
}

function classifyIntent(message = '') {
  const text = String(message || '').toLowerCase();

  if (!text.trim()) {
    return 'bettingwizard';
  }

  const isSheetCommand =
    /\b(write|append|update|set|sheet|google sheets|leer|read|escrib|agrega|agregar)\b/.test(
      text
    );
  if (isSheetCommand) {
    return 'sheetops';
  }

  const asksForRawHistory =
    /\b(historial|history|record|records|filas|rows|tabla|raw data|mostrar historial)\b/.test(
      text
    );
  const asksForAnalysis =
    /\b(main|main card|evento|pelea|analiz|opina|quien|gana|pick|predic|pronost|estrateg|apuesta|vs|versus)\b/.test(
      text
    );

  if (asksForRawHistory && !asksForAnalysis) {
    return 'fightsscalper';
  }

  return 'bettingwizard';
}

function normaliseTarget(target = '') {
  const value = String(target || '').trim().toLowerCase();
  if (value === 'sheetops' || value === 'fightscalper' || value === 'bettingwizard') {
    return value;
  }
  if (value === 'fightsscalper') {
    return 'fightscalper';
  }
  return 'bettingwizard';
}

function unpackAgentResult(result) {
  if (typeof result === 'string') {
    return { text: result, metadata: {} };
  }

  if (result && typeof result === 'object') {
    if (typeof result.reply === 'string') {
      return {
        text: result.reply,
        metadata: result.metadata || {},
      };
    }
    if (typeof result.text === 'string') {
      return {
        text: result.text,
        metadata: result.metadata || {},
      };
    }
  }

  return {
    text: String(result ?? ''),
    metadata: {},
  };
}

export function createRouterChain({
  sheetOps,
  fightsScalper,
  bettingWizard,
  conversationStore,
  chain: providedChain,
} = {}) {
  const chain =
    providedChain ??
    routerPrompt.pipe(
      new ChatOpenAI({
        model: 'gpt-4o-mini',
        temperature: 0.2,
      })
    );

  async function routeMessage(input = '') {
    const { chatId, message, metadata } = parseRouteInput(input);
    const originalMessage = String(message || '');

    console.log('[routerChain] Incoming message:', originalMessage);
    console.log('[routerChain] Agent availability snapshot:', {
      bettingWizardType: bettingWizard && typeof bettingWizard,
      bettingWizardHasHandler: typeof bettingWizard?.handleMessage === 'function',
      sheetOpsHasHandler: typeof sheetOps?.handleMessage === 'function',
      fightsScalperHasHandler: typeof fightsScalper?.handleMessage === 'function',
      chatId,
    });

    const resolution = conversationStore?.resolveMessage
      ? conversationStore.resolveMessage(chatId, originalMessage)
      : {
          originalMessage,
          resolvedMessage: originalMessage,
          resolvedFight: null,
          source: null,
        };
    const messageForAgent = resolution?.resolvedMessage || originalMessage;

    let target = normaliseTarget(classifyIntent(originalMessage));

    if (ENABLE_LLM_ROUTER) {
      try {
        const response = await chain.invoke({ input: originalMessage });
        target = normaliseTarget(response.content);
      } catch (error) {
        console.error('❌ Router failed to invoke the language model.', error);
      }
    }

    console.log(`🤖 Router decided: ${target}`);

    let rawResult = null;

    try {
      switch (target) {
        case 'bettingwizard':
          if (!bettingWizard?.handleMessage) {
            console.error('❌ Betting Wizard agent missing or invalid.', bettingWizard);
            rawResult = 'Betting Wizard agent is unavailable.';
            break;
          }
          rawResult = await bettingWizard.handleMessage(messageForAgent, {
            chatId,
            originalMessage,
            resolution,
            metadata,
          });
          break;
        case 'sheetops':
          if (!sheetOps?.handleMessage) {
            console.error('❌ SheetOps agent missing or invalid.', sheetOps);
            rawResult = 'Sheet Ops agent is unavailable.';
            break;
          }
          rawResult = await sheetOps.handleMessage(originalMessage, {
            chatId,
            metadata,
          });
          break;
        case 'fightscalper':
          if (!fightsScalper?.handleMessage) {
            console.error('❌ FightsScalper agent missing or invalid.', fightsScalper);
            rawResult = 'Fights Scalper agent is unavailable.';
            break;
          }
          rawResult = await fightsScalper.handleMessage(originalMessage, {
            chatId,
            metadata,
          });
          break;
        default:
          rawResult = "I'm not sure which agent to use for that.";
      }
    } catch (error) {
      console.error(`❌ Agent "${target}" threw an error.`, error);
      rawResult = 'El agente seleccionado falló al procesar tu solicitud.';
    }

    const { text, metadata: agentMetadata } = unpackAgentResult(rawResult);

    if (conversationStore?.appendTurn) {
      conversationStore.appendTurn(chatId, 'user', originalMessage);
      conversationStore.appendTurn(chatId, 'assistant', text);
    }

    if (conversationStore?.setLastResolvedFight && agentMetadata?.resolvedFight) {
      conversationStore.setLastResolvedFight(chatId, agentMetadata.resolvedFight);
    }

    if (conversationStore?.setLastCard && agentMetadata?.webContext?.fights?.length) {
      conversationStore.setLastCard(chatId, {
        eventName: agentMetadata.webContext.eventName,
        date: agentMetadata.webContext.date,
        fights: agentMetadata.webContext.fights,
      });
    }

    return text;
  }

  return { routeMessage };
}

export default { createRouterChain };
