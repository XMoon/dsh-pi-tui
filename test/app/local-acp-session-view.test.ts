/**
 * Owner-semantics contracts for the connection-scoped Host ACP Session View.
 *
 * These tests drive the PURE `AcpSessionViewRegistry` against a fake
 * {@link HostAcpSessionAccess}, so they prove the reservation/claim lifecycle,
 * the exact live Agent/Session identity fence, two-connection conflict, close
 * idempotence, physical-teardown release, cold/live dispatch through the single
 * `resolveAgent` owner, and the post-dispatch-unknown classification WITHOUT
 * copying any DSH Agent scheduling. The real Host composition, real socket and
 * real Agent identity are covered by `test/app/local-acp-listener.test.ts` and
 * the `acp.po2-session-view` split smoke.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-session-view.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  AcpSessionViewRegistry,
  LocalAcpViewError,
  type AcpCreateSessionOutcome,
  type AcpCreateWorkspaceOutcome,
  type AcpImageLimits,
  type AcpPromptFactListener,
  type AcpSessionPromptRequest,
  type AcpStoredImage,
  type AcpStoredImageRef,
  type HostAcpSessionAccess,
  type LiveAgentViewIdentity,
} from '../../src/app/remote-process/local-acp-session-view.ts'
import { createHostAcpSessionAccess } from '../../src/app/remote-process/local-host-entry.ts'

const QUIET_DIAG: Diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  dispose: () => {},
}

interface AgentLike extends LiveAgentViewIdentity {
  readonly session: { readonly id: string; readonly header: { readonly cwd: string } }
}

function makeAgent(id: string, cwd: string): AgentLike {
  return { id, session: { id, header: { cwd } } }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class FakeAccess implements HostAcpSessionAccess {
  readonly createWorkspaceCalls: string[] = []
  readonly createSessionCalls: string[] = []
  readonly resolveCalls: string[] = []
  readonly promptCalls: AcpSessionPromptRequest[] = []
  readonly removedMessageIds: string[] = []
  readonly cancelledTurns: Array<{ readonly turn: number; readonly keepInbox: boolean }> = []
  /** The fake inbox: messageIds still pending on the exact agent. */
  pendingInbox = new Set<string>()
  /** The fake official current-turn fence of the exact agent. */
  turnFence: { openTurnStartSeq: number | null; lastTurn: number } | 'stale' = { openTurnStartSeq: null, lastTurn: 0 }
  agentStatus: 'idle' | 'running' = 'idle'
  createWorkspaceImpl: (path: string) => Promise<AcpCreateWorkspaceOutcome> =
    async path => ({ kind: 'created', workspaceId: `ws:${path}`, path })
  createSessionImpl: (workspaceId: string) => Promise<AcpCreateSessionOutcome> =
    async () => ({ kind: 'indeterminate', code: 'createSession unconfigured' })
  resolveAgentImpl: (sessionId: string) => Promise<
    { agent: LiveAgentViewIdentity } | { error: { code: string; message: string } }
  > = async sessionId => {
    const agent = this.agents.get(sessionId)
    return agent === undefined
      ? { error: { code: 'session/not-found', message: 'not found' } }
      : { agent }
  }

  promptImpl: (request: AcpSessionPromptRequest, signal: AbortSignal) => Promise<{ readonly accepted: true }> =
    async () => ({ accepted: true })

  cancelPendingImpl: (messageId: string) => 'removed' | 'not-pending' | 'stale' =
    messageId => {
      if (this.turnFence === 'stale') return 'stale'
      if (!this.pendingInbox.has(messageId)) return 'not-pending'
      this.pendingInbox.delete(messageId)
      this.removedMessageIds.push(messageId)
      return 'removed'
    }

  cancelCurrentTurnImpl: (turn: number) => 'addressed' | 'not-current' | 'stale' =
    turn => {
      if (this.turnFence === 'stale') return 'stale'
      if (this.turnFence.openTurnStartSeq === null || this.turnFence.lastTurn !== turn) return 'not-current'
      if (this.agentStatus !== 'running') return 'not-current'
      this.cancelledTurns.push({ turn, keepInbox: true })
      this.agentStatus = 'idle'
      this.turnFence = { openTurnStartSeq: null, lastTurn: this.turnFence.lastTurn }
      return 'addressed'
    }

  private readonly agents = new Map<string, AgentLike>()

  seed(agent: AgentLike): void { this.agents.set(agent.id, agent) }
  remove(id: string): void { this.agents.delete(id) }

  async createWorkspace(path: string): Promise<AcpCreateWorkspaceOutcome> {
    this.createWorkspaceCalls.push(path)
    return this.createWorkspaceImpl(path)
  }

  async createSession(workspaceId: string): Promise<AcpCreateSessionOutcome> {
    this.createSessionCalls.push(workspaceId)
    return this.createSessionImpl(workspaceId)
  }

  async resolveAgent(sessionId: string): Promise<
    { agent: LiveAgentViewIdentity } | { error: { code: string; message: string } }
  > {
    this.resolveCalls.push(sessionId)
    return this.resolveAgentImpl(sessionId)
  }

  currentAgent(sessionId: string): LiveAgentViewIdentity | undefined {
    return this.agents.get(sessionId)
  }

  currentSession(sessionId: string): object | undefined {
    return this.agents.get(sessionId)?.session
  }

  async prompt(request: AcpSessionPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }> {
    this.promptCalls.push(request)
    return await this.promptImpl(request, signal)
  }

  pendingMessage(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string):
    'pending' | 'absent' | 'stale' {
    if (this.agents.get(sessionId) !== agent || this.agents.get(sessionId)?.session !== session || agent.session !== session) return 'stale'
    return this.pendingInbox.has(messageId) ? 'pending' : 'absent'
  }

  cancelPending(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string):
    'removed' | 'not-pending' | 'stale' {
    if (this.agents.get(sessionId) !== agent || this.agents.get(sessionId)?.session !== session) return 'stale'
    return this.cancelPendingImpl(messageId)
  }

  cancelCurrentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object, turn: number):
    'addressed' | 'not-current' | 'stale' {
    if (this.agents.get(sessionId) !== agent || this.agents.get(sessionId)?.session !== session) return 'stale'
    return this.cancelCurrentTurnImpl(turn)
  }

  currentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object):
    { readonly kind: 'current'; readonly openTurn: number | null } | { readonly kind: 'stale' } {
    if (this.agents.get(sessionId) !== agent || this.agents.get(sessionId)?.session !== session) return { kind: 'stale' }
    if (this.turnFence === 'stale') return { kind: 'stale' }
    return { kind: 'current', openTurn: this.turnFence.openTurnStartSeq === null ? null : this.turnFence.lastTurn }
  }

  imageLimits(): AcpImageLimits | undefined { return { maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 8, mediaTypes: ['image/png'] } }
  supportsImagePrompts(): Promise<boolean> { return Promise.resolve(false) }

  /** The fake official Store objects this fake can verify, keyed by attachmentId. */
  readonly storedImages = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  /** Every committed image reference the View asked the Store to read. */
  readonly imageReadCalls: AcpStoredImageRef[] = []
  /** One held/scripted Store read; the default verifies a known object. */
  imageReadImpl: (ref: AcpStoredImageRef, signal: AbortSignal) => Promise<AcpStoredImage> =
    async ref => {
      const stored = this.storedImages.get(ref.attachmentId)
      if (stored === undefined) throw new Error('attachment not found')
      return { data: stored.bytes, mediaType: stored.mediaType }
    }

  async readOutputImage(ref: AcpStoredImageRef, signal: AbortSignal): Promise<AcpStoredImage> {
    this.imageReadCalls.push(ref)
    return await this.imageReadImpl(ref, signal)
  }

  observePromptFacts(_listener: AcpPromptFactListener): () => void {
    return () => {}
  }
}

function isViewError(code: string): (error: unknown) => boolean {
  return error => error instanceof LocalAcpViewError && error.code === code
}

const NEW = { cwd: '/work/a', mcpServers: [] as unknown[] }

test('session/new creates one workspace then one session and attaches the exact live identity', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S1', '/work/a')
  access.createSessionImpl = async () => { access.seed(agent); return { kind: 'created', sessionId: 'S1' } }
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const result = await registry.newSession(conn, access, NEW)

  assert.deepEqual(result, { sessionId: 'S1' })
  assert.deepEqual(access.createWorkspaceCalls, ['/work/a'])
  assert.deepEqual(access.createSessionCalls, ['ws:/work/a'])
  assert.deepEqual(access.resolveCalls, ['S1'])
  assert.equal(registry.claimCount(), 1)
  assert.equal(registry.hasClaim('S1'), true)
  assert.equal(registry.phaseOf(conn), 'attached')
})

