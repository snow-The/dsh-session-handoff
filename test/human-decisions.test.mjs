/**
 * human-decisions.test.mjs —— 真人訊息抽取的規格。
 *
 * 背景：使用者指出「真正的人類訊息和一些決策是得核對保留成更有條理的方法，
 * 因為你直接折疊會遺漏當初的上下文對應關係」。
 *
 * 量測（_p0/measure-decision-loss.mjs，150 個 session、2,944 則被折疊的真人訊息）：
 *   長 + 帶決策語彙的訊息，遺失率 87.1%
 *   根因：官方摘要 prompt 的 8 個槽位沒有「使用者原話」這一格
 *
 * 判準：抽取必須是 deterministic 的（不靠模型），且必須帶 before/after 上下文，
 * 否則原話只是一句話，不知道它是對什麼說的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractHumanDecisions, hasDecisionMarker, DECISION_MARKERS, HUMAN_SOURCE_KINDS, renderHumanDecisions } from '../lib/human-decisions.js'

const human = (seq, text, extra = {}) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { source: { kind: 'user' }, content: text, ...extra },
})
const injected = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { source: { kind: 'runtime-context' }, content: text },
})
const assistant = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }] } },
})
const toolResult = (seq, text) => ({
  type: 'tool/result',
  seq,
  time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }] } },
})

test('只抽 source.kind === "user"，不抽注入的 runtime-context', () => {
  const events = [injected(1, 'ACP: 1/100'), human(2, '你應該用 npx 而不是 pnpm'), injected(3, 'ACP: 2/100')]
  const out = extractHumanDecisions(events, { start: 1, end: 3 })
  assert.equal(out.length, 1)
  assert.equal(out[0].seq, 2)
  assert.match(out[0].text, /npx/)
})

test('範圍外的訊息不抽', () => {
  const events = [human(1, '範圍外'), human(5, '範圍內'), human(9, '範圍外')]
  const out = extractHumanDecisions(events, { start: 4, end: 6 })
  assert.equal(out.length, 1)
  assert.equal(out[0].seq, 5)
})

test('帶 before：記錄範圍內前一個 assistant 與 tool/result 的 seq', () => {
  const events = [assistant(1, '我先看看'), toolResult(2, '檔案內容'), human(3, '不對，應該改 X')]
  const out = extractHumanDecisions(events, { start: 1, end: 3 })
  assert.equal(out.length, 1)
  assert.equal(out[0].before.lastAssistantSeq, 1)
  assert.equal(out[0].before.lastToolSeq, 2)
})

test('帶 after：記錄範圍內後一個 assistant 的 seq', () => {
  const events = [human(1, '改成 X'), assistant(2, '好，改了')]
  const out = extractHumanDecisions(events, { start: 1, end: 2 })
  assert.equal(out[0].after.firstAssistantSeq, 2)
})

test('沒有 before/after 時是 null，不是 undefined', () => {
  const events = [human(1, '只有這句話')]
  const out = extractHumanDecisions(events, { start: 1, end: 1 })
  assert.equal(out[0].before.lastAssistantSeq, null)
  assert.equal(out[0].before.lastToolSeq, null)
  assert.equal(out[0].after.firstAssistantSeq, null)
})

test('保留 turn 與 time', () => {
  // `user/message` does NOT carry a turn field (measured 0 of 352 across 20 sessions), so the turn
  // is derived from the preceding `turn/start`. The old version of this test put `turn: 7` on the
  // message itself, which is a shape production never produces.
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 7 } },
    human(2, 'x'),
  ]
  const out = extractHumanDecisions(events, { start: 1, end: 2 })
  assert.equal(out[0].turn, 7)
  assert.equal(out[0].time, 1002)
})

test('user/message 自己帶的 turn 欄位不被採用（production 從不產生它）', () => {
  const events = [{ ...human(1, 'x'), turn: 7 }]
  const out = extractHumanDecisions(events, { start: 1, end: 1 })
  assert.equal(out[0].turn, null)
})

test('空文字或只有空白的訊息跳過', () => {
  const events = [human(1, ''), human(2, '   \n  '), human(3, '有內容')]
  const out = extractHumanDecisions(events, { start: 1, end: 3 })
  assert.equal(out.length, 1)
  assert.equal(out[0].seq, 3)
})

test('content 是 block 陣列時也能抽', () => {
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '區塊形式' }] } },
  ]
  const out = extractHumanDecisions(events, { start: 1, end: 1 })
  assert.equal(out[0].text, '區塊形式')
})

test('非陣列輸入回空陣列，不拋錯', () => {
  assert.deepEqual(extractHumanDecisions(null, { start: 1, end: 2 }), [])
  assert.deepEqual(extractHumanDecisions([], { start: 1, end: 2 }), [])
})

test('沒有 range 時抽全部', () => {
  const events = [human(1, 'a'), human(5, 'b')]
  const out = extractHumanDecisions(events)
  assert.equal(out.length, 2)
})

// hasDecisionMarker
test('hasDecisionMarker: 認得中文決策語彙', () => {
  assert.equal(hasDecisionMarker('你應該用 npx'), true)
  assert.equal(hasDecisionMarker('不要用 pnpm'), true)
  assert.equal(hasDecisionMarker('必須先量測'), true)
  assert.equal(hasDecisionMarker('改成 X 而不是 Y'), true)
})

test('hasDecisionMarker: 認得英文決策語彙', () => {
  assert.equal(hasDecisionMarker('you should use npx'), true)
  assert.equal(hasDecisionMarker('never use pnpm'), true)
  assert.equal(hasDecisionMarker('use A instead of B'), true)
})

test('hasDecisionMarker: 純確認不算決策', () => {
  assert.equal(hasDecisionMarker('OK'), false)
  assert.equal(hasDecisionMarker('好'), false)
  assert.equal(hasDecisionMarker('繼續'), false)
})

test('hasDecisionMarker: 空字串不算', () => {
  assert.equal(hasDecisionMarker(''), false)
  assert.equal(hasDecisionMarker(null), false)
})

test('DECISION_MARKERS 是匯出的常數，可被外部檢視', () => {
  assert.ok(Array.isArray(DECISION_MARKERS))
  assert.ok(DECISION_MARKERS.length > 0)
  assert.ok(DECISION_MARKERS.includes('應該'))
})

// 整合：抽取結果要能標記哪些帶決策
test('抽取結果帶 decision 旗標', () => {
  const events = [human(1, 'OK'), human(2, '你應該用 npx 而不是 pnpm')]
  const out = extractHumanDecisions(events, { start: 1, end: 2 })
  assert.equal(out[0].decision, false)
  assert.equal(out[1].decision, true)
})

// 跨折疊的保護：我們自己注入的區塊不能被下一次折疊吃掉
const injectedByUs = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { source: { kind: 'acp-human-decisions' }, content: text },
})

test('跨折疊：acp-human-decisions 也算真人訊息，不會被下一次折疊吃掉', () => {
  const events = [injectedByUs(1, '## Human messages in the folded range (verbatim)\n\n- **seq 8** ...')]
  const out = extractHumanDecisions(events, { start: 1, end: 1 })
  assert.equal(out.length, 1, '我們自己注入的區塊必須被再抽一次，否則保護只維持一次折疊')
})

test('跨折疊：重複的內容只保留一次（不累積）', () => {
  const body = '- **seq 8** **[decision]**\n  > 你應該用 npx 而不是 pnpm'
  const events = [human(1, '你應該用 npx 而不是 pnpm'), injectedByUs(2, body)]
  const out = extractHumanDecisions(events, { start: 1, end: 2 })
  // 兩者內容重疊，去重後只留一筆
  assert.equal(out.length, 1, '同一段話不該因為被注入過就變成兩筆')
})

test('跨折疊：不同內容都保留', () => {
  const events = [human(1, '第一句話'), injectedByUs(2, '第二句話')]
  const out = extractHumanDecisions(events, { start: 1, end: 2 })
  assert.equal(out.length, 2)
})

test('HUMAN_SOURCE_KINDS 是匯出的常數', () => {
  assert.ok(Array.isArray(HUMAN_SOURCE_KINDS))
  assert.ok(HUMAN_SOURCE_KINDS.includes('user'))
  assert.ok(HUMAN_SOURCE_KINDS.includes('acp-human-decisions'))
})

// renderHumanDecisions 的選擇策略
//
// 第一版按 seq 順序塞到 maxChars 滿為止。實測（_p0/measure-cap-coverage.mjs，6 個 session、
// 1,934 則真人訊息）：8000 上限只保住 127 / 1,613 = 7.9%，92.1% 被丟掉。
// 上限保護了成本，卻讓保護本身失效。
//
// 現在改成「決策訊息全保 + 其餘按新到舊填」。
const rec = (seq, text, decision = false) => ({
  seq,
  turn: null,
  time: 1000 + seq,
  chars: text.length,
  text,
  decision,
  before: { lastAssistantSeq: null, lastToolSeq: null },
  after: { firstAssistantSeq: null },
})

test('render: 決策訊息優先於非決策訊息', () => {
  const records = [rec(1, '普通訊息一'), rec(2, '你應該用 npx', true), rec(3, '普通訊息二')]
  const out = renderHumanDecisions(records, { maxChars: 0 })
  const decisionAt = out.indexOf('你應該用 npx')
  const plainAt = out.indexOf('普通訊息一')
  assert.ok(decisionAt >= 0 && plainAt >= 0)
  assert.ok(decisionAt < plainAt, '決策訊息必須排在前面')
})

test('render: 非決策訊息按「新到舊」排，不是按 seq', () => {
  const records = [rec(1, '最舊的'), rec(2, '中間的'), rec(3, '最新的')]
  const out = renderHumanDecisions(records, { maxChars: 0 })
  const newest = out.indexOf('最新的')
  const oldest = out.indexOf('最舊的')
  assert.ok(newest >= 0 && oldest >= 0)
  assert.ok(newest < oldest, '預算該先給最新的訊息')
})

test('render: 上限吃緊時，決策訊息仍全部保留', () => {
  // 10 則決策訊息 + 100 則普通訊息，上限只夠放決策的
  const records = []
  for (let i = 1; i <= 10; i++) records.push(rec(i, `決策 ${i}：應該這樣做`, true))
  for (let i = 11; i <= 110; i++) records.push(rec(i, `普通訊息 ${i}`))
  const out = renderHumanDecisions(records, { maxChars: 2000 })
  for (let i = 1; i <= 10; i++) {
    assert.ok(out.includes(`決策 ${i}`), `決策 ${i} 必須在區塊裡`)
  }
})

test('render: 上限吃緊時，保留的是最新的普通訊息', () => {
  const records = []
  for (let i = 1; i <= 200; i++) records.push(rec(i, `訊息 ${i} ${'x'.repeat(50)}`))
  const out = renderHumanDecisions(records, { maxChars: 3000 })
  assert.ok(out.includes('訊息 200'), '最新的必須保留')
  assert.ok(!out.includes('訊息 1 '), '最舊的該被丟掉')
})

test('render: 有東西被丟時，明講丟了幾則', () => {
  const records = []
  for (let i = 1; i <= 200; i++) records.push(rec(i, `訊息 ${i} ${'x'.repeat(50)}`))
  const out = renderHumanDecisions(records, { maxChars: 2000 })
  // The unit is now a TURN, not a message: every turn holds exactly one human message (264/264
  // measured), so "turn(s)" is the accurate noun. The intent of this test is unchanged — a silent
  // truncation must never read as "this is everything".
  assert.match(out, /more turn\(s\) omitted by the size cap/)
  assert.match(out, /remain in the session log/)
})

test('render: 被丟的決策訊息要單獨報數', () => {
  // 決策訊息多到放不下
  const records = []
  for (let i = 1; i <= 100; i++) records.push(rec(i, `決策 ${i} ${'y'.repeat(100)}`, true))
  const out = renderHumanDecisions(records, { maxChars: 2000 })
  assert.match(out, /decision-bearing/, '必須說明有多少決策訊息被丟')
})

test('render: maxChars 0 表示無上限', () => {
  const records = []
  for (let i = 1; i <= 100; i++) records.push(rec(i, `訊息 ${i} ${'x'.repeat(100)}`))
  const out = renderHumanDecisions(records, { maxChars: 0 })
  assert.ok(!out.includes('omitted'), '無上限時不該有省略說明')
  assert.ok(out.includes('訊息 1 '), '無上限時最舊的也在')
})

test('render: 空陣列回空字串', () => {
  assert.equal(renderHumanDecisions([], { maxChars: 8000 }), '')
  assert.equal(renderHumanDecisions(null), '')
})
