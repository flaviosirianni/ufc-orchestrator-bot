import '../core/env.js';

const DEFAULT_TTL_MS = Number(process.env.CONVERSATION_TTL_MS ?? '86400000');
const DEFAULT_MAX_TURNS = Number(process.env.CONVERSATION_MAX_TURNS ?? '20');
const DEFAULT_MAX_TURN_CHARS = Number(process.env.CONVERSATION_MAX_TURN_CHARS ?? '1600');

const ORDINAL_TO_INDEX = {
  primera: 1,
  primer: 1,
  segunda: 2,
  tercero: 3,
  tercera: 3,
  cuarta: 4,
  cuarto: 4,
  quinta: 5,
  quinto: 5,
};

function nowMs() {
  return Date.now();
}

function createSession(chatId, ttlMs) {
  const now = nowMs();
  return {
    chatId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMs,
    turns: [],
    lastCardFights: [],
    lastEvent: null,
    lastResolvedFight: null,
    userProfile: {
      bankroll: null,
      unitSize: null,
      riskProfile: null,
      currency: null,
      notes: '',
    },
    betHistory: [],
    ledgerSummary: null,
  };
}

function trimTurns(turns, maxTurns) {
  if (turns.length <= maxTurns) {
    return turns;
  }
  return turns.slice(turns.length - maxTurns);
}

function extractFightIndex(message = '') {
  const text = String(message || '').toLowerCase();

  const numericMatch = text.match(
    /\b(?:pelea|fight|combate)\s*(?:n[uú]mero|num|#)?\s*(\d{1,2})\b/
  );
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const ordinalMatch = text.match(
    /\b(?:pelea|fight|combate)?\s*(primera|primer|segunda|tercera|cuarta|quinta)\b/
  );
  if (ordinalMatch) {
    return ORDINAL_TO_INDEX[ordinalMatch[1]] ?? null;
  }

  return null;
}

function refersToPreviousFight(message = '') {
  const text = String(message || '').toLowerCase();
  return /\b(esa pelea|ese combate|esa lucha|esa)\b/.test(text);
}

function formatFight(fight) {
  if (!fight?.fighterA || !fight?.fighterB) {
    return null;
  }
  return `${fight.fighterA} vs ${fight.fighterB}`;
}

export class ConversationStore {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTurnChars = DEFAULT_MAX_TURN_CHARS,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxTurns = maxTurns;
    this.maxTurnChars = maxTurnChars;
    this.sessions = new Map();
  }

  cleanupExpired() {
    const now = nowMs();
    for (const [chatId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(chatId);
      }
    }
  }

  getSession(chatId = 'default') {
    this.cleanupExpired();

    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.updatedAt = nowMs();
      existing.expiresAt = existing.updatedAt + this.ttlMs;
      return existing;
    }

    const session = createSession(chatId, this.ttlMs);
    this.sessions.set(chatId, session);
    return session;
  }

  patch(chatId, partial) {
    const session = this.getSession(chatId);
    Object.assign(session, partial);
    session.updatedAt = nowMs();
    session.expiresAt = session.updatedAt + this.ttlMs;
    return session;
  }

  appendTurn(chatId, role, content) {
    if (!content) {
      return;
    }

    const session = this.getSession(chatId);
    const normalizedContent = String(content).slice(0, this.maxTurnChars);
    session.turns.push({
      role,
      content: normalizedContent,
      at: nowMs(),
    });
    session.turns = trimTurns(session.turns, this.maxTurns);
    session.updatedAt = nowMs();
    session.expiresAt = session.updatedAt + this.ttlMs;
  }

  getRecentTurns(chatId, limit = 8) {
    const session = this.getSession(chatId);
    if (limit <= 0) {
      return [];
    }
    return session.turns.slice(Math.max(0, session.turns.length - limit));
  }

  setLastCard(chatId, {
    eventName = null,
    date = null,
    fights = [],
  } = {}) {
    const session = this.getSession(chatId);
    session.lastEvent = {
      eventName,
      date,
      updatedAt: nowMs(),
    };
    session.lastCardFights = Array.isArray(fights) ? fights.slice(0, 12) : [];
    if (session.lastCardFights.length) {
      session.lastResolvedFight = session.lastCardFights[0];
    }
    session.updatedAt = nowMs();
    session.expiresAt = session.updatedAt + this.ttlMs;
  }

  setLastResolvedFight(chatId, fight) {
    if (!fight?.fighterA || !fight?.fighterB) {
      return;
    }
    this.patch(chatId, { lastResolvedFight: fight });
  }

  getUserProfile(chatId) {
    const session = this.getSession(chatId);
    return {
      ...session.userProfile,
    };
  }

  updateUserProfile(chatId, updates = {}) {
    const session = this.getSession(chatId);
    session.userProfile = {
      ...session.userProfile,
      ...updates,
    };
    session.updatedAt = nowMs();
    session.expiresAt = session.updatedAt + this.ttlMs;
    return session.userProfile;
  }

  addBetRecord(chatId, record = {}) {
    const session = this.getSession(chatId);
    session.betHistory.push({
      ...record,
      recordedAt: nowMs(),
    });
    session.betHistory = trimTurns(session.betHistory, 50);
    session.updatedAt = nowMs();
    session.expiresAt = session.updatedAt + this.ttlMs;
    return session.betHistory[session.betHistory.length - 1];
  }

  getBetHistory(chatId, limit = 20) {
    const session = this.getSession(chatId);
    if (limit <= 0) {
      return [];
    }
    return session.betHistory.slice(Math.max(0, session.betHistory.length - limit));
  }

  resolveMessage(chatId, message = '') {
    const session = this.getSession(chatId);
    const originalMessage = String(message || '');
    const trimmed = originalMessage.trim();

    if (!trimmed) {
      return {
        originalMessage,
        resolvedMessage: originalMessage,
        resolvedFight: null,
        source: null,
      };
    }

    const index = extractFightIndex(trimmed);
    let resolvedFight = null;
    let source = null;

    if (index && session.lastCardFights[index - 1]) {
      resolvedFight = session.lastCardFights[index - 1];
      source = `fight-index-${index}`;
    } else if (refersToPreviousFight(trimmed) && session.lastResolvedFight) {
      resolvedFight = session.lastResolvedFight;
      source = 'last-resolved-fight';
    }

    if (!resolvedFight) {
      return {
        originalMessage,
        resolvedMessage: originalMessage,
        resolvedFight: null,
        source: null,
      };
    }

    const formattedFight = formatFight(resolvedFight);
    const resolvedMessage = [
      originalMessage,
      '',
      '[CONVERSATION_CONTEXT]',
      `La referencia de pelea en este mensaje corresponde a: ${formattedFight}.`,
    ].join('\n');

    this.setLastResolvedFight(chatId, resolvedFight);

    return {
      originalMessage,
      resolvedMessage,
      resolvedFight,
      source,
    };
  }
}

export function createConversationStore(options) {
  return new ConversationStore(options);
}

export default createConversationStore;
