/**
 * The TSP slash-completion seat on the REAL SDK mount.
 *
 * Every case drives the production `mountTspRenderer` over the scripted tty pane
 * and the shipped `@stencil-hq/tern` SDK: the catalog arrives through the
 * mount's own install port (the same call the command layer's single commit
 * point makes), the key the composer sees is the SDK's OWN decoded `Key`, and
 * the assertion reads the reconciled wire — the ONE dock editor's controlled
 * `text`/UTF-16 `cursor`, the candidate rows of the anchored list, and the exact
 * number of application callbacks the mount made.
 *
 * EVIDENCE LEVEL: SDK mount + wire. STANDS-IN: the scripted pane is not a
 * physical Tern client (that lane is `scripts/tern-pane-slash-completion-ux.mjs`
 * and `scripts/tern-gui-slash-completion.mjs`); the application above the mount
 * is the renderer's own bound input handlers, not the `SurfaceRuntime` — the
 * real catalog provenance, the real `SubmissionController` and the real
 * extension registry are
 * `test/app/tern-tsp-slash-completion-composition.test.ts`.
 *
 * Seat priority proves ONE fact per seat here: while a higher owner holds the
 * keys, no arrow reaches the completion list. Each seat's own navigation stays
 * with its own suite (`tern-tsp-permission-composer`,
 * `tern-tsp-model-quick-menu`, `tern-tsp-session-browser`,
 * `tern-tsp-model-picker`, `tern-tsp-preset-picker`, `tern-tsp-work-hub`).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-slash-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { TspCommandCompletionInstallation } from '../../src/app/surface/runtime.ts'
import type { HostFilePort } from '../../src/runtime/host-file-port.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'

/**
 * The bounded observation window for this file's ABSENCE claims (the same
 * contract `docs/guides/testing.md` §5 and the sibling TSP lanes use): "the
 * popup did not appear" has no event to await, so an absence claim waits
 * exactly this window and then reads the wire, while every PRESENCE claim waits
 * an authoritative pane frame.
 */
const ABSENCE_WINDOW_MS = 200

const ESCAPE = '\u001b'
const UP = `${ESCAPE}[A`
const DOWN = `${ESCAPE}[B`
const ALT_UP = `${ESCAPE}[1;3A`
const TAB = '\t'
const SHIFT_TAB = `${ESCAPE}[27;2Z`
const ENTER = '\r'
const CTRL_C = '\u0003'

const COMMANDS = [
  { name: 'model', description: 'Choose a model' },
  // An empty description is what the catalog carries for a row with none: the
  // provider composes it away, so the row paints no description slot.
  { name: 'more', description: '' },
  { name: 'new', description: 'Create a session', argumentHint: '<title>' },
]

interface SeatCalls {
  submits: Array<{ text: string; gesture: string }>
  cancels: number
  notes: number
  exits: number
  steers: number
  pastes: number
}

interface SlashPane {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly session: Session
  readonly calls: SeatCalls
  readonly composerId: string
  /** The Host-file port this mount was installed with (a counting stub). */
  readonly hostFileCalls: () => number
  editor(): { text: string; cursor: number }
  /** The ONE input field on the wire (never a second editor). */
  fields(): string[]
  /** The candidate rows currently on the wire, in painted order. */
  rows(): WireNode[]
  /** The plain-text candidate lines of a pane without styled chrome. */
  bareRows(): WireNode[]
  /** The text a candidate row paints (its own children). */
  rowText(node: WireNode): string
  highlighted(): WireNode[]
  /** Commit a draft through the mount's own composer port and land its frame,
   *  so a case starts from an exact document instead of a keystroke sequence. */
  type(draft: string): Promise<void>
  /** Install a catalog through the mount's own install port. */
  install(overrides?: Partial<TspCommandCompletionInstallation>): void
  /** Send a key that MUST move the wire and wait for the frame it painted. */
  key(bytes: string): Promise<void>
  /** Send a key that must change NOTHING, then wait the absence window. */
  quietKey(bytes: string): Promise<void>
  click(node: WireNode): Promise<void>
  commitStatus(snapshot: StatusSnapshot): Promise<void>
  dispose(): Promise<void>
}

