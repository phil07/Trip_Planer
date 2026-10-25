# Arbeitsregeln

- **Nur der Branch `main` existiert.** Keine Feature-Branches, keine Pull Requests – direkt auf `main` committen und pushen. Vorher pullen.
- **`Trip-Planer/version.js` (`APP_VERSION`) bei jedem Push auf `main`, der etwas unter `Trip-Planer/` ändert, um eins erhöhen.** Der Service-Worker-Cache leitet sich davon ab; daran erkennt die installierte App den neuen Stand.
- Antworten und Commit-Nachrichten auf Deutsch.
