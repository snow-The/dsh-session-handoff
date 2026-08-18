// Unit tests for the active-context-pruning internals: pressure math & range safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../lib/index.js';

const { parseLimit, thresholdTokens, pressureLevel, assertSafeRange } = __internals;

test('parseLimit handles percent and token forms', () => {
  assert.deepEqual(parseLimit('60%'), { ratio: 0.6, tokens: undefined });
  assert.deepEqual(parseLimit('2000'), { ratio: undefined, tokens: 2000 });
  assert.deepEqual(parseLimit(undefined), { ratio: 0.6, tokens: undefined });
});

test('thresholdTokens converts percent against window', () => {
  assert.equal(thresholdTokens(parseLimit('60%'), 1_000_000), 600_000);
  assert.equal(thresholdTokens(parseLimit('2000'), 1_000_000), 2000);
  assert.equal(thresholdTokens(parseLimit('60%'), undefined), Infinity);
});

test('pressureLevel classifies soft/hard/none', () => {
  assert.equal(pressureLevel(500_000, 600_000, 700_000), 'none');
  assert.equal(pressureLevel(650_000, 600_000, 700_000), 'soft');
  assert.equal(pressureLevel(750_000, 600_000, 700_000), 'hard');
});

test('assertSafeRange enforces surface membership and order', () => {
  const session = { surface: { nodes: [10, 20, 30, 40, 50] } };
  const config = { preserveRecent: 2 };
  // valid: end at index 2 (30) leaves the last 2 (40,50) untouched
  assert.doesNotThrow(() => assertSafeRange(session, 10, 30, config));
  // end too recent
  assert.throws(() => assertSafeRange(session, 10, 40, config), /cannot compress the last/);
  // start after end
  assert.throws(() => assertSafeRange(session, 30, 10, config), /after end/);
  // not on surface
  assert.throws(() => assertSafeRange(session, 11, 30, config), /not on the current surface/);
});
