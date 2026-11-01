/**
 * dsh-session-handoff — moderation-triggered CONTEXT reset.
 *
 * Why this exists (2026-10-05, from a real kill):
 *   Provider failover rotates the ROUTE. Content moderation is not a route problem — the
 *   provider is up and healthy; it is the transcript it refuses. Rotating the route re-sends
 *   the same bytes and dies the same way (observed: commandcode 400 → volcengine 404 →
 *   deepseek-official 400 Content-Exists-Risk, session dead).
 *   The only move that can work is changing WHAT IS SENT: take the offending content out of
 *   the carried context and retry.
 *
 * Two stages, cheapest first — and both must PROVE the context shrank:
 *   1. tombstone the newest spent tool results (deterministic, no model call — a model call
 *      would re-send the very content that was just refused, and be refused again);
 *   2. only if stage 1 freed too little, fold a range (the caller injects the fold, because
 *      that needs the compaction service).
 *
 * A reset that frees nothing reports `changed: false`, so the caller surfaces the original
 * provider error instead of looping on a transcript it cannot shrink.
 */

/** Signatures a provider uses when it refuses content (not capacity, not auth). */
export const MODERATION_PATTERNS = Object.freeze([
  /content exists risk/i,
  /content[ _-]?moderation/i,
  /content policy/i,
  /risk control/i,
  /blocked by (?:the )?(?:safety|content) (?:filter|system)/i,
  /内容(?:存在)?(?:风险|風險)/,
  /(?:触发|觸發|命中)(?:了)?(?:内容|內容)?(?:审查|審查|风控|風控)/,
  /违规内容|違規內容/,
]);

/**
 * HTTP-400-class provider codes. A generic 400 tells us nothing by itself — an aggregator in
 * front of a moderated model reports exactly this shape — so these count as moderation
 * evidence only TOGETHER WITH a second, distinct provider refusing the same step.
 */
export const BAD_REQUEST_CODES = Object.freeze([
  'INVALID_REQUEST',
  'PROVIDER_HTTP_ERROR',
  'BAD_REQUEST',
]);

/** True when the failure message names content moderation outright. */
export function isModerationFailure(failure) {
  const message = String(failure?.message ?? '');
  return MODERATION_PATTERNS.some((re) => re.test(message));
}

/**
 * Weaker, second-hand signal: the same step has already been refused by a DIFFERENT provider
 * with a 400-class code. Two independent routes refusing one request is the signature of a
 * content refusal wearing a generic error (a single-route 400 is far more often a malformed
 * request, and guessing wrong there would tombstone good context).
 * @param failure the current failure
 * @param rejectedElsewhere Set of providers that already refused this step with a 400-class code
 */
export function looksLikeModeration(failure, rejectedElsewhere) {
  if (isModerationFailure(failure)) return true;
  const code = failure?.code;
  if (typeof code !== 'string' || !BAD_REQUEST_CODES.includes(code)) return false;
  if (!(rejectedElsewhere instanceof Set) || rejectedElsewhere.size === 0) return false;
  return !rejectedElsewhere.has(failure?.provider);
}

/** The text that replaces refused content; the original stays in the session log. */
export function tombstoneText(seq) {
  return '…[moderation-reset: this tool result was removed from the carried context because a'
    + ' provider refused the request as a content-moderation hit. It is NOT lost — the original'
    + ' is still in session.jsonl at seq ' + String(seq) + '. Re-read it with the file tools if'
    + ' it is needed again.]';
}

/**
 * Build the reset function the failover installer calls on a moderation failure.
 *
 * @param deps.ctx      cordis context (only logger is used)
 * @param deps.meter    (agent) => number, currently carried tokens
 * @param deps.results  (agent) => [{seq, toolName, parts}] newest-first tombstone candidates
 * @param deps.replace  (agent, target, text) => boolean, one-node surface replacement
 * @param deps.fold     (agent, info) => Promise<boolean>, stage 2 (needs the compaction service)
 * @param deps.minFreedRatio fraction of the context a reset must free to count as changed
 */
export function createModerationReset({ ctx, meter, results, replace, fold, minFreedRatio = 0.02, maxTombstones = 4 } = {}) {
  return async function resetContextForModeration(agent, info = {}) {
    const measure = typeof meter === 'function' ? meter : () => 0;
    const before = Number(measure(agent) ?? 0);
    let targets = [];
    try { targets = (typeof results === 'function' ? results(agent) : []) ?? []; } catch { targets = []; }
    let done = 0;
    for (const target of targets.slice(0, maxTombstones)) {
      let ok = false;
      try { ok = replace(agent, target, tombstoneText(target?.seq)) === true; } catch { ok = false; }
      if (ok) done += 1;
    }
    let after = Number(measure(agent) ?? before);
    const need = Math.max(200, Math.round(before * minFreedRatio));
    if (done > 0 && before - after >= need) {
      return { changed: true, how: 'tombstoned ' + done + ' tool result(s)', freed: before - after, before, after };
    }
    if (typeof fold === 'function') {
      try { await fold(agent, { ...info, tombstones: done }); } catch (err) {
        ctx?.logger?.warn?.('[dsh-session-handoff] moderation fold failed: ' + String(err?.message ?? err).slice(0, 200));
      }
      after = Number(measure(agent) ?? after);
      if (before - after >= need) {
        return { changed: true, how: 'folded a range', freed: before - after, before, after };
      }
    }
    return { changed: false, how: done > 0 ? ('tombstoned ' + done + ' but freed only ' + Math.max(0, before - after)) : 'nothing to remove', freed: Math.max(0, before - after), before, after };
  };
}

export const __internals = { MODERATION_PATTERNS, BAD_REQUEST_CODES };
