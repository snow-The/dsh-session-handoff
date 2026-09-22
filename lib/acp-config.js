/**
 * dsh-session-handoff — ACP threshold configuration.
 *
 *   acp_config    — show the active compaction thresholds (soft/hard limits,
 *                   preserveRecent, minTokens, nudge)
 *   acp_set_limit — persist new thresholds into settings.yaml's
 *                   `session-handoff:` section (the plugin config base).
 *                   Takes effect on the next session / after reload; the
 *                   current session keeps the thresholds it was started with.
 *
 * Reading/writing the settings.yaml `session-handoff:` section directly keeps
 * this zero-dependency and undo-snapshot-friendly (dsh-undo-savepoint).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECTION = 'session-handoff';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function settingsPath() {
  return join(dshHome(), 'settings.yaml');
}

const DEFAULTS = {
  minContextLimit: '60%',
  maxContextLimit: '70%',
  preserveRecent: 2,
  minTokens: 200,
  // Deep fold: aim the post-compaction surface at this fraction of the window. One
  // compaction already costs a full-prefix cache miss, so folding deep buys turns.
  compressTargetRatio: 0.35,
  nudge: true,
  clampToCeiling: false,
  // Who fires the fold. Both keys existed in resolveConfig but NOT here, and readSection reads only
  // the keys it finds in DEFAULTS — so settings.yaml could not move the fuse at all and the host
  // trigger was pinned to 'hard'. Between the soft trigger and the ceiling the MODEL was then the
  // only thing that could compact, which is exactly where agents stalled and asked the user to
  // authorize it.
  hostTrigger: true,
  // Default 'soft': the HOST folds at the trigger by itself. The model cannot be the trigger — that
  // makes the policy depend on it reading a number correctly, and the same complaint returned three
  // times (73% read as 100%; the soft limit read as the whole budget; then agents stopping to ask for
  // permission). The model still owns the RANGE whenever it folds earlier than the trigger, so the
  // normal path (acp_compress with a model-written summary) is unchanged.
  hostTriggerAt: 'soft',
  // Deterministic shrink of spent tool results (lib/shrink.js). ON: the carrying cost it attacks is
  // 79-87% of the measured prompt bill and the pass costs no model call. The guards are what make it
  // safe — nothing younger than shrinkProtectedTail surface nodes is touched, and every marker names
  // the seq that still holds the original.
  shrinkToolResults: true,
  // 800 tokens ≈ 3200 chars. Measured over a heavy session's 3852 tool results (p50 586 chars, p90
  // 2255, p99 7260): a 3000-TOKEN threshold sits above p99 and almost never fires, while >= 3000
  // CHARS already reaches ~25% of all tool text (the head+tail budget caps the yield near 30%).
  shrinkMinTokens: 800,
  shrinkProtectedTail: 4,
  // How far back a shrink may reach, in nodes. The re-billed region grows with that distance, so this
  // is the knob that keeps the trade profitable; older bulk belongs to the next fold.
  shrinkWindowNodes: 16,
  shrinkMaxPerStep: 2,
  shrinkHeadChars: 1200,
  shrinkTailChars: 400,
  // Cache-hit price as a fraction of the miss price (0.02 = DeepSeek's published 0.02/1 off-peak,
  // 0.04/2 peak). It decides how the carrying term weighs against the folding term, so it is DATA:
  // a price change must not need a code edit.
  cacheHitPriceRatio: 0.02,
  // Smallest share of the context a fold must remove to be worth its own cache miss (default 10%).
  // The miss is proportional to the whole post-fold prompt; the saving is proportional to the folded
  // range at the hit price, so break-even is ~49 x (context / folded) later requests.
  minFoldRatio: 0.1,
};

/** Read the plugin's section from settings.yaml (defaults when absent). */
function readSection(text) {
  const out = { ...DEFAULTS };
  const re = new RegExp(`^${SECTION}:\\s*$[\\s\\S]*?(?=\\n\\S[^:]*:|\\n$)`, 'm');
  const m = text.match(re);
  if (m == null) return out;
  const block = m[0];
  for (const key of Object.keys(DEFAULTS)) {
    const kv = block.match(new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm'));
    if (kv) {
      let raw = kv[1].trim();
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1);
      }
      if (key === 'nudge' || key === 'clampToCeiling' || key === 'hostTrigger' || key === 'shrinkToolResults') out[key] = raw === 'true';
      else if (key === 'shrinkMinTokens' || key === 'shrinkProtectedTail' || key === 'shrinkWindowNodes' || key === 'shrinkMaxPerStep' || key === 'shrinkHeadChars' || key === 'shrinkTailChars' || key === 'cacheHitPriceRatio' || key === 'minFoldRatio') out[key] = Number(raw);
      // Only two fuse positions exist. Anything unreadable must land on the conservative one rather
      // than reach compactionDecision as a truthy string.
      else if (key === 'hostTriggerAt') out[key] = raw === 'soft' ? 'soft' : 'hard';
      else if (key === 'preserveRecent' || key === 'minTokens') out[key] = Number(raw);
      // A fraction of the window. Read as a raw STRING it would still multiply, but a value that is
      // not a fraction (NaN, 0, 2, "35%") would silently become the fold target and aim a fold at the
      // wrong place, so an unusable value falls back to the default instead of being honoured.
      else if (key === 'compressTargetRatio') {
        const n = Number(raw);
        out[key] = Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULTS.compressTargetRatio;
      }
      else out[key] = raw;
    }
  }
  return out;
}

