// ─── TRESOR: Verschlüsselung für Cloud-Sync und vollständiges Backup ─────────
// Aus dem Sync-Passwort entsteht per PBKDF2 ein AES-256-GCM-Schlüssel. Das Passwort selbst
// wird nirgends gespeichert. Der Schlüssel liegt (nicht exportierbar) in IndexedDB dieses
// Geräts; das Salt und ein Prüfwert liegen in Google Drive (tp-vault.json), damit weitere
// Geräte mit demselben Passwort denselben Schlüssel ableiten können.
// Ohne Passwort sind Cloud-Kopie und Backups nicht lesbar – es gibt keine Hintertür.
(function () {
    'use strict';
    const DB_NAME = 'tp_vault', STORE = 'kv', ITER = 600000, CHECK = 'trip-planer-vault';
    const te = new TextEncoder(), td = new TextDecoder();

    // ─── Hilfen ───────────────────────────────────────────────────────────
    function b64(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
    }
    function unb64(str) {
        const s = atob(String(str || '')), u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u;
    }
    const rand = n => crypto.getRandomValues(new Uint8Array(n));
    const supported = () => !!(window.crypto && crypto.subtle && window.indexedDB);

    function db() {
        return new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
            req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function kv(mode, fn) {
        const d = await db();
        try {
            return await new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(req ? req.result : undefined);
                tx.onabort = tx.onerror = () => reject(tx.error);
            });
        } finally { d.close(); }
    }

    async function derive(password, salt) {
        const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base,
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function encWith(key, bytes) {
        const iv = rand(12);
        return { iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
    }
    async function decWith(key, iv, ct) {
        try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)); }
        catch (e) { const err = new Error('Entschlüsseln fehlgeschlagen – falsches Passwort oder beschädigte Datei.'); err.code = 'bad-key'; throw err; }
    }

    // ─── Schlüssel dieses Geräts ──────────────────────────────────────────
    let keyP = null;
    function getKey() {
        if (!supported()) return Promise.resolve(null);
        if (!keyP) keyP = kv('readonly', st => st.get('key')).then(r => (r && r.key) || null).catch(() => null);
        return keyP;
    }
    async function storeKey(key) {
        await kv('readwrite', st => st.put({ id: 'key', key }));
        keyP = Promise.resolve(key);
    }
    async function need() {
        const k = await getKey();
        if (!k) { const e = new Error('Sync-Passwort fehlt auf diesem Gerät.'); e.code = 'need-password'; throw e; }
        return k;
    }
    const hasKey = async () => !!(await getKey());
    // Neues Passwort: liefert die Tresor-Datei (Salt + Prüfwert) für Google Drive.
    async function create(password) {
        const salt = rand(16), key = await derive(password, salt);
        const c = await encWith(key, te.encode(CHECK));
        await storeKey(key);
        return { app: 'trip-planer-vault', v: 1, iter: ITER, salt: b64(salt), iv: b64(c.iv), check: b64(c.ct) };
    }
    // Weiteres Gerät: Passwort gegen die Tresor-Datei prüfen und Schlüssel merken.
    async function unlock(password, meta) {
        if (!meta || meta.app !== 'trip-planer-vault' || !meta.salt || !meta.check) throw new Error('Tresor-Datei in Google Drive ist ungültig.');
        const key = await derive(password, unb64(meta.salt));
        let ok = false;
        try { ok = td.decode(await decWith(key, unb64(meta.iv), unb64(meta.check))) === CHECK; } catch (e) {}
        if (!ok) { const e = new Error('Falsches Passwort.'); e.code = 'bad-key'; throw e; }
        await storeKey(key);
    }
    async function forget() {
        await kv('readwrite', st => st.delete('key')).catch(() => {});
        keyP = Promise.resolve(null);
    }

    // ─── Ver-/Entschlüsseln mit dem Geräteschlüssel ───────────────────────
    async function encryptJson(obj) {
        const c = await encWith(await need(), te.encode(JSON.stringify(obj)));
        return { iv: b64(c.iv), ct: b64(c.ct) };
    }
    async function decryptJson(box) {
        return JSON.parse(td.decode(await decWith(await need(), unb64(box.iv), unb64(box.ct))));
    }
    // Binär: 12 Byte IV, danach der Geheimtext.
    async function encryptBytes(bytes) {
        const c = await encWith(await need(), bytes);
        const out = new Uint8Array(12 + c.ct.length);
        out.set(c.iv); out.set(c.ct, 12);
        return out;
    }
    async function decryptBytes(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (u.length < 13) { const e = new Error('Datei ist leer oder beschädigt.'); e.code = 'bad-key'; throw e; }
        return decWith(await need(), u.subarray(0, 12), u.subarray(12));
    }

    // ─── Dokument-Paket: [4 Byte Kopflänge][Kopf als JSON][Datei][Vorschau] ─
    async function packDoc(d) {
        const head = te.encode(JSON.stringify({ id: d.id, title: d.title, cat: d.cat, kind: d.kind, created: d.created, ref: d.ref || '',
            blobType: d.blob.type || '', blobSize: d.blob.size, thumbType: d.thumb ? d.thumb.type || '' : '', thumbSize: d.thumb ? d.thumb.size : 0 }));
        const blob = new Uint8Array(await d.blob.arrayBuffer());
        const thumb = d.thumb ? new Uint8Array(await d.thumb.arrayBuffer()) : new Uint8Array(0);
        const out = new Uint8Array(4 + head.length + blob.length + thumb.length);
        new DataView(out.buffer).setUint32(0, head.length);
        out.set(head, 4); out.set(blob, 4 + head.length); out.set(thumb, 4 + head.length + blob.length);
        return out;
    }
    function unpackDoc(u, offset = 0) {
        const view = new DataView(u.buffer, u.byteOffset, u.byteLength);
        const hl = view.getUint32(offset);
        const h = JSON.parse(td.decode(u.subarray(offset + 4, offset + 4 + hl)));
        let p = offset + 4 + hl;
        const blob = new Blob([u.slice(p, p + h.blobSize)], { type: h.blobType }); p += h.blobSize;
        const thumb = h.thumbSize ? new Blob([u.slice(p, p + h.thumbSize)], { type: h.thumbType }) : null; p += h.thumbSize;
        return { doc: { id: h.id, title: h.title, cat: h.cat, kind: h.kind, created: h.created, ref: h.ref, blob, thumb }, end: p };
    }

    // ─── Vollständiges Backup (eine Datei, eigenes Salt, Passwort beim Öffnen) ─
    // Aufbau: "TPBK1" + Salt(16) + IV(12) + Geheimtext von [4 Byte Länge][JSON-Nutzdaten][Dokument-Pakete …]
    const MAGIC = te.encode('TPBK1');
    async function buildBackup(password, payload, docs) {
        const head = te.encode(JSON.stringify(Object.assign({}, payload, { docCount: docs.length })));
        const packs = [];
        for (const d of docs) packs.push(await packDoc(d));
        const plain = new Uint8Array(4 + head.length + packs.reduce((n, p) => n + p.length, 0));
        new DataView(plain.buffer).setUint32(0, head.length);
        plain.set(head, 4);
        let p = 4 + head.length;
        packs.forEach(x => { plain.set(x, p); p += x.length; });
        const salt = rand(16), c = await encWith(await derive(password, salt), plain);
        return new Blob([MAGIC, salt, c.iv, c.ct], { type: 'application/octet-stream' });
    }
    function isBackup(u) { return u.length > 33 && MAGIC.every((b, i) => u[i] === b); }
    async function openBackup(password, bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (!isBackup(u)) throw new Error('Keine vollständige Backup-Datei.');
        const plain = await decWith(await derive(password, u.subarray(5, 21)), u.subarray(21, 33), u.subarray(33));
        const hl = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
        const payload = JSON.parse(td.decode(plain.subarray(4, 4 + hl)));
        const docs = [];
        let p = 4 + hl;
        for (let i = 0; i < (payload.docCount || 0) && p < plain.length; i++) { const r = unpackDoc(plain, p); docs.push(r.doc); p = r.end; }
        return { payload, docs };
    }

    // ─── Passwort-Dialog ──────────────────────────────────────────────────
    // opts: { title, hint, confirm (zweites Feld), action }. Liefert das Passwort oder null.
    function askPassword(opts) {
        const o = opts || {};
        let d = document.getElementById('modal-vault-pw');
        if (!d) {
            d = document.createElement('dialog');
            d.id = 'modal-vault-pw';
            d.setAttribute('aria-labelledby', 'vault-pw-title');
            d.innerHTML = `
                <h3 id="vault-pw-title"></h3>
                <form method="dialog" class="dialog-body" id="vault-pw-form">
                    <p class="form-hint" id="vault-pw-hint"></p>
                    <div class="form-group"><label for="vault-pw-1">Passwort</label><input type="password" id="vault-pw-1" autocomplete="off" maxlength="200"></div>
                    <div class="form-group" id="vault-pw-2-wrap"><label for="vault-pw-2">Passwort wiederholen</label><input type="password" id="vault-pw-2" autocomplete="off" maxlength="200"></div>
                    <p class="form-hint" id="vault-pw-err" role="alert"></p>
                </form>
                <div class="dialog-actions">
                    <button type="button" class="btn" id="vault-pw-ok"></button>
                    <button type="button" class="btn btn-secondary" id="vault-pw-cancel">Abbrechen</button>
                </div>`;
            document.body.appendChild(d);
        }
        const q = id => d.querySelector(id);
        q('#vault-pw-title').textContent = o.title || 'Passwort';
        q('#vault-pw-hint').textContent = o.hint || '';
        q('#vault-pw-ok').textContent = o.action || 'OK';
        q('#vault-pw-2-wrap').hidden = !o.confirm;
        q('#vault-pw-1').value = ''; q('#vault-pw-2').value = ''; q('#vault-pw-err').textContent = '';
        return new Promise(resolve => {
            let result = null;
            const submit = () => {
                const a = q('#vault-pw-1').value, b = q('#vault-pw-2').value;
                if (o.confirm && a.length < 8) { q('#vault-pw-err').textContent = 'Bitte mindestens 8 Zeichen.'; return; }
                if (!a) { q('#vault-pw-err').textContent = 'Bitte das Passwort eingeben.'; return; }
                if (o.confirm && a !== b) { q('#vault-pw-err').textContent = 'Die Passwörter stimmen nicht überein.'; return; }
                result = a; d.close();
            };
            q('#vault-pw-ok').onclick = submit;
            q('#vault-pw-cancel').onclick = () => d.close();
            q('#vault-pw-form').onsubmit = e => { e.preventDefault(); submit(); };
            d.addEventListener('close', () => { q('#vault-pw-1').value = ''; q('#vault-pw-2').value = ''; resolve(result); }, { once: true });
            d.showModal();
            q('#vault-pw-1').focus();
        });
    }

    window.tripVault = { supported, hasKey, create, unlock, forget, encryptJson, decryptJson, encryptBytes, decryptBytes,
        packDoc, unpackDoc, buildBackup, openBackup, isBackup, askPassword };
})();
