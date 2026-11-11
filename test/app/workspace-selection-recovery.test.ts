/**
 * The pure Workspace pre-selection recovery admission.
 *
 * The policy answers ONE question from ONE typed production input: may the
 * local UI guide the user to choose another Workspace after the Host rejected
 * a PRE-CREATE selection? It owns no IO and no state; the Browser, the next
 * intent and the Session transition stay with their existing owners.
 *
 * @module @xmoon76/dsh-pi-tui/workspace-selection-recovery.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverableWorkspaceSelection } from '../../src/app/session/workspace-selection-recovery.ts'
import { LifecycleError, WorkspaceSelectionError } from '../../src/runtime/session-lifecycle-port.ts'
import { cancellationError } from '../../src/runtime/process/tasks.ts'

test('every standard pre-create refusal code is navigable and keeps its official code', () => {
  for (const code of ['workspace/invalid-path', 'workspace/not-found', 'workspace/name-conflict']) {
    assert.deepEqual(
      recoverableWorkspaceSelection(new WorkspaceSelectionError('refused', 'the Host refused the Workspace', code)),
      { kind: 'select-workspace', reason: 'refused', code },
      `${code} must allow the user to choose another Workspace`,
    )
  }
})

test('a refusal without a Host code is navigable without inventing a reason', () => {
  assert.deepEqual(
    recoverableWorkspaceSelection(new WorkspaceSelectionError('refused', 'the Host refused the Workspace')),
    { kind: 'select-workspace', reason: 'refused' },
    'a code-less refusal still proves the user can choose another target',
  )
})

test('an unavailable or superseded selection never navigates', () => {
  for (const kind of ['unavailable', 'superseded'] as const) {
    assert.deepEqual(
      recoverableWorkspaceSelection(new WorkspaceSelectionError(kind, `the Host selection was ${kind}`)),
      { kind: 'none' },
      `${kind} is not a directory the user can fix`,
    )
  }
})

test('an unknown refused code is never widened into a recovery', () => {
  assert.deepEqual(
    recoverableWorkspaceSelection(new WorkspaceSelectionError('refused', 'the Host refused for another reason', 'workspace/quota')),
    { kind: 'none' },
    'a future official code needs its own contract before it can navigate',
  )
})

test('a post-create lifecycle failure, a plain error and a cancellation are never navigable', () => {
  const postCreate = new LifecycleError('published-with-error', 'current', 'published but the Workspace attach failed', 'session-1')
  const notPublished = new LifecycleError('rejected', 'current', 'the create was refused before publication')
  for (const error of [postCreate, notPublished, new Error('the Host refused the proposed workspace directory'), cancellationError('aborted')]) {
    assert.deepEqual(recoverableWorkspaceSelection(error), { kind: 'none' }, `${String(error)} must not navigate`)
  }
})
