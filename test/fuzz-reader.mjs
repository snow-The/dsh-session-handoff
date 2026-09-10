/**
 * Fuzz the session-log reader.
 *
 * Why this target: a single-frame rewrite of a session log is what corrupted a ten-day
 * session, and the reader is the component that has to survive whatever it is handed -
 * truncated files, torn tails, single-frame logs, garbage between frames, and compressed
 * payloads that happen to contain the zstd magic bytes (frameOffsets() finds frame starts
 * by scanning for that magic, so a false positive is a real risk).
 *
 * Invariants, not exact outputs:
 *   - never throw
 *   - never hang (bounded wall time per case)
 *   - always return the documented shape (array / string|null / object)
 *
 * Deterministic: a seeded PRNG means a failure reproduces from the printed seed.
 *   node test/fuzz-reader.mjs [--iters=300] [--seed=12345]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readSessionEventsFile, readSessionEventsIncremental, readHeaderLine, fileStamp, zstdText } from '../lib/zstd-reader.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ITERS = Number(args.iters ?? 300);
const SEED = Number(args.seed ?? 20260911);

/** mulberry32: tiny deterministic PRNG so every failure is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
const randBytes = (n) => { const b = Buffer.allocUnsafe(n); for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256); return b; };
const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'));
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const HEADER = JSON.stringify({ type: 'session', version: 3, id: 'session-fuzz', createdAt: 1, cwd: 'C:/x' });
const evLine = (i) => JSON.stringify({ type: 'user/message', seq: i, data: { content: [{ type: 'text', text: 'x'.repeat(20) }] } });
const healthy = () => Buffer.concat([frame(HEADER + '\n'), frame(evLine(1) + '\n'), frame(evLine(2) + '\n')]);

const corpora = {
  empty: () => Buffer.alloc(0),
  oneByte: () => Buffer.from([0x28]),
  random: () => randBytes(1 + Math.floor(rand() * 4096)),
  singleFrameWholeFile: () => frame([HEADER, evLine(1), evLine(2)].join('\n')),   // the corruption mode
  healthy,
  headerOnly: () => frame(HEADER + '\n'),
  tornTail: () => { const h = healthy(); return h.subarray(0, Math.max(1, h.length - Math.floor(rand() * 12) - 1)); },
  garbageBetweenFrames: () => Buffer.concat([frame(HEADER + '\n'), randBytes(1 + Math.floor(rand() * 32)), frame(evLine(1) + '\n')]),
  magicInPayload: () => Buffer.concat([frame(HEADER + '\n'), MAGIC, MAGIC, frame(evLine(1) + '\n')]),
  notJsonLines: () => Buffer.concat([frame('not json at all\n{"broken":\n'), frame(evLine(1) + '\n')]),
  headerNotJson: () => frame('this is not a header\n'),
  hugeFrame: () => frame(HEADER + '\n' + 'a'.repeat(2 * 1024 * 1024)),
  nestedMagic: () => { const inner = frame(evLine(1) + '\n'); return Buffer.concat([frame(HEADER + '\n'), inner, inner]); },
};

const problems = [];
const dir = mkdtempSync(join(tmpdir(), 'fuzz-reader-'));
const file = join(dir, 'session.jsonl.zstd');
let cases = 0;
for (let i = 0; i < ITERS; i++) {
  const name = pick(Object.keys(corpora));
  const buf = corpora[name]();
  writeFileSync(file, buf);
  cases++;

  const started = Date.now();
  // Attribute a failure to the exact call: "the reader throws" is not actionable.
  const attempts = [
    ['readSessionEventsFile', () => readSessionEventsFile(file), (v) => Array.isArray(v)],
    ['readSessionEventsIncremental', () => readSessionEventsIncremental(file, 0, undefined), (v) => v != null && typeof v === 'object'],
    ['readHeaderLine', () => readHeaderLine(file), (v) => v === null || typeof v === 'string'],
    ['fileStamp', () => fileStamp(file), (v) => v != null && typeof v === 'object'],
    ['zstdText', () => zstdText(buf), (v) => v === null || typeof v === 'string'],
  ];
  for (const [fn, call, ok] of attempts) {
    try {
      const value = call();
      if (!ok(value)) problems.push({ fn, name, why: 'SHAPE: returned ' + typeof value, bytes: buf.length });
    } catch (err) {
      problems.push({ fn, name, why: 'THREW: ' + (err && err.message ? err.message : String(err)), bytes: buf.length });
    }
  }
  try {
    // sanity: a healthy log must still parse, or the fuzzer is testing nothing
    if (name === 'healthy' && readSessionEventsFile(file).length === 0) problems.push({ fn: 'sanity', name, why: 'healthy log read as empty' });
  } catch { /* already reported above */ }
  const ms = Date.now() - started;
  if (ms > 3000) problems.push({ name, why: 'SLOW: ' + ms + 'ms', bytes: buf.length });
}
try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

const tally = (key) => {
  const acc = {};
  for (const p of problems) { const k = key(p); acc[k] = (acc[k] ?? 0) + 1; }
  return acc;
};
console.log(JSON.stringify({
  seed: SEED, iterations: ITERS, cases,
  problems: problems.length,
  byFunction: tally((p) => p.fn),
  byCorpus: tally((p) => p.name),
  byReason: tally((p) => String(p.why).split(':')[0]),
  samples: problems.slice(0, 5),
}, null, 1));
process.exit(problems.length ? 1 : 0);
