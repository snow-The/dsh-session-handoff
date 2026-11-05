/**
 * dsh-session-handoff — model route management (any registered route).
 *
 * Every registered provider route — from the live llm directory, from
 * settings.yaml `llm-pi-ai.providers.*`, or the two built-ins — is a
 * first-class route the user can order, switch to, and fail over to.
 * There is no single fixed model id: whatever the chat dialog is using is
 * preserved when switching.
 *   model_routes — list every registered route: provider, baseURL, key env +
 *                  family, vision wrapper variant, default status
 *   model_switch — point agent-default-model at a route (persisted in
 *                  settings.yaml; next sessions use it)
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

/** Probe a credential ref WITHOUT pretending to resolve it.
 *
 * Layered like the host: process env wins, then `.credentials.yaml` refs.
 * But a ref that exists only in the managed store is **not** something this
 * tool can read — the values there are opaque. Returning 'missing' for that
 * case (the old behaviour) was a lie: it turned "I cannot see it" into "it is
 * not there", which is the exact confusion this file exists to remove.
 *
 * @returns {{state: 'env'|'stored'|'missing'|'undeclared', prefix?: string}}
 */
function keyProbe(keyName) {
  if (!keyName) return { state: 'undeclared' };
  const env = process.env[keyName];
  if (env) return { state: 'env', prefix: env.slice(0, 3) };
  const cred = readFileSyncSafe(join(dshHome(), '.credentials.yaml'));
  const line = cred.split('\n').find((l) => l.trim().startsWith(keyName + ':'));
  if (line) return { state: 'stored' };
  return { state: 'missing' };
}
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Enumerate every provider route the host can actually serve.
 *
 * `registered` MEANS "the host's llm directory has an adapter for it" — that is
 * literally what `llm.listProviders()` returns (`[...adapters.values()]`). The
 * previous version derived it from settings.yaml's `llm-pi-ai.providers.*`
 * models list, so any route that came from a **profile patch row** (or from any
 * config surface other than settings.yaml) was listed — because the live
 * directory knew it — and then declared `registered: false` in the same breath.
 * A tool that contradicts itself is worse than no tool.
 *
 * Extra config facts (baseURL / apiKeyEnv / models) are taken from the live
 * provider metadata first, then from settings.yaml, then from the two built-ins.
 *
 * @param ctx - plugin context (for the llm service).
 * @param requestContext - the running session's requestContext(), if any:
 *   { provider, model, contextWindow } — the model last chosen in the dialog.
 */
function enumerateRoutes(ctx, requestContext) {
  const routes = [];
  const settings = readSettingsYaml(readFileSyncSafe(settingsPath()));
  const defaultProvider = settings.agentDefault.provider;
  const llm = ctx?.get?.('llm') ?? ctx?.llm;
  const entries = (llm?.listProviders?.() ?? []).filter((p) => p?.id);
  const live = new Map(entries.map((p) => [p.id, p]));
  const configured = Object.keys(settings.llmProviders);
  const builtins = ['deepseek-official', 'deepseek'];
  const names = [...new Set([...live.keys(), ...configured, ...builtins])];
  const BUILTIN_BASE = {
    'deepseek-official': 'https://api.deepseek.com',
    deepseek: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  };
  const BUILTIN_KEY = { 'deepseek-official': 'DEEPSEEK_API_KEY', deepseek: 'ARK_API_KEY' };
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const base = name.startsWith('vision-toolkit-') ? name.slice('vision-toolkit-'.length) : name;
    const entry = live.get(name) ?? live.get(base);
    const p = settings.llmProviders[base];
    const isBuiltin = BUILTIN_BASE[base] != null && p == null;
    const routeModels = p?.models ?? entry?.models ?? [];
    // registered: live adapter > built-in > a settings block that declares models.
    const registered = entry != null || isBuiltin || routeModels.length > 0;
    const baseURL = entry?.baseURL ?? p?.baseURL ?? (isBuiltin ? BUILTIN_BASE[base] : null);
    const keyEnv = entry?.apiKeyEnv ?? p?.apiKeyEnv ?? (isBuiltin ? BUILTIN_KEY[base] : undefined);
    const probe = keyProbe(keyEnv);
    const keyFamily = probe.state === 'env' ? (probe.prefix.startsWith('ark') ? 'ark' : probe.prefix.startsWith('sk') ? 'official' : probe.prefix) : probe.state;
    const inUse = requestContext != null && (requestContext.provider === name || (name === base && requestContext.provider === `vision-toolkit-${base}`));
    routes.push({
      provider: name,
      baseURL: baseURL ?? null,
      keyEnv: keyEnv ?? null,
      keyFamily,
      keyState: probe.state,
      servesModel: registered,
      registered,
      source: entry != null ? 'live' : isBuiltin ? 'builtin' : 'settings',
      models: routeModels,
      default: defaultProvider === name || defaultProvider === `vision-toolkit-${base}`,
      inUse: inUse === true,
      currentModel: inUse && requestContext ? requestContext.model : undefined,
      vision: name.startsWith('vision-toolkit-'),
      note: name.startsWith('vision-toolkit-') ? 'vision wrapper' : (isBuiltin ? 'built-in route' : entry != null ? 'registered route (config not in settings.yaml)' : 'configured route'),
    });
  }
  return routes;
}

