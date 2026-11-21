import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { buildAppPayload } from '../src/core/format.js';
import { buildModelQuotaView } from '../src/core/quota-store.js';
import type { SessionMetrics } from '../src/core/types.js';
import { stripAnsi, visibleLen } from '../src/statusline/ansi.js';
import { renderStatusline } from '../src/statusline/render.js';
import {
  collectDoctorReport,
  findRecentActiveWal,
  runInstallCommand,
  runUninstallCommand
} from '../src/app/service.js';
import { parsePosixEtimeSeconds } from '../src/app/host-probe.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'ag-sl-cli-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function sampleMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    cascadeId: '11111111-2222-3333-4444-555555555555',
    hasData: true,
    lastGenIdx: 3,
    ctxTokens: 42000,
    contextLimitTokens: 256000,
    ctxPct: 16,
    remainCtxTokens: 214000,
    lastInTok: 1200,
    lastCacheRead: 40800,
    lastOutTok: 850,
    lastThinkTok: 300,
    lastRespTok: 550,
    lastCacheRate: 97.1,
    sessionCacheRate: 92.4,
    totalIn: 10000,
    totalCache: 121000,
    totalOut: 3200,
    totalThink: 1200,
    totalResp: 2000,
    userTurns: 4,
    validCalls: 6,
    turnSteps: 2,
    turnOut: 1400,
    turnThink: 500,
    turnResp: 900,
    turnDur: 16.2,
    useStreamTps: true,
    rawStreamTps: 85.4,
    e2eTps: 72.1,
    tps: 85.4,
    ttft: 1.2,
    streamDur: 10.0,
    totDur: 11.2,
    subagentCount: 2,
    subagentCalls: 3,
    subagentIn: 1000,
    subagentCache: 4000,
    subagentOut: 900,
    descendantCount: 2,
    ...overrides
  };
}

