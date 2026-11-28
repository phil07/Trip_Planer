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
    const text = await page.locator('#placesList').evaluate(el => el.textContent);
    assert.match(text, /geschätzt per Zug/);
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

t('Stationen: umbenennen behält die Station und ihre Aktivitäten', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.click('.place-more summary >> nth=0');
    await page.click('text=Umbenennen >> nth=0');
    await page.waitForFunction(() => document.getElementById('modal-rename').open);
    await page.fill('#rn-name', 'Neu Tokio');
    await page.click('#modal-rename .btn:not(.btn-secondary)');
    const txt = await page.locator('#view-places').innerText();
    assert.match(txt, /Neu Tokio/);
});

t('Stationen: Notiz hinzufügen und auf der Karte anzeigen', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.locator('#placesList .station-head >> nth=0').click();
    await page.click('#placesList .st-link:has-text("Notiz hinzufügen") >> nth=0');
    await page.waitForFunction(() => document.getElementById('modal-place-notes').open);
    await page.fill('#pn-text', 'Check-in ab 15 Uhr, siehe https://example.com/buchung.');
    await page.click('#modal-place-notes .btn:not(.btn-secondary)');
    await page.locator('#placesList .place-notes >> nth=0').waitFor();
    assert.match(await page.locator('#placesList .place-notes >> nth=0').innerText(), /Check-in ab 15 Uhr/);
    const link = page.locator('#placesList .place-notes a >> nth=0');
    assert.equal(await link.getAttribute('href'), 'https://example.com/buchung');
    assert.equal(await link.getAttribute('target'), '_blank');
    const saved = await page.evaluate(() => JSON.stringify(localStorage));
    assert.match(saved, /Check-in ab 15 Uhr/);
    assert.deepEqual(errors, []);
});

t('Stationen: eingeklappt kompakt, Tipp klappt Details auf', async () => {
    await open();
    await go('view-places', 'Stationen');
    const card = page.locator('#placesList .place-card.station >> nth=0');
    assert.equal(await card.locator('.station-details').isVisible(), false);
    assert.match(await card.locator('.station-head').innerText(), /\d{2}\.\d{2}\.[\s\S]*N(acht|ächte)/);
    await card.locator('.station-head').click();
    assert.equal(await card.locator('.nights-row').isVisible(), true);
    assert.equal(await card.locator('.station-head').getAttribute('aria-expanded'), 'true');
    // Anreise: eine Zeile, aufgeklappt mit Transportmittel und gebuchter Verbindung
    const arrival = page.locator('#placesList .transit-leg--end >> nth=0');
    assert.match(await arrival.locator('summary').innerText(), /Anreise nach/);
    await arrival.locator('summary').click();
    assert.match(await arrival.innerText(), /Transport und Buchung/);
    assert.deepEqual(errors, []);
});

t('Stationen: Buchungsbestätigung an die Unterkunft anhängen und öffnen', async () => {
    await open();
    await go('view-places', 'Stationen');
    const card = page.locator('#placesList .place-card.station >> nth=0');
    await card.locator('.station-head').click();
    await card.locator('.att-add').click();
    await page.waitForFunction(() => document.getElementById('modal-doc').open);
    assert.equal(await page.inputValue('#doc-cat'), 'hotel');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#docFileInput', { name: 'buchung.png', mimeType: 'image/png', buffer: png });
    await page.fill('#doc-title', 'Hotel Bestätigung');
    await page.click('#docSaveBtn');
    const chip = page.locator('#placesList .place-card.station >> nth=0').locator('.att-open[data-att-open]');
    await chip.waitFor();
    assert.match(await chip.innerText(), /Hotel Bestätigung/);
    await chip.click();
    await page.waitForFunction(() => document.getElementById('modal-doc-viewer').open);
    assert.deepEqual(errors, []);
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
    await go('view-settings', 'Einstellungen');
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
    const legs = page.locator('#placesList .transit-leg:not(.transit-leg--end)');
    // Osaka: Mietwagen -> Auto-Symbol, kein Zug-Planer, Route für Auto
    const osaka = legs.nth(1);
    await osaka.locator(':scope > summary').click();
    await osaka.locator('.transit-routes > summary').click();
    assert.equal(await osaka.locator(':scope > summary .ph-car').count(), 1);
    assert.equal(await osaka.locator(':scope > summary .ph-train-simple').count(), 0);
    assert.match(await osaka.innerText(), /Route in Google Maps \(Auto\)/);
    assert.doesNotMatch(await osaka.innerText(), /Jorudan/);
    // Kyoto: Zug -> Zug-Symbol und Zug-Planer
    const kyoto = legs.nth(0);
    await kyoto.locator(':scope > summary').click();
    await kyoto.locator('.transit-routes > summary').click();
    assert.equal(await kyoto.locator(':scope > summary .ph-train-regional').count(), 1);
    assert.match(await kyoto.innerText(), /Jorudan/);
});

t('Stationen: ein Dialog für Transportmittel und Buchung', async () => {
    await open();
    await go('view-places', '');
    const leg = page.locator('#placesList .transit-leg:not(.transit-leg--end)').nth(0);
    await leg.locator(':scope > summary').click();
    assert.equal(await leg.locator('.transit-edit').count(), 1, 'ein Knopf statt zwei');
    await leg.locator('.transit-edit').click();
    await page.waitForFunction(() => document.getElementById('modal-transit').open);
    assert.match(await page.locator('#modal-transit-title').innerText(), /Transport und Buchung/);
    assert.equal(await page.locator('#transit-modes .chip.active').getAttribute('data-mode'), 'Zug');
    await page.click('#transit-modes .chip[data-mode="Bus"]');
    assert.match(await page.locator('label[for="transit-train"]').innerText(), /Linie/);
    await page.fill('#transit-tdetail', 'Express');
    await page.click('#transit-save');
    const places = await page.evaluate(() => JSON.parse(localStorage.getItem('tp_places')));
    assert.equal(places[1].transport, 'Bus · Express');
    assert.deepEqual(errors, []);
});

t('Stationen: laufende Station markiert, Leerzustand mit nächstem Schritt', async () => {
    await open({ ...FIXTURE(), tp_start: day(-1) });
    await go('view-places', '');
    assert.match(await page.locator('#placesList .place-card.station >> nth=0').locator('.station-status').innerText(), /Aktuell/i);
    await page.evaluate(() => { places = []; saveData(); renderPlaces(); });
    assert.equal(await page.locator('#placesList .station-empty .empty-cta').count(), 1);
    assert.deepEqual(errors, []);
});

