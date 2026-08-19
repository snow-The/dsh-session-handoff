/**
 * dsh-session-handoff — provider failover (auto route switching).
 *
 * The user maintains an ordered priority list of provider routes
 * (`session-handoff.failoverRoutes: a,b,c` in settings.yaml — the order IS
 * the priority). When a model request fails because the current provider is
 * unreachable or out of quota — NOT because the user interrupted — the next
 * provider in the list is tried automatically and the step continues.
 *
 * Wiring (official dsh-llm / dsh-agent-loop extension points):
 *
 *   1. `agent/request-error` (waterfall): fired when a request stream ends in
 *      `finish.kind === "error"`. Returning `{ kind: "retry" }` makes the
 *      agent loop `continue` its step loop and rebuild the request.
 *      Aborted signals (user interrupts) are never failed over.
 *   2. `agent/request` (waterfall): fired inside buildRequest before the LLM
 *      call; its return value is the seed call config
 *      `{ provider, model, ... }` and `prepareCall(config)` rebinds the
 *      adapter for that provider. We override `provider` with the chosen
 *      fallback (model is preserved — every route serves the same model).
 *
 * Failover codes are the dsh-llm provider-neutral taxonomy (LlmError.code):
 * quota exhausted, rate limited, upstream server/transport failures, empty
 * degenerate responses, bad credentials and unregistered adapters. Context
 * overflow is deliberately NOT failed over (switching providers does not
 * shrink the transcript). Unknown codes are left alone.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECTION = 'session-handoff';

/** LlmError codes that trigger provider failover (see module doc). */
export const FAILOVER_CODES = Object.freeze([
  'QUOTA',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'AUTH',
  'INVALID_CREDENTIAL',
  'NO_ADAPTER',
]);

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function settingsPath() {
  return join(dshHome(), 'settings.yaml');
}

/**
 * Parse one failover route entry: `provider[:model[:effort]]`.
 * provider is required; model and effort (reasoning effort, e.g. max/high)
 * are optional — when set, failover overrides the seed's model/effort.
 * @param {string} str
 * @returns {{provider: string, model?: string, effort?: string}|null}
 */
export function parseFailoverEntry(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  const [provider, model, effort] = s.split(':').map((x) => (x ?? '').trim());
  if (!provider) return null;
  const entry = { provider };
  if (model) entry.model = model;
  if (effort) entry.effort = effort;
  return entry;
}

/** Format one route entry back to the `provider[:model[:effort]]` string. */
export function formatFailoverEntry(entry) {
  const e = entry ?? {};
  const parts = [e.provider ?? ''];
  if (e.model) parts.push(e.model);
  if (e.effort) parts.push(e.effort);
  return parts.join(':');
}

/**
 * Pick the first route that has not been tried yet.
 * @param {Array} routes - ordered priority list of entries
 *   ({ provider, model?, effort? }; first = highest priority).
 * @param {Set<string>} tried - set of provider names already attempted.
 * @returns the next entry object, or null when every route was tried.
 */
export function pickNextProvider(routes, tried) {
  for (const entry of routes) {
    if (!tried.has(entry.provider)) return entry;
  }
  return null;
}

/** Read the ordered failover route list ([] when disabled) as entry objects. */
export async function readFailoverRoutes() {
  let text = '';
  try {
    text = await readFile(settingsPath(), 'utf8');
  } catch {
    return [];
  }
  const re = new RegExp(`^${SECTION}:\\s*$[\\s\\S]*?(?=\\n\\S[^:]*:|\\n$)`, 'm');
  const m = text.match(re);
  if (m == null) return [];
  const kv = m[0].match(/^\s{2}failoverRoutes:\s*(.+)$/m);
  if (kv == null) return [];
  return String(kv[1])
    .trim()
    .split(',')
    .map((s) => s.trim())
    .map(parseFailoverEntry)
    .filter((e) => e !== null);
}

/**
 * Persist the ordered failover route list into settings.yaml's
 * `session-handoff:` section (single comma-separated line; order = priority).
 * Accepts strings (`provider[:model[:effort]]`) or entry objects.
 * Passing an empty array disables failover and removes the line.
 * @returns the saved entries as objects.
 */
export async function writeFailoverRoutes(providers) {
  const path = settingsPath();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch { /* create fresh */ }
  const entries = (providers ?? [])
    .map((p) => (typeof p === 'string' ? parseFailoverEntry(p) : p))
    .filter((e) => e !== null && typeof e?.provider === 'string' && e.provider.length > 0);
  const line = `  failoverRoutes: ${entries.map(formatFailoverEntry).join(',')}`;
  const re = new RegExp(`^${SECTION}:\\s*$[\\s\\S]*?(?=\\n\\S[^:]*:|\\n$)`, 'm');
  const match = text.match(re);
  if (match != null) {
    // Drop the previous failoverRoutes line (if any), then append the new one.
    const block = match[0].replace(/^\s{2}failoverRoutes:.*$/m, '').replace(/\s+$/, '');
    const next = entries.length > 0 ? `${block}\n${line}` : block;
    text = text.replace(re, next);
  } else if (entries.length > 0) {
    text = text.trimEnd() + `\n${SECTION}:\n${line}\n`;
  }
  await writeFile(path, text, 'utf8');
  return entries;
}

