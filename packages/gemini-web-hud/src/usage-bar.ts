import { el, findDisclaimerElement, svgIcon } from './dom-utils';
import {
  STORAGE_KEY_USAGE,
  type RuntimeMessage,
  type UsageFramePostMessage,
  type UsagePool,
  type UsageSnapshot
} from './types';
import {
  formatCountdown,
  formatPoolResetCompact,
  formatResetClock,
  metricToneFromUsedPct
} from './usage-parser';

const USAGE_PAGE_URL = 'https://gemini.google.com/usage';
const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const STALE_CACHE_MS = 60_000;
const IFRAME_TIMEOUT_MS = 12_000;

function isGeneratingNow(): boolean {
  const stopSelectors = [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
    'button[data-test-id="stop-button"]',
    '.stop-icon'
  ];
  for (const sel of stopSelectors) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node && node.offsetParent !== null) return true;
  }
  return false;
}

export class UsageBarController {
  private root: HTMLElement;
  private poolsWrap: HTMLElement;
  private popoverEl: HTMLElement;
  private refreshBtn: HTMLButtonElement;
  private attachedHost: HTMLElement | null = null;
  private snapshot: UsageSnapshot | null = null;
  private loading = false;
  private failed = false;
  private hiddenIframe: HTMLIFrameElement | null = null;
  private iframeTimeout: number | null = null;
  private tickTimer: number | null = null;
  private pollTimer: number | null = null;
  private wasGenerating = false;
  private domObserver: MutationObserver | null = null;
  private genDebounceTimer: number | null = null;
  private attachTimer: number | null = null;