t('Navigation: untere Leiste, Zurück zur Startseite, Packliste nur auf Start', async () => {
    await open();
    assert.equal(await page.locator('#bottomNav .bn-item').count(), 5);
    assert.equal(await page.locator('#bottomNav .bn-item.active').getAttribute('data-view'), 'view-home');
    await page.click('#bottomNav [data-view="view-places"]');
    await page.waitForFunction(() => document.getElementById('view-places').classList.contains('active'));
    assert.equal(await page.locator('#bottomNav [data-view="view-places"]').getAttribute('aria-current'), 'page');
    await page.click('#bottomNav [data-view="view-dayplan"]');
    await page.waitForFunction(() => document.getElementById('view-dayplan').classList.contains('active'));
    // Zurück führt zur Startseite (nicht aus der App)
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('view-home').classList.contains('active'));
    // „Mehr“ öffnet das Menü, Packliste ist dort auffindbar
    await page.click('#bn-more');
    await page.waitForFunction(() => document.getElementById('app').classList.contains('menu-open'));
    assert.equal(await page.locator('#menu-pack').count(), 0, 'Packliste ist kein eigener Menüpunkt');
    await page.click('#menu-home');
    await page.waitForFunction(() => !document.getElementById('app').classList.contains('menu-open'));
    assert.equal(await page.locator('#packHandle').isVisible(), true, 'Packliste liegt auf der Startseite');
    assert.deepEqual(errors, []);
});

t('Navigation: neue Reise per Formular, Route-Dialog fragt fehlendes Land selbst', async () => {
    await open();
    await go('view-settings', 'Einstellungen');
    await page.evaluate(() => { tripNewFromSettings(); });
    await page.waitForFunction(() => document.getElementById('modal-asktext').open);
    await page.click('#asktext-ok');
    assert.equal(await page.locator('#asktext-err').isVisible(), true, 'Fehler am Feld');
    assert.equal(await page.locator('#asktext-input').getAttribute('aria-invalid'), 'true');
    await page.click('#asktext-cancel');
    // Route-Dialog ohne Reiseland zeigt ein Landfeld
    await page.evaluate(() => { tripCountry = ''; openRouteWizard(); });
    assert.equal(await page.locator('#rw-country-wrap').isVisible(), true);
    assert.deepEqual(errors, []);
});

t('Start: Einstiegs-Schritte haken sich ab und lassen sich ausblenden', async () => {
    await open({ tp_onboarded: '1', tp_start: day(5), tp_tripname: 'Test', tp_tripcountry: 'Japan', tp_tripcountry_manual: '1', tp_crawled: '1', tp_places: '[]', tp_acts: '[]' });
    assert.equal(await page.locator('#homeSteps').isVisible(), true);
    assert.equal(await page.locator('#homeSteps li.done').count(), 1);
    await page.click('#homeSteps .link-btn');
    assert.equal(await page.locator('#homeSteps').isVisible(), false);
    assert.deepEqual(errors, []);
});

t('Layout: Startseite läuft bei vielen Stationen und langen Namen nicht über den Bildschirm', async () => {
    const names = ['Tokyo', 'Fukuoka', 'Kumamoto', 'Miyazaki', 'Kagoshima', 'Osaka', 'Kyoto', 'Nara', 'Kobe', 'Himeji', 'Hiroshima', 'Nagoya', 'Sapporo', 'Sendai', 'Nagano'];
    const seed = { ...FIXTURE(), tp_places: JSON.stringify(names.map((n, i) => ({ id: i + 1, name: n, nights: 2, lat: 35 - i * .3, lng: 139 - i * .3, hotel: 'Hotel Tokyo Trip Ueno Nishi Nippori Annex', hotelLat: 35, hotelLng: 139, transport: i ? 'Zug' : 'Flug' }))) };
    await open(seed);
    for (const w of [360, 411]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => { const h = document.querySelector('.home-scroll'); return { sw: h.scrollWidth, cw: h.clientWidth }; });
        assert.ok(m.sw <= m.cw + 1, `Startseite bei ${w}px zu breit: ${m.sw} > ${m.cw}`);
        // Handy: eine Spalte, die Karten nutzen die volle Breite
        const wide = await page.evaluate(() => { const c = document.querySelector('#homeStats .stat-card'), h = document.querySelector('.home-scroll'); return c.getBoundingClientRect().width > h.clientWidth * 0.2 && document.querySelector('.home-next').getBoundingClientRect().width > h.clientWidth * 0.8; });
        assert.ok(wide, `Startseite bei ${w}px nicht einspaltig`);
    }
    assert.deepEqual(errors, []);
});

