/**
 * B3-A2: the ONE temporary Work Details Reader resource of the TSP renderer.
 *
 * The chain under test is the PRODUCTION mount (`mountTspRenderer` over the
 * scripted pane installed as the process tty): the real Work Hub presenter, the
 * real one SDK `Session` with its base inline surface, the real temporary
 * `mode:'screen'` surface, the real input iterator, the real interaction seat
 * and the SDK's own wire. Only the tty boundary is scripted, so every claim
 * here is about the production composition — never a hand-rolled surface.
 *
 * Evidence level: scripted SDK wire (not a real Tern client). A2 is
 * `PROJECTION_ONLY`: production `/tasks` stays unreachable, so this presenter is
 * driven through the internal presentation port exactly as A3 will.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-work-reader-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { OpenOptions, Session, Surface } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskBrowserPresentationOpen,
} from '../../src/app/surface/task-presentation-port.ts'
import type { TuiQuestion } from '../../src/app/surface/interaction-presenter.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import {
  pickerNode,
  pickerProps,
  surfaceFocusOps,
  surfaceFrames,
  surfaceNodes,
  surfaceScrollOps,
  surfaceTexts,
  sendAction,
  sendSelect,
} from '../support/tsp-picker-wire.ts'

const HUB = 'work-hub-'
const BASE = 's1'

interface ReaderHarness {
  readonly pane: TspPane
  readonly session: Session
  renderer: TspRenderer
  readonly opens: TaskBrowserPresentationHandle[]
  readonly selects: string[]
  readonly closes: number[]
  readonly retires: string[]
  readonly cancels: number[]
  readonly fatals: unknown[]
  open(items: readonly TaskPanelItem[], overrides?: Partial<TaskBrowserPresentationOpen>): TaskBrowserPresentationHandle
  /** The id of the CURRENT temporary Reader surface, from the real wire. */
  readerId(): string | undefined
  dispose(): Promise<void>
}

function row(value: string, overrides: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return {
    value,
    label: value,
    status: 'running',
    source: 'job',
    type: 'bash',
    active: true,
    ...overrides,
  }
}

function options(overrides: Partial<TaskBrowserPresentationOpen> = {}): TaskBrowserPresentationOpen {
  return {
    header: 'Tasks',
    mode: 'full',
    openedFrom: 'command',
    scope: 'all',
    enableSearch: true,
    expandedIds: [],
    collapsedIds: [],
    maxVisible: 18,
    loading: false,
    groupLabels: true,
    onRefresh: () => {},
    onStop: () => {},
    onViewportExpose: () => {},
    onRetired: () => {},
    ...overrides,
  }
}

