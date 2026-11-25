import type { MetricTone, UsagePool, UsagePoolKind, UsageSnapshot } from './types';

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function metricToneFromUsedPct(usedPct: number): MetricTone {
  if (usedPct >= 90) return 'crit';
  if (usedPct >= 75) return 'warn';
  if (usedPct >= 50) return 'mid';
  return 'good';
}

export function classifyPoolKind(rawId: string): { kind: UsagePoolKind; label: string } {
  const upper = rawId.toUpperCase();
  if (
    upper.includes('FIVE_HOURLY') ||
    upper.includes('5_HOUR') ||
    upper.includes('5H') ||
    upper.includes('SESSION') ||
    upper.includes('CURRENT')
  ) {
    return { kind: '5h', label: '5h' };
  }
  if (upper.includes('WEEKLY') || upper.includes('7_DAY') || upper.includes('7D') || upper.includes('WEEK')) {
    return { kind: '7d', label: '7d' };
  }
  const clean = rawId.replace(/^GXU_/i, '').replace(/_/g, ' ').trim();
  return { kind: 'other', label: clean || 'Quota' };
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    if (ms > 1e12) return new Date(ms).toISOString();
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.seconds === 'number' || typeof rec.seconds === 'string') {
      const sec = Number(rec.seconds);
      if (Number.isFinite(sec) && sec > 1e9) {
        return new Date(sec * 1000).toISOString();
      }
    }
  }
  return undefined;
}

function findResetTimestampInPool(poolObj: Record<string, unknown>): string | undefined {
  const gxu =
    poolObj.gxu && typeof poolObj.gxu === 'object'
      ? (poolObj.gxu as Record<string, unknown>)
      : undefined;
  const direct =
    normalizeIsoTimestamp(gxu?.windowRefreshesAt) ??
    normalizeIsoTimestamp(poolObj.windowRefreshesAt) ??
    normalizeIsoTimestamp(poolObj.resetsAt) ??
    normalizeIsoTimestamp(poolObj.resetAt) ??
    normalizeIsoTimestamp(poolObj.resetTime);
  if (direct) return direct;

  // Fallback: search nested fields whose key hints at reset/refresh/expiration
  const visited = new Set<unknown>();
  const walk = (node: unknown, depth: number): string | undefined => {
    if (!node || typeof node !== 'object' || depth > 4 || visited.has(node)) return undefined;
    visited.add(node);
    if (Array.isArray(node)) return undefined;

    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (/(refresh|reset|expir|renew)/i.test(key)) {
        const ts = normalizeIsoTimestamp(val);
        if (ts) return ts;
      }
      if (val && typeof val === 'object') {
        const nested = walk(val, depth + 1);
        if (nested) return nested;
      }
    }
    return undefined;
  };

  return walk(poolObj, 0);
}

function normalizePercentageValue(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  if (raw <= 1) return clampPct(raw * 100);
  return clampPct(raw);
}

