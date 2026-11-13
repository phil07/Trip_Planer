// Unit-Tests für die Datenverlust-Pfade: Sicherung, Import, Rückschreiben bei vollem Speicher.
// Lädt die echten Funktionen aus app.js (keine Kopie). Ausführen: node --test tests/tripdata.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../Trip-Planer/app.js', import.meta.url), 'utf8');

function grab(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} nicht in app.js gefunden`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
}
const keysSrc = src.match(/const EXPORT_KEYS = \[[\s\S]*?\];/)[0];

// Fake-localStorage; failWhen(key, value) lässt setItem werfen wie bei vollem Speicher.
function makeEnv(initial = {}, failWhen = () => false) {
    const m = new Map(Object.entries(initial));
    const ls = {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { if (failWhen(k, v)) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
    };
    const code = `${keysSrc}
        const APP_VERSION = 'vTEST';
        const clearAiCaches = () => 0;
        const safeSetItem = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
        ${grab('snapshotTripData')}
        ${grab('writeTripData')}
        ${grab('savePreImportBackup')}
        ${grab('persist')}
        globalThis.testFns = { snapshotTripData, writeTripData, savePreImportBackup, persist };`;
    const context = {
        localStorage: ls,
        places: [], acts: [], planPoints: [], returnBooking: null, startDate: '', tripName: '', tripCountry: '', tripCountryManual: false,
        clean: x => x, console: { error() {} },
    };
    vm.runInNewContext(code, context);
    return { m, ...context.testFns, context };
}

test('snapshotTripData nimmt nur gesetzte Schlüssel mit', () => {
    const { snapshotTripData } = makeEnv({ tp_places: '[1]', fremd: 'x' });
    assert.deepEqual(JSON.parse(JSON.stringify(snapshotTripData())), { tp_places: '[1]' });
});

test('writeTripData ersetzt Reisedaten und entfernt veraltete Schlüssel', () => {
    const { m, writeTripData } = makeEnv({ tp_places: 'alt', tp_budget: 'alt', fremd: 'bleibt' });
    assert.equal(writeTripData({ tp_places: 'neu' }, {}), true);
    assert.equal(m.get('tp_places'), 'neu');
    assert.equal(m.has('tp_budget'), false);
    assert.equal(m.get('fremd'), 'bleibt');
});

test('writeTripData: Speicher voll mitten im Schreiben -> alter Stand wird zurückgeschrieben', () => {
    const prev = { tp_places: 'alt', tp_budget: 'alt' };
    const { m, writeTripData } = makeEnv(prev, (k, v) => v === 'GROSS');
    assert.equal(writeTripData({ tp_places: 'neu', tp_journal: 'GROSS' }, prev), false);
    assert.equal(m.get('tp_places'), 'alt');
    assert.equal(m.get('tp_budget'), 'alt');
    assert.equal(m.has('tp_journal'), false);
});

test('savePreImportBackup speichert die Daten mit Beschriftung', () => {
    const { m, savePreImportBackup } = makeEnv();
    assert.equal(savePreImportBackup({ tp_places: '[1]' }, 'Test'), true);
    const b = JSON.parse(m.get('tp_backup_before_import'));
    assert.equal(b.label, 'Test');
    assert.deepEqual(b.data, { tp_places: '[1]' });
});

test('savePreImportBackup: Speicher voll -> false, vorhandene Sicherung bleibt unangetastet', () => {
    const { m, savePreImportBackup } = makeEnv({ tp_backup_before_import: 'ALTE_SICHERUNG' }, k => k === 'tp_backup_before_import');
    assert.equal(savePreImportBackup({ tp_places: '[1]' }, 'Test'), false);
    assert.equal(m.get('tp_backup_before_import'), 'ALTE_SICHERUNG');
});

test('persist: Speicherfehler stellt den vollständigen alten Stand wieder her', () => {
    const previous = {
        tp_places: '["alt"]', tp_acts: '["alt"]', tp_start: '2026-01-01',
        tp_tripname: 'Alt', tp_tripcountry: 'Japan', tp_tripcountry_manual: '1',
        tp_return: 'Zug', tp_arrival: 'Flug',
    };
    const { m, persist, context } = makeEnv(previous, k => k === 'tp_tripcountry');
    context.places = [{ name: 'Neu' }];
    context.acts = [{ title: 'Neu' }];
    context.planPoints = [{ id: 1, city: 'Tokyo', day: '2026-10-15', text: 'Neu', done: false }];
    context.startDate = '2026-11-01'; context.tripName = 'Neu'; context.tripCountry = 'Italien';
    context.tripCountryManual = true; context.returnTransport = 'Auto'; context.arrivalTransport = 'Zug';
    assert.equal(persist(), false);
    for (const [key, value] of Object.entries(previous)) assert.equal(m.get(key), value, key);
});

test('saveSettings stellt bei Speicherfehler den alten Zustand wieder her und lässt den Dialog offen', () => {
    const toasts = [], timers = [];
    let closed = false;
    const settings = vm.runInNewContext(`
        ${grab('saveSettings')}
        saveSettings;
    `, {
        clearTripForCountryChange: () => true,
        updateUndoImportBtn() {}, renderPlaces() {}, renderActs() {}, drawMap() {},
        startDate: '2026-01-01', tripName: 'Alt', tripCountry: 'Japan', tripCountryManual: false,
        tripLangCode: 'ja', tripLangName: 'Japanisch', places: [{ name: 'Tokyo' }], acts: [], planPoints: [],
        returnTransport: 'Zug', arrivalTransport: 'Flug', crawlerDone: true,
        localStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        tripCountry: 'Japan',
        document: { getElementById: id => ({
            value: id === 's-startdate' ? '2026-11-01' : id === 's-tripcountry' ? 'Italien' : '',
            close() { closed = true; },
        }) },
        catsLoading: { clear() {} }, actsFill: {}, cityBooted: {},
        defaultStartDate: () => '2026-11-01',
        parseISODate: () => new Date('2026-11-01'),
        isNaN,
        applyTripCountry() {},
        renderPhrases() {},
        saveData: () => false,
        openRouteWizard: () => timers.push(['route']),
        showToast: (...args) => toasts.push(args),
        setTimeout: (...args) => timers.push(args),
        console,
    });

    settings();
    assert.deepEqual(toasts, []);
    assert.deepEqual(timers, []);
    assert.equal(closed, false);
});

test('persist schreibt eigene Tagesplan-Punkte unter tp_plan', () => {
    const { m, persist, context } = makeEnv({});
    context.planPoints = [{ id: 7, city: 'Kyoto', day: '2026-10-16', text: 'Frühstück', done: true, dayOrder: 0 }];
    Object.assign(context, { returnTransport: '', arrivalTransport: '', returnBooking: null, tripCountry: '', tripCountryManual: false, tripName: '' });
    persist();
    assert.deepEqual(JSON.parse(m.get('tp_plan')), context.planPoints);
});
