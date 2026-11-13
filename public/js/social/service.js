// Social service coordinating account changes, friends polling, and lifecycle.
//
// Follows Stronghold Protocol rules:
// - Single in-flight request guard to avoid pileup on slow host responses.
// - 5s polling when friends drawer is open, pauses when drawer is closed or page is hidden.
// - Invalidates older requests on account change.
// - Distinguishes empty array (clear list) from errors (preserve stale list + mark isStale).

import { socialStore } from './store.js';
import { normalizeFriendsList } from './friendModel.js';

let activeSocialService = null;

export function getSocialService() {
  return activeSocialService;
}

export function createSocialService({
  bridge,
  store = socialStore,
  pollIntervalMs = 5000,
  doc = typeof document !== 'undefined' ? document : null,
  setTimeoutFn = typeof setTimeout !== 'undefined' ? setTimeout : null,
  clearTimeoutFn = typeof clearTimeout !== 'undefined' ? clearTimeout : null,
} = {}) {
  let disposed = false;
  let inFlight = false;
  let pollTimer = null;
  let currentUid = null;

  function stopPolling() {
    if (pollTimer) {
      clearTimeoutFn(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNextPoll() {
    stopPolling();
    if (disposed) return;
    const s = store.get();
    if (!s.drawerOpen) return;
    if (doc && doc.visibilityState === 'hidden') return;

    pollTimer = setTimeoutFn(() => {
      void refreshFriends({ background: true }).then(() => {
        scheduleNextPoll();
      });
    }, pollIntervalMs);
  }

  async function checkAccountChange(newProfile) {
    const prevUid = currentUid;
    const newUid = newProfile?.uid || newProfile?.businessUserId || null;

    if (prevUid !== null && newUid !== prevUid) {
      // Account changed: bump bridge generation to discard inflight responses
      bridge.bumpGeneration?.();
      currentUid = newUid;
      store.set({
        selfProfile: newProfile,
        friends: [],
        error: null,
        isStale: false,
        lastUpdated: null,
      });
      return true;
    }

    currentUid = newUid;
    store.patch('selfProfile', newProfile || null);
    return false;
  }

  async function refreshSelf() {
    if (disposed || !bridge) return null;
    try {
      const res = await bridge.getSelfProfile();
      if (res.ok && res.data) {
        await checkAccountChange(res.data);
        return res.data;
      }
    } catch (err) {
      console.warn('[social] refreshSelf failed', err);
    }
    return null;
  }

  async function refreshFriends({ background = false } = {}) {
    if (disposed || !bridge || inFlight) return;
    inFlight = true;
    if (!background) {
      store.set({ loading: true, error: null });
    }

    try {
      // Re-verify self profile before fetching friends
      const selfRes = await bridge.getSelfProfile();
      let selfProfile = store.get().selfProfile;
      if (selfRes.ok && selfRes.data) {
        const changed = await checkAccountChange(selfRes.data);
        selfProfile = selfRes.data;
        if (changed) {
          // Account just changed, restart fetch
        }
      }

      const res = await bridge.getFriends();
      if (disposed) return;

      if (res.ok) {
        const rawList = res.data || [];
        const normalized = normalizeFriendsList(rawList, selfProfile);
        store.set({
          friends: normalized,
          loading: false,
          error: null,
          isStale: false,
          lastUpdated: Date.now(),
        });
      } else {
        // Failed: preserve existing friends, mark as stale
        store.set((prev) => ({
          loading: false,
          error: res.message || res.error || 'Failed to fetch friends',
          isStale: prev.friends.length > 0,
        }));
      }
    } catch (err) {
      if (disposed) return;
      store.set((prev) => ({
        loading: false,
        error: err?.message || String(err),
        isStale: prev.friends.length > 0,
      }));
    } finally {
      inFlight = false;
    }
  }

  function openDrawer() {
    store.set({ drawerOpen: true });
    void refreshFriends();
    scheduleNextPoll();
  }

  function closeDrawer() {
    store.set({ drawerOpen: false });
    stopPolling();
  }

  function toggleDrawer() {
    if (store.get().drawerOpen) closeDrawer();
    else openDrawer();
  }

  function setFilter(filter) {
    store.set({ filter });
  }

  function setSearchQuery(searchQuery) {
    store.set({ searchQuery });
  }

  // Handle visibility changes
  const onVisibilityChange = () => {
    if (!doc) return;
    if (doc.visibilityState === 'visible') {
      if (store.get().drawerOpen) {
        void refreshFriends();
        scheduleNextPoll();
      }
    } else {
      stopPolling();
    }
  };

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  function syncHostCapabilities() {
    if (disposed) return;
    const available = bridge.isHostAvailable();
    store.set({
      hostAvailable: available,
      capabilities: bridge.getCapabilities(),
    });
    if (available) {
      void refreshSelf();
    }
  }

  // Subscribe to late host ready events
  const unsubHostReady = typeof bridge.onHostReady === 'function'
    ? bridge.onHostReady(() => syncHostCapabilities())
    : () => {};

  // Initial check
  void (async () => {
    await bridge.waitForReady();
    syncHostCapabilities();
  })();

  function dispose() {
    disposed = true;
    if (activeSocialService === svc) activeSocialService = null;
    stopPolling();
    unsubHostReady();
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
  }

  const svc = {
    refreshSelf,
    refreshFriends,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    setFilter,
    setSearchQuery,
    dispose,
  };
  activeSocialService = svc;
  return svc;
}
