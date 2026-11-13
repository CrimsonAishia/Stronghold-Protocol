// Friend data normalization, validation, filtering, sorting, and progress parsing.
//
// Follows Stronghold Protocol architecture:
// - Never exclude self purely by nickname (prevents accidental omission of players with same name).
// - Strict normalization of IDs and status.
// - Parse game progress from host extra data if present.

import { sanitizeId, sanitizeAvatar } from '../integrations/bakaboxBridge.js';

/**
 * @typedef {Object} FriendProgress
 * @property {string|null} version
 * @property {string|null} mode
 * @property {string|null} difficulty
 * @property {number|null} round
 * @property {string|null} phase
 * @property {boolean} paused
 * @property {boolean} spectating
 * @property {string} statusLabel
 * @property {string} detailText
 * @property {{ code: string, origin?: string }|null} roomShare
 */

/**
 * @typedef {Object} FriendItem
 * @property {string} id
 * @property {string} name
 * @property {string|null} tag
 * @property {string|null} avatar
 * @property {'online'|'in_run'|'offline'|'unknown'} status
 * @property {number|null} updatedAt
 * @property {FriendProgress|null} progress
 * @property {boolean} isSelf
 * @property {Record<string, unknown>} raw
 */

/**
 * Normalize raw status string to recognized enum.
 */
export function normalizeStatus(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.toLowerCase().trim();
  if (s === 'online' || s === 'in_lobby' || s === 'idle') return 'online';
  if (s === 'in_run' || s === 'playing' || s === 'in_game' || s === 'busy') return 'in_run';
  if (s === 'offline') return 'offline';
  return 'unknown';
}

/**
 * Parse game progress from host item extra object.
 */
export function parseProgress(rawExtra) {
  if (!rawExtra || typeof rawExtra !== 'object') return null;

  const version = typeof rawExtra.version === 'string' ? rawExtra.version : null;
  const mode = typeof rawExtra.mode === 'string' ? rawExtra.mode : null;
  const difficulty = typeof rawExtra.difficulty === 'string' ? rawExtra.difficulty : null;
  const round = Number.isInteger(rawExtra.round) && rawExtra.round >= 0 ? rawExtra.round : null;
  const phase = typeof rawExtra.phase === 'string' ? rawExtra.phase : null;
  const paused = rawExtra.paused === true;
  const spectating = rawExtra.spectating === true;

  const statusLabel = typeof rawExtra.statusLabel === 'string' ? rawExtra.statusLabel.trim() : '';
  const detailText = typeof rawExtra.detailText === 'string' ? rawExtra.detailText.trim() : '';

  let roomShare = null;
  if (rawExtra.roomShare && typeof rawExtra.roomShare === 'object') {
    const code = sanitizeId(rawExtra.roomShare.code);
    if (code) {
      roomShare = {
        code,
        origin: typeof rawExtra.roomShare.origin === 'string' ? rawExtra.roomShare.origin : undefined,
      };
    }
  }

  return {
    version,
    mode,
    difficulty,
    round,
    phase,
    paused,
    spectating,
    statusLabel,
    detailText,
    roomShare,
  };
}

/**
 * Normalize a single raw friend entry from host response.
 */
export function normalizeFriend(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = sanitizeId(raw.id ?? raw.uid ?? raw.businessUserId);
  if (!id) return null;

  const name = typeof raw.name === 'string' ? raw.name.trim()
    : (typeof raw.username === 'string' ? raw.username.trim()
      : (typeof raw.nickname === 'string' ? raw.nickname.trim() : ''));

  const tag = typeof raw.tag === 'string' ? raw.tag.trim()
    : (typeof raw.userTag === 'string' ? raw.userTag.trim() : null);

  const avatar = sanitizeAvatar(raw.avatar ?? raw.avatarUrl ?? raw.headImg);
  const status = normalizeStatus(raw.status);

  let updatedAt = null;
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) {
    updatedAt = raw.updatedAt;
  } else if (typeof raw.lastActiveAt === 'number' && Number.isFinite(raw.lastActiveAt)) {
    updatedAt = raw.lastActiveAt;
  }

  const extra = raw.extra ?? raw.progress ?? raw.gameExtra;
  const progress = parseProgress(extra);
  const isSelf = raw.isSelf === true;

  return {
    id,
    name: name || id,
    tag,
    avatar,
    status,
    updatedAt,
    progress,
    isSelf,
    raw,
  };
}

/**
 * Filter out self based on selfProfile.
 * Strictly uses uid/businessUserId or isSelf flag. Never filters by nickname alone.
 */
export function isFriendSelf(friend, selfProfile) {
  if (!friend) return false;
  if (friend.isSelf === true) return true;
  if (!selfProfile) return false;

  const selfUid = sanitizeId(selfProfile.uid);
  const selfBuid = sanitizeId(selfProfile.businessUserId);

  if (selfUid && (friend.id === selfUid || friend.raw?.uid === selfUid)) return true;
  if (selfBuid && (friend.id === selfBuid || friend.raw?.businessUserId === selfBuid)) return true;

  return false;
}

/**
 * Normalize a list of raw friends, filter duplicates, filter self, sort.
 */
export function normalizeFriendsList(rawList, selfProfile) {
  if (!Array.isArray(rawList)) return [];

  const seenIds = new Set();
  const normalized = [];

  for (const raw of rawList) {
    const friend = normalizeFriend(raw);
    if (!friend) continue;
    if (seenIds.has(friend.id)) continue;
    seenIds.add(friend.id);

    if (isFriendSelf(friend, selfProfile)) continue;

    normalized.push(friend);
  }

  return sortFriends(normalized);
}

/**
 * Is this friend considered currently active/online?
 */
export function isOnline(status) {
  return status === 'online' || status === 'in_run';
}

/**
 * Sort friends: online first, then alphabetical by name, then stable by id.
 */
export function sortFriends(list) {
  return [...list].sort((a, b) => {
    const aOn = isOnline(a.status) ? 1 : 0;
    const bOn = isOnline(b.status) ? 1 : 0;
    if (aOn !== bOn) return bOn - aOn;

    const nameComp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    if (nameComp !== 0) return nameComp;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Filter friends by search query (matches name, id, tag) and online filter.
 */
export function filterFriends(list, { filter = 'all', query = '' } = {}) {
  let res = list;
  if (filter === 'online') {
    res = res.filter((f) => isOnline(f.status));
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (q) {
    res = res.filter((f) => {
      if (f.name.toLowerCase().includes(q)) return true;
      if (f.id.toLowerCase().includes(q)) return true;
      if (f.tag && f.tag.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  return res;
}
