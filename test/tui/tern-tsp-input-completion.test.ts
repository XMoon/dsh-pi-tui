/**
 * The TSP input-completion seat on the REAL SDK mount.
 *
 * Every case drives the production `mountTspRenderer` over the scripted tty pane
 * and the shipped `@stencil-hq/tern` SDK: the catalog arrives through the
 * mount's own install port (the same call the command layer's single commit
 * point makes), the key the composer sees is the SDK's OWN decoded `Key`, and
 * the assertion reads the reconciled wire — the ONE dock editor's controlled
 * `text`/UTF-16 `cursor`, the candidate rows of the anchored list, and the exact
 * number of application callbacks the mount made.
 *
 * The seat is ONE list with five positions decided by the SAME classifiers the
 * shared Provider uses: a first-line leading `/command` (I-C), a Host `@`
 * mention, a first-line leading `/image`/`/attach` path argument, a body
 * inline path argument, and the body inline `/action`/`/skill` reference. This
 * file proves the mount-level behaviour of those seats — which rows paint, what
 * one accept writes, and that accepting never reads, stages or submits — not
 * the command plane's intake (`test/app/**`/`test/integration/**`).
 *
 * EVIDENCE LEVEL: SDK mount + wire. STANDS-IN: the scripted pane is not a
 * physical Tern client (that lane is `scripts/tern-pane-input-completion-ux.mjs`
 * and `scripts/tern-gui-input-completion.mjs`); the application above the mount
 * is the renderer's own bound input handlers, not the `SurfaceRuntime` — the
 * real catalog provenance, the real `SubmissionController`, the real stager
 * installation and the real extension registry are
 * `test/app/tern-tsp-input-completion-composition.test.ts`.
 *
 * Seat priority proves ONE fact per seat here: while a higher owner holds the
 * keys, no arrow reaches the completion list. Each seat's own navigation stays
 * with its own suite (`tern-tsp-permission-composer`,
 * `tern-tsp-model-quick-menu`, `tern-tsp-session-browser`,
 * `tern-tsp-model-picker`, `tern-tsp-preset-picker`, `tern-tsp-work-hub`).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-input-completion.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import type { HumanSkillSummary } from '../../src/domain/catalog/skill.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type {
  TspCommandCompletionInstallation,
  TspInlineAttachmentStake,
} from '../../src/app/surface/runtime.ts'
import type {
  HostFileListResult,
  HostFilePort,
  HostFileScope,
} from '../../src/runtime/host-file-port.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
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
const LEFT = `${ESCAPE}[D`
const CTRL_V = String.fromCharCode(22)
// kitty CSI-u: 'v' (118) with the Alt modifier (3).
const ALT_V = `${ESCAPE}[118;3u`
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
  /** Step the caret LEFT by graphemes and wait for the caret / frame it painted. */
  caretLeft(steps: number, expected?: number): Promise<void>
  /** The mount's OWN render counter: every `render()` pushes exactly one frame
   *  to the scripted pane, so a frame delta IS the real render call count that
   *  §7.1 demands (the final wire diff alone cannot prove exactly-once). */
  frameCount(): number
  /** The candidate rows as painted AT the first `count` frames. */
  rowsThrough(count: number): WireNode[]
  /** The composer text/caret as painted AT the first `count` frames. */
  editorThrough(count: number): { text: string; cursor: number }
  click(node: WireNode, writes?: boolean): Promise<void>
  commitStatus(snapshot: StatusSnapshot): Promise<void>
  dispose(): Promise<void>
}

interface MountOptions {
  /** Negotiate `el` + `styles` so the Quiet Composer shell (and its popup) mounts. */
  readonly chrome?: boolean
  readonly commands?: TspCommandCompletionInstallation['commands']
  /** A Host-file port that COUNTS every call (the no-file-probe witness). */
  readonly countingHostFile?: boolean
  /** A scripted Host-file port (the positive `@` authority). */
  readonly fileReferences?: HostFilePort | null
  /** The Client-local completion base (a real temp directory when a case needs
   *  real local files; the mount uses the bounded no-finder fallback). */
  readonly localCwd?: string
  /** The detached inline skill catalog the body `/name` seat reads. */
  readonly skillReferences?: readonly HumanSkillSummary[]
  readonly extensionSuggest?: TspCommandCompletionInstallation['extensionSuggest']
}

/** One scripted Host-file port plus the queries it really answered. */
interface ScriptedHostFile {
  readonly port: HostFilePort
  readonly queries: Array<{ readonly scope: HostFileScope; readonly query: string }>
  /** EVERY port method this mount was asked to call (the witness that a seat
   *  which must not reach the Host really never reaches it). */
  readonly calls: () => number
}

/** A Host-file port that answers exactly what the case scripts (an
 *  authoritative `ok` list, an empty `ok`, or `unavailable`) and records every
 *  `listReferences` query it receives. */
function scriptedHostFilePort(
  answer: HostFileListResult | ((query: string) => HostFileListResult),
): ScriptedHostFile {
  const queries: Array<{ readonly scope: HostFileScope; readonly query: string }> = []
  let calls = 0
  return {
    queries,
    calls: () => calls,
    port: {
      async listReferences (scope, query) {
        calls += 1
        queries.push({ scope, query })
        return typeof answer === 'function' ? answer(query) : answer
      },
      async resolveReference () {
        calls += 1
        return { kind: 'unavailable', reason: 'the scripted port never probes existence' }
      },
      async canonicalizeMentions (_scope, text) {
        calls += 1
        return text
      },
    },
  }
}

/** The dotted row a positive control MUST see. A candidate VALUE with a dot is
 *  exactly what a `…\.completion-[^.]+$`-style row filter silently misses (the
 *  key sanitizer keeps `.`), so every "no row painted" claim in this file is
 *  preceded by a control that paints this row through the SAME addressing. */
const DOTTED_HOST_ROW = '›@src/deep.ts'
const DOTTED_HOST_ITEMS: HostFileListResult = {
  kind: 'ok',
  items: [{ path: 'src/deep.ts', kind: 'file' }],
}

/** A real Client-local completion base in a test-owned temp directory. A
 *  directory entry ends with `/`; everything else is a file with fixture
 *  content. The cleanup is owned by `testLifecycle`, never by this file. */
function localWorkspace(t: TestContext, entries: readonly string[]): string {
  const root = testLifecycle(t).tempDir('dsh-tsp-id-local-')
  for (const entry of entries) {
    const full = join(root, entry)
    if (entry.endsWith('/')) {
      mkdirSync(full, { recursive: true })
      continue
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, 'fixture')
  }
  return root
}

/** One recorded stager call: the immutable stake and the wire document the
 *  mount had committed at the moment it reached the command plane. */
interface StagedStake {
  readonly stake: TspInlineAttachmentStake
  readonly wire: { text: string; cursor: number }
}

/** Install the mount's ONE inline-attachment stager and record its calls. */
function captureStager(m: { readonly renderer: TspRenderer; editor(): { text: string; cursor: number } }): StagedStake[] {
  const staged: StagedStake[] = []
  m.renderer.installInlineAttachmentStager((stake) => {
    staged.push({ stake, wire: m.editor() })
  })
  return staged
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
  const hostFile = options.fileReferences !== undefined
    ? options.fileReferences
    : options.countingHostFile === true
      ? countingHostFilePort(() => { hostFileCalls += 1 })
      : null
  const localCwd = options.localCwd ?? '/work'
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
      localCwd: () => localCwd,
      skillReferences: options.skillReferences ?? [],
      hostShellCompletion: undefined,
      ...(options.extensionSuggest === undefined ? {} : { extensionSuggest: options.extensionSuggest }),
      ...overrides,
    })
  }
  install()

  const nodes = (): WireNode[] => wireNodes(pane)
  /** The live node set folded through the FIRST `count` frames — the painted
   *  state AT a frame, which is what makes a render count observable rather than
   *  inferred from the final wire diff. */
  const nodesThrough = (count: number): WireNode[] => wireNodes({ frames: () => pane.frames().slice(0, count) })
  // A candidate ROW is the `el` button the popup paints; its name/description
  // are CHILD `el` nodes addressed under it (`….0`, `….1`). The row key's last
  // path segment starts with `completion-`, but its VALUE keeps dots (a real
  // file name such as `src/deep.ts` survives the key sanitizer), so a filter
  // anchored on "no dot after the prefix" silently matches NOTHING and every
  // absence assertion becomes vacuous. A row is therefore the OUTERMOST
  // completion `el` under the live popup: a child is excluded because its id
  // starts with its row's id plus `.`.
  const rowsIn = (list: WireNode[]): WireNode[] => {
    const candidateEls = list.filter(node => node.k === 'el' && node.id.includes('.completion-'))
    return candidateEls.filter(node => !candidateEls.some(other => other.id !== node.id
      && node.id.startsWith(`${other.id}.`)))
  }
  const rowNodes = (): WireNode[] => rowsIn(nodes())
  const composerThrough = (count: number): { text: string; cursor: number } => {
    const node = nodesThrough(count).find(candidate => candidate.id === composerId)
    return { text: String(node?.p.text ?? ''), cursor: Number(node?.p.cursor ?? 0) }
  }
  const bareRowNodes = (): WireNode[] => nodes().filter(node => node.k === 'text'
    && /completion-bare-/.test(node.id))
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
    frameCount: () => pane.frameCount(),
    rowsThrough: (count) => rowsIn(nodesThrough(count)),
    editorThrough: composerThrough,
    async caretLeft(steps, expected) {
      await m.key(LEFT.repeat(steps))
      if (expected !== undefined) {
        await waitUntil(`the caret parked at ${expected}`, () => m.editor().cursor === expected)
      }
    },
    async click(node, writes = false) {
      const mark = pane.frameCount()
      pane.event({ ev: 'action', sf: pane.frames().at(-1)?.sf, id: node.id, act: 'click' })
      if (writes) {
        await waitUntil('the click painted its frame', () => pane.frameCount() > mark)
        return
      }
      // reason: bounded absence window — a refused click writes no frame, so the
      // only observation available is that the wire stopped moving.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    commitStatus: async (snapshot) => {
      const mark = pane.frameCount()
      status = snapshot
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the committed status painted its frame', () => pane.frameCount() > mark)
    },
    dispose: () => renderer.dispose(),
  }
  return m
}

