import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripBom } from './config.js';
import type {
  ContextDetailBreakdown,
  CustomizationFileItem,
  GenRowMetrics,
  HeavyToolCallItem,
  McpServerSummaryItem,
  TurnGrowthPoint
} from './types.js';

interface TranscriptStepSummary {
  idx: number;
  type: string;
  source: string;
  replyChars: number;
  thinkChars: number;
  toolArgsChars: number;
  estTokens: number;
  toolCalls: Array<{ name: string; label: string; targetPath: string | null }>;
}

interface CachedTranscriptAnalysis {
  sig: string;
  lastCompactionStepIdx: number;
  checkpointCount: number;
  readFileRealPaths: Set<string>;
  replyChars: number;
  thinkChars: number;
  toolArgsChars: number;
  genericToolMap: Map<number, { stepIndex: number; toolName: string; label: string; path: string | null; estTokens: number }>;
  fallbackHeavyCalls: HeavyToolCallItem[];
  totalToolCalls: number;
}

interface CachedCustomizations {
  builtAt: number;
  rules: CustomizationFileItem[];
  activeRulesTokens: number;
  deferredRulesTokens: number;
  skills: CustomizationFileItem[];
  activeSkillsIndexTokens: number;
  loadedSkillsBodyTokens: number;
  deferredSkillsTokens: number;
  mcpServers: McpServerSummaryItem[];
  mcpManifestTokens: number;
  mcpInstructionsTokens: number;
  mcpLoadedTokens: number;
  mcpDeferredTokens: number;
}

const transcriptCache = new Map<string, CachedTranscriptAnalysis>();
const customizationCache = new Map<string, CachedCustomizations>();
const MAX_TRANSCRIPT_BYTES = 48 * 1024 * 1024;
const CUSTOMIZATION_TTL_MS = 4000;

export function clearInspectorCaches(): void {
  transcriptCache.clear();
  customizationCache.clear();
}

export function estTextTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const sample = len > 2000 ? text.slice(0, 2000) : text;
  let punct = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 58 || c === 34 || c === 60 || c === 62 || c === 92) {
      punct++;
    }
  }
  const charsPerTok = punct / sample.length > 0.08 ? 3.45 : 3.85;
  return Math.max(1, Math.ceil(len / charsPerTok));
}

export function uriToFsPath(uri: string): string | null {
  if (!uri || typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      try {
        const decoded = decodeURIComponent(trimmed.replace(/^file:\/\/\/?/, ''));
        return process.platform === 'win32' && /^[a-zA-Z]:/.test(decoded) ? decoded : `/${decoded}`;
      } catch {
        return null;
      }
    }
  }
  return path.isAbsolute(trimmed) ? trimmed : null;
}

export function normalizeWorkspacePathForMatch(rawPathOrUri: string): string {
  const fsPath = uriToFsPath(rawPathOrUri) ?? rawPathOrUri;
  if (!fsPath) return '';
  let norm = fsPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/[a-zA-Z]:\//.test(norm)) {
    norm = norm.slice(1);
  }
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(norm)) {
    norm = norm.toLowerCase();
  }
  return norm;
}

function safeRealpath(p: string): string | null {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

function safeReaddirWithTypes(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readTextSafe(p: string, maxBytes = 512 * 1024): { text: string | null; size: number } {
  const st = safeStat(p);
  if (!st || !st.isFile() || st.size > maxBytes) {
    return { text: null, size: st ? st.size : 0 };
  }
  try {
    return { text: stripBom(fs.readFileSync(p, 'utf8')), size: st.size };
  } catch {
    return { text: null, size: st.size };
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  const { text } = readTextSafe(p, 2 * 1024 * 1024);
  if (!text) return null;
  try {
    const clean = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseYamlFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx < 0) return { meta: {}, body: text };
  const rawMeta = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 4).trimStart();
  const meta: Record<string, string> = {};
  const lines = rawMeta.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '>-' || val === '>' || val === '|-' || val === '|') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        parts.push(lines[i].trim());
      }
      val = parts.join(' ');
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body };
}

