/**
 * TSP I-B: the ↑/↓ input-history recall on the REAL SDK mount.
 *
 * Every case drives the production `mountTspRenderer` over the shipped
 * `@stencil-hq/tern` SDK and the scripted tty pane: the key the composer sees is
 * the SDK's OWN decoded `Key`, and the assertion reads the reconciled wire node
 * props (`text` plus the UTF-16 `cursor`) of the ONE dock editor. The history
 * the recall shows is committed through the mount's own display seam — the same
 * calls the Session publication and the hydration reseed make in production —
 * so a scope change, a reseed or a settlement is proven on the surface the user
 * reads, never on a renderer-local copy.
 *
 * EVIDENCE LEVEL: SDK mount + wire. STANDS-IN: the scripted pane is not a
 * physical Tern client (the real-client keyboard lane is
 * `scripts/tern-pane-history-recall-ux.mjs`), and the application above the
 * mount is the renderer's own bound input handlers, not the `SurfaceRuntime` —
 * the real `SubmissionController`, the real `InputHistory` and the real JSONL
 * are `test/app/tern-tsp-history-recall-composition.test.ts`.
 *
 * Seat priority proves ONE fact per seat here: while a higher owner holds the
 * keys, no arrow reaches the composer. Each seat's own navigation stays with its
 * own suite (`tern-tsp-work-hub`, `tern-tsp-session-browser`,
 * `tern-tsp-model-picker`, `tern-tsp-preset-picker`,
 * `tern-tsp-model-quick-menu`, `tern-tsp-permission-composer`); the Model,
 * Preset and Quick presenters sit in the same `dispatchKey` ladder slots the
 * Session Browser and the Permission menu occupy below.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-history-recall.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import type { SessionBrowserReadSnapshot } from '../../src/app/command/session-browser-presentation.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type { TaskBrowserPresentationOpen } from '../../src/app/surface/task-presentation-port.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { PastedPathReceipt } from '../../src/app/surface/pasted-image-intake.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'

/** The SDK's own decoded gestures, sent as raw terminal bytes like a real tty. */
const UP = '\u001b[A'
const DOWN = '\u001b[B'
const ALT_UP = '\u001b[1;3A'
const ESCAPE = '\u001b'
const ENTER = '\r'
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BRACKET_BEGIN = '\u001b[200~'
const BRACKET_END = '\u001b[201~'

interface RecallCalls {
  readonly submits: Array<{ text: string; gesture: string; token: number | undefined }>
  readonly admits: string[]
  readonly remembers: string[]
  readonly receipts: PastedPathReceipt[]
  notes: number
  cancels: number
  exits: number
  steers: number
}

interface RecallPane {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly session: Session
  readonly calls: RecallCalls
  /** The REAL node id of this mount's composer editor. */
  readonly composerId: string
  /** The controlled `ui.editor` props the wire currently carries. */
  editor(): { text: string; cursor: number }
  /** Every editor/input node the surface carries (the one-seat proof). */
  fields(): string[]
  /** The focus ops the surface received, in wire order. */
  focusTargets: () => string[]
  /** Send raw key bytes, then the shared render wait (it covers the SDK frame
   *  the assertion reads, not a guessed readiness window). */
  key(bytes: string): Promise<void>
  /** Commit history rows through the mount's own display seam. */
  seed(entries: readonly string[], owner?: string): void
  /** Replace the committed status snapshot and land its frame. */
  commitStatus(snapshot: StatusSnapshot): Promise<void>
  dispose(): Promise<void>
}

interface MountOptions {
  /** Negotiate `el` + `styles` so the Quiet Composer shell (and its menus) mount. */
  readonly chrome?: boolean
  readonly sessionBrowser?: boolean
  /** The application's pasted-path delivery admission (the mount's own gate). */
  readonly admit?: (text: string) => boolean
  /** The application's plain-history eligibility. */
  readonly remember?: (text: string) => boolean
}

