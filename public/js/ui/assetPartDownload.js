import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, ProgressBar, Spinner } from './components.js';
import { assetPartDownloader, formatBytes } from '../assetPartDownload.js';
import { t } from '../../../shared/i18n.js';

export function SegmentedProgressBar({ parts = [], totalBytes = 0, receivedBytes = 0, percent = 0 }) {
  if (!parts.length) {
    return html`<${ProgressBar}
      value=${receivedBytes}
      max=${totalBytes || 1}
      label=${`${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})`}
    />`;
  }

  return html`<div class="asset-parts-progress" data-testid="asset-parts-progress">
    <div class="asset-parts-bar" role="progressbar" aria-valuenow=${percent} aria-valuemin="0" aria-valuemax="100">
      ${parts.map((part) => {
        const title = `分包 #${part.index} (${formatBytes(part.bytes)}): ${
          part.status === 'completed' ? t('已完成')
          : part.status === 'importing' ? t('正在解压导入')
          : part.status === 'verifying' ? t('正在校验')
          : part.status === 'downloading' ? `${t('下载中')} ${part.percent}%`
          : t('排队中')
        }`;
        return html`<div
          key=${part.id}
          class=${`asset-part-seg is-${part.status}`}
          title=${title}
          aria-label=${title}
        >
          <div class="asset-part-seg__fill" style=${`width: ${part.percent}%;`}></div>
          <span class="asset-part-seg__num">${part.index}</span>
        </div>`;
      })}
    </div>
    <div class="asset-parts-summary">
      <span class="asset-parts-summary__pct">${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})</span>
      <span class="asset-parts-summary__count">${t('已完成 {done}/{total} 个分包', { done: parts.filter((p) => p.status === 'completed').length, total: parts.length })}</span>
    </div>
  </div>`;
}

export function AssetPartDownloadPanel({ onComplete }) {
  const [state, setState] = useState(() => assetPartDownloader.get());

  useEffect(() => {
    const unsubscribe = assetPartDownloader.subscribe(setState);
    return () => {
      unsubscribe();
    };
  }, []);

  const isDownloading = ['downloading', 'verifying', 'importing'].includes(state.phase);
  const checkProgress = state.checkProgress;
  const checkLabel = checkProgress?.stage === 'server' ? t('正在检查服务器素材…')
    : checkProgress?.stage === 'manifest' ? t('正在读取素材清单…')
    : checkProgress?.stage === 'worker' ? t('正在启用本地素材…')
    : t('正在检查本地素材…');

  return html`<div class="asset-part-downloader" data-testid="asset-part-downloader">
    ${state.phase === 'checking' ? checkProgress?.total > 0 ? html`
      <p role="status">
        ${checkLabel}${' '}
        ${checkProgress.stage === 'local'
          ? t('已检查 {done} / {total} 个分包', checkProgress)
          : t('已完成 {done} / {total} 个文件', checkProgress)}
      </p>
      <${ProgressBar} value=${checkProgress.done} max=${checkProgress.total} size="sm" />
    ` : html`<${Spinner} size="sm" label=${checkLabel} />` : null}
    ${state.phase === 'idle' ? html`
      ${!state.completedParts && !state.hasStagedParts ? html`<p class="t-lo">${t('初次进入需下载完整素材（包含干员模型、立绘、棋盘与语音包，约 814 MB）。建议在稳定网络下进行。')}</p>` : null}
      <div class="resource-manager__actions">
        <${Button} variant="primary" size="lg" block=${true} onClick=${() => assetPartDownloader.start()}>
          ${state.completedParts || state.hasStagedParts ? t('继续下载') : t('下载完整素材')}
        <//>
      </div>
    ` : null}

    ${isDownloading || state.phase === 'paused' ? html`
      <p class="asset-part-downloader__status" role="status">${state.statusText}</p>
      ${state.importProgress ? html`<p role="status">${t('正在解压导入')} ${state.importProgress.done} / ${state.importProgress.total}</p>` : null}
      <${SegmentedProgressBar}
        parts=${state.parts}
        totalBytes=${state.totalBytes}
        receivedBytes=${state.receivedBytes}
        percent=${state.percent}
      />
      <div class="asset-part-downloader__stats">
        <span>${state.speedText ? `${t('下载速度')}：${state.speedText}` : ''}</span>
        <span>${state.etaText ? `${state.etaText}` : ''}</span>
      </div>
      <div class="resource-manager__actions">
        ${state.phase === 'paused' ? html`
          <${Button} variant="primary" size="md" onClick=${() => assetPartDownloader.resume()}>
            ${t('继续下载')}
          <//>
        ` : html`
          <${Button} size="md" onClick=${() => assetPartDownloader.pause()}>
            ${t('暂停')}
          <//>
        `}
      </div>
    ` : null}

    ${state.phase === 'complete' ? html`
      <p class="t-mint" role="status">${t('所有素材分包已全部校验并解压就绪，可开始游戏！')}</p>
      <div class="resource-manager__actions">
        <${Button} variant="primary" size="lg" block=${true} iconRight="chevrons" onClick=${() => onComplete?.()}>
          ${t('进入大厅')}
        <//>
      </div>
    ` : null}

    ${state.phase === 'check_timeout' ? html`
      <p class="t-amber" role="alert">${t('请求超时，请重试')}</p>
      <div class="resource-manager__actions">
        <${Button} variant="primary" size="md" onClick=${() => assetPartDownloader.check({ retry: true })}>
          ${t('重新检查')}
        <//>
      </div>
    ` : null}

    ${state.phase === 'error' ? html`
      <p class="t-amber" role="alert">${state.statusText}</p>
      <div class="resource-manager__actions">
        <${Button} variant="primary" size="md" onClick=${() => assetPartDownloader.resume()}>
          ${t('重试下载')}
        <//>
      </div>
    ` : null}
  </div>`;
}
