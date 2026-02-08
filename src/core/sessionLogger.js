import {
  upsertUser,
  upsertChat,
  upsertSession,
  appendMessage,
} from './sqliteStore.js';

function buildSessionId(chatId, userId) {
  if (!chatId) return null;
  if (userId) {
    return `${chatId}:${userId}`;
  }
  return chatId;
}

function sanitizeMessage(content = '') {
  const text = String(content || '').trim();
  return text.length ? text : null;
}

export function createSessionLogger() {
  async function logInteraction({
    chatId,
    userId,
    userInfo = {},
    chatInfo = {},
    sessionState = null,
    userMessage = '',
    assistantMessage = '',
  } = {}) {
    if (!chatId) {
      return;
    }

    const sessionId = buildSessionId(chatId, userId);
    if (!sessionId) {
      return;
    }

    upsertUser({
      userId,
      username: userInfo?.username,
      firstName: userInfo?.firstName,
      lastName: userInfo?.lastName,
    });

    upsertChat({
      chatId,
      type: chatInfo?.type,
      title: chatInfo?.title,
    });

    if (sessionState) {
      upsertSession({
        sessionId,
        chatId,
        userId,
        messageCount: sessionState.turns?.length ?? 0,
        lastEvent: sessionState.lastEvent,
        lastCard: sessionState.lastCardFights?.length
          ? {
              eventName: sessionState.lastEvent?.eventName || null,
              date: sessionState.lastEvent?.date || null,
              fights: sessionState.lastCardFights,
            }
          : null,
        lastResolvedFight: sessionState.lastResolvedFight,
      });
    } else {
      upsertSession({
        sessionId,
        chatId,
        userId,
        messageCount: 0,
      });
    }

    const cleanUserMessage = sanitizeMessage(userMessage);
    const cleanAssistantMessage = sanitizeMessage(assistantMessage);

    if (cleanUserMessage) {
      appendMessage({
        sessionId,
        role: 'user',
        content: cleanUserMessage,
      });
    }

    if (cleanAssistantMessage) {
      appendMessage({
        sessionId,
        role: 'assistant',
        content: cleanAssistantMessage,
      });
    }
  }

  return { logInteraction };
}

export default { createSessionLogger };
