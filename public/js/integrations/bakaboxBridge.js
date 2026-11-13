// BakaBox integration bridge adapter.
//
// Dual-channel support:
// 1. window.BakaBox standard host interface (getFriends, getSelfProfile, touchGame)
// 2. Flutter in-app webview fallback (flutter_inappwebview.callHandler)
//
// Designed to be non-blocking, defensive against malformed payloads, with bounded timeouts
// and lifecycle cleanup (dispose).

/**
 * @typedef {Object} BridgeCapabilities
 * @property {boolean} profile
 * @property {boolean} friends
 * @property {boolean} progress
 */

/**
 * @typedef {Object} SelfProfile
 * @property {boolean} isLoggedIn
 * @property {string|null} uid
 * @property {string|null} businessUserId
 * @property {string} username
 * @property {string|null} avatar
 * @property {Record<string, unknown>} raw
 */

/**
 * @typedef {Object} BridgeResult
 * @property {boolean} ok
 * @property {any} [data]
 * @property {string} [error] 'unsupported' | 'timeout' | 'invalid_response' | 'host_error' | 'unavailable' | 'disposed'
 * @property {string} [message]
 */

/**
 * Normalize an ID to a non-empty string, or null if invalid.
 * Accepts string or finite number, forbids objects/booleans.
 */
export function sanitizeId(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s.length > 0 ? s : null;
  }
  return null;
}

/**
 * Normalize avatar URL: only http/https/data/blob or null.
 */
export function sanitizeAvatar(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  return null;
}

/**
 * Create a BakaBox bridge instance with injectable dependencies for testability.
 */
