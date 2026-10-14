/**
 * Phase 3A / PR-B gate: the editor-seat OPTIONAL TENANT arbitration.
 *
 * The editor seat is owned by exactly one physical occupant at a time. Three
 * BLOCKING owners already existed (Question, Approval, Save Location); this
 * suite pins the new, PRIVATE optional-tenant seam on top of them:
 *
 * - at most ONE optional tenant (`active` | `parked`) identified by a per-open
 *   token and the caller's own `isCurrent()` subject predicate;
 * - a REFUSE gate that never runs the factory while a blocking owner or a
 *   disposed surface exists (B-07);
 * - PARK before any modal mount/focus callback, so no intermediate tenant focus
 *   or reveal can be observed (B-03/B-05/B-06);
 * - restore of the SAME instance only after the LAST blocking owner left
 *   (B-02/B-04/B-11/B-12);
 * - exactly-once caller-owned close, with a late lease strictly inert
 *   (B-08/B-09/B-17);
 * - the seat projection / physical focus / input routing derive from the LIVE
 *   owner, never from a shadow flag (B-01/B-13/B-14/B-15/B-16/B-22/B-24).
 *
 * Every case drives the REAL production seam: a real `TuiApp`, a real
 * `VirtualTerminal`, the real Question flow, `ApprovalRuntime` and
 * `SaveLocationPrompt`. The optional tenant is only a CALLER of the private
 * `tryOpenOptionalSeatTenant` seam — it never simulates host park/restore.
 * @module @xmoon76/dsh-pi-tui/editor-seat-optional-tenant.test
 */

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { afterEach, test } from 'node:test'
import { initialStatusSnapshot } from '../src/domain/status/snapshot.ts'
import type { StatusStore } from '../src/domain/status/store.ts'
import { EditorRegistry } from '../src/extension/internal/editor-registry.ts'
import type { AdvancedInteractiveComponent } from '../src/extension/advanced-types.ts'
import type { EditorHost, ExtensionEditor, ExtensionView } from '../src/extension/public-types.ts'
import type { SaveLocationDeps, SaveLocationResult } from '../src/tui/interaction/save-location.ts'
import { HistoryPanel } from '../src/tui/panels/history-panel.ts'
import { TuiApp, type ApprovalOutcome } from '../src/tui-app.ts'
import { releaseProcessTuiSlot } from '../src/tui/process-slot.ts'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file is
 * disposed after each test — the process slot (the vendored fork keybindings
 * are process-global) is released only by the FINAL dispose, never by stop(). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** The visible viewport, stripped of ANSI, joined for substring checks. */
function viewport(vt: VirtualTerminal): string {
  return vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** Drain the coalesced projection microtasks (setFocusSeat / surface publish). */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// The optional-tenant CALLER side (the private seam's shape, structurally).
// ---------------------------------------------------------------------------

interface TestOptionalSeatSpec {
  readonly component: Component & Focusable
  readonly isCurrent: () => boolean
  readonly close: () => void
}

interface OptionalSeatSeam {
  tryOpenOptionalSeatTenant(create: () => TestOptionalSeatSpec): { close(): void } | undefined
}

/** One scripted optional tenant: a real Focusable component that owns its OWN
 * draft/selection state, records every delivered key, counts its ONE
 * caller-owned cleanup path and counts every FOCUS GAIN (a fabricated focus
 * transition is a defect, so the count is a first-class sink). */
interface Tenant {
  readonly component: Component & Focusable
  readonly keys: string[]
  closeCalls(): number
  draft(): string
  focusGains(): number
  setCurrent(value: boolean): void
  spec(): TestOptionalSeatSpec
}

function makeTenant(seed = '', onFocusLost?: () => void, onFocusGained?: () => void): Tenant {
  const state = { current: true, closes: 0, keys: [] as string[], draft: seed, focused: false, gains: 0 }
  const component: Component & Focusable = {
    get focused(): boolean {
      return state.focused
    },
    set focused(value: boolean) {
      const gained = value && !state.focused
      const lost = !value && state.focused
      if (gained) state.gains += 1
      state.focused = value
      if (lost) onFocusLost?.()
      if (gained) onFocusGained?.()
    },
    render: () => [`optional-tenant:${state.draft}`],
    invalidate: () => {},
    handleInput: (data) => {
      state.keys.push(data)
      // A printable key is appended to the tenant's OWN draft: the state must
      // survive a park/restore round-trip without being rebuilt.
      if (data.length === 1 && data >= ' ' && data <= '~') state.draft += data
    },
  }
  return {
    component,
    keys: state.keys,
    closeCalls: () => state.closes,
    draft: () => state.draft,
    focusGains: () => state.gains,
    setCurrent: (value) => { state.current = value },
    spec: () => ({
      component,
      isCurrent: () => state.current,
      close: () => { state.closes += 1 },
    }),
  }
}

/** Call the PRODUCTION private seam (never a test double): REFUSE is the
 * `undefined` capacity result. */
function openOptional(
  app: TuiApp,
  create: () => TestOptionalSeatSpec,
): { close(): void } | undefined {
  return (app as unknown as OptionalSeatSeam).tryOpenOptionalSeatTenant(create)
}

function openTenant(app: TuiApp, tenant: Tenant): { close(): void } | undefined {
  return openOptional(app, () => tenant.spec())
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface AppHarness {
  vt: VirtualTerminal
  app: TuiApp
  submissions: string[]
  steers: string[]
  focusReports: boolean[]
  exits(): number
  openTasks(): number
}

function startApp(registry?: EditorRegistry, history?: import('../src/client/history/search.ts').HistorySearchSource): AppHarness {
  const vt = new VirtualTerminal(100, 30)
  const submissions: string[] = []
  const steers: string[] = []
  const focusReports: boolean[] = []
  let exitCount = 0
  let openTaskCalls = 0
  const harness = {
    vt, submissions, steers, focusReports,
    exits: () => exitCount,
    openTasks: () => openTaskCalls,
  } as AppHarness
  const app = new TuiApp(vt, {
    onSubmit: (text) => { submissions.push(text) },
    onExit: () => { exitCount += 1 },
    onSteer: (text) => { steers.push(text) },
    onTerminalFocus: (focused) => { focusReports.push(focused) },
  }, {
    ...(registry === undefined ? {} : { editorRegistry: registry }),
    ...(history === undefined ? {} : { historySearchSource: history }),
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  // B4-B: the retired onOpenTasks sink becomes a spy on the production entry.
  const realEntry = app.enterTaskQuick.bind(app)
  app.enterTaskQuick = () => {
    const entered = realEntry.call(app)
    if (entered) openTaskCalls += 1
    return entered
  }
  app.start()
  harness.app = app
  startedApps.add(app)
  return harness
}

/** A Client-local save-location deps set with no real filesystem. */
function saveDeps(): SaveLocationDeps {
  return {
    resolveDirectory: (input) => input === './' ? '/tmp/dsh-pr-b-out' : input,
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

/** A replacement plugin editor whose view renders one mutable text row (the
 * real editor registry + component compiler path — no mocked seat). */
function rowsEditor(state: { rows: string[] }): ExtensionEditor {
  let doc = ''
  return {
    get component(): ExtensionView {
      return {
        kind: 'rows',
        rows: state.rows.map(row => ({ kind: 'text', spans: [{ text: row }] })),
      }
    },
    getText: () => doc,
    setText: (text) => { doc = text },
    getCursor: () => 0,
    setCursor: () => {},
    dispose: () => {},
  }
}

/** A plugin editor whose DOCUMENT write recompiles its live view through the
 * host (`viewSwap`) — the invalidate/HMR seam. The `component` getter is an
 * ACCESSOR on the object literal (a spread would freeze the first view). */
function registerLiveView(registry: EditorRegistry, id: string, state: { text: string }, priority = 0): void {
  registry.register({
    id,
    priority,
    create: (host: EditorHost) => ({
      get component(): ExtensionView {
        return { kind: 'text', spans: [{ text: state.text }] }
      },
      getText: () => state.text,
      setText: (text) => {
        state.text = text
        host.invalidate()
      },
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, `plugin-${id}`)
}

// ---------------------------------------------------------------------------
// B-14 (RED first): the plugin viewSwap gap while Save Location owns the seat
// ---------------------------------------------------------------------------

test('B-14: a plugin editor invalidate during Save Location cannot displace the SaveLocationFrame', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const state = { text: 'before' }
  registerLiveView(registry, 'live', state)
  app.setDraft('before')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('before'), `the plugin editor must be mounted first:\n${viewport(vt)}`)

  const promise = askSave(app)
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('Save session archive'),
    `the SaveLocationFrame must own the seat:\n${viewport(vt)}`,
  )

  // The plugin recompiles its live view WHILE the prompt owns the seat.
  app.setDraft('after')
  await vt.waitForRender()
  const screen = viewport(vt)
  assert.ok(screen.includes('Save session archive'), `the SaveLocationFrame must STAY mounted:\n${screen}`)
  assert.ok(!screen.includes('after'), `the recompiled view must not displace the prompt:\n${screen}`)

  // The prompt still owns input: Esc cancels it (never reaches the plugin).
  vt.sendInput('\x1b')
  assert.deepEqual(await promise, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('after'),
    `the LATEST compiled view must mount once the prompt settles:\n${viewport(vt)}`,
  )
  assert.equal(app.seatEditorForTest().id, 'live')
})

test('B-13: a plugin editor winner change during a Question cannot displace the QuestionFrame', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const a = { rows: ['editor A'] }
  registry.register({ id: 'a', priority: 0, create: () => rowsEditor(a) }, 'plugin-a')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('editor A'))

  const promise = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('continue?'))

  const b = { rows: ['editor B'] }
  registry.register({ id: 'b', priority: -1, create: () => rowsEditor(b) }, 'plugin-b')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  const screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `the QuestionFrame must STAY mounted:\n${screen}`)
  assert.ok(!screen.includes('editor B'), `the new winner must not displace the frame:\n${screen}`)

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('editor B'), 'the latest winner mounts after settle')
})

// ---------------------------------------------------------------------------
// B-01/B-07: activation, real key delivery, and the REFUSE gate
// ---------------------------------------------------------------------------

test('B-01: an optional tenant becomes the seat occupant, takes real keys, and never touches the host draft', async () => {
  const { vt, app, submissions } = startApp()
  await vt.waitForRender()
  app.setDraft('host draft')
  await vt.waitForRender()

  const tenant = makeTenant()
  const lease = openTenant(app, tenant)
  assert.notEqual(lease, undefined, 'an unblocked open must return a lease')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('optional-tenant:'), `the tenant must be projected:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), tenant.component, 'focus must follow the tenant')
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the derived seat must be the tenant panel')

  vt.sendInput('h')
  vt.sendInput('i')
  await vt.waitForRender()
  assert.deepEqual(tenant.keys, ['h', 'i'], 'the tenant must receive the real keys')
  assert.equal(tenant.draft(), 'hi', 'the tenant owns its own state')
  assert.ok(viewport(vt).includes('optional-tenant:hi'), `the tenant repaint must be visible:\n${viewport(vt)}`)
  assert.equal(app.hostEditorTextForTest(), 'host draft', 'the host draft must stay untouched')
  assert.deepEqual(submissions, [], 'no Host submission may fire behind the tenant')

  lease?.close()
  assert.equal(tenant.closeCalls(), 1, 'the caller close runs exactly once')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'the tenant must leave the seat')
})

test('B-07: an optional request while a blocking owner is live is REFUSED without running the factory', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()

  // Question active.
  const question = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  let factoryCalls = 0
  const refusedDuringQuestion = openOptional(app, () => {
    factoryCalls += 1
    return makeTenant().spec()
  })
  assert.equal(refusedDuringQuestion, undefined, 'a question blocks the open')
  assert.equal(factoryCalls, 0, 'the factory must never run for a refused request')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()

  // Save Location active.
  const save = askSave(app)
  await vt.waitForRender()
  const refusedDuringSave = openOptional(app, () => {
    factoryCalls += 1
    return makeTenant().spec()
  })
  assert.equal(refusedDuringSave, undefined, 'a save prompt blocks the open')
  assert.equal(factoryCalls, 0)
  vt.sendInput('\x1b')
  assert.deepEqual(await save, { kind: 'cancelled' })
  await vt.waitForRender()

  // Approval active.
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  const refusedDuringApproval = openOptional(app, () => {
    factoryCalls += 1
    return makeTenant().spec()
  })
  assert.equal(refusedDuringApproval, undefined, 'an approval blocks the open')
  assert.equal(factoryCalls, 0)
  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()

  // The same request succeeds once nothing blocks.
  const tenant = makeTenant()
  assert.notEqual(openTenant(app, tenant), undefined, 'an unblocked request must be accepted')
  await settle()
  assert.equal(app.focusSeatForTest(), 'editor-panel')
})

// ---------------------------------------------------------------------------
// B-02..B-06: PARK across Question / Save Location / Approval, restore LAST
// ---------------------------------------------------------------------------

test('B-02: a Question parks the tenant; the SAME instance and its own state return on settle', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  vt.sendInput('a')
  vt.sendInput('b')
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant owns the keyboard first')
  const gainsAtOpen = tenant.focusGains()

  const question = app.askQuestions([{ id: 'q1', question: 'park me?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('park me?'), `the question must own the seat:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'the parked tenant leaves the seat')
  assert.notEqual(app.focusedComponentForTest(), tenant.component, 'a parked tenant is not an input target')
  assert.equal(tenant.focusGains(), gainsAtOpen, 'the tenant must never regain focus while parked')
  assert.equal(tenant.closeCalls(), 0, 'parking must never dispose the tenant')

  // Keys while parked belong to the modal: the tenant sees nothing.
  const keysWhileParked = tenant.keys.length
  vt.sendInput('z')
  assert.equal(tenant.keys.length, keysWhileParked, 'a PARKED tenant must not receive input')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the SAME tenant component returns')
  assert.equal(tenant.draft(), 'ab', 'the tenant keeps its own draft across the park')
  assert.ok(viewport(vt).includes('optional-tenant:ab'), `the restored state must be painted:\n${viewport(vt)}`)
  assert.ok(tenant.focusGains() > gainsAtOpen, 'the tenant is the focused seat owner again after the last blocker')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-03: two queued Questions never refocus or re-project the tenant in between', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  // Two questions queue FIFO; the FIRST one supersedes the tenant.
  const first = app.askQuestions([{ id: 'q1', question: 'question one?', options: [{ label: 'Yes' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'question two?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('question one?'))
  const gainsAtPark = tenant.focusGains()

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  // The middle of the FIFO: the second flow took the seat DIRECTLY.
  assert.ok(viewport(vt).includes('question two?'), `the second flow must be mounted:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'no tenant projection between two queued flows')
  assert.equal(tenant.focusGains(), gainsAtPark, 'no tenant focus between two queued flows')
  assert.notEqual(app.focusedComponentForTest(), tenant.component)

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the LAST settle restores the tenant')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-04: a Save Location prompt owns the seat while the tenant waits', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  vt.sendInput('a')
  const gainsAtOpen = tenant.focusGains()

  const save = askSave(app)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Save session archive'), `the prompt must own the seat:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'))
  assert.equal(tenant.focusGains(), gainsAtOpen, 'no tenant focus while the prompt owns the seat')
  const keysWhileParked = tenant.keys.length
  vt.sendInput('z')
  assert.equal(tenant.keys.length, keysWhileParked, 'the prompt consumes keys, not the tenant')

  vt.sendInput('\x1b')
  assert.deepEqual(await save, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  assert.equal(tenant.draft(), 'a', 'the tenant draft survives')
  assert.ok(tenant.focusGains() > gainsAtOpen, 'the tenant is focused again after the prompt settles')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-05: an Approval overlay owns the keyboard while the tenant is PARKED', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  const gainsAtOpen = tenant.focusGains()

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'), `the approval must be visible:\n${viewport(vt)}`)
  assert.notEqual(app.focusedComponentForTest(), tenant.component, 'the approval owns the keyboard')
  assert.notEqual(app.focusedComponentForTest(), null)
  assert.equal(tenant.focusGains(), gainsAtOpen, 'the tenant must not flash back into focus')
  const keysWhileParked = tenant.keys.length
  vt.sendInput('q')
  assert.equal(tenant.keys.length, keysWhileParked, 'the approval consumes the ordinary keys')

  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant returns after the approval')
  assert.equal(tenant.focusGains(), gainsAtOpen + 1)
  assert.equal(tenant.closeCalls(), 0)
})

test('B-06: a queued A → B approval restores the tenant only after the LAST prompt', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  const gainsAtOpen = tenant.focusGains()

  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'first' })
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'second' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'), 'the first approval is on screen')
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  await vt.waitForRender()
  // The queue handed over: the SECOND prompt owns the screen and the tenant
  // must still be parked (no restore in between).
  assert.ok(viewport(vt).includes('fs'), `the second approval must be on screen:\n${viewport(vt)}`)
  assert.equal(tenant.focusGains(), gainsAtOpen, 'no tenant focus between two queued approvals')
  assert.notEqual(app.focusedComponentForTest(), tenant.component)
  vt.sendInput('n')
  assert.equal(await second, 'rejected')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the drained queue releases the tenant')
  assert.equal(tenant.closeCalls(), 0)
})

// ---------------------------------------------------------------------------
// B-08..B-12: identity, replacement, reentrancy, staleness
// ---------------------------------------------------------------------------

test('B-08: a newer tenant replaces the old one exactly once; the late lease is inert', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const a = makeTenant('A')
  const b = makeTenant('B')
  const leaseA = openTenant(app, a)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), a.component)

  const leaseB = openTenant(app, b)
  await vt.waitForRender()
  assert.equal(a.closeCalls(), 1, 'the replaced tenant is released exactly once')
  assert.equal(b.closeCalls(), 0)
  assert.equal(app.focusedComponentForTest(), b.component, 'the newer tenant owns the seat')
  assert.ok(viewport(vt).includes('optional-tenant:B'))

  vt.sendInput('z')
  assert.deepEqual(b.keys, ['z'], 'the newer tenant receives the keys')
  assert.deepEqual(a.keys, [], 'the replaced tenant receives nothing')

  // A late close of the OLD lease must be a strict no-op for the new record.
  leaseA?.close()
  assert.equal(a.closeCalls(), 1, 'a late old lease must not close twice')
  assert.equal(b.closeCalls(), 0, 'a late old lease must never close the newer tenant')
  assert.equal(app.focusedComponentForTest(), b.component)
  assert.equal(b.draft(), 'Bz', 'the newer tenant state is untouched')
  leaseB?.close()
  assert.equal(b.closeCalls(), 1)
})

test('B-09: a tenant opened from inside the old close wins; the outer candidate cleans itself up once', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const a = makeTenant('A')
  const b = makeTenant('B')
  const c = makeTenant('C')
  let cLease: { close(): void } | undefined
  // Tenant A's ONE cleanup path synchronously opens C (the classic window).
  const leaseA = openOptional(app, () => ({
    component: a.component,
    isCurrent: () => true,
    close: () => {
      a.spec().close()
      cLease = openTenant(app, c)
    },
  }))
  assert.notEqual(leaseA, undefined)
  await vt.waitForRender()

  // The OUTER request (B) retires A first — inside that close, C wins.
  const leaseB = openTenant(app, b)
  assert.equal(leaseB, undefined, 'the outer request must lose to the newer C')
  assert.equal(a.closeCalls(), 1)
  assert.equal(b.closeCalls(), 1, 'the losing candidate releases exactly itself, once')
  assert.notEqual(cLease, undefined, 'C must be installed')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), c.component, 'C owns the seat (never the stale B)')
  assert.notEqual(app.focusedComponentForTest(), b.component)
  vt.sendInput('q')
  assert.deepEqual(c.keys, ['q'])
  assert.deepEqual(b.keys, [], 'the losing candidate never receives input')
  assert.equal(app.assertOverlayForestForTest(), undefined)
})

