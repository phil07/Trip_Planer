# Push-Benachrichtigungen einrichten (einmalig)

Der Code für echte Web-Push-Benachrichtigungen ist fertig implementiert
(Worker unter `/worker`, Verschlüsselung nach RFC 8291, VAPID nach RFC 8292,
lokal gegen eine unabhängige Referenzimplementierung verifiziert). Zwei
Schritte lassen sich nur mit Zugriff auf **dein** Cloudflare-Konto erledigen
– das kann ich aus dieser Session heraus nicht für dich tun.

Voraussetzung: `npx wrangler login` einmal ausgeführt (öffnet den Browser für
den Cloudflare-Login).

## 1. KV-Namespace anlegen (speichert die Push-Subscriptions)

```bash
npx wrangler kv namespace create PUSH_SUBS
```

Die Ausgabe enthält eine `id`. Diese in `wrangler.jsonc` eintragen:

```jsonc
"kv_namespaces": [
  { "binding": "PUSH_SUBS", "id": "HIER_DIE_ID_EINFÜGEN" }
]
```

## 2. Secrets setzen

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
# Wert: der private Schlüssel, den Claude dir im Chat gegeben hat
# (PKCS8, base64url-kodiert) – NICHT ins Repo committen.

npx wrangler secret put PUSH_SEND_SECRET
# Wert: ein beliebiges, selbst gewähltes Passwort – schützt den
# /api/push-send-Endpunkt davor, dass Fremde Push-Nachrichten an
# deine Geräte schicken.
```

Der zugehörige **öffentliche** Schlüssel steht bereits fest in
`Trip-Planer/index.html` (`VAPID_PUBLIC_KEY`) – der muss nicht geheim sein.

## 3. Deployen

Ganz normal pushen/deployen wie bisher – der Cloudflare-Build führt
automatisch `npx wrangler versions upload` aus (Deploy-Befehl war schon so
konfiguriert).

## 4. Testen

In der App: einmal irgendwo tippen → Chrome fragt nach Benachrichtigungs-
Erlaubnis → erlauben. Das registriert die Subscription am Worker.

Test-Push manuell auslösen:

```bash
curl -X POST https://japan.iphilipp07-869.workers.dev/api/push-send \
  -H "X-Push-Secret: DEIN_PUSH_SEND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Funktioniert!","url":"./"}'
```

Antwort z. B. `{"sent":1,"failed":0,"removed":0}`. Die Benachrichtigung
sollte innerhalb weniger Sekunden auf dem Gerät ankommen (auch wenn die App
geschlossen ist).

## Wichtig – was ich nicht verifizieren konnte

Aus dieser Sandbox-Umgebung heraus habe ich keinen Internetzugriff auf
FCM/Mozilla-Push-Server und keinen Zugang zu deinem Cloudflare-Konto. Die
Kryptografie (Verschlüsselung + VAPID-Signatur) habe ich lokal gegen eine
unabhängige RFC-8291/8292-Implementierung gegengetestet und für korrekt
befunden – die tatsächliche Zustellung über den echten Push-Dienst konnte
ich aber nicht End-to-End testen. Falls der Testpush oben nicht ankommt,
meld dich mit der Fehlermeldung des curl-Aufrufs.
