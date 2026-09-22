// A settle row is a MEASUREMENT of one fold's cache bill, written by a later pre-step. Counting it as
// a fold would double the compaction count, add a second loss figure for the same event, and turn
// "the gap between the last two folds" into the milliseconds between a fold and its own settle row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pooledSummary, foldRows, layerLines, outcomeLines } from '../lib/metrics.js';

const tmp = mkdtempSync(join(tmpdir(), 'acpsettle-'));
process.env.DSH_HOME = tmp;
process.env.DSH_ACP_METRICS = join(tmp, 'acp-metrics.jsonl');
mkdirSync(join(tmp, 'storages'), { recursive: true });

const mod = await import('../lib/index.js');
const { scheduleCacheSettle, settleCacheBill } = mod.__internals;

/** The harness's own per-session usage row, in the shape cache-stats.js reads. */
const writeProjCache = (hits, misses) => writeFileSync(join(tmp, 'storages', 'session_projcache.json'), JSON.stringify({
  tables: { sessions: { s1: { rows: { tokenUsage: { val: { totals: { cacheReadTokens: hits, uncachedInputTokens: misses } } } } } } },
}));

test('settle rows measure a fold, they never count as one', () => {
  const rows = [
    { kind: 'fold', ts: 1000, session: 's1', before: 10000, after: 4000, lossTokens: 3600, lossCostCNY: 0.004 },
    { kind: 'fold', ts: 60000, session: 's1', before: 9000, after: 3000, lossTokens: 2700, lossCostCNY: 0.003 },
    { kind: 'settle', ts: 2000, session: 's1', foldTs: 1000, uncachedTokens: 4000, cachedTokens: 120, estimatedTokens: 3600 },
  ];
  assert.equal(foldRows(rows).length, 2, 'only two of the three rows record a fold');
  const pooled = pooledSummary(rows);
  assert.equal(pooled.compactions, 2, 'a settle row is not a third fold');
  assert.equal(pooled.lossTokens, 6300, 'and it must not add a second loss figure for the same event');
  assert.equal(pooled.settled, 1);
  assert.equal(pooled.settledUncached, 4000);
  assert.equal(pooled.settledCached, 120);
  const lines = layerLines({
    work: { compactions: pooled.compactions, lossTokens: pooled.lossTokens, lossCostCNY: pooled.lossCostCNY,
            settled: pooled.settled, settledUncached: pooled.settledUncached, settledCached: pooled.settledCached },
  });
  assert.match(lines[3], /^L3 measured: 1 fold bill\(s\) settled from the harness counters — 4000 uncached \+ 120 cached tok billed after the fold$/);
  // Rows written before v0.18.4 carry no kind: they ARE folds and must keep counting as folds.
  assert.equal(pooledSummary([{ ts: 1, session: 'old', before: 100, after: 50, lossTokens: 10 }]).compactions, 1);
  const l4 = outcomeLines({ rows, sessionId: 's1' });
  assert.match(l4[0], /gap between the last two folds 59\.0s/, 'L4 reads folds, not settle rows: ' + l4[0]);
});

test('a fold settles its measured cache bill — once, and only after the counters move', () => {
  const session = { id: 's1' };
  writeProjCache(100000, 5000);
  scheduleCacheSettle(session, { ts: 111, cacheAtFold: { hits: 100000, misses: 5000 }, estimated: 4000, estimatedCostCNY: 0.004 });
  assert.equal(settleCacheBill(session), false, 'nothing billed since the fold: not settled yet');
  writeProjCache(100120, 9000);            // the post-fold call billed 4000 uncached + 120 cached
  assert.equal(settleCacheBill(session), true, 'the counters moved: the bill is now measurable');
  assert.equal(settleCacheBill(session), false, 'a settled fold is never settled twice');
  const rows = readFileSync(process.env.DSH_ACP_METRICS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.kind === 'settle');
  assert.ok(row, 'the settle row was appended: ' + JSON.stringify(rows));
  assert.equal(row.session, 's1');
  assert.equal(row.foldTs, 111);
  assert.equal(row.uncachedTokens, 4000);
  assert.equal(row.cachedTokens, 120);
  assert.equal(row.estimatedTokens, 4000, 'the estimate is kept beside the measurement, never instead of it');
});

test('cleanup', () => { rmSync(tmp, { recursive: true, force: true }); });
