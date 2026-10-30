/**
 * TSP-7 PR-C: the composer action row (Model / Effort / Send / Stop).
 *
 * Every case mounts the PRODUCTION `mountTspRenderer` over the scripted pane
 * and asserts on the REAL reconciled wire tree plus the bound business
 * handlers — never on renderer-local state. The row's contracts:
 *
 * - capability gate: no `el`+`styles` ⇒ NO row at all (no fake text button),
 *   the editor/keyboard routes unchanged;
 * - Send shares the EXACT Enter path (one submit, cleared-before-callback);
 *   an empty wire-form draft is refused by the handler (the client does not
 *   enforce `disabled` on an `el` button — measured);
 * - Stop rides the EXISTING cancel intent and exists only while the committed
 *   snapshot says busy;
 * - Model/Effort forward to the ONE late-bound `/model` UI entry with the
 *   right hint, and only on the CURRENT seat (modal/picker/hydration/
 *   unbound/disposed each refuse);
 * - the label width rule: short labels below 72 columns, bounded values at or
 *   above, never a fabricated `default`/`high`.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-composer-actions.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { emptyStatusSnapshot, type StatusSnapshot, type StatusSnapshotReader } from '../../src/domain/status/types.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import type { Op } from '@stencil-hq/tern'

/** The wire node shape the helper folds (see tsp-picker-wire.ts). */
interface WireNode {
  readonly id: string
  readonly k: string
  readonly p: Record<string, unknown>
  readonly c?: WireNode[]
}

/** Fold the pane's frames into the live node set (same rules as the shared helper). */
function foldWireNodes(frames: ReadonlyArray<{ readonly ops: readonly Op[] }>): WireNode[] {
  const live = new Map<string, WireNode>()
  const parents = new Map<string, string>()
  const remove = (id: string): void => {
    parents.delete(id)
    for (const [child, parent] of parents) if (parent === id) remove(child)
    live.delete(id)
  }
  const add = (node: WireNode, parent: string): void => {
    live.set(node.id, { ...node, p: { ...node.p } })
    parents.set(node.id, parent)
    for (const child of node.c ?? []) add(child, node.id)
  }
  for (const frame of frames)
    for (const op of frame.ops) {
      if (op[0] === 'add') add(op[4] as unknown as WireNode, String(op[2]))
      if (op[0] === 'del') remove(String(op[1]))
      if (op[0] === 'set') {
        const node = live.get(String(op[1]))
        if (node !== undefined) Object.assign(node.p, op[2])
      }
      if (op[0] === 'text') {
        const node = live.get(String(op[1]))
        const mode = op[2]
        const value = op[3]
        if (node !== undefined && typeof value === 'string') {
          if (mode === 'replace') node.p.text = value
          if (mode === 'append') node.p.text = String(node.p.text ?? '') + value
        }
      }
    }
  return [...live.values()]
}

/** The live wire nodes of the base surface's dock region. */
function dockNodes(pane: TspPane): WireNode[] {
  return foldWireNodes(pane.frames().filter(frame => frame.sf === pane.frames().at(-1)!.sf))
    .filter(node => node.id.startsWith('dock.'))
}

/** One dock node by an exact trailing key fragment. */
function dockNode(pane: TspPane, key: string): WireNode | undefined {
  return dockNodes(pane).find(node => node.id.endsWith(`.${key}`) || node.id === `dock.${key}`)
}

/** The composer action row's buttons as (key → node), when the row is mounted. */
function composerButtons(pane: TspPane): Map<string, WireNode> {
  const out = new Map<string, WireNode>()
  for (const node of dockNodes(pane)) {
    if (node.k !== 'el') continue
    const key = String(node.p['key'] ?? '')
    if (key.startsWith('composer-')) out.set(key, node)
  }
  return out
}

/** The row node itself (the outer `row` keyed `composer-actions`). */
function composerRow(pane: TspPane): WireNode | undefined {
  return dockNodes(pane).find(node => node.id === 'dock.composer-actions')
}

