/**
 * Tests for turn-grouped human-message preservation.
 *
 * ## What changed and why
 *
 * The first implementation (`human-decisions.js`) rendered a FLAT list of messages, each with a
 * seq pointer:
 *
 *   - **seq 1234** _(after assistant seq 1230; after tool result seq 1228; led to assistant seq 1240)_
 *     > 用戶的原話
 *
 * Measured over 138 sessions / 22 folds / 264 folded human messages
 * (`_p0/measure-context-correspondence.mjs`, `_p0/measure-turn-structure.mjs`):
 *
 *   - the seq pointer costs ~120 chars per message while the message itself is p50 36 chars
 *   - the pointer is NEVER dereferenced: `acp_search` was called 0 times in 316 folds / 70,073 calls
 *   - every turn contains EXACTLY ONE human message (264/264 = 100%), so the turn is the natural
 *     unit and grouping is unambiguous
 *   - turn-grouped rendering costs 0.73% of what the fold saves; flat + seq pointer costs 0.35%
 *
 * So the pointer was paying 3x the message's own size to record a reference nobody follows. The
 * replacement records what the pointer was trying to say, in words: what the user asked, what was
 * done about it, and what came out. That is the "context correspondence" the user asked for.
 *
 * @module dsh-session-handoff/test/turn-grouped
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHumanDecisions,
  renderHumanDecisions,
  groupByTurn,
  summariseTurn,
} from '../lib/human-decisions.js'

/** Build a minimal session event log. */
function ev(seq, type, data, turn) {
  return { seq, type, time: 1700000000000 + seq, data, ...(turn === undefined ? {} : { turn }) }
}

function human(seq, text) {
  return ev(seq, 'user/message', {
    message: { role: 'user', content: [{ type: 'text', text }] },
    source: { kind: 'user' },
  })
}

function assistant(seq, text) {
  return ev(seq, 'assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function toolCall(seq, name, args) {
  return ev(seq, 'tool/call', { name, arguments: JSON.stringify(args) })
}

function toolResult(seq, text) {
  return ev(seq, 'tool/result', {
    message: {
      role: 'user',
      content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
    },
  })
}

function turnStart(seq, turn) {
  return ev(seq, 'turn/start', { turn })
}

// ---------------------------------------------------------------------------
// groupByTurn
// ---------------------------------------------------------------------------

test('groupByTurn: assigns each event to the turn opened by the preceding turn/start', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'first'),
    assistant(3, 'did first'),
    turnStart(4, 2),
    human(5, 'second'),
    assistant(6, 'did second'),
  ]
  const groups = groupByTurn(events)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].turn, 1)
  assert.deepEqual(groups[0].events.map((e) => e.seq), [2, 3])
  assert.equal(groups[1].turn, 2)
  assert.deepEqual(groups[1].events.map((e) => e.seq), [5, 6])
})

test('groupByTurn: events before the first turn/start belong to no turn', () => {
  const events = [human(1, 'orphan'), turnStart(2, 1), human(3, 'in turn')]
  const groups = groupByTurn(events)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].turn, 1)
  assert.deepEqual(groups[0].events.map((e) => e.seq), [3])
})

test('groupByTurn: a turn/start without a numeric turn is ignored, not treated as turn 0', () => {
  const events = [turnStart(1, undefined), human(2, 'x'), turnStart(3, 7), human(4, 'y')]
  const groups = groupByTurn(events)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].turn, 7)
})

// ---------------------------------------------------------------------------
// summariseTurn
// ---------------------------------------------------------------------------

test('summariseTurn: records what the user said, what was done, and the outcome', () => {
  const events = [
    turnStart(1, 3),
    human(2, '把上限改成 32000'),
    toolCall(3, 'read', { file_path: 'C:/repo/lib/index.js' }),
    toolResult(4, 'file contents'),
    assistant(5, '改好了，測試 269/269 綠。'),
  ]
  const s = summariseTurn(events, 3)
  assert.equal(s.turn, 3)
  assert.deepEqual(s.human, ['把上限改成 32000'])
  assert.deepEqual(s.did, ['read(C:/repo/lib/index.js)'])
  assert.equal(s.outcome, '改好了，測試 269/269 綠。')
})

test('summariseTurn: tool signature comes from data.arguments, which is a JSON STRING', () => {
  // The first version read `data.input` and produced `pwsh({})` for every call.
  const events = [turnStart(1, 1), human(2, 'x'), toolCall(3, 'pwsh', { command: 'node --test' })]
  const s = summariseTurn(events, 1)
  assert.deepEqual(s.did, ['pwsh(node --test)'])
})

