import '../core/env.js';
import { readRange } from './sheetOpsTool.js';

function normalise(value) {
  return value ? String(value).toLowerCase() : '';
}

function extractFighterNamesFromMessage(message = '') {
  const cleaned = message.replace(/[^a-zA-Z\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);

  const names = new Set();
  let buffer = [];

  for (const word of words) {
    const isCapitalised = word[0] === word[0]?.toUpperCase();

    if (isCapitalised) {
      buffer.push(word);
      if (buffer.length === 2) {
        names.add(buffer.join(' '));
        buffer = [];
      }
      continue;
    }

    if (/^vs$/i.test(word) || /^versus$/i.test(word) || /^v$/i.test(word)) {
      if (buffer.length) {
        names.add(buffer.join(' '));
      }
      buffer = [];
      continue;
    }

    if (buffer.length) {
      names.add(buffer.join(' '));
      buffer = [];
    }
  }

  if (buffer.length) {
    names.add(buffer.join(' '));
  }

  if (!names.size && words.includes('vs')) {
    const [left, right] = message.split(/vs|versus|v/gi);
    const normaliseName = (segment = '') =>
      segment
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');

    const leftName = normaliseName(left);
    const rightName = normaliseName(right);

    if (leftName) {
      names.add(leftName);
    }
    if (rightName) {
      names.add(rightName);
    }
  }

  return Array.from(names).filter(Boolean);
}

export async function getFighterHistory({
  sheetId = process.env.SHEET_ID,
  range = 'Fights!A:E',
  message = '',
} = {}) {
  const values = await readRange(sheetId, range);
  const fighters = extractFighterNamesFromMessage(message);

  if (!fighters.length) {
    return { fighters: [], rows: values };
  }

  const lowerNames = fighters.map((name) => normalise(name));
  const filteredRows = values.filter((row) => {
    const rowValues = row.map(normalise);
    return lowerNames.some((name) => rowValues.some((value) => value.includes(name)));
  });

  return { fighters, rows: filteredRows };
}

export async function fetchAndStoreUpcomingFights() {
  return 'Live fight scraping is disabled. Maintain the Google Sheet manually before requesting analysis.';
}

export default {
  getFighterHistory,
  fetchAndStoreUpcomingFights,
  extractFighterNamesFromMessage,
};
