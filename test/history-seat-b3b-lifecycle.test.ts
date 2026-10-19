/**
 * Phase 3B / B3-B L6: the History editor-seat tenant's Session lifecycle
 * (plan §2 LIFECYCLE/CURRENTNESS/PUBLISH/FOCUS, §5 H3B-01..H3B-12).
 *
 * The fixture composes the REAL production pieces:
 * - `createSessionOwnershipCore` + `createSessionScopeAuthority` (the ONE
 *   Session owner/generation authority) and `bindSessionRuntime` (the real
 *   ordinary-transition / fork / first-session publication path) drive the app
 *   exactly like `src/app/bootstrap.ts` does: `captureHistoryScope` is the same
 *   one-line `sessionScope.capture()` bridge and the ownership core's
 *   `resetForGeneration` hook calls `app.retireStaleHistorySeat()` — the two
 *   production History-retirement entries.
 * - a real `TuiApp` over the real `VirtualTerminal`, the real History
 *   editor-seat tenant (`HistoryPanel`), the real Question / Approval / Save
 *   Location blockers and the real `EditorRegistry` plugin-editor handoff.
 *
 * Substitutes (deliberately minimal, bottom-of-stack IO only): the opaque
 * `owners` mapping, the `retirement` port and the `lifecycle` open/fork, plus
 * the static in-memory `HistorySearchSource` rows. There is deliberately NO DSH
 * Host/wire here — History writes nothing Host-side.
 *
 * Owner publication itself is NEVER faked: `core.setCurrentOwner` runs inside
 * the real `runOrdinaryCommit` / `runForkCommit` / `runFirstSessionCommit` via
 * `bindSessionRuntime`.
 * @module @xmoon76/dsh-pi-tui/history-seat-b3b-lifecycle.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { EditorRegistry } from '../src/extension/internal/editor-registry.ts'
import type { ExtensionEditor } from '../src/extension/public-types.ts'
import {
  createSessionOwnershipCore,
  type SessionOwnershipCore,
} from '../src/app/session/ownership-core.ts'
import {
  createSessionScopeAuthority,
  type SessionScopeAuthority,
} from '../src/app/session/scope.ts'
import {
  bindSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeSurface,
} from '../src/app/session/runtime.ts'
import type { SessionOwnerRef } from '../src/app/session/subject.ts'
import type { SessionOwnerRetirement } from '../src/app/session/owner-access.ts'
import type { Diag } from '../src/runtime/process/diagnostics.ts'
import type { OwnedTaskOptions } from '../src/runtime/process/tasks.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS, type HistorySearchPage, type HistorySearchRequest, type HistorySearchSource } from '../src/client/history/search.ts'
import { HistoryPanel } from '../src/tui/panels/history-panel.ts'
import type { SaveLocationDeps, SaveLocationResult } from '../src/tui/interaction/save-location.ts'
import { TuiApp, type HistoryOpenScope, type OwnedRunner } from '../src/tui-app.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp built here is disposed after each test — the vendored fork
 * keybindings are a process-global slot (see `src/tui/process-slot.ts`). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const fakeDiag: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

const strip = (lines: readonly string[]): string =>
  lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')

const panelVisible = (vt: VirtualTerminal): boolean =>
  vt.getViewport().some(line => line.includes('Input History'))

/** Bounded settling for the panel's async search — never a wall-clock poll. */
async function waitFor(probe: () => boolean, maxMs = 2000): Promise<void> {
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > maxMs) throw new Error('waitFor: predicate never became true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// ---------------------------------------------------------------------------
// The ONE History dispose probe: the real panel's caller-owned cleanup path.
// ---------------------------------------------------------------------------

interface HistoryDisposeProbe {
  /** Every `HistoryPanel.dispose()` attempt (a double close would count twice). */
  count(): number
  /** Make the NEXT real dispose run its effect, then throw exactly `value`. */
  armThrow(value: unknown): void
  restore(): void
}

/**
 * Count the real `HistoryPanel.dispose()` entries (the ONE lease-close sink) and
 * optionally inject the shape of a throwing caller cleanup. The original is
 * saved UNBOUND and re-invoked with `original.call(this)` — never `.bind` — so
 * the production method keeps its own receiver and no default branch can hide.
 */
function probeHistoryPanelDispose(life: TestLifecycle): HistoryDisposeProbe {
  const original = HistoryPanel.prototype.dispose
  let count = 0
  let pending: { value: unknown } | undefined
  HistoryPanel.prototype.dispose = function patchedDispose(this: HistoryPanel): void {
    count += 1
    const armed = pending
    pending = undefined
    original.call(this)
    if (armed !== undefined) throw armed.value
  }
  const restore = (): void => { HistoryPanel.prototype.dispose = original }
  life.defer(restore)
  return {
    count: () => count,
    armThrow: (value) => { pending = { value } },
    restore,
  }
}

// ---------------------------------------------------------------------------
// History search sources (the bottom-of-stack IO substitute only).
// ---------------------------------------------------------------------------

interface StaticRow { readonly content: string; readonly ts: number }

/** A deterministic in-memory source that filters like the real one (substring). */
function filterSource(rows: readonly StaticRow[]): HistorySearchSource {
  return {
    search: async (request: HistorySearchRequest): Promise<HistorySearchPage> => ({
      results: rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => request.query === '' || row.content.includes(request.query))
        .map(({ row, index }) => ({
          id: `row-${index}`,
          content: row.content,
          cwd: '/work/a',
          ts: row.ts,
          sourceFile: '/h.jsonl',
          sourceByteOffset: index + 1,
        })),
      exhausted: true,
    }),
  }
}

interface DeferredSearchSource {
  readonly source: HistorySearchSource
  requests(): readonly HistorySearchRequest[]
  settle(page: HistorySearchPage): void
  fail(error: unknown): void
}

/** A controllable source: each call pends until the test settles it. */
function deferredSearchSource(): DeferredSearchSource {
  const requests: HistorySearchRequest[] = []
  const pending: Array<{ resolve: (page: HistorySearchPage) => void; reject: (error: unknown) => void }> = []
  const source: HistorySearchSource = {
    search: (request) => {
      requests.push(request)
      return new Promise<HistorySearchPage>((resolve, reject) => { pending.push({ resolve, reject }) })
    },
  }
  const settle = (page: HistorySearchPage): void => {
    const next = pending.shift()
    assert.ok(next !== undefined, 'settle() requires one pending search')
    next.resolve(page)
  }
  const fail = (error: unknown): void => {
    const next = pending.shift()
    assert.ok(next !== undefined, 'fail() requires one pending search')
    next.reject(error)
  }
  return { source, requests: () => requests, settle, fail }
}

