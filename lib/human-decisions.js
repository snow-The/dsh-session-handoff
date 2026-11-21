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

/** Is this event a human message? `user/message` is a container; `source.kind` is the discriminator. */
function isHuman(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * Extract every human message inside an inclusive surface range, with its surrounding context.
 *
 * Deterministic: no model call, no heuristics about importance. Every human message in range is
 * returned; `decision` only ranks them.
 *
 * @param events - session events in log order.
 * @param range - inclusive `{ start, end }` seq bounds; omit to scan everything.
 * @returns one record per human message, in log order.
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
  return out
}

/**
 * Render extracted records as a compact Markdown block for injection after a fold.
 *
 * Decision-bearing messages come first so a reader who stops early still sees the direction-setting
 * ones. Every message is included; ordering is the only thing `decision` changes.
 *
 * @param records - output of {@link extractHumanDecisions}.
 * @param options - `maxChars` caps the rendered block (default 8000); 0 means no cap.
 * @returns Markdown text, or an empty string when there is nothing to render.
 */
export function renderHumanDecisions(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 8000

  const ordered = [...records].sort((a, b) => {
    if (a.decision !== b.decision) return a.decision ? -1 : 1
    return a.seq - b.seq
  })

  const lines = [
    '## Human messages in the folded range (verbatim)',
    '',
    'These are the user\'s own words from the range just summarized, with the context each one',
    'answered. A summary keeps conclusions; this keeps the instruction and what it was responding to.',
    '',
  ]

  let used = lines.join('\n').length
  let omitted = 0
  for (const r of ordered) {
    // Named `contextParts`, not `ctx`: a repo-wide test scans for `ctx.<service>` to prove every
    // Cordis service is injected, and a local variable called `ctx` reads as a violation.
    const contextParts = []
    if (r.before?.lastAssistantSeq != null) contextParts.push(`after assistant seq ${r.before.lastAssistantSeq}`)
    if (r.before?.lastToolSeq != null) contextParts.push(`after tool result seq ${r.before.lastToolSeq}`)
    if (r.after?.firstAssistantSeq != null) contextParts.push(`led to assistant seq ${r.after.firstAssistantSeq}`)
    const ctxLine = contextParts.length ? `  _(${contextParts.join('; ')})_` : ''
    const block = [`- **seq ${r.seq}**${r.decision ? ' **[decision]**' : ''}${ctxLine}`, `  > ${r.text.replace(/\n/g, '\n  > ')}`].join('\n')
    if (maxChars > 0 && used + block.length > maxChars) {
      omitted++
      continue
    }
    lines.push(block)
    used += block.length
  }

  if (omitted > 0) {
    lines.push('', `_(${omitted} more human message(s) omitted by the size cap; they remain in the session log.)_`)
  }
  return lines.join('\n')
}