  constructor() {
    this.poolsWrap = el('span', { className: 'gwh-usage-pools' });
    this.popoverEl = el('div', { className: 'gwh-usage-popover', attrs: { role: 'tooltip' } });

    this.refreshBtn = el(
      'button',
      {
        className: 'gwh-usage-refresh',
        title: '立即同步 /usage 真实余额',
        attrs: { type: 'button', 'aria-label': '刷新对话余额' }
      },
      svgIcon(['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'], 11)
    );
    this.refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.refreshUsage(true);
    });

    const divider = el('span', { className: 'gwh-inline-divider', text: '·' });
    const inlineRow = el(
      'span',
      { className: 'gwh-usage-inline-content' },
      divider,
      this.poolsWrap,
      this.refreshBtn
    );

    this.root = el('span', { className: 'gwh-usage-inline' }, this.popoverEl, inlineRow);
  }

  public mount(): void {
    this.attachToDisclaimer();
    this.render();

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<UsageFramePostMessage> | null;
      if (!data || data.source !== 'gwh-usage-frame') return;

      if (data.type === 'snapshot' && data.snapshot) {
        this.applySnapshot(data.snapshot);
        this.cleanupIframe();
      } else if (data.type === 'empty') {
        this.loading = false;
        if (!this.snapshot) this.failed = true;
        this.cleanupIframe();
        this.render();
      }
    });

    try {
      chrome.runtime.onMessage.addListener((raw) => {
        const msg = raw as Partial<RuntimeMessage> | null;
        if (msg?.type === 'GWH_USAGE_UPDATE' && msg.snapshot) {
          this.applySnapshot(msg.snapshot);
        }
      });
    } catch {
      // ignore
    }

    this.loadCachedAndRefresh();

    this.tickTimer = window.setInterval(() => {
      if (this.snapshot) this.render();
    }, 30_000);

    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        this.refreshUsage(false);
      }
    }, AUTO_REFRESH_INTERVAL_MS);

    this.domObserver = new MutationObserver(() => {
      // Re-attach if Angular replaced the disclaimer row
      if (!this.root.isConnected || !this.attachedHost?.isConnected) {
        this.scheduleAttach();
      }

      // Refresh right after Gemini finishes streaming a reply
      const generating = isGeneratingNow();
      if (generating) {
        this.wasGenerating = true;
      } else if (this.wasGenerating) {
        this.wasGenerating = false;
        if (this.genDebounceTimer !== null) window.clearTimeout(this.genDebounceTimer);
        this.genDebounceTimer = window.setTimeout(() => {
          this.genDebounceTimer = null;
          this.refreshUsage(true);
        }, 1500);
      }
    });
    this.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  public setTheme(dark: boolean): void {
    this.root.classList.toggle('gwh-dark', dark);
  }

  public onRouteChange(): void {
    this.scheduleAttach(150);
    window.setTimeout(() => this.attachToDisclaimer(), 650);
  }

  private scheduleAttach(delayMs = 200): void {
    if (this.attachTimer !== null) window.clearTimeout(this.attachTimer);
    this.attachTimer = window.setTimeout(() => {
      this.attachTimer = null;
      this.attachToDisclaimer();
    }, delayMs);
  }

  private attachToDisclaimer(): void {
    const disclaimer = findDisclaimerElement();
    if (disclaimer) {
      // Already mounted cleanly inside this disclaimer
      if (this.attachedHost === disclaimer && this.root.isConnected && disclaimer.contains(this.root)) {
        return;
      }
      this.attachedHost = disclaimer;
      this.root.classList.remove('gwh-usage-fallback-fixed');
      disclaimer.classList.add('gwh-disclaimer-host');
      disclaimer.appendChild(this.root);
      return;
    }

    // Fallback when disclaimer isn't rendered yet: place subtle inline text at bottom center
    if (!this.root.isConnected) {
      this.attachedHost = null;
      this.root.classList.add('gwh-usage-fallback-fixed');
      document.body.appendChild(this.root);
    }
  }

  private loadCachedAndRefresh(): void {
    try {
      chrome.storage.local.get(STORAGE_KEY_USAGE, (items) => {
        const cached = items[STORAGE_KEY_USAGE] as UsageSnapshot | undefined;
        if (cached && Array.isArray(cached.pools) && cached.pools.length > 0) {
          this.snapshot = cached;
          this.render();
          if (Date.now() - cached.fetchedAt > STALE_CACHE_MS) {
            this.refreshUsage(false);
          }
        } else {
          this.refreshUsage(true);
        }
      });
    } catch {
      this.refreshUsage(true);
    }
  }

  private applySnapshot(snapshot: UsageSnapshot): void {
    this.snapshot = snapshot;
    this.loading = false;
    this.failed = false;
    this.render();
  }

  public refreshUsage(force: boolean): void {
    if (this.loading) return;
    if (!force && this.snapshot && Date.now() - this.snapshot.fetchedAt < STALE_CACHE_MS) {
      return;
    }

    this.loading = true;
    this.failed = false;
    this.render();
    this.cleanupIframe();

    const iframe = document.createElement('iframe');
    iframe.className = 'gwh-usage-hidden-iframe';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.src = USAGE_PAGE_URL;
    this.hiddenIframe = iframe;
    document.body.appendChild(iframe);

    this.iframeTimeout = window.setTimeout(() => {
      this.loading = false;
      if (!this.snapshot) this.failed = true;
      this.cleanupIframe();
      this.render();
    }, IFRAME_TIMEOUT_MS);
  }

  private cleanupIframe(): void {
    if (this.iframeTimeout !== null) {
      window.clearTimeout(this.iframeTimeout);
      this.iframeTimeout = null;
    }
    if (this.hiddenIframe) {
      this.hiddenIframe.remove();
      this.hiddenIframe = null;
    }
  }

  private createPctRing(pct: number, tone: string): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const r = 5.6;
    const circ = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, pct));
    const offset = circ * (1 - clamped / 100);

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', `gwh-ring gwh-tone-${tone}`);
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');

    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('class', 'gwh-ring-track');
    track.setAttribute('cx', '8');
    track.setAttribute('cy', '8');
    track.setAttribute('r', String(r));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '2.3');

    const arc = document.createElementNS(ns, 'circle');
    arc.setAttribute('class', 'gwh-ring-arc');
    arc.setAttribute('cx', '8');
    arc.setAttribute('cy', '8');
    arc.setAttribute('r', String(r));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '2.3');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', circ.toFixed(2));
    arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
    arc.setAttribute('transform', 'rotate(-90 8 8)');

    svg.append(track, arc);
    return svg;
  }

  private renderPoolChip(pool: UsagePool): HTMLElement {
    const tone = metricToneFromUsedPct(pool.usedPct);
    const countdown = formatPoolResetCompact(pool);
    const label = el('span', { className: 'gwh-pool-label', text: pool.label });
    const ring = this.createPctRing(pool.remainingPct, tone);
    const pct = el('span', {
      className: `gwh-pool-pct gwh-tone-${tone}`,
      text: `${pool.remainingPct}%`
    });

    const parts: Array<Node | null> = [label, ring, pct];
    if (countdown) {
      parts.push(el('span', { className: 'gwh-pool-reset', text: countdown }));
    }
    return el('span', { className: 'gwh-pool-chip' }, ...parts);
  }

  private renderPopover(): void {
    this.popoverEl.replaceChildren();

    const header = el(
      'div',
      { className: 'gwh-pop-header' },
      el('span', { className: 'gwh-pop-title', text: 'Gemini 对话额度余额' }),
      el('a', {
        className: 'gwh-pop-link',
        text: '打开 /usage ↗',
        attrs: {
          href: USAGE_PAGE_URL,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      })
    );
    this.popoverEl.appendChild(header);

    if (this.snapshot && this.snapshot.pools.length > 0) {
      for (const pool of this.snapshot.pools) {
        const tone = metricToneFromUsedPct(pool.usedPct);
        const titleText =
          pool.kind === '5h'
            ? '5 小时窗口'
            : pool.kind === '7d'
              ? '每周窗口 (7d)'
              : pool.label;
        const resetClock = formatResetClock(pool.resetAtIso);
        const countdown = formatCountdown(pool.resetAtIso);
        const resetSummary = resetClock
          ? `${resetClock} 重置（${countdown ?? ''}）`
          : pool.resetText || '等待重置信息';

        const barFill = el('div', { className: `gwh-pop-bar-fill gwh-tone-bg-${tone}` });
        barFill.style.width = `${pool.remainingPct}%`;

        const row = el(
          'div',
          { className: 'gwh-pop-row' },
          el(
            'div',
            { className: 'gwh-pop-row-top' },
            el('span', { className: 'gwh-pop-pool-name', text: titleText }),
            el('span', {
              className: `gwh-pop-pool-val gwh-tone-${tone}`,
              text: `剩余 ${pool.remainingPct}% · 已用 ${pool.usedPct}%`
            })
          ),
          el('div', { className: 'gwh-pop-bar' }, barFill),
          el('div', { className: 'gwh-pop-reset', text: resetSummary })
        );
        this.popoverEl.appendChild(row);
      }

      const syncDate = new Date(this.snapshot.fetchedAt);
      const syncTime = `${String(syncDate.getHours()).padStart(2, '0')}:${String(
        syncDate.getMinutes()
      ).padStart(2, '0')}:${String(syncDate.getSeconds()).padStart(2, '0')}`;
      this.popoverEl.appendChild(
        el('div', {
          className: 'gwh-pop-foot',
          text: `数据来源：gemini.google.com/usage（${this.snapshot.source === 'graphql' ? 'GraphQL' : 'DOM'}）· 更新于 ${syncTime}`
        })
      );
    } else {
      this.popoverEl.appendChild(
        el('div', {
          className: 'gwh-pop-empty',
          text: this.loading
            ? '正在静默读取 gemini.google.com/usage 真实额度…'
            : '暂未读取到额度池，请点击右侧刷新或打开 /usage 页面查看登录状态。'
        })
      );
    }
  }

  private render(): void {
    this.refreshBtn.classList.toggle('gwh-spinning', this.loading);
    this.poolsWrap.replaceChildren();

    if (this.snapshot && this.snapshot.pools.length > 0) {
      this.snapshot.pools.forEach((pool, idx) => {
        if (idx > 0) {
          this.poolsWrap.appendChild(el('span', { className: 'gwh-sep', text: '·' }));
        }
        this.poolsWrap.appendChild(this.renderPoolChip(pool));
      });
    } else if (this.loading) {
      this.poolsWrap.appendChild(
        el('span', { className: 'gwh-usage-status', text: '余额同步中…' })
      );
    } else if (this.failed) {
      const link = el('a', {
        className: 'gwh-usage-fallback-link',
        text: '余额未读取 (/usage)',
        attrs: {
          href: USAGE_PAGE_URL,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      });
      this.poolsWrap.appendChild(link);
    } else {
      this.poolsWrap.appendChild(
        el('span', { className: 'gwh-usage-status', text: '余额待同步' })
      );
    }

    this.renderPopover();
  }

  public destroy(): void {
    this.cleanupIframe();
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.domObserver?.disconnect();
    this.root.remove();
  }
}
