// Unit tests for model-routes: route enumeration + the real switch write.
//
// The switch used to write `$DSH_HOME/settings.yaml`, which the running host
// does not read — a green checkmark on a no-op. It now hands the change to the
// host's `configEditor` (the owner of the profile patch) and reads the live
// config back. These tests drive BOTH halves with a fake editor, and the
// "must accept" control next to every "must reject" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DSH_HOME: only `.credentials.yaml` is read from here now.
const tmp = mkdtempSync(join(tmpdir(), 'routes-test-'));
process.env.DSH_HOME = tmp;
writeFileSync(join(tmp, '.credentials.yaml'), 'ARK_API_KEY: enc:whatever\nCOMMANDCODE_API_KEY: enc:whatever\n');

const mod = await import('../lib/model-routes.js');

const AGENT_DEFAULT = {
  id: 'agent-default-model',
  name: '@deepseek-ai/dsh-agent-default-model',
  config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'max' },
};

/**
 * A host-shaped ctx: an llm directory, and a configEditor that owns the patch.
 * @param {object} o
 * @param {Array} [o.providers] llm.listProviders() rows
 * @param {boolean} [o.hasRow] the profile has an agent-default-model row
 * @param {boolean} [o.apply] whether the fake editor really applies the change
 * @param {boolean} [o.noEditor] the host exposes no configEditor at all
 * @param {Error} [o.editThrows] the editor rejects (rollback path)
 */
function fakeCtx({ providers = [], hasRow = true, apply = true, noEditor = false, editThrows = null, config } = {}) {
  const entry = {
    options: {
      id: AGENT_DEFAULT.id,
      name: AGENT_DEFAULT.name,
      config: { ...(config ?? AGENT_DEFAULT.config) },
    },
  };
  const calls = [];
  const editor = {
    documentPath: 'C:/Users/x/.dsh/profiles/web/cordis.patch.yml',
    entries: () => (hasRow ? [entry] : []),
    edit: async (target, change) => {
      calls.push(change);
      if (editThrows) throw editThrows;
      const next = change({ ...target.options.config }, {});
      if (apply) target.options.config = next;
    },
  };
  const services = {
    llm: { listProviders: () => providers },
    ...(noEditor ? {} : { configEditor: editor }),
  };
  return { ctx: { get: (name) => services[name] }, entry, calls, editor };
}

test('enumerateRoutes lists live + built-in routes, never invented from settings.yaml', () => {
  const { ctx } = fakeCtx({ providers: [{ id: 'commandcode', baseURL: 'https://api.commandcode.ai', apiKeyEnv: 'COMMANDCODE_API_KEY' }, { id: 'deepseek' }] });
  const routes = mod.enumerateRoutes(ctx);
  const names = routes.map((r) => r.provider);
  assert.deepEqual(names.slice().sort(), ['commandcode', 'deepseek', 'deepseek-official']);
  const cc = routes.find((r) => r.provider === 'commandcode');
  assert.equal(cc.registered, true, 'a live adapter IS registration');
  assert.equal(cc.source, 'live');
  assert.equal(cc.baseURL, 'https://api.commandcode.ai');
  assert.equal(cc.keyState, 'stored', 'a ref in the managed store is stored, not missing');
  const off = routes.find((r) => r.provider === 'deepseek-official');
  assert.equal(off.source, 'builtin');
  assert.equal(off.baseURL, 'https://api.deepseek.com');
  assert.equal(off.keyState, 'missing', 'no env, no stored ref');
});

test('the default marker comes from the live agent-default-model config', () => {
  const { ctx } = fakeCtx({
    providers: [{ id: 'commandcode' }, { id: 'deepseek-official' }],
    config: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  });
  const routes = mod.enumerateRoutes(ctx);
  assert.equal(routes.find((r) => r.provider === 'deepseek-official').default, true);
  assert.equal(routes.find((r) => r.provider === 'commandcode').default, false);

  const read = mod.readAgentDefault(ctx);
  assert.equal(read.source, 'live-config');
  assert.equal(read.provider, 'deepseek-official');
  assert.equal(read.model, 'deepseek-v4.1-flash');
  assert.equal(read.reasoningEffort, 'high');
  assert.equal(read.patchPath, 'C:/Users/x/.dsh/profiles/web/cordis.patch.yml');
});

