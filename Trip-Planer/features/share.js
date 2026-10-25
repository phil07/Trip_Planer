// ─── REISE TEILEN (ohne Server) ──────────────────────────────────────────────
// Die Reisedaten (gleicher Umfang wie der JSON-Export, EXPORT_KEYS) werden mit
// CompressionStream('deflate-raw') komprimiert, base64url-kodiert und in das
// Hash-Fragment eines Links gepackt: https://<origin>/#import=<daten>.
// Das Fragment schickt der Browser nie an den Server – die Daten gehen nur an
// die Personen, die den Link bekommen.
// Bevorzugt wird ein KURZLINK (#s=<id>.<schlüssel>): Die Daten werden im Browser mit AES-GCM
// verschlüsselt und als Chiffretext 30 Tage auf dem Worker (POST /api/share) abgelegt; der
// Schlüssel steht nur im Link. So bleibt der Link ~60 Zeichen lang und passt immer in einen
// QR-Code. Ist der Server nicht erreichbar, fällt die App auf den langen Link (#import=) zurück. Beim Öffnen läuft alles durch
// validateBackup() und den normalen Import-Weg (replaceTripData mit Sicherung
// „Letzten Import rückgängig machen“). Keine Live-Synchronisation (bräuchte ein Backend).
(function () {
    'use strict';
    const HASH_PREFIX = '#import=';
    const SHORT_PREFIX = '#s=';
    const SHORT_MAX_BLOB = 512 * 1024;       // wie auf dem Server
    const QR_MAX_LEN = 2500;                 // längere Links passen nicht zuverlässig in einen QR-Code
    const MAX_HASH_LEN = 4 * 1024 * 1024;    // kodierte Daten: mehr ist kein echter Export
    const MAX_INFLATED = 5 * 1024 * 1024;    // Schutz vor Dekompressions-Bomben
    // Persönliche Einstellungen des Empfängers bleiben erhalten, wenn der Link sie nicht enthält.
    const KEEP_LOCAL_KEYS = ['tp_theme', 'tp_journal'];
    const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

    // ── Kodierung ──
    function bytesToB64url(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function b64urlToBytes(s) {
        if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Ungültige Zeichen');
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
        const bin = atob(b64), out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    async function deflate(text) {
        const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Entpackt stückweise und bricht ab, sobald mehr als `max` Bytes herauskämen.
    async function inflateLimited(bytes, max) {
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = []; let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > max) { try { await reader.cancel(); } catch (e) {} throw new Error('Zu groß'); }
            chunks.push(value);
        }
        const out = new Uint8Array(total); let off = 0;
        chunks.forEach(c => { out.set(c, off); off += c.length; });
        return new TextDecoder('utf-8', { fatal: true }).decode(out);
    }

    // ── Payload bauen (wie exportTripData, aber optional ohne Tagebuch/Notizen) ──
    function buildPayload(opts) {
        const data = {};
        EXPORT_KEYS.forEach(k => {
            if (k === 'tp_theme') return; // Design ist Geräte-Vorliebe, nicht Reisedaten
            if (k === 'tp_journal' && !opts.journal) return;
            const v = localStorage.getItem(k); if (v !== null) data[k] = v;
        });
        if (!opts.notes && data.tp_acts) {
            try {
                const acts = JSON.parse(data.tp_acts);
                if (Array.isArray(acts)) data.tp_acts = JSON.stringify(acts.map(a => (isObj(a) ? Object.assign({}, a, { notes: '' }) : a)));
            } catch (e) {}
        }
        return { app: 'trip-planer', version: APP_VERSION, exportedAt: new Date().toISOString(),
            label: (typeof tripName === 'string' && tripName.trim()) || 'Reise', shared: true, data };
    }
    async function buildLink(payload) {
        const enc = bytesToB64url(await deflate(JSON.stringify(payload)));
        return location.origin + location.pathname + HASH_PREFIX + enc;
    }

    // ── Kurzlink: Ende-zu-Ende-verschlüsselt, Server sieht nur Chiffretext ──
    async function encryptBytes(bytes) {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
        const blob = new Uint8Array(iv.length + ct.length);
        blob.set(iv); blob.set(ct, iv.length);
        return { blob, key: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', key))) };
    }
    async function decryptBytes(blob, keyB64) {
        const raw = b64urlToBytes(keyB64);
        if (raw.length !== 32 || blob.length < 29) throw new Error('Ungültig');
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12)));
    }
    async function buildShortLink(payload) {
        if (!(window.crypto && crypto.subtle)) throw new Error('Kein WebCrypto');
        const { blob, key } = await encryptBytes(await deflate(JSON.stringify(payload)));
        if (blob.length > SHORT_MAX_BLOB) throw new Error('Zu groß');
        const res = await fetch('/api/share', { method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream' } });
        if (!res.ok) throw new Error('Server ' + res.status);
        const { id } = await res.json();
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(id)) throw new Error('Ungültige Antwort');
        return location.origin + location.pathname + SHORT_PREFIX + id + '.' + key;
    }
    async function fetchShort(ref) {
        const m = /^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{43})$/.exec(ref);
        if (!m) throw new Error('Ungültig');
        const res = await fetch('/api/share/' + m[1], { cache: 'no-store' });
        if (res.status === 404) throw new Error('Abgelaufen');
        if (!res.ok) throw new Error('Server ' + res.status);
        const blob = new Uint8Array(await res.arrayBuffer());
        if (blob.length > SHORT_MAX_BLOB) throw new Error('Zu groß');
        return inflateLimited(await decryptBytes(blob, m[2]), MAX_INFLATED);
    }

    // ── QR-Code (selbst gehostet: vendor/qrcode-generator, erst bei Bedarf geladen) ──
    let qrLibPromise = null;
    function loadQrLib() {
        if (typeof window.qrcode === 'function') return Promise.resolve(window.qrcode);
        if (!qrLibPromise) qrLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/qrcode-generator/qrcode.js';
            s.onload = () => (typeof window.qrcode === 'function' ? resolve(window.qrcode) : reject(new Error('qrcode fehlt')));
            s.onerror = () => { qrLibPromise = null; reject(new Error('qrcode nicht ladbar')); };
            document.head.appendChild(s);
        });
        return qrLibPromise;
    }
    // Zeichnet dunkle Module auf weißen Grund (auch im Dark Mode – Kameras brauchen Kontrast + Ruhezone).
    function drawQr(canvas, text, qrcodeFn) {
        const qr = qrcodeFn(0, 'L');
        qr.addData(text, 'Byte');
        qr.make();
        const n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const scale = Math.max(1, Math.floor((240 * dpr) / total));
        canvas.width = canvas.height = total * scale;
        canvas.style.width = canvas.style.height = Math.round(total * scale / dpr) + 'px';
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#111';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
            if (qr.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }

    // ── Teilen-Dialog ──
    let dlg = null, currentLink = '', buildSeq = 0;
    function ensureDialog() {
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.id = 'modal-share';
        dlg.setAttribute('aria-labelledby', 'modal-share-title');
        dlg.innerHTML = `
        <h3 id="modal-share-title">Reise teilen</h3>
        <div class="dialog-body">
            <p class="share-intro">Mitreisende öffnen den Link und übernehmen deinen Planungsstand – ohne Konto und ohne Server.</p>
            <label class="share-check"><input type="checkbox" id="share-journal"> Tagebuch mitsenden</label>
            <label class="share-check"><input type="checkbox" id="share-notes" checked> Notizen zu Aktivitäten mitsenden</label>
            <div class="share-qr" id="share-qr" hidden><canvas id="share-qr-canvas" role="img" aria-label="QR-Code mit dem Teilen-Link"></canvas></div>
            <p class="share-info" id="share-info" aria-live="polite"></p>
            <div class="form-group"><label for="share-link">Link</label><input type="text" id="share-link" readonly spellcheck="false"></div>
            <div class="btn-row share-btns">
                <button type="button" class="btn-icon" id="share-btn-copy"><i class="ph-light ph-copy" aria-hidden="true"></i> Link kopieren</button>
                <button type="button" class="btn-icon" id="share-btn-file"><i class="ph-light ph-file-arrow-up" aria-hidden="true"></i> Als Datei teilen</button>
            </div>
            <p class="share-privacy"><i class="ph-light ph-shield-check" aria-hidden="true"></i> <span><strong>Datenschutz:</strong> Die Reisedaten werden in deinem Browser verschlüsselt, bevor sie hochgeladen werden. Der Schlüssel steckt nur im Teil hinter „#“ des Links und wird nie an einen Server geschickt – der Server speichert nur unlesbaren Chiffretext für 30 Tage. Wer den Link hat, kann die Daten lesen.</span></p>
            <p class="share-note">Kein Live-Abgleich: Spätere Änderungen bitte erneut teilen. Beim Öffnen ersetzt der Link die Reisedaten der Empfänger (vorher wird automatisch gesichert).</p>
        </div>
        <div class="dialog-actions">
            <button type="button" class="btn" id="share-btn-link">Link teilen</button>
            <button type="button" class="btn btn-secondary" onclick="this.closest('dialog').close()">Schließen</button>
        </div>`;
        document.body.appendChild(dlg);
        const $ = id => dlg.querySelector('#' + id);
        $('share-journal').addEventListener('change', refreshLink);
        $('share-notes').addEventListener('change', refreshLink);
        $('share-link').addEventListener('focus', e => e.target.select());
        $('share-btn-copy').addEventListener('click', copyLink);
        $('share-btn-file').addEventListener('click', shareFile);
        $('share-btn-link').addEventListener('click', () => (navigator.share ? shareLink() : copyLink()));
        if (!navigator.share) $('share-btn-link').textContent = 'Link kopieren';
        return dlg;
    }
    const opts = () => ({ journal: dlg.querySelector('#share-journal').checked, notes: dlg.querySelector('#share-notes').checked });

    async function refreshLink() {
        const seq = ++buildSeq;
        const info = dlg.querySelector('#share-info'), input = dlg.querySelector('#share-link'), qrBox = dlg.querySelector('#share-qr');
        const linkBtns = [dlg.querySelector('#share-btn-copy'), dlg.querySelector('#share-btn-link')];
        currentLink = ''; input.value = ''; qrBox.hidden = true;
        if (!canCompress) {
            info.textContent = 'Dieser Browser kann keine Teilen-Links erstellen – bitte „Als Datei teilen“ nutzen.';
            linkBtns.forEach(b => { b.disabled = true; });
            return;
        }
        info.textContent = 'Link wird erstellt…';
        let link, short = false;
        try {
            const payload = buildPayload(opts());
            try { link = await buildShortLink(payload); short = true; } catch (e) { link = await buildLink(payload); }
        } catch (e) {
            if (seq !== buildSeq) return;
            info.textContent = '⚠️ Link konnte nicht erstellt werden – bitte „Als Datei teilen“ nutzen.';
            linkBtns.forEach(b => { b.disabled = true; });
            return;
        }
        if (seq !== buildSeq) return; // Checkbox wurde inzwischen erneut geändert
        currentLink = link; input.value = link;
        linkBtns.forEach(b => { b.disabled = false; });
        const len = link.length.toLocaleString('de-DE');
        if (link.length > QR_MAX_LEN) {
            info.textContent = `Kurzlink nicht verfügbar (offline?) – der lange Link hat ${len} Zeichen und ist zu lang für einen QR-Code. Bitte Link oder Datei teilen.`;
            return;
        }
        info.textContent = short ? `Kurzlink zum Scannen mit der Handykamera · 30 Tage gültig` : `Zum Scannen mit der Handykamera · ${len} Zeichen (Kurzlink nicht verfügbar)`;
        try {
            const fn = await loadQrLib();
            if (seq !== buildSeq) return;
            drawQr(dlg.querySelector('#share-qr-canvas'), link, fn);
            qrBox.hidden = false;
        } catch (e) {
            if (seq === buildSeq) info.textContent = `QR-Code nicht verfügbar – bitte Link teilen · ${len} Zeichen`;
        }
    }

    async function shareLink() {
        if (!currentLink) return;
        try {
            await navigator.share({ title: 'Reise: ' + ((typeof tripName === 'string' && tripName) || 'Reise'),
                text: 'Unsere Reiseplanung – Link öffnen, um sie in den Reiseplaner zu übernehmen:', url: currentLink });
            haptic();
        } catch (e) { if (e && e.name !== 'AbortError') copyLink(); }
    }
    async function copyLink() {
        if (!currentLink) return;
        try { await navigator.clipboard.writeText(currentLink); haptic(); showToast('📋 Link kopiert'); }
        catch (e) {
            const input = dlg.querySelector('#share-link'); input.focus(); input.select();
            let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {}
            showToast(ok ? '📋 Link kopiert' : 'Bitte den markierten Link manuell kopieren.');
        }
    }
    async function shareFile() {
        const payload = buildPayload(opts());
        const json = JSON.stringify(payload, null, 2);
        const slug = payload.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'reise';
        const name = `trip-planer-${slug}-${todayISO()}.json`;
        let file = null;
        try { file = new File([json], name, { type: 'application/json' }); } catch (e) {}
        if (file && navigator.canShare?.({ files: [file] })) {
            try { await navigator.share({ files: [file], title: 'Reise: ' + payload.label }); haptic(); return; }
            catch (e) { if (e && e.name === 'AbortError') return; }
        }
        // Fallback: herunterladen – Empfänger nutzen „Wiederherstellen“ im Menü.
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast('⬇️ Datei heruntergeladen – Empfänger nutzen „Wiederherstellen“ im Menü', 4000);
    }

    function openShareDialog() {
        if (typeof toggleMenu === 'function') toggleMenu(false);
        ensureDialog();
        dlg.querySelector('#share-btn-file').hidden = false;
        refreshLink();
        dlg.showModal();
    }

    // ── Empfangen: #import=… auswerten ──
    function clearHash() {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
    async function decodeShared(enc) {
        if (!enc || enc.length > MAX_HASH_LEN) throw new Error('Länge');
        return parseShared(await inflateLimited(b64urlToBytes(enc), MAX_INFLATED));
    }
    function parseShared(text) {
        const payload = JSON.parse(text);
        const data = validateBackup(payload);
        if (!data) throw new Error('Ungültig');
        return { payload, data };
    }
    function countJson(str, pick) {
        try { const v = JSON.parse(str); const x = pick ? pick(v) : v; return Array.isArray(x) ? x.length : 0; } catch (e) { return 0; }
    }
    let importDlg = null;
    function showImportConfirm(payload, data) {
        if (!importDlg) {
            importDlg = document.createElement('dialog');
            importDlg.id = 'modal-share-import';
            importDlg.setAttribute('aria-labelledby', 'modal-share-import-title');
            document.body.appendChild(importDlg);
        }
        const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim().slice(0, 80) : 'Geteilte Reise';
        const places = countJson(data.tp_places), acts = countJson(data.tp_acts),
            costs = countJson(data.tp_budget, b => b && b.entries), journal = data.tp_journal ? countJson(data.tp_journal) : null;
        let start = '';
        if (data.tp_start) { const d = new Date(data.tp_start); if (!isNaN(d)) start = d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }); }
        const row = (icon, text) => `<li><i class="ph-light ph-${icon}" aria-hidden="true"></i> ${esc(text)}</li>`;
        importDlg.innerHTML = `
        <h3 id="modal-share-import-title">Geteilte Reise übernehmen?</h3>
        <div class="dialog-body">
            <p class="share-import-name">„${esc(label)}“</p>
            <ul class="share-import-list">
                ${start ? row('calendar-blank', 'Start: ' + start) : ''}
                ${row('map-pin', places + (places === 1 ? ' Station' : ' Stationen'))}
                ${row('star', acts + (acts === 1 ? ' Aktivität' : ' Aktivitäten'))}
                ${row('wallet', costs + (costs === 1 ? ' Ausgabe' : ' Ausgaben'))}
                ${journal === null ? row('notebook', 'Ohne Tagebuch – dein eigenes bleibt erhalten') : row('notebook', journal + ' Tagebuch-Einträge')}
            </ul>
            <p class="share-note">Deine aktuellen Reisedaten werden ersetzt. Vorher wird automatisch gesichert – über „Letzten Import rückgängig machen“ im Menü kommst du zurück.</p>
        </div>
        <div class="dialog-actions">
            <button type="button" class="btn" data-act="ok">Übernehmen</button>
            <button type="button" class="btn btn-secondary" data-act="cancel">Abbrechen</button>
        </div>`;
        const finish = ok => {
            importDlg.close();
            if (!ok) {
                showToast('Geteilte Reise nicht übernommen – nichts geändert.');
                if (localStorage.getItem('tp_onboarded') !== '1' && typeof openSettings === 'function') openSettings();
                return;
            }
            const merged = Object.assign({}, data);
            KEEP_LOCAL_KEYS.forEach(k => {
                if (merged[k] === undefined) { const v = localStorage.getItem(k); if (v !== null) merged[k] = v; }
            });
            replaceTripData(merged, 'Automatische Sicherung vor geteilter Reise', '✅ Geteilte Reise übernommen – App wird neu geladen…');
        };
        importDlg.querySelector('[data-act="ok"]').onclick = () => finish(true);
        importDlg.querySelector('[data-act="cancel"]').onclick = () => finish(false);
        importDlg.oncancel = e => { e.preventDefault(); finish(false); };
        // Onboarding-Einstellungen (Erststart) nicht über dem Bestätigungsdialog stehen lassen.
        document.querySelectorAll('dialog[open]').forEach(d => { if (d !== importDlg) d.close(); });
        importDlg.showModal();
    }
    let handling = false;
    async function handleImportHash() {
        const isShort = location.hash.startsWith(SHORT_PREFIX);
        if (handling || !(isShort || location.hash.startsWith(HASH_PREFIX))) return;
        handling = true;
        const enc = location.hash.slice((isShort ? SHORT_PREFIX : HASH_PREFIX).length);
        clearHash(); // nie erneut beim Neuladen auswerten
        try {
            if (!canCompress) { showToast('⚠️ Dieser Browser kann geteilte Links nicht öffnen – bitte als Datei teilen lassen.', 5000); return; }
            let res;
            try { res = isShort ? parseShared(await fetchShort(enc)) : await decodeShared(enc); } catch (e) {
                showToast(e && e.message === 'Abgelaufen' ? '⚠️ Dieser Teilen-Link ist abgelaufen oder nicht mehr vorhanden – nichts geändert.'
                    : e && /^Server|Failed to fetch|NetworkError|Load failed/.test(e.message) ? '⚠️ Keine Verbindung zum Server – bitte online erneut öffnen.'
                    : e && e.message === 'Zu groß' ? '⚠️ Geteilte Daten sind zu groß – nichts geändert.' : '⚠️ Ungültiger oder beschädigter Teilen-Link – nichts geändert.', 5000);
                return;
            }
            showImportConfirm(res.payload, res.data);
        } finally { handling = false; }
    }

    // ── Einhängen: Menü-Button + Link-Auswertung ──
    function injectMenuButton() {
        if (document.getElementById('btnShareTrip')) return;
        const row = document.querySelector('.menu-footer .btn-row');
        if (!row) return;
        const btn = document.createElement('button');
        btn.type = 'button'; btn.id = 'btnShareTrip'; btn.className = 'btn-icon share-menu-btn';
        btn.innerHTML = '<i class="ph-light ph-share-network" aria-hidden="true"></i> Reise teilen';
        btn.addEventListener('click', openShareDialog);
        row.parentNode.insertBefore(btn, row);
    }
    function init() {
        injectMenuButton();
        // Nach dem App-Start (Onboarding-Dialog öffnet nach 400 ms) auswerten.
        if (location.hash.startsWith(HASH_PREFIX) || location.hash.startsWith(SHORT_PREFIX)) setTimeout(handleImportHash, 500);
    }
    window.addEventListener('hashchange', handleImportHash);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    window.featureShare = { open: openShareDialog, buildLink, buildShortLink, buildPayload, decodeShared, handleImportHash };
})();
