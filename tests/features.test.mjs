// Tests für die Feature-Module: Öffnungszeiten, Verbindungen, Notfall, Wetter, Erinnerungen, Teilen.
// Lädt die echten Skripte aus Trip-Planer/features in eine vm mit Fake-Browser (siehe helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFeature, appPrelude, makeStorage, J } from './helpers.mjs';

const prelude = appPrelude({
    consts: ['isObj', 'finiteOr', 'isHHMM', 'HOURS_SOURCES', 'TRANSPORT_MODES', 'clean', 'ico', 'readJsonKey_', 'escHtml'].filter(n => n !== 'readJsonKey_'),
    funcs: ['distanceKm', 'parseISODate', 'localISO', 'esc', 'normHours', 'transportMode', 'normTransport', 'readJsonKey', 'writeJson'],
}) + '\nvar places = [], computedData = [], tripCountry = "";\nfunction safeSetItem(k, v) { localStorage.setItem(k, v); return true; }\n';

// ───────────────────────── Öffnungszeiten ─────────────────────────
const OH = loadFeature('openinghours', ['fromOsm', 'issues', 'inWindow', 'parseDaySel'], {}, prelude);
const osm = s => { const r = OH.t.fromOsm(s); return r && J(r); };

test('fromOsm: Standardformen', () => {
    assert.deepEqual(osm('Tu-Su 09:30-17:00; Mo off'), { closed: [1], from: '09:30', to: '17:00', src: 'OpenStreetMap' });
    assert.deepEqual(osm('Mo-Fr 10:00-18:00; Sa,Su 10:00-17:00'), { closed: [], from: '10:00', to: '18:00', src: 'OpenStreetMap' });
    assert.deepEqual(osm('09:00-17:00'), { closed: [], from: '09:00', to: '17:00', src: 'OpenStreetMap' });
    assert.deepEqual(osm('10:00-14:00,17:00-22:00'), { closed: [], from: '10:00', to: '22:00', src: 'OpenStreetMap' });
});
test('fromOsm: Ruhetage Samstag/Sonntag', () => {
    assert.deepEqual(osm('Mo-Fr 08:00-16:00').closed, [0, 6]);
});
test('fromOsm: Wochenend-Bereich Fr-Mo läuft zyklisch', () => {
    assert.deepEqual(osm('Fr-Mo 10:00-18:00').closed, [2, 3, 4]);
});
test('fromOsm: über Mitternacht und 24:00', () => {
    assert.equal(osm('Mo-Su 18:00-02:00').to, '02:00');
    assert.equal(osm('Mo-Su 08:00-24:00').to, '23:59');
});
test('fromOsm: Feiertags-Regeln werden übersprungen', () => {
    assert.deepEqual(osm('Mo-Fr 09:00-17:00; PH off').closed, [0, 6]);
});
test('fromOsm: Unverständliches oder Mehrdeutiges ergibt null', () => {
    for (const s of ['24/7', '', '   ', null, 5, 'Jan-Mar Mo 09:00-10:00', 'Mo-Fr', 'sunrise-sunset', 'PH off', 'x'.repeat(600), 'Mo-Fr 25:00-26:00']) {
        assert.equal(OH.t.fromOsm(s), null, `sollte null sein: ${s}`);
    }
});
test('inWindow: normal und über Mitternacht', () => {
    assert.equal(OH.t.inWindow('12:00', { from: '09:00', to: '17:00' }), true);
    assert.equal(OH.t.inWindow('18:00', { from: '09:00', to: '17:00' }), false);
    assert.equal(OH.t.inWindow('01:00', { from: '18:00', to: '02:00' }), true);
    assert.equal(OH.t.inWindow('12:00', { from: '18:00', to: '02:00' }), false);
});
test('issues: Ruhetag, Zeitfenster, Museum am Montag', () => {
    const mon = '2026-10-26', tue = '2026-10-27'; // 26.10.2026 = Montag
    const h = { closed: [1], from: '09:00', to: '17:00', src: 'manual' };
    assert.equal(OH.t.issues({ day: mon, hours: h })[0].text, 'Ruhetag am Montag');
    assert.match(OH.t.issues({ day: tue, time: '20:00', hours: h })[0].text, /Außerhalb der Öffnungszeit \(09:00–17:00 Uhr\)/);
    assert.deepEqual(J(OH.t.issues({ day: tue, time: '10:00', hours: h })), []);
    assert.equal(OH.t.issues({ day: mon, type: 'Museum', title: 'Kunstmuseum' })[0].level, 'info');
    assert.deepEqual(J(OH.t.issues({ day: tue, type: 'Museum', title: 'Kunstmuseum' })), []);
    assert.deepEqual(J(OH.t.issues({ title: 'ohne Tag', hours: h })), []);
    assert.deepEqual(J(OH.t.issues({ day: 'kaputt', hours: h })), []);
    assert.deepEqual(J(OH.t.issues(null)), []);
});

