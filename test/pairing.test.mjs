// The balance rule the core enforces, replicated so a refused fold can be retried DOWNWARD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingEffect, balancedCutsAfter, snapEndDown } from '../lib/pairing.js';

const ev = (message) => ({ data: { message } });
const call = (id) => ev({ content: [{ type: 'tool-call', id, name: 'run_code' }] });
const result = (id) => ev({ content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'ok' }] }] });
const text = (t) => ev({ content: [{ type: 'text', text: t }] });

const nodes = [10, 11, 12, 13, 14, 15];
const events = new Map([
  [10, text('ask')],
  [11, call('c1')],          // opens c1 -> unbalanced after
  [12, result('c1')],        // closes c1 -> balanced after
  [13, call('c2')],          // opens c2
  [14, call('c3')],          // opens c3 as well
  [15, result('c3')],        // closes c3, c2 still open
]);

test('a cut is balanced only when no tool call is left open across it', () => {
  const cuts = balancedCutsAfter(nodes, events);
  assert.deepEqual([...cuts].sort((a, b) => a - b), [0, 2], 'index 0 (before the call) and index 2 (after its result)');
  assert.equal(cuts.has(1), false, 'the cut right after a tool call is unbalanced');
  assert.equal(cuts.has(4), false, 'closing only one of two open calls is still unbalanced');
});

test('snapEndDown takes the nearest balanced cut at or BEFORE the requested end', () => {
  // The caller asked to fold up to node 13 (which just opened c2) — the core would refuse it.
  assert.equal(snapEndDown({ nodes, eventBySeq: events, startSeq: 10, endSeq: 13 }), 12);
  // A request that is already balanced is returned unchanged.
  assert.equal(snapEndDown({ nodes, eventBySeq: events, startSeq: 10, endSeq: 12 }), 12);
  // [11..14] is refused as asked, but it still CONTAINS one balanced sub-range: fold 11..12, which
  // keeps that step's call/result pair whole — a subset of the request, never a bigger fold.
  assert.equal(snapEndDown({ nodes, eventBySeq: events, startSeq: 11, endSeq: 14 }), 12);
  // Nothing balanced inside the range at all: the caller's error stands, we do not invent a range.
  assert.equal(snapEndDown({ nodes, eventBySeq: events, startSeq: 13, endSeq: 15 }), null, 'c2 and c3 are both still open, so no cut in 13..15 is balanced');
  assert.equal(snapEndDown({ nodes, eventBySeq: events, startSeq: 14, endSeq: 15 }), null);
});

test('the effect reader understands the surface shapes it will actually meet', () => {
  assert.deepEqual(pairingEffect(call('x')), { opens: ['x'], closes: [] });
  assert.deepEqual(pairingEffect(result('y')), { opens: [], closes: ['y'] });
  assert.deepEqual(pairingEffect(ev({ content: [{ type: 'text', text: 'no tools here' }] })), { opens: [], closes: [] });
  assert.deepEqual(pairingEffect(undefined), { opens: [], closes: [] }, 'a missing event is not a crash');
});
