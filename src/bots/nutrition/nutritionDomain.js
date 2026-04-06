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

const NAME_STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'sin',
  'por',
  'para',
  'y',
  'e',
  'en',
  'al',
  'a',
  'un',
  'una',
  'unos',
  'unas',
  'me',
  'mi',
  'mis',
  'tu',
  'tus',
  'registrame',
  'registrar',
  'anotame',
  'anotar',
  'sumame',
  'sumar',
  'desayuno',
  'desayune',
  'almuerzo',
  'almorce',
  'cena',
  'cene',
  'merienda',
  'colacion',
  'colacion',
]);

const QUANTITY_TOKEN_PATTERN =
  '\\d+(?:\\s*\\/\\s*\\d+)?(?:[.,]\\d+)?|media|medio|un\\s+medio|una\\s+media|un\\s+cuarto|una\\s+cuarta|cuarto|un\\s+tercio|tercio|tres\\s+cuartos';
const QUANTITY_UNIT_PATTERN =
  'kg|kilos?|kilogramos?|g|gr|gramos?|ml|cc|l|litros?|u|unidad(?:es)?|porciones?|platos?|bochas?|tazas?|vasos?|scoops?|huevos?|rodajas?|cucharadas?|cucharaditas?';

function stripLeadingIntakeContext(value = '') {
  return String(value || '')
    .replace(
      /^\s*(?:registr(?:a|á)(?:me)?|anot(?:a|á)(?:me)?|sum(?:a|á)(?:me)?|agreg(?:a|á)(?:me)?|comi|me\s+comi|desayun(?:e|é)|almorc(?:e|é)|cen(?:e|é)|desayuno|almuerzo|cena|merienda|colacion|colación)\b[:\s-]*/i,
      ''
    )
    .trim();
}