/** Mount the production renderer over a Reader-capable scripted pane. */
async function mount(
  t: { after(fn: () => unknown): void },
  paneOptions: { readonly kinds?: readonly string[]; readonly features?: readonly string[] } = {},
): Promise<ReaderHarness> {
  // The Session Browser opt-in advertises the Hub's native Picker; the Reader
  // needs `row`/`text` and the official `scroll` feature, both of which this
  // pane set carries — the same negotiated vocabulary the real client reports.
  const pane = installTspPane({ sessionBrowser: true, workDetails: true, ...paneOptions })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  let disposed = false
  const restorePane = (): void => { if (!disposed) pane.restore() }
  t.after(restorePane)
  const fatals: unknown[] = []
  const harness: ReaderHarness = {
    pane,
    session,
    renderer: undefined as unknown as TspRenderer,
    opens: [],
    selects: [],
    closes: [],
    retires: [],
    cancels: [],
    fatals,
    open(items, overrides = {}) {
      const handle = harness.renderer.taskPresentation.openBrowser(
        items,
        (value) => { harness.selects.push(value); return 'close' },
        () => { harness.closes.push(1) },
        options({
          onRetired: reason => { harness.retires.push(reason) },
          ...overrides,
        }),
      )
      harness.opens.push(handle)
      return handle
    },
    readerId: () => [...pane.openSurfaces()].reverse().find(entry => entry.mode === 'screen')?.id,
    dispose: async () => {
      try {
        await harness.renderer.dispose()
      } finally {
        disposed = true
        pane.restore()
      }
    },
  }
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => { void harness.renderer.dispose().catch(() => {}) })
  renderer.bindInput({
    exit() {},
    cancel: () => { harness.cancels.push(1) },
    submit: () => { throw new Error('Reader input must never reach the composer submit path') },
    steer() {},
    pasteMedia: () => {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  harness.renderer = renderer
  return harness
}

/** The live text of the CURRENT Reader surface. */
function readerTexts(h: ReaderHarness, id: string): string[] {
  return surfaceTexts(h.pane, id)
}

/** The actual registered node id of the Reader's `← Work` row. */
function backNodeId(h: ReaderHarness, id: string): string | undefined {
  return surfaceNodes(h.pane, id).find(node => node.id.includes('.work-back-'))?.id
}

/** Every surface id the wire saw opened, in order, with its mode. */
function openedSurfaces(h: ReaderHarness): Array<{ id: string; mode?: string; title?: string }> {
  return [...h.pane.openSurfaces()]
}

/** The acts a surface's frames really carried (the whole added subtree). */
function actsOf(h: ReaderHarness, sf: string): string[] {
  interface WireSubtree {
    readonly p?: { readonly actions?: { readonly click?: string } }
    readonly c?: readonly WireSubtree[]
  }
  const acts: string[] = []
  const visit = (node: WireSubtree): void => {
    if (typeof node.p?.actions?.click === 'string') acts.push(node.p.actions.click)
    for (const child of node.c ?? []) visit(child)
  }
  for (const frame of surfaceFrames(h.pane, sf)) {
    for (const op of frame.ops) {
      if (op[0] === 'add') visit(op[4] as unknown as WireSubtree)
    }
  }
  return acts
}

/** Replace ONE method on the production instance, keeping the original receiver
 *  contract (`original.call(instance, …)` — never a `.bind`). */
function patchMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
  const original = target[key]
  target[key] = replacement
  return () => { target[key] = original }
}

/** Patch the SDK session's `open` so a case can observe/fail the acquired Screen. */
function patchOpen(session: Session, hook: (surface: Surface, options: OpenOptions) => void): () => void {
  return patchMethod(session, 'open', function (this: Session, openOptions?: OpenOptions) {
    const surface = Object.getPrototypeOf(session).open.call(this, openOptions) as Surface
    hook(surface, openOptions ?? {})
    return surface
  })
}

/** Focus and scroll the Reader already received (the SDK's own wire ops). */
function readerScrolls(h: ReaderHarness, id: string): Array<{ id: string; to: string }> {
  return surfaceScrollOps(h.pane, id)
}

async function openHub(h: ReaderHarness, items: readonly TaskPanelItem[]): Promise<void> {
  h.open(items)
  await waitUntil('the Work Hub picker is mounted', () => pickerNode(h.pane, HUB) !== undefined)
}

/** Enter the Reader for the CURRENT row and wait for its surface's document. */
async function enterReader(h: ReaderHarness): Promise<string> {
  const before = (h.readerId())
  h.pane.key('\r')
  await waitUntil('the temporary Reader surface renders its document', () => {
    const id = h.readerId()
    return id !== undefined && id !== before && surfaceNodes(h.pane, id).length > 0
  })
  return h.readerId()!
}

// ── R01: one Session, one base surface, one temporary Screen ────────────────

test('Enter opens ONE temporary screen on the SAME Session and shows the current row without the business router', async (t) => {
  const h = await mount(t)
  await openHub(h, [
    row('job:j1', { label: 'integration build', status: 'running', startedAt: 2_000 }),
    row('job:j2', { label: 'unit tests', status: 'failed', active: false, detail: 'one assertion failed' }),
  ])
  await waitUntil('the failed row is selected', () => pickerProps(h.pane, HUB).selected === 'job:j2')
  const surfacesBefore = h.session.surfaces.length
  const reader = await enterReader(h)

  assert.equal(h.session.surfaces.length, surfacesBefore + 1, 'exactly ONE extra surface exists')
  assert.equal(h.session.surfaces.filter(surface => surface.mode === 'screen').length, 1,
    'exactly one screen-mode surface is open')
  const opened = openedSurfaces(h)
  assert.equal(opened.filter(entry => entry.mode === 'screen').length, 1, 'the wire saw ONE screen open')
  const screen = opened.find(entry => entry.mode === 'screen')!
  assert.equal(screen.title, 'Work details', 'the screen advertises its own title')
  assert.equal(reader, screen.id)
  assert.equal(screen.id.startsWith(BASE), false, 'the Reader is a DISTINCT surface from the base')
  const content = readerTexts(h, reader)
  assert.equal(content[0], '← Work', 'the document leads with the navigation row')
  assert.ok(content.includes('unit tests'), 'the current row label is shown')
  assert.ok(content.includes('Job · failed'), 'the real status word is shown')
  assert.ok(content.includes('Stable ID job:j2'), 'the stable row id is shown')
  assert.ok(content.includes('one assertion failed'), 'the row detail is shown')
  assert.deepEqual(h.selects, [], 'opening the Reader never runs the business row router')
  assert.deepEqual(h.cancels, [], 'opening the Reader never cancels the main Agent')
})

// ── R07/R08: Back by Esc and by the REAL navigation row ─────────────────────

test('Esc returns to the SAME Hub panel state and closes exactly one Screen without cancelling the Agent', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1'), row('job:j2', { label: 'second' })])
  sendSelect(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  await waitUntil('the second row is selected', () => pickerProps(h.pane, HUB).selected === 'job:j2')
  h.pane.key('s')
  await waitUntil('a query is live', () => pickerProps(h.pane, HUB).query === 's')
  const pickerIdBefore = pickerNode(h.pane, HUB)!.id
  const reader = await enterReader(h)
  const closeFramesBefore = h.pane.closeFrames()

  h.pane.key('\u001b')
  await waitUntil('the Reader close frame reached the wire', () => h.pane.closeFrames() === closeFramesBefore + 1)
  assert.deepEqual(h.pane.closedSurfaceIds(), [reader], 'the Screen itself was the closed surface')
  assert.deepEqual(h.cancels, [], 'Esc in the Reader never cancels the main Agent')

  assert.equal(pickerNode(h.pane, HUB)!.id, pickerIdBefore, 'the SAME Hub panel is displayed again')
  assert.equal(pickerProps(h.pane, HUB).selected, 'job:j2', 'the selection is preserved')
  assert.equal(pickerProps(h.pane, HUB).query, 's', 'the query is preserved')
  assert.equal(pickerNode(h.pane, HUB)!.p.state, 'ready', 'the refresh state is preserved')
  assert.deepEqual(h.selects, [], 'Back is not a business selection')
  assert.deepEqual(h.closes, [], 'Back never closes the Hub itself')
})

test('clicking the REAL `← Work` row returns, and a stale or foreign target is ignored', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const back = backNodeId(h, reader)
  assert.ok(back, 'the document registers a real Back node id')
  assert.ok(actsOf(h, reader).includes('click'), 'the Back row really carries the click action on the wire')

  // A foreign surface id and a fabricated node id must change nothing.
  h.pane.event({ ev: 'action', sf: 's9', id: back, act: 'click' })
  h.pane.event({ ev: 'action', sf: reader, id: `${back}.made-up`, act: 'click' })
  await waitUntil('the foreign targets change nothing', () => h.pane.closeFrames() === 0)
  assert.equal(h.readerId(), reader, 'the Reader is still the current one')

  h.pane.event({ ev: 'action', sf: reader, id: back, act: 'click' })
  await waitUntil('the real Back row closes the Reader', () => h.pane.closeFrames() === 1)
  assert.deepEqual(h.pane.closedSurfaceIds(), [reader])
  assert.ok(pickerNode(h.pane, HUB) !== undefined, 'the same Hub is shown again')
  assert.deepEqual(h.cancels, [], 'the native Back never cancels the main Agent')
})

