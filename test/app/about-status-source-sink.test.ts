/**
 * Gate A source→sink proofs (Phase 3C / C3): the OFFICIAL facts travel the
 * REAL production path — the real command runtime's session-stats read and
 * scope capture, the real StatusRuntime force (coordinator → injected
 * SessionReader port), the REAL SettingsWorkspacePanel paint — into the
 * EXACT clipboard payload (`c` on a fact, `C` Copy All).
 *
 * These are the plan §3.3 proofs 1 (Direct) and 4 (sessionless), plus the
 * negative controls: a copy after the Session swap cannot copy A, and an
 * unrelated `r` never forces a context measurement.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { type TuiCommandRunner } from "../../src/commands.ts"
import { registerTuiCommandsWithDirectSeams } from "../support/register-tui-commands.ts"
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { ContextMeasurementCoordinator } from '../../src/domain/status/context-measurement.ts'
import { sessionStatsFactsOf } from '../../src/domain/status/stats.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { event, fakeSession, fakeAgent } from '../support/runner-harness.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()

interface SinkHarness {
  readonly copied: readonly string[]
  readonly invoke: (name?: string) => unknown
  readonly view: () => string
  readonly pressKey: (data: string) => Promise<void>
  /** One native SGR press+release on 0-based terminal cells. */
  readonly click: (row: number, col: number) => Promise<void>
  /** BOUNDED wait until the frame satisfies the predicate (no bare sleep). */
  readonly waitForFrame: (predicate: (frame: string) => boolean, label: string) => Promise<void>
  readonly statsCalls: () => number
  readonly contextCalls: () => number
  readonly fireStatusInvalidation: () => void
  readonly switchSession: (id: string | undefined) => void
  readonly dispose: () => void
}

interface ProofOptions {
  readonly session: string | undefined
  readonly stats: {
    readonly turns: number
    readonly llmMs: number
    readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cacheHitPct: number }
  }
  readonly contextValue?: number
}

/**
 * The REAL surface: a TuiApp + a registered `/settings` over a runner whose
 * scope/stats/context run through `sessionScopeFacts` + a counting reader —
 * the same seams the production composition injects (status invalidation via
 * a controllable StatusStore stand-in that behaves identically: the listener
 * fires only when the projection changed).
 */
