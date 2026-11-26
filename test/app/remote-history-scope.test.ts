/**
 * The per-open Remote History scope capture: the active Session's exact
 * workingDirectory face (subscribe before the passive read) and the
 * sessionless confirmed-Workspace follow baseline. These are structural
 * application cases; the real face/wire are proved by the E0 gate, the Remote
 * suite and the packed lane.
 *
 * @module @xmoon76/dsh-pi-tui/remote-history-scope.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteHistoryOpenScope } from '../../src/app/remote/history-scope.ts'
import { createWorkspaceNextIntentOwner } from '../../src/app/session/workspace-next-intent.ts'
import type { RemoteSessionFacts } from '../../src/app/remote/presentation-source.ts'
import type {
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
} from '../../src/runtime/session-workspace-facts-port.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class FollowHandle implements WorkspaceFactsHandle {
  readonly frames: WorkspaceFactsFrame[] = []
  private readonly waiters: Array<(frame: WorkspaceFactsFrame | undefined) => void> = []
  private done = false
  current = true
  disposed = 0
  attemptedGeneration(): unknown { return { id: 1 } }
  isCurrent(): boolean { return this.current }
  dispose(): void { this.disposed += 1 }
  push(frame: WorkspaceFactsFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.frames.push(frame)
  }
  end(): void {
    this.done = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
  [Symbol.asyncIterator](): AsyncIterator<WorkspaceFactsFrame> {
    return {
      next: async () => {
        if (this.frames.length > 0) return { done: false, value: this.frames.shift() as WorkspaceFactsFrame }
        if (this.done) return { done: true, value: undefined }
        const frame = await new Promise<WorkspaceFactsFrame | undefined>((resolve) => { this.waiters.push(resolve) })
        return frame === undefined ? { done: true, value: undefined } : { done: false, value: frame }
      },
    }
  }
}

const WORKSPACE = { workspaceId: 'workspace-a', path: '/repo/a', title: 'a', sessionIds: [] }

function workspacePort(handle: FollowHandle): SessionWorkspaceFactsPort {
  return {
    readActivity: async () => [],
    observeActivity: () => { throw new Error('not used') },
    followWorkspaces: () => handle,
  } as unknown as SessionWorkspaceFactsPort
}

function activeFacts(overrides: {
  subscribeWorkingDirectory?: (sessionId: string, listener: () => void) => (() => void) | undefined
  workingDirectory?: () => string | undefined
  tokenCurrent?: () => boolean
} = {}): RemoteSessionFacts {
  return {
    sessionStatus: () => ({ cwd: '/repo/a' }),
    plan: () => undefined,
    running: () => undefined,
    captureTransportToken: () => 'token',
    isTransportTokenCurrent: () => overrides.tokenCurrent?.() ?? true,
    mainViewRetained: () => true,
    windowRefoldProof: () => undefined,
    sessionStatsProjection: () => undefined,
    subscribeWorkingDirectory: overrides.subscribeWorkingDirectory ?? (() => () => {}),
    workingDirectory: overrides.workingDirectory ?? (() => '/repo/a'),
  } as unknown as RemoteSessionFacts
}

test('the exact workingDirectory face is subscribed before its passive value read', () => {
  const order: string[] = []
  let face: (() => void) | undefined
  let unsubscribed = 0
  const facts = activeFacts({
    subscribeWorkingDirectory: (_sessionId, listener) => {
      order.push('subscribe')
      face = listener
      return () => { unsubscribed += 1 }
    },
    workingDirectory: () => {
      order.push('read')
      return '/repo/a'
    },
  })
  const scope = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: facts,
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.deepEqual(order, ['subscribe', 'read'])
  assert.equal(scope.directory().available, true)
  assert.equal(scope.directory().cwd, '/repo/a')
  face?.()
  assert.equal(scope.isCurrent(), false, 'a face publication permanently revokes the open')
  assert.equal(scope.directory().available, false)
  scope.dispose()
  assert.equal(unsubscribed, 1)
})

test('an A→B→A face notification leaves the original A capture dead, never value-equal acceptance', () => {
  let face: (() => void) | undefined
  const facts = activeFacts({
    subscribeWorkingDirectory: (_sessionId, listener) => {
      face = listener
      return () => {}
    },
  })
  const scope = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: facts,
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.equal(scope.directory().available, true)
  assert.equal(scope.directory().cwd, '/repo/a')
  face?.()
  face?.()
  assert.equal(scope.isCurrent(), false)
  assert.equal(scope.directory().available, false)
  scope.dispose()
})

test('a stale transport token or a missing retained binding revokes the open', () => {
  const stale = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts({ tokenCurrent: () => false }),
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.equal(stale.isCurrent(), false)
  assert.equal(stale.directory().available, false)
  stale.dispose()

  const unretained = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts({ subscribeWorkingDirectory: () => undefined }),
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.equal(unretained.directory().available, false)
  assert.equal(unretained.directory().reason, 'session-not-retained')
  unretained.dispose()
})

test('the official Session status supplies the same effective cwd when the face has not materialized', () => {
  const scope = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts({ workingDirectory: () => undefined }),
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.equal(scope.directory().available, true)
  assert.equal(scope.directory().cwd, '/repo/a')
  scope.dispose()
})

test('a sessionless capture follows the confirmed Workspace and revokes on intent, path, removal or stream end', async () => {
  const intent = createWorkspaceNextIntentOwner(undefined)
  intent.setResolvedWorkspace('workspace-a', '/repo/a')
  const handle = new FollowHandle()
  const scope = createRemoteHistoryOpenScope({
    sessionId: undefined,
    isScopeCurrent: () => true,
    sessionFacts: undefined,
    workspaceFacts: workspacePort(handle),
    workspaceIntent: intent,
    diag: DIAG,
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  handle.push({ type: 'baseline', items: [WORKSPACE] })
  await waitFor(() => scope.directory().available, 'workspace baseline')
  assert.equal(scope.directory().cwd, '/repo/a')
  assert.equal(scope.isCurrent(), true)

  handle.push({ type: 'upsert', workspace: { ...WORKSPACE } })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(scope.isCurrent(), true, 'the same id and path is not a revocation')
  handle.push({ type: 'upsert', workspace: { ...WORKSPACE, path: '/repo/changed' } })
  await waitFor(() => !scope.isCurrent(), 'path change')
  assert.equal(scope.directory().available, false)
  scope.dispose()

  const removalHandle = new FollowHandle()
  const removalIntent = createWorkspaceNextIntentOwner(undefined)
  removalIntent.setResolvedWorkspace('workspace-a', '/repo/a')
  const removal = createRemoteHistoryOpenScope({
    sessionId: undefined, isScopeCurrent: () => true, sessionFacts: undefined,
    workspaceFacts: workspacePort(removalHandle), workspaceIntent: removalIntent, diag: DIAG,
  })
  removalHandle.push({ type: 'baseline', items: [WORKSPACE] })
  await waitFor(() => removal.directory().available, 'removal baseline')
  removalHandle.push({ type: 'remove', workspaceId: 'workspace-a' })
  await waitFor(() => !removal.isCurrent(), 'removal revocation')
  removal.dispose()

  const endHandle = new FollowHandle()
  const endIntent = createWorkspaceNextIntentOwner(undefined)
  endIntent.setResolvedWorkspace('workspace-a', '/repo/a')
  const ended = createRemoteHistoryOpenScope({
    sessionId: undefined, isScopeCurrent: () => true, sessionFacts: undefined,
    workspaceFacts: workspacePort(endHandle), workspaceIntent: endIntent, diag: DIAG,
  })
  endHandle.push({ type: 'baseline', items: [WORKSPACE] })
  await waitFor(() => ended.directory().available, 'end baseline')
  endHandle.end()
  await waitFor(() => !ended.isCurrent(), 'stream end revocation')
  ended.dispose()

  const revisionIntent = createWorkspaceNextIntentOwner(undefined)
  revisionIntent.setResolvedWorkspace('workspace-a', '/repo/a')
  const revisionScope = createRemoteHistoryOpenScope({
    sessionId: undefined, isScopeCurrent: () => true, sessionFacts: undefined,
    workspaceFacts: workspacePort(new FollowHandle()), workspaceIntent: revisionIntent, diag: DIAG,
  })
  revisionIntent.setResolvedWorkspace('workspace-a', '/repo/a')
  assert.equal(revisionScope.isCurrent(), false, 'even a same-id revision change revokes the captured intent')
  revisionScope.dispose()
  intent.dispose()
})
