// The deterministic shrink: pure decisions, plus the one shape the session contract allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutText, isShrunkContent, resultText, hasNonTextParts, shrinkTargets, shrunkenContent } from '../lib/shrink.js';

const block = (text, extra = {}) => ({ type: 'tool-result', toolCallId: 'call_1', toolName: 'run_code', content: [{ type: 'text', text }], ...extra });
const nodeAt = (seq, tokens, type = 'tool/result') => ({ seq, type, tokens });
const eventsFor = (map) => new Map(Object.entries(map).map(([seq, b]) => [Number(seq), { data: { message: { id: 'm' + seq, role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [b] } } }]));

test('cutText keeps head and tail and counts what it drops', () => {
  const t = 'a'.repeat(5000);
  const cut = cutText(t, { headChars: 1000, tailChars: 200 });
  assert.equal(cut.head.length, 1000);
  assert.equal(cut.tail.length, 200);
  assert.equal(cut.elided, 3800);
  assert.equal(cut.total, 5000);
  const small = cutText('short', { headChars: 1000, tailChars: 200 });
  assert.equal(small.elided, 0, 'a text shorter than the budget is left alone');
  assert.equal(small.head, 'short');
  assert.equal(small.tail, '');
});

test('shrunkenContent refuses when there is nothing worth dropping, and always names where the original is', () => {
  assert.equal(shrunkenContent(block('tiny'), { seq: 7, headChars: 100, tailChars: 20 }), null);
  const out = shrunkenContent(block('b'.repeat(9000)), { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
  assert.equal(out.length, 1);
  const text = out[0].text;
  assert.match(text, /…\[shrunk run_code · \d+ of 9000 chars elided — original in the session log, seq 7\]/);
  assert.ok(text.startsWith('b'.repeat(100)), 'the head is kept verbatim');
  assert.ok(text.endsWith('b'.repeat(20)), 'and the tail');
  assert.ok(isShrunkContent(out), 'the marker is what makes a later pass skip it');
});

test('shrinkTargets skips the live tail, small results, images and already-shrunk results', () => {
  const big = 'c'.repeat(9000);
  const nodes = [nodeAt(1, 4000), nodeAt(2, 100), nodeAt(3, 5000), nodeAt(4, 9000), nodeAt(5, 9000), nodeAt(6, 9000)];
  const events = eventsFor({
    1: block(big),
    2: block('small'),
    3: block(big, { content: [{ type: 'image', attachment: 'x' }] }),
    4: shrunkenContent(block(big), { seq: 4, headChars: 50, tailChars: 10 })[0] ? block('c'.repeat(9000)) : block(big),
    5: block(big),
    6: block(big),
  });
  // node 4 is marked as already shrunk by giving it the marker text directly
  events.get(4).data.message.content[0].content = [{ type: 'text', text: '…[shrunk run_code · 8000 of 9000 chars elided — original in the session log, seq 4]' }];
  // protectedTail 2 with 6 nodes protects indices 4 and 5, so only node 1 survives every guard:
  // 2 is too small, 3 holds an image, 4 already carries the marker.
  const targets = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 2 });
  assert.deepEqual(targets.map((t) => t.seq), [1], 'the live tail is never touched');
  assert.equal(targets[0].toolName, 'run_code');
  // Move the guard and the same surface yields one more: the protection is the boundary, not a guess.
  const wider = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1 });
  assert.deepEqual(wider.map((t) => t.seq), [1, 5]);
  // And a limit is honoured in surface order — oldest first, which is what has been read longest ago.
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, limit: 1 }).map((t) => t.seq), [1]);
});

test('a replacement is one node, same type, and differs from the original ONLY in content', () => {
  // This is the contract the harness enforces (assertToolResultRewrite). Verified against the real
  // Session class: the append is accepted, the surface goes [0,1] -> [0,2], and changing the message
  // id instead is refused with "may change only content".
  const original = { id: 'm7', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [block('d'.repeat(9000))] };
  const content = shrunkenContent(original.content[0], { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
  const replacement = { ...original, content: [{ ...original.content[0], content }] };
  assert.equal(replacement.id, original.id);
  assert.deepEqual(replacement.source, original.source);
  assert.equal(replacement.content.length, 1);
  assert.equal(replacement.content[0].toolCallId, original.content[0].toolCallId);
  assert.equal(replacement.content[0].type, original.content[0].type);
  assert.notDeepEqual(replacement.content[0].content, original.content[0].content);
});

test('the guards read the block, not its label', () => {
  assert.equal(resultText(block('abc')), 'abc');
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(hasNonTextParts(block('abc')), false);
  assert.equal(hasNonTextParts({ content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: 'x' }] }), true, 'an image is never silently dropped');
  assert.equal(isShrunkContent([{ type: 'text', text: 'plain' }]), false);
});
