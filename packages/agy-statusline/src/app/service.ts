import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';
import {
  loadUserConfig,
  readHostPluginEnabled,
  resolveQuotaCachePath,
  resolveSeedQuotaCachePaths,
  stripBom
} from '../core/config.js';
import { buildModelQuotaView, loadQuotaCache } from '../core/quota-store.js';
import { isSqliteAvailable } from '../core/sqlite-metrics.js';
import {
  APP_VERSION,
  daemonPidFilePath,
  fetchTargetsResult,
  isDaemonProcessConfirmed,
  isPidAlive,
  parseDaemonPidFile,
  resolveChannelEndpoints,
  stopExistingDaemon
} from './daemon.js';
import {
  type HostProcessInfo,
  findRecentActiveWal,
  readHostVersionAndProcesses,
  sleepSync,
  writeRelaunchGuard
} from './host-probe.js';

export { type HostProcessInfo, findRecentActiveWal, readHostVersionAndProcesses };

export interface DoctorReport {
  version: string;
  nodeVersion: string;
  nodeOk: boolean;
  sqliteAvailable: boolean;
  platform: string;
  homedir: string;
  pluginInstalled: boolean;
  pluginDir: string;
  hostPluginEnabled: boolean;
  cliSettingsPath: string;
  cliStatuslineCommand: string | null;
  cliStatuslineWired: boolean;
  userConfigPath: string;
  userConfigExists: boolean;
  quotaCachePath: string;
  quotaCacheExists: boolean;
  quotaCacheTimestamp: string | null;
  quotaBuckets: Array<{ key: string; usedPct: number; resetCountdown: string; resetLocalTime: string }>;
  appVersion: string | null;
  cdpStatus: 'ready' | 'missing_opt_in_flag' | 'app_not_running' | 'stale_port_file';
  cdpPortReachable: boolean;
  daemonRunning: boolean;
  daemonPid: number | null;
}

function isModernNode(nodeVer: string = process.versions.node): boolean {
  const [maj, min] = nodeVer.split('.').map((n) => parseInt(n, 10));
  return maj > 22 || (maj === 22 && min >= 13);
}

function resolveStableNodeExecPath(
  execPath: string = process.execPath,
  platform: string = process.platform,
  home: string = os.homedir()
): string {
  if (platform !== 'darwin' && platform !== 'linux') return execPath;
  let realExec = '';
  try {
    realExec = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }

  const dynamicCellar: string[] = [];
  for (const probePath of [execPath, realExec]) {
    const m = String(probePath || '').match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node)$/i);
    if (m) {
      dynamicCellar.push(path.join(m[1], 'bin', m[3]));
      dynamicCellar.push(path.join(m[1], 'opt', m[2], 'bin', m[3]));
    }
  }

  const staticCandidates =
    platform === 'darwin'
      ? [
          '/opt/homebrew/bin/node',
          '/usr/local/bin/node',
          '/opt/homebrew/opt/node/bin/node',
          '/usr/local/opt/node/bin/node',
          '/opt/homebrew/opt/node@22/bin/node',
          '/opt/homebrew/opt/node@24/bin/node',
          path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'),
          path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
        ]
      : [
          '/home/linuxbrew/.linuxbrew/bin/node',
          '/usr/local/bin/node',
          '/usr/bin/node',
          path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
        ];

  const seen = new Set<string>();
  for (const cand of [...dynamicCellar, ...staticCandidates]) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    try {
      if (fs.existsSync(cand) && fs.realpathSync(cand) === realExec) return cand;
    } catch {
      // ignore
    }
  }
  return execPath;
}

