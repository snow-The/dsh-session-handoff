/**
 * The wired path: apply() -> acp_status -> the text a user reads.
 *
 * Why a boot test and not just the pure renderers: this plugin once had a banner whose unit test
 * passed against a string that nobody rendered. The metrics block is only worth anything if the
 * tool actually prints it, next to a journal that actually has rows.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'acp-status-'));
process.env.DSH_HOME = dir;
process.env.DSH_ACP_METRICS = join(dir, 'acp-metrics.jsonl');
process.env.DSH_NOTEMAP_RETRIEVAL = join(dir, 'notemap-retrieval.jsonl');

const ROWS = [
  { v: 1, ts: 1000, session: 's1', start: 1, end: 9, nodes: 8, before: 10000, after: 4000, lossTokens: 6000, lossCostCNY: 0.5, ms: 300, userMsgs: 3 },
  { v: 1, ts: 4000, session: 's1', start: 10, end: 20, nodes: 10, before: 8000, after: 3000, lossTokens: 5000, lossCostCNY: 0.4, ms: 200, userMsgs: 7 },
];
writeFileSync(process.env.DSH_ACP_METRICS, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(process.env.DSH_NOTEMAP_RETRIEVAL,
  JSON.stringify({ v: 1, tool: 'notemap_neighbors', truncated: true }) + '\n'
  + JSON.stringify({ v: 1, tool: 'notemap_paths', unknown_id: 'readimm8' }) + '\n');

const { apply, dispose } = await import('../lib/index.js');
const { readMetrics } = await import('../lib/metrics.js');

// A fold starts the ingest worker; its MessagePort is a live handle, so the suite must end it
// explicitly or the test process hangs forever with no failing test to show for it.
after(() => { dispose(); });

/** The smallest ctx that boots the plugin: register, services, lifecycle hooks. */
function boot() {
  const registered = [];
  const meter = { measure: () => ({ totalTokens: 1234, nodes: [{ seq: 1, tokens: 1234 }] }) };
  const llm = { resolveModelInfo: async () => ({ contextWindow: 10000 }) };
  const ctx = {
    tools: { register: (d) => { registered.push(d); return d; } },
    get: (k) => (k === 'tokenMeter' ? meter : k === 'llm' ? llm : undefined),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: () => {}, on: () => {}, provide: () => {},
  };
  apply(ctx, { minContextLimit: '50%', maxContextLimit: '90%' });
  const session = {
    id: 's1',
    surface: { nodes: [1, 2, 3] },
    events: [],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'probe' } }),
    ctx,
  };
  const agent = { session, ctx, options: { provider: "deepseek", model: "probe" } };
  return { registered, agent };
}

test('acp_status prints the budget ledger, the four layers and the pooled view', async () => {
  const { registered, agent } = boot();
  const status = registered.find((t) => t.name === 'acp_status');
  assert.ok(status, "acp_status must be registered");
  const text = await status.execute({}, { agent });

  assert.match(text, /budget: used 1234 tok = 12\.3% of 10000 \(window reported by the host\) \| soft 5000 = 50\.0% \| hard 9000 = 90\.0% \| unit: tokenMeter estimate/,
    'ratio, absolute cap and unit in one line: ' + text.split('\n')[1]);
  assert.match(text, /L1 stored: 1234 tok on the surface \/ 3 nodes \/ 0 collapsed/);
  assert.match(text, /L2 delivered \(billed\): not recorded for this session yet/);
  assert.match(text, /L3 work: 2 compaction\(s\), ~11000 tok lost to prefix-cache misses, ≈0\.900 CNY, 500 ms in folds, 7 user turns so far/);
  assert.match(text, /L4 outcome \(proxy\): gap between the last two folds 3\.0s/);
  assert.match(text, /retrieval signals: 2 degenerate answer\(s\) — 1 truncated, 1 unknown_id, 0 unresolved/);
  assert.match(text, /restatement of the same request by the user: NOT measured/);
  assert.match(text, /pooled: 2 compaction\(s\) across 1 session\(s\), avg shrink 61\.1%/);
  assert.match(text, /this session: 2, avg shrink 61\.1%/);
  assert.match(text, /compactions this session: 2 in the journal \(0 in this process - a restart resets that ledger\)/,
    'the journal and the in-process ledger must not contradict each other');
});

test('without a journal the status says so — it does not invent zeros', async () => {
  process.env.DSH_ACP_METRICS = join(dir, 'absent.jsonl');
  const { registered, agent } = boot();
  const text = await registered.find((t) => t.name === 'acp_status').execute({}, { agent });
  assert.match(text, /pooled: no compactions recorded in the journal/);
  assert.match(text, /L4 outcome \(proxy\): no fold recorded for this session/);
  assert.match(text, /compactions this session: none recorded/);
  assert.ok(!/avg shrink/.test(text), 'no data must not render as a shrink figure');
  process.env.DSH_ACP_METRICS = join(dir, 'acp-metrics.jsonl');
});