test('session/new runs the create exactly once even when the post-dispatch result is unconfirmed', async () => {
  const access = new FakeAccess()
  access.createSessionImpl = async () => ({ kind: 'indeterminate', code: 'session/internal' })
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  await assert.rejects(registry.newSession(conn, access, NEW), isViewError('LOCAL_ACP_VIEW_CREATE_INDETERMINATE'))
  assert.equal(access.createSessionCalls.length, 1, 'session/new must never retry the Host create')
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('session/new rejects an invalid cwd and an unsupported MCP server before any Host create', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  await assert.rejects(
    registry.newSession(conn, access, { cwd: 'relative/dir', mcpServers: [] }),
    isViewError('LOCAL_ACP_VIEW_INVALID_REQUEST'),
  )
  await assert.rejects(
    registry.newSession(conn, access, { cwd: '/ok', mcpServers: [{ type: 'stdio' }] }),
    isViewError('LOCAL_ACP_VIEW_INVALID_REQUEST'),
  )
  assert.deepEqual(access.createWorkspaceCalls, [], 'an invalid request must not reach the Host workspace')
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('session/new reports an unconfirmed workspace outcome instead of a client directory error', async () => {
  const access = new FakeAccess()
  // The official Workspace Controller wraps persistence failures as
  // `workspace/invalid-path` too, so the Host cannot prove "not created".
  access.createWorkspaceImpl = async () => ({ kind: 'indeterminate', code: 'workspace/invalid-path' })
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  await assert.rejects(registry.newSession(conn, access, NEW), isViewError('LOCAL_ACP_VIEW_WORKSPACE_UNAVAILABLE'))
  assert.equal(access.createSessionCalls.length, 0, 'an unconfirmed workspace must not create a session')
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('session/resume borrows the SAME live Agent object and returns an empty object', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S2', '/work/b')
  access.seed(agent)
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const result = await registry.resumeSession(conn, access, { sessionId: 'S2', cwd: '/work/b' })

  assert.deepEqual(result, {})
  assert.deepEqual(access.resolveCalls, ['S2'])
  assert.equal(access.createSessionCalls.length, 0, 'resume must never create a session')
  assert.equal(registry.phaseOf(conn), 'attached')
})

test('session/resume maps not-found, subagent-owned and writer-held failures to stable rejections', async () => {
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  for (const [code, expected] of [
    ['session/not-found', 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND'],
    ['session/agent-busy', 'LOCAL_ACP_VIEW_SUBAGENT_OWNED'],
    ['session/writer-held', 'LOCAL_ACP_VIEW_WRITER_HELD'],
  ] as const) {
    const access = new FakeAccess()
    access.resolveAgentImpl = async () => ({ error: { code, message: 'x' } })
    const conn = registry.createConnection()
    await assert.rejects(registry.resumeSession(conn, access, { sessionId: 'S', cwd: '/w' }), isViewError(expected))
    assert.equal(registry.claimCount(), 0, `${code} must leave no reservation`)
    assert.equal(registry.phaseOf(conn), 'idle')
  }
})

test('a second connection cannot attach a Session another connection already holds', async () => {
  const access = new FakeAccess()
  access.seed(makeAgent('S3', '/w'))
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const a = registry.createConnection()
  const b = registry.createConnection()

  await registry.resumeSession(a, access, { sessionId: 'S3', cwd: '/w' })
  await assert.rejects(
    registry.resumeSession(b, access, { sessionId: 'S3', cwd: '/w' }),
    isViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED'),
  )
  assert.equal(registry.phaseOf(b), 'idle', 'the refused connection stays idle')
  assert.equal(registry.claimCount(), 1, 'the first connection keeps its claim')
  // The first connection is unaffected and can still close its View.
  assert.deepEqual(await registry.closeSession(a, access, 'S3'), {})
  assert.equal(registry.claimCount(), 0)
})

test('session/close is idempotent on one connection and never clears another connection claim', async () => {
  const access = new FakeAccess()
  access.seed(makeAgent('S4', '/w'))
  access.seed(makeAgent('S5', '/w'))
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const a = registry.createConnection()
  const b = registry.createConnection()

  await registry.resumeSession(a, access, { sessionId: 'S4', cwd: '/w' })
  await registry.resumeSession(b, access, { sessionId: 'S5', cwd: '/w' })

  assert.deepEqual(await registry.closeSession(a, access, 'S4'), {})
  assert.deepEqual(await registry.closeSession(a, access, 'S4'), {}, 'a repeated close on the same connection is idempotent')
  assert.equal(registry.phaseOf(a), 'idle')
  assert.equal(registry.hasClaim('S5'), true, 'another connection claim is untouched')
  assert.equal(registry.claimCount(), 1)
  // A connection closing a Session it never held is refused.
  await assert.rejects(registry.closeSession(a, access, 'S5'), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))
})

test('releasing a connection frees only its claims and marks it closed', async () => {
  const access = new FakeAccess()
  access.seed(makeAgent('S6', '/w'))
  access.seed(makeAgent('S7', '/w'))
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const a = registry.createConnection()
  const b = registry.createConnection()

  await registry.resumeSession(a, access, { sessionId: 'S6', cwd: '/w' })
  await registry.resumeSession(b, access, { sessionId: 'S7', cwd: '/w' })

  registry.releaseConnection(a)
  assert.equal(registry.phaseOf(a), 'closed')
  assert.equal(registry.hasClaim('S6'), false, 'the released connection claim is gone')
  assert.equal(registry.hasClaim('S7'), true, 'the sibling connection claim survives')
})

test('a late resolution after the connection closed never publishes an attached View', async () => {
  const access = new FakeAccess()
  const pending = deferred<{ agent: LiveAgentViewIdentity }>()
  access.resolveAgentImpl = () => pending.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const attempt = registry.resumeSession(conn, access, { sessionId: 'S8', cwd: '/w' })
  // The reservation exists synchronously BEFORE the resolve await settles.
  assert.equal(registry.hasClaim('S8'), true)
  // The connection closes while the official resolve is still in flight.
  registry.releaseConnection(conn)
  pending.resolve({ agent: makeAgent('S8', '/w') })

  await assert.rejects(attempt, isViewError('LOCAL_ACP_VIEW_CLOSED'))
  assert.equal(registry.hasClaim('S8'), false, 'a late resolve must not resurrect the claim')
  assert.equal(registry.phaseOf(conn), 'closed')
})

test('the resolved Agent must be the EXACT live registry object (stale generation refused)', async () => {
  const access = new FakeAccess()
  access.resolveAgentImpl = async () => ({ agent: makeAgent('S9', '/w') })
  // The live registry holds a DIFFERENT object under that id.
  access.seed(makeAgent('S9', '/w'))
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  await assert.rejects(
    registry.resumeSession(conn, access, { sessionId: 'S9', cwd: '/w' }),
    isViewError('LOCAL_ACP_VIEW_AGENT_UNAVAILABLE'),
  )
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('a second new/resume while a connection is attaching is refused as busy', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S10', '/w')
  access.seed(agent)
  const pending = deferred<{ agent: LiveAgentViewIdentity }>()
  access.resolveAgentImpl = () => pending.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const first = registry.resumeSession(conn, access, { sessionId: 'S10', cwd: '/w' })
  await assert.rejects(
    registry.newSession(conn, access, NEW),
    isViewError('LOCAL_ACP_VIEW_BUSY'),
  )
  pending.resolve({ agent })
  await first
  assert.equal(registry.phaseOf(conn), 'attached')
})

test('a close while a connection is still attaching cancels the pending attach', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S12', '/w')
  access.seed(agent)
  const pending = deferred<{ agent: LiveAgentViewIdentity }>()
  access.resolveAgentImpl = () => pending.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const attempt = registry.resumeSession(conn, access, { sessionId: 'S12', cwd: '/w' })
  assert.equal(registry.hasClaim('S12'), true)
  // The client closes the same session id while resume is still in flight.
  assert.deepEqual(await registry.closeSession(conn, access, 'S12'), {})
  assert.equal(registry.hasClaim('S12'), false)
  pending.resolve({ agent })
  // The late result must NOT resurrect an attached view.
  await assert.rejects(attempt, isViewError('LOCAL_ACP_VIEW_CLOSED'))
  assert.equal(registry.hasClaim('S12'), false)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('a late result from a superseded attach NEVER clobbers the newer operation state', async () => {
  const access = new FakeAccess()
  const agentS1 = makeAgent('S1', '/w')
  const agentS2 = makeAgent('S2', '/w')
  access.seed(agentS1)
  access.seed(agentS2)
  const pendingS1 = deferred<{ agent: LiveAgentViewIdentity }>()
  const pendingS2 = deferred<{ agent: LiveAgentViewIdentity }>()
  access.resolveAgentImpl = sessionId => (sessionId === 'S1' ? pendingS1.promise : pendingS2.promise)
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const first = registry.resumeSession(conn, access, { sessionId: 'S1', cwd: '/w' })
  assert.equal(registry.phaseOf(conn), 'attaching')
  // close(S1) then immediately a NEW resume(S2) starts while S1's resolve is
  // still in flight: a second attach operation now owns the connection state.
  assert.deepEqual(await registry.closeSession(conn, access, 'S1'), {})
  const second = registry.resumeSession(conn, access, { sessionId: 'S2', cwd: '/w' })
  assert.equal(registry.phaseOf(conn), 'attaching', 'the newer resume owns attaching')

  // The STALE S1 result resolves late: it must be inert and must NOT reset the
  // connection to idle (which would let a third request attach concurrently).
  pendingS1.resolve({ agent: agentS1 })
  await assert.rejects(first, isViewError('LOCAL_ACP_VIEW_CLOSED'))
  assert.equal(registry.phaseOf(conn), 'attaching', 'the stale S1 result must not clobber S2 attaching')
  assert.equal(registry.hasClaim('S1'), false)
  assert.equal(registry.hasClaim('S2'), true, 'S2 reservation survives the stale S1 result')

  // S2 still commits cleanly.
  pendingS2.resolve({ agent: agentS2 })
  await second
  assert.equal(registry.phaseOf(conn), 'attached')
  assert.equal(registry.hasClaim('S2'), true)
})

test('a rejecting resolve after a physical disconnect keeps the connection closed (never resurrected)', async () => {
  const access = new FakeAccess()
  const pending = deferred<{ agent: LiveAgentViewIdentity }>()
  access.resolveAgentImpl = () => pending.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()

  const attempt = registry.resumeSession(conn, access, { sessionId: 'S13', cwd: '/w' })
  registry.releaseConnection(conn)
  assert.equal(registry.phaseOf(conn), 'closed')
  pending.reject(new Error('host failed after disconnect'))
  await assert.rejects(attempt)
  assert.equal(registry.phaseOf(conn), 'closed', 'a late rejection must not turn a closed connection back to idle')
  assert.equal(registry.hasClaim('S13'), false)
})

test('resume then close then resume of the SAME session never lets a stale result delete the new claim', async () => {
  for (const mode of ['success', 'error', 'throw'] as const) {
    const access = new FakeAccess()
    const agent = makeAgent('S', '/w')
    access.seed(agent)
    let call = 0
    let stale!: Deferred<{ agent: LiveAgentViewIdentity } | { error: { code: string; message: string } }>
    access.resolveAgentImpl = () => {
      call += 1
      if (call === 1) { stale = deferred(); return stale.promise }
      return Promise.resolve({ agent })
    }
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const conn = registry.createConnection()
    const staleAttempt = registry.resumeSession(conn, access, { sessionId: 'S', cwd: '/w' })
    assert.equal(registry.hasClaim('S'), true)
    assert.deepEqual(await registry.closeSession(conn, access, 'S'), {})
    assert.equal(registry.hasClaim('S'), false)
    const newAttempt = registry.resumeSession(conn, access, { sessionId: 'S', cwd: '/w' })
    assert.equal(registry.hasClaim('S'), true, `${mode}: the new claim exists`)
    if (mode === 'success') stale.resolve({ agent })
    else if (mode === 'error') stale.resolve({ error: { code: 'session/not-found', message: 'x' } })
    else stale.reject(new Error('boom'))
    await assert.rejects(staleAttempt, (error: unknown) => error instanceof LocalAcpViewError)
    assert.equal(registry.hasClaim('S'), true, `${mode}: the stale result must NOT delete the new claim`)
    await newAttempt
    assert.equal(registry.phaseOf(conn), 'attached')
    assert.deepEqual(await registry.closeSession(conn, access, 'S'), {})
    assert.equal(registry.hasClaim('S'), false)
  }
})

test('session/new classifies the HOST result instead of whichever await threw', async () => {
  {
    const access = new FakeAccess()
    access.createWorkspaceImpl = async () => ({ kind: 'indeterminate', code: 'workspace/internal' })
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const conn = registry.createConnection()
    await assert.rejects(registry.newSession(conn, access, NEW), isViewError('LOCAL_ACP_VIEW_WORKSPACE_UNAVAILABLE'))
    assert.equal(access.createSessionCalls.length, 0)
  }
  {
    const access = new FakeAccess()
    access.createSessionImpl = async () => ({ kind: 'rejected', code: 'gateway/bad-request' })
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const conn = registry.createConnection()
    await assert.rejects(registry.newSession(conn, access, NEW), isViewError('LOCAL_ACP_VIEW_INVALID_REQUEST'))
    assert.equal(registry.claimCount(), 0)
  }
  {
    const access = new FakeAccess()
    access.createSessionImpl = async () => ({ kind: 'published-with-error', sessionId: 'S30', code: 'session/workspace-attach-failed' })
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const conn = registry.createConnection()
    await assert.rejects(
      registry.newSession(conn, access, NEW),
      (error: unknown) => error instanceof LocalAcpViewError
        && error.code === 'LOCAL_ACP_VIEW_CREATE_ATTACH_FAILED'
        && error.data.sessionId === 'S30',
    )
    assert.equal(access.createSessionCalls.length, 1, 'never retried')
    assert.equal(registry.claimCount(), 0)
    assert.equal(registry.phaseOf(conn), 'idle')
  }
})

test('session/new keeps the created session id when the agent borrow fails after a confirmed create', async () => {
  const access = new FakeAccess()
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: 'S20' })
  access.resolveAgentImpl = async () => ({ error: { code: 'gateway/internal', message: 'x' } })
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  await assert.rejects(
    registry.newSession(conn, access, NEW),
    (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_VIEW_HOST_ERROR'
      && error.data.sessionId === 'S20',
  )
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('a cwd mismatch on resume is attached without changing the Host Session', async () => {  const access = new FakeAccess()
  access.seed(makeAgent('S11', '/host/dir'))
  const warnings: string[] = []
  const diag: Diag = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => { warnings.push(message) },
    error: () => {},
    dispose: () => {},
  }
  const registry = new AcpSessionViewRegistry(diag)
  const conn = registry.createConnection()

  await registry.resumeSession(conn, access, { sessionId: 'S11', cwd: '/client/dir' })
  assert.equal(registry.phaseOf(conn), 'attached')
  assert.deepEqual(warnings, ['local-acp.view.cwd-mismatch'], 'the mismatch is a fixed non-sensitive note')
  assert.equal(access.createSessionCalls.length, 0)
})

test('the production Host pending lookup reads both official inbox lists and rejects stale identities', () => {
  const session = { id: 'S', header: {} }
  const agent = {
    id: 'S',
    session,
    inbox: {
      remove: () => false,
      nextTurn: [{ id: 'next-turn' }],
      nextStep: [{ id: 'next-step' }],
    },
  }
  const agents = { get: (id: string) => id === 'S' ? agent : undefined }
  const sessions = { get: (id: string) => id === 'S' ? session : undefined }
  const context = {
    reflect: {
      get(name: string) {
        if (name === 'workspaceController') return { create: async () => ({ workspace: { workspaceId: 'ws', path: '/w' }, created: true }) }
        if (name === 'sessionController') return {
          create: async () => ({ sessionId: 'S' }),
          resolveAgent: async () => ({ agent }),
          prompt: async () => ({ accepted: true }),
        }
        if (name === 'agents') return agents
        if (name === 'sessions') return sessions
        return undefined
      },
    },
  } as unknown as Parameters<typeof createHostAcpSessionAccess>[0]
  const access = createHostAcpSessionAccess(context)
  assert.equal(access.pendingMessage('S', agent, session, 'next-turn'), 'pending')
  assert.equal(access.pendingMessage('S', agent, session, 'next-step'), 'pending')
  assert.equal(access.pendingMessage('S', agent, session, 'absent'), 'absent')
  assert.equal(access.pendingMessage('S', { ...agent }, session, 'next-turn'), 'stale')
  assert.equal(access.pendingMessage('S', agent, { ...session }, 'next-turn'), 'stale')
  agent.inbox.nextTurn = []
  agent.inbox.nextStep = []
  assert.equal(access.pendingMessage('S', agent, session, 'next-turn'), 'absent', 'each lookup uses the live official list')
  agent.session = { id: 'S', header: {} }
  assert.equal(access.pendingMessage('S', agent, session, 'absent'), 'stale', 'the Agent must still drive the exact Session')
})

test('the Host image facade reads the default and exact live model routes and refuses unknown or stale admission', async () => {
  const session = { id: 'S-image', header: { cwd: '/w' } }
  let route: { provider: string; model: string } | undefined = { provider: 'provider', model: 'image' }
  const agent = { id: session.id, session, model: { current: () => route } }
  let liveAgent: typeof agent | undefined = agent
  let liveSession: typeof session | undefined = session
  const limits = { maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 8, mediaTypes: ['image/png'] }
  const dispatched: AcpSessionPromptRequest[] = []
  const resolved: Array<[string, string]> = []
  let resolveInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }> =
    async (_provider, model) => model === 'image' ? { inputModalities: ['text', 'image'] } : {}
  let store: { imageLimits: AcpImageLimits } | undefined = { imageLimits: limits }
  let defaultRoute: { provider: string; model: string } | undefined = { provider: 'provider', model: 'image' }
  let defaultModel: { currentSelection: () => typeof route } | undefined = { currentSelection: () => defaultRoute }
  const llm = { resolveModelInfo: async (provider: string, model: string) => {
    resolved.push([provider, model])
    return await resolveInfo(provider, model)
  } }
  const context = {
    reflect: { get(name: string) {
      if (name === 'workspaceController') return {}
      if (name === 'sessionController') return { prompt: async (request: AcpSessionPromptRequest) => { dispatched.push(request); return { accepted: true } } }
      if (name === 'agents') return { get: () => liveAgent }
      if (name === 'sessions') return { get: () => liveSession }
      if (name === 'attachments') return store
      if (name === 'agentDefaultModel') return defaultModel
      if (name === 'llm') return llm
      return undefined
    } },
  } as unknown as Parameters<typeof createHostAcpSessionAccess>[0]
  const access = createHostAcpSessionAccess(context)
  assert.equal(access.imageLimits(), limits)
  assert.equal(await access.supportsImagePrompts(), true)
  assert.deepEqual(resolved, [['provider', 'image']])
  const request: AcpSessionPromptRequest = {
    requestId: 'image-request', sessionId: session.id, mode: 'queue',
    content: [{ type: 'image', mediaType: 'image/png', data: 'AQID' }],
  }
  assert.deepEqual(await access.prompt(request, new AbortController().signal), { accepted: true })
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0], request, 'the facade forwards once without persisting or rewriting image bytes')

  route = { provider: 'provider', model: 'text-only' }
  resolveInfo = async (_provider, model) => model === 'text-only' ? { inputModalities: ['text'] } : {}
  await assert.rejects(access.prompt(request, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'session/attachment-invalid')
  assert.equal(dispatched.length, 1)

  route = { provider: 'provider', model: 'unknown' }
  resolveInfo = async () => ({})
  await assert.rejects(access.prompt(request, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'session/attachment-invalid')
  assert.equal(dispatched.length, 1)
  route = { provider: 'provider', model: 'image' }
  const gate = deferred<{ inputModalities?: readonly string[] }>()
  resolveInfo = async () => await gate.promise
  const stale = access.prompt(request, new AbortController().signal)
  liveAgent = { ...agent }
  gate.resolve({ inputModalities: ['image'] })
  await assert.rejects(stale, (error: unknown) => (error as { code?: string }).code === 'session/attachment-invalid')
  assert.equal(dispatched.length, 1, 'a new Agent under the same Session id receives no old image request')

  liveAgent = agent
  const abortGate = deferred<{ inputModalities?: readonly string[] }>()
  resolveInfo = async () => await abortGate.promise
  const controller = new AbortController()
  const aborted = access.prompt(request, controller.signal)
  controller.abort()
  abortGate.resolve({ inputModalities: ['image'] })
  await assert.rejects(aborted, { name: 'AbortError' })
  assert.equal(dispatched.length, 1)

  store = undefined
  assert.equal(await createHostAcpSessionAccess(context).supportsImagePrompts(), false)
  store = { imageLimits: limits }
  defaultModel = undefined
  assert.equal(await createHostAcpSessionAccess(context).supportsImagePrompts(), false)
  liveSession = undefined
})

test('the production Host access classifier maps official errors to the right create outcome', async () => {
  let workspaceImpl: () => Promise<unknown> = async () => ({ workspace: { workspaceId: 'ws', path: '/w' }, created: true })
  let sessionImpl: () => Promise<unknown> = async () => ({ sessionId: 'S' })
  const context = {
    reflect: {
      get(name: string) {
        if (name === 'workspaceController') return { create: async () => await workspaceImpl() }
        if (name === 'sessionController') {
          return {
            create: async () => await sessionImpl(),
            resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'x' } }),
          }
        }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'sessions') return { get: () => undefined }
        return undefined
      },
    },
  } as unknown as Parameters<typeof createHostAcpSessionAccess>[0]
  const access = createHostAcpSessionAccess(context)

  // The official Workspace Controller wraps a persistence failure as
  // `workspace/invalid-path`: no official fact proves "no Workspace created".
  workspaceImpl = async () => {
    throw { isDSHRemoteError: true, code: 'workspace/invalid-path', details: { path: '/w' } }
  }
  assert.deepEqual(await access.createWorkspace('/w'), { kind: 'indeterminate', code: 'workspace/invalid-path' })

  // Definite PRE-mint rejections keep their definite classification.
  for (const code of ['gateway/bad-request', 'workspace/not-found']) {
    sessionImpl = async () => {
      throw { isDSHRemoteError: true, code, details: {} }
    }
    assert.deepEqual(await access.createSession('ws'), { kind: 'rejected', code })
  }

  // `agent-preset/not-found|invalid` can ALSO be raised AFTER the Session handle
  // was persisted (`composition.setup` → `presets.mount` → `retain`), so they
  // cannot prove "not created" and must stay unconfirmed.
  for (const code of ['agent-preset/not-found', 'agent-preset/invalid']) {
    sessionImpl = async () => {
      throw { isDSHRemoteError: true, code, details: {} }
    }
    assert.deepEqual(await access.createSession('ws'), { kind: 'indeterminate', code })
  }

  // The official published-with-error keeps the authoritative created id.
  sessionImpl = async () => {
    throw { isDSHRemoteError: true, code: 'session/workspace-attach-failed', details: { sessionId: 'S-created', workspaceId: 'ws' } }
  }
  assert.deepEqual(await access.createSession('ws'), {
    kind: 'published-with-error',
    sessionId: 'S-created',
    code: 'session/workspace-attach-failed',
  })

  // A confirmed create is created.
  sessionImpl = async () => ({ sessionId: 'S-ok' })
  assert.deepEqual(await access.createSession('ws'), { kind: 'created', sessionId: 'S-ok' })
})

/** One attached prompt View over a fake Host access driven by REAL intermediate facts. */
function promptView(sessionId = 'P1'): {
  access: FakeAccess
  agent: AgentLike
  registry: AcpSessionViewRegistry
  conn: ReturnType<AcpSessionViewRegistry['createConnection']>
  notifications: SessionUpdate[]
  permissionRequests: Array<{ params: import('../../src/app/remote-process/local-acp-session-view.ts').AcpRequestPermissionParams; signal?: AbortSignal; respond: (response: import('../../src/app/remote-process/local-acp-session-view.ts').AcpRequestPermissionResponse) => void; fail: (error: unknown) => void }>
  attach: () => Promise<void>
  start: (text?: string, signal?: AbortSignal, prompt?: readonly unknown[], imageEnabled?: boolean) => Promise<{ stopReason: string }>
  insert: (rpcId: string, messageId: string, text?: string) => void
  claim: (messageId: string, turn: number, rpcId?: string) => void
  commit: (type: string, data: Record<string, unknown>) => void
  message: (messageId: string, rpcId: string, kind?: string) => { id: string; source: { kind: string; rpcId: string } }
  deferredSend: () => { promise: Promise<void>; release: () => void }
} {
  const access = new FakeAccess()
  const agent = makeAgent(sessionId, '/w')
  access.seed(agent)
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const notifications: SessionUpdate[] = []
  const permissionRequests: Array<{ params: import('../../src/app/remote-process/local-acp-session-view.ts').AcpRequestPermissionParams; signal?: AbortSignal; respond: (response: import('../../src/app/remote-process/local-acp-session-view.ts').AcpRequestPermissionResponse) => void; fail: (error: unknown) => void }> = []
  const pending: Array<{ promise: Promise<void>; release: () => void }> = []
  const sendUpdate = async (update: SessionUpdate): Promise<void> => {
    const gate = pending.shift()
    if (gate !== undefined) await gate.promise
    notifications.push(update)
  }
  const message = (messageId: string, rpcId: string, kind = 'user') => ({ id: messageId, source: { kind, rpcId } })
  return {
    access,
    agent,
    registry,
    conn,
    notifications,
    permissionRequests,
    message,
    attach: async () => { await registry.resumeSession(conn, access, { sessionId, cwd: '/w' }) },
    start: (text = 'hello', signal = new AbortController().signal, prompt = [{ type: 'text', text }], imageEnabled = false) =>
      registry.promptSession(conn, access, { sessionId, prompt }, signal, imageEnabled, sendUpdate, (params, options) =>
        new Promise((resolveAsk, rejectAsk) => {
          permissionRequests.push({
            params,
            signal: options?.signal,
            respond: resolveAsk,
            fail: rejectAsk,
          })
        })),
    insert: (rpcId: string, messageId: string, text = 'hello') => {
      access.pendingInbox.add(messageId)
      registry.onInboxInserted(agent, message(messageId, rpcId))
    },
    claim: (messageId: string, turn: number, rpcId = 'unknown') => {
      access.pendingInbox.delete(messageId)
      registry.onInboxClaimed(agent, message(messageId, rpcId), turn)
    },
    commit: (type: string, data: Record<string, unknown>) => {
      if (type === 'turn/end' && access.turnFence !== 'stale' && access.turnFence.lastTurn === data.turn) {
        access.turnFence.openTurnStartSeq = null
        access.agentStatus = 'idle'
      }
      registry.onSessionEvent(agent.session, { type, data })
    },
    deferredSend: () => {
      let release!: () => void
      const promise = new Promise<void>(resolveSend => { release = resolveSend })
      pending.push({ promise, release })
      return { promise, release }
    },
  }
}

/** The `sessionUpdate` kind of one collected update (typed for assertions). */
function updateKind(update: SessionUpdate): string {
  return update.sessionUpdate
}

/** The one content block of a collected agent chunk update. */
function chunkOf(update: SessionUpdate | undefined): Record<string, unknown> {
  assert.ok(update !== undefined, 'the expected ACP update was delivered')
  assert.ok('content' in update, 'the expected ACP update carries one content block')
  return update.content as Record<string, unknown>
}

/** One committed assistant message event carrying ordered content blocks. */
function assistantData(turn: number, messageId: string, blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { turn, step: 1, message: { id: messageId, content: blocks } }
}

/** Let queued output-delivery microtasks run (never a timing assumption). */
async function flushOutput(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

function isPromptError(code: string): (error: unknown) => boolean {
  return error => error instanceof LocalAcpViewError && error.code === code
}

test('a prompt settles end_turn only from rpcId -> inserted id -> claimed turn -> committed text -> turn/end', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('the same text')
  assert.equal(view.access.promptCalls.length, 1, 'exactly one Host prompt dispatch')
  const request = view.access.promptCalls[0]!
  assert.equal(request.mode, 'queue')
  assert.equal(typeof request.requestId, 'string')
  assert.ok(request.requestId.length > 0)
  assert.deepEqual(request.content, [{ type: 'text', text: 'the same text' }])

  // The SAME TEXT under another request id is a different message: it must not
  // be attributed to this prompt and its turn output must stay off this wire.
  view.insert('some-other-request', 'm-foreign', 'the same text')
  view.claim('m-foreign', 1, 'some-other-request')
  view.commit('assistant/message', assistantData(1, 'm-foreign', [{ type: 'text', text: 'foreign answer' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(view.notifications.length, 0, 'a foreign request turn is never projected')

  view.insert(request.requestId, 'm-own', 'the same text')
  view.claim('m-own', 2, request.requestId)
  view.commit('assistant/message', assistantData(2, 'm-own', [{ type: 'text', text: 'real answer' }]))
  await flushOutput()
  assert.equal(view.notifications.length, 1)
  assert.deepEqual(view.notifications[0], {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'm-own',
    content: { type: 'text', text: 'real answer' },
  })
  view.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('an assistant message with two Markdown text blocks projects each block verbatim and in order', async () => {
  // Regression: PO-4B Markdown fidelity (external qualification plan §6): the
  // sample keeps CRLF, blank lines, backticks, JSON characters and Unicode, and
  // each committed text block must become exactly one ordered chunk.
  const block1 = '# PO-4B Report\r\n\r\n- [report](./.po4b/report.md)\r\n- [missing](./.po4b/missing.md)\r\n- [private](./.po4b/private.md)\r\n\r\n'
  const block2 = '```json\n{"path":"./.po4b/report.md","quote":"`literal`"}\n```\n\n**bold**  _italic_  中文🙂\n'
  const view = promptView()
  await view.attach()
  const attempt = view.start('po4b:markdown-host-files:v1')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-markdown')
  view.claim('m-markdown', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-markdown', [
    { type: 'text', text: block1 },
    { type: 'text', text: block2 },
  ]))
  await flushOutput()
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-markdown', content: { type: 'text', text: block1 } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-markdown', content: { type: 'text', text: block2 } },
  ])
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('a prompt answers only after its own turn/end AND the ordered notification drain', async () => {
  const view = promptView()
  await view.attach()
  const gate = view.deferredSend()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'late answer' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  let settled = false
  void attempt.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the answer must wait for the notification drain')
  gate.release()
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('the host prompt acknowledgement alone never settles a turn: queued output and completion stay separate facts', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  let settled = false
  void attempt.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'an accepted ACK is not a completed turn')
  assert.equal(view.notifications.length, 0)
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 7, request.requestId)
  view.commit('assistant/message', assistantData(7, 'm-1', [{ type: 'text', text: 'ok' }]))
  view.commit('turn/end', { turn: 7, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('a mixed turn fails closed whether the foreign claim lands before or after the owned claim', async () => {
  {
    // Foreign next-step message claimed in the SAME claim batch, BEFORE ours.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-own')
    view.claim('m-foreign', 5, 'tui-request')
    view.claim('m-own', 5, request.requestId)
    view.commit('assistant/message', assistantData(5, 'm-both', [{ type: 'text', text: 'mixed answer' }]))
    view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
    assert.equal(view.notifications.length, 0, 'a mixed turn projects nothing')
  }
  {
    // A TUI steer claimed into the running owned turn AFTER our claim.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-own')
    view.claim('m-own', 6, request.requestId)
    view.commit('assistant/message', assistantData(6, 'm-own', [{ type: 'text', text: 'first half' }]))
    await flushOutput()
    view.claim('m-steer', 6, 'tui-steer')
    view.commit('assistant/message', assistantData(6, 'm-mixed', [{ type: 'text', text: 'second half' }]))
    view.commit('turn/end', { turn: 6, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
    assert.equal(view.notifications.length, 1, 'only the pre-mix committed half was projected')
    assert.ok(!view.notifications.some(update => JSON.stringify(update).includes('second half')))
  }
})

test('turn reasons map to the legal stop reasons or a stable failure; no outcome is silently end_turn', async () => {
  const cases: Array<{ reason: Record<string, unknown>; expected: string }> = [
    { reason: { kind: 'completed' }, expected: 'end_turn' },
    { reason: { kind: 'max-tokens' }, expected: 'max_tokens' },
  ]
  for (const entry of cases) {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'answer' }]))
    view.commit('turn/end', { turn: 1, reason: entry.reason })
    assert.deepEqual(await attempt, { stopReason: entry.expected })
  }
  for (const kind of ['blocked', 'error', 'aborted', 'interrupted'] as const) {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'partial' }]))
    view.commit('turn/end', { turn: 1, reason: { kind } })
    await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED'
      && error.data.reason === kind)
  }
  {
    // A completed turn with no real assistant text is NOT a successful prompt.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
    await flushOutput()
    assert.equal(view.notifications.length, 1, 'the tool call itself was projected')
    assert.ok(view.notifications.every(update => update.sessionUpdate !== 'agent_message_chunk'))
  }
})