// ───────────────────────── Verbindungen ─────────────────────────
const TR = loadFeature('transit', ['estimate', 'estimateFor', 'fmtDuration', 'fmtKm', 'endpoint', 'isJapan', 'summaryText', 'connectionHtml', 'MODES', 'legInfo'], {}, prelude);
const TOKYO = { lat: 35.681, lng: 139.767 }, OSAKA = { lat: 34.702, lng: 135.495 }, BERLIN = { lat: 52.52, lng: 13.405 }, ROM = { lat: 41.9, lng: 12.5 };
const km = (a, b) => 6371 * 2 * Math.asin(Math.sqrt(Math.sin((b.lat - a.lat) * Math.PI / 360) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin((b.lng - a.lng) * Math.PI / 360) ** 2));

test('fmtDuration: auf 5 Minuten gerundet, Stunden und Minuten', () => {
    assert.equal(TR.t.fmtDuration(0), '5 Min.');
    assert.equal(TR.t.fmtDuration(42), '40 Min.');
    assert.equal(TR.t.fmtDuration(60), '1 Std.');
    assert.equal(TR.t.fmtDuration(95), '1 Std. 35 Min.');
    assert.equal(TR.t.fmtDuration(300), '5 Std.');
});
test('fmtKm: Komma unter 10 km, sonst ganze Zahl', () => {
    assert.equal(TR.t.fmtKm(4.26), '4,3 km');
    assert.equal(TR.t.fmtKm(12.6), '13 km');
});
test('estimateFor: unbekanntes Verkehrsmittel → null', () => {
    assert.equal(TR.t.estimateFor('Rakete', TOKYO, OSAKA, 400), null);
    assert.equal(TR.t.estimateFor('Ausstehend', TOKYO, OSAKA, 400), null);
});
test('estimateFor: Flug ist auf langen Strecken schneller als Auto und Zug', () => {
    const d = km(BERLIN, { lat: 40.64, lng: -73.78 }); // Berlin–New York
    const fl = TR.t.estimateFor('Flug', BERLIN, { lat: 40.64, lng: -73.78 }, d);
    const car = TR.t.estimateFor('Mietwagen', BERLIN, { lat: 40.64, lng: -73.78 }, d);
    const train = TR.t.estimateFor('Zug', BERLIN, { lat: 40.64, lng: -73.78 }, d);
    assert.ok(fl.min < car.min && fl.min < train.min);
    assert.ok(fl.note.includes('Flughafen'));
    assert.equal(fl.mode, 'Flug');
});
test('estimateFor: kurze Flüge haben mindestens 30 Min. Flugzeit plus Flughafen-Aufwand', () => {
    assert.ok(TR.t.estimateFor('Flug', TOKYO, OSAKA, 10).min >= 30 + 180);
});
test('estimateFor: Zu Fuß braucht auf 5 km etwa 1,25 Std., Auto ist schneller als Bus', () => {
    const w = TR.t.estimateFor('Zu Fuß', TOKYO, OSAKA, 5);
    assert.ok(Math.abs(w.min - 5 * 1.25 / 5 * 60) < 1e-6);
    assert.ok(TR.t.estimateFor('Mietwagen', ROM, BERLIN, 1200).min < TR.t.estimateFor('Bus', ROM, BERLIN, 1200).min);
});
test('estimateFor: Strecke wird je Verkehrsmittel aus der Luftlinie hochgerechnet; Fähre langsam', () => {
    assert.equal(TR.t.estimateFor('Flug', TOKYO, OSAKA, 100).dist, 100);
    assert.equal(TR.t.estimateFor('Bus', TOKYO, OSAKA, 100).dist, 130);
    assert.equal(TR.t.estimateFor('Mietwagen', TOKYO, OSAKA, 100).gm, 'driving');
    assert.equal(TR.t.estimateFor('Zu Fuß', TOKYO, OSAKA, 3).gm, 'walking');
    assert.ok(TR.t.estimateFor('Fähre', TOKYO, OSAKA, 60).min > TR.t.estimateFor('Bus', TOKYO, OSAKA, 60).min - 1);
});
test('estimateFor: Zug in Japan nutzt das Schnellzug-Netz (Tokio–Osaka deutlich unter 4 Std.), Zug im Ausland nicht', () => {
    const d = km(TOKYO, OSAKA);
    const jp = TR.t.estimateFor('Zug', TOKYO, OSAKA, d);
    assert.equal(jp.mode, 'Zug');
    assert.ok(jp.min > 120 && jp.min < 240, `Japan-Zug ${jp.min}`);
    const eu = TR.t.estimateFor('Zug', BERLIN, ROM, km(BERLIN, ROM));
    assert.ok(eu.min > jp.min);
    assert.equal(eu.mode, 'Zug');
});
test('estimate (Japan): kurze Strecken per Regionalzug, ohne Shinkansen-Anbindung nur langsam', () => {
    assert.ok(TR.t.estimate(TOKYO, { lat: 35.45, lng: 139.63 }, 30).min < 60);
});
test('isJapan / endpoint', () => {
    assert.equal(TR.t.isJapan(TOKYO), true);
    assert.equal(TR.t.isJapan(BERLIN), false);
    assert.equal(TR.t.endpoint({ lat: 0, lng: 0 }), null);
    assert.equal(TR.t.endpoint({ name: 'x' }), null);
    assert.deepEqual(J(TR.t.endpoint({ lat: 1, lng: 2 })), { lat: 1, lng: 2, hotel: false });
    assert.deepEqual(J(TR.t.endpoint({ lat: 1, lng: 2, hotelLat: 3, hotelLng: 4 })), { lat: 3, lng: 4, hotel: true });
});
test('legInfo: Etappe mit Koordinaten – Schätzung folgt dem gewählten Transportmittel', () => {
    TR.ctx.places = [{ name: 'Tokio (Ankunft)', ...TOKYO }, { name: 'Osaka', ...OSAKA, transport: 'Flug' }];
    TR.ctx.computedData = [{ isoEnd: '2026-10-25' }];
    const info = TR.t.legInfo(0);
    assert.equal(info.fromName, 'Tokio'); assert.equal(info.toName, 'Osaka'); assert.equal(info.day, '2026-10-25');
    assert.equal(info.est.mode, 'Flug');
    assert.match(TR.t.summaryText(info), /^Flug · ca\. \d+ km · ca\. \d/);
    assert.match(info.gmaps, /travelmode=transit$/);
    TR.ctx.places[1].transport = 'Mietwagen';
    assert.match(TR.t.legInfo(0).gmaps, /travelmode=driving$/);
    assert.equal(TR.t.legInfo(5), null);
});
test('legInfo: ohne Koordinaten Distanz unbekannt, Google-Link nutzt Namen', () => {
    TR.ctx.places = [{ name: 'Alt', hotel: 'Hotel A' }, { name: 'Neu', hotel: '' }];
    const info = TR.t.legInfo(0);
    assert.equal(info.km, null);
    assert.equal(TR.t.summaryText(info), 'Distanz unbekannt (keine Koordinaten)');
    assert.ok(info.gmaps.includes('origin=' + encodeURIComponent('Hotel A, Alt')));
    assert.ok(info.gmaps.includes('destination=Neu'));
});
test('legInfo: ohne Transportmittel Standard „Zug“', () => {
    TR.ctx.places = [{ name: 'A', ...TOKYO }, { name: 'B', ...OSAKA, transport: 'Ausstehend' }];
    assert.equal(TR.t.legInfo(0).est.mode, 'Zug');
});
test('connectionHtml: maskiert Eingaben und zeigt Abfahrt/Sitzplatz', () => {
    assert.equal(TR.t.connectionHtml(null), '');
    const h = TR.t.connectionHtml({ train: 'Hikari <b>', dep: '09:30', seat: '12A', note: '<img>' });
    assert.ok(h.includes('Hikari &lt;b&gt; · ab 09:30 Uhr · 12A'));
    assert.ok(h.includes('&lt;img&gt;') && !h.includes('<img>'));
});

