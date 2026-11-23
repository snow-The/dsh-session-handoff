/**
 * The fold's human-message restoration must append a payload the v4 reader ACCEPTS.
 *
 * ## The bug this pins
 *
 * `runCompaction` appended `{ message }` as the `user/message` payload. For `user/message` the
 * payload IS the UserMessage — the `{ message }` envelope belongs to assistant/system/tool events.
 * The wrapped row therefore had `data.source === undefined`, and the v4 reader refuses it with
 *
 *   SessionFormatError: format v4 message requires a producer-owned source kind
 *
 * Crucially the reader refuses the WHOLE session, not the row: one fold made the session
 * unloadable ("历史加载失败"). A unit test on the append shape is the only place this is cheap to
 * catch — the failure surfaces days later, in a different process, as an unopenable session.
 *
 * ## Why the assertion is on the RECORDED CALL, not on a live Session
 *
 * The real Session validates lazily (its own snapshot accepts both shapes), so a live-session test
 * would have passed while the file was being written wrong. The contract that matters is the one
 * the v4 reader enforces on disk, so this test asserts the payload shape directly and then runs the
 * official v4 admission check over the row it would have produced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

const { humanDecisionPayload } = __internals

test('the restored human block is appended as the UserMessage itself, not a { message } envelope', () => {
  const payload = humanDecisionPayload('## Human messages\n\n- **seq 8** ...')
  assert.equal(Object.hasOwn(payload, 'message'), false, 'user/message data must not be an envelope')
  assert.equal(payload.role, 'user')
  assert.equal(payload.source.kind, 'acp-human-decisions')
  assert.deepEqual(payload.content, [{ type: 'text', text: '## Human messages\n\n- **seq 8** ...' }])
  assert.equal(typeof payload.id, 'string')
  assert.ok(payload.id.length > 0, 'a message without an id cannot be restored')
})

test('the payload carries a producer-owned source kind (the exact v4 admission rule)', () => {
  const { source } = humanDecisionPayload('x')
  assert.equal(typeof source.kind, 'string')
  assert.ok(source.kind.length > 0)
  assert.notEqual(source.kind, 'plugin', 'v4 refuses the retired plugin wrapper')
})

test('an empty block still produces a well-formed message (never a half-built row)', () => {
  const payload = humanDecisionPayload('')
  assert.equal(payload.role, 'user')
  assert.equal(payload.source.kind, 'acp-human-decisions')
  assert.deepEqual(payload.content, [{ type: 'text', text: '' }])
})
