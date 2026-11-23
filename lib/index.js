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
import z from '@deepseek-ai/schemastery';
import { sessionEvents } from './session-events.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerSessionMgmtTools } from './session-mgmt.js';
import { registerModelRoutesTools, enumerateRoutes, switchProvider } from './model-routes.js';
import { registerAcpConfigTools, readAcpSection, readSection, writeAcpConfig } from './acp-config.js';
import { Worker } from 'node:worker_threads';
import { readSessionEventsIncremental, fileStamp } from './zstd-reader.js';
import { RepetitionGuard } from './repetition.js';
import { restrictSubagentTools, shouldRestrict } from './subagent-tool-scope.js';
import { registerGraphTools, graphRecall, graphHotEntities, storeBlock, blockStats, openDb as graphOpenDb, sessionFilePath, readSessionEventsFromFile, autoIngestSession } from './graph.js';
import { recommendThresholds } from './acp-recommend.js';
import { installFailover, registerFailoverTools, readFailoverRoutes, writeFailoverRoutes } from './failover.js';
import { createModerationReset } from './moderation.js';
import { readSessionCache, formatCacheLine, compactionCacheLoss } from './cache-stats.js';
import { shrinkTargets, shrunkenContent, withResultParts, truncateText } from './shrink.js';
import { snapEndDown, balancedCutsAfter } from './pairing.js';
import { appendMetric, readMetrics, readRetrievalSignals, statusBlock, formatCheckpointLines } from './metrics.js';
// 安全取用未注入的服务（webServer 缺席是正常的：headless/tui profile 里就没有）。
// 详见 lib/services.js 顶部 —— `ctx.get?.(x) ?? ctx.x` 不是防御，右侧会抛。
import { serviceOf } from './services.js';
import { extractHumanDecisions, renderHumanDecisions } from './human-decisions.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-session-handoff';

export const inject = ['tools', 'storageDomain', 'sessionPersistence', 'workspaceRegistry', 'agents', 'llm'];

/**
 * Row-level tunables, declared so `ctx.configForms` can serve this plugin.
 *
 * 為什麼非宣告不可：沒有 `Config` 就沒有設定表單，而 @snow-the/dsh-toolbox 的卡片是
 * `SPECS.filter(s => served.has(s.id))` —— `whileServed` 永遠看不到這個 namespace，
 * 於是「工具設定」裡只有 memory 一張卡。這不是 UI bug，是缺少官方要求的 config schema。
 *
 * 這些欄位**就是** `resolveConfig()` 合併的那些鍵。優先序不變：
 * 內建預設 < settings.yaml 的 `session-handoff:` 段 < cordis row config。
 * 宣告 schema 只多了「GUI 有東西可畫」，不改讀取路徑。
 *
 * 不標 `.volatile()`：本插件在 apply 時就 resolve 出設定物件，執行中改值需要重啟；
 * 誠實地讓表單顯示「需重啟」比假裝即時生效好。
 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('總開關。關掉後 handoff_* / acp_* 工具仍註冊，但壓縮不會被觸發。'),
  minContextLimit: z.union([z.string(), z.number()]).default('65%')
    .description('軟觸發：用量超過它就會摺。可寫百分比（"65%"）或絕對 token 數。'),
  maxContextLimit: z.union([z.string(), z.number()]).default('85%')
    .description('硬上限：真正的天花板。超過就必須摺，不再是建議。'),
  preserveRecent: z.number().step(1).min(0).default(2)
    .description('永遠保留的最新表面節點數（摺疊範圍不碰它）。'),
  minTokens: z.number().step(1).min(0).default(200)
    .description('一次摺疊至少要有這麼多 token，否則不值得付一次全前綴 cache miss。'),
  nudge: z.boolean().default(true)
    .description('在系統提示裡注入壓力提示行（目前用量／上限／是否該摺）。'),
  clampToCeiling: z.boolean().default(false)
    .description('把硬上限夾到「視窗 − maxTokens」以下，讓摺疊一定早於 provider 拒收。'),
  hostTrigger: z.boolean().default(true)
    .description('由宿主自己觸發摺疊；關掉則回到「提示模型、模型可能不理」的舊行為。'),
  hostTriggerAt: z.union([z.string(), z.number()]).default('soft')
    .description('宿主在哪條線觸發：soft = 過了軟觸發就摺；hard = 只在硬上限摺。'),
  compressTargetRatio: z.number().min(0).max(1).step(0.01).default(0.35)
    .description('深摺目標：摺完後表面落在視窗的這個比例。摺淺會很快再摺一次，每次都要付整段 cache miss。'),
  minFoldRatio: z.number().min(0).max(1).step(0.01).default(0.1)
    .description('一次摺疊至少要移除這個比例的表面，否則視為不值得（避免碎摺）。'),
  shrinkToolResults: z.boolean().default(true)
    .description('對已花掉的工具結果做無模型的 head/tail 裁剪（不呼叫 LLM）。'),
  shrinkMinTokens: z.number().step(1).default(3000)
    .description('只裁剪大於這個 token 數的工具結果。'),
  shrinkMaxPerStep: z.number().step(1).default(2)
    .description('每個 pre-step 最多裁剪幾個結果。'),
  shrinkWindowNodes: z.number().step(1).default(16)
    .description('裁剪最多往回看幾個表面節點（越遠，重送的 provider 前綴越長）。'),
  stutterGuard: z.boolean().default(true)
    .description('偵測已知的退化重複（deepseek-v4.1-flash 的 "OK. / Let me write. / Let me go." 迴圈）並取消該回合。只比對已知片語，不會誤殺真實輸出。'),
  shrinkProtectedTail: z.number().step(1).default(4)
    .description('最後幾個表面節點一律不裁剪。'),
  shrinkHeadChars: z.number().step(1).default(600)
    .description('裁剪後保留的開頭字元數。'),
  shrinkTailChars: z.number().step(1).default(400)
    .description('裁剪後保留的結尾字元數。'),
  cacheHitPriceRatio: z.number().min(0).max(1).step(0.01).default(0.02)
    .description('cache 命中價佔未命中價的比例（用於估算一次摺疊的成本）。'),
  cacheMissPricePerMTokens: z.number().min(0).step(0.01).default(1)
    .description('每百萬未命中 token 的單價（人民幣）；所有成本數字都按它換算。'),
});

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
    const t = typeof d.text === 'string' ? d.text : truncateText(JSON.stringify(d), 200);
    return truncateText(String(t), 300);
  }
  if (event.type === 'compaction/summary') {
    const s = d.summary ?? d;
    const text = Array.isArray(s) ? s.map((b) => b?.text ?? '').join('\n') : (s?.text ?? truncateText(JSON.stringify(d), 200));
    return `[compaction checkpoint] ${truncateText(String(text), 300)}`;
  }
  return '';
}

function requireAgent(exec) {
  if (exec?.agent?.session == null) throw new Error('handoff/acp tools need an active agent session');
  return exec.agent;
}

// sessionEvents lives in ./session-events.js: ONE owner for "a harness Session has no `events`".
// graph.js needs the same fact, and a per-module copy is how it grew a second, broken reader.
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
      if (recentUser.length < 5) recentUser.push(truncateText(txt, 200));
    }
    else if (t === 'assistant/message') stats.assistantMsgs += 1;
    else if (t === 'tool/call') stats.toolCalls += 1;
    else if (t === 'tool/result') stats.toolResults += 1;
    else if (t === 'compaction/summary') { stats.checkpoints += 1; const s = truncateText(eventText(e), 160); if (s) decisions.push(s); }
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
      // File-first: compaction/shadowed originals live in session.jsonl, not the
      // in-memory surface — stats were 0 on long sessions. Fall back to memory.
      const fileMap = getSessionFileEvents(agent.session);
      const events = fileMap && fileMap.size ? [...fileMap.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : sessionEvents(agent.session);
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

Name the two thresholds correctly, because they are not the same kind of thing: the SOFT limit is a TRIGGER you own — fold when you pass it — and the HARD limit is the CAP on the window. A trigger is not a budget: passing the soft line does not mean your context is nearly gone, and below it you keep working exactly as before.

Compaction is threshold-driven, not a judgment call, and it is your call to make. When the per-turn ACP line says you passed the trigger, call acp_compress end:auto once — no deliberation about whether to compress or which range to take, and never stop a turn to ask the user whether to compact or wait for their permission. Folding is an internal, reversible action: the original text stays recoverable through acp_decompress. When usage crosses the hard limit, compress before any other work.

Every compaction forces the host to re-project the system prompt and open a new request series, so the NEXT call re-sends the whole prompt uncached. A shallow fold (stopping just under the soft limit) pays that price again a few turns later — measured on our own logs, long sessions compacted 135-168 times. Fold deep instead: acp_compress extends the range backwards to land near compressTargetRatio (default 0.35) of the window unless you pass deep:false.

acp_compress summary rules:
- dense bullets; keep paths, signatures, error strings, numbers, decisions and why; drop consumed logs. The next turn only sees that summary.
- Type-aware: tool results -> keep tool name + input signature + key output numbers only (90%+ shrink); code -> signatures + file:line refs; conversation -> semantic gist; images -> drop.
- End with a "## Recoverable" pointer line listing file paths / function names / exact seq ids. Seq ids are the event keys of the session archive (~/.dsh/sessions/**/session.jsonl.zstd, grep "seq":N) and the keys acp_decompress accepts — keep them exact so the original detail can always be re-read.
- After writing the summary, self-check one line: "lost: <none | what>"; if anything critical is missing, fold it back in before submitting.

Two fields the summary must carry, because a checkpoint without them can only be evicted by age, never by usefulness:
- **intent** — the FIRST line of the summary, literally starting "Intent:". What this session is trying to achieve, not what it did. "Did X, then Y" is a log; "wants Z, blocked on W" is an intent. If the goal changed mid-session, give the current one and note the change.
- **confidence** — inline on each bullet that asserts something, as "(confidence 1-10)". 9-10 = verified by a command's output or a file read this session; 5-6 = inferred from context; 1-3 = a guess or a plan not yet run. Add "decay" only when the fact goes stale on its own (versions, paths, external state): "(confidence 7, decay 3)".
- Do NOT add a bullet per field. Confidence rides on the bullets you already write — a summary that grows a "Confidence:" section has traded one failure for another.

The shape, so there is nothing to interpret:
Intent: <one line: what this session is trying to achieve>
- <what was found or decided> (confidence 9)
- <what is still open> (confidence 5, decay 2)

