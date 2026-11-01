// The deterministic shrink, in BOTH session representations: V3's tool-result wrapper and V4's
// first-class tool message (dsh-session-format-v3-to-v4). Reading only one of them fails silently on
// the other — no error, the pass simply never matches a result — so both are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutText, isShrunkContent, partsText, hasNonTextParts, shrinkTargets, shrunkenContent, toolResultOf, withResultParts,
  safeCutIndex, tailText, truncateText,
} from '../lib/shrink.js';

/** V3: role 'user', one tool-result wrapper holding the parts. */
const v3Message = (text, extra = {}) => ({
  id: 'm', role: 'user', source: { kind: 'tool', callId: 'call_1' },
  content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'run_code', content: [{ type: 'text', text }], ...extra }],
});
/** V4: role 'tool', toolCallId lifted, parts are the message content. */
const v4Message = (text, extra = {}) => ({
  id: 'm', role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1',
  'plugin:result:toolName': 'run_code', content: [{ type: 'text', text }], ...extra,
});
const event = (message) => ({ data: { message } });
const nodeAt = (seq, tokens, type = 'tool/result') => ({ seq, type, tokens });
const eventsFor = (map) => new Map(Object.entries(map).map(([seq, message]) => [Number(seq), event(message)]));

test('toolResultOf reads BOTH representations into one shape', () => {
  const v3 = toolResultOf(v3Message('hello'));
  const v4 = toolResultOf(v4Message('hello'));
  for (const r of [v3, v4]) {
    assert.equal(r.toolCallId, 'call_1');
    assert.equal(r.toolName, 'run_code');
    assert.equal(partsText(r.parts), 'hello');
    assert.equal(r.isError, false);
  }
  assert.equal(v3.shape, 'v3');
  assert.equal(v4.shape, 'v4');
  assert.equal(toolResultOf({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), null, 'an assistant message is not a tool result');
  assert.equal(toolResultOf(undefined), null);
});

test('withResultParts re-emits the shape it read', () => {
  const parts = [{ type: 'text', text: 'short' }];
  const v3 = withResultParts(toolResultOf(v3Message('long')), parts);
  assert.equal(v3.content.length, 1, 'V3 keeps the wrapper');
  assert.equal(v3.content[0].type, 'tool-result');
  assert.deepEqual(v3.content[0].content, parts);
  assert.equal(v3.content[0].toolCallId, 'call_1', 'the wrapper keeps its call id');
  const v4 = withResultParts(toolResultOf(v4Message('long')), parts);
  assert.deepEqual(v4.content, parts, 'V4 carries the parts directly');
  assert.equal(v4.toolCallId, 'call_1', 'and keeps the lifted call id');
  assert.equal(v4.role, 'tool');
});

test('cutText keeps head and tail and counts what it drops', () => {
  const cut = cutText('a'.repeat(5000), { headChars: 1000, tailChars: 200 });
  assert.equal(cut.head.length, 1000);
  assert.equal(cut.tail.length, 200);
  assert.equal(cut.elided, 3800);
  const small = cutText('short', { headChars: 1000, tailChars: 200 });
  assert.equal(small.elided, 0);
  assert.equal(small.tail, '');
});

test('shrunkenContent refuses when there is nothing worth dropping, and always names where the original is', () => {
  assert.equal(shrunkenContent([{ type: 'text', text: 'tiny' }], { seq: 7, headChars: 100, tailChars: 20 }), null);
  const out = shrunkenContent([{ type: 'text', text: 'b'.repeat(9000) }], { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
  assert.equal(out.length, 1);
  assert.match(out[0].text, /…\[shrunk run_code · \d+ of 9000 chars elided — original in the session log, seq 7\]/);
  assert.ok(out[0].text.startsWith('b'.repeat(100)));
  assert.ok(out[0].text.endsWith('b'.repeat(20)));
  assert.ok(isShrunkContent(out), 'the marker is what makes a later pass skip it');
});

test('shrinkTargets handles a surface holding BOTH representations, newest first, with every guard', () => {
  const big = 'c'.repeat(9000);
  const nodes = [nodeAt(1, 4000), nodeAt(2, 100), nodeAt(3, 5000), nodeAt(4, 9000), nodeAt(5, 9000), nodeAt(6, 9000)];
  const events = eventsFor({
    1: v3Message(big),
    2: v4Message('small'),
    3: v4Message(big, { content: [{ type: 'image', attachment: 'x' }] }),
    4: v4Message('…[shrunk run_code · 8000 of 9000 chars elided — original in the session log, seq 4]'),
    5: v4Message(big),
    6: v3Message(big),
  });
  const targets = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 2 });
  assert.deepEqual(targets.map((t) => t.seq), [1], 'the live tail is never touched');
  assert.equal(targets[0].shape, 'v3');
  const wider = shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1 });
  assert.deepEqual(wider.map((t) => t.seq), [5, 1], 'NEWEST first, across both shapes');
  assert.equal(wider[0].shape, 'v4');
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, limit: 1 }).map((t) => t.seq), [5]);
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, windowNodes: 1 }).map((t) => t.seq), [5]);
  assert.deepEqual(shrinkTargets({ nodes, eventBySeq: events, minTokens: 3000, protectedTail: 1, windowNodes: 5 }).map((t) => t.seq), [5, 1]);
});

