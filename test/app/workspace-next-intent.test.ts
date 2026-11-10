import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceNextIntentOwner } from '../../src/app/session/workspace-next-intent.ts'

test('a failed initial Host path preflight is visible without changing the create proposal', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const create = owner.capture()
  owner.rejectCreateResolution(create, 'Host cannot use the launch directory')
  assert.deepEqual(owner.capture().intent, { kind: 'host-path', path: '/launch' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().displayPath, '/launch')
  assert.equal(owner.snapshot().error, 'Host cannot use the launch directory')
  assert.ok(owner.capture().isCurrent(), 'a retried first submission can resolve the same proposal again')
})
test('a verified Workspace intent remains a create proposal until the Host resolves it again', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/canonical')

  const capture = owner.capture()
  assert.deepEqual(capture.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().displayPath, '/host/canonical')

  const next = owner.capture()
  assert.deepEqual(next.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.ok(next.isCurrent())
})

test('path verification fences in-flight creates without replacing the last confirmed create intent', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const submit = owner.capture()
  const verification = owner.beginPathVerification('/client/new')

  assert.equal(submit.isCurrent(), true, 'starting a path check does not cancel an already admitted create')
  assert.deepEqual(verification.intent, { kind: 'host-path', path: '/client/new' }, 'Host resolution checks the new candidate')
  assert.deepEqual(owner.capture().intent, { kind: 'workspace-id', workspaceId: 'workspace-a' }, 'the active create target remains the last Host-confirmed Workspace')

  owner.rejectPathVerification(verification, 'unavailable on Host')
  assert.deepEqual(owner.capture().intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().displayPath, '/client/new')
})
test('a newer directory intent fences an older path verification and create settlement', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const verification = owner.beginPathVerification()
  const createdIntent = owner.capture()

  owner.setResolvedWorkspace('workspace-b', '/host/b')
  assert.equal(owner.commitVerifiedPath(verification, 'workspace-a', '/host/a'), undefined)
  owner.consumeAfterCommittedCreate(createdIntent)

  assert.deepEqual(owner.capture().intent, { kind: 'workspace-id', workspaceId: 'workspace-b' })
  assert.equal(owner.snapshot().displayPath, '/host/b')
})

test('a rejected path verification preserves the prior create intent and exposes its reason', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const verification = owner.beginPathVerification()
  owner.rejectPathVerification(verification, 'Directory unavailable on Host')

  assert.deepEqual(owner.capture().intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().error, 'Directory unavailable on Host')
})

test('committed create consumes only the captured intent and resets to the launch proposal', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const capture = owner.capture()

  owner.consumeAfterCommittedCreate(capture)

  assert.deepEqual(owner.capture().intent, { kind: 'host-path', path: '/launch' })
  assert.equal(owner.snapshot().status, 'proposed')
  assert.equal(owner.snapshot().displayPath, '/launch')
})

test('disposing the owner invalidates every capture', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const capture = owner.capture()
  owner.dispose()

  assert.equal(capture.isCurrent(), false)
})