test('an unknown window is printed as UNKNOWN, never as a full context', async () => {
  const registered = [];
  const meter = { measure: () => ({ totalTokens: 999999, nodes: [] }) };
  const ctx = {
    tools: { register: (d) => { registered.push(d); return d; } },
    get: (k) => (k === 'tokenMeter' ? meter : undefined),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: () => {}, on: () => {}, provide: () => {},
  };
  apply(ctx, { minContextLimit: "50%", maxContextLimit: "90%" });
  const session = { id: 's2', surface: { nodes: [] }, events: [], requestHeader: () => ({ config: {} }), ctx };
  const text = await registered.find((t) => t.name === "acp_status").execute({}, { agent: { session, ctx } });
  assert.match(text, /window UNKNOWN/);
  assert.match(text, /no-llm-service|no-provider-model/, 'the reason is named: ' + text);
  const budgetLine = text.split('\n').find((l) => l.startsWith('budget:'));
  assert.ok(!/%/.test(budgetLine), 'no percentage may be manufactured without a denominator: ' + budgetLine);
});

/**
 * The automatic fold: this is the half that must never need a human or a model decision. The tool
 * `acp_compress` is the model folding EARLY (its own choice); this is the host folding at the fuse,
 * on `agent/pre-step`, before the request is built. If this test goes red, "跑下去" is a lie.
 */
function bootAutoFold({ shrink = true } = {}) {
  const handlers = new Map();
  const registered = [];
  const logs = [];
  const foldedCalls = [];
  let used = 950000;
  const meter = { measure: () => ({ totalTokens: used, nodes: Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, tokens: 95000 })) }) };
  const compaction = {
    compactRegion: async (start, end) => {
      foldedCalls.push([start, end]);
      if (shrink) used = 300000;
      return { shadowedRange: { start, end }, shadowedSeqs: [1, 2, 3, 4, 5, 6, 7, 8] };
    },
  };
  const llm = { resolveModelInfo: async () => ({ contextWindow: 1000000 }) };
  const ctx = {
    tools: { register: (d) => { registered.push(d); return d; } },
    get: (k) => (k === 'tokenMeter' ? meter : k === 'llm' ? llm : k === 'compaction' ? compaction : undefined),
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error() {}, debug() {} },
    effect: () => {}, provide: () => {},
    on: (evt, fn) => { handlers.set(evt, fn); },
  };
  apply(ctx, { minContextLimit: '78%', maxContextLimit: '90%' });
  const session = {
    id: 'auto-fold-' + (shrink ? 'ok' : 'stuck'),
    surface: { nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    events: [],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'probe' } }),
    ctx,
  };
  return { agent: { session, ctx, options: {} }, handlers, logs, foldedCalls, session };
}

test('the host folds by itself at the fuse — no model call, no user, no asking', async () => {
  const before = readMetrics().rows.length;
  const { agent, handlers, logs, foldedCalls } = bootAutoFold();
  const preStep = handlers.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'the automatic fold must hang off agent/pre-step');
  let nextCalled = false;
  await preStep({ agent }, () => { nextCalled = true; });
  // [2, 8]: index 0 is the system-prompt node and is NEVER folded (a host fold that rewrote it was a
  // real bug once); the last two nodes are the preserved tail.
  assert.deepEqual(foldedCalls, [[2, 8]], "everything foldable was folded, unprompted");
  assert.ok(nextCalled, "and the step then proceeds — the fold does not stop the run");
  assert.ok(logs.some((l) => /acp host-trigger: folded 950000 -> 300000/.test(l)), "the fold is logged: " + logs.join(" | "));
  const rows = readMetrics().rows;
  assert.equal(rows.length, before + 1, "the automatic fold leaves a journal row like any other fold");
  assert.equal(rows[rows.length - 1].before, 950000);
  assert.equal(rows[rows.length - 1].after, 300000);
});

test('a fold that does not shrink is reported and cooled down, not retried in a loop', async () => {
  const { agent, handlers, logs, foldedCalls } = bootAutoFold({ shrink: false });
  const preStep = handlers.get('agent/pre-step');
  await preStep({ agent }, () => {});
  assert.equal(foldedCalls.length, 1);
  assert.ok(logs.some((l) => /FOLD FAILED/.test(l)), "a fold that achieved nothing must say so: " + logs.join(" | "));
  await preStep({ agent }, () => {});
  assert.equal(foldedCalls.length, 1, "the cooldown stops a failing fold from being retried on every step");
});

after(() => {
  dispose();
  console.log('ACTIVE RESOURCES AFTER TESTS: ' + JSON.stringify(process.getActiveResourcesInfo()));
});

process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });