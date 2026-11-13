// Optional CDN origin for public art. Dynamic game data and plugin code stay on the game origin.
export function normalizeAssetCdn(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('SP_ASSET_CDN must be an HTTP(S) origin');
  const text = value.trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new TypeError('SP_ASSET_CDN must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || /[\\\s]/.test(text)) throw new TypeError('SP_ASSET_CDN must contain only an HTTP(S) scheme, host and optional port');
  return url.origin;
}

export const CDN_ASSET_PATH = /^\/(?:assets|fonts|media)\/[^/]/;

/** Rewrite only public art paths; preserve model hashes, filenames and all non-art values. */
export function cdnManifest(value, origin) {
  if (!origin) return value;
  if (typeof value === 'string') return CDN_ASSET_PATH.test(value) ? origin + value : value;
  if (Array.isArray(value)) return value.map((entry) => cdnManifest(entry, origin));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cdnManifest(entry, origin)]));
}

/** External same-origin bootstrap, also read by the classic imported-art worker. */
export function cdnBootstrap(origin) {
  return `globalThis.__SP_ASSET_CDN__ = ${JSON.stringify(origin)};\n`;
}

/** Fonts in the entry page load directly from the CDN; application code keeps its original origin. */
export function cdnHtml(html, origin) {
  return origin ? html.replace(/(\bhref=["'])(\/fonts\/[^"']+)(["'])/g, (_all, before, url, after) => before + origin + url + after) : html;
}
