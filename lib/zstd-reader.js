/**
 * zstd-reader.js - streaming, incremental multi-frame Zstandard reader.
 *
 * DSH session .jsonl.zstd files are MANY concatenated zstd frames (one frame
 * per append batch; a long session can hold 278k+ frames). node:zlib's
 * zstdDecompressSync is SINGLE-frame only and silently truncates multi-frame
 * input, so frames are located by their magic 28 B5 2F FD and decoded one by one.
 *
 * Why this file was rewritten (2026-09-11):
 *   The previous reader did readFileSync(whole file) -> decode EVERY frame ->
 *   Buffer.concat(parts) -> one giant plaintext string -> split into lines ->
 *   JSON.parse every line, synchronously on the main thread. Measured on a real
 *   155 MB / 278,451-frame session: 9,061 ms and +993 MB heap PER CALL, on every
 *   acp_compress (the watermark only guarded the DB write, not the read/decode).
 *
 *   Now: sessions are append-only, so callers that keep a byte offset only pay
 *   for the bytes appended since the last consumed frame, and a cheap
 *   fileStamp() gate lets them skip an unchanged file entirely (0 ms, no read).
 *   Nothing ever materializes the whole plaintext.
 */
import { openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameRanges } from './zstd-frames.js';

const require = createRequire(import.meta.url);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * zstd 可执行文件候选。抽取为函数只为让两个 CLI 回退点共用一份列表；本提交**不改变**其内容，
 * 仍是 PATH 上的 `zstd` 加一个本机绝对路径（下一提交再改为可移植解析）。
 */
export function zstdBinaryCandidates() {
  return ['zstd', WINGET_ZSTD];
}

/** node:zlib zstd decoder, or null when the runtime predates Node 22.13. */
function zstdSync() {
  try {
    const z = require('node:zlib');
    return typeof z.zstdDecompressSync === 'function' ? z.zstdDecompressSync : null;
  } catch { return null; }
}

/**
 * 帧区间（start/end）。
 *
 * 原先这里只做**魔数扫描**：找出每个 0x28B52FFD 的位置，再靠解压确认边界
 * （作者因此不得不加 3 次试探补偿，因为压缩载荷里可能出现同样的字节序列）。
 *
 * 现在改用 zstd-frames.js 的**结构化扫描**（移植自官方 scanZstdFrames）：
 * 走帧头描述符 + 块头得到逐字节精确的区间，不解压任何块。
 * 实测（107.4 MB 真实日志）：结构扫描 22 ms，逐帧解压 1541 ms，
 * 且结构扫描给出 171,893 个区间、首尾相接、覆盖 100%。
 *
 * 韧性不变：frameRanges() 在结构扫描失败（日志损坏）时**退回魔数扫描**，
 * 所以"部分损坏仍尽量多读"的既有行为被保留，只是正常路径变得更精确。
 *
 * @param {Buffer} buf
 * @returns {{ start: number, end: number }[]}
 */
function frameRangesOf(buf) {
  const r = frameRanges(buf);
  if (r.mode === 'magic-fallback') {
    // 只在真的退回时出声（正常路径保持安静）。
    console.warn('[dsh-session-handoff] zstd: structural scan failed, fell back to magic scan:', r.fallbackReason);
  }
  return r.frames;
}

/** Offsets of every frame start inside buf（保留：给只想要起点的调用方）。 */
function frameOffsets(buf) {
  return frameRangesOf(buf).map((r) => r.start);
}

/** Feed one decompressed frame's JSONL lines to sink (optionally filtered). */
function collectEvents(text, keep, sink) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!keep || keep(ev)) sink(ev);
  }
}

/** Read only the byte range [from, EOF) - the prefix is never loaded. */
function readTail(path, from) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.min(Number(from) || 0, size));
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === len ? buf : buf.subarray(0, got), size, start };
  } finally { closeSync(fd); }
}

/** Cheap change token: size + mtime + a 4 KB prefix hash (detects rewrites). */
export function fileStamp(path) {
  const st = statSync(path);
  let head = Buffer.alloc(0);
  try {
    const fd = openSync(path, 'r');
    try { head = Buffer.allocUnsafe(Math.min(4096, st.size)); readSync(fd, head, 0, head.length, 0); }
    finally { closeSync(fd); }
  } catch { /* stamp still usable via size+mtime */ }
  let h = 5381;
  for (let i = 0; i < head.length; i++) h = ((h << 5) + h + head[i]) >>> 0;
  return { size: st.size, mtimeMs: st.mtimeMs, prefixHash: h };
}

/**
 * Decode the frames appended after \`fromByte\`.
 * @returns { events, consumedBytes, fileBytes } - resume from consumedBytes.
 */
