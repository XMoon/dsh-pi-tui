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
import { afterEach, test } from 'node:test'
import { initialStatusSnapshot } from '../src/domain/status/snapshot.ts'
import type { StatusStore } from '../src/domain/status/store.ts'
import { EditorRegistry } from '../src/extension/internal/editor-registry.ts'
import type { AdvancedInteractiveComponent } from '../src/extension/advanced-types.ts'
import type { EditorHost, ExtensionEditor, ExtensionView } from '../src/extension/public-types.ts'
import type { SaveLocationDeps, SaveLocationResult } from '../src/tui/interaction/save-location.ts'
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
}

function startApp(registry?: EditorRegistry): AppHarness {
  const vt = new VirtualTerminal(100, 30)
  const submissions: string[] = []
  const steers: string[] = []
  const focusReports: boolean[] = []
  let exitCount = 0
  const harness = { vt, submissions, steers, focusReports, exits: () => exitCount } as AppHarness
  const app = new TuiApp(vt, {
    onSubmit: (text) => { submissions.push(text) },
    onExit: () => { exitCount += 1 },
    onSteer: (text) => { steers.push(text) },
    onTerminalFocus: (focused) => { focusReports.push(focused) },
  }, registry === undefined ? {} : { editorRegistry: registry })
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

test('B-23: the existing History overlay is suspended/restored by a Question and stays outside the tenant seam', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    historySearchSource: { search: async () => ({ results: [], exhausted: true }) },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.openHistorySearch()
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('History Search'), `the history overlay must be up:\n${viewport(vt)}`)
  vt.sendInput('abc')
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('abc'), 'the query is typed into the history panel')

  const question = app.askQuestions([{ id: 'q1', question: 'history under a question?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('history under a question?'))
  assert.ok(!viewport(vt).includes('History Search'), 'the history overlay is suspended, not migrated')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(viewport(vt).includes('History Search'), 'the history overlay is restored by its own suspension')
  assert.ok(viewport(vt).includes('abc'), 'the query survives the suspension')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewport(vt).includes('History Search'), 'the history panel keeps its own Esc close contract')
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
function advancedOverlayProbe(text: string): {
  component: AdvancedInteractiveComponent
  focusCount(): number
  blurCount(): number
} {
  const state = { focus: 0, blur: 0 }
  return {
    component: {
      render: () => ({ kind: 'text', spans: [{ text }] }),
      handleInput: () => false,
      onFocus: () => { state.focus += 1 },
      onBlur: () => { state.blur += 1 },
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
  void save
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

  const question = app.askQuestions([{ id: 'q1', question: 'never presented?', options: [{ label: 'Yes' }] }])
  await assert.rejects(question, /stale tenant close boom/)
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

  const save = askSave(app)
  await assert.rejects(save, /stale tenant close boom/)
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

  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'never presented' })
  await assert.rejects(approval, /stale tenant close boom/)
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
