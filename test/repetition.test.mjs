// Degenerate repetition: the detector must fire on the live sample and NOT on real work.
//
// The positive sample is the exact text the user pasted from a stuck session on 2026-11-21. The
// negative samples are real shapes a coding agent produces every day — a repeated statement, a
// closing-tag block, a markdown rule, a base64 blob, a table. A detector that fires on those is
// worse than none, because it aborts work that was going fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectRepetition, RepetitionGuard, DEFAULTS } = await import('../lib/repetition.js');

/** The live failure, verbatim (the user pasted it twice; this is one cycle plus its repeat). */
const LIVE = `OK.

Let me write.

Let me go.

Writing.

Let me go.

OK.

Let me write.

Let me go.

Writing.

Let me go.
`;

test('the live degenerate sample is detected', () => {
  const v = detectRepetition(LIVE);
  assert.equal(v.degenerate, true, `expected degenerate, got ${JSON.stringify(v)}`);
  // The detector reports the SHAPE it found, and the live sample is caught by the line test
  // (4 distinct lines out of 10), not by a cycle count — the pasted text is only 1.98 cycles,
  // so a repeats-based assertion would be asserting the wrong mechanism.
  assert.ok(v.distinctRatio <= DEFAULTS.maxDistinctRatio,
    `distinctRatio ${v.distinctRatio} above ${DEFAULTS.maxDistinctRatio}`);
  assert.ok(v.meanLineChars <= DEFAULTS.maxMeanLineChars,
    `meanLineChars ${v.meanLineChars} above ${DEFAULTS.maxMeanLineChars}`);
});

test('a longer run of the same stutter is still detected', () => {
  const v = detectRepetition(LIVE.repeat(4));
  assert.equal(v.degenerate, true);
  // More repeats of the same four lines means a LOWER distinct ratio, not a higher one.
  assert.ok(v.distinctRatio < 0.2, `expected a low distinct ratio, got ${v.distinctRatio}`);
});

// --- negatives: real work must never be aborted ------------------------------------------------

test('a repeated statement in real code is NOT degenerate', () => {
  const code = [
    'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;',
    'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;',
    'function total() {', '  return a + b + c + d + e + f + g + h;', '}',
    'export { total };',
  ].join('\n');
  const v = detectRepetition(code);
  assert.equal(v.degenerate, false, `false positive on code: ${JSON.stringify(v)}`);
});

test('a block of identical closing tags is NOT degenerate', () => {
  const html = '<div>\n'.repeat(30) + 'content here\n' + '</div>\n'.repeat(30);
  const v = detectRepetition(html);
  assert.equal(v.degenerate, false, `false positive on markup: ${JSON.stringify(v)}`);
});

test('a markdown rule and a separator table are NOT degenerate', () => {
  const md = '# Title\n\n' + '-'.repeat(80) + '\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n'
    + 'Some prose that explains what the table means and why it is here.\n';
  const v = detectRepetition(md);
  assert.equal(v.degenerate, false, `false positive on markdown: ${JSON.stringify(v)}`);
});

test('a base64 blob is NOT degenerate', () => {
  // Deterministic pseudo-random base64: high entropy, no short cycle.
  let s = '';
  let x = 12345;
  for (let i = 0; i < 600; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[x % 64];
  }
  const v = detectRepetition(s);
  assert.equal(v.degenerate, false, `false positive on base64: ${JSON.stringify(v)}`);
});

test('a long answer that quotes the stutter ONCE is NOT degenerate', () => {
  // The phrase appears, but it is not the answer — coverage must stay below the bar.
  const answer = 'Here is what I found. OK. Let me write. Let me go. Writing. Let me go.\n\n'
    + 'The actual finding is that the compaction threshold was read from the wrong section, '
    + 'so the soft limit never fired and the session grew until the provider rejected it. '
    + 'The fix is to read the section the plugin actually writes, and to assert the round trip '
    + 'in a test so the two cannot drift apart again without something going red.';
  const v = detectRepetition(answer);
  assert.equal(v.degenerate, false, `false positive on a quoted phrase: ${JSON.stringify(v)}`);
});

test('short output is never judged', () => {
  const v = detectRepetition('OK. Let me go.');
  assert.equal(v.degenerate, false);
  assert.equal(v.reason, 'too-short');
});

// --- the streaming wrapper --------------------------------------------------------------------

test('the guard fires mid-stream, not only at the end', () => {
  // The line-based test needs `minLines` content lines before it can judge, so the guard cannot
  // fire on the first delta — that is correct, not a bug. What matters is that it fires BEFORE
  // the stream ends, i.e. while there is still text left to suppress.
  //
  // Measured trace (probe-guard.mjs): checks at 20/40/60/80/100 chars, fires at 100 of 107. The
  // first version asserted `at < LIVE.length - 20`, which demanded firing by char 87 — earlier
  // than the detector can possibly have 6 content lines. The assertion was wrong, not the guard.
  const g = new RepetitionGuard({ checkEveryChars: 20 });
  let fired = null;
  for (let i = 0; i < LIVE.length; i += 10) {
    const v = g.push(LIVE.slice(i, i + 10));
    if (v.degenerate) { fired = { at: i, v }; break; }
  }
  assert.ok(fired, `the guard never fired while streaming the degenerate sample (saw ${g.output.length} chars)`);
  assert.ok(fired.at > 0, 'fired on the very first delta — it cannot have had enough lines to judge');
  assert.ok(fired.at < LIVE.length, `fired only after the stream ended (${fired.at}/${LIVE.length})`);
});

test('the guard does not fire while streaming real code', () => {
  const g = new RepetitionGuard({ checkEveryChars: 40 });
  const code = 'export function add(a, b) {\n  return a + b;\n}\n\n'
    + 'export function sub(a, b) {\n  return a - b;\n}\n\n'
    + 'export function mul(a, b) {\n  return a * b;\n}\n';
  for (let i = 0; i < code.length; i += 10) {
    const v = g.push(code.slice(i, i + 10));
    assert.equal(v.degenerate, false, `fired on real code at ${i}: ${JSON.stringify(v)}`);
  }
});
