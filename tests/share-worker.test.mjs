import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// share.js ist ein ES-Modul mit export – als data:-URL importieren.
const src = readFileSync(new URL('../worker/share.js', import.meta.url), 'utf8');
const { handleShare } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const kv = () => { const m = new Map(); return { m, put: async (k, v, o) => { m.set(k, { v, o }); }, get: async k => (m.has(k) ? m.get(k).v : null) }; };
const call = (env, method, path, body, origin = 'https://x.test') => {
    const u = new URL('https://x.test' + path);
    return handleShare(new Request(u, { method, body, headers: origin ? { origin } : {} }), env, u);
};

test('Share-Worker: speichern und lesen', async () => {
    const env = { SHARES: kv() };
    const blob = new Uint8Array(100).fill(7);
    const res = await call(env, 'POST', '/api/share', blob);
    assert.equal(res.status, 200);
    const { id } = await res.json();
    assert.match(id, /^[A-Za-z0-9_-]{16,32}$/);
    assert.equal(env.SHARES.m.get('s:' + id).o.expirationTtl, 30 * 86400);
    const got = await call(env, 'GET', '/api/share/' + id);
    assert.equal(got.status, 200);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), blob);
});
test('Share-Worker: Fremd-Origin, zu groß, zu klein, unbekannt, ungültige ID', async () => {
    const env = { SHARES: kv() };
    assert.equal((await call(env, 'POST', '/api/share', new Uint8Array(100), 'https://evil.test')).status, 403);
    assert.equal((await call(env, 'POST', '/api/share', new Uint8Array(100), null)).status, 403);
    assert.equal((await call(env, 'POST', '/api/share', new Uint8Array(512 * 1024 + 1))).status, 413);
    assert.equal((await call(env, 'POST', '/api/share', new Uint8Array(5))).status, 400);
    assert.equal((await call(env, 'GET', '/api/share/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
    assert.equal((await call(env, 'GET', '/api/share/x')).status, 400);
    assert.equal((await call(env, 'DELETE', '/api/share/AAAAAAAAAAAAAAAAAAAAAA')).status, 405);
    assert.equal((await call({}, 'GET', '/api/share/AAAAAAAAAAAAAAAAAAAAAA')).status, 500);
});
