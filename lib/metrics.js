/**
 * Compaction metrics: an append-only journal plus the three-part budget ledger.
 *
 * Why this file exists (two failures it is built against):
 *
 *  1. The per-session compaction ledger used to be an in-process Map, so every number the
 *     harness ever measured died with the process — and a POOLED number was impossible to
 *     compute at all. 31057 (Measure Before You Manage) reports pooled 55.5% and per-session
 *     50.8% for the same data: a single aggregate would have been reported as "the" result.
 *     Journal rows are per-session, and every reader gets both views (see pooledSummary).
 *
 *  2. "75% of the window" reads like a measurement. It is an estimate (the host tokenMeter)
 *     over an assumed window, which is exactly the nominal-label trap the same paper documents.
 *     So every ratio here is printed next to its absolute cap AND its unit, and an unknown
 *     window says UNKNOWN instead of defaulting to something that looks fine.
 *
 * L4 (outcome) has no ground truth on a coding agent — the binary y LIMBO optimises does not
 * exist here — so this module reports PROXIES and prints "not measured" where nothing measures
 * them. An absent signal must never render as a zero.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** One generation of history is kept; an append-only file that never rotates costs more to read
 *  than the numbers in it are worth. */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

let warned = false;
function warnOnce(what, err) {
  if (warned) return;
  warned = true;
  console.warn('[dsh-session-handoff] ' + what + ':', err instanceof Error ? err.message : String(err));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function dshHomeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Journal path (DSH_ACP_METRICS overrides it; the tests point it at a temp file). */
export function metricsPath(opts = {}) {
  return opts.file ?? process.env.DSH_ACP_METRICS ?? join(dshHomeDir(), 'acp-metrics.jsonl');
}

/** Retrieval journal written by dsh-notemap for degenerate answers (shared file contract). */
export function retrievalPath(opts = {}) {
  return opts.file ?? process.env.DSH_NOTEMAP_RETRIEVAL ?? join(dshHomeDir(), 'notemap-retrieval.jsonl');
}

/**
 * Append one row. Returns true/false and NEVER throws: a measurement is not worth losing a
 * compaction over, and a metrics failure must not turn into a failed fold.
 */
export function appendMetric(row, opts = {}) {
  try {
    const file = metricsPath(opts);
    mkdirSync(dirname(file), { recursive: true });
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_JOURNAL_BYTES;
    try {
      if (statSync(file).size > maxBytes) renameSync(file, file + '.1');
    } catch { /* no file yet, or a rename that is not ours to make: appending is still correct */ }
    appendFileSync(file, JSON.stringify({ v: 1, ...row }) + '\n');
    return true;
  } catch (err) {
    warnOnce('metrics journal unavailable (accounting degrades to in-process only)', err);
    return false;
  }
}

/**
 * Read a JSONL journal. A line that does not parse is COUNTED and skipped, never thrown: one
 * torn line (a crash mid-append) must not cost the whole history, and a silent skip would hide
 * a writer that is emitting garbage.
 */
function readJournal(file, opts = {}) {
  const out = { path: file, exists: false, rows: [], skipped: 0 };
  if (!existsSync(file)) return out;
  out.exists = true;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (err) { warnOnce('metrics journal unreadable', err); return out; }
  const lines = text.split('\n');
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const r = JSON.parse(t);
      if (r != null && typeof r === 'object') rows.push(r); else out.skipped += 1;
    } catch { out.skipped += 1; }
  }
  const limit = Number(opts.limit);
  out.rows = Number.isFinite(limit) && limit > 0 ? rows.slice(-Math.floor(limit)) : rows;
  out.total = rows.length;
  return out;
}

/**
 * Compaction rows: {ts, session, start, end, nodes, before, after, lossTokens, lossCostCNY, ms}.
 * Settle rows: {kind:'settle', ts, session, foldTs, uncachedTokens, cachedTokens, estimatedTokens} —
 * the MEASURED cache bill of that fold, written once its next call has been billed. Fold sums must
 * use {@link foldRows}; note that rows written before v0.18.4 priced the fold on the PRE-fold context
 * and so carry an inflated lossTokens (by that fold's own shrink factor).
 */
export function readMetrics(opts = {}) {
  return readJournal(metricsPath(opts), opts);
}

/**
 * The exact shadowed range of every fold, as renderable lines.
 *
 * `acp_decompress` matches a CHECKPOINT, not an arbitrary range: a partial or mis-remembered range
 * is refused with "no compaction checkpoint matches start/end". Until this existed the only places
 * that carried the boundary were the fold's own return string and the checkpoint message already
 * injected into the surface -- so a model that had scrolled past both had to re-derive it, or
 * re-read the checkpoint prose, or guess. All three were observed. The journal has held
 * `{start, end}` per fold all along (the row is written for the cost ledger); this only surfaces it
 * in the one place a caller looks when it wants to retrieve something.
 *
 * De-duplicated by range, newest ts wins: a journal can hold the same fold twice (a retried write),
 * and two identical lines in a retrieval index are noise, not information.
 */
