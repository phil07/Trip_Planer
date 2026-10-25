// Unit-Tests für den ICS-Generator (Trip-Planer/features/calendar.js).
// Ausführen: node --test tests/calendar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildIcs, escapeText, foldLine, parseTime } = require('../Trip-Planer/features/calendar.js');

const NOW = new Date(Date.UTC(2026, 9, 18, 7, 5, 9));
const bytes = s => Buffer.byteLength(s, 'utf8');
// Entfaltet nach RFC 5545 §3.1 (CRLF + Leerzeichen entfernen).
const unfold = ics => ics.replace(/\r\n[ \t]/g, '');
const lines = ics => unfold(ics).split('\r\n');
const events = ics => unfold(ics).split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
const field = (ev, name) => (ev.split('\r\n').find(l => l.startsWith(name + ':') || l.startsWith(name + ';')) || '');

const DATA = {
    tripName: 'Japan, Teil 1; Test\\Reise',
    startDate: '2026-11-01',
    places: [
        { id: 1, name: 'Tokio (Ankunft)', nights: 3, hotel: 'Hotel Gracery, Shinjuku; 8F', transport: 'Ausstehend', lat: 35.69, lng: 139.7 },
        { id: 2, name: 'Kyoto', nights: 2, hotel: '', transport: 'Zug', lat: 35.01, lng: 135.77 },
        { id: 3, name: 'Osaka (Abreise)', nights: 0, hotel: 'Kansai Airport', transport: 'Zug' }
    ],
    acts: [
        { id: 11, title: 'Senso-ji', type: '🏯 Sehenswürdigkeit', topPlace: 'Tokio', day: '2026-11-02', time: '09:30', lat: 35.7148, lng: 139.7967 },
        { id: 12, title: 'Ramen, scharf', type: '🍣 Restaurant', topPlace: 'Tokio', day: '2026-11-02', desc: 'Zeile 1\nZeile 2' },
        { id: 13, title: 'Falscher Tag', topPlace: 'Kyoto', day: '2026-11-01' }, // außerhalb des Kyoto-Aufenthalts
        { id: 14, title: 'Spät', topPlace: 'Kyoto', day: '2026-11-05', time: '23:30', duration: 90 }
    ]
};

test('escapeText: \\ ; , und Zeilenumbrüche', () => {
    assert.equal(escapeText('a\\b;c,d\ne\r\nf\rg'), 'a\\\\b\\;c\\,d\\ne\\nf\\ng');
    assert.equal(escapeText('Doppelpunkt: bleibt'), 'Doppelpunkt: bleibt');
    assert.equal(escapeText('x\u0007y\tz'), 'xy\tz');
    assert.equal(escapeText(null), '');
});

test('foldLine: max. 75 Oktette, Fortsetzung mit Leerzeichen, ASCII', () => {
    const line = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1);
    parts.forEach((p, i) => { assert.ok(bytes(p) <= 75, `Teil ${i} hat ${bytes(p)} Oktette`); if (i) assert.equal(p[0], ' '); });
    assert.equal(bytes(parts[0]), 75);
    assert.equal(folded.replace(/\r\n /g, ''), line);
    assert.equal(foldLine('KURZ:abc'), 'KURZ:abc');
});

test('foldLine: Umlaute und Emojis werden nicht zerteilt', () => {
    for (const unit of ['ä', 'Ü', 'ß', '東京', '🏯', '👨‍👩‍👧', '🇯🇵', 'é']) {
        for (let prefixLen = 0; prefixLen < 5; prefixLen++) {
            const line = 'SUMMARY:' + 'a'.repeat(prefixLen) + unit.repeat(60);
            const folded = foldLine(line);
            const parts = folded.split('\r\n');
            parts.forEach((p, i) => {
                assert.ok(bytes(p) <= 75, `${unit}: Teil ${i} hat ${bytes(p)} Oktette`);
                // Ein zerteiltes UTF-8-Zeichen/Surrogatpaar ergäbe U+FFFD bzw. einen einsamen Surrogat.
                assert.equal(Buffer.from(p, 'utf8').toString('utf8'), p);
                assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p), 'einsamer Surrogat');
            });
            assert.equal(folded.replace(/\r\n /g, ''), line, 'Entfalten ergibt Original');
        }
    }
});

test('buildIcs: Grundgerüst, CRLF, Faltung aller Zeilen', () => {
    const { ics, count } = buildIcs(DATA, { now: NOW });
    assert.equal(count, 6); // 3 Stationen + 3 gültige Aktivitäten
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(ics), 'nur CRLF');
    ics.split('\r\n').forEach(l => assert.ok(bytes(l) <= 75, `zu lang: ${l}`));
    const L = lines(ics);
    assert.ok(L.includes('PRODID:-//Trip-Planer//Kalender-Export//DE'));
    assert.ok(L.includes('X-WR-CALNAME:Japan\\, Teil 1\\; Test\\\\Reise'));
    assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, L.filter(l => l === 'END:VEVENT').length);
    events(ics).forEach(ev => {
        assert.match(field(ev, 'DTSTAMP'), /^DTSTAMP:20261018T070509Z$/);
        assert.match(field(ev, 'UID'), /^UID:[A-Za-z0-9._-]+@trip-planer\.app$/);
    });
});

