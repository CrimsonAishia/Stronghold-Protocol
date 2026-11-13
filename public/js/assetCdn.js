// The server publishes this optional origin through /asset-cdn.js before application modules run.
export function assetCdnOrigin() {
  const value = globalThis.__SP_ASSET_CDN__;
  return typeof value === 'string' ? value : '';
}

/** Canonical path of our own art or the configured CDN's art; never accept arbitrary external URLs. */
export function cdnAssetPath(raw, cdn = assetCdnOrigin()) {
  if (typeof raw !== 'string' || /[?#\\\\]/.test(raw) || raw.includes('\0')) return null;
  if (/^\/(?:assets|fonts|media)\/[^/]/.test(raw)) return raw;
  if (!cdn) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== cdn || url.username || url.password || !/^\/(?:assets|fonts|media)\/[^/]/.test(url.pathname)) return null;
  return url.pathname;
}
