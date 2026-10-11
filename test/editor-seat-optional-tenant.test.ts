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

function makeTenant(seed = '', onFocusLost?: () => void): Tenant {
  const state = { current: true, closes: 0, keys: [] as string[], draft: seed, focused: false, gains: 0 }
  const component: Component & Focusable = {
    get focused(): boolean {
      return state.focused
    },
    set focused(value: boolean) {
      if (value && !state.focused) state.gains += 1
      const lost = !value && state.focused
      state.focused = value
      if (lost) onFocusLost?.()
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
  exits(): number
}

function startApp(registry?: EditorRegistry): AppHarness {
  const vt = new VirtualTerminal(100, 30)
  const submissions: string[] = []
  const steers: string[] = []
  let exitCount = 0
  const harness = { vt, submissions, steers, exits: () => exitCount } as AppHarness
  const app = new TuiApp(vt, {
    onSubmit: (text) => { submissions.push(text) },
    onExit: () => { exitCount += 1 },
    onSteer: (text) => { steers.push(text) },
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

test('B-03: two queued Questions never reveal a suspended overlay or refocus the tenant in between', async () => {
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
