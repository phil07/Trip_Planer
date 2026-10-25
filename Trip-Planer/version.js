// Single source of truth for the app version.
// Bump this ONE value per release – sw.js (cache name) and app.js (menu display)
// both derive from it. Loaded in the window (before app.js) and in the service
// worker (via importScripts).
self.APP_VERSION = 'v215';