test('an Agent failure or disposal only fails the SAME agent and the SAME owned turn', async () => {
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 3, request.requestId)
    // Another turn's failure and another Agent's failure are inert.
    view.registry.onAgentError(view.agent, 2)
    view.registry.onAgentError(makeAgent('OTHER', '/w'), 3)
    view.commit('assistant/message', assistantData(3, 'm-1', [{ type: 'text', text: 'answer' }]))
    view.commit('turn/end', { turn: 3, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 4, request.requestId)
    view.registry.onAgentError(view.agent, 4)
    await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'agent-error')
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 5, request.requestId)
    view.registry.onAgentDisposed(view.agent)
    await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'agent-disposed')
  }
})

test('invalid prompt admission is refused before any Host dispatch', async () => {
  const view = promptView()
  await view.attach()
  const signal = new AbortController().signal
  for (const prompt of [
    [],
    [{ type: 'text', text: '   ' }],
    [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    [{ type: 'resource' }],
    [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }],
    [{ type: 'unknown' }],
  ]) {
    await assert.rejects(
      view.registry.promptSession(view.conn, view.access, { sessionId: 'P1', prompt }, signal, false, async () => {}),
      isPromptError('LOCAL_ACP_PROMPT_INVALID_CONTENT'),
    )
  }
  await assert.rejects(
    view.registry.promptSession(view.conn, view.access, { sessionId: 'OTHER', prompt: [{ type: 'text', text: 'x' }] }, signal, false, async () => {}),
    isPromptError('LOCAL_ACP_VIEW_NOT_OWNED'),
  )
  assert.equal(view.access.promptCalls.length, 0, 'no invalid prompt reaches the Host')
})

