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

export function isUsagePathname(pathname: string): boolean {
  return /^(?:\/u\/\d+)?\/usage(?:\/|$)/.test(String(pathname || ''));
}

function normalizePercentageValue(raw: unknown): number | undefined {
  const num =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw.trim().replace(/%$/, ''))
        : NaN;
  if (!Number.isFinite(num) || num < 0) return undefined;
  if (num > 0 && num <= 1 && (typeof raw === 'number' || String(raw).includes('.'))) {
    return clampPct(num * 100);
  }
  if (num === 0) return 0;
  return clampPct(num);
}

function extractPoolsFromObject(root: unknown): UsagePool[] {
  const found: UsagePool[] = [];
  const seen = new Set<string>();
  const visited = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (node == null || depth > 14) return;

    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (
        (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
        /(GXU_|poolType|percentageUsed|pct_used|percentageRemaining|windowRefreshesAt|getUsageInfo|graphqlJson)/.test(
          trimmed
        )
      ) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          // ignore non-JSON strings
        }
      }
      return;
    }

    if (typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    const rec = node as Record<string, unknown>;

    if (typeof rec.graphqlJson === 'string') {
      walk(rec.graphqlJson, depth + 1);
    }

    // Candidate pool object (Google Gemini BudgetPool uses `poolType` + `percentageUsed`)
    const rawUsed =
      rec.percentageUsed ?? rec.percentUsed ?? rec.usedPercentage ?? rec.pct_used ?? rec.percentage_used;
    const rawRemaining =
      rec.percentageRemaining ?? rec.remainingPercentage ?? rec.pct_remaining ?? rec.percentage_remaining;
    const hasUsed = rawUsed !== undefined && rawUsed !== null;
    const hasRemaining = rawRemaining !== undefined && rawRemaining !== null;

    if (hasUsed || hasRemaining) {
      const rawId =
        (typeof rec.poolType === 'string' && rec.poolType) ||
        (typeof rec.id === 'string' && rec.id) ||
        (typeof rec.poolId === 'string' && rec.poolId) ||
        (typeof rec.type === 'string' && rec.type) ||
        (typeof rec.name === 'string' && rec.name) ||
        `pool_${found.length}`;

      let usedPct: number | undefined;
      if (hasUsed) {
        usedPct = normalizePercentageValue(rawUsed);
      } else if (hasRemaining) {
        const rem = normalizePercentageValue(rawRemaining);
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
      if (val && (typeof val === 'object' || typeof val === 'string')) walk(val, depth + 1);
    }
  };

  walk(root, 0);
  return sortPools(found);
}

function sortPools(pools: UsagePool[]): UsagePool[] {
  const rank: Record<UsagePoolKind, number> = { '5h': 0, '7d': 1, other: 2 };
  return [...pools].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function stripXssiPrefix(text: string): string {
  return text.replace(/^\s*\)\]\}'\s*\n?/, '').trim();
}

export interface GraphQLInspectResult {
  snapshot: UsageSnapshot | null;
  canSeeUsageLimits?: boolean;
  errorMessages: string[];
}

