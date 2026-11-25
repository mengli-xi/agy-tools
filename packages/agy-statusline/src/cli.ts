import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadUserConfig,
  resolveQuotaCachePath,
  resolveSeedQuotaCachePaths
} from './core/config.js';
import { buildModelQuotaView, loadQuotaCache } from './core/quota-store.js';
import { refreshQuotaViaUsage } from './core/usage-runner.js';
import { APP_VERSION, runDaemon } from './app/daemon.js';
import {
  collectDoctorReport,
  ensureDaemonRunning,
  formatDoctorReport,
  runInstallCommand,
  runRelaunchCommand,
  runUninstallCommand
} from './app/service.js';
import { CONTEXT_CATEGORY_SPECS, formatContextCeiling, formatContextUsed } from './core/format.js';
import { collectIdeInspectPayload } from './ide/inspect-provider.js';
import { runStatuslineCommand } from './statusline/render.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePackageRoot(): string {
  // When bundled at dist/agy-statusline.mjs -> parent is package root.
  const parent = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(parent, 'plugin.json'))) return parent;
  return __dirname;
}

function getArg(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function getAllArgs(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      out.push(args[i + 1]);
      i++;
    } else if (args[i].startsWith(`${flag}=`)) {
      out.push(args[i].slice(flag.length + 1));
    }
  }
  return out;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function printUsage(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(
    [
      `agy-statusline v${APP_VERSION}`,
      '',
      'Usage:',
      '  agy-statusline statusline                       Render CLI /statusline output from stdin JSON',
      '  agy-statusline inspect [--json] [--workspace .] Inspect granular context breakdown & IDE snapshot',
      '  agy-statusline daemon [--once] [--channel ...]  Run App CDP capsule daemon',
      '  agy-statusline ensure-daemon                    Start daemon in background if not running',
      '  agy-statusline install [--home <dir>]           Install plugin, IDE ext, CLI hook & App daemon',
      '  agy-statusline uninstall [--home <dir>]         Remove plugin, IDE ext, CLI hook & App daemon',
      '  agy-statusline relaunch [--force]               Relaunch Antigravity App with CDP port enabled',
      '  agy-statusline quota refresh|show [--json]      Refresh or inspect shared 5h/7d quota cache',
      '  agy-statusline doctor [--json]                  Check App, IDE, CLI wiring, CDP & quota cache',
      '  agy-statusline version                          Print version',
      ''
    ].join('\n')
  );
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? (process.stdin.isTTY ? 'help' : 'statusline');
  const rest = argv.slice(1);
  const homedir = getArg(argv, '--home') || os.homedir();

  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage(process.stdout);
    return 0;
  }

  if (command === 'statusline') {
    const { config } = loadUserConfig(homedir);
    return runStatuslineCommand(__filename, config, { homedir });
  }

  if (command === 'inspect') {
    const workspaces = getAllArgs(rest, '--workspace');
    const pinnedCascadeId = getArg(rest, '--cascade') || '';
    const modelHint = getArg(rest, '--model') || '';
    const payload = collectIdeInspectPayload({
      homedir,
      workspacePaths: workspaces.length > 0 ? workspaces : [process.cwd()],
      pinnedCascadeId,
      modelHint
    });
    if (hasFlag(rest, '--json')) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const m = payload.metrics;
      if (!m || !m.hasData) {
        process.stdout.write('No active conversation matched for workspace.\n');
      } else {
        const lines = [
          `Session: ${payload.selectedTitle || m.cascadeId} (${m.cascadeId})`,
          `Context: [${formatContextUsed(m.ctxTokens)}/${formatContextCeiling(m.contextLimitTokens)}] ${m.ctxPct}% (free ${formatContextUsed(m.remainCtxTokens)})`
        ];
        if (m.ctxDetail) {
          const cats = m.ctxDetail.categories;
          for (const spec of CONTEXT_CATEGORY_SPECS) {
            const v = cats[spec.key] || 0;
            if (v <= 0) continue;
            lines.push(`  - ${spec.label}: ${formatContextUsed(v)}`);
          }
          if (m.ctxDetail.deferred.totalTokens > 0) {
            lines.push(`  - 懒加载已省 (0 活跃占用): ${formatContextUsed(m.ctxDetail.deferred.totalTokens)}`);
          }
          if (m.ctxDetail.compaction.count > 0) {
            lines.push(
              `  - 自动/手动压缩: ${m.ctxDetail.compaction.count} 次 (省 ${formatContextUsed(m.ctxDetail.compaction.totalSavedTokens)})`
            );
          }
        }
        process.stdout.write(`${lines.join('\n')}\n`);
      }
    }
    return 0;
  }

  if (command === 'daemon') {
    return runDaemon({
      once: hasFlag(rest, '--once'),
      channel: getArg(rest, '--channel'),
      cliEntryPath: __filename,
      homedir
    });
  }

  if (command === 'ensure-daemon') {
    ensureDaemonRunning(__filename);
    process.stdout.write('{}\n');
    return 0;
  }

  if (command === 'quota') {
    const sub = rest[0] || 'show';
    const cachePath = resolveQuotaCachePath(homedir);
    if (sub === 'refresh') {
      const res = await refreshQuotaViaUsage(cachePath, {
        background: hasFlag(rest, '--background'),
        lockToken: getArg(rest, '--lock-token') || '',
        homedir
      });
      if (hasFlag(rest, '--json')) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stderr.write(`[quota] ${res.message}\n`);
        if (res.ok && res.summary) process.stdout.write(`${res.summary}\n`);
      }
      return res.ok ? 0 : 2;
    }
    if (sub === 'show') {
      const { cache } = loadQuotaCache(resolveSeedQuotaCachePaths(homedir));
      const view = buildModelQuotaView(cache, getArg(rest, '--model') || 'Gemini');
      process.stdout.write(`${JSON.stringify({ cachePath, cache, view }, null, 2)}\n`);
      return 0;
    }
    printUsage(process.stderr);
    return 2;
  }

  if (command === 'install') {
    const res = await runInstallCommand({
      packageRoot: resolvePackageRoot(),
      homedir,
      noDaemon: hasFlag(rest, '--no-daemon'),
      channel: getArg(rest, '--channel') || 'auto'
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (command === 'uninstall') {
    const res = runUninstallCommand({ homedir });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (command === 'relaunch') {
    const res = runRelaunchCommand({
      channel: getArg(rest, '--channel') || 'auto',
      force: hasFlag(rest, '--force'),
      homedir
    });
    process.stdout.write(`${JSON.stringify(res.payload, null, 2)}\n`);
    return res.exitCode;
  }

  if (command === 'doctor') {
    const report = await collectDoctorReport({
      homedir,
      channel: getArg(rest, '--channel') || 'auto'
    });
    if (hasFlag(rest, '--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatDoctorReport(report));
    }
    return 0;
  }

  printUsage(process.stderr);
  return 2;
}

let isDirectMain = false;
if (process.argv[1]) {
  try {
    isDirectMain = fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    const base = path.basename(process.argv[1]);
    isDirectMain = base === 'agy-statusline.mjs' || base === 'agy-statusline' || base === 'cli.ts';
  }
}

if (isDirectMain) {
  const code = await runCli();
  process.exit(code);
}