function sanitizeNameHint(value = '') {
  const text = stripLeadingIntakeContext(String(value || ''));
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
    .replace(/^[\s,:;.-]+|[\s,:;.-]+$/g, ' ')
    .replace(/^(?:de|del|la|el|los|las|con|sin|y|e)\s+/i, ' ')
    .replace(/\s+(?:de|del|la|el|los|las|con|sin|y|e)$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  const normalized = String(value || '').replace(',', '.').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFlexibleQuantityToken(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = normalizeText(raw).replace(/\s+/g, ' ');

  const normalizedCompact = normalized.replace(/\s+/g, '');
  if (/^\d+\/\d+$/.test(normalizedCompact)) {
    const [numeratorRaw, denominatorRaw] = normalizedCompact.split('/');
    const numerator = Number(numeratorRaw);
    const denominator = Number(denominatorRaw);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
  }

  const byWords = {
    media: 0.5,
    medio: 0.5,
    'un medio': 0.5,
    'una media': 0.5,
    'un cuarto': 0.25,
    'una cuarta': 0.25,
    cuarto: 0.25,
    'un tercio': 1 / 3,
    tercio: 1 / 3,
    'tres cuartos': 0.75,
  };
  if (Object.prototype.hasOwnProperty.call(byWords, normalized)) {
    return byWords[normalized];
  }

  const numeric = parseNumber(raw);
  if (Number.isFinite(numeric)) return numeric;
  return null;
}

function normalizeQuantityUnit(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const aliases = {
    kilo: 'kg',
    kilos: 'kg',
    kilogramo: 'kg',
    kilogramos: 'kg',
    kg: 'kg',
    gr: 'g',
    gramo: 'g',
    gramos: 'g',
    g: 'g',
    litro: 'l',
    litros: 'l',
    l: 'l',
    ml: 'ml',
    cc: 'cc',
    u: 'unidad',
    unidad: 'unidad',
    unidades: 'unidad',
    porcion: 'porcion',
    porciones: 'porcion',
    plato: 'plato',
    platos: 'plato',
    bocha: 'bocha',
    bochas: 'bocha',
    taza: 'taza',
    tazas: 'taza',
    vaso: 'vaso',
    vasos: 'vaso',
    scoop: 'scoop',
    scoops: 'scoop',
    huevo: 'huevo',
    huevos: 'huevo',
    rodaja: 'rodaja',
    rodajas: 'rodaja',
    cucharada: 'cucharada',
    cucharadas: 'cucharada',
    cucharadita: 'cucharadita',
    cucharaditas: 'cucharadita',
  };
  return aliases[normalized] || normalized;
}

function tokenOverlapCount(valueA = '', valueB = '') {
  const aTokens = normalizeText(valueA)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
  const bTokens = new Set(
    normalizeText(valueB)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token))
  );
  if (!aTokens.length || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap;
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
  const todayParts = extractDateParts(todayIsoDate);
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

  const monthNameToNumber = {
    enero: 1,
    feb: 2,
    febrero: 2,
    mar: 3,
    marzo: 3,
    abr: 4,
    abril: 4,
    may: 5,
    mayo: 5,
    jun: 6,
    junio: 6,
    jul: 7,
    julio: 7,
    ago: 8,
    agosto: 8,
    sep: 9,
    sept: 9,
    set: 9,
    setiembre: 9,
    septiembre: 9,
    oct: 10,
    octubre: 10,
    nov: 11,
    noviembre: 11,
    dic: 12,
    diciembre: 12,
  };
  const dayMonthNameMatch = normalized.match(
    /\b(\d{1,2})\s*(?:de\s+)?(enero|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:tiembre)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)(?:\s*(?:de)?\s*(20\d{2}))?\b/
  );
  if (dayMonthNameMatch) {
    const day = Number(dayMonthNameMatch[1]);
    const monthToken = String(dayMonthNameMatch[2] || '').trim();
    const month = Number(monthNameToNumber[monthToken] || 0);
    const fallbackYear = Number(todayParts?.year || 0);
    const parsedYear = Number(dayMonthNameMatch[3] || 0);
    const year = parsedYear >= 2000 ? parsedYear : fallbackYear;
    if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        localDate: `${year.toString().padStart(4, '0')}-${month
          .toString()
          .padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
        matchedToken: dayMonthNameMatch[0],
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
  const hhmm = text.match(/\b([01]?\d|2[0-3])[:h.]([0-5]\d)\s*(?:hs?|h)?\b/i);
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
  const andFollowedByAmount = new RegExp(
    `\\s+y\\s+(?=(?:${QUANTITY_TOKEN_PATTERN})(?:\\s*(?:${QUANTITY_UNIT_PATTERN}))?\\b)`,
    'gi'
  );
  const canonical = raw
    .replace(/\s+\+\s+/g, '\n')
    .replace(andFollowedByAmount, '\n');
  return canonical
    .split(/\n|,|;/g)
    .map((part) => stripLeadingIntakeContext(part.trim()))
    .filter(Boolean);
}

function parseQuantityAndUnit(rawPart = '') {
  const text = stripLeadingIntakeContext(String(rawPart || '').trim());
  if (!text) {
    return {
      quantityValue: null,
      quantityUnit: null,
      nameHint: '',
    };
  }

  const explicit = text.match(
    new RegExp(`\\b(${QUANTITY_TOKEN_PATTERN})\\s*(${QUANTITY_UNIT_PATTERN})\\b`, 'i')
  );
  if (explicit) {
    const quantityValue = parseFlexibleQuantityToken(explicit[1]);
    const quantityUnit = normalizeQuantityUnit(explicit[2]);
    let nameHint = sanitizeNameHint(
      text.replace(explicit[0], ' ').replace(/\s+/g, ' ').trim()
    );
    if (quantityUnit === 'huevo') {
      const augmented = sanitizeNameHint(`${quantityUnit} ${nameHint}`.trim());
      nameHint = augmented || 'huevo';
    }
    return {
      quantityValue,
      quantityUnit,
      nameHint,
    };
  }

  const leading = text.match(
    /^(\d+(?:\s*\/\s*\d+)?(?:[.,]\d+)?|media|medio|un\s+medio|una\s+media|un\s+cuarto|una\s+cuarta|cuarto|un\s+tercio|tercio|tres\s+cuartos)\s+(.+)$/i
  );
  if (leading) {
    return {
      quantityValue: parseFlexibleQuantityToken(leading[1]),
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

  const hintTokens = normalizedNameHint
    .split(' ')
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 && !NAME_STOPWORDS.has(token) && !/^\d+$/.test(token)
    );
  const entryTokens = new Set(
    entryName
      .split(' ')
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 && !NAME_STOPWORDS.has(token) && !/^\d+$/.test(token)
      )
  );
  const overlap = hintTokens.filter((token) => entryTokens.has(token)).length;
  return overlap * 10;
}

function buildNameHintVariants(normalizedNameHint = '') {
  const base = normalizeText(normalizedNameHint);
  if (!base) return [];
  const variants = new Set([base]);
  variants.add(base.replace(/^(?:de|del|la|el|los|las|con|sin)\s+/i, '').trim());
  variants.add(base.replace(/\s+y\s+.+$/i, '').trim());
  variants.add(base.replace(/\s+e\s+.+$/i, '').trim());
  variants.add(base.replace(/\s+con\s+.+$/i, '').trim());
  return [...variants].filter((variant) => variant && variant.length >= 3);
}

function mergeCatalogPools(...pools) {
  const merged = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const entry of Array.isArray(pool) ? pool : []) {
      const key = String(entry?.id || entry?.productName || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function resolveCatalogEntry(nameHint = '') {
  const normalizedNameHint = toCatalogNormalizedToken(nameHint);
  if (!normalizedNameHint) return null;
  const hintVariants = buildNameHintVariants(normalizedNameHint);
  if (!hintVariants.length) return null;

  const tokenCandidates = [];
  const hintTokens = [...new Set(
    normalizedNameHint
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token))
  )];
  for (const token of hintTokens.slice(0, 5)) {
    tokenCandidates.push(...findFoodCatalogCandidates(token, { limit: 20 }));
  }

  const candidates = findFoodCatalogCandidates(normalizedNameHint, { limit: 80 });
  let pool = mergeCatalogPools(candidates, tokenCandidates);
  if (!pool.length) {
    pool = listFoodCatalogEntries().slice(0, 1200);
  }

  let best = null;
  let bestScore = 0;
  let bestOverlap = 0;
  for (const hintVariant of hintVariants) {
    for (const entry of pool) {
      const entryName = normalizeText(entry?.productName || entry?.normalizedName || '');
      const overlap = tokenOverlapCount(hintVariant, entryName);
      const hasStrongStringMatch =
        entryName === hintVariant ||
        hintVariant.includes(entryName) ||
        entryName.includes(hintVariant);
      if (!hasStrongStringMatch && overlap <= 0) {
        continue;
      }
      const score = scoreCatalogMatch(entry, hintVariant);
      if (score > bestScore || (score === bestScore && overlap > bestOverlap)) {
        bestScore = score;
        bestOverlap = overlap;
        best = entry;
      }
    }
  }
  if (best && bestScore >= 20) return best;

  let looseBest = null;
  let looseScore = 0;
  let looseOverlap = 0;
  let looseHintTokenCount = 0;
  for (const hintVariant of hintVariants) {
    const hintTokens = normalizeText(hintVariant)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
    for (const entry of pool) {
      const entryName = normalizeText(entry?.productName || entry?.normalizedName || '');
      const entryTokens = entryName
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
      const overlap = tokenOverlapCount(hintVariant, entryName);
      if (overlap <= 0) continue;
      if (hintTokens.length >= 4 && overlap < 2) continue;
      const isDirectHint =
        entryName === hintVariant ||
        hintVariant.includes(entryName) ||
        entryName.includes(hintVariant);
      const overlapRatio = hintTokens.length
        ? overlap / hintTokens.length
        : 0;
      const score = overlap * 12 + (isDirectHint ? 8 : 0) + overlapRatio * 10;
      if (hintTokens.length >= 3 && overlapRatio < 0.34 && !isDirectHint) continue;
      if (entryTokens.length >= 3 && overlap < 2 && !isDirectHint) continue;
      if (score > looseScore || (score === looseScore && overlap > looseOverlap)) {
        looseScore = score;
        looseOverlap = overlap;
        looseHintTokenCount = hintTokens.length;
        looseBest = entry;
      }
    }
  }
  if (
    looseBest &&
    (looseScore >= 18 || (looseHintTokenCount > 0 && looseHintTokenCount <= 2 && looseOverlap >= 1 && looseScore >= 12))
  ) {
    return looseBest;
  }
  return null;
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

function estimateItemFromNameHint({
  nameHint = '',
  quantityValue = null,
  quantityUnit = '',
} = {}) {
  const normalized = normalizeText(nameHint);
  if (!normalized) return null;

  const presets = [
    {
      pattern: /\braviol(?:es)?\b/,
      foodItem: 'ravioles de ricota con tuco',
      portionG: 280,
      caloriesKcal: 320,
      proteinG: 12,
      carbsG: 52,
      fatG: 8,
      source: 'estimacion_lexica',
    },
    {
      pattern: /\bguiso\b.*\blentej(?:a|as)\b|\blentej(?:a|as)\b.*\bguiso\b/,
      foodItem: 'guiso de lentejas con pollo',
      portionG: 350,
      caloriesKcal: 420,
      proteinG: 24,
      carbsG: 46,
      fatG: 14,
      source: 'estimacion_lexica',
    },
  ];

  const preset = presets.find((candidate) => candidate.pattern.test(normalized));
  if (!preset) return null;

  const finalQuantityValue =
    Number.isFinite(Number(quantityValue)) && Number(quantityValue) > 0 ? Number(quantityValue) : 1;
  const finalQuantityUnit = String(quantityUnit || 'porcion').trim() || 'porcion';
  const factor = quantityInPortions(finalQuantityValue, finalQuantityUnit, preset.portionG);

  return {
    foodItem: preset.foodItem,
    quantityValue: finalQuantityValue,
    quantityUnit: finalQuantityUnit,
    caloriesKcal: round((Number(preset.caloriesKcal) || 0) * factor),
    proteinG: round((Number(preset.proteinG) || 0) * factor),
    carbsG: round((Number(preset.carbsG) || 0) * factor),
    fatG: round((Number(preset.fatG) || 0) * factor),
    confidence: 'baja',
    source: preset.source,
    brandOrNotes: null,
    catalogItemId: null,
    inputAlias: nameHint,
    resolutionMode: 'estimate',
    matchConfidence: 'baja',
  };
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
    hadExplicitDate: Boolean(dateHint.matchedToken),
    hadExplicitTime: Boolean(timeHint.matchedToken),
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
      const estimated = estimateItemFromNameHint({
        nameHint: quantity.nameHint || chunk,
        quantityValue: quantity.quantityValue,
        quantityUnit: quantity.quantityUnit,
      });
      if (estimated) {
        items.push(estimated);
        continue;
      }
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
      catalogItemId: Number(entry.id) || null,
      inputAlias: quantity.nameHint || chunk,
      resolutionMode: 'catalog',
      matchConfidence: 'media',
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