// ───────────────────────── Notfall ─────────────────────────
const EM = loadFeature('emergency', ['urgentFor', 'telHref', 'normalize', 'NUMBERS', 'allergySentence', 'SENTENCES', 'ALLERGENS', 'FIELDS'], {}, prelude);

test('NUMBERS: ≥ 40 Länder, nur Ziffern, Japan korrekt', () => {
    const n = J(EM.t.NUMBERS);
    assert.ok(Object.keys(n).length >= 40);
    for (const [land, v] of Object.entries(n)) for (const [k, num] of Object.entries(v)) {
        assert.match(num, /^\d{2,5}$/, `${land}.${k}=${num}`);
        assert.ok('epafgt'.includes(k), `Art ${k} bei ${land}`);
    }
    assert.deepEqual(n.Japan, { p: '110', a: '119', f: '119' });
    assert.equal(n.Italien.e, '112');
});
test('urgentFor: gleiche Nummern werden zu einer Kachel, unbekanntes Land → 112', () => {
    const jp = J(EM.t.urgentFor('Japan'));
    assert.deepEqual(jp.map(x => [x.show, x.title]), [['110', 'Polizei'], ['119', 'Rettungsdienst & Feuerwehr']]);
    assert.ok(jp.every(x => x.urgent && x.tel === x.show));
    const it = J(EM.t.urgentFor('Italien'));
    assert.deepEqual(it.map(x => x.show), ['112', '113', '118', '115']);
    const unknown = J(EM.t.urgentFor('Atlantis'));
    assert.deepEqual(unknown.map(x => [x.show, x.title]), [['112', 'Notruf']]);
    assert.deepEqual(J(EM.t.urgentFor('')).map(x => x.show), ['112']);
});
test('telHref: nur gültige Rufnummern, Schutz vor Müll', () => {
    assert.equal(EM.t.telHref('+49 30 5000 0'), 'tel:+4930 50000'.replace(' ', ''));
    assert.equal(EM.t.telHref('0049 30 123456'), 'tel:+4930123456');
    assert.equal(EM.t.telHref('110'), 'tel:110');
    assert.equal(EM.t.telHref('12'), '');
    assert.equal(EM.t.telHref(''), '');
    assert.equal(EM.t.telHref(null), '');
    assert.equal(EM.t.telHref('1'.repeat(30)), '');
    assert.ok(!EM.t.telHref('javascript:alert(1)123').includes('javascript'));
});
test('normalize (Notfall-Ausweis): nur bekannte Felder, Länge begrenzt, Blutgruppe aus fester Liste', () => {
    const n = J(EM.t.normalize({ name: '  Anna\u0000 Beispiel ', blood: '0-', allergies: 'x'.repeat(999), fremd: 'y', policy: 5 }));
    assert.equal(n.name, 'Anna Beispiel');
    assert.equal(n.blood, '0−');
    assert.equal(n.allergies.length, 300);
    assert.equal(n.policy, '');
    assert.ok(!('fremd' in n));
    assert.equal(J(EM.t.normalize({ blood: 'Z+' })).blood, '');
    assert.equal(J(EM.t.normalize(null)).name, '');
    assert.equal(J(EM.t.normalize([1])).name, '');
});
test('Notfall-Sätze: vollständig (Japanisch, Lautschrift, Deutsch) und Allergiesatz mit Auslöser', () => {
    for (const s of J(EM.t.SENTENCES)) assert.ok(s.length === 3 && s.every(x => x.length > 1));
    for (const a of J(EM.t.ALLERGENS)) assert.ok(a.length === 3 && a.every(x => x.length > 0));
    assert.deepEqual(J(EM.t.allergySentence(['卵', 'tamago', 'Ei'])), ['私は卵アレルギーがあります。', 'Watashi wa tamago arerugī ga arimasu.', 'Ich habe eine Allergie gegen Ei.']);
    assert.equal(J(EM.t.allergySentence(null))[0], '私はアレルギーがあります。');
});