acp_decompress returns the original hidden text for this turn; it does not restore the surface.`;

/**
 * How far back to extend a compaction so one call buys real headroom.
 *
 * A surface replacement is not free: dsh-agent-loop re-projects the system prompt and
 * starts a new request series whenever `surface.replaceGeneration` changes
 * (dsh-agent-loop/lib/index.js:1019), so the next request misses the provider's prefix
 * cache entirely. Paying that once for a deep fold beats paying it every few turns for a
 * shallow one — our own graph shows sessions that compacted 135-168 times.
 *
 * @returns the (possibly earlier) start seq to fold from.
 */
/** Per-session compaction ledger (in-process): how often we pay the prefix-cache price. */
const compactionLedger = new Map();
function compactionStats(session) {
  const id = session?.id ?? 'unknown';
  let s = compactionLedger.get(id);
  if (s == null) { s = { count: 0, lossTokens: 0, lossCost: 0 }; compactionLedger.set(id, s); }
  return s;
}

/**
 * Folds whose REAL cache bill has not been read yet, keyed by session id.
 *
 * The journal used to PREDICT the fold's cache cost from a prompt size — and it took the PRE-fold
 * size, while the cost falls on the NEXT call, whose context is the POST-fold one. Every row
 * therefore overstated its own fold by that fold's shrink factor (our rows: before 718k-810k, after
 * 134k-274k => 3-6x). The harness already records the truth per session (storages/session_projcache
 * .json: cacheReadTokens / uncachedInputTokens, cumulative and disjoint), so the bill is MEASURED:
 * snapshot the counters as the fold lands, read them again on the next pre-step, journal the delta.
 */
const pendingCacheSettle = new Map();

/** Sessions whose shrink rewrite was refused once — the shape is wrong, and the next one fails the same way. */
const shrinkRefused = new Set();
/** The deferral note is worth saying once, not on every pre-step. */
let shrinkDeferredLogged = false;
/** The override note (we run despite a mounted pruner) is worth saying once too. */
let shrinkOverrideLogged = false;
/**
 * session -> the disposer that lifts its subagent tool restriction.
 *
 * The restriction is scoped to the agent, so it dies with the agent's context — but keeping the
 * disposer makes the lifetime explicit and lets a test prove the restriction is reversible.
 */
const subagentRestrictions = new Map();

/**
 * Shrink spent tool results — deterministically, with no model call.
 *
 * The cheapest lever on the cost that dominates the prompt bill: on our two heaviest sessions 79-87%
 * of billed prompt tokens were cache reads re-sending context, and a tool dump that has already been
 * read is bulk. Head + tail + a marker naming the original seq keeps what an agent actually goes back
 * for, and the original stays in the session log.
 *
 * The write is a ONE-NODE surface replacement of the same event type with only the content changed —
 * the single rewrite the session contract permits for tool/result — so no system prompt changes and
 * everything before the shrunk node stays in the provider's prefix cache.
 *
 * @returns how many results were rewritten.
 */
/**
 * Should our deterministic shrink run, or defer to the harness pruner?
 *
 * Pure and exported so the decision is a tested artifact rather than a comment. The rule is
 * "defer only when the harness pruner is at least as aggressive as we are", because:
 *
 *  - THRESHOLD: its budget is characters (default 8192); ours is tokens (default 800 ≈ 3200
 *    chars). Deferring to a looser pruner leaves the 3200-8192 char band unpruned forever.
 *  - TIMING: per dsh-compaction-tool-result-pruner/README.zh.md:60 it runs ONLY after a
 *    compaction trigger fires. Ours runs on every agent/pre-step.
 *
 * Measured on an 8-day session (12,288 tool results): the official pruner fired ZERO times at
 * its 8192 default while 678 results exceeded our threshold and 7.05M chars were reclaimable.
 * The old unconditional deferral is what made both mechanisms idle.
 *
 * @returns {{run: boolean, reason: string, ours?: number, theirs?: number}}
 */
export function shrinkDecision(ctx, config) {
  const pruner = typeof ctx?.get === 'function' ? ctx.get('toolResultPruner') : null;
  if (pruner == null) return { run: true, reason: 'no-pruner' };
  const ours = Number(config?.shrinkMinTokens ?? 800) * 4;   // 4 chars/token, the meter's heuristic
  // A pruner that exposes no threshold is the official default, not "unknown": guessing
  // "unknown -> defer" is exactly how the original bug happened.
  const theirs = Number(pruner?.config?.thresholdChars ?? pruner?.thresholdChars ?? 8192);
  if (Number.isFinite(theirs) && theirs <= ours) return { run: false, reason: 'defer', ours, theirs };
  return { run: true, reason: 'pruner-too-loose', ours, theirs };
}

function shrinkSpentResults(ctx, agent, config) {
  if (config?.shrinkToolResults !== true) return 0;
  const decision = shrinkDecision(ctx, config);
  if (!decision.run) {
    if (!shrinkDeferredLogged) {
      shrinkDeferredLogged = true;
      try { ctx.logger?.info?.(`acp shrink: deferring to the harness toolResultPruner (thresholdChars ${decision.theirs} <= our ${decision.ours})`); } catch { /* logging is best-effort */ }
    }
    return 0;
  }
  if (decision.reason === 'pruner-too-loose' && !shrinkOverrideLogged) {
    shrinkOverrideLogged = true;
    try {
      ctx.logger?.info?.(`acp shrink: NOT deferring — harness pruner thresholdChars ${decision.theirs} is looser than our ${decision.ours}, and it only runs after a compaction trigger`);
    } catch { /* logging is best-effort */ }
  }
  const session = agent?.session;
  if (session == null || typeof session.append !== 'function') return 0;
  let targets;
  let events;
  try {
    events = getSessionFileEvents(session);
    targets = shrinkTargets({
      nodes: surfaceNodes(ctx, session),
      eventBySeq: events,
      minTokens: config.shrinkMinTokens,
      protectedTail: config.shrinkProtectedTail,
      windowNodes: config.shrinkWindowNodes,
      limit: config.shrinkMaxPerStep,
    });
  } catch { return 0; }
  if (targets.length === 0) return 0;
  const before = ctx.get('tokenMeter')?.measure(session)?.totalTokens ?? 0;
  let done = 0;
  for (const target of targets) {
    const content = shrunkenContent(target.parts, {
      seq: target.seq,
      toolName: target.toolName,
      headChars: config.shrinkHeadChars,
      tailChars: config.shrinkTailChars,
    });
    if (content == null) continue;
    try {
      // Re-emit in the shape we READ: V4 carries the parts directly on the message, V3 nests them in
      // the one tool-result wrapper. Building the V3 shape on a V4 log is refused by the contract.
      session.append('tool/result', { message: withResultParts(target, content) }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq],
      });
      done += 1;
    } catch (err) {
      // A refused rewrite means the session contract disagrees with our shape — the next one would
      // fail identically. Say it once per session and stop, rather than looping on a rejected write.
      const key = String(session.id ?? 'unknown');
      if (!shrinkRefused.has(key)) {
        shrinkRefused.add(key);
        try { ctx.logger?.warn?.('acp shrink refused: ' + String(err?.message ?? err).slice(0, 200)); } catch { /* logging is best-effort */ }
      }
      break;
    }
  }
  if (done > 0) {
    const after = ctx.get('tokenMeter')?.measure(session)?.totalTokens ?? before;
    appendMetric({ kind: 'shrink', ts: Date.now(), session: session.id, nodes: done, before, after, freed: Math.max(0, before - after) });
  }
  return done;
}

// ── 內容審查的上下文重置（2026-10-05）───────────────────────────────────────
// 被審查拒掉的是**這份 transcript**，不是這條路由；換路由只是把同樣的位元組再送一次
// （實際事故：commandcode 400 → volcengine 404 → deepseek-official 400 Content Exists Risk）。
// 所以先把最新讀進來的那幾筆工具結果從**carried context** 換成墓碑（決定性、不叫模型 ——
// 叫模型會把剛剛被拒的內容再送一次），真的騰不出量才折一段。
function newestToolResultTargets(ctx, agent) {
  const session = agent?.session;
  if (session == null) return [];
  try {
    return shrinkTargets({
      nodes: surfaceNodes(ctx, session),
      eventBySeq: getSessionFileEvents(session),
      minTokens: config.shrinkMinTokens,
      protectedTail: 0,          // 審查命中的往往就是剛讀進來那一筆，尾巴不能保護
      windowNodes: config.shrinkWindowNodes,
      limit: 4,
    });
  } catch { return []; }
}

function replaceToolResultContent(agent, target, text) {
  const session = agent?.session;
  if (session == null || typeof session.append !== 'function') return false;
  const parts = [{ type: 'text', text }];
  session.append('tool/result', { message: withResultParts(target, parts) }, {
    surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
    sourceEventSeqs: [target.seq],
  });
  return true;
}

/** Snapshot a session's cumulative cache counters as a fold lands. */
function scheduleCacheSettle(session, entry) {
  const id = session?.id;
  if (id == null) return;
  pendingCacheSettle.set(String(id), { ...entry, estimated: Math.round(entry.estimated ?? 0) });
}

/**
 * Append the measured cache bill of a fold whose next call has already happened.
 * @returns whether a row was written.
 */
function settleCacheBill(session) {
  const id = session?.id;
  if (id == null) return false;
  const key = String(id);
  const pending = pendingCacheSettle.get(key);
  if (pending == null) return false;
  const base = pending.cacheAtFold;
  if (base == null) { pendingCacheSettle.delete(key); return false; }
  const now = readSessionCache(key);
  if (now == null) return false;                 // no usage row yet: keep waiting
  const uncached = now.misses - base.misses;
  if (!(uncached > 0)) return false;             // nothing billed since the fold: keep waiting
  pendingCacheSettle.delete(key);
  appendMetric({
    kind: 'settle', ts: Date.now(), session: key, foldTs: pending.ts,
    uncachedTokens: uncached, cachedTokens: Math.max(0, now.hits - base.hits),
    estimatedTokens: pending.estimated, estimatedCostCNY: pending.estimatedCostCNY ?? null,
  });
  return true;
}

/**
 * User turns so far — the L4 context for a fold row. A count must never break a fold.
 *
 * It used to read `agent.session.events`, which does not exist on a real harness session (see
 * sessionEvents above): the count was therefore ALWAYS 0, and the first real journal row proved it
 * (`userMsgs: 0` for a session with 810k tokens of history). A field that always reads zero is worse
 * than no field — it looks like a measurement.
 */
function countUserMsgs(agent) {
  try { return summarizeEvents(sessionEvents(agent?.session)).stats.userMsgs; } catch { return undefined; }
}

export function deepFoldStart(meter, session, config, start, end, windowTokens) {
  const nodes = session?.surface?.nodes ?? [];
  // `nodes` holds SEQS (`readonly nodes: readonly SessionSeq[]`, docs/subsystems/session.md:410),
  // so `nodes.indexOf(start)` would have been correct. The comment here used to claim the array
  // held node objects and that indexOf was therefore always -1 — that claim was never measured and
  // is false on this build (`_p0/probe-surface-node-type.mjs`: number=456).
  //
  // The `seqOf` form is kept because it is correct under BOTH representations, which is the only
  // property worth paying for here. What it does NOT do is make `deep: true` effective: measured
  // `_p0/probe-deepfold-noop.mjs` — `deepFoldStart` can reach back on 0 of 9 real folds, because
  // `hostFoldRange` already starts at the first foldable node. The target is applied on the END
  // (`foldEndForTarget`), not here.
  const seqOf = (n) => (typeof n === 'number' ? n : n?.seq);
  const si = nodes.findIndex((n) => seqOf(n) === start);
  // `end` may be the string 'auto' (that is what `hostFoldRange` returns). Comparing it with `===`
  // against numeric seqs made `ei` -1, so this function returned `start` on its FIRST line — before
  // the extension loop ever ran. Measured 2026-11-22 (`_p0/probe-deepfold-cause.mjs`): 37 of 37 host
  // ranges returned at that gate, 0 reached the loop.
  //
  // That matters because the earlier explanation for "deep is a no-op" was "hostFoldRange already
  // starts at the first foldable node, so there is nothing to extend". That may also be true, but it
  // was never the reason: the function never got far enough to find out. Two different causes with
  // two different fixes — delete the function, or wire it correctly.
  const ei = Number.isFinite(Number(end)) && typeof end !== 'string'
    ? nodes.findIndex((n) => seqOf(n) === end)
    : nodes.length - 1 - (Number(config?.preserveRecent) || 2);
  if (si <= 0 || ei < 0 || ei >= nodes.length) return start;
  const priced = new Map((meter?.measure(session)?.nodes ?? []).map((n) => [n.seq, n.tokens]));
  const total = meter?.measure(session)?.totalTokens ?? 0;
  const ratio = Number(config.compressTargetRatio ?? 0.35);
  const basis = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : total;
  const target = Math.max(0, Math.round(basis * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.35)));
  let fold = 0;
  for (let i = si; i <= ei; i++) fold += priced.get(seqOf(nodes[i])) ?? 0;
  let chosen = si;
  for (let i = si - 1; i >= 0; i--) {
    if (total - fold <= target) break;
    fold += priced.get(seqOf(nodes[i])) ?? 0;
    chosen = i;
  }
  return nodes[chosen];
}

/**
 * The END that makes a fold LAND at `compressTargetRatio` instead of overshooting it.
 *
 * `deepFoldStart` can only move the START backwards — and `hostFoldRange` already starts at the
 * first foldable node (index 1, or just past `keep_first`). So on every host-triggered fold there
 * is nothing to extend, and the target was never applied. Measured 2026-11-22:
 *
 *   `_p0/probe-deepfold-noop.mjs`   — `deepFoldStart` could reach back on **0 of 9** folds
 *   `_p0/measure-retain-surface.mjs` — priced surface after the fold: **1.1%** of the window
 *                                      (median), against a `compressTargetRatio` of **0.35**
 *
 * Both numbers are priced by the OFFICIAL estimator (`estimateMessage` over `foldSurface`), not by
 * provider usage — which stopped being recorded on this route on 2026-11-14
 * (`_p0/probe-usage-cutoff.mjs`), so the older `measure-retain.mjs` was reporting a frozen level.
 *
 * The target can only be honoured by folding LESS: keep more of the recent tail verbatim. This
 * returns the last surface seq whose cumulative price still fits under `surfaceTotal - target`,
 * snapped DOWN to a tool-pairing-balanced cut. Erring on the "fold less" side is deliberate — the
 * operator's complaint was "过度压缩反倒导致在做重要且复杂的事情到一半他给忘了", so a fold that
 * leaves the surface ABOVE the target is the safe direction; one that lands below it is the bug.
 *
 * @param meter - token meter (per-node pricing); without it the target cannot be computed.
 * @param session - session whose surface is being folded.
 * @param config - plugin config (`compressTargetRatio`).
 * @param start - inclusive first surface seq of the fold.
 * @param end - inclusive last surface seq the caller asked for.
 * @param windowTokens - the route's context window, the denominator of the target.
 * @param options.eventBySeq - seq -> event map, for the tool-pairing balance check.
 * @returns `{ end }` with the end seq to use, `{ end: null, skip: true }` when the surface is
 *   already at or below the target (the fold would be cosmetic — do NOT fold), or
 *   `{ end: null, skip: false }` when the target cannot be computed at all (the caller keeps its
 *   own range). The three outcomes are distinguishable ON PURPOSE: a bare `null` used to mean both
 *   "already there" and "cannot compute", and the caller treated both as "use the maximal range" —
 *   i.e. the over-compression this function exists to prevent.
 */
export function foldEndForTarget(meter, session, config, start, end, windowTokens, options = {}) {
  const nodes = session?.surface?.nodes ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0) return { end: null, skip: false };
  const seqOf = (n) => (typeof n === 'number' ? n : n?.seq);
  const si = nodes.findIndex((n) => seqOf(n) === start);
  if (si < 0) return { end: null, skip: false };
  // `end` may be the string 'auto' — that is what `hostFoldRange` returns, and the host-triggered
  // path passes it straight through. It used to be compared with `===` against numeric seqs, so
  // `findIndex` returned -1 and this function answered `{ end: null, skip: false }` on EVERY host
  // fold. The caller reads that as "cannot compute, keep my own range", so `foldEnd` stayed 'auto'
  // and the fold went to the maximal end — i.e. the compressTargetRatio fix never ran on the path
  // it was written for. Measured 2026-11-22 (`_p0/probe-host-path-target.mjs`): 0 of 37 host
  // ranges produced a target.
  //
  // 'auto' means "as far as the preserved tail allows", which is exactly the bound
  // `autoBalancedEnd` uses (`nodes.length - 1 - preserveRecent`). Resolving it here keeps the two
  // in agreement instead of leaving one of them to interpret the string.
  const ei = Number.isFinite(Number(end)) && typeof end !== 'string'
    ? nodes.findIndex((n) => seqOf(n) === end)
    : nodes.length - 1 - (Number(config?.preserveRecent) || 2);
  if (ei < 0 || ei <= si || ei >= nodes.length) return { end: null, skip: false };

  const measurement = meter?.measure(session);
  const priced = new Map((measurement?.nodes ?? []).map((n) => [n.seq, n.tokens]));
  if (priced.size === 0) return { end: null, skip: false };
  const priceAt = (i) => priced.get(seqOf(nodes[i])) ?? 0;

  // The denominator is the SURFACE total, not `measure().totalTokens`: the fold removes surface
  // nodes, so the arithmetic has to be in the same unit as the per-node prices. Mixing a
  // request-pressure total (which includes the response reservation) with a sum of node prices is
  // the unit mismatch this project keeps hitting.
  //
  // `surfaceTokens` is the official field for exactly this number — `token-meter.md:22-23`:
  // "Total route-priced request tokens across the current surface; equals the sum of the node
  // prices." The implementation agrees by construction (`dsh-token-meter/lib/index.js:762-769`
  // accumulates `surfaceTokens += tokens` inside the same `nodes.map` that returns the prices), so
  // this is the same number the loop below would produce — but it is the number the meter itself
  // reports, so it cannot drift away from the per-node prices it is compared against.
  //
  // The loop stays as a fallback for a host whose meter predates the field; it is not dead code,
  // it is the compatibility path, and it is only taken when the official field is absent.
  let surfaceTotal = Number(measurement?.surfaceTokens);
  if (!Number.isFinite(surfaceTotal) || surfaceTotal <= 0) {
    surfaceTotal = 0;
    for (let i = 0; i < nodes.length; i++) surfaceTotal += priceAt(i);
  }
  if (surfaceTotal <= 0) return { end: null, skip: false };

  const ratio = Number(config?.compressTargetRatio ?? 0.35);
  const basis = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : surfaceTotal;
  const target = Math.round(basis * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.35));

  // How much must this fold remove to land at the target?
  //
  // ⚠ `need` must be measured from `totalTokens`, NOT from `surfaceTotal`, and the difference is
  // not cosmetic. The target is a fraction of the WINDOW, and the number the window is compared
  // against everywhere else — the trigger, the banner, the provider bill — is `totalTokens`, which
  // also carries the tool schemas, the system prompt and the response reservation. `surfaceTotal`
  // is only the message nodes.
  //
  // Measured 2026-11-22 (`_p0/probe-skip-vs-trigger.mjs`): a session at 81.8% of its window
  // (818,090 tokens) had a surface of only 34.4% (343,816). Against a 350,000 target the old
  // arithmetic computed `need = 343,816 - 350,000 < 0` and returned `skip: true` — so a session
  // that was 16.8 points OVER the soft limit was told its surface was "already at the target" and
  // no fold happened at all. Two numbers that are both called tokens, but not the same quantity.
  //
  // The prices below are surface prices, and `need` is "tokens that must leave the context" — the
  // same unit, because a node's price IS the number of context tokens it contributes. So the
  // subtraction is valid; only the minuend was wrong.
  const current = Number(measurement?.totalTokens);
  const need = (Number.isFinite(current) && current > 0 ? current : surfaceTotal) - target;
  // Genuinely at or below the target: the fold would be cosmetic, and `assertFoldWorthIt` would
  // refuse it anyway. Say so explicitly instead of returning a bare null the caller cannot read.
  if (need <= 0) return { end: null, skip: true };

  // Walk forward from the start and stop at the last index that still fits under `need`.
  // That is the SHALLOWEST fold that reaches the target.
  let acc = 0;
  let chosen = -1;
  for (let i = si; i <= ei; i++) {
    const t = priceAt(i);
    if (acc + t > need) break;
    acc += t;
    chosen = i;
  }
  // Even the first node overshoots `need`: the surface is within one node of the target. Fold that
  // one node — the overshoot is bounded by a single node, which is the closest landing available.
  //
  // Returning null here would be WORSE than useless: the caller falls back to its own (maximal)
  // range, i.e. the exact over-compression this function exists to prevent. Whether a one-node fold
  // is worth its cache miss is a different question, and `assertFoldWorthIt` already answers it.
  if (chosen < si) chosen = si;

  const candidate = seqOf(nodes[chosen]);
  // The core refuses a range whose end splits a step's tool-call/result pair. Snap DOWN, never
  // sideways: the snapped end is at or before the chosen one, so the fold only ever removes less.
  //
  // `snapEndDown` is not used here on purpose: it requires `endIdx > startIdx`, so it returns null
  // for a ONE-node fold — which is exactly the case this function produces when the surface is
  // within one node of the target. A null there would send the caller back to its maximal range,
  // i.e. the over-compression being fixed. Walking the balanced-cut set handles both cases.
  const cuts = balancedCutsAfter(nodes, options.eventBySeq ?? new Map());
  for (let i = chosen; i >= si; i--) if (cuts.has(i)) return { end: seqOf(nodes[i]), skip: false };
  // No balanced cut inside the range at all: the caller keeps its own range (skip: false), because
  // "cannot compute" and "already at the target" must not collapse into the same answer.
  return { end: null, skip: false };
}

/**
 * Index of a surface node by SEQ.
 *
 * ⚠ The comment that used to live here said `session.surface.nodes` holds NODE OBJECTS
 * (`{ seq, type, ... }`) and that `nodes.indexOf(seq)` is ALWAYS -1. **That was wrong**, and it
 * drove a whole round of "fixes" to code that was already correct.
 *
 * The official contract is explicit — `docs/subsystems/session.md:406-410`:
 *
 *     interface SessionSurface {
 *       // Current surface event sequences in model-visible order.
 *       readonly nodes: readonly SessionSeq[]
 *     }
 *
 * and measured on this build (`_p0/probe-surface-node-type.mjs`,
 * `_p0/probe-surfacemanager-nodes.mjs`): `foldSurface().nodes` → `number=456`,
 * `SurfaceManager.nodes` → 457 numbers, `indexOf` and `findIndex(seqOf)` both return 228.
 *
 * So `nodes.indexOf(seq)` is CORRECT here. This helper is kept because it is harmless and makes
 * the call sites readable, NOT because the array holds objects. Accepting both shapes costs
 * nothing and survives a future representation change; asserting the wrong one cost a round.
 *
 * @param nodes - surface seqs (or, defensively, node objects).
 * @param seq - the seq to locate.
 * @returns the index, or -1.
 */
function nodeIndex(nodes, seq) {
  if (!Array.isArray(nodes)) return -1;
  const want = typeof seq === 'number' ? seq : seq?.seq;
  if (want == null) return -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const have = typeof n === 'number' ? n : n?.seq;
    if (have === want) return i;
  }
  return -1;
}

function parseLimit(raw) {
  const s = String(raw ?? '65%');
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

// Full session events read from the session FILE (zstd). surface node seqs
// point at original events compaction has shadowed out of the in-memory
// agent.session.events — reading the file recovers real type/preview.
// ---------------------------------------------------------------------------
// Graph ingest runs on a WORKER THREAD.
//
// Parsing a session log is CPU- and memory-bound (155 MB logs hold 278k frames /
// 423k events) and doing it inline froze the harness event loop for seconds on
// every compression. Requests are coalesced: ingest is incremental, so only the
// newest one matters. The worker is unref()'d so it never keeps DSH alive, and a
// missing worker degrades to an inline call rather than losing the checkpoint.
// ---------------------------------------------------------------------------
let ingestWorker = null;
let ingestInFlight = null;
let ingestPending = null;
let ingestSeq = 0;

/**
 * Terminate the ingest worker and drop its queue.
 *
 * The worker is unref()'d so it never holds the HARNESS open — but its MessagePort is still an
 * active handle, so any short-lived embedding (a test process, a CLI) that triggers one fold will
 * hang at exit with ["PipeWrap","PipeWrap","MessagePort"] and no error. Unload/teardown calls this.
 */
export function dispose() {
  try {
    if (ingestWorker != null) ingestWorker.terminate();
  } catch { /* the worker may already be gone */ }
  ingestWorker = null;
  ingestInFlight = null;
  ingestPending = null;
}

function postIngest(req) {
  const w = ingestWorker;
  if (w === null) { try { autoIngestSession(req.sessionId, req.cwd); } catch { /* inline fallback */ } return; }
  ingestInFlight = req;
  try { w.postMessage(req); } catch (e) {
    ingestInFlight = null;
    console.warn('[dsh-session-handoff] ingest post failed:', String(e?.message ?? e));
    try { autoIngestSession(req.sessionId, req.cwd); } catch { /* ignore */ }
  }
}

function ingestWorkerInstance() {
  if (ingestWorker !== null) return ingestWorker;
  if (typeof Worker !== 'function') return null;
  try {
    const w = new Worker(new URL('./ingest-worker.js', import.meta.url));
    w.unref(); // a pending ingest must never hold the harness open
    w.on('message', (msg) => {
      ingestInFlight = null;
      if (msg && msg.ok) {
        const r = msg.result ?? {};
        if (r.added > 0 || r.unchanged !== true) {
          console.warn('[dsh-session-handoff] graph ingest (worker): added=' + (r.added ?? 0) + ' bytes=' + (r.bytesParsed ?? 0) + ' in ' + msg.ms + 'ms');
        }
      } else {
        console.warn('[dsh-session-handoff] graph ingest (worker) failed:', String(msg && msg.error));
      }
      if (ingestPending !== null) { const next = ingestPending; ingestPending = null; postIngest(next); }
    });
    w.on('error', (e) => {
      console.warn('[dsh-session-handoff] ingest worker error:', String(e?.message ?? e));
      try { w.terminate(); } catch { /* ignore */ }
      ingestWorker = null; ingestInFlight = null;
    });
    w.on('exit', () => { ingestWorker = null; ingestInFlight = null; });
    ingestWorker = w;
    return w;
  } catch (e) {
    console.warn('[dsh-session-handoff] cannot start ingest worker:', String(e?.message ?? e));
    return null;
  }
}

/** Queue one incremental graph ingest and return immediately. */
function scheduleIngest(sessionId, cwd) {
  if (!sessionId) return;
  const req = { id: ++ingestSeq, sessionId: String(sessionId), cwd: cwd ?? undefined };
  ingestWorkerInstance();
  if (ingestInFlight !== null) { ingestPending = req; return; }
  postIngest(req);
}

const sessionFileCache = new Map(); // kind -> Map(sessionId -> { stamp, byteOffset, bySeq })
/** Per-projection bucket: the full and light indexes must never evict each other. */
function cacheBucket(kind) {
  let m = sessionFileCache.get(kind);
  if (!m) { m = new Map(); sessionFileCache.set(kind, m); }
  return m;
}
const EMPTY_SEQ_MAP = new Map();

/**
 * Cached seq index of a session FILE, built incrementally.
 *
 * The previous version cached by mtime only and rebuilt by reading + parsing the
 * WHOLE log on every miss - on a live session the mtime changes constantly, so
 * a 155 MB / 423k-event log was re-read (5 s, ~1 GB) again and again. Session
 * logs are append-only, so only the bytes appended since the last consumed frame
 * are decoded now, and an unchanged file returns the cache without any read.
 *
 * @param project - maps one parsed event to the stored value (undefined drops it).
 */
function sessionFileIndex(session, project, kind) {
  try {
    const id = session?.id;
    if (!id) return EMPTY_SEQ_MAP;
    const path = sessionFilePath(id, session?.header?.cwd ?? process.cwd());
    if (!path) return EMPTY_SEQ_MAP;
    const stamp = fileStamp(path);
    const bucket = cacheBucket(kind);
    const hit = bucket.get(id);
    if (hit && hit.stamp.size === stamp.size && hit.stamp.mtimeMs === stamp.mtimeMs && hit.stamp.prefixHash === stamp.prefixHash) return hit.bySeq;
    const resume = Boolean(hit) && hit.stamp.prefixHash === stamp.prefixHash && hit.byteOffset <= stamp.size;
    const from = resume ? hit.byteOffset : 0;
    const bySeq = resume ? hit.bySeq : new Map();
    const scan = readSessionEventsIncremental(path, from);
    for (const e of scan.events) {
      if (!e || e.seq == null) continue;
      const v = project(e);
      if (v !== undefined) bySeq.set(Number(e.seq), v);
    }
    bucket.set(id, { stamp, byteOffset: scan.consumedBytes, bySeq });
    return bySeq;
  } catch { return EMPTY_SEQ_MAP; }
}

/** Test seam: exercise the incremental file index without a live session. */
export { sessionFileIndex as __sessionFileIndex, scheduleIngest as __scheduleIngest };

/** Full events by seq (handoff export needs complete payloads). */
function getSessionFileEvents(session) { return sessionFileIndex(session, (e) => e, 'full'); }

/** Light seq -> { type, text } projection for the surface dump. */
function getSessionFileIndex(session) {
  return sessionFileIndex(session, (e) => ({ type: e.type, text: truncateText(eventText(e), 120) }), 'light');
}

function surfaceNodes(ctx, session) {
  const priced = new Map((ctx.get('tokenMeter')?.measure(session)?.nodes ?? []).map((n) => [n.seq, n.tokens]));
  const mem = sessionEvents(session);
  const file = getSessionFileIndex(session);
  const memBySeq = new Map();
  for (const e of mem) if (e && e.seq != null) memBySeq.set(Number(e.seq), e);
  const lookup = (seq) => file.get(seq) ?? memBySeq.get(seq); // file first (has shadowed originals)
  // 診斷線：預設**不印**。它會把 session id、事件數、完整路徑與前三個 probe seq 寫到 stderr，
  // 而 surfaceNodes() 每個 session 都會被呼叫一次 —— 所以開機時每個開過的 session 各噴一行，
  // 連**別的 session**（例如另一個工作區的長會話）也會一起被印出來。
  // 那是診斷，不是狀態；要看就 DSH_SESSION_HANDOFF_DIAG=1（與 _p0 的 LP-1 同一個做法）。
  if (!surfaceNodes._diag && process.env.DSH_SESSION_HANDOFF_DIAG === '1') {
    surfaceNodes._diag = true;
    try {
      const id = session?.id;
      const probe = (session.surface?.nodes ?? []).slice(0, 3);
      console.warn('[dsh-session-handoff][diag] session=' + id +
        ' fileMap=' + file.size + ' memMap=' + memBySeq.size +
        ' surfaceN=' + (session.surface?.nodes ?? []).length +
        ' path=' + sessionFilePath(id, session?.header?.cwd ?? process.cwd()) +
        ' probe=' + JSON.stringify(probe.map((s) => [s, file.get(s)?.type ?? 'MISS'])));
    } catch (e) { console.warn('[dsh-session-handoff][diag] failed:', String(e?.message ?? e)); }
  }
  return (session.surface?.nodes ?? []).map((seq) => {
    const event = lookup(seq);
    return {
      seq,
      type: event?.type ?? 'unknown',
      tokens: priced.get(seq) ?? 0,
      preview: truncateText(event && typeof event.text === 'string' ? event.text : eventText(event), 72),
    };
  });
}

export function renderStatus(ctx, agent, config, windowTokens, completionBudget, opts = {}) {
  const used = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
  const { min: minTokens, hard: maxTokens } = effectiveLimits(config, windowTokens, completionBudget);
  const level = pressureLevel(used, minTokens, maxTokens);
  // Quiet mode IS the production per-turn banner: the sh:acp:surface section calls this
  // function, so these wording tests cover the text the user actually sees. It used to be a
  // second, hand-rolled copy inside that section while the tests exercised this one — the tests
  // passed against a string nobody rendered, which is how the banner lost its window (and its
  // soft/hard limits) without a single failing test.
  if (opts.quiet) {
    // Lead with the WINDOW percentage. A bare "100%" measured against the soft limit reads as
    // "the context is full" and is simply false — the window is 1M here, so a context at the
    // 730k soft limit is 73% full, not 100%.
    const pctWindow = Number.isFinite(windowTokens) && windowTokens > 0 ? Math.round((used / windowTokens) * 100) : null;
    // "soft limit 730000 = 75%" was read as "the soft limit IS 75%": the ratio and the threshold
    // sat side by side with no separator of meaning. Headroom cannot be misread.
    const parts = [];
    if (pctWindow != null) parts.push(pctWindow + '% of the window');
    // The HARD ceiling is the wall, so it carries the only number that answers "how much room do I
    // have". The soft number used to carry it instead ("soft limit 780000 — ~24k left") and models
    // read that as their remaining context: near the trigger they went conservative and stopped a
    // turn to ask the user for permission to compact. The budget is the ceiling; say so with it.
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      const room = Math.max(0, maxTokens - used);
      parts.push(room > 0 ? 'hard ceiling ' + maxTokens + ' — ' + Math.round(room / 1000) + 'k of room' : 'hard ceiling ' + maxTokens + ' — reached');
    }
    // The soft limit is a trigger the agent owns, not a second cap, and the line must survive any
    // reading of it as a budget — so the number and the denial travel together.
    if (Number.isFinite(minTokens) && minTokens > 0) {
      // No "Nk ahead" number here. It was read as a BUDGET, verbatim, in a real session:
      // "Budget: ~7k tokens before the soft trigger - I'm at the limit" -> the agent wrapped the turn
      // up and promised a compaction that the host then never performed (the session hovered 4k under
      // the trigger). A small number sitting next to a limit word will be read as runway, whatever
      // preposition follows it, so this line carries the STATE and the denial - never the distance.
      parts.push('soft trigger ' + minTokens + (minTokens - used > 0
        ? ' (fold when you pass it, it is not a cap)'
        : ' (passed - fold now; not a cap)'));
    }
    // An unknown window used to render as a bare token count — no percentage, no limits, and no
    // hint that anything was wrong. Name the failure so it gets fixed instead of merely observed.
    const diag = windowTokens == null ? ' [window unknown: ' + (opts.windowDiag ?? 'unknown') + ']' : '';
    // The action sentence follows the LEVEL. It used to be the constant "below soft limit, no
    // compaction needed" — printed even past the trigger, because the level was computed here and
    // then never read. That contradicted the instruction section (fold when you pass it) and left
    // models stopping to ask the user what to do about compaction.
    const action = level === 'hard'
      ? 'past the HARD ceiling: compress before any other work with acp_compress end:auto; do not start new exploration and do not ask the user.'
      : level === 'soft'
        ? 'past the soft trigger: fold now with acp_compress end:auto (deep by default), then continue — your own call, never a question for the user.'
        : 'below the trigger: keep working; folding spent ranges is your own call and never a question for the user.';
    return 'ACP: ' + used + (windowTokens ? '/' + windowTokens : '') + ' tokens' + (parts.length ? ' (' + parts.join('; ') + ')' : '') + diag + ' — ' + action;
  }
  const nodes = surfaceNodes(ctx, agent.session);
  const growth = estimateGrowth(ctx, agent);
  let forecast = '';
  if (Number.isFinite(maxTokens) && growth != null && growth > 0) {
    const turnsLeft = Math.max(0, Math.floor((maxTokens - used) / growth));
    forecast = `\nestimated: ~${turnsLeft} turns until hard limit (growth ≈ ${Math.round(growth / 1000)}k/turn${used >= minTokens ? ', compress spent ranges now' : ''})`;
  }
  const lines = [
    `context: ${used}${windowTokens ? ` / ${windowTokens}` : ''} tokens (level ${pressureLevel(used, minTokens, maxTokens)})`,
    `limits: soft trigger ${minTokens === Infinity ? 'n/a' : minTokens} (fold when passed — not a cap), hard ceiling ${maxTokens === Infinity ? 'n/a' : maxTokens}`,
    `surface nodes: ${nodes.length}`,
    ...nodes.map((n) => `  s${n.seq} ${n.type} [${n.tokens}] ${n.preview}`),
  ];
  return lines.join('\n') + forecast;
}

function assertSafeRange(session, start, end, config) {
  const nodes = session.surface?.nodes ?? [];
  const startIdx = nodeIndex(nodes, start);
  const endIdx = nodeIndex(nodes, end);
  if (startIdx < 0) throw new Error(`start seq ${start} is not on the current surface`);
  if (endIdx < 0) throw new Error(`end seq ${end} is not on the current surface`);
  // Node 0 IS the system prompt, and the core refuses a replace that begins there:
  //   "surface replace: node 0 holds the system prompt and may be rewritten only by a
  //    system/message over exactly that node"
  // Measured 2026-11-21 (_p0/measure-fold-failures.mjs): 5 compaction/end events carry exactly
  // that error, all from 2026-08/09. `hostFoldRange` starts at index 1 so the HOST-triggered path
  // was safe, but `acp_compress` takes a caller-supplied start and nothing stopped it from being
  // node 0 -- the fold then failed at the core, after the caller had already announced it.
  if (startIdx === 0) {
    throw new Error(
      `start seq ${start} is surface node 0 (the system prompt); a fold must begin at node 1 or later`,
    );
  }
  if (startIdx > endIdx) throw new Error(`start seq ${start} is after end seq ${end} on the surface`);
  const lastAllowed = nodes.length - 1 - (config.preserveRecent ?? 2);
  if (endIdx > lastAllowed) throw new Error(`cannot compress the last ${config.preserveRecent} surface node(s)`);
}

/**
 * Who decides that a compaction must happen?
 *
 * It used to be the model, every time: the banner asked, and if the model did not act nothing
 * happened. That is not a policy, it is a hope -- and it failed silently for the whole life of the
 * feature (the window cache threw ReferenceError into an empty catch, so `used >= soft` was never
 * true and the banner could not even ask). No audited peer works this way: Letta triggers inside
 * the agent step off a message-count buffer with retries, LangGraph ships no auto-compaction,
 * Zep/mem0 compact nothing. The host owns the trigger; the model keeps owning the RANGE.
 *
 * Pure and exported so the policy is a tested decision, not a condition buried in a hook.
 */
export function compactionDecision(used, soft, hard, opts = {}) {
  if (opts.hostTrigger === false) return "none";
  const forceAt = opts.forceAt === "soft" ? soft : hard;
  if (!Number.isFinite(used) || !Number.isFinite(forceAt) || forceAt <= 0) return "none";
  return used >= forceAt ? "force" : "none";
}

/**
 * A compaction that does not shrink the context is a BUG, not a no-op. Without this assertion the
 * honest outcome of a failed fold is "the banner keeps saying you are over the limit", which looks
 * exactly like a model that keeps ignoring it.
 */
export function foldShrank(before, after, minRatio = 0.05) {
  const need = Math.max(1000, Math.round((Number.isFinite(before) ? before : 0) * minRatio));
  if (!Number.isFinite(before) || !Number.isFinite(after)) return { ok: false, freed: 0, need, reason: "unmeasurable" };
  const freed = before - after;
  return { ok: freed >= need, freed, need, reason: freed >= need ? "" : `only ${Math.max(0, freed)} tokens freed, needed ${need}` };
}

/**
 * The first surface node that carries a HUMAN message, or null.
 *
 * `user/message` is a CONTAINER, not a content type: measured on one 8-day session, 85.6% of
 * `user/message` chars were `runtime-context` injections wearing the user's clothes, and the human's
 * own words were 0.08% of the surface. So "the first user message" is the wrong question — the
 * discriminator is `source.kind === 'user'`.
 *
 * Why this matters for folding: the human's opening instruction is the single most
 * non-reconstructable thing on the surface. Everything else can be re-read, re-run, or recomputed;
 * that cannot. Prior art (`Evaluating Memory Condensation Strategies for Coding Agents`,
 * arXiv 2605.18854) names this parameter `keep_first` and always preserves it. Measured here before
 * the fix: 9 of 9 compacted sessions had their first human message folded away.
 *
 * @param nodes - surface nodes, each with `seq`, `type`, and optionally `source`.
 * @returns the seq of the first human message, or null when the surface holds none.
 */
export function firstHumanSeq(nodes) {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (node?.type !== 'user/message') continue;
    if (node?.source?.kind === 'user') return node.seq;
  }
  return null;
}

/**
 * The range a host-triggered fold may touch. Pure, so the RANGE is a tested decision too.
 *
 * Surface node 0 IS the system prompt, and the host rewrites that node only through a
 * system/message over exactly that node. Handing the host a range that begins there is refused
 * outright ("surface replace: node 0 holds the system prompt and may be rewritten only by a
 * system/message over exactly that node"): the fold does nothing, the context does not shrink,
 * and from the outside it looks exactly like a trigger that never fired at all. So a host fold
 * starts at the first node AFTER the system prompt and ends at the pairing-balanced boundary
 * runCompaction derives for 'auto'.
 *
 * `keepFirst` (a seq) raises the start past the human's opening instruction. Without it the fold
 * begins at nodes[1] and eats that instruction — measured: 9 of 9 compacted sessions lost it.
 *
 * Returns { start, end } or null when the surface holds nothing safe to fold.
 */
export function hostFoldRange(nodes, preserveRecent = 2, options = {}) {
  if (!Array.isArray(nodes)) return null;
  const pr = Number.isFinite(preserveRecent) ? preserveRecent : 2;
  // index 0 (system prompt) + nodes[1] as the start + at least one end node before the preserved
  // tail: fewer than pr + 3 nodes means there is no range to hand over at all.
  if (nodes.length < pr + 3) return null;
  let startIdx = 1;
  const keepFirst = options?.keepFirst;
  if (Number.isFinite(keepFirst) && keepFirst > 0) {
    // `nodes` holds SEQS (docs/subsystems/session.md:410), so `indexOf(seq)` would be correct.
    // The comment here used to claim the array held node objects — never measured, and false on
    // this build. The `seqOf` form is kept because it is correct under both representations.
    const at = nodes.findIndex((n) => (typeof n === 'number' ? n : n?.seq) === keepFirst);
    // The protected node must still be on the surface; if it is not, the caller's seq is stale and
    // silently ignoring it would be worse than honouring the default.
    if (at >= 0) startIdx = Math.max(startIdx, at + 1);
  }
  // The last foldable index is the one before the preserved tail.
  const lastAllowed = nodes.length - 1 - pr;
  if (startIdx > lastAllowed) return null;
  return { start: nodes[startIdx], end: 'auto' };
}

/**
 * Is a recorded fold failure still describing reality? A failure note is a statement about the
 * CURRENT pressure: once the context is back under the soft limit (whoever folded it), the note is
 * stale, and a banner that keeps announcing a failed fold while the window is 9% full is exactly
 * how the model learns to ignore the banner.
 */
export function foldFailureStale(failure, used, soft) {
  return failure != null && Number.isFinite(used) && used < soft;
}

/**
 * The acp_compress parameter contract, at module scope so it is a tested artifact instead of prose
 * buried in a registration call. Two constraints here are load-bearing, and both were learned the
 * hard way:
 *
 *  - `required: false` must never be written: the host's schema compiler rejects the key outright
 *    ("parameters.X.required must be true when present") and the whole plugin tree then fails to
 *    load. Omit the key for an optional parameter.
 *  - `end` MUST admit the string 'auto'. The pressure banner orders the model to
 *    `call acp_compress end:auto`, so a declaration that accepts only an integer makes the
 *    plugin's own instruction impossible to follow — observed live as
 *    `invalid arguments: "end" must be an integer`, with the model then hand-deriving a range
 *    that runCompaction derives better. runCompaction has understood 'auto' all along; only the
 *    declaration refused it. oneOf is the host's supported union form (a `type` array is not,
 *    and `type` may not sit beside oneOf).
 */
const ACP_COMPRESS_PARAMETERS = {
  start: { type: 'integer', description: 'Inclusive first surface seq (omit with deep to fold from as far back as the target needs)' },
  end: {
    required: true,
    oneOf: [
      { type: 'integer', description: 'Inclusive last surface seq' },
      { type: 'string', description: "'auto' = the pairing-balanced boundary nearest the preserved tail" },
    ],
  },
  deep: { type: 'boolean', description: 'Extend the range backwards so the folded surface lands near compressTargetRatio (default true; pass false for an exactly-scoped fold)' },
  summary: { type: 'string', required: true, description: 'Dense checkpoint the next turn will see instead of this range' },
  topic: { type: 'string', description: 'Short label' },
};

function registerAcpTools(ctx, config, pending, windows, completionBudgets) {
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
    name: 'acp_shrink',
    description: 'Shrink spent tool results in place — no model call, no summary, no surface-wide fold. Each large old tool output becomes its head, its tail, and a marker naming the seq that still holds the original in the session log. This is the cheapest lever on the CARRYING cost that dominates the prompt bill: measured on our two heaviest sessions, 79-87% of billed prompt tokens were cache reads re-sending context, against ~0.27M miss-equivalents for one fold. Runs automatically on the protected-tail boundary when shrinkToolResults is on; call it now to shrink a batch.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum results to shrink this call (default: shrinkMaxPerStep)' },
      minTokens: { type: 'integer', description: 'Only results at least this large (default: shrinkMinTokens)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = exec?.agent;
      if (agent?.session == null) return 'acp_shrink: no session on this call';
      const before = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
      const done = shrinkSpentResults(ctx, agent, {
        ...config,
        shrinkToolResults: true,
        shrinkMinTokens: args?.minTokens ?? config.shrinkMinTokens,
        shrinkMaxPerStep: args?.limit ?? config.shrinkMaxPerStep,
      });
      const after = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? before;
      if (done === 0) {
        return 'acp_shrink: nothing to shrink — no tool result past the protected tail ('
          + (config.shrinkProtectedTail ?? 4) + ' nodes) is both >= ' + (args?.minTokens ?? config.shrinkMinTokens)
          + ' tokens and still unshrunk';
      }
      return 'acp_shrink: ' + done + ' tool result(s) shrunk — ' + before + ' → ' + after + ' tokens (freed '
        + Math.max(0, before - after) + '); originals stay in the session log and each marker names its seq';
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_status',
    description: 'Show ACP usage, surface seq map, and the exact shadowed range of every checkpoint (what acp_decompress accepts).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec);
      const w = windows.get(agent.session) ?? await resolveWindow(ctx, agent);
      const { plane } = resolveCompaction(exec);
      const cache = readSessionCache(agent?.session?.id);
      const stats = compactionLedger.get(agent?.session?.id) ?? { count: 0, lossTokens: 0, lossCost: 0 };
      // Proposal A: ratio, absolute cap and UNIT on one line; L1-L4 below; pooled beside this
      // session. The JOURNAL is what makes the pooled view (and survival across a restart)
      // possible - the in-process ledger alone could never answer "is this session typical?".
      const sessionId = agent?.session?.id;
      const used = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
      const { min: softTokens, hard: hardTokens } = effectiveLimits(config, w, completionBudgets.get(agent.session));
      const journal = readMetrics({ limit: 5000 });
      const block = statusBlock({
        usedTokens: used, windowTokens: w, softTokens, hardTokens,
        windowReason: w == null ? (await resolveWindowInfo(ctx, agent))?.reason : undefined,
        surfaceNodes: surfaceNodes(ctx, agent.session).length, collapsedNodes: stats.count,
        billed: cache == null ? null : { hits: cache.hits, misses: cache.misses, hitRate: cache.hitRate },
        rows: journal.rows, retrieval: readRetrievalSignals({ limit: 500 }), sessionId,
      });
      // The checkpoint table is rendered HERE, next to the same journal the ledger is built from:
      // its absence was the gap that left a model re-deriving a range acp_decompress would refuse.
      const checkpoints = formatCheckpointLines(journal.rows, sessionId);
      return `compaction backend: ${plane}\n` + renderStatus(ctx, agent, config, w, completionBudgets.get(agent.session))
        + `\n` + block.lines.join('\n')
        + `\n` + (cache ? formatCacheLine(cache, config.cacheHitPriceRatio) : 'prefix cache: not recorded for this session yet')
        + (block.session.compactions > 0
            ? `\ncompactions this session: ${block.session.compactions} in the journal`
              + (stats.count === block.session.compactions ? '' : ` (${stats.count} in this process - a restart resets that ledger)`)
              + `, ≈${block.session.lossTokens} tokens / ≈${block.session.lossCostCNY.toFixed(3)} of cache re-sent uncached after a fold (ESTIMATED from the post-fold context — rows written before v0.18.4 priced the pre-fold one and read high); each fold opens a new request series`
              + (block.session.settled > 0
                  ? `; MEASURED: ${block.session.settledUncached} uncached + ${block.session.settledCached} cached tok billed across ${block.session.settled} settled fold(s)`
                  : '')
            : `\ncompactions this session: none recorded`)
        + (checkpoints.length > 0 ? '\n' + checkpoints.join('\n') : '')
        + (journal.skipped ? `\njournal: ${journal.skipped} unreadable line(s) skipped (${journal.path}) - a metrics read never fails a status call` : '');
    },
  }));

  /**
   * M1: after a compaction, capture large tool-output originals under the
   * shadowed range into the lossless block store (acp_block_originals) so any
   * compressed block stays recoverable verbatim. Returns count stored.
   */
  function storeCompressedBlocks(ctx, agent, result) {
    try {
      const db = graphOpenDb();
      if (db == null) return 0;
      try {
        // Two bugs in one line, both silent: `session.events` does not exist on a harness session
        // (so this capture never stored anything, and reported "blocks saved: 0" as if the folded
        // range held nothing worth keeping), and indexing the events ARRAY by seq reads the wrong
        // event whenever seq != array position. Both are fixed by the accessor + a seq map.
        const events = sessionEvents(agent?.session);
        const bySeq = new Map();
        for (const ev of events) if (ev != null && ev.seq != null) bySeq.set(Number(ev.seq), ev);
        const seqs = result?.shadowedSeqs ?? [];
        let stored = 0;
        for (const seq of seqs) {
          const ev = bySeq.get(Number(seq));
          if (!ev || ev.type !== 'tool/result') continue;
          const d = ev.data ?? {};
          // raw output: prefer data.text (full), else JSON of data
          const raw = typeof d.text === 'string' ? d.text : (d.output != null ? (typeof d.output === 'string' ? d.output : JSON.stringify(d.output)) : JSON.stringify(d));
          if (typeof raw !== 'string' || raw.length < 200) continue;
          const kind = String(d.name ?? 'tool');
          const r = storeBlock(db, { sessionId: agent.session?.id ?? 'session', seq: Number(seq), kind, text: raw });
          if (r && !r.duplicate) stored++;
        }
        return stored;
      } finally { db.close(); }
    } catch { return 0; }
  }

  /**
   * ONE owner for "fold a range": range selection, safety assertions, the compaction call and all
   * after-care. The acp_compress TOOL and the host-owned trigger below both come through here.
   * Two hand-rolled copies of a procedure is how this plugin once ended up with a banner the tests
   * never rendered; the trigger must not become a second copy of the fold either.
   *
   * summary == null is meaningful: the compaction service then uses its OWN summarizer, which is
   * what makes a host-triggered fold possible at all (the model is not in the loop to write one).
   */
  /**
   * The pairing-balanced end seq the core accepts, nearest the preserved tail.
   *
   * ⚠ This used to pick "the last node priced at <= 150 tokens", and its comment claimed that was
   * "the same rule `end: 'auto'` uses (a tool result or usage node closes a step...)". That claim
   * was never measured and is false: PRICE has nothing to do with tool-call/result PAIRING. A cheap
   * node can sit in the middle of an open step, and a large one can close it.
   *
   * Measured 2026-11-22 (`_p0/probe-auto-end-balance.mjs`, 37 real surfaces): the price rule picked
   * an end the core REFUSES on **6 of 37 (16.2%)**. That is the source of the
   * "not a balanced boundary" refusals `measure-fold-failures` counted — not a caller guessing
   * wrong, but this function choosing an unbalanced end and relying on `snapEndDown` to rescue it.
   *
   * The rule is now the one the comment always claimed: the last BALANCED cut at or before
   * `lastAllowed`. `balancedCutsAfter` is the same predicate the core applies
   * (`dsh-compaction-basic/lib/index.js:558`), so the end this returns is one the core accepts.
   */
  function autoBalancedEnd(agent, start) {
    const nodes = agent.session?.surface?.nodes ?? [];
    const si = nodeIndex(nodes, Number(start));
    if (si < 0) return NaN;
    const lastAllowed = nodes.length - 1 - (config.preserveRecent ?? 2);
    if (lastAllowed <= si) return NaN;
    const live = new Map();
    for (const ev of sessionEvents(agent.session)) if (ev?.seq != null) live.set(Number(ev.seq), ev);
    const cuts = balancedCutsAfter(nodes, live);
    // Walk back from the preserved tail to the first balanced cut strictly after the start.
    for (let i = lastAllowed; i > si; i--) {
      if (!cuts.has(i)) continue;
      const seq = typeof nodes[i] === 'number' ? nodes[i] : nodes[i]?.seq;
      if (Number.isFinite(seq)) return seq;
    }
    // No balanced cut inside the range: the caller must not get a guessed end. NaN makes
    // `runCompaction` fail loudly instead of handing the core a range it will refuse.
    return NaN;
  }

  /** Prompt tokens inside an inclusive surface range, from the token meter's own per-node pricing. */
  function rangeTokens(agent, startSeq, endSeq) {
    const nodes = agent.session?.surface?.nodes ?? [];
    const a = nodeIndex(nodes, Number(startSeq));
    const b = nodeIndex(nodes, Number(endSeq));
    if (a < 0 || b < 0) return 0;
    return (ctx.get('tokenMeter')?.measure(agent.session)?.nodes ?? [])
      .filter((n) => { const i = nodeIndex(nodes, n.seq); return i >= a && i <= b; })
      .reduce((sum, n) => sum + n.tokens, 0);
  }

  /**
   * A fold pays back only if it removes a REAL share of the context.
   *
   * The miss it forces is proportional to the whole post-fold prompt; the saving is proportional to the
   * folded range and accrues at the cache-hit price (2% of a miss). Break-even is ~49 x
   * (context / folded) later requests, so a cosmetic fold never pays — measured on a live probe, a
   * 596-token fold of a 507k context cost 0.497 CNY of re-sent context to save ~12 tokens per request
   * (a 41,700-request payback). Refusing it is the honest answer, and the message carries the why.
   */
  function assertFoldWorthIt(agent, startSeq, endSeq, tokens) {
    const contextTokens = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
    if (contextTokens <= 0) return;
    const minShare = Number(config.minFoldRatio ?? 0.1);
    const share = tokens / contextTokens;
    if (share >= minShare) return;
    throw new Error(`this fold would remove ~${tokens} of ~${contextTokens} tokens (${(share * 100).toFixed(1)}%)`
      + ` and force one full-prefix miss (~${Math.round(contextTokens * 0.98)} tokens re-sent) to save ~${Math.round(tokens * 0.02)} per request`
      + ` — break-even is ~${Math.round(49 * contextTokens / Math.max(1, tokens))} later requests, which no session reaches.`
      + ` Fold a range worth at least ${Math.round(minShare * 100)}% of the context, or pass deep:true to extend it backwards.`);
  }

  async function runCompaction(agent, opts) {
    const { service: compaction, plane } = resolveCompaction(opts.exec);
    if (compaction == null || typeof compaction.compactRegion !== 'function') {
      throw new Error(`acp_compress needs the compaction service (found on: ${plane}); load @deepseek-ai/dsh-compaction-basic`);
    }
    let start = Number(opts.start);
    let end = Number(opts.end);
    if (Number.isNaN(end) || String(opts.end ?? '').trim().toLowerCase() === 'auto') {
      // auto: the last PAIRING-BALANCED cut at or before the preserved tail.
      //
      // ⚠ This used to say "the nearest node priced at <= 150 tokens (a tool result or usage node
      // closes a step)". Price is not pairing: measured on 37 real surfaces, that rule picked an
      // end the core refuses on 6 of them (16.2%) — `_p0/probe-auto-end-balance.mjs`. The comment
      // described a rule the code did not implement, and the code's rule was wrong.
      end = autoBalancedEnd(agent, start);
    }
    // Deep fold: one compaction already costs a full-prefix miss, so reach back as far as
    // the target needs instead of leaving the surface just under the soft limit.
    let foldedFrom = null;
    if (opts.deep !== false && Number.isFinite(start)) {
      const candidate = deepFoldStart(ctx.get('tokenMeter'), agent.session, config, start, end, windows.get(agent.session) ?? null);
      if (Number.isFinite(candidate) && candidate !== start) {
        try { assertSafeRange(agent.session, candidate, end, config); foldedFrom = start; start = candidate; }
        catch { /* an unbalanced extension must never override the caller's range */ }
      }
    }
    if (!Number.isFinite(start)) throw new Error('start is required (or pass deep to derive it)');
    assertSafeRange(agent.session, start, end, config);
    const meter = ctx.get('tokenMeter');
    // A range that is too small to be worth folding must be refused EVEN WITHOUT a token meter.
    //
    // Both guards used to live inside `if (meter != null)`, so a context without the token-meter
    // service skipped them entirely and could fold a 10-token range -- paying one full-prefix
    // miss to save almost nothing. The meter is the accurate measure; the node count is the
    // fallback that keeps the guard from disappearing.
    if (meter == null) {
      const nodes = agent.session?.surface?.nodes ?? [];
      const a = nodeIndex(nodes, start);
      const b = nodeIndex(nodes, end);
      const nodeCount = a >= 0 && b >= a ? b - a + 1 : 0;
      if (nodeCount < 2) {
        throw new Error(
          `range ${start}-${end} covers ${nodeCount} surface node(s); a fold needs at least 2 `
            + '(no token meter is available to price it more precisely)',
        );
      }
    }
    if (meter != null) {
      // `selected` used to be computed here and never read: a filter that re-derived
      // nodeIndex(start) and nodeIndex(end) on EVERY iteration (O(n^2)) and then threw the
      // result away. Removed rather than left as a comment -- dead code that looks like a
      // guard is worse than no code, because the next reader assumes something depends on it.
      const tokens = rangeTokens(agent, start, end);
      if (tokens < config.minTokens) throw new Error(`range is only ~${tokens} tokens; minTokens is ${config.minTokens}`);
      // A fold pays back only if it removes a REAL share of the context. The miss it forces is
      // proportional to the whole post-fold prompt, while the saving is proportional to the folded
      // range and accrues at the cache-hit price (2% of a miss, per DeepSeek's table). Break-even is
      // ~49 x (context / folded) later requests, so a cosmetic fold never pays: measured on a live
      // probe, a 596-token fold of a 507k context cost 0.497 CNY of re-sent context to save ~12
      // tokens per request — a 41,700-request payback. Refusing it is the honest answer.
      assertFoldWorthIt(agent, start, end, tokens);
    }
    // Price the edit before making it: replacing a surface range forces the host to
    // re-project the system prompt and start a new request series, so the next call
    // re-sends the whole prompt at the cache-miss rate.
    const promptTokens = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
    // Counters BEFORE the edit: the delta read on the next pre-step is this fold's real cache bill.
    const cacheAtFold = readSessionCache(agent?.session?.id);
    if (opts.summary != null) pending.set(agent.session, opts.summary);
    // Extract the human's own words BEFORE the fold: once compactRegion lands, those events are
    // shadowed and the surface no longer carries them. Measured over 150 sessions and 2,944 folded
    // human messages, 87.1% of the long decision-bearing ones lost their content — the official
    // summary prompt has eight sections and none of them asks for the user's words. Human messages
    // are 0.08% of the surface, so keeping every one verbatim is nearly free.
    let humanBlock = '';
    try {
      const events = sessionEvents(agent.session);
      const records = extractHumanDecisions(events, { start, end });
      // 32000, not 8000. Measured over 7 sessions with 247 decision-bearing messages
    // (_p0/measure-decision-budget.mjs): an 8,000-char cap kept only 51.8% of them, 16,000 kept
    // 81.0%, and 32,000 kept 100%. The mean decision text per session is 13,999 chars, so 32,000
    // covers the worst case with room for the recent non-decision messages too.
    //
    // Cost check: 32,000 chars is ~8,000 tokens, against a fold that saves ~400,000 tokens --
    // 2%. The cap exists to stop runaway growth, not to save money; setting it below what the
    // decision messages need defeats the mechanism it is protecting.
    //
    // `events` is passed so the block is grouped BY TURN (what was asked -> what was done ->
    // what came out) instead of a flat list of messages with seq pointers. Measured over 138
    // sessions / 22 folds / 264 folded human messages: every turn holds exactly one human message
    // (264/264), the seq pointer cost ~120 chars per message against a p50 36-char message, and it
    // was never dereferenced (acp_search: 0 calls in 316 folds). Turn grouping costs 0.73% of what
    // the fold saves and records the correspondence instead of a reference nobody follows.
    humanBlock = renderHumanDecisions(records, { maxChars: config.humanMessageMaxChars ?? 32000, events });
    } catch { /* extraction must never block a fold the caller already decided on */ }
    try {
      const t0 = Date.now();
      // A guessed `end` that would split a step is refused by the core ("not a balanced boundary"),
      // which turned a fold the agent had ALREADY decided on into a dead end: it told the user a
      // compaction was coming and none did (a real session's last fold attempt died exactly here).
      // Retry once at the balanced boundary end:'auto' would have chosen. The range only ever shrinks
      // (the boundary is at or before the refused end), so this can never fold more than asked.
      let snappedNote = '';
      let result;
      try {
        result = await compaction.compactRegion(start, end, agent, opts.signal);
      } catch (err) {
        const reason = String(err?.message ?? err);
        // Snap DOWN, never sideways. The nearest balanced cut at or BEFORE the requested end keeps the
        // retry a SUBSET of the caller's range; `end: 'auto'` picks the boundary nearest the preserved
        // TAIL instead, which for a small requested range would fold far more than was asked for.
        // Live surface events are the right source here (the nodes in the range are current by
        // definition), and unlike the file index they exist for a session that was never flushed.
        const live = new Map();
        for (const ev of sessionEvents(agent.session)) if (ev?.seq != null) live.set(Number(ev.seq), ev);
        const fallback = snapEndDown({
          nodes: agent.session?.surface?.nodes ?? [],
          eventBySeq: live,
          startSeq: start,
          endSeq: end,
        });
        if (!/not a balanced boundary/.test(reason) || fallback == null || fallback === end) throw err;
        // The snapped range is SMALLER than the request, so it can fall under the worth-it share even
        // when the request did not. Check before paying for the miss, never after.
        assertFoldWorthIt(agent, start, fallback, rangeTokens(agent, start, fallback));
        result = await compaction.compactRegion(start, fallback, agent, opts.signal);
        snappedNote = ' | end ' + end + ' split a step: folded DOWN to the balanced boundary ' + fallback + ' instead';
      }
      // M1: lossless block store — capture large tool-output originals under
      // the compressed range so they stay recoverable verbatim (headroom CCR).
      const stored = storeCompressedBlocks(ctx, agent, result);
      // Put the human's own words back. The summary replaced the range; this appends what the
      // summary is structurally unable to keep (see human-decisions.js for the measurement).
      // Appended, never replacing: an append only lengthens the prefix, so the cache still hits.
      let humanNote = '';
      if (humanBlock) {
        try {
          agent.session.append('user/message', humanDecisionPayload(humanBlock), { surfaceOp: 'append' });
          humanNote = ` | human messages restored verbatim (${humanBlock.length} chars)`;
        } catch (err) {
          // A failed restoration must not undo a fold that already landed.
          humanNote = ` | human messages NOT restored: ${String(err?.message ?? err).slice(0, 120)}`;
        }
      }
      // Auto graph ingest: the new checkpoint lands in the session FILE now.
      // Scheduled on a worker thread - parsing the log must never block the
      // harness event loop (it used to freeze it for seconds per compression).
      scheduleIngest(agent?.session?.id, agent?.session?.header?.cwd);
      // Price the context the NEXT call must re-send — the POST-fold one (PREFIX-CACHE-STUDY §3: the
      // whole context of the next call is billed at the miss rate). Pricing the pre-fold prompt was
      // the mismatch this replaces; the measured bill lands as a settle row one step later.
      const afterTokens = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
      const loss = compactionCacheLoss(afterTokens, config.cacheMissPricePerMTokens, config.cacheHitPriceRatio);
      scheduleCacheSettle(agent.session, { ts: Date.now(), cacheAtFold, estimated: loss.tokens, estimatedCostCNY: loss.costCNY });
      const stats = compactionStats(agent.session);
      stats.count += 1; stats.lossTokens += loss.tokens; stats.lossCost += loss.costCNY;
      // The journal row is the only durable record of what a fold COST and what it ACHIEVED.
      // The in-process ledger dies with the process, and `after` is re-measured rather than
      // assumed: a fold that shrinks less than it promised is visible here and nowhere else.
      appendMetric({
        ts: Date.now(), session: agent?.session?.id,
        start: result.shadowedRange.start, end: result.shadowedRange.end,
        nodes: result.shadowedSeqs?.length ?? 0,
        before: promptTokens,
        after: afterTokens,
        lossTokens: loss.tokens, lossCostCNY: loss.costCNY,
        // `ms` is the PLUGIN-SIDE call, not the summarizer's work: the first real row measured 9ms
        // for a 536k-token fold, because the host produces the summary outside this await. It must
        // therefore not be read as "what the fold cost in wall time".
        ms: Date.now() - t0, userMsgs: countUserMsgs(agent),
      });
      return `compressed${opts.topic ? ` (${opts.topic})` : ''} ${result.shadowedRange.start}-${result.shadowedRange.end}: ${result.shadowedSeqs?.length ?? 0} nodes`
        + (stored ? ` | blocks saved: ${stored}` : '')
        + (foldedFrom != null ? ` | deep fold: start ${foldedFrom} → ${result.shadowedRange.start} (target ${Math.round((config.compressTargetRatio ?? 0.35) * 100)}% of window)` : '')
        + ` | the next call re-sends ~${loss.tokens} tokens uncached (≈${loss.costCNY}) — priced on the POST-fold context; the measured bill is journaled as a settle row`
        + ` | session total: ${stats.count} compaction${stats.count === 1 ? '' : 's'}, ~${stats.lossTokens} tokens`
        + humanNote
        + snappedNote;
    } catch (error) {
      if (opts.summary != null) pending.delete(agent.session);
      throw error;
    }
  }

  ctx.tools.register(defineTool({
    name: 'acp_compress',
    description: 'Replace an inclusive surface seq range with your summary via the official compaction API. Range must be tool-pairing balanced and must not include the newest tail.',
    parameters: ACP_COMPRESS_PARAMETERS,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const summary = String(args.summary ?? '').trim();
      if (!summary) throw new Error('summary is required');
      return runCompaction(agent, {
        exec,
        start: args.start,
        end: args.end,
        deep: args.deep,
        summary,
        topic: args.topic,
        source: 'model',
      });
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
          hits.push(`s${e.seq} ${e.type}\n  ${truncateText(text, 200)}`);
          if (hits.length >= (args.limit ?? 10)) break;
        }
      }
      const graph = graphRecall(String(args.query || ''), 5);
      if (graph && graph.length) {
        hits.push('');
        hits.push('## graph cross-checkpoint:');
        for (const g of graph) {
          hits.push(`  ${g.id} [${g.kind}]`);
          for (const cp of g.checkpoints) hits.push(`    -> s${cp.seqStart}-${cp.seqEnd}: ${cp.summary}`);
        }
      }
      return hits.length ? hits.join('\n') : `no hits for ${JSON.stringify(args.query)}`;
    },
  }));

  // The host-owned trigger in apply() must NOT re-implement the fold: one owner, or the two copies
  // drift (which is precisely how the banner once ended up outside the reach of its own tests).
  return { runCompaction };
}

/**
 * Resolve the model window. Returns { window, maxTokens } on success and { reason } on failure —
 * NEVER a bare undefined. The banner renders synchronously and cannot await, so a silent failure
 * there is indistinguishable from "no window configured", which is how the pressure banner spent
 * its life printing neither a percentage nor the soft/hard limits. A measuring component that
 * degrades silently makes every number downstream suspect; this one names its own failure.
 */
async function resolveWindowInfo(ctx, agent) {
  const header = agent?.session?.requestHeader?.()?.config;
  const provider = header?.provider || agent?.options?.provider;
  const model = header?.model || agent?.options?.model;
  const llm = ctx.get('llm');
  if (llm == null) return { reason: 'no-llm-service' };
  if (!provider || !model) return { reason: 'no-provider-model(' + (provider ?? '?') + '/' + (model ?? '?') + ')' };
  try {
    const info = await llm.resolveModelInfo(provider, model);
    // resolveModelInfo returns top-level fields in DSH (e.g. inputModalities,
    // contextWindow). Some versions nest under info.context — support both.
    const window = info?.contextWindow ?? info?.context?.contextWindow ?? info?.window;
    if (!Number.isInteger(window) || window <= 0) return { reason: 'no-context-window(' + provider + '/' + model + ')' };
    const maxTokens = info?.defaultMaxTokens;
    return {
      window,
      maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
    };
  } catch (e) {
    return { reason: 'threw:' + String(e?.message ?? e).slice(0, 80) };
  }
}

/**
 * Resolve the window for a tool/endpoint call AND remember it process-wide. Tools used to resolve
 * without caching, so a successful acp_status never helped the banner. Every successful resolution
 * anywhere is now what keeps the synchronous banner correct.
 */
async function resolveWindow(ctx, agent) {
  return (await rememberWindow(ctx, agent))?.window;
}

/**
 * Process-wide caches. These MUST live at module scope: rememberWindow() below is module-level and
 * referenced them from a scope where the identifier did not exist, so EVERY call threw
 * ReferenceError("windows is not defined") straight into an empty catch. The visible consequence:
 * the per-turn banner never carried a window, never showed the soft/hard limits, and the ACP
 * threshold it exists to advertise could never fire — for the entire life of the feature.
 * A probe that fails silently is worse than no probe: this one cost three sessions of debugging in
 * the wrong place. rememberWindow now records WHY it failed (lastWindowDiag) and the banner prints it.
 */
const windows = new WeakMap();
const completionBudgets = new WeakMap();

/**
 * Last window we could resolve, for ANY session. The per-turn banner renders synchronously and used
 * to read only the per-session map — which agent/pre-step fills — so at session start (and after a
 * restart) the banner saw no window at all. The window is a property of the MODEL, so remembering
 * the last one is both correct and enough.
 */
let lastKnownWindow;

/** Why the last window probe failed: "never-resolved" means the hook never ran at all. */
let lastWindowDiag = 'never-resolved';

/**
 * The last host-triggered fold that did not shrink the context. Surfaced in the banner on purpose:
 * a fold that silently achieves nothing looks exactly like a model ignoring the limit.
 */
let lastFoldFailure = null;

/** Resolve + remember the window for this agent (never throws; never blocks a render). */
async function rememberWindow(ctx, agent) {
  try {
    const info = await resolveWindowInfo(ctx, agent);
    if (info?.window != null && Number.isFinite(info.window)) {
      windows.set(agent.session, info.window);
      lastKnownWindow = info.window;
      lastWindowDiag = null;
      if (info.maxTokens != null) completionBudgets.set(agent.session, info.maxTokens);
      return info;
    }
    lastWindowDiag = info?.reason ?? 'unknown';
  } catch (e) {
    lastWindowDiag = 'threw:' + String(e?.message ?? e).slice(0, 80);
  }
  return null;
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
    // Sum every node between the first and last turn markers (not just the markers
    // themselves — those are a few tokens each and would underestimate growth by orders
    // of magnitude) - but ONLY the nodes that still occupy the context. After
    // acp_compress the hidden nodes keep their pricing in the meter, and summing them
    // overstated per-turn growth by orders of magnitude, so the banner forecast a hard
    // limit that was nowhere near. session.surface.nodes is the authoritative list of
    // what is still in context.
    const onSurface = new Set((session?.surface?.nodes ?? []).map((s) => Number(s)));
    const counted = (seq) => onSurface.size === 0 || onSurface.has(Number(seq));
    let sum = 0;
    let pricedCount = 0;
    for (let i = first; i <= last; i++) {
      if (!counted(i)) continue;
      const t = priced.get(i);
      if (typeof t === 'number') { sum += t; pricedCount += 1; }
    }
    if (pricedCount >= 2) return Math.max(1, Math.floor(sum / span));
    // No token pricing: estimate from raw event characters, same surface filter, and
    // look events up BY SEQ - indexing the array with a seq number silently reads the
    // wrong event whenever seqs are not contiguous.
    const bySeq = new Map();
    for (const e of events) if (e != null && e.seq != null) bySeq.set(Number(e.seq), e);
    let chars = 0;
    for (let i = first; i <= last; i++) {
      if (!counted(i)) continue;
      const e = bySeq.get(i);
      if (e == null) continue;
      const s = JSON.stringify(e.data ?? {});
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
      // NOTE: the harness completion budget lives in a WeakMap owned by registerAcpTools, which
      // this tool's scope cannot see — referencing it here threw "completionBudgets is not
      // defined" on every call (never noticed because the tool had never been invoked).
      // maxTokens is optional; omitting it only skips the provider-ceiling clamp.
      const rec = recommendThresholds({ windowTokens: w, growthPerTurn: estimateGrowth(ctx, agent) });
      const growthText = rec.growthPerTurn >= 1000
        ? `${(rec.growthPerTurn / 1000).toFixed(1)}k`
        : String(rec.growthPerTurn);
      return [
        `Recommended ACP thresholds: soft ${rec.min} / hard ${rec.max}`,
        `(window ${(w / 1000).toFixed(0)}k, growth ≈ ${growthText}/turn)`,
        ...rec.reasoning,
        '',
        `Apply: acp_set_limit minContextLimit=${rec.min} maxContextLimit=${rec.max}`,
        ...(function () {
          const hot = graphHotEntities(5);
          if (!hot || !hot.length) return [];
          return ['', 'hot entities across checkpoints:', ...hot.map((n) => `  ${n.id} [${n.kind}] x${n.mention_count}`)];
        })(),
      ].join('\n');
    },
  }));
}

/**
 * Hoist the official prompt's intent section to the first line.
 *
 * WHY. `dsh-compaction-basic`'s eight-section prompt already asks for
 * `## Primary Request and Intent`, and measured 2026-11-23 over 241 official summaries,
 * **241 (100%) have that section with real content and 0 are "(none)"**. So the intent is
 * already being written -- it is just written as a SECTION, and a reader (or an audit) that
 * wants "what is this session trying to achieve" has to find it among eight headings.
 *
 * This does not invent anything. It moves text the model already wrote to the place a reader
 * looks first, and leaves the section in place so nothing is lost. That is why it is safe to
 * do here rather than by rewriting the prompt: the prompt is in the npx cache and would be
 * lost on upgrade, while this hook is ours.
 *
 * @param {string} text - a summary produced by the official summarizer.
 * @returns the same summary with an `Intent:` first line, or the input unchanged when there
 *   is no usable section (an empty or "(none)" section must NOT become an empty Intent line).
 */
