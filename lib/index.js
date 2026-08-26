/**
 * dsh-session-handoff — session handoff & context management for DSH.
 *
 * Module A (handoff): handoff_status / handoff_export / handoff_resume —
 *   structured session handoff. Parses the session event log into a portable
 *   Markdown handoff document (objective / progress / decisions / todos /
 *   key files) written to `<workspace>/.dsh-handoff/`. New sessions resume
 *   from it. Zero third-party dependencies.
 *
 * Module B (pruning): acp_status / acp_compress / acp_decompress /
 *   acp_search + a system-prompt pressure banner — active context pruning
 *   through the official compaction API (ctx.compaction.compactRegion) with
 *   model-authored summaries. Absorbed and refreshed from the 3-day-old
 *   active-context-pruning plugin (works against current DSH).
 *
 * Module C (soft enhance): OpenViking memory (viking_* tools) and archify
 *   (CLI/skill) are detected, never required. handoff_export reports which
 *   enhancers are available so the agent can use them if present.
 *
 * Core is node builtins + official DSH services only.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { registerSessionMgmtTools } from './session-mgmt.js';
import { registerModelRoutesTools, enumerateRoutes, switchProvider } from './model-routes.js';
import { registerAcpConfigTools, readAcpSection, readSection, writeAcpConfig } from './acp-config.js';
import { recommendThresholds } from './acp-recommend.js';
import { installFailover, registerFailoverTools, readFailoverRoutes, writeFailoverRoutes } from './failover.js';

export const name = 'dsh-session-handoff';

export const inject = ['tools', 'storageDomain', 'sessionPersistence', 'workspaceRegistry', 'agents', 'llm'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function eventText(event) {
  if (!event) return '';
  const d = event.data ?? {};
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const msg = d.message ?? d;
    const c = msg?.content;
    if (Array.isArray(c)) {
      return c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    }
    return typeof c === 'string' ? c : '';
  }
  if (event.type === 'tool/call') {
    return `${d.name ?? 'tool'}(${JSON.stringify(d.arguments ?? d.args ?? {})})`;
  }
  if (event.type === 'tool/result') {
    const t = typeof d.text === 'string' ? d.text : JSON.stringify(d).slice(0, 200);
    return String(t).slice(0, 300);
  }
  if (event.type === 'compaction/summary') {
    const s = d.summary ?? d;
    const text = Array.isArray(s) ? s.map((b) => b?.text ?? '').join('\n') : (s?.text ?? JSON.stringify(d).slice(0, 200));
    return `[compaction checkpoint] ${String(text).slice(0, 300)}`;
  }
  return '';
}

function requireAgent(exec) {
  if (exec?.agent?.session == null) throw new Error('handoff/acp tools need an active agent session');
  return exec.agent;
}

function sessionEvents(session) {
  const events = session?.events;
  if (events == null) return [];
  if (Array.isArray(events)) return events;
  if (typeof events[Symbol.iterator] === 'function') return [...events];
  return [];
}

function findWorkspace(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

const HANDOFF_DIR = '.dsh-handoff';

// ---------------------------------------------------------------------------
// Module A: handoff
// ---------------------------------------------------------------------------

/**
 * True when a user/message event is a system-injected banner rather than a
 * real user message: runtime-context snapshots, checkpoint condensations,
 * skill-catalog notices, system reminders, or empty text. These arrive as
 * user/message events in the session log and must not be captured as
 * "recent user objectives".
 */
function isInjectedUserMessage(text) {
  if (!text || !text.trim()) return true;
  if (text.includes('<system-reminder>')) return true;
  if (text.startsWith('This is an automatically generated checkpoint')) return true;
  if (text.startsWith('Current runtime context.')) return true;
  if (text.includes('This snapshot supersedes earlier runtime-context')) return true;
  if (text.includes('The available skill catalog changed')) return true;
  if (text.startsWith('Additional instructions from:')) return true;
  return false;
}

function summarizeEvents(events) {
  const stats = { turns: 0, userMsgs: 0, assistantMsgs: 0, toolCalls: 0, toolResults: 0, checkpoints: 0 };
  const recentUser = [];
  const decisions = [];
  for (const e of events) {
    const t = e?.type;
    if (t === 'turn/start') stats.turns += 1;
    else if (t === 'user/message') {
      const txt = eventText(e).trim();
      if (isInjectedUserMessage(txt)) continue;
      stats.userMsgs += 1;
      if (recentUser.length < 5) recentUser.push(txt.slice(0, 200));
    }
    else if (t === 'assistant/message') stats.assistantMsgs += 1;
    else if (t === 'tool/call') stats.toolCalls += 1;
    else if (t === 'tool/result') stats.toolResults += 1;
    else if (t === 'compaction/summary') { stats.checkpoints += 1; const s = eventText(e).slice(0, 160); if (s) decisions.push(s); }
  }
  return { stats, recentUser, checkpoints: decisions };
}

