/**
 * zstd-reader.js - multi-frame Zstandard reader for DSH session files.
 *
 * DSH session .jsonl.zstd files are MANY concatenated zstd frames (one frame
 * per write batch; a long session can hold 40k+ frames). node:zlib's
 * zstdDecompressSync is SINGLE-frame only and silently truncates multi-frame
 * input (verified: 179 chars instead of 89.6M).
 *
 * Strategy (verified on a 28.6MB / 43,662-frame file -> full 89.6M chars):
 *   1. scan the buffer for the zstd frame magic 28 B5 2F FD (little-endian
 *      frame starts; false positives inside frames are essentially impossible
 *      for real session payloads),
 *   2. zstdDecompressSync each frame slice (Node 22.13+ built-in),
 *   3. concat. Falls back to the zstd CLI (PATH, then the known winget path)
 *      when node:zlib lacks Zstd (Node < 22.13).
 *
 * JSONL parsing lives here too so a caller gets events directly.
 */
import { readFileSync } from 'node:fs';

const WINGET_ZSTD = 'C:\\Users\\snow\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Meta.Zstandard_Microsoft.Winget.Source_8wekyb3d8bbwe\\zstd-v1.5.7-win64\\zstd.exe';

/** Decompress a (possibly multi-frame) zstd buffer to a UTF-8 string. */
export function zstdText(buf) {
  const { zstdDecompressSync } = (() => { try { return require('node:zlib'); } catch { return {}; } })();
  if (typeof zstdDecompressSync === 'function') {
    const starts = [];
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i);
    }
    if (starts.length > 1) {
      const parts = [];
      for (let f = 0; f < starts.length; f++) {
        const s = starts[f];
        const e = f + 1 < starts.length ? starts[f + 1] : buf.length;
        parts.push(zstdDecompressSync(buf.subarray(s, e)));
      }
      return Buffer.concat(parts).toString('utf8');
    }
    return zstdDecompressSync(buf).toString('utf8'); // single frame
  }
  // CLI fallback (handles multi-frame too)
  const { execSync } = require('node:child_process');
  const tmp = require('node:os').tmpdir() + '\\dsh-zstd-' + process.pid + '.bin';
  require('node:fs').writeFileSync(tmp, buf);
  try {
    for (const bin of ['zstd', WINGET_ZSTD]) {
      try { return execSync(bin + ' -d -c ' + JSON.stringify(tmp), { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* next */ }
    }
  } finally {
    try { require('node:fs').unlinkSync(tmp); } catch { /* ignore */ }
  }
  throw new Error('zstd: no usable decoder (node:zlib < 22.13 and no CLI)');
}

/** Read a session file (plain .jsonl or .zstd) and parse JSONL events. */
export function readSessionEventsFile(path) {
  if (!path) return [];
  let text;
  try {
    if (path.endsWith('.zstd')) text = zstdText(readFileSync(path));
    else text = readFileSync(path, 'utf8');
  } catch (e) {
    console.warn('[dsh-session-handoff] readSessionEventsFile failed:', String(e?.message ?? e));
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip bad lines */ }
  }
  return events;
}
