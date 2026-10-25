#!/usr/bin/env bash
# Construit et installe le widget macOS de ConsoElec : /Applications/ConsoElec Widget.app
# Prérequis : Xcode, XcodeGen (brew install xcodegen), Local.xcconfig avec DEVELOPMENT_TEAM.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f Local.xcconfig ]; then
  echo "✗ Local.xcconfig manquant : copiez Local.xcconfig.example et indiquez votre équipe de signature." >&2
  exit 1
fi

xcodegen generate --quiet
xcodebuild -project ConsoElecWidget.xcodeproj -scheme ConsoElecWidget -destination 'platform=macOS' \
  -allowProvisioningUpdates -quiet test
xcodebuild -project ConsoElecWidget.xcodeproj -scheme ConsoElecWidget -configuration Release \
  -derivedDataPath build -allowProvisioningUpdates build

APP="build/Build/Products/Release/ConsoElec Widget.app"
pkill -x "ConsoElec Widget" 2>/dev/null || true
rm -rf "/Applications/ConsoElec Widget.app"
ditto "$APP" "/Applications/ConsoElec Widget.app"
open "/Applications/ConsoElec Widget.app"
echo "✓ Installé : /Applications/ConsoElec Widget.app"
echo "  Ajoutez le widget : clic droit sur le bureau → Modifier les widgets → ConsoElec."