// ── The natural query and the accept-only rule ───────────────────────────────

test('a caret partway through a longer token completes it instead of submitting the half-typed command', async (t) => {
  const m = await mountSlashPane(t, { chrome: true, commands: [{ name: 'new', description: 'Create a session' }] })
  // `/newbie` with the caret parked after `/new` — the shape of editing a token
  // in place. The candidate `/new` matches the before-caret text exactly, so an
  // implementation that reads that as "already complete" gives Enter to the
  // submit path and runs a command the user never finished typing.
  await m.type('/newbie')
  for (let step = 0; step < 3; step += 1) await m.key(LEFT)
  await m.key(TAB)
  await waitUntil('the token-under-caret list painted', () => m.rows().length > 0)
  await m.key(ENTER)
  // The shared provider replaces the token PREFIX it was given and keeps the
  // rest of the line, so the completed draft is `/new bie` — the point of the
  // case is that the half-typed `/newbie` was never EXECUTED.
  assert.deepEqual(m.editor(), { text: '/new bie', cursor: 5 },
    'the provider separator lands the caret before the untouched tail')
  assert.deepEqual(m.calls.submits, [], 'Enter on an open list is never a submission')
  assert.equal(m.rows().length, 0, 'the list is gone after the accept gesture')
  // The user's NEXT Enter is the explicit submit, carrying the live draft.
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [{ text: '/new bie', gesture: 'enter' }],
    'only the later Enter submits, and it submits the completed draft')
})

test('an answer whose replacement reaches outside the command token is refused without touching indentation or the tail', async (t) => {
  // The plugin chain is a real extension point and may hand back an arbitrary
  // `prefix`. One computed on the WIRE-ish indentation would, if applied, drop
  // the leading spaces and the `/` — so the accept layer must refuse it.
  const answers: Array<{ prefix: string; value: string }> = [
    { prefix: '  /z', value: 'xyz' },
    { prefix: '/z', value: 'zoom' },
  ]
  let call = 0
  let pluginAsked = 0
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    extensionSuggest: async () => {
      const answer = answers[Math.min(call, answers.length - 1)]
      call += 1
      return { items: [{ value: answer.value, label: answer.value }], prefix: answer.prefix }
    },
  })
  await m.type('  /z')
  await m.key(TAB)
  await waitUntil('the indented-token answer painted', () => m.rows().length > 0)
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '  /z', cursor: 4 },
    'the out-of-token replacement wrote nothing: the indentation and the slash survive')
  assert.deepEqual(m.calls.submits, [], 'a refused completion never becomes a submission')
  // Positive control: the SAME chain with a well-formed command prefix DOES
  // complete, so the guard above is a token rule and not a blanket refusal.
  await m.type('  /z')
  call = 1
  await m.key(TAB)
  await waitUntil('the well-formed answer painted again', () => m.rows().length > 0)
  await m.key(ENTER)
  assert.equal(m.editor().text.startsWith('  /zoom '), true,
    'a prefix inside the token still completes, keeping the indentation intact')
  assert.deepEqual(m.calls.submits, [], 'and completing still submitted nothing')
})

test('a failed catalog synthesis closes the seat so no plugin answer can revive the menu', async (t) => {
  let pluginAsked = 0
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [{ name: 'model', description: 'Choose a model' }],
    extensionSuggest: async () => {
      pluginAsked += 1
      return { items: [{ value: 'revived', label: 'revived' }], prefix: '/rev' }
    },
  })
  // CONTROL first: the plugin chain really is reachable for this seat when the
  // catalog has no answer, so the negative below cannot be a vacuous green.
  await m.type('/re')
  await m.key('v')
  await waitUntil('the plugin fallback painted', () => m.rows().length > 0)
  assert.equal(pluginAsked > 0, true, 'the plugin chain was consulted for an unmatched token')
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/revived'])

  // The collision state: the command layer withdraws every candidate AND marks
  // the source failed. The seat must then ask NOTHING — plugin fallback
  // included — so a known-bad command source cannot come back as a menu.
  pluginAsked = 0
  m.install({ commands: [], sourceFailed: true })
  await m.type('/re')
  await m.key('v')
  await m.quietKey(TAB)
  assert.equal(m.rows().length, 0, 'a failed source offers no candidates, plugin answer or not')
  assert.equal(pluginAsked, 0, 'and the plugin chain is not even consulted')
  assert.deepEqual(m.calls.submits, [], 'nothing was submitted by any of it')

  // A later successful commit reopens the same seat on the real catalog.
  m.install({ commands: [{ name: 'model', description: 'Choose a model' }] })
  await m.type('/mo')
  await m.key('d')
  await waitUntil('the recovered source paints', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/modelChoose a model'],
    'the recovered catalog is the source again')
})

test('a candidate the composer refuses to write still clears the painted list, so Escape stays Escape', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    // A plugin may hand back ANY text as a candidate value. This one carries a
    // line break: the accept layer's token check passes (the tail after the
    // token survives), and the composer then correctly refuses a change that
    // crosses a line. The seat must not treat that planned write as a committed
    // one, or the withdrawn list stays painted and the next Escape hits Cancel.
    extensionSuggest: async () => ({
      items: [{ value: 'x\ny', label: 'x' }],
      prefix: '/z',
    }),
  })
  await m.type('/z\nsecond')
  for (let step = 0; step < 7; step += 1) await m.key(LEFT)
  await m.key(TAB)
  await waitUntil('the plugin candidate painted', () => m.rows().length > 0)
  assert.deepEqual(m.editor(), { text: '/z\nsecond', cursor: 2 }, 'the caret sits at the end of the command token')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/z\nsecond', cursor: 2 }, 'the cross-line candidate wrote nothing')
  assert.deepEqual(m.calls.submits, [], 'a refused accept never became a submission')
  assert.equal(m.rows().length, 0, 'the dismissed list is off the wire, not left painted')
  await m.quietKey(ESCAPE)
  assert.equal(m.calls.cancels, 1, 'so the next Escape reaches its original cancel owner')
})

test('a tab-separated argument position is not a command-name seat, even for a plugin answer', async (t) => {
  let asked = 0
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    extensionSuggest: async () => {
      asked += 1
      return { items: [{ value: 'revived', label: 'revived' }], prefix: '/new\targ' }
    },
  })
  // `/new<TAB>argument`: the token ended at the tab, so this is an argument
  // position, which I-C never completes.
  await m.type('/new\targument')
  await m.quietKey(TAB)
  assert.equal(m.rows().length, 0, 'a tab-separated tail opens no command-name list')
  assert.equal(asked, 0, 'and the plugin chain is never consulted for that position')
  // CONTROL: the same draft with the caret INSIDE the command name is a real
  // seat, so the negative above is the whitespace rule and not a dead path.
  await m.type('/new\targument')
  // `/new\targument` is 13 units; nine LEFT steps park the caret at column 4,
  // inside the command name and before the tab.
  for (let step = 0; step < 9; step += 1) await m.key(LEFT)
  await m.key(TAB)
  await waitUntil('the in-token query reached the plugin chain', () => asked > 0)
  assert.deepEqual(m.editor(), { text: '/new\targument', cursor: 4 },
    'the control draft is caret-inside-token, and the answer completed nothing else')
})

test('clicking an already-complete candidate closes the list instead of looking inert', async (t) => {
  const m = await mountSlashPane(t, { chrome: true, commands: [{ name: 'new', description: 'Create a session' }] })
  // Typing the last character is what makes the token complete while the list
  // that character opened is still up — the state where a click has nothing to
  // complete.
  await m.type('/ne')
  await m.key('w')
  await waitUntil('the exact-name list painted', () => m.rows().length > 0)
  assert.deepEqual(m.editor(), { text: '/new', cursor: 4 }, 'the token is complete and the list is open')
  const row = m.rows()[0]!
  await m.click(row, false)
  assert.deepEqual(m.editor(), { text: '/new', cursor: 4 }, 'the draft was not rewritten or submitted by the click')
  assert.deepEqual(m.calls.submits, [], 'a click never submits')
  assert.equal(m.rows().length, 0, 'and the list the user clicked dismisses itself')
})

test('Ctrl+V with an empty clipboard still takes the dismissed list off the wire', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the list painted', () => m.rows().length > 0)
  // The application owns the OS probe: with nothing to paste it writes no draft
  // and notifies nothing, so no frame is coming from that owner.
  await m.quietKey(CTRL_V)
  assert.equal(m.calls.pastes, 1, 'the existing paste owner still ran exactly once')
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'the paste intent edited nothing in the draft')
  assert.equal(m.rows().length, 0, 'and the list it dismissed is off the wire')
  await m.quietKey(ESCAPE)
  assert.equal(m.calls.cancels, 1, 'so Escape reaches its original cancel owner, not a hidden list')
})

test('Alt+V with no visual on the frame still takes the dismissed list off the wire', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('/mo')
  await waitUntil('the list painted', () => m.rows().length > 0)
  // The chord is consumed even when no figure exists (a documented no-op that
  // leaves the draft untouched), which is exactly the frame-less owner case.
  await m.quietKey(ALT_V)
  assert.deepEqual(m.editor(), { text: '/mo', cursor: 3 }, 'the chord changed neither the draft nor the caret')
  assert.equal(m.rows().length, 0, 'the dismissed list is gone from the wire')
  assert.deepEqual(m.calls.submits, [], 'and nothing was submitted on the way')
  await m.quietKey(ESCAPE)
  assert.equal(m.calls.cancels, 1, 'Escape still belongs to cancel')
})