export function formatCheckpointLines(rows = [], sessionId) {
  const seen = new Map();
  for (const r of foldRows(rows)) {
    if (sessionId != null && String(r?.session ?? 'unknown') !== String(sessionId)) continue;
    if (!Number.isFinite(r?.start) || !Number.isFinite(r?.end)) continue;
    const key = r.start + '-' + r.end;
    const prev = seen.get(key);
    if (prev == null || num(r.ts) >= num(prev.ts)) seen.set(key, r);
  }
  if (seen.size === 0) return [];
  const ordered = [...seen.values()].sort((a, b) => num(a.start) - num(b.start));
  return [
    'recoverable checkpoints (acp_decompress needs these EXACT boundaries):',
    ...ordered.map((r) => `  s${r.start}-s${r.end}  ${num(r.nodes)} node(s)`
      + (num(r.before) > 0 ? `  ${num(r.before)}->${num(r.after)} tok` : '')),
  ];
}

/** Retrieval rows: {ts, session, tool, total, returned, truncated, unknown_id}. */
export function readRetrievalSignals(opts = {}) {
  return readJournal(retrievalPath(opts), opts);
}

function shrinkOf(s) {
  if (s.beforeTokens <= 0) return null;
  return (s.beforeTokens - s.afterTokens) / s.beforeTokens;
}

/**
 * Pooled AND per-session, side by side, always. Each session keeps its own rows so a reader can
 * see that the pooled figure is not the typical one (the 55.5% vs 50.8% lesson).
 */
/**
 * Only the rows that RECORD a fold. A settle row measures one fold's cache bill and is written by a
 * later pre-step, so counting it as a fold would double the compaction count, add a second loss
 * figure for the same event, and turn "the gap between the last two folds" into the milliseconds
 * between a fold and its own settle row.
 */
export function foldRows(rows = []) {
  return rows.filter((r) => (r?.kind ?? 'fold') === 'fold');
}

export function pooledSummary(rows = []) {
  const per = new Map();
  const all = { compactions: 0, lossTokens: 0, lossCostCNY: 0, beforeTokens: 0, afterTokens: 0, settled: 0, settledUncached: 0, settledCached: 0, shrinks: 0, shrinkFreed: 0 };
  for (const r of rows) {
    if (r?.kind === 'settle') {
      all.settled += 1;
      all.settledUncached += num(r.uncachedTokens);
      all.settledCached += num(r.cachedTokens);
      continue;
    }
    // Deterministic shrinks are not compactions either: they carry no summary, no model call and no
    // quality loss, so folding them into the compaction count would misstate all three.
    if (r?.kind === 'shrink') {
      all.shrinks += 1;
      all.shrinkFreed += num(r.freed);
    }
  }
  for (const r of foldRows(rows)) {
    const id = String(r.session ?? 'unknown');
    let s = per.get(id);
    if (s == null) {
      s = { session: id, compactions: 0, lossTokens: 0, lossCostCNY: 0, beforeTokens: 0, afterTokens: 0, measured: 0, firstTs: null, lastTs: null };
      per.set(id, s);
    }
    s.compactions += 1;
    s.lossTokens += num(r.lossTokens);
    s.lossCostCNY += num(r.lossCostCNY);
    all.compactions += 1;
    all.lossTokens += num(r.lossTokens);
    all.lossCostCNY += num(r.lossCostCNY);
    const before = num(r.before);
    const after = num(r.after);
    const ts = num(r.ts);
    if (ts > 0) {
      if (s.firstTs == null || ts < s.firstTs) s.firstTs = ts;
      if (s.lastTs == null || ts > s.lastTs) s.lastTs = ts;
    }
    if (before > 0 && after > 0) {
      s.beforeTokens += before;
      s.afterTokens += after;
      s.measured += 1;
      all.beforeTokens += before;
      all.afterTokens += after;
    }
  }
  const perSession = [...per.values()].map((s) => ({ ...s, shrink: shrinkOf(s) }));
  return {
    sessions: perSession.length,
    compactions: all.compactions,
    lossTokens: all.lossTokens,
    lossCostCNY: all.lossCostCNY,
    measured: perSession.reduce((n, s) => n + s.measured, 0),
    shrink: shrinkOf(all),
    // Measured, not predicted: the harness counters actually billed after a fold.
    settled: all.settled,
    settledUncached: all.settledUncached,
    settledCached: all.settledCached,
    shrinks: all.shrinks,
    shrinkFreed: all.shrinkFreed,
    perSession,
  };
}

