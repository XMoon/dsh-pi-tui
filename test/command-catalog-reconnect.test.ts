/**
 * M3-6 PR2 §14.2 supporting CommandSurface owner tests (CCR-1..CCR-8):
 * the Remote Connection-generation invalidation subscription the command
 * catalog owner installs — the last-good Host claim policy across a
 * disconnect, the automatic same-Session refresh on a new defined
 * generation, the current-session-id read at callback execution time, the
 * coordinator's supersession when generation C replaces an in-flight B
 * refresh, and the disposal fence. NOT labelled L1–L6: this is the
 * owner/component level; the mounted source→decision→sink proof lives in
 * `runner-remote-command-plane.test.ts` and the adapter delegation proof in
 * `remote-command-source.test.ts`.
 *
 * The suite drives the REAL `createCommandSurface` + the REAL
 * `CatalogRefreshCoordinator` install path (`register()` →
 * `registerTuiCommands` → `installSurfaceSnapshot`), with:
 * - a controlled Remote command source double (the official generation
 *   observable + the catalog reads it would have issued);
 * - a sessionless-safe fake TuiCommandRunner (the busy-enter harness shape:
 *   registration itself never needs a live session);
 * - the Direct negative control (CCR-8) over the same harness with
 *   `remoteCommandSource === undefined`.
 * @module @xmoon76/dsh-pi-tui/command-catalog-reconnect.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { createCommandSurface } from '../src/app/command/surface.ts'
import type { RemoteCommandSourceFace } from '../src/app/application-runtime.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { TuiCommandRunner, TuiSettingsLike } from '../src/commands.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { DraftImageStore } from '../src/client/media/image/draft-store.ts'
import type { ModelSelectionValue } from '../src/domain/session/model-selection.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The official generation token shape (identity compared with Object.is). */
interface GenerationToken { readonly id: number }

/** One catalog read the Remote command source double issued. */
interface CatalogRead { readonly sessionId: string }

/**
 * The controlled Remote command source double: the official generation
 * observable (getSnapshot/subscribe with the REAL synchronous-notify option)
 * plus a catalog-read recorder whose settled snapshots the test scripts.
 * Each scripted entry is either a snapshot array, `undefined` (a transport
 * supersession), a rejection, or an async resolver ({defer: true}) the test
 * settles later.
 */
