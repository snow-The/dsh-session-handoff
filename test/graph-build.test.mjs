/**
 * `acp_graph build` over the in-memory accessor.
 *
 * The regression this guards: graph.js used to read `session.events` (a property a harness session
 * does not have) as its fallback for sessions whose log file is empty — so the fallback was dead code
 * and `build` reported "+0 checkpoint(s)" as if the session had none. The stub here deliberately
 * exposes ONLY `ownEvents()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'acp-graph-'));
process.env.DSH_HOME = dir;   // the graph DB and the watermarks live under it, never the real ones

const { apply, dispose } = await import('../lib/index.js');

test('acp_graph build ingests a session that exposes ONLY ownEvents()', async () => {
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return d; } },
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: () => {}, provide: () => {}, on: () => {},
  };
  apply(ctx, {});
  const events = [
    { seq: 42, type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'the in-memory checkpoint that must reach the graph' }] } },
  ];
  const session = { id: 'graph-probe', header: { cwd: dir }, ownEvents: () => events, surface: { nodes: [42] } };
  const out = await registered.find((t) => t.name === 'acp_graph').execute({ command: 'build' }, { agent: { session, ctx } });
  assert.match(String(out), /\+[1-9][0-9]* checkpoint/, 'the in-memory events must be ingested when no session file exists: ' + String(out));
  assert.match(String(out), /checkpoints=[1-9]/, String(out));
  dispose();
});

process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
