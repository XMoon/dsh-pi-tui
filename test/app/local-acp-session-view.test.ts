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
  type AcpPromptFactListener,
  type AcpSessionPromptRequest,
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
  assert.deepEqual(registry.closeSession(a, 'S3'), {})
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

  assert.deepEqual(registry.closeSession(a, 'S4'), {})
  assert.deepEqual(registry.closeSession(a, 'S4'), {}, 'a repeated close on the same connection is idempotent')
  assert.equal(registry.phaseOf(a), 'idle')
  assert.equal(registry.hasClaim('S5'), true, 'another connection claim is untouched')
  assert.equal(registry.claimCount(), 1)
  // A connection closing a Session it never held is refused.
  assert.throws(() => registry.closeSession(a, 'S5'), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))
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
  assert.deepEqual(registry.closeSession(conn, 'S12'), {})
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
  assert.deepEqual(registry.closeSession(conn, 'S1'), {})
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
    assert.deepEqual(registry.closeSession(conn, 'S'), {})
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
    assert.deepEqual(registry.closeSession(conn, 'S'), {})
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
  attach: () => Promise<void>
  start: (text?: string, signal?: AbortSignal) => Promise<{ stopReason: string }>
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
  const conn = registry.createConnection()
  const notifications: SessionUpdate[] = []
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
    message,
    attach: async () => { await registry.resumeSession(conn, access, { sessionId, cwd: '/w' }) },
    start: (text = 'hello', signal = new AbortController().signal) =>
      registry.promptSession(conn, access, { sessionId, prompt: [{ type: 'text', text }] }, signal, sendUpdate),
    insert: (rpcId: string, messageId: string, text = 'hello') => {
      registry.onInboxInserted(agent, message(messageId, rpcId))
    },
    claim: (messageId: string, turn: number, rpcId = 'unknown') => {
      registry.onInboxClaimed(agent, message(messageId, rpcId), turn)
    },
    commit: (type: string, data: Record<string, unknown>) => {
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
    [{ type: 'resource_link', name: 'x', uri: 'file:///x' }],
  ]) {
    await assert.rejects(
      view.registry.promptSession(view.conn, view.access, { sessionId: 'P1', prompt }, signal, async () => {}),
      isPromptError('LOCAL_ACP_PROMPT_INVALID_CONTENT'),
    )
  }
  await assert.rejects(
    view.registry.promptSession(view.conn, view.access, { sessionId: 'OTHER', prompt: [{ type: 'text', text: 'x' }] }, signal, async () => {}),
    isPromptError('LOCAL_ACP_VIEW_NOT_OWNED'),
  )
  assert.equal(view.access.promptCalls.length, 0, 'no invalid prompt reaches the Host')
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

test('close and physical release never fake a cancelled shared turn; late facts cannot reach a new claim', async () => {
  {
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 2, request.requestId)
    assert.throws(() => view.registry.closeSession(view.conn, 'P1'), isPromptError('LOCAL_ACP_PROMPT_IN_FLIGHT'))
    assert.equal(view.registry.phaseOf(view.conn), 'attached', 'an in-flight close leaves the View attached')
    // The Host turn keeps running; only the View release ends the request.
    view.registry.releaseConnection(view.conn)
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_VIEW_CLOSED'))
    // Late facts of the old View are inert.
    view.commit('assistant/message', assistantData(2, 'm-1', [{ type: 'text', text: 'late answer' }]))
    view.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await flushOutput()
    assert.equal(view.notifications.length, 0)

    // A NEW connection attaching the SAME session receives none of the old turn.
    const next = promptView()
    await next.attach()
    next.commit('assistant/message', assistantData(2, 'm-1', [{ type: 'text', text: 'late answer' }]))
    next.commit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    assert.equal(next.notifications.length, 0, 'an old generation turn is never replayed to a new claim')
  }
})

test('an aborted ACP request releases only the View flight and leaves the Host turn alone', async () => {
  const view = promptView()
  await view.attach()
  const controller = new AbortController()
  const attempt = view.start('abort me', controller.signal)
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-1')
  view.claim('m-1', 8, request.requestId)
  controller.abort(new Error('client went away'))
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_ABORTED'))
  view.commit('assistant/message', assistantData(8, 'm-1', [{ type: 'text', text: 'after abort' }]))
  assert.equal(view.notifications.length, 0)
  assert.equal(view.access.promptCalls.length, 1, 'abort never re-dispatches the prompt')
  // The View is still attached and can take a new prompt afterwards.
  const second = view.start('next prompt')
  const secondRequest = view.access.promptCalls[1]!
  view.insert(secondRequest.requestId, 'm-2')
  view.claim('m-2', 9, secondRequest.requestId)
  view.commit('assistant/message', assistantData(9, 'm-2', [{ type: 'text', text: 'second answer' }]))
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
  view.registry.closeSession(view.conn, 'P1')
  // A new live Agent object for the SAME session id (a new generation).
  const replacement = makeAgent('P1', '/w')
  view.access.seed(replacement)
  await view.registry.resumeSession(view.conn, view.access, { sessionId: 'P1', cwd: '/w' })
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  // The OLD Agent object's facts are inert.
  view.insert(request.requestId, 'm-1')
  view.registry.onInboxInserted(view.agent, view.message('m-old', request.requestId))
  view.registry.onInboxClaimed(view.agent, view.message('m-old', request.requestId), 1)
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
    onAgentError: (agent, turn) => { seen.push(`error:${agent.id}:${String(turn)}`) },
    onAgentDisposed: agent => { seen.push(`disposed:${agent.id}`) },
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
  assert.deepEqual(seen, [
    'inserted:S:m1:r1',
    'claimed:S:m1:3',
    'event:S:turn/end',
    'error:S:3',
    'disposed:S',
  ], 'each official event reaches the sink with its real identity payload')
  dispose()
  assert.equal([...listeners.values()].every(set => set.size === 0), true, 'the disposer removes exactly its own listeners')
})
