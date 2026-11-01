/**
 * Deterministic tool-result shrink — the same information budget a careful agent would keep if it
 * were taking notes, produced WITHOUT a model call.
 *
 * Why this shape and not another compaction:
 *   Measured on two heavy sessions (session_projcache.json), 79-87% of the billed prompt cost is
 *   CARRYING the context (cache reads), not compacting it. A tool dump that has already been read is
 *   the cheapest thing to cut, and the original stays in the session log.
 *
 * TWO REPRESENTATIONS. DSH 0.1.7-rc.2 moved to session format V4, which LIFTED the tool result out of
 * its wrapper (dsh-session-format-v3-to-v4, section "Tool-result representation"):
 *
 *   V3: message = { id, role: 'user', source: {kind:'tool',callId},
 *                   content: [ { type:'tool-result', toolCallId, toolName, isError?, content: [parts] } ] }
 *   V4: message = { id, role: 'tool', source: {kind:'tool',callId}, toolCallId, isError?,
 *                   content: [parts], 'plugin:result:toolName': ... }
 *
 * Reading only one of them fails SILENTLY on the other — no error, the pass simply never matches a
 * result — so every reader here goes through {@link toolResultOf}, and a replacement is re-emitted in
 * the shape it was read from.
 */

/** Marker that makes a shrunk result recognisable on a later pass. */
export const SHRINK_MARKER_PREFIX = '…[shrunk ';

/**
 * Read a tool result's parts from either the V3 wrapper or the V4 first-class tool message.
 * @param message - the event's `data.message`.
 * @returns {{shape:'v3'|'v4', toolCallId:string, toolName:string, isError:boolean, parts:unknown[], message:object, wrapper:object|null}|null}
 */
export function toolResultOf(message) {
  if (message == null || typeof message !== 'object') return null;
  const content = Array.isArray(message.content) ? message.content : null;
  if (content == null) return null;
  if (message.role === 'tool' || typeof message.toolCallId === 'string') {
    return {
      shape: 'v4',
      toolCallId: String(message.toolCallId ?? message.source?.callId ?? ''),
      // V4 keeps the wrapper's other fields as plugin:result:<name> (format-v3-to-v4 README §Tool-result).
      toolName: String(message['plugin:result:toolName'] ?? message.toolName ?? 'tool'),
      isError: message.isError === true,
      parts: content,
      message,
      wrapper: null,
    };
  }
  const wrapper = content[0];
  if (wrapper == null || wrapper.type !== 'tool-result') return null;
  return {
    shape: 'v3',
    toolCallId: String(wrapper.toolCallId ?? ''),
    toolName: String(wrapper.toolName ?? 'tool'),
    isError: wrapper.isError === true,
    parts: Array.isArray(wrapper.content) ? wrapper.content : [],
    message,
    wrapper,
  };
}

/**
 * Rebuild the `data.message` of a tool result with new parts, in the shape it was read from.
 * V4 puts the parts directly on the message; V3 nests them inside the one tool-result wrapper.
 */
export function withResultParts(result, parts) {
  if (result.shape === 'v4') return { ...result.message, content: parts };
  return { ...result.message, content: [{ ...result.wrapper, content: parts }] };
}

/** Whether a tool-result parts array already carries the shrink marker. */
export function isShrunkContent(parts) {
  if (!Array.isArray(parts)) return false;
  return parts.some((block) => typeof block?.text === 'string' && block.text.includes(SHRINK_MARKER_PREFIX));
}

/** The text a tool-result parts array carries. */
export function partsText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** Whether the parts hold anything we refuse to touch (images and other non-text parts). */
export function hasNonTextParts(parts) {
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => part?.type !== 'text');
}

/**
 * 一个**码元**下标，修正成不切断代理对的位置。
 *
 * 为什么需要：JS 的 `s.slice(0, n)` / `s.slice(-m)` 按 **UTF-16 码元**切，而一个 emoji
 * （以及任何 U+10000 以上的字）占**两个**码元。切点正好落在两者之间时，头部结尾是一个
 * **孤立的高位代理**（U+D800..DBFF），尾部开头是一个**孤立的低位代理**（U+DC00..DFFF）。
 *
 * 这不是「显示难看」，是**会让整条会话报废**：
 *   · 带孤立代理的字符串进了请求载荷，provider 会以**不可重试的 400** 拒绝；
 *   · 而坏值已经写进会话日志 → 每次恢复都再发一次 → 会话从此救不回来。
 * 2026-11-02 实测：`~/.dsh/sessions` 全量 456 档 / 1,127,335 行里有 18 处孤立代理，
 * 全部是这条路径产生的（surface map 的 `slice(0, 72)` 预览、以及本文件的 `cutText`）。
 *
 * @param {string} text 原文
 * @param {number} index 想切在哪个码元下标
 * @returns {number} 安全的下标（若前一个码元是高位代理，就退一格）
 */