// ---------------------------------------------------------------------------
// The Session fixture: real ownership core + real scope + real runtime.
// ---------------------------------------------------------------------------

interface SessionFixture {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly core: SessionOwnershipCore
  readonly runtime: SessionRuntime
  /** Every `HistoryOpenScope` the app captured, in open order (the REAL pair). */
  readonly captures: HistoryOpenScope[]
  /** The generation-reset retirement observations (owner not yet published). */
  readonly resetRetires: Array<{ generation: number; ownerId: string | undefined; focusSeat: string }>
  /** The publishOwner-seam retirement observations (owner published). */
  readonly publicationRetires: Array<{ sessionId: string | undefined; focusSeat: string }>
  readonly copied: string[]
  readonly notices: string[]
  /** Publish one owner synchronously through the REAL resume commit shape. */
  publish(sessionId: string): void
  /** Fail the NEXT ordinary commit at the pre-publication `resetSubmitLatency`. */
  armResetSubmitLatencyFailure(): void
  /** Fail the owner metadata lookup for `sessionId` (post-bump, pre-publication). */
  armCompletionIdentityFailure(sessionId: string): void
}

function buildSessionFixture(life: TestLifecycle, options: {
  source: HistorySearchSource
  copySelection?: (text: string) => Promise<boolean>
  runOwned?: OwnedRunner
}): SessionFixture {
  const vt = new VirtualTerminal(80, 24)
  const ownerIds = new Map<SessionOwnerRef, string>()
  const copied: string[] = []
  const notices: string[] = []

  let disposed = false
  let failResetSubmitLatency = false
  let failCompletionFor: string | undefined

  const fromHandle = (handle: { session: { id: string } }): SessionOwnerRef => {
    // Every lifecycle handle is a FRESH owner ref: a same-id reopen is a NEW
    // ownership generation (the exact A→B→A discriminator).
    const owner = {} as SessionOwnerRef
    ownerIds.set(owner, handle.session.id)
    return owner
  }

  let app!: TuiApp
  let core!: SessionOwnershipCore

  const captures: HistoryOpenScope[] = []
  const resetRetires: SessionFixture['resetRetires'] = []
  const publicationRetires: SessionFixture['publicationRetires'] = []

  core = createSessionOwnershipCore({
    isSurfaceDisposed: () => disposed,
    // The bootstrap's `createSessionOwnershipCore({ resetForGeneration })` hook:
    // the authoritative generation has ALREADY moved when this runs, so a same-
    // owner bump (and a post-bump pre-publication failure) expires the captured
    // scope here. This is the production entry, not a test-only close.
    resetForGeneration: () => {
      app.retireStaleHistorySeat()
      resetRetires.push({
        generation: core.generation(),
        ownerId: core.currentSessionId(),
        focusSeat: app.focusSeatForTest(),
      })
    },
  })

  // The EXACT `src/app/bootstrap.ts` bridge: ONE atomic capture, handed to the
  // TUI as `{ sessionId, isCurrent }`; no string fallback exists.
  const sessionScope: SessionScopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) {
        return { subject: undefined, sessionId: undefined, generation: core.generation() }
      }
      return { subject, sessionId: core.currentSessionId()!, generation: core.generation() }
    },
    isSubjectCurrent: subject => core.isSubjectCurrent(subject),
  })

  const surface: SessionRuntimeSurface = {
    warnRetirement: () => {},
    warnRetirementSkipped: () => {},
    isSurfaceDisposed: () => disposed,
    beginOpening: () => ({}),
    clearOpening: () => {},
    settlePendingQueueRecalls: () => {},
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {
      if (!failResetSubmitLatency) return
      failResetSubmitLatency = false
      throw new Error('commit seam exploded before publication')
    },
    setCompletionOwner: () => {},
    initLiveSession: async () => {},
    refreshLiveCatalog: async () => {},
    reportSwitch: () => {},
    clearUnpinnedDrafts: () => {},
    dropOutgoingActiveDraft: () => {},
    // The real app entry (the mounted surface half of the publication).
    beginInputHistoryScope: (owner) => { app.beginInputHistoryScope(owner) },
    // The real publication-commit retirement, with an in-commit observation:
    // the focus seat AFTER the app retired, still inside the synchronous
    // publishOwner section (before any post-commit await).
    retireStaleHistorySeat: () => {
      app.retireStaleHistorySeat()
      publicationRetires.push({
        sessionId: core.currentSessionId(),
        focusSeat: app.focusSeatForTest(),
      })
    },
    withdrawReplacedPresentation: () => {},
    reportSwitchFailure: () => {},
    launchComposition: async () => ({ composition: {} }),
    setResumeFailure: () => {},
    reportFirstSessionCreateFailure: () => {},
    notifyResumeFailure: () => {},
    awaitPendingDefaultWrite: async () => {},
    newSessionId: () => 'session-first',
    sessionCreateCwd: () => '/work/a',
    currentOpening: () => undefined,
    resetOpening: () => {},
  }

  const owners = {
    fromHandle: (handle: { session: { id: string } }): SessionOwnerRef => fromHandle(handle),
    sessionId: (owner: SessionOwnerRef): string => {
      const id = ownerIds.get(owner)
      if (id === undefined) throw new Error('unknown SessionOwnerRef')
      return id
    },
    completionIdentity: (owner: SessionOwnerRef): string | undefined => {
      const id = owners.sessionId(owner)
      if (failCompletionFor === id) {
        failCompletionFor = undefined
        throw new Error('completionIdentity exploded before publication')
      }
      return `completion:${id}`
    },
  }

  const retirement: SessionOwnerRetirement = {
    whenIdleOrAbort: async () => false,
    flush: async () => {},
    preCancel: () => {},
    retire: async () => ({ failures: [], durabilityFailure: undefined }),
    park: () => {},
    retireParked: async () => ({ failures: [], durabilityFailure: undefined }),
  }

  const lifecycle = {
    create: async () => { throw new Error('unexpected create in this fixture') },
    open: async (request: { sessionId: string }) => ({
      ownership: 'current' as const,
      outcome: { kind: 'opened' as const, handle: { session: { id: request.sessionId } } },
    }),
    fork: async () => { throw new Error('unexpected fork in this fixture') },
  }

  app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    ...(options.runOwned === undefined ? {} : { runOwned: options.runOwned }),
  }, {
    historySearchSource: options.source,
    historySearchCwd: () => '/work/a',
    ...(options.copySelection === undefined ? {} : { copySelection: options.copySelection }),
    captureHistoryScope: () => {
      const scope = sessionScope.capture()
      const pair: HistoryOpenScope = {
        sessionId: scope.sessionId,
        isCurrent: () => sessionScope.isCurrent(scope),
      }
      captures.push(pair)
      return pair
    },
  })
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  startedApps.add(app)
  life.defer(() => app.stop())

  const runtime = bindSessionRuntime(core, {
    owners,
    retirement,
    lifecycle,
    lifecycleSignal: new AbortController().signal,
    surface,
    isScopeCurrent: scope => sessionScope.isCurrent(scope),
    diag: fakeDiag,
  })

  return {

    vt,
    app,
    core,
    runtime,
    captures,
    resetRetires,
    publicationRetires,
    copied,
    notices,
    publish: (sessionId) => {
      runtime.publishResumedOwner({ session: { id: sessionId } }, () => undefined)
    },
    armResetSubmitLatencyFailure: () => { failResetSubmitLatency = true },
    armCompletionIdentityFailure: (sessionId) => { failCompletionFor = sessionId },
  }
}

