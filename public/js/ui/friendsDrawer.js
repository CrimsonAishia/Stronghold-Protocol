// Friends Drawer UI component (Preact + htm).
//
// Follows Stronghold Protocol design system and BakaBox integration spec.
// - Pure client UI with accessible keyboard controls (Escape to close).
// - Fallback avatar rendering with error prevention.
// - Support for filter tabs (All / Online) and search query.
// - "Join Room" button when friend has shared active waiting room code.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel } from './components.js';
import { useStore } from '../store.js';
import { socialStore } from '../social/store.js';
import { getSocialService } from '../social/service.js';
import { filterFriends } from '../social/friendModel.js';
import { t } from '../../../shared/i18n.js';

function AvatarImage({ src, name }) {
  const [failed, setFailed] = useState(false);
  const firstChar = (name || '?').slice(0, 1).toUpperCase();

  if (!src || failed) {
    return html`<div class="friends-avatar" aria-hidden="true">${firstChar}</div>`;
  }

  return html`<div class="friends-avatar">
    <img src=${src} alt="" onError=${() => setFailed(true)} />
  </div>`;
}

function StatusPill({ status }) {
  let label = t('离线');
  if (status === 'online') label = t('在线');
  else if (status === 'in_run') label = t('作战中');
  else if (status === 'unknown') label = t('状态未知');

  return html`<span class="friend-status-pill is-${status}">${label}</span>`;
}

