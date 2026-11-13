// Trip Planer – Google Drive Sync (appDataFolder)
// Läuft komplett clientseitig, nutzt Google Identity Services.
// Jede Reise hat eine eigene Datei im App-Ordner:
//   Hauptreise: trip-planer-sync.json (bisherige Datei bleibt erhalten)
//   weitere:    trip-planer-<id>.json
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
const FILE_PREFIX = 'trip-planer-';
const MAIN_FILE_NAME = 'trip-planer-sync.json';
const META_KEY = 'tp_sync_meta';   // {enabled, lastSync, fileIds, remoteSeen, syncedHash}
const TOKEN_KEY = 'tp_sync_token'; // {token, exp}
const TRIPS_KEY = 'tp_trips';      // Reiseliste aus app.js
const ACTIVE_KEY = 'tp_active_trip';
const SNAP_PREFIX = 'tp_trip_data:';

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

// Reisedaten-Schlüssel aus app.js – hier dupliziert, damit sync.js standalone ist
const EXPORT_KEYS = [
  'tp_places','tp_acts','tp_budget','tp_journal','tp_pack',
  'tp_start','tp_tripname','tp_tripcountry','tp_tripcountry_manual','tp_return','tp_arrival',
  'tp_theme','tp_fx_ccy','tp_emergency','tp_daily_budget'
];

// App-Version aus app.js lesen (global)
const APP_VERSION = window.APP_VERSION || 'unknown';

const activeTripId = () => localStorage.getItem(ACTIVE_KEY) || 'main';
const fileNameFor = (tripId) => tripId === 'main' ? MAIN_FILE_NAME : FILE_PREFIX + tripId + '.json';
function tripIdFromFileName(name) {
  if (name === MAIN_FILE_NAME) return 'main';
  const m = /^trip-planer-(.+)\.json$/.exec(name);
  return m ? m[1] : null;
}

// Payload zusammenbauen (Daten der aktiven Reise)
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

// Fingerabdruck der Daten: zeigt, ob sich etwas geändert hat
function hashData(data) {
  const s = JSON.stringify(Object.keys(data).sort().map(k => [k, data[k]]));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return String(h);
}

// Payload in die aktive Reise schreiben
function applyPayload(payload) {
  if (typeof validateBackup !== 'function') return false;
  // Gleiche Prüfung wie beim Import: Typen, bekannte Keys, Format
  const data = validateBackup(payload);
  if (!data) return false;
  Object.keys(data).forEach(k => localStorage.setItem(k, data[k]));
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
// Meldungen als Schnellmeldung oben (showResultToast in index.html). Die Fuß-Leiste (#toast)
// liegt im geöffneten Menü unter der Oberfläche und bleibt dort unsichtbar.
function notify(msg, variant) {
  if (typeof window.showResultToast === 'function') window.showResultToast(msg, variant);
  else if (typeof showToast === 'function') showToast(msg);
}
// In der Android-App über den nativen Google-Login (native/login.js), im Browser über GIS.
function loadNativeLogin() {
  if (window.tpNativeLogin) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/native-login.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Anmelde-Modul konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}
async function requestToken() {
  if (window.Capacitor?.isNativePlatform?.()) {
    const say = msg => notify(msg, 'ok');
    say('Anmeldung: Modul wird geladen …');
    await loadNativeLogin();
    say('Anmeldung: Google wird geöffnet …');
    // Ohne Antwort nach 25 Sekunden abbrechen, damit nie „nichts passiert“.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('keine Antwort von Google nach 25 s')), 25000));
    const token = await Promise.race([window.tpNativeLogin.accessToken(SCOPE, TP_SYNC_CLIENT_ID), timeout]);
    say('Anmeldung: Zugriff erhalten');
    setToken(token, 3600);
    return token;
  }
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

// Fehler mit HTTP-Status und Googles Begründung
async function driveError(r, what) {
  const detail = await r.json().then(j => j?.error?.message).catch(() => '');
  return new Error(what + ' fehlgeschlagen (' + r.status + ')' + (detail ? ': ' + detail : ''));
}

// Datei im App-Ordner suchen
async function findFile(name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const r = await drive(`${API}?q=${q}&spaces=appDataFolder&fields=files(id,name,modifiedTime)`);
  if (!r.ok) throw await driveError(r, 'Drive abfrage');
  const j = await r.json();
  return j.files && j.files[0] ? j.files[0] : null;
}

// Änderungszeit einer Datei
async function fileModified(fileId) {
  const r = await drive(`${METADATA}${fileId}?fields=modifiedTime`);
  if (!r.ok) throw await driveError(r, 'Drive abfrage');
  return (await r.json()).modifiedTime;
}

// Datei herunterladen
async function downloadFile(fileId) {
  const r = await drive(`${METADATA}${fileId}?alt=media`);
  if (!r.ok) throw await driveError(r, 'Download');
  return await r.json();
}

// Datei anlegen oder aktualisieren
async function writeFile(tripId, payload, fileId) {
  const body = JSON.stringify(payload);
  const fields = '&fields=id,modifiedTime';
  if (fileId) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: fileNameFor(tripId) })], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));
    const r = await drive(`${UPLOAD}/${fileId}?uploadType=multipart${fields}`, { method: 'PATCH', body: form });
    if (!r.ok) throw await driveError(r, 'Update');
    return await r.json();
  }
  // Create: ohne parents landet die Datei außerhalb des App-Ordners, und
  // drive.appdata darf dort nicht schreiben (403 "insufficient permissions").
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: fileNameFor(tripId), parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));
  const r = await drive(`${UPLOAD}?uploadType=multipart${fields}`, { method: 'POST', body: form });
  if (!r.ok) throw await driveError(r, 'Erstellen');
  return await r.json();
}

