#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="api-tts-v1"
ARCHIVE="${1:-$SCRIPT_DIR/${APP_NAME}.tar}"
APP_DIR="$SCRIPT_DIR/$APP_NAME"
DATA_BACKUP=""

if [ ! -f "$ARCHIVE" ]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

if [ -d "$APP_DIR/data" ]; then
  DATA_BACKUP="$(mktemp -d)"
  cp -a "$APP_DIR/data/." "$DATA_BACKUP/"
fi

rm -rf "$APP_DIR"
tar -xf "$ARCHIVE" -C "$SCRIPT_DIR"

if [ -n "$DATA_BACKUP" ]; then
  mkdir -p "$APP_DIR/data"
  cp -a "$DATA_BACKUP/." "$APP_DIR/data/"
  rm -rf "$DATA_BACKUP"
fi

chmod +x "$APP_DIR/deploy-up.sh" || true
"$APP_DIR/deploy-up.sh"
