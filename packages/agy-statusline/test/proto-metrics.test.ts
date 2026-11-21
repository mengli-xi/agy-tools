import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  concatProtoFields,
  encodeBytesField,
  encodeVarintField
} from '../src/core/proto.js';
import {
  clearMetricsCaches,
  parseConversationMetrics
} from '../src/core/sqlite-metrics.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sl-proto-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  clearMetricsCaches();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function buildGenMetadataBlob(opts: {
  inTok: number;
  outTok: number;
  cacheRead: number;
  thinkTok: number;
  respTok: number;
  maxCtx?: number;
  ttftSec: number;
  streamSec: number;
}): Uint8Array {
  const usage = concatProtoFields([
    encodeVarintField(2, opts.inTok),
    encodeVarintField(3, opts.outTok),
    encodeVarintField(5, opts.cacheRead),
    encodeVarintField(9, opts.thinkTok),
    encodeVarintField(10, opts.respTok)
  ]);
  const chatFields: Uint8Array[] = [encodeBytesField(4, usage)];

  if (opts.maxCtx && opts.maxCtx > 0) {
    const ctxWin = encodeVarintField(4, opts.maxCtx);
    const chatStart = encodeBytesField(10, ctxWin);
    chatFields.push(encodeBytesField(9, chatStart));
  }

  const encodeDuration = (secFloat: number) => {
    const secs = Math.floor(secFloat);
    const nanos = Math.round((secFloat - secs) * 1e9);
    return concatProtoFields([encodeVarintField(1, secs), encodeVarintField(2, nanos)]);
  };

  chatFields.push(encodeBytesField(11, encodeDuration(opts.ttftSec)));
  chatFields.push(encodeBytesField(12, encodeDuration(opts.streamSec)));

  return encodeBytesField(1, concatProtoFields(chatFields));
}

function createConvDb(
  dir: string,
  uuid: string,
  opts: {
    genRows: Array<{ idx: number; blob: Uint8Array }>;
    steps?: Array<{ idx: number; stepType: number }>;
    parentId?: string;
    rootId?: string;
  }
): string {
  const dbPath = path.join(dir, `${uuid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER);
    CREATE TABLE trajectory_metadata_blob (data BLOB);
  `);
  const insertGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  for (const r of opts.genRows) {
    insertGen.run(r.idx, r.blob);
  }
  const insertStep = db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)');
  for (const s of opts.steps ?? []) {
    insertStep.run(s.idx, s.stepType);
  }
  if (opts.parentId || opts.rootId) {
    const metaFields: Uint8Array[] = [];
    if (opts.parentId) metaFields.push(encodeBytesField(5, opts.parentId));
    if (opts.rootId) metaFields.push(encodeBytesField(6, opts.rootId));
    db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(concatProtoFields(metaFields));
  }
  db.close();
  return dbPath;
}