test('resource_link becomes the official ordered text hint and negotiated images keep their position', async () => {
  const view = promptView()
  await view.attach()
  const link = { type: 'resource_link', name: 'a "file"', uri: 'file:///host/private.png' }
  const prompt = [
    { type: 'text', text: 'before' },
    link,
    { type: 'text', text: 'middle' },
    { type: 'image', mimeType: 'image/png', data: 'AQID' },
    { type: 'text', text: 'after' },
  ]
  const attempt = view.start('', undefined, prompt, true)
  const request = view.access.promptCalls[0]!
  assert.deepEqual(request.content, [
    { type: 'text', text: `before\n[resource_link name=${JSON.stringify(link.name)} uri=${JSON.stringify(link.uri)}]\nmiddle` },
    { type: 'image', mediaType: 'image/png', data: 'AQID' },
    { type: 'text', text: 'after' },
  ])
  view.insert(request.requestId, 'm-mixed')
  view.claim('m-mixed', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-mixed', [{ type: 'text', text: 'accepted' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('an image-only prompt reaches the Host without inserting an empty text block', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('', undefined, [{ type: 'image', mimeType: 'image/jpeg', data: '/w==' }], true)
  const request = view.access.promptCalls[0]!
  assert.deepEqual(request.content, [{ type: 'image', mediaType: 'image/jpeg', data: '/w==' }])
  view.insert(request.requestId, 'm-image-only')
  view.claim('m-image-only', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-image-only', [{ type: 'text', text: 'seen' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('an unlisted image MIME is refused even when this connection negotiated image', async () => {
  const view = promptView()
  await view.attach()
  await assert.rejects(
    view.start('', undefined, [{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }], true),
    isPromptError('LOCAL_ACP_PROMPT_INVALID_CONTENT'),
  )
  assert.equal(view.access.promptCalls.length, 0)
})

test('a second concurrent prompt is refused and the Host dispatch count stays exactly one', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('first')
  await assert.rejects(view.start('second'), isPromptError('LOCAL_ACP_PROMPT_IN_FLIGHT'))
  assert.equal(view.access.promptCalls.length, 1)
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'ok' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('a Host rejection before insertion is definite; a rejection after insertion is indeterminate and never retried', async () => {
  {
    const view = promptView()
    await view.attach()
    view.access.promptImpl = async () => {
      throw { code: 'session/agent-busy', message: 'busy' }
    }
    await assert.rejects(view.start(), (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_PROMPT_HOST_REJECTED' && error.data.hostCode === 'session/agent-busy')
    assert.equal(view.access.promptCalls.length, 1, 'a definite rejection is never retried')
  }
  {
    const view = promptView()
    await view.attach()
    view.access.promptImpl = async request => {
      // The real wrapper can fail AFTER the message entered the live inbox.
      view.registry.onInboxInserted(view.agent, view.message('m-queued', request.requestId))
      throw { code: 'session/internal', message: 'late failure' }
    }
    await assert.rejects(view.start(), isPromptError('LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE'))
    assert.equal(view.access.promptCalls.length, 1, 'an unknown dispatch outcome is never replayed')
  }
})

test('a close with a RUNNING owned flight cancels the exact turn, drains, detaches and stays idempotent', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 2, request.requestId)
  view.access.pendingInbox.delete('m-1')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 2 }
  view.access.agentStatus = 'running'
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  // The repeated close awaits the SAME settlement (never a second cancel).
  const closingAgain = view.registry.closeSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [{ turn: 2, keepInbox: true }], 'exactly one official user cancel of the exact turn')
  // The prompt answers `cancelled` only after the real user-aborted turn/end.
  view.commit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  assert.deepEqual(await closing, {})
  assert.deepEqual(await closingAgain, {}, 'a repeated close awaits the same settlement')
  assert.equal(view.registry.hasClaim('P1'), false)
  assert.equal(view.registry.phaseOf(view.conn), 'idle')
})

test('a physical disconnect with a QUEUED flight removes the exact pending message before releasing the claim', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.access.pendingInbox.add('m-1')
  view.registry.releaseConnection(view.conn, view.access)
  // The scoped cancellation removes the exact queued message; the claim is
  // released only after that proven settlement. The disconnected request
  // settles cancelled (a proven removal) — never a fabricated success.
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  assert.deepEqual(view.access.removedMessageIds, ['m-1'], 'the disconnect removed the exact queued message')
  for (let guard = 0; guard < 100 && view.registry.hasClaim('P1'); guard += 1) {
    await new Promise(resolveTick => setImmediate(resolveTick))
  }
  assert.equal(view.registry.hasClaim('P1'), false, 'the disconnect releases the claim after the settlement')
})

test('late facts of a settled old View never reach a new claim', async () => {
  const view = promptView()
  await view.attach()
  view.insert('old-request', 'm-old')
  view.claim('m-old', 2, 'old-request')
  await view.registry.closeSession(view.conn, view.access, 'P1')
  view.commit('assistant/message', assistantData(2, 'm-old', [{ type: 'text', text: 'late answer' }]))
  view.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await flushOutput()
  assert.equal(view.notifications.length, 0)

  // A NEW connection attaching the SAME session receives none of the old turn.
  const next = promptView()
  await next.attach()
  next.commit('assistant/message', assistantData(2, 'm-old', [{ type: 'text', text: 'late answer' }]))
  next.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(next.notifications.length, 0, 'an old generation turn is never replayed to a new claim')
})

test('an aborted ACP request scopes to the owned turn like any other cancel and never fakes a result', async () => {
  const view = promptView()
  await view.attach()
  const controller = new AbortController()
  const attempt = view.start('abort me', controller.signal)
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.access.pendingInbox.delete('m-1')
  view.access.turnFence = { openTurnStartSeq: 800, lastTurn: 8 }
  view.access.agentStatus = 'running'
  view.claim('m-1', 8, request.requestId)
  // The SDK RequestSignal abort is a CHANNEL fact: it routes through the SAME
  // scoped cancellation and only the real user-aborted turn/end settles it.
  controller.abort(new Error('client went away'))
  assert.deepEqual(view.access.cancelledTurns, [{ turn: 8, keepInbox: true }], 'the exact owned turn is user-cancelled')
  assert.equal(view.notifications.length, 0, 'a dead channel delivers nothing')
  assert.equal(view.access.promptCalls.length, 1, 'abort never re-dispatches the prompt')
  view.commit('assistant/message', assistantData(8, 'm-1', [{ type: 'text', text: 'after abort' }]))
  assert.equal(view.notifications.length, 0, 'post-abort committed output is not delivered')
  view.commit('turn/end', { turn: 8, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  // The View is still attached and can take a new prompt afterwards.
  const second = view.start('next prompt')
  const secondRequest = view.access.promptCalls[1]!
  view.insert(secondRequest.requestId, 'm-2')
  view.access.pendingInbox.delete('m-2')
  view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 9 }
  view.access.agentStatus = 'running'
  view.claim('m-2', 9, secondRequest.requestId)
  view.commit('assistant/message', assistantData(9, 'm-2', [{ type: 'text', text: 'second answer' }]))
  view.access.turnFence = { openTurnStartSeq: null, lastTurn: 9 }
  view.access.agentStatus = 'idle'
  view.commit('turn/end', { turn: 9, reason: { kind: 'completed' } })
  assert.deepEqual(await second, { stopReason: 'end_turn' })
})

test('tool call and result project as standard ACP updates; unsupported committed blocks fail the request', async () => {
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"a"}' })
    view.commit('tool/result', {
      turn: 1,
      step: 1,
      message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'file body' }] },
    })
    view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'done' }]))
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    await flushOutput()
    assert.deepEqual(view.notifications, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'read',
        kind: 'other',
        status: 'in_progress',
        rawInput: { file_path: 'a' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'done' } },
    ])
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'image', attachment: { id: 'img' } }]))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'))
    assert.equal(view.notifications.length, 0, 'an unsupported block is never truncated into a fake text')
  }
})

test('a failed notification or an over-capacity output queue fails only this View request', async () => {
  {
    // A sibling View whose transport rejects: the failure belongs to that View.
    const access = new FakeAccess()
    const agent = makeAgent('P2', '/w')
    access.seed(agent)
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const conn = registry.createConnection()
    await registry.resumeSession(conn, access, { sessionId: 'P2', cwd: '/w' })
    const failingAttempt = registry.promptSession(
      conn,
      access,
      { sessionId: 'P2', prompt: [{ type: 'text', text: 'x' }] },
      new AbortController().signal,
      false,
      async () => { throw new Error('socket gone') },
    )
    const failingRequest = access.promptCalls[0]!
    registry.onInboxInserted(agent, { id: 'm-x', source: { kind: 'user', rpcId: failingRequest.requestId } })
    registry.onInboxClaimed(agent, { id: 'm-x', source: { kind: 'user', rpcId: failingRequest.requestId } }, 1)
    registry.onSessionEvent(agent.session, { type: 'assistant/message', data: assistantData(1, 'm-x', [{ type: 'text', text: 'x' }]) })
    await assert.rejects(failingAttempt, isPromptError('LOCAL_ACP_PROMPT_OUTPUT_FAILED'))
    assert.equal(access.promptCalls.length, 1, 'a transport failure never re-dispatches the prompt')

    // An unrelated healthy View still completes after its sibling failed.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'ok' }]))
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    const blocks = Array.from({ length: 65 }, (_entry, index) => ({ type: 'text', text: `block-${String(index)}` }))
    view.commit('assistant/message', assistantData(1, 'm-1', blocks))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE'))
    assert.equal(view.notifications.length, 0, 'the overflow was detected at the fixed queue bound')
  }
})

test('same session id with a NEW Agent object never lets the old Agent facts reach the new claim', async () => {
  const view = promptView()
  await view.attach()
  await view.registry.closeSession(view.conn, view.access, 'P1')
  // A new live Agent object for the SAME session id (a new generation).
  const replacement = makeAgent('P1', '/w')
  view.access.seed(replacement)
  await view.registry.resumeSession(view.conn, view.access, { sessionId: 'P1', cwd: '/w' })
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  // The OLD Agent object's facts are inert. Its own request ids never match
  // this attached generation, and it must not be mistaken for a foreign
  // acceptance of the CURRENT request id.
  view.registry.onInboxInserted(view.agent, view.message('m-old-other', 'old-generation-request'))
  view.registry.onInboxClaimed(view.agent, view.message('m-old', 'old-generation-request'), 1)
  view.commit('assistant/message', assistantData(1, 'm-old', [{ type: 'text', text: 'old agent answer' }]))
  assert.equal(view.notifications.length, 0, 'the old Agent generation is never projected')
  // The CURRENT Agent object's exact facts settle the prompt.
  view.registry.onInboxInserted(replacement, view.message('m-new', request.requestId))
  view.registry.onInboxClaimed(replacement, view.message('m-new', request.requestId), 2)
  view.registry.onSessionEvent(replacement.session, {
    type: 'assistant/message',
    data: assistantData(2, 'm-new', [{ type: 'text', text: 'new agent answer' }]),
  })
  view.registry.onSessionEvent(replacement.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  await flushOutput()
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-new', content: { type: 'text', text: 'new agent answer' } },
  ])
})

test('the production Host access subscribes the prompt fact sink and disposes exactly those listeners', () => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const on = (name: string, listener: Listener): (() => void) => {
    const set = listeners.get(name) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(name, set)
    return () => { set.delete(listener) }
  }
  const context = {
    reflect: {
      get(name: string) {
        if (name === 'workspaceController') return { create: async () => ({ workspace: { workspaceId: 'ws', path: '/w' }, created: true }) }
        if (name === 'sessionController') {
          return {
            create: async () => ({ sessionId: 'S' }),
            resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'x' } }),
            prompt: async () => ({ accepted: true }),
          }
        }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'sessions') return { get: () => undefined }
        return undefined
      },
    },
    on,
  } as unknown as Parameters<typeof createHostAcpSessionAccess>[0]
  const access = createHostAcpSessionAccess(context)
  const seen: string[] = []
  const dispose = access.observePromptFacts({
    onInboxInserted: (agent, message) => { seen.push(`inserted:${agent.id}:${message.id}:${String(message.source?.rpcId)}`) },
    onInboxClaimed: (agent, message, turn) => { seen.push(`claimed:${agent.id}:${message.id}:${String(turn)}`) },
    onSessionEvent: (session, event) => { seen.push(`event:${String((session as { id: string }).id)}:${event.type}`) },
    onInboxDiscarded: (agent, message) => { seen.push(`discarded:${agent.id}:${message.id}`) },
    onAgentError: (agent, turn) => { seen.push(`error:${agent.id}:${String(turn)}`) },
    onAgentDisposed: agent => { seen.push(`disposed:${agent.id}`) },
    onApprovalRequest: (request, next) => {
      seen.push(`approval:${request.agent.id}:${String(request.toolName)}:${String(request.callId)}`)
      return next()
    },
  })
  const agent = { id: 'S', session: { id: 'S', header: {} } }
  const fire = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  fire('agent/inbox/inserted', { agent, message: { id: 'm1', source: { kind: 'user', rpcId: 'r1' } } })
  fire('agent/inbox/claimed', { agent, message: { id: 'm1' }, turn: 3 })
  fire('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  fire('agent/error', { agent, turn: 3, step: 1, error: new Error('x') })
  fire('agent/disposed', { agent })
  fire('approval/request', { agent, toolName: 'bash', callId: 'c9' }, async () => 'rejected')
  assert.deepEqual(seen, [
    'inserted:S:m1:r1',
    'claimed:S:m1:3',
    'event:S:turn/end',
    'error:S:3',
    'disposed:S',
    'approval:S:bash:c9',
  ], 'each official event reaches the sink with its real identity payload')
  dispose()
  assert.equal([...listeners.values()].every(set => set.size === 0), true, 'the disposer removes exactly its own listeners')
})

test('a prompt is refused before dispatch when the borrowed Agent/Session is stale', async () => {
  const view = promptView()
  await view.attach()
  // The Host retires its live Agent while the View is still attached; the
  // official Controller would cold-resume a NEW Agent for the same Session.
  view.access.remove('P1')
  await assert.rejects(view.start(), isPromptError('LOCAL_ACP_PROMPT_STALE_AGENT'))
  assert.equal(view.access.promptCalls.length, 0, 'a stale borrowed identity must never reach the Host prompt')
  assert.equal(view.registry.phaseOf(view.conn), 'attached', 'the View stays attached for a real re-attach')
})

test('an accepted request on a DIFFERENT Agent generation fails bounded and is never re-dispatched', async () => {
  const view = promptView()
  await view.attach()
  // Same session id, but a DISTINCT Agent object: what the official Controller
  // cold-resumes while the async resolve runs. It accepts OUR requestId.
  const foreignAgent = makeAgent('P1', '/w')
  view.access.promptImpl = async request => {
    view.registry.onInboxInserted(foreignAgent, { id: 'm-foreign-gen', source: { kind: 'user', rpcId: request.requestId } })
    return { accepted: true as const }
  }
  await assert.rejects(view.start(), isPromptError('LOCAL_ACP_PROMPT_STALE_AGENT'))
  assert.equal(view.access.promptCalls.length, 1, 'the accepted request is never re-dispatched')
  // The foreign generation's later facts stay inert for this View.
  view.registry.onInboxClaimed(foreignAgent, {
    id: 'm-foreign-gen',
    source: { kind: 'user', rpcId: view.access.promptCalls[0]!.requestId },
  }, 1)
  assert.equal(view.notifications.length, 0)
})

test('an acceptance whose exact identity changed during resolve fails bounded', async () => {
  const view = promptView()
  await view.attach()
  view.access.promptImpl = async () => {
    view.access.remove('P1')
    return { accepted: true as const }
  }
  await assert.rejects(view.start(), isPromptError('LOCAL_ACP_PROMPT_STALE_AGENT'))
  assert.equal(view.access.promptCalls.length, 1, 'the request is never retried')
})

test('a failed turn without assistant text keeps its REAL terminal classification', async () => {
  for (const kind of ['blocked', 'error', 'aborted', 'interrupted'] as const) {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    // No assistant message at all before the failed terminal.
    view.commit('turn/end', { turn: 1, reason: { kind } })
    await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED'
      && error.data.reason === kind)
  }
})

