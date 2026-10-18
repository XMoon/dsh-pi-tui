/**
 * The editor seat's PHYSICAL FOCUS AUTHORITY.
 *
 * The seat's physical mount (`EditorSeatMount`) wraps whatever occupies the
 * seat: the host `TuiEditor`, a plugin editor's compiled view, or a
 * History/Question/Save tenant frame. In Transcript Fullscreen a pointer press
 * inside the occupant reaches the fork's `Container.handleMouse`, which
 * promotes the mouse focus target to the mount CONTAINER itself, and
 * `TuiAltScreen` then focuses that container. The mount's transparent
 * `focused` / `handleInput` forwarding keeps typing working — but the PHYSICAL
 * focus fact is then the mount, not the real occupant.
 *
 * Four host consumers compare the physical focus to a target component by
 * STRICT IDENTITY and must never observe the mount:
 *
 * - `publishFocusSeat` / `optionalSeatOwnsKeyboard` / `optionalTenantHoldsFocus`
 *   (FOCUS-01: the optional seat tenant stays the seat panel and its keys);
 * - `publishFocusSeat` across a capturing overlay and a plugin-editor handoff
 *   (FOCUS-02: the seat occupant identity never drifts to the mount);
 * - `editorAccepts` (FOCUS-03: a plugin keybinding may not steal an
 *   editor-owned navigation key).
 *
 * Every case drives the REAL `TuiApp` + `VirtualTerminal` + native SGR bytes;
 * the pointer-focus requests below model the pointer capability an interactive
 * seat occupant exposes (the host `TuiEditor` is the built-in one).
 * @module @xmoon76/pi-tui/test/editor-seat-focus-authority
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent } from '@xmoon76/pi-tui'
import { EditorRegistry } from '../src/extension/internal/editor-registry.ts'
import type { EditorInputEvent, ExtensionEditor, ExtensionView } from '../src/extension/public-types.ts'
import type { HistorySearchResult, HistorySearchSource } from '../src/client/history/search.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp built here is disposed after each test: the process slot is
 *  released by the FINAL dispose, never by `stop()`. An unexpected teardown
 *  failure must FAIL the test (the production `dispose()` aggregates its own
 *  cleanup failures and may rethrow the EXACT thrown value — including
 *  `undefined`), while every remaining app is still released. The presence flag
 *  is separate from the value so a thrown `undefined` is not mistaken for
 *  "no failure". */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  let failed = false
  let failure: unknown
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try {
      app.dispose()
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }
  if (failed) throw failure
})

const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripTerminalSequences)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number =>
  rawView(vt).findIndex(line => line.includes(needle))

/** Drain every coalesced projection microtask (focus seat publish / render). */
async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}
/** One native SGR press+release on the SAME cell: a synthesized primary click. */
const click = (vt: VirtualTerminal, row: number, col: number): void => {
  press(vt, row, col)
  release(vt, row, col)
}

// ---------------------------------------------------------------------------
// The private optional-seat tenant seam (the History/optional tenant contract).
// ---------------------------------------------------------------------------

interface OptionalSeatTenantSpec {
  readonly component: Component & Focusable
  readonly isCurrent: () => boolean
  readonly close: () => void
}
interface OptionalSeatSeam {
  tryOpenOptionalSeatTenant(create: () => OptionalSeatTenantSpec): { close(): void } | undefined
}

interface Tenant {
  readonly component: Component & Focusable
  readonly keys: string[]
  draft(): string
  closeCalls(): number
  spec(): OptionalSeatTenantSpec
}

/**
 * One scripted optional tenant whose painted surface ACCEPTS pointer focus: a
 * left press asks the screen to focus it, exactly like the host editor (and
 * any interactive input view) does. Its own key sink / draft proves that the
 * tenant keeps its state and receives input while it is the seat occupant.
 */
function makePointerTenant(seed = ''): Tenant {
  const state = { keys: [] as string[], draft: seed, focused: false, closes: 0 }
  const component: Component & Focusable = {
    get focused(): boolean {
      return state.focused
    },
    set focused(value: boolean) {
      state.focused = value
    },
    render: () => [`optional-tenant:${state.draft}`],
    invalidate: () => {},
    handleInput: (data: string) => {
      state.keys.push(data)
      if (data.length === 1 && data >= ' ' && data <= '~') state.draft += data
    },
    handleMouse: (event: TuiMouseEvent) =>
      event.type === 'press' && event.button === 'left' ? { handled: true, focus: true } : undefined,
  }
  return {
    component,
    keys: state.keys,
    draft: () => state.draft,
    closeCalls: () => state.closes,
    spec: () => ({
      component,
      isCurrent: () => true,
      close: () => { state.closes += 1 },
    }),
  }
}