test('B-10: a factory that synchronously opens a modal invalidates its own request', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  let factoryCalls = 0
  let inner: Promise<unknown> | undefined
  const lease = openOptional(app, () => {
    factoryCalls += 1
    // The factory itself re-enters the host: a Question takes the seat.
    inner = app.askQuestions([{ id: 'q1', question: 'born inside a factory?', options: [{ label: 'Ok' }] }])
    return tenant.spec()
  })
  assert.equal(lease, undefined, 'the invalidated candidate must not install')
  assert.equal(factoryCalls, 1, 'the factory ran exactly once (the gate was open when it started)')
  assert.equal(tenant.closeCalls(), 1, 'the invalidated candidate releases exactly itself, once')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('born inside a factory?'), `the modal must be answerable:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'no hidden second occupant may exist')
  assert.notEqual(app.focusedComponentForTest(), tenant.component)
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await inner, [{ id: 'q1', selected: ['Ok'] }])
})

test('B-11: a caller close while PARKED is not resurrected by the blocking settle', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const winner = { rows: ['latest editor winner'] }
  registry.register({ id: 'w', priority: 0, create: () => rowsEditor(winner) }, 'plugin-w')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('latest editor winner'))

  const tenant = makeTenant()
  const lease = openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)

  const question = app.askQuestions([{ id: 'q1', question: 'close me while parked?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('close me while parked?'))
  // The caller closes the PARKED tenant: its lease drops the identity.
  lease?.close()
  assert.equal(tenant.closeCalls(), 1)

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'a closed tenant must never resurrect')
  assert.ok(viewport(vt).includes('latest editor winner'), 'the latest editor winner owns the seat')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  assert.equal(tenant.closeCalls(), 1)
})

test('B-12: a PARKED tenant whose subject went stale is retired, never restored', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const winner = { rows: ['stale-subject fallback'] }
  registry.register({ id: 'w', priority: 0, create: () => rowsEditor(winner) }, 'plugin-w')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()

  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)

  const question = app.askQuestions([{ id: 'q1', question: 'stale subject?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  tenant.setCurrent(false)
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'a stale tenant is retired on the restore gate')
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'a stale tenant must not be restored')
  assert.ok(viewport(vt).includes('stale-subject fallback'))
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
})

// ---------------------------------------------------------------------------
// B-15..B-18: HMR, fullscreen, final disposal and failure aggregation
// ---------------------------------------------------------------------------

test('B-15: a plugin editor unload while the tenant is PARKED keeps the frame and spares the tenant', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  let pluginDisposed = 0
  const state = { text: 'plugin view' }
  registry.register({
    id: 'hmr',
    priority: 0,
    create: (host: EditorHost) => ({
      get component(): ExtensionView {
        return { kind: 'text', spans: [{ text: state.text }] }
      },
      getText: () => state.text,
      setText: (text) => {
        state.text = text
        host.invalidate()
      },
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => { pluginDisposed += 1 },
    }),
  }, 'plugin-hmr')
  app.setDraft('plugin view')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('plugin view'))

  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  const question = app.askQuestions([{ id: 'q1', question: 'unload under question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()

  // The plugin is unloaded (HMR) WHILE the tenant is parked.
  registry.dispose('hmr')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('unload under question?'), 'the QuestionFrame must stay mounted')
  assert.ok(!viewport(vt).includes('plugin view'), 'the unloaded view must not be projected')
  assert.equal(pluginDisposed, 1, 'the holder releases its old instance exactly once')
  assert.equal(tenant.closeCalls(), 0, 'the parked tenant must not be disposed with the plugin')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant outranks the unloaded plugin')
  assert.ok(viewport(vt).includes('optional-tenant:'))
  assert.equal(pluginDisposed, 1)
  assert.equal(tenant.closeCalls(), 0)
})

test('B-16: regular ↔ fullscreen keeps ONE logical tenant record', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  let factoryCalls = 0
  const lease = openOptional(app, () => {
    factoryCalls += 1
    return tenant.spec()
  })
  await vt.waitForRender()
  vt.sendInput('a')
  assert.deepEqual(tenant.keys, ['a'])

  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the shared record focuses in fullscreen')
  assert.ok(viewport(vt).includes('optional-tenant:a'), `the tenant paints in fullscreen:\n${viewport(vt)}`)
  vt.sendInput('b')
  assert.deepEqual(tenant.keys, ['a', 'b'], 'fullscreen keys reach the tenant')

  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the same record focuses back in regular')
  assert.ok(viewport(vt).includes('optional-tenant:ab'))
  assert.equal(factoryCalls, 1, 'a fullscreen swap must never re-create the tenant')
  assert.equal(tenant.closeCalls(), 0, 'a fullscreen swap must never close the tenant')
  lease?.close()
  assert.equal(tenant.closeCalls(), 1)
})

test('B-17: final dispose releases an ACTIVE tenant exactly once', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  app.dispose()
  assert.equal(tenant.closeCalls(), 1, 'the tenant is released by the final disposal')
  assert.equal(app.isDisposed(), true)
  app.dispose()
  assert.equal(tenant.closeCalls(), 1, 'dispose is idempotent for the tenant too')
})

test('B-17b: final dispose releases a PARKED tenant exactly once, before the modal teardown', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  const question = app.askQuestions([{ id: 'q1', question: 'dispose under a question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  app.dispose()
  assert.equal(tenant.closeCalls(), 1, 'a parked tenant is still released by the final disposal')
  await assert.rejects(question)
})

test('B-18: a throwing tenant close and a throwing sibling teardown surface as ordered AggregateError entries', async () => {
  const vt = new VirtualTerminal(100, 30)
  const store = {
    snapshot: () => initialStatusSnapshot('0.0.0'),
    subscribe: () => () => { throw new Error('store teardown boom') },
    update: () => {},
  } as unknown as StatusStore
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()

  const tenant = makeTenant()
  const lease = openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => true,
    close: () => { throw new Error('tenant close boom') },
  }))
  assert.notEqual(lease, undefined)

  let caught: unknown
  try {
    app.dispose()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AggregateError, `expected an AggregateError, got ${String(caught)}`)
  const errors = (caught as AggregateError).errors.map(entry => (entry as Error).message)
  assert.deepEqual(
    errors,
    ['tenant close boom', 'store teardown boom'],
    'both independent obligations are attempted, in batch order',
  )
  // The final teardown FAILED, so the process slot is deliberately kept
  // claimed (the fail-closed contract). Release it here so the remaining
  // cases of this file can start their own surface.
  releaseProcessTuiSlot()
})

// ---------------------------------------------------------------------------
// B-19..B-25: preemption, overlap, focus handoff, History, input routing
// ---------------------------------------------------------------------------

test('B-19: a Question superseding Save Location never restores the tenant mid-preemption', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  vt.sendInput('a')
  const gainsAtOpen = tenant.focusGains()

  const save = askSave(app)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Save session archive'))

  const question = app.askQuestions([{ id: 'q1', question: 'supersede the save?', options: [{ label: 'Yes' }] }])
  assert.deepEqual(await save, { kind: 'cancelled' }, 'the superseded prompt is cancelled, never left pending')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('supersede the save?'), `the question must own the seat:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'the tenant must not flash during the handoff')
  assert.equal(tenant.focusGains(), gainsAtOpen, 'no transient tenant focus during the preemption')
  assert.equal(tenant.closeCalls(), 0)

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  assert.equal(tenant.draft(), 'a', 'the tenant keeps its own state across the preemption')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-20: an Approval superseding Save Location restores the tenant only after the approval', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  vt.sendInput('a')
  const gainsAtOpen = tenant.focusGains()

  const save = askSave(app)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Save session archive'))

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'preempt the save' })
  assert.deepEqual(await save, { kind: 'cancelled' }, 'the save prompt is cancelled by the approval')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'), `the approval must own the screen:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('optional-tenant:'), 'the tenant must not revive during the preemption')
  assert.equal(tenant.focusGains(), gainsAtOpen, 'no transient tenant focus during the approval preemption')
  assert.equal(tenant.closeCalls(), 0)

  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant returns after the approval')
  assert.equal(tenant.draft(), 'a')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-21: a legal Approval + Question overlap keeps the modal owner and the tenant PARKED', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  const gainsAtOpen = tenant.focusGains()

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'overlap with a question' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'))

  // A question presented while the approval is live suspends the overlay and
  // takes the seat (the pre-existing Host precedence).
  const question = app.askQuestions([{ id: 'q1', question: 'overlap question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('overlap question?'), `the question owns the seat:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('bash'), 'the approval is suspended under the question')
  assert.equal(tenant.focusGains(), gainsAtOpen)
  // A modal-safe inspection key must not leak into the parked tenant.
  const keysAtOverlap = tenant.keys.length
  vt.sendInput('\x0f')
  assert.equal(tenant.keys.length, keysAtOverlap, 'the modal inspection whitelist never reaches the tenant')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  // The approval is restored and re-focused; the tenant stays PARKED because
  // another blocking owner is still live.
  assert.ok(viewport(vt).includes('bash'), `the approval must be restored:\n${viewport(vt)}`)
  assert.notEqual(app.focusedComponentForTest(), tenant.component, 'the restored approval keeps the keyboard')
  assert.equal(tenant.focusGains(), gainsAtOpen, 'the tenant must stay parked under the approval')

  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant returns after the LAST blocker')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-22: a capturing overlay keeps the keyboard; the tenant regains it only when the overlay closes', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  const lease = openTenant(app, tenant)
  await vt.waitForRender()
  const gainsAtOpen = tenant.focusGains()

  app.openPicker([{ value: 'a', label: 'pick-me' }], () => {}, () => {})
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('pick-me'), `the picker must be visible:\n${viewport(vt)}`)
  assert.notEqual(app.focusedComponentForTest(), tenant.component, 'the overlay is the keyboard owner')
  assert.equal(tenant.focusGains(), gainsAtOpen, 'the tenant tail must not steal the overlay focus')
  const keysBefore = tenant.keys.length
  vt.sendInput('z')
  assert.equal(tenant.keys.length, keysBefore, 'overlay keys never reach the tenant')
  assert.equal(app.assertOverlayForestForTest(), undefined)

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant is the live seat owner again')
  vt.sendInput('k')
  assert.deepEqual(tenant.keys.slice(keysBefore), ['k'])
  assert.equal(tenant.closeCalls(), 0)
  lease?.close()
})