export function sessionSummary(rows = [], sessionId) {
  const id = String(sessionId ?? 'unknown');
  const own = rows.filter((r) => String(r.session ?? "unknown") === id);
  return pooledSummary(own);
}

/**
 * The three-part budget ledger. Ratio, absolute cap, unit — one string, always all three.
 * windowTokens == null is NOT "no pressure": it is "we do not know the denominator", and the
 * line says so (the older banner printed a bare token count and nothing looked wrong).
 */
export function budgetLedger({ usedTokens, windowTokens, softTokens, hardTokens, windowReason } = {}) {
  const used = num(usedTokens);
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? num(windowTokens) : null;
  const cap = (v) => (Number.isFinite(v) && v > 0 ? num(v) : null);
  const soft = cap(softTokens);
  const hard = cap(hardTokens);
  return {
    used,
    window,
    soft,
    hard,
    windowSource: window == null ? 'unknown' : 'reported',
    windowReason: window == null ? String(windowReason ?? 'unknown') : null,
    unit: 'tokenMeter estimate (host), not billed tokens',
    ratio: window == null ? null : used / window,
    softRatio: soft == null || window == null ? null : soft / window,
    hardRatio: hard == null || window == null ? null : hard / window,
  };
}

function pct(x) {
  return x == null ? null : (x * 100).toFixed(1) + "%";
}

export function formatBudgetLine(l) {
  if (l == null) return "budget: not available";
  const head = l.window == null
    ? "budget: used " + l.used + " tok (window UNKNOWN — " + l.windowReason + ")"
    : "budget: used " + l.used + " tok = " + pct(l.ratio) + " of " + l.window + " (window reported by the host)";
  const soft = l.soft == null ? "n/a" : String(l.soft) + (l.softRatio != null ? " = " + pct(l.softRatio) : "");
  const hard = l.hard == null ? "n/a" : String(l.hard) + (l.hardRatio != null ? " = " + pct(l.hardRatio) : "");
  return head + " | soft " + soft + " | hard " + hard + " | unit: " + l.unit;
}

/**
 * L1/L2/L3 of 31057 Tab.4. `billed` is the only layer whose numbers come from the provider
 * (cache read vs uncached input, both disjoint in the harness TokenUsage convention) — the
 * estimated-to-send figure lives in the budget line, and the two are deliberately not merged.
 */
export function layerLines({ storedTokens, surfaceNodes, collapsedNodes, billed, work } = {}) {
  const lines = [];
  lines.push("L1 stored: " + num(storedTokens) + " tok on the surface"
    + (Number.isFinite(surfaceNodes) ? " / " + surfaceNodes + " nodes" : "")
    + (Number.isFinite(collapsedNodes) ? " / " + collapsedNodes + " collapsed" : ""));
  if (billed == null) lines.push("L2 delivered (billed): not recorded for this session yet");
  else lines.push("L2 delivered (billed): " + num(billed.hits) + " cached + " + num(billed.misses) + " miss (hit "
    + (billed.hitRate == null ? "n/a" : pct(billed.hitRate)) + ")");
  if (work != null) {
    lines.push("L3 work: " + num(work.compactions) + " compaction(s), ~" + num(work.lossTokens)
      + " tok re-sent uncached (ESTIMATED from the post-fold context), ≈" + num(work.lossCostCNY).toFixed(3) + " CNY"
      + (Number.isFinite(work.ms) ? ", " + Math.round(work.ms) + " ms of plugin-side fold calls" : "")
      + (Number.isFinite(work.userMsgs) ? ", " + work.userMsgs + " user turns so far" : ""));
    // The estimate above is a price made at fold time; this is the bill the provider actually sent.
    if (num(work.settled) > 0) lines.push("L3 measured: " + num(work.settled) + " fold bill(s) settled from the harness "
      + "counters — " + num(work.settledUncached) + " uncached + " + num(work.settledCached) + " cached tok billed after the fold");
    else lines.push("L3 measured: no settled fold bill yet (the row is written one step after a fold)");
    if (num(work.shrinks) > 0) lines.push("L3 shrink: " + num(work.shrinks) + " deterministic shrink pass(es) freed "
      + num(work.shrinkFreed) + " tok with no model call and no summary");
  }
  return lines;
}

/**
 * L4 (outcome) is the layer we do NOT have. These are proxies and they say what they are:
 *  - the gap between the last two compactions (a stuttering threshold is a mis-set budget);
 *  - retrieval signals recorded by dsh-notemap: a CUT list, a handle that did not resolve, or a
 *    resolver answer that came back unresolved (all three are observed failures, none is a guess);
 *  - restatement of the same request by the user: NOT measured (it needs a semantic call we
 *    have not built), so it is printed as not-measured rather than as a zero.
 */