test('a fully typed command name still submits on Enter, while a partial one only completes', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  // Partial token: the list is open and Enter accepts, submitting nothing.
  await m.key('/ne')
  await waitUntil('the partial list painted', () => m.rows().length > 0)
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/new ', cursor: 5 }, 'the partial token completed')
  assert.deepEqual(m.calls.submits, [], 'the accept submitted nothing')
  // Fully typed token with the list still open: there is nothing left to
  // complete, so Enter stays the submit it always was. Regression: swallowing
  // this turns `type /new, press Enter` into a draft that only grows a space,
  // which is what broke the pre-existing Direct history lane.
  await m.type('/ne')
  await m.key('w')
  await waitUntil('the exact-name list painted', () => m.rows().length > 0)
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [{ text: '/new', gesture: 'enter' }],
    'a completed token submits exactly once instead of adding a space')
  assert.deepEqual(m.editor(), { text: '', cursor: 0 }, 'and the submitted draft left the composer')
})

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

// ── The seat fence: what is never a candidate seat ───────────────────────────

test('a shell line, an at-email, a version tag, an absolute path, a URL and ordinary prose never open a candidate list', async (t) => {
  const host = scriptedHostFilePort(() => DOTTED_HOST_ITEMS)
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['src/deep.ts']),
  })
  // POSITIVE CONTROL first, through the SAME row addressing the negatives use:
  // a dotted candidate value really paints, so "no row" below cannot be the
  // filter silently matching nothing.
  await m.type('@src/deep')
  await m.key(TAB)
  await waitUntil('the dotted positive control painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), [DOTTED_HOST_ROW],
    'the control row is a dotted value addressed by the same filter')
  const controlCalls = host.calls()
  // `/usr/bi` IS the first-line leading-slash SEAT, but no installed command and
  // no plugin answers it — the point here is that no FILE source is consulted.
  const drafts = [
    '!ls',
    '!!',
    'hello foo',
    './foo',
    '/usr/bi',
    'https://example.com/a/b',
    'a@b.co/x',
    'foo@bar.com',
    'pkg@1.0.0',
  ]
  for (const draft of drafts) {
    // The draft is committed through the mount's own composer port (a raw `\n`
    // byte is an Enter gesture to the SDK, not a line break), then ONE real key
    // edits it so the natural trigger runs against the intended document.
    await m.type(draft)
    await m.key('x')
    assert.equal(m.rows().length, 0, `${JSON.stringify(draft)} paints no candidate list`)
    assert.equal(m.bareRows().length, 0, `${JSON.stringify(draft)} paints no bare candidate line`)
    assert.deepEqual(m.calls.submits, [], `${JSON.stringify(draft)} submitted nothing`)
    assert.equal(host.calls(), controlCalls, `${JSON.stringify(draft)} reached no HostFilePort method`)
  }
  // The three at-grammar near-misses are also not file seats on the explicit
  // Tab trigger: an email/version/URL `@` is not a Host mention.
  for (const draft of ['foo@bar.com', 'pkg@1.0.0', 'https://example.com/@src']) {
    await m.type(draft)
    await m.quietKey(TAB)
    assert.equal(m.rows().length, 0, `${JSON.stringify(draft)} Tab paints no candidate list`)
    assert.equal(host.calls(), controlCalls, `${JSON.stringify(draft)} Tab reaches no HostFilePort method`)
  }
  assert.equal(host.calls(), controlCalls, 'no closed position queried the Host-file port at all')
})

test('Tab outside the command seat is not consumed by the completion seat', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  await m.key('hello')
  await m.quietKey(TAB)
  assert.equal(m.rows().length, 0, 'ordinary prose has no candidate list')
  assert.equal(m.editor().text.length > 0, true, 'and the Tab key is left to its existing owner')
})

// ── The Host `@` seat ───────────────────────────────────────────────────────

test('a Host @ mention paints the official @ rows and accepting one inserts the literal mention with the exact caret and stages nothing', async (t) => {
  const host = scriptedHostFilePort(() => ({
    kind: 'ok',
    items: [
      { path: 'src/deep.ts', kind: 'file' },
      { path: 'src/deep', kind: 'directory' },
    ],
  }))
  // The Client-local base holds a name that WOULD match the same query: if any
  // layer leaked the `@` seat into the local source, a plain `src/fo-local.ts`
  // row would paint instead of (or beside) the Host rows.
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['src/fo-local.ts']),
  })
  const staged = captureStager(m)
  await m.type('请看 @src/fo')
  await m.key(TAB)
  await waitUntil('the Host @ list painted', () => m.rows().length === 2)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›@src/deep.ts', ' @src/deep/'],
    'the rows carry the official @ values, in the Host order, with the first highlighted')
  assert.equal(m.rows().some(node => m.rowText(node).includes('fo-local')), false,
    'no Client-local candidate is mixed into the Host seat')
  assert.deepEqual(m.editor(), { text: '请看 @src/fo', cursor: 10 },
    'opening the list leaves the draft and the UTF-16 caret untouched')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '请看 @src/deep.ts ', cursor: 16 },
    'the accept writes only the literal mention plus the provider separator, and parks the caret after it')
  assert.deepEqual(m.calls.submits, [], 'accepting a Host mention is never a submission')
  assert.equal(staged.length, 0, 'a Host mention acceptance never reaches the inline-attachment stager')
  assert.deepEqual(host.queries.map(entry => entry.query), ['src/fo'],
    'the Host port received the official query form (the @ stripped, exactly once)')
  assert.deepEqual(host.queries[0]!.scope, { kind: 'workspace', cwd: '/work' },
    'the query was addressed to the mounted workspace scope')
  // The next Enter is the one explicit submission; it sends the literal text.
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [{ text: '请看 @src/deep.ts ', gesture: 'enter' }],
    'the LATER Enter submits the literal mention exactly once')
})

test('quoted and CJK-glued Host @ mentions keep the prose around them byte-for-byte', async (t) => {
  const host = scriptedHostFilePort(query => query === 'my fi'
    ? { kind: 'ok', items: [{ path: 'my file.png', kind: 'file' }] }
    : { kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] })
  const m = await mountSlashPane(t, { chrome: true, fileReferences: host.port })
  const staged = captureStager(m)
  // Quoted form: the unclosed `"` is part of the mention token; the official
  // grammar closes it and the space before it is never rewritten.
  await m.type('看 @"my fi')
  await m.key(TAB)
  await waitUntil('the quoted mention list painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›@"my file.png"', 'the quoted row is the official quoted value')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '看 @"my file.png" ', cursor: 17 },
    'the accept keeps the prose before the mention and the closed quote')
  // CJK-glued form: no ASCII separator before `@`, and the prefix survives.
  await m.type('看看@src/')
  await m.key(TAB)
  await waitUntil('the CJK-glued mention list painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›@src/deep.ts')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '看看@src/deep.ts ', cursor: 15 },
    'the CJK sentence before the mention is byte-identical and the caret is measured in UTF-16 units')
  assert.deepEqual(host.queries.map(entry => entry.query), ['my fi', 'src/'],
    'both official queries were stripped forms, quoting included')
  assert.deepEqual(m.calls.submits, [], 'neither mention accept submitted anything')
  assert.equal(staged.length, 0, 'neither mention accept staged a file')
})

test('the same single seat walks, accepts and dismisses a Host @ list with Tab, Shift+Tab, arrows, Escape and a click', async (t) => {
  const host = scriptedHostFilePort(() => ({
    kind: 'ok',
    items: [
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
      { path: 'src/c', kind: 'directory' },
    ],
  }))
  const m = await mountSlashPane(t, { chrome: true, fileReferences: host.port })
  const staged = captureStager(m)
  await m.type('@src/')
  await m.key(TAB)
  await waitUntil('the @ list painted', () => m.rows().length === 3)
  // The row of THIS frame becomes the stale target at the end of the case.
  const stale = m.rows()[0]!
  assert.equal(m.rowText(m.highlighted()[0]!), '›@src/a.ts')
  await m.key(TAB)
  assert.equal(m.rowText(m.highlighted()[0]!), ' @src/b.ts'.replace(/^ /, '›'), 'Tab walks forward')
  await m.key(SHIFT_TAB)
  assert.equal(m.rowText(m.highlighted()[0]!), '›@src/a.ts', 'Shift+Tab walks back')
  await m.key(DOWN)
  await m.key(DOWN)
  assert.equal(m.rowText(m.highlighted()[0]!), '›@src/c/', 'the arrows walk to the directory row')
  assert.deepEqual(m.editor(), { text: '@src/', cursor: 5 }, 'walking the list never edits the draft')
  await m.key(ESCAPE)
  assert.equal(m.rows().length, 0, 'Escape closed only the list')
  assert.equal(m.calls.cancels, 0, 'an open list turns Escape into a dismiss, never a cancel')
  await m.quietKey(ESCAPE)
  assert.equal(m.calls.cancels, 1, 'with the list closed Escape reaches its original cancel owner once')
  // Re-open (a fresh list highlights row 0 again), walk to the directory row
  // and accept it — a directory `@` continuation inserts the official value and
  // stages nothing.
  await m.key(TAB)
  await waitUntil('the @ list repainted', () => m.rows().length === 3)
  await m.key(DOWN)
  await m.key(DOWN)
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '@src/c/', cursor: 7 },
    'the highlighted directory mention was inserted literally, with no trailing separator')
  assert.equal(staged.length, 0, 'a Host directory accept never reaches the inline-attachment stager')
  assert.deepEqual(m.calls.submits, [], 'no gesture above submitted anything')
  // A click on a row of a SUPERSEDED frame completes nothing.
  m.install({ commands: COMMANDS })
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  await m.click(stale)
  assert.deepEqual(m.editor(), { text: '@src/c/', cursor: 7 }, 'an old @ row cannot write into the composer')
  assert.deepEqual(m.calls.submits, [], 'and a rejected click never submits')
})