// Merkt sich pro Reise: Datei-ID, zuletzt gesehene Änderungszeit in Drive, Fingerabdruck
function rememberFile(tripId, fileId, modifiedTime, data) {
  const m = getMeta();
  setMeta({
    fileIds: Object.assign({}, m.fileIds, { [tripId]: fileId }),
    remoteSeen: Object.assign({}, m.remoteSeen, { [tripId]: modifiedTime }),
    syncedHash: Object.assign({}, m.syncedHash, { [tripId]: hashData(data) }),
    lastSync: new Date().toISOString()
  });
}

async function pullRemote(tripId, fileId, remoteModified, remote) {
  if (!applyPayload(remote)) throw new Error('Ungültige Datei in Google Drive');
  rememberFile(tripId, fileId, remoteModified, buildPayload().data);
  return { action: 'pulled' };
}

async function pushLocal(tripId, fileId, local) {
  const updated = await writeFile(tripId, local, fileId);
  rememberFile(tripId, fileId, updated.modifiedTime, local.data);
  return { action: 'pushed' };
}

// Sync der aktiven Reise
async function syncNow({ interactive = false } = {}) {
  if (!TP_SYNC_CLIENT_ID) throw new Error('Client-ID nicht gesetzt');

  const tripId = activeTripId();
  const m = getMeta();
  const local = buildPayload();
  const localHash = hashData(local.data);
  // Ohne gemerkten Fingerabdruck weiß die App nicht, was sich geändert hat -> als geändert behandeln
  const localChanged = (m.syncedHash || {})[tripId] !== localHash;

  let fileId = (m.fileIds || {})[tripId] || null;
  if (!fileId) {
    const found = await findFile(fileNameFor(tripId));
    if (!found) {
      const created = await writeFile(tripId, local, null);
      rememberFile(tripId, created.id, created.modifiedTime, local.data);
      return { action: 'created' };
    }
    fileId = found.id;
  }

  const remoteModified = await fileModified(fileId);
  const remoteChanged = (m.remoteSeen || {})[tripId] !== remoteModified;

  if (!remoteChanged && !localChanged) return { action: 'unchanged' };
  if (!remoteChanged) return pushLocal(tripId, fileId, local);

  const remote = await downloadFile(fileId);
  if (!localChanged) return pullRemote(tripId, fileId, remoteModified, remote);

  // Beide Seiten geändert: sind die Stände gleich, ist nichts zu tun
  if (hashData(remote.data || {}) === localHash) {
    rememberFile(tripId, fileId, remoteModified, local.data);
    return { action: 'unchanged' };
  }

  if (interactive) {
    const useDrive = confirm(
      'Auf diesem Gerät und in Google Drive gibt es unterschiedliche Stände.\n\n' +
      'OK: Stand aus Google Drive übernehmen\n' +
      'Abbrechen: diesen Stand nach Google Drive hochladen'
    );
    return useDrive ? pullRemote(tripId, fileId, remoteModified, remote) : pushLocal(tripId, fileId, local);
  }
  throw new Error('Unterschiedliche Stände. Bitte „Jetzt synchronisieren“ antippen.');
}

