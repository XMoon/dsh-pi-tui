import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceNextIntentOwner } from '../../src/app/session/workspace-next-intent.ts'

test('an unselected owner has NO capture and no Host-resolvable intent', () => {
  const owner = createWorkspaceNextIntentOwner(undefined)
  assert.equal(owner.capture(), undefined, 'unselected never fabricates a Host request')
  const snapshot = owner.snapshot()
  assert.equal(snapshot.status, 'unselected')
  assert.equal(snapshot.intent, undefined)
  assert.equal(snapshot.workspaceId, undefined)
  assert.equal(snapshot.provenance, undefined)
})

test('a failed initial Host path preflight is visible without changing the create proposal', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const create = owner.capture()
  assert.ok(create !== undefined)
  owner.rejectCreateResolution(create, 'Host cannot use the launch directory')
  assert.deepEqual(owner.capture()?.intent, { kind: 'host-path', path: '/launch' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().displayPath, '/launch')
  assert.equal(owner.snapshot().error, 'Host cannot use the launch directory')
  assert.ok(owner.capture()?.isCurrent(), 'a retried first submission can resolve the same proposal again')
})

test('a verified Workspace intent remains a create proposal until the Host resolves it again', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/canonical')

  const capture = owner.capture()
  assert.deepEqual(capture?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().displayPath, '/host/canonical')
  assert.equal(owner.snapshot().provenance, 'manual', 'a picker choice is an explicit user decision')

  const next = owner.capture()
  assert.deepEqual(next?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.ok(next?.isCurrent())
})

test('path verification fences in-flight creates without replacing the last confirmed create intent', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const submit = owner.capture()
  const verification = owner.beginPathVerification('/client/new')

  assert.equal(submit?.isCurrent(), true, 'starting a path check does not cancel an already admitted create')
  assert.deepEqual(verification.intent, { kind: 'host-path', path: '/client/new' }, 'Host resolution checks the new candidate')
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' }, 'the active create target remains the last Host-confirmed Workspace')

  owner.rejectPathVerification(verification, 'unavailable on Host')
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().displayPath, '/client/new')
})

test('a newer directory intent fences an older path verification and create settlement', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const verification = owner.beginPathVerification()
  const createdIntent = owner.capture()
  assert.ok(createdIntent !== undefined)

  owner.setResolvedWorkspace('workspace-b', '/host/b')
  assert.equal(owner.commitVerifiedPath(verification, 'workspace-a', '/host/a'), undefined)
  owner.consumeAfterCommittedCreate(createdIntent)

  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-b' })
  assert.equal(owner.snapshot().displayPath, '/host/b')
})

test('a rejected path verification preserves the prior create intent and exposes its reason', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const verification = owner.beginPathVerification()
  owner.rejectPathVerification(verification, 'Directory unavailable on Host')

  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.equal(owner.snapshot().status, 'rejected')
  assert.equal(owner.snapshot().error, 'Directory unavailable on Host')
})

test('a committed launch-cwd create resets to the launch proposal', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const capture = owner.capture()
  assert.ok(capture !== undefined)

  owner.consumeAfterCommittedCreate(capture)

  assert.deepEqual(owner.capture()?.intent, { kind: 'host-path', path: '/launch' })
  assert.equal(owner.snapshot().status, 'proposed')
  assert.equal(owner.snapshot().displayPath, '/launch')
  assert.equal(owner.snapshot().provenance, 'launch')
})

test('a committed create keeps an explicit user Workspace selection (no silent cwd reset)', () => {
  const owner = createWorkspaceNextIntentOwner(undefined)
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const capture = owner.capture()
  assert.ok(capture !== undefined)

  owner.consumeAfterCommittedCreate(capture)

  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' },
    'the explicit choice persists across the Client next sessionless create')
  assert.equal(owner.snapshot().status, 'confirmed')
  assert.equal(owner.snapshot().provenance, 'manual')
})

