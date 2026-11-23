// hoistIntent: move the intent the official summarizer already wrote to the first line.
//
// The claim being tested is narrow and checkable: this function MOVES text, it does not
// invent it. So every test asserts either (a) the hoisted line is a substring of the input,
// or (b) the input is returned unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

const { hoistIntent } = __internals

const OFFICIAL = [
  '## Primary Request and Intent',
  '- inventory duplicate plugins on this machine',
  '- absorb hindsight into a DSH plugin',
  '',
  '## Key Technical Concepts',
  '- cordis, schemastery',
].join('\n')

test('the intent section becomes the first line', () => {
  const out = hoistIntent(OFFICIAL)
  assert.match(out.split('\n')[0], /^Intent: /)
})

test('the hoisted line is text that was already in the summary, not new text', () => {
  const out = hoistIntent(OFFICIAL)
  const first = out.split('\n')[0].replace(/^Intent:\s*/, '')
  assert.ok(OFFICIAL.includes(first), `"${first}" is not a substring of the input`)
})

test('the original section is kept, so nothing is lost', () => {
  const out = hoistIntent(OFFICIAL)
  assert.match(out, /## Primary Request and Intent/)
  assert.match(out, /absorb hindsight into a DSH plugin/)
})

test('an empty section is NOT turned into an empty Intent line', () => {
  const empty = '## Primary Request and Intent\n(none)\n\n## Current Work\n- x'
  assert.equal(hoistIntent(empty), empty)
})

test('a summary with no intent section is returned unchanged', () => {
  const none = '## Current Work\n- x\n\n## Next Step\n- y'
  assert.equal(hoistIntent(none), none)
})

test('an already-hoisted summary is not hoisted twice', () => {
  const once = hoistIntent(OFFICIAL)
  assert.equal(hoistIntent(once), once)
})

test('non-string input is returned as-is (the hook must never throw)', () => {
  assert.equal(hoistIntent(null), null)
  assert.equal(hoistIntent(undefined), undefined)
  assert.equal(hoistIntent(''), '')
})

test('the hoisted summary passes the audit\'s intent check', () => {
  // The audit's own pattern, verbatim.
  const AUDIT_INTENT_FIELD = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:intent|目標|goal)(?:\*\*)?\s*[:：]/im
  assert.match(hoistIntent(OFFICIAL), AUDIT_INTENT_FIELD)
})
