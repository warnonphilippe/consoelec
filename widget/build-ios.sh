#!/usr/bin/env bash
# Construit et installe l'app « ConsoElec » et son widget sur l'iPhone (branché en USB, ou appairé sur le même Wi-Fi).
# Prérequis : Xcode avec la plateforme iOS (xcodebuild -downloadPlatform iOS), XcodeGen, Local.xcconfig avec
# DEVELOPMENT_TEAM, mode développeur activé sur l'iPhone.
# Avec l'équipe gratuite « Personal Team », la signature expire après 7 jours : relancer ce script chaque semaine.
# Choisir un appareil précis : DEVICE=<UDID ou nom> ./build-ios.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f Local.xcconfig ]; then
  echo "✗ Local.xcconfig manquant : copiez Local.xcconfig.example et indiquez votre équipe de signature." >&2
  exit 1
fi

DEVICES_JSON="$(mktemp)"
trap 'rm -f "$DEVICES_JSON"' EXIT
xcrun devicectl list devices --quiet --json-output "$DEVICES_JSON" >/dev/null
DEVICE="${DEVICE:-$(/usr/bin/python3 - "$DEVICES_JSON" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
phones = [d for d in devices
          if d.get("hardwareProperties", {}).get("platform") == "iOS"
          and d.get("connectionProperties", {}).get("pairingState") == "paired"]
print(phones[0]["hardwareProperties"]["udid"] if phones else "")
PY
)}"
if [ -z "$DEVICE" ]; then
  echo "✗ Aucun iPhone appairé : branchez-le en USB, déverrouillez-le et répondez « Se fier » à cet ordinateur." >&2
  exit 1
fi

xcodegen generate --quiet
xcodebuild -project ConsoElecWidget.xcodeproj -scheme ConsoElecPhone -configuration Release \
  -destination "id=$DEVICE" -derivedDataPath build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet build

APP="build/Build/Products/Release-iphoneos/ConsoElec.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
if ! xcrun devicectl device process launch --device "$DEVICE" io.github.warnonphilippe.consoelec.phone >/dev/null 2>&1; then
  echo "! L'app est installée mais n'a pas pu être lancée. Au premier lancement, autorisez le développeur :"
  echo "  Réglages → Général → VPN et gestion de l'appareil → votre identifiant Apple → Faire confiance."
fi
echo "✓ Installé sur l'iPhone : ConsoElec (signature valable 7 jours avec l'équipe gratuite)."
echo "  Ajoutez le widget : appui long sur l'écran d'accueil → Modifier → Ajouter un widget → ConsoElec."
