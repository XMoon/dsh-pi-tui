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
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  type AcpSessionPolicyRequest,
  type AcpSessionPolicyState,
} from '../../src/app/remote-process/local-acp-session-policy.ts'
import {
  AcpSessionViewRegistry,
  LocalAcpViewError,
  type AcpContinuedAnswerOutcome,
  type AcpCreateSessionOutcome,
  type AcpConfigUpdate,
  type AcpCreateWorkspaceOutcome,
  type AcpImageLimits,
  type AcpPromptFactListener,
  type AcpQuestionAnswer,
  type AcpQuestionSnapshot,
  type AcpSessionPromptRequest,
  type AcpStoredImage,
  type AcpStoredImageRef,
  type AcpElicitationRequest,
  type AcpElicitationRequester,
  type AcpElicitationResponse,
  type AcpViewChannels,
  type HostAcpSessionAccess,
  type LiveAgentViewIdentity,
} from '../../src/app/remote-process/local-acp-session-view.ts'
import {
  answerQuestionForm,
  buildQuestionForm,
  type AcpQuestionSpec,
} from '../../src/app/remote-process/local-acp-question-form.ts'
import { AcpAssistantStream } from '../../src/app/remote-process/local-acp-live-stream.ts'
import {
  EMPTY_COMMAND_CATALOG,
  type AcpCommandCatalogRead,
  type AcpNativeSkillCatalog,
} from '../../src/app/remote-process/local-acp-commands.ts'
import { AcpModelError, type AcpModelCurrentness, type AcpModelOptionRequest } from '../../src/app/remote-process/local-acp-model-selection.ts'
import { AcpScopedMcpError, type AcpScopedMcpCurrentness, type AcpScopedMcpLease } from '../../src/app/remote-process/local-acp-scoped-mcp.ts'
import type {
  AcpHistoryHeader,
  AcpNegotiatedCapabilities,
  AcpSessionHistory,
  AcpSessionReadRow,
} from '../../src/app/remote-process/local-acp-projections.ts'
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