test('an authoritative empty Host answer closes the @ seat without falling back to a Client-local listing', async (t) => {
  const empty = scriptedHostFilePort(() => ({ kind: 'ok', items: [] }))
  // The Client-local base holds the SAME name the Host query would match: any
  // fallback into the local filesystem would paint a row here.
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: scriptedHostFilePort(() => DOTTED_HOST_ITEMS).port,
    localCwd: localWorkspace(t, ['src/deep.ts']),
  })
  await m.type('@src')
  await m.key(TAB)
  await waitUntil('the dotted positive control painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), [DOTTED_HOST_ROW],
    'the row addressing used below really sees a dotted candidate')
  // The same seat, the same draft, the authoritative empty answer.
  m.install({ fileReferences: empty.port })
  await m.type('@src')
  await m.quietKey(TAB)
  // reason: bounded absence window — an authoritative empty answer has no
  // painted event to await; the fact is that neither source painted a row.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.rows().length, 0, 'an authoritative ok:[] paints no candidate row')
  assert.equal(m.bareRows().length, 0, 'and no bare fallback line either')
  assert.deepEqual(m.editor(), { text: '@src', cursor: 4 }, 'the empty answer changed neither draft nor caret')
  assert.equal(empty.queries.length, 1, 'the Host authority was asked exactly once')
  assert.deepEqual(m.calls.submits, [], 'an empty answer never submits')
  assert.equal(m.fields().length, 1, 'no second input field was invented for the empty seat')
})

test('an unavailable Host source closes the @ seat without claiming the path is missing', async (t) => {
  const offline = scriptedHostFilePort(() => ({
    kind: 'unavailable',
    reason: 'the Host file capability is not mounted',
  }))
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: scriptedHostFilePort(() => DOTTED_HOST_ITEMS).port,
    localCwd: localWorkspace(t, ['src/deep.ts']),
  })
  await m.type('@src')
  await m.key(TAB)
  await waitUntil('the dotted positive control painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), [DOTTED_HOST_ROW],
    'the row addressing used below really sees a dotted candidate')
  // The same seat, the same draft, the capability that cannot answer.
  m.install({ fileReferences: offline.port })
  await m.type('@src')
  await m.quietKey(TAB)
  // reason: bounded absence window — the `unavailable` outcome has no event;
  // the contract is that it paints nothing and invents no notice.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.rows().length, 0, 'an unavailable source paints no candidate row')
  assert.equal(offline.queries.length, 1, 'the Host authority was asked exactly once')
  const texts = wireNodes(m.pane)
    .map(node => String(node.p.text ?? ''))
    .filter(text => text !== '')
  assert.deepEqual(texts.filter(text => /not found|unavailable|does not exist|不存在|不可用/i.test(text)), [],
    'no "not found"/"unavailable" notice was invented for the Host capability state')
  assert.deepEqual(m.calls.submits, [], 'an unavailable source never submits')
})

test('a @ mention never queries Client-local files and a /image argument never queries the Host port', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'host-foo.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    // A local name with the same letters exists, but the two sources never meet.
    localCwd: localWorkspace(t, ['@foo.png']),
  })
  await m.type('@fo')
  await m.key(TAB)
  await waitUntil('the Host-only mention painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›@host-foo.ts', 'the @ seat answers from the Host port only')
  assert.equal(host.queries.length, 1)
  // `/image @foo` is a declared Client-local path argument, never a mention.
  await m.type('/image @fo')
  await m.key(TAB)
  await waitUntil('the Client-local argument painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›@foo.png'],
    'the argument seat answers from the Client-local filesystem only')
  assert.equal(host.queries.length, 1, 'the Client-local /image seat never re-queried the Host port')
  assert.deepEqual(m.calls.submits, [], 'neither seat submitted anything')
})

// ── Client-local leading and inline attachment seats ───────────────────────

test('a leading /image argument accepts only the argument and the next Enter is the one that executes the command', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    countingHostFile: true,
    localCwd: localWorkspace(t, ['shots/err.png']),
  })
  const staged = captureStager(m)
  await m.type('/image sho')
  await m.key(TAB)
  await waitUntil('the leading Client-local argument painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›shots/', ' shots/err.png'],
    'the rows are the REAL local paths (a directory keeps its /), never /shots/ or a command row')
  // The first row is a directory: accepting it only continues the path query.
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/image shots/', cursor: 13 },
    'only the argument text changed; the /image command token survives byte-for-byte')
  assert.deepEqual(m.calls.submits, [], 'the completion accept records zero submissions')
  assert.equal(staged.length, 0, 'accepting a leading path argument never reaches the inline stager')
  assert.equal(m.hostFileCalls(), 0, 'the Client-local leading seat never touched the Host port')
  // The leading seat is not the inline continuation seat: it stays closed until
  // the user asks again. A fresh TYPE is the natural re-query.
  assert.equal(m.rows().length, 0, 'a leading path accept does not keep a stale list painted')
  // The next Enter is the one that reaches the application's submit/command
  // owner at mount level; at this layer it is one explicit business gesture.
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [{ text: '/image shots/', gesture: 'enter' }],
    'the LATER Enter is the single explicit execution gesture for the leading command')
})

test('the now-open argument, second-line, at-mention and body inline drafts paint their own seats', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  // Every draft is committed through the mount's composer port and then edited
  // by ONE real key, so the natural trigger runs against the intended document.
  // Each draft is written so the appended `t` still names a real candidate.
  for (const draft of ['/attach ', '/attach no', '@src', 'look /image ', 'a\n/at']) {
    await m.type(draft)
    await m.key('t')
    await waitUntil(`${JSON.stringify(draft)} painted its own list`, () => m.rows().length > 0)
    assert.deepEqual(m.calls.submits, [], `${JSON.stringify(draft)} opened a list without submitting`)
  }
  assert.equal(host.queries.length > 0, true, 'the @ seat reached the Host port')
})

test('a second-line /attach argument paints the same Client-local path rows as a first-line leading argument', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    countingHostFile: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('first\n/attach note')
  await m.key('s')
  await waitUntil('the second-line path rows painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›notes.txt'],
    'the second-line argument is the Client-local inline path seat')
  await m.key(ENTER)
  assert.equal(m.editor().text.startsWith('first\n/attach notes.txt'), true,
    'the accept rewrites only the argument; the first line and the command token survive')
  assert.equal(staged.length, 1, 'a second-line inline FILE accept reaches the stager once')
  assert.equal(m.hostFileCalls(), 0, 'the Client-local path seat never touched the Host port')
  assert.deepEqual(m.calls.submits, [], 'the path accept was not a submission')
})

test('a body /att action opens the /attach path seat without reading a file', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('look /att')
  await m.key(TAB)
  await waitUntil('the /attach action row painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/attachAttach local file or image'])
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: 'look /attach ', cursor: 'look /attach '.length },
    'the action writes exactly /attach plus one separator')
  assert.equal(staged.length, 0, 'the action stages nothing')
  await waitUntil('the /attach path rows painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›notes.txt'])
  assert.equal(staged.length, 0, 'listing /attach paths still stages nothing')
  assert.deepEqual(m.calls.submits, [], 'no action or path listing submitted anything')
})

test('a body inline /im action opens the path seat from the same local cwd and the action accept stages nothing', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('看一下 /im')
  await m.key(TAB)
  await waitUntil('the inline /im action list painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/imageInsert local image'],
    'the fixed /image action is the inline /name row, with its own description')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '看一下 /image ', cursor: 11 },
    'accepting an action writes exactly /image plus one separator and keeps the CJK prose')
  assert.deepEqual(m.calls.submits, [], 'the action accept is never a submission')
  assert.equal(staged.length, 0, 'an action acceptance never reaches the file stager')
  // The SAME seat re-queries the now-real path argument from the local cwd.
  await waitUntil('the same seat immediately painted the local path rows', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›notes.txt'],
    'the follow-up query lists the real Client-local cwd, with no file read yet')
  assert.equal(staged.length, 0, 'listing paths still stages nothing')
})

test('an inline path DIRECTORY continues the listing while a FILE commits one acceptance and preserves all surrounding prose', async (t) => {
  const root = localWorkspace(t, ['shots/err.png', 'notes.txt'])
  const m = await mountSlashPane(t, { chrome: true, localCwd: root })
  const staged = captureStager(m)
  await m.type('看一下 /image sho')
  await m.key(TAB)
  await waitUntil('the inline directory row painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›shots/', ' shots/err.png'],
    'both real local paths are offered; the directory keeps its trailing /')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '看一下 /image shots/', cursor: '看一下 /image shots/'.length },
    'a directory accept continues the argument and leaves the prefix and command intact')
  assert.equal(staged.length, 0, 'a DIRECTORY acceptance stages nothing')
  await waitUntil('the directory children painted', () => m.rows().map(node => m.rowText(node)).includes('›shots/err.png'))
  // Backspace is unnecessary: `setDraft` installs a fresh single-line FILE
  // seat whose prose must survive BOTH the accept and a later placeholder
  // commit. The CRLF/emoji surroundings are covered by the next case.
  await m.type('看一下 /image notes')
  await m.key(TAB)
  await waitUntil('the inline file row painted', () => m.rows().map(node => m.rowText(node)).includes('›notes.txt'))
  await m.key(ENTER)
  const committedText = '看一下 /image notes.txt '
  const committedCursor = '看一下 /image notes.txt'.length
  assert.deepEqual(m.editor(), { text: committedText, cursor: committedCursor },
    'the FILE accept writes the path and one separator, leaving the caret right after the path token')
  assert.deepEqual(m.calls.submits, [], 'the FILE accept is never a submission')
  assert.equal(staged.length, 1, 'a committed FILE acceptance reaches the stager exactly once')
  const { stake, wire } = staged[0]!
  assert.equal(stake.command, 'image')
  assert.equal(stake.path, 'notes.txt')
  assert.equal(stake.rawDraft, committedText)
  assert.deepEqual(wire, { text: committedText, cursor: committedCursor },
    'the stager observed the SAME committed wire document and caret')
  assert.deepEqual(stake.span, { line: 0, start: 4, end: committedCursor },
    'the raw fragment names the /image command, its separator and the selected path')
  assert.equal(stake.draft(), committedText, 'the live draft the stake reads is the accepted text')
  const placeholder = '[image #1 (notes.txt)]'
  assert.equal(stake.commit(placeholder), true, 'the one atomic placeholder commit succeeded')
  const afterText = `看一下 ${placeholder} `
  assert.deepEqual(m.editor(), { text: afterText, cursor: afterText.length - 1 },
    'the placeholder replaces ONLY the inline fragment: the prose before /image survives byte-for-byte')
  assert.equal(stake.current(), false, 'a committed edit retires the old intake stake')
})

