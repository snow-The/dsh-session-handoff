/**
 * fold-guard-without-meter.test.mjs —— 沒有 tokenMeter 時，折疊保護不能消失。
 *
 * 背景：`runCompaction` 的 `minTokens` 與 `assertFoldWorthIt` 兩個保護原本都寫在
 * `if (meter != null) { ... }` 裡面。**沒有 tokenMeter 服務時，兩個保護全部跳過**，
 * 於是 10 token 的折疊也會被允許——付一次全前綴 miss 去省幾乎零。
 *
 * 這支驗證退路：沒有 meter 時用「節點數」當粗略判準，至少 2 個節點才准折。
 *
 * 注意：`runCompaction` 是閉包內的函式，無法直接呼叫。這支驗證的是
 * **同樣的判斷邏輯**（用 nodeIndex 算節點數），確保退路本身正確。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 複製 lib/index.js 的 nodeIndex（同樣的語義），驗證退路算得對。
function nodeIndex(nodes, seq) {
  if (!Array.isArray(nodes)) return -1
  const want = typeof seq === 'number' ? seq : seq?.seq
  if (want == null) return -1
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const have = typeof n === 'number' ? n : n?.seq
    if (have === want) return i
  }
  return -1
}

/** 複製 runCompaction 的退路判斷。 */
function nodeCountInRange(nodes, start, end) {
  const a = nodeIndex(nodes, start)
  const b = nodeIndex(nodes, end)
  return a >= 0 && b >= a ? b - a + 1 : 0
}

const surface = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, type: 'assistant/message' }))

test('退路：單一節點的範圍被算成 1（該拒絕）', () => {
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 5, 5), 1)
})

test('退路：兩個節點的範圍被算成 2（該允許）', () => {
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 5, 6), 2)
})

test('退路：跨多節點算得對', () => {
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 2, 8), 7)
})

test('退路：start 找不到時回 0（該拒絕）', () => {
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 99, 5), 0)
})

test('退路：end 在 start 之前時回 0（該拒絕）', () => {
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 8, 2), 0)
})

test('退路：純 seq 陣列也算得對', () => {
  const nodes = [1, 2, 3, 4, 5]
  assert.equal(nodeCountInRange(nodes, 2, 4), 3)
})

test('退路：空陣列回 0', () => {
  assert.equal(nodeCountInRange([], 1, 2), 0)
})

test('退路：非陣列回 0', () => {
  assert.equal(nodeCountInRange(null, 1, 2), 0)
})

test('退路：節點是物件時也算得對（這是原本的缺陷形狀）', () => {
  // 若用 nodes.indexOf(seq)，這裡會回 0（永遠找不到），於是「節點太少」被誤判成
  // 「範圍無效」——兩種錯誤都會拒絕合法折疊。
  const nodes = surface(10)
  assert.equal(nodeCountInRange(nodes, 3, 7), 5, '物件陣列必須算得對')
})
