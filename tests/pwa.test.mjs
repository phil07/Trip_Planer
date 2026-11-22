// PWA und APK nutzen denselben Ordner Trip-Planer/. Die PWA braucht zusätzlich jede geladene Datei
// im Offline-Speicher des Service Workers – sonst fehlt sie ohne Netz. Ausführen: node --test tests/pwa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../Trip-Planer/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const sw = readFileSync(new URL('sw.js', dir), 'utf8');
const precache = new Set([...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));

test('jedes Skript und Stylesheet aus index.html liegt im Offline-Speicher', () => {
    const files = [...html.matchAll(/(?:src|href)="([^"#:?]+\.(?:js|css))"/g)].map(m => m[1]);
    assert.ok(files.length > 10);
    const missing = [...new Set(files)].filter(f => !precache.has('./' + f));
    assert.deepEqual(missing, []);
});
test('jede Datei im Offline-Speicher existiert', () => {
    const missing = [...precache].filter(u => u !== './' && !/^\.\/(datenschutz|nutzungsbedingungen|impressum)$/.test(u))
        .filter(u => !existsSync(new URL(u.slice(2), dir)));
    assert.deepEqual(missing, []);
});
test('Bibliotheken, die erst bei Bedarf geladen werden, kommen von zwischengespeicherten Hosts', () => {
    const hosts = sw.match(/const CDN_HOSTS = \[([^\]]*)\]/)[1];
    for (const h of ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']) assert.ok(hosts.includes(h), h);
});
