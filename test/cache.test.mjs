/**
 * Regression tests for prompt-cache accounting (study: docs/PREFIX-CACHE-STUDY.md).
 *
 * The number these functions produce is a DECISION INPUT: every acp_compress bumps
 * surface.replaceGeneration, which makes the host re-project the system prompt and start
 * a new request series (dsh-agent-loop/lib/index.js:1019) - the next call re-sends the
 * whole prompt at the miss rate. If this accounting silently returned 0 (the classic
 * "failure indistinguishable from no data"), compaction would look free again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionCache, formatCacheLine, compactionCacheLoss, formatTokens, projCachePath } from '../lib/cache-stats.js';

function fixture(hits, misses) {
  const home = mkdtempSync(join(tmpdir(), 'handoff-cache-'));
  mkdirSync(join(home, 'storages'), { recursive: true });
  const file = join(home, 'storages', 'session_projcache.json');
  writeFileSync(file, JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: { sessions: { 'session-abc': { rows: { tokenUsage: { val: { totals: { uncachedInputTokens: misses, outputTokens: 10, cacheReadTokens: hits, cacheWriteTokens: 0 } } } } } } },
  }));
  return file;
}

test('hit rate uses the harness DISJOINT convention (input excludes cache reads)', () => {
  const stats = readSessionCache('session-abc', { file: fixture(1359509312, 87030652) });
  assert.equal(stats.hits, 1359509312);
  assert.equal(stats.misses, 87030652);
  assert.ok(Math.abs(stats.hitRate - 0.9399) < 0.001, 'expected ~94% hit rate, got ' + stats.hitRate);
});

test('missing data is null, never a fake zero-hit reading', () => {
  assert.equal(readSessionCache('session-not-there', { file: fixture(100, 100) }), null);
  assert.equal(readSessionCache('', { file: fixture(100, 100) }), null);
  assert.equal(readSessionCache(null, { file: fixture(100, 100) }), null);
  assert.equal(readSessionCache('session-abc', { file: join(tmpdir(), 'definitely-not-here-12345.json') }), null);
});

test('a torn or unreadable store degrades to null instead of throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'handoff-cache-bad-'));
  mkdirSync(join(home, 'storages'), { recursive: true });
  const file = join(home, 'storages', 'session_projcache.json');
  writeFileSync(file, '{"tables":{"sessions":{"session-abc":{"rows":{"tokenUsage":{"val":{"totals"'); // truncated write
  assert.doesNotThrow(() => readSessionCache('session-abc', { file }));
  assert.equal(readSessionCache('session-abc', { file }), null);
});

test('compaction cost = whole prompt re-sent at (miss - hit) price', () => {
  assert.deepEqual(compactionCacheLoss(200000, 1), { tokens: 200000, costCNY: 0.18 });
  assert.deepEqual(compactionCacheLoss(0, 1), { tokens: 0, costCNY: 0 });
  assert.deepEqual(compactionCacheLoss(-5, 1), { tokens: 0, costCNY: 0 });
  assert.deepEqual(compactionCacheLoss('120000', 2), { tokens: 120000, costCNY: 0.216 });
  assert.deepEqual(compactionCacheLoss(1000000, Number.NaN).costCNY, 0.9); // bad price -> default 1
});

test('the status line states the hit rate AND what misses cost', () => {
  const line = formatCacheLine({ hits: 1000000, misses: 100000, total: 1100000, hitRate: 1000000 / 1100000 });
  assert.match(line, /90\.9% hit/);
  assert.match(line, /of prompt cost/);
  assert.equal(formatCacheLine(null), 'prefix cache: no usage recorded for this session yet');
  assert.equal(formatCacheLine({ hits: 0, misses: 0, total: 0, hitRate: null }), 'prefix cache: no usage recorded for this session yet');
});

test('token formatting is human-scale', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2K');
  assert.equal(formatTokens(10603900000), '10.6B');
  assert.equal(formatTokens(Number.NaN), '0');
  assert.equal(formatTokens(-1), '0');
});

test('the projcache path honours DSH_HOME', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = 'X:\\fake-home';
  try {
    assert.equal(projCachePath(), join('X:\\fake-home', 'storages', 'session_projcache.json'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});