// ---------------------------------------------------------------------------
// The modal fixture: a controllable capture pair (no Session changes happen in
// these tests) but a REAL History tenant and REAL blocking owners.
// ---------------------------------------------------------------------------

interface ModalFixture {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly copied: string[]
  readonly notices: string[]
  /** Flip the captured scope's currentness (the Session-fence stand-in). */
  setTenantCurrent(value: boolean): void
  /** The History panel that currently owns the seat, or undefined. */
  livePanel(): HistoryPanel | undefined
}

function buildModalFixture(life: TestLifecycle, options: {
  source: HistorySearchSource
  registry?: EditorRegistry
  copySelection?: (text: string) => Promise<boolean>
  runOwned?: OwnedRunner
}): ModalFixture {
  const vt = new VirtualTerminal(80, 24)
  const copied: string[] = []
  const notices: string[] = []
  let tenantCurrent = true
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    ...(options.runOwned === undefined ? {} : { runOwned: options.runOwned }),
  }, {
    ...(options.registry === undefined ? {} : { editorRegistry: options.registry }),
    historySearchSource: options.source,
    historySearchCwd: () => '/work/a',
    ...(options.copySelection === undefined ? {} : { copySelection: options.copySelection }),
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => tenantCurrent }),
  })
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  return {
    vt,
    app,
    copied,
    notices,
    setTenantCurrent: (value) => { tenantCurrent = value },
    livePanel: () => {
      const focused = app.focusedComponentForTest()
      return focused instanceof HistoryPanel ? focused : undefined
    },
  }
}

/** A Client-local save-location deps set with no real filesystem. */
function saveDeps(): SaveLocationDeps {
  return {
    resolveDirectory: (input) => input === './' ? '/tmp/dsh-b3b-out' : input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => null,
  }
}

function askSave(app: TuiApp): Promise<SaveLocationResult> {
  return app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    saveDeps(),
  )
}

/** The hidden host editor's cursor (the draft/cursor round-trip witness). */
function hostCursor(app: TuiApp): unknown {
  return (app as unknown as { editor: { getCursor(): unknown } }).editor.getCursor()
}

/** Open History and return the REAL tenant instance that owns the keyboard. */
async function openHistory(vt: VirtualTerminal, app: TuiApp): Promise<HistoryPanel> {
  app.openHistorySearch()
  await vt.waitForRender()
  const focused = app.focusedComponentForTest()
  assert.ok(focused instanceof HistoryPanel, 'the History tenant must own the seat')
  return focused
}

/** A plugin editor whose input hook records every semantic event it receives. */
function recordingPluginEditor(state: { text: string; received: string[] }): ExtensionEditor {
  return {
    get component() {
      return { kind: 'text' as const, spans: [{ text: state.text }] }
    },
    getText: () => state.text,
    setText: (text) => { state.text = text },
    getCursor: () => 0,
    setCursor: () => {},
    handleInput: (event) => {
      // Ordinary typing arrives as a `key` (one char per chunk) or as a short
      // printable `text` run; both belong to the plugin's own document here.
      const typed = event.kind === 'text'
        ? event.text
        : event.kind === 'key' && !event.key.ctrl && !event.key.alt && [...event.key.key].length === 1
          ? event.key.key
          : undefined
      if (typed === undefined) return false
      state.received.push(typed)
      state.text += typed
      return true
    },
    dispose: () => {},
  }
}

// ---------------------------------------------------------------------------
// H3B-01: Question FIFO Q1 → Q2
// ---------------------------------------------------------------------------