export function inspectUsageGraphQL(rawText: string, nowMs = Date.now()): GraphQLInspectResult {
  const cleaned = stripXssiPrefix(rawText);
  if (!cleaned) return { snapshot: null, errorMessages: ['empty_response'] };

  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(cleaned));
  } catch {
    for (const line of cleaned.split(/\r?\n/)) {
      const t = line.trim().replace(/,$/, '');
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try {
        candidates.push(JSON.parse(t));
      } catch {
        // Ignore non-JSON framing lines
      }
    }
  }

  let canSeeUsageLimits: boolean | undefined;
  const errorMessages: string[] = [];
  const allPools: UsagePool[] = [];
  const seenIds = new Set<string>();

  const scanMeta = (node: unknown, depth: number): void => {
    if (!node || depth > 10) return;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          scanMeta(JSON.parse(trimmed), depth + 1);
        } catch {
          // ignore
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) scanMeta(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (typeof rec.canSeeUsageLimits === 'boolean') {
        canSeeUsageLimits = rec.canSeeUsageLimits;
      }
      if (Array.isArray(rec.errors)) {
        for (const err of rec.errors) {
          if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
            errorMessages.push(String((err as Record<string, unknown>).message).slice(0, 120));
          }
        }
      }
      for (const val of Object.values(rec)) {
        if (val && (typeof val === 'object' || typeof val === 'string')) {
          scanMeta(val, depth + 1);
        }
      }
    }
  };

  for (const candidate of candidates) {
    scanMeta(candidate, 0);
    for (const p of extractPoolsFromObject(candidate)) {
      const key = `${p.kind}:${p.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        allPools.push(p);
      }
    }
  }

  const sorted = sortPools(allPools);
  return {
    snapshot:
      sorted.length > 0
        ? {
            pools: sorted,
            fetchedAt: nowMs,
            source: 'graphql'
          }
        : null,
    ...(canSeeUsageLimits !== undefined ? { canSeeUsageLimits } : {}),
    errorMessages
  };
}

export function parseUsageGraphQL(rawText: string, nowMs = Date.now()): UsageSnapshot | null {
  return inspectUsageGraphQL(rawText, nowMs).snapshot;
}

export function parseUsageFromInlineScripts(
  scriptContents: Iterable<string>,
  nowMs = Date.now()
): UsageSnapshot | null {
  for (const text of scriptContents) {
    if (
      !text ||
      !/(GXU_FIVE_HOURLY|GXU_WEEKLY|percentageUsed|pct_used|windowRefreshesAt|getUsageInfo)/.test(text)
    ) {
      continue;
    }
    const direct = parseUsageGraphQL(text, nowMs);
    if (direct) return direct;

    // Extract JSON objects/arrays embedded inside AF_initDataCallback(...) or assignments
    const cbRegex = /AF_initDataCallback\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;?/g;
    let m: RegExpExecArray | null;
    while ((m = cbRegex.exec(text)) !== null) {
      const candidate = m[1];
      const normalizedJson = candidate.replace(
        /([{,]\s*)(key|hash|data|sideChannel)(\s*:)/g,
        '$1"$2"$3'
      ).replace(/'([^'\\]*)'/g, '"$1"');
      const snap = parseUsageGraphQL(normalizedJson, nowMs);
      if (snap) return snap;
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
    pattern: /(5[\s-]*hour|5\s*hr|每?\s*5\s*小时|五小时|current\s*(?:window|limit|usage)|session\s*(?:limit|usage)|当前(?:窗口|限额|用量))/i
  },
  {
    kind: '7d',
    label: '7d',
    id: 'DOM_WEEKLY',
    pattern: /(weekly|7[\s-]*day|每周|每?\s*7\s*天|七天|本周(?:限额|用量)?|周限额|周用量)/i
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

      // Include up to 2 preceding lines (in case percentage sits above the window label)
      // and up to 6 following lines without bleeding across adjacent quota sections.
      let start = Math.max(0, i - 2);
      for (let j = i - 1; j >= start; j--) {
        if (DOM_SECTIONS.some((other) => other.pattern.test(lines[j]))) {
          start = j + 1;
          break;
        }
      }
      let end = Math.min(lines.length, i + 6);
      for (let j = i + 1; j < end; j++) {
        if (DOM_SECTIONS.some((other) => other.kind !== section.kind && other.pattern.test(lines[j]))) {
          end = j;
          break;
        }
      }
      const afterFirstBlock = [
        ...lines.slice(i, end),
        ...lines.slice(start, i)
      ].join('\n');
      const pct = extractPctFromBlock(afterFirstBlock);
      if (pct) {
        seenKinds.add(section.kind);
        const resetText = extractResetTextFromBlock(afterFirstBlock);
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
