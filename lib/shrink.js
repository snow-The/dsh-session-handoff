/**
 * Deterministic tool-result shrink — the same information budget a careful agent would keep if it
 * were taking notes, produced WITHOUT a model call.
 *
 * Why this shape and not another compaction:
 *   Measured on two heavy sessions (session_projcache.json), 79-87% of the billed prompt cost is
 *   CARRYING the context (cache reads), not compacting it: session-f20d1471 carried 3.51B cached
 *   against 52.5M uncached, session-b0e810e7 1.53B against 41.4M. One fold's post-fold re-send is
 *   ~0.27M miss-equivalents — negligible against that. So the lever is the carried SIZE, and a
 *   tool result is the cheapest thing to shrink: it is bulk, it has already been read once, and its
 *   original stays in the session log (the marker carries the seq that finds it).
 *
 * A shrink is a surface REPLACEMENT (one node, same type, content only — the only rewrite the
 * session contract allows for tool/result). It changes no system prompt, so the host's re-projection
 * is a no-op and the prefix cache survives everything before the shrunk node.
 */

/** Marker that makes a shrunk result recognisable on a later pass. */
export const SHRINK_MARKER_PREFIX = '…[shrunk ';

/**
 * Whether a tool-result content array already carries the shrink marker.
 *
 * The marker sits AFTER the head (the head is what an agent recognises the output by), so this is a
 * substring test — a startsWith check here silently never matched, which meant the same result was
 * shrunk again on every pass.
 */
export function isShrunkContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block?.text === 'string' && block.text.includes(SHRINK_MARKER_PREFIX));
}

/** The text a tool-result block carries, across its inner blocks. */
export function resultText(block) {
  const inner = block?.content;
  if (!Array.isArray(inner)) return '';
  return inner.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** Whether a tool-result block holds anything we refuse to touch (images and other non-text parts). */
export function hasNonTextParts(block) {
  const inner = block?.content;
  if (!Array.isArray(inner)) return false;
  return inner.some((part) => part?.type !== 'text');
}

/**
 * Cut one text into the head and tail worth keeping.
 * @returns {{head: string, tail: string, elided: number, total: number}}
 */
export function cutText(text, { headChars = 1200, tailChars = 400 } = {}) {
  const s = String(text ?? '');
  const head = Math.max(0, Math.floor(headChars));
  const tail = Math.max(0, Math.floor(tailChars));
  if (s.length <= head + tail) return { head: s, tail: '', elided: 0, total: s.length };
  return { head: s.slice(0, head), tail: tail === 0 ? '' : s.slice(s.length - tail), elided: s.length - head - tail, total: s.length };
}

/**
 * The replacement inner content for one tool result: head, a marker naming what was dropped and how
 * to get it back, then the tail. The marker is the whole point — an agent that needs a detail knows
 * the original is one grep away instead of guessing that the output was never that long.
 */
export function shrunkenContent(block, { seq, toolName, headChars, tailChars, keepChars = 0 } = {}) {
  const text = resultText(block);
  const cut = cutText(text, { headChars, tailChars });
  if (cut.elided <= keepChars) return null;              // nothing worth the replacement
  const where = seq == null ? 'the session log' : 'the session log, seq ' + seq;
  const marker = SHRINK_MARKER_PREFIX + (toolName || 'tool') + ' · ' + cut.elided + ' of ' + cut.total
    + ' chars elided — original in ' + where + ']';
  return [{ type: 'text', text: cut.head + '\n' + marker + (cut.tail === '' ? '' : '\n' + cut.tail) }];
}

/**
 * Pick the tool results worth shrinking.
 *
 * Guards, in order: only tool/result nodes; only those at least `protectedTail` nodes from the end
 * (the live tail is what the agent is reasoning about right now); only at least `minTokens`; never
 * one that already carries the marker; never one holding an image.
 *
 * @param nodes surface nodes as {seq, type, tokens} (see surfaceNodes).
 * @param eventBySeq full events by seq (see getSessionFileEvents).
 * @returns candidates in surface order: {seq, tokens, toolName, block}
 */
export function shrinkTargets({ nodes = [], eventBySeq = new Map(), minTokens = 3000, protectedTail = 4, limit = Infinity } = {}) {
  const out = [];
  const last = nodes.length - 1 - Math.max(0, protectedTail);
  for (let i = 0; i <= last; i++) {
    const node = nodes[i];
    if (node?.type !== 'tool/result') continue;
    if (Number(node.tokens ?? 0) < minTokens) continue;
    const event = eventBySeq.get(Number(node.seq));
    const block = event?.data?.message?.content?.[0];
    if (block?.type !== 'tool-result') continue;
    if (hasNonTextParts(block)) continue;
    if (isShrunkContent(block.content)) continue;
    if (resultText(block).length === 0) continue;
    out.push({ seq: Number(node.seq), tokens: Number(node.tokens ?? 0), toolName: block.toolName ?? 'tool', block });
    if (out.length >= limit) break;
  }
  return out;
}