/** One test-only lease handle; the View never inspects its Fiber internals. */
function makeScopedLease(agent: LiveAgentViewIdentity, session: object, serverName = 's1'): AcpScopedMcpLease {
  return { agent: agent as never, session, serverNames: [serverName], fibers: [] }
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

  readonly mountScopedMcpCalls: Array<{ readonly sessionId: string; readonly servers: readonly unknown[] }> = []
  readonly retireScopedMcpCalls: AcpScopedMcpLease[] = []
  mountScopedMcpImpl: (
    agent: LiveAgentViewIdentity,
    session: object,
    servers: readonly unknown[],
    stillCurrent: () => AcpScopedMcpCurrentness,
    signal?: AbortSignal,
  ) => Promise<AcpScopedMcpLease | undefined> = async () => {
    throw new Error('mountScopedMcp is not configured for this test')
  }
  retireScopedMcpImpl: (lease: AcpScopedMcpLease) => Promise<void> = async () => {}

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

  async mountScopedMcp(
    agent: LiveAgentViewIdentity,
    session: object,
    servers: readonly unknown[],
    stillCurrent: () => AcpScopedMcpCurrentness,
    signal?: AbortSignal,
  ): Promise<AcpScopedMcpLease | undefined> {
    this.mountScopedMcpCalls.push({ sessionId: agent.id, servers })
    return await this.mountScopedMcpImpl(agent, session, servers, stillCurrent, signal)
  }

  async requestRetireScopedMcp(lease: AcpScopedMcpLease): Promise<void> {
    this.retireScopedMcpCalls.push(lease)
    const active = lease.retirePromise ??= this.retireScopedMcpImpl(lease)
    try {
      return await active
    } catch (error) {
      if (lease.retirePromise === active) lease.retirePromise = undefined
      throw error
    }
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

  /** Every config-option read the View performed, with its exact Agent/Session identity. */
  readonly modelOptionCalls: Array<{ readonly agent: LiveAgentViewIdentity; readonly session: object }> = []
  /** Every model write the View performed, with its exact request. */
  readonly selectModelCalls: Array<{
    readonly agent: LiveAgentViewIdentity
    readonly session: object
    readonly request: AcpModelOptionRequest
  }> = []
  /** The scripted full option state the fake Host returns. */
  modelOptionsImpl: (agent: LiveAgentViewIdentity, session: object) => Promise<SessionConfigOption[]> =
    async () => []
  /** The scripted commit result; the default returns the same full option state. */
  selectModelImpl: (
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpModelOptionRequest,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ) => Promise<SessionConfigOption[]> = async () => []
  /** The scripted committed policy state the fake Host returns. */
  readSessionPolicyImpl: (agent: LiveAgentViewIdentity, session: object) => AcpSessionPolicyState =
    () => ({})
  /** The scripted policy write terminal; the default commits the requested value. */
  selectSessionPolicyImpl: (
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ) => Promise<AcpSessionPolicyState> = async (_agent, _session, request) =>
    request.kind === 'mode' ? { mode: request.mode } : { agentTeam: request.enabled }

  async modelOptions(agent: LiveAgentViewIdentity, session: object): Promise<SessionConfigOption[]> {
    this.modelOptionCalls.push({ agent, session })
    return await this.modelOptionsImpl(agent, session)
  }

  async selectModelOnly(
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpModelOptionRequest,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ): Promise<SessionConfigOption[]> {
    this.selectModelCalls.push({ agent, session, request })
    return await this.selectModelImpl(agent, session, request, signal, stillCurrent)
  }

  readSessionPolicy(agent: LiveAgentViewIdentity, session: object): AcpSessionPolicyState {
    return this.readSessionPolicyImpl(agent, session)
  }

  async selectSessionPolicy(
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ): Promise<AcpSessionPolicyState> {
    return await this.selectSessionPolicyImpl(agent, session, request, signal, stillCurrent)
  }

  observePromptFacts(_listener: AcpPromptFactListener): () => void {
    return () => {}
  }

  readCommandCatalogImpl: (agent: LiveAgentViewIdentity, session: object) => AcpCommandCatalogRead =
    () => EMPTY_COMMAND_CATALOG
  readCommandCatalog(agent: LiveAgentViewIdentity, session: object): AcpCommandCatalogRead {
    return this.readCommandCatalogImpl(agent, session)
  }

  readNativeSkillsImpl: (agent: LiveAgentViewIdentity, session: object, signal: AbortSignal) => Promise<AcpNativeSkillCatalog> =
    async () => ({ kind: 'absent' })
  async readNativeSkills(agent: LiveAgentViewIdentity, session: object, signal: AbortSignal): Promise<AcpNativeSkillCatalog> {
    return await this.readNativeSkillsImpl(agent, session, signal)
  }

  readonly standaloneCommandCalls: Array<{ readonly agent: LiveAgentViewIdentity; readonly session: object; readonly line: string; readonly signal: AbortSignal }> = []
  executeStandaloneCommandImpl: (
    agent: LiveAgentViewIdentity,
    session: object,
    line: string,
    signal: AbortSignal,
  ) => Promise<unknown> = async () => undefined
  executeStandaloneCommand(agent: LiveAgentViewIdentity, session: object, line: string, signal: AbortSignal): Promise<unknown> {
    this.standaloneCommandCalls.push({ agent, session, line, signal })
    return this.executeStandaloneCommandImpl(agent, session, line, signal)
  }

  readonly manualCompactCalls: Array<{ readonly agent: LiveAgentViewIdentity; readonly session: object; readonly signal: AbortSignal }> = []
  executeManualCompactImpl: (agent: LiveAgentViewIdentity, session: object, signal: AbortSignal) => Promise<unknown> =
    async () => null
  executeManualCompact(agent: LiveAgentViewIdentity, session: object, signal: AbortSignal): Promise<unknown> {
    this.manualCompactCalls.push({ agent, session, signal })
    return this.executeManualCompactImpl(agent, session, signal)
  }

  parseCommand(line: string): { readonly name: string; readonly rawInput: string } | undefined {
    return parseCommand(line)
  }

  /** Whether this fake Host bound the official Controller/Query read seams. */
  sessionReadReady = false
  supportsSessionRead(): boolean {
    return this.sessionReadReady
  }
  readonly sessionListCalls: number[] = []
  sessionListRows: readonly AcpSessionReadRow[] = []
  readSessionListImpl: (signal?: AbortSignal) => Promise<readonly AcpSessionReadRow[]> =
    async () => this.sessionListRows
  async readSessionList(signal?: AbortSignal): Promise<readonly AcpSessionReadRow[]> {
    this.sessionListCalls.push(1)
    return await this.readSessionListImpl(signal)
  }
  readonly historyCalls: string[] = []
  sessionHistory: AcpSessionHistory = { header: { sessionId: '' }, events: [] }
  readSessionHistoryImpl: (sessionId: string, signal?: AbortSignal) => Promise<AcpSessionHistory> =
    async () => this.sessionHistory
  async readSessionHistory(sessionId: string, signal?: AbortSignal): Promise<AcpSessionHistory> {
    this.historyCalls.push(sessionId)
    return await this.readSessionHistoryImpl(sessionId, signal)
  }
  headerFacts: AcpHistoryHeader | undefined
  /** Every signal the View handed to a header read (the cold-read cancel seam). */
  headerFactsSignals: (AbortSignal | undefined)[] = []
  headerFactsImpl: (sessionId: string, signal?: AbortSignal) => Promise<AcpHistoryHeader | undefined> = async () => this.headerFacts
  async sessionHeaderFacts(sessionId: string, signal?: AbortSignal): Promise<AcpHistoryHeader | undefined> {
    this.headerFactsSignals.push(signal)
    return await this.headerFactsImpl(sessionId, signal)
  }
  pressureValue: unknown
  contextPressure(): unknown {
    return this.pressureValue
  }
  todosValue: unknown
  sessionTodos(): unknown {
    return this.todosValue
  }

  /** Question capability of this fake Host (off unless a test enables it). */
  questionService = false
  hasQuestionService(): boolean {
    return this.questionService
  }
  questionSnapshotImpl: (
    sessionId: string,
    agent: LiveAgentViewIdentity,
    session: object,
  ) => AcpQuestionSnapshot = () => ({ kind: 'unavailable' })
  questionSnapshot(sessionId: string, agent: LiveAgentViewIdentity, session: object): AcpQuestionSnapshot {
    return this.questionSnapshotImpl(sessionId, agent, session)
  }
  answerContinuedImpl: (
    sessionId: string,
    agent: LiveAgentViewIdentity,
    session: object,
    callId: string,
    answer: AcpQuestionAnswer,
  ) => AcpContinuedAnswerOutcome = () => ({ kind: 'not-continued' })
  /** Every official late-answer submission this fake Host received. */
  readonly answerContinuedCalls: Array<{ readonly callId: string; readonly answer: AcpQuestionAnswer }> = []
  answerContinued(
    sessionId: string,
    agent: LiveAgentViewIdentity,
    session: object,
    callId: string,
    answer: AcpQuestionAnswer,
    _stillCurrent: () => boolean,
  ): AcpContinuedAnswerOutcome {
    // A deliberately dumb recorder: the View's own ownership fence is what the
    // QU-05 test proves, so this fake must never hide a missing View fence.
    this.answerContinuedCalls.push({ callId, answer })
    return this.answerContinuedImpl(sessionId, agent, session, callId, answer)
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
    isViewError('LOCAL_ACP_MCP_INVALID_DECLARATION'),
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
  // A close of a foreign, unknown or inactive Session is a side-effect-free
  // success and never touches the real owner's claim.
  const phaseB = registry.phaseOf(b)
  assert.deepEqual(await registry.closeSession(a, access, 'S5'), {})
  assert.equal(registry.hasClaim('S5'), true, 'the foreign claim survives the idempotent close')
  assert.equal(registry.phaseOf(b), phaseB, 'the foreign connection phase is untouched')
  assert.deepEqual(await registry.closeSession(a, access, 'unknown-session'), {})
  assert.equal(registry.claimCount(), 1)

  // Closing A again after the SAME connection attaches B remains an inert `{}`
  // and cannot release or mutate B's exact claim.
  access.seed(makeAgent('S6', '/w'))
  await registry.resumeSession(a, access, { sessionId: 'S6', cwd: '/w' })
  const claimB = registry.ownsClaim(a, 'S6')
  assert.equal(claimB, true)
  assert.deepEqual(await registry.closeSession(a, access, 'S4'), {})
  assert.equal(registry.ownsClaim(a, 'S6'), claimB, 'the active B claim is unchanged')
  assert.equal(registry.phaseOf(a), 'attached', 'the active B View remains attached')
  assert.equal(registry.claimCount(), 2, 'B and the other connection claim both survive')
})

test('ownership readback is exact to the connection and includes retained fences', async () => {
  const access = new FakeAccess()
  access.seed(makeAgent('S-owned', '/w'))
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const a = registry.createConnection()
  const b = registry.createConnection()
  await registry.resumeSession(a, access, { sessionId: 'S-owned', cwd: '/w' })

  assert.equal(registry.ownsClaim(a, 'S-owned'), true)
  assert.equal(registry.ownsClaim(b, 'S-owned'), false)
  assert.equal(registry.ownsClaim(a, 'S-unknown'), false)
  assert.equal(registry.hasClaimOwnedBy(a), true)
  assert.equal(registry.hasClaimOwnedBy(b), false)
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
          modelCatalog: async () => ({ groups: [] }),
        }
        if (name === 'agents') return agents
        if (name === 'sessions') return sessions
        if (name === 'llm') return { resolveModelInfo: async () => ({}) }
        if (name === 'tools') return { definitions: () => [] }
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
      if (name === 'sessionController') return {
        prompt: async (request: AcpSessionPromptRequest) => { dispatched.push(request); return { accepted: true } },
        modelCatalog: async () => ({ groups: [] }),
      }
      if (name === 'agents') return { get: () => liveAgent }
      if (name === 'sessions') return { get: () => liveSession }
      if (name === 'attachments') return store
      if (name === 'agentDefaultModel') return defaultModel
      if (name === 'llm') return llm
      if (name === 'tools') return { definitions: () => [] }
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

test('the production Host command access binds only the audited identities and the exact retained compaction engine', async () => {
  const session = { id: 'S-command', header: { cwd: '/w' } }
  const agent = { id: session.id, session, ctx: {} }
  const feedback = {
    name: 'feedback',
    description: 'Send feedback.',
    definitionId: '@deepseek-ai/dsh-command-feedback',
    input: { hint: 'What should we know?' },
  }
  const compact = {
    name: 'compact',
    description: 'Compact this session.',
    definitionId: '@deepseek-ai/dsh-command-compact',
  }
  const executed: Array<{ line: string; attachments: readonly unknown[]; signal: AbortSignal }> = []
  const compacted: Array<{ signal: AbortSignal; sourceCommandId?: unknown }> = []
  let modules = ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact']
  class OfficialEngine {
    async compactNow(_agent: object, signal: AbortSignal, sourceCommandId?: unknown) {
      compacted.push({ signal, ...sourceCommandId === undefined ? {} : { sourceCommandId } })
      return null
    }
  }
  const officialEngine = new OfficialEngine()
  const rootEngine = { async compactNow() { throw new Error('the root engine must never be used') } }
  let scopedEngine: unknown = officialEngine
  let skillsSnapshot: { skills: unknown[]; complete: boolean } = { skills: [], complete: true }
  let skillLoader = true
  const skills = {
    async snapshot() { return skillsSnapshot },
  }
  let scopedSkills: unknown = skills
  const globalSkills = skills
  let presetId = 'standard'
  let serviceThrow = false
  const context = {
    reflect: { get(name: string) {
      if (name === 'workspaceController') return { create: async () => ({ workspace: { workspaceId: 'ws', path: '/w' } }) }
      if (name === 'sessionController') return {
        create: async () => ({ sessionId: session.id }),
        resolveAgent: async () => ({ agent }),
        modelCatalog: async () => ({ groups: [] }),
      }
      if (name === 'agents') return { get: () => agent }
      if (name === 'sessions') return { get: () => session }
      if (name === 'llm') return { resolveModelInfo: async () => ({}) }
      if (name === 'tools') return { definitions: () => [] }
      if (name === 'commands') return {
        list: () => [feedback, compact],
        find: (_agent: object, command: string) => command === 'feedback' ? feedback : command === 'compact' ? compact : undefined,
        execute: async (_agent: object, line: string, attachments: readonly unknown[], signal: AbortSignal) => {
          executed.push({ line, attachments, signal })
          return { result: { kind: 'success', text: 'recorded' } }
        },
      }
      if (name === 'agentPresets') return {
        inspectCompositions: () => [{
          id: presetId,
          modules: [
            ...modules,
            ...skillLoader ? ['@deepseek-ai/dsh-tool-skill'] : [],
          ].map(moduleName => ({ moduleName })),
        }],
        serviceFor: (_agent: object, service: string) => {
          if (serviceThrow) throw new Error('retained service read failed')
          return service === 'compaction' ? scopedEngine : service === 'skills' ? scopedSkills : undefined
        },
      }
      if (name === 'workingDirectory') return { get: () => '/w' }
      if (name === 'skills') return globalSkills
      if (name === 'compaction') return rootEngine
      return undefined
    } },
  } as unknown as Parameters<typeof createHostAcpSessionAccess>[0]
  const access = createHostAcpSessionAccess(context, undefined, OfficialEngine)
  const catalog = access.readCommandCatalog(agent, session)
  assert.deepEqual(catalog.effectiveNames, ['feedback', 'compact'])
  assert.equal(catalog.feedback, 'available')
  assert.equal(catalog.compact, 'available')
  assert.deepEqual(catalog.rows.map(row => row.name), ['feedback', 'compact'])
  await access.executeStandaloneCommand(agent, session, '/feedback hello', new AbortController().signal)
  assert.equal(executed.length, 1)
  assert.equal(executed[0]?.line, '/feedback hello')
  assert.deepEqual(executed[0]?.attachments, [])
  await access.executeManualCompact(agent, session, new AbortController().signal)
  assert.equal(compacted.length, 1)
  assert.equal(compacted[0]?.sourceCommandId, undefined, 'ACP never fabricates the command identity')
  // A custom composition with a second compaction engine is not audited.
  modules = ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', 'custom-compaction-engine']
  assert.equal(access.readCommandCatalog(agent, session).compact, 'unavailable')
  assert.throws(() => access.executeManualCompact(agent, session, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  assert.equal(compacted.length, 1, 'no fallback engine was reached')
  modules = ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact']
  presetId = 'custom'
  assert.equal(access.readCommandCatalog(agent, session).compact, 'unavailable')
  assert.throws(() => access.executeManualCompact(agent, session, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  presetId = 'standard'
  serviceThrow = true
  assert.throws(() => access.readCommandCatalog(agent, session), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  await assert.rejects(access.readNativeSkills(agent, session, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  serviceThrow = false
  scopedEngine = { async compactNow() { return null } }
  assert.equal(access.readCommandCatalog(agent, session).compact, 'unavailable',
    'a same-shape nonofficial engine is not the anchored official implementation')
  scopedEngine = undefined
  assert.equal(access.readCommandCatalog(agent, session).compact, 'unavailable')
  assert.throws(() => access.executeManualCompact(agent, session, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  scopedEngine = officialEngine

  // Native Skill reads require the exact loader and a COMPLETE official snapshot.
  skillsSnapshot = {
    complete: true,
    skills: [
      { name: 'deploy', description: 'Deploy the app.', invocation: { userInvocable: true, modelInvocable: false } },
      { name: 'model-only', description: 'Model only.', invocation: { userInvocable: false, modelInvocable: true } },
      { name: 'broken', description: 3, invocation: { userInvocable: true } },
    ],
  }
  assert.deepEqual(await access.readNativeSkills(agent, session, new AbortController().signal), {
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  })
  skillsSnapshot = { ...skillsSnapshot, complete: false }
  await assert.rejects(access.readNativeSkills(agent, session, new AbortController().signal), (error: unknown) =>
    (error as { code?: string }).code === 'unavailable')
  // The standard composition mounts tool-skill against the global skills
  // service; when the retained scope publishes no scoped service that global
  // registry is the effective authority.
  skillsSnapshot = { ...skillsSnapshot, complete: true }
  scopedSkills = undefined
  assert.deepEqual(await access.readNativeSkills(agent, session, new AbortController().signal), {
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  }, 'the official global registry is used when the retained loader has no scoped service')
  // A real scoped registry wins and is not unioned with the global one.
  scopedSkills = {
    async snapshot() {
      return {
        complete: true,
        skills: [{ name: 'scoped-only', description: 'Scoped only.', invocation: { userInvocable: true } }],
      }
    },
  }
  assert.deepEqual(await access.readNativeSkills(agent, session, new AbortController().signal), {
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'scoped-only', description: 'Scoped only.' }],
  }, 'the scoped registry is the exact authority when it exists')
  scopedSkills = skills
  skillLoader = false
  assert.deepEqual(await access.readNativeSkills(agent, session, new AbortController().signal), { kind: 'absent' })
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
            modelCatalog: async () => ({ groups: [] }),
          }
        }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'sessions') return { get: () => undefined }
        if (name === 'llm') return { resolveModelInfo: async () => ({}) }
        if (name === 'tools') return { definitions: () => [] }
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
function promptView(sessionId = 'P1', options: { readonly mcp?: boolean; readonly channels?: AcpViewChannels } = {}): {
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
  commit: (type: string, data: Record<string, unknown>, time?: number) => void
  /** The committed sequence of the LAST `commit()` (the durable join key). */
  lastSeq: () => number
  /** One official transient assistant-stream frame of the attached Agent. */
  stream: (frame: unknown) => void
  message: (messageId: string, rpcId: string, kind?: string) => { id: string; source: { kind: string; rpcId: string } }
  deferredSend: () => { promise: Promise<void>; release: () => void }
} {
  const access = new FakeAccess()
  const agent = makeAgent(sessionId, '/w')
  access.seed(agent)
  const mcpServers = options.mcp === true
    ? [{ name: 's1', command: '/bin/true', args: [], env: [] }]
    : []
  if (options.mcp === true) access.mountScopedMcpImpl = async (_agent, session) => makeScopedLease(agent, session)
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
  /** Monotone committed Session sequence of this fake harness's events. */
  let committedSeq = 0
  return {
    access,
    agent,
    registry,
    conn,
    notifications,
    permissionRequests,
    message,
    lastSeq: () => committedSeq,
    stream: (frame: unknown) => { registry.onAssistantStream(agent, frame) },
    attach: async () => { await registry.resumeSession(conn, access, { sessionId, cwd: '/w', ...(mcpServers.length === 0 ? {} : { mcpServers }) }, options.channels) },
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
      committedSeq += 1
      registry.onSessionEvent(agent.session, { seq: committedSeq, type, data })
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

test('DSH internal inbox injections do not make the ACP-owned turn MIXED', async () => {
  {
    // next-step context is claimed before the ACP next-turn message in one batch.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-owned')
    view.registry.onInboxClaimed(view.agent, {
      id: 'm-skill',
      source: { kind: 'skill-invocation' },
    }, 5)
    view.registry.onInboxClaimed(view.agent, {
      id: 'm-time',
      source: { kind: 'time-context' },
    }, 5)
    view.claim('m-owned', 5, request.requestId)
    view.commit('assistant/message', assistantData(5, 'm-answer', [{ type: 'text', text: 'answer' }]))
    view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    assert.deepEqual(view.notifications, [
      { sessionUpdate: 'agent_message_chunk', messageId: 'm-answer', content: { type: 'text', text: 'answer' } },
    ], 'injected context does not suppress the owned response')
  }
  {
    // A subagent notice and a clock snapshot arrive while the ACP turn runs.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-owned')
    view.claim('m-owned', 6, request.requestId)
    view.commit('assistant/message', assistantData(6, 'm-before', [{ type: 'text', text: 'before' }]))
    await flushOutput()
    view.registry.onInboxClaimed(view.agent, {
      id: 'm-subagent',
      source: { kind: 'subagent-settled' },
    }, 6)
    view.registry.onInboxClaimed(view.agent, {
      id: 'm-time',
      source: { kind: 'time-context' },
    }, 6)
    view.commit('assistant/message', assistantData(6, 'm-after', [{ type: 'text', text: 'after' }]))
    view.commit('turn/end', { turn: 6, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    assert.deepEqual(view.notifications, [
      { sessionUpdate: 'agent_message_chunk', messageId: 'm-before', content: { type: 'text', text: 'before' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm-after', content: { type: 'text', text: 'after' } },
    ], 'later internal claims do not stop subsequent ACP output')
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
    // A tool-only completed turn is a REAL success: ACP v1 requires no visible
    // assistant text, and the durable tool updates are its whole output.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-1')
    view.claim('m-1', 1, request.requestId)
    view.commit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
    view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a tool-only completed turn is a real end_turn')
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

test('a close with a RUNNING owned flight retires its exact MCP lease after the real turn terminal', async () => {
  const view = promptView('P1', { mcp: true })
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-mcp-close')
  view.claim('m-mcp-close', 2, request.requestId)
  view.access.pendingInbox.delete('m-mcp-close')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 2 }
  view.access.agentStatus = 'running'
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  assert.equal(view.access.retireScopedMcpCalls.length, 0, 'the MCP lease must not retire before the prompt terminal')
  view.commit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  assert.deepEqual(await closing, {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.access.retireScopedMcpCalls.length, 1)
  assert.equal(view.registry.hasClaim('P1'), false)
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
    registry.onSessionEvent(agent.session, { seq: 1, type: 'assistant/message', data: assistantData(1, 'm-x', [{ type: 'text', text: 'x' }]) })
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
    seq: 2,
    type: 'assistant/message',
    data: assistantData(2, 'm-new', [{ type: 'text', text: 'new agent answer' }]),
  })
  view.registry.onSessionEvent(replacement.session, { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
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
            modelCatalog: async () => ({ groups: [] }),
          }
        }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'sessions') return { get: () => undefined }
        if (name === 'llm') return { resolveModelInfo: async () => ({}) }
        if (name === 'tools') return { definitions: () => [] }
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
    onCommandCatalogInvalidated: () => {},
    onSkillCatalogInvalidated: () => {},
    onPolicyAvailabilityInvalidated: () => {},
    onAgentError: (agent, turn) => { seen.push(`error:${agent.id}:${String(turn)}`) },
    onAgentDisposed: agent => { seen.push(`disposed:${agent.id}`) },
    onApprovalRequest: (request, next) => {
      seen.push(`approval:${request.agent.id}:${String(request.toolName)}:${String(request.callId)}`)
      return next()
    },
    onAssistantStream: agent => { seen.push(`stream:${agent.id}`) },
    onQuestionRequest: (_request, next) => next(),
    onQuestionProjection: (session, key) => { seen.push(`projection:${String((session as unknown as { id: string }).id)}:${key}`) },
    onSubagentStart: info => { seen.push(`subagent-start:${info.id}:${info.parentSessionId}`) },
    onSubagentEnd: info => { seen.push(`subagent-end:${info.id}:${String(info.stopReason)}`) },
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
  assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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
  assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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
    assert.deepEqual(await attempt, { stopReason: 'end_turn' }, 'a completed owned turn needs no assistant text')
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

test('PO-4C C-L1-01: an image-only assistant message is valid output, and a reasoning-only completed turn is a real end_turn', async () => {
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
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    assert.deepEqual(view.notifications.map(updateKind), ['agent_thought_chunk'])
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

test('PO-4C C-L1-05: a mixed turn aborts a held image read, hangs no settlement and is never a content failure', async () => {
  const view = promptView()
  await view.attach()
  const readStarted = deferred<void>()
  // A signal-respecting official Store read: it only ends because the mixing
  // aborts this flight's output IO (a read that ignored the signal would be an
  // upstream contract violation, not a View behaviour).
  view.access.imageReadImpl = async (_ref, signal) => {
    readStarted.resolve()
    return await new Promise<AcpStoredImage>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-mixed')
  view.claim('m-mixed', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-mixed', [
    { type: 'text', text: 'before' },
    imageBlock('sha256:race'),
  ]))
  await readStarted.promise
  // A foreign message claimed into the SAME turn proves MIXED while the pre-mix
  // event's image read is still running: the read is abandoned, the queued
  // output is dropped, and turn/end can still settle promptly.
  view.claim('m-foreign', 1, 'tui-steer')
  view.commit('assistant/message', assistantData(1, 'm-after-mix', [{ type: 'text', text: 'after mix' }]))
  // The real Host terminal arrives while the abandoned read unwinds: the tail
  // must resolve (never hold the settlement) and the MIXED class must win.
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const error = await attempt.then(() => undefined, (reason: unknown) => reason)
  assert.ok(isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN')(error), 'the mixed settlement (not the aborted read) classifies the request')
  assert.equal(isPromptError('LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED')(error), false,
    'an abort-induced read rejection never masquerades as a content-read failure')
  assert.deepEqual(view.notifications, [], 'a mixed turn hands none of its pending output to the transport')
  assert.equal(JSON.stringify(view.notifications).includes('after mix'), false)
})

test('PO-4C C-L1-05: session/close abandons a held image read and hands no further output to the closing View', async () => {
  const view = promptView()
  await view.attach()
  const readStarted = deferred<void>()
  view.access.imageReadImpl = async (_ref, signal) => {
    readStarted.resolve()
    return await new Promise<AcpStoredImage>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-closing')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 1 }
  view.access.agentStatus = 'running'
  view.claim('m-closing', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-closing', [
    { type: 'text', text: 'before' },
    imageBlock('sha256:closing'),
  ]))
  await readStarted.promise
  const closing = view.registry.closeSession(view.conn, view.access, 'P1')
  await flushOutput()
  assert.deepEqual(view.notifications, [], 'the closing View receives no further output, not even the pending text')
  // The real owned-turn terminal still settles both the prompt and the close.
  view.commit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await closing, {})
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
  assert.equal(view.registry.hasClaim('P1'), false)
})

test('PO-4C C-L1-05: a request abort during a held read abandons the output instead of failing it as content', async () => {
  const view = promptView()
  await view.attach()
  const controller = new AbortController()
  const readStarted = deferred<void>()
  view.access.imageReadImpl = async (_ref, signal) => {
    readStarted.resolve()
    return await new Promise<AcpStoredImage>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const attempt = view.start('hello', controller.signal)
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-abort')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 1 }
  view.access.agentStatus = 'running'
  view.claim('m-abort', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-abort', [
    { type: 'text', text: 'before' },
    imageBlock('sha256:abort'),
  ]))
  await readStarted.promise
  controller.abort()
  await flushOutput()
  assert.deepEqual(view.notifications, [], 'the aborted channel receives nothing, and the abort is not a content failure')
  view.commit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(await attempt, { stopReason: 'cancelled' })
})

test('PO-4C F2: a session/cancel abandons a held image read and settles on the real cancelled turn/end', async () => {
  const view = promptView()
  await view.attach()
  const readStarted = deferred<void>()
  // A signal-respecting official Store read: without the cancellation aborting
  // this flight's output IO it would never settle, so the cancelled answer
  // could not be produced.
  view.access.imageReadImpl = async (_ref, signal) => {
    readStarted.resolve()
    return await new Promise<AcpStoredImage>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-cancel')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 1 }
  view.access.agentStatus = 'running'
  view.claim('m-cancel', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-cancel', [
    { type: 'text', text: 'before' },
    imageBlock('sha256:cancel'),
  ]))
  await readStarted.promise
  view.registry.cancelSession(view.conn, view.access, 'P1')
  // The real user-aborted terminal of the owned turn settles the request; the
  // abandoned read must not hang it nor become a content failure.
  view.commit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const settled = await Promise.race([
    attempt.then(value => ({ kind: 'settled' as const, value }), (error: unknown) => ({ kind: 'failed' as const, error })),
    // A bounded deadline turns a missing settlement into a clean test failure
    // instead of a hung suite; the authoritative fact is the real cancelled
    // turn/end above, not this window.
    new Promise<{ kind: 'timeout' }>(resolveTimeout => setTimeout(() => resolveTimeout({ kind: 'timeout' }), 2_000)),
  ])
  assert.equal(settled.kind, 'settled', 'a session/cancel must not wait for the held Store read')
  assert.deepEqual(settled.kind === 'settled' ? settled.value : undefined, { stopReason: 'cancelled' })
  assert.deepEqual(view.notifications, [], 'the not-yet-converted event is dropped; no partial chunk is sent')
})

test('PO-4C F2 sibling: a cancel after a held image read drops the following queued event and never fabricates delivery', async () => {
  const view = promptView()
  await view.attach()
  const readStarted = deferred<void>()
  const releaseRead = deferred<AcpStoredImage>()
  let readSignal: AbortSignal | undefined
  view.access.imageReadImpl = async (_ref, signal) => {
    readSignal = signal
    readStarted.resolve()
    return await releaseRead.promise
  }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-sibling')
  view.access.turnFence = { openTurnStartSeq: 100, lastTurn: 2 }
  view.access.agentStatus = 'running'
  view.claim('m-sibling', 2, request.requestId)
  // A: an assistant event whose image read is held.
  view.commit('assistant/message', assistantData(2, 'm-image', [
    imageBlock('sha256:sibling'),
  ]))
  await readStarted.promise
  // B: a later text event queued BEHIND the held read in the SAME outputTail.
  view.commit('assistant/message', assistantData(2, 'm-after', [{ type: 'text', text: 'after-cancel' }]))
  // The official running-turn cancel is addressed while A is held.
  view.registry.cancelSession(view.conn, view.access, 'P1')
  assert.equal(readSignal?.aborted, true, 'the commit cancellation stops this flight\'s held Store read')
  // Release the held read: the abort rejection (or a late success) must not
  // unblock B. A backend that ignores the signal is modelled by resolving here.
  releaseRead.resolve({ data: IMAGE_BYTES, mediaType: 'image/png' })
  view.commit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const settled = await Promise.race([
    attempt.then(value => ({ kind: 'settled' as const, value }), (error: unknown) => ({ kind: 'failed' as const, error })),
    // Bounded hang-detection window: the authoritative result is the real user-aborted turn/end above.
    new Promise<{ kind: 'timeout' }>(resolveTimeout => setTimeout(() => resolveTimeout({ kind: 'timeout' }), 2_000)),
  ])
  assert.equal(settled.kind, 'settled', 'the cancelled settlement must not hang on the queued sibling')
  assert.deepEqual(settled.kind === 'settled' ? settled.value : undefined, { stopReason: 'cancelled' })
  assert.deepEqual(view.notifications, [],
    'neither the held image event nor the later queued text may be delivered after the cancellation')
  assert.equal(JSON.stringify(view.notifications).includes('after-cancel'), false)
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

function modelOptionsFor(currentValue: string): SessionConfigOption[] {
  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [{ group: 'group:p1', name: 'Provider 1', options: [{ value: currentValue, name: currentValue }] }],
  }]
}

test('config option reads and model selection require the exact attached claim and reject a closed View', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-model', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  access.selectModelImpl = async () => modelOptionsFor('["p1","b"]')
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const signal = new AbortController().signal

  await assert.rejects(registry.modelOptions(conn, access, 'S-model'), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))
  await assert.rejects(
    registry.setConfigOption(conn, access, { sessionId: 'S-model', configId: 'model', value: '["p1","b"]' }, signal),
    isViewError('LOCAL_ACP_VIEW_NOT_OWNED'),
  )
  await registry.resumeSession(conn, access, { sessionId: 'S-model', cwd: '/w' })
  assert.deepEqual(await registry.modelOptions(conn, access, 'S-model'), modelOptionsFor('["p1","a"]'))
  assert.equal(access.modelOptionCalls.length, 1)
  assert.equal(access.modelOptionCalls[0]?.agent, agent)
  assert.equal(access.modelOptionCalls[0]?.session, agent.session)
  await assert.rejects(registry.modelOptions(conn, access, 'other-session'), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))

  const selected = await registry.setConfigOption(
    conn,
    access,
    { sessionId: 'S-model', configId: 'model', value: '["p1","b"]' },
    signal,
  )
  assert.deepEqual(selected, modelOptionsFor('["p1","b"]'))
  assert.equal(access.selectModelCalls.length, 1)
  assert.deepEqual(access.selectModelCalls[0]?.request, { configId: 'model', value: '["p1","b"]' })

  await registry.closeSession(conn, access, 'S-model')
  await assert.rejects(registry.modelOptions(conn, access, 'S-model'), isViewError('LOCAL_ACP_VIEW_NOT_OWNED'))
  await assert.rejects(
    registry.setConfigOption(conn, access, { sessionId: 'S-model', configId: 'model', value: '["p1","b"]' }, signal),
    isViewError('LOCAL_ACP_VIEW_NOT_OWNED'),
  )
  assert.equal(access.selectModelCalls.length, 1, 'a closed View never reaches the Host model service')
})

test('a model change is refused as VIEW_BUSY while this View owns an unsettled prompt flight', async () => {
  const view = promptView('S-model-busy')
  await view.attach()
  const attempt = view.start('busy prompt')
  const request = view.access.promptCalls[0]!
  await assert.rejects(
    view.registry.setConfigOption(
      view.conn,
      view.access,
      { sessionId: 'S-model-busy', configId: 'model', value: '["p1","b"]' },
      new AbortController().signal,
    ),
    isViewError('LOCAL_ACP_MODEL_VIEW_BUSY'),
  )
  assert.equal(view.access.selectModelCalls.length, 0)
  // Settle the flight through its real facts so teardown stays clean.
  view.insert(request.requestId, 'm-busy')
  view.claim('m-busy', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-busy', [{ type: 'text', text: 'ok' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('a model validation pending before a command is rejected as VIEW_BUSY and the command still completes', async () => {
  const view = projectionView('S-model-command')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  await view.resume()
  const validationEntered = deferred<void>()
  const validationRelease = deferred<void>()
  let observed: AcpModelCurrentness | undefined
  view.access.selectModelImpl = async (_agent, _session, _request, _signal, stillCurrent) => {
    validationEntered.resolve()
    await validationRelease.promise
    observed = stillCurrent()
    throw new AcpModelError('LOCAL_ACP_MODEL_VIEW_BUSY', 'view busy', -32046)
  }
  const selection = view.registry.setConfigOption(
    view.conn, view.access,
    { sessionId: 'S-model-command', configId: 'model', value: '["p1","b"]' },
    new AbortController().signal,
  )
  await validationEntered.promise
  const commandEntered = deferred<void>()
  const commandRelease = deferred<unknown>()
  view.access.executeStandaloneCommandImpl = async () => {
    commandEntered.resolve()
    return await commandRelease.promise
  }
  const command = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'S-model-command', prompt: [{ type: 'text', text: '/feedback held model' }] },
    new AbortController().signal, false, async () => {},
  )
  await commandEntered.promise
  validationRelease.resolve()
  await assert.rejects(selection, isViewError('LOCAL_ACP_MODEL_VIEW_BUSY'))
  assert.equal(observed, 'view-busy', 'the final currentness gate sees the command slot')
  assert.equal(view.access.selectModelCalls.length, 1, 'the Host model write is rejected once')
  commandRelease.resolve({ result: { kind: 'success', text: 'ok' } })
  assert.deepEqual(await command, { stopReason: 'end_turn' })
})

test('a prompt admitted while model validation is pending is rejected at the last View busy gate', async () => {
  const view = promptView('S-model-race')
  await view.attach()
  const gate = deferred<void>()
  let observed: AcpModelCurrentness | undefined
  view.access.selectModelImpl = async (_agent, _session, _request, _signal, stillCurrent) => {
    await gate.promise
    observed = stillCurrent()
    if (observed !== 'view-busy') throw new AcpModelError('LOCAL_ACP_MODEL_STALE', 'stale', -32042)
    throw new AcpModelError('LOCAL_ACP_MODEL_VIEW_BUSY', 'view busy', -32046)
  }
  const selection = view.registry.setConfigOption(
    view.conn,
    view.access,
    { sessionId: 'S-model-race', configId: 'model', value: '["p1","b"]' },
    new AbortController().signal,
  )
  // The prompt is admitted while the model service is still validating; this
  // is the exact interleaving that must not append a Session model selection.
  const attempt = view.start('race prompt')
  const request = view.access.promptCalls[0]!
  gate.resolve()
  await assert.rejects(selection, isViewError('LOCAL_ACP_MODEL_VIEW_BUSY'))
  assert.equal(observed, 'view-busy')
  assert.equal(view.access.selectModelCalls.length, 1)
  // Settle the prompt through its real facts; the View stays usable.
  view.insert(request.requestId, 'm-race')
  view.claim('m-race', 1, request.requestId)
  view.commit('assistant/message', assistantData(1, 'm-race', [{ type: 'text', text: 'ok' }]))
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('a model/selection event sends one full config_option_update to the exact attached claim only', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-notify', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","b"]')
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const notifications: Array<{ readonly sessionId: string; readonly update: AcpConfigUpdate }> = []
  await registry.resumeSession(conn, access, { sessionId: 'S-notify', cwd: '/w' }, {
    notifyConfigUpdate: async (sessionId, update) => {
      notifications.push({ sessionId, update })
    },
  })
  await registry.sessionConfigState(conn, access, 'S-notify')

  registry.onSessionEvent({ id: 'other' }, { seq: 4, type: 'model/selection', data: { provider: 'p1', model: 'b' } })
  registry.onSessionEvent(agent.session, { seq: 5, type: 'model/selection', data: { provider: 'p1', model: 'b' } })
  await flushOutput()
  assert.deepEqual(notifications, [{
    sessionId: 'S-notify',
    update: { kind: 'config', configOptions: modelOptionsFor('["p1","b"]') },
  }])

  await registry.closeSession(conn, access, 'S-notify')
  registry.onSessionEvent(agent.session, { seq: 6, type: 'model/selection', data: { provider: 'p1', model: 'c' } })
  await flushOutput()
  assert.equal(notifications.length, 1, 'a closed claim receives no config update')
})

test('an async config read for an old claim never reaches a re-bound View', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-lag', '/w')
  access.seed(agent)
  const gate = deferred<SessionConfigOption[]>()
  let reads = 0
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const oldNotifications: AcpConfigUpdate[] = []
  await registry.resumeSession(conn, access, { sessionId: 'S-lag', cwd: '/w' }, {
    notifyConfigUpdate: async (_sessionId, update) => {
      oldNotifications.push(update)
    },
  })
  await registry.sessionConfigState(conn, access, 'S-lag')
  access.modelOptionsImpl = async () => {
    reads += 1
    return reads === 1 ? await gate.promise : modelOptionsFor('["p1","c"]')
  }
  registry.onSessionEvent(agent.session, { seq: 7, type: 'model/selection', data: { provider: 'p1', model: 'b' } })
  await Promise.resolve()
  await registry.closeSession(conn, access, 'S-lag')

  const conn2 = registry.createConnection()
  const newNotifications: AcpConfigUpdate[] = []
  await registry.resumeSession(conn2, access, { sessionId: 'S-lag', cwd: '/w' }, {
    notifyConfigUpdate: async (_sessionId, update) => {
      newNotifications.push(update)
    },
  })
  await registry.sessionConfigState(conn2, access, 'S-lag')
  gate.resolve(modelOptionsFor('["p1","b"]'))
  await flushOutput()
  assert.deepEqual(oldNotifications, [], 'a closed claim cannot deliver its late catalog read')
  assert.deepEqual(newNotifications, [], 'the new claim receives nothing for the old event')

  registry.onSessionEvent(agent.session, { seq: 8, type: 'model/selection', data: { provider: 'p1', model: 'c' } })
  await flushOutput()
  assert.deepEqual(newNotifications, [{ kind: 'config', configOptions: modelOptionsFor('["p1","c"]') }])
})

test('a config invalidation during a held read discards the old cut and delivers only the latest state', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-order', '/w')
  access.seed(agent)
  const first = deferred<SessionConfigOption[]>()
  const started = deferred<void>()
  let reads = 0
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const notifications: string[] = []
  await registry.resumeSession(conn, access, { sessionId: 'S-order', cwd: '/w' }, {
    notifyConfigUpdate: async (_sessionId, update) => {
      if (update.kind === 'config') notifications.push((update.configOptions[0] as { currentValue: string }).currentValue)
    },
  })
  await registry.sessionConfigState(conn, access, 'S-order')
  access.modelOptionsImpl = async () => {
    reads += 1
    if (reads === 1) {
      started.resolve()
      return await first.promise
    }
    return modelOptionsFor('["p1","c"]')
  }

  registry.onSessionEvent(agent.session, { seq: 9, type: 'model/selection', data: { provider: 'p1', model: 'b' } })
  await started.promise
  // The invalidation arrives WHILE the first cut is still held: that cut can
  // never be delivered as current.
  registry.onSessionEvent(agent.session, { seq: 10, type: 'model/selection', data: { provider: 'p1', model: 'c' } })
  first.resolve(modelOptionsFor('["p1","b"]'))
  await flushOutput()
  assert.ok(reads >= 2, 'the invalidated cut was re-read instead of delivered')
  assert.deepEqual(notifications.filter(value => value === '["p1","b"]'), [], 'the stale cut was never delivered')
  assert.equal(notifications.at(-1), '["p1","c"]', 'the final delivered state is the newest cut')
})


test('an invalidation during the SECOND coalesced pass is not dropped by the pass bound', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-order-2', '/w')
  access.seed(agent)
  let reads = 0
  const first = deferred<SessionConfigOption[]>()
  const started = deferred<void>()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const notifications: string[] = []
  await registry.resumeSession(conn, access, { sessionId: 'S-order-2', cwd: '/w' }, {
    notifyConfigUpdate: async (_sessionId, update) => {
      if (update.kind !== 'config') return
      const value = (update.configOptions[0] as { currentValue: string }).currentValue
      notifications.push(value)
      // The second delivered cut is still being sent when a newer authoritative
      // event arrives: the loop bound must not clear that dirty fact.
      if (value === '["p1","m3"]') {
        registry.onSessionEvent(agent.session, { seq: 30, type: 'model/selection', data: { provider: 'p1', model: 'm4' } })
      }
    },
  })
  await registry.sessionConfigState(conn, access, 'S-order-2')
  access.modelOptionsImpl = async () => {
    reads += 1
    if (reads === 1) {
      started.resolve()
      return await first.promise
    }
    return modelOptionsFor(`["p1","m${String(reads)}"]`)
  }
  registry.onSessionEvent(agent.session, { seq: 10, type: 'model/selection', data: { provider: 'p1', model: 'm1' } })
  await started.promise
  registry.onSessionEvent(agent.session, { seq: 20, type: 'model/selection', data: { provider: 'p1', model: 'm3' } })
  first.resolve(modelOptionsFor('["p1","m1"]'))
  await flushOutput()
  await flushOutput()
  assert.equal(reads >= 4, true, 'the invalidation during the second pass must schedule a third pass')
  assert.equal(notifications.at(-1), '["p1","m4"]', 'the newest committed cut must be delivered')
})

test('the initial config state uses one policy cut in the fixed model, mode, agent_team order', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-cfg', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  access.readSessionPolicyImpl = () => ({ mode: 'plan', agentTeam: true })
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-cfg', cwd: '/w' }, {
    capabilities: { plan: false, compaction: false, subagents: false, notices: false, booleanConfigOptions: true },
  })
  const snapshot = await registry.sessionConfigState(conn, access, 'S-cfg')
  assert.equal(snapshot.modes?.currentModeId, 'plan')
  const ids = (snapshot.configOptions ?? []).map(option => option.id)
  assert.deepEqual(ids, ['model', 'mode', 'agent_team'])
  const modeRow = snapshot.configOptions?.find(option => option.id === 'mode')
  assert.equal((modeRow as { currentValue?: string }).currentValue, 'plan')
  const teamRow = snapshot.configOptions?.find(option => option.id === 'agent_team')
  assert.equal((teamRow as { currentValue?: boolean }).currentValue, true)
})

test('the Agent Team row is absent when the connection did not negotiate the boolean capability', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-no-bool', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  access.readSessionPolicyImpl = () => ({ mode: 'default', agentTeam: true })
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-no-bool', cwd: '/w' })
  const snapshot = await registry.sessionConfigState(conn, access, 'S-no-bool')
  assert.deepEqual((snapshot.configOptions ?? []).map(option => option.id), ['model', 'mode'])
  await assert.rejects(
    registry.setConfigOption(conn, access, { sessionId: 'S-no-bool', configId: 'agent_team', type: 'boolean', value: true }, new AbortController().signal),
    isViewError('LOCAL_ACP_CONFIG_INVALID_OPTION'),
  )
})

test('legacy session/set_mode is refused before the modes list was announced, then writes the same policy authority', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-mode', '/w')
  access.seed(agent)
  let policy: AcpSessionPolicyState = { mode: 'default' }
  const writes: AcpSessionPolicyRequest[] = []
  access.readSessionPolicyImpl = () => policy
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  access.selectSessionPolicyImpl = async (_agent, _session, request) => {
    writes.push(request)
    if (request.kind === 'mode') policy = { mode: request.mode }
    return policy
  }
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-mode', cwd: '/w' })
  await assert.rejects(
    registry.setMode(conn, access, 'S-mode', 'plan', new AbortController().signal),
    isViewError('LOCAL_ACP_CONFIG_INVALID_OPTION'),
  )
  await registry.sessionConfigState(conn, access, 'S-mode')
  assert.deepEqual(await registry.setMode(conn, access, 'S-mode', 'plan', new AbortController().signal), {})
  assert.deepEqual(writes, [{ kind: 'mode', mode: 'plan' }])
  const selected = await registry.setConfigOption(
    conn,
    access,
    { sessionId: 'S-mode', configId: 'mode', value: 'default' },
    new AbortController().signal,
  )
  assert.equal((selected.find(option => option.id === 'mode') as { currentValue?: string }).currentValue, 'default')
  assert.deepEqual(writes, [{ kind: 'mode', mode: 'plan' }, { kind: 'mode', mode: 'default' }])
})

test('a held policy write refuses a prompt, a model commit and a second policy write on the same View', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-busy-policy', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  const gate = deferred<AcpSessionPolicyState>()
  access.selectSessionPolicyImpl = async () => await gate.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-busy-policy', cwd: '/w' })
  const first = registry.setConfigOption(
    conn,
    access,
    { sessionId: 'S-busy-policy', configId: 'mode', value: 'plan' },
    new AbortController().signal,
  )
  await flushOutput()
  await assert.rejects(
    registry.promptSession(conn, access, { sessionId: 'S-busy-policy', prompt: [{ type: 'text', text: 'hi' }] }, new AbortController().signal, false, async () => {}),
    isViewError('LOCAL_ACP_PROMPT_IN_FLIGHT'),
  )
  await assert.rejects(
    registry.setConfigOption(conn, access, { sessionId: 'S-busy-policy', configId: 'model', value: '["p1","a"]' }, new AbortController().signal),
    isViewError('LOCAL_ACP_MODEL_VIEW_BUSY'),
  )
  await assert.rejects(
    registry.setConfigOption(conn, access, { sessionId: 'S-busy-policy', configId: 'mode', value: 'default' }, new AbortController().signal),
    isViewError('LOCAL_ACP_CONFIG_VIEW_BUSY'),
  )
  gate.resolve({ mode: 'plan' })
  await first
})

test('close waits for the captured policy terminal without cancelling it, then releases the View', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-close-policy', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  const gate = deferred<AcpSessionPolicyState>()
  access.selectSessionPolicyImpl = async () => await gate.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-close-policy', cwd: '/w' })
  const write = registry.setConfigOption(
    conn,
    access,
    { sessionId: 'S-close-policy', configId: 'mode', value: 'plan' },
    new AbortController().signal,
  )
  await flushOutput()
  let closed = false
  const closing = registry.closeSession(conn, access, 'S-close-policy').then(() => { closed = true })
  await flushOutput()
  assert.equal(closed, false, 'close never fabricates a detach before the Host terminal')
  assert.equal(registry.claimCount(), 1, 'the exact claim stays fenced while the write is unsettled')
  gate.resolve({ mode: 'plan' })
  await write.catch(() => {})
  await closing
  assert.equal(registry.claimCount(), 0)
})

