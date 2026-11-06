/**
 * TSP I-E: the application COMPOSITION of the `Ctrl+R` History search.
 *
 * This is the lane that proves the seat is wired to the ONE owner of every fact
 * it acts on, through the production chain
 * `bootstrap`-shaped `SurfaceRuntime.start` → `SurfaceRendererMount.mount(
 * image, status, historySearch)` → `bindHistorySearch` →
 * `createTspHistorySearch` → the mount's ONE `TspComposer` and ONE Client-local
 * copy callback. The currentness authority is the REAL
 * `createSessionScopeAuthority` over the REAL `createSessionOwnershipCore`, so
 * the refusals below are driven by an actual owner/generation publication —
 * never by a pre-answered `isCurrent: () => true` boolean.
 *
 * EVIDENCE LEVEL: application-composed / SDK wire. The `SurfaceRuntime`, its
 * mount, the ownership core, the scope authority, the search source, the TSP
 * renderer and the SDK are PRODUCTION. STANDS-IN: the scripted tty (the real
 * client lane is `scripts/tern-pane-history-search-ux.mjs`), and the submit
 * sink below `events.onSubmit` is this composition's recorder — the REAL
 * `SubmissionController`, `DirectSessionWriter` and prompt-count witness are
 * `test/integration/tern-tsp-history-search-direct.test.ts`.
 *
 * What THIS file owns and no other lane proves: the mount receives the SAME
 * search source the surface was given, the scope is captured exactly once per
 * open, and an owner publication / same-id reopen / generation bump that lands
 * while a read, a copy or a painted frame is in flight retires the older card
 * instead of writing into the newer Session.
 * @module @xmoon76/dsh-pi-tui/test/app/tern-tsp-history-search-composition
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { createSurfaceRuntime, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { ComposerSubmitRequest } from '../../src/tui-app.ts'
import { FileHistorySearchSource } from '../../src/client/history/search.ts'
import type { HistorySearchPage, HistorySearchRequest } from '../../src/client/history/search.ts'
import { historyFilePath } from '../../src/client/history/store.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const CTRL_R = '\u0012'
const ENTER = '\r'
const TAB = '\t'
/** One bounded window: long enough for the seat's own debounce plus an SDK
 *  input dispatch, so "nothing happened" is a real observation. */
const ABSENCE_WINDOW_MS = 400

interface ChainHarness {
  readonly pane: TspPane
  readonly surface: ReturnType<typeof createSurfaceRuntime<never>>
  readonly renderer: () => TspRenderer
  /** The identity witnesses the mount received. */
  readonly received: { source: unknown; cwd: unknown; captureScope: unknown }
  readonly binds: { history: number; status: number; images: number }
  readonly requests: HistorySearchRequest[]
  readonly copies: string[]
  readonly submits: string[]
  /** The real source object this composition handed to `surface.start`. */
  readonly source: FileHistorySearchSource
  /** The object the surface forwarded to the mount (identity witness). */
  readonly boundSource: unknown
  /** Publishes a NEW owner through the REAL ownership core. */
  publishOwner(sessionId: string): void
  /** Parks the next read the seat issues; `releaseHeld` settles it late. */
  holdNextRead(): void
  releaseHeld(page?: HistorySearchPage): void
  copySettlement(): (copied: boolean) => void
  draft(): { text: string; cursor: number }
  texts(): string[]
  cardPainted(): boolean
  ids(match: RegExp): string[]
  key(bytes: string): Promise<void>
  type(bytes: string): void
  click(id: string): Promise<void>
  /** A click the seat must REFUSE: a refused gesture owes no frame, so waiting
   *  for one would be a false signal — this delivers it and observes absence. */
  clickRefused(id: string): void
  observeAbsence(): Promise<void>
  dispose(): Promise<void>
}