/**
 * The fuse ceiling. The client UI sliders stop at 90 and recommendThresholds() caps the fuse at
 * 90% of the window too, for a reason that is not cosmetic: the hard limit must leave room for one
 * turn's burst (measured 18-31k tokens/turn here) plus a single large tool result.
 *
 * The TOOL used to accept up to 95% while the UI could not even display 95 — settings.yaml and the
 * panel disagreed about what is valid, and the more permissive writer won (that is how this very
 * config ended up at 88/95). One ceiling, enforced where writes happen.
 * test/acp-config.test.mjs asserts this number and the UI literal are the same.
 */
export const FUSE_CEILING_PCT = 90;

/** Validate one limit string ("60%" or a token count). */
function validateLimit(raw, label) {
  const s = String(raw).trim();
  if (/^\d{1,3}%$/.test(s)) {
    const pct = Number(s.slice(0, -1));
    const ceiling = label === 'maxContextLimit' ? FUSE_CEILING_PCT : 95;
    if (pct < 1 || pct > ceiling) {
      throw new Error(`${label} percent must be 1-${ceiling}`
        + (label === 'maxContextLimit'
          ? ` (the fuse stays at or below ${FUSE_CEILING_PCT}% so one turn's burst cannot overflow the window; the UI slider caps there too)`
          : ''));
    }
    return s;
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 1000) throw new Error(`${label} token count must be >= 1000`);
    return s;
  }
  throw new Error(`${label} must be like "70%" or a token count`);
}

/** Read the effective ACP section from settings.yaml (defaults when absent). */
async function readAcpSection() {
  let text = '';
  try { text = await readFile(settingsPath(), 'utf8'); } catch { /* no settings yet */ }
  return readSection(text);
}