interface MountOptions {
  /** Negotiate `el` + `styles` so the Quiet Composer shell (and its popup) mounts. */
  readonly chrome?: boolean
  readonly commands?: TspCommandCompletionInstallation['commands']
  /** A Host-file port that COUNTS every call (the no-file-probe witness). */
  readonly countingHostFile?: boolean
  readonly extensionSuggest?: TspCommandCompletionInstallation['extensionSuggest']
}

function permissionSnapshot(id: string, label = id, matched = true): StatusSnapshot {
  return {
    ...emptyStatusSnapshot(),
    access: { permissionPreset: { id, label, matched } },
  } as StatusSnapshot
}

/** A Host-file port that only counts: I-C opens no file seat, so it must never
 *  be consulted, and this is the witness rather than an inference. */
function countingHostFilePort(onCall: () => void): HostFilePort {
  return {
    async listReferences () {
      onCall()
      return { kind: 'unavailable', reason: 'the witness port never discovers files' }
    },
    async resolveReference () {
      onCall()
      return { kind: 'unavailable', reason: 'the witness port never probes a path' }
    },
    async canonicalizeMentions (_scope, text) {
      onCall()
      return text
    },
  }
}

async function mountSlashPane(
  t: { after(fn: () => unknown): void },
  options: MountOptions = {},
): Promise<SlashPane> {
  const chrome = options.chrome === true
  const pane = installTspPane(chrome ? { composerActions: true, modelQuick: true } : {})
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects through the shipped SDK')
  const calls: SeatCalls = { submits: [], cancels: 0, notes: 0, exits: 0, steers: 0, pastes: 0 }
  let hostFileCalls = 0
  const hostFile = options.countingHostFile === true
    ? countingHostFilePort(() => { hostFileCalls += 1 })
    : null
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit: () => { calls.exits += 1 },
    onFatal: (error) => assert.fail(`the mount routed a fatal: ${String(error)}`),
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit: () => { calls.exits += 1 },
    cancel: () => { calls.cancels += 1 },
    submit: (text, request) => { calls.submits.push({ text, gesture: String(request) }) },
    steer: () => { calls.steers += 1 },
    pasteMedia: () => { calls.pastes += 1 },
    pastedPath: () => {},
    admitPastedPathDelivery: () => true,
    shouldRememberInput: () => true,
    noteUserInput: () => { calls.notes += 1 },
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: () => {},
    openModelQuick: () => {},
    openSessionBrowser: () => {},
    sessionBrowserAvailable: () => true,
    ...(chrome
      ? {
        permissionOptions: () => ['read-only', 'workspace-write', 'danger-full-access'],
        selectPermission: () => {},
      }
      : {}),
  })
  let status = emptyStatusSnapshot()
  renderer.bindStatusReader({ snapshot: () => status })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  const composerId = chrome ? 'dock.quiet-composer.composer' : 'dock.composer'
  await waitUntil('the mount painted its composer editor', () => wireNodes(pane).some(node => node.id === composerId))

  const install = (overrides: Partial<TspCommandCompletionInstallation> = {}): void => {
    renderer.installCommandCompletions({
      commands: options.commands ?? COMMANDS,
      cwd: '/work',
      fileReferences: hostFile,
      scope: () => ({ kind: 'workspace', cwd: '/work' }),
      localCwd: () => '/work',
      skillReferences: [],
      hostShellCompletion: false,
      ...(options.extensionSuggest === undefined ? {} : { extensionSuggest: options.extensionSuggest }),
      ...overrides,
    })
  }
  install()

  const nodes = (): WireNode[] => wireNodes(pane)
  // A candidate ROW is the `el` button itself; its name/description are CHILD
  // nodes addressed under it (`…​.slash-….0`), so the row filter must not match
  // those. The bare pane has no styled rows: it paints plain `ui.text` lines.
  const rowNodes = (): WireNode[] => nodes().filter(node => node.k === 'el'
    && /\.slash-[^.]+$/.test(node.id))
  const bareRowNodes = (): WireNode[] => nodes().filter(node => node.k === 'text'
    && /slash-bare-/.test(node.id))
  const m: SlashPane = {
    pane,
    renderer,
    session,
    calls,
    composerId,
    hostFileCalls: () => hostFileCalls,
    editor() {
      const node = nodes().find(candidate => candidate.id === composerId)
      assert.ok(node, `the ${composerId} editor node is on the wire`)
      return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    },
    fields() {
      return nodes().filter(node => node.k === 'editor' || node.k === 'input').map(node => node.id)
    },
    rows: rowNodes,
    bareRows: bareRowNodes,
    rowText(node) {
      if (node.c === undefined || node.c.length === 0) return String(node.p.text ?? '')
      return node.c.map(child => String((nodes().find(c => c.id === child.id) ?? child).p.text ?? '')).join('')
    },
    highlighted() {
      return rowNodes().filter(node => (node.p.attrs as Record<string, string> | undefined)?.['data-highlight'] === 'true')
    },
    install,
    async type(draft) {
      m.renderer.composer.setDraft(draft)
      await waitUntil(`the draft ${JSON.stringify(draft)} painted`, () => m.editor().text === draft)
    },
    async key(bytes) {
      const mark = pane.frameCount()
      pane.key(bytes)
      await waitUntil(`the ${JSON.stringify(bytes)} key painted its frame`, () => pane.frameCount() > mark)
    },
    async quietKey(bytes) {
      pane.key(bytes)
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async click(node) {
      pane.event({ ev: 'action', sf: pane.frames().at(-1)?.sf, id: node.id, act: 'click' })
      await new Promise(resolve => setTimeout(resolve, 60))
    },
    commitStatus: async (snapshot) => {
      status = snapshot
      renderer.display.commitDisplaySubject({}, {}, undefined)
      const mark = pane.frameCount()
      await waitUntil('the committed status painted its frame', () => pane.frameCount() > mark)
    },
    dispose: () => renderer.dispose(),
  }
  return m
}

