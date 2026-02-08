const DIRECT_SHEET_KEYWORDS = /\b(sheet|google sheets|read|leer|write|append|update|set|escrib|agrega|agregar|anadir|añadir)\b/i;
const RANGE_PATTERN = /\b(?:[A-Za-z0-9_]+![A-Z]+(?:\d+)?(?::[A-Z]+(?:\d+)?)?|[A-Z]+\d+:[A-Z]+\d+|[A-Z]+:[A-Z]+)\b/;
const RAW_HISTORY_KEYWORDS = /\b(historial|history|filas|rows|tabla|raw data|cache|sync|refresh)\b/i;
const ANALYSIS_KEYWORDS = /\b(analiz|opina|pick|gana|quien|evento|main card|predic|estrateg|apuesta|vs|versus)\b/i;

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
  const text = String(message || '').trim();
  if (!text) {
    return 'bettingwizard';
  }

  const looksLikeSheetCommand =
    DIRECT_SHEET_KEYWORDS.test(text) && RANGE_PATTERN.test(text);
  if (looksLikeSheetCommand) {
    return 'sheetops';
  }

  const asksForRawHistory = RAW_HISTORY_KEYWORDS.test(text);
  const asksForAnalysis = ANALYSIS_KEYWORDS.test(text);

  if (asksForRawHistory && !asksForAnalysis) {
    return 'fightsscalper';
  }

  if (/^\/(historial|history|cache|sync)\b/i.test(text)) {
    return 'fightsscalper';
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

function defaultResolution(message) {
  return {
    originalMessage: message,
    resolvedMessage: message,
    resolvedFight: null,
    source: null,
  };
}

export function createRouterChain({
  sheetOps,
  fightsScalper,
  bettingWizard,
  conversationStore,
  sessionLogger,
} = {}) {
  async function routeMessage(input = '') {
    const { chatId, message, metadata } = parseRouteInput(input);
    const originalMessage = String(message || '');
    const userIdRaw = metadata?.user?.id;
    const userId = userIdRaw ? String(userIdRaw) : null;
    const sessionId = userId ? `${chatId}:${userId}` : chatId;
    const userInfo = metadata?.user || {};
    const chatInfo = metadata?.chat || {};

    console.log('[routerChain] Incoming message:', originalMessage);
    console.log('[routerChain] Agent availability snapshot:', {
      bettingWizardType: bettingWizard && typeof bettingWizard,
      bettingWizardHasHandler: typeof bettingWizard?.handleMessage === 'function',
      sheetOpsHasHandler: typeof sheetOps?.handleMessage === 'function',
      fightsScalperHasHandler: typeof fightsScalper?.handleMessage === 'function',
      chatId: sessionId,
    });

    const resolution = conversationStore?.resolveMessage
      ? conversationStore.resolveMessage(sessionId, originalMessage)
      : defaultResolution(originalMessage);
    const messageForAgent = resolution?.resolvedMessage || originalMessage;

    const target = classifyIntent(originalMessage);
    console.log(`🤖 Router decided: ${target}`);

    let rawResult = null;

    try {
      switch (target) {
        case 'sheetops':
          if (!sheetOps?.handleMessage) {
            rawResult = 'Sheet Ops agent is unavailable.';
            break;
          }
          rawResult = await sheetOps.handleMessage(originalMessage, {
            chatId,
            metadata,
          });
          break;
        case 'fightsscalper':
          if (!fightsScalper?.handleMessage) {
            rawResult = 'Fights Scalper agent is unavailable.';
            break;
          }
          rawResult = await fightsScalper.handleMessage(originalMessage, {
            chatId,
            metadata,
          });
          break;
        case 'bettingwizard':
        default:
          if (!bettingWizard?.handleMessage) {
            rawResult = 'Betting Wizard agent is unavailable.';
            break;
          }
          rawResult = await bettingWizard.handleMessage(messageForAgent, {
            chatId: sessionId,
            originalMessage,
            resolution,
            metadata,
            inputItems: metadata?.inputItems,
            userId,
            userInfo,
            chatInfo,
            originalChatId: chatId,
          });
          break;
      }
    } catch (error) {
      console.error(`❌ Agent "${target}" threw an error.`, error);
      rawResult = 'El agente seleccionado falló al procesar tu solicitud.';
    }

    const { text, metadata: agentMetadata } = unpackAgentResult(rawResult);

    if (conversationStore?.appendTurn) {
      conversationStore.appendTurn(sessionId, 'user', originalMessage);
      conversationStore.appendTurn(sessionId, 'assistant', text);
    }

    if (conversationStore?.setLastResolvedFight && agentMetadata?.resolvedFight) {
      conversationStore.setLastResolvedFight(sessionId, agentMetadata.resolvedFight);
    }

    if (conversationStore?.setLastCard && agentMetadata?.eventCard?.fights?.length) {
      conversationStore.setLastCard(sessionId, {
        eventName: agentMetadata.eventCard.eventName,
        date: agentMetadata.eventCard.date,
        fights: agentMetadata.eventCard.fights,
      });
    }

    if (sessionLogger?.logInteraction) {
      const sessionState = conversationStore?.getSession
        ? conversationStore.getSession(sessionId)
        : null;
      await sessionLogger.logInteraction({
        chatId,
        userId,
        userInfo,
        chatInfo,
        sessionState,
        userMessage: originalMessage,
        assistantMessage: text,
      });
    }

    return text;
  }

  return { routeMessage };
}

export default { createRouterChain };