test('an inline path on a CRLF-terminated line completes on its OWN line, stages exactly once, and leaves the pair and line 2 byte-for-byte', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  // The attachment grammar ends the token AT the line break, so the seat window
  // stops before the CR: this accept is an ordinary same-line replacement and the
  // CRLF cluster is never part of what it writes (the Composer guard against a
  // break-carrying fragment stays as the backstop, witnessed in the editor suite).
  await m.type('看一下 /image note\r\nsecond line')
  // `\r\n` is ONE grapheme cluster, so the walk back from the document end is
  // line 2 plus that single cluster.
  await m.caretLeft('second line'.length + 1, '看一下 /image note'.length)
  await m.key('s')
  await waitUntil('the first-line CRLF file row painted', () => m.rows().map(node => m.rowText(node)).includes('›notes.txt'))
  await m.key(ENTER)
  const accepted = '看一下 /image notes.txt \r\nsecond line'
  const acceptedCursor = '看一下 /image notes.txt'.length
  assert.deepEqual(m.editor(), { text: accepted, cursor: acceptedCursor },
    'the name completes on its own line: the CRLF pair and line 2 survive byte-for-byte')
  assert.equal(staged.length, 1, 'the CRLF-line file acceptance reached the stager exactly once')
  const { stake, wire } = staged[0]!
  assert.equal(stake.command, 'image')
  assert.equal(stake.path, 'notes.txt', 'the intake read the path the user chose')
  assert.equal(stake.rawDraft, accepted)
  assert.deepEqual(wire, { text: accepted, cursor: acceptedCursor },
    'the stager observed the SAME committed document and caret')
  assert.deepEqual(stake.span, { line: 0, start: 4, end: acceptedCursor },
    'the raw fragment stays inside line 1')
  assert.equal(accepted.slice(stake.span.start, stake.span.end).includes('\r'), false,
    'the fragment the placeholder replaces carries none of the break')
  assert.deepEqual(m.calls.submits, [], 'the accept is never a submission')
  const placeholder = '[image #1 (notes.txt)]'
  assert.equal(stake.commit(placeholder), true, 'the placeholder commits on a CRLF-terminated line')
  const afterText = `看一下 ${placeholder} \r\nsecond line`
  assert.deepEqual(m.editor(), { text: afterText, cursor: 4 + placeholder.length },
    'the splice replaced ONLY the fragment: the break, line 2 and the separator survive')
  assert.equal(stake.current(), false, 'a committed edit retires the old intake stake')
})

test('an OPEN quoted inline path on a CRLF line closes on its own line and leaves line 2 verbatim', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['my file.png']),
  })
  const staged = captureStager(m)
  // The quoted branch has the same boundary: an open quote never reaches across a
  // line for its partner, so the user's own `"` on line 2 is prose that survives.
  await m.type('look /image "m\r\nsecond"')
  await m.caretLeft('second"'.length + 1, 'look /image "m'.length)
  await m.key('y')
  await waitUntil('the quoted CRLF row painted', () => m.rows().map(node => m.rowText(node)).includes('›my file.png'))
  await m.key(ENTER)
  const accepted = 'look /image "my file.png" \r\nsecond"'
  assert.deepEqual(m.editor(), { text: accepted, cursor: 'look /image "my file.png"'.length },
    'the quoted name closes on its own line and line 2 keeps its stray quote verbatim')
  assert.equal(staged.length, 1, 'the quoted CRLF acceptance staged exactly once')
  assert.equal(staged[0]!.stake.path, 'my file.png', 'the intake received the unquoted path')
  assert.deepEqual(staged[0]!.stake.span, { line: 0, start: 5, end: 'look /image "my file.png"'.length },
    'the fragment stops before the break')
})

test('a multi-line CRLF document keeps the first line, CRLF pair and emoji around a second-line inline file acceptance', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  // The document is committed through the mount's composer port: a raw Enter
  // byte would be a submit gesture, and the CRLF pair is the content under
  // test. Type `s` naturally so the SECOND line's inline path query paints.
  await m.type('🖼️ first\r\n看一下 /image note')
  await m.key('s')
  const caretAtPath = m.editor().cursor
  assert.equal(caretAtPath, '🖼️ first\r\n看一下 /image notes'.length,
    'the typed character completed the second-line path token at the document end')
  await waitUntil('the second-line CRLF file row painted', () => m.rows().length > 0)
  await m.key(ENTER)
  const accepted = '🖼️ first\r\n看一下 /image notes.txt '
  const acceptedCursor = accepted.length - 1
  assert.deepEqual(m.editor(), { text: accepted, cursor: acceptedCursor },
    'the accepted path did not eat the emoji, the CRLF pair or the first line')
  assert.equal(staged.length, 1, 'the CRLF file acceptance staged exactly once')
  const { stake } = staged[0]!
  assert.equal(stake.rawDraft, accepted)
  assert.deepEqual(stake.span, { line: 1, start: 4, end: '看一下 /image notes.txt'.length },
    'the half-open span stays inside the second logical line')
  const placeholder = '[image #1 (notes.txt)]'
  assert.equal(stake.commit(placeholder), true)
  const afterText = `🖼️ first\r\n看一下 ${placeholder} `
  assert.deepEqual(m.editor(), { text: afterText, cursor: afterText.length - 1 },
    'the placeholder splice preserved the emoji, the CRLF pair and line 1 byte-for-byte')
})

test('a U+3000-led remainder at a mid-token caret is consumed once on the real seat, never duplicated', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['全角　名.png', 'ascii.png']),
  })
  const staged = captureStager(m)
  // The caret sits INSIDE the name, so the whole `　名.png` tail is the token's own
  // remainder: U+3000 is filename content, and a whitespace-class boundary would
  // stop there and re-emit the tail after the accepted value.
  await m.type('look /image 全角　名.png')
  await m.caretLeft('　名.png'.length, 'look /image 全角'.length)
  // A caret-only move never re-queries: Tab is this seat's own open gesture at a
  // closed list, so the query is asked at the mid-token caret the way a user asks it.
  await m.key(TAB)
  await waitUntil('the U+3000 row painted at the mid-token caret', () => m.rows().map(node => m.rowText(node)).includes('›全角　名.png'))
  await m.key(ENTER)
  const accepted = 'look /image 全角　名.png '
  assert.deepEqual(m.editor(), { text: accepted, cursor: 'look /image 全角　名.png'.length },
    'the name is written ONCE with no duplicated full-width tail')
  assert.equal(staged.length, 1, 'the mid-token U+3000 acceptance staged exactly once')
  assert.equal(staged[0]!.stake.path, '全角　名.png', 'the intake received the whole name including U+3000')
})

test('a caret parked away from the live token makes a FILE acceptance stale: the write is refused, no stager call, and the editable path survives', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('看一下 /image notes')
  await m.key(TAB)
  await waitUntil('the file row painted', () => m.rows().length === 1)
  // Park the caret with LEFT (a caret-only move), then type one character so a
  // NEW document is live: the list's snapshot is now stale. A TAB (not Enter)
  // is the stale ACCEPT gesture, because a closed popup's Enter stays the
  // composer's ordinary submit gesture.
  await m.caretLeft(1, '看一下 /image notes'.length - 1)
  await m.key('q')
  const live = m.editor()
  await m.quietKey(TAB)
  assert.deepEqual(m.editor(), live, 'a stale accept wrote nothing and kept the user-editable path text')
  assert.deepEqual(m.calls.submits, [], 'a refused/no-op accept is CONSUMED, never a submission')
  assert.equal(staged.length, 0, 'a refused composer write never reached the stager')
  assert.equal(m.rows().length, 0, 'the stale list retired')
})

test('a forged inlineAttachment marker on a leading-slash plugin row is displayed and inserted as plain text and never stages a file', async (t) => {
  // The LEADING-SLASH shape of the same hazard: a `/name` token is not a path
  // seat at all, so the inline attachment plane is unreachable here for a reason
  // that has nothing to do with row identity. The identity fence itself is the
  // next case, which drives the forged row at a real inline path seat.
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    localCwd: localWorkspace(t, []),
    extensionSuggest: async () => ({
      prefix: '/z',
      items: [{
        value: 'zz',
        label: 'zz',
        // The structural marker is NOT a permission: only a real
        // MentionProvider request may grant a Client-local read.
        inlineAttachment: 'path',
        command: 'image',
        directory: false,
      } as never],
    }),
  })
  const staged = captureStager(m)
  await m.type('/z')
  await m.key(TAB)
  await waitUntil('the plugin row painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›/zz', 'the foreign row is displayed as an ordinary /name row')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/zz ', cursor: 4 },
    'the plugin completion inserted plain text and nothing else')
  assert.equal(staged.length, 0, 'no forged marker reached the inline-attachment stager')
  assert.deepEqual(m.calls.submits, [], 'the plugin accept is still accept-only')
})

