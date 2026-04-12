/**
 * eventMirrorService.js
 *
 * Builds and refreshes event_fight_mirror + event_fighter_mirror in bot.db
 * using data from ufc_stats.db (via ufcStatsTool). Acts as a hot cache for
 * the current/next event's fight card and fighter stats packs.
 *
 * Refresh triggers:
 *   1. Cron every EVENT_FIGHT_MIRROR_REFRESH_MS (default 60 min)
 *   2. Immediate trigger when event_watch_state changes event_id
 */

const TAG = '[eventMirrorService]';

function slugify(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Build mirror rows for a single watch_key from event_watch_state.
 */
async function buildMirrorForWatchKey(watchKey, { ufcStats, store }) {
  const eventState = store.getEventWatchState(watchKey);
  if (!eventState?.mainCard?.length) {
    return { builtAt: null, fightCount: 0, fighterCount: 0 };
  }

  const { eventId, eventName } = eventState;
  const builtAt = new Date().toISOString();
  const fightRows = [];
  const fighterMap = new Map(); // slug → { fighterName, statsPackJson }

  for (let i = 0; i < eventState.mainCard.length; i++) {
    const entry = eventState.mainCard[i];
    const fighterA = entry.fighterA || entry.fighter_a || '';
    const fighterB = entry.fighterB || entry.fighter_b || '';
    const fightId = entry.fightId || entry.fight_id || `${slugify(fighterA)}_vs_${slugify(fighterB)}`;

    // Fetch stats for both fighters (fail-safe: null if unavailable)
    let statsA = null;
    let statsB = null;

    if (ufcStats.isAvailable()) {
      try {
        const resA = ufcStats.getFighterStats({ fighterName: fighterA, limit: 8, includeRounds: false });
        if (resA && resA.fights) statsA = { fighter: resA.fighter, fights: resA.fights };
      } catch (err) {
        console.error(`${TAG} getFighterStats error for "${fighterA}":`, err.message);
      }
      try {
        const resB = ufcStats.getFighterStats({ fighterName: fighterB, limit: 8, includeRounds: false });
        if (resB && resB.fights) statsB = { fighter: resB.fighter, fights: resB.fights };
      } catch (err) {
        console.error(`${TAG} getFighterStats error for "${fighterB}":`, err.message);
      }
    }

    const statsPackJson = { fighterA: statsA, fighterB: statsB };

    fightRows.push({
      eventId: eventId || '',
      fightId,
      fighterA,
      fighterB,
      weightClass: entry.weightClass || entry.weight_class || null,
      cardPosition: i,
      statsPackJson,
    });

    // Per-fighter mirror rows
    const slugA = slugify(fighterA);
    if (slugA && !fighterMap.has(slugA)) {
      fighterMap.set(slugA, { fighterName: fighterA, statsPackJson: statsA });
    }
    const slugB = slugify(fighterB);
    if (slugB && !fighterMap.has(slugB)) {
      fighterMap.set(slugB, { fighterName: fighterB, statsPackJson: statsB });
    }
  }

  const fighterRows = Array.from(fighterMap.entries()).map(([slug, { fighterName, statsPackJson }]) => ({
    eventId: eventId || '',
    fighterSlug: slug,
    fighterName,
    statsPackJson,
  }));

  store.clearEventMirror(watchKey);
  if (fightRows.length) store.upsertEventFightMirror(fightRows, watchKey);
  if (fighterRows.length) store.upsertEventFighterMirror(fighterRows, watchKey);

  return { builtAt, fightCount: fightRows.length, fighterCount: fighterRows.length };
}

/**
 * Refresh mirrors for both next_event and current_event.
 */
async function refreshAllMirrors({ ufcStats, store }) {
  for (const watchKey of ['next_event', 'current_event']) {
    try {
      const result = await buildMirrorForWatchKey(watchKey, { ufcStats, store });
      if (result.fightCount > 0) {
        console.log(
          `${TAG} [${watchKey}] mirror built: ${result.fightCount} fights, ${result.fighterCount} fighters`
        );
      }
    } catch (err) {
      console.error(`${TAG} [${watchKey}] mirror build failed:`, err.message);
    }
  }
}

/**
 * Trigger immediate mirror refresh if the event_id changed for a watch_key.
 */
export function triggerMirrorRefreshIfEventChanged(prevEventId, newEventId, watchKey, deps) {
  if (!prevEventId || !newEventId) return;
  if (prevEventId === newEventId) return;
  refreshAllMirrors(deps).catch((err) => {
    console.error(`${TAG} event-change trigger failed:`, err.message);
  });
}

/**
 * initEventMirrorService({ ufcStats, store, refreshMs })
 *
 * Starts the background mirror refresh loop.
 *
 * @param {object} ufcStats  — ufcStatsTool module (isAvailable, getFighterStats)
 * @param {object} store     — { getEventWatchState, getEventFightMirror, upsertEventFightMirror,
 *                               upsertEventFighterMirror, clearEventMirror }
 * @param {number} refreshMs — cron interval (default 3600000 = 60 min)
 * @returns {{ stop(): void }}
 */
export function initEventMirrorService({ ufcStats, store, refreshMs } = {}) {
  if (!ufcStats || !store) {
    console.warn(`${TAG} Missing ufcStats or store — mirror service disabled.`);
    return { stop: () => {} };
  }

  const interval = Math.max(60_000, Number(refreshMs) || 3_600_000);
  const deps = { ufcStats, store };

  // Initial refresh (non-blocking)
  refreshAllMirrors(deps).catch((err) => {
    console.error(`${TAG} Initial refresh failed:`, err.message);
  });

  const timer = setInterval(() => {
    refreshAllMirrors(deps).catch((err) => {
      console.error(`${TAG} Scheduled refresh failed:`, err.message);
    });
  }, interval);

  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
