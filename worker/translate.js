// Übersetzung nach Deutsch über Cloudflare Workers AI (Modell m2m100, kostenloses Tageskontingent
// des Kontos). Zweite Stufe in der App nach Google Translate, vor MyMemory und der KI-Zusammenfassung.
// Nur die eigene Web-App und die Android-App dürfen fragen; Texte werden nicht gespeichert.
// POST /api/translate  {"texts":["…"], "sources":["ja"|"en"|"ko"|"zh"|…]}  →  {"texts":["…"]}
export const NATIVE_ORIGIN = 'https://localhost';
const MODEL = '@cf/meta/m2m100-1.2b';
const MAX_TEXTS = 20, MAX_CHARS = 6000;
const LANG_RE = /^[a-z]{2}$/;

// m2m100 gerät gelegentlich in eine Endlosschleife ("Tokyo-Tokyo-Tokyo-…"): solche Ergebnisse verwerfen.
export const degenerate = (out, src) => /(\p{L}{2,})(?:[\s\-–,.·]+\1){3,}/iu.test(out) || (out.length > 60 && out.length > src.length * (/[\u3040-\u9fff\uac00-\ud7af]/.test(src) ? 10 : 5));

export const corsFor = request => request.headers.get('Origin') === NATIVE_ORIGIN
    ? { 'access-control-allow-origin': NATIVE_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' }
    : {};
export const json = (obj, status, request) => new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, corsFor(request))
});

export async function handleTranslate(request, env, url) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(request) });
    if (request.method !== 'POST') return json({ error: 'method' }, 405, request);
    const origin = request.headers.get('Origin');
    if (origin !== url.origin && origin !== NATIVE_ORIGIN) return json({ error: 'forbidden' }, 403, request);
    if (!env.AI) return json({ error: 'AI-Binding fehlt – siehe wrangler.jsonc' }, 501, request);

    const raw = await request.text();
    if (raw.length > MAX_CHARS * 2) return json({ error: 'Zu groß' }, 413, request);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ error: 'Ungültige Daten' }, 400, request); }
    const texts = Array.isArray(body?.texts) ? body.texts.slice(0, MAX_TEXTS).map(t => String(t ?? '').slice(0, 1500)) : null;
    if (!texts || !texts.length || texts.join('').length > MAX_CHARS) return json({ error: 'Ungültige Daten' }, 400, request);
    const sources = texts.map((_, i) => {
        const s = Array.isArray(body.sources) ? String(body.sources[i] || '') : '';
        return LANG_RE.test(s) ? s : 'en';
    });

    // Das Modell kennt keinen synchronen Stapelbetrieb: je Text ein Aufruf, parallel.
    const out = await Promise.all(texts.map(async (text, i) => {
        if (!text.trim() || sources[i] === 'de') return text;
        try {
            const r = await env.AI.run(MODEL, { text, source_lang: sources[i], target_lang: 'de' });
            const t = typeof r?.translated_text === 'string' ? r.translated_text.trim() : '';
            return t && !degenerate(t, text) ? t : null;
        } catch (e) { return null; }
    }));
    if (out.every(t => t === null)) return json({ error: 'Übersetzung nicht verfügbar' }, 503, request);
    return json({ texts: out }, 200, request);
}
