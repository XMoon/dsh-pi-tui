/**
 * Headless tests for the display subject resolution (plan §12.8/§12.11):
 * main, subagent one-shot, subagent continuable, and the viewer-close
 * return to main.
 * @module @xmoon76/dsh-pi-tui/status-subject.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDisplaySubject } from '../src/status/resolve-subject.ts'

test('subject: main when no viewer is open', () => {
  assert.deepEqual(resolveDisplaySubject(undefined), { subject: { kind: 'main' } })
})

test('subject: subagent one-shot carries the durable identity', () => {
  const view = resolveDisplaySubject({
    childSessionId: 'child-1',
    label: 'reviewer',
    mode: 'one-shot',
  })
  assert.deepEqual(view, {
    subject: { kind: 'subagent', id: 'child-1', label: 'reviewer', mode: 'one-shot' },
  })
})

test('subject: subagent continuable', () => {
  const view = resolveDisplaySubject({
    childSessionId: 'child-2',
    mode: 'continuable',
  })
  assert.deepEqual(view, {
    subject: { kind: 'subagent', id: 'child-2', mode: 'continuable' },
  })
})

test('subject: viewer close returns to main', () => {
  assert.deepEqual(resolveDisplaySubject(undefined), { subject: { kind: 'main' } })
})
