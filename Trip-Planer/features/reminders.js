// ─── ERINNERUNGEN VOR STATIONSWECHSELN ──────────────────────────────────────
// Rein lokal, ohne Server: Beim Öffnen/Wieder-Sichtbarwerden der App wird geprüft,
// ob heute ein Check-out ansteht oder morgen ein Stationswechsel ist. Dann erscheint
// ein Banner auf der Startseite und – falls erlaubt – eine Benachrichtigung
// (max. einmal pro Ereignis, Merker in localStorage + IndexedDB).
// Zusätzlich: Periodic Background Sync (nur wo unterstützt, praktisch Chrome/Android
// mit installierter PWA) – der Service Worker (features/reminders-sw.js) liest dafür
// den vorberechneten Zeitplan aus IndexedDB, weil er keinen Zugriff auf localStorage hat.
// iOS/Safari kennt kein Periodic Sync: dort gibt es Hintergrund-Erinnerungen nur per
// echtem Server-Push (worker/ – noch nicht deployt, s. docs/push-setup.md).
(function () {
    'use strict';
    const SETTINGS_KEY = 'tp_reminders';       // { on, eve } – Geräte-Einstellung, nicht im Backup
    const STATE_KEY = 'tp_reminders_state';    // { sent: {key: ts}, hidden: {key: ts} }
    const SYNC_TAG = 'trip-planer-reminders';
    const DB_NAME = 'jp26-reminders', DB_STORE = 'kv';
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const KEEP_MS = 45 * 864e5;                  // Merker nach 45 Tagen aufräumen
    const DAY_FROM = '06:00', DAY_FALLBACK_END = '12:00';

    const validHHMM = v => typeof v === 'string' && HHMM.test(v);
    function loadSettings() {
        const s = readJsonKey(SETTINGS_KEY, isObj, {});
        return { on: s.on !== false, eve: validHHMM(s.eve) ? s.eve : '19:00' };
    }
    function cleanMap(m) {
        const out = {}, min = Date.now() - KEEP_MS;
        if (isObj(m)) Object.keys(m).slice(0, 500).forEach(k => { const t = Number(m[k]); if (k.length <= 200 && Number.isFinite(t) && t > min) out[k] = t; });
        return out;
    }
    function loadState() {
        const s = readJsonKey(STATE_KEY, isObj, {});
        return { sent: cleanMap(s.sent), hidden: cleanMap(s.hidden) };
    }
    const saveState = st => writeJson(STATE_KEY, st);

    // Lokale Uhrzeit "HH:MM" an einem ISO-Tag → Zeitstempel (ms)
    function at(iso, hhmm) {
        const d = parseISODate(iso), [h, m] = hhmm.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        return d.getTime();
    }
    function shiftDay(iso, n) { const d = parseISODate(iso); d.setDate(d.getDate() + n); return localISO(d); }
    const endOfDay = iso => at(iso, '23:59') + 59999;

    // Alle Erinnerungs-Ereignisse der Reise. Pro Ereignis:
    //   key  – stabil (Art + Datum + Station), damit jedes Ereignis nur einmal benachrichtigt
    //   text – Banner-/Benachrichtigungstext
    //   showFrom/showTo – Zeitraum für das Banner
    //   notifyFrom/notifyTo – Zeitraum für die Benachrichtigung
    function buildEvents(settings) {
        const evs = [];
        if (!Array.isArray(places) || !places.length || !computedData.length) return evs;
        const coText = co => validHHMM(co) ? ` – Check-out bis ${co}` : ' – Check-out nicht vergessen';
        const first = computedData[0];
        if (first) {
            const day = shiftDay(first.isoStart, -1), name = clean(String(places[0].name));
            evs.push({ key: `start|${first.isoStart}|${name}`, kind: 'eve', icon: 'airplane-takeoff',
                text: `Morgen geht's los nach ${name}`,
                showFrom: at(day, '00:00'), showTo: endOfDay(day), notifyFrom: at(day, settings.eve), notifyTo: endOfDay(day) });
        }
        places.forEach((p, i) => {
            const cd = computedData[i];
            if (!cd || clampNights(p.nights) < 1) return;   // Durchreise ohne Übernachtung → kein Check-out
            const name = clean(String(p.name));
            const next = places.slice(i + 1).find(x => String(x.name ?? '').trim());
            const nextName = next ? clean(String(next.name)) : '';
            const co = validHHMM(p.checkout) ? p.checkout : '';
            const eveDay = shiftDay(cd.isoEnd, -1), dayEnd = at(cd.isoEnd, co || DAY_FALLBACK_END);
            const where = nextName ? `nach ${nextName}` : `nach Hause – Rückreise ab ${name}`;
            evs.push({ key: `eve|${cd.isoEnd}|${name}`, kind: 'eve', icon: 'suitcase-rolling',
                text: `Morgen geht's ${where}${coText(co)}`,
                showFrom: at(eveDay, '00:00'), showTo: endOfDay(eveDay), notifyFrom: at(eveDay, settings.eve), notifyTo: endOfDay(eveDay) });
            evs.push({ key: `day|${cd.isoEnd}|${name}`, kind: 'day', icon: 'door-open',
                text: `Heute geht's ${where}${coText(co)}`,
                showFrom: at(cd.isoEnd, '00:00'), showTo: dayEnd,
                notifyFrom: Math.min(at(cd.isoEnd, DAY_FROM), dayEnd - 30 * 60000), notifyTo: dayEnd });
        });
        return evs;
    }

    // ─── IndexedDB (gemeinsam mit dem Service Worker) ──────────────────────
    function idb() {
        return new Promise((res, rej) => {
            if (!('indexedDB' in self)) return rej(new Error('no idb'));
            const r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function idbGet(key) {
        const db = await idb();
        return new Promise(res => {
            const q = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
            q.onsuccess = () => { res(q.result); db.close(); };
            q.onerror = () => { res(undefined); db.close(); };
        });
    }
    async function idbPut(key, val) {
        const db = await idb();
        return new Promise(res => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(val, key);
            tx.oncomplete = () => { res(true); db.close(); };
            tx.onerror = tx.onabort = () => { res(false); db.close(); };
        });
    }
    // Merker des Service Workers (im Hintergrund schon benachrichtigt) übernehmen
    async function mergeSwSent(st) {
        try {
            const swSent = cleanMap(await idbGet('sent'));
            Object.assign(st.sent, swSent);
        } catch (e) { /* kein IDB (z. B. privates Fenster) → nur localStorage */ }
        return st;
    }

    // Zeitplan für den Service Worker ablegen (nur Ereignisse, die noch in der Zukunft liegen)
    let syncT = null;
    function scheduleSync() {
        clearTimeout(syncT);
        syncT = setTimeout(async () => {
            const s = loadSettings(), now = Date.now();
            const events = s.on ? buildEvents(s).filter(e => e.notifyTo > now).slice(0, 200)
                .map(e => ({ key: e.key, body: e.text, from: e.notifyFrom, to: e.notifyTo })) : [];
            try { await idbPut('schedule', { on: s.on, events, updated: now }); } catch (e) {}
        }, 300);
    }

    // ─── Benachrichtigung ──────────────────────────────────────────────────
    const notifySupported = () => 'Notification' in window;
    const notifyGranted = () => notifySupported() && Notification.permission === 'granted';
    async function showNote(ev) {
        const title = 'Trip Planer – Erinnerung';
        const opts = { body: ev.text, tag: 'trip-planer-rem-' + ev.key.slice(0, 60), icon: './icons/icon-192-v2.png',
            badge: './icons/icon-192-v2.png', data: { url: './' } };
        try {
            const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
            if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
        } catch (e) { console.warn('Erinnerung (SW) fehlgeschlagen:', e); }
        // Ohne Service Worker (z. B. Desktop-Browser-Tab): klassische Notification;
        // Android-Chrome wirft hier einen TypeError – dann bleibt es beim Banner.
        try { new Notification(title, opts); return true; } catch (e) { return false; }
    }

    let checking = false;
    async function check() {
        render();
        const s = loadSettings();
        if (!s.on || !notifyGranted() || checking) return;
        checking = true;
        try {
            const now = Date.now();
            const due = buildEvents(s).filter(e => now >= e.notifyFrom && now <= e.notifyTo);
            if (!due.length) return;
            const st = await mergeSwSent(loadState());
            let changed = false;
            for (const ev of due) {
                if (st.sent[ev.key]) continue;
                if (await showNote(ev)) { st.sent[ev.key] = now; changed = true; }
            }
            if (changed) {
                saveState(st);
                try { const db = cleanMap(await idbGet('sent')); Object.assign(db, st.sent); await idbPut('sent', db); } catch (e) {}
            }
        } finally { checking = false; }
    }

    // ─── Periodic Background Sync (Feature-Detect) ─────────────────────────
    // Status: 'active' | 'unsupported' | 'denied' (nicht installiert / nicht erlaubt) | 'off'
    async function updatePeriodicSync() {
        const s = loadSettings();
        try {
            if (!('serviceWorker' in navigator)) return 'unsupported';
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg || !('periodicSync' in reg)) return 'unsupported';
            if (!s.on || !notifyGranted()) { await reg.periodicSync.unregister(SYNC_TAG).catch(() => {}); return 'off'; }
            let state = 'granted';
            try { state = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch (e) {}
            if (state !== 'granted') return 'denied';
            // Browser entscheidet selbst, wie oft er tatsächlich weckt (oft nur 1–2× täglich).
            await reg.periodicSync.register(SYNC_TAG, { minInterval: 60 * 60 * 1000 });
            return 'active';
        } catch (e) { console.warn('periodicSync (Erinnerungen):', e); return 'denied'; }
    }

    // ─── Banner auf der Startseite ─────────────────────────────────────────
    function render() {
        scheduleSync();
        const intro = document.querySelector('#view-home .home-intro');
        if (!intro) return;
        let box = document.getElementById('homeReminder');
        const s = loadSettings(), st = loadState(), now = Date.now();
        const active = s.on ? buildEvents(s).filter(e => now >= e.showFrom && now <= e.showTo && !st.hidden[e.key]) : [];
        if (!active.length) { box?.remove(); return; }
        if (!box) {
            box = document.createElement('div');
            box.id = 'homeReminder'; box.className = 'rem-banner-list';
            box.setAttribute('role', 'status');
            intro.appendChild(box);
        }
        box.innerHTML = active.map(e => `<div class="rem-banner rem-banner--${e.kind === 'day' ? 'day' : 'eve'}">
            <span class="rem-ico">${ico(e.icon, e.kind === 'day' ? '🧳' : '🔔')}</span>
            <span class="rem-text">${esc(e.text)}</span>
            <button type="button" class="rem-close" data-key="${esc(e.key)}" aria-label="Erinnerung ausblenden">${ico('x', '✕')}</button>
        </div>`).join('');
        box.querySelectorAll('.rem-close').forEach(b => b.addEventListener('click', () => {
            const st2 = loadState(); st2.hidden[b.dataset.key] = Date.now(); saveState(st2); haptic(); render();
        }));
    }

    // ─── Einstellungs-Dialog ───────────────────────────────────────────────
    function permText() {
        if (!notifySupported()) return 'Benachrichtigungen werden in diesem Browser nicht unterstützt – Erinnerung nur als Banner in der App.';
        if (Notification.permission === 'granted') return 'Benachrichtigungen sind erlaubt.';
        if (Notification.permission === 'denied') return 'Benachrichtigungen sind blockiert – in den Browser-/System-Einstellungen erlauben.';
        return 'Benachrichtigungen sind noch nicht erlaubt.';
    }
    const BG_TEXT = {
        active: 'Hintergrund-Prüfung aktiv – der Browser weckt die App gelegentlich (Zeitpunkt bestimmt das System).',
        unsupported: 'Keine Hintergrund-Prüfung auf diesem Gerät – erinnert wird beim Öffnen der App.',
        denied: 'Hintergrund-Prüfung nicht verfügbar (App installieren, Chrome/Android) – erinnert wird beim Öffnen der App.',
        off: 'Hintergrund-Prüfung startet, sobald Erinnerungen an und Benachrichtigungen erlaubt sind.'
    };
    function ensureDialog() {
        let dlg = document.getElementById('modal-reminders');
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.id = 'modal-reminders';
        dlg.setAttribute('aria-labelledby', 'modal-reminders-title');
        dlg.innerHTML = `<h3 id="modal-reminders-title">Erinnerungen</h3>
            <div class="dialog-body">
                <label class="rem-switch"><input type="checkbox" id="rem-on"><span>Vor Stationswechseln erinnern</span></label>
                <div class="form-group"><label for="rem-eve">Vorabend-Erinnerung um</label><input type="time" id="rem-eve" step="60"></div>
                <div class="rem-perm">
                    <p class="rem-hint" id="rem-perm-text"></p>
                    <button type="button" class="btn btn-secondary rem-perm-btn" id="rem-perm-btn">${ico('bell-ringing', '🔔')} Benachrichtigungen erlauben</button>
                    <p class="rem-hint" id="rem-bg-text"></p>
                </div>
                <div class="rem-sub">Check-out-Zeit pro Station</div>
                <div id="rem-places"></div>
            </div>
            <div class="dialog-actions">
                <button type="button" class="btn" id="rem-save">Speichern</button>
                <button type="button" class="btn btn-secondary" id="rem-cancel">Abbrechen</button>
            </div>`;
        document.body.appendChild(dlg);
        dlg.querySelector('#rem-cancel').addEventListener('click', () => dlg.close());
        dlg.querySelector('#rem-save').addEventListener('click', saveDialog);
        // Erlaubnis ausschließlich auf Knopfdruck anfragen
        dlg.querySelector('#rem-perm-btn').addEventListener('click', async () => {
            if (!notifySupported()) return;
            try { await Notification.requestPermission(); } catch (e) {}
            await syncPermUi();
            if (notifyGranted()) { showToast('🔔 Erinnerungen per Benachrichtigung aktiv'); check(); }
            else if (Notification.permission === 'denied') showToast('Benachrichtigungen blockiert – in den Einstellungen erlauben');
        });
        return dlg;
    }
    async function syncPermUi() {
        const dlg = document.getElementById('modal-reminders');
        if (!dlg) return;
        dlg.querySelector('#rem-perm-text').textContent = permText();
        dlg.querySelector('#rem-perm-btn').hidden = !notifySupported() || Notification.permission !== 'default';
        const bg = dlg.querySelector('#rem-bg-text');
        bg.textContent = BG_TEXT[await updatePeriodicSync()] || '';
    }
    function openDialog() {
        const dlg = ensureDialog(), s = loadSettings();
        dlg.querySelector('#rem-on').checked = s.on;
        dlg.querySelector('#rem-eve').value = s.eve;
        const list = dlg.querySelector('#rem-places');
        const rows = places.map((p, i) => ({ p, i, cd: computedData[i] })).filter(r => r.cd && clampNights(r.p.nights) >= 1);
        list.innerHTML = rows.length ? rows.map(({ p, i, cd }) => `<div class="form-group rem-place">
                <label for="rem-co-${i}">${esc(clean(String(p.name)))} <span class="rem-date">· Check-out ${esc(fmtDate(cd.isoEnd))}</span></label>
                <input type="time" id="rem-co-${i}" data-id="${esc(String(p.id))}" step="60" value="${validHHMM(p.checkout) ? p.checkout : ''}">
            </div>`).join('')
            : '<p class="rem-hint">Noch keine Stationen mit Übernachtung.</p>';
        dlg.showModal();
        syncPermUi();
    }
    function saveDialog() {
        const dlg = document.getElementById('modal-reminders');
        const eve = dlg.querySelector('#rem-eve').value.trim();
        if (!validHHMM(eve)) { showToast('⚠️ Uhrzeit bitte als HH:MM angeben (z. B. 19:00)'); return; }
        const inputs = [...dlg.querySelectorAll('#rem-places input[type="time"]')];
        const bad = inputs.find(inp => inp.value.trim() && !validHHMM(inp.value.trim()));
        if (bad) { showToast('⚠️ Check-out-Zeit bitte als HH:MM angeben (z. B. 10:00)'); bad.focus(); return; }
        writeJson(SETTINGS_KEY, { on: dlg.querySelector('#rem-on').checked, eve });
        let changed = false;
        inputs.forEach(inp => {
            const p = places.find(x => String(x.id) === inp.dataset.id);
            const v = inp.value.trim();
            if (p && (p.checkout || '') !== v) { p.checkout = v; changed = true; }
        });
        if (changed) saveData(); else render();
        dlg.close();
        showToast('✅ Erinnerungen gespeichert');
        updatePeriodicSync();
        check();
    }

    // Einstieg im Reise-Daten-Dialog
    function injectSettingsEntry() {
        const body = document.querySelector('#modal-settings .dialog-body');
        if (!body || document.getElementById('btnReminders')) return;
        const b = document.createElement('button');
        b.type = 'button'; b.id = 'btnReminders'; b.className = 'btn btn-secondary rem-entry';
        b.innerHTML = `${ico('bell', '🔔')} Erinnerungen & Check-out-Zeiten`;
        b.addEventListener('click', openDialog); // öffnet über dem Reise-Daten-Dialog, dessen Eingaben bleiben erhalten
        body.appendChild(b);
    }

    window.reminders = { render, check, open: openDialog, buildEvents: () => buildEvents(loadSettings()) };

    document.addEventListener('DOMContentLoaded', () => {
        injectSettingsEntry();
        check();
        updatePeriodicSync();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    // Läuft die App sichtbar über die Vorabend-Uhrzeit hinweg, trotzdem erinnern.
    setInterval(() => { if (document.visibilityState === 'visible') check(); }, 5 * 60 * 1000);
})();
