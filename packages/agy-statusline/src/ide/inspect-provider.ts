import os from 'node:os';
import path from 'node:path';
import {
  loadUserConfig,
  readHostPluginEnabled,
  resolveSeedQuotaCachePaths
} from '../core/config.js';
import {
  AUTO_COMPACT_PCT,
  CONTEXT_CATEGORY_SPECS,
  buildDashboardHtml,
  escapeHtml,
  fmtTok,
  formatContextCeiling,
  formatContextUsed,
  levelForPct,
  selectCacheRate
} from '../core/format.js';
import { buildAllQuotaPools, buildModelQuotaView, loadQuotaCache } from '../core/quota-store.js';
import {
  UUID_RE,
  discoverWorkspaceConversations,
  isSqliteAvailable,
  parseConversationMetrics
} from '../core/sqlite-metrics.js';
import type { IdeInspectPayload, SeverityLevel } from '../core/types.js';

export function collectIdeInspectPayload(opts: {
  homedir?: string;
  workspacePaths?: string[];
  pinnedCascadeId?: string;
  modelHint?: string;
  now?: Date;
} = {}): IdeInspectPayload {
  const homedir = opts.homedir ?? os.homedir();
  const now = opts.now ?? new Date();
  const workspacePaths = (opts.workspacePaths ?? []).filter(Boolean);
  const { config } = loadUserConfig(homedir);
  const hostPluginOn = readHostPluginEnabled(homedir);
  const enabled = config.enabled && config.ide.enabled && hostPluginOn;

  const { cache: quotaCache } = loadQuotaCache(resolveSeedQuotaCachePaths(homedir));
  const candidates = isSqliteAvailable()
    ? discoverWorkspaceConversations({
        homedir,
        channel: config.channel,
        workspacePaths,
        limit: 24
      })
    : [];

  let selectedCascadeId = '';
  let selectedTitle = '';
  let matchedWorkspace = false;
  let selectedChannel: 'stable' | 'insiders' = 'stable';

  const pinned = String(opts.pinnedCascadeId || '').trim().toLowerCase();
  if (pinned && UUID_RE.test(pinned)) {
    selectedCascadeId = pinned;
    const found = candidates.find((c) => c.cascadeId === pinned);
    if (found) {
      selectedTitle = found.title;
      matchedWorkspace = found.matchedWorkspace;
      selectedChannel = found.channel;
    } else {
      selectedTitle = `会话 ${pinned.slice(0, 8)}`;
    }
  } else if (workspacePaths.length > 0) {
    const bestWs = candidates.find((c) => c.matchedWorkspace);
    if (bestWs) {
      selectedCascadeId = bestWs.cascadeId;
      selectedTitle = bestWs.title;
      matchedWorkspace = true;
      selectedChannel = bestWs.channel;
    }
  } else if (candidates.length > 0 && candidates[0].activeNow) {
    selectedCascadeId = candidates[0].cascadeId;
    selectedTitle = candidates[0].title;
    matchedWorkspace = false;
    selectedChannel = candidates[0].channel;
  }

  let metrics = null;
  if (selectedCascadeId && isSqliteAvailable()) {
    const convDirs = [
      path.join(
        homedir,
        '.gemini',
        selectedChannel === 'insiders' ? 'antigravity-insiders' : 'antigravity',
        'conversations'
      ),
      path.join(
        homedir,
        '.gemini',
        selectedChannel === 'insiders' ? 'antigravity' : 'antigravity-insiders',
        'conversations'
      )
    ];
    metrics = parseConversationMetrics(selectedCascadeId, convDirs, {
      contextLimit: config.contextLimit,
      contextLimitOverride: config.contextLimitOverride,
      homedir
    });
  }

  const effectiveModelLabel =
    metrics?.activeModelDisplay || metrics?.activeModelId || opts.modelHint || 'Gemini';
  const quotaView = buildModelQuotaView(quotaCache, effectiveModelLabel, undefined, now);
  const quotaPools = buildAllQuotaPools(quotaCache, effectiveModelLabel, undefined, now);
  const dashboardHtml = buildDashboardHtml(metrics, quotaPools, { richPanelMode: true });

  return {
    ok: true,
    timestamp: now.toISOString(),
    enabled,
    selectedCascadeId,
    selectedTitle,
    matchedWorkspace,
    candidates,
    metrics,
    quotaView,
    quotaPools,
    dashboardHtml,
    config
  };
}