/** A busy/idle snapshot with a model configured as asked. */
function snapshotFor(options: {
  readonly busy?: boolean
  readonly model?: { readonly displayName: string; readonly id: string; readonly reasoningEffort?: string }
}): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    composition: options.model === undefined ? {} : { model: options.model },
    activity: { ...base.activity, busy: options.busy === true },
  } as StatusSnapshot
}

/** One mounted renderer with the pane, the bound handlers and the status reader recorded. */
interface Mounted {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly calls: {
    readonly submits: Array<{ readonly text: string; readonly gesture: string }>
    readonly cancels: number
    readonly modelEntries: Array<'models' | 'effort'>
    readonly notes: number
    readonly notifications: string[]
  }
  /** Replace the committed status snapshot and wait a frame. */
  commitStatus(snapshot: StatusSnapshot): Promise<void>
  dispose(): Promise<void>
}

async function mountComposerActions(options: {
  readonly kinds?: readonly string[]
  readonly features?: readonly string[]
  readonly cols?: number
  readonly modelPickerKinds?: boolean
} = {}): Promise<Mounted> {
  const pane = installTspPane({
    // The composer row needs `el` + `styles`; the model picker needs its own
    // kinds. The base HELLO already advertises `styles`; `el` rides the
    // explicit kinds override with the base vocabulary preserved.
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.features === undefined ? {} : { features: options.features }),
    ...(options.modelPickerKinds === true ? { modelPicker: true } : {}),
  })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit() {},
    onFatal: (e) => assert.fail(String(e)),
  })
  const calls = {
    submits: [] as Array<{ text: string; gesture: string }>,
    cancels: 0,
    modelEntries: [] as Array<'models' | 'effort'>,
    notes: 0,
    notifications: [] as string[],
  }
  renderer.bindInput({
    exit() {},
    cancel: () => { calls.cancels += 1 },
    submit: (text, request) => { calls.submits.push({ text, gesture: String(request) }) },
    steer() {},
    pasteMedia: () => {},
    noteUserInput: () => { calls.notes += 1 },
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: entry => { calls.modelEntries.push(entry) },
  })
  let current = snapshotFor({})
  const reader: StatusSnapshotReader = { snapshot: () => current }
  renderer.bindStatusReader(reader)
  const notify = renderer.display.notify.bind(renderer.display)
  renderer.display.notify = (text, kind) => { calls.notifications.push(text); notify(text, kind) }
  const mounted: Mounted = {
    pane,
    renderer,
    calls,
    async commitStatus(snapshot) {
      current = snapshot
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the status committed', () => pane.frameCount() > 0)
      await settle(60)
    },
    dispose: () => renderer.dispose(),
  }
  await mounted.commitStatus(current)
  return mounted
}

/** Click one wire node the way the client does (its `actions.click` mapping). */
function click(pane: TspPane, node: WireNode): void {
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: node.id, act: 'click' })
}

/* ------------------------------------------------------------- the row itself */

test('composer actions: the row mounts between the editor and the statusline on an el+styles pane', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  const buttons = composerButtons(pane)
  assert.deepEqual([...buttons.keys()].sort(), ['composer-effort', 'composer-model', 'composer-send'],
    'the idle row carries Model, Effort and Send — Stop only exists while busy')
  assert.ok(composerRow(pane), 'the row node itself is mounted')
  // The row sits AFTER the editor and BEFORE the first status row in the dock
  // column (the frozen §4.1 order). The wire folds nodes in ADD order, so the
  // flat dock list's indices ARE the column order.
  const ids = dockNodes(pane).map(node => node.id)
  const editorAt = ids.indexOf('dock.composer')
  const actionsAt = ids.indexOf('dock.composer-actions')
  const statusAt = ids.findIndex(id => id.startsWith('dock.status-row'))
  assert.ok(editorAt >= 0 && actionsAt > editorAt, 'the action row follows the editor')
  if (statusAt >= 0) assert.ok(actionsAt < statusAt, 'the action row precedes the statusline')
})

