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
        - id: deepseek-v4-flash
          name: DeepSeek V4 Flash(ARK)
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro(ARK)
      apiKeyEnv: ARK_API_KEY
agent-default-model:
  provider: vision-toolkit-deepseek-official
  model: deepseek-v4-flash
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
  assert.ok(parsed.llmProviders.deepseek.models.includes('deepseek-v4-flash'));
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
  const routes = enumerateRoutes(ctx, { provider: 'vision-toolkit-deepseek', model: 'deepseek-v4-flash', contextWindow: 1000000 });
  const wrapped = routes.find((r) => r.provider === 'vision-toolkit-deepseek');
  assert.ok(wrapped, 'vision wrapper appears in the route list (chat model list)');
  assert.equal(wrapped.inUse, true, 'wrapper is the in-use chat model');
  assert.equal(wrapped.currentModel, 'deepseek-v4-flash');
  assert.equal(wrapped.vision, true);
  const raw = routes.find((r) => r.provider === 'deepseek');
  assert.equal(raw.inUse, true, 'raw route is also marked when its wrapper is in use');
});

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true });
});
