import { el, findDisclaimerElement, svgIcon } from './dom-utils';
import {
  STORAGE_KEY_LOGS,
  resolveAccountScope,
  type RuntimeMessage,
  type UsageFailureReason,
  type UsageFramePostMessage,
  type UsagePool,
  type UsageSnapshot
} from './types';
import {
  formatCountdown,
  formatPoolResetCompact,
  formatResetClock,
  inspectUsageGraphQL,
  metricToneFromUsedPct
} from './usage-parser';

const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const STALE_CACHE_MS = 60_000;
const IFRAME_TIMEOUT_MS = 12_000;
const MAX_DIAG_LOGS = 24;

// Persisted query IDs from Google Gemini UsagePageSurface bundle (UsagePageRefetchQuery & UsagePageQuery)
const USAGE_QUERY_SIGNATURES = [
  '2/zVD7SCWMtztY2bUcQjS0lbVG6hHjwQA/Z1rS9LvrnY4=',
  '2/oee4e7iJB+YlSRDtGuxpv36rfWVddgii370z2JvCuVM='
];

function currentUsageUrl(): string {
  const { pathPrefix } = resolveAccountScope(window.location.pathname);
  return `https://gemini.google.com${pathPrefix}/usage`;
}

function currentGraphQLEndpoint(): string {
  const { pathPrefix } = resolveAccountScope(window.location.pathname);
  const forwarded = new URLSearchParams();
  const pageParams = new URLSearchParams(window.location.search);
  for (const key of ['e', 'expflags', 'exprollouts', 'mendeldebug']) {
    const val = pageParams.get(key);
    if (val) forwarded.set(key, val);
  }
  const qs = forwarded.toString();
  return `${window.location.origin}${pathPrefix}/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery${qs ? `?${qs}` : ''}`;
}

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
  private failureReason: UsageFailureReason | null = null;
  private failureDetail = '';
  private diagLogs: string[] = [];
  private copyToastText = '';
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
    const scope = resolveAccountScope(window.location.pathname);
    this.log(`mount path=${window.location.pathname} account=${scope.accountKey}`);
    this.attachToDisclaimer();
    this.render();

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<UsageFramePostMessage> | null;
      if (!data || data.source !== 'gwh-usage-frame') return;

      if (data.type === 'snapshot' && data.snapshot) {
        this.log(
          `iframe snapshot ok source=${data.snapshot.source} pools=${data.snapshot.pools
            .map((p) => `${p.label}:${p.remainingPct}%`)
            .join(',')}`
        );
        this.applySnapshot(data.snapshot);
        this.cleanupIframe();
      } else if (data.type === 'empty') {
        this.log(`iframe empty reason=${data.reason ?? 'unknown'} detail=${data.detail ?? '-'}`);
        this.loading = false;
        this.failureReason = data.reason ?? 'no_pools_in_page';
        this.failureDetail = data.detail ?? '';
        if (!this.snapshot) this.failed = true;
        this.cleanupIframe();
        this.render();
      }
    });

    try {
      chrome.runtime.onMessage.addListener((raw) => {
        const msg = raw as Partial<RuntimeMessage> | null;
        if (msg?.type === 'GWH_USAGE_UPDATE' && msg.snapshot) {
          const { accountKey } = resolveAccountScope(window.location.pathname);
          const msgAccount = msg.accountKey ?? msg.snapshot.accountKey ?? 'u0';
          if (msgAccount === accountKey) {
            this.applySnapshot(msg.snapshot);
          }
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
    const { storageKey } = resolveAccountScope(window.location.pathname);
    try {
      chrome.storage.local.get(storageKey, (items) => {
        const cached = items[storageKey] as UsageSnapshot | undefined;
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
    this.failureReason = null;
    this.failureDetail = '';
    this.render();
  }

  private log(msg: string): void {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
      2,
      '0'
    )}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const entry = `[${ts}] ${msg}`;
    this.diagLogs.push(entry);
    if (this.diagLogs.length > MAX_DIAG_LOGS) {
      this.diagLogs.splice(0, this.diagLogs.length - MAX_DIAG_LOGS);
    }
    try {
      // eslint-disable-next-line no-console
      console.info('[GeminiWebHUD]', entry);
      chrome.storage.local.set({ [STORAGE_KEY_LOGS]: [...this.diagLogs] });
    } catch {
      // ignore
    }
  }

  private broadcastAndPersist(snapshot: UsageSnapshot): void {
    const { accountKey } = resolveAccountScope(window.location.pathname);
    const tagged: UsageSnapshot = { ...snapshot, accountKey };
    try {
      const runtimeMsg: RuntimeMessage = {
        type: 'GWH_USAGE_UPDATE',
        accountKey,
        snapshot: tagged
      };
      chrome.runtime.sendMessage(runtimeMsg);
    } catch {
      // ignore
    }
  }

  private async tryDirectGraphQLFetch(): Promise<
    | { status: 'ok'; snapshot: UsageSnapshot }
    | { status: 'gate_disabled' }
    | { status: 'unauthenticated' }
    | { status: 'fallback' }
  > {
    const baseEndpoint = currentGraphQLEndpoint();
    const variablesJson = JSON.stringify({ g1Request: null, workspaceRequest: null });

    for (const sig of USAGE_QUERY_SIGNATURES) {
      const params = new URLSearchParams({
        query_signature: sig,
        variables: variablesJson
      });
      const url = `${baseEndpoint}${baseEndpoint.includes('?') ? '&' : '?'}${params.toString()}`;
      try {
        const res = await window.fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        });
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          this.log(`direct-gql status=${res.status} unauthenticated`);
          return { status: 'unauthenticated' };
        }
        if (!res.ok) {
          this.log(`direct-gql sig=${sig.slice(0, 10)} status=${res.status} len=${text.length}`);
          continue;
        }
        const inspected = inspectUsageGraphQL(text);
        this.log(
          `direct-gql sig=${sig.slice(0, 10)} status=200 len=${text.length} gate=${String(
            inspected.canSeeUsageLimits
          )} pools=${inspected.snapshot?.pools.length ?? 0}${
            inspected.errorMessages.length ? ` errs=${inspected.errorMessages.join('|')}` : ''
          }`
        );
        if (inspected.snapshot) {
          return { status: 'ok', snapshot: inspected.snapshot };
        }
        if (inspected.canSeeUsageLimits === false) {
          return { status: 'gate_disabled' };
        }
      } catch (err) {
        this.log(`direct-gql error=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: 'fallback' };
  }

  public refreshUsage(force: boolean): void {
    if (this.loading) return;
    if (!force && this.snapshot && Date.now() - this.snapshot.fetchedAt < STALE_CACHE_MS) {
      return;
    }

    this.loading = true;
    this.failed = false;
    this.failureReason = null;
    this.failureDetail = '';
    this.render();
    this.cleanupIframe();

    void (async () => {
      const direct = await this.tryDirectGraphQLFetch();
      if (direct.status === 'ok') {
        this.applySnapshot(direct.snapshot);
        this.broadcastAndPersist(direct.snapshot);
        return;
      }
      if (direct.status === 'gate_disabled') {
        this.loading = false;
        this.failureReason = 'feature_gate_disabled';
        this.failureDetail = 'canSeeUsageLimits=false';
        if (!this.snapshot) this.failed = true;
        this.render();
        return;
      }
      if (direct.status === 'unauthenticated') {
        this.loading = false;
        this.failureReason = 'login_required';
        if (!this.snapshot) this.failed = true;
        this.render();
        return;
      }

      // Fallback to hidden /usage iframe if persisted query signature changed
      const usageUrl = currentUsageUrl();
      this.log(`fallback to hidden iframe url=${usageUrl}`);
      const iframe = document.createElement('iframe');
      iframe.className = 'gwh-usage-hidden-iframe';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('tabindex', '-1');
      iframe.src = usageUrl;
      this.hiddenIframe = iframe;
      document.body.appendChild(iframe);

      this.iframeTimeout = window.setTimeout(() => {
        this.log('iframe timeout after 12s');
        this.loading = false;
        this.failureReason = 'iframe_blocked_or_timeout';
        if (!this.snapshot) this.failed = true;
        this.cleanupIframe();
        this.render();
      }, IFRAME_TIMEOUT_MS);
    })();
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

  private describeFailure(): { badge: string; detail: string } {
    switch (this.failureReason) {
      case 'feature_gate_disabled':
        return {
          badge: '⚠ 当前账号无用量面板',
          detail:
            'Google 服务端返回 canSeeUsageLimits=false（当前 Google 账号套餐如免费版/Workspace 企业号或所在节点暂未开放 5h/7d 用量面板）。可点右上角「打开 /usage」验证，也可点下方「复制诊断日志」发给开发者。'
        };
      case 'redirected_to_app':
        return {
          badge: '⚠ 账号未开放 /usage',
          detail:
            '访问 /usage 时被服务端自动跳回聊天页（免费账号、部分企业 Workspace 账号或当前代理节点地区可能暂未开放 Usage Limits 面板）。'
        };
      case 'login_required':
        return {
          badge: '⚠ 需重新登录 (/usage)',
          detail: '读取用量接口返回未认证状态，请刷新页面重新登录 Google 账号后再试。'
        };
      case 'no_pools_in_page':
        return {
          badge: '⚠ 未识别到额度池 (/usage)',
          detail: `/usage 页面已加载${this.failureDetail ? ` (${this.failureDetail})` : ''}，但未返回 5h / 7d 额度池数据。请点击下方「复制诊断日志」粘贴排查。`
        };
      case 'iframe_blocked_or_timeout':
      default:
        return {
          badge: '⚠ 余额读取超时 (/usage)',
          detail:
            '读取 /usage 超过 12 秒未响应，请确认已在 chrome://extensions 点击扩展刷新按钮（⟳）并刷新本页，或点下方「复制诊断日志」。'
        };
    }
  }

  private createCopyLogsButton(): HTMLElement {
    const btn = el('button', {
      className: 'gwh-copy-logs-btn',
      text: this.copyToastText || '复制诊断日志',
      attrs: { type: 'button' }
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const report = [
        `url: ${window.location.href}`,
        `ua: ${navigator.userAgent}`,
        ...this.diagLogs
      ].join('\n');
      navigator.clipboard?.writeText(report).then(
        () => {
          this.copyToastText = '已复制日志 ✓';
          this.renderPopover();
          window.setTimeout(() => {
            this.copyToastText = '';
            this.renderPopover();
          }, 1800);
        },
        () => {
          this.copyToastText = '复制失败，请看 F12 Console';
          this.renderPopover();
        }
      );
    });
    return btn;
  }

  private renderPopover(): void {
    this.popoverEl.replaceChildren();
    const usageUrl = currentUsageUrl();

    const header = el(
      'div',
      { className: 'gwh-pop-header' },
      el('span', { className: 'gwh-pop-title', text: 'Gemini 对话额度余额' }),
      el('a', {
        className: 'gwh-pop-link',
        text: '打开 /usage ↗',
        attrs: {
          href: usageUrl,
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
        el(
          'div',
          { className: 'gwh-pop-foot-row' },
          el('span', {
            className: 'gwh-pop-foot-text',
            text: `${this.snapshot.source === 'graphql' ? 'GraphQL 直连' : 'DOM'} · 更新于 ${syncTime}`
          }),
          this.createCopyLogsButton()
        )
      );
    } else if (this.loading) {
      this.popoverEl.appendChild(
        el('div', {
          className: 'gwh-pop-empty',
          text: `正在请求 ${usageUrl.replace('https://', '')} 真实额度…`
        })
      );
    } else if (this.failed) {
      const info = this.describeFailure();
      this.popoverEl.appendChild(
        el('div', {
          className: 'gwh-pop-empty gwh-pop-error',
          text: info.detail
        })
      );
      if (this.diagLogs.length > 0) {
        this.popoverEl.appendChild(
          el('pre', {
            className: 'gwh-pop-log',
            text: this.diagLogs.slice(-4).join('\n')
          })
        );
      }
      this.popoverEl.appendChild(
        el('div', { className: 'gwh-pop-foot-row' }, this.createCopyLogsButton())
      );
    } else {
      this.popoverEl.appendChild(
        el('div', {
          className: 'gwh-pop-empty',
          text: '点击右侧刷新按钮或打开 /usage 页面即可同步额度。'
        })
      );
      this.popoverEl.appendChild(
        el('div', { className: 'gwh-pop-foot-row' }, this.createCopyLogsButton())
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
      const info = this.describeFailure();
      const link = el('a', {
        className: 'gwh-usage-fallback-link gwh-usage-warn-link',
        text: info.badge,
        attrs: {
          href: currentUsageUrl(),
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
