import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';
import ffmpegPath from 'ffmpeg-static';
import { toTelegramHtml, toTelegramPlainText } from './messageFormatter.js';

const execFileAsync = promisify(execFile);

const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES ?? String(25 * 1024 * 1024));
const AUDIO_TRANSCRIBE_MODEL = process.env.AUDIO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const MAX_AUDIO_TRANSCRIPT_CHARS = Number(
  process.env.MAX_AUDIO_TRANSCRIPT_CHARS ?? '4000'
);
const MEDIA_GROUP_FLUSH_MS = Number(process.env.MEDIA_GROUP_FLUSH_MS ?? '900');
const FFMPEG_BINARY = ffmpegPath || 'ffmpeg';
const TYPING_ACTION_INTERVAL_MS = Number(process.env.TYPING_ACTION_INTERVAL_MS ?? '4500');
const CALLBACK_DEDUP_WINDOW_MS = Number(
  process.env.TELEGRAM_CALLBACK_DEDUP_WINDOW_MS ?? '2500'
);
const CALLBACK_DEDUP_MAX_KEYS_PER_CHAT = Number(
  process.env.TELEGRAM_CALLBACK_DEDUP_MAX_KEYS_PER_CHAT ?? '80'
);
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const MP_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';
const INTERACTION_MODES = new Set(['guided_strict', 'hybrid']);
const GUIDED_MENU_IDS = new Set(['default', 'ufc_default', 'ufc_v1', 'nutrition_v1']);
const TELEGRAM_INTERACTION_MODE = normalizeInteractionMode(
  process.env.TELEGRAM_INTERACTION_MODE || 'guided_strict'
);
const GUIDED_QUOTES_TEXT_FALLBACK =
  String(process.env.GUIDED_QUOTES_TEXT_FALLBACK ?? 'true').toLowerCase() !== 'false';
const GUIDED_INPUT_ACTIONS = new Set([
  'analyze_quotes',
  'record_bet',
  'settle_bet',
  'log_intake',
  'log_weighin',
  'update_profile',
  'view_summary',
  'learning_chat',
]);

const MAIN_MENU_ROWS = [
  [
    { text: 'Apuestas', callback_data: 'menu:bets' },
    { text: 'Evento', callback_data: 'menu:event' },
  ],
  [
    { text: 'Config', callback_data: 'menu:config' },
    { text: 'Ayuda', callback_data: 'qa:help' },
  ],
];

const GUIDED_MAIN_MENU_ROWS = [
  [{ text: 'Analizar cuotas', callback_data: 'qa:analyze_quotes' }],
  [
    { text: 'Ledger', callback_data: 'menu:ledger' },
    { text: 'Creditos', callback_data: 'qa:view_credits' },
  ],
  [
    { text: 'Ayuda', callback_data: 'qa:help' },
  ],
];

const GUIDED_MAIN_MENU_ROWS_MINIMAL = [
  [{ text: 'Analizar', callback_data: 'qa:analyze_quotes' }],
  [{ text: 'Creditos', callback_data: 'qa:view_credits' }],
  [{ text: 'Ayuda', callback_data: 'qa:help' }],
];

const GUIDED_LEDGER_MENU_ROWS = [
  [
    { text: 'Registrar', callback_data: 'qa:record_bet' },
    { text: 'Cerrar', callback_data: 'qa:settle_bet' },
  ],
  [
    { text: 'Pendientes', callback_data: 'qa:list_pending' },
    { text: 'Historial', callback_data: 'qa:list_history' },
  ],
  [{ text: '⬅ Volver', callback_data: 'menu:main' }],
];

const NUTRITION_GUIDED_MAIN_MENU_ROWS = [
  [
    { text: '🍽 Registrar ingesta', callback_data: 'qa:nutrition_log_intake' },
    { text: '⚖️ Registrar pesaje', callback_data: 'qa:nutrition_log_weighin' },
  ],
  [
    { text: '🧭 Perfil/objetivos', callback_data: 'qa:nutrition_update_profile' },
    { text: '📊 Resumen', callback_data: 'qa:nutrition_view_summary' },
  ],
  [
    { text: '🎓 Aprendizaje', callback_data: 'qa:nutrition_learning' },
    { text: '💳 Creditos', callback_data: 'qa:view_credits' },
  ],
  [{ text: '🆘 Ayuda', callback_data: 'qa:help' }],
];

const NUTRITION_TUTORIAL_LEVEL_ROWS = [
  [
    { text: '🟢 Básico', callback_data: 'qa:nutrition_tutorial:menu_basico' },
    { text: '🟡 Intermedio', callback_data: 'qa:nutrition_tutorial:menu_intermedio' },
    { text: '🔴 Avanzado', callback_data: 'qa:nutrition_tutorial:menu_avanzado' },
  ],
  [{ text: '⬅ Volver al menú', callback_data: 'menu:main' }],
];

const NUTRITION_TUTORIAL_BASICO_ROWS = [
  [{ text: 'Calorías: qué son y por qué importan', callback_data: 'qa:nutrition_tutorial:calorias' }],
  [{ text: 'Proteínas, carbos y grasas', callback_data: 'qa:nutrition_tutorial:macros' }],
  [{ text: 'Cómo armar un plato equilibrado', callback_data: 'qa:nutrition_tutorial:armar_plato' }],
  [{ text: 'Cómo leer etiquetas nutricionales', callback_data: 'qa:nutrition_tutorial:etiquetas' }],
  [{ text: 'Comer mejor sin contar todo', callback_data: 'qa:nutrition_tutorial:comer_mejor' }],
  [{ text: '⬅ Niveles', callback_data: 'qa:nutrition_tutorial:menu_niveles' }],
];

const NUTRITION_TUTORIAL_INTERMEDIO_ROWS = [
  [{ text: 'Proteína y saciedad', callback_data: 'qa:nutrition_tutorial:proteina_saciedad' }],
  [{ text: 'Fibra: la gran olvidada', callback_data: 'qa:nutrition_tutorial:fibra' }],
  [{ text: 'Hambre física vs emocional', callback_data: 'qa:nutrition_tutorial:hambre_emocional' }],
  [{ text: 'Fines de semana y situaciones sociales', callback_data: 'qa:nutrition_tutorial:finde_social' }],
  [{ text: 'Alcohol y nutrición', callback_data: 'qa:nutrition_tutorial:alcohol' }],
  [{ text: '⬅ Niveles', callback_data: 'qa:nutrition_tutorial:menu_niveles' }],
];

const NUTRITION_TUTORIAL_AVANZADO_ROWS = [
  [{ text: 'Déficit calórico sin perder músculo', callback_data: 'qa:nutrition_tutorial:deficit_musculo' }],
  [{ text: 'Recomposición corporal', callback_data: 'qa:nutrition_tutorial:recomposicion' }],
  [{ text: 'Retención de líquidos', callback_data: 'qa:nutrition_tutorial:retencion_liquido' }],
  [{ text: 'Cómo interpretar el peso en la balanza', callback_data: 'qa:nutrition_tutorial:interpretar_peso' }],
  [{ text: 'Cómo usar el bot al máximo', callback_data: 'qa:nutrition_tutorial:usar_bot' }],
  [{ text: '⬅ Niveles', callback_data: 'qa:nutrition_tutorial:menu_niveles' }],
];

const BETS_MENU_ROWS = [
  [
    { text: 'Analizar cuotas', callback_data: 'qa:analyze_quotes' },
    { text: 'Registrar', callback_data: 'act:bet_record' },
  ],
  [
    { text: 'Pendientes', callback_data: 'qa:list_pending' },
    { text: 'Cerrar', callback_data: 'qa:settle_bet' },
  ],
  [
    { text: 'Corregir', callback_data: 'qa:undo_last' },
    { text: '⬅ Volver', callback_data: 'menu:main' },
  ],
];

const EVENT_MENU_ROWS = [
  [
    { text: 'Proyecciones', callback_data: 'qa:event_projections' },
    { text: 'Ultimas novedades', callback_data: 'qa:latest_news' },
  ],
  [
    { text: 'Alertas noticias', callback_data: 'act:cfg_news_alerts_toggle' },
    { text: '⬅ Volver', callback_data: 'menu:main' },
  ],
];

const CONFIG_MENU_ROWS = [
  [
    { text: 'Ver config', callback_data: 'qa:view_config' },
    { text: 'Unidad', callback_data: 'act:cfg_unit' },
  ],
  [
    { text: 'Riesgo', callback_data: 'act:cfg_risk' },
  ],
  [
    { text: 'Bankroll', callback_data: 'act:cfg_bankroll' },
    { text: 'Stake/Exposicion', callback_data: 'act:cfg_stake_exposure' },
  ],
  [
    { text: 'Timezone', callback_data: 'act:cfg_timezone' },
    { text: 'Creditos', callback_data: 'qa:view_credits' },
  ],
  [
    { text: '⬅ Volver', callback_data: 'menu:main' },
  ],
];

