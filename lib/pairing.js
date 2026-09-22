/**
 * Tool-pairing balance over a surface — the rule the core enforces on every compactRegion call.
 *
 * `dsh-compaction` refuses a range whose cut would split a step's tool-call/result pair:
 * "end seq N is not a balanced boundary (would split a step, or the step is still open)". That
 * refusal used to end a fold the agent had already announced, so `runCompaction` retries. The retry
 * must fold no MORE than the caller asked for, which needs the nearest balanced cut at or BEFORE the
 * requested end — the boundary `end: 'auto'` picks is the one nearest the preserved TAIL, i.e. the
 * opposite direction.
 *
 * The rule is replicated here rather than imported: the plugin is zero-dependency by design and the
 * harness packages do not resolve from a profile's own node_modules.
 */

/** The tool-call ids a node OPENS and the one it CLOSES, read off its own message content. */
export function pairingEffect(event) {
  const message = event?.data?.message ?? event?.data ?? null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const opens = [];
  const closes = [];
  for (const block of content) {
    if (block?.type === 'tool-call' && typeof block.id === 'string') opens.push(block.id);
    else if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') closes.push(block.toolCallId);
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
