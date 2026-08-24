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
