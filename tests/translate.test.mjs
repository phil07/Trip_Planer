import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTranslate } from '../worker/translate.js';

const url = new URL('https://japan.example.workers.dev/api/translate');
const req = (body, origin = url.origin) => new Request(url, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('translate: übersetzt mit Quellsprache und lässt Deutsch unverändert', async () => {
    const calls = [];
    const env = { AI: { run: async (model, input) => { calls.push(input); return { translated_text: 'DE:' + input.text }; } } };
    const res = await handleTranslate(req({ texts: ['こんにちは', 'Hallo Welt'], sources: ['ja', 'de'] }), env, url);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).texts, ['DE:こんにちは', 'Hallo Welt']);
    assert.deepEqual(calls, [{ text: 'こんにちは', source_lang: 'ja', target_lang: 'de' }]);
});

test('translate: fremde Herkunft abgelehnt, Android-App erlaubt mit CORS', async () => {
    const env = { AI: { run: async (m, i) => ({ translated_text: i.text }) } };
    assert.equal((await handleTranslate(req({ texts: ['a'] }, 'https://evil.example'), env, url)).status, 403);
    const ok = await handleTranslate(req({ texts: ['a'] }, 'https://localhost'), env, url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');
});

test('translate: ohne AI-Binding 501, alle Fehler 503, Unsinn 400', async () => {
    assert.equal((await handleTranslate(req({ texts: ['a'] }), {}, url)).status, 501);
    const broken = { AI: { run: async () => { throw new Error('quota'); } } };
    assert.equal((await handleTranslate(req({ texts: ['a'] }), broken, url)).status, 503);
    assert.equal((await handleTranslate(req({ nope: 1 }), broken, url)).status, 400);
});

test('translate: Endlosschleifen des Modells werden verworfen', async () => {
    const env = { AI: { run: async (m, i) => ({ translated_text: i.text === 'x' ? 'Der Garten von Tokyo-Tokyo-Tokyo-Tokyo-Tokyo-' : 'Ostgarten' }) } };
    const res = await handleTranslate(req({ texts: ['x', '東御苑'], sources: ['ja', 'ja'] }), env, url);
    assert.deepEqual((await res.json()).texts, [null, 'Ostgarten']);
});