t('Aktivitäten: Neu-laden-Symbol sitzt mittig im Knopf', async () => {
    await open();
    await go('view-activities', 'Aktivitäten');
    const off = await page.evaluate(() => {
        const b = document.getElementById('activitiesFab').getBoundingClientRect(), i = document.querySelector('#activitiesFab svg').getBoundingClientRect();
        return { dx: Math.abs((b.left + b.width / 2) - (i.left + i.width / 2)), dy: Math.abs((b.top + b.height / 2) - (i.top + i.height / 2)), w: i.width, h: i.height };
    });
    assert.ok(off.dx <= 1 && off.dy <= 1, `Symbol nicht mittig: ${off.dx}/${off.dy}`);
    assert.equal(off.w, off.h, 'Symbol-Box ist quadratisch');
    // Während der Drehung bleibt der Mittelpunkt an derselben Stelle (kein Eiern)
    await page.evaluate(() => document.getElementById('activitiesFab').classList.add('spinning'));
    const centers = [];
    for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(130);
        centers.push(await page.evaluate(() => { const r = document.querySelector('#activitiesFab svg').getBoundingClientRect(), b = document.getElementById('activitiesFab').getBoundingClientRect(); return [r.left + r.width / 2 - (b.left + b.width / 2), r.top + r.height / 2 - (b.top + b.height / 2)]; }));
    }
    const spread = Math.max(...centers.map(c => Math.hypot(c[0], c[1])));
    assert.ok(spread < 0.5, `Symbol weicht beim Drehen von der Knopfmitte ab um ${spread.toFixed(2)} px`);
    assert.deepEqual(errors, []);
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

// ─── Cloud-Sync mit Verschlüsselung gegen ein nachgebautes Google Drive ─────
function fakeDrive() {
    const files = new Map(); let n = 0;
    const stamp = () => new Date(Date.now() + (++n) * 1000).toISOString();
    return { files, async handle(route) {
        const req = route.request(), u = new URL(req.url()), m = req.method();
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        const id = u.pathname.split('/files/')[1];
        if (u.pathname.startsWith('/upload/') && m === 'PATCH') {
            const f = files.get(id); if (!f) return json({ error: { message: 'nicht gefunden' } }, 404);
            f.body = req.postDataBuffer() || Buffer.alloc(0); f.modifiedTime = stamp();
            return json({ id, modifiedTime: f.modifiedTime });
        }
        if (!id && m === 'POST') { const nid = 'f' + (++n); files.set(nid, { name: JSON.parse(req.postData()).name, body: Buffer.alloc(0), modifiedTime: stamp() }); return json({ id: nid }); }
        if (!id && m === 'GET') {
            const q = u.searchParams.get('q') || '';
            const eq = /name='([^']+)'/.exec(q), has = /name contains '([^']+)'/.exec(q);
            const out = [...files].filter(([, f]) => eq ? f.name === eq[1] : has ? f.name.includes(has[1]) : true).map(([fid, f]) => ({ id: fid, name: f.name, modifiedTime: f.modifiedTime }));
            return json({ files: out });
        }
        const f = files.get(id);
        if (!f) return json({ error: { message: 'nicht gefunden' } }, 404);
        if (m === 'DELETE') { files.delete(id); return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }); }
        if (u.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: f.body });
        return json({ id, modifiedTime: f.modifiedTime });
    } };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function openWithDrive(drive, seed) {
    await open(seed);
    await page.route(/^https:\/\/www\.googleapis\.com\//, r => drive.handle(r));
    await page.evaluate(() => {
        localStorage.setItem('tp_sync_token', JSON.stringify({ token: 't', exp: Date.now() + 3600e3 }));
        localStorage.setItem('tp_sync_meta', JSON.stringify({ enabled: true }));
    });
}
const enterPw = async (pw, twice) => {
    await page.waitForFunction(() => document.getElementById('modal-vault-pw')?.open);
    await page.fill('#vault-pw-1', pw);
    if (twice) await page.fill('#vault-pw-2', pw);
    await page.click('#vault-pw-ok');
};

t('Cloud: Sync-Passwort verschlüsselt Reisedaten und Dokumente, zweites Gerät entsperrt sie', async () => {
    const drive = fakeDrive();
    await openWithDrive(drive);
    assert.equal((await page.evaluate(() => TripPlannerSync.syncNow())).action, 'created');
    const tripFile = () => [...drive.files.values()].find(f => f.name === 'trip-planer-sync.json');
    assert.match(tripFile().body.toString(), /Tokio/); // vorher: lesbar

    // Dokument anlegen, dann Verschlüsselung einrichten
    await go('view-documents', 'Dokumente');
    await page.click('[data-doc-add]');
    await page.setInputFiles('#docFileInput', { name: 'pass.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#doc-title', 'Reisepass Geheim');
    await page.click('#docSaveBtn');
    await page.locator('.doc-item').waitFor();
    await go('view-settings', 'Einstellungen');
    await page.click('#btnVaultSetup');
    await enterPw('korrekt-pferd-batterie', true);
    await page.waitForFunction(() => /Dokument verschlüsselt gesichert/.test(document.getElementById('sync-status').textContent));
    const body = tripFile().body.toString();
    assert.doesNotMatch(body, /Tokio/);
    assert.match(body, /"enc":1/);
    const docFile = [...drive.files.values()].find(f => f.name.startsWith('tp-doc-main-'));
    assert.ok(docFile && docFile.body.length > 50);
    assert.equal(docFile.body.includes(Buffer.from('Reisepass Geheim')), false);
    assert.ok([...drive.files.values()].some(f => f.name === 'tp-vault.json'));
    assert.deepEqual(errors, []);
    await ctx.close();

    // Zweites Gerät: leerer Speicher, falsches und dann richtiges Passwort
    await openWithDrive(drive, { tp_onboarded: '1' });
    const done = page.evaluate(() => TripPlannerSync.connect());
    await enterPw('falsch-falsch', false);
    await page.waitForFunction(() => /Falsches Passwort/.test(document.body.innerText));
    await enterPw('korrekt-pferd-batterie', false);
    await done.catch(() => {}); // die App lädt nach dem Übernehmen neu
    await page.waitForFunction(() => /Tokio/.test(localStorage.getItem('tp_places') || '') && typeof switchView === 'function' && window.TripPlannerSync && document.getElementById('hero-num')?.innerText !== '–');
    await page.waitForTimeout(1200);
    assert.match(await page.evaluate(() => JSON.stringify(places)), /Tokio/); // Stand ist wirklich in der App, nicht nur im Speicher
    await page.evaluate(() => TripPlannerSync.syncDocs());
    await page.evaluate(() => switchView('view-documents', 'Dokumente'));
    await page.locator('.doc-item').waitFor();
    assert.match(await page.locator('.doc-item').innerText(), /Reisepass Geheim/);

    // Löschen auf Gerät 2 entfernt die Datei in der Cloud
    await page.click('[data-doc-del]');
    await page.waitForFunction(() => !document.querySelector('.doc-item'));
    await page.evaluate(() => TripPlannerSync.syncDocs());
    assert.equal([...drive.files.values()].some(f => f.name.startsWith('tp-doc-main-')), false);
});

t('Vollständiges Backup: verschlüsselte Datei enthält Dokumente und lässt sich wiederherstellen', async () => {
    await open();
    await go('view-documents', 'Dokumente');
    await page.click('[data-doc-add]');
    await page.setInputFiles('#docFileInput', { name: 'pass.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#doc-title', 'Ticket Geheim');
    await page.click('#docSaveBtn');
    await page.locator('.doc-item').waitFor();
    await go('view-settings', 'Einstellungen');
    const dl = page.waitForEvent('download');
    await page.click('#btnFullBackup');
    await enterPw('backup-passwort', true);
    const file = await (await dl).path();
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 5).toString(), 'TPBK1');
    assert.equal(bytes.includes(Buffer.from('Tokio')), false);
    assert.equal(bytes.includes(Buffer.from('Ticket Geheim')), false);
    await ctx.close();

    await open({ tp_onboarded: '1' });
    await go('view-settings', 'Einstellungen');
    page.on('dialog', d => d.accept());
    await page.setInputFiles('#importFileInput', { name: 'x.tpbackup', mimeType: 'application/octet-stream', buffer: bytes });
    await enterPw('backup-passwort', false);
    await page.waitForFunction(() => /Tokio/.test(localStorage.getItem('tp_places') || ''));
    await page.waitForLoadState('load');
    await page.waitForFunction(() => typeof switchView === 'function' && window.documentsFeature);
    await page.evaluate(() => switchView('view-documents', 'Dokumente'));
    await page.locator('.doc-item').waitFor();
    assert.match(await page.locator('.doc-item').innerText(), /Ticket Geheim/);
});

t('Buchungsbestätigung: Hotelname wird gelesen und in die Station übernommen', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.evaluate(() => { window.Tesseract = { recognize: async () => ({ data: { text: 'Booking confirmed\nHotel: Hotel Gracery Shinjuku\nCheck-in 18.11.' } }) }; });
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    const card = page.locator('#placesList .place-card.station >> nth=0');
    await card.locator('.station-head').click();
    await card.locator('.att-add').click();
    await page.waitForFunction(() => document.getElementById('modal-doc').open);
    await page.setInputFiles('#docFileInput', { name: 'buchung.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#doc-title', 'Hotelbestätigung');
    await page.click('#docSaveBtn');
    // Prüfdialog statt stillem Eintragen: Name vorbefüllt, änderbar
    const review = page.locator('#modal-booking-review');
    await review.locator('[data-br="ok"]').waitFor({ timeout: 15000 });
    assert.equal(await review.locator('#br-hotel').inputValue(), 'Hotel Gracery Shinjuku');
    await review.locator('[data-br="ok"]').click();
    await page.waitForFunction(() => (places[0].hotel || '').includes('Gracery Shinjuku'), null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => places[0].hotel), 'Hotel Gracery Shinjuku');
    assert.equal(dialogs.length, 0);
    assert.deepEqual(errors, []);
});

