import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface HostProcessInfo {
  pid: number;
  channel: 'stable' | 'insiders';
  appPath: string;
  exePath: string;
  hasCdpFlag: boolean;
  elapsedSec: number;
  hasUpdatedFlag: boolean;
}

export interface RelaunchGuardData {
  lastRelaunchAtMs: number;
  lastChannel: string;
  reason: string;
  handledPids: number[];
}

export function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // ignore
  }
}

export function parsePosixEtimeSeconds(raw: string): number {
  const clean = String(raw || '').trim();
  if (!clean) return 999999;

  let days = 0;
  let timePart = clean;
  const dashIdx = clean.indexOf('-');
  if (dashIdx !== -1) {
    const dayStr = clean.slice(0, dashIdx);
    timePart = clean.slice(dashIdx + 1);
    if (!/^\d+$/.test(dayStr)) return 999999;
    days = parseInt(dayStr, 10);
  }

  const parts = timePart.split(':');
  if (parts.length !== 2 && parts.length !== 3) return 999999;
  for (const seg of parts) {
    if (!/^\d+$/.test(seg)) return 999999;
  }

  let hours = 0;
  let mins = 0;
  let secs = 0;
  if (parts.length === 2) {
    mins = parseInt(parts[0], 10);
    secs = parseInt(parts[1], 10);
  } else {
    hours = parseInt(parts[0], 10);
    mins = parseInt(parts[1], 10);
    secs = parseInt(parts[2], 10);
  }
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

export function readHostVersionAndProcesses(
  channel: string = 'auto',
  homedir: string = os.homedir()
): { appVersion: string | null; runningProcesses: HostProcessInfo[] } {
  const allowStable = channel !== 'insiders';
  const allowInsiders = channel !== 'stable';
  let appVersion: string | null = null;
  const runningProcesses: HostProcessInfo[] = [];

  if (process.platform === 'darwin') {
    const appCandidates =
      channel === 'insiders'
        ? ['/Applications/Antigravity - Insiders.app', path.join(homedir, 'Applications/Antigravity - Insiders.app')]
        : ['/Applications/Antigravity.app', path.join(homedir, 'Applications/Antigravity.app'), '/Applications/Antigravity - Insiders.app'];
    for (const appBundle of appCandidates) {
      const plist = path.join(appBundle, 'Contents', 'Info.plist');
      if (!fs.existsSync(plist)) continue;
      try {
        const xml = fs.readFileSync(plist, 'utf8');
        const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
        if (m && m[1]) {
          appVersion = m[1].trim();
          break;
        }
      } catch {
        // ignore
      }
    }

    const ps = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 2500 });
    if (ps.status === 0 && ps.stdout) {
      for (const line of String(ps.stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const elapsedSec = parsePosixEtimeSeconds(m[2]);
        const cmd = m[3];
        if (
          !pid ||
          /--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk|--ms-enable-electron-run-as-node/i.test(cmd) ||
          /Helper(?:\s|\.|\/)/i.test(cmd)
        ) {
          continue;
        }
        const appMatch = cmd.match(
          /^(\S.*?\/Antigravity(?:\s-\sInsiders)?\.app)\/Contents\/MacOS\/(Antigravity(?:\s-\sInsiders)?)(?:\s|$)/
        );
        if (!appMatch) continue;
        const ch = /Insiders/i.test(appMatch[2]) ? 'insiders' : 'stable';
        if ((ch === 'stable' && !allowStable) || (ch === 'insiders' && !allowInsiders)) continue;
        runningProcesses.push({
          pid,
          channel: ch,
          appPath: appMatch[1],
          exePath: `${appMatch[1]}/Contents/MacOS/${appMatch[2]}`,
          hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/.test(cmd),
          elapsedSec,
          hasUpdatedFlag: /--updated(?:\s|$)/.test(cmd)
        });
      }
    }
  } else if (process.platform === 'win32') {
    const psCmd = [
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$now = Get-Date`,
      `$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe' OR Name = 'Antigravity - Insiders.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk|--ms-enable-electron-run-as-node' } | ForEach-Object { $elapsed = if ($_.CreationDate) { [Math]::Max(0, [int]($now - $_.CreationDate).TotalSeconds) } else { 999999 }; @{ pid = [int]$_.ProcessId; name = [string]$_.Name; exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; elapsed = $elapsed } })`,
      `$procs | ConvertTo-Json -Compress -Depth 3`
    ].join('\n');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout.trim()) as unknown;
        const rawProcs = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of rawProcs) {
          if (!item || typeof item !== 'object') continue;
          const p = item as Record<string, unknown>;
          const ch = /insiders/i.test(String(p.name || p.exe || '')) ? 'insiders' : 'stable';
          if ((ch === 'stable' && !allowStable) || (ch === 'insiders' && !allowInsiders)) continue;
          const cmd = String(p.cmd || '');
          const elapsedRaw = Number(p.elapsed);
          runningProcesses.push({
            pid: Number(p.pid) || 0,
            channel: ch,
            appPath: '',
            exePath: String(p.exe || ''),
            hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/i.test(cmd),
            elapsedSec: Number.isFinite(elapsedRaw) ? elapsedRaw : 999999,
            hasUpdatedFlag: /--updated(?:\s|$)/i.test(cmd)
          });
        }
      } catch {
        // ignore
      }
    }
  } else {
    const ps = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 2500 });
    if (ps.status === 0 && ps.stdout) {
      for (const line of String(ps.stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const elapsedSec = parsePosixEtimeSeconds(m[2]);
        const cmd = m[3];
        if (!pid || /--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk/i.test(cmd)) continue;
        const binMatch = cmd.match(/^(\/\S*\/antigravity(?:-insiders)?)(?:\s|$)/i);
        if (!binMatch) continue;
        const ch = /insiders/i.test(binMatch[1]) ? 'insiders' : 'stable';
        if ((ch === 'stable' && !allowStable) || (ch === 'insiders' && !allowInsiders)) continue;
        runningProcesses.push({
          pid,
          channel: ch,
          appPath: '',
          exePath: binMatch[1],
          hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/.test(cmd),
          elapsedSec,
          hasUpdatedFlag: /--updated(?:\s|$)/.test(cmd)
        });
      }
    }
  }

  return { appVersion, runningProcesses };
}