function renderHandoffDoc(ctx, agent, events, extras = {}) {
  const { stats, recentUser, checkpoints } = summarizeEvents(events);
  const header = agent.session.requestHeader?.()?.config ?? {};
  const now = new Date().toISOString();
  const lines = [
    '# Session Handoff',
    '',
    `- exported: ${now}`,
    `- session: ${agent.session.id}`,
    `- cwd: ${findWorkspace(agent)}`,
    `- model: ${header.provider ?? '?'} / ${header.model ?? '?'}`,
    '',
    '## Overview',
    '',
    `- turns: ${stats.turns}`,
    `- user messages: ${stats.userMsgs}`,
    `- assistant messages: ${stats.assistantMsgs}`,
    `- tool calls: ${stats.toolCalls}`,
    `- compaction checkpoints: ${stats.checkpoints}`,
    '',
    '## Recent user objectives',
    '',
    ...(recentUser.length ? recentUser.map((u) => `- ${u}`) : ['- (none captured)']),
    '',
    '## Compaction checkpoints (history summarized)',
    '',
    ...(checkpoints.length ? checkpoints.map((c) => `- ${c}`) : ['- (none)']),
    '',
    '## Agent guidance for the next session',
    '',
    '- Read this document, then continue the work described in "Recent user objectives".',
    '- If OpenViking is available, run viking_search with the session id to find archived context.',
    '- Use acp_status to see context pressure before starting heavy work.',
    '',
  ];
  if (extras.enhancers?.length) {
    lines.push('## Enhancers detected', '', ...extras.enhancers.map((e) => `- ${e}`), '');
  }
  if (extras.handoffPackage) {
    lines.push('## Handoff package (actions for the next session)', '', extras.handoffPackage, '');
  }
  return lines.join('\n');
}

function detectEnhancers(ctx) {
  const found = [];
  // OpenViking: look for viking_* tools already registered.
  try {
    const tools = ctx.tools?.list?.() ?? [];
    const viking = tools.filter((t) => typeof t?.name === 'string' && t.name.startsWith('viking_'));
    if (viking.length) found.push('openviking');
  } catch { /* tools.list may not exist */ }
  // archify: the skill bundle is shipped by @tt-a1i/archify-dsh (or archify
  // via the deepseek-harness integration); detect the package in the profile.
  try {
    const archifyPkg = resolve(process.cwd(), 'node_modules', '@tt-a1i', 'archify-dsh');
    if (existsSync(archifyPkg)) found.push('archify');
  } catch { /* ignore */ }
  return found;
}

/**
 * Build the "handoff package": concrete, copy-paste actions the agent can run
 * to archive this handoff in OpenViking and/or render an archify diagram.
 * Returns a Markdown block; empty when no enhancer is present.
 */
function buildHandoffPackage(ctx, agent, events) {
  const enhancers = detectEnhancers(ctx);
  const { stats, recentUser } = summarizeEvents(events);
  const blocks = [];
  if (enhancers.includes('openviking')) {
    const remember = [
      `viking_remember content: "Session handoff ${agent.session.id}: ${stats.turns} turns, ${stats.userMsgs} user messages, ${stats.toolCalls} tool calls, ${stats.checkpoints} checkpoints. Recent objectives: ${recentUser.slice(0, 3).join(' | ') || 'n/a'}" category: handoff`,
    ].join('\n');
    blocks.push('### OpenViking archive', '', '```', remember, '```', '');
  }
  if (enhancers.includes('archify')) {
    const cmd = [
      `# Render a progress diagram from the handoff doc:`,
      `archify render "${join(agent.session.header?.cwd ?? process.cwd(), HANDOFF_DIR, `handoff-${agent.session.id}.md`)}" --out "${HANDOFF_DIR}/diagram-${agent.session.id}.svg"`,
    ].join('\n');
    blocks.push('### archify progress diagram', '', '```', cmd, '```', '');
  }
  return blocks.join('\n');
}

function registerHandoffTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'handoff_status',
    description: 'Show a compact overview of the current session: turn counts, message counts, tool usage, compaction checkpoints, and context pressure if measurable.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec);
      const events = sessionEvents(agent.session);
      const { stats, checkpoints } = summarizeEvents(events);
      const meter = ctx.get('tokenMeter');
      let pressure = '';
      if (meter != null) {
        try {
          const used = meter.measure(agent.session)?.totalTokens ?? 0;
          const header = agent.session.requestHeader?.()?.config;
          const llm = ctx.get('llm');
          let windowTokens;
          if (llm && header?.provider && header?.model) {
            try { windowTokens = (await llm.resolveModelInfo(header.provider, header.model))?.context?.contextWindow; } catch { /* ignore */ }
          }
          pressure = `tokens used: ${used}${windowTokens ? ` / window ${windowTokens} (${(used / windowTokens * 100).toFixed(1)}%)` : ''}`;
        } catch { /* ignore */ }
      }
      return [
        `session: ${agent.session.id}`,
        `turns: ${stats.turns} | user: ${stats.userMsgs} | assistant: ${stats.assistantMsgs} | tools: ${stats.toolCalls} | checkpoints: ${stats.checkpoints}`,
        pressure,
        `enhancers: ${detectEnhancers(ctx).join('; ') || 'none'}`,
      ].filter(Boolean).join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'handoff_export',
    description: 'Export the current session into a structured Markdown handoff document under <workspace>/.dsh-handoff/ so a fresh session can continue the work. Returns the document path and a summary. If OpenViking is detected, also suggest viking_remember for long-term recall.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec);
      const events = sessionEvents(agent.session);
      const enhancers = detectEnhancers(ctx);
      const handoffPackage = buildHandoffPackage(ctx, agent, events);
      const doc = renderHandoffDoc(ctx, agent, events, { enhancers, handoffPackage });
      const ws = findWorkspace(agent);
      const dir = join(ws, HANDOFF_DIR);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `handoff-${agent.session.id}.md`);
      await writeFile(file, doc, 'utf8');
      const { stats } = summarizeEvents(events);
      const lines = [
        `Handoff written: ${file}`,
        `session ${agent.session.id}: ${stats.turns} turns, ${stats.userMsgs} user msgs, ${stats.toolCalls} tool calls, ${stats.checkpoints} checkpoints`,
        `enhancers detected: ${enhancers.length ? enhancers.join('; ') : 'none'}`,
      ];
      if (enhancers.includes('openviking')) {
        lines.push('OpenViking archive: the document contains a ready viking_remember command — run it to archive this handoff for cross-session recall.');
      }
      if (enhancers.includes('archify')) {
        lines.push('archify: the document contains a diagram command — run it to render a progress diagram.');
      }
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'handoff_resume',
    description: 'Load the latest handoff document for this workspace (or a specific one) so a fresh session can continue the previous work. Pass a filename to load a specific document, or omit for the most recent.',
    parameters: {
      file: { type: 'string', description: 'Optional handoff filename under .dsh-handoff/ (omit for the most recent)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const dir = join(findWorkspace(agent), HANDOFF_DIR);
      if (!existsSync(dir)) return 'No handoff documents found in .dsh-handoff/. Run handoff_export in the previous session first.';
      const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse();
      if (files.length === 0) return 'No handoff documents found in .dsh-handoff/.';
      const target = args?.file ? args.file : files[0];
      const file = join(dir, target);
      if (!existsSync(file)) return `Handoff not found: ${target}. Available: ${files.join(', ')}`;
      const doc = await readFile(file, 'utf8');
      return `Loaded handoff: ${target}\n\n${doc}`;
    },
  }));
}

// ---------------------------------------------------------------------------
// Module B: active context pruning (absorbed from active-context-pruning)
// ---------------------------------------------------------------------------

const ACP_SECTION = `Active Context Pruning (ACP) is available. History is hidden by replacing a surface range with your summary — not by hard truncation.

Use surface seq ids from the ACP runtime context or acp_status. Never compress the newest preserve-recent tail (it includes the live tool call).

When usage crosses the soft limit, call acp_compress on spent exploration/tool dumps. When it crosses the hard limit, compress before any other work.

acp_compress summary rules:
- dense bullets; keep paths, signatures, error strings, numbers, decisions and why; drop consumed logs. The next turn only sees that summary.
- Type-aware: tool results -> keep tool name + input signature + key output numbers only (90%+ shrink); code -> signatures + file:line refs; conversation -> semantic gist; images -> drop.
- End with a "## Recoverable" pointer line listing file paths / function names / exact seq ids. Seq ids are the event keys of the session archive (~/.dsh/sessions/**/session.jsonl.zstd, grep "seq":N) and the keys acp_decompress accepts — keep them exact so the original detail can always be re-read.
- After writing the summary, self-check one line: "lost: <none | what>"; if anything critical is missing, fold it back in before submitting.

acp_decompress returns the original hidden text for this turn; it does not restore the surface.`;

function parseLimit(raw) {
  const s = String(raw ?? '60%');
  if (s.endsWith('%')) return { ratio: Number(s.slice(0, -1)) / 100, tokens: undefined };
  return { ratio: undefined, tokens: Number(s) };
}

function thresholdTokens(limit, windowTokens) {
  if (limit.tokens != null) return limit.tokens;
  if (limit.ratio != null && windowTokens != null) return Math.floor(windowTokens * limit.ratio);
  return Infinity;
}

/**
 * Effective ACP limits for a session. The configured hard limit is clamped to
 * the provider's real request ceiling (context window minus the completion
 * budget maxTokens). A hard limit above that ceiling can never fire: the
 * provider rejects the request with CONTEXT_WINDOW_EXCEEDED and the harness
 * forces a whole-range compaction instead of letting the agent prune spent
 * ranges first.
 */
