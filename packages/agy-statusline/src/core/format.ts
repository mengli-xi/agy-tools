import { formatLocalResetTime } from './quota-store.js';
import { classifyModelMetadata } from './sqlite-metrics.js';
import type {
  AppRenderItem,
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
    const usedStr = formatContextUsed(metrics.ctxTokens);
    const limitStr = formatContextCeiling(metrics.contextLimitTokens);
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

    // Unused in inline chip now that progress ring is shown, kept for tooltip header below
    void usedStr;
    void limitStr;

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
    const compactTokens = Math.round(limitTokens * (AUTO_COMPACT_PCT / 100));
    const compactLabelStr = formatContextUsed(compactTokens);

    let segBarInner = '';
    let breakdownLegendHtml = '';
    if (metrics.hasCtxBreakdown) {
      const rawSys = Math.max(0, metrics.ctxBreakdownSys || 0);
      const rawTDef = Math.max(0, metrics.ctxBreakdownToolDefs || 0);
      const rawTCall = Math.max(0, metrics.ctxBreakdownToolCalls || 0);
      const rawModel = Math.max(0, metrics.ctxBreakdownModel || 0);
      const rawUser = Math.max(0, metrics.ctxBreakdownUser || 0);
      const rawParts = [rawSys, rawTDef, rawTCall, rawModel, rawUser];
      const rawSum = Math.max(1, rawSys + rawTDef + rawTCall + rawModel + rawUser);
      const scale = metrics.ctxTokens > 0 ? metrics.ctxTokens / rawSum : 1;
      const scaledParts = rawParts.map((v) => (v > 0 ? Math.round(v * scale) : 0));
      const scaledSum = scaledParts.reduce((a, b) => a + b, 0);
      if (metrics.ctxTokens > 0 && scaledSum !== metrics.ctxTokens) {
        let maxIdx = 0;
        for (let i = 1; i < rawParts.length; i++) {
          if (rawParts[i] > rawParts[maxIdx]) maxIdx = i;
        }
        scaledParts[maxIdx] = Math.max(0, scaledParts[maxIdx] + (metrics.ctxTokens - scaledSum));
      }
      const [sysTok, tdefTok, tcallTok, modelTok, userTok] = scaledParts;

      const segments: Array<{ tok: number; cls: string; title: string }> = [
        { tok: sysTok, cls: 'ag-sl-seg-sys', title: `系统与规则 ${formatContextUsed(sysTok)}` },
        { tok: tdefTok, cls: 'ag-sl-seg-tdef', title: `工具与扩展定义 ${formatContextUsed(tdefTok)}` },
        { tok: tcallTok, cls: 'ag-sl-seg-tcall', title: `工具调用与返回 ${formatContextUsed(tcallTok)}` },
        { tok: modelTok, cls: 'ag-sl-seg-model', title: `模型思考与回复 ${formatContextUsed(modelTok)}` },
        { tok: userTok, cls: 'ag-sl-seg-user', title: `用户提问 ${formatContextUsed(userTok)}` }
      ];
      let usedWidth = 0;
      for (const s of segments) {
        if (s.tok <= 0) continue;
        const w = Math.min(100 - usedWidth, (s.tok / limitTokens) * 100);
        if (w <= 0) continue;
        usedWidth += w;
        segBarInner += `<span class="ag-sl-seg ${s.cls}" style="width:${w.toFixed(2)}%" title="${escapeHtml(s.title)}"></span>`;
      }
      breakdownLegendHtml =
        `<span class="ag-sl-bd-legend">` +
          `<span><i class="ag-sl-dot ag-sl-seg-sys"></i>系统 ${escapeHtml(formatContextUsed(sysTok))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-seg-tdef"></i>工具定义 ${escapeHtml(formatContextUsed(tdefTok))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-seg-tcall"></i>工具调用 ${escapeHtml(formatContextUsed(tcallTok))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-seg-model"></i>模型 ${escapeHtml(formatContextUsed(modelTok))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-seg-user"></i>提问 ${escapeHtml(formatContextUsed(userTok))}</span>` +
        `</span>`;
    } else {
      const cacheW = Math.min(100, (metrics.lastCacheRead / limitTokens) * 100);
      const newW = Math.min(100 - cacheW, (Math.max(0, metrics.ctxTokens - metrics.lastCacheRead) / limitTokens) * 100);
      segBarInner =
        `<span class="ag-sl-seg ag-sl-seg-tdef" style="width:${cacheW.toFixed(2)}%" title="命中缓存 ${escapeHtml(formatContextUsed(metrics.lastCacheRead))}"></span>` +
        `<span class="ag-sl-seg ag-sl-bg-${ctxTone}" style="width:${newW.toFixed(2)}%" title="本步新增 ${escapeHtml(formatContextUsed(metrics.lastInTok))}"></span>`;
      breakdownLegendHtml =
        `<span class="ag-sl-bd-legend">` +
          `<span><i class="ag-sl-dot ag-sl-seg-tdef"></i>缓存 ${escapeHtml(formatContextUsed(metrics.lastCacheRead))}</span>` +
          `<span><i class="ag-sl-dot ag-sl-bg-${ctxTone}"></i>新增 ${escapeHtml(formatContextUsed(metrics.lastInTok))}</span>` +
        `</span>`;
    }

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
        `<div class="ag-sl-ctx-sub">` +
          breakdownLegendHtml +
        `</div>` +
      `</div>`
    );

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

  return {
    paneKey,
    cascadeId,
    hasContent: Boolean(toolbarHtml || quotaHtml),
    inlineHtml,
    toolbarHtml,
    toolbarCompactHtml,
    toolbarCoexistHtml,
    quotaHtml,
    tooltipHtml: tooltipSections.join('')
  };
}
