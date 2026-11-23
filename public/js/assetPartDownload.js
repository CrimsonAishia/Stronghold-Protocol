// Explicit multi-part asset download & verification for release distribution.
// Downloads segmented ZIP parts from Gitee Release (or configured CDN/mirror), verifies SHA-256,
// and streams them into Cache Storage via assetPack.js before unlocking lobby entrance.

import { APP_VERSION } from '../../shared/constants.js';
import { assetCdnOrigin, cdnAssetPath } from './assetCdn.js';
import { IMPORTED_ASSET_CACHE, releaseAssetCache, setActiveAssetVersion, listImportedPaths, ensureImportedAssetWorker } from './assetCache.js';
import { createAssetImport, importReleaseAssetPart, crc32 } from './assetPack.js';

export const GITEE_RELEASE_BASE = 'https://gitee.com/CrimsonAishia/stronghold-protocol/releases/download';

export function defaultManifestUrl(version = APP_VERSION) {
  return `${GITEE_RELEASE_BASE}/assets-v${version}/manifest.json`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '计算中…';
  if (seconds < 60) return `还需约 ${Math.round(seconds)} 秒`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `还需约 ${mins} 分 ${secs} 秒`;
}

export function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

const memoryStorage = new Map();
function getStorage(custom) {
  if (custom) {
    return {
      getItem: (k) => custom.getItem?.(k) ?? null,
      setItem: (k, v) => custom.setItem?.(k, v),
      removeItem: (k) => (custom.removeItem ? custom.removeItem(k) : custom.setItem?.(k, '')),
    };
  }
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch { /* fallback */ }
  return {
    getItem: (k) => memoryStorage.get(k) ?? null,
    setItem: (k, v) => memoryStorage.set(k, String(v)),
    removeItem: (k) => memoryStorage.delete(k),
  };
}

export const CORE_SELF_HOSTED_PROBES = [
  '/data/assets.json',
  '/assets/ui/icon.png',
  '/assets/ui/entry/bkg_01.png',
  '/assets/audio/sound_fx/p_skill_default.wav',
  '/assets/ui/prepareBkg/img_screen_line_repeat.png',
  '/assets/char/avatar/char_002_amiya.png',
  '/assets/char/portrait/char_002_amiya_1.png',
  '/assets/spine/op/char_002_amiya/front/char_002_amiya.skel',
  '/assets/spine/op/char_002_amiya/front/char_002_amiya.atlas',
  '/assets/spine/op/char_002_amiya/front/char_002_amiya.png',
  '/assets/audio/music/m_bat_base01.mp3',
];

export function collectManifestAssetPaths(manifest) {
  const paths = new Set();
  if (!manifest || typeof manifest !== 'object') return [];

  const visit = (val) => {
    if (typeof val === 'string' && cdnAssetPath(val)) {
      paths.add(val);
    } else if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) visit(item);
      } else {
        for (const key of Object.keys(val)) visit(val[key]);
      }
    }
  };

  visit(manifest);
  return [...paths];
}

