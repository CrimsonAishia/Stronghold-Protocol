// public/js/ui/roomChat.js — built-in multiplayer room chat.
import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { createStore, useStore, store } from '../store.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

export const CHAT_MAX_LEN = 200;
export const CHAT_MAX_MESSAGES = 50;

/**
 * Creates an isolated chat manager instance (used for default app singleton and testing).
 * @param {{ store: any, net: any, t?: (msgid: string) => string }} deps
 */
export function createChatManager({ store: appStore, net: appNet, t: tr = t }) {
  const chatStore = createStore({
    open: false,
    messages: [],
    unread: 0,
    draft: '',
    sending: false,
    error: null,
  });

  let lastChatId = null;
  let lastRoomCode = null;
  let lastNetStatus = appNet.status || 'disconnected';
  let sendSeq = 0;

  function setOpen(open) {
    if (open) {
      chatStore.set({ open: true, unread: 0 });
    } else {
      chatStore.set({ open: false });
    }
  }

  function setDraft(draft) {
    chatStore.set({ draft, error: null });
  }

  function clearError() {
    chatStore.set({ error: null });
  }

  function fetchHistory() {
    const room = appStore.get().room;
    if (!room || room.mode !== 'coop' || !room.chatId || appNet.status !== 'online') return Promise.resolve();
    return appNet.request('room.chatHistory').catch(() => {});
  }

  async function sendMessage(text) {
    const cur = chatStore.get();
    if (cur.sending) return false;
    const submitted = text !== undefined ? text : cur.draft;
    const raw = submitted
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!raw) return false;
    if (raw.length > CHAT_MAX_LEN) return false;

    const room = appStore.get().room;
    if (!room || room.mode !== 'coop' || !room.chatId || appNet.status !== 'online') {
      chatStore.set({ error: tr('未连接或不在房间中') });
      return false;
    }

    const targetChatId = room.chatId;
    const curSeq = ++sendSeq;

    chatStore.set({ sending: true, error: null });
    try {
      await appNet.request('room.chat', { text: raw, chatId: targetChatId });
      const currentRoom = appStore.get().room;
      if (currentRoom?.chatId === targetChatId && curSeq === sendSeq) {
        chatStore.set({ sending: false, draft: chatStore.get().draft === submitted ? '' : chatStore.get().draft, error: null });
      }
      return true;
    } catch (err) {
      const currentRoom = appStore.get().room;
      if (currentRoom?.chatId === targetChatId && curSeq === sendSeq) {
        let errText = tr('发送失败，请重试');
        if (err?.code === 'RATE') errText = tr('发送太快，请稍后再试');
        else if (err?.code === 'NOT_IN_ROOM' || err?.code === 'OFFLINE' || err?.code === 'DISCONNECTED') {
          errText = tr('未连接或不在房间中');
        }
        chatStore.set({ sending: false, error: errText });
      }
      return false;
    }
  }

  function onChatMessage(msg) {
    const room = appStore.get().room;
    if (!room || room.mode !== 'coop' || !msg || msg.chatId !== room.chatId) return;
    const current = chatStore.get();
    if (current.messages.some((m) => m.seq === msg.seq)) return;

    const nextMessages = [...current.messages, msg].slice(-CHAT_MAX_MESSAGES);
    const nextUnread = current.open ? 0 : current.unread + 1;
    chatStore.set({ messages: nextMessages, unread: nextUnread });
  }

  function onChatHistory(msg) {
    const room = appStore.get().room;
    if (!room || room.mode !== 'coop' || !msg || msg.chatId !== room.chatId) return;
    const current = chatStore.get();
    const bySeq = new Map();
    for (const m of current.messages) if (m && Number.isInteger(m.seq)) bySeq.set(m.seq, m);
    for (const m of msg.messages || []) if (m && Number.isInteger(m.seq)) bySeq.set(m.seq, m);
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-CHAT_MAX_MESSAGES);
    chatStore.set({ messages: merged });
  }

  function onNetStatus(snap) {
    const prevStatus = lastNetStatus;
    const nextStatus = snap?.status || appNet.status;
    lastNetStatus = nextStatus;

    if (prevStatus !== 'online' && nextStatus === 'online') {
      const room = appStore.get().room;
      if (room && room.mode === 'coop' && room.chatId) {
        fetchHistory();
      }
    }
  }

  function onStoreChange(s) {
    const room = s.room;
    if (!room || room.mode !== 'coop' || !room.chatId) {
      if (lastChatId != null || lastRoomCode != null) {
        lastChatId = null;
        lastRoomCode = null;
        sendSeq++;
        chatStore.set({ messages: [], unread: 0, draft: '', error: null, sending: false, open: false });
      }
      return;
    }

    if (room.chatId !== lastChatId) {
      lastChatId = room.chatId;
      lastRoomCode = room.code;
      sendSeq++;
      chatStore.set({ messages: [], unread: 0, draft: '', error: null, sending: false });
      if (appNet.status === 'online') {
        fetchHistory();
      }
    }
  }

  const unNetChat = appNet.on?.('m.chat', onChatMessage);
  const unNetHistory = appNet.on?.('m.chat.history', onChatHistory);
  const unNetStatus = appNet.on?.('status', onNetStatus);
  const unStore = appStore.subscribe?.(onStoreChange);

  // Initialize tracking with current store state
  onStoreChange(appStore.get());

  function dispose() {
    if (typeof unNetChat === 'function') unNetChat();
    else appNet.off?.('m.chat', onChatMessage);
    if (typeof unNetHistory === 'function') unNetHistory();
    else appNet.off?.('m.chat.history', onChatHistory);
    if (typeof unNetStatus === 'function') unNetStatus();
    else appNet.off?.('status', onNetStatus);
    if (typeof unStore === 'function') unStore();
  }

  return {
    chatStore,
    setOpen,
    setDraft,
    clearError,
    sendMessage,
    fetchHistory,
    dispose,
  };
}