test('buildIcs: Stationen ganztägig über Startdatum + kumulierte Nächte, Hotel als LOCATION', () => {
    const ev = events(buildIcs(DATA, { now: NOW, includeActivities: false }).ics);
    assert.equal(ev.length, 3);
    assert.equal(field(ev[0], 'DTSTART'), 'DTSTART;VALUE=DATE:20261101');
    assert.equal(field(ev[0], 'DTEND'), 'DTEND;VALUE=DATE:20261104');
    assert.equal(field(ev[0], 'SUMMARY'), 'SUMMARY:📍 Tokio');
    assert.equal(field(ev[0], 'LOCATION'), 'LOCATION:Hotel Gracery\\, Shinjuku\\; 8F');
    assert.equal(field(ev[1], 'DTSTART'), 'DTSTART;VALUE=DATE:20261104');
    assert.equal(field(ev[1], 'DTEND'), 'DTEND;VALUE=DATE:20261106');
    assert.equal(field(ev[1], 'LOCATION'), 'LOCATION:Kyoto'); // ohne Hotel: Stadtname
    assert.match(field(ev[1], 'DESCRIPTION'), /Anreise: Zug/);
    // 0 Nächte → mindestens ein Tag (DTEND exklusiv)
    assert.equal(field(ev[2], 'DTSTART'), 'DTSTART;VALUE=DATE:20261106');
    assert.equal(field(ev[2], 'DTEND'), 'DTEND;VALUE=DATE:20261107');
    assert.ok(!buildIcs(DATA, { now: NOW, includeActivities: false }).ics.includes('BEGIN:VTIMEZONE'));
});

test('buildIcs: Aktivitäten mit Uhrzeit (TZID Asia/Tokyo + VTIMEZONE) und ganztägig', () => {
    const { ics } = buildIcs(DATA, { now: NOW });
    assert.ok(ics.includes('BEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo\r\n'));
    assert.ok(ics.indexOf('END:VTIMEZONE') < ics.indexOf('BEGIN:VEVENT'));
    const ev = events(ics).slice(3);
    assert.deepEqual(ev.map(e => field(e, 'SUMMARY')), ['SUMMARY:Senso-ji', 'SUMMARY:Ramen\\, scharf', 'SUMMARY:Spät']);
    assert.equal(field(ev[0], 'DTSTART'), 'DTSTART;TZID=Asia/Tokyo:20261102T093000');
    assert.equal(field(ev[0], 'DTEND'), 'DTEND;TZID=Asia/Tokyo:20261102T103000');
    assert.equal(field(ev[0], 'GEO'), 'GEO:35.7148;139.7967');
    assert.equal(field(ev[1], 'DTSTART'), 'DTSTART;VALUE=DATE:20261102');
    assert.equal(field(ev[1], 'DTEND'), 'DTEND;VALUE=DATE:20261103');
    assert.match(field(ev[1], 'DESCRIPTION'), /Zeile 1\\nZeile 2/);
    // über Mitternacht
    assert.equal(field(ev[2], 'DTSTART'), 'DTSTART;TZID=Asia/Tokyo:20261105T233000');
    assert.equal(field(ev[2], 'DTEND'), 'DTEND;TZID=Asia/Tokyo:20261106T010000');
});

test('buildIcs: floating Zeit ohne TZID, stabile UIDs, Robustheit', () => {
    const a = buildIcs(DATA, { now: NOW, tzid: '' }).ics;
    assert.ok(!a.includes('VTIMEZONE') && !a.includes('TZID'));
    assert.ok(unfold(a).includes('DTSTART:20261102T093000\r\n'));
    const uids = s => events(s).map(e => field(e, 'UID'));
    const b = buildIcs(DATA, { now: new Date(Date.UTC(2027, 0, 1)) }).ics;
    assert.deepEqual(uids(a), uids(b), 'UIDs unabhängig vom Exportzeitpunkt');
    assert.equal(new Set(uids(a)).size, uids(a).length, 'UIDs eindeutig');
    // manipulierte Daten
    const evil = buildIcs({ startDate: 'kaputt', places: [{ id: 'x\r\nBEGIN:VEVENT', name: '<img>' }], acts: [{ id: '1;2', title: 'a\r\nEND:VCALENDAR', day: '2026-11-01' }] }, { now: NOW }).ics;
    assert.ok(!/\r\nEND:VCALENDAR\r\n(?!$)/.test(evil), 'keine Zeilen-Injektion');
    assert.equal((evil.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(evil, /UID:act-1-2@trip-planer\.app/);
    assert.doesNotThrow(() => buildIcs(null));
});

test('buildIcs: lange Beschreibung mit Umlauten/Emojis bleibt nach Entfalten identisch', () => {
    const desc = 'Grüße aus Kyōto 🍵🏯 – Öffnungszeiten: Mo–Fr, 9–17 Uhr; Eintritt ¥500. '.repeat(5);
    const { ics } = buildIcs({ startDate: '2026-11-01', places: [{ id: 1, name: 'Kyoto', nights: 1 }],
        acts: [{ id: 7, title: 'Tee 🍵', topPlace: 'Kyoto', day: '2026-11-01', desc }] }, { now: NOW });
    ics.split('\r\n').forEach(l => {
        assert.ok(bytes(l) <= 75);
        assert.equal(Buffer.from(l, 'utf8').toString('utf8'), l);
    });
    const d = field(events(ics)[1], 'DESCRIPTION');
    assert.ok(d.includes(escapeText(desc.trim())));
});

test('parseTime', () => {
    assert.deepEqual(parseTime('9:05'), { h: 9, m: 5 });
    assert.deepEqual(parseTime('0905'), { h: 9, m: 5 });
    assert.equal(parseTime('24:00'), null);
    assert.equal(parseTime(''), null);
    assert.equal(parseTime(undefined), null);
});