/**
 * Install the two failover listeners. Returns a disposer.
 * Safe to call even when the agents service is absent (no-op).
 */
export function installFailover(ctx) {
  if (typeof ctx.on !== 'function') return () => {};
  const pending = new Map();
  const keyOf = (agent, turn, step) => `${agent?.id ?? agent?.session ?? '?'}:${turn}:${step}`;
  // Tried-sets must survive the error → request → error cycle, so a second
  // failure moves to the NEXT route (A→B→C), not back to A. Entries are
  // pruned after a TTL to bound memory on long sessions.
  const TTL = 10 * 60 * 1000;
  function prunePending() {
    const now = Date.now();
    for (const [k, s] of pending) {
      if (now - (s.at ?? 0) > TTL) pending.delete(k);
    }
  }

  const disposeError = ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    // User interrupt / cancellation — never failed over.
    if (signal?.aborted === true) return next();
    const code = failure?.code;
    if (typeof code !== 'string' || !FAILOVER_CODES.includes(code)) return next();
    prunePending();
    let routes = [];
    try {
      routes = await readFailoverRoutes();
    } catch { /* settings unreadable → no failover */ }
    if (routes.length === 0) return next();
    const key = keyOf(agent, turn, step);
    const state = pending.get(key) ?? { tried: new Set(), at: Date.now() };
    state.tried.add(provider);
    const nextProvider = pickNextProvider(routes, state.tried);
    if (nextProvider === null) {
      pending.delete(key);
      return next(); // every route failed — surface the original error
    }
    state.next = nextProvider;
    state.at = Date.now();
    pending.set(key, state);
    try {
      agent?.session?.append?.('llm/failover', {
        turn,
        step,
        from: provider,
        to: nextProvider.provider,
        code,
        message: failure?.message ?? '',
      });
    } catch { /* observability only */ }
    ctx.logger?.info?.(`[dsh-session-handoff] failover ${provider} → ${nextProvider.provider} (${code})`);
    return { kind: 'retry' };
  });

  const disposeRequest = ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const key = keyOf(agent, turn, step);
    const state = pending.get(key);
    if (state === undefined || state.next === undefined) return next();
    // NOTE: keep the entry — the tried-set must persist so a subsequent
    // failure on the fallback advances to the next route, not back to the
    // first. It is pruned by TTL and on all-routes-tried.
    const seed = await next();
    if (seed === undefined || seed === null) return seed;
    const out = { ...seed, provider: state.next.provider };
    // Per-route overrides: when the entry pins a model / reasoning effort,
    // apply it to the rebuilt request (true cross-model failover).
    if (state.next.model) out.model = state.next.model;
    if (state.next.effort) out.reasoningEffort = state.next.effort;
    return out;
  });

  return () => {
    try { disposeError?.(); } catch { /* already disposed */ }
    try { disposeRequest?.(); } catch { /* already disposed */ }
  };
}

export function registerFailoverTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'failover_config',
    description: 'Show the failover priority list (ordered; each entry `provider[:model[:effort]]`). Empty = failover disabled. Routes are switched automatically when the active provider is unreachable or out of quota (never on user interruption).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const routes = await readFailoverRoutes();
      if (routes.length === 0) {
        return 'Failover disabled (no routes configured).\n\nSet an ordered list with failover_set, e.g. providers: ["deepseek:deepseek-v4-flash:max", "deepseek-official"].';
      }
      return [
        'Failover priority list (first = highest; model/effort optional overrides):',
        ...routes.map((e, i) => `  ${i + 1}. ${formatFailoverEntry(e)}`),
        '',
        'On QUOTA / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / AUTH / credential / adapter errors the next route is tried automatically. User interrupts never fail over.',
      ].join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'failover_set',
    description: 'Set the failover priority list (order = priority). Each entry is `provider` or `provider:model` or `provider:model:effort`. Pass an empty array to disable failover. Persisted to settings.yaml `session-handoff.failoverRoutes`.',
    parameters: {
      providers: { type: 'array', items: { type: 'string' }, description: 'Ordered route entries, first = highest priority (e.g. "deepseek:deepseek-v4-flash:max")' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const valid = await writeFailoverRoutes(args?.providers ?? []);
      if (valid.length === 0) return 'Failover disabled (empty list saved).';
      return [
        'Failover priority list saved:',
        ...valid.map((e, i) => `  ${i + 1}. ${formatFailoverEntry(e)}`),
        '',
        'Takes effect immediately for new requests.',
      ].join('\n');
    },
  }));
}

export const __internals = { pickNextProvider, readFailoverRoutes, writeFailoverRoutes, parseFailoverEntry, formatFailoverEntry };