function openTenant(app: TuiApp, tenant: Tenant): { close(): void } | undefined {
  return (app as unknown as OptionalSeatSeam).tryOpenOptionalSeatTenant(() => tenant.spec())
}

/** The zero-based draft line the editor cursor currently sits on. */
function cursorLine(app: TuiApp): number {
  const draft = app.getDraft()
  return draft.slice(0, app.seatEditorForTest().getCursor()).split('\n').length - 1
}

// ---------------------------------------------------------------------------
// FOCUS-01: the optional seat tenant stays the physical focus owner.
// ---------------------------------------------------------------------------

test('FOCUS-01 a fullscreen click inside the optional seat tenant leaves the PANEL as the input owner', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()

  const tenant = makePointerTenant()
  const lease = openTenant(app, tenant)
  assert.notEqual(lease, undefined, 'an unblocked optional open must return a lease')
  await vt.waitForRender()
  await flush(2)
  assert.ok(view(vt).includes('optional-tenant:'), `the tenant must paint its own surface:\n${view(vt)}`)

  const row = rowOf(vt, 'optional-tenant:')
  assert.ok(row >= 0, `the tenant surface must be locatable:\n${view(vt)}`)
  click(vt, row, 3)
  await vt.waitForRender()
  await flush(8)

  // (a) The tenant itself is the resolved input owner — never the seat mount.
  assert.equal(
    app.inputOwnerForTest(),
    tenant.component,
    'a fullscreen click inside the tenant must leave the TENANT as the input owner',
  )
  // (b) The derived seat projection observes the live physical focus.
  await flush(2)
  assert.equal(
    app.focusSeatForTest(),
    'editor-panel',
    'the optional tenant must still project as the editor-panel seat',
  )
  // (c) The tenant keeps the keyboard and the HOST draft stays untouched.
  vt.sendInput('h')
  vt.sendInput('i')
  await vt.waitForRender()
  await flush(2)
  assert.deepEqual(tenant.keys, ['h', 'i'], 'every key after the click must reach the tenant')
  assert.equal(tenant.draft(), 'hi', 'the tenant owns its own state')
  assert.equal(app.hostEditorTextForTest(), '', 'the host editor must never receive a tenant key')
  assert.equal(app.getDraft(), '', 'the Host draft must stay untouched behind the tenant')

  // (d) The RAW PROTOCOL sink fence resolves the SAME owner. A terminal focus
  // report is a Host protocol chunk: while the mount-focused tenant owns the
  // keyboard the fence must CONSUME it instead of letting the seat mount forward
  // it into the tenant. Reverting only this predicate (`optionalTenantHoldsFocus`)
  // to raw object identity delivers the chunk to the tenant — that is what keeps
  // this branch failable.
  const keysBeforeProtocol = [...tenant.keys]
  vt.sendInput('\x1b[I')
  await vt.waitForRender()
  await flush(2)
  assert.deepEqual(tenant.keys, keysBeforeProtocol,
    'a Host protocol chunk must be consumed by the protocol sink fence, never forwarded to the tenant')

  lease?.close()
  assert.equal(tenant.closeCalls(), 1, 'the caller close runs exactly once')
})

// ---------------------------------------------------------------------------
// FOCUS-02: capturing overlay open/close + plugin-editor handoff.
// ---------------------------------------------------------------------------

