/**
 * T3-B1: the Search card on the REAL SDK mount, and the canonical
 * `target → owner → current SDK Tree id → reveal` chain.
 *
 * Every case drives the production `mountTspRenderer` over the shipped
 * `@stencil-hq/tern` SDK and the scripted tty pane, and asserts on the WIRE:
 * the card's own reconciled nodes, the ONE controlled composer's props, the
 * `focus`/`reveal` ops the mount actually issued, and the bound handlers. A key
 * is delivered as raw terminal bytes and decoded by the SDK's own keyboard; a
 * click is a pane event addressed at the node id the SDK assigned in the
 * committed frame.
 *
 * The semantic-search binding here is a NARROW scripted double over a REAL
 * `TranscriptFolder` fed by real official SessionEvents: the Folder's own
 * `search()`/`resolveSearchMatch()`/`searchRevision()` are the production ones,
 * and the renderer's canonical-owner chain (`lastMainBlocks.owners` → the
 * `ContinuousMainJournal`'s attached id) is the production one. That is what
 * makes the reveal cases meaningful: the id sent on the wire is the id the SDK
 * derived for the block that really owns the matched message.
 *
 * The real `SurfaceRuntime` → selected Folder binding (Remote coverage, same-id
 * cold replacement, dispose) is `test/app/tern-tsp-semantic-search-surface.test.ts`.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-semantic-reveal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptSearchMatch } from '../../src/domain/transcript/search.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import type {
  TspTranscriptSemanticSearchBinding,
  TspTranscriptSemanticSearchSnapshot,
} from '../../src/app/surface/runtime.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { clickNodeById, foldWireNodes, surfaceFocusOps, surfaceTexts, wireNodes } from '../support/tsp-picker-wire.ts'

const T0 = 1_700_000_000_000
const OLD_ONLY = 'T3B1_OLD_ARCHIVE_ONLY'
const INNER_ONLY = 'T3B1_INNER_TOOL_ONLY'
const SHARED = 'T3B1_SHARED'
const WORKFLOW_MARKER = 'T3B1_WF_RUN_ONLY'
const WORKFLOW_MEMBER_MARKER = 'T3B1_WF_MEMBER_LABEL'

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

/** One official seed: an old user row, a Turn-2 tool whose long result body
 *  carries INNER_ONLY, a SHARED assistant answer and a later tail row. */