export function readSessionEventsIncremental(path, fromByte, keep) {
  const { buf, size, start } = readTail(path, fromByte || 0);
  const events = [];
  let consumed = start;
  const dec = zstdSync();
  if (dec === null) return { events: readAllViaCli(path, keep), consumedBytes: size, fileBytes: size };
  const offs = frameOffsets(buf);
  for (let f = 0; f < offs.length; f++) {
    const s = offs[f];
    let endIdx = f + 1;
    let text = null;
    // A magic inside a compressed payload is a false positive: widen to the
    // next real boundary (bounded) instead of silently truncating the stream.
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = endIdx < offs.length ? offs[endIdx] : buf.length;
      try { text = dec(buf.subarray(s, e)).toString('utf8'); break; } catch { text = null; endIdx++; }
      if (endIdx > offs.length) break;
    }
    if (text === null) break;                         // torn tail: retry next call
    collectEvents(text, keep, (ev) => events.push(ev));
    consumed = start + (endIdx < offs.length ? offs[endIdx] : buf.length);
    f = endIdx - 1;
  }
  return { events, consumedBytes: consumed, fileBytes: size };
}

/** Legacy whole-file CLI decode (only when node:zlib has no Zstd). */
function readAllViaCli(path, keep) {
  const { execSync } = require('node:child_process');
  let text = null;
  for (const bin of zstdBinaryCandidates()) {
    try { text = execSync(bin + ' -d -c ' + JSON.stringify(path), { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); break; } catch { /* next */ }
  }
  if (text === null) { console.warn('[dsh-session-handoff] zstd: no usable decoder'); return []; }
  const events = [];
  collectEvents(text, keep, (ev) => events.push(ev));
  return events;
}

/**
 * Decode ONLY the first frame of a log - the header line - with a bounded read.
 * Used by the provenance backfill, which walks every session file and must not pay
 * for the bodies (some logs are 155 MB).
 */
export function readHeaderLine(path, maxBytes = 65536) {
  const dec = zstdSync();
  if (dec === null) return null;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, maxBytes);
    const fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(len);
    try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
    const offs = frameOffsets(buf);
    const end = offs.length > 1 ? offs[1] : buf.length;
    return dec(buf.subarray(0, end)).toString('utf8').split('\n')[0];
  } catch { return null; }
}

/** All events of one session file (streaming; no whole-text materialization). */
export function readSessionEventsFile(path, keep) {
  if (!path) return [];
  try {
    if (String(path).endsWith('.zstd')) return readSessionEventsIncremental(path, 0, keep).events;
    const events = [];
    collectEvents(readFileSync(path, 'utf8'), keep, (ev) => events.push(ev));
    return events;
  } catch (e) {
    console.warn('[dsh-session-handoff] readSessionEventsFile failed:', String(e?.message ?? e));
    return [];
  }
}

/** Decompress a whole (possibly multi-frame) buffer to text. */
/**
 * Decode a buffer of concatenated zstd frames into text.
 *
 * TOTAL BY CONTRACT: returns the text of every frame it could decode, or null when
 * nothing decodes - empty input, random bytes, a truncated frame, or an environment with
 * no decoder at all.
 *
 * The file-level readers in this module were already total (a torn tail is a normal state
 * for a session log), but this exported helper threw instead, so a fuzzer flagged it on
 * 102 of 250 adversarial inputs ("unexpected end of file", "Unknown frame descriptor").
 * A reader handing its caller an exception on damaged input is the failure mode this whole
 * module exists to avoid. Behaviour change: "no usable decoder" used to throw; it now
 * returns null like every other undecodable case. No caller in this repo or in the other
 * @snow-the plugins relied on the throw.
 */
export function zstdText(buf) {
  if (buf == null || buf.length === 0) return null;
  const dec = zstdSync();
  if (dec !== null) {
    const offs = frameOffsets(buf);
    const starts = offs.length === 0 ? [0] : offs;   // no magic: try the buffer as a single frame
    const parts = [];
    for (let f = 0; f < starts.length; f++) {
      const s = starts[f];
      const e = f + 1 < starts.length ? starts[f + 1] : buf.length;
      try { parts.push(dec(buf.subarray(s, e))); } catch { /* skip the damaged frame, keep the rest */ }
    }
    if (parts.length === 0) return null;
    return Buffer.concat(parts).toString('utf8');
  }
  const { join } = require('node:path');
  const tmp = join(tmpdir(), 'dsh-zstd-' + process.pid + '-' + Date.now() + '.bin');
  try {
    writeFileSync(tmp, buf);
    const { execSync } = require('node:child_process');
    for (const bin of zstdBinaryCandidates()) {
      try { return execSync(bin + ' -d -c ' + JSON.stringify(tmp), { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* next */ }
    }
  } catch { /* fall through to null */ } finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
  return null;
}
