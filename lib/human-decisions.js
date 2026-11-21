/**
 * Human-message extraction for compaction.
 *
 * ## Why this exists
 *
 * Compaction replaces a surface span with a model-written summary. Measured over 150 sessions and
 * 2,944 folded human messages (`_p0/measure-decision-loss.mjs`), the loss is not uniform — it is
 * worst exactly where it matters most:
 *
 *   short replies (< 20 chars)      51.6% lost
 *   medium (20-100)                 64.8% lost
 *   long (> 100)                    76.8% lost
 *   long AND decision-bearing       87.1% lost
 *
 * The cause is structural, not model laziness: `dsh-compaction-basic`'s summary prompt
 * (`lib/index.js:246-278`) has eight fixed sections and NONE of them asks for the user's own words.
 * `Primary Request and Intent` says "quote verbatim where the exact wording matters", but "where it
 * matters" is the summarizer's judgement, and a summarizer keeps conclusions while dropping the
 * reasoning that produced them.
 *
 * ## What "context correspondence" means here
 *
 * The user's objection was not "text was lost" but "the correspondence between the message and its
 * context was lost". A quoted sentence without its surroundings answers the wrong question: the same
 * words can be right in one situation and wrong in another. So each extracted message carries:
 *
 *   before.lastAssistantSeq / before.lastToolSeq  — what was being discussed when it was said
 *   after.firstAssistantSeq                       — what changed as a result
 *
 * ## Why extraction instead of exclusion
 *
 * The obvious alternative is "never fold human messages". That does not work: `surfaceOp: replace`
 * requires a CONTIGUOUS span, and human messages are scattered through the range. Excluding them
 * would shatter the range into pieces too small to fold. Extraction leaves the fold intact and puts
 * the messages back afterwards.
 *
 * ## Cost
 *
 * Human messages are 0.08% of the surface (31,365 chars out of 39.2M in one 8-day session). Keeping
 * every one of them verbatim is nearly free — the least reconstructable content is also the cheapest.
 *
 * @module dsh-session-handoff/human-decisions
 */

/**
 * Words that mark a message as setting direction rather than acknowledging receipt.
 *
 * This is a HEURISTIC and it is known to be incomplete: "use A not B" carries a decision without
 * containing any of these words. It is used to RANK what to surface first, never to decide what to
 * discard — every human message is extracted regardless.
 */
export const DECISION_MARKERS = [
  // Chinese
  '應該', '不該', '不要', '不准', '必須', '改成', '而不是', '錯誤', '問題在',
  '記住', '規則', '判準', '決定', '以後', '一律', '絕不', '優先', '注意',
  // English
  'should', 'must', 'never', 'instead', 'rule', 'decide', 'wrong', 'remember',
]

/**
 * Does this text read like a decision rather than an acknowledgement?
 * @param text - message text; null and empty are not decisions.
 * @returns true when any marker appears (case-insensitive).
 */
export function hasDecisionMarker(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const lower = text.toLowerCase()
  return DECISION_MARKERS.some((m) => lower.includes(m.toLowerCase()))
}

/** Pull plain text out of a message payload, tolerating string and block-array content. */
function textOf(data) {
  const m = data?.message ?? data
  const c = m?.content ?? m?.text
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ')
  return ''
}

/**
 * Source kinds whose messages carry the human's own words.
 *
 * `user` is the human. `acp-human-decisions` is what THIS module appends after a fold — without it
 * the protection lasts exactly one fold: the block would be folded away by the next compaction and
 * the words would be gone for good. Treating our own output as input is what makes the guarantee
 * hold across repeated folds.
 */
export const HUMAN_SOURCE_KINDS = ['user', 'acp-human-decisions']

/** Is this event a human message? `user/message` is a container; `source.kind` is the discriminator. */
function isHuman(event) {
  if (event?.type !== 'user/message') return false
  const kind = event?.data?.source?.kind
  return HUMAN_SOURCE_KINDS.includes(kind)
}

/**
 * Extract every human message inside an inclusive surface range, with its surrounding context.
 *
 * Deterministic: no model call, no heuristics about importance. Every human message in range is
 * returned; `decision` only ranks them.
 *
 * ## Why our own injected block is treated as input
 *
 * After a fold this module appends a `user/message` with `source.kind: 'acp-human-decisions'`
 * carrying the extracted words. If that block were NOT recognised as human content, the next fold
 * would swallow it and the protection would last exactly one fold. So it is recognised — and then
 * de-duplicated, because the block re-states messages that may still be in range.
 *
 * De-duplication is by normalised text: a message whose words already appear inside a longer
 * extracted message is dropped. That keeps the block from growing on every fold while never losing
 * a message that says something new.
 *
 * @param events - session events in log order.
 * @param range - inclusive `{ start, end }` seq bounds; omit to scan everything.
 * @returns one record per distinct human message, in log order.
 */
