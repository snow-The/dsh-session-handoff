/**
 * keep-first.test.mjs —— `keepFirst` 的規格。
 *
 * 背景：arXiv 2605.18854 的 condenser 有四個參數，其中 `keep_first`
 * （初始事件永遠保留）我們的 ACP 沒有。實測（`_p0/measure-keep-first.mjs`）：
 * 9 個有 compaction 的 session，**第一則真人訊息 100% 被摺掉**。
 *
 * 原因：`hostFoldRange` 從 `nodes[1]` 開始——跳過 node 0（系統提示）之後
 * 立刻開始摺，而第一則真人訊息通常就在 node 1 或 node 2。
 *
 * 判準：`keepFirst` 給定時，折疊範圍的起點必須在「第一則真人訊息」之後。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostFoldRange, firstHumanSeq } from '../lib/index.js'

// 模擬 surface：node 0 是系統提示，node 1 是第一則真人訊息
const surface = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('keepFirst: 沒有給時，從 nodes[1] 開始（現行行為）', () => {
  const r = hostFoldRange(surface(10), 2)
  assert.deepEqual(r, { start: 2, end: 'auto' })
})

test('keepFirst: 給定時，起點必須在第一則真人訊息之後', () => {
  const r = hostFoldRange(surface(10), 2, { keepFirst: 2 })
  assert.equal(r.start, 3, '第一則真人訊息是 seq 2，起點必須是 3')
})

test('keepFirst: 第一則真人訊息在 node 1 時，起點是 2', () => {
  const r = hostFoldRange(surface(10), 2, { keepFirst: 1 })
  assert.equal(r.start, 2)
})

test('keepFirst: 第一則真人訊息在很後面時，起點跟著後移', () => {
  const r = hostFoldRange(surface(20), 2, { keepFirst: 7 })
  assert.equal(r.start, 8)
})

test('keepFirst: 起點超過可折疊範圍時回 null（不該硬折）', () => {
  // 10 個 node，preserveRecent 2 → 最後可折到 index 7（seq 8）
  // keepFirst 8 → 起點 9，但 9 > 8，沒有東西可折
  const r = hostFoldRange(surface(10), 2, { keepFirst: 8 })
  assert.equal(r, null)
})

test('keepFirst: 0 或負數視為沒有保護', () => {
  assert.deepEqual(hostFoldRange(surface(10), 2, { keepFirst: 0 }), { start: 2, end: 'auto' })
  assert.deepEqual(hostFoldRange(surface(10), 2, { keepFirst: -1 }), { start: 2, end: 'auto' })
})

test('keepFirst: 非數字視為沒有保護', () => {
  assert.deepEqual(hostFoldRange(surface(10), 2, { keepFirst: null }), { start: 2, end: 'auto' })
  assert.deepEqual(hostFoldRange(surface(10), 2, { keepFirst: 'x' }), { start: 2, end: 'auto' })
})

test('keepFirst: 節點太少時仍然回 null', () => {
  assert.equal(hostFoldRange(surface(4), 2, { keepFirst: 1 }), null)
})

// firstHumanSeq：從 surface 節點找出第一則真人訊息
test('firstHumanSeq: 找到 source.kind === "user" 的第一個節點', () => {
  const nodes = [
    { seq: 1, type: 'system/message' },
    { seq: 2, type: 'user/message', source: { kind: 'runtime-context' } },
    { seq: 3, type: 'user/message', source: { kind: 'user' } },
    { seq: 4, type: 'user/message', source: { kind: 'user' } },
  ]
  assert.equal(firstHumanSeq(nodes), 3)
})

test('firstHumanSeq: 沒有真人訊息時回 null', () => {
  const nodes = [
    { seq: 1, type: 'system/message' },
    { seq: 2, type: 'user/message', source: { kind: 'runtime-context' } },
  ]
  assert.equal(firstHumanSeq(nodes), null)
})

test('firstHumanSeq: 空陣列或非陣列回 null', () => {
  assert.equal(firstHumanSeq([]), null)
  assert.equal(firstHumanSeq(null), null)
  assert.equal(firstHumanSeq(undefined), null)
})
