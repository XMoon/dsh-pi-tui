/**
 * B3-A2: the Reader's reading keys, scroll authority and input swallowing.
 *
 * Every key here travels as REAL tty bytes through the SDK's ONE input loop, and
 * every scroll observation is the SDK's own `scroll` op on the wire (a
 * renderer-local call is not a client viewport). The temporary Screen is the
 * production one acquired by `mountTspRenderer`; nothing is hand-mounted.
 *
 * The headless wire proves WHICH operation and WHICH region each key addresses.
 * The client's actual viewport movement and the mid-scroll resize anchor are
 * real-Tern evidence and are recorded in the PR (see the Tern headless lane);
 * this suite deliberately claims no client geometry.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-work-reader-scroll.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskBrowserPresentationOpen,
} from '../../src/app/surface/task-presentation-port.ts'
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
} from '../support/tsp-picker-wire.ts'

const HUB = 'work-hub-'
const BASE = 's1'

interface ScrollHarness {
  readonly pane: TspPane
  renderer: TspRenderer
  readonly selects: string[]
  readonly cancels: number[]
  readonly exits: number[]
  readonly submits: string[]
  readonly steers: string[]
  readonly closes: number[]
  readonly continuedOpens: number[]
  open(items: readonly TaskPanelItem[], overrides?: Partial<TaskBrowserPresentationOpen>): TaskBrowserPresentationHandle
  readerId(): string | undefined
  dispose(): Promise<void>
}

function row(value: string, overrides: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return { value, label: value, status: 'running', source: 'job', type: 'bash', active: true, ...overrides }
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

/**
 * A document long enough that a real client MUST scroll: a wrapped CJK label,
 * a hostile long stable id and a multi-paragraph detail. The fixture is the
 * content source; the client's own overflow behaviour is what the real Tern
 * lane measures.
 */
const LONG_LABEL = `构建且校验发布工件 ${'长标题段落 '.repeat(40)}`
const LONG_ID = `job:${'a-very-long-stable-identity-'.repeat(12)}end`
const LONG_DETAIL = `${'The detail body streams the run facts.\n'.repeat(60)}END-OF-DETAILS`

