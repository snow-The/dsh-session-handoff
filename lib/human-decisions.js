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
 * Assistant text only — `assistant/message` content is a block array and only `type: 'text'`
 * blocks are prose. Reasoning and tool-call blocks are not the outcome of a turn.
 */
function assistantTextOf(data) {
  const c = data?.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * A tool call as `name(signature)`.
 *
 * `data.arguments` is a JSON **string**, not an object. The first version read `data.input` and
 * produced `pwsh({})` for every single call — a signature that identifies nothing.
 *
 * `run_code` is special: its `code` argument is an entire program, and taking the first 70 chars of
 * it produces noise like `run_code(// 確認現有 vision 文檔的尾部,以便新文檔正確引用 const vision = ...)`.
 * Measured on a real fold: one turn's Did line reached 800+ chars of unreadable fragments. For
 * `run_code` the signature is the first `tools.<verb>({...})` call inside the program — that names
 * the action ("read", "grep", "edit") instead of quoting the source.
 */
function toolCallSignature(data) {
  const name = data?.name ?? '?'
  let args = data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      /* not JSON — keep the raw string as the signature */
    }
  }
  let sig = ''
  if (typeof args === 'string') sig = args
  else if (args && typeof args === 'object') {
    if (name === 'run_code' && typeof args.code === 'string') {
      // Name the first tool the program calls, plus its first path/pattern argument.
      const m = args.code.match(/tools\.(\w+)\s*\(\s*\{([^}]*)\}/)
      if (m) {
        const verb = m[1]
        const inner = m[2]
        const arg =
          inner.match(/(?:file_path|path|pattern|query|command)\s*:\s*["'`]([^"'`]{0,60})/)?.[1] ?? ''
        sig = arg ? `${verb}(${arg})` : `${verb}(...)`
      } else {
        // No recognisable tool call: say how big the program was rather than quoting it.
        sig = `<${args.code.split('\n').length} lines>`
      }
    } else {
      sig =
        args.file_path ??
        args.path ??
        args.command ??
        args.query ??
        args.pattern ??
        args.code ??
        JSON.stringify(args)
    }
  }
  return `${name}(${String(sig).replace(/\s+/g, ' ').slice(0, 70)})`
}

/** First non-empty line, truncated — the cheapest thing that still identifies a block of prose. */
function firstLine(text, max = 110) {
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (t) return t.slice(0, max)
  }
  return ''
}

/**
 * Group events into turns.
 *
 * `user/message` does NOT carry a `turn` field (measured: 0 of 352). The turn number lives on
 * `turn/start` events, so grouping is "everything after a turn/start belongs to that turn".
 *
 * Measured over 264 folded human messages: every turn contains EXACTLY ONE human message
 * (264/264 = 100%), so this grouping is unambiguous — a turn is a single exchange.
 *
 * @param events - session events in log order.
 * @returns `[{ turn, events }]`, in log order; events before the first turn/start are dropped.
 */
export function groupByTurn(events) {
  if (!Array.isArray(events)) return []
  const groups = []
  let current = null
  for (const e of events) {
    if (e?.type === 'turn/start' && Number.isFinite(e.data?.turn)) {
      current = { turn: e.data.turn, events: [] }
      groups.push(current)
      continue
    }
    if (current !== null) current.events.push(e)
  }
  return groups
}

/**
 * Reduce one turn to the three things that make it reconstructable.
 *
 * The flat list this replaces recorded a seq pointer per message — `_(after assistant seq 1230;
 * after tool result seq 1228; led to assistant seq 1240)_`. Measured: that pointer costs ~120 chars
 * per message while the message itself is p50 36 chars, and it was NEVER dereferenced
 * (`acp_search`: 0 calls in 316 folds / 70,073 tool calls). It recorded a reference nobody follows.
 *
 * These three fields say what the pointer was trying to say, in words:
 *
 *   human    — what the user asked (verbatim; this is the part a summary drops)
 *   did      — which tools ran, by signature (what was attempted)
 *   outcome  — the last assistant prose (what came of it)
 *
 * Tool RESULTS are deliberately not inlined: they are the bulk of the surface and the fold's
 * summary already covers them. The signature is what identifies the action.
 *
 * @param events - the events of one turn.
 * @param turn - the turn number, for the returned record.
 * @returns `{ turn, human, did, outcome }`.
 */
