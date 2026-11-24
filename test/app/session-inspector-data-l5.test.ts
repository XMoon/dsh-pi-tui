/**
 * L5/L4: the real Session Inspector exact read over the OFFICIAL Host/Client
 * wire.
 *
 * ```text
 * real Host committed events (closed turns on an owned Agent Session)
 *   -> official sessionStats + tokenUsage + projection registry cut
 *   -> Direct attached/cold observation OR official `session.projections` unary
 *   -> detached Inspector DTO (the SAME pure mapper on both adapters)
 *   -> real Browser read owner selection -> published Inspector snapshot
 * ```
 *
 * FIXTURE MANIFEST
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - `createRemoteApplicationHostFixture`'s real Host Context (JSONL persistence,
 *   SessionStore, projection registry, real AgentLoop-owned Agent handles, the
 *   official Session controller/typert Gateway) and the real in-process Client
 *   (`createRemoteClientRuntime`) with the production Remote namespaces.
 * - The official `@deepseek-ai/dsh-session-stats` and
 *   `@deepseek-ai/dsh-token-meter` function/service plugins are mounted ONCE on
 *   that Host because this in-process fixture does not compose the bundle's
 *   Loader rows; the standard profile row proof lives in
 *   `test/app/schedule-host-profile.test.ts`.
 * - Real `Session.append` commits for two closed turns on X and a live trailing
 *   turn on Y; X is then really disposed through its owned Agent handle.
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - The Browser owner's per-open Activity observation is the repository's inert
 *   typed fake: this case owns the Inspector path, not Activity (whose L5 case
 *   is `remote-session-workspace-agent-removal.test.ts`).
 * - `presentation` is a read-only probe: this case reports the typed selection
 *   explicitly. The real PiTUI/TSP presenter wiring is covered by
 *   `session-workspace-panel.test.ts` and `tern-tsp-session-browser.test.ts`.
 * - The `remote.session.projections` call counter is a local pass-through over
 *   the SAME official namespace instance; it changes no Host RPC or store.
 *
 * DELIBERATELY ABSENT
 * - No real OS split Client/Host process (that is the split-process lane).
 * - No Inspector visual paint (PR3 owns the UI).
 *
 * @module @xmoon76/dsh-pi-tui/session-inspector-data-l5.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createSessionBrowserReadOwner } from '../../src/app/command/session-browser-read.ts'
import type {
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { detachSessionInspector, INSPECTOR_PROJECTION_KEYS } from '../../src/runtime/session-inspector-projection.ts'
import { RemoteSessionReader } from '../../src/runtime/remote/session-reader-remote.ts'
import {
  RemoteSessionWorkspaceFacts,
  type RemoteSessionFactsRemotes,
} from '../../src/runtime/remote/session-workspace-facts-remote.ts'
import { DirectSessionWorkspaceFacts } from '../../src/runtime/direct/session-workspace-facts-direct.ts'
import { DirectSessionReader } from '../../src/runtime/direct/session-direct.ts'
import { DirectSessionMarkdown } from '../../src/runtime/direct/session-markdown-direct.ts'
import type { SessionWorkspaceFactsPort } from '../../src/runtime/session-workspace-facts-port.ts'
import { createRemoteApplicationHostFixture, waitFor, testLifecycle } from '../support/remote-application-fixture.ts'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { inertActivityObservation } from '../support/session-workspace-facts-fake.ts'

const X = 'l5-inspector-cold-session'
const Y = 'l5-inspector-live-session'
const Z = 'l5-inspector-roster-change'

class ProbePresentation implements SessionBrowserPresentation {
  readonly requests: SessionBrowserPanelRequest[] = []
  readonly snapshots: SessionBrowserReadSnapshot[] = []
  readonly latest = (): SessionBrowserReadSnapshot | undefined => this.snapshots.at(-1)

  open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle {
    this.requests.push(request)
    return {
      isDisposed: () => false,
      setSnapshot: (snapshot) => { this.snapshots.push(snapshot) },
      close: () => { request.onClose() },
    }
  }

  notify(): void {}
}

/** Commit one REAL closed turn through the official Session API. The tiny wait
 *  gives the paired TTFT/decode wall times a positive, still real span. */
