export type ChannelMode = 'auto' | 'stable' | 'insiders';
export type CacheRateMode = 'last' | 'session';
export type SeverityLevel = 'ok' | 'warn' | 'crit';
export type MetricTone = 'good' | 'info' | 'mid' | 'warn' | 'crit' | 'dim';

export interface UserConfig {
  enabled: boolean;
  channel: ChannelMode;
  cacheRateMode: CacheRateMode;
  contextLimit: number;
  contextLimitOverride: number;
  cli: {
    showModel: boolean;
    showGitBranch: boolean;
    color: boolean;
  };
  app: {
    enabled: boolean;
    cdpAutoRelaunch: boolean;
  };
}

export interface GenRowMetrics {
  idx: number;
  inTok: number;
  outTok: number;
  cacheRead: number;
  ctx: number;
  maxCtx: number;
  thinkTok: number;
  respTok: number;
  ttft: number;
  stream: number;
  totDur: number;
}

export interface SessionMetrics {
  cascadeId: string;
  hasData: boolean;
  sig?: string;
  isDraining?: boolean;
  partialStale?: boolean;
  uncBackoffActive?: boolean;
  transientError?: boolean;
  cachedMetrics?: SessionMetrics | null;
  lastGenIdx: number;
  ctxTokens: number;
  contextLimitTokens: number;
  ctxPct: number;
  remainCtxTokens: number;
  lastInTok: number;
  lastCacheRead: number;
  lastOutTok: number;
  lastThinkTok: number;
  lastRespTok: number;
  lastCacheRate: number;
  sessionCacheRate: number;
  totalIn: number;
  totalCache: number;
  totalOut: number;
  totalThink: number;
  totalResp: number;
  userTurns: number;
  validCalls: number;
  turnSteps: number;
  turnOut: number;
  turnThink: number;
  turnResp: number;
  turnDur: number;
  useStreamTps: boolean;
  rawStreamTps: number;
  e2eTps: number;
  tps: number;
  ttft: number;
  streamDur: number;
  totDur: number;
  subagentCount: number;
  subagentCalls: number;
  subagentIn: number;
  subagentCache: number;
  subagentOut: number;
  descendantCount: number;
}

export interface QuotaBucket {
  remaining_fraction?: number;
  reset_time?: string;
  reset_in_seconds?: number;
}

export interface LegacyModelQuota {
  remainingFraction: number;
  resetTime: string;
}

export interface QuotaCacheData {
  timestamp?: string;
  source?: string;
  email?: string;
  plan_name?: string;
  models?: Record<string, LegacyModelQuota>;
  quota?: Record<string, QuotaBucket>;
}

export interface QuotaWindowView {
  key: string;
  label: string;
  usedPct: number;
  remainingPct: number;
  resetCountdown: string;
  resetLocalTime: string;
  resetTimeIso: string;
}

export interface ModelQuotaView {
  hasQuota: boolean;
  poolLabel: string;
  windows: QuotaWindowView[];
  fetchedAtIso: string;
}

export interface WatchedPanel {
  paneKey: string;
  cascadeId: string;
  modelLabel: string;
}

export interface AppRenderItem {
  paneKey: string;
  cascadeId: string;
  hasContent: boolean;
  inlineHtml: string;
  tooltipHtml: string;
}

export interface StatuslinePayload {
  cwd?: string;
  session_id?: string;
  conversation_id?: string;
  conversation_title?: string;
  version?: string;
  transcript_path?: string;
  email?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: unknown;
  };
  quota?: Record<string, QuotaBucket>;
  agent_state?: string;
  cycle_mode?: unknown;
  plan_tier?: string;
  terminal_width?: number;
  vcs?: {
    type?: string;
    branch?: string;
    root?: string;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
}
