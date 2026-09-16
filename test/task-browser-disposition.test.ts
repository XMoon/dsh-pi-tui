/**
 * The Task Center row-selection disposition (plan §4.3/§4.4): the runner
 * delegates its close/keep-open decision to this pure mapping, so every
 * branch is asserted here — a subagent transcript REPLACES the browser, a
 * Job detail keeps it mounted, and an UNKNOWN row (a stale panel selection
 * after a live re-projection) must leave the parent usable.
 * @module @xmoon76/dsh-pi-tui/task-browser-disposition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { taskRowSelectionDisposition } from '../src/index.ts'

test('taskRowSelectionDisposition: a subagent transcript replaces the browser', () => {
  assert.equal(taskRowSelectionDisposition({ kind: 'subagent' }, 'keep-open'), 'close',
    'a subagent transcript is a session surface, never a child overlay')
})

test('taskRowSelectionDisposition: a Job detail keeps the browser mounted', () => {
  assert.equal(taskRowSelectionDisposition({ kind: 'job' }, 'keep-open'), 'keep-open',
    'a Job status detail is a child overlay of the browser')
  assert.equal(taskRowSelectionDisposition({ kind: 'job' }, 'close'), 'close',
    'a subagent-kind job that opens the child transcript replaces the browser')
})

test('taskRowSelectionDisposition: an unknown/stale row never dismisses the parent', () => {
  assert.equal(taskRowSelectionDisposition(undefined, 'keep-open'), 'keep-open',
    'a vanished/stale selection must leave the browser usable')
  assert.equal(taskRowSelectionDisposition(undefined, 'close'), 'keep-open',
    'the unknown row wins over the detail disposition')
})
