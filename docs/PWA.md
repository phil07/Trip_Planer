# PWA veröffentlichen (gleichzeitig mit der APK)

Web-App (PWA) und Android-App (APK) entstehen aus demselben Ordner `Trip-Planer/`.
Bei jedem Push auf `main` laufen zwei GitHub-Actions:

| Workflow | Ergebnis |
|---|---|
| `android-release.yml` | APK als GitHub-Release, getaggt mit `APP_VERSION` |
| `pwa-deploy.yml` | PWA auf Cloudflare (`https://japan.iphilipp07-869.workers.dev`) |

Beide lesen die Version aus `Trip-Planer/version.js`. Der PWA-Workflow prüft am Ende,
ob die neue Version wirklich live ist, und wird rot, wenn nicht.

## Einmalige Einrichtung

### 1. Cloudflare-API-Token anlegen

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**
2. Vorlage **Edit Cloudflare Workers** → **Use template**
3. Bei *Account Resources* dein Konto wählen, bei *Zone Resources* „All zones“ lassen
4. **Continue to summary** → **Create Token** → Token kopieren (wird nur einmal angezeigt)

### 2. Account-ID kopieren

Im Cloudflare-Dashboard unter **Workers & Pages** rechts: **Account ID**.

### 3. Secrets in GitHub eintragen

Repository `phil07/Trip_Planer` → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Wert |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token aus Schritt 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Account-ID aus Schritt 2 |

### 4. Ersten Lauf starten

**Actions → PWA veröffentlichen → Run workflow**. Danach läuft er bei jedem Push von selbst.

### 5. Alte Cloudflare-Git-Verbindung trennen (empfohlen)

Bis v233 hat Cloudflare die PWA selbst aus dem Repository gebaut. Diese Verbindung ist seit
der Umbenennung des Repositorys stehen geblieben. Damit nicht zwei Wege gleichzeitig
veröffentlichen: Cloudflare → **Workers & Pages → japan → Settings → Build → Git repository → Disconnect**.

## Ohne Secrets

Fehlen die Secrets, bleibt der Workflow grün und zeigt eine Warnung. Die PWA bleibt dann auf
dem alten Stand; von Hand veröffentlichen geht weiter mit `npx wrangler deploy`.
