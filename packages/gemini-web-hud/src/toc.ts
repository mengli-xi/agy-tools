import { el, findChatLeftEdge, normalizeQueryTitle, svgIcon } from './dom-utils';

export interface TocItem {
  index: number;
  element: HTMLElement;
  title: string;
  fullText: string;
}

const USER_QUERY_SELECTORS = [
  'user-query',
  '[data-test-id="user-query"]',
  'user-query-content',
  '.user-query-bubble-with-background'
];

const QUERY_TEXT_SELECTORS = [
  '.query-text',
  '.query-text-line',
  '[data-test-id="user-query-text"]',
  '.user-query-text',
  'p'
];

function extractQueryElements(): HTMLElement[] {
  for (const selector of USER_QUERY_SELECTORS) {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (matches.length === 0) continue;

    const filtered = matches.filter((node) => {
      if (!node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return !matches.some((other) => other !== node && other.contains(node));
    });

    if (filtered.length > 0) return filtered;
  }
  return [];
}

function extractQueryText(container: HTMLElement): string {
  for (const selector of QUERY_TEXT_SELECTORS) {
    const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
    if (nodes.length > 0) {
      const joined = nodes
        .map((n) => n.innerText || n.textContent || '')
        .join(' ')
        .trim();
      if (joined) return joined;
    }
  }
  return (container.innerText || container.textContent || '').trim();
}

export class TocController {
  private root: HTMLElement;
  private railEl: HTMLElement;
  private panelEl: HTMLElement;
  private countBadge: HTMLElement;
  private searchWrap: HTMLElement;
  private searchInput: HTMLInputElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private items: TocItem[] = [];
  private activeIndex = -1;
  private filterText = '';
  private hoverOpen = false;
  private closeTimer: number | null = null;
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private layoutTimer: number | null = null;
  private lastSignature = '';

  constructor() {
    this.railEl = el('div', {
      className: 'gwh-toc-rail',
      attrs: { role: 'navigation', 'aria-label': '用户消息导航点' }
    });

    this.countBadge = el('span', { className: 'gwh-toc-count', text: '0' });

    const header = el(
      'div',
      { className: 'gwh-toc-header' },
      el(
        'div',
        { className: 'gwh-toc-title-group' },
        svgIcon(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'], 14),
        el('span', { className: 'gwh-toc-title', text: '提问目录' })
      ),
      this.countBadge
    );

    this.searchInput = el('input', {
      className: 'gwh-toc-search',
      attrs: {
        type: 'search',
        placeholder: '筛选提问…',
        'aria-label': '筛选用户提问'
      }
    });
    this.searchWrap = el('div', { className: 'gwh-toc-search-wrap' }, this.searchInput);

    this.listEl = el('div', { className: 'gwh-toc-list', attrs: { role: 'list' } });
    this.emptyEl = el('div', { className: 'gwh-toc-empty', text: '当前对话暂无用户消息' });

    const topBtn = el(
      'button',
      { className: 'gwh-toc-foot-btn', title: '跳到第一条提问', attrs: { type: 'button' } },
      svgIcon(['M18 15l-6-6-6 6'], 12),
      el('span', { text: '首条' })
    );
    const bottomBtn = el(
      'button',
      { className: 'gwh-toc-foot-btn', title: '跳到最新一条提问', attrs: { type: 'button' } },
      svgIcon(['M6 9l6 6 6-6'], 12),
      el('span', { text: '最新' })
    );
    topBtn.addEventListener('click', () => {
      if (this.items.length > 0) this.jumpTo(0);
    });
    bottomBtn.addEventListener('click', () => {
      if (this.items.length > 0) this.jumpTo(this.items.length - 1);
    });

    const footer = el('div', { className: 'gwh-toc-footer' }, topBtn, bottomBtn);

    this.panelEl = el(
      'div',
      { className: 'gwh-toc-panel', attrs: { 'aria-label': '用户消息目录面板' } },
      header,
      this.searchWrap,
      this.listEl,
      this.emptyEl,
      footer
    );

    this.root = el(
      'aside',
      { className: 'gwh-toc', attrs: { 'aria-label': '用户消息目录' } },
      this.railEl,
      this.panelEl
    );

    const openPanel = (): void => {
      if (this.closeTimer !== null) {
        window.clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      if (!this.hoverOpen) {
        this.hoverOpen = true;
        this.root.classList.add('gwh-toc-open');
      }
    };

    const scheduleClose = (): void => {
      if (document.activeElement === this.searchInput) return;
      if (this.closeTimer !== null) window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = null;
        if (document.activeElement === this.searchInput) return;
        this.hoverOpen = false;
        this.root.classList.remove('gwh-toc-open');
      }, 180);
    };

    this.root.addEventListener('mouseenter', openPanel);
    this.root.addEventListener('mouseleave', scheduleClose);
    this.searchInput.addEventListener('focus', openPanel);
    this.searchInput.addEventListener('blur', () => {
      if (!this.root.matches(':hover')) scheduleClose();
    });
    this.searchInput.addEventListener('input', () => {
      this.filterText = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });
  }

  public mount(): void {
    document.body.appendChild(this.root);
    this.updateLeftPosition();
    this.scan();

    this.mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (this.root.contains(m.target)) continue;
        this.scheduleScan();
        this.scheduleLayout();
        break;
      }
    });
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('resize', () => this.scheduleLayout());
    const resizeObs = new ResizeObserver(() => this.scheduleLayout());
    resizeObs.observe(document.body);
  }

  public setTheme(dark: boolean): void {
    this.root.classList.toggle('gwh-dark', dark);
  }

  public onRouteChange(): void {
    this.filterText = '';
    this.searchInput.value = '';
    this.lastSignature = '';
    this.activeIndex = -1;
    this.scheduleScan(120);
    this.scheduleLayout(120);
    window.setTimeout(() => {
      this.scan();
      this.updateLeftPosition();
    }, 600);
  }

  private scheduleLayout(delayMs = 120): void {
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = null;
      this.updateLeftPosition();
    }, delayMs);
  }

  private updateLeftPosition(): void {
    const leftX = findChatLeftEdge();
    this.root.style.left = `${leftX}px`;
  }

  private scheduleScan(delayMs = 240): void {
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, delayMs);
  }

  public scan(): void {
    const nodes = extractQueryElements();
    const nextItems: TocItem[] = nodes.map((element, index) => {
      const fullText = extractQueryText(element);
      return {
        index,
        element,
        title: normalizeQueryTitle(fullText, 64),
        fullText
      };
    });

    const signature = nextItems.map((it) => `${it.index}:${it.title}`).join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.items = nextItems;

    this.countBadge.textContent = String(this.items.length);
    this.root.classList.toggle('gwh-toc-has-items', this.items.length > 0);
    this.searchWrap.style.display = this.items.length >= 4 ? '' : 'none';

    if (this.items.length > 0 && (this.activeIndex < 0 || this.activeIndex >= this.items.length)) {
      this.activeIndex = this.items.length - 1;
    }

    this.renderRail();
    this.renderList();
    this.observeVisibility();
  }

  private renderRail(): void {
    this.railEl.replaceChildren();
    for (const item of this.items) {
      const dot = el('button', {
        className: `gwh-toc-dot${item.index === this.activeIndex ? ' gwh-toc-dot-active' : ''}`,
        title: `${item.index + 1}. ${item.title}`,
        attrs: {
          type: 'button',
          'aria-label': `跳转到第 ${item.index + 1} 条提问：${item.title}`,
          'data-gwh-idx': String(item.index)
        }
      });
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.jumpTo(item.index);
      });
      this.railEl.appendChild(dot);
    }
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    const query = this.filterText;
    const matched = query
      ? this.items.filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.fullText.toLowerCase().includes(query) ||
            String(item.index + 1) === query
        )
      : this.items;

    this.emptyEl.style.display = matched.length === 0 ? '' : 'none';
    this.emptyEl.textContent =
      this.items.length === 0 ? '当前对话暂无用户消息' : '未找到匹配的提问';

    for (const item of matched) {
      const idxSpan = el('span', {
        className: 'gwh-toc-item-idx',
        text: String(item.index + 1)
      });
      const textSpan = el('span', {
        className: 'gwh-toc-item-text',
        text: item.title
      });
      const btn = el(
        'button',
        {
          className: `gwh-toc-item${item.index === this.activeIndex ? ' gwh-toc-item-active' : ''}`,
          title: item.fullText.slice(0, 240),
          attrs: {
            type: 'button',
            role: 'listitem',
            'data-gwh-idx': String(item.index)
          }
        },
        idxSpan,
        textSpan
      );
      btn.addEventListener('click', () => this.jumpTo(item.index));
      this.listEl.appendChild(btn);
    }
  }

  private observeVisibility(): void {
    this.observer?.disconnect();
    if (this.items.length === 0) return;

    const visibleSet = new Set<number>();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = this.items.findIndex((it) => it.element === entry.target);
          if (idx === -1) continue;
          if (entry.isIntersecting) visibleSet.add(idx);
          else visibleSet.delete(idx);
        }
        if (visibleSet.size > 0) {
          const topMost = Math.min(...visibleSet);
          this.setActiveIndex(topMost);
        }
      },
      {
        root: null,
        rootMargin: '-12% 0px -55% 0px',
        threshold: 0.05
      }
    );

    for (const item of this.items) {
      this.observer.observe(item.element);
    }
  }

  private setActiveIndex(index: number): void {
    if (this.activeIndex === index) return;
    this.activeIndex = index;

    const dots = this.railEl.querySelectorAll<HTMLButtonElement>('.gwh-toc-dot');
    for (const dot of dots) {
      dot.classList.toggle('gwh-toc-dot-active', Number(dot.getAttribute('data-gwh-idx')) === index);
    }

    const buttons = this.listEl.querySelectorAll<HTMLButtonElement>('.gwh-toc-item');
    for (const btn of buttons) {
      const isMatch = Number(btn.getAttribute('data-gwh-idx')) === index;
      btn.classList.toggle('gwh-toc-item-active', isMatch);
      if (isMatch && this.hoverOpen) {
        btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  private jumpTo(index: number): void {
    const item = this.items[index];
    if (!item || !item.element.isConnected) {
      this.scan();
      return;
    }
    this.setActiveIndex(index);
    item.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    item.element.classList.remove('gwh-jump-highlight');
    void item.element.offsetWidth;
    item.element.classList.add('gwh-jump-highlight');
    window.setTimeout(() => {
      item.element.classList.remove('gwh-jump-highlight');
    }, 1500);
  }
}