const QUICK_ACTION_HINTS = {
  analyze_fight: [
    '🥊 Analizar pelea (sin cuotas)',
    'Pasame pelea y, si queres, evento.',
    'Ejemplo: `Zellhuber vs Green`',
    'Con eso te doy: escenario probable, claves tacticas, riesgos y lean principal.',
    'No hace falta mandar cuotas para este modo.',
  ].join('\n'),
  analyze_quotes: [
    '📸 Analizar cuotas',
    'Quotes = cuotas/odds actuales de tu bookie para esa pelea.',
    'Para tomar decisiones, necesito screenshot completo de la pagina de apuestas de ESA pelea (sin recortes).',
    'Ideal: que se vea ML + O/U + metodo, si aparecen.',
    'Fallback texto aceptado: `evento, pelea, mercado, cuota`.',
    'Con eso te devuelvo lectura + EV + stake sugerido.',
  ].join('\n'),
  event_projections: [
    '📊 Proyecciones para el evento',
    'Te muestro pelea por pelea qué escenario veo hoy:',
    '- ganador proyectado',
    '- nivel de confianza (%)',
    '- solo novedades relevantes si cambian la lectura',
  ].join('\n'),
  latest_news: [
    '📰 Ultimas novedades',
    'Te comparto las noticias mas relevantes del proximo evento UFC.',
    'Si no hay novedades de impacto, te lo digo explicitamente.',
  ].join('\n'),
  bet_open: [
    '🚪 Abrir apuesta (setup, sin registrar todavía)',
    'Usalo para preparar la jugada antes de guardarla en ledger.',
    'Pasame: pelea + mercado + idea de entrada.',
    'Ejemplo: `Zellhuber vs Green, Under 2.5, entrar solo si @1.80+`.',
    'Te devuelvo plan de entrada (escenario, riesgos y trigger), pero no lo registra.',
  ].join('\n'),
  record_bet: [
    '🧾 Registrar apuesta al ledger',
    'Mandame screenshot del ticket ya hecho (ideal: pelea + pick + cuota + stake).',
    'Fallback texto: `evento, pelea, pick/mercado, cuota, stake`.',
    'Ejemplo: `UFC 326, Holloway vs Oliveira, Holloway ML, @2.10, $5000`.',
  ].join('\n'),
  settle_bet: [
    '✅ Cerrar apuesta',
    'Ideal: screenshot del resultado de la apuesta (ticket/historial del bookie).',
    'Fallback texto: `bet_id + resultado`.',
    'Ejemplo: `bet_id 31 WON` o `bet_id 31 LOST`.',
    'Si no sabes el ID, primero tocá `Pendientes` (aparece como `bet_id 45`).',
  ].join('\n'),
  config_stake: [
    '⚙️ Configurar stake minimo',
    'Mandame un mensaje como:',
    '- `mi stake minimo es $3000`',
    '- `minimo 4u por pick`',
    '- `mi stake minimo es $3000 y minimo 4u por pick`',
  ].join('\n'),
  config_profile: [
    '⚙️ Configurar perfil',
    'Podés pasarme datos como:',
    '- `unidad 600`',
    '- `riesgo moderado`',
    '- `bankroll 120000`',
    '- `timezone America/Argentina/Buenos_Aires`',
  ].join('\n'),
  config_unit: [
    '⚙️ Configurar unidad',
    'Mandame un mensaje como:',
    '- `unidad 600`',
    '- `mi unidad es 750`',
  ].join('\n'),
  config_risk: [
    '⚙️ Configurar riesgo',
    'Mandame un mensaje como:',
    '- `riesgo conservador`',
    '- `riesgo moderado`',
    '- `riesgo agresivo`',
  ].join('\n'),
  config_bankroll: [
    '⚙️ Configurar bankroll',
    'Mandame un mensaje como:',
    '- `bankroll 120000`',
    '- `mi bankroll es $90000`',
  ].join('\n'),
  config_timezone: [
    '⚙️ Configurar timezone',
    'Mandame un mensaje como:',
    '- `timezone America/Argentina/Buenos_Aires`',
    '- `tz America/Mexico_City`',
  ].join('\n'),
  config_utilization: [
    '⚙️ Configurar exposicion objetivo por evento',
    'Mandame un mensaje como:',
    '- `utilizacion objetivo 35%`',
    '- `exposicion objetivo evento 40`',
  ].join('\n'),
  config_stake_exposure: [
    '⚙️ Stake / Exposicion',
    'Podés configurar ambas en mensajes separados o juntos.',
    'Ejemplos:',
    '- `mi stake minimo es $3000 y minimo 4u por pick`',
    '- `utilizacion objetivo 35%`',
  ].join('\n'),
  config_news_alerts_toggle: [
    '🔔 Alertas de noticias',
    'Activa o desactiva avisos automáticos de cambios relevantes del evento.',
    'Ejemplos:',
    '- `activar alertas noticias`',
    '- `desactivar alertas noticias`',
    '- `estado alertas noticias`',
  ].join('\n'),
  help: [
    '🆘 Ayuda de botones',
    '',
    '🏠 Principal',
    '- `Apuestas`: operaciones de ledger y lectura de cuotas.',
    '- `Evento`: proyecciones y novedades del próximo evento.',
    '- `Config`: ajustes de perfil de staking.',
    '',
    '📚 Apuestas',
    '- `Analizar cuotas`: lectura + EV con odds/quotes.',
    '- `Registrar`: guarda la apuesta en ledger.',
    '- `Pendientes`: lista apuestas abiertas con bet_id.',
    '- `Cerrar`: cierra una apuesta (`bet_id + WON/LOST`).',
    '- `Corregir`: revierte la última mutación sensible.',
    '',
    '⚙️ Config',
    '- `Ver config`: muestra tus ajustes actuales.',
    '- `Unidad / Riesgo / Bankroll / Stake-Exposicion / Timezone`: actualizan tu perfil.',
    '- `Creditos`: muestra saldo y movimientos.',
    '',
    '🧠 Evento',
    '- `Proyecciones`: lectura actual pelea por pelea + confianza.',
    '- `Ultimas novedades`: resumen de noticias relevantes recientes.',
    '- `Alertas noticias`: activa/desactiva avisos automáticos de novedades relevantes.',
    '',
    'Tip: podés seguir usando chat libre; los botones son atajos.',
  ].join('\n'),
  help_guided: [
    '🆘 Ayuda (modo guiado estricto)',
    '',
    'Acciones disponibles:',
    '- `Analizar cuotas`: analiza screenshot completo o texto estructurado de odds.',
    '- `Ledger`: registrar/cerrar apuestas y ver pendientes/historial.',
    '- `Creditos`: saldo + movimientos recientes.',
    '- `Ayuda`: recordatorio rapido del flujo.',
    '',
    'Que son las quotes:',
    '- Son las cuotas/odds que ves en tu casa de apuestas para una pelea.',
    '',
    'Regla para decisiones accionables:',
    '- Envia screenshot completo de la pagina de apuestas de esa pelea (no recortes).',
    '',
    'Formato recomendado para analisis:',
    '- Screenshot completo (ideal: ML + O/U + metodo).',
    '- O texto estructurado: `evento, pelea, mercado, cuota`.',
    '',
    'Formato recomendado para ledger:',
    '- `Registrar`: screenshot del ticket hecho o texto `evento, pelea, pick, cuota, stake`.',
    '- `Cerrar`: screenshot del resultado o texto `bet_id + WON/LOST/PUSH`.',
    '',
    'En este modo no uso chat libre para interpretar otras tareas.',
  ].join('\n'),
  guided_welcome: [
    '📌 Menu principal (modo guiado)',
    'Elegí una accion:',
    '- `Analizar cuotas` para EV/stake.',
    '- `Ledger` para registrar/cerrar y consultar apuestas.',
    '- `Creditos` para saldo y recarga.',
  ].join('\n'),
  guided_welcome_minimal: [
    '📌 Menu principal (modo guiado)',
    'Elegí una accion:',
    '- `Analizar` para la tarea principal de este bot.',
    '- `Creditos` para saldo y recarga.',
    '- `Ayuda` para ver formato recomendado de input.',
  ].join('\n'),
  guided_reencauce: [
    '📌 Modo guiado activo (quotes = cuotas/odds de tu bookie).',
    'Para una recomendacion accionable, mandame screenshot completo de la pagina de apuestas de esa pelea.',
    'Si no tenes imagen, usa texto estructurado: `evento, pelea, mercado, cuota`.',
    'Tambien podes usar los botones `Analizar cuotas`, `Ledger`, `Creditos` o `Ayuda`.',
  ].join('\n'),
  guided_reencauce_record_bet: [
    '📌 Modo guiado - Registrar apuesta.',
    'Mandame screenshot del ticket ya hecho (que se vea pelea + pick + cuota + stake).',
    'Si no tenes imagen, usa texto: `evento, pelea, pick/mercado, cuota, stake`.',
  ].join('\n'),
  guided_reencauce_settle_bet: [
    '📌 Modo guiado - Cerrar apuesta.',
    'Mandame screenshot del resultado del ticket o del historial del bookie.',
    'Si no tenes imagen, usa texto: `bet_id + WON/LOST/PUSH`.',
  ].join('\n'),
  nutrition_help_guided: [
    '🆘 Ayuda (Nutricion V1, modo guiado)',
    '',
    'Modulos:',
    '- `Registrar ingesta`: texto simple `hora + lo ingerido` (si no ponés hora, uso ahora local).',
    '- `Registrar pesaje`: `peso_kg` obligatorio; el resto es opcional.',
    '- `Perfil/objetivos`: objetivo, kcal target, proteina target, timezone, notas y productos fijos por alias.',
    '- `Resumen`: hoy + rolling 7d/14d + estado vs objetivo.',
    '- `Aprendizaje`: unico modulo con chat libre nutricional.',
    '- `Creditos`: saldo y recarga.',
    '',
    'Fuera de `Aprendizaje`, el bot no toma chat ambiguo: te reencauza al modulo activo.',
  ].join('\n'),
  nutrition_welcome: [
    '🥗 Menu principal (Nutricion V1)',
    'Elegí un modulo:',
    '- `Registrar ingesta`',
    '- `Registrar pesaje`',
    '- `Perfil/objetivos`',
    '- `Resumen`',
    '- `Aprendizaje`',
  ].join('\n'),
  nutrition_log_intake: [
    '🍽 Registrar ingesta',
    'Formato simple recomendado:',
    '- `13:30 pollo con arroz + ensalada`',
    '- `mate con 2 tostadas con queso`',
    'También podés mandar foto de la comida: si hay buena claridad la registro; si no, te pido confirmación.',
    'Si no aclarás fecha/hora, uso ahora en tu timezone.',
  ].join('\n'),
  nutrition_log_weighin: [
    '⚖️ Registrar pesaje',
    'Mandame al menos el peso en kg.',
    'Ejemplos:',
    '- `81.4 kg`',
    '- `hoy 08:15 81.4 kg grasa 18.2% agua 56%`',
  ].join('\n'),
  nutrition_update_profile: [
    '🧭 Perfil / objetivos',
    'Podés pasar uno o varios campos en el mismo mensaje.',
    'Ejemplos:',
    '- `objetivo bajar grasa manteniendo musculo`',
    '- `target 2200 kcal y 170g proteina`',
    '- `timezone America/Argentina/Buenos_Aires`',
    '- `restricciones: sin lactosa`',
    '- `producto leche proteica = Leche Proteica La Serenisima`',
    '- `listar productos fijos`',
  ].join('\n'),
  nutrition_view_summary: [
    '📊 Resumen',
    'Te voy a mostrar hoy + rolling 7d/14d y comparacion corta vs tu perfil.',
  ].join('\n'),
  nutrition_learning: [
    '🎓 Modo Aprendizaje activo',
    'Podés chatear libre o elegir un tutorial:',
    '- Básico: calorías, macros, armar un plato, etiquetas',
    '- Intermedio: proteína, fibra, hambre emocional, fines de semana',
    '- Avanzado: déficit, recomposición, interpretar el peso',
    'Elegí un nivel con los botones o escribí tu pregunta.',
  ].join('\n'),
  nutrition_reencauce: [
    '📌 Modo guiado Nutricion activo.',
    'Elegí un modulo en botones para operar: ingesta, pesaje, perfil, resumen o aprendizaje.',
  ].join('\n'),
  nutrition_reencauce_intake: [
    '📌 Modo guiado - Registrar ingesta.',
    'Mandame texto simple con `hora + lo ingerido`.',
    'Ejemplo: `14:10 yogur + banana + 30g avena`.',
  ].join('\n'),
  nutrition_reencauce_weighin: [
    '📌 Modo guiado - Registrar pesaje.',
    'Necesito al menos `peso_kg`.',
    'Ejemplo: `81.4 kg`.',
  ].join('\n'),
  nutrition_reencauce_profile: [
    '📌 Modo guiado - Perfil/objetivos.',
    'Pasame campos a actualizar (objetivo, kcal, proteina, timezone, notas/restricciones).',
    'Tambien podés setear productos fijos: `producto leche proteica = Leche Proteica La Serenisima`.',
  ].join('\n'),
};

