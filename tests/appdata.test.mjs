// Tests für die Datenaufbereitung in app.js: Normalisierung von Stationen/Aktivitäten, Backup-Prüfung,
// Datumsrechnung, Länder-Namen, Packlisten. Lädt die echten Funktionen (keine Kopie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers.mjs';

// Objekte aus der vm haben andere Prototypen – für deepEqual über JSON angleichen.
const J = x => JSON.parse(JSON.stringify(x));

const A = loadApp({
    consts: ['clampNights', 'isObj', 'finiteOr', 'TAXI_MAX', 'taxiStr', 'isHHMM', 'HOURS_SOURCES', 'RATING_SOURCES',
        'TRANSPORT_MODES', 'COUNTRY_LANG', 'COUNTRY_ALIASES', 'COUNTRY_LANG_LOWER', 'clean', 'PACK_MAX', 'packClean',
        'EXPORT_KEYS', 'canonCountry'],
    funcs: ['normPlace', 'normTransit', 'normAct', 'normHours', 'normRating', 'normTransport', 'localISO', 'parseISODate',
        'nightsWord', 'distanceKm', 'esc', 'packNormItems', 'validateBackup'],
    also: ['PACK_TEXT_MAX'],
    extra: 'Object.keys(COUNTRY_LANG).forEach(k => { COUNTRY_LANG_LOWER[k.toLowerCase()] = k; });',
});

test('clampNights: 0–365, ganzzahlig, Müll wird 0', () => {
    assert.equal(A.clampNights(3), 3);
    assert.equal(A.clampNights(2.6), 3);
    assert.equal(A.clampNights(-4), 0);
    assert.equal(A.clampNights(9999), 365);
    assert.equal(A.clampNights('abc'), 0);
    assert.equal(A.clampNights(null), 0);
});

test('nightsWord: Singular/Plural', () => {
    assert.equal(A.nightsWord(1), 'Nacht');
    assert.equal(A.nightsWord(0), 'Nächte');
    assert.equal(A.nightsWord(5), 'Nächte');
});

test('localISO/parseISODate: Rundreise ohne Zeitzonen-Versatz', () => {
    const d = A.parseISODate('2026-03-29');
    assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 2); assert.equal(d.getDate(), 29);
    assert.equal(A.localISO(d), '2026-03-29');
    const next = new Date(d); next.setDate(next.getDate() + 1);
    assert.equal(A.localISO(next), '2026-03-30');
    assert.equal(A.localISO(new Date(2026, 0, 5)), '2026-01-05');
});

test('parseISODate: ungültige Eingaben ergeben ein ungültiges Datum', () => {
    assert.ok(isNaN(A.parseISODate('').getTime()));
    assert.ok(isNaN(A.parseISODate(undefined).getTime()));
    assert.ok(isNaN(A.parseISODate('kein datum').getTime()));
});

test('distanceKm: bekannte Strecken und Symmetrie', () => {
    assert.equal(A.distanceKm(50, 8, 50, 8), 0);
    const tokyoOsaka = A.distanceKm(35.681, 139.767, 34.702, 135.495);
    assert.ok(tokyoOsaka > 390 && tokyoOsaka < 410, `Tokio–Osaka ${tokyoOsaka}`);
    assert.ok(Math.abs(tokyoOsaka - A.distanceKm(34.702, 135.495, 35.681, 139.767)) < 1e-9);
});