// ── The natural query and the accept-only rule ───────────────────────────────

test('typing a first-line slash command token paints the installed candidates and changes nothing else', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/modelChoose a model', ' /more'],
    'the provider order is kept, the first row is the default highlight, and a row without a description paints no empty slot')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'the draft and the caret stay exactly what the user typed')
  assert.deepEqual(m.calls.submits, [], 'painting a candidate list submits nothing')
  assert.equal(m.fields().length, 1, 'the popup never adds a second input field')
})

test('a plain Enter on a highlighted candidate completes the command name and never submits; the next Enter submits once', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/model ', cursor: 7 },
    'the accept writes the command name plus the provider separator and lands the caret after it')
  assert.deepEqual(m.calls.submits, [], 'accepting a candidate is never a submission')
  assert.equal(m.rows().length, 0, 'the accepted frame carries no stale list')
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [{ text: '/model ', gesture: 'enter' }],
    'the LATER explicit Enter is the one business submission')
})

test('Tab opens the list without accepting it, and Tab and Shift+Tab walk the candidates', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/m')
  await waitUntil('the Tab-less list painted', () => m.rows().length > 0)
  const first = m.rows()
  assert.equal(m.highlighted().length, 1)
  assert.equal(m.rowText(m.highlighted()[0]!), '›/modelChoose a model')
  await m.key(TAB)
  assert.deepEqual(m.editor(), { text: '/m', cursor: 2 }, 'Tab walks the list and never writes the draft')
  assert.equal(m.rowText(m.highlighted()[0]!), ' /more'.replace(/^ /, '›'), 'Tab moved the highlight forward')
  await m.key(SHIFT_TAB)
  assert.equal(m.rowText(m.highlighted()[0]!), '›/modelChoose a model', 'Shift+Tab moved it back')
  assert.deepEqual(m.calls.submits, [], 'no Tab gesture submitted anything')
})

test('with one candidate, Tab accepts that one candidate and still submits nothing', async (t) => {
  const m = await mountSlashPane(t, { chrome: true, commands: [{ name: 'model', description: 'Choose a model' }] })
  await m.key('/mo')
  await waitUntil('the single candidate painted', () => m.rows().length === 1)
  await m.key(TAB)
  assert.deepEqual(m.editor(), { text: '/model ', cursor: 7 })
  assert.deepEqual(m.calls.submits, [])
})