export function formatIdeStatusBarDisplay(payload: IdeInspectPayload): {
  text: string;
  severity: SeverityLevel;
  markdownTooltip: string;
} {
  const { metrics, quotaView, config } = payload;
  const hasMetrics = Boolean(metrics && metrics.hasData);
  const hasQuota = Boolean(quotaView && quotaView.hasQuota && quotaView.windows.length > 0);

  let maxSeverity: SeverityLevel = 'ok';
  const bumpSeverity = (lvl: SeverityLevel) => {
    if (lvl === 'crit') maxSeverity = 'crit';
    else if (lvl === 'warn' && maxSeverity === 'ok') maxSeverity = 'warn';
  };

  const leftTokens: string[] = [];
  if (hasMetrics && metrics) {
    const ctxPct = Math.round(metrics.ctxPct);
    bumpSeverity(levelForPct(ctxPct));
    const cacheRate = Math.round(selectCacheRate(metrics, config));
    const tpsVal = Math.max(0, Math.round(metrics.tps || 0));

    if (metrics.isOrchestrator) {
      const pTag = metrics.orchestratorPhase === 'exec' ? 'Exec' : 'Plan';
      const mTag = metrics.activeShortModel || 'Carbon';
      leftTokens.push(`$(layers) Orch·${mTag} ${pTag}`);
    } else if (metrics.activeShortModel) {
      const eff = metrics.activeEffort ? ` ${metrics.activeEffort}` : '';
      leftTokens.push(`$(pulse) ${metrics.activeShortModel}${eff}`);
    } else {
      leftTokens.push('$(pulse) AGY');
    }

    leftTokens.push(`Ctx ${ctxPct}%`);
    leftTokens.push(`Cache ${cacheRate}%`);
    if (tpsVal > 0) leftTokens.push(`${tpsVal} tok/s`);
    if (metrics.subagentCount > 0) leftTokens.push(`+${metrics.subagentCount} sub`);
  }

  const rightTokens: string[] = [];
  if (hasQuota) {
    for (const w of quotaView.windows) {
      bumpSeverity(levelForPct(w.usedPct));
      const cd = !hasMetrics && w.resetCountdown ? ` ${w.resetCountdown}` : '';
      rightTokens.push(`${w.label} ${w.usedPct}%${cd}`);
    }
  }

  let text = '$(dashboard) AGY';
  if (leftTokens.length > 0 && rightTokens.length > 0) {
    text = `${leftTokens.join(' · ')} │ ${rightTokens.join(' · ')}`;
  } else if (leftTokens.length > 0) {
    text = leftTokens.join(' · ');
  } else if (rightTokens.length > 0) {
    text = `$(dashboard) AGY ${rightTokens.join(' · ')}`;
  }

  // Build clean VS Code MarkdownString tooltip
  const mdLines: string[] = [];
  if (hasMetrics && metrics) {
    const usedStr = formatContextUsed(metrics.ctxTokens);
    const limitStr = formatContextCeiling(metrics.contextLimitTokens);
    const compactTokens = Math.round(metrics.contextLimitTokens * (AUTO_COMPACT_PCT / 100));
    const titlePart = payload.selectedTitle ? ` — ${payload.selectedTitle}` : '';
    mdLines.push(`**AGY 会话遥测${titlePart}**  *(Gen #${metrics.lastGenIdx + 1})*`);
    mdLines.push('');
    const compactBadge =
      (metrics.compactionCount || 0) > 0
        ? ` · 已压缩 ${metrics.compactionCount} 次 (省 ${formatContextUsed(metrics.compactionSavedTokens || 0)})`
        : '';
    mdLines.push(
      `- **上下文窗口**：\`[${usedStr}/${limitStr}]\` **${Math.round(metrics.ctxPct)}%** · 余 \`${formatContextUsed(metrics.remainCtxTokens)}\` *(压缩点 ${AUTO_COMPACT_PCT}% ~${formatContextUsed(compactTokens)}${compactBadge})*`
    );

    if (metrics.ctxDetail) {
      const cats = metrics.ctxDetail.categories;
      const topCats = CONTEXT_CATEGORY_SPECS.filter((s) => (cats[s.key] || 0) > 0)
        .map((s) => `${s.label} \`${formatContextUsed(cats[s.key])}\``)
        .slice(0, 6);
      if (topCats.length > 0) {
        mdLines.push(`- **上下文构成**：${topCats.join(' · ')}`);
      }
      if (metrics.ctxDetail.deferred.totalTokens > 0) {
        mdLines.push(
          `- **按需懒加载已省**：\`${formatContextUsed(metrics.ctxDetail.deferred.totalTokens)}\` *(0 活跃占用)*`
        );
      }
    }

    const combinedOut = Math.max(0, (metrics.totalOut || 0) + (metrics.subagentOut || 0));
    mdLines.push(
      `- **速率与缓存**：\`${metrics.tps.toFixed(1)} tok/s\` · TTFT \`${metrics.ttft.toFixed(2)}s\` · Cache \`${metrics.lastCacheRate.toFixed(1)}% / ${metrics.sessionCacheRate.toFixed(1)}%\` · 累计输出 \`${fmtTok(combinedOut)}\``
    );
  } else {
    mdLines.push('**AGY Statusline** *(当前工作区暂无活跃会话)*');
  }

  if (hasQuota) {
    mdLines.push('');
    const qParts = quotaView.windows.map((w) => {
      const cd = w.resetCountdown ? ` (${w.resetCountdown})` : '';
      return `**${w.label}** \`${w.usedPct}%\` 余${w.remainingPct}%${cd}`;
    });
    mdLines.push(`- **账户配额 (${quotaView.poolLabel})**：${qParts.join(' · ')}`);
  }

  mdLines.push('');
  mdLines.push('---');
  mdLines.push(
    '[$(graph) 打开详细面板](command:agy-statusline.openPanel) &nbsp;·&nbsp; ' +
      '[$(list-selection) 切换会话](command:agy-statusline.selectSession) &nbsp;·&nbsp; ' +
      '[$(refresh) 刷新配额](command:agy-statusline.refreshQuota)'
  );

  return {
    text,
    severity: maxSeverity,
    markdownTooltip: mdLines.join('\n')
  };
}

