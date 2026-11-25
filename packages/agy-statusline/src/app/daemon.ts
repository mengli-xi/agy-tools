import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  ensureLoopbackNoProxy,
  loadUserConfig,
  readHostPluginEnabled,
  resolveQuotaCachePath,
  resolveSeedQuotaCachePaths,
  stripBom
} from '../core/config.js';
import { buildAppPayload } from '../core/format.js';
import {
  buildAllQuotaPools,
  buildModelQuotaView,
  loadQuotaCache,
  persistMergedQuotaIfChanged
} from '../core/quota-store.js';
import {
  ChannelEndpoint,
  getCompositeChildSnapshot,
  getDbState,
  isSqliteAvailable,
  parseConversationMetrics,
  UUID_RE
} from '../core/sqlite-metrics.js';
import type { AppRenderItem, QuotaBucket, QuotaCacheData, UserConfig, WatchedPanel } from '../core/types.js';
import { isUsageRefreshDue, recordUsageOutcome, spawnDetachedQuotaRefresh } from '../core/usage-runner.js';
import {
  findRecentActiveWal,
  readHostVersionAndProcesses,
  readRelaunchGuard,
  sleepSync,
  writeRelaunchGuard
} from './host-probe.js';

export const APP_VERSION = '0.3.0';

const HOST_QUOTA_RPC_EXPRESSION = `(async function(){
  try {
    var cachedRef = window.__ag_statusline_ls_ref;
    var ls = cachedRef && typeof cachedRef.deref === 'function' ? cachedRef.deref() : null;
    if (!ls || typeof ls.retrieveUserQuotaSummary !== 'function') {
      ls = null;
      var root = document.getElementById('root') || document.body;
      if (!root) return { ok: false };
      var fk = Object.keys(root).find(function(k){ return k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0; });
      if (!fk || !root[fk]) return { ok: false };
      var q = [root[fk]];
      var seen = new Set();
      var n = 0;
      while (q.length > 0 && n < 3500) {
        var f = q.shift();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        n++;
        var v = f.memoizedProps && f.memoizedProps.value;
        if (v && typeof v === 'object' && typeof v.retrieveUserQuotaSummary === 'function') {
          ls = v;
          break;
        }
        if (f.child) q.push(f.child);
        if (f.sibling) q.push(f.sibling);
      }
      if (ls && typeof WeakRef === 'function') {
        window.__ag_statusline_ls_ref = new WeakRef(ls);
      }
    }
    if (!ls) return { ok: false };
    var raw = await ls.retrieveUserQuotaSummary({ forceRefresh: true });
    var res = (raw && raw.response) || raw || {};
    var groups = Array.isArray(res.groups) ? res.groups : [];
    var buckets = [];
    for (var i = 0; i < groups.length; i++) {
      var bs = (groups[i] && groups[i].buckets) || [];
      for (var j = 0; j < bs.length; j++) {
        var b = bs[j];
        if (!b || b.disabled) continue;
        var id = typeof b.bucketId === 'string' ? b.bucketId : '';
        var frac = typeof b.remainingFraction === 'number'
          ? b.remainingFraction
          : (b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number' ? b.remaining.value : null);
        var rt = b.resetTime;
        var iso = '';
        if (typeof rt === 'string') {
          iso = rt;
        } else if (rt && typeof rt === 'object' && rt.seconds !== undefined) {
          var ms = Number(rt.seconds || 0) * 1000 + Math.floor(Number(rt.nanos || 0) / 1e6);
          if (isFinite(ms) && ms > 0) iso = new Date(ms).toISOString();
        }
        if (id && frac !== null && isFinite(frac) && iso) {
          buckets.push({ id: id, remainingFraction: frac, resetTime: iso });
        }
      }
    }
    return { ok: buckets.length > 0, buckets: buckets };
  } catch (e) {
    return { ok: false };
  }
})()`;

const ALLOWED_ORIGINS = [
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://localhost',
  'https://localhost',
  'vscode-file://'
];

const HOST_PROBE_EXPRESSION = `(function(){
  try {
    if (window.top !== window) return 'non_host';
    if (window.location && window.location.protocol === 'vscode-file:') return 'host';
    if (window.__APP_CONFIG__ && window.__APP_CONFIG__.productName === 'antigravity') return 'host';
    var n = window.electronNative;
    if (n && ((typeof n.setTitleBarOverlay === 'function' && window.nativeStorage && typeof window.nativeStorage.getItems === 'function') ||
        (typeof n.getZoomLevel === 'function' && n.wcvBrowser && typeof n.wcvBrowser.setThemeColor === 'function'))) {
      return 'host';
    }
    if (typeof document !== 'undefined' && document.querySelector) {
      if (document.querySelector('link[href*="/jetbox.css"], body[data-agy-theme], body[data-newux-theme], [id="antigravity.agentSidePanelInputBox"]')) {
        return 'host';
      }
      if (document.readyState === 'complete' && document.body) {
        return 'non_host';
      }
    }
    return 'pending';
  } catch (e) {
    return 'pending';
  }
})()`;

export function daemonPidFilePath(): string {
  return path.join(os.tmpdir(), 'agy-statusline-daemon.pid');
}

export function daemonLogFilePath(): string {
  return path.join(os.tmpdir(), 'agy-statusline-daemon.log');
}

export function logDaemon(msg: string): void {
  try {
    const logPath = daemonLogFilePath();
    const line = `[${new Date().toISOString()}] [PID ${process.pid}] ${msg}\n`;
    if (fs.existsSync(logPath)) {
      const st = fs.statSync(logPath);
      if (st.size > 131072) {
        const buf = fs.readFileSync(logPath);
        const tail = buf.subarray(Math.max(0, buf.length - 32768));
        fs.writeFileSync(logPath, Buffer.concat([tail, Buffer.from(line, 'utf8')]));
        return;
      }
    }
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // ignore
  }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && (err as NodeJS.ErrnoException).code === 'EPERM');
  }
}

export function parseDaemonPidFile(filePath: string = daemonPidFilePath()): {
  pid: number;
  startMs: number;
  stopRequested: boolean;
} {
  try {
    if (!fs.existsSync(filePath)) return { pid: 0, startMs: 0, stopRequested: false };
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { pid: 0, startMs: 0, stopRequested: false };
    const lines = raw.split(/\r?\n/);
    const pid = parseInt(lines[0] || '0', 10) || 0;
    const second = (lines[1] || '').trim();
    if (second === 'STOP') return { pid, startMs: 0, stopRequested: true };
    const startMs = parseInt(second, 10) || 0;
    return { pid, startMs, stopRequested: false };
  } catch {
    return { pid: 0, startMs: 0, stopRequested: false };
  }
}

