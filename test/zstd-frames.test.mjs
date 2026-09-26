/**
 * 帧扫描：结构化扫描必须给出【精确、连续、完整覆盖】的帧区间。
 *
 * 回归背景：zstd-reader.js 原先只按魔数（0x28B52FFD）定位帧起点，边界靠解压确认，
 * 压缩载荷里出现同样字节序列时会得到假阳性边界 —— 那是静默的损坏。
 * 现在改用移植自官方 scanZstdFrames 的结构化扫描（走帧头描述符 + 块头，不解压）。
 * 本测试锁住结构化扫描的应有性质，以及"结构失败时退回魔数"的韧性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scanZstdFramesStrict, frameRanges, magicOffsets } from '../lib/zstd-frames.js';

const require = createRequire(import.meta.url);

/** 用 node:zlib 造 n 个可独立解码的 zstd 帧并拼接（真实会话日志就是这种形态）。 */
function concatFrames(payloads) {
  const z = require('node:zlib');
  return Buffer.concat(payloads.map((p) => z.zstdCompressSync(Buffer.from(p, 'utf8'))));
}

test('structural scan yields contiguous, exactly-covering frame ranges', () => {
  const buf = concatFrames(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
  const scan = scanZstdFramesStrict(buf);
  assert.equal(scan.frames.length, 3, 'three concatenated frames must be found');
  assert.equal(scan.tornStart, undefined, 'a complete file has no torn frame');
  assert.equal(scan.frames[0].start, 0);
  assert.equal(scan.frames[scan.frames.length - 1].end, buf.length, 'coverage must reach EOF');
  for (let i = 1; i < scan.frames.length; i++) {
    assert.equal(scan.frames[i].start, scan.frames[i - 1].end, 'ranges must be contiguous');
  }
});

test('structural scan still finds the frames a byte-at-a-time magic hunt would miss', () => {
  // 关键点：魔数扫描只能给出"疑似起点"；结构扫描给出精确区间。
  // 这里断言每个区间都能独立解压成功 —— 精确边界的最直接证据。
  const z = require('node:zlib');
  const payloads = ['{"x":1}\n', '{"x":2}\n', '{"x":3}\n', '{"x":4}\n'];
  const buf = concatFrames(payloads);
  const { frames } = scanZstdFramesStrict(buf);
  assert.equal(frames.length, payloads.length);
  frames.forEach((r, i) => {
    const text = z.zstdDecompressSync(buf.subarray(r.start, r.end)).toString('utf8');
    assert.equal(text, payloads[i], `frame ${i} must decode alone from its exact range`);
  });
});

test('a torn final frame is reported by its start, not silently dropped', () => {
  const whole = concatFrames(['{"a":1}\n', '{"b":2}\n']);
  const half = concatFrames(['{"a":1}\n']);
  // 截断第二个帧：结构扫描应给出 tornStart 指向它，而不是抛错或假装没有。
  const torn = Buffer.concat([half, whole.subarray(half.length, half.length + Math.floor((whole.length - half.length) / 2))]);
  const scan = scanZstdFramesStrict(torn);
  assert.equal(scan.frames.length, 1, 'the complete frame must still be reported');
  assert.equal(typeof scan.tornStart, 'number', 'the torn frame start must be reported');
  assert.equal(scan.tornStart, half.length);
});

test('structurally corrupt input throws instead of returning wrong boundaries', () => {
  const good = concatFrames(['{"a":1}\n']);
  const corrupt = Buffer.concat([good, Buffer.from([0x00, 0x01, 0x02, 0x03])]);
  assert.throws(() => scanZstdFramesStrict(corrupt), /corrupt Zstandard session log/);
});

test('frameRanges falls back to magic offsets on corruption, and says so', () => {
  const good = concatFrames(['{"a":1}\n', '{"b":2}\n']);
  const corrupt = Buffer.concat([good, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  const r = frameRanges(corrupt);
  assert.equal(r.mode, 'magic-fallback', 'must fall back rather than fail the whole read');
  assert.match(String(r.fallbackReason), /corrupt Zstandard session log/);
  assert.ok(r.frames.length >= 1, 'the magic path must still yield candidate ranges');
  assert.deepEqual(
    r.frames.map((f) => f.start),
    magicOffsets(corrupt),
    'fallback ranges must start at the magic offsets',
  );
});

test('frameRanges uses the structural path when the input is sound', () => {
  const buf = concatFrames(['{"a":1}\n', '{"b":2}\n']);
  const r = frameRanges(buf);
  assert.equal(r.mode, 'structural');
  assert.equal(r.frames.length, 2);
});
