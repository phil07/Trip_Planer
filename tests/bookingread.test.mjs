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
    assert.equal(extract(text), 'HOTEL Tokyo Trip Ueno Nishi Nippori');
});
test('Beschriftung "Unterkunft:" wird weiterhin übernommen', () => {
    assert.equal(extract('Unterkunft: Ryokan Sakura Hakone\nCheck-in 15:00'), 'Ryokan Sakura Hakone');
});