t('Buchungen an Stationen: erneut lesen und wieder entfernen', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.evaluate(() => { window.Tesseract = { recognize: async () => ({ data: { text: 'Hotel: Hotel Gracery Shinjuku' } }) }; });
    page.on('dialog', d => d.accept());
    const card = () => page.locator('#placesList .place-card.station >> nth=0');
    await card().locator('.station-head').click();
    await card().locator('.att-add').click();
    await page.waitForFunction(() => document.getElementById('modal-doc').open);
    await page.setInputFiles('#docFileInput', { name: 'buchung.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#doc-title', 'Hotelbestätigung');
    await page.click('#docSaveBtn');
    await page.locator('#modal-booking-review [data-br="ok"]').click({ timeout: 15000 });
    await page.waitForFunction(() => places[0].hotel === 'Hotel Gracery Shinjuku', null, { timeout: 15000 });
    // Erneut lesen: neue Schreibweise im Text, Name wird nach Rückfrage ersetzt
    await page.evaluate(() => { window.Tesseract = { recognize: async () => ({ data: { text: 'Hotel: Hotel Gracery Shinjuku Tokyo' } }) }; });
    await card().locator('.att-menu').click();
    await card().locator('[data-att-scan]').click();
    await page.locator('#modal-booking-review [data-br="ok"]').click({ timeout: 15000 });
    await page.waitForFunction(() => places[0].hotel === 'Hotel Gracery Shinjuku Tokyo', null, { timeout: 15000 });
    // Entfernen: Bestätigung verschwindet aus der Station
    assert.equal(await card().locator('.att-pill').count(), 1);
    // Die Liste wird nach dem Lesen neu gezeichnet; Menü erst öffnen, wenn es sichtbar bleibt.
    await card().locator('.att-menu').click();
    await card().locator('.att-del').waitFor({ state: 'visible', timeout: 1500 }).catch(() => card().locator('.att-menu').click());
    await card().locator('.att-del').click();
    await page.waitForFunction(() => !document.querySelector('#placesList .place-card.station .att-pill'), null, { timeout: 5000 });
    assert.deepEqual(errors, []);
});

t('Anreise: Flugdaten aus der Bestätigung werden eingetragen, Pille zum Entfernen', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.evaluate(() => { window.Tesseract = { recognize: async () => ({ data: { text: 'Flugnummer LH716\nAbflug 10:15\nFrankfurt - Tokio' } }) }; });
    page.on('dialog', d => d.accept());
    const arrival = page.locator('#placesList .transit-leg--end >> nth=0');
    await arrival.locator('summary').click();
    await arrival.locator('.att-add').click();
    await page.waitForFunction(() => document.getElementById('modal-doc').open);
    await page.setInputFiles('#docFileInput', { name: 'flug.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#doc-title', 'Flugbestätigung');
    await page.click('#docSaveBtn');
    await page.locator('#modal-booking-review [data-br="ok"]').click({ timeout: 15000 });
    await page.waitForFunction(() => places[0].transit && places[0].transit.dep === '10:15', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => places[0].transit.train), 'LH 716');
    // Entfernen über die Pille
    await page.locator('#placesList .transit-leg--end >> nth=0').locator('.att-pill .att-menu').click();
    // Das Menü darf nicht vom Pillen-Rahmen abgeschnitten werden: der Knopf muss an seiner Mitte treffbar sein.
    const delBox = await page.locator('#placesList .transit-leg--end >> nth=0').locator('.att-pill .att-del').boundingBox();
    assert.ok(delBox, 'Menü ist sichtbar');
    const hit = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el?.closest('.att-del'); }, [delBox.x + delBox.width / 2, delBox.y + delBox.height / 2]);
    assert.equal(hit, true, 'Menü-Knopf ist nicht abgeschnitten');
    await page.locator('#placesList .transit-leg--end >> nth=0').locator('.att-pill .att-del').click();
    await page.waitForFunction(() => !document.querySelector('#placesList .transit-leg--end .att-pill'), null, { timeout: 5000 });
    assert.deepEqual(errors, []);
});

t('Verbindung: Flug zeigt Flugnummer und Abflug statt Zug', async () => {
    await open();
    await go('view-places', 'Stationen');
    const arrival = page.locator('#placesList .transit-leg--end >> nth=0');
    await arrival.locator('summary').click();
    await arrival.locator('.transit-edit').click();
    await page.waitForFunction(() => document.getElementById('modal-transit')?.open);
    assert.equal(await page.locator('label[for="transit-train"]').innerText(), 'Flugnummer');
    assert.equal(await page.locator('label[for="transit-dep"]').innerText(), 'Abflug');
    await page.click('#transit-cancel');
    assert.deepEqual(errors, []);
});

