// Unit tests for the active-context-pruning internals: pressure math & range safety.
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { __internals } from '../lib/index.js';

const { parseLimit, thresholdTokens, pressureLevel, assertSafeRange } = __internals;


test('estimateGrowth ignores hidden nodes after compression', () => {
  // Simulate a session right after acp_compress: the turn markers span a
  // seq range that includes hidden (non-surface) nodes with large token
  // pricing. Those must NOT be counted — they no longer occupy context.
  const events = [];
  // turn 1 markers + heavy nodes that got compressed away
  events.push({ seq: 100, type: 'turn/start', data: {} });
  for (let i = 101; i <= 130; i++) events.push({ seq: i, type: 'user/message', data: { message: { content: 'x'.repeat(200) } } });
  events.push({ seq: 131, type: 'turn/start', data: {} });
  for (let i = 132; i <= 140; i++) events.push({ seq: i, type: 'tool/result', data: { text: 'y'.repeat(150) } });
  events.push({ seq: 141, type: 'turn/start', data: {} });
  // after compression only a few nodes remain on the surface
  const session = {
    events,
    surface: { nodes: [141] }, // only the latest turn marker survives
  };
  const meter = {
    measure: () => ({
      nodes: [
        ...events.map((e, idx) => ({ seq: e.seq, tokens: idx % 3 === 0 ? 5000 : 800 })),
      ],
    }),
  };
  const ctx = { get: (k) => (k === 'tokenMeter' ? meter : undefined) };
  const growth = __internals.estimateGrowth(ctx, { session }, 5);
  // Hidden nodes (100..140) must be excluded; only surface seq 141 is counted,
  // which alone is not enough pricing (pricedCount < 2) → falls through to the
  // char path, still surface-filtered. Either way growth must stay tiny, not ~100k.
  assert.ok(growth < 5000, 'growth must not include hidden nodes, got ' + growth);
});

test('estimateGrowth counts only surface nodes for pricing', () => {
  const events = [
    { seq: 200, type: 'turn/start', data: {} },
    { seq: 201, type: 'user/message', data: { message: { content: 'a'.repeat(600) } } },
    { seq: 202, type: 'assistant/message', data: { message: { content: 'b'.repeat(600) } } },
    { seq: 203, type: 'turn/start', data: {} },
  ];
  const session = { events, surface: { nodes: [200, 201, 202, 203] } };
  const meter = {
    measure: () => ({ nodes: [{ seq: 200, tokens: 10 }, { seq: 201, tokens: 300 }, { seq: 202, tokens: 500 }, { seq: 203, tokens: 10 }] }),
  };
  const ctx = { get: (k) => (k === 'tokenMeter' ? meter : undefined) };
  const growth = __internals.estimateGrowth(ctx, { session }, 5);
  // (10+300+500+10) / 1 span = 820
  assert.equal(growth, 820);
});

// --- deep fold: one compaction should buy many turns ----------------------------
// The cost model is in dsh-agent-loop/lib/index.js:1019 (a surface replacement makes the
// host re-project the system prompt and start a new request series -> full-prefix miss).
import { deepFoldStart } from '../lib/index.js';

function meterFor(nodes) {
  return { measure: () => ({ nodes, totalTokens: nodes.reduce((s, n) => s + n.tokens, 0) }) };
}

test('a shallow fold is extended back until the surface reaches the target ratio', () => {
  // 10 nodes x 10k = 100k total; window 100k -> target 35k -> the folded range must cover ~65k
  const nodes = Array.from({ length: 10 }, (_, i) => ({ seq: 100 + i, tokens: 10000 }));
  const session = { surface: { nodes: nodes.map((n) => n.seq) } };
  const start = deepFoldStart(meterFor(nodes), session, { compressTargetRatio: 0.35 }, 108, 109, 100000);
  // folding only 108..109 (20k) leaves 80k; extending back to ~104 gives ~60k folded (40k left)
  assert.ok(start < 108, 'start must move earlier, got ' + start);
  const si = session.surface.nodes.indexOf(start);
  const folded = nodes.slice(si).reduce((s, n) => s + n.tokens, 0);
  assert.ok(folded >= 55000, 'fold should be deep, folded=' + folded);
});

