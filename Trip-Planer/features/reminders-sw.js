// ─── ERINNERUNGEN – Service-Worker-Teil (per importScripts in sw.js) ────────
// Periodic Background Sync (Chrome/Android, installierte PWA): Der Client legt den
// vorberechneten Zeitplan in IndexedDB ab (features/reminders.js); hier wird nur
// geprüft, ob ein Ereignis gerade fällig und noch nicht benachrichtigt ist.
(function () {
    const SYNC_TAG = 'trip-planer-reminders';
    const DB_NAME = 'jp26-reminders', DB_STORE = 'kv';
    const KEEP_MS = 45 * 864e5;

    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    function get(db, key) {
        return new Promise(res => {
            const q = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
            q.onsuccess = () => res(q.result); q.onerror = () => res(undefined);
        });
    }
    function put(db, key, val) {
        return new Promise(res => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(val, key);
            tx.oncomplete = () => res(true); tx.onerror = tx.onabort = () => res(false);
        });
    }
    const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
    const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';

    async function checkReminders() {
        let db;
        try { db = await idb(); } catch (e) { return; }
        try {
            const sched = await get(db, 'schedule');
            if (!isObj(sched) || !sched.on || !Array.isArray(sched.events)) return;
            if (self.Notification && Notification.permission !== 'granted') return;
            // App gerade sichtbar → dort übernimmt features/reminders.js (Banner + Benachrichtigung).
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            if (clients.some(c => c.visibilityState === 'visible')) return;
            const now = Date.now(), min = now - KEEP_MS;
            const sentRaw = await get(db, 'sent'), sent = {};
            if (isObj(sentRaw)) Object.keys(sentRaw).forEach(k => { const t = Number(sentRaw[k]); if (Number.isFinite(t) && t > min) sent[k] = t; });
            let changed = false;
            for (const ev of sched.events) {
                if (!isObj(ev)) continue;
                const key = text(ev.key, 200), body = text(ev.body, 240);
                if (!key || !body || sent[key] || !(now >= Number(ev.from) && now <= Number(ev.to))) continue;
                await self.registration.showNotification('Trip Planer – Erinnerung', {
                    body, tag: 'trip-planer-rem-' + key.slice(0, 60),
                    icon: './icons/icon-192-v2.png', badge: './icons/icon-192-v2.png', data: { url: './' }
                });
                sent[key] = now; changed = true;
            }
            if (changed) await put(db, 'sent', sent);
        } catch (e) { console.warn('SW Erinnerungen:', e); }
        finally { db.close(); }
    }

    self.addEventListener('periodicsync', e => {
        if (e.tag === SYNC_TAG) e.waitUntil(checkReminders());
    });
})();