function seedFolder(): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  const turn = (n: number, userText: string, assistantText: string): void => {
    events.push(ev('turn/start', { turn: n }, seq++))
    events.push(ev('user/message', {
      id: MessageId(`t3b1-u-${n}`), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' },
    }, seq++))
    events.push(ev('step/start', { turn: n, step: 0 }, seq++))
    events.push(ev('assistant/message', {
      turn: n,
      step: 0,
      message: {
        id: MessageId(`t3b1-a-${n}`),
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        source: { kind: 'model', provider: 'scripted', model: 'scripted' },
      },
      stream: [],
    }, seq++))
    events.push(ev('step/end', { turn: n, step: 0 }, seq++))
    events.push(ev('turn/end', { turn: n, reason: { kind: 'completed' } }, seq++))
  }
  turn(1, `an old request that mentions ${OLD_ONLY}`, 'a plain answer')
  events.push(ev('turn/start', { turn: 2 }, seq++))
  events.push(ev('user/message', {
    id: MessageId('t3b1-u-2'), role: 'user', content: [{ type: 'text', text: 'read the example file' }], source: { kind: 'user' },
  }, seq++))
  events.push(ev('step/start', { turn: 2, step: 0 }, seq++))
  events.push(ev('tool/call', {
    turn: 2, step: 0, callId: ToolCallId('call-t3b1-inner'), name: 'read',
    arguments: JSON.stringify({ file_path: 'src/t3b1-inner.ts' }),
  }, seq++))
  events.push(ev('tool/result', {
    turn: 2,
    step: 0,
    message: {
      id: MessageId('t3b1-tool-2'),
      role: 'tool',
      toolCallId: ToolCallId('call-t3b1-inner'),
      content: [{ type: 'text', text: [
        '<path>src/t3b1-inner.ts</path>',
        '<content>',
        ...Array.from({ length: 12 }, (_, line) => `${line + 1}: inner line ${line + 1}`),
        `7: ${INNER_ONLY} sits inside this collapsed tool body`,
        ...Array.from({ length: 6 }, (_, line) => `${line + 14}: inner line ${line + 14}`),
        '</content>',
      ].join('\n') }],
      source: { kind: 'tool', callId: ToolCallId('call-t3b1-inner') },
    },
  }, seq++))
  events.push(ev('assistant/message', {
    turn: 2,
    step: 0,
    message: {
      id: MessageId('t3b1-a-2'),
      role: 'assistant',
      content: [{ type: 'text', text: `the answer carries ${SHARED}` }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted' },
    },
    stream: [],
  }, seq++))
  events.push(ev('step/end', { turn: 2, step: 0 }, seq++))
  events.push(ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, seq++))
  turn(3, 'a later request', `the later answer carries ${SHARED} again`)
  // Turn 4: ONE Workflow run whose member label carries the workflow marker. The
  // run starts fact-driven CLOSED, so the search grant is the only opener.
  events.push(ev('turn/start', { turn: 4 }, seq++))
  events.push(ev('user/message', {
    id: MessageId('t3b1-u-4'), role: 'user', content: [{ type: 'text', text: 'run the deployment workflow' }], source: { kind: 'user' },
  }, seq++))
  events.push(ev('tool-workflow/run-start', { runId: 'wf-b1', name: `deploy ${WORKFLOW_MARKER}` }, seq++))
  events.push(ev('tool-workflow/agent-start', {
    runId: 'wf-b1', seq: 1, label: `build ${WORKFLOW_MEMBER_MARKER}`, phase: 'Build', childId: 'child-b1-1',
  }, seq++))
  events.push(ev('tool-workflow/agent-end', { runId: 'wf-b1', seq: 1, outcome: 'completed' }, seq++))
  events.push(ev('tool-workflow/run-end', { runId: 'wf-b1', stopReason: 'completed' }, seq++))
  events.push(ev('step/start', { turn: 4, step: 0 }, seq++))
  events.push(ev('assistant/message', {
    turn: 4,
    step: 0,
    message: {
      id: MessageId('t3b1-a-4'),
      role: 'assistant',
      content: [{ type: 'text', text: 'the workflow finished' }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted' },
    },
    stream: [],
  }, seq++))
  events.push(ev('step/end', { turn: 4, step: 0 }, seq++))
  events.push(ev('turn/end', { turn: 4, reason: { kind: 'completed' } }, seq++))
  folder.apply(events)
  return folder
}

const SOURCE = { token: 'surface-source' }

/** The narrow production-shaped binding over the REAL Folder. */
function folderBinding(folder: TranscriptFolder): {
  readonly binding: TspTranscriptSemanticSearchBinding
  readonly state: { live: boolean; resolved: number }
} {
  const state = { live: true, resolved: 0 }
  const binding: TspTranscriptSemanticSearchBinding = {
    snapshot(query, refinement): TspTranscriptSemanticSearchSnapshot | undefined {
      if (!state.live) return undefined
      const matches = refinement === undefined || refinement.source !== SOURCE
        ? folder.search(query)
        : folder.search(query, {
            previousQuery: refinement.previousQuery,
            previousMatches: refinement.previousMatches,
            revision: refinement.revision,
          })
      return {
        source: SOURCE,
        subjectKind: 'main',
        subjectId: 'ses_b1',
        revision: folder.searchRevision(),
        matches,
        coverage: 'entire-session',
      }
    },
    resolve(source, match) {
      if (!state.live || source !== SOURCE) return undefined
      state.resolved += 1
      return folder.resolveSearchMatch(match)
    },
    current: (source) => state.live && source === SOURCE,
    revision: (source) => (state.live && source === SOURCE ? folder.searchRevision() : undefined),
  }
  return { binding, state }
}

interface RevealPane {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly folder: TranscriptFolder
  readonly bindingState: { live: boolean; resolved: number }
  readonly calls: { submits: number; cancels: number; exits: number; notes: number }
  cardPainted: () => boolean
  queryField: () => { text: string; cursor: number } | undefined
  texts: () => string[]
  composerNode: () => { text: string; cursor: number } | undefined
  focusOps: () => (string | null)[]
  revealOps: () => { id: string; at: string }[]
  key(bytes: string): void
  click(id: string): void
  painted(predicate: () => boolean, label: string): Promise<void>
  absent(): Promise<void>
}

