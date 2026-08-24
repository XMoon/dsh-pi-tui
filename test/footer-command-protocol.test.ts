/**
 * Headless tests for the footer command protocol (plan §17.5): the V1
 * JSON payload carries the safe StatusSnapshot projection — no secrets,
 * no live objects, no session events.
 * @module @xmoon76/dsh-pi-tui/footer-command-protocol.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommandInput } from '../src/footer/command-protocol.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

function mutableSnapshot(): DeepMutable<StatusSnapshot> {
  return emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
}

test('the V1 payload serializes the snapshot + geometry', () => {
  const snap = mutableSnapshot()
  snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  snap.interaction.focusMode = true
  const input = buildCommandInput(snap, 160, 45)
  assert.equal(input.schemaVersion, 1)
  assert.deepEqual(input.surface, { width: 160, height: 45, fullscreen: false, focusedSeat: 'editor' })
  assert.deepEqual(input.view, { subject: 'main' })
  assert.equal(input.composition.model?.id, 'flash')
  assert.equal(input.interaction.focusMode, true)
  // The payload is plain JSON (the command receives a string).
  const json = JSON.stringify(input)
  assert.ok(json.includes('"schemaVersion":1'))
  assert.ok(json.includes('"width":160'))
})

test('the subagent view maps to the subject string', () => {
  const snap = mutableSnapshot()
  snap.view.subject = { kind: 'subagent', id: 'c1', mode: 'one-shot' }
  const input = buildCommandInput(snap, 80, 24)
  assert.deepEqual(input.view, { subject: 'subagent' })
})

test('the payload never carries live objects or secrets', () => {
  const snap = emptyStatusSnapshot()
  const input = buildCommandInput(snap, 80, 24)
  const json = JSON.stringify(input)
  for (const forbidden of ['apiKey', 'credential', 'password', 'secret', 'sessionEvents']) {
    assert.ok(!json.toLowerCase().includes(forbidden.toLowerCase()), `forbidden field leaked: ${forbidden}`)
  }
})
