// The shrink deferral must depend on whether the harness pruner will actually FIRE, not on
// whether it exists.
//
// Measured on an 8-day session (12,288 tool results): the official
// @deepseek-ai/dsh-compaction-tool-result-pruner fired ZERO times because its default
// `thresholdChars: 8192` sits above p99 (12,574 chars), while 678 results exceeded OUR
// threshold (800 tokens ≈ 3200 chars) and 7.05M chars were reclaimable. The old code deferred
// unconditionally, so both mechanisms were idle and each believed the other had it.
//
// These tests pin the decision table, not the implementation:
//   pruner absent                      -> run
//   pruner present, threshold <= ours  -> defer
//   pruner present, threshold >  ours  -> run (and say why once)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');

/** Minimal ctx whose only job is to answer ctx.get('toolResultPruner'). */
function ctxWith(pruner, log = []) {
  return {
    get: (name) => (name === 'toolResultPruner' ? pruner : null),
    logger: { info: (m) => log.push(m), warn: (m) => log.push(m) },
  };
}

/** A session that records what was appended, so "did it run" is observable. */
function fakeSession() {
  const appended = [];
  return {
    id: 'test-session',
    appended,
    append: (type, data, opts) => { appended.push({ type, data, opts }); return appended.length; },
  };
}

test('the decision is exported and reads the pruner threshold, not its presence', () => {
  // The helper must exist as a named export; a test that cannot name the unit under test is
  // testing the module's mood, not its behaviour.
  assert.equal(typeof mod.shrinkDecision, 'function', 'shrinkDecision must be exported');
  assert.equal(typeof mod.__internals.shrinkSpentResults, 'function', 'shrinkSpentResults must be reachable');
});

test('no pruner -> run', () => {
  const d = mod.shrinkDecision(ctxWith(null), { shrinkMinTokens: 800 });
  assert.equal(d.run, true);
  assert.equal(d.reason, 'no-pruner');
});

test('pruner at or below our threshold -> defer', () => {
  // 3200 chars == 800 tokens * 4, the meter's own heuristic. Equal counts as "as aggressive".
  const d = mod.shrinkDecision(ctxWith({ config: { thresholdChars: 3200 } }), { shrinkMinTokens: 800 });
  assert.equal(d.run, false);
  assert.equal(d.reason, 'defer');
});

test('pruner looser than our threshold -> run, because it would never fire in the band we cover', () => {
  // This is the real rc.5 default (8192) and the exact case that produced zero prunes in 8 days.
  const d = mod.shrinkDecision(ctxWith({ config: { thresholdChars: 8192 } }), { shrinkMinTokens: 800 });
  assert.equal(d.run, true);
  assert.equal(d.reason, 'pruner-too-loose');
  assert.equal(d.theirs, 8192);
  assert.equal(d.ours, 3200);
});

test('a pruner that exposes no threshold is treated as the official default, not as "unknown"', () => {
  // Guessing "unknown -> defer" is how the original bug happened: absence of evidence read as
  // evidence of coverage.
  const d = mod.shrinkDecision(ctxWith({}), { shrinkMinTokens: 800 });
  assert.equal(d.theirs, 8192);
  assert.equal(d.run, true);
});

test('the override is logged once, not on every pre-step', () => {
  const log = [];
  const ctx = ctxWith({ config: { thresholdChars: 8192 } }, log);
  const session = fakeSession();
  const agent = { session };
  // Two calls: the note must appear exactly once.
  mod.__internals.shrinkSpentResults(ctx, agent, { shrinkMinTokens: 800, shrinkToolResults: true });
  mod.__internals.shrinkSpentResults(ctx, agent, { shrinkMinTokens: 800, shrinkToolResults: true });
  const notes = log.filter((m) => m.includes('NOT deferring'));
  assert.equal(notes.length, 1, `expected one override note, got ${notes.length}: ${JSON.stringify(log)}`);
});