test('H3B-01: a Question FIFO parks History across Q1→Q2 and restores the SAME tenant query/selection/Preview anchor', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildModalFixture(life, {
    source: filterSource([
      { content: 'fix nginx reload', ts: 3 },
      { content: 'old nginx prompt', ts: 1 },
    ]),
  })
  await h.vt.waitForRender()
  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('fix nginx reload'))
  h.vt.sendInput('nginx')
  await waitFor(() => strip(h.vt.getViewport()).includes('old nginx prompt'))
  h.vt.sendInput('\x1b[B') // select the second (older) row
  await h.vt.waitForRender()
  const before = strip(h.vt.getViewport())
  assert.ok(before.split('\n').some(line => line.startsWith('> ')), 'a row is selected before the park')
  assert.equal(h.app.focusSeatForTest(), 'editor-panel', 'the History tenant owns the derived seat')

  const first = h.app.askQuestions([{ id: 'q1', question: 'first flow?', options: [{ label: 'Yes' }] }])
  const second = h.app.askQuestions([{ id: 'q2', question: 'second flow?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('first flow?'), 'Q1 owns the seat')
  assert.notEqual(h.app.focusSeatForTest(), 'editor-panel', 'a parked History is not the keyboard owner')
  assert.equal(panel.focused, false, 'the parked tenant lost focus')
  // An ordinary key while Q1 owns the seat must never reach the parked panel.
  h.vt.sendInput('Z')
  await h.vt.waitForRender()
  assert.ok(!strip(h.vt.getViewport()).includes('nginxZ'), 'no key may leak into the parked History query')

  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  await h.vt.waitForRender()
  // The FIFO middle: Q2 takes the seat DIRECTLY — History must stay parked.
  assert.ok(strip(h.vt.getViewport()).includes('second flow?'), 'Q2 owns the seat after Q1 settles')
  assert.notEqual(h.app.focusSeatForTest(), 'editor-panel', 'no History restore between the two flows')
  assert.equal(panel.focused, false, 'no tenant focus between the two flows')

  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the LAST settle restores the SAME tenant instance')
  assert.equal(h.app.focusSeatForTest(), 'editor-panel')
  assert.equal(dispose.count(), 0, 'parking must never dispose the tenant')
  assert.equal(strip(h.vt.getViewport()), before,
    'query, selected row and Preview anchor are byte-identical after the park/restore round trip')
})

// ---------------------------------------------------------------------------
// H3B-02: Approval A → B, including the hasPending() handover gap
// ---------------------------------------------------------------------------

test('H3B-02: an Approval A→B FIFO keeps History parked across the hasPending() handover gap', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildModalFixture(life, { source: filterSource([{ content: 'approval park row', ts: 3 }]) })
  await h.vt.waitForRender()
  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('approval park row'))

  // The `hasPending()` gap: `ApprovalRuntime.settle(A)` clears the ACTIVE slot and
  // only then calls `showNext()` for B. `projectActivity()` runs inside that
  // window (the settle step list, before the handover) — a synchronous callback
  // there must still observe B as pending (`hasPending()` = active OR queued) and
  // must never restore the parked tenant.
  const proto = TuiApp.prototype as unknown as { projectActivity(): void }
  const originalProject = proto.projectActivity
  const gaps: Array<{ seat: string; panelFocused: boolean }> = []
  let armed = false
  proto.projectActivity = function patchedProjectActivity(this: TuiApp): void {
    originalProject.call(this)
    if (armed) {
      gaps.push({
        seat: this.focusSeatForTest(),
        panelFocused: this.focusedComponentForTest() === panel,
      })
    }
  }
  life.defer(() => { proto.projectActivity = originalProject })

  const first = h.app.showApprovalPrompt({ toolName: 'bash', reason: 'approval first' })
  const second = h.app.showApprovalPrompt({ toolName: 'fs', reason: 'approval second' })
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('bash'), 'A owns the seat')
  assert.notEqual(h.app.focusSeatForTest(), 'editor-panel', 'the approval parks History')

  armed = true
  h.vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('fs'), 'B took the seat after A settled')
  assert.notEqual(h.app.focusSeatForTest(), 'editor-panel', 'no History restore between A and B')
  assert.ok(gaps.length >= 1, 'the settle tail really ran inside the active→next handover window')
  assert.ok(gaps.every(gap => gap.seat !== 'editor-panel' && !gap.panelFocused),
    `the parked History must never regain the seat in the handover gap: ${JSON.stringify(gaps)}`)

  h.vt.sendInput('n')
  assert.equal(await second, 'rejected')
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the drained queue releases the SAME tenant')
  assert.equal(dispose.count(), 0, 'park/restore must never dispose the tenant')
})

// ---------------------------------------------------------------------------
// H3B-03: Save Location cancel + confirm
// ---------------------------------------------------------------------------

test('H3B-03: a Save Location prompt parks History; cancel and confirm both restore it with draft/cursor/paste registry intact', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildModalFixture(life, { source: filterSource([{ content: 'save prompt row', ts: 3 }]) })
  await h.vt.waitForRender()
  // A REAL large paste through the fork editor's bracketed-paste path: the raw
  // document carries the registry marker, the wire form expands it.
  const body = Array.from({ length: 40 }, (_, index) => `pasted line ${index}`).join('\n')
  h.vt.sendInput(`before \x1b[200~${body}\x1b[201~ after`)
  await h.vt.waitForRender()
  const document = h.app.seatTextForTest()
  const expanded = h.app.getDraft()
  const cursor = hostCursor(h.app)
  assert.match(document, /\[paste #1 \+40 lines\]/, 'the editor created a REAL registry marker')

  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('save prompt row'))

  // Cancel.
  const cancelled = askSave(h.app)
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('Save session archive'), 'the Save prompt owns the seat')
  assert.ok(!panelVisible(h.vt), 'the parked History is not painted')
  assert.notEqual(h.app.focusSeatForTest(), 'editor-panel')
  h.vt.sendInput('\x1b')
  assert.deepEqual(await cancelled, { kind: 'cancelled' })
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the cancel restores the SAME History tenant')
  assert.equal(h.app.seatTextForTest(), document, 'cancel leaves the marker document byte-identical')
  assert.equal(h.app.getDraft(), expanded, 'the paste registry still resolves to the same payload')
  assert.deepEqual(hostCursor(h.app), cursor, 'cancel preserves the cursor')

  // Confirm.
  const confirmed = askSave(h.app)
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('Save session archive'), 'the second Save prompt owns the seat')
  h.vt.sendInput('\r')
  assert.deepEqual(await confirmed, { kind: 'selected', directory: '/tmp/dsh-b3b-out', overwrite: false })
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the confirm restores the SAME History tenant')
  assert.equal(h.app.seatTextForTest(), document, 'confirm leaves the marker document byte-identical')
  assert.equal(h.app.getDraft(), expanded, 'the paste registry still resolves to the same payload')
  assert.deepEqual(hostCursor(h.app), cursor, 'confirm preserves the cursor')
  assert.equal(dispose.count(), 0, 'the park/restore round trips never dispose the tenant')
})

// ---------------------------------------------------------------------------
// H3B-04: a throwing stale-History cleanup during a blocker park
// ---------------------------------------------------------------------------

test('H3B-04: a stale History whose cleanup throws while a Question preempts the seat surfaces the error identity and rolls the owner back once', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildModalFixture(life, { source: filterSource([{ content: 'reentrant row', ts: 3 }]) })
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  // The captured subject expires (a replaced owner / switched Session): the next
  // re-projection must retire the tenant through its ONE caller cleanup.
  h.setTenantCurrent(false)
  const boom = new Error('history seat cleanup boom')
  dispose.armThrow(boom)

  const question = h.app.askQuestions([{ id: 'q1', question: 'never presented?', options: [{ label: 'Yes' }] }])
  let caught: unknown
  try { await question } catch (error) { caught = error }
  assert.equal(caught, boom, 'the ORIGINAL cleanup failure must surface by identity')
  await h.vt.waitForRender()
  assert.equal(dispose.count(), 1, 'the stale tenant is closed exactly once (no double close)')
  assert.ok(!strip(h.vt.getViewport()).includes('never presented?'),
    'the Question whose park failed must not be presented')
  assert.ok(!panelVisible(h.vt), 'the retired History must not stay painted')
  assert.equal(h.app.focusSeatForTest(), 'editor', 'the seat projects the live editor again')

  // No half-committed modal: a fresh Question/Save handoff still works and the
  // History is long gone.
  const healthy = h.app.askQuestions([{ id: 'q2', question: 'healthy after rollback?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('healthy after rollback?'), 'no half-committed Question may remain')
  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  assert.deepEqual(await healthy, [{ id: 'q2', selected: ['Yes'] }])
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt), 'the retired History never comes back')
})