test('B-23: History is the first REAL optional-seat tenant; a Question parks and restores the SAME seat', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    historySearchSource: {
      search: async () => ({
        results: [{ id: 'h1', content: 'history entry', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
        exhausted: true,
      }),
    },
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  assert.ok(viewport(vt).includes('Input History'), `the History tenant owns the editor seat:\n${viewport(vt)}`)
  // Phase 3B / B3-A retired the old managed History overlay: no overlay node is
  // created and no responsive frame survives.
  assert.equal(app.overlayGraphState().handles, 0, 'History is a SEAT tenant, never an overlay node')
  vt.sendInput('abc')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('abc'), 'the query is typed into the History panel')

  const question = app.askQuestions([{ id: 'q1', question: 'history under a question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('history under a question?'))
  assert.ok(!viewport(vt).includes('Input History'), 'the parked History tenant is not painted')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Input History'), 'the SAME History tenant is restored after the settle')
  assert.ok(viewport(vt).includes('abc'), 'the query survives the park/restore round trip')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('Input History'), 'the panel keeps its own Esc close contract')
})

test('B-24: the tenant takes ordinary keys; Host-reserved and protocol input keeps its owner', async () => {
  const { vt, app, submissions, steers, exits } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()

  vt.sendInput('x')
  vt.sendInput('\r')
  assert.deepEqual(tenant.keys, ['x', '\r'], 'ordinary keys and Enter belong to the tenant')
  assert.deepEqual(submissions, [], 'Enter must never submit the hidden host editor')
  vt.sendInput('\x13')
  assert.deepEqual(tenant.keys, ['x', '\r', '\x13'], 'the steer chord is the tenant key here')
  assert.deepEqual(steers, [], 'the Host steer action must never fire behind the tenant')

  // Host-reserved: physical Escape is the lifecycle seam.
  vt.sendInput('\x1b')
  assert.deepEqual(tenant.keys, ['x', '\r', '\x13'], 'Escape is Host-reserved, never the tenant')
  // Host-reserved: the effective exit key stays on the Host path.
  vt.sendInput('\x03')
  vt.sendInput('\x03')
  assert.deepEqual(tenant.keys, ['x', '\r', '\x13'], 'Ctrl+C is Host-reserved, never the tenant')
  assert.ok(exits() >= 1, 'Ctrl+C must reach the Host exit path')
  // Terminal protocol: a mouse report bypasses the host key ladder entirely
  // (the fullscreen viewport listener owns it), so the tenant never sees the
  // raw SGR chunk as a key.
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('\x1b[<0;5;5M')
  assert.deepEqual(
    tenant.keys.filter(key => key.includes('[<')),
    [],
    'mouse chunks never reach the tenant as keys',
  )
  assert.deepEqual(submissions, [], 'the mouse chunk must not submit either')
  app.setFullscreen(false)
  await vt.waitForRender()
  // Terminal protocol: a Kitty key-RELEASE artifact is consumed upstream.
  vt.sendInput('\x1b[97;1:3u')
  assert.deepEqual(tenant.keys, ['x', '\r', '\x13'], 'key-release artifacts never reach the tenant')
  assert.equal(app.assertOverlayForestForTest(), undefined)
})

test('B-25: an approval mount whose focus callback settles it releases the losing mount', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const controller = new AbortController()
  let trigger: (() => void) | undefined
  const tenant = makeTenant('', () => {
    const hook = trigger
    trigger = undefined
    if (hook !== undefined) hook()
  })
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)

  let second: Promise<ApprovalOutcome> | undefined
  trigger = () => {
    // The prior focused component loses focus to the mounting approval: the
    // OLD prompt settles at once and a NEWER approval is opened from inside
    // the mount's own callback.
    controller.abort()
    second = app.showApprovalPrompt({ toolName: 'fs', reason: 'the newer approval' })
  }
  const first = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'the losing approval',
    signal: controller.signal,
  })
  assert.equal(await first, 'cancelled', 'the aborted prompt settles cancelled')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('fs'), `only the newer prompt may be mounted:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('bash'), 'the losing mount must be physically released')
  assert.equal(app.ownedApprovalFramesForTest(), 1, 'the losing mount frame is disposed, never leaked')
  assert.equal(app.assertOverlayForestForTest(), undefined)

  // A fullscreen swap replays the remount registrations: the stale prompt
  // must not come back (its handle was never registered for a rebind).
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('fs'), `the newer prompt survives the swap:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('bash'), 'the stale prompt must never be re-mounted')

  vt.sendInput('y')
  assert.equal(await second, 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant returns after the newer approval')
  assert.equal(tenant.closeCalls(), 0)
})

// ---------------------------------------------------------------------------
// Resize: the plan's target geometries must not lose focus or tenant state
// ---------------------------------------------------------------------------

test('sizes: a resize cycle keeps the tenant projected and focused at every target geometry', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  const lease = openTenant(app, tenant)
  await vt.waitForRender()
  vt.sendInput('a')
  vt.sendInput('b')

  for (const [columns, rows] of [[80, 24], [120, 40], [200, 60], [80, 10]] as const) {
    vt.resize(columns, rows)
    await vt.waitForRender()
    assert.equal(
      app.focusedComponentForTest(),
      tenant.component,
      `the tenant must stay the keyboard owner after a ${columns}x${rows} resize`,
    )
    vt.sendInput('c')
    await vt.waitForRender()
    assert.equal(
      tenant.draft().endsWith('c'),
      true,
      `the tenant must keep receiving keys after a ${columns}x${rows} resize`,
    )
    if (rows >= 24) {
      assert.ok(
        viewport(vt).includes('optional-tenant:abc'),
        `the tenant projection must survive a ${columns}x${rows} resize:\n${viewport(vt)}`,
      )
    }
  }
  assert.equal(app.focusSeatForTest(), 'editor-panel')
  assert.equal(tenant.closeCalls(), 0, 'a resize must never close the tenant')
  assert.equal(tenant.draft(), 'abcccc', 'the tenant keeps its own state across every resize')
  lease?.close()
  assert.equal(tenant.closeCalls(), 1)
})

// ---------------------------------------------------------------------------
// Round-1 review fixes: protocol delivery, settle-tail focus, dead-flow fence,
// ACTIVE-stale re-projection, and the real suspended-root FIFO control
// ---------------------------------------------------------------------------

/** A minimal ADVANCED interactive overlay probe: the real public host mount
 * (`showAdvancedInteractiveOverlay`) with focus/blur counters as the sink. */
function advancedOverlayProbe(text: string, onFocused?: () => void, onBlurred?: () => void): {
  component: AdvancedInteractiveComponent
  focusCount(): number
  blurCount(): number
} {
  const state = { focus: 0, blur: 0 }
  return {
    component: {
      render: () => ({ kind: 'text', spans: [{ text }] }),
      handleInput: () => false,
      onFocus: () => {
        state.focus += 1
        onFocused?.()
      },
      onBlur: () => {
        state.blur += 1
        onBlurred?.()
      },
      dispose: () => {},
    },
    focusCount: () => state.focus,
    blurCount: () => state.blur,
  }
}