const CTRL_C = '\u0003'
const ESCAPE = '\u001b'
const ENTER = '\r'
const ALT_SHIFT_S = '\u001b[115;4u'

async function mountSearchPane(
  t: { after(fn: () => unknown): void },
  options: {
    readonly transcriptSearch?: boolean
    readonly folder?: TranscriptFolder
    readonly cols?: number
    readonly nativeInteraction?: boolean
    /** The display preset this mount presents (the Focus cases need the real
     *  Focus projection, which is a display-state fact, never a renderer flag). */
    readonly preset?: 'full' | 'compact' | 'focus'
  } = {},
): Promise<RevealPane> {
  const pane = installTspPane({
    composerActions: true,
    ...(options.cols === undefined ? {} : { cols: options.cols }),
    ...(options.transcriptSearch === false ? {} : { transcriptSearch: true }),
    ...(options.nativeInteraction === true ? { nativeInteraction: true } : {}),
  })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects through the shipped SDK')
  const folder = options.folder ?? seedFolder()
  const scripted = folderBinding(folder)
  const calls = { submits: 0, cancels: 0, exits: 0, notes: 0 }
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => true,
    requestExit: () => { calls.exits += 1 },
    onFatal: (error) => { throw error },
    displayState: { preset: options.preset ?? 'full' },
  })
  t.after(() => renderer.dispose())
  if (options.transcriptSearch !== false) renderer.bindTranscriptSemanticSearch(scripted.binding)
  renderer.bindInput({
    exit: () => { calls.exits += 1 },
    cancel: () => { calls.cancels += 1 },
    submit: () => { calls.submits += 1 },
    steer: () => {},
    pasteMedia: () => {},
    pastedPath: () => {},
    selectPermission: () => {},
    admitPastedPathDelivery: () => true,
    shouldRememberInput: () => true,
    noteUserInput: () => { calls.notes += 1 },
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: () => {},
    openModelQuick: () => {},
    modelPickerAvailable: () => false,
    openSessionBrowser: () => {},
    sessionBrowserAvailable: () => false,
    openTasksBrowserUi() {},
    tasksBrowserUiAvailable: () => false,
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  // The ONE formal transcript commit: the REAL Folder's own messages.
  renderer.display.commitDisplaySubject({}, {}, undefined)
  renderer.display.setTranscript(folder.messages(), undefined, { mode: 'latest', hasNewer: false }, [], undefined, SOURCE)
  await waitUntil('the mount painted its composer editor',
    () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  // The Search entry appears in the frame the INPUT BIND commits (the bind is
  // what flips the admission), so the pane is ready only once that frame landed.
  if (options.transcriptSearch !== false) {
    await waitUntil('the mount painted its Search session entry',
      () => wireNodes(pane).some(node => node.id.includes('composer-search')))
  }

  return {
    pane,
    renderer,
    folder,
    bindingState: scripted.state,
    calls,
    // The LIVE folded frame, not the additive wire list: an `add` stays in the
  // history after its card left the frame.
  cardPainted: () => foldWireNodes(pane.frames()).some(node => String(node.id).includes('search-card')),
    queryField: () => {
      const node = wireNodes(pane).find(candidate => /-query$/.test(candidate.id) && candidate.id.includes('ss'))
      if (node === undefined) return undefined
      return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    },
    texts: () => surfaceTexts(pane, 's1'),
    composerNode: () => {
      const node = wireNodes(pane).find(candidate => candidate.id === 'dock.quiet-composer.composer')
      if (node === undefined) return undefined
      return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    },
    focusOps: () => surfaceFocusOps(pane, 's1'),
    revealOps: () => pane.frames()
      .flatMap(frame => frame.ops.filter(op => op[0] === 'reveal'))
      .map(op => ({ id: String(op[1]), at: String(op[2] ?? 'nearest') })),
    key(bytes: string) { pane.key(bytes) },
    click(id: string) { clickNodeById(pane, id) },
    async painted(predicate, label) { await waitUntil(label, predicate) },
    // reason: the absence contract is a bounded observation window — no later
    // reveal op, no painted card and no composer edit within the window.
    async absent() { await settle(120) },
  }
}

/** The raw key bytes for one printable character. */
const char = (value: string): string => value

// ── A. The mutually exclusive Dock ───────────────────────────────────────────

test('the Search card REPLACES the Composer node while open, and closing restores the SAME controller', async (t) => {
  const h = await mountSearchPane(t)
  // A non-empty draft and a mid-string caret: the state the card must not touch.
  h.key(char('h'))
  h.key(char('i'))
  await h.painted(() => h.composerNode()?.text === 'hi', 'the draft installed')
  const draftBefore = h.composerNode()
  assert.ok(draftBefore !== undefined)
  assert.equal(draftBefore.text, 'hi')

  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the search card painted')
  // The Composer is WITHDRAWN, not hidden: no editor node, no Send, no Search
  // session entry exists in the current frame at all.
  assert.equal(h.composerNode(), undefined, 'the Composer editor is not in the Dock while the card is open')
  const ids = wireNodes(h.pane).map(node => node.id)
  assert.equal(ids.some(id => id.includes('composer-send')), false, 'there is no Send while the card is open')
  assert.equal(ids.some(id => id.includes('composer-search')), false,
    'the Search-session entry is withdrawn with the shell it belongs to')
  assert.equal(ids.some(id => id.includes('composer-permission')), false,
    'the Permission control is withdrawn with the shell')

  // The card's own query field is the ONE editable input and owns the caret.
  const query = h.queryField()
  assert.ok(query !== undefined, 'the card carries exactly one query field')
  assert.equal(query.text, '', 'the card opens with an empty query')
  const focus = h.focusOps().at(-1)
  assert.ok(typeof focus === 'string' && focus.includes('-query'),
    `the caret is on the card's query field: ${String(focus)}`)

  // Escape restores the ORIGINAL controller: the same draft and caret.
  h.key(ESCAPE)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  const restored = h.composerNode()
  assert.equal(restored?.text, 'hi', 'the draft survives the search round trip')
  assert.equal(restored?.cursor, draftBefore.cursor, 'the caret is the one the user left')
  assert.equal(h.cardPainted(), false, 'the card is gone')
  assert.equal(h.calls.submits, 0, 'no search gesture ever submitted')
})

test('a pane without the negotiated capability paints NO Search entry and states the truth on the chord', async (t) => {
  const h = await mountSearchPane(t, { transcriptSearch: false })
  const ids = wireNodes(h.pane).map(node => node.id)
  assert.equal(ids.some(id => id.includes('composer-search')), false,
    'a pane that cannot paint the card carries no search entry at all')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.texts().some(text => text.includes('Session Search unavailable')),
    'the unavailable statement')
  assert.equal(h.cardPainted(), false, 'no fake card was opened')
})

test('the Status/Footer owner stays painted while the Search card owns the Dock', async (t) => {
  const h = await mountSearchPane(t)
  // A real status commit gives the footer rows content.
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.painted(() => wireNodes(h.pane).some(node => node.id === 'dock.footer-group'), 'the footer painted')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  assert.equal(wireNodes(h.pane).some(node => node.id === 'dock.footer-group'), true,
    'the SAME footer owner is still in the search-open frame')
})

test('a NARROW pane carries exactly ONE Send (the actions move to their own row)', async (t) => {
  // 44 cols < the narrow threshold (56): the narrow branch is the ONE honest
  // way to test the re-arranged action row.
  const h = await mountSearchPane(t, { cols: 44 })
  const ids = wireNodes(h.pane).map(node => node.id)
  assert.equal(ids.filter(id => id.includes('composer-send')).length, 1,
    `exactly ONE Send on a narrow pane :: ${JSON.stringify(ids.filter(id => id.includes('composer')))}`)
  assert.equal(ids.filter(id => id.includes('composer-stop')).length <= 1, true)
  // The actions row exists and the controls row keeps only Permission/Model.
  assert.equal(ids.some(id => id.includes('composer-actions-narrow')), true,
    'the narrow action row is present')
})

test('the Quiet Composer carries ONE Send and ONE Search session entry, never a second Send', async (t) => {
  const h = await mountSearchPane(t)
  const ids = wireNodes(h.pane).map(node => node.id)
  assert.equal(ids.filter(id => id.includes('composer-send')).length, 1,
    `exactly one Send button: ${JSON.stringify(ids.filter(id => id.includes('composer')))}`)
  assert.equal(ids.filter(id => id.includes('composer-search')).length, 1,
    `exactly one Search session entry :: ${JSON.stringify(ids.filter(id => id.includes('composer')))}`)
  // The click runs the SAME entry the chord runs.
  const entry = wireNodes(h.pane).find(node => node.id.includes('composer-search'))
  assert.ok(entry !== undefined)
  h.click(entry.id)
  await h.painted(() => h.cardPainted(), 'the card opened from the button')
  assert.equal(h.queryField() !== undefined, true)
})

// ── B. Query, targets and the canonical reveal ───────────────────────────────

test('the card searches the REAL Folder and reveals the canonical card of the current target', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === INNER_ONLY.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('1/1 targets')), 'one representative target')
  assert.equal(h.texts().some(text => text.includes('Source-only · position unverified · Tool result')), true,
    `the card states the card-level Source-only fact with the static source kind :: ${JSON.stringify(h.texts())}`)

  h.key(ENTER)
  await h.painted(() => h.revealOps().length > 0, 'the reveal op')
  const reveal = h.revealOps().at(-1)
  assert.ok(reveal !== undefined)
  assert.equal(reveal.at, 'nearest')
  // The revealed id must be the SDK's OWN id for the block that owns the matched
  // message — a Main root, never a synthesized `msg-<id>` path.
  // The SDK derives a top-level Main child's id from the region it was added to:
  // `main.<block key>`. The block key carries the frame's scope prefix, so the id
  // is `<scope>msg-<n>` under `main.`.
  assert.match(reveal.id, /^main\..*msg-\d+$/u, `the reveal names a Main root id: ${reveal.id}`)
  assert.equal(h.bindingState.resolved > 0, true, 'the binding resolved the representative message')
})