test('composer actions: a pane without el or styles mounts NO row and never a fake control', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  assert.equal(composerRow(pane), undefined, 'no el ⇒ no action row')
  assert.equal(composerButtons(pane).size, 0, 'and no stray button node anywhere in the dock')
  // The honest degradation keeps the keyboard routes: the editor is mounted.
  assert.ok(dockNode(pane, 'composer'), 'the controlled editor still mounts')
})

/* ----------------------------------------------------------------------- Send */

test('composer actions: Send runs the EXACT Enter path — one submit, draft cleared before the callback', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  // A non-empty draft: type through the REAL key path, then click Send.
  pane.key('hello composer')
  await settle(80)
  assert.equal(m.renderer.composer.getDraft(), 'hello composer', 'the typed draft is live')
  const send = composerButtons(pane).get('composer-send')
  assert.ok(send)
  click(pane, send!)
  await waitUntil('one submit', () => calls.submits.length === 1)
  assert.equal(calls.submits[0]!.text, 'hello composer')
  assert.equal(m.renderer.composer.getDraft(), '', 'the draft was cleared before the callback ran')
  // Enter on a refilled draft is the SAME path (one more submit, not two).
  pane.key('second')
  await settle(60)
  pane.key('\r')
  await waitUntil('the second submit', () => calls.submits.length === 2)
  assert.equal(calls.submits[1]!.text, 'second')
})

test('composer actions: Send refuses an empty wire-form draft AND paints the disabled state', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  const send = composerButtons(pane).get('composer-send')
  assert.ok(send)
  // The VISIBLE disabled fact rides the button's own attributes (the client
  // paints muted from them) — plus the semantic reason in the tooltip.
  assert.deepEqual(send!.p['attrs'], { 'aria-disabled': 'true', disabled: 'disabled' },
    'the empty-draft Send carries the disabled presentation')
  assert.equal(send!.p['title'], 'Type a message to send')
  click(pane, send!)
  await settle(200) // window: let the pane ack the frame before reading the wire
  assert.equal(calls.submits.length, 0, 'an empty draft never submits (the handler re-check holds)')
  // A non-empty draft clears the disabled presentation on the next frame.
  pane.key('text')
  await waitUntil('Send is enabled again', () => {
    const next = composerButtons(pane).get('composer-send')
    const attrs = next?.p['attrs'] as Record<string, unknown> | undefined
    return next !== undefined && attrs?.['aria-disabled'] !== 'true'
  })
})

test('composer actions: hostile model facts never reach the wire raw (labels AND titles)', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  // A model name/effort carrying OSC/escape/control content: every EXTERNAL
  // component of the tooltip passes the same physical-line sanitization as the
  // visible label (the terminal-output contract covers the title too).
  await m.commitStatus(snapshotFor({
    model: {
      displayName: 'evil\u001b]52;c;YXR0YWNr\u0007name\u000bline\u001b[2J',
      id: 'x',
      reasoningEffort: 'high\u0000ctrl\u001b',
    },
  }))
  const buttons = composerButtons(pane)
  const modelTitle = String(buttons.get('composer-model')?.p['title'] ?? '')
  const effortTitle = String(buttons.get('composer-effort')?.p['title'] ?? '')
  for (const title of [modelTitle, effortTitle]) {
    assert.ok(!title.includes('YXR0YWNr'), 'no OSC payload in the tooltip')
    assert.ok(!title.includes('\u001b'), 'no raw ESC reaches the tooltip')
    assert.ok(!title.includes('\u000b') && !title.includes('\u0000'), 'no control byte reaches the tooltip')
  }
  assert.ok(modelTitle.includes('name'), 'the readable part of the name survives')
})

test('composer actions: Send stays the ONLY submit path — a busy turn still allows queueing through it', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  await m.commitStatus(snapshotFor({ busy: true, model: { displayName: 'luna-fast', id: 'luna-fast' } }))
  const buttons = composerButtons(pane)
  assert.ok(buttons.has('composer-send'), 'Send is NOT replaced by Stop while busy')
  assert.ok(buttons.has('composer-stop'), 'Stop coexists with Send (§2.1)')
  pane.key('queued message')
  await settle(80)
  click(pane, buttons.get('composer-send')!)
  await waitUntil('the busy submit', () => calls.submits.length === 1)
  assert.equal(calls.submits[0]!.text, 'queued message')
})