export function isDaemonProcessConfirmed(pid: number): boolean {
  if (!pid || pid <= 0 || pid === process.pid || !isPidAlive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000
      });
      return r.status === 0 && String(r.stdout || '').toLowerCase().includes('node.exe');
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000
    });
    if (r.status !== 0) return false;
    const cmd = String(r.stdout || '').toLowerCase();
    return cmd.includes('agy-statusline') || cmd.includes('daemon');
  } catch {
    return false;
  }
}

export function stopExistingDaemon(): boolean {
  const pidPath = daemonPidFilePath();
  const parsed = parseDaemonPidFile(pidPath);
  if (!parsed.pid || !isDaemonProcessConfirmed(parsed.pid)) {
    try {
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    fs.writeFileSync(pidPath, `${parsed.pid}\nSTOP\n`, 'utf8');
  } catch {
    // ignore
  }
  try {
    process.kill(parsed.pid, 'SIGTERM');
  } catch {
    // ignore
  }
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(parsed.pid)) break;
    sleepSync(60);
  }
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
  return true;
}

export function resolveChannelEndpoints(
  channelMode: string = 'auto',
  homedir: string = os.homedir()
): ChannelEndpoint[] {
  const channels: Array<'stable' | 'insiders'> =
    channelMode === 'stable'
      ? ['stable']
      : channelMode === 'insiders'
        ? ['insiders']
        : ['stable', 'insiders'];

  return channels.map((singleChannel) => {
    const isInsiders = singleChannel === 'insiders';
    const appDirName = isInsiders ? 'Antigravity - Insiders' : 'Antigravity';
    const geminiSubDir = isInsiders ? '.gemini/antigravity-insiders' : '.gemini/antigravity';
    let portFile: string;
    if (process.platform === 'darwin') {
      portFile = path.join(homedir, 'Library', 'Application Support', appDirName, 'DevToolsActivePort');
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
      portFile = path.join(appData, appDirName, 'DevToolsActivePort');
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
      portFile = path.join(xdg, appDirName, 'DevToolsActivePort');
    }

    const dotDir = path.join(homedir, isInsiders ? '.antigravity-insiders' : '.antigravity');
    const argvPath = path.join(dotDir, 'argv.json');
    let fallbackPort = isInsiders ? 9223 : 9222;
    try {
      if (fs.existsSync(argvPath)) {
        const stripped = stripBom(fs.readFileSync(argvPath, 'utf8')).replace(
          /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,
          ''
        );
        const m = stripped.match(/"remote-debugging-port"\s*:\s*(\d+)/);
        if (m && parseInt(m[1], 10) > 0) fallbackPort = parseInt(m[1], 10);
      }
    } catch {
      // ignore
    }

    return {
      channel: singleChannel,
      portFile,
      geminiSubDir,
      explicitConvDir: false,
      fallbackPort,
      channelInstalled:
        fs.existsSync(portFile) || fs.existsSync(path.dirname(portFile)) || fs.existsSync(dotDir),
      conversationsDir: path.join(homedir, geminiSubDir, 'conversations')
    } as ChannelEndpoint & { fallbackPort: number; channelInstalled: boolean };
  });
}

type FullChannelEndpoint = ChannelEndpoint & { fallbackPort: number; channelInstalled: boolean };

interface TargetInfo {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  parentId?: string | null;
  webSocketDebuggerUrl?: string;
}

function readPortInfo(portFile: string | undefined): { port: number; browserWsPath: string } {
  try {
    if (!portFile || !fs.existsSync(portFile)) return { port: 0, browserWsPath: '' };
    const lines = fs
      .readFileSync(portFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const port = parseInt(lines[0] || '0', 10);
    const wsPath = lines[1] && lines[1].startsWith('/') ? lines[1] : '';
    return Number.isFinite(port) && port > 0 ? { port, browserWsPath: wsPath } : { port: 0, browserWsPath: '' };
  } catch {
    return { port: 0, browserWsPath: '' };
  }
}

function isExternalBrowserProduct(browser: unknown, userAgent: unknown): boolean {
  const b = String(browser || '').trim();
  const ua = String(userAgent || '').trim();
  if (/electron|antigravity/i.test(b) || /electron\/|antigravity\//i.test(ua)) return false;
  return /^(?:Headless)?Chrome\/|^Edg\/|^Brave\//i.test(b);
}

function fetchBrowserVersionInfo(port: number): Promise<{ wsUrl: string; externalBrowser: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: { wsUrl: string; externalBrowser: boolean }) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 450 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done({ wsUrl: '', externalBrowser: false });
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const rawWs = typeof parsed.webSocketDebuggerUrl === 'string' ? parsed.webSocketDebuggerUrl.trim() : '';
          const wsUrl = rawWs.startsWith('ws://') || rawWs.startsWith('wss://') ? rawWs : '';
          done({
            wsUrl,
            externalBrowser: isExternalBrowserProduct(parsed.Browser, parsed['User-Agent'])
          });
        } catch {
          done({ wsUrl: '', externalBrowser: false });
        }
      });
      res.on('error', () => done({ wsUrl: '', externalBrowser: false }));
    });
    req.on('error', () => done({ wsUrl: '', externalBrowser: false }));
    req.on('timeout', () => {
      req.destroy();
      done({ wsUrl: '', externalBrowser: false });
    });
  });
}

export function fetchTargetsResult(port: number): Promise<{ reachable: boolean; targets: TargetInfo[] }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: { reachable: boolean; targets: TargetInfo[] }) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 450 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done({ reachable: false, targets: [] });
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          done(Array.isArray(parsed) ? { reachable: true, targets: parsed as TargetInfo[] } : { reachable: false, targets: [] });
        } catch {
          done({ reachable: false, targets: [] });
        }
      });
      res.on('error', () => done({ reachable: false, targets: [] }));
    });
    req.on('error', () => done({ reachable: false, targets: [] }));
    req.on('timeout', () => {
      req.destroy();
      done({ reachable: false, targets: [] });
    });
  });
}

function isAllowedOrigin(urlStr: string): boolean {
  if (!urlStr) return false;
  return ALLOWED_ORIGINS.some((prefix) => urlStr.startsWith(prefix));
}

function getTargetOriginKey(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin && u.origin !== 'null' ? u.origin : u.protocol || String(urlStr || '').slice(0, 64);
  } catch {
    return String(urlStr || '').slice(0, 64);
  }
}