/**
 * Point agent-default-model at one route and persist it to settings.yaml.
 * Shared by the model_switch tool and the web client route. The model and
 * reasoning effort are preserved from the current default unless explicitly
 * overridden via opts ({ model, reasoningEffort }) — the plugin is not tied
 * to a single model id or effort. Does NOT invent a vision wrapper — if the
 * user picked a vision-toolkit-* provider (from the chat model list) that
 * exact provider is used as-is.
 */
async function switchProvider(ctx, provider, opts = {}) {
  const target = String(provider ?? '').trim();
  const routes = enumerateRoutes(ctx);
  const route = routes.find((r) => r.provider === target);
  if (route == null) {
    const available = routes.map((r) => r.provider).join(', ');
    throw new Error(`unknown provider "${target}"; available: ${available}`);
  }
  const effective = route.provider;
  const path = settingsPath();
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  // Preserve model + effort currently selected for the default route unless
  // explicitly overridden (any model, any effort — nothing hard-coded).
  const current = readSettingsYaml(readFileSyncSafe(path)).agentDefault;
  const model = opts.model || current.model;
  const effort = opts.reasoningEffort || current.reasoningEffort || 'max';
  const lines = ['agent-default-model:', `  provider: ${effective}`];
  if (model) lines.push(`  model: ${model}`);
  lines.push(`  reasoningEffort: ${effort}`, '');
  const newBlock = lines.join('\n');
  // Replace or insert the agent-default-model block.
  const blockRe = /^agent-default-model:\s*$[\s\S]*?(?=\n\S[^:]*:|\n$)/m;
  if (blockRe.test(text)) {
    text = text.replace(blockRe, newBlock.trimEnd());
  } else {
    text = text.trimEnd() + '\n' + newBlock;
  }
  await writeFile(path, text, 'utf8');
  return { route, provider: effective, model, reasoningEffort: effort };
}

function registerModelRoutesTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'model_routes',
    description: 'List every registered model route: provider, baseURL, key env + family (ark-/sk-), whether it is the default, and whether it is a vision wrapper. Any registered route can be ordered, switched to, and failed over to — no model id is hard-coded.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const routes = enumerateRoutes(ctx);
      const KEY_NOTE = {
        env: '从环境变量读到',
        stored: '托管存储里有这条 ref，本工具不解析其值',
        missing: '环境与托管存储里都没有',
        undeclared: 'provider 没有申报 apiKeyEnv',
      };
      const lines = ['Registered model routes:', ''];
      for (const r of routes) {
        lines.push(`${r.default ? '*' : ' '} ${r.provider}`);
        lines.push(`    baseURL: ${r.baseURL ?? '(unset)'}`);
        lines.push(`    key: ${r.keyEnv ?? '(provider 未申报)'} [${r.keyFamily}] — ${KEY_NOTE[r.keyState] ?? r.keyState}`);
        lines.push(`    registered: ${r.registered} (source: ${r.source})`);
        lines.push(`    vision wrapper: ${r.vision}`);
        lines.push(`    ${r.note}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'model_switch',
    description: 'Point agent-default-model at one registered route (e.g. deepseek for the Ark plan, deepseek-official for the official API, or a vision-toolkit-* wrapper the chat model list offers). Model and reasoning effort are preserved from the current default unless explicitly overridden (model / reasoningEffort params). Writes the legacy $DSH_HOME/settings.yaml AND prints the profile-patch row the running host actually reads — settings.yaml is a removed surface in current DSH, so the write alone does NOT change the default model. No vision model is configured here: the chat dialog\'s own model list (incl. vision-toolkit wrappers) is the source of truth.',
    parameters: {
      provider: { type: 'string', required: true, description: 'Provider name from model_routes (e.g. deepseek, deepseek-official, vision-toolkit-deepseek)' },
      model: { type: 'string', description: 'Optional model id to pin (default: keep the current default model)' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort to pin (max/high/medium/low/none; default: keep the current effort)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const { route, provider, model, reasoningEffort } = await switchProvider(ctx, args?.provider, {
        model: args?.model,
        reasoningEffort: args?.reasoningEffort,
      });
      const keyWarn = route.keyFamily === '(missing)' || route.keyFamily === 'unknown'
        ? `\nWARNING: no key found for ${route.keyEnv} — the route will 401 until a key is set.`
        : '';
      return formatSwitchReport({ provider, model, reasoningEffort, route, keyWarn });
    },
  }));
}

/** The exact patch row the user needs, so a switch is one paste instead of a guess. */
function patchRowFor({ provider, model, reasoningEffort }) {
	return [
		'- id: agent-default-model',
		"  name: '@deepseek-ai/dsh-agent-default-model'",
		'  config:',
		`    provider: ${provider}`,
		...(model ? [`    model: ${model}`] : []),
		`    reasoningEffort: ${reasoningEffort ?? 'max'}`,
	].join('\n');
}

/**
 * Build the switch report — and say the truth about where the value lands.
 *
 * 2026-11-05: `settings.yaml` is a REMOVED surface in current DSH (`dsh-settings` keeps it only in a
 * migration path), the profile's patch file is the durable one
 * (`dsh-plugin-manager` writes `profile.patchPath`), and `agent-default-model` reads its own plugin
 * config — never settings.yaml. So the write below does NOT change the default model, and a report
 * claiming "takes effect for new sessions" would be a lie with a green checkmark.
 */
function formatSwitchReport({ provider, model, reasoningEffort, route, keyWarn }) {
	return [
		`agent-default-model -> ${provider} (${route?.baseURL ?? '?'})`,
		`model: ${model ?? '(unset)'}   reasoningEffort: ${reasoningEffort ?? '(unset)'}`,
		`key: ${route?.keyEnv ?? '(provider 未申报)'} [${route?.keyFamily ?? 'unknown'}]`,
		'',
		'⚠ 已写入 $DSH_HOME/settings.yaml，但**当前 DSH 不读这个文件**：',
		'  它在 dsh-settings 里只剩迁移路径（removed），配置的归属是 profile 的 patch 层；',
		'  而 agent-default-model 只读自己的插件 config。**所以这次写入不会改变默认模型。**',
		'',
		'  要真的换，把下面这段放进 profile 的 cordis.patch.yml（替换同 id 的行）并重启宿主：',
		'',
		patchRowFor({ provider, model, reasoningEffort }),
		'',
		'  验证：dsh --profile web --dump-config  然后看 agent-default-model 的 provider',
		keyWarn,
	].filter(Boolean).join('\n');
}

export { registerModelRoutesTools };
export { readSettingsYaml, enumerateRoutes, switchProvider, patchRowFor, formatSwitchReport };