function unquoteArg(v: unknown): string {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function describeToolCall(tc: Record<string, unknown>): { name: string; label: string; targetPath: string | null } {
  const name = typeof tc.name === 'string' && tc.name ? tc.name : 'tool';
  const args = tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)
    ? (tc.args as Record<string, unknown>)
    : {};
  const fileArg = unquoteArg(args.Path ?? args.AbsolutePath ?? args.TargetFile ?? '');
  if (fileArg) {
    return { name, label: `${name} (${path.basename(fileArg)})`, targetPath: fileArg };
  }
  const summary = unquoteArg(args.toolSummary ?? args.toolAction ?? '');
  if (summary) {
    return { name, label: `${name}: ${summary}`, targetPath: null };
  }
  if (name === 'run_command' && args.CommandLine) {
    const cmd = unquoteArg(args.CommandLine).replace(/\s+/g, ' ').slice(0, 42);
    return { name, label: `run_command: ${cmd}`, targetPath: null };
  }
  if (name === 'invoke_subagent' && args.TypeName) {
    const role = unquoteArg(args.Role ?? '');
    return { name, label: role ? `subagent: ${unquoteArg(args.TypeName)} (${role})` : `subagent: ${unquoteArg(args.TypeName)}`, targetPath: null };
  }
  return { name, label: name, targetPath: null };
}

function inferPathsFromDbPath(
  dbPath: string,
  explicitHome?: string
): { appDataDir: string | null; configDir: string | null } {
  const convDir = path.dirname(dbPath);
  let appDataDir: string | null = null;
  let inferredHome: string | null = explicitHome ?? null;

  if (path.basename(convDir).toLowerCase() === 'conversations') {
    const parent = path.dirname(convDir);
    if (safeStat(path.join(parent, 'brain')) || safeStat(path.join(parent, 'mcp'))) {
      appDataDir = parent;
    }
    const grandParent = path.dirname(parent);
    if (!inferredHome && path.basename(grandParent).toLowerCase() === '.gemini') {
      inferredHome = path.dirname(grandParent);
    }
  }

  const configDir = inferredHome ? path.join(inferredHome, '.gemini', 'config') : null;
  return { appDataDir, configDir };
}

function analyzeTranscriptCached(appDataDir: string | null, cascadeId: string): CachedTranscriptAnalysis | null {
  if (!appDataDir || !cascadeId) return null;
  const logsDir = path.join(appDataDir, 'brain', cascadeId, '.system_generated', 'logs');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const compactPath = path.join(logsDir, 'transcript.jsonl');
  const fullSt = safeStat(fullPath);
  const compactSt = safeStat(compactPath);
  const activePath = fullSt && fullSt.isFile() ? fullPath : compactSt && compactSt.isFile() ? compactPath : '';
  const activeSt = activePath === fullPath ? fullSt : compactSt;
  if (!activePath || !activeSt || activeSt.size <= 0 || activeSt.size > MAX_TRANSCRIPT_BYTES) {
    return null;
  }

  const sig = `${activePath}:${activeSt.mtimeMs}:${activeSt.size}`;
  const hit = transcriptCache.get(cascadeId);
  if (hit && hit.sig === sig) return hit;

  let raw = '';
  try {
    raw = fs.readFileSync(activePath, 'utf8');
  } catch {
    return null;
  }

  const parsedSteps: TranscriptStepSummary[] = [];
  let checkpointCount = 0;
  let lastCompactionArrayIdx = -1;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const s = JSON.parse(line) as Record<string, unknown>;
      if (!s || typeof s !== 'object') continue;
      const type = typeof s.type === 'string' ? s.type : '';
      const source = typeof s.source === 'string' ? s.source : '';
      const idx = typeof s.step_index === 'number' ? s.step_index : parsedSteps.length;
      const content = typeof s.content === 'string' ? s.content : '';
      const thinking = typeof s.thinking === 'string' ? s.thinking : '';
      const rawCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const toolCalls: Array<{ name: string; label: string; targetPath: string | null }> = [];
      for (const tc of rawCalls) {
        if (tc && typeof tc === 'object') {
          toolCalls.push(describeToolCall(tc as Record<string, unknown>));
        }
      }
      const toolArgsChars = rawCalls.length > 0 ? JSON.stringify(rawCalls).length : 0;
      const mediaCount = Array.isArray(s.media) ? s.media.length : 0;
      const estTokens = (content ? estTextTokens(content) : 0) + mediaCount * 258 + 6;

      if (type === 'CHECKPOINT') {
        checkpointCount++;
        lastCompactionArrayIdx = parsedSteps.length;
      }

      parsedSteps.push({
        idx,
        type,
        source,
        replyChars: content.length,
        thinkChars: thinking.length,
        toolArgsChars,
        estTokens,
        toolCalls
      });
    } catch {
      // ignore torn streaming JSONL line
    }
  }

  const readFileRealPaths = new Set<string>();
  let replyChars = 0;
  let thinkChars = 0;
  let toolArgsChars = 0;
  const genericToolMap = new Map<
    number,
    { stepIndex: number; toolName: string; label: string; path: string | null; estTokens: number }
  >();
  const allActiveCalls: HeavyToolCallItem[] = [];

  let activeCallQueue: Array<{ stepIndex: number; name: string; label: string; targetPath: string | null }> = [];

  for (let i = lastCompactionArrayIdx + 1; i < parsedSteps.length; i++) {
    const st = parsedSteps[i];
    if (st.type === 'PLANNER_RESPONSE') {
      replyChars += st.replyChars;
      thinkChars += st.thinkChars;
      toolArgsChars += st.toolArgsChars;
      activeCallQueue = st.toolCalls.map((tc) => {
        if ((tc.name === 'read_file' || tc.name === 'view_file') && tc.targetPath) {
          const real = safeRealpath(tc.targetPath);
          if (real) readFileRealPaths.add(real);
        }
        return {
          stepIndex: st.idx,
          name: tc.name,
          label: tc.label,
          targetPath: tc.targetPath
        };
      });
    } else if (st.type === 'GENERIC') {
      const matchedCall = activeCallQueue.shift();
      if (matchedCall) {
        const resolvedPath = matchedCall.targetPath ? safeRealpath(matchedCall.targetPath) ?? matchedCall.targetPath : null;
        const entry = {
          stepIndex: matchedCall.stepIndex,
          toolName: matchedCall.name,
          label: matchedCall.label,
          path: resolvedPath,
          estTokens: st.estTokens
        };
        genericToolMap.set(st.idx, entry);
        allActiveCalls.push({
          stepIndex: entry.stepIndex,
          toolName: entry.toolName,
          label: entry.label,
          path: entry.path,
          tokens: entry.estTokens
        });
      }
    }
  }

  const totalToolCalls = allActiveCalls.length;
  allActiveCalls.sort((a, b) => b.tokens - a.tokens);

  const result: CachedTranscriptAnalysis = {
    sig,
    lastCompactionStepIdx: lastCompactionArrayIdx >= 0 ? parsedSteps[lastCompactionArrayIdx].idx : -1,
    checkpointCount,
    readFileRealPaths,
    replyChars,
    thinkChars,
    toolArgsChars,
    genericToolMap,
    fallbackHeavyCalls: allActiveCalls.slice(0, 10),
    totalToolCalls
  };

  if (transcriptCache.size >= 24) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest !== undefined) transcriptCache.delete(oldest);
  }
  transcriptCache.set(cascadeId, result);
  return result;
}

function findMarkdownFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const entry of safeReaddirWithTypes(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    } else if (recursive && entry.isDirectory()) {
      out.push(...findMarkdownFiles(full, true));
    }
  }
  return out;
}

function collectEnabledPlugins(
  appDataDir: string | null,
  configDir: string | null,
  workspaceDirs: string[]
): Array<{ name: string; path: string }> {
  const enabledOverride = new Map<string, boolean>();
  if (configDir) {
    const hostCfg = readJsonSafe(path.join(configDir, 'config.json'));
    const pluginsObj = hostCfg?.plugins;
    if (pluginsObj && typeof pluginsObj === 'object' && !Array.isArray(pluginsObj)) {
      for (const [dirKey, val] of Object.entries(pluginsObj as Record<string, unknown>)) {
        if (val && typeof val === 'object' && typeof (val as { enabled?: unknown }).enabled === 'boolean') {
          enabledOverride.set(dirKey, Boolean((val as { enabled?: boolean }).enabled));
        }
      }
    }
  }

  const roots: string[] = [];
  for (const w of workspaceDirs) roots.push(path.join(w, '.agents', 'plugins'));
  if (configDir) roots.push(path.join(configDir, 'plugins'));
  if (appDataDir) roots.push(path.join(appDataDir, 'builtin', 'plugins'));

  const byName = new Map<string, { name: string; path: string }>();
  for (const root of roots) {
    for (const entry of safeReaddirWithTypes(root)) {
      if (!entry.isDirectory()) continue;
      const pPath = path.join(root, entry.name);
      const manifest = readJsonSafe(path.join(pPath, 'plugin.json'));
      if (!manifest) continue;
      const override = enabledOverride.get(entry.name);
      const isEnabled = override !== undefined ? override : manifest.disabled !== true;
      if (!isEnabled) continue;
      const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : entry.name;
      if (!byName.has(name)) {
        byName.set(name, { name, path: pPath });
      }
    }
  }
  return Array.from(byName.values());
}

