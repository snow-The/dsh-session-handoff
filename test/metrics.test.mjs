/**
 * The metrics journal, the budget ledger and the four layers.
 *
 * What these tests are really guarding: a metrics surface that reports a number where it has
 * none (a fake zero, or a percentage against an assumed window) is worse than no surface at all,
 * because it gets believed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMetric, readMetrics, readRetrievalSignals, pooledSummary, sessionSummary,
  budgetLedger, formatBudgetLine, layerLines, outcomeLines, formatPooledLine, formatDuration,
} from '../lib/metrics.js';

const dir = mkdtempSync(join(tmpdir(), 'acp-metrics-'));
const jpath = (name) => join(dir, name);

test('the budget ledger prints ratio, absolute cap and unit together — and UNKNOWN is not a number', () => {
  const reported = budgetLedger({ usedTokens: 123178, windowTokens: 1000000, softTokens: 780000, hardTokens: 900000 });
  assert.equal(reported.windowSource, 'reported');
  assert.equal(reported.ratio, 0.123178);
  const line = formatBudgetLine(reported);
  assert.match(line, /12\.3% of 1000000/);
  assert.match(line, /soft 780000 = 78\.0%/);
  assert.match(line, /hard 900000 = 90\.0%/);
  assert.match(line, /unit: /, 'a ratio without its unit is a label, not a measurement');

  const unknown = budgetLedger({ usedTokens: 123178, softTokens: 780000, windowReason: 'no-llm-service' });
  assert.equal(unknown.windowSource, 'unknown');
  assert.equal(unknown.ratio, null);
  const unknownLine = formatBudgetLine(unknown);
  assert.match(unknownLine, /window UNKNOWN/);
  assert.match(unknownLine, /no-llm-service/);
  assert.ok(!/%/.test(unknownLine), 'no percentage may be invented from an assumed window: ' + unknownLine);
});

test('the journal round-trips, and a torn line is counted, not thrown', () => {
  const file = jpath('journal.jsonl');
  assert.equal(appendMetric({ ts: 1, session: 's1', before: 100, after: 40 }, { file }), true);
  assert.equal(appendMetric({ ts: 2, session: 's1', before: 100, after: 50 }, { file }), true);
  writeFileSync(file, readFileSync(file, 'utf8') + '{not json\n\n');
  const read = readMetrics({ file });
  assert.equal(read.exists, true);
  assert.equal(read.rows.length, 2);
  assert.equal(read.skipped, 1, 'a corrupt line is reported, not silently dropped');
  assert.equal(read.total, 2);
  assert.equal(readMetrics({ file, limit: 1 }).rows.length, 1, 'limit takes the tail');
});

test('an unwritable journal is a false, never an exception', () => {
  const blocker = jpath('blocker');
  writeFileSync(blocker, 'x');
  const wrote = appendMetric({ ts: 3, session: 's1' }, { file: join(blocker, 'nested', 'j.jsonl') });
  assert.equal(wrote, false, 'a metrics failure must not become a failed compaction');
});

test('a full journal rotates instead of growing without bound', () => {
  const file = jpath('rotate.jsonl');
  appendMetric({ ts: 1, session: 's1' }, { file, maxBytes: 10 });
  appendMetric({ ts: 2, session: 's1' }, { file, maxBytes: 10 });
  assert.ok(statSync(file + '.1').size > 0, 'the old generation is kept');
  assert.equal(readMetrics({ file }).rows.length, 1, 'and the live file starts clean');
});

test('pooled and per-session are both reported, and they disagree on purpose', () => {
  const rows = [
    { ts: 10, session: 'deep', before: 1000, after: 200, lossTokens: 900, lossCostCNY: 0.9 },
    { ts: 20, session: 'shallow', before: 1000, after: 900, lossTokens: 100, lossCostCNY: 0.1 },
  ];
  const pooled = pooledSummary(rows);
  assert.equal(pooled.sessions, 2);
  assert.equal(pooled.compactions, 2);
  assert.equal(pooled.shrink, 0.45);
  assert.notEqual(pooled.shrink, 0.8, 'the pooled figure is not the typical one');
  assert.notEqual(pooled.shrink, 0.1);
  const deep = pooled.perSession.find((s) => s.session === 'deep');
  const shallow = pooled.perSession.find((s) => s.session === 'shallow');
  assert.equal(deep.shrink, 0.8);
  assert.equal(shallow.shrink, 0.1);
  assert.equal(sessionSummary(rows, 'deep').compactions, 1);
  const line = formatPooledLine(pooled, sessionSummary(rows, "deep"));
  assert.match(line, /2 compaction\(s\) across 2 session\(s\), avg shrink 45\.0%/);
  assert.match(line, /this session: 1, avg shrink 80\.0%/);
  assert.match(formatPooledLine(pooledSummary([]), null), /no compactions recorded/);
});

test('the four layers name their gaps instead of filling them with zeros', () => {
  const lines = layerLines({
    storedTokens: 123178, surfaceNodes: 920, collapsedNodes: 4,
    billed: { hits: 0, misses: 0, hitRate: null },
    work: { compactions: 1, lossTokens: 751488, lossCostCNY: 0.676, ms: 4200, userMsgs: 12 },
  });
  assert.match(lines[0], /^L1 stored: 123178 tok on the surface \/ 920 nodes \/ 4 collapsed$/);
  assert.match(lines[1], /^L2 delivered \(billed\): 0 cached \+ 0 miss \(hit n\/a\)$/);
  assert.match(lines[2], /^L3 work: 1 compaction\(s\), ~751488 tok lost to prefix-cache misses, ≈0\.676 CNY, 4200 ms in folds, 12 user turns so far$/);
  assert.match(layerLines({ storedTokens: 1 })[1], /L2 delivered \(billed\): not recorded/, 'no cache data is not a zero-hit day');

  const empty = outcomeLines({ rows: [], sessionId: 's1', retrieval: { exists: false, path: 'x.jsonl' } });
  assert.match(empty[0], /no fold recorded for this session/);
  assert.match(empty[1], /retrieval signals: not recorded/);
  assert.ok(!/0 degenerate/.test(empty.join(' ')), 'an absent signal must not render as zero');
  assert.match(empty[2], /NOT measured/);

  const rows = [
    { ts: 1000, session: 's1' },
    { ts: 1000 + 2500, session: 's1' },
    { ts: 900, session: 'other' },
  ];
  const retrieval = {
    exists: true, skipped: 0,
    rows: [{ truncated: true }, { truncated: true }, { unknown_id: 'readimm8' }, { resolved: false }, { truncated: false, unknown_id: null }],
  };
  const withData = outcomeLines({ rows, sessionId: 's1', retrieval, now: 4000 });
  assert.match(withData[0], /gap between the last two folds 2\.5s/);
  assert.match(withData[1], /5 degenerate answer\(s\) — 2 truncated, 1 unknown_id, 1 unresolved/);
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(90000), '1.5min');
});

test('the retrieval journal is read with the same tolerance as the metrics journal', () => {
  const file = jpath('retrieval.jsonl');
  writeFileSync(file, JSON.stringify({ v: 1, tool: 'notemap_neighbors', truncated: true }) + '\n' + 'oops\n');
  const read = readRetrievalSignals({ file });
  assert.equal(read.exists, true);
  assert.equal(read.rows.length, 1);
  assert.equal(read.skipped, 1);
  assert.equal(readRetrievalSignals({ file: jpath('missing.jsonl') }).exists, false);
});

process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});