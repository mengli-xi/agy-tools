import { formatLocalResetTime } from './quota-store.js';
import { classifyModelMetadata } from './sqlite-metrics.js';
import type {
  AppRenderItem,
  ContextCategoryKey,
  ContextDetailBreakdown,
  MetricTone,
  ModelQuotaView,
  QuotaPoolTabView,
  SessionMetrics,
  SeverityLevel,
  UserConfig
} from './types.js';

export function levelForPct(pct: number): SeverityLevel {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

export function toneForUsagePct(pct: number): MetricTone {
  if (!Number.isFinite(pct)) return 'dim';
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  if (pct >= 50) return 'mid';
  return 'good';
}

export function toneForCachePct(pct: number): MetricTone {
  if (!Number.isFinite(pct)) return 'dim';
  if (pct >= 80) return 'good';
  if (pct >= 40) return 'info';
  return 'warn';
}

export function toneForTps(tps: number): MetricTone {
  if (!Number.isFinite(tps) || tps <= 0) return 'dim';
  if (tps >= 100) return 'info';
  if (tps >= 40) return 'good';
  return 'mid';
}

export function toneForTtft(sec: number): MetricTone {
  if (!Number.isFinite(sec) || sec <= 0) return 'dim';
  if (sec > 6) return 'warn';
  if (sec > 2.5) return 'mid';
  return 'good';
}

export function fmtTok(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString('en-US');
}

export function formatContextUsed(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(2))}M`;
  }
  if (n >= 1000) {
    return `${Number((n / 1000).toFixed(1))}k`;
  }
  return String(Math.round(n));
}

export function formatContextCeiling(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '--';
  if (tokens === 1_048_576 || tokens === 1_000_000) return '1M';
  if (tokens === 524_288 || tokens === 512_000) return '512k';
  if (tokens === 262_144 || tokens === 256_000) return '256k';
  if (tokens === 131_072 || tokens === 128_000) return '128k';
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function selectCacheRate(metrics: SessionMetrics, config: UserConfig): number {
  return config.cacheRateMode === 'session' ? metrics.sessionCacheRate : metrics.lastCacheRate;
}

function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

export const AUTO_COMPACT_PCT = 85;

interface CategorySpec {
  key: ContextCategoryKey;
  label: string;
  cls: string;
  expandGroup?: 'agent' | 'tools';
}

export const CONTEXT_CATEGORY_SPECS: readonly CategorySpec[] = [
  { key: 'messages', label: '用户提问', cls: 'ag-sl-seg-user' },
  { key: 'agentResponses', label: '模型回复', cls: 'ag-sl-seg-model', expandGroup: 'agent' },
  { key: 'toolCalls', label: '工具调用', cls: 'ag-sl-seg-tcall', expandGroup: 'tools' },
  { key: 'systemPrompt', label: '系统提示词', cls: 'ag-sl-seg-sys' },
  { key: 'systemTools', label: '内置工具定义', cls: 'ag-sl-seg-tdef' },
  { key: 'mcpTools', label: 'MCP 工具定义', cls: 'ag-sl-seg-mcp' },
  { key: 'mcpInstructions', label: 'MCP 服务指令', cls: 'ag-sl-seg-mcpi' },
  { key: 'rulesFiles', label: '规则与记忆', cls: 'ag-sl-seg-rules' },
  { key: 'skills', label: 'Skills 技能', cls: 'ag-sl-seg-skills' },
  { key: 'customAgents', label: '子 Agent 与插件', cls: 'ag-sl-seg-agents' },
  { key: 'systemMessages', label: '系统消息', cls: 'ag-sl-seg-sysmsg' },
  { key: 'checkpointBuffer', label: '压缩摘要缓冲', cls: 'ag-sl-seg-compact' }
];

const CHEVRON_SVG =
  '<svg class="ag-sl-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.25 2.5L7.75 6L4.25 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const OPEN_FILE_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.5 3.5H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5M9.5 3H13v3.5M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function synthesizeFallbackDetail(metrics: SessionMetrics): ContextDetailBreakdown | null {
  if (metrics.ctxDetail) return metrics.ctxDetail;
  if (!metrics.hasCtxBreakdown) return null;

  const rawSys = Math.max(0, metrics.ctxBreakdownSys || 0);
  const rawTDef = Math.max(0, metrics.ctxBreakdownToolDefs || 0);
  const rawTCall = Math.max(0, metrics.ctxBreakdownToolCalls || 0);
  const rawModel = Math.max(0, metrics.ctxBreakdownModel || 0);
  const rawUser = Math.max(0, metrics.ctxBreakdownUser || 0);
  const rawParts = [rawSys, rawTDef, rawTCall, rawModel, rawUser];
  const rawSum = Math.max(1, rawSys + rawTDef + rawTCall + rawModel + rawUser);
  const scale = metrics.ctxTokens > 0 ? metrics.ctxTokens / rawSum : 1;
  const scaled = rawParts.map((v) => (v > 0 ? Math.round(v * scale) : 0));
  const scaledSum = scaled.reduce((a, b) => a + b, 0);
  if (metrics.ctxTokens > 0 && scaledSum !== metrics.ctxTokens) {
    let maxIdx = 0;
    for (let i = 1; i < rawParts.length; i++) {
      if (rawParts[i] > rawParts[maxIdx]) maxIdx = i;
    }
    scaled[maxIdx] = Math.max(0, scaled[maxIdx] + (metrics.ctxTokens - scaledSum));
  }
  const [sysTok, tdefTok, tcallTok, modelTok, userTok] = scaled;
  const thinkWeight = Math.max(0, metrics.totalThink || metrics.lastThinkTok || 0);
  const respWeight = Math.max(0, metrics.totalResp || metrics.lastRespTok || 0);
  const agentThinking =
    thinkWeight + respWeight > 0 ? Math.round((modelTok * thinkWeight) / (thinkWeight + respWeight)) : 0;
  const agentReplies = Math.max(0, modelTok - agentThinking);

  return {
    exactFromSqlite: true,
    categories: {
      messages: userTok,
      agentResponses: modelTok,
      agentReplies,
      agentThinking,
      toolCalls: tcallTok,
      toolCallOutputs: tcallTok,
      toolCallArgs: 0,
      mcpTools: 0,
      mcpInstructions: 0,
      systemTools: tdefTok,
      systemPrompt: sysTok,
      rulesFiles: 0,
      skills: 0,
      customAgents: 0,
      systemMessages: 0,
      checkpointBuffer: 0
    },
    sinceLastCacheTokens: Math.max(0, metrics.lastInTok || 0),
    freeTokens: Math.max(0, metrics.remainCtxTokens || 0),
    deferred: { mcpTokens: 0, skillsTokens: 0, rulesTokens: 0, totalTokens: 0 },
    compaction: {
      count: metrics.compactionCount || 0,
      totalSavedTokens: metrics.compactionSavedTokens || 0,
      lastBeforeTokens: 0,
      lastAfterTokens: 0
    },
    heavyToolCalls: [],
    totalToolCalls: 0,
    mcpServers: [],
    rules: [],
    skills: [],
    turnsHistory: [],
    workspaceUris: []
  };
}

export function buildContextRingSvg(pct: number, tone: MetricTone): string {
  const circ = 36.13;
  const clamped = Math.max(0, Math.min(100, pct));
  const rawDash = (clamped / 100) * circ;
  const dash = clamped > 0 ? Math.max(1.9, rawDash) : 0;
  return (
    `<svg class="ag-sl-ctx-ring" viewBox="0 0 16 16" aria-hidden="true">` +
      `<circle class="ag-sl-ring-track" cx="8" cy="8" r="5.75"></circle>` +
      `<circle class="ag-sl-ring-fill ag-sl-tone-${tone}" cx="8" cy="8" r="5.75" stroke-dasharray="${dash.toFixed(2)} ${circ}" transform="rotate(-90 8 8)"></circle>` +
    `</svg>`
  );
}

function fmtSharePct(tokens: number, limitTokens: number): string {
  if (limitTokens <= 0 || tokens <= 0) return '0.0%';
  const p = (tokens / limitTokens) * 100;
  return p >= 10 ? `${p.toFixed(1)}%` : `${p.toFixed(1)}%`;
}

export interface DashboardRenderOptions {
  richPanelMode?: boolean;
}

export function buildDashboardHtml(
  metrics: SessionMetrics | null,
  effectivePools: QuotaPoolTabView[],
  options: DashboardRenderOptions = {}
): string {
  const hasMetrics = Boolean(metrics && metrics.hasData);
  const richPanel = Boolean(options.richPanelMode);
  const tooltipSections: string[] = [];

  if (hasMetrics && metrics) {
    const ctxPct = Math.round(clampPercent(metrics.ctxPct));
    const ctxTone = toneForUsagePct(ctxPct);
    const cacheTone = toneForCachePct(metrics.lastCacheRate);
    const tpsTone = toneForTps(metrics.tps || 0);
    const ttftTone = toneForTtft(metrics.ttft || 0);
    const usedStr = formatContextUsed(metrics.ctxTokens);
    const limitStr = formatContextCeiling(metrics.contextLimitTokens);
    const combinedOut = Math.max(0, (metrics.totalOut || 0) + (metrics.subagentOut || 0));

    let modelChipHtml = '';
    if (metrics.isOrchestrator) {
      const pLabel = metrics.orchestratorPhase === 'exec' ? 'Exec' : 'Plan';
      const pCls = metrics.orchestratorPhase === 'exec' ? 'ag-sl-orch-exec' : 'ag-sl-orch-plan';
      const mTag = metrics.activeShortModel || (metrics.orchestratorPhase === 'exec' ? 'Hydrogen' : 'Carbon');
      modelChipHtml = `<div class="ag-sl-tt-model-tag"><span class="ag-sl-orch ${pCls}">${pLabel} · ${escapeHtml(mTag)}</span></div>`;
    } else if (metrics.activeShortModel) {
      const eff = metrics.activeEffort ? ` · ${escapeHtml(metrics.activeEffort)}` : '';
      modelChipHtml = `<div class="ag-sl-tt-model-tag"><span class="ag-sl-tt-chip">${escapeHtml(metrics.activeShortModel)}${eff}</span></div>`;
    }

    tooltipSections.push(
      `<div class="ag-sl-tt-top">` +
        `<div class="ag-sl-tt-title-group">` +
          `<span class="ag-sl-tt-title">会话遥测</span>` +
          `<span class="ag-sl-badge">Gen #${metrics.lastGenIdx + 1}</span>` +
          `<span class="ag-sl-tt-meta">${metrics.userTurns} 轮提问 · ${metrics.validCalls} 次调用</span>` +
        `</div>` +
        modelChipHtml +
      `</div>`
    );

    const limitTokens = Math.max(1, metrics.contextLimitTokens || 256000);
    const barDenom = Math.max(limitTokens, metrics.ctxTokens, 1);
    const compactTokens = Math.round(limitTokens * (AUTO_COMPACT_PCT / 100));
    const compactLabelStr = formatContextUsed(compactTokens);
    const detail = synthesizeFallbackDetail(metrics);

    if (detail) {
      const cats = detail.categories;
      const activeSpecs = CONTEXT_CATEGORY_SPECS.filter((s) => (cats[s.key] || 0) > 0);

      // 1. Segmented bar
      let segBarInner = '';
      let usedWidth = 0;
      for (const spec of activeSpecs) {
        const tok = cats[spec.key] || 0;
        if (tok <= 0) continue;
        const w = Math.min(100 - usedWidth, Math.max(0.45, (tok / barDenom) * 100));
        if (w <= 0) continue;
        usedWidth += w;
        const title = `${spec.label}: ${formatContextUsed(tok)} (${fmtSharePct(tok, limitTokens)})`;
        segBarInner += `<span class="ag-sl-seg ${spec.cls}" data-ag-sl-cat="${spec.key}" style="width:${w.toFixed(2)}%" title="${escapeHtml(title)}"></span>`;
      }

      // 2. 10x10 Grid (100 cells = 1% each)
      const totalCells = 100;
      const cellsHtml: string[] = [];
      for (const spec of activeSpecs) {
        const tok = cats[spec.key] || 0;
        const count = Math.max(tok > 0 ? 1 : 0, Math.round((tok / barDenom) * totalCells));
        const title = `${spec.label}: ${formatContextUsed(tok)} (${fmtSharePct(tok, limitTokens)})`;
        for (let i = 0; i < count && cellsHtml.length < totalCells; i++) {
          const isCompactCell = cellsHtml.length === AUTO_COMPACT_PCT - 1;
          cellsHtml.push(
            `<span class="ag-sl-grid-cell ${spec.cls}${isCompactCell ? ' ag-sl-grid-compact' : ''}" data-ag-sl-cat="${spec.key}" title="${escapeHtml(title)}"></span>`
          );
        }
      }
      while (cellsHtml.length < totalCells) {
        const isCompactCell = cellsHtml.length === AUTO_COMPACT_PCT - 1;
        const freeTitle = isCompactCell
          ? `自动压缩点 ~${AUTO_COMPACT_PCT}% (${compactLabelStr})`
          : `剩余空间: ${formatContextUsed(detail.freeTokens)}`;
        cellsHtml.push(
          `<span class="ag-sl-grid-cell ag-sl-grid-free${isCompactCell ? ' ag-sl-grid-compact' : ''}" title="${escapeHtml(freeTitle)}"></span>`
        );
      }

      // 3. Interactive category breakdown rows + inline expandable sub-rows
      const catRowsHtml: string[] = [];
      for (const spec of activeSpecs) {
        const tok = cats[spec.key] || 0;
        const isExpandable =
          (spec.expandGroup === 'agent' && (cats.agentReplies > 0 || cats.agentThinking > 0)) ||
          (spec.expandGroup === 'tools' &&
            (cats.toolCallOutputs > 0 || cats.toolCallArgs > 0 || detail.heavyToolCalls.length > 0));
        const expandAttrs = isExpandable
          ? ` data-ag-sl-expand="${spec.expandGroup}" data-open="0" role="button" tabindex="0"`
          : '';
        catRowsHtml.push(
          `<div class="ag-sl-cat-row${isExpandable ? ' ag-sl-cat-clickable' : ''}" data-ag-sl-cat="${spec.key}"${expandAttrs}>` +
            `<span class="ag-sl-dot ${spec.cls}"></span>` +
            `<span class="ag-sl-cat-lbl">${escapeHtml(spec.label)}${isExpandable ? CHEVRON_SVG : ''}</span>` +
            `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(tok))}</span>` +
            `<span class="ag-sl-cat-pct ag-sl-mono">${escapeHtml(fmtSharePct(tok, limitTokens))}</span>` +
          `</div>`
        );

        if (spec.expandGroup === 'agent' && isExpandable) {
          catRowsHtml.push(
            `<div class="ag-sl-cat-subs" data-ag-sl-sub-for="agent" data-open="0">` +
              `<div class="ag-sl-cat-row ag-sl-cat-sub" data-ag-sl-cat="agentResponses">` +
                `<span class="ag-sl-dot ${spec.cls} ag-sl-dot-sub"></span>` +
                `<span class="ag-sl-cat-lbl">正文回复</span>` +
                `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(cats.agentReplies))}</span>` +
                `<span class="ag-sl-cat-pct ag-sl-mono">${escapeHtml(fmtSharePct(cats.agentReplies, limitTokens))}</span>` +
              `</div>` +
              `<div class="ag-sl-cat-row ag-sl-cat-sub" data-ag-sl-cat="agentResponses">` +
                `<span class="ag-sl-dot ${spec.cls} ag-sl-dot-sub"></span>` +
                `<span class="ag-sl-cat-lbl">思考推理</span>` +
                `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(cats.agentThinking))}</span>` +
                `<span class="ag-sl-cat-pct ag-sl-mono">${escapeHtml(fmtSharePct(cats.agentThinking, limitTokens))}</span>` +
              `</div>` +
            `</div>`
          );
        }

        if (spec.expandGroup === 'tools' && isExpandable) {
          const topHeavyInline = detail.heavyToolCalls
            .slice(0, 4)
            .map((hc) => {
              const openBtn =
                richPanel && hc.path
                  ? `<button type="button" class="ag-sl-open-btn" data-ag-sl-open-file="${escapeHtml(hc.path)}" title="在编辑器中打开">${OPEN_FILE_SVG}</button>`
                  : '';
              return (
                `<div class="ag-sl-cat-row ag-sl-cat-sub ag-sl-heavy-sub" data-ag-sl-cat="toolCalls">` +
                  `<span class="ag-sl-heavy-name" title="${escapeHtml(hc.label)}">${escapeHtml(hc.label)}</span>` +
                  `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(hc.tokens))}${openBtn}</span>` +
                `</div>`
              );
            })
            .join('');

          catRowsHtml.push(
            `<div class="ag-sl-cat-subs" data-ag-sl-sub-for="tools" data-open="0">` +
              `<div class="ag-sl-cat-row ag-sl-cat-sub" data-ag-sl-cat="toolCalls">` +
                `<span class="ag-sl-dot ${spec.cls} ag-sl-dot-sub"></span>` +
                `<span class="ag-sl-cat-lbl">工具返回</span>` +
                `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(cats.toolCallOutputs))}</span>` +
                `<span class="ag-sl-cat-pct ag-sl-mono">${escapeHtml(fmtSharePct(cats.toolCallOutputs, limitTokens))}</span>` +
              `</div>` +
              (cats.toolCallArgs > 0
                ? `<div class="ag-sl-cat-row ag-sl-cat-sub" data-ag-sl-cat="toolCalls">` +
                    `<span class="ag-sl-dot ${spec.cls} ag-sl-dot-sub"></span>` +
                    `<span class="ag-sl-cat-lbl">调用参数</span>` +
                    `<span class="ag-sl-cat-tok ag-sl-mono">${escapeHtml(formatContextUsed(cats.toolCallArgs))}</span>` +
                    `<span class="ag-sl-cat-pct ag-sl-mono">${escapeHtml(fmtSharePct(cats.toolCallArgs, limitTokens))}</span>` +
                  `</div>`
                : '') +
              topHeavyInline +
            `</div>`
          );
        }
      }

      const compactPillHtml =
        detail.compaction.count > 0
          ? `<span class="ag-sl-compacted-pill" title="累计自动/手动压缩 ${detail.compaction.count} 次，释放约 ${escapeHtml(formatContextUsed(detail.compaction.totalSavedTokens))} 上下文">已压缩 ${detail.compaction.count} 次${detail.compaction.totalSavedTokens > 0 ? ` · 省 ${escapeHtml(formatContextUsed(detail.compaction.totalSavedTokens))}` : ''}</span>`
          : '';

      const viewToggleHtml =
        `<span class="ag-sl-view-switch" role="group" aria-label="上下文视图切换">` +
          `<button type="button" class="ag-sl-view-btn" data-ag-sl-ctx-view="bar" data-active="1">条形</button>` +
          `<button type="button" class="ag-sl-view-btn" data-ag-sl-ctx-view="grid" data-active="0">网格</button>` +
        `</span>`;

      const deferredParts: string[] = [];
      if (detail.deferred.mcpTokens > 0) deferredParts.push(`MCP ${formatContextUsed(detail.deferred.mcpTokens)}`);
      if (detail.deferred.skillsTokens > 0) deferredParts.push(`Skills ${formatContextUsed(detail.deferred.skillsTokens)}`);
      if (detail.deferred.rulesTokens > 0) deferredParts.push(`Rules ${formatContextUsed(detail.deferred.rulesTokens)}`);
      const deferredSummaryHtml =
        detail.deferred.totalTokens > 0
          ? `<span class="ag-sl-ctx-deferred" title="按需渐进加载（未读入当前上下文，0 活跃 Token 占用）：${escapeHtml(deferredParts.join(' · '))}">懒加载省 ${escapeHtml(formatContextUsed(detail.deferred.totalTokens))} (${escapeHtml(deferredParts.join(' · '))})</span>`
          : '';

      tooltipSections.push(
        `<div class="ag-sl-ctx-block">` +
          `<div class="ag-sl-ctx-head">` +
            `<span class="ag-sl-ctx-title-wrap">` +
              `<span class="ag-sl-tt-lbl">上下文窗口</span>` +
              `<span class="ag-sl-compact-tag">压缩点 ${AUTO_COMPACT_PCT}% (~${escapeHtml(compactLabelStr)})</span>` +
              compactPillHtml +
            `</span>` +
            `<span class="ag-sl-ctx-nums">` +
              `<span class="ag-sl-mono">[${escapeHtml(usedStr)}/${escapeHtml(limitStr)}]</span>` +
              `<span class="ag-sl-tone-${ctxTone} ag-sl-bold">${ctxPct}%</span>` +
              viewToggleHtml +
            `</span>` +
          `</div>` +
          `<div class="ag-sl-ctx-vis" data-ag-sl-view-panel="bar" data-active="1">` +
            `<div class="ag-sl-prog ag-sl-prog-seg">` +
              segBarInner +
              `<i class="ag-sl-compact-tick" style="left:${AUTO_COMPACT_PCT}%" title="自动压缩点 ~${AUTO_COMPACT_PCT}% (${escapeHtml(compactLabelStr)})"></i>` +
            `</div>` +
          `</div>` +
          `<div class="ag-sl-ctx-vis" data-ag-sl-view-panel="grid" data-active="0">` +
            `<div class="ag-sl-ctx-grid">${cellsHtml.join('')}</div>` +
          `</div>` +
          `<div class="ag-sl-cat-list">${catRowsHtml.join('')}</div>` +
          `<div class="ag-sl-ctx-meta-strip">` +
            `<span>本步新增 <b>${escapeHtml(formatContextUsed(detail.sinceLastCacheTokens))}</b> · 剩余空间 <b>${escapeHtml(formatContextUsed(detail.freeTokens))}</b></span>` +
            deferredSummaryHtml +
          `</div>` +
        `</div>`
      );
    } else {
      const cacheW = Math.min(100, (metrics.lastCacheRead / limitTokens) * 100);
      const newW = Math.min(100 - cacheW, (Math.max(0, metrics.ctxTokens - metrics.lastCacheRead) / limitTokens) * 100);
      const segBarInner =
        `<span class="ag-sl-seg ag-sl-seg-tdef" style="width:${cacheW.toFixed(2)}%" title="命中缓存 ${escapeHtml(formatContextUsed(metrics.lastCacheRead))}"></span>` +
        `<span class="ag-sl-seg ag-sl-bg-${ctxTone}" style="width:${newW.toFixed(2)}%" title="本步新增 ${escapeHtml(formatContextUsed(metrics.lastInTok))}"></span>`;
      const breakdownLegendHtml =
        `<span class="ag-sl-bd-legend">` +
          `<span><i class="ag-sl-dot ag-sl-seg-tdef"></i>缓存 ${escapeHtml(formatContextUsed(metrics.lastCacheRead))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-bg-${ctxTone}"></i>新增 ${escapeHtml(formatContextUsed(metrics.lastInTok))}</span>` +
        `</span>`;

      tooltipSections.push(
        `<div class="ag-sl-ctx-block">` +
          `<div class="ag-sl-ctx-head">` +
            `<span class="ag-sl-ctx-title-wrap">` +
              `<span class="ag-sl-tt-lbl">上下文窗口</span>` +
              `<span class="ag-sl-compact-tag">压缩点 ${AUTO_COMPACT_PCT}% (~${escapeHtml(compactLabelStr)})</span>` +
            `</span>` +
            `<span class="ag-sl-ctx-nums">` +
              `<span class="ag-sl-mono">[${escapeHtml(usedStr)}/${escapeHtml(limitStr)}]</span>` +
              `<span class="ag-sl-tone-${ctxTone} ag-sl-bold">${ctxPct}%</span>` +
              `<span class="ag-sl-tt-muted">余 ${escapeHtml(formatContextUsed(metrics.remainCtxTokens))}</span>` +
            `</span>` +
          `</div>` +
          `<div class="ag-sl-prog ag-sl-prog-seg">` +
            segBarInner +
            `<i class="ag-sl-compact-tick" style="left:${AUTO_COMPACT_PCT}%" title="自动压缩点 ~${AUTO_COMPACT_PCT}% (${escapeHtml(compactLabelStr)})"></i>` +
          `</div>` +
          `<div class="ag-sl-ctx-sub">${breakdownLegendHtml}</div>` +
        `</div>`
      );
    }

    const speedSub = metrics.useStreamTps
      ? `流式 ${metrics.rawStreamTps.toFixed(1)} · 端到端 ${metrics.e2eTps.toFixed(1)}`
      : `端到端 ${metrics.e2eTps.toFixed(1)} tok/s`;
    const delayLabel = metrics.useStreamTps ? 'TTFT' : '等待';
    const streamWord = metrics.useStreamTps ? '流式' : '刷出';
    const delaySub = `${streamWord} ${metrics.streamDur.toFixed(1)}s · 总计 ${metrics.totDur.toFixed(1)}s`;
    const outSummary =
      metrics.subagentCount > 0
        ? `累计 ${escapeHtml(fmtTok(combinedOut))} (主 ${escapeHtml(fmtTok(metrics.totalOut))} + 子 ${escapeHtml(fmtTok(metrics.subagentOut))})`
        : `思考 ${escapeHtml(fmtNum(metrics.lastThinkTok))} + 正文 ${escapeHtml(fmtNum(metrics.lastRespTok))} · 累计 ${escapeHtml(fmtTok(metrics.totalOut))}`;

    tooltipSections.push(
      `<div class="ag-sl-kpi-grid">` +
        `<div class="ag-sl-kpi">` +
          `<div class="ag-sl-kpi-lbl">生成速率</div>` +
          `<div class="ag-sl-kpi-val"><span class="ag-sl-tone-${tpsTone}">${metrics.tps.toFixed(1)}</span><span class="ag-sl-kpi-unit">tok/s</span></div>` +
          `<div class="ag-sl-kpi-sub">${escapeHtml(speedSub)}</div>` +
        `</div>` +
        `<div class="ag-sl-kpi">` +
          `<div class="ag-sl-kpi-lbl">响应延迟</div>` +
          `<div class="ag-sl-kpi-val"><span class="ag-sl-tone-${ttftTone}">${metrics.ttft.toFixed(2)}s</span><span class="ag-sl-kpi-unit">${delayLabel}</span></div>` +
          `<div class="ag-sl-kpi-sub">${escapeHtml(delaySub)}</div>` +
        `</div>` +
        `<div class="ag-sl-kpi">` +
          `<div class="ag-sl-kpi-lbl">缓存命中 (单步 / 整体)</div>` +
          `<div class="ag-sl-kpi-val"><span class="ag-sl-tone-${cacheTone}">${metrics.lastCacheRate.toFixed(1)}%</span><span class="ag-sl-kpi-unit">/ ${metrics.sessionCacheRate.toFixed(1)}%</span></div>` +
          `<div class="ag-sl-kpi-sub">累计 ${escapeHtml(fmtTok(metrics.totalCache))} 缓存 / ${escapeHtml(fmtTok(metrics.totalIn))} 新增</div>` +
        `</div>` +
        `<div class="ag-sl-kpi">` +
          `<div class="ag-sl-kpi-lbl">本步输出</div>` +
          `<div class="ag-sl-kpi-val">${escapeHtml(fmtNum(metrics.lastOutTok))}<span class="ag-sl-kpi-unit">tok</span></div>` +
          `<div class="ag-sl-kpi-sub">${outSummary}</div>` +
        `</div>` +
      `</div>`
    );

    const footerPills: string[] = [];
    if (metrics.orchPlanCalls > 0 || metrics.orchExecCalls > 0) {
      footerPills.push(
        `<span><b>Orchestrator 调度</b> 规划 ${escapeHtml(metrics.orchPlanModel || 'Pro')} ${metrics.orchPlanCalls} 次 (${escapeHtml(fmtTok(metrics.orchPlanOut))}) · 执行 ${escapeHtml(metrics.orchExecModel || 'Worker')} ${metrics.orchExecCalls} 次 (${escapeHtml(fmtTok(metrics.orchExecOut))})</span>`
      );
    }
    if (metrics.turnSteps > 1) {
      footerPills.push(
        `<span><b>本轮 (${metrics.turnSteps}步)</b> 输出 ${escapeHtml(fmtNum(metrics.turnOut))} (思 ${escapeHtml(fmtNum(metrics.turnThink))} + 响 ${escapeHtml(fmtNum(metrics.turnResp))}) · ${metrics.turnDur.toFixed(1)}s</span>`
      );
    }
    const subSyncing = Boolean(metrics.isDraining || metrics.partialStale);
    if (metrics.subagentCount > 0) {
      footerPills.push(
        `<span><b>子 Agent (${metrics.subagentCount}${subSyncing ? ' · 同步中' : ''})</b> ${metrics.subagentCalls} 次 · 输 ${escapeHtml(fmtTok(metrics.subagentOut))}</span>`
      );
    } else if (metrics.descendantCount > 0 && subSyncing) {
      footerPills.push(`<span>正在索引 ${metrics.descendantCount} 个子会话…</span>`);
    }
    if (footerPills.length > 0) {
      tooltipSections.push(`<div class="ag-sl-footer-strip">${footerPills.join('')}</div>`);
    }

    // Extended drill-down accordions for IDE Webview Inspector
    if (richPanel && detail) {
      const accordions: string[] = [];

      if (detail.heavyToolCalls.length > 0) {
        const rows = detail.heavyToolCalls
          .map((hc) => {
            const openBtn = hc.path
              ? `<button type="button" class="ag-sl-open-btn" data-ag-sl-open-file="${escapeHtml(hc.path)}" title="在编辑器中打开">${OPEN_FILE_SVG}</button>`
              : '';
            return (
              `<div class="ag-sl-acc-row">` +
                `<span class="ag-sl-acc-name" title="${escapeHtml(hc.label)}">${escapeHtml(hc.label)} <i class="ag-sl-acc-tag">step ${hc.stepIndex}</i></span>` +
                `<span class="ag-sl-acc-val ag-sl-mono">${escapeHtml(formatContextUsed(hc.tokens))}${openBtn}</span>` +
              `</div>`
            );
          })
          .join('');
        accordions.push(
          `<details class="ag-sl-acc" data-ag-sl-sec="tools" open>` +
            `<summary><span>高占用工具调用</span><span class="ag-sl-acc-cnt">${detail.totalToolCalls || detail.heavyToolCalls.length}</span></summary>` +
            `<div class="ag-sl-acc-body">${rows}</div>` +
          `</details>`
        );
      }

      if (detail.mcpServers.length > 0) {
        const rows = detail.mcpServers
          .map((srv) => {
            const stateTag = srv.disabled
              ? '<i class="ag-sl-acc-tag">已禁用</i>'
              : `<i class="ag-sl-acc-tag">${srv.toolCount} tools</i>`;
            return (
              `<div class="ag-sl-acc-row">` +
                `<span class="ag-sl-acc-name">${escapeHtml(srv.name)} ${stateTag}</span>` +
                `<span class="ag-sl-acc-val ag-sl-mono">活跃 ${escapeHtml(formatContextUsed(srv.activeTokens + srv.instructionsTokens))} · 懒加载 ${escapeHtml(formatContextUsed(srv.deferredTokens))}</span>` +
              `</div>`
            );
          })
          .join('');
        accordions.push(
          `<details class="ag-sl-acc" data-ag-sl-sec="mcp">` +
            `<summary><span>MCP 服务与工具定义</span><span class="ag-sl-acc-cnt">${detail.mcpServers.length}</span></summary>` +
            `<div class="ag-sl-acc-body">${rows}</div>` +
          `</details>`
        );
      }

      if (detail.rules.length > 0 || detail.skills.length > 0) {
        const ruleRows = detail.rules
          .map((r) => {
            const openBtn = r.path
              ? `<button type="button" class="ag-sl-open-btn" data-ag-sl-open-file="${escapeHtml(r.path)}" title="在编辑器中打开">${OPEN_FILE_SVG}</button>`
              : '';
            return (
              `<div class="ag-sl-acc-row">` +
                `<span class="ag-sl-acc-name">${escapeHtml(r.name)} <i class="ag-sl-acc-tag">${escapeHtml(r.scope)}</i>${r.loaded ? ' <i class="ag-sl-acc-tag ag-sl-tag-on">生效</i>' : ''}</span>` +
                `<span class="ag-sl-acc-val ag-sl-mono">${escapeHtml(formatContextUsed(r.tokens))}${openBtn}</span>` +
              `</div>`
            );
          })
          .join('');
        const skillRows = detail.skills
          .slice(0, 16)
          .map((sk) => {
            const openBtn = sk.path
              ? `<button type="button" class="ag-sl-open-btn" data-ag-sl-open-file="${escapeHtml(sk.path)}" title="在编辑器中打开">${OPEN_FILE_SVG}</button>`
              : '';
            const label = sk.loaded
              ? `索引 ${formatContextUsed(sk.tokens)} · 已读 ${formatContextUsed(sk.secondaryTokens || 0)}`
              : `索引 ${formatContextUsed(sk.tokens)} · 懒加载 ${formatContextUsed(sk.secondaryTokens || 0)}`;
            return (
              `<div class="ag-sl-acc-row">` +
                `<span class="ag-sl-acc-name">${escapeHtml(sk.name)} <i class="ag-sl-acc-tag">${escapeHtml(sk.scope)}</i>${sk.loaded ? ' <i class="ag-sl-acc-tag ag-sl-tag-on">已加载</i>' : ''}</span>` +
                `<span class="ag-sl-acc-val ag-sl-mono">${escapeHtml(label)}${openBtn}</span>` +
              `</div>`
            );
          })
          .join('');
        accordions.push(
          `<details class="ag-sl-acc" data-ag-sl-sec="custom">` +
            `<summary><span>规则与 Skills 明细</span><span class="ag-sl-acc-cnt">${detail.rules.length + detail.skills.length}</span></summary>` +
            `<div class="ag-sl-acc-body">${ruleRows}${skillRows}</div>` +
          `</details>`
        );
      }

      if (detail.turnsHistory.length > 1) {
        const turns = detail.turnsHistory;
        const maxPrompt = Math.max(1, ...turns.map((t) => t.ctxTokens));
        const w = 340;
        const h = 56;
        const pts = turns
          .map((t, i) => {
            const x = (i / (turns.length - 1)) * (w - 8) + 4;
            const y = h - 5 - (t.ctxTokens / maxPrompt) * (h - 12);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        const dots = turns
          .map((t, i) => {
            if (!t.compacted) return '';
            const x = (i / (turns.length - 1)) * (w - 8) + 4;
            const y = h - 5 - (t.ctxTokens / maxPrompt) * (h - 12);
            return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#F59E0B"/>`;
          })
          .join('');
        const sparkSvg =
          `<svg class="ag-sl-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
            `<polyline points="${pts}" fill="none" stroke="#0EA5E9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
            dots +
          `</svg>`;
        accordions.push(
          `<details class="ag-sl-acc" data-ag-sl-sec="growth">` +
            `<summary><span>上下文增长曲线</span><span class="ag-sl-acc-cnt">${turns.length} 步</span></summary>` +
            `<div class="ag-sl-acc-body">${sparkSvg}</div>` +
          `</details>`
        );
      }

      if (accordions.length > 0) {
        tooltipSections.push(`<div class="ag-sl-acc-group">${accordions.join('')}</div>`);
      }
    }
  }

  if (effectivePools.length > 0) {
    const defaultPool = effectivePools.find((p) => p.isDefault) || effectivePools[0];
    const tabsHtml =
      effectivePools.length > 1
        ? `<div class="ag-sl-pool-tabs" role="tablist">` +
            effectivePools
              .map(
                (p) =>
                  `<button type="button" class="ag-sl-pool-tab" data-ag-sl-pool-tab="${p.id}" data-active="${p.id === defaultPool.id ? '1' : '0'}">${escapeHtml(p.tabLabel)}</button>`
              )
              .join('') +
          `</div>`
        : '';

    const poolPanelsHtml = effectivePools
      .map((pool) => {
        const maxUsed = pool.windows.reduce((mx, w) => Math.max(mx, w.usedPct), 0);
        const paceCls = maxUsed >= 85 ? 'ag-sl-pace-low' : maxUsed >= 65 ? 'ag-sl-pace-tight' : 'ag-sl-pace-ok';
        const paceText = maxUsed >= 85 ? '额度偏低' : maxUsed >= 65 ? '余量偏紧' : '充裕';
        const syncTag = pool.fetchedAtIso ? `更新于 ${formatLocalResetTime(pool.fetchedAtIso)}` : '';

        const rowsHtml = pool.windows
          .map((w) => {
            const qTone = toneForUsagePct(w.usedPct);
            const usedClamped = Math.round(clampPercent(w.usedPct));
            const labelTitle =
              w.label === '5h' ? '5h 窗口' : w.label === '7d' ? '周额度' : `${w.label} 限额`;
            const resetPart = w.resetCountdown
              ? ` · ${w.resetCountdown}`
              : w.resetLocalTime && w.usedPct > 0
                ? ` · ${w.resetLocalTime}`
                : '';

            return (
              `<div class="ag-sl-qrow">` +
                `<span class="ag-sl-qrow-lbl">${escapeHtml(labelTitle)}</span>` +
                `<div class="ag-sl-prog ag-sl-qrow-bar"><div class="ag-sl-prog-fill ag-sl-bg-${qTone}" style="width:${usedClamped}%"></div></div>` +
                `<span class="ag-sl-qrow-val"><span class="ag-sl-tone-${qTone} ag-sl-bold">${usedClamped}%</span> <span class="ag-sl-tt-muted">(余${w.remainingPct}%)${escapeHtml(resetPart)}</span></span>` +
              `</div>`
            );
          })
          .join('');

        return (
          `<div class="ag-sl-pool-panel" data-ag-sl-pool-panel="${pool.id}" data-active="${pool.id === defaultPool.id ? '1' : '0'}">` +
            `<div class="ag-sl-pool-hdr">` +
              `<span class="ag-sl-pool-title-wrap">` +
                `<span class="ag-sl-pool-title">账户模型配额 (${escapeHtml(pool.poolTitle)})</span>` +
                `<span class="ag-sl-pace ${paceCls}">${paceText}</span>` +
              `</span>` +
              (tabsHtml || (syncTag ? `<span class="ag-sl-tt-sync">${escapeHtml(syncTag)}</span>` : '')) +
            `</div>` +
            `<div class="ag-sl-quota-grid ag-sl-qrows-wrap">${rowsHtml}</div>` +
          `</div>`
        );
      })
      .join('');

    tooltipSections.push(
      `<div class="ag-sl-quota-section${hasMetrics ? ' ag-sl-has-prev' : ''}" data-ag-sl-default-pool="${defaultPool.id}">` +
        poolPanelsHtml +
      `</div>`
    );
  }

  return tooltipSections.join('');
}

