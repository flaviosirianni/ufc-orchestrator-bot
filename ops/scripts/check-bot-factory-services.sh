#!/usr/bin/env bash
set -euo pipefail

SERVICES=("billing-service" "bot-factory@ufc" "bot-factory@nutrition" "bot-factory@medical_reader")

for SERVICE in "${SERVICES[@]}"; do
  STATUS="$(systemctl is-active "$SERVICE" || true)"
  echo "$SERVICE: $STATUS"
  if [[ "$STATUS" != "active" ]]; then
    echo "detalle:"
    systemctl status "$SERVICE" --no-pager -l | sed -n '1,20p'
  fi
done