function controlledRemoteSource(options: {
  /** Notify the listener SYNCHRONOUSLY at subscription time (the rc.2 shape). */
  readonly synchronousSubscriptionNotify?: boolean
  /** Make the official generation unsubscribe throw AFTER doing its real
   *  release (the M3-6 PR3 partial-disposer fault injection). */
  readonly unsubscribeFailure?: Error
}) {
  const generationA = { id: 1 } satisfies GenerationToken
  const generationB = { id: 2 } satisfies GenerationToken
  const generationC = { id: 3 } satisfies GenerationToken
  let snapshot: GenerationToken | undefined = generationA
  let unsubscribed = 0
  let listeners: Array<() => void> = []
  const reads: CatalogRead[] = []
  /** One scripted read: a settled name list, a rejection, or a held gate the
   * test releases with `releaseRead` (the stale-read scenarios). */
  type Scripted =
    | { readonly kind: 'settle'; readonly names: readonly string[] }
    | { readonly kind: 'reject'; readonly error: Error }
    | { readonly kind: 'hold'; readonly release: (names: readonly string[]) => void; readonly gate: Promise<readonly string[]> }
  let scripted: readonly Scripted[] = []
  let readOrdinal = 0
  const holds = new Map<number, Scripted & { kind: 'hold' }>()
  const source: RemoteCommandSourceFace & {
    readonly tokens: { readonly a: GenerationToken; readonly b: GenerationToken; readonly c: GenerationToken }
    readonly reads: readonly CatalogRead[]
    /** Script the NEXT reads (in order): a name list, an Error (rejection),
     * or 'hold' (the read waits until the test releases it). */
    script(next: ReadonlyArray<readonly string[] | Error | 'hold'>): void
    /** Release one held read with the names it settles with. */
    releaseRead(ordinal: number, names: readonly string[]): void
    replace(next: GenerationToken | undefined): void
    readonly unsubscribedCount: () => number
    readonly listenerCount: () => number
  } = {
    tokens: { a: generationA, b: generationB, c: generationC },
    reads,
    script: (next) => {
      scripted = next.map(entry => {
        if (entry instanceof Error) return { kind: 'reject', error: entry } as Scripted
        if (entry === 'hold') {
          let release: (names: readonly string[]) => void = () => {}
          const gate = new Promise<readonly string[]>(resolve => { release = resolve })
          return { kind: 'hold', release, gate } as Scripted
        }
        return { kind: 'settle', names: entry } as Scripted
      })
      readOrdinal = 0
    },
    releaseRead: (ordinal, names) => { holds.get(ordinal)?.release(names) },
    unsubscribedCount: () => unsubscribed,
    listenerCount: () => listeners.length,
    replace: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    read: async (sessionId: string) => {
      reads.push({ sessionId })
      const ordinal = readOrdinal
      readOrdinal += 1
      const plan = scripted[ordinal]
      if (plan === undefined) return { commands: Object.freeze([]), skills: Object.freeze([]) } as never
      if (plan.kind === 'reject') throw plan.error
      const names = plan.kind === 'hold' ? await plan.gate : plan.names
      return { commands: Object.freeze(names.map(name => Object.freeze({ name, description: name }))), skills: Object.freeze([]) } as never
    },
    readCommands: async (sessionId: string) => {
      reads.push({ sessionId })
      const ordinal = readOrdinal
      readOrdinal += 1
      const plan = scripted[ordinal]
      if (plan === undefined) return []
      if (plan.kind === 'reject') throw plan.error
      const names = plan.kind === 'hold' ? await plan.gate : plan.names
      return names.map(name => ({ name, description: name }))
    },
    captureTransportToken: (sessionId: string): unknown => ({ generation: snapshot, binding: `binding:${sessionId}` }),
    isTransportTokenCurrent: (sessionId: string, token: unknown): boolean => {
      const captured = token as { generation?: unknown; binding?: unknown } | undefined
      if (captured === undefined || typeof captured !== 'object') return false
      if (!Object.is(captured.generation, snapshot)) return false
      return captured.binding === `binding:${sessionId}`
    },
    connectionGeneration: () => snapshot,
    subscribeConnectionGeneration: (listener: () => void): (() => void) => {
      listeners.push(listener)
      if (options.synchronousSubscriptionNotify === true) listener()
      return () => {
        unsubscribed += 1
        listeners = listeners.filter(entry => entry !== listener)
        if (options.unsubscribeFailure !== undefined) throw options.unsubscribeFailure
      }
    },
  }
  // Track the held reads so releaseRead reaches the read currently waiting.
  const trackHolds = (): void => {
    for (let index = 0; index < scripted.length; index += 1) {
      const plan = scripted[index]
      if (plan !== undefined && plan.kind === 'hold') holds.set(index, plan)
    }
  }
  const baseScript = source.script
  source.script = (next: ReadonlyArray<readonly string[] | Error | 'hold'>): void => {
    baseScript(next)
    holds.clear()
    trackHolds()
  }
  return source
}

/** One harness's app disposal + the process-slot sweep (the vendored fork's
 * keybindings are process-global: only the FINAL dispose releases the slot,
 * so every test must dispose its app; a disposed app is skipped). */
const startedApps = new Set<TuiApp>()
test.afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch { /* the sweep never blocks a test */ }
  }
})

/** The no-op diag the owner tests use (assertions read the recorder state). */
const silentDiag = createDiag({ filePath: undefined, stderrLevel: 'off' })

/**
 * The sessionless-safe fake runner (the busy-enter harness shape): the
 * registration pass and the coordinator install path need no live session.
 * `currentSessionId` is a live getter over the harness's mutable state so the
 * owner's callback-time session read is observable (CCR-6).
 */
