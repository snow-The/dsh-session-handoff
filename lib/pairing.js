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
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block?.type === 'tool-call') {
      const id = block.id ?? block.toolCallId;
      // A tool-call with NO usable id still OPENS a call. Skipping it made this function report a
      // cut as balanced where the core reports it as unbalanced — the dangerous direction, because
      // the fold then asks for an end the core refuses. The core counts calls (`eventDelta` in
      // `dsh-compaction/lib/index.js:21-27` returns the number of tool-call blocks, id or not), so
      // an anonymous open must stay open. A synthetic id keeps it open forever, which is exactly
      // what the count does.
      //
      // Measured 2026-11-22 (`_p0/probe-pairing-agreement.mjs`): 0 occurrences in 9,978 real
      // surface nodes, so this is preventive, not a fix for an observed failure.
      opens.push(typeof id === 'string' && id.length > 0 ? id : `\u0000anon:${i}`);
    } else if (block?.type === 'tool-result') {
      if (typeof block.toolCallId === 'string' && block.toolCallId.length > 0) closes.push(block.toolCallId);
    }
  }
  return { opens, closes };
}

/**
 * Surface indices after which the cut is balanced — no unanswered tool call crosses it.
 *
 * `nodes[i]` is a NODE OBJECT, so `eventBySeq.get(Number(nodes[i]))` was `get(NaN)` — always
 * undefined, so `pairingEffect` saw no opens and no closes and EVERY cut looked balanced. That
 * made `snapEndDown` return the requested end unchanged, i.e. the "snap down" never snapped.
 * Same defect class as the nine `nodes.indexOf(seq)` calls in index.js.
 *
 * @returns Set<number> of indices (the cut AFTER `nodes[i]`).
 */
export function balancedCutsAfter(nodes = [], eventBySeq = new Map()) {
  const open = new Set();
  const cuts = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const seq = typeof n === 'number' ? n : n?.seq;
    const { opens, closes } = pairingEffect(eventBySeq.get(Number(seq)));
    for (const id of opens) open.add(id);
    for (const id of closes) open.delete(id);
    if (open.size === 0) cuts.add(i);
  }
  return cuts;
}

/**
 * Index of a surface node by SEQ.
 *
 * `nodes` holds NODE OBJECTS (`{ seq, type, ... }`), not seqs, so `nodes.indexOf(seq)` compares
 * by identity and is ALWAYS -1. Measured 2026-11-21: this made `snapEndDown` return null on
 * every call, which is the ONLY recovery path when a fold's requested end splits a step — so a
 * fold that hit "not a balanced boundary" had no way to snap down and simply failed.
 *
 * Accepts a bare number too, so unit tests can pass plain seq arrays.
 */
function nodeIndex(nodes, seq) {
  if (!Array.isArray(nodes)) return -1
  const want = typeof seq === 'number' ? seq : seq?.seq
  if (want == null) return -1
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const have = typeof n === 'number' ? n : n?.seq
    if (have === want) return i
  }
  return -1
}

/**
 * The nearest balanced end at or before `endSeq` (and strictly after `startSeq`), or null when the
 * requested range holds no balanced cut. Folding down can only ever remove LESS than was asked for.
 */
export function snapEndDown({ nodes = [], eventBySeq = new Map(), startSeq, endSeq } = {}) {
  const endIdx = nodeIndex(nodes, Number(endSeq));
  const startIdx = nodeIndex(nodes, Number(startSeq));
  if (endIdx < 0 || startIdx < 0 || endIdx <= startIdx) return null;
  const cuts = balancedCutsAfter(nodes, eventBySeq);
  // `nodes[i]` is a NODE OBJECT, so `Number(nodes[i])` is NaN — the caller then got NaN as the
  // snapped end. Return the seq, not the node and not Number(node).
  const seqAt = (i) => {
    const n = nodes[i];
    return typeof n === 'number' ? n : n?.seq;
  };
  for (let i = endIdx; i > startIdx; i--) if (cuts.has(i)) return seqAt(i);
  return null;
}