async function appendClosedTurn(session: Session, turn: number, outputTokens: number): Promise<void> {
  session.append('turn/start', { turn })
  // The released v4 log contract numbers steps from 1 (AgentLoop appends
  // `step/start` with `phase.step + 1`); step 0 is not a valid stored step.
  session.append('step/start', { turn, step: 1 })
  await new Promise(resolve => setTimeout(resolve, 5))
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: MessageId(`l5-inspector-${turn}-${outputTokens}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [{ type: 'chunk', time: Date.now() - 2, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
    usage: { inputTokens: 3, outputTokens },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('L5/L4: the exact Inspector read is cold, non-activating, retained-safe and reconnects in the same owner', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'session-inspector-l5')

  // The real Host services the standard profile mounts through its bundle rows;
  // this fixture mounts the package services directly instead.
  if (host.ctx.get('tokenMeter') === undefined) {
    const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
    await host.ctx.plugin(TokenMeter)
  }

  // Seed X through a real owned Agent handle, with two closed turns of distinct
  // output sizes. The bundle's stats unit is mounted only when the REAL
  // registry snapshot proves it is absent.
  const xHandle = await (host.ctx as any).agents.create({
    sessionId: SessionId(X),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd: host.anchorDir },
  })
  const xSession = host.ctx.sessions.get(SessionId(X))
  assert.ok(xSession !== undefined, 'the fixture must own the seeded Host Session X')
  await appendClosedTurn(xSession, 1, 120)
  await appendClosedTurn(xSession, 2, 30)

  const registry = host.ctx.get('sessionProjections') as {
    snapshot(session: Session, keys?: readonly string[]): {
      readonly asOfSeq: number
      readonly values: Readonly<Record<string, unknown>>
    }
  }
  if (!('sessionStats' in registry.snapshot(xSession, INSPECTOR_PROJECTION_KEYS).values)) {
    await host.ctx.plugin(await import('@deepseek-ai/dsh-session-stats'))
  }
  const hostCut = registry.snapshot(xSession, INSPECTOR_PROJECTION_KEYS)
  const expected = detachSessionInspector(X, hostCut.asOfSeq, hostCut.values)
  assert.ok(expected.stats !== undefined, 'the real registry folds the whole-log sessionStats unit')
  assert.equal(expected.stats.turns, 2)
  assert.equal(expected.stats.steps, 2)
  assert.ok((expected.stats.avgTtftMs ?? 0) > 0, 'the committed TTFT span is real and positive')
  assert.ok((expected.stats.decodeTokensPerSec ?? 0) > 0, 'the committed decode span is real and positive')
  assert.equal(expected.usage?.outputTokens, 150, 'the tokenUsage projection folds both real turns')

  // Really dispose X's owned Agent handle: X becomes a cold, unretained,
  // persisted Session BEFORE the Client opens.
  await xHandle.dispose()
  await waitFor('X leaves the Host Session store', () => host.ctx.sessions.get(SessionId(X)) === undefined)
  await waitFor('X leaves the Host Agent store', () => (host.ctx as any).agents.get(SessionId(X)) === undefined)
  const persistence = host.ctx.get('sessionPersistence') as SessionPersistence
  const statBefore = await persistence.stat(SessionId(X))
  assert.ok(statBefore !== undefined, 'the cold Session keeps its durable log')
  assert.notEqual(statBefore.formatStatus, 'migration-required')

  // Y is the retained/live comparison target; its reference is normal fixture
  // setup owned by THIS test, never by the Inspector.
  const yHandle = await (host.ctx as any).agents.create({
    sessionId: SessionId(Y),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd: host.anchorDir },
  })
  const ySession = host.ctx.sessions.get(SessionId(Y))
  assert.ok(ySession !== undefined, 'the fixture must own the seeded Host Session Y')
  await appendClosedTurn(ySession, 1, 40)

  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const yReference = client.sessions.retain(SessionId(Y), { source: 'tuiMainView' })
  const remoteFacts = new RemoteSessionWorkspaceFacts({
    sessions: client.sessions,
    remote: { session: client.remote.session, workspace: client.remote.workspace },
    connection: { generation: client.connection.generation },
    events: {
      onSessionStatus: listener => client.remote.$on.bind(client.remote)('api-session/status', listener),
    },
    workspaceStream: client.workspaceStream,
    initialGeneration: client.initialGeneration,
  })
  t.after(async () => {
    yReference.release()
    remoteFacts.dispose()
    await client.dispose()
    await hostRuntime.dispose()
    await yHandle.dispose().catch(() => {})
    await host.dispose()
  })
  await yReference.ready
  await waitFor('the real Client list is ready', () => client.sessions.list.getSnapshot().phase === 'ready')
  await waitFor('the cold and live Sessions are listed', () => {
    const ids = client.sessions.list.getSnapshot().ids.map(String)
    return ids.includes(X) && ids.includes(Y)
  })

  // ── Direct cold read: exact, no retain, no activation, no migration ───────
  // X is cold here, so this fixture needs no live-registry resolver; the cold
  // stat/observation primitives are the SAME production owners the Direct
  // backend injects.
  const directReader = new DirectSessionReader(host.ctx, undefined, {
    durableProjectionForSession: () => ({ lastUsed: null, next: null }),
  })
  const directMarkdown = new DirectSessionMarkdown(host.ctx)
  const directFacts = new DirectSessionWorkspaceFacts(
    host.ctx,
    id => (host.ctx as any).agents.get(SessionId(id)),
    {
      liveSession: id => directReader.inspectorLiveSession(id),
      snapshot: (session, keys) => directReader.inspectorSnapshot(session, keys),
      onProjectionChanged: listener => directReader.inspectorOnChanged(listener) ?? (() => {}),
      stat: (id, signal) => directMarkdown.inspectorStat(id, signal),
      observe: (id, signal) => directMarkdown.inspectorObservation(id, signal),
    },
  )
  const xRetainBefore = client.sessions.retainInfo(SessionId(X)).getSnapshot()
  const directSource = directFacts.openInspector(X, () => {})
  const directResult = await directSource.read(new AbortController().signal)
  directSource.dispose()
  assert.equal(directResult.kind, 'ready')
  if (directResult.kind === 'ready') {
    assert.deepEqual(directResult.data, expected,
      'the Direct cold observation reads the SAME exact projection cut the Host registry held')
  }

  // ── Remote cold read: ONE official unary, same detached DTO ───────────────
  const inspectorRpc: string[] = []
  const countingSession: RemoteSessionFactsRemotes['session'] = {
    state: (request, signal) => client.remote.session.state({ sessionId: SessionId(request.sessionId) }, signal),
    projections: (request, signal) => {
      inspectorRpc.push(request.sessionId)
      return client.remote.session.projections({ sessionId: SessionId(request.sessionId) }, signal)
    },
  }
  const countingFacts = new RemoteSessionWorkspaceFacts({
    sessions: client.sessions,
    remote: { session: countingSession, workspace: client.remote.workspace },
    connection: { generation: client.connection.generation },
    events: {
      onSessionStatus: listener => client.remote.$on.bind(client.remote)('api-session/status', listener),
    },
    workspaceStream: client.workspaceStream,
    initialGeneration: client.initialGeneration,
  })
  t.after(() => { countingFacts.dispose() })
  const remoteSource = countingFacts.openInspector(X, () => {})
  const remoteResult = await remoteSource.read(new AbortController().signal)
  remoteSource.dispose()
  assert.equal(remoteResult.kind, 'ready')
  if (remoteResult.kind === 'ready') {
    assert.deepEqual(remoteResult.data, expected,
      'the Remote exact unary maps to the SAME detached Inspector DTO (Direct/Remote parity)')
  }
  assert.deepEqual(inspectorRpc, [X], 'ONE exact unary at X; no refresh/retain/re-enumeration')
  assert.equal(host.ctx.sessions.get(SessionId(X)), undefined, 'X never attached')
  assert.equal((host.ctx as any).agents.get(SessionId(X)), undefined, 'X never activated an Agent')
  const statAfter = await persistence.stat(SessionId(X))
  assert.equal(statAfter?.revision, statBefore.revision, 'the cold reads never rewrote the durable log')
  assert.equal(statAfter?.formatStatus, statBefore.formatStatus, 'the cold reads never migrated the log')
  const xRetainAfter = client.sessions.retainInfo(SessionId(X)).getSnapshot()
  assert.equal(xRetainAfter.referenceCount, xRetainBefore.referenceCount, 'the Inspector never retained X')
  assert.deepEqual(xRetainAfter.retainedBy, xRetainBefore.retainedBy)

  // ── The SAME real owner over the retained Y: selected changes and the ─────
  // official projection publication drive the trailing exact read.
  inspectorRpc.length = 0
  const yRetainBefore = client.sessions.retainInfo(SessionId(Y)).getSnapshot()
  const ownerFacts: SessionWorkspaceFactsPort = {
    readActivity: async () => {
      throw new Error('this L5 case never takes a whole-roster Activity sample')
    },
    observeActivity: () => inertActivityObservation(),
    followWorkspaces: (signal, mode) => countingFacts.followWorkspaces(signal, mode),
    openInspector: (sessionId, onInvalidated) => countingFacts.openInspector(sessionId, onInvalidated),
    observeConnectionGeneration: listener => countingFacts.observeConnectionGeneration!(listener),
    connectionGeneration: () => countingFacts.connectionGeneration!(),
  }
  const presentation = new ProbePresentation()
  const diag = createDiag({ stderrLevel: 'off' })
  const owner = createSessionBrowserReadOwner({
    reader: new RemoteSessionReader(client.sessions, client.connection.generation),
    presentation,
    captureSubject: () => ({
      subject: { currentSessionId: Y, currentCwd: host.anchorDir, isCurrent: () => true },
      scope: { sessionId: Y } as unknown as SessionScope,
    }),
    diag,
    sessionId: () => Y,
    sessionWorkspaceFacts: ownerFacts,
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitFor('the real owner roster lists Y', () =>
    presentation.latest()?.rows.some(entry => entry.id === Y) === true)
  presentation.requests[0]!.onInspectorSelection!({ sessionId: Y, origin: 'browse' })
  await waitFor('the selected Y exact Inspector cut', () =>
    presentation.latest()?.inspector?.state === 'ready'
    && presentation.latest()?.inspector?.sessionId === Y)
  const firstY = presentation.latest()!.inspector
  assert.ok(firstY?.state === 'ready')
  if (firstY?.state === 'ready') {
    assert.equal(firstY.data.stats?.turns, 1, 'the live selected cut is the seeded single turn')
    assert.equal(firstY.data.usage?.outputTokens, 40)
  }
  const yRetainDuring = client.sessions.retainInfo(SessionId(Y)).getSnapshot()
  assert.equal(yRetainDuring.referenceCount, yRetainBefore.referenceCount,
    'the Inspector read borrowed the binding without extending its retention')

  // A real committed turn on the SELECTED Session reaches the official
  // projection publication and the owner performs ONE trailing exact read.
  const readsAfterSelection = inspectorRpc.length
  await appendClosedTurn(ySession, 2, 20)
  await waitFor('the selected Inspector cut advances to the new committed turn', () => {
    const inspector = presentation.latest()?.inspector
    return inspector?.state === 'ready' && inspector.data.stats?.turns === 2
  })
  const advanced = presentation.latest()!.inspector
  assert.ok(advanced?.state === 'ready')
  if (advanced?.state === 'ready') {
    assert.equal(advanced.data.usage?.outputTokens, 60, 'the trailing exact read includes the new real turn')
  }
  assert.ok(inspectorRpc.length > readsAfterSelection, 'the relevant publication scheduled a trailing exact read')

  // An UNRELATED roster change (a new Session Z) never re-reads the selection.
  const readsBeforeUnrelated = inspectorRpc.length
  host.ctx.sessions.create(SessionId(Z), { meta: { cwd: host.anchorDir } })
  await waitFor('the unrelated real Session reaches the owner roster', () =>
    presentation.latest()?.rows.some(entry => entry.id === Z) === true)
  // The contract is "no periodic/extra read follows an unrelated roster change":
  // a short quiet period is the only way to observe the ABSENCE of the
  // forbidden read, so this is a bounded negative observation window.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(inspectorRpc.length, readsBeforeUnrelated,
    'an unrelated list change never re-reads the selected Inspector data')
  assert.equal(presentation.latest()?.inspector?.sessionId, Y, 'the selected identity survives the roster change')

  // A REAL Connection reconnect revokes the old exact cut and re-proves it in
  // the SAME owner, with no periodic polling afterwards.
  const snapshotsBeforeReconnect = presentation.snapshots.length
  const readsBeforeReconnect = inspectorRpc.length
  client.connection.reconnect()
  await waitFor('the real reconnect revokes the old exact cut', () =>
    presentation.snapshots.slice(snapshotsBeforeReconnect).some(snapshot =>
      snapshot.inspector !== undefined && snapshot.inspector.state !== 'ready'))
  await waitFor('the real reconnect re-proves the selected exact cut', () => {
    const inspector = presentation.latest()?.inspector
    return inspector?.state === 'ready' && inspector.sessionId === Y
  })
  assert.ok(inspectorRpc.length > readsBeforeReconnect, 'the replacement generation performs a fresh exact read')
  const readsAfterRecovery = inspectorRpc.length
  // Bounded negative window: no periodic Inspector read may follow the recovery.
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(inspectorRpc.length, readsAfterRecovery, 'no periodic/duplicate Inspector read follows the recovery')
  assert.equal(client.sessions.retainInfo(SessionId(Y)).getSnapshot().referenceCount,
    yRetainBefore.referenceCount, 'the recovered read still never retained Y itself')
  assert.equal(host.ctx.sessions.get(SessionId(X)), undefined, 'X stayed cold through every real qualification')
  assert.equal((host.ctx as any).agents.get(SessionId(X)), undefined)
})