test('B-03b: a suspended overlay root is never revealed or refocused between two queued Questions', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  // A REAL capturing overlay root with its own focus/blur recorders is
  // suspended by the question flow.
  const root = advancedOverlayProbe('queued-root')
  app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('queued-root'), `the root must be up first:\n${viewport(vt)}`)
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const first = app.askQuestions([{ id: 'q1', question: 'first queued?', options: [{ label: 'Yes' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'second queued?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('first queued?'))
  assert.ok(!viewport(vt).includes('queued-root'), 'the overlay root is suspended under the flow')
  assert.equal(root.blurCount(), 1, 'the suspension releases the keyboard exactly once')
  const gainsWhileParked = tenant.focusGains()
  const focusWhileSuspended = root.focusCount()
  const blurWhileSuspended = root.blurCount()

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  // The FIFO handover: the second flow took the seat directly — the suspended
  // root must NOT be briefly revealed and the tenant/root must not regain
  // focus in the gap.
  assert.ok(viewport(vt).includes('second queued?'), `the second flow must be mounted:\n${viewport(vt)}`)
  assert.ok(!viewport(vt).includes('queued-root'), 'the suspended root must not be revealed between queued flows')
  assert.equal(root.focusCount(), focusWhileSuspended, 'no transient root focus between queued flows')
  assert.equal(root.blurCount(), blurWhileSuspended, 'no transient root blur between queued flows')
  assert.equal(tenant.focusGains(), gainsWhileParked, 'the tenant must not regain focus between queued flows')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  await vt.waitForRender()
  // The root's own focus intent survives the graph: it is restored and
  // re-focused exactly once, and the tenant is ACTIVE again underneath it.
  assert.ok(viewport(vt).includes('queued-root'), `the root must be restored:\n${viewport(vt)}`)
  assert.equal(root.focusCount(), focusWhileSuspended + 1, 'the root is refocused once on restore')
  assert.equal(root.blurCount(), blurWhileSuspended)
  assert.notEqual(app.focusedComponentForTest(), tenant.component)
  assert.equal(app.focusSeatForTest(), 'overlay')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-24b: host-classified protocol chunks never reach the tenant on either screen', async () => {
  const { vt, app, focusReports } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  const protocolChunks = ['\x1b[<0;5;5M', '\x1b[<64;5;5M', '\x1b[M !!', '\x1b[97;1:3u']
  for (const chunk of protocolChunks) vt.sendInput(chunk)
  assert.deepEqual(tenant.keys, [], 'no host-classified protocol chunk may reach the tenant (regular screen)')

  app.setFullscreen(true)
  await vt.waitForRender()
  for (const chunk of [...protocolChunks, '\x1b[I', '\x1b[O']) vt.sendInput(chunk)
  assert.deepEqual(tenant.keys, [], 'no host-classified protocol chunk may reach the tenant (fullscreen)')
  assert.deepEqual(
    focusReports,
    [true, false],
    'the host focus decoder must still observe both focus reports',
  )

  // Ordinary keys stay the tenant's on the swapped screen...
  vt.sendInput('x')
  assert.deepEqual(tenant.keys, ['x'], 'ordinary keys still reach the tenant in fullscreen')
  // ...and a bracketed PASTE is user TEXT, not protocol: it still reaches the
  // focused component, exactly as it does for the host editor.
  vt.sendInput('\x1b[200~hi\x1b[201~')
  assert.deepEqual(tenant.keys, ['x', '\x1b[200~hi\x1b[201~'], 'paste text is not protocol input')
  assert.equal(tenant.closeCalls(), 0)
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
})

test('B-26: a capturing overlay opened by the tenant focus callback during the Question restore keeps the keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const overlay = advancedOverlayProbe('newer overlay')
  let arm: (() => void) | undefined
  const tenant = makeTenant('', undefined, () => {
    const run = arm
    arm = undefined
    run?.()
  })
  openTenant(app, tenant)
  await vt.waitForRender()
  const question = app.askQuestions([{ id: 'q1', question: 'restore tail?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  // Arm: the NEXT tenant focus gain (the restore) synchronously mounts a
  // capturing overlay — the newer owner of the keyboard.
  arm = () => { app.showAdvancedInteractiveOverlay(overlay.component) }
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(overlay.focusCount(), 1, 'the newer overlay gains focus exactly once')
  assert.equal(overlay.blurCount(), 0, 'the settle tail must not blur the newer owner')
  assert.ok(viewport(vt).includes('newer overlay'), `the newer owner must stay painted:\n${viewport(vt)}`)
  assert.equal(tenant.closeCalls(), 0)
})

test('B-26b: a capturing overlay opened during the Save Location restore keeps the keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const overlay = advancedOverlayProbe('save-tail overlay')
  let arm: (() => void) | undefined
  const tenant = makeTenant('', undefined, () => {
    const run = arm
    arm = undefined
    run?.()
  })
  openTenant(app, tenant)
  await vt.waitForRender()
  const save = askSave(app)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Save session archive'))
  arm = () => { app.showAdvancedInteractiveOverlay(overlay.component) }
  vt.sendInput('\x1b')
  assert.deepEqual(await save, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.equal(overlay.focusCount(), 1, 'the newer overlay gains focus exactly once')
  assert.equal(overlay.blurCount(), 0, 'the save settle tail must not blur the newer owner')
  assert.ok(viewport(vt).includes('save-tail overlay'), `the newer owner must stay painted:\n${viewport(vt)}`)
  assert.equal(tenant.closeCalls(), 0)
})

test('B-27: a Save Location disposal that cancels the superseding Question never mounts a dead frame', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()

  const questionController = new AbortController()
  let completionRegistered = false
  let cancelQuestionOnCompletionAbort: (() => void) | undefined
  const deps: SaveLocationDeps = {
    ...saveDeps(),
    // A REAL completion subscriber that reacts to the prompt's disposal by
    // cancelling the flow that superseded the prompt.
    complete: (_raw, signal) => {
      completionRegistered = true
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          cancelQuestionOnCompletionAbort?.()
          resolve(null)
        })
      })
    },
  }
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  await vt.waitForRender()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.equal(completionRegistered, true, 'the prompt must have issued its initial completion')
  assert.ok(viewport(vt).includes('Save session archive'))

  cancelQuestionOnCompletionAbort = () => questionController.abort()
  const question = app.askQuestions(
    [{ id: 'q1', question: 'dead frame?', options: [{ label: 'Yes' }] }],
    questionController.signal,
  )
  // The preemption settles the save, whose disposal aborts the new flow: the
  // flow promise must settle (never hang) and its frame must never mount.
  await assert.rejects(question)
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('dead frame?'), `a cancelled flow must never mount a frame:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the live owner keeps the seat')
  assert.equal(app.focusSeatForTest(), 'editor-panel')
  assert.equal(tenant.closeCalls(), 0)
  assert.deepEqual(await save, { kind: 'cancelled' }, 'the superseded prompt still settles cancelled')
})

test('B-28: an ACTIVE tenant whose subject goes stale is retired at the input entry', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  tenant.setCurrent(false)
  vt.sendInput('x')
  await vt.waitForRender()
  assert.deepEqual(tenant.keys, [], 'a stale tenant must receive no key')
  assert.equal(tenant.closeCalls(), 1, 'the stale ACTIVE tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the stale panel must leave the seat:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component, 'the live owner takes over')
  assert.equal(app.focusSeatForTest(), 'editor')
})

test('B-29: an ACTIVE tenant whose subject goes stale is retired and re-projected at a screen swap', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  tenant.setCurrent(false)

  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'the swap retires the stale ACTIVE tenant exactly once')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the stale panel must not survive the swap:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  assert.equal(app.focusSeatForTest(), 'editor')

  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'the retirement is exactly once across both swaps')
  assert.ok(!viewport(vt).includes('optional-tenant:'))
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
})

test('B-29b: a stale ACTIVE tenant is retired even when a restored overlay keeps the keyboard across the swap', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  // A REMOUNTABLE capturing overlay: it survives the swap and reclaims the
  // keyboard, so the swap's own re-projection — not a focus-restore entry — is
  // what has to retire the stale tenant.
  const overlay = advancedOverlayProbe('swap-root')
  app.showAdvancedInteractiveOverlay(overlay.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('swap-root'), `the overlay must be up first:\n${viewport(vt)}`)
  tenant.setCurrent(false)

  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'the swap retires the stale ACTIVE tenant exactly once')
  assert.ok(
    !viewport(vt).includes('optional-tenant:'),
    `the stale panel must not survive the swap even behind an overlay:\n${viewport(vt)}`,
  )
  assert.ok(viewport(vt).includes('swap-root'), `the restored overlay must keep the keyboard:\n${viewport(vt)}`)
  assert.notEqual(app.focusedComponentForTest(), tenant.component)
  assert.equal(app.focusSeatForTest(), 'overlay')
})

test('B-24c: a stale-but-focused tenant receives no host-classified protocol chunk and is retired', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  // Stale but still PHYSICALLY focused: the fork's fall-through would deliver
  // the raw chunk to it, so the protocol fence must cover the physical fact.
  tenant.setCurrent(false)
  vt.sendInput('\x1b[<0;5;5M')
  await vt.waitForRender()
  assert.deepEqual(tenant.keys, [], 'a stale focused tenant must receive no raw protocol chunk')
  assert.equal(tenant.closeCalls(), 1, 'the protocol entry retires the stale record exactly once')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the stale panel must leave the seat:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component, 'the live owner takes over')

  // The same holds in fullscreen, where the viewport observes the focus report
  // before the fence runs.
  const second = makeTenant()
  openTenant(app, second)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), second.component)
  second.setCurrent(false)
  vt.sendInput('\x1b[I')
  vt.sendInput('\x1b[O')
  await vt.waitForRender()
  assert.deepEqual(second.keys, [], 'a stale focused tenant must receive no focus report')
  assert.equal(second.closeCalls(), 1, 'the fullscreen protocol entry retires it exactly once')
  assert.ok(!viewport(vt).includes('optional-tenant:'))
})

test('B-27b: a stale tenant retired while parking cannot strand the existing overlay roots', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const overlay = advancedOverlayProbe('park-root')
  app.showAdvancedInteractiveOverlay(overlay.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('park-root'), `the root must be up first:\n${viewport(vt)}`)
  assert.equal(app.focusSeatForTest(), 'overlay')

  let tenantIsCurrent = true
  let closeCalls = 0
  let abortOnClose: (() => void) | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => { closeCalls += 1; abortOnClose?.() },
  }))
  await vt.waitForRender()
  // The focused capturing overlay outranks the tenant's own projection: the
  // tenant is ACTIVE but not the keyboard owner here.
  assert.equal(app.focusSeatForTest(), 'overlay')

  const controller = new AbortController()
  tenantIsCurrent = false
  abortOnClose = () => controller.abort()
  const dead = app.askQuestions(
    [{ id: 'q1', question: 'park window?', options: [{ label: 'Yes' }] }],
    controller.signal,
  )
  await assert.rejects(dead)
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the park retires the stale tenant exactly once')
  assert.ok(!viewport(vt).includes('park window?'), 'a flow cancelled while parking must never mount a frame')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the retired tenant must leave the seat:\n${viewport(vt)}`)
  // The existing root must NOT have been hidden by the dead flow: it stays
  // painted/focused with UNCHANGED focus/blur counters instead of becoming a
  // stranded hidden handle.
  assert.ok(viewport(vt).includes('park-root'), `the existing root must not be stranded:\n${viewport(vt)}`)
  assert.equal(overlay.focusCount(), 1, 'the existing root was focused once and never refocused')
  assert.equal(overlay.blurCount(), 0, 'the dead-flow park causes no fabricated blur on the root')
  assert.equal(app.focusSeatForTest(), 'overlay')

  // The surface is not stuck on the dead flow: a NEW flow suspends and restores
  // the very same root.
  const again = app.askQuestions([{ id: 'q2', question: 'second flow?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('second flow?'), 'the surface must accept a new flow')
  assert.ok(!viewport(vt).includes('park-root'), 'the live flow suspends the root')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await again, [{ id: 'q2', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('park-root'), `the live flow restores the root:\n${viewport(vt)}`)
})

test('B-27c: an overlay opened by the completion abort during the handoff is resumed by the question', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const overlay = advancedOverlayProbe('handoff-root')
  let completionRegistered = false
  let openOnCompletionAbort: (() => void) | undefined
  const deps: SaveLocationDeps = {
    ...saveDeps(),
    complete: (_raw, signal) => {
      completionRegistered = true
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          openOnCompletionAbort?.()
          resolve(null)
        })
      })
    },
  }
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  await vt.waitForRender()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.equal(completionRegistered, true)
  openOnCompletionAbort = () => { app.showAdvancedInteractiveOverlay(overlay.component) }

  const question = app.askQuestions([{ id: 'q1', question: 'handoff union?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(
    !viewport(vt).includes('handoff-root'),
    `the root opened during the handoff is suspended under the flow:\n${viewport(vt)}`,
  )
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('handoff-root'), `the handoff root must be resumed:\n${viewport(vt)}`)
  assert.ok(overlay.focusCount() >= 1, 'the resumed root takes its own focus intent')
  assert.deepEqual(await save, { kind: 'cancelled' }, 'the superseded prompt still settles cancelled')
})

test('B-30: a newer overlay opened by the stale-tenant cleanup during an Approval settle keeps the keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const overlay = advancedOverlayProbe('approval-tail-root')
  let tenantIsCurrent = true
  let closeCalls = 0
  let openOnClose: (() => void) | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      const run = openOnClose
      openOnClose = undefined
      run?.()
    },
  }))
  await vt.waitForRender()

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'stale under the approval' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'))
  tenantIsCurrent = false
  // The approval settle's focus fallback re-validates the PARKED tenant: its
  // caller cleanup opens a NEWER capturing overlay, which must keep the
  // keyboard (no fabricated blur/re-focus by the settle tail).
  openOnClose = () => { app.showAdvancedInteractiveOverlay(overlay.component) }
  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the focus entry retires the stale tenant exactly once')
  assert.equal(overlay.focusCount(), 1, 'the newer overlay gains focus exactly once')
  assert.equal(overlay.blurCount(), 0, 'the settle tail must not blur the newer owner')
  assert.ok(
    viewport(vt).includes('approval-tail-root'),
    `the newer owner must stay painted:\n${viewport(vt)}`,
  )
  assert.equal(app.focusSeatForTest(), 'overlay')
})

/** Open one optional tenant whose caller cleanup throws, then park it behind a
 * real blocking owner; the owner must roll back instead of staying
 * half-committed. */
function throwingParkTenant(app: TuiApp): { closeCalls(): number } {
  let tenantIsCurrent = true
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      throw new Error('stale tenant close boom')
    },
  }))
  tenantIsCurrent = false
  return { closeCalls: () => closeCalls }
}

test('B-31: a throwing stale-tenant cleanup while parking rolls the Question owner back', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = throwingParkTenant(app)
  await vt.waitForRender()

  const controller = new AbortController()
  const question = app.askQuestions(
    [{ id: 'q1', question: 'never presented?', options: [{ label: 'Yes' }] }],
    controller.signal,
  )
  await assert.rejects(question, /stale tenant close boom/)
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'the failed state must release its abort binding (nothing else can unbind it)',
  )
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'the stale tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('never presented?'), 'the failed presentation must not mount a frame')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the retired tenant must not stay painted:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component, 'the live owner keeps the seat')
  // The blocking owner was ROLLED BACK: a new optional request is accepted
  // (factory runs) instead of being refused by a half-committed question.
  let factoryCalls = 0
  const next = makeTenant()
  const lease = openOptional(app, () => {
    factoryCalls += 1
    return next.spec()
  })
  assert.notEqual(lease, undefined, 'no half-committed question may remain')
  assert.equal(factoryCalls, 1)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), next.component)
  // ... and a new question is answerable too.
  const healthy = app.askQuestions([{ id: 'q2', question: 'healthy?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('healthy?'))
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await healthy, [{ id: 'q2', selected: ['Yes'] }])
  assert.equal(next.closeCalls(), 0)
})

test('B-31b: a throwing stale-tenant cleanup while parking rolls the Save Location owner back', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = throwingParkTenant(app)
  await vt.waitForRender()

  const saveController = new AbortController()
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    saveDeps(),
    saveController.signal,
  )
  await assert.rejects(save, /stale tenant close boom/)
  assert.equal(
    getEventListeners(saveController.signal, 'abort').length,
    0,
    'the failed prompt must release its abort binding',
  )
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1)
  assert.ok(!viewport(vt).includes('Save session archive'), 'the failed prompt must not be presented')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the retired tenant must not stay painted:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  const next = makeTenant()
  assert.notEqual(openTenant(app, next), undefined, 'no half-committed save prompt may remain')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), next.component)
})