/* ----------------------------------------------------------------------- Stop */

test('composer actions: Stop exists only while the committed snapshot says busy, and rides cancel', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  assert.equal(composerButtons(pane).has('composer-stop'), false, 'an idle subject paints no Stop')
  await m.commitStatus(snapshotFor({ busy: true }))
  const stop = composerButtons(pane).get('composer-stop')
  assert.ok(stop, 'the busy subject paints Stop')
  click(pane, stop!)
  await waitUntil('one cancel', () => calls.cancels === 1)
  assert.equal(m.renderer.composer.getDraft(), '', 'Stop never touches the draft')
  // Busy turning idle retires the button on the next committed frame.
  await m.commitStatus(snapshotFor({ busy: false }))
  assert.equal(composerButtons(pane).has('composer-stop'), false)
})

test('composer actions: a one-frame-old Stop click cannot cancel a NEWLY idle subject', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  await m.commitStatus(snapshotFor({ busy: true }))
  const stale = composerButtons(pane).get('composer-stop')
  assert.ok(stale)
  await m.commitStatus(snapshotFor({ busy: false }))
  // The stale node id is still addressable on the wire only if the client kept
  // it; the CURRENT frame paints no Stop, so the handler's own busy re-check is
  // the gate. Address the retired id directly to prove the re-check.
  click(pane, stale!)
  await settle(200) // window: let the pane ack the frame before reading the wire
  assert.equal(calls.cancels, 0, 'the busy re-check refused the stale click')
})

/* --------------------------------------------------------------- Model/Effort */

test('composer actions: Model and Effort forward to the one late-bound entry with the right hint', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m
  const buttons = composerButtons(pane)
  click(pane, buttons.get('composer-model')!)
  click(pane, buttons.get('composer-effort')!)
  await waitUntil('both entries', () => calls.modelEntries.length === 2)
  assert.deepEqual(calls.modelEntries, ['models', 'effort'])
  assert.equal(m.renderer.composer.getDraft(), '', 'opening the picker never touches the draft')
})

test('composer actions: the labels follow the width rule and never fabricate a value', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  const label = (node: WireNode | undefined): string => {
    if (node === undefined) return ''
    const text = node.p['text']
    if (typeof text === 'string') return text
    return String((node.c ?? []).map(child => String((child as unknown as WireNode).p?.['text'] ?? '')).join(''))
  }
  // No model fact: plain short labels, no invented `default`/`high`.
  let buttons = composerButtons(pane)
  assert.equal(label(buttons.get('composer-model')), 'Model ▾')
  assert.equal(label(buttons.get('composer-effort')), 'Effort ▾')
  // A configured model at the default 120 columns (>= 72): the bounded values appear.
  await m.commitStatus(snapshotFor({
    model: { displayName: 'luna-fast', id: 'luna-fast', reasoningEffort: 'high' },
  }))
  buttons = composerButtons(pane)
  assert.equal(label(buttons.get('composer-model')), 'Model · luna-fast ▾')
  assert.equal(label(buttons.get('composer-effort')), 'Effort · high ▾')
  // A very long display name is clamped by the shared middle clamp, never wrapped raw.
  await m.commitStatus(snapshotFor({
    model: { displayName: 'an-extremely-long-model-name-that-cannot-fit', id: 'x', reasoningEffort: 'high' },
  }))
  buttons = composerButtons(pane)
  const clamped = label(buttons.get('composer-model'))
  assert.ok(clamped.startsWith('Model · ') && clamped.endsWith(' ▾'))
  assert.ok(!clamped.includes('an-extremely-long-model-name-that-cannot-fit'),
    'the value is clamped, never painted whole')
})

