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
  modelEnum?: number;
  modelId?: string;
  modelDisplay?: string;
}): Uint8Array {
  const usage = concatProtoFields([
    encodeVarintField(2, opts.inTok),
    encodeVarintField(3, opts.outTok),
    encodeVarintField(5, opts.cacheRead),
    encodeVarintField(9, opts.thinkTok),
    encodeVarintField(10, opts.respTok)
  ]);
  const chatFields: Uint8Array[] = [];
  if (opts.modelEnum && opts.modelEnum > 0) {
    chatFields.push(encodeVarintField(3, opts.modelEnum));
  }
  chatFields.push(encodeBytesField(4, usage));

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
  if (opts.modelId) {
    chatFields.push(encodeBytesField(19, opts.modelId));
  }
  if (opts.modelDisplay) {
    chatFields.push(encodeBytesField(21, opts.modelDisplay));
  }

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
    assert.equal(Math.round(m.tps), 60); // visible respTok 600 / streamSec 10.0 (excludes 400 thinkTok in TTFT)
    assert.equal(Math.round(m.e2eTps * 10) / 10, 87); // total outTok 1000 / (1.5 + 10.0)
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

  it('tracks Orchestrator Plan/Exec model transitions and regular model Effort levels', () => {
    const dir = makeTempDir();
    const orchCid = '44444444-5555-6666-7777-888888888888';

    createConvDb(dir, orchCid, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 2000,
            outTok: 600,
            cacheRead: 8000,
            thinkTok: 200,
            respTok: 400,
            maxCtx: 512000,
            ttftSec: 2.0,
            streamSec: 4.0,
            modelEnum: 1667,
            modelId: 'gemini-pro-orchestrator',
            modelDisplay: 'Orchestrator (Carbon)'
          })
        },
        {
          idx: 1,
          blob: buildGenMetadataBlob({
            inTok: 1000,
            outTok: 400,
            cacheRead: 10000,
            thinkTok: 100,
            respTok: 300,
            maxCtx: 512000,
            ttftSec: 1.0,
            streamSec: 2.0,
            modelEnum: 1669,
            modelId: 'gemini-flash-worker-agy',
            modelDisplay: 'Gemini 4 Hydrogen (Orchestrator)'
          })
        }
      ],
      steps: [{ idx: 0, stepType: 14 }]
    });

    const om = parseConversationMetrics(orchCid, dir);
    assert.ok(om && om.hasData);
    assert.equal(om.isOrchestrator, true);
    assert.equal(om.orchestratorPhase, 'exec');
    assert.equal(om.activeShortModel, 'Hydrogen');
    assert.equal(om.activeEffort, '');
    assert.equal(om.orchPlanCalls, 1);
    assert.equal(om.orchPlanModel, 'Carbon');
    assert.equal(om.orchPlanOut, 600);
    assert.equal(om.orchExecCalls, 1);
    assert.equal(om.orchExecModel, 'Hydrogen');
    assert.equal(om.orchExecOut, 400);

    const stdCid = '55555555-6666-7777-8888-999999999999';
    createConvDb(dir, stdCid, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 2000,
            outTok: 500,
            cacheRead: 18000,
            thinkTok: 150,
            respTok: 350,
            maxCtx: 256000,
            ttftSec: 1.2,
            streamSec: 3.0,
            modelEnum: 1528,
            modelId: 'gemini-4-hydrogen',
            modelDisplay: 'Gemini 4 Hydrogen (XHigh)'
          })
        }
      ]
    });

    const sm = parseConversationMetrics(stdCid, dir);
    assert.ok(sm && sm.hasData);
    assert.equal(sm.isOrchestrator, false);
    assert.equal(sm.orchestratorPhase, '');
    assert.equal(sm.activeShortModel, '4 Hydrogen');
    assert.equal(sm.activeEffort, 'XHigh');
  });

  it('splits TokenBreakdown into Sys, ToolDefs, ToolCalls (GENERIC), Model, and User', () => {
    const dir = makeTempDir();
    const cid = '66666666-7777-8888-9999-aaaaaaaaaaaa';

    const makeSubItem = (label: string, toks: number) =>
      concatProtoFields([encodeBytesField(1, label), encodeVarintField(3, toks)]);
    const makeCategory = (name: string, kind: number, toks: number, subs: Uint8Array[] = []) =>
      concatProtoFields([
        encodeBytesField(1, name),
        encodeVarintField(2, kind),
        encodeVarintField(4, toks),
        ...subs.map((s) => encodeBytesField(5, s))
      ]);

    const tb = concatProtoFields([
      encodeBytesField(1, makeCategory('System Prompt', 1, 4000)),
      encodeBytesField(1, makeCategory('Rules', 3, 2500)),
      encodeBytesField(1, makeCategory('Tools', 2, 10800)),
      encodeBytesField(1, makeCategory('Skills', 5, 3400)),
      encodeBytesField(
        1,
        makeCategory('Chat Messages', 7, 260000, [
          makeSubItem('0: USER_INPUT', 1500),
          makeSubItem('1: PLANNER_RESPONSE', 92000),
          makeSubItem('2: GENERIC', 165000),
          makeSubItem('3: SYSTEM_MESSAGE', 1500)
        ])
      )
    ]);

    const usage = concatProtoFields([
      encodeVarintField(2, 6700),
      encodeVarintField(3, 800),
      encodeVarintField(5, 280000),
      encodeVarintField(9, 200),
      encodeVarintField(10, 600)
    ]);
    const ctxWin = concatProtoFields([encodeBytesField(3, tb), encodeVarintField(4, 512000)]);
    const chat = concatProtoFields([
      encodeBytesField(4, usage),
      encodeBytesField(9, encodeBytesField(10, ctxWin))
    ]);
    const rowWithBd = encodeBytesField(1, chat);

    // Row 1 omits ctxWin.3 to verify fallback to most recent row with breakdown
    const rowWithoutBd = buildGenMetadataBlob({
      inTok: 3000,
      outTok: 500,
      cacheRead: 293600,
      thinkTok: 100,
      respTok: 400,
      maxCtx: 512000,
      ttftSec: 1.0,
      streamSec: 4.0
    });

    createConvDb(dir, cid, {
      genRows: [
        { idx: 0, blob: rowWithBd },
        { idx: 1, blob: rowWithoutBd }
      ],
      steps: [{ idx: 0, stepType: 14 }]
    });

    const m = parseConversationMetrics(cid, dir);
    assert.ok(m && m.hasData);
    assert.equal(m.hasCtxBreakdown, true);
    assert.equal(m.ctxBreakdownSys, 8000); // 4000 + 2500 + 1500 SYSTEM_MESSAGE
    assert.equal(m.ctxBreakdownToolDefs, 14200); // 10800 + 3400
    assert.equal(m.ctxBreakdownToolCalls, 165000); // GENERIC tool calls/outputs
    assert.equal(m.ctxBreakdownModel, 92000); // PLANNER_RESPONSE
    assert.equal(m.ctxBreakdownUser, 1500); // USER_INPUT

    // Granular ctxDetail categories reconcile cleanly to latest ctxTokens (296600)
    assert.ok(m.ctxDetail);
    assert.equal(m.ctxDetail.exactFromSqlite, true);
    const catSum =
      m.ctxDetail.categories.messages +
      m.ctxDetail.categories.agentResponses +
      m.ctxDetail.categories.toolCalls +
      m.ctxDetail.categories.mcpTools +
      m.ctxDetail.categories.mcpInstructions +
      m.ctxDetail.categories.systemTools +
      m.ctxDetail.categories.systemPrompt +
      m.ctxDetail.categories.rulesFiles +
      m.ctxDetail.categories.skills +
      m.ctxDetail.categories.customAgents +
      m.ctxDetail.categories.systemMessages +
      m.ctxDetail.categories.checkpointBuffer;
    assert.equal(catSum, m.ctxTokens);
    assert.ok(m.ctxDetail.categories.rulesFiles > 0);
    assert.ok(m.ctxDetail.categories.skills > 0);
    assert.ok(m.ctxDetail.categories.agentThinking > 0);
    assert.ok(m.ctxDetail.categories.agentReplies > 0);
  });

  it('detects context compactions, saved tokens, deferred inventory, and heavy tool calls in sandbox', () => {
    const fakeHome = makeTempDir();
    const appData = path.join(fakeHome, '.gemini', 'antigravity');
    const convDir = path.join(appData, 'conversations');
    const cid = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    fs.mkdirSync(convDir, { recursive: true });

    // Create deferred MCP schema, skill, and on-demand rule in isolated fakeHome
    const mcpSrvDir = path.join(appData, 'mcp', 'demo-mcp');
    fs.mkdirSync(mcpSrvDir, { recursive: true });
    fs.writeFileSync(path.join(mcpSrvDir, 'query_docs.json'), JSON.stringify({ name: 'query_docs', description: 'a'.repeat(600) }));

    const skillDir = path.join(fakeHome, '.gemini', 'config', 'skills', 'demo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, `---\nname: demo-skill\ndescription: Demo skill\n---\n${'Skill body text '.repeat(120)}\n`);

    const rulesDir = path.join(fakeHome, '.gemini', 'config', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'lazy-rule.md'),
      `---\ntrigger: model_decision\n---\n${'Lazy rule content '.repeat(80)}\n`
    );

    // Create transcript with a tool call at step 1 -> GENERIC result at step 2
    const logsDir = path.join(appData, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const transcriptLines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Inspect repo' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        thinking: 'Let me run tests',
        content: 'Running tests now.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run unit tests' } }]
      }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'TAP version 13\nok 1\n' })
    ];
    fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), `${transcriptLines.join('\n')}\n`);

    const makeSubItem = (label: string, toks: number) =>
      concatProtoFields([encodeBytesField(1, label), encodeVarintField(3, toks)]);
    const makeCategory = (name: string, kind: number, toks: number, subs: Uint8Array[] = []) =>
      concatProtoFields([
        encodeBytesField(1, name),
        encodeVarintField(2, kind),
        encodeVarintField(4, toks),
        ...subs.map((s) => encodeBytesField(5, s))
      ]);

    const tbAfterCompact = concatProtoFields([
      encodeBytesField(1, makeCategory('System Prompt', 1, 4000)),
      encodeBytesField(1, makeCategory('Tools', 2, 8000)),
      encodeBytesField(1, makeCategory('MCP', 4, 500)),
      encodeBytesField(
        1,
        makeCategory('Chat Messages', 7, 47500, [
          makeSubItem('0: USER_INPUT', 500),
          makeSubItem('1: PLANNER_RESPONSE', 5000),
          makeSubItem('2: GENERIC', 28000),
          makeSubItem('3: CHECKPOINT', 14000)
        ])
      )
    ]);
    const postCompactChat = concatProtoFields([
      encodeBytesField(
        4,
        concatProtoFields([
          encodeVarintField(2, 12000),
          encodeVarintField(3, 600),
          encodeVarintField(5, 48000),
          encodeVarintField(9, 200),
          encodeVarintField(10, 400)
        ])
      ),
      encodeBytesField(9, encodeBytesField(10, concatProtoFields([encodeBytesField(3, tbAfterCompact), encodeVarintField(4, 256000)])))
    ]);

    createConvDb(convDir, cid, {
      genRows: [
        {
          idx: 0,
          blob: buildGenMetadataBlob({
            inTok: 20000,
            outTok: 1000,
            cacheRead: 190000, // 210k before compaction
            thinkTok: 300,
            respTok: 700,
            maxCtx: 256000,
            ttftSec: 1.0,
            streamSec: 4.0
          })
        },
        {
          idx: 1,
          blob: encodeBytesField(1, postCompactChat) // 60k after compaction -> 150k saved!
        }
      ],
      steps: [{ idx: 0, stepType: 14 }]
    });

    const m = parseConversationMetrics(cid, convDir, { homedir: fakeHome });
    assert.ok(m && m.hasData && m.ctxDetail);
    assert.equal(m.compactionCount, 1);
    assert.equal(m.compactionSavedTokens, 150000);
    assert.ok(m.ctxDetail.categories.checkpointBuffer > 0);
    assert.ok(m.ctxDetail.deferred.mcpTokens > 0);
    assert.ok(m.ctxDetail.deferred.skillsTokens > 0);
    assert.ok(m.ctxDetail.deferred.rulesTokens > 0);
    assert.equal(m.ctxDetail.heavyToolCalls.length, 1);
    assert.equal(m.ctxDetail.heavyToolCalls[0].label, 'run_command: Run unit tests');
    assert.equal(m.ctxDetail.heavyToolCalls[0].tokens, 28000);
  });
});
