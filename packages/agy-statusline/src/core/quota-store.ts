import fs from 'node:fs';
import path from 'node:path';
import type {
  LegacyModelQuota,
  ModelQuotaView,
  QuotaBucket,
  QuotaCacheData,
  QuotaPoolTabView,
  QuotaWindowView
} from './types.js';

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function usedPercentFromFraction(remainingFraction: number): number {
  return Math.trunc((1 - clamp01(remainingFraction)) * 100 + 0.5);
}

function pad2(n: number): string {
  const intVal = Math.max(0, Math.trunc(n));
  return intVal < 10 ? `0${intVal}` : String(intVal);
}

export function formatCountdownCompact(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  let totalMinutes = Math.max(0, Math.trunc(seconds / 60));
  const days = Math.trunc(totalMinutes / (24 * 60));
  totalMinutes -= days * 24 * 60;
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d${pad2(hours)}h`;
  }
  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m`;
  }
  return `${minutes}m`;
}

export function formatLocalResetTime(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface BucketSpec {
  key: string;
  label: string;
}

const ARGON_WEEKLY_KEY = 'gemini-argon-wtu-weekly';

export function resolveQuotaBucketSpecs(
  modelLabel: string,
  quotaMap: Record<string, QuotaBucket>
): { poolLabel: string; specs: BucketSpec[] } {
  const normalized = String(modelLabel || '').toLowerCase();
  if (normalized.includes('claude') || normalized.includes('gpt') || normalized.includes('oss')) {
    return {
      poolLabel: 'Claude / 3P',
      specs: [
        { key: '3p-5h', label: '5h' },
        { key: '3p-weekly', label: '7d' }
      ]
    };
  }
  if (normalized.includes('argon') && Object.prototype.hasOwnProperty.call(quotaMap, ARGON_WEEKLY_KEY)) {
    return {
      poolLabel: 'Gemini Argon',
      specs: [{ key: ARGON_WEEKLY_KEY, label: '7d' }]
    };
  }
  return {
    poolLabel: 'Gemini',
    specs: [
      { key: 'gemini-5h', label: '5h' },
      { key: 'gemini-weekly', label: '7d' }
    ]
  };
}

export function parseQuotaCacheFile(filePath: string): QuotaCacheData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as QuotaCacheData;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!parsed.models || typeof parsed.models !== 'object') {
      parsed.models = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadQuotaCache(candidates: string[]): {
  cache: QuotaCacheData | null;
  loadedFrom: string | null;
  primaryUnloadable: boolean;
} {
  let primaryUnloadable = false;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const parsed = parseQuotaCacheFile(candidate);
    if (parsed) {
      return { cache: parsed, loadedFrom: candidate, primaryUnloadable };
    }
    if (i === 0 && fs.existsSync(candidate)) {
      primaryUnloadable = true;
    }
  }
  return { cache: null, loadedFrom: null, primaryUnloadable };
}

export function filterLiveBuckets(
  quota: Record<string, QuotaBucket> | undefined,
  now: Date
): Record<string, QuotaBucket> {
  const out: Record<string, QuotaBucket> = {};
  if (!quota || typeof quota !== 'object') return out;
  const nowMs = now.getTime();
  for (const [key, bucket] of Object.entries(quota)) {
    if (!bucket || typeof bucket !== 'object') continue;
    const frac = bucket.remaining_fraction;
    if (typeof frac !== 'number' || !Number.isFinite(frac)) continue;
    let resetIso = typeof bucket.reset_time === 'string' ? bucket.reset_time : '';
    let resetSeconds = typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds)
      ? bucket.reset_in_seconds
      : undefined;

    if (resetIso) {
      const resetMs = Date.parse(resetIso);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
        continue;
      }
      resetSeconds = Math.max(0, Math.trunc((resetMs - nowMs) / 1000));
    } else if (resetSeconds !== undefined) {
      if (resetSeconds <= 0) continue;
      resetIso = new Date(nowMs + resetSeconds * 1000).toISOString();
    }

    out[key] = {
      remaining_fraction: clamp01(frac),
      ...(resetIso ? { reset_time: resetIso } : {}),
      ...(resetSeconds !== undefined ? { reset_in_seconds: resetSeconds } : {})
    };
  }
  return out;
}

export function mergeQuotaBuckets(
  officialQuota: Record<string, QuotaBucket> | undefined,
  cachedQuota: Record<string, QuotaBucket> | undefined,
  now: Date
): Record<string, QuotaBucket> {
  const liveOfficial = filterLiveBuckets(officialQuota, now);
  const liveCached = filterLiveBuckets(cachedQuota, now);
  const merged: Record<string, QuotaBucket> = { ...liveOfficial };

  for (const [key, fromCache] of Object.entries(liveCached)) {
    const fromOfficial = Object.prototype.hasOwnProperty.call(liveOfficial, key)
      ? liveOfficial[key]
      : undefined;
    if (!fromOfficial || !Number.isFinite(fromOfficial.remaining_fraction)) {
      merged[key] = fromCache;
      continue;
    }
    const cacheFrac = fromCache.remaining_fraction ?? 1;
    const officialFrac = fromOfficial.remaining_fraction ?? 1;
    if (cacheFrac <= officialFrac) {
      merged[key] = fromCache;
    }
  }
  return merged;
}

