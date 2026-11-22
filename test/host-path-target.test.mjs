/**
 * host-path-target.test.mjs —— host 觸發的摺疊必須真的套用 compressTargetRatio。
 *
 * 背景（兩個獨立的缺陷，同一個症狀）：
 *
 *   1. `hostFoldRange` 回 `{ start, end: 'auto' }` —— end 是**字串**。
 *      `foldEndForTarget` 用 `nodes.findIndex((n) => seqOf(n) === end)` 找它，
 *      數字比字串永遠不相等 → -1 → 回 `{ end: null, skip: false }`。
 *      呼叫者把 null 讀成「算不出來，保留自己的範圍」，foldEnd 保持 'auto'，
 *      由 `autoBalancedEnd` 決定 —— 也就是摺到最大。
 *
 *      `_p0/probe-host-path-target.mjs`：37 個 host 範圍，**0 個**算得出目標。
 *
 *   2. 就算 end 解析對了，`need` 的算法也錯：
 *        need = surfaceTotal - target
 *      但 target 是「視窗的 35%」，而視窗比對的對象是 `totalTokens`
 *      （含工具 schema、system prompt、回應保留），不是 `surfaceTotal`（只有訊息節點）。
 *
 *      `_p0/probe-skip-vs-trigger.mjs`：一個 81.8% 視窗的 session（818,090 tokens）
 *      表面只有 34.4%（343,816）。舊算法得到 `need = 343,816 - 350,000 < 0` → skip，
 *      於是**一個超過軟線 16.8 個百分點的 session 被告知「已在目標以下」而不摺**。
 *
 * 這兩個缺陷都不會拋錯，只會讓摺疊「安靜地不發生」—— 所以需要測試釘住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldEndForTarget } from '../lib/index.js';

/** 造一個 meter：節點價格固定，但 totalTokens 可以與節點總和不同。 */
function meter(nodes, { totalTokens, surfaceTokens } = {}) {
  const sum = nodes.reduce((a, n) => a + n.tokens, 0);
  return {
    measure: () => ({
      totalTokens: totalTokens ?? sum,
      surfaceTokens: surfaceTokens ?? sum,
      nodes,
    }),
  };
}

function session(seqs) {
  return { surface: { nodes: seqs } };
}

test("foldEndForTarget 認得 end: 'auto'（不是把它當成一個找不到的 seq）", () => {
  // 20 個節點 × 10k = 200k 表面；視窗 1M，目標 0.35 → 350k。
  // totalTokens 也給 200k（小於目標）→ 應該 skip，但**必須是「算得出來才 skip」**。
  // 這裡要驗的是：'auto' 不再讓函式回 { end: null, skip: false }（算不出來）。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  const nodes = seqs.map((seq) => ({ seq, tokens: 10_000 }));
  const r = foldEndForTarget(meter(nodes), session(seqs), { compressTargetRatio: 0.35, preserveRecent: 2 }, 2, 'auto', 1_000_000);
  assert.equal(r.skip, true, "'auto' 必須被解析，然後才判斷是否已達標 —— 不是回「算不出來」");
  assert.equal(r.end, null);
});

test("end: 'auto' 解析成「保留尾巴之前的最後一個節點」，與 autoBalancedEnd 同一個界", () => {
  // 20 個節點，preserveRecent 2 → lastAllowed = 20 - 1 - 2 = 17（index）。
  // 表面 20 × 100k = 2M，視窗 2M，目標 0.35 → 700k，need = 1.3M = 13 個節點。
  // 從 index 1 起算，第 13 個是 index 13（seq 14）。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  const nodes = seqs.map((seq) => ({ seq, tokens: 100_000 }));
  const r = foldEndForTarget(meter(nodes), session(seqs), { compressTargetRatio: 0.35, preserveRecent: 2 }, 2, 'auto', 2_000_000);
  assert.equal(r.skip, false);
  assert.equal(r.end, 14, `應該停在 seq 14，實際 ${r.end}`);
});

test('need 用 totalTokens 算，不是 surfaceTotal（兩個都是 token，但不是同一個量）', () => {
  // 這是 probe-skip-vs-trigger 量到的真實形狀：
  //   totalTokens 818,090（81.8% 視窗）   surfaceTotal 343,816（34.4%）
  //   target 350,000
  // 舊算法：need = 343,816 - 350,000 < 0 → skip（該摺卻不摺）
  // 新算法：need = 818,090 - 350,000 = 468,090 → 摺得下去
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  // 節點總和 343,816，平均分配
  const per = Math.floor(343_816 / 20);
  const nodes = seqs.map((seq) => ({ seq, tokens: per }));
  const r = foldEndForTarget(
    meter(nodes, { totalTokens: 818_090 }),
    session(seqs),
    { compressTargetRatio: 0.35, preserveRecent: 2 },
    2,
    'auto',
    1_000_000,
  );
  assert.equal(r.skip, false, 'totalTokens 遠高於目標時不能 skip —— 那正是「該摺卻不摺」');
  assert.ok(r.end != null, '而且必須算得出一個 end');
});

test('真的在目標以下時才 skip（totalTokens 與 surfaceTotal 都低）', () => {
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  const nodes = seqs.map((seq) => ({ seq, tokens: 5_000 }));   // 100k 表面
  const r = foldEndForTarget(
    meter(nodes, { totalTokens: 120_000 }),
    session(seqs),
    { compressTargetRatio: 0.35, preserveRecent: 2 },
    2,
    'auto',
    1_000_000,
  );
  assert.equal(r.skip, true, '120k 對 350k 目標 → 真的已達標');
});

test('沒有 totalTokens 時退回 surfaceTotal（相容路徑，不是死碼）', () => {
  // 舊版 meter 沒有 totalTokens。那時 need 只能用 surfaceTotal 算 —— 不完美，但比 skip 好。
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  const nodes = seqs.map((seq) => ({ seq, tokens: 100_000 }));   // 2M 表面
  const m = { measure: () => ({ surfaceTokens: 2_000_000, nodes }) };   // 沒有 totalTokens
  const r = foldEndForTarget(m, session(seqs), { compressTargetRatio: 0.35, preserveRecent: 2 }, 2, 'auto', 2_000_000);
  assert.equal(r.skip, false);
  assert.equal(r.end, 14, `退回 surfaceTotal 也要算對，實際 ${r.end}`);
});

test('數字 end 仍然照舊運作（不是只有 auto 被修）', () => {
  const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
  const nodes = seqs.map((seq) => ({ seq, tokens: 10_000 }));
  const r = foldEndForTarget(meter(nodes), session(seqs), { compressTargetRatio: 0.35 }, 2, 20, 200_000);
  assert.equal(r.skip, false);
  assert.equal(r.end, 14);
});
