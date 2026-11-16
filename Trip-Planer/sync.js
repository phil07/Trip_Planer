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

// Verschlüsselung (features/vault.js): Tresor-Datei mit Salt + Prüfwert, Dokumente als eigene Dateien.
// Beide Namen beginnen bewusst nicht mit FILE_PREFIX, damit sie nie als Reise gelesen werden.
const VAULT_FILE = 'tp-vault.json';
const DOC_PREFIX = 'tp-doc-';
const DOC_BASE_PREFIX = 'tp_doc_synced:'; // pro Reise: { <docId>: { h, m, f } } – zuletzt abgeglichener Stand
const MOBILE_KEY = 'tp_doc_sync_mobile';  // '1' = Dokumente auch über mobile Daten übertragen
const vault = () => window.tripVault;
const hasKey = async () => !!(vault() && await vault().hasKey());

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
  'tp_places','tp_acts','tp_plan','tp_return_booking','tp_budget','tp_journal','tp_pack',
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

// Payload in die aktive Reise schreiben.
// Wichtig: Die App hält die Reisedaten im Arbeitsspeicher. Nach dem Schreiben wird deshalb neu geladen –
// ein saveData() an dieser Stelle würde den gerade geholten Stand sofort mit dem alten überschreiben.
let reloadPending = false;
function applyPayload(payload) {
  if (typeof validateBackup !== 'function') return false;
  // Gleiche Prüfung wie beim Import: Typen, bekannte Keys, Format
  const data = validateBackup(payload);
  if (!data) return false;
  const current = snapshotTripData();
  // Bisherigen Stand sichern („Letzten Import rückgängig machen“), sofern er Stationen enthält
  let hadPlaces = false;
  try { hadPlaces = (JSON.parse(current.tp_places || '[]') || []).length > 0; } catch (e) {}
  if (hadPlaces) savePreImportBackup(current, 'Automatische Sicherung vor Cloud-Abgleich');
  if (!writeTripData(data, current)) return false;
  try { localStorage.setItem('tp_onboarded', '1'); } catch (e) {}
  reloadPending = true;
  return true;
}
function reloadIfPulled() {
  if (!reloadPending) return;
  reloadPending = false;
  notify('Stand aus Google Drive übernommen – App wird neu geladen …', 'ok');
  setTimeout(() => location.reload(), 700);
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

// Reisedaten vor dem Hochladen verschlüsseln, sobald ein Sync-Passwort eingerichtet ist.
async function sealPayload(payload) {
  if (!(await hasKey())) return payload;
  const box = await vault().encryptJson(payload.data);
  return { app: 'trip-planer', version: payload.version, exportedAt: payload.exportedAt, enc: 1, iv: box.iv, ct: box.ct };
}
async function openPayload(remote) {
  if (!remote || !remote.enc) return remote;
  if (!(await hasKey())) { const e = new Error('Die Cloud-Daten sind verschlüsselt. Bitte in den Einstellungen das Sync-Passwort eingeben.'); e.code = 'need-password'; throw e; }
  return { app: 'trip-planer', version: remote.version, exportedAt: remote.exportedAt, data: await vault().decryptJson(remote) };
}

// Rohinhalt einer Datei (leer = null, z. B. wenn ein früherer Upload abgebrochen ist)
async function downloadBytes(fileId) {
  const r = await drive(`${METADATA}${fileId}?alt=media`);
  if (!r.ok) throw await driveError(r, 'Download');
  const buf = new Uint8Array(await r.arrayBuffer());
  return buf.length ? buf : null;
}
async function downloadJson(fileId) {
  const buf = await downloadBytes(fileId);
  if (!buf) return null;
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return null; }
}
// Reisedatei herunterladen und bei Bedarf entschlüsseln
async function downloadFile(fileId) {
  return openPayload(await downloadJson(fileId));
}