const MENU_SCOPES = new Set(['main', 'ledger', 'bets', 'event', 'config']);
const GUIDED_ALLOWED_CALLBACKS = new Set([
  'menu:main',
  'menu:ledger',
  'qa:analyze_quotes',
  'qa:record_bet',
  'qa:settle_bet',
  'qa:list_pending',
  'qa:list_history',
  'qa:help',
  'qa:view_credits',
  'qa:topup_credits',
]);

const GUIDED_ALLOWED_CALLBACKS_MINIMAL = new Set([
  'menu:main',
  'qa:analyze_quotes',
  'qa:help',
  'qa:view_credits',
  'qa:topup_credits',
]);

const NUTRITION_GUIDED_ALLOWED_CALLBACKS = new Set([
  'menu:main',
  'qa:nutrition_log_intake',
  'qa:nutrition_log_weighin',
  'qa:nutrition_update_profile',
  'qa:nutrition_view_summary',
  'qa:nutrition_learning',
  'qa:help',
  'qa:view_credits',
  'qa:topup_credits',
]);

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toPositiveInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number(fallback) || 0;
  }
  return Math.round(parsed);
}

export function normalizeGuidedMenuId(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (GUIDED_MENU_IDS.has(normalized)) {
    if (normalized === 'default' || normalized === 'ufc_default') {
      return 'ufc_v1';
    }
    return normalized;
  }
  return 'ufc_v1';
}

function getDefaultGuidedAction({ guidedMenuId = 'ufc_v1', guidedLedgerEnabled = true } = {}) {
  if (normalizeGuidedMenuId(guidedMenuId) === 'nutrition_v1') {
    return 'log_intake';
  }
  if (!guidedLedgerEnabled) {
    return 'analyze_quotes';
  }
  return 'analyze_quotes';
}

export function normalizeInteractionMode(mode = '') {
  const normalized = String(mode || '').trim().toLowerCase();
  return INTERACTION_MODES.has(normalized) ? normalized : 'guided_strict';
}

export function isGuidedStrictInteractionMode(mode = '') {
  return normalizeInteractionMode(mode) === 'guided_strict';
}

export function normalizeGuidedAction(action = '', { defaultAction = 'analyze_quotes' } = {}) {
  const normalized = String(action || '').trim().toLowerCase();
  return GUIDED_INPUT_ACTIONS.has(normalized) ? normalized : defaultAction;
}

export function isGuidedCallbackAllowed(
  callbackData = '',
  { ledgerEnabled = true, guidedMenuId = 'ufc_v1' } = {}
) {
  const value = String(callbackData || '').trim();
  const menuId = normalizeGuidedMenuId(guidedMenuId);
  let allowed = ledgerEnabled ? GUIDED_ALLOWED_CALLBACKS : GUIDED_ALLOWED_CALLBACKS_MINIMAL;
  if (menuId === 'nutrition_v1') {
    allowed = NUTRITION_GUIDED_ALLOWED_CALLBACKS;
  }
  if (allowed.has(value)) {
    return true;
  }
  if (/^qa:nutrition_goal:[a-z_]+$/.test(value)) return true;
  if (/^qa:nutrition_tutorial:[a-z0-9_]+$/.test(value)) return true;
  return /^qa:topup_pack:\d+$/i.test(value);
}

export function looksLikeStructuredOddsText(message = '') {
  const text = normalizeText(message);
  if (!text) return false;

  if (/@\s*\d+([.,]\d+)?/.test(text)) {
    return true;
  }

  const hasMarketKeyword =
    /\b(cuota|cuotas|odds?|quote|quotes|moneyline|ml|over|under|totales?|props?|linea|lineas)\b/.test(
      text
    );
  const hasNumericSignal =
    /\b\d+([.,]\d+)?\b/.test(text) || /\b(o|u)\s*\d+([.,]\d+)?\b/.test(text);

  if (hasMarketKeyword && hasNumericSignal) {
    return true;
  }

  const hasFightContext = /\b(vs|versus|evento|pelea|fight)\b/.test(text);
  if (hasFightContext && hasNumericSignal && /\b(stake|u|units?|bookie)\b/.test(text)) {
    return true;
  }

  return false;
}

export function resolveGuidedMessageDecision({
  cleanMessage = '',
  hasMedia = false,
  allowTextFallback = GUIDED_QUOTES_TEXT_FALLBACK,
  activeGuidedAction = 'analyze_quotes',
  guidedMenuId = 'ufc_v1',
} = {}) {
  const menuId = normalizeGuidedMenuId(guidedMenuId);
  if (menuId === 'nutrition_v1') {
    return resolveNutritionGuidedMessageDecision({
      cleanMessage,
      hasMedia,
      activeGuidedAction,
    });
  }

  const guidedAction = normalizeGuidedAction(activeGuidedAction, {
    defaultAction: 'analyze_quotes',
  });
  if (hasMedia) {
    return {
      action: 'route',
      guidedAction,
      inputType: 'image',
    };
  }

  if (allowTextFallback) {
    if (looksLikeStructuredBetSettleText(cleanMessage)) {
      return {
        action: 'route',
        guidedAction: 'settle_bet',
        inputType: 'text_bet_settle',
      };
    }

    if (looksLikeStructuredBetRecordText(cleanMessage)) {
      return {
        action: 'route',
        guidedAction: 'record_bet',
        inputType: 'text_bet_record',
      };
    }

    if (looksLikeStructuredOddsText(cleanMessage)) {
      return {
        action: 'route',
        guidedAction: 'analyze_quotes',
        inputType: 'text_odds',
      };
    }
  }

  return {
    action: 'block',
    guidedAction: null,
    inputType: null,
  };
}