function readPortFromPortFile(portFile: string | undefined): number {
  try {
    if (!portFile || !fs.existsSync(portFile)) return 0;
    const first = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]?.trim() || '0';
    const port = parseInt(first, 10);
    return Number.isFinite(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

export async function collectDoctorReport(opts: {
  homedir?: string;
  channel?: string;
  skipProcessProbe?: boolean;
} = {}): Promise<DoctorReport> {
  const homedir = opts.homedir ?? os.homedir();
  const isCustomSandbox = Boolean(opts.homedir && path.resolve(opts.homedir) !== path.resolve(os.homedir()));
  const channel = opts.channel ?? 'auto';
  const pluginDir = path.join(homedir, '.gemini', 'config', 'plugins', 'agy-statusline');
  const pluginInstalled = fs.existsSync(path.join(pluginDir, 'plugin.json')) &&
    fs.existsSync(path.join(pluginDir, 'dist', 'agy-statusline.mjs'));
  const hostPluginEnabled = readHostPluginEnabled(homedir);

  const cliSettingsPath = path.join(homedir, '.gemini', 'antigravity-cli', 'settings.json');
  let cliStatuslineCommand: string | null = null;
  let cliStatuslineWired = false;
  if (fs.existsSync(cliSettingsPath)) {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(cliSettingsPath, 'utf8'))) as {
        statusLine?: { command?: unknown };
      };
      if (typeof parsed?.statusLine?.command === 'string' && parsed.statusLine.command.trim()) {
        cliStatuslineCommand = parsed.statusLine.command.trim();
        cliStatuslineWired = cliStatuslineCommand.toLowerCase().includes('agy-statusline');
      }
    } catch {
      // ignore
    }
  }

  const userCfg = loadUserConfig(homedir);
  const quotaCachePath = resolveQuotaCachePath(homedir);
  const quotaLoad = loadQuotaCache(resolveSeedQuotaCachePaths(homedir));
  const quotaBuckets: DoctorReport['quotaBuckets'] = [];
  if (quotaLoad.cache) {
    const geminiView = buildModelQuotaView(quotaLoad.cache, 'Gemini', undefined);
    const claudeView = buildModelQuotaView(quotaLoad.cache, 'Claude', undefined);
    const seen = new Set<string>();
    for (const w of [...geminiView.windows, ...claudeView.windows]) {
      if (seen.has(w.key)) continue;
      seen.add(w.key);
      quotaBuckets.push({
        key: w.key,
        usedPct: w.usedPct,
        resetCountdown: w.resetCountdown,
        resetLocalTime: w.resetLocalTime
      });
    }
  }

  let appVersion: string | null = null;
  let cdpStatus: DoctorReport['cdpStatus'] = 'app_not_running';
  let cdpPortReachable = false;

  if (!opts.skipProcessProbe && !isCustomSandbox) {
    const hostInfo = readHostVersionAndProcesses(channel, homedir);
    appVersion = hostInfo.appVersion;
    const endpoints = resolveChannelEndpoints(channel, homedir);
    const activePorts = endpoints.map((e) => readPortFromPortFile(e.portFile)).filter((p) => p > 0);
    for (const port of activePorts) {
      const res = await fetchTargetsResult(port);
      if (res.reachable) {
        cdpPortReachable = true;
        break;
      }
    }
    if (hostInfo.runningProcesses.length > 0) {
      const hasReady = cdpPortReachable || hostInfo.runningProcesses.some((p) => p.hasCdpFlag);
      cdpStatus = hasReady ? 'ready' : 'missing_opt_in_flag';
    } else if (activePorts.length > 0) {
      cdpStatus = cdpPortReachable ? 'ready' : 'stale_port_file';
    }
  }

  const pidInfo = isCustomSandbox ? { pid: 0, startMs: 0, stopRequested: false } : parseDaemonPidFile();
  const daemonRunning = Boolean(
    !isCustomSandbox && pidInfo.pid > 0 && !pidInfo.stopRequested && isDaemonProcessConfirmed(pidInfo.pid)
  );

  return {
    version: APP_VERSION,
    nodeVersion: process.version,
    nodeOk: isModernNode(),
    sqliteAvailable: isSqliteAvailable(),
    platform: process.platform,
    homedir,
    pluginInstalled,
    pluginDir,
    hostPluginEnabled,
    cliSettingsPath,
    cliStatuslineCommand,
    cliStatuslineWired,
    userConfigPath: userCfg.path,
    userConfigExists: userCfg.exists,
    quotaCachePath,
    quotaCacheExists: fs.existsSync(quotaCachePath),
    quotaCacheTimestamp: quotaLoad.cache?.timestamp ?? null,
    quotaBuckets,
    appVersion,
    cdpStatus,
    cdpPortReachable,
    daemonRunning,
    daemonPid: daemonRunning ? pidInfo.pid : null
  };
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    `agy-statusline doctor (v${r.version})`,
    '',
    `  node        ${r.nodeVersion} (${r.nodeOk ? 'ok' : 'requires >= 22.13'})`,
    `  sqlite      ${r.sqliteAvailable ? 'available (node:sqlite)' : 'unavailable'}`,
    `  plugin      ${r.pluginInstalled ? 'installed' : 'not installed'} (${r.pluginDir})`,
    `  host switch ${r.hostPluginEnabled ? 'enabled' : 'disabled in ~/.gemini/config/config.json'}`,
    `  cli hook    ${r.cliStatuslineWired ? `wired (${r.cliStatuslineCommand})` : `not wired (${r.cliSettingsPath})`}`,
    `  quota cache ${r.quotaCacheExists ? `present (updated ${r.quotaCacheTimestamp || 'unknown'})` : 'empty'}`,
    `  app cdp     ${r.cdpStatus}${r.appVersion ? ` (v${r.appVersion})` : ''}`,
    `  daemon      ${r.daemonRunning ? `running (PID ${r.daemonPid})` : 'not running'}`
  ];
  if (r.quotaBuckets.length > 0) {
    lines.push('  quotas      ' + r.quotaBuckets.map((b) => `${b.key}=${b.usedPct}%${b.resetCountdown ? ` (${b.resetCountdown})` : ''}`).join(', '));
  }
  return `${lines.join('\n')}\n`;
}

