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
