import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  concatProtoFields,
  encodeBytesField,
  encodeVarintField
} from '../src/core/proto.js';
import { clearMetricsCaches } from '../src/core/sqlite-metrics.js';
import {
  collectDoctorReport,
  runInstallCommand,
  runUninstallCommand
} from '../src/app/service.js';
import {
  buildIdeWebviewDocument,
  collectIdeInspectPayload,
  formatIdeStatusBarDisplay
} from '../src/ide/inspect-provider.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'ag-sl-ide-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  clearMetricsCaches();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('IDE extension install + workspace session inspector', () => {
  it('matches active workspace conversations, formats StatusBar & Webview HTML, and supports session pinning', () => {
    const fakeHome = makeTempDir('ag-sl-ide-home-');
    const wsTarget = path.join(fakeHome, 'projects', 'my-app');
    const wsOther = path.join(fakeHome, 'projects', 'other-repo');
    fs.mkdirSync(wsTarget, { recursive: true });
    fs.mkdirSync(wsOther, { recursive: true });

    const appData = path.join(fakeHome, '.gemini', 'antigravity');
    const convDir = path.join(appData, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const cidTarget = 'aaaaaaaa-1111-2222-3333-444444444444';
    const cidOther = 'bbbbbbbb-1111-2222-3333-444444444444';

    // Populate conversation_summaries.db
    const sdb = new DatabaseSync(path.join(appData, 'conversation_summaries.db'));
    sdb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL DEFAULT "",
        not_fully_idle NUMERIC NOT NULL DEFAULT 0,
        killed NUMERIC NOT NULL DEFAULT 0
      );
    `);
    const insSummary = sdb.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, parent_conversation_id, not_fully_idle, killed)
       VALUES (?, ?, ?, ?, ?, '', ?, 0)`
    );
    insSummary.run(
      cidOther,
      'Other Repo Task',
      15,
      '2026-11-24T12:00:00Z',
      JSON.stringify([pathToFileURL(wsOther).href]),
      0
    );
    insSummary.run(
      cidTarget,
      'Implement IDE Extension',
      28,
      '2026-11-24T11:30:00Z',
      JSON.stringify([pathToFileURL(wsTarget).href]),
      1
    );
    sdb.close();

    // Populate conversation DBs
    const createSimpleConvDb = (cid: string, inTok: number, cacheRead: number, modelDisplay: string) => {
      const db = new DatabaseSync(path.join(convDir, `${cid}.db`));
      db.exec(`
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER);
        CREATE TABLE trajectory_metadata_blob (data BLOB);
      `);
      const usage = concatProtoFields([
        encodeVarintField(2, inTok),
        encodeVarintField(3, 800),
        encodeVarintField(5, cacheRead),
        encodeVarintField(9, 250),
        encodeVarintField(10, 550)
      ]);
      const dur = (s: number) => concatProtoFields([encodeVarintField(1, s), encodeVarintField(2, 0)]);
      const chat = concatProtoFields([
        encodeBytesField(4, usage),
        encodeBytesField(9, encodeBytesField(10, encodeVarintField(4, 256000))),
        encodeBytesField(11, dur(1)),
        encodeBytesField(12, dur(5)),
        encodeBytesField(21, modelDisplay)
      ]);
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)').run(encodeBytesField(1, chat));
      db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14), (1, 15)').run();
      db.close();
    };

    createSimpleConvDb(cidTarget, 6000, 58000, 'Gemini 4 Carbon (Medium)'); // 64k / 256k = 25%
    createSimpleConvDb(cidOther, 10000, 190000, 'Claude Sonnet 5.5 (Thinking)'); // 200k / 256k = 78%

    // Seed quota cache
    const cacheDir = path.join(fakeHome, '.cache', 'agy-statusline');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'quota_cache.json'),
      JSON.stringify({
        timestamp: '2026-11-24T12:00:00Z',
        quota: {
          'gemini-5h': { remaining_fraction: 0.72, reset_time: '2026-11-24T15:00:00Z' },
          'gemini-weekly': { remaining_fraction: 0.50, reset_time: '2026-11-28T12:00:00Z' }
        }
      })
    );

    const now = new Date('2026-11-24T12:30:00Z');
    const autoPayload = collectIdeInspectPayload({
      homedir: fakeHome,
      workspacePaths: [wsTarget],
      now
    });

    assert.equal(autoPayload.ok, true);
    assert.equal(autoPayload.matchedWorkspace, true);
    assert.equal(autoPayload.selectedCascadeId, cidTarget);
    assert.equal(autoPayload.selectedTitle, 'Implement IDE Extension');
    assert.equal(autoPayload.metrics?.ctxPct, 25);

    const bar = formatIdeStatusBarDisplay(autoPayload);
    assert.ok(bar.text.includes('4 Carbon Med'));
    assert.ok(bar.text.includes('Ctx 25%'));
    assert.ok(bar.text.includes('5h 28%'));
    assert.ok(bar.text.includes('7d 50%'));
    assert.equal(bar.severity, 'ok');
    assert.ok(bar.markdownTooltip.includes('Implement IDE Extension'));
    assert.ok(bar.markdownTooltip.includes('command:agy-statusline.openPanel'));

    const webviewHtml = buildIdeWebviewDocument(autoPayload, '/* css */', '');
    assert.ok(webviewHtml.includes('id="ag-sl-session-select"'));
    assert.ok(webviewHtml.includes('Implement IDE Extension'));
    assert.ok(webviewHtml.includes('Other Repo Task'));
    assert.ok(webviewHtml.includes('ag-sl-webview-card'));

    // Pinning to cidOther switches metrics & triggers warn severity (78% >= 75%)
    const pinnedPayload = collectIdeInspectPayload({
      homedir: fakeHome,
      workspacePaths: [wsTarget],
      pinnedCascadeId: cidOther,
      now
    });
    assert.equal(pinnedPayload.selectedCascadeId, cidOther);
    assert.equal(pinnedPayload.metrics?.ctxPct, 78);
    const pinnedBar = formatIdeStatusBarDisplay(pinnedPayload);
    assert.equal(pinnedBar.severity, 'warn');
  });

  it('installs, registers in extensions.json, diagnoses, and uninstalls IDE extensions across Antigravity IDE and VS Code', async () => {
    const fakePkgRoot = makeTempDir('ag-sl-ide-pkg-');
    const fakeHome = makeTempDir('ag-sl-ide-sandbox-');

    // Prepare staged package tree including ide/
    fs.mkdirSync(path.join(fakePkgRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'ide', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'skills', 'agy-statusline'), { recursive: true });
    fs.writeFileSync(path.join(fakePkgRoot, 'plugin.json'), '{"name":"agy-statusline","version":"0.3.0"}\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'README.md'), '# agy-statusline\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'dist', 'agy-statusline.mjs'), '#!/usr/bin/env node\n');
    fs.writeFileSync(
      path.join(fakePkgRoot, 'ide', 'package.json'),
      JSON.stringify({ name: 'agy-statusline', publisher: 'agy-tools', version: '0.3.0' }, null, 2)
    );
    fs.writeFileSync(path.join(fakePkgRoot, 'ide', 'dist', 'extension.cjs'), 'exports.activate = () => {};\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'hooks', 'status-line.sh'), '#!/usr/bin/env sh\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'hooks', 'status-line.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(fakePkgRoot, 'skills', 'agy-statusline', 'SKILL.md'), '# skill\n');

    // Simulate existing Antigravity IDE (with an existing extension in extensions.json) and VS Code profiles
    const agyIdeExtDir = path.join(fakeHome, '.antigravity-ide', 'extensions');
    const vscodeExtDir = path.join(fakeHome, '.vscode', 'extensions');
    fs.mkdirSync(agyIdeExtDir, { recursive: true });
    fs.mkdirSync(vscodeExtDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyIdeExtDir, 'extensions.json'),
      JSON.stringify([
        {
          identifier: { id: 'rust-lang.rust-analyzer' },
          version: '0.3.3113',
          relativeLocation: 'rust-lang.rust-analyzer-0.3.3113'
        }
      ])
    );

    const installRes = await runInstallCommand({
      packageRoot: fakePkgRoot,
      homedir: fakeHome,
      noDaemon: true
    });
    assert.equal(installRes.ok, true);
    assert.equal((installRes.ideExtensions as unknown[]).length, 2);

    assert.ok(fs.existsSync(path.join(agyIdeExtDir, 'agy-tools.agy-statusline-0.3.0', 'dist', 'extension.cjs')));
    assert.ok(fs.existsSync(path.join(vscodeExtDir, 'agy-tools.agy-statusline-0.3.0', 'dist', 'extension.cjs')));

    const agyExtJsonAfterInstall = JSON.parse(fs.readFileSync(path.join(agyIdeExtDir, 'extensions.json'), 'utf8')) as Array<{
      identifier?: { id?: string };
    }>;
    assert.equal(agyExtJsonAfterInstall.length, 2);
    assert.ok(agyExtJsonAfterInstall.some((e) => e.identifier?.id === 'rust-lang.rust-analyzer'));
    assert.ok(agyExtJsonAfterInstall.some((e) => e.identifier?.id === 'agy-tools.agy-statusline'));

    const report = await collectDoctorReport({ homedir: fakeHome, skipProcessProbe: true });
    assert.equal(report.ideExtensionInstalled, true);
    assert.equal(report.ideTargets.length, 2);
    assert.ok(report.ideTargets.every((t) => t.installed && t.version === '0.3.0'));

    const uninstallRes = runUninstallCommand({ homedir: fakeHome });
    assert.equal(uninstallRes.ok, true);
    assert.deepEqual(uninstallRes.ideRemovedFrom, ['antigravity-ide', 'vscode']);
    assert.equal(fs.existsSync(path.join(agyIdeExtDir, 'agy-tools.agy-statusline-0.3.0')), false);
    assert.equal(fs.existsSync(path.join(vscodeExtDir, 'agy-tools.agy-statusline-0.3.0')), false);

    const agyExtJsonAfterUninstall = JSON.parse(fs.readFileSync(path.join(agyIdeExtDir, 'extensions.json'), 'utf8')) as Array<{
      identifier?: { id?: string };
    }>;
    assert.equal(agyExtJsonAfterUninstall.length, 1);
    assert.equal(agyExtJsonAfterUninstall[0].identifier?.id, 'rust-lang.rust-analyzer');
  });
});