test('summariseTurn: run_code names the tool it calls, not the program source', () => {
  // Measured on a real fold: quoting the program produced
  //   run_code(// 確認現有 vision 文檔的尾部,以便新文檔正確引用 const vision = await tools.read({ file_)
  // — 800+ chars of unreadable fragments for one turn.
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    toolCall(3, 'run_code', {
      code: 'const vision = await tools.read({ file_path: "kb/docs/vision.adoc" })\nreturn vision',
    }),
  ]
  const s = summariseTurn(events, 1)
  assert.deepEqual(s.did, ['run_code(read(kb/docs/vision.adoc))'])
})

test('summariseTurn: run_code with no recognisable tool call reports its size, not its source', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    toolCall(3, 'run_code', { code: 'const a = 1\nconst b = 2\nreturn a + b' }),
  ]
  const s = summariseTurn(events, 1)
  assert.deepEqual(s.did, ['run_code(<3 lines>)'])
})

test('summariseTurn: a run_code Did line stays short even for a huge program', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    toolCall(3, 'run_code', { code: 'x'.repeat(20000) }),
  ]
  const s = summariseTurn(events, 1)
  assert.ok(s.did[0].length < 40, `Did line was ${s.did[0].length} chars`)
})

test('summariseTurn: the action list is capped and says how many were dropped', () => {
  // Measured on a real fold: one turn ran 13 distinct run_code programs and the Did line became a
  // 700-char wall. The first few identify the turn; the rest is detail the summary already covers.
  const events = [turnStart(1, 1), human(2, 'x')]
  for (let i = 0; i < 13; i++) {
    events.push(toolCall(3 + i, 'read', { file_path: `f${i}.js` }))
  }
  const s = summariseTurn(events, 1)
  assert.equal(s.did.length, 6) // 5 actions + the "+N more" marker
  assert.equal(s.did[5], '+8 more')
})

test('summariseTurn: exactly 5 actions are not capped', () => {
  const events = [turnStart(1, 1), human(2, 'x')]
  for (let i = 0; i < 5; i++) events.push(toolCall(3 + i, 'read', { file_path: `f${i}.js` }))
  const s = summariseTurn(events, 1)
  assert.equal(s.did.length, 5)
  assert.ok(!s.did.some((d) => d.includes('more')))
})

test('summariseTurn: duplicate tool calls collapse to one entry', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    toolCall(3, 'read', { file_path: 'a.js' }),
    toolCall(4, 'read', { file_path: 'a.js' }),
    toolCall(5, 'read', { file_path: 'b.js' }),
  ]
  const s = summariseTurn(events, 1)
  assert.deepEqual(s.did, ['read(a.js)', 'read(b.js)'])
})

test('summariseTurn: outcome is the LAST assistant text, not the first', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    assistant(3, '先讀檔案'),
    assistant(4, '結論：已修好'),
  ]
  const s = summariseTurn(events, 1)
  assert.equal(s.outcome, '結論：已修好')
})

test('summariseTurn: a turn with no assistant text has an empty outcome, not undefined', () => {
  const events = [turnStart(1, 1), human(2, 'x')]
  const s = summariseTurn(events, 1)
  assert.equal(s.outcome, '')
})

test('summariseTurn: tool results are NOT inlined — only the call signature is kept', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'x'),
    toolCall(3, 'read', { file_path: 'a.js' }),
    toolResult(4, 'x'.repeat(50000)),
  ]
  const s = summariseTurn(events, 1)
  assert.equal(s.did.length, 1)
  assert.ok(!JSON.stringify(s).includes('x'.repeat(1000)))
})

// ---------------------------------------------------------------------------
// extractHumanDecisions — turn attached
// ---------------------------------------------------------------------------

test('extractHumanDecisions: each record carries the turn it belongs to', () => {
  const events = [
    turnStart(1, 1),
    human(2, 'first'),
    turnStart(3, 2),
    human(4, 'second'),
  ]
  const records = extractHumanDecisions(events, { start: 1, end: 4 })
  assert.equal(records.length, 2)
  assert.equal(records[0].turn, 1)
  assert.equal(records[1].turn, 2)
})

test('extractHumanDecisions: turn is null when the message precedes any turn/start', () => {
  const events = [human(1, 'orphan'), turnStart(2, 1)]
  const records = extractHumanDecisions(events, { start: 1, end: 2 })
  assert.equal(records.length, 1)
  assert.equal(records[0].turn, null)
})

