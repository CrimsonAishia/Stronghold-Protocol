// Player presence reporting service.
//
// Translates game store state into BakaBox host touchGame(extra) payloads.
// Features:
// - Debounced updates (max 1 per second)
// - 45s periodic heartbeat
// - Visibility awareness (pauses reporting in background, resumes on foreground)
// - Clean mapping of PHASE constants and room status

import { PHASE } from '../../../shared/constants.js';
import { shownVersion } from '../versions.js';
import { isSpectating, selectRoute } from '../store.js';
import { socialStore as defaultSocialStore } from './store.js';

/**
 * Generate a presence payload from current app state.
 */
export function buildPresencePayload(gameState, { shareRoomCode = null, hostOrigin = '' } = {}) {
  const route = selectRoute(gameState);
  const conn = gameState.connection;
  const room = gameState.room;
  const match = gameState.match;
  const pub = match?.public;
  const inMatch = !!(pub || room?.inMatch);
  const spectating = isSpectating(room, gameState.me?.playerId);

  const version = shownVersion(gameState);
  const mode = room?.mode || (pub?.mode) || null;
  const difficulty = room?.difficulty || (pub?.difficulty) || null;
  const round = typeof pub?.round === 'number' ? pub.round : null;
  const phase = pub?.phase || null;
  const paused = pub?.paused === true || gameState.match?.battle?.paused === true;

  // 1. Connection disrupted or recovering (distinguish initial pre-hello connection from drops)
  const isReconnecting = (conn && conn.status === 'reconnecting')
    || (gameState.ui?.restoring === true)
    || (conn?.everOnline && conn?.status !== 'online')
    || (gameState.session?.entered && conn && conn.status !== 'online');

  if (isReconnecting) {
    return {
      schemaVersion: 1,
      status: 'online',
      activity: 'reconnecting',
      statusLabel: '重新连接中',
      detailText: '正在恢复连接',
      version,
      mode,
      difficulty,
      round,
      phase,
      paused,
      spectating,
      roomShare: null,
      updatedAt: Date.now(),
    };
  }

  // 2. Match result screen or RESULT phase
  if (match?.result || phase === PHASE.RESULT) {
    return {
      schemaVersion: 1,
      status: 'online',
      activity: 'result',
      statusLabel: '模拟结束',
      detailText: round ? `第 ${round} 回合完结` : '模拟完结',
      version,
      mode,
      difficulty,
      round,
      phase,
      paused,
      spectating,
      roomShare: null,
      updatedAt: Date.now(),
    };
  }

  // 3. Active in-match
  if (inMatch && pub) {
    let activity = 'playing';
    let statusLabel = '作战中';
    let detailText = round ? `第 ${round} 回合` : '';

    if (spectating) {
      activity = 'spectating';
      statusLabel = '观战中';
    } else if (phase === PHASE.INFO_CHECK || phase === PHASE.BAND_DRAFT || phase === PHASE.BATTLE_CHECK) {
      activity = 'preparing';
      statusLabel = '策略选择中';
    } else if (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP) {
      activity = 'preparing';
      statusLabel = phase === PHASE.SP_DRAFT ? '机变阶段' : '休整期';
    } else if (phase === PHASE.SETTLE) {
      activity = 'settling';
      statusLabel = '回合结算';
    } else if (phase === PHASE.COMBAT || phase === PHASE.UNITE || phase === PHASE.FINAL_ASSAULT || phase === PHASE.HIDDEN_CORE) {
      activity = 'playing';
      statusLabel = phase === PHASE.UNITE ? '联防作战' : (phase === PHASE.FINAL_ASSAULT ? '最终攻势' : '作战中');
    }

    if (paused) {
      statusLabel += ' (已暂停)';
    }

    return {
      schemaVersion: 1,
      status: 'in_run',
      activity,
      statusLabel,
      detailText,
      version,
      mode,
      difficulty,
      round,
      phase,
      paused,
      spectating,
      roomShare: null,
      updatedAt: Date.now(),
    };
  }

  // 4. Waiting room
  if (room && !room.inMatch) {
    const isShared = !!shareRoomCode && shareRoomCode === room.code;
    const roomCode = isShared ? room.code : null;
    return {
      schemaVersion: 1,
      status: 'online',
      activity: 'room',
      statusLabel: '待战中',
      detailText: isShared ? `房间 ${roomCode}` : '等待同盟就绪',
      version,
      mode,
      difficulty,
      round: null,
      phase: null,
      paused: false,
      spectating,
      roomShare: roomCode ? { code: roomCode, origin: hostOrigin || undefined } : null,
      updatedAt: Date.now(),
    };
  }

  // 5. Lobby or Title
  const isLobby = route === 'lobby' || gameState.session?.entered;
  return {
    schemaVersion: 1,
    status: 'online',
    activity: isLobby ? 'lobby' : 'title',
    statusLabel: isLobby ? '大厅' : '主界面',
    detailText: '',
    version,
    mode: null,
    difficulty: null,
    round: null,
    phase: null,
    paused: false,
    spectating: false,
    roomShare: null,
    updatedAt: Date.now(),
  };
}