test('a replacement is one node, same type, and differs from the original ONLY in content — both shapes', () => {
  for (const message of [v3Message('d'.repeat(9000)), v4Message('d'.repeat(9000))]) {
    const result = toolResultOf(message);
    const parts = shrunkenContent(result.parts, { seq: 7, toolName: 'run_code', headChars: 100, tailChars: 20 });
    const replacement = withResultParts(result, parts);
    assert.equal(replacement.id, message.id);
    assert.deepEqual(replacement.source, message.source);
    assert.equal(replacement.role, message.role, 'the role is preserved per shape');
    assert.notDeepEqual(replacement.content, message.content, 'only the content changed');
  }
});

test('the guards read the parts, not their label', () => {
  assert.equal(partsText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(hasNonTextParts([{ type: 'text', text: 'a' }]), false);
  assert.equal(hasNonTextParts([{ type: 'text', text: 'a' }, { type: 'image', attachment: 'x' }]), true, 'an image is never silently dropped');
  assert.equal(isShrunkContent([{ type: 'text', text: 'plain' }]), false);
});

// ---------------------------------------------------------------------------------------------
// 码点安全截断（2026-11-02）
//
// 事故：`~/.dsh/sessions` 全量 456 档 / 1,127,335 行里查出 18 处**孤立 UTF-16 代理对**，
// 每一个都来自本文件/调用方的 `slice(0, N)`：切点刚好落在一个 emoji 的两个码元之间，
// 头以孤立高位代理结尾。那串字随后被写进会话日志、再进请求载荷 —— provider 以
// **不可重试的 400** 拒绝，而坏值留在历史里，那条会话就再也恢复不了。
//
// 下面用**穷举**而不是挑几个点：任何一个切点都不许劈开代理对。
// ---------------------------------------------------------------------------------------------

// 每个字符都可能是代理对的字符串：中文、emoji(2 码元)、BMP 标点、组合序列
const MIXED = '評估完成 ✅ 完整報告：\n\n## 🗺 地图\n| 表格 | 🏠 首頁 |\n🧭🧭 tail';

test('safeCutIndex never lands between a surrogate pair (every index)', () => {
  for (let i = 0; i <= MIXED.length; i++) {
    const cut = safeCutIndex(MIXED, i);
    const head = MIXED.slice(0, cut);
    assert.equal(head.isWellFormed(), true, `cut at ${i} produced a lone surrogate in the head`);
    // 它只允许「退一格」，不许乱跳
    assert.ok(i - cut === 0 || i - cut === 1, `cut at ${i} moved by ${i - cut}`);
  }
});

test('truncateText is well-formed for EVERY budget, and respects budget-1', () => {
  for (let n = 0; n <= MIXED.length; n++) {
    const out = truncateText(MIXED, n);
    assert.equal(out.isWellFormed(), true, `budget ${n} produced a lone surrogate`);
    assert.ok(out.length <= n, `budget ${n} returned ${out.length} chars`);
    // 只在确实劈开一对时才少一个码元；否则必须用满预算
    const full = MIXED.slice(0, n);
    assert.ok(out.length === n || out.length === n - 1, `budget ${n} returned ${out.length} chars`);
    assert.equal(out.length === n, full.isWellFormed(), `budget ${n}: shrank a well-formed cut`);
  }
});

test('tailText is well-formed for EVERY keep length', () => {
  for (let n = 0; n <= MIXED.length + 2; n++) {
    const out = tailText(MIXED, n);
    assert.equal(out.isWellFormed(), true, `keep ${n} produced a lone surrogate`);
    assert.ok(out.length <= n, `keep ${n} returned ${out.length} chars`);
  }
});

test('cutText head and tail are BOTH well-formed for every head/tail pair', () => {
  for (let head = 0; head <= 12; head++) {
    for (let tail = 0; tail <= 12; tail++) {
      const cut = cutText(MIXED, { headChars: head, tailChars: tail });
      assert.equal(cut.head.isWellFormed(), true, `head ${head}/tail ${tail}: head split a pair`);
      assert.equal(cut.tail.isWellFormed(), true, `head ${head}/tail ${tail}: tail split a pair`);
    }
  }
});

test('the real-world hit: a 72-char preview of a message ending in "## 🗺"', () => {
  // 现场原文（session db5fe294 seq 152535 的 surface 预览）。72 正好切在 🗺 的两个码元之间。
  const line = '評估完成 ✅ 完整報告存於 `kb/docs/research/06-model-evaluation.adoc`。以下是核心結論：\n\n## 🗺 內容';
  const legacy = line.slice(0, 72);           // 旧行为：切开了代理对
  assert.equal(legacy.isWellFormed(), false, 'this fixture must reproduce the bug');
  const fixed = truncateText(line, 72);
  assert.equal(fixed.isWellFormed(), true);
  assert.equal(fixed.length, 71, 'it drops exactly the orphaned high surrogate');
});

test('shrunkenContent never writes a lone surrogate back into the transcript', () => {
  // 这条最要命：cutText 的输出会被 withResultParts 写回会话日志，坏值从此留在历史里。
  const long = 'x'.repeat(1199) + '🧭' + 'y'.repeat(400);
  assert.equal(long.slice(0, 1200).isWellFormed(), false, 'this fixture must reproduce the bug');
  const parts = shrunkenContent([{ type: 'text', text: long }], { seq: 1, toolName: 'run_code', headChars: 1200, tailChars: 400 });
  assert.notEqual(parts, null);
  const text = partsText(parts);
  assert.equal(text.isWellFormed(), true);
});
