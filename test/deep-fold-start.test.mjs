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

/**
 * `end: 'auto'` 必須被解析，不能讓函式在第一行就返回。
 *
 * `hostFoldRange` 回 `{ start, end: 'auto' }`，而 `deepFoldStart` 原本用
 * `nodes.findIndex((n) => seqOf(n) === end)` 找它 —— 數字比字串永遠不相等 → -1 →
 * `if (si <= 0 || ei < 0) return start`。**延伸迴圈從未執行過。**
 *
 * 實測（`_p0/probe-deepfold-cause.mjs`）：37 個 host 範圍，37 個在第一道門就返回。
 *
 * 這很重要，因為「deep 是 no-op」原本的解釋是「hostFoldRange 已經從第一個可折節點開始，
 * 沒得延伸」。那可能也對，但它從來不是原因 —— 函式根本沒走到那裡。
 * 兩個原因要分開，因為修法不同：一個是接錯線，一個是該刪掉這個函式。
 */
test("deepFoldStart: end: 'auto' 會被解析，不是在第一道門就返回", () => {
  // 10 個節點 × 10k = 100k，視窗 100k，目標 0.35 → 35k。
  // start = seq 8（index 7），'auto' 解析成 index 10-1-2 = 7 → 與 start 同一個 index。
  // 這個 case 的 end 太靠近 start，所以延伸不了 —— 但它必須是「算完之後發現不用延伸」，
  // 不是「ei < 0 直接 return」。用一個 end 較遠的表面才分得出兩者。
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 100_000)
  const session = fakeSession(seqs)

  // start = seq 6（index 5），'auto' → index 7（seq 8）。
  // fold = seq 6..8 = 30k，total - fold = 70k > 35k → 必須往前延伸。
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35, preserveRecent: 2 }, 6, 'auto', 100_000)
  assert.ok(seqOf(start) < 6, `'auto' 要被解析並往前延伸，實際 ${seqOf(start)}`)
})

test("deepFoldStart: 'auto' 的界與 autoBalancedEnd 一致（preserveRecent）", () => {
  // 若 'auto' 解析成「最後一個節點」而不是「preserveRecent 之前」，延伸會多算兩個節點。
  // 20 個節點 × 10k = 200k，視窗 200k，目標 0.35 → 70k。
  // start = seq 3（index 2）。'auto' → index 20-1-2 = 17（seq 18）。
  // fold = seq 3..18 = 16 × 10k = 160k，total - fold = 40k <= 70k → 已達標，不延伸。
  // 若 'auto' 解析成 index 19（seq 20）：fold = 18 × 10k = 180k，total - fold = 20k，
  // 同樣已達標 —— 這個 case 分不出來。改用一個剛好卡在邊界的。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]), 200_000)
  const session = fakeSession(seqs)

  // start = seq 2（index 1）。'auto' → index 17（seq 18）。
  // fold = seq 2..18 = 17 × 10k = 170k，total - fold = 30k <= 70k → 不延伸，回 seq 2。
  const start = deepFoldStart(meter, session, { compressTargetRatio: 0.35, preserveRecent: 2 }, 2, 'auto', 200_000)
  assert.equal(seqOf(start), 2, `已達標時不延伸，實際 ${seqOf(start)}`)
})
