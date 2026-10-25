#!/usr/bin/env bash
# Construit l'application de bureau macOS (Apple Silicon) :
#   release/consoelec-<version>-mac-arm64.dmg
# Usage : ./release/build.sh   (depuis n'importe quel dossier)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ Le .dmg ne se construit que sur macOS." >&2
  exit 1
fi

# Dépendances absentes ou plus anciennes que package-lock.json → npm ci.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "→ npm ci"
  npm ci --no-audit --no-fund
fi

npm test
npm run dist:mac

VERSION="$(node -p "require('./package.json').version")"
DMG="release/consoelec-${VERSION}-mac-arm64.dmg"
echo
echo "✓ $(ls -lh "$DMG" | awk '{print $5, $NF}')"
echo "  Installer : ouvrir le .dmg et glisser ConsoElec dans Applications."
