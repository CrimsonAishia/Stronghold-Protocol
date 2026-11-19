// Explicit multi-part asset download & verification for release distribution.
// Downloads segmented ZIP parts from Gitee Release (or configured CDN/mirror), verifies SHA-256,
// and streams them into Cache Storage via assetPack.js before unlocking lobby entrance.

import { APP_VERSION } from '../../shared/constants.js';
import { listImportedPaths } from './assetCache.js';
import { createAssetImport } from './assetPack.js';

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
  if (custom) return custom;
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch { /* fallback */ }
  return {
    getItem: (k) => memoryStorage.get(k) ?? null,
    setItem: (k, v) => memoryStorage.set(k, String(v)),
    removeItem: (k) => memoryStorage.delete(k),
  };
}

/** Check whether local asset parts are already complete. */
export async function checkAssetReadiness({
  version = APP_VERSION,
  fetch: doFetch = (...args) => globalThis.fetch(...args),
  caches: cachesApi = globalThis.caches,
  storage: customStorage,
} = {}) {
  const store = getStorage(customStorage);
  const key = `sp_assets_ready_v${version}`;
  if (store.getItem(key) === '1') {
    return { ready: true, reason: 'storage' };
  }
  try {
    const paths = await listImportedPaths(cachesApi);
    if (paths && paths.size >= 1000) {
      store.setItem(key, '1');
      return { ready: true, reason: 'imported_cache' };
    }
  } catch { /* ignore */ }

  try {
    const probe = await doFetch('/assets/ui/icon.png', { method: 'HEAD', cache: 'no-cache' });
    if (probe && probe.status === 200 && !/text\/html/i.test(probe.headers?.get('content-type') || '')) {
      store.setItem(key, '1');
      return { ready: true, reason: 'self_hosted' };
    }
  } catch { /* ignore */ }

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
  const store = getStorage(customStorage);
  const readyKey = `sp_assets_ready_v${version}`;
  const partsKey = `sp_finished_parts_v${version}`;

  let state = {
    phase: 'checking',
    ready: false,
    totalParts: 0,
    completedParts: 0,
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
    error: null,
  };

  const listeners = new Set();
  let controller = null;
  let running = null;
  let paused = false;

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

  async function check() {
    state = { ...state, phase: 'checking', statusText: '正在检查本地素材…', error: null };
    emit();
    const result = await checkAssetReadiness({ version, fetch: doFetch, caches: cachesApi, storage: store });
    if (result.ready) {
      state = {
        ...state,
        phase: 'complete',
        ready: true,
        percent: 100,
        statusText: '素材已就绪，可直接进入游戏',
      };
    } else {
      state = {
        ...state,
        phase: 'idle',
        ready: false,
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
    try {
      response = await doFetch(targetUrl, { signal: controller?.signal, cache: 'default' });
    } catch (err) {
      if (isGitee) {
        response = await doFetch(url, { signal: controller?.signal, cache: 'default' });
      } else {
        throw err;
      }
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
    return '';
  }

  async function run() {
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
            if (data && Array.isArray(data.parts) && data.parts.length > 0) {
              manifest = data;
              break;
            }
          }
        } catch { /* fallback to next candidate */ }
      }

      if (!manifest || !Array.isArray(manifest.parts) || !manifest.parts.length) {
        throw new Error('无法读取素材发布清单，请检查网络连接');
      }

      const allParts = manifest.parts;
      const finishedIds = new Set(getFinishedPartIds());
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
        store.setItem(readyKey, '1');
        state = {
          ...state,
          phase: 'complete',
          ready: true,
          percent: 100,
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

      const importEngine = importer || createAssetImport({ fetch: doFetch, caches: cachesApi });

      const CONCURRENCY = 2;
      const downloadQueue = [...remainingParts];
      const readyToImportQueue = [];
      let isImporting = false;
      let importError = null;

      const triggerImport = async () => {
        if (isImporting) return;
        isImporting = true;
        try {
          while (readyToImportQueue.length > 0 && !paused && !importError) {
            const item = readyToImportQueue.shift();
            const { part, partIndex, zipData } = item;

            if (part.sha256) {
              const actualSha = await computeSha256(zipData);
              if (actualSha && actualSha.toLowerCase() !== part.sha256.toLowerCase()) {
                updatePart(partIndex, { status: 'error' });
                throw new Error(`分包 ${part.id} 校验失败，文件可能已损坏，请重试`);
              }
            }

            updatePart(partIndex, { status: 'importing' });
            state.phase = 'importing';
            refreshStatusText();
            emit();

            await importEngine.start({ type: 'zip', data: zipData });

            addFinishedPartId(part.id);
            updatePart(partIndex, { status: 'completed', percent: 100 });
            state.completedParts++;
            refreshStatusText();
            emit();
          }
        } catch (err) {
          importError = err;
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
        const zipData = await downloadStream(part.url, part.bytes, (chunkBytes) => {
          receivedBytes += chunkBytes;
          partReceived += chunkBytes;
          const pPct = part.bytes > 0 ? Math.min(100, Math.floor((partReceived / part.bytes) * 100)) : 0;
          updatePart(partIndex, { receivedBytes: partReceived, percent: pPct });
          state.receivedBytes = receivedBytes;
          updateThroughput(chunkBytes);
        });

        if (paused || importError) return;
        updatePart(partIndex, { status: 'verifying', percent: 100 });
        emit();
        readyToImportQueue.push({ part, partIndex, zipData });
        triggerImport();
      };

      const activeTasks = new Set();
      while ((downloadQueue.length > 0 || activeTasks.size > 0) && !paused && !importError) {
        while (downloadQueue.length > 0 && activeTasks.size < CONCURRENCY && !paused && !importError) {
          const nextPart = downloadQueue.shift();
          const task = runDownloader(nextPart)
            .catch((err) => {
              if (!paused) importError = err;
              controller?.abort();
            })
            .finally(() => {
              activeTasks.delete(task);
            });
          activeTasks.add(task);
        }

        if (activeTasks.size === 0) break;
        await Promise.race(activeTasks);
        if (importError) throw importError;
      }

      // 等待解包队列全部执行完毕
      while ((isImporting || readyToImportQueue.length > 0) && !paused && !importError) {
        await new Promise((r) => setTimeout(r, 40));
      }
      if (importError) throw importError;

      if (!paused) {
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
        state = { ...state, phase: 'error', error: err.message || '下载出错，请重试', statusText: `下载未完成：${err.message || '未知错误'}` };
      }
      emit();
    } finally {
      controller = null;
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
    start() {
      if (running) return running;
      running = run().finally(() => { running = null; });
      return running;
    },
    pause() {
      paused = true;
      controller?.abort();
    },
    resume() {
      return this.start();
    },
  };
}

export const assetPartDownloader = createAssetPartDownloader();
