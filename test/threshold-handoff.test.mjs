/**
 * The wired path: apply() -> agent/pre-step -> the project handoff document on disk.
 *
 * Why a boot test and not only the pure decision: this plugin's history is full of features whose
 * unit test passed against a string nobody rendered. `handoffWriteDecision` proves WHEN to write;
 * it proves nothing about whether anything is ever written, where, or whether it happens before the
 * fold that destroys the surface it describes. Those are the three claims this file tests.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'threshold-handoff-home-'));
const ws = mkdtempSync(join(tmpdir(), 'threshold-handoff-ws-'));
process.env.DSH_HOME = home;
process.env.DSH_ACP_METRICS = join(home, 'acp-metrics.jsonl');

const { apply, dispose } = await import('../lib/index.js');

// A fold starts the ingest worker; its MessagePort is a live handle, so the suite must end it
// explicitly or the test process hangs forever with no failing test to show for it.
after(() => { dispose(); });

// Temp-dir cleanup belongs at exit, not in after(): the worker still holds the directory when the
// hook returns and rmSync then fails EPERM (measured). Same shape as metrics-status.test.mjs.
process.on('exit', () => {
  for (const d of [home, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** The smallest ctx that boots the plugin, with a working directory a handoff can land in. */
function boot({ id, shrink = true, config = {} } = {}) {
  const handlers = new Map();
  const logs = [];
  const observedAtFold = [];
  let used = 950000;
  const sessionId = `threshold-${id}`;
  const file = join(ws, '.dsh-handoff', `handoff-${sessionId}.md`);
  const meter = {
    measure: () => ({ totalTokens: used, nodes: Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, tokens: 95000 })) }),
  };
  const compaction = {
    compactRegion: async (start, end) => {
      // Did the document exist at the moment the surface was folded? That ordering is the whole
      // point: a document written AFTER the fold describes a surface nobody can see any more.
      observedAtFold.push(existsSync(file));
      if (shrink) used = 300000;
      return { shadowedRange: { start, end }, shadowedSeqs: [1, 2, 3, 4, 5, 6, 7, 8] };
    },
  };
  const llm = { resolveModelInfo: async () => ({ contextWindow: 1000000 }) };
  const ctx = {
    tools: { register: (d) => d },
    get: (k) => (k === 'tokenMeter' ? meter : k === 'llm' ? llm : k === 'compaction' ? compaction : undefined),
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error() {}, debug() {} },
    effect: () => {}, provide: () => {},
    on: (evt, fn) => { handlers.set(evt, fn); },
  };
  apply(ctx, { minContextLimit: '78%', maxContextLimit: '90%', ...config });
  const events = [
    { seq: 1, type: 'user/message', data: { message: { content: 'ship the threshold handoff' } } },
    { seq: 2, type: 'tool/result', data: { name: 'pwsh', text: 'z'.repeat(300) } },
  ];
  const session = {
    id: sessionId,
    header: { cwd: ws },
    surface: { nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ownEvents: () => events,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'probe' } }),
    ctx,
  };
  return { agent: { session, ctx, options: {} }, handlers, logs, observedAtFold, file };
}

test('the threshold leaves the project document on disk BEFORE the fold', async () => {
  const b = boot({ id: 'wired' });
  const preStep = b.handlers.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'the threshold handoff must hang off agent/pre-step');
  await preStep({ agent: b.agent }, () => {});
  assert.ok(existsSync(b.file), 'the handoff must exist in the session working directory: ' + b.file);
  assert.deepEqual(b.observedAtFold, [true], 'it must already be on disk when the fold runs');
  const doc = readFileSync(b.file, 'utf8');
  assert.match(doc, /- written because: ACP hard limit/, 'the document says why it exists');
  assert.match(doc, /## Context budget \(ACP\)/);
  assert.match(doc, /ship the threshold handoff/, 'the session objective is carried');
  assert.ok(b.logs.some((l) => /acp threshold handoff: level hard/.test(l)), 'the write is logged: ' + b.logs.join(' | '));
});

test('the document is written once per level, not on every step', async () => {
  // shrink:false keeps `used` past the limit, so the second step reaches the same level again.
  const b = boot({ id: 'once', shrink: false });
  const preStep = b.handlers.get('agent/pre-step');
  await preStep({ agent: b.agent }, () => {});
  await preStep({ agent: b.agent }, () => {});
  const writes = b.logs.filter((l) => /acp threshold handoff: level/.test(l));
  assert.equal(writes.length, 1, 'a second step at the same level must not rewrite the file');
});

test('the soft crossing writes the document even when no fold follows', async () => {
  // maxContextLimit 120% clamps to the window, so 950k is past soft (780k) and below hard (1M):
  // the durable copy exists even when the trigger decides not to fold.
  const b = boot({ id: 'soft', config: { minContextLimit: '78%', maxContextLimit: '120%' } });
  await b.handlers.get('agent/pre-step')({ agent: b.agent }, () => {});
  assert.deepEqual(b.observedAtFold, [], 'nothing to fold at the soft level');
  assert.ok(existsSync(b.file), 'but the document is still written');
  assert.match(readFileSync(b.file, 'utf8'), /- written because: ACP soft limit/);
});

test('handoffOnThreshold: false leaves the working directory alone', async () => {
  const b = boot({ id: 'off', config: { handoffOnThreshold: false } });
  await b.handlers.get('agent/pre-step')({ agent: b.agent }, () => {});
  assert.equal(existsSync(b.file), false, 'the escape hatch must be honest');
  assert.equal(b.logs.filter((l) => /acp threshold handoff/.test(l)).length, 0);
});
