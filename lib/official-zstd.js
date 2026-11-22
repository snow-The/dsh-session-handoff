/**
 * official-zstd.js — call the OFFICIAL `scanZstdFrames` instead of maintaining our own.
 *
 * ## Why this file exists
 *
 * `dsh-session-persistence-jsonl` ships `scanZstdFrames` in `src/zstd.ts`, but its
 * `lib/index.js` exports only `Config, JsonlCompressionSchema, apply, name`. So the
 * function is present in the package and unreachable through its public surface.
 *
 * Three routes were tried (measured 2026-11-21, re-measured 2026-11-22):
 *
 *   import '.../lib/index.js'   -> not exported
 *   import '.../src/zstd.ts'    -> Node refuses to strip types under node_modules
 *   extract the function, write it OUTSIDE node_modules, import that  -> works
 *
 * The third route is what this module does. It is not a reimplementation: the source text
 * is read from the installed package at runtime, so an upstream fix is picked up
 * automatically. `probe-official-zstd.mjs` proved the extracted function returns frames
 * byte-identical to ours (16,860 frames on a 24.1 MB session).
 *
 * ## Why the extraction is narrow
 *
 * The whole `zstd.ts` cannot be imported: its decoder uses TypeScript parameter
 * properties, which strip-only mode rejects. `scanZstdFrames` is a pure function that
 * depends on no decoder, so only it (plus `ZSTD_MAGIC`) is extracted.
 *
 * ## Failure behaviour
 *
 * Returns `null` rather than throwing. A caller that cannot reach the official
 * implementation must fall back to its own, and a missing optimisation is not an error.
 * The reason is available from `officialZstdStatus()` so a silent fallback can be seen.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** Where the installed package keeps the source. Overridable for tests. */
const DEFAULT_SOURCE =
  'C:/Users/snow/AppData/Local/npm-cache/_npx/63d4cff42d507497/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

let cached = null
let cachedFrom = null
let lastStatus = { ok: false, reason: 'not attempted' }

/**
 * Extract `scanZstdFrames` (and `ZSTD_MAGIC`) from the official source text.
 * Returns the extracted source, or null with a reason.
 */
export function extractScanSource(src) {
  const startMarker = 'export function scanZstdFrames'
  const startIdx = src.indexOf(startMarker)
  if (startIdx < 0) return { ok: false, reason: 'scanZstdFrames not found in the official source' }

  // Find the function's closing brace by brace matching from the start marker.
  let depth = 0
  let endIdx = -1
  let seenBrace = false
  for (let i = startIdx; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') { depth += 1; seenBrace = true }
    else if (ch === '}') {
      depth -= 1
      if (seenBrace && depth === 0) { endIdx = i + 1; break }
    }
  }
  if (endIdx < 0) return { ok: false, reason: 'could not find the end of scanZstdFrames' }

  const magicMatch = src.match(/const ZSTD_MAGIC = [^\n]+/)
  const magicLine = magicMatch ? magicMatch[0] : 'const ZSTD_MAGIC = 0xFD2FB528'

  return { ok: true, source: `${magicLine}\n${src.slice(startIdx, endIdx)}\n` }
}

/**
 * Load the official `scanZstdFrames`.
 *
 * @param {string} [sourcePath] - override the installed package path (tests).
 * @returns {Promise<Function|null>} the function, or null when it cannot be loaded.
 */
export async function loadOfficialScanZstdFrames(sourcePath = DEFAULT_SOURCE) {
  // The cache is keyed by SOURCE PATH, not global. A global cache would answer a request
  // for a different (or missing) path with a function loaded from somewhere else — the
  // caller would get a working function and never learn it came from the wrong file.
  // My own probe caught this: asking for a nonexistent path returned the cached function.
  if (cached && cachedFrom === sourcePath) return cached

  if (!existsSync(sourcePath)) {
    lastStatus = { ok: false, reason: `official source not found: ${sourcePath}` }
    return null
  }

  let src
  try {
    src = readFileSync(sourcePath, 'utf8')
  } catch (e) {
    lastStatus = { ok: false, reason: `cannot read official source: ${String(e?.message ?? e).slice(0, 120)}` }
    return null
  }

  const extracted = extractScanSource(src)
  if (!extracted.ok) {
    lastStatus = { ok: false, reason: extracted.reason }
    return null
  }

  // The extracted fragment still carries type annotations, so it must be written as .ts
  // OUTSIDE node_modules — Node only strips types outside that tree.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-official-zstd-'))
  const file = join(dir, 'scan.ts')
  try {
    writeFileSync(file, extracted.source, 'utf8')
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.scanZstdFrames !== 'function') {
      lastStatus = { ok: false, reason: 'extracted module did not export scanZstdFrames' }
      return null
    }
    cached = mod.scanZstdFrames
    cachedFrom = sourcePath
    lastStatus = { ok: true, reason: `extracted ${extracted.source.length} chars from ${sourcePath}` }
    return cached
  } catch (e) {
    lastStatus = { ok: false, reason: `import failed: ${String(e?.message ?? e).slice(0, 160)}` }
    return null
  } finally {
    // The module is already loaded into the ESM registry; the temp file is no longer needed.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Why the last load succeeded or failed. Never throws. */
export function officialZstdStatus() {
  return { ...lastStatus, cached: cached !== null }
}

/** Test seam: forget the cached function. */
export function resetOfficialZstdCache() {
  cached = null
  cachedFrom = null
  lastStatus = { ok: false, reason: 'reset' }
}
