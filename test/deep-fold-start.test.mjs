/**
 * deep-fold-start.test.mjs —— `deepFoldStart` 的規格。
 *
 * 背景：它用 `nodes.indexOf(start)` 找節點，但 `nodes` 裝的是**物件**，
 * `indexOf` 比對物件參考，所以永遠回 -1 → `si <= 0` → `return start`。
 * **`deep: true` 從未加深任何折疊。**
 *
 * 實測（`_p0/measure-retain.mjs`，當前 session 8 次折疊）：
 *   retainedRatio 中位數 0.174，而 compressTargetRatio 是 0.35
 *
 * 這個檔案裡的 9 處 `nodes.indexOf` 是同一個缺陷（見 `nodeIndex` 的註解）。
 *
 * ⚠ 回傳值是**節點本身**（`nodes[chosen]`），不是 seq。
 * 第一版測試斷言 `start === 2`，實際回 `{ seq: 2, type: ... }`——測試抓到了這個誤解。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deepFoldStart } from '../lib/index.js'

/** 造一個假的 meter：每個節點固定 tokens，總量可算。 */
function fakeMeter(nodeTokens, totalTokens) {
  return {
    measure: () => ({
      totalTokens,
      nodes: nodeTokens.map(([seq, tokens]) => ({ seq, tokens })),
    }),
  }
}

/** 造一個假的 session：surface.nodes 是物件陣列（真實形狀）。 */
function fakeSession(seqs) {
  return { surface: { nodes: seqs.map((seq) => ({ seq, type: 'assistant/message' })) } }
}

/** 回傳值可能是節點物件或裸 seq，統一取 seq。 */
const seqOf = (n) => (typeof n === 'number' ? n : n?.seq)

test('deepFoldStart: 節點是物件時也要找到（indexOf 比對物件會失效）', () => {
  // 10 個節點，每個 10k tokens，總量 100k
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 100_000)
  const session = fakeSession(seqs)

  // 從 seq 8 折到 seq 9，目標 35% = 35k
  // 目前 fold = 20k（seq 8+9），total - fold = 80k > 35k，所以要往前延伸
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 8, 9, 100_000)

  assert.notEqual(seqOf(start), 8, '必須往前延伸，不能原樣回傳 start')
  assert.ok(seqOf(start) < 8, `延伸後的起點應該 < 8，實際 ${seqOf(start)}`)
})

test('deepFoldStart: 已經低於目標時不延伸', () => {
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 100_000)
  const session = fakeSession(seqs)

  // 從 seq 2 折到 seq 9：fold = 80k，total - fold = 20k <= 35k，已達標
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 2, 9, 100_000)
  assert.equal(seqOf(start), 2, '已達標時不該再往前')
})

test('deepFoldStart: 找不到 start 時原樣回傳（不該亂折）', () => {
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 50_000)
  const session = fakeSession(seqs)
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 99, 5, 50_000)
  assert.equal(seqOf(start), 99, '找不到就回原值')
})

test('deepFoldStart: 找不到 end 時原樣回傳', () => {
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 50_000)
  const session = fakeSession(seqs)
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 2, 99, 50_000)
  assert.equal(seqOf(start), 2, 'end 找不到就回原值')
})

test('deepFoldStart: start 在 index 0 時不折（那是系統提示）', () => {
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 50_000)
  const session = fakeSession(seqs)
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 1, 5, 50_000)
  assert.equal(seqOf(start), 1, 'index 0 是系統提示，不能折')
})

test('deepFoldStart: 沒有 meter 時不炸', () => {
  const session = fakeSession([1, 2, 3, 4, 5])
  const start = deepFoldStart(null, session, { compressTargetRatio: 0.35 }, 2, 4, 50_000)
  assert.equal(seqOf(start), 2, '沒有 meter 就回原值')
})

test('deepFoldStart: 沒有 session 時不炸', () => {
  const start = deepFoldStart(fakeMeter([[1, 1000]], 1000), null, { compressTargetRatio: 0.35 }, 2, 4, 1000)
  assert.equal(seqOf(start), 2)
})

test('deepFoldStart: 純 seq 陣列也能用（測試友善）', () => {
  const meter = fakeMeter([[1, 10_000], [2, 10_000], [3, 10_000], [4, 10_000], [5, 10_000]], 50_000)
  const session = { surface: { nodes: [1, 2, 3, 4, 5] } }
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35 }, 4, 5, 50_000)
  assert.ok(seqOf(start) < 4, `純 seq 陣列也該延伸，實際 ${seqOf(start)}`)
})