function setupProof(options: ProofOptions): SinkHarness {
  const columns = 100
  const rows = 40
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  let statsCalls = 0
  let contextCalls = 0
  let scopeObject: { readonly sessionId: string; readonly generation: number } | undefined =
    options.session === undefined ? undefined : { sessionId: options.session, generation: 1 }
  // The IDEMPOTENT captured scope (the production authority caches its
  // capture until owner/generation changes): the same live state yields the
  // SAME object, so the scope identity fence sees one owner per generation.
  let capturedScope: { readonly sessionId: string; readonly subject: unknown; readonly generation: number } | undefined =
    scopeObject === undefined
      ? undefined
      : { sessionId: scopeObject.sessionId, subject: { owner: scopeObject }, generation: scopeObject.generation }
  const recaptureScope = (): void => {
    capturedScope = scopeObject === undefined
      ? undefined
      : { sessionId: scopeObject.sessionId, subject: { owner: scopeObject }, generation: scopeObject.generation }
  }
  let fireInvalidation: () => void = () => {}
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const owned: OwnedRunner = (_label, task) => {
    void Promise.resolve().then(task)
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events, { copySelection: async (text: string) => { copied.push(text); return true } })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)

  // ── THE OFFICIAL DIRECT AUTHORITY ──────────────────────────────────────
  // A real Session event log (the SAME envelope shape the production Host
  // appends) + the production scope authority: `sessionScopeFacts` wires the
  // REAL `createSessionScopeAuthority` (owner+generation fences) over the
  // live agent slot, and its `currentSessionStats` is the PRODUCTION fold
  // (computeStats over the exact attachment's whole snapshot log).
  const ownershipCore = {
    _generation: 1,
    _sessionId: options.session as string | undefined,
    generation(): number { return this._generation },
    currentSessionId(): string | undefined { return this._sessionId },
    captureLiveSessionScope(): unknown {
      return scopeFacts.captureLiveSessionScope()
    },
    isSessionScopeCurrent(scope: unknown): boolean {
      return scopeFacts.isSessionScopeCurrent(scope as never)
    },
  }
  const eventLog = options.session === undefined
    ? []
    : [
        event('turn/start', { turn: 0 }, 0),
        event('step/start', { turn: 0, step: 0 }, 1),
        event('user/message', {
          id: MessageId('u-proof'), role: 'user', content: [{ type: 'text', text: `${options.session} prompt` }], source: { kind: 'user' },
        }, 2, 'append'),
        event('assistant/message', {
          turn: 0, step: 0,
          message: {
            id: MessageId('a-proof'), role: 'assistant',
            content: [{ type: 'text', text: 'proof answer' }],
            source: { kind: 'model', provider: 'smoke', model: 'smoke' },
          },
          stream: [],
          usage: {
            inputTokens: options.stats.tokens.input,
            outputTokens: options.stats.tokens.output,
            cacheReadTokens: options.stats.tokens.cacheRead,
            cacheWriteTokens: options.stats.tokens.cacheWrite,
          },
        }, 3, 'append'),
        event('step/end', { turn: 0, step: 0 }, 4),
        event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
      ]
  const session = fakeSession({
    id: options.session ?? 'no-session',
    header: { id: options.session ?? 'no-session', cwd: '/ws/proof', createdAt: 0, version: 1 },
    events: eventLog,
  })
  const liveAgentSlot: { agent: ReturnType<typeof fakeAgent> | undefined } = {
    agent: options.session === undefined ? undefined : fakeAgent(session),
  }
  const scopeFacts = sessionScopeFacts(() => liveAgentSlot.agent, () => ownershipCore.generation())
  // The PRODUCTION grouping over the official fold (the bootstrap seam composes
  // sessionStatsFactsOf(computeStats(log)) — the same shape, byte for byte).
  const currentSessionStats = async (scope: never): Promise<unknown> => {
    statsCalls += 1
    const folded = await scopeFacts.currentSessionStats(scope)
    return folded === undefined ? undefined : sessionStatsFactsOf(folded)
  }
  // The official projection read of the exact attachment: the same port call
  // the production Direct sessionReader serves (the projection face over the
  // attachment's own identity facts).
  const sessionReader = {
    measureContext: (sessionId: string): number | undefined => {
      void sessionId
      return undefined
    },
    sessionStatus: (sessionId: string): unknown =>
      liveAgentSlot.agent !== undefined && liveAgentSlot.agent.session.id === sessionId
        ? {
            sessionId,
            title: 'proof session',
            cwd: liveAgentSlot.agent.session.header.cwd,
            context: options.contextValue === undefined ? undefined : { contextWindow: 128_000 },
          }
        : undefined,
    sessionStatusFailed: () => false,
  }


  // The REAL coordinator + force semantics (the StatusRuntime force path,
  // reduced to its own dependencies): bind/markDirty/measure through the
  // counting reader — the classification the About view receives.
  const coordinator = new ContextMeasurementCoordinator()
  const measureReader = (sessionId: string): number | undefined => {
    contextCalls += 1
    return sessionId === '' ? undefined : options.contextValue
  }
  const forceResult = (): { readonly value: number | undefined; readonly observation: 'fresh' | 'last-known' | 'unavailable' } => {
    const sessionId = scopeObject?.sessionId
    if (sessionId === undefined) return { value: undefined, observation: 'unavailable' }
    coordinator.bind(sessionId)
    coordinator.markDirty()
    return coordinator.measureResult(sessionId, measureReader)
  }

  const base: Record<string, unknown> = {
    ctx,
    app,
    diag,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: () => ownershipCore.currentSessionId(),
    // THE OFFICIAL DIRECT AUTHORITY: the scope capture/currentness ride the
    // production SessionScopeAuthority (sessionScopeFacts wires the REAL
    // owner+generation authority over the live agent slot), and
    // `currentSessionStats` is the PRODUCTION fold — computeStats over the
    // exact attachment's whole snapshot log, grouped by the bootstrap's own
    // sessionStatsFactsOf. No test-composed stats anywhere.
    ...sessionScopeFacts(() => liveAgentSlot.agent, () => ownershipCore.generation()),
    currentSessionStats,
    captureLiveSessionScope: () => ownershipCore.captureLiveSessionScope(),
    isSessionScopeCurrent: (scope: never) => ownershipCore.isSessionScopeCurrent(scope),
    sessionReader,
    forceContextMeasurement: () => forceResult().value,
    forceContextMeasurementResult: forceResult,
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: (listener: () => void) => {
      fireInvalidation = listener
      return () => {}
    },
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: (preset: string) => ({ kind: 'unchanged', preset }),
    refreshStatus: () => {},
    copyToClipboard: async () => true,
    tuiSettings: {
      get: () => ({
        notificationMode: 'always', notificationMethod: 'auto', terminalProgress: '9;4+7501', theme: 'dark',
      }),
      replace: () => {},
    },
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    config: {
      configReadiness: () => 'ready',
      visualTools: {
        read: () => ({ enabled: true, revision: 1, userOverridden: false, applied: true }),
        setEnabled: async (_enabled: boolean, _revision: number) => {},
      },
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false, recordsSupported: () => false },
      providers: { available: () => false },
      authorization: { available: () => false },
      account: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings'): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return {
    copied,
    invoke,
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    pressKey: async (data: string) => {
      vt.sendInput(data)
      await vt.waitForRender()
    },
    click: async (row, col) => {
      vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
      vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
      await vt.waitForRender()
    },
    waitForFrame: async (predicate, label) => {
      const current = (): string => vt.getViewport().map(stripTerminalSequences).join('\n')
      for (let at = 0; at < 25; at += 1) {
        if (predicate(current())) return
        await vt.waitForRender()
      }
      assert.ok(predicate(current()), `the frame never settled: ${label}\n${current()}`)
    },
    statsCalls: () => statsCalls,
    contextCalls: () => contextCalls,
    fireStatusInvalidation: () => fireInvalidation(),
    switchSession: (id) => {
      scopeObject = id === undefined ? undefined : { sessionId: id, generation: (scopeObject?.generation ?? 0) + 1 }
      // THE PRODUCTION SWAP: a different session is a DIFFERENT attachment —
      // a fresh empty log (its own official fold reads turns 0).
      const fresh = fakeSession({
        id: id ?? 'no-session',
        header: { id: id ?? 'no-session', cwd: '/ws/proof', createdAt: 0, version: 1 },
        events: [],
      })
      liveAgentSlot.agent = id === undefined ? undefined : fakeAgent(fresh)
      ownershipCore._sessionId = id
      ownershipCore._generation += 1
      recaptureScope()
    },
    dispose: () => { app.dispose() },
  }
}

