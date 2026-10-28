// ─── REISEDOKUMENTE (offline, nur lokal auf diesem Gerät) ─────────────────
// Fotos/PDFs von Pass, Tickets, Hotelbuchungen, JR-Pass, Versicherung … liegen als
// Blobs in IndexedDB (localStorage wäre mit ~5 MB viel zu klein). Sie sind bewusst
// NICHT Teil des JSON-Backups (EXPORT_KEYS) und werden nirgendwohin übertragen.
// Verschlüsselt mit AES-256-GCM. Der Schlüssel wird ohne Passwort beim ersten Speichern
// erzeugt, ist nicht exportierbar und liegt nur in dieser IndexedDB (Store „keys“).
// Nutzt Helfer aus app.js: esc(), showToast(), showUndoToast(), haptic().
(function () {
    'use strict';
    const DB_NAME = tripDbName('jp26_documents'), DB_VERSION = 2, STORE = 'docs', KEY_STORE = 'keys';
    const MAX_FILE = 15 * 1024 * 1024;      // PDFs (und fertig verkleinerte Bilder) max. 15 MB
    const MAX_IMG_IN = 50 * 1024 * 1024;    // Bild-Rohdatei vor dem Verkleinern
    const MAX_DIM = 2000, THUMB_DIM = 320, JPEG_Q = 0.85, THUMB_Q = 0.7;
    const KEEP_ORIGINAL_MAX = 2.5 * 1024 * 1024; // kleine JPEG/PNG/WebP ≤ 2000 px bleiben unverändert
    const MAX_DOCS = 200, TITLE_MAX = 80;
    // [id, Bezeichnung, Phosphor-Icon, Ersatz-Emoji]
    const CATS = [
        ['passport', 'Reisepass & Ausweis', 'identification-card', '🛂'],
        ['ticket', 'Tickets & Flüge', 'airplane-tilt', '✈️'],
        ['hotel', 'Hotelbuchungen', 'bed', '🏨'],
        ['jrpass', 'JR-Pass & Bahn', 'train', '🚄'],
        ['insurance', 'Versicherung', 'first-aid-kit', '🩺'],
        ['other', 'Sonstiges', 'file', '📄']
    ];
    const CAT_IDS = new Set(CATS.map(c => c[0]));
    const catOf = id => CATS.find(c => c[0] === id) || CATS[CATS.length - 1];
    const icon = (name, fb) => `<i class="ph-light ph-${name}" data-fb="${fb}" aria-hidden="true"></i>`;

    let docs = [];             // normalisierte Datensätze inkl. Blob-Referenzen
    let state = 'idle';        // idle | loading | ready | error
    let loadError = null;
    let listUrls = [];         // Object-URLs der Vorschaubilder (beim Neu-Rendern freigeben)
    let viewerUrl = null;
    let pending = null;        // { file, kind } – im Hinzufügen-Dialog gewählte Datei
    let pendingUrl = null;
    let editId = null;         // gesetzt = Dialog im Umbenennen-Modus
    let persistAsked = false;

    // ─── IndexedDB ──────────────────────────────────────────────────────────
    // Verständliche Fehlermeldungen für Quota, fehlendes IndexedDB, privaten Modus.
    function dbError(e) {
        const name = (e && e.name) || '';
        const err = new Error();
        if (name === 'QuotaExceededError' || /quota/i.test((e && e.message) || '')) {
            err.code = 'quota';
            err.message = 'Speicher voll – bitte Platz schaffen (z. B. andere Dokumente löschen).';
        } else if (name === 'unsupported' || name === 'SecurityError' || name === 'InvalidStateError' || name === 'TimeoutError' || name === 'UnknownError') {
            err.code = 'unavailable';
            err.message = 'Lokaler Dokumenten-Speicher nicht verfügbar (z. B. privater Modus oder blockierte Website-Daten).';
        } else {
            err.code = 'other';
            err.message = 'Speichern fehlgeschlagen' + (name ? ` (${name})` : '') + '.';
        }
        return err;
    }
    let dbP = null;
    function openDb() {
        if (dbP) return dbP;
        dbP = new Promise((resolve, reject) => {
            let req;
            try {
                if (!window.indexedDB) throw { name: 'unsupported' };
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) { reject(dbError(e)); return; }
            const timer = setTimeout(() => reject(dbError({ name: 'TimeoutError' })), 8000);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: 'id' });
            };
            req.onsuccess = () => {
                clearTimeout(timer);
                const db = req.result;
                db.onversionchange = () => { db.close(); dbP = null; };
                db.onclose = () => { dbP = null; };
                resolve(db);
            };
            req.onerror = () => { clearTimeout(timer); reject(dbError(req.error)); };
        });
        dbP.catch(() => { dbP = null; }); // nächster Versuch darf neu öffnen
        return dbP;
    }
    async function withStore(mode, fn, store = STORE) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            let tx, req;
            try { tx = db.transaction(store, mode); req = fn(tx.objectStore(store)); }
            catch (e) { dbP = null; reject(dbError(e)); return; }
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onabort = tx.onerror = () => reject(dbError(tx.error || (req && req.error)));
        });
    }
    const dbGetAll = () => withStore('readonly', st => st.getAll());
    const dbPut = rec => withStore('readwrite', st => st.put(rec));
    const dbDelete = id => withStore('readwrite', st => st.delete(id));

    // ─── Verschlüsselung ohne Passwort ──────────────────────────────────────
    // AES-256-GCM. Der Schlüssel entsteht beim ersten Speichern und bleibt als CryptoKey
    // (nicht exportierbar) im Browser. Der Nutzer muss nichts festlegen.
    let keyP = null;
    function getKey() {
        if (keyP) return keyP;
        if (!(window.crypto && crypto.subtle)) return Promise.reject(dbError({ name: 'unsupported' }));
        keyP = (async () => {
            const existing = await withStore('readonly', st => st.get('doc-key'), KEY_STORE);
            if (existing && existing.key) return existing.key;
            const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            await withStore('readwrite', st => st.put({ id: 'doc-key', key }), KEY_STORE);
            return key;
        })();
        keyP.catch(() => { keyP = null; });
        return keyP;
    }
    async function enc(bytes) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), bytes) };
    }
    async function dec(box) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, await getKey(), box.ct);
    }
    // Datensatz für IndexedDB: Titel, Bild und Vorschau sind verschlüsselt.
    // Im Klartext bleiben nur Kategorie, Typ und Datum für Sortierung und Anzeige.
    async function sealRecord(d) {
        const title = await enc(new TextEncoder().encode(JSON.stringify({ title: d.title })));
        const blob = await enc(await d.blob.arrayBuffer());
        const thumb = d.thumb ? Object.assign(await enc(await d.thumb.arrayBuffer()), { type: d.thumb.type }) : null;
        return { id: d.id, cat: d.cat, kind: d.kind, created: d.created, v: 2,
            title, blob: Object.assign(blob, { type: d.blob.type }), thumb };
    }
    async function openRecord(row) {
        const { title } = JSON.parse(new TextDecoder().decode(await dec(row.title)));
        const blob = new Blob([await dec(row.blob)], { type: row.blob.type || '' });
        const thumb = row.thumb ? new Blob([await dec(row.thumb)], { type: row.thumb.type || '' }) : null;
        return { id: row.id, title, cat: row.cat, kind: row.kind, created: row.created, blob, thumb };
    }

    // ─── Normalisieren (Datenbank-Inhalte nie ungeprüft anzeigen) ───────────
    const cleanTitle = t => (typeof t === 'string' ? t : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    function normDoc(d) {
        if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || !(d.blob instanceof Blob)) return null;
        return {
            id: d.id.slice(0, 60),
            title: cleanTitle(d.title) || 'Dokument',
            cat: CAT_IDS.has(d.cat) ? d.cat : 'other',
            kind: d.kind === 'pdf' ? 'pdf' : 'image',
            created: Number.isFinite(d.created) ? d.created : 0,
            blob: d.blob,
            thumb: d.thumb instanceof Blob ? d.thumb : null
        };
    }

    async function load() {
        state = 'loading';
        try {
            const rows = await dbGetAll();
            const loaded = [], legacy = [];
            for (const row of (Array.isArray(rows) ? rows : [])) {
                try {
                    if (row && row.v === 2) loaded.push(normDoc(await openRecord(row)));
                    else if (row && row.blob instanceof Blob) { const d = normDoc(row); if (d) { loaded.push(d); legacy.push(d); } }
                } catch (e) { console.warn('Dokument nicht lesbar', row && row.id, e); }
            }
            docs = loaded.filter(Boolean);
            // Altbestand (unverschlüsselt, vor dieser Version) nachträglich verschlüsseln
            for (const d of legacy) {
                try { await dbPut(await sealRecord(d)); } catch (e) { console.warn('Verschlüsselung fehlgeschlagen', d.id, e); }
            }
            state = 'ready'; loadError = null;
        } catch (e) {
            state = 'error'; loadError = e;
            console.warn('Dokumente: IndexedDB nicht nutzbar', e);
        }
        render();
    }

    // ─── Bildverarbeitung ───────────────────────────────────────────────────
    async function decodeImage(file) {
        if (typeof createImageBitmap === 'function') {
            try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
        }
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file), img = new Image();
            img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
            img.src = url;
        });
    }
    function encodeScaled(src, max, quality) {
        const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
        const s = Math.min(1, max / Math.max(sw, sh, 1));
        const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // transparente PNGs nicht schwarz werden lassen
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, w, h);
        return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('encode')), 'image/jpeg', quality));
    }
    async function processImage(file) {
        if (file.size > MAX_IMG_IN) throw new Error('Bild ist zu groß (max. 50 MB).');
        let bmp;
        try { bmp = await decodeImage(file); }
        catch (e) { throw new Error('Bildformat wird von diesem Browser nicht unterstützt (z. B. HEIC) – bitte als JPEG/PNG wählen.'); }
        try {
            const sw = bmp.naturalWidth || bmp.width, sh = bmp.naturalHeight || bmp.height;
            const keep = /^image\/(jpeg|png|webp)$/.test(file.type) && Math.max(sw, sh) <= MAX_DIM && file.size <= KEEP_ORIGINAL_MAX;
            const blob = keep ? file.slice(0, file.size, file.type) : await encodeScaled(bmp, MAX_DIM, JPEG_Q);
            const thumb = await encodeScaled(bmp, THUMB_DIM, THUMB_Q).catch(() => null);
            if (blob.size > MAX_FILE) throw new Error('Bild ist auch verkleinert noch zu groß.');
            return { blob, thumb };
        } finally { try { bmp.close?.(); } catch (e) {} }
    }
    async function readHead(blob, n) {
        const part = blob.slice(0, n);
        if (part.arrayBuffer) return new Uint8Array(await part.arrayBuffer());
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(new Uint8Array(fr.result)); fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(part);
        });
    }
    async function processPdf(file) {
        if (file.size > MAX_FILE) throw new Error('PDF ist zu groß (max. 15 MB).');
        const head = await readHead(file, 5);
        // Magic Bytes "%PDF-" – verhindert, dass z. B. eine umbenannte HTML-Datei gespeichert wird
        if (String.fromCharCode(...head) !== '%PDF-') throw new Error('Datei ist kein gültiges PDF.');
        return { blob: file.slice(0, file.size, 'application/pdf'), thumb: null };
    }
    function kindOf(file) {
        if (!file) return null;
        if (file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name || ''))) return 'pdf';
        if (/^image\//.test(file.type) && file.type !== 'image/svg+xml') return 'image';
        if (!file.type && /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name || '')) return 'image';
        return null;
    }

    // ─── Speicherplatz ──────────────────────────────────────────────────────
    function askPersist() {
        if (persistAsked) return;
        persistAsked = true;
        try {
            navigator.storage?.persisted?.().then(p => p ? true : navigator.storage.persist?.())
                .then(() => updateStorageInfo()).catch(() => {});
        } catch (e) {}
    }
    const fmtSize = b => b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    async function updateStorageInfo() {
        const el = document.getElementById('docStorageInfo');
        if (!el) return;
        const parts = [];
        const total = docs.reduce((s, d) => s + d.blob.size + (d.thumb ? d.thumb.size : 0), 0);
        if (docs.length) parts.push(`${docs.length} Dokument${docs.length === 1 ? '' : 'e'} · ${fmtSize(total)}`);
        try {
            const p = await navigator.storage?.persisted?.();
            if (p === true) parts.push('dauerhaft gespeichert');
            else if (p === false && docs.length) parts.push('Browser darf bei Speichermangel löschen');
        } catch (e) {}
        try {
            const est = await navigator.storage?.estimate?.();
            if (est && est.quota) parts.push(`frei ca. ${fmtSize(Math.max(0, est.quota - (est.usage || 0)))}`);
        } catch (e) {}
        el.textContent = parts.join(' · ');
    }

    // ─── Rendern ────────────────────────────────────────────────────────────
    function render() {
        const list = document.getElementById('documentsList');
        if (!list) return;
        if (state === 'idle') { load(); }
        listUrls.forEach(u => URL.revokeObjectURL(u));
        listUrls = [];
        const note = `<div class="doc-note">${icon('lock-simple', '🔒')}<div><b>Verschlüsselt, nur auf diesem Gerät.</b> Kein Passwort nötig. Dokumente sind offline verfügbar, werden nicht hochgeladen und sind <b>nicht im JSON-Backup</b> enthalten. Löschst du die Website-Daten des Browsers, sind sie weg – Originale also zusätzlich sicher aufbewahren.<span class="doc-storage" id="docStorageInfo"></span></div></div>`;
        const fab = document.getElementById('docFab');
        if (fab) fab.hidden = state === 'error';
        if (state === 'idle' || state === 'loading') { list.innerHTML = note + '<div class="empty-acts">Lade Dokumente …</div>'; return; }
        if (state === 'error') {
            list.innerHTML = note + `<div class="empty-acts">⚠️ ${esc(loadError && loadError.message)}<br><button type="button" class="btn empty-cta" data-doc-retry>Erneut versuchen</button></div>`;
            return;
        }
        if (!docs.length) {
            list.innerHTML = note + '<div class="empty-acts">🛂 Noch keine Dokumente.<br>Speichere Pass, Tickets, Hotelbuchungen oder JR-Pass als Foto oder PDF – auch ohne Netz griffbereit.<br><button type="button" class="btn empty-cta" data-doc-add>Dokument hinzufügen</button></div>';
            updateStorageInfo();
            return;
        }
        const groups = CATS.map(c => ({ c, items: docs.filter(d => d.cat === c[0]).sort((a, b) => b.created - a.created) })).filter(g => g.items.length);
        list.innerHTML = note + groups.map(({ c, items }) => `
        <div class="dayplan-card doc-group">
            <div class="dayplan-header">
                <h3>${icon(c[2], c[3])} ${esc(c[1])}</h3>
                <span class="dayplan-count">${items.length}</span>
            </div>
            ${items.map(d => {
                let thumb;
                if (d.thumb || d.kind === 'image') {
                    const u = URL.createObjectURL(d.thumb || d.blob);
                    listUrls.push(u);
                    thumb = `<img class="doc-thumb" src="${esc(u)}" alt="" loading="lazy" decoding="async">`;
                } else thumb = `<span class="doc-thumb doc-thumb-pdf">${icon('file-pdf', '📄')}<span>PDF</span></span>`;
                return `
            <div class="doc-item">
                <button type="button" class="doc-open" data-doc-open="${esc(d.id)}" aria-label="${esc(d.title)} öffnen">
                    ${thumb}
                    <span class="doc-text"><span class="doc-title">${esc(d.title)}</span><span class="doc-meta">${d.kind === 'pdf' ? 'PDF' : 'Bild'} · ${esc(fmtSize(d.blob.size))}${d.created ? ' · ' + esc(new Date(d.created).toLocaleDateString('de-DE')) : ''}</span></span>
                </button>
                <button type="button" class="edit-btn" data-doc-edit="${esc(d.id)}" aria-label="${esc(d.title)} umbenennen">✏️</button>
                <button type="button" class="del-btn" data-doc-del="${esc(d.id)}" aria-label="${esc(d.title)} löschen">✕</button>
            </div>`;
            }).join('')}
        </div>`).join('');
        updateStorageInfo();
    }

    // ─── Öffnen ─────────────────────────────────────────────────────────────
    function openDoc(id) {
        const d = docs.find(x => x.id === id);
        if (!d) return;
        haptic();
        if (d.kind === 'pdf') {
            // Typ immer fest auf application/pdf setzen: eine blob:-URL läuft im App-Origin,
            // ein falscher MIME-Typ (z. B. text/html) dürfte dort niemals gerendert werden.
            const url = URL.createObjectURL(new Blob([d.blob], { type: 'application/pdf' }));
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
            return;
        }
        const dlg = document.getElementById('modal-doc-viewer');
        const img = document.getElementById('docViewerImg');
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        viewerUrl = URL.createObjectURL(d.blob);
        img.classList.remove('zoomed');
        img.src = viewerUrl;
        img.alt = d.title;
        document.getElementById('docViewerTitle').textContent = d.title;
        dlg.showModal();
    }

    // ─── Hinzufügen / Umbenennen ────────────────────────────────────────────
    function setPending(file) {
        const box = document.getElementById('docPicked');
        if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
        pending = null;
        if (!file) { box.hidden = true; box.replaceChildren(); return; }
        const kind = kindOf(file);
        if (!kind) { showToast('⚠️ Nur Bilder oder PDFs möglich'); box.hidden = true; return; }
        if (kind === 'pdf' && file.size > MAX_FILE) { showToast('⚠️ PDF ist zu groß (max. 15 MB)'); box.hidden = true; return; }
        pending = { file, kind };
        let prev;
        if (kind === 'image') {
            pendingUrl = URL.createObjectURL(file);
            prev = `<img class="doc-thumb" src="${esc(pendingUrl)}" alt="">`;
        } else prev = `<span class="doc-thumb doc-thumb-pdf">${icon('file-pdf', '📄')}<span>PDF</span></span>`;
        box.innerHTML = `${prev}<span class="doc-text"><span class="doc-title">${esc(file.name || 'Foto')}</span><span class="doc-meta">${esc(fmtSize(file.size))}</span></span>`;
        box.hidden = false;
        const t = document.getElementById('doc-title');
        if (!t.value.trim()) t.value = cleanTitle((file.name || '').replace(/\.[a-z0-9]{2,5}$/i, '')).slice(0, TITLE_MAX);
    }
    function openAdd() {
        if (state === 'error') { showToast('⚠️ ' + (loadError ? loadError.message : 'Speicher nicht verfügbar')); return; }
        if (docs.length >= MAX_DOCS) { showToast(`⚠️ Maximal ${MAX_DOCS} Dokumente`); return; }
        editId = null;
        const dlg = document.getElementById('modal-doc');
        document.getElementById('modal-doc-title').textContent = 'Dokument hinzufügen';
        document.getElementById('docPick').hidden = false;
        document.getElementById('docSizeHint').hidden = false;
        document.getElementById('docFileInput').value = '';
        document.getElementById('docFileCamera').value = '';
        document.getElementById('doc-title').value = '';
        document.getElementById('doc-cat').value = 'passport';
        setPending(null);
        dlg.showModal();
    }
    function openEdit(id) {
        const d = docs.find(x => x.id === id);
        if (!d) return;
        editId = id;
        setPending(null);
        document.getElementById('modal-doc-title').textContent = 'Dokument umbenennen';
        document.getElementById('docPick').hidden = true;
        document.getElementById('docSizeHint').hidden = true;
        document.getElementById('doc-title').value = d.title;
        document.getElementById('doc-cat').value = d.cat;
        document.getElementById('modal-doc').showModal();
    }
    let saving = false;
    async function save() {
        if (saving) return;
        const title = cleanTitle(document.getElementById('doc-title').value);
        const cat = CAT_IDS.has(document.getElementById('doc-cat').value) ? document.getElementById('doc-cat').value : 'other';
        if (!title) { showToast('⚠️ Bitte einen Titel eingeben'); return; }
        const btn = document.getElementById('docSaveBtn');
        saving = true; btn.disabled = true; btn.textContent = 'Speichere …';
        try {
            if (editId) {
                const d = docs.find(x => x.id === editId);
                if (!d) throw new Error('Dokument nicht gefunden.');
                const next = Object.assign({}, d, { title, cat });
                await dbPut(await sealRecord(next));
                Object.assign(d, { title, cat });
                showToast('✅ Dokument aktualisiert');
            } else {
                if (!pending) { showToast('⚠️ Bitte zuerst ein Foto oder PDF wählen'); return; }
                const { blob, thumb } = pending.kind === 'pdf' ? await processPdf(pending.file) : await processImage(pending.file);
                const rec = { id: 'doc' + Date.now() + Math.random().toString(36).slice(2, 7), title, cat, kind: pending.kind, created: Date.now(), blob, thumb };
                await dbPut(await sealRecord(rec));
                docs.push(normDoc(rec));
                showToast('✅ Dokument gespeichert');
                askPersist();
            }
            editId = null;
            document.getElementById('modal-doc').close();
            render();
        } catch (e) {
            console.warn('Dokument speichern fehlgeschlagen', e);
            showToast('⚠️ ' + (e && e.message ? e.message : 'Speichern fehlgeschlagen'), 5000);
        } finally {
            saving = false; btn.disabled = false; btn.textContent = 'Speichern';
        }
    }
    async function del(id) {
        const idx = docs.findIndex(d => d.id === id);
        if (idx < 0) return;
        haptic();
        const d = docs[idx];
        try { await dbDelete(id); }
        catch (e) { showToast('⚠️ ' + e.message); return; }
        docs.splice(docs.indexOf(d), 1);
        render();
        showUndoToast(`🗑️ „${d.title.slice(0, 40)}“ gelöscht`, async () => {
            if (docs.some(x => x.id === id)) return;
            try { await dbPut(await sealRecord(d)); docs.push(d); render(); }
            catch (e) { showToast('⚠️ Wiederherstellen fehlgeschlagen: ' + e.message); }
        });
    }

    // ─── DOM aufbauen + Ereignisse ──────────────────────────────────────────
    function init() {
        const app = document.getElementById('app');
        if (!app || document.getElementById('modal-doc')) return;
        const tpl = document.createElement('template');
        tpl.innerHTML = `
    <dialog id="modal-doc" aria-labelledby="modal-doc-title">
        <h3 id="modal-doc-title">Dokument hinzufügen</h3>
        <div class="dialog-body">
            <div class="doc-pick" id="docPick">
                <button type="button" class="btn btn-secondary doc-pick-btn" data-doc-pick="docFileCamera">${icon('camera', '📷')} Kamera</button>
                <button type="button" class="btn btn-secondary doc-pick-btn" data-doc-pick="docFileInput">${icon('folder-open', '📁')} Datei / PDF</button>
                <input type="file" id="docFileCamera" accept="image/*" capture="environment" hidden>
                <input type="file" id="docFileInput" accept="image/*,application/pdf" hidden>
            </div>
            <div class="doc-picked" id="docPicked" hidden></div>
            <div class="form-group"><label for="doc-title">Titel</label><input type="text" id="doc-title" maxlength="${TITLE_MAX}" placeholder="z. B. Reisepass, Flug FRA–HND" autocomplete="off"></div>
            <div class="form-group"><label for="doc-cat">Kategorie</label><select id="doc-cat">${CATS.map(c => `<option value="${esc(c[0])}">${esc(c[3] + ' ' + c[1])}</option>`).join('')}</select></div>
            <p class="form-hint" id="docSizeHint">Bilder werden auf max. ${MAX_DIM} px verkleinert, PDFs bis 15 MB unverändert gespeichert – nur auf diesem Gerät.</p>
        </div>
        <div class="dialog-actions">
            <button type="button" class="btn" id="docSaveBtn">Speichern</button>
            <button type="button" class="btn btn-secondary" data-doc-close>Abbrechen</button>
        </div>
    </dialog>
    <dialog id="modal-doc-viewer" class="doc-viewer" aria-labelledby="docViewerTitle">
        <div class="doc-viewer-bar">
            <h3 id="docViewerTitle"></h3>
            <button type="button" class="doc-viewer-close" data-doc-close aria-label="Schließen">${icon('x', '✕')}</button>
        </div>
        <div class="doc-viewer-wrap"><img id="docViewerImg" alt=""></div>
    </dialog>`;
        app.appendChild(tpl.content);

        const dlg = document.getElementById('modal-doc'), viewer = document.getElementById('modal-doc-viewer');
        dlg.addEventListener('click', e => {
            const pick = e.target.closest('[data-doc-pick]');
            if (pick) { document.getElementById(pick.dataset.docPick)?.click(); return; }
            if (e.target.closest('[data-doc-close]')) dlg.close();
        });
        ['docFileInput', 'docFileCamera'].forEach(id => document.getElementById(id).addEventListener('change', ev => setPending(ev.target.files && ev.target.files[0])));
        document.getElementById('docSaveBtn').addEventListener('click', save);
        document.getElementById('doc-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        dlg.addEventListener('close', () => { setPending(null); editId = null; });

        viewer.addEventListener('click', e => {
            if (e.target.closest('[data-doc-close]') || e.target === viewer) { viewer.close(); return; }
            if (e.target.id === 'docViewerImg') e.target.classList.toggle('zoomed');
        });
        viewer.addEventListener('close', () => {
            const img = document.getElementById('docViewerImg');
            img.removeAttribute('src');
            if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
        });

        const view = document.getElementById('view-documents');
        view?.addEventListener('click', e => {
            const t = e.target.closest('[data-doc-open],[data-doc-edit],[data-doc-del],[data-doc-add],[data-doc-retry]');
            if (!t) return;
            if (t.dataset.docOpen) openDoc(t.dataset.docOpen);
            else if (t.dataset.docEdit) openEdit(t.dataset.docEdit);
            else if (t.dataset.docDel) del(t.dataset.docDel);
            else if (t.hasAttribute('data-doc-add')) openAdd();
            else if (t.hasAttribute('data-doc-retry')) { state = 'idle'; render(); }
        });
        document.getElementById('docFab')?.addEventListener('click', openAdd);
        // Wurde die View schon beim Start (zuletzt geöffnete Seite) aktiviert, jetzt füllen
        if (view?.classList.contains('active')) render();
    }

    window.documentsFeature = { render, openAdd };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