describe('statusline rendering + app payload + sandbox install', () => {
  it('renders full unified metrics on wide CLI terminals and degrades cleanly on narrow ones', () => {
    const now = new Date('2026-11-21T02:00:00Z');
    const cfg = defaultConfig();
    cfg.cli.color = false;

    const payload = {
      model: { id: 'gemini-4-carbon-medium', display_name: 'Gemini 4 Carbon (Medium)' },
      context_window: {
        total_input_tokens: 42000,
        context_window_size: 256000,
        used_percentage: 16.4
      },
      quota: {
        'gemini-5h': { remaining_fraction: 0.78, reset_time: '2026-11-21T04:15:00Z' },
        'gemini-weekly': { remaining_fraction: 0.55, reset_time: '2026-11-25T10:00:00Z' }
      },
      terminal_width: 140
    };

    const wide = renderStatusline(JSON.stringify(payload), {
      config: cfg,
      now,
      metrics: sampleMetrics(),
      gitBranch: 'main'
    });
    assert.equal(
      wide,
      '4 Carbon Med │ main │ Ctx 16% · Cache 97% · 85 tok/s · 5h 22% 2h15m · 7d 45% 4d08h · +2 sub'
    );

    // Pure telemetry mode (no model/branch prefix)
    const pureCfg = defaultConfig();
    pureCfg.cli.color = false;
    pureCfg.cli.showModel = false;
    pureCfg.cli.showGitBranch = false;
    const pure = renderStatusline(JSON.stringify(payload), {
      config: pureCfg,
      now,
      metrics: sampleMetrics(),
      gitBranch: 'main'
    });
    assert.equal(pure, 'Ctx 16% · Cache 97% · 85 tok/s · 5h 22% 2h15m · 7d 45% 4d08h · +2 sub');

    // Progressive width fitting with ANSI colors enabled
    const colorCfg = defaultConfig();
    for (const width of [75, 52, 32]) {
      const narrow = renderStatusline(JSON.stringify({ ...payload, terminal_width: width }), {
        config: colorCfg,
        now,
        metrics: sampleMetrics(),
        gitBranch: 'feature/very-long-branch-name'
      });
      assert.ok(visibleLen(narrow) <= width, `width ${width} exceeded: ${stripAnsi(narrow)}`);
      assert.ok(stripAnsi(narrow).includes('Ctx 16%'));
    }

    // Dynamic ANSI colorization responds to threshold transitions
    const warnLine = renderStatusline(
      JSON.stringify({
        ...payload,
        context_window: { total_input_tokens: 215000, context_window_size: 256000 },
        quota: {
          'gemini-5h': { remaining_fraction: 0.08, reset_time: '2026-11-21T04:15:00Z' },
          'gemini-weekly': { remaining_fraction: 0.45, reset_time: '2026-11-25T10:00:00Z' }
        },
        terminal_width: 140
      }),
      {
        config: colorCfg,
        now,
        metrics: sampleMetrics({ ctxPct: 84, lastCacheRate: 30, tps: 120 }),
        gitBranch: 'main'
      }
    );
    assert.ok(warnLine.includes('\x1b[38;5;208m84%\x1b[0m'));
    assert.ok(warnLine.includes('\x1b[38;5;208m30%\x1b[0m'));
    assert.ok(warnLine.includes('\x1b[36m120\x1b[0m tok/s'));
    assert.ok(warnLine.includes('\x1b[31m92%\x1b[0m'));
    assert.ok(warnLine.includes('\x1b[33m55%\x1b[0m'));
  });

  it('builds App inline & tooltip HTML for active sessions and keeps quota resident on Home', () => {
    const now = new Date('2026-11-21T02:00:00Z');
    const cfg = defaultConfig();
    const quotaView = buildModelQuotaView(
      {
        timestamp: '2026-11-21T01:59:00Z',
        quota: {
          'gemini-5h': { remaining_fraction: 0.78, reset_time: '2026-11-21T04:15:00Z' },
          'gemini-weekly': { remaining_fraction: 0.55, reset_time: '2026-11-25T10:00:00Z' }
        }
      },
      'Gemini 4 Carbon (Medium)',
      undefined,
      now
    );

    const activeItem = buildAppPayload('pane-1', '11111111-2222-3333-4444-555555555555', sampleMetrics(), quotaView, cfg);
    assert.equal(activeItem.hasContent, true);
    assert.ok(activeItem.inlineHtml.includes('class="ag-sl-bar-left"'));
    assert.ok(activeItem.inlineHtml.includes('class="ag-sl-bar-right"'));
    assert.ok(activeItem.inlineHtml.includes('<span class="ag-sl-tone-good">16%</span>'));
    assert.ok(activeItem.inlineHtml.includes('42k/256k'));
    assert.ok(activeItem.inlineHtml.includes('<span class="ag-sl-tone-good">97%</span>'));
    assert.ok(activeItem.inlineHtml.includes('<span class="ag-sl-tone-good">85</span>'));
    assert.ok(activeItem.inlineHtml.includes('<span class="ag-sl-lbl">TTFT</span> <span class="ag-sl-tone-good">1.2s</span>'));
    assert.ok(activeItem.inlineHtml.includes('<span class="ag-sl-lbl">Out</span> <span class="ag-sl-val">4.1k</span>'));
    assert.ok(activeItem.inlineHtml.includes('5h</span> <span class="ag-sl-tone-good">22%</span>'));
    assert.ok(activeItem.inlineHtml.includes('7d</span> <span class="ag-sl-tone-good">45%</span>'));
    assert.ok(activeItem.inlineHtml.includes('+2 sub'));
    assert.ok(activeItem.tooltipHtml.includes('class="ag-sl-ctx-block"'));
    assert.ok(activeItem.tooltipHtml.includes('class="ag-sl-kpi-grid"'));
    assert.ok(activeItem.tooltipHtml.includes('class="ag-sl-quota-grid"'));
    assert.ok(activeItem.tooltipHtml.includes('Gen #4'));
    assert.ok(activeItem.tooltipHtml.includes('4 轮提问 · 6 次调用'));
    assert.ok(activeItem.tooltipHtml.includes('账户模型配额 (Gemini)'));

    const stressedItem = buildAppPayload(
      'pane-2',
      '11111111-2222-3333-4444-555555555555',
      sampleMetrics({ ctxPct: 92, lastCacheRate: 25, tps: 145, ttft: 7.5 }),
      quotaView,
      cfg
    );
    assert.ok(stressedItem.inlineHtml.includes('<span class="ag-sl-tone-crit">92%</span>'));
    assert.ok(stressedItem.inlineHtml.includes('<span class="ag-sl-tone-warn">25%</span>'));
    assert.ok(stressedItem.inlineHtml.includes('<span class="ag-sl-tone-info">145</span>'));
    assert.ok(stressedItem.inlineHtml.includes('<span class="ag-sl-tone-warn">7.5s</span>'));
    assert.ok(stressedItem.tooltipHtml.includes('ag-sl-bg-crit'));

    const homeItem = buildAppPayload('pane-1', '', null, quotaView, cfg);
    assert.equal(homeItem.hasContent, true);
    assert.ok(homeItem.inlineHtml.includes('class="ag-sl-bar-left"'));
    assert.ok(homeItem.inlineHtml.includes('<span class="ag-sl-tone-dim">0%</span>'));
    assert.ok(homeItem.inlineHtml.includes('<span class="ag-sl-tone-dim">--</span>'));
    assert.ok(homeItem.inlineHtml.includes('class="ag-sl-bar-right"'));
    assert.ok(homeItem.inlineHtml.includes('5h'));
    assert.ok(homeItem.inlineHtml.includes('7d'));
    assert.ok(homeItem.tooltipHtml.includes('class="ag-sl-quota-grid"'));
    assert.ok(homeItem.tooltipHtml.includes('账户模型配额 (Gemini)'));
  });

  it('installs, diagnoses, and uninstalls cleanly in an isolated sandbox --home', async () => {
    const fakePkgRoot = makeTempDir('ag-sl-pkg-');
    const fakeHome = makeTempDir('ag-sl-home-');

    fs.mkdirSync(path.join(fakePkgRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'skills', 'agy-statusline'), { recursive: true });
    fs.writeFileSync(path.join(fakePkgRoot, 'plugin.json'), '{"name":"agy-statusline"}\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'README.md'), '# test\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'dist', 'agy-statusline.mjs'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'hooks', 'status-line.sh'), '#!/usr/bin/env sh\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'hooks', 'status-line.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'skills', 'agy-statusline', 'SKILL.md'), '# skill\n');

    const cliDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive: true });
    const settingsPath = path.join(cliDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ toolPermission: 'always-proceed' }, null, 2));

    const installRes = await runInstallCommand({
      packageRoot: fakePkgRoot,
      homedir: fakeHome,
      noDaemon: true
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.cdpStatus, 'sandbox');

    const afterInstallSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterInstallSettings.toolPermission, 'always-proceed');
    assert.ok(String(afterInstallSettings.statusLine?.command || '').includes('agy-statusline'));

    const report = await collectDoctorReport({ homedir: fakeHome, skipProcessProbe: true });
    assert.equal(report.nodeOk, true);
    assert.equal(report.sqliteAvailable, true);
    assert.equal(report.pluginInstalled, true);
    assert.equal(report.cliStatuslineWired, true);

    const uninstallRes = runUninstallCommand({ homedir: fakeHome });
    assert.equal(uninstallRes.ok, true);
    assert.equal(uninstallRes.pluginRemoved, true);
    assert.equal(uninstallRes.statusLineRemoved, true);

    const afterUninstallSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterUninstallSettings.toolPermission, 'always-proceed');
    assert.equal(afterUninstallSettings.statusLine, undefined);
  });

  it('scopes active WAL detection to the target App process tree', () => {
    const fakeHome = makeTempDir('ag-sl-wal-home-');
    const convDir = path.join(fakeHome, '.gemini', 'antigravity', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const walPath = path.join(convDir, 'test.db-wal');
    fs.writeFileSync(walPath, Buffer.alloc(8192, 1));

    const fd = fs.openSync(walPath, 'r');
    try {
      assert.deepEqual(findRecentActiveWal(fakeHome, 'stable', []), []);
      if (process.platform !== 'win32') {
        assert.deepEqual(findRecentActiveWal(fakeHome, 'stable', [999999]), []);
        assert.deepEqual(findRecentActiveWal(fakeHome, 'stable', [process.pid]), ['test.db-wal']);
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  it('parses POSIX ps etime durations safely', () => {
    assert.equal(parsePosixEtimeSeconds('00:05'), 5);
    assert.equal(parsePosixEtimeSeconds('01:02:03'), 3723);
    assert.equal(parsePosixEtimeSeconds('2-00:00:01'), 172801);
    assert.equal(parsePosixEtimeSeconds(''), 999999);
  });
});
