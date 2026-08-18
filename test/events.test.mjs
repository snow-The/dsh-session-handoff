// Unit tests for session-handoff internals: event summarization & text extraction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../lib/index.js';

const { summarizeEvents, eventText } = __internals;

const events = [
  { seq: 1, type: 'turn/start' },
  { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Objective one' }] } } },
  { seq: 3, type: 'tool/call', data: { name: 'write_file', arguments: { file: 'a.zig' } } },
  { seq: 4, type: 'tool/result', data: { text: 'ok' } },
  { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
  { seq: 6, type: 'compaction/summary', data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], summary: [{ type: 'text', text: 'Early work' }] } },
  { seq: 7, type: 'turn/end' },
];

test('summarizeEvents counts each category from real events', () => {
  const { stats } = summarizeEvents(events);
  assert.equal(stats.turns, 1);
  assert.equal(stats.userMsgs, 1);
  assert.equal(stats.assistantMsgs, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolResults, 1);
  assert.equal(stats.checkpoints, 1);
});

test('summarizeEvents captures recent user objectives', () => {
  const { recentUser } = summarizeEvents(events);
  assert.ok(recentUser.some((u) => u.includes('Objective one')));
});

test('summarizeEvents captures checkpoint summary text', () => {
  const { checkpoints } = summarizeEvents(events);
  assert.ok(checkpoints.some((c) => c.includes('Early work')));
});

test('eventText extracts structured message content', () => {
  const e = { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } } };
  assert.equal(eventText(e), 'a\nb');
});

test('eventText handles tool calls and plain strings', () => {
  const tc = { type: 'tool/call', data: { name: 'write_file', arguments: { file: 'x' } } };
  assert.ok(eventText(tc).includes('write_file'));
  const plain = { type: 'assistant/message', data: { message: { content: 'hi' } } };
  assert.equal(eventText(plain), 'hi');
});
