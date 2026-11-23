// The ACP summary contract is a PROMPT, so nothing else can pin it: a prompt that silently
// loses a field keeps every test green while the audit that measures summary quality
// (noConfidence 474/510 = 93%, noIntent 247/510 = 48%) stays red forever.
//
// These tests assert the two things the audit checks for, in the exact spelling the audit
// looks for. If someone rewrites the wording, the audit's regexes are the contract, not this
// file's prose -- so the assertions are on the audit's own patterns.
import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

const { ACP_SECTION } = __internals

// The audit's checkNoConfidence: /confidence|decay|證據強度|時效/i
const AUDIT_CONFIDENCE = /confidence|decay|證據強度|時效/i
// The audit's checkNoIntent: /(?:目標|intent|goal|在做什麼|目的)/i
const AUDIT_INTENT = /(?:目標|intent|goal|在做什麼|目的)/i

test('the ACP prompt asks for confidence, in the spelling the audit checks', () => {
  assert.match(ACP_SECTION, AUDIT_CONFIDENCE)
})

test('the ACP prompt asks for intent, in the spelling the audit checks', () => {
  assert.match(ACP_SECTION, AUDIT_INTENT)
})

test('confidence is asked for INLINE on existing bullets, not as a new section', () => {
  // The failure mode this guards: adding a "## Confidence" section satisfies the audit's
  // regex while making the summary longer and no more evictable. The prompt must say the
  // score rides on bullets that already exist.
  assert.match(ACP_SECTION, /inline/i)
  assert.match(ACP_SECTION, /Do NOT add a bullet per field/i)
})

test('intent is asked for as the FIRST line, not as one more bullet among many', () => {
  assert.match(ACP_SECTION, /FIRST line/i)
  assert.match(ACP_SECTION, /Intent:/)
})

test('the prompt still carries the pre-existing rules it had before the two fields', () => {
  // A prompt edit that drops a rule is a regression the two new assertions cannot see.
  assert.match(ACP_SECTION, /## Recoverable/)
  assert.match(ACP_SECTION, /lost: <none \| what>/)
  assert.match(ACP_SECTION, /acp_decompress returns the original hidden text/)
})
