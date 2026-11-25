import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountdown,
  formatPoolResetCompact,
  metricToneFromUsedPct,
  parseUsageDocumentText,
  parseUsageGraphQL
} from '../src/usage-parser';
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
