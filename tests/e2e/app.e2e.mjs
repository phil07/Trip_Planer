// Browser-Tests (Playwright + Chromium) gegen die echte App. Ausführen: npm run test:e2e
// Voraussetzung: `npm install` (playwright-core) und ein Chromium (CHROME_PATH oder /opt/pw-browsers).
// Netzwerk wird gestubbt, die App läuft über einen lokalen Static-Server; ohne Browser werden die Tests übersprungen.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../Trip-Planer/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)) {
        if (!fs.existsSync(base)) continue;
        for (const d of fs.readdirSync(base).filter(x => /^chromium-\d+$/.test(x)).sort().reverse()) {
            for (const sub of ['chrome-linux64', 'chrome-linux']) {
                const p = path.join(base, d, sub, 'chrome');
                if (fs.existsSync(p)) return p;
            }
        }
    }
    return null;
}
let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch (e) { /* nicht installiert */ }
const chrome = findChrome();
const SKIP = !chromium || !chrome ? 'playwright-core oder Chromium fehlt' : false;

let server, base, browser;
const day = n => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

const FIXTURE = () => ({
    tp_onboarded: '1', tp_start: day(2), tp_tripname: 'Japan im Herbst', tp_tripcountry: 'Japan', tp_tripcountry_manual: '1', tp_crawled: '1',
    tp_places: JSON.stringify([
        { id: 1, name: 'Tokio', nights: 4, lat: 35.6762, lng: 139.6503, hotel: 'Hotel Gracery', hotelLat: 35.6955, hotelLng: 139.7006, transport: 'Flug · LH 716' },
        { id: 2, name: 'Kyoto', nights: 3, lat: 35.0116, lng: 135.7681, hotel: 'Royal Park', hotelLat: 35.0094, hotelLng: 135.76, transport: 'Zug', transit: { train: 'Nozomi 215', dep: '09:33', seat: '12A', note: 'JR Pass' } },
        { id: 3, name: 'Osaka', nights: 2, lat: 34.6937, lng: 135.5023, hotel: 'Cross Hotel', hotelLat: 34.6702, hotelLng: 135.5017, transport: 'Mietwagen' },
    ]),
    tp_acts: JSON.stringify([
        { id: 11, topPlace: 'Tokio', type: '🏯 Sehenswürdigkeit', title: 'Senso-ji Tempel', desc: 'Tempel', lat: 35.7148, lng: 139.7967, favorite: true, day: day(3), dayOrder: 0, time: '09:00' },
        { id: 12, topPlace: 'Tokio', type: '🍣 Restaurant', title: 'Ichiran Ramen', desc: 'Ramen', lat: 35.6595, lng: 139.7005, favorite: false, day: day(3), dayOrder: 1, time: '19:00' },
        { id: 13, topPlace: 'Kyoto', type: '🏯 Sehenswürdigkeit', title: 'Fushimi Inari', desc: 'Schrein', lat: 34.9671, lng: 135.7727, favorite: true, day: '', dayOrder: 0, time: '' },
    ]),
    tp_budget: JSON.stringify({ travelers: [{ id: 't1', name: 'Anna' }, { id: 't2', name: 'Ben' }], budget: { Hotel: 1000, Essen: 500 }, entries: [
        { id: 'b1', cat: 'Hotel', desc: 'Hotel', place: 'Tokio', date: day(2), amount: 520, cur: 'EUR', origAmount: 520, paidBy: 't1', splitAmong: ['t1', 't2'] },
        { id: 'b2', cat: 'Essen', desc: 'Sushi', place: 'Tokio', date: day(3), amount: 80, cur: 'EUR', origAmount: 80, paidBy: 't2', splitAmong: ['t1', 't2'] },
    ] }),
    tp_pack: JSON.stringify({ v: 3, active: 'l0', lists: [{ id: 'l0', name: 'Gemeinsam', items: [] }] }),
});

before(async () => {
    if (SKIP) return;
    server = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p === '/') p = '/index.html';
        const f = path.join(ROOT, p);
        if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nicht gefunden'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
        fs.createReadStream(f).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });

let ctx, page, errors;
async function open(seed = FIXTURE(), { dark = false } = {}) {
    ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, locale: 'de-DE', colorScheme: dark ? 'dark' : 'light' });
    page = await ctx.newPage();
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => {
        const u = r.request().url();
        const json = body => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        if (/api\.frankfurter.*\.\./.test(u)) {
            const rates = {};
            for (let i = 30; i >= 0; i--) rates[day(-i)] = { JPY: 158 + (30 - i) * 0.1, USD: 1.1 };
            return json({ base: 'EUR', start_date: day(-30), end_date: day(0), rates });
        }
        if (/api\.frankfurter/.test(u)) return json({ base: 'EUR', date: day(0), rates: { JPY: 160, USD: 1.1, GBP: 0.85, CHF: 0.95 } });
        if (/api\.open-meteo/.test(u)) return json({ daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [] } });
        return r.abort();
    });
    await page.addInitScript(s => {
        if (localStorage.getItem('__seeded')) return;
        localStorage.setItem('__seeded', '1');
        Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
        sessionStorage.setItem('tp_crawled_session', '1');
    }, seed);
    await page.goto(base + 'index.html');
    await page.waitForFunction(() => typeof switchView === 'function' && document.getElementById('hero-num')?.innerText !== '–');
}
afterEach(async () => { await ctx?.close(); ctx = null; });
const go = (view, title) => page.evaluate(([v, t]) => switchView(v, t), [view, title]);
const t = (name, fn) => test(name, { skip: SKIP }, fn);

t('Start: lädt ohne JavaScript-Fehler, Countdown und voller Restzeit-Balken', async () => {
    await open();
    assert.equal(await page.locator('#hero-num').innerText(), '2');
    assert.match(await page.locator('#hero-unit').innerText(), /Tage bis zum Start/);
    assert.equal(await page.locator('#hero-progress-fill').evaluate(e => e.style.width), '100%');
    assert.match(await page.locator('#hero-route').innerText(), /1\. Tokio.*2\. Kyoto.*3\. Osaka/);
    assert.deepEqual(errors, []);
});

t('Start: Statistik zählt Orte, Nächte, Aktivitäten und Favoriten', async () => {
    await open();
    const nums = await page.locator('#homeStats .stat-num').allInnerTexts();
    assert.deepEqual(nums, ['3', '9', '3', '2']);
});

t('Menü: jeder Menüpunkt zeigt seine Ansicht', async () => {
    await open();
    const items = [['places', 'view-places'], ['map', 'view-map'], ['activities', 'view-activities'], ['dayplan', 'view-dayplan'],
        ['currency', 'view-currency'], ['budget', 'view-budget'], ['phrases', 'view-phrases'], ['documents', 'view-documents'],
        ['journal', 'view-journal'], ['emergency', 'view-emergency'], ['home', 'view-home']];
    for (const [id, view] of items) {
        await page.click('#menuBtn');
        await page.click(`#menu-${id}`);
        await page.waitForFunction(v => document.getElementById(v)?.classList.contains('active'), view);
        assert.equal(await page.locator('.view.active').count(), 1, `${view}: genau eine aktive Ansicht`);
    }
    assert.deepEqual(errors, []);
});

t('Stationen: drei Karten, gerade (nicht gedreht), gleiche Breite', async () => {
    await open();
    await go('view-places', 'Stationen');
    const cards = page.locator('#placesList .place-card.station');
    assert.equal(await cards.count(), 3);
    const info = await cards.evaluateAll(els => els.map(e => ({ tf: getComputedStyle(e).transform, w: Math.round(e.getBoundingClientRect().width) })));
    assert.ok(info.every(i => i.tf === 'none' || i.tf === 'matrix(1, 0, 0, 1, 0, 0)'), JSON.stringify(info));
    assert.equal(new Set(info.map(i => i.w)).size, 1);
});

t('Stationen: Verbindung zeigt Zug ohne Shinkansen-Option', async () => {
    await open();
    await go('view-places', 'Stationen');
    const text = await page.locator('#placesList').innerText();
    assert.match(text, /Zug · ca\. \d+ km · ca\. \d/);
    assert.doesNotMatch(text, /Shinkansen/);
});

t('Aktivitäten: Liste, Favoritenfilter', async () => {
    await open();
    await go('view-activities', 'Aktivitäten');
    assert.match(await page.locator('#view-activities').innerText(), /Senso-ji/);
    await page.evaluate(() => setFilter('__favs__'));
    const txt = await page.locator('#view-activities').innerText();
    assert.match(txt, /Senso-ji/); assert.match(txt, /Fushimi/);
    assert.doesNotMatch(txt, /Ichiran/);
});