// ---------------------------------------------------------------------------
// renderHumanDecisions — turn-grouped output
// ---------------------------------------------------------------------------

test('renderHumanDecisions: groups by turn and shows User / Did / Outcome', () => {
  const events = [
    turnStart(1, 1),
    human(2, '把上限改成 32000'),
    toolCall(3, 'edit', { file_path: 'lib/index.js' }),
    assistant(4, '改好了'),
  ]
  const records = extractHumanDecisions(events, { start: 1, end: 4 })
  const out = renderHumanDecisions(records, { maxChars: 32000, events })
  assert.match(out, /### Turn 1/)
  assert.match(out, /\*\*User\*\*: 把上限改成 32000/)
  assert.match(out, /\*\*Did\*\*: edit\(lib\/index\.js\)/)
  assert.match(out, /\*\*Outcome\*\*: 改好了/)
})

test('renderHumanDecisions: no seq POINTERS in the output', () => {
  // The pointer was never dereferenced (0 acp_search calls in 316 folds) and cost 3x the message.
  // A `### seq N` heading is a label; `_(after assistant seq N; ...)_` is the pointer that was
  // removed. Only the latter is asserted absent.
  const events = [turnStart(1, 1), human(2, 'hello'), assistant(3, 'hi')]
  const records = extractHumanDecisions(events, { start: 1, end: 3 })
  const out = renderHumanDecisions(records, { maxChars: 32000, events })
  assert.doesNotMatch(out, /_\(after assistant seq/)
  assert.doesNotMatch(out, /after tool result seq/)
  assert.doesNotMatch(out, /led to assistant seq/)
})

test('renderHumanDecisions: falls back to a flat list when no events are supplied', () => {
  // Backwards compatibility: callers that only have records still get readable output.
  // A record that carries a turn still uses the turn heading — that is strictly better than a seq
  // heading, so the fallback only differs in that it cannot add Did/Outcome.
  const records = [{ seq: 5, turn: null, text: 'hello', decision: false, chars: 5 }]
  const out = renderHumanDecisions(records, { maxChars: 32000 })
  assert.match(out, /hello/)
  assert.match(out, /### seq 5/)
  assert.doesNotMatch(out, /\*\*Did\*\*/)
})

test('renderHumanDecisions: a record with a turn uses the turn heading even without events', () => {
  const records = [{ seq: 5, turn: 2, text: 'hello', decision: false, chars: 5 }]
  const out = renderHumanDecisions(records, { maxChars: 32000 })
  assert.match(out, /### Turn 2/)
})

test('renderHumanDecisions: decision-bearing turns are kept first when the cap bites', () => {
  const events = [
    turnStart(1, 1),
    human(2, '這是一個很長的普通訊息 ' + 'x'.repeat(400)),
    turnStart(3, 2),
    human(4, '必須改成 B，不要 A'),
  ]
  const records = extractHumanDecisions(events, { start: 1, end: 4 })
  const out = renderHumanDecisions(records, { maxChars: 200, events })
  assert.match(out, /必須改成 B/)
})

test('renderHumanDecisions: says how many turns were dropped by the cap', () => {
  const events = []
  for (let t = 1; t <= 20; t++) {
    events.push(turnStart(t * 10, t), human(t * 10 + 1, `message ${t} ` + 'y'.repeat(200)))
  }
  const records = extractHumanDecisions(events, { start: 1, end: 300 })
  const out = renderHumanDecisions(records, { maxChars: 500, events })
  assert.match(out, /omitted by the size cap/)
})

test('renderHumanDecisions: empty records render an empty string', () => {
  assert.equal(renderHumanDecisions([], { maxChars: 32000 }), '')
})

test('renderHumanDecisions: a turn with no tool calls omits the Did line', () => {
  const events = [turnStart(1, 1), human(2, 'just talking'), assistant(3, 'ok')]
  const records = extractHumanDecisions(events, { start: 1, end: 3 })
  const out = renderHumanDecisions(records, { maxChars: 32000, events })
  assert.doesNotMatch(out, /\*\*Did\*\*/)
})

test('renderHumanDecisions: multiple human messages in one turn all appear', () => {
  // Measured 100% one-per-turn, but the renderer must not silently drop a second one.
  const events = [turnStart(1, 1), human(2, 'first'), human(3, 'second'), assistant(4, 'ok')]
  const records = extractHumanDecisions(events, { start: 1, end: 4 })
  const out = renderHumanDecisions(records, { maxChars: 32000, events })
  assert.match(out, /first/)
  assert.match(out, /second/)
})