// ── currentness across the Reader handover ─────────────────────────────────

test('a delayed `details#N` from BEFORE the reading cannot open a second screen after the return', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1', { label: 'build' })])
  const pickerId = pickerNode(h.pane, HUB)!.id
  const staleAction = String(((pickerProps(h.pane, HUB).actions ?? []) as Array<Record<string, unknown>>)[1]!.id)
  assert.equal(/^details#\d+$/u.test(staleAction), true, `the pre-reading token is revision-tokened: ${staleAction}`)
  const screens = (): number => h.pane.openSurfaces().filter(entry => entry.mode === 'screen').length

  // A full reading round trip. Nothing about the panel changes except the
  // handover itself, so without a handover-scoped invalidation the SAME token
  // would still address the re-painted action.
  const reader = await enterReader(h)
  h.pane.key('\u001b')
  await waitUntil('the Reader closed', () => h.pane.closedSurfaceIds().includes(reader))
  await waitUntil('the Hub is painted again with the read action',
    () => ((pickerProps(h.pane, HUB).actions ?? []) as unknown[]).length === 2)

  // The pre-reading action must now be dead. A stale action that is (wrongly)
  // accepted would acquire a NEW surface synchronously, so the negative window
  // is bounded and the assertion is on the real open count, not on a string.
  const freshActions = (): Array<Record<string, unknown>> => (pickerProps(h.pane, HUB).actions ?? []) as Array<Record<string, unknown>>
  const freshToken = String(freshActions()[1]?.id ?? '')
  sendAction(h.pane, staleAction, undefined, pickerId)
  await new Promise(resolve => setTimeout(resolve, 150)) // reason: bounded negative-observation window for a rejected stale action
  // `screens()` counts every screen the wire ever OPENED; a second acquisition
  // would raise it. A closed-and-settled reading leaves the count unchanged.
  assert.equal(screens(), 1, 'a delayed pre-reading action NEVER opens a second screen')
  assert.notEqual(staleAction, freshToken,
    `the re-painted action carries a DIFFERENT token than the pre-reading frame: stale=${staleAction} fresh=${freshToken}`)

  // …while the action painted AFTER the return still reads normally.
  const freshAction = String(((pickerProps(h.pane, HUB).actions ?? []) as Array<Record<string, unknown>>)[1]!.id)
  assert.notEqual(freshAction.replace(/#\d+$/u, ''), '', 'the returned action is still the read intent')
  sendAction(h.pane, freshAction, undefined, pickerId)
  await waitUntil('the fresh action opens a NEW reading', () => screens() === 2)
  assert.equal(screens(), 2, 'the current action opens exactly one new screen')
  assert.deepEqual(h.selects, [], 'neither the stale nor the fresh read action ran the business router')
})

// ── R09: a NEW reading takes a NEW identity, one Screen at a time ───────────

test('a second reading after Back takes a new surface and epoch with only one Reader present', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1', { label: 'first' }), row('job:j2', { label: 'second' })])
  const first = await enterReader(h)
  const firstBack = backNodeId(h, first)!
  h.pane.key('\u001b')
  await waitUntil('the first Reader closed', () => h.pane.closeFrames() === 1)

  sendSelect(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  await waitUntil('the second row is selected', () => pickerProps(h.pane, HUB).selected === 'job:j2')
  const second = await enterReader(h)

  assert.notEqual(second, first, 'a new reading acquires a NEW surface')
  const secondBack = backNodeId(h, second)!
  assert.notEqual(secondBack, firstBack, 'the new reading owns a NEW Back target')
  assert.equal(surfaceNodes(h.pane, second).filter(node => node.k === 'row' && node.id.includes('.work-back-')).length, 1,
    'exactly ONE Back row exists in the new document')
  assert.equal(h.session.surfaces.filter(surface => surface.mode === 'screen').length, 1,
    'only ONE temporary screen is open at a time')
  assert.ok(readerTexts(h, second).includes('second'), 'the new document reads the new row')

  // A late click addressed at the CLOSED reading's node id does nothing.
  h.pane.event({ ev: 'action', sf: first, id: firstBack, act: 'click' })
  await waitUntil('the retired reading cannot act', () => h.pane.closeFrames() === 1)
  assert.equal(h.readerId(), second, 'the current Reader is untouched by the retired one')
})

// ── R02/R27: the paint-time action follows the REAL admission ───────────────

test('the Hub paints the read action only while a Reader can really be admitted, and never claims an unsupported pane', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const actions = (): string[] => ((pickerProps(h.pane, HUB).actions ?? []) as Array<Record<string, unknown>>)
    .map(action => String(action.id).replace(/#\d+$/u, ''))
  assert.deepEqual(actions(), ['close', 'details'], 'a readable pane offers the action')

  // While the Reader is OPEN the base frame must not advertise a read action the
  // renderer would refuse. Whether the client shows that frame is its own
  // presentation decision (a measured build covers it), so the requirement is on
  // the painted frame, not on an assumed user-visible tab…
  const reader = await enterReader(h)
  const settle = new Promise<void>(resolve => { setTimeout(resolve, 0) })
  await settle
  await waitUntil('the Hub repainted without the read action', () => actions().length === 1)
  assert.deepEqual(actions(), ['close'], 'an open Reader withdraws the action from the retained Hub')
  assert.equal(String(pickerProps(h.pane, HUB).message ?? ''), '',
    'a temporarily occupied Reader is NOT reported as a pane that cannot read')

  // …and restored once the close has settled.
  h.pane.key('\u001b')
  await waitUntil('the Reader closed', () => h.pane.closedSurfaceIds().includes(reader))
  await waitUntil('the action came back', () => actions().length === 2)
  assert.deepEqual(actions(), ['close', 'details'], 'the action returns after the close settles')
})

// ── R12/R14: one initial start, stable document identity, no reset ──────────

test('the Reader starts once and a background status update repaints the SAME document identity without a new start', async (t) => {
  const h = await mount(t)
  const handle = h.open([row('job:j1', { label: 'build', status: 'running' })])
  const reader = await enterReader(h)
  assert.deepEqual(readerScrolls(h, reader).map(entry => entry.to), ['start'], 'exactly ONE start scroll')
  assert.deepEqual(surfaceFocusOps(h.pane, reader), ['main'], 'exactly ONE initial focus')

  const idsBefore = surfaceNodes(h.pane, reader).map(node => node.id)
  const closeFramesBefore = h.pane.closeFrames()
  const frameCountBefore = surfaceFrames(h.pane, reader).length
  // A background TaskRuntime commit: the SAME row value, a new truthful status.
  handle.setItems([row('job:j1', { label: 'build', status: 'failed', active: false, detail: 'exit code 2' })])
  await waitUntil('the document repaints the new status', () =>
    readerTexts(h, reader).includes('Job · failed'))

  const idsAfter = surfaceNodes(h.pane, reader).map(node => node.id)
  assert.deepEqual(idsAfter.filter(id => idsBefore.includes(id)), idsBefore,
    'every pre-existing node keeps its keyed identity across the repaint')
  const repaintOps = surfaceFrames(h.pane, reader).slice(frameCountBefore).flatMap(frame => frame.ops)
  assert.equal(repaintOps.some(op => op[0] === 'del'), false,
    'a status repaint deletes no node (no remount, no scroll reset)')
  assert.ok(readerTexts(h, reader).includes('exit code 2'), 'the new detail reached the document')
  assert.deepEqual(readerScrolls(h, reader).map(entry => entry.to), ['start'],
    'a status repaint never asks for a START scroll again')
  assert.deepEqual(surfaceFocusOps(h.pane, reader), ['main'], 'a status repaint never re-issues focus')
  assert.equal(h.pane.closeFrames(), closeFramesBefore, 'the Reader stayed open')
  assert.deepEqual(h.selects, [], 'the repaint is not a business selection')

  // A resize addressed at the CURRENT Reader never resets the reading anchor.
  h.pane.event({ ev: 'resize', sf: reader, cols: 90 })
  await waitUntil('the resized document is committed', () => surfaceFrames(h.pane, reader).length >= 3)
  assert.deepEqual(readerScrolls(h, reader).map(entry => entry.to), ['start'], 'resize never resets the scroll')
})

// ── R15: a disappearing selected row revokes the Reader ─────────────────────

test('a removed selected row retires the Reader and normalizes the Hub selection without opening a successor', async (t) => {
  const h = await mount(t)
  const handle = h.open([row('job:j1', { label: 'first' }), row('job:j2', { label: 'second' })])
  await waitUntil('the first row is selected', () => pickerProps(h.pane, HUB).selected === 'job:j1')
  const reader = await enterReader(h)
  const screensOpened = openedSurfaces(h).filter(entry => entry.mode === 'screen').length

  handle.setItems([row('job:j2', { label: 'second' })])
  await waitUntil('the Reader is retired with the vanished row', () => h.pane.closedSurfaceIds().includes(reader))
  assert.deepEqual(h.pane.closedSurfaceIds(), [reader], 'the vanished target closed its own reading')
  await waitUntil('the Hub keeps its own successor selection', () => pickerProps(h.pane, HUB).selected === 'job:j2')
  assert.equal(pickerProps(h.pane, HUB).selected, 'job:j2', 'the Hub normalized to the surviving row')
  assert.equal(openedSurfaces(h).filter(entry => entry.mode === 'screen').length, screensOpened,
    'NO successor Reader was opened automatically')
})

// ── R16: a modal preempts the Reader and never accepts a hidden answer ──────

test('an official approval preempts the Reader synchronously, refuses hidden answers, then answers once', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  // A controlled delayed close: the Screen stays physically present until the
  // test releases it, which is exactly the visibility window under test.
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  let closeCalls = 0
  const restoreClose = patchOpen(h.session, () => {})
  const screen = h.session.surface(reader)!
  const restoreScreenClose = patchMethod(screen, 'close', () => {
    closeCalls += 1
    return delayed
  })
  t.after(() => { restoreScreenClose(); restoreClose() })

  const outcome = h.renderer.interaction.showApprovalPrompt({ toolName: 'bash', reason: 'needs a shell' }, true)
  // The logical seat is committed, and the Reader has been revoked already.
  assert.equal(closeCalls, 1, 'the modal preemption started EXACTLY ONE close')
  let settled = false
  void outcome.then(() => { settled = true })

  // While the old Screen is still physically present, no answer key may reach
  // the invisible form: y/n/Enter are consumed with no effect. The contract IS
  // a bounded negative-observation window (the held close promise is the only
  // thing that can end it, and an ABSENCE has no positive signal to await), so
  // the wait is deliberate and finite.
  for (const key of ['y', 'n', '\r']) h.pane.key(key)
  await new Promise(resolve => setTimeout(resolve, 120)) // reason: bounded negative-observation window while the close is held
  assert.equal(settled, false, 'no hidden approval answer was accepted')
  assert.equal(closeCalls, 1, 'repeated keys never started a second close')
  assert.equal(h.pane.closeFrames(), 0, 'the delayed close wrote no close frame yet')

  release()
  await waitUntil('the modal layer is really painted after the close', () =>
    surfaceFrames(h.pane, BASE).some(frame => frame.ops.some(op =>
      op[0] === 'add' && /^layer\.modal-\d+$/.test(String(op[1])))))
  h.pane.key('n')
  assert.equal(await outcome, 'rejected', 'the visible form answered exactly once')
  await waitUntil('the same Hub is restored after the modal settles',
    () => pickerNode(h.pane, HUB) !== undefined && pickerProps(h.pane, HUB).selected === 'job:j1')
  assert.deepEqual(h.closes, [], 'the modal never closed the Hub')
  assert.equal(h.pane.closeFrames(), 0, 'the stubbed close wrote no wire frame')
})

// ── R17: a Question taking the seat while the Reader close is pending ──────

test('a Question preempted behind a delayed Reader close aborts with the existing classification and never shows a ghost form', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  // A controlled delayed close keeps the Screen physically present, so the
  // Question's logical seat and the visible surface really disagree.
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  let closeCalls = 0
  const screen = h.session.surface(reader)!
  const restore = patchMethod(screen, 'close', () => { closeCalls += 1; return delayed })
  t.after(restore)

  const abort = new AbortController()
  const answers = h.renderer.interaction.askQuestions(
    [{ id: 'q1', header: 'Pick one', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    abort.signal,
    undefined,
    false,
  ).then(() => 'answered', (error: unknown) => String(error))
  assert.equal(closeCalls, 1, 'the Question seat preempts the Reader with exactly one close')

  // While the Screen is still up no answer key may reach the invisible form,
  // and NO operable Question node may be published to the base layer either:
  // the seat's logical activation already happened, so painting it now would
  // put a form behind the Screen that the client cannot see.
  const modalNodes = (): string[] => surfaceNodes(h.pane, BASE)
    .filter(node => node.id.startsWith('layer.modal-'))
    .map(node => node.id)
  assert.deepEqual(modalNodes(), [],
    'the Question was NOT published while the Reader close is still in flight')
  for (const key of ['1', '\r', 'y', '\u001b[B', '\r']) h.pane.key(key)
  await new Promise(resolve => setTimeout(resolve, 120)) // reason: bounded negative-observation window while the close is held
  assert.equal(closeCalls, 1, 'no key started a second close')
  assert.deepEqual(modalNodes(), [],
    'no Question node appeared on the base layer while the close is in flight')
  let settled = false
  void answers.then(() => { settled = true })
  assert.equal(settled, false, 'no hidden answer settled the Question')

  // The Host withdraws the request while the close is still pending: the
  // promise must take the EXISTING cancellation classification, exactly once,
  // and no ghost form may appear afterwards.
  abort.abort()
  const outcome = await answers
  assert.match(outcome, /aborted|cancelled/iu,
    `the aborted Question takes the flow's own cancellation classification: ${outcome}`)
  assert.equal(closeCalls, 1, 'the abort never started another Screen close')

  release()
  // The stubbed close never writes a wire frame, so the observable settlement is
  // the renderer's OWN restore: the base repaints with the same Hub on top.
  await waitUntil('the delayed close settled and the base seat was restored',
    () => pickerNode(h.pane, HUB) !== undefined
      && surfaceNodes(h.pane, BASE).filter(node => node.id.includes('modal')).length === 0)
  await new Promise(resolve => setTimeout(resolve, 120)) // reason: bounded negative-observation window for "no ghost form appears"
  assert.deepEqual(surfaceNodes(h.pane, BASE).filter(node => node.id.startsWith('layer.modal-')).map(node => node.id), [],
    'the aborted Question published no operable modal node at all')
  assert.ok(pickerNode(h.pane, HUB) !== undefined, 'the same Hub owns the base again')
  assert.deepEqual(h.closes, [], 'the preemption never closed the Hub itself')
})

// ── R21/R22: hydration replaces the subject; a facts clear does not ─────────

test('session hydration retires the Reader before the Hub and drops its stale events', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const back = backNodeId(h, reader)!
  const pickerId = pickerNode(h.pane, HUB)!.id

  h.renderer.display.beginSessionHydration()
  await waitUntil('the Reader close frame reached the wire', () => h.pane.closeFrames() === 1)
  assert.deepEqual(h.pane.closedSurfaceIds(), [reader], 'the Reader was released first')
  assert.ok(h.retires.includes('external'), 'the Hub was retired as well')

  // A late event from the retired Reader/base picker can never act now.
  h.pane.event({ ev: 'action', sf: reader, id: back, act: 'click' })
  h.pane.event({ ev: 'select', sf: BASE, id: pickerId, item: 'job:j1' })
  await waitUntil('the new subject paints no old Hub', () => pickerNode(h.pane, HUB) === undefined)
  assert.equal(h.pane.closeFrames(), 1, 'stale events never start another close')
  assert.deepEqual(h.selects, [], 'the retired hub row never reaches the business router')
})

test('a same-subject facts reset keeps the Reader and its reading anchor', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const framesBefore = surfaceFrames(h.pane, reader).length

  h.renderer.display.resetSessionFacts()
  await waitUntil('the base repaint was committed', () => surfaceFrames(h.pane, BASE).length > 0)
  assert.equal(h.pane.closeFrames(), 0, 'a facts clear is not an ownership change')
  assert.equal(h.readerId(), reader, 'the same Reader is still current')
  assert.deepEqual(readerScrolls(h, reader).map(entry => entry.to), ['start'], 'the reading anchor survives')
  assert.ok(surfaceFrames(h.pane, reader).length >= framesBefore)
})

// ── R19: another Presenter wins the seat ────────────────────────────────────

test('another Presenter replaces the Reader and the Hub, and closing it never restores the old Hub', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const browser = h.renderer.sessionBrowserPresentation
  assert.ok(browser, 'the pane advertises the Session Browser kinds')
  let browserCloses = 0
  const handle = browser.open({
    subject: { currentSessionId: 'session-current', currentCwd: '/workspace/project', isCurrent: () => true },
    onQueryChange: () => {},
    onResumeIntent: () => {},
    onClose: () => { browserCloses += 1 },
  })
  await waitUntil('the Reader is retired by the sibling open', () => h.pane.closedSurfaceIds().includes(reader))
  assert.deepEqual(h.retires, ['external'], 'the Hub was retired exactly once')
  await waitUntil('the Session Browser owns the base layer',
    () => surfaceNodes(h.pane, BASE).some(node => String(node.p.key ?? '').startsWith('session-browser-')))
  assert.equal(openedSurfaces(h).filter(entry => entry.mode === 'screen').length, 1,
    'no second screen was opened for the replacement (no ghost)')
  h.pane.key('\u001b')
  await waitUntil('Esc closes the Session Browser', () => browserCloses === 1)
  await waitUntil('the base returns to the composer', () => surfaceFocusOps(h.pane, BASE).at(-1) === 'dock.composer')
  await waitUntil('the retired Hub never reappears', () => pickerNode(h.pane, HUB) === undefined)
  assert.equal(pickerNode(h.pane, HUB), undefined, 'the old Hub is not revived by any close tail')
  handle.close()
})