test('a physical release keeps the policy claim fenced until the original write settles', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('S-eof-policy', '/w')
  access.seed(agent)
  access.modelOptionsImpl = async () => modelOptionsFor('["p1","a"]')
  const gate = deferred<AcpSessionPolicyState>()
  access.selectSessionPolicyImpl = async () => await gate.promise
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'S-eof-policy', cwd: '/w' })
  const write = registry.setConfigOption(
    conn,
    access,
    { sessionId: 'S-eof-policy', configId: 'mode', value: 'plan' },
    new AbortController().signal,
  )
  await flushOutput()
  registry.releaseConnection(conn, access)
  assert.equal(registry.claimCount(), 1, 'EOF/Off is not the policy terminal')
  gate.resolve({ mode: 'plan' })
  await write.catch(() => {})
  await flushOutput()
  assert.equal(registry.claimCount(), 0)
})

test('session/new mounts one scoped MCP lease before attached and close releases the claim only after retirement', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-new', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const retire = deferred<void>()
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => lease
  access.retireScopedMcpImpl = async () => await retire.promise

  assert.deepEqual(await registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] }), { sessionId: agent.id })
  assert.equal(access.mountScopedMcpCalls.length, 1)
  assert.equal(registry.phaseOf(conn), 'attached')

  assert.deepEqual(await registry.closeSession(conn, access, agent.id), {})
  assert.equal(access.retireScopedMcpCalls.length, 1)
  assert.equal(registry.claimCount(), 1, 'the claim stays fenced while the exact lease is retiring')
  retire.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('session/new returns the authoritative created session id when its MCP mount fails after the Host create', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-fail', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  access.mountScopedMcpImpl = async () => { throw new AcpScopedMcpError('START_FAILED', 'start failed') }

  await assert.rejects(
    registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] }),
    (error: unknown) => error instanceof LocalAcpViewError
      && error.code === 'LOCAL_ACP_MCP_START_FAILED'
      && error.data.sessionId === agent.id,
  )
  assert.equal(access.createSessionCalls.length, 1, 'a failed mount never retries the Host create')
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
})

test('a busy MCP mount refuses session/resume without attaching, and the later retry succeeds on the same Agent', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-busy', '/work/mcp')
  access.seed(agent)
  const lease = makeScopedLease(agent, agent.session)
  let attempt = 0
  access.mountScopedMcpImpl = async () => {
    attempt += 1
    if (attempt === 1) throw new AcpScopedMcpError('AGENT_BUSY', 'busy')
    return lease
  }

  await assert.rejects(
    registry.resumeSession(conn, access, { sessionId: agent.id, cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] }),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_MCP_AGENT_BUSY',
  )
  assert.equal(registry.claimCount(), 0)
  assert.equal(registry.phaseOf(conn), 'idle')
  assert.deepEqual(await registry.resumeSession(conn, access, {
    sessionId: agent.id, cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }],
  }), {})
  assert.equal(registry.phaseOf(conn), 'attached')
})

test('a close during a pending MCP mount keeps the reservation and retires the late lease instead of attaching it', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-close-pending', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const mounted = deferred<AcpScopedMcpLease>()
  const retire = deferred<void>()
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => await mounted.promise
  access.retireScopedMcpImpl = async () => await retire.promise

  const attaching = registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  while (access.mountScopedMcpCalls.length === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await registry.closeSession(conn, access, agent.id), {})
  mounted.resolve(lease)
  await assert.rejects(attaching, (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_MCP_STALE')
  assert.equal(access.retireScopedMcpCalls.length, 1)
  assert.equal(registry.claimCount(), 1)
  retire.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.claimCount(), 0)
})

test('a physical disconnect during a pending MCP mount retires the late lease and never resurrects the closed view', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-eof', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const mounted = deferred<AcpScopedMcpLease>()
  const retire = deferred<void>()
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => await mounted.promise
  access.retireScopedMcpImpl = async () => await retire.promise

  const attaching = registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  while (access.mountScopedMcpCalls.length === 0) await new Promise(resolve => setImmediate(resolve))
  registry.releaseConnection(conn, access)
  mounted.resolve(lease)
  await assert.rejects(attaching, (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_MCP_STALE')
  assert.equal(registry.phaseOf(conn), 'closed')
  assert.equal(access.retireScopedMcpCalls.length, 1)
  assert.equal(registry.claimCount(), 1)
  retire.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.claimCount(), 0)
})