function hoistIntent(text) {
  if (typeof text !== 'string' || !text) return text;
  // Already hoisted (an ACP-authored summary, or a second pass): leave it alone.
  if (/^\s*Intent:/m.test(text.split('\n').slice(0, 3).join('\n'))) return text;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*Primary Request and Intent\s*$/i.test(l.trim()));
  if (start < 0) return text;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const joined = body.join('\n').trim();
  const stripped = joined.replace(/^[-*\s]*/, '').trim();
  if (!stripped || /^\(none\)$/i.test(stripped)) return text;
  // One line: the first non-empty bullet, without its marker. The section keeps the rest.
  const first = body.map((l) => l.trim()).find((l) => l && !/^\(none\)$/i.test(l));
  if (!first) return text;
  const oneLine = first.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return text;
  return `Intent: ${oneLine}\n\n${text}`;
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
    const result = await original(input, agent, signal);
    // The official summarizer's output is the only thing this hook can improve without
    // changing the prompt: hoist the intent it already wrote. A failure here must never
    // break a fold, so it is guarded and falls back to the original result.
    try {
      const blocks = result?.summary;
      if (Array.isArray(blocks)) {
        const hoisted = blocks.map((b) =>
          b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: hoistIntent(b.text) } : b,
        );
        return { ...result, summary: hoisted };
      }
    } catch { /* a hoist that throws must not cost the fold */ }
    return result;
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
    minContextLimit: merged.minContextLimit ?? '65%',
    maxContextLimit: merged.maxContextLimit ?? '85%',
    preserveRecent: merged.preserveRecent ?? 2,
    minTokens: merged.minTokens ?? 200,
    nudge: merged.nudge ?? true,
    clampToCeiling: merged.clampToCeiling ?? false,
    // Host-owned trigger. Off = the old behaviour (the model is asked and may ignore it).
    hostTrigger: merged.hostTrigger ?? true,
    // WHERE it fires. 'soft' = the host folds at the trigger itself. The model cannot be the trigger:
    // that makes the policy depend on it reading a number correctly, and the same complaint came back
    // three times (73% read as 100%; the soft limit read as the whole budget; then agents stopping to
    // ask the user for permission). Between the trigger and the ceiling nothing else fires, which is
    // precisely the gap where a stalled agent sits. The model still owns the RANGE whenever it folds
    // earlier than the trigger (acp_compress), so the normal path is unchanged.
    hostTriggerAt: merged.hostTriggerAt ?? 'soft',
    // Deterministic shrink of spent tool results. ON by default because the carrying cost it attacks
    // is 79-87% of the measured prompt bill, it costs no model call, and the guards keep it away from
    // the live tail (see shrinkTargets): nothing younger than shrinkProtectedTail nodes is touched.
    shrinkToolResults: merged.shrinkToolResults ?? true,
    shrinkMinTokens: merged.shrinkMinTokens ?? 800,
    shrinkProtectedTail: merged.shrinkProtectedTail ?? 4,
    shrinkWindowNodes: merged.shrinkWindowNodes ?? 16,
    // Degenerate-stutter guard: on by default, because the failure it catches costs real money
    // and has no other detector. It only matches KNOWN filler phrases (lib/repetition.js), so a
    // false positive requires an output that is entirely "OK. / Let me write. / Let me go.".
    stutterGuard: merged.stutterGuard ?? true,
    shrinkMaxPerStep: merged.shrinkMaxPerStep ?? 2,
    shrinkHeadChars: merged.shrinkHeadChars ?? 1200,
    shrinkTailChars: merged.shrinkTailChars ?? 400,
    // Cache-hit price as a fraction of the miss price. DeepSeek's table is 0.02/1 off-peak and 0.04/2
    // peak, so the RATIO is 2% either way; a deployment on another provider sets its own.
    cacheHitPriceRatio: merged.cacheHitPriceRatio ?? 0.02,
    minFoldRatio: merged.minFoldRatio ?? 0.1,
    // Absolute miss price, so the journal's CNY figures match the hour the work happens in.
    cacheMissPricePerMTokens: merged.cacheMissPricePerMTokens ?? 1,
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
  const webServer = serviceOf(ctx, 'webServer');
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
      const agents = serviceOf(ctx, 'agents');
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
      const { route, provider, model, reasoningEffort, patchPath } = await switchProvider(ctx, body?.provider, {
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
        patchPath: patchPath ?? null,
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
    const agents = serviceOf(ctx, 'agents');
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
    const agents = serviceOf(ctx, 'agents');
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

/**
 * Wire the degenerate-stutter guard onto a ctx.
 *
 * Extracted from apply() so the wiring is testable without a full harness: apply() needs
 * `ctx.effect`, `ctx.tools.register`, `ctx.storageDomain`, and more, so a test that called it
 * failed at registration before reaching the behaviour under test. This function needs only
 * `ctx.on` and `ctx.logger`, which is exactly the surface it uses.
 *
 * THE SEAM. `agent/assistant-stream` is `@mode emit` — a listener cannot abort from it. But the
 * loop's own stream consumption (dsh-agent-loop/lib/index.js:894-898) calls
 * `signal.throwIfAborted()` after EVERY chunk, and that signal is `this.phase.abort.signal`
 * (index.js:682) — the same AbortController that `agent.cancel(cause)` aborts (index.js:594).
 * So cancelling the agent is what actually stops the stream, and `{ kind: 'hook', reason }` is
 * the cause the contract provides for exactly this.
 *
 * @param ctx - anything with `on(name, fn)` and an optional `logger`
 * @param config - `{ stutterGuard?: boolean }`
 * @returns {{guards: Map, cancelled: Set}} the live state, for tests and diagnostics
 */
export function installStutterGuard(ctx, config = {}) {
  const guards = new Map();     // session -> RepetitionGuard
  const cancelled = new Set();  // sessions already cancelled once

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    try {
      if (config?.stutterGuard === false) return;
      const session = agent?.session;
      if (session == null) return;
      // One guard per attempt: a retry must not inherit the previous attempt's accumulated text.
      // checkEveryChars is 40, not 120: the measured stutter is 107 chars, so a 120-char interval
      // would never run the check at all — the guard would be installed and never consulted.
      if (frame?.type === 'start') { guards.set(session, new RepetitionGuard({ checkEveryChars: 40 })); return; }
      if (frame?.type !== 'chunk') return;
      const chunk = frame.chunk;
      // Only visible text and reasoning: tool-call deltas are JSON fragments, not prose.
      const delta = chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' ? chunk.text : null;
      if (typeof delta !== 'string' || delta === '') return;
      let guard = guards.get(session);
      if (guard == null) { guard = new RepetitionGuard({ checkEveryChars: 40 }); guards.set(session, guard); }
      const verdict = guard.push(delta);
      if (!verdict.degenerate) return;
      if (cancelled.has(session)) return;
      cancelled.add(session);
      try { ctx.logger?.warn?.(`acp stutter guard: cancelling the turn — ${verdict.reason}`); } catch { /* best-effort */ }
      agent.cancel({ kind: 'hook', reason: `degenerate repetition: ${verdict.reason}` });
    } catch { /* the guard must never break a stream */ }
  });

  ctx.on('agent/created', ({ agent }) => {
    const session = agent?.session;
    if (session != null) { guards.delete(session); cancelled.delete(session); }
  });

  return { guards, cancelled };
}