test('B-31c: a throwing stale-tenant cleanup while parking rolls the Approval owner back', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = throwingParkTenant(app)
  await vt.waitForRender()

  const approvalController = new AbortController()
  const approval = app.showApprovalPrompt(
    { toolName: 'bash', reason: 'never presented', signal: approvalController.signal },
  )
  await assert.rejects(approval, /stale tenant close boom/)
  assert.equal(
    getEventListeners(approvalController.signal, 'abort').length,
    0,
    'the failed approval must release its abort binding',
  )
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1)
  assert.ok(!viewport(vt).includes('bash'), 'the failed approval must not be presented')
  assert.ok(!viewport(vt).includes('optional-tenant:'), `the retired tenant must not stay painted:\n${viewport(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  // The approval runtime is not half-committed: a new approval is answerable.
  const healthy = app.showApprovalPrompt({ toolName: 'fs', reason: 'healthy' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('fs'))
  vt.sendInput('y')
  assert.equal(await healthy, 'allowed-once')
  const next = makeTenant()
  assert.notEqual(openTenant(app, next), undefined, 'no half-committed approval may remain')
})

// ---------------------------------------------------------------------------
// Round-2 review fixes: preempting cleanup, failed-state release, Save live
// fence, Approval FIFO gap, abandoned suspension, rollback repaint + the
// PR-E affordance integration
// ---------------------------------------------------------------------------

/** Open one optional tenant whose ONE cleanup synchronously runs `onClose` and
 * THEN throws — the shape of a caller cleanup that preempts the presentation it
 * is retiring (abort the old modal, open a NEWER same-type modal, throw). */
function preemptingCloseTenant(app: TuiApp, onClose: () => void): { closeCalls(): number } {
  let tenantIsCurrent = true
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      onClose()
      throw new Error('stale tenant close boom')
    },
  }))
  tenantIsCurrent = false
  return { closeCalls: () => closeCalls }
}

/** Await a promise a regression could leave forever pending (the failure mode
 * under test is exactly "the newer owner no longer settles"). */
async function settleOrTimeout<T>(promise: Promise<T>, ms = 300): Promise<T | 'TIMEOUT'> {
  return Promise.race([
    promise,
    new Promise<'TIMEOUT'>(resolve => { setTimeout(() => resolve('TIMEOUT'), ms) }),
  ])
}

test('B-31d: a NEWER Question opened by the throwing cleanup keeps its owner', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const presentedController = new AbortController()
  let newer: Promise<unknown> | undefined
  const tenant = preemptingCloseTenant(app, () => {
    presentedController.abort()
    newer = app.askQuestions([{ id: 'q-new', question: 'newer question?', options: [{ label: 'Yes' }] }])
  })
  await vt.waitForRender()

  const preempted = app.askQuestions(
    [{ id: 'q-old', question: 'preempted question?', options: [{ label: 'Yes' }] }],
    presentedController.signal,
  )
  await assert.rejects(preempted)
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1, 'the stale tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('preempted question?'), 'the preempted flow must never mount')
  assert.ok(viewport(vt).includes('newer question?'), `the newer flow must keep its owner:\n${viewport(vt)}`)
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await settleOrTimeout(newer!), [{ id: 'q-new', selected: ['Yes'] }])
})

test('B-31e: a NEWER Save Location opened by the throwing cleanup keeps its owner', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const presentedController = new AbortController()
  let newer: Promise<unknown> | undefined
  const tenant = preemptingCloseTenant(app, () => {
    presentedController.abort()
    newer = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-new.zip', initialDirectory: './' },
      saveDeps(),
    )
  })
  await vt.waitForRender()

  const preempted = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-old.zip', initialDirectory: './' },
    saveDeps(),
    presentedController.signal,
  )
  assert.deepEqual(await preempted, { kind: 'cancelled' }, 'the aborted prompt settles cancelled')
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1)
  assert.ok(!viewport(vt).includes('dsh-session-old.zip'), 'the preempted prompt must never mount')
  assert.ok(viewport(vt).includes('dsh-session-new.zip'), `the newer prompt must keep its owner:\n${viewport(vt)}`)
  vt.sendInput('\x1b')
  assert.deepEqual(await newer, { kind: 'cancelled' }, 'the newer prompt must stay answerable')
})

test('B-31f: a NEWER Approval opened by the throwing cleanup keeps its owner', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const presentedController = new AbortController()
  let newer: Promise<unknown> | undefined
  const tenant = preemptingCloseTenant(app, () => {
    presentedController.abort()
    newer = app.showApprovalPrompt({ toolName: 'fs', reason: 'newer approval' })
  })
  await vt.waitForRender()

  const preempted = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'preempted approval',
    signal: presentedController.signal,
  })
  assert.equal(await preempted, 'cancelled', 'the aborted approval settles cancelled')
  await vt.waitForRender()
  assert.equal(tenant.closeCalls(), 1)
  assert.ok(!viewport(vt).includes('bash'), 'the preempted approval must never be presented')
  assert.ok(viewport(vt).includes('fs'), `the newer approval must keep its owner:\n${viewport(vt)}`)
  vt.sendInput('y')
  assert.equal(
    await settleOrTimeout(newer!),
    'allowed-once',
    'the newer approval must still be answerable (its active owner may not be cleared)',
  )
})

test('B-32: a stale close that only cancels the new Save keeps the dead frame out and the live root visible', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const root = advancedOverlayProbe('save-live-root')
  app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('save-live-root'))

  const controller = new AbortController()
  let tenantIsCurrent = true
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      // Aborts the prompt that is being presented, WITHOUT throwing.
      controller.abort()
    },
  }))
  tenantIsCurrent = false

  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    saveDeps(),
    controller.signal,
  )
  assert.deepEqual(await save, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the stale tenant is retired exactly once')
  assert.ok(
    !viewport(vt).includes('Save session archive'),
    `a cancelled presentation must not mount a dead frame:\n${viewport(vt)}`,
  )
  assert.ok(
    viewport(vt).includes('save-live-root'),
    `the live overlay root must not be hidden by the dead presentation:\n${viewport(vt)}`,
  )
  assert.notEqual(app.focusedComponentForTest(), null)
})

test('B-33: the Approval A→B handover window refuses a fresh optional opener', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let arm = false
  let attempts = 0
  let factoryCalls = 0
  let tenantLease: { close(): void } | undefined
  const late = makeTenant('LATE')
  const root = advancedOverlayProbe('fifo-root', () => {
    if (!arm) return
    arm = false
    attempts += 1
    tenantLease = openOptional(app, () => {
      factoryCalls += 1
      return late.spec()
    })
  })
  app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()

  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'A' })
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'B' })
  await vt.waitForRender()
  arm = true
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(first), 'allowed-once')
  await vt.waitForRender()
  assert.equal(attempts, 1, 'the restored root focus callback must have attempted the open')
  assert.equal(factoryCalls, 0, 'the REFUSE gate must not run the factory during the A→B window')
  assert.equal(tenantLease, undefined, 'no tenant may be installed between two queued approvals')
  assert.notEqual(app.focusSeatForTest(), 'editor-panel', 'no intermediate tenant seat')
  assert.ok(viewport(vt).includes('fs'), `the second approval must own the screen:\n${viewport(vt)}`)

  vt.sendInput('n')
  assert.equal(await settleOrTimeout(second), 'rejected')
  await vt.waitForRender()
  // After the WHOLE queue drained the opener succeeds (the factory runs).
  const lateLease = openOptional(app, () => {
    factoryCalls += 1
    return late.spec()
  })
  assert.notEqual(lateLease, undefined, 'the drained queue releases the tenant slot')
  assert.equal(factoryCalls, 1)
  assert.equal(late.closeCalls(), 0)
  lateLease?.close()
})

test('B-34: a root opened by a cleanup during an abandoned presentation is handed back', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const late = advancedOverlayProbe('late-root')
  const controller = new AbortController()
  let tenantIsCurrent = true
  let closeCalls = 0
  let abortOnClose: (() => void) | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      abortOnClose?.()
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false
  abortOnClose = () => {
    controller.abort()
    // The cleanup opens a NEWER overlay while the (now dead) question still owns
    // the seat: the broker appends it to that dead state's suspension set.
    app.showAdvancedInteractiveOverlay(late.component)
  }

  const dead = app.askQuestions(
    [{ id: 'q1', question: 'abandoned?', options: [{ label: 'Yes' }] }],
    controller.signal,
  )
  await assert.rejects(dead)
  await vt.waitForRender()
  assert.equal(closeCalls, 1)
  assert.ok(!viewport(vt).includes('abandoned?'), 'the dead presentation must not mount a frame')
  assert.ok(
    viewport(vt).includes('late-root'),
    `the callback-created root must be handed back, never stranded hidden:\n${viewport(vt)}`,
  )
  assert.ok(late.focusCount() >= 1, 'the handed-back root takes its focus intent')
})

test('B-35: the approval rollback still attempts the repaint and re-publishes the live seat', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the tenant owns the derived seat first')
  tenant.setCurrent(false)

  const mountProto = TuiApp.prototype as unknown as { mountSeatChild(): void }
  const renderProto = TuiApp.prototype as unknown as { requestRender(force?: boolean): void }
  const originalMount = mountProto.mountSeatChild
  const originalRender = renderProto.requestRender
  let renderCalls = 0
  // A throwing mount/focus step must not truncate the rollback's independent
  // obligations (seat publish + repaint).
  mountProto.mountSeatChild = () => { throw new Error('rollback mount boom') }
  renderProto.requestRender = function (this: unknown, force?: boolean): void {
    renderCalls += 1
    originalRender.call(this, force)
  }
  let caught: unknown
  try {
    const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'rollback truncation' })
    try {
      caught = await settleOrTimeout(approval)
    } catch (error) {
      caught = error
    }
  } finally {
    mountProto.mountSeatChild = originalMount
    renderProto.requestRender = originalRender
  }
  assert.ok(
    caught instanceof AggregateError && caught.errors.length === 2,
    `the primary and the rollback failure must both surface by identity: ${String(caught)}`,
  )
  await vt.waitForRender()
  assert.ok(renderCalls >= 1, 'the rollback must still attempt the independent repaint')
  assert.notEqual(
    app.focusSeatForTest(),
    'editor-panel',
    'the derived seat must be re-published, never left on the stale tenant value',
  )
  // (The patched mount throws before the park's re-validation could retire the
  // tenant, so the caller cleanup is not part of THIS scenario: the assertion
  // above is the seat-publish obligation and `renderCalls` the repaint one.)
  void tenant
})

test('B-37: the ↓ view affordance is withheld while an ACTIVE tenant owns the seat', async () => {
  const { vt, app, openTasks } = startApp()
  // B4-B: the admission needs the Quick projection alongside the badge.
  await vt.waitForRender()
  app.setQuickTaskItems([{ value: 'job:job-1', label: 'pnpm build', status: 'running', kind: 'task', source: 'job' }])
  app.setTasks([{ id: 'job-1', label: 'pnpm build', status: 'running', kind: 'job' }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('↓ view'), `the idle footer must advertise the affordance:\n${viewport(vt)}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(openTasks(), 1, 'the empty-editor ↓ must reach the task-browser sink')

  const tenant = makeTenant()
  const lease = openTenant(app, tenant)
  await vt.waitForRender()
  assert.ok(
    !viewport(vt).includes('↓ view'),
    `an ACTIVE optional tenant captures the seat and must withhold the ↓ hint:\n${viewport(vt)}`,
  )
  assert.ok(viewport(vt).includes('task running'), 'the task badge itself must survive')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(openTasks(), 1, 'the tenant consumes ↓ — no task-browser dispatch')
  assert.ok(tenant.keys.includes('\x1b[B'), 'the ↓ key belongs to the tenant')

  lease?.close()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('↓ view'), 'closing the tenant restores the affordance')
  // B4-B: the earlier witness ENTERED Quick — leave it before the restore shot.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(openTasks(), 2, 'the restored ↓ reaches the sink again')
})

test('B-36: a user-thrown AggregateError from a caller cleanup stays ONE rollback entry', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const primary = new Error('primary close boom')
  const secondary = new AggregateError([new Error('one'), new Error('two')], 'secondary')
  let tenantIsCurrent = true
  // The tenant's focus-loss setter throws a user AggregateError.
  const tenant = makeTenant('', () => { throw secondary })
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => { throw primary },
  }))
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant holds the keyboard first')
  tenantIsCurrent = false

  const controller = new AbortController()
  const save = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    saveDeps(),
    controller.signal,
  )
  let caught: unknown
  try {
    await settleOrTimeout(save)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AggregateError, `expected an AggregateError, got ${String(caught)}`)
  assert.equal(
    (caught as AggregateError).errors.length,
    2,
    'the rollback failure must stay ONE thrown value (never flattened into its .errors)',
  )
  assert.equal(
    (caught as AggregateError).errors[0],
    primary,
    'the primary failure keeps its identity',
  )
  assert.equal(
    (caught as AggregateError).errors[1],
    secondary,
    'the user-thrown aggregate keeps its identity as the second entry',
  )
})

test('B-38: a root a throwing cleanup acquired while the owner was live is handed back', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const late = advancedOverlayProbe('rolling-root')
  let tenantIsCurrent = true
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      // While the question STILL owns the seat: the broker appends this root to
      // that state's suspension set (hidden, topology intact).
      app.showAdvancedInteractiveOverlay(late.component)
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component)
  tenantIsCurrent = false

  const question = app.askQuestions([{ id: 'q-roll', question: 'rolling back?', options: [{ label: 'Yes' }] }])
  await assert.rejects(question)
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('rolling back?'), 'the failed presentation must mount no frame')
  assert.ok(
    viewport(vt).includes('rolling-root'),
    `the root the cleanup acquired must be handed back, never stranded hidden:\n${viewport(vt)}`,
  )
})

test('B-39: the broker releasing an old overlay never leaves a retired tenant with the keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => { closeCalls += 1 },
  }))
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant owns the keyboard first')

  const root = advancedOverlayProbe('covering-root')
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.notEqual(app.focusedComponentForTest(), tenant.component, 'the newer overlay covers the tenant')
  assert.equal(root.focusCount(), 1)

  // The broker RELEASES the old overlay it holds: no newer operation exists, so
  // the seat fallback must run — the fork's own unfocus fallback would otherwise
  // restore its preFocus (the now retired tenant).
  tenantIsCurrent = false
  rootLease.blur()
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the focus entry retires the stale tenant exactly once')
  assert.notEqual(
    app.focusedComponentForTest(),
    tenant.component,
    'a RETIRED tenant must never get the keyboard back from the fork preFocus fallback',
  )
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component, 'the live seat owner takes it')
  assert.equal(app.focusSeatForTest(), 'editor')
  const keysBefore = tenant.keys.length
  vt.sendInput('x')
  assert.equal(tenant.keys.length, keysBefore, 'a retired tenant receives no key')
})

test('B-40: a failed Question presentation advances its QUEUED successor', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let queued: Promise<unknown> | undefined
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      // A legally QUEUED successor: requested while the failing flow still owns
      // the seat, and the failing flow is NOT aborted first.
      queued = app.askQuestions([{ id: 'q-next', question: 'queued successor?', options: [{ label: 'Yes' }] }])
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false

  const failed = app.askQuestions([{ id: 'q-fail', question: 'failing flow?', options: [{ label: 'Yes' }] }])
  await assert.rejects(failed, /stale tenant close boom/)
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the stale tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('failing flow?'), 'the failed flow must never mount')
  assert.ok(
    viewport(vt).includes('queued successor?'),
    `the queued successor must take the seat through the queue authority:\n${viewport(vt)}`,
  )
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await settleOrTimeout(queued!), [{ id: 'q-next', selected: ['Yes'] }])
})

