// Unit-Tests: /api/extract (Buchungsdaten per Workers AI). Ausführen: node --test tests/extract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleExtract, redact } from '../worker/extract.js';

const url = new URL('https://trip.example/api/extract');
const req = (body, origin = url.origin) => new Request(url, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('extract: liefert bereinigte Flugdaten, Text ohne persönliche Angaben', async () => {
    let seen;
    const env = { AI: { run: async (model, input) => { seen = input; return { response: { number: 'GK 513', dep: '15:25', terminal: '3', gate: '', seat: '', from: 'NRT', to: 'FUK', date: '2026-11-28' } }; } } };
    const res = await handleExtract(req({ kind: 'transit', text: 'Jetstar Japan 513\n15:25 uhr\nAbflug\nmax@example.com\n+49 769 139 7119' }), env, url);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.number, 'GK 513'); assert.equal(data.dep, '15:25'); assert.equal(data.terminal, '3');
    assert.ok(!/example\.com|7119/.test(seen.messages[1].content));
    assert.equal(seen.response_format.type, 'json_schema');
});
test('extract: zweites Modell springt ein, Unsinn verworfen, fremde Herkunft 403', async () => {
    let n = 0;
    const env = { AI: { run: async () => { if (n++ === 0) throw new Error('busy'); return { response: '{"number":"","dep":"25 Uhr"}' }; } } };
    const res = await handleExtract(req({ kind: 'transit', text: 'irgendein Text ohne Flug' }), env, url);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data, null);
    assert.equal((await handleExtract(req({ kind: 'transit', text: 'Hallo Welt Text' }, 'https://evil.example'), env, url)).status, 403);
    assert.equal((await handleExtract(req({ kind: 'nope', text: 'Hallo Welt Text' }), env, url)).status, 400);
    assert.equal((await handleExtract(req({ kind: 'hotel', text: 'Hallo Welt Text' }), {}, url)).status, 501);
});
test('redact (Worker)', () => {
    assert.equal(redact('Name: Max Muster\nFlug LH 716').trim(), 'Flug LH 716');
});
test('extract: Buchungsklasse ist kein Sitz, Ankunfts-Gate mit Text verworfen', async () => {
    const env = { AI: { run: async () => ({ response: { number: 'GK 513', dep: '15:25', terminal: 'Terminal 3', gate: 'D, Gate 1', seat: 'Q' } }) } };
    const { data } = await (await handleExtract(req({ kind: 'transit', text: 'Jetstar Japan 513 Abflug' }), env, url)).json();
    assert.equal(data.terminal, '3'); assert.equal(data.gate, ''); assert.equal(data.seat, '');
});
test('extract: Uhrzeit tolerant ("3:25 PM", "15.25 Uhr")', async () => {
    for (const [dep, want] of [['3:25 PM', '15:25'], ['15.25 Uhr', '15:25'], ['12:05 am', '00:05']]) {
        const env = { AI: { run: async () => ({ response: { number: 'GK 513', dep } }) } };
        const { data } = await (await handleExtract(req({ kind: 'transit', text: 'Jetstar Japan 513 Abflug' }), env, url)).json();
        assert.equal(data.dep, want);
    }
});
test('extract: Ankunftszeit wird übernommen', async () => {
    const env = { AI: { run: async () => ({ response: { flight_or_train_number: 'GK 513', departure_time: '15:25', arrival_time: '5:55 PM' } }) } };
    const { data } = await (await handleExtract(req({ kind: 'transit', text: 'Jetstar Japan 513 Abflug' }), env, url)).json();
    assert.equal(data.dep, '15:25'); assert.equal(data.arr, '17:55');
});
