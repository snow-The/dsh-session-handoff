/**
 * repetition.js — detect a KNOWN degenerate stutter, not "degenerate text" in general.
 *
 * THE FAILURE (observed live 2026-11-21, deepseek-v4.1-flash):
 *
 *   OK. / Let me write. / Let me go. / Writing. / Let me go.
 *   OK. / Let me write. / Let me go. / Writing. / Let me go.
 *
 * WHY THIS IS A KNOWN-PATTERN MATCHER AND NOT A HEURISTIC
 *
 * Two general detectors were written first and both were wrong, measured against this sample:
 *
 *   - "the same substring appears twice" fires on real work: repeated statements, closing tags,
 *     markdown rules, base64.
 *   - "a cycle repeats N times" MISSES the sample: 97 normalised chars with a 49-char cycle is
 *     1.98 repeats, and requiring 3+ means it only fires after the damage is done.
 *
 * A third attempt scored "distinct lines / total lines" and needed a structural-line exclusion
 * list to stop firing on `<div>` blocks — i.e. it was a general text classifier with a growing
 * list of exceptions. That is the wrong shape for this problem: the operator's instruction is
 * explicit — catch THIS format, because it is what deepseek-v4.1-flash does, and the next model
 * version will do something else.
 *
 * So the rule is narrow and literal: the output is degenerate when EVERY non-empty line is one of
 * a small set of known filler phrases, repeated. Real work always contains at least one line that
 * is not in that set, so it cannot false-positive. A new model version adds its own phrases to
 * KNOWN_STUTTERS instead of loosening the algorithm.
 *
 * This module is pure: no I/O, no clock, no model.
 */

/**
 * Known stutter phrase sets, keyed by the model that produces them.
 *
 * Adding an entry is the supported way to cover a new model. Do not widen the matching rule.
 */
export const KNOWN_STUTTERS = {
  'deepseek-v4.1-flash': ['OK.', 'Let me write.', 'Let me go.', 'Writing.'],
};

/** Tunables. */
export const DEFAULTS = {
  /** Which phrase set to match. Defaults to the model this was measured on. */
  model: 'deepseek-v4.1-flash',
  /** Extra phrases, for a model whose set is not in KNOWN_STUTTERS yet. */
  phrases: null,
  /** Lines needed before the verdict means anything. The live sample has 10. */
  minLines: 4,
  /** Share of non-empty lines that must be known phrases. 1 = every single one. */
  minPhraseShare: 1,
};

/** Non-empty trimmed lines. */
function linesOf(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Normalise a phrase for comparison: collapse whitespace, case-insensitive, ignore trailing punctuation runs. */
function normPhrase(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @param {string} text - the output so far (text or reasoning deltas concatenated)
 * @param {object} [options] - overrides for DEFAULTS
 * @returns {{degenerate: boolean, reason: string, matched?: number, lines?: number, phrases?: string[], chars: number}}
 */
export function detectRepetition(text, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const chars = typeof text === 'string' ? text.length : 0;

  const known = cfg.phrases ?? KNOWN_STUTTERS[cfg.model];
  if (!Array.isArray(known) || known.length === 0) {
    return { degenerate: false, reason: `no known phrase set for model "${cfg.model}"`, chars };
  }
  const set = new Set(known.map(normPhrase));

  const lines = linesOf(text);
  if (lines.length < cfg.minLines) {
    return { degenerate: false, reason: 'too-few-lines', chars, lines: lines.length };
  }

  const matched = lines.filter((l) => set.has(normPhrase(l))).length;
  const share = matched / lines.length;
  if (share < cfg.minPhraseShare) {
    return {
      degenerate: false,
      reason: `${matched}/${lines.length} lines are known phrases (share ${share.toFixed(2)} < ${cfg.minPhraseShare})`,
      matched,
      lines: lines.length,
      chars,
    };
  }

  return {
    degenerate: true,
    reason: `all ${lines.length} lines are known ${cfg.model} stutter phrases (${matched} matched)`,
    matched,
    lines: lines.length,
    phrases: known,
    chars,
  };
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