async function mountRecallPane(
  t: { after(fn: () => unknown): void },
  options: MountOptions = {},
): Promise<RecallPane> {
  const pane = installTspPane({
    ...(options.chrome === true ? { composerActions: true } : {}),
    ...(options.sessionBrowser === true ? { sessionBrowser: true } : {}),
  })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects through the shipped SDK')
  const calls: RecallCalls = {
    submits: [], admits: [], remembers: [], receipts: [],
    notes: 0, cancels: 0, exits: 0, steers: 0,
  }
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit: () => { calls.exits += 1 },
    onFatal: (error) => assert.fail(`the mount routed a fatal: ${String(error)}`),
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit: () => { calls.exits += 1 },
    cancel: () => { calls.cancels += 1 },
    submit: (text, request, scopeToken) => {
      calls.submits.push({ text, gesture: String(request), token: scopeToken })
    },
    steer: () => { calls.steers += 1 },
    pasteMedia: () => {},
    pastedPath: (receipt) => { calls.receipts.push(receipt) },
    admitPastedPathDelivery: (text) => {
      calls.admits.push(text)
      return options.admit === undefined ? true : options.admit(text)
    },
    shouldRememberInput: (text) => {
      calls.remembers.push(text)
      return options.remember === undefined ? true : options.remember(text)
    },
    noteUserInput: () => { calls.notes += 1 },
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: () => {},
    openModelQuick: () => {},
    openSessionBrowser: () => {},
    sessionBrowserAvailable: () => true,
    ...(options.chrome === true
      ? {
        permissionOptions: () => ['read-only', 'workspace-write', 'danger-full-access'],
        selectPermission: () => {},
      }
      : {}),
  })
  let status = emptyStatusSnapshot()
  renderer.bindStatusReader({ snapshot: () => status })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await settle()
  const composerId = options.chrome === true ? 'dock.quiet-composer.composer' : 'dock.composer'
  return {
    pane,
    renderer,
    session,
    calls,
    composerId,
    editor() {
      const node = wireNodes(pane).find(candidate => candidate.id === composerId)
      assert.ok(node, `the ${composerId} editor node is on the wire`)
      return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    },
    fields() {
      return wireNodes(pane)
        .filter(node => node.k === 'editor' || node.k === 'input')
        .map(node => node.id)
    },
    focusTargets: () => pane.frames()
      .flatMap(frame => frame.ops.filter(op => op[0] === 'focus').map(op => String(op[1]))),
    async key(bytes) {
      pane.key(bytes)
      // reason: the shared render wait covers the SDK frame/delivery the
      // assertion reads; the wire is what the case observes.
      await settle()
    },
    seed(entries, owner) {
      renderer.display.resetInputHistory(entries, owner)
    },
    async commitStatus(snapshot) {
      const before = pane.frameCount()
      status = snapshot
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the status committed a frame', () => pane.frameCount() > before)
      await settle(80)
    },
    dispose: async () => {
      await renderer.dispose()
      await session.close()
    },
  }
}

/** Click one `el` node the pane carries (the composer's own control entries). */
function clickNode(pane: TspPane, idFragment: string): void {
  const node = wireNodes(pane).find(candidate => candidate.k === 'el' && candidate.id.includes(idFragment))
  assert.ok(node, `the ${idFragment} control is on the wire`)
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: node.id, act: 'click' })
}

const SESSION_ROWS: SessionBrowserReadSnapshot = {
  listState: 'ready',
  rows: [
    { id: 'session-a', updatedAt: 1_700_000_000_000, createdAt: 1_700_000_000_000, cwd: '/work', live: true, title: 'A' },
    { id: 'session-b', updatedAt: 1_700_000_000_001, createdAt: 1_700_000_000_000, cwd: '/work', live: false, title: 'B' },
  ],
  query: '',
  resumePending: false,
  searchState: 'idle',
  searchResults: [],
  hasMore: false,
}

const HUB_ITEMS: readonly TaskPanelItem[] = [
  { value: 'agent:child-1', label: 'child agent', status: 'running', group: 'subagents' },
  { value: 'job:j1', label: 'pnpm test', status: 'running', group: 'jobs' },
]