// ---------------------------------------------------------------------------
// H3B-05: a real A → B publication
// ---------------------------------------------------------------------------

test('H3B-05: a real A→B publication retires the open History seat exactly once before the first new-session frame', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, { source: filterSource([{ content: 'session a row', ts: 3 }]) })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  assert.equal(h.captures.length, 0, 'the resume publication opens no History scope')

  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('session a row'))
  assert.equal(h.app.focusSeatForTest(), 'editor-panel')

  assert.equal(await h.runtime.switchSession('session-b'), undefined, 'the switch committed')
  // The generation-reset hook already retired the seat while the OLD owner was
  // still current (the bump runs BEFORE publishOwner in `runOrdinaryCommit`).
  assert.equal(h.resetRetires.length, 1, 'exactly one generation reset ran')
  assert.equal(h.resetRetires[0]!.generation, 1, 'the authoritative generation really moved')
  assert.equal(h.resetRetires[0]!.ownerId, 'session-a', 'History closed while the OLD owner was still current')
  assert.notEqual(h.resetRetires[0]!.focusSeat, 'editor-panel', 'the seat left the History tenant at the reset')
  // The publishOwner seam ran too (idempotently) with the NEW owner published.
  assert.equal(h.publicationRetires.length, 1, 'the publication commit retirement ran exactly once')
  assert.equal(h.publicationRetires[0]!.sessionId, 'session-b', 'the new owner was already published')
  assert.notEqual(h.publicationRetires[0]!.focusSeat, 'editor-panel', 'History never owns the seat after the commit')
  assert.equal(dispose.count(), 1, 'the stale seat was disposed exactly once across both entries')

  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt), 'the first new-session frame must not paint the old History')
  assert.equal(h.app.focusSeatForTest(), 'editor')
  assert.equal(h.app.focusedComponentForTest() !== panel, true, 'the old panel owns nothing')

  // Idempotence: a repeated retirement entry is a strict no-op.
  h.app.retireStaleHistorySeat()
  h.app.retireStaleHistorySeat()
  assert.equal(dispose.count(), 1, 'repeated retirement calls never close again')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt))

  // Positive control: a fresh open captures the NEW session.
  const reopened = await openHistory(h.vt, h.app)
  assert.equal(h.captures.at(-1)!.sessionId, 'session-b', 'the new open binds the published Session')
  assert.equal(reopened, h.app.focusedComponentForTest())
})

// ---------------------------------------------------------------------------
// H3B-06: A → B → A with the same id string
// ---------------------------------------------------------------------------

test('H3B-06: an A→B→A switch with the SAME id string leaves the captured OLD scope refusing Enter/Copy/async', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, {
    source: filterSource([{ content: 'stale session-a row', ts: 3 }]),
  })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('stale session-a row'))
  const oldCapture = h.captures[0]!
  assert.equal(oldCapture.sessionId, 'session-a')
  assert.equal(oldCapture.isCurrent(), true, 'the captured scope starts current')
  const oldPanel = h.app.focusedComponentForTest()
  assert.ok(oldPanel instanceof HistoryPanel)

  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  await h.vt.waitForRender()
  assert.equal(oldCapture.isCurrent(), false, 'B replaced the captured owner')

  // Back to the SAME id string — but a NEW owner generation (a fresh binding).
  assert.equal(await h.runtime.switchSession('session-a'), undefined)
  await h.vt.waitForRender()
  assert.equal(h.captures.length, 1, 'the switch never auto-reopens History (no capture)')
  assert.equal(oldCapture.sessionId, 'session-a', 'the re-opened session carries the same id string')
  assert.equal(oldCapture.isCurrent(), false,
    'the OLD captured scope must still refuse after the same-id reopen (exact owner, not string)')
  assert.equal(dispose.count(), 1, 'the old seat was retired exactly once by the first switch')
  assert.ok(!panelVisible(h.vt), 'the stale History is gone')
  assert.equal(oldPanel instanceof HistoryPanel && oldPanel.focused, false, 'the stale panel owns nothing')
  assert.equal(oldPanel.canAccept(), false,
    'the stale panel\'s own acceptance predicate refuses (the app guard reads the SAME captured scope)')

  // Enter/Alt+C while no seat is open: the stale capture must not write into the
  // new session's editor and the old panel's copy path must stay silent.
  const draftBefore = h.app.getDraft()
  h.vt.sendInput('\r')
  h.vt.sendInput('\x1bc')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), draftBefore, 'Enter on the stale seat never touches the new session editor')
  assert.deepEqual(h.copied, [], 'the stale seat copied nothing')
  assert.equal(oldCapture.isCurrent(), false)

  // Positive control: a FRESH seat (same id, NEW owner generation) is captured
  // current and really accepts into the same-id session.
  const freshPanel = await openHistory(h.vt, h.app)
  const fresh = h.captures[1]!
  assert.equal(fresh.sessionId, 'session-a', 'the fresh seat binds the same id string')
  assert.equal(fresh.isCurrent(), true, 'the NEW capture is current')
  assert.notEqual(fresh, oldCapture)
  assert.equal(oldCapture.isCurrent(), false, 'the old capture stays refused')
  assert.notEqual(freshPanel, oldPanel)
  await waitFor(() => strip(h.vt.getViewport()).includes('stale session-a row'))
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), 'stale session-a row', 'the current capture really accepts')
  assert.equal(oldCapture.isCurrent(), false, 'accepting through the new scope did not revive the old one')
})

// ---------------------------------------------------------------------------
// H3B-07: same-owner generation bump and sessionless → first Session
// ---------------------------------------------------------------------------

test('H3B-07: a same-owner generation bump expires the captured scope and retires the seat even though the id did not move', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, { source: filterSource([{ content: 'bump row', ts: 3 }]) })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('bump row'))
  const captured = h.captures[0]!
  assert.equal(captured.isCurrent(), true)

  h.core.bumpGeneration()
  assert.equal(h.core.currentSessionId(), 'session-a', 'the OWNER is unchanged by a generation bump')
  assert.equal(h.core.generation(), 1)
  assert.equal(captured.isCurrent(), false, 'the same-id capture is refused: the generation moved')
  assert.equal(h.resetRetires.length, 1, 'the ONE generation-reset hook ran')
  assert.notEqual(h.resetRetires[0]!.focusSeat, 'editor-panel', 'the seat was closed at the bump, before any keypress')
  assert.equal(dispose.count(), 1, 'the stale seat was disposed exactly once')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt), 'the bump is reflected in the very next frame')
  assert.equal(h.captures.length, 1, 'no new open happened')

  // Positive control: a fresh capture at the new generation is current.
  await openHistory(h.vt, h.app)
  assert.equal(h.captures[1]!.isCurrent(), true)
  assert.equal(h.captures[1]!.sessionId, 'session-a')
})