// ── R23: acquisition and render failures are fatal, never silent ────────────

test('a screen acquisition failure is fatal once, opens nothing and keeps the base input owned', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const failure = new Error('screen acquisition refused')
  const restore = patchMethod(h.session, 'open', function (this: Session, openOptions?: OpenOptions) {
    if (openOptions?.mode === 'screen') throw failure
    return Object.getPrototypeOf(h.session).open.call(this, openOptions) as Surface
  })
  t.after(restore)
  h.pane.key('\r')
  await waitUntil('the fatal lifecycle observed the acquisition failure', () => h.fatals.length === 1)
  assert.equal(h.fatals[0], failure, 'the ORIGINAL error reaches the fatal route')
  assert.equal(openedSurfaces(h).filter(entry => entry.mode === 'screen').length, 0,
    'no Screen was fabricated and no fallback overlay was opened')
  assert.equal(h.pane.closeFrames(), 0, 'there is no nonexistent resource to close')
  // The base input stays owned: Esc still closes the Hub exactly once.
  restore()
  h.pane.key('\u001b')
  await waitUntil('the base still owns its input', () => h.closes.length === 1)
})

test('a screen render failure retires the acquired resource, closes it once and routes the SAME error', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const failure = new Error('the screen frame was refused')
  let screenId: string | undefined
  let renderCalls = 0
  const restores: Array<() => void> = []
  restores.push(patchOpen(h.session, (surface, openOptions) => {
    if (openOptions.mode !== 'screen') return
    screenId = surface.id
    restores.push(patchMethod(surface, 'render', () => {
      renderCalls += 1
      if (renderCalls === 1) throw failure
      Object.getPrototypeOf(surface).render.call(surface, { main: null })
    }))
  }))
  t.after(() => { for (const restore of restores.reverse()) restore() })

  h.pane.key('\r')
  await waitUntil('the fatal lifecycle observed the render failure', () => h.fatals.length === 1)
  assert.equal(h.fatals[0], failure, 'the ORIGINAL render error is forwarded, not a close error')
  assert.ok(screenId !== undefined)
  await waitUntil('the failed Reader was released exactly once', () => h.pane.closedSurfaceIds().includes(screenId!))
  assert.deepEqual(h.pane.closedSurfaceIds(), [screenId], 'one close attempt for the acquired Screen')
  // No Reader input leaked: Esc now belongs to the visible Hub again.
  h.pane.key('\u001b')
  await waitUntil('the Hub still receives keys after the fatal', () => h.closes.length === 1)
})

