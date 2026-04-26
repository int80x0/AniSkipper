# AniSkipper

Leichtes Browser-Addon zum schnellen Überspringen von Anime-Openings.

## Features
- Skip-Button direkt im Player
- Frei einstellbare Skip-Dauer
- Hotkey im Popup konfigurierbar
- Seiten-Whitelist (manuell oder aktuelle Seite übernehmen)
- Läuft in Firefox sowie Chrome-/Opera-basierten Browsern

## Installation
### Firefox
1. `about:debugging#/runtime/this-firefox` öffnen
2. `Temporäres Add-on laden` klicken
3. `AniSkipper/manifest.json` auswählen

### Chrome / Opera
1. `dist/AniSkipper-chrome-<version>.zip` entpacken
2. `chrome://extensions` oder `opera://extensions` öffnen
3. Developer Mode aktivieren
4. `Entpackte Erweiterung laden` und den entpackten Ordner wählen

## Build
```powershell
.\AniSkipper\build-xpi.ps1
.\AniSkipper\build-chrome.ps1
```

## Nutzung
1. Seite im Popup freischalten
2. Skip-Dauer, Hotkey und Button-Position einstellen
3. Im Player per Button oder Hotkey skippen
