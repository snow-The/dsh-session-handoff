// Unit tests for model-routes: settings YAML parsing + route enumeration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DSH_HOME with a representative settings.yaml.
const tmp = mkdtempSync(join(tmpdir(), 'routes-test-'));
process.env.DSH_HOME = tmp;

const settings = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    deepseek:
      baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
      models:
        - id: deepseek-v4.1-flash
          name: DeepSeek V4 Flash(ARK)
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro(ARK)
      apiKeyEnv: ARK_API_KEY
agent-default-model:
  provider: vision-toolkit-deepseek-official
  model: deepseek-v4.1-flash
  reasoningEffort: max
`;
writeFileSync(join(tmp, 'settings.yaml'), settings);

const mod = await import('../lib/model-routes.js');

test('readSettingsYaml parses providers and default model', () => {
  const { readSettingsYaml } = mod;
  const parsed = readSettingsYaml(settings);
  assert.ok(parsed.llmProviders.deepseek, 'deepseek provider parsed');
  assert.equal(parsed.llmProviders.deepseek.baseURL, 'https://ark.cn-beijing.volces.com/api/plan/v3');
  assert.equal(parsed.llmProviders.deepseek.apiKeyEnv, 'ARK_API_KEY');
  assert.ok(parsed.llmProviders.deepseek.models.includes('deepseek-v4.1-flash'));
  assert.equal(parsed.agentDefault.provider, 'vision-toolkit-deepseek-official');
  assert.equal(parsed.agentDefault.reasoningEffort, 'max');
});

test('enumerateRoutes lists configured + built-in routes with default marker', () => {
  const { enumerateRoutes } = mod;
  const routes = enumerateRoutes({});
  const names = routes.map((r) => r.provider);
  assert.ok(names.includes('deepseek'), 'configured route listed');
  assert.ok(names.includes('deepseek-official'), 'built-in route listed');
  const ds = routes.find((r) => r.provider === 'deepseek');
  assert.equal(ds.servesModel, true);
  assert.equal(ds.keyEnv, 'ARK_API_KEY');
  const off = routes.find((r) => r.provider === 'deepseek-official');
  assert.equal(off.default, true, 'vision-toolkit- variant counts as default');
  assert.equal(off.vision, false, 'bare route is not a vision wrapper');
});

test('enumerateRoutes marks the chat-context selection via requestContext', () => {
  const { enumerateRoutes } = mod;
  // llm directory (chat model list): raw + vision-toolkit wrappers.
  const ctx = {
    get: () => ({ listProviders: () => [
      { id: 'deepseek' },
      { id: 'deepseek-official' },
      { id: 'vision-toolkit-deepseek' },
      { id: 'vision-toolkit-deepseek-official' },
    ] }),
  };
  // The running session is on the vision-toolkit-deepseek wrapper (Ark + vision).
  const routes = enumerateRoutes(ctx, { provider: 'vision-toolkit-deepseek', model: 'deepseek-v4.1-flash', contextWindow: 1000000 });
  const wrapped = routes.find((r) => r.provider === 'vision-toolkit-deepseek');
  assert.ok(wrapped, 'vision wrapper appears in the route list (chat model list)');
  assert.equal(wrapped.inUse, true, 'wrapper is the in-use chat model');
  assert.equal(wrapped.currentModel, 'deepseek-v4.1-flash');
  assert.equal(wrapped.vision, true);
  const raw = routes.find((r) => r.provider === 'deepseek');
  assert.equal(raw.inUse, true, 'raw route is also marked when its wrapper is in use');
});

test('a live route that settings.yaml does not describe is still registered', () => {
  const { enumerateRoutes } = mod;
  // 这正是假红的形状：commandcode 这类路由来自 profile patch 行，
  // settings.yaml 里**没有**它的 llm-pi-ai 块，但宿主 llm 目录里有它的 adapter。
  // 旧实现只看 settings.yaml 的 models 列表，于是「列得出来 + 判成未注册」。
  const ctx = {
    get: () => ({
      listProviders: () => [
        { id: 'commandcode', name: 'Command Code' },
        { id: 'deepseek', name: 'DeepSeek (ARK)' },
      ],
    }),
  };
  const routes = enumerateRoutes(ctx);

  const cc = routes.find((r) => r.provider === 'commandcode');
  assert.ok(cc, 'live route must be listed');
  assert.equal(cc.registered, true, 'live registration IS registration');
  assert.equal(cc.source, 'live');
  // 「看不到钥匙」不得冒充「没有钥匙」：provider 没申报 apiKeyEnv 时是 undeclared
  assert.equal(cc.keyState, 'undeclared');
  assert.notEqual(cc.keyFamily, '(missing)');

  const ds = routes.find((r) => r.provider === 'deepseek');
  assert.equal(ds.keyEnv, 'ARK_API_KEY', 'settings still supplies the key ref');
  assert.equal(ds.registered, true);
});

test('switch report tells the truth about where the write lands, and prints the pasteable row', () => {
  const { formatSwitchReport, patchRowFor } = mod;
  const route = { baseURL: 'https://api.commandcode.ai', keyEnv: 'COMMANDCODE_API_KEY', keyFamily: 'stored' };
  const text = formatSwitchReport({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    reasoningEffort: 'max',
    route,
  });
  // 旧文案是谎：当前 DSH 不读 settings.yaml 的这一节
  assert.ok(!/takes effect for new sessions/.test(text), 'must not claim the switch takes effect');
  assert.match(text, /不会改变默认模型/);
  assert.match(text, /settings\.yaml/);
  // 必须给出可直接粘贴进 profile patch 的行
  assert.match(text, /- id: agent-default-model/);
  assert.match(text, /provider: commandcode/);
  assert.match(text, /model: deepseek\/deepseek-v4\.1-flash/);
  assert.match(text, /reasoningEffort: max/);
  assert.equal(
    patchRowFor({ provider: 'x', model: 'y', reasoningEffort: 'high' }),
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
