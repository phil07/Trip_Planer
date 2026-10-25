// Unit-Tests für den Ausgleichsalgorithmus der Kostenaufteilung.
// Ausführen: node --test tests/splitcosts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toCents, splitCents, computeBalances, settle, participantsOf } = require('../Trip-Planer/features/splitcosts.js');

const T = [{ id: 'ta', name: 'Anna' }, { id: 'tb', name: 'Ben' }, { id: 'tc', name: 'Chris' }];
const sum = a => a.reduce((s, x) => s + x, 0);
// Wendet Zahlungen auf Salden an – danach muss alles 0 sein.
function applyTransfers(bal, txs) {
    const m = new Map(bal);
    for (const t of txs) { m.set(t.from, m.get(t.from) + t.cents); m.set(t.to, m.get(t.to) - t.cents); }
    return m;
}

test('toCents rundet Float-Beträge korrekt', () => {
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(19.99), 1999);
    assert.equal(toCents(0.07 * 3), 21);
    assert.equal(toCents('x'), 0);
});

test('splitCents verteilt Restcents, Summe bleibt exakt', () => {
    assert.deepEqual(splitCents(1000, 3), [334, 333, 333]);
    assert.deepEqual(splitCents(2, 3), [1, 1, 0]);
    assert.deepEqual(splitCents(0, 2), [0, 0]);
    assert.deepEqual(splitCents(5, 0), []);
    for (let c = 0; c < 500; c += 7) for (let n = 1; n < 8; n++) assert.equal(sum(splitCents(c, n)), c);
});

test('participantsOf: fehlend/leer/unbekannt = alle, sonst Reisenden-Reihenfolge', () => {
    assert.deepEqual(participantsOf({}, T), ['ta', 'tb', 'tc']);
    assert.deepEqual(participantsOf({ splitAmong: ['tx'] }, T), ['ta', 'tb', 'tc']);
    assert.deepEqual(participantsOf({ splitAmong: ['tc', 'ta', 'tx'] }, T), ['ta', 'tc']);
});

test('computeBalances: Saldo = bezahlt − Anteil, Summe 0, ohne Zahler ignoriert', () => {
    const entries = [
        { amount: 90, paidBy: 'ta' },                              // je 30
        { amount: 10, paidBy: 'tb', splitAmong: ['tb', 'tc'] },    // je 5
        { amount: 0.1 + 0.2, paidBy: 'tc', splitAmong: ['ta'] },   // 30 Cent für Anna
        { amount: 50 },                                            // ohne Zahler
        { amount: 20, paidBy: 'tx' },                              // unbekannter Zahler
    ];
    const { stats, unassigned } = computeBalances(T, entries);
    assert.equal(unassigned, 2);
    assert.deepEqual(stats.get('ta'), { paid: 9000, share: 3030, balance: 5970 });
    assert.deepEqual(stats.get('tb'), { paid: 1000, share: 3500, balance: -2500 });
    assert.deepEqual(stats.get('tc'), { paid: 30, share: 3500, balance: -3470 });
    assert.equal(sum([...stats.values()].map(s => s.balance)), 0);
});

test('settle: einfache Fälle', () => {
    assert.deepEqual(settle(new Map([['ta', 0], ['tb', 0]])), []);
    assert.deepEqual(settle([['ta', 4210], ['tb', -4210]]), [{ from: 'tb', to: 'ta', cents: 4210 }]);
    // Einer hat alles bezahlt → jede andere Person zahlt ihm genau ihren Anteil
    assert.deepEqual(settle([['ta', 6000], ['tb', -3000], ['tc', -3000]]),
        [{ from: 'tb', to: 'ta', cents: 3000 }, { from: 'tc', to: 'ta', cents: 3000 }]);
});

test('settle: Greedy größter Schuldner ↔ größter Gläubiger', () => {
    assert.deepEqual(settle([['ta', 5970], ['tb', -2500], ['tc', -3470]]),
        [{ from: 'tc', to: 'ta', cents: 3470 }, { from: 'tb', to: 'ta', cents: 2500 }]);
    // Passende Paare werden direkt ausgeglichen (2 statt 3 Zahlungen)
    assert.deepEqual(settle([['ta', 100], ['tb', 50], ['tc', -100], ['td', -50]]),
        [{ from: 'tc', to: 'ta', cents: 100 }, { from: 'td', to: 'tb', cents: 50 }]);
});

test('settle: Zufallstests – Salden danach 0, höchstens n−1 Zahlungen, nur ganze positive Cent', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 300; run++) {
        const n = 2 + Math.floor(rnd() * 7);
        const ts = Array.from({ length: n }, (_, i) => ({ id: 't' + i, name: 'P' + i }));
        const entries = Array.from({ length: Math.floor(rnd() * 15) }, () => ({
            amount: Math.round(rnd() * 50000) / 100 + rnd() * 1e-9,
            paidBy: 't' + Math.floor(rnd() * n),
            splitAmong: ts.filter(() => rnd() < 0.6).map(t => t.id),
        }));
        const { stats } = computeBalances(ts, entries);
        const bal = new Map(ts.map(t => [t.id, stats.get(t.id).balance]));
        assert.equal(sum([...bal.values()]), 0);
        const txs = settle(bal);
        assert.ok(txs.length <= n - 1);
        txs.forEach(t => { assert.ok(Number.isInteger(t.cents) && t.cents > 0); assert.notEqual(t.from, t.to); });
        assert.ok([...applyTransfers(bal, txs).values()].every(v => v === 0));
    }
});