test('an unconfirmed MCP cleanup keeps the exact claim fenced so a second connection cannot attach the Session', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const first = registry.createConnection()
  const second = registry.createConnection()
  const agent = makeAgent('mcp-fenced', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => lease
  access.retireScopedMcpImpl = async () => {
    throw new AcpScopedMcpError('CLEANUP_UNCONFIRMED', 'cleanup unconfirmed', lease)
  }

  await registry.newSession(first, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  assert.deepEqual(await registry.closeSession(first, access, agent.id), {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.claimCount(), 1, 'the unconfirmed cleanup must keep its exact claim')
  await assert.rejects(
    registry.resumeSession(second, access, { sessionId: agent.id, cwd: '/work/mcp' }),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
  )
})

test('an unconfirmed MCP retirement is retried on a later real terminal instead of fencing the Session forever', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-retry', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => lease
  let attempts = 0
  access.retireScopedMcpImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new AcpScopedMcpError('CLEANUP_UNCONFIRMED', 'cleanup unconfirmed', lease)
  }

  await registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  assert.deepEqual(await registry.closeSession(conn, access, agent.id), {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 1)
  assert.equal(registry.claimCount(), 1, 'the failed attempt keeps the exact claim fenced')
  // The Agent disposal is a new real terminal fact; the same lease must be
  // retried instead of accepting the rejected retirePromise as final.
  registry.onAgentDisposed(agent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.equal(registry.claimCount(), 0)
})

test('an Agent disposal releases an attached claim with no other obligation', async () => {
  const access = new FakeAccess()
  const agent = makeAgent('agent-disposed-plain', '/work/plain')
  access.seed(agent)
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const conn = registry.createConnection()
  await registry.resumeSession(conn, access, { sessionId: 'agent-disposed-plain', cwd: '/work/plain' })
  assert.equal(registry.phaseOf(conn), 'attached')
  registry.onAgentDisposed(agent)
  assert.equal(registry.claimCount(), 0, 'the disposed exact Agent claim must not fence the Session')
  assert.equal(registry.phaseOf(conn), 'idle', 'only the disposed View slot becomes idle')
})

test('an Agent disposal releases an attached claim after its MCP lease retires', async () => {
  const access = new FakeAccess()
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const agent = makeAgent('mcp-disposed', '/work/mcp')
  access.seed(agent)
  access.createSessionImpl = async () => ({ kind: 'created', sessionId: agent.id })
  const lease = makeScopedLease(agent, agent.session)
  access.mountScopedMcpImpl = async () => lease
  access.retireScopedMcpImpl = async () => {}

  await registry.newSession(conn, access, { cwd: '/work/mcp', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  assert.equal(registry.phaseOf(conn), 'attached')
  registry.onAgentDisposed(agent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.claimCount(), 0, 'the disposed Agent claim must not block a later resume')
})

// ---------------------------------------------------------------------------
// G-ACP2-PR1: owned transient streaming, question Forms and continued lifecycles.
// ---------------------------------------------------------------------------

/** One recorded reverse `elicitation/create` the fake connection must answer. */
interface PendingForm {
  readonly request: AcpElicitationRequest
  readonly signal: AbortSignal
  respond(response: AcpElicitationResponse): void
  fail(error: unknown): void
}

/** The ONE connection-scoped reverse Form channel of a fake ACP client. */
function formChannel(): { requester: AcpElicitationRequester; forms: PendingForm[] } {
  const forms: PendingForm[] = []
  const requester: AcpElicitationRequester = (request, options) => new Promise((resolveForm, rejectForm) => {
    forms.push({
      request,
      signal: options.signal,
      respond: resolveForm,
      fail: rejectForm,
    })
  })
  return { requester, forms }
}

/** One official continued question read of the fake Host projection. */
function continuedQuestions(questions: readonly AcpQuestionSpec[], callId = 'call-continued'): AcpQuestionSnapshot {
  return { kind: 'current', continued: [{ callId, questions }], settled: new Set() }
}

/** One official transient stream frame at the given dense position. */
function streamFrame(attemptId: string, revision: number, index: number, chunk: Record<string, unknown>): Record<string, unknown> {
  return { type: 'chunk', attemptId, revision, index, time: index, chunk }
}

test('G-ACP2-PR1 ST-01/ST-02: transient deltas precede the durable message and the exact seq join never re-sends text', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-stream')
  view.access.turnFence = { openTurnStartSeq: 900, lastTurn: 9 }
  view.claim('m-stream', 9, request.requestId)
  const attemptId = 'P1:1'
  view.stream({ type: 'start', attemptId, revision: 1, turn: 9, step: 1 })
  view.stream(streamFrame(attemptId, 2, 0, { type: 'block-start', index: 0, blockType: 'text' }))
  view.stream(streamFrame(attemptId, 3, 1, { type: 'text-delta', index: 0, text: 'Hel' }))
  view.stream(streamFrame(attemptId, 4, 2, { type: 'text-delta', index: 0, text: 'lo' }))
  view.stream(streamFrame(attemptId, 5, 3, { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } }))
  await flushOutput()
  // BEFORE any durable assistant/message event: the model text is on the wire.
  assert.deepEqual(view.notifications.map(updateKind), ['agent_message_chunk', 'agent_message_chunk'])
  const streamedId = (view.notifications[0] as { messageId?: unknown }).messageId
  assert.equal(typeof streamedId, 'string', 'the provisional text carries one stable ACP message id')
  assert.equal((view.notifications[1] as { messageId?: unknown }).messageId, streamedId)
  assert.equal(chunkOf(view.notifications[0]).text, 'Hel')
  assert.equal(chunkOf(view.notifications[1]).text, 'lo')

  // The durable append commits, then its official end names the exact seq.
  view.commit('assistant/message', assistantData(9, 'm-durable', [{ type: 'text', text: 'Hello' }]))
  const seq = view.lastSeq()
  view.stream({ type: 'end', attemptId, revision: 6, index: 4, outcome: { kind: 'committed', eventType: 'assistant/message', seq } })
  await flushOutput()
  assert.equal(view.notifications.length, 2, 'the durable text was already delivered and is never re-sent')
  assert.equal(view.notifications.map(update => String((update as { messageId?: unknown }).messageId)).join(''), String(streamedId) + String(streamedId))
  view.commit('turn/end', { turn: 9, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 ST-02: a joined durable message adds only the image it never streamed', async () => {
  const view = promptView()
  await view.attach()
  view.access.storedImages.set('sha256:joined', { bytes: IMAGE_BYTES, mediaType: 'image/png' })
  const attempt = view.start('po4c:stream-join-image:v1')
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-stream-image')
  view.access.turnFence = { openTurnStartSeq: 910, lastTurn: 10 }
  view.claim('m-stream-image', 10, request.requestId)
  const attemptId = 'P1:2'
  view.stream({ type: 'start', attemptId, revision: 1, turn: 10, step: 1 })
  view.stream(streamFrame(attemptId, 2, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }))
  view.stream(streamFrame(attemptId, 3, 1, { type: 'reasoning-delta', index: 0, text: 'plan' }))
  view.stream(streamFrame(attemptId, 4, 2, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } }))
  view.stream(streamFrame(attemptId, 5, 3, { type: 'block-start', index: 1, blockType: 'text' }))
  view.stream(streamFrame(attemptId, 6, 4, { type: 'text-delta', index: 1, text: 'answer' }))
  view.stream(streamFrame(attemptId, 7, 5, { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } }))
  await flushOutput()
  assert.deepEqual(view.notifications.map(updateKind), ['agent_thought_chunk', 'agent_message_chunk'])

  view.commit('assistant/message', assistantData(10, 'm-durable-image', [
    { type: 'reasoning', text: 'plan' },
    { type: 'text', text: 'answer' },
    imageBlock('sha256:joined'),
  ]))
  const seq = view.lastSeq()
  view.stream({ type: 'end', attemptId, revision: 8, index: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq } })
  await flushOutput()
  assert.deepEqual(view.notifications.map(updateKind), ['agent_thought_chunk', 'agent_message_chunk', 'agent_message_chunk'],
    'only the never-streamed image is added')
  assert.equal(chunkOf(view.notifications[2]).type, 'image')
  const streamedId = (view.notifications[0] as { messageId?: unknown }).messageId
  assert.equal((view.notifications[2] as { messageId?: unknown }).messageId, streamedId,
    'the residual durable block continues the SAME provisional message')
  view.commit('turn/end', { turn: 10, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 ST-03: a framing gap, a mismatched seq or a different attempt never joins provisional text', async () => {
  {
    // An index gap breaks the attempt: its durable message can no longer prove
    // that the already delivered bytes are the committed content.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-gap')
    view.access.turnFence = { openTurnStartSeq: 920, lastTurn: 11 }
    view.claim('m-gap', 11, request.requestId)
    view.stream({ type: 'start', attemptId: 'P1:3', revision: 1, turn: 11, step: 1 })
    view.stream(streamFrame('P1:3', 2, 0, { type: 'text-delta', index: 0, text: 'part' }))
    view.stream(streamFrame('P1:3', 3, 7, { type: 'text-delta', index: 0, text: 'ial' }))
    await flushOutput()
    assert.equal(view.notifications.length, 1, 'the accepted delta was delivered before the gap')
    view.commit('assistant/message', assistantData(11, 'm-gap-durable', [{ type: 'text', text: 'partial' }]))
    view.stream({
      type: 'end', attemptId: 'P1:3', revision: 4, index: 8,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
    })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
    assert.equal(view.notifications.length, 1, 'no correction text is ever appended')
  }
  {
    // A committed message whose end names a DIFFERENT durable seq is unprovable.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-seq')
    view.access.turnFence = { openTurnStartSeq: 930, lastTurn: 12 }
    view.claim('m-seq', 12, request.requestId)
    view.stream({ type: 'start', attemptId: 'P1:4', revision: 1, turn: 12, step: 1 })
    view.stream(streamFrame('P1:4', 2, 0, { type: 'text-delta', index: 0, text: 'same' }))
    await flushOutput()
    view.commit('assistant/message', assistantData(12, 'm-seq-durable', [{ type: 'text', text: 'same' }]))
    view.stream({
      type: 'end', attemptId: 'P1:4', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() + 41 },
    })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
  }
  {
    // A replacement attempt that never sent bytes must NOT turn an already
    // delivered answer into a success: the client still shows the old bytes and
    // ACP v1 output cannot be retracted.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-replace')
    view.access.turnFence = { openTurnStartSeq: 940, lastTurn: 13 }
    view.claim('m-replace', 13, request.requestId)
    view.stream({ type: 'start', attemptId: 'P1:5', revision: 1, turn: 13, step: 1 })
    view.stream(streamFrame('P1:5', 2, 0, { type: 'text-delta', index: 0, text: 'retry' }))
    await flushOutput()
    view.stream({ type: 'start', attemptId: 'P1:6', revision: 3, turn: 13, step: 1 })
    view.commit('assistant/message', assistantData(13, 'm-retry-durable', [{ type: 'text', text: 'final' }]))
    view.stream({
      type: 'end', attemptId: 'P1:6', revision: 4, index: 0,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
    })
    // The real terminal is the LAST fact: without it an implementation that
    // accepted the replacement would merely hang instead of failing the test.
    view.commit('turn/end', { turn: 13, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
    await flushOutput()
    assert.equal(view.notifications.length, 1, 'the replacement never adds a second answer over the unprovable one')
    assert.equal(chunkOf(view.notifications[0]).text, 'retry')
  }
})

test('G-ACP2-PR1 ST-03/GL-01: a foreign turn start, an abandoned attempt or a later autonomous turn never stream here', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-owned-turn')
  view.access.turnFence = { openTurnStartSeq: 950, lastTurn: 21 }
  view.claim('m-owned-turn', 21, request.requestId)
  // A start of a DIFFERENT turn is never attributed to this flight.
  view.stream({ type: 'start', attemptId: 'P1:7', revision: 1, turn: 22, step: 1 })
  view.stream(streamFrame('P1:7', 2, 0, { type: 'text-delta', index: 0, text: 'other turn' }))
  await flushOutput()
  assert.equal(view.notifications.length, 0, 'a foreign turn never reaches this prompt')

  // The owned attempt streams, then abandons without a durable message.
  view.stream({ type: 'start', attemptId: 'P1:8', revision: 3, turn: 21, step: 1 })
  view.stream(streamFrame('P1:8', 4, 0, { type: 'text-delta', index: 0, text: 'provisional' }))
  view.stream({ type: 'end', attemptId: 'P1:8', revision: 5, index: 1, outcome: { kind: 'abandoned' } })
  await flushOutput()
  assert.equal(view.notifications.length, 1)
  // The attempt end is NOT the prompt end: the request still awaits turn/end,
  // and that completed terminal can never be reported as a success because the
  // abandoned bytes have no durable message.
  const settled = attempt.then(value => ({ value }), (error: unknown) => ({ error }))
  await flushOutput()
  assert.equal((await Promise.race([settled, Promise.resolve('pending')])), 'pending',
    'an attempt end never settles the prompt')
  view.commit('turn/end', { turn: 21, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))

  // A later autonomous (Goal) turn has no flight of its own: nothing streams.
  view.stream({ type: 'start', attemptId: 'P1:9', revision: 6, turn: 23, step: 1 })
  view.stream(streamFrame('P1:9', 7, 0, { type: 'text-delta', index: 0, text: 'autonomous' }))
  await flushOutput()
  assert.equal(view.notifications.length, 1, 'a settled flight never resumes streaming')
})

test('G-ACP2-PR1 QU-01: an owned blocking question travels as a standard Form and its accepted answer returns to the same waterfall', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-question')
  view.access.turnFence = { openTurnStartSeq: 960, lastTurn: 31 }
  view.claim('m-question', 31, request.requestId)
  const questions: AcpQuestionSpec[] = [
    { id: 'pick', question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'first' }, { label: 'B' }] },
    { id: 'many', question: 'Pick many', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
    { id: 'free', question: 'Anything else?', detail: 'free text' },
    { id: 'other', question: 'Which?', options: [{ label: 'p' }, { label: 'q' }] },
  ]
  let delegated = 0
  const answer = view.registry.onQuestionRequest(
    { agent: view.agent, questions, wait: { callId: 'call-question' } },
    async () => { delegated += 1; return { answers: [] } },
  )
  await flushOutput()
  assert.equal(delegated, 0, 'an ACP-owned question is never delegated to the TUI')
  assert.equal(channel.forms.length, 1, 'exactly one standard Form was sent on this connection')
  const form = channel.forms[0]!
  assert.equal(form.request.sessionId, 'P1')
  assert.equal(form.request.toolCallId, 'call-question')
  const schema = form.request.requestedSchema as { type?: string; required?: readonly string[]; properties?: Record<string, Record<string, unknown>> }
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, [])
  const properties = schema.properties!
  assert.deepEqual(Object.keys(properties), ['q0', 'q0__other', 'q1', 'q1__other', 'q2', 'q3', 'q3__other'])
  assert.deepEqual(properties.q0!.oneOf, [
    { const: 'A', title: 'A', description: 'first' },
    { const: 'B', title: 'B' },
  ])
  assert.equal(properties.q0!.title, 'Choice')
  assert.equal(properties.q1!.type, 'array')
  assert.deepEqual(properties.q1!.maxItems, 2)
  assert.equal(properties.q2!.type, 'string')
  assert.equal(properties.q2!.title, 'Question 3')
  assert.equal(properties.q2!.description, 'Anything else?\n\nfree text')
  assert.equal(properties.q3__other!.title, 'Other (optional)')

  form.respond({
    action: 'accept',
    content: { q0: 'B', q1: ['x', 'y'], q2: 'free answer', q3__other: 'custom text' },
  })
  assert.deepEqual(await answer, {
    answers: [
      { id: 'pick', selected: ['B'] },
      { id: 'many', selected: ['x', 'y'] },
      { id: 'free', selected: [], custom: 'free answer' },
      { id: 'other', selected: [], custom: 'custom text' },
    ],
  })
  // The accepted answer reaches the ORIGINAL waterfall only; the owned turn
  // then settles on its own real facts.
  view.commit('assistant/message', assistantData(31, 'm-after-question', [{ type: 'text', text: 'answered' }]))
  view.commit('turn/end', { turn: 31, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 QU-01 negatives: no Form capability, a foreign turn, an invalid answer, decline and cancel all fail closed', async () => {
  {
    // A TUI-owned turn keeps its existing seat: `next()` exactly once.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    await view.attach()
    view.access.turnFence = { openTurnStartSeq: 970, lastTurn: 41 }
    let delegated = 0
    const answer = await view.registry.onQuestionRequest(
      { agent: view.agent, questions: [{ id: 'tui', question: 'tui?' }] },
      async () => { delegated += 1; return { answers: [{ id: 'tui', selected: ['yes'] }] } },
    )
    assert.equal(delegated, 1)
    assert.deepEqual(answer, { answers: [{ id: 'tui', selected: ['yes'] }] })
    assert.equal(channel.forms.length, 0, 'a TUI question never gets an ACP Form')
  }
  {
    // An owned turn on a connection WITHOUT the negotiated Form capability.
    const view = promptView()
    view.access.questionService = true
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-no-form')
    view.access.turnFence = { openTurnStartSeq: 980, lastTurn: 42 }
    view.claim('m-no-form', 42, request.requestId)
    let delegated = 0
    await assert.rejects(
      view.registry.onQuestionRequest(
        { agent: view.agent, questions: [{ id: 'owned', question: 'owned?' }] },
        async () => { delegated += 1; return { answers: [] } },
      ),
      isPromptError('LOCAL_ACP_QUESTION_UNAVAILABLE'),
    )
    assert.equal(delegated, 0, 'an ACP-owned question is never handed to the TUI')
    view.commit('turn/end', { turn: 42, reason: { kind: 'error', error: { code: 'TOOL_FAILED', message: 'x' } } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  }
  {
    // Every illegal client answer keeps ONE stable classification.
    const cases: Array<{ readonly label: string; readonly response: AcpElicitationResponse }> = [
      { label: 'an unknown key', response: { action: 'accept', content: { q9: 'x' } } },
      { label: 'a label outside the options', response: { action: 'accept', content: { q0: 'Z' } } },
      { label: 'a wrong primitive type', response: { action: 'accept', content: { q0: ['A'] } } },
      { label: 'a JSON null single value', response: { action: 'accept', content: { q0: null } } },
      { label: 'a JSON null multi value', response: { action: 'accept', content: { q1: null } } },
      { label: 'a duplicated multi selection', response: { action: 'accept', content: { q1: ['x', 'x'] } } },
      { label: 'an unknown action', response: { action: 'approve' } },
    ]
    for (const scenario of cases) {
      const channel = formChannel()
      const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
      view.access.questionService = true
      await view.attach()
      const attempt = view.start()
      const request = view.access.promptCalls[0]!
      view.insert(request.requestId, 'm-bad-answer')
      view.access.turnFence = { openTurnStartSeq: 990, lastTurn: 43 }
      view.claim('m-bad-answer', 43, request.requestId)
      const answer = view.registry.onQuestionRequest(
        {
          agent: view.agent,
          questions: [
            { id: 'one', question: 'one', options: [{ label: 'A' }, { label: 'B' }] },
            { id: 'two', question: 'two', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
          ],
        },
        async () => ({ answers: [] }),
      )
      await flushOutput()
      channel.forms[0]!.respond(scenario.response)
      await assert.rejects(answer, isPromptError('LOCAL_ACP_QUESTION_BAD_ANSWER'), scenario.label)
      view.registry.onAgentDisposed(view.agent)
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
    }
    for (const action of ['decline', 'cancel'] as const) {
      const channel = formChannel()
      const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
      view.access.questionService = true
      await view.attach()
      const attempt = view.start()
      const request = view.access.promptCalls[0]!
      view.insert(request.requestId, 'm-declined')
      view.access.turnFence = { openTurnStartSeq: 1000, lastTurn: 44 }
      view.claim('m-declined', 44, request.requestId)
      const answer = view.registry.onQuestionRequest(
        { agent: view.agent, questions: [{ id: 'one', question: 'one', options: [{ label: 'A' }] }] },
        async () => ({ answers: [] }),
      )
      await flushOutput()
      channel.forms[0]!.respond({ action })
      await assert.rejects(answer, isPromptError('LOCAL_ACP_QUESTION_DECLINED'), action)
      view.registry.onAgentDisposed(view.agent)
      await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
    }
  }
})

test('G-ACP2-PR1 QU-02/QU-03: the native timed deadline answers pending at once and exactly one late answer reaches the official service', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-timed')
  view.access.turnFence = { openTurnStartSeq: 1010, lastTurn: 51 }
  view.claim('m-timed', 51, request.requestId)
  const questions: AcpQuestionSpec[] = [{ id: 'timed', question: 'answer?', options: [{ label: 'yes' }, { label: 'no' }] }]
  // The official projection reports the call as NOT yet continued (the durable
  // tool result has not committed): a late answer must be held, not guessed.
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued: [], settled: new Set() })
  const answered: Array<{ callId: string; answer: unknown }> = []
  view.access.answerContinuedImpl = (_sessionId, _agent, _session, callId, answer) => {
    answered.push({ callId, answer })
    return { kind: 'queued' }
  }
  const deadline = new AbortController()
  const answer = view.registry.onQuestionRequest(
    { agent: view.agent, questions, signal: deadline.signal, wait: { callId: 'call-timed', timed: true } },
    async () => ({ answers: [] }),
  )
  await flushOutput()
  assert.equal(channel.forms.length, 1)
  // The OFFICIAL deadline (not a JS timer) aborts the foreground waterfall.
  const timedOut = Object.assign(new Error('ask_user_question timed out before the user answered'), {
    name: 'UserQuestionError',
    code: 'ASK_TIMED_OUT',
  })
  deadline.abort(timedOut)
  await assert.rejects(answer, (error: unknown) => error === timedOut,
    'the original waterfall rejects with the official abort reason (askTimed becomes pending)')
  assert.equal(channel.forms[0]!.signal.aborted, false, 'the Form is NOT revoked by the timed deadline')
  // A projection change BEFORE the durable tool/result records `continued` is
  // not proof that the call settled: the still-open Form must survive it.
  view.registry.onQuestionProjection(view.agent.session, 'inbox')
  await flushOutput()
  assert.equal(channel.forms[0]!.signal.aborted, false, 'an unrecorded continued call keeps its Form')

  // The human answers late: the single legal answer is held until the official
  // projection proves the call is continued.
  channel.forms[0]!.respond({ action: 'accept', content: { q0: 'yes' } })
  await flushOutput()
  assert.equal(answered.length, 0, 'a late answer is never submitted before the projection says continued')

  view.access.questionSnapshotImpl = () => continuedQuestions(questions, 'call-timed')
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.deepEqual(answered, [{ callId: 'call-timed', answer: { answers: [{ id: 'timed', selected: ['yes'] }] } }])
  // A second projection change never submits the same answer twice.
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.equal(answered.length, 1)
  // The Turn itself was never held by the Form: it settles on its own facts.
  view.commit('assistant/message', assistantData(51, 'm-timed-after', [{ type: 'text', text: 'continued' }]))
  view.commit('turn/end', { turn: 51, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 QU-03 negatives: a non-timed abort revokes the Form, a queued reply stops the obligation and a close aborts every reverse Form', async () => {
  {
    // A turn cancellation is NOT a timed deadline: the Form is revoked.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-cancel-form')
    view.access.turnFence = { openTurnStartSeq: 1020, lastTurn: 52 }
    view.claim('m-cancel-form', 52, request.requestId)
    const signal = new AbortController()
    const answer = view.registry.onQuestionRequest(
      { agent: view.agent, questions: [{ id: 'q', question: 'q?' }], signal: signal.signal, wait: { callId: 'call-x', timed: true } },
      async () => ({ answers: [] }),
    )
    await flushOutput()
    const cancelled = Object.assign(new Error('turn cancelled'), { name: 'AbortError' })
    signal.abort(cancelled)
    await assert.rejects(answer, (error: unknown) => error === cancelled)
    await flushOutput()
    assert.equal(channel.forms[0]!.signal.aborted, true, 'a non-deadline abort revokes the Form')
    assert.equal(view.access.answerContinuedCalls.length, 0)
    view.commit('turn/end', { turn: 52, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_TURN_FAILED'))
  }
  {
    // The official service rejects the late reply (another owner queued one):
    // the obligation ends and is never retried.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-queued')
    view.access.turnFence = { openTurnStartSeq: 1030, lastTurn: 53 }
    view.claim('m-queued', 53, request.requestId)
    view.access.questionSnapshotImpl = () => continuedQuestions([{ id: 'q', question: 'q?' }], 'call-queued')
    view.access.answerContinuedImpl = () => ({ kind: 'rejected', code: 'REPLY_QUEUED' })
    const deadline = new AbortController()
    const answer = view.registry.onQuestionRequest(
      { agent: view.agent, questions: [{ id: 'q', question: 'q?' }], signal: deadline.signal, wait: { callId: 'call-queued', timed: true } },
      async () => ({ answers: [] }),
    )
    await flushOutput()
    deadline.abort(Object.assign(new Error('timeout'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }))
    await assert.rejects(answer)
    channel.forms[0]!.respond({ action: 'accept', content: { q0: 'late' } })
    await flushOutput()
    assert.equal(view.access.answerContinuedCalls.length, 1, 'the official submission happened exactly once')
    view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
    await flushOutput()
    assert.equal(view.access.answerContinuedCalls.length, 1, 'REPLY_QUEUED is never retried')
    view.commit('turn/end', { turn: 53, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  }
  {
    // Closing the View aborts an outstanding continued Form and keeps the Host
    // projection untouched.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-close-form')
    view.access.turnFence = { openTurnStartSeq: 1040, lastTurn: 54 }
    view.claim('m-close-form', 54, request.requestId)
    const deadline = new AbortController()
    const answer = view.registry.onQuestionRequest(
      { agent: view.agent, questions: [{ id: 'q', question: 'q?' }], signal: deadline.signal, wait: { callId: 'call-close', timed: true } },
      async () => ({ answers: [] }),
    )
    await flushOutput()
    deadline.abort(Object.assign(new Error('timeout'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }))
    await assert.rejects(answer)
    // The continued Form outlives the PROMPT flight: it is released by the
    // claim/connection, never by the turn's own settlement.
    view.commit('assistant/message', assistantData(54, 'm-close-after', [{ type: 'text', text: 'done' }]))
    view.commit('turn/end', { turn: 54, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
    assert.equal(channel.forms[0]!.signal.aborted, false, 'a settled flight does not revoke a continued Form')
    await view.registry.closeSession(view.conn, view.access, 'P1')
    await flushOutput()
    assert.equal(channel.forms[0]!.signal.aborted, true, 'close aborts the connection-owned reverse Form')
  }
})

test('G-ACP2-PR1 QU-04: resume offers the official continued questions one at a time and an answer from another owner stops the Form', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  const first: AcpQuestionSpec[] = [{ id: 'first', question: 'first?', options: [{ label: 'yes' }] }]
  const second: AcpQuestionSpec[] = [{ id: 'second', question: 'second?' }]
  const continued = [
    { callId: 'call-first', questions: first },
    { callId: 'call-second', questions: second },
  ]
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued, settled: new Set() })
  const answered: string[] = []
  view.access.answerContinuedImpl = (_sessionId, _agent, _session, callId) => {
    answered.push(callId)
    return { kind: 'queued' }
  }
  await view.attach()
  await flushOutput()
  assert.equal(channel.forms.length, 1, 'exactly ONE Form is outstanding at a time')
  assert.equal(channel.forms[0]!.request.toolCallId, 'call-first')
  // The human answers the FIRST continued question.
  channel.forms[0]!.respond({ action: 'accept', content: { q0: 'yes' } })
  await flushOutput()
  assert.deepEqual(answered, ['call-first'])
  assert.equal(channel.forms.length, 2, 'the next continued question follows in official ask order')
  assert.equal(channel.forms[1]!.request.toolCallId, 'call-second')
  // Another owner settles the second call first: the projection change aborts
  // the stale Form instead of leaving it open.
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued: [], settled: new Set(['call-second']) })
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.equal(channel.forms[1]!.signal.aborted, true)
  assert.deepEqual(answered, ['call-first'], 'a settled call is never answered from a stale Form')
})

test('G-ACP2-PR1 MX-01: a late human user-question-reply makes the owned turn MIXED while internal injections do not', async () => {
  {
    // The SAME internal-injection negative control as the main-line fix.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-owned')
    view.registry.onInboxClaimed(view.agent, { id: 'm-skill', source: { kind: 'skill-invocation' } }, 61)
    view.claim('m-owned', 61, request.requestId)
    view.commit('assistant/message', assistantData(61, 'm-ok', [{ type: 'text', text: 'ok' }]))
    view.commit('turn/end', { turn: 61, reason: { kind: 'completed' } })
    assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  }
  {
    // A late human reply to a continued question claimed into the SAME turn is
    // a SECOND human input: the turn is MIXED even though this View submitted it.
    const view = promptView()
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-owned')
    view.access.turnFence = { openTurnStartSeq: 1100, lastTurn: 62 }
    view.claim('m-owned', 62, request.requestId)
    view.registry.onInboxClaimed(view.agent, { id: 'm-late-reply', source: { kind: 'user-question-reply' } }, 62)
    view.commit('turn/end', { turn: 62, reason: { kind: 'completed' } })
    await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
  }
})

test('G-ACP2-PR1: the pure Form projection rejects an unrepresentable batch and keeps __proto__ inert', () => {
  assert.equal(buildQuestionForm([]), undefined, 'an empty batch has no Form')
  assert.equal(buildQuestionForm([
    { id: 'dup', question: 'a' },
    { id: 'dup', question: 'b' },
  ]), undefined, 'duplicate official ids cannot collide on the wire')
  const form = buildQuestionForm([{ id: 'only', question: 'ok?', options: [{ label: 'yes' }] }])
  assert.ok(form !== undefined)
  // A response keyed by the prototype accessor never resolves to a selection.
  const polluted = JSON.parse('{"action":"accept","content":{"__proto__":"yes"}}') as unknown
  assert.deepEqual(answerQuestionForm(form, polluted), { kind: 'invalid' })
  // An accepted empty content is DSH's documented skip, never an approval.
  assert.deepEqual(answerQuestionForm(form, { action: 'accept', content: {} }), {
    kind: 'answered',
    answers: [{ id: 'only', selected: [] }],
  })
})

test('G-ACP2-PR1 QU-01: a question of a TUI-origin turn keeps its TUI responder even when the ACP message joined that turn', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  await view.attach()
  // The TUI already opened the turn before this ACP prompt was admitted.
  view.access.turnFence = { openTurnStartSeq: 700, lastTurn: 7 }
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-steered')
  view.claim('m-steered', 7, request.requestId)
  let delegated = 0
  const answer = await view.registry.onQuestionRequest(
    { agent: view.agent, questions: [{ id: 'tui-question', question: 'whose?' }] },
    async () => { delegated += 1; return { answers: [{ id: 'tui-question', selected: ['tui'] }] } },
  )
  assert.equal(delegated, 1, 'the TUI responder of its own turn answers exactly once')
  assert.deepEqual(answer, { answers: [{ id: 'tui-question', selected: ['tui'] }] })
  assert.equal(channel.forms.length, 0, 'the ACP connection never receives a Form for a TUI-origin turn')
  // The turn itself is still MIXED for the ACP prompt's own output contract.
  view.commit('assistant/message', assistantData(7, 'm-mixed-answer', [{ type: 'text', text: 'answer' }]))
  view.commit('turn/end', { turn: 7, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_MIXED_TURN'))
})

test('G-ACP2-PR1 ST-03: an attempt whose terminal can never be observed is permanently closed and its late frames are inert', async () => {
  // The stream's OWN state must be the guarantee, not the surrounding output fence.
  const attempt = new AcpAssistantStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 3, step: 1 }, 'acp-message-1')
  assert.deepEqual(
    attempt.acceptChunk({ type: 'chunk', attemptId: 'a1', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }),
    { kind: 'delta', delta: { kind: 'message', text: 'hi' } },
  )
  assert.equal(attempt.isOpen(), true)
  attempt.endWithoutTerminal()
  assert.equal(attempt.isOpen(), false, 'a lost terminal closes the attempt for good')
  assert.equal(await attempt.terminalFact, undefined, 'the terminal fact stays unknowable')
  assert.equal(attempt.hasTerminal, false, 'no terminal fact was recorded yet')
  assert.deepEqual(
    attempt.acceptChunk({ type: 'chunk', attemptId: 'a1', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: 'late' } }),
    { kind: 'broken' },
    'a late chunk is rejected by the attempt itself',
  )
  assert.equal(
    attempt.acceptEnd({ type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } }),
    false,
    'a late end frame cannot claim the closed attempt',
  )
  // The late end is a COMPLETE no-op: it may not even record an outcome.
  assert.equal(await attempt.terminalFact, undefined, 'a late end never repairs the unknowable terminal fact')
  assert.equal(attempt.hasTerminal, false, 'a late end on a permanently closed attempt records NOTHING')
  assert.equal(attempt.isOpen(), false, 'a late end never reopens the attempt')
  assert.deepEqual(attempt.streamedBlocks(), [{ kind: 'message', text: 'hi' }],
    'the delivered preview stays available for the fail-closed join')
  assert.equal(attempt.hasSent(), true)
  assert.deepEqual(
    attempt.acceptChunk({ type: 'chunk', attemptId: 'a1', revision: 5, index: 3, chunk: { type: 'text-delta', index: 0, text: 'later' } }),
    { kind: 'broken' },
    'the closed attempt stays closed for every later frame',
  )

  // View-level: a frame of an already-terminal turn never reaches the connection.
  {
    const view = promptView()
    await view.attach()
    const settled = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-terminal')
    view.access.turnFence = { openTurnStartSeq: 920, lastTurn: 5 }
    view.claim('m-terminal', 5, request.requestId)
    view.stream({ type: 'start', attemptId: 'P1:late', revision: 1, turn: 5, step: 1 })
    view.stream(streamFrame('P1:late', 2, 0, { type: 'text-delta', index: 0, text: 'partial' }))
    view.commit('assistant/message', assistantData(5, 'm-terminal-durable', [{ type: 'text', text: 'partial' }]))
    // Official turn terminal arrives with NO attempt `end` frame.
    view.commit('turn/end', { turn: 5, reason: { kind: 'completed' } })
    view.stream(streamFrame('P1:late', 3, 1, { type: 'text-delta', index: 0, text: ' LATE' }))
    await assert.rejects(settled, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
    await flushOutput()
    assert.equal(view.notifications.length, 1, 'only the pre-terminal delta was delivered')
    assert.equal(chunkOf(view.notifications[0]).text, 'partial')
  }
  {
    // The same terminal loss WITHOUT a committed message still settles the turn
    // and still never delivers the late frame.
    const view = promptView()
    await view.attach()
    const settled = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-terminal-silent')
    view.access.turnFence = { openTurnStartSeq: 930, lastTurn: 6 }
    view.claim('m-terminal-silent', 6, request.requestId)
    view.stream({ type: 'start', attemptId: 'P1:late2', revision: 1, turn: 6, step: 1 })
    view.stream(streamFrame('P1:late2', 2, 0, { type: 'text-delta', index: 0, text: 'kept' }))
    await flushOutput()
    // The attempt's `end` never arrived and no message committed, so the
    // delivered bytes have no durable owner: the completed terminal must fail
    // closed instead of reporting a success the client cannot reconcile.
    view.commit('turn/end', { turn: 6, reason: { kind: 'completed' } })
    view.stream(streamFrame('P1:late2', 3, 1, { type: 'text-delta', index: 0, text: ' LATE' }))
    await assert.rejects(settled, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
    await flushOutput()
    assert.equal(view.notifications.length, 1, 'the late frame was never delivered')
    assert.equal(chunkOf(view.notifications[0]).text, 'kept')
  }
})

test('G-ACP2-PR1 ST-04: an official retry poisons the flight and an unprovable later success never answers end_turn', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-retry-official')
  view.access.turnFence = { openTurnStartSeq: 970, lastTurn: 41 }
  view.claim('m-retry-official', 41, request.requestId)
  view.stream({ type: 'start', attemptId: 'P1:r1', revision: 1, turn: 41, step: 1 })
  view.stream(streamFrame('P1:r1', 2, 0, { type: 'text-delta', index: 0, text: 'retry' }))
  await flushOutput()
  assert.equal(view.notifications.length, 1)
  // The provider retried: attempt A commits an official `assistant/attempt`,
  // which owns NO durable message, so A's delivered bytes can never be joined.
  view.commit('assistant/attempt', { turn: 41, step: 1, attempt: 1, reason: { kind: 'retry' } })
  view.stream({
    type: 'end', attemptId: 'P1:r1', revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: view.lastSeq() },
  })
  // Attempt B streams nothing and commits its own message + matching end.
  view.stream({ type: 'start', attemptId: 'P1:r2', revision: 4, turn: 41, step: 1 })
  view.commit('assistant/message', assistantData(41, 'm-retry-final', [{ type: 'text', text: 'final' }]))
  view.stream({
    type: 'end', attemptId: 'P1:r2', revision: 5, index: 0,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
  })
  // The real terminal is the LAST fact: an implementation that accepted the
  // retried attempt would otherwise hang here instead of failing the test.
  view.commit('turn/end', { turn: 41, reason: { kind: 'completed' } })
  await assert.rejects(attempt, isPromptError('LOCAL_ACP_PROMPT_STREAM_DIVERGENCE'))
  await flushOutput()
  assert.equal(view.notifications.length, 1, 'the stale retried answer is never joined by a second delivery')
  assert.equal(chunkOf(view.notifications[0]).text, 'retry')
})