async function mount(t: { after(fn: () => unknown): void }): Promise<ScrollHarness> {
  const pane = installTspPane({ sessionBrowser: true, workDetails: true })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  let disposed = false
  t.after(() => { if (!disposed) pane.restore() })
  const fatals: unknown[] = []
  const harness: ScrollHarness = {
    pane,
    renderer: undefined as unknown as TspRenderer,
    selects: [],
    cancels: [],
    exits: [],
    submits: [],
    steers: [],
    closes: [],
    continuedOpens: [],
    open(items, overrides = {}) {
      return harness.renderer.taskPresentation.openBrowser(
        items,
        (value) => { harness.selects.push(value); return 'close' },
        () => { harness.closes.push(1) },
        options({ onRetired: () => {}, ...overrides }),
      )
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
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit: () => { harness.exits.push(1) },
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => { void harness.renderer.dispose().catch(() => {}) })
  renderer.bindInput({
    exit: () => { harness.exits.push(1) },
    cancel: () => { harness.cancels.push(1) },
    submit: text => { harness.submits.push(text) },
    steer: text => { harness.steers.push(text) },
    pasteMedia: () => {},
    noteUserInput() {},
    listContinuedQuestions: () => {
      harness.continuedOpens.push(1)
      return []
    },
    reopenContinuedQuestion: () => false,
  })
  harness.renderer = renderer
  return harness
}

/** Open the Hub on the overflowing document and enter the Reader. */
async function enterLongReader(h: ScrollHarness): Promise<string> {
  h.open([row(LONG_ID, { label: LONG_LABEL, detail: LONG_DETAIL, startedAt: 1_700_000_000_000 })])
  await waitUntil('the Hub is mounted', () => pickerNode(h.pane, HUB) !== undefined)
  h.pane.key('\r')
  await waitUntil('the Reader document is mounted', () => {
    const id = h.readerId()
    return id !== undefined && surfaceNodes(h.pane, id).length > 0
  })
  return h.readerId()!
}

/** The `scroll` targets of one surface, in order. */
const scrollTargets = (h: ScrollHarness, sf: string): string[] => surfaceScrollOps(h.pane, sf).map(entry => entry.to)

/** Wait for one more scroll op on the Reader and return its direction. */
async function nextScroll(h: ScrollHarness, reader: string, count: number): Promise<string> {
  await waitUntil('the scroll op reaches the wire', () => surfaceScrollOps(h.pane, reader).length > count)
  return surfaceScrollOps(h.pane, reader).at(-1)!.to
}

// ── R11/R13: the six reading keys address the ONE main region ───────────────

test('PageDown/PageUp/Up/Down/Home/End each send the exact native scroll on the Reader main region', async (t) => {
  const h = await mount(t)
  const reader = await enterLongReader(h)
  const initial = scrollTargets(h, reader)
  assert.deepEqual(initial, ['start'], 'the reading starts at the document top')

  const cases: Array<{ readonly bytes: string; readonly expected: string }> = [
    { bytes: '\u001b[6~', expected: 'page-down' },
    { bytes: '\u001b[5~', expected: 'page-up' },
    { bytes: '\u001b[B', expected: 'line-down' },
    { bytes: '\u001b[A', expected: 'line-up' },
    { bytes: '\u001b[H', expected: 'start' },
    { bytes: '\u001b[F', expected: 'end' },
  ]
  let count = surfaceScrollOps(h.pane, reader).length
  for (const entry of cases) {
    h.pane.key(entry.bytes)
    const step = await nextScroll(h, reader, count)
    assert.equal(step, entry.expected, `${JSON.stringify(entry.bytes)} maps to ${entry.expected}`)
    count += 1
  }
  const ops = surfaceScrollOps(h.pane, reader)
  assert.equal(ops.length, cases.length + 1, 'exactly one scroll op per gesture, none invented')
  assert.ok(ops.every(op => op.id === 'main'),
    `every scroll addresses the document's own main region: ${JSON.stringify(ops)}`)
  assert.deepEqual(h.selects, [], 'no reading key runs the business row router')
  assert.deepEqual(h.cancels, [], 'no reading key cancels the main Agent')
  assert.deepEqual(h.closes, [], 'no reading key closes the Hub')
})

test('a resize while the reading is mid-scroll keeps the document identity and never resets the anchor', async (t) => {
  const h = await mount(t)
  const handle = h.open([
    row(LONG_ID, { label: LONG_LABEL, detail: LONG_DETAIL, startedAt: 1_700_000_000_000, status: 'running' }),
  ])
  await waitUntil('the Hub is mounted', () => pickerNode(h.pane, HUB) !== undefined)
  h.pane.key('\r')
  await waitUntil('the Reader document is mounted', () => {
    const id = h.readerId()
    return id !== undefined && surfaceNodes(h.pane, id).length > 0
  })
  const reader = h.readerId()!
  // Scroll away from the top through the REAL reading key.
  let count = surfaceScrollOps(h.pane, reader).length
  h.pane.key('\u001b[6~')
  await nextScroll(h, reader, count)
  count += 1
  h.pane.key('\u001b[6~')
  await nextScroll(h, reader, count)
  assert.deepEqual(scrollTargets(h, reader), ['start', 'page-down', 'page-down'])

  const idsBefore = surfaceNodes(h.pane, reader).map(node => node.id)
  const focusBefore = surfaceFocusOps(h.pane, reader)
  const framesBefore = surfaceFrames(h.pane, reader).length
  const closeFramesBefore = h.pane.closeFrames()

  // A resize addressed at the CURRENT Screen is the Screen's own geometry
  // event: it re-renders the SAME keyed tree and asks for no scroll/focus.
  for (const cols of [90, 72, 120]) h.pane.event({ ev: 'resize', sf: reader, cols })
  // A background commit makes the resulting frame observable (a pure resize
  // may diff to no ops, which is the SDK's own no-op).
  handle.setItems([row(LONG_ID, { label: LONG_LABEL, detail: LONG_DETAIL, startedAt: 1_700_000_000_000, status: 'failed', active: false })])
  await waitUntil('the post-resize document is committed', () =>
    surfaceFrames(h.pane, reader).length > framesBefore && surfaceTexts(h.pane, reader).includes('Job · failed'))

  assert.deepEqual(scrollTargets(h, reader), ['start', 'page-down', 'page-down'],
    'a mid-read resize asks for NO further scroll (no reset, no start)')
  assert.deepEqual(surfaceFocusOps(h.pane, reader), focusBefore, 'a resize never re-issues focus')
  const postResizeOps = surfaceFrames(h.pane, reader).slice(framesBefore).flatMap(frame => frame.ops)
  assert.equal(postResizeOps.some(op => op[0] === 'del' && op[1] === 'main'), false,
    'the document region is never unmounted by a resize')
  const idsAfter = surfaceNodes(h.pane, reader).map(node => node.id)
  assert.deepEqual(idsAfter.filter(id => idsBefore.includes(id)), idsBefore,
    'the client keeps the SAME scroll container identity across the resize')
  assert.ok(surfaceTexts(h.pane, reader).includes(LONG_LABEL), 'the document content is unchanged')
  assert.ok(surfaceTexts(h.pane, reader).includes(LONG_DETAIL), 'the long detail survives the resize')
  assert.equal(h.pane.closeFrames(), closeFramesBefore, 'a resize never closes the Reader')
  assert.deepEqual(h.cancels, [], 'a resize is never a cancel intent')
})

// ── R18: every other key is consumed as Reader input ────────────────────────

test('letters, Enter, Ctrl+D, Ctrl+C, Alt+Q and a paste never reach the composer, Agent or continuation list', async (t) => {
  const h = await mount(t)
  const reader = await enterLongReader(h)
  const scrollsBefore = surfaceScrollOps(h.pane, reader).length
  const closeFramesBefore = h.pane.closeFrames()

  for (const bytes of [
    'a',
    '\r',
    '\u0004',
    '\u0003',
    '\u001bq',
    '\u001b[200~pasted text\u001b[201~',
    'q',
    ' ',
    '\u007f',
  ]) {
    h.pane.key(bytes)
  }
  // The subject is that these keys have NO effect at all, so this is a bounded
  // negative-observation window rather than a wait for a positive signal.
  await new Promise(resolve => setTimeout(resolve, 200)) // reason: bounded negative-observation window for the swallowed-key contract

  assert.deepEqual(h.submits, [], 'no Reader key submits the composer text')
  assert.deepEqual(h.steers, [], 'no Reader key steers the Agent')
  assert.deepEqual(h.cancels, [], 'no Reader key cancels the main Agent')
  assert.deepEqual(h.exits, [], 'no Reader key exits the renderer')
  assert.deepEqual(h.continuedOpens, [], 'Alt+Q never opens the transient continuation list from a Reader')
  assert.equal(scrollTargets(h, reader).length, scrollsBefore, 'plain Reader input never scrolls')
  assert.equal(h.pane.closeFrames(), closeFramesBefore, 'no consumed key closed the Reader')
  assert.equal(h.renderer.composer.getDraft(), '', 'the composer draft is never mutated by the Reader')
  assert.equal(h.readerId(), reader, 'the Reader is still the visible page')
})

test('the Reader Esc leaves the document for the same Hub without cancelling the Agent', async (t) => {
  const h = await mount(t)
  const reader = await enterLongReader(h)
  const backBefore = surfaceScrollOps(h.pane, reader).length
  h.pane.key('\u001b')
  await waitUntil('the Reader was retired', () => h.pane.closedSurfaceIds().includes(reader))
  assert.deepEqual(h.cancels, [], 'the Reader Esc is nav, not the Agent cancel')
  assert.equal(h.pane.closeFrames(), 1, 'exactly one Screen close')
  assert.equal(scrollTargets(h, reader).length, backBefore, 'leaving sends no extra scroll')
  await waitUntil('the same Hub owns the layer again', () => pickerNode(h.pane, HUB) !== undefined)
  assert.equal(pickerProps(h.pane, HUB).selected, LONG_ID, 'the same row is still selected')
})

// ── a genuinely overflowing document ───────────────────────────────────────

test('the delivered document is long enough that the reading keys are meaningful', async (t) => {
  const h = await mount(t)
  const reader = await enterLongReader(h)
  const content = surfaceTexts(h.pane, reader)
  assert.ok(content.includes(LONG_LABEL), 'the label line is delivered whole (client-wrapped)')
  assert.ok(content.includes(LONG_DETAIL), 'the detail body is delivered whole')
  // The document's own text volume (not a client geometry claim) is what makes
  // the paging meaningful: a client that renders it in its viewport must
  // overflow at the tested pane heights.
  const body = content.join('\n')
  assert.ok(body.split('\n').length >= 8, `the document carries a real multi-line body: ${body.split('\n').length} lines`)
  assert.ok(body.length > 2_000, `the document carries a long body: ${body.length} chars`)
  const labelNode = surfaceNodes(h.pane, reader).find(node => node.id.endsWith('.work-label'))
  assert.equal(labelNode?.p.wrap, 'word', 'the label is word-wrapped by the client, never pre-truncated')
  assert.ok(surfaceTexts(h.pane, reader).some(text => text.startsWith('Stable ID ')), 'the identity line is present')
  assert.ok(!JSON.stringify(surfaceNodes(h.pane, reader)).includes('UFdORUQ='), 'no hostile payload is fabricated here')
  assert.deepEqual(h.selects, [], 'building the document reads no business row')
})
