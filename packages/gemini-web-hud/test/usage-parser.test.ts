import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountdown,
  formatPoolResetCompact,
  inspectUsageGraphQL,
  isUsagePathname,
  metricToneFromUsedPct,
  parseUsageDocumentText,
  parseUsageFromInlineScripts,
  parseUsageGraphQL
} from '../src/usage-parser';
import { resolveAccountScope } from '../src/types';
import { normalizeQueryTitle } from '../src/dom-utils';

test('parseUsageGraphQL extracts 5h and 7d pools with XSSI prefix', () => {
  const payload = `)]}'\n${JSON.stringify({
    data: {
      viewer: {
        rpcs: {
          getUsageInfo: {
            pools: [
              {
                id: 'GXU_WEEKLY',
                percentageUsed: 0.12,
                gxu: { windowRefreshesAt: '2026-12-01T08:00:00Z' }
              },
              {
                id: 'GXU_FIVE_HOURLY',
                percentageUsed: 0.35,
                gxu: { windowRefreshesAt: '2026-11-26T10:30:00Z' }
              }
            ]
          }
        }
      }
    }
  })}`;

  const snapshot = parseUsageGraphQL(payload, 1_700_000_000_000);
  assert.ok(snapshot);
  assert.equal(snapshot.source, 'graphql');
  assert.equal(snapshot.pools.length, 2);

  // Sorted 5h before 7d
  assert.equal(snapshot.pools[0].kind, '5h');
  assert.equal(snapshot.pools[0].usedPct, 35);
  assert.equal(snapshot.pools[0].remainingPct, 65);
  assert.equal(snapshot.pools[0].resetAtIso, '2026-11-26T10:30:00.000Z');

  assert.equal(snapshot.pools[1].kind, '7d');
  assert.equal(snapshot.pools[1].usedPct, 12);
  assert.equal(snapshot.pools[1].remainingPct, 88);
});

test('parseUsageDocumentText parses English and Chinese rendered /usage text', () => {
  const enText = `
    Usage limits
    5-hour window
    28% used
    Resets in 3 hr 10 min

    Weekly limit
    91% remaining
    Resets on Dec 2
  `;
  const enSnap = parseUsageDocumentText(enText, 1234);
  assert.ok(enSnap);
  assert.equal(enSnap.source, 'dom');
  assert.equal(enSnap.pools.length, 2);
  assert.equal(enSnap.pools[0].kind, '5h');
  assert.equal(enSnap.pools[0].usedPct, 28);
  assert.equal(enSnap.pools[0].remainingPct, 72);
  assert.equal(enSnap.pools[1].kind, '7d');
  assert.equal(enSnap.pools[1].usedPct, 9);
  assert.equal(enSnap.pools[1].remainingPct, 91);

  const zhText = `
    用量限额
    5 小时窗口
    已用 60%
    将于 18:30 重置

    每周限额
    剩余 80%
    将于周一重置
  `;
  const zhSnap = parseUsageDocumentText(zhText, 5678);
  assert.ok(zhSnap);
  assert.equal(zhSnap.pools.length, 2);
  assert.equal(zhSnap.pools[0].remainingPct, 40);
  assert.equal(zhSnap.pools[1].remainingPct, 80);
});

test('formatCountdown and metricToneFromUsedPct follow expected thresholds', () => {
  const now = Date.parse('2026-11-26T03:00:00Z');
  assert.equal(formatCountdown('2026-11-26T05:15:00Z', now), '2h15m');
  assert.equal(formatCountdown('2026-11-30T11:00:00Z', now), '4d08h');
  assert.equal(formatCountdown('2026-11-26T03:00:30Z', now), '<1m');
  assert.equal(formatCountdown('2026-11-26T02:59:00Z', now), '即将重置');

  assert.equal(metricToneFromUsedPct(20), 'good');
  assert.equal(metricToneFromUsedPct(50), 'mid');
  assert.equal(metricToneFromUsedPct(75), 'warn');
  assert.equal(metricToneFromUsedPct(92), 'crit');

  // Text-based reset fallback formatting
  assert.equal(formatPoolResetCompact({ resetText: 'Resets in 3 hr 10 min' }, now), '3h10m');
  assert.equal(formatPoolResetCompact({ resetText: '2 小时 5 分钟后重置' }, now), '2h05m');
  assert.equal(formatPoolResetCompact({ resetText: '将于周一重置' }, now), '周一');
});