test('a forged inlineAttachment marker at a real INLINE path seat is refused by row identity, while the request own row stages exactly once', async (t) => {
  // One real file answers the CONTROL query; NOTHING in this directory matches
  // the forged query `zz`, so the base provider returns null there and only the
  // plugin chain can answer — the forged row lands in the SAME seat, under the
  // SAME declared command, with the SAME structural marker.
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    localCwd: localWorkspace(t, ['real.png']),
    extensionSuggest: async () => ({
      prefix: 'zz',
      items: [{
        value: 'zz.png',
        label: 'zz.png',
        inlineAttachment: 'path',
        command: 'image',
        directory: false,
      } as never],
    }),
  })
  const staged = captureStager(m)

  // POSITIVE CONTROL: at this seat a row the Provider really produced under its
  // strict snapshot DOES stage exactly one immutable acceptance.
  await m.type('look /image rea')
  await m.key(TAB)
  await waitUntil('the real inline path row painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›real.png')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: 'look /image real.png ', cursor: 'look /image real.png'.length },
    'the real row completed the argument at the inline path seat')
  assert.equal(staged.length, 1, 'the real row reached the stager exactly once')
  assert.equal(staged[0]!.stake.path, 'real.png', 'the stake carries the real candidate path')
  assert.deepEqual(staged[0]!.stake.span, { line: 0, start: 5, end: 'look /image real.png'.length },
    'the span names the command token, its separator and the accepted value')

  // THE FENCE: same seat, same `command:'image'`, marker-shaped row from the
  // plugin chain — it may only ever be ordinary text.
  await m.type('look /image zz')
  await m.key(TAB)
  await waitUntil('the forged inline row painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›zz.png',
    'the forged row is displayed with its own label at the inline path seat')
  await m.key(ENTER)
  // The PERMISSION claim is asserted FIRST, on purpose: a regression that lets the
  // marker buy the attachment route shows up here as `2 !== 1` instead of surfacing
  // first as the cosmetic separator the attachment grammar appends. Both halves are
  // discriminating — measured under the M5 mutant in either order (the text-shape
  // assert fails when it leads, the staging fence fails when it leads).
  assert.equal(staged.length, 1,
    'NO second acceptance was staged — the provider-request row identity, not the marker, is the permission')
  assert.deepEqual(m.editor(), { text: 'look /image zz.png', cursor: 'look /image zz.png'.length },
    'it inserted the plugin value as plain text: the prose, the `/image` command token and the separator survive')
  assert.deepEqual(m.calls.submits, [], 'the forged accept is still accept-only')
})

test('a quoted inline path acceptance closes the quote once and hands the intake the unquoted path', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['my file.png']),
  })
  const staged = captureStager(m)
  await m.type('look /image "my')
  await m.key(TAB)
  await waitUntil('the quoted local row painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›my file.png'],
    'the row paints the real local path, not a double-quoted command token')
  await m.click(m.rows()[0]!, true)
  const accepted = 'look /image "my file.png" '
  assert.deepEqual(m.editor(), { text: accepted, cursor: 'look /image "my file.png"'.length },
    'the quote was closed exactly once and the prose before /image survived')
  assert.equal(staged.length, 1, 'the quoted FILE acceptance staged once')
  assert.equal(staged[0]!.stake.path, 'my file.png', 'the intake received the unquoted path')
})

test('a Unicode filename with a full-width space completes span-exactly and keeps the surrounding prose', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['全角　名.png', 'ascii.png']),
  })
  const staged = captureStager(m)
  await m.type('look /image 全角')
  await m.key(TAB)
  await waitUntil('the Unicode candidate painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›全角　名.png'],
    'only the matching Unicode name is offered; the U+3000 is path content, not a separator')
  await m.key(ENTER)
  const accepted = 'look /image 全角　名.png '
  assert.deepEqual(m.editor(), { text: accepted, cursor: 'look /image 全角　名.png'.length },
    'the name was written once with no duplicated tail and the prose around it survived')
  assert.equal(staged.length, 1)
  assert.equal(staged[0]!.stake.path, '全角　名.png', 'the read target is the raw name, quotes and spacing included')
})

test('a FILE acceptance whose intake never commits leaves the accepted path editable and invents no placeholder', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  // The command plane owns the read and the store; a failing/absent intake
  // simply never calls `commit()`. The mount must not predict its success.
  const staged = captureStager(m)
  await m.type('看一下 /attach notes')
  await m.key(TAB)
  await waitUntil('the attach file row painted', () => m.rows().length > 0)
  await m.key(ENTER)
  const accepted = '看一下 /attach notes.txt '
  assert.deepEqual(m.editor(), { text: accepted, cursor: '看一下 /attach notes.txt'.length },
    'the accepted path is the live, still-editable draft')
  assert.equal(staged.length, 1, 'the file acceptance reached the stager exactly once')
  // reason: bounded absence window — no intake is running that could produce a
  // placeholder frame; the fact is that no optimistic text ever appears.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(m.editor(), { text: accepted, cursor: '看一下 /attach notes.txt'.length },
    'no placeholder was invented for a read that never settled')
  assert.equal(staged[0]!.stake.current(), true, 'the live seat is still the accepted one')
  await m.key(LEFT)
  assert.equal(staged[0]!.stake.current(), false, 'a user edit fences the old intake')
  assert.deepEqual(m.calls.submits, [], 'none of this submitted anything')
})

test('a failed command catalog closes the leading-slash seat but leaves the Host @ and Client-local path seats answering', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  m.install({ sourceFailed: true })
  await m.type('/mo')
  await m.quietKey(TAB)
  assert.equal(m.rows().length, 0, 'a failed command source offers no leading /command rows')
  await m.type('@src')
  await m.key(TAB)
  await waitUntil('the Host @ seat still painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›@src/deep.ts')
  await m.type('/image notes')
  await m.key(TAB)
  await waitUntil('the Client-local leading path seat still painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›notes.txt'])
  assert.deepEqual(m.calls.submits, [], 'none of those seats submitted anything')
})

test('a stale Host @ or path list after a new catalog, a draft clear or a hydration window accepts nothing', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  const liveDraft = '看 @srcx'
  const refusedAfter = async (seam: () => void, label: string): Promise<void> => {
    await m.type(liveDraft)
    await m.key(TAB)
    await waitUntil(`${label}: the Host @ list painted`, () => m.rows().length > 0)
    const stale = m.rows()[0]!
    seam()
    await m.click(stale)
    assert.deepEqual(m.editor(), { text: liveDraft, cursor: liveDraft.length }, `${label}: the old @ row wrote nothing`)
    assert.deepEqual(m.calls.submits, [], `${label}: the old @ row submitted nothing`)
    assert.equal(staged.length, 0, `${label}: the old @ row staged nothing`)
    // A→B→A: returning to the SAME query must re-query the CURRENT source, not
    // resurrect the old row. Ask with the natural trigger once more; the Host
    // port is the authority that re-answers.
    const before = host.queries.length
    await m.type(liveDraft)
    await m.key('q')
    await waitUntil(`${label}: the fresh query painted`, () => host.queries.length > before)
  }
  await refusedAfter(() => m.install({ commands: [{ name: 'model', description: 'Choose a model' }] }), 'a new catalog')
  await refusedAfter(() => m.renderer.display.clearActiveDraft(), 'a draft clear')
  await refusedAfter(() => m.renderer.display.beginInputHistoryScope('owner-b'), 'a published owner')
  // Hydration is an INPUT FENCE: the outgoing list and its in-flight query die
  // at `beginSessionHydration`, so the stale row cannot be clicked even before
  // the incoming subject's first frame lifts the fence.
  await m.type(liveDraft)
  await m.key(TAB)
  await waitUntil('hydration: the Host @ list painted', () => m.rows().length > 0)
  const stale = m.rows()[0]!
  m.renderer.display.beginSessionHydration()
  await m.click(stale)
  assert.deepEqual(m.editor(), { text: liveDraft, cursor: liveDraft.length },
    'hydration: the old @ row wrote nothing')
  assert.deepEqual(m.calls.submits, [], 'hydration: the old @ row submitted nothing')
  assert.equal(staged.length, 0, 'hydration: the old @ row staged nothing')
  m.renderer.display.commitDisplaySubject({}, {}, undefined)
  assert.equal(m.rows().length, 0, 'hydration: the next committed frame carries no old list')
})

test('a bare pane shows at most three rows with no click affordance for Host @, path and inline seats', async (t) => {
  const host = scriptedHostFilePort(() => ({
    kind: 'ok',
    items: [
      { path: 'src/one.ts', kind: 'file' },
      { path: 'src/two.ts', kind: 'file' },
      { path: 'src/three.ts', kind: 'file' },
      { path: 'src/four.ts', kind: 'file' },
    ],
  }))
  const m = await mountSlashPane(t, {
    chrome: false,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['one.txt', 'two.txt', 'three.txt', 'four.txt']),
  })
  // One natural keystroke opens the Host @ and inline-action seats; a leading
  // path argument needs Tab (its empty cwd listing is the explicit trigger).
  const seats: Array<{ draft: string; key: string }> = [
    { draft: '@src', key: 't' },
    { draft: '/image ', key: TAB },
    { draft: 'look /at', key: 't' },
  ]
  for (const { draft, key } of seats) {
    await m.type(draft)
    if (key === TAB) await m.quietKey(key)
    else await m.key(key)
    await waitUntil(`${JSON.stringify(draft)} painted bare rows`, () => m.bareRows().length > 0)
    assert.equal(m.bareRows().length <= 3, true, `${JSON.stringify(draft)} paints at most three bare rows`)
    // Not "my row filter found no button" — this pane advertised no `el` kind at
    // all, so NO `el` node may exist anywhere on the wire.
    assert.equal(wireNodes(m.pane).filter(node => node.k === 'el').length, 0,
      `${JSON.stringify(draft)}: a pane without el paints no clickable element at all`)
    assert.equal(m.fields().length, 1, `${JSON.stringify(draft)} keeps exactly one editor`)
    const painted = m.bareRows().map(node => m.rowText(node))
    assert.equal(painted.filter(text => text.startsWith('›')).length, 1,
      `${JSON.stringify(draft)} has exactly one bare highlight marker`)
  }
  assert.equal(host.queries.length > 0, true, 'the Host @ seat really answered on the bare pane')
  assert.deepEqual(m.calls.submits, [], 'none of the bare-pane seats submitted anything')
})