test('readAgentDefault names WHY it cannot answer instead of guessing', () => {
  const noEditor = mod.readAgentDefault(fakeCtx({ noEditor: true }).ctx);
  assert.equal(noEditor.source, 'no-editor');
  assert.equal(noEditor.provider, undefined);
  assert.equal(noEditor.patchPath, null);

  const noRow = mod.readAgentDefault(fakeCtx({ hasRow: false }).ctx);
  assert.equal(noRow.source, 'no-entry');
  assert.equal(noRow.provider, undefined);

  // and the tool still renders an empty/marker-free list rather than throwing
  const listing = mod.enumerateRoutes(fakeCtx({ noEditor: true, providers: [{ id: 'commandcode' }] }).ctx);
  assert.equal(listing.some((r) => r.default), false, 'no live config -> no default marker');
});

test('a live adapter that stays quiet about auth still shows the host built-in route', () => {
  // The adapters expose only their id: no baseURL, no apiKeyEnv, no models.
  // A route the host can serve must not look keyless for that reason — and a
  // route that is NOT one of the two built-ins must not borrow their auth.
  const { ctx } = fakeCtx({ providers: [{ id: 'deepseek' }, { id: 'deepseek-official' }, { id: 'commandcode' }] });
  const routes = mod.enumerateRoutes(ctx);
  const ark = routes.find((r) => r.provider === 'deepseek');
  assert.equal(ark.baseURL, 'https://ark.cn-beijing.volces.com/api/plan/v3');
  assert.equal(ark.keyEnv, 'ARK_API_KEY');
  assert.equal(ark.keyState, 'stored');
  assert.equal(ark.source, 'live', 'it IS live — the table only fills what the adapter omits');
  assert.equal(ark.note, 'registered route (host built-in name)');

  const off = routes.find((r) => r.provider === 'deepseek-official');
  assert.equal(off.keyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(off.keyState, 'missing');

  const cc = routes.find((r) => r.provider === 'commandcode');
  assert.equal(cc.baseURL, null, 'a foreign route gets no borrowed baseURL');
  assert.equal(cc.keyEnv, null, 'a foreign route gets no borrowed key ref');
});

test('a provider that declares no apiKeyEnv is undeclared, not missing', () => {
  const { ctx } = fakeCtx({ providers: [{ id: 'commandcode', name: 'Command Code' }] });
  const cc = mod.enumerateRoutes(ctx).find((r) => r.provider === 'commandcode');
  assert.equal(cc.keyState, 'undeclared');
  assert.notEqual(cc.keyFamily, '(missing)');
  assert.equal(cc.keyEnv, null);
});

test('switchProvider writes through the host editor and preserves unrelated fields', async () => {
  const { ctx, entry, calls } = fakeCtx({
    providers: [{ id: 'commandcode', baseURL: 'https://api.commandcode.ai', apiKeyEnv: 'COMMANDCODE_API_KEY' }, { id: 'deepseek-official' }],
    config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'max', someOtherField: 'keep me' },
  });
  const result = await mod.switchProvider(ctx, 'deepseek-official');

  assert.equal(calls.length, 1, 'exactly one edit call — no second writer');
  assert.equal(result.provider, 'deepseek-official');
  assert.equal(result.model, 'deepseek/deepseek-v4.1-flash', 'model preserved from the previous default');
  assert.equal(result.reasoningEffort, 'max', 'effort preserved');
  assert.equal(result.previous.provider, 'commandcode', 'the report can name what moved');
  assert.equal(result.patchPath, 'C:/Users/x/.dsh/profiles/web/cordis.patch.yml');
  assert.equal(entry.options.config.someOtherField, 'keep me', 'an unrelated config field survives the switch');
  assert.equal(entry.options.config.provider, 'deepseek-official');
});

