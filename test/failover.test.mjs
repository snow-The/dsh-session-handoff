// Unit tests for provider failover: candidate selection + settings persistence.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'failover-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/failover.js');
const { pickNextProvider, readFailoverRoutes, writeFailoverRoutes, FAILOVER_CODES } = mod;

test('FAILOVER_CODES covers quota, rate, server, transport, credential, adapter', () => {
  for (const code of ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'AUTH', 'INVALID_CREDENTIAL', 'NO_ADAPTER']) {
    assert.ok(FAILOVER_CODES.includes(code), code);
  }
  // context overflow and unknown are NOT failed over
  assert.ok(!FAILOVER_CODES.includes('CONTEXT_WINDOW_EXCEEDED'));
  assert.ok(!FAILOVER_CODES.includes('UNKNOWN'));
});

test('pickNextProvider returns the first untried route', () => {
  assert.equal(pickNextProvider(['a', 'b', 'c'], new Set(['a'])), 'b');
  assert.equal(pickNextProvider(['a', 'b'], new Set()), 'a');
  assert.equal(pickNextProvider(['a'], new Set(['a'])), null);
  assert.equal(pickNextProvider([], new Set()), null);
});

test('pickNextProvider skips every tried route in order', () => {
  assert.equal(pickNextProvider(['a', 'b', 'c'], new Set(['c', 'a'])), 'b');
  assert.equal(pickNextProvider(['a', 'b', 'c'], new Set(['a', 'b', 'c'])), null);
});

test('writeFailoverRoutes persists an ordered list and readFailoverRoutes round-trips', async () => {
  const written = await writeFailoverRoutes(['deepseek-official', 'deepseek', 'vision-toolkit-deepseek-official']);
  assert.deepEqual(written, ['deepseek-official', 'deepseek', 'vision-toolkit-deepseek-official']);
  const read = await readFailoverRoutes();
  assert.deepEqual(read, ['deepseek-official', 'deepseek', 'vision-toolkit-deepseek-official']);
});

test('writeFailoverRoutes merges into an existing settings.yaml section', async () => {
  writeFileSync(join(tmp, 'settings.yaml'), [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 1',
    'session-handoff:',
    '  minContextLimit: "60%"',
    '  maxContextLimit: "70%"',
    'agent-default-model:',
    '  provider: deepseek-official',
    '',
  ].join('\n'));
  await writeFailoverRoutes(['deepseek', 'deepseek-official']);
  const text = readFileSync(join(tmp, 'settings.yaml'), 'utf8');
  assert.match(text, /failoverRoutes: deepseek,deepseek-official/);
  assert.match(text, /minContextLimit: "60%"/); // sibling key untouched
  assert.deepEqual(await readFailoverRoutes(), ['deepseek', 'deepseek-official']);
});

test('empty list disables failover and removes the line', async () => {
  await writeFailoverRoutes([]);
  assert.deepEqual(await readFailoverRoutes(), []);
  const text = readFileSync(join(tmp, 'settings.yaml'), 'utf8');
  assert.ok(!text.includes('failoverRoutes'));
});

test('readFailoverRoutes returns [] when the section is absent', async () => {
  writeFileSync(join(tmp, 'settings.yaml'), 'agent-default-model:\n  provider: x\n');
  assert.deepEqual(await readFailoverRoutes(), []);
});

after(() => rmSync(tmp, { recursive: true, force: true }));
