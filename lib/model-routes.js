/**
 * dsh-session-handoff — model route management (same model, many vendors).
 *
 * For people who share one model id (e.g. deepseek-v4-flash) across several
 * vendors/plans — official API, Volcano Ark, etc.:
 *   model_routes — list every route that serves the model: provider, baseURL,
 *                  key env + family, vision wrapper variant, default status
 *   model_switch — point agent-default-model at a route (persisted in
 *                  settings.yaml; next sessions use it) and report whether a
 *                  vision-wrapper variant should be selected instead
 *
 * Reads/writes ~/.dsh/settings.yaml directly (tiny YAML surface we control);
 * the dsh-undo-savepoint plugin snapshots config changes automatically.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const MODEL_ID = 'deepseek-v4-flash';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function settingsPath() {
  return join(dshHome(), 'settings.yaml');
}

/** Very small YAML reader for the settings surface we care about. */
function readSettingsYaml(text) {
  const out = { llmProviders: {}, agentDefault: {} };
  // llm-pi-ai.providers.<name> blocks
  const piMatch = text.match(/^llm-pi-ai:\s*$[\s\S]*?^\s{2}providers:\s*$/m);
  let providersSection = '';
  if (piMatch) {
    const start = piMatch.index + piMatch[0].length;
    // until next top-level key (no indent)
    const next = text.slice(start).search(/\n\S[^:]*:/);
    providersSection = text.slice(start, next === -1 ? undefined : start + next);
  }
  // provider blocks: "    <name>:" with 4-space indent inside providers
  const providerRe = /^\s{4}([A-Za-z0-9_.-]+):\s*$/gm;
  let m;
  while ((m = providerRe.exec(providersSection))) {
    const name = m[1];
    const blockStart = m.index + m[0].length;
    // until next 4-space provider key or dedent
    const rest = providersSection.slice(blockStart);
    const nextKey = rest.search(/^\s{4}[A-Za-z0-9_.-]+:\s*$/m);
    const block = rest.slice(0, nextKey === -1 ? undefined : nextKey);
    const baseURL = block.match(/^\s+baseURL:\s*(.+)$/m)?.[1]?.trim();
    const apiKeyEnv = block.match(/^\s+apiKeyEnv:\s*(.+)$/m)?.[1]?.trim();
    const models = [...block.matchAll(/^\s+-\s+id:\s*([^\s]+)/gm)].map((x) => x[1]);
    out.llmProviders[name] = { baseURL, apiKeyEnv, models };
  }
  // agent-default-model block
  const admMatch = text.match(/^agent-default-model:\s*$[\s\S]*?(?=\n\S[^:]*:|\n$)/m);
  if (admMatch) {
    const block = admMatch[0];
    out.agentDefault = {
      provider: block.match(/^\s+provider:\s*(.+)$/m)?.[1]?.trim(),
      model: block.match(/^\s+model:\s*(.+)$/m)?.[1]?.trim(),
      reasoningEffort: block.match(/^\s+reasoningEffort:\s*(.+)$/m)?.[1]?.trim(),
    };
  }
  return out;
}

/** Resolve credential key values (prefix only — never leak full keys). */
function keyPrefix(keyName) {
  const env = process.env[keyName];
  if (env) return env.slice(0, 3);
  try {
    const cred = readFileSyncSafe(join(dshHome(), '.credentials.yaml'));
    const m = cred.match(new RegExp(`^${keyName}:\\s*(\\S+)`, 'm'));
    return m ? m[1].slice(0, 3) : undefined;
  } catch {
    return undefined;
  }
}
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Enumerate every route that serves MODEL_ID:
 * provider routes (settings) + the built-in deepseek-official route, each
 * with its vision-wrapper variant (vision-toolkit-<provider>).
 */