// ── R24: a delayed or rejected close is owned, never retried ────────────────

test('a delayed close forbids a duplicate close and a re-open, and restores the base seat afterwards', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  let closeCalls = 0
  const screen = h.session.surface(reader)!
  const restore = patchMethod(screen, 'close', () => { closeCalls += 1; return delayed })
  t.after(restore)

  h.pane.key('\u001b')
  await waitUntil('the Reader close started', () => closeCalls === 1)
  // Rapid Esc / Enter / Back while the close is pending: ONE close, no new open.
  h.pane.key('\u001b')
  h.pane.key('\u001b')
  h.pane.key('\r')
  await new Promise(resolve => setTimeout(resolve, 120)) // reason: bounded negative-observation window (the absence of a second close/open has no positive signal)
  assert.equal(closeCalls, 1, 'a pending close is never started twice')
  assert.equal(openedSurfaces(h).filter(entry => entry.mode === 'screen').length, 1,
    'no new Reader may be acquired while a close is pending')
  assert.equal(surfaceNodes(h.pane, BASE).length > 0, true, 'the base frame is still owned')

  release()
  await waitUntil('the base seat is restored after the close settles',
    () => surfaceFocusOps(h.pane, BASE).at(-1) === pickerNode(h.pane, HUB)?.id)
  assert.equal(pickerNode(h.pane, HUB)?.id !== undefined, true, 'the same Hub owns the caret again')
})