function scanCustomizationsCached(
  appDataDir: string | null,
  configDir: string | null,
  workspaceUris: string[],
  readFileRealPaths: Set<string>
): CachedCustomizations {
  const workspaceDirs = workspaceUris
    .map(uriToFsPath)
    .filter((p): p is string => Boolean(p && safeStat(p)?.isDirectory()));

  const readSig = Array.from(readFileRealPaths).sort().join(',');
  const cacheKey = `${appDataDir || ''}|${configDir || ''}|${workspaceDirs.join(',')}|${readSig}`;
  const now = Date.now();
  const cached = customizationCache.get(cacheKey);
  if (cached && now - cached.builtAt < CUSTOMIZATION_TTL_MS) {
    return cached;
  }

  const plugins = collectEnabledPlugins(appDataDir, configDir, workspaceDirs);

  // 1. Rules
  const ruleCandidates: Array<{ filePath: string; scope: string; label: string }> = [];
  for (const w of workspaceDirs) {
    for (const fname of ['GEMINI.md', 'AGENTS.md']) {
      const f = path.join(w, fname);
      if (safeStat(f)?.isFile()) ruleCandidates.push({ filePath: f, scope: 'Workspace', label: fname });
    }
    for (const f of findMarkdownFiles(path.join(w, '.agents', 'rules'), true)) {
      ruleCandidates.push({ filePath: f, scope: 'Workspace', label: path.basename(f) });
    }
  }
  if (configDir) {
    for (const fname of ['GEMINI.md', 'AGENTS.md']) {
      const f = path.join(configDir, fname);
      if (safeStat(f)?.isFile()) ruleCandidates.push({ filePath: f, scope: 'Global', label: fname });
    }
    for (const f of findMarkdownFiles(path.join(configDir, 'rules'), true)) {
      ruleCandidates.push({ filePath: f, scope: 'Global', label: path.basename(f) });
    }
  }
  for (const p of plugins) {
    for (const f of findMarkdownFiles(path.join(p.path, 'rules'), true)) {
      ruleCandidates.push({ filePath: f, scope: `Plugin:${p.name}`, label: `${p.name}/${path.basename(f)}` });
    }
  }

  const seenRules = new Set<string>();
  const rules: CustomizationFileItem[] = [];
  let activeRulesTokens = 0;
  let deferredRulesTokens = 0;
  for (const rc of ruleCandidates) {
    const real = safeRealpath(rc.filePath);
    if (!real || seenRules.has(real)) continue;
    seenRules.add(real);
    const { text } = readTextSafe(real);
    if (text === null) continue;
    const { meta } = parseYamlFrontmatter(text);
    const trigger = meta.trigger || 'always_on';
    const loaded = trigger === 'always_on' || readFileRealPaths.has(real);
    const tokens = estTextTokens(text);
    if (loaded) activeRulesTokens += tokens;
    else deferredRulesTokens += tokens;
    rules.push({ name: rc.label, scope: rc.scope, path: real, tokens, loaded });
  }

  // 2. Skills
  const skillRoots: Array<{ dir: string; scope: string }> = [
    ...workspaceDirs.map((w) => ({ dir: path.join(w, '.agents', 'skills'), scope: 'Workspace' }))
  ];
  if (configDir) skillRoots.push({ dir: path.join(configDir, 'skills'), scope: 'Global' });
  for (const p of plugins) skillRoots.push({ dir: path.join(p.path, 'skills'), scope: `Plugin:${p.name}` });
  if (appDataDir) skillRoots.push({ dir: path.join(appDataDir, 'builtin', 'skills'), scope: 'Builtin' });

  const seenSkillNames = new Set<string>();
  const seenSkillPaths = new Set<string>();
  const skills: CustomizationFileItem[] = [];
  let activeSkillsIndexTokens = 0;
  let loadedSkillsBodyTokens = 0;
  let deferredSkillsTokens = 0;

  for (const sr of skillRoots) {
    for (const entry of safeReaddirWithTypes(sr.dir)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(sr.dir, entry.name, 'SKILL.md');
      const real = safeRealpath(skillFile);
      if (!real || seenSkillPaths.has(real)) continue;
      const { text } = readTextSafe(real);
      if (text === null) continue;
      const { meta, body } = parseYamlFrontmatter(text);
      const name = meta.name || entry.name;
      if (seenSkillNames.has(name)) continue;
      seenSkillNames.add(name);
      seenSkillPaths.add(real);

      const indexTokens = estTextTokens(`- ${name} (${skillFile}): ${meta.description || ''}`);
      const bodyTokens = estTextTokens(body);
      const loaded = readFileRealPaths.has(real);
      activeSkillsIndexTokens += indexTokens;
      if (loaded) loadedSkillsBodyTokens += bodyTokens;
      else deferredSkillsTokens += bodyTokens;
      skills.push({
        name,
        scope: sr.scope,
        path: real,
        tokens: indexTokens,
        secondaryTokens: bodyTokens,
        loaded
      });
    }
  }
  skills.sort((a, b) => Number(b.loaded) - Number(a.loaded) || (b.secondaryTokens || 0) - (a.secondaryTokens || 0));

  // 3. MCP Servers
  const mcpConfigs = new Map<string, { disabled: boolean; source: string }>();
  const ingestMcpCfg = (cfgPath: string, source: string, prefix = '') => {
    const cfg = readJsonSafe(cfgPath);
    const servers = cfg?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
    for (const [name, rawSrv] of Object.entries(servers as Record<string, unknown>)) {
      const fullName = prefix ? `${prefix}_${name}` : name;
      const disabled = Boolean(rawSrv && typeof rawSrv === 'object' && (rawSrv as { disabled?: unknown }).disabled);
      mcpConfigs.set(fullName, { disabled, source });
    }
  };
  if (configDir) ingestMcpCfg(path.join(configDir, 'mcp_config.json'), 'Global');
  for (const p of plugins) ingestMcpCfg(path.join(p.path, 'mcp_config.json'), `Plugin:${p.name}`, p.name);

  const mcpServers: McpServerSummaryItem[] = [];
  let mcpManifestTokens = 0;
  let mcpInstructionsTokens = 0;
  let mcpLoadedTokens = 0;
  let mcpDeferredTokens = 0;

  if (appDataDir) {
    const mcpRoot = path.join(appDataDir, 'mcp');
    for (const entry of safeReaddirWithTypes(mcpRoot)) {
      if (!entry.isDirectory()) continue;
      const serverName = entry.name;
      const serverDir = path.join(mcpRoot, serverName);
      const cfgInfo = mcpConfigs.get(serverName);
      const disabled = cfgInfo ? cfgInfo.disabled : false;

      let instTokens = 0;
      const instReal = safeRealpath(path.join(serverDir, 'instructions.md'));
      if (instReal) {
        const { text } = readTextSafe(instReal, 256 * 1024);
        if (text) instTokens = estTextTokens(text);
      }

      const toolNames: string[] = [];
      let deferredTok = 0;
      let loadedTok = 0;
      for (const f of safeReaddirWithTypes(serverDir)) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const tReal = safeRealpath(path.join(serverDir, f.name));
        if (!tReal) continue;
        const { text } = readTextSafe(tReal, 256 * 1024);
        if (text === null) continue;
        const tok = estTextTokens(text);
        toolNames.push(f.name.replace(/\.json$/, ''));
        if (readFileRealPaths.has(tReal)) loadedTok += tok;
        else deferredTok += tok;
      }

      const manifestTok = toolNames.length > 0
        ? estTextTokens(`# ${serverName}\nLazy:\n${toolNames.join('\n')}`)
        : estTextTokens(`# ${serverName}`);

      if (!disabled) {
        mcpManifestTokens += manifestTok;
        mcpInstructionsTokens += instTokens;
        mcpLoadedTokens += loadedTok;
        mcpDeferredTokens += deferredTok;
      }

      mcpServers.push({
        name: serverName,
        source: cfgInfo?.source || 'Discovered',
        disabled,
        toolCount: toolNames.length,
        activeTokens: disabled ? 0 : manifestTok + loadedTok,
        deferredTokens: disabled ? 0 : deferredTok,
        instructionsTokens: disabled ? 0 : instTokens
      });
    }
  }
  mcpServers.sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.deferredTokens - a.deferredTokens);

  const built: CachedCustomizations = {
    builtAt: now,
    rules,
    activeRulesTokens,
    deferredRulesTokens,
    skills,
    activeSkillsIndexTokens,
    loadedSkillsBodyTokens,
    deferredSkillsTokens,
    mcpServers,
    mcpManifestTokens,
    mcpInstructionsTokens,
    mcpLoadedTokens,
    mcpDeferredTokens
  };

  if (customizationCache.size >= 24) {
    const oldest = customizationCache.keys().next().value;
    if (oldest !== undefined) customizationCache.delete(oldest);
  }
  customizationCache.set(cacheKey, built);
  return built;
}