function ensureArgvRemoteDebugging(homedir: string, channel: string): { path: string; action: string } | null {
  const dirName = channel === 'insiders' ? '.antigravity-insiders' : '.antigravity';
  const dotDir = path.join(homedir, dirName);
  if (!fs.existsSync(dotDir)) return null;
  const argvPath = path.join(dotDir, 'argv.json');
  const defaultPort = channel === 'insiders' ? 9223 : 9222;
  try {
    if (!fs.existsSync(argvPath)) {
      fs.writeFileSync(argvPath, `${JSON.stringify({ 'remote-debugging-port': defaultPort }, null, 2)}\n`, 'utf8');
      return { path: argvPath, action: 'created' };
    }
    const raw = fs.readFileSync(argvPath, 'utf8');
    if (/"remote-debugging-port"\s*:/.test(raw)) {
      return { path: argvPath, action: 'already-present' };
    }
    const openIdx = raw.indexOf('{');
    if (openIdx !== -1) {
      const after = raw.slice(openIdx + 1);
      const hasProps = /\S/.test(after.replace(/\}[\s\S]*$/, ''));
      const patched = `${raw.slice(0, openIdx + 1)}\n\t"remote-debugging-port": ${defaultPort}${hasProps ? ',' : ''}${after}`;
      fs.writeFileSync(argvPath, patched, 'utf8');
      return { path: argvPath, action: 'patched' };
    }
  } catch {
    // ignore
  }
  return { path: argvPath, action: 'skipped' };
}

