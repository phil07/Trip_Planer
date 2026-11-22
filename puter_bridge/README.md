# Puter-KI-Brücke (`japan-ki`)

Mini-Seite, die das Puter-SDK (zusätzliche KI-Quelle für Routenvorschläge) **getrennt von der App** lädt.
Sie läuft auf einer eigenen Adresse (`https://japan-ki.iphilipp07-869.workers.dev`), damit der Browser
Puters fremden Code vollständig von den App-Daten (Reise, Tagebuch, Budget, API-Keys) trennt.
Die App bettet sie als iframe ein und tauscht nur den Text der Routen-Anfrage per `postMessage` aus.

Solange die Brücke nicht deployt ist, überspringt die App Puter einfach (Pollinations läuft weiter).

## Veröffentlichen

Der GitHub-Workflow `.github/workflows/pwa-deploy.yml` veröffentlicht die Brücke bei jedem Push auf `main`
zusammen mit der App (Schritt „KI-Brücke veröffentlichen (japan-ki)“). Eine Git-Verbindung im
Cloudflare-Dashboard ist dafür nicht nötig und sollte getrennt bleiben.

## Sicherheit

- `public/_headers`: `frame-ancestors` erlaubt das Einbetten nur durch die App-Adresse.
- `public/index.html` nimmt Nachrichten nur von der App-Adresse an (`APP_ORIGINS`) und begrenzt Anfrage-/Antwortlänge.
- Ändert sich die App-Adresse, beide Stellen sowie `PUTER_BRIDGE_ORIGIN` in `Trip-Planer/app.js` anpassen.