test('a rejected close is fatal once, reports no success, and teardown still releases base and session', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const failure = new Error('the close frame was refused')
  const screen = h.session.surface(reader)!
  let screenCloseCalls = 0
  const restore = patchMethod(screen, 'close', () => {
    screenCloseCalls += 1
    // The first attempt is the failing one under test; the SDK's own teardown
    // iteration must not become a foreign unhandled rejection.
    return screenCloseCalls === 1 ? Promise.reject(failure) : Promise.resolve()
  })
  t.after(restore)

  h.pane.key('\u001b')
  await waitUntil('the fatal lifecycle observed the close failure', () => h.fatals.length === 1)
  assert.equal(h.fatals[0], failure, 'the EXACT close rejection is routed once')
  assert.equal(screenCloseCalls, 1, 'the renderer never retried the close')
  // The rejection is not converted into an info notice or a fake success.
  assert.equal(readerTexts(h, reader).some(text => text.includes('closed')), false)

  let baseCloses = 0
  let sessionCloses = 0
  const base = h.session.surface(BASE)!
  const restores = [
    patchMethod(base, 'close', function () { baseCloses += 1; return Object.getPrototypeOf(base).close.call(base, { keep: false }) }),
    patchMethod(h.session, 'close', function () { sessionCloses += 1; return Object.getPrototypeOf(h.session).close.call(h.session) }),
  ]
  t.after(() => { for (const item of restores.reverse()) item() })
  const disposal = await h.dispose().then(() => undefined, (error: unknown) => error)
  assert.equal(disposal, failure, 'the failure-bearing close promise stays the disposal failure')
  assert.equal(baseCloses, 1, 'teardown still attempted the base surface release')
  assert.equal(sessionCloses, 1, 'teardown still attempted the session release')
})

