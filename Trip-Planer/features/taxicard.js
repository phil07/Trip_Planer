// ─── TAXI-KARTE („Zeig dem Taxifahrer“) ──────────────────────────────────
// Vollbild-Dialog mit Ziel (Unterkunft einer Station oder Aktivität) in der
// Landessprache, darunter klein das Original. Die vom Nutzer eingetragene/korrigierte
// Adresse wird im Stations- bzw. Aktivitätsobjekt gespeichert (taxiAddr + taxiFor,
// normalisiert in normPlace/normAct), damit sie offline und im Backup verfügbar ist.
// Automatische Übersetzung (translate.googleapis) nur als Vorschlag, im AI-Cache gecacht.
(function () {
    'use strict';
    const MAX_LEN = 300; // muss zu TAXI_MAX in app.js (normPlace/normAct) passen
    const PHRASE_DE = 'Bitte bringen Sie mich zu dieser Adresse.';
    const PHRASE_JA = 'この住所までお願いします。';
    const memCache = new Map();
    let cur = null;          // { kind: 'place'|'act', id, src, lat, lng }
    let wakeLock = null, seq = 0;

    // Zielsprache: Reiseland bestimmt die Sprache; ohne Reiseland Japanisch (Japan-Reise).
    const targetLang = () => (typeof tripCountry === 'string' && tripCountry && tripLangCode) ? tripLangCode : 'ja';
    const cacheKey = (lang, t) => 'tp_taxi_' + lang + '_' + hashText(t);

    function cachedTranslation(lang, text) {
        const k = cacheKey(lang, text);
        if (memCache.has(k)) return memCache.get(k);
        try { const c = localStorage.getItem(k); if (c) { memCache.set(k, c); return c; } } catch (e) {}
        return '';
    }
    // Gleiches Muster wie toGerman()/getActivePhrases() in app.js (translate.googleapis, gtx).
    async function translateTo(lang, text) {
        const t = String(text || '').trim().slice(0, MAX_LEN);
        if (!t) return '';
        const hit = cachedTranslation(lang, t);
        if (hit) return hit;
        if (navigator.onLine === false) return '';
        try {
            const res = await fetchWithTimeout(
                `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(t)}`, 6000);
            const d = await res.json();
            const out = (Array.isArray(d?.[0]) ? d[0] : []).map(x => Array.isArray(x) ? String(x[0] ?? '') : '').join('').trim().slice(0, MAX_LEN);
            if (!out) return '';
            memCache.set(cacheKey(lang, t), out);
            aiCacheSet(cacheKey(lang, t), out);
            return out;
        } catch (e) { return ''; }
    }

    function targetFor(kind, id) {
        if (kind === 'place') {
            const p = places.find(x => x.id === id);
            if (!p || !p.hotel) return null;
            return { kind, id, obj: p, title: String(p.hotel), src: `${p.hotel}, ${clean(p.name)}`,
                lat: p.hotelLat, lng: p.hotelLng, sub: `Unterkunft · ${clean(p.name)}` };
        }
        const a = acts.find(x => x.id === id);
        if (!a) return null;
        const where = a.locLabel || a.topPlace;
        return { kind, id, obj: a, title: String(a.title), src: where ? `${a.title}, ${where}` : String(a.title),
            lat: a.lat, lng: a.lng, sub: `Aktivität · ${a.topPlace}` };
    }

    // Aktuelle Station (gleiche Logik wie renderHome: erste Station, die noch nicht vorbei ist).
    function currentPlace() {
        if (!places.length) return null;
        const today = todayISO();
        let idx = computedData.findIndex(c => c && c.isoEnd > today);
        if (idx < 0 || idx >= places.length) idx = 0;
        return places[idx];
    }

    function ensureDialog() {
        let dlg = document.getElementById('modal-taxi');
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.id = 'modal-taxi';
        dlg.setAttribute('aria-labelledby', 'taxi-phrase-de');
        dlg.innerHTML = `
            <div class="taxi-top">
                <button type="button" class="taxi-close" aria-label="Taxi-Karte schließen">${ico('x', '✕')}</button>
            </div>
            <div class="taxi-card">
                <p class="taxi-phrase-local" id="taxi-phrase-local" lang="ja"></p>
                <p class="taxi-phrase-de" id="taxi-phrase-de">${esc(PHRASE_DE)}</p>
                <div class="taxi-dest" id="taxi-dest" lang="ja"></div>
                <div class="taxi-orig" id="taxi-orig"></div>
                <div class="taxi-status" id="taxi-status" role="status"></div>
            </div>
            <div class="taxi-tools">
                <p class="taxi-hint">${ico('sun', '☀️')}<span>Tipp: Bildschirmhelligkeit ganz hochdrehen.</span> <span id="taxi-wake"></span></p>
                <button type="button" class="btn taxi-maps">${ico('map-trifold')} In Google Maps öffnen</button>
                <details class="taxi-edit">
                    <summary>Adresse in Landessprache eintragen/korrigieren</summary>
                    <div class="form-group">
                        <label for="taxi-input">Adresse (wird gespeichert, auch offline verfügbar)</label>
                        <textarea id="taxi-input" rows="3" maxlength="${MAX_LEN}" lang="ja"></textarea>
                    </div>
                    <div class="taxi-edit-btns">
                        <button type="button" class="btn-icon taxi-save">${ico('check')} Speichern</button>
                        <button type="button" class="btn-icon taxi-use">${ico('translate')} Vorschlag übernehmen</button>
                        <button type="button" class="btn-icon taxi-clear">${ico('trash')} Entfernen</button>
                    </div>
                </details>
            </div>`;
        document.body.appendChild(dlg);
        dlg.querySelector('.taxi-close').addEventListener('click', () => dlg.close());
        dlg.querySelector('.taxi-maps').addEventListener('click', openMaps);
        dlg.querySelector('.taxi-save').addEventListener('click', () => save(document.getElementById('taxi-input').value));
        dlg.querySelector('.taxi-clear').addEventListener('click', () => save(''));
        dlg.querySelector('.taxi-use').addEventListener('click', () => {
            const s = dlg.dataset.suggestion || '';
            if (!s) { showToast('Kein Übersetzungsvorschlag verfügbar.'); return; }
            document.getElementById('taxi-input').value = s;
        });
        dlg.addEventListener('close', () => { cur = null; seq++; releaseWake(); });
        return dlg;
    }

    async function requestWake() {
        const el = document.getElementById('taxi-wake');
        if (!('wakeLock' in navigator)) { if (el) el.textContent = ''; return; }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            if (el) el.textContent = 'Bildschirm bleibt an.';
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch (e) { if (el) el.textContent = ''; }
    }
    function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
    // Wake Lock wird beim Verlassen der Seite automatisch freigegeben – bei Rückkehr neu anfordern.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && cur && !wakeLock) requestWake();
    });

    function render() {
        if (!cur) return;
        const t = targetFor(cur.kind, cur.id);
        if (!t) { document.getElementById('modal-taxi')?.close(); return; }
        cur = t;
        const dlg = ensureDialog(), lang = targetLang();
        const saved = String(t.obj.taxiAddr || '');
        const stale = saved && t.obj.taxiFor && t.obj.taxiFor !== t.src;
        const suggestion = cachedTranslation(lang, t.src);
        dlg.dataset.suggestion = suggestion;
        ['taxi-phrase-local', 'taxi-dest', 'taxi-input'].forEach(id => document.getElementById(id).setAttribute('lang', lang));
        const phrase = lang === 'ja' ? PHRASE_JA : (cachedTranslation(lang, PHRASE_DE) || '');
        const phEl = document.getElementById('taxi-phrase-local');
        phEl.textContent = phrase; phEl.hidden = !phrase;
        const main = saved || suggestion || t.title;
        const dest = document.getElementById('taxi-dest');
        dest.textContent = main;
        dest.classList.toggle('is-orig', !saved && !suggestion);
        document.getElementById('taxi-orig').textContent = `${t.src} · ${t.sub}`;
        const st = document.getElementById('taxi-status');
        st.textContent = stale ? `⚠️ Gespeicherte Adresse gehört zu „${t.obj.taxiFor}“ – bitte prüfen.`
            : saved ? 'Gespeicherte Adresse'
            : suggestion ? 'Automatisch übersetzt – Vorschlag, bitte ggf. korrigieren.'
            : navigator.onLine === false ? 'Offline – noch keine Übersetzung gespeichert.' : 'Übersetze…';
        const inp = document.getElementById('taxi-input');
        if (document.activeElement !== inp) { inp.value = saved; inp.placeholder = suggestion || 'z. B. 東京都新宿区…'; }
    }

    async function fetchMissing() {
        if (!cur) return;
        const my = ++seq, lang = targetLang(), src = cur.src;
        const jobs = [translateTo(lang, src)];
        if (lang !== 'ja') jobs.push(translateTo(lang, PHRASE_DE));
        await Promise.all(jobs);
        if (my !== seq || !cur) return;
        render();
        if (!cachedTranslation(lang, src) && !cur.obj.taxiAddr) {
            document.getElementById('taxi-status').textContent = navigator.onLine === false
                ? 'Offline – noch keine Übersetzung gespeichert.' : 'Übersetzung nicht verfügbar – Adresse gern selbst eintragen.';
        }
    }

    function save(val) {
        if (!cur) return;
        const v = String(val || '').trim().slice(0, MAX_LEN);
        const o = cur.obj;
        if (v) { o.taxiAddr = v; o.taxiFor = cur.src; } else { delete o.taxiAddr; delete o.taxiFor; }
        persist();
        haptic(10);
        showToast(v ? '✅ Adresse gespeichert' : 'Adresse entfernt');
        document.getElementById('taxi-input').blur();
        render();
    }

    function openMaps() {
        if (!cur) return;
        const q = (cur.lat != null && cur.lng != null && Number.isFinite(+cur.lat) && Number.isFinite(+cur.lng) && (cur.lat || cur.lng))
            ? `${+cur.lat},${+cur.lng}` : (cur.obj.taxiAddr || `${cur.src} ${tripCountry || ''}`.trim());
        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, '_blank', 'noopener');
    }

    function open(kind, id) {
        const t = targetFor(kind, Number(id));
        if (!t) { showToast(kind === 'place' ? 'Noch keine Unterkunft eingetragen.' : 'Aktivität nicht gefunden.'); return; }
        cur = t;
        const dlg = ensureDialog();
        dlg.querySelector('.taxi-edit').open = false;
        document.getElementById('taxi-input').value = '';
        render();
        if (!dlg.open) dlg.showModal();
        haptic(10);
        requestWake();
        fetchMissing();
    }

    // Startseiten-Hook: „Zum Hotel“-Schnellzugriff in der Karte der aktuellen Station.
    function homeHook(container) {
        if (!container) return;
        container.querySelector('.taxi-home')?.remove();
        const p = currentPlace();
        if (!p || !p.hotel) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-icon taxi-home';
        b.innerHTML = `${ico('taxi', '🚕')} Zum Hotel <span class="taxi-home-sub">${esc(p.hotel)}</span>`;
        b.setAttribute('aria-label', `Taxi-Karte zum Hotel ${p.hotel} öffnen`);
        b.addEventListener('click', () => open('place', p.id));
        container.appendChild(b);
    }

    window.taxiCard = {
        openPlace: id => open('place', id),
        openAct: id => open('act', id),
        homeHook,
    };
    // app.js rendert die Startseite schon vor dem Laden dieses Skripts – einmal nachziehen.
    homeHook(document.getElementById('homeNext'));
})();
