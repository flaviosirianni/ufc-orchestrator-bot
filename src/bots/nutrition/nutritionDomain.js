import {
  findFoodCatalogCandidates,
  listFoodCatalogEntries,
  toCatalogNormalizedToken,
} from './nutritionStore.js';

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function sanitizeNameHint(value = '') {
  const text = String(value || '');
  if (!text.trim()) return '';
  return text
    .replace(
      /\b(del|de)\s+que\s+tengo\s+anotad[oa]\s+en\s+info\s+nutricional\b/gi,
      ' '
    )
    .replace(/\bque\s+tengo\s+anotad[oa]\b/gi, ' ')
    .replace(/\ben\s+info\s+nutricional\b/gi, ' ')
    .replace(/\bde\s+info\s+nutricional\b/gi, ' ')
    .replace(/\b(info\s+nutricional)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  const normalized = String(value || '').replace(',', '.').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimeZone(value = '', fallback = 'America/Argentina/Buenos_Aires') {
  const candidate = String(value || '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function formatInTimeZone(date = new Date(), timeZone = 'America/Argentina/Buenos_Aires') {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    localDate: `${pick('year')}-${pick('month')}-${pick('day')}`,
    localTime: `${pick('hour')}:${pick('minute')}`,
  };
}

function toUtcIsoFromLocal({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  timeZone = 'America/Argentina/Buenos_Aires',
} = {}) {
  const safeTz = normalizeTimeZone(timeZone);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  const zoned = formatInTimeZone(utcGuess, safeTz);
  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const zonedAsUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    0
  );
  const corrected = new Date(utcGuess.getTime() + (targetAsUtcMs - zonedAsUtcMs));
  return corrected.toISOString();
}

function shiftIsoDate(isoDate = '', deltaDays = 0) {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  return date.toISOString().slice(0, 10);
}

function extractDateParts(localDate = '') {
  const match = String(localDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function extractTimeParts(localTime = '') {
  const match = String(localTime || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function detectDateHint(message = '', todayIsoDate = '') {
  const text = String(message || '');
  const normalized = normalizeText(text);
  const isoMatch = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const [_, yearRaw, monthRaw, dayRaw] = isoMatch;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        localDate: `${year.toString().padStart(4, '0')}-${month
          .toString()
          .padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
        matchedToken: isoMatch[0],
      };
    }
  }

  const dmyMatch = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/);
  if (dmyMatch) {
    const [_, dayRaw, monthRaw, yearRaw] = dmyMatch;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        localDate: `${year.toString().padStart(4, '0')}-${month
          .toString()
          .padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
        matchedToken: dmyMatch[0],
      };
    }
  }

  if (/\bayer\b/.test(normalized)) {
    return {
      localDate: shiftIsoDate(todayIsoDate, -1),
      matchedToken: 'ayer',
    };
  }
  if (/\bhoy\b/.test(normalized)) {
    return {
      localDate: todayIsoDate,
      matchedToken: 'hoy',
    };
  }
  return { localDate: todayIsoDate, matchedToken: '' };
}

function detectTimeHint(message = '', fallbackTime = '') {
  const text = String(message || '');
  const hhmm = text.match(/\b([01]?\d|2[0-3])[:h.]([0-5]\d)\b/i);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    return {
      localTime: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
      matchedToken: hhmm[0],
    };
  }
  const hsWithPrefix = text.match(/\b(?:a\s+las?\s*)([01]?\d|2[0-3])\s*(?:hs?|h)\b/i);
  if (hsWithPrefix) {
    const hour = Number(hsWithPrefix[1]);
    return {
      localTime: `${hour.toString().padStart(2, '0')}:00`,
      matchedToken: hsWithPrefix[0],
    };
  }
  const hsOnly = text.match(/\b([01]?\d|2[0-3])\s*(?:hs|h)\b/i);
  if (hsOnly) {
    const hour = Number(hsOnly[1]);
    return {
      localTime: `${hour.toString().padStart(2, '0')}:00`,
      matchedToken: hsOnly[0],
    };
  }
  const hOnly = text.match(/\b([01]?\d|2[0-3])\s*h\b/i);
  if (hOnly) {
    const hour = Number(hOnly[1]);
    return {
      localTime: `${hour.toString().padStart(2, '0')}:00`,
      matchedToken: hOnly[0],
    };
  }
  return {
    localTime: fallbackTime,
    matchedToken: '',
  };
}

function stripTemporalTokens(message = '', tokens = []) {
  let output = String(message || '');
  for (const token of tokens) {
    if (!token) continue;
    output = output.replace(token, ' ');
  }
  return output.replace(/\s+/g, ' ').trim();
}

function splitIntakeCandidates(cleanText = '') {
  const raw = String(cleanText || '').trim();
  if (!raw) return [];
  const canonical = raw.replace(/\s+\+\s+/g, '\n');
  return canonical
    .split(/\n|,|;/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseQuantityAndUnit(rawPart = '') {
  const text = String(rawPart || '').trim();
  if (!text) {
    return {
      quantityValue: null,
      quantityUnit: null,
      nameHint: '',
    };
  }

  const explicit = text.match(
    /\b(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|gramos?|ml|cc|l|litros?|u|unidad(?:es)?|porciones?)\b/i
  );
  if (explicit) {
    const quantityValue = parseNumber(explicit[1]);
    const quantityUnit = normalizeText(explicit[2]);
    const nameHint = sanitizeNameHint(
      text.replace(explicit[0], ' ').replace(/\s+/g, ' ').trim()
    );
    return {
      quantityValue,
      quantityUnit,
      nameHint,
    };
  }

  const leading = text.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (leading) {
    return {
      quantityValue: parseNumber(leading[1]),
      quantityUnit: 'unidad',
      nameHint: sanitizeNameHint(String(leading[2] || '').trim()),
    };
  }

  return {
    quantityValue: 1,
    quantityUnit: 'porcion',
    nameHint: sanitizeNameHint(text),
  };
}

function scoreCatalogMatch(entry = {}, normalizedNameHint = '') {
  if (!entry || !normalizedNameHint) return 0;
  const entryName = normalizeText(entry.productName || entry.normalizedName || '');
  if (!entryName) return 0;
  if (entryName === normalizedNameHint) return 100;
  if (normalizedNameHint.includes(entryName)) return 80;
  if (entryName.includes(normalizedNameHint)) return 60;

  const hintTokens = normalizedNameHint.split(' ').filter(Boolean);
  const entryTokens = new Set(entryName.split(' ').filter(Boolean));
  const overlap = hintTokens.filter((token) => entryTokens.has(token)).length;
  return overlap * 10;
}

function resolveCatalogEntry(nameHint = '') {
  const normalizedNameHint = toCatalogNormalizedToken(nameHint);
  if (!normalizedNameHint) return null;

  const candidates = findFoodCatalogCandidates(normalizedNameHint, { limit: 40 });
  let pool = Array.isArray(candidates) ? candidates : [];
  if (!pool.length) {
    pool = listFoodCatalogEntries().slice(0, 120);
  }

  let best = null;
  let bestScore = 0;
  for (const entry of pool) {
    const score = scoreCatalogMatch(entry, normalizedNameHint);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best || bestScore < 20) return null;
  return best;
}

function quantityInPortions(quantityValue = null, quantityUnit = '', portionG = 100) {
  const q = Number(quantityValue);
  if (!Number.isFinite(q) || q <= 0) return 1;
  const unit = normalizeText(quantityUnit);
  const p = Number(portionG) || 100;

  if (unit === 'kg' || unit === 'kilo' || unit === 'kilos') {
    return (q * 1000) / p;
  }
  if (unit === 'g' || unit === 'gr' || unit === 'gramo' || unit === 'gramos') {
    return q / p;
  }
  if (unit === 'l' || unit === 'litro' || unit === 'litros') {
    return (q * 1000) / p;
  }
  if (unit === 'ml' || unit === 'cc') {
    return q / p;
  }
  return q;
}

function round(value = 0) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function resolveTemporalContext({
  rawMessage = '',
  userTimeZone = 'America/Argentina/Buenos_Aires',
  now = new Date(),
} = {}) {
  const timeZone = normalizeTimeZone(userTimeZone);
  const nowLocal = formatInTimeZone(now, timeZone);
  const dateHint = detectDateHint(rawMessage, nowLocal.localDate);
  const timeHint = detectTimeHint(rawMessage, nowLocal.localTime);

  const dateParts = extractDateParts(dateHint.localDate);
  const timeParts = extractTimeParts(timeHint.localTime);
  const loggedAt = dateParts
    ? toUtcIsoFromLocal({
        year: dateParts.year,
        month: dateParts.month,
        day: dateParts.day,
        hour: timeParts?.hour ?? nowLocal.hour,
        minute: timeParts?.minute ?? nowLocal.minute,
        second: 0,
        timeZone,
      })
    : now.toISOString();

  return {
    timeZone,
    localDate: dateHint.localDate || nowLocal.localDate,
    localTime: timeHint.localTime || nowLocal.localTime,
    loggedAt,
    strippedMessage: stripTemporalTokens(rawMessage, [dateHint.matchedToken, timeHint.matchedToken]),
    usedRuntimeNow: !dateHint.matchedToken && !timeHint.matchedToken,
  };
}

export function parseIntakePayload({
  rawMessage = '',
  userTimeZone = 'America/Argentina/Buenos_Aires',
  now = new Date(),
} = {}) {
  const temporal = resolveTemporalContext({
    rawMessage,
    userTimeZone,
    now,
  });
  const normalizedText = String(temporal.strippedMessage || '').trim();
  const chunks = splitIntakeCandidates(normalizedText);
  if (!chunks.length) {
    return {
      ok: false,
      error: 'missing_intake_items',
      temporal,
      unresolvedItems: [],
      items: [],
    };
  }

  const items = [];
  const unresolvedItems = [];
  for (const chunk of chunks) {
    const quantity = parseQuantityAndUnit(chunk);
    const entry = resolveCatalogEntry(quantity.nameHint || chunk);
    if (!entry) {
      unresolvedItems.push(chunk);
      continue;
    }

    const factor = quantityInPortions(quantity.quantityValue, quantity.quantityUnit, entry.portionG);
    items.push({
      foodItem: entry.productName,
      quantityValue: quantity.quantityValue,
      quantityUnit: quantity.quantityUnit,
      caloriesKcal: round((Number(entry.caloriesKcal) || 0) * factor),
      proteinG: round((Number(entry.proteinG) || 0) * factor),
      carbsG: round((Number(entry.carbsG) || 0) * factor),
      fatG: round((Number(entry.fatG) || 0) * factor),
      confidence: 'media',
      source: entry.source || 'base_estandar',
      brandOrNotes: entry.brand || null,
    });
  }

  if (!items.length) {
    return {
      ok: false,
      error: 'no_resolved_items',
      temporal,
      unresolvedItems,
      items,
    };
  }

  if (unresolvedItems.length) {
    return {
      ok: false,
      error: 'partial_resolution',
      temporal,
      unresolvedItems,
      items,
    };
  }

  return {
    ok: true,
    temporal,
    items,
    unresolvedItems: [],
  };
}

export function parseWeighinPayload({
  rawMessage = '',
  userTimeZone = 'America/Argentina/Buenos_Aires',
  now = new Date(),
} = {}) {
  const temporal = resolveTemporalContext({
    rawMessage,
    userTimeZone,
    now,
  });
  const text = normalizeText(rawMessage);
  const weightMatch =
    text.match(/\b(\d{2,3}(?:[.,]\d{1,2})?)\s*kg\b/) ||
    text.match(/\bpeso\s*[:=]?\s*(\d{2,3}(?:[.,]\d{1,2})?)\b/);

  const weightKg = weightMatch ? parseNumber(weightMatch[1]) : null;
  if (!weightKg) {
    return {
      ok: false,
      error: 'missing_weight',
      temporal,
    };
  }

  const bodyFat = text.match(/\bgrasa(?:\s+corporal)?\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
  const visceral = text.match(/\bvisceral\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,2})?)\b/);
  const muscle = text.match(
    /\b(?:musculo|masa muscular)\s*[:=]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*kg/
  );
  const water = text.match(/\bagua\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
  const bmr = text.match(/\bbmr\s*[:=]?\s*(\d{3,5}(?:[.,]\d{1,2})?)\b/);
  const bone = text.match(
    /\b(?:hueso|masa osea)\s*[:=]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*kg/
  );

  return {
    ok: true,
    temporal,
    weighin: {
      weightKg,
      bodyFatPercent: bodyFat ? parseNumber(bodyFat[1]) : null,
      visceralFat: visceral ? parseNumber(visceral[1]) : null,
      muscleMassKg: muscle ? parseNumber(muscle[1]) : null,
      bodyWaterPercent: water ? parseNumber(water[1]) : null,
      bmrKcal: bmr ? parseNumber(bmr[1]) : null,
      boneMassKg: bone ? parseNumber(bone[1]) : null,
      notes: '',
    },
  };
}

export function parseProfileUpdatePayload(rawMessage = '') {
  const message = String(rawMessage || '').trim();
  const normalized = normalizeText(message);
  if (!normalized) {
    return {
      ok: false,
      error: 'empty_profile_payload',
      updates: {},
    };
  }

  const updates = {};
  const timezoneMatch = message.match(/\b(?:timezone|tz)\s+([A-Za-z_]+\/[A-Za-z_]+)\b/);
  if (timezoneMatch) {
    updates.timezone = timezoneMatch[1].trim();
  }

  const kcalMatch = message.match(/\b(\d{3,5})\s*k?cal\b/i);
  if (kcalMatch) {
    updates.targetCaloriesKcal = Number(kcalMatch[1]);
  }

  const proteinMatch =
    message.match(/\b(\d{2,4})\s*g(?:r)?\s*(?:de\s*)?prote/i) ||
    message.match(/\bprote(?:ina)?\s*[:=]?\s*(\d{2,4})\s*g/i);
  if (proteinMatch) {
    updates.targetProteinG = Number(proteinMatch[1]);
  }

  const goalMatch = message.match(/\bobjetivo\b\s*[:=]?\s*(.+)$/i);
  if (goalMatch) {
    updates.mainGoal = goalMatch[1].trim();
  } else if (/\b(bajar grasa|definicion|definición|mantener|volumen|recomposicion|recomposición)\b/.test(normalized)) {
    updates.mainGoal = message.trim();
  }

  const restrictionsMatch = message.match(/\b(?:restricciones?|notas?)\b\s*[:=]?\s*(.+)$/i);
  if (restrictionsMatch) {
    updates.restrictions = restrictionsMatch[1].trim();
  }

  if (!Object.keys(updates).length) {
    return {
      ok: false,
      error: 'no_profile_fields_detected',
      updates: {},
    };
  }

  return { ok: true, updates };
}

export function resolveNutritionModuleFromAction(guidedAction = '') {
  const action = String(guidedAction || '').trim();
  if (action === 'log_intake') return 'ingesta';
  if (action === 'log_weighin') return 'pesaje';
  if (action === 'update_profile') return 'perfil';
  if (action === 'view_summary') return 'resumen';
  if (action === 'learning_chat') return 'aprendizaje';
  if (action === 'view_credits') return 'creditos';
  if (action === 'view_analysis') return 'aprendizaje';
  return 'ingesta';
}

export function formatMacroLine(prefix = '', values = {}) {
  return `${prefix}${Math.round(Number(values.caloriesKcal) || 0)} kcal | P ${Math.round(
    Number(values.proteinG) || 0
  )} g | C ${Math.round(Number(values.carbsG) || 0)} g | G ${Math.round(
    Number(values.fatG) || 0
  )} g`;
}