test('G-ACP2-PR1 ST-05: a slow output tail never misreports a legitimate adjacent attempt as a divergence', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-two-steps')
  view.access.turnFence = { openTurnStartSeq: 980, lastTurn: 42 }
  view.claim('m-two-steps', 42, request.requestId)
  // The first delta is held in the transport, so attempt A's reconciliation is
  // still queued when the SAME turn legally opens attempt B.
  const gate = view.deferredSend()
  view.stream({ type: 'start', attemptId: 'P1:s1', revision: 1, turn: 42, step: 1 })
  view.stream(streamFrame('P1:s1', 2, 0, { type: 'text-delta', index: 0, text: 'first' }))
  view.commit('assistant/message', assistantData(42, 'm-step-a', [{ type: 'text', text: 'first' }]))
  view.stream({
    type: 'end', attemptId: 'P1:s1', revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
  })
  view.stream({ type: 'start', attemptId: 'P1:s2', revision: 4, turn: 42, step: 1 })
  view.stream(streamFrame('P1:s2', 5, 0, { type: 'text-delta', index: 0, text: 'second' }))
  view.commit('assistant/message', assistantData(42, 'm-step-b', [{ type: 'text', text: 'second' }]))
  view.stream({
    type: 'end', attemptId: 'P1:s2', revision: 6, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
  })
  gate.release()
  await flushOutput()
  view.commit('turn/end', { turn: 42, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
  assert.deepEqual(view.notifications.map(update => chunkOf(update).text), ['first', 'second'],
    'each step owns its own reconciliation and nothing is duplicated or lost')
})

test('G-ACP2-PR1 ST-06: joined blocks already streamed never charge the pending-update budget', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-many-streamed')
  view.access.turnFence = { openTurnStartSeq: 990, lastTurn: 43 }
  view.claim('m-many-streamed', 43, request.requestId)
  const attemptId = 'P1:m1'
  view.stream({ type: 'start', attemptId, revision: 1, turn: 43, step: 1 })
  const blocks: Array<Record<string, unknown>> = []
  let revision = 2
  let index = 0
  for (let block = 0; block < 65; block += 1) {
    const text = `block-${String(block)}`
    view.stream(streamFrame(attemptId, revision, index, { type: 'block-start', index: block, blockType: 'text' }))
    revision += 1
    index += 1
    view.stream(streamFrame(attemptId, revision, index, { type: 'text-delta', index: block, text }))
    revision += 1
    index += 1
    view.stream(streamFrame(attemptId, revision, index, { type: 'block-end', index: block, block: { type: 'text', text } }))
    revision += 1
    index += 1
    await flushOutput()
    blocks.push({ type: 'text', text })
  }
  assert.equal(view.notifications.length, 65, 'every delta was delivered exactly once')
  // The durable message repeats those 65 blocks: the join sends nothing more,
  // so the message must not reserve or charge 65 pending updates.
  view.commit('assistant/message', assistantData(43, 'm-many-durable', blocks))
  view.stream({
    type: 'end', attemptId, revision, index,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
  })
  await flushOutput()
  assert.equal(view.notifications.length, 65, 'a fully streamed joined message adds nothing')
  view.commit('turn/end', { turn: 43, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 QU-04: two simultaneous continued commitments keep their own answers', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-two-timed')
  view.access.turnFence = { openTurnStartSeq: 1000, lastTurn: 60 }
  view.claim('m-two-timed', 60, request.requestId)
  // The SAME option labels in both questions: an answer crossing the other
  // obligation would still be schema-valid, so only the call identity can
  // prevent it.
  const qa: AcpQuestionSpec[] = [{ id: 'qa', question: 'A?', options: [{ label: 'yes' }, { label: 'no' }] }]
  const qb: AcpQuestionSpec[] = [{ id: 'qb', question: 'B?', options: [{ label: 'yes' }, { label: 'no' }] }]
  view.access.questionSnapshotImpl = () => ({
    kind: 'current',
    continued: [{ callId: 'call-A', questions: qa }, { callId: 'call-B', questions: qb }],
    settled: new Set(),
  })
  const submitted: Array<{ callId: string; answer: AcpQuestionAnswer }> = []
  view.access.answerContinuedImpl = (_sessionId, _agent, _session, callId, answer) => {
    submitted.push({ callId, answer })
    return { kind: 'queued' }
  }
  const timedOut = (label: string): Error => Object.assign(
    new Error(`ask_user_question timed out (${label})`),
    { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' },
  )
  const deadlineA = new AbortController()
  const askA = view.registry.onQuestionRequest(
    { agent: view.agent, questions: qa, signal: deadlineA.signal, wait: { callId: 'call-A', timed: true } },
    async () => ({ answers: [] }),
  )
  await flushOutput()
  const deadlineB = new AbortController()
  const askB = view.registry.onQuestionRequest(
    { agent: view.agent, questions: qb, signal: deadlineB.signal, wait: { callId: 'call-B', timed: true } },
    async () => ({ answers: [] }),
  )
  await flushOutput()
  assert.equal(channel.forms.length, 2, 'each timed question owns its own Form')
  deadlineA.abort(timedOut('A'))
  await assert.rejects(askA, (error: unknown) => (error as { code?: string }).code === 'ASK_TIMED_OUT')
  deadlineB.abort(timedOut('B'))
  await assert.rejects(askB, (error: unknown) => (error as { code?: string }).code === 'ASK_TIMED_OUT')
  assert.equal(channel.forms[0]!.signal.aborted, false, 'the first obligation is not revoked by the second deadline')
  assert.equal(channel.forms[1]!.signal.aborted, false)
  // Answer the FIRST (older) question while the newer obligation is still open:
  // its answer may never be re-read through the newer call's form.
  channel.forms[0]!.respond({ action: 'accept', content: { q0: 'yes' } })
  await flushOutput()
  channel.forms[1]!.respond({ action: 'accept', content: { q0: 'no' } })
  await flushOutput()
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.deepEqual(submitted, [
    { callId: 'call-A', answer: { answers: [{ id: 'qa', selected: ['yes'] }] } },
    { callId: 'call-B', answer: { answers: [{ id: 'qb', selected: ['no'] }] } },
  ], 'no answer may ever become another call answer')
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.equal(submitted.length, 2, 'each obligation submits exactly once')
  view.commit('turn/end', { turn: 60, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

test('G-ACP2-PR1 QU-05: a View that lost ownership never writes a continued answer into the shared Session', async () => {
  const qa: AcpQuestionSpec[] = [{ id: 'qa', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] }]
  {
    // A late continued answer crosses a real await: the response resolves, then
    // the physical connection is released before the continuation runs.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    await view.attach()
    const attempt = view.start()
    const request = view.access.promptCalls[0]!
    view.insert(request.requestId, 'm-release-race')
    view.access.turnFence = { openTurnStartSeq: 1010, lastTurn: 61 }
    view.claim('m-release-race', 61, request.requestId)
    view.access.questionSnapshotImpl = () => continuedQuestions(qa, 'call-release')
    const deadline = new AbortController()
    const ask = view.registry.onQuestionRequest(
      { agent: view.agent, questions: qa, signal: deadline.signal, wait: { callId: 'call-release', timed: true } },
      async () => ({ answers: [] }),
    )
    await flushOutput()
    deadline.abort(Object.assign(new Error('timeout'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }))
    await assert.rejects(ask)
    channel.forms[0]!.respond({ action: 'accept', content: { q0: 'a1' } })
    view.registry.releaseConnection(view.conn, view.access)
    await flushOutput()
    assert.equal(view.access.answerContinuedCalls.length, 0,
      'a released View never injects its late answer into the shared Session')
    // The disconnect cancellation owns the flight's settlement (a fake Host
    // cancellation may stay pending); the observation is the absent write.
    attempt.catch(() => {})
  }
  {
    // A resumed offer: the client answers, then the connection is released
    // before the offer chain submits.
    const channel = formChannel()
    const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    view.access.questionSnapshotImpl = () => continuedQuestions(qa, 'call-resumed')
    await view.attach()
    await flushOutput()
    assert.equal(channel.forms.length, 1, 'the resumed connection offers the continued question')
    channel.forms[0]!.respond({ action: 'accept', content: { q0: 'a1' } })
    view.registry.releaseConnection(view.conn, view.access)
    await flushOutput()
    assert.equal(view.access.answerContinuedCalls.length, 0,
      'a released offer never writes a new user message into the shared Session')
  }
})

test('G-ACP2-PR1 ST-07: a reconciliation that sends nothing never charges the pending-update budget', async () => {
  const view = promptView()
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-budget-join')
  view.access.turnFence = { openTurnStartSeq: 995, lastTurn: 44 }
  view.claim('m-budget-join', 44, request.requestId)
  // Hold the tail so every later task is still PENDING (its reservation is
  // charged, not yet drained).
  const gate = view.deferredSend()
  const attemptId = 'P1:budget'
  view.stream({ type: 'start', attemptId, revision: 1, turn: 44, step: 1 })
  view.stream(streamFrame(attemptId, 2, 0, { type: 'text-delta', index: 0, text: 'streamed' }))
  // 63 further REAL pending updates fill the budget exactly to its 64 ceiling.
  for (let call = 0; call < 63; call += 1) {
    view.commit('tool/call', { turn: 44, callId: `call-${String(call)}`, name: 'probe', input: {} })
  }
  // The durable message of the fully streamed attempt sends NOTHING more: its
  // reconciliation must fit at exactly 64 pending updates, not force 65.
  view.commit('assistant/message', assistantData(44, 'm-budget-durable', [{ type: 'text', text: 'streamed' }]))
  view.stream({
    type: 'end', attemptId, revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: view.lastSeq() },
  })
  await flushOutput()
  gate.release()
  await flushOutput()
  view.commit('turn/end', { turn: 44, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' },
    'a zero-send reconciliation never makes a legal queue overflow')
  assert.equal(view.notifications.filter(update => updateKind(update) === 'agent_message_chunk').length, 1,
    'the streamed text stays delivered exactly once')
})

/** Read one claim's question resources. The leak this guards is the RESOURCE
 * (a dead obligation and its Form handle), not any private field's shape. */
function registryClaim(view: ReturnType<typeof promptView>, sessionId: string): {
  continuedQuestions?: Map<string, unknown>
  questionForms?: Set<unknown>
} {
  const registry = view.registry as unknown as {
    claims: Map<string, { continuedQuestions?: Map<string, unknown>; questionForms?: Set<unknown> }>
  }
  const claim = registry.claims.get(sessionId)
  assert.ok(claim !== undefined, 'the View holds its claim')
  return claim
}

test('G-ACP2-PR1 QU-06: another owner settling a continued call reclaims the exact obligation and its Form', async () => {
  const channel = formChannel()
  const view = promptView('P1', { channels: { requestElicitation: channel.requester } })
  view.access.questionService = true
  await view.attach()
  const attempt = view.start()
  const request = view.access.promptCalls[0]!
  view.insert(request.requestId, 'm-other-settled')
  view.access.turnFence = { openTurnStartSeq: 1050, lastTurn: 70 }
  view.claim('m-other-settled', 70, request.requestId)
  const qa: AcpQuestionSpec[] = [{ id: 'qa', question: 'A?', options: [{ label: 'yes' }, { label: 'no' }] }]
  // The projection has not recorded the call yet: the Form stays open.
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued: [], settled: new Set() })
  const deadline = new AbortController()
  const ask = view.registry.onQuestionRequest(
    { agent: view.agent, questions: qa, signal: deadline.signal, wait: { callId: 'call-other', timed: true } },
    async () => ({ answers: [] }),
  )
  await flushOutput()
  deadline.abort(Object.assign(new Error('timeout'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }))
  await assert.rejects(ask)
  const claim = registryClaim(view, 'P1')
  assert.equal(claim.continuedQuestions?.size, 1, 'the timed question owns one obligation')
  assert.equal(claim.questionForms?.size, 1)
  // ANOTHER owner answers it: the official projection moves the call to settled.
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued: [], settled: new Set(['call-other']) })
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  await flushOutput()
  assert.equal(channel.forms[0]!.signal.aborted, true, 'the stale Form is stopped')
  assert.equal(claim.continuedQuestions?.size, 0, 'the dead obligation is reclaimed, not accumulated')
  assert.equal(claim.questionForms?.size, 0, 'its Form handle is reclaimed with it')
  assert.equal(view.access.answerContinuedCalls.length, 0,
    'nothing is written for a call another owner already settled')
  // A later projection change is a bounded no-op: no second abort, no re-add.
  view.registry.onQuestionProjection(view.agent.session, 'userQuestions')
  view.registry.onQuestionProjection(view.agent.session, 'inbox')
  await flushOutput()
  assert.equal(claim.continuedQuestions?.size, 0)
  assert.equal(claim.questionForms?.size, 0)
  view.commit('turn/end', { turn: 70, reason: { kind: 'completed' } })
  assert.deepEqual(await attempt, { stopReason: 'end_turn' })
})

// ─────────────────────────── G-ACP2-PR2: list/load projections ───────────────

/** Every optional read-only capability negotiated (the "capable client"). */
const PR2_CAPABILITIES: AcpNegotiatedCapabilities = {
  plan: true,
  compaction: true,
  subagents: true,
  notices: true,
  booleanConfigOptions: true,
}

/** A connection that negotiated none of the optional read-only capabilities. */
const PR2_BASELINE: AcpNegotiatedCapabilities = {
  plan: false,
  compaction: false,
  subagents: false,
  notices: false,
  booleanConfigOptions: false,
}

/** Bounded condition wait on a REAL fact (never a fixed sleep as evidence). */
async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

/**
 * One View harness for the load/replay and read-only projection contracts.
 * The projection sink records every standard update of the exact Session and
 * can be held to model a slow drain.
 */
function projectionView(
  sessionId = 'L1',
  options: {
    readonly capabilities?: AcpNegotiatedCapabilities
    readonly history?: AcpSessionHistory
    readonly mcpServers?: readonly unknown[]
    readonly channels?: Partial<AcpViewChannels>
  } = {},
): {
  access: FakeAccess
  agent: AgentLike
  registry: AcpSessionViewRegistry
  conn: ReturnType<AcpSessionViewRegistry['createConnection']>
  notifications: SessionUpdate[]
  catalogNotifications: SessionUpdate[]
  load: () => Promise<Record<string, never>>
  resume: () => Promise<Record<string, never>>
  holdProjection: () => { readonly entered: Promise<void>; readonly release: () => void }
  failProjection: (times: number) => Promise<void>
  commit: (type: string, data: Record<string, unknown>, time?: number) => void
  nextSeq: () => number
  lastSeq: () => number
} {
  const access = new FakeAccess()
  access.sessionReadReady = true
  const agent = makeAgent(sessionId, '/w')
  access.seed(agent)
  access.sessionHistory = options.history ?? { header: { sessionId, cwd: '/w' }, events: [] }
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const notifications: SessionUpdate[] = []
  const catalogNotifications: SessionUpdate[] = []
  let gate: Promise<void> | undefined
  let entered: (() => void) | undefined
  let failures = 0
  let failureDrain: (() => void) | undefined
  const channels: AcpViewChannels = {
    capabilities: options.capabilities ?? PR2_CAPABILITIES,
    ...(options.channels ?? {}),
    notifyProjection: async (_sessionId, update) => {
      if (gate !== undefined) {
        entered?.()
        entered = undefined
        await gate
      }
      if (failures > 0) {
        failures -= 1
        if (failures === 0) {
          failureDrain?.()
          failureDrain = undefined
        }
        throw new Error('projection sink failed')
      }
      // Catalog delivery is the one baseline notification every attached View
      // now receives. Keep it out of the historical PR2 lists (which assert
      // plan/usage/compaction payloads) while a dedicated catalog assertion
      // still observes the real wire row and its ordering.
      if (update.sessionUpdate === 'available_commands_update') catalogNotifications.push(update)
      else notifications.push(update)
    },
  }
  let seq = 100
  return {
    access,
    agent,
    registry,
    conn,
    notifications,
    catalogNotifications,
    load: async () => await registry.loadSession(
      conn,
      access,
      { sessionId, cwd: '/w', mcpServers: [...(options.mcpServers ?? [])] },
      channels,
    ),
    resume: async () => await registry.resumeSession(conn, access, { sessionId, cwd: '/w' }, channels),
    holdProjection: () => {
      const held = Promise.withResolvers<void>()
      const blocked = Promise.withResolvers<void>()
      gate = held.promise
      entered = blocked.resolve
      return {
        entered: blocked.promise,
        release: () => {
          gate = undefined
          held.resolve()
        },
      }
    },
    failProjection: (times: number) => {
      failures = times
      const settled = Promise.withResolvers<void>()
      failureDrain = settled.resolve
      return settled.promise
    },
    commit: (type: string, data: Record<string, unknown>, time?: number) => {
      seq += 1
      registry.onSessionEvent(agent.session, { seq, type, data, ...(time === undefined ? {} : { time }) })
    },
    nextSeq: () => seq + 1,
    lastSeq: () => seq,
  }
}

test('G-ACP2-PR2 LOAD-01: session/load replays the complete canonical history in order before answering', async () => {
  const history: AcpSessionHistory = {
    header: { sessionId: 'L1', cwd: '/w' },
    events: [
      { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'how do I run it?' }], role: 'user' } },
      { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'with make' }] } } },
      { seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"make"}' } },
      {
        seq: 3,
        type: 'tool/result',
        data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }, { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] } },
      },
      { seq: 4, type: 'todo/write', data: { todos: [{ content: 'run make', status: 'completed' }] } },
    ],
  }
  const view = projectionView('L1', { history })
  view.access.storedImages.set('img-1', { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' })

  await view.load()

  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), [
    'user_message_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan_update',
  ])
  assert.deepEqual(view.notifications[0], {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u1',
    content: { type: 'text', text: 'how do I run it?' },
  })
  const toolUpdate = view.notifications[3] as { content?: readonly { type: string; content?: { type: string; data?: string } }[] }
  assert.equal(toolUpdate.content?.length, 2)
  assert.equal(toolUpdate.content?.[1]?.content?.type, 'image')
  assert.equal(toolUpdate.content?.[1]?.content?.data, Buffer.from(Uint8Array.of(1, 2, 3)).toString('base64'),
    'the history image carries the verified Store bytes')
  assert.deepEqual(view.notifications[4], {
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: 'dsh-todos:L1', entries: [{ content: 'run make', status: 'completed', priority: 'medium' }] },
  })
  assert.equal(view.registry.claimCount(), 1, 'the loaded Session keeps its one View')
})

test('G-ACP2-PR2 LOAD-02: live events during the snapshot join exactly once, ordered after the replayed seq', async () => {
  const view = projectionView('L1')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  // A live event the snapshot already contains (seq 0) and a new one (seq 1)
  // arrive while the canonical read is in flight.
  view.registry.onSessionEvent(view.agent.session, { seq: 0, type: 'todo/write', data: { todos: [{ content: 'duplicate', status: 'pending' }] } })
  view.registry.onSessionEvent(view.agent.session, { seq: 1, type: 'todo/write', data: { todos: [{ content: 'live', status: 'pending' }] } })
  readRelease.resolve({
    header: { sessionId: 'L1', cwd: '/w' },
    events: [{ seq: 0, type: 'todo/write', data: { todos: [{ content: 'snapshot', status: 'pending' }] } }],
  })
  await loading
  const planContents = view.notifications.map(update =>
    (update as { plan?: { entries?: readonly { content?: string }[] } }).plan?.entries?.[0]?.content)
  assert.deepEqual(planContents, ['snapshot', 'live'],
    'the duplicated seq 0 is dropped and the newer seq 1 is replayed once, after the snapshot')
})

test('G-ACP2-PR2 LOAD-01 negative: session/resume NEVER replays history', async () => {
  const view = projectionView('R1', {
    history: {
      header: { sessionId: 'R1', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'old', source: { kind: 'user' }, content: [{ type: 'text', text: 'past' }], role: 'user' } }],
    },
  })
  await view.resume()
  assert.deepEqual(view.notifications, [], 'resume attaches without replaying a single historical update')
  assert.equal(view.access.historyCalls.length, 0, 'resume never reads canonical history')
})