function registerAutostartService(
  pluginDir: string,
  homedir: string
): { platform: string; serviceFile?: string; started?: boolean } {
  const entryScript = path.join(pluginDir, 'dist', 'agy-statusline.mjs');
  const nodeExec = resolveStableNodeExecPath(process.execPath, process.platform, homedir);

  if (process.platform === 'darwin') {
    const launchAgentsDir = path.join(homedir, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const label = 'com.agy.statusline.daemon';
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeExec}</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>${entryScript}</string>
        <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path.join(homedir, '.gemini', 'bin')}:${path.join(homedir, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/agy-statusline-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agy-statusline-daemon.err</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const target = `gui/${uid}/${label}`;
    spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
    const bootRes = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
    if (bootRes.status !== 0) {
      spawnSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
    }
    spawnSync('launchctl', ['kickstart', '-k', target], { stdio: 'ignore' });
    return { platform: 'darwin', serviceFile: plistPath, started: true };
  }

  if (process.platform === 'linux') {
    const systemdDir = path.join(homedir, '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceFile = path.join(systemdDir, 'agy-statusline.service');
    const unit = `[Unit]
Description=AGY Statusline App CDP Daemon
After=default.target

[Service]
Environment="PATH=${path.join(homedir, '.gemini', 'bin')}:${path.join(homedir, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin"
ExecStart="${nodeExec}" --disable-warning=ExperimentalWarning "${entryScript}" daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(serviceFile, unit, 'utf8');
    try {
      execSync('systemctl --user daemon-reload && systemctl --user enable --now agy-statusline.service 2>/dev/null || true');
    } catch {
      // ignore
    }
    return { platform: 'linux', serviceFile, started: true };
  }

  if (process.platform === 'win32') {
    stopExistingDaemon();
    const localVbs = path.join(pluginDir, 'AgyStatuslineDaemon.vbs');
    const cmd = `""${nodeExec}"" --disable-warning=ExperimentalWarning ""${entryScript}"" daemon`;
    const vbs = `\uFEFFSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "${cmd}", 0, False\r\n`;
    fs.writeFileSync(localVbs, vbs, 'utf16le');
    const regRes = spawnSync(
      'reg',
      [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'AgyStatuslineDaemon',
        '/t',
        'REG_SZ',
        '/d',
        `wscript.exe //B //NoLogo "${localVbs}"`,
        '/f'
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    const child = spawn(nodeExec, ['--disable-warning=ExperimentalWarning', entryScript, 'daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return { platform: 'win32', serviceFile: localVbs, started: regRes.status === 0 || Boolean(child.pid) };
  }

  return { platform: process.platform, started: false };
}

function unregisterAutostartService(homedir: string): void {
  if (process.platform === 'darwin') {
    const label = 'com.agy.statusline.daemon';
    const plistPath = path.join(homedir, 'Library', 'LaunchAgents', `${label}.plist`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
    spawnSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
    try {
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    } catch {
      // ignore
    }
  } else if (process.platform === 'linux') {
    const serviceFile = path.join(homedir, '.config', 'systemd', 'user', 'agy-statusline.service');
    try {
      execSync('systemctl --user disable --now agy-statusline.service 2>/dev/null || true');
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
    } catch {
      // ignore
    }
  } else if (process.platform === 'win32') {
    spawnSync(
      'reg',
      ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AgyStatuslineDaemon', '/f'],
      { stdio: 'ignore', windowsHide: true }
    );
  }
}

export function copyPluginTree(srcRoot: string, destRoot: string): void {
  const realSrc = fs.existsSync(srcRoot) ? fs.realpathSync(srcRoot) : srcRoot;
  const realDestParent = path.dirname(destRoot);
  fs.mkdirSync(realDestParent, { recursive: true });
  if (fs.existsSync(destRoot) && fs.realpathSync(destRoot) === realSrc) {
    return;
  }

  fs.mkdirSync(path.join(destRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'skills', 'agy-statusline'), { recursive: true });

  const files = [
    'plugin.json',
    'assets/logo.svg',
    'README.md',
    'dist/agy-statusline.mjs',
    'hooks/status-line.sh',
    'hooks/status-line.cmd',
    'skills/agy-statusline/SKILL.md'
  ];

  for (const rel of files) {
    const s = path.join(srcRoot, rel);
    const d = path.join(destRoot, rel);
    if (!fs.existsSync(s)) continue;
    fs.copyFileSync(s, d);
    if (rel.endsWith('.sh') || rel.endsWith('.mjs')) {
      try {
        fs.chmodSync(d, 0o755);
      } catch {
        // ignore
      }
    }
  }
}

export async function runInstallCommand(opts: {
  packageRoot: string;
  homedir?: string;
  noDaemon?: boolean;
  channel?: string;
}): Promise<Record<string, unknown>> {
  const homedir = opts.homedir ?? os.homedir();
  const isCustomSandbox = path.resolve(homedir) !== path.resolve(os.homedir());
  const pluginDir = path.join(homedir, '.gemini', 'config', 'plugins', 'agy-statusline');

  copyPluginTree(opts.packageRoot, pluginDir);

  // Wire CLI settings.json statusLine while preserving all existing fields
  const cliDir = path.join(homedir, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(cliDir, 'settings.json');
  fs.mkdirSync(cliDir, { recursive: true });
  let settingsObj: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settingsObj = parsed as Record<string, unknown>;
      }
    } catch {
      settingsObj = {};
    }
  }

  const hookCmd =
    process.platform === 'win32'
      ? '%USERPROFILE%\\.gemini\\config\\plugins\\agy-statusline\\hooks\\status-line.cmd'
      : '~/.gemini/config/plugins/agy-statusline/hooks/status-line.sh';
  settingsObj.statusLine = { type: 'command', command: hookCmd };

  const tmpSettings = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpSettings, `${JSON.stringify(settingsObj, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpSettings, settingsPath);

  const argvResult = ensureArgvRemoteDebugging(homedir, opts.channel || 'auto');

  try {
    fs.rmSync(`${resolveQuotaCachePath(homedir)}.backoff.json`, { force: true });
  } catch {
    // ignore
  }

  let serviceInfo: Record<string, unknown> = { skipped: true };
  if (!opts.noDaemon && !isCustomSandbox) {
    stopExistingDaemon();
    serviceInfo = registerAutostartService(pluginDir, homedir);
    const entry = path.join(pluginDir, 'dist', 'agy-statusline.mjs');
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, 'daemon', '--once'], {
      stdio: 'ignore',
      timeout: 5000
    });
  }

  const doctor = await collectDoctorReport({
    homedir,
    channel: opts.channel,
    skipProcessProbe: isCustomSandbox
  });

  return {
    ok: true,
    pluginDir,
    settingsPath,
    statusLineCommand: hookCmd,
    argvResult,
    serviceInfo,
    cdpStatus: isCustomSandbox ? 'sandbox' : doctor.cdpStatus,
    relaunchHint:
      !isCustomSandbox && doctor.cdpStatus === 'missing_opt_in_flag'
        ? `Antigravity is running without --remote-debugging-port. When idle, run: node "${path.join(pluginDir, 'dist', 'agy-statusline.mjs')}" relaunch`
        : null
  };
}

export function runUninstallCommand(opts: { homedir?: string } = {}): Record<string, unknown> {
  const homedir = opts.homedir ?? os.homedir();
  const isCustomSandbox = path.resolve(homedir) !== path.resolve(os.homedir());
  const pluginDir = path.join(homedir, '.gemini', 'config', 'plugins', 'agy-statusline');
  const settingsPath = path.join(homedir, '.gemini', 'antigravity-cli', 'settings.json');

  if (!isCustomSandbox) {
    stopExistingDaemon();
    unregisterAutostartService(homedir);
  }

  let statusLineRemoved = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8'))) as Record<string, unknown>;
      const sl = parsed?.statusLine as { command?: unknown } | undefined;
      if (typeof sl?.command === 'string' && sl.command.toLowerCase().includes('agy-statusline')) {
        delete parsed.statusLine;
        const tmp = `${settingsPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, settingsPath);
        statusLineRemoved = true;
      }
    } catch {
      // ignore
    }
  }

  let pluginRemoved = false;
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    pluginRemoved = true;
  }

  return { ok: true, pluginDir, pluginRemoved, statusLineRemoved };
}

