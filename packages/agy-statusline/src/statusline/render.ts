import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultConfig,
  resolveQuotaCachePath,
  resolveSeedQuotaCachePaths
} from '../core/config.js';
import {
  formatContextCeiling,
  formatContextUsed,
  selectCacheRate,
  toneForCachePct,
  toneForTps,
  toneForUsagePct
} from '../core/format.js';
import {
  buildModelQuotaView,
  loadQuotaCache,
  persistMergedQuotaIfChanged
} from '../core/quota-store.js';
import { parseConversationMetrics, UUID_RE } from '../core/sqlite-metrics.js';
import type {
  QuotaCacheData,
  SessionMetrics,
  StatuslinePayload,
  UserConfig
} from '../core/types.js';
import { recordUsageOutcome, spawnDetachedQuotaRefresh } from '../core/usage-runner.js';
import { ANSI, colorForTone, colorize, truncateColumns, visibleLen } from './ansi.js';
import { resolveGitBranch, sanitizeBranchName } from './git.js';

export const STDIN_TIMEOUT_MS = 1000;

export function shortModelName(display: string): string {
  const raw = String(display || '').trim();
  if (!raw) return 'Gemini';
  let s = raw
    .replace(/\bGemini\b/gi, '')
    .replace(/\bClaude\b/gi, '')
    .replace(/\bThinking\b/gi, '')
    .replace(/\bOrchestrator\b/gi, 'Orch')
    .replace(/\bMedium\b/gi, 'Med')
    .replace(/\bExtra\s+High\b/gi, 'XHigh')
    .replace(/[()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  if (!s) s = raw;
  if (visibleLen(s) > 20) {
    s = `${truncateColumns(s, 17)}...`;
  }
  return s;
}

export function isCompleteJsonObject(raw: string): boolean {
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function readStdinJson(
  stdin: NodeJS.ReadableStream = process.stdin,
  timeoutMs: number = STDIN_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      stdin.removeListener('error', finish);
      stdin.on('error', () => {});
      stdin.pause();
      (stdin as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve(raw);
    };
    const onData = (chunk: string) => {
      raw += chunk;
      if (isCompleteJsonObject(raw)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function resolveContextSummary(
  payload: StatuslinePayload,
  metrics: SessionMetrics | null,
  config: UserConfig
): { usedTokens: number; limitTokens: number; pct: number } {
  const cw = payload.context_window;
  const rawInput =
    typeof cw?.total_input_tokens === 'number' && Number.isFinite(cw.total_input_tokens)
      ? cw.total_input_tokens
      : 0;
  const rawWin =
    typeof cw?.context_window_size === 'number' && Number.isFinite(cw.context_window_size)
      ? cw.context_window_size
      : 0;

  const limitTokens =
    config.contextLimitOverride > 0
      ? config.contextLimitOverride
      : rawWin > 0
        ? rawWin
        : metrics && metrics.hasData && metrics.contextLimitTokens > 0
          ? metrics.contextLimitTokens
          : 0;

  let usedTokens = 0;
  if (rawInput > 0) {
    usedTokens = rawInput;
  } else if (metrics && metrics.hasData && metrics.ctxTokens > 0) {
    usedTokens = metrics.ctxTokens;
  } else if (
    limitTokens > 0 &&
    typeof cw?.used_percentage === 'number' &&
    Number.isFinite(cw.used_percentage) &&
    cw.used_percentage > 0
  ) {
    usedTokens = Math.round((cw.used_percentage / 100) * limitTokens);
  }

  let pct = 0;
  if (usedTokens > 0 && limitTokens > 0) {
    pct = clampPct((usedTokens / limitTokens) * 100);
  } else if (typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage) && cw.used_percentage > 0) {
    pct = clampPct(cw.used_percentage);
  } else if (metrics && metrics.hasData) {
    pct = clampPct(metrics.ctxPct);
  } else {
    pct = clampPct(cw?.used_percentage ?? 0);
  }

  return { usedTokens, limitTokens, pct };
}

function validDir(dir: string | undefined): string {
  const clean = String(dir || '').trim();
  if (!clean) return '';
  try {
    return fs.statSync(clean).isDirectory() ? clean : '';
  } catch {
    return '';
  }
}

export function detectGitBranch(payload: StatuslinePayload): string {
  const dirs = [
    payload.workspace?.current_dir,
    payload.cwd,
    payload.vcs?.root,
    payload.workspace?.project_dir
  ];
  for (const d of dirs) {
    const dir = validDir(d);
    if (!dir) continue;
    const b = resolveGitBranch(dir);
    if (b) return b;
  }
  const fromPayload = sanitizeBranchName(payload.vcs?.branch ?? '');
  if (fromPayload) return fromPayload;
  if (!payload.cwd || path.basename(process.cwd()) === path.basename(payload.cwd)) {
    const cwdBranch = resolveGitBranch(process.cwd());
    if (cwdBranch) return cwdBranch;
  }
  return '';
}

export interface RenderStatuslineOptions {
  config?: UserConfig;
  cache?: QuotaCacheData | null;
  homedir?: string;
  now?: Date;
  metrics?: SessionMetrics | null;
  gitBranch?: string;
}

export function renderStatusline(rawInput: string, opts: RenderStatuslineOptions = {}): string {
  if (!rawInput || !rawInput.trim()) {
    return 'agy-statusline';
  }
  let payload: StatuslinePayload;
  try {
    payload = JSON.parse(rawInput) as StatuslinePayload;
  } catch {
    return 'agy-statusline';
  }

  const config = opts.config ?? defaultConfig();
  const homedir = opts.homedir ?? os.homedir();
  const now = opts.now ?? new Date();
  const color = config.cli.color;
  const width =
    typeof payload.terminal_width === 'number' && payload.terminal_width > 0
      ? payload.terminal_width
      : 100;

  let metrics: SessionMetrics | null = opts.metrics !== undefined ? opts.metrics : null;
  if (opts.metrics === undefined) {
    const rawCid = String(payload.conversation_id || payload.session_id || '').trim().toLowerCase();
    if (UUID_RE.test(rawCid)) {
      const cliConvDir = path.join(homedir, '.gemini', 'antigravity-cli', 'conversations');
      metrics = parseConversationMetrics(rawCid, cliConvDir, {
        contextLimit: config.contextLimit,
        contextLimitOverride: config.contextLimitOverride
      });
    }
  }

  const modelDisplay = payload.model?.display_name || payload.model?.id || 'Gemini';
  let modelPart = '';
  if (config.cli.showModel) {
    if (metrics && metrics.hasData && metrics.isOrchestrator) {
      const phaseTag = metrics.orchestratorPhase === 'exec' ? 'Exec' : 'Plan';
      const phaseColor = metrics.orchestratorPhase === 'exec' ? ANSI.cyan : ANSI.magenta;
      const mName = metrics.activeShortModel || (metrics.orchestratorPhase === 'exec' ? 'Hydrogen' : 'Carbon');
      modelPart = `${colorize(`Orch·${mName}`, ANSI.blue, color)} ${colorize(phaseTag, phaseColor, color)}`;
    } else {
      modelPart = colorize(shortModelName(modelDisplay), ANSI.blue, color);
    }
  }
  const branchName = config.cli.showGitBranch
    ? (opts.gitBranch ?? detectGitBranch(payload))
    : '';
  const branchPart = branchName ? colorize(branchName, ANSI.magenta, color) : '';

  const ctxInfo = resolveContextSummary(payload, metrics, config);
  const ctxBracket = `[${formatContextUsed(ctxInfo.usedTokens)}/${formatContextCeiling(ctxInfo.limitTokens)}]`;
  const ctxPctColored = colorize(`${ctxInfo.pct}%`, colorForTone(toneForUsagePct(ctxInfo.pct)), color);
  const ctxStr = `${colorize(ctxBracket, ANSI.muted, color)} ${ctxPctColored}`;

  const hasMetrics = Boolean(metrics && metrics.hasData);
  const stepCacheRate = hasMetrics && metrics ? Math.round(Math.max(0, Math.min(100, metrics.lastCacheRate))) : 0;
  const sessCacheRate = hasMetrics && metrics ? Math.round(Math.max(0, Math.min(100, metrics.sessionCacheRate))) : 0;
  const singleCacheRate = hasMetrics && metrics ? Math.round(selectCacheRate(metrics, config)) : 0;
  const cacheDualStr =
    hasMetrics && metrics
      ? `Cache ${colorize(`${stepCacheRate}%`, colorForTone(toneForCachePct(stepCacheRate)), color)}${colorize(`/${sessCacheRate}%`, ANSI.muted, color)}`
      : '';
  const cacheCompactStr =
    hasMetrics && metrics
      ? `Cache ${colorize(`${singleCacheRate}%`, colorForTone(toneForCachePct(singleCacheRate)), color)}`
      : '';
  const tpsRounded = hasMetrics && metrics ? Math.round(metrics.tps || 0) : 0;
  const tpsStr =
    hasMetrics && metrics
      ? `${colorize(String(tpsRounded), colorForTone(toneForTps(metrics.tps || 0)), color)} tok/s`
      : '';
  const subStr =
    hasMetrics && metrics && metrics.subagentCount > 0
      ? colorize(`+${metrics.subagentCount} sub`, ANSI.cyan, color)
      : '';

  const quotaView = buildModelQuotaView(opts.cache, modelDisplay, payload.quota, now);

  const fmtQuotaWindows = (withReset: boolean): string => {
    if (!quotaView.hasQuota) return '';
    return quotaView.windows
      .map((w) => {
        const pctColored = colorize(
          `${w.usedPct}%`,
          colorForTone(toneForUsagePct(w.usedPct)),
          color
        );
        const resetPart =
          withReset && w.resetCountdown
            ? ` ${colorize(w.resetCountdown, ANSI.muted, color)}`
            : '';
        return `${w.label} ${pctColored}${resetPart}`;
      })
      .join(colorize(' · ', ANSI.muted, color));
  };

  const quotaFull = fmtQuotaWindows(true);
  const quotaCompact = fmtQuotaWindows(false);

  const sepPipe = colorize(' │ ', ANSI.muted, color);
  const sepDot = colorize(' · ', ANSI.muted, color);

  const joinParts = (header: string[], body: string[]): string => {
    const bodyStr = body.filter(Boolean).join(sepDot);
    const all = [...header.filter(Boolean), bodyStr].filter(Boolean);
    return all.join(sepPipe);
  };

  const candidates = [
    joinParts([modelPart, branchPart], [ctxStr, cacheDualStr, tpsStr, quotaFull, subStr]),
    joinParts([modelPart], [ctxStr, cacheDualStr, tpsStr, quotaFull]),
    joinParts([], [ctxStr, cacheDualStr, tpsStr, quotaFull]),
    joinParts([], [ctxStr, cacheCompactStr, tpsStr, quotaCompact]),
    joinParts([], [ctxStr, quotaCompact]),
    ctxStr
  ].filter(Boolean);

  for (const line of candidates) {
    if (visibleLen(line) <= width) {
      return line;
    }
  }
  const fallback = candidates[candidates.length - 1] ?? ctxStr;
  return truncateColumns(fallback, width);
}

export async function runStatuslineCommand(
  cliEntryPath: string,
  config: UserConfig,
  opts: {
    homedir?: string;
    env?: Record<string, string | undefined>;
    stdin?: NodeJS.ReadableStream;
    stdout?: (s: string) => void;
    now?: Date;
  } = {}
): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? os.homedir();
  const now = opts.now ?? new Date();

  if (env.AGY_STATUSLINE_NESTED === '1' || env.AGY_HUD_NESTED === '1') {
    await readStdinJson(opts.stdin ?? process.stdin, STDIN_TIMEOUT_MS);
    return 0;
  }

  const raw = await readStdinJson(opts.stdin ?? process.stdin, STDIN_TIMEOUT_MS);
  let payload: StatuslinePayload | null = null;
  try {
    payload = JSON.parse(raw) as StatuslinePayload;
  } catch {
    payload = null;
  }

  const cachePath = resolveQuotaCachePath(homedir, env);
  const { cache: seedCache } = loadQuotaCache(resolveSeedQuotaCachePaths(homedir, env));
  let activeCache = seedCache;

  const hasStdinQuota = Boolean(payload?.quota && Object.keys(payload.quota).length > 0);
  if (hasStdinQuota && payload?.quota) {
    try {
      const res = persistMergedQuotaIfChanged(cachePath, payload.quota, {
        source: 'statusline',
        now
      });
      if (res.cache) activeCache = res.cache;
      recordUsageOutcome(cachePath, true, '', now);
    } catch {
      // ignore cache write errors on statusline hot path
    }
  }

  const agentState = String(payload?.agent_state || '').trim().toLowerCase();
  const isActive = agentState !== '' && agentState !== 'idle';
  if (cliEntryPath && !hasStdinQuota) {
    spawnDetachedQuotaRefresh(cliEntryPath, cachePath, isActive, activeCache, now, homedir);
  }

  const line = renderStatusline(raw, {
    config,
    cache: activeCache,
    homedir,
    now
  });
  stdout(`${line}\n`);
  return 0;
}
