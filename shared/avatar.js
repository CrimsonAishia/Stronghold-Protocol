// Public BakaBox forum avatar origin used by both the protocol and the site CSP.
export const AVATAR_ORIGINS = Object.freeze(['https://bbs.zombieden.cn']);

/** @param {unknown} value */
export function isAvatarUrl(value) {
  return typeof value === 'string' && value.length <= 2048
    && /^https:\/\/bbs\.zombieden\.cn(?:[/?#]|$)/i.test(value)
    && !/[\s\\\\]/.test(value);
}
