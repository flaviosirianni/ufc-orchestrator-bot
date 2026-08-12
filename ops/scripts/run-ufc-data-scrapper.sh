#!/usr/bin/env bash
# ufc-data-scrapper runbook — scrape ufcstats.com, build a candidate ufc_stats.db,
# validate it, and only then atomically swap it into production and restart the bot.
# Never touches the live DB unless the candidate passes validation; always keeps a
# one-generation backup to roll back to if the post-swap restart doesn't come back healthy.
set -euo pipefail

SCRAPER_DIR="${SCRAPER_DIR:-/home/ubuntu/apps/data-scrapper}"
PY="$SCRAPER_DIR/.venv/bin/python"
LIVE_DB="${LIVE_DB:-/home/ubuntu/ufc-orchestrator-data/ufc_stats.db}"
CANDIDATE_DB="${LIVE_DB}.candidate"
BACKUP_DB="${LIVE_DB}.bak"
LOG_FILE="${SCRAPER_LOG_FILE:-/tmp/ufc-data-scrapper.log}"
LOCK_FILE="${SCRAPER_LOCK_FILE:-/tmp/ufc-data-scrapper.lock}"
HEALTH_URL="${UFC_HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_WAIT_SEC="${HEALTH_WAIT_SEC:-240}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE"; }

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  log "Ya hay una corrida en curso (lock activo), saliendo sin hacer nada."
  exit 0
fi

cleanup() { rm -f "$CANDIDATE_DB"; }
trap cleanup EXIT

cd "$SCRAPER_DIR"

log "Scrape incremental de peleas completadas..."
"$PY" run_ufc.py scrape --since-year 2016 2>&1 | tee -a "$LOG_FILE"

log "Scrape de cartelera upcoming..."
"$PY" run_ufc.py scrape-upcoming 2>&1 | tee -a "$LOG_FILE"

log "Convirtiendo a SQLite (candidato, no toca la DB live todavia)..."
rm -f "$CANDIDATE_DB"
"$PY" convert_to_sqlite.py --output "$CANDIDATE_DB" 2>&1 | tee -a "$LOG_FILE"

log "Validando candidato..."
integrity=$(sqlite3 "$CANDIDATE_DB" "PRAGMA integrity_check;")
if [[ "$integrity" != "ok" ]]; then
  log "ABORTA: integrity_check devolvio '$integrity'. DB live sin tocar."
  exit 1
fi

candidate_fights=$(sqlite3 "$CANDIDATE_DB" "SELECT COUNT(*) FROM fights;")
missing_iso=$(sqlite3 "$CANDIDATE_DB" "SELECT COUNT(*) FROM fights WHERE event_date_iso IS NULL;")
live_fights=0
if [[ -f "$LIVE_DB" ]]; then
  live_fights=$(sqlite3 "$LIVE_DB" "SELECT COUNT(*) FROM fights;" 2>/dev/null || echo 0)
fi

if (( candidate_fights < live_fights )); then
  log "ABORTA: candidato tiene menos fights ($candidate_fights) que el live ($live_fights). DB live sin tocar."
  exit 1
fi
if (( missing_iso > 0 )); then
  log "ABORTA: $missing_iso fila(s) sin event_date_iso en el candidato. DB live sin tocar."
  exit 1
fi
log "Candidato OK: $candidate_fights fights (live tenia $live_fights), integrity_check=ok, event_date_iso completo."

if [[ -f "$LIVE_DB" ]]; then
  cp "$LIVE_DB" "$BACKUP_DB"
fi
mv "$CANDIDATE_DB" "$LIVE_DB"
log "Swap atomico aplicado: $LIVE_DB actualizado."

log "Reiniciando bot-factory@ufc..."
if ! sudo systemctl restart bot-factory@ufc.service; then
  log "ALERTA: systemctl restart fallo. Revirtiendo a la DB anterior."
  [[ -f "$BACKUP_DB" ]] && mv "$BACKUP_DB" "$LIVE_DB" && sudo systemctl restart bot-factory@ufc.service || true
  exit 1
fi

log "Esperando /health (hasta ${HEALTH_WAIT_SEC}s)..."
waited=0
while (( waited < HEALTH_WAIT_SEC )); do
  if curl -sf --connect-timeout 3 --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
    log "Bot healthy post-swap. Corrida exitosa."
    exit 0
  fi
  sleep 5
  waited=$(( waited + 5 ))
done

log "ALERTA: /health no respondio en ${HEALTH_WAIT_SEC}s post-swap. Revirtiendo a la DB anterior."
if [[ -f "$BACKUP_DB" ]]; then
  mv "$BACKUP_DB" "$LIVE_DB"
  sudo systemctl restart bot-factory@ufc.service || true
  log "Rollback aplicado."
fi
exit 1