export function buildIdeWebviewOptionsHtml(payload: IdeInspectPayload, pinnedCascadeId: string): string {
  const autoSelected = !pinnedCascadeId ? ' selected' : '';
  const autoDesc = payload.matchedWorkspace && payload.selectedTitle
    ? `自动跟随当前工作区 (${escapeHtml(payload.selectedTitle)})`
    : '自动跟随当前工作区最新会话';
  const opts: string[] = [`<option value=""${autoSelected}>${autoDesc}</option>`];

  for (const c of payload.candidates) {
    const sel = pinnedCascadeId && c.cascadeId === pinnedCascadeId ? ' selected' : '';
    const wsTag = c.matchedWorkspace ? '[当前工作区] ' : '';
    const liveTag = c.activeNow ? '● ' : '';
    const label = `${liveTag}${wsTag}${c.title} (${c.cascadeId.slice(0, 8)})`;
    opts.push(`<option value="${escapeHtml(c.cascadeId)}"${sel}>${escapeHtml(label)}</option>`);
  }
  return opts.join('');
}

export function buildIdeWebviewDocument(
  payload: IdeInspectPayload,
  capsuleCss: string,
  pinnedCascadeId: string = ''
): string {
  const optionsHtml = buildIdeWebviewOptionsHtml(payload, pinnedCascadeId);
  const emptyHint =
    !payload.metrics || !payload.metrics.hasData
      ? `<div class="ag-sl-wv-empty">当前工作区暂未匹配到进行中的对话，可在上方下拉框手动选择历史会话查看上下文拆分。</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AGY Context &amp; Quota</title>
  <style>
    ${capsuleCss}
    body {
      margin: 0;
      padding: 14px 16px 24px;
      background: var(--vscode-editor-background, var(--background, #14151B));
      color: var(--vscode-foreground, var(--foreground, #E5E7EB));
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      --card: var(--vscode-editorWidget-background, #1B1D24);
      --foreground: var(--vscode-foreground, #E5E7EB);
      --muted-foreground: var(--vscode-descriptionForeground, #9CA3AF);
      --border: var(--vscode-widget-border, rgba(128, 128, 128, 0.22));
    }
    body.vscode-light {
      --card: var(--vscode-editorWidget-background, #FAF8F5);
      --foreground: var(--vscode-foreground, #1F1E1D);
      --muted-foreground: var(--vscode-descriptionForeground, #6B7280);
    }
    .ag-sl-wv-shell {
      max-width: 720px;
      margin: 0 auto;
    }
    .ag-sl-wv-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .ag-sl-wv-select {
      flex: 1 1 240px;
      min-width: 0;
      height: 28px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--vscode-dropdown-background, var(--card));
      color: var(--vscode-dropdown-foreground, var(--foreground));
      font-size: 12px;
      outline: none;
    }
    .ag-sl-wv-btn {
      height: 28px;
      padding: 0 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.14));
      color: var(--vscode-button-secondaryForeground, var(--foreground));
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .ag-sl-wv-btn:hover {
      filter: brightness(1.1);
    }
    .ag-sl-wv-empty {
      margin-bottom: 10px;
      padding: 8px 11px;
      border-radius: 7px;
      border: 1px dashed var(--border);
      color: var(--muted-foreground);
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <div class="ag-sl-wv-shell">
    <div class="ag-sl-wv-bar">
      <select id="ag-sl-session-select" class="ag-sl-wv-select" aria-label="选择会话">${optionsHtml}</select>
      <button id="ag-sl-refresh-quota" type="button" class="ag-sl-wv-btn">刷新 5h/7d 配额</button>
    </div>
    <div id="ag-sl-empty-wrap">${emptyHint}</div>
    <div id="ag-statusline-tooltip" class="ag-sl-webview-card" data-visible="1">${payload.dashboardHtml}</div>
  </div>
  <script>
    (function() {
      const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
      const root = document.getElementById('ag-statusline-tooltip');
      const selectEl = document.getElementById('ag-sl-session-select');
      const refreshBtn = document.getElementById('ag-sl-refresh-quota');
      const emptyWrap = document.getElementById('ag-sl-empty-wrap');

      let viewMode = 'bar';
      let selectedPool = null;
      let hoverCat = null;
      const expandedGroups = new Set();

      function syncInteractiveState() {
        if (!root) return;
        root.querySelectorAll('[data-ag-sl-ctx-view]').forEach((btn) => {
          btn.setAttribute('data-active', btn.getAttribute('data-ag-sl-ctx-view') === viewMode ? '1' : '0');
        });
        root.querySelectorAll('[data-ag-sl-view-panel]').forEach((p) => {
          p.setAttribute('data-active', p.getAttribute('data-ag-sl-view-panel') === viewMode ? '1' : '0');
        });
        root.querySelectorAll('[data-ag-sl-expand]').forEach((row) => {
          const g = row.getAttribute('data-ag-sl-expand') || '';
          row.setAttribute('data-open', expandedGroups.has(g) ? '1' : '0');
        });
        root.querySelectorAll('[data-ag-sl-sub-for]').forEach((sub) => {
          const g = sub.getAttribute('data-ag-sl-sub-for') || '';
          sub.setAttribute('data-open', expandedGroups.has(g) ? '1' : '0');
        });

        const panels = root.querySelectorAll('.ag-sl-pool-panel');
        if (panels.length > 0) {
          let pid = selectedPool || '';
          if (!pid || !root.querySelector('.ag-sl-pool-panel[data-ag-sl-pool-panel="' + pid + '"]')) {
            const sec = root.querySelector('.ag-sl-quota-section');
            pid = (sec && sec.getAttribute('data-ag-sl-default-pool')) || panels[0].getAttribute('data-ag-sl-pool-panel') || '';
          }
          root.querySelectorAll('.ag-sl-pool-tab').forEach((btn) => {
            btn.setAttribute('data-active', btn.getAttribute('data-ag-sl-pool-tab') === pid ? '1' : '0');
          });
          panels.forEach((p) => {
            p.setAttribute('data-active', p.getAttribute('data-ag-sl-pool-panel') === pid ? '1' : '0');
          });
        }
        applyHover(hoverCat);
      }

      function applyHover(catKey) {
        hoverCat = catKey;
        if (!root) return;
        root.querySelectorAll('.ag-sl-seg[data-ag-sl-cat], .ag-sl-grid-cell[data-ag-sl-cat]').forEach((el) => {
          if (!catKey) {
            el.removeAttribute('data-hot');
            el.removeAttribute('data-dim');
          } else if (el.getAttribute('data-ag-sl-cat') === catKey) {
            el.setAttribute('data-hot', '1');
            el.removeAttribute('data-dim');
          } else {
            el.removeAttribute('data-hot');
            el.setAttribute('data-dim', '1');
          }
        });
        root.querySelectorAll('.ag-sl-cat-row[data-ag-sl-cat]').forEach((el) => {
          if (catKey && el.getAttribute('data-ag-sl-cat') === catKey) el.setAttribute('data-hot', '1');
          else el.removeAttribute('data-hot');
        });
      }

      selectEl?.addEventListener('change', () => {
        vscode?.postMessage({ type: 'selectSession', cascadeId: selectEl.value || '' });
      });

      refreshBtn?.addEventListener('click', () => {
        refreshBtn.textContent = '正在刷新…';
        vscode?.postMessage({ type: 'refreshQuota' });
      });

      root?.addEventListener('mouseover', (ev) => {
        const el = ev.target?.closest?.('[data-ag-sl-cat]');
        const next = el && root.contains(el) ? el.getAttribute('data-ag-sl-cat') : null;
        if (next !== hoverCat) applyHover(next);
      });
      root?.addEventListener('mouseleave', () => applyHover(null));

      root?.addEventListener('click', (ev) => {
        const openBtn = ev.target?.closest?.('[data-ag-sl-open-file]');
        if (openBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          vscode?.postMessage({ type: 'openFile', path: openBtn.getAttribute('data-ag-sl-open-file') });
          return;
        }
        const viewBtn = ev.target?.closest?.('[data-ag-sl-ctx-view]');
        if (viewBtn) {
          ev.preventDefault();
          const v = viewBtn.getAttribute('data-ag-sl-ctx-view');
          if (v === 'bar' || v === 'grid') {
            viewMode = v;
            syncInteractiveState();
          }
          return;
        }
        const expandRow = ev.target?.closest?.('[data-ag-sl-expand]');
        if (expandRow) {
          ev.preventDefault();
          const grp = expandRow.getAttribute('data-ag-sl-expand');
          if (grp) {
            if (expandedGroups.has(grp)) expandedGroups.delete(grp);
            else expandedGroups.add(grp);
            syncInteractiveState();
          }
          return;
        }
        const tabBtn = ev.target?.closest?.('[data-ag-sl-pool-tab]');
        if (tabBtn) {
          ev.preventDefault();
          selectedPool = tabBtn.getAttribute('data-ag-sl-pool-tab');
          syncInteractiveState();
        }
      });

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'quotaRefreshed' && refreshBtn) {
          refreshBtn.textContent = '刷新 5h/7d 配额';
        }
        if (msg.type === 'update' && root) {
          const openSecs = new Set(
            Array.from(root.querySelectorAll('details.ag-sl-acc[open]')).map((d) => d.getAttribute('data-ag-sl-sec'))
          );
          if (typeof msg.optionsHtml === 'string' && selectEl && document.activeElement !== selectEl) {
            selectEl.innerHTML = msg.optionsHtml;
          }
          if (emptyWrap && typeof msg.emptyHint === 'string') {
            emptyWrap.innerHTML = msg.emptyHint;
          }
          if (typeof msg.dashboardHtml === 'string' && root.innerHTML !== msg.dashboardHtml) {
            root.innerHTML = msg.dashboardHtml;
            root.querySelectorAll('details.ag-sl-acc').forEach((d) => {
              const sec = d.getAttribute('data-ag-sl-sec');
              if (openSecs.size > 0) d.open = openSecs.has(sec);
            });
          }
          syncInteractiveState();
        }
      });

      syncInteractiveState();
    })();
  </script>
</body>
</html>`;
}
