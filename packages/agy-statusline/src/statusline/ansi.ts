import type { MetricTone, SeverityLevel } from '../core/types.js';

export const ANSI = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  orange: '\x1b[38;5;208m',
  muted: '\x1b[90m'
} as const;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_TOKEN_RE = /(\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp === 0x200d ||
    cp === 0x200c ||
    cp === 0x200b ||
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isFullWidthCodePoint(cp: number): boolean {
  if (cp < 0x1100) return false;
  return (
    cp <= 0x115f ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (isZeroWidthCodePoint(cp)) return 0;
  if (isFullWidthCodePoint(cp)) return 2;
  return 1;
}

export function visibleLen(input: string): number {
  const plain = stripAnsi(input);
  let width = 0;
  for (const ch of plain) {
    width += charDisplayWidth(ch);
  }
  return width;
}

export function truncateColumns(input: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (visibleLen(input) <= maxCols) return input;

  const target = maxCols > 1 ? maxCols - 1 : maxCols;
  const parts = input.split(ANSI_TOKEN_RE);
  let out = '';
  let cols = 0;
  let hasOpenAnsi = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      out += part;
      hasOpenAnsi = part !== ANSI.reset;
      continue;
    }
    for (const ch of part) {
      const w = charDisplayWidth(ch);
      if (cols + w > target) {
        if (maxCols > 1) out += '…';
        if (hasOpenAnsi) out += ANSI.reset;
        return out;
      }
      out += ch;
      cols += w;
    }
  }
  if (hasOpenAnsi) out += ANSI.reset;
  return out;
}

export function colorize(text: string, colorCode: string, enabled: boolean): string {
  if (!enabled || !text) return text;
  return `${colorCode}${text}${ANSI.reset}`;
}

export function colorForSeverity(level: SeverityLevel): string {
  switch (level) {
    case 'crit':
      return ANSI.red;
    case 'warn':
      return ANSI.orange;
    default:
      return ANSI.green;
  }
}

export function colorForTone(tone: MetricTone): string {
  switch (tone) {
    case 'crit':
      return ANSI.red;
    case 'warn':
      return ANSI.orange;
    case 'mid':
      return ANSI.yellow;
    case 'info':
      return ANSI.cyan;
    case 'dim':
      return ANSI.muted;
    default:
      return ANSI.green;
  }
}
