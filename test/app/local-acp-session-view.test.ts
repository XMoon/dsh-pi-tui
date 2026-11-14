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
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  AcpSessionViewRegistry,
  LocalAcpViewError,
  type AcpCreateSessionOutcome,
  type AcpCreateWorkspaceOutcome,
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