test('B-40b: a failed Approval presentation advances its QUEUED successor', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let queued: Promise<unknown> | undefined
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      queued = app.showApprovalPrompt({ toolName: 'fs', reason: 'queued approval' })
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false

  const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'failing approval' })
  let caught: unknown
  try {
    await settleOrTimeout(failed)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error, `the failed approval must reject: ${String(caught)}`)
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the stale tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('bash'), 'the failed approval must never be presented')
  assert.ok(
    viewport(vt).includes('fs'),
    `the queued successor must be presented through showNext:\n${viewport(vt)}`,
  )
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(queued!), 'allowed-once', 'the queued successor must be answerable')
})

// ---------------------------------------------------------------------------
// Delta review round 3: a FAILED presentation's rollback obligations. The park
// rollback and the queue advance are independent; the successor fact is read
// BEFORE the handover runs; the advance is gated on still owning the seat; a
// successor handed over from a never-presented flow takes its OWN suspension;
// and the seat's focus-intent observation counts the fork's auto-focus.
// ---------------------------------------------------------------------------

test('B-41: a doubly-failing Approval park still presents its QUEUED successor', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let queued: Promise<unknown> | undefined
  let tenantIsCurrent = true
  // Set by the stale tenant's ONE cleanup: the park's own `mountSeatChild` runs
  // BEFORE it, the rollback's afterwards.
  let retireRan = false
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      retireRan = true
      queued = app.showApprovalPrompt({ toolName: 'fs', reason: 'queued approval' })
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false

  const mountProto = TuiApp.prototype as unknown as { mountSeatChild(): void }
  const originalMount = mountProto.mountSeatChild
  // Fail the ROLLBACK's own step (the first `mountSeatChild` after the
  // retirement): the park's failure and the rollback's failure are independent,
  // so the queue advance must still present the successor.
  let rollbackFailed = 0
  mountProto.mountSeatChild = function (this: unknown): void {
    if (retireRan && rollbackFailed === 0) {
      rollbackFailed += 1
      throw new Error('rollback mount boom')
    }
    originalMount.call(this)
  }
  let caught: unknown
  try {
    const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'failing approval' })
    try {
      await settleOrTimeout(failed)
    } catch (error) {
      caught = error
    }
  } finally {
    mountProto.mountSeatChild = originalMount
  }
  assert.ok(
    caught instanceof AggregateError && caught.errors.length === 2,
    `the park failure and the rollback failure must both surface by identity: ${String(caught)}`,
  )
  const surfaces = (caught as AggregateError).errors as Error[]
  assert.equal(surfaces[0].message, 'stale tenant close boom', 'the park failure stays the PRIMARY value')
  assert.equal(surfaces[1].message, 'rollback mount boom', 'the throwing step is the collected ROLLBACK failure')
  assert.equal(rollbackFailed, 1, 'the rollback step ran (and failed) exactly once')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('bash'), 'the failed approval must never be presented')
  assert.ok(
    viewport(vt).includes('fs'),
    `a rollback failure may not skip the INDEPENDENT queue advance:\n${viewport(vt)}`,
  )
  vt.sendInput('y')
  assert.equal(
    await settleOrTimeout(queued!),
    'allowed-once',
    'the queued successor must stay answerable after the double failure',
  )
})

test('B-42: a throwing handover step cannot clear the successor it already installed', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const proto = TuiApp.prototype as unknown as { projectActivity(): void }
  const original = proto.projectActivity
  let armed = false
  proto.projectActivity = function (this: unknown): void {
    if (armed) throw new Error('handover project boom')
    original.call(this)
  }
  try {
    const first = app.askQuestions([{ id: 'q1', question: 'first flow?', options: [{ label: 'Yes' }] }])
    const second = app.askQuestions([{ id: 'q2', question: 'second flow?', options: [{ label: 'Yes' }] }])
    await vt.waitForRender()
    assert.ok(viewport(vt).includes('first flow?'), `the first flow owns the seat:\n${viewport(vt)}`)
    vt.sendInput('\r')
    armed = true
    let caught: unknown
    try {
      vt.sendInput('\r')
    } catch (error) {
      caught = error
    } finally {
      armed = false
    }
    assert.ok(caught instanceof Error, `the handover failure must surface: ${String(caught)}`)
    assert.deepEqual(await settleOrTimeout(first), [{ id: 'q1', selected: ['Yes'] }])
    await vt.waitForRender()
    assert.ok(
      viewport(vt).includes('second flow?'),
      `the successor the throwing handover installed must keep the seat:\n${viewport(vt)}`,
    )
    vt.sendInput('\r')
    vt.sendInput('\r')
    assert.deepEqual(
      await settleOrTimeout(second),
      [{ id: 'q2', selected: ['Yes'] }],
      'the installed successor must stay answerable',
    )
  } finally {
    proto.projectActivity = original
  }
})

test('B-43: a failed presentation never dequeues over the newer Question that preempted it', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const controller = new AbortController()
  let newer: Promise<unknown> | undefined
  let third: Promise<unknown> | undefined
  let closeCalls = 0
  let tenantIsCurrent = true
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      // Abort the flow being presented: ITS OWN release hands the seat to the
      // newer flow below (the normal path, not this rollback), which then queues
      // the third one behind itself.
      controller.abort()
      newer = app.askQuestions([{ id: 'q-new', question: 'newer successor?', options: [{ label: 'Yes' }] }])
      third = app.askQuestions([{ id: 'q-third', question: 'third queued?', options: [{ label: 'Yes' }] }])
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false

  const failed = app.askQuestions(
    [{ id: 'q-old', question: 'preempted flow?', options: [{ label: 'Yes' }] }],
    controller.signal,
  )
  await assert.rejects(failed)
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the stale tenant is retired exactly once')
  assert.ok(!viewport(vt).includes('preempted flow?'), 'the failed flow must never mount')
  assert.ok(viewport(vt).includes('newer successor?'), `the newer owner must keep the seat:\n${viewport(vt)}`)
  assert.ok(
    !viewport(vt).includes('third queued?'),
    'the failed presentation must not dequeue a queued flow over the newer owner',
  )
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(
    await settleOrTimeout(newer!),
    [{ id: 'q-new', selected: ['Yes'] }],
    'the newer owner must stay answerable',
  )
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('third queued?'), `the queued flow must take the seat next:\n${viewport(vt)}`)
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await settleOrTimeout(third!), [{ id: 'q-third', selected: ['Yes'] }])
})

test('B-44: a successor handed over from a failed presentation takes its OWN initial suspension', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let queued: Promise<unknown> | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      queued = app.askQuestions([{ id: 'q-next', question: 'queued successor?', options: [{ label: 'Yes' }] }])
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  // A REAL capturing root is up: the failing flow's park fails BEFORE its own
  // suspension, so the successor cannot inherit any graph over it.
  const root = advancedOverlayProbe('pre-existing-root')
  app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('pre-existing-root'), `the capturing root must be up first:\n${viewport(vt)}`)
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')
  tenantIsCurrent = false

  const failed = app.askQuestions([{ id: 'q-fail', question: 'failing flow?', options: [{ label: 'Yes' }] }])
  await assert.rejects(failed, /stale tenant close boom/)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('queued successor?'), `the successor must be presented:\n${viewport(vt)}`)
  assert.ok(
    !viewport(vt).includes('pre-existing-root'),
    `a successor handed over from a never-presented flow must take its own suspension:\n${viewport(vt)}`,
  )
  const blurWhileSuspended = root.blurCount()
  assert.equal(blurWhileSuspended, 1, 'the suspension releases the root keyboard exactly once')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await settleOrTimeout(queued!), [{ id: 'q-next', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('pre-existing-root'), `the root must be restored:\n${viewport(vt)}`)
  assert.equal(root.focusCount(), 2, 'the root reclaims the keyboard exactly once on restore')
  assert.equal(root.blurCount(), blurWhileSuspended, 'no further root blur on restore')
})

test('B-45: an overlay auto-focused while the stale tenant is retired keeps the keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let closeCalls = 0
  const hidden = advancedOverlayProbe('hidden-then-shown')
  let hiddenLease: { hide(): void; show(): void } | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      // A HIDDEN capturing overlay re-shown by the cleanup auto-focuses inside
      // the fork's own setHidden(false) — a newer keyboard owner the seat
      // fallback of the VERY focus entry that retires this tenant must not steal
      // back.
      hiddenLease!.show()
    },
  }))
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant owns the keyboard first')

  hiddenLease = app.showAdvancedInteractiveOverlay(hidden.component)
  await vt.waitForRender()
  assert.equal(hidden.focusCount(), 1, 'the overlay auto-focuses when first shown')
  // The live component that owns the keyboard while this overlay is up (the
  // managed wrapper the host projection reports — never the raw plugin object).
  const hiddenOwner = app.focusedComponentForTest()
  assert.notEqual(hiddenOwner, null)
  assert.notEqual(hiddenOwner, app.seatEditorForTest().component, 'the overlay owns the keyboard when shown')
  hiddenLease.hide()
  await vt.waitForRender()
  assert.equal(hidden.blurCount(), 1, 'hiding the overlay releases its keyboard exactly once')

  const covering = advancedOverlayProbe('covering-again')
  const coveringLease = app.showAdvancedInteractiveOverlay(covering.component)
  await vt.waitForRender()
  assert.equal(covering.focusCount(), 1, 'the covering root owns the keyboard')

  tenantIsCurrent = false
  // Releasing the covering overlay runs the seat-owner focus entry, which is
  // exactly what retires the stale tenant (and where the cleanup re-shows the
  // hidden overlay).
  coveringLease.blur()
  await vt.waitForRender()
  assert.equal(closeCalls, 1, 'the focus entry retires the stale tenant exactly once')
  assert.equal(hidden.focusCount(), 2, 'the re-shown overlay auto-focuses')
  assert.equal(
    app.focusedComponentForTest(),
    hiddenOwner,
    'the newer auto-focus must survive the seat fallback of the same focus entry',
  )
  assert.equal(hidden.blurCount(), 1, 'the seat fallback must not steal the keyboard back')
  assert.equal(app.focusSeatForTest(), 'overlay')
})

test('B-46: a successor superseded INSIDE its own initial suspension hides the roots and keeps the live frame', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  let superseded: Promise<unknown> | undefined
  let third: Promise<unknown> | undefined
  const successorController = new AbortController()
  let abortArmed = false
  // A REAL capturing root whose onBlur aborts the successor WHILE that successor's
  // initial suspension is running: its own settlement then hands the seat to the
  // queued third flow mid-suspension.
  const root = advancedOverlayProbe('reentrant-root', undefined, () => {
    if (!abortArmed) return
    abortArmed = false
    successorController.abort()
  })
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      superseded = app.askQuestions(
        [{ id: 'q-b', question: 'superseded successor?', options: [{ label: 'Yes' }] }],
        successorController.signal,
      )
      third = app.askQuestions([{ id: 'q-c', question: 'third after mid-suspension?', options: [{ label: 'Yes' }] }])
      abortArmed = true
      throw new Error('stale tenant close boom')
    },
  }))
  await vt.waitForRender()
  app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('reentrant-root'), `the root must be up first:\n${viewport(vt)}`)
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')
  tenantIsCurrent = false

  const failed = app.askQuestions([{ id: 'q-fail', question: 'failing flow?', options: [{ label: 'Yes' }] }])
  await assert.rejects(failed, /stale tenant close boom/)
  await assert.rejects(superseded!)
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('third after mid-suspension?'),
    `the flow queued behind the superseded one must own the seat:\n${viewport(vt)}`,
  )
  assert.ok(
    !viewport(vt).includes('reentrant-root'),
    `a successor superseded mid-suspension may not leave the inherited roots painted:\n${viewport(vt)}`,
  )
  const liveFrame = (app as unknown as { seatFallbackComponent(): unknown }).seatFallbackComponent()
  assert.notEqual(liveFrame, undefined, 'the live successor frame must be built')
  assert.equal(
    app.focusedComponentForTest(),
    liveFrame,
    'the keyboard must belong to the LIVE frame, never the retired successor it superseded',
  )
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await settleOrTimeout(third!), [{ id: 'q-c', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('reentrant-root'), `the root must be restored afterwards:\n${viewport(vt)}`)
})

test('B-47: a settled Approval never cancels the Save Location its own cleanup opened', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let tenantIsCurrent = true
  const controller = new AbortController()
  let save: Promise<SaveLocationResult> | undefined
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      // No throw: the stale cleanup aborts the approval being presented and opens
      // a NEWER Save Location prompt in the same call — the approval's own release
      // clears its active slot, so the tail that follows must be inert.
      controller.abort()
      save = askSave(app)
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false

  const approval = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'stale approval tail',
    signal: controller.signal,
  })
  assert.equal(await settleOrTimeout(approval), 'cancelled', 'the aborted approval settles cancelled')
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('dsh-session-abc.zip'),
    `the Save Location opened by the cleanup must survive the settled approval's tail:\n${viewport(vt)}`,
  )
  vt.sendInput('\x1b')
  assert.deepEqual(
    await settleOrTimeout(save!),
    { kind: 'cancelled' },
    'the newer prompt must stay answerable',
  )
})