function bucketsMateriallyEqual(
  a: Record<string, QuotaBucket> | undefined,
  b: Record<string, QuotaBucket> | undefined
): boolean {
  const keysA = Object.keys(a ?? {}).sort();
  const keysB = Object.keys(b ?? {}).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    const ba = a![k];
    const bb = b![k];
    if (Math.abs((ba.remaining_fraction ?? 1) - (bb.remaining_fraction ?? 1)) > 1e-6) return false;
    const ra = Date.parse(ba.reset_time ?? '');
    const rb = Date.parse(bb.reset_time ?? '');
    // Ignore tiny clock drift (<5s) on untouched floating reset timestamps
    if (Number.isFinite(ra) !== Number.isFinite(rb)) return false;
    if (Number.isFinite(ra) && Math.abs(ra - rb) > 5000) return false;
  }
  return true;
}

export function writeQuotaCacheAtomic(cachePath: string, data: QuotaCacheData): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch {
      // ignore on Windows
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function persistMergedQuotaIfChanged(
  cachePath: string,
  incomingQuota: Record<string, QuotaBucket> | undefined,
  opts: { source?: string; now?: Date; forceWrite?: boolean } = {}
): { written: boolean; cache: QuotaCacheData | null } {
  const now = opts.now ?? new Date();
  const liveIncoming = filterLiveBuckets(incomingQuota, now);
  if (Object.keys(liveIncoming).length === 0) {
    return { written: false, cache: parseQuotaCacheFile(cachePath) };
  }

  const existing = parseQuotaCacheFile(cachePath);
  const existingLive = filterLiveBuckets(existing?.quota, now);

  // When a fresh /usage run succeeds, it is authoritative for active resets, while still protecting
  // against stale lags via mergeQuotaBuckets against unexpired existing readings when source !== 'usage'.
  const nextQuota: Record<string, QuotaBucket> =
    opts.source === 'usage' || opts.source === 'app-rpc'
      ? liveIncoming
      : mergeQuotaBuckets(liveIncoming, existingLive, now);

  // Strip volatile reset_in_seconds when persisting to disk so timestamps remain canonical ISO strings
  const persistedQuota: Record<string, QuotaBucket> = {};
  for (const [k, v] of Object.entries(nextQuota)) {
    persistedQuota[k] = {
      remaining_fraction: v.remaining_fraction,
      ...(v.reset_time ? { reset_time: v.reset_time } : {})
    };
  }

  const unchanged =
    existing !== null &&
    bucketsMateriallyEqual(existing.quota, persistedQuota) &&
    (!opts.forceWrite || existing.source === opts.source);
  if (unchanged) {
    return { written: false, cache: existing };
  }

  const nextCache: QuotaCacheData = {
    ...(existing ?? {}),
    timestamp: now.toISOString(),
    source: opts.source ?? existing?.source ?? 'statusline',
    models: existing?.models ?? {},
    quota: persistedQuota
  };
  writeQuotaCacheAtomic(cachePath, nextCache);
  return { written: true, cache: nextCache };
}

function normalizeModelName(input: string): string {
  return input
    .toLowerCase()
    .replace(/gemini|[()_-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function matchLegacyModelQuota(
  cache: QuotaCacheData | null | undefined,
  modelLabel: string
): LegacyModelQuota | null {
  if (!cache?.models) return null;
  if (Object.prototype.hasOwnProperty.call(cache.models, modelLabel)) {
    return cache.models[modelLabel];
  }
  const needle = normalizeModelName(modelLabel);
  if (!needle) return null;
  for (const [label, quota] of Object.entries(cache.models)) {
    const hay = normalizeModelName(label);
    if (hay && (hay.includes(needle) || needle.includes(hay))) {
      return quota;
    }
  }
  return null;
}

export function buildModelQuotaView(
  cache: QuotaCacheData | null | undefined,
  modelLabel: string,
  officialQuota: Record<string, QuotaBucket> | undefined = undefined,
  now: Date = new Date()
): ModelQuotaView {
  const merged = mergeQuotaBuckets(officialQuota, cache?.quota, now);
  const rawCombined: Record<string, QuotaBucket> = {
    ...(cache?.quota ?? {}),
    ...(officialQuota ?? {})
  };
  const { poolLabel, specs } = resolveQuotaBucketSpecs(
    modelLabel,
    Object.keys(merged).length > 0 ? merged : rawCombined
  );
  const windows: QuotaWindowView[] = [];

  for (const { key, label } of specs) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      const rawBucket = officialQuota?.[key] ?? cache?.quota?.[key];
      const resetMs = rawBucket?.reset_time ? Date.parse(rawBucket.reset_time) : NaN;
      if (
        rawBucket &&
        typeof rawBucket.remaining_fraction === 'number' &&
        Number.isFinite(rawBucket.remaining_fraction) &&
        Number.isFinite(resetMs) &&
        resetMs <= now.getTime()
      ) {
        windows.push({
          key,
          label,
          usedPct: 0,
          remainingPct: 100,
          resetCountdown: '',
          resetLocalTime: '',
          resetTimeIso: ''
        });
      }
      continue;
    }
    const bucket = merged[key];
    const frac = bucket?.remaining_fraction;
    if (typeof frac !== 'number' || !Number.isFinite(frac)) continue;
    const clampedFrac = clamp01(frac);
    const usedPct = usedPercentFromFraction(clampedFrac);
    const remainingPct = Math.max(0, Math.min(100, 100 - usedPct));

    let resetSeconds = typeof bucket.reset_in_seconds === 'number' ? bucket.reset_in_seconds : 0;
    const resetTimeIso = bucket.reset_time ?? '';
    if (resetTimeIso) {
      const ts = Date.parse(resetTimeIso);
      if (Number.isFinite(ts)) {
        resetSeconds = Math.max(0, Math.trunc((ts - now.getTime()) / 1000));
      }
    }
    const resetCountdown = usedPct > 0 && resetSeconds > 0 ? formatCountdownCompact(resetSeconds) : '';
    const resetLocalTime = resetTimeIso ? formatLocalResetTime(resetTimeIso) : '';

    windows.push({
      key,
      label,
      usedPct,
      remainingPct,
      resetCountdown,
      resetLocalTime,
      resetTimeIso
    });
  }

  if (windows.length === 0) {
    const legacy = matchLegacyModelQuota(cache, modelLabel);
    if (legacy && Number.isFinite(legacy.remainingFraction)) {
      const clampedFrac = clamp01(legacy.remainingFraction);
      const usedPct = usedPercentFromFraction(clampedFrac);
      const ts = legacy.resetTime ? Date.parse(legacy.resetTime) : NaN;
      const resetSeconds = Number.isFinite(ts) ? Math.max(0, Math.trunc((ts - now.getTime()) / 1000)) : 0;
      windows.push({
        key: 'legacy',
        label: '5h',
        usedPct,
        remainingPct: Math.max(0, Math.min(100, 100 - usedPct)),
        resetCountdown: usedPct > 0 && resetSeconds > 0 ? formatCountdownCompact(resetSeconds) : '',
        resetLocalTime: legacy.resetTime ? formatLocalResetTime(legacy.resetTime) : '',
        resetTimeIso: legacy.resetTime || ''
      });
    }
  }

  return {
    hasQuota: windows.length > 0,
    poolLabel,
    windows,
    fetchedAtIso: cache?.timestamp || ''
  };
}

export function buildAllQuotaPools(
  cache: QuotaCacheData | null | undefined,
  activeModelLabel: string = 'Gemini',
  officialQuota: Record<string, QuotaBucket> | undefined = undefined,
  now: Date = new Date()
): QuotaPoolTabView[] {
  const norm = String(activeModelLabel || '').toLowerCase();
  const rawCombined: Record<string, QuotaBucket> = {
    ...(cache?.quota ?? {}),
    ...(officialQuota ?? {})
  };
  const hasArgonBucket = Object.prototype.hasOwnProperty.call(rawCombined, ARGON_WEEKLY_KEY);
  const preferredId: 'gemini' | 'claude' | 'argon' =
    norm.includes('claude') || norm.includes('gpt') || norm.includes('oss')
      ? 'claude'
      : norm.includes('argon') && hasArgonBucket
        ? 'argon'
        : 'gemini';

  const defs: Array<{ id: 'gemini' | 'claude' | 'argon'; probe: string; tabLabel: string; poolTitle: string }> = [
    { id: 'gemini', probe: 'Gemini', tabLabel: 'Gemini', poolTitle: 'Gemini' },
    { id: 'claude', probe: 'Claude', tabLabel: 'Claude', poolTitle: 'Claude / GPT' }
  ];
  if (hasArgonBucket) {
    defs.push({ id: 'argon', probe: 'Gemini Argon', tabLabel: 'Argon', poolTitle: 'Gemini Argon' });
  }

  const pools: QuotaPoolTabView[] = [];
  for (const d of defs) {
    const view = buildModelQuotaView(cache, d.probe, officialQuota, now);
    if (!view.hasQuota || view.windows.length === 0) continue;
    pools.push({
      id: d.id,
      tabLabel: d.tabLabel,
      poolTitle: d.poolTitle,
      isDefault: d.id === preferredId,
      windows: view.windows,
      fetchedAtIso: view.fetchedAtIso
    });
  }

  if (pools.length > 0 && !pools.some((p) => p.isDefault)) {
    pools[0].isDefault = true;
  }
  return pools;
}