test('a hit inside a FOLDED tool body still finds the owning Main card (Source-only, never a fake Exact)', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of 'inner_tool_only') h.key(char(ch))
  await h.painted(() => h.texts().some(text => text.includes('targets')), 'a settled result')
  // The seed's marker is inside the collapsed tool body: the Folder owns it even
  // though the painted Main document does not show it.
  assert.equal(h.texts().some(text => text.includes('Exact')), false,
    'the card never claims a character-exact position')
  assert.equal(h.texts().some(text => text.includes('Source-only')), true,
    'the card states the card-level Source-only fact')
})

test('the empty query is the frozen 0-target state and Next never sends a reveal', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  assert.equal(h.texts().some(text => text.includes('0/0 targets')), true, 'an empty query has no targets')
  const before = h.revealOps().length
  h.key(ENTER)
  await h.absent()
  assert.equal(h.revealOps().length, before, 'no target means no reveal op')
})

test('a zero-match query paints the count and stays inert', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of 'zzzznomatch') h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === 'zzzznomatch', 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('0/0 targets')), 'zero targets')
  assert.equal(h.texts().some(text => text.includes('No matches in the loaded session')), true,
    `texts=${JSON.stringify(h.texts())}`)
  const before = h.revealOps().length
  h.key(ENTER)
  await h.absent()
  assert.equal(h.revealOps().length, before, 'a zero-match Next sends nothing')
})