function enumerateRoutes(ctx) {
  const routes = [];
  const settings = readSettingsYaml(readFileSyncSafe(settingsPath()));
  const defaultProvider = settings.agentDefault.provider;
  const builtins = ['deepseek-official', 'deepseek'];
  const seen = new Set();
  for (const name of [...Object.keys(settings.llmProviders), ...builtins]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const p = settings.llmProviders[name];
    const isBuiltin = builtins.includes(name) && p == null;
    // A route serves the model when it declares it in settings, or when it is
    // a built-in route (pi-ai catalog serves deepseek-v4-flash there).
    const serves = isBuiltin || (p?.models?.includes(MODEL_ID) ?? false);
    const baseURL = isBuiltin
      ? (name === 'deepseek-official' ? 'https://api.deepseek.com' : 'https://ark.cn-beijing.volces.com/api/plan/v3')
      : p?.baseURL;
    const keyEnv = p?.apiKeyEnv ?? (name === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : 'ARK_API_KEY');
    const key = keyPrefix(keyEnv);
    const isArk = baseURL?.includes('ark.') ?? false;
    routes.push({
      provider: name,
      baseURL,
      keyEnv,
      keyFamily: key ? (key.startsWith('ark') ? 'ark' : key.startsWith('sk') ? 'official' : key) : '(missing)',
      servesModel: serves,
      default: defaultProvider === name || defaultProvider === `vision-toolkit-${name}`,
      visionVariant: `vision-toolkit-${name}`,
      note: isBuiltin ? 'built-in route' : 'configured route',
    });
  }
  return routes;
}

function registerModelRoutesTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'model_routes',
    description: `List every route that serves ${MODEL_ID}: provider, baseURL, key env + family (ark-/sk-), whether it is the default, and the vision-wrapper variant. Useful when sharing one model across vendors/plans.`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const routes = enumerateRoutes(ctx);
      const lines = ['Model routes for ' + MODEL_ID + ':', ''];
      for (const r of routes) {
        lines.push(`${r.default ? '*' : ' '} ${r.provider}`);
        lines.push(`    baseURL: ${r.baseURL ?? '(unset)'}`);
        lines.push(`    key: ${r.keyEnv} [${r.keyFamily}]`);
        lines.push(`    serves ${MODEL_ID}: ${r.servesModel}`);
        lines.push(`    vision variant: ${r.visionVariant}`);
        lines.push(`    ${r.note}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'model_switch',
    description: `Point agent-default-model at one of the routes serving ${MODEL_ID} (e.g. deepseek-official for the official API, deepseek for the Ark plan). Persists to settings.yaml — new sessions use it; the current session keeps its own selection. Recommend the vision variant when the route's provider has no image input.`,
    parameters: {
      provider: { type: 'string', required: true, description: 'Provider name from model_routes (e.g. deepseek-official, deepseek)' },
      vision: { type: 'boolean', description: 'Also switch to the vision wrapper variant (vision-toolkit-<provider>) if available' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const target = String(args.provider ?? '').trim();
      const routes = enumerateRoutes(ctx);
      const route = routes.find((r) => r.provider === target);
      if (route == null) {
        const available = routes.map((r) => r.provider).join(', ');
        throw new Error(`unknown provider "${target}"; available: ${available}`);
      }
      const useVision = args?.vision === true && route.visionVariant != null;
      const provider = useVision ? route.visionVariant : route.provider;
      const path = settingsPath();
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        text = '';
      }
      // Replace or insert the agent-default-model block.
      const blockRe = /^agent-default-model:\s*$[\s\S]*?(?=\n\S[^:]*:|\n$)/m;
      const newBlock = [
        'agent-default-model:',
        `  provider: ${provider}`,
        `  model: ${MODEL_ID}`,
        '  reasoningEffort: max',
        '',
      ].join('\n');
      if (blockRe.test(text)) {
        text = text.replace(blockRe, newBlock.trimEnd());
      } else {
        text = text.trimEnd() + '\n' + newBlock;
      }
      await writeFile(path, text, 'utf8');
      const keyWarn = route.keyFamily === '(missing)' || route.keyFamily === 'unknown'
        ? `\nWARNING: no key found for ${route.keyEnv} — the route will 401 until a key is set.`
        : '';
      return [
        `agent-default-model -> ${provider} (${route.baseURL ?? '?'})`,
        `key: ${route.keyEnv} [${route.keyFamily}]`,
        `takes effect for new sessions; this session keeps its own model selection.`,
        `vision wrapper: ${useVision ? 'enabled' : 'not used (pass vision:true to enable)'}`,
        keyWarn,
      ].filter(Boolean).join('\n');
    },
  }));
}

export { registerModelRoutesTools };
export { readSettingsYaml, enumerateRoutes };
