import './env.js';

export const ROUTES = {
  UPDATE: 'update',
  ANALYZE: 'analyze',
  BET: 'bet',
  HELP: 'help',
  UNKNOWN: 'unknown',
};

export function determineIntent(message = '') {
  const text = message.toLowerCase();

  if (/(update|refresh|sync)/.test(text)) {
    return ROUTES.UPDATE;
  }

  if (/(analy[sz]e|analysis|insight|preview)/.test(text)) {
    return ROUTES.ANALYZE;
  }

  if (/(bet|wager|parlay|pick)/.test(text)) {
    return ROUTES.BET;
  }

  if (/(help|what can you do|usage)/.test(text)) {
    return ROUTES.HELP;
  }

  return ROUTES.UNKNOWN;
}

function defaultHelpMessage() {
  return [
    '👋 Welcome to the UFC Orchestrator Bot!',
    '• Send "update" to refresh the Google Sheet with the latest fight card.',
    '• Send "analyze" followed by a question for scouting reports.',
    '• Ask for "bet" ideas to receive a high-level betting angle.',
  ].join('\n');
}

export function createRouterChain({
  sheetOps,
  fightsScalper,
  bettingWizard,
} = {}) {
  const sheetId = process.env.SHEET_ID;

  async function routeMessage(message = '') {
    const intent = determineIntent(message);

    switch (intent) {
      case ROUTES.UPDATE:
        if (!fightsScalper?.fetchAndStoreUpcomingFights) {
          return 'Update route is not available because the fights scalper tool is missing.';
        }
        return fightsScalper.fetchAndStoreUpcomingFights({
          sheetId,
        });
      case ROUTES.ANALYZE:
      case ROUTES.BET:
        if (!bettingWizard?.generateBettingStrategy) {
          return 'Betting Wizard is not configured yet. Please check the server logs.';
        }
        return bettingWizard.generateBettingStrategy({
          message,
          sheetId,
          range: 'Fights!A:E',
        });
      case ROUTES.HELP:
        return defaultHelpMessage();
      case ROUTES.UNKNOWN:
      default:
        return [
          "I wasn't sure what you needed.",
          'Try commands like "update fights", "analyze the main event", or "bet ideas".',
        ].join(' ');
    }
  }

  return {
    routeMessage,
    determineIntent,
    sheetOps,
  };
}

export default {
  createRouterChain,
  determineIntent,
  ROUTES,
};
