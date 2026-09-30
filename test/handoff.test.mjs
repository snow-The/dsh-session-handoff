// Unit tests for handoff document generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../lib/index.js';

const { renderHandoffDoc } = __internals;

function makeAgent() {
  return {
    session: {
      id: 'session-test-9',
      header: { cwd: 'C:/workspace' },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    },
  };
}

const events = [
  { seq: 1, type: 'turn/start' },
  { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Ship the backend' }] } } },
  { seq: 3, type: 'tool/call', data: { name: 'write_file' } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
];

test('handoff document contains required sections', () => {
  const doc = renderHandoffDoc({}, makeAgent(), events);
  for (const section of ['# Session Handoff', '## Overview', '## Recent user objectives', '## Agent guidance']) {
    assert.ok(doc.includes(section), `missing section: ${section}`);
  }
});

test('handoff document embeds session metadata', () => {
  const doc = renderHandoffDoc({}, makeAgent(), events);
  assert.ok(doc.includes('session-test-9'));
  assert.ok(doc.includes('C:/workspace'));
  assert.ok(doc.includes('deepseek-official'));
});

test('handoff document includes the handoff package when provided', () => {
  const agent = makeAgent();
  const doc = renderHandoffDoc({}, agent, events, {
    enhancers: ['openviking', 'archify'],
    handoffPackage: '### OpenViking archive\n\n```\nviking_remember ...\n```\n',
  });
  assert.ok(doc.includes('## Handoff package'));
  assert.ok(doc.includes('viking_remember'));
  assert.ok(doc.includes('OpenViking archive'));
});

// The bug this locks out: the section was labelled "Recent user objectives" but was filled by
// `if (recentUser.length < 5)`, i.e. the FIRST five human messages of the session. A handoff
// written after a long session therefore described what the work was at the START and said nothing
// about where it had got to — the one thing a handoff exists to carry.
test('the objective is the first human message and the recent list is the LAST five', () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => ([
    { seq: n * 2, type: 'turn/start' },
    { seq: n * 2 + 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: `ask ${n}` }] } } },
  ]));
  const doc = renderHandoffDoc({}, makeAgent(), many);
  assert.ok(doc.includes('## Session objective (first human message)'));
  assert.ok(doc.includes('- ask 1'), 'the first message is the objective');
  for (const n of [4, 5, 6, 7, 8]) assert.ok(doc.includes(`- ask ${n}`), `recent must contain ask ${n}`);
  assert.ok(!doc.includes('- ask 3'), 'the middle of the session is not "recent"');
  assert.ok(doc.includes('## Recent user objectives (last 5)'));
});

test('the document records the ACP budget it was written under', () => {
  const doc = renderHandoffDoc({}, makeAgent(), events, {
    acp: { minContextLimit: 400000, maxContextLimit: 400000, preserveRecent: 2, compressTargetRatio: 0.2 },
  });
  assert.ok(doc.includes('## Context budget (ACP)'));
  assert.ok(doc.includes('soft limit (minContextLimit): 400000'));
  assert.ok(doc.includes('deep-fold target (compressTargetRatio): 0.2'));
  assert.ok(doc.includes('OVERWRITTEN on the next export'), 'the reader must know this file is machine-owned');
});

// exportHandoffForAgent writes the whole file on every export. Without carry-over, the notes block
// is the first thing destroyed -- and it is the only part a human authored.
test('notes inside the marked block survive a re-export', () => {
  const { extractCarriedNotes } = __internals;
  const first = renderHandoffDoc({}, makeAgent(), events);
  assert.equal(extractCarriedNotes(first), '', 'an unedited placeholder is not carried content');
  const edited = first.replace(
    '(write durable notes for the next session here; this block is carried over on re-export)',
    'THE TOKEN LIVES IN .env.local\nDo not rerun the migration.',
  );
  const carried = extractCarriedNotes(edited);
  assert.match(carried, /THE TOKEN LIVES IN \.env\.local/);
  const second = renderHandoffDoc({}, makeAgent(), events, { carriedNotes: carried });
  assert.match(second, /THE TOKEN LIVES IN \.env\.local/);
  assert.match(second, /Do not rerun the migration\./);
  assert.equal(extractCarriedNotes(second), carried, 'round trip: the carried block is stable');
});

test('a truncated or marker-less document carries nothing instead of guessing', () => {
  const { extractCarriedNotes } = __internals;
  assert.equal(extractCarriedNotes('<!-- dsh-handoff:notes -->\nno closing marker\n'), '');
  assert.equal(extractCarriedNotes('a document with no markers at all'), '');
  assert.equal(extractCarriedNotes(undefined), '');
});