type LeafBucketKey =
  | 'messages'
  | 'agentReplies'
  | 'agentThinking'
  | 'toolCallOutputs'
  | 'toolCallArgs'
  | 'mcpTools'
  | 'mcpInstructions'
  | 'systemTools'
  | 'systemPrompt'
  | 'rulesFiles'
  | 'skills'
  | 'customAgents'
  | 'systemMessages'
  | 'checkpointBuffer';

function scaleAndReconcileLeafBuckets(
  raw: Record<LeafBucketKey, number>,
  targetTotal: number
): Record<LeafBucketKey, number> {
  const keys = Object.keys(raw) as LeafBucketKey[];
  const out = { ...raw };
  let rawSum = 0;
  for (const k of keys) {
    out[k] = Math.max(0, out[k] || 0);
    rawSum += out[k];
  }
  if (targetTotal <= 0 || rawSum <= 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }

  const scale = targetTotal / rawSum;
  let scaledSum = 0;
  for (const k of keys) {
    out[k] = out[k] > 0 ? Math.round(out[k] * scale) : 0;
    scaledSum += out[k];
  }

  const diff = targetTotal - scaledSum;
  if (diff !== 0) {
    let bestKey: LeafBucketKey = keys[0];
    for (const k of keys) {
      if (raw[k] > raw[bestKey]) bestKey = k;
    }
    out[bestKey] = Math.max(0, out[bestKey] + diff);
  }
  return out;
}