function FriendRow({ friend, onJoinRoom }) {
  const progress = friend.progress;
  const roomCode = progress?.roomShare?.code;

  let progressText = progress?.statusLabel || '';
  if (progress?.detailText) {
    progressText = progressText ? `${progressText} · ${progress.detailText}` : progress.detailText;
  }

  return html`<div class="friend-item-card">
    <div class="friend-item-main">
      <${AvatarImage} src=${friend.avatar} name=${friend.name} />
      <div class="friend-item-meta">
        <div class="friend-item-name-row">
          <span class="friend-item-name" title=${friend.name}>${friend.name}</span>
          ${friend.tag ? html`<span class="friend-item-tag">#${friend.tag}</span>` : null}
        </div>
      </div>
      <${StatusPill} status=${friend.status} />
    </div>

    ${progressText || roomCode ? html`
      <div class="friend-progress-row">
        <span class="friend-progress-desc" title=${progressText}>${progressText || t('正在游戏中')}</span>
        ${roomCode && onJoinRoom ? html`
          <${Button}
            variant="primary"
            size="sm"
            onClick=${() => onJoinRoom(roomCode)}
          >${t('加入同盟')}<//>
        ` : null}
      </div>
    ` : null}
  </div>`;
}

export function FriendsDrawer({ service, onJoinRoom }) {
  const open = useStore((s) => s.drawerOpen, Object.is, socialStore);
  const loading = useStore((s) => s.loading, Object.is, socialStore);
  const error = useStore((s) => s.error, Object.is, socialStore);
  const isStale = useStore((s) => s.isStale, Object.is, socialStore);
  const selfProfile = useStore((s) => s.selfProfile, Object.is, socialStore);
  const friends = useStore((s) => s.friends, Object.is, socialStore);
  const filter = useStore((s) => s.filter, Object.is, socialStore);
  const searchQuery = useStore((s) => s.searchQuery, Object.is, socialStore);

  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        service.closeDrawer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, service]);

  if (!open) return null;

  const filtered = filterFriends(friends, { filter, query: searchQuery });

  return html`<div
    class="friends-drawer-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label=${t('好友与同盟')}
    onClick=${(ev) => { if (ev.target === ev.currentTarget) service.closeDrawer(); }}
  >
    <div class="friends-drawer-panel" ref=${panelRef}>
      <header class="friends-drawer-header">
        <div class="friends-drawer-title-group">
          <${MicroLabel} tone="mint">BAKABOX<//>
          <h2 class="friends-drawer-title">${t('好友列表')}</h2>
        </div>
        <${Button}
          variant="icon"
          icon="close"
          aria-label=${t('关闭')}
          onClick=${() => service.closeDrawer()}
        />
      </header>

      ${selfProfile && selfProfile.isLoggedIn !== false && (selfProfile.uid || selfProfile.username) ? html`
        <div class="friends-self-card">
          <${AvatarImage} src=${selfProfile.avatar} name=${selfProfile.username} />
          <div class="friends-self-info">
            <span class="friends-self-name">${selfProfile.username || t('玩家本人')}</span>
            <span class="friends-self-uid">UID: ${selfProfile.uid || selfProfile.businessUserId || '--'}</span>
          </div>
          <span class="friend-status-pill is-online">${t('本人在线')}</span>
        </div>
      ` : html`
        <div class="friends-self-card">
          <div class="friends-self-info">
            <span class="friends-self-name">${t('宿主环境未登录')}</span>
            <span class="friends-self-uid">${t('登录后可同步好友与进度')}</span>
          </div>
        </div>
      `}

      <div class="friends-controls">
        <div class="friends-search-row">
          <input
            type="search"
            class="friends-search-input"
            placeholder=${t('搜索昵称或编号...')}
            value=${searchQuery}
            onInput=${(ev) => service.setSearchQuery(ev.target.value)}
          />
        </div>
        <div class="friends-filter-tabs">
          <button
            type="button"
            class="friends-tab-btn ${filter === 'all' ? 'is-active' : ''}"
            onClick=${() => service.setFilter('all')}
          >
            ${t('全部')} (${friends.length})
          </button>
          <button
            type="button"
            class="friends-tab-btn ${filter === 'online' ? 'is-active' : ''}"
            onClick=${() => service.setFilter('online')}
          >
            ${t('在线')}
          </button>
        </div>
      </div>

      ${isStale ? html`
        <div class="friends-stale-banner">
          <span>${t('正在更新好友数据，当前显示缓存')}</span>
          <${Button}
            variant="ghost"
            size="sm"
            onClick=${() => service.refreshFriends()}
          >${t('重试')}<//>
        </div>
      ` : null}

      <div class="friends-list">
        ${loading && friends.length === 0 ? html`
          <div class="friends-empty-box">
            <span class="friends-empty-title">${t('正在同步好友数据...')}</span>
          </div>
        ` : null}

        ${!loading && error && friends.length === 0 ? html`
          <div class="friends-empty-box">
            <span class="friends-empty-title">${t('同步失败，请检查宿主环境')}</span>
            <${Button}
              variant="primary"
              size="sm"
              onClick=${() => service.refreshFriends()}
            >${t('重新加载')}<//>
          </div>
        ` : null}

        ${!loading && !error && friends.length === 0 ? html`
          <div class="friends-empty-box">
            <span class="friends-empty-title">${t('暂无同玩好友')}</span>
            <span class="t-lo">${t('好友从 BakaBox 运行本游戏后将在此显示')}</span>
          </div>
        ` : null}

        ${friends.length > 0 && filtered.length === 0 ? html`
          <div class="friends-empty-box">
            <span class="friends-empty-title">${t('未找到匹配的好友')}</span>
          </div>
        ` : null}

        ${filtered.map((friend) => html`
          <${FriendRow}
            key=${friend.id}
            friend=${friend}
            onJoinRoom=${onJoinRoom}
          />
        `)}
      </div>
    </div>
  </div>`;
}

/**
 * Topbar or lobby button to toggle friends drawer.
 */
export function FriendsDrawerButton({ service, class: className = '' }) {
  const available = useStore((s) => s.hostAvailable, Object.is, socialStore);
  const svc = service || getSocialService();
  if (!available || !svc) return null;

  return html`<${Button}
    variant="ghost"
    size="sm"
    icon="users"
    class=${className}
    onClick=${() => svc.toggleDrawer()}
    aria-label=${t('好友列表')}
  >
    ${t('好友')}
  <//>`;
}