test('Ctrl+C, Ctrl+V and a higher menu retire an OPEN non-slash popup and route the intent to its owner exactly once', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, { chrome: true, fileReferences: host.port })
  const openHostList = async (): Promise<void> => {
    await m.type('看 @src')
    await m.key(TAB)
    await waitUntil('the Host @ popup painted', () => m.rows().length > 0)
  }
  // Ctrl+C is an application cancel intent, never an accept gesture.
  await openHostList()
  await m.quietKey(CTRL_C)
  assert.equal(m.calls.cancels, 1, 'Ctrl+C reached the cancel owner exactly once')
  assert.equal(m.rows().length, 0, 'the open Host list retired from the wire')
  assert.deepEqual(m.editor(), { text: '看 @src', cursor: '看 @src'.length }, 'the draft and caret were untouched')
  assert.deepEqual(m.calls.submits, [], 'the cancel intent never became a submit')
  // Ctrl+V is the application's paste owner even when no clipboard image
  // exists: no draft write, and no extra read AFTER the intent.
  await openHostList()
  const beforePaste = host.queries.length
  await m.quietKey(CTRL_V)
  assert.equal(m.calls.pastes, 1, 'the paste owner ran exactly once')
  assert.equal(m.rows().length, 0, 'the open Host list is off the wire')
  assert.equal(host.queries.length, beforePaste, 'an empty paste triggers no extra Host file read')
  assert.deepEqual(m.calls.submits, [], 'the paste intent never became a submit')
  // Modal/menu precedence: the Permission menu takes the keys and the hidden
  // list cannot answer an arrow or an Enter.
  await m.commitStatus(permissionSnapshot('workspace-write'))
  await openHostList()
  const trigger = wireNodes(m.pane).find(node => node.k === 'el' && node.id.includes('.composer-permission-s')
    && !node.id.includes('option'))
  assert.ok(trigger, 'the permission trigger is on the wire')
  await m.click(trigger!)
  await waitUntil('the permission menu opened', () => wireNodes(m.pane).some(node => node.id.includes('.composer-permission-option-')))
  assert.equal(m.rows().length, 0, 'a higher menu retired the open Host list')
  const highlightedOptions = (): number => wireNodes(m.pane)
    .filter(node => node.k === 'el' && node.id.includes('.composer-permission-option-')
      && (node.p.attrs as Record<string, string> | undefined)?.['data-highlight'] === 'true').length
  assert.equal(highlightedOptions() <= 1, true, 'the menu carries its own one-row highlight state')
  await m.key(DOWN)
  assert.equal(highlightedOptions(), 1, 'the arrow reached the permission menu, not a hidden completion list')
  assert.deepEqual(m.editor(), { text: '看 @src', cursor: '看 @src'.length }, 'the menu key never edited the draft')
  assert.deepEqual(m.calls.submits, [], 'no modal-precedence key became a submit')
})

test('an inline skill row shares the /name seat with the attachment actions but inserts only plain text', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    skillReferences: [{ name: 'image-note', description: 'A plain skill reference' }],
    commands: [],
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('look /image-n')
  await m.key(TAB)
  await waitUntil('the inline skill row painted', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›/image-noteA plain skill reference'])
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: 'look /image-note ', cursor: 'look /image-note '.length },
    'only the /name token was rewritten')
  assert.equal(staged.length, 0, 'a skill row never stages a file')
  assert.deepEqual(m.calls.submits, [], 'a skill accept is accept-only')
})

// ── The render-count contract (§7.1: the frame delta IS the render count) ────

test('a WRITING completion commits exactly one frame, and a continuation commits its write and its re-query as two distinct states', async (t) => {
  const host = scriptedHostFilePort(() => DOTTED_HOST_ITEMS)
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['shots/err.png', 'notes.txt']),
  })
  const staged = captureStager(m)

  // Host `@` accept: one editor mutation and no follow-up query → one frame.
  await m.type('请看 @src')
  await m.key(TAB)
  await waitUntil('the mention list painted', () => m.rows().length > 0)
  const mentionBefore = m.frameCount()
  await m.key(ENTER)
  await waitUntil('the mention accept painted', () => m.editor().text === '请看 @src/deep.ts ')
  assert.equal(m.frameCount() - mentionBefore, 1,
    'the mention accept commits exactly ONE render')
  assert.equal(m.rowsThrough(mentionBefore + 1).length, 0,
    'that single frame carries the finished text with the list already withdrawn')
  // reason: bounded absence window — a double commit would arrive as a LATER
  // frame; the fact is that no second frame ever follows this state.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.frameCount() - mentionBefore, 1, 'and nothing re-renders the same committed state')

  // Inline ACTION accept: the write is ONE frame, the re-queried path list the
  // NEXT — two frames for two different states, never two for one.
  await m.type('看一下 /im')
  await m.key(TAB)
  await waitUntil('the action list painted', () => m.rows().length > 0)
  const actionBefore = m.frameCount()
  await m.key(ENTER)
  await waitUntil('the action path list painted', () => m.rowsThrough(actionBefore + 2).length > 0)
  assert.equal(m.frameCount() - actionBefore, 2,
    'the action accept commits exactly one write frame plus exactly one settled-list frame')
  assert.equal(m.editorThrough(actionBefore + 1).text, '看一下 /image ', 'the first new frame is the write')
  assert.equal(m.rowsThrough(actionBefore + 1).length, 0,
    'and it carries no list yet: the follow-up query did not ride the same frame twice')
  assert.equal(m.editorThrough(actionBefore + 2).text, '看一下 /image ',
    'the second new frame changed only the popup, never the document again')
  assert.equal(m.rowsThrough(actionBefore + 2).length, 2, 'the settled path list is that one frame')

  // DIRECTORY accept: the same shape — one write frame, one continuation frame.
  await m.type('看一下 /image sh')
  await m.key(TAB)
  await waitUntil('the directory list painted', () => m.rows().length > 0)
  const dirBefore = m.frameCount()
  await m.key(ENTER)
  await waitUntil('the continuation list painted', () => m.rowsThrough(dirBefore + 2).length > 0)
  assert.equal(m.frameCount() - dirBefore, 2,
    'the directory accept commits exactly one write frame plus exactly one continuation frame')
  assert.deepEqual(m.rowsThrough(dirBefore + 1).map(node => m.rowText(node)), [],
    'the write frame carries the continued argument and an empty popup')
  assert.equal(m.editorThrough(dirBefore + 2).text, '看一下 /image shots/',
    'the continuation frame left the document untouched')
  assert.deepEqual(m.rowsThrough(dirBefore + 2).map(node => m.rowText(node)), ['›shots/err.png'],
    'and painted exactly the child listing of the accepted directory')
  assert.equal(staged.length, 0, 'none of these writes staged a file, so no notice frame was added either')
  assert.deepEqual(m.calls.submits, [], 'and none of them submitted')
})

