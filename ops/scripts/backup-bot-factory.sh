#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${1:-/home/ubuntu/bot-data}"
BACKUP_ROOT="${2:-/home/ubuntu/bot-data/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TS="$(date +%F-%H%M%S)"

mkdir -p "$BACKUP_ROOT"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 no esta instalado" >&2
  exit 1
fi

mapfile -t DB_FILES < <(find "$DATA_ROOT" -maxdepth 3 -type f -name '*.db' | sort)

if [[ ${#DB_FILES[@]} -eq 0 ]]; then
  echo "No se encontraron DBs en $DATA_ROOT"
  exit 0
fi

for DB_PATH in "${DB_FILES[@]}"; do
  BASE_NAME="$(basename "$DB_PATH" .db)"
  PARENT_NAME="$(basename "$(dirname "$DB_PATH")")"
  OUT_PATH="$BACKUP_ROOT/${PARENT_NAME}-${BASE_NAME}-${TS}.db"
  sqlite3 "$DB_PATH" ".backup '$OUT_PATH'"
  echo "backup ok: $DB_PATH -> $OUT_PATH"
done

find "$BACKUP_ROOT" -type f -name '*.db' -mtime "+$RETENTION_DAYS" -print -delete