// Reisen übernehmen, die es nur in Drive gibt (z. B. auf einem neuen Gerät)
async function importRemoteTrips() {
  const q = encodeURIComponent(`name contains '${FILE_PREFIX}' and trashed=false`);
  const r = await drive(`${API}?q=${q}&spaces=appDataFolder&fields=files(id,name,modifiedTime)`);
  if (!r.ok) throw await driveError(r, 'Drive abfrage');
  const files = (await r.json()).files || [];

  let trips = [];
  try { trips = JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]') || []; } catch (e) {}
  const known = new Set(trips.map(t => t.id));

  let count = 0;
  for (const f of files) {
    const tripId = tripIdFromFileName(f.name);
    if (!tripId || known.has(tripId)) continue;
    const remote = await downloadFile(f.id);
    if (!remote || remote.app !== 'trip-planer' || !remote.data) continue;
    const name = (remote.data.tp_tripname || '').trim() || 'Reise aus Drive';
    trips.push({ id: tripId, name, created: remote.exportedAt || new Date().toISOString() });
    // Der Stand aus Drive wird der gespeicherte Stand dieser Reise
    localStorage.setItem(SNAP_PREFIX + tripId, JSON.stringify(remote.data));
    rememberFile(tripId, f.id, f.modifiedTime, remote.data);
    known.add(tripId);
    count++;
  }
  if (count) localStorage.setItem(TRIPS_KEY, JSON.stringify(trips));
  return count;
}

// Datei einer Reise in Drive löschen (beim Löschen der Reise)
async function deleteRemote(tripId) {
  const m = getMeta();
  const fileId = (m.fileIds || {})[tripId];
  if (!fileId) return;
  const r = await drive(`${METADATA}${fileId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw await driveError(r, 'Löschen');
  const fileIds = Object.assign({}, m.fileIds);
  const remoteSeen = Object.assign({}, m.remoteSeen);
  const syncedHash = Object.assign({}, m.syncedHash);
  delete fileIds[tripId]; delete remoteSeen[tripId]; delete syncedHash[tripId];
  setMeta({ fileIds, remoteSeen, syncedHash });
}

// Alte Einzeldatei aus Stufe 1 in die neue Struktur übernehmen
(function migrateMeta() {
  const m = getMeta();
  if (m.fileId) {
    setMeta({ fileIds: Object.assign({ main: m.fileId }, m.fileIds), fileId: null });
  }
})();

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
      if (getMeta().enabled) syncNow().then(() => importRemoteTrips()).then(n => {
        if (n && typeof window.tripsOpenRender === 'function') window.tripsOpenRender();
      }).catch(() => {});
    }, 90000);
  },
  connect: async () => {
    try {
      await requestToken();
      setMeta({ enabled: true });
      await syncNow({ interactive: true });
      const n = await importRemoteTrips();
      notify(n ? 'Mit Google Drive verbunden, ' + n + ' Reise(n) übernommen' : 'Mit Google Drive verbunden', 'ok');
      if (n && typeof window.tripsOpenRender === 'function') window.tripsOpenRender();
    } catch (e) {
      notify('Verbindung fehlgeschlagen: ' + e.message, 'err');
    }
  },
  disconnect: () => {
    setMeta({ enabled: false });
    localStorage.removeItem(TOKEN_KEY);
    notify('Sync getrennt', 'ok');
  },
  syncNow,
  importRemoteTrips,
  deleteRemote,
  statusText: syncStatusText,
  isEnabled: () => !!getMeta().enabled
};
})();
