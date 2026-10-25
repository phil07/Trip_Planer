# Puter-KI-Brücke (`japan-ki`)

Mini-Seite, die das Puter-SDK (zusätzliche KI-Quelle für Routenvorschläge) **getrennt von der App** lädt.
Sie läuft auf einer eigenen Adresse (`https://japan-ki.iphilipp07-869.workers.dev`), damit der Browser
Puters fremden Code vollständig von den App-Daten (Reise, Tagebuch, Budget, API-Keys) trennt.
Die App bettet sie als iframe ein und tauscht nur den Text der Routen-Anfrage per `postMessage` aus.

Solange die Brücke nicht deployt ist, überspringt die App Puter einfach (Pollinations läuft weiter).

## Einmalig einrichten (Cloudflare-Dashboard)

1. Workers & Pages → **Create** → **Import a repository** → `phil07/Trip_Planer` wählen.
2. Projektname: **`japan-ki`** (muss exakt so heißen – daraus entsteht die Adresse).
3. Unter *Advanced settings* → **Root directory**: `puter_bridge`
4. Build command leer lassen, Deploy command `npx wrangler deploy` (Standard).
5. Deployen. Danach muss `https://japan-ki.iphilipp07-869.workers.dev` die Seite „Puter ist eine zusätzliche …“ zeigen.

## Sicherheit

- `public/_headers`: `frame-ancestors` erlaubt das Einbetten nur durch die App-Adresse.
- `public/index.html` nimmt Nachrichten nur von der App-Adresse an (`APP_ORIGINS`) und begrenzt Anfrage-/Antwortlänge.
- Ändert sich die App-Adresse, beide Stellen sowie `PUTER_BRIDGE_ORIGIN` in `Trip-Planer/app.js` anpassen.
