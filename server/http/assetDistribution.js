// Server-side asset distribution helper: provides same-origin proxying for Gitee Release parts
// to bypass browser CORS / CSP limitations while keeping verified SHA-256 integrity on the client.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { APP_VERSION } from '../../shared/constants.js';
import { sendError, sendJson } from './common.js';
import { ROOT } from './config.js';

const GITEE_BASE = 'https://gitee.com/CrimsonAishia/stronghold-protocol/releases/download';
const ALLOWED_HOSTS = new Set(['gitee.com', 'foruda.gitee.com']);
const MANIFEST_CACHE_FILE = path.join(ROOT, 'data', 'asset-manifest.json');

export function isAllowedDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host) || host.endsWith('.gitee.com');
  } catch {
    return false;
  }
}

export async function handleAssetManifest(req, res) {
  // 1. Check local cached file
  try {
    if (fs.existsSync(MANIFEST_CACHE_FILE)) {
      const content = fs.readFileSync(MANIFEST_CACHE_FILE, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data.parts) && data.parts.length > 0) {
        sendJson(req, res, 200, data);
        return;
      }
    }
  } catch { /* fallback to remote */ }

  // 2. Fetch from Gitee release via Node (no CORS constraint)
  const remoteUrl = `${GITEE_BASE}/assets-v${APP_VERSION}/manifest.json`;
  try {
    const upstream = await globalThis.fetch(remoteUrl, { redirect: 'follow' });
    if (!upstream.ok) {
      sendError(req, res, 502, '获取素材发布清单失败', `上游返回 HTTP ${upstream.status}`);
      return;
    }
    const data = await upstream.json();
    try {
      fs.mkdirSync(path.dirname(MANIFEST_CACHE_FILE), { recursive: true });
      fs.writeFileSync(MANIFEST_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* ignore cache write error */ }
    sendJson(req, res, 200, data);
  } catch (err) {
    sendError(req, res, 502, '连接素材发布源失败', err?.message || String(err));
  }
}

export async function handleAssetStream(req, res, query) {
  const params = new URLSearchParams(query || '');
  const targetUrl = params.get('url');
  if (!targetUrl || !isAllowedDownloadUrl(targetUrl)) {
    sendError(req, res, 400, '请求的资源地址无效或未经授权');
    return;
  }

  try {
    const upstream = await globalThis.fetch(targetUrl, { redirect: 'follow' });
    if (!upstream.ok) {
      sendError(req, res, upstream.status >= 500 ? 502 : upstream.status, '获取分包数据失败', `HTTP ${upstream.status}`);
      return;
    }

    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/zip',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    };
    const len = upstream.headers.get('content-length');
    if (len) headers['Content-Length'] = len;

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      sendError(req, res, 502, '下载分包中断', err?.message || String(err));
    } else {
      res.destroy(err);
    }
  }
}