function fakeRunnerDeps(options: {
  readonly remoteSource?: RemoteCommandSourceFace
  readonly currentSessionId: () => string | undefined
}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  app.start()
  const tuiSettings: TuiSettingsLike = {
    get: () => ({ theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', history: {} }) as never,
    replace: () => undefined,
  }
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: silentDiag,
    ...sessionScopeFacts(() => undefined, () => 0),
    get currentSessionId() { return options.currentSessionId() },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } as never },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    defaultIntentOutcome: undefined,
    settleIntent: () => {},
    tuiSettings,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined, sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    // The Remote branch shape: no Host registry mirror (Client-only view).
    commandRegistry: undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: false,
    transcriptExportAvailable: false,
    interaction: {
      questions: {
        onRequest: () => true, subscribe: () => undefined, snapshot: () => undefined,
        claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {}, setApprovalPolicy: () => true,
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  const scopeFacts = sessionScopeFacts(() => undefined, () => 0)
  const surface = createCommandSurface<ModelSelectionValue, string, never>({
    ctx,
    logError: () => {},
    diag: silentDiag,
    signal: new AbortController().signal,
    app: () => app,
    liveAgent: () => undefined,
    sessionScope: {
      capture: () => scopeFacts.captureSessionScope(),
      captureLive: () => undefined,
      isCurrent: scope => scopeFacts.isSessionScopeCurrent(scope as never),
    },
    ownership: {
      generation: () => 0,
      currentSessionId: () => options.currentSessionId(),
    },
    transition: { pending: () => false, run: async (task) => task() },
    commandsRegistry: () => undefined,
    clientCommands: runner.clientCommands,
    ...(options.remoteSource === undefined ? {} : {
      remoteCommandSource: options.remoteSource,
      remoteFacts: {
        running: () => undefined,
        sessionStatus: () => undefined,
      },
    }),
    direct: {
      listScopedCommands: () => [],
      sessionStats: async () => undefined,
      lastAssistantText: async () => undefined,
      promptAdmission: async (_agent, _hasImages, task) => task(),
    },
    directCatalog: {
      readSurfaceCatalog: async () => ({ commands: [], scopedCommands: [], skills: [], issues: [] }),
      listGlobalCommands: () => [],
    },
    catalog: runner.catalog as never,
    toCatalogAgent: (agent) => agent as never,
    presets: {
      launch: undefined,
      pending: () => undefined,
      setPending: () => {},
      current: () => undefined,
      blank: () => undefined,
    },
    clientCwd: '/ws',
    surface: {
      setNotificationMode: () => {},
      setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
      openJobView: () => {},
      openTasksBrowser: () => {},
    },
    backend: {
      kind: options.remoteSource === undefined ? 'direct' : 'remote',
      sessionReader: runner.sessionReader,
      sessionWriter: runner.sessionWriter,
      interaction: runner.interaction,
      catalog: runner.catalog,
      config: runner.config,
      hostFile: runner.hostFile,
      hostShellCompletion: false,
      transcriptExportAvailable: false,
    },
    session: {
      ensureSession: () => runner.ensureSession(),
      withWriter: async (_scope, task) => task(),
      switchSession: async () => undefined,
      forkSession: async () => ({ kind: 'committed', value: undefined }) as never,
      transitionTo: runner.transitionTo,
    },
    status: {
      forceContextMeasurement: () => undefined,
      sessionCwd: () => '/ws',
      refresh: () => {},
      updateWelcomeCard: () => {},
    },
    settings: {
      applyFooterSettings: () => {},
      setDisplayPreset: () => ({ applied: true }) as never,
    },
    model: {
      selected: runner.selected,
      defaultIntent: { intent: undefined, record: undefined, outcome: undefined },
      currentDefault: () => undefined,
      setPending: () => {},
      reconcileDefaultIntent: () => {},
      setDefaultIntent: () => {},
      settleIntent: () => {},
      awaitPendingDefaultWrite: async () => {},
      trackDefaultWrite: () => {},
    } as never,
    viewer: { enterView: async () => {} },
    drafts: {
      images: runner.imageStore,
      files: { pin: () => {}, unpin: () => {}, clearUnpinned: () => {}, attach: () => {} } as never,
    },
    extensions: {
      current: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    pluginManager: {
      open: () => {},
      submenu: () => ({ render: () => [], invalidate: () => {} }) as never,
    },
    client: {
      runCopyCommand: undefined as never,
      copyEnv: undefined as never,
    },
    submission: {
      prepareDeps: () => ({}) as never,
      settleQueueRecalls: () => {},
    },
    promptState: {
      progressUpdates: runner.progressUpdatesState,
      responseStyle: runner.responseStyleState,
      gitAttribution: runner.gitAttributionState,
    },
    tuiSettings,
    displayState: { preset: 'full' } as never,
    agents: runner.agents,
    imageLimits: runner.imageLimits,
    openRewindPicker: () => {},
    requestExit: () => {},
    exit: () => {},
  })
  return {
    surface,
    runner,
    app,
    /** Register the TUI commands (building the runner facade first). */
    register: () => {
      surface.buildRunner(runner as never)
      surface.register()
    },
    dispose: () => {
      surface.disposeCatalog()
      startedApps.delete(app)
      if (!app.isDisposed()) {
        try { app.dispose() } catch { /* the afterEach sweep is idempotent */ }
      }
    },
  }
}

/* ── CCR-1 ────────────────────────────────────────────────────────────── */

test('CCR-1: a synchronous subscription-time generation notification is NOT a duplicate startup refresh', () => {
  // The rc.2 observable may notify the CURRENT token synchronously at
  // subscription time. Capture-before-subscribe + Object.is(token) identity
  // makes that immediate callback a no-op: zero catalog reads (§6 Must 3).
  const source = controlledRemoteSource({ synchronousSubscriptionNotify: true })
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    // The subscription exists and observed token A …
    assert.equal(source.listenerCount(), 1, 'the generation subscription is installed')
    // … but NO reconnect-owned catalog read was issued.
    assert.deepEqual(source.reads, [],
      'a synchronous current-token notification must not trigger a catalog read')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-2 ────────────────────────────────────────────────────────────── */

test('CCR-2: disconnect (A -> undefined) reads nothing, clears nothing, and keeps the Host-origin claim reserved', async () => {
  const source = controlledRemoteSource({})
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    // Install a REAL Host catalog through the coordinator's own path.
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' })?.claimed, true,
      'the installed Host command claims the name before the disconnect')

    // A -> undefined: no read, no clear, no Client same-name takeover.
    const clientRegistry = harness.runner.clientCommands
    clientRegistry.register({
      name: 'host-a',
      description: 'client twin',
      handler: () => ({ kind: 'success' as const }),
    })
    source.replace(undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(source.reads.map(read => read.sessionId), ['session-a'],
      'the disconnect issued NO new catalog read')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' })?.claimed, true,
      'the last-good Host-origin claim survives the disconnect')
    assert.equal(harness.surface.hostCatalogResolves('host-a'), true,
      'the reserved Host name cannot be taken over by the Client twin while disconnected')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-3 ────────────────────────────────────────────────────────────── */

test('CCR-3: a new defined generation B refreshes automatically without /reload and replaces the Host truth', async () => {
  const source = controlledRemoteSource({})
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' })?.claimed, true)

    // undefined -> B: exactly ONE reconnect-owned refresh against the
    // CURRENT session id, returning a B catalog that retires host-a and
    // adds host-b.
    source.script([['host-b']])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(source.reads.map(read => read.sessionId), ['session-a', 'session-a'],
      'exactly one reconnect-owned read against the current session id')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' }), undefined,
      'the retired A-only Host command is absent after the successful B commit')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-b' })?.claimed, true,
      'the new B Host command is authoritative after the commit')
    assert.equal(harness.surface.hostCatalogResolves('host-a'), false,
      'the completion/claim state reflects B, not the A residue')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-4 ────────────────────────────────────────────────────────────── */

test('CCR-4: a FAILED new-generation read keeps the last-good Host claims (no blank success, no Client takeover)', async () => {
  const source = controlledRemoteSource({})
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')

    // B is defined but the command provider FAILS (a rejected read — the
    // coordinator routes it to `failed`, and the last-good field survives).
    source.script([new Error('commands/list exploded')])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' })?.claimed, true,
      'the last-good Host command authority remains after the failed B read')
    assert.equal(harness.surface.hostCatalogResolves('host-a'), true,
      'no blank/empty catalog replaced the last-good Host truth')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-5 ────────────────────────────────────────────────────────────── */

test('CCR-5: generation C supersedes an in-flight B refresh through the existing coordinator fences', async () => {
  const source = controlledRemoteSource({})
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')

    // The B refresh (read #1) is HELD; generation C appears while B is still
    // in flight, then the C refresh (read #2) settles immediately with
    // host-c. Only C may install (D6).
    source.script(['hold', ['host-c']])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 50))
    source.replace(undefined)
    source.replace(source.tokens.c)
    await new Promise(resolve => setTimeout(resolve, 150))
    // Release the held B read LATE with a snapshot only B would install.
    source.releaseRead(0, ['host-b'])
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-c' })?.claimed, true,
      'the C snapshot is the installed current catalog')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-b' }), undefined,
      'the superseded B snapshot never installed')
  } finally {
    source.releaseRead(0, [])
    harness.dispose()
  }
})

/* ── CCR-6 ────────────────────────────────────────────────────────────── */

test('CCR-6: the reconnect callback reads the CURRENT session id at execution time, never a startup-captured id', async () => {
  const source = controlledRemoteSource({})
  let currentSession: string | undefined = 'session-a'
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => currentSession,
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')
    // The application owner moves to Session B BEFORE the reconnect
    // callback performs its read.
    currentSession = 'session-b'
    source.script([['host-b']])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(source.reads.map(read => read.sessionId), ['session-a', 'session-b'],
      'the reconnect refresh addressed the CURRENT session (B), never the startup-captured A')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-7 ────────────────────────────────────────────────────────────── */

test('CCR-7: disposeCatalog unsubscribes the generation listener exactly once and no post-dispose refresh starts', async () => {
  const source = controlledRemoteSource({})
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')
    const readsBefore = source.reads.length
    harness.surface.disposeCatalog()
    assert.equal(source.unsubscribedCount(), 1,
      'the official unsubscribe ran exactly once')
    assert.equal(source.listenerCount(), 0,
      'no generation listener remains after catalog disposal')
    // A post-dispose generation change must start nothing.
    source.script([['host-z']])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(source.reads.length, readsBefore,
      'no read started after the catalog was disposed')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-8 ────────────────────────────────────────────────────────────── */

test('CCR-8 (Direct negative control): no generation subscription exists on the Direct branch', () => {
  const harness = fakeRunnerDeps({
    remoteSource: undefined,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    // The Direct surface refresh still works through its own path (the
    // standing/preset target), and NOTHING subscribed to any generation.
    // The strongest available proof over this harness: registration
    // succeeded and the catalog refresh entrypoints remain usable.
    assert.equal(harness.surface.catalogRefreshAvailable(), true,
      'the Direct catalog coordinator is registered and usable')
  } finally {
    harness.dispose()
  }
})

/* ── CCR-9 (M3-6 PR3) ─────────────────────────────────────────────────── */

test('CCR-9: a throwing official generation unsubscribe still disposes the coordinator and retires the refresh path', async () => {
  const unsubscribeFailure = new Error('generation unsubscribe failed')
  const source = controlledRemoteSource({ unsubscribeFailure })
  const harness = fakeRunnerDeps({
    remoteSource: source,
    currentSessionId: () => 'session-a',
  })
  try {
    harness.register()
    source.script([['host-a']])
    await harness.surface.refreshLiveCatalogById('session-a')
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-a' })?.claimed, true)

    // Leave one refresh IN FLIGHT (a held read), then dispose the catalog with
    // a throwing official unsubscribe. The coordinator disposal must still run
    // and abort the active refresh, so the held read can never install.
    source.script(['hold'])
    const inFlight = harness.surface.refreshLiveCatalogById('session-a')
    await new Promise(resolve => setTimeout(resolve, 30))
    const readsBeforeDispose = source.reads.length

    assert.throws(() => harness.surface.disposeCatalog(), (error: unknown) => error === unsubscribeFailure)
    assert.equal(source.unsubscribedCount(), 1, 'the official unsubscribe ran exactly once before throwing')
    assert.equal(harness.surface.catalogRefreshAvailable(), false,
      'the refresh request is retired despite the unsubscribe failure')

    // The coordinator WAS disposed: releasing the held read cannot install.
    source.releaseRead(0, ['host-z'])
    await inFlight
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(harness.surface.hostOriginClaimOf({ name: 'host-z' }), undefined,
      'the aborted refresh could not install its late snapshot')

    // No later generation callback can start a read through this surface.
    source.script([['host-b']])
    source.replace(undefined)
    source.replace(source.tokens.b)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(source.reads.length, readsBeforeDispose,
      'no read started after the catalog was disposed')

    // A second disposal is inert: no rethrow, no second unsubscribe.
    harness.surface.disposeCatalog()
    assert.equal(source.unsubscribedCount(), 1)
  } finally {
    source.releaseRead(0, [])
    harness.dispose()
  }
})
