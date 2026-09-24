/**
 * Durable failure presentation: a turn-ending error must reach the user with
 * its message intact. This is the contract the preset-lifecycle hardening
 * relies on: DSH rc.1 persists a non-`LlmError` turn failure (including the
 * official agent-preset invariant violation) as `code: 'UNKNOWN'`, so a
 * user-visible row must render the MESSAGE and must NOT depend on a
 * `code === 'INVARIANT'` classification the Host does not produce.
 * @module @xmoon76/dsh-pi-tui/failure-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { displayFailure, displayFailureText } from '../src/failure-presentation.ts'

/** The exact shape DSH rc.1 persists for an invariant violation thrown out of
 * prompt assembly: a durable `UNKNOWN` code beside the thrown message. */
const INVARIANT_FAILURE = {
  code: 'UNKNOWN',
  message: 'invariant violated by "@deepseek-ai/dsh-agent-preset-registry": '
    + 'agent "session-1" addressed a model without joining any agent preset while a roster is composed; '
    + 'its tools, prompt sections, and skill catalog resolve against the empty global layer',
}

test('a UNKNOWN-coded invariant failure renders its message, not the code alone', () => {
  const text = displayFailureText(INVARIANT_FAILURE)
  assert.equal(text, `UNKNOWN: ${INVARIANT_FAILURE.message}`,
    'the message must survive verbatim; no INVARIANT re-classification exists on this side')
  assert.ok(text.includes('without joining any agent preset'), 'the failure reason must be visible to the user')
})

test('a message without a code renders bare, and a code without a message renders alone', () => {
  assert.equal(displayFailureText({ message: 'boom' }), 'boom')
  assert.equal(displayFailureText({ code: 'UNKNOWN' }), 'UNKNOWN')
  assert.equal(displayFailureText(undefined), 'error')
})

test('AUTH failures never leak provider text but keep their stable code', () => {
  assert.deepEqual(displayFailure({ code: 'AUTH', message: 'secret-provider-detail' }), { code: 'AUTH', message: '' })
  assert.equal(displayFailureText({ code: 'AUTH', message: 'secret-provider-detail' }), 'authentication failed')
})
