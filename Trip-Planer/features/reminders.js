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
    const SETTINGS_KEY = 'tp_reminders';       // { eveOn, eve, dayOn, todoOn } – Geräte-Einstellung, nicht im Backup
    const STATE_KEY = 'tp_reminders_state';    // { sent: {key: ts}, hidden: {key: ts} }
    const SYNC_TAG = 'trip-planer-reminders';
    const DB_NAME = 'jp26-reminders', DB_STORE = 'kv';
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const KEEP_MS = 45 * 864e5;                  // Merker nach 45 Tagen aufräumen
    const DAY_FROM = '06:00', DAY_FALLBACK_END = '11:00'; // Check-out ohne eigene Angabe: 11 Uhr (wie in app.js)

    const validHHMM = v => typeof v === 'string' && HHMM.test(v);
    // Je Art ein Schalter. Ältere Einstellung { on: false } schaltet alle aus.
    function loadSettings() {
        const s = readJsonKey(SETTINGS_KEY, isObj, {});
        const def = s.on !== false;
        const flag = k => typeof s[k] === 'boolean' ? s[k] : def;
        const o = { eveOn: flag('eveOn'), dayOn: flag('dayOn'), todoOn: flag('todoOn'), eve: validHHMM(s.eve) ? s.eve : '19:00' };
        o.on = o.eveOn || o.dayOn || o.todoOn;
        return o;
    }
    function saveSettings(o) { writeJson(SETTINGS_KEY, { eveOn: !!o.eveOn, dayOn: !!o.dayOn, todoOn: !!o.todoOn, eve: o.eve }); }
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
    // ToDos mit Fälligkeit: Erinnerung, sobald sie weniger als 24 Stunden entfernt ist (solange offen).
    // Ohne Uhrzeit gilt das Ende des Tages. Fällt der Beginn in die Nacht (22–7 Uhr), wird um 7 Uhr erinnert.
    function todoEvents() {
        const out = [];
        const items = window.todos?.load?.() || [];
        const today = localISO(new Date()), tomorrow = shiftDay(today, 1);
        for (const t of items) {
            if (t.done || !t.due) continue;
            const deadline = validHHMM(t.dueTime) ? at(t.due, t.dueTime) : endOfDay(t.due);
            let from = deadline - 864e5;
            const fd = new Date(from), h = fd.getHours();
            if (h >= 22 || h < 7) {
                const seven = new Date(fd); if (h >= 22) seven.setDate(seven.getDate() + 1); seven.setHours(7, 0, 0, 0);
                if (seven.getTime() < deadline) from = seven.getTime();
            }
            const when = t.due === today ? 'heute' : t.due === tomorrow ? 'morgen' : fmtDate(t.due);
            out.push({ key: `todo|${t.id}|${t.due}|${t.dueTime || ''}`, kind: 'todo', icon: 'check-square',
                text: `ToDo fällig ${when}${validHHMM(t.dueTime) ? ` um ${t.dueTime}` : ''}: ${t.t}`,
                showFrom: from, showTo: deadline, notifyFrom: from, notifyTo: deadline });
        }
        return out;
    }
    // Nur die eingeschalteten Arten (Vorabend, Abreisetag, ToDos)
    function buildEvents(settings) {
        return buildAllEvents(settings).filter(e => e.kind === 'todo' ? settings.todoOn : e.kind === 'day' ? settings.dayOn : settings.eveOn);
    }
    function buildAllEvents(settings) {
        const evs = todoEvents();
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
    // In der Android-App: Erinnerungen als lokale Benachrichtigungen fest einplanen, damit sie auch
    // kommen, wenn die App geschlossen ist. Vorherige Einträge werden vorher gelöscht (IDs 1–60).
    const NATIVE = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const NATIVE_MAX = 60;
    let nativeT = null;
    function scheduleNative() {
        clearTimeout(nativeT);
        nativeT = setTimeout(async () => {
            const s = loadSettings(), now = Date.now(), st = loadState();
            // Schon ausgelöste Erinnerungen (geplanter Zeitpunkt liegt in der Vergangenheit) nicht neu planen –
            // sonst käme bei jedem Öffnen der App dieselbe Benachrichtigung erneut.
            const events = s.on ? buildEvents(s).filter(e => e.notifyTo > now && !(st.sent[e.key] && st.sent[e.key] <= now)).slice(0, NATIVE_MAX) : [];
            try {
                const ids = Array.from({ length: NATIVE_MAX }, (_, i) => ({ id: i + 1 }));
                await window.Capacitor.nativePromise('LocalNotifications', 'cancel', { notifications: ids });
                const notifications = events.map((e, i) => ({
                    id: i + 1, title: 'Trip Planer – Erinnerung', body: e.text,
                    schedule: { at: new Date(Math.max(e.notifyFrom, now + 5000)).toISOString() }
                }));
                if (notifications.length) await window.Capacitor.nativePromise('LocalNotifications', 'schedule', { notifications });
                events.forEach((e, i) => { st.sent[e.key] = new Date(notifications[i].schedule.at).getTime(); });
                if (events.length) saveState(st);
            } catch (e) { console.warn('Erinnerungen (App):', e); }
        }, 300);
    }
    let syncT = null;
    function scheduleSync() {
        if (NATIVE()) return scheduleNative();
        clearTimeout(syncT);
        syncT = setTimeout(async () => {
            const s = loadSettings(), now = Date.now();
            const events = s.on ? buildEvents(s).filter(e => e.notifyTo > now).slice(0, 200)
                .map(e => ({ key: e.key, body: e.text, from: e.notifyFrom, to: e.notifyTo })) : [];
            try { await idbPut('schedule', { on: s.on, events, updated: now }); } catch (e) {}
        }, 300);
    }

    // ─── Benachrichtigung ──────────────────────────────────────────────────
    const notifySupported = () => NATIVE() || 'Notification' in window;
    const notifyGranted = () => NATIVE() || (notifySupported() && Notification.permission === 'granted');
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
        if (NATIVE()) return; // in der App übernimmt der geplante Alarm (scheduleNative)
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
        box.innerHTML = active.map(e => `<div class="rem-banner rem-banner--${e.kind === 'day' || e.kind === 'todo' ? 'day' : 'eve'}"${e.kind === 'todo' ? ' data-todo="1"' : ''}>
            <span class="rem-ico">${ico(e.icon, e.kind === 'todo' ? '☑️' : e.kind === 'day' ? '🧳' : '🔔')}</span>
            <span class="rem-text">${esc(e.text)}</span>
            <button type="button" class="rem-close" data-key="${esc(e.key)}" aria-label="Erinnerung ausblenden">${ico('x', '✕')}</button>
        </div>`).join('');
        // ToDo-Erinnerung antippen: ToDos öffnen
        box.querySelectorAll('.rem-banner[data-todo] .rem-text').forEach(t => {
            t.setAttribute('role', 'link'); t.tabIndex = 0; t.style.cursor = 'pointer';
            const go = () => switchView('view-todos', 'ToDos');
            t.addEventListener('click', go);
            t.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        });
        box.querySelectorAll('.rem-close').forEach(b => b.addEventListener('click', () => {
            const st2 = loadState(); st2.hidden[b.dataset.key] = Date.now(); saveState(st2); haptic(); render();
        }));
    }

    // ─── Einstellungen (nur unter Einstellungen → Benachrichtigungen) ──────
    function permText() {
        if (NATIVE()) return 'Benachrichtigungen kommen als App-Mitteilung, auch wenn die App geschlossen ist.';
        if (!notifySupported()) return 'Benachrichtigungen werden in diesem Browser nicht unterstützt – Erinnerung nur als Banner auf der Startseite.';
        if (Notification.permission === 'granted') return 'Benachrichtigungen sind erlaubt.';
        if (Notification.permission === 'denied') return 'Benachrichtigungen sind blockiert – in den Browser- bzw. Systemeinstellungen erlauben.';
        return 'Benachrichtigungen sind noch nicht erlaubt – ohne Erlaubnis erscheinen Erinnerungen nur als Banner auf der Startseite.';
    }
    const BG_TEXT = {
        active: 'Hintergrund-Prüfung aktiv – der Browser weckt die App gelegentlich (Zeitpunkt bestimmt das System).',
        unsupported: 'Keine Hintergrund-Prüfung auf diesem Gerät – erinnert wird beim Öffnen der App.',
        denied: 'Hintergrund-Prüfung nicht verfügbar (App installieren, Chrome/Android) – erinnert wird beim Öffnen der App.',
        off: ''
    };
    function renderSettings() {
        const box = document.getElementById('notifySettings');
        if (!box) return;
        const s = loadSettings();
        const rows = (typeof places !== 'undefined' ? places : []).map((p, i) => ({ p, i, cd: computedData[i] })).filter(r => r.cd && clampNights(r.p.nights) >= 1);
        const sw = (id, on, title, sub) => `<label class="rem-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span>${title}<small>${sub}</small></span></label>`;
        box.innerHTML = `
            <p class="settings-hint" id="rem-perm-text"></p>
            <button type="button" class="btn-icon rem-perm-btn" id="rem-perm-btn" hidden>${ico('bell-ringing', '🔔')} Benachrichtigungen erlauben</button>
            ${sw('rem-eve-on', s.eveOn, 'Vorabend eines Stationswechsels', 'Auch am Abend vor Reisebeginn')}
            <div class="form-group rem-eve-time"><label for="rem-eve">Uhrzeit am Vorabend</label><input type="time" id="rem-eve" step="60" value="${esc(s.eve)}" ${s.eveOn ? '' : 'disabled'}></div>
            ${sw('rem-day-on', s.dayOn, 'Check-out am Abreisetag', 'Morgens, spätestens 30 Minuten vor dem Check-out')}
            ${sw('rem-todo-on', s.todoOn, 'Fällige ToDos', 'Wenn die Fälligkeit weniger als 24 Stunden entfernt ist')}
            <p class="settings-hint" id="rem-bg-text"></p>
            <details class="rem-checkouts"${rows.length ? '' : ' hidden'}>
                <summary>${ico('caret-down', '▾')}<span>Check-out-Zeiten pro Station</span></summary>
                <p class="settings-hint">Ohne Angabe gilt 11:00. Ab dem Check-out zeigt die App dich am Abreisetag als unterwegs.</p>
                ${rows.map(({ p, i, cd }) => `<div class="form-group rem-place">
                    <label for="rem-co-${i}">${esc(clean(String(p.name)))} <span class="rem-date">· ${esc(fmtDate(cd.isoEnd))}</span></label>
                    <input type="time" id="rem-co-${i}" data-id="${esc(String(p.id))}" step="60" value="${validHHMM(p.checkout) ? p.checkout : ''}" placeholder="11:00">
                </div>`).join('')}
            </details>`;
        const save = () => {
            const cur = loadSettings();
            const eve = box.querySelector('#rem-eve').value.trim();
            const next = { eveOn: box.querySelector('#rem-eve-on').checked, dayOn: box.querySelector('#rem-day-on').checked,
                todoOn: box.querySelector('#rem-todo-on').checked, eve: validHHMM(eve) ? eve : cur.eve };
            box.querySelector('#rem-eve').disabled = !next.eveOn;
            saveSettings(next);
            render(); updatePeriodicSync().then(syncPermUi); check();
        };
        box.querySelectorAll('#rem-eve-on, #rem-day-on, #rem-todo-on').forEach(i => i.addEventListener('change', () => { haptic(); save(); }));
        box.querySelector('#rem-eve').addEventListener('change', save);
        box.querySelectorAll('.rem-place input').forEach(inp => inp.addEventListener('change', () => {
            const v = inp.value.trim();
            if (v && !validHHMM(v)) { showToast('Check-out-Zeit bitte als HH:MM angeben (z. B. 10:00)'); return; }
            const p = places.find(x => String(x.id) === inp.dataset.id);
            if (p && (p.checkout || '') !== v) { p.checkout = v; saveData(); }
        }));
        // Erlaubnis ausschließlich auf Knopfdruck anfragen
        box.querySelector('#rem-perm-btn').addEventListener('click', async () => {
            if (!notifySupported()) return;
            try { await Notification.requestPermission(); } catch (e) {}
            await syncPermUi();
            if (notifyGranted()) { showToast('Erinnerungen per Benachrichtigung aktiv'); check(); }
            else if (Notification.permission === 'denied') showToast('Benachrichtigungen blockiert – in den Einstellungen erlauben');
        });
        syncPermUi();
    }
    async function syncPermUi() {
        const box = document.getElementById('notifySettings');
        if (!box || !box.querySelector('#rem-perm-text')) return;
        box.querySelector('#rem-perm-text').textContent = permText();
        box.querySelector('#rem-perm-btn').hidden = NATIVE() || !notifySupported() || Notification.permission !== 'default';
        box.querySelector('#rem-bg-text').textContent = NATIVE() ? '' : (BG_TEXT[await updatePeriodicSync()] || '');
    }
    // Früher ein eigener Dialog – jetzt führt jeder Aufruf zu den Einstellungen.
    function openSettings() {
        if (typeof switchView === 'function') switchView('view-settings', 'Einstellungen');
        setTimeout(() => document.getElementById('set-notify')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    }

    window.reminders = { render, check, open: openSettings, renderSettings, buildEvents: () => buildEvents(loadSettings()) };

    document.addEventListener('DOMContentLoaded', () => {
        check();
        updatePeriodicSync();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    // Läuft die App sichtbar über die Vorabend-Uhrzeit hinweg, trotzdem erinnern.
    setInterval(() => { if (document.visibilityState === 'visible') check(); }, 5 * 60 * 1000);
})();