// ───────────────────────── Wetter ─────────────────────────
const WX = loadFeature('weather', ['wxInfo', 'normDay', 'num'], {}, prelude);
test('wxInfo: WMO-Codes auf Text abbilden', () => {
    const txt = c => J(WX.t.wxInfo(c))[2];
    assert.equal(txt(0), 'Sonnig'); assert.equal(txt(3), 'Bedeckt'); assert.equal(txt(45), 'Nebel');
    assert.equal(txt(53), 'Nieselregen'); assert.equal(txt(63), 'Regen'); assert.equal(txt(81), 'Regen');
    assert.equal(txt(73), 'Schnee'); assert.equal(txt(95), 'Gewitter'); assert.equal(txt(999), 'Wetter'); assert.equal(txt('x'), 'Wetter');
});
test('normDay: nur gültige Tage mit Zahlen in sinnvollen Grenzen', () => {
    assert.equal(WX.t.normDay(null), null);
    assert.equal(WX.t.normDay({ d: '25.10.2026' }), null);
    assert.deepEqual(J(WX.t.normDay({ d: '2026-10-25', code: 61, tmin: 8, tmax: 17, pop: 70 })), { d: '2026-10-25', code: 61, tmin: 8, tmax: 17, pop: 70 });
    assert.deepEqual(J(WX.t.normDay({ d: '2026-10-25', code: 500, tmin: 'x', tmax: 200, pop: -1 })), { d: '2026-10-25', code: null, tmin: null, tmax: null, pop: null });
});

