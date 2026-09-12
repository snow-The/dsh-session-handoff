// Unit tests for the active-context-pruning internals: pressure math & range safety.
import { test } from 'node:test';
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