test('B-48: a throwing physical mount releases the failed Approval and its queue', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // The physical overlay mount is the ONE funnel every overlay goes through. A
  // throwing step there (the mount runs plugin focus/blur callbacks; the Advanced
  // tier routes those to `notify`, a first-party/Cordis throw reaches the caller)
  // is injected RECEIVER-PRESERVINGLY, once, so the assertion below is about the
  // failure window, not about the injected identity.
  const proto = TuiApp.prototype as unknown as {
    showOverlayOnHost(component: unknown, options: unknown, ownership?: unknown): unknown
  }
  const original = proto.showOverlayOnHost
  let armed = false
  proto.showOverlayOnHost = function (
    this: unknown,
    component: unknown,
    options: unknown,
    ownership?: unknown,
  ): unknown {
    if (armed) {
      armed = false
      throw new Error('overlay mount boom')
    }
    return original.call(this, component, options, ownership)
  }
  try {
    armed = true
    const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'throwing mount' })
    let caught: unknown
    try {
      await settleOrTimeout(failed)
    } catch (error) {
      caught = error
    }
    const primary = caught instanceof AggregateError ? caught.errors[0] : caught
    assert.ok(
      primary instanceof Error && primary.message === 'overlay mount boom',
      `the mount failure must surface by identity as the primary failure: ${String(caught)}`,
    )

    // The failed mount may not latch the input stage: a NEW approval is presentable
    // and answerable, and the optional seat can open again.
    const healthy = app.showApprovalPrompt({ toolName: 'fs', reason: 'healthy after mount failure' })
    vt.sendInput('y')
    assert.equal(
      await settleOrTimeout(healthy),
      'allowed-once',
      'a failed mount must not leave a half-committed approval blocking the stage',
    )
    const next = makeTenant()
    assert.notEqual(openTenant(app, next), undefined, 'no half-committed approval may remain')
    await vt.waitForRender()
    assert.equal(app.focusedComponentForTest(), next.component)
  } finally {
    proto.showOverlayOnHost = original
  }
})

test('B-49: multiple rollback failures sit FLAT behind the primary failure', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const mountProto = TuiApp.prototype as unknown as { mountSeatChild(): void }
  const publishProto = TuiApp.prototype as unknown as { publishFocusSeat(): void }
  const originalMount = mountProto.mountSeatChild
  const originalPublish = publishProto.publishFocusSeat
  // Armed by the stale tenant's cleanup: the park's OWN mount call has already
  // run by then, so only the ROLLBACK's two steps throw. Each failure is a
  // pre-created instance so the assertions below can compare OBJECT IDENTITY.
  let armRollback = false
  let closeCalls = 0
  let tenantIsCurrent = true;
  const closeFailure = new Error('stale tenant close boom')
  const mountFailure = new Error('rollback mount boom')
  const publishFailure = new Error('rollback publish boom')
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => tenantIsCurrent,
    close: () => {
      closeCalls += 1
      armRollback = true
      throw closeFailure
    },
  }))
  await vt.waitForRender()
  tenantIsCurrent = false
  mountProto.mountSeatChild = function (this: unknown): void {
    if (armRollback) throw mountFailure
    originalMount.call(this)
  }
  publishProto.publishFocusSeat = function (this: unknown): void {
    if (armRollback) throw publishFailure
    originalPublish.call(this)
  }
  let caught: unknown
  try {
    const failed = app.askQuestions([{ id: 'q-flat', question: 'flat aggregation?', options: [{ label: 'Yes' }] }])
    try {
      await settleOrTimeout(failed)
    } catch (error) {
      caught = error
    }
  } finally {
    armRollback = false
    mountProto.mountSeatChild = originalMount
    publishProto.publishFocusSeat = originalPublish
  }
  assert.ok(caught instanceof AggregateError, `expected an AggregateError, got ${String(caught)}`)
  const errors = (caught as AggregateError).errors
  assert.equal(
    errors.length,
    3,
    'the primary failure and BOTH rollback failures must stay FLAT entries (never nested)',
  )
  assert.equal(errors[0], closeFailure, 'the primary failure keeps its object identity, first')
  assert.equal(errors[1], mountFailure, 'rollback failures keep their identity in step order')
  assert.equal(errors[2], publishFailure)
  assert.equal(closeCalls, 1, 'the stale tenant is retired exactly once')
})

test('B-50: a failed Approval mount restores a parked-but-current optional tenant', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), tenant.component, 'the tenant owns the seat first')

  // The physical mount throws while a HEALTHY (still-current) tenant is parked
  // behind it: the park retires nobody, so the last-blocker restore obligation is
  // the only thing that can bring this tenant back.
  const proto = TuiApp.prototype as unknown as {
    showOverlayOnHost(component: unknown, options: unknown, ownership?: unknown): unknown
  }
  const original = proto.showOverlayOnHost
  let armed = true
  proto.showOverlayOnHost = function (
    this: unknown,
    component: unknown,
    options: unknown,
    ownership?: unknown,
  ): unknown {
    if (armed) {
      armed = false
      throw new Error('overlay mount boom')
    }
    return original.call(this, component, options, ownership)
  }
  try {
    const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'failed with a parked tenant' })
    await assert.rejects(settleOrTimeout(failed))
  } finally {
    proto.showOverlayOnHost = original
  }
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'the failed mount leaves no approval frame')
  assert.equal(
    app.focusedComponentForTest(),
    tenant.component,
    'the SAME parked tenant instance must be restored once no approval is left',
  )
  assert.ok(
    viewport(vt).includes('optional-tenant:'),
    `the restored tenant must be painted again:\n${viewport(vt)}`,
  )
  const keysBefore = tenant.keys.length
  vt.sendInput('x')
  assert.equal(tenant.keys.length, keysBefore + 1, 'the restored tenant takes keys again')
  assert.equal(tenant.closeCalls(), 0)
})

test('B-51: a physical overlay mount that fails before registration leaves no ghost modal', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // The fork pushes its overlay-stack entry and then performs terminal IO before
  // returning the raw handle. Fail that IO seam ONCE: the broker never saw a node
  // for this projection, so only a positional release can remove the ghost.
  const originalHideCursor = vt.hideCursor.bind(vt)
  let armed = true
  vt.hideCursor = (): void => {
    if (armed) {
      armed = false
      throw new Error('terminal io boom')
    }
    originalHideCursor()
  }
  try {
    const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'ghost mount' })
    let caught: unknown
    try {
      await settleOrTimeout(failed)
    } catch (error) {
      caught = error
    }
    const primary = caught instanceof AggregateError ? caught.errors[0] : caught
    assert.ok(
      primary instanceof Error && primary.message === 'terminal io boom',
      `the IO failure must surface by identity: ${String(caught)}`,
    )
  } finally {
    vt.hideCursor = originalHideCursor
  }
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'the failed mount leaves no approval frame')
  assert.ok(
    !viewport(vt).includes('bash'),
    `an unregistered raw projection must not survive as a ghost modal:\n${viewport(vt)}`,
  )
  assert.equal(app.assertOverlayForestForTest(), undefined)
  // ... and the stage stays usable.
  const healthy = app.showApprovalPrompt({ toolName: 'fs', reason: 'healthy after the ghost' })
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(healthy), 'allowed-once')
})

test('B-53: a QUEUED Approval whose mount fails rejects its own promise', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const tenant = makeTenant()
  openTenant(app, tenant)
  await vt.waitForRender()

  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'first approval' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'), `the first approval owns the stage:\n${viewport(vt)}`)
  // B is QUEUED: its Promise executor has already returned, so a mount failure for
  // B can no longer rely on the executor to reject it.
  const proto = TuiApp.prototype as unknown as {
    showOverlayOnHost(component: unknown, options: unknown, ownership?: unknown): unknown
  }
  const original = proto.showOverlayOnHost
  let armed = false
  proto.showOverlayOnHost = function (
    this: unknown,
    component: unknown,
    options: unknown,
    ownership?: unknown,
  ): unknown {
    if (armed) {
      armed = false
      throw new Error('queued mount boom')
    }
    return original.call(this, component, options, ownership)
  }
  let queued: Promise<unknown> | undefined
  try {
    queued = app.showApprovalPrompt({ toolName: 'fs', reason: 'queued approval' })
    armed = true
    // Settling the first prompt mounts the queued one — that mount fails and the
    // settle tail propagates the failure.
    try {
      vt.sendInput('y')
    } catch {
      // The failure escapes through the settlement path; the assertions below are
      // about the two promises.
    }
  } finally {
    proto.showOverlayOnHost = original
  }
  assert.equal(await settleOrTimeout(first), 'allowed-once', 'the first approval settles normally')
  let queuedFailure: unknown
  try {
    const outcome = await settleOrTimeout(queued!)
    queuedFailure = new Error(`the queued approval RESOLVED as ${String(outcome)} instead of rejecting`)
  } catch (error) {
    queuedFailure = error
  }
  const primary = queuedFailure instanceof AggregateError ? queuedFailure.errors[0] : queuedFailure
  assert.ok(
    primary instanceof Error && primary.message === 'queued mount boom',
    `a queued approval whose mount fails must REJECT with the failure, never time out: ${String(queuedFailure)}`,
  )
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('fs'), 'the failed queued approval must never be presented')
  assert.equal(app.ownedApprovalFramesForTest(), 0)
  assert.equal(
    app.focusedComponentForTest(),
    tenant.component,
    'the tenant comes back once no approval is left',
  )
  const healthy = app.showApprovalPrompt({ toolName: 'grep', reason: 'healthy after the fifo failure' })
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(healthy), 'allowed-once')
})

test('B-54: a real Advanced blur chain that throws through the host unwind leaves no ghost Approval', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  // A REAL optional tenant whose currentness lookup throws the sentinel, armed by
  // the root's own blur so the throw lands in the host's reconciliation of the
  // MOUNT (after the park), never in the park.
  const sentinel = new Error('currentness sentinel')
  let sentinelArmed = false
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => {
      if (sentinelArmed) {
        sentinelArmed = false
        throw sentinel
      }
      return true
    },
    close: () => { closeCalls += 1 },
  }))
  await vt.waitForRender()
  const winner = { rows: ['winner editor'] }
  const root = advancedOverlayProbe('real-root', undefined, () => {
    // A real editor-winner change plus a plugin exception: the adapter routes the
    // exception to `onError` → notify → requestRender → editor reconciliation →
    // mountSeatChild → the tenant lookup throws `sentinel`, which escapes the
    // MOUNT (the initial PARK is already done).
    registry.register({ id: 'winner', priority: -1, create: () => rowsEditor(winner) }, 'plugin-winner')
    sentinelArmed = true
    throw new Error('plugin boom')
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'registered then failed' })
  let caught: unknown
  try {
    await settleOrTimeout(failed)
  } catch (error) {
    caught = error
  }
  const primary = caught instanceof AggregateError ? caught.errors[0] : caught
  assert.equal(primary, sentinel, `the mount failure must be the caller sentinel by identity: ${String(caught)}`)
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'the failed mount leaves no approval frame')
  assert.ok(
    !viewport(vt).includes('bash'),
    `the registered node and its raw projection must both be unwound:\n${viewport(vt)}`,
  )
  assert.ok(viewport(vt).includes('real-root'), `the original root must still be there:\n${viewport(vt)}`)
  assert.equal(app.assertOverlayForestForTest(), undefined)
  // The surviving root still owns the keyboard (it is a live capturing overlay);
  // once it leaves, the healthy tenant — parked during the failed mount — is the
  // live seat owner and must take it.
  rootLease.close()
  await vt.waitForRender()
  assert.equal(
    app.focusedComponentForTest(),
    tenant.component,
    'the healthy tenant is restored and focused once the last owner leaves',
  )
  const healthy = app.showApprovalPrompt({ toolName: 'grep', reason: 'healthy after the real chain' })
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(healthy), 'allowed-once')
  assert.equal(closeCalls, 0)
})

test('B-55: a failed Approval mount across a re-entrant fullscreen swap never pops the surviving root', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const sentinel = new Error('swap currentness sentinel')
  let sentinelArmed = false
  let closeCalls = 0
  const tenant = makeTenant()
  openOptional(app, () => ({
    component: tenant.component,
    isCurrent: () => {
      if (sentinelArmed) {
        sentinelArmed = false
        throw sentinel
      }
      return true
    },
    close: () => { closeCalls += 1 },
  }))
  await vt.waitForRender()
  const winner = { rows: ['winner editor'] }
  let chainStarted = false
  const root = advancedOverlayProbe('swap-root', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    // A re-entrant fullscreen swap inside the mount's physical transition: the
    // already-registered Approval node loses its raw projection to
    // `detachPhysical()`, and the surviving root is re-mounted on the NEW screen.
    app.setFullscreen(true)
    registry.register({ id: 'winner', priority: -1, create: () => rowsEditor(winner) }, 'plugin-winner')
    sentinelArmed = true
    throw new Error('plugin boom')
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const failed = app.showApprovalPrompt({ toolName: 'bash', reason: 'swap then failed' })
  let caught: unknown
  try {
    await settleOrTimeout(failed)
  } catch (error) {
    caught = error
  }
  const primary = caught instanceof AggregateError ? caught.errors[0] : caught
  assert.equal(primary, sentinel, `the mount failure must be the caller sentinel by identity: ${String(caught)}`)
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'the failed mount leaves no approval frame')
  assert.ok(
    !viewport(vt).includes('bash'),
    `the failed Approval must be unwound on the swapped screen too:\n${viewport(vt)}`,
  )
  assert.ok(
    viewport(vt).includes('swap-root'),
    `the RE-MOUNTED surviving root must never be popped as a ghost (its node's raw was cleared by the swap):\n${viewport(vt)}`,
  )
  assert.equal(app.assertOverlayForestForTest(), undefined)
  // The swapped surface stays coherent: the surviving root still owns the
  // keyboard, and once it leaves the healthy tenant is restored and receives input.
  rootLease.close()
  await vt.waitForRender()
  assert.equal(
    app.focusedComponentForTest(),
    tenant.component,
    'the healthy tenant is restored and focused after the last owner leaves',
  )
  const keysBefore = tenant.keys.length
  vt.sendInput('x')
  assert.equal(tenant.keys.length, keysBefore + 1, 'input reaches the live owner on the swapped screen')
  assert.equal(closeCalls, 0)
})

