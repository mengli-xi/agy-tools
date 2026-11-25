interface BootPayload {
  version: string;
  enabled: boolean;
}

interface PanelSubscription {
  paneKey: string;
  cascadeId: string;
  modelLabel: string;
}

interface RenderItem {
  paneKey: string;
  cascadeId: string;
  hasContent: boolean;
  inlineHtml: string;
  toolbarHtml?: string;
  toolbarCompactHtml?: string;
  toolbarCoexistHtml?: string;
  quotaHtml?: string;
  tooltipHtml: string;
}

interface AgStatuslineWindow extends Window {
  __APP_CONFIG__?: { productName?: string };
  electronNative?: {
    setTitleBarOverlay?: unknown;
    getZoomLevel?: unknown;
    wcvBrowser?: { setThemeColor?: unknown };
  };
  nativeStorage?: { getItems?: unknown };
  __AG_STATUSLINE_BOOT__?: BootPayload;
  __ag_statusline_version?: string;
  __ag_statusline_ready?: boolean;
  __ag_statusline_skip_non_host?: boolean;
  __ag_statusline_boot_dcl?: (() => void) | null;
  __ag_statusline_doc_obs?: MutationObserver | null;
  __ag_statusline_cleanup?: Array<() => void>;
  __ag_statusline_pane_seq?: number;
  __ag_statusline_payload_by_pane?: Record<string, RenderItem>;
  __ag_statusline_active_tt_bar?: HTMLElement | null;
  __ag_statusline_selected_pool?: string | null;
  __ag_statusline_ctx_view?: 'bar' | 'grid';
  __ag_statusline_expanded_cats?: Set<string>;
  __ag_statusline_hover_cat?: string | null;
  __ag_statusline_bar_tt_map?: WeakMap<HTMLElement, string>;
  __ag_statusline_tt_hide_timer?: ReturnType<typeof setTimeout> | null;
  __ag_statusline_sub_sig?: string;
  __ag_statusline_panels?: PanelSubscription[];
  __ag_statusline_render?: (items: RenderItem | RenderItem[]) => void;
  __ag_statusline_check?: () => void;
  __ag_statusline_schedule_check?: () => void;
  __ag_statusline_route_timer?: ReturnType<typeof setInterval> | null;
  __ag_statusline_focusin_fn?: ((e: Event) => void) | null;
  __ag_statusline_click_fn?: ((e: Event) => void) | null;
  __ag_statusline_focusin_installed?: boolean;
  __ag_statusline_click_installed?: boolean;
  __ag_statusline_history_installed?: boolean;
  __ag_statusline_dcl_fn?: (() => void) | null;
  __agStatuslineSubscribe?: (payloadJson: string) => void;
}

const win = window as AgStatuslineWindow;