/** Validate and persist new ACP thresholds into settings.yaml's `session-handoff:` section. */
async function writeAcpConfig(args) {
  const path = settingsPath();
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch { /* create fresh */ }
  const current = readSection(text);
  const next = { ...current };
  if (args.minContextLimit != null) next.minContextLimit = validateLimit(args.minContextLimit, 'minContextLimit');
  if (args.maxContextLimit != null) next.maxContextLimit = validateLimit(args.maxContextLimit, 'maxContextLimit');
  if (args.preserveRecent != null) {
    if (!Number.isInteger(args.preserveRecent) || args.preserveRecent < 0 || args.preserveRecent > 20) throw new Error('preserveRecent must be 0-20');
    next.preserveRecent = args.preserveRecent;
  }
  if (args.minTokens != null) {
    if (!Number.isInteger(args.minTokens) || args.minTokens < 0) throw new Error('minTokens must be >= 0');
    next.minTokens = args.minTokens;
  }
  if (args.nudge != null) next.nudge = Boolean(args.nudge);
  if (args.clampToCeiling != null) next.clampToCeiling = Boolean(args.clampToCeiling);
  if (args.hostTrigger != null) next.hostTrigger = Boolean(args.hostTrigger);
  if (args.hostTriggerAt != null) {
    const at = String(args.hostTriggerAt).trim();
    if (at !== 'soft' && at !== 'hard') throw new Error('hostTriggerAt must be "soft" or "hard"');
    next.hostTriggerAt = at;
  }

  const block = [
    `${SECTION}:`,
    `  minContextLimit: ${next.minContextLimit}`,
    `  maxContextLimit: ${next.maxContextLimit}`,
    `  preserveRecent: ${next.preserveRecent}`,
    `  minTokens: ${next.minTokens}`,
    `  nudge: ${next.nudge}`,
    `  clampToCeiling: ${next.clampToCeiling}`,
    // Read-then-write symmetry: this block used to omit compressTargetRatio, so ANY acp_set_limit
    // call silently deleted a configured deep-fold target from settings.yaml.
    `  compressTargetRatio: ${next.compressTargetRatio}`,
    `  hostTrigger: ${next.hostTrigger}`,
    `  hostTriggerAt: ${next.hostTriggerAt}`,
    `  shrinkToolResults: ${next.shrinkToolResults}`,
    `  shrinkMinTokens: ${next.shrinkMinTokens}`,
    `  shrinkProtectedTail: ${next.shrinkProtectedTail}`,
    `  shrinkWindowNodes: ${next.shrinkWindowNodes}`,
    `  shrinkMaxPerStep: ${next.shrinkMaxPerStep}`,
    `  cacheHitPriceRatio: ${next.cacheHitPriceRatio}`,
    `  minFoldRatio: ${next.minFoldRatio}`,
    '',
  ].join('\n');
  const re = new RegExp(`^${SECTION}:\\s*$[\\s\\S]*?(?=\\n\\S[^:]*:|\\n$)`, 'm');
  if (re.test(text)) {
    text = text.replace(re, block.trimEnd());
  } else {
    text = text.trimEnd() + '\n' + block;
  }
  await writeFile(path, text, 'utf8');
  return next;
}

