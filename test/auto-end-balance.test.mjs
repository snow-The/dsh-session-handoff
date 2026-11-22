/**
 * auto-end-balance.test.mjs —— `end: 'auto'` 必須挑一個核心會接受的切點。
 *
 * 背景（量測推翻了註解裡的斷言）：
 *   `autoBalancedEnd` 原本挑「價格 <= 150 的節點」，註解卻寫著那是
 *   「the same rule `end: 'auto'` uses (a tool result or usage node closes a step)」。
 *   **價格與配對無關**：便宜的節點可以落在一個還沒關閉的 step 中間。
 *
 *   `_p0/probe-auto-end-balance.mjs` 在 37 個真實表面上量到：
 *   價格規則挑的 end 有 **6 個（16.2%）被核心拒絕**。
 *   那正是 `measure-fold-failures` 數到的 "not a balanced boundary" 的來源。
 *
 * 這個檔案釘住三件事：
 *   1. 有平衡切點時，挑的是平衡切點（不是便宜的節點）
 *   2. 便宜的節點在未關閉的 step 中間時，**不會**被挑中
 *   3. 沒有任何平衡切點時回 NaN（讓呼叫者大聲失敗，不是猜一個 end）
 *
 * ⚠ `autoBalancedEnd` 是 `registerAcpTools` 內的閉包，沒有 export。
 * 所以這裡用「讀原始碼 + 驅動 `balancedCutsAfter`」兩段驗證，而不是直接呼叫它。
 * 直接呼叫需要整個 ctx，那會讓測試變成整合測試，而這裡要釘的是規則本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balancedCutsAfter } from '../lib/pairing.js';

const SOURCE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

/** 取出 `autoBalancedEnd` 的函式本體（從宣告到下一個同縮排的 `}`）。 */
function autoEndBody() {
  const at = SOURCE.indexOf('function autoBalancedEnd(');
  assert.ok(at > 0, 'autoBalancedEnd must exist');
  const end = SOURCE.indexOf('\n  }', at);
  assert.ok(end > at, 'autoBalancedEnd body must be findable');
  return SOURCE.slice(at, end);
}

test('autoBalancedEnd 用配對平衡，不是價格', () => {
  const body = autoEndBody();
  assert.ok(
    /balancedCutsAfter\(/.test(body),
    'the auto end must be derived from the pairing rule, not from a price threshold',
  );
  assert.ok(
    !/<= 150/.test(body),
    'the price threshold (<= 150) must be gone: price has nothing to do with tool-call/result pairing',
  );
});

test('autoBalancedEnd 找不到平衡切點時回 NaN，不猜一個 end', () => {
  const body = autoEndBody();
  assert.ok(
    /return NaN/.test(body),
    'no balanced cut must yield NaN so the caller fails loudly instead of handing the core a range it refuses',
  );
});

test('價格便宜的節點若在未關閉的 step 中間，不是平衡切點', () => {
  // 這是原規則會挑錯的形狀：一個很便宜的節點，但它開了一個還沒關的 tool call。
  // 節點 1..6；節點 4 開 call，節點 6 才關。
  const nodes = [1, 2, 3, 4, 5, 6];
  const bySeq = new Map([
    [1, { seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } } }],
    [2, { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } }],
    [3, { seq: 3, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'more' }] } } }],
    [4, { seq: 4, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] } } }],
    [5, { seq: 5, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'tiny' }] } } }],
    [6, { seq: 6, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [] } } }],
  ]);
  const cuts = balancedCutsAfter(nodes, bySeq);
  // 切點在 index 4（節點 5）之後：call c1 還開著 → 不平衡。
  assert.equal(cuts.has(4), false, 'a cut while a tool call is open must not be balanced');
  // 切點在 index 5（節點 6）之後：call 關了 → 平衡。
  assert.equal(cuts.has(5), true, 'the cut after the closing tool result must be balanced');
});

test('autoBalancedEnd 的迴圈方向：從保留尾巴往前找，不是從 start 往後', () => {
  // 方向很重要：往前找（i--）得到「最靠近保留尾巴」的平衡切點，也就是摺得最少的那個。
  // 從 start 往後找會得到摺得最多的那個 —— 那是過度壓縮的方向。
  const body = autoEndBody();
  assert.ok(/for \(let i = lastAllowed; i > si; i--\)/.test(body),
    'the walk must go backwards from the preserved tail, so the fold removes as little as possible');
});

test('autoBalancedEnd 尊重 preserveRecent', () => {
  const body = autoEndBody();
  assert.ok(
    /nodes\.length - 1 - \(config\.preserveRecent \?\? 2\)/.test(body),
    'the last foldable index must be derived from preserveRecent',
  );
});