test('esc: maskiert HTML-Zeichen, null/undefined werden leer', () => {
    assert.equal(A.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(A.esc(null), '');
    assert.equal(A.esc(undefined), '');
    assert.equal(A.esc(5), '5');
});

test('clean: entfernt Ankunft/Abreise-Zusätze', () => {
    assert.equal(A.clean('Tokio (Ankunft)'), 'Tokio');
    assert.equal(A.clean('Osaka (Abreise)'), 'Osaka');
    assert.equal(A.clean('Kyoto'), 'Kyoto');
});

test('normTransport: freie Angaben auf die Auswahl vereinheitlichen, Details bleiben', () => {
    assert.equal(A.normTransport('Bahn'), 'Zug');
    assert.equal(A.normTransport('Shinkansen'), 'Zug');
    assert.equal(A.normTransport('ICE · Sitz 12'), 'Zug · Sitz 12');
    assert.equal(A.normTransport('PKW'), 'Mietwagen');
    assert.equal(A.normTransport('✈️ Flug · LH 714'), 'Flug · LH 714');
    assert.equal(A.normTransport('Fähre'), 'Fähre');
    assert.equal(A.normTransport('Zu Fuß'), 'Zu Fuß');
    assert.equal(A.normTransport('Ausstehend'), 'Ausstehend');
    assert.equal(A.normTransport(''), '');
    assert.equal(A.normTransport(null), '');
});

test('TRANSPORT_MODES: keine eigene Shinkansen-Option', () => {
    assert.deepEqual(J(A.TRANSPORT_MODES.map(m => m.label)), ['Flug', 'Zug', 'Bus', 'Mietwagen', 'Fähre', 'Zu Fuß']);
});

test('normTransit: nur kurze Strings, leer wird null', () => {
    assert.equal(A.normTransit(null), null);
    assert.equal(A.normTransit('x'), null);
    assert.equal(A.normTransit({ train: ' ', dep: 'x', seat: '', note: '' }), null);
    const t = A.normTransit({ train: ' Hikari 503 ', dep: '09:30', seat: '12A', note: 'n'.repeat(500) });
    assert.equal(t.train, 'Hikari 503'); assert.equal(t.dep, '09:30'); assert.equal(t.seat, '12A'); assert.equal(t.note.length, 200);
    assert.equal(A.normTransit({ train: 'a', dep: '9:30' }).dep, '');
});

test('normHours: Ruhetage und Zeitfenster streng validiert', () => {
    assert.equal(A.normHours(null), null);
    assert.equal(A.normHours({}), null);
    assert.equal(A.normHours({ closed: [0, 1, 2, 3, 4, 5, 6] }), null);
    assert.deepEqual(J(A.normHours({ closed: [3, 1, 1, 9, -1, 'x'] })), { closed: [1, 3], from: '', to: '', src: 'manual' });
    assert.deepEqual(J(A.normHours({ from: '09:00', to: '17:30', src: 'OpenStreetMap' })), { closed: [], from: '09:00', to: '17:30', src: 'OpenStreetMap' });
    assert.equal(A.normHours({ from: '09:00', to: '09:00' }), null);
    assert.equal(A.normHours({ from: '25:00', to: '10:00' }), null);
    assert.equal(A.normHours({ closed: [1], src: '<script>' }).src, 'manual');
});

test('normRating: nur bekannte Quellen, Sterne 0–5', () => {
    assert.equal(A.normRating(null), null);
    assert.equal(A.normRating({ stars: 4, source: 'Hacker' }), null);
    assert.equal(A.normRating({ stars: 0, source: 'Google' }), null);
    assert.deepEqual(J(A.normRating({ stars: 9, count: 3.6, source: 'Google' })), { stars: 5, count: 4, source: 'Google' });
});

test('normPlace: Defaults, Nächte begrenzt, Koordinaten und Checkout', () => {
    const p = A.normPlace({ name: 'Tokio', nights: '4', lat: '35.6', lng: 'x', checkout: '10:30' }, 0);
    assert.equal(p.name, 'Tokio'); assert.equal(p.nights, 4);
    assert.equal(p.lat, 35.6); assert.equal(p.lng, 0);
    assert.equal(p.hotelLat, null); assert.equal(p.transport, 'Ausstehend');
    assert.equal(p.checkout, '10:30'); assert.equal(p.transit, null);
    assert.equal(A.normPlace({ name: 'X', checkout: '25:99' }, 0).checkout, '');
    assert.equal(A.normPlace({ name: 'X', transport: 'Bahn' }, 0).transport, 'Zug');
    assert.equal(A.normPlace({}, 0).name, '');
});

test('normAct: Felder bereinigt, unsichere Bild-URLs verworfen', () => {
    const a = A.normAct({ title: 'Tempel', day: '2026-10-25', time: '09:15', imgUrl: 'javascript:alert(1)', favorite: 1 }, 0);
    assert.equal(a.title, 'Tempel'); assert.equal(a.day, '2026-10-25'); assert.equal(a.time, '09:15');
    assert.equal(a.imgUrl, null); assert.equal(a.favorite, true);
    assert.equal(A.normAct({ imgUrl: 'https://x.test/a.jpg' }, 0).imgUrl, 'https://x.test/a.jpg');
    assert.equal(A.normAct({ day: '25.10.2026', time: '9:15' }, 0).day, '');
    assert.equal(A.normAct({ time: '9:15' }, 0).time, '');
    assert.equal(A.normAct({}, 0).notes, '');
});

test('canonCountry: Aliase und Schreibweisen auf den kanonischen Namen', () => {
    assert.equal(A.canonCountry('italy'), 'Italien');
    assert.equal(A.canonCountry('  JAPAN '), 'Japan');
    assert.equal(A.canonCountry('Italien'), 'Italien');
    assert.equal(A.canonCountry('Atlantis'), 'Atlantis');
    assert.equal(A.canonCountry(''), '');
    assert.equal(A.canonCountry(null), '');
});

test('COUNTRY_LANG: jedes Land hat eine Sprache', () => {
    const entries = Object.entries(A.COUNTRY_LANG);
    assert.ok(entries.length >= 40);
    for (const [name, v] of entries) assert.ok(v && typeof v.lang === 'string' && v.lang.length >= 2, `${name} ohne lang`);
});

test('packNormItems: bereinigt, ohne Duplikate/leere Texte, gedeckelt', () => {
    const out = A.packNormItems([
        { id: 'a', e: '🧳', t: '  Pass  ', done: 1 }, { id: 'a', t: 'Doppelt' }, { id: 'b', t: '   ' },
        { id: '', t: 'ohne id' }, { id: 'c', t: 'Ladekabel', e: '' }, 'kaputt', null,
    ]);
    assert.deepEqual(J(out.map(x => x.id)), ['a', 'c']);
    assert.equal(out[0].t, 'Pass'); assert.equal(out[0].done, true); assert.equal(out[1].e, '📌');
    assert.ok(!('c' in out[0]), 'keine Kategorien mehr');
    const many = Array.from({ length: 400 }, (_, i) => ({ id: 'i' + i, t: 'x' + i }));
    assert.equal(A.packNormItems(many).length, A.PACK_MAX);
    assert.equal(A.packNormItems([{ id: 'l', t: 'y'.repeat(300) }])[0].t.length, A.PACK_TEXT_MAX);
});

test('validateBackup: akzeptiert gültige, lehnt kaputte Sicherungen ab', () => {
    const ok = { app: 'trip-planer', data: { tp_places: JSON.stringify([{ name: 'A' }]), tp_start: '2026-10-24', fremd: 'x' } };
    const out = A.validateBackup(ok);
    assert.deepEqual(J(Object.keys(out).sort()), ['tp_places', 'tp_start']);
    // Sicherung aus der Zeit vor v170: Präfix jp26_ statt tp_
    const alt = A.validateBackup({ app: 'trip-planer', data: { jp26_places: JSON.stringify([{ name: 'A' }]), jp26_start: '2026-10-24' } });
    assert.deepEqual(J(Object.keys(alt).sort()), ['tp_places', 'tp_start']);
    assert.equal(A.validateBackup(null), null);
    assert.equal(A.validateBackup({ app: 'andere', data: {} }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: {} }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_places: 5 } }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_places: '{"a":1}' } }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_places: '[1]' } }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_places: '[{' } }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_start: 'quatsch' } }), null);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_budget: '{"entries":[],"travelers":[]}' } }).tp_budget.length > 0, true);
    assert.equal(A.validateBackup({ app: 'trip-planer', data: { tp_budget: '{"entries":5}' } }), null);
});
