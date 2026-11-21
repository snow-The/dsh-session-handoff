/**
 * repetition.js — detect degenerate repetition in a streaming model output.
 *
 * THE FAILURE THIS TARGETS (observed live, 2026-11-21, pasted by the user):
 *
 *   OK. / Let me write. / Let me go. / Writing. / Let me go.
 *   OK. / Let me write. / Let me go. / Writing. / Let me go.
 *
 * The model is not producing content; it is cycling through four short phrases. The session keeps
 * paying for it and nothing downstream can tell this apart from a long answer by length alone.
 *
 * WHY THE OBVIOUS APPROACHES ARE WRONG — both were tried and measured on that sample:
 *
 *  1. "the same substring appears twice" fires on real work: `const x = 1;` on ten lines,
 *     `</div>` closing tags, a markdown rule, a base64 blob.
 *  2. "a cycle repeats N times" MISSES the sample. The pasted text is 97 normalised chars with a
 *     49-char cycle, i.e. 1.98 repeats — and a model that stutters for a while before the user
 *     copies it produces exactly this. Requiring 3+ repeats means the detector only fires after
 *     the damage is done, which is the opposite of useful.
 *
 * WHAT ACTUALLY SEPARATES THE TWO — measured on the sample:
 *
 *   lines: 10 non-empty, 4 distinct          -> distinct ratio 0.40
 *   mean line length: 8.8 chars              -> every line is a fragment, not a statement
 *   content: no code, no numbers, no paths   -> nothing an agent could act on
 *
 * Real work has a HIGH distinct-line ratio (a code block, a table, a report) and lines long
 * enough to carry information. A stutter has a LOW ratio and short lines. So the score is
 * `distinctRatio`, and it is only consulted once there are enough lines to be meaningful.
 *
 * This module is pure: no I/O, no clock, no model.
 */

/** Tunables, all measured against the live sample in test/repetition.test.mjs. */
export const DEFAULTS = {
  /** Lines needed before the ratio means anything. The live sample has 10. */
  minLines: 6,
  /** Distinct non-empty lines / non-empty lines, at or below which the output is a stutter. */
  maxDistinctRatio: 0.5,
  /** Mean characters per non-empty line, at or below which lines are fragments. */
  maxMeanLineChars: 40,
  /** A cycle must still appear this many times for the substring path to fire. */
  minRepeats: 2,
  /** Shortest cycle worth calling degenerate. Below this, `;;;` and `}}}` are normal code. */
  minCycleChars: 8,
  /** Longest cycle. A repeated 2000-char block is a template, not a stutter. */
  maxCycleChars: 400,
  /** Share of the whole output the cycle must account for. */
  minCoverage: 0.6,
  /** Do not judge until there is enough text to judge. */
  minChars: 60,
};

