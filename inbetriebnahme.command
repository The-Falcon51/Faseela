#!/bin/bash
# Faseela – Inbetriebnahme auf diesem Mac. Per Doppelklick starten.
# Macht nacheinander: Prüfungen -> Web-Deployment (nach Rückfrage) -> Android-Sync -> iOS-Projekt erzeugen.
# Bricht beim ersten Fehler ab und sagt, in welchem Schritt. Nichts wird gelöscht; alte Ordner werden umbenannt.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1;32m== %s ==\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mABBRUCH in Schritt "%s": %s\033[0m\n' "$CURRENT" "$1"; read -r -p "Enter zum Schließen … " _; exit 1; }
trap 'fail "Befehl fehlgeschlagen (siehe Ausgabe oben)"' ERR
CURRENT="Start"

CURRENT="1 Voraussetzungen"; step "$CURRENT"
command -v node >/dev/null || fail "Node.js fehlt (https://nodejs.org)"
command -v npm >/dev/null || fail "npm fehlt"
echo "Node $(node -v), npm $(npm -v)"
[ -f public/i18n-de.js ] || fail "public/i18n-de.js fehlt – Pakete 3/4 nicht entpackt?"
[ -d node_modules/@capacitor/push-notifications ] || { echo "Installiere Abhängigkeiten …"; npm install; }

CURRENT="2 Build-Prüfungen"; step "$CURRENT"
# Copy the web build into the native projects first: the build check below refuses to pass while they differ.
npm run sync
npm run build

CURRENT="3 Web-Deployment"; step "$CURRENT"
if command -v firebase >/dev/null; then FB=(firebase); else FB=(npx --yes firebase-tools); fi
echo "Ziel: Firebase Hosting (faseela.web.app und gen-lang-client-0319369264.web.app)"
read -r -p "Jetzt live schalten? (j/n) " answer
if [ "$answer" = "j" ] || [ "$answer" = "J" ]; then
  "${FB[@]}" deploy --only hosting
  code=$(curl -s -o /dev/null -w '%{http_code}' https://faseela.web.app/i18n-de.js || true)
  [ "$code" = "200" ] && echo "Live-Prüfung ok (i18n-de.js erreichbar)." || echo "WARNUNG: Live-Prüfung meldet HTTP $code – bitte Ausgabe oben prüfen."
else
  echo "Deployment übersprungen."
fi

CURRENT="4 Android-Sync"; step "$CURRENT"
if [ -f android/gradlew ]; then
  npx cap sync android
  # The app uses the WebP images; JPEG originals with a WebP twin only bloat the app (about 20 MB).
  find android/app/src/main/assets/public -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) | while read -r f; do
    if [ -f "${f%.*}.webp" ]; then rm -f "$f"; fi
  done
  [ -f android/app/google-services.json ] || echo "Hinweis: android/app/google-services.json fehlt noch – Push bleibt bis dahin aus."
  if command -v java >/dev/null && { [ -n "${ANDROID_HOME:-}" ] || [ -d "$HOME/Library/Android/sdk" ]; }; then
    export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    echo "Baue Android-Testversion …"
    (cd android && ./gradlew assembleDebug -q) && echo "Testversion: android/app/build/outputs/apk/debug/app-debug.apk"
  else
    echo "Android-SDK oder Java nicht gefunden – Testversion nicht gebaut (Android Studio installieren)."
  fi
else
  echo "Android-Projekt unvollständig – übersprungen."
fi

CURRENT="5 iOS-Projekt"; step "$CURRENT"
if ! command -v xcodebuild >/dev/null; then
  echo "Xcode fehlt – iOS übersprungen. Xcode aus dem App Store installieren und dieses Skript erneut starten."
elif ! command -v pod >/dev/null; then
  echo "CocoaPods fehlt – iOS übersprungen. Installation: brew install cocoapods  (danach Skript erneut starten)."
else
  if [ ! -f ios/App/Podfile ]; then
    ICON_BACKUP=""
    if [ -d ios ]; then
      old="ios-alt-$(date +%Y%m%d-%H%M%S)"
      [ -f ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png ] && ICON_BACKUP="$old/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
      mv ios "$old"; echo "Alter iOS-Ordner liegt jetzt in $old"
    fi
    npx cap add ios
    [ -n "$ICON_BACKUP" ] && [ -f "$ICON_BACKUP" ] && cp "$ICON_BACKUP" ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  fi
  npx cap sync ios
  find ios/App/App/public -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) | while read -r f; do
    if [ -f "${f%.*}.webp" ]; then rm -f "$f"; fi
  done
  PLIST=ios/App/App/Info.plist
  setkey() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
  setkey CFBundleDisplayName "Faseela"
  setkey NSMicrophoneUsageDescription "Spracheingabe im Assistenten · Voice input in the assistant · الإدخال الصوتي في المساعد"
  setkey NSCameraUsageDescription "Fotos von Zahlungsbelegen und Feldberichten · Photos of payment receipts and field reports · تصوير إشعارات الدفع والتقارير الميدانية"
  setkey NSLocationWhenInUseUsageDescription "GPS-Position eines Feldberichts · GPS position of a field report · موقع التقرير الميداني"
  /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST"
  echo "iOS-Projekt bereit: ios/App/App.xcworkspace (in Xcode öffnen, Team wählen, auf Gerät starten)."
fi

step "Fertig"
echo "Nächste Schritte stehen in docs/ARCHITECTURE_AND_OPERATIONS.md, Abschnitt 2s."
read -r -p "Enter zum Schließen … " _
