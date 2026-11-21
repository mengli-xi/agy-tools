import { formatLocalResetTime } from './quota-store.js';
import type {
  AppRenderItem,
  MetricTone,
  ModelQuotaView,
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

export function formatContextCeiling(tokens: number): string {
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

export function buildAppPayload(
  paneKey: string,
  cascadeId: string,
  metrics: SessionMetrics | null,
  quotaView: ModelQuotaView,
  config: UserConfig
): AppRenderItem {
  const hasMetrics = Boolean(metrics && metrics.hasData);
  const hasQuota = Boolean(quotaView && quotaView.hasQuota);

  if (!hasMetrics && !hasQuota) {
    return {
      paneKey,
      cascadeId,
      hasContent: false,
      inlineHtml: '',
      tooltipHtml: ''
    };
  }

  const leftParts: string[] = [];

  if (hasMetrics && metrics) {
    const ctxPct = Math.round(clampPercent(metrics.ctxPct));
    const ctxTone = toneForUsagePct(ctxPct);
    const limitStr = formatContextCeiling(metrics.contextLimitTokens);
    const cacheRate = Math.round(clampPercent(selectCacheRate(metrics, config)));
    const cacheTone = toneForCachePct(cacheRate);
    const tpsVal = Math.max(0, Math.round(metrics.tps || 0));
    const tpsTone = toneForTps(metrics.tps || 0);
    const ttftSec = Math.max(0, metrics.ttft || 0);
    const ttftTone = toneForTtft(ttftSec);
    const combinedOut = Math.max(0, (metrics.totalOut || 0) + (metrics.subagentOut || 0));

    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-lbl">Ctx</span> <span class="ag-sl-tone-${ctxTone}">${ctxPct}%</span> <span class="ag-sl-dim">${escapeHtml(fmtTok(metrics.ctxTokens))}/${escapeHtml(limitStr)}</span></span>`
    );
    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-lbl">Cache</span> <span class="ag-sl-tone-${cacheTone}">${cacheRate}%</span></span>`
    );
    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-tone-${tpsTone}">${tpsVal}</span> <span class="ag-sl-dim">tok/s</span></span>`
    );
    if (ttftSec > 0) {
      const delayLabel = metrics.useStreamTps ? 'TTFT' : 'Hold';
      leftParts.push(
        `<span class="ag-sl-item"><span class="ag-sl-lbl">${delayLabel}</span> <span class="ag-sl-tone-${ttftTone}">${ttftSec.toFixed(1)}s</span></span>`
      );
    }
    if (combinedOut > 0) {
      leftParts.push(
        `<span class="ag-sl-item"><span class="ag-sl-lbl">Out</span> <span class="ag-sl-val">${escapeHtml(fmtTok(combinedOut))}</span></span>`
      );
    }
    if (metrics.subagentCount > 0) {
      leftParts.push(`<span class="ag-sl-sub">+${metrics.subagentCount} sub</span>`);
    }
  } else {
    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-lbl">Ctx</span> <span class="ag-sl-tone-dim">0%</span></span>`
    );
    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-lbl">Cache</span> <span class="ag-sl-tone-dim">--</span></span>`
    );
    leftParts.push(
      `<span class="ag-sl-item"><span class="ag-sl-tone-dim">-- tok/s</span></span>`
    );
  }

  const rightParts: string[] = [];
  if (hasQuota) {
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

  const sep = '<span class="ag-sl-sep">·</span>';
  const leftHtml = `<div class="ag-sl-bar-left">${leftParts.join(sep)}</div>`;
  const rightHtml = rightParts.length > 0 ? `<div class="ag-sl-bar-right">${rightParts.join(sep)}</div>` : '';
  const inlineHtml = `${leftHtml}${rightHtml}`;

  const tooltipSections: string[] = [];

  if (hasMetrics && metrics) {
    const ctxPct = Math.round(clampPercent(metrics.ctxPct));
    const ctxTone = toneForUsagePct(ctxPct);
    const cacheTone = toneForCachePct(metrics.lastCacheRate);
    const tpsTone = toneForTps(metrics.tps || 0);
    const ttftTone = toneForTtft(metrics.ttft || 0);
    const limitStr = formatContextCeiling(metrics.contextLimitTokens);
    const combinedOut = Math.max(0, (metrics.totalOut || 0) + (metrics.subagentOut || 0));

    tooltipSections.push(
      `<div class="ag-sl-tt-top">` +
        `<div class="ag-sl-tt-title-group">` +
          `<span class="ag-sl-tt-title">会话遥测</span>` +
          `<span class="ag-sl-badge">Gen #${metrics.lastGenIdx + 1}</span>` +
          `<span class="ag-sl-tt-meta">${metrics.userTurns} 轮提问 · ${metrics.validCalls} 次调用</span>` +
        `</div>` +
      `</div>`
    );

    tooltipSections.push(
      `<div class="ag-sl-ctx-block">` +
        `<div class="ag-sl-ctx-head">` +
          `<span class="ag-sl-tt-lbl">上下文水位</span>` +
          `<span class="ag-sl-ctx-nums">` +
            `<span class="ag-sl-mono">${escapeHtml(fmtTok(metrics.ctxTokens))} / ${escapeHtml(limitStr)}</span>` +
            `<span class="ag-sl-tone-${ctxTone} ag-sl-bold">${ctxPct}%</span>` +
            `<span class="ag-sl-tt-muted">余 ${escapeHtml(fmtTok(metrics.remainCtxTokens))}</span>` +
          `</span>` +
        `</div>` +
        `<div class="ag-sl-prog"><div class="ag-sl-prog-fill ag-sl-bg-${ctxTone}" style="width:${ctxPct}%"></div></div>` +
        `<div class="ag-sl-ctx-sub">` +
          `<span>本步: 新增 ${escapeHtml(fmtNum(metrics.lastInTok))} + 缓存 ${escapeHtml(fmtNum(metrics.lastCacheRead))}</span>` +
          `<span>会话命中 ${metrics.sessionCacheRate.toFixed(1)}%</span>` +
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
          `<div class="ag-sl-kpi-lbl">单步缓存</div>` +
          `<div class="ag-sl-kpi-val"><span class="ag-sl-tone-${cacheTone}">${metrics.lastCacheRate.toFixed(1)}%</span></div>` +
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

  if (hasQuota) {
    const syncTag = quotaView.fetchedAtIso ? `更新于 ${formatLocalResetTime(quotaView.fetchedAtIso)}` : '';
    tooltipSections.push(
      `<div class="ag-sl-tt-subhdr${hasMetrics ? ' ag-sl-has-prev' : ''}">` +
        `<span>账户模型配额 (${escapeHtml(quotaView.poolLabel)})</span>` +
        (syncTag ? `<span class="ag-sl-tt-sync">${escapeHtml(syncTag)}</span>` : '') +
      `</div>`
    );

    const gridCols = quotaView.windows.length === 1 ? ' ag-sl-qgrid-1' : '';
    const qCards = quotaView.windows.map((w) => {
      const qTone = toneForUsagePct(w.usedPct);
      const usedClamped = Math.round(clampPercent(w.usedPct));
      const labelTitle =
        w.label === '5h' ? '5h 周期限额' : w.label === '7d' ? '7d 周期限额' : `${w.label} 限额`;
      const resetDesc = w.resetCountdown
        ? `${w.resetCountdown} 后重置${w.resetLocalTime ? ` (${w.resetLocalTime})` : ''}`
        : w.usedPct === 0
          ? '未消耗'
          : w.resetLocalTime
            ? `重置于 ${w.resetLocalTime}`
            : '刷新中';

      return (
        `<div class="ag-sl-qcard">` +
          `<div class="ag-sl-qcard-top">` +
            `<span class="ag-sl-qcard-lbl">${escapeHtml(labelTitle)}</span>` +
            `<span class="ag-sl-qcard-pct"><span class="ag-sl-tone-${qTone} ag-sl-bold">${usedClamped}%</span> <span class="ag-sl-tt-muted">余 ${w.remainingPct}%</span></span>` +
          `</div>` +
          `<div class="ag-sl-prog"><div class="ag-sl-prog-fill ag-sl-bg-${qTone}" style="width:${usedClamped}%"></div></div>` +
          `<div class="ag-sl-qcard-sub">${escapeHtml(resetDesc)}</div>` +
        `</div>`
      );
    });

    tooltipSections.push(`<div class="ag-sl-quota-grid${gridCols}">${qCards.join('')}</div>`);
  }

  return {
    paneKey,
    cascadeId,
    hasContent: true,
    inlineHtml,
    tooltipHtml: tooltipSections.join('')
  };
}
