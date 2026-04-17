#!/bin/zsh

set -euo pipefail

FIREBASE_BIN="${HOME}/.npm-global/bin/firebase"

if [[ ! -x "${FIREBASE_BIN}" ]]; then
  if command -v firebase >/dev/null 2>&1; then
    FIREBASE_BIN="$(command -v firebase)"
  else
    echo "Firebase CLI not found." >&2
    echo "Install it with: npm install -g firebase-tools" >&2
    exit 1
  fi
fi

"$(dirname "$0")/build.sh"

exec "${FIREBASE_BIN}" deploy --only hosting "$@"
