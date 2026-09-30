/**
 * Upstream issue #2: `handoff_resume` without `file` loaded the WRONG handoff.
 *
 * The old selection was `(await readdir(dir)).filter(…).sort().reverse()`. `sort()` with no
 * comparator is lexicographic and every file shares the `handoff-session-` prefix, so the deciding
 * characters were the hex of a session id. In the reporter's workspace that picked the 2026-09-20
 * document when the 2026-09-29 one existed — and nothing in the output said so, because a stale
 * handoff reads exactly like a fresh one.
 *
 * This file uses that exact workspace (names + mtimes) as the fixture.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'handoff-resume-home-'));
const ws = mkdtempSync(join(tmpdir(), 'handoff-resume-ws-'));
process.env.DSH_HOME = home;
process.env.DSH_ACP_METRICS = join(home, 'acp-metrics.jsonl');

const { apply, dispose, __internals } = await import('../lib/index.js');
const { rankHandoffDocs } = __internals;

/** The reporter's four documents, verbatim, including the newest/oldest mtimes. */
const DOCS = [
  { name: 'handoff-session-370c142b-bd50-473e-9d38-1ace1f01535b.md', at: '2026-09-29T14:23:35Z', exported: '2026-09-29T06:23:35.000Z' },
  { name: 'handoff-session-025b6f81-9a1d-4137-a665-8ff2b66d343b.md', at: '2026-09-22T10:23:22Z', exported: '2026-09-22T02:23:22.000Z' },
  { name: 'handoff-session-fdf39917-9f55-4062-9daa-b988ca680697.md', at: '2026-09-20T11:20:18Z', exported: '2026-09-20T03:20:18.616Z' },
  { name: 'handoff-session-61b9676a-907d-4cc4-9bc3-2d283150fd95.md', at: '2026-09-13T23:53:26Z', exported: '2026-09-13T15:53:26.000Z' },
];
const NEWEST = DOCS[0].name;
const LEXICOGRAPHIC_WINNER = 'handoff-session-fdf39917-9f55-4062-9daa-b988ca680697.md';

const dir = join(ws, '.dsh-handoff');
mkdirSync(dir, { recursive: true });
for (const d of DOCS) {
  const p = join(dir, d.name);
  writeFileSync(p, `# Session Handoff\n\n- exported: ${d.exported}\n- session: ${d.name.slice(16, 24)}\n`);
  const t = new Date(d.at);
  utimesSync(p, t, t);
}

function boot() {
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return d; } },
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: () => {}, provide: () => {}, on: () => {},
  };
  apply(ctx, {});
  const session = {
    id: 'resume-probe',
    header: { cwd: ws },
    surface: { nodes: [] },
    ownEvents: () => [],
    requestHeader: () => ({ config: {} }),
  };
  return { registered, agent: { session, ctx, options: {} } };
}

const resume = () => boot().registered.find((t) => t.name === 'handoff_resume');

after(() => { dispose(); });
process.on('exit', () => {
  for (const d of [home, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('the fixture really is a lexicographic trap (otherwise this file proves nothing)', () => {
  const byName = DOCS.map((d) => d.name).sort().reverse();
  assert.equal(byName[0], LEXICOGRAPHIC_WINNER, 'the old sort().reverse() must pick the 2026-09-20 document');
  assert.notEqual(byName[0], NEWEST, 'and it must NOT be the newest by mtime');
});

test('rankHandoffDocs orders by recency, not by name', async () => {
  const ranked = await rankHandoffDocs(dir, DOCS.map((d) => d.name));
  assert.deepEqual(ranked.map((r) => r.name), DOCS.map((d) => d.name));
  assert.equal(ranked[0].name, NEWEST);
});

test('handoff_resume with no file loads the newest document and states its age', async () => {
  const out = await resume().execute({}, { agent: boot().agent });
  assert.match(out, new RegExp(`Loaded handoff: ${NEWEST}`), 'the newest by mtime must win: ' + out.split('\n')[0]);
  assert.ok(out.includes('exported 2026-09-29T06:23:35.000Z'), 'the age is printed, not inferred');
  assert.ok(out.includes('newest of 4 documents'));
  assert.ok(!out.includes('NOT the newest'), 'no warning when it IS the newest');
});

test('an explicitly named older document loads, and says it is not the newest', async () => {
  const b = boot();
  const out = await b.registered.find((t) => t.name === 'handoff_resume').execute(
    { file: LEXICOGRAPHIC_WINNER },
    { agent: b.agent },
  );
  assert.match(out, new RegExp(`Loaded handoff: ${LEXICOGRAPHIC_WINNER}`), 'an explicit request is still honoured');
  assert.ok(out.includes(`Note: this is NOT the newest document — ${NEWEST} is newer.`), 'the trap becomes visible: ' + out.split('\n').slice(0, 2).join(' / '));
});

test('an explicit name that does not exist lists what is available', async () => {
  const b = boot();
  const out = await b.registered.find((t) => t.name === 'handoff_resume').execute(
    { file: 'handoff-session-nope.md' },
    { agent: b.agent },
  );
  assert.match(out, /Handoff not found: handoff-session-nope\.md/);
  assert.ok(out.includes(NEWEST), 'the available list is shown');
});