test('G-ACP2-PR2 LOAD-05: unrepresentable history, a broken seq order or an unreadable image fail closed and release only this View', async () => {
  for (const [events, code, stored] of [
    [
      [
        { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: 'f1', name: 'a.txt', bytes: 1 } }], role: 'user' } },
      ],
      'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT',
      false,
    ],
    [
      [
        { seq: 2, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }], role: 'user' } },
        { seq: 2, type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'b' }], role: 'user' } },
      ],
      'LOCAL_ACP_LOAD_INVALID_HISTORY',
      false,
    ],
    [
      [
        { seq: 0, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'image', attachment: { attachmentId: 'missing', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] } } },
      ],
      'LOCAL_ACP_LOAD_ATTACHMENT_READ_FAILED',
      true,
    ],
  ] as const) {
    const view = projectionView('F1', { history: { header: { sessionId: 'F1', cwd: '/w' }, events: [...events] } })
    if (stored) view.access.imageReadImpl = async () => { throw new Error('missing object') }
    await assert.rejects(view.load(), isPromptError(code))
    assert.equal(view.registry.claimCount(), 0, `${code}: the failed load releases its own claim`)
    assert.equal(view.registry.phaseOf(view.conn), 'idle', `${code}: the connection is free for a later attach`)
    assert.deepEqual(view.notifications, [], `${code}: no partial history is reported as a complete load`)
  }
})

test('G-ACP2-PR2 LOAD-02 negative: a close during the replay read delivers no history and refuses the load', async () => {
  const view = projectionView('C1')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  await view.registry.closeSession(view.conn, view.access, 'C1')
  readRelease.resolve({
    header: { sessionId: 'C1', cwd: '/w' },
    events: [{ seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'secret' }], role: 'user' } }],
  })
  await assert.rejects(loading, isPromptError('LOCAL_ACP_VIEW_CLOSED'))
  assert.deepEqual(view.notifications, [], 'a closed View never receives the history it was reading')
  assert.equal(view.registry.claimCount(), 0)
})

test('G-ACP2-PR2 LOAD-02 negative: an over-budget live window fails the load with the replay backpressure class', async () => {
  const view = projectionView('B1')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  for (let index = 0; index < 1025; index += 1) {
    view.registry.onSessionEvent(view.agent.session, { seq: index + 1, type: 'turn/start', data: { turn: index } })
  }
  readRelease.resolve({ header: { sessionId: 'B1', cwd: '/w' }, events: [] })
  await assert.rejects(loading, isPromptError('LOCAL_ACP_LOAD_BACKPRESSURE'))
  assert.deepEqual(view.notifications, [])
  assert.equal(view.registry.claimCount(), 0, 'the over-budget replay releases only its own View')
})

test('G-ACP2-PR2 LOAD-04: a prompt is refused as VIEW_BUSY while the load replay is still open', async () => {
  const view = projectionView('P2')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  await assert.rejects(
    view.registry.promptSession(view.conn, view.access, { sessionId: 'P2', prompt: [{ type: 'text', text: 'new' }] }, new AbortController().signal, false, async () => {}),
    isPromptError('LOCAL_ACP_VIEW_BUSY'),
  )
  readRelease.resolve({ header: { sessionId: 'P2', cwd: '/w' }, events: [] })
  await loading
  assert.equal(view.access.promptCalls.length, 0, 'no prompt is dispatched into a replaying View')
})

test('G-ACP2-PR2 META-01/PLAN-01/USAGE-01: live read-only projections are capability-gated and official-sourced', async () => {
  const capable = projectionView('M1')
  await capable.resume()
  capable.access.pressureValue = { projectedTokens: 42, pressureTokens: 40, contextWindow: 200 }
  capable.access.todosValue = null
  capable.notifications.length = 0
  // A baseline `plan` for a client without the negotiated capability.
  const baseline = projectionView('M2', { capabilities: PR2_BASELINE })
  await baseline.resume()
  baseline.notifications.length = 0
  baseline.commit('todo/write', { todos: [{ content: 'step', status: 'in_progress' }] })
  await waitUntil(() => baseline.notifications.length === 1, 'the baseline plan replaces the list')
  assert.deepEqual(baseline.notifications, [{
    sessionUpdate: 'plan',
    entries: [{ content: 'step', status: 'in_progress', priority: 'medium' }],
  }])

  capable.commit('todo/write', { todos: [{ content: 'step', status: 'in_progress' }] })
  capable.commit('todo/write', { todos: [] })
  capable.commit('assistant/message', {
    turn: 1,
    step: 1,
    usage: { inputTokens: 10, outputTokens: 2 },
    message: { id: 'a1', content: [{ type: 'text', text: 'done' }] },
  })
  capable.commit('session/title', { title: 'A real title', messageSeqs: [], source: 'user' })
  capable.commit('compaction/start', { compactionId: 'cp1', turn: null })
  capable.commit('compaction/end', { compactionId: 'cp1', turn: null })
  capable.registry.onSubagentStart({ runId: 'run1', id: 'CHILD', parentSessionId: 'M1', local: true })
  capable.access.headerFacts = { sessionId: 'CHILD', parentSessionId: 'M1', origin: 'subagent', cwd: '/w/child' }
  await waitUntil(() => capable.notifications.length >= 7, 'the live read-only projections are delivered')

  assert.deepEqual(capable.notifications.slice(0, 6), [
    {
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'dsh-todos:M1', entries: [{ content: 'step', status: 'in_progress', priority: 'medium' }] },
    },
    { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'dsh-todos:M1', entries: [] } },
    { sessionUpdate: 'usage_update', used: 42, size: 200 },
    { sessionUpdate: 'session_info_update', title: 'A real title' },
    { sessionUpdate: 'compaction_update', compactionId: 'cp1', status: 'in_progress' },
    { sessionUpdate: 'compaction_update', compactionId: 'cp1', status: 'completed' },
  ])
  const subagent = capable.notifications[6] as { sessionUpdate: string; sessionId: string; capabilities?: unknown; state?: unknown; cwd?: string }
  assert.equal(subagent.sessionUpdate, 'subagent_update')
  assert.equal(subagent.sessionId, 'CHILD')
  assert.deepEqual(subagent.state, { state: 'running' })
  assert.equal(subagent.cwd, '/w/child')
  assert.equal(subagent.capabilities, undefined, 'no child mutation capability is ever announced')
})

test('G-ACP2-PR2 USAGE-01 negative: no provider sample or no capacity means NO usage update (never a fabricated 0)', async () => {
  const view = projectionView('U1')
  await view.resume()
  view.notifications.length = 0
  view.access.pressureValue = { projectedTokens: 42 }
  view.commit('assistant/message', { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'x' }] } })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(view.notifications, [], 'a message without provider usage produces no occupancy update')
  view.access.pressureValue = { projectedTokens: 42, contextWindow: 200 }
  view.commit('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 }, message: { id: 'a2', content: [{ type: 'text', text: 'y' }] } })
  await waitUntil(() => view.notifications.length === 1, 'the real occupancy update is delivered')
  assert.deepEqual(view.notifications, [{ sessionUpdate: 'usage_update', used: 42, size: 200 }])
})

test('G-ACP2-PR2 COMPACT-01/SUB-01/MESSAGE-01 negatives: an unnegotiated client receives no supplemental frame', async () => {
  const view = projectionView('N1', { capabilities: PR2_BASELINE })
  await view.resume()
  view.notifications.length = 0
  view.access.pressureValue = { projectedTokens: 1, contextWindow: 10 }
  view.access.headerFacts = { sessionId: 'CHILD', parentSessionId: 'N1', origin: 'subagent', cwd: '/w' }
  view.commit('compaction/start', { compactionId: 'cp1', turn: null })
  view.commit('compaction/end', { compactionId: 'cp1', turn: null })
  view.commit('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 }, message: { id: 'a1', content: [{ type: 'text', text: 'x' }] } })
  view.commit('user/message', { id: 'am1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'S2' }, content: [{ type: 'text', text: 'hi' }], role: 'user' })
  view.registry.onSubagentStart({ runId: 'r1', id: 'CHILD', parentSessionId: 'N1', local: true })
  await waitUntil(() => view.notifications.length >= 1, 'the baseline usage update is delivered')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(view.notifications, [{ sessionUpdate: 'usage_update', used: 1, size: 10 }],
    'compaction, session_message and subagent updates require their negotiated capability')
})

test('G-ACP2-PR2 COMPACT-02: a failed compaction notification does not consume the lifecycle transition', async () => {
  const view = projectionView('C4')
  await view.resume()
  view.notifications.length = 0
  const failed = view.failProjection(1)
  view.commit('compaction/start', { compactionId: 'cp-retry', turn: null })
  await failed
  // The SAME official start is not a duplicate when the first attempt never
  // reached the client: the state is recorded only after a successful send.
  view.commit('compaction/start', { compactionId: 'cp-retry', turn: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.notifications.map(update => (update as { status?: string }).status), ['in_progress'])
})

test('G-ACP2-PR2 META-02: a failed title notification does not suppress the same durable title', async () => {
  const view = projectionView('M3')
  await view.resume()
  view.notifications.length = 0
  const failed = view.failProjection(1)
  view.commit('session/title', { title: 'Retry title', messageSeqs: [], source: 'user' })
  await failed
  view.commit('session/title', { title: 'Retry title', messageSeqs: [], source: 'user' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.notifications.map(update => (update as { title?: string }).title), ['Retry title'])
})

test('G-ACP2-PR2 LOAD-09: a close during a history Store read is a cancellation, not a corrupt attachment', async () => {
  const view = projectionView('LD9', {
    history: {
      header: { sessionId: 'LD9', cwd: '/w' },
      events: [{
        seq: 0, type: 'tool/result',
        data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'image', attachment: { attachmentId: 'img-held', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] } },
      }],
    },
  })
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<void>()
  view.access.imageReadImpl = async () => {
    readStarted.resolve()
    await readRelease.promise
    throw new Error('store read aborted')
  }
  const loading = view.load()
  await readStarted.promise
  await view.registry.closeSession(view.conn, view.access, 'LD9')
  readRelease.resolve()
  await assert.rejects(loading, isViewError('LOCAL_ACP_VIEW_CLOSED'),
    'the abort class wins over the attachment error')
})

test('G-ACP2-PR2 LOAD-13: a subagent-edge overflow aborts the waiting read and fails the load with BACKPRESSURE', async () => {
  const view = projectionView('LD15', {
    history: {
      header: { sessionId: 'LD15', cwd: '/w' },
      events: [{
        seq: 0,
        type: 'user/message',
        data: {
          id: 'am1',
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'COLD' },
          role: 'user',
          content: [{ type: 'text', text: 'from a cold child' }],
        },
      }],
    },
  })
  const entered = Promise.withResolvers<void>()
  let readSignal: AbortSignal | undefined
  view.access.headerFactsImpl = async (_sessionId, signal) => {
    readSignal = signal
    entered.resolve()
    await new Promise<void>(resolve => {
      if (signal?.aborted === true) { resolve(); return }
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return undefined
  }
  const loading = view.load()
  await entered.promise
  // Fill the OTHER replay buffer (official subagent lifecycle edges) past its
  // cap: MAX_REPLAY_BUFFERED_EVENTS is 1024.
  for (let index = 0; index <= 1024; index += 1) {
    view.registry.onSubagentStart({
      runId: `run-${String(index)}`, id: `child-${String(index)}`, parentSessionId: 'LD15', local: true,
    })
  }
  assert.equal(readSignal?.aborted, true, 'the edge overflow aborts the waiting read')
  await assert.rejects(loading, isViewError('LOCAL_ACP_LOAD_BACKPRESSURE'),
    'the load reports backpressure, not a plain cancellation')
  assert.equal(view.registry.hasClaim('LD15'), false, 'the failed load releases only this View')
})

test('G-ACP2-PR2 LIVE-01: a live close aborts an in-flight cold header read without publishing a late frame', async () => {
  const view = projectionView('L15')
  await view.resume()
  view.notifications.length = 0
  const entered = Promise.withResolvers<void>()
  let readSignal: AbortSignal | undefined
  view.access.headerFactsImpl = async (_sessionId, signal) => {
    readSignal = signal
    entered.resolve()
    // Settles ONLY through the claim's cancellation owner: no manual release.
    await new Promise<void>(resolve => {
      if (signal?.aborted === true) { resolve(); return }
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return undefined
  }
  view.commit('user/message', {
    id: 'am-live',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'COLD-CHILD' },
    role: 'user',
    content: [{ type: 'text', text: 'from a cold child' }],
  })
  await entered.promise
  await view.registry.closeSession(view.conn, view.access, 'L15')
  assert.equal(readSignal?.aborted, true, 'close aborts the live cold header read')
  await flushOutput()
  assert.equal(view.notifications.some(update => update.sessionUpdate === 'session_message'), false,
    'no late frame from the cancelled live projection')
})

test('G-ACP2-PR2 LIVE-02: a live close aborts an in-flight attachment Store read', async () => {
  const view = projectionView('L16')
  await view.resume()
  view.notifications.length = 0
  view.access.headerFacts = { sessionId: 'CHILD', origin: 'subagent', parentSessionId: 'L16', cwd: '/w' }
  const entered = Promise.withResolvers<void>()
  let readSignal: AbortSignal | undefined
  view.access.imageReadImpl = async (_ref, signal) => {
    readSignal = signal
    entered.resolve()
    await new Promise<void>(resolve => {
      if (signal?.aborted === true) { resolve(); return }
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new Error('store read aborted')
  }
  view.commit('user/message', {
    id: 'am-live-image',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'CHILD' },
    role: 'user',
    content: [
      { type: 'text', text: 'with an image' },
      { type: 'image', attachment: { attachmentId: 'img-live', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
    ],
  })
  await entered.promise
  await view.registry.closeSession(view.conn, view.access, 'L16')
  assert.equal(readSignal?.aborted, true, 'close aborts the live Store read')
  await flushOutput()
  assert.equal(view.notifications.some(update => update.sessionUpdate === 'session_message'), false,
    'the aborted read never publishes a partial message')
})

test('G-ACP2-PR2 LOAD-12: load offers the official continued question after its history drained', async () => {
  const channel = formChannel()
  const view = projectionView('LD12', {
    channels: { requestElicitation: channel.requester },
    history: {
      header: { sessionId: 'LD12', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }], role: 'user' } }],
    },
  })
  view.access.questionService = true
  const continued = [{ callId: 'call-first', questions: [{ id: 'q0', question: 'first?', options: [{ label: 'yes' }] }] }]
  view.access.questionSnapshotImpl = () => ({ kind: 'current', continued, settled: new Set() })
  const answered: string[] = []
  view.access.answerContinuedImpl = (_sessionId, _agent, _session, callId) => {
    answered.push(callId)
    return { kind: 'queued' }
  }
  const hold = view.holdProjection()
  const loading = view.load()
  // The canonical history is still blocked at the sink: the reverse Form must
  // not exist yet.
  await hold.entered
  assert.equal(channel.forms.length, 0, 'the continued Form waits for the drained history')
  hold.release()
  await loading
  await flushOutput()
  assert.equal(channel.forms.length, 1, 'load offers the pending continued question exactly once')
  assert.equal(channel.forms[0]!.request.toolCallId, 'call-first')
  assert.equal(view.notifications.at(0)?.sessionUpdate, 'user_message_chunk',
    'the canonical history is delivered before the reverse Form')
  channel.forms[0]!.respond({ action: 'accept', content: { q0: 'yes' } })
  await flushOutput()
  assert.deepEqual(answered, ['call-first'], 'the answer returns to the official owner')
})

test('G-ACP2-PR2 LOAD-12 negative: a load without continued questions or Form capability offers nothing', async () => {
  {
    const channel = formChannel()
    const view = projectionView('LD13', { channels: { requestElicitation: channel.requester } })
    view.access.questionService = true
    view.access.questionSnapshotImpl = () => ({ kind: 'current', continued: [], settled: new Set() })
    await view.load()
    await flushOutput()
    assert.equal(channel.forms.length, 0, 'no pending question means no Form')
  }
  {
    let snapshots = 0
    // No `requestElicitation`: the client did not declare the Form capability.
    const view = projectionView('LD14')
    view.access.questionService = true
    view.access.questionSnapshotImpl = () => {
      snapshots += 1
      return { kind: 'current', continued: [{ callId: 'call-x', questions: [{ id: 'q', question: 'x?', options: [{ label: 'yes' }] }] }], settled: new Set() }
    }
    await view.load()
    await flushOutput()
    assert.equal(snapshots, 0, 'a client without the Form capability never asks for continued questions')
  }
})

test('G-ACP2-PR2 LOAD-10: a title committed during the replay keeps its official durable time', async () => {
  const view = projectionView('LD10', {
    history: {
      header: { sessionId: 'LD10', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }], role: 'user' } }],
    },
  })
  const hold = view.holdProjection()
  const loading = view.load()
  await hold.entered
  // The official durable event carries its own time; the buffered window must
  // keep it so the replay projects the same `updatedAt` the live path would.
  view.commit('session/title', { title: 'Committed mid-replay', messageSeqs: [], source: 'user' }, 1_750_000_000_000)
  hold.release()
  await loading
  const info = view.notifications.find(update => update.sessionUpdate === 'session_info_update')
  assert.equal((info as { title?: string } | undefined)?.title, 'Committed mid-replay')
  assert.equal((info as { updatedAt?: string } | undefined)?.updatedAt,
    new Date(1_750_000_000_000).toISOString(),
    'the replayed title carries the event time, never a fabricated one')
})

test('G-ACP2-PR2 LOAD-11: a close aborts an in-flight cold header read instead of waiting for it', async () => {
  const view = projectionView('LD11', {
    history: {
      header: { sessionId: 'LD11', cwd: '/w' },
      events: [{
        seq: 0,
        type: 'user/message',
        data: {
          id: 'am1',
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'CHILD' },
          role: 'user',
          content: [{ type: 'text', text: 'from the child' }],
        },
      }],
    },
  })
  const entered = Promise.withResolvers<void>()
  const releaseRead = Promise.withResolvers<void>()
  view.access.headerFactsImpl = async () => {
    entered.resolve()
    await releaseRead.promise
    return undefined
  }
  const loading = view.load()
  await entered.promise
  const signal = view.access.headerFactsSignals[0]
  assert(signal !== undefined, 'the header read receives a cancellation signal')
  await view.registry.closeSession(view.conn, view.access, 'LD11')
  assert.equal(signal?.aborted, true, 'close aborts the waiting official header read')
  releaseRead.resolve()
  await assert.rejects(loading, isViewError('LOCAL_ACP_VIEW_CLOSED'))
  assert.equal(view.notifications.some(update => update.sessionUpdate === 'session_message'), false,
    'no late session_message from the cancelled replay')
})

test('G-ACP2-PR2 MESSAGE-01: a verified child message is announced by its association first, while the runtime settlement notice never is', async () => {
  const view = projectionView('A1')
  await view.resume()
  view.notifications.length = 0
  // The sender's OFFICIAL header proves it is a subagent child of this Session.
  view.access.headerFacts = { sessionId: 'SENDER', origin: 'subagent', parentSessionId: 'A1', cwd: '/w' }
  // A durable `user/message` event's data IS the message object.
  view.commit('user/message', {
    id: 'am1',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' },
    content: [{ type: 'text', text: 'the child says hi' }],
    role: 'user',
  })
  view.commit('user/message', {
    id: 'settled1',
    source: { kind: 'subagent-settled', form: 'notice', summary: 'child finished', senderSessionId: 'CHILD' },
    content: [{ type: 'text', text: 'runtime account' }],
    role: 'user',
  })
  await waitUntil(() => view.notifications.length >= 2, 'the association and the agent message are projected')
  await new Promise(resolve => setTimeout(resolve, 10))
  // Stable v1: `subagent_update` announces the child BEFORE its traffic, and it
  // never invents an activity snapshot the Host did not report.
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'subagent_update', sessionId: 'SENDER', cwd: '/w' },
    {
      sessionUpdate: 'session_message',
      messageId: 'am1',
      senderSessionId: 'SENDER',
      recipientSessionId: 'A1',
      content: [{ type: 'text', text: 'the child says hi' }],
    },
  ])
  // A second message from the SAME child never re-announces it.
  view.commit('user/message', {
    id: 'am2',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' },
    content: [{ type: 'text', text: 'and again' }],
    role: 'user',
  })
  await waitUntil(() => view.notifications.length >= 3, 'the second agent message is projected')
  assert.deepEqual(view.notifications.slice(2).map(update => update.sessionUpdate), ['session_message'])
})

test('G-ACP2-PR2 MESSAGE-01 negative: an unprovable author never fabricates a session_message or a child association', async () => {
  const view = projectionView('A3')
  await view.resume()
  view.notifications.length = 0
  // No official header at all: a forged sender cannot be proven to be a child.
  view.access.headerFacts = undefined
  view.commit('user/message', {
    id: 'am9',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'FORGED' },
    content: [{ type: 'text', text: 'from nowhere' }],
    role: 'user',
  })
  // A real Session that is neither this Session's child nor its parent.
  view.access.headerFacts = { sessionId: 'STRANGER', cwd: '/w' }
  view.commit('user/message', {
    id: 'am10',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'STRANGER' },
    content: [{ type: 'text', text: 'from a sibling' }],
    role: 'user',
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(view.notifications, [], 'an unproven author projects nothing')
})

test('G-ACP2-PR2 MESSAGE-02: a child Session receives its verified parent author without inventing a child association', async () => {
  const view = projectionView('CHILD1')
  await view.resume()
  view.notifications.length = 0
  // This View's Session is itself a subagent child of PARENT; the author is the
  // parent, which is a real Session but never an announced child.
  view.access.headerFactsImpl = async sessionId => {
    if (sessionId === 'CHILD1') return { sessionId: 'CHILD1', origin: 'subagent', parentSessionId: 'PARENT' }
    if (sessionId === 'PARENT') return { sessionId: 'PARENT', cwd: '/w' }
    return undefined
  }
  view.commit('user/message', {
    id: 'am20',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'PARENT' },
    content: [{ type: 'text', text: 'instructions from the parent' }],
    role: 'user',
  })
  await waitUntil(() => view.notifications.length >= 1, 'the parent message is projected')
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['session_message'])
})