test('H3B-07 (first-session): the first published Session kills a sessionless History seat at the publication seam', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, { source: filterSource([{ content: 'sessionless row', ts: 3 }]) })
  h.app.start()
  await h.vt.waitForRender()
  assert.equal(h.core.owner(), undefined, 'the fixture really starts sessionless')
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('sessionless row'))
  const captured = h.captures[0]!
  assert.equal(captured.sessionId, undefined, 'the sessionless capture carries no id')
  assert.equal(captured.isCurrent(), true)
  assert.equal(h.resetRetires.length, 0)

  assert.equal(await h.runtime.commitFirstSession({ session: { id: 'session-first' } }), true)
  assert.equal(h.core.currentSessionId(), 'session-first')
  // The publication seam itself retired the sessionless seat (the owner exists
  // now, so the sessionless capture fails even though no id string moved).
  assert.equal(h.publicationRetires.length, 1, 'the first-session publication commit retired exactly once')
  assert.equal(h.publicationRetires[0]!.sessionId, 'session-first')
  assert.notEqual(h.publicationRetires[0]!.focusSeat, 'editor-panel')
  assert.equal(captured.isCurrent(), false, 'the sessionless capture is refused once an owner exists')
  assert.equal(dispose.count(), 1, 'the sessionless seat was disposed exactly once')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt), 'the first published frame must not paint the sessionless History')

  const reopened = await openHistory(h.vt, h.app)
  assert.equal(h.captures.at(-1)!.sessionId, 'session-first')
  assert.equal(reopened, h.app.focusedComponentForTest())
})

// ---------------------------------------------------------------------------
// H3B-08: failed / pre-commit switches
// ---------------------------------------------------------------------------

test('H3B-08: a pre-publication switch failure never retires a still-current History seat nor rewrites the owner', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, { source: filterSource([{ content: 'survivor row', ts: 3 }]) })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('survivor row'))
  const captured = h.captures[0]!
  const draftBefore = h.app.getDraft()

  // The commit section throws BEFORE the generation bump: the owner was never
  // published, so nothing may treat the History as switched away.
  h.armResetSubmitLatencyFailure()
  const result = await h.runtime.switchSession('session-b')
  assert.match(String(result), /commit seam exploded before publication/, 'the truthful failure surfaces')
  assert.equal(h.core.currentSessionId(), 'session-a', 'no new owner was published')
  assert.equal(h.resetRetires.length, 0, 'no generation reset ran')
  assert.equal(captured.isCurrent(), true, 'the captured scope is STILL current')
  assert.equal(dispose.count(), 0, 'a failed switch must never retire a current History seat')
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the SAME seat is still open')
  assert.ok(panelVisible(h.vt), 'the History survives a failed switch')
  assert.equal(h.app.getDraft(), draftBefore, 'the failed switch left the draft untouched')

  // A later successful switch still retires it exactly once.
  assert.equal(await h.runtime.switchSession('session-c'), undefined)
  await h.vt.waitForRender()
  assert.equal(dispose.count(), 1, 'the eventually committed switch retired it exactly once')
  assert.ok(!panelVisible(h.vt))
})

test('H3B-08 (post-bump): a post-bump pre-publication failure keeps the owner and still retires through the generation contract', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildSessionFixture(life, { source: filterSource([{ content: 'post bump row', ts: 3 }]) })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('post bump row'))
  const captured = h.captures[0]!
  const draftBefore = h.app.getDraft()

  // The owner-metadata lookup throws AFTER the generation bump and BEFORE
  // `core.setCurrentOwner`: the publication never happened, but the generation
  // legally moved — the captured scope expires through the SAME authority.
  h.armCompletionIdentityFailure('session-b')
  const result = await h.runtime.switchSession('session-b')
  assert.match(String(result), /completionIdentity exploded before publication/)
  assert.equal(h.core.currentSessionId(), 'session-a', 'the OLD owner stands (no publication)')
  assert.equal(h.core.generation(), 1, 'the bump is not rolled back')
  assert.equal(captured.isCurrent(), false, 'the generation-contract expiry is authoritative')
  assert.equal(h.resetRetires.length, 1, 'the ONE reset hook retired the seat at the bump')
  assert.notEqual(h.resetRetires[0]!.ownerId, 'session-b', 'the new owner was NEVER published when History closed')
  assert.equal(dispose.count(), 1, 'retired exactly once, by the generation contract')
  assert.equal(h.app.getDraft(), draftBefore, 'History cleanup never rewrote the session draft')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt))

  // A fresh open on the STILL-CURRENT owner A works (the owner was untouched).
  await openHistory(h.vt, h.app)
  assert.equal(h.captures.at(-1)!.sessionId, 'session-a')
  assert.equal(h.captures.at(-1)!.isCurrent(), true)
})

// ---------------------------------------------------------------------------
// H3B-09: an async History query across a real publication
// ---------------------------------------------------------------------------

test('H3B-09: a deferred History search resolving/rejecting after a switch paints nothing, writes nothing and cleans up once', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const deferred = deferredSearchSource()
  const h = buildSessionFixture(life, { source: deferred.source })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  assert.equal(deferred.requests().length, 1, 'the open runs exactly ONE immediate search')
  const firstSignal = deferred.requests()[0]!.signal
  assert.equal(firstSignal?.aborted, false, 'the search is in flight')

  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  assert.equal(firstSignal?.aborted, true, 'the committed switch aborted the in-flight search exactly once')
  assert.equal(dispose.count(), 1, 'the seat was retired exactly once')

  // The stale page resolves AFTER the switch: it must not paint and must not
  // write into the new session.
  deferred.settle({
    results: [{
      id: 'stale', content: 'previous session row', cwd: '/work/a', ts: 1,
      sourceFile: '/h.jsonl', sourceByteOffset: 1,
    }],
    exhausted: true,
  })
  await h.vt.waitForRender()
  await new Promise(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!strip(h.vt.getViewport()).includes('previous session row'),
    'a page resolved for the replaced Session is never painted')
  assert.equal(h.app.getDraft(), '', 'the stale page wrote nothing into the new session')
  assert.ok(!panelVisible(h.vt), 'the stale seat is not resurrected')

  // Reject phase: a search scheduled by the NEW session is aborted by the next
  // switch, and its debounce timer is cleared exactly once.
  await openHistory(h.vt, h.app)
  assert.equal(deferred.requests().length, 2, 'the second open runs its own immediate search')
  const secondSignal = deferred.requests()[1]!.signal
  h.vt.sendInput('q') // schedules the debounce and aborts the in-flight request
  await h.vt.waitForRender()
  assert.equal(secondSignal?.aborted, true, 'the debounce invalidated the previous generation')
  assert.equal(await h.runtime.switchSession('session-c'), undefined)
  assert.equal(dispose.count(), 2, 'the second seat was retired exactly once')
  deferred.fail(new Error('late search failure'))
  await h.vt.waitForRender()
  await new Promise(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!strip(h.vt.getViewport()).includes('History unavailable'),
    'a late rejection must not paint the failure state into the new session')
  assert.equal(h.app.getDraft(), '', 'a late rejection wrote nothing')
  // The dispose cleared the debounce timer: no third search may ever start.
  // Proving an ABSENT timer fire needs one bounded wait past its deadline.
  await new Promise(resolve => setTimeout(resolve, HISTORY_SEARCH_DEBOUNCE_MS + 80))
  assert.equal(deferred.requests().length, 2, 'the disposed panel cleared its debounce timer exactly once')
})