test('a failure while the Host admission is pending never becomes an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    {
      // Abort during a pending admission.
      const view = promptView()
      await view.attach()
      let finishAdmission!: (value: { readonly accepted: true }) => void
      view.access.promptImpl = async () => await new Promise(resolveAdmission => { finishAdmission = resolveAdmission })
      const controller = new AbortController()
      const attempt = view.start('abort while admitting', controller.signal)
      controller.abort(new Error('client went away'))
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
      assert.deepEqual(unhandled, [], 'the early rejection must be observed before admission settles')
      finishAdmission({ accepted: true })
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_ABORTED'))
      assert.equal(view.access.promptCalls.length, 1, 'no retry after an aborted admission')
    }
    {
      // Physical release during a pending admission.
      const view = promptView()
      await view.attach()
      let finishAdmission!: (value: { readonly accepted: true }) => void
      view.access.promptImpl = async () => await new Promise(resolveAdmission => { finishAdmission = resolveAdmission })
      const attempt = view.start('release while admitting')
      view.registry.releaseConnection(view.conn, view.access)
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
      assert.deepEqual(unhandled, [], 'a released View must not leave the flight rejection unhandled')
      finishAdmission({ accepted: true })
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_ABORTED'))
      assert.equal(view.access.promptCalls.length, 1)
    }
    {
      // The exact Agent is disposed during a pending admission.
      const view = promptView()
      await view.attach()
      let finishAdmission!: (value: { readonly accepted: true }) => void
      view.access.promptImpl = async () => await new Promise(resolveAdmission => { finishAdmission = resolveAdmission })
      const attempt = view.start('dispose while admitting')
      view.registry.onAgentDisposed(view.agent)
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
      assert.deepEqual(unhandled, [], 'an Agent disposal must not leave the flight rejection unhandled')
      finishAdmission({ accepted: true })
      await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
        && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'agent-disposed')
      assert.equal(view.access.promptCalls.length, 1)
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a mixed turn drops notifications that were queued but not yet handed to the transport', async () => {
  const view = promptView()
  await view.attach()
  const gate = view.deferredSend()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 1, request.requestId)
  // Batch 1 must actually reach the transport (and block there) BEFORE the mix
  // is confirmed; batch 2 is queued behind it and still ours to drop.
  view.commit('assistant/message', assistantData(1, 'm-1', [{ type: 'text', text: 'already sending' }]))
  await flushOutput()
  view.commit('assistant/message', assistantData(1, 'm-2', [{ type: 'text', text: 'still queued' }]))
  // A TUI steer is claimed into the SAME turn AFTER both batches were queued.
  view.claim('m-steer', 1, 'tui-steer')
  gate.release()
  await flushOutput()
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'already sending' } },
  ], 'only the update already handed to the transport may be delivered')
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  assert.ok(!JSON.stringify(view.notifications).includes('still queued'))
})

// ── PO-3B: scoped cancellation + approval ownership contracts ──

test('C01: session/cancel on an idle attached View is a no-op that never touches the Host Agent', async () => {
  const view = promptView()
  await view.attach()
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.removedMessageIds, [], 'no inbox removal')
  assert.deepEqual(view.access.cancelledTurns, [], 'no Agent cancel')
  assert.equal(view.registry.hasClaim('P1'), true, 'the View stays attached')
  assert.equal(view.registry.phaseOf(view.conn), 'attached')
  // A cancel of a Session this connection does not hold is equally inert.
  view.registry.cancelSession(view.conn, view.access, 'OTHER')
  assert.deepEqual(view.access.cancelledTurns, [])
})

test('C02: a cancel of a QUEUED own message removes exactly it and answers cancelled after the admission classification', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.removedMessageIds, ['m-b'], 'exactly the queued own message is durably removed')
  assert.deepEqual(view.access.cancelledTurns, [], 'no Agent cancel is issued for a queued message')
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('C03: a cancel arriving BEFORE the durable insertion still removes the late-inserted message exactly once', async () => {
  const view = promptView()
  await view.attach()
  let finishAdmission!: (value: { readonly accepted: true }) => void
  view.access.promptImpl = () => new Promise(resolveAdmission => { finishAdmission = resolveAdmission })
  const attempt = view.start('late insert')
  const request = view.access.promptCalls[0]!
  // The cancellation arrives while the official admission is still pending.
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.removedMessageIds, [], 'nothing is removable before the durable id exists')
  // The late insertion callback observes the pending intent and removes it.
  view.insert(request.requestId, 'm-late')
  assert.deepEqual(view.access.removedMessageIds, ['m-late'], 'the late-inserted message is removed exactly once')
  finishAdmission({ accepted: true })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('C04: the remove/claim race never cancels a foreign turn (claim wins -> exact running cancel; remove wins -> settled)', async () => {
  {
    // Claim wins: between the cancel intent and the pending read, the official
    // inbox already claimed the message into its own turn, so the removal
    // misses and the SAME callback stack addresses the exact running turn.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    // The official claim takes the message out of the pending lists first.
    view.access.pendingInbox.delete('m-b')
    view.access.turnFence = { openTurnStartSeq: 500, lastTurn: 3 }
    view.access.agentStatus = 'running'
    view.claim('m-b', 3, request.requestId)
    // The cancel intent arrives AFTER the claim: the claim callback already
    // saved the authoritative turn, so this addresses the exact CURRENT turn.
    view.registry.cancelSession(view.conn, view.access, 'P1')
    assert.deepEqual(view.access.cancelledTurns, [{ turn: 3, keepInbox: true }], 'the exact claimed current turn is cancelled')
    assert.deepEqual(view.access.removedMessageIds, [], 'no removal is attempted once the turn owns the message')
    view.commit('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  }
  {
    // Remove wins: the durable removal happened before any claim; the next
    // foreign turn (a TUI C) is NEVER cancelled by this View.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    view.registry.cancelSession(view.conn, view.access, 'P1')
    assert.deepEqual(view.access.removedMessageIds, ['m-b'])
    // A foreign TUI turn runs and completes naturally.
    view.access.turnFence = { openTurnStartSeq: 700, lastTurn: 9 }
    view.access.agentStatus = 'running'
    view.claim('m-foreign', 9, 'tui-request')
    view.commit('assistant/message', assistantData(9, 'm-foreign', [{ type: 'text', text: 'tui answer' }]))
    view.commit('turn/end', { turn: 9, reason: { kind: 'completed' } })
    assert.deepEqual(view.access.cancelledTurns, [], 'the foreign TUI turn is never cancelled')
    assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  }
})

test('C05: a cancel of a RUNNING own turn answers cancelled only after the real user-aborted turn/end and drain', async () => {
  const view = promptView()
  await view.attach()
  const gate = view.deferredSend()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  view.access.agentStatus = 'running'
  view.claim('m-b', 4, request.requestId)
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [{ turn: 4, keepInbox: true }])
  view.commit('assistant/message', assistantData(4, 'm-b', [{ type: 'text', text: 'partial' }]))
  view.commit('turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  let settled = false
  void attempt.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the cancelled answer must wait for the notification drain')
  gate.release()
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('C06: a turn that already completed naturally keeps its REAL result (the cancel loses the race)', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 5 }
  view.access.agentStatus = 'running'
  view.claim('m-b', 5, request.requestId)
  view.commit('assistant/message', assistantData(5, 'm-b', [{ type: 'text', text: 'real answer' }]))
  // The turn completes BEFORE the cancel intent arrives.
  view.access.turnFence = { openTurnStartSeq: null, lastTurn: 5 }
  view.access.agentStatus = 'idle'
  view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'a settled turn is never cancelled')
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('C07: a cancel of a MIXED owned turn never cancels the Agent and keeps the D23 failure', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.claim('m-steer', 6, 'tui-steer')
  view.claim('m-b', 6, request.requestId)
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 6 }
  view.access.agentStatus = 'running'
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'a mixed turn is never Agent-cancelled')
  view.commit('turn/end', { turn: 6, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('A01/A03: an approval of the OWN running turn goes ONLY to this connection and maps the selected options', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.access.turnFence = { openTurnStartSeq: 700, lastTurn: 7 }
  view.claim('m-b', 7, request.requestId)
  let delegated = false
  const outcomePromise = view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-1' },
    async () => { delegated = true; return 'rejected' },
  )
  // Let the reverse request reach its channel (a real microtask hop).
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.permissionRequests.length, 1, 'exactly one reverse request was issued on this connection')
  const asked = view.permissionRequests[0]!
  assert.equal(asked.params.sessionId, 'P1')
  assert.deepEqual(asked.params.toolCall, { toolCallId: 'call-1' })
  assert.deepEqual(asked.params.options.map(option => option.kind), ['allow_once', 'reject_once'])
  asked.respond({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
  const outcome = await outcomePromise
  assert.equal(delegated, false, 'an ACP-owned approval is never delegated to the TUI channel')
  assert.equal(outcome, 'rejected')
  view.commit('turn/end', { turn: 7, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
})

test('A02: an approval of a TUI-owned turn is delegated exactly once', async () => {
  const view = promptView()
  await view.attach()
  // The View is idle: no flight, no retired fence; the official fence has an
  // open turn owned by the TUI.
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 12 }
  let delegated = 0
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-2' },
    async () => { delegated += 1; return 'allowed-once' },
  )
  assert.equal(delegated, 1, 'a TUI-owned approval is delegated exactly once')
  assert.equal(outcome, 'allowed-once')
  assert.equal(view.permissionRequests.length, 0, 'no reverse request was issued')
})

test('A04: a stale identity, an unknown optionId and a missing callId all fail closed without a grant', async () => {
  {
    // A missing callId on an OWNED turn is fail-closed, never delegated.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    view.access.pendingInbox.delete('m-b')
    view.access.turnFence = { openTurnStartSeq: 300, lastTurn: 3 }
    view.claim('m-b', 3, request.requestId)
    let delegated = false
    const outcome = await view.registry.onApprovalRequest(
      { agent: view.agent, toolName: 'bash' },
      async () => { delegated = true; return 'unavailable' },
    )
    assert.equal(outcome, 'unavailable')
    assert.equal(delegated, false, 'an owned approval without a callId never reaches the TUI')
    view.commit('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
  }
  {
    // An unknown optionId never grants.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    view.access.pendingInbox.delete('m-b')
    view.access.turnFence = { openTurnStartSeq: 400, lastTurn: 4 }
    view.claim('m-b', 4, request.requestId)
    const outcome = view.registry.onApprovalRequest(
      { agent: view.agent, toolName: 'bash', callId: 'call-3' },
      async () => 'rejected',
    )
    await new Promise(resolve => setImmediate(resolve))
    view.permissionRequests[0]!.respond({ outcome: { outcome: 'selected', optionId: 'allow-forever' } })
    assert.equal(await outcome, 'unavailable', 'an unknown optionId fails closed')
    view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
  }
  {
    // A stale exact identity is fail-closed without delegation.
    const view = promptView()
    await view.attach()
    view.access.turnFence = 'stale'
    let delegated = false
    const outcome = await view.registry.onApprovalRequest(
      { agent: view.agent, toolName: 'bash', callId: 'call-4' },
      async () => { delegated = true; return 'unavailable' },
    )
    assert.equal(outcome, 'unavailable')
    assert.equal(delegated, false, 'a stale fence never delegates')
  }
})

test('A05: an upstream signal abort settles the reverse request as cancelled (never a grant, never TUI fallback)', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.access.turnFence = { openTurnStartSeq: 800, lastTurn: 8 }
  view.claim('m-b', 8, request.requestId)
  const upstream = new AbortController()
  const outcome = view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-5', signal: upstream.signal },
    async () => 'allowed-once',
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.permissionRequests.length, 1)
  upstream.abort()
  view.permissionRequests[0]!.respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  assert.equal(await outcome, 'cancelled', 'the upstream abort wins over a late allow')
  view.commit('turn/end', { turn: 8, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
})

test('A06: an approval arriving AFTER the flight failed (retired turn) never leaks to the TUI', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.claim('m-b', 9, request.requestId)
  // The flight fails (e.g. an output delivery failure) BEFORE its turn ended.
  view.access.promptImpl = async () => ({ accepted: true })
  view.registry.onAgentError(view.agent, 9)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  // The old turn is STILL running on the Host (its official current-turn
  // fence still points at the retired turn): the late approval request must be
  // answered fail-closed by the retired-turn fence, never delegated.
  view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 9 }
  let delegated = false
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-late' },
    async () => { delegated = true; return 'allowed-once' },
  )
  assert.equal(delegated, false, 'a retired ACP turn approval never reaches the TUI')
  assert.equal(outcome, 'unavailable')
  // The fence dies on the real turn/end; a LATER TUI turn delegates again.
  view.commit('turn/end', { turn: 9, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 10 }
  let delegatedAfter = 0
  const outcomeAfter = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-next' },
    async () => { delegatedAfter += 1; return 'rejected' },
  )
  assert.equal(delegatedAfter, 1, 'after the retired fence died, a TUI turn delegates again')
  assert.equal(outcomeAfter, 'rejected')
})

test('a committed assistant message carrying a tool-call block projects the text and skips the block (the durable tool/call event owns it)', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 11, request.requestId)
  view.commit('tool/call', { turn: 11, step: 1, callId: 'call-9', name: 'bash', arguments: '{"command":"true"}' })
  // The SAME turn's assistant/message carries its tool-call block plus text.
  view.commit('assistant/message', assistantData(11, 'm-1', [
    { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"true"}' },
    { type: 'text', text: 'after the tool' },
  ]))
  view.commit('tool/result', {
    turn: 11,
    step: 1,
    message: { toolCallId: 'call-9', isError: false, content: [{ type: 'text', text: 'ok' }] },
  })
  view.commit('turn/end', { turn: 11, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  await flushOutput()
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), [
    'tool_call',
    'agent_message_chunk',
    'tool_call_update',
  ], 'the tool-call block in the assistant message is not duplicated or rejected')
})

test('RFL-001: a stale live-flight turn marker never suppresses the TUI responder of the current turn', async () => {
  {
    // The flight's claimed turn is no longer the official current turn: a
    // NEW turn (TUI-owned) is open. The request must be delegated.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    view.access.pendingInbox.delete('m-b')
    view.claim('m-b', 3, request.requestId)
    // The official fence moved on to a foreign turn.
    view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 4 }
    let delegated = 0
    const outcome = await view.registry.onApprovalRequest(
      { agent: view.agent, toolName: 'bash', callId: 'call-new-turn' },
      async () => { delegated += 1; return 'allowed-once' },
    )
    assert.equal(delegated, 1, 'a request of the NEW current (TUI-owned) turn is delegated')
    assert.equal(outcome, 'allowed-once')
    assert.equal(view.permissionRequests.length, 0, 'no reverse request is issued for a foreign turn')
    view.commit('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
  }
  {
    // The flight's turn terminalized (no open turn): the ask cannot legally
    // belong to it, so the classification fails closed instead of asking.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-b')
    view.access.pendingInbox.delete('m-b')
    view.claim('m-b', 5, request.requestId)
    view.access.turnFence = { openTurnStartSeq: null, lastTurn: 5 }
    let delegated = false
    const outcome = await view.registry.onApprovalRequest(
      { agent: view.agent, toolName: 'bash', callId: 'call-dead-turn' },
      async () => { delegated = true; return 'rejected' },
    )
    assert.equal(outcome, 'unavailable', 'a dead declared turn fails closed')
    assert.equal(delegated, false, 'a dead declared turn never reaches the TUI')
    view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
  }
})