test('arrows walk the candidate list while it is open and never touch the history recall', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  // Seed history through the mount's OWN seam, so a browse would be observable.
  m.renderer.display.resetInputHistory(['newest draft', 'older draft'], 'scope-a')
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  await m.key(UP)
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, '↑ with the list open walks it, it never recalls history')
  assert.equal(m.rowText(m.highlighted()[0]!), '›/more', '↑ from the first row wraps to the last')
  await m.key(DOWN)
  assert.equal(m.rowText(m.highlighted()[0]!), '›/modelChoose a model', '↓ wraps back')
  // The history kernel is untouched: with the list closed the arrows are still
  // the I-B recall, and the first ↑ from a non-zero caret is the line Home that
  // I-B defines before the browse begins.
  await m.key(ESCAPE)
  assert.equal(m.rows().length, 0, 'Escape closed only the list')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'Escape left the draft and the caret untouched')
  assert.equal(m.calls.cancels, 0, 'an open list turns Escape into a dismiss, never a cancel')
  await m.key(UP)
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 0 }, 'the first ↑ from a mid-line caret is still the I-B Home move')
  await m.key(UP)
  assert.equal(m.editor().text, 'newest draft', 'with the list closed, the next ↑ is the history recall')
})

test('a modified arrow never enters the candidate list', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  const before = m.highlighted()
  await m.quietKey(ALT_UP)
  assert.equal(m.rows().length, 0, 'a modified key retires the list instead of walking it')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'and the modified key never edits the draft')
  assert.equal(m.highlighted().length === before.length, false)
})

test('Escape with the list closed keeps the existing cancel owner and runs it exactly once', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  await m.key(ESCAPE)
  assert.equal(m.calls.cancels, 0, 'the first Escape belongs to the list')
  await m.quietKey(ESCAPE)
  assert.equal(m.calls.cancels, 1, 'the next Escape reaches the original cancel owner once')
})

test('Ctrl+C retires the list and still runs the existing cancel intent exactly once', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the candidate list painted', () => m.rows().length > 0)
  await m.quietKey(CTRL_C)
  assert.equal(m.calls.cancels, 1, 'the cancel intent is never swallowed by the popup')
  assert.equal(m.rows().length, 0, 'the list is gone')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'and the draft is untouched')
})

// ── The seat fence: what is never a command seat ─────────────────────────────

test('an argument position, a second line, an at-mention, a shell line and prose never open a candidate list', async (t) => {
  const m = await mountSlashPane(t, { chrome: true, countingHostFile: true })
  for (const draft of ['/attach ', '/attach im', 'a\n/ne', '@src', '!ls', '!!', 'hello /ne', '/usr/bi']) {
    // The draft is committed through the mount's own composer port (a raw `\n`
    // byte is an Enter gesture to the SDK, not a line break), then ONE real key
    // edits it so the natural trigger runs against the intended document.
    await m.type(draft)
    await m.key('x')
    assert.equal(m.rows().length, 0, `${JSON.stringify(draft)} paints no candidate list`)
    assert.equal(m.bareRows().length, 0, `${JSON.stringify(draft)} paints no bare candidate line`)
    assert.deepEqual(m.calls.submits, [], `${JSON.stringify(draft)} submitted nothing`)
  }
  assert.equal(m.hostFileCalls(), 0, 'no completion request reached the Host-file port')
})

test('Tab outside the command seat is not consumed by the completion seat', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('hello')
  await m.quietKey(TAB)
  assert.equal(m.rows().length, 0, 'ordinary prose has no candidate list')
  assert.equal(m.editor().text.length > 0, true, 'and the Tab key is left to its existing owner')
})

// ── Catalog lifecycle ───────────────────────────────────────────────────────

test('a new catalog commit withdraws the current list and the next query shows only the new source', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the first catalog painted', () => m.rows().length === 2)
  m.install({ commands: [{ name: 'model', description: 'Choose a model' }] })
  assert.equal(m.rows().length, 0, 'a replaced source never keeps the rows it no longer owns')
  await m.type('/m')
  await m.key('o')
  await waitUntil('the new source painted its own list', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/modelChoose a model'],
    'only the commands of the CURRENT catalog are offered')
})

test('an empty candidate install withdraws the list entirely', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/ne')
  await waitUntil('the list painted', () => m.rows().length > 0)
  m.install({ commands: [] })
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.rows().length, 0, 'a withdrawn source shows no shell of a menu')
  assert.deepEqual(m.editor(), { text: '/ne', cursor: 3 })
})