export function apply(ctx, config) {
  config = resolveConfig(config);

  const pending = new WeakMap();
  // windows / completionBudgets are declared at MODULE scope (see their comment): module-level helpers
  // (rememberWindow, resolveWindow) touch them, and an apply()-local binding was invisible from there —
  // which is exactly the ReferenceError that silently disabled the window cache.

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

  /**
   * Host-owned trigger. Runs BEFORE next() so the request is built from the folded surface.
   *
   * The range is not negotiated: at the fuse, everything except the preserved tail goes. The model
   * still owns the range when it folds EARLIER than the fuse (acp_compress), so nothing about the
   * normal path changes -- this only removes the possibility of nobody folding at all.
   *
   * summary == null on purpose: the compaction service then uses its own summarizer. The model is
   * not in the loop at this moment, so it cannot be the author.
   */
  const foldCooldown = new WeakMap();
  async function hostTriggeredFold(agent) {
    try {
      const session = agent?.session;
      if (session == null) return;
      const meter = ctx.get('tokenMeter');
      if (meter == null) return;
      const used = meter.measure(session)?.totalTokens ?? 0;
      const w = windows.get(session) ?? lastKnownWindow;
      const { min: soft, hard } = effectiveLimits(config, w, completionBudgets.get(session));
      const decision = compactionDecision(used, soft, hard, { hostTrigger: config.hostTrigger, forceAt: config.hostTriggerAt });
      if (foldFailureStale(lastFoldFailure, used, soft)) {
        ctx.logger?.info?.(`acp host-trigger: cleared stale fold failure (used ${used} < soft ${soft}): ${lastFoldFailure.reason}`);
        lastFoldFailure = null;
      }
      if (decision !== 'force') return;
      if ((foldCooldown.get(session) ?? 0) > Date.now()) return;
      const nodes = session.surface?.nodes;
      const range = hostFoldRange(nodes, config.preserveRecent ?? 2, { keepFirst: firstHumanSeq(nodes) });
      if (range == null) return;   // nothing safe to fold: the surface is the system prompt + tail
      const before = used;
      // `deep: true` so the fold honours compressTargetRatio. It was hard-coded `false`, which
      // skipped deepFoldStart entirely (lib/index.js:1244 gates on `opts.deep !== false`) — so the
      // configured target never applied and every fold landed wherever the range happened to end.
      //
      // ⚠ `deep: true` alone does NOT honour the target, and that was measured, not assumed:
      // `_p0/probe-deepfold-noop.mjs` replayed all 9 folds of session 14cc3134 and found
      // `deepFoldStart` could reach back on **0 of 9** — the range already starts at the first
      // foldable node, so there is nothing to extend. `_p0/measure-retain-surface.mjs` (priced by
      // the OFFICIAL estimator, not by provider usage, which stopped being recorded on this route
      // on 2026-11-14) measured the post-fold surface at **1.1%** of the window against a target
      // of 0.35. The fold was not shallow because the target was ignored; it was maximal.
      //
      // So the target is applied on the END: fold only as far as lands AT the target, keeping the
      // rest of the recent tail verbatim. That is the direction the operator asked for — "过度压缩
      // 反倒导致在做重要且复杂的事情到一半他给忘了" — and it is the only direction available,
      // since the start is already as far back as it can go.
      let foldEnd = range.end;
      try {
        const live = new Map();
        for (const ev of sessionEvents(session)) if (ev?.seq != null) live.set(Number(ev.seq), ev);
        const targeted = foldEndForTarget(meter, session, config, range.start, range.end, w, { eventBySeq: live });
        // `skip: true` means the surface is ALREADY at or below the target, so this fold would be
        // cosmetic. Do not fold at all — falling through to `range.end` here would perform the
        // maximal fold the target exists to prevent, which is exactly the bug this path fixes.
        if (targeted?.skip) {
          ctx.logger?.info?.(`acp host-trigger: skipped — surface is already at compressTargetRatio (${used} tokens)`);
          return;
        }
        if (targeted?.end != null) foldEnd = targeted.end;
      } catch { /* a target we cannot compute must never block the fold the trigger already decided on */ }
      await acpTools.runCompaction(agent, { start: range.start, end: foldEnd, deep: true, summary: null, topic: 'host-trigger' });
      const after = ctx.get('tokenMeter')?.measure(session)?.totalTokens ?? before;
      const check = foldShrank(before, after);
      lastFoldFailure = check.ok ? null : { at: Date.now(), before, after, reason: check.reason };
      if (!check.ok) foldCooldown.set(session, Date.now() + 10 * 60_000);
      ctx.logger?.info?.(`acp host-trigger: ${check.ok ? 'folded' : 'FOLD FAILED'} ${before} -> ${after} (${check.reason || 'ok'})`);
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 160);
      lastFoldFailure = { at: Date.now(), before: null, after: null, reason };
      foldCooldown.set(agent?.session, Date.now() + 10 * 60_000);
      ctx.logger?.warn?.(`acp host-trigger failed: ${reason}`);
    }
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await rememberWindow(ctx, agent);
    // Read the previous fold's REAL cache bill first: the request that paid it has already happened.
    // Accounting must never block a step, hence the guard.
    try { settleCacheBill(agent?.session); } catch { /* accounting is best-effort */ }
    // Deterministic shrink BEFORE the fold decision: it costs no model call, and every result it
    // removes from the carried context is removed from every later request too. A refusal must never
    // block a step.
    try { shrinkSpentResults(ctx, agent, config); } catch { /* a refused shrink is logged, not fatal */ }
    await hostTriggeredFold(agent);
    return next();
  });
  // Also resolve at agent creation: the banner can render before the first pre-step, and
  // until it has a window the ACP threshold is inert.
  ctx.on('agent/created', ({ agent }) => {
    void rememberWindow(ctx, agent);
    // Keep research / cross-machine / orchestration tools out of a SUBAGENT's request.
    //
    // Measured across 168 native `source/repos` sessions (all `origin: "subagent"`,
    // `agentPreset: "cordis"`): 126 of 222 declared tools were never called, costing 21,136 tokens
    // per request — 58.3% of the whole schema block. `preset-cordis` itself declares only ~35
    // plugins (cfg-dump.yml:1125); the rest are registered GLOBALLY by our own bundles, and
    // `ctx.tools.register` is global by contract, so a subagent inherits every one of them.
    //
    // `restrict()` is the official mechanism for exactly this (dsh-tools/index.d.ts:51-58:
    // "Restrict global tools for the calling agent scope"), it is reversible, and it does not
    // touch registrations. See lib/subagent-tool-scope.js for the deny list and its evidence.
    try {
      const applied = restrictSubagentTools(agent?.ctx ?? ctx, agent);
      if (applied.disposer != null) {
        subagentRestrictions.set(agent.session, applied.disposer);
        if (applied.skipped.length > 0) {
          // A tool that did not exist yet cannot be denied yet. Say which, so the next
          // measurement is not read as "the deny list was wrong".
          ctx.logger?.info?.(`subagent tool scope: denied ${applied.denied}, skipped ${applied.skipped.length} not-yet-registered (${applied.skipped.join(', ')})`);
        }
      } else if (shouldRestrict(agent)) {
        // Say it once: a restriction that did not apply leaves the subagent with every tool, and
        // silence would make the next measurement look like the fix worked.
        ctx.logger?.warn?.('subagent tool scope: restrict() did not apply (no scoped ctx, no registry, or every name unknown)');
      }
    } catch { /* the restriction must never block agent creation */ }
  });

  // --- degenerate-stutter guard -------------------------------------------------------------
  // The wiring lives in installStutterGuard() so it is testable without a full harness; see that
  // function for the seam analysis and the reason the guard is narrow.
  installStutterGuard(ctx, config);

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
        // Same fallback the acp_status tool has always had — plus the last window we ever
        // resolved, because this render is synchronous and may run before any pre-step.
        let w = windows.get(agent.session) ?? lastKnownWindow;
        if (w == null && agent?.session != null) {
          void rememberWindow(ctx, agent);   // fills the maps for the NEXT render
        }
        const used = ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0;
        const { min: soft, hard } = effectiveLimits(config, w, completionBudgets.get(agent.session));
        const level = pressureLevel(used, soft, hard);
        // Deterministic quiet mode: below the soft limit there is nothing to
        // decide — no banner and no surface dump, so the model never has to
        // re-evaluate compaction. Compaction is a threshold event, not a
        // judgment call. Full detail stays one acp_status call away.
        const showFull = config.nudge !== false && used >= soft;
        // A fold that achieved nothing must not look like a model ignoring the limit.
        const foldNote = lastFoldFailure
          ? `\nACP FOLD FAILED: ${lastFoldFailure.reason}`
            + (Number.isFinite(lastFoldFailure.before) ? ` (${lastFoldFailure.before} → ${lastFoldFailure.after} tokens)` : '')
            + ' — compaction ran and the context did not shrink; do not retry blindly.'
          : '';
        if (!showFull) {
          // ONE owner for this text: renderStatus in quiet mode. It used to be duplicated here,
          // which is exactly how the banner drifted out of reach of the wording tests.
          return renderStatus(ctx, agent, config, w, completionBudgets.get(agent.session), { quiet: true, windowDiag: lastWindowDiag }) + foldNote;
        }
        const banner = level === 'hard'
          ? 'ACP: context is past the HARD ceiling (the cap). Compress before any other work: acp_compress end:auto now. Do not start new exploration, and do not ask the user — this is your call.'
          : 'ACP: context is past the soft trigger (a trigger, not a cap — the hard ceiling is higher). Fold now, yourself: acp_compress end:auto once (deep by default), then continue. Never stop a turn to ask the user whether to compact.';
        return `${banner}\n\n${renderStatus(ctx, agent, config, w, completionBudgets.get(agent.session))}${foldNote}`;
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
  const acpTools = registerAcpTools(ctx, config, pending, windows, completionBudgets);
  registerGraphTools(ctx, defineTool);
  registerRecommendTool(ctx, windows);
  registerSessionMgmtTools(ctx);
  registerModelRoutesTools(ctx);
  registerAcpConfigTools(ctx, applyLiveConfig);
  registerFailoverTools(ctx);
  // 內容審查時換的是上下文，不是路由。reset 由這個模組組出來（它才拿得到 tokenMeter
  // 與壓縮服務），failover 只負責在對的時機呼叫它並決定要不要 retry。
  installFailover(ctx, {
    onModerationReset: createModerationReset({
      ctx,
      meter: (agent) => ctx.get('tokenMeter')?.measure(agent?.session)?.totalTokens ?? 0,
      results: (agent) => newestToolResultTargets(ctx, agent),
      replace: (agent, target, text) => replaceToolResultContent(agent, target, text),
      fold: async (agent) => {
        const nodes = agent?.session?.surface?.nodes;
        const range = hostFoldRange(nodes, config.preserveRecent ?? 1, { keepFirst: firstHumanSeq(nodes) });
        if (range == null) return false;
        // Same reason as the host-trigger fold: `deep: false` skips deepFoldStart, so the
        // configured compressTargetRatio never applies. A moderation reset is a fold like any
        // other and must land at the same target.
        await acpTools.runCompaction(agent, { ...range, deep: true, summary: null, topic: 'moderation-reset' });
        return true;
      },
    }),
    maxModerationResets: 2,
  });

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
/**
 * Build the `user/message` payload that restores the human's own words after a fold.
 *
 * The payload IS the UserMessage: for `user/message`, `data` is the message itself, not a
 * `{ message }` envelope (that envelope belongs to assistant/system/tool events). This was
 * written as `{ message }` once, which produced a row with `data.source === undefined`; the v4
 * reader refuses that with "format v4 message requires a producer-owned source kind" — and it
 * refuses the WHOLE session, so a single fold made the session unloadable. The shape is a
 * function (not an inline literal) so a test can pin it without a live Session.
 *
 * @param {string} text - the rendered human-decisions block.
 * @returns the UserMessage to append.
 */