function looksLikeStructuredWeighinText(message = '') {
  const text = normalizeText(message);
  if (!text) return false;

  const hasWeightKeyword = /\b(peso|kg|kilo|kilos)\b/.test(text);
  const hasWeightValue = /\b\d{2,3}([.,]\d{1,2})?\b/.test(text);
  return hasWeightKeyword && hasWeightValue;
}

function resolveNutritionGuidedMessageDecision({
  cleanMessage = '',
  hasMedia = false,
  activeGuidedAction = 'log_intake',
} = {}) {
  const guidedAction = normalizeGuidedAction(activeGuidedAction, {
    defaultAction: 'log_intake',
  });
  const normalizedText = normalizeText(cleanMessage);

  if (guidedAction === 'learning_chat') {
    if (hasMedia) {
      return {
        action: 'route',
        guidedAction: 'learning_chat',
        inputType: 'image_learning',
      };
    }
    if (normalizedText) {
      return {
        action: 'route',
        guidedAction: 'learning_chat',
        inputType: 'text_freechat',
      };
    }
    return { action: 'block', guidedAction: null, inputType: null };
  }

  if (guidedAction === 'log_weighin') {
    if (hasMedia) {
      return {
        action: 'route',
        guidedAction: 'log_weighin',
        inputType: 'image_weighin',
      };
    }
    if (looksLikeStructuredWeighinText(cleanMessage)) {
      return {
        action: 'route',
        guidedAction: 'log_weighin',
        inputType: 'text_weighin',
      };
    }
    return { action: 'block', guidedAction: null, inputType: null };
  }

  if (guidedAction === 'update_profile') {
    if (normalizedText && !hasMedia) {
      return {
        action: 'route',
        guidedAction: 'update_profile',
        inputType: 'text_profile',
      };
    }
    return { action: 'block', guidedAction: null, inputType: null };
  }

  if (guidedAction === 'view_summary') {
    if (
      normalizedText &&
      /\b(resumen|summary|rolling|promedio|hoy|como vengo|cómo vengo)\b/.test(normalizedText)
    ) {
      return {
        action: 'route',
        guidedAction: 'view_summary',
        inputType: 'text_summary_request',
      };
    }
    return { action: 'block', guidedAction: null, inputType: null };
  }

  if (hasMedia) {
    return {
      action: 'route',
      guidedAction: 'log_intake',
      inputType: 'image_intake',
    };
  }

  if (normalizedText) {
    return {
      action: 'route',
      guidedAction: 'log_intake',
      inputType: 'text_intake',
    };
  }

  return { action: 'block', guidedAction: null, inputType: null };
}

function looksLikeStructuredBetRecordText(message = '') {
  const text = normalizeText(message);
  if (!text) return false;

  const hasOdds = /@\s*\d+([.,]\d+)?/.test(text);
  const hasStake =
    /\b(stake|u|units?|unidades?)\b/.test(text) ||
    /\$\s*\d+/.test(text) ||
    /\b\d+\s*(ars|usd)\b/.test(text);
  const hasFight = /\b(vs|versus|pelea|fight)\b/.test(text);
  const hasPickContext = /\b(ml|moneyline|over|under|pick|metodo|method|ko|tko|submission)\b/.test(
    text
  );

  return hasOdds && hasStake && (hasFight || hasPickContext);
}

function looksLikeStructuredBetSettleText(message = '') {
  const text = normalizeText(message);
  if (!text) return false;

  const hasBetId = /\bbet[_\s-]?id\b[^0-9]{0,4}\d+/.test(text) || /\b#\d+\b/.test(text);
  const hasResult = /\b(won|lost|push|win|loss|ganad|perdid|nula|void|pendiente|pending)\b/.test(
    text
  );
  if (hasBetId && hasResult) {
    return true;
  }

  const hasCloseVerb = /\b(cerrar|cerra|settle|marcar|actualizar)\b/.test(text);
  return hasCloseVerb && hasResult;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseTopupPacks(raw = '') {
  const map = new Map();
  const entries = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [creditsRaw, amountRaw] = entry.split(':').map((part) => String(part || '').trim());
    const credits = parsePositiveNumber(creditsRaw);
    const amount = parsePositiveNumber(amountRaw);
    if (!credits || !amount) continue;
    map.set(credits, amount);
  }
  return [...map.entries()]
    .map(([credits, amount]) => ({ credits, amount }))
    .sort((a, b) => a.credits - b.credits);
}

const TOPUP_PACKS_LIST = parseTopupPacks(MP_TOPUP_PACKS);

function formatArs(value = 0) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(Number(value) || 0);
  } catch {
    const rounded = Math.round(Number(value) || 0);
    return `$${rounded.toLocaleString('es-AR')}`;
  }
}

function normalizeMenuScope(scope = 'main') {
  const normalized = String(scope || '').trim().toLowerCase();
  return MENU_SCOPES.has(normalized) ? normalized : 'main';
}

function normalizeBaseUrl(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function stripFixedTopupPack(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('credits');
    parsed.searchParams.delete('pack');
    return parsed.toString();
  } catch {
    return value
      .replace(/([?&])(credits|pack)=[^&]*(&)?/gi, (_, sep, __, tail) => {
        if (sep === '?' && tail) return '?';
        if (sep === '&' && tail) return '&';
        return '';
      })
      .replace(/[?&]$/, '');
  }
}

function withQueryParam(rawUrl = '', key = '', value = '') {
  const normalizedUrl = String(rawUrl || '').trim();
  const normalizedKey = String(key || '').trim();
  if (!normalizedUrl || !normalizedKey) return normalizedUrl;
  try {
    const parsed = new URL(normalizedUrl);
    parsed.searchParams.set(normalizedKey, String(value || ''));
    return parsed.toString();
  } catch {
    const delimiter = normalizedUrl.includes('?') ? '&' : '?';
    return `${normalizedUrl}${delimiter}${normalizedKey}=${encodeURIComponent(String(value || ''))}`;
  }
}

function resolveTopupUrlForUser(userId = '', { credits = null } = {}) {
  const safeUserId = encodeURIComponent(String(userId || '').trim());
  const normalizedCredits = parsePositiveNumber(credits);
  const appBase = normalizeBaseUrl(APP_PUBLIC_URL);
  if (appBase) {
    let directUrl = safeUserId
      ? `${appBase}/topup/checkout?user_id=${safeUserId}`
      : `${appBase}/topup/checkout`;
    if (normalizedCredits) {
      directUrl = withQueryParam(directUrl, 'credits', normalizedCredits);
    }
    return directUrl;
  }

  const fromEnv = stripFixedTopupPack(CREDIT_TOPUP_URL);
  if (fromEnv) {
    if (!safeUserId) return fromEnv;
    const withUser = fromEnv
      .replaceAll('{user_id}', safeUserId)
      .replaceAll('{telegram_user_id}', safeUserId);
    const baseUrl =
      withUser !== fromEnv ? withUser : withQueryParam(fromEnv, 'user_id', safeUserId);
    if (normalizedCredits) {
      return withQueryParam(baseUrl, 'credits', normalizedCredits);
    }
    return baseUrl;
  }

  return '';
}

function buildTopupPacksHintLines() {
  if (!TOPUP_PACKS_LIST.length) {
    return [];
  }
  const lines = ['Equivalencias de recarga:'];
  for (const pack of TOPUP_PACKS_LIST) {
    lines.push(`- ${pack.credits} creditos = ${formatArs(pack.amount)}`);
  }
  return lines;
}

function hasTopupCopy(text = '') {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return false;
  return (
    value.includes('packs de recarga') ||
    value.includes('equivalencias de recarga') ||
    value.includes('link para elegir pack') ||
    value.includes('recarga (elegis pack)') ||
    value.includes('/topup/checkout')
  );
}

function buildTopupPackButtons() {
  if (!TOPUP_PACKS_LIST.length) {
    return [];
  }
  return TOPUP_PACKS_LIST.map((pack) => [
    {
      text: `${pack.credits} cr • ${formatArs(pack.amount)}`,
      callback_data: `qa:topup_pack:${pack.credits}`,
    },
  ]);
}

function buildCreditsQuickActionRows({
  guidedMenuId = 'ufc_v1',
  guidedLedgerEnabled = true,
} = {}) {
  if (normalizeGuidedMenuId(guidedMenuId) === 'nutrition_v1') {
    return [
      [
        { text: '🍽 Ingesta', callback_data: 'qa:nutrition_log_intake' },
        { text: '📊 Resumen', callback_data: 'qa:nutrition_view_summary' },
      ],
      [{ text: '🎓 Aprendizaje', callback_data: 'qa:nutrition_learning' }],
    ];
  }

  return guidedLedgerEnabled
    ? [
        [
          { text: '📸 Analizar cuotas', callback_data: 'qa:analyze_quotes' },
          { text: '🧾 Ledger', callback_data: 'menu:ledger' },
        ],
      ]
    : [[{ text: '📸 Analizar', callback_data: 'qa:analyze_quotes' }]];
}