// ── C. Key ownership: nothing reaches the hidden Composer ────────────────────

test('every printable key, Enter and paste is consumed by the card and never edits or submits the draft', async (t) => {
  const h = await mountSearchPane(t)
  h.key(char('k'))
  await h.painted(() => h.composerNode()?.text === 'k', 'the draft installed')
  const notesBefore = h.calls.notes
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of 'abc') h.key(char(ch))
  h.key(ENTER)
  h.key('\u0016') // Ctrl+V
  h.key('\u0004') // Ctrl+D
  await h.absent()
  assert.equal(h.queryField()?.text, 'abc', 'the card received the printable keys')
  assert.equal(h.calls.submits, 0, 'Enter never submitted the hidden draft')
  assert.equal(h.calls.notes, notesBefore, 'the card consumed the keys before any user-input note')
  h.key(ESCAPE)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  assert.equal(h.composerNode()?.text, 'k', 'the draft is exactly what the user left')
})

test('Ctrl+C retires the card FIRST and then reaches the cancel owner exactly once', async (t) => {
  const h = await mountSearchPane(t)
  h.key(char('c'))
  await h.painted(() => h.composerNode()?.text === 'c', 'the draft installed')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  h.key(CTRL_C)
  await h.painted(() => h.cardPainted() === false, 'the card retired')
  assert.equal(h.composerNode()?.text, 'c', 'the draft was never touched by the interrupt')
  assert.equal(h.calls.cancels, 1, 'the cancel intent reached its owner exactly once')
  assert.equal(h.calls.exits, 0, 'Ctrl+C is never an exit')
})

