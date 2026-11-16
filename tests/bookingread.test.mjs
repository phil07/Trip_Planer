// Unit-Tests: Hotelname aus Text einer Buchungsbestätigung. Ausführen: node --test tests/bookingread.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../Trip-Planer/features/bookingread.js', import.meta.url), 'utf8');
const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const extract = ctx.window.bookingRead.extractHotelName;

test('Beschriftung "Hotel:" wird übernommen', () => {
    assert.equal(extract('Buchungsbestätigung\nHotel: Hotel Gracery Shinjuku\nCheck-in 18.11.'), 'Hotel Gracery Shinjuku');
});
test('Property name in englischer Bestätigung', () => {
    assert.equal(extract('Property name: Royal Park Kyoto\nGuest: Max'), 'Royal Park Kyoto');
});
test('freie Zeile mit Schlüsselwort', () => {
    assert.equal(extract('Thank you for booking\nRoyal Park Hotel Kyoto\nCheck-in 22.11.2026'), 'Royal Park Hotel Kyoto');
});
test('Ryokan wird erkannt', () => {
    assert.equal(extract('Ryokan Sakura Hakone  |  2 Nächte'), 'Ryokan Sakura Hakone');
});
test('ohne Hotelangabe leer', () => {
    assert.equal(extract('Flug LH 716 Frankfurt - Tokio, Abflug 10:15'), '');
    assert.equal(extract(''), '');
});
test('Zeile mit Preis/Check-in wird nicht als Name genommen', () => {
    assert.equal(extract('Hotel check-in: 15:00\nTotal price hotel 520 EUR'), '');
});

test('Seitentitel "Unterkunft in Tokyo" wird nicht als Hotel genommen (Expedia-PDF)', () => {
    const text = 'Unterkunft in Tokyo\n25. Nov. 2026 – 28. Nov. 2026\nHOTEL Tokyo Trip Ueno Nishi Nippori\nBestätigung: T_2603346607\nBuchungsdetails\nGebucht\nCheck-in\nMi., 25. Nov.\n15:00 Uhr';
    assert.equal(extract(text), 'Hotel Tokyo Trip Ueno Nishi Nippori');
});
test('Beschriftung "Unterkunft:" wird weiterhin übernommen', () => {
    assert.equal(extract('Unterkunft: Ryokan Sakura Hakone\nCheck-in 15:00'), 'Ryokan Sakura Hakone');
});

test('Großbuchstaben werden normal geschrieben, Kürzel bleiben', () => {
    assert.equal(extract('ROYAL PARK HOTEL Kyoto\nCheck-in 22.11.'), 'Royal Park Hotel Kyoto');
    assert.equal(extract('Hotel: APA Hotel Osaka Umeda'), 'APA Hotel Osaka Umeda');
});

test('Zug: Name und Nummer, Abfahrt und Gleis werden erkannt', () => {
    const t = ctx.window.bookingRead.extractTransit('JR Pass Reservierung\nNozomi 215\nAbfahrt 09:33 Uhr\nGleis 14 Wagen 7 Sitz 12A\nTokio → Kyoto');
    assert.equal(t.train, 'Nozomi 215');
    assert.equal(t.dep, '09:33');
    assert.equal(t.gate, '14');
    assert.match(t.seat, /Wagen 7/);
});
test('Flug: Flugnummer und Abflugzeit', () => {
    const t = ctx.window.bookingRead.extractTransit('Flugnummer LH716\nAbflug 10:15\nFrankfurt (FRA) - Tokio (HND)');
    assert.equal(t.train, 'LH 716');
    assert.equal(t.dep, '10:15');
});
test('Check-in-Zeit wird nicht als Abfahrt genommen', () => {
    const t = ctx.window.bookingRead.extractTransit('Hotel Gracery\nCheck-in ab 15:00\nNozomi 215');
    assert.equal(t.dep, '');
    assert.equal(t.train, 'Nozomi 215');
});
test('ohne Zug- oder Flugdaten: null', () => {
    assert.equal(ctx.window.bookingRead.extractTransit('Hotel Gracery Shinjuku\nCheck-in 15:00'), null);
});

test('Flug-Screenshot ohne Beschriftung: Flugnummer, Abflug am Flughafen, Sitz', () => {
    const t = ctx.window.bookingRead.extractTransit('Flight details\nScheduled\nJan 1 (Fri) JL407\nTokyo (Narita)\nNRT\n10:40\nFrankfurt\nFRA\n17:00\nTerminal 2\nSeat 18K');
    assert.equal(t.train, 'JL 407');
    assert.equal(t.dep, '10:40');
    assert.equal(t.seat, '18K');
});

test('Flug-Screenshot, Variante 1: Beschriftung und Wert in getrennten Zeilen', () => {
    const t = ctx.window.bookingRead.extractTransit('Flight details\nScheduled\nJan 1 (Fri) JL407\nTokyo\n(Narita)\nNRT\n10:40\nFrankfurt\nFRA\n17:00\n14h 20m\nTerminal\n2\nGate\n-\nBoarding time\n-\nBoarding\n-\nClass\nPremium\nEconomy\nSeat\n18K');
    assert.equal(t.train, 'JL 407');
    assert.equal(t.dep, '10:40');
    assert.equal(t.terminal, '2');
    assert.equal(t.seat, '18K');
    assert.equal(t.gate, '');
});
test('Flug-Screenshot, Variante 2: alles in einer Zeile, Uhrzeit mit O statt 0', () => {
    const t = ctx.window.bookingRead.extractTransit('JL407 NRT 1O:40 FRA 17:00\nTerminal 2 Gate - Boarding time -\nSeat 18K');
    assert.equal(t.train, 'JL 407');
    assert.equal(t.dep, '10:40');
    assert.equal(t.terminal, '2');
    assert.equal(t.seat, '18K');
});

test('Sitz: OCR liest "I8K" statt "18K", Wert in der nächsten Zeile', () => {
    const t = ctx.window.bookingRead.extractTransit('JL407 NRT 10:40\nPremium\nEconomy\nSeat\nI8K >');
    assert.equal(t.seat, '18K');
});
test('Sitz: Wert in derselben Zeile mit Pfeil', () => {
    const t = ctx.window.bookingRead.extractTransit('JL407 NRT 10:40\nSeat 18K >');
    assert.equal(t.seat, '18K');
});