t('Flug: Terminal, Gate und Sitz sind eigene Felder und werden getrennt gespeichert', async () => {
    await open();
    await go('view-places', 'Stationen');
    const arrival = page.locator('#placesList .transit-leg--end >> nth=0');
    await arrival.locator('summary').click();
    await arrival.locator('.transit-edit').click();
    await page.waitForFunction(() => document.getElementById('modal-transit')?.open);
    assert.equal(await page.locator('#transit-terminal-wrap').isVisible(), true);
    assert.equal(await page.locator('#transit-gate-wrap').isVisible(), true);
    await page.fill('#transit-train', 'JL 407');
    await page.fill('#transit-dep', '10:40');
    await page.fill('#transit-terminal', '2');
    await page.fill('#transit-gate', '23');
    await page.fill('#transit-seat', '18K');
    await page.click('#transit-save');
    await page.waitForFunction(() => places[0].transit && places[0].transit.seat === '18K');
    const tr = await page.evaluate(() => places[0].transit);
    assert.equal(tr.terminal, '2');
    assert.equal(tr.gate, '23');
    assert.equal(tr.seat, '18K');
    assert.deepEqual(errors, []);
});

t('Buchung als PDF: Tipp öffnet die Anzeige in der App (ohne Netz mit Ausweg)', async () => {
    await open();
    await go('view-places', 'Stationen');
    const card = () => page.locator('#placesList .place-card.station >> nth=0');
    await card().locator('.station-head').click();
    await card().locator('.att-add').click();
    await page.waitForFunction(() => document.getElementById('modal-doc').open);
    await page.setInputFiles('#docFileInput', { name: 'buchung.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await page.fill('#doc-title', 'Hotelbuchung PDF');
    await page.click('#docSaveBtn');
    await card().locator('.att-open').waitFor();
    await card().locator('.att-open').click();
    await page.waitForFunction(() => document.getElementById('modal-doc-viewer').open);
    assert.equal(await page.locator('#docViewerTitle').innerText(), 'Hotelbuchung PDF');
    // pdf.js ist im Test nicht erreichbar: Hinweis und Ausweg statt eines leeren Bildschirms
    await page.locator('#docPdfExternal').waitFor();
    assert.deepEqual(errors, []);
});

t('Aktivitäten: weit entfernte Treffer fallen weg, Liste nächste zuerst', async () => {
    const seed = FIXTURE();
    const acts = JSON.parse(seed.tp_acts);
    // Kyoto-Hotel liegt bei 35.0094/135.76. Busan (~460 km) ist ein automatischer Treffer und muss raus;
    // ein weit entfernter Favorit bleibt erhalten.
    acts.push(
        { id: 21, topPlace: 'Kyoto', type: '🏯 Sehenswürdigkeit', title: 'Gamcheon Kulturdorf Busan', desc: 'Busan', lat: 35.0975, lng: 129.0106, favorite: false, day: '', dayOrder: 0, time: '' },
        { id: 22, topPlace: 'Kyoto', type: '🏯 Sehenswürdigkeit', title: 'Kinkaku-ji', desc: 'Tempel', lat: 35.0394, lng: 135.7292, favorite: false, day: '', dayOrder: 0, time: '' },
        { id: 23, topPlace: 'Kyoto', type: '🏯 Sehenswürdigkeit', title: 'Nishiki Markt', desc: 'Markt', lat: 35.005, lng: 135.7649, favorite: false, day: '', dayOrder: 0, time: '' },
        { id: 24, topPlace: 'Kyoto', type: '🏯 Sehenswürdigkeit', title: 'Lieblingsort weit weg', desc: 'Favorit', lat: 35.1, lng: 129.0, favorite: true, day: '', dayOrder: 0, time: '' }
    );
    seed.tp_acts = JSON.stringify(acts);
    await open(seed);
    assert.equal(await page.evaluate(() => acts.some(a => a.title.includes('Busan'))), false, 'Busan-Treffer wurde entfernt');
    assert.equal(await page.evaluate(() => acts.some(a => a.title === 'Lieblingsort weit weg')), true, 'Favorit bleibt');
    await go('view-activities', 'Aktivitäten');
    await page.evaluate(() => setFilter('Kyoto'));
    const titles = await page.locator('#activitiesList .act-title').allInnerTexts();
    // Nishiki (~0,7 km vom Hotel) vor Kinkaku-ji (~4 km) vor Fushimi Inari (~5 km), Favorit weit weg zuletzt.
    assert.deepEqual(titles.filter(x => ['Nishiki Markt', 'Kinkaku-ji', 'Fushimi Inari', 'Lieblingsort weit weg'].includes(x)),
        ['Nishiki Markt', 'Kinkaku-ji', 'Fushimi Inari', 'Lieblingsort weit weg']);
    assert.match(await page.locator('#activitiesList .act-card').first().locator('.act-type').innerText(), /vom Hotel/);
    assert.deepEqual(errors, []);
});

t('Aktivitäten: Titel auf Deutsch, Original nur intern', async () => {
    await open();
    await page.route(/translate\.googleapis\.com/, r => {
        const q = new URL(r.request().url()).searchParams.get('q') || '';
        const out = q.split('\n').map(l => l === 'Ichiran Ramen' ? 'Ichiran Nudelsuppe' : l).join('\n');
        r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([[[out, q]]]) });
    });
    await page.evaluate(() => translateActTitles());
    await page.waitForFunction(() => acts.find(a => a.title === 'Ichiran Ramen')?.titleDe === 'Ichiran Nudelsuppe', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => acts.find(a => a.title === 'Senso-ji Tempel').titleDe), '', 'unverändert bleibt das Original');
    await go('view-activities', 'Aktivitäten');
    await page.evaluate(() => { setFilter('Tokio'); renderActs(); });
    const card = page.locator('#activitiesList .act-card', { hasText: 'Ichiran Nudelsuppe' });
    assert.equal(await card.locator('.act-title').innerText(), 'Ichiran Nudelsuppe');
    assert.equal(await card.locator('.act-orig').count(), 0, 'Originalname wird nicht angezeigt');
    // Suche findet auch das Original, Bearbeiten zeigt den deutschen Titel und behält das Original
    await page.evaluate(() => openActivityDialog(acts.find(x => x.title === 'Ichiran Ramen')));
    assert.equal(await page.inputValue('#a-title'), 'Ichiran Nudelsuppe');
    await page.evaluate(() => saveActivityManual());
    assert.equal(await page.evaluate(() => acts.filter(x => x.title === 'Ichiran Ramen' && x.titleDe === 'Ichiran Nudelsuppe').length), 1, 'Original bleibt beim Speichern ohne Änderung');
    assert.deepEqual(errors, []);
});

