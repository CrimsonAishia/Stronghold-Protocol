// Social state store for BakaBox integration.
//
// Separated from game session state (does not pollute gameplay/economy/sim stores).
// Reactive via createStore.

import { createStore } from '../store.js';

export const INITIAL_SOCIAL_STATE = Object.freeze({
  hostAvailable: false,
  capabilities: {
    profile: false,
    friends: false,
    progress: false,
  },
  selfProfile: null,
  profileChecked: false,
  friends: [],
  loading: false,
  error: null,
  isStale: false,
  lastUpdated: null,
  drawerOpen: false,
  filter: 'all', // 'all' | 'online'
  searchQuery: '',
  roomShareEnabled: false,
});

export const socialStore = createStore({ ...INITIAL_SOCIAL_STATE });

export function toggleRoomShare() {
  const next = !socialStore.get().roomShareEnabled;
  socialStore.set({ roomShareEnabled: next });
  return next;
}

export function setRoomShare(enabled) {
  socialStore.set({ roomShareEnabled: !!enabled });
}

export function resetSocialStore() {
  socialStore.set({
    ...INITIAL_SOCIAL_STATE,
    // Preserve host availability & capabilities if already checked
    hostAvailable: socialStore.get().hostAvailable,
    capabilities: { ...socialStore.get().capabilities },
    roomShareEnabled: false,
  });
}
