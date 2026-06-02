#!/usr/bin/env bash
# bot-factory runtime guard — probes /health, triggers controlled restarts
# Requires: jq, systemd, bash 4+
set -euo pipefail

BOTS=("ufc:3000" "nutrition:3001" "ovidius_medibot:3002")
STATE_FILE="${GUARD_STATE_FILE:-/tmp/bot-factory-guard-state.json}"
LOCK_FILE="${GUARD_LOCK_FILE:-/tmp/bot-factory-guard.lock}"
LOG_FILE="${GUARD_LOG_FILE:-/var/log/bot-factory-guard.log}"
RESTART_WINDOW_SEC="${RESTART_WINDOW_SEC:-1800}"
STALE_IDLE_SEC="${STALE_IDLE_SEC:-300}"
ALERT_TOKEN="${TELEGRAM_GUARD_TOKEN:-}"
ALERT_CHAT="${TELEGRAM_ADMIN_CHAT:-}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE"; }

alert() {
  local msg="[bot-factory-guard] $1"
  log "ALERT: $msg"
  [[ -z "$ALERT_TOKEN" || -z "$ALERT_CHAT" ]] && return 0
  curl -s -X POST "https://api.telegram.org/bot${ALERT_TOKEN}/sendMessage" \
    -d "chat_id=${ALERT_CHAT}" \
    --data-urlencode "text=${msg}" \
    --connect-timeout 5 --max-time 10 > /dev/null || true
}

if [[ -f "$LOCK_FILE" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if (( age < 300 )); then
    log "Guard ya corriendo (lock ${age}s), saliendo"
    exit 0
  fi
  log "Lock obsoleto (${age}s), eliminando"
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

now=$(date +%s)

old_state='{}'
if [[ -f "$STATE_FILE" ]]; then
  old_state=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
fi

state='{}'
for entry in "${BOTS[@]}"; do
  bot="${entry%%:*}"
  port="${entry##*:}"
  last_restart=$(echo "$old_state" | jq -r --arg bot "$bot" '.[$bot].last_restart // 0' 2>/dev/null || echo 0)
  prev_conflicts=$(echo "$old_state" | jq -r --arg bot "$bot" '.[$bot].conflicts // 0' 2>/dev/null || echo 0)
  consec_failures=$(echo "$old_state" | jq -r --arg bot "$bot" '.[$bot].consec_failures // 0' 2>/dev/null || echo 0)

  health=$(curl -sf --connect-timeout 3 --max-time 5 "http://localhost:${port}/health" 2>/dev/null || echo "")

  if [[ -z "$health" ]]; then
    consec_failures=$(( consec_failures + 1 ))
    log "[$bot] /health inaccesible en puerto $port (fallo consecutivo: ${consec_failures})"
    if (( consec_failures >= 2 )); then
      alert "$bot health inaccesible — revisar servicio"
    fi
    state=$(echo "$state" | jq \
      --arg bot "$bot" \
      --argjson r "$last_restart" \
      --argjson c "$prev_conflicts" \
      --argjson f "$consec_failures" \
      '.[$bot] = {last_restart: $r, conflicts: $c, consec_failures: $f}')
    continue
  fi
  consec_failures=0

  telegram_runtime=$(echo "$health" | jq -c '.runtime.telegram // empty' 2>/dev/null || echo "")
  degraded=false
  disabled=false
  idle_ms=0
  conflicts=0
  last_update_at=0
  last_error_at=0
  last_error_message=""
  if [[ -n "$telegram_runtime" && "$telegram_runtime" != "null" ]]; then
    degraded=$(echo "$telegram_runtime" | jq -r '.degraded // false')
    disabled=$(echo "$telegram_runtime" | jq -r '.disabled // false')
    idle_ms=$(echo "$telegram_runtime" | jq -r '.idleMs // 0')
    conflicts=$(echo "$telegram_runtime" | jq -r '.pollingConflictCount // 0')
    last_update_at=$(echo "$telegram_runtime" | jq -r '.lastUpdateAt // 0')
    last_error_at=$(echo "$telegram_runtime" | jq -r '.lastPollingErrorAt // 0')
    last_error_message=$(echo "$telegram_runtime" | jq -r '.lastErrorMessage // ""')
  fi

  idle_sec=$(( idle_ms / 1000 ))

  reason=""
  if [[ -z "$telegram_runtime" || "$telegram_runtime" == "null" ]]; then
    reason="telegram runtime missing"
  elif [[ "$disabled" == "true" ]]; then
    reason="telegram disabled"
  elif [[ "$degraded" == "true" ]] && (( idle_sec > STALE_IDLE_SEC )); then
    reason="degraded+stale idle=${idle_sec}s"
  elif (( idle_sec > STALE_IDLE_SEC && last_error_at > last_update_at )); then
    reason="stale+polling_error idle=${idle_sec}s last_error=${last_error_message:-unknown}"
  elif (( idle_sec > STALE_IDLE_SEC && conflicts > prev_conflicts )); then
    reason="stale+conflicts idle=${idle_sec}s new=$((conflicts - prev_conflicts))"
  fi

  if [[ -n "$reason" ]]; then
    elapsed=$(( now - last_restart ))
    if (( elapsed < RESTART_WINDOW_SEC )); then
      log "[$bot] necesita restart ($reason) pero dentro de ventana (${elapsed}s < ${RESTART_WINDOW_SEC}s)"
    else
      log "[$bot] reiniciando: $reason"
      alert "Reiniciando $bot — $reason"
      if sudo systemctl restart "bot-factory@${bot}"; then
        last_restart=$now
        log "[$bot] restart OK"
      else
        alert "$bot restart FALLÓ — intervención manual necesaria"
        log "[$bot] restart FALLÓ"
      fi
    fi
  else
    log "[$bot] ok (idle=${idle_sec}s conflicts=${conflicts} degraded=${degraded})"
  fi

  state=$(echo "$state" | jq \
    --arg bot "$bot" \
    --argjson r "$last_restart" \
    --argjson c "$conflicts" \
    --argjson f "$consec_failures" \
    '.[$bot] = {last_restart: $r, conflicts: $c, consec_failures: $f}')
done
echo "$state" > "$STATE_FILE"
