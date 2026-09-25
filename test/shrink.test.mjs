// The deterministic shrink, in BOTH session representations: V3's tool-result wrapper and V4's
// first-class tool message (dsh-session-format-v3-to-v4). Reading only one of them fails silently on
// the other — no error, the pass simply never matches a result — so both are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutText, isShrunkContent, partsText, hasNonTextParts, shrinkTargets, shrunkenContent, toolResultOf, withResultParts,
} from '../lib/shrink.js';

/** V3: role 'user', one tool-result wrapper holding the parts. */
const v3Message = (text, extra = {}) => ({
  id: 'm', role: 'user', source: { kind: 'tool', callId: 'call_1' },
  content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'run_code', content: [{ type: 'text', text }], ...extra }],
});
/** V4: role 'tool', toolCallId lifted, parts are the message content. */
const v4Message = (text, extra = {}) => ({
  id: 'm', role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1',
  'plugin:result:toolName': 'run_code', content: [{ type: 'text', text }], ...extra,
});
const event = (message) => ({ data: { message } });
const nodeAt = (seq, tokens, type = 'tool/result') => ({ seq, type, tokens });
const eventsFor = (map) => new Map(Object.entries(map).map(([seq, message]) => [Number(seq), event(message)]));

test('toolResultOf reads BOTH representations into one shape', () => {
  const v3 = toolResultOf(v3Message('hello'));
  const v4 = toolResultOf(v4Message('hello'));
  for (const r of [v3, v4]) {
    assert.equal(r.toolCallId, 'call_1');
    assert.equal(r.toolName, 'run_code');
    assert.equal(partsText(r.parts), 'hello');
    assert.equal(r.isError, false);
  }
  assert.equal(v3.shape, 'v3');
  assert.equal(v4.shape, 'v4');
  assert.equal(toolResultOf({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), null, 'an assistant message is not a tool result');
  assert.equal(toolResultOf(undefined), null);
});

test('withResultParts re-emits the shape it read', () => {
  const parts = [{ type: 'text', text: 'short' }];
  const v3 = withResultParts(toolResultOf(v3Message('long')), parts);
  assert.equal(v3.content.length, 1, 'V3 keeps the wrapper');
  assert.equal(v3.content[0].type, 'tool-result');
  assert.deepEqual(v3.content[0].content, parts);
  assert.equal(v3.content[0].toolCallId, 'call_1', 'the wrapper keeps its call id');
  const v4 = withResultParts(toolResultOf(v4Message('long')), parts);
  assert.deepEqual(v4.content, parts, 'V4 carries the parts directly');
  assert.equal(v4.toolCallId, 'call_1', 'and keeps the lifted call id');
  assert.equal(v4.role, 'tool');
});

test('cutText keeps head and tail and counts what it drops', () => {
  const cut = cutText('a'.repeat(5000), { headChars: 1000, tailChars: 200 });
  assert.equal(cut.head.length, 1000);
  assert.equal(cut.tail.length, 200);
  assert.equal(cut.elided, 3800);
  const small = cutText('short', { headChars: 1000, tailChars: 200 });
  assert.equal(small.elided, 0);
  assert.equal(small.tail, '');
});

test('shrunkenContent refuses when there is nothing worth dropping, and always names where the original is', () => {
  assert.equal(shrunkenContent([{ type: 'text', text: 'tiny' }], { seq: 7, headChars: 100, tailChars: 20 }), null);
  const out = shrunkenContent([{ type: 'text', text: 'b'.repeat(9000) }], { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
  assert.equal(out.length, 1);
  assert.match(out[0].text, /…\[shrunk run_code · \d+ of 9000 chars elided — original in the session log, seq 7\]/);
  assert.ok(out[0].text.startsWith('b'.repeat(100)));
  assert.ok(out[0].text.endsWith('b'.repeat(20)));
  assert.ok(isShrunkContent(out), 'the marker is what makes a later pass skip it');
});

test('shrinkTargets handles a surface holding BOTH representations, newest first, with every guard', () => {
  const big = 'c'.repeat(9000);
  const nodes = [nodeAt(1, 4000), nodeAt(2, 100), nodeAt(3, 5000), nodeAt(4, 9000), nodeAt(5, 9000), nodeAt(6, 9000)];
  const events = eventsFor({
    1: v3Message(big),
    2: v4Message('small'),
    3: v4Message(big, { content: [{ type: 'image', attachment: 'x' }] }),
    4: v4Message('…[shrunk run_code · 8000 of 9000 chars elided — original in the session log, seq 4]'),
    5: v4Message(big),
    6: v3Message(big),
  });
  const targets = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 2 });
  assert.deepEqual(targets.map((t) => t.seq), [1], 'the live tail is never touched');
  assert.equal(targets[0].shape, 'v3');
  const wider = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1 });
  assert.deepEqual(wider.map((t) => t.seq), [5, 1], 'NEWEST first, across both shapes');
  assert.equal(wider[0].shape, 'v4');
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, limit: 1 }).map((t) => t.seq), [5]);
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, windowNodes: 1 }).map((t) => t.seq), [5]);
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, windowNodes: 5 }).map((t) => t.seq), [5, 1]);
});

test('a replacement is one node, same type, and differs from the original ONLY in content — both shapes', () => {
  for (const message of [v3Message('d'.repeat(9000)), v4Message('d'.repeat(9000))]) {
    const result = toolResultOf(message);
    const parts = shrunkenContent(result.parts, { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
    const replacement = withResultParts(result, parts);
    assert.equal(replacement.id, message.id);
    assert.deepEqual(replacement.source, message.source);
    assert.equal(replacement.role, message.role, 'the role is preserved per shape');
    assert.notDeepEqual(replacement.content, message.content, 'only the content changed');
  }
});

test('the guards read the parts, not their label', () => {
  assert.equal(partsText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(hasNonTextParts([{ type: 'text', text: 'a' }]), false);
  assert.equal(hasNonTextParts([{ type: 'text', text: 'a' }, { type: 'image', attachment: 'x' }]), true, 'an image is never silently dropped');
  assert.equal(isShrunkContent([{ type: 'text', text: 'plain' }]), false);
});