test('G-ACP2-PR2 SUB-01 negative: an ordinary fork (parentSession without origin=subagent) never announces a child', async () => {
  const view = projectionView('F2')
  await view.resume()
  view.notifications.length = 0
  view.access.headerFacts = { sessionId: 'FORK', parentSessionId: 'F2' }
  view.registry.onSubagentStart({ runId: 'r1', id: 'FORK', parentSessionId: 'F2', local: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(view.notifications, [], 'a fork header is not a subagent association')
})

test('G-ACP2-PR2 PLAN-02: the official turn/start reset removes the already announced plan', async () => {
  const view = projectionView('P1')
  await view.resume()
  view.notifications.length = 0
  view.commit('todo/write', { todos: [{ content: 'first turn work', status: 'completed' }] })
  await waitUntil(() => view.notifications.length >= 1, 'the first plan is projected')
  view.commit('turn/start', { turn: 2 })
  await waitUntil(() => view.notifications.length >= 2, 'the reset removes the announced plan')
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['plan_update', 'plan_removed'],
    'a negotiated client gets plan_removed for the exact plan id')
  assert.equal((view.notifications[1] as { planId?: string }).planId, 'dsh-todos:P1')
  // A turn start with NOTHING announced sends nothing: official null is not a
  // plan removal.
  view.notifications.length = 0
  view.commit('turn/start', { turn: 3 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(view.notifications.length, 0)
})

test('G-ACP2-PR2 PLAN-03: a baseline client gets the empty whole-list replacement on the same reset', async () => {
  const view = projectionView('P2', { capabilities: PR2_BASELINE })
  await view.resume()
  view.notifications.length = 0
  view.commit('todo/write', { todos: [{ content: 'first turn work', status: 'pending' }] })
  await waitUntil(() => view.notifications.length >= 1, 'the legacy plan is projected')
  view.commit('turn/start', { turn: 2 })
  await waitUntil(() => view.notifications.length >= 2, 'the reset replaces the legacy plan')
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['plan', 'plan'])
  assert.deepEqual((view.notifications[1] as { entries?: unknown[] }).entries, [])
})

test('G-ACP2-PR2 PLAN-04: a replayed plan then turn/start keeps the same reset order', async () => {
  const view = projectionView('P3', {
    history: {
      header: { sessionId: 'P3', cwd: '/w' },
      events: [
        { seq: 0, type: 'todo/write', data: { todos: [{ content: 'history work', status: 'completed' }] } },
        { seq: 1, type: 'turn/start', data: { turn: 2 } },
      ],
    },
  })
  await view.load()
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['plan_update', 'plan_removed'])
})

test('G-ACP2-PR2 PLAN-01: resume reads the CURRENT official plan once, and a null projection sends nothing', async () => {
  const view = projectionView('R2')
  view.access.todosValue = [{ content: 'open work', status: 'pending' }]
  await view.resume()
  await waitUntil(() => view.notifications.length === 1, 'the current plan is projected on resume')
  assert.deepEqual(view.notifications, [{
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: 'dsh-todos:R2', entries: [{ content: 'open work', status: 'pending', priority: 'medium' }] },
  }])

  const none = projectionView('R3')
  none.access.todosValue = null
  await none.resume()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(none.notifications, [], 'no todo write yet means no plan at all')
})

test('G-ACP2-PR2 MESSAGE-01: a loaded history replays its real agent-message as session_message', async () => {
  const view = projectionView('H1', {
    history: {
      header: { sessionId: 'H1', cwd: '/w' },
      events: [{
        seq: 0,
        type: 'user/message',
        data: { id: 'am1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' }, content: [{ type: 'text', text: 'from the child' }], role: 'user' },
      }],
    },
  })
  // The canonical history replays the verified child association first, exactly
  // like the live path: stable v1 announces a child before its traffic.
  view.access.headerFacts = { sessionId: 'SENDER', origin: 'subagent', parentSessionId: 'H1', cwd: '/w' }
  await view.load()
  assert.deepEqual(view.notifications, [
    { sessionUpdate: 'subagent_update', sessionId: 'SENDER', cwd: '/w' },
    {
      sessionUpdate: 'session_message',
      messageId: 'am1',
      senderSessionId: 'SENDER',
      recipientSessionId: 'H1',
      content: [{ type: 'text', text: 'from the child' }],
    },
  ])
  // A baseline client never receives the supplemental frame.
  const baseline = projectionView('H2', {
    capabilities: PR2_BASELINE,
    history: {
      header: { sessionId: 'H2', cwd: '/w' },
      events: [{
        seq: 0,
        type: 'user/message',
        data: { id: 'am1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' }, content: [{ type: 'text', text: 'from the child' }], role: 'user' },
      }],
    },
  })
  await baseline.load()
  assert.deepEqual(baseline.notifications, [])
})

test('G-ACP2-PR2 LOAD-03: a turn committed while the snapshot is read replays completely and once', async () => {
  const view = projectionView('L3', {
    history: {
      header: { sessionId: 'L3', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'before the snapshot' }], role: 'user' } }],
    },
  })
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  // A DIFFERENT surface (the TUI) commits a whole real turn while the canonical
  // snapshot is being read: it is NOT part of the snapshot and NOT live flight
  // output of this View, but it IS that Session's durable history.
  view.commit('user/message', { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'during the read' }], role: 'user' })
  view.commit('assistant/message', { message: { id: 'a1', content: [{ type: 'text', text: 'while reading' }] } })
  view.commit('tool/call', { callId: 'c2', name: 'bash', arguments: '{"cmd":"ls"}' })
  view.commit('tool/result', { message: { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'ok' }] } })
  readRelease.resolve({
    header: { sessionId: 'L3', cwd: '/w' },
    events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'before the snapshot' }], role: 'user' } }],
  })
  await loading
  const kinds = view.notifications.map(update => update.sessionUpdate)
  assert.deepEqual(kinds, [
    'user_message_chunk',
    'user_message_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
  ], 'the snapshot history then the buffered turn, each transcript fact exactly once')
  assert.equal((view.notifications[2] as { content?: { text?: string } }).content?.text, 'while reading')
})

test('G-ACP2-PR2 LOAD-07: the replay barrier stays closed until the history really drained', async () => {
  const view = projectionView('LD1', {
    history: {
      header: { sessionId: 'LD1', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }], role: 'user' } }],
    },
  })
  const hold = view.holdProjection()
  const loading = view.load()
  // Deterministic: the sink itself signals that the history notification is
  // blocked, so the ordered tail is provably still draining here.
  await hold.entered
  await assert.rejects(
    view.registry.promptSession(view.conn, view.access, {
      sessionId: 'LD1', prompt: [{ type: 'text', text: 'too early' }],
    }, new AbortController().signal, false, async () => {}),
    isViewError('LOCAL_ACP_VIEW_BUSY'),
    'a prompt cannot enter while the load history is still being sent',
  )
  // A DIFFERENT surface commits a durable humch while the drain is running: it
  // must still ride the canonical replay, never the live-only path.
  view.commit('user/message', { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'during drain' }], role: 'user' })
  hold.release()
  await loading
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['user_message_chunk', 'user_message_chunk'],
    'the snapshot AND the turn committed during the drain are replayed')
  assert.equal((view.notifications[1] as { content?: { text?: string } }).content?.text, 'during drain')
})

test('G-ACP2-PR2 LOAD-08: close during the drain cancels the replay instead of publishing a stale history', async () => {
  const view = projectionView('LD2', {
    history: {
      header: { sessionId: 'LD2', cwd: '/w' },
      events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }], role: 'user' } }],
    },
  })
  const hold = view.holdProjection()
  const loading = view.load()
  await hold.entered
  await view.registry.closeSession(view.conn, view.access, 'LD2')
  hold.release()
  await assert.rejects(loading, isViewError('LOCAL_ACP_VIEW_CLOSED'),
    'a closed View never publishes a stale load history')
  // The ONE frame already handed to the transport before the close cannot be
  // retracted; nothing after it may be published.
  assert.equal(view.notifications.length, 1)
  assert.equal(view.notifications[0]?.sessionUpdate, 'user_message_chunk')
  assert.equal(view.registry.hasClaim('LD2'), false)
})

test('G-ACP2-PR2 SUB-02: an official child edge observed inside a load barrier never precedes the canonical history', async () => {
  const view = projectionView('S7')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  view.access.headerFacts = { sessionId: 'CHILD', origin: 'subagent', parentSessionId: 'S7', cwd: '/w' }
  const loading = view.load()
  await readStarted.promise
  view.registry.onSubagentStart({ runId: 'run-barrier', id: 'CHILD', parentSessionId: 'S7', local: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(view.notifications.length, 0, 'a child edge cannot overtake the history it must follow')
  readRelease.resolve({
    header: { sessionId: 'S7', cwd: '/w' },
    events: [{ seq: 0, type: 'user/message', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'history first' }], role: 'user' } }],
  })
  await loading
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['user_message_chunk', 'subagent_update'],
    'the canonical history comes first, then the child association announced inside the same tail')
})

test('G-ACP2-PR2 PLAN-05: a turn/start reset arriving while the plan send is still held is not lost', async () => {
  const view = projectionView('P5')
  await view.resume()
  view.notifications.length = 0
  const hold = view.holdProjection()
  view.commit('todo/write', { todos: [{ content: 'held plan', status: 'pending' }] })
  // The sink proves the plan notification is STILL HELD when the official reset
  // arrives. The reset must still enter the one ordered tail; deciding at
  // arrival time would drop it while `announcedPlan` is not set yet.
  await hold.entered
  view.commit('turn/start', { turn: 2 })
  hold.release()
  await waitUntil(() => view.notifications.length >= 2, 'the held plan then exactly one reset')
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['plan_update', 'plan_removed'])
})

test('G-ACP2-PR2 PLAN-06: a HELD legacy plan send followed by the official reset yields one empty replacement', async () => {
  const view = projectionView('P6', { capabilities: PR2_BASELINE })
  await view.resume()
  view.notifications.length = 0
  const hold = view.holdProjection()
  view.commit('todo/write', { todos: [{ content: 'held legacy plan', status: 'pending' }] })
  await hold.entered
  view.commit('turn/start', { turn: 2 })
  hold.release()
  await waitUntil(() => view.notifications.length >= 2, 'the held legacy plan then exactly one reset')
  assert.deepEqual(view.notifications.map(update => update.sessionUpdate), ['plan', 'plan'])
  assert.deepEqual((view.notifications[1] as { entries?: unknown[] }).entries, [],
    'a baseline client gets the complete empty replacement, never a fabricated plan_removed')
})

test('G-ACP2-PR2 LOAD-06: an unreadable agent-message image fails the load instead of dropping the message', async () => {
  const event = (image: unknown) => [{
    seq: 0,
    type: 'user/message',
    data: {
      id: 'am1',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'CHILD' },
      role: 'user',
      content: [{ type: 'text', text: 'see the image' }, image],
    },
  }]
  const broken = projectionView('LD6', {
    history: { header: { sessionId: 'LD6', cwd: '/w' }, events: event({ type: 'image', attachment: { attachmentId: 'img-missing', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }) },
  })
  broken.access.headerFacts = { sessionId: 'CHILD', origin: 'subagent', parentSessionId: 'LD6', cwd: '/w' }
  await assert.rejects(broken.load(), isViewError('LOCAL_ACP_LOAD_ATTACHMENT_READ_FAILED'),
    'an incomplete canonical replay fails closed instead of dropping the message')
  // The same committed message with a readable Store object replays normally.
  const healthy = projectionView('LD7', {
    history: { header: { sessionId: 'LD7', cwd: '/w' }, events: event({ type: 'image', attachment: { attachmentId: 'img-ok', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }) },
  })
  healthy.access.headerFacts = { sessionId: 'CHILD', origin: 'subagent', parentSessionId: 'LD7', cwd: '/w' }
  healthy.access.storedImages.set('img-ok', { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' })
  await healthy.load()
  const message = healthy.notifications.find(update => update.sessionUpdate === 'session_message')
  assert.deepEqual(message?.content?.map(block => block.type), ['text', 'image'])
})

test('G-ACP2-PR2 LOAD-02: buffered live events join in seq order, once per seq, even when delivered out of order', async () => {
  const view = projectionView('O1')
  const readStarted = Promise.withResolvers<void>()
  const readRelease = Promise.withResolvers<AcpSessionHistory>()
  view.access.readSessionHistoryImpl = async () => {
    readStarted.resolve()
    return await readRelease.promise
  }
  const loading = view.load()
  await readStarted.promise
  // Delivered 3 → 2 → 2 (a duplicate) while the snapshot is read.
  for (const title of ['third', 'second', 'second']) {
    view.registry.onSessionEvent(view.agent.session, {
      seq: title === 'third' ? 3 : 2,
      type: 'session/title',
      data: { title, messageSeqs: [], source: 'user' },
    })
  }
  readRelease.resolve({ header: { sessionId: 'O1', cwd: '/w' }, events: [] })
  await loading
  assert.deepEqual(view.notifications.map(update => (update as { title?: string }).title), ['second', 'third'],
    'the live window is projected in ascending seq order exactly once per seq')
})

test('G-ACP2-PR2 COMPACT-01: a duplicated compaction callback never re-projects the lifecycle', async () => {
  const view = projectionView('C2')
  await view.resume()
  view.notifications.length = 0
  const start = { compactionId: 'cp1', turn: null }
  view.commit('compaction/start', start)
  view.commit('compaction/start', start)
  view.commit('compaction/summary', { compactionId: 'cp1', summary: [{ type: 'text', text: 'sum' }] })
  view.commit('compaction/summary', { compactionId: 'cp1', summary: [{ type: 'text', text: 'sum' }] })
  view.commit('compaction/end', { compactionId: 'cp1', turn: null })
  view.commit('compaction/end', { compactionId: 'cp1', turn: null })
  await waitUntil(() => view.notifications.length >= 3, 'the compaction lifecycle is projected')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(view.notifications.map(update => (update as { status?: string }).status),
    ['in_progress', 'in_progress', 'completed'])
  assert.equal((view.notifications[1] as { summary?: unknown }).summary !== undefined, true)
})

test('G-ACP2-PR2 SUB-01: an end arriving while the start notification is still held still joins it in order', async () => {
  const view = projectionView('S8')
  await view.resume()
  view.notifications.length = 0
  view.access.headerFacts = { sessionId: 'CHILD', parentSessionId: 'S8', origin: 'subagent', cwd: '/w' }
  const hold = view.holdProjection()
  view.registry.onSubagentStart({ runId: 'run-held', id: 'CHILD', parentSessionId: 'S8', local: true })
  await hold.entered
  view.registry.onSubagentEnd({ runId: 'run-held', id: 'CHILD', parentSessionId: 'S8', local: true, stopReason: 'completed' })
  hold.release()
  await waitUntil(() => view.notifications.length >= 2, 'the held start then its end are delivered in order')
  const states = view.notifications
    .filter(update => update.sessionUpdate === 'subagent_update')
    .map(update => (update as { state?: { state?: string; stopReason?: unknown } }).state)
  assert.deepEqual(states, [{ state: 'running' }, { state: 'idle', stopReason: 'end_turn' }],
    'the runId join resolves inside the one FIFO tail, so a held start cannot orphan its end')
})

test('G-ACP2-PR2 SUB-01 negative: an end edge whose start this View never projected announces nothing', async () => {
  const view = projectionView('S9')
  await view.resume()
  view.notifications.length = 0
  view.access.headerFacts = { sessionId: 'CHILD', parentSessionId: 'S9', origin: 'subagent', cwd: '/w' }
  view.registry.onSubagentEnd({ runId: 'never-started', id: 'CHILD', parentSessionId: 'S9', local: true, stopReason: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(view.notifications, [], 'a lone idle snapshot is not a verified association')
})

test('G-ACP2-PR2 META-01: identical titles are not re-sent and another Session never receives this one projection', async () => {
  const view = projectionView('T1')
  await view.resume()
  view.notifications.length = 0
  view.commit('session/title', { title: 'Same', messageSeqs: [], source: 'user' })
  view.commit('session/title', { title: 'Same', messageSeqs: [], source: 'user' })
  view.commit('session/title', { title: 'Changed', messageSeqs: [], source: 'user' })
  await waitUntil(() => view.notifications.length === 2, 'only the two real title changes are projected')
  assert.deepEqual(view.notifications.map(update => (update as { title?: string }).title), ['Same', 'Changed'])
  // A sibling Session's event never reaches this claim's connection.
  view.registry.onSessionEvent({ id: 'other' }, { seq: 900, type: 'todo/write', data: { todos: [] } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(view.notifications.length, 2)
})

/** One detached command catalog for the new ACP command owner tests. */
function commandCatalog(commandNames: readonly ('feedback' | 'compact')[] = []): AcpCommandCatalogRead {
  const rows = commandNames.map(name => ({
    kind: 'command' as const,
    name,
    description: name === 'feedback' ? 'Send feedback to the product team.' : 'Compact this session.',
    ...(name === 'feedback' ? {} : { inputHint: 'No arguments' }),
  }))
  return {
    effectiveNames: [...commandNames],
    feedback: commandNames.includes('feedback') ? 'available' : 'missing',
    compact: commandNames.includes('compact') ? 'available' : 'missing',
    rows,
  }
}

/** One scripted official ManualCompactionError (structural; never the real class). */

test('ACP /feedback executes the official standalone command once, never a prompt or model turn', async () => {
  const view = projectionView('CMD1')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const entered = deferred<void>()
  const release = deferred<{ readonly result: { readonly kind: 'success'; readonly text: string } }>()
  let executionSignal: AbortSignal | undefined
  view.access.executeStandaloneCommandImpl = async (_agent, _session, line, signal) => {
    assert.equal(line, '/feedback hello')
    executionSignal = signal
    entered.resolve()
    return await release.promise
  }
  await view.resume()
  view.notifications.length = 0
  const signal = new AbortController()
  const updates: SessionUpdate[] = []
  const request = view.registry.promptSession(
    view.conn,
    view.access,
    { sessionId: 'CMD1', prompt: [{ type: 'text', text: '/feedback hello' }] },
    signal.signal,
    false,
    async update => { updates.push(update) },
  )
  await entered.promise
  assert.equal(view.access.promptCalls.length, 0, 'the command is never sent to the model prompt path')
  assert.equal(view.access.standaloneCommandCalls.length, 1)
  view.registry.cancelSession(view.conn, view.access, 'CMD1')
  await Promise.resolve()
  assert.equal(executionSignal?.aborted, false, 'a dispatched standalone command is not interruptible by the client')
  release.resolve({ result: { kind: 'success', text: 'Feedback recorded.' } })
  assert.deepEqual(await request, { stopReason: 'end_turn' })
  assert.deepEqual(updates, [{
    sessionUpdate: 'agent_message_chunk',
    messageId: updates[0]?.sessionUpdate === 'agent_message_chunk' ? (updates[0] as { messageId: string }).messageId : '',
    content: { type: 'text', text: 'Feedback recorded.' },
  }])
  assert.equal(view.registry.hasUnsettledHostWork(), false)
})

test('ACP command admission is one exact slot: a second prompt/command is refused until the official Promise settles', async () => {
  const view = projectionView('CMD2')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const entered = deferred<void>()
  const release = deferred<unknown>()
  view.access.executeStandaloneCommandImpl = async () => {
    entered.resolve()
    return await release.promise
  }
  await view.resume()
  const signal = new AbortController()
  const first = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD2', prompt: [{ type: 'text', text: '/feedback first' }] },
    signal.signal, false, async () => {},
  )
  await entered.promise
  await assert.rejects(
    view.registry.promptSession(
      view.conn, view.access,
      { sessionId: 'CMD2', prompt: [{ type: 'text', text: '/feedback second' }] },
      signal.signal, false, async () => {},
    ),
    isPromptError('LOCAL_ACP_PROMPT_IN_FLIGHT'),
  )
  assert.equal(view.access.standaloneCommandCalls.length, 1, 'no second official execution was admitted')
  release.resolve({ result: { kind: 'success', text: 'ok' } })
  assert.deepEqual(await first, { stopReason: 'end_turn' })
})

test('ACP /compact exposes one exact scoped operation and orders its PR2 updates before the command result', async () => {
  const view = projectionView('CMP1')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  view.access.executeManualCompactImpl = async () => {
    view.commit('compaction/start', { compactionId: 'c1', turn: null })
    const startSeq = view.lastSeq()
    view.commit('compaction/summary', {
      compactionId: 'c1', summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 12,
      provider: 'p', model: 'm',
    })
    const summarySeq = view.lastSeq()
    view.commit('user/message', {
      role: 'user', id: 'checkpoint-c1', content: [],
      source: { kind: 'compact-checkpoint', compactionId: 'c1' },
    })
    view.commit('compaction/end', { compactionId: 'c1', turn: null })
    const endSeq = view.lastSeq()
    return {
      compactionId: 'c1', startSeq, summarySeq, endSeq,
      shadowedSeqs: [1, 2], shadowedTokenCount: 12,
    }
  }
  await view.resume()
  view.notifications.length = 0
  const result = await view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMP1', prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal, false,
    async update => { view.notifications.push(update) },
  )
  assert.deepEqual(result, { stopReason: 'end_turn' })
  assert.equal(view.access.promptCalls.length, 0)
  assert.equal(view.access.manualCompactCalls.length, 1)
  const kinds = view.notifications.map(update => update.sessionUpdate)
  assert.deepEqual(kinds, ['compaction_update', 'compaction_update', 'compaction_update', 'agent_message_chunk'],
    'the existing PR2 updates are delivered before the command result text')
  assert.deepEqual(view.notifications.at(-1), {
    sessionUpdate: 'agent_message_chunk',
    messageId: (view.notifications.at(-1) as { messageId: string }).messageId,
    content: { type: 'text', text: 'Compacted 2 history items (~12 tokens).' },
  })
})

test('ACP /compact commit wins the reverse synchronous race and is never aborted', async () => {
  const view = projectionView('CMP2')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  const entered = deferred<void>()
  const release = deferred<void>()
  let executionSignal: AbortSignal | undefined
  let startSeq = 0
  let summarySeq = 0
  let endSeq = 0
  view.access.executeManualCompactImpl = async (_agent, _session, signal) => {
    executionSignal = signal
    view.commit('compaction/start', { compactionId: 'c2', turn: null })
    startSeq = view.lastSeq()
    entered.resolve()
    await release.promise
    return {
      compactionId: 'c2', startSeq, summarySeq, endSeq,
      shadowedSeqs: [1], shadowedTokenCount: 1,
    }
  }
  await view.resume()
  const result = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMP2', prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  view.registry.cancelSession(view.conn, view.access, 'CMP2')
  // The cancel intent is recorded, but the summarizer output and the whole
  // commit bracket are published in the SAME synchronous stack before the
  // deferred decision can run. The commit must win.
  view.commit('compaction/summary', {
    compactionId: 'c2', summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
    provider: 'p', model: 'm',
  })
  summarySeq = view.lastSeq()
  view.commit('compaction/end', { compactionId: 'c2', turn: null })
  endSeq = view.lastSeq()
  release.resolve()
  assert.deepEqual(await result, { stopReason: 'end_turn' })
  await Promise.resolve()
  assert.equal(executionSignal?.aborted, false, 'a committed operation is never aborted by the deferred decision')
})

test('ACP /compact abort is deferred exactly one microtask and the real precommit cancellation settles', async () => {
  const view = projectionView('CMP3')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  const entered = deferred<void>()
  view.access.executeManualCompactImpl = async (_agent, _session, signal) => {
    view.commit('compaction/start', { compactionId: 'c3', turn: null })
    entered.resolve()
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        view.commit('compaction/end', { compactionId: 'c3', turn: null, error: 'cancelled' })
        reject(signal.reason)
      }, { once: true })
    })
  }
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMP3', prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  view.registry.cancelSession(view.conn, view.access, 'CMP3')
  assert.deepEqual(await request, { stopReason: 'cancelled' })
  assert.equal(view.access.manualCompactCalls[0]?.signal.aborted, true)
})

test('ACP catalog publishes a complete sorted replacement and never executes a shadowed Skill', async () => {
  const view = projectionView('CAT1')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  })
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the initial catalog is delivered')
  const first = view.catalogNotifications[0] as { availableCommands: Array<{ name: string }> }
  assert.deepEqual(first.availableCommands.map(row => row.name), ['compact', 'deploy'])
  // A real Host command named deploy now shadows the Skill: the next complete
  // catalog drops the Skill row, and a submitted deploy line is unsupported.
  view.access.readCommandCatalogImpl = () => ({
    effectiveNames: ['compact', 'deploy'],
    feedback: 'missing',
    compact: 'available',
    rows: [
      { kind: 'command', name: 'compact', description: 'Compact this session.' },
    ],
  })
  view.registry.onCommandCatalogInvalidated()
  await waitUntil(() => view.catalogNotifications.length === 2, 'the replacement catalog is delivered')
  const second = view.catalogNotifications[1] as { availableCommands: Array<{ name: string }> }
  assert.deepEqual(second.availableCommands.map(row => row.name), ['compact'])
  view.access.executeStandaloneCommandImpl = async () => {
    throw new Error('the shadowed command must never be executed')
  }
  await assert.rejects(
    view.registry.promptSession(
      view.conn, view.access,
      { sessionId: 'CAT1', prompt: [{ type: 'text', text: '/deploy now' }] },
      new AbortController().signal, false, async () => {},
    ),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_COMMAND_UNSUPPORTED',
  )
  assert.equal(view.access.standaloneCommandCalls.length, 0, 'the supported-name set never grants execution authority')
})

