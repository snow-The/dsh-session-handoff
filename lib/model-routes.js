/**
 * dsh-session-handoff — model route management (any registered route).
 *
 * `model_routes` — list every route the host can actually serve: provider,
 *                  baseURL, key env + family, vision wrapper, default marker.
 * `model_switch` — point `agent-default-model` at one of them, for real.
 *
 * WHERE THE VALUE LIVES (verified 2026-11-05 against the shipped host):
 *   • `agent-default-model` reads `this.config.provider.get()` — its own plugin
 *     config, never `$DSH_HOME/settings.yaml`.
 *   • `$DSH_HOME/settings.yaml` is a removed surface in current DSH: the only
 *     code that still touches it is `dsh-settings`' migration path ("removed /
 *     move into the active profile"). Nothing reads our write there.
 *   • The durable config surface is the active profile's patch file, and the
 *     host owns writing it: `ctx.configEditor.edit(entry, change)` takes the
 *     profile lock (`withFileLock` on the profile's package.json), edits a
 *     `yaml` document (not regenerated text), writes atomically, reconciles the
 *     Loader and rolls the file back if reconciliation fails.
 *
 * So this module does what an honest client does: hand the change to the owner
 * of the file instead of re-implementing its lock, and then READ THE RESULT
 * BACK — a switch that cannot show itself applied is reported as not applied.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT_DEFAULT_ID = 'agent-default-model';
const AGENT_DEFAULT_PLUGIN = '@deepseek-ai/dsh-agent-default-model';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
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
 * Find the owner of the `agent-default-model` config: the host's config editor
 * service plus the Loader entry for that plugin.
 *
 * `configEditor.entries()` lists the addressable profile rows — the same rows
 * the host itself edits, so we never invent a second notion of "the file".
 *
 * @returns {{editor: object, entry: object|null}|null} null when the host does
 *   not expose the service (an old host — this plugin supports only the current
 *   one, and a caller deserves to be told rather than silently mis-written).
 */