export function buildContextDetailBreakdown(opts: {
  cascadeId: string;
  dbPath: string;
  ctxTokens: number;
  lastInTok: number;
  remainCtxTokens: number;
  bdSource: GenRowMetrics;
  validItems: GenRowMetrics[];
  workspaceUris: string[];
  homedir?: string;
}): ContextDetailBreakdown {
  const {
    cascadeId,
    dbPath,
    ctxTokens,
    lastInTok,
    remainCtxTokens,
    bdSource,
    validItems,
    workspaceUris,
    homedir
  } = opts;

  // 1. Detect compactions & build growth curve from valid gen_metadata rows
  let compactionCount = 0;
  let compactionSavedTokens = 0;
  let lastBeforeTokens = 0;
  let lastAfterTokens = 0;
  let lastCompactionValidPos = -1;
  const allHistory: TurnGrowthPoint[] = [];

  for (let i = 0; i < validItems.length; i++) {
    const cur = validItems[i];
    let compacted = false;
    if (i > 0) {
      const prev = validItems[i - 1];
      const drop = prev.ctx - cur.ctx;
      if (drop > Math.max(5000, prev.ctx * 0.12)) {
        compacted = true;
        compactionCount += 1;
        compactionSavedTokens += drop;
        lastBeforeTokens = prev.ctx;
        lastAfterTokens = cur.ctx;
        lastCompactionValidPos = i;
      }
    }
    allHistory.push({
      idx: cur.idx,
      ctxTokens: cur.ctx,
      outTokens: cur.outTok,
      compacted
    });
  }
  const turnsHistory = allHistory.slice(-24);

  // 2. Optional transcript & customization enrichment
  const { appDataDir, configDir } = inferPathsFromDbPath(dbPath, homedir);
  const transcript = analyzeTranscriptCached(appDataDir, cascadeId);
  if (transcript && transcript.checkpointCount > compactionCount) {
    compactionCount = transcript.checkpointCount;
  }

  const readPaths = transcript?.readFileRealPaths ?? new Set<string>();
  const cust = scanCustomizationsCached(appDataDir, configDir, workspaceUris, readPaths);

  // Compute active-window thinking vs reply ratio from SQLite validItems (post-compaction)
  let activeWindowThink = 0;
  let activeWindowResp = 0;
  const startPos = lastCompactionValidPos >= 0 ? lastCompactionValidPos : 0;
  for (let i = startPos; i < validItems.length; i++) {
    activeWindowThink += validItems[i].thinkTok || 0;
    activeWindowResp += validItems[i].respTok || 0;
  }

  // Pair SQLite exact step GENERIC tokens with transcript tool call names when both exist
  let heavyToolCalls: HeavyToolCallItem[] = [];
  let totalToolCalls = transcript?.totalToolCalls || 0;
  if (bdSource.rawStepTokens && bdSource.rawStepTokens.length > 0 && transcript && transcript.genericToolMap.size > 0) {
    const exactCalls: HeavyToolCallItem[] = [];
    for (const st of bdSource.rawStepTokens) {
      if (st.stepTag === 'GENERIC' || st.stepTag.includes('TOOL')) {
        const mapped = transcript.genericToolMap.get(st.stepIdx);
        if (mapped) {
          exactCalls.push({
            stepIndex: mapped.stepIndex,
            toolName: mapped.toolName,
            label: mapped.label,
            path: mapped.path,
            tokens: st.tokens
          });
        } else if (st.tokens > 0) {
          exactCalls.push({
            stepIndex: st.stepIdx,
            toolName: 'tool',
            label: `Step #${st.stepIdx} tool output`,
            path: null,
            tokens: st.tokens
          });
        }
      }
    }
    if (exactCalls.length > 0) {
      totalToolCalls = Math.max(totalToolCalls, exactCalls.length);
      exactCalls.sort((a, b) => b.tokens - a.tokens);
      heavyToolCalls = exactCalls.slice(0, 10);
    }
  }
  if (heavyToolCalls.length === 0 && transcript) {
    heavyToolCalls = transcript.fallbackHeavyCalls;
  } else if (heavyToolCalls.length === 0 && bdSource.rawStepTokens) {
    const rawOnlyCalls = bdSource.rawStepTokens
      .filter((s) => (s.stepTag === 'GENERIC' || s.stepTag.includes('TOOL')) && s.tokens > 0)
      .map((s) => ({
        stepIndex: s.stepIdx,
        toolName: 'tool',
        label: `Step #${s.stepIdx} 工具返回`,
        path: null,
        tokens: s.tokens
      }));
    totalToolCalls = rawOnlyCalls.length;
    rawOnlyCalls.sort((a, b) => b.tokens - a.tokens);
    heavyToolCalls = rawOnlyCalls.slice(0, 10);
  }

  // 3. Split active context categories
  let rawLeaf: Record<LeafBucketKey, number>;

  if (bdSource.hasCtxBreakdown) {
    const rawModel = Math.max(0, bdSource.ctxBreakdownModel || 0);
    const rawToolOut = Math.max(0, bdSource.ctxBreakdownToolCalls || 0);

    let toolCallArgs = 0;
    let modelRemain = rawModel;
    if (transcript) {
      const charSum = transcript.replyChars + transcript.thinkChars + transcript.toolArgsChars;
      if (charSum > 0 && transcript.toolArgsChars > 0) {
        toolCallArgs = Math.round((rawModel * transcript.toolArgsChars) / charSum);
        modelRemain = Math.max(0, rawModel - toolCallArgs);
      }
    }

    let agentThinking = 0;
    let agentReplies = modelRemain;
    if (activeWindowThink + activeWindowResp > 0) {
      agentThinking = Math.round((modelRemain * activeWindowThink) / (activeWindowThink + activeWindowResp));
      agentReplies = Math.max(0, modelRemain - agentThinking);
    } else if (transcript && transcript.replyChars + transcript.thinkChars > 0) {
      agentThinking = Math.round(
        (modelRemain * transcript.thinkChars) / (transcript.replyChars + transcript.thinkChars)
      );
      agentReplies = Math.max(0, modelRemain - agentThinking);
    }

    const rawMcpTotal = Math.max(0, bdSource.rawMcpTok || 0);
    let mcpInstructions = 0;
    let mcpTools = rawMcpTotal;
    if (rawMcpTotal > 0 && cust.mcpInstructionsTokens > 0) {
      const diskMcpSum = Math.max(1, cust.mcpInstructionsTokens + cust.mcpManifestTokens);
      mcpInstructions = Math.round((rawMcpTotal * cust.mcpInstructionsTokens) / diskMcpSum);
      mcpTools = Math.max(0, rawMcpTotal - mcpInstructions);
    }

    rawLeaf = {
      messages: Math.max(0, bdSource.ctxBreakdownUser || 0),
      agentReplies,
      agentThinking,
      toolCallOutputs: rawToolOut + cust.mcpLoadedTokens,
      toolCallArgs,
      mcpTools,
      mcpInstructions,
      systemTools: Math.max(0, bdSource.rawSystemToolsTok || 0),
      systemPrompt: Math.max(0, bdSource.rawSystemPromptTok || 0),
      rulesFiles: Math.max(0, bdSource.rawRulesTok || 0),
      skills: Math.max(0, bdSource.rawSkillsTok || 0) + cust.loadedSkillsBodyTokens,
      customAgents: Math.max(0, bdSource.rawSubagentsPluginsTok || 0),
      systemMessages: Math.max(0, bdSource.rawSystemMsgTok || 0),
      checkpointBuffer: Math.max(0, bdSource.rawCheckpointTok || 0)
    };
  } else {
    // Fallback when SQLite row omits TokenBreakdown: anchor on first prompt + session deltas
    const firstCtx = validItems.length > 0 ? validItems[0].ctx : 0;
    const baseBudget = Math.min(ctxTokens, firstCtx > 0 ? Math.round(firstCtx * 0.85) : 10000);
    const rulesFiles = Math.min(cust.activeRulesTokens, Math.round(baseBudget * 0.25));
    const skills = Math.min(cust.activeSkillsIndexTokens, Math.round(baseBudget * 0.2));
    const mcpTools = Math.min(cust.mcpManifestTokens, Math.round(baseBudget * 0.2));
    const mcpInstructions = Math.min(cust.mcpInstructionsTokens, Math.round(baseBudget * 0.15));
    const remBase = Math.max(0, baseBudget - rulesFiles - skills - mcpTools - mcpInstructions);
    const systemTools = Math.round(remBase * 0.55);
    const systemPrompt = Math.max(0, remBase - systemTools);

    const dynamicBudget = Math.max(0, ctxTokens - baseBudget);
    const modelEst = Math.min(dynamicBudget, activeWindowThink + activeWindowResp);
    const agentThinking =
      activeWindowThink + activeWindowResp > 0
        ? Math.round((modelEst * activeWindowThink) / (activeWindowThink + activeWindowResp))
        : 0;
    const agentReplies = Math.max(0, modelEst - agentThinking);
    const remDyn = Math.max(0, dynamicBudget - modelEst);
    const messages = Math.max(firstCtx > baseBudget ? firstCtx - baseBudget : 0, Math.round(remDyn * 0.12));
    const toolCallOutputs = Math.max(0, remDyn - messages);

    rawLeaf = {
      messages,
      agentReplies,
      agentThinking,
      toolCallOutputs,
      toolCallArgs: 0,
      mcpTools,
      mcpInstructions,
      systemTools,
      systemPrompt,
      rulesFiles,
      skills: skills + cust.loadedSkillsBodyTokens,
      customAgents: 0,
      systemMessages: 0,
      checkpointBuffer: 0
    };
  }

  const leaf = scaleAndReconcileLeafBuckets(rawLeaf, ctxTokens);
  const deferredTotal = cust.mcpDeferredTokens + cust.deferredSkillsTokens + cust.deferredRulesTokens;

  return {
    exactFromSqlite: Boolean(bdSource.hasCtxBreakdown),
    categories: {
      messages: leaf.messages,
      agentResponses: leaf.agentReplies + leaf.agentThinking,
      agentReplies: leaf.agentReplies,
      agentThinking: leaf.agentThinking,
      toolCalls: leaf.toolCallOutputs + leaf.toolCallArgs,
      toolCallOutputs: leaf.toolCallOutputs,
      toolCallArgs: leaf.toolCallArgs,
      mcpTools: leaf.mcpTools,
      mcpInstructions: leaf.mcpInstructions,
      systemTools: leaf.systemTools,
      systemPrompt: leaf.systemPrompt,
      rulesFiles: leaf.rulesFiles,
      skills: leaf.skills,
      customAgents: leaf.customAgents,
      systemMessages: leaf.systemMessages,
      checkpointBuffer: leaf.checkpointBuffer
    },
    sinceLastCacheTokens: Math.max(0, lastInTok),
    freeTokens: Math.max(0, remainCtxTokens),
    deferred: {
      mcpTokens: cust.mcpDeferredTokens,
      skillsTokens: cust.deferredSkillsTokens,
      rulesTokens: cust.deferredRulesTokens,
      totalTokens: deferredTotal
    },
    compaction: {
      count: compactionCount,
      totalSavedTokens: compactionSavedTokens,
      lastBeforeTokens,
      lastAfterTokens
    },
    heavyToolCalls,
    totalToolCalls,
    mcpServers: cust.mcpServers,
    rules: cust.rules,
    skills: cust.skills,
    turnsHistory,
    workspaceUris
  };
}
