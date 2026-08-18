import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendThresholds } from '../lib/acp-recommend.js';

test('recommendThresholds returns valid percent limits for a 1M window', () => {
  const r = recommendThresholds({ windowTokens: 1048576 });
  assert.match(r.min, /^\d+%$/);
  assert.match(r.max, /^\d+%$/);
  const min = Number(r.min.slice(0, -1));
  const max = Number(r.max.slice(0, -1));
  assert.ok(min >= 1 && max <= 95);
  assert.ok(min < max, `soft ${min}% must be below hard ${max}%`);
  assert.ok(max <= 90, 'fuse must not exceed 90%');
});

test('heavier per-turn growth lowers the soft limit (earlier active compaction)', () => {
  const light = recommendThresholds({ windowTokens: 1048576, growthPerTurn: 10000 });
  const heavy = recommendThresholds({ windowTokens: 1048576, growthPerTurn: 50000 });
  assert.ok(
    Number(heavy.min.slice(0, -1)) < Number(light.min.slice(0, -1)),
    `heavy ${heavy.min} should be below light ${light.min}`,
  );
});

test('hard limit stays at the fuse with a burst margin below the window', () => {
  const r = recommendThresholds({ windowTokens: 1048576, growthPerTurn: 50000 });
  assert.ok(r.maxTokens < r.windowTokens);
  assert.ok(r.windowTokens - r.maxTokens >= 50000, 'at least a 50k burst margin');
});

test('small windows still yield valid ordered limits', () => {
  const r = recommendThresholds({ windowTokens: 131072, growthPerTurn: 5000 });
  const min = Number(r.min.slice(0, -1));
  const max = Number(r.max.slice(0, -1));
  assert.ok(min >= 1 && max <= 95);
  assert.ok(min < max);
});

test('reasoning lines explain the cost model', () => {
  const r = recommendThresholds({ windowTokens: 1048576, growthPerTurn: 30000 });
  assert.ok(Array.isArray(r.reasoning) && r.reasoning.length >= 3);
  assert.ok(r.reasoning.some((line) => line.includes('fuse')));
  assert.ok(r.reasoning.some((line) => line.includes('runway')));
});

test('invalid window tokens throw', () => {
  assert.throws(() => recommendThresholds({ windowTokens: 0 }));
  assert.throws(() => recommendThresholds({ windowTokens: Number.NaN }));
});