// ── R25/R26: independent release attempts and ONE shared disposal promise ───

test('a THROWING synchronous disposer never skips the base and Session release, and still shares one promise', async (t) => {
  const h = await mount(t)
  // The CURRENT panel's owner callback is a reentrant cleanup sink; `retire()`
  // invokes it synchronously, so a throwing sink defects a synchronous disposal
  // step. This is the failure path a real failing onRetired cleanup produces.
  const retireError = new Error('owner retirement cleanup refused')
  h.open([row('job:j1')], { onRetired: () => { throw retireError } })
  await waitUntil('the Hub is mounted', () => pickerNode(h.pane, HUB) !== undefined)

  let baseCloses = 0
  let sessionCloses = 0
  const base = h.session.surface(BASE)!
  const restores = [
    patchMethod(base, 'close', function (this: Surface) { baseCloses += 1; return Object.getPrototypeOf(base).close.call(base, { keep: false }) }),
    patchMethod(h.session, 'close', function (this: Session) { sessionCloses += 1; return Object.getPrototypeOf(h.session).close.call(h.session) }),
  ]
  t.after(() => { for (const item of restores.reverse()) item() })

  const first = h.renderer.dispose()
  const second = h.renderer.dispose()
  assert.equal(first, second, 'a throwing synchronous disposer still shares ONE disposal promise')
  const failure = await first.then(() => undefined, (error: unknown) => error)
  assert.equal(failure, retireError, 'the throwing step\'s original value is reported, not swallowed')
  assert.equal(baseCloses, 1, 'the base surface was still released despite the throwing step')
  assert.equal(sessionCloses, 1, 'the SDK Session was still released despite the throwing step')
  await h.dispose().catch(() => {})
})

test('a SYNCHRONOUSLY REENTRANT dispose from a retirement callback shares the ONE latched promise', async (t) => {
  const h = await mount(t)
  // The real reentrancy hazard: a retirement cleanup runs INSIDE the first
  // dispose, before any await, and calls `dispose()` again. If the shared
  // promise were not latched before the cleanup, this inner call would start a
  // second teardown and return a different promise.
  const nested: Promise<void>[] = []
  h.open([row('job:j1')], {
    onRetired: () => { nested.push(h.renderer.dispose()) },
  })
  await waitUntil('the Hub is mounted', () => pickerNode(h.pane, HUB) !== undefined)

  let baseCloses = 0
  let sessionCloses = 0
  const base = h.session.surface(BASE)!
  const restores = [
    patchMethod(base, 'close', function (this: Surface) { baseCloses += 1; return Object.getPrototypeOf(base).close.call(base, { keep: false }) }),
    patchMethod(h.session, 'close', function (this: Session) { sessionCloses += 1; return Object.getPrototypeOf(h.session).close.call(h.session) }),
  ]
  t.after(() => { for (const item of restores.reverse()) item() })

  const outer = h.renderer.dispose()
  assert.equal(nested.length, 1, 'the retirement cleanup really reentered dispose() synchronously')
  assert.equal(nested[0], outer,
    'the synchronously reentrant call received the SAME promise, not a second teardown')
  assert.equal(h.renderer.dispose(), outer, 'and so is any later call')
  await outer.then(() => undefined, () => undefined)
  assert.equal(baseCloses, 1, 'the base surface was released exactly once')
  assert.equal(sessionCloses, 1, 'the SDK Session was released exactly once')
})

