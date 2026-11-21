// Known-stutter detection: fire on the measured deepseek-v4.1-flash format, never on real work.
//
// The positive sample is the exact text the user pasted from a stuck session on 2026-11-21.
// The negatives are real shapes a coding agent produces every day. The guarantee this file pins
// is narrow on purpose: the detector fires only when EVERY non-empty line is a known filler
// phrase, so a single line of real content is enough to keep the stream alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectRepetition, RepetitionGuard, KNOWN_STUTTERS, DEFAULTS } = await import('../lib/repetition.js');

/** The live failure, verbatim. */
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
  assert.equal(v.lines, 10);
  assert.equal(v.matched, 10, 'every line must be a known phrase');
});

test('a longer run of the same stutter is still detected', () => {
  const v = detectRepetition(LIVE.repeat(4));
  assert.equal(v.degenerate, true);
  assert.equal(v.lines, 40);
});

test('the phrase set is data, so a new model version is a new entry, not a new algorithm', () => {
  assert.deepEqual(KNOWN_STUTTERS['deepseek-v4.1-flash'], ['OK.', 'Let me write.', 'Let me go.', 'Writing.']);
  // A model whose set is not registered is NOT judged — the detector says so instead of guessing.
  const v = detectRepetition(LIVE, { model: 'some-future-model' });
  assert.equal(v.degenerate, false);
  assert.match(v.reason, /no known phrase set/);
});

test('an unregistered model can be covered by passing its phrases', () => {
  const v = detectRepetition('Hmm.\n\nLet me think.\n\nHmm.\n\nLet me think.\n', {
    model: 'some-future-model',
    phrases: ['Hmm.', 'Let me think.'],
  });
  assert.equal(v.degenerate, true);
});

// --- negatives: real work must never be aborted ------------------------------------------------

test('ONE line of real content is enough to keep the stream alive', () => {
  // This is the whole safety property: the detector requires EVERY line to be a known phrase.
  const mixed = LIVE + '\nThe compaction threshold was read from the wrong section.\n';
  const v = detectRepetition(mixed);
  assert.equal(v.degenerate, false, `false positive when real content is present: ${JSON.stringify(v)}`);
});

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
  let s = '';
  let x = 12345;
  for (let i = 0; i < 600; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[x % 64];
  }
  const v = detectRepetition(s);
  assert.equal(v.degenerate, false, `false positive on base64: ${JSON.stringify(v)}`);
});

test('a long answer that QUOTES the stutter is NOT degenerate', () => {
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
  assert.equal(v.reason, 'too-few-lines');
});

// --- the streaming wrapper --------------------------------------------------------------------

test('the guard fires mid-stream, not only at the end', () => {
  // The detector needs `minLines` (4) before it can judge, so it cannot fire on the first delta —
  // that is correct. What matters is that it fires BEFORE the stream ends, while there is still
  // text left to suppress.
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
