import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveQuotaCachePath } from '../core/config.js';
import { escapeHtml } from '../core/format.js';
import { isSqliteAvailable } from '../core/sqlite-metrics.js';
import type { IdeInspectPayload } from '../core/types.js';
import { isUsageRefreshDue, spawnDetachedQuotaRefresh } from '../core/usage-runner.js';
import {
  buildIdeWebviewDocument,
  buildIdeWebviewOptionsHtml,
  collectIdeInspectPayload,
  formatIdeStatusBarDisplay
} from './inspect-provider.js';

const TRUSTED_COMMANDS = [
  'agy-statusline.openPanel',
  'agy-statusline.selectSession',
  'agy-statusline.refreshQuota'
] as const;

function resolveExternalNodeBinary(homedir: string): string {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
          path.join(process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'fnm_multishells', 'node.exe'),
          'node.exe'
        ]
      : [
          '/opt/homebrew/bin/node',
          '/usr/local/bin/node',
          path.join(homedir, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'),
          path.join(homedir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'),
          '/usr/bin/node',
          'node'
        ];
  for (const cand of candidates) {
    if (!path.isAbsolute(cand) || fs.existsSync(cand)) {
      return cand;
    }
  }
  return 'node';
}

function resolveCliScriptPath(extensionPath: string, homedir: string): string {
  const candidates = [
    path.join(extensionPath, '..', 'dist', 'agy-statusline.mjs'),
    path.join(extensionPath, 'agy-statusline.mjs'),
    path.join(homedir, '.gemini', 'config', 'plugins', 'agy-statusline', 'dist', 'agy-statusline.mjs')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

function fetchPayloadViaExternalCli(
  nodeBin: string,
  cliScript: string,
  workspacePaths: string[],
  pinnedCascadeId: string
): Promise<IdeInspectPayload | null> {
  return new Promise((resolve) => {
    if (!cliScript) {
      resolve(null);
      return;
    }
    const args = ['--disable-warning=ExperimentalWarning', cliScript, 'inspect', '--json'];
    for (const wp of workspacePaths) {
      args.push('--workspace', wp);
    }
    if (pinnedCascadeId) {
      args.push('--cascade', pinnedCascadeId);
    }
    execFile(nodeBin, args, { timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as IdeInspectPayload;
        resolve(parsed && parsed.ok ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const homedir = os.homedir();
  let pinnedCascadeId = '';
  let lastPayload: IdeInspectPayload | null = null;
  let refreshing = false;
  let activePanel: vscode.WebviewPanel | null = null;
  let lastPushedHtmlSig = '';
  let lastActivityMs = Date.now();
  let lastMetricsSig = '';

  const createBarItem = (alignment: 'left' | 'right') => {
    const alignEnum =
      alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    const priority = alignment === 'left' ? 95 : 105;
    const item = vscode.window.createStatusBarItem('agy-statusline.bar', alignEnum, priority);
    item.name = 'AGY Statusline';
    item.command = 'agy-statusline.openPanel';
    return item;
  };

  let currentAlignment: 'left' | 'right' = 'right';
  let statusBarItem = createBarItem(currentAlignment);
  context.subscriptions.push({
    dispose: () => {
      statusBarItem.dispose();
    }
  });

  const getWorkspacePaths = (): string[] => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map((f) => f.uri.fsPath).filter(Boolean);
  };

  const pushWebviewUpdate = (payload: IdeInspectPayload) => {
    if (!activePanel) return;
    const optionsHtml = buildIdeWebviewOptionsHtml(payload, pinnedCascadeId);
    const emptyHint =
      !payload.metrics || !payload.metrics.hasData
        ? `<div class="ag-sl-wv-empty">当前工作区暂未匹配到进行中的对话，可在上方下拉框手动选择历史会话查看上下文拆分。</div>`
        : '';
    const sig = `${pinnedCascadeId}|${optionsHtml}|${payload.dashboardHtml}`;
    if (sig === lastPushedHtmlSig) return;
    lastPushedHtmlSig = sig;
    void activePanel.webview.postMessage({
      type: 'update',
      optionsHtml,
      emptyHint,
      dashboardHtml: payload.dashboardHtml
    });
  };

  const refreshTick = async (forceWebview = false): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const wsPaths = getWorkspacePaths();
      let payload: IdeInspectPayload | null = null;

      if (isSqliteAvailable()) {
        payload = collectIdeInspectPayload({
          homedir,
          workspacePaths: wsPaths,
          pinnedCascadeId
        });
      } else {
        const cliScript = resolveCliScriptPath(context.extensionPath, homedir);
        const nodeBin = resolveExternalNodeBinary(homedir);
        payload = await fetchPayloadViaExternalCli(nodeBin, cliScript, wsPaths, pinnedCascadeId);
      }

      if (!payload || !payload.enabled) {
        statusBarItem.hide();
        return;
      }

      lastPayload = payload;

      if (payload.config.ide.alignment !== currentAlignment) {
        currentAlignment = payload.config.ide.alignment;
        statusBarItem.dispose();
        statusBarItem = createBarItem(currentAlignment);
      }

      const nextMetricsSig = payload.metrics?.sig || '';
      if (nextMetricsSig && nextMetricsSig !== lastMetricsSig) {
        lastMetricsSig = nextMetricsSig;
        lastActivityMs = Date.now();
      }

      // Trigger background quota refresh when due and CLI script is installed
      const cliScript = resolveCliScriptPath(context.extensionPath, homedir);
      if (cliScript) {
        const cachePath = resolveQuotaCachePath(homedir);
        const now = new Date();
        const recentlyActive = now.getTime() - lastActivityMs < 3 * 60 * 1000;
        if (isUsageRefreshDue(cachePath, null, recentlyActive, now)) {
          spawnDetachedQuotaRefresh(cliScript, cachePath, recentlyActive, null, now, homedir);
        }
      }

      const display = formatIdeStatusBarDisplay(payload);
      statusBarItem.text = display.text;
      if (display.severity === 'crit') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (display.severity === 'warn') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBarItem.backgroundColor = undefined;
      }

      const md = new vscode.MarkdownString(display.markdownTooltip, true);
      md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
      md.supportHtml = true;
      statusBarItem.tooltip = md;
      statusBarItem.show();

      if (activePanel && (forceWebview || activePanel.visible)) {
        pushWebviewUpdate(payload);
      }
    } catch {
      // keep existing bar state on transient errors
    } finally {
      refreshing = false;
    }
  };

  const openInspectorPanel = async () => {
    if (!lastPayload) {
      await refreshTick(true);
    }
    if (activePanel) {
      activePanel.reveal(vscode.ViewColumn.Beside, false);
      if (lastPayload) {
        lastPushedHtmlSig = '';
        pushWebviewUpdate(lastPayload);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agyStatuslineInspector',
      'AGY Context & Quota',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    activePanel = panel;
    lastPushedHtmlSig = '';

    if (lastPayload) {
      panel.webview.html = buildIdeWebviewDocument(lastPayload, __AG_CAPSULE_CSS__, pinnedCascadeId);
    } else {
      panel.webview.html = `<html><body style="padding:16px;font-family:sans-serif">正在加载会话遥测…</body></html>`;
    }

    panel.webview.onDidReceiveMessage(async (rawMsg) => {
      if (!rawMsg || typeof rawMsg !== 'object') return;
      const msg = rawMsg as Record<string, unknown>;
      if (msg.type === 'selectSession') {
        pinnedCascadeId = typeof msg.cascadeId === 'string' ? msg.cascadeId.trim() : '';
        lastPushedHtmlSig = '';
        await refreshTick(true);
      } else if (msg.type === 'refreshQuota') {
        await vscode.commands.executeCommand('agy-statusline.refreshQuota');
        void panel.webview.postMessage({ type: 'quotaRefreshed' });
      } else if (msg.type === 'openFile' && typeof msg.path === 'string' && msg.path) {
        try {
          const realPath = fs.realpathSync(msg.path);
          if (fs.statSync(realPath).isFile()) {
            await vscode.window.showTextDocument(vscode.Uri.file(realPath), {
              preview: true,
              viewColumn: vscode.ViewColumn.One
            });
          }
        } catch {
          void vscode.window.showWarningMessage(`无法打开文件: ${escapeHtml(String(msg.path))}`);
        }
      }
    });

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        void refreshTick(true);
      }
    });

    panel.onDidDispose(() => {
      if (activePanel === panel) {
        activePanel = null;
        lastPushedHtmlSig = '';
      }
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agy-statusline.openPanel', openInspectorPanel),
    vscode.commands.registerCommand('agy-statusline.selectSession', async () => {
      if (!lastPayload) await refreshTick(false);
      const candidates = lastPayload?.candidates ?? [];
      interface SessionPickItem extends vscode.QuickPickItem {
        cascadeId: string;
      }
      const items: SessionPickItem[] = [
        {
          label: '$(sync) 自动跟随当前工作区会话',
          description: !pinnedCascadeId ? '当前模式' : '',
          detail: '自动匹配当前打开工作区的活跃或最新 Antigravity 会话',
          cascadeId: ''
        },
        ...candidates.map((c) => ({
          label: `${c.activeNow ? '$(VmActive) ' : '$(comment-discussion) '}${c.title}`,
          description: `${c.matchedWorkspace ? '当前工作区 · ' : ''}${c.cascadeId.slice(0, 8)}`,
          detail: `${c.stepCount} 步${c.workspaceUris[0] ? ` · ${c.workspaceUris[0]}` : ''}`,
          cascadeId: c.cascadeId
        }))
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: '选择 AGY Statusline 监控会话',
        placeHolder: '选择自动跟随或固定到指定会话'
      });
      if (picked !== undefined) {
        pinnedCascadeId = picked.cascadeId;
        lastPushedHtmlSig = '';
        await refreshTick(true);
      }
    }),
    vscode.commands.registerCommand('agy-statusline.refreshQuota', async () => {
      const cliScript = resolveCliScriptPath(context.extensionPath, homedir);
      if (!cliScript) {
        void vscode.window.showWarningMessage('未找到 agy-statusline CLI 脚本，请先运行 agy-statusline install');
        return;
      }
      const nodeBin = resolveExternalNodeBinary(homedir);
      await new Promise<void>((resolve) => {
        execFile(
          nodeBin,
          ['--disable-warning=ExperimentalWarning', cliScript, 'quota', 'refresh', '--json'],
          { timeout: 25000, windowsHide: true },
          () => resolve()
        );
      });
      lastPushedHtmlSig = '';
      await refreshTick(true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      lastPushedHtmlSig = '';
      void refreshTick(true);
    })
  );

  void refreshTick(false);
  pollTimer = setInterval(() => {
    void refreshTick(false);
  }, 1500);

  context.subscriptions.push({
    dispose: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  });
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
