/**
 * fold-end-target.test.mjs —— `foldEndForTarget` 的規格。
 *
 * 背景（量測推翻了原本的修法）：
 *   `_p0/probe-deepfold-noop.mjs` 重放 session 14cc3134 的 9 次折疊，
 *   `deepFoldStart` 能往前延伸的是 **0 / 9**——範圍起點本來就已經是最前面的可折節點。
 *   `_p0/measure-retain-surface.mjs`（用官方 `estimateMessage` 定價，不靠 provider usage）
 *   量到摺後表面是視窗的 **1.1%**，而 `compressTargetRatio` 是 **0.35**。
 *
 * 所以目標只能靠**摺少一點**達成：保留更多近期尾巴。這個檔案釘住那個算術。
 *
 * 三個必須紅的性質：
 *   1. 目標是「摺完落在 0.35」，不是「摺越多越好」——摺過頭要被抓到
 *   2. 目標算不出來時回 null（呼叫者保留自己的範圍），不是亂摺
 *   3. 平衡邊界只會往下 snap，不會往上（往上等於摺超過呼叫者要求的量）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldEndForTarget } from '../lib/index.js'

/** 造一個 meter：每個節點固定 tokens。 */
function fakeMeter(nodeTokens) {
  return { measure: () => ({ nodes: nodeTokens.map(([seq, tokens]) => ({ seq, tokens })) }) }
}

/** 造一個 session：surface.nodes 是物件陣列（真實形狀）。 */
function fakeSession(seqs) {
  return { surface: { nodes: seqs.map((seq) => ({ seq, type: 'assistant/message' })) } }
}

/** 回傳值可能是節點物件或裸 seq，統一取 seq。 */
const seqOf = (n) => (typeof n === 'number' ? n : n?.seq)

test('foldEndForTarget: 摺到目標就停，不是摺到 end', () => {
  // 20 個節點 × 10k = 200k 表面；視窗 200k，目標 0.35 → 70k
  // 需要移除 130k = 13 個節點。從 index 1 起算，第 13 個是 index 13。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)

  const end = foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 2, 20, 200_000)

  assert.ok(end != null, '應該算得出一個 end')
  assert.ok(seqOf(end) < 20, `不能摺到呼叫者給的 end（20），實際 ${seqOf(end)}`)
  // 1..13 共 13 個節點 = 130k，剛好落在 70k
  assert.equal(seqOf(end), 14, `應該停在 index 13（seq 14），實際 ${seqOf(end)}`)
})

test('foldEndForTarget: 目標越低，摺得越多（單調性）', () => {
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)

  const shallow = foldEndForTarget(meter, session, { compressTargetRatio: 0.6 }, 2, 20, 200_000)
  const deep = foldEndForTarget(meter, session, { compressTargetRatio: 0.2 }, 2, 20, 200_000)

  assert.ok(seqOf(deep) > seqOf(shallow), `目標越低要摺越多：0.2 → ${seqOf(deep)}，0.6 → ${seqOf(shallow)}`)
})

test('foldEndForTarget: 表面已經在目標以下時回 null（不摺）', () => {
  // 5 個節點 × 10k = 50k，視窗 200k，目標 0.35 = 70k → 已經在目標以下
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)

  const end = foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 2, 5, 200_000)
  assert.equal(end, null, '已經達標就不該摺')
})

test('foldEndForTarget: 第一個節點就超過 need 時只摺那一個（不摺過頭，也不退回最大摺疊）', () => {
  // 10 個節點 × 40k = 400k，視窗 200k，目標 0.35 = 70k → need 330k
  // 每個節點 40k，摺 8 個才到 320k，第 9 個會超過 need。
  // 關鍵：不能回 null。回 null 會讓呼叫者退回自己的（最大）範圍——那正是要修的 bug。
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 40_000]))
  const session = fakeSession(seqs)

  const end = foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 2, 10, 200_000)
  assert.ok(end != null, '不能回 null（呼叫者會退回最大摺疊）')
  assert.ok(seqOf(end) < 10, `不能摺到呼叫者給的 end（10），實際 ${seqOf(end)}`)
})

test('foldEndForTarget: 單一節點就超過 need 時只摺一個，不摺到 end', () => {
  // 10 個節點 × 400k = 4M 表面；視窗 4M，目標 0.95 → 3.8M → need 200k
  // 第一個節點就 400k > 200k → 只摺那一個（index 1, seq 2），不是摺到 end。
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 400_000]))
  const session = fakeSession(seqs)

  const end = foldEndForTarget(meter, session, { compressTargetRatio: 0.95 }, 2, 10, 4_000_000)
  assert.equal(seqOf(end), 2, `應該只摺第一個節點（seq 2），實際 ${seqOf(end)}`)
})

test('foldEndForTarget: 沒有 meter 時回 null（不亂摺）', () => {
  const session = fakeSession([1, 2, 3, 4, 5])
  assert.equal(foldEndForTarget(null, session, { compressTargetRatio: 0.35 }, 2, 5, 100_000), null)
})

test('foldEndForTarget: 沒有 session 時回 null', () => {
  const meter = fakeMeter([[1, 10_000]])
  assert.equal(foldEndForTarget(meter, null, { compressTargetRatio: 0.35 }, 2, 5, 100_000), null)
})

test('foldEndForTarget: start/end 不在表面上時回 null', () => {
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)
  assert.equal(foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 99, 5, 100_000), null)
  assert.equal(foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 2, 99, 100_000), null)
})

test('foldEndForTarget: end 在 start 之前時回 null', () => {
  const seqs = [1, 2, 3, 4, 5]
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)
  assert.equal(foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 4, 2, 100_000), null)
})

test('foldEndForTarget: 平衡邊界只往下 snap，不往上', () => {
  // 20 個節點，每個 10k。目標 0.35 → 停在 index 13（seq 14）。
  // 造一個「seq 14 會切開工具配對」的表面：seq 13 開了一個 call，seq 14 才關。
  // 平衡切點在 index 12（seq 13）之前，所以 snap 後必須 <= 14。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)

  const eventBySeq = new Map()
  eventBySeq.set(13, { seq: 13, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] } } })
  eventBySeq.set(14, { seq: 14, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [] } } })

  const end = foldEndForTarget(meter, session, { compressTargetRatio: 0.35 }, 2, 20, 200_000, { eventBySeq })
  assert.ok(end != null, '應該 snap 到一個平衡邊界')
  assert.ok(seqOf(end) <= 14, `snap 只能往下：實際 ${seqOf(end)} > 14`)
})

test('foldEndForTarget: 預設 compressTargetRatio 是 0.35（漂移會紅）', () => {
  // 20 個節點 × 10k = 200k，視窗 200k。0.35 → 70k → 摺 13 個節點。
  // 若預設值漂移（例如變成 0.5），會摺 10 個節點 → seq 12，這個斷言就會紅。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1)
  const meter = fakeMeter(seqs.map((s) => [s, 10_000]))
  const session = fakeSession(seqs)

  const end = foldEndForTarget(meter, session, {}, 2, 20, 200_000)
  assert.equal(seqOf(end), 14, `預設目標應該是 0.35（停在 seq 14），實際 ${seqOf(end)}`)
})