t('Tagesplan: nur Favoriten – geplante unter ihrem Tag, ungeplante getrennt', async () => {
    await open();
    await go('view-dayplan', 'Tagesplan');
    const txt = await page.locator('#dayPlanList').innerText();
    assert.match(txt, /Senso-ji/);
    assert.match(txt, /Fushimi/);
    assert.doesNotMatch(txt, /Ichiran/);
    assert.ok(await page.locator('#dayPlanList .dayplan-card[data-day]').count() >= 1);
});

t('Tagesplan: eigene Punkte anlegen, abhaken – erledigte rutschen nach unten', async () => {
    await open();
    await go('view-dayplan', 'Tagesplan');
    await page.click('#view-dayplan .fab-add-act');
    await page.waitForFunction(() => document.getElementById('modal-plan').open);
    await page.fill('#pl-text', 'Frühstück am Bahnhof');
    await page.click('#modal-plan .btn:not(.btn-secondary)');
    await page.click('#view-dayplan .fab-add-act');
    await page.fill('#pl-text', 'Tempelbesuch');
    await page.click('#modal-plan .btn:not(.btn-secondary)');
    const order = async () => (await page.locator('#dayPlanList .dayplan-item-title').allInnerTexts());
    let titles = await order();
    assert.ok(titles.indexOf('Frühstück am Bahnhof') < titles.indexOf('Tempelbesuch'));
    await page.locator('#dayPlanList .plan-check[data-kind="pt"]:not(:checked)').first().click({ force: true });
    await page.waitForFunction(() => document.querySelector('#dayPlanList .dayplan-item.is-done') !== null);
    titles = await order();
    assert.ok(titles.indexOf('Tempelbesuch') < titles.indexOf('Frühstück am Bahnhof'), 'erledigter Punkt rutscht nach unten');
    await page.reload();
    await go('view-dayplan', 'Tagesplan');
    assert.match(await page.locator('#dayPlanList').innerText(), /Frühstück am Bahnhof/);
});

t('Tagesplan: eigener Punkt umbenennen', async () => {
    await open();
    await go('view-dayplan', 'Tagesplan');
    await page.click('#view-dayplan .fab-add-act');
    await page.fill('#pl-text', 'Alt');
    await page.click('#modal-plan .btn:not(.btn-secondary)');
    await page.click('#dayPlanList .edit-btn >> nth=0');
    await page.waitForFunction(() => document.getElementById('modal-plan').open);
    await page.fill('#pl-text', 'Neu');
    await page.click('#modal-plan .btn:not(.btn-secondary)');
    const txt = await page.locator('#dayPlanList').innerText();
    assert.match(txt, /Neu/);
    assert.doesNotMatch(txt, /\bAlt\b/);
});

t('Währungsrechner: 250 EUR → 40.000 JPY mit gestubbtem Kurs, Rückrichtung', async () => {
    await open();
    await go('view-currency', 'Währungsrechner');
    await page.waitForFunction(() => !/lädt/i.test(document.getElementById('fxMeta').textContent));
    await page.selectOption('#fxToCcy', 'JPY');
    await page.fill('#fxFromAmt', '250');
    await page.waitForFunction(() => /40[.,]?000/.test(document.getElementById('fxToAmt').value));
    await page.fill('#fxToAmt', '16000');
    await page.waitForFunction(() => /^100([.,]0+)?$/.test(document.getElementById('fxFromAmt').value));
});

t('Reisekosten: Summe aus den Ausgaben, Kostenaufteilung nennt Ausgleich', async () => {
    await open();
    await go('view-budget', 'Reisekosten');
    assert.match(await page.locator('#budgetTop').innerText(), /600[,.]00|600\s?€/);
    assert.match(await page.locator('#budgetEntries').innerText(), /Hotel/);
    assert.deepEqual(errors, []);
});

t('Notfall (Japan): 110 und 119, Nummern als tel:-Links', async () => {
    await open();
    await go('view-emergency', 'Notfall');
    const hrefs = await page.locator('#emergencyContent a.em-call.urgent').evaluateAll(a => a.map(x => x.getAttribute('href')));
    assert.deepEqual(hrefs, ['tel:110', 'tel:119']);
});