describe('proto + sqlite-metrics', () => {
  it('parses Ctx%, maxCtx ceiling, cache rates, streaming TPS, and multi-step turns', () => {
    const dir = makeTempDir();
    const cid = '11111111-2222-3333-4444-555555555555';

    createConvDb(dir, cid, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 10000,
            outTok: 500,
            cacheRead: 0,
            thinkTok: 200,
            respTok: 300,
            maxCtx: 1048576,
            ttftSec: 1.0,
            streamSec: 5.0
          })
        },
        {
          idx: 1,
          blob: buildGenMetadataBlob({
            inTok: 5000,
            outTok: 1000,
            cacheRead: 95000,
            thinkTok: 400,
            respTok: 600,
            maxCtx: 1048576,
            ttftSec: 1.5,
            streamSec: 10.0
          })
        }
      ],
      steps: [
        { idx: 1, stepType: 14 }, // user turn 1
        { idx: 2, stepType: 15 },
        { idx: 3, stepType: 15 }  // 2 planning/gen steps after last user turn
      ]
    });

    const m = parseConversationMetrics(cid, dir);
    assert.ok(m && m.hasData);
    assert.equal(m.contextLimitTokens, 1048576);
    assert.equal(m.ctxTokens, 100000);
    assert.equal(m.ctxPct, 10); // Math.round(100000 / 1048576 * 100)
    assert.equal(Math.round(m.lastCacheRate), 95); // 95000 / 100000
    assert.equal(Math.round(m.sessionCacheRate * 10) / 10, 86.4); // 95000 / 110000
    assert.equal(m.useStreamTps, true);
    assert.equal(Math.round(m.tps), 100); // 1000 / 10.0
    assert.equal(m.ttft, 1.5);
    assert.equal(m.userTurns, 1);
    assert.equal(m.validCalls, 2);
    assert.equal(m.turnSteps, 2);
    assert.equal(m.turnOut, 1500);
  });

  it('falls back to e2e TPS when stream duration is tiny and handles incremental tail updates', () => {
    const dir = makeTempDir();
    const cid = '22222222-2222-3333-4444-555555555555';
    const dbPath = createConvDb(dir, cid, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 2000,
            outTok: 200,
            cacheRead: 8000,
            thinkTok: 50,
            respTok: 150,
            ttftSec: 1.8,
            streamSec: 0.2
          })
        }
      ],
      steps: [
        { idx: 1, stepType: 14 },
        { idx: 2, stepType: 15 }
      ]
    });

    const first = parseConversationMetrics(cid, dir);
    assert.ok(first && first.hasData);
    assert.equal(first.useStreamTps, false);
    assert.equal(Math.round(first.tps), 100); // 200 / (1.8 + 0.2)
    assert.equal(first.contextLimitTokens, 256000);

    // Append a new step & gen row to verify O(1) incremental cursor pickup
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)').run(3, 14);
    db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)').run(4, 15);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      1,
      buildGenMetadataBlob({
        inTok: 1000,
        outTok: 400,
        cacheRead: 19000,
        thinkTok: 100,
        respTok: 300,
        ttftSec: 1.0,
        streamSec: 4.0
      })
    );
    db.close();

    // Force mtime change slightly if filesystem timestamp granularity coalesces
    const nowSec = Date.now() / 1000 + 2;
    fs.utimesSync(dbPath, nowSec, nowSec);

    const second = parseConversationMetrics(cid, dir);
    assert.ok(second && second.hasData);
    assert.equal(second.validCalls, 2);
    assert.equal(second.userTurns, 2);
    assert.equal(second.totalOut, 600);
    assert.equal(second.lastGenIdx, 1);
    assert.equal(Math.round(second.lastCacheRate), 95);
  });

  it('aggregates descendant subagent trees via trajectory_metadata_blob BFS', () => {
    const dir = makeTempDir();
    const rootId = '33333333-2222-3333-4444-555555555555';
    const childId = '44444444-2222-3333-4444-555555555555';
    const grandId = '55555555-2222-3333-4444-555555555555';

    createConvDb(dir, rootId, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 4000,
            outTok: 500,
            cacheRead: 16000,
            thinkTok: 100,
            respTok: 400,
            ttftSec: 1.0,
            streamSec: 5.0
          })
        }
      ],
      steps: [{ idx: 1, stepType: 14 }, { idx: 2, stepType: 15 }]
    });

    createConvDb(dir, childId, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 1000,
            outTok: 300,
            cacheRead: 5000,
            thinkTok: 50,
            respTok: 250,
            ttftSec: 0.5,
            streamSec: 3.0
          })
        }
      ],
      parentId: rootId,
      rootId
    });

    createConvDb(dir, grandId, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 500,
            outTok: 200,
            cacheRead: 2500,
            thinkTok: 50,
            respTok: 150,
            ttftSec: 0.5,
            streamSec: 2.0
          })
        }
      ],
      parentId: childId,
      rootId
    });

    const m = parseConversationMetrics(rootId, dir);
    assert.ok(m && m.hasData);
    assert.equal(m.subagentCount, 2);
    assert.equal(m.subagentCalls, 2);
    assert.equal(m.subagentOut, 500);
    assert.equal(m.subagentIn, 1500);
    assert.equal(m.subagentCache, 7500);
  });
});