test('a committed create consumes the ONE-SHOT auto proposal back to unselected', () => {
  const owner = createWorkspaceNextIntentOwner('/client/cwd', 'auto')
  const verification = owner.beginPathVerification()
  assert.equal(owner.snapshot().provenance, 'auto', 'verifying the current proposal preserves its provenance')
  const committed = owner.commitVerifiedPath(verification, 'workspace-auto', '/host/cwd')
  assert.ok(committed !== undefined)

  owner.consumeAfterCommittedCreate(committed)

  assert.equal(owner.capture(), undefined, 'the one-shot auto adoption never becomes an assumed selection')
  assert.equal(owner.snapshot().status, 'unselected')
})

test('a one-shot auto candidate can be released back to unselected without a Host call', () => {
  const owner = createWorkspaceNextIntentOwner('/client/cwd', 'auto')
  owner.resetToLaunchCwd()
  assert.equal(owner.capture(), undefined)
  assert.equal(owner.snapshot().status, 'unselected')
})

test('the revision is monotonic across A→B→A so a stale A answer is distinguishable', () => {
  const owner = createWorkspaceNextIntentOwner(undefined)
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const firstA = owner.capture()
  assert.ok(firstA !== undefined)
  owner.setResolvedWorkspace('workspace-b', '/host/b')
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  const secondA = owner.capture()
  assert.ok(secondA !== undefined)

  assert.equal(firstA.intent.kind, secondA.intent.kind)
  assert.ok(secondA.revision > firstA.revision, 'the same WorkspaceId returns under a newer revision')
  assert.equal(firstA.isCurrent(), false, 'the first A capture is fenced')
  assert.equal(secondA.isCurrent(), true)
})

test('a subscription observes committed intent changes, including same-revision verification states', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const seen: Array<{ status: string; revision: number; workspaceId?: string }> = []
  const seenIds: string[] = []
  const unsubscribe = owner.subscribe((snapshot) => {
    seen.push({ status: snapshot.status, revision: snapshot.revision, ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }) })
    seenIds.push(`${snapshot.status}:${String(snapshot.revision)}`)
  })
  assert.equal(seen.length, 0, 'the initial subscription is silent; the caller reads snapshot() itself')

  owner.setResolvedWorkspace('workspace-a', '/host/a')
  assert.deepEqual(seen.at(-1), { status: 'confirmed', revision: 1, workspaceId: 'workspace-a' })

  const verification = owner.beginPathVerification('/client/candidate')
  assert.deepEqual(seen.at(-1), { status: 'verifying', revision: 1, workspaceId: 'workspace-a' },
    'the same revision still publishes the transient verification state')
  assert.equal(owner.capture()?.isCurrent(), true, 'starting a verification does not replace the confirmed create target')

  owner.rejectPathVerification(verification, 'candidate rejected')
  assert.deepEqual(seen.at(-1), { status: 'rejected', revision: 1, workspaceId: 'workspace-a' })
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })

  const beforeReset = seen.length
  owner.resetToLaunchCwd()
  assert.ok(seen.length > beforeReset, 'a real reset publishes its new proposal')
  assert.equal(seen.at(-1)?.status, 'proposed')
  assert.equal(seen.at(-1)?.revision, 2)
  assert.deepEqual(seenIds, [...new Set(seenIds)], 'each committed transition is published once')

  unsubscribe()
  const afterUnsubscribe = seen.length
  owner.setResolvedWorkspace('workspace-b', '/host/b')
  assert.equal(seen.length, afterUnsubscribe, 'an unsubscribed listener receives nothing')
})

test('a listener that unsubscribes during publication does not stop the remaining listeners', () => {
  const owner = createWorkspaceNextIntentOwner(undefined)
  let first = 0
  let second = 0
  const offFirst = owner.subscribe(() => {
    first += 1
    offFirst()
  })
  owner.subscribe(() => { second += 1 })
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  assert.equal(first, 1)
  assert.equal(second, 1)
})

test('disposing the owner invalidates every capture', () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const capture = owner.capture()
  assert.ok(capture !== undefined)
  owner.dispose()

  assert.equal(capture.isCurrent(), false)
})
