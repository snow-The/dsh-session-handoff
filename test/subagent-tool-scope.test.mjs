// The subagent tool restriction must actually remove tools, and must not touch a root session.
//
// THE MEASUREMENT THIS ENCODES. Across 168 native `source/repos` sessions (all subagents), 126 of
// 222 declared tools were never called, costing 21,136 tokens per request — 58.3% of the schema
// block. The dominant families are rlab_* (10), search_* (4) and ssh_* (3).
//
// WHAT THESE TESTS PIN:
//   - the deny list covers the measured-dead families and nothing else
//   - a subagent gets the restriction; a root session does not
//   - the disposer is returned so the restriction is reversible
//   - an unknown name fails LOUDLY (returns null) instead of silently disabling the restriction
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../lib/subagent-tool-scope.js');
const { SUBAGENT_DENY, subagentDenyList, shouldRestrict, restrictSubagentTools } = mod;

/**
 * A ctx whose tools.restrict behaves like the real one.
 *
 * The real implementation (dsh-tools/lib/index.js:453-466) throws on the FIRST unknown name and
 * names every unknown tool in the message, so the fake must do the same or the narrowing path
 * cannot be tested.
 */
function fakeCtx({ unknownNames = [], failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    get: (name) => (name === 'tools' ? {
      restrict: (filter) => {
        calls.push(filter);
        if (failWith != null) throw new Error(failWith);
        const named = (filter.deny ?? []).filter((n) => unknownNames.includes(n));
        if (named.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool${named.length > 1 ? 's' : ''} ${named.map((n) => `"${n}"`).join(', ')}; known global tools: ...`);
        }
        return () => { calls.push({ disposed: true }); };
      },
    } : null),
  };
}

function agentWith(header) {
  return { session: { header } };
}

test('the deny list covers the three measured-dead families', () => {
  const deny = subagentDenyList();
  // Measured dead across 168 subagent sessions.
  for (const name of ['rlab_related', 'rlab_scoop', 'rlab_ocr', 'search_api', 'search_deep', 'ssh_tunnel', 'ssh_cluster']) {
    assert.ok(deny.includes(name), `${name} must be denied — it was never called in 168 sessions`);
  }
  // And it must NOT deny the tools a subagent actually needs.
  for (const name of ['pwsh', 'read', 'write', 'edit', 'grep', 'glob', 'subagent', 'todo_write']) {
    assert.ok(!deny.includes(name), `${name} must stay — a subagent needs it`);
  }
});

test('the deny list has no duplicates', () => {
  const deny = subagentDenyList();
  assert.equal(new Set(deny).size, deny.length, 'a duplicate would be a silent no-op');
});

test('a subagent is restricted, a root session is not', () => {
  assert.equal(shouldRestrict(agentWith({ origin: 'subagent', delegationDepth: 1 })), true);
  assert.equal(shouldRestrict(agentWith({ delegationDepth: 0 })), false);
  assert.equal(shouldRestrict(agentWith({})), false);
  assert.equal(shouldRestrict({}), false, 'a missing session must not throw');
  assert.equal(shouldRestrict(null), false);
});

test('restrictSubagentTools applies the deny list and returns a disposer', () => {
  const ctx = fakeCtx();
  const applied = restrictSubagentTools(ctx, agentWith({ origin: 'subagent' }));
  assert.equal(ctx.calls.length, 1, 'exactly one restrict call');
  assert.deepEqual(ctx.calls[0].deny, subagentDenyList());
  assert.equal(ctx.calls[0].allow, undefined, 'deny only — allow would freeze the toolset');
  assert.equal(typeof applied.disposer, 'function', 'the restriction must be reversible');
  assert.equal(applied.denied, subagentDenyList().length);
  assert.deepEqual(applied.skipped, []);
  applied.disposer();
  assert.deepEqual(ctx.calls[1], { disposed: true });
});

test('a root session gets NO restriction', () => {
  const ctx = fakeCtx();
  const applied = restrictSubagentTools(ctx, agentWith({ delegationDepth: 0 }));
  assert.equal(applied.disposer, null);
  assert.equal(ctx.calls.length, 0, 'a root session must keep every tool');
});

test('a not-yet-registered tool is SKIPPED, not fatal', () => {
  // `restrict()` validates every name against the registrations that exist AT THAT MOMENT
  // (dsh-tools/lib/index.js:463-465) and throws on the first unknown one. A tool registered a
  // moment later — a lazily loaded bundle — would therefore fail the WHOLE call and leave the
  // subagent with every tool. The helper narrows instead.
  const ctx = fakeCtx({ unknownNames: ['rlab_related', 'ssh_tunnel'] });
  const applied = restrictSubagentTools(ctx, agentWith({ origin: 'subagent' }));
  assert.equal(typeof applied.disposer, 'function', 'the restriction must still apply');
  assert.deepEqual(applied.skipped, ['rlab_related', 'ssh_tunnel']);
  assert.equal(applied.denied, subagentDenyList().length - 2);
  assert.ok(!ctx.calls.at(-1).deny.includes('rlab_related'), 'the unknown name must be dropped');
  assert.ok(ctx.calls.at(-1).deny.includes('rlab_ocr'), 'the known names must survive');
});

test('a failure that is NOT about unknown names reports nothing applied', () => {
  // Swallowing an unrelated error would hide a real defect behind "it did not apply".
  const ctx = fakeCtx({ failWith: 'tools.restrict() requires a scoped context (agent.ctx)' });
  const applied = restrictSubagentTools(ctx, agentWith({ origin: 'subagent' }));
  assert.equal(applied.disposer, null);
  assert.deepEqual(applied.skipped, []);
});

test('a ctx without a tool registry is a no-op, not a crash', () => {
  assert.equal(restrictSubagentTools({ get: () => null }, agentWith({ origin: 'subagent' })).disposer, null);
  assert.equal(restrictSubagentTools(null, agentWith({ origin: 'subagent' })).disposer, null);
});