test('PROOF 1 (Direct): live session official facts → real panel → C copies the exact payload', async () => {
  const h = setupProof({
    session: 'proof-sess-1',
    stats: { turns: 7, llmMs: 91_500, tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, cacheHitPct: 23.1 } },
    contextValue: 64_000,
  })
  try {
    h.invoke()
    await h.waitForFrame(frame => /Turns/.test(frame), 'the ready About frame with the lifetime facts')
    const frame = h.view()
    assert.match(frame, /Session ID/, 'the identity fact paints')
    assert.match(frame, /Turns/, 'the lifetime facts paint')
    assert.match(frame, /Fresh/, 'the fresh context observation paints')
    // `C` = Copy All: the exact payload through the real clipboard sink.
    await h.pressKey('C')
    assert.equal(h.copied.length, 1, 'exactly one clipboard leg')
    const report = h.copied[0]!
    const lines = report.split('\n')
    assert.equal(lines[0], 'dsh-pi-tui Status')
    assert.ok(lines.includes('Session ID: proof-sess-1'))
    assert.ok(lines.includes('Title: proof session'))
    // The OFFICIAL fold's values: one seeded completed turn.
    assert.ok(lines.includes('Turns: 1'), `the official lifetime: ${lines.filter(l => l.startsWith('Turns'))}`)
    assert.ok(lines.includes('Steps: 1'))
    assert.ok(lines.some(line => /^LLM wall: \d+s \(\d+ ms\)$/.test(line)), `the LLM wall pair: ${lines.filter(l => l.startsWith('LLM'))}`)
    assert.ok(lines.includes('Input tokens: 1000'), 'the official usage input rides the payload')
    assert.ok(lines.includes('Output tokens: 200'))
    assert.ok(lines.includes('Cache read tokens: 300'))
    assert.ok(lines.includes('Used tokens: 64000'))
    assert.ok(lines.includes('Observation: Fresh'))
    assert.ok(!report.includes('🐋'), 'the whale is never serialized')
  } finally {
    h.dispose()
  }
})

test('PROOF 4 (sessionless): /settings first frame never reads, versions copy works', async () => {
  const h = setupProof({
    session: undefined,
    stats: { turns: 0, llmMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 } },
  })
  try {
    h.invoke()
    await h.waitForFrame(frame => /No active session/u.test(frame), 'the sessionless first frame')
    assert.equal(h.statsCalls(), 0, 'a sessionless open performs ZERO stats reads')
    assert.equal(h.contextCalls(), 0, 'a sessionless open performs ZERO context forces')
    const frame = h.view()
    assert.match(frame, /No active session/u, 'the sessionless state word paints')
    assert.match(frame, /TUI/, 'the runtime facts paint')
    await h.pressKey('C')
    const report = h.copied[0] ?? ''
    assert.match(report, /Session ID: No active session/u)
    assert.ok(!report.includes('Turns:'), 'sessionless omits the detail groups')
  } finally {
    h.dispose()
  }
})