function hubOptions(): TaskBrowserPresentationOpen {
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
  }
}
test('↑ walks the mount scope onto the controlled editor and ↓ returns the draft with its exact caret', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest entry', 'older entry'])
  h.pane.key('my draft')
  await waitUntil('the composer holds the typed draft', () => h.editor().text === 'my draft')
  const focusedBefore = h.focusTargets().at(-1)

  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'my draft', cursor: 0 },
    'the first ↑ only moved the caret to the recallable boundary')
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest entry', cursor: 0 },
    'the second ↑ took index 0 of the newest-first snapshot — the newest row, never the oldest')
  await h.key(UP)
  assert.equal(h.editor().text, 'older entry', 'a repeated ↑ walks older')
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'newest entry', cursor: 12 }, '↓ walks newer and lands that row end')
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'my draft', cursor: 8 },
    'leaving index 0 restores the pre-browse draft and its UTF-16 caret')
  assert.equal(h.calls.submits.length, 0, 'the whole gesture sequence never submitted')
  assert.equal(h.focusTargets().at(-1), focusedBefore, 'the hardware focus stays on the same editor node')
})

test('the Quiet Composer recall paints its ONE editor path and adds no second field', async (t) => {
  const h = await mountRecallPane(t, { chrome: true })
  assert.deepEqual(h.fields(), [h.composerId], 'the shell carries exactly one editor before the recall')
  h.seed(['quiet row'])
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'quiet row', cursor: 0 },
    'the recalled row is the same controlled editor, at its real nested path')
  assert.deepEqual(h.fields(), [h.composerId], 'and no second input node appeared')
})

test('a modal form owns the arrows, the hidden composer keeps its draft, and the recall resumes after it closes', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest entry'])
  h.pane.key('hidden draft')
  await waitUntil('the composer holds the draft', () => h.editor().text === 'hidden draft')
  const pending = h.renderer.interaction.askQuestions(
    [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
    undefined,
    undefined,
    false,
  )
  pending.catch(() => {})
  await settle()
  const notes = h.calls.notes
  await h.key(UP)
  await h.key(UP)
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'hidden draft', cursor: 12 },
    'the seat consumed every arrow: the draft, the caret and the focus behind it are untouched')
  assert.equal(h.calls.notes, notes, 'a key the seat owns is not composer user input')
  h.pane.key(ESCAPE)
  await settle()
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'hidden draft', cursor: 0 },
    'the first ↑ after the close is the boundary step — no ghost jump into history')
  await h.key(UP)
  assert.equal(h.editor().text, 'newest entry', 'the recall resumes once the seat lets go')
})

test('the Permission menu cycles its options on ↑/↓ without touching the draft, and Escape leaves only the menu', async (t) => {
  const h = await mountRecallPane(t, { chrome: true })
  const base = emptyStatusSnapshot()
  await h.commitStatus({
    ...base,
    access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } },
  } as StatusSnapshot)
  await h.key('draft under the menu')
  h.seed(['newest entry'])
  clickNode(h.pane, '.composer-permission-s')
  await settle()
  const before = h.editor()
  await h.key(DOWN)
  await h.key(UP)
  assert.deepEqual(h.editor(), before, 'the open menu took both arrows; the composer text and caret did not move')
  h.pane.key(ESCAPE)
  await settle()
  assert.equal(h.calls.cancels, 0, 'Escape closed the menu and did not route the cancel intent')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest entry', cursor: 0 }, 'the recall works once the menu is closed')
})

test('the Session Browser and the Work Hub consume the arrows before the composer does', async (t) => {
  const h = await mountRecallPane(t, { sessionBrowser: true })
  h.seed(['newest entry'])
  h.pane.key('kept draft')
  await waitUntil('the composer holds the draft', () => h.editor().text === 'kept draft')

  const presentation = h.renderer.sessionBrowserPresentation
  assert.ok(presentation, 'the pane advertises the Browser kinds')
  const browser = presentation.open({
    subject: { currentSessionId: 'session-a', currentCwd: '/work', isCurrent: () => true },
    onQueryChange: () => {},
    onResumeIntent: () => {},
    onClose: () => {},
  })
  browser.setSnapshot(SESSION_ROWS)
  await settle()
  await h.key(UP)
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'kept draft', cursor: 10 },
    'the Browser list took the arrows; the composer behind it never moved')
  browser.close()
  await settle()

  const hub = h.renderer.taskPresentation.openBrowser(HUB_ITEMS, () => 'close', () => {}, hubOptions())
  await settle()
  await h.key(UP)
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'kept draft', cursor: 10 }, 'the Work Hub takes the arrows too')
  hub.close()
  await settle()
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest entry', cursor: 0 }, 'and the recall resumes for the composer')
})