// ── D. Temporary disclosure grants ───────────────────────────────────────────

test('a hit inside a folded tool body opens ONLY that card, and closing the search restores the manual state', async (t) => {
  const h = await mountSearchPane(t)
  // Before the search the tool body's inner text is NOT in the painted Main.
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false,
    'the seed really keeps the tool body folded before any search')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === INNER_ONLY.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('1/1 targets')), 'one target')
  h.key(ENTER)
  // The grant opens the OWNING tool card in the Main projection: the folded body
  // text becomes readable WITHOUT a fake toggle event and WITHOUT the user
  // having expanded anything by hand.
  await h.painted(() => h.texts().some(text => text.includes(INNER_ONLY)),
    `the temporary grant opened the owning tool body :: ${JSON.stringify(h.texts().slice(-6))}`)
  h.key(ESCAPE)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  // Closing the search RETRACTS the temporary grant: the body is folded again and
  // no manual preference was written.
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false,
    'the search-only grant never became a manual disclosure choice')
})

test('a passive repaint never grants disclosure; only an explicit navigation does', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  // An empty query has no target, so no grant exists.
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false)
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.absent()
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false,
    'a passive repaint never opens a folded card')
})

test('a hit on a workflow member label opens the run and that phase for the CURRENT target only', async (t) => {
  const h = await mountSearchPane(t)
  // Before the search the workflow run is presented fact-driven CLOSED (all
  // members settled = clean), so the member label is not readable in Main.
  assert.equal(h.texts().some(text => text.includes(WORKFLOW_MEMBER_MARKER)), false,
    'the seed really keeps the workflow run folded before any search')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of WORKFLOW_MEMBER_MARKER.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === WORKFLOW_MEMBER_MARKER.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'one target')
  h.key(ENTER)
  // The grant opens the run and the phase for THIS frame: the member label is
  // readable, and the manual workflowDisclosureStates were never written.
  await h.painted(() => h.texts().some(text => text.includes(WORKFLOW_MEMBER_MARKER)),
    `the temporary grant opened the workflow run :: ${JSON.stringify(h.texts().slice(-6))}`)
  h.key(ESCAPE)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  assert.equal(h.texts().some(text => text.includes(WORKFLOW_MEMBER_MARKER)), false,
    'closing the search retracts the workflow grant (the manual state is untouched)')
})

test('the Tab ring survives a repaint: the caret is not pulled back to the query', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  h.key('\t')
  await h.absent()
  const afterTab = h.focusOps().at(-1)
  assert.ok(typeof afterTab === 'string' && !afterTab.includes('-query'),
    `Tab moved the caret off the query field :: ${String(afterTab)}`)
  // Any status/revision repaint must NOT pull the caret back to the query.
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.absent()
  const afterRepaint = h.focusOps().at(-1)
  assert.equal(afterRepaint, afterTab,
    `the ring survived the repaint :: ${String(afterRepaint)}`)
})