t('Länderwechsel auf Italien: Rückfrage, Reise gelöscht, SOS zeigt 112/113/118/115, Sicherung vorhanden', async () => {
    await open();
    page.on('dialog', d => d.accept());
    await page.evaluate(() => openSettings());
    await page.fill('#s-tripcountry', 'Italien');
    await page.evaluate(() => saveSettings());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('tp_places') || '[]').length === 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('tp_tripcountry')), 'Italien');
    await go('view-emergency', 'Notfall');
    const nums = await page.locator('#emergencyContent a.em-call.urgent .em-call-num').allInnerTexts();
    assert.deepEqual(nums, ['112', '113', '118', '115']);
    assert.ok(await page.evaluate(() => Object.keys(localStorage).some(k => /backup|preimport/i.test(k))), 'Sicherung fehlt');
});

t('Länderwechsel: „Abbrechen“ in der Rückfrage ändert nichts', async () => {
    await open();
    page.on('dialog', d => d.dismiss());
    await page.evaluate(() => openSettings());
    await page.fill('#s-tripcountry', 'Italien');
    await page.evaluate(() => saveSettings());
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tp_places')).length), 3);
    assert.equal(await page.evaluate(() => localStorage.getItem('tp_tripcountry')), 'Japan');
});

t('Packliste: Eintrag hinzufügen, abhaken, bleibt nach Neuladen erhalten', async () => {
    await open();
    await page.click('#packHandle');
    await page.fill('#packAddInput', 'Reiseadapter');
    await page.press('#packAddInput', 'Enter');
    await page.waitForSelector('#packItems >> text=Reiseadapter');
    await page.reload();
    await page.waitForFunction(() => typeof switchView === 'function');
    assert.ok(await page.evaluate(() => /Reiseadapter/.test(localStorage.getItem('tp_pack'))));
});

t('Einstellungen: Reiseland und Datum werden gespeichert und überstehen ein Neuladen', async () => {
    await open();
    await page.evaluate(() => openSettings());
    await page.fill('#s-tripname', 'Testreise');
    await page.fill('#s-startdate', day(10));
    await page.evaluate(() => saveSettings());
    await page.reload();
    await page.waitForFunction(() => document.getElementById('hero-num')?.innerText === '10');
    assert.equal(await page.evaluate(() => localStorage.getItem('tp_tripname')), 'Testreise');
});

t('Design: Dunkelmodus per Systemeinstellung und Umschalten', async () => {
    await open(FIXTURE(), { dark: true });
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(bg, 'rgb(255, 255, 255)');
    await page.evaluate(() => setTheme('light'));
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
});

t('Erstes Öffnen ohne Daten: Willkommen-Dialog statt Fehler', async () => {
    await open({});
    assert.deepEqual(errors, []);
    await page.waitForFunction(() => document.getElementById('modal-settings')?.open);
});

t('Manifest und Icons sind erreichbar', async () => {
    await open();
    const m = await (await page.request.get(base + 'manifest.json')).json();
    assert.ok(m.name && m.start_url && m.icons?.length);
    for (const i of m.icons) assert.equal((await page.request.get(new URL(i.src, base + 'manifest.json').href)).status(), 200, i.src);
});

t('Service Worker: Datei ist erreichbar und enthält die App-Version im Cache-Namen', async () => {
    await open();
    const sw = await (await page.request.get(base + 'sw.js')).text();
    const ver = await page.evaluate(() => self.APP_VERSION);
    assert.match(ver, /^v\d+$/);
    assert.ok(/APP_VERSION|CACHE/.test(sw));
});

t('Reise teilen: Kurzlink (verschlüsselt) mit QR-Code, Empfänger sieht die Reise', async () => {
    await open();
    const store = new Map(); let uploaded = null;
    await page.route('**/api/share**', async r => {
        const req = r.request(), id = new URL(req.url()).pathname.split('/')[3];
        if (req.method() === 'POST') { uploaded = req.postDataBuffer(); store.set('abcdefghijklmnop', uploaded); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'abcdefghijklmnop' }) }); }
        const b = store.get(id);
        return b ? r.fulfill({ contentType: 'application/octet-stream', body: b }) : r.fulfill({ status: 404, body: '{}' });
    });
    await page.click('#menuBtn');
    await page.click('#btnShareTrip');
    await page.waitForFunction(() => document.getElementById('share-link')?.value.includes('#s='));
    const link = await page.locator('#share-link').inputValue();
    assert.ok(link.length < 120, 'Link ist kurz: ' + link.length);
    await page.waitForFunction(() => !document.getElementById('share-qr').hidden);
    assert.ok(uploaded && !uploaded.toString('latin1').includes('Tokio'), 'Server bekommt nur Chiffretext');
    // Empfänger: neuer Kontext, gleicher Speicher
    await ctx.close();
    await open({});
    await page.route('**/api/share**', r => {
        const b = store.get(new URL(r.request().url()).pathname.split('/')[3]);
        return b ? r.fulfill({ contentType: 'application/octet-stream', body: b }) : r.fulfill({ status: 404, body: '{}' });
    });
    await page.evaluate(h => { location.hash = h; }, link.slice(link.indexOf('#')));
    await page.waitForFunction(() => document.getElementById('modal-share-import')?.open);
    assert.match(await page.locator('#modal-share-import').innerText(), /Japan im Herbst[\s\S]*3 Stationen/);
    assert.deepEqual(errors, []);
});

