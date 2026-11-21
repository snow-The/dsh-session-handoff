// The stutter guard must actually CANCEL the turn, not merely notice the stutter.
//
// This is the wiring test, and it exists because "the detector works" and "the stream stops" are
// different claims. The seam is:
//
//   agent/assistant-stream (emit)  ->  our listener accumulates deltas
//   agent.cancel({kind:'hook'})    ->  aborts this.phase.abort (dsh-agent-loop/index.js:594)
//   the loop's chunk loop          ->  signal.throwIfAborted() after every chunk (:894-898)
//
// So the assertion is on the CALL, with the real frame shapes the loop emits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');

/** A ctx that records listeners so the test can drive them, and records cancels. */
function fakeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    listeners,
    logs,
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    // apply() registers cleanup through ctx.effect; a fake ctx must provide it or every test
    // fails at apply() before reaching the behaviour under test.
    effect: (fn) => { if (typeof fn === 'function') fn(); },
    get: () => null,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    emit: async (name, payload) => {
      for (const fn of listeners.get(name) ?? []) await fn(payload);
    },
  };
}

/** An agent whose cancel() is observable. */
function fakeAgent() {
  const cancels = [];
  return {
    cancels,
    session: { id: 'test-session', append: () => 0 },
    cancel: (cause, options) => { cancels.push({ cause, options }); },
  };
}

/** One `chunk` frame carrying a text delta, as the loop publishes it. */
function textFrame(text) {
  return { type: 'chunk', chunk: { type: 'text-delta', index: 0, text } };
}

const LIVE = `OK.

Let me write.

Let me go.

Writing.

Let me go.

OK.

Let me write.

Let me go.

Writing.

Let me go.
`;

test('the guard cancels the turn when the known stutter streams', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: true });
  const agent = fakeAgent();

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  // Feed the live sample in deltas, as a provider would.
  for (let i = 0; i < LIVE.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(LIVE.slice(i, i + 10)) });
  }

  assert.equal(agent.cancels.length, 1, `expected exactly one cancel, got ${JSON.stringify(agent.cancels)}`);
  assert.equal(agent.cancels[0].cause.kind, 'hook', 'the contract provides {kind:"hook", reason} for this');
  assert.match(agent.cancels[0].cause.reason, /degenerate repetition/);
});

test('the guard does NOT cancel a normal answer', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: true });
  const agent = fakeAgent();

  const answer = 'The compaction threshold was read from the wrong section, so the soft limit '
    + 'never fired and the session grew until the provider rejected it. The fix is to read the '
    + 'section the plugin actually writes.\n\nHere is the patch:\n\n'
    + '```js\nconst cfg = readSection(text);\n```\n\nThat is all.';
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  for (let i = 0; i < answer.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(answer.slice(i, i + 10)) });
  }

  assert.equal(agent.cancels.length, 0, `false positive: ${JSON.stringify(agent.cancels)}`);
});

test('the guard cancels ONCE, not on every later chunk', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: true });
  const agent = fakeAgent();

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  for (let i = 0; i < LIVE.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(LIVE.slice(i, i + 10)) });
  }
  // Keep streaming after the cancel: a real provider may deliver buffered chunks.
  for (let i = 0; i < LIVE.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(LIVE.slice(i, i + 10)) });
  }

  assert.equal(agent.cancels.length, 1, `expected one cancel, got ${agent.cancels.length}`);
});

test('stutterGuard: false disables it entirely', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: false });
  const agent = fakeAgent();

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  for (let i = 0; i < LIVE.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(LIVE.slice(i, i + 10)) });
  }

  assert.equal(agent.cancels.length, 0, 'the guard must be off when configured off');
});

test('a new attempt resets the guard, so a clean retry is not cancelled', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: true });
  const agent = fakeAgent();

  // First attempt stutters and is cancelled.
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  for (let i = 0; i < LIVE.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(LIVE.slice(i, i + 10)) });
  }
  assert.equal(agent.cancels.length, 1);

  // Second attempt is a real answer: the accumulated stutter must not carry over.
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  const answer = 'Here is the finding: the threshold was read from the wrong section, and the '
    + 'soft limit therefore never fired. The fix reads the section the plugin writes.';
  for (let i = 0; i < answer.length; i += 10) {
    await ctx.emit('agent/assistant-stream', { agent, frame: textFrame(answer.slice(i, i + 10)) });
  }
  assert.equal(agent.cancels.length, 1, 'the retry must not be cancelled for the previous attempt');
});

test('tool-call deltas are not judged as prose', async () => {
  const ctx = fakeCtx();
  mod.installStutterGuard(ctx, { stutterGuard: true });
  const agent = fakeAgent();

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  // A tool call whose JSON fragments happen to repeat must not be read as a stutter.
  for (let i = 0; i < 20; i++) {
    await ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 0, id: 'c1', text: '{"a":1}' } },
    });
  }
  assert.equal(agent.cancels.length, 0, 'tool-call deltas must be ignored');
});