// ───────────────────────── Erinnerungen ─────────────────────────
const RM = loadFeature('reminders', ['validHHMM', 'shiftDay', 'at', 'cleanMap', 'loadSettings'], {}, prelude);
test('validHHMM / shiftDay / at', () => {
    assert.equal(RM.t.validHHMM('19:00'), true); assert.equal(RM.t.validHHMM('24:00'), false); assert.equal(RM.t.validHHMM('7:00'), false);
    assert.equal(RM.t.shiftDay('2026-10-31', 1), '2026-11-01'); assert.equal(RM.t.shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(new Date(RM.t.at('2026-10-25', '08:30')).getHours(), 8);
});
test('cleanMap: alte, ungültige und überlange Einträge werden verworfen', () => {
    const now = Date.now();
    const out = J(RM.t.cleanMap({ a: now, b: now - 100 * 864e5, c: 'x', ['k'.repeat(300)]: now }));
    assert.deepEqual(Object.keys(out), ['a']);
    assert.deepEqual(J(RM.t.cleanMap(null)), {});
});
test('loadSettings: Standard 19:00, ungültige Zeiten werden ersetzt', () => {
    assert.deepEqual(J(RM.t.loadSettings()), { on: true, eve: '19:00' });
    RM.ctx.localStorage.setItem('tp_reminders', JSON.stringify({ on: false, eve: '99:99' }));
    assert.deepEqual(J(RM.t.loadSettings()), { on: false, eve: '19:00' });
    RM.ctx.localStorage.setItem('tp_reminders', JSON.stringify({ eve: '20:15' }));
    assert.equal(RM.t.loadSettings().eve, '20:15');
});

// ───────────────────────── Teilen ─────────────────────────
const exportKeys = "const EXPORT_KEYS = ['tp_places','tp_acts','tp_journal','tp_theme','tp_start'];\nconst APP_VERSION = 'vtest';\n";
const SH = loadFeature('share', ['bytesToB64url', 'b64urlToBytes', 'buildPayload'], { location: { origin: 'https://x.test', pathname: '/', hash: '', href: '' } }, prelude + '\n' + exportKeys + 'var tripName = "Japan im Herbst";');
test('Base64url: Rundlauf für beliebige Bytes, ohne + / =', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    const enc = SH.t.bytesToB64url(bytes);
    assert.match(enc, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual([...SH.t.b64urlToBytes(enc)], [...bytes]);
    assert.throws(() => SH.t.b64urlToBytes('ab+c'));
    assert.throws(() => SH.t.b64urlToBytes('a b'));
});
test('buildPayload: ohne Design, Tagebuch und Notizen nur auf Wunsch', () => {
    SH.ctx.localStorage.setItem('tp_places', '[{"name":"A"}]');
    SH.ctx.localStorage.setItem('tp_acts', JSON.stringify([{ title: 'T', notes: 'geheim' }]));
    SH.ctx.localStorage.setItem('tp_journal', '[{"t":1}]');
    SH.ctx.localStorage.setItem('tp_theme', 'dark');
    const p = J(SH.t.buildPayload({ journal: false, notes: false }));
    assert.equal(p.app, 'trip-planer'); assert.equal(p.shared, true); assert.equal(p.label, 'Japan im Herbst');
    assert.ok(!('tp_theme' in p.data)); assert.ok(!('tp_journal' in p.data));
    assert.equal(JSON.parse(p.data.tp_acts)[0].notes, '');
    const q = J(SH.t.buildPayload({ journal: true, notes: true }));
    assert.ok('tp_journal' in q.data); assert.equal(JSON.parse(q.data.tp_acts)[0].notes, 'geheim');
});