test('a formal scope begin or reseed retires the open browse so an outgoing draft cannot be walked back in', async (t) => {
  const h = await mountRecallPane(t)
  // Boot: the sessionless launch-cwd pool is a real scope.
  h.seed(['cwd row'])
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'cwd row', cursor: 0 }, 'a deferred start recalls the cwd immediately')

  h.renderer.display.beginInputHistoryScope('session-a')
  h.renderer.display.resetInputHistory(['a row'], 'session-a')
  await settle()
  assert.deepEqual(h.editor(), { text: 'cwd row', cursor: 0 }, 'the seam commits state only — it never rewrites the visible text')
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'cwd row', cursor: 7 },
    'the pool browse was retired: ↓ moves the caret, it cannot restore a replaced projection')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'a row', cursor: 0 }, 'A\'s own rows are what the browse walks now')

  // B is published while A's row is on screen: A's browse must not follow.
  h.renderer.composer.setDraft('typed in a')
  await waitUntil('the composer holds the A draft', () => h.editor().text === 'typed in a')
  await h.key(UP)
  await h.key(UP)
  assert.equal(h.editor().text, 'a row', 'the draft is bookmarked inside A')
  h.renderer.display.beginInputHistoryScope('session-b')
  h.renderer.display.resetInputHistory(['b row'], 'session-b')
  await settle()
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'a row', cursor: 5 },
    'B\'s publication retired the browse: the A draft cannot come back')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'b row', cursor: 0 }, 'B recalls only B\'s rows')

  // And back to A (A→B→A): A's rows are recallable again, B's browse is gone.
  h.renderer.display.beginInputHistoryScope('session-a')
  h.renderer.display.resetInputHistory(['a row'], 'session-a')
  await settle()
  await h.key(DOWN)
  assert.equal(h.editor().text, 'b row', 'the B bookmark died with the publication')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'a row', cursor: 0 }, 'A recalls its own rows again after the switch back')
})

test('a settlement, a status commit and a Welcome commit never cancel the open browse', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest', 'older'])
  h.pane.key('mine')
  await waitUntil('the composer holds the draft', () => h.editor().text === 'mine')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest', cursor: 0 })

  h.renderer.display.settleScopeInput({ token: 7, owner: 'session-x', outcome: 'written', text: 'a settled row' })
  await settle()
  assert.deepEqual(h.editor(), { text: 'newest', cursor: 0 },
    'a settlement updates the kernel ledger, not the row being read')
  await h.key(UP)
  assert.equal(h.editor().text, 'older', 'and the browse continues from where it was')

  h.renderer.display.setWelcomeIdle(true)
  h.renderer.display.commitStatusFacts({ sessionTitle: 'renamed' })
  h.renderer.display.setPendingInputPresentation({ queued: [], tail: [], running: true })
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await settle()
  assert.equal(h.editor().text, 'older', 'no repaint is a history-owner signal — the browse survived all four')
  await h.key(DOWN)
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'mine', cursor: 4 }, 'and ↓ still returns the user\'s own draft')
})

test('the hydration window drops arrows like every other edit, and the browse that survived it resumes at the commit', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest', 'older'])
  h.pane.key('mine')
  await waitUntil('the composer holds the draft', () => h.editor().text === 'mine')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest', cursor: 0 })
  const notes = h.calls.notes

  h.renderer.display.beginSessionHydration()
  await settle()
  await h.key(DOWN)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest', cursor: 0 }, 'a fenced arrow writes nothing to the wire')
  assert.equal(h.calls.notes, notes, 'and a fenced arrow is not user input either')

  // The incoming subject commits and lifts the fence. Loading alone never
  // retired the bookmark, so the pre-publication window cannot eat the draft.
  h.renderer.display.setTranscript(
    [] as never, undefined, { mode: 'latest' } as never, [], undefined, { generation: 'next' }, 'hidden',
  )
  await settle()
  await h.key(DOWN)
  assert.deepEqual(h.editor(), { text: 'mine', cursor: 4 },
    'the browse the window preserved still returns the draft it replaced')
})