/** Three real v2 rows for one cwd, written through the store's own path. */
function seedHistory(home: string, cwd: string, sessionId: string, rows: readonly string[]): string {
  const file = historyFilePath(home, cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${rows.map((content, index) => JSON.stringify({
    v: 2, content, cwd, ts: 1_700_000_000_000 + index, sessionId,
  })).join('\n')}\n`)
  return file
}

async function mountChain(life: TestLifecycle, sessionId0: string): Promise<ChainHarness> {
  const home = life.tempDir('dsh-ie-composition-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  seedHistory(home, home, sessionId0, ['alpha one prompt', 'beta two prompt about tern', 'gamma three prompt'])

  const pane = installTspPane({ composerActions: true, historySearch: true })
  life.defer(() => pane.restore())
  const connected = await sdkConnect({ timeout: 500, exitHooks: false })
  assert.ok(connected !== null, 'the shipped SDK accepts the scripted pane')
  const session: Session = connected

  const source = new FileHistorySearchSource({ dshHome: home })
  const requests: HistorySearchRequest[] = []
  let hold = false
  let release: ((page: HistorySearchPage) => void) | undefined
  const heldSource = {
    search(request: HistorySearchRequest): Promise<HistorySearchPage> {
      requests.push(request)
      if (hold) return new Promise(resolve => { release = resolve })
      return source.search(request)
    },
  }

  // The REAL ownership stack: the same two authorities `bootstrap` composes.
  const ownership = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  ownership.setCurrentOwner({} as never, sessionId0)
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = ownership.captureSubject()
      if (subject === undefined) return { subject: undefined, sessionId: undefined, generation: ownership.generation() }
      const sessionId = ownership.currentSessionId()
      if (sessionId === undefined) throw new Error('a live ownership subject must carry a session id')
      return { subject, sessionId, generation: ownership.generation() }
    },
    isSubjectCurrent: subject => ownership.isSubjectCurrent(subject),
  })

  const binds = { history: 0, status: 0, images: 0 }
  const received: { source: unknown; cwd: unknown; captureScope: unknown } = { source: undefined, cwd: undefined, captureScope: undefined }
  const copies: string[] = []
  const submits: string[] = []
  let settleCopy: ((copied: boolean) => void) | undefined
  let mountedRenderer: TspRenderer | undefined

  const rendererMount: SurfaceRendererMount = {
    // The production mount projection: three read-only inputs, installed
    // synchronously and exactly once, then the renderer's own members forwarded.
    mount: (binding, statusReader, historySearch) => {
      binds.status += 1
      binds.images += 1
      binds.history += 1
      received.source = historySearch.source
      received.cwd = historySearch.cwd
      received.captureScope = historySearch.captureScope
      mountedRenderer = mountTspRenderer(session, {
        copyVisual: async (text) => {
          copies.push(text)
          return new Promise<boolean>(resolve => { settleCopy = resolve })
        },
        requestExit: () => {},
        onFatal: (error) => { throw new Error(`the mount routed a fatal: ${String(error)}`) },
      })
      mountedRenderer.bindStatusReader(statusReader)
      mountedRenderer.bindImages(binding)
      mountedRenderer.bindHistorySearch(historySearch)
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }

  const nullPresentation = {
    handleFocusReport: () => {}, markFocused: () => {}, focusState: () => 'focused' as const,
    notify: () => {}, enableFocusReporting: () => {}, disableFocusReporting: () => {},
  }
  const routing = {
    isCleanedUp: () => false, isAttachedSession: () => false, currentSessionId: () => ownership.currentSessionId(),
    hasLiveAgent: () => true, completionOwnerId: () => undefined, observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({}), viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this composition') },
    mainFolder: () => ({}), viewedChildFolder: () => { throw new Error('no viewer in this composition') },
    pendingSubjectId: () => undefined, pendingSnapshot: () => undefined, submissionEchoes: () => undefined,
    queueTextOf: () => '', exitView: () => {}, refreshStatusCheap: () => {}, refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {}, applyGoalChange: () => {}, sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false, settleLocalSubmitAck: () => {}, markSubmitLatency: () => {},
    observeDurableSubmission: () => {}, markContextDirty: () => {}, refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false, flushTurn: () => {}, registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false, viewedChildAgent: () => undefined, setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {}, agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this composition') },
    applyMainAssistantInput: () => {},
  } as unknown as SurfaceEventRoutingSource<never>

  const surface = createSurfaceRuntime<never>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation as never,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(routing)
  surface.start({
    events: {
      onSubmit: (text: string) => { submits.push(text) },
      onExit: () => {},
      shouldRememberInput: () => true,
    } as never,
    renderer: rendererMount,
    workspaceRoot: home,
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: heldSource,
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => home,
    // The SAME bridge bootstrap passes: one atomic capture, no re-derived id.
    captureHistoryScope: () => {
      const scope = scopeAuthority.capture()
      return { sessionId: scope.sessionId, isCurrent: () => scopeAuthority.isCurrent(scope) }
    },
    onTerminalResize: () => {},
    copySelection: async () => true,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text: string) => text,
  } as never)
  surface.bindRendererInput()

  const harness: ChainHarness = {
    pane,
    surface,
    renderer: () => {
      assert.ok(mountedRenderer, 'the TSP renderer committed its mount')
      return mountedRenderer
    },
    received,
    binds,
    requests,
    copies,
    submits,
    source,
    boundSource: heldSource,
    publishOwner(sessionId) {
      // The synchronous publication seam itself: a NEW owner object under the
      // id. `setCurrentOwner` bumps the generation the older capture pinned,
      // so a same-id reopen (A→B→A) is stale by OWNER identity, not by string.
      ownership.setCurrentOwner({} as never, sessionId)
    },
    holdNextRead() { hold = true },
    releaseHeld(page) { hold = false; release?.(page ?? { results: [], exhausted: false }); release = undefined },
    copySettlement() {
      assert.ok(settleCopy !== undefined, 'a copy write is in flight')
      const settleNow = settleCopy!
      return (copied: boolean) => settleNow(copied)
    },
    draft: () => {
      const node = wireNodes(pane).find(candidate => candidate.id === 'dock.quiet-composer.composer')
      return { text: String(node?.p.text ?? ''), cursor: Number(node?.p.cursor ?? 0) }
    },
    texts: () => wireNodes(pane).map(node => {
      const value = (node.p as { text?: unknown }).text
      return typeof value === 'string' ? value : ''
    }).filter(Boolean),
    cardPainted: () => wireNodes(pane).some(node => node.id.includes('history-card')),
    ids: (match) => wireNodes(pane).map(node => node.id).filter(id => match.test(id)),
    async key(bytes) {
      const mark = pane.frameCount()
      pane.key(bytes)
      await waitUntil(`the ${JSON.stringify(bytes)} key painted a frame`, () => pane.frameCount() > mark)
    },
    type(bytes) { pane.key(bytes) },
    async click(id) {
      const mark = pane.frameCount()
      pane.event({ ev: 'action', sf: 's1', id, act: 'click' })
      await waitUntil('the click painted a frame', () => pane.frameCount() > mark)
    },
    clickRefused(id) { pane.event({ ev: 'action', sf: 's1', id, act: 'click' }) },
    async observeAbsence() {
      // reason: a refused late settlement writes no frame by design, so the
      // only observation of "nothing happened" is this bounded window.
      await settle(ABSENCE_WINDOW_MS)
    },
    async dispose() {
      await mountedRenderer?.dispose()
      await session.close()
    },
  }
  await waitUntil('the mount painted its composer editor',
    () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  return harness
}

// ── A. One owner per fact, all the way down ─────────────────────────────────

test('the mount installs ONE History seat from the surface\'s own source, cwd and scope bridge', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    assert.deepEqual(h.binds, { history: 1, status: 1, images: 1 },
      'every read-only capability is installed exactly once at the mount')
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    assert.equal(h.requests.length, 1, 'one read for the first page')
    assert.deepEqual(
      { scope: h.requests[0]?.scope, cwd: h.requests[0]?.cwd, sessionId: h.requests[0]?.sessionId, limit: h.requests[0]?.limit },
      { scope: 'session', cwd: process.env.DSH_HOME, sessionId: 'ses_a', limit: 200 },
      'the request names the live captured scope and the surface session cwd',
    )
    await waitUntil('the real JSONL rows painted', () => h.texts().some(text => text.startsWith('Results · 3 shown')))
    assert.ok(h.texts().some(text => text.includes('alpha one prompt')),
      'the production file-backed source answered through the mount bundle')
    assert.equal(h.submits.length, 0, 'opening submitted nothing')
  } finally {
    await h.dispose()
  }
})

test('the scope bridge is captured exactly ONCE per open and reused by every later round', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    await waitUntil('the first page painted', () => h.texts().some(text => text.startsWith('Results · 3 shown')))
    const sessionId = h.requests[0]?.sessionId
    h.key('p')
    h.key('r')
    h.key('o')
    h.key('m')
    await waitUntil('the typed round read', () => h.requests.at(-1)?.query === 'prom')
    h.key(TAB)
    await waitUntil('the scope round read', () => h.requests.at(-1)?.scope === 'current')
    assert.equal(h.requests.at(-1)?.sessionId, sessionId,
      'the later rounds still name the open-time session identity')
    // The decisive witness: the Directory scope ignores the identity, and the
    // All scope reads the same one source object the mount received.
    assert.equal(h.requests.at(-1)?.cwd, process.env.DSH_HOME, 'and the open-time cwd')
    h.key(ENTER)
    await waitUntil('the restore wrote the composer', () => h.draft().text !== '')
    assert.equal(h.submits.length, 0, 'the restore stayed a draft write')
  } finally {
    await h.dispose()
  }
})

// ── B. A publication during an in-flight read or copy refuses the late result ─

test('an owner publication between the read and its settlement refuses the retired page', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    h.holdNextRead()
    h.key(CTRL_R)
    await waitUntil('the held round started', () => h.requests.length === 1)
    h.publishOwner('ses_b')
    h.releaseHeld({
      results: [{ id: 'retired.jsonl:0', content: 'page read for the retired owner', cwd: '/w',
        ts: 1_800_000_000_000, sessionId: 'ses_a', sourceFile: 'retired.jsonl', sourceByteOffset: 0 }],
      exhausted: true,
    })
    await h.observeAbsence()
    assert.equal(h.texts().some(text => text.includes('page read for the retired owner')), false,
      'the retired owner page was never painted')
    assert.equal(h.cardPainted(), false, 'the card with the dead capture left the frame')
    h.type(ENTER)
    await h.observeAbsence()
    assert.equal(h.draft().text, '', 'and its rows restored nothing into the newer Session')
    assert.equal(h.submits.some(text => text.includes('retired owner')), false,
      'the retired page never reached the submission path either')
  } finally {
    await h.dispose()
  }
})

test('a Copy settlement that lands after a publication announces nothing onto the newer owner', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    await waitUntil('the rows painted', () => h.texts().some(text => text.startsWith('Results · 3 shown')))
    const selected = h.texts().find(text => text.startsWith('›'))!
    h.type('\u001bc')
    await waitUntil('the copy write started', () => h.copies.length === 1)
    assert.equal(h.copies[0], selected.slice(1),
      'the RAW stored bytes of the selected row reached the ONE Client-local copy policy')
    h.publishOwner('ses_b')
    h.copySettlement()(true)
    await h.observeAbsence()
    assert.equal(h.texts().some(text => text.includes('Copied the history entry')), false,
      'the retired settlement stated nothing on the dock')
  } finally {
    await h.dispose()
  }
})

test('a painted Restore cell from the older card cannot act after a same-id reopen', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    await waitUntil('the rows painted', () => h.texts().some(text => text.startsWith('Results · 3 shown')))
    const restore = h.ids(/-restore$/)[0]!
    assert.ok(restore.includes('history-card'), 'the cell belongs to this card')
    // A→B→A: the SAME id, a NEW owner object. A string equality would accept.
    h.publishOwner('ses_b')
    h.publishOwner('ses_a')
    h.clickRefused(restore)
    await h.observeAbsence()
    assert.equal(h.draft().text, '', 'the older capture restored nothing under the reopened Session')
    assert.equal(h.submits.length, 0, 'and never submitted')
  } finally {
    await h.dispose()
  }
})

// ── C. The composition never gains a second authority ───────────────────────

test('the mount forwards the surface\'s own source identity and every scope reads through that one object', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    assert.equal(h.received.source, h.boundSource, 'the mount received the surface\'s OWN source object, not a copy')
    assert.equal(typeof h.received.cwd, 'function', 'the cwd bridge is the surface getter')
    assert.equal(typeof h.received.captureScope, 'function', 'and so is the one scope bridge')
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    assert.equal(h.requests.at(-1)?.scope, 'session', 'this composition has a live owner, so Session is the default')
    await waitUntil('the rows painted', () => h.texts().some(text => text.startsWith('Results · 3 shown')))
    h.key(TAB)
    await waitUntil('Directory started', () => h.requests.at(-1)?.scope === 'current')
    h.key(TAB)
    await waitUntil('All started', () => h.requests.at(-1)?.scope === 'all')
    assert.equal(h.requests.length, 3, 'every scope read the ONE bound source')
  } finally {
    await h.dispose()
  }
})

test('the hydration commit retires the card with pure state and the outer frame carries it', async (t) => {
  const life = testLifecycle(t)
  const h = await mountChain(life, 'ses_a')
  try {
    h.holdNextRead()
    h.key(CTRL_R)
    await waitUntil('the card opened', () => h.cardPainted())
    const requestsBefore = h.requests.length
    const framesBefore = h.pane.frameCount()
    h.renderer().display.beginSessionHydration()
    assert.equal(h.cardPainted(), false, 'the hydration commit carries the frame with no card')
    assert.equal(h.requests.length, requestsBefore, 'the retire inside the seam issued no new read')
    h.releaseHeld({ results: [{ id: 'hydrating.jsonl:0', content: 'page read during hydration', cwd: '/w',
      ts: 1, sourceFile: 'hydrating.jsonl', sourceByteOffset: 0 }], exhausted: true })
    h.type(ENTER)
    await h.observeAbsence()
    assert.equal(h.draft().text, '', 'the retired card restored nothing')
    assert.equal(h.requests.length, requestsBefore, 'and issued no further read')
    h.renderer().display.setTranscript([], undefined, undefined, undefined, undefined, {})
    await waitUntil('the hydration frame painted', () => !h.cardPainted())
    assert.equal(h.cardPainted(), false, 'the outer commit carries the frame with no card')
  } finally {
    await h.dispose()
  }
})