test('RFL-002: an Agent disposal clears its retired-turn fence for good', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.access.pendingInbox.delete('m-b')
  view.claim('m-b', 7, request.requestId)
  // The Agent is disposed while the flight holds a claimed turn.
  view.registry.onAgentDisposed(view.agent)
  await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
    && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'agent-disposed')
  // No turn/end will ever arrive for the disposed Agent. A later approval
  // request must be delegated (no legal ACP owner remains), never trapped by
  // a stale retired fence.
  view.access.turnFence = { openTurnStartSeq: 1200, lastTurn: 8 }
  let delegated = 0
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-after-dispose' },
    async () => { delegated += 1; return 'rejected' },
  )
  assert.equal(delegated, 1, 'after disposal the request is delegated, not trapped')
  assert.equal(outcome, 'rejected')
})

test('F1: an SDK disconnect during a pending admission still removes the LATE-inserted message exactly', async () => {
  const view = promptView()
  await view.attach()
  let finishAdmission!: (value: { readonly accepted: true }) => void
  view.access.promptImpl = async () => await new Promise(resolveAdmission => { finishAdmission = resolveAdmission })
  const controller = new AbortController()
  const attempt = view.start('late after death', controller.signal)
  const request = view.access.promptCalls[0]!
  // The physical channel dies while the Host admission is still in flight.
  controller.abort(new Error('socket gone'))
  assert.deepEqual(view.access.removedMessageIds, [], 'nothing is removable before the durable id exists')
  assert.equal(view.registry.hasClaim('P1'), true, 'the claim keeps its attribution through the disconnect')
  // The official admission completes LATE and inserts the message: the
  // surviving fence must remove exactly it.
  view.access.pendingInbox.add('m-late-f1')
  view.registry.onInboxInserted(view.agent, view.message('m-late-f1', request.requestId))
  assert.deepEqual(view.access.removedMessageIds, ['m-late-f1'], 'the late-inserted message is removed exactly once')
  finishAdmission({ accepted: true })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('F1: a disconnect while the turn is running cancels the exact owned turn through the surviving claim', async () => {
  const view = promptView()
  await view.attach()
  const controller = new AbortController()
  const attempt = view.start('running at death', controller.signal)
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-run')
  view.access.pendingInbox.delete('m-run')
  view.access.turnFence = { openTurnStartSeq: 600, lastTurn: 6 }
  view.access.agentStatus = 'running'
  view.claim('m-run', 6, request.requestId)
  controller.abort(new Error('socket gone'))
  assert.deepEqual(view.access.cancelledTurns, [{ turn: 6, keepInbox: true }], 'the SDK abort routes through the scoped cancellation')
  assert.equal(view.notifications.length, 0, 'a dead channel delivers nothing')
  view.commit('turn/end', { turn: 6, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('F2: a close after an early flight failure keeps the retired-turn approval fence (no TUI leak)', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-f2')
  view.access.pendingInbox.delete('m-f2')
  view.claim('m-f2', 4, request.requestId)
  // The flight fails early (an output delivery failure) BEFORE its turn ended.
  view.registry.onAgentError(view.agent, 4)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  // The client closes the View; the old turn is STILL running.
  view.access.turnFence = { openTurnStartSeq: 400, lastTurn: 4 }
  await view.registry.closeSession(view.conn, view.access, 'P1')
  // A late approval of that exact turn must NOT be delegated to the TUI.
  let delegated = false
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-f2' },
    async () => { delegated = true; return 'allowed-once' },
  )
  assert.equal(delegated, false, 'the retired ACP turn approval never reaches the TUI after the close')
  assert.equal(outcome, 'unavailable')
  // The fence dies on the real turn/end; a LATER TUI turn delegates again.
  view.commit('turn/end', { turn: 4, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  view.access.turnFence = { openTurnStartSeq: 500, lastTurn: 5 }
  let delegatedAfter = 0
  await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-next' },
    async () => { delegatedAfter += 1; return 'rejected' },
  )
  assert.equal(delegatedAfter, 1, 'after the fence died a TUI turn delegates again')
})

test('F2: a physical disconnect after an early flight failure keeps the retired-turn fence too', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-f2b')
  view.access.pendingInbox.delete('m-f2b')
  view.claim('m-f2b', 7, request.requestId)
  view.registry.onAgentError(view.agent, 7)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  view.access.turnFence = { openTurnStartSeq: 700, lastTurn: 7 }
  view.registry.releaseConnection(view.conn, view.access)
  let delegated = false
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-f2b' },
    async () => { delegated = true; return 'allowed-once' },
  )
  assert.equal(delegated, false, 'a disconnect does not leak the retired ACP turn approval to the TUI')
  assert.equal(outcome, 'unavailable')
  view.commit('turn/end', { turn: 7, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  // The fence died with the real terminal; a new TUI turn is delegated.
  view.access.turnFence = { openTurnStartSeq: 800, lastTurn: 8 }
  let delegatedAfter = 0
  await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-after' },
    async () => { delegatedAfter += 1; return 'rejected' },
  )
  assert.equal(delegatedAfter, 1)
})

test('RFL-005: a failure landing DURING the disconnect keeps its retired fence and never leaks the approval', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-r5')
  view.access.pendingInbox.delete('m-r5')
  view.claim('m-r5', 3, request.requestId)
  view.access.turnFence = { openTurnStartSeq: 300, lastTurn: 3 }
  view.access.agentStatus = 'running'
  // The disconnect's scoped cancellation aborts the exact turn; the flight
  // then ALSO fails (the race: a real failure beats the aborted turn/end).
  view.access.cancelCurrentTurnImpl = turn => {
    const result = view.access.cancelCurrentTurnImpl === undefined ? 'not-current' : 'addressed'
    void turn
    view.access.cancelledTurns.push({ turn, keepInbox: true })
    view.access.agentStatus = 'idle'
    view.access.turnFence = { openTurnStartSeq: null, lastTurn: turn }
    // The racing failure lands before the real terminal record.
    view.registry.onAgentError(view.agent, turn)
    return result
  }
  view.registry.releaseConnection(view.conn, view.access)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  // The late approval of the still-running turn must NOT reach the TUI even
  // though the disconnect task already finished its cancellation.
  view.access.turnFence = { openTurnStartSeq: 300, lastTurn: 3 }
  let delegated = false
  const outcome = await view.registry.onApprovalRequest(
    { agent: view.agent, toolName: 'bash', callId: 'call-r5' },
    async () => { delegated = true; return 'allowed-once' },
  )
  assert.equal(delegated, false, 'a fence born during the disconnect never leaks to the TUI')
  assert.equal(outcome, 'unavailable')
  // The fence dies on the real terminal and the claim is RELEASED (RFL-006).
  view.commit('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(view.registry.hasClaim('P1'), false, 'the fenced claim is released at the fence death')
})

test('RFL-006: a detached fenced claim is released on the real turn/end and the Session is attachable again', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-r6')
  view.access.pendingInbox.delete('m-r6')
  view.claim('m-r6', 5, request.requestId)
  view.registry.onAgentError(view.agent, 5)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  // A close detaches the View while the fence is alive.
  view.access.turnFence = { openTurnStartSeq: 500, lastTurn: 5 }
  await view.registry.closeSession(view.conn, view.access, 'P1')
  assert.equal(view.registry.hasClaim('P1'), true, 'the fenced claim survives the close')
  // The real terminal ends the fence AND releases the claim.
  view.commit('turn/end', { turn: 5, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  assert.equal(view.registry.hasClaim('P1'), false, 'the claim is released at the fence death (no permanent ALREADY_ATTACHED)')
  // A fresh connection may attach the SAME Session again.
  const conn2 = view.registry.createConnection()
  await view.registry.resumeSession(conn2, view.access, { sessionId: 'P1', cwd: '/w' })
  assert.equal(view.registry.phaseOf(conn2), 'attached')
})

test('RFL-006: an Agent disposal also releases a detached fenced claim', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-r6b')
  view.access.pendingInbox.delete('m-r6b')
  view.claim('m-r6b', 6, request.requestId)
  view.registry.onAgentError(view.agent, 6)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  view.access.turnFence = { openTurnStartSeq: 600, lastTurn: 6 }
  view.registry.releaseConnection(view.conn, view.access)
  assert.equal(view.registry.hasClaim('P1'), true, 'the fenced claim survives the disconnect')
  // The disposal ends the fence and releases the detached claim.
  view.registry.onAgentDisposed(view.agent)
  assert.equal(view.registry.hasClaim('P1'), false, 'the disposal releases the fenced claim')
})

test('PO3A-G replay: mixed fail -> later clean turns -> close -> a fresh connection attaches the SAME Session', async () => {
  const view = promptView()
  await view.attach()
  // E: a mixed turn fails closed after its own turn/end.
  const mixedAttempt = view.start('mixed')
  const mixedRequest = view.access.promptCalls[0]!
  view.insert(mixedRequest.requestId, 'm-mixed')
  view.access.pendingInbox.delete('m-mixed')
  view.claim('m-steer', 2, 'tui-steer')
  view.claim('m-mixed', 2, mixedRequest.requestId)
  view.commit('assistant/message', assistantData(2, 'm-mixed', [{ type: 'text', text: 'half' }]))
  view.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await assert.rejects(mixedAttempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  await flushOutput()
  // F: later clean turns settle normally.
  const cleanAttempt = view.start('clean')
  const cleanRequest = view.access.promptCalls[1]!
  view.insert(cleanRequest.requestId, 'm-clean')
  view.access.pendingInbox.delete('m-clean')
  view.claim('m-clean', 3, cleanRequest.requestId)
  view.commit('assistant/message', assistantData(3, 'm-clean', [{ type: 'text', text: 'answer' }]))
  view.commit('turn/end', { turn: 3, reason: { kind: 'completed' } })
  assert.deepEqual(await cleanAttempt, { stopReason: 'end_turn' })
  // G: close, then a FRESH connection attaches the SAME Session.
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {})
  assert.equal(view.registry.hasClaim('P1'), false, 'the mixed-failed claim is fully released')
  const conn3 = view.registry.createConnection()
  await view.registry.resumeSession(conn3, view.access, { sessionId: 'P1', cwd: '/w' })
  assert.equal(view.registry.phaseOf(conn3), 'attached')
})

test('R701-04: a close pending over a MIXED turn detaches after the real turn/end (no cached failure)', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('mixed close')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-mixed-close')
  view.access.pendingInbox.delete('m-mixed-close')
  view.access.turnFence = { openTurnStartSeq: 500, lastTurn: 5 }
  view.access.agentStatus = 'running'
  view.claim('m-mixed-close', 5, request.requestId)
  // A TUI steer is claimed into the SAME turn BEFORE the close.
  view.claim('m-steer-close', 5, 'tui-steer')
  // The client closes the View while the mixed turn is STILL running.
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  // D23: the mixed turn is never Agent-cancelled.
  assert.deepEqual(view.access.cancelledTurns, [], 'the mixed turn keeps running (never Agent-cancelled)')
  // The turn reaches its real terminal: the PROMPT keeps its mixed failure.
  view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  // ...and the SAME close completes instead of caching that prompt failure.
  assert.deepEqual(await closing, {}, 'the close detaches after the proven Host terminal')
  assert.equal(view.registry.hasClaim('P1'), false, 'the claim is released')
  // A repeated close stays idempotent.
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {})
  // A FRESH connection can resume the SAME Session.
  const conn2 = view.registry.createConnection()
  await view.registry.resumeSession(conn2, view.access, { sessionId: 'P1', cwd: '/w' })
  assert.equal(view.registry.phaseOf(conn2), 'attached')
})

test('R701-04 sibling: a close pending over a turn that ends with a real FAILURE also detaches truthfully', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('failing close')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-fail-close')
  view.access.pendingInbox.delete('m-fail-close')
  view.access.turnFence = { openTurnStartSeq: 700, lastTurn: 7 }
  view.access.agentStatus = 'running'
  view.claim('m-fail-close', 7, request.requestId)
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  // The owned turn reaches a real ERROR terminal (not a cancellation).
  view.commit('turn/end', { turn: 7, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
  await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
    && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'error')
  assert.deepEqual(await closing, {}, 'the close completes on the real failed terminal')
  assert.equal(view.registry.hasClaim('P1'), false)
})

test('R701-04 negative: an UNPROVEN close (stale identity) still fails closed and keeps the View', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-stale-close')
  view.access.pendingInbox.delete('m-stale-close')
  view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 9 }
  view.access.agentStatus = 'running'
  view.claim('m-stale-close', 9, request.requestId)
  // The exact identity is gone: neither removal nor turn cancel can be proven.
  view.access.turnFence = 'stale'
  await assert.rejects(view.registry.closeSession(view.conn, view.access, 'P1'),
    isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
  assert.equal(view.registry.hasClaim('P1'), true, 'an unproven close never detaches')
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
})

test('R701-04 sibling: an Agent disposal during a pending close lets the close complete', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-disp-close')
  view.access.pendingInbox.delete('m-disp-close')
  view.access.turnFence = { openTurnStartSeq: 300, lastTurn: 3 }
  view.access.agentStatus = 'running'
  view.claim('m-disp-close', 3, request.requestId)
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  view.registry.onAgentDisposed(view.agent)
  await assert.rejects(attempt, (error: unknown) => error instanceof LocalAcpViewError
    && error.code === 'LOCAL_ACP_PROMPT_TURN_FAILED' && error.data.reason === 'agent-disposed')
  assert.deepEqual(await closing, {}, 'the disposed Agent is a provable terminal: real detach, no error')
  assert.equal(view.registry.hasClaim('P1'), false, 'the claim is released')
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {}, 'repeated close is idempotent')
})