test('the Tasks footer action is NOT advertised while the Search card owns the Dock', async (t) => {
  // The Tasks action needs the picker + Reader capabilities AND the real bound
  // business entry: this is the ONE honest way to paint it at all.
  const pane = installTspPane({
    composerActions: true,
    transcriptSearch: true,
    workDetails: true,
    modelPicker: true,
  })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const folder = seedFolder()
  const scripted = folderBinding(folder)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => true,
    requestExit: () => {},
    onFatal: (error) => { throw error },
    displayState: { preset: 'full' },
  })
  t.after(() => renderer.dispose())
  renderer.bindTranscriptSemanticSearch(scripted.binding)
  renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {},
    pasteMedia: () => {}, pastedPath: () => {}, selectPermission: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput: () => {}, listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false, openModelPicker: () => {},
    openModelQuick: () => {}, modelPickerAvailable: () => false,
    openSessionBrowser: () => {}, sessionBrowserAvailable: () => false,
    openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
  })
  // The Tasks segment renders only with a REAL task fact, so the positive
  // control needs a live task count in the committed status.
  const tasksStatus = {
    ...emptyStatusSnapshot(),
    activity: { ...emptyStatusSnapshot().activity, taskCount: 1 },
  }
  renderer.bindStatusReader({ snapshot: () => tasksStatus })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  renderer.display.setTranscript(folder.messages(), undefined, { mode: 'latest', hasNewer: false }, [], undefined, SOURCE)
  await waitUntil('the composer painted', () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  // reason: the transcript/status frames land only when the pane's ack returns
  // credit, so the observation window lets that async ack flush the frames.
  await settle(300)
  // The Tasks action rides a segment's `actions` OBJECT ({click: act}), not an
  // array: serialize whatever the node carries so the assertion reads the real
  // wire shape.
  const actionsOf = () => wireNodes(pane)
    .map(node => JSON.stringify(node.p['actions'] ?? ''))
    .filter(text => text.includes('dsh.footer.tasks'))
  // The closed frame DOES advertise the Tasks action (the positive control).
  assert.equal(actionsOf().some(act => act.includes('tasks')), true,
    'the closed frame carries the Tasks action')
  await pane.key(ALT_SHIFT_S)
  await waitUntil('the card painted', () => wireNodes(pane).some(node => node.id.includes('search-card')))
  assert.equal(actionsOf().some(act => act.includes('tasks')), false,
    'the search-open frame paints NO Tasks click affordance')
})

test('a higher seat RETIRES the card: closing it does not bring the old search back', async (t) => {
  const h = await mountSearchPane(t, { nativeInteraction: true })
  h.key(char('q'))
  await h.painted(() => h.composerNode()?.text === 'q', 'the draft installed')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  // The REAL higher-seat acquisition: the production interaction presenter
  // presents an official Question form, which IS the modal seat.
  // A REPRESENTABLE question (the presenter refuses a payload it cannot paint).
  const asked = h.renderer.interaction.askQuestions(
    [{ id: 'q-1', question: 'Proceed?', options: [{ label: 'Yes' }] }] as never,
    undefined,
    undefined,
    false,
  )
  // The prompt is a modal: the seat retires instead of parking behind it.
  asked.catch(() => {})
  await h.absent()
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.absent()
  assert.equal(h.cardPainted(), false, 'the card is not painted while the modal owns the input')
  // A repaint after the higher seat settles must NOT resurrect the old search:
  // the seat was RETIRED, not parked.
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.absent()
  assert.equal(h.cardPainted(), false, 'the retired card never comes back')
  assert.equal(h.queryField(), undefined, 'the old query field is gone')
  assert.equal(h.composerNode()?.text, 'q', 'the draft was never touched')
})

test('closing the search retracts the grant: the body folds again and no manual state was written', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === INNER_ONLY.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'one target')
  h.key(ENTER)
  await h.painted(() => h.texts().some(text => text.includes(INNER_ONLY)),
    'the grant opened the owning tool card')
  // Escape closes the card; the SAME frame must retract the grant.
  h.key(ESCAPE)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false,
    `the grant is retracted with the card :: ${JSON.stringify(h.texts().slice(-4))}`)
  // Re-opening starts a NEW navigation epoch whose grant opens it again: the
  // manual state was never written, so nothing was "remembered" as collapsed.
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted again')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'the target again')
  h.key(ENTER)
  await h.painted(() => h.texts().some(text => text.includes(INNER_ONLY)),
    'a fresh navigation grants again (the manual set was never polluted)')
})