test('a disposed mount takes no late arrow and commits no late recall state', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest'])
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'newest', cursor: 0 })
  await h.renderer.dispose()
  const frames = h.pane.frames().length

  await h.key(DOWN)
  await h.key(UP)
  assert.equal(h.pane.frames().length, frames, 'no key after the release paints a frame')

  h.renderer.display.resetInputHistory(['late row'], 'late-owner')
  h.renderer.display.settleScopeInput({ token: 3, owner: 'late-owner', outcome: 'written', text: 'late row' })
  await settle()
  assert.equal(h.renderer.scopeFactCountForTest(), 0, 'a disposed mount commits no recall state')
  assert.equal(h.pane.frames().length, frames, 'and the late seam commits still painted nothing')
})

test('a draft the application refuses keeps its text, its caret and its live paste lease', async (t) => {
  const path = '/home/xmoon/.cache/tern/pastes/a07fa8e58c3d1059.png'
  const h = await mountRecallPane(t, { admit: (text) => !text.includes(path) })
  h.seed(['plain row'])
  h.pane.key(`${BRACKET_BEGIN}${path} ${BRACKET_END}`)
  await waitUntil('the pasted path is ordinary draft text', () => h.editor().text === `${path} `)
  const receipt = h.calls.receipts[0]
  assert.ok(receipt, 'one real bracketed paste forwarded exactly one receipt')

  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: `${path} `, cursor: 0 },
    'the refused recall replaced nothing and cleared nothing')
  assert.equal(h.calls.admits.at(-1), `${path} `, 'the refusal came from the application gate, not a renderer guess')
  assert.equal(receipt.hasLivePath(path), true, 'the read still in flight keeps its own lease')

  h.renderer.composer.setDraft('plain')
  await waitUntil('the plain draft is live', () => h.editor().text === 'plain')
  await h.key(UP)
  await h.key(UP)
  assert.deepEqual(h.editor(), { text: 'plain row', cursor: 0 }, 'a plain draft recalls normally')
  assert.equal(receipt.replacePastedPath(path, '[image #1 (8×8)]'), false,
    'the late image read can never rewrite bytes inside a recalled history row')
  assert.equal(h.editor().text, 'plain row', 'and the recalled row stayed exactly what the scope carried')
})

test('the arrows never become a submit, a steer or a cancel: the existing gestures keep their owners', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest', 'older'])
  await h.key(UP)
  await h.key(UP)
  await h.key(DOWN)
  await h.key(UP)
  assert.equal(h.calls.submits.length, 0, 'no arrow submitted')
  assert.equal(h.calls.steers, 0, 'no arrow steered')
  assert.equal(h.calls.cancels, 0, 'no arrow cancelled')

  h.pane.key(ENTER)
  await waitUntil('the recalled row reached the application submit entry', () => h.calls.submits.length === 1)
  assert.equal(h.calls.submits[0]!.text, 'older', 'Enter submits the row the browse is sitting on and nothing else')
  assert.equal(typeof h.calls.submits[0]!.token, 'number',
    'the accepted Enter still mints its occurrence token in the same mount kernel')
  assert.deepEqual(h.editor(), { text: '', cursor: 0 }, 'the draft cleared exactly as it did before the recall')

  h.pane.key(CTRL_C)
  await settle()
  assert.equal(h.calls.cancels, 1, 'Ctrl+C is still the cancel intent')
  h.pane.key(CTRL_D)
  await waitUntil('the empty-draft Ctrl+D routed the exit', () => h.calls.exits === 1)
})

test('a modified arrow stays whatever the application already made it, never the recall', async (t) => {
  const h = await mountRecallPane(t)
  h.seed(['newest'])
  h.pane.key('draft')
  await waitUntil('the composer holds the draft', () => h.editor().text === 'draft')
  await h.key(ALT_UP)
  assert.deepEqual(h.editor(), { text: 'draft', cursor: 5 }, 'the recall never consumed a modified arrow')
  assert.deepEqual(h.calls.admits, [], 'and no application gate was consulted for it')
})