export function extractHumanDecisions(events, range) {
  if (!Array.isArray(events)) return []
  const start = Number.isFinite(range?.start) ? range.start : -Infinity
  const end = Number.isFinite(range?.end) ? range.end : Infinity

  const out = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!isHuman(event)) continue
    if (!(event.seq >= start && event.seq <= end)) continue

    const text = textOf(event.data)
    if (!text.trim()) continue

    // Walk backwards for the most recent assistant / tool result BEFORE this message, and forwards
    // for the first assistant AFTER it. Both stay inside the range: context outside the fold is
    // still on the surface and does not need to be restated.
    let lastAssistantSeq = null
    let lastToolSeq = null
    for (let j = i - 1; j >= 0; j--) {
      const e = events[j]
      if (!(e.seq >= start)) break
      if (lastAssistantSeq === null && e.type === 'assistant/message') lastAssistantSeq = e.seq
      if (lastToolSeq === null && e.type === 'tool/result') lastToolSeq = e.seq
      if (lastAssistantSeq !== null && lastToolSeq !== null) break
    }

    let firstAssistantSeq = null
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]
      if (!(e.seq <= end)) break
      if (e.type === 'assistant/message') {
        firstAssistantSeq = e.seq
        break
      }
    }

    out.push({
      seq: event.seq,
      turn: event.turn ?? null,
      time: event.time ?? null,
      chars: text.length,
      text,
      decision: hasDecisionMarker(text),
      before: { lastAssistantSeq, lastToolSeq },
      after: { firstAssistantSeq },
    })
  }
  return dedupeByText(out)
}

/** Normalise for comparison: collapse whitespace, drop Markdown decoration. */
function normalise(text) {
  return String(text ?? '')
    .replace(/[#>*_`\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Drop records whose words are already contained in a longer record.
 *
 * The injected block is a rendering of earlier messages, so it repeats them. Keeping both would
 * make the block grow on every fold. A record is dropped only when its normalised text is a
 * substring of another record's — a genuinely new message is never dropped.
 */
function dedupeByText(records) {
  if (records.length < 2) return records
  const norm = records.map((r) => normalise(r.text))
  const keep = new Array(records.length).fill(true)
  for (let i = 0; i < records.length; i++) {
    for (let j = 0; j < records.length; j++) {
      if (i === j || !keep[i]) continue
      // Drop the shorter one when it is contained in the longer one.
      if (norm[i].length < norm[j].length && norm[j].includes(norm[i])) {
        keep[i] = false
        break
      }
      // Equal length and equal text: keep the earlier seq, drop the later duplicate.
      if (norm[i].length === norm[j].length && norm[i] === norm[j] && i > j) {
        keep[i] = false
        break
      }
    }
  }
  return records.filter((_, i) => keep[i])
}

/**
 * Render extracted records as a compact Markdown block for injection after a fold.
 *
 * ## Selection, not truncation
 *
 * The first version sorted decision-bearing messages first and then filled up to `maxChars` in
 * order. Measured over 6 sessions with 1,934 human messages (`_p0/measure-cap-coverage.mjs`):
 * an 8,000-char cap kept only **127 of 1,613** renderable messages — **7.9%**. The cap protected
 * the cost and destroyed the protection: 92% of the words were dropped anyway.
 *
 * So the cap now selects instead of truncating:
 *
 *   1. every decision-bearing message (they set direction; there are few)
 *   2. the most RECENT messages, newest first, until the budget is spent
 *
 * Recency beats log order because a fold's range ends at the present: the newest messages are the
 * ones the next turn is most likely to still be acting on. A message from 200 turns ago that is
 * neither decision-bearing nor recent is the cheapest thing to drop.
 *
 * When even that overflows, the block says how many were dropped and that they remain in the log —
 * a silent truncation would read as "this is everything".
 *
 * @param records - output of {@link extractHumanDecisions}.
 * @param options - `maxChars` caps the rendered block (default 8000); 0 means no cap.
 * @returns Markdown text, or an empty string when there is nothing to render.
 */
export function renderHumanDecisions(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 8000

  // 1. decision-bearing first (in log order — they read as a sequence of instructions)
  // 2. then the rest, NEWEST first, so the budget goes to what is still being acted on
  const decisions = records.filter((r) => r.decision).sort((a, b) => a.seq - b.seq)
  const others = records.filter((r) => !r.decision).sort((a, b) => b.seq - a.seq)
  const ordered = [...decisions, ...others]

  const header = [
    '## Human messages in the folded range (verbatim)',
    '',
    "These are the user's own words from the range just summarized, with the context each one",
    'answered. A summary keeps conclusions; this keeps the instruction and what it was responding to.',
    '',
  ].join('\n')

  const lines = [header]
  let used = header.length
  let omitted = 0
  let omittedDecisions = 0
  for (const r of ordered) {
    const contextParts = []
    if (r.before?.lastAssistantSeq != null) contextParts.push(`after assistant seq ${r.before.lastAssistantSeq}`)
    if (r.before?.lastToolSeq != null) contextParts.push(`after tool result seq ${r.before.lastToolSeq}`)
    if (r.after?.firstAssistantSeq != null) contextParts.push(`led to assistant seq ${r.after.firstAssistantSeq}`)
    const ctxLine = contextParts.length ? `  _(${contextParts.join('; ')})_` : ''
    const block = [`- **seq ${r.seq}**${r.decision ? ' **[decision]**' : ''}${ctxLine}`, `  > ${r.text.replace(/\n/g, '\n  > ')}`].join('\n')
    if (maxChars > 0 && used + block.length > maxChars) {
      omitted++
      if (r.decision) omittedDecisions++
      continue
    }
    lines.push(block)
    used += block.length
  }

  if (omitted > 0) {
    const parts = [`_(${omitted} more human message(s) omitted by the size cap`]
    if (omittedDecisions > 0) parts.push(`, ${omittedDecisions} of them decision-bearing`)
    parts.push('; all remain in the session log and are reachable with acp_search.)_')
    lines.push('', parts.join(''))
  }
  return lines.join('\n')
}