test('no extension when the surface is already at or below the target', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ seq: 1 + i, tokens: 1000 })); // 10k total
  const session = { surface: { nodes: nodes.map((n) => n.seq) } };
  // target 0.35 * 100000 = 35k, total is only 10k -> nothing to gain
  assert.equal(deepFoldStart(meterFor(nodes), session, { compressTargetRatio: 0.35 }, 8, 9, 100000), 8);
});

test('unknown or unpaired boundaries leave the caller range untouched', () => {
  const nodes = [{ seq: 1, tokens: 1000 }];
  const session = { surface: { nodes: [1] } };
  assert.equal(deepFoldStart(meterFor(nodes), session, {}, 1, 999, 1000), 1, 'unknown end -> unchanged');
  assert.equal(deepFoldStart(meterFor(nodes), { surface: { nodes: [] } }, {}, 5, 6, 1000), 5, 'unknown start -> unchanged');
});

test('a missing ratio falls back to 35 percent', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ seq: 1 + i, tokens: 10000 }));
  const session = { surface: { nodes: nodes.map((n) => n.seq) } };
  const withDefault = deepFoldStart(meterFor(nodes), session, {}, 9, 10, 100000);
  const explicit = deepFoldStart(meterFor(nodes), session, { compressTargetRatio: 0.35 }, 9, 10, 100000);
  assert.equal(withDefault, explicit);
});

// --- structural guard: tool parameter schemas ----------------------------------
// The host's schema compiler REJECTS the mere presence of `required: false`
// ("parameters.X.required must be true when present") and then the whole plugin tree
// fails to load — DSH cannot boot at all. Optional parameters must simply omit the key.
// This shipped once (acp_compress.start) and took the harness down; the test below fails
// if it ever comes back. Comments are stripped so an explanatory comment cannot trip it.
test('no tool parameter declares required:false (the host rejects the key outright)', () => {
  const dir = new URL('../lib/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const raw = readFileSync(new URL(f, dir), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    code.split('\n').forEach((line, i) => {
      if (/\brequired\s*:\s*false\b/.test(line)) offenders.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 90));
    });
  }
  assert.deepEqual(offenders, [], 'required:false kills the plugin tree at load');
});

// --- banner/status wording: percentages must never read as "context full" ----------
// Production complaint: "只到730K就说到100%" — the soft limit (730k) was rendered as a bare
// percentage, so a context at the limit read as a full window even though the window is 1M.
import { renderStatus } from '../lib/index.js';

const stub = (usedTokens) => ({
  ctx: { get: (name) => (name === 'tokenMeter' ? { measure: () => ({ totalTokens: usedTokens, nodes: [] }) } : undefined) },
  agent: { session: { id: 's', surface: { nodes: [] } } },
});

