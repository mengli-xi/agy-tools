import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { parseProto, parseProtoRepeated, readUtf8 } from './proto.js';
import type { GenRowMetrics, OrchestratorPhase, SessionMetrics } from './types.js';

// Suppress Node 22 ExperimentalWarning emitted when importing node:sqlite.
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const first = rest[0] as string | { type?: string } | undefined;
  const type = typeof first === 'string' ? first : first?.type;
  if (
    type === 'ExperimentalWarning' ||
    (warning && typeof warning === 'object' && warning.name === 'ExperimentalWarning') ||
    (typeof warning === 'string' && warning.includes('SQLite is an experimental feature'))
  ) {
    return;
  }
  return (origEmitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
};

let DatabaseSyncCtor: typeof DatabaseSyncType | null = null;
try {
  const mod = await import('node:sqlite').catch(() => null);
  if (mod && typeof mod.DatabaseSync === 'function') {
    DatabaseSyncCtor = mod.DatabaseSync;
  }
} catch {
  DatabaseSyncCtor = null;
}

export function isSqliteAvailable(): boolean {
  return DatabaseSyncCtor !== null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;

export interface ChannelEndpoint {
  channel: string;
  portFile?: string;
  geminiSubDir?: string;
  explicitConvDir?: boolean;
  conversationsDir: string;
}

export interface DbState {
  dbPath: string;
  rawSig: string;
  sig: string;
  uncDeferred?: boolean;
}

interface IncrementalState {
  rowCount: number;
  maxIdx: number;
  userStepsCount: number;
  lastUserStepIdx: number;
  items: GenRowMetrics[];
  validItems: GenRowMetrics[];
  totalIn: number;
  totalCache: number;
  totalOut: number;
  totalThink: number;
  totalResp: number;
}

interface ChildScalarMetrics {
  sig: string;
  hasData: boolean;
  calls: number;
  totalIn: number;
  totalCache: number;
  totalOut: number;
  totalThink: number;
  totalResp: number;
}

interface LineageNode {
  hasMeta: boolean;
  parentId: string;
  rootId: string;
  statSig: string;
}

interface DirLineageState {
  dirMtimeMs: number;
  scanningDirMtimeMs: number;
  lastPendingScanAt: number;
  unindexedQueue: Array<{ uuid: string; dbPath: string; mtimeMs: number; statSig: string }>;
  unindexedSet: Set<string>;
  noMetaPending: Map<string, string>;
  nodes: Map<string, LineageNode>;
  byParent: Map<string, Set<string>>;
  byRoot: Map<string, Set<string>>;
}

export interface ChildSnapshot {
  conversationsDir: string;
  descendantIds: string[];
  childSigs: Map<string, string>;
  isDraining: boolean;
  partialStale: boolean;
  uncBackoffActive?: boolean;
  sig: string;
}

export interface MetricsParseOptions {
  contextLimit?: number;
  contextLimitOverride?: number;
}

const MAX_METRICS_CACHE_SIZE = 30;
const MAX_CHILD_METRICS_CACHE_SIZE = 4096;
const MAX_NO_META_PENDING_IDS = 64;
const LINEAGE_TICK_MAX_OPENS = 45;
const LINEAGE_TICK_MAX_OPENS_UNC = 8;
const LINEAGE_TICK_MAX_MS = 60;
const NO_META_RESCAN_LOCAL_MS = 2500;
const NO_META_RESCAN_UNC_MS = 15000;

const metricsCache = new Map<string, { sig: string; payload: SessionMetrics }>();
const lastBestEffortCache = new Map<string, SessionMetrics>();
const incrementalMetricsMap = new Map<string, IncrementalState>();
const childMetricsCache = new Map<string, ChildScalarMetrics>();
const lineageStateByDir = new Map<string, DirLineageState>();
const resolvedCascadeDbCache = new Map<string, string>();
const negativeCascadeWslCache = new Map<string, number>();
const lastKnownDbStateCache = new Map<string, DbState>();
const wslDirsCache = new Map<string, { sig: string; distro: string; dirs: string[]; probedAt: number }>();

let cachedRegWslDistros: { distros: string[]; probedAt: number } = { distros: [], probedAt: 0 };
let wslUncBackoffUntil = 0;
let wslSqliteTmpSeq = 0;
let sqliteUriSupported: boolean | null = null;

export function clearMetricsCaches(): void {
  metricsCache.clear();
  lastBestEffortCache.clear();
  incrementalMetricsMap.clear();
  childMetricsCache.clear();
  lineageStateByDir.clear();
  resolvedCascadeDbCache.clear();
  negativeCascadeWslCache.clear();
  lastKnownDbStateCache.clear();
  wslDirsCache.clear();
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, val: V, maxEntries: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function setMetricsCache(dbPath: string, entry: { sig: string; payload: SessionMetrics }): void {
  setBoundedMap(metricsCache, dbPath, entry, MAX_METRICS_CACHE_SIZE);
  if (metricsCache.size >= MAX_METRICS_CACHE_SIZE) {
    for (const k of Array.from(incrementalMetricsMap.keys())) {
      if (!metricsCache.has(k) && incrementalMetricsMap.size > MAX_METRICS_CACHE_SIZE) {
        incrementalMetricsMap.delete(k);
      }
    }
  }
}

function getFileMtimeSig(filePath: string): string {
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    return st ? `${st.mtimeMs}:${st.size}` : '0:0';
  } catch {
    return '0:0';
  }
}

function isUncPath(p: string): boolean {
  if (!p || process.platform !== 'win32') return false;
  return (
    p.startsWith('\\\\wsl.localhost\\') ||
    p.startsWith('\\\\wsl$\\') ||
    p.startsWith('\\\\?\\UNC\\') ||
    p.startsWith('\\\\') ||
    p.startsWith('//wsl')
  );
}

function resolveWslDistrosFromRegistry(): string[] {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (now - cachedRegWslDistros.probedAt < 60000) {
    return cachedRegWslDistros.distros;
  }
  const distros: string[] = [];
  try {
    const res = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 1500
    });
    if (res.status === 0 && res.stdout) {
      const out = String(res.stdout);
      const defMatch = out.match(/^\s*DefaultDistribution\s+REG_SZ\s+(\{[^\r\n]+\})/im);
      const defaultGuid = defMatch ? defMatch[1].trim().toLowerCase() : '';
      const byGuid = new Map<string, string>();
      const blocks = out.split(/\r?\n(?=\s*HKEY_CURRENT_USER\\)/i);
      for (const blk of blocks) {
        const hdrMatch = blk.match(/\\Lxss\\(\{[^\\\r\n]+\})\s*$/im);
        if (!hdrMatch) continue;
        const guid = hdrMatch[1].trim().toLowerCase();
        const nameMatch = blk.match(/^\s*DistributionName\s+REG_SZ\s+([^\r\n]+)/im);
        if (!nameMatch) continue;
        const name = nameMatch[1].trim();
        if (!name || /^docker-desktop/i.test(name) || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
        byGuid.set(guid, name);
      }
      if (defaultGuid && byGuid.has(defaultGuid)) {
        distros.push(byGuid.get(defaultGuid)!);
      } else {
        for (const name of byGuid.values()) {
          if (!distros.includes(name)) distros.push(name);
        }
      }
    }
  } catch {
    // ignore registry errors
  }
  cachedRegWslDistros = { distros, probedAt: now };
  return distros;
}

export function resolveWin32WslConversationsDirs(portFile: string, geminiSubDir: string): string[] {
  if (process.platform !== 'win32' || !portFile || !geminiSubDir) return [];
  const now = Date.now();
  if (now < wslUncBackoffUntil) return [];
  try {
    const wslStatePath = path.join(path.dirname(portFile), 'wsl_state.json');
    const fileSig = getFileMtimeSig(wslStatePath);
    const envDistro = String(process.env.ANTIGRAVITY_WSL_DISTRO || '').trim();
    const compositeSig = `${fileSig}|env:${envDistro}`;
    if (fileSig === '0:0' && !envDistro) {
      wslDirsCache.delete(wslStatePath);
      return [];
    }
    const cached = wslDirsCache.get(wslStatePath);
    if (
      cached &&
      cached.sig === compositeSig &&
      ((cached.dirs.length > 0 && now - cached.probedAt < 60000) || now - cached.probedAt < 15000)
    ) {
      return cached.dirs;
    }

    let wslState: Record<string, unknown> = {};
    if (fileSig !== '0:0') {
      try {
        wslState = JSON.parse(fs.readFileSync(wslStatePath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      } catch {
        wslState = {};
      }
    }
    const persistedDistro = String(
      wslState?.distro || wslState?.distroName || wslState?.defaultDistro || ''
    ).trim();
    const rawDistro = persistedDistro || envDistro;
    let candidateDistros: string[] = [];
    if (rawDistro) {
      if (/^[A-Za-z0-9._-]+$/.test(rawDistro)) candidateDistros = [rawDistro];
    } else if (fileSig !== '0:0') {
      candidateDistros = resolveWslDistrosFromRegistry();
    }
    if (candidateDistros.length === 0) {
      wslDirsCache.set(wslStatePath, { sig: compositeSig, distro: '', dirs: [], probedAt: now });
      return [];
    }

    const t0 = Date.now();
    const subParts = geminiSubDir.split('/');
    const found: string[] = [];
    outer: for (const distro of candidateDistros) {
      for (const uncHost of ['wsl.localhost', 'wsl$']) {
        const distroRoot = `\\\\${uncHost}\\${distro}`;
        if (!fs.existsSync(distroRoot)) {
          if (Date.now() - t0 > 400) break outer;
          continue;
        }
        const homeRoot = path.join(distroRoot, 'home');
        if (fs.existsSync(homeRoot)) {
          try {
            for (const userEntry of fs.readdirSync(homeRoot)) {
              const convDir = path.join(homeRoot, userEntry, ...subParts, 'conversations');
              if (fs.existsSync(convDir)) found.push(convDir);
            }
          } catch {
            // ignore
          }
        }
        const rootConvDir = path.join(distroRoot, 'root', ...subParts, 'conversations');
        if (fs.existsSync(rootConvDir)) found.push(rootConvDir);
        if (Date.now() - t0 > 400) break outer;
        if (found.length > 0) break outer;
      }
      if (Date.now() - t0 > 400) break;
    }
    if (Date.now() - t0 > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
    }
    const uniqueDirs = Array.from(new Set(found));
    wslDirsCache.set(wslStatePath, {
      sig: compositeSig,
      distro: candidateDistros.join(','),
      dirs: uniqueDirs,
      probedAt: Date.now()
    });
    return uniqueDirs;
  } catch {
    wslUncBackoffUntil = Date.now() + 45000;
    return [];
  }
}

export function getCachedWslDirsForPortFile(portFile?: string): string[] {
  if (process.platform !== 'win32' || !portFile) return [];
  const cached = wslDirsCache.get(path.join(path.dirname(portFile), 'wsl_state.json'));
  return cached?.dirs ?? [];
}

function getDbStatByPath(dbPath: string): { dbPath: string; mtimeMs: number; sig: string } | null {
  try {
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    return {
      dbPath,
      mtimeMs: Math.max(st.mtimeMs || 0, wst ? wst.mtimeMs || 0 : 0),
      sig: `${st.mtimeMs}:${st.size}|${walSig}`
    };
  } catch {
    return null;
  }
}

export function resolveConversationDbPath(
  cascadeId: string,
  endpointOrDir: string | string[] | ChannelEndpoint
): string {
  if (!cascadeId || !endpointOrDir) return '';
  if (Array.isArray(endpointOrDir)) {
    const dirs = endpointOrDir.filter(Boolean);
    for (const d of dirs) {
      const candidate = path.join(d, `${cascadeId}.db`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return dirs.length > 0 ? path.join(dirs[0], `${cascadeId}.db`) : '';
  }
  if (typeof endpointOrDir === 'string') {
    return path.join(endpointOrDir, `${cascadeId}.db`);
  }

  const primaryDir = endpointOrDir.conversationsDir || '';
  const cacheKey = `${endpointOrDir.channel || 'default'}|${primaryDir}|${cascadeId}`;
  const cachedPath = resolvedCascadeDbCache.get(cacheKey);
  if (cachedPath) {
    const cachedUnc = isUncPath(cachedPath);
    if (cachedUnc && Date.now() < wslUncBackoffUntil) {
      return cachedPath;
    }
    const tCheck = Date.now();
    const exists = fs.existsSync(cachedPath);
    if (cachedUnc && Date.now() - tCheck > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
    }
    if (exists) return cachedPath;
    resolvedCascadeDbCache.delete(cacheKey);
  }

  const remember = (foundPath: string): string => {
    negativeCascadeWslCache.delete(cacheKey);
    setBoundedMap(resolvedCascadeDbCache, cacheKey, foundPath, 64);
    return foundPath;
  };

  if (primaryDir) {
    const primaryCandidate = path.join(primaryDir, `${cascadeId}.db`);
    if (fs.existsSync(primaryCandidate)) {
      return remember(primaryCandidate);
    }
  }

  const now = Date.now();
  if (
    process.platform === 'win32' &&
    !endpointOrDir.explicitConvDir &&
    endpointOrDir.portFile &&
    now >= wslUncBackoffUntil &&
    (negativeCascadeWslCache.get(cacheKey) || 0) <= now
  ) {
    const t0 = Date.now();
    const wslDirs = resolveWin32WslConversationsDirs(
      endpointOrDir.portFile,
      endpointOrDir.geminiSubDir || '.gemini/antigravity'
    );
    for (const dir of wslDirs) {
      const wslCandidate = path.join(dir, `${cascadeId}.db`);
      if (fs.existsSync(wslCandidate)) {
        return remember(wslCandidate);
      }
      if (Date.now() - t0 > 400) break;
    }
    if (Date.now() - t0 > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
    }
    if (negativeCascadeWslCache.size >= 128) negativeCascadeWslCache.clear();
    negativeCascadeWslCache.set(cacheKey, Date.now() + 10000);
  }

  return primaryDir ? path.join(primaryDir, `${cascadeId}.db`) : '';
}

export function getDbState(
  cascadeId: string,
  endpointOrDir: string | string[] | ChannelEndpoint
): DbState | null {
  try {
    const dbPath = resolveConversationDbPath(cascadeId, endpointOrDir);
    if (!dbPath) return null;
    const unc = isUncPath(dbPath);
    if (unc && Date.now() < wslUncBackoffUntil) {
      const prev = lastKnownDbStateCache.get(dbPath);
      return prev
        ? { ...prev, uncDeferred: true }
        : { dbPath, rawSig: 'unc_deferred', sig: `${dbPath}#unc_deferred`, uncDeferred: true };
    }
    const t0 = Date.now();
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (unc && Date.now() - t0 > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
    }
    if (!st) {
      lastKnownDbStateCache.delete(dbPath);
      return null;
    }
    let wst: fs.Stats | undefined;
    if (!unc || Date.now() >= wslUncBackoffUntil) {
      wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
      if (unc && Date.now() - t0 > 400) {
        wslUncBackoffUntil = Date.now() + 45000;
      }
    }
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    const rawSig = `${st.mtimeMs}:${st.size}|${walSig}`;
    const stateObj: DbState = { dbPath, rawSig, sig: `${dbPath}#${rawSig}` };
    setBoundedMap(lastKnownDbStateCache, dbPath, stateObj, 64);
    return stateObj;
  } catch {
    return null;
  }
}

function canUseSqliteFileUri(): boolean {
  if (sqliteUriSupported !== null) return sqliteUriSupported;
  if (!DatabaseSyncCtor) return false;
  let probeDb: DatabaseSyncType | null = null;
  try {
    probeDb = new DatabaseSyncCtor('file::memory:', { readOnly: true });
    sqliteUriSupported = true;
  } catch {
    sqliteUriSupported = false;
  } finally {
    try {
      probeDb?.close();
    } catch {
      // ignore
    }
  }
  return sqliteUriSupported;
}

function buildSqliteImmutableUncUri(uncDbPath: string): string {
  let normalized = String(uncDbPath || '').replace(/\\/g, '/');
  if (normalized.startsWith('//?/UNC/')) {
    normalized = '//' + normalized.slice(8);
  }
  const encoded = normalized
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `file://${encoded}?immutable=1`;
}

function withReadOnlyDb<T>(dbPath: string, timeoutMs: number, fn: (db: DatabaseSyncType) => T): T {
  if (!DatabaseSyncCtor) {
    throw new Error('node:sqlite is not available (Node >= 22.13 required)');
  }
  if (!isUncPath(dbPath)) {
    const db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: timeoutMs });
    try {
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  const walPath = `${dbPath}-wal`;
  let hasActiveWal = false;
  try {
    const wst = fs.statSync(walPath, { throwIfNoEntry: false });
    hasActiveWal = Boolean(wst && wst.size > 0);
  } catch {
    hasActiveWal = false;
  }

  if (!hasActiveWal && canUseSqliteFileUri()) {
    let immDb: DatabaseSyncType | null = null;
    try {
      immDb = new DatabaseSyncCtor(buildSqliteImmutableUncUri(dbPath), { readOnly: true, timeout: timeoutMs });
      const out = fn(immDb);
      immDb.close();
      immDb = null;
      return out;
    } catch (err) {
      try {
        immDb?.close();
      } catch {
        // ignore
      }
      if (/no such table/i.test(String((err as Error)?.message || ''))) {
        throw err;
      }
    }
  }

  wslSqliteTmpSeq = (wslSqliteTmpSeq + 1) % 1000000;
  const tmpBase = path.join(
    os.tmpdir(),
    `ag-sl-sqlite-${process.pid}-${Date.now()}-${wslSqliteTmpSeq}.db`
  );
  let tmpDb: DatabaseSyncType | null = null;
  try {
    fs.copyFileSync(dbPath, tmpBase);
    if (hasActiveWal) {
      try {
        fs.copyFileSync(walPath, `${tmpBase}-wal`);
      } catch {
        // ignore
      }
    }
    tmpDb = new DatabaseSyncCtor(tmpBase, { readOnly: true, timeout: timeoutMs });
    return fn(tmpDb);
  } finally {
    try {
      tmpDb?.close();
    } catch {
      // ignore
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${tmpBase}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

function readTrajectoryLineage(dbPath: string): {
  ok: boolean;
  hasMeta?: boolean;
  permanentInvalid?: boolean;
  parentId: string;
  rootId: string;
} {
  try {
    return withReadOnlyDb(dbPath, 20, (db) => {
      const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (!row || !(row.data instanceof Uint8Array)) {
        return { ok: true, hasMeta: false, parentId: '', rootId: '' };
      }
      const meta = parseProto(row.data);
      const parentId = readUtf8(meta.get(5)).trim();
      const rootId = readUtf8(meta.get(6)).trim();
      return { ok: true, hasMeta: true, parentId, rootId };
    });
  } catch (err) {
    const msg = String((err as Error)?.message || '');
    if (/no such table/i.test(msg)) {
      return { ok: true, hasMeta: false, parentId: '', rootId: '' };
    }
    if (isUncPath(dbPath) && /locked|busy|malformed|disk i\/o|ebusy|eacces|enoent/i.test(msg)) {
      return { ok: false, parentId: '', rootId: '' };
    }
    if (!/locked|busy/i.test(msg)) {
      return { ok: true, hasMeta: false, permanentInvalid: true, parentId: '', rootId: '' };
    }
    return { ok: false, parentId: '', rootId: '' };
  }
}

function addAdjacencyEdge(map: Map<string, Set<string>>, key: string, childId: string): void {
  if (!key || !childId || key === childId) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(childId);
}

function removeAdjacencyEdge(map: Map<string, Set<string>>, key: string, childId: string): void {
  if (!key) return;
  const set = map.get(key);
  if (!set) return;
  set.delete(childId);
  if (set.size === 0) map.delete(key);
}

function setNodeLineage(dirState: DirLineageState, uuid: string, node: LineageNode): void {
  const prev = dirState.nodes.get(uuid);
  if (prev) {
    if (prev.parentId && prev.parentId !== node.parentId) {
      removeAdjacencyEdge(dirState.byParent, prev.parentId, uuid);
    }
    if (prev.rootId && prev.rootId !== node.rootId) {
      removeAdjacencyEdge(dirState.byRoot, prev.rootId, uuid);
    }
  }
  dirState.nodes.set(uuid, node);
  if (node.parentId) addAdjacencyEdge(dirState.byParent, node.parentId, uuid);
  if (node.rootId) addAdjacencyEdge(dirState.byRoot, node.rootId, uuid);
}

function deleteNodeLineage(dirState: DirLineageState, uuid: string): void {
  const prev = dirState.nodes.get(uuid);
  if (prev) {
    removeAdjacencyEdge(dirState.byParent, prev.parentId, uuid);
    removeAdjacencyEdge(dirState.byRoot, prev.rootId, uuid);
    dirState.nodes.delete(uuid);
  }
  dirState.noMetaPending.delete(uuid);
}

function rememberNoMetaPending(dirState: DirLineageState, uuid: string, statSig: string): void {
  setBoundedMap(dirState.noMetaPending, uuid, statSig, MAX_NO_META_PENDING_IDS);
}

function refreshLineageIndex(conversationsDir: string): {
  dirState: DirLineageState | null;
  isDraining: boolean;
  backoffSkipped: boolean;
} {
  if (!conversationsDir || !DatabaseSyncCtor) {
    return { dirState: null, isDraining: false, backoffSkipped: false };
  }
  let dirState = lineageStateByDir.get(conversationsDir);
  if (!dirState) {
    dirState = {
      dirMtimeMs: -1,
      scanningDirMtimeMs: -1,
      lastPendingScanAt: 0,
      unindexedQueue: [],
      unindexedSet: new Set(),
      noMetaPending: new Map(),
      nodes: new Map(),
      byParent: new Map(),
      byRoot: new Map()
    };
    lineageStateByDir.set(conversationsDir, dirState);
  }

  const unc = isUncPath(conversationsDir);
  const nowMs = Date.now();
  if (unc && nowMs < wslUncBackoffUntil) {
    return { dirState, isDraining: dirState.unindexedQueue.length > 0, backoffSkipped: true };
  }

  const dirSt = fs.statSync(conversationsDir, { throwIfNoEntry: false });
  if (!dirSt || !dirSt.isDirectory()) {
    return { dirState, isDraining: false, backoffSkipped: false };
  }

  const dirChanged = dirSt.mtimeMs !== dirState.dirMtimeMs && dirSt.mtimeMs !== dirState.scanningDirMtimeMs;
  const tWallStart = nowMs;
  let backoffSkipped = false;

  if (dirChanged) {
    let entries: string[];
    try {
      entries = fs.readdirSync(conversationsDir);
    } catch {
      if (unc && Date.now() - tWallStart > 400) {
        wslUncBackoffUntil = Date.now() + 45000;
        backoffSkipped = true;
      }
      return { dirState, isDraining: dirState.unindexedQueue.length > 0, backoffSkipped };
    }

    const seenIds = new Set<string>();
    let enqueued = false;
    for (const entry of entries) {
      if (unc && Date.now() - tWallStart > 400) {
        wslUncBackoffUntil = Date.now() + 45000;
        backoffSkipped = true;
        break;
      }
      const m = entry.match(DB_FILE_RE);
      if (!m) continue;
      const uuid = m[1];
      seenIds.add(uuid);
      const existingNode = dirState.nodes.get(uuid);
      if (existingNode?.hasMeta === true) continue;
      if (dirState.unindexedSet.has(uuid)) continue;

      const dbPath = path.join(conversationsDir, entry);
      const statInfo = getDbStatByPath(dbPath);
      if (!statInfo) continue;

      if (existingNode && existingNode.statSig === statInfo.sig) continue;
      if (dirState.noMetaPending.get(uuid) === statInfo.sig) continue;

      dirState.unindexedQueue.push({ uuid, dbPath, mtimeMs: statInfo.mtimeMs, statSig: statInfo.sig });
      dirState.unindexedSet.add(uuid);
      enqueued = true;
    }

    if (!backoffSkipped) {
      for (const existingId of Array.from(dirState.nodes.keys())) {
        if (!seenIds.has(existingId)) deleteNodeLineage(dirState, existingId);
      }
      if (dirState.unindexedQueue.length > 0) {
        const nextQueue: typeof dirState.unindexedQueue = [];
        for (const item of dirState.unindexedQueue) {
          if (seenIds.has(item.uuid)) {
            nextQueue.push(item);
          } else {
            dirState.unindexedSet.delete(item.uuid);
          }
        }
        if (enqueued || nextQueue.length !== dirState.unindexedQueue.length) {
          nextQueue.sort((a, b) => b.mtimeMs - a.mtimeMs);
        }
        dirState.unindexedQueue = nextQueue;
      }
      dirState.scanningDirMtimeMs = dirSt.mtimeMs;
    } else if (enqueued && dirState.unindexedQueue.length > 1) {
      dirState.unindexedQueue.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
  } else if (dirState.unindexedQueue.length === 0) {
    const pendingRescanMs = unc ? NO_META_RESCAN_UNC_MS : NO_META_RESCAN_LOCAL_MS;
    if (dirState.noMetaPending.size > 0 && nowMs - dirState.lastPendingScanAt >= pendingRescanMs) {
      dirState.lastPendingScanAt = nowMs;
      const newlyChanged: typeof dirState.unindexedQueue = [];
      for (const [uuid, prevSig] of Array.from(dirState.noMetaPending.entries())) {
        if (unc && Date.now() - tWallStart > 400) {
          wslUncBackoffUntil = Date.now() + 45000;
          backoffSkipped = true;
          break;
        }
        if (dirState.nodes.get(uuid)?.hasMeta) {
          dirState.noMetaPending.delete(uuid);
          continue;
        }
        const dbPath = path.join(conversationsDir, `${uuid}.db`);
        const statInfo = getDbStatByPath(dbPath);
        if (!statInfo) {
          dirState.noMetaPending.delete(uuid);
          continue;
        }
        if (statInfo.sig !== prevSig && !dirState.unindexedSet.has(uuid)) {
          newlyChanged.push({ uuid, dbPath, mtimeMs: statInfo.mtimeMs, statSig: statInfo.sig });
          dirState.unindexedSet.add(uuid);
        }
      }
      if (newlyChanged.length > 0) {
        newlyChanged.sort((a, b) => b.mtimeMs - a.mtimeMs);
        dirState.unindexedQueue.push(...newlyChanged);
      }
    }
  }

  if (dirState.unindexedQueue.length === 0) {
    if (!backoffSkipped && dirState.scanningDirMtimeMs >= 0) {
      dirState.dirMtimeMs = dirState.scanningDirMtimeMs;
    }
    return { dirState, isDraining: false, backoffSkipped };
  }

  if (backoffSkipped || (unc && Date.now() < wslUncBackoffUntil)) {
    return { dirState, isDraining: dirState.unindexedQueue.length > 0, backoffSkipped: true };
  }

  const tPerfStart = performance.now();
  const maxTickOpens = unc ? LINEAGE_TICK_MAX_OPENS_UNC : LINEAGE_TICK_MAX_OPENS;
  let opens = 0;
  let qIdx = 0;
  const busyRetry: typeof dirState.unindexedQueue = [];

  while (qIdx < dirState.unindexedQueue.length) {
    if (opens > 0 && (opens >= maxTickOpens || performance.now() - tPerfStart >= LINEAGE_TICK_MAX_MS)) {
      break;
    }
    if (unc && Date.now() - tWallStart > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
      backoffSkipped = true;
      break;
    }
    const item = dirState.unindexedQueue[qIdx++];
    dirState.unindexedSet.delete(item.uuid);
    opens += 1;
    const res = readTrajectoryLineage(item.dbPath);
    if (res.ok) {
      if (res.hasMeta) {
        dirState.noMetaPending.delete(item.uuid);
        setNodeLineage(dirState, item.uuid, {
          hasMeta: true,
          parentId: res.parentId,
          rootId: res.rootId,
          statSig: item.statSig
        });
      } else {
        setNodeLineage(dirState, item.uuid, {
          hasMeta: false,
          parentId: '',
          rootId: '',
          statSig: item.statSig
        });
        if (!res.permanentInvalid) {
          rememberNoMetaPending(dirState, item.uuid, item.statSig);
          dirState.lastPendingScanAt = Date.now();
        } else {
          dirState.noMetaPending.delete(item.uuid);
        }
      }
    } else {
      busyRetry.push(item);
      dirState.unindexedSet.add(item.uuid);
    }
  }

  if (qIdx > 0 || busyRetry.length > 0) {
    const remaining = dirState.unindexedQueue.slice(qIdx);
    if (busyRetry.length > 0) remaining.push(...busyRetry);
    dirState.unindexedQueue = remaining;
  }

  if (unc && !backoffSkipped && Date.now() - tWallStart > 400) {
    wslUncBackoffUntil = Date.now() + 45000;
    backoffSkipped = true;
  }

  if (dirState.unindexedQueue.length === 0 && !backoffSkipped && dirState.scanningDirMtimeMs >= 0) {
    dirState.dirMtimeMs = dirState.scanningDirMtimeMs;
  }

  return { dirState, isDraining: dirState.unindexedQueue.length > 0, backoffSkipped };
}

function findDescendantIds(cascadeId: string, dirState: DirLineageState | null): string[] {
  if (!dirState) return [];
  const visited = new Set<string>([cascadeId]);
  const queue: string[] = [];

  const selfNode = dirState.nodes.get(cascadeId);
  if (!selfNode || !selfNode.parentId) {
    const rootSet = dirState.byRoot.get(cascadeId);
    if (rootSet) {
      for (const id of rootSet) {
        if (id === cascadeId || visited.has(id)) continue;
        visited.add(id);
        queue.push(id);
      }
    }
  }

  const directSet = dirState.byParent.get(cascadeId);
  if (directSet) {
    for (const id of directSet) {
      if (id === cascadeId || visited.has(id)) continue;
      visited.add(id);
      queue.push(id);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const curId = queue[qi++];
    const nextSet = dirState.byParent.get(curId);
    if (!nextSet) continue;
    for (const id of nextSet) {
      if (id === cascadeId || visited.has(id)) continue;
      visited.add(id);
      queue.push(id);
    }
  }

  queue.sort();
  return queue;
}

export function getCompositeChildSnapshot(
  cascadeId: string,
  conversationsDir: string,
  parentSig = ''
): ChildSnapshot {
  if (!cascadeId || !UUID_RE.test(cascadeId) || !conversationsDir) {
    return {
      conversationsDir: '',
      descendantIds: [],
      childSigs: new Map(),
      isDraining: false,
      partialStale: false,
      sig: parentSig
    };
  }

  const { dirState, isDraining, backoffSkipped } = refreshLineageIndex(conversationsDir);
  const descendantIds = findDescendantIds(cascadeId, dirState);
  const childSigs = new Map<string, string>();
  const childSigParts: string[] = [];
  let partialStale = Boolean(backoffSkipped);
  const unc = isUncPath(conversationsDir);
  const t0 = Date.now();

  if (unc && Date.now() < wslUncBackoffUntil) {
    partialStale = true;
    for (const cid of descendantIds) {
      const prev = childMetricsCache.get(path.join(conversationsDir, `${cid}.db`))?.sig || '';
      childSigs.set(cid, prev || 'unc_deferred');
      childSigParts.push(`${cid}=${prev || '0:0|0:0'}`);
    }
  } else {
    for (const cid of descendantIds) {
      if (unc && (Date.now() < wslUncBackoffUntil || Date.now() - t0 > 400)) {
        if (Date.now() >= wslUncBackoffUntil) wslUncBackoffUntil = Date.now() + 45000;
        partialStale = true;
        const prev = childMetricsCache.get(path.join(conversationsDir, `${cid}.db`))?.sig || '';
        childSigs.set(cid, prev || 'unc_deferred');
        childSigParts.push(`${cid}=${prev || '0:0|0:0'}`);
        continue;
      }
      const statInfo = getDbStatByPath(path.join(conversationsDir, `${cid}.db`));
      if (unc && Date.now() - t0 > 400) {
        wslUncBackoffUntil = Date.now() + 45000;
        partialStale = true;
      }
      childSigs.set(cid, statInfo ? statInfo.sig : 'missing');
      childSigParts.push(`${cid}=${statInfo ? statInfo.sig : '0:0|0:0'}`);
    }
  }

  const uncBackoffActive = Boolean(unc && Date.now() < wslUncBackoffUntil);
  return {
    conversationsDir,
    descendantIds,
    childSigs,
    isDraining: Boolean(isDraining),
    partialStale,
    uncBackoffActive,
    sig: `${parentSig}|children:${childSigParts.join(',')}${isDraining ? '|draining' : ''}${partialStale ? '|stale' : ''}`
  };
}

export function parseGenMetadataRow(row: { idx: number; data: Uint8Array }): GenRowMetrics {
  const top = parseProto(row.data);
  const chatRaw = top.get(1);
  const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map<number, number | Uint8Array>();
  const usageRaw = chat.get(4);
  const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map<number, number | Uint8Array>();
  const chatStartRaw = chat.get(9);
  const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map<number, number | Uint8Array>();
  const ctxWinRaw = chatStart.get(10);
  const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map<number, number | Uint8Array>();
  const maxCtxRaw = ctxWin.get(4);
  const maxCtx = typeof maxCtxRaw === 'number' ? maxCtxRaw : 0;

  let hasCtxBreakdown = false;
  let ctxBreakdownSys = 0;
  let ctxBreakdownToolDefs = 0;
  let ctxBreakdownToolCalls = 0;
  let ctxBreakdownModel = 0;
  let ctxBreakdownUser = 0;
  const tbRaw = ctxWin.get(3);
  if (tbRaw instanceof Uint8Array && tbRaw.length > 0) {
    const categories = parseProtoRepeated(tbRaw, 1);
    for (const catBuf of categories) {
      const cat = parseProto(catBuf);
      const kind = typeof cat.get(2) === 'number' ? Number(cat.get(2)) : 0;
      const toks = typeof cat.get(4) === 'number' ? Number(cat.get(4)) : 0;
      const name = readUtf8(cat.get(1)).toLowerCase();
      if (kind === 1 || kind === 3 || kind === 8 || /system|rule|memor|guide/i.test(name)) {
        if (toks > 0) ctxBreakdownSys += toks;
      } else if (
        kind === 2 ||
        kind === 4 ||
        kind === 5 ||
        kind === 6 ||
        kind === 9 ||
        /tool|mcp|skill|plugin|subagent/i.test(name)
      ) {
        if (toks > 0) ctxBreakdownToolDefs += toks;
      } else {
        const subs = parseProtoRepeated(catBuf, 5);
        if (subs.length > 0) {
          let subSum = 0;
          for (const subBuf of subs) {
            const sub = parseProto(subBuf);
            const stoks = typeof sub.get(3) === 'number' ? Number(sub.get(3)) : 0;
            if (stoks <= 0) continue;
            subSum += stoks;
            const rawLbl = readUtf8(sub.get(1));
            const colonIdx = rawLbl.indexOf(':');
            const stepTag = (colonIdx >= 0 ? rawLbl.slice(colonIdx + 1) : rawLbl).trim().toUpperCase();
            if (stepTag === 'SYSTEM_MESSAGE' || stepTag.includes('SYSTEM')) {
              ctxBreakdownSys += stoks;
            } else if (stepTag === 'GENERIC' || stepTag.includes('TOOL')) {
              ctxBreakdownToolCalls += stoks;
            } else if (stepTag === 'USER_INPUT' || stepTag.startsWith('USER')) {
              ctxBreakdownUser += stoks;
            } else {
              ctxBreakdownModel += stoks;
            }
          }
          if (toks > subSum) {
            ctxBreakdownModel += toks - subSum;
          }
        } else if (toks > 0) {
          ctxBreakdownModel += toks;
        }
      }
    }
    hasCtxBreakdown =
      ctxBreakdownSys + ctxBreakdownToolDefs + ctxBreakdownToolCalls + ctxBreakdownModel + ctxBreakdownUser > 0;
  }

  const ttftRaw = chat.get(11);
  const ttftMap = ttftRaw instanceof Uint8Array ? parseProto(ttftRaw) : new Map<number, number | Uint8Array>();
  const streamRaw = chat.get(12);
  const streamMap = streamRaw instanceof Uint8Array ? parseProto(streamRaw) : new Map<number, number | Uint8Array>();

  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const inTok = num(usage.get(2));
  const outTok = num(usage.get(3));
  const cacheWrite = num(usage.get(4));
  const cacheRead = num(usage.get(5));
  const thinkTok = num(usage.get(9));
  const respTok = num(usage.get(10));
  const ttft = num(ttftMap.get(1)) + num(ttftMap.get(2)) / 1e9;
  const stream = num(streamMap.get(1)) + num(streamMap.get(2)) / 1e9;
  const modelEnum = num(chat.get(3));
  const modelId = readUtf8(chat.get(19)).trim();
  const modelDisplay = readUtf8(chat.get(21)).trim();

  return {
    idx: row.idx,
    inTok,
    outTok,
    cacheRead,
    cacheWrite,
    ctx: inTok + cacheRead + cacheWrite,
    maxCtx,
    hasCtxBreakdown,
    ctxBreakdownSys,
    ctxBreakdownToolDefs,
    ctxBreakdownToolCalls,
    ctxBreakdownModel,
    ctxBreakdownUser,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream,
    modelEnum,
    modelId,
    modelDisplay
  };
}

export function classifyModelMetadata(
  modelId: string,
  modelDisplay: string,
  modelEnum: number = 0
): {
  isOrchestrator: boolean;
  phase: OrchestratorPhase;
  shortModel: string;
  effort: string;
} {
  const disp = String(modelDisplay || '').trim();
  const mid = String(modelId || '').trim();

  const isOrchestrator = Boolean(
    /orchestrator/i.test(disp) ||
      /orchestrator|-worker-agy/i.test(mid) ||
      modelEnum === 1667 ||
      modelEnum === 1537 ||
      modelEnum === 1669
  );

  if (isOrchestrator) {
    const isExec = Boolean(
      /worker|flash/i.test(mid) ||
        modelEnum === 1669 ||
        (/\(orchestrator\)/i.test(disp) && !/^orchestrator\b/i.test(disp))
    );
    const phase: OrchestratorPhase = isExec ? 'exec' : 'plan';
    let shortModel = '';
    if (!isExec) {
      const m = disp.match(/orchestrator\s*\(([^)]+)\)/i);
      if (m && m[1]) {
        shortModel = m[1].trim();
      } else if (/neon/i.test(mid)) {
        shortModel = 'Neon';
      } else {
        shortModel = 'Carbon';
      }
    } else {
      shortModel = disp
        .replace(/\bGemini\b/gi, '')
        .replace(/\(Orchestrator\)/gi, '')
        .replace(/\b\d+(?:\.\d+)?\b/g, '')
        .replace(/[()]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');
      if (!shortModel) {
        shortModel = /flash/i.test(mid) ? 'Flash' : 'Worker';
      }
    }
    return { isOrchestrator: true, phase, shortModel, effort: '' };
  }

  let effort = '';
  const parenMatch = disp.match(/\(([^)]+)\)\s*$/);
  if (parenMatch && parenMatch[1]) {
    const rawEff = parenMatch[1].trim();
    if (/^extra\s*high$|^xhigh$/i.test(rawEff)) effort = 'XHigh';
    else if (/^high$/i.test(rawEff)) effort = 'High';
    else if (/^med(?:ium)?$/i.test(rawEff)) effort = 'Med';
    else if (/^low$/i.test(rawEff)) effort = 'Low';
    else if (/^min(?:imal)?$/i.test(rawEff)) effort = 'Min';
    else if (/^max$/i.test(rawEff)) effort = 'Max';
  }

  let shortModel = disp
    .replace(/\(([^)]+)\)\s*$/, '')
    .replace(/\bGemini\b/gi, '')
    .replace(/\bClaude\b/gi, '')
    .replace(/\bThinking\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

  if (!shortModel) {
    shortModel = mid;
  }

  return { isOrchestrator: false, phase: '', shortModel, effort };
}

function loadChildScalarMetrics(
  childId: string,
  conversationsDir: string,
  knownStatSig: string | null,
  allowUncachedOpen: boolean
): {
  exists: boolean;
  fromCache?: boolean;
  deferred?: boolean;
  transientError?: boolean;
  staleMetrics?: ChildScalarMetrics | null;
  metrics?: ChildScalarMetrics;
} {
  if (knownStatSig === 'missing') return { exists: false };
  const dbPath = path.join(conversationsDir, `${childId}.db`);
  const cached = childMetricsCache.get(dbPath);
  if (knownStatSig === 'unc_deferred') {
    return { exists: true, deferred: true, staleMetrics: cached || null };
  }
  if (!knownStatSig && !allowUncachedOpen) {
    return { exists: true, deferred: true, staleMetrics: cached || null };
  }
  const sig = knownStatSig || getDbStatByPath(dbPath)?.sig || '';
  if (!sig) return { exists: false };

  if (cached && cached.sig === sig) {
    setBoundedMap(childMetricsCache, dbPath, cached, MAX_CHILD_METRICS_CACHE_SIZE);
    return { exists: true, fromCache: true, metrics: cached };
  }
  if (!allowUncachedOpen) {
    return { exists: true, deferred: true, staleMetrics: cached || null };
  }

  try {
    return withReadOnlyDb(dbPath, 20, (db) => {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all() as Array<{
        idx: number;
        data: Uint8Array;
      }>;
      let calls = 0;
      let totalIn = 0;
      let totalCache = 0;
      let totalOut = 0;
      let totalThink = 0;
      let totalResp = 0;
      for (const r of rows) {
        if (!(r.data instanceof Uint8Array)) continue;
        const p = parseGenMetadataRow({ idx: Number(r.idx), data: r.data });
        if (p.ctx > 0 || p.outTok > 0) {
          calls += 1;
          totalIn += p.inTok;
          totalCache += p.cacheRead;
          totalOut += p.outTok;
          totalThink += p.thinkTok;
          totalResp += p.respTok;
        }
      }
      const entry: ChildScalarMetrics = {
        sig,
        hasData: calls > 0,
        calls,
        totalIn,
        totalCache,
        totalOut,
        totalThink,
        totalResp
      };
      setBoundedMap(childMetricsCache, dbPath, entry, MAX_CHILD_METRICS_CACHE_SIZE);
      return { exists: true, fromCache: false, metrics: entry };
    });
  } catch (err) {
    const msg = String((err as Error)?.message || '');
    if (
      /locked|busy/i.test(msg) ||
      (isUncPath(dbPath) && /malformed|disk i\/o|ebusy|eacces|enoent/i.test(msg))
    ) {
      return { exists: true, fromCache: false, transientError: true, staleMetrics: cached || null };
    }
    const emptyEntry: ChildScalarMetrics = {
      sig,
      hasData: false,
      calls: 0,
      totalIn: 0,
      totalCache: 0,
      totalOut: 0,
      totalThink: 0,
      totalResp: 0
    };
    setBoundedMap(childMetricsCache, dbPath, emptyEntry, MAX_CHILD_METRICS_CACHE_SIZE);
    return { exists: true, fromCache: false, metrics: emptyEntry };
  }
}

function emptySessionMetrics(
  cascadeId: string,
  extra: Partial<SessionMetrics> = {}
): SessionMetrics {
  return {
    cascadeId,
    hasData: false,
    lastGenIdx: 0,
    ctxTokens: 0,
    contextLimitTokens: 256000,
    ctxPct: 0,
    remainCtxTokens: 256000,
    lastInTok: 0,
    lastCacheRead: 0,
    lastOutTok: 0,
    lastThinkTok: 0,
    lastRespTok: 0,
    lastCacheRate: 0,
    sessionCacheRate: 0,
    totalIn: 0,
    totalCache: 0,
    totalOut: 0,
    totalThink: 0,
    totalResp: 0,
    userTurns: 0,
    validCalls: 0,
    turnSteps: 0,
    turnOut: 0,
    turnThink: 0,
    turnResp: 0,
    turnDur: 0,
    useStreamTps: false,
    rawStreamTps: 0,
    e2eTps: 0,
    tps: 0,
    ttft: 0,
    streamDur: 0,
    totDur: 0,
    subagentCount: 0,
    subagentCalls: 0,
    subagentIn: 0,
    subagentCache: 0,
    subagentOut: 0,
    descendantCount: 0,
    activeModelId: '',
    activeModelDisplay: '',
    activeShortModel: '',
    activeEffort: '',
    isOrchestrator: false,
    orchestratorPhase: '',
    orchPlanCalls: 0,
    orchPlanModel: '',
    orchPlanOut: 0,
    orchExecCalls: 0,
    orchExecModel: '',
    orchExecOut: 0,
    ...extra
  };
}

export function parseConversationMetrics(
  cascadeId: string,
  endpointOrDir: string | string[] | ChannelEndpoint,
  options: MetricsParseOptions = {},
  precomputedState: DbState | null = null,
  precomputedChildSnap: ChildSnapshot | null = null
): SessionMetrics | null {
  if (!DatabaseSyncCtor) return null;
  if (!cascadeId || !UUID_RE.test(cascadeId)) return null;
  const state = precomputedState || getDbState(cascadeId, endpointOrDir);
  if (!state || !state.dbPath || !state.sig) return emptySessionMetrics(cascadeId);

  const { dbPath, sig } = state;
  const conversationsDir = path.dirname(dbPath);
  const childSnap =
    precomputedChildSnap || getCompositeChildSnapshot(cascadeId, conversationsDir, state.rawSig || sig);
  const limitEpoch = `v2:${options.contextLimit ?? 256000}:${options.contextLimitOverride ?? 0}`;
  const compositeSig = `${childSnap?.sig || sig}|lim:${limitEpoch}`;

  const cached = metricsCache.get(dbPath);
  if (cached && cached.sig === compositeSig && !childSnap?.isDraining && !childSnap?.partialStale) {
    return cached.payload;
  }

  const uncParent = isUncPath(dbPath);
  if (uncParent && Date.now() < wslUncBackoffUntil) {
    const bestEffort = cached?.payload || lastBestEffortCache.get(dbPath) || null;
    if (bestEffort) {
      return { ...bestEffort, partialStale: true, uncBackoffActive: true };
    }
    return emptySessionMetrics(cascadeId, {
      transientError: true,
      uncBackoffActive: true,
      cachedMetrics: null
    });
  }

  const tParentWallStart = Date.now();
  try {
    const parentDbRes = withReadOnlyDb(dbPath, 200, (db) => {
      const metaStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata')
        .get() as { cnt?: number; maxIdx?: number } | undefined;
      const rowCount = Number(metaStat?.cnt ?? 0);
      const maxIdx = Number(metaStat?.maxIdx ?? -1);
      if (rowCount === 0 || maxIdx < 0) {
        return { empty: true as const };
      }

      const userStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS lastIdx FROM steps WHERE step_type = 14')
        .get() as { cnt?: number; lastIdx?: number } | undefined;
      const lastUserStepIdx = Number(userStat?.lastIdx ?? -1);
      const userStepsCount = Number(userStat?.cnt ?? 0);
      const turnStat = db
        .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 15 AND idx > ?')
        .get(lastUserStepIdx) as { cnt?: number } | undefined;
      const rawTurnSteps = Number(turnStat?.cnt ?? 0);

      let inc = incrementalMetricsMap.get(dbPath);
      if (
        inc &&
        (rowCount < inc.rowCount ||
          maxIdx < inc.maxIdx ||
          userStepsCount < inc.userStepsCount ||
          lastUserStepIdx < inc.lastUserStepIdx ||
          (lastUserStepIdx !== inc.lastUserStepIdx && userStepsCount <= inc.userStepsCount))
      ) {
        inc = undefined;
      }

      if (inc) {
        const startIdx = inc.maxIdx;
        const deltaRows = db
          .prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC')
          .all(startIdx) as Array<{ idx: number; data: Uint8Array }>;
        while (inc.items.length > 0 && inc.items[inc.items.length - 1].idx >= startIdx) {
          const popped = inc.items.pop()!;
          inc.totalIn -= popped.inTok + popped.cacheWrite;
          inc.totalCache -= popped.cacheRead;
          inc.totalOut -= popped.outTok;
          inc.totalThink -= popped.thinkTok;
          inc.totalResp -= popped.respTok;
        }
        while (inc.validItems.length > 0 && inc.validItems[inc.validItems.length - 1].idx >= startIdx) {
          inc.validItems.pop();
        }
        if (inc.items.length + deltaRows.length === rowCount) {
          for (const r of deltaRows) {
            if (!(r.data instanceof Uint8Array)) continue;
            const p = parseGenMetadataRow({ idx: Number(r.idx), data: r.data });
            inc.items.push(p);
            inc.totalIn += p.inTok + p.cacheWrite;
            inc.totalCache += p.cacheRead;
            inc.totalOut += p.outTok;
            inc.totalThink += p.thinkTok;
            inc.totalResp += p.respTok;
            if (p.ctx > 0 || p.outTok > 0) inc.validItems.push(p);
          }
          inc.rowCount = rowCount;
          inc.maxIdx = maxIdx;
          inc.userStepsCount = userStepsCount;
          inc.lastUserStepIdx = lastUserStepIdx;
        } else {
          inc = undefined;
        }
      }

      if (!inc) {
        const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all() as Array<{
          idx: number;
          data: Uint8Array;
        }>;
        const items: GenRowMetrics[] = [];
        const validItems: GenRowMetrics[] = [];
        let totalIn = 0;
        let totalCache = 0;
        let totalOut = 0;
        let totalThink = 0;
        let totalResp = 0;
        for (const r of rows) {
          if (!(r.data instanceof Uint8Array)) continue;
          const p = parseGenMetadataRow({ idx: Number(r.idx), data: r.data });
          items.push(p);
          totalIn += p.inTok + p.cacheWrite;
          totalCache += p.cacheRead;
          totalOut += p.outTok;
          totalThink += p.thinkTok;
          totalResp += p.respTok;
          if (p.ctx > 0 || p.outTok > 0) validItems.push(p);
        }
        inc = {
          rowCount: rows.length,
          maxIdx: rows.length > 0 ? Number(rows[rows.length - 1].idx) : -1,
          userStepsCount,
          lastUserStepIdx,
          items,
          validItems,
          totalIn,
          totalCache,
          totalOut,
          totalThink,
          totalResp
        };
      }

      return { empty: false as const, inc, userStepsCount, rawTurnSteps };
    });

    if (parentDbRes.empty) {
      incrementalMetricsMap.delete(dbPath);
      const emptyPayload = emptySessionMetrics(cascadeId, {
        sig: compositeSig,
        isDraining: Boolean(childSnap?.isDraining),
        partialStale: Boolean(childSnap?.partialStale)
      });
      if (!childSnap?.isDraining && !childSnap?.partialStale) {
        setMetricsCache(dbPath, { sig: compositeSig, payload: emptyPayload });
      }
      return emptyPayload;
    }

    const { inc, userStepsCount, rawTurnSteps } = parentDbRes;
    if (uncParent && Date.now() - tParentWallStart > 400) {
      wslUncBackoffUntil = Date.now() + 45000;
    }
    setBoundedMap(incrementalMetricsMap, dbPath, inc, MAX_METRICS_CACHE_SIZE);

    const { validItems: valid, totalIn, totalCache, totalOut, totalThink, totalResp } = inc;
    if (valid.length === 0) {
      const emptyPayload = emptySessionMetrics(cascadeId, {
        sig: compositeSig,
        isDraining: Boolean(childSnap?.isDraining),
        partialStale: Boolean(childSnap?.partialStale)
      });
      if (!childSnap?.isDraining && !childSnap?.partialStale) {
        setMetricsCache(dbPath, { sig: compositeSig, payload: emptyPayload });
      }
      return emptyPayload;
    }

    const descendantIds = childSnap?.descendantIds || [];
    const isDraining = Boolean(childSnap?.isDraining);
    let partialStale = Boolean(childSnap?.partialStale);
    let subagentCount = 0;
    let subagentCalls = 0;
    let subagentIn = 0;
    let subagentCache = 0;
    let subagentOut = 0;
    let childSqlOpens = 0;
    const tChildPerfStart = performance.now();
    const tChildWallStart = Date.now();
    const uncChildren = isUncPath(conversationsDir);
    const maxChildOpens = uncChildren ? LINEAGE_TICK_MAX_OPENS_UNC : LINEAGE_TICK_MAX_OPENS;

    for (const childId of descendantIds) {
      if (childId === cascadeId) continue;
      const knownChildSig = childSnap.childSigs?.get(childId) || null;
      const uncNowBlocked =
        uncChildren && (Date.now() < wslUncBackoffUntil || Date.now() - tChildWallStart > 400);
      if (uncChildren && Date.now() - tChildWallStart > 400 && Date.now() >= wslUncBackoffUntil) {
        wslUncBackoffUntil = Date.now() + 45000;
      }
      const allowUncachedOpen =
        !uncNowBlocked &&
        (childSqlOpens === 0 ||
          (childSqlOpens < maxChildOpens && performance.now() - tChildPerfStart < LINEAGE_TICK_MAX_MS));
      const childRes = loadChildScalarMetrics(childId, conversationsDir, knownChildSig, allowUncachedOpen);
      if (!childRes.exists) continue;
      if (!childRes.fromCache && !childRes.deferred) {
        childSqlOpens += 1;
        if (uncChildren && Date.now() - tChildWallStart > 400) {
          wslUncBackoffUntil = Date.now() + 45000;
        }
      }

      let cm: ChildScalarMetrics | null = null;
      if (childRes.deferred || childRes.transientError) {
        partialStale = true;
        if (childRes.staleMetrics && childRes.staleMetrics.hasData) {
          cm = childRes.staleMetrics;
        } else {
          continue;
        }
      } else if (childRes.metrics) {
        cm = childRes.metrics;
      }

      if (!cm || !cm.hasData) continue;
      subagentCount += 1;
      subagentCalls += cm.calls;
      subagentIn += cm.totalIn;
      subagentCache += cm.totalCache;
      subagentOut += cm.totalOut;
    }

    const turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
    const turnSteps = turnSlice.length;
    let turnOut = 0;
    let turnThink = 0;
    let turnResp = 0;
    let turnDur = 0;
    for (const item of turnSlice) {
      turnOut += item.outTok;
      turnThink += item.thinkTok;
      turnResp += item.respTok;
      turnDur += item.totDur;
    }

    const last = valid[valid.length - 1];
    const fallbackLimit = options.contextLimit && options.contextLimit > 0 ? options.contextLimit : 256000;
    const contextLimitTokens =
      options.contextLimitOverride && options.contextLimitOverride > 0
        ? options.contextLimitOverride
        : last.maxCtx > 0
          ? last.maxCtx
          : fallbackLimit;

    const visibleOut =
      last.respTok > 0
        ? last.respTok
        : last.thinkTok > 0
          ? Math.max(0, last.outTok - last.thinkTok)
          : last.outTok;
    const rawStreamTps = visibleOut > 0 && last.stream >= 0.5 ? visibleOut / last.stream : 0;
    const e2eTps = last.totDur > 0 ? last.outTok / last.totDur : 0;
    const streamRatio = last.totDur > 0 ? last.stream / last.totDur : 0;
    const useStreamTps =
      rawStreamTps > 0 &&
      rawStreamTps <= 600 &&
      (streamRatio >= 0.12 || (last.stream >= 1.5 && rawStreamTps <= 300));
    const tps = useStreamTps ? rawStreamTps : e2eTps;
    const ctxPct = Math.max(0, Math.min(100, Math.round((last.ctx / contextLimitTokens) * 100)));
    const lastCacheRate = last.ctx > 0 ? (last.cacheRead / last.ctx) * 100 : 0;
    const sessionCacheRate = totalIn + totalCache > 0 ? (totalCache / (totalIn + totalCache)) * 100 : 0;
    const remainCtxTokens = Math.max(0, contextLimitTokens - last.ctx);
    const uncBackoffActive = Boolean(
      childSnap?.uncBackoffActive || (uncParent && Date.now() < wslUncBackoffUntil)
    );

    let orchPlanCalls = 0;
    let orchPlanModel = '';
    let orchPlanOut = 0;
    let orchExecCalls = 0;
    let orchExecModel = '';
    let orchExecOut = 0;
    for (const item of valid) {
      const info = classifyModelMetadata(item.modelId, item.modelDisplay, item.modelEnum);
      if (!info.isOrchestrator) continue;
      if (info.phase === 'plan') {
        orchPlanCalls += 1;
        orchPlanOut += item.outTok;
        if (info.shortModel) orchPlanModel = info.shortModel;
      } else if (info.phase === 'exec') {
        orchExecCalls += 1;
        orchExecOut += item.outTok;
        if (info.shortModel) orchExecModel = info.shortModel;
      }
    }
    const lastModel = classifyModelMetadata(last.modelId, last.modelDisplay, last.modelEnum);
    let bdSource = last;
    if (!bdSource.hasCtxBreakdown) {
      for (let i = valid.length - 2; i >= 0; i--) {
        if (valid[i].hasCtxBreakdown) {
          bdSource = valid[i];
          break;
        }
      }
    }

    const payload: SessionMetrics = {
      cascadeId,
      hasData: true,
      sig: compositeSig,
      isDraining,
      partialStale,
      uncBackoffActive,
      lastGenIdx: last.idx,
      ctxTokens: last.ctx,
      contextLimitTokens,
      ctxPct,
      remainCtxTokens,
      hasCtxBreakdown: bdSource.hasCtxBreakdown,
      ctxBreakdownSys: bdSource.ctxBreakdownSys,
      ctxBreakdownToolDefs: bdSource.ctxBreakdownToolDefs,
      ctxBreakdownToolCalls: bdSource.ctxBreakdownToolCalls,
      ctxBreakdownModel: bdSource.ctxBreakdownModel,
      ctxBreakdownUser: bdSource.ctxBreakdownUser,
      lastInTok: last.inTok,
      lastCacheRead: last.cacheRead,
      lastOutTok: last.outTok,
      lastThinkTok: last.thinkTok,
      lastRespTok: last.respTok,
      lastCacheRate,
      sessionCacheRate,
      totalIn,
      totalCache,
      totalOut,
      totalThink,
      totalResp,
      userTurns: userStepsCount,
      validCalls: valid.length,
      turnSteps,
      turnOut,
      turnThink,
      turnResp,
      turnDur,
      useStreamTps,
      rawStreamTps,
      e2eTps,
      tps,
      ttft: last.ttft,
      streamDur: last.stream,
      totDur: last.totDur,
      subagentCount,
      subagentCalls,
      subagentIn,
      subagentCache,
      subagentOut,
      descendantCount: descendantIds.length,
      activeModelId: last.modelId,
      activeModelDisplay: last.modelDisplay,
      activeShortModel: lastModel.shortModel,
      activeEffort: lastModel.effort,
      isOrchestrator: lastModel.isOrchestrator,
      orchestratorPhase: lastModel.phase,
      orchPlanCalls,
      orchPlanModel,
      orchPlanOut,
      orchExecCalls,
      orchExecModel,
      orchExecOut
    };

    setBoundedMap(lastBestEffortCache, dbPath, payload, 64);
    if (!isDraining && !partialStale) {
      setMetricsCache(dbPath, { sig: compositeSig, payload });
    }
    return payload;
  } catch {
    return emptySessionMetrics(cascadeId, {
      transientError: true,
      cachedMetrics: cached?.payload || null
    });
  }
}
