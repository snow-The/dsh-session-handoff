// Unit tests for moderation-triggered CONTEXT reset (see lib/moderation.js).
//
// The point of these tests is the ORDER of the two mechanisms: moderation must try to change
// WHAT IS SENT (context) before anything else — rotating the route re-sends the same bytes to a
// provider that is already healthy, which is exactly how a session died on 2026-10-05.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'moderation-'));
process.env.DSH_HOME = tmp;

const m = await import('../lib/moderation.js');
const f = await import('../lib/failover.js');
const { isModerationFailure, looksLikeModeration, createModerationReset, tombstoneText } = m;

test('isModerationFailure matches the provider wordings we have actually seen', () => {
  assert.ok(isModerationFailure({ code: 'INVALID_REQUEST', message: 'Content Exists Risk (request_id: 15d7ce36-5ede-4a35-8cb2-6a315397f901)' }));
  assert.ok(isModerationFailure({ message: 'blocked by the safety filter' }));
  assert.ok(isModerationFailure({ message: '内容存在风险' }));
  assert.ok(isModerationFailure({ message: '觸發了內容審查' }));
});

test('isModerationFailure does not fire on capacity, auth or unknown errors', () => {
  for (const failure of [
    { code: 'QUOTA', message: 'quota exhausted' },
    { code: 'RATE_LIMIT', message: 'slow down' },
    { code: 'AUTH', message: 'bad key' },
    { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' },
    { code: 'PROVIDER_HTTP_ERROR', message: 'Command Code 请求失败（HTTP 400）' },
  ]) assert.equal(isModerationFailure(failure), false, JSON.stringify(failure));
});

test('looksLikeModeration is the second-hand signal only: 400-class AND another provider already refused', () => {
  const generic = { code: 'PROVIDER_HTTP_ERROR', message: 'server refused the request', provider: 'commandcode' };
  assert.equal(looksLikeModeration(generic, new Set()), false, 'one provider alone is not evidence');
  assert.equal(looksLikeModeration(generic, new Set(['commandcode'])), false, 'the SAME provider twice is not evidence');
  assert.equal(looksLikeModeration(generic, new Set(['deepseek'])), true, 'a second, distinct provider is');
  assert.equal(looksLikeModeration({ code: 'QUOTA', message: 'x', provider: 'a' }, new Set(['b'])), false, 'capacity codes are not moderation');
});

test('tombstoneText names the seq so the content is one lookup away, never lost', () => {
  const t = tombstoneText(4711);
  assert.match(t, /4711/);
  assert.match(t, /moderation-reset/);
});

function stubAgent(tokens) {
  const state = { tokens };
  return {
    agent: { id: 'sess', session: { append: () => {} } },
    shrink(by) { state.tokens -= by; },
    meter: () => state.tokens,
  };
}

test('reset stage 1: tombstoning the newest results is enough — no model call, no fold', async () => {
  const { agent, meter, shrink } = stubAgent(100000);
  let folded = 0;
  const replaced = [];
  const reset = createModerationReset({
    meter,
    results: () => [{ seq: 900 }, { seq: 899 }],
    replace: (_a, target) => { replaced.push(target.seq); shrink(3000); return true; },
    fold: async () => { folded += 1; return true; },
  });
  const out = await reset(agent, {});
  assert.equal(out.changed, true);
  assert.match(out.how, /tombstoned 2/);
  assert.deepEqual(replaced, [900, 899]);
  assert.equal(folded, 0, 'the fold must not run when tombstones already freed enough');
});

test('reset stage 2: tombstones too small -> fold; and both must PROVE the context shrank', async () => {
  const { agent, meter, shrink } = stubAgent(100000);
  let folded = 0;
  const reset = createModerationReset({
    meter,
    results: () => [{ seq: 12 }],
    replace: () => { shrink(100); return true; },   // frees 100 < need(2000)
    fold: async () => { folded += 1; shrink(40000); return true; },
  });
  const out = await reset(agent, {});
  assert.equal(folded, 1);
  assert.equal(out.changed, true);
  assert.match(out.how, /folded a range/);
  assert.equal(out.freed, 40100);
});

test('reset reports changed:false when nothing can be removed (caller must surface the error, not loop)', async () => {
  const { agent, meter } = stubAgent(50000);
  const reset = createModerationReset({
    meter,
    results: () => [],
    replace: () => false,
    fold: async () => { throw new Error('compaction service missing'); },
  });
  const out = await reset(agent, {});
  assert.equal(out.changed, false);
  assert.match(out.how, /nothing to remove/);
});

test('reset survives a throwing collector and a throwing replace', async () => {
  const { agent, meter } = stubAgent(1000);
  const reset = createModerationReset({
    meter,
    results: () => { throw new Error('no file events'); },
    replace: () => { throw new Error('surface refused'); },
  });
  const out = await reset(agent, {});
  assert.equal(out.changed, false);
});

// --- integration with the failover installer ---------------------------------

function makeCtx() {
  const handlers = {};
  const events = [];
  const appended = [];
  return {
    handlers,
    events,
    appended,
    ctx: {
      on(name, fn) { handlers[name] = fn; return () => {}; },
      logger: { info: (s) => events.push(s), warn: (s) => events.push(s) },
      tools: { register: () => {} },
    },
  };
}

test('moderation failure retries the SAME provider after the context changed (route is not the problem)', async () => {
  const { writeFailoverRoutes } = f;
  await writeFailoverRoutes(['deepseek', 'deepseek-official']);
  const { ctx, handlers, events } = makeCtx();
  let calls = 0;
  f.installFailover(ctx, { onModerationReset: async () => { calls += 1; return { changed: true, how: 'tombstoned 1 tool result(s)', freed: 3000, before: 100000, after: 97000 }; } });
  const agent = { id: 's1', session: { append: () => {} } };
  const out = await handlers['agent/request-error'](
    { agent, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'INVALID_REQUEST', message: 'Content Exists Risk (request_id: x)' }, signal: {} },
    () => 'CONTINUE',
  );
  assert.deepEqual(out, { kind: 'retry' });
  assert.equal(calls, 1);
  assert.ok(events.some((e) => /moderation reset #1/.test(e)), 'the reset must be logged');
  const seed = await handlers['agent/request']({ agent, turn: 1, step: 1 }, () => ({ provider: 'deepseek-official', model: 'm' }));
  assert.deepEqual(seed, { provider: 'deepseek-official', model: 'm' }, 'no route switch on a content refusal');
});

test('a moderation reset that frees nothing does not fake success', async () => {
  const { ctx, handlers } = makeCtx();
  f.installFailover(ctx, { onModerationReset: async () => ({ changed: false, how: 'nothing to remove' }) });
  const agent = { id: 's2', session: { append: () => {} } };
  const out = await handlers['agent/request-error'](
    { agent, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'INVALID_REQUEST', message: 'Content Exists Risk' }, signal: {} },
    () => 'CONTINUE',
  );
  assert.equal(out, 'CONTINUE', 'the original error surfaces');
});

test('the reset budget is bounded: after maxModerationResets the error surfaces', async () => {
  const { ctx, handlers } = makeCtx();
  let calls = 0;
  f.installFailover(ctx, { onModerationReset: async () => { calls += 1; return { changed: true, how: 'ok', freed: 1 }; }, maxModerationResets: 2 });
  const agent = { id: 's3', session: { append: () => {} } };
  const fire = () => handlers['agent/request-error'](
    { agent, turn: 2, step: 1, provider: 'p', failure: { code: 'INVALID_REQUEST', message: 'Content Exists Risk' }, signal: {} },
    () => 'CONTINUE',
  );
  assert.deepEqual(await fire(), { kind: 'retry' });
  assert.deepEqual(await fire(), { kind: 'retry' });
  assert.equal(await fire(), 'CONTINUE');
  assert.equal(calls, 2);
});

test('the heuristic needs two distinct providers before it resets context', async () => {
  const { ctx, handlers } = makeCtx();
  let calls = 0;
  f.installFailover(ctx, { onModerationReset: async () => { calls += 1; return { changed: true, how: 'ok', freed: 1 }; } });
  const agent = { id: 's4', session: { append: () => {} } };
  const generic = (provider) => handlers['agent/request-error'](
    { agent, turn: 3, step: 1, provider, failure: { code: 'PROVIDER_HTTP_ERROR', message: '服务端拒绝了本次请求' }, signal: {} },
    () => 'CONTINUE',
  );
  assert.equal(await generic('commandcode'), 'CONTINUE');
  assert.equal(calls, 0, 'one generic 400 is a bad request, not moderation');
  assert.deepEqual(await generic('deepseek'), { kind: 'retry' });
  assert.equal(calls, 1, 'a second, distinct provider refusing the same step is the signature');
});
