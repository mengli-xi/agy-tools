import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CacheRateMode, ChannelMode, IdeAlignment, UserConfig } from './types.js';

export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export function defaultConfig(): UserConfig {
  return {
    enabled: true,
    channel: 'auto',
    cacheRateMode: 'last',
    contextLimit: 256000,
    contextLimitOverride: 0,
    proxy: '',
    cli: {
      showModel: true,
      showGitBranch: true,
      color: true
    },
    app: {
      enabled: true,
      cdpAutoRelaunch: true
    },
    ide: {
      enabled: true,
      alignment: 'right'
    }
  };
}

export function ensureLoopbackNoProxy(raw: string = ''): string {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const lower = new Set(items.map((s) => s.toLowerCase()));
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    if (!lower.has(host)) {
      items.push(host);
      lower.add(host);
    }
  }
  return items.join(',');
}

export function resolveEffectiveProxyEnv(
  configProxy: string = '',
  baseEnv: Record<string, string | undefined> = process.env,
  fallbackEnv: Record<string, string | undefined> = {}
): Record<string, string> {
  const explicit = configProxy.trim();
  const existingNoProxy =
    baseEnv.NO_PROXY?.trim() ||
    baseEnv.no_proxy?.trim() ||
    fallbackEnv.NO_PROXY?.trim() ||
    fallbackEnv.no_proxy?.trim() ||
    '';

  if (explicit) {
    const noProxy = ensureLoopbackNoProxy(existingNoProxy);
    const out: Record<string, string> = {
      HTTPS_PROXY: explicit,
      HTTP_PROXY: explicit,
      NO_PROXY: noProxy,
      no_proxy: noProxy
    };
    if (/^socks/i.test(explicit)) {
      out.ALL_PROXY = explicit;
    }
    return out;
  }

  const envHttps = baseEnv.HTTPS_PROXY?.trim() || baseEnv.https_proxy?.trim() || '';
  const envHttp = baseEnv.HTTP_PROXY?.trim() || baseEnv.http_proxy?.trim() || '';
  const envAll = baseEnv.ALL_PROXY?.trim() || baseEnv.all_proxy?.trim() || '';
  const hasBaseProxy = Boolean(envHttps || envHttp || envAll);

  const httpsProxy = hasBaseProxy
    ? envHttps
    : fallbackEnv.HTTPS_PROXY?.trim() || fallbackEnv.https_proxy?.trim() || '';
  const httpProxy = hasBaseProxy
    ? envHttp
    : fallbackEnv.HTTP_PROXY?.trim() || fallbackEnv.http_proxy?.trim() || '';
  const allProxy = hasBaseProxy
    ? envAll
    : fallbackEnv.ALL_PROXY?.trim() || fallbackEnv.all_proxy?.trim() || '';

  if (!httpsProxy && !httpProxy && !allProxy) {
    return {};
  }

  const noProxy = ensureLoopbackNoProxy(existingNoProxy);
  const out: Record<string, string> = {
    NO_PROXY: noProxy,
    no_proxy: noProxy
  };
  if (httpsProxy) out.HTTPS_PROXY = httpsProxy;
  if (httpProxy) out.HTTP_PROXY = httpProxy;
  if (allProxy) out.ALL_PROXY = allProxy;
  return out;
}

export function resolveUserConfigPath(
  homedir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env
): string {
  const explicit = env.AGY_STATUSLINE_CONFIG?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, 'agy-statusline', 'config.json');
  }
  return path.join(homedir, '.config', 'agy-statusline', 'config.json');
}

export function resolveQuotaCachePath(
  homedir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env
): string {
  const explicit = env.AGY_STATUSLINE_QUOTA_CACHE?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, 'agy-statusline', 'quota_cache.json');
  }
  return path.join(homedir, '.cache', 'agy-statusline', 'quota_cache.json');
}

export function resolveSeedQuotaCachePaths(
  homedir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env
): string[] {
  const primary = resolveQuotaCachePath(homedir, env);
  if (env.AGY_STATUSLINE_QUOTA_CACHE?.trim()) {
    return [primary];
  }
  const hudFallback = path.join(homedir, '.cache', 'agy-hud', 'quota_cache.json');
  return primary === hudFallback ? [primary] : [primary, hudFallback];
}

function normalizeChannel(raw: unknown, fallback: ChannelMode): ChannelMode {
  if (raw === 'stable' || raw === 'insiders' || raw === 'auto') return raw;
  return fallback;
}