function resolveGuidedBlockHintByAction(guidedAction = '', { guidedMenuId = 'ufc_v1' } = {}) {
  const menuId = normalizeGuidedMenuId(guidedMenuId);
  if (menuId === 'nutrition_v1') {
    const action = normalizeGuidedAction(guidedAction, { defaultAction: 'log_intake' });
    if (action === 'log_weighin') {
      return QUICK_ACTION_HINTS.nutrition_reencauce_weighin;
    }
    if (action === 'update_profile') {
      return QUICK_ACTION_HINTS.nutrition_reencauce_profile;
    }
    if (action === 'view_summary') {
      return QUICK_ACTION_HINTS.nutrition_view_summary;
    }
    if (action === 'learning_chat') {
      return QUICK_ACTION_HINTS.nutrition_learning;
    }
    return QUICK_ACTION_HINTS.nutrition_reencauce_intake;
  }

  const action = normalizeGuidedAction(guidedAction, {
    defaultAction: 'analyze_quotes',
  });
  if (action === 'record_bet') {
    return QUICK_ACTION_HINTS.guided_reencauce_record_bet;
  }
  if (action === 'settle_bet') {
    return QUICK_ACTION_HINTS.guided_reencauce_settle_bet;
  }
  return QUICK_ACTION_HINTS.guided_reencauce;
}

function guidedMenuScopeForAction(guidedAction = '', { guidedMenuId = 'ufc_v1' } = {}) {
  if (normalizeGuidedMenuId(guidedMenuId) === 'nutrition_v1') {
    return 'main';
  }
  const action = normalizeGuidedAction(guidedAction, {
    defaultAction: 'analyze_quotes',
  });
  return action === 'record_bet' || action === 'settle_bet' ? 'ledger' : 'main';
}

function pickLargestPhoto(photos = []) {
  if (!photos.length) {
    return null;
  }

  return photos.reduce((largest, current) => {
    if (!largest) {
      return current;
    }
    const largestSize = largest.file_size ?? 0;
    const currentSize = current.file_size ?? 0;
    return currentSize > largestSize ? current : largest;
  }, null);
}

function fileExtension(filePath = '') {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return ext || '';
}

function guessImageMime(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function downloadTelegramFile(bot, token, fileId) {
  const file = await bot.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error('Telegram file_path missing.');
  }

  if (file.file_size && file.file_size > MAX_MEDIA_BYTES) {
    throw new Error('Archivo demasiado grande para procesar.');
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No pude descargar el archivo (${response.status}).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Archivo demasiado grande para procesar.');
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    filePath,
  };
}

async function convertAudioToMp3(buffer, inputExt = 'ogg') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufc-audio-'));
  const inputPath = path.join(tempDir, `input.${inputExt || 'ogg'}`);
  const outputPath = path.join(tempDir, 'output.mp3');

  try {
    await fs.writeFile(inputPath, buffer);
    await execFileAsync(FFMPEG_BINARY, ['-y', '-i', inputPath, outputPath]);
    const outBuffer = await fs.readFile(outputPath);
    return outBuffer;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildImageInput(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return {
    type: 'input_image',
    image_url: `data:${mimeType};base64,${base64}`,
    detail: 'auto',
  };
}

function buildAudioInput(buffer, format = 'mp3') {
  return {
    type: 'input_audio',
    input_audio: {
      data: buffer.toString('base64'),
      format,
    },
  };
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no esta configurada para transcribir audio.');
  }
  return new OpenAI({ apiKey });
}

async function transcribeAudio(buffer, filename = 'audio.mp3') {
  const client = getOpenAIClient();
  const file = await toFile(buffer, filename);
  const response = await client.audio.transcriptions.create({
    model: AUDIO_TRANSCRIBE_MODEL,
    file,
  });

  const text = typeof response === 'string' ? response : response?.text;
  if (!text) {
    throw new Error('Transcripcion vacia.');
  }

  return text.slice(0, MAX_AUDIO_TRANSCRIPT_CHARS);
}