/**
 * Compare two presence payloads to see if a report is needed.
 */
export function isPresenceEqual(a, b) {
  if (!a || !b) return false;
  return a.status === b.status
    && a.activity === b.activity
    && a.statusLabel === b.statusLabel
    && a.detailText === b.detailText
    && a.version === b.version
    && a.mode === b.mode
    && a.difficulty === b.difficulty
    && a.round === b.round
    && a.phase === b.phase
    && a.paused === b.paused
    && a.spectating === b.spectating
    && Boolean(a.roomShare) === Boolean(b.roomShare)
    && a.roomShare?.code === b.roomShare?.code;
}

/**
 * Install the presence reporter service.
 */
export function installPresence({
  bridge,
  store,
  socialStore = defaultSocialStore,
  getShareRoomCode = null,
  heartbeatMs = 45000,
  minIntervalMs = 1000,
  doc = typeof document !== 'undefined' ? document : null,
  setTimeoutFn = typeof setTimeout !== 'undefined' ? setTimeout : null,
  clearTimeoutFn = typeof clearTimeout !== 'undefined' ? clearTimeout : null,
} = {}) {
  let disposed = false;
  let inFlight = false;
  let pendingReport = false;
  let pendingForce = false;
  let lastReported = null;
  let lastReportedAt = 0;
  let debounceTimer = null;
  let heartbeatTimer = null;

  function isPageHidden() {
    return doc ? doc.visibilityState === 'hidden' : false;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (disposed || isPageHidden()) return;

    heartbeatTimer = setTimeoutFn(() => {
      void triggerReport(true);
      scheduleHeartbeat();
    }, heartbeatMs);
  }

  async function triggerReport(force = false) {
    if (disposed || !bridge || !bridge.isHostAvailable() || isPageHidden()) return;
    if (inFlight) {
      pendingReport = true;
      if (force) pendingForce = true;
      return;
    }
    const curState = store.get();
    const shareCode = typeof getShareRoomCode === 'function' ? getShareRoomCode() : null;
    const payload = buildPresencePayload(curState, { shareRoomCode: shareCode });

    const now = Date.now();
    const unchanged = isPresenceEqual(payload, lastReported);
    if (!force && unchanged && (now - lastReportedAt < heartbeatMs)) {
      return;
    }

    inFlight = true;
    try {
      const res = await bridge.touchGame(payload);
      if (res?.ok) {
        lastReported = payload;
        lastReportedAt = Date.now();
      }
    } catch (err) {
      console.warn('[presence] touchGame report failed', err);
    } finally {
      inFlight = false;
      if (pendingReport) {
        const forceNext = pendingForce;
        pendingReport = false;
        pendingForce = false;
        if (forceNext) {
          void triggerReport(true);
        } else {
          queueReport();
        }
      }
    }
  }

  function queueReport() {
    if (disposed || isPageHidden()) return;
    if (inFlight) {
      pendingReport = true;
      return;
    }
    if (debounceTimer) clearTimeoutFn(debounceTimer);

    const now = Date.now();
    const elapsed = now - lastReportedAt;
    const delay = elapsed >= minIntervalMs ? 0 : (minIntervalMs - elapsed);

    debounceTimer = setTimeoutFn(() => {
      void triggerReport();
    }, delay);
  }

  // Subscribe to game store changes
  const unsubscribeStore = store.subscribe(() => {
    queueReport();
  });

  // Subscribe to social store changes (e.g. room share toggle)
  const targetSocialStore = socialStore !== undefined ? socialStore : defaultSocialStore;
  const unsubscribeSocial = targetSocialStore?.subscribe?.((next, prev) => {
    if (next?.roomShareEnabled !== prev?.roomShareEnabled) {
      queueReport();
    }
  });

  // Handle visibility changes
  const onVisibilityChange = () => {
    if (!doc) return;
    if (doc.visibilityState === 'visible') {
      void triggerReport(true);
      scheduleHeartbeat();
    } else {
      stopHeartbeat();
      if (debounceTimer) {
        clearTimeoutFn(debounceTimer);
        debounceTimer = null;
      }
      pendingReport = false;
      pendingForce = false;
    }
  };

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  scheduleHeartbeat();

  return {
    reportNow: () => triggerReport(true),
    dispose: () => {
      disposed = true;
      pendingReport = false;
      pendingForce = false;
      stopHeartbeat();
      if (debounceTimer) clearTimeoutFn(debounceTimer);
      unsubscribeStore();
      if (typeof unsubscribeSocial === 'function') {
        unsubscribeSocial();
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
  };
}