t('Aktivitäten: fehlende Beschreibungen schreibt die KI', async () => {
    await open();
    let asked = null;
    await page.route(/text\.pollinations\.ai/, async r => {
        const body = JSON.parse(r.request().postData() || '{}');
        asked = JSON.parse(body.messages[1].content);
        const d = asked.map(x => ({ i: x.i, t: `${x.name} ist ein bekannter Ort in ${x.ort}, gut für einen Besuch.` }));
        r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ d }) });
    });
    const ja = '水鏡天満宮（すいきょうてんまんぐう）は、福岡県福岡市中央区天神一丁目にある天満宮の1つである。';
    await page.evaluate(ja => { acts.find(a => a.title === 'Fushimi Inari').desc = ja; fillMissingDescs(); }, ja);
    await page.waitForFunction(() => acts.find(a => a.title === 'Fushimi Inari')?.desc.includes('bekannter Ort'), null, { timeout: 5000 });
    assert.equal(asked.find(x => x.original === 'Fushimi Inari').hinweis, ja, 'fremdsprachiger Text geht als Quelle an die KI');
    assert.equal(await page.evaluate(() => acts.find(a => a.title === 'Fushimi Inari').descDe), true);
    assert.ok(asked.length >= 3, 'alle Einträge mit Platzhalter wurden angefragt');
    assert.deepEqual(errors, []);
});

t('Aktivitäten: Aktualisieren lädt automatisch gefundene neu, Favoriten und Geplantes bleiben', async () => {
    const seed = FIXTURE();
    const acts = JSON.parse(seed.tp_acts);
    acts.push({ id: 31, topPlace: 'Tokio', type: '🏯 Sehenswürdigkeit', title: 'Alter Treffer', desc: 'Alt', lat: 35.68, lng: 139.7, favorite: false, day: '', dayOrder: 0, time: '' });
    seed.tp_acts = JSON.stringify(acts);
    await open(seed);
    await go('view-activities', 'Aktivitäten');
    await page.evaluate(() => setFilter('Tokio'));
    await page.evaluate(() => refreshActivities());
    const left = await page.evaluate(() => acts.filter(a => a.topPlace === 'Tokio').map(a => a.title).sort());
    assert.equal(left.includes('Alter Treffer'), false, 'alter automatischer Treffer ist weg');
    assert.ok(left.includes('Ichiran Ramen') && left.includes('Senso-ji Tempel'), 'Favorit und Eingeplantes bleiben');
    assert.equal(await page.evaluate(() => acts.some(a => a.title === 'Fushimi Inari')), true, 'andere Orte unberührt');
    assert.equal(await page.evaluate(() => acts.some(a => a.lat == null && !a.manual)), false, 'keine erfundenen Platzhalter ohne Ort');
    assert.deepEqual(errors, []);
});

t('Übersetzung: ohne Google übernimmt Cloudflare, danach MyMemory', async () => {
    await open();
    // Google bleibt gesperrt (Standard im Test). Cloudflare übersetzt nur "Ichiran Ramen".
    let cfAsked = null;
    await page.route(/\/api\/translate$/, async r => {
        const body = JSON.parse(r.request().postData() || '{}');
        cfAsked = body;
        r.fulfill({ contentType: 'application/json', body: JSON.stringify({ texts: body.texts.map(t => t === 'Ichiran Ramen' ? 'Ichiran Nudeln' : null) }) });
    });
    await page.route(/api\.mymemory\.translated\.net/, r => {
        const q = new URL(r.request().url()).searchParams.get('q');
        r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: q === 'Senso-ji Tempel' ? 'Sensoji-Tempel' : q } }) });
    });
    await page.evaluate(() => translateActTitles());
    await page.waitForFunction(() => acts.find(a => a.title === 'Ichiran Ramen')?.titleDe === 'Ichiran Nudeln', null, { timeout: 8000 });
    await page.waitForFunction(() => acts.find(a => a.title === 'Senso-ji Tempel')?.titleDe === 'Sensoji-Tempel', null, { timeout: 8000 });
    assert.ok(cfAsked.sources.every(s => /^[a-z]{2}$/.test(s)), 'Quellsprache wird mitgeschickt');
    assert.deepEqual(errors, []);
});

t('Übersetzung: Endlosschleife ("Tokyo-Tokyo-…") wird verworfen, nächste Stufe springt ein', async () => {
    await open();
    await page.route(/\/api\/translate$/, r => r.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ texts: ['Der Garten von Tokyo-Tokyo-Tokyo-Tokyo-Tokyo-Tokyo-'] }) }));
    await page.route(/api\.mymemory\.translated\.net/, r => r.fulfill({ contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'Der Ostgarten des Kaiserpalasts.' } }) }));
    const out = await page.evaluate(() => translateManyToGerman(['皇居東御苑は皇居の東側にある庭園です。']));
    assert.deepEqual(out, ['Der Ostgarten des Kaiserpalasts.']);
    const cleaned = await page.evaluate(() => {
        return typeof badTranslation === 'function' && badTranslation('Seite des Königshauses von Tokyo-Tokyo-Tokyo-Tokyo-Tokyo-') && !badTranslation('Bora Bora ist eine Insel.');
    });
    assert.ok(cleaned);
    assert.deepEqual(errors, []);
});

