import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildModelQuotaView,
  formatCountdownCompact,
  mergeQuotaBuckets,
  persistMergedQuotaIfChanged,
  resolveQuotaBucketSpecs,
  usedPercentFromFraction
} from '../src/core/quota-store.js';
import { parseUsageOutput, resolveAgyCommand } from '../src/core/usage-runner.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sl-quota-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('quota-store + usage-runner', () => {
  it('routes models to the right quota pool and handles Argon fallback', () => {
    const proQuota = {
      'gemini-5h': { remaining_fraction: 0.8 },
      'gemini-weekly': { remaining_fraction: 0.6 },
      '3p-5h': { remaining_fraction: 0.9 },
      '3p-weekly': { remaining_fraction: 0.7 },
      'gemini-argon-wtu-weekly': { remaining_fraction: 0.5 }
    };
    const ultraQuota = {
      'gemini-5h': { remaining_fraction: 0.8 },
      'gemini-weekly': { remaining_fraction: 0.6 }
    };

    assert.equal(resolveQuotaBucketSpecs('Gemini 4 Carbon (Medium)', proQuota).poolLabel, 'Gemini');
    assert.deepEqual(
      resolveQuotaBucketSpecs('Claude Opus 5.5 (High)', proQuota).specs.map((s) => s.key),
      ['3p-5h', '3p-weekly']
    );
    assert.deepEqual(
      resolveQuotaBucketSpecs('GPT-OSS 120B (Medium)', proQuota).specs.map((s) => s.key),
      ['3p-5h', '3p-weekly']
    );
    assert.deepEqual(
      resolveQuotaBucketSpecs('Gemini 4 Argon (High)', proQuota).specs.map((s) => s.key),
      ['gemini-argon-wtu-weekly']
    );
    // Ultra plan without argon bucket falls back to Gemini 5h/weekly
    assert.deepEqual(
      resolveQuotaBucketSpecs('Gemini 4 Argon (High)', ultraQuota).specs.map((s) => s.key),
      ['gemini-5h', 'gemini-weekly']
    );
  });

  it('computes used% and compact countdowns, omitting countdown at 0% used', () => {
    assert.equal(usedPercentFromFraction(0.78), 22);
    assert.equal(usedPercentFromFraction(0.55), 45);
    assert.equal(usedPercentFromFraction(1.0), 0);
    assert.equal(formatCountdownCompact(2 * 3600 + 15 * 60), '2h15m');
    assert.equal(formatCountdownCompact(4 * 86400 + 8 * 3600), '4d08h');
    assert.equal(formatCountdownCompact(38 * 60), '38m');

    const now = new Date('2026-11-21T02:00:00Z');
    const view = buildModelQuotaView(
      {
        timestamp: '2026-11-21T01:59:00Z',
        quota: {
          'gemini-5h': {
            remaining_fraction: 0.78,
            reset_time: '2026-11-21T04:15:00Z'
          },
          'gemini-weekly': {
            remaining_fraction: 1.0,
            reset_time: '2026-11-28T02:00:00Z'
          }
        }
      },
      'Gemini 4 Carbon (Medium)',
      undefined,
      now
    );

    assert.equal(view.hasQuota, true);
    assert.equal(view.windows.length, 2);
    assert.equal(view.windows[0].usedPct, 22);
    assert.equal(view.windows[0].resetCountdown, '2h15m');
    assert.equal(view.windows[1].usedPct, 0);
    assert.equal(view.windows[1].resetCountdown, '');
  });

  it('drops expired windows and keeps fresher (lower) remaining_fraction across bidirectional merges', () => {
    const now = new Date('2026-11-21T02:00:00Z');
    const official = {
      'gemini-5h': { remaining_fraction: 0.71, reset_time: '2026-11-21T05:00:00Z' },
      'gemini-weekly': { remaining_fraction: 0.55, reset_time: '2026-11-25T10:00:00Z' },
      '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-11-21T01:00:00Z' } // expired
    };
    const cached = {
      'gemini-5h': { remaining_fraction: 0.65, reset_time: '2026-11-21T05:00:00Z' }, // fresher
      'gemini-weekly': { remaining_fraction: 0.60, reset_time: '2026-11-25T10:00:00Z' } // staler
    };

    const merged = mergeQuotaBuckets(official, cached, now);
    assert.equal(merged['gemini-5h'].remaining_fraction, 0.65);
    assert.equal(merged['gemini-weekly'].remaining_fraction, 0.55);
    assert.equal(merged['3p-5h'], undefined);

    const dir = makeTempDir();
    const cachePath = path.join(dir, 'quota_cache.json');
    const w1 = persistMergedQuotaIfChanged(cachePath, cached, { source: 'usage', now });
    assert.equal(w1.written, true);
    // Writing unchanged values should skip disk write
    const w2 = persistMergedQuotaIfChanged(cachePath, cached, { source: 'usage', now });
    assert.equal(w2.written, false);
    // Lower official payload value should update shared cache for App
    const w3 = persistMergedQuotaIfChanged(cachePath, official, { source: 'statusline', now });
    assert.equal(w3.written, true);
    assert.equal(w3.cache?.quota?.['gemini-weekly'].remaining_fraction, 0.55);
    assert.equal(w3.cache?.quota?.['gemini-5h'].remaining_fraction, 0.65);
  });

  it('parses official agy -p /usage JSON output', () => {
    const stdout = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              buckets: [
                { id: 'gemini-5h', remaining_fraction: 0.82, reset_time: '2026-11-21T06:00:00Z' },
                { id: 'gemini-weekly', remaining_fraction: 0.51, reset_time: '2026-11-26T00:00:00Z' }
              ]
            },
            {
              buckets: [
                { id: 'invalid key!', remaining_fraction: 0.5, reset_time: '2026-11-21T06:00:00Z' }
              ]
            }
          ]
        }
      }
    });
    const parsed = parseUsageOutput(stdout);
    assert.ok(parsed);
    assert.equal(Object.keys(parsed).length, 2);
    assert.equal(parsed['gemini-5h'].remaining_fraction, 0.82);
    assert.equal(parsed['gemini-weekly'].remaining_fraction, 0.51);
    assert.equal(parseUsageOutput('not-json'), null);
  });

  it('keeps reset 5h window visible at 0% used after reset_time passes and resolves ~/.gemini/bin/agy', () => {
    const now = new Date('2026-11-21T03:00:00Z');
    const view = buildModelQuotaView(
      {
        timestamp: '2026-11-20T19:15:21Z',
        quota: {
          'gemini-5h': {
            remaining_fraction: 0.917,
            reset_time: '2026-11-20T20:53:56Z'
          },
          'gemini-weekly': {
            remaining_fraction: 0.954,
            reset_time: '2026-11-26T17:56:54Z'
          }
        }
      },
      'Gemini 4 Carbon (Medium)',
      undefined,
      now
    );

    assert.equal(view.hasQuota, true);
    assert.equal(view.windows.length, 2);
    assert.equal(view.windows[0].label, '5h');
    assert.equal(view.windows[0].usedPct, 0);
    assert.equal(view.windows[0].resetCountdown, '');
    assert.equal(view.windows[1].label, '7d');
    assert.equal(view.windows[1].usedPct, 5);

    const fakeHome = makeTempDir();
    const binDir = path.join(fakeHome, '.gemini', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeAgy = path.join(binDir, 'agy');
    fs.writeFileSync(fakeAgy, '#!/usr/bin/env sh\n');
    assert.equal(resolveAgyCommand('darwin', fakeHome), fakeAgy);
  });
});
