import { sendWebPush } from './webpush.js';
import { handleShare } from './share.js';

const VAPID_SUBJECT = 'mailto:iphilipp07@gmail.com';

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Nur echte Push-Dienste der Browser als Ziel zulassen – sonst könnte jemand
// beliebige URLs eintragen, die der Worker dann bei push-send anfragt.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
    /\.notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const MAX_BODY = 4096, MAX_SUBS = 50;
const isB64url = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+=*$/.test(v);
const clip = (v, d, max) => typeof v === 'string' && v.trim() ? v.slice(0, max) : d;

async function readJsonLimited(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}
// Zeitkonstanter Vergleich (über SHA-256, damit auch unterschiedliche Längen nichts verraten).
async function secretMatches(given, expected) {
    const [a, b] = await Promise.all([given || '', expected].map(v => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
    return crypto.subtle.timingSafeEqual(a, b);
}

// POST /api/push-subscribe – vom Client nach Notification.requestPermission() aufgerufen,
// speichert die PushSubscription (Endpoint + Schlüssel) in KV, damit wir sie später
// ansprechen können. Kein Klarname/keine persönlichen Daten enthalten.
async function handleSubscribe(request, env) {
    if (!env.PUSH_SUBS) return json({ error: 'PUSH_SUBS KV-Namespace ist nicht gebunden – siehe wrangler.jsonc' }, 500);
    // Nur Anfragen von der eigenen App-Seite (Browser setzen Origin bei POST immer).
    if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
    const sub = await readJsonLimited(request);
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return json({ error: 'invalid subscription' }, 400);
    let ep;
    try { ep = new URL(sub.endpoint); } catch (e) { return json({ error: 'invalid endpoint' }, 400); }
    if (ep.protocol !== 'https:' || !PUSH_HOSTS.some(re => re.test(ep.hostname))) return json({ error: 'endpoint not allowed' }, 400);
    if (!isB64url(sub.keys.p256dh, 80, 100) || !isB64url(sub.keys.auth, 16, 32)) return json({ error: 'invalid keys' }, 400);
    const key = await sha256Hex(ep.href);
    if (!(await env.PUSH_SUBS.get(key))) {
        const existing = await env.PUSH_SUBS.list({ limit: MAX_SUBS });
        if (existing.keys.length >= MAX_SUBS) return json({ error: 'too many subscriptions' }, 429);
    }
    // Nur die benötigten Felder speichern, keine beliebigen Zusatzdaten.
    await env.PUSH_SUBS.put(key, JSON.stringify({ endpoint: ep.href, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }));
    return json({ ok: true });
}

// POST /api/push-send – schickt eine Push-Nachricht an alle gespeicherten Subscriptions.
// Geschützt durch ein Shared Secret (Header X-Push-Secret), damit nicht jeder x-beliebige
// Person Benachrichtigungen an deine Geräte schicken kann. Secret setzen mit:
//   npx wrangler secret put PUSH_SEND_SECRET
async function handleSend(request, env) {
    if (!env.PUSH_SEND_SECRET) return json({ error: 'PUSH_SEND_SECRET ist nicht gesetzt (wrangler secret put PUSH_SEND_SECRET)' }, 500);
    if (!(await secretMatches(request.headers.get('X-Push-Secret'), env.PUSH_SEND_SECRET))) return json({ error: 'unauthorized' }, 401);
    if (!env.VAPID_PRIVATE_KEY) return json({ error: 'VAPID_PRIVATE_KEY ist nicht gesetzt (wrangler secret put VAPID_PRIVATE_KEY)' }, 500);
    if (!env.PUSH_SUBS) return json({ error: 'PUSH_SUBS KV-Namespace ist nicht gebunden – siehe wrangler.jsonc' }, 500);

    const body = (await readJsonLimited(request)) || {};
    // Ziel-Link nur innerhalb der App (der Service Worker prüft das zusätzlich).
    const origin = new URL(request.url).origin;
    let url = './';
    try { const u = new URL(clip(body.url, './', 500), origin + '/'); if (u.origin === origin) url = u.pathname + u.search + u.hash; } catch (e) {}
    const payload = {
        title: clip(body.title, 'Trip Planer', 80),
        body: clip(body.body, '', 240),
        url,
        tag: clip(body.tag, 'push', 40)
    };

    let sent = 0, failed = 0, removed = 0;
    let cursor;
    do {
        const list = await env.PUSH_SUBS.list({ cursor });
        for (const k of list.keys) {
            const raw = await env.PUSH_SUBS.get(k.name);
            if (!raw) continue;
            try {
                const sub = JSON.parse(raw);
                await sendWebPush(sub, payload, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, VAPID_SUBJECT);
                sent++;
            } catch (e) {
                failed++;
                // 404/410 = Subscription ist abgelaufen/wurde vom Browser widerrufen -> aufräumen
                if (e.status === 404 || e.status === 410) { await env.PUSH_SUBS.delete(k.name); removed++; }
            }
        }
        cursor = list.cursor;
    } while (cursor);

    return json({ sent, failed, removed });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === '/api/push-subscribe' && request.method === 'POST') return handleSubscribe(request, env);
        if (url.pathname === '/api/push-send' && request.method === 'POST') return handleSend(request, env);
        if (url.pathname === '/api/share' || url.pathname.startsWith('/api/share/')) return handleShare(request, env, url);
        return env.ASSETS.fetch(request);
    }
};