export async function runDaemon(opts: {
  once?: boolean;
  channel?: string;
  cliEntryPath?: string;
  homedir?: string;
} = {}): Promise<number> {
  const RUN_ONCE = Boolean(opts.once);
  const homedir = opts.homedir ?? os.homedir();
  const cliEntryPath = opts.cliEntryPath ?? '';
  const noProxy = ensureLoopbackNoProxy(process.env.NO_PROXY || process.env.no_proxy || '');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  const pidPath = daemonPidFilePath();
  const myStartMs = Math.round(Date.now() - process.uptime() * 1000);

  if (!RUN_ONCE) {
    const existing = parseDaemonPidFile(pidPath);
    if (existing.pid && existing.pid !== process.pid && isDaemonProcessConfirmed(existing.pid)) {
      stopExistingDaemon();
    }
    try {
      fs.writeFileSync(pidPath, `${process.pid}\n${myStartMs}\n`, 'utf8');
    } catch {
      // ignore
    }
  }

  let daemonExiting = false;
  const shutdown = () => {
    if (daemonExiting) return;
    daemonExiting = true;
    closeAllBrowserWatchers();
    for (const [, entry] of attachedTargets.entries()) {
      try {
        entry.ws.close();
      } catch {
        // ignore
      }
    }
    attachedTargets.clear();
    if (!RUN_ONCE) {
      try {
        const cur = parseDaemonPidFile(pidPath);
        if (cur.pid === process.pid) fs.unlinkSync(pidPath);
      } catch {
        // ignore
      }
    }
  };

  if (!RUN_ONCE) {
    process.on('SIGINT', () => {
      shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      shutdown();
      process.exit(0);
    });
  }

  interface AttachedEntry {
    ws: WebSocket;
    endpoint: FullChannelEndpoint;
    attachedAt: number;
    hostConfirmed: boolean;
    updateNewDocScript: (force?: boolean) => Promise<void>;
    inject: () => Promise<boolean>;
    checkAndInject: () => Promise<void>;
    syncPanels: (force?: boolean, skipDomEval?: boolean) => Promise<void>;
    fetchHostQuota: () => Promise<Record<string, QuotaBucket> | null>;
    updateTargetUrl: (url: string, title?: string) => void;
  }

  const attachedTargets = new Map<string, AttachedEntry>();
  const attachingTargetIds = new Set<string>();
  const destroyedWhileAttaching = new Set<string>();
  const skippedNonHostTargets = new Map<
    string,
    { origin: string; skippedAt: number; attempts: number; titleHadAg: boolean }
  >();
  const browserWatchers = new Map<
    string,
    { ws: WebSocket; wsUrl: string; port: number; channel: string; endpoint: FullChannelEndpoint; closing: boolean }
  >();
  const browserWatcherBackoffUntil = new Map<string, number>();
  const fallbackBackoffUntil = new Map<number, number>();
  const ignoredUnflaggedHostPids = new Set<number>();
  const exemptedHostPidByChannel = new Map<string, number>();
  let isCdpRelaunching = false;

  const maybeAutoRelaunchColdStart = (endpoints: FullChannelEndpoint[]): boolean => {
    if (!effectiveEnabled || !currentConfig.app.cdpAutoRelaunch || RUN_ONCE || isCdpRelaunching) {
      return false;
    }

    const installedEps = endpoints.filter((ep) => ep.channelInstalled);
    if (
      installedEps.length > 0 &&
      installedEps.every((ep) => {
        if (readPortInfo(ep.portFile).port > 0) return true;
        const exemptedPid = exemptedHostPidByChannel.get(ep.channel);
        return Boolean(exemptedPid && isPidAlive(exemptedPid));
      })
    ) {
      return false;
    }

    const { runningProcesses } = readHostVersionAndProcesses(currentConfig.channel, homedir);
    for (const proc of runningProcesses) {
      if (proc.hasCdpFlag || ignoredUnflaggedHostPids.has(proc.pid)) continue;
      const ep = endpoints.find((e) => e.channel === proc.channel);
      if (ep && readPortInfo(ep.portFile).port > 0) continue;

      const maxAge = proc.hasUpdatedFlag ? 25 : 12;
      if (proc.elapsedSec > maxAge) {
        ignoredUnflaggedHostPids.add(proc.pid);
        exemptedHostPidByChannel.set(proc.channel, proc.pid);
        logDaemon(
          `Skipped cold-start relay for Antigravity (${proc.channel}, PID ${proc.pid}, uptime ${proc.elapsedSec}s > ${maxAge}s)`
        );
        continue;
      }

      if (findRecentActiveWal(homedir, proc.channel, [proc.pid], 8).length > 0) {
        ignoredUnflaggedHostPids.add(proc.pid);
        exemptedHostPidByChannel.set(proc.channel, proc.pid);
        logDaemon(
          `Skipped cold-start relay for Antigravity (${proc.channel}, PID ${proc.pid}): active WAL detected`
        );
        continue;
      }

      const guard = readRelaunchGuard();
      if (guard.handledPids.includes(proc.pid) || Date.now() - guard.lastRelaunchAtMs < 45000) {
        ignoredUnflaggedHostPids.add(proc.pid);
        exemptedHostPidByChannel.set(proc.channel, proc.pid);
        continue;
      }

      isCdpRelaunching = true;
      try {
        ignoredUnflaggedHostPids.add(proc.pid);
        writeRelaunchGuard({
          lastChannel: proc.channel,
          reason: 'cold-start-relay',
          newPids: [proc.pid]
        });

        if (process.platform === 'win32') {
          const psStop = `$gp = Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; if ($gp) { [void]$gp.CloseMainWindow(); if (-not $gp.WaitForExit(1800)) { Stop-Process -Id ${proc.pid} -Force -ErrorAction SilentlyContinue } }`;
          spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psStop], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 4500
          });
        } else {
          try {
            process.kill(proc.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          for (let i = 0; i < 40 && isPidAlive(proc.pid); i++) sleepSync(80);
          if (isPidAlive(proc.pid)) {
            try {
              process.kill(proc.pid, 'SIGKILL');
            } catch {
              // ignore
            }
            for (let i = 0; i < 15 && isPidAlive(proc.pid); i++) sleepSync(60);
          }
        }
        sleepSync(180);

        if (process.platform === 'darwin' && proc.appPath) {
          spawnSync('/usr/bin/open', ['-a', proc.appPath, '--args', '--remote-debugging-port=0'], {
            stdio: 'ignore',
            timeout: 5000
          });
        } else if (proc.exePath) {
          const child = spawn(proc.exePath, ['--remote-debugging-port=0'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          });
          child.unref();
        }

        logDaemon(
          `Cold-start auto-relaunched Antigravity (${proc.channel}, old PID ${proc.pid}, age ${proc.elapsedSec}s) with --remote-debugging-port=0`
        );
        return true;
      } catch (err) {
        logDaemon(`Cold-start relay failed for PID ${proc.pid}: ${(err as Error)?.message || String(err)}`);
      } finally {
        isCdpRelaunching = false;
      }
    }
    return false;
  };

  let currentConfig: UserConfig = loadUserConfig(homedir).config;
  let effectiveEnabled = true;
  let currentBundleVersion = '';
  let currentInjectScript = '';
  let activeCache: QuotaCacheData | null = null;
  let quotaCacheSig = '';
  let lastHostActivityAtMs = Date.now();

  const rebuildPayloadIfNeeded = (): boolean => {
    const loaded = loadUserConfig(homedir);
    currentConfig = loaded.config;
    if (opts.channel && (opts.channel === 'stable' || opts.channel === 'insiders' || opts.channel === 'auto')) {
      currentConfig = { ...currentConfig, channel: opts.channel };
    }
    const hostPluginOn = readHostPluginEnabled(homedir);
    effectiveEnabled = currentConfig.enabled && currentConfig.app.enabled && hostPluginOn;

    const hash = crypto
      .createHash('sha256')
      .update(APP_VERSION)
      .update(String(effectiveEnabled))
      .update(__AG_BROWSER_RUNTIME_CODE__)
      .digest('hex')
      .slice(0, 8);
    const nextVersion = `${APP_VERSION}-${effectiveEnabled ? 'on' : 'off'}-${hash}`;
    if (nextVersion === currentBundleVersion && currentInjectScript) {
      return false;
    }
    currentBundleVersion = nextVersion;
    const bootPayload = {
      version: nextVersion,
      enabled: effectiveEnabled
    };
    currentInjectScript = `window.__AG_STATUSLINE_BOOT__=${JSON.stringify(bootPayload)};\n${__AG_BROWSER_RUNTIME_CODE__}`;
    return true;
  };

  let hostRpcQuotaInFlight = false;
  let lastHostRpcAttemptMs = 0;

  const refreshSharedQuotaCache = async (): Promise<void> => {
    const candidates = resolveSeedQuotaCachePaths(homedir);
    const primary = resolveQuotaCachePath(homedir);
    const computeDiskSig = () =>
      candidates
        .map((p) => {
          try {
            const st = fs.statSync(p, { throwIfNoEntry: false });
            return st ? `${p}:${st.mtimeMs}:${st.size}` : `${p}:0`;
          } catch {
            return `${p}:0`;
          }
        })
        .join('|');

    const sig = computeDiskSig();
    if (sig !== quotaCacheSig) {
      quotaCacheSig = sig;
      activeCache = loadQuotaCache(candidates).cache;
    }

    if (!RUN_ONCE && effectiveEnabled) {
      let confirmedEntry: AttachedEntry | null = null;
      for (const entry of attachedTargets.values()) {
        if (entry.hostConfirmed) {
          confirmedEntry = entry;
          break;
        }
      }
      if (!confirmedEntry && activeCache !== null) {
        return;
      }
      const now = new Date();
      const isRecentlyActive = Boolean(confirmedEntry) && now.getTime() - lastHostActivityAtMs < 3 * 60 * 1000;
      if (!isUsageRefreshDue(primary, activeCache, isRecentlyActive, now)) {
        return;
      }

      if (confirmedEntry && !hostRpcQuotaInFlight && now.getTime() - lastHostRpcAttemptMs >= 30_000) {
        hostRpcQuotaInFlight = true;
        lastHostRpcAttemptMs = now.getTime();
        try {
          const rpcQuota = await confirmedEntry.fetchHostQuota();
          if (rpcQuota && Object.keys(rpcQuota).length > 0) {
            const writeRes = persistMergedQuotaIfChanged(primary, rpcQuota, {
              source: 'app-rpc',
              now,
              forceWrite: true
            });
            recordUsageOutcome(primary, true, '', now);
            if (writeRes.cache) {
              activeCache = writeRes.cache;
              quotaCacheSig = computeDiskSig();
            }
            return;
          }
        } finally {
          hostRpcQuotaInFlight = false;
        }
      }

      if (cliEntryPath) {
        spawnDetachedQuotaRefresh(cliEntryPath, primary, isRecentlyActive, activeCache, now, homedir);
      }
    }
  };

  function closeAllBrowserWatchers(): void {
    for (const [, entry] of browserWatchers.entries()) {
      entry.closing = true;
      try {
        entry.ws.close();
      } catch {
        // ignore
      }
    }
    browserWatchers.clear();
    browserWatcherBackoffUntil.clear();
  }

  function isSkippedNonHost(t: TargetInfo, nowMs = Date.now()): boolean {
    const id = String(t.id || t.targetId || '').trim();
    if (!id) return false;
    const skipped = skippedNonHostTargets.get(id);
    if (!skipped || skipped.origin !== getTargetOriginKey(t.url || '')) return false;
    const ageMs = nowMs - skipped.skippedAt;
    const titleHasAg = String(t.title || '').includes('Antigravity');
    if (titleHasAg && !skipped.titleHadAg && skipped.attempts < 6 && ageMs >= 150) return false;
    if (titleHasAg && skipped.attempts < 6 && ageMs >= 3000) return false;
    if (skipped.attempts < 3 && ageMs >= 8000) return false;
    return true;
  }

  function isCandidateTarget(t: TargetInfo, nowMs = Date.now()): boolean {
    const id = String(t.id || t.targetId || '').trim();
    if (!id) return false;
    if (t.type !== 'page') return false;
    const url = String(t.url || '');
    if (url.startsWith('devtools://')) return false;
    if (!isAllowedOrigin(url)) return false;
    if (String(t.title || '').includes('Launchpad')) return false;
    if (isSkippedNonHost(t, nowMs)) return false;
    return true;
  }

  async function ensureBrowserWatcher(
    endpoint: FullChannelEndpoint,
    port: number,
    browserWsPath: string,
    isFallbackPort: boolean
  ): Promise<void> {
    if (RUN_ONCE || daemonExiting || !effectiveEnabled || !port) return;
    const watcherKey = `${endpoint.channel}:${port}`;

    for (const [key, entry] of Array.from(browserWatchers.entries())) {
      if (entry.channel === endpoint.channel && entry.port !== port) {
        entry.closing = true;
        browserWatchers.delete(key);
        browserWatcherBackoffUntil.delete(key);
        try {
          entry.ws.close();
        } catch {
          // ignore
        }
      }
    }

    const desiredWsUrl = browserWsPath ? `ws://127.0.0.1:${port}${browserWsPath}` : '';
    const existing = browserWatchers.get(watcherKey);
    if (existing) {
      const alive = existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN;
      if (alive && (!desiredWsUrl || existing.wsUrl === desiredWsUrl)) {
        existing.endpoint = endpoint;
        return;
      }
      existing.closing = true;
      browserWatchers.delete(watcherKey);
      try {
        existing.ws.close();
      } catch {
        // ignore
      }
    }

    if (Date.now() < (browserWatcherBackoffUntil.get(watcherKey) || 0)) return;
    const info = desiredWsUrl
      ? { wsUrl: desiredWsUrl, externalBrowser: false }
      : await fetchBrowserVersionInfo(port);
    if (!info.wsUrl || (isFallbackPort && info.externalBrowser) || daemonExiting) return;

    try {
      const ws = new WebSocket(info.wsUrl);
      const entry = { ws, wsUrl: info.wsUrl, port, channel: endpoint.channel, endpoint, closing: false };
      browserWatchers.set(watcherKey, entry);

      let msgId = 1;
      ws.addEventListener('open', () => {
        if (entry.closing || daemonExiting) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        browserWatcherBackoffUntil.delete(watcherKey);
        try {
          ws.send(JSON.stringify({ id: msgId++, method: 'Target.setDiscoverTargets', params: { discover: true } }));
        } catch {
          // ignore
        }
      });

      ws.addEventListener('message', (event) => {
        if (entry.closing || daemonExiting) return;
        try {
          const msg = JSON.parse(String(event.data)) as {
            method?: string;
            params?: { targetInfo?: TargetInfo; targetId?: string };
          };
          if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
            const infoObj = msg.params?.targetInfo;
            const tid = String(infoObj?.targetId || infoObj?.id || '').trim();
            if (!tid) return;
            const existingAttached = attachedTargets.get(tid);
            if (existingAttached) {
              existingAttached.updateTargetUrl(String(infoObj?.url || ''), String(infoObj?.title || ''));
              return;
            }
            if (attachingTargetIds.has(tid) || !infoObj || !isCandidateTarget(infoObj)) return;
            void attachTarget(
              {
                ...infoObj,
                id: tid,
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tid}`
              },
              entry.endpoint
            );
          } else if (msg.method === 'Target.targetDestroyed') {
            const tid = String(msg.params?.targetId || '').trim();
            if (!tid) return;
            if (attachingTargetIds.has(tid)) destroyedWhileAttaching.add(tid);
            const attached = attachedTargets.get(tid);
            if (attached) {
              attachedTargets.delete(tid);
              try {
                attached.ws.close();
              } catch {
                // ignore
              }
            }
            skippedNonHostTargets.delete(tid);
          }
        } catch {
          // ignore
        }
      });

      const onDrop = () => {
        if (browserWatchers.get(watcherKey) === entry) browserWatchers.delete(watcherKey);
        if (!entry.closing && !daemonExiting) {
          browserWatcherBackoffUntil.set(watcherKey, Date.now() + 5000);
        }
      };
      ws.addEventListener('close', onDrop);
      ws.addEventListener('error', onDrop);
    } catch {
      browserWatcherBackoffUntil.set(watcherKey, Date.now() + 5000);
    }
  }

  function parsePanelsPayload(raw: string): WatchedPanel[] {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out: WatchedPanel[] = [];
      for (const item of arr.slice(0, 16)) {
        if (!item || typeof item !== 'object') continue;
        const paneKey = String((item as Record<string, unknown>).paneKey || '').trim();
        const rawCid = String((item as Record<string, unknown>).cascadeId || '').trim().toLowerCase();
        const cascadeId = UUID_RE.test(rawCid) ? rawCid : '';
        const modelLabel = String((item as Record<string, unknown>).modelLabel || 'Gemini').trim() || 'Gemini';
        if (paneKey) out.push({ paneKey, cascadeId, modelLabel });
      }
      return out;
    } catch {
      return [];
    }
  }

  function attachTarget(target: TargetInfo, endpoint: FullChannelEndpoint): Promise<boolean> {
    const targetId = String(target.id || '').trim();
    const wsUrl = target.webSocketDebuggerUrl;
    if (!targetId || !wsUrl) return Promise.resolve(false);
    if (attachedTargets.has(targetId) || attachingTargetIds.has(targetId)) {
      return Promise.resolve(false);
    }
    attachingTargetIds.add(targetId);
    destroyedWhileAttaching.delete(targetId);

    return new Promise((resolveAttach) => {
      let ws: WebSocket;
      let settled = false;
      const finishAttach = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(attachTimeout);
        attachingTargetIds.delete(targetId);
        if (destroyedWhileAttaching.delete(targetId)) {
          if (attachedTargets.get(targetId)?.ws === ws) attachedTargets.delete(targetId);
          skippedNonHostTargets.delete(targetId);
          try {
            ws?.close();
          } catch {
            // ignore
          }
          resolveAttach(false);
          return;
        }
        resolveAttach(ok);
      };
      const attachTimeout = setTimeout(() => finishAttach(false), 2500);

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        clearTimeout(attachTimeout);
        finishAttach(false);
        return;
      }

      let msgId = 1;
      const pendingCallbacks = new Map<number, (msg: unknown) => void>();
      let evalScriptId: string | null = null;
      let lastNewDocSig = '';
      let watchedPanels: WatchedPanel[] = [];
      let hasExplicitSubscription = false;
      const lastRenderedByPane = new Map<string, string>();
      const lastSessionKeyByPane = new Map<string, string>();
      const lastMetricsSigByPane = new Map<string, string>();

      let currentTargetUrl = String(target.url || '');
      let currentTargetTitle = String(target.title || '');
      let hostConfirmed = false;
      let nonHostSettled = false;
      let pendingProbe = false;
      let probingPending = false;
      let pendingRecheckQueued = false;
      let pendingRetryCount = 0;
      let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let navDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      let runtimeEnabled = false;
      let pageEnabled = false;
      let bindingsAdded = false;
      let initialAttachDone = false;

      const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> =>
        new Promise((resolve) => {
          if (ws.readyState !== WebSocket.OPEN) {
            resolve(null);
            return;
          }
          const id = msgId++;
          const timer = setTimeout(() => {
            pendingCallbacks.delete(id);
            resolve(null);
          }, 2500);
          pendingCallbacks.set(id, (msg) => {
            clearTimeout(timer);
            resolve((msg as Record<string, unknown>) || null);
          });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch {
            clearTimeout(timer);
            pendingCallbacks.delete(id);
            resolve(null);
          }
        });

      const updateNewDocScript = async (force = false) => {
        const nextSig = `${effectiveEnabled}|${currentBundleVersion}`;
        if (!force && evalScriptId && nextSig === lastNewDocSig) return;
        if (evalScriptId) {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: evalScriptId });
          evalScriptId = null;
        }
        if (effectiveEnabled) {
          const addRes = await send('Page.addScriptToEvaluateOnNewDocument', { source: currentInjectScript });
          const ident = (addRes?.result as { identifier?: string } | undefined)?.identifier;
          if (ident) {
            evalScriptId = ident;
            lastNewDocSig = nextSig;
          }
        } else {
          lastNewDocSig = nextSig;
        }
      };

      const inject = async (): Promise<boolean> => {
        hasExplicitSubscription = false;
        const res = await send('Runtime.evaluate', {
          expression: currentInjectScript,
          returnByValue: false
        });
        if (ws.readyState !== WebSocket.OPEN || destroyedWhileAttaching.has(targetId)) return false;
        const rObj = res?.result as { exceptionDetails?: unknown } | undefined;
        if (res?.error || rObj?.exceptionDetails) {
          logDaemon(`Injection failed on ${targetId}`);
          return false;
        }
        return true;
      };

      const fetchHostQuota = async (): Promise<Record<string, QuotaBucket> | null> => {
        if (!hostConfirmed || nonHostSettled || ws.readyState !== WebSocket.OPEN) return null;
        const evalRes = await send('Runtime.evaluate', {
          expression: HOST_QUOTA_RPC_EXPRESSION,
          awaitPromise: true,
          returnByValue: true
        });
        const val = (evalRes?.result as {
          result?: {
            value?: {
              ok?: boolean;
              buckets?: Array<{ id?: unknown; remainingFraction?: unknown; resetTime?: unknown }>;
            };
          };
        } | undefined)?.result?.value;
        if (!val?.ok || !Array.isArray(val.buckets)) return null;
        const quota: Record<string, QuotaBucket> = {};
        for (const b of val.buckets) {
          const id = typeof b?.id === 'string' ? b.id.trim() : '';
          const frac = typeof b?.remainingFraction === 'number' ? b.remainingFraction : NaN;
          const rt = typeof b?.resetTime === 'string' ? b.resetTime : '';
          if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) continue;
          if (!Number.isFinite(frac) || frac < 0 || frac > 1) continue;
          if (!rt || !Number.isFinite(Date.parse(rt))) continue;
          quota[id] = { remaining_fraction: frac, reset_time: rt };
        }
        return Object.keys(quota).length > 0 ? quota : null;
      };

      const syncPanels = async (force = false, skipDomEval = false): Promise<void> => {
        if (!effectiveEnabled || !isSqliteAvailable()) return;

        if (!skipDomEval && (!hasExplicitSubscription || force)) {
          const evalRes = await send('Runtime.evaluate', {
            expression: `(function(){
              if (Array.isArray(window.__ag_statusline_panels)) return window.__ag_statusline_panels;
              return [];
            })()`,
            returnByValue: true
          });
          const val = (evalRes?.result as { result?: { value?: unknown } } | undefined)?.result?.value;
          if (Array.isArray(val)) {
            watchedPanels = parsePanelsPayload(JSON.stringify(val));
          }
        }

        if (watchedPanels.length === 0) return;

        const now = new Date();
        const updatesToPush: AppRenderItem[] = [];
        const commitMeta: Array<{ paneKey: string; renderedSig: string; sessionKey: string }> = [];

        for (const panel of watchedPanels) {
          const { paneKey, cascadeId, modelLabel } = panel;
          const quotaView = buildModelQuotaView(activeCache, modelLabel, undefined, now);
          const quotaPools = buildAllQuotaPools(activeCache, modelLabel, undefined, now);

          let metrics = null;
          let metricsSig = 'none';
          let transientError = false;
          let partialOrDraining = false;

          if (cascadeId && UUID_RE.test(cascadeId)) {
            const dbState = getDbState(cascadeId, endpoint);
            const convDir = dbState?.dbPath ? path.dirname(dbState.dbPath) : '';
            const childSnap = convDir ? getCompositeChildSnapshot(cascadeId, convDir, dbState?.rawSig || dbState?.sig || '') : null;
            metricsSig = childSnap?.sig || dbState?.sig || 'empty';
            const parsed = parseConversationMetrics(
              cascadeId,
              endpoint,
              {
                contextLimit: currentConfig.contextLimit,
                contextLimitOverride: currentConfig.contextLimitOverride,
                homedir
              },
              dbState,
              childSnap
            );
            if (parsed?.transientError) {
              transientError = true;
              metrics = parsed.cachedMetrics ?? null;
            } else {
              metrics = parsed;
              partialOrDraining = Boolean(parsed?.isDraining || parsed?.partialStale);
            }
          }

          if (metricsSig !== 'none' && metricsSig !== 'empty' && metricsSig !== lastMetricsSigByPane.get(paneKey)) {
            lastMetricsSigByPane.set(paneKey, metricsSig);
            lastHostActivityAtMs = Date.now();
          }

          if (transientError && !metrics && !quotaView.hasQuota) continue;

          const item = buildAppPayload(paneKey, cascadeId, metrics, quotaView, currentConfig, modelLabel, quotaPools);
          const renderedSig = `${item.hasContent ? '1' : '0'}|${item.inlineHtml}|${item.tooltipHtml}`;
          const sessionKey = `${cascadeId}|${modelLabel}|${metricsSig}|${quotaCacheSig}|${currentConfig.cacheRateMode}|${currentConfig.contextLimit}:${currentConfig.contextLimitOverride}`;

          if (force || renderedSig !== lastRenderedByPane.get(paneKey)) {
            updatesToPush.push(item);
            commitMeta.push({
              paneKey,
              renderedSig,
              sessionKey: partialOrDraining || transientError ? '' : sessionKey
            });
          } else if (!partialOrDraining && !transientError) {
            lastSessionKeyByPane.set(paneKey, sessionKey);
          }
        }

        if (updatesToPush.length > 0) {
          const pushRes = await send('Runtime.evaluate', {
            expression: `if (typeof window.__ag_statusline_render === 'function') { window.__ag_statusline_render(${JSON.stringify(updatesToPush)}); }`,
            returnByValue: false
          });
          const rObj = pushRes?.result as { exceptionDetails?: unknown } | undefined;
          if (pushRes && !pushRes.error && !rObj?.exceptionDetails) {
            for (const c of commitMeta) {
              lastRenderedByPane.set(c.paneKey, c.renderedSig);
              if (c.sessionKey) lastSessionKeyByPane.set(c.paneKey, c.sessionKey);
            }
          }
        }
      };

      const checkAndInject = async (): Promise<void> => {
        if (!hostConfirmed || nonHostSettled || ws.readyState !== WebSocket.OPEN) return;
        if (!isAllowedOrigin(currentTargetUrl)) {
          if (attachedTargets.get(targetId)?.ws === ws) attachedTargets.delete(targetId);
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        const checkRes = await send('Runtime.evaluate', {
          expression: `({
            injected: window.__ag_statusline_version === ${JSON.stringify(currentBundleVersion)} && window.__ag_statusline_ready === true,
            skipNonHost: window.__ag_statusline_skip_non_host === true,
            kind: ${HOST_PROBE_EXPRESSION}
          })`,
          returnByValue: true
        });
        const state = (checkRes?.result as { result?: { value?: Record<string, unknown> } } | undefined)?.result?.value;
        if (!state || typeof state !== 'object') return;
        if (state.skipNonHost || state.kind === 'non_host') {
          await markNonHostAndDetach(currentTargetUrl);
          return;
        }
        if (state.kind === 'pending') return;
        if (state.injected !== true) {
          await inject();
          await syncPanels(true);
        } else if (effectiveEnabled && !evalScriptId) {
          await updateNewDocScript();
        }
      };

      const clearPendingTimer = () => {
        if (pendingRetryTimer) {
          clearTimeout(pendingRetryTimer);
          pendingRetryTimer = null;
        }
      };

      const probeHostKind = async (): Promise<'host' | 'non_host' | 'pending'> => {
        const res = await send('Runtime.evaluate', {
          expression: HOST_PROBE_EXPRESSION,
          returnByValue: true
        });
        const val = (res?.result as { result?: { value?: unknown } } | undefined)?.result?.value;
        return val === 'host' || val === 'non_host' || val === 'pending' ? val : 'pending';
      };

      const markNonHostAndDetach = async (reasonUrl: string) => {
        if (nonHostSettled) return;
        nonHostSettled = true;
        pendingProbe = false;
        hostConfirmed = false;
        clearPendingTimer();
        if (navDebounceTimer) {
          clearTimeout(navDebounceTimer);
          navDebounceTimer = null;
        }
        const originKey = getTargetOriginKey(reasonUrl || target.url || '');
        if (originKey) {
          const prev = skippedNonHostTargets.get(targetId);
          const sameOrigin = prev && prev.origin === originKey;
          const titleHasAg = String(currentTargetTitle || target.title || '').includes('Antigravity');
          skippedNonHostTargets.set(targetId, {
            origin: originKey,
            skippedAt: Date.now(),
            attempts: sameOrigin ? prev.attempts + 1 : 1,
            titleHadAg: Boolean((sameOrigin && prev.titleHadAg) || titleHasAg)
          });
        }
        if (evalScriptId && ws.readyState === WebSocket.OPEN) {
          const idToRemove = evalScriptId;
          evalScriptId = null;
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: idToRemove });
        }
        if (attachedTargets.get(targetId)?.ws === ws) attachedTargets.delete(targetId);
        clearTimeout(attachTimeout);
        try {
          ws.close();
        } catch {
          // ignore
        }
        finishAttach(false);
      };

      const promoteToHost = async (): Promise<boolean> => {
        if (hostConfirmed || nonHostSettled || ws.readyState !== WebSocket.OPEN) return false;
        hostConfirmed = true;
        lastHostActivityAtMs = Date.now();
        pendingProbe = false;
        clearPendingTimer();
        skippedNonHostTargets.delete(targetId);
        const entry = attachedTargets.get(targetId);
        if (entry && entry.ws === ws) entry.hostConfirmed = true;

        if (!pageEnabled) {
          pageEnabled = true;
          await send('Page.enable');
        }
        if (!runtimeEnabled) {
          runtimeEnabled = true;
          await send('Runtime.enable');
        }
        if (ws.readyState !== WebSocket.OPEN || nonHostSettled) {
          finishAttach(false);
          return false;
        }
        if (!bindingsAdded) {
          bindingsAdded = true;
          await send('Runtime.addBinding', { name: '__agStatuslineSubscribe' });
        }
        await updateNewDocScript(true);
        const ok = await inject();
        await syncPanels(true);
        initialAttachDone = true;
        clearTimeout(attachTimeout);
        finishAttach(ok);
        return ok;
      };

      const PENDING_DELAYS = [30, 50, 100, 200];
      const schedulePendingRetry = () => {
        clearPendingTimer();
        if (!pendingProbe || hostConfirmed || nonHostSettled || ws.readyState !== WebSocket.OPEN) return;
        if (pendingRetryCount >= 40) {
          pendingProbe = false;
          if (attachedTargets.get(targetId)?.ws === ws) attachedTargets.delete(targetId);
          clearTimeout(attachTimeout);
          try {
            ws.close();
          } catch {
            // ignore
          }
          finishAttach(false);
          return;
        }
        const delay = PENDING_DELAYS[Math.min(pendingRetryCount, PENDING_DELAYS.length - 1)];
        pendingRetryCount += 1;
        pendingRetryTimer = setTimeout(() => {
          pendingRetryTimer = null;
          void recheckPendingHost();
        }, delay);
      };

      const recheckPendingHost = async () => {
        if (!pendingProbe || hostConfirmed || nonHostSettled || ws.readyState !== WebSocket.OPEN) return;
        if (probingPending) {
          pendingRecheckQueued = true;
          return;
        }
        probingPending = true;
        try {
          if (!isAllowedOrigin(currentTargetUrl)) {
            await markNonHostAndDetach(currentTargetUrl);
            return;
          }
          const kind = await probeHostKind();
          if (ws.readyState !== WebSocket.OPEN || nonHostSettled || hostConfirmed) return;
          if (kind === 'host') {
            await promoteToHost();
          } else if (kind === 'non_host') {
            await markNonHostAndDetach(currentTargetUrl);
          } else if (!pendingRecheckQueued) {
            schedulePendingRetry();
          }
        } finally {
          probingPending = false;
          if (pendingRecheckQueued) {
            pendingRecheckQueued = false;
            if (pendingProbe && !hostConfirmed && !nonHostSettled && ws.readyState === WebSocket.OPEN) {
              void recheckPendingHost();
            }
          }
        }
      };

      ws.addEventListener('open', async () => {
        if (destroyedWhileAttaching.has(targetId) || ws.readyState !== WebSocket.OPEN || nonHostSettled) {
          finishAttach(false);
          return;
        }
        if (!runtimeEnabled) {
          runtimeEnabled = true;
          await send('Runtime.enable');
        }
        const kind = await probeHostKind();
        if (ws.readyState !== WebSocket.OPEN || nonHostSettled || destroyedWhileAttaching.has(targetId)) {
          finishAttach(false);
          return;
        }
        if (kind === 'host') {
          await promoteToHost();
          return;
        }
        if (kind === 'non_host') {
          await markNonHostAndDetach(currentTargetUrl);
          return;
        }
        pendingProbe = true;
        if (!pageEnabled) {
          pageEnabled = true;
          await send('Page.enable');
        }
        await recheckPendingHost();
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            id?: number;
            method?: string;
            params?: { name?: string; payload?: string; frame?: { id?: string; parentId?: string; url?: string } };
          };
          if (msg.id && pendingCallbacks.has(msg.id)) {
            const cb = pendingCallbacks.get(msg.id)!;
            pendingCallbacks.delete(msg.id);
            cb(msg);
            return;
          }
          if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agStatuslineSubscribe') {
            if (!hostConfirmed) return;
            lastHostActivityAtMs = Date.now();
            watchedPanels = parsePanelsPayload(String(msg.params.payload || ''));
            hasExplicitSubscription = true;
            lastRenderedByPane.clear();
            lastSessionKeyByPane.clear();
            if (watchedPanels.length > 0) {
              void syncPanels(true, true);
            }
            return;
          }
          if (
            msg.method === 'Page.frameNavigated' &&
            (!msg.params?.frame?.parentId || msg.params.frame.id === targetId) &&
            msg.params?.frame?.url
          ) {
            currentTargetUrl = String(msg.params.frame.url);
            hasExplicitSubscription = false;
          }
          if (
            msg.method === 'Page.frameNavigated' ||
            msg.method === 'Page.loadEventFired' ||
            msg.method === 'Page.domContentEventFired'
          ) {
            if (!msg.params?.frame || !msg.params.frame.parentId || msg.params.frame.id === targetId) {
              if (pendingProbe && !hostConfirmed && !nonHostSettled) {
                void recheckPendingHost();
                return;
              }
              if (!initialAttachDone) return;
              if (navDebounceTimer) clearTimeout(navDebounceTimer);
              navDebounceTimer = setTimeout(() => {
                navDebounceTimer = null;
                void checkAndInject();
              }, 120);
            }
          }
        } catch {
          // ignore
        }
      });

      const closeHandler = () => {
        clearTimeout(attachTimeout);
        clearPendingTimer();
        pendingProbe = false;
        if (navDebounceTimer) {
          clearTimeout(navDebounceTimer);
          navDebounceTimer = null;
        }
        for (const [, cb] of pendingCallbacks) cb(null);
        pendingCallbacks.clear();
        if (attachedTargets.get(targetId)?.ws === ws) attachedTargets.delete(targetId);
        finishAttach(false);
      };
      ws.addEventListener('close', closeHandler);
      ws.addEventListener('error', closeHandler);

      attachedTargets.set(targetId, {
        ws,
        endpoint,
        attachedAt: Date.now(),
        get hostConfirmed() {
          return hostConfirmed;
        },
        set hostConfirmed(v: boolean) {
          hostConfirmed = Boolean(v);
        },
        updateNewDocScript,
        inject,
        checkAndInject,
        syncPanels,
        fetchHostQuota,
        updateTargetUrl: (u: string, nextTitle = '') => {
          let changed = false;
          if (nextTitle && nextTitle !== currentTargetTitle) {
            currentTargetTitle = nextTitle;
            if (nextTitle.includes('Antigravity')) changed = true;
          }
          if (u && u !== currentTargetUrl) {
            currentTargetUrl = u;
            changed = true;
          }
          if (changed && pendingProbe && !hostConfirmed && !nonHostSettled && ws.readyState === WebSocket.OPEN) {
            void recheckPendingHost();
          }
        }
      });
    });
  }

  let isSyncing = false;
  let syncTick = 0;

  const sync = async (): Promise<void> => {
    if (!RUN_ONCE) {
      const curPid = parseDaemonPidFile(pidPath);
      if (curPid.stopRequested || (curPid.pid && curPid.pid !== process.pid)) {
        shutdown();
        process.exit(0);
      }
    }
    if (isSyncing || daemonExiting) return;
    isSyncing = true;
    const syncStartMs = Date.now();
    syncTick = (syncTick + 1) % 6000;
    try {
      const bundleChanged = rebuildPayloadIfNeeded();
      await refreshSharedQuotaCache();

      if (!effectiveEnabled) {
        closeAllBrowserWatchers();
      }
      const shouldHeartbeat = bundleChanged || syncTick % 6 === 1;
      const endpoints = resolveChannelEndpoints(currentConfig.channel, homedir) as FullChannelEndpoint[];
      if (maybeAutoRelaunchColdStart(endpoints)) return;
      const probedPorts = new Set<number>();
      const activeTargetIds = new Set<string>();
      const pendingPages: Array<{ target: TargetInfo; endpoint: FullChannelEndpoint }> = [];

      for (const ep of endpoints) {
        const portInfo = readPortInfo(ep.portFile);
        let activePort = portInfo.port;
        let activeWsPath = portInfo.browserWsPath;
        let fromPortFile = false;
        let reachable = false;
        let targets: TargetInfo[] = [];

        if (activePort && !probedPorts.has(activePort)) {
          probedPorts.add(activePort);
          const res = await fetchTargetsResult(activePort);
          reachable = res.reachable;
          targets = res.targets;
          if (reachable) fromPortFile = true;
        }
        if (
          !reachable &&
          ep.channelInstalled &&
          ep.fallbackPort &&
          !probedPorts.has(ep.fallbackPort) &&
          (RUN_ONCE || Date.now() >= (fallbackBackoffUntil.get(ep.fallbackPort) || 0))
        ) {
          probedPorts.add(ep.fallbackPort);
          const res = await fetchTargetsResult(ep.fallbackPort);
          if (!res.reachable) {
            fallbackBackoffUntil.set(ep.fallbackPort, Date.now() + 10000);
          } else {
            const ver = await fetchBrowserVersionInfo(ep.fallbackPort);
            if (ver.externalBrowser) {
              fallbackBackoffUntil.set(ep.fallbackPort, Date.now() + 10000);
            } else {
              reachable = true;
              targets = res.targets;
              activePort = ep.fallbackPort;
              activeWsPath = '';
              fallbackBackoffUntil.delete(ep.fallbackPort);
            }
          }
        }
        if (!reachable) continue;

        if (activePort && effectiveEnabled) {
          await ensureBrowserWatcher(ep, activePort, activeWsPath, !fromPortFile);
        }

        for (const t of targets) {
          const tid = String(t.id || '').trim();
          if (!tid) continue;
          const skipped = skippedNonHostTargets.get(tid);
          if (skipped && (!isAllowedOrigin(t.url || '') || getTargetOriginKey(t.url || '') !== skipped.origin)) {
            skippedNonHostTargets.delete(tid);
          }
          if (t.webSocketDebuggerUrl && isCandidateTarget(t)) {
            activeTargetIds.add(tid);
            pendingPages.push({ target: t, endpoint: ep });
          }
        }
      }

      const attachPromises: Array<Promise<boolean>> = [];
      for (const { target, endpoint } of pendingPages) {
        const tid = String(target.id || '');
        const existing = attachedTargets.get(tid);
        if (!existing) {
          if (!attachingTargetIds.has(tid)) attachPromises.push(attachTarget(target, endpoint));
        } else {
          existing.endpoint = endpoint;
          existing.updateTargetUrl(String(target.url || ''), String(target.title || ''));
          if (existing.hostConfirmed) {
            if (bundleChanged) await existing.updateNewDocScript();
            if (shouldHeartbeat) await existing.checkAndInject();
            await existing.syncPanels(bundleChanged);
          }
        }
      }
      if (attachPromises.length > 0) {
        await Promise.allSettled(attachPromises);
      }

      for (const [id, entry] of attachedTargets.entries()) {
        if (!activeTargetIds.has(id)) {
          if (entry.attachedAt >= syncStartMs) continue;
          try {
            entry.ws.close();
          } catch {
            // ignore
          }
          attachedTargets.delete(id);
        }
      }
    } finally {
      isSyncing = false;
    }
  };

  rebuildPayloadIfNeeded();
  logDaemon(`Daemon started (version=${APP_VERSION}, sqlite=${isSqliteAvailable()}, once=${RUN_ONCE})`);
  await sync();

  if (RUN_ONCE) {
    shutdown();
    return 0;
  }

  setInterval(() => {
    void sync();
  }, 2500);

  return new Promise(() => {});
}