function humanDecisionPayload(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'acp-human-decisions' },
  });
}

export const __internals = {
  summarizeEvents,
  renderHandoffDoc,
  // The summary contract is a PROMPT, so it is only testable if a test can read it. Exported
  // because the audit that measures summary quality (noConfidence 93%, noIntent 48%) can only
  // say "the prompt now asks for it" if the prompt is reachable from a test.
  ACP_SECTION,
  parseLimit,
  thresholdTokens,
  pressureLevel,
  assertSafeRange,
  eventText,
  sessionEvents,
  estimateGrowth,
  // The window cache is the piece that silently did nothing for the life of the feature: every
  // rememberWindow() call threw ReferenceError('windows is not defined') into an empty catch, so
  // these are exported to make "the cache actually caches" a test instead of a hope.
  rememberWindow,
  resolveWindowInfo,
  windows,
  completionBudgets,
  windowDiag: () => lastWindowDiag,
  // The compaction policy is a decision, so it is testable as one.
  compactionDecision,
  foldShrank,
  hostFoldRange,
  // The shrink deferral is a decision too — and it was WRONG for the life of the feature (it
  // deferred to a pruner that never fired). Exported so "does it run" is a test, not a claim.
  shrinkDecision,
  shrinkSpentResults,
  // The cache bill is MEASURED, so the measurement is testable: snapshot at fold time, settle on the
  // next pre-step, write exactly one row.
  scheduleCacheSettle,
  settleCacheBill,
  foldFailureStale,
  ACP_COMPRESS_PARAMETERS,
  // The restored human block's SHAPE is a durable-format contract: a wrong envelope here does not
  // fail the fold, it makes the session unloadable on the next start. Pinned by a test.
  humanDecisionPayload,
  // The official summarizer already writes an intent section; this hoists it to the first
  // line. Exported because "it moves text, it does not invent it" is a claim a test can check.
  hoistIntent,
};
