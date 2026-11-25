export type UsagePoolKind = '5h' | '7d' | 'other';

export type MetricTone = 'good' | 'mid' | 'warn' | 'crit';

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
}

export interface RuntimeMessage {
  type: 'GWH_USAGE_UPDATE' | 'GWH_GET_USAGE';
  snapshot?: UsageSnapshot;
}

export const STORAGE_KEY_USAGE = 'gwh_usage_snapshot_v1';