// ---------------------------------------------------------------------------
// H3B-10: Copy All settling across a real publication
// ---------------------------------------------------------------------------

test('H3B-10: a Copy All payload is captured synchronously and a late settlement neither notifies nor repaints the new session', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const copied: string[] = []
  const settlements: Array<(ok: boolean) => void> = []
  // The runner starts the clipboard task SYNCHRONOUSLY, so the payload reaching
  // the clipboard capability is observed without any await.
  const syncRunner: OwnedRunner = <T,>(
    _label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void => {
    let result: T | Promise<T>
    try { result = task() } catch (error) { options.onError?.(error); return }
    Promise.resolve(result).then(value => options.onResult?.(value), error => options.onError?.(error))
  }
  const h = buildSessionFixture(life, {
    source: filterSource([{ content: 'copy payload exact', ts: 3 }]),
    copySelection: (text) => {
      copied.push(text)
      return new Promise<boolean>((resolve) => { settlements.push(resolve) })
    },
    runOwned: syncRunner,
  })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('copy payload exact'))

  h.vt.sendInput('\x1bc') // Alt+C
  assert.deepEqual(copied, ['copy payload exact'],
    'the EXACT payload reaches the clipboard capability synchronously (no await)')
  assert.equal(h.app.getDraft(), '', 'Copy All never accepts into the editor')
  assert.equal(settlements.length, 1, 'the clipboard write is pending')

  assert.equal(await h.runtime.switchSession('session-b'), undefined)
  await h.vt.waitForRender()
  assert.equal(dispose.count(), 1, 'the switch retired the copy-owning seat exactly once')

  // The failure settlement of the copy started for A would notify "Copy failed"
  // while the seat were live; the switch must have fenced it.
  settlements[0]!(false)
  await new Promise(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.deepEqual(h.notices, [], 'a copy settling after the Session switch must not notify')
  assert.ok(!strip(h.vt.getViewport()).includes('Copy failed'), 'no stale failure is painted')
  assert.ok(!strip(h.vt.getViewport()).includes('copy payload exact'),
    'the stale copy neither repaints its row nor the old History')
  assert.equal(h.app.getDraft(), '', 'the late settlement wrote nothing into the new session')

  // POSITIVE control: a copy on the NEW session's live seat DOES notify, so the
  // negative above really tests the session fence (not a dead notification path).
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('copy payload exact'))
  h.vt.sendInput('\x1bc')
  assert.equal(settlements.length, 2, 'the live-seat copy really started')
  settlements[1]!(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.notices, ['Copy sent'], 'the live-seat settlement notifies as expected')
})

// ---------------------------------------------------------------------------
// H3B-11: reentrancy inside the onAccept lease close
// ---------------------------------------------------------------------------

test('H3B-11: a synchronous reentry inside onAccept\'s lease.close() never overwrites the newer tenant, and the old lease retires only itself', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const h = buildModalFixture(life, { source: filterSource([{ content: 'accepted prompt', ts: 3 }]) })
  await h.vt.waitForRender()
  h.app.setDraft('original draft')
  await h.vt.waitForRender()
  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('accepted prompt'))

  // The reentry hook: `retireOptionalSeat` re-projects the seat after the old
  // lease's close; a synchronous callback there opens a NEWER History tenant.
  const proto = TuiApp.prototype as unknown as { mountSeatChild(): void }
  const originalMount = proto.mountSeatChild
  let reentered = false
  proto.mountSeatChild = function patchedMountSeatChild(this: TuiApp): void {
    originalMount.call(this)
    if (!reentered) {
      reentered = true
      this.openHistorySearch()
    }
  }
  life.defer(() => { proto.mountSeatChild = originalMount })

  h.vt.sendInput('\r') // accept the selected row; onAccept closes THIS lease first
  await h.vt.waitForRender()
  assert.equal(reentered, true, 'the lease close really re-entered a newer tenant')
  assert.equal(dispose.count(), 1, 'the old lease retired exactly ITS OWN panel once')
  const newer = h.app.focusedComponentForTest()
  assert.ok(newer instanceof HistoryPanel, 'the newer tenant owns the seat')
  assert.notEqual(newer, panel, 'the newer tenant is a different instance')
  assert.equal(h.app.seatTextForTest(), 'original draft',
    'the stale onAccept must NOT overwrite the newer owner with the accepted content')
  assert.ok(panelVisible(h.vt), 'the newer History tenant stays painted')
  assert.equal(h.app.focusSeatForTest(), 'editor-panel')

  // The newer owner is fully usable: Esc closes it and the editor keeps the
  // original draft (the accepted content was dropped, never queued).
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt))
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), 'original draftx', 'the current editor is editable after the reentry')
})

// ---------------------------------------------------------------------------
// H3B-12: a plugin editor winner change while History is PARKED
// ---------------------------------------------------------------------------

