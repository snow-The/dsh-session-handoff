// The host-triggered fold must honour compressTargetRatio.
//
// THE BUG: hostTriggeredFold called runCompaction({ deep: false }), and runCompaction gates the
// deep-fold extension on `opts.deep !== false` (lib/index.js:1244). So deepFoldStart never ran,
// compressTargetRatio never applied, and every fold landed wherever the caller's range happened to
// end. Measured over 28 folds in an 8-day session: fired at 59.9%, landed at 19.1%, while the
// configured target said 0.35.
//
// These tests pin the DECISION (does the host path ask for a deep fold?) and the ARITHMETIC
// (does deepFoldStart land near the target?). A test that only greps for `deep: true` would pass
// on a comment, so the second half drives the real function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mod = await import('../lib/index.js');
const { deepFoldStart } = mod;

/** A surface of `n` nodes, each priced `tokens`, with a meter that reports them. */
function fakeSurface(n, tokens) {
  const nodes = Array.from({ length: n }, (_, i) => i + 1);   // seqs 1..n
  const session = { surface: { nodes } };
  const meter = {
    measure: () => ({
      totalTokens: n * tokens,
      nodes: nodes.map((seq) => ({ seq, tokens })),
    }),
  };
  return { session, meter, nodes };
}

test('deepFoldStart reaches back far enough to land near the target', () => {
  // 100 nodes × 10k tokens = 1M total, window 1M. Target 0.35 means the surface should end up
  // near 350k, i.e. the fold must swallow ~650k = 65 nodes.
  const { session, meter, nodes } = fakeSurface(100, 10_000);
  const start = nodes[50];   // the caller's range starts halfway
  const end = nodes[99];
  const chosen = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, start, end, 1_000_000);
  const idx = nodes.indexOf(chosen);
  assert.ok(idx < nodes.indexOf(start), `expected the fold to reach back past ${start}, got ${chosen}`);
  // After folding nodes[idx..99], what survives is nodes[0..idx-1].
  const surviving = idx * 10_000;
  const target = 0.35 * 1_000_000;
  assert.ok(Math.abs(surviving - target) <= 10_000 * 2,
    `expected to land near ${target}, got ${surviving} (chosen index ${idx})`);
});

test('a higher target folds LESS, a lower target folds MORE', () => {
  const { session, meter, nodes } = fakeSurface(100, 10_000);
  const shallow = deepFoldStart(meter, session, { compressTargetRatio: 0.60 }, nodes[50], nodes[99], 1_000_000);
  const deep = deepFoldStart(meter, session, { compressTargetRatio: 0.20 }, nodes[50], nodes[99], 1_000_000);
  // A shallower target (0.60) leaves more, so it must start LATER in the surface.
  assert.ok(nodes.indexOf(shallow) > nodes.indexOf(deep),
    `0.60 should fold less than 0.20: shallow starts at ${shallow}, deep at ${deep}`);
});

test('the host fold path asks for a deep fold', () => {
  // The decision, not the arithmetic: read the source and require `deep: true` on the
  // host-trigger call. This is the assertion that would have caught the original bug.
  const text = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const hostCall = /runCompaction\(agent, \{ \.\.\.range, deep: (\w+), summary: null, topic: 'host-trigger' \}\)/.exec(text);
  assert.ok(hostCall, 'the host-trigger runCompaction call must be findable');
  assert.equal(hostCall[1], 'true', 'the host fold must pass deep: true, or compressTargetRatio never applies');
  const modCall = /runCompaction\(agent, \{ \.\.\.range, deep: (\w+), summary: null, topic: 'moderation-reset' \}\)/.exec(text);
  assert.ok(modCall, 'the moderation-reset runCompaction call must be findable');
  assert.equal(modCall[1], 'true', 'a moderation reset is a fold like any other');
});

test('compressTargetRatio defaults to 0.35 and is a fraction', () => {
  // The value the operator chose. If someone changes the default, this test says so out loud
  // instead of letting the fold depth drift silently.
  const schema = mod.Config({});
  assert.equal(schema.compressTargetRatio, 0.35);
});
