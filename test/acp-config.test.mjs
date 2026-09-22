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

// Both fuse keys lived in resolveConfig but NOT in DEFAULTS, and readSection reads only the keys it
// finds in DEFAULTS — so settings.yaml could not move the fuse at all: the host trigger stayed pinned
// to 'hard', and between the soft trigger and the ceiling the MODEL was the only thing that could
// compact. That gap is exactly where agents stalled and asked the user to authorize compaction.
test('the host-fold fuse is configurable, and an unreadable value lands on the ceiling', () => {
  const cfg = readSection(['session-handoff:', '  hostTrigger: false', '  hostTriggerAt: soft', ''].join('\n'));
  assert.equal(cfg.hostTrigger, false, 'the host trigger can be turned off');
  assert.equal(cfg.hostTriggerAt, 'soft', 'and moved to the soft trigger');
  assert.equal(readSection('session-handoff:\n  hostTriggerAt: whenever\n').hostTriggerAt, 'hard', 'only two positions exist; anything else means the ceiling');
  assert.equal(readSection('').hostTriggerAt, 'hard');
  assert.equal(readSection('').hostTrigger, true);
});

test('writing the config never drops a key it read, and the fold target stays a fraction', async () => {
  writeFileSync(join(tmp, 'settings.yaml'), ['session-handoff:', '  minContextLimit: "70%"', '  compressTargetRatio: 0.5', ''].join('\n'));
  const tools = [];
  mod.registerAcpConfigTools({ tools: { register: (t) => tools.push(t) } });
  const set = tools.find((t) => t.name === 'acp_set_limit');
  await set.execute({ maxContextLimit: '85%' }, {});
  let text = readFileSync(join(tmp, 'settings.yaml'), 'utf8');
  assert.ok(text.includes('compressTargetRatio: 0.5'), 'the deep-fold target survived the rewrite:\n' + text);
  assert.equal(readSection(text).compressTargetRatio, 0.5, 'and it reads back as a NUMBER, not a string');
  assert.equal(readSection(text).maxContextLimit, '85%');
  await set.execute({ hostTriggerAt: 'soft' }, {});
  text = readFileSync(join(tmp, 'settings.yaml'), 'utf8');
  assert.equal(readSection(text).hostTriggerAt, 'soft', 'the fuse round-trips through settings.yaml');
  await assert.rejects(() => set.execute({ hostTriggerAt: 'sometimes' }, {}), /must be "soft" or "hard"/);
  assert.equal(readSection('session-handoff:\n  compressTargetRatio: banana\n').compressTargetRatio, 0.35, 'an unusable fraction falls back to the default');
});

// The inconsistency this test exists for: the UI slider capped at 90 while the TOOL accepted up to
// 95, so settings.yaml (88/95) described a configuration the panel could not even display. The more
// permissive writer won. One ceiling, checked from both ends.
test('the fuse ceiling is one number: the tool refuses what the UI cannot display', async () => {
  assert.equal(mod.FUSE_CEILING_PCT, 90);
  const ui = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('max: 90,'), 'the UI slider must still cap at the same number');
  assert.ok(ui.includes('Math.min(90,'), 'and clamp a stored value to it');
  assert.throws(() => validateLimit('95%', 'maxContextLimit'), /must be 1-90/, 'the fuse may not exceed the ceiling');
  assert.equal(validateLimit('90%', 'maxContextLimit'), '90%', 'the ceiling itself is allowed');
  assert.equal(validateLimit('95%', 'minContextLimit'), '95%', 'the advisory threshold has no burst-margin constraint');
  const tools = [];
  mod.registerAcpConfigTools({ tools: { register: (t) => tools.push(t) } });
  const set = tools.find((t) => t.name === 'acp_set_limit');
  await assert.rejects(() => set.execute({ maxContextLimit: '95%' }, {}), /must be 1-90/);
});

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true });
});