test('a click on a candidate row of an older frame completes nothing', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the list painted', () => m.rows().length > 0)
  const stale = m.rows()[1]!
  m.install({ commands: [{ name: 'model', description: 'Choose a model' }] })
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  await m.click(stale)
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'an old row cannot write into the composer')
  assert.deepEqual(m.calls.submits, [], 'a rejected click never submits')
})

test('a click on the current row completes it once and submits nothing', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the list painted', () => m.rows().length > 0)
  await m.click(m.rows()[1]!)
  assert.deepEqual(m.editor(), { text: '/more ', cursor: 6 },
    'the clicked row is the one written, with the provider command-name separator')
  assert.equal(m.rows().length, 0)
  assert.deepEqual(m.calls.submits, [])
})

test('a late plugin answer that arrives after the user typed on never paints and never accepts', async (t) => {
  const release: Array<(value: { items: { value: string; label: string }[]; prefix: string } | null) => void> = []
  const m = await mountSlashPane(t, {
    chrome: true,
    // The plugin chain is consulted only when the host catalog has nothing, so
    // an unknown command name is the honest slow-answer path.
    extensionSuggest: (query) => new Promise((resolve) => { release.push(resolve as never) }),
  })
  await m.type('/z')
  await m.key('z')
  assert.equal(m.rows().length, 0, 'nothing is painted while the answer is outstanding')
  // The user keeps typing: this retires every request outstanding until now,
  // so each of those answers must be dropped on arrival.
  const stale = [...release]
  await m.key('q')
  const live = release[release.length - 1]!
  for (const answer of stale) {
    answer({ items: [{ value: 'stale', label: 'stale' }], prefix: '/zz' })
  }
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.rows().length, 0, `all ${stale.length} superseded answers paint nothing`)
  assert.deepEqual(m.editor(), { text: '/zzq', cursor: 4 }, 'and no late answer writes the draft')
  live({ items: [{ value: 'zzq', label: 'zzq' }], prefix: '/zzq' })
  await waitUntil('the current answer paints its own list', () => m.rows().length > 0)
  assert.equal(m.rowText(m.rows()[0]!), '›/zzq', 'the list the user can now accept belongs to the live query')
})

// ── Formal lifecycle seams ──────────────────────────────────────────────────

test('a formal scope commit, a draft clear and a hydration window each retire the browse so its rows can never be accepted', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  const refusedAfter = async (seam: () => void, label: string): Promise<void> => {
    await m.type('/mo')
    // Tab is the explicit trigger: a programmatic draft write never queries.
    await m.key(TAB)
    await waitUntil(`${label}: the list painted`, () => m.rows().length > 0)
    const rows = m.rows()
    seam()
    // The seat-state commit is SYNCHRONOUS, and these seams deliberately trigger
    // no repaint (the publication blocks own that frame). So the witness is the
    // one that matters to the user: the rows still on screen can no longer do
    // anything — no draft write, no submit — and the next painted frame carries
    // no list at all.
    await m.click(rows[0]!)
    assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, `${label}: a retired row cannot write the draft`)
    assert.deepEqual(m.calls.submits, [], `${label}: a retired row cannot submit`)
    await m.type('/mo')
    assert.equal(m.rows().length, 0, `${label}: the next frame carries no list`)
  }
  await refusedAfter(() => { m.renderer.display.beginInputHistoryScope('owner-b') }, 'a published owner')
  await refusedAfter(() => { m.renderer.display.resetInputHistory(['row'], 'owner-c') }, 'a reseeded scope')
  await refusedAfter(() => { m.renderer.display.beginSessionHydration() }, 'the hydration window')
  assert.equal(m.calls.cancels, 0, 'none of these seams became a cancel')
})