// Datei anlegen oder aktualisieren: erst Metadaten (nur beim Anlegen), dann der Inhalt.
// Ohne parents landet die Datei außerhalb des App-Ordners, und drive.appdata darf dort nicht schreiben.
async function putFile(name, body, type, fileId) {
  if (!fileId) {
    const r = await drive(API + '?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: ['appDataFolder'] }) });
    if (!r.ok) throw await driveError(r, 'Erstellen');
    fileId = (await r.json()).id;
  }
  const r = await drive(`${UPLOAD}/${fileId}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
  if (!r.ok) throw await driveError(r, 'Hochladen');
  return await r.json();
}
async function writeFile(tripId, payload, fileId) {
  return putFile(fileNameFor(tripId), JSON.stringify(await sealPayload(payload)), 'application/json', fileId);
}
// Alle Dateien im App-Ordner, deren Name den Text enthält (mit Blättern)
async function listFiles(contains) {
  const q = encodeURIComponent(`name contains '${contains}' and trashed=false`);
  const out = [];
  let page = '';
  do {
    const r = await drive(`${API}?q=${q}&spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    if (!r.ok) throw await driveError(r, 'Drive abfrage');
    const j = await r.json();
    out.push(...(j.files || []));
    page = j.nextPageToken || '';
  } while (page);
  return out;
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
  reloadIfPulled();
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
  if (!remote || !remote.data) return pushLocal(tripId, fileId, local); // leere/kaputte Datei ersetzen
  if (!localChanged) return pullRemote(tripId, fileId, remoteModified, remote);

  // Beide Seiten geändert: sind die Stände gleich, ist nichts zu tun
  if (hashData(remote.data || {}) === localHash) {
    rememberFile(tripId, fileId, remoteModified, local.data);
    return { action: 'unchanged' };
  }

  // Neues/leeres Gerät: hier gibt es noch keine Stationen, in Drive schon -> ohne Rückfrage übernehmen
  const noPlaces = d => { try { return !(JSON.parse(d.tp_places || '[]') || []).length; } catch (e) { return true; } };
  if (noPlaces(local.data) && !noPlaces(remote.data)) return pullRemote(tripId, fileId, remoteModified, remote);

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
  const files = await listFiles(FILE_PREFIX);

  let trips = [];
  try { trips = JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]') || []; } catch (e) {}
  const known = new Set(trips.map(t => t.id));

  let count = 0;
  for (const f of files) {
    const tripId = tripIdFromFileName(f.name);
    if (!tripId || known.has(tripId)) continue;
    let remote = null;
    try { remote = await downloadFile(f.id); } catch (e) { if (e.code !== 'need-password' && e.code !== 'bad-key') throw e; }
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
  // Dokumente der Reise ebenfalls aus Drive entfernen
  try {
    for (const f of await listFiles(DOC_PREFIX + tripId + '-')) await drive(`${METADATA}${f.id}`, { method: 'DELETE' });
    localStorage.removeItem(DOC_BASE_PREFIX + tripId);
  } catch (e) {}
}

// ─── Verschlüsselung einrichten ──────────────────────────────────────────────
// Erstes Gerät: Passwort festlegen, Tresor-Datei anlegen, vorhandene Cloud-Daten verschlüsseln.
// Weiteres Gerät: Passwort eingeben und gegen die Tresor-Datei prüfen.
async function setupVault() {
  if (!vault() || !vault().supported()) throw new Error('Verschlüsselung wird von diesem Browser nicht unterstützt.');
  const found = await findFile(VAULT_FILE);
  const meta = found ? await downloadJson(found.id) : null;
  if (meta && meta.salt) {
    for (;;) {
      const pw = await vault().askPassword({ title: 'Sync-Passwort eingeben', action: 'Entsperren',
        hint: 'Deine Cloud-Daten sind verschlüsselt. Gib das Passwort ein, das du beim Einrichten festgelegt hast.' });
      if (!pw) return false;
      try { await vault().unlock(pw, meta); break; }
      catch (e) { notify(e.message, 'err'); }
    }
  } else {
    const pw = await vault().askPassword({ title: 'Sync-Passwort festlegen', action: 'Verschlüsselung einschalten', confirm: true,
      hint: 'Mit diesem Passwort werden Reisedaten und Dokumente verschlüsselt, bevor sie in Google Drive landen. Du brauchst es auf jedem weiteren Gerät. Wichtig: Vergisst du es, sind Cloud-Kopie und Backups nicht mehr lesbar.' });
    if (!pw) return false;
    const created = await vault().create(pw);
    await putFile(VAULT_FILE, JSON.stringify(created), 'application/json', found ? found.id : null);
  }
  await encryptRemoteTrips();
  return true;
}
// Alle noch unverschlüsselten Reisedateien in Drive durch verschlüsselte ersetzen.
async function encryptRemoteTrips() {
  const active = activeTripId();
  for (const f of await listFiles(FILE_PREFIX)) {
    const tripId = tripIdFromFileName(f.name);
    if (!tripId) continue;
    const raw = await downloadJson(f.id);
    if (!raw || raw.enc || raw.app !== 'trip-planer' || !raw.data) continue;
    const updated = await putFile(f.name, JSON.stringify(await sealPayload(raw)), 'application/json', f.id);
    // Die Datei hat sich nur in der Form geändert: als gesehen merken, damit kein unnötiger Abgleich folgt.
    const m = getMeta();
    if (tripId !== active && (m.remoteSeen || {})[tripId] === f.modifiedTime) {
      setMeta({ remoteSeen: Object.assign({}, m.remoteSeen, { [tripId]: updated.modifiedTime }) });
    }
  }
  // Aktive Reise: beim nächsten Abgleich neu bewerten
  const m = getMeta(), syncedHash = Object.assign({}, m.syncedHash);
  delete syncedHash[active];
  setMeta({ syncedHash });
}
// Nach dem Verbinden: gibt es schon einen Tresor in Drive, aber kein Passwort auf diesem Gerät, danach fragen.
async function ensureVaultKey() {
  if (!vault() || await hasKey()) return;
  const found = await findFile(VAULT_FILE);
  if (found) await setupVault();
}

// ─── Dokumente abgleichen (nur mit Sync-Passwort) ────────────────────────────
// Jedes Dokument ist eine eigene verschlüsselte Datei tp-doc-<Reise>-<Dokument>.bin.
// base merkt sich den zuletzt abgeglichenen Stand, damit Löschungen auf beiden Seiten erkannt werden.
const docsApi = () => window.documentsFeature && window.documentsFeature.sync;
const onMobileData = () => { const c = navigator.connection; return !!(c && (c.type === 'cellular' || c.saveData)); };
const docsAllowed = () => !onMobileData() || localStorage.getItem(MOBILE_KEY) === '1';
let docsRunning = null, docsAgain = false;
function syncDocs() {
  if (docsRunning) { docsAgain = true; return docsRunning; }
  docsRunning = syncDocsNow().finally(() => {
    docsRunning = null;
    if (docsAgain) { docsAgain = false; syncDocs().catch(() => {}); }
  });
  return docsRunning;
}
async function syncDocsNow() {
  const api = docsApi();
  if (!api || !getMeta().enabled || !(await hasKey())) return { skipped: 'off' };
  if (!docsAllowed()) { setMeta({ docsInfo: 'Dokumente warten auf WLAN' }); return { skipped: 'mobile' }; }
  const tripId = activeTripId(), prefix = DOC_PREFIX + tripId + '-';
  const baseKey = DOC_BASE_PREFIX + tripId;
  const base = read(baseKey);
  const local = new Map((await api.list()).map(d => [d.id, d.h]));
  const remote = new Map();
  (await listFiles(prefix)).forEach(f => { if (f.name.endsWith('.bin')) remote.set(f.name.slice(prefix.length, -4), f); });
  const next = {}, seen = new Set();
  let up = 0, down = 0, changedLocal = false, failed = 0;
  const upload = async (id, fileId) => {
    const d = await api.get(id);
    if (!d) return;
    const body = await vault().encryptBytes(await vault().packDoc(d));
    const r = await putFile(prefix + id + '.bin', body, 'application/octet-stream', fileId);
    next[id] = { h: local.get(id), m: r.modifiedTime, f: r.id };
    up++;
  };
  const download = async (id, f) => {
    const bytes = await downloadBytes(f.id);
    if (!bytes) return false;
    const { doc } = vault().unpackDoc(await vault().decryptBytes(bytes));
    doc.id = id;
    next[id] = { h: await api.put(doc), m: f.modifiedTime, f: f.id };
    down++; changedLocal = true;
    return true;
  };
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    if (activeTripId() !== tripId) break; // Reise gewechselt: abbrechen, nächster Lauf übernimmt
    seen.add(id);
    const b = base[id], f = remote.get(id), has = local.has(id);
    try {
      if (has && !f) {
        if (b) { await api.remove(id); changedLocal = true; }   // in der Cloud gelöscht
        else await upload(id, null);
      } else if (!has && f) {
        if (b) await drive(`${METADATA}${f.id}`, { method: 'DELETE' }); // hier gelöscht
        else if (!(await download(id, f))) await drive(`${METADATA}${f.id}`, { method: 'DELETE' }); // leere Datei aufräumen
      } else if (has && f) {
        if (!b || local.get(id) !== b.h) await upload(id, f.id);       // neu oder hier geändert
        else if (b.m !== f.modifiedTime) { if (!(await download(id, f))) await upload(id, f.id); } // in der Cloud geändert
        else next[id] = b;
      }
    } catch (e) {
      failed++;
      if (b) next[id] = b;
      console.warn('Dokument-Sync', id, e);
      if (e.code === 'need-password') throw e;
    }
  }
  Object.keys(base).forEach(id => { if (!seen.has(id) && !(id in next)) next[id] = base[id]; });
  write(baseKey, next);
  if (changedLocal) api.refresh();
  const n = Object.keys(next).length;
  setMeta({ docsInfo: failed ? `${failed} Dokument(e) nicht übertragen` : `${n} Dokument${n === 1 ? '' : 'e'} verschlüsselt gesichert` });
  return { up, down, failed };
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
  return 'Zuletzt: ' + new Date(meta.lastSync).toLocaleString('de-DE') + (meta.docsInfo ? ' · ' + meta.docsInfo : '');
}

let docsTimer = null;
// Öffentliche API
window.TripPlannerSync = {
  init: async () => {
    // Sync auf Änderungen planen
    setInterval(() => {
      if (getMeta().enabled) syncNow().then(() => importRemoteTrips()).then(n => {
        if (n && typeof window.tripsOpenRender === 'function') window.tripsOpenRender();
        return syncDocs();
      }).catch(() => {});
    }, 90000);
  },
  connect: async () => {
    try {
      if (!getToken()) await requestToken();
      setMeta({ enabled: true });
      await ensureVaultKey();
      await syncNow({ interactive: true });
      const n = await importRemoteTrips();
      syncDocs().catch(() => {});
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
  syncDocs,
  // Dokument hier geändert: kurz sammeln, dann abgleichen
  docsChanged: () => { clearTimeout(docsTimer); docsTimer = setTimeout(() => syncDocs().catch(() => {}), 4000); },
  setupVault,
  hasVaultKey: hasKey,
  docsOnMobile: () => localStorage.getItem(MOBILE_KEY) === '1',
  setDocsOnMobile: on => { on ? localStorage.setItem(MOBILE_KEY, '1') : localStorage.removeItem(MOBILE_KEY); if (on) syncDocs().catch(() => {}); },
  importRemoteTrips,
  deleteRemote,
  statusText: syncStatusText,
  isEnabled: () => !!getMeta().enabled
};
})();
