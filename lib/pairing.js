/**
 * Tool-pairing balance over a surface — the rule the core enforces on every compactRegion call.
 *
 * `dsh-compaction` refuses a range whose cut would split a step's tool-call/result pair:
 * "end seq N is not a balanced boundary (would split a step, or the step is still open)". That
 * refusal used to end a fold the agent had already announced, so `runCompaction` retries — and the
 * retry must fold no MORE than the caller asked for, which needs the nearest balanced cut at or BEFORE
 * the requested end.
 *
 * TWO REPRESENTATIONS (see shrink.js for the full note). Session format V4 lifted the tool result out
 * of its `tool-result` wrapper into a first-class `role: 'tool'` message:
 *
 *   V3: the call closes inside `content[0] = { type:'tool-result', toolCallId }`
 *   V4: the call closes by the MESSAGE itself — role 'tool' + `message.toolCallId`
 *
 * Detecting only the V3 wrapper on a V4 log would leave every call looking open, i.e. every cut
 * unbalanced — the retry would then refuse the folds it exists to save.
 */

/** The tool-call ids a node OPENS and the ones it CLOSES, across both representations. */
export function pairingEffect(event) {
  const message = event?.data?.message ?? event?.data ?? null;
  const opens = [];
  const closes = [];
  if (message == null || typeof message !== 'object') return { opens, closes };
  // V4 first-class tool message: closes the call it names.
  if (message.role === 'tool' || typeof message.toolCallId === 'string') {
    const id = typeof message.toolCallId === 'string' ? message.toolCallId : message.source?.callId;
    if (typeof id === 'string' && id.length > 0) closes.push(id);
  }
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type === 'tool-call') {
      const id = block.id ?? block.toolCallId;
      if (typeof id === 'string' && id.length > 0) opens.push(id);
    } else if (block?.type === 'tool-result') {
      if (typeof block.toolCallId === 'string' && block.toolCallId.length > 0) closes.push(block.toolCallId);
    }
  }
  return { opens, closes };
}

/**
 * Surface indices after which the cut is balanced — no unanswered tool call crosses it.
 * @returns Set<number> of indices (the cut AFTER `nodes[i]`).
 */
export function balancedCutsAfter(nodes = [], eventBySeq = new Map()) {
  const open = new Set();
  const cuts = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const { opens, closes } = pairingEffect(eventBySeq.get(Number(nodes[i])));
    for (const id of opens) open.add(id);
    for (const id of closes) open.delete(id);
    if (open.size === 0) cuts.add(i);
  }
  return cuts;
}

/**
 * The nearest balanced end at or before `endSeq` (and strictly after `startSeq`), or null when the
 * requested range holds no balanced cut. Folding down can only ever remove LESS than was asked for.
 */
export function snapEndDown({ nodes = [], eventBySeq = new Map(), startSeq, endSeq } = {}) {
  const endIdx = nodes.indexOf(Number(endSeq));
  const startIdx = nodes.indexOf(Number(startSeq));
  if (endIdx < 0 || startIdx < 0 || endIdx <= startIdx) return null;
  const cuts = balancedCutsAfter(nodes, eventBySeq);
  for (let i = endIdx; i > startIdx; i--) if (cuts.has(i)) return Number(nodes[i]);
  return null;
}