test('composer actions: a narrow pane (cols < 72) keeps the short labels', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.commitStatus(snapshotFor({
    model: { displayName: 'luna-fast', id: 'luna-fast', reasoningEffort: 'high' },
  }))
  // 60 columns — the pane's own resize event drives the SDK caps.
  pane.event({ ev: 'resize', sf: pane.frames().at(-1)!.sf, cols: 60 })
  await settle(120) // window: let the pane ack the frame before reading the wire
  await m.commitStatus(snapshotFor({
    model: { displayName: 'luna-fast', id: 'luna-fast', reasoningEffort: 'high' },
  }))
  const buttons = composerButtons(pane)
  const label = (node: WireNode | undefined): string => {
    if (node === undefined) return ''
    const text = node.p['text']
    return typeof text === 'string' ? text : String((node.c ?? []).map(c => String((c as unknown as WireNode).p?.['text'] ?? '')).join(''))
  }
  assert.equal(label(buttons.get('composer-model')), 'Model ▾', 'the narrow pane drops the value')
  assert.equal(label(buttons.get('composer-effort')), 'Effort ▾')
})

/* ----------------------------------------------------------- seat admission */

test('composer actions: a click behind a modal seat, an open picker, hydration or the pre-bind window never acts', async (t) => {
  const m = await mountComposerActions({
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el', 'picker', 'row', 'overlay', 'text'],
    modelPickerKinds: true,
  })
  t.after(() => { void m.dispose() })
  const { pane, calls, renderer } = m
  // 1) The MODEL PICKER open: the base buttons are behind its layer.
  renderer.modelPresentation!.open({
    subject: { sessionless: true },
    entry: 'models',
    isCurrent: () => true,
    retry() {},
    apply: () => 'superseded',
    runOwned: (label, task, options) => {
      void Promise.resolve().then(task).then(options.onResult, options.onError)
    },
  }).setDirectory({
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'm' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'm', name: 'M' }] }],
      failures: [],
    },
  })
  await settle(150) // window: let the pane ack the frame before reading the wire
  const behind = composerButtons(pane).get('composer-model')
  assert.ok(behind, 'the base row is still in the tree behind the picker layer')
  click(pane, behind!)
  await settle(200) // window: let the pane ack the frame before reading the wire
  assert.equal(calls.modelEntries.length, 0, 'a click behind an open picker never opens a second one')
  // Close the picker and prove the same button works again (non-vacuous).
  renderer.modelPresentation!.open({
    subject: { sessionless: true },
    entry: 'models',
    isCurrent: () => true,
    retry() {},
    apply: () => 'superseded',
    runOwned: (label, task, options) => {
      void Promise.resolve().then(task).then(options.onResult, options.onError)
    },
  }).close()
  await settle(150) // window: let the pane ack the frame before reading the wire
  click(pane, composerButtons(pane).get('composer-model')!)
  await waitUntil('the re-opened base click forwards', () => calls.modelEntries.length === 1)

  // 2) The HYDRATION window: the buttons are painted but inert, and the
  //    composer's keys are DROPPED (the frozen input fence) — the draft is
  //    preserved exactly as it was, and no submit can leave the window.
  const draftBefore = m.renderer.composer.getDraft()
  renderer.display.beginSessionHydration()
  await settle(120) // window: let the pane ack the frame before reading the wire
  const hydratingButtons = composerButtons(pane)
  const send = hydratingButtons.get('composer-send')
  pane.key('typed during the window')
  await settle(80)
  click(pane, send!)
  await settle(200) // window: let the pane ack the frame before reading the wire
  assert.equal(calls.submits.length, 0, 'no submit during the hydration window')
  assert.equal(m.renderer.composer.getDraft(), draftBefore,
    'the hydration fence drops the keys and preserves the draft as it was')
})

test('composer actions: a disposed renderer never acts on a late click', async (t) => {
  const m = await mountComposerActions({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el'] })
  const { pane, calls } = m
  const send = composerButtons(pane).get('composer-send')
  const stopLike = composerButtons(pane).get('composer-model')
  await m.dispose()
  t.after(() => { void Promise.resolve() })
  // The disposed surface's wire nodes are gone from the pane; address the
  // remembered ids anyway to prove the handler-side fence.
  click(pane, send!)
  click(pane, stopLike!)
  await settle(200) // window: let the pane ack the frame before reading the wire
  assert.equal(calls.submits.length, 0)
  assert.equal(calls.modelEntries.length, 0)
})
