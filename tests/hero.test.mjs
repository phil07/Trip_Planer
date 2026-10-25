// Test für die Startseiten-Karte („Deine Reise“): Countdown-Text und Restzeit-Balken (voll → leer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers.mjs';

const els = {};
const el = id => (els[id] ??= { id, style: {}, value: '', innerText: '', textContent: '', innerHTML: '', childElementCount: 1 });
const document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [] };

const A = loadApp({
    consts: ['clampNights', 'isObj', 'finiteOr', 'clean'],
    funcs: ['localISO', 'parseISODate', 'todayISO', 'nightsWord', 'calculateDates'],
    globals: { document },
    extra: `var places = [], acts = [], startDate = '', tripName = '', tripCountry = '', computedData = [];
        var COUNTRY_LANG = {}; function renderHome() {}
        function defaultStartDate() { return todayISO(); }
        var setTrip = (s, nights) => { startDate = s; places = nights.map((n, i) => ({ name: 'S' + i, nights: n })); };`,
    also: ['setTrip'],
});

const iso = off => { const d = new Date(); d.setDate(d.getDate() + off); return A.localISO(d); };
function bar(startOffset, nights) {
    A.setTrip(iso(startOffset), nights);
    A.calculateDates();
    return { width: els['hero-progress-fill'].style.width, unit: els['hero-unit'].textContent, num: els['hero-num'].innerText };
}

test('vor dem Start: Balken voll, Countdown in Tagen', () => {
    const r = bar(5, [3, 2]);
    assert.equal(r.width, '100%');
    assert.equal(String(r.num), '5');
    assert.equal(r.unit, 'Tage bis zum Start');
    assert.equal(bar(1, [2]).unit, 'Tag bis zum Start');
});
test('am Starttag: Balken voll', () => {
    const r = bar(0, [4, 4]);
    assert.equal(r.width, '100%');
    assert.match(r.unit, /heute geht's los/);
});
test('während der Reise: Balken leert sich mit den Resttagen', () => {
    // 10 Nächte gesamt, gestartet vor 2 Tagen → 8 von 10 Tagen übrig
    assert.equal(bar(-2, [4, 6]).width, '80%');
    assert.equal(bar(-5, [4, 6]).width, '50%');
    assert.equal(bar(-9, [4, 6]).width, '10%');
    assert.match(bar(-2, [4, 6]).unit, /seit Reisebeginn/);
});
test('nach dem Reiseende: Balken leer', () => {
    assert.equal(bar(-10, [4, 6]).width, '0%');
    assert.equal(bar(-30, [4, 6]).width, '0%');
});
test('ohne Stationen oder ohne Nächte: Balken leer', () => {
    assert.equal(bar(3, []).width, '0%');
    assert.equal(bar(3, [0, 0]).width, '0%');
});
test('Route-Zeile listet die Stationen', () => {
    bar(3, [2, 2]);
    assert.equal(els['hero-route'].innerText, '1. S0 • 2. S1');
    bar(3, []);
    assert.equal(els['hero-route'].innerText, 'Noch keine Route geplant');
});