test('FOCUS-02 a fullscreen editor click, a capturing overlay and a plugin editor handoff never leave a wrong input owner', async () => {
  const vt = new VirtualTerminal(100, 30)
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  const hostDraft = 'host draft'
  app.setDraft(hostDraft)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()

  // A press inside the host editor's painted rows accepts pointer focus (the
  // built-in seat occupant's capability). The seat mount must forward that
  // focus to the editor, never promote its own container.
  const promptRow = rowOf(vt, '❯')
  assert.ok(promptRow >= 0, `the editor must paint its prompt row:\n${view(vt)}`)
  click(vt, promptRow, 2)
  await vt.waitForRender()
  await flush(8)
  assert.equal(
    app.inputOwnerForTest(),
    app.seatEditorForTest().component,
    'a fullscreen click inside the editor must leave the EDITOR as the input owner',
  )

  // A capturing overlay owns the keyboard while it is open and must release it
  // back to the SAME seat occupant when it closes.
  const picker = app.openPicker([{ value: 'a', label: 'pick-me' }], () => {}, () => {})
  await vt.waitForRender()
  await flush(8)
  assert.notEqual(
    app.inputOwnerForTest(),
    app.seatEditorForTest().component,
    'the capturing overlay must own the keyboard while it is open',
  )
  assert.equal(app.focusSeatForTest(), 'overlay', 'a capturing overlay projects the overlay seat')
  picker.close?.()
  await vt.waitForRender()
  await flush(8)
  assert.equal(
    app.inputOwnerForTest(),
    app.seatEditorForTest().component,
    'closing the capturing overlay must restore the live seat occupant',
  )

  // A plugin editor handoff replaces the seat occupant: the new compiled view
  // is the physical focus owner and receives typing; the hidden host editor
  // keeps its own draft untouched.
  const pluginKeys: string[] = []
  let pluginText = hostDraft
  const plugin: ExtensionEditor = {
    get component(): ExtensionView {
      return { kind: 'text', spans: [{ text: `plugin:${pluginText}` }] }
    },
    getText: () => pluginText,
    setText: (text: string) => { pluginText = text },
    getCursor: () => 0,
    setCursor: () => {},
    handleInput: (event: EditorInputEvent) => {
      pluginKeys.push(event.kind === 'key' ? event.key.key : event.kind === 'text' ? event.text : event.kind)
      return true
    },
    dispose: () => {},
  }
  registry.register({ id: 'plugin-editor', priority: 1, create: () => plugin }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  await flush(8)

  assert.equal(app.seatEditorForTest().id, 'plugin-editor', 'the plugin editor must win the seat')
  assert.equal(
    app.inputOwnerForTest(),
    app.seatEditorForTest().component,
    'the handoff must leave the PLUGIN VIEW as the input owner',
  )
  vt.sendInput('x')
  await vt.waitForRender()
  await flush(2)
  assert.deepEqual(pluginKeys, ['x'], 'typing must reach the plugin seat occupant')
  assert.equal(app.hostEditorTextForTest(), hostDraft, 'the hidden host editor must not receive the plugin key')
})

// ---------------------------------------------------------------------------
// FOCUS-03: a plugin binding may not steal an editor-owned navigation key.
// ---------------------------------------------------------------------------

test('FOCUS-03 a plugin Down binding never takes the key while the seat editor owns the seat', async () => {
  const vt = new VirtualTerminal(100, 30)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action: string) => { actions.push(action) },
  }, {
    // The plugin stage maps the Down key to a public action; the host editor's
    // own navigation binding must outrank it whenever the editor is focused.
    pluginActionFor: (key) => key.key === 'down' && !key.ctrl && !key.alt ? 'open-search' : undefined,
  })
  app.start()
  startedApps.add(app)
  app.setDraft('one\ntwo\nthree')
  await vt.waitForRender()
  app.keybindingsManager().setPluginRules([{ id: 'plugin-down', action: 'open-search', key: 'down' }])
  app.setFullscreen(true)
  await vt.waitForRender()

  // A press inside the editor makes the editor the input owner. `editorAccepts`
  // reads the RESOLVED input owner: the seat mount never stands in for it.
  const promptRow = rowOf(vt, '❯')
  assert.ok(promptRow >= 0, `the editor must paint its prompt row:\n${view(vt)}`)
  click(vt, promptRow, 1)
  await vt.waitForRender()
  await flush(8)
  assert.equal(actions.length, 0, 'the click itself must not dispatch a plugin action')

  vt.sendInput('\x1b[B') // Down
  await vt.waitForRender()
  await flush(8)
  assert.deepEqual(actions, [], 'the editor owns Down: the plugin binding must NOT take the key')
  assert.equal(cursorLine(app), 1, 'the editor must consume Down and move the cursor to the second draft line')
  assert.equal(app.getDraft(), 'one\ntwo\nthree', 'Down is a cursor move, never a draft edit')
})

// ---------------------------------------------------------------------------
// FOCUS-04: the REAL History tenant path is a GUARD, not a defect witness.
// ---------------------------------------------------------------------------

