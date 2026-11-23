// The prompt and the audit must agree on the FORMAT, or the prompt can ask for the right
// thing in a shape the audit cannot see — and then "the prompt was fixed" and "the number
// did not move" are both true, with no way to tell which one is wrong.
//
// This is not hypothetical. Measured 2026-11-23: `noIntent` read 0% on the official half
// because the audit matched the SECTION HEADING `## Primary Request and Intent`, not a field.
// The audit now demands a labelled line and a score attached to the word. So the prompt must
// ask for exactly those shapes, and this test is what keeps the two in step.
//
// The assertions are the audit's own regexes, copied verbatim from
// `~/.dsh/_p0/audit-summary-quality.mjs`. If the audit changes, this test must change with it
// — that is the point: a silent divergence is the failure mode being prevented.
import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

const { ACP_SECTION } = __internals

// --- the audit's checks, verbatim -------------------------------------------------------
const AUDIT_SCORED = /(?:confidence|decay|證據強度|時效)\s*[:=]?\s*\(?\s*\d/i
const AUDIT_INTENT_FIELD = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:intent|目標|goal)(?:\*\*)?\s*[:：]/im

/**
 * A summary written the way ACP_SECTION tells the model to write one.
 *
 * Deliberately minimal: one `Intent:` line and one bullet carrying an inline score. If the
 * prompt's prescribed shape stops satisfying the audit, this fixture stops passing.
 */
const SUMMARY_IN_PRESCRIBED_FORM = [
  'Intent: make the ACP summary infer rather than enumerate',
  '- the audit read 63% enumerate, but the verb list was English-only (confidence 9)',
  '- the prompt now asks for a score inline on existing bullets (confidence 8)',
  '- the host still serves the old prompt until it reloads (confidence 5, decay 2)',
].join('\n')

test('a summary in the prescribed form satisfies the audit\'s intent check', () => {
  assert.match(SUMMARY_IN_PRESCRIBED_FORM, AUDIT_INTENT_FIELD)
})

test('a summary in the prescribed form satisfies the audit\'s confidence check', () => {
  assert.match(SUMMARY_IN_PRESCRIBED_FORM, AUDIT_SCORED)
})

test('the prompt asks for the exact label the audit looks for', () => {
  // The audit wants a line STARTING with the label followed by a separator. The prompt must
  // say "Intent:" (with the colon), not "an intent line" or "Intent -".
  assert.match(ACP_SECTION, /literally starting "Intent:"/)
})

test('the prompt asks for the score in the shape the audit can read', () => {
  // The audit needs the word followed by a number. The prompt's example must be one of those
  // shapes, so a model copying the example produces something the audit accepts.
  assert.match(ACP_SECTION, /\(confidence 1-10\)/)
  assert.match(ACP_SECTION, /\(confidence 7, decay 3\)/)
})

test('the prompt does NOT ask for a separate Confidence section', () => {
  // A "## Confidence" section would satisfy the audit's regex while making the summary longer
  // and no more evictable -- trading one failure for another. The prompt must forbid it.
  assert.match(ACP_SECTION, /Do NOT add a bullet per field/)
})

test('the prompt still forbids the enumeration shape the audit penalises', () => {
  // The audit's enumerate check is bullets/verbs > 3. The prompt must keep asking for dense
  // bullets that cover several actions, not one bullet per action.
  assert.match(ACP_SECTION, /dense bullets/)
})
