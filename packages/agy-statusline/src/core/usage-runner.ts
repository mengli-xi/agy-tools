import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadUserConfig, resolveEffectiveProxyEnv } from './config.js';
import { parseQuotaCacheFile, persistMergedQuotaIfChanged } from './quota-store.js';
import type { QuotaBucket, QuotaCacheData } from './types.js';

export const USAGE_COMMAND_ARGS = ['-p', '/usage', '--output-format', 'json', '--print-timeout', '15s'];

export interface UsageRunResult {
  code: number | null;
  stdout: string;
  stderr?: string;
  timedOut: boolean;
  error?: string;
}

export type UsageRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<UsageRunResult>;

export type UsageOutcome =
  | { ok: true; quota: Record<string, QuotaBucket> }
  | { ok: false; message: string; authError?: boolean };

export interface BackoffMarker {
  failures?: number;
  retryAt?: string;
  lastError?: string;
}

const SCRATCH_PREFIX = 'agy-statusline-usage-';
const STALE_SCRATCH_MS = 60 * 60 * 1000;
const USAGE_RESET_ROLLOVER_FLOOR_MS = 60 * 1000;
const USAGE_ACTIVE_FLOOR_MS = 90 * 1000;
const USAGE_IDLE_FLOOR_MS = 15 * 60 * 1000;
const USAGE_LOCK_STALE_MS = 120 * 1000;
const BACKOFF_STEPS_MS = [3 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
const AUTH_BACKOFF_MS = 30 * 60 * 1000;

const AUTH_ERROR_RE =
  /authentication required|not logged in|login required|switchlogintoauthcode|unauthenticated|invalid_grant|oauth token|please sign in|please log in/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseUsageOutput(stdout: string): Record<string, QuotaBucket> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const groups = asRecord(asRecord(asRecord(parsed).command).data).groups;
  if (!Array.isArray(groups)) return null;

  const quota: Record<string, QuotaBucket> = {};
  for (const group of groups) {
    const buckets = asRecord(group).buckets;
    if (!Array.isArray(buckets)) continue;
    for (const raw of buckets) {
      const bucket = asRecord(raw);
      const id = bucket.id;
      const fraction = bucket.remaining_fraction;
      const reset = bucket.reset_time;
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) continue;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      if (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset))) continue;
      quota[id] = { remaining_fraction: fraction, reset_time: reset };
    }
  }
  return Object.keys(quota).length > 0 ? quota : null;
}

export function sweepStaleScratch(root: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_SCRATCH_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function killWindowsTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  let ended = false;
  try {
    const res = spawnSync(taskkill, ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000
    });
    ended = res.error === undefined && res.status === 0;
  } catch {
    ended = false;
  }
  if (!ended) child.kill('SIGKILL');
}

export function resolveAgyCommand(platform: string = process.platform, homedir: string = os.homedir()): string {
  const candidates =
    platform === 'win32'
      ? [
          path.join(homedir, '.gemini', 'bin', 'agy.exe'),
          path.join(homedir, '.gemini', 'bin', 'agy.cmd'),
          path.join(homedir, '.gemini', 'antigravity-cli', 'bin', 'agy.exe'),
          path.join(homedir, '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'),
          'agy'
        ]
      : [
          path.join(homedir, '.gemini', 'bin', 'agy'),
          path.join(homedir, '.local', 'bin', 'agy'),
          path.join(homedir, '.gemini', 'antigravity-cli', 'bin', 'agy'),
          '/opt/homebrew/bin/agy',
          '/usr/local/bin/agy',
          'agy'
        ];
  for (const c of candidates) {
    if (c === 'agy') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return 'agy';
}

export interface RunAgyOptions {
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
  platform?: string;
}

function installNoopBrowserShims(scratchDir: string, basePath: string | undefined, platform: string): string {
  if (platform === 'win32') {
    return basePath || '';
  }
  const shimDir = path.join(scratchDir, 'no-browser-bin');
  try {
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    const script = '#!/bin/sh\nexit 0\n';
    for (const binName of ['open', 'xdg-open', 'sensible-browser', 'wslview']) {
      const p = path.join(shimDir, binName);
      fs.writeFileSync(p, script, { encoding: 'utf8', mode: 0o755 });
    }
    return basePath ? `${shimDir}${path.delimiter}${basePath}` : shimDir;
  } catch {
    return basePath || '';
  }
}

export function runAgyUsage(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: RunAgyOptions = {}
): Promise<UsageRunResult> {
  const {
    command = resolveAgyCommand(options.platform),
    timeoutMs = 20 * 1000,
    maxBytes = 1024 * 1024,
    platform = process.platform
  } = options;

  return new Promise((resolve) => {
    let scratch: string;
    try {
      sweepStaleScratch(os.tmpdir());
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(err) });
      return;
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      BROWSER: platform === 'win32' ? '' : '/usr/bin/true',
      AGY_CLI_NONINTERACTIVE_HEADLESS: 'true',
      CI: '1'
    };
    if (platform !== 'win32') {
      childEnv.PATH = installNoopBrowserShims(scratch, env.PATH, platform);
    }

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    const maxErrBytes = 16 * 1024;
    let timedOut = false;
    let settled = false;
    const detached = platform !== 'win32';

    const child = spawn(command, args, {
      cwd: scratch,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true
    });

    const finish = (result: UsageRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr.destroy();
      } catch {
        // ignore
      }
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // ignore
      }
      resolve(result);
    };

    let treeKillStarted = false;
    const killGroup = () => {
      if (platform === 'win32') {
        if (treeKillStarted) return;
        treeKillStarted = true;
        killWindowsTree(child);
        return;
      }
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        killGroup();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (errSize >= maxErrBytes) return;
      const slice = errSize + chunk.length > maxErrBytes ? chunk.subarray(0, maxErrBytes - errSize) : chunk;
      errChunks.push(slice);
      errSize += slice.length;
    });

    child.on('error', (err) => finish({ code: null, stdout: '', stderr: '', timedOut: false, error: String(err) }));
    child.on('close', (code) =>
      finish({
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut
      })
    );
    child.on('exit', (code) => {
      setTimeout(() => {
        if (settled) return;
        killGroup();
        finish({
          code,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          timedOut
        });
      }, 500).unref();
    });
  });
}

