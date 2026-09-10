/**
 * Prompt-cache accounting for ACP.
 *
 * Why this exists: every acp_compress bumps `session.surface.replaceGeneration`, and
 * dsh-agent-loop reacts by re-projecting the system prompt and starting a new request
 * series (dsh-agent-loop/lib/index.js:1019) — the provider then has no matching byte
 * prefix, so the WHOLE prompt is billed at the miss rate. Compaction is therefore not
 * free, and its price is proportional to the context size at the moment you compress.
 *
 * Numbers are read (read-only, best effort) from the harness's own per-session usage
 * row in <DSH_HOME>/storages/session_projcache.json. That record uses the harness
 * TokenUsage convention, which is DISJOINT: `uncachedInputTokens` excludes cache reads,
 * so hit rate = cacheRead / (cacheRead + uncachedInput).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DeepSeek bills a cache hit at ~10% of the miss rate, so a lost prefix costs 0.9x the
 *  miss price — the constant behind every estimate in this module. */
export const CACHE_HIT_PRICE_RATIO = 0.1;

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function projCachePath() {
  return join(dshHome(), 'storages', 'session_projcache.json');
}

let warned = false;
function warnOnce(what, err) {
  if (warned) return;
  warned = true;
  console.warn('[dsh-session-handoff] ' + what + ':', err instanceof Error ? err.message : String(err));
}

/** Human-scale token count: 1234 -> "1.2K", 10603900000 -> "10.6B". */
export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (v >= size) return (v / size).toFixed(1) + suffix;
  }
  return String(Math.round(v));
}

/**
 * Read the harness's per-session cache counters.
 * @returns {{hits:number, misses:number, total:number, hitRate:number|null}|null}
 *   null when nothing is recorded yet (a fresh session) or the store is unreadable —
 *   never a fake zero, so callers can tell "no data" from "no hits".
 */
export function readSessionCache(sessionId, opts = {}) {
  const id = sessionId == null ? null : String(sessionId);
  if (id == null || id === '') return null;
  const file = opts.file ?? projCachePath();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const row = raw?.tables?.sessions?.[id];
    const totals = row?.rows?.tokenUsage?.val?.totals ?? row?.rows?.liveTokenUsage?.val?.settled;
    if (totals == null) return null;
    const hits = Number(totals.cacheReadTokens ?? 0);
    const misses = Number(totals.uncachedInputTokens ?? 0);
    const total = hits + misses;
    return { hits, misses, total, hitRate: total > 0 ? hits / total : null };
  } catch (err) {
    warnOnce('session cache stats unavailable (compaction cost estimates degrade to token counts)', err);
    return null;
  }
}

/** One-line summary for acp_status. */
export function formatCacheLine(stats) {
  if (stats == null || stats.total === 0) return 'prefix cache: no usage recorded for this session yet';
  const pct = stats.hitRate == null ? 'n/a' : (stats.hitRate * 100).toFixed(1) + '%';
  const costShare = stats.misses / (stats.misses + CACHE_HIT_PRICE_RATIO * stats.hits);
  return 'prefix cache: ' + pct + ' hit (' + formatTokens(stats.hits) + ' cached / ' + formatTokens(stats.misses)
    + ' miss) — misses are ' + (costShare * 100).toFixed(1) + '% of prompt cost';
}

/**
 * What a compaction costs: the whole prompt is re-sent uncached, so the loss is every
 * prompt token currently in play, priced at (miss - hit) = 0.9x the miss rate.
 * @param promptTokens tokens in the prompt right before the compaction.
 * @param missPricePerMTokens currency per 1M miss tokens (settings: cacheMissPricePerMTokens).
 */
export function compactionCacheLoss(promptTokens, missPricePerMTokens = 1) {
  const tokens = Math.max(0, Math.round(Number(promptTokens) || 0));
  const price = Number(missPricePerMTokens);
  const effective = Number.isFinite(price) && price >= 0 ? price : 1;
  const costCNY = (tokens * (1 - CACHE_HIT_PRICE_RATIO) * effective) / 1e6;
  return { tokens, costCNY: Math.round(costCNY * 1000) / 1000 };
}