export function summariseTurn(events, turn) {
  const human = []
  const did = []
  const seenCall = new Set()
  let outcome = ''
  for (const e of events ?? []) {
    if (e?.type === 'user/message' && HUMAN_SOURCE_KINDS.includes(e?.data?.source?.kind)) {
      const t = textOf(e.data)
      if (t.trim()) human.push(t)
    } else if (e?.type === 'tool/call') {
      const sig = toolCallSignature(e.data)
      if (!seenCall.has(sig)) {
        seenCall.add(sig)
        did.push(sig)
      }
    } else if (e?.type === 'assistant/message') {
      const t = assistantTextOf(e.data)
      if (t.trim()) outcome = firstLine(t)
    }
  }
  // Cap the action list. Measured on a real fold: one turn ran 13 distinct `run_code` programs and
  // the Did line became a 700-char wall that no reader parses. The first few actions identify what
  // the turn was about; the rest is detail the summary already covers.
  const MAX_DID = 5
  const didCapped = did.length > MAX_DID ? [...did.slice(0, MAX_DID), `+${did.length - MAX_DID} more`] : did
  return { turn, human, did: didCapped, outcome }
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

  // Turn numbers live on `turn/start`, never on `user/message` (measured 0 of 352). Build the
  // seq -> turn map once so each record can carry the turn it belongs to.
  const turnAt = new Map()
  let currentTurn = null
  for (const e of events) {
    if (e?.type === 'turn/start' && Number.isFinite(e.data?.turn)) currentTurn = e.data.turn
    if (Number.isFinite(e?.seq)) turnAt.set(e.seq, currentTurn)
  }

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
      turn: turnAt.get(event.seq) ?? null,
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
 * ## Turn-grouped, not a flat list
 *
 * The first version rendered one bullet per message with a seq pointer. Measured over 138
 * sessions / 22 folds / 264 folded human messages:
 *
 *   - the pointer cost ~120 chars per message; the message itself is p50 36 chars
 *   - the pointer was never dereferenced: `acp_search` was called 0 times in 316 folds
 *   - every turn holds exactly one human message (264/264 = 100%)
 *   - turn-grouped rendering costs 0.73% of what the fold saves
 *
 * A flat list of 264 messages is not "organised", it is merely "not lost". Grouping by turn turns
 * it into 264 units of "what was asked -> what was done -> what came out", which is the
 * correspondence the user asked to preserve. When `events` is supplied the block is grouped by
 * turn; without it the records are rendered flat (the caller may only have records).
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
 *   1. every decision-bearing turn (they set direction; there are few)
 *   2. the most RECENT turns, newest first, until the budget is spent
 *
 * Recency beats log order because a fold's range ends at the present: the newest turns are the
 * ones the next turn is most likely to still be acting on.
 *
 * When even that overflows, the block says how many were dropped and that they remain in the log —
 * a silent truncation would read as "this is everything".
 *
 * @param records - output of {@link extractHumanDecisions}.
 * @param options - `maxChars` caps the rendered block (default 32000); 0 means no cap.
 *                  `events` enables turn grouping; omit for a flat list.
 * @returns Markdown text, or an empty string when there is nothing to render.
 */
export function renderHumanDecisions(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 32000
  const events = Array.isArray(options.events) ? options.events : null

  // Build the units to render. With events, a unit is a TURN; without, a unit is a message.
  let units
  if (events) {
    const byTurn = new Map()
    for (const g of groupByTurn(events)) {
      const s = summariseTurn(g.events, g.turn)
      if (s.human.length > 0) byTurn.set(g.turn, s)
    }
    units = records.map((r) => {
      const s = r.turn != null ? byTurn.get(r.turn) : null
      return {
        key: r.turn ?? r.seq,
        turn: r.turn,
        decision: r.decision,
        seq: r.seq,
        human: s?.human?.length ? s.human : [r.text],
        did: s?.did ?? [],
        outcome: s?.outcome ?? '',
      }
    })
    // One unit per turn: a turn with several messages already carries all of them.
    const seen = new Set()
    units = units.filter((u) => {
      if (u.turn == null) return true
      if (seen.has(u.turn)) return false
      seen.add(u.turn)
      return true
    })
  } else {
    units = records.map((r) => ({
      key: r.seq,
      turn: r.turn ?? null,
      decision: r.decision,
      seq: r.seq,
      human: [r.text],
      did: [],
      outcome: '',
    }))
  }

  // 1. decision-bearing first (in log order — they read as a sequence of instructions)
  // 2. then the rest, NEWEST first, so the budget goes to what is still being acted on
  const decisions = units.filter((u) => u.decision).sort((a, b) => a.seq - b.seq)
  const others = units.filter((u) => !u.decision).sort((a, b) => b.seq - a.seq)
  const ordered = [...decisions, ...others]

  const header = [
    '## Human messages in the folded range (verbatim, grouped by turn)',
    '',
    "These are the user's own words from the range just summarized, with what was done about each",
    'and what came of it. A summary keeps conclusions; this keeps the instruction and its result.',
    '',
  ].join('\n')

  // The header is prose about the block, not content of it. When the cap is small enough that the
  // header alone would consume it, the header is what gets dropped — never the decision-bearing
  // turns. (Measured failure: with maxChars 200 the 300-char header left zero room and EVERY
  // decision message was omitted, which is the exact opposite of what the cap is for.)
  const headerFits = maxChars <= 0 || header.length < maxChars * 0.5
  const lines = headerFits ? [header] : []
  let used = headerFits ? header.length : 0
  let omitted = 0
  let omittedDecisions = 0
  for (const u of ordered) {
    const parts = []
    parts.push(u.turn != null ? `### Turn ${u.turn}` : `### seq ${u.seq}`)
    for (const h of u.human) parts.push(`**User**: ${h.replace(/\n/g, '\n  ')}`)
    if (u.did.length) parts.push(`**Did**: ${u.did.join('; ')}`)
    if (u.outcome) parts.push(`**Outcome**: ${u.outcome}`)
    const block = parts.join('\n')
    if (maxChars > 0 && used + block.length > maxChars) {
      omitted++
      if (u.decision) omittedDecisions++
      continue
    }
    lines.push('', block)
    used += block.length
  }

  if (omitted > 0) {
    const parts = [`_(${omitted} more turn(s) omitted by the size cap`]
    if (omittedDecisions > 0) parts.push(`, ${omittedDecisions} of them decision-bearing`)
    parts.push('; all remain in the session log and are reachable with acp_search.)_')
    lines.push('', parts.join(''))
  }
  return lines.join('\n')
}
