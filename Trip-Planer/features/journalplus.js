// ─── TAGEBUCH+: Fotos, Ort, Karten-Ebene, Reise-Rückschau ──────────────────
// Ergänzt das Reisetagebuch aus app.js über Hooks (window.journalPlus.*):
// • Fotos werden verkleinert in IndexedDB („tp_journal_photos") gespeichert –
//   im Eintrag (localStorage/Backup) stehen nur die Foto-IDs.
// • Ort: aktueller Standort (nur auf Knopfdruck) oder Ort der gewählten Station.
// • Karte: zuschaltbare Ebene „Tagebuch" mit Markern der Einträge.
// • Reise-Rückschau: alle Einträge chronologisch, Tag für Tag, mit Fotos.
// Nutzt Helfer aus app.js: esc, showToast, haptic, fmtDateLong, todayISO, journal, places, …
(function () {
    'use strict';
    const DB_NAME = 'jp26_journal_photos', STORE = 'photos';
    const MAX_EDGE = 1600, THUMB_EDGE = 360, QUALITY = 0.8, MAX_PHOTOS = 20;
    const LAYER_KEY = 'tp_journal_layer'; // Geräte-Einstellung (kein Reisedatum → nicht im Backup)
    const ID_RE = /^p[a-z0-9]{6,40}$/;

    // ─── IndexedDB ────────────────────────────────────────────────────────
    let dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB nicht verfügbar')); return; }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    }
    async function tx(mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
            let result;
            const r = fn(st);
            if (r) r.onsuccess = () => { result = r.result; };
            t.oncomplete = () => resolve(result);
            t.onerror = t.onabort = () => reject(t.error);
        });
    }
    const putPhoto = rec => tx('readwrite', st => st.put(rec));
    const getPhoto = id => tx('readonly', st => st.get(id));
    const delPhotos = ids => ids.length ? tx('readwrite', st => { ids.forEach(id => st.delete(id)); }) : Promise.resolve();

    // Blob-URLs der Vorschaubilder einmal erzeugen und wiederverwenden.
    const thumbUrls = new Map();
    async function thumbUrl(id) {
        if (thumbUrls.has(id)) return thumbUrls.get(id);
        const rec = await getPhoto(id).catch(() => null);
        const blob = rec && (rec.thumb || rec.blob);
        if (!(blob instanceof Blob)) return null;
        const url = URL.createObjectURL(blob);
        thumbUrls.set(id, url);
        return url;
    }
    function forgetUrls(ids) { ids.forEach(id => { const u = thumbUrls.get(id); if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); } }); }
    function removePhotos(ids) {
        ids = ids.filter(id => ID_RE.test(id));
        forgetUrls(ids);
        return delPhotos(ids).catch(e => console.warn('Fotos löschen fehlgeschlagen:', e));
    }

    // ─── Bild verkleinern ─────────────────────────────────────────────────
    async function decode(file) {
        if (window.createImageBitmap) {
            try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* Fallback unten */ }
        }
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            return img;
        } finally { URL.revokeObjectURL(url); }
    }
    function toJpeg(src, edge) {
        const w0 = src.width, h0 = src.height, f = Math.min(1, edge / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * f)), h = Math.max(1, Math.round(h0 * f));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // transparente PNGs nicht schwarz werden lassen
        ctx.drawImage(src, 0, 0, w, h);
        return new Promise((res, rej) => c.toBlob(b => b ? res({ blob: b, w, h }) : rej(new Error('toBlob')), 'image/jpeg', QUALITY));
    }
    const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    async function storeFile(file) {
        const src = await decode(file);
        const full = await toJpeg(src, MAX_EDGE), thumb = await toJpeg(src, THUMB_EDGE);
        src.close?.();
        const id = newId();
        await putPhoto({ id, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h, created: Date.now() });
        return id;
    }

    // ─── Eintrags-Dialog (Fotos + Ort) ────────────────────────────────────
    // draft: Stand im offenen Dialog; added = in diesem Dialog neu gespeicherte Fotos
    // (bei Abbrechen wieder löschen), removed = entfernte vorhandene Fotos (erst beim Speichern löschen).
    let draft = null, committed = false;
    const $ = id => document.getElementById(id);

    function ensureModalUi() {
        if ($('jp-photos-group')) return;
        const textGroup = $('j-text')?.closest('.form-group');
        if (!textGroup) return;
        const loc = document.createElement('div');
        loc.className = 'form-group'; loc.id = 'jp-loc-group';
        loc.innerHTML = `<label>Position auf der Karte (optional)</label>
            <div class="jp-loc-btns">
                <button type="button" class="jp-chip" id="jp-loc-gps"><i class="ph-light ph-crosshair" data-fb="🎯" aria-hidden="true"></i> Aktueller Standort</button>
                <button type="button" class="jp-chip" id="jp-loc-station"><i class="ph-light ph-map-pin" data-fb="📍" aria-hidden="true"></i> Ort der Station</button>
            </div>
            <div class="jp-loc-status" id="jp-loc-status" aria-live="polite"></div>`;
        const ph = document.createElement('div');
        ph.className = 'form-group'; ph.id = 'jp-photos-group';
        ph.innerHTML = `<label>Fotos</label>
            <div class="jp-photo-edit" id="jp-photo-edit"></div>
            <label class="jp-chip jp-add-photo" for="jp-file"><i class="ph-light ph-camera" data-fb="📷" aria-hidden="true"></i> Fotos hinzufügen</label>
            <input type="file" id="jp-file" accept="image/*" multiple hidden>
            <div class="jp-hint">Fotos bleiben nur auf diesem Gerät und sind <b>nicht</b> im JSON-Backup enthalten.</div>`;
        textGroup.after(loc, ph);
        $('jp-loc-gps').addEventListener('click', useGps);
        $('jp-loc-station').addEventListener('click', useStation);
        $('jp-file').addEventListener('change', onFiles);
        $('jp-photo-edit').addEventListener('click', ev => {
            const b = ev.target.closest('[data-rm]');
            if (!b || !draft) return;
            const id = b.dataset.rm;
            draft.photos = draft.photos.filter(x => x !== id);
            if (draft.added.includes(id)) { draft.added = draft.added.filter(x => x !== id); removePhotos([id]); }
            else draft.removed.push(id);
            renderDraftPhotos();
        });
        $('modal-journal').addEventListener('close', () => {
            // Abgebrochen: im Dialog neu aufgenommene Fotos wieder verwerfen.
            if (draft && !committed && draft.added.length) removePhotos(draft.added);
            draft = null;
        });
    }
    function renderLocStatus() {
        const el = $('jp-loc-status');
        if (!el || !draft) return;
        if (draft.lat == null) { el.innerHTML = '<span class="jp-muted">Keine Position gespeichert</span>'; return; }
        const src = draft.locSrc === 'gps' ? 'Standort' : 'Station';
        el.innerHTML = `<span>📍 ${esc(src)}: ${esc(draft.lat.toFixed(4))}, ${esc(draft.lng.toFixed(4))}</span>
            <button type="button" class="jp-link" id="jp-loc-clear">Entfernen</button>`;
        $('jp-loc-clear').onclick = () => { draft.lat = draft.lng = null; draft.locSrc = ''; renderLocStatus(); };
    }
    function setLoc(lat, lng, src) {
        if (!draft || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
        draft.lat = lat; draft.lng = lng; draft.locSrc = src; renderLocStatus(); haptic();
        return true;
    }
    function useGps() {
        const btn = $('jp-loc-gps');
        const fallback = msg => {
            // Zuletzt bekannter Standort der App (Karte/Aktivitäten) als Ersatz
            if (typeof userLocation !== 'undefined' && userLocation && setLoc(userLocation.lat, userLocation.lng, 'gps')) showToast('📍 Zuletzt bekannter Standort übernommen');
            else showToast(msg);
        };
        if (!navigator.geolocation) { fallback('Standort wird von diesem Gerät nicht unterstützt.'); return; }
        if (!window.isSecureContext) { fallback('⚠️ Standort braucht HTTPS.'); return; }
        btn.classList.add('loading'); btn.disabled = true;
        navigator.geolocation.getCurrentPosition(pos => {
            btn.classList.remove('loading'); btn.disabled = false;
            const { latitude, longitude } = pos.coords;
            try { userLocation = { lat: latitude, lng: longitude }; } catch (e) {}
            if (setLoc(latitude, longitude, 'gps')) showToast('📍 Standort übernommen');
        }, () => {
            btn.classList.remove('loading'); btn.disabled = false;
            fallback('Standort konnte nicht ermittelt werden.');
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }
    function stationCoords(placeLabel) {
        if (!placeLabel || typeof places === 'undefined') return null;
        const i = places.findIndex((p, k) => displayName(p.name, k) === placeLabel);
        const p = places[i];
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || (p.lat === 0 && p.lng === 0)) return null;
        return { lat: p.lat, lng: p.lng };
    }
    function useStation() {
        const label = $('j-place').value;
        if (!label) { showToast('Bitte zuerst oben eine Station wählen'); return; }
        const c = stationCoords(label);
        if (!c) { showToast('⚠️ Für diese Station ist keine Position bekannt'); return; }
        setLoc(c.lat, c.lng, 'station');
    }
    async function onFiles(ev) {
        const input = ev.target, files = [...(input.files || [])].filter(f => /^image\//.test(f.type) || !f.type);
        input.value = '';
        if (!draft || !files.length) return;
        const room = MAX_PHOTOS - draft.photos.length;
        if (room <= 0) { showToast(`⚠️ Höchstens ${MAX_PHOTOS} Fotos pro Eintrag`); return; }
        const d = draft, todo = files.slice(0, room);
        const label = $('jp-photos-group').querySelector('.jp-add-photo');
        label.classList.add('loading');
        let failed = 0;
        for (const f of todo) {
            try {
                const id = await storeFile(f);
                if (draft !== d) { removePhotos([id]); return; } // Dialog inzwischen geschlossen
                d.photos.push(id); d.added.push(id);
                renderDraftPhotos();
            } catch (e) { failed++; console.warn('Foto konnte nicht gespeichert werden:', e); }
        }
        label.classList.remove('loading');
        if (failed) showToast(`⚠️ ${failed} Foto${failed === 1 ? '' : 's'} konnte${failed === 1 ? '' : 'n'} nicht gespeichert werden`);
        if (files.length > room) showToast(`⚠️ Höchstens ${MAX_PHOTOS} Fotos pro Eintrag`);
    }
    function renderDraftPhotos() {
        const el = $('jp-photo-edit');
        if (!el || !draft) return;
        el.innerHTML = draft.photos.map(id => `<div class="jp-thumb-wrap"><img class="jp-thumb" data-pid="${esc(id)}" alt="Foto">
            <button type="button" class="jp-thumb-rm" data-rm="${esc(id)}" aria-label="Foto entfernen">✕</button></div>`).join('');
        hydrate(el);
    }
    function openModal(entry) {
        ensureModalUi();
        committed = false;
        draft = { photos: entry ? (entry.photos || []).slice() : [], added: [], removed: [],
            lat: entry && entry.lat != null ? entry.lat : null, lng: entry && entry.lng != null ? entry.lng : null,
            locSrc: entry ? entry.locSrc || '' : '' };
        renderLocStatus(); renderDraftPhotos();
    }
    function collect() {
        if (!draft) return {};
        return { photos: draft.photos.slice(), lat: draft.lat, lng: draft.lng, locSrc: draft.lat == null ? '' : draft.locSrc };
    }
    function commit() {
        if (!draft) return;
        committed = true;
        const removed = draft.removed.filter(id => !referenced(id));
        if (removed.length) removePhotos(removed);
        refreshMapLayer();
    }
    const referenced = id => typeof journal !== 'undefined' && journal.some(e => (e.photos || []).includes(id));

    // Eintrag gelöscht: Fotos erst nach Ablauf des „Rückgängig"-Fensters entfernen.
    function onDelete(entry) {
        refreshMapLayer();
        const ids = (entry && entry.photos || []).slice();
        setTimeout(() => {
            if (typeof journal !== 'undefined' && journal.some(e => e.id === entry.id)) { refreshMapLayer(); return; }
            removePhotos(ids.filter(id => !referenced(id)));
        }, 6500);
    }

    // ─── Liste: Thumbnails ────────────────────────────────────────────────
    function entryHtml(e) {
        const ids = (e.photos || []).filter(id => ID_RE.test(id));
        const loc = e.lat != null ? `<button type="button" class="jp-maplink" data-jid="${esc(e.id)}" aria-label="Auf der Karte zeigen">${ico('map-pin', '📍')} Karte</button>` : '';
        if (!ids.length && !loc) return '';
        return `<div class="jp-strip">${ids.map((id, k) => `<button type="button" class="jp-thumb-btn" data-jid="${esc(e.id)}" data-k="${k}" aria-label="Foto ${k + 1} im Vollbild"><img class="jp-thumb" data-pid="${esc(id)}" alt=""></button>`).join('')}${loc}</div>`;
    }
    function hydrate(root) {
        root.querySelectorAll('img[data-pid]').forEach(img => {
            const id = img.dataset.pid;
            if (!ID_RE.test(id)) return;
            thumbUrl(id).then(u => { if (u) img.src = u; else img.closest('.jp-thumb-btn, .jp-thumb-wrap, .jp-rv-photo')?.classList.add('jp-missing'); });
        });
    }
    function afterRender(list) {
        if (!list) return;
        hydrate(list);
        if (journal.length) {
            const bar = document.createElement('div');
            bar.className = 'jp-review-bar';
            bar.innerHTML = `<button type="button" class="jp-chip jp-review-btn">${ico('film-strip', '🎞️')} Reise-Rückschau</button>`;
            bar.firstElementChild.addEventListener('click', openReview);
            list.prepend(bar);
        }
        if (!list.dataset.jpBound) {
            list.dataset.jpBound = '1';
            list.addEventListener('click', ev => {
                const t = ev.target.closest('.jp-thumb-btn');
                if (t) { const e = journal.find(x => x.id === t.dataset.jid); if (e) openViewer(e.photos, +t.dataset.k || 0); return; }
                const m = ev.target.closest('.jp-maplink');
                if (m) showEntryOnMap(m.dataset.jid);
            });
        }
        refreshMapLayer();
    }

    // ─── Vollbild-Ansicht ─────────────────────────────────────────────────
    let viewer = null, vIds = [], vIdx = 0, vUrl = null;
    function ensureViewer() {
        if (viewer) return viewer;
        viewer = document.createElement('dialog');
        viewer.className = 'jp-viewer'; viewer.setAttribute('aria-label', 'Foto');
        viewer.innerHTML = `<img class="jp-viewer-img" alt="Tagebuch-Foto">
            <button type="button" class="jp-viewer-close" aria-label="Schließen">✕</button>
            <button type="button" class="jp-viewer-nav jp-prev" aria-label="Vorheriges Foto">‹</button>
            <button type="button" class="jp-viewer-nav jp-next" aria-label="Nächstes Foto">›</button>
            <div class="jp-viewer-count" aria-live="polite"></div>`;
        document.body.appendChild(viewer);
        viewer.querySelector('.jp-viewer-close').onclick = () => viewer.close();
        viewer.querySelector('.jp-prev').onclick = ev => { ev.stopPropagation(); showV(vIdx - 1); };
        viewer.querySelector('.jp-next').onclick = ev => { ev.stopPropagation(); showV(vIdx + 1); };
        viewer.querySelector('.jp-viewer-img').onclick = () => viewer.close();
        viewer.addEventListener('keydown', ev => { if (ev.key === 'ArrowLeft') showV(vIdx - 1); if (ev.key === 'ArrowRight') showV(vIdx + 1); });
        let x0 = null;
        viewer.addEventListener('touchstart', ev => { x0 = ev.touches[0].clientX; }, { passive: true });
        viewer.addEventListener('touchend', ev => {
            if (x0 == null) return;
            const dx = ev.changedTouches[0].clientX - x0; x0 = null;
            if (Math.abs(dx) > 50) showV(vIdx + (dx < 0 ? 1 : -1));
        });
        viewer.addEventListener('close', () => { if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; } viewer.querySelector('.jp-viewer-img').removeAttribute('src'); });
        return viewer;
    }
    async function showV(i) {
        if (!vIds.length) return;
        vIdx = (i + vIds.length) % vIds.length;
        const v = ensureViewer(), img = v.querySelector('.jp-viewer-img');
        v.querySelector('.jp-viewer-count').textContent = vIds.length > 1 ? `${vIdx + 1} / ${vIds.length}` : '';
        v.querySelectorAll('.jp-viewer-nav').forEach(b => { b.hidden = vIds.length < 2; });
        const want = vIdx;
        const rec = await getPhoto(vIds[want]).catch(() => null);
        if (want !== vIdx || !v.open) return;
        if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
        if (rec && rec.blob instanceof Blob) { vUrl = URL.createObjectURL(rec.blob); img.src = vUrl; }
        else { img.removeAttribute('src'); showToast('⚠️ Foto nicht mehr vorhanden'); }
    }
    function openViewer(ids, k) {
        vIds = (ids || []).filter(id => ID_RE.test(id));
        if (!vIds.length) return;
        const v = ensureViewer();
        if (!v.open) v.showModal();
        showV(k);
    }

    // ─── Reise-Rückschau ──────────────────────────────────────────────────
    let review = null;
    function stationForDate(iso) {
        if (!iso || typeof computedData === 'undefined') return '';
        const i = computedData.findIndex(c => c && c.isoStart <= iso && iso < c.isoEnd);
        return i >= 0 && places[i] ? displayName(places[i].name, i) : '';
    }
    function tripDayNo(iso) {
        if (!iso || typeof startDate === 'undefined') return null;
        const d = Math.round((new Date(iso + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 864e5);
        return Number.isFinite(d) && d >= 0 ? d + 1 : null;
    }
    function openReview() {
        if (!review) {
            review = document.createElement('dialog');
            review.className = 'jp-review'; review.setAttribute('aria-labelledby', 'jp-review-title');
            review.innerHTML = `<div class="jp-review-head"><h3 id="jp-review-title">Reise-Rückschau</h3>
                <button type="button" class="jp-viewer-close jp-review-close" aria-label="Schließen">✕</button></div>
                <div class="jp-review-body" id="jp-review-body"></div>`;
            document.body.appendChild(review);
            review.querySelector('.jp-review-close').onclick = () => review.close();
            review.addEventListener('click', ev => {
                const t = ev.target.closest('.jp-rv-photo');
                if (!t) return;
                const e = journal.find(x => x.id === t.dataset.jid);
                if (e) openViewer(e.photos, +t.dataset.k || 0);
            });
        }
        const sorted = journal.slice().sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.created || 0) - (b.created || 0));
        const days = [];
        sorted.forEach(e => { const last = days[days.length - 1]; if (last && last.date === e.date) last.items.push(e); else days.push({ date: e.date, items: [e] }); });
        const nPhotos = sorted.reduce((s, e) => s + (e.photos || []).length, 0);
        const body = review.querySelector('#jp-review-body');
        body.innerHTML = `<p class="jp-review-sum">${esc(sorted.length)} Eintrag${sorted.length === 1 ? '' : 'e'} · ${esc(days.length)} Tag${days.length === 1 ? '' : 'e'} · ${esc(nPhotos)} Foto${nPhotos === 1 ? '' : 's'}</p>` +
            days.map(d => {
                const no = tripDayNo(d.date), st = stationForDate(d.date);
                return `<section class="jp-rv-day">
                    <div class="jp-rv-dayhead"><span class="jp-rv-dayno">${no ? 'Tag ' + esc(no) : 'Ohne Reisetag'}</span>
                        <h4>${d.date ? esc(fmtDateLong(d.date)) : 'Ohne Datum'}</h4>${st ? `<span class="jp-rv-station">${esc(st)}</span>` : ''}</div>
                    ${d.items.map(e => `<article class="jp-rv-entry">
                        ${e.place ? `<span class="journal-place">📍 ${esc(e.place)}</span>` : ''}
                        <div class="journal-text">${esc(e.text)}</div>
                        ${(e.photos || []).length ? `<div class="jp-rv-photos jp-n${Math.min(3, e.photos.length)}">${e.photos.map((id, k) => `<button type="button" class="jp-rv-photo" data-jid="${esc(e.id)}" data-k="${k}" aria-label="Foto ${k + 1} im Vollbild"><img data-pid="${esc(id)}" alt=""></button>`).join('')}</div>` : ''}
                    </article>`).join('')}
                </section>`;
            }).join('') + '<p class="jp-hint">Fotos liegen nur auf diesem Gerät (nicht im JSON-Backup).</p>';
        hydrate(body);
        if (!review.open) review.showModal();
        body.scrollTop = 0;
    }

    // ─── Karten-Ebene „Tagebuch" ──────────────────────────────────────────
    let lmap = null, jLayer = null, layerOn = false;
    try { layerOn = localStorage.getItem(LAYER_KEY) === '1'; } catch (e) {}
    function entryCoords(e) {
        if (e.lat != null && e.lng != null) return [e.lat, e.lng];
        const c = stationCoords(e.place); // ältere Einträge ohne Position: Ort der Station
        return c ? [c.lat, c.lng] : null;
    }
    function excerpt(t, n = 140) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
    function entryTitle(e) {
        const first = String(e.text || '').split('\n')[0].trim();
        return e.place || excerpt(first, 40) || 'Tagebuch';
    }
    function refreshMapLayer() {
        if (!jLayer || !window.L) return;
        jLayer.clearLayers();
        if (!layerOn || typeof journal === 'undefined') return;
        const icon = L.divIcon({ className: 'jp-marker', html: '<span>📝</span>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
        journal.forEach(e => {
            const c = entryCoords(e);
            if (!c) return;
            const firstPid = (e.photos || []).find(id => ID_RE.test(id));
            const html = `<div class="jp-popup">${firstPid ? `<img class="jp-popup-img" data-pid="${esc(firstPid)}" alt="">` : ''}
                <div class="jp-popup-date">${esc(e.date ? fmtDateLong(e.date) : 'Ohne Datum')}</div>
                <b>${esc(entryTitle(e))}</b><div class="jp-popup-text">${esc(excerpt(e.text))}</div></div>`;
            L.marker(c, { icon, zIndexOffset: 400, title: entryTitle(e) }).addTo(jLayer).bindPopup(html, { maxWidth: 240 })
                .on('popupopen', ev => { const el = ev.popup.getElement(); if (el) hydrate(el); });
        });
    }
    function setLayer(on) {
        layerOn = on;
        try { localStorage.setItem(LAYER_KEY, on ? '1' : '0'); } catch (e) {}
        const b = $('jp-layer-btn');
        if (b) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
        refreshMapLayer();
    }
    function initMapLayer(m) {
        if (!m || !window.L || lmap) return;
        lmap = m;
        jLayer = L.layerGroup().addTo(m);
        const view = $('view-map');
        if (view && !$('jp-layer-btn')) {
            const b = document.createElement('button');
            b.type = 'button'; b.id = 'jp-layer-btn'; b.className = 'jp-layer-btn';
            b.title = 'Tagebuch-Ebene ein/aus';
            b.innerHTML = `${ico('notebook', '📝')}<span>Tagebuch</span>`;
            b.addEventListener('click', () => { haptic(); setLayer(!layerOn); if (layerOn && !journal.some(entryCoords)) showToast('Noch keine Tagebuch-Einträge mit Ort'); });
            view.appendChild(b);
        }
        setLayer(layerOn);
    }
    function showEntryOnMap(id) {
        const e = journal.find(x => x.id === id), c = e && entryCoords(e);
        if (!c || !lmap) return;
        if (!layerOn) setLayer(true);
        switchView('view-map', 'Reiseroute Karte');
        setTimeout(() => {
            lmap.invalidateSize();
            lmap.setView(c, 13, { animate: true });
            jLayer.eachLayer(mk => { const ll = mk.getLatLng(); if (ll.lat === c[0] && ll.lng === c[1] && mk.options.title === entryTitle(e)) mk.openPopup(); });
        }, 250);
    }

    window.journalPlus = { entryHtml, afterRender, openModal, collect, commit, onDelete, initMapLayer, openReview, refreshMapLayer };
})();
