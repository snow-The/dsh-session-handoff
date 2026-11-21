/**
 * snap-end-down.test.mjs —— `snapEndDown` 的規格。
 *
 * 背景：它用 `nodes.indexOf(Number(endSeq))` 找節點，但 `nodes` 裝的是**物件**，
 * `indexOf` 比對物件參考，所以永遠回 -1 → `endIdx < 0` → **永遠回 null**。
 *
 * 這是折疊失敗時唯一的退路：當請求的 end 會切開一個 step，`runCompaction` 會呼叫
 * `snapEndDown` 找「往前最近的平衡邊界」。它回 null 就代表那次折疊直接失敗。
 *
 * 2026-11-21 實測：`lib/index.js` 有 9 處同樣的缺陷（已修），`lib/pairing.js` 有 2 處。
 *
 * ⚠ 事件形狀（`pairingEffect` 讀的）：
 *   V4: `data.message.role === 'tool'` + `data.message.toolCallId` → closes
 *   V3: `data.message.content[] = { type:'tool-call', id }` → opens
 *       `data.message.content[] = { type:'tool-result', toolCallId }` → closes
 * 第一版測試用 `data.callId`，那不是它讀的欄位——測試抓到了我的誤解。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapEndDown, balancedCutsAfter, pairingEffect } from '../lib/pairing.js'

/** 造一個「開啟 tool call」的事件。 */
function openCall(seq, callId) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: callId }] } } }
}

/** 造一個「關閉 tool call」的事件（V4 形狀）。 */
function closeCall(seq, callId) {
  return { seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId } } }
}

/** 造一個普通事件（不開不關）。 */
function plain(seq) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }
}

function toMap(events) {
  const m = new Map()
  for (const e of events) m.set(e.seq, e)
  return m
}

test('pairingEffect: 認得 V3 的 tool-call 區塊', () => {
  const { opens, closes } = pairingEffect(openCall(1, 'c1'))
  assert.deepEqual(opens, ['c1'])
  assert.deepEqual(closes, [])
})

test('pairingEffect: 認得 V4 的 role:tool 訊息', () => {
  const { opens, closes } = pairingEffect(closeCall(2, 'c1'))
  assert.deepEqual(opens, [])
  assert.deepEqual(closes, ['c1'])
})

test('snapEndDown: 節點是物件時也要找到（indexOf 比對物件會失效）', () => {
  const nodes = [1, 2, 3, 4, 5].map((seq) => ({ seq, type: 'assistant/message' }))
  const events = toMap([plain(1), plain(2), plain(3), plain(4), plain(5)])
  const r = snapEndDown({ nodes, eventBySeq: events, startSeq: 1, endSeq: 5 })
  assert.notEqual(r, null, '全部平衡時應該找得到，不能回 null')
  assert.equal(r, 5, '最近的平衡邊界就是 endSeq 本身')
})

test('snapEndDown: 往前找最近的平衡邊界', () => {
  const nodes = [1, 2, 3, 4, 5].map((seq) => ({ seq, type: 'assistant/message' }))
  // seq 3 開 call，seq 4 關
  const events = toMap([plain(1), plain(2), openCall(3, 'c1'), closeCall(4, 'c1'), plain(5)])
  // 在 seq 3 之後切會留下未回應的 call，所以平衡邊界是 seq 2
  const r = snapEndDown({ nodes, eventBySeq: events, startSeq: 1, endSeq: 3 })
  assert.equal(r, 2, 'seq 3 之後不平衡，要往前退到 seq 2')
})

test('snapEndDown: 找不到 start 時回 null', () => {
  const nodes = [1, 2, 3].map((seq) => ({ seq, type: 'assistant/message' }))
  const r = snapEndDown({ nodes, eventBySeq: new Map(), startSeq: 99, endSeq: 3 })
  assert.equal(r, null)
})

test('snapEndDown: 找不到 end 時回 null', () => {
  const nodes = [1, 2, 3].map((seq) => ({ seq, type: 'assistant/message' }))
  const r = snapEndDown({ nodes, eventBySeq: new Map(), startSeq: 1, endSeq: 99 })
  assert.equal(r, null)
})

test('snapEndDown: end 在 start 之前時回 null', () => {
  const nodes = [1, 2, 3].map((seq) => ({ seq, type: 'assistant/message' }))
  const r = snapEndDown({ nodes, eventBySeq: new Map(), startSeq: 3, endSeq: 1 })
  assert.equal(r, null)
})

test('snapEndDown: 純 seq 陣列也能用（測試友善）', () => {
  const nodes = [1, 2, 3, 4, 5]
  const r = snapEndDown({ nodes, eventBySeq: new Map(), startSeq: 1, endSeq: 5 })
  assert.equal(r, 5, '純 seq 陣列也該找得到')
})

test('snapEndDown: 空節點陣列回 null', () => {
  assert.equal(snapEndDown({ nodes: [], eventBySeq: new Map(), startSeq: 1, endSeq: 2 }), null)
})

test('snapEndDown: 沒有參數時不炸', () => {
  assert.equal(snapEndDown(), null)
})

test('balancedCutsAfter: 每個節點之後都是平衡的（沒有 tool call）', () => {
  const nodes = [1, 2, 3].map((seq) => ({ seq, type: 'assistant/message' }))
  const cuts = balancedCutsAfter(nodes, new Map())
  assert.deepEqual([...cuts].sort((a, b) => a - b), [0, 1, 2])
})

test('balancedCutsAfter: 未關閉的 tool call 之後不是平衡的', () => {
  const nodes = [1, 2, 3].map((seq) => ({ seq, type: 'assistant/message' }))
  const events = toMap([plain(1), openCall(2, 'c1'), plain(3)])
  const cuts = balancedCutsAfter(nodes, events)
  // seq 2 開了 call 沒關，所以 index 1 之後不平衡
  assert.ok(!cuts.has(1), 'index 1 之後有未回應的 call')
  assert.ok(cuts.has(0), 'index 0 之後是平衡的')
})