(function runBoot(boot: BootPayload | undefined, fromDcl = false): void {
  if (win.top !== win) return;
  if (!boot || typeof boot !== 'object') return;

  if (win.__ag_statusline_boot_dcl) {
    try {
      win.removeEventListener('DOMContentLoaded', win.__ag_statusline_boot_dcl);
    } catch {
      // ignore
    }
    win.__ag_statusline_boot_dcl = null;
  }
  if (win.__ag_statusline_doc_obs) {
    try {
      win.__ag_statusline_doc_obs.disconnect();
    } catch {
      // ignore
    }
    win.__ag_statusline_doc_obs = null;
  }

  const isPreloadHost = (): boolean => {
    if (win.location && win.location.protocol === 'vscode-file:') return true;
    if (win.__APP_CONFIG__?.productName === 'antigravity') return true;
    return Boolean(
      win.electronNative &&
        ((typeof win.electronNative.setTitleBarOverlay === 'function' &&
          win.nativeStorage &&
          typeof win.nativeStorage.getItems === 'function') ||
          (typeof win.electronNative.getZoomLevel === 'function' &&
            typeof win.electronNative.wcvBrowser?.setThemeColor === 'function'))
    );
  };

  const isAntigravityHost = (): boolean => {
    if (isPreloadHost()) return true;
    return Boolean(
      typeof document !== 'undefined' &&
        typeof document.querySelector === 'function' &&
        document.querySelector(
          'link[href*="/jetbox.css"], body[data-agy-theme], body[data-newux-theme], [id="antigravity.agentSidePanelInputBox"]'
        )
    );
  };

  const scheduleBootOnDcl = (): void => {
    if (typeof win.addEventListener !== 'function') return;
    win.__ag_statusline_boot_dcl = () => {
      win.__ag_statusline_boot_dcl = null;
      runBoot(boot, true);
    };
    win.addEventListener('DOMContentLoaded', win.__ag_statusline_boot_dcl, { once: true });
  };

  if (typeof document === 'undefined' || !document.documentElement) {
    if (typeof document !== 'undefined') {
      if (isPreloadHost() && typeof MutationObserver === 'function') {
        try {
          const obs = new MutationObserver(() => {
            if (document.documentElement) {
              try {
                obs.disconnect();
              } catch {
                // ignore
              }
              win.__ag_statusline_doc_obs = null;
              runBoot(boot, false);
            }
          });
          win.__ag_statusline_doc_obs = obs;
          obs.observe(document, { childList: true });
        } catch {
          // ignore
        }
      }
      if (!fromDcl && document.readyState === 'loading') {
        scheduleBootOnDcl();
      }
    }
    return;
  }

  if (!isAntigravityHost()) {
    if (!fromDcl && document.readyState === 'loading') {
      scheduleBootOnDcl();
      return;
    }
    win.__ag_statusline_skip_non_host = true;
    return;
  }

  if (win.__ag_statusline_skip_non_host) {
    try {
      delete win.__ag_statusline_skip_non_host;
    } catch {
      win.__ag_statusline_skip_non_host = false;
    }
  }

  const PATCH_VERSION = boot.version || '0.1.1';
  const ENABLED = boot.enabled !== false;

  if (Array.isArray(win.__ag_statusline_cleanup) && win.__ag_statusline_cleanup.length > 0) {
    const prev = win.__ag_statusline_cleanup.splice(0, win.__ag_statusline_cleanup.length);
    for (const fn of prev) {
      try {
        if (typeof fn === 'function') fn();
      } catch {
        // ignore
      }
    }
  }
  win.__ag_statusline_cleanup = [];

  if (win.__ag_statusline_dcl_fn) {
    try {
      win.removeEventListener('DOMContentLoaded', win.__ag_statusline_dcl_fn);
    } catch {
      // ignore
    }
    win.__ag_statusline_dcl_fn = null;
  }
  if (win.__ag_statusline_route_timer) {
    try {
      clearInterval(win.__ag_statusline_route_timer);
    } catch {
      // ignore
    }
    win.__ag_statusline_route_timer = null;
  }

  const clearTooltipHideTimer = (): void => {
    if (win.__ag_statusline_tt_hide_timer) {
      try {
        clearTimeout(win.__ag_statusline_tt_hide_timer);
      } catch {
        // ignore
      }
      win.__ag_statusline_tt_hide_timer = null;
    }
  };

  const removeUiElements = (): void => {
    try {
      clearTooltipHideTimer();
      document
        .querySelectorAll(
          '#ag-statusline-pill, .ag-statusline-pill, [data-ag-statusline-pill], .ag-statusline-inline, [data-ag-statusline-inline], .ag-statusline-bar, [data-ag-statusline-bar]'
        )
        .forEach((el) => el.remove());
      document.querySelectorAll('[data-ag-sl-row-mode]').forEach((el) => {
        el.removeAttribute('data-ag-sl-row-mode');
      });
      document.getElementById('ag-statusline-tooltip')?.remove();
    } catch {
      // ignore
    }
  };

  if (!ENABLED) {
    document.getElementById('ag-statusline-style')?.remove();
    removeUiElements();
    win.__ag_statusline_active_tt_bar = null;
    win.__ag_statusline_payload_by_pane = Object.create(null);
    win.__ag_statusline_panels = [];
    win.__ag_statusline_sub_sig = undefined;
    win.__ag_statusline_check = undefined;
    win.__ag_statusline_schedule_check = undefined;
    win.__ag_statusline_ready = true;
    win.__ag_statusline_version = `${PATCH_VERSION}-disabled`;
    return;
  }

  const headTarget = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
  let styleEl = document.getElementById('ag-statusline-style') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ag-statusline-style';
    headTarget?.appendChild(styleEl);
  }
  if (styleEl && styleEl.textContent !== __AG_CAPSULE_CSS__) {
    styleEl.textContent = __AG_CAPSULE_CSS__;
  }

  const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const AUX_TAB_RE = /^(?:side_question|subagent_convo)__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const INPUT_BOX_SELECTOR = '[id="antigravity.agentSidePanelInputBox"]';
  const BRANCH_PILL_SELECTOR =
    '[data-testid="branch-pill-trigger"], [data-testid="project-branch-picker"], [data-testid="project-selector-trigger"], [data-testid="location-selector-trigger"], [aria-label^="Select project"], [aria-label^="选择项目"]';
  const HOME_GREETING_SELECTOR = '[data-testid="home-greeting"], [data-testid="home-splash-content"]';

  if (!win.__ag_statusline_bar_tt_map || !(win.__ag_statusline_bar_tt_map instanceof WeakMap)) {
    win.__ag_statusline_bar_tt_map = new WeakMap<HTMLElement, string>();
  }
  const barTooltipMap = win.__ag_statusline_bar_tt_map;
  const payloadByPane: Record<string, RenderItem> = Object.create(null);
  win.__ag_statusline_payload_by_pane = payloadByPane;

  const boxObservers = new WeakMap<Element, MutationObserver>();
  const boxResizeObservers = new WeakMap<Element, ResizeObserver>();
  const activeMutationObservers = new Set<MutationObserver>();
  const activeResizeObservers = new Set<ResizeObserver>();
  const activeRafs = new Set<number>();
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  win.__ag_statusline_cleanup.push(() => {
    clearTooltipHideTimer();
    for (const mo of activeMutationObservers) {
      try {
        mo.disconnect();
      } catch {
        // ignore
      }
    }
    activeMutationObservers.clear();
    for (const ro of activeResizeObservers) {
      try {
        ro.disconnect();
      } catch {
        // ignore
      }
    }
    activeResizeObservers.clear();
    for (const id of activeRafs) {
      try {
        cancelAnimationFrame(id);
      } catch {
        // ignore
      }
    }
    activeRafs.clear();
    for (const tid of activeTimers) {
      try {
        clearTimeout(tid);
      } catch {
        // ignore
      }
    }
    activeTimers.clear();
    win.__ag_statusline_focusin_fn = null;
    win.__ag_statusline_click_fn = null;
    win.__ag_statusline_check = undefined;
    win.__ag_statusline_schedule_check = undefined;
  });

  // Remove legacy v0.1.0 pills and stale bars from older bundles
  try {
    document
      .querySelectorAll('#ag-statusline-pill, .ag-statusline-pill, [data-ag-statusline-pill]')
      .forEach((el) => el.remove());
    document.querySelectorAll('[data-ag-sl-row-mode]').forEach((el) => {
      el.removeAttribute('data-ag-sl-row-mode');
    });
    document
      .querySelectorAll('.ag-statusline-inline, [data-ag-statusline-inline], .ag-statusline-bar, [data-ag-statusline-bar]')
      .forEach((el) => {
        if (el.getAttribute('data-ag-sl-ver') !== PATCH_VERSION) {
          el.remove();
        }
      });
    const oldTt = document.getElementById('ag-statusline-tooltip');
    if (oldTt && oldTt.getAttribute('data-ag-sl-ver') !== PATCH_VERSION) {
      oldTt.remove();
    }
  } catch {
    // ignore
  }

  function extractAuxTabUuid(raw: string | null): string {
    const m = String(raw || '').trim().match(AUX_TAB_RE);
    return m ? m[1].toLowerCase() : '';
  }

  function getOrAssignPaneKey(box: Element): string {
    const existing = box.getAttribute('data-ag-sl-pane');
    if (existing) return existing;
    const seq = (win.__ag_statusline_pane_seq || 0) + 1;
    win.__ag_statusline_pane_seq = seq;
    const key = `pane-${seq}`;
    box.setAttribute('data-ag-sl-pane', key);
    return key;
  }

  function extractFocusedOrPrimaryCascadeId(): string {
    try {
      const sp = new URLSearchParams(win.location.search || '');
      const focused = String(sp.get('focused') || '').trim().toLowerCase();
      if (CASCADE_UUID_RE.test(focused)) return focused;

      let decoded = String(win.location.pathname || '');
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // ignore
      }
      const m = decoded.match(/\/c\/([^/?#]+)/i);
      if (m) {
        const parts = m[1].split(/\+|%2b/i);
        for (const p of parts) {
          const cid = String(p || '').trim().toLowerCase();
          if (CASCADE_UUID_RE.test(cid)) return cid;
        }
      }

      const q = String(sp.get('cascadeId') || '').trim().toLowerCase();
      if (CASCADE_UUID_RE.test(q)) return q;

      const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      if (sel) {
        const cid = String(sel.getAttribute('data-cascade-id') || '').trim().toLowerCase();
        if (CASCADE_UUID_RE.test(cid)) return cid;
      }
    } catch {
      // ignore
    }
    return '';
  }

  function resolveBoxCascadeId(box: Element, totalBoxes: number): string {
    try {
      const sideContainer = box.closest(
        '[data-testid="side-question-tab-content"], [data-testid="side-question-tab-composer"], [data-side-panel-composer], [data-media-drop-scope="subpane"]'
      );
      if (sideContainer) {
        const tabContent = sideContainer.matches(
          '[data-testid="side-question-tab-content"], [data-media-drop-scope="subpane"]'
        )
          ? sideContainer
          : sideContainer.closest(
              '[data-testid="side-question-tab-content"], [data-media-drop-scope="subpane"]'
            ) || sideContainer;
        const sideConv = tabContent.querySelector(
          '[data-testid="side-question-tab-conversation"][data-cascade-id], [data-testid="subagent-tab-conversation"][data-cascade-id], [data-cascade-id]'
        );
        if (sideConv) {
          const sideCid = String(sideConv.getAttribute('data-cascade-id') || '').trim().toLowerCase();
          if (CASCADE_UUID_RE.test(sideCid)) return sideCid;
        }
        const auxRoot = box.closest('[data-testid="aux-pane-split"], [data-pane-id]') || document;
        const strip = auxRoot.querySelector(
          '[data-active-tab-id^="side_question__"], [data-active-tab-id^="subagent_convo__"]'
        );
        if (strip) {
          const stripCid = extractAuxTabUuid(strip.getAttribute('data-active-tab-id'));
          if (stripCid) return stripCid;
        }
        return '';
      }

      const view = box.closest('[data-testid="conversation-view"][data-cascade-id], [data-cascade-id]');
      if (view) {
        const cid = String(view.getAttribute('data-cascade-id') || '').trim().toLowerCase();
        if (CASCADE_UUID_RE.test(cid)) return cid;
      }

      if (totalBoxes === 1) {
        const paneScope = box.closest('[data-pane-id], [data-testid="overview-panel-host"], main') || document;
        const hasHomeGreeting = Boolean(
          box.closest(HOME_GREETING_SELECTOR) || paneScope.querySelector(HOME_GREETING_SELECTOR)
        );
        const hasBranchTrigger = Boolean(box.querySelector(BRANCH_PILL_SELECTOR));
        if (win.location.pathname !== '/' && !hasHomeGreeting && !hasBranchTrigger) {
          return extractFocusedOrPrimaryCascadeId();
        }
      }
    } catch {
      // ignore
    }
    return '';
  }

  function resolveBoxModelLabel(box: Element): string {
    try {
      const trigger = box.querySelector('[data-testid="model-selector-trigger"]');
      if (!trigger) return 'Gemini';
      const aria = String(trigger.getAttribute('aria-label') || '').trim();
      const ariaMatch = aria.match(/^(?:Model,\s*current:|模型，当前：)\s*(.+)$/i);
      if (ariaMatch && ariaMatch[1]) {
        return ariaMatch[1].trim();
      }
      const txt = String(trigger.textContent || '').trim();
      if (txt) return txt;
    } catch {
      // ignore
    }
    return 'Gemini';
  }

  function findFooterRow(box: Element): HTMLElement | null {
    const direct = box.querySelector('.agy-composer-footer, [data-testid="input-box-bottom-toolbar"]') as HTMLElement | null;
    if (direct && direct.children.length >= 2) return direct;
    const rows = box.querySelectorAll('div.flex.w-full.items-center.justify-between');
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i] as HTMLElement;
      if (r.querySelector('[data-testid="model-selector-trigger"], [data-testid="send-button"], [data-testid="input-cancel-button"]')) {
        return r;
      }
    }
    return direct;
  }

  const PRISM_BAR_SELECTOR =
    '#ag-prism-pulse-bar, #ag-pulse-status-bar, [data-ag-prism-pulse-bar="true"], [data-ag-pulse-bar="true"]';

  function findInlineForBox(box: Element, paneKey: string): HTMLElement | null {
    const inside = box.querySelector('[data-ag-statusline-inline="1"], .ag-statusline-inline') as HTMLElement | null;
    if (inside) return inside;
    const all = document.querySelectorAll('[data-ag-statusline-inline="1"], .ag-statusline-inline');
    for (let i = 0; i < all.length; i++) {
      const cand = all[i] as HTMLElement;
      if (cand.getAttribute('data-ag-sl-pane-key') === paneKey) return cand;
    }
    return null;
  }

  function measureAvailableInlinePx(box: Element, footer: HTMLElement, inlineEl: HTMLElement): number {
    const prevDisp = inlineEl.style.display;
    inlineEl.style.display = 'none';
    try {
      const footerWidth = footer.clientWidth || box.clientWidth || 0;
      if (footerWidth <= 0) return 0;

      let leftUsed = 180;
      const leftCluster = footer.firstElementChild as HTMLElement | null;
      if (leftCluster && leftCluster !== inlineEl) {
        const modelBtn = leftCluster.querySelector('[data-testid="model-selector-trigger"]') as HTMLElement | null;
        const plusBtn = leftCluster.querySelector('button:not([data-testid="model-selector-trigger"])') as HTMLElement | null;
        if (modelBtn) {
          const modelNatural = Math.max(
            modelBtn.offsetWidth || 0,
            Math.min(240, (modelBtn.scrollWidth || 0) + 12)
          );
          const plusW = plusBtn ? (plusBtn.offsetWidth || 28) + 8 : 34;
          leftUsed = plusW + modelNatural;
        } else {
          leftUsed = Math.max(150, leftCluster.offsetWidth || 0);
        }
      }

      let rightUsed = 148;
      const kids = Array.from(footer.children);
      for (let i = kids.length - 1; i >= 1; i--) {
        const k = kids[i] as HTMLElement;
        if (k === inlineEl || k.matches?.(PRISM_BAR_SELECTOR)) continue;
        rightUsed = Math.max(96, k.offsetWidth || 148);
        break;
      }

      return footerWidth - leftUsed - rightUsed - 24;
    } finally {
      inlineEl.style.display = prevDisp;
    }
  }

  function bindAnchorHover(el: HTMLElement): void {
    el.addEventListener('mouseenter', () => {
      const ttHtml = barTooltipMap.get(el);
      if (!ttHtml) return;
      positionAndShowTooltip(el, ttHtml);
    });
    el.addEventListener('mouseleave', () => {
      scheduleHideTooltip(el);
    });
  }

  function createInlineElement(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'ag-statusline-inline';
    span.setAttribute('data-ag-statusline-inline', '1');
    span.setAttribute('data-ag-sl-hover-anchor', '1');
    span.setAttribute('data-ag-sl-ver', PATCH_VERSION);
    bindAnchorHover(span);
    return span;
  }

  function ensureInlineForBox(box: Element, paneKey: string): { inlineEl: HTMLElement | null; availPx: number } {
    const footer = findFooterRow(box);
    if (!footer || footer.children.length === 0) {
      return { inlineEl: null, availPx: 0 };
    }
    let inlineEl = findInlineForBox(box, paneKey);
    if (!inlineEl) {
      inlineEl = createInlineElement();
    }
    inlineEl.setAttribute('data-ag-sl-pane-key', paneKey);

    let rightCluster: Element | null = null;
    const kids = Array.from(footer.children);
    for (let i = kids.length - 1; i >= 1; i--) {
      const k = kids[i];
      if (k === inlineEl || k.matches?.(PRISM_BAR_SELECTOR)) continue;
      rightCluster = k;
      break;
    }

    if (rightCluster && rightCluster.parentElement === footer) {
      if (rightCluster.previousElementSibling !== inlineEl) {
        footer.insertBefore(inlineEl, rightCluster);
      }
    } else if (inlineEl.parentElement !== footer) {
      footer.appendChild(inlineEl);
    }

    const availPx = measureAvailableInlinePx(box, footer, inlineEl);
    return { inlineEl, availPx };
  }

  function canMountOutsideBox(box: Element): boolean {
    if (!box.parentElement) return false;
    try {
      const cs = win.getComputedStyle(box.parentElement);
      return !(cs.display.includes('flex') && cs.flexDirection.startsWith('row'));
    } catch {
      return true;
    }
  }

  function findBarForBox(box: Element, paneKey: string): HTMLElement | null {
    const next = box.nextElementSibling as HTMLElement | null;
    if (
      next &&
      (next.hasAttribute('data-ag-statusline-bar') || next.classList.contains('ag-statusline-bar'))
    ) {
      const nextPane = next.getAttribute('data-ag-sl-pane-key');
      if (!nextPane || nextPane === paneKey) {
        return next;
      }
    }

    const inside = box.querySelector('[data-ag-statusline-bar="1"], .ag-statusline-bar') as HTMLElement | null;
    if (inside) {
      return inside;
    }

    const allBars = document.querySelectorAll('[data-ag-statusline-bar="1"], .ag-statusline-bar');
    for (let i = 0; i < allBars.length; i++) {
      const candidate = allBars[i] as HTMLElement;
      if (candidate.getAttribute('data-ag-sl-pane-key') === paneKey) {
        return candidate;
      }
    }
    return null;
  }

  function hideTooltipNow(): void {
    clearTooltipHideTimer();
    const tt = document.getElementById('ag-statusline-tooltip');
    if (tt) tt.removeAttribute('data-visible');
    win.__ag_statusline_active_tt_bar = null;
    win.__ag_statusline_selected_pool = null;
    win.__ag_statusline_hover_cat = null;
  }

  function applySelectedPoolTab(tt: HTMLElement, poolId: string | null): void {
    const panels = tt.querySelectorAll('.ag-sl-pool-panel');
    if (panels.length === 0) return;
    let targetId = poolId || '';
    if (!targetId || !tt.querySelector(`.ag-sl-pool-panel[data-ag-sl-pool-panel="${targetId}"]`)) {
      const sec = tt.querySelector('.ag-sl-quota-section');
      targetId = sec?.getAttribute('data-ag-sl-default-pool') || panels[0].getAttribute('data-ag-sl-pool-panel') || '';
    }
    tt.querySelectorAll('.ag-sl-pool-tab').forEach((btn) => {
      btn.setAttribute('data-active', btn.getAttribute('data-ag-sl-pool-tab') === targetId ? '1' : '0');
    });
    panels.forEach((p) => {
      p.setAttribute('data-active', p.getAttribute('data-ag-sl-pool-panel') === targetId ? '1' : '0');
    });
  }

  function applyContextViewState(tt: HTMLElement): void {
    const mode = win.__ag_statusline_ctx_view === 'grid' ? 'grid' : 'bar';
    tt.querySelectorAll('[data-ag-sl-ctx-view]').forEach((btn) => {
      btn.setAttribute('data-active', btn.getAttribute('data-ag-sl-ctx-view') === mode ? '1' : '0');
    });
    tt.querySelectorAll('[data-ag-sl-view-panel]').forEach((panel) => {
      panel.setAttribute('data-active', panel.getAttribute('data-ag-sl-view-panel') === mode ? '1' : '0');
    });
    const expanded = win.__ag_statusline_expanded_cats;
    tt.querySelectorAll('[data-ag-sl-expand]').forEach((row) => {
      const grp = row.getAttribute('data-ag-sl-expand') || '';
      row.setAttribute('data-open', expanded?.has(grp) ? '1' : '0');
    });
    tt.querySelectorAll('[data-ag-sl-sub-for]').forEach((sub) => {
      const grp = sub.getAttribute('data-ag-sl-sub-for') || '';
      sub.setAttribute('data-open', expanded?.has(grp) ? '1' : '0');
    });
  }

  function applyCategoryHoverHighlight(tt: HTMLElement, catKey: string | null): void {
    win.__ag_statusline_hover_cat = catKey;
    tt.querySelectorAll('.ag-sl-seg[data-ag-sl-cat], .ag-sl-grid-cell[data-ag-sl-cat]').forEach((el) => {
      if (!catKey) {
        el.removeAttribute('data-hot');
        el.removeAttribute('data-dim');
      } else if (el.getAttribute('data-ag-sl-cat') === catKey) {
        el.setAttribute('data-hot', '1');
        el.removeAttribute('data-dim');
      } else {
        el.removeAttribute('data-hot');
        el.setAttribute('data-dim', '1');
      }
    });
    tt.querySelectorAll('.ag-sl-cat-row[data-ag-sl-cat]').forEach((el) => {
      if (catKey && el.getAttribute('data-ag-sl-cat') === catKey) {
        el.setAttribute('data-hot', '1');
      } else {
        el.removeAttribute('data-hot');
      }
    });
  }

  function repositionTooltipForBar(tt: HTMLElement, bar: HTMLElement): void {
    const vw = win.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = win.innerHeight || document.documentElement.clientHeight || 768;
    const r = bar.getBoundingClientRect();

    tt.style.maxHeight = `${Math.max(160, vh - 20)}px`;
    tt.style.bottom = 'auto';

    const availAbove = Math.max(0, r.top - 10);
    const availBelow = Math.max(0, vh - r.bottom - 10);
    const naturalH = tt.scrollHeight || tt.offsetHeight || 260;
    const placeAbove = availAbove >= naturalH || availAbove >= availBelow;
    const maxAvail = placeAbove ? availAbove : availBelow;
    const chosenMaxH = Math.max(120, Math.floor(maxAvail - 6));

    tt.style.maxHeight = `${chosenMaxH}px`;
    const renderedH = Math.min(naturalH, chosenMaxH);
    const ttWidth = Math.min(456, Math.max(320, tt.offsetWidth || 448), Math.max(240, vw - 20));
    const alignRight = r.left > vw * 0.42;
    const preferredLeft = alignRight ? r.right - ttWidth : r.left;
    const left = Math.max(10, Math.min(preferredLeft, vw - ttWidth - 10));
    const rawTop = placeAbove ? r.top - renderedH - 8 : r.bottom + 8;
    const topPx = Math.max(8, Math.min(rawTop, vh - renderedH - 8));

    tt.style.left = `${Math.round(left)}px`;
    tt.style.top = `${Math.round(topPx)}px`;
  }

  function hideTooltipIfOwner(bar: HTMLElement | null): void {
    const cur = win.__ag_statusline_active_tt_bar;
    if (!bar || cur === bar || Boolean(cur && bar.contains(cur))) {
      hideTooltipNow();
    }
  }

  function scheduleHideTooltip(bar: HTMLElement): void {
    clearTooltipHideTimer();
    const tid = setTimeout(() => {
      activeTimers.delete(tid);
      win.__ag_statusline_tt_hide_timer = null;
      hideTooltipIfOwner(bar);
    }, 120);
    activeTimers.add(tid);
    win.__ag_statusline_tt_hide_timer = tid;
  }

  function ensureTooltip(): HTMLElement | null {
    let tt = document.getElementById('ag-statusline-tooltip');
    if (tt && tt.getAttribute('data-ag-sl-ver') !== PATCH_VERSION) {
      tt.remove();
      tt = null;
    }
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = 'ag-statusline-tooltip';
      tt.setAttribute('data-ag-sl-ver', PATCH_VERSION);
      tt.addEventListener('mouseenter', () => {
        clearTooltipHideTimer();
      });
      tt.addEventListener('mouseleave', () => {
        if (tt) applyCategoryHoverHighlight(tt, null);
        const owner = win.__ag_statusline_active_tt_bar;
        if (owner) scheduleHideTooltip(owner);
      });
      tt.addEventListener('mouseover', (ev) => {
        if (!tt) return;
        const t = ev.target as Element | null;
        const catEl = t?.closest?.('[data-ag-sl-cat]') as HTMLElement | null;
        const nextCat = catEl && tt.contains(catEl) ? catEl.getAttribute('data-ag-sl-cat') : null;
        if (nextCat !== (win.__ag_statusline_hover_cat || null)) {
          applyCategoryHoverHighlight(tt, nextCat);
        }
      });
      tt.addEventListener('click', (ev) => {
        const t = ev.target as Element | null;
        if (!tt) return;

        const viewBtn = t?.closest?.('[data-ag-sl-ctx-view]') as HTMLElement | null;
        if (viewBtn && tt.contains(viewBtn)) {
          ev.preventDefault();
          ev.stopPropagation();
          const v = viewBtn.getAttribute('data-ag-sl-ctx-view');
          if (v === 'bar' || v === 'grid') {
            win.__ag_statusline_ctx_view = v;
            applyContextViewState(tt);
            const owner = win.__ag_statusline_active_tt_bar;
            if (owner) repositionTooltipForBar(tt, owner);
          }
          return;
        }

        const expandRow = t?.closest?.('[data-ag-sl-expand]') as HTMLElement | null;
        if (expandRow && tt.contains(expandRow)) {
          ev.preventDefault();
          ev.stopPropagation();
          const grp = expandRow.getAttribute('data-ag-sl-expand');
          if (grp) {
            if (!(win.__ag_statusline_expanded_cats instanceof Set)) {
              win.__ag_statusline_expanded_cats = new Set<string>();
            }
            if (win.__ag_statusline_expanded_cats.has(grp)) {
              win.__ag_statusline_expanded_cats.delete(grp);
            } else {
              win.__ag_statusline_expanded_cats.add(grp);
            }
            applyContextViewState(tt);
            const owner = win.__ag_statusline_active_tt_bar;
            if (owner) repositionTooltipForBar(tt, owner);
          }
          return;
        }

        const tabBtn = t?.closest?.('[data-ag-sl-pool-tab]') as HTMLElement | null;
        if (!tabBtn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const pid = tabBtn.getAttribute('data-ag-sl-pool-tab');
        if (pid) {
          win.__ag_statusline_selected_pool = pid;
          applySelectedPoolTab(tt, pid);
        }
      });
      document.body.appendChild(tt);
    } else if (tt && document.body && tt.parentElement !== document.body) {
      document.body.appendChild(tt);
    }
    return tt;
  }

  function positionAndShowTooltip(bar: HTMLElement, ttHtml: string): void {
    clearTooltipHideTimer();
    const tt = ensureTooltip();
    if (!tt) return;

    const wasVisibleSameAnchor =
      tt.getAttribute('data-visible') === '1' && win.__ag_statusline_active_tt_bar === bar;
    const prevScroll = wasVisibleSameAnchor ? tt.scrollTop : 0;

    if (tt.innerHTML !== ttHtml) {
      tt.innerHTML = ttHtml;
      tt.scrollTop = prevScroll;
    }
    applySelectedPoolTab(tt, win.__ag_statusline_selected_pool || null);
    applyContextViewState(tt);
    applyCategoryHoverHighlight(tt, win.__ag_statusline_hover_cat || null);
    win.__ag_statusline_active_tt_bar = bar;

    repositionTooltipForBar(tt, bar);
    tt.setAttribute('data-visible', '1');
  }

  function createBarElement(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ag-statusline-bar';
    bar.setAttribute('data-ag-statusline-bar', '1');
    bar.setAttribute('data-ag-sl-ver', PATCH_VERSION);

    // Delegate hover ONLY to actual metric spans ([data-ag-sl-hover-anchor="1"]), ignoring empty bar space
    bar.addEventListener('mouseover', (ev) => {
      const anchor = (ev.target as Element | null)?.closest?.('[data-ag-sl-hover-anchor="1"]') as HTMLElement | null;
      if (!anchor || !bar.contains(anchor)) return;
      const ttHtml = barTooltipMap.get(bar);
      if (!ttHtml) return;
      positionAndShowTooltip(anchor, ttHtml);
    });
    bar.addEventListener('mouseout', (ev) => {
      const fromAnchor = (ev.target as Element | null)?.closest?.('[data-ag-sl-hover-anchor="1"]') as HTMLElement | null;
      if (!fromAnchor || !bar.contains(fromAnchor)) return;
      const related = ev.relatedTarget as Element | null;
      if (related && fromAnchor.contains(related)) return;
      scheduleHideTooltip(fromAnchor);
    });
    return bar;
  }

  function syncModelObserverForBox(box: Element): void {
    if (typeof ResizeObserver === 'function' && !boxResizeObservers.has(box)) {
      try {
        const ro = new ResizeObserver(() => {
          const paneKey = box.getAttribute('data-ag-sl-pane') || '';
          const item = paneKey ? payloadByPane[paneKey] : undefined;
          const bar = paneKey ? findBarForBox(box, paneKey) : null;
          if (bar && item) {
            applyRenderItemToBox(box, paneKey, bar, item);
          }
        });
        ro.observe(box);
        boxResizeObservers.set(box, ro);
        activeResizeObservers.add(ro);
      } catch {
        // ignore
      }
    }
    if (typeof MutationObserver === 'undefined' || boxObservers.has(box)) return;
    const mo = new MutationObserver((records) => {
      const hasExternalChange = records.some((rec) => {
        const t = rec.target as Element | null;
        return !t?.closest?.('[data-ag-statusline-inline="1"], [data-ag-statusline-bar="1"]');
      });
      if (hasExternalChange) {
        schedulePanelCheck();
      }
    });
    const footer = findFooterRow(box);
    const target = footer ?? box;
    try {
      mo.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label', 'hidden', 'data-ag-prism-hidden', 'data-layout', 'style']
      });
      boxObservers.set(box, mo);
      activeMutationObservers.add(mo);
    } catch {
      // ignore
    }
  }

  function ensureBarForBox(box: Element, paneKey: string): HTMLElement {
    let bar = findBarForBox(box, paneKey);
    if (!bar) {
      bar = createBarElement();
    }
    bar.setAttribute('data-ag-sl-pane-key', paneKey);

    if (canMountOutsideBox(box)) {
      const insideExtras = box.querySelectorAll('.ag-statusline-bar, [data-ag-statusline-bar]');
      for (let i = 0; i < insideExtras.length; i++) {
        const extra = insideExtras[i];
        if (extra !== bar) extra.remove();
      }
      bar.removeAttribute('data-ag-sl-inside-card');
      if (bar.parentElement !== box.parentElement || bar.previousElementSibling !== box) {
        box.after(bar);
      }
    } else {
      if (!bar.hasAttribute('data-ag-sl-inside-card')) {
        bar.setAttribute('data-ag-sl-inside-card', '1');
      }
      if (bar.parentElement !== box) {
        box.appendChild(bar);
      }
    }

    syncModelObserverForBox(box);
    return bar;
  }

  function applyMarkupAndTooltip(el: HTMLElement | null, html: string, tooltipHtml: string, displayMode: 'flex' | 'inline-flex'): void {
    if (!el) return;
    if (!html) {
      if (el.innerHTML !== '') el.innerHTML = '';
      if (el.style.display !== 'none') el.style.display = 'none';
      barTooltipMap.delete(el);
      hideTooltipIfOwner(el);
      return;
    }

    barTooltipMap.set(el, tooltipHtml);
    const activeOwner = win.__ag_statusline_active_tt_bar;
    const wasChildAnchorRight = Boolean(activeOwner && el.contains(activeOwner) && activeOwner.classList.contains('ag-sl-bar-right'));
    const ownsActiveTt = activeOwner === el || Boolean(activeOwner && el.contains(activeOwner));

    if (el.innerHTML !== html) {
      el.innerHTML = html;
    }
    if (el.style.display !== displayMode) {
      el.style.display = displayMode;
    }

    if (ownsActiveTt) {
      let nextAnchor: HTMLElement = el;
      if (activeOwner !== el) {
        const sel = wasChildAnchorRight ? '.ag-sl-bar-right' : '[data-ag-sl-hover-anchor="1"]';
        nextAnchor = (el.querySelector(sel) as HTMLElement | null) || el;
      }
      win.__ag_statusline_active_tt_bar = nextAnchor;
      const tt = document.getElementById('ag-statusline-tooltip');
      if (tt && tt.getAttribute('data-visible') === '1' && tooltipHtml && tt.innerHTML !== tooltipHtml) {
        positionAndShowTooltip(nextAnchor, tooltipHtml);
      }
    }
  }

  function applyRenderItemToBox(box: Element, paneKey: string, bar: HTMLElement, item: RenderItem | undefined): void {
    const { inlineEl, availPx } = ensureInlineForBox(box, paneKey);
    if (!item || !item.hasContent) {
      applyMarkupAndTooltip(inlineEl, '', '', 'inline-flex');
      applyMarkupAndTooltip(bar, '', '', 'flex');
      bar.removeAttribute('data-ag-sl-layout');
      return;
    }

    const nextTooltip = item.tooltipHtml || '';
    const fullToolbar = item.toolbarHtml ?? '';
    const compactToolbar = item.toolbarCompactHtml ?? fullToolbar;
    const quotaMarkup = item.quotaHtml ?? '';

    if (inlineEl && fullToolbar) {
      // 3-tier anti-overlap width fitting: full inline -> compact inline -> drop below input box
      let placedInline = false;
      if (availPx >= 125) {
        const tryFull = availPx >= 245;
        const candidateHtml = tryFull ? fullToolbar : compactToolbar;
        applyMarkupAndTooltip(inlineEl, candidateHtml, nextTooltip, 'inline-flex');
        const renderedW = inlineEl.scrollWidth || inlineEl.offsetWidth || 0;
        if (renderedW <= availPx + 2) {
          placedInline = true;
        } else if (tryFull && compactToolbar && compactToolbar !== fullToolbar) {
          applyMarkupAndTooltip(inlineEl, compactToolbar, nextTooltip, 'inline-flex');
          const compactW = inlineEl.scrollWidth || inlineEl.offsetWidth || 0;
          if (compactW <= availPx + 2) {
            placedInline = true;
          }
        }
      }

      if (placedInline) {
        bar.removeAttribute('data-ag-sl-layout');
        applyMarkupAndTooltip(bar, quotaMarkup, nextTooltip, 'flex');
        return;
      }

      // Narrow side-panel fallback: hide inline strip so model selector & Turbo never collide,
      // and place compact session telemetry at bottom-left opposite bottom-right quota!
      applyMarkupAndTooltip(inlineEl, '', '', 'inline-flex');
      const belowLeft = `<span class="ag-sl-hover-target ag-sl-bar-left" data-ag-sl-hover-anchor="1">${compactToolbar}</span>`;
      bar.setAttribute('data-ag-sl-layout', 'split');
      applyMarkupAndTooltip(bar, `${belowLeft}${quotaMarkup}`, nextTooltip, 'flex');
      return;
    }

    if (inlineEl) {
      applyMarkupAndTooltip(inlineEl, '', '', 'inline-flex');
    }
    bar.removeAttribute('data-ag-sl-layout');
    applyMarkupAndTooltip(bar, quotaMarkup || item.inlineHtml, nextTooltip, 'flex');
  }

  function pruneOrphanedBars(activeBoxByPane: Map<string, Element>): void {
    const allBars = document.querySelectorAll('[data-ag-statusline-bar="1"], .ag-statusline-bar');
    for (let i = 0; i < allBars.length; i++) {
      const b = allBars[i] as HTMLElement;
      const pk = b.getAttribute('data-ag-sl-pane-key') || '';
      const owner = pk ? activeBoxByPane.get(pk) : undefined;
      const owned = Boolean(owner && (owner.nextElementSibling === b || owner.contains(b)));
      if (!owned) {
        hideTooltipIfOwner(b);
        b.remove();
      }
    }
    const allInlines = document.querySelectorAll('[data-ag-statusline-inline="1"], .ag-statusline-inline');
    for (let i = 0; i < allInlines.length; i++) {
      const sp = allInlines[i] as HTMLElement;
      const pk = sp.getAttribute('data-ag-sl-pane-key') || '';
      const owner = pk ? activeBoxByPane.get(pk) : undefined;
      if (!owner || !owner.contains(sp)) {
        hideTooltipIfOwner(sp);
        sp.remove();
      }
    }
    if (win.__ag_statusline_active_tt_bar && !win.__ag_statusline_active_tt_bar.isConnected) {
      hideTooltipNow();
    }
  }

  function checkAndSyncPanels(): void {
    try {
      if (document.hidden) return;
      const boxes = Array.from(document.querySelectorAll(INPUT_BOX_SELECTOR));
      const totalBoxes = boxes.length;
      const panels: PanelSubscription[] = [];
      const activeBoxByPane = new Map<string, Element>();
      const primaryCid = extractFocusedOrPrimaryCascadeId();

      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const paneKey = getOrAssignPaneKey(box);
        const cascadeId = resolveBoxCascadeId(box, totalBoxes);
        const modelLabel = resolveBoxModelLabel(box);
        activeBoxByPane.set(paneKey, box);
        panels.push({ paneKey, cascadeId, modelLabel });

        const bar = ensureBarForBox(box, paneKey);
        if (cascadeId) {
          bar.setAttribute('data-ag-sl-cascade-id', cascadeId);
        } else {
          bar.removeAttribute('data-ag-sl-cascade-id');
        }
        const existing = payloadByPane[paneKey];
        if (existing && existing.cascadeId === cascadeId) {
          applyRenderItemToBox(box, paneKey, bar, existing);
        } else {
          applyRenderItemToBox(box, paneKey, bar, undefined);
        }
      }

      pruneOrphanedBars(activeBoxByPane);

      if (panels.length === 0 && primaryCid) {
        panels.push({ paneKey: 'route-primary', cascadeId: primaryCid, modelLabel: 'Gemini' });
      }

      win.__ag_statusline_panels = panels;
      const subSig = JSON.stringify(panels);
      if (subSig !== win.__ag_statusline_sub_sig) {
        win.__ag_statusline_sub_sig = subSig;
        if (typeof win.__agStatuslineSubscribe === 'function') {
          try {
            win.__agStatuslineSubscribe(subSig);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function schedulePanelCheck(): void {
    const run = () => {
      if (typeof win.__ag_statusline_check === 'function') {
        win.__ag_statusline_check();
      }
    };
    const raf = requestAnimationFrame(() => {
      activeRafs.delete(raf);
      const t0 = setTimeout(() => {
        activeTimers.delete(t0);
        run();
      }, 0);
      activeTimers.add(t0);
    });
    activeRafs.add(raf);
    for (const delay of [120, 400]) {
      const tid = setTimeout(() => {
        activeTimers.delete(tid);
        run();
      }, delay);
      activeTimers.add(tid);
    }
  }

  win.__ag_statusline_check = checkAndSyncPanels;
  win.__ag_statusline_schedule_check = schedulePanelCheck;

  win.__ag_statusline_render = (rawItems: RenderItem | RenderItem[]) => {
    try {
      const items = Array.isArray(rawItems) ? rawItems : [rawItems];
      const boxes = Array.from(document.querySelectorAll(INPUT_BOX_SELECTOR));
      const boxByPane = new Map<string, Element>();
      for (const box of boxes) {
        boxByPane.set(getOrAssignPaneKey(box), box);
      }

      for (const item of items) {
        if (!item || typeof item !== 'object' || !item.paneKey) continue;
        payloadByPane[item.paneKey] = item;
        const box = boxByPane.get(item.paneKey);
        if (!box) continue;
        const bar = ensureBarForBox(box, item.paneKey);
        applyRenderItemToBox(box, item.paneKey, bar, item);
      }
    } catch {
      // ignore
    }
  };

  win.__ag_statusline_focusin_fn = (e: Event) => {
    const t = e.target as Element | null;
    if (!t?.closest) return;
    if (
      t.closest(
        `[data-pane-id], [data-testid="conversation-view"], [data-testid="side-question-tab-content"], [data-media-drop-scope="subpane"], [data-side-panel-strip], ${INPUT_BOX_SELECTOR}`
      )
    ) {
      schedulePanelCheck();
    }
  };

  win.__ag_statusline_click_fn = (e: Event) => {
    const t = e.target as Element | null;
    if (!t?.closest) return;
    if (
      t.closest(
        '[data-tab-id], [data-side-panel-strip], [data-testid="model-selector-trigger"], [role="option"], [role="menuitem"]'
      )
    ) {
      schedulePanelCheck();
    }
  };

  if (!win.__ag_statusline_focusin_installed) {
    win.__ag_statusline_focusin_installed = true;
    document.addEventListener(
      'focusin',
      (e) => {
        win.__ag_statusline_focusin_fn?.(e);
      },
      true
    );
  }
  if (!win.__ag_statusline_click_installed) {
    win.__ag_statusline_click_installed = true;
    document.addEventListener(
      'click',
      (e) => {
        win.__ag_statusline_click_fn?.(e);
      },
      true
    );
  }
  if (!win.__ag_statusline_history_installed) {
    win.__ag_statusline_history_installed = true;
    const wrapHistory = (method: 'pushState' | 'replaceState') => {
      const orig = history[method];
      if (typeof orig !== 'function') return;
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const ret = orig.apply(this, args);
        win.__ag_statusline_schedule_check?.();
        return ret;
      };
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
    win.addEventListener('popstate', () => win.__ag_statusline_schedule_check?.());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) win.__ag_statusline_check?.();
    });
  }

  if (typeof MutationObserver === 'function' && document.documentElement) {
    try {
      const rootObs = new MutationObserver(() => {
        schedulePanelCheck();
      });
      rootObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-ag-cs-telemetry', 'data-ag-cs-style']
      });
      activeMutationObservers.add(rootObs);
    } catch {
      // ignore
    }
  }

  win.__ag_statusline_route_timer = setInterval(() => {
    win.__ag_statusline_check?.();
  }, 3000);

  if (document.body) {
    win.__ag_statusline_ready = true;
    checkAndSyncPanels();
  } else {
    win.__ag_statusline_ready = false;
    win.__ag_statusline_dcl_fn = () => {
      win.__ag_statusline_dcl_fn = null;
      win.__ag_statusline_ready = true;
      checkAndSyncPanels();
    };
    win.addEventListener('DOMContentLoaded', win.__ag_statusline_dcl_fn, { once: true });
  }

  win.__ag_statusline_version = PATCH_VERSION;
})(win.__AG_STATUSLINE_BOOT__, false);