function normalizeCacheRateMode(raw: unknown, fallback: CacheRateMode): CacheRateMode {
  if (raw === 'last' || raw === 'session') return raw;
  return fallback;
}

function normalizeIdeAlignment(raw: unknown, fallback: IdeAlignment): IdeAlignment {
  if (raw === 'left' || raw === 'right') return raw;
  return fallback;
}

export function parseUserConfig(raw: string): UserConfig {
  const base = defaultConfig();
  try {
    const parsed = JSON.parse(stripBom(raw)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return base;
    }
    const rawCli = parsed.cli && typeof parsed.cli === 'object' && !Array.isArray(parsed.cli)
      ? (parsed.cli as Record<string, unknown>)
      : {};
    const rawApp = parsed.app && typeof parsed.app === 'object' && !Array.isArray(parsed.app)
      ? (parsed.app as Record<string, unknown>)
      : {};
    const rawIde = parsed.ide && typeof parsed.ide === 'object' && !Array.isArray(parsed.ide)
      ? (parsed.ide as Record<string, unknown>)
      : {};

    const ctxLimit = Number(parsed.contextLimit);
    const ctxOverride = Number(parsed.contextLimitOverride);

    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : base.enabled,
      channel: normalizeChannel(parsed.channel, base.channel),
      cacheRateMode: normalizeCacheRateMode(parsed.cacheRateMode, base.cacheRateMode),
      contextLimit: Number.isFinite(ctxLimit) && ctxLimit > 0 ? ctxLimit : base.contextLimit,
      contextLimitOverride: Number.isFinite(ctxOverride) && ctxOverride > 0 ? ctxOverride : 0,
      proxy: typeof parsed.proxy === 'string' ? parsed.proxy.trim() : base.proxy,
      cli: {
        showModel: typeof rawCli.showModel === 'boolean' ? rawCli.showModel : base.cli.showModel,
        showGitBranch: typeof rawCli.showGitBranch === 'boolean' ? rawCli.showGitBranch : base.cli.showGitBranch,
        color: typeof rawCli.color === 'boolean' ? rawCli.color : base.cli.color
      },
      app: {
        enabled: typeof rawApp.enabled === 'boolean' ? rawApp.enabled : base.app.enabled,
        cdpAutoRelaunch:
          typeof rawApp.cdpAutoRelaunch === 'boolean' ? rawApp.cdpAutoRelaunch : base.app.cdpAutoRelaunch
      },
      ide: {
        enabled: typeof rawIde.enabled === 'boolean' ? rawIde.enabled : base.ide.enabled,
        alignment: normalizeIdeAlignment(rawIde.alignment, base.ide.alignment)
      }
    };
  } catch {
    return base;
  }
}

export function getFileMtimeSig(filePath: string): string {
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    return st ? `${st.mtimeMs}:${st.size}` : '0:0';
  } catch {
    return '0:0';
  }
}

export function loadUserConfig(
  homedir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env
): { config: UserConfig; path: string; exists: boolean; sig: string } {
  const cfgPath = resolveUserConfigPath(homedir, env);
  const sig = getFileMtimeSig(cfgPath);
  if (sig === '0:0') {
    return { config: defaultConfig(), path: cfgPath, exists: false, sig };
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return { config: parseUserConfig(raw), path: cfgPath, exists: true, sig };
  } catch {
    return { config: defaultConfig(), path: cfgPath, exists: false, sig };
  }
}

const hostPluginEnabledCache = new Map<string, { sig: string; enabled: boolean }>();

export function readHostPluginEnabled(homedir: string = os.homedir()): boolean {
  const hostCfgPath = path.join(homedir, '.gemini', 'config', 'config.json');
  const sig = getFileMtimeSig(hostCfgPath);
  const cached = hostPluginEnabledCache.get(hostCfgPath);
  if (cached && cached.sig === sig) {
    return cached.enabled;
  }
  let enabled = true;
  if (sig !== '0:0') {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(hostCfgPath, 'utf8'))) as {
        plugins?: Record<string, { enabled?: unknown } | undefined>;
      };
      if (parsed?.plugins?.['agy-statusline']?.enabled === false) {
        enabled = false;
      }
    } catch {
      enabled = true;
    }
  }
  hostPluginEnabledCache.set(hostCfgPath, { sig, enabled });
  return enabled;
}