export function outcomeLines({ rows = [], sessionId, retrieval = null, now = Date.now() } = {}) {
  const id = String(sessionId ?? 'unknown');
  const mine = foldRows(rows).filter((r) => String(r.session ?? "unknown") === id).sort((a, b) => num(a.ts) - num(b.ts));
  const lines = [];
  if (mine.length >= 2) {
    const a = mine[mine.length - 2];
    const b = mine[mine.length - 1];
    const gapMs = num(b.ts) - num(a.ts);
    lines.push("L4 outcome (proxy): gap between the last two folds " + formatDuration(gapMs)
      + " (stutter = budget mis-set, refold = the fold was too shallow)");
  } else if (mine.length === 1) {
    lines.push("L4 outcome (proxy): one fold so far, " + formatDuration(Math.max(0, num(now) - num(mine[0].ts))) + " ago");
  } else {
    lines.push("L4 outcome (proxy): no fold recorded for this session");
  }
  if (retrieval == null || retrieval.exists !== true) {
    lines.push("retrieval signals: not recorded (dsh-notemap writes " + (retrieval?.path ?? retrievalPath()) + ")");
  } else {
    const rows2 = retrieval.rows ?? [];
    const cut = rows2.filter((r) => r.truncated === true).length;
    const miss = rows2.filter((r) => r.unknown_id != null && r.unknown_id !== "").length;
    const unres = rows2.filter((r) => r.resolved === false).length;
    lines.push("retrieval signals: " + rows2.length + " degenerate answer(s) — " + cut + " truncated, " + miss + " unknown_id, " + unres + " unresolved"
      + (retrieval.skipped ? ", " + retrieval.skipped + " unreadable line(s)" : ""));
  }
  lines.push("restatement of the same request by the user: NOT measured (no semantic pass yet) — read it as missing, not as zero");
  return lines;
}

export function formatDuration(ms) {
  const v = num(ms);
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 60000) return (v / 1000).toFixed(1) + "s";
  if (v < 3600000) return (v / 60000).toFixed(1) + "min";
  return (v / 3600000).toFixed(1) + "h";
}

/**
 * The status block: budget ledger, L1-L4, pooled-beside-this-session. Pure, so the text a user
 * actually reads is covered by tests — an older banner had a unit test against a string nobody
 * rendered, which is how it silently lost its window.
 */
export function statusBlock({
  usedTokens, windowTokens, softTokens, hardTokens, windowReason,
  surfaceNodes, collapsedNodes, billed, rows = [], retrieval = null, sessionId, now = Date.now(),
} = {}) {
  const ledger = budgetLedger({ usedTokens, windowTokens, softTokens, hardTokens, windowReason });
  const pooled = pooledSummary(rows);
  const own = sessionSummary(rows, sessionId);
  const mine = foldRows(rows).filter((r) => String(r.session ?? 'unknown') === String(sessionId ?? 'unknown'));
  const foldMs = mine.reduce((n, r) => n + num(r.ms), 0);
  const userMsgs = mine.length > 0 ? mine[mine.length - 1].userMsgs : undefined;
  const lines = [
    formatBudgetLine(ledger),
    ...layerLines({
      storedTokens: usedTokens, surfaceNodes, collapsedNodes, billed,
      work: { compactions: own.compactions, lossTokens: own.lossTokens, lossCostCNY: own.lossCostCNY,
              settled: own.settled, settledUncached: own.settledUncached, settledCached: own.settledCached,
              shrinks: own.shrinks, shrinkFreed: own.shrinkFreed,
              ms: foldMs > 0 ? foldMs : undefined, userMsgs: Number.isFinite(userMsgs) ? userMsgs : undefined },
    }),
    ...outcomeLines({ rows, sessionId, retrieval, now }),
    formatPooledLine(pooled, own),
  ];
  return { ledger, pooled, session: own, lines };
}

/** One line for acp_status: pooled next to this session. */
export function formatPooledLine(summary, sessionSummaryView, label = "this session") {
  if (summary == null || summary.compactions === 0) return "pooled: no compactions recorded in the journal";
  const shr = (s) => (s == null || s.shrink == null ? "n/a" : (s.shrink * 100).toFixed(1) + "%");
  const own = sessionSummaryView == null ? null : sessionSummaryView;
  return "pooled: " + summary.compactions + " compaction(s) across " + summary.sessions + " session(s), avg shrink " + shr(summary)
    + " | " + label + ": " + (own == null ? "n/a" : own.compactions + ", avg shrink " + shr(own));
}