function extractPoolsFromObject(root: unknown): UsagePool[] {
  const found: UsagePool[] = [];
  const seen = new Set<string>();
  const visited = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const rec = node as Record<string, unknown>;

    // Candidate pool object
    const hasUsed =
      typeof rec.percentageUsed === 'number' ||
      typeof rec.percentUsed === 'number' ||
      typeof rec.usedPercentage === 'number';
    const hasRemaining =
      typeof rec.percentageRemaining === 'number' ||
      typeof rec.remainingPercentage === 'number';

    if (hasUsed || hasRemaining) {
      const rawId =
        (typeof rec.id === 'string' && rec.id) ||
        (typeof rec.poolId === 'string' && rec.poolId) ||
        (typeof rec.type === 'string' && rec.type) ||
        (typeof rec.name === 'string' && rec.name) ||
        `pool_${found.length}`;

      let usedPct: number | undefined;
      if (hasUsed) {
        usedPct = normalizePercentageValue(
          rec.percentageUsed ?? rec.percentUsed ?? rec.usedPercentage
        );
      } else if (hasRemaining) {
        const rem = normalizePercentageValue(rec.percentageRemaining ?? rec.remainingPercentage);
        if (rem !== undefined) usedPct = clampPct(100 - rem);
      }

      if (usedPct !== undefined) {
        const resetAtIso = findResetTimestampInPool(rec);

        const { kind, label } = classifyPoolKind(rawId);
        const dedupeKey = `${kind}:${rawId}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          found.push({
            id: rawId,
            kind,
            label,
            usedPct,
            remainingPct: clampPct(100 - usedPct),
            ...(resetAtIso ? { resetAtIso } : {})
          });
        }
      }
    }

    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') walk(val);
    }
  };

  walk(root);
  return sortPools(found);
}

function sortPools(pools: UsagePool[]): UsagePool[] {
  const rank: Record<UsagePoolKind, number> = { '5h': 0, '7d': 1, other: 2 };
  return [...pools].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function stripXssiPrefix(text: string): string {
  return text.replace(/^\s*\)\]\}'\s*\n?/, '').trim();
}

export function parseUsageGraphQL(rawText: string, nowMs = Date.now()): UsageSnapshot | null {
  const cleaned = stripXssiPrefix(rawText);
  if (!cleaned) return null;

  // Handle single JSON object or newline-delimited JSON chunks
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(cleaned));
  } catch {
    for (const line of cleaned.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try {
        candidates.push(JSON.parse(t));
      } catch {
        // Ignore non-JSON framing lines
      }
    }
  }

  for (const candidate of candidates) {
    const pools = extractPoolsFromObject(candidate);
    if (pools.length > 0) {
      return {
        pools,
        fetchedAt: nowMs,
        source: 'graphql'
      };
    }
  }

  return null;
}

interface DomSectionHint {
  kind: UsagePoolKind;
  label: string;
  id: string;
  pattern: RegExp;
}

const DOM_SECTIONS: DomSectionHint[] = [
  {
    kind: '5h',
    label: '5h',
    id: 'DOM_FIVE_HOURLY',
    pattern: /(5[\s-]*hour|5\s*小时|current\s*(?:window|limit|usage)|session\s*(?:limit|usage)|当前(?:窗口|限额|用量))/i
  },
  {
    kind: '7d',
    label: '7d',
    id: 'DOM_WEEKLY',
    pattern: /(weekly|7[\s-]*day|每周|7\s*天|本周(?:限额|用量)?)/i
  }
];

function extractPctFromBlock(block: string): { usedPct: number; remainingPct: number } | null {
  const remainingMatch =
    block.match(/(\d{1,3})\s*%\s*(?:left|remaining|available|剩余|可用)/i) ??
    block.match(/(?:剩余|可用)\s*(\d{1,3})\s*%/i);
  if (remainingMatch) {
    const remainingPct = clampPct(Number(remainingMatch[1]));
    return { usedPct: clampPct(100 - remainingPct), remainingPct };
  }

  const usedMatch =
    block.match(/(\d{1,3})\s*%\s*(?:used|of\s+limit|已用|已使用)/i) ??
    block.match(/(?:已用|已使用)\s*(\d{1,3})\s*%/i) ??
    block.match(/(\d{1,3})\s*%/);
  if (usedMatch) {
    const usedPct = clampPct(Number(usedMatch[1]));
    return { usedPct, remainingPct: clampPct(100 - usedPct) };
  }

  return null;
}

function extractResetTextFromBlock(block: string): string | undefined {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/(resets?|refreshes?|renews?|重置|刷新|恢复|更新)/i.test(line) && line.length <= 100) {
      return line;
    }
  }
  return undefined;
}

export function parseUsageDocumentText(bodyText: string, nowMs = Date.now()): UsageSnapshot | null {
  const normalized = bodyText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;

  const lines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const pools: UsagePool[] = [];
  const seenKinds = new Set<UsagePoolKind>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const section of DOM_SECTIONS) {
      if (seenKinds.has(section.kind)) continue;
      if (!section.pattern.test(line)) continue;

      // Stop block before the next quota section header to prevent cross-section bleed
      let end = Math.min(lines.length, i + 6);
      for (let j = i + 1; j < end; j++) {
        if (DOM_SECTIONS.some((other) => other.kind !== section.kind && other.pattern.test(lines[j]))) {
          end = j;
          break;
        }
      }
      const windowBlock = lines.slice(i, end).join('\n');
      const pct = extractPctFromBlock(windowBlock);
      if (pct) {
        seenKinds.add(section.kind);
        const resetText = extractResetTextFromBlock(windowBlock);
        pools.push({
          id: section.id,
          kind: section.kind,
          label: section.label,
          usedPct: pct.usedPct,
          remainingPct: pct.remainingPct,
          ...(resetText ? { resetText } : {})
        });
      }
    }
  }

  if (pools.length === 0) return null;
  return {
    pools: sortPools(pools),
    fetchedAt: nowMs,
    source: 'dom'
  };
}

export function formatCountdown(iso?: string, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return null;
  const diffSec = Math.floor((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return '即将重置';
  if (diffSec < 60) return '<1m';
  const totalMin = Math.floor(diffSec / 60);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

export function formatResetClock(iso?: string, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return null;
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;

  const sameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  if (sameDay) return `今天 ${timeStr}`;

  const tomorrow = new Date(nowMs + 86400_000);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate();
  if (isTomorrow) return `明天 ${timeStr}`;

  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${month}-${day} ${timeStr}`;
}

export function formatResetFromText(resetText?: string, nowMs = Date.now()): string | null {
  if (!resetText) return null;
  const text = resetText.trim();
  if (!text) return null;

  // 1. Relative duration: e.g. "3 小时 15 分钟后重置", "Resets in 3 hr 10 min", "2d 5h"
  const days = Number(text.match(/(\d+)\s*(?:天|d(?:ay)?s?\b)/i)?.[1] ?? 0);
  const hours = Number(text.match(/(\d+)\s*(?:小时|小時|(?:hr?s?|hours?)\b)/i)?.[1] ?? 0);
  const mins = Number(text.match(/(\d+)\s*(?:分钟|分鐘|分|(?:min(?:ute)?s?|m)\b)/i)?.[1] ?? 0);
  if (days > 0 || hours > 0 || mins > 0) {
    if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`;
    if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
    return `${mins}m`;
  }

  // 2. Clock time on today/tomorrow: e.g. "将于 18:30 重置", "Resets at 6:30 PM", "明天 08:30 重置"
  const clockMatch = text.match(/(上午|下午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (clockMatch) {
    let hour = Number(clockMatch[2]);
    const minute = Number(clockMatch[3]);
    const zhPeriod = clockMatch[1] ?? '';
    const enPeriod = (clockMatch[4] ?? '').toUpperCase();

    if ((enPeriod === 'PM' || zhPeriod === '下午' || zhPeriod === '晚上') && hour < 12) {
      hour += 12;
    } else if ((enPeriod === 'AM' || zhPeriod === '凌晨') && hour === 12) {
      hour = 0;
    }

    // If a specific calendar date (e.g. "12月1日" or "Dec 2") is also present, keep compact date+time
    const zhDate = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (zhDate) {
      const target = new Date(nowMs);
      target.setMonth(Number(zhDate[1]) - 1, Number(zhDate[2]));
      target.setHours(hour, minute, 0, 0);
      if (target.getTime() < nowMs - 86400_000) {
        target.setFullYear(target.getFullYear() + 1);
      }
      return formatCountdown(target.toISOString(), nowMs);
    }

    const target = new Date(nowMs);
    target.setHours(hour, minute, 0, 0);
    if (/明天|tomorrow/i.test(text)) {
      target.setDate(target.getDate() + 1);
    } else if (target.getTime() <= nowMs) {
      target.setDate(target.getDate() + 1);
    }
    return formatCountdown(target.toISOString(), nowMs);
  }

  // 3. Compact cleaned fallback (strip boilerplate words)
  const compact = text
    .replace(/^(?:resets?|refreshes?|renews?)\s*(?:in|at|on)?\s*/i, '')
    .replace(/^(?:将于|將於|将在|將在)\s*/i, '')
    .replace(/\s*(?:重置|刷新|恢复|恢復|更新)\s*[。.]?$/i, '')
    .trim();
  return compact ? compact.slice(0, 18) : null;
}

export function formatPoolResetCompact(
  pool: Pick<UsagePool, 'resetAtIso' | 'resetText'>,
  nowMs = Date.now()
): string | null {
  return formatCountdown(pool.resetAtIso, nowMs) ?? formatResetFromText(pool.resetText, nowMs);
}
