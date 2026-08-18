// Unit tests for ACP threshold config: parsing + validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acpcfg-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/acp-config.js');
const { readSection, validateLimit } = mod;

test('readSection returns defaults when section absent', () => {
  const cfg = readSection('agent-default-model:\n  provider: x\n');
  assert.equal(cfg.minContextLimit, '60%');
  assert.equal(cfg.maxContextLimit, '70%');
  assert.equal(cfg.preserveRecent, 2);
  assert.equal(cfg.minTokens, 200);
  assert.equal(cfg.nudge, true);
});

test('readSection parses a present section', () => {
  const text = [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 1',
    'session-handoff:',
    '  minContextLimit: "50%"',
    '  maxContextLimit: "65%"',
    '  preserveRecent: 3',
    '  minTokens: 500',
    '  nudge: false',
    'agent-default-model:',
    '  provider: deepseek-official',
    '',
  ].join('\n');
  const cfg = readSection(text);
  assert.equal(cfg.minContextLimit, '50%');
  assert.equal(cfg.maxContextLimit, '65%');
  assert.equal(cfg.preserveRecent, 3);
  assert.equal(cfg.minTokens, 500);
  assert.equal(cfg.nudge, false);
});

test('validateLimit accepts percent and token forms, rejects bad ones', () => {
  assert.equal(validateLimit('60%', 'x'), '60%');
  assert.equal(validateLimit('600000', 'x'), '600000');
  assert.throws(() => validateLimit('0%', 'x'), /1-95/);
  assert.throws(() => validateLimit('99%', 'x'), /1-95/);
  assert.throws(() => validateLimit('500', 'x'), />= 1000/);
  assert.throws(() => validateLimit('banana', 'x'), /like "70%"/);
});

test('round-trip: set then read persists', async () => {
  writeFileSync(join(tmp, 'settings.yaml'), 'agent-default-model:\n  provider: x\n');
  const { registerAcpConfigTools } = mod;
  const tools = [];
  registerAcpConfigTools({ tools: { register: (t) => tools.push(t) } });
  const set = tools.find((t) => t.name === 'acp_set_limit');
  const out = await set.execute({ minContextLimit: '55%', maxContextLimit: '80%' }, {});
  assert.ok(out.includes('55%'));
  assert.ok(out.includes('80%'));
  const cfg = readSection(readFileSync(join(tmp, 'settings.yaml'), 'utf8'));
  assert.equal(cfg.minContextLimit, '55%');
  assert.equal(cfg.maxContextLimit, '80%');
});

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true });
});
