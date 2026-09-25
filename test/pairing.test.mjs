// The balance rule the core enforces, replicated for BOTH session representations so a refused fold can
// be retried downward: V3 closes a call inside a tool-result wrapper, V4 closes it with a first-class
// role:'tool' message carrying toolCallId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingEffect, balancedCutsAfter, snapEndDown } from '../lib/pairing.js';

const call = (id) => ({ data: { message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'run_code' }] } } });
const v3Result = (id) => ({ data: { message: { role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'ok' }] }] } } });
const v4Result = (id) => ({ data: { message: { role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, content: [{ type: 'text', text: 'ok' }] } } });
const text = (t) => ({ data: { message: { role: 'assistant', content: [{ type: 'text', text: t }] } } });

test('both representations close a call, so a cut is balanced in either log', () => {
  assert.deepEqual(pairingEffect(v3Result('c1')), { opens: [], closes: ['c1'] });
  assert.deepEqual(pairingEffect(v4Result('c1')), { opens: [], closes: ['c1'] });
  assert.deepEqual(pairingEffect(call('c1')), { opens: ['c1'], closes: [] });
  assert.deepEqual(pairingEffect(undefined), { opens: [], closes: [] }, 'a missing event is not a crash');
});

test('a V4 log balances exactly like a V3 one', () => {
  const nodes = [10, 11, 12, 13, 14, 15];
  const v3 = new Map([[10, text('ask')], [11, call('c1')], [12, v3Result('c1')], [13, call('c2')], [14, call('c3')], [15, v3Result('c3')]]);
  const v4 = new Map([[10, text('ask')], [11, call('c1')], [12, v4Result('c1')], [13, call('c2')], [14, call('c3')], [15, v4Result('c3')]]);
  const cuts3 = [...balancedCutsAfter(nodes, v3)].sort((a, b) => a - b);
  const cuts4 = [...balancedCutsAfter(nodes, v4)].sort((a, b) => a - b);
  assert.deepEqual(cuts3, [0, 2]);
  assert.deepEqual(cuts4, cuts3, 'the representation must not change the answer');
  assert.equal(snapEndDown({ nodes, eventBySeq: v4, startSeq: 10, endSeq: 13 }), 12, 'and the snap-down lands in the same place');
  assert.equal(snapEndDown({ nodes, eventBySeq: v4, startSeq: 13, endSeq: 15 }), null, 'nothing balanced inside 13..15 either way');
});

test('a mixed log (V3 and V4 rows) still balances', () => {
  const nodes = [1, 2, 3];
  // index 0 is a plain message (balanced), index 1 OPENS a call (unbalanced), index 2 is a V4 tool
  // message that closes it (balanced) — the representation of the close is the only variable.
  const mixed = new Map([[1, text('ask')], [2, call('x')], [3, v4Result('x')]]);
  assert.deepEqual([...balancedCutsAfter(nodes, mixed)].sort((a, b) => a - b), [0, 2]);
  const withV3Close = new Map([[1, text('ask')], [2, call('x')], [3, v3Result('x')]]);
  assert.deepEqual([...balancedCutsAfter(nodes, withV3Close)].sort((a, b) => a - b), [0, 2], 'and a V3 close gives the same cuts');
});