export function registerAcpConfigTools(ctx, onChange) {
  ctx.tools.register(defineTool({
    name: 'acp_config',
    description: 'Show the active Active Context Pruning thresholds (minContextLimit = the soft trigger that fires a fold; maxContextLimit = the hard ceiling, the real cap; preserveRecent, minTokens, nudge) from settings.yaml.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const cfg = await readAcpSection();
      return [
        'ACP thresholds:',
        `  minContextLimit: ${cfg.minContextLimit}   (soft trigger — fold when you pass it; NOT a cap, keep working up to it)`,
        `  maxContextLimit: ${cfg.maxContextLimit}   (hard ceiling — the cap; compress before you reach it)`,
        'The window itself is the budget; the trigger only decides WHEN you fold, never whether you may continue.',
        `  preserveRecent: ${cfg.preserveRecent}`,
        `  minTokens: ${cfg.minTokens}`,
        `  nudge: ${cfg.nudge}`,
        `  clampToCeiling: ${cfg.clampToCeiling}`,
        `  compressTargetRatio: ${cfg.compressTargetRatio}   (deep-fold target; a fold aims the surface here)`,
        `  hostTrigger: ${cfg.hostTrigger}   (the host fires the fold itself)`,
        `  hostTriggerAt: ${cfg.hostTriggerAt}   ("soft" = fold as soon as the trigger is passed, no model in the loop; "hard" = only at the ceiling)`,
        `  shrinkToolResults: ${cfg.shrinkToolResults}   (deterministic head+tail shrink of spent tool results; no model call)`,
        `  shrinkMinTokens: ${cfg.shrinkMinTokens}   (only results at least this large)`,
        `  shrinkProtectedTail: ${cfg.shrinkProtectedTail}   (never touch the last N surface nodes)`,
        `  shrinkWindowNodes: ${cfg.shrinkWindowNodes}   (how far back a shrink may reach — a replacement re-bills everything after it)`,
        `  shrinkMaxPerStep: ${cfg.shrinkMaxPerStep}`,
        `  cacheHitPriceRatio: ${cfg.cacheHitPriceRatio}   (cache-hit price / miss price — 0.02 on DeepSeek's table; it decides how carrying weighs against folding)`,
        `  minFoldRatio: ${cfg.minFoldRatio}   (a fold must remove at least this share of the context to be worth its own cache miss)`, 
        '',
        'Applied at startup from settings.yaml; acp_set_limit updates the live config immediately.',
      ].join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_set_limit',
    description: 'Persist new Active Context Pruning thresholds into settings.yaml (`session-handoff:` section): minContextLimit (the soft trigger) / maxContextLimit (the hard ceiling) as "NN%" or token counts, plus preserveRecent, minTokens, nudge. Takes effect on the next session.',
    parameters: {
      minContextLimit: { type: 'string', description: 'Soft trigger: fold when usage passes this; not a cap, e.g. "60%" or 600000' },
      maxContextLimit: { type: 'string', description: 'Hard ceiling: the cap on the window, e.g. "70%" or 700000' },
      preserveRecent: { type: 'integer', description: 'Surface nodes to always keep (default 2)' },
      minTokens: { type: 'integer', description: 'Minimum tokens a range must hold before acp_compress accepts it (default 200)' },
      nudge: { type: 'boolean', description: 'Inject the pressure banner into the system prompt (default true)' },
      hostTrigger: { type: 'boolean', description: 'Let the host fire the fold itself instead of waiting for the model to act on the banner (default true)' },
      hostTriggerAt: { type: 'string', description: '"soft" = the host folds as soon as the soft trigger is passed, so no agent can stall and ask; "hard" = only at the ceiling (default)' },
      shrinkToolResults: { type: 'boolean', description: 'Deterministically shrink spent tool results (head+tail+pointer, no model call) to cut the carrying cost (default true)' },
      shrinkMinTokens: { type: 'integer', description: 'Only shrink tool results at least this large (default 3000)' },
      shrinkProtectedTail: { type: 'integer', description: 'Never touch the last N surface nodes (default 4)' },
      shrinkWindowNodes: { type: 'integer', description: 'How far back a shrink may reach, in nodes (default 16) — a replacement re-bills the provider prefix from that point on' },
      shrinkMaxPerStep: { type: 'integer', description: 'Most results shrunk per pre-step (default 2)' },
      cacheHitPriceRatio: { type: 'number', description: 'Cache-hit price as a fraction of the miss price (default 0.02, DeepSeek\'s published ratio)' },
      minFoldRatio: { type: 'number', description: 'Smallest share of the context a fold must remove to be worth its cache miss (default 0.1 = 10%)' },
      clampToCeiling: { type: 'boolean', description: 'Clamp the hard limit below window - maxTokens so ACP fires before the provider rejects (default false)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const next = await writeAcpConfig(args);
      onChange?.(next);
      return [
        'ACP thresholds updated in settings.yaml and applied to the live runtime config:',
        `  minContextLimit: ${next.minContextLimit}`,
        `  maxContextLimit: ${next.maxContextLimit}`,
        `  preserveRecent: ${next.preserveRecent}`,
        `  minTokens: ${next.minTokens}`,
        `  nudge: ${next.nudge}`,
        `  hostTrigger: ${next.hostTrigger}`,
        `  hostTriggerAt: ${next.hostTriggerAt}`,
        '',
        'Effective limits are clamped below the provider request ceiling (window - maxTokens).',
      ].join('\n');
    },
  }));
}

export { readSection, validateLimit, readAcpSection, writeAcpConfig };