export async function queryUsage(
  runner: UsageRunner = runAgyUsage,
  opts: { homedir?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<UsageOutcome> {
  const baseEnv = opts.env ?? process.env;
  const userCfg = loadUserConfig(opts.homedir ?? os.homedir(), baseEnv);
  const proxyEnv = resolveEffectiveProxyEnv(userCfg.config.proxy, baseEnv);

  const result = await runner(USAGE_COMMAND_ARGS, {
    ...baseEnv,
    ...proxyEnv,
    AGY_STATUSLINE_NESTED: '1',
    AGY_HUD_NESTED: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    AGY_CLI_NONINTERACTIVE_HEADLESS: 'true',
    BROWSER: process.platform === 'win32' ? '' : '/usr/bin/true'
  });

  if (result.error !== undefined) {
    return { ok: false, message: 'agy /usage failed: could not start agy.' };
  }
  const combinedText = `${result.stdout}\n${result.stderr || ''}`;
  if (AUTH_ERROR_RE.test(combinedText)) {
    return { ok: false, message: 'agy /usage failed: authentication required.', authError: true };
  }
  if (result.timedOut) {
    return { ok: false, message: 'agy /usage failed: timed out.' };
  }
  if (result.code !== 0) {
    return { ok: false, message: `agy /usage failed: exit ${result.code ?? 'signal'}.` };
  }
  const quota = parseUsageOutput(result.stdout);
  if (quota === null) {
    return { ok: false, message: 'agy /usage failed: unreadable output.' };
  }
  return { ok: true, quota };
}

export function backoffPathFor(cachePath: string): string {
  return `${cachePath}.backoff.json`;
}

export function readBackoffMarker(cachePath: string): BackoffMarker | null {
  try {
    const p = backoffPathFor(cachePath);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as BackoffMarker;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

export function recordUsageOutcome(
  cachePath: string,
  ok: boolean,
  errorMsg = '',
  now: Date = new Date(),
  authError = false
): void {
  const p = backoffPathFor(cachePath);
  if (ok) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
    return;
  }
  const prev = readBackoffMarker(cachePath);
  const failures = (prev?.failures ?? 0) + 1;
  const stepDelay = BACKOFF_STEPS_MS[Math.min(failures - 1, BACKOFF_STEPS_MS.length - 1)];
  const isAuth = authError || /authentication required/i.test(errorMsg);
  const delayMs = isAuth ? Math.max(stepDelay, AUTH_BACKOFF_MS) : stepDelay;
  const next: BackoffMarker = {
    failures,
    retryAt: new Date(now.getTime() + delayMs).toISOString(),
    lastError: errorMsg
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // ignore
  }
}

export function takeUsageLock(lockPath: string, token: string, now: Date = new Date()): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (now.getTime() - fs.statSync(lockPath).mtimeMs <= USAGE_LOCK_STALE_MS) {
          return false;
        }
        const aside = `${lockPath}.stale-${token}`;
        fs.renameSync(lockPath, aside);
        fs.rmSync(aside, { force: true });
      } catch (takeoverErr) {
        if ((takeoverErr as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
  }
  return false;
}

export function releaseUsageLock(lockPath: string, token: string): void {
  try {
    if (token && fs.readFileSync(lockPath, 'utf8') === token) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

export function isUsageRefreshDue(
  cachePath: string,
  cache: QuotaCacheData | null,
  active: boolean,
  now: Date = new Date()
): boolean {
  const nowMs = now.getTime();
  const backoff = readBackoffMarker(cachePath);
  const retryMs = Date.parse(backoff?.retryAt ?? '');
  if (Number.isFinite(retryMs) && retryMs > nowMs) {
    return false;
  }
  const cacheTimeMs = Date.parse(cache?.timestamp ?? '');
  const ageMs = Number.isFinite(cacheTimeMs) ? nowMs - cacheTimeMs : Infinity;
  const hasExpiredWindow = Boolean(
    cache?.quota &&
      Object.values(cache.quota).some((b) => {
        if (!b || typeof b.reset_time !== 'string') return false;
        const rt = Date.parse(b.reset_time);
        return Number.isFinite(rt) && rt <= nowMs;
      })
  );
  if (hasExpiredWindow && ageMs > USAGE_RESET_ROLLOVER_FLOOR_MS) {
    return true;
  }
  const floorMs = active ? USAGE_ACTIVE_FLOOR_MS : USAGE_IDLE_FLOOR_MS;
  return ageMs > floorMs;
}

export async function refreshQuotaViaUsage(
  cachePath: string,
  opts: { background?: boolean; lockToken?: string; runner?: UsageRunner; now?: Date; homedir?: string } = {}
): Promise<{ ok: boolean; message: string; summary?: string }> {
  const now = opts.now ?? new Date();
  const lockPath = `${cachePath}.lock`;
  let ownToken = opts.lockToken ?? '';
  let ownsLock = false;

  if (opts.background) {
    try {
      const owner = fs.readFileSync(lockPath, 'utf8');
      if (!ownToken || owner !== ownToken) {
        return { ok: false, message: 'Skipped agy /usage: does not hold lock.' };
      }
      ownsLock = true;
    } catch {
      return { ok: false, message: 'Skipped agy /usage: lock missing.' };
    }
    const backoff = readBackoffMarker(cachePath);
    const retryMs = Date.parse(backoff?.retryAt ?? '');
    if (Number.isFinite(retryMs) && retryMs > now.getTime()) {
      releaseUsageLock(lockPath, ownToken);
      return { ok: false, message: 'Skipped agy /usage: failure backoff active.' };
    }
    const existing = parseQuotaCacheFile(cachePath);
    const cacheTs = Date.parse(existing?.timestamp ?? '');
    if (
      (existing?.source === 'usage' || existing?.source === 'app-rpc') &&
      Number.isFinite(cacheTs) &&
      now.getTime() - cacheTs < USAGE_RESET_ROLLOVER_FLOOR_MS
    ) {
      releaseUsageLock(lockPath, ownToken);
      return { ok: true, message: 'Skipped agy /usage: cache already fresh.' };
    }
  } else {
    ownToken = randomUUID();
    ownsLock = takeUsageLock(lockPath, ownToken, now);
  }

  try {
    const outcome = await queryUsage(opts.runner, { homedir: opts.homedir });
    if (!outcome.ok) {
      recordUsageOutcome(cachePath, false, outcome.message, now, outcome.authError);
      return { ok: false, message: outcome.message };
    }
    persistMergedQuotaIfChanged(cachePath, outcome.quota, {
      source: 'usage',
      now,
      forceWrite: true
    });
    recordUsageOutcome(cachePath, true, '', now);
    const summary = Object.entries(outcome.quota)
      .map(([k, b]) => `${k} ${Math.round((1 - (b.remaining_fraction ?? 1)) * 100)}% used`)
      .join(', ');
    return { ok: true, message: `Updated quota cache at ${cachePath}`, summary };
  } finally {
    if (ownsLock && ownToken) {
      releaseUsageLock(lockPath, ownToken);
    }
  }
}

export function spawnDetachedQuotaRefresh(
  cliEntryPath: string,
  cachePath: string,
  active: boolean,
  cache: QuotaCacheData | null,
  now: Date = new Date(),
  homedir?: string
): boolean {
  if (!isUsageRefreshDue(cachePath, cache, active, now)) return false;
  const lockPath = `${cachePath}.lock`;
  const token = randomUUID();
  if (!takeUsageLock(lockPath, token, now)) return false;
  const spawnArgs = [
    '--disable-warning=ExperimentalWarning',
    cliEntryPath,
    'quota',
    'refresh',
    '--background',
    '--lock-token',
    token
  ];
  if (homedir && path.resolve(homedir) !== path.resolve(os.homedir())) {
    spawnArgs.push('--home', homedir);
  }
  try {
    const child = spawn(process.execPath, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return true;
  } catch {
    releaseUsageLock(lockPath, token);
    return false;
  }
}
