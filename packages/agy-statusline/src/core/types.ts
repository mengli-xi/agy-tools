export type ChannelMode = 'auto' | 'stable' | 'insiders';
export type CacheRateMode = 'last' | 'session';
export type IdeAlignment = 'left' | 'right';
export type SeverityLevel = 'ok' | 'warn' | 'crit';
export type MetricTone = 'good' | 'info' | 'mid' | 'warn' | 'crit' | 'dim';
export type OrchestratorPhase = '' | 'plan' | 'exec';

export type ContextCategoryKey =
  | 'messages'
  | 'agentResponses'
  | 'toolCalls'
  | 'mcpTools'
  | 'mcpInstructions'
  | 'systemTools'
  | 'systemPrompt'
  | 'rulesFiles'
  | 'skills'
  | 'customAgents'
  | 'systemMessages'
  | 'checkpointBuffer';

export interface UserConfig {
  enabled: boolean;
  channel: ChannelMode;
  cacheRateMode: CacheRateMode;
  contextLimit: number;
  contextLimitOverride: number;
  proxy: string;
  cli: {
    showModel: boolean;
    showGitBranch: boolean;
    color: boolean;
  };
  app: {
    enabled: boolean;
    cdpAutoRelaunch: boolean;
  };
  ide: {
    enabled: boolean;
    alignment: IdeAlignment;
  };
}

export interface RawBreakdownStepItem {
  stepIdx: number;
  stepTag: string;
  tokens: number;
}

export interface GenRowMetrics {
  idx: number;
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
  ctx: number;
  maxCtx: number;
  hasCtxBreakdown: boolean;
  ctxBreakdownSys: number;
  ctxBreakdownToolDefs: number;
  ctxBreakdownToolCalls: number;
  ctxBreakdownModel: number;
  ctxBreakdownUser: number;
  rawSystemPromptTok?: number;
  rawSystemToolsTok?: number;
  rawRulesTok?: number;
  rawMcpTok?: number;
  rawSkillsTok?: number;
  rawSubagentsPluginsTok?: number;
  rawSystemMsgTok?: number;
  rawCheckpointTok?: number;
  rawStepTokens?: RawBreakdownStepItem[];
  thinkTok: number;
  respTok: number;
  ttft: number;
  stream: number;
  totDur: number;
  modelEnum: number;
  modelId: string;
  modelDisplay: string;
}

export interface HeavyToolCallItem {
  stepIndex: number;
  toolName: string;
  label: string;
  path: string | null;
  tokens: number;
}

export interface CustomizationFileItem {
  name: string;
  scope: string;
  path: string | null;
  tokens: number;
  secondaryTokens?: number;
  loaded: boolean;
}

export interface McpServerSummaryItem {
  name: string;
  source: string;
  disabled: boolean;
  toolCount: number;
  activeTokens: number;
  deferredTokens: number;
  instructionsTokens: number;
}

export interface TurnGrowthPoint {
  idx: number;
  ctxTokens: number;
  outTokens: number;
  compacted: boolean;
}

export interface ContextDetailBreakdown {
  exactFromSqlite: boolean;
  categories: {
    messages: number;
    agentResponses: number;
    agentReplies: number;
    agentThinking: number;
    toolCalls: number;
    toolCallOutputs: number;
    toolCallArgs: number;
    mcpTools: number;
    mcpInstructions: number;
    systemTools: number;
    systemPrompt: number;
    rulesFiles: number;
    skills: number;
    customAgents: number;
    systemMessages: number;
    checkpointBuffer: number;
  };
  sinceLastCacheTokens: number;
  freeTokens: number;
  deferred: {
    mcpTokens: number;
    skillsTokens: number;
    rulesTokens: number;
    totalTokens: number;
  };
  compaction: {
    count: number;
    totalSavedTokens: number;
    lastBeforeTokens: number;
    lastAfterTokens: number;
  };
  heavyToolCalls: HeavyToolCallItem[];
  totalToolCalls: number;
  mcpServers: McpServerSummaryItem[];
  rules: CustomizationFileItem[];
  skills: CustomizationFileItem[];
  turnsHistory: TurnGrowthPoint[];
  workspaceUris: string[];
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
  hasCtxBreakdown?: boolean;
  ctxBreakdownSys?: number;
  ctxBreakdownToolDefs?: number;
  ctxBreakdownToolCalls?: number;
  ctxBreakdownModel?: number;
  ctxBreakdownUser?: number;
  ctxDetail?: ContextDetailBreakdown;
  compactionCount?: number;
  compactionSavedTokens?: number;
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
  activeModelId: string;
  activeModelDisplay: string;
  activeShortModel: string;
  activeEffort: string;
  isOrchestrator: boolean;
  orchestratorPhase: OrchestratorPhase;
  orchPlanCalls: number;
  orchPlanModel: string;
  orchPlanOut: number;
  orchExecCalls: number;
  orchExecModel: string;
  orchExecOut: number;
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

export interface QuotaPoolTabView {
  id: 'gemini' | 'claude' | 'argon';
  tabLabel: string;
  poolTitle: string;
  isDefault: boolean;
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
  toolbarHtml: string;
  toolbarCompactHtml: string;
  toolbarCoexistHtml: string;
  quotaHtml: string;
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

export interface IdeConversationCandidate {
  cascadeId: string;
  title: string;
  stepCount: number;
  lastModifiedIso: string;
  lastModifiedMs: number;
  workspaceUris: string[];
  matchedWorkspace: boolean;
  activeNow: boolean;
  channel: 'stable' | 'insiders';
}

export interface IdeInspectPayload {
  ok: boolean;
  timestamp: string;
  enabled: boolean;
  selectedCascadeId: string;
  selectedTitle: string;
  matchedWorkspace: boolean;
  candidates: IdeConversationCandidate[];
  metrics: SessionMetrics | null;
  quotaView: ModelQuotaView;
  quotaPools: QuotaPoolTabView[];
  dashboardHtml: string;
  config: UserConfig;
}
