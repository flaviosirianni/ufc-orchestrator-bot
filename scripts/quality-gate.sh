#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="${QUALITY_MANTRA_CHECK_SCRIPT:-$HOME/.codex/skills/quality-mantra-defaults/scripts/check-quality-pack.sh}"

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "[quality-gate] ERROR: no encuentro check-quality-pack.sh en $CHECK_SCRIPT"
  exit 1
fi

"$CHECK_SCRIPT" "$ROOT_DIR"
echo "[quality-gate] OK"
