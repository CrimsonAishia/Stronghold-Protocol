// Classic service worker for art a player imported on this origin.
// Keep these three lines in sync with public/js/assetCache.js (that module documents why this file is not a module).
const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';
const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';
const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;
const RELEASE_ASSET_CACHE = 'sp-release-assets-v1';
const RELEASE_ASSET_CACHE_PREFIX = 'sp-release-assets-';

function releaseAssetCache(version) {
  if (!version) return RELEASE_ASSET_CACHE;
  const v = String(version).trim();
  const suffix = v.startsWith('v') ? v : `v${v}`;
  return `${RELEASE_ASSET_CACHE_PREFIX}${encodeURIComponent(suffix)}`;
}

const DB_NAME = 'sp_worker_state';
const STORE_NAME = 'client_versions';

function openStateDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'clientId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveClientVersionToDb(clientId, version) {
  const db = await openStateDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store['put']({ clientId, version, at: Date.now() });
  } catch { /* ignore */ }
}

async function getClientVersionFromDb(clientId) {
  const db = await openStateDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(clientId);
      req.onsuccess = () => resolve(req.result?.version || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let activeVersion = null;
const clientVersions = new Map();
self.addEventListener('message', (event) => {
  if (event.data && typeof event.data === 'object') {
    if (event.data.type === 'SET_VERSION' && event.data.version) {
      const ver = String(event.data.version).trim();
      if (event.source?.id) {
        clientVersions.set(event.source.id, ver);
        void saveClientVersionToDb(event.source.id, ver);
      }
      activeVersion = ver;
    }
  }
});

function getCookieVersion(request) {
  try {
    const cookie = request.headers?.get?.('cookie') || '';
    const match = cookie.match(/(?:^|;\s*)sp_version=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function parseVersionParts(name) {
  const clean = name.replace(/^sp-release-assets-/, '').replace(/^v/, '');
  return clean.split(/[-._]/).map((part) => {
    const num = parseInt(part, 10);
    return Number.isNaN(num) ? part : num;
  });
}

function compareVersionsDesc(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return vb - va;
    } else {
      const sa = String(va);
      const sb = String(vb);
      if (sa !== sb) return sb.localeCompare(sa);
    }
  }
  return b.localeCompare(a);
}

function releaseCacheNames(names, activeVer) {
  if (activeVer) {
    const target = releaseAssetCache(activeVer);
    return names.includes(target) ? [target] : [target];
  }
  const versionCaches = names
    .filter((name) => name.startsWith(RELEASE_ASSET_CACHE_PREFIX))
    .sort(compareVersionsDesc);
  if (versionCaches.length) return [versionCaches[0]];
  return [RELEASE_ASSET_CACHE];
}
// Optional server configuration; a plain static host keeps its original same-origin behavior.
try { importScripts('/asset-cdn.js'); } catch { /* optional configuration */ }

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  // A cache-only probe (resourceCheck.js) must reach the browser HTTP cache. respondWith, even with 504, hides
  // that cache. Leaving the event unanswered lets a hit return and a miss reject, with no network. Cache Storage
  // is already decided by the page's caches.match before this probe.
  if (request.cache === 'only-if-cached') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin && url.origin !== self.__SP_ASSET_CDN__) return;
  if (!IMPORTED_ASSET_PATH.test(url.pathname)) {
    if (!/^\/(?:assets|fonts|media)\//.test(url.pathname)) return;
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(request);
        if (response.ok && !/text\/html/i.test(response.headers.get('content-type') || '')) return response;
      } catch { /* Try the verified release cache. */ }
      const names = caches.keys ? await caches.keys() : [];
      let ver = event.clientId ? clientVersions.get(event.clientId) : null;
      if (!ver && event.clientId) {
        ver = await getClientVersionFromDb(event.clientId);
        if (ver) clientVersions.set(event.clientId, ver);
      }
      if (!ver) {
        ver = getCookieVersion(request) || activeVersion;
      }
      const cacheNames = releaseCacheNames(names, ver);
      for (const name of cacheNames) {
        try {
          const cache = await caches.open(name);
          const hit = await cache.match(self.location.origin + url.pathname);
          if (hit) return hit;
        } catch { /* Try next cache */ }
      }
      return response || Response.error();
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(IMPORTED_ASSET_CACHE);
    // The exact key: an import stores each URL without a query, so the path is the key. `ignoreSearch` would make
    // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
    const hit = await cache.match(self.location.origin + url.pathname);
    if (hit) return hit;
    // Do not cache the network response. The browser's own HTTP cache still applies to this fetch.
    return fetch(request);
  })());
});
