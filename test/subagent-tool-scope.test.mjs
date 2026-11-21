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

/** A ctx whose tools.restrict records what it was asked to deny. */
function fakeCtx({ failOnUnknown = false } = {}) {
  const calls = [];
  return {
    calls,
    get: (name) => (name === 'tools' ? {
      restrict: (filter) => {
        calls.push(filter);
        if (failOnUnknown) throw new Error('unknown tool name');
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
  const disposer = restrictSubagentTools(ctx, agentWith({ origin: 'subagent' }));
  assert.equal(ctx.calls.length, 1, 'exactly one restrict call');
  assert.deepEqual(ctx.calls[0].deny, subagentDenyList());
  assert.equal(ctx.calls[0].allow, undefined, 'deny only — allow would freeze the toolset');
  assert.equal(typeof disposer, 'function', 'the restriction must be reversible');
  disposer();
  assert.deepEqual(ctx.calls[1], { disposed: true });
});

test('a root session gets NO restriction', () => {
  const ctx = fakeCtx();
  const disposer = restrictSubagentTools(ctx, agentWith({ delegationDepth: 0 }));
  assert.equal(disposer, null);
  assert.equal(ctx.calls.length, 0, 'a root session must keep every tool');
});

test('an unknown tool name fails loudly instead of silently disabling the restriction', () => {
  // By contract, `restrict` fails the whole call on an unknown name. Swallowing that would leave
  // the subagent with every tool and no signal that the fix did nothing.
  const ctx = fakeCtx({ failOnUnknown: true });
  const disposer = restrictSubagentTools(ctx, agentWith({ origin: 'subagent' }));
  assert.equal(disposer, null, 'the caller must be able to tell it did not apply');
});

test('a ctx without a tool registry is a no-op, not a crash', () => {
  assert.equal(restrictSubagentTools({ get: () => null }, agentWith({ origin: 'subagent' })), null);
  assert.equal(restrictSubagentTools(null, agentWith({ origin: 'subagent' })), null);
});
