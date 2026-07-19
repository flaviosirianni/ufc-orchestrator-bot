#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! ROOT_DIR="$(git -C "$SCRIPT_ROOT" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERROR: $SCRIPT_ROOT no pertenece a un repo git inicializado"
  exit 1
fi

PRE_PUSH="$ROOT_DIR/.githooks/pre-push"
if [[ ! -f "$PRE_PUSH" ]]; then
  echo "ERROR: falta el hook versionado $PRE_PUSH"
  exit 1
fi

chmod +x "$PRE_PUSH"
git -C "$ROOT_DIR" config core.hooksPath .githooks
echo "HOOKS_PATH=.githooks"
echo "PRE_PUSH=$PRE_PUSH"