test('R701-04 sibling: an early failure during a pending close fails ONCE, then a later close succeeds on the real terminal', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-early-close')
  view.access.pendingInbox.delete('m-early-close')
  view.access.turnFence = { openTurnStartSeq: 400, lastTurn: 4 }
  view.access.agentStatus = 'running'
  view.claim('m-early-close', 4, request.requestId)
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  // The flight fails early while its turn is still running: the close cannot
  // claim a settlement and reports the real failure.
  view.registry.onAgentError(view.agent, 4)
  await assert.rejects(closing, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  assert.equal(view.registry.hasClaim('P1'), true, 'the fenced claim survives the failed close')
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  // The real turn terminal ends the fence: a repeated close now succeeds.
  view.commit('turn/end', { turn: 4, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {},
    'the close re-evaluates on the now-proven terminal instead of replaying the stale failure')
  assert.equal(view.registry.hasClaim('P1'), false)
})

test('LC-01: an UNCONFIRMED unclaimed cancellation is never turned into a successful close by a repeat close', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  // The durable message EXISTS but was never claimed (no turn yet).
  view.insert(request.requestId, 'm-lc1')
  view.access.pendingInbox.delete('m-lc1')
  // The exact identity is gone: the pending removal cannot be proven.
  view.access.turnFence = 'stale'
  const first = view.registry.closeSession(view.conn, view.access, 'P1')
  await assert.rejects(first, isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
  assert.deepEqual(view.access.removedMessageIds, [], 'no removal was ever proven')
  // A repeat close must NOT succeed merely because the local flight is gone.
  await assert.rejects(view.registry.closeSession(view.conn, view.access, 'P1'),
    isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
  assert.equal(view.registry.hasClaim('P1'), true, 'the reservation survives an unconfirmed obligation')
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'the Host work is still unsettled')
  // A minted Prompt is refused while the old Host responsibility is open.
  const second = view.start('while fenced').then(() => 'resolved' as const, (error: unknown) => error)
  const raced = await Promise.race([
    second,
    // Bounded negative observation: the refusal must arrive without any new Host fact.
    new Promise<'timeout'>(resolve => { setTimeout(() => { resolve('timeout') }, 1_000) }),
  ])
  assert.ok(raced instanceof LocalAcpViewError && raced.code === 'LOCAL_ACP_PROMPT_IN_FLIGHT',
    `a Prompt must be refused while the old Host obligation is open (got ${String(raced)})`)
  // The exact Agent's disposal is a real terminal fact that settles it.
  view.registry.onAgentDisposed(view.agent)
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {},
    'only the real terminal fact allows the detach')
  assert.equal(view.registry.hasClaim('P1'), false)
})

test('LC-02: a physical disconnect keeps the unconfirmed unclaimed obligation and its Host attribution', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-lc2')
  view.access.pendingInbox.delete('m-lc2')
  view.access.turnFence = 'stale'
  view.registry.closeSession(view.conn, view.access, 'P1').catch(() => {})
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED'))
  // The socket is gone, but the Host work is not: the claim, its Session
  // reservation and the fact observer must all survive.
  view.registry.releaseConnection(view.conn, view.access)
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.equal(view.registry.hasClaim('P1'), true, 'the obligation claim survives the disconnect')
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'the Host work is still unsettled (observer retained)')
  // Another ACP connection must NOT silently take over the same Session.
  const other = view.registry.createConnection()
  await assert.rejects(view.registry.resumeSession(other, view.access, { sessionId: 'P1', cwd: '/w' }),
    isViewError('LOCAL_ACP_VIEW_ALREADY_ATTACHED'))
  // The exact Agent's disposal is a real terminal proof: the obligation ends,
  // the detached claim is released, and the Session becomes attachable again.
  view.registry.onAgentDisposed(view.agent)
  assert.equal(view.registry.hasClaim('P1'), false, 'the terminal fact releases the detached claim')
  assert.equal(view.registry.hasUnsettledHostWork(), false)
  await view.registry.resumeSession(other, view.access, { sessionId: 'P1', cwd: '/w' })
  assert.equal(view.registry.phaseOf(other), 'attached')
})

test('a same-id edit or steer retains an unclaimed obligation until official pending absence proves removal', async () => {
  const view = promptView()
  await view.attach()
  view.access.promptImpl = async request => {
    view.insert(request.requestId, 'm-edit')
    throw new Error('admission failed after insertion')
  }
  await assert.rejects(view.start(), isPromptError('LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE'))
  const message = view.message('m-edit', view.access.promptCalls[0]!.requestId)
  // replace commits the replacement projection before discarded(old), then inserted(new).
  view.registry.onInboxDiscarded(view.agent, message)
  view.registry.onInboxInserted(view.agent, message)
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'discarded alone is no terminal proof')
  await Promise.resolve()
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'the same id is still officially pending')
  // steer removes, then reinserts in next-step in the same synchronous stack.
  view.access.pendingInbox.delete(message.id)
  view.registry.onInboxDiscarded(view.agent, message)
  view.access.pendingInbox.add(message.id)
  view.registry.onInboxInserted(view.agent, message)
  await Promise.resolve()
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'same-stack steer reinsertion retains the obligation')
  // A stale exact identity cannot prove removal even when its old inbox is empty.
  view.access.pendingInbox.delete(message.id)
  view.registry.onInboxDiscarded(view.agent, message)
  const replacement = makeAgent('P1', '/w')
  view.access.seed(replacement)
  await Promise.resolve()
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'a stale checkpoint retains the responsibility')
  view.access.seed(view.agent)
  view.registry.onInboxDiscarded(view.agent, message)
  await view.registry.whenHostWorkSettled()
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {})
})

test('a true external queued removal settles an active flight only after admission classification', async () => {
  const view = promptView()
  await view.attach()
  const admission = deferred<{ readonly accepted: true }>()
  view.access.promptImpl = () => admission.promise
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-remove')
  view.access.pendingInbox.delete('m-remove')
  view.registry.onInboxDiscarded(view.agent, view.message('m-remove', request.requestId))
  await Promise.resolve()
  assert.equal(view.registry.hasUnsettledHostWork(), true, 'the real admission still owes its classification')
  admission.resolve({ accepted: true })
  // The bounded microtask drain covers admission -> queued-removal -> output settlement.
  for (let step = 0; step < 12; step += 1) await Promise.resolve()
  assert.equal(view.registry.hasUnsettledHostWork(), false, 'the external removal must not strand the live Flight')
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  assert.deepEqual(view.access.removedMessageIds, [], 'the checkpoint observes removal without issuing another remove')
})

test('an admission error after proven external removal keeps its error and creates no new Host obligation', async () => {
  const view = promptView()
  await view.attach()
  const admission = deferred<{ readonly accepted: true }>()
  view.access.promptImpl = () => admission.promise
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-remove-error')
  view.access.pendingInbox.delete('m-remove-error')
  view.registry.onInboxDiscarded(view.agent, view.message('m-remove-error', request.requestId))
  await Promise.resolve()
  admission.reject(new Error('admission failed after the removal'))
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE'))
  assert.equal(view.registry.hasUnsettledHostWork(), false, 'the proven removal remains terminal despite the admission error')
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {})
})

test('a detached retired claim cannot dispatch a prompt after the same connection attaches another Session', async () => {
  const view = promptView('A')
  await view.attach()
  const original = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-retired')
  view.claim('m-retired', 1, request.requestId)
  view.registry.onAgentError(view.agent, 1)
  await assert.rejects(original, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  await view.registry.closeSession(view.conn, view.access, 'A')
  view.access.seed(makeAgent('B', '/w'))
  await view.registry.resumeSession(view.conn, view.access, { sessionId: 'B', cwd: '/w' })
  view.access.promptImpl = async () => { throw new Error('unexpected dispatch to retired Session') }
  await assert.rejects(view.start(), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))
  assert.equal(view.access.promptCalls.length, 1, 'the retired reservation is observation-only')
  assert.equal(view.registry.phaseOf(view.conn), 'attached')
  view.registry.onAgentDisposed(view.agent)
  assert.equal(view.registry.hasClaim('A'), false)
  assert.equal(view.registry.hasClaim('B'), true)
})

for (const stage of ['attaching', 'attached'] as const) {
  test(`a repeat close of a detached retired Session preserves the newer ${stage} View`, async () => {
    const view = promptView('A')
    await view.attach()
    const original = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-retired')
    view.claim('m-retired', 1, request.requestId)
    view.registry.onAgentError(view.agent, 1)
    await assert.rejects(original, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
    await view.registry.closeSession(view.conn, view.access, 'A')
    const agentB = makeAgent('B', '/w')
    view.access.seed(agentB)
    view.access.seed(makeAgent('C', '/w'))
    const resolution = deferred<{ agent: LiveAgentViewIdentity }>()
    if (stage === 'attaching') view.access.resolveAgentImpl = () => resolution.promise
    const attaching = view.registry.resumeSession(view.conn, view.access, { sessionId: 'B', cwd: '/w' })
    if (stage === 'attached') await attaching
    const op = view.conn.op
    assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'A'), {})
    assert.equal(view.registry.phaseOf(view.conn), stage, 'old close must not reset the current phase')
    assert.equal(view.conn.op, op, 'old close must not change the current operation')
    await assert.rejects(view.registry.resumeSession(view.conn, view.access, { sessionId: 'C', cwd: '/w' }), isViewError('LOCAL_ACP_VIEW_BUSY'))
    if (stage === 'attaching') {
      resolution.resolve({ agent: agentB })
      await attaching
    }
    view.commit('turn/end', { turn: 1, reason: { kind: 'error' } })
    assert.equal(view.registry.hasClaim('A'), false, 'the old callback releases only its own reservation')
    assert.equal(view.registry.hasClaim('B'), true)
    assert.equal(view.registry.phaseOf(view.conn), 'attached')
    view.registry.releaseConnection(view.conn, view.access)
    assert.equal(view.registry.phaseOf(view.conn), 'closed')
    assert.equal(view.registry.hasClaim('B'), false)
    view.registry.onAgentDisposed(view.agent)
    assert.equal(view.registry.phaseOf(view.conn), 'closed', 'an old callback cannot resurrect the connection')
  })
}

test('a close already awaiting an old turn cannot reopen a physically disconnected connection', async () => {
  const view = promptView('A')
  await view.attach()
  const original = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-closing')
  view.claim('m-closing', 1, request.requestId)
  view.claim('m-tui', 1, 'tui')
  const closing = view.registry.closeSession(view.conn, view.access, 'A')
  view.registry.releaseConnection(view.conn, view.access)
  const op = view.conn.op
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await assert.rejects(original, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  assert.deepEqual(await closing, {})
  assert.equal(view.registry.phaseOf(view.conn), 'closed', 'the old close completion cannot write idle after disconnect')
  assert.equal(view.conn.op, op)
  assert.equal(view.registry.hasClaim('A'), false)
})

test('a same-id ACP steer into TUI C refreshes provenance from A to C before its claim', async () => {
  const view = promptView()
  await view.attach()
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 1 }
  view.access.agentStatus = 'running'
  view.claim('m-tui-a', 1, 'tui-a')
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-b')
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // TUI C was ahead of B in next-turn and starts naturally after A ends.
  view.access.turnFence = { openTurnStartSeq: 200, lastTurn: 2 }
  view.access.agentStatus = 'running'
  view.claim('m-tui-c', 2, 'tui-c')
  // The same official B id is steered from next-turn into C's next-step.
  view.access.pendingInbox.delete('m-b')
  view.registry.onInboxDiscarded(view.agent, view.message('m-b', request.requestId))
  view.insert(request.requestId, 'm-b')
  await Promise.resolve()
  view.claim('m-b', 2, request.requestId)
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'B cannot cancel TUI C')
  let delegated = 0
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'tui-c-ask' }, async () => {
    delegated += 1
    return 'allowed-once'
  }), 'allowed-once')
  assert.equal(delegated, 1, 'C retains its own responder after the ID-preserving steer')
  assert.equal(view.permissionRequests.length, 0)
  view.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('a foreign next-step claim in an ACP-started turn does not take its approval owner', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-acp-turn')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  view.access.agentStatus = 'running'
  // Inbox.claim handles the older TUI next-step item before ACP B's next-turn item.
  view.claim('m-old-tui-next-step', 4, 'tui')
  view.claim('m-acp-turn', 4, request.requestId)
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'a mixed turn remains untouched')
  let delegated = 0
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'acp-turn-ask' }, async () => {
    delegated += 1
    return 'allowed-once'
  }), 'unavailable')
  assert.equal(delegated, 0, 'foreign-first claim order does not transfer approval authority')
  assert.equal(view.permissionRequests.length, 0)
  view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('a TUI turn open before ACP insertion keeps approval even when the TUI claim is first', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  view.access.agentStatus = 'running'
  // The own message insertion checkpoint sees the already-open TUI turn.
  view.insert(request.requestId, 'm-late-borrowed')
  view.claim('m-late-tui', 4, 'tui')
  view.claim('m-late-borrowed', 4, request.requestId)
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [])
  let delegated = 0
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'late-start-tui' }, async () => {
    delegated += 1
    return 'allowed-once'
  }), 'allowed-once')
  assert.equal(delegated, 1)
  assert.equal(view.permissionRequests.length, 0)
  view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('an ACP steer into a turn open before its flight preserves TUI approval and never cancels the shared turn', async () => {
  const view = promptView()
  await view.attach()
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  view.access.agentStatus = 'running'
  view.claim('m-original-tui', 4, 'tui')
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-borrowed')
  view.access.pendingInbox.delete('m-borrowed')
  view.registry.onInboxDiscarded(view.agent, view.message('m-borrowed', request.requestId))
  view.insert(request.requestId, 'm-borrowed')
  view.claim('m-borrowed', 4, request.requestId)
  await Promise.resolve()
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'the original TUI turn may not be cancelled')
  let delegated = 0
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'tui-ask' }, async () => {
    delegated += 1
    return 'allowed-once'
  }), 'allowed-once')
  assert.equal(delegated, 1, 'the original TUI responder runs exactly once')
  assert.equal(view.permissionRequests.length, 0)
  view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('TUI approval provenance survives a flight failure before or after its message is claimed', async () => {
  for (const stage of ['unclaimed', 'claimed'] as const) {
    const view = promptView()
    await view.attach()
    view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
    view.access.agentStatus = 'running'
    view.claim('m-tui', 4, 'tui')
    if (stage === 'unclaimed') {
      view.access.promptImpl = async request => {
        view.insert(request.requestId, 'm-borrowed-failed')
        throw new Error('admission failed after insertion')
      }
    }
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    if (stage === 'unclaimed') {
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_DISPATCH_INDETERMINATE'))
      // The existing unclaimed record must survive a same-stack steer.
      view.access.pendingInbox.delete('m-borrowed-failed')
      view.registry.onInboxDiscarded(view.agent, view.message('m-borrowed-failed', request.requestId))
      view.insert(request.requestId, 'm-borrowed-failed')
      view.claim('m-borrowed-failed', 4, request.requestId)
      await Promise.resolve()
    } else {
      view.insert(request.requestId, 'm-borrowed-failed')
      view.claim('m-borrowed-failed', 4, request.requestId)
      view.registry.onAgentError(view.agent, 4)
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
    }
    assert.equal(view.registry.hasUnsettledHostWork(), true, 'the borrowed turn remains open')
    // Detachment must preserve the TUI responder through the existing retired record.
    await view.registry.closeSession(view.conn, view.access, 'P1')
    let delegated = 0
    assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'late-tui' }, async () => {
      delegated += 1
      return 'rejected'
    }), 'rejected', stage)
    assert.equal(delegated, 1, stage)
    assert.equal(view.permissionRequests.length, 0, stage)
    view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
    assert.equal(view.registry.hasClaim('P1'), false, 'the real terminal releases the detached record')
  }
})