test('a composer control that takes the keys retires the hidden slash list', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.commitStatus(permissionSnapshot('workspace-write'))
  await m.key('/mo')
  await waitUntil('the slash list painted', () => m.rows().length > 0)
  const trigger = wireNodes(m.pane).find(node => node.k === 'el' && node.id.includes('.composer-permission-s')
    && !node.id.includes('option'))
  assert.ok(trigger, 'the permission trigger is on the wire')
  await m.click(trigger!)
  await waitUntil('the permission menu opened', () => wireNodes(m.pane).some(node => node.id.includes('.composer-permission-option-')))
  assert.equal(m.rows().length, 0, 'the slash list is gone once the menu owns the keys')
  const highlightOf = (list: WireNode[]): string => list
    .filter(node => (node.p.attrs as Record<string, string> | undefined)?.['data-highlight'] === 'true')
    .map(node => node.id).join(',')
  const options = wireNodes(m.pane).filter(node => node.k === 'el' && node.id.includes('.composer-permission-option-'))
  const beforeHighlight = highlightOf(options)
  await m.key(DOWN)
  const moved = wireNodes(m.pane).filter(node => node.k === 'el' && node.id.includes('.composer-permission-option-'))
  const highlightedOption = moved.filter(node => (node.p.attrs as Record<string, string> | undefined)?.['data-highlight'] === 'true')
  assert.equal(highlightedOption.length, 1, 'exactly one menu row holds the highlight')
  assert.notEqual(highlightOf(moved), beforeHighlight, 'the menu, not the slash list, answered the arrow')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'the menu key never edits the draft')
})

test('a disposed mount cannot be painted or written by a late catalog or a late answer', async (t) => {
  const release: Array<(value: never) => void> = []
  const m = await mountSlashPane(t, {
    chrome: true,
    extensionSuggest: () => new Promise((resolve) => { release.push(resolve as never) }),
  })
  await m.key('/zz')
  await new Promise(resolve => setTimeout(resolve, 60))
  const draft = m.editor()
  await m.dispose()
  release[0]?.(undefined as never)
  m.renderer.installCommandCompletions({
    commands: [{ name: 'model', description: 'Choose a model' }],
    cwd: '/work',
    fileReferences: null,
    scope: () => ({ kind: 'workspace', cwd: '/work' }),
    localCwd: () => '/work',
    skillReferences: [],
    hostShellCompletion: false,
  })
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(m.editor(), draft, 'the wire stopped moving with the mount')
  assert.deepEqual(m.calls.submits, [], 'a disposed mount submitted nothing')
})

// ── The pane without styled chrome ──────────────────────────────────────────

test('a pane without el and styles shows at most three plain text candidates above the one editor and stays keyboard-operable', async (t) => {
  const wide = Array.from({ length: 8 }, (_unused, index) => ({ name: `cmd${index}`, description: `d${index}` }))
  const m = await mountSlashPane(t, { chrome: false, commands: wide })
  await m.key('/cmd')
  await waitUntil('the plain text candidates painted', () => m.bareRows().length > 0)
  assert.equal(m.bareRows().length, 3, 'the bare fallback shows at most three rows')
  assert.equal(m.rows().length, 0, 'and it paints no styled button rows, because this pane cannot make one real')
  assert.equal(m.fields().length, 1, 'still exactly one input field')
  const painted = m.bareRows().map(node => m.rowText(node))
  assert.equal(painted.filter(text => text.startsWith('›')).length, 1,
    'exactly one bare line carries the highlight marker')
  assert.match(painted.find(text => text.startsWith('›')) ?? '', /\/cmd0/, 'the marked line is the default candidate')
  assert.deepEqual(painted.map(text => text.replace(/^[› ]/, '').split(' — ')[0]).sort(),
    ['/cmd0', '/cmd1', '/cmd2'].sort(), 'the first three candidates are the ones painted')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/cmd0 ', cursor: 6 }, 'Enter completes on the bare pane too')
  assert.deepEqual(m.calls.submits, [], 'and still never submits')
})

test('the window keeps the highlighted row visible when the list is longer than the popup', async (t) => {
  const many = Array.from({ length: 12 }, (_unused, index) => ({
    name: `aa${String(index).padStart(2, '0')}`,
    description: '',
  }))
  const m = await mountSlashPane(t, { chrome: true, commands: many })
  await m.key('/aa')
  await waitUntil('the windowed list painted', () => m.rows().length === 6)
  assert.equal(m.rows().length, 6, 'at most six rows are handed to the painter')
  for (let step = 0; step < 8; step += 1) await m.key(DOWN)
  const highlighted = m.highlighted()
  assert.equal(highlighted.length, 1, 'exactly one row carries the highlight')
  assert.equal(m.rows().some(node => node.id === highlighted[0]!.id), true,
    'the highlighted row stays inside the painted window after eight steps')
})
