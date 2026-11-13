# Android-App (APK)

Die App liegt als Capacitor-Projekt im Ordner `android/`. Die Web-Dateien kommen aus `Trip-Planer/`.

## Einmalig: Signierschlüssel anlegen

Android verlangt, dass jede Aktualisierung mit demselben Schlüssel signiert ist. Verlierst du den Schlüssel, können installierte Apps nicht mehr aktualisiert werden. Bewahre die Datei und die Passwörter sicher auf, außerhalb des Repos.

```bash
keytool -genkeypair -v -keystore release.jks -alias tripplaner -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.jks > release.jks.base64
```

Dann unter GitHub im Repo unter **Settings → Secrets and variables → Actions** diese Secrets anlegen:

| Secret | Inhalt |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Inhalt von `release.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore-Passwort |
| `ANDROID_KEY_ALIAS` | `tripplaner` |
| `ANDROID_KEY_PASSWORD` | Schlüssel-Passwort |

Lege `release.jks` und `release.jks.base64` nie ins Repo. `*.jks` steht zwar in `.gitignore`, die `.base64`-Datei nicht. Lösche sie nach dem Kopieren ins Secret.

## Bei jeder Release

1. Auf GitHub unter **Releases** eine neue Release mit Tag wie `v235` veröffentlichen.
2. Der Workflow `.github/workflows/android-release.yml` baut die APK und hängt sie als `trip-planer-v235.apk` an die Release.
3. Die App prüft die neueste Release. Ist sie neuer als die installierte Version, erscheint ein Hinweis zum Herunterladen. Installieren bestätigt der Nutzer selbst.

Die Versionsnummer in `Trip-Planer/version.js` sollte mit dem Release-Tag übereinstimmen, sonst zeigt die App nach dem Update eine falsche Version.

## Lokal bauen

Voraussetzung: Android Studio oder das Android SDK, Java 21.

```bash
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug
```

Die Debug-APK liegt danach unter `android/app/build/outputs/apk/debug/`. Sie ist nicht signiert für Updates; zum Testen reicht sie.

## Bekannte Grenzen

- Ohne Netz läuft die App mit den gespeicherten Daten. Die Karte braucht Internet.
- Externe Dienste (Wetter, Währung, Karten, Suche) müssen die Herkunft `https://localhost` der App akzeptieren. Das ist beim ersten Start in der APK zu prüfen.
- Installieren aus dem Browser heraus braucht die Erlaubnis „Apps aus unbekannten Quellen installieren“ für den Browser.