test('NEGATIVE: a copy after the Session swap cannot copy A — including DURING the pending read', async () => {
  const h = setupProof({
    session: 'sess-3',
    stats: { turns: 11, llmMs: 5_000, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 } },
    contextValue: 1_000,
  })
  try {
    h.invoke()
    // A = sess-3: id-derived lifetime figures 11+3 = 14 turns.
    // A = sess-3: the seeded turn's OFFICIAL fold (turns 1).
    await h.waitForFrame(frame => /Turns  +1\b/.test(frame), 'the A ready frame')
    // The PENDING-swap negative: copy DURING B's window (before the B read
    // settles) — the revoked view must refuse, never emit A.
    h.switchSession('sess-9')
    h.fireStatusInvalidation()
    // The revoked frame names B at once (the synchronous revocation); the
    // Loading row may be replaced by B's ready frame within one paint tick,
    // so the assertion waits only for the SUBJECT swap, then copies.
    await h.waitForFrame(frame => /sess-9/.test(frame), 'the B frame after the revocation')
    await h.pressKey('C')
    assert.ok(!h.copied.some(report => report.includes('sess-3')), 'a pending-swap copy never emits A')
    // B = sess-9: a FRESH session — its official fold is the EMPTY log
    // (turns 0), distinguishable from A's seeded turn (turns 1).
    await h.waitForFrame(frame => /Turns  +0\b/.test(frame), 'the B ready frame with ITS OWN figures')
    await h.pressKey('C')
    const report = h.copied.at(-1) ?? ''
    assert.match(report, /Session ID: sess-9/u, 'the copy rides the NEW subject')
    assert.ok(!report.includes('sess-3'), 'A never leaks into the payload')
    assert.match(report, /Turns: 0/u, 'B shows its OWN official fold (the empty fresh log)')
    assert.ok(!/Turns: 1\n/.test(report), 'A lifetime figures never survive the swap')
    assert.equal(h.statsCalls(), 2, 'A entry + B re-read: exactly one read per subject')
  } finally {
    h.dispose()
  }
})

test('NEGATIVE: the About `r` forces the context exactly once and never twice per press', async () => {
  const h = setupProof({
    session: 'sess-r',
    stats: { turns: 1, llmMs: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 } },
    contextValue: 2_000,
  })
  try {
    h.invoke()
    await h.waitForFrame(frame => /Turns/.test(frame), 'the ready frame before r')
    const afterEntry = h.contextCalls()
    assert.ok(afterEntry >= 1, 'the entry force ran')
    // Focus the content and press r once.
    await h.pressKey('\r')
    await h.pressKey('r')
    await h.waitForFrame(
      frame => /Turns/.test(frame),
      'the frame settles after r (the frame already matched; the wait drains the read)',
    )
    assert.equal(h.contextCalls(), afterEntry + 1, 'ONE explicit force per refresh press')
  } finally {
    h.dispose()
  }
})

test('NEGATIVE→POSITIVE: the action row paints Refresh AND Copy All as two independently clickable targets', async () => {
  const h = setupProof({
    session: 'sess-click',
    stats: { turns: 2, llmMs: 500, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 } },
    contextValue: 3_000,
  })
  try {
    h.invoke()
    await h.waitForFrame(frame => /Turns/.test(frame), 'the live About frame')
    // Locate the action row and BOTH painted buttons.
    const rows = h.view().split('\n')
    const actionRowIndex = rows.findIndex(line => line.includes('Copy All ['))
    assert.ok(actionRowIndex !== -1, `the action row paints on a live session:\n${h.view()}`)
    const actionRow = rows[actionRowIndex]!
    const refreshCol = actionRow.indexOf('Refresh context [')
    const copyAllCol = actionRow.indexOf('Copy All [')
    assert.ok(refreshCol !== -1 && copyAllCol !== -1 && copyAllCol > refreshCol,
      `both buttons paint side by side: ${JSON.stringify(actionRow)}`)
    const contextBefore = h.contextCalls()
    // Click 1: Copy All — the clipboard gets the report, no refresh.
    await h.click(actionRowIndex, copyAllCol + 2)
    assert.equal(h.copied.length, 1, 'the Copy All button copied through the real sink')
    assert.match(h.copied[0]!, /dsh-pi-tui Status/u)
    assert.equal(h.contextCalls(), contextBefore, 'the Copy All click never refreshed')
    // Click 2: Refresh on the SAME row, DIFFERENT cells — one force, no copy.
    await h.click(actionRowIndex, refreshCol + 2)
    assert.equal(h.copied.length, 1, 'the Refresh click never copied')
    assert.equal(h.contextCalls(), contextBefore + 1, 'the Refresh click forced exactly once')
    // A genuinely BLANK cell (far right of the action row, past both
    // buttons) is inert: no copy, no refresh.
    await h.click(actionRowIndex, copyAllCol + 40)
    assert.equal(h.copied.length, 1, 'a blank-cell click never copies')
    assert.equal(h.contextCalls(), contextBefore + 1, 'a blank-cell click never refreshes')
  } finally {
    h.dispose()
  }
})