t('ToDos: hinzufügen, bearbeiten, abhaken, entfernen und im Backup', async () => {
    await open();
    await page.evaluate(() => switchView('view-todos', 'ToDos'));
    await page.fill('#todoAddInput', 'JR Pass bestellen');
    await page.press('#todoAddInput', 'Enter');
    await page.fill('#todoAddInput', 'Yen abheben');
    await page.click('#todoAddForm button[type="submit"]');
    assert.equal(await page.locator('#todoContent .todo-item').count(), 2);
    assert.equal(await page.textContent('#menu-todos-count'), '2');
    // Bearbeiten: Text, Fälligkeit und Notiz
    await page.click('[data-todo-edit] >> text=JR Pass bestellen');
    await page.fill('#todo-text', 'JR Pass online bestellen');
    await page.fill('#todo-due', '2020-01-01');
    await page.fill('#todo-note', 'Mit Reisepassnummer');
    await page.click('#todoSaveBtn');
    const first = page.locator('#todoContent .todo-item').first();
    assert.match(await first.textContent(), /JR Pass online bestellen[\s\S]*Überfällig[\s\S]*Mit Reisepassnummer/);
    // Abhaken: wandert nach „Erledigt“
    await page.click('input[aria-label="JR Pass online bestellen abhaken"]');
    assert.equal(await page.locator('#todoContent .todo-item').count(), 1);
    assert.match(await page.textContent('#todoDoneToggle'), /Erledigt \(1\)/);
    assert.equal(await page.textContent('#menu-todos-count'), '1');
    // Entfernen mit Rückgängig
    await page.click('[data-todo-del]');
    assert.equal(await page.locator('#todoContent .todo-item').count(), 0);
    await page.click('#toast .toast-action');
    assert.equal(await page.locator('#todoContent .todo-item').count(), 1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tp_todos')));
    assert.equal(stored.items.length, 2);
    assert.ok(stored.items.some(x => x.done && x.due === '2020-01-01' && x.note === 'Mit Reisepassnummer'));
    assert.ok(await page.evaluate(() => EXPORT_KEYS.includes('tp_todos')));
    assert.deepEqual(errors, []);
});

t('Bestätigung: KI ergänzt fehlende Angaben, Prüfdialog erlaubt Korrektur', async () => {
    await open();
    let asked = null;
    await page.route(/\/api\/extract$/, r => { asked = JSON.parse(r.request().postData()); r.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ data: { number: 'GK 513', dep: '15:25', terminal: '3', gate: '', seat: '', from: 'NRT', to: 'FUK', date: '2026-11-28' } }) }); });
    const id = await page.evaluate(() => places[1].id);
    // Text, in dem die Regeln nichts finden; E-Mail darf nicht an die KI gehen
    const run = page.evaluate(([id]) => window.bookingRead.applyTransit('leg:' + id,
        'Reiseplan\nAirline: Sonnenflieger\nmax@example.com\nLos geht es um viertel nach drei', null, false), [id]);
    const review = page.locator('#modal-booking-review');
    await review.locator('[data-br="ok"]').waitFor({ timeout: 10000 });
    assert.match(await review.innerText(), /KI[\s\S]*nach Fukuoka \(FUK\) · 28\.11\.2026/);
    assert.equal(await review.locator('#br-train').inputValue(), 'GK 513');
    assert.equal(await review.locator('#br-from').inputValue(), 'Tokyo Narita (NRT)');
    await review.locator('#br-seat').fill('14C');
    await review.locator('[data-br="ok"]').click();
    await run;
    const tr = await page.evaluate(([id]) => places.find(p => p.id === id).transit, [id]);
    assert.equal(tr.train, 'GK 513'); assert.equal(tr.dep, '15:25'); assert.equal(tr.terminal, '3'); assert.equal(tr.seat, '14C');
    assert.equal(tr.from, 'Tokyo Narita (NRT)');
    assert.equal(asked.kind, 'transit');
    assert.ok(!/example\.com/.test(asked.text));
    // Abbrechen trägt nichts ein; leiser Lauf beim Start überschreibt nichts
    const run2 = page.evaluate(([id]) => window.bookingRead.applyTransit('leg:' + id, 'Flugnummer LH716\nAbflug 10:15', null, false), [id]);
    await review.locator('[data-br="cancel"]').click({ timeout: 10000 });
    await run2;
    await page.evaluate(([id]) => window.bookingRead.applyTransit('leg:' + id, 'Flugnummer LH716\nAbflug 10:15', null, true), [id]);
    assert.equal(await page.evaluate(([id]) => places.find(p => p.id === id).transit.train, [id]), 'GK 513');
    assert.deepEqual(errors, []);
});

t('Texterkennung: Bild wird vorbereitet (Statusleiste weg, dunkel invertiert, vergrößert)', async () => {
    await open();
    const r = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 900;
        const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, 400, 900); g.fillStyle = '#eee'; g.fillRect(50, 400, 300, 40);
        const out = window.bookingRead.prepareForOcr(c);
        const px = out.getContext('2d').getImageData(5, 5, 1, 1).data[0];
        return { w: out.width, h: out.height, bg: px };
    });
    assert.equal(r.w, 1600);
    assert.ok(r.h < 900 * 4 && r.h > 3400, 'Statusleiste abgeschnitten: ' + r.h);
    assert.ok(r.bg > 200, 'dunkler Hintergrund wird hell: ' + r.bg);
    assert.deepEqual(errors, []);
});

t('Station: Navigation zur Unterkunft öffnet Google Maps ab aktuellem Standort', async () => {
    await open();
    await go('view-places', 'Stationen');
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    const card = page.locator('#placesList .place-card.station >> nth=0');
    await card.locator('.station-head').click();
    await card.locator('.hotel-nav').click();
    const urls = await page.evaluate(() => {
        const p = places[0], out = [window.__opened[0]];
        // ohne Koordinaten: Suche nach Hotelname und Ort
        out.push(hotelNavUrl({ name: 'Kyoto', hotel: 'Royal Park' }));
        return out.concat([p.hotelLat, p.hotelLng]);
    });
    assert.equal(urls[0], `https://www.google.com/maps/dir/?api=1&destination=${urls[2]},${urls[3]}`);
    assert.ok(!/origin=/.test(urls[0]), 'Start = aktueller Standort');
    assert.equal(urls[1], 'https://www.google.com/maps/dir/?api=1&destination=Royal%20Park%2C%20Kyoto');
    assert.deepEqual(errors, []);
});

