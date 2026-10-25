// Trip Planer – Google Drive Sync (appDataFolder)
// Läuft komplett clientseitig, nutzt Google Identity Services.
// Synchronisiert die EXPORT_KEYS aus app.js, ohne API-Keys.
//
// Einrichtung:
// 1. Google Cloud Console -> OAuth Client ID für Web App anlegen
// 2. Authorized JavaScript origins: deine Domain / localhost
// 3. Scopes: https://www.googleapis.com/auth/drive.appdata
//
// Die Client-ID unten aus dem Service-Tracker übernommen. Falls du eine
// separate ID für Trip Planer nutzt, ersetze sie hier.

(function () {
'use strict';

const TP_SYNC_CLIENT_ID = '892793329409-u0v9ku7011acd7vss7imbumcrbgjmlhr.apps.googleusercontent.com';

// Konfiguration
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'trip-planer-sync.json';
const META_KEY = 'tp_sync_meta';   // {enabled, fileId, lastSync}
const TOKEN_KEY = 'tp_sync_token'; // {token, exp}

// Drive API Endpunkte
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const METADATA = 'https://www.googleapis.com/drive/v3/files/';

// Lokaler State
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch { return {}; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const getMeta = () => read(META_KEY);
const setMeta = (patch) => write(META_KEY, Object.assign(getMeta(), patch));

const getToken = () => {
  const t = read(TOKEN_KEY);
  return t.token && t.exp > Date.now() ? t.token : null;
};
const setToken = (token, expiresIn) => write(TOKEN_KEY, { token, exp: Date.now() + (expiresIn * 1000) - 5000 });

// EXPORT_KEYS aus app.js – hier dupliziert, damit sync.js standalone ist
const EXPORT_KEYS = [
  'tp_places','tp_acts','tp_budget','tp_journal','tp_pack',
  'tp_start','tp_tripname','tp_tripcountry','tp_tripcountry_manual','tp_return','tp_arrival',
  'tp_theme','tp_fx_ccy','tp_emergency'
];

// App-Version aus app.js lesen (global)
const APP_VERSION = window.APP_VERSION || 'unknown';

// Payload zusammenbauen
function buildPayload() {
  const data = {};
  EXPORT_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  return {
    app: 'trip-planer',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data
  };
}

// Payload aus Datei laden
function applyPayload(payload) {
  if (!payload || payload.app !== 'trip-planer' || !payload.data) return false;
  // Nur bekannte Keys schreiben
  Object.keys(payload.data).forEach(k => {
    if (EXPORT_KEYS.includes(k)) {
      localStorage.setItem(k, payload.data[k]);
    }
  });
  // UI nachladen
  if (typeof saveData === 'function') saveData();
  return true;
}

// Google GIS laden
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('GIS konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}

// Token anfordern
async function requestToken() {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: TP_SYNC_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) {
          setToken(resp.access_token, resp.expires_in || 3600);
          resolve(resp.access_token);
        } else {
          reject(new Error(resp?.error || 'Auth fehlgeschlagen'));
        }
      },
      error_callback: (e) => reject(new Error(e?.type || 'Auth abgebrochen'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

// Drive Wrapper
async function drive(url, opts = {}) {
  let token = getToken();
  if (!token) token = await requestToken();
  const r = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers)
  }));
  if (r.status === 401) {
    // Token ungültig
    localStorage.removeItem(TOKEN_KEY);
    token = await requestToken();
    const r2 = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers)
    }));
    return r2;
  }
  return r;
}

// Datei finden
async function findFileId() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await drive(`${API}?q=${q}&spaces=appDataFolder&fields=files(id,name)`);
  if (!r.ok) {
    const detail = await r.json().then(j => j?.error?.message).catch(() => '');
    throw new Error('Drive abfrage fehlgeschlagen (' + r.status + ')' + (detail ? ': ' + detail : ''));
  }
  const j = await r.json();
  return j.files && j.files[0] ? j.files[0].id : null;
}

