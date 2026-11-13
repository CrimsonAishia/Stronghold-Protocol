import { ERR } from '../../../shared/constants.js';
import { NetError } from '../net.js';
import { socialStore } from './store.js';
import { canPlayOnline } from './sessionName.js';
import { getSocialService } from './service.js';

/** Shared by manual room entry, invite links and friends. The server checks admission separately. */
export function requireOnlineLogin() {
  if (!canPlayOnline(socialStore.get().selfProfile)) throw new NetError(ERR.LOGIN_REQUIRED);
}

/** Room entry must use a fresh host response, not a cached profile from before logout. */
export async function refreshOnlineLogin() {
  const service = getSocialService();
  if (service && !canPlayOnline(await service.refreshSelf())) throw new NetError(ERR.LOGIN_REQUIRED);
  requireOnlineLogin();
}