test('a refused accept and every non-completion key over an OPEN non-slash popup owe exactly one dismissal frame and never a second', async (t) => {
  const host = scriptedHostFilePort(() => DOTTED_HOST_ITEMS)
  const m = await mountSlashPane(t, {
    chrome: true,
    fileReferences: host.port,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  const openHostPopup = async (): Promise<number> => {
    await m.type('看 @src')
    await m.key(TAB)
    await waitUntil('the Host popup painted', () => m.rows().length > 0)
    return m.frameCount()
  }

  // The no-write accept (the inline path seat whose argument ALREADY is the
  // highlighted row, with the user's own separator after it): the seat still
  // owes the ONE frame that takes the still-visible list off the wire.
  await m.type('看一下 /image notes.txt ')
  await m.caretLeft(1, '看一下 /image notes.txt'.length)
  await m.key(TAB)
  await waitUntil('the already-complete file row painted', () => m.rows().map(node => m.rowText(node)).includes('›notes.txt'))
  const refusedBefore = m.frameCount()
  await m.key(ENTER)
  await waitUntil('the no-write accept dismissed its list',
    () => m.frameCount() > refusedBefore && m.rowsThrough(m.frameCount()).length === 0)
  assert.equal(m.frameCount() - refusedBefore, 1,
    'a write that lands nothing owes exactly one dismissal frame, so the next Escape is not left facing a painted list')
  // reason: bounded absence window — the claim is that NO second frame follows a
  // refused accept; there is no further event to wait for.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(m.frameCount() - refusedBefore, 1, 'and the refusal produced no further render')
  assert.deepEqual(m.editor(), { text: '看一下 /image notes.txt ', cursor: '看一下 /image notes.txt'.length },
    'the refused accept wrote nothing')
  assert.equal(staged.length, 0, 'and staged nothing')

  // Ctrl+C: the popup retires (one frame) and the cancel intent still travels.
  const ctrlCBefore = await openHostPopup()
  await m.quietKey(CTRL_C)
  assert.equal(m.frameCount() - ctrlCBefore, 1, 'Ctrl+C costs exactly the one dismissal frame')
  assert.equal(m.calls.cancels, 1, 'and the cancel owner ran exactly once')
  assert.equal(m.rows().length, 0, 'the popup is off the wire')

  // Ctrl+V with an empty clipboard: its owner writes nothing, so the dismissed
  // list is the only frame the mount may add.
  const ctrlVBefore = await openHostPopup()
  const queriesBefore = host.queries.length
  await m.quietKey(CTRL_V)
  assert.equal(m.frameCount() - ctrlVBefore, 1, 'an empty Ctrl+V costs exactly the one dismissal frame')
  assert.equal(m.calls.pastes, 1, 'the paste owner ran exactly once')
  assert.equal(host.queries.length, queriesBefore, 'and no extra file read was triggered')

  // A higher owner taking the keys: opening the Permission menu retires the
  // popup inside that SAME frame — one frame, not a dismissal plus an opening.
  await m.commitStatus(permissionSnapshot('workspace-write'))
  const menuBefore = await openHostPopup()
  const trigger = wireNodes(m.pane).find(node => node.k === 'el' && node.id.includes('.composer-permission-s')
    && !node.id.includes('option'))
  assert.ok(trigger, 'the permission trigger is on the wire')
  await m.click(trigger!, true)
  assert.equal(m.frameCount() - menuBefore, 1, 'the menu opening and the popup dismissal commit as ONE frame')
  assert.equal(m.rows().length, 0, 'the non-slash popup is gone once the menu owns the keys')
  assert.deepEqual(m.calls.submits, [], 'no dismissal path ever produced a submission')
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
  await m.click(m.rows()[1]!, true)
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

test('a late Host answer after a new catalog, a draft clear or the hydration window paints nothing and is accepted by nothing', async (t) => {
  const pending: Array<(value: HostFileListResult) => void> = []
  const host: HostFilePort = {
    async listReferences (_scope, _query) {
      return new Promise<HostFileListResult>(resolve => { pending.push(resolve) })
    },
    async resolveReference () {
      return { kind: 'unavailable', reason: 'the deferred port never probes' }
    },
    async canonicalizeMentions (_scope, text) {
      return text
    },
  }
  const answer: HostFileListResult = { kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }
  const m = await mountSlashPane(t, { chrome: true, fileReferences: host })
  const staged = captureStager(m)
  const refusedAfter = async (
    seam: () => void,
    label: string,
    fresh: boolean,
  ): Promise<void> => {
    const outstanding = pending.length
    await m.type('看 @sr')
    await m.key('x')
    assert.equal(pending.length > outstanding, true, `${label}: the Host query was really issued`)
    assert.equal(m.rows().length, 0, `${label}: nothing is painted while the answer is outstanding`)
    seam()
    pending[outstanding]!(answer)
    // reason: bounded absence window — the released answer either paints a row
    // or it does not; the fact under test is that it never paints.
    await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    assert.equal(m.rows().length, 0, `${label}: the superseded answer paints no row`)
    assert.deepEqual(m.editor(), { text: '看 @srx', cursor: '看 @srx'.length },
      `${label}: the late answer wrote no draft`)
    assert.deepEqual(m.calls.submits, [], `${label}: the late answer submitted nothing`)
    assert.equal(staged.length, 0, `${label}: the late answer staged nothing`)
    if (!fresh) return
    // POSITIVE CONTROL: the same seat re-queries and a FRESH answer paints.
    const live = pending.length
    await m.type('看 @sr')
    await m.key('y')
    assert.equal(pending.length > live, true, `${label}: a fresh query was issued for the live draft`)
    pending[pending.length - 1]!(answer)
    await waitUntil(`${label}: the fresh answer painted`, () => m.rows().length > 0)
  }
  await refusedAfter(() => m.install({ commands: [{ name: 'model', description: 'Choose a model' }] }), 'a new catalog', true)
  await refusedAfter(() => m.renderer.display.clearActiveDraft(), 'a draft clear', true)
  await refusedAfter(() => m.renderer.display.beginSessionHydration(), 'the hydration window', false)
})






// ── Enter is accept-only at every non-slash seat ────────────────────────────

test('Enter at a Host @ mention whose typed token already names the row is still accept-only, never a submission', async (t) => {
  const host = scriptedHostFilePort(() => ({ kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }))
  const m = await mountSlashPane(t, { chrome: true, fileReferences: host.port })
  const staged = captureStager(m)
  // The draft ALREADY holds the official value: the I-C "whole first-line token
  // names the candidate" exception does not exist for a Host `@` seat.
  await m.type('看 @src/deep.ts')
  await m.key(TAB)
  await waitUntil('the exact-name mention painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›@src/deep.ts')
  await m.key(ENTER)
  assert.deepEqual(m.calls.submits, [],
    'the Enter was consumed as an accept: only the I-C leading-slash token may hand Enter to submit')
  assert.deepEqual(m.editor(), { text: '看 @src/deep.ts ', cursor: '看 @src/deep.ts '.length },
    'the accept added the provider separator instead of executing the draft')
  assert.equal(staged.length, 0, 'and a mention accept still stages nothing')
})

test('Enter at a body inline action whose token already names the action completes it and is never a submission', async (t) => {
  const m = await mountSlashPane(t, {
    chrome: true,
    localCwd: localWorkspace(t, ['notes.txt']),
  })
  const staged = captureStager(m)
  await m.type('look /image')
  await m.key(TAB)
  await waitUntil('the exact-name action painted', () => m.rows().length === 1)
  assert.equal(m.rowText(m.rows()[0]!), '›/imageInsert local image')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: 'look /image ', cursor: 'look /image '.length },
    'the inline action gained exactly one separator; the token was never executed')
  assert.deepEqual(m.calls.submits, [], 'the inline-seat Enter is accept-only even for a complete token')
  assert.equal(staged.length, 0, 'an action accept never reaches the stager')
  await waitUntil('the path seat opened after the action', () => m.rows().length > 0)
  assert.deepEqual(m.rows().map(node => m.rowText(node)), ['›notes.txt'])
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
  // reason: bounded absence window — no settlement has been released yet, so the
  // fact to observe is that nothing painted.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
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
    hostShellCompletion: undefined,
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

test('typing inside a command token keeps the caret column as the query, and the text after it survives', async (t) => {
  const m = await mountSlashPane(t, { chrome: true })
  // `/mo x`, two real Left steps, then `e`: the document the query must describe
  // is `/moe x` with the caret INSIDE the token (column 4), not at its end. A
  // query built on the line end would read the space after the caret, refuse the
  // seat and never open — the shape a user hits when fixing a typo mid-token.
  await m.type('/mo x')
  await m.key(LEFT)
  await m.key(LEFT)
  await m.key('e')
  assert.deepEqual(m.editor(), { text: '/moe x', cursor: 4 }, 'the typed char landed inside the token')
  await waitUntil('the mid-token query painted', () => m.rows().length > 0)
  const names = m.rows().map(node => node.id.slice(node.id.lastIndexOf('_') + 1))
  assert.deepEqual(names.sort(), ['model', 'more'], 'the candidates are the ones for the token under the caret')
  assert.deepEqual(m.editor(), { text: '/moe x', cursor: 4 }, 'painting the query moved neither text nor caret')
  assert.deepEqual(m.calls.submits, [], 'a mid-token query submitted nothing')
})

test('a bare pane walks its three-line window so the selected candidate is never off-window', async (t) => {
  const wide = Array.from({ length: 8 }, (_unused, index) => ({ name: `cmd${index}`, description: `d${index}` }))
  const m = await mountSlashPane(t, { chrome: false, commands: wide })
  await m.key('/cmd')
  await waitUntil('the bare window painted', () => m.bareRows().length === 3)
  // Four DOWN steps select the fifth candidate — past the painted three. The
  // window is the SURFACE's budget, so a bare pane must walk it the same way the
  // styled shell does: a candidate the user selected must be on screen.
  for (let step = 0; step < 4; step += 1) await m.key(DOWN)
  const painted = m.bareRows().map(node => m.rowText(node))
  assert.equal(painted.length, 3, 'still at most three plain text lines')
  const marked = painted.filter(text => text.startsWith('›'))
  assert.equal(marked.length, 1, 'exactly one painted line carries the highlight')
  assert.match(marked[0]!, /\/cmd4/, 'the selected candidate is inside the painted window')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/cmd4 ', cursor: 6 }, 'Enter completes the VISIBLE selection')
  assert.deepEqual(m.calls.submits, [], 'and completing it submitted nothing')
})

test('the window keeps the highlighted row visible when the list is longer than the popup', async (t) => {
  const many = Array.from({ length: 12 }, (_unused, index) => ({
    name: `aa${String(index).padStart(2, '0')}`,
    description: '',
  }))
  const m = await mountSlashPane(t, { chrome: true, commands: many })
  await m.key('/aa')
  await waitUntil('the windowed list painted', () => m.rows().length === 6)
  assert.equal(m.rows().length, 6, 'the painted window holds at most the six rows the contract allows')
  for (let step = 0; step < 8; step += 1) await m.key(DOWN)
  const highlighted = m.highlighted()
  assert.equal(highlighted.length, 1, 'exactly one row carries the highlight')
  assert.equal(m.rows().some(node => node.id === highlighted[0]!.id), true,
    'the highlighted row stays inside the painted window after eight steps')
})

// ── RFL-013: both painted halves of a candidate row are untrusted labels ─────

test('a candidate description carrying ANSI/CR/LF/TAB is projected onto one safe line and the row still accepts on its own identity', async (t) => {
  // A candidate row is a ONE-LINE cell whose description the painter composes
  // into the button `title`/`aria` AND paints as its own span, so both fields
  // need the repository's untrusted-LABEL projection. A plugin controls its own
  // description text, so this is a real provider surface: without the second
  // projection the ANSI sequence reaches the wire while the name beside it is
  // clean. Identity is untouched — the accept below still uses the Provider's
  // own value.
  const esc = String.fromCharCode(27)
  const cr = String.fromCharCode(13)
  const lf = String.fromCharCode(10)
  const tab = String.fromCharCode(9)
  const hostile = `red${esc}[31mdesc${esc}[0m cr${cr}lf${lf}tab${tab}end`
  const m = await mountSlashPane(t, {
    chrome: true,
    commands: [],
    extensionSuggest: async () => ({
      prefix: '/z',
      items: [{ value: 'zz', label: 'zz', description: hostile } as never],
    }),
  })
  await m.type('/z')
  await m.key(TAB)
  await waitUntil('the plugin row painted', () => m.rows().length === 1)
  const row = m.rows()[0]!
  const control = /[\u0000-\u0008\u000a-\u001f\u007f]/u
  const painted = m.rowText(row)
  assert.equal(painted.startsWith('\u203a/zz'), true, `the row still paints its own name: ${JSON.stringify(painted)}`)
  assert.equal(control.test(painted), false, `the painted row carries no control character: ${JSON.stringify(painted)}`)
  assert.equal(control.test(String(row.p.title ?? '')), false, 'the row title is terminal-safe')
  assert.equal(control.test(String(row.p.aria ?? '')), false, 'the row aria is terminal-safe')
  await m.key(ENTER)
  assert.deepEqual(m.editor(), { text: '/zz ', cursor: 4 },
    'the sanitised projection did not touch what the accept inserts')
  assert.deepEqual(m.calls.submits, [], 'and the accept is still accept-only')
})
