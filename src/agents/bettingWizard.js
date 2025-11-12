import '../core/env.js';
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { HumanMessage, SystemMessage } from 'langchain/schema';
import { readRange } from '../tools/sheetOpsTool.js';

const DEFAULT_MODEL = 'gpt-3.5-turbo-0125';

function formatFightsTable(rows) {
  if (!rows || !rows.length) {
    return 'No fight data was found in the sheet.';
  }

  const header = ['Date', 'Event', 'Fighter A', 'Fighter B', 'Odds'];
  const tableRows = rows
    .map((row) => row.map((value) => (value ? String(value) : '')))
    .map((row, index) => `${index + 1}. ${row.join(' | ')}`)
    .join('\n');

  return `${header.join(' | ')}\n${tableRows}`;
}

export function createBettingWizard({
  sheetOps = { readRange },
  fightsScalper,
  llmOptions = {},
} = {}) {
  const llm = new ChatOpenAI({
    modelName: llmOptions.modelName || DEFAULT_MODEL,
    temperature: llmOptions.temperature ?? 0.2,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  async function generateBettingStrategy({
    message,
    sheetId = process.env.SHEET_ID,
    range = 'Fights!A:E',
  }) {
    const context = fightsScalper
      ? await fightsScalper
          .getFighterHistory({ sheetId, range, message })
          .catch((error) => {
            console.error('Failed to retrieve fighter history', error);
            return null;
          })
      : null;

    const rows = context?.rows
      ? context.rows
      : await sheetOps.readRange(sheetId, range).catch((error) => {
          console.error('Failed to read Google Sheet range', error);
          return [];
        });

    const fightsTable = formatFightsTable(rows);
    const fighterSummary = context?.fighters?.length
      ? `Identified fighters: ${context.fighters.join(', ')}`
      : 'No specific fighters identified in the request; using full fight history.';

    const systemPrompt =
      'You are the Betting Wizard, an expert MMA analyst that crafts responsible betting strategies. '
      + 'Use the provided fight table to ground your insights. If information is missing, state your assumptions.';

    const humanPrompt = `User request: ${message}\n${fighterSummary}\n\nFights Table:\n${fightsTable}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(humanPrompt),
    ]);

    return response?.content || 'The Betting Wizard could not formulate a response at this time.';
  }

  async function refreshAndSummarise(sheetId) {
    if (!fightsScalper) {
      return 'Fights scalper tool is not configured.';
    }

    const updateMessage = await fightsScalper.fetchAndStoreUpcomingFights({
      sheetId,
    });

    return `${updateMessage}\nThe sheet has been refreshed with the latest UFC bouts.`;
  }

  return {
    generateBettingStrategy,
    refreshAndSummarise,
  };
}

export default {
  createBettingWizard,
};
