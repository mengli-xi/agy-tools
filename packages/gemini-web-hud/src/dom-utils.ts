/**
 * Trusted-Types-safe DOM helpers (never uses innerHTML / insertAdjacentHTML).
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: {
    className?: string;
    text?: string;
    title?: string;
    attrs?: Record<string, string>;
  },
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts?.className) node.className = opts.className;
  if (opts?.text !== undefined) node.textContent = opts.text;
  if (opts?.title !== undefined) node.title = opts.title;
  if (opts?.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function svgIcon(paths: string[], size = 14, viewBox = '0 0 24 24'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Strips common accessibility/role prefixes from Gemini user query text and condenses whitespace.
 */
export function normalizeQueryTitle(raw: string, maxChars = 64): string {
  const cleaned = raw
    .replace(/^\s*(?:You said|你说|你說|你问道|已说)\s*[:：]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '（无文本消息）';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

export function detectDarkTheme(): boolean {
  const body = document.body;
  const html = document.documentElement;
  if (
    body?.classList.contains('dark-theme') ||
    body?.classList.contains('dark') ||
    html?.classList.contains('dark-theme') ||
    html?.classList.contains('dark')
  ) {
    return true;
  }
  if (body?.classList.contains('light-theme') || html?.classList.contains('light-theme')) {
    return false;
  }
  try {
    const bg = window.getComputedStyle(body || html).backgroundColor;
    const match = bg.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5;
    }
  } catch {
    // ignore
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function findComposerElement(): HTMLElement | null {
  const selectors = [
    'input-area-v2',
    '.input-area-container',
    'rich-textarea',
    '.text-input-field',
    'form .input-box'
  ];
  for (const sel of selectors) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 180 && rect.height > 20) return node;
    }
  }
  return null;
}

/**
 * Computes the left X coordinate of the main conversation pane (to the right of Gemini's left sidebar).
 */
export function findChatLeftEdge(): number {
  const mainSelectors = [
    'chat-window',
    'main',
    'bard-sidenav-content',
    '.mat-drawer-content',
    '.chat-container'
  ];
  for (const sel of mainSelectors) {
    const node = document.querySelector<HTMLElement>(sel);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width > 360 && rect.height > 200) {
      return Math.max(8, Math.round(rect.left + 12));
    }
  }

  // Fallback: check left sidebar right edge
  const sideSelectors = ['bard-sidenav', 'side-navigation-content', 'mat-sidenav', 'nav'];
  for (const sel of sideSelectors) {
    const node = document.querySelector<HTMLElement>(sel);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width > 40 && rect.width < 420 && rect.height > 200 && rect.left <= 10) {
      return Math.round(rect.right + 12);
    }
  }

  return 16;
}

const DISCLAIMER_SELECTORS = [
  'hallucination-disclaimer',
  '.hallucination-disclaimer',
  '.disclaimer-container',
  '[data-test-id="disclaimer"]',
  '.bottom-container .disclaimer'
];

const DISCLAIMER_TEXT_RE =
  /(Gemini\s*是一款\s*AI\s*工具|未必正确无误|可能出错|Gemini\s+can\s+make\s+mistakes|Gemini\s+is\s+AI|double-check)/i;

/**
 * Finds Gemini's bottom disclaimer element ("Gemini 是一款 AI 工具，其回答未必正确无误。")
 * so quota info can be placed inline on the exact same row.
 */
export function findDisclaimerElement(): HTMLElement | null {
  for (const sel of DISCLAIMER_SELECTORS) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node && node.isConnected) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 8) return node;
    }
  }

  // Text-based fallback near the bottom of the viewport
  const candidates = document.querySelectorAll<HTMLElement>('p, span, div');
  for (let i = candidates.length - 1; i >= 0; i--) {
    const node = candidates[i];
    if (node.closest('.gwh-usage-inline, .gwh-toc')) continue;
    const text = (node.textContent || '').trim();
    if (text.length < 10 || text.length > 140) continue;
    if (!DISCLAIMER_TEXT_RE.test(text)) continue;
    // Prefer leaf-ish element near the bottom of the screen
    if (node.children.length > 3) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width > 40 && rect.top > window.innerHeight * 0.65) {
      return node;
    }
  }

  return null;
}
