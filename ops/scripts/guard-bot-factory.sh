#!/usr/bin/env bash
# bot-factory runtime guard — probes /health, triggers controlled restarts
# Requires: jq, systemd, bash 4+
set -euo pipefail

BOTS=("ufc:3000" "nutrition:3001" "ovidius_medibot:3002")
STATE_FILE="/tmp/bot-factory-guard-state.json"
LOCK_FILE="/tmp/bot-factory-guard.lock"
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

declare -A last_restart
declare -A prev_conflicts
if [[ -f "$STATE_FILE" ]]; then
  for entry in "${BOTS[@]}"; do
    bot="${entry%%:*}"
    last_restart[$bot]=$(jq -r ".${bot}.last_restart // 0" "$STATE_FILE" 2>/dev/null || echo 0)
    prev_conflicts[$bot]=$(jq -r ".${bot}.conflicts // 0" "$STATE_FILE" 2>/dev/null || echo 0)
  done
fi

for entry in "${BOTS[@]}"; do
  bot="${entry%%:*}"
  port="${entry##*:}"

  health=$(curl -sf --connect-timeout 3 --max-time 5 "http://localhost:${port}/health" 2>/dev/null || echo "")

  if [[ -z "$health" ]]; then
    log "[$bot] /health inaccesible en puerto $port"
    alert "$bot health inaccesible — revisar servicio"
    continue
  fi

  degraded=$(echo "$health"   | jq -r '.runtime.telegram.degraded // false')
  idle_ms=$(echo "$health"    | jq -r '.runtime.telegram.idleMs // 0')
  conflicts=$(echo "$health"  | jq -r '.runtime.telegram.pollingConflictCount // 0')

  idle_sec=$(( idle_ms / 1000 ))
  prev="${prev_conflicts[$bot]:-0}"
  prev_conflicts[$bot]=$conflicts

  reason=""
  if [[ "$degraded" == "true" ]] && (( idle_sec > STALE_IDLE_SEC )); then
    reason="degraded+stale idle=${idle_sec}s"
  elif (( idle_sec > STALE_IDLE_SEC && conflicts > prev )); then
    reason="stale+conflicts idle=${idle_sec}s new=$((conflicts - prev))"
  fi

  if [[ -n "$reason" ]]; then
    elapsed=$(( now - ${last_restart[$bot]:-0} ))
    if (( elapsed < RESTART_WINDOW_SEC )); then
      log "[$bot] necesita restart ($reason) pero dentro de ventana (${elapsed}s < ${RESTART_WINDOW_SEC}s)"
    else
      log "[$bot] reiniciando: $reason"
      alert "Reiniciando $bot — $reason"
      if sudo systemctl restart "bot-factory@${bot}"; then
        last_restart[$bot]=$now
        log "[$bot] restart OK"
      else
        alert "$bot restart FALLÓ — intervención manual necesaria"
        log "[$bot] restart FALLÓ"
      fi
    fi
  else
    log "[$bot] ok (idle=${idle_sec}s conflicts=${conflicts} degraded=${degraded})"
  fi
done

state='{}'
for entry in "${BOTS[@]}"; do
  bot="${entry%%:*}"
  state=$(echo "$state" | jq \
    --arg bot "$bot" \
    --argjson r "${last_restart[$bot]:-0}" \
    --argjson c "${prev_conflicts[$bot]:-0}" \
    '.[$bot] = {last_restart: $r, conflicts: $c}')
done
echo "$state" > "$STATE_FILE"