export function safeCutIndex(text, index) {
  const s = String(text ?? '');
  const i = Math.max(0, Math.min(s.length, Math.floor(index)));
  if (i <= 0 || i >= s.length) return i;
  const before = s.charCodeAt(i - 1);
  return before >= 0xd800 && before <= 0xdbff ? i - 1 : i;   // 别把一对切成两半
}

/**
 * 取头部前 `maxChars` 个码元，**绝不**以孤立高位代理结尾。
 * 这是所有「事件预览」应该走的路（surface map、handoff 摘要、图节点预览……）。
 */
export function truncateText(text, maxChars, { ellipsis = '' } = {}) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(maxChars));
  if (s.length <= n) return s;
  return s.slice(0, safeCutIndex(s, n)) + ellipsis;
}

/**
 * 取尾部后 `keepChars` 个码元，**绝不**以孤立低位代理开头。
 */
export function tailText(text, keepChars) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(keepChars));
  if (n === 0) return '';
  if (s.length <= n) return s;
  let start = s.length - n;
  const after = s.charCodeAt(start);
  if (after >= 0xdc00 && after <= 0xdfff) start += 1;        // 跳过孤立的低半
  return s.slice(start);
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
  // 2026-11-02：原来是 `s.slice(0, head)` / `s.slice(s.length - tail)`。
  // 按码元切会劈开代理对 —— 头以孤立高位结尾、尾以孤立低位开头，而这条路径
  // **写回会话日志**，坏值从此留在历史里。改用码点安全的截断。
  return { head: truncateText(s, head), tail: tailText(s, tail), elided: s.length - head - tail, total: s.length };
}

/**
 * The replacement parts for one tool result: head, a marker naming what was dropped and how to get it
 * back, then the tail. The marker is the whole point — an agent that needs a detail knows the original
 * is one lookup away instead of guessing that the output was never that long.
 */
export function shrunkenContent(parts, { seq, toolName, headChars, tailChars, keepChars = 0 } = {}) {
  const text = partsText(parts);
  const cut = cutText(text, { headChars, tailChars });
  if (cut.elided <= keepChars) return null;              // nothing worth the replacement
  const where = seq == null ? 'the session log' : 'the session log, seq ' + seq;
  const marker = SHRINK_MARKER_PREFIX + (toolName || 'tool') + ' · ' + cut.elided + ' of ' + cut.total
    + ' chars elided — original in ' + where + ']';
  return [{ type: 'text', text: cut.head + '\n' + marker + (cut.tail === '' ? '' : '\n' + cut.tail) }];
}

/**
 * Pick the tool results worth shrinking — NEWEST first, inside a bounded window.
 *
 * Order is a COST decision. A replacement invalidates the provider's prefix from the changed node
 * ONWARD, so the re-bill is proportional to the distance from the tail: rewriting a result 2000 nodes
 * back re-bills the whole rest of the context (~360k miss-equivalents on a heavy session) to free
 * ~1k tokens of carry (~104 equivalents per request) — economically backwards. Taking the newest
 * eligible results keeps the re-billed region to a few nodes, which is what makes the trade pay.
 * Older bulk is left to the next fold, which pays one miss for everything.
 *
 * Guards: only tool/result nodes; never within `protectedTail` nodes of the end (the live tail is
 * what the agent is reasoning about); only within `windowNodes` of that boundary; only at least
 * `minTokens`; never one holding an image; never one that already carries the marker.
 *
 * @param nodes surface nodes as {seq, type, tokens} (see surfaceNodes).
 * @param eventBySeq full events by seq (see getSessionFileEvents).
 * @returns candidates newest first: {seq, tokens, toolName, shape, message, wrapper, parts}
 */
export function shrinkTargets({ nodes = [], eventBySeq = new Map(), minTokens = 800, protectedTail = 4, windowNodes = 16, limit = Infinity } = {}) {
  const out = [];
  const newest = nodes.length - 1 - Math.max(0, protectedTail);
  const span = Number.isFinite(windowNodes) ? Math.max(0, windowNodes - 1) : newest;
  const oldest = Math.max(0, newest - span);
  for (let i = newest; i >= oldest; i--) {
    const node = nodes[i];
    if (node?.type !== 'tool/result') continue;
    if (Number(node.tokens ?? 0) < minTokens) continue;
    const result = toolResultOf(eventBySeq.get(Number(node.seq))?.data?.message);
    if (result == null) continue;
    if (hasNonTextParts(result.parts)) continue;
    if (isShrunkContent(result.parts)) continue;
    if (partsText(result.parts).length === 0) continue;
    out.push({ seq: Number(node.seq), tokens: Number(node.tokens ?? 0), toolName: result.toolName, shape: result.shape, message: result.message, wrapper: result.wrapper, parts: result.parts });
    if (out.length >= limit) break;
  }
  return out;
}