/** Split into non-empty trimmed lines. */
function linesOf(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Lines that carry no information on their own: markup tags, closing braces, separators.
 *
 * Measured false positive: a block of 30 `<div>` + 30 `</div>` has 2 distinct lines out of 61
 * (ratio 0.03) and a mean of 6 chars — it looks exactly like a stutter by the ratio test, and it
 * is perfectly normal markup. The difference is that those lines are STRUCTURE, not content: a
 * stutter repeats phrases that are meant to be read, and markup is not.
 *
 * So structural lines are excluded from the ratio. A file that is nothing but tags then has too
 * few content lines to judge, which is the honest answer — there is no stutter to detect there.
 */
const STRUCTURAL = [
  /^<\/?[a-zA-Z][\w:-]*(\s[^>]*)?\/?>$/,   // <div>, </div>, <br/>, <a href="...">
  /^[{}()[\];,]+$/,                        // }, ); ], ;
  /^[-=_*~#]{3,}$/,                        // --- === *** ~~~ ###
  /^\|?[\s:|-]+\|?$/,                      // table separator rows
];

function isStructural(line) {
  return STRUCTURAL.some((re) => re.test(line));
}

/** Content lines only: what a reader would actually read. */
function contentLinesOf(text) {
  return linesOf(text).filter((l) => !isStructural(l));
}

/**
 * @param {string} text - the output so far (text or reasoning deltas concatenated)
 * @param {object} [options] - overrides for DEFAULTS
 * @returns {{degenerate: boolean, reason: string, distinctRatio?: number, meanLineChars?: number, lines?: number, cycle?: string, repeats?: number, coverage?: number, chars: number}}
 */
export function detectRepetition(text, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const chars = typeof text === 'string' ? text.length : 0;
  if (chars < cfg.minChars) return { degenerate: false, reason: 'too-short', chars };

  const lines = contentLinesOf(text);
  if (lines.length < cfg.minLines) return { degenerate: false, reason: 'too-few-content-lines', chars, lines: lines.length };

  const distinct = new Set(lines);
  const distinctRatio = distinct.size / lines.length;
  const meanLineChars = lines.reduce((a, l) => a + l.length, 0) / lines.length;

  // Path 1 — the measured shape: few distinct short lines.
  if (distinctRatio <= cfg.maxDistinctRatio && meanLineChars <= cfg.maxMeanLineChars) {
    return {
      degenerate: true,
      reason: `${distinct.size} distinct lines out of ${lines.length} (ratio ${distinctRatio.toFixed(2)}), mean ${meanLineChars.toFixed(1)} chars/line`,
      distinctRatio,
      meanLineChars,
      lines: lines.length,
      chars,
    };
  }

  // Path 2 — a long cycle repeated inside otherwise-normal text. Kept because a model can also
  // stutter in the middle of a real answer, and the line shape alone would not catch that.
  const norm = text.replace(/\s+/g, ' ').trim();
  const n = norm.length;
  let best = null;
  const maxCycle = Math.min(cfg.maxCycleChars, Math.floor(n / cfg.minRepeats));
  for (let len = cfg.minCycleChars; len <= maxCycle; len++) {
    if (len * cfg.minRepeats > n) break;
    for (let start = 0; start + len * cfg.minRepeats <= n; start++) {
      const cycle = norm.slice(start, start + len);
      let repeats = 0;
      let at = start;
      while (at + len <= n && norm.startsWith(cycle, at)) { repeats++; at += len; }
      if (repeats < cfg.minRepeats) continue;
      const coverage = (len * repeats) / n;
      if (coverage < cfg.minCoverage) continue;
      if (best === null || coverage > best.coverage + 1e-9
        || (Math.abs(coverage - best.coverage) <= 1e-9 && len < best.cycle.length)) {
        best = { cycle, repeats, coverage, start };
      }
    }
  }
  if (best !== null) {
    return {
      degenerate: true,
      reason: `cycle of ${best.cycle.length} chars repeated ${best.repeats}x from offset ${best.start}, covering ${(best.coverage * 100).toFixed(0)}% of the output`,
      cycle: best.cycle,
      repeats: best.repeats,
      coverage: best.coverage,
      distinctRatio,
      meanLineChars,
      lines: lines.length,
      chars,
    };
  }

  return { degenerate: false, reason: 'no-degenerate-shape', distinctRatio, meanLineChars, lines: lines.length, chars };
}

/**
 * Incremental wrapper for a stream: push deltas, ask whether to abort.
 *
 * Re-checks at most every `checkEveryChars` characters, because running the scan on every token
 * would cost more than the tokens it saves.
 */
export class RepetitionGuard {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.text = '';
    this.lastCheck = 0;
    this.checkEveryChars = options.checkEveryChars ?? 120;
    this.verdict = null;
  }

  /** @param {string} delta @returns {{degenerate: boolean, reason: string}} */
  push(delta) {
    if (typeof delta !== 'string' || delta === '') return { degenerate: false, reason: 'empty' };
    this.text += delta;
    if (this.text.length - this.lastCheck < this.checkEveryChars) {
      return { degenerate: false, reason: 'not-due' };
    }
    this.lastCheck = this.text.length;
    this.verdict = detectRepetition(this.text, this.options);
    return this.verdict;
  }

  /** The text seen so far, for the caller to keep or discard. */
  get output() { return this.text; }
}