/** One History search result row (the production `HistorySearchResult` shape). */
function historyRow(content: string, ts: number): HistorySearchResult {
  return { id: content, content, cwd: '/work/a', ts, sourceFile: '/work/a/history.jsonl', sourceByteOffset: 0 }
}

test('FOCUS-04 a fullscreen click inside the REAL History tenant leaves the PANEL as the input owner', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    historySearchSource: {
      search: async () => ({ results: [historyRow('alpha prompt', 3), historyRow('beta prompt', 2)], exhausted: true }),
    } satisfies HistorySearchSource,
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()

  // Mount the REAL optional seat tenant through the production entry.
  app.openHistorySearch()
  await vt.waitForRender()
  await flush(8)

  const panel = (app as unknown as { historyPanel?: Component }).historyPanel
  assert.ok(panel !== undefined, `the real History tenant must be mounted:\n${view(vt)}`)
  assert.ok(view(vt).includes('Input History'), `the panel must paint its seat frame:\n${view(vt)}`)
  assert.equal(app.inputOwnerForTest(), panel, 'the mounted panel is the input owner')
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the History tenant projects the editor-panel seat')

  // A RESULT-row click is DELIVERED to the panel (the selection moves), and it
  // must not move either the raw physical focus or the resolved input owner off
  // the panel.
  const resultRow = rowOf(vt, 'beta prompt')
  const resultCol = resultRow < 0 ? -1 : rawView(vt)[resultRow]!.indexOf('beta prompt')
  assert.ok(resultRow >= 0 && resultCol >= 0, `the result rows must paint:\n${view(vt)}`)
  click(vt, resultRow, resultCol + 1)
  await vt.waitForRender()
  await flush(8)
  assert.ok(
    rawView(vt).some(line => line.startsWith('> ') && line.includes('beta prompt')),
    `the result click must reach the panel (the selection moves):\n${view(vt)}`,
  )
  assert.equal(app.focusedComponentForTest(), panel, 'a result click must not move the physical focus off the panel')
  assert.equal(app.inputOwnerForTest(), panel, 'a result click must not move the input owner off the panel')

  // The QUERY-row click is delivered too, and it cannot promote the seat mount:
  // the REAL `HistoryPanel.handleMouse` deliberately DROPS the query Input's own
  // focus intent (it returns `{handled:true}`, never `focus:true`), so no
  // `result.focus` ever reaches the fork's `Container.handleMouse` and the mount
  // is never installed as the focus target. THIS is why the real path is a
  // GUARD rather than a defect witness: the mount promotion needs an occupant
  // whose painted surface requests pointer focus (FOCUS-01's scripted tenant,
  // FOCUS-02's host editor).
  //
  // The click's delivery is witnessed through the Input's own cursor: with the
  // query seeded, a press at the leading input cell moves the caret to offset 0,
  // so the next typed keys land BEFORE the seed ("xyab", never "abxy").
  vt.sendInput('a')
  vt.sendInput('b')
  await vt.waitForRender()
  await flush(2)
  assert.ok(
    rawView(vt).some(line => line.includes('Search: > ab')),
    `the seeded query must paint before the pointer gesture:\n${view(vt)}`,
  )
  const searchRow = rowOf(vt, 'Search:')
  assert.ok(searchRow >= 0, `the query row must paint:\n${view(vt)}`)
  const searchCol = rawView(vt)[searchRow]!.indexOf('Search: ') + 'Search: '.length
  click(vt, searchRow, searchCol)
  await vt.waitForRender()
  await flush(8)
  assert.equal(app.focusedComponentForTest(), panel, 'a query-row click must not move the physical focus off the panel')
  assert.equal(app.inputOwnerForTest(), panel, 'a query-row click must not move the input owner off the panel')
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the panel keeps the editor-panel projection after the clicks')

  // Keys after the pointer gestures reach the PANEL's own query input; nothing
  // leaks past the tenant into the hidden host editor / Host draft.
  vt.sendInput('x')
  vt.sendInput('y')
  await vt.waitForRender()
  await flush(2)
  assert.ok(
    rawView(vt).some(line => line.includes('Search: > xyab')),
    `the panel's query input must receive the typed keys at the clicked caret:\n${view(vt)}`,
  )
  assert.equal(app.hostEditorTextForTest(), '', 'the host editor must never receive a tenant key')
  assert.equal(app.getDraft(), '', 'the Host draft must stay untouched behind the tenant')
})