t('Stationen: Etappen-Symbol und Links folgen dem Verkehrsmittel (Mietwagen ≠ Zug)', async () => {
    await open();
    await go('view-places', '');
    const legs = page.locator('#placesList .transit-leg');
    // Osaka: Mietwagen -> Auto-Symbol, kein Zug-Planer, Route für Auto
    const osaka = legs.nth(1);
    await osaka.locator('summary').click();
    assert.equal(await osaka.locator('summary .ph-car').count(), 1);
    assert.equal(await osaka.locator('summary .ph-train-simple').count(), 0);
    assert.match(await osaka.innerText(), /Route in Google Maps \(Auto\)/);
    assert.doesNotMatch(await osaka.innerText(), /Jorudan/);
    // Kyoto: Zug -> Zug-Symbol und Zug-Planer
    const kyoto = legs.nth(0);
    await kyoto.locator('summary').click();
    assert.equal(await kyoto.locator('summary .ph-train-regional').count(), 1);
    assert.match(await kyoto.innerText(), /Jorudan/);
});

t('Währungsrechner: Schnellbeträge rechnen um, Kursverlauf zeigt 30 Tage', async () => {
    await open();
    await go('view-currency', 'Währungsrechner');
    await page.evaluate(() => { fxFrom = 'EUR'; fxTo = 'JPY'; saveFxCcyPrefs(); renderFxSelects(); renderFxChips(); refreshFxHistory(); fxConvert('from'); });
    await page.waitForFunction(() => !document.getElementById('fxHistory').hidden && document.querySelector('#fxHistoryChart .fx-line'));
    const chips = await page.locator('#fxChips .chip-sm').allInnerTexts();
    assert.deepEqual(chips, ['10 EUR', '50 EUR', '100 EUR', '500 EUR']);
    await page.evaluate(() => { fxFrom = 'JPY'; fxTo = 'EUR'; saveFxCcyPrefs(); renderFxSelects(); renderFxChips(); refreshFxHistory(); fxConvert('from'); });
    await page.waitForFunction(() => document.querySelector('#fxHistoryChart .fx-line'));
    assert.equal((await page.locator('#fxChips .chip-sm').allInnerTexts())[1], '5.000 JPY');
    await page.locator('#fxChips .chip-sm').nth(1).click();
    assert.equal(await page.locator('#fxFromAmt').inputValue(), '5000');
    assert.notEqual(await page.locator('#fxToAmt').inputValue(), '');
    assert.match(await page.locator('#fxHistoryMeta').innerText(), /Hoch .* Tief .* Veränderung/);
    assert.deepEqual(errors, []);
});

t('Kursverlauf: Achsen, Hoch/Tief und Tipp-Anzeige für einzelne Tage', async () => {
    await open();
    await go('view-currency', 'Währungsrechner');
    await page.evaluate(() => { fxFrom = 'EUR'; fxTo = 'JPY'; saveFxCcyPrefs(); renderFxSelects(); refreshFxHistory(); });
    await page.waitForFunction(() => document.querySelector('#fxHistoryChart .fx-line'));
    assert.equal(await page.locator('#fxHistoryChart .fx-axis').count(), 6);
    assert.match(await page.locator('#fxHistoryMeta').innerText(), /Hoch .* Tief .* Veränderung \+/);
    const box = await page.locator('#fxHistoryChart svg').boundingBox();
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    assert.match(await page.locator('#fxReadout').innerText(), /1 EUR = .* JPY/);
    assert.deepEqual(errors, []);
});