export function startTelegramBot(router, options = {}) {
  const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
  const bot = options.botInstance || new TelegramBot(token, { polling: true });
  const interactionMode = normalizeInteractionMode(
    options.interactionMode || TELEGRAM_INTERACTION_MODE
  );
  const guidedMenuId = normalizeGuidedMenuId(
    options.guidedMenuId || options.domainGuidedMenu || 'ufc_v1'
  );
  const guidedLedgerEnabled = options.guidedLedgerEnabled !== false;
  const guidedQuotesTextFallback =
    typeof options.guidedQuotesTextFallback === 'boolean'
      ? options.guidedQuotesTextFallback
      : GUIDED_QUOTES_TEXT_FALLBACK;
  const callbackDedupWindowMs = toPositiveInt(
    options.callbackDedupWindowMs ??
      process.env.TELEGRAM_CALLBACK_DEDUP_WINDOW_MS ??
      CALLBACK_DEDUP_WINDOW_MS,
    CALLBACK_DEDUP_WINDOW_MS
  );
  const callbackDedupMaxKeysPerChat = toPositiveInt(
    options.callbackDedupMaxKeysPerChat ??
      process.env.TELEGRAM_CALLBACK_DEDUP_MAX_KEYS_PER_CHAT ??
      CALLBACK_DEDUP_MAX_KEYS_PER_CHAT,
    CALLBACK_DEDUP_MAX_KEYS_PER_CHAT
  );
  const nowProvider = typeof options.nowProvider === 'function' ? options.nowProvider : Date.now;
  const defaultGuidedAction = getDefaultGuidedAction({
    guidedMenuId,
    guidedLedgerEnabled,
  });
  const downloadFile = options.downloadFileImpl || downloadTelegramFile;
  const transcribeAudioImpl = options.transcribeAudioImpl || transcribeAudio;
  const convertAudioToMp3Impl = options.convertAudioToMp3Impl || convertAudioToMp3;
  const pendingMediaGroups = new Map();
  const inFlightByChat = new Set();
  const menuScopeByChat = new Map();
  const guidedActionByChat = new Map();
  const recentCallbacksByChat = new Map();

  function getMenuScope(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return 'main';
    return normalizeMenuScope(menuScopeByChat.get(key) || 'main');
  }

  function setMenuScope(chatId, scope = 'main') {
    const key = String(chatId || '').trim();
    if (!key) return 'main';
    const normalized = normalizeMenuScope(scope);
    menuScopeByChat.set(key, normalized);
    return normalized;
  }

  function getGuidedAction(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return defaultGuidedAction;
    const current = normalizeGuidedAction(guidedActionByChat.get(key) || defaultGuidedAction, {
      defaultAction: defaultGuidedAction,
    });
    if (
      !guidedLedgerEnabled &&
      (current === 'record_bet' || current === 'settle_bet')
    ) {
      return defaultGuidedAction;
    }
    return current;
  }

  function setGuidedAction(chatId, action = defaultGuidedAction) {
    const key = String(chatId || '').trim();
    if (!key) return defaultGuidedAction;
    let normalized = normalizeGuidedAction(action, {
      defaultAction: defaultGuidedAction,
    });
    if (
      !guidedLedgerEnabled &&
      (normalized === 'record_bet' || normalized === 'settle_bet')
    ) {
      normalized = defaultGuidedAction;
    }
    guidedActionByChat.set(key, normalized);
    return normalized;
  }

  function buildCallbackDedupKey({ data = '', messageId = '', userId = '' } = {}) {
    return `${String(userId || '').trim()}|${String(messageId || '').trim()}|${String(data || '').trim()}`;
  }

  function shouldSkipDuplicateCallback({
    chatId = '',
    data = '',
    messageId = '',
    userId = '',
  } = {}) {
    if (!callbackDedupWindowMs) {
      return false;
    }
    const key = buildCallbackDedupKey({ data, messageId, userId });
    if (!key) return false;

    const chatKey = String(chatId || '').trim();
    if (!chatKey) return false;

    const nowMs = Number(nowProvider()) || Date.now();
    let seen = recentCallbacksByChat.get(chatKey);
    if (!seen) {
      seen = new Map();
      recentCallbacksByChat.set(chatKey, seen);
    }

    for (const [existingKey, seenAt] of seen.entries()) {
      if (nowMs - seenAt > callbackDedupWindowMs) {
        seen.delete(existingKey);
      }
    }

    const lastSeenAt = seen.get(key);
    if (Number.isFinite(lastSeenAt) && nowMs - lastSeenAt <= callbackDedupWindowMs) {
      seen.set(key, nowMs);
      return true;
    }

    seen.set(key, nowMs);
    if (seen.size > callbackDedupMaxKeysPerChat) {
      const overflow = seen.size - callbackDedupMaxKeysPerChat;
      let dropped = 0;
      for (const existingKey of seen.keys()) {
        seen.delete(existingKey);
        dropped += 1;
        if (dropped >= overflow) break;
      }
    }

    return false;
  }

  function buildQuickActionsMarkup(scope = 'main') {
    if (isGuidedStrictInteractionMode(interactionMode)) {
      if (guidedMenuId === 'nutrition_v1') {
        return {
          inline_keyboard: NUTRITION_GUIDED_MAIN_MENU_ROWS,
        };
      }
      if (scope === 'ledger' && guidedLedgerEnabled) {
        return {
          inline_keyboard: GUIDED_LEDGER_MENU_ROWS,
        };
      }
      return {
        inline_keyboard: guidedLedgerEnabled
          ? GUIDED_MAIN_MENU_ROWS
          : GUIDED_MAIN_MENU_ROWS_MINIMAL,
      };
    }

    if (scope === 'bets') {
      return {
        inline_keyboard: BETS_MENU_ROWS,
      };
    }
    if (scope === 'event') {
      return {
        inline_keyboard: EVENT_MENU_ROWS,
      };
    }
    if (scope === 'config') {
      return {
        inline_keyboard: CONFIG_MENU_ROWS,
      };
    }
    return {
      inline_keyboard: MAIN_MENU_ROWS,
    };
  }


  async function sendBotMessage(
    chatId,
    text,
    { menuScope = null, replyMarkupOverride = null } = {}
  ) {
    const rawText = String(text || '');
    const htmlText = toTelegramHtml(rawText);
    const plainText = toTelegramPlainText(rawText);
    const resolvedScope =
      menuScope === null || menuScope === undefined
        ? getMenuScope(chatId)
        : setMenuScope(chatId, menuScope);
    const replyMarkup = replyMarkupOverride || buildQuickActionsMarkup(resolvedScope);

    try {
      return await bot.sendMessage(chatId, htmlText || plainText || ' ', {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    } catch (error) {
      console.error('⚠️ Telegram parse_mode HTML failed, fallback to plain text:', error);
      return bot.sendMessage(chatId, plainText || rawText || ' ', {
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    }
  }

  async function routeSyntheticAction(query, syntheticMessage = '', metadata = {}) {
    const sourceMsg = query?.message;
    if (!sourceMsg) {
      return null;
    }

    const chatId = sourceMsg.chat?.id;
    if (!chatId || !syntheticMessage) {
      return null;
    }

    return router.routeMessage({
      chatId: String(chatId),
      message: syntheticMessage,
      interactionMode,
      guidedAction: metadata.guidedAction || null,
      inputType: metadata.inputType || null,
      user: {
        id: query?.from?.id ? String(query.from.id) : null,
        username: query?.from?.username || null,
        firstName: query?.from?.first_name || null,
        lastName: query?.from?.last_name || null,
      },
      chat: {
        id: sourceMsg.chat?.id ? String(sourceMsg.chat.id) : null,
        type: sourceMsg.chat?.type || null,
        title: sourceMsg.chat?.title || null,
      },
      originalAction: query?.data || null,
    });
  }

  async function sendMenu(chatId, scope = 'main') {
    if (isGuidedStrictInteractionMode(interactionMode)) {
      if (guidedMenuId === 'nutrition_v1') {
        return sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_welcome, { menuScope: 'main' });
      }
      if (scope === 'ledger' && guidedLedgerEnabled) {
        return sendBotMessage(chatId, '🧾 Menu Ledger (modo guiado)', {
          menuScope: 'ledger',
        });
      }
      return sendBotMessage(
        chatId,
        guidedLedgerEnabled
          ? QUICK_ACTION_HINTS.guided_welcome
          : QUICK_ACTION_HINTS.guided_welcome_minimal,
        { menuScope: 'main' }
      );
    }

    if (scope === 'bets') {
      return sendBotMessage(chatId, '📚 Menu Apuestas', { menuScope: 'bets' });
    }
    if (scope === 'event') {
      return sendBotMessage(chatId, '🧠 Menu Evento', { menuScope: 'event' });
    }
    if (scope === 'config') {
      return sendBotMessage(chatId, '⚙️ Menu Config', { menuScope: 'config' });
    }
    return sendBotMessage(chatId, 'Menu principal', { menuScope: 'main' });
  }

  async function deliverToRouter({
    msg,
    userMessage,
    inputItems,
    mediaStats,
    isAlbum = false,
    guidedAction = null,
    guidedInputType = null,
  } = {}) {
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const chatInfo = msg.chat || {};

    const cleanMessage = String(userMessage || '').trim();
    const hasMedia = Array.isArray(inputItems) && inputItems.length > 0;

    if (inFlightByChat.has(chatId)) {
      await sendBotMessage(
        chatId,
        '⏳ Estoy respondiendo tu mensaje anterior. Esperá mi respuesta y seguimos.'
      );
      return;
    }

    if (!cleanMessage && !hasMedia) {
      await sendBotMessage(
        chatId,
        'Por ahora puedo procesar texto, imagen o audio. Si queres, mandame tu consulta por mensaje o adjunta un archivo.'
      );
      return;
    }

    console.log(
      `📩 Mensaje recibido${isAlbum ? ' (album)' : ''}: ${cleanMessage || '[sin texto]'}`
    );

    inFlightByChat.add(chatId);
    let typingTimer = null;
    try {
      await bot.sendChatAction(chatId, 'typing');
      typingTimer = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, TYPING_ACTION_INTERVAL_MS);

      const reply = await router.routeMessage({
        chatId: String(chatId),
        message: cleanMessage,
        telegramMessageId: msg.message_id,
        inputItems,
        mediaStats,
        interactionMode,
        guidedAction,
        inputType: guidedInputType,
        guidedInputType,
        user: {
          id: from.id ? String(from.id) : null,
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
        },
        chat: {
          id: chatInfo.id ? String(chatInfo.id) : null,
          type: chatInfo.type || null,
          title: chatInfo.title || null,
        },
      });

      if (reply && typeof reply === 'object' && reply.text) {
        await sendBotMessage(chatId, reply.text, { replyMarkupOverride: reply.replyMarkup || null });
      } else {
        await sendBotMessage(chatId, reply || 'No tengo respuesta para eso aún 😅');
      }
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      inFlightByChat.delete(chatId);
    }
  }

  async function processSingleMessage(msg) {
    const chatId = msg.chat.id;
    let userMessage = msg.text || msg.caption || '';

    const inputItems = [];
    const mediaStats = { imageCount: 0, audioSeconds: 0 };

    try {
      if (Array.isArray(msg.photo) && msg.photo.length) {
        const bestPhoto = pickLargestPhoto(msg.photo);
        if (bestPhoto?.file_id) {
          const { buffer, filePath } = await downloadFile(bot, token, bestPhoto.file_id);
          const ext = fileExtension(filePath) || 'jpg';
          const mimeType = guessImageMime(ext);
          inputItems.push(buildImageInput(buffer, mimeType));
          mediaStats.imageCount += 1;
        }
      }

      const audioFile = msg.voice || msg.audio;
      if (audioFile?.file_id) {
        const { buffer, filePath } = await downloadFile(bot, token, audioFile.file_id);
        const ext = fileExtension(filePath);
        const audioBuffer =
          ext === 'mp3' || ext === 'wav'
            ? buffer
            : await convertAudioToMp3Impl(buffer, ext || 'ogg');

        const transcript = await transcribeAudioImpl(
          audioBuffer,
          `audio.${ext === 'wav' ? 'wav' : 'mp3'}`
        );
        if (transcript) {
          const transcriptBlock = `[TRANSCRIPCION_AUDIO]\\n${transcript}`;
          userMessage = userMessage.trim()
            ? `${userMessage}\\n\\n${transcriptBlock}`
            : transcriptBlock;
        }
        if (audioFile.duration) {
          mediaStats.audioSeconds = Number(audioFile.duration) || 0;
        }
      }
    } catch (error) {
      console.error('❌ Error procesando media:', error);
      await sendBotMessage(
        chatId,
        'No pude procesar el archivo multimedia. Si es audio, asegurate de que pueda convertirlo a mp3/wav (requiere ffmpeg).'
      );
      return;
    }

    const cleanMessage = String(userMessage || '').trim();
    if (/^\/start\b/i.test(cleanMessage)) {
      if (isGuidedStrictInteractionMode(interactionMode)) {
        setGuidedAction(chatId, defaultGuidedAction);
      }
      await sendMenu(chatId, 'main');
      if (isGuidedStrictInteractionMode(interactionMode)) {
        await sendBotMessage(
          chatId,
          guidedMenuId === 'nutrition_v1'
            ? QUICK_ACTION_HINTS.nutrition_log_intake
            : QUICK_ACTION_HINTS.analyze_quotes,
          { menuScope: 'main' }
        );
      }
      return;
    }

    if (/^\/help\b/i.test(cleanMessage)) {
      const helpText = isGuidedStrictInteractionMode(interactionMode)
        ? guidedMenuId === 'nutrition_v1'
          ? QUICK_ACTION_HINTS.nutrition_help_guided
          : QUICK_ACTION_HINTS.help_guided
        : QUICK_ACTION_HINTS.help;
      await sendBotMessage(chatId, helpText, { menuScope: 'main' });
      return;
    }

    if (isGuidedStrictInteractionMode(interactionMode)) {
      const activeGuidedAction = getGuidedAction(chatId);
      const decision = resolveGuidedMessageDecision({
        cleanMessage,
        hasMedia: inputItems.length > 0,
        allowTextFallback: guidedQuotesTextFallback,
        activeGuidedAction,
        guidedMenuId,
      });

      if (decision.action !== 'route') {
        await sendBotMessage(
          chatId,
          resolveGuidedBlockHintByAction(activeGuidedAction, { guidedMenuId }),
          {
            menuScope: guidedMenuScopeForAction(activeGuidedAction, { guidedMenuId }),
          }
        );
        return;
      }

      if (guidedMenuId === 'nutrition_v1' && decision.guidedAction) {
        setGuidedAction(chatId, decision.guidedAction);
      }

      await deliverToRouter({
        msg,
        userMessage,
        inputItems,
        mediaStats,
        guidedAction: decision.guidedAction,
        guidedInputType: decision.inputType,
      });
      return;
    }

    await deliverToRouter({ msg, userMessage, inputItems, mediaStats });
  }

  function enqueueMediaGroup(msg) {
    const groupId = msg.media_group_id;
    if (!groupId) return;

    const entry = pendingMediaGroups.get(groupId) || { messages: [], timer: null };
    entry.messages.push(msg);

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    entry.timer = setTimeout(() => {
      flushMediaGroup(groupId).catch((error) => {
        console.error('❌ Error procesando album:', error);
      });
    }, MEDIA_GROUP_FLUSH_MS);

    pendingMediaGroups.set(groupId, entry);
  }

  async function flushMediaGroup(groupId) {
    const entry = pendingMediaGroups.get(groupId);
    if (!entry) return;
    pendingMediaGroups.delete(groupId);

    const messages = entry.messages || [];
    if (!messages.length) return;

    const first = messages[0];
    const chatId = first.chat.id;
    const inputItems = [];
    const textParts = [];
    const mediaStats = { imageCount: 0, audioSeconds: 0 };

    for (const msg of messages) {
      const text = String(msg.caption || msg.text || '').trim();
      if (text) {
        textParts.push(text);
      }
    }

    const uniqueText = textParts.filter((value, index, arr) => arr.indexOf(value) === index);
    const userMessage = uniqueText.join('\n\n');

    try {
      for (const msg of messages) {
        if (!Array.isArray(msg.photo) || !msg.photo.length) {
          continue;
        }
        const bestPhoto = pickLargestPhoto(msg.photo);
        if (!bestPhoto?.file_id) continue;
        const { buffer, filePath } = await downloadFile(bot, token, bestPhoto.file_id);
        const ext = fileExtension(filePath) || 'jpg';
        const mimeType = guessImageMime(ext);
        inputItems.push(buildImageInput(buffer, mimeType));
        mediaStats.imageCount += 1;
      }
    } catch (error) {
      console.error('❌ Error procesando album:', error);
      await sendBotMessage(
        chatId,
        'No pude procesar todas las fotos del album. Probá reenviarlas o mandar menos imágenes.'
      );
      return;
    }

    if (isGuidedStrictInteractionMode(interactionMode)) {
      const activeGuidedAction = getGuidedAction(chatId);
      const decision = resolveGuidedMessageDecision({
        cleanMessage: userMessage,
        hasMedia: inputItems.length > 0,
        allowTextFallback: guidedQuotesTextFallback,
        activeGuidedAction,
        guidedMenuId,
      });

      if (decision.action !== 'route') {
        await sendBotMessage(
          chatId,
          resolveGuidedBlockHintByAction(activeGuidedAction, { guidedMenuId }),
          {
            menuScope: guidedMenuScopeForAction(activeGuidedAction, { guidedMenuId }),
          }
        );
        return;
      }

      if (guidedMenuId === 'nutrition_v1' && decision.guidedAction) {
        setGuidedAction(chatId, decision.guidedAction);
      }

      await deliverToRouter({
        msg: first,
        userMessage,
        inputItems,
        mediaStats,
        isAlbum: true,
        guidedAction: decision.guidedAction,
        guidedInputType: decision.inputType,
      });
      return;
    }

    await deliverToRouter({
      msg: first,
      userMessage,
      inputItems,
      mediaStats,
      isAlbum: true,
    });
  }

  bot.on('message', async (msg) => {
    if (msg.media_group_id && Array.isArray(msg.photo) && msg.photo.length) {
      enqueueMediaGroup(msg);
      return;
    }

    await processSingleMessage(msg);
  });

  bot.on('callback_query', async (query) => {
    const data = String(query?.data || '');
    const chatId = query?.message?.chat?.id;
    if (!chatId) {
      return;
    }
    const safeUserId = query?.from?.id ? String(query.from.id) : '';

    if (
      shouldSkipDuplicateCallback({
        chatId,
        data,
        messageId: query?.message?.message_id,
        userId: safeUserId,
      })
    ) {
      try {
        await bot.answerCallbackQuery(query.id);
      } catch (error) {
        console.error('⚠️ Error respondiendo callback duplicado:', error);
      }
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('⚠️ Error respondiendo callback_query:', error);
    }

    if (isGuidedStrictInteractionMode(interactionMode)) {
      if (
        !isGuidedCallbackAllowed(data, {
          ledgerEnabled: guidedLedgerEnabled,
          guidedMenuId,
        })
      ) {
        await sendBotMessage(chatId, 'Esa accion no esta disponible en modo guiado.', {
          menuScope: 'main',
        });
        return;
      }

      if (data === 'menu:main') {
        setGuidedAction(chatId, defaultGuidedAction);
        await sendMenu(chatId, 'main');
        return;
      }

      if (guidedMenuId === 'nutrition_v1') {
        if (data === 'qa:nutrition_log_intake') {
          setGuidedAction(chatId, 'log_intake');
          await sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_log_intake, { menuScope: 'main' });
          return;
        }

        if (data === 'qa:nutrition_log_weighin') {
          setGuidedAction(chatId, 'log_weighin');
          await sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_log_weighin, {
            menuScope: 'main',
          });
          return;
        }

        if (data === 'qa:nutrition_update_profile') {
          setGuidedAction(chatId, 'update_profile');
          await sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_update_profile, {
            menuScope: 'main',
          });
          return;
        }

        if (data === 'qa:nutrition_learning') {
          setGuidedAction(chatId, 'learning_chat');
          await sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_learning, {
            replyMarkupOverride: { inline_keyboard: NUTRITION_TUTORIAL_LEVEL_ROWS },
          });
          return;
        }

        if (data === 'qa:nutrition_view_summary') {
          setGuidedAction(chatId, 'view_summary');
          const routed = await routeSyntheticAction(
            query,
            'mostrame mi resumen nutricional de hoy con rolling 7d y 14d',
            { guidedAction: 'view_summary', inputType: 'synthetic' }
          );
          await sendBotMessage(chatId, routed || 'No pude calcular el resumen ahora mismo.', {
            menuScope: 'main',
          });
          return;
        }
      }

      if (data.startsWith('qa:nutrition_goal:') && guidedMenuId === 'nutrition_v1') {
        const slug = data.replace('qa:nutrition_goal:', '');
        const currentGuidedAction = getGuidedAction(chatId) || defaultGuidedAction;
        const routed = await routeSyntheticAction(query, `goal:${slug}`, {
          guidedAction: currentGuidedAction,
          inputType: 'text_intake',
        });
        if (routed && typeof routed === 'object' && routed.text) {
          await sendBotMessage(chatId, routed.text, { replyMarkupOverride: routed.replyMarkup || null });
        } else if (routed) {
          await sendBotMessage(chatId, routed, { menuScope: 'main' });
        }
        return;
      }

      if (data.startsWith('qa:nutrition_tutorial:') && guidedMenuId === 'nutrition_v1') {
        const slug = data.replace('qa:nutrition_tutorial:', '');
        setGuidedAction(chatId, 'learning_chat');

        // "Volver a niveles" — show level selector directly without LLM call
        if (slug === 'menu_niveles') {
          await sendBotMessage(chatId, QUICK_ACTION_HINTS.nutrition_learning, {
            replyMarkupOverride: { inline_keyboard: NUTRITION_TUTORIAL_LEVEL_ROWS },
          });
          return;
        }

        // Level submenus — show topic list with proper buttons
        if (slug === 'menu_basico') {
          await sendBotMessage(chatId, '📚 Tutoriales — Nivel Básico:', {
            replyMarkupOverride: { inline_keyboard: NUTRITION_TUTORIAL_BASICO_ROWS },
          });
          return;
        }
        if (slug === 'menu_intermedio') {
          await sendBotMessage(chatId, '📚 Tutoriales — Nivel Intermedio:', {
            replyMarkupOverride: { inline_keyboard: NUTRITION_TUTORIAL_INTERMEDIO_ROWS },
          });
          return;
        }
        if (slug === 'menu_avanzado') {
          await sendBotMessage(chatId, '📚 Tutoriales — Nivel Avanzado:', {
            replyMarkupOverride: { inline_keyboard: NUTRITION_TUTORIAL_AVANZADO_ROWS },
          });
          return;
        }

        // Actual tutorial content — route to learning_chat handler
        const tutorialReply = await routeSyntheticAction(query, `tutorial:${slug}`, {
          guidedAction: 'learning_chat',
          inputType: 'text_freechat',
        });
        if (tutorialReply) {
          await sendBotMessage(chatId, tutorialReply, { menuScope: 'main' });
        }
        return;
      }

      if (data === 'menu:ledger') {
        if (!guidedLedgerEnabled) {
          await sendMenu(chatId, 'main');
          return;
        }
        setGuidedAction(chatId, 'record_bet');
        await sendMenu(chatId, 'ledger');
        return;
      }

      if (data === 'qa:analyze_quotes') {
        setGuidedAction(chatId, 'analyze_quotes');
        await sendBotMessage(chatId, QUICK_ACTION_HINTS.analyze_quotes, { menuScope: 'main' });
        return;
      }

      if (data === 'qa:record_bet') {
        if (!guidedLedgerEnabled) {
          await sendBotMessage(chatId, 'Este bot no tiene ledger habilitado en modo guiado.', {
            menuScope: 'main',
          });
          return;
        }
        setGuidedAction(chatId, 'record_bet');
        await sendBotMessage(chatId, QUICK_ACTION_HINTS.record_bet, { menuScope: 'ledger' });
        return;
      }

      if (data === 'qa:settle_bet') {
        if (!guidedLedgerEnabled) {
          await sendBotMessage(chatId, 'Este bot no tiene ledger habilitado en modo guiado.', {
            menuScope: 'main',
          });
          return;
        }
        setGuidedAction(chatId, 'settle_bet');
        await sendBotMessage(chatId, QUICK_ACTION_HINTS.settle_bet, { menuScope: 'ledger' });
        return;
      }

      if (data === 'qa:list_pending') {
        if (!guidedLedgerEnabled) {
          await sendBotMessage(chatId, 'Este bot no tiene ledger habilitado en modo guiado.', {
            menuScope: 'main',
          });
          return;
        }
        setGuidedAction(chatId, 'settle_bet');
        const routed = await routeSyntheticAction(
          query,
          'mostrame mis apuestas pending del ledger con bet_id',
          { guidedAction: 'ledger_list_pending', inputType: 'synthetic' }
        );
        await sendBotMessage(chatId, routed || 'No pude consultar pendientes ahora mismo.', {
          menuScope: 'ledger',
        });
        return;
      }

      if (data === 'qa:list_history') {
        if (!guidedLedgerEnabled) {
          await sendBotMessage(chatId, 'Este bot no tiene ledger habilitado en modo guiado.', {
            menuScope: 'main',
          });
          return;
        }
        const routed = await routeSyntheticAction(
          query,
          'mostrame mi historial de apuestas del ledger',
          { guidedAction: 'ledger_list_history', inputType: 'synthetic' }
        );
        await sendBotMessage(chatId, routed || 'No pude consultar historial ahora mismo.', {
          menuScope: 'ledger',
        });
        return;
      }

      if (data === 'qa:help') {
        await sendBotMessage(
          chatId,
          guidedMenuId === 'nutrition_v1'
            ? QUICK_ACTION_HINTS.nutrition_help_guided
            : QUICK_ACTION_HINTS.help_guided,
          { menuScope: 'main' }
        );
        return;
      }

      if (data === 'qa:view_credits') {
        const routed = await routeSyntheticAction(
          query,
          'decime cuantos creditos tengo y mis ultimos movimientos',
          { guidedAction: 'view_credits', inputType: 'synthetic' }
        );
        const textParts = [routed || 'No pude consultar créditos ahora mismo.'];
        if (!hasTopupCopy(routed)) {
          const chooserUrl = resolveTopupUrlForUser(safeUserId);
          const topupHintLines = buildTopupPacksHintLines();
          if (topupHintLines.length) {
            textParts.push('', ...topupHintLines);
          }
          if (chooserUrl) {
            textParts.push('', `Link para elegir pack: ${chooserUrl}`);
          }
        }
        await sendBotMessage(chatId, textParts.join('\n'), {
          menuScope: 'main',
          replyMarkupOverride: {
            inline_keyboard: [
              ...buildTopupPackButtons(),
              [{ text: '💳 Cargar creditos', callback_data: 'qa:topup_credits' }],
              ...buildCreditsQuickActionRows({
                guidedMenuId,
                guidedLedgerEnabled,
              }),
            ],
          },
        });
        return;
      }

      if (data === 'qa:topup_credits') {
        const topupUrl = resolveTopupUrlForUser(safeUserId);
        if (topupUrl) {
          const lines = [
            '💳 Cargar créditos',
            'Abrí este link para elegir pack y pagar por Mercado Pago:',
            topupUrl,
          ];
          const packsHint = buildTopupPacksHintLines();
          if (packsHint.length) {
            lines.push('', ...packsHint);
          }
          lines.push('', 'Luego podés volver al botón `Creditos` para confirmar el saldo.');
          await sendBotMessage(
            chatId,
            lines.join('\n'),
            {
              menuScope: 'main',
              replyMarkupOverride: {
                inline_keyboard: [
                  ...buildTopupPackButtons(),
                  [{ text: '↩ Volver a Creditos', callback_data: 'qa:view_credits' }],
                ],
              },
            }
          );
        } else {
          await sendBotMessage(
            chatId,
            [
              '💳 Cargar créditos',
              'Todavía no tengo configurado el link de checkout en este entorno.',
              'Podés revisar tu saldo actual con `Creditos`.',
            ].join('\n'),
            { menuScope: 'main' }
          );
        }
        return;
      }

      if (/^qa:topup_pack:\d+$/i.test(data)) {
        const credits = Number(data.split(':').pop() || '0');
        const directTopupUrl = resolveTopupUrlForUser(safeUserId, { credits });
        if (!directTopupUrl) {
          await sendBotMessage(
            chatId,
            'No pude generar el link de checkout para ese pack en este entorno.',
            { menuScope: 'main' }
          );
          return;
        }
        await sendBotMessage(
          chatId,
          [
            `💳 Checkout pack ${credits} creditos`,
            'Abrí este link para pagar ese pack:',
            directTopupUrl,
          ].join('\n'),
          { menuScope: 'main' }
        );
        return;
      }
    }

    if (data === 'menu:main') {
      await sendMenu(chatId, 'main');
      return;
    }
    if (data === 'menu:bets') {
      await sendMenu(chatId, 'bets');
      return;
    }
    if (data === 'menu:event') {
      await sendMenu(chatId, 'event');
      return;
    }
    if (data === 'menu:config') {
      await sendMenu(chatId, 'config');
      return;
    }

    if (data === 'qa:analyze_quotes') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.analyze_quotes, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:analyze_fight') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.analyze_fight, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:help') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.help, { menuScope: getMenuScope(chatId) });
      return;
    }

    if (data === 'qa:topup_credits') {
      const topupUrl = resolveTopupUrlForUser(query?.from?.id ? String(query.from.id) : '');
      if (topupUrl) {
        await sendBotMessage(
          chatId,
          [
            '💳 Cargar créditos',
            'Abrí este link para ver packs y pagar por Mercado Pago:',
            topupUrl,
            '',
            'Si querés, después te muestro tus créditos y movimientos.',
          ].join('\n'),
          { menuScope: 'main' }
        );
      } else {
        await sendBotMessage(
          chatId,
          [
            '💳 Cargar créditos',
            'Todavía no tengo configurado el link de checkout en este entorno.',
            'Puedo mostrarte tus créditos actuales mientras tanto con el botón `Creditos`.',
          ].join('\n'),
          { menuScope: 'main' }
        );
      }
      return;
    }

    if (data === 'qa:record_bet') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.record_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:settle_bet') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.settle_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:bet_open') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.bet_open, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:bet_record') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.record_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:cfg_stake') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_stake, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_profile') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_profile, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_unit') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_unit, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_risk') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_risk, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_bankroll') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_bankroll, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_timezone') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_timezone, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_utilization') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_utilization, { menuScope: 'config' });
      return;
    }
    if (data === 'act:cfg_stake_exposure') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_stake_exposure, {
        menuScope: 'config',
      });
      return;
    }

    const syntheticByAction = {
      'qa:list_pending': 'mostrame mis apuestas pending del ledger con bet_id',
      'qa:list_history': 'mostrame mi historial de apuestas del ledger',
      'qa:undo_last': 'deshace la ultima mutacion del ledger',
      'qa:view_config':
        'mostrame mi configuracion actual (bankroll, unidad, riesgo, timezone y stake minimo)',
      'qa:view_credits': 'decime cuantos creditos tengo y mis ultimos movimientos',
      'qa:event_projections': 'mostrame proyecciones para el proximo evento',
      'qa:latest_news': 'mostrame ultimas novedades relevantes del proximo evento',
      'act:cfg_news_alerts_toggle': 'toggle alertas noticias',
    };

    const syntheticMessage = syntheticByAction[data];
    if (!syntheticMessage) {
      return;
    }

    const routed = await routeSyntheticAction(query, syntheticMessage);
    const menuScopeByAction = {
      'qa:list_pending': 'bets',
      'qa:list_history': 'bets',
      'qa:undo_last': 'bets',
      'qa:view_config': 'config',
      'qa:view_credits': 'config',
      'qa:event_projections': 'event',
      'qa:latest_news': 'event',
      'act:cfg_news_alerts_toggle': 'config',
    };
    const menuScope = menuScopeByAction[data] || getMenuScope(chatId);
    await sendBotMessage(chatId, routed || 'No pude completar esa accion ahora mismo.', {
      menuScope,
    });
  });

  console.log('🤖 Telegram bot iniciado y esperando mensajes...');

  return {
    bot,
    interactionMode,
    async sendSystemMessage({ chatId, text } = {}) {
      if (!chatId || !text) return null;
      return sendBotMessage(chatId, text);
    },
  };
}