function effectiveLimits(config, windowTokens, maxTokens) {
  const configuredMin = thresholdTokens(parseLimit(config.minContextLimit), windowTokens);
  const configuredHard = thresholdTokens(parseLimit(config.maxContextLimit), windowTokens);
  // Provider-ceiling clamping is opt-in (clampToCeiling: true). By default the
  // configured soft/hard limits apply as-is, so e.g. 73%/90% means exactly
  // 730k/900k of a 1M window. Only the harness's own CONTEXT_WINDOW_EXCEEDED
  // overflow recovery (provider rejection) falls back to a forced compaction.
  if (config.clampToCeiling !== true) {
    const hard = Number.isFinite(windowTokens) ? Math.min(configuredHard, windowTokens) : configuredHard;
    return { min: Math.min(configuredMin, hard), hard };
  }
  let hard = Number.isFinite(windowTokens) ? Math.min(configuredHard, windowTokens) : configuredHard;
  if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0 && Number.isFinite(windowTokens)) {
    const ceiling = Math.max(1000, windowTokens - maxTokens - 16384);
    hard = Math.min(hard, ceiling);
  }
  const soft = Math.min(configuredMin, Math.max(1000, hard - 20000));
  return { min: soft, hard };
}

function pressureLevel(used, minTokens, maxTokens) {
  if (used >= maxTokens) return 'hard';
  if (used >= minTokens) return 'soft';
  return 'none';
}

function surfaceNodes(ctx, session) {
  const priced = new Map((ctx.get('tokenMeter')?.measure(session)?.nodes ?? []).map((n) => [n.seq, n.tokens]));
  return (session.surface?.nodes ?? []).map((seq) => {
    const event = sessionEvents(session)[seq];
    return {
      seq,
      type: event?.type ?? 'unknown',
      tokens: priced.get(seq) ?? 0,
      preview: eventText(event).slice(0, 72),
    };
  });
}

function renderStatus(ctx, agent, config, windowTokens, completionBudget) {
  const used = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
  const { min: minTokens, hard: maxTokens } = effectiveLimits(config, windowTokens, completionBudget);
  const nodes = surfaceNodes(ctx, agent.session);
  const growth = estimateGrowth(ctx, agent);
  let forecast = '';
  if (Number.isFinite(maxTokens) && growth != null && growth > 0) {
    const turnsLeft = Math.max(0, Math.floor((maxTokens - used) / growth));
    forecast = `\nestimated: ~${turnsLeft} turns until hard limit (growth ≈ ${Math.round(growth / 1000)}k/turn${used >= minTokens ? ', compress spent ranges now' : ''})`;
  }
  const lines = [
    `context: ${used}${windowTokens ? ` / ${windowTokens}` : ''} tokens (level ${pressureLevel(used, minTokens, maxTokens)})`,
    `limits: soft ${minTokens === Infinity ? 'n/a' : minTokens}, hard ${maxTokens === Infinity ? 'n/a' : maxTokens}`,
    `surface nodes: ${nodes.length}`,
    ...nodes.map((n) => `  s${n.seq} ${n.type} [${n.tokens}] ${n.preview}`),
  ];
  return lines.join('\n') + forecast;
}

function assertSafeRange(session, start, end, config) {
  const nodes = session.surface?.nodes ?? [];
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx < 0) throw new Error(`start seq ${start} is not on the current surface`);
  if (endIdx < 0) throw new Error(`end seq ${end} is not on the current surface`);
  if (startIdx > endIdx) throw new Error(`start seq ${start} is after end seq ${end} on the surface`);
  const lastAllowed = nodes.length - 1 - (config.preserveRecent ?? 2);
  if (endIdx > lastAllowed) throw new Error(`cannot compress the last ${config.preserveRecent} surface node(s)`);
}

