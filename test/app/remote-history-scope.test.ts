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

function readyInspector(
  sessionId = 'session-a',
  cwd = '/repo/a',
  hooks: { open?: () => void; read?: () => void; dispose?: () => void } = {},
): {
  read(signal?: AbortSignal): Promise<{ kind: 'ready'; data: { sessionId: string; asOfSeq: number; effectiveCwd: string } }>
  dispose(): void
} {
  return {
    async read() {
      hooks.read?.()
      return { kind: 'ready', data: { sessionId, asOfSeq: 7, effectiveCwd: cwd } }
    },
    dispose() { hooks.dispose?.() },
  }
}

function workspacePort(
  handle: FollowHandle,
  inspector?: { read(signal?: AbortSignal): Promise<unknown>; dispose(): void } | null,
): SessionWorkspaceFactsPort {
  const base = {
    readActivity: async () => [],
    observeActivity: () => { throw new Error('not used') },
    followWorkspaces: () => handle,
    connectionGeneration: () => 'generation-1',
  }
  if (inspector === undefined) return { ...base, openInspector: () => readyInspector() } as unknown as SessionWorkspaceFactsPort
  if (inspector === null) return base as unknown as SessionWorkspaceFactsPort
  return { ...base, openInspector: () => inspector } as unknown as SessionWorkspaceFactsPort
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

test('the exact workingDirectory face is subscribed before the exact passive cut', async () => {
  const order: string[] = []
  let face: (() => void) | undefined
  let unsubscribed = 0
  let inspectorDisposed = 0
  const facts = activeFacts({
    subscribeWorkingDirectory: (_sessionId, listener) => {
      order.push('subscribe')
      face = listener
      return () => { unsubscribed += 1 }
    },
  })
  const inspector = readyInspector('session-a', '/repo/a', {
    open: () => order.push('open'),
    read: () => order.push('read'),
    dispose: () => { inspectorDisposed += 1 },
  })
  let opened: ((reason: 'changed' | 'source-replaced') => void) | undefined
  const port = {
    ...workspacePort(new FollowHandle(), inspector),
    openInspector: (id: string, onInvalidated: (reason: 'changed' | 'source-replaced') => void) => {
      order.push('open')
      opened = onInvalidated
      return inspector
    },
  } as unknown as SessionWorkspaceFactsPort
  const scope = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: facts,
    workspaceFacts: port,
    workspaceIntent: undefined,
    diag: DIAG,
  })
  await waitFor(() => scope.directory().available, 'the exact cut')
  assert.deepEqual(order, ['subscribe', 'open', 'read'])
  assert.equal(scope.directory().cwd, '/repo/a')
  face?.()
  assert.equal(scope.isCurrent(), false, 'a face publication permanently revokes the open')
  assert.equal(scope.directory().available, false)
  opened?.('source-replaced')
  scope.dispose()
  assert.equal(unsubscribed, 1)
  assert.equal(inspectorDisposed, 1)
})

test('an A→B→A face notification leaves the original A capture dead, never value-equal acceptance', async () => {
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
  await waitFor(() => scope.directory().available, 'the exact cut')
  assert.equal(scope.directory().cwd, '/repo/a')
  face?.()
  face?.()
  assert.equal(scope.isCurrent(), false)
  assert.equal(scope.directory().available, false)
  scope.dispose()
})

test('a stale transport token or a missing retained binding revokes the open', async () => {
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

  let live = true
  const midOpen = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts({ tokenCurrent: () => live }),
    workspaceFacts: workspacePort(new FollowHandle()),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  await waitFor(() => midOpen.directory().available, 'the exact cut')
  live = false
  assert.equal(midOpen.isCurrent(), false, 'a same-id transport replacement revokes the open')
  assert.equal(midOpen.directory().available, false)
  midOpen.dispose()

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

test('a missing or stale exact cut refuses Directory but keeps the Session/All open', async () => {
  const missing = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts(),
    workspaceFacts: workspacePort(new FollowHandle(), null),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  assert.equal(missing.directory().available, false)
  assert.equal(missing.directory().reason, 'directory-unavailable')
  assert.equal(missing.isCurrent(), true)
  missing.dispose()

  const stale = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts(),
    workspaceFacts: workspacePort(new FollowHandle(), {
      read: async () => ({ kind: 'unavailable' as const, message: 'stale' }),
      dispose: () => {},
    }),
    workspaceIntent: undefined,
    diag: DIAG,
  })
  await waitFor(() => stale.directory().available === false, 'the stale cut')
  assert.equal(stale.isCurrent(), true)
  stale.dispose()
})

test('an inspector invalidation revokes the captured authority', async () => {
  let invalidate: ((reason: 'changed' | 'source-replaced') => void) | undefined
  const port = {
    ...workspacePort(new FollowHandle()),
    openInspector: (_id: string, onInvalidated: (reason: 'changed' | 'source-replaced') => void) => {
      invalidate = onInvalidated
      return readyInspector()
    },
  } as unknown as SessionWorkspaceFactsPort
  const scope = createRemoteHistoryOpenScope({
    sessionId: 'session-a',
    isScopeCurrent: () => true,
    sessionFacts: activeFacts(),
    workspaceFacts: port,
    workspaceIntent: undefined,
    diag: DIAG,
  })
  await waitFor(() => scope.directory().available, 'the exact cut')
  invalidate?.('changed')
  assert.equal(scope.isCurrent(), true, 'a normal Inspector changed (running/stats) is not a cwd revocation')
  assert.equal(scope.directory().available, true)
  invalidate?.('source-replaced')
  assert.equal(scope.isCurrent(), false)
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

  const replaceHandle = new FollowHandle()
  const replaceIntent = createWorkspaceNextIntentOwner(undefined)
  replaceIntent.setResolvedWorkspace('workspace-a', '/repo/a')
  const replaced = createRemoteHistoryOpenScope({
    sessionId: undefined, isScopeCurrent: () => true, sessionFacts: undefined,
    workspaceFacts: workspacePort(replaceHandle), workspaceIntent: replaceIntent, diag: DIAG,
  })
  replaceHandle.push({ type: 'baseline', items: [WORKSPACE] })
  await waitFor(() => replaced.directory().available, 'replace baseline')
  replaceHandle.push({ type: 'replace', items: [{ ...WORKSPACE, path: '/repo/replaced' }] })
  await waitFor(() => !replaced.isCurrent(), 'replace path mutation')
  replaced.dispose()

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
