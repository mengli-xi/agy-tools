export type UsagePoolKind = '5h' | '7d' | 'other';

export type MetricTone = 'good' | 'mid' | 'warn' | 'crit';

export type UsageFailureReason =
  | 'feature_gate_disabled'
  | 'redirected_to_app'
  | 'login_required'
  | 'no_pools_in_page'
  | 'iframe_blocked_or_timeout';

export interface UsagePool {
  id: string;
  kind: UsagePoolKind;
  label: string;
  usedPct: number;
  remainingPct: number;
  resetAtIso?: string;
  resetText?: string;
}

export interface UsageSnapshot {
  pools: UsagePool[];
  fetchedAt: number;
  source: 'graphql' | 'dom';
  accountKey?: string;
}

export interface UsageBridgeMessage {
  source: 'gwh-usage-bridge';
  type: 'graphql';
  payload: string;
}

export interface UsageFramePostMessage {
  source: 'gwh-usage-frame';
  type: 'snapshot' | 'empty';
  snapshot?: UsageSnapshot;
  reason?: UsageFailureReason;
  detail?: string;
}

export interface RuntimeMessage {
  type: 'GWH_USAGE_UPDATE' | 'GWH_GET_USAGE';
  snapshot?: UsageSnapshot;
  accountKey?: string;
}

export const STORAGE_KEY_USAGE = 'gwh_usage_snapshot_v1';
export const STORAGE_KEY_LOGS = 'gwh_diag_logs_v1';

export function resolveAccountScope(pathname: string): {
  accountKey: string;
  pathPrefix: string;
  storageKey: string;
} {
  const m = String(pathname || '').match(/^\/u\/(\d+)(?:\/|$)/);
  const idx = m ? m[1] : '0';
  const accountKey = `u${idx}`;
  return {
    accountKey,
    pathPrefix: m ? `/u/${idx}` : '',
    storageKey: idx === '0' ? STORAGE_KEY_USAGE : `${STORAGE_KEY_USAGE}_${accountKey}`
  };
}