/** @template T @param {(signal: AbortSignal) => Promise<T>} read */
async function readWithDeadline(read, timeoutMs, signal = /** @type {AbortSignal | undefined} */ (undefined)) {
  const controller = new AbortController();
  let timer;
  let stop;
  /** @type {Promise<null>} */
  const deadline = new Promise((resolve) => {
    stop = () => { controller.abort(); resolve(null); };
    timer = setTimeout(stop, timeoutMs);
  });
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    if (controller.signal.aborted) return null;
    return await Promise.race([read(controller.signal), deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function manifestRevision(doFetch, signal) {
  return readWithDeadline(async (requestSignal) => {
    const response = await doFetch('/data/assets.json', { method: 'HEAD', cache: 'no-cache', signal: requestSignal });
    return response?.ok && !/text\/html/i.test(response.headers?.get?.('content-type') || '')
      ? response.headers?.get?.('etag') || null : null;
  }, 1500, signal);
}

/** Check whether local asset parts are already complete. */
export async function checkAssetReadiness({
  version = APP_VERSION,
  fetch: doFetch = (...args) => globalThis.fetch(...args),
  caches: cachesApi = globalThis.caches,
  storage: customStorage,
  onProgress,
  onStage,
  signal,
  onHostedVerified,
  hostedTimeoutMs = 5000,
} = {}) {
  setActiveAssetVersion(version);
  const store = getStorage(customStorage);
  const key = `sp_assets_ready_v${version}`;

  const verifyWorker = async () => {
    if (globalThis.navigator?.serviceWorker) {
      const swRes = await ensureImportedAssetWorker();
      if (!swRes?.ok) {
        store.removeItem(key);
        return false;
      }
    }
    return true;
  };

  if (store.getItem(key) === '1') {
    if (!(await verifyWorker())) {
      return { ready: false, reason: 'uncontrolled' };
    }
    return { ready: true, reason: 'storage' };
  }
  try {
    const paths = await listImportedPaths(cachesApi);
    if (paths && paths.size >= 1000) {
      if (!(await verifyWorker())) {
        return { ready: false, reason: 'uncontrolled' };
      }
      store.setItem(key, '1');
      return { ready: true, reason: 'imported_cache' };
    }
  } catch { /* ignore */ }

  try {
    if (!assetCdnOrigin()) {
      onStage?.('server');
      const hosted = await readWithDeadline(async (requestSignal) => {
        const response = await doFetch('/api/asset-part/hosted', { cache: 'no-store', signal: requestSignal });
        return response?.ok ? response.json() : null;
      }, hostedTimeoutMs, signal);
      if (hosted?.complete === true) {
        if (onHostedVerified) {
          onStage?.('manifest');
          const revision = await manifestRevision(doFetch, signal);
          if (!signal?.aborted) onHostedVerified(revision);
        }
        return { ready: true, reason: 'self_hosted' };
      }
      if (hosted?.complete === false) return { ready: false, reason: 'missing' };
    }
    onStage?.('manifest');
    const loaded = await readWithDeadline(async (requestSignal) => {
      const response = await doFetch('/data/assets.json', { cache: 'no-cache', signal: requestSignal });
      if (!response?.ok || /text\/html/i.test(response.headers?.get?.('content-type') || '')) return { manifest: null };
      return { manifest: await response.json(), revision: response.headers?.get?.('etag') };
    }, 5000, signal);
    if (!loaded && signal) return { ready: false, reason: 'unavailable' };
    const manifest = loaded?.manifest;
    if (!manifest) return { ready: false, reason: 'missing' };
    const paths = collectManifestAssetPaths(manifest);
    const charCount = manifest?.chars ? Object.keys(manifest.chars).length : 0;
    if (paths.length < 10 || (charCount > 0 && charCount < 5)) {
      return { ready: false, reason: 'missing' };
    }
    let next = 0;
    let checked = 0;
    onProgress?.(checked, paths.length);
    let missing = false;
    const controller = new AbortController();
    let finishMissing;
    const missingResult = new Promise((resolve) => { finishMissing = resolve; });
    const markMissing = () => {
      if (!missing) {
        missing = true;
        controller.abort();
        finishMissing();
      }
    };
    if (signal?.aborted) markMissing();
    else signal?.addEventListener('abort', markMissing, { once: true });
    let probeTimedOut = false;
    const stopWaiting = () => { probeTimedOut = true; markMissing(); };
    let timeout = setTimeout(stopWaiting, 5000);
    const probeAssets = async () => {
      while (!missing && next < paths.length) {
        const url = paths[next++];
        try {
          let probe = await doFetch(url, { method: 'HEAD', cache: 'no-cache', signal: controller.signal });
          if (probe?.status === 405) probe = await doFetch(url, { method: 'GET', cache: 'no-cache', signal: controller.signal });
          const available = probe?.status === 200 && !/text\/html/i.test(probe.headers?.get?.('content-type') || '');
          if (probe?.body?.cancel) await probe.body.cancel().catch(() => {});
          if (!available) {
            markMissing();
          } else {
            checked++;
            if (checked === paths.length || checked % 50 === 0) onProgress?.(checked, paths.length);
            clearTimeout(timeout);
            if (!missing) timeout = setTimeout(stopWaiting, 5000);
          }
        } catch {
          markMissing();
        }
      }
    };
    try {
      await Promise.race([Promise.all(Array.from({ length: Math.min(16, paths.length) }, probeAssets)), missingResult]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', markMissing);
    }
    if (!missing) {
      onHostedVerified?.(loaded.revision);
      store.setItem(key, '1');
      return { ready: true, reason: 'self_hosted' };
    }
    if (probeTimedOut && signal) return { ready: false, reason: 'unavailable' };
  } catch { /* A failed manifest or probe cannot confirm completeness. */ }
  return { ready: false, reason: 'missing' };
}

/**
 * Multi-part asset downloader state machine with throughput monitoring and SHA-256 verification.
 */
export function createAssetPartDownloader({
  version = APP_VERSION,
  manifestUrl,
  fetch: doFetch = (...args) => globalThis.fetch(...args),
  caches: cachesApi = globalThis.caches,
  storage: customStorage,
  importer,
} = {}) {
  setActiveAssetVersion(version);
  const store = getStorage(customStorage);
  const readyKey = `sp_assets_ready_v${version}`;
  const hostedKey = `sp_hosted_assets_ready_v${version}:${assetCdnOrigin() || ''}`;
  const serverPathsKey = `${hostedKey}:part-dependencies`;
  const saveHostedRevision = (revision) => revision ? store.setItem(hostedKey, revision) : store.removeItem(hostedKey);
  const partsKey = `sp_finished_parts_v${version}`;
  const recordsUrl = `/sp-asset-parts-${encodeURIComponent(version)}.json`;
  const reinstallRecordsUrl = `/sp-asset-parts-reinstall-${encodeURIComponent(version)}.json`;
  const stagingUrl = (part, reinstall = false) => `/sp-asset-part-${reinstall ? 'reinstall-' : ''}${encodeURIComponent(version)}-${encodeURIComponent(part.id)}-${part.sha256.toLowerCase()}.zip`;

  async function readRecords() {
    if (!cachesApi?.open) return null;
    const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
    const response = await cache.match(recordsUrl);
    if (!response) return {};
    try {
      const records = await response.json();
      return records && typeof records === 'object' && !Array.isArray(records) ? records : {};
    } catch {
      return {};
    }
  }

  async function writeRecords(records) {
    const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
    await cache.put(recordsUrl, new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json' } }));
  }

  async function readReinstallRecords() {
    if (!cachesApi?.open) return null;
    try {
      const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
      const response = await cache.match(reinstallRecordsUrl);
      if (!response) return null;
      const records = await response.json();
      return records && typeof records === 'object' && !Array.isArray(records) ? records : null;
    } catch {
      return null;
    }
  }

  async function writeReinstallRecords(records) {
    if (!cachesApi?.open) return;
    try {
      const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
      await cache.put(reinstallRecordsUrl, new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* ignore */ }
  }

  async function clearReinstallRecords() {
    if (!cachesApi?.open) return;
    try {
      const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
      await cache.delete(reinstallRecordsUrl);
    } catch { /* ignore */ }
  }

  function isValidPng(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 45) {
      console.log('DEBUG isValidPng fail: too short', bytes.length);
      return false;
    }
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== pngSig[i]) {
        console.log('DEBUG isValidPng fail: bad sig at', i);
        return false;
      }
    }
    let offset = 8;
    let hasIhdr = false;
    let hasIend = false;

    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const typeOffset = offset + 4;
      const dataOffset = offset + 8;
      const nextOffset = dataOffset + length + 4;
      if (nextOffset > bytes.length) {
        console.log('DEBUG isValidPng fail: nextOffset > bytes.length', nextOffset, bytes.length);
        return false;
      }
      const type = String.fromCharCode(bytes[typeOffset], bytes[typeOffset + 1], bytes[typeOffset + 2], bytes[typeOffset + 3]);
      if (!hasIhdr) {
        if (type !== 'IHDR' || length < 13) {
          console.log('DEBUG isValidPng fail: not IHDR', type, length);
          return false;
        }
        hasIhdr = true;
      }
      if (type === 'IEND') {
        hasIend = true;
        if (length !== 0 || nextOffset !== bytes.length) {
          console.log('DEBUG isValidPng fail: IEND length or trailing', length, nextOffset, bytes.length);
          return false;
        }
      }

      const storedCrc = ((bytes[nextOffset - 4] << 24) | (bytes[nextOffset - 3] << 16) | (bytes[nextOffset - 2] << 8) | bytes[nextOffset - 1]) >>> 0;
      const chunkTypeAndData = bytes.subarray(typeOffset, dataOffset + length);
      const computedCrc = crc32(chunkTypeAndData);
      if (computedCrc !== storedCrc) {
        console.log('DEBUG isValidPng fail: CRC mismatch for', type, storedCrc.toString(16), computedCrc.toString(16));
        return false;
      }

      offset = nextOffset;
      if (hasIend) break;
    }

    if (!hasIhdr || !hasIend) console.log('DEBUG isValidPng fail: missing IHDR or IEND', hasIhdr, hasIend);
    return hasIhdr && hasIend;
  }

  async function isValidCachedResponse(res, path = '') {
    if (!res || res.status !== 200) return false;
    const contentType = res.headers?.get?.('content-type') || '';
    if (/text\/html/i.test(contentType)) return false;
    const cl = res.headers?.get?.('content-length');
    if (cl && parseInt(cl, 10) === 0) return false;
    let buf;
    try {
      const clone = res.clone ? res.clone() : res;
      buf = await clone.arrayBuffer();
      if (!buf || buf.byteLength === 0) return false;
    } catch {
      return false;
    }

    const bytes = new Uint8Array(buf);
    const lowerPath = typeof path === 'string' ? path.toLowerCase() : '';
    const lowerType = contentType.toLowerCase();

    // PNG check: magic number 89 50 4E 47 0D 0A 1A 0A, followed by IHDR chunk and chunk CRC verification
    if (lowerPath.endsWith('.png') || lowerType.includes('image/png')) {
      if (!isValidPng(bytes)) return false;
      if (typeof globalThis.createImageBitmap === 'function') {
        try {
          const bmp = await globalThis.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          bmp?.close?.();
        } catch {
          return false;
        }
      }
    } else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg') || lowerType.includes('image/jpeg')) {
      if (bytes.length < 3) return false;
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
    } else if (lowerPath.endsWith('.webp') || lowerType.includes('image/webp')) {
      if (bytes.length < 12) return false;
      const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isRiff || !isWebp) return false;
    } else if (lowerPath.endsWith('.ogg') || lowerType.includes('audio/ogg')) {
      if (bytes.length < 4) return false;
      if (bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) return false;
    } else if (lowerPath.endsWith('.wav') || lowerType.includes('audio/wav') || lowerType.includes('audio/x-wav')) {
      if (bytes.length < 12) return false;
      const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const isWave = bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
      if (!isRiff || !isWave) return false;
    } else if (lowerPath.endsWith('.json') || lowerType.includes('application/json')) {
      try {
        const text = new TextDecoder().decode(bytes);
        JSON.parse(text);
      } catch {
        return false;
      }
    }
    return true;
  }

  async function serverAssetAvailable(path, signal) {
    const probeController = new AbortController();
    const abortProbe = () => probeController.abort();
    signal?.addEventListener('abort', abortProbe, { once: true });
    let timer;
    try {
      const probeRequest = async () => {
        let response = await doFetch(path, { method: 'HEAD', cache: 'no-cache', signal: probeController.signal });
        if (response?.status === 405) {
          response = await doFetch(path, { method: 'GET', cache: 'no-cache', signal: probeController.signal });
        }
        return response;
      };
      const probe = await Promise.race([
        probeRequest(),
        new Promise((resolve) => { timer = setTimeout(() => { probeController.abort(); resolve(null); }, 5000); }),
      ]);
      if (signal?.aborted || paused) throw new DOMException('Paused', 'AbortError');
      const hosted = probe && probe.status === 200 && !/text\/html/i.test(probe.headers?.get('content-type') || '');
      if (probe?.body?.cancel) {
        try { await probe.body.cancel(); } catch { /* ignore */ }
      }
      return !!hosted;
    } catch (err) {
      if (signal?.aborted || paused) throw err;
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortProbe);
    }
  }

  async function validRecords(records, parts, signal, { startup = false, serverPathsVerified = false, onProgress } = {}) {
    const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
    const valid = new Set();
    let importedPaths = null;
    let releaseCache = null;
    const installed = startup && store.getItem(readyKey) === '1';
    const releaseCacheName = releaseAssetCache(version);
    for (const [index, part] of parts.entries()) {
      if (paused || signal?.aborted) throw new DOMException('Paused', 'AbortError');
      onProgress?.(index, parts.length);
      const record = records[part.id];
      if (!record || record.sha256 !== part.sha256 || !Array.isArray(record.paths) || !Array.isArray(record.serverPaths)) continue;
      const releasePaths = Array.isArray(record.releasePaths) ? record.releasePaths : [];
      const serverPaths = record.serverPaths;
      if (!record.paths.length && !releasePaths.length && !serverPaths.length) continue;
      // The release paths are only recorded after a verified ZIP has been imported.
      const quick = startup && (installed || releasePaths.length > 0);
      const probePaths = (paths) => quick && paths.length > 2 ? [paths[0], paths[paths.length - 1]] : paths;
      let present = true;
      if (releasePaths.length) releaseCache ||= await cachesApi.open(releaseCacheName);
      let paths = record.paths;
      if (quick && paths.length > 2) {
        // Pruning updates the index, so a removed path must still trigger verification.
        importedPaths ??= await listImportedPaths(cachesApi);
        if (paths.every((path) => importedPaths.has(path))) paths = probePaths(paths);
      }
      const entries = [
        ...paths.map((path) => ({ cache, path })),
        ...probePaths(releasePaths).map((path) => ({ cache: releaseCache, path })),
      ];
      let nextEntry = 0;
      const checkEntries = async () => {
        while (present && nextEntry < entries.length) {
          if (paused || signal?.aborted) throw new DOMException('Paused', 'AbortError');
          const { cache: entryCache, path } = entries[nextEntry++];
          const res = await entryCache.match(path);
          if (!res || !await isValidCachedResponse(res, path)) { present = false; break; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(16, entries.length) }, checkEntries));
      let nextServerPath = 0;
      const checkServerPaths = async () => {
        while (present && nextServerPath < serverPaths.length) {
          if (paused || signal?.aborted) throw new DOMException('Paused', 'AbortError');
          if (!await serverAssetAvailable(serverPaths[nextServerPath++], signal)) present = false;
        }
      };
      if (present && serverPaths.length && !serverPathsVerified) {
        await Promise.all(Array.from({ length: Math.min(startup ? 8 : 1, serverPaths.length) }, checkServerPaths));
      }
      if (present) valid.add(part.id);
    }
    onProgress?.(parts.length, parts.length);
    return valid;
  }

  let state = {
    phase: 'checking',
    ready: false,
    totalParts: 0,
    completedParts: 0,
    hasStagedParts: false,
    currentPartIndex: 0,
    currentPartId: '',
    downloadingIndex: 0,
    importingIndex: 0,
    parts: [],
    totalBytes: 0,
    receivedBytes: 0,
    percent: 0,
    speed: 0,
    speedText: '',
    etaSeconds: 0,
    etaText: '',
    statusText: '正在检查本地素材…',
    checkProgress: null,
    importProgress: null,
    error: null,
  };

  const listeners = new Set();
  let controller = null;
  let verifyController = null;
  let running = null;
  let paused = false;
  let reinstallPending = false;
  let notifyImportSlot = () => {};

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  function getFinishedPartIds() {
    try {
      const raw = store.getItem(partsKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function addFinishedPartId(partId) {
    const current = new Set(getFinishedPartIds());
    current.add(partId);
    store.setItem(partsKey, JSON.stringify([...current]));
  }

  async function inspectStartup(signal, reportProgress, retry) {
    const savedRevision = store.getItem(hostedKey);
    if (savedRevision) {
      reportProgress('manifest');
      if (await manifestRevision(doFetch, signal) === savedRevision) {
        return { ready: true, reason: 'self_hosted' };
      }
      reportProgress('local');
    }
    const inspectHosted = () => checkAssetReadiness({
      version, fetch: doFetch, caches: null, storage: { getItem: () => null, setItem: () => {} },
      onProgress: (done, total) => reportProgress('server', done, total),
      onStage: reportProgress, signal, onHostedVerified: saveHostedRevision, hostedTimeoutMs: retry ? 60000 : 5000,
    });
    let result = { ready: false };
    let completedParts = 0;
    let hasStagedParts = false;
    let serverPathsRevision = null;
    try {
      const records = await readRecords();
      if (records?.__parts?.length) {
        if (records.__parts.some((part) => records[part.id]?.serverPaths?.length)) {
          reportProgress('manifest');
          serverPathsRevision = await manifestRevision(doFetch, signal);
        }
        const serverPathsVerified = !!serverPathsRevision && serverPathsRevision === store.getItem(serverPathsKey);
        const valid = await validRecords(records, records.__parts, signal, {
          startup: true,
          serverPathsVerified,
          onProgress: (done, total) => reportProgress('local', done, total),
        });
        completedParts = valid.size;
        result = { ready: valid.size === records.__parts.length };
        if (!result.ready && !completedParts && cachesApi?.open) {
          try {
            reportProgress('local');
            const staged = await cachesApi.open(`sp-asset-parts-download-${version}`);
            for (const part of records.__parts) {
              if (signal.aborted) return null;
              if (typeof part?.id !== 'string' || !/^[a-f0-9]{64}$/i.test(part.sha256 || '')) continue;
              if (await staged.match(stagingUrl(part))) {
                hasStagedParts = true;
                break;
              }
            }
          } catch { /* Staging is optional and will be rechecked when downloading. */ }
        }
      }
    } catch { /* A missing or unreadable cache requires repair. */ }
    if (signal.aborted) return null;
    if (!result.ready) return { ...await inspectHosted(), completedParts, hasStagedParts };
    if (globalThis.navigator?.serviceWorker) {
      reportProgress('worker');
      const swRes = await ensureImportedAssetWorker();
      if (!swRes.ok) {
        const hosted = await inspectHosted();
        if (hosted.ready) return { ...hosted, completedParts, hasStagedParts };
        return { ready: false, error: `Service Worker 注册失败 (${swRes.reason})，无法启用本地缓存` };
      }
    }
    return { ready: true, reason: 'local', serverPathsRevision };
  }

  async function check({ retry = false } = {}) {
    if (running) return state;
    state = { ...state, phase: 'checking', statusText: '正在检查本地素材…', checkProgress: null, error: null };
    emit();
    const result = await readWithDeadline(
      (signal) => inspectStartup(signal, (stage, done = 0, total = 0) => {
        if (running || signal.aborted) return;
        state = { ...state, checkProgress: { stage, done, total } };
        emit();
      }, retry),
      retry ? 75000 : 12000,
    );
    if (running) return state;
    if (!result || result.reason === 'unavailable') {
      state = { ...state, phase: 'check_timeout', ready: false, statusText: '请求超时，请重试' };
    } else if (result.ready) {
      if (result.reason === 'local') {
        store.setItem(readyKey, '1');
        if (result.serverPathsRevision) store.setItem(serverPathsKey, result.serverPathsRevision);
        else store.removeItem(serverPathsKey);
      } else {
        store.removeItem(readyKey);
        store.removeItem(serverPathsKey);
      }
      state = {
        ...state,
        phase: 'complete',
        ready: true,
        percent: 100,
        statusText: '素材已就绪，可直接进入游戏',
      };
    } else if (result.error) {
      store.removeItem(readyKey);
      state = { ...state, phase: 'error', ready: false, error: result.error, statusText: result.error };
    } else {
      store.removeItem(readyKey);
      store.removeItem(serverPathsKey);
      saveHostedRevision(null);
      state = {
        ...state,
        phase: 'idle',
        ready: false,
        completedParts: result.completedParts,
        hasStagedParts: result.hasStagedParts,
        statusText: '需要下载完整素材以进入游戏',
      };
    }
    emit();
    return state;
  }

  async function downloadStream(url, expectedBytes, onProgress) {
    const isGitee = typeof url === 'string' && (url.includes('gitee.com') || url.includes('foruda.gitee.com'));
    const targetUrl = isGitee ? `/api/asset-part/stream?url=${encodeURIComponent(url)}` : url;
    let response;
    if (isGitee) {
      let triedDirect = false;
      try {
        response = await doFetch(targetUrl, { signal: controller?.signal, cache: 'default' });
        if (!response.ok || /text\/html/i.test(response.headers?.get('content-type') || '')) {
          triedDirect = true;
          response = await doFetch(url, { signal: controller?.signal, cache: 'default' });
        }
      } catch (err) {
        if (!triedDirect) {
          response = await doFetch(url, { signal: controller?.signal, cache: 'default' });
        } else {
          throw err;
        }
      }
    } else {
      response = await doFetch(url, { signal: controller?.signal, cache: 'default' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`下载失败 HTTP ${response.status}`), { status: response.status });
    }
    if (/text\/html/i.test(response.headers?.get('content-type') || '')) {
      throw Object.assign(new Error('未找到资源分包 (返回HTML)'), { status: 'html' });
    }

    const reader = response.body?.getReader ? response.body.getReader() : null;
    if (!reader) {
      const buf = new Uint8Array(await response.arrayBuffer());
      onProgress(buf.byteLength);
      return buf;
    }

    const chunks = [];
    let received = 0;
    for (;;) {
      if (paused) throw new DOMException('Paused', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress(value.byteLength);
      }
    }
    const full = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      full.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return full;
  }

  async function computeSha256(data) {
    if (globalThis.crypto?.subtle?.digest) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
      return toHex(digest);
    }
    throw new Error('浏览器不支持素材校验');
  }

  async function run(reinstall = false) {
    if (typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext) {
      state = { ...state, phase: 'error', error: '请使用 HTTPS 或 localhost 下载素材', statusText: '请使用 HTTPS 或 localhost 下载素材' };
      emit();
      return;
    }
    paused = false;
    controller = new AbortController();
    state = { ...state, phase: 'downloading', error: null, statusText: '正在获取下载清单…' };
    emit();

    try {
      const candidates = [
        '/api/asset-part/manifest',
        '/data/asset-manifest.json',
        manifestUrl || defaultManifestUrl(version),
      ];
      let manifest = null;
      for (const url of candidates) {
        try {
          const resp = await doFetch(url, { signal: controller.signal });
          if (resp && resp.ok && !/text\/html/i.test(resp.headers?.get('content-type') || '')) {
            const data = await resp.json();
            if (data && (!data.version || data.version === version) && Array.isArray(data.parts) && data.parts.length > 0 &&
              data.parts.every((part) => part && typeof part.id === 'string' && part.id &&
                typeof part.url === 'string' && part.url && /^[a-f0-9]{64}$/i.test(part.sha256) &&
                Number.isFinite(part.bytes) && part.bytes > 0) &&
              new Set(data.parts.map((part) => part.id)).size === data.parts.length) {
              manifest = data;
              break;
            }
          }
        } catch { /* fallback to next candidate */ }
      }

      if (!manifest || !Array.isArray(manifest.parts) || !manifest.parts.length) {
        throw new Error('无法读取素材发布清单，请检查网络连接');
      }

      store.removeItem(serverPathsKey);
      const allParts = manifest.parts;
      const storedRecords = await readRecords();
      let records = null;
      let finishedIds = new Set();

      if (reinstall) {
        const reinstallRecords = await readReinstallRecords();
        if (reinstallRecords && reinstallRecords.__parts) {
          finishedIds = await validRecords(reinstallRecords, allParts, controller.signal);
        }
        records = reinstallRecords || {};
        records.__parts = allParts.map(({ id, sha256 }) => ({ id, sha256 }));
        await writeReinstallRecords(records);
      } else {
        records = storedRecords;
        if (records) {
          records.__parts = allParts.map(({ id, sha256 }) => ({ id, sha256 }));
          finishedIds = await validRecords(records, allParts, controller.signal);
          await writeRecords(records);
        } else {
          finishedIds = new Set(getFinishedPartIds());
        }
      }
      const totalBytes = allParts.reduce((sum, p) => sum + (p.bytes || 0), 0);
      let receivedBytes = allParts
        .filter((p) => finishedIds.has(p.id))
        .reduce((sum, p) => sum + (p.bytes || 0), 0);

      const remainingParts = allParts.filter((p) => !finishedIds.has(p.id));
      const initialParts = allParts.map((p, idx) => {
        const isDone = finishedIds.has(p.id);
        return {
          id: p.id,
          index: idx + 1,
          bytes: p.bytes || 0,
          receivedBytes: isDone ? (p.bytes || 0) : 0,
          percent: isDone ? 100 : 0,
          status: isDone ? 'completed' : 'pending',
        };
      });

      state = {
        ...state,
        totalParts: allParts.length,
        completedParts: finishedIds.size,
        totalBytes,
        receivedBytes,
        percent: totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : 0,
        parts: initialParts,
      };

      if (!remainingParts.length) {
        if (globalThis.navigator?.serviceWorker) {
          const swRes = await ensureImportedAssetWorker();
          if (!swRes.ok) {
            throw new Error(`Service Worker 注册失败 (${swRes.reason})，无法启用本地缓存`);
          }
        }
        if (reinstall) {
          const reinstallRec = await readReinstallRecords();
          const recordsToCommit = (reinstallRec && Object.keys(reinstallRec).length > 0) ? reinstallRec : records;
          if (recordsToCommit) {
            await writeRecords(recordsToCommit);
            await clearReinstallRecords();
          }
        } else if (records) {
          await writeRecords(records);
          await clearReinstallRecords();
        }
        store.setItem(partsKey, JSON.stringify(allParts.map((part) => part.id)));
        store.setItem(readyKey, '1');
        state = {
          ...state,
          phase: 'complete',
          ready: true,
          percent: 100,
          downloadingIndex: 0,
          importingIndex: 0,
          statusText: '素材已就绪！',
        };
        emit();
        return;
      }

      const updatePart = (partIdx, patch) => {
        state.parts = state.parts.map((p) => (p.index === partIdx ? { ...p, ...patch } : p));
      };

      const refreshStatusText = () => {
        if (state.phase === 'complete') {
          state.statusText = '素材下载与导入完成！';
        } else if (state.completedParts === state.totalParts) {
          state.statusText = '正在完成素材导入…';
        } else {
          state.statusText = `正在下载素材 (${state.completedParts}/${state.totalParts})…`;
        }
      };

      let speedSamples = [];
      const updateThroughput = (bytesDelta) => {
        const now = Date.now();
        speedSamples.push({ at: now, bytes: bytesDelta });
        const windowThreshold = now - 2000;
        speedSamples = speedSamples.filter((s) => s.at >= windowThreshold);
        const windowBytes = speedSamples.reduce((acc, s) => acc + s.bytes, 0);
        const windowDuration = Math.max(0.2, (now - (speedSamples[0]?.at || now)) / 1000);
        const speed = windowBytes / windowDuration;
        const remaining = Math.max(0, totalBytes - receivedBytes);
        const eta = speed > 1024 ? remaining / speed : 0;
        state = {
          ...state,
          speed,
          speedText: speed > 0 ? `${formatBytes(speed)}/s` : '',
          etaSeconds: eta,
          etaText: eta > 0 ? formatDuration(eta) : '计算中…',
          percent: totalBytes > 0 ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : 0,
        };
        emit();
      };

      const importManifests = new Map();
      const fetchImportManifest = async (url, options) => {
        if (!importManifests.has(url)) {
          const requestController = new AbortController();
          const abortRequest = () => requestController.abort();
          controller.signal.addEventListener('abort', abortRequest, { once: true });
          let timer;
          const request = Promise.race([
            doFetch(url, { ...options, signal: requestController.signal }).then(async (response) => ({
              body: await response.arrayBuffer(),
              status: response.status,
              statusText: response.statusText,
              headers: [...response.headers.entries()],
            })),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => {
                requestController.abort();
                reject(new Error('素材清单请求超时，请重试'));
              }, 15000);
            }),
          ]).finally(() => {
            clearTimeout(timer);
            controller?.signal.removeEventListener('abort', abortRequest);
          });
          importManifests.set(url, request);
        }
        const response = await importManifests.get(url);
        return new Response(response.body.byteLength ? response.body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      const importEngine = importer || createAssetImport({ fetch: fetchImportManifest, caches: cachesApi });

      const CONCURRENCY = 2;
      const MAX_READY_TO_IMPORT = 2;
      const downloadQueue = [...remainingParts];
      const readyToImportQueue = [];
      const openedStagingCache = cachesApi?.open ? await cachesApi.open(`sp-asset-parts-download-${version}`).catch(() => null) : null;
      const stagingCache = openedStagingCache?.delete ? openedStagingCache : null;
      let isImporting = false;
      let importTask = Promise.resolve();
      let importError = null;
      const slotResolvers = [];

      notifyImportSlot = () => {
        while (slotResolvers.length > 0) {
          const r = slotResolvers.shift();
          if (r) r();
        }
      };
      const waitForImportSlot = () => {
        return new Promise((resolve) => { slotResolvers.push(resolve); });
      };

      const triggerImport = async () => {
        if (isImporting) return;
        isImporting = true;
        try {
          while (readyToImportQueue.length > 0 && !paused && !importError) {
            const item = readyToImportQueue.shift();
            notifyImportSlot();
            const { part, partIndex } = item;
            let zipData = item.zipData;
            if (!zipData) {
              const saved = await stagingCache.match(stagingUrl(part, reinstall));
              if (!saved) throw new Error(`分包 ${part.id} 暂存已丢失，请重试`);
              zipData = new Uint8Array(await saved.arrayBuffer());
            }

            if (part.sha256) {
              const actualSha = await computeSha256(zipData);
              if (actualSha.toLowerCase() !== part.sha256.toLowerCase()) {
                updatePart(partIndex, { status: 'error' });
                throw new Error(`分包 ${part.id} 校验失败，文件可能已损坏，请重试`);
              }
            }

            updatePart(partIndex, { status: 'importing' });
            state.phase = 'importing';
            refreshStatusText();
            emit();

            const releasePaths = importer ? [] : await importReleaseAssetPart(zipData, cachesApi, version);
            const unsubscribeImport = importEngine.subscribe?.((progress) => {
              if (progress.total > 0) {
                state = { ...state, importProgress: { done: progress.done, total: progress.total } };
                emit();
              }
            });
            try {
              await importEngine.start({ type: 'zip', data: zipData, ...(!importer ? { releaseVersion: version } : {}) });
            } finally {
              unsubscribeImport?.();
              state = { ...state, importProgress: null };
            }
            const importState = importEngine.get?.();
            let isComplete = false;
            let serverPaths = [];
            if (importState) {
              if (importState.phase === 'complete') {
                isComplete = true;
              } else if (releasePaths.length && importState.phase === 'empty') {
                isComplete = true;
              } else if (importState.failed === 0 && !importState.error) {
                const rejected = (typeof importEngine.getRejected === 'function' ? importEngine.getRejected() : null) ||
                  importState.rejectedEntries || [];
                if (rejected.length > 0 && (importState.accepted > 0 || releasePaths.length > 0)) {
                  let allServerHosted = true;
                  const verifiedServerPaths = [];
                  for (const entry of rejected) {
                    if (paused || controller?.signal?.aborted) {
                      throw new DOMException('Paused', 'AbortError');
                    }
                    const hosted = await serverAssetAvailable(entry.url, controller?.signal);
                    if (!hosted) {
                      allServerHosted = false;
                      break;
                    }
                    verifiedServerPaths.push(entry.url);
                  }
                  if (allServerHosted) {
                    isComplete = true;
                    serverPaths = verifiedServerPaths;
                  }
                }
              }
            } else {
              isComplete = true;
            }

            if (!isComplete) {
              throw new Error(`分包 ${part.id} 导入未完成，请重试`);
            }

            if (records) {
              records[part.id] = {
                sha256: part.sha256,
                paths: importEngine.getStoredPaths(),
                releasePaths,
                serverPaths: serverPaths || [],
              };
              if (reinstall) {
                await writeReinstallRecords(records);
              } else {
                await writeRecords(records);
              }
            }
            if (stagingCache?.delete) await stagingCache.delete(stagingUrl(part, reinstall));
            if (!reinstall) addFinishedPartId(part.id);
            updatePart(partIndex, { status: 'completed', percent: 100 });
            state.completedParts++;
            refreshStatusText();
            emit();
          }
        } catch (err) {
          importError ||= err;
          controller?.abort();
        } finally {
          isImporting = false;
        }
      };

      const runDownloader = async (part) => {
        if (paused || importError) return;
        const partIndex = allParts.findIndex((p) => p.id === part.id) + 1;
        updatePart(partIndex, { status: 'downloading', receivedBytes: 0, percent: 0 });
        refreshStatusText();
        emit();

        let partReceived = 0;
        let zipData = null;
        let staged = false;
        if (stagingCache) {
          try {
            const saved = await stagingCache.match(stagingUrl(part, reinstall));
            if (saved) {
              const bytes = new Uint8Array(await saved.arrayBuffer());
              if (bytes.byteLength === part.bytes && (await computeSha256(bytes)).toLowerCase() === part.sha256.toLowerCase()) {
                zipData = bytes;
                staged = true;
                receivedBytes += bytes.byteLength;
                state.receivedBytes = receivedBytes;
              } else if (stagingCache.delete) {
                await stagingCache.delete(stagingUrl(part, reinstall));
              }
            }
          } catch { /* A missing or unreadable staging cache requires a download. */ }
        }
        if (!zipData) {
          let idleTimer;
          const resetIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              importError ||= new Error(`分包 ${part.id} 下载超时，请重试`);
              controller?.abort();
              notifyImportSlot();
            }, 30000);
          };
          resetIdleTimer();
          try {
            zipData = await downloadStream(part.url, part.bytes, (chunkBytes) => {
              resetIdleTimer();
              receivedBytes += chunkBytes;
              partReceived += chunkBytes;
              const pPct = part.bytes > 0 ? Math.min(100, Math.floor((partReceived / part.bytes) * 100)) : 0;
              updatePart(partIndex, { receivedBytes: partReceived, percent: pPct });
              state.receivedBytes = receivedBytes;
              updateThroughput(chunkBytes);
            });
          } finally {
            clearTimeout(idleTimer);
          }
        }

        if (paused || importError) return;
        updatePart(partIndex, { status: 'verifying', percent: 100 });
        emit();
        if (stagingCache && !staged && (await computeSha256(zipData)).toLowerCase() === part.sha256.toLowerCase()) {
          try {
            await stagingCache.put(stagingUrl(part, reinstall), new Response(zipData));
            staged = true;
          } catch { /* Continue with the in-memory ZIP. */ }
        }
        readyToImportQueue.push({ part, partIndex, zipData: staged ? null : zipData });
        if (!isImporting) importTask = triggerImport();
      };

      const activeTasks = new Set();
      while (downloadQueue.length > 0 && !paused && !importError) {
        while (readyToImportQueue.filter((item) => item.zipData).length >= MAX_READY_TO_IMPORT && !paused && !importError) {
          await Promise.race([
            waitForImportSlot(),
            ...activeTasks,
            importTask,
          ]);
        }
        if (paused || importError) break;

        while (activeTasks.size >= CONCURRENCY && !paused && !importError) {
          await Promise.race(activeTasks);
        }
        if (paused || importError || downloadQueue.length === 0) break;

        if (readyToImportQueue.filter((item) => item.zipData).length < MAX_READY_TO_IMPORT && activeTasks.size < CONCURRENCY) {
          const nextPart = downloadQueue.shift();
          const task = runDownloader(nextPart)
            .catch((err) => {
              if (!paused) importError ||= err;
              controller?.abort();
              notifyImportSlot();
            })
            .finally(() => {
              activeTasks.delete(task);
            });
          activeTasks.add(task);
        }
      }

      await Promise.allSettled(activeTasks);
      await importTask;
      if (importError) throw importError;

      if (paused) {
        state = { ...state, phase: 'paused', statusText: '下载已暂停' };
        emit();
      } else {
        if (globalThis.navigator?.serviceWorker) {
          const swRes = await ensureImportedAssetWorker();
          if (!swRes.ok) {
            throw new Error(`Service Worker 注册失败 (${swRes.reason})，无法启用本地缓存`);
          }
        }
        if (reinstall && records) {
          await writeRecords(records);
          await clearReinstallRecords();
        }
        store.setItem(partsKey, JSON.stringify(allParts.map((part) => part.id)));
        store.setItem(readyKey, '1');
        state = {
          ...state,
          phase: 'complete',
          ready: true,
          percent: 100,
          downloadingIndex: 0,
          importingIndex: 0,
          statusText: '素材下载与导入完成！',
        };
        emit();
      }
    } catch (err) {
      if (paused || err?.name === 'AbortError') {
        state = { ...state, phase: 'paused', statusText: '下载已暂停' };
      } else {
        let liveValid = false;
        if (!err?.message?.includes('Service Worker') && !paused) {
          verifyController = new AbortController();
          try {
            const stored = await readRecords();
            if (stored?.__parts?.length && !paused) {
              const v = await validRecords(stored, stored.__parts, verifyController.signal);
              if (v.size === stored.__parts.length) {
                liveValid = true;
              }
            }
          } catch { /* ignore */ }
          finally {
            verifyController = null;
          }
        }

        if (paused) {
          state = { ...state, phase: 'paused', statusText: '下载已暂停' };
          emit();
          return;
        }

        if (!liveValid) {
          state.ready = false;
          store.removeItem(readyKey);
        }
        state = {
          ...state,
          phase: 'error',
          ready: liveValid,
          error: err.message || '下载出错，请重试',
          statusText: `下载未完成：${err.message || '未知错误'}`,
        };
      }
      emit();
    } finally {
      controller = null;
      verifyController = null;
    }
  }

  return {
    get: () => state,
    emit() {
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    reinstall() {
      return this.start(true);
    },
    start(reinstall = false) {
      if (running) return running;
      reinstallPending = reinstall;
      const locks = globalThis.navigator?.locks;
      const execute = () => run(reinstallPending);
      running = (locks?.request ? locks.request('sp-asset-part-install', execute) : execute()).finally(() => {
        if (state.phase === 'complete') reinstallPending = false;
        running = null;
      });
      return running;
    },
    pause() {
      paused = true;
      controller?.abort();
      verifyController?.abort();
      notifyImportSlot?.();
      state = { ...state, phase: 'paused', statusText: '下载已暂停' };
      emit();
    },
    resume() {
      return this.start(reinstallPending);
    },
  };
}

export const assetPartDownloader = createAssetPartDownloader();