test('a triple release failure attempts Screen, base and Session in order and aggregates the originals', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const reader = await enterReader(h)
  const screenError = new Error('screen release refused')
  const baseError = new Error('base release refused')
  const sessionError = new Error('session release refused')
  const base = h.session.surface(BASE)!
  let baseCloses = 0
  let sessionCloses = 0
  const restores = [
    patchMethod(base, 'close', () => { baseCloses += 1; return Promise.reject(baseError) }),
    patchMethod(h.session, 'close', () => { sessionCloses += 1; return Promise.reject(sessionError) }),
  ]
  t.after(() => { for (const item of restores.reverse()) item() })
  // The REAL SDK close path fails while writing the Screen's close frame.
  h.pane.failCloseWrite(screenError)
  let screenCloses = 0
  const screen = h.session.surface(reader)!
  restores.push(patchMethod(screen, 'close', function () {
    screenCloses += 1
    return Object.getPrototypeOf(screen).close.call(screen, { keep: false })
  }))

  const first = h.renderer.dispose()
  const second = h.renderer.dispose()
  assert.equal(first, second, 'concurrent disposal calls share ONE promise (identity)')
  const error = await first.then(() => undefined, (value: unknown) => value)
  assert.ok(error instanceof AggregateError, 'multiple failures aggregate instead of being dropped')
  assert.deepEqual((error as AggregateError).errors, [screenError, baseError, sessionError],
    'every original failure is preserved in resource release order')
  assert.equal(baseCloses, 1, 'the base release was attempted once')
  assert.equal(sessionCloses, 1, 'the session release was attempted once')
  assert.equal(screenCloses, 1, 'the Screen release was attempted exactly once')
  assert.equal(h.pane.closeFrames(), 0, 'the failed close write recorded no close frame')
  await h.dispose().catch(() => {})
})

test('disposing without a Reader keeps the established single-close teardown', async (t) => {
  const h = await mount(t)
  await openHub(h, [row('job:j1')])
  const framesBefore = h.pane.closeFrames()
  await h.dispose()
  assert.equal(h.pane.closeFrames(), framesBefore + 1, 'exactly ONE base close frame was written')
  assert.deepEqual(h.pane.closedSurfaceIds(), [BASE], 'only the resident base surface closed')
})

// ── R27/G3: capability truth ────────────────────────────────────────────────

test('a pane without the negotiated scroll feature opens no Screen and states the truth', async (t) => {
  // `row`/`text` are present but the official `scroll` feature is not, so the
  // reading keys could not work: the action is not offered at all.
  const h = await mount(t, {
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'picker', 'overlay', 'row', 'text'],
    features: ['flow', 'styles'],
  })
  await openHub(h, [row('job:j1')])
  const actions = (pickerProps(h.pane, HUB).actions ?? []) as Array<Record<string, unknown>>
  assert.deepEqual(actions.map(action => action.id), ['close'], 'no unreadable Reader action is offered')
  assert.equal(String(pickerProps(h.pane, HUB).message), 'Work details unavailable in this pane.')
  h.pane.key('\r')
  await new Promise(resolve => setTimeout(resolve, 150)) // reason: bounded negative-observation window for "no Screen was opened"
  assert.deepEqual(h.fatals, [], 'a missing capability is not a fatal')
  assert.equal(h.renderer.display.supportsTaskCenter, false, 'the Task Center capability never flips')
  assert.equal(h.renderer.display.supportsViewer, false, 'the Viewer capability never flips')
})

test('the production seam declares the Task Center only with the negotiated kinds and no Viewer', async (t) => {
  const h = await mount(t)
  // B3-A3: this pane negotiated `picker` plus the Reader's `col`/`row`/`text`
  // and `scroll`, so the display seam truthfully reports the Task Center. The
  // missing-capability negative is the test ABOVE (no `scroll` ⇒ false).
  assert.equal(h.renderer.display.supportsTaskCenter, true,
    'a fully negotiated pane declares the production Task Center')
  assert.equal(h.renderer.display.supportsViewer, false, 'A2/A3 add no Agent Viewer')
  // The Reader is reachable ONLY through the internal presentation port, so
  // without an open Hub there is no local Read entry at all.
  h.pane.key('q')
  await new Promise(resolve => setTimeout(resolve, 120)) // reason: bounded negative-observation window for "no Reader outside a Hub"
  assert.equal(openedSurfaces(h).filter(entry => entry.mode === 'screen').length, 0,
    'no Reader can be opened outside a current Work Hub row')
  assert.ok(pickerNode(h.pane, HUB) === undefined)
})

// A tracked type reference so the unused-import guard stays honest for the
// question shape the seat exposes (no Question case is mounted here: the modal
// preemption proves the seat hook, and the Question form itself is covered by
// the interaction suite).
export type ReaderLifecycleQuestion = TuiQuestion