test('H3B-12: a plugin editor winner change during a PARK never ejects the blocker and History\'s Esc hands the keyboard to the CURRENT winner', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const registry = new EditorRegistry()
  const h = buildModalFixture(life, {
    source: filterSource([{ content: 'park winner row', ts: 3 }]),
    registry,
  })
  await h.vt.waitForRender()
  h.app.setDraft('host draft')
  await h.vt.waitForRender()
  const first = { text: 'first plugin', received: [] as string[] }
  registry.register({ id: 'plugin-first', priority: 0, create: () => recordingPluginEditor(first) }, 'plugin-first')
  h.app.reconcileEditorNow()
  await h.vt.waitForRender()
  // The handoff PRESERVES the draft: the host draft was transferred into the
  // plugin. Write a distinct plugin document, then the seat text is the plugin's.
  h.app.setDraft('first plugin')
  await h.vt.waitForRender()
  assert.equal(h.app.seatEditorForTest().id, 'plugin-first', 'the first plugin is the seat winner')
  assert.equal(h.app.seatTextForTest(), 'first plugin', 'the first plugin owns the seat')

  const panel = await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('park winner row'))

  const question = h.app.askQuestions([{ id: 'q1', question: 'holds the seat?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('holds the seat?'), 'the blocker owns the seat')
  assert.ok(!panelVisible(h.vt), 'History is parked')

  // While PARKED: a NEW plugin editor (lower priority = winner) is registered
  // and recompiled. It must not eject the blocker.
  const second = { text: 'second plugin live', received: [] as string[] }
  registry.register({ id: 'plugin-second', priority: -1, create: () => recordingPluginEditor(second) }, 'plugin-second')
  h.app.reconcileEditorNow()
  await h.vt.waitForRender()
  assert.ok(strip(h.vt.getViewport()).includes('holds the seat?'),
    'the winner change must not eject the blocking Question')
  assert.ok(!panelVisible(h.vt), 'the parked History stays hidden while the blocker is live')
  assert.equal(h.app.seatEditorForTest().id, 'plugin-second',
    'the recompiled winner is already the seat editor while the blocker still owns the frame')

  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await h.vt.waitForRender()
  assert.equal(h.app.focusedComponentForTest(), panel, 'the SAME History tenant is restored after the blocker')
  assert.equal(dispose.count(), 0, 'the park/restore never disposed History')

  // Esc closes History and the CURRENT winner — the recompiled second plugin,
  // never the hidden host editor — takes the keyboard.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt))
  assert.equal(h.app.seatEditorForTest().id, 'plugin-second', 'the CURRENT winner is the seat editor')
  assert.equal(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component,
    'the CURRENT winner physically holds the keyboard')
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.deepEqual(second.received, ['x'], 'the current winner receives the keys')
  assert.deepEqual(first.received, [], 'the replaced winner receives nothing')
  assert.equal(h.app.hostEditorTextForTest(), 'host draft', 'the hidden host editor is never written by the plugin winner')
})


// ---------------------------------------------------------------------------
// B3-B composition lock: the bootstrap reset-callback wiring.
// ---------------------------------------------------------------------------

test('B3-B composition: bootstrap retires History in the ONE resetForGeneration callback', () => {
  // Why a source lock: the L6 harness above mirrors bootstrap's reset wiring, so
  // removing THIS production line is otherwise invisible (the publishOwner seam
  // still retires after the ordinary switch's bump). A pure generation bump has
  // no publishOwner, so this is the only entry that closes History then.
  const source = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const coreCall = /createSessionOwnershipCore\(\{([\s\S]*?)\n {4}\}\)/.exec(withoutComments)?.[1]
  assert.ok(coreCall !== undefined, 'the composition root must construct the ownership core')
  assert.ok(coreCall.includes('surface.retireStaleHistorySeat()'),
    'a same-owner generation bump must retire the History seat from the ONE reset callback')
  assert.equal(withoutComments.split('surface.retireStaleHistorySeat()').length - 1, 2,
    'the composition root reaches the app retirement exactly twice: the reset callback and the publication port wiring')
  // The OTHER History composition line: the ONE scope bridge. A mutation to it
  // (e.g. isCurrent: () => true) would survive the behavioural suite because the
  // fixture mirrors this exact bridge, so lock its authoritative shape.
  const bridge = /captureHistoryScope: \(\) => \{([\s\S]*?)\n {6}\}/.exec(withoutComments)?.[1]
  assert.ok(bridge !== undefined, 'the composition root must inject the ONE History scope bridge')
  assert.ok(bridge.includes('sessionScope.capture()'), 'the bridge must capture ONE atomic authority scope')
  assert.ok(bridge.includes('sessionScope.isCurrent(scope)'), 'the bridge must re-read the SAME captured scope')
  assert.equal(withoutComments.split('captureHistoryScope').length - 1, 1,
    'exactly ONE History scope bridge exists in the composition root')
})


// ---------------------------------------------------------------------------
// H3B-05b: a throwing History cleanup AT PUBLICATION (plan §2.4 item 7)
// ---------------------------------------------------------------------------

test('H3B-05b: a throwing History cleanup at publication keeps the published owner, surfaces the error identity and closes once', async (t) => {
  const life = testLifecycle(t)
  const dispose = probeHistoryPanelDispose(life)
  const ownedFailures: unknown[] = []
  // The owned-task channel the app uses to report a retirement cleanup failure
  // (`routeTerminalSettlementFailure`): capture every primary failure identity.
  const capturingRunner: OwnedRunner = <T,>(
    _label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void => {
    const settle = (handler: ((value: T) => void) | undefined, value: T): void => {
      try { handler?.(value) } catch (error) { ownedFailures.push(error) }
    }
    let result: T | Promise<T>
    try { result = task() } catch (error) { settle(options.onError as ((value: T) => void) | undefined, error as T); return }
    Promise.resolve(result).then(
      value => settle(options.onResult as ((value: T) => void) | undefined, value),
      error => settle(options.onError as ((value: T) => void) | undefined, error as T),
    )
  }
  const h = buildSessionFixture(life, {
    source: filterSource([{ content: 'publication cleanup row', ts: 3 }]),
    runOwned: capturingRunner,
  })
  h.publish('session-a')
  h.app.start()
  await h.vt.waitForRender()
  await openHistory(h.vt, h.app)
  await waitFor(() => strip(h.vt.getViewport()).includes('publication cleanup row'))

  const boom = new Error('history cleanup at publication boom')
  dispose.armThrow(boom)

  assert.equal(await h.runtime.switchSession('session-b'), undefined,
    'the throwing History cleanup must NOT roll back or reject the Session commit')
  assert.equal(h.core.currentSessionId(), 'session-b',
    'the NEW owner stays published; the OLD owner is never restored')
  assert.equal(dispose.count(), 1,
    'the stale seat closed exactly once (the failure did not truncate the cleanup)')
  assert.equal(ownedFailures.length, 1, 'the cleanup failure reached the owned-failure channel')
  assert.equal(ownedFailures[0], boom, 'the ORIGINAL error identity is preserved')
  await h.vt.waitForRender()
  assert.ok(!panelVisible(h.vt), 'the retired History never stays painted')
  assert.equal(h.app.focusSeatForTest(), 'editor', 'the seat projects the live editor')

  // Positive control: the NEW owner's History still opens and acts normally.
  await openHistory(h.vt, h.app)
  assert.equal(h.captures.at(-1)!.sessionId, 'session-b')
  assert.equal(h.captures.at(-1)!.isCurrent(), true)
})
