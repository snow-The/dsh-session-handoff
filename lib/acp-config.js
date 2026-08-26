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
  nudge: true,
  clampToCeiling: false,
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
      if (key === 'nudge' || key === 'clampToCeiling') out[key] = raw === 'true';
      else if (key === 'preserveRecent' || key === 'minTokens') out[key] = Number(raw);
      else out[key] = raw;
    }
  }
  return out;
}

/** Validate one limit string ("60%" or a token count). */
function validateLimit(raw, label) {
  const s = String(raw).trim();
  if (/^\d{1,3}%$/.test(s)) {
    const pct = Number(s.slice(0, -1));
    if (pct < 1 || pct > 95) throw new Error(`${label} percent must be 1-95`);
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

  const block = [
    `${SECTION}:`,
    `  minContextLimit: ${next.minContextLimit}`,
    `  maxContextLimit: ${next.maxContextLimit}`,
    `  preserveRecent: ${next.preserveRecent}`,
    `  minTokens: ${next.minTokens}`,
    `  nudge: ${next.nudge}`,
    `  clampToCeiling: ${next.clampToCeiling}`,
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
    description: 'Show the active Active Context Pruning thresholds (soft/hard context limits, preserveRecent, minTokens, nudge) from settings.yaml.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const cfg = await readAcpSection();
      return [
        'ACP thresholds:',
        `  minContextLimit: ${cfg.minContextLimit}   (soft — compress before this)`,
        `  maxContextLimit: ${cfg.maxContextLimit}   (hard — compress now)`,
        `  preserveRecent: ${cfg.preserveRecent}`,
        `  minTokens: ${cfg.minTokens}`,
        `  nudge: ${cfg.nudge}`,
        `  clampToCeiling: ${cfg.clampToCeiling}`, 
        '',
        'Applied at startup from settings.yaml; acp_set_limit updates the live config immediately.',
      ].join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'acp_set_limit',
    description: 'Persist new Active Context Pruning thresholds into settings.yaml (`session-handoff:` section): minContextLimit / maxContextLimit as "NN%" or token counts, preserveRecent, minTokens, nudge. Takes effect on the next session.',
    parameters: {
      minContextLimit: { type: 'string', description: 'Soft limit, e.g. "60%" or 600000' },
      maxContextLimit: { type: 'string', description: 'Hard limit, e.g. "70%" or 700000' },
      preserveRecent: { type: 'integer', description: 'Surface nodes to always keep (default 2)' },
      minTokens: { type: 'integer', description: 'Minimum tokens a range must hold before acp_compress accepts it (default 200)' },
      nudge: { type: 'boolean', description: 'Inject the pressure banner into the system prompt (default true)' },
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
        '',
        'Effective limits are clamped below the provider request ceiling (window - maxTokens).',
      ].join('\n');
    },
  }));
}

export { readSection, validateLimit, readAcpSection, writeAcpConfig };
