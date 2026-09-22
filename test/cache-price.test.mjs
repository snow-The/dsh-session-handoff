
// The constant behind every cost estimate in this plugin. It was 0.1 for a while — 5x too expensive —
// and because it weighs CARRYING (cache reads) against FOLDING (one full miss), the error inverted the
// advice it fed. It is now the published ratio, and it is configurable, because prices are data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_HIT_PRICE_RATIO, compactionCacheLoss, formatCacheLine } from '../lib/cache-stats.js';

test('the cache-hit price is 2% of the miss price, and a fold is priced on that difference', () => {
  assert.equal(CACHE_HIT_PRICE_RATIO, 0.02, "DeepSeek's table: 0.02/1 off-peak and 0.04/2 peak, so 2% either way");
  // Re-sending a million tokens that would have been cache hits costs (1 - 0.02) CNY at 1 CNY/M.
  const loss = compactionCacheLoss(1_000_000, 1);
  assert.equal(loss.tokens, 1_000_000);
  assert.equal(loss.costCNY, 0.98);
  // The ratio is a parameter: another provider's price is a config value, not a code edit.
  assert.equal(compactionCacheLoss(1_000_000, 1, 0.1).costCNY, 0.9);
  assert.equal(compactionCacheLoss(1_000_000, 2, 0.02).costCNY, 1.96, 'peak pricing doubles the bill, not the ratio');
});

test('the hit-rate line reports the misses share under the same ratio', () => {
  const line = formatCacheLine({ hits: 3_513_708_672, misses: 52_516_278, total: 3_566_224_950, hitRate: 0.985 }, 0.02);
  // 52.5M misses against 3513.7M hits at 2%: misses are 43% of the prompt bill, not the 13% the 10%
  // ratio reported for the same session.
  assert.match(line, /misses are 4\d\.\d% of prompt cost/, line);
  assert.match(line, /98\.5% hit/);
});