export const defaultChatManager = createChatManager({ store, net, t });
export const chatStore = defaultChatManager.chatStore;
export const setChatOpen = defaultChatManager.setOpen;
export const sendChatMessage = defaultChatManager.sendMessage;

/**
 * Shared Room Chat component for Room Screen and Game Screen.
 * @param {{ inGame?: boolean }} props
 */
export function RoomChat({ inGame = false }) {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const chat = useStore((s) => s, Object.is, chatStore);
  const inputRef = useRef(null);
  const messagesRef = useRef(null);
  const panelRef = useRef(null);

  if (!room || room.mode !== 'coop') return null;

  const lastSeq = chat.messages[chat.messages.length - 1]?.seq ?? null;

  // Autoscroll to bottom on message updates or open
  useEffect(() => {
    if (chat.open && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [chat.open, lastSeq]);

  // Focus input when opened
  useEffect(() => {
    if (chat.open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [chat.open]);

  // Close when clicking outside panel
  useEffect(() => {
    if (!chat.open) return undefined;
    const onPointerDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest('.room-chat-toggle')) {
        defaultChatManager.setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [chat.open]);

  const handleToggle = () => {
    defaultChatManager.setOpen(!chat.open);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    defaultChatManager.sendMessage();
  };

  return html`<div class="room-chat-host">
    <button
      type="button"
      class=${inGame ? `gm__gear gm__chat-btn room-chat-toggle${chat.open ? ' is-on' : ''}` : `rs-chat-btn room-chat-toggle${chat.open ? ' is-on' : ''}`}
      aria-label=${t('房间聊天')}
      title=${chat.unread ? `${t('房间聊天')} (${chat.unread})` : t('房间聊天')}
      aria-expanded=${chat.open ? 'true' : 'false'}
      onClick=${handleToggle}
    >
      <${Icon} name="chat" />
      ${inGame ? null : html`<span class="rs-chat-btn__label">${t('房间聊天')}</span>`}
      ${chat.unread > 0 ? html`<span class="chat-badge">${chat.unread > 99 ? '99+' : chat.unread}</span>` : null}
    </button>

    ${chat.open ? html`<div class="room-chat-panel" ref=${panelRef} role="dialog" aria-label=${t('房间聊天')}>
      <div class="room-chat__header">
        <span class="room-chat__title">
          <${Icon} name="chat" />
          <span>${t('房间聊天')}</span>
        </span>
        <button
          type="button"
          class="room-chat__close"
          onClick=${() => defaultChatManager.setOpen(false)}
          title=${t('收起')}
          aria-label=${t('收起')}
        >
          <${Icon} name="close" />
        </button>
      </div>

      <div class="room-chat__messages" ref=${messagesRef} role="log" aria-live="polite">
        ${chat.messages.length === 0
          ? html`<div class="room-chat__empty">${t('暂无聊天记录')}</div>`
          : chat.messages.map((m) => {
              const isMine = m.playerId === me?.playerId;
              return html`<div key=${m.seq} class=${`room-chat__line${isMine ? ' is-me' : ''}`}>
                <span class="room-chat__author">${m.name}:</span>
                <span class="room-chat__text">${m.text}</span>
              </div>`;
            })}
      </div>

      ${chat.error ? html`<div class="room-chat__error" role="status">${chat.error}</div>` : null}

      <form class="room-chat__compose" onSubmit=${handleSubmit}>
        <input
          ref=${inputRef}
          class="room-chat__input"
          type="text"
          maxlength=${CHAT_MAX_LEN}
          placeholder=${t('输入消息…')}
          aria-label=${t('聊天消息')}
          value=${chat.draft}
          onInput=${(e) => defaultChatManager.setDraft(e.target.value)}
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              defaultChatManager.setOpen(false);
              return;
            }
            if (e.key === 'Enter') {
              if (e.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              defaultChatManager.sendMessage();
            }
          }}
          onKeyUp=${(e) => e.stopPropagation()}
        />
        <button
          type="submit"
          class="room-chat__send btn btn--primary"
          disabled=${chat.sending || !chat.draft.trim()}
        >
          ${t('发送')}
        </button>
      </form>
    </div>` : null}
  </div>`;
}