function registerAcpTools(ctx, config, pending, windows) {
  /**
   * Locate the compaction service. In web mode dsh-web-app disables
   * compaction-basic on the host plane and mounts it in the per-session
   * realm (agent ctx), so the agent's own ctx must be tried first; headless
   * mode keeps it on the host plane (plugin ctx). Returns null when neither
   * plane provides it.
   */
  function resolveCompaction(exec) {
    const candidates = [
      ['agent', exec?.agent?.ctx],
      ['session', exec?.agent?.session?.ctx],
      ['host', ctx],
    ];
    for (const [plane, c] of candidates) {
      if (c == null || typeof c.get !== 'function') continue;
      try {
        const found = c.get('compaction');
        if (found != null) return { service: found, plane };
      } catch { /* scope may be tearing down */ }
    }
    return { service: null, plane: 'none' };
  }

  ctx.tools.register(defineTool({
    name: 'acp_status',
    description: 'Show ACP usage, surface seq map, and compaction checkpoints.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec);
      const w = windows.get(agent.session) ?? await resolveWindow(ctx, agent);
      const { plane } = resolveCompaction(exec);
      return `compaction backend: ${plane}\n` + renderStatus(ctx, agent, config, w, completionBudgets.get(agent.session));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_compress',
    description: 'Replace an inclusive surface seq range with your summary via the official compaction API. Range must be tool-pairing balanced and must not include the newest tail.',
    parameters: {
      start: { type: 'integer', required: true, description: 'Inclusive first surface seq' },
      end: { type: 'integer', required: true, description: 'Inclusive last surface seq' },
      summary: { type: 'string', required: true, description: 'Dense checkpoint the next turn will see instead of this range' },
      topic: { type: 'string', description: 'Short label' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const { service: compaction, plane } = resolveCompaction(exec);
      if (compaction == null || typeof compaction.compactRegion !== 'function') {
        throw new Error(`acp_compress needs the compaction service (found on: ${plane}); load @deepseek-ai/dsh-compaction-basic`);
      }
      const start = Number(args.start);
      const end = Number(args.end);
      const summary = String(args.summary ?? '').trim();
      if (!summary) throw new Error('summary is required');
      assertSafeRange(agent.session, start, end, config);
      const meter = ctx.get('tokenMeter');
      if (meter != null) {
        const nodes = meter.measure(agent.session)?.nodes ?? [];
        const selected = nodes.filter((n) => {
          const idx = (agent.session.surface?.nodes ?? []).indexOf(n.seq);
          const a = (agent.session.surface?.nodes ?? []).indexOf(start);
          const b = (agent.session.surface?.nodes ?? []).indexOf(end);
          return idx >= a && idx <= b;
        });
        const tokens = selected.reduce((sum, n) => sum + n.tokens, 0);
        if (tokens < config.minTokens) throw new Error(`range is only ~${tokens} tokens; minTokens is ${config.minTokens}`);
      }
      pending.set(agent.session, summary);
      try {
        const result = await compaction.compactRegion(start, end, agent, exec.signal);
        return `compressed${args.topic ? ` (${args.topic})` : ''} ${result.shadowedRange.start}-${result.shadowedRange.end}: ${result.shadowedSeqs?.length ?? 0} nodes`;
      } catch (error) {
        pending.delete(agent.session);
        throw error;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_decompress',
    description: 'Return the original text hidden by a compaction checkpoint. Does not restore the surface.',
    parameters: {
      start: { type: 'integer', description: 'Original shadowed start seq' },
      end: { type: 'integer', description: 'Original shadowed end seq' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const events = sessionEvents(agent.session);
      const summary = [...events].reverse().find((e) => e?.type === 'compaction/summary'
        && e.data?.shadowedRange?.start === Number(args.start)
        && e.data?.shadowedRange?.end === Number(args.end));
      if (summary == null) throw new Error('no compaction checkpoint matches start/end');
      const seqs = summary.data.shadowedSeqs ?? [];
      const parts = seqs.map((s) => `# s${s} ${events[s]?.type ?? '?'}\n${eventText(events[s])}`);
      return `restored s${summary.data.shadowedRange.start}-${summary.data.shadowedRange.end} (read-only)\n\n${parts.join('\n\n') || '(empty)'}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_search',
    description: 'Search visible surface events and hidden compacted originals (case-insensitive substring).',
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive substring' },
      limit: { type: 'integer', description: 'Max hits (default 10)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const q = String(args.query ?? '').toLowerCase();
      const events = sessionEvents(agent.session);
      const hits = [];
      for (const e of events) {
        const text = eventText(e);
        if (text.toLowerCase().includes(q)) {
          hits.push(`s${e.seq} ${e.type}\n  ${text.slice(0, 200)}`);
          if (hits.length >= (args.limit ?? 10)) break;
        }
      }
      return hits.length ? hits.join('\n') : `no hits for ${JSON.stringify(args.query)}`;
    },
  }));
}

async function resolveWindowInfo(ctx, agent) {
  const header = agent.session.requestHeader?.()?.config;
  const provider = header?.provider || agent.options?.provider;
  const model = header?.model || agent.options?.model;
  const llm = ctx.get('llm');
  if (llm == null || !provider || !model) return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const window = info?.context?.contextWindow;
    if (!Number.isInteger(window) || window <= 0) return undefined;
    const maxTokens = info?.defaultMaxTokens;
    return {
      window,
      maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
    };
  } catch {
    return undefined;
  }
}

async function resolveWindow(ctx, agent) {
  return (await resolveWindowInfo(ctx, agent))?.window;
}

/**
 * Estimate this session's per-turn context growth (tokens) from the last few
 * turns. Falls back to a character-based estimate when the token meter has no
 * pricing for the recent events. Returns undefined when there is not enough
 * history — callers then use the default growth (5% of the window).
 */
function estimateGrowth(ctx, agent, turns = 5) {
  try {
    const meter = ctx.get('tokenMeter');
    const session = agent?.session;
    if (meter == null || session == null) return undefined;
    const nodes = meter.measure(session)?.nodes ?? [];
    const priced = new Map(nodes.map((n) => [n.seq, n.tokens]));
    const events = sessionEvents(session);
    const turnSeqs = [];
    for (const e of events) {
      if (e?.type === 'turn/start' && typeof e?.seq === 'number') turnSeqs.push(e.seq);
    }
    if (turnSeqs.length < 2) return undefined;
    const recent = turnSeqs.slice(-(turns + 1));
    const first = recent[0];
    const last = recent[recent.length - 1];
    const span = Math.max(1, recent.length - 1);
    // Sum EVERY node between the first and last turn markers (not just the
    // turn markers themselves — those are a few tokens each and would
    // underestimate growth by orders of magnitude).
    let sum = 0;
    let pricedCount = 0;
    for (let i = first; i <= last; i++) {
      const t = priced.get(i);
      if (typeof t === 'number') { sum += t; pricedCount += 1; }
    }
    if (pricedCount >= 2) return Math.max(1, Math.floor(sum / span));
    // No token pricing: estimate from raw event characters.
    let chars = 0;
    for (let i = first; i <= last; i++) {
      const e = events[i];
      if (e == null) continue;
      const d = e.data ?? {};
      const s = JSON.stringify(d);
      chars += typeof s === 'string' ? s.length : 0;
    }
    return Math.max(1, Math.floor(chars / 3 / span));
  } catch {
    return undefined;
  }
}

function registerRecommendTool(ctx, windows) {
  ctx.tools.register(defineTool({
    name: 'acp_recommend',
    description: 'Recommend cost-optimal ACP soft/hard thresholds based on the real context window and this session\'s per-turn growth (carrying cost per turn vs one summarize call per compaction vs quality loss). Returns "NN%" limits + the reasoning.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec);
      const w = windows.get(agent.session) ?? await resolveWindow(ctx, agent);
      if (w == null) throw new Error('cannot resolve the model context window (llm.resolveModelInfo)');
      const rec = recommendThresholds({ windowTokens: w, growthPerTurn: estimateGrowth(ctx, agent), maxTokens: completionBudgets.get(agent.session) });
      const growthText = rec.growthPerTurn >= 1000
        ? `${(rec.growthPerTurn / 1000).toFixed(1)}k`
        : String(rec.growthPerTurn);
      return [
        `Recommended ACP thresholds: soft ${rec.min} / hard ${rec.max}`,
        `(window ${(w / 1000).toFixed(0)}k, growth ≈ ${growthText}/turn)`,
        ...rec.reasoning,
        '',
        `Apply: acp_set_limit minContextLimit=${rec.min} maxContextLimit=${rec.max}`,
      ].join('\n');
    },
  }));
}

function installSummaryHook(ctx, pending) {
  const compaction = ctx.get('compaction');
  if (compaction == null || typeof compaction.summarize !== 'function') return () => {};
  const original = compaction.summarize.bind(compaction);
  compaction.summarize = async (input, agent, signal) => {
    const summary = pending.get(agent.session);
    if (summary != null) {
      pending.delete(agent.session);
      return { summary: [{ type: 'text', text: summary }], provider: 'acp', model: 'model-authored' };
    }
    return original(input, agent, signal);
  };
  return () => { compaction.summarize = original; };
}

/** Read the settings.yaml `session-handoff:` section synchronously (config bridge). */
function readSettingsSectionSync() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const text = readFileSync(join(home, 'settings.yaml'), 'utf8');
    return readSection(text);
  } catch {
    return {};
  }
}

function resolveConfig(config = {}) {
  // Precedence: built-in defaults < settings.yaml `session-handoff:` < cordis config.
  const merged = { ...readSettingsSectionSync(), ...config };
  return {
    enabled: merged.enabled ?? true,
    minContextLimit: merged.minContextLimit ?? '60%',
    maxContextLimit: merged.maxContextLimit ?? '70%',
    preserveRecent: merged.preserveRecent ?? 2,
    minTokens: merged.minTokens ?? 200,
    nudge: merged.nudge ?? true,
    clampToCeiling: merged.clampToCeiling ?? false,
  };
}

// ---------------------------------------------------------------------------
// Module D: web routes (client UI backend)
// ---------------------------------------------------------------------------

const ROUTE_PREFIX = '/dsh-session-handoff';

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  return JSON.parse(raw);
}

/** Export one agent's session into a handoff document; shared by the tool and the web route. */
async function exportHandoffForAgent(ctx, agent) {
  if (agent?.session == null) throw new Error('agent-has-no-session');
  const events = sessionEvents(agent.session);
  const enhancers = detectEnhancers(ctx);
  const handoffPackage = buildHandoffPackage(ctx, agent, events);
  const doc = renderHandoffDoc(ctx, agent, events, { enhancers, handoffPackage });
  const ws = findWorkspace(agent);
  const dir = join(ws, HANDOFF_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `handoff-${agent.session.id}.md`);
  await writeFile(file, doc, 'utf8');
  const { stats } = summarizeEvents(events);
  return {
    file,
    sessionId: agent.session.id,
    turns: stats.turns,
    userMsgs: stats.userMsgs,
    toolCalls: stats.toolCalls,
    checkpoints: stats.checkpoints,
    enhancers,
  };
}

function registerRoutes(ctx, windows, onChange, completionBudgets) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer;
  if (webServer == null || typeof webServer.register !== 'function') return;
  const register = (path, handler) => {
    try {
      webServer.register({ kind: 'exact', path, handler });
    } catch (error) {
      ctx.logger?.warn?.('[dsh-session-handoff] route registration failed for', path, error);
    }
  };

  // GET /dsh-session-handoff/routes — every model route (model_routes), with
  // the current chat-context selection (running session's requestContext).
  register(`${ROUTE_PREFIX}/routes`, async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const agents = ctx.get?.('agents') ?? ctx.agents;
      const running = [...(agents?.list?.() ?? [])].find((a) => a?.status === 'running');
      const requestContext = running?.session?.requestContext?.() ?? undefined;
      return respond(res, 200, {
        ok: true,
        routes: enumerateRoutes(ctx, requestContext),
        current: requestContext ?? null,
      });
    } catch (error) {
      return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // POST /dsh-session-handoff/switch — { provider } → agent-default-model (model_switch).
  register(`${ROUTE_PREFIX}/switch`, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    try {
      const { route, provider, model, reasoningEffort } = await switchProvider(ctx, body?.provider, {
        model: typeof body?.model === 'string' ? body.model : undefined,
        reasoningEffort: typeof body?.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
      });
      return respond(res, 200, {
        ok: true,
        provider,
        model,
        reasoningEffort,
        baseURL: route.baseURL ?? null,
        keyEnv: route.keyEnv,
        keyFamily: route.keyFamily,
      });
    } catch (error) {
      return respond(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // GET|POST /dsh-session-handoff/acp — read (GET) or persist (POST) ACP
  // thresholds. Registered ONCE: the webServer keeps a single handler per
  // exact path, so two registrations for the same path shadowed each other
  // (POST fell through to the GET handler → 405 method-not-allowed).
  register(`${ROUTE_PREFIX}/acp`, async (req, res) => {
    if (req.method === 'GET') {
      try {
        return respond(res, 200, { ok: true, section: await readAcpSection() });
      } catch (error) {
        return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return respond(res, 400, { ok: false, error: 'bad-request' });
      }
      try {
        const section = await writeAcpConfig(body ?? {});
        onChange?.(section);
        return respond(res, 200, { ok: true, section });
      } catch (error) {
        return respond(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    }
    return respond(res, 405, { ok: false, error: 'method-not-allowed' });
  });

  // POST /dsh-session-handoff/recommend — { sessionId? } → cost-optimal ACP thresholds.
  register(`${ROUTE_PREFIX}/recommend`, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const agents = ctx.get?.('agents') ?? ctx.agents;
    let agent;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (sessionId !== '') agent = agents?.get?.(sessionId);
    if (agent == null) agent = [...(agents?.list?.() ?? [])].find((a) => a?.status === 'running');
    if (agent == null) return respond(res, 400, { ok: false, error: 'no-agent-session' });
    try {
      const w = windows.get(agent.session) ?? (await resolveWindowInfo(ctx, agent))?.window;
      if (w == null) return respond(res, 500, { ok: false, error: 'cannot-resolve-window' });
      const maxTokens = completionBudgets.get(agent.session);
      const rec = recommendThresholds({ windowTokens: w, growthPerTurn: estimateGrowth(ctx, agent), maxTokens });
      return respond(res, 200, {
        ok: true,
        min: rec.min,
        max: rec.max,
        growthPerTurn: rec.growthPerTurn,
        windowTokens: w,
        reasoning: rec.reasoning,
      });
    } catch (error) {
      return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // POST /dsh-session-handoff/export — { sessionId } → handoff document (handoff_export).
  register(`${ROUTE_PREFIX}/export`, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') return respond(res, 400, { ok: false, error: 'missing-session-id' });
    const agents = ctx.get?.('agents') ?? ctx.agents;
    const agent = agents?.get?.(sessionId);
    if (agent == null) return respond(res, 404, { ok: false, error: 'session-not-found' });
    try {
      return respond(res, 200, { ok: true, ...(await exportHandoffForAgent(ctx, agent)) });
    } catch (error) {
      return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // GET|POST /dsh-session-handoff/failover — read or persist the ordered
  // provider failover list (order = priority; [] = disabled).
  register(`${ROUTE_PREFIX}/failover`, async (req, res) => {
    if (req.method === 'GET') {
      try {
        const routes = await readFailoverRoutes();
        return respond(res, 200, { ok: true, enabled: routes.length > 0, routes });
      } catch (error) {
        return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return respond(res, 400, { ok: false, error: 'bad-request' });
      }
      try {
        const list = Array.isArray(body?.providers) ? body.providers : [];
        const routes = await writeFailoverRoutes(list);
        return respond(res, 200, { ok: true, enabled: routes.length > 0, routes });
      } catch (error) {
        return respond(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    }
    return respond(res, 405, { ok: false, error: 'method-not-allowed' });
  });
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  config = resolveConfig(config);

  const pending = new WeakMap();
  const windows = new WeakMap();
  const completionBudgets = new WeakMap();

  /** Apply newly persisted ACP settings to the live runtime config immediately. */
  function applyLiveConfig(next) {
    config.minContextLimit = next.minContextLimit;
    config.maxContextLimit = next.maxContextLimit;
    config.preserveRecent = next.preserveRecent;
    config.minTokens = next.minTokens;
    config.nudge = next.nudge;
    config.clampToCeiling = next.clampToCeiling ?? false;
  }

  ctx.effect(() => installSummaryHook(ctx, pending));

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const info = await resolveWindowInfo(ctx, agent);
    if (info != null) {
      windows.set(agent.session, info.window);
      if (info.maxTokens != null) completionBudgets.set(agent.session, info.maxTokens);
    }
    return next();
  });

  // Pressure banner + surface map injected into the system prompt.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt != null) {
    systemPrompt.section({ name: 'sh:acp:instructions', order: 80, text: ACP_SECTION });
    systemPrompt.context({
      name: 'sh:acp:surface',
      order: 80,
      text: (assembly) => {
        const agent = assembly.agent;
        if (agent?.session == null) return '';
        const w = windows.get(agent.session);
        const body = renderStatus(ctx, agent, config, w, completionBudgets.get(agent.session));
        if (!config.nudge) return `ACP surface map. Use these seq ids with acp_compress.\n\n${body}`;
        const used = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
        const { min, hard: max } = effectiveLimits(config, w, completionBudgets.get(agent.session));
        const level = pressureLevel(used, min, max);
        const banner = level === 'hard'
          ? 'ACP: context is past the hard limit. Call acp_compress now. Do not start new exploration.'
          : level === 'soft'
            ? 'ACP: context is past the soft limit. Compress spent ranges with acp_compress before continuing.'
            : '';
        return `${banner}\n\n${body}`;
      },
    });
  }

  // /handoff and /acp commands.
  const commands = ctx.get('commands');
  if (commands != null) {
    commands.register({
      name: 'handoff',
      description: 'Export the current session handoff document (same output as handoff_export, including the handoff package)',
      async handler(invocation) {
        const events = sessionEvents(invocation.agent.session);
        const enhancers = detectEnhancers(ctx);
        const handoffPackage = buildHandoffPackage(ctx, invocation.agent, events);
        const doc = renderHandoffDoc(ctx, invocation.agent, events, { enhancers, handoffPackage });
        const dir = join(findWorkspace(invocation.agent), HANDOFF_DIR);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `handoff-${invocation.agent.session.id}.md`);
        await writeFile(file, doc, 'utf8');
        return { kind: 'success', text: `Handoff written: ${file}${handoffPackage ? ' (with handoff package)' : ''}` };
      },
    });
    commands.register({
      name: 'acp',
      description: 'Show Active Context Pruning status',
      async handler(invocation) {
        const w = windows.get(invocation.agent.session) ?? await resolveWindow(ctx, invocation.agent);
        return { kind: 'success', text: renderStatus(ctx, invocation.agent, config, w, completionBudgets.get(invocation.agent.session)) };
      },
    });
  }

  registerHandoffTools(ctx);
  registerAcpTools(ctx, config, pending, windows);
  registerRecommendTool(ctx, windows);
  registerSessionMgmtTools(ctx);
  registerModelRoutesTools(ctx);
  registerAcpConfigTools(ctx, applyLiveConfig);
  registerFailoverTools(ctx);
  installFailover(ctx);

  // Fallback: web profiles disable compaction-basic on the host plane and
  // mount it only in per-session preset realms, so legacy sessions without a
  // realm never get a backend. When nothing else provides the service, mount
  // the official engine ourselves so acp_compress works everywhere.
  if (ctx.get('compaction') == null) {
    import('@deepseek-ai/dsh-compaction-basic').then(({ default: BasicCompactionEngine }) => {
      if (ctx.get('compaction') == null) {
        ctx.provide('compaction', new BasicCompactionEngine(ctx, {}));
        ctx.logger?.info?.('dsh-session-handoff: mounted fallback compaction backend (host plane)');
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`dsh-session-handoff: fallback compaction mount failed: ${String(error)}`);
    });
  }
  registerRoutes(ctx, windows, applyLiveConfig, completionBudgets);
}

/**
 * Pure internals exported for unit testing (not part of the public API).
 */
export const __internals = {
  summarizeEvents,
  renderHandoffDoc,
  parseLimit,
  thresholdTokens,
  pressureLevel,
  assertSafeRange,
  eventText,
  sessionEvents,
};