test('a gone root invalidates the target reachability: the card says Unavailable, never a stale claim', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === INNER_ONLY.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'one target')
  h.key(ENTER)
  await h.painted(() => h.revealOps().length > 0, 'the reveal op for the current target')
  await h.painted(() => h.texts().some(text => text.includes('Source-only · position unverified')),
    'the reachable target states the card-level claim')
  // The REAL client `gone` for the revealed root.
  const sf = h.pane.frames().at(-1)!.sf
  const revealedId = h.revealOps().at(-1)?.id
  assert.ok(revealedId !== undefined)
  h.pane.event({ ev: 'gone', sf, ids: [revealedId], raw: {} })
  await h.painted(() => h.texts().some(text => text.includes('Unavailable in current pane')),
    `the evicted root is reported honestly :: ${JSON.stringify(h.texts().slice(-5))}`)
  // RFL-016: an UNRELATED root's eviction must NOT poison the current target.
  // (The target's own root was evicted above; re-open a fresh card to test the
  // unrelated case on a live, reachable target.)
  // No stale-id reveal follows the eviction.
  const revealsAfterGone = h.revealOps().length
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.absent()
  assert.equal(h.revealOps().length, revealsAfterGone,
    'a passive repaint after gone never sends a stale-id reveal')
})

test('an UNRELATED root eviction leaves the current target reachable (no false Unavailable)', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of INNER_ONLY.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === INNER_ONLY.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'one target')
  h.key(ENTER)
  await h.painted(() => h.revealOps().length > 0, 'the reveal op')
  const targetRoot = h.revealOps().at(-1)!.id
  // The client evicts a DIFFERENT root (a real id from another Main block).
  const otherRoot = h.pane.frames()
    .flatMap(frame => frame.ops)
    .filter(op => op[0] === 'add' && typeof op[1] === 'string'
      && String(op[1]).startsWith('main.') && op[1] !== targetRoot)
    .map(op => String(op[1]))
    .at(0)
  assert.ok(otherRoot !== undefined && otherRoot !== targetRoot, 'a different Main root exists')
  const sf = h.pane.frames().at(-1)!.sf
  h.pane.event({ ev: 'gone', sf, ids: [otherRoot], raw: {} })
  await h.absent()
  // The CURRENT target's root is still attached: the card must keep the
  // card-level claim instead of claiming the target is unavailable.
  assert.equal(h.texts().some(text => text.includes('Unavailable in current pane')), false,
    `an unrelated eviction never poisons the target :: ${JSON.stringify(h.texts().slice(-5))}`)
})

test('a VISIBLE prompt row hit opens NO Thought (the row never lived inside it)', async (t) => {
  const h = await mountSearchPane(t, { preset: 'focus' })
  // The prompt row is visible in Focus OUTSIDE the Thought: its own turn's
  // Thought is folded and must stay folded when the prompt is the target.
  const promptMarker = 'read the example file'
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of promptMarker) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === promptMarker, 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('/1 targets')), 'one target')
  // The visible prompt row is already readable; no Thought grant may add the
  // hidden process (the tool body) on top of it.
  assert.equal(h.texts().some(text => text.includes(INNER_ONLY)), false,
    `a visible-row hit never opens unrelated Process :: ${JSON.stringify(h.texts().slice(-5))}`)
})

// ── E. Currentness: a dead source retires the card ───────────────────────────

test('a source that stops being current retires the card and restores the Composer', async (t) => {
  const h = await mountSearchPane(t)
  h.key(char('d'))
  await h.painted(() => h.composerNode()?.text === 'd', 'the draft installed')
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  h.bindingState.live = false
  // A repaint after the source died must not keep painting an operable card.
  h.renderer.display.commitDisplaySubject({}, {}, undefined)
  await h.painted(() => h.composerNode() !== undefined, 'the Composer restored')
  assert.equal(h.cardPainted(), false, 'the card is gone')
  assert.equal(h.composerNode()?.text, 'd', 'the draft was never touched')
})

test('a reveal is never sent for a target whose source died after the query', async (t) => {
  const h = await mountSearchPane(t)
  h.key(ALT_SHIFT_S)
  await h.painted(() => h.cardPainted(), 'the card painted')
  for (const ch of SHARED.toLowerCase()) h.key(char(ch))
  await h.painted(() => (h.queryField()?.text ?? '') === SHARED.toLowerCase(), 'the query installed')
  await h.painted(() => h.texts().some(text => text.includes('1/2 targets')),
    `two representative cards with the first current :: ${JSON.stringify(h.texts().slice(-6))}`)
  const before = h.revealOps().length
  h.bindingState.live = false
  h.key(ENTER)
  await h.absent()
  assert.equal(h.revealOps().length, before, 'no reveal op is sent for a dead source')
})