test('normalizeQueryTitle strips accessibility prefixes and truncates cleanly', () => {
  assert.equal(normalizeQueryTitle('You said:  Hello   world  '), 'Hello world');
  assert.equal(normalizeQueryTitle('你说：帮我分析一下这段代码'), '帮我分析一下这段代码');
  assert.equal(normalizeQueryTitle('   '), '（无文本消息）');
  const long = 'a'.repeat(80);
  assert.equal(normalizeQueryTitle(long, 20).length, 20);
  assert.ok(normalizeQueryTitle(long, 20).endsWith('…'));
});

test('supports /u/<n>/usage account routing, batchexecute/SSR script payloads, and preceding-line DOM %', () => {
  assert.equal(isUsagePathname('/usage'), true);
  assert.equal(isUsagePathname('/u/0/usage'), true);
  assert.equal(isUsagePathname('/u/2/usage/'), true);
  assert.equal(isUsagePathname('/u/0/app'), false);

  assert.deepEqual(resolveAccountScope('/app'), {
    accountKey: 'u0',
    pathPrefix: '',
    storageKey: 'gwh_usage_snapshot_v1'
  });
  assert.deepEqual(resolveAccountScope('/u/1/app/abc'), {
    accountKey: 'u1',
    pathPrefix: '/u/1',
    storageKey: 'gwh_usage_snapshot_v1_u1'
  });

  // Google Boq batchexecute stringified inner JSON + snake_case pct_used
  const batchPayload = `)]}'\n\n[["wrb.fr","UsageRpc",${JSON.stringify(
    JSON.stringify({
      pools: [
        { id: 'GXU_FIVE_HOURLY', pct_used: 0.2, windowRefreshesAt: '2026-11-27T12:00:00Z' },
        { id: 'GXU_WEEKLY', pct_used: 0.05, windowRefreshesAt: '2026-12-03T00:00:00Z' }
      ]
    })
  )},null,null,null,"generic"]]`;
  const batchSnap = parseUsageGraphQL(batchPayload, 1000);
  assert.ok(batchSnap);
  assert.equal(batchSnap.pools.length, 2);
  assert.equal(batchSnap.pools[0].remainingPct, 80);
  assert.equal(batchSnap.pools[1].remainingPct, 95);

  // SSR AF_initDataCallback inline script
  const ssrScript = `AF_initDataCallback({key: 'ds:1', hash: '2', data: [{"id":"GXU_FIVE_HOURLY","percentageUsed":0.42}], sideChannel: {}});`;
  const ssrSnap = parseUsageFromInlineScripts([ssrScript], 2000);
  assert.ok(ssrSnap);
  assert.equal(ssrSnap.pools[0].remainingPct, 58);

  // Preceding-line percentage above Chinese "每 5 小时" label
  const reversedDom = `
    用量限额
    已用 15%
    每 5 小时刷新一次 · 4 小时 10 分钟后重置
  `;
  const domSnap = parseUsageDocumentText(reversedDom, 3000);
  assert.ok(domSnap);
  assert.equal(domSnap.pools[0].remainingPct, 85);

  // Production Gemini BudgetPool schema uses `poolType` (not `id`) + streamed array chunks + featureGates
  const prodStream = `)]}'\n${JSON.stringify([
    {
      data: {
        viewer: {
          status: { featureGates: { canSeeUsageLimits: true } },
          rpcs: {
            getUsageInfo: {
              subscriptionTier: 'PRO',
              pools: [
                {
                  poolType: 'GXU_FIVE_HOURLY',
                  percentageUsed: 0.18,
                  gxu: { windowRefreshesAt: '2026-11-27T13:00:00Z' }
                },
                {
                  poolType: 'GXU_WEEKLY',
                  percentageUsed: 0.06,
                  gxu: { windowRefreshesAt: '2026-12-03T08:00:00Z' }
                }
              ]
            }
          }
        }
      }
    }
  ])}`;
  const prodInspected = inspectUsageGraphQL(prodStream, 4000);
  assert.equal(prodInspected.canSeeUsageLimits, true);
  assert.ok(prodInspected.snapshot);
  assert.equal(prodInspected.snapshot.pools[0].kind, '5h');
  assert.equal(prodInspected.snapshot.pools[0].remainingPct, 82);
  assert.equal(prodInspected.snapshot.pools[1].kind, '7d');
  assert.equal(prodInspected.snapshot.pools[1].remainingPct, 94);

  const gatedOff = inspectUsageGraphQL(
    JSON.stringify([{ data: { viewer: { status: { featureGates: { canSeeUsageLimits: false } } } } }]),
    5000
  );
  assert.equal(gatedOff.canSeeUsageLimits, false);
  assert.equal(gatedOff.snapshot, null);
});
