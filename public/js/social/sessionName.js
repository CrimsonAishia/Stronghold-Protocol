// Host profile names are display data only. Session ownership still uses the server's reconnect token.
import { sanitizeName } from '../ui/playerName.js';

export function profileName(profile) {
  return profile?.isLoggedIn === true ? sanitizeName(profile.username) : '';
}

export function canPlayOnline(profile) {
  return !!profileName(profile);
}

/** Keep entered sessions in sync even when the host bridge/profile arrives after boot. */
export function installSessionName({ net, store, socialStore }) {
  const sync = () => {
    if (!store.get().session.entered || socialStore.get().profileChecked === false) return;
    const name = profileName(socialStore.get().selfProfile);
    net.setName(name || '游客', { guest: !name, loggedIn: !!name, avatarUrl: name ? socialStore.get().selfProfile?.avatar : null }); // i18n-ignore (server-assigned player name)
  };
  const unsubProfile = socialStore.subscribe(sync);
  const unsubSession = store.subscribe((state, prev) => {
    if (state.session.entered !== prev.session.entered || state.me.playerId !== prev.me.playerId) sync();
  });
  sync();
  return () => { unsubProfile(); unsubSession(); };
}