test('the quiet line reports fullness against the WINDOW, and the soft limit as a threshold', () => {
  const { ctx, agent } = stub(730000);
  const line = renderStatus(ctx, agent, {}, 1000000, undefined, { quiet: true });
  assert.match(line, /^ACP: 730000\/1000000 tokens \(/, 'the live banner shape: ' + line);
  assert.match(line, /73% of the window/, 'window percentage first: ' + line);
  // the resolved limits depend on config — assert they are NAMED as thresholds with their own
  // number and headroom, not that they equal a particular value
  assert.match(line, /soft limit \d+ — (reached|~\d+k left)/, 'soft headroom: ' + line);
  assert.match(line, /hard \d+ — (reached|~\d+k left)/, 'hard headroom must also be shown: ' + line);
  assert.ok(!/\(100%\)/.test(line), 'a bare 100% must never appear: ' + line);
  assert.ok(!/soft limit \d+ = \d+%/.test(line), 'the threshold must never be stated as a ratio: ' + line);
  assert.ok(!/= \d+%/.test(line), 'no bare threshold ratio anywhere: ' + line);
  assert.ok(!/window unknown/.test(line), 'a known window must not carry the diagnostic: ' + line);
});

test('an unknown window degrades to the threshold alone, never a fake percentage — and says why', () => {
  const { ctx, agent } = stub(130000);
  const line = renderStatus(ctx, agent, {}, undefined, undefined, { quiet: true, windowDiag: 'no-provider-model(?/?)' });
  assert.ok(!/% of the window/.test(line), 'no window -> no window percentage: ' + line);
  assert.match(line, /tokens/);
  assert.match(line, /\[window unknown: no-provider-model\(\?\/\?\)\]/, 'an unknown window must SAY why: ' + line);
  assert.ok(!/\d+\/undefined/.test(line), 'never print the literal undefined: ' + line);
});

// The banner used to be a second, hand-rolled copy inside the sh:acp:surface section while these
// tests exercised renderStatus quiet mode: they passed against a string nobody rendered. One owner.
test('the per-turn banner text has exactly one owner in lib/', () => {
  const dir = new URL('../lib/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const owners = files.filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('below soft limit, no compaction needed'));
  assert.deepEqual(owners, ['index.js'], 'the banner text must live in exactly one file, found: ' + owners.join(', '));
  const code = readFileSync(new URL('index.js', dir), 'utf8');
  assert.equal((code.match(/below soft limit, no compaction needed/g) ?? []).length, 1, 'and exactly once');
});

// --- the window cache: a probe that fails silently is worse than no probe ---------------
// Production line, live for the whole life of the feature:
//   ACP: 230768 tokens [window unknown: threw:windows is not defined]
// rememberWindow() is module-level and referenced two WeakMaps declared inside apply(), so EVERY
// call threw ReferenceError straight into an empty catch. The banner therefore never had a window,
// never showed the soft/hard limits, and "used >= soft" with soft = Infinity was never true — the
// ACP threshold the banner exists to advertise could not fire. Nothing failed loudly enough for a
// test to notice; these two tests are that notice.

test('the window cache actually caches a resolved window', async () => {
  const { rememberWindow, windows, windowDiag } = __internals;
  const session = { id: 'cache-test', requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) };
  const ctx = { get: (n) => (n === 'llm' ? { resolveModelInfo: async () => ({ contextWindow: 123456, defaultMaxTokens: 4096 }) } : undefined) };
  const info = await rememberWindow(ctx, { session });
  assert.equal(info?.window, 123456, 'the probe must return the window it resolved');
  assert.equal(windows.get(session), 123456, 'the per-session map must hold it (this is what threw)');
  assert.equal(windowDiag(), null, 'a success must clear the diagnostic: ' + windowDiag());
});

test('an unresolvable window says WHY, never a bare undefined', async () => {
  const { rememberWindow, windowDiag } = __internals;
  const session = { id: 'diag-test', requestHeader: () => ({ config: {} }) };
  assert.equal(await rememberWindow({ get: () => undefined }, { session }), null);
  assert.match(String(windowDiag()), /no-llm-service/, 'the banner prints this string: ' + windowDiag());
});

// --- who owns the compaction trigger ------------------------------------------------------
// The trigger used to be the model's alone: the banner asked, and if the model did not act
// nothing happened at all. That is a hope, not a policy -- and it failed silently for the whole
// life of the feature. No audited peer works this way (Letta fires inside the agent step off a
// message-count buffer; LangGraph ships no auto-compaction; Zep/mem0 compact nothing).
test('the host owns the trigger: past the fuse it folds, below it stays out of the way', () => {
  const { compactionDecision } = __internals;
  assert.equal(compactionDecision(500000, 880000, 950000), 'none');
  assert.equal(compactionDecision(949999, 880000, 950000), 'none');
  assert.equal(compactionDecision(950000, 880000, 950000), 'force');
  assert.equal(compactionDecision(950000, 880000, 950000, { hostTrigger: false }), 'none', 'the escape hatch must stay honest');
  assert.equal(compactionDecision(880000, 880000, 950000, { forceAt: 'soft' }), 'force', 'forceAt moves the fuse, it does not remove it');
  assert.equal(compactionDecision(100, Infinity, Infinity), 'none', 'an unresolved window must never fold');
});

test('a fold that does not shrink the context is a failure, never a no-op', () => {
  const { foldShrank } = __internals;
  assert.equal(foldShrank(900000, 300000).ok, true);
  assert.equal(foldShrank(900000, 899000).ok, false, 'a fold that frees ~nothing is a failure');
  assert.match(foldShrank(900000, 899000).reason, /only \d+ tokens freed/);
  assert.equal(foldShrank(NaN, 5).ok, false, 'unmeasurable is a failure, not a pass');
});
