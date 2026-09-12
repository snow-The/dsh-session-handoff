// Unit tests for session-mgmt internals: id validation + trash entry storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point DSH_HOME at a temp dir so trash paths are isolated.
const tmp = mkdtempSync(join(tmpdir(), 'smgmt-test-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/session-mgmt.js');
const { TRASH_LIMIT } = mod;

test('TRASH_LIMIT is 10', () => {
  assert.equal(TRASH_LIMIT, 10);
});

test('validateId accepts official session id shapes', async () => {
  const { registerSessionMgmtTools } = mod;
  // validateId is internal; exercise via the tools' error path.
  const tools = [];
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    sessionPersistence: { list: async () => [], locate: () => undefined },
    workspaceRegistry: {},
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerSessionMgmtTools(ctx);
  const trash = tools.find((t) => t.name === 'session_trash');
  // valid uuid-ish id: should proceed (no artifact, entry recorded)
  const out = await trash.execute({ sessionId: 'session-abc123' }, {});
  assert.ok(out.includes('Trashed session-abc123'));
  // invalid id: rejected
  await assert.rejects(() => trash.execute({ sessionId: '../evil' }, {}), /invalid session id/);
  await assert.rejects(() => trash.execute({ sessionId: 'a b' }, {}), /invalid session id/);
});

test('trash entries persist and honor the limit', async () => {
  const { registerSessionMgmtTools } = mod;
  const tools = [];
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    sessionPersistence: { list: async () => [], locate: () => undefined },
    workspaceRegistry: {},
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerSessionMgmtTools(ctx);
  const trash = tools.find((t) => t.name === 'session_trash');
  // trash more than the limit
  for (let i = 0; i < TRASH_LIMIT + 3; i += 1) {
    await trash.execute({ sessionId: `session-aaaa${i}` }, {});
  }
  const list = tools.find((t) => t.name === 'session_list');
  const out = await list.execute({ includeTrash: true }, {});
  // only the newest TRASH_LIMIT survive
  const lines = out.split('\n').filter((l) => l.includes('session-aaaa'));
  assert.ok(lines.length <= TRASH_LIMIT, `expected <= ${TRASH_LIMIT} entries, got ${lines.length}`);
  // the oldest was purged
  assert.ok(!out.includes('session-aaaa0'), 'oldest entry should have been purged');
});

test('session_purge removes the entry', async () => {
  const { registerSessionMgmtTools } = mod;
  const tools = [];
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    sessionPersistence: { list: async () => [], locate: () => undefined },
    workspaceRegistry: {},
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerSessionMgmtTools(ctx);
  const trash = tools.find((t) => t.name === 'session_trash');
  const purge = tools.find((t) => t.name === 'session_purge');
  await trash.execute({ sessionId: 'session-fff1' }, {});
  await purge.execute({ sessionId: 'session-fff1' }, {});
  const list = tools.find((t) => t.name === 'session_list');
  const out = await list.execute({ includeTrash: true }, {});
  assert.ok(!out.includes('session-fff1'));
});

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true });
});

// --- regression: the persistence list returns SNAPSHOTS, not headers -----------
// Production symptom (rc.2, 2026-09-12): session_list printed "undefined" for every
// row and session_trash answered "(no artifact found, entry recorded)" for sessions
// that plainly existed. Both read `h.id` one level too shallow.
const { sessionEntries, registerSessionMgmtTools } = mod;

test('persistence snapshots are unwrapped', () => {
  const snapshots = [{ header: { id: 'session-abc', cwd: 'C:\\work' }, revision: 'r1', sizeBytes: 10 }];
  const entries = sessionEntries(snapshots);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'session-abc');
  assert.equal(entries[0].cwd, 'C:\\work');
  assert.equal(entries[0].entry, snapshots[0], 'the raw snapshot must survive for locate()');
});

test('bare headers still work; identity-less rows are dropped, never rendered', () => {
  assert.equal(sessionEntries([{ id: 'x', cwd: '/a' }])[0].id, 'x');
  assert.deepEqual(sessionEntries([{ revision: 'r' }, null, undefined, { header: {} }]), []);
  assert.deepEqual(sessionEntries(null), []);
  assert.deepEqual(sessionEntries(undefined), []);
});

test('session_list renders real ids and never the word undefined', async () => {
  const registered = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    sessionPersistence: {
      list: async () => [{ header: { id: 'session-xyz', cwd: 'D:\\proj' }, revision: 'r', sizeBytes: 1 }],
    },
    agents: { get: () => undefined },
  };
  registerSessionMgmtTools(ctx);
  const tool = registered.find((t) => t.name === 'session_list');
  assert.ok(tool, 'session_list must register');
  const printed = await tool.execute({});
  assert.match(printed, /session-xyz/);
  assert.match(printed, /D:\\proj/);
  assert.ok(!/undefined/.test(printed), 'no row may render as undefined: ' + printed);
});

test('session_list tolerates the old bare-header shape too', async () => {
  const registered = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    sessionPersistence: { list: async () => [{ id: 'session-old', cwd: '/legacy' }] },
    agents: { get: () => undefined },
  };
  registerSessionMgmtTools(ctx);
  const printed = await registered.find((t) => t.name === 'session_list').execute({});
  assert.match(printed, /session-old/);
  assert.ok(!/undefined/.test(printed));
});