export function runRelaunchCommand(opts: {
  channel?: string;
  force?: boolean;
  homedir?: string;
} = {}): { exitCode: number; payload: Record<string, unknown> } {
  const channel = opts.channel ?? 'auto';
  const homedir = opts.homedir ?? os.homedir();

  const host = readHostVersionAndProcesses(channel, homedir);
  const procs = host.runningProcesses;

  if (!opts.force) {
    const activeWals = findRecentActiveWal(
      homedir,
      channel,
      procs.map((p) => p.pid),
      8
    );
    if (activeWals.length > 0) {
      return {
        exitCode: 2,
        payload: {
          ok: false,
          reason: 'active_conversation_detected',
          activeWals,
          hint: 'Wait until active Agent turns finish or pass --force.'
        }
      };
    }
  }

  writeRelaunchGuard({
    lastChannel: channel,
    reason: 'manual-cli-relaunch',
    newPids: procs.map((p) => p.pid)
  });

  let targetAppPath = procs[0]?.appPath || '';
  let targetExePath = procs[0]?.exePath || '';
  if (!targetAppPath && !targetExePath) {
    if (process.platform === 'darwin') {
      targetAppPath = channel === 'insiders'
        ? '/Applications/Antigravity - Insiders.app'
        : '/Applications/Antigravity.app';
    } else if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
      targetExePath = path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
    } else {
      targetExePath = 'antigravity';
    }
  }

  for (const p of procs) {
    if (process.platform === 'darwin' && p.appPath) {
      spawnSync('osascript', ['-e', `tell application "${p.appPath}" to quit`], { stdio: 'ignore', timeout: 3000 });
      for (let i = 0; i < 25 && isPidAlive(p.pid); i++) sleepSync(100);
    } else if (process.platform === 'win32') {
      const psStop = `$gp = Get-Process -Id ${p.pid} -ErrorAction SilentlyContinue; if ($gp) { [void]$gp.CloseMainWindow(); if (-not $gp.WaitForExit(1800)) { Stop-Process -Id ${p.pid} -Force -ErrorAction SilentlyContinue } }`;
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psStop], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 4500
      });
    }
    if (isPidAlive(p.pid)) {
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch {
        // ignore
      }
      for (let i = 0; i < 30 && isPidAlive(p.pid); i++) sleepSync(100);
    }
  }

  sleepSync(250);

  if (process.platform === 'darwin' && targetAppPath) {
    spawnSync('/usr/bin/open', ['-a', targetAppPath, '--args', '--remote-debugging-port=0'], {
      stdio: 'ignore',
      timeout: 5000
    });
  } else if (targetExePath) {
    const child = spawn(targetExePath, ['--remote-debugging-port=0'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
  }

  const endpoints = resolveChannelEndpoints(channel, homedir);
  for (let i = 0; i < 18; i++) {
    sleepSync(250);
    const portReady = endpoints.some((ep) => readPortFromPortFile(ep.portFile) > 0);
    const flagReady = readHostVersionAndProcesses(channel, homedir).runningProcesses.some((p) => p.hasCdpFlag);
    if (portReady || flagReady) {
      return {
        exitCode: 0,
        payload: {
          ok: true,
          relaunched: true,
          cdpReady: true,
          stoppedPids: procs.map((p) => p.pid)
        }
      };
    }
  }

  const afterProcs = readHostVersionAndProcesses(channel, homedir).runningProcesses;
  return {
    exitCode: 1,
    payload: {
      ok: false,
      reason: afterProcs.length > 0 ? 'cdp_flag_not_applied' : 'launch_blocked_or_failed',
      stoppedPids: procs.map((p) => p.pid),
      hint: 'GUI app launch did not complete in this shell. Open Antigravity from Dock/Spotlight (the background daemon will auto-enable CDP) or run relaunch in an external Terminal.'
    }
  };
}

export function ensureDaemonRunning(cliEntryPath: string): { started: boolean; pid: number | null } {
  const pidInfo = parseDaemonPidFile(daemonPidFilePath());
  if (pidInfo.pid && !pidInfo.stopRequested && isDaemonProcessConfirmed(pidInfo.pid)) {
    return { started: false, pid: pidInfo.pid };
  }
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', cliEntryPath, 'daemon'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );
  child.unref();
  return { started: true, pid: child.pid ?? null };
}