test('switchProvider honours explicit model / effort overrides', async () => {
  const { ctx, entry } = fakeCtx({ providers: [{ id: 'commandcode' }, { id: 'deepseek' }] });
  const result = await mod.switchProvider(ctx, 'deepseek', { model: 'deepseek-v4-pro', reasoningEffort: 'low' });
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(result.reasoningEffort, 'low');
  assert.equal(entry.options.config.reasoningEffort, 'low');
});

test('a write that the live config does not show is reported as FAILED, not done', async () => {
  // Must reject: the editor runs but the change never lands.
  const { ctx } = fakeCtx({ providers: [{ id: 'commandcode' }, { id: 'deepseek-official' }], apply: false });
  await assert.rejects(
    () => mod.switchProvider(ctx, 'deepseek-official'),
    /does not show it[\s\S]*provider: wanted deepseek-official/,
  );

  // Must accept (control): the same call with a working editor succeeds.
  const ok = fakeCtx({ providers: [{ id: 'commandcode' }, { id: 'deepseek-official' }], apply: true });
  await assert.doesNotReject(() => mod.switchProvider(ok.ctx, 'deepseek-official'));
});

test('switchProvider refuses without lying about why', async () => {
  const noEditor = fakeCtx({ providers: [{ id: 'commandcode' }], noEditor: true });
  await assert.rejects(() => mod.switchProvider(noEditor.ctx, 'commandcode'), /configEditor/);

  const noRow = fakeCtx({ providers: [{ id: 'commandcode' }], hasRow: false });
  await assert.rejects(
    () => mod.switchProvider(noRow.ctx, 'commandcode'),
    /no `agent-default-model` row[\s\S]*- id: agent-default-model/,
    'the error carries the pasteable row, so the fix is one paste',
  );

  const unknown = fakeCtx({ providers: [{ id: 'commandcode' }] });
  await assert.rejects(() => mod.switchProvider(unknown.ctx, 'nope'), /unknown provider "nope"; available: .*commandcode/);
  assert.equal(unknown.calls.length, 0, 'a rejected switch must not touch the profile');
});

test('a failing editor surfaces its own error (the host already rolled the file back)', async () => {
  const boom = new Error('Configuration for "agent-default-model" is overridden by a home patch');
  const { ctx } = fakeCtx({ providers: [{ id: 'commandcode' }, { id: 'deepseek-official' }], editThrows: boom });
  await assert.rejects(() => mod.switchProvider(ctx, 'deepseek-official'), /overridden by a home patch/);
});

test('switch report states the file, the verified read-back, and what moved', () => {
  const text = mod.formatSwitchReport({
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
    route: { baseURL: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', keyFamily: 'stored' },
    previous: { provider: 'commandcode', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    patchPath: 'C:/x/profiles/web/cordis.patch.yml',
  });
  assert.match(text, /wrote: C:\/x\/profiles\/web\/cordis\.patch\.yml/);
  assert.match(text, /verified by reading the live agent-default-model config back/);
  assert.match(text, /provider commandcode -> deepseek-official/);
  assert.match(text, /reasoningEffort max -> high/);
  assert.ok(!/model deepseek\/deepseek-v4\.1-flash ->/.test(text), 'an unchanged field is not reported as a change');
  // The lie this file exists to remove: settings.yaml does not carry the value.
  assert.ok(!/takes effect for new sessions/.test(text));
  assert.match(text, /settings\.yaml is NOT involved/);

  const noop = mod.formatSwitchReport({
    provider: 'deepseek-official',
    model: 'm',
    reasoningEffort: 'max',
    route: {},
    previous: { provider: 'deepseek-official', model: 'm', reasoningEffort: 'max' },
    patchPath: 'p',
  });
  assert.match(noop, /changed: nothing/);
});

test('patchRowFor emits a row the loader accepts', () => {
  assert.equal(
    mod.patchRowFor({ provider: 'x', model: 'y', reasoningEffort: 'high' }),
    [
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: x',
      '    model: y',
      '    reasoningEffort: high',
    ].join('\n'),
  );
});

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true });
});