function collectDescendantPids(rootPids: number[]): Set<number> {
  const visited = new Set<number>();
  if (rootPids.length === 0) return visited;

  const validRoots = rootPids.filter((p) => Number.isFinite(p) && p > 0);
  if (validRoots.length === 0) return visited;

  if (process.platform === 'win32') {
    for (const r of validRoots) visited.add(r);
    return visited;
  }

  const childrenMap = new Map<number, number[]>();
  try {
    const ps = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1500 });
    if (ps.status === 0 && ps.stdout) {
      for (const line of String(ps.stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const ppid = parseInt(m[2], 10);
        if (!pid || ppid < 0) continue;
        const list = childrenMap.get(ppid);
        if (list) list.push(pid);
        else childrenMap.set(ppid, [pid]);
      }
    }
  } catch {
    // ignore ps errors; root PIDs still seeded below
  }

  const queue: number[] = [];
  for (const r of validRoots) {
    if (!visited.has(r)) {
      visited.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const kids = childrenMap.get(cur);
    if (!kids) continue;
    for (const kid of kids) {
      if (!visited.has(kid)) {
        visited.add(kid);
        queue.push(kid);
      }
    }
  }
  return visited;
}

export function findRecentActiveWal(
  homedir: string,
  channel: string,
  appRootPids?: number[],
  windowSec = 8
): string[] {
  if (Array.isArray(appRootPids) && appRootPids.length === 0) {
    return [];
  }

  const dirs: string[] = [];
  if (channel !== 'insiders') dirs.push(path.join(homedir, '.gemini', 'antigravity', 'conversations'));
  if (channel !== 'stable') dirs.push(path.join(homedir, '.gemini', 'antigravity-insiders', 'conversations'));

  const now = Date.now();
  const candidates: Array<{ name: string; fullPath: string }> = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.db-wal')) continue;
        const fullPath = path.join(dir, name);
        const st = fs.statSync(fullPath, { throwIfNoEntry: false });
        if (st && st.size > 4096 && now - st.mtimeMs < windowSec * 1000) {
          candidates.push({ name, fullPath });
        }
      }
    } catch {
      // ignore
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  if (process.platform !== 'win32' && Array.isArray(appRootPids) && appRootPids.length > 0) {
    const appTree = collectDescendantPids(appRootPids);
    const active: string[] = [];
    for (const { name, fullPath } of candidates) {
      const dbFullPath = fullPath.slice(0, -4);
      const targets = [fullPath, dbFullPath].filter((p) => fs.existsSync(p));
      if (targets.length === 0) continue;
      const res = spawnSync('lsof', ['-t', '--', ...targets], { encoding: 'utf8', timeout: 1500 });
      if (res.error) {
        active.push(name);
        continue;
      }
      const openPids = String(res.stdout || '')
        .split(/\s+/)
        .map((tok) => parseInt(tok.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
      if (openPids.some((pid) => appTree.has(pid))) {
        active.push(name);
      }
    }
    return active;
  }

  return candidates.map((c) => c.name);
}

export function relaunchGuardFilePath(): string {
  return path.join(os.tmpdir(), 'ag-cdp-relaunch-guard.json');
}

export function readRelaunchGuard(): RelaunchGuardData {
  const fallback: RelaunchGuardData = {
    lastRelaunchAtMs: 0,
    lastChannel: 'auto',
    reason: '',
    handledPids: []
  };
  try {
    const p = relaunchGuardFilePath();
    if (!fs.existsSync(p)) return fallback;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const handledPids = Array.isArray(raw?.handledPids)
      ? raw.handledPids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    return {
      lastRelaunchAtMs: Number(raw?.lastRelaunchAtMs) || 0,
      lastChannel: String(raw?.lastChannel || 'auto'),
      reason: String(raw?.reason || ''),
      handledPids
    };
  } catch {
    return fallback;
  }
}

export function writeRelaunchGuard(patch: {
  lastChannel?: string;
  reason?: string;
  newPids?: number[];
}): void {
  try {
    const prev = readRelaunchGuard();
    const added = (patch.newPids || []).filter((n) => Number.isFinite(n) && n > 0);
    const mergedPids = Array.from(new Set([...prev.handledPids, ...added])).slice(-16);
    const next: RelaunchGuardData = {
      lastRelaunchAtMs: Date.now(),
      lastChannel: patch.lastChannel ?? prev.lastChannel,
      reason: patch.reason ?? prev.reason,
      handledPids: mergedPids
    };
    fs.writeFileSync(relaunchGuardFilePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // ignore
  }
}