test('a later flight joining a retired ACP turn remains mixed and never delegates its approval', async () => {
  const view = promptView()
  await view.attach()
  const original = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-original-acp')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  view.access.agentStatus = 'running'
  view.claim('m-original-acp', 4, request.requestId)
  view.registry.onAgentError(view.agent, 4)
  await assert.rejects(original, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  const later = view.start()
  const laterRequest = view.access.promptCalls[1]!
  view.insert(laterRequest.requestId, 'm-later-acp')
  let delegated = 0
  const next = async () => { delegated += 1; return 'allowed-once' as const }
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'retired-ask' }, next), 'unavailable')
  view.claim('m-later-acp', 4, laterRequest.requestId)
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.deepEqual(view.access.cancelledTurns, [], 'joining an already owned turn is mixed even without a new foreign claim')
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'mixed-ask' }, next), 'unavailable')
  assert.equal(delegated, 0)
  assert.equal(view.permissionRequests.length, 0)
  view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  await assert.rejects(later, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('a queued flight claimed into a new turn after the old TUI turn ended keeps ACP approval ownership', async () => {
  const view = promptView()
  await view.attach()
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 4 }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-new-turn')
  view.commit('turn/end', { turn: 4, reason: { kind: 'completed' } })
  view.access.turnFence = { openTurnStartSeq: 200, lastTurn: 5 }
  view.claim('m-new-turn', 5, request.requestId)
  let delegated = 0
  const outcome = view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'new-turn-ask' }, async () => {
    delegated += 1
    return 'rejected'
  })
  await Promise.resolve()
  assert.equal(view.permissionRequests.length, 1)
  view.permissionRequests[0]!.respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  assert.equal(await outcome, 'allowed-once')
  assert.equal(delegated, 0)
  view.commit('assistant/message', assistantData(5, 'm-new-turn', [{ type: 'text', text: 'new ACP answer' }]))
  view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('LC-04: an early failure + claimed turn detaches after the real turn/end and the prompt keeps its own error', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-lc4')
  view.access.pendingInbox.delete('m-lc4')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 2 }
  view.access.agentStatus = 'running'
  view.claim('m-lc4', 2, request.requestId)
  // The flight fails early while its claimed turn still runs.
  view.registry.onAgentError(view.agent, 2)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  let delegated = 0
  assert.equal(await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'bash', callId: 'late-acp' }, async () => {
    delegated += 1
    return 'allowed-once'
  }), 'unavailable')
  assert.equal(delegated, 0, 'the early failed ACP turn remains fail-closed before its terminal')
  // The real terminal ends the turn: close detaches and a new connection resumes.
  view.commit('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'P1'), {})
  assert.equal(view.registry.hasClaim('P1'), false)
  const next = view.registry.createConnection()
  await view.registry.resumeSession(next, view.access, { sessionId: 'P1', cwd: '/w' })
  assert.equal(view.registry.phaseOf(next), 'attached')
})

// ---------------------------------------------------------------------------
// PO-4C: committed assistant/tool standard content output.
// ---------------------------------------------------------------------------

/** One committed image block naming a structural official image reference. */
function imageBlock(attachmentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'image',
    attachment: {
      attachmentId,
      mediaType: 'image/png',
      bytes: 8,
      width: 1,
      height: 1,
      ...overrides,
    },
  }
}

/** One committed tool result message carrying ordered content blocks. */
function toolResultData(turn: number, toolCallId: string, isError: boolean, blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { turn, step: 1, message: { toolCallId, isError, content: blocks } }
}

const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('PO-4C C-L1-01: an assistant text/image/text message projects every committed block in order with Store-verified bytes', async () => {
  const view = promptView()
  await view.attach()
  // The fake Store returns the VERIFIED media type; the committed block's own
  // `mediaType` is ignored, so a block can never dictate the wire MIME.
  view.access.storedImages.set('sha256:img1', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const attempt = view.start('po4c:assistant-mixed:v1')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-po4c')
  view.claim('m-po4c', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-po4c', [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'before\r\n' },
    imageBlock('sha256:img1', { mediaType: 'image/webp' }),
    { type: 'text', text: 'after 中文🙂\n' },
  ]))
  await flushOutput()
  assert.equal(view.access.imageReadCalls.length, 1, 'the committed reference is read exactly once')
  assert.deepEqual(view.access.imageReadCalls[0], {
    attachmentId: 'sha256:img1', mediaType: 'image/webp', bytes: 8, width: 1, height: 1,
  })
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'agent_thought_chunk', messageId: 'm-po4c', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-po4c', content: { type: 'text', text: 'before\r\n' } },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-po4c',
      content: { type: 'image', data: Buffer.from(IMAGE_BYTES).toString('base64'), mimeType: 'image/png' },
    },
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-po4c', content: { type: 'text', text: 'after 中文🙂\n' } },
  ])
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('PO-4C C-L1-01: an image-only assistant message is valid visible output (and reasoning-only still fails closed)', async () => {
  {
    const view = promptView()
    await view.attach()
    view.access.storedImages.set('sha256:only', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
    const attempt = view.start('po4c:assistant-image-only:v1')
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-image-only')
    view.claim('m-image-only', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-image-only', [{ type: 'reasoning', text: 'plan' }, imageBlock('sha256:only')]))
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'an image is visible output: no NO_ASSISTANT_TEXT')
    assert.deepEqual(view.notifications.map(updateKind), ['agent_thought_chunk', 'agent_message_chunk'])
    assert.equal(chunkOf(view.notifications[1]).type, 'image')
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-reasoning')
    view.claim('m-reasoning', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-reasoning', [{ type: 'reasoning', text: 'thinking only' }]))
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT'))
  }
})

test('PO-4C C-L1-02: one committed tool result becomes ONE ordered text/image tool_call_update with the durable status and callId', async () => {
  const a2ui = 'A2UI_JSON={"version":"popo.a2ui/1","components":[]}'
  const view = promptView()
  await view.attach()
  view.access.storedImages.set('sha256:tool-img', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-tool')
  view.claim('m-tool', 1, request.requestId)
  view.commit('tool/call', { turn: 1, step: 1, callId: 'call-po4c', name: 'po4c_tool', arguments: 'not-json{' })
  view.commit('tool/result', toolResultData(1, 'call-po4c', false, [
    { type: 'text', text: a2ui },
    imageBlock('sha256:tool-img'),
    { type: 'text', text: 'tool-tail\n' },
  ]))
  view.commit('assistant/message', assistantData(1, 'm-answer', [{ type: 'text', text: 'tool completed\n' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  assert.deepEqual(view.notifications, [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-po4c',
      title: 'po4c_tool',
      kind: 'other',
      status: 'in_progress',
      rawInput: 'not-json{',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-po4c',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: a2ui } },
        {
          type: 'content',
          content: { type: 'image', data: Buffer.from(IMAGE_BYTES).toString('base64'), mimeType: 'image/png' },
        },
        { type: 'content', content: { type: 'text', text: 'tool-tail\n' } },
      ],
    },
    { sessionUpdate: 'agent_message_chunk', messageId: 'm-answer', content: { type: 'text', text: 'tool completed\n' } },
  ])
  assert.equal(view.notifications.filter(update => updateKind(update) === 'tool_call_update').length, 1,
    'one committed tool result is exactly one update, never one per content block')
  assert.equal(view.notifications.filter(update => updateKind(update) === 'tool_call').length, 1,
    'the assistant tool-call block never duplicates the durable tool/call start')
})

test('PO-4C C-L1-02: a failed tool result keeps its official isError status', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('po4c:tool-failed:v1')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-failed')
  view.claim('m-failed', 1, request.requestId)
  view.commit('tool/call', { turn: 1, step: 1, callId: 'call-fail', name: 'po4c_tool', arguments: '{"x":1}' })
  view.commit('tool/result', toolResultData(1, 'call-fail', true, [{ type: 'text', text: 'tool exploded: error' }]))
  view.commit('assistant/message', assistantData(1, 'm-failed', [{ type: 'text', text: 'tool failed\n' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  const update = view.notifications.find(candidate => updateKind(candidate) === 'tool_call_update')
  assert.deepEqual(update, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-fail',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'tool exploded: error' } }],
  })
})

test('PO-4C C-L1-03: a held Store read blocks every later committed event (single FIFO, no reordering)', async () => {
  const view = promptView()
  await view.attach()
  view.access.storedImages.set('sha256:held', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const readStarted = deferred<void>()
  const readGate = deferred<AcpStoredImage>()
  view.access.imageReadImpl = async () => {
    readStarted.resolve()
    return await readGate.promise
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-fifo')
  view.claim('m-fifo', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-fifo', [
    { type: 'text', text: 'first' },
    imageBlock('sha256:held'),
  ]))
  await readStarted.promise
  // Later committed events arrive while the first event's image read is held.
  view.commit('tool/call', { turn: 1, step: 2, callId: 'call-after', name: 'po4c_tool', arguments: '{}' })
  view.commit('tool/result', toolResultData(1, 'call-after', false, [{ type: 'text', text: 'after image' }]))
  view.commit('assistant/message', assistantData(1, 'm-after', [{ type: 'text', text: 'answer' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  let settled = false
  void attempt.then(() => { settled = true }, () => { settled = true })
  await flushOutput()
  assert.deepEqual(view.notifications, [], 'nothing overtakes the held image read')
  assert.equal(settled, false, 'turn/end is not a delivery proof: settlement waits for the tail')
  readGate.resolve({ data: IMAGE_BYTES, mediaType: 'image/png' })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  assert.deepEqual(view.notifications.map(updateKind), [
    'agent_message_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
  ])
  assert.equal(chunkOf(view.notifications[1]).type, 'image')
  assert.equal(chunkOf(view.notifications[4]).text, 'answer')
})

test('PO-4C C-L1-04: a Store read failure fails the event without any partial chunk and before later output', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start('po4c:missing-image:v1')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-missing')
  view.claim('m-missing', 1, request.requestId)
  // A real earlier event was already delivered and must not be retracted.
  view.commit('assistant/message', assistantData(1, 'm-earlier', [{ type: 'text', text: 'earlier' }]))
  await flushOutput()
  assert.equal(view.notifications.length, 1)
  // The committed image names an object the fake Store cannot verify: the
  // text block of the SAME event must not be sent either.
  view.commit('assistant/message', assistantData(1, 'm-broken', [
    { type: 'text', text: 'would-be-partial' },
    imageBlock('sha256:absent'),
  ]))
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED'))
  assert.deepEqual(view.notifications.map(updateKind), ['agent_message_chunk'])
  assert.equal(chunkOf(view.notifications[0]).text, 'earlier')
  assert.equal(JSON.stringify(view.notifications).includes(Buffer.from(IMAGE_BYTES).toString('base64')), false,
    'a failed read never emits fabricated bytes')
})

test('PO-4C C-L1-04: an unsupported committed block still fails closed instead of truncating', async () => {
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-file')
    view.claim('m-file', 1, request.requestId)
    view.commit('assistant/message', assistantData(1, 'm-file', [
      { type: 'text', text: 'visible' },
      { type: 'file', attachment: { attachmentId: 'sha256:file', name: 'a.txt', bytes: 1 } },
    ]))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'))
    assert.equal(view.notifications.length, 0, 'the whole event fails before any partial block is sent')
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-bad-ref')
    view.claim('m-bad-ref', 1, request.requestId)
    // A committed image without the structural official reference is not
    // readable content: never guess an object or emit an empty image.
    view.commit('assistant/message', assistantData(1, 'm-bad-ref', [{ type: 'image', attachment: { id: 'img' } }]))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'))
    assert.equal(view.access.imageReadCalls.length, 0)
  }
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-tool-file')
    view.claim('m-tool-file', 1, request.requestId)
    view.commit('tool/result', toolResultData(1, 'call-file', false, [
      { type: 'file', attachment: { attachmentId: 'sha256:file', name: 'a.txt', bytes: 1 } },
    ]))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT'))
    assert.equal(view.notifications.length, 0)
  }
})

test('PO-4C C-L1-05: a mixed turn aborts the pending image read and never sends its late chunks', async () => {
  const view = promptView()
  await view.attach()
  view.access.storedImages.set('sha256:race', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const readStarted = deferred<void>()
  view.access.imageReadImpl = async (_ref, signal) => {
    readStarted.resolve()
    return await new Promise<AcpStoredImage>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ data: IMAGE_BYTES, mediaType: 'image/png' }), 50)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-mixed')
  view.claim('m-mixed', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-mixed', [{ type: 'text', text: 'before' }, imageBlock('sha256:race')]))
  await readStarted.promise
  // A foreign message claimed into the SAME turn proves MIXED while the read runs.
  view.claim('m-foreign', 1, 'tui-steer')
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  assert.deepEqual(view.notifications, [], 'the aborted read is a closure, not a content failure: no chunk leaked')
  // A late read completion after the failure never revives delivery.
  await flushOutput()
  assert.deepEqual(view.notifications, [])
})

test('PO-4C C-L1-05: an Agent disposal during a read fails the request once and a late read never reaches the wire', async () => {
  const view = promptView()
  await view.attach()
  view.access.storedImages.set('sha256:disposed', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const readStarted = deferred<void>()
  const releaseRead = deferred<AcpStoredImage>()
  view.access.imageReadImpl = async () => {
    readStarted.resolve()
    return await releaseRead.promise
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-disposed')
  view.claim('m-disposed', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-disposed', [imageBlock('sha256:disposed')]))
  await readStarted.promise
  view.registry.onAgentDisposed(view.agent)
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  releaseRead.resolve({ data: IMAGE_BYTES, mediaType: 'image/png' })
  await flushOutput()
  assert.deepEqual(view.notifications, [], 'a late read result of a settled flight is inert')
  assert.equal(view.access.promptCalls.length, 1, 'a disposed Agent is never re-dispatched')
  // The exact durable terminal (Agent disposal) removed the flight, so no
  // second responsibility or fence lingers for it.
  let lateApproval = 'unset'
  lateApproval = await view.registry.onApprovalRequest({ agent: view.agent, toolName: 'po4c_tool', callId: 'late' }, async () => 'allowed-once')
  assert.equal(lateApproval, 'allowed-once', 'a proven terminal turn has no lingering retired fence')
})

test('PO-4C C-L1-06: the pending-update budget reserves image chunks before any Store read', async () => {
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-over')
    view.claim('m-over', 1, request.requestId)
    const blocks = Array.from({ length: 65 }, (_entry, index) => imageBlock(`sha256:many-${String(index)}`))
    view.commit('assistant/message', assistantData(1, 'm-over', blocks))
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_OUTPUT_BACKPRESSURE'))
    assert.equal(view.access.imageReadCalls.length, 0, 'the overflow is detected on the reservation, not mid-read')
    assert.equal(view.notifications.length, 0)
  }
  {
    const view = promptView()
    await view.attach()
    for (let index = 0; index < 64; index += 1) {
      view.access.storedImages.set(`sha256:ok-${String(index)}`, { bytes: IMAGE_BYTES, mediaType: 'image/png' })
    }
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-at-cap')
    view.claim('m-at-cap', 1, request.requestId)
    const blocks = Array.from({ length: 64 }, (_entry, index) => imageBlock(`sha256:ok-${String(index)}`))
    view.commit('assistant/message', assistantData(1, 'm-at-cap', blocks))
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    assert.equal(view.notifications.length, 64)
    assert.equal(view.notifications.every(update => updateKind(update) === 'agent_message_chunk'), true)
  }
})