// Datei hochladen / aktualisieren
async function uploadFile(payload) {
  const meta = getMeta();
  const body = JSON.stringify(payload);
  const fileId = meta.fileId;

  const metadata = { name: FILE_NAME };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: FILE_NAME })], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));

  if (fileId) {
    // Update
    const r = await drive(`${UPLOAD}/${fileId}?uploadType=multipart`, {
      method: 'PATCH',
      body: form
    });
    if (!r.ok) throw new Error('Update fehlgeschlagen');
    return fileId;
  } else {
    // Create
    const r = await drive(`${UPLOAD}?uploadType=multipart`, {
      method: 'POST',
      body: form
    });
    if (!r.ok) throw new Error('Erstellen fehlgeschlagen');
    const j = await r.json();
    setMeta({ fileId: j.id });
    return j.id;
  }
}

// Datei herunterladen
async function downloadFile(fileId) {
  const r = await drive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if (!r.ok) throw new Error('Download fehlgeschlagen');
  return await r.json();
}

// Sync durchführen
async function syncNow({ interactive = false } = {}) {
  if (!TP_SYNC_CLIENT_ID) throw new Error('Client-ID nicht gesetzt');

  const meta = getMeta();
  let fileId = meta.fileId;

  if (!fileId) {
    fileId = await findFileId();
    if (fileId) setMeta({ fileId });
  }

  // Lokalen Stand hochladen
  const localPayload = buildPayload();

  if (fileId) {
    // Remote laden
    const remote = await downloadFile(fileId);

    // Konfliktlösung: neueres exportedAt gewinnt
    const localTime = new Date(localPayload.exportedAt).getTime();
    const remoteTime = new Date(remote.exportedAt).getTime();

    if (remoteTime > localTime) {
      // Remote ist neuer -> übernehmen
      if (interactive) {
        const ok = confirm('Remote-Daten sind neuer. Überschreiben?');
        if (ok) {
          applyPayload(remote);
          setMeta({ lastSync: new Date().toISOString() });
          return { action: 'pulled' };
        }
      } else {
        applyPayload(remote);
        setMeta({ lastSync: new Date().toISOString() });
        return { action: 'pulled' };
      }
    } else {
      // Lokal ist neuer oder gleich -> hochladen
      await uploadFile(localPayload);
      setMeta({ lastSync: new Date().toISOString() });
      return { action: 'pushed' };
    }
  } else {
    // Keine Datei -> erstellen
    await uploadFile(localPayload);
    setMeta({ lastSync: new Date().toISOString() });
    return { action: 'created' };
  }
}

// UI Helper
function syncStatusText() {
  const meta = getMeta();
  if (!meta.enabled) return 'Sync deaktiviert';
  if (!meta.lastSync) return 'Noch nicht synchronisiert';
  return 'Zuletzt: ' + new Date(meta.lastSync).toLocaleString('de-DE');
}

// Öffentliche API
window.TripPlannerSync = {
  init: async () => {
    // Sync auf Änderungen planen
    setInterval(() => {
      if (getMeta().enabled) syncNow().catch(() => {});
    }, 90000);
  },
  connect: async () => {
    try {
      await requestToken();
      setMeta({ enabled: true });
      await syncNow({ interactive: true });
      if (typeof showToast === 'function') showToast('Mit Google Drive verbunden', 'ok');
    } catch (e) {
      if (typeof showToast === 'function') showToast('Verbindung fehlgeschlagen: ' + e.message, 'err');
    }
  },
  disconnect: () => {
    setMeta({ enabled: false, fileId: null });
    localStorage.removeItem(TOKEN_KEY);
    if (typeof showToast === 'function') showToast('Sync getrennt', 'ok');
  },
  syncNow,
  statusText: syncStatusText,
  isEnabled: () => !!getMeta().enabled
};
})();
