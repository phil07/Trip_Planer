// Anmeldung bei Google in der Android-App (Credential Manager). Wird mit esbuild gebündelt:
// npm run build:native  →  Trip-Planer/vendor/native-login.js. Nur in der App geladen (sync.js).
import { SocialLogin } from '@capgo/capacitor-social-login';

let ready = null;
window.tpNativeLogin = {
    // webClientId ist die Web-Client-ID aus der Google Cloud Console (nicht die Android-ID).
    async accessToken(scope, webClientId) {
        ready ??= SocialLogin.initialize({ google: { webClientId } });
        await ready;
        const res = await SocialLogin.login({ provider: 'google', options: { scopes: [scope] } });
        const token = res?.result?.accessToken?.token;
        if (!token) throw new Error('Kein Zugriffstoken von Google');
        return token;
    }
};
