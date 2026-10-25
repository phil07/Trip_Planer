// Kurzlinks fürs Teilen einer Reise: speichert einen im Browser verschlüsselten Datenblock in KV
// (Binding SHARES) und gibt eine kurze, nicht erratbare ID zurück. Den Schlüssel kennt nur der Link
// (Teil hinter „#“, wird nie an einen Server geschickt) – der Server sieht nur Chiffretext.
const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const MAX_BLOB = 512 * 1024;       // verschlüsselter Block (Deflate + AES-GCM)
const MIN_BLOB = 12 + 16 + 1;      // IV + GCM-Tag + mindestens ein Byte
const SHARE_TTL = 30 * 86400;      // Kurzlinks verfallen nach 30 Tagen

const headers = extra => Object.assign({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }, extra);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: headers({ 'content-type': 'application/json; charset=utf-8' }) });

function newId() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function handleShare(request, env, url) {
    if (!env.SHARES) return json({ error: 'SHARES KV-Namespace ist nicht gebunden – siehe wrangler.jsonc' }, 500);
    const parts = url.pathname.split('/').filter(Boolean); // api, share, [id]
    const id = parts[2];

    if (request.method === 'POST' && !id) {
        // Nur Anfragen von der eigenen App-Seite (Browser setzen Origin bei POST immer).
        if (request.headers.get('Origin') !== url.origin) return json({ error: 'forbidden' }, 403);
        const buf = await request.arrayBuffer();
        if (buf.byteLength > MAX_BLOB) return json({ error: 'Zu groß' }, 413);
        if (buf.byteLength < MIN_BLOB) return json({ error: 'Ungültige Daten' }, 400);
        const newKey = newId();
        await env.SHARES.put('s:' + newKey, buf, { expirationTtl: SHARE_TTL });
        return json({ id: newKey, expiresInDays: SHARE_TTL / 86400 });
    }
    if (request.method === 'GET' && id) {
        if (!ID_RE.test(id)) return json({ error: 'Ungültige Adresse' }, 400);
        const buf = await env.SHARES.get('s:' + id, 'arrayBuffer');
        if (!buf) return json({ error: 'Nicht gefunden oder abgelaufen' }, 404);
        return new Response(buf, { headers: headers({ 'content-type': 'application/octet-stream' }) });
    }
    return json({ error: 'Nicht erlaubt' }, 405);
}
