// ─── WEB PUSH (RFC 8291 aes128gcm + RFC 8292 VAPID) ────────────────────────
// Reine Web-Crypto-Implementierung (kein npm-Paket "web-push" – das nutzt
// Node-APIs, die im Cloudflare-Workers-Runtime nicht verfügbar sind). Folgt
// exakt den beiden RFCs, damit Chrome/FCM & Firefox/Mozilla-Autopush die
// Nachricht akzeptieren.

function b64urlToBytes(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}
function bytesToB64url(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}
function textBytes(str) { return new TextEncoder().encode(str); }

async function buildVapidHeader(endpoint, vapidPublicKeyB64url, vapidPrivateKeyPkcs8B64url, subject) {
    const origin = new URL(endpoint).origin;
    const header = { typ: 'JWT', alg: 'ES256' };
    const payload = { aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
    const signingInput = bytesToB64url(textBytes(JSON.stringify(header))) + '.' + bytesToB64url(textBytes(JSON.stringify(payload)));
    const privKey = await crypto.subtle.importKey(
        'pkcs8', b64urlToBytes(vapidPrivateKeyPkcs8B64url),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    );
    // Web Crypto liefert die ECDSA-Signatur bereits als raw r||s (IEEE P1363) –
    // exakt das JWS-ES256-Format, keine DER-Konvertierung nötig.
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, textBytes(signingInput));
    const jwt = signingInput + '.' + bytesToB64url(sig);
    return `vapid t=${jwt}, k=${vapidPublicKeyB64url}`;
}

async function encryptPayload(payloadObj, p256dhB64url, authB64url) {
    const plaintext = textBytes(JSON.stringify(payloadObj));
    const subscriberPubBytes = b64urlToBytes(p256dhB64url);
    const authSecret = b64urlToBytes(authB64url);

    const subscriberPubKey = await crypto.subtle.importKey(
        'raw', subscriberPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const localPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

    const ecdhSecretBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: subscriberPubKey }, localKeyPair.privateKey, 256
    );
    const ecdhSecret = await crypto.subtle.importKey('raw', ecdhSecretBits, 'HKDF', false, ['deriveBits']);

    // Stufe 1 (RFC 8291 §3.4): IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"||ua_pub||as_pub, 32)
    const keyInfo = concatBytes(textBytes('WebPush: info\0'), subscriberPubBytes, localPubBytes);
    const ikmBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, ecdhSecret, 256
    );
    const ikmKey = await crypto.subtle.importKey('raw', ikmBits, 'HKDF', false, ['deriveBits']);

    // Stufe 2 (RFC 8188 aes128gcm): CEK/NONCE aus IKM + zufälligem 16-Byte-Salt
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cekBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: textBytes('Content-Encoding: aes128gcm\0') }, ikmKey, 128
    );
    const nonceBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: textBytes('Content-Encoding: nonce\0') }, ikmKey, 96
    );

    const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
    // Delimiter-Oktett 0x02 (letzter Record, RFC 8188 §2) ans Klartextende – kein Padding nötig.
    const padded = concatBytes(plaintext, new Uint8Array([0x02]));
    const cipherBits = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBits }, cek, padded);

    // RFC-8188-Record-Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(65)
    const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
    const header = concatBytes(salt, rs, new Uint8Array([localPubBytes.length]), localPubBytes);
    return concatBytes(header, new Uint8Array(cipherBits));
}

// sub: { endpoint, keys: { p256dh, auth } } – wie vom Browser (PushSubscription.toJSON()) geliefert.
// payloadObj: { title, body, url, tag } – landet unverändert im "push"-Event des Service Workers.
export async function sendWebPush(sub, payloadObj, vapidPublicKeyB64url, vapidPrivateKeyPkcs8B64url, subject) {
    const body = await encryptPayload(payloadObj, sub.keys.p256dh, sub.keys.auth);
    const authHeader = await buildVapidHeader(sub.endpoint, vapidPublicKeyB64url, vapidPrivateKeyPkcs8B64url, subject);
    const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
            'Content-Encoding': 'aes128gcm',
            'TTL': '2419200',
            'Urgency': 'normal',
            'Authorization': authHeader
        },
        body
    });
    if (!res.ok) {
        const err = new Error(`push send failed: ${res.status} ${await res.text().catch(() => '')}`);
        err.status = res.status;
        throw err;
    }
    return res;
}