t('Aktivitäten und Tagesplan: Navigation ab aktuellem Standort, auch ohne Koordinaten', async () => {
    await open();
    await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
    const r = await page.evaluate(() => {
        const withGeo = { id: 1, title: 'Senso-ji', topPlace: 'Tokio', lat: 35.7148, lng: 139.7967 };
        const noGeo = { id: 2, title: 'Ichiran Ramen', titleDe: 'Ichiran Nudeln', topPlace: 'Tokio', lat: null, lng: null };
        return [actNavUrl(withGeo), actNavUrl(noGeo)];
    });
    assert.equal(r[0], 'https://www.google.com/maps/dir/?api=1&destination=35.7148,139.7967');
    assert.equal(r[1], 'https://www.google.com/maps/dir/?api=1&destination=Ichiran%20Ramen%2C%20Tokio');
    await go('view-activities', 'Aktivitäten');
    const btn = page.locator('#activitiesList .btn-nav-act').first();
    if (await btn.count()) {
        await btn.click();
        const u = await page.evaluate(() => window.__opened.pop());
        assert.match(u, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
        assert.ok(!/origin=|travelmode=/.test(u));
    }
    assert.deepEqual(errors, []);
});

t('ToDos: Erinnerung weniger als 24 Stunden vor Fälligkeit, nur solange offen', async () => {
    await open();
    const r = await page.evaluate(() => {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const now = new Date(), in3d = new Date(Date.now() + 3 * 864e5), in2h = new Date(Date.now() + 2 * 3600e3);
        const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        localStorage.setItem('tp_todos', JSON.stringify({ v: 1, items: [
            { id: 'soon', t: 'Visum prüfen', due: iso(in2h), dueTime: hm(in2h), done: false },
            { id: 'later', t: 'JR Pass', due: iso(in3d), done: false },
            { id: 'nodue', t: 'Ohne Datum', due: '', done: false },
            { id: 'done', t: 'Erledigt', due: iso(in2h), dueTime: hm(in2h), done: true }] }));
        const evs = window.reminders.buildEvents().filter(e => e.kind === 'todo');
        const t = Date.now();
        return { keys: evs.map(e => e.key.split('|')[1]), active: evs.filter(e => t >= e.notifyFrom && t <= e.notifyTo).map(e => e.text),
            laterFrom: evs.find(e => e.key.includes('later'))?.notifyFrom - t };
    });
    assert.deepEqual(r.keys.sort(), ['later', 'soon']);
    assert.equal(r.active.length, 1);
    assert.match(r.active[0], /^ToDo fällig (heute|morgen) um \d{2}:\d{2}: Visum prüfen$/);
    assert.ok(r.laterFrom > 24 * 3600e3, 'späteres ToDo erinnert erst später');
    // Banner auf der Startseite, Antippen öffnet die ToDos
    await page.evaluate(() => { switchView('view-home', 'Start'); window.reminders.render(); });
    const banner = page.locator('#homeReminder .rem-banner[data-todo]');
    assert.match(await banner.innerText(), /Visum prüfen/);
    await banner.locator('.rem-text').click();
    assert.ok(await page.locator('#view-todos.active').count());
    // Abhaken: Erinnerung verschwindet
    await page.click('input[aria-label="Visum prüfen abhaken"]');
    assert.equal(await page.evaluate(() => window.reminders.buildEvents().filter(e => e.kind === 'todo' && e.key.includes('soon')).length), 0);
    // Dialog: Uhrzeit nur mit Datum, Hinweis auf Erinnerung
    await page.click('[data-todo-edit] >> text=JR Pass');
    assert.equal(await page.locator('#todoRemHint').isVisible(), true);
    await page.fill('#todo-due', '');
    assert.equal(await page.locator('#todo-time').isDisabled(), true);
    assert.equal(await page.locator('#todoRemHint').isVisible(), false);
    assert.deepEqual(errors, []);
});

t('Einstellungen → Benachrichtigungen: Arten einzeln schaltbar, nirgends sonst', async () => {
    await open();
    await page.evaluate(() => {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const d = new Date(Date.now() + 2 * 3600e3);
        localStorage.setItem('tp_todos', JSON.stringify({ v: 1, items: [{ id: 'x', t: 'Visum', due: iso(d), dueTime: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, done: false }] }));
    });
    await go('view-settings', 'Einstellungen');
    const box = page.locator('#notifySettings');
    assert.equal(await box.locator('#rem-todo-on').isChecked(), true);
    assert.equal(await page.evaluate(() => window.reminders.buildEvents().some(e => e.kind === 'todo')), true);
    await box.locator('#rem-todo-on').uncheck();
    assert.equal(await page.evaluate(() => window.reminders.buildEvents().some(e => e.kind === 'todo')), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tp_reminders')).todoOn), false);
    // Vorabend aus: Uhrzeit gesperrt
    await box.locator('#rem-eve-on').uncheck();
    assert.equal(await box.locator('#rem-eve').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.reminders.buildEvents().some(e => e.kind === 'eve')), false);
    // Check-out-Zeit pro Station
    await box.locator('.rem-checkouts summary').click();
    await box.locator('.rem-place input').first().fill('10:30');
    await box.locator('.rem-place input').first().dispatchEvent('change');
    assert.equal(await page.evaluate(() => places[0].checkout), '10:30');
    // ToDo-Dialog verweist nur per Text, ohne eigenen Einstellungs-Knopf; kein Erinnerungs-Dialog mehr
    assert.equal(await page.locator('#todoRemSettings, #modal-reminders').count(), 0);
    assert.deepEqual(errors, []);
});

t('Flug: Abflughafen als eigenes Feld, in der Verbindung sichtbar', async () => {
    await open();
    await go('view-places', 'Stationen');
    const arrival = page.locator('#placesList .transit-leg--end >> nth=0');
    await arrival.locator('summary').click();
    await arrival.locator('.transit-edit').click();
    await page.waitForFunction(() => document.getElementById('modal-transit')?.open);
    assert.equal(await page.locator('label[for="transit-from"]').innerText(), 'Abflughafen');
    await page.fill('#transit-from', 'Frankfurt-Hahn (HHN)');
    await page.click('#transit-save');
    assert.equal(await page.evaluate(() => places[0].transit.from), 'Frankfurt-Hahn (HHN)');
    assert.match(await page.locator('#placesList .transit-leg--end >> nth=0').innerText(), /Frankfurt-Hahn \(HHN\)/);
    // Reines Kürzel wird lesbar angezeigt
    await page.evaluate(() => { places[0].transit.from = 'HND'; saveData(); });
    assert.match(await page.locator('#placesList .transit-leg--end >> nth=0').innerText(), /Tokyo Haneda \(HND\)/);
    // Leiser Lauf beim Start ergänzt nur den fehlenden Flughafen derselben Verbindung
    await page.evaluate(() => { places[0].transit = { train: 'LH 716', dep: '10:15', from: '', terminal: '', gate: '', seat: '', note: 'x' }; });
    await page.evaluate(() => window.bookingRead.applyTransit('arrival', 'Flugnummer LH716\nAbflug 11:00\nFrankfurt (FRA) - Tokio (HND)', null, true));
    const tr = await page.evaluate(() => places[0].transit);
    assert.equal(tr.from, 'Frankfurt am Main (FRA)'); assert.equal(tr.dep, '10:15'); assert.equal(tr.note, 'x');
    assert.deepEqual(errors, []);
});
