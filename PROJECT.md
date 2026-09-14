# Japan2026 — Projekt-Übersicht

Dieses Repo wird an mehreren Geräten bearbeitet (PC, Handy/Web via claude.ai/code). **Immer zuerst pullen, am Ende pushen.**

## Was das ist

Reise-App für eine Japan-Reise. Bestandteile:

| Datei | Zweck |
| --- | --- |
| `Japan2026_PWA/` | Die eigentliche App als PWA (`index.html`, `sw.js`, `manifest.json`, Icons). Läuft offline/für Handy. |
| `Japan_2026_App_Interaktiv.html` | Standalone-Mockup der App (interaktiv, eine Datei). |
| `Japan_2026_App_Mockup.html` | Design-Mockup (eine Datei). |
| `Japan_Image_Test.html` | Testseite für Bilddarstellung. |

## Wie die App läuft

- PWA per `file://` oder beliebigem static Server öffnen (keine Abhängigkeiten, kein Build-Schritt).
- `sw.js` macht die App offline-fähig (Cache-Update ggf. Cache-Version anpassen).

## Regeln

- **Immer pullen, bevor du anfängst; immer pushen, wenn du fertig bist.** Konflikte entstehen hier fast immer durch vergessene Pulls.
- Änderungen an Inhalt/Logik: direkt in `Japan2026_PWA/index.html` (die HTML-Mockups sind Standalone-Experimente, nicht die Live-App).
- Bei PWA-Änderungen Cache-Version in `sw.js` hochzählen.
- Tests/Preview: nichts Besonderes nötig, Datei im Browser öffnen.

## Sprach-/Kontext-Hinweis

Der Besitzer schreibt Deutsch — sonstige Antworten/Meldungen gern auf Deutsch. Projekt-Inhalte (App-Text) je nach Wunsch.