test('an advertised native Skill keeps the ordinary prompt path and revalidates before dispatch', async () => {
  const view = projectionView('SK1')
  view.access.readCommandCatalogImpl = () => commandCatalog([])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  })
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the Skill catalog is delivered')
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'SK1', prompt: [{ type: 'text', text: '/deploy production' }] },
    new AbortController().signal, false, async () => {},
  )
  await waitUntil(() => view.access.promptCalls.length === 1, 'the native prompt reaches the official Controller')
  assert.equal(view.access.standaloneCommandCalls.length, 0, 'a Skill is never the standalone command route')
  const prompt = view.access.promptCalls[0]
  assert.notEqual(prompt, undefined)
  view.registry.onInboxInserted(view.agent, { id: 'skill-msg', source: { kind: 'user', rpcId: prompt?.requestId } })
  view.registry.onInboxClaimed(view.agent, { id: 'skill-msg' }, 1)
  view.commit('assistant/message', { turn: 1, message: { id: 'skill-answer', content: [{ type: 'text', text: 'deployed' }] } })
  view.commit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await request, { stopReason: 'end_turn' })
})

test('a held Skill preflight is cancellable before any Host insertion and releases the claim', async () => {
  const view = projectionView('SK2')
  view.access.readCommandCatalogImpl = () => commandCatalog([])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  })
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the Skill catalog is delivered')
  let entered!: () => void
  const held = new Promise<void>(resolve => { entered = resolve })
  view.access.readNativeSkillsImpl = async (_agent, _session, signal) => {
    entered()
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'SK2', prompt: [{ type: 'text', text: '/deploy' }] },
    new AbortController().signal, false, async () => {},
  )
  await held
  view.registry.cancelSession(view.conn, view.access, 'SK2')
  assert.deepEqual(await request, { stopReason: 'cancelled' })
  assert.equal(view.access.promptCalls.length, 0, 'no prompt may be inserted after a cancelled preflight')
  assert.equal(view.registry.hasUnsettledHostWork(), false, 'the pre-dispatch cancellation leaves no Host obligation')
})

test('a Host command registering during the Skill preflight wins: the stale Skill intent is refused', async () => {
  const view = projectionView('SK3')
  view.access.readCommandCatalogImpl = () => commandCatalog([])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available',
    cwd: '/w',
    skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }],
  })
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the Skill catalog is delivered')
  let entered!: () => void
  const enteredRead = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  view.access.readNativeSkillsImpl = async () => {
    entered()
    await held
    return { kind: 'available', cwd: '/w', skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy the app.' }] }
  }
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'SK3', prompt: [{ type: 'text', text: '/deploy' }] },
    new AbortController().signal, false, async () => {},
  )
  await enteredRead
  // The same name becomes a real Host command while the read is held.
  view.access.readCommandCatalogImpl = () => ({
    effectiveNames: ['deploy'],
    feedback: 'missing',
    compact: 'missing',
    rows: [],
  })
  release()
  await assert.rejects(request, (error: unknown) =>
    error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_COMMAND_STALE')
  assert.equal(view.access.promptCalls.length, 0, 'a Host command registration never falls through to a model prompt')
})

test('Close waits for the original command Promise and never releases the claim on delivery alone', async () => {
  const view = projectionView('CMD3')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const entered = deferred<void>()
  const release = deferred<unknown>()
  view.access.executeStandaloneCommandImpl = async () => {
    entered.resolve()
    return await release.promise
  }
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD3', prompt: [{ type: 'text', text: '/feedback held' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  let closed = false
  const closing = view.registry.closeSession(view.conn, view.access, 'CMD3').then(value => {
    closed = true
    return value
  })
  await Promise.resolve()
  assert.equal(closed, false, 'close cannot detach before the official command Promise settles')
  assert.equal(view.registry.hasUnsettledHostWork(), true)
  assert.equal(view.registry.hasClaim('CMD3'), true)
  release.resolve({ result: { kind: 'success', text: 'ok' } })
  assert.deepEqual(await closing, {})
  assert.deepEqual(await request, { stopReason: 'end_turn' })
  assert.equal(view.registry.hasClaim('CMD3'), false)
})

test('a physical EOF keeps the command claim fenced and releases it only after the original Promise settles', async () => {
  const view = projectionView('CMD4')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const entered = deferred<void>()
  const release = deferred<unknown>()
  view.access.executeStandaloneCommandImpl = async () => {
    entered.resolve()
    return await release.promise
  }
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD4', prompt: [{ type: 'text', text: '/feedback eof' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  view.registry.releaseConnection(view.conn, view.access)
  await Promise.resolve()
  assert.equal(view.registry.hasClaim('CMD4'), true, 'EOF is a delivery close, not a Host terminal')
  assert.equal(view.registry.hasUnsettledHostWork(), true)
  release.resolve({ result: { kind: 'success', text: 'ok' } })
  assert.deepEqual(await request, { stopReason: 'end_turn' })
  await waitUntil(() => !view.registry.hasClaim('CMD4'), 'the command claim is released after its real terminal')
})

test('a failed catalog re-read retains the last delivered complete catalog and later converges', async () => {
  const view = projectionView('CAT2')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the initial catalog is delivered')
  view.access.readCommandCatalogImpl = () => {
    throw new Error('registry unavailable')
  }
  view.registry.onCommandCatalogInvalidated()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(view.catalogNotifications.length, 1, 'a read failure never publishes an empty replacement')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback', 'compact'])
  view.registry.onCommandCatalogInvalidated()
  await waitUntil(() => view.catalogNotifications.length === 2, 'a later successful read publishes the replacement')
  const names = (view.catalogNotifications[1] as { availableCommands: Array<{ name: string }> }).availableCommands.map(row => row.name)
  assert.deepEqual(names, ['compact', 'feedback'])
})

test('a held catalog snapshot that loses its epoch never delivers its stale replacement', async () => {
  const view = projectionView('CAT3')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  view.access.readNativeSkillsImpl = async () => ({ kind: 'available', cwd: '/w', skills: [] })
  await view.resume()
  await waitUntil(() => view.catalogNotifications.length === 1, 'the initial catalog is delivered')
  const entered = deferred<void>()
  const release = deferred<AcpNativeSkillCatalog>()
  view.access.readNativeSkillsImpl = async () => {
    entered.resolve()
    return await release.promise
  }
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback', 'compact'])
  view.registry.onCommandCatalogInvalidated()
  await entered.promise
  // A newer invalidation lands while the first snapshot is held. The stale
  // read must lose its epoch after the await; only the newest complete catalog
  // may reach the client.
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  view.registry.onCommandCatalogInvalidated()
  view.access.readNativeSkillsImpl = async () => ({ kind: 'available', cwd: '/w', skills: [] })
  release.resolve({ kind: 'available', cwd: '/w', skills: [] })
  await waitUntil(() => view.catalogNotifications.length === 2, 'the newest complete catalog is delivered')
  const delivered = (view.catalogNotifications[1] as { availableCommands: Array<{ name: string }> })
    .availableCommands.map(row => row.name)
  assert.deepEqual(delivered, ['compact'], 'the stale held replacement never reaches the client')
})

test('session/load holds the first history notification and publishes the catalog only after the replay barrier', async () => {
  const history: AcpSessionHistory = {
    header: { sessionId: 'CAT5', cwd: '/w' },
    events: [
      { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'load question' }], role: 'user' } },
      { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'load answer' }] } } },
    ],
  }
  const view = projectionView('CAT5', { history })
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const held = view.holdProjection()
  const loading = view.load()
  await held.entered
  assert.equal(view.catalogNotifications.length, 0, 'the catalog waits for the replay barrier')
  held.release()
  await loading
  await waitUntil(() => view.catalogNotifications.length === 1, 'the complete catalog is delivered after load')
  const names = (view.catalogNotifications[0] as { availableCommands: Array<{ name: string }> })
    .availableCommands.map(row => row.name)
  assert.deepEqual(names, ['feedback'])
  assert.equal(view.notifications.filter(update => update.sessionUpdate === 'user_message_chunk').length, 1,
    'the held history user message is delivered exactly once')
  assert.equal(view.notifications.filter(update => update.sessionUpdate === 'agent_message_chunk').length, 1,
    'the held history assistant message is delivered exactly once')
})

test('a compact settled through end but held before flush is not aborted by a late cancel', async () => {
  const view = projectionView('CMP7')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  const entered = deferred<void>()
  const release = deferred<void>()
  let startSeq = 0
  let summarySeq = 0
  let endSeq = 0
  view.access.executeManualCompactImpl = async (_agent, _session, signal) => {
    view.commit('compaction/start', { compactionId: 'c7', turn: null })
    startSeq = view.lastSeq()
    view.commit('compaction/summary', {
      compactionId: 'c7', summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
      provider: 'p', model: 'm',
    })
    summarySeq = view.lastSeq()
    view.commit('compaction/end', { compactionId: 'c7', turn: null })
    endSeq = view.lastSeq()
    entered.resolve()
    await release.promise
    assert.equal(signal.aborted, false, 'the end-before-flush window is not a cancellation boundary')
    return { compactionId: 'c7', startSeq, summarySeq, endSeq, shadowedSeqs: [1], shadowedTokenCount: 1 }
  }
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMP7', prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  view.registry.cancelSession(view.conn, view.access, 'CMP7')
  await Promise.resolve()
  assert.equal(view.access.manualCompactCalls[0]?.signal.aborted, false)
  release.resolve()
  assert.deepEqual(await request, { stopReason: 'end_turn' })
})

test('a failed command result notification is OUTPUT_FAILED, never a business cancellation or retry', async () => {
  const view = projectionView('CMD5')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  view.access.executeStandaloneCommandImpl = async () => ({ result: { kind: 'success', text: 'Feedback recorded.' } })
  await view.resume()
  await assert.rejects(
    view.registry.promptSession(
      view.conn, view.access,
      { sessionId: 'CMD5', prompt: [{ type: 'text', text: '/feedback hi' }] },
      new AbortController().signal, false,
      async () => { throw new Error('wire write failed') },
    ),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_COMMAND_OUTPUT_FAILED',
  )
  assert.equal(view.access.standaloneCommandCalls.length, 1, 'the official command ran exactly once and was never retried')
})

test('Close during a held command never retires the scoped MCP lease before the original Promise', async () => {
  const view = projectionView('CMD6', { mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] })
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  view.access.mountScopedMcpImpl = async (agent, session) => makeScopedLease(agent, session)
  const retireCalls: string[] = []
  const retire = deferred<void>()
  view.access.retireScopedMcpImpl = async lease => {
    retireCalls.push(lease.serverNames.join(','))
    await retire.promise
  }
  const entered = deferred<void>()
  const release = deferred<unknown>()
  view.access.executeStandaloneCommandImpl = async () => {
    entered.resolve()
    return await release.promise
  }
  await view.load()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD6', prompt: [{ type: 'text', text: '/feedback held' }] },
    new AbortController().signal, false, async () => {},
  )
  await entered.promise
  let closed = false
  const closing = view.registry.closeSession(view.conn, view.access, 'CMD6').then(value => {
    closed = true
    return value
  })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.deepEqual(retireCalls, [], 'the MCP lease is not retired before the command terminal')
  release.resolve({ result: { kind: 'success', text: 'ok' } })
  assert.deepEqual(await closing, {})
  await waitUntil(() => retireCalls.length === 1, 'the exact MCP lease retires after the command terminal')
  retire.resolve()
  assert.deepEqual(await request, { stopReason: 'end_turn' })
})

test('R1: a cancel from the synchronous compaction/start observer is replayed after dispatch', async () => {
  const view = projectionView('CMP8')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  let aborted = false
  view.access.executeManualCompactImpl = async (_agent, _session, signal) => {
    view.commit('compaction/start', { compactionId: 'c8', turn: null })
    // Reenter cancellation synchronously INSIDE the official call's prefix,
    // before executeManualCompact returns to the View.
    view.registry.cancelSession(view.conn, view.access, 'CMP8')
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        view.commit('compaction/end', { compactionId: 'c8', turn: null, error: 'cancelled' })
        reject(signal.reason)
      }, { once: true })
    })
  }
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMP8', prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal, false, async () => {},
  )
  assert.deepEqual(await request, { stopReason: 'cancelled' })
  assert.equal(aborted, true, 'the post-dispatch cancel replayed onto the captured controller')
})

test('R2: close resolves after the raw Host terminal even while the result notification is held', async () => {
  const view = projectionView('CMD7')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  const entered = deferred<void>()
  const gate = deferred<void>()
  let closeSettled = false
  view.access.executeStandaloneCommandImpl = async () => ({ result: { kind: 'success', text: 'held result' } })
  await view.resume()
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD7', prompt: [{ type: 'text', text: '/feedback held delivery' }] },
    new AbortController().signal, false,
    async () => {
      entered.resolve()
      await gate.promise
    },
  )
  await entered.promise
  const closing = view.registry.closeSession(view.conn, view.access, 'CMD7').then(value => {
    closeSettled = true
    return value
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  assert.equal(closeSettled, true, 'a settled Host operation must not retain close on a dead output wait')
  assert.deepEqual(await closing, {})
  gate.resolve()
  assert.deepEqual(await request, { stopReason: 'end_turn' })
})

test('R2: an aborted command request abandons only its held result delivery', async () => {
  const view = projectionView('CMD10')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  view.access.executeStandaloneCommandImpl = async () => ({ result: { kind: 'success', text: 'held request result' } })
  await view.resume()
  const entered = deferred<void>()
  const gate = deferred<void>()
  const controller = new AbortController()
  const first = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD10', prompt: [{ type: 'text', text: '/feedback first' }] },
    controller.signal, false,
    async () => { entered.resolve(); await gate.promise },
  )
  await entered.promise
  controller.abort()
  assert.deepEqual(await first, { stopReason: 'end_turn' }, 'the exact request abort releases its own dead delivery wait')
  // The already-started wire send is not cancellable; once the test releases
  // that held sink, the next request must be admitted and delivered.
  gate.resolve()
  const second = await view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD10', prompt: [{ type: 'text', text: '/feedback second' }] },
    new AbortController().signal, false, async () => {},
  )
  assert.deepEqual(second, { stopReason: 'end_turn' }, 'the command slot is available for the next request')
  assert.equal(view.access.standaloneCommandCalls.length, 2)
})

test('R3: a failed own mandatory compaction frame is OUTPUT_FAILED, not a successful command', async () => {
  const view = projectionView('CMP9')
  view.access.readCommandCatalogImpl = () => commandCatalog(['compact'])
  view.access.executeManualCompactImpl = async () => {
    view.commit('compaction/start', { compactionId: 'c9', turn: null })
    view.commit('compaction/summary', {
      compactionId: 'c9', summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
      provider: 'p', model: 'm',
    })
    view.commit('compaction/end', { compactionId: 'c9', turn: null })
    return { compactionId: 'c9', startSeq: 101, summarySeq: 102, endSeq: 103, shadowedSeqs: [1], shadowedTokenCount: 1 }
  }
  await view.resume()
  await new Promise(resolveWait => setImmediate(resolveWait))
  const drained = view.failProjection(1)
  await assert.rejects(
    view.registry.promptSession(
      view.conn, view.access,
      { sessionId: 'CMP9', prompt: [{ type: 'text', text: '/compact' }] },
      new AbortController().signal, false, async () => {},
    ),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_COMMAND_OUTPUT_FAILED',
  )
  await drained
})

test('R5: a cancel that lands after the Skill preflight helper returns is caught at final admission', async () => {
  const view = projectionView('SKL5')
  view.access.readCommandCatalogImpl = () => commandCatalog([])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available', cwd: '/w', skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy.' }],
  })
  await view.resume()
  for (let attempt = 0; attempt < 100 && view.catalogNotifications.length === 0; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  assert.equal(view.catalogNotifications.length, 1, 'the Skill catalog is delivered before the prompt')
  await new Promise(resolveWait => setImmediate(resolveWait))
  let catalogReads = 0
  view.access.readCommandCatalogImpl = () => {
    catalogReads += 1
    // Invocation-time reads only: 1 route, 2 helper re-read, 3 outer final
    // read. Reenter cancel at the LAST read, after the helper returned.
    if (catalogReads === 3) view.registry.cancelSession(view.conn, view.access, 'SKL5')
    return commandCatalog([])
  }
  const result = await view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'SKL5', prompt: [{ type: 'text', text: '/deploy now' }] },
    new AbortController().signal, false, async () => {},
  )
  assert.deepEqual(result, { stopReason: 'cancelled' })
  assert.equal(catalogReads, 3, 'the test actually reached the final post-read admission guard')
  assert.equal(view.access.promptCalls.length, 0, 'the revoked Skill never reached the official prompt')
  const claim = (view.registry as unknown as { claims: Map<string, { unclaimedHostObligation?: object }> }).claims.get('SKL5')
  assert.equal(claim?.unclaimedHostObligation, undefined, 'no unclaimed Host obligation was planted')
})

test('R5: a definite Skill no-dispatch failure racing Close rejects the request and closes', async () => {
  const view = projectionView('SKLCLOSE')
  view.access.readCommandCatalogImpl = () => commandCatalog([])
  view.access.readNativeSkillsImpl = async () => ({
    kind: 'available', cwd: '/w', skills: [{ kind: 'skill', name: 'deploy', description: 'Deploy.' }],
  })
  await view.resume()
  for (let attempt = 0; attempt < 100 && view.catalogNotifications.length === 0; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  assert.equal(view.catalogNotifications.length, 1, 'the Skill catalog is delivered before the race')
  await new Promise(resolveWait => setImmediate(resolveWait))
  const closeDone = deferred<Record<string, never>>()
  let invocationReads = 0
  view.access.readCommandCatalogImpl = () => {
    invocationReads += 1
    if (invocationReads >= 2) {
      queueMicrotask(() => {
        void view.registry.closeSession(view.conn, view.access, 'SKLCLOSE').then(
          value => closeDone.resolve(value),
          error => closeDone.reject(error),
        )
      })
      throw new Error('controlled final Skill read failure')
    }
    return commandCatalog([])
  }
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'SKLCLOSE', prompt: [{ type: 'text', text: '/deploy close race' }] },
    new AbortController().signal, false, async () => {},
  )
  const [requestResult, closeResult] = await Promise.allSettled([request, closeDone.promise])
  assert.equal(closeResult.status, 'fulfilled')
  assert.deepEqual(closeResult.status === 'fulfilled' ? closeResult.value : undefined, {})
  assert.equal(requestResult.status, 'rejected')
  assert.equal(requestResult.status === 'rejected' && requestResult.reason instanceof LocalAcpViewError
    ? requestResult.reason.code : '', 'LOCAL_ACP_COMMAND_UNAVAILABLE')
  assert.equal(view.access.promptCalls.length, 0, 'no official prompt was invoked')
  assert.equal(view.access.cancelledTurns.length, 0, 'Close did not fabricate a foreign turn cancellation')
  assert.equal(view.registry.hasClaim('SKLCLOSE'), false)
  assert.deepEqual(await view.registry.closeSession(view.conn, view.access, 'SKLCLOSE'), {},
    'Close is idempotent after the definite no-dispatch terminal')
})

test('R2: a held predecessor projection cannot retain close after the raw Host command settled', async () => {
  const view = projectionView('CMD8')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  view.access.executeStandaloneCommandImpl = async () => ({ result: { kind: 'success', text: 'behind held predecessor' } })
  await view.resume()
  view.notifications.length = 0
  const held = view.holdProjection()
  view.commit('todo/write', { todos: [{ content: 'held predecessor', status: 'pending' }] })
  await held.entered
  let resultEntered = false
  let closeSettled = false
  const request = view.registry.promptSession(
    view.conn, view.access,
    { sessionId: 'CMD8', prompt: [{ type: 'text', text: '/feedback predecessor' }] },
    new AbortController().signal, false,
    async () => { resultEntered = true },
  )
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  assert.equal(resultEntered, false, 'the result must be queued behind the real held predecessor')
  const closing = view.registry.closeSession(view.conn, view.access, 'CMD8').then(value => {
    closeSettled = true
    return value
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  assert.equal(closeSettled, true, 'a dead output predecessor must not retain the settled Host operation')
  assert.deepEqual(await closing, {})
  held.release()
  assert.deepEqual(await request, { stopReason: 'end_turn' })
})

test('R7: command admission refuses a still-retired turn', async () => {
  const view = projectionView('CMD9')
  view.access.readCommandCatalogImpl = () => commandCatalog(['feedback'])
  await view.resume()
  const claims = (view.registry as unknown as { claims: Map<string, { retiringTurn?: object }> }).claims
  claims.get('CMD9')!.retiringTurn = { turn: 1, origin: 'tui' }
  await assert.rejects(
    view.registry.promptSession(
      view.conn, view.access,
      { sessionId: 'CMD9', prompt: [{ type: 'text', text: '/feedback blocked' }] },
      new AbortController().signal, false, async () => {},
    ),
    (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_VIEW_BUSY',
  )
  assert.equal(view.access.standaloneCommandCalls.length, 0)
})
