/**
 * assert-safe-range.test.mjs —— 折疊範圍的安全檢查。
 *
 * 背景：`assertSafeRange` 原本只檢查「找不到」與「start 在 end 之後」，
 * **沒有檢查 start 是不是 node 0**（系統提示）。
 *
 * 實測（`_p0/measure-fold-failures.mjs`）：5 次 `compaction/end` 帶的錯誤正是
 *   "surface replace: node 0 holds the system prompt and may be rewritten only by a
 *    system/message over exactly that node"
 * 全部來自 2026-08/09。
 *
 * `hostFoldRange` 從 index 1 開始，所以 host-triggered 路徑安全；但 `acp_compress`
 * 吃呼叫端給的 start，沒有任何東西阻止它是 node 0——折疊於是在 core 那裡失敗，
 * 而呼叫端已經公告過了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

// `assertSafeRange` 不是直接 export，是掛在 `__internals` 上（給單元測試用的內部）。
const { assertSafeRange } = __internals

/** 造一個假的 session：node 0 是系統提示，其餘是普通節點。 */
function fakeSession(count = 10) {
  const nodes = []
  for (let i = 0; i < count; i++) {
    nodes.push({ seq: i + 1, type: i === 0 ? 'system/message' : 'assistant/message' })
  }
  return { surface: { nodes } }
}

test('assertSafeRange: start 是 node 0 時必須拒絕', () => {
  const session = fakeSession(10)
  assert.throws(
    () => assertSafeRange(session, 1, 5, { preserveRecent: 2 }),
    /node 0 \(the system prompt\)/,
    'node 0 是系統提示，折疊不能從那裡開始',
  )
})

test('assertSafeRange: start 是 node 1 時允許', () => {
  const session = fakeSession(10)
  assert.doesNotThrow(() => assertSafeRange(session, 2, 5, { preserveRecent: 2 }))
})

test('assertSafeRange: start 找不到時拒絕', () => {
  const session = fakeSession(10)
  assert.throws(() => assertSafeRange(session, 99, 5, { preserveRecent: 2 }), /not on the current surface/)
})

test('assertSafeRange: end 找不到時拒絕', () => {
  const session = fakeSession(10)
  assert.throws(() => assertSafeRange(session, 2, 99, { preserveRecent: 2 }), /not on the current surface/)
})

test('assertSafeRange: start 在 end 之後時拒絕', () => {
  const session = fakeSession(10)
  assert.throws(() => assertSafeRange(session, 5, 2, { preserveRecent: 2 }), /is after end seq/)
})

test('assertSafeRange: end 落在保留尾部時拒絕', () => {
  const session = fakeSession(10)
  // 10 個節點，preserveRecent 2 → lastAllowed = 7（index）
  assert.throws(() => assertSafeRange(session, 2, 9, { preserveRecent: 2 }), /cannot compress the last/)
})

test('assertSafeRange: end 剛好在邊界時允許', () => {
  const session = fakeSession(10)
  // lastAllowed = 7 → seq 8 是 index 7
  assert.doesNotThrow(() => assertSafeRange(session, 2, 8, { preserveRecent: 2 }))
})

test('assertSafeRange: 純 seq 陣列也能用', () => {
  const session = { surface: { nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }
  assert.throws(() => assertSafeRange(session, 1, 5, { preserveRecent: 2 }), /node 0/)
  assert.doesNotThrow(() => assertSafeRange(session, 2, 5, { preserveRecent: 2 }))
})

test('assertSafeRange: 沒有 preserveRecent 時用預設 2 判斷邊界', () => {
  const session = fakeSession(10)
  // 沒有 preserveRecent 時，lastAllowed 用 ?? 2 算，所以 seq 9（index 8）仍被拒
  assert.throws(() => assertSafeRange(session, 2, 9, {}), /cannot compress the last/)
})