export function buildAppPayload(
  paneKey: string,
  cascadeId: string,
  metrics: SessionMetrics | null,
  quotaView: ModelQuotaView,
  config: UserConfig,
  selectedModelLabel: string = '',
  quotaPools?: QuotaPoolTabView[]
): AppRenderItem {
  const hasMetrics = Boolean(metrics && metrics.hasData);
  const effectivePools: QuotaPoolTabView[] =
    quotaPools && quotaPools.length > 0
      ? quotaPools
      : quotaView && quotaView.hasQuota
        ? [
            {
              id: /claude|3p/i.test(quotaView.poolLabel) ? 'claude' : /argon/i.test(quotaView.poolLabel) ? 'argon' : 'gemini',
              tabLabel: /claude|3p/i.test(quotaView.poolLabel) ? 'Claude' : /argon/i.test(quotaView.poolLabel) ? 'Argon' : 'Gemini',
              poolTitle: quotaView.poolLabel,
              isDefault: true,
              windows: quotaView.windows,
              fetchedAtIso: quotaView.fetchedAtIso
            }
          ]
        : [];
  const hasQuota = Boolean((quotaView && quotaView.hasQuota) || effectivePools.length > 0);

  if (!hasMetrics && !hasQuota) {
    return {
      paneKey,
      cascadeId,
      hasContent: false,
      inlineHtml: '',
      toolbarHtml: '',
      toolbarCompactHtml: '',
      toolbarCoexistHtml: '',
      quotaHtml: '',
      tooltipHtml: ''
    };
  }

  const sep = '<span class="ag-sl-sep">·</span>';
  const fullParts: string[] = [];
  const compactParts: string[] = [];

  if (hasMetrics && metrics && metrics.isOrchestrator) {
    const phaseLabel = metrics.orchestratorPhase === 'exec' ? 'Exec' : 'Plan';
    const phaseCls = metrics.orchestratorPhase === 'exec' ? 'ag-sl-orch-exec' : 'ag-sl-orch-plan';
    const modelTag = metrics.activeShortModel || (metrics.orchestratorPhase === 'exec' ? 'Hydrogen' : 'Carbon');
    const orchBadge = `<span class="ag-sl-orch ${phaseCls}">${phaseLabel} · ${escapeHtml(modelTag)}</span>`;
    fullParts.push(orchBadge);
    compactParts.push(orchBadge);
  } else if ((!hasMetrics || !metrics?.isOrchestrator) && /orchestrator/i.test(selectedModelLabel)) {
    const selInfo = classifyModelMetadata('', selectedModelLabel, 0);
    const idleBadge = `<span class="ag-sl-orch ag-sl-orch-idle">Plan · ${escapeHtml(selInfo.shortModel || 'Carbon')}</span>`;
    fullParts.push(idleBadge);
    compactParts.push(idleBadge);
  }

  if (hasMetrics && metrics) {
    const ctxPct = Math.round(clampPercent(metrics.ctxPct));
    const ctxTone = toneForUsagePct(ctxPct);
    const stepCacheRate = Math.round(clampPercent(metrics.lastCacheRate));
    const sessCacheRate = Math.round(clampPercent(metrics.sessionCacheRate));
    const primaryCacheRate = config.cacheRateMode === 'session' ? sessCacheRate : stepCacheRate;
    const secondaryCacheRate = config.cacheRateMode === 'session' ? stepCacheRate : sessCacheRate;
    const primaryCacheTone = toneForCachePct(primaryCacheRate);
    const tpsVal = Math.max(0, Math.round(metrics.tps || 0));
    const tpsTone = toneForTps(metrics.tps || 0);
    const ttftSec = Math.max(0, metrics.ttft || 0);
    const ttftTone = toneForTtft(ttftSec);
    const combinedOut = Math.max(0, (metrics.totalOut || 0) + (metrics.subagentOut || 0));

    const tpsChip = `<span class="ag-sl-item"><span class="ag-sl-tone-${tpsTone}">${tpsVal}</span> <span class="ag-sl-dim">tok/s</span></span>`;
    const cacheFullChip = `<span class="ag-sl-item"><span class="ag-sl-lbl">Cache</span> <span class="ag-sl-tone-${primaryCacheTone}">${primaryCacheRate}%</span><span class="ag-sl-dim">/${secondaryCacheRate}%</span></span>`;
    const cacheCompactChip = `<span class="ag-sl-item"><span class="ag-sl-tone-${primaryCacheTone}">${primaryCacheRate}%</span><span class="ag-sl-dim">/${secondaryCacheRate}%</span></span>`;
    const ctxRing = buildContextRingSvg(ctxPct, ctxTone);
    const ctxChip = `<span class="ag-sl-item ag-sl-ctx-chip">${ctxRing}<span class="ag-sl-tone-${ctxTone}">${ctxPct}%</span></span>`;

    fullParts.push(tpsChip, cacheFullChip, ctxChip);
    compactParts.push(tpsChip, cacheCompactChip, ctxChip);

    if (ttftSec > 0) {
      const delayLabel = metrics.useStreamTps ? 'TTFT' : 'Hold';
      fullParts.push(
        `<span class="ag-sl-item"><span class="ag-sl-lbl">${delayLabel}</span> <span class="ag-sl-tone-${ttftTone}">${ttftSec.toFixed(1)}s</span></span>`
      );
    }
    if (combinedOut > 0) {
      fullParts.push(
        `<span class="ag-sl-item"><span class="ag-sl-lbl">Out</span> <span class="ag-sl-val">${escapeHtml(fmtTok(combinedOut))}</span></span>`
      );
    }
    if (metrics.subagentCount > 0) {
      fullParts.push(`<span class="ag-sl-sub">+${metrics.subagentCount} sub</span>`);
      compactParts.push(`<span class="ag-sl-sub">+${metrics.subagentCount}</span>`);
    }
  }

  const rightParts: string[] = [];
  if (quotaView && quotaView.hasQuota) {
    for (const w of quotaView.windows) {
      const qTone = toneForUsagePct(w.usedPct);
      const resetPart = w.resetCountdown
        ? ` <span class="ag-sl-dim">${escapeHtml(w.resetCountdown)}</span>`
        : '';
      rightParts.push(
        `<span class="ag-sl-item"><span class="ag-sl-lbl">${escapeHtml(w.label)}</span> <span class="ag-sl-tone-${qTone}">${w.usedPct}%</span>${resetPart}</span>`
      );
    }
  }

  const toolbarHtml = fullParts.length > 0 ? fullParts.join(sep) : '';
  const toolbarCompactHtml = compactParts.length > 0 ? compactParts.join(sep) : '';
  const toolbarCoexistHtml = toolbarHtml;
  const quotaHtml =
    rightParts.length > 0
      ? `<span class="ag-sl-hover-target ag-sl-bar-right" data-ag-sl-hover-anchor="1">${rightParts.join(sep)}</span>`
      : '';
  const leftSummary = toolbarHtml
    ? `<span class="ag-sl-hover-target ag-sl-bar-left" data-ag-sl-hover-anchor="1">${toolbarHtml}</span>`
    : '';
  const inlineHtml = `${leftSummary}${quotaHtml}`;
  const tooltipHtml = buildDashboardHtml(metrics, effectivePools, { richPanelMode: false });

  return {
    paneKey,
    cascadeId,
    hasContent: Boolean(toolbarHtml || quotaHtml),
    inlineHtml,
    toolbarHtml,
    toolbarCompactHtml,
    toolbarCoexistHtml,
    quotaHtml,
    tooltipHtml
  };
}
