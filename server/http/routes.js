// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * /studio and /studio/… → the plugin studio (server/studio/index.js: for this machine and the local network only — any
//     other client gets the 404 page; its API also takes POST / PUT / DELETE), when the server has one;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, the vanilla content
//     hash `content.vanilla`, the modded content sets in use `content.sets` and — only when there are some — how many
//     unofficial plugins the server has, `content.plugins` (the title screen's count before any hello) — DESIGN §32 —,
//     sockets, sessions,
//     rooms, matches; `versions: { enabled, default, hosts }` only when the server enables another official version than
//     第二期下半 — DESIGN §35.23), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';
import { handleAssetManifest, handleAssetStream } from './assetDistribution.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { relOf } from './assetViews.js';

const MAX_URL_LENGTH = 4096;

/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  let notices = false;
  try { notices = lobby?.plugins?.hasNotices?.() === true; } catch { /* optional catalogue hint */ }
  return { ...(n > 0 ? { plugins: n } : {}), ...(notices ? { notices: true } : {}) };
}

/** The content sets with gameplay plugins rooms hold now (DESIGN §32.6; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, content?: { cs: string } | null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null, publicDir?: string, dataDir?: string, trusted?: any,
 *           versions?: ReturnType<typeof import('../versions.js').createVersionSets> | null,
 *           versionHosts?: { stats: () => object } | null }} health
 *   content: the server's vanilla content (server/plugins/identity.js); versions / versionHosts: the official versions
 *   and their match hosts (DESIGN §35.23)
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, content = null, traffic, assetIndex, views, trusted, versions = null, versionHosts = null }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    // what its rooms play (DESIGN §32): the vanilla content hash, and how many content sets with gameplay plugins rooms
    // hold now (P1c, §32.6 — a room's cosmetic plugins leave its cs the vanilla one, §32.3); how many unofficial plugins
    // it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  // the official versions (DESIGN §35.23): only when another one than 第二期下半 is enabled
  if (versions && versions.nonDefault.length) {
    report.versions = { enabled: [...versions.ids], default: versions.defaultId,
      hosts: versionHosts ? versionHosts.stats() : { workers: 0, matches: 0, transport: 'process' } };
  }
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean,
 *           csp?: string | null,
 *           studio?: { handles: (rawPath: string) => boolean, handle: (req: any, res: any, rawPath: string, query: string) => Promise<void> } | null }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY); studio: the
 *   plugin studio (server/studio/index.js), or none
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req,res,parts.rawPath)) return;
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    if (parts.rawPath === '/api/asset-part/hosted') {
      const index = health.assetIndex;
      if (!index && health.publicDir && health.dataDir && health.views) {
        const view = await health.views.get('assets.json');
        const raw = view?.body || await readFile(path.join(health.dataDir, 'assets.json'));
        const manifest = JSON.parse(raw.toString());
        const paths = new Set();
        let unsupported = false;
        const visit = (value) => {
          if (typeof value === 'string') {
            if (value.startsWith('/media/')) unsupported = true;
            else if (value.startsWith('/assets/') || value.startsWith('/fonts/')) {
              const rel = relOf(value);
              if (rel) paths.add(rel);
              else unsupported = true;
            }
          } else if (value && typeof value === 'object') {
            for (const child of Object.values(value)) visit(child);
          }
        };
        visit(manifest);
        if (unsupported) {
          sendJson(req, res, 503, { complete: false });
          return;
        }
        const charCount = manifest.chars ? Object.keys(manifest.chars).length : 0;
        let complete = paths.size >= 10 && (charCount === 0 || charCount >= 5);
        const files = [...paths];
        let next = 0;
        const checkFiles = async () => {
          while (complete && next < files.length) {
            const file = files[next++];
            const info = await stat(path.join(health.publicDir, file)).catch(() => null);
            if (!info?.isFile()) complete = false;
          }
        };
        await Promise.all(Array.from({ length: Math.min(32, files.length) }, checkFiles));
        res.setHeader('Cache-Control', 'no-store');
        sendJson(req, res, 200, { complete });
        return;
      }
      if (!index || !health.views) {
        sendJson(req, res, 503, { complete: false });
        return;
      }
      const last = index.stats().last;
      const scannedAt = last.at ? Date.parse(last.at) : 0;
      if (!index.ready || !scannedAt || Date.now() - scannedAt >= 5000) await index.refresh();
      const view = await health.views.get('assets.json');
      res.setHeader('Cache-Control', 'no-store');
      if (view?.body && view.body.toString('utf8').includes('"/media/')) {
        sendJson(req, res, 503, { complete: false });
        return;
      }
      sendJson(req, res, 200, { complete: !!view && index.ready && !index.stats().last.error && view.hashed >= 10 && view.plain === 0 });
      return;
    }
    if (parts.rawPath === '/api/asset-part/manifest') {
      await handleAssetManifest(req, res);
      return;
    }
    if (parts.rawPath === '/api/asset-part/stream') {
      await handleAssetStream(req, res, parts.query);
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