export function createBakaboxBridge({
  win = typeof window !== 'undefined' ? window : null,
  timeoutMs = 3000,
  readyTimeoutMs = 2000,
  setTimeoutFn = typeof setTimeout !== 'undefined' ? setTimeout : null,
  clearTimeoutFn = typeof clearTimeout !== 'undefined' ? clearTimeout : null,
} = {}) {
  let disposed = false;
  let generation = 0;
  const listeners = [];
  const readyCallbacks = new Set();

  function notifyReady() {
    if (disposed) return;
    if (isHostAvailable()) {
      const caps = getCapabilities();
      for (const cb of [...readyCallbacks]) {
        try { cb(caps); } catch { /* ignore */ }
      }
    }
  }

  // Application-level listener supporting late injection until dispose
  if (win && typeof win.addEventListener === 'function') {
    const handleLateReady = () => notifyReady();
    win.addEventListener('bakabox:ready', handleLateReady);
    win.addEventListener('flutterInAppWebViewPlatformReady', handleLateReady);
    listeners.push(() => {
      win.removeEventListener('bakabox:ready', handleLateReady);
      win.removeEventListener('flutterInAppWebViewPlatformReady', handleLateReady);
    });
  }

  function onHostReady(cb) {
    if (typeof cb !== 'function') return () => {};
    readyCallbacks.add(cb);
    if (isHostAvailable()) {
      try { cb(getCapabilities()); } catch { /* ignore */ }
    }
    return () => readyCallbacks.delete(cb);
  }

  function withTimeout(promise, ms, opName = 'op') {
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeoutFn(() => {
        resolve({ ok: false, error: 'timeout', message: `${opName} timed out after ${ms}ms` });
      }, ms);
    });
    return Promise.race([
      promise.then(
        (data) => {
          clearTimeoutFn(timer);
          return data;
        },
        (err) => {
          clearTimeoutFn(timer);
          return { ok: false, error: 'host_error', message: err?.message || String(err) };
        }
      ),
      timeoutPromise,
    ]);
  }

  function getHost() {
    if (disposed || !win) return null;
    const bb = win.BakaBox;
    if (bb && bb.isAvailable !== false) return bb;
    return null;
  }

  function getFlutter() {
    if (disposed || !win) return null;
    const flutter = win.flutter_inappwebview;
    if (flutter && typeof flutter.callHandler === 'function') return flutter;
    return null;
  }

  function isHostAvailable() {
    if (disposed || !win) return false;
    if (win.BakaBox?.isAvailable === false) return false;
    return !!(getHost() || getFlutter());
  }

  function getCapabilities() {
    const bb = getHost();
    const fl = getFlutter();
    return {
      profile: !!(bb && typeof bb.getSelfProfile === 'function') || !!fl,
      friends: !!(bb && typeof bb.getFriends === 'function') || !!fl,
      progress: !!(bb && typeof bb.touchGame === 'function') || !!fl,
    };
  }

  async function waitForReady(overrideMs) {
    if (disposed) return { ok: false, error: 'disposed' };
    if (isHostAvailable()) {
      return { ok: true, data: getCapabilities() };
    }
    if (!win || typeof win.addEventListener !== 'function') {
      return { ok: false, error: 'unavailable', message: 'No window available' };
    }

    const waitMs = typeof overrideMs === 'number' ? overrideMs : readyTimeoutMs;
    return new Promise((resolve) => {
      let timer;
      let cleanUp;

      const onReady = () => {
        if (cleanUp) cleanUp();
        if (disposed) {
          resolve({ ok: false, error: 'disposed' });
          return;
        }
        resolve({ ok: isHostAvailable(), data: getCapabilities() });
      };

      const cleanup1 = () => win.removeEventListener('bakabox:ready', onReady);
      const cleanup2 = () => win.removeEventListener('flutterInAppWebViewPlatformReady', onReady);

      cleanUp = () => {
        clearTimeoutFn(timer);
        cleanup1();
        cleanup2();
      };

      win.addEventListener('bakabox:ready', onReady);
      win.addEventListener('flutterInAppWebViewPlatformReady', onReady);

      timer = setTimeoutFn(() => {
        cleanUp();
        resolve({ ok: isHostAvailable(), data: getCapabilities(), error: isHostAvailable() ? undefined : 'timeout' });
      }, waitMs);
    });
  }

  async function getSelfProfile() {
    if (disposed) return { ok: false, error: 'disposed' };
    const curGen = generation;
    const bb = getHost();
    const fl = getFlutter();

    let raw;
    if (bb && typeof bb.getSelfProfile === 'function') {
      const res = await withTimeout(Promise.resolve().then(() => bb.getSelfProfile()), timeoutMs, 'getSelfProfile');
      if (res?.ok === false) return res;
      raw = res?.data !== undefined ? res.data : res;
    } else if (fl) {
      const res = await withTimeout(Promise.resolve().then(() => fl.callHandler('getSelfProfile')), timeoutMs, 'callHandler(getSelfProfile)');
      if (res?.ok === false) return res;
      raw = res?.data !== undefined ? res.data : res;
    } else {
      return { ok: false, error: 'unsupported', message: 'Profile API not supported by host' };
    }

    if (disposed || curGen !== generation) return { ok: false, error: 'disposed' };
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'invalid_response', message: 'Profile response is not an object' };
    }

    // Normalize profile fields
    const uid = sanitizeId(raw.uid ?? raw.id);
    const businessUserId = sanitizeId(raw.businessUserId ?? raw.buid);
    const username = typeof raw.username === 'string' ? raw.username.trim()
      : (typeof raw.name === 'string' ? raw.name.trim() : (typeof raw.nickname === 'string' ? raw.nickname.trim() : ''));
    const avatar = sanitizeAvatar(raw.avatar ?? raw.avatarUrl ?? raw.headImg);
    const isLoggedIn = raw.isLoggedIn === true || (raw.isLoggedIn !== false && (!!uid || !!username));

    return {
      ok: true,
      data: {
        isLoggedIn,
        uid,
        businessUserId,
        username,
        avatar,
        raw,
      },
    };
  }

  async function getFriends() {
    if (disposed) return { ok: false, error: 'disposed' };
    const curGen = generation;
    const bb = getHost();
    const fl = getFlutter();

    let rawList;
    if (bb && typeof bb.getFriends === 'function') {
      const res = await withTimeout(Promise.resolve().then(() => bb.getFriends()), timeoutMs, 'getFriends');
      if (res?.ok === false) return res;
      rawList = res?.data !== undefined ? res.data : res;
    } else if (fl) {
      // Flutter channel fallback: try getGameFriends first, or getFriends
      const res = await withTimeout(Promise.resolve().then(() => fl.callHandler('getGameFriends')), timeoutMs, 'callHandler(getGameFriends)');
      if (res?.ok === false) return res;
      rawList = res?.data !== undefined ? res.data : res;
    } else {
      return { ok: false, error: 'unsupported', message: 'Friends API not supported by host' };
    }

    if (disposed || curGen !== generation) return { ok: false, error: 'disposed' };
    if (!Array.isArray(rawList)) {
      return { ok: false, error: 'invalid_response', message: 'Friends response is not an array' };
    }

    return { ok: true, data: rawList };
  }

  async function touchGame(extra) {
    if (disposed) return { ok: false, error: 'disposed' };
    const bb = getHost();
    const fl = getFlutter();

    let resVal;
    if (bb && typeof bb.touchGame === 'function') {
      const res = await withTimeout(Promise.resolve().then(() => bb.touchGame(extra)), timeoutMs, 'touchGame');
      if (res?.ok === false) return res;
      resVal = res?.data !== undefined ? res.data : res;
    } else if (fl) {
      const res = await withTimeout(Promise.resolve().then(() => fl.callHandler('touchGame', extra)), timeoutMs, 'callHandler(touchGame)');
      if (res?.ok === false) return res;
      resVal = res?.data !== undefined ? res.data : res;
    } else {
      return { ok: false, error: 'unsupported', message: 'touchGame not supported' };
    }

    // touchGame returning false is considered failure
    if (resVal === false) {
      return { ok: false, error: 'host_error', message: 'Host touchGame returned false' };
    }
    return { ok: true, data: resVal };
  }

  function dispose() {
    disposed = true;
    generation++;
    readyCallbacks.clear();
    while (listeners.length > 0) {
      const clean = listeners.pop();
      try { clean(); } catch { /* ignore */ }
    }
  }

  function bumpGeneration() {
    generation++;
  }

  return {
    isHostAvailable,
    getCapabilities,
    waitForReady,
    onHostReady,
    getSelfProfile,
    getFriends,
    touchGame,
    bumpGeneration,
    dispose,
  };
}