test('B-56: a fullscreen swap inside the Approval mount still leaves the dialog mounted', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let chainStarted = false
  const root = advancedOverlayProbe('swap-root-ok', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    // The SYMMETRIC path to B-55: the same re-entrant swap inside the mount's
    // physical transition, but NO throw — the mount completes and the Approval
    // commits as the active owner.
    app.setFullscreen(true)
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'swap during mount' })
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('bash'),
    `the active Approval must be physically mounted on the swapped screen:\n${viewport(vt)}`,
  )
  assert.equal(app.focusSeatForTest(), 'overlay', 'the approval owns the seat on the swapped screen')
  // The pre-swap wrapper identity is NOT a valid negative control after a swap
  // (the root is re-mounted as a NEW wrapper): the NEWER-owner control is B-57.
  assert.notEqual(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'the interleaved swap may not hand the live Approval keyboard to the editor',
  )
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(approval), 'allowed-once', 'the approval stays answerable after the swap')
  assert.equal(app.ownedApprovalFramesForTest(), 0, 'the settled approval leaves no frame behind')
  await vt.waitForRender()
  assert.equal(app.assertOverlayForestForTest(), undefined)
  assert.ok(viewport(vt).includes('swap-root-ok'), `the surviving root must be restored:\n${viewport(vt)}`)
  rootLease.close()
  await vt.waitForRender()
})

test('B-57: a callback NEWER focus inside the swap window beats the pre-swap owner', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let chainStarted = false
  let newerOwner: Component | null = null
  let rootLease: { focus(): void; close(): void } | undefined
  const root = advancedOverlayProbe('newer-focus-root', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    app.setFullscreen(true)
    // The SAME synchronous window performs a NEWER explicit focus: it must win over
    // the pre-swap owner the late Approval restore would otherwise re-install.
    rootLease!.focus()
    newerOwner = app.focusedComponentForTest()
  })
  rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')
  const blursBefore = root.blurCount()
  void blursBefore

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'swap then newer focus' })
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('bash'),
    `the Approval is still projected by its late remount:\n${viewport(vt)}`,
  )
  assert.notEqual(newerOwner, null)
  assert.equal(
    app.focusedComponentForTest(),
    newerOwner,
    'the callback NEWER focus must win over the pre-swap owner snapshot',
  )
  assert.equal(
    root.blurCount(),
    blursBefore + 1,
    'only the mount\'s own blur may happen: the late restore must not blur the newer owner',
  )
  // The newer owner leaves: the live Approval takes the keyboard (it is the
  // frontmost capturing root) and stays answerable.
  rootLease.close()
  await vt.waitForRender()
  assert.notEqual(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'the live Approval takes the keyboard once the newer root leaves',
  )
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(approval), 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0)
  assert.equal(app.assertOverlayForestForTest(), undefined)
})

test('B-57b: a capturing overlay mounted in the swap window keeps its keyboard', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let chainStarted = false
  let cOwner: Component | null = null
  let cLease: { blur(): void; close(): void } | undefined
  const c = advancedOverlayProbe('newer-capturing-c')
  const root = advancedOverlayProbe('newer-swap-root', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    app.setFullscreen(true)
    // A NEWER capturing mount (not just a focus()): its handoff must also survive
    // the late pre-swap restore.
    cLease = app.showAdvancedInteractiveOverlay(c.component)
    cOwner = app.focusedComponentForTest()
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1)

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'swap then newer mount' })
  await vt.waitForRender()
  assert.equal(c.focusCount(), 1, 'the newer capturing overlay auto-focused on its mount')
  assert.notEqual(cOwner, null)
  assert.equal(app.focusedComponentForTest(), cOwner, 'the newer mount keeps the keyboard')
  assert.equal(c.blurCount(), 0, 'the late restore must not blur the newer capturing owner')
  // VISUAL ORDER: the physical paint priority must follow the broker's logical
  // z-order — the later-mounted capturing overlay stays drawn on top of the
  // Approval panel it covers, never the other way round.
  assert.ok(
    viewport(vt).includes('newer-capturing-c'),
    `the newer capturing overlay must stay VISUALLY on top of the Approval:\n${viewport(vt)}`,
  )
  // (The Approval's own rows underneath the covering box are legitimately
  // hidden by it — the discriminating fact is that C is drawn at all, and the
  // Approval stays active and answerable below, asserted after C leaves.)
  // The newer overlay leaves: the live Approval takes over and settles.
  cLease!.close()
  await vt.waitForRender()
  assert.notEqual(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'the live Approval takes the keyboard once the newer overlay leaves',
  )
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(approval), 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0)
  assert.equal(app.assertOverlayForestForTest(), undefined)
})

test('B-58: an Advanced overlay whose own mount interleaves a swap is re-projected', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const late = advancedOverlayProbe('sibling-late-a')
  let chainStarted = false
  const root = advancedOverlayProbe('sibling-swap-root', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    // This root's blur is triggered by ANOTHER Advanced overlay's mount, and the
    // swap it starts detaches THAT overlay's projection while its mount is still in
    // flight — the sibling window, where its remount callback cannot exist yet.
    app.setFullscreen(true)
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const lateLease = app.showAdvancedInteractiveOverlay(late.component)
  await vt.waitForRender()
  assert.ok(
    viewport(vt).includes('sibling-late-a'),
    `an overlay whose own mount interleaved a swap must still be projected:\n${viewport(vt)}`,
  )
  assert.notEqual(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'a live overlay owns the keyboard, never the editor',
  )
  assert.equal(app.assertOverlayForestForTest(), undefined)
  rootLease.close()
  lateLease.close()
  await vt.waitForRender()
})

test('B-60: a NEWER owner that leaves inside the swap window still hands the keyboard to the live Approval', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let chainStarted = false
  const c = advancedOverlayProbe('early-leaver-c')
  const root = advancedOverlayProbe('early-leaver-root', undefined, () => {
    if (chainStarted) return
    chainStarted = true
    app.setFullscreen(true)
    // A newer capturing owner mounts and LEAVES inside the same synchronous window:
    // it does not hold the keyboard when the late restore runs, so the live, visible
    // Approval — never the editor — must own the keyboard afterwards.
    const cLease = app.showAdvancedInteractiveOverlay(c.component)
    cLease.close()
  })
  const rootLease = app.showAdvancedInteractiveOverlay(root.component)
  await vt.waitForRender()
  assert.equal(root.focusCount(), 1, 'the root owns the keyboard first')

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'newer owner left early' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('bash'), `the live Approval must be projected:\n${viewport(vt)}`)
  assert.notEqual(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'a live visible Approval owns the keyboard once the newer owner is gone',
  )
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(approval), 'allowed-once')
  await vt.waitForRender()
  assert.equal(app.ownedApprovalFramesForTest(), 0)
  assert.equal(app.assertOverlayForestForTest(), undefined)
  void rootLease
})

test('B-56: History as the seat tenant restores the plugin editor WINNER without writing the hidden host editor', async () => {
  const registry = new EditorRegistry()
  const history: import('../src/client/history/search.ts').HistorySearchSource = {
    search: async () => ({
      results: [{ id: 'h1', content: 'restored prompt', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
      exhausted: true,
    }),
  }
  const { vt, app } = startApp(registry, history)
  await vt.waitForRender()
  app.setDraft('host draft')
  await vt.waitForRender()
  const plugin = { text: '' }
  registerLiveView(registry, 'live', plugin)
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  app.setDraft('plugin draft')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'plugin draft', 'the plugin editor owns the seat document')

  // Esc: the plugin draft is untouched and the hidden host editor never moves.
  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  assert.ok(viewport(vt).includes('Input History'), `the History tenant owns the seat:\n${viewport(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'plugin draft', 'Esc must leave the plugin draft unchanged')
  assert.equal(app.hostEditorTextForTest(), 'host draft', 'Esc must never write the hidden host editor')

  // Enter: the CURRENT winner receives the accepted content.
  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  vt.sendInput('\r')
  await vt.waitForRender()
  await settle()
  assert.equal(app.seatTextForTest(), 'restored prompt', 'Enter populates the CURRENT seat winner')
  assert.equal(plugin.text, 'restored prompt', 'the plugin editor received the accepted content')
  assert.equal(app.hostEditorTextForTest(), 'host draft', 'the hidden host editor is never written')
  // The derived focus seat is the EDITOR again (the plugin winner's compiled
  // view is re-created per projection, so its identity is not the assertion —
  // the live seat derivation is).
  assert.equal(app.focusSeatForTest(), 'editor', 'focus returns to the editor seat after the restore')
})

// ---------------------------------------------------------------------------
// Phase 3B / B3-B: the REAL History tenant under the blocking owners and the
// plugin-editor winner handoff. B-56 pins the restore; these pin the PARK-time
// winner change/invalidate and the Question↔Save handoff.
// ---------------------------------------------------------------------------

test('B-61: the REAL History tenant: a plugin editor winner change + recompile while PARKED never ejects the blocker and Esc keeps the CURRENT winner', async () => {
  const registry = new EditorRegistry()
  const history: import('../src/client/history/search.ts').HistorySearchSource = {
    search: async () => ({
      results: [{ id: 'h1', content: 'parked prompt', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
      exhausted: true,
    }),
  }
  const { vt, app } = startApp(registry, history)
  await vt.waitForRender()
  app.setDraft('host draft')
  const first = { text: '' }
  registerLiveView(registry, 'first', first)
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  app.setDraft('first plugin')
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'first', 'the first plugin owns the seat')

  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  assert.ok(viewport(vt).includes('Input History'), `the History tenant owns the seat:\n${viewport(vt)}`)
  const panel = app.focusedComponentForTest()

  const question = app.askQuestions([{ id: 'q1', question: 'still holds the seat?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('still holds the seat?'), 'the Question owns the seat')
  assert.ok(!viewport(vt).includes('Input History'), 'the parked History is hidden')

  // Winner change + live-view recompile while PARKED: a LOWER priority editor
  // wins; its `setText` recompiles the view through the host invalidate seam.
  const second = { text: 'second view' }
  registerLiveView(registry, 'second', second, -1)
  app.reconcileEditorNow()
  app.requestRender()
  app.setDraft('second recompiled')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('still holds the seat?'),
    'the winner change/recompile must not eject the blocking Question')
  assert.ok(!viewport(vt).includes('Input History'), 'the parked History stays hidden')
  assert.equal(app.seatEditorForTest().id, 'second', 'the newer winner is the seat editor while parked')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'the SAME History tenant is restored after the blocker')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('Input History'))
  assert.equal(app.seatEditorForTest().id, 'second', 'the CURRENT winner — never the hidden host editor — takes the keyboard')
  assert.equal(app.seatTextForTest(), 'second recompiled', 'the recompiled winner keeps its live document')
  assert.equal(app.hostEditorTextForTest(), 'host draft', 'the hidden host editor is never written')
})

test('B-62: the REAL History tenant survives a Question↔Save Location handoff and is restored exactly once at the END', async () => {
  const history: import('../src/client/history/search.ts').HistorySearchSource = {
    search: async () => ({
      results: [{ id: 'h1', content: 'handoff prompt', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
      exhausted: true,
    }),
  }
  const { vt, app } = startApp(undefined, history)
  await vt.waitForRender()
  app.setDraft('handoff draft')
  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  assert.ok(viewport(vt).includes('Input History'))
  const panel = app.focusedComponentForTest()

  const save = askSave(app)
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('Save session archive'), 'the Save prompt owns the seat first')
  assert.ok(!viewport(vt).includes('Input History'), 'the parked History is hidden')

  const question = app.askQuestions([{ id: 'q1', question: 'takes over?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('takes over?'), 'the Question supersedes the Save prompt')
  assert.ok(!viewport(vt).includes('Input History'), 'no History projection mid-handoff')
  assert.deepEqual(await save, { kind: 'cancelled' }, 'the superseded Save prompt settles cancelled')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('Input History'), 'the History stays parked while the Question lives')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'the History is restored exactly once, at the very END')
  assert.equal(app.seatTextForTest(), 'handoff draft', 'the draft survived the whole handoff')
})

test('B-63: the REAL History tenant: a throwing stale cleanup while parking an Approval surfaces the error identity and rolls the owner back once', async (t) => {
  const history: import('../src/client/history/search.ts').HistorySearchSource = {
    search: async () => ({
      results: [{ id: 'h1', content: 'stale cleanup prompt', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }],
      exhausted: true,
    }),
  }
  const vt = new VirtualTerminal(100, 30)
  let tenantCurrent = true
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSteer: () => {},
  }, {
    historySearchSource: history,
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => tenantCurrent }),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.openHistorySearch()
  await vt.waitForRender()
  await settle()
  assert.ok(viewport(vt).includes('Input History'))

  // The ONE caller cleanup path of the REAL History panel: count its entries and
  // inject the shape of a throwing caller cleanup (the park's stale-tenant
  // retirement).
  const originalDispose = HistoryPanel.prototype.dispose
  let disposeCalls = 0
  let pendingThrow: { value: unknown } | undefined
  HistoryPanel.prototype.dispose = function patchedHistoryDispose(this: HistoryPanel): void {
    disposeCalls += 1
    const armed = pendingThrow
    pendingThrow = undefined
    originalDispose.call(this)
    if (armed !== undefined) throw armed.value
  }
  t.after(() => { HistoryPanel.prototype.dispose = originalDispose })

  tenantCurrent = false
  const boom = new Error('history stale cleanup boom')
  pendingThrow = { value: boom }
  const controller = new AbortController()
  const approval = app.showApprovalPrompt(
    { toolName: 'bash', reason: 'never presented', signal: controller.signal },
  )
  let caught: unknown
  try { await approval } catch (error) { caught = error }
  assert.equal(caught, boom, 'the ORIGINAL cleanup failure must surface by identity')
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'the failed approval must release its abort binding',
  )
  await vt.waitForRender()
  assert.equal(disposeCalls, 1, 'the stale History tenant is closed exactly once (no double close)')
  assert.ok(!viewport(vt).includes('bash'), 'the failed approval must never be presented')
  assert.ok(!viewport(vt).includes('Input History'), 'the retired History must not stay painted')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the seat projects the live editor again')
  // No half-committed approval: a fresh one is answerable.
  const healthy = app.showApprovalPrompt({ toolName: 'fs', reason: 'healthy after rollback' })
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('fs'))
  vt.sendInput('y')
  assert.equal(await settleOrTimeout(healthy), 'allowed-once')
})