function agentDefaultOwner(ctx) {
  const editor = ctx?.get?.('configEditor') ?? ctx?.configEditor;
  if (editor == null || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') return null;
  const entry = (editor.entries() ?? []).find(
    (row) => row?.options?.id === AGENT_DEFAULT_ID || row?.options?.name === AGENT_DEFAULT_PLUGIN,
  );
  return { editor, entry: entry ?? null };
}

/**
 * The default route as the running host actually holds it.
 *
 * `source` is deliberately part of the answer: 'live-config' means it came from
 * the plugin that consumes it, 'no-entry' means the profile has no such row,
 * 'no-editor' means the host cannot be asked at all. Anything else would be a
 * guess dressed as a reading.
 */
function readAgentDefault(ctx) {
  const owner = agentDefaultOwner(ctx);
  const config = owner?.entry?.options?.config ?? {};
  return {
    provider: typeof config.provider === 'string' ? config.provider : undefined,
    model: typeof config.model === 'string' ? config.model : undefined,
    reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
    source: owner == null ? 'no-editor' : owner.entry == null ? 'no-entry' : 'live-config',
    patchPath: owner?.editor?.documentPath ?? null,
  };
}

/**
 * Enumerate every provider route the host can actually serve.
 *
 * `registered` MEANS "the host's llm directory has an adapter for it" — that is
 * literally what `llm.listProviders()` returns (`[...adapters.values()]`). The
 * previous version derived it from settings.yaml's `llm-pi-ai.providers.*`
 * models list, so any route that came from a **profile patch row** was listed —
 * because the live directory knew it — and then declared `registered: false` in
 * the same breath. A tool that contradicts itself is worse than no tool.
 *
 * `default` comes from the same place the default is consumed: the live
 * `agent-default-model` config. It used to come from settings.yaml, which is
 * how the marker quietly moved off the model in use.
 *
 * @param ctx - plugin context (for the llm + configEditor services).
 * @param requestContext - the running session's requestContext(), if any:
 *   { provider, model, contextWindow } — the model last chosen in the dialog.
 */
function enumerateRoutes(ctx, requestContext) {
  const routes = [];
  const agentDefault = readAgentDefault(ctx);
  const defaultProvider = agentDefault.provider;
  const llm = ctx?.get?.('llm') ?? ctx?.llm;
  const entries = (llm?.listProviders?.() ?? []).filter((p) => p?.id);
  const live = new Map(entries.map((p) => [p.id, p]));
  const builtins = ['deepseek-official', 'deepseek'];
  const names = [...new Set([...live.keys(), ...builtins])];
  const BUILTIN_BASE = {
    'deepseek-official': 'https://api.deepseek.com',
    deepseek: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  };
  const BUILTIN_KEY = { 'deepseek-official': 'DEEPSEEK_API_KEY', deepseek: 'ARK_API_KEY' };
  for (const name of names) {
    const base = name.startsWith('vision-toolkit-') ? name.slice('vision-toolkit-'.length) : name;
    const entry = live.get(name) ?? live.get(base);
    // The two host built-in routes keep their known auth/base even though the
    // adapter object does not expose them: a route the host can serve must not
    // look keyless just because the adapter is quiet. An adapter value always
    // wins over the table.
    const builtinBase = BUILTIN_BASE[base] ?? null;
    const builtinKey = BUILTIN_KEY[base];
    const registered = entry != null || builtinBase != null;
    const baseURL = entry?.baseURL ?? builtinBase;
    const keyEnv = entry?.apiKeyEnv ?? builtinKey;
    const probe = keyProbe(keyEnv);
    const keyFamily = probe.state === 'env' ? (probe.prefix.startsWith('ark') ? 'ark' : probe.prefix.startsWith('sk') ? 'official' : probe.prefix) : probe.state;
    const inUse = requestContext != null && (requestContext.provider === name || (name === base && requestContext.provider === `vision-toolkit-${base}`));
    routes.push({
      provider: name,
      baseURL: baseURL ?? null,
      keyEnv: keyEnv ?? null,
      keyFamily,
      keyState: probe.state,
      registered,
      source: entry != null ? 'live' : 'builtin',
      models: entry?.models ?? [],
      default: defaultProvider === name || defaultProvider === `vision-toolkit-${base}`,
      inUse: inUse === true,
      currentModel: inUse && requestContext ? requestContext.model : undefined,
      vision: name.startsWith('vision-toolkit-'),
      note: name.startsWith('vision-toolkit-')
        ? 'vision wrapper'
        : entry == null
          ? 'built-in route (no live adapter)'
          : builtinBase != null
            ? 'registered route (host built-in name)'
            : 'registered route (from a profile patch row)',
    });
  }
  return routes;
}

/**
 * Point `agent-default-model` at one route — the real write, through the host.
 *
 * The change is derived from the entry's CURRENT config (so unrelated fields
 * survive) and handed to `configEditor.edit`, which owns the profile lock, the
 * document model, the atomic write, the Loader reconcile and the rollback.
 * Afterwards the live config is read back: if it does not carry what we asked
 * for, this throws instead of printing a green checkmark.
 *
 * Model and effort are preserved from the current default unless explicitly
 * overridden via opts ({ model, reasoningEffort }) — nothing is hard-coded.
 */
async function switchProvider(ctx, provider, opts = {}) {
  const target = String(provider ?? '').trim();
  const routes = enumerateRoutes(ctx);
  const route = routes.find((r) => r.provider === target);
  if (route == null) {
    throw new Error(`unknown provider "${target}"; available: ${routes.map((r) => r.provider).join(', ')}`);
  }
  const owner = agentDefaultOwner(ctx);
  if (owner == null) {
    throw new Error('this host exposes no `configEditor` service, so the profile patch cannot be written from here; the profile patch is the only surface the running host reads for agent-default-model.');
  }
  if (owner.entry == null) {
    throw new Error(`the active profile has no \`${AGENT_DEFAULT_ID}\` row, so there is no config to point at \`${route.provider}\`. Add this row once, then switch freely:\n${patchRowFor({ provider: route.provider, model: opts.model, reasoningEffort: opts.reasoningEffort })}`);
  }
  const before = readAgentDefault(ctx);
  const model = opts.model || before.model;
  const reasoningEffort = opts.reasoningEffort || before.reasoningEffort || 'max';
  const wanted = { provider: route.provider, reasoningEffort };
  if (model) wanted.model = model;

  await owner.editor.edit(owner.entry, (config) => ({ ...config, ...wanted }));

  const after = readAgentDefault(ctx);
  const drifted = ['provider', 'model', 'reasoningEffort'].filter((key) => wanted[key] != null && after[key] !== wanted[key]);
  if (drifted.length > 0) {
    throw new Error(
      `the patch was written but the live config does not show it (${drifted
        .map((key) => `${key}: wanted ${wanted[key]}, live ${after[key] ?? '(unset)'}`)
        .join('; ')}). Patch: ${owner.editor.documentPath}`,
    );
  }
  return { route, provider: after.provider, model: after.model, reasoningEffort: after.reasoningEffort, previous: before, patchPath: owner.editor.documentPath };
}

function registerModelRoutesTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'model_routes',
    description: 'List every route the host can actually serve: provider, baseURL, key env + family (ark-/sk-), whether it is the default (read from the live agent-default-model config, not from settings.yaml), and whether it is a vision wrapper. Any registered route can be ordered, switched to, and failed over to — no model id is hard-coded.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const routes = enumerateRoutes(ctx);
      const agentDefault = readAgentDefault(ctx);
      const KEY_NOTE = {
        env: '从环境变量读到',
        stored: '托管存储里有这条 ref，本工具不解析其值',
        missing: '环境与托管存储里都没有',
        undeclared: 'provider 没有申报 apiKeyEnv',
      };
      const lines = [
        'Registered model routes:',
        `default (agent-default-model, source: ${agentDefault.source}): ${agentDefault.provider ?? '(unset)'} / ${agentDefault.model ?? '(unset)'} / ${agentDefault.reasoningEffort ?? '(unset)'}`,
        agentDefault.patchPath ? `profile patch: ${agentDefault.patchPath}` : 'profile patch: (unknown — no configEditor service)',
        '',
      ];
      for (const r of routes) {
        lines.push(`${r.default ? '*' : ' '} ${r.provider}`);
        lines.push(`    baseURL: ${r.baseURL ?? '(unset)'}`);
        lines.push(`    key: ${r.keyEnv ?? '(provider 未申报)'} [${r.keyFamily}] — ${KEY_NOTE[r.keyState] ?? r.keyState}`);
        lines.push(`    registered: ${r.registered} (source: ${r.source})`);
        lines.push(`    vision wrapper: ${r.vision}`);
        lines.push(`    ${r.inUse ? `in use by this chat: ${r.currentModel ?? '(model unknown)'}` : r.note}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'model_switch',
    description: 'Point agent-default-model at one route (e.g. deepseek for the Ark plan, deepseek-official for the official API, or a vision-toolkit-* wrapper the chat model list offers). Model and reasoning effort are preserved from the current default unless explicitly overridden (model / reasoningEffort params). Writes the ACTIVE PROFILE PATCH through the host\'s own configEditor (profile lock + document edit + atomic write + Loader reconcile + rollback on failure), so this is a real, persisted switch — and it reads the live config back, so a switch that did not take is reported as failed, never as done. No vision model is configured here: the chat dialog\'s own model list (incl. vision-toolkit wrappers) is the source of truth.',
    parameters: {
      provider: { type: 'string', required: true, description: 'Provider name from model_routes (e.g. deepseek, deepseek-official, vision-toolkit-deepseek)' },
      model: { type: 'string', description: 'Optional model id to pin (default: keep the current default model)' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort to pin (max/high/medium/low/none; default: keep the current effort)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const result = await switchProvider(ctx, args?.provider, {
        model: args?.model,
        reasoningEffort: args?.reasoningEffort,
      });
      return formatSwitchReport(result);
    },
  }));
}

/** The row a profile needs when it has none — so the fix is one paste, not a guess. */
function patchRowFor({ provider, model, reasoningEffort }) {
  return [
    '- id: agent-default-model',
    `  name: '${AGENT_DEFAULT_PLUGIN}'`,
    '  config:',
    `    provider: ${provider}`,
    ...(model ? [`    model: ${model}`] : []),
    `    reasoningEffort: ${reasoningEffort ?? 'max'}`,
  ].join('\n');
}

/**
 * Build the switch report — and say the truth about where the value landed.
 *
 * 2026-11-05: `$DSH_HOME/settings.yaml` is a REMOVED surface in current DSH
 * (`dsh-settings` keeps it only in a migration path), the profile's patch file
 * is the durable one (`dsh-plugin-manager` writes `profile.patchPath`), and
 * `agent-default-model` reads its own plugin config — never settings.yaml.
 * Writing settings.yaml therefore changed nothing while the report claimed
 * "takes effect for new sessions": a lie with a green checkmark. This report
 * only states what was read back from the live config, and names the file.
 */
function formatSwitchReport({ provider, model, reasoningEffort, route, previous, patchPath }) {
  const moved = [['provider', previous?.provider, provider], ['model', previous?.model, model], ['reasoningEffort', previous?.reasoningEffort, reasoningEffort]]
    .filter(([, was, now]) => was !== now);
  return [
    `agent-default-model -> ${provider} (${route?.baseURL ?? '?'})`,
    `model: ${model ?? '(unset)'}   reasoningEffort: ${reasoningEffort ?? '(unset)'}`,
    `key: ${route?.keyEnv ?? '(provider 未申报)'} [${route?.keyFamily ?? 'unknown'}]`,
    '',
    `wrote: ${patchPath ?? '(profile patch path unknown)'}`,
    moved.length > 0
      ? `changed: ${moved.map(([field, was, now]) => `${field} ${was ?? '(unset)'} -> ${now ?? '(unset)'}`).join(', ')}`
      : 'changed: nothing (the config already held these values)',
    'applied: verified by reading the live agent-default-model config back after the write.',
    'surface: the profile patch — settings.yaml is NOT involved (it is a removed surface and nothing reads it).',
  ].join('\n');
}

export { registerModelRoutesTools };
export { agentDefaultOwner, readAgentDefault, enumerateRoutes, switchProvider, patchRowFor, formatSwitchReport };
