/**
 * TSP I-E: the `Ctrl+R` input-history search seat on the REAL SDK mount.
 *
 * Every case drives the production `mountTspRenderer` with its production
 * `bindHistorySearch` install over the shipped `@stencil-hq/tern` SDK and the
 * scripted tty pane, and asserts on the WIRE: the card's own reconciled nodes,
 * the ONE controlled composer's props, the `focus`/`reveal`/`scroll` ops the
 * mount actually issued, and the bound application handlers. A key is delivered
 * as raw terminal bytes and decoded by the SDK's own keyboard; a click is a
 * pane event addressed at the node id the SDK assigned in the committed frame.
 *
 * Every PRESENCE claim waits an authoritative predicate (a settled read, a
 * painted row, an op on the wire); every ABSENCE claim waits one named bounded
 * window. The seat debounces every non-initial query round by the source's own
 * `HISTORY_SEARCH_DEBOUNCE_MS`, so a query-round claim waits the REQUEST, never
 * a frame count.
 *
 * EVIDENCE LEVEL: SDK mount + wire. STANDS-IN: the scripted pane is not a
 * physical Tern client (that lane is `scripts/tern-pane-history-search-ux.mjs`),
 * the search source is a scripted `HistorySearchSource` (the real JSONL store,
 * its scope rules and the production persistence owner are
 * `test/integration/tern-tsp-history-search-direct.test.ts`), and the
 * application above the mount is the renderer's own bound handlers (the real
 * `SurfaceRuntime` → mount → seat binding and the Session currentness authority
 * are `test/app/tern-tsp-history-search-composition.test.ts`).
 *
 * What THIS file owns and no other lane proves: the frozen seat priority and
 * key table (a consumed key never reaches the Composer reducer, `Enter` never
 * submits, `Esc`/`Ctrl+C` never cancel the Agent), the Select-vs-Restore
 * pointer split, the retired-frame and retired-round refusals, the Modal park
 * and resume of the SAME instance, and the capability-negative statement.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-history-search.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { HistorySearchPage, HistorySearchRequest, HistorySearchResult } from '../../src/client/history/search.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS, HISTORY_SEARCH_RESULT_LIMIT } from '../../src/client/history/search.ts'
import type { TspHistorySearchBinding } from '../../src/app/surface/runtime.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { createTspHistorySearch } from '../../src/tui/tsp/history-search.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { clickNodeById, surfaceTexts, wireNodes } from '../support/tsp-picker-wire.ts'

/** The bounded observation window for this file's ABSENCE claims: one debounced
 *  query round plus the SDK's own input dispatch. Every absence claim below
 *  waits exactly this window and then reads the wire. */
const ABSENCE_WINDOW_MS = HISTORY_SEARCH_DEBOUNCE_MS * 3

const CTRL_R = '\u0012'
const ENTER = '\r'
const ESCAPE = '\u001b'
const CTRL_C = '\u0003'
const CTRL_V = String.fromCharCode(22)
const TAB = '\t'
const SHIFT_TAB = '\u001b[27;2Z'
const UP = '\u001b[A'
const LEFT = '\u001b[D'
const DOWN = '\u001b[B'
const PAGE_DOWN = '\u001b[6~'
const F2 = '\u001bOQ'
const ALT_UP = '\u001b[1;3A'
const ALT_C = '\u001bc'
const BACKSPACE = '\u007f'

/** One seeded row. `ts` is absolute so a painted age never rides the clock. */
interface SeedRow {
  readonly content: string
  readonly cwd?: string | null
  readonly ts?: number | null
  readonly sessionId?: string
}

interface HistoryPane {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly calls: Record<'submits' | 'cancels' | 'exits' | 'steers' | 'pastes' | 'notes' | 'receipts', number>
  readonly copies: string[]
  readonly requests: HistorySearchRequest[]
  /** Releases the read the scripted source parked on the query `hold`. */
  resolveHeld: (page: HistorySearchPage) => void
  /** Park the NEXT read the seat issues until {@link resolveHeld} runs. */
  holdNext: () => void
  composer(): { text: string; cursor: number }
  cardPainted(): boolean
  cardSerials(): string[]
  texts(): string[]
  selected(): string[]
  queryField(): { text: string; cursor: number } | undefined
  ops(kind: 'focus' | 'reveal' | 'scroll'): string[][]
  ids(match: RegExp): string[]
  key(bytes: string): void
  click(id: string): void
  painted(predicate: () => boolean, label: string): Promise<void>
  observeAbsence(): Promise<void>
  dispose(): Promise<void>
}

interface MountOptions {
  /** `'none'` mounts a renderer with NO History plane (the unbound negative). */
  readonly binding?: TspHistorySearchBinding | 'none'
  /** `false` advertises a pane that never negotiated the card's kinds/scroll. */
  readonly historySearch?: boolean
  readonly rows?: readonly SeedRow[]
  /** `null` = a sessionless start (no live Session identity at open). */
  readonly sessionId?: string | null
  readonly isCurrent?: () => boolean
  readonly cwd?: string
  readonly copyOk?: boolean
  readonly nativeInteraction?: boolean
  readonly modelPicker?: boolean
}

const DEFAULT_ROWS: readonly SeedRow[] = [
  { content: 'alpha one' },
  { content: 'beta two about tern' },
  { content: 'gamma three\nwith a second line' },
]

/** The scripted source: a literal substring filter, plus a read that PARKS when
 *  the query is exactly `hold` — the stale-round witness. */
function scriptSource(rows: readonly SeedRow[]): {
  readonly source: TspHistorySearchBinding['source']
  readonly armNext: () => void
  readonly requests: HistorySearchRequest[]
  resolveHeld: (page: HistorySearchPage) => void
} {
  const requests: HistorySearchRequest[] = []
  const toResult = (row: SeedRow, index: number): HistorySearchResult => ({
    id: `seed.jsonl:${index}`,
    content: row.content,
    cwd: row.cwd === undefined ? '/work/alpha' : row.cwd,
    ts: row.ts === undefined ? 1_700_000_000_000 + index * 60_000 : row.ts,
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    sourceFile: 'seed.jsonl',
    sourceByteOffset: index,
  })
  let release: ((page: HistorySearchPage) => void) | undefined
  let armed = false
  return {
    requests,
    armNext(): void { armed = true },
    source: {
      search(request: HistorySearchRequest): Promise<HistorySearchPage> {
        requests.push(request)
        if (request.signal?.aborted) return Promise.resolve({ results: [], exhausted: false })
        // `hold` (the stale-round witness) and an armed next read (the park
        // window) both park the answer until the case releases it.
        if (armed || request.query === 'hold') {
          armed = false
          return new Promise(resolve => { release = resolve })
        }
        const all = rows.map(toResult)
        return Promise.resolve({
          results: request.query === ''
            ? all
            : all.filter(row => row.content.toLowerCase().includes(request.query.toLowerCase())),
          exhausted: true,
        })
      },
    },
    resolveHeld: (page: HistorySearchPage) => { release?.(page) },
  }
}

async function mountHistoryPane(
  t: { after(fn: () => unknown): void },
  options: MountOptions = {},
): Promise<HistoryPane> {
  const pane = installTspPane({
    composerActions: true,
    ...(options.historySearch === false ? {} : { historySearch: true }),
    ...(options.nativeInteraction === true ? { nativeInteraction: true } : {}),
    ...(options.modelPicker === true ? { modelPicker: true } : {}),
  })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects through the shipped SDK')

  const scripted = scriptSource(options.rows ?? DEFAULT_ROWS)
  const calls = { submits: 0, cancels: 0, exits: 0, steers: 0, pastes: 0, notes: 0, receipts: 0 }
  const copies: string[] = []
  const renderer = mountTspRenderer(session, {
    copyVisual: async (text) => { copies.push(text); return options.copyOk !== false },
    requestExit: () => { calls.exits += 1 },
    onFatal: (error) => { throw error },
  })
  t.after(() => renderer.dispose())
  if (options.binding !== 'none') {
    const sessionId = options.sessionId === undefined ? 'ses_a' : options.sessionId
    renderer.bindHistorySearch(options.binding ?? {
      source: scripted.source,
      cwd: () => options.cwd ?? '/work/alpha',
      captureScope: () => ({
        sessionId: sessionId === null ? undefined : sessionId,
        isCurrent: options.isCurrent ?? (() => true),
      }),
    })
  }
  renderer.bindInput({
    exit: () => { calls.exits += 1 },
    cancel: () => { calls.cancels += 1 },
    submit: () => { calls.submits += 1 },
    steer: () => { calls.steers += 1 },
    pasteMedia: () => { calls.pastes += 1 },
    pastedPath: () => { calls.receipts += 1 },
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
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  // The mount's own committed frame is the readiness fact — no timed window.
  await waitUntil('the mount painted its composer editor',
    () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))

  return {
    pane,
    renderer,
    calls,
    copies,
    requests: scripted.requests,
    resolveHeld: scripted.resolveHeld,
    holdNext: () => scripted.armNext(),
    composer: () => {
      const node = wireNodes(pane).find(candidate => candidate.id === 'dock.quiet-composer.composer')
      return { text: String(node?.p.text ?? ''), cursor: Number(node?.p.cursor ?? 0) }
    },
    cardPainted: () => wireNodes(pane).some(node => node.id.includes('history-card')),
    cardSerials: () => [...new Set(wireNodes(pane)
      .map(node => node.id.match(/history-card-\d+/)?.[0])
      .filter((id): id is string => id !== undefined))],
    texts: () => surfaceTexts(pane, 's1'),
    selected: () => surfaceTexts(pane, 's1').filter(text => text.startsWith('›')),
    queryField: () => {
      const node = wireNodes(pane).find(candidate => /-query$/.test(candidate.id))
      if (node === undefined) return undefined
      return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    },
    ops: (kind) => pane.frames()
      .flatMap(frame => frame.ops.filter(op => op[0] === kind))
      .map(op => op.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry ?? null))),
    ids: (match) => wireNodes(pane).map(node => node.id).filter(id => match.test(id)),
    key(bytes: string) { pane.key(bytes) },
    click(id: string) { clickNodeById(pane, id) },
    async painted(predicate, label) { await waitUntil(label, predicate) },
    async observeAbsence() {
      // reason: the absence contract is "no later round and no repaint", which
      // is only observable as a bounded window over the debounced round length.
      await settle(ABSENCE_WINDOW_MS)
    },
    async dispose() {
      await renderer.dispose()
      await session.close()
    },
  }
}

// ── A. Opening the seat ──────────────────────────────────────────────────────

test('Ctrl+R opens ONE card above the ONE composer and reads the recent page at once with an empty query', async (t) => {
  const h = await mountHistoryPane(t)
  assert.equal(h.cardPainted(), false, 'no card before the chord')
  h.key(CTRL_R)
  await h.painted(() => h.cardPainted(), 'the card painted')
  assert.equal(h.cardSerials().length, 1, 'exactly one card frame')
  assert.equal(h.requests.length, 1, 'the empty query reads NOW, not after the debounce')
  assert.deepEqual(
    {
      scope: h.requests[0]?.scope,
      cwd: h.requests[0]?.cwd,
      sessionId: h.requests[0]?.sessionId,
      query: h.requests[0]?.query,
      limit: h.requests[0]?.limit,
    },
    { scope: 'session', cwd: '/work/alpha', sessionId: 'ses_a', query: '', limit: 200 },
    'the request carries the open-time scope, cwd, Session identity and the source row cap',
  )
  await h.painted(() => h.texts().some(text => text === 'Results · 3 shown'), 'the settled counter')
  assert.ok(h.texts().includes('Input History'), 'the card names itself')
  assert.equal(h.composer().text, '', 'opening never touches the draft')
  assert.equal(wireNodes(h.pane).filter(node => node.k === 'editor').length, 1,
    'the card adds NO second editor: the ONE controlled composer stays')
  assert.ok(h.ops('focus').at(-1)?.[1]?.endsWith('-query'), 'the query field owns the hardware caret')
})

test('a sessionless start defaults to Directory and its Scope ring never offers Session', async (t) => {
  const h = await mountHistoryPane(t, { sessionId: null })
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the sessionless first round')
  assert.equal(h.requests[0]?.scope, 'current', 'no Session scope without a live identity')
  assert.equal(h.requests[0]?.sessionId, undefined, 'and no session identity is sent either')
  await h.painted(() => h.texts().includes('Scope: Directory ⌄'), 'the Scope control states the current scope')
  h.key(TAB)
  await h.painted(() => h.requests.at(-1)?.scope === 'all', 'Tab walked Directory → All')
  h.key(TAB)
  await h.painted(() => h.requests.length === 3, 'the third round started')
  assert.equal(h.requests.at(-1)?.scope, 'current', 'and the ring never includes Session')
})

test('a mounted renderer with no History plane states the refusal and keeps its draft and keys', async (t) => {
  const h = await mountHistoryPane(t, { binding: 'none' })
  h.key('keep me')
  await h.painted(() => h.composer().text === 'keep me', 'the draft reached the editor')
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text === 'Input history search is unavailable in this Tern pane.'),
    'the missing capability is stated, not silently skipped')
  assert.equal(h.composer().text, 'keep me', 'the chord was consumed: no literal r was inserted')
  assert.equal(h.cardPainted(), false, 'and no card exists')
  assert.deepEqual(h.requests, [], 'nothing was ever queried')
})

test('a pane that never negotiated the card kinds and scroll feature gets no half UI and no read', async (t) => {
  const h = await mountHistoryPane(t, { historySearch: false })
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text === 'Input history search is unavailable in this Tern pane.'),
    'the same explicit refusal')
  assert.equal(h.cardPainted(), false, 'no card without the negotiated kinds and the scroll feature')
  assert.deepEqual(h.requests, [], 'the source was never queried')
})

// ── B. Restore is a draft write, never a submission ──────────────────────────

test('Enter restores the selected entry as the exact stored text and the NEXT Enter is the only submit', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text === 'Results · 3 shown'), 'the settled page')
  h.key(ENTER)
  await h.painted(() => h.composer().text !== '', 'the restore committed')
  assert.deepEqual(h.composer(), { text: 'alpha one', cursor: 9 },
    'the exact content replaced the draft with the caret at its end')
  assert.equal(h.calls.submits, 0, 'restore is never a submission')
  assert.equal(h.calls.notes, 0, 'and it is not user-input activity either')
  assert.equal(h.cardPainted(), false, 'the card closed with the restore')
  assert.equal(h.ops('focus').at(-1)?.[1], 'dock.quiet-composer.composer', 'the caret returned to the ONE composer')
  h.key(ENTER)
  await h.painted(() => h.calls.submits === 1, 'the later Enter submitted once')
  assert.equal(h.calls.submits, 1, 'exactly one submission for one Enter')
})

test('a multi-line entry restores whole with its newline and a later arrow is ordinary editor motion', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the first row selected')
  h.key(DOWN)
  h.key(DOWN)
  await h.painted(() => h.selected()[0]?.includes('gamma three') === true, 'the third row is selected')
  h.key(ENTER)
  await h.painted(() => h.composer().text.includes('second line'), 'the multi-line restore landed')
  assert.equal(h.composer().text, 'gamma three\nwith a second line', 'the FULL original text, newline included')
  assert.equal(h.calls.submits, 0, 'and the restored multi-line text was not executed')
  h.key(DOWN)
  await h.observeAbsence()
  assert.equal(h.composer().text, 'gamma three\nwith a second line', 'the arrow moved inside the draft, it never re-recalled')
  assert.equal(h.calls.submits, 0, 'and no submit either')
})

test('Esc and Ctrl+C each close the card only, and the same chords still cancel once the card is gone', async (t) => {
  for (const chord of [ESCAPE, CTRL_C]) {
    const h = await mountHistoryPane(t)
    h.key('draft')
    await h.painted(() => h.composer().text === 'draft', 'the draft reached the editor')
    h.key(CTRL_R)
    await h.painted(() => h.cardPainted(), 'the card opened')
    h.key(chord)
    await h.painted(() => !h.cardPainted(), 'the card closed')
    assert.equal(h.calls.cancels, 0, `${JSON.stringify(chord)} inside History never cancels the Agent`)
    assert.deepEqual(h.composer(), { text: 'draft', cursor: 5 }, `${JSON.stringify(chord)} left the draft and caret alone`)
    h.key(CTRL_C)
    await h.painted(() => h.calls.cancels === 1, 'the cancel intent reached the app')
    assert.equal(h.calls.cancels, 1, 'and exactly once, as it did before this seat existed')
    assert.equal(h.composer().text, 'draft', 'the cancel never cleared the draft here')
    await h.dispose()
  }
})

test('the card close is byte-exact for every draft shape the plan names, never a partial cancel', async (t) => {
  // Plan §7.2.2: `Esc`/`Ctrl+C` inside History must be equivalent to the same
  // chord with no card at all, for the drafts the composer really holds. The
  // witness is the WHOLE draft identity plus every sink the seat must not touch.
  // The claim is the INVARIANT (a byte-identical draft AND caret across the
  // card), so the caret is read from the editor after the motion rather than
  // computed: the editor walks grapheme clusters, not UTF-16 units.
  const DRAFTS: Array<{ readonly name: string; readonly bytes: string; readonly left: number }> = [
    { name: 'multi-line', bytes: 'line one\nline two', left: 3 },
    { name: 'caret at zero', bytes: 'keep me', left: 0 },
    { name: 'caret mid-run', bytes: 'a😀b', left: 1 },
    { name: 'emoji only', bytes: '🧪🧪 test', left: 2 },
  ]
  for (const chord of [ESCAPE, CTRL_C]) {
    for (const draft of DRAFTS) {
      const h = await mountHistoryPane(t)
      // A bracketed paste is the only honest way to put a line break INTO a
      // draft: a raw newline byte decodes as `enter` and would submit it.
      h.pane.key(`\u001b[200~${draft.bytes}\u001b[201~`)
      await h.painted(() => h.composer().text === draft.bytes, `${draft.name} reached the editor`)
      if (draft.left === 0) {
        for (let step = 0; step < 12; step += 1) h.key(LEFT)
        await h.painted(() => h.composer().cursor === 0, `${draft.name} caret at zero`)
      } else {
        for (let step = 0; step < draft.left; step += 1) h.key(LEFT)
        await h.painted(() => h.composer().cursor < draft.bytes.length, `${draft.name} caret parked mid-draft`)
      }
      const before = h.composer()
      const pastesBefore = h.calls.pastes
      const receiptsBefore = h.calls.receipts
      const notesBefore = h.calls.notes
      h.key(CTRL_R)
      await h.painted(() => h.cardPainted(), 'the card opened')
      h.key(chord)
      await h.painted(() => !h.cardPainted(), 'the card closed')
      assert.deepEqual(h.composer(), before,
        `${JSON.stringify(chord)} on ${draft.name}: the draft and caret are byte-identical`)
      assert.equal(h.calls.cancels, 0, `${JSON.stringify(chord)} on ${draft.name} never cancelled the Agent`)
      assert.equal(h.calls.submits, 0, `${JSON.stringify(chord)} on ${draft.name} never submitted`)
      assert.equal(h.calls.steers, 0, `${JSON.stringify(chord)} on ${draft.name} never steered`)
      assert.equal(h.calls.pastes, pastesBefore, `${JSON.stringify(chord)} never armed the paste intake`)
      assert.equal(h.calls.receipts, receiptsBefore, `${JSON.stringify(chord)} never armed a pasted-path intake`)
      assert.equal(h.calls.notes, notesBefore, `${JSON.stringify(chord)} never recorded an input`)
      await h.dispose()
    }
  }
})

// ── C. The frozen key table ──────────────────────────────────────────────────

test('typing edits only the card query and refilters through the source; the draft never moves', async (t) => {
  const h = await mountHistoryPane(t)
  h.key('mine')
  await h.painted(() => h.composer().text === 'mine', 'the draft reached the editor')
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('t')
  h.key('e')
  h.key('r')
  h.key('n')
  await h.painted(() => h.requests.at(-1)?.query === 'tern', 'the debounced round carried the current query')
  assert.deepEqual(h.queryField(), { text: 'tern', cursor: 4 }, 'the card field holds the query with its caret')
  assert.equal(h.composer().text, 'mine', 'the composer draft is untouched')
  await h.painted(() => h.texts().some(text => text === 'Results · 1 shown'), 'only the matching row is shown')
  h.key(ENTER)
  await h.painted(() => h.composer().text !== 'mine', 'the filtered row restored')
  assert.equal(h.composer().text, 'beta two about tern', 'the filtered row is what restored')
  assert.equal(h.calls.submits, 0, 'and the draft behind it was never executed')
})

test('Backspace edits the query on a grapheme boundary and never reaches the composer reducer', async (t) => {
  const h = await mountHistoryPane(t)
  h.key('draft')
  await h.painted(() => h.composer().text === 'draft', 'the draft reached the editor')
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('a')
  h.key('b')
  await h.painted(() => h.requests.at(-1)?.query === 'ab', 'the ab round')
  h.key(BACKSPACE)
  await h.painted(() => h.requests.at(-1)?.query === 'a', 'the shorter query re-read')
  assert.deepEqual(h.queryField(), { text: 'a', cursor: 1 }, 'one grapheme went back')
  assert.equal(h.composer().text, 'draft', 'the draft, caret and mode survived')
})

test('Ctrl+V inside the card neither pastes media nor inserts a character anywhere', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.cardPainted(), 'the card opened')
  h.key(CTRL_V)
  await h.observeAbsence()
  assert.equal(h.calls.pastes, 0, 'the application paste owner never saw the chord')
  assert.equal(h.calls.receipts, 0, 'and no pasted-path intake was armed either')
  assert.equal(h.composer().text, '', 'the draft stayed empty')
  assert.deepEqual(h.queryField(), { text: '', cursor: 0 }, 'nor did the query gain a literal v')
})

test('Tab and Shift+Tab cycle the scope with the query preserved in the frozen order', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('o')
  h.key('n')
  h.key('e')
  await h.painted(() => h.requests.at(-1)?.scope === 'session' && h.requests.at(-1)?.query === 'one', 'the typed round')
  h.key(TAB)
  await h.painted(() => h.requests.at(-1)?.scope === 'current', 'Tab → Directory')
  h.key(TAB)
  await h.painted(() => h.requests.at(-1)?.scope === 'all', 'Tab → All')
  assert.equal(h.requests.at(-1)?.query, 'one', 'the query string survived both switches')
  h.key(SHIFT_TAB)
  await h.painted(() => h.requests.at(-1)?.scope === 'current', 'Shift+Tab walks back')
  await h.painted(() => h.texts().includes('Scope: Directory ⌄'), 'and the control reads it')
})

test('Up/Down walk the selection with one reveal and clamp at both ends instead of wrapping', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the first settled row starts selected')
  assert.deepEqual(h.selected(), ['›alpha one'], 'the first row starts selected')
  const before = h.ops('reveal').length
  h.key(DOWN)
  await h.painted(() => h.ops('reveal').length === before + 1, 'one real move issued exactly one reveal')
  assert.ok(h.ops('reveal').at(-1)?.[1]?.endsWith('-o1'), 'addressed at the row node of THIS frame')
  assert.deepEqual(h.selected(), ['›beta two about tern'], 'and the highlight moved down')
  h.key(UP)
  await h.painted(() => h.selected()[0]?.includes('alpha one') === true, 'back up')
  h.key(UP)
  await h.observeAbsence()
  assert.deepEqual(h.selected(), ['›alpha one'], 'the first row clamps — it never wraps to the last')
})

test('PageDown steps the selection by the page budget and clamps at the last row', async (t) => {
  const rows = Array.from({ length: 20 }, (_unused, index) => ({ content: `row ${index}` }))
  const h = await mountHistoryPane(t, { rows })
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the page settled')
  h.key(PAGE_DOWN)
  await h.painted(() => h.selected()[0]?.includes('row 6') === true, 'one page moved by the frozen page step')
  h.key(PAGE_DOWN)
  h.key(PAGE_DOWN)
  h.key(PAGE_DOWN)
  await h.painted(() => h.selected()[0]?.includes('row 19') === true, 'the last row clamps the page walk')
  assert.equal(h.composer().text, '', 'and paging never wrote the draft')
})

test('Alt arrows scroll the Preview container only and never move the selection', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the page settled')
  const selectedBefore = h.selected()
  const before = h.ops('scroll').length
  h.key(ALT_UP)
  await h.painted(() => h.ops('scroll').length > before, 'the mount issued a native scroll op')
  assert.ok(String(h.ops('scroll').at(-1)?.[1]).endsWith('-preview-scroll'),
    'addressed at the Preview container of this frame')
  assert.equal(String(h.ops('scroll').at(-1)?.[2]), 'line-up', 'one line up')
  h.key(ALT_UP)
  await h.painted(() => h.ops('scroll').length > before + 1, 'a second scroll op')
  assert.deepEqual(h.selected(), selectedBefore, 'the result highlight never moved')
  assert.equal(h.calls.submits, 0, 'and no scroll gesture leaked into a submission')
})

test('F2 toggles the SAME card with its query and selection, never a second surface', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('o')
  h.key('n')
  h.key('e')
  await h.painted(() => h.requests.at(-1)?.query === 'one', 'the typed round')
  const queryBefore = h.queryField()?.text
  const selectedBefore = h.selected()
  const surfacesBefore = h.pane.openSurfaces().length
  h.key(F2)
  await h.painted(() => h.texts().includes('Collapse'), 'the same card states its expanded height')
  assert.equal(h.cardSerials().length, 1, 'still one card, same frame')
  assert.equal(h.queryField()?.text, queryBefore, 'the query survived the toggle')
  assert.deepEqual(h.selected(), selectedBefore, 'the selection survived the toggle')
  assert.equal(h.pane.openSurfaces().length, surfacesBefore, 'and no second SDK surface was opened for it')
  h.key(F2)
  await h.painted(() => h.texts().includes('Expand'), 'and back to the normal presentation')
})

test('a second Ctrl+R keeps ONE live card instance and starts no new read', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('t')
  h.key('e')
  h.key('r')
  h.key('n')
  await h.painted(() => h.requests.at(-1)?.query === 'tern', 'the typed round')
  const requestsBefore = h.requests.length
  const serialBefore = h.cardSerials()[0]
  h.key(CTRL_R)
  await h.painted(() => h.ops('focus').at(-1)?.[1]?.endsWith('-query') === true, 'the caret went back to the query')
  assert.equal(h.requests.length, requestsBefore, 'no second open re-queried the source')
  assert.equal(h.cardSerials().length, 1, 'still exactly one card')
  assert.equal(h.cardSerials()[0], serialBefore, 'the SAME instance, not a replacement')
  assert.equal(h.queryField()?.text, 'tern', 'its query and selection stayed put')
})

// ── D. The pointer contract ──────────────────────────────────────────────────

test('a result row click selects only; the explicit Restore button is the one composer write', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.ids(/-o\d$/).length === 3, 'the settled page painted three real el buttons')
  const rows = h.ids(/-o\d$/)
  assert.equal(rows.length, 3, 'three result rows, each an el button')
  h.click(rows[1]!)
  await h.painted(() => h.selected()[0]?.includes('beta two') === true, 'the row click moved the selection')
  assert.equal(h.composer().text, '', 'a row click never writes the composer')
  assert.equal(h.calls.submits, 0, 'and never submits')
  const restore = h.ids(/-restore$/)[0]
  assert.ok(restore !== undefined, 'the card carries one real Restore button')
  h.click(restore!)
  await h.painted(() => h.composer().text !== '', 'the restore committed')
  assert.equal(h.composer().text, 'beta two about tern', 'the row the pointer selected, byte for byte')
  assert.equal(h.cardPainted(), false, 'and the card closed')
  assert.equal(h.calls.submits, 0, 'still zero submissions from the whole pointer walk')
})

test('a click addressed at a retired frame acts on nothing — not the row, not the Restore button', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.ids(/-o\d$/).length === 3, 'the first page')
  const staleRow = h.ids(/-o\d$/)[2]!
  const staleRestore = h.ids(/-restore$/)[0]!
  h.key('t')
  h.key('e')
  h.key('r')
  h.key('n')
  await h.painted(() => h.requests.at(-1)?.query === 'tern', 'the newer round reached the source')
  await h.painted(() => h.selected()[0]?.includes('beta two') === true, 'the newer round repainted its own ids')
  assert.notEqual(h.ids(/-o\d$/)[0], staleRow, 'the live row id belongs to a NEWER frame')
  h.click(staleRow)
  await h.observeAbsence()
  assert.deepEqual(h.selected(), ['›beta two about tern'], 'the stale row click did not reselect')
  h.click(staleRestore)
  await h.observeAbsence()
  assert.equal(h.composer().text, '', 'the stale Restore click wrote no composer text')
  assert.equal(h.cardPainted(), true, 'and did not close the live card either')
  assert.equal(h.calls.submits, 0, 'and it never became a submission')
})

test('Scope, Expand, Close and Copy are el buttons whose click runs exactly one intent', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.ids(/-scope$/).length === 1, 'the Scope control is one el button, not blue text')
  h.click(h.ids(/-scope$/)[0]!)
  await h.painted(() => h.requests.at(-1)?.scope === 'current', 'the Scope click re-queried through the same intent')
  h.click(h.ids(/-expand$/)[0]!)
  await h.painted(() => h.texts().includes('Collapse'), 'the Expand click toggled the same card')
  h.click(h.ids(/-copy$/)[0]!)
  await h.painted(() => h.copies.length === 1, 'the Copy click reached the copy policy')
  assert.deepEqual(h.copies, ['alpha one'], 'the raw stored content, not a rendered row')
  assert.equal(h.cardPainted(), true, 'a copy never closes the card')
  h.click(h.ids(/-close$/)[0]!)
  await h.painted(() => !h.cardPainted(), 'the Close click removed the card')
  assert.equal(h.calls.cancels, 0, 'and the close was never an Agent cancel')
})

test('a stale Scope-frame click cannot re-scope the live card or start an older round', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.ids(/-scope$/).length === 1, 'the first frame')
  const staleScope = h.ids(/-scope$/)[0]!
  h.key(TAB)
  await h.painted(() => h.requests.at(-1)?.scope === 'current', 'the keyboard switch worked')
  const roundsBefore = h.requests.length
  h.click(staleScope)
  await h.observeAbsence()
  assert.equal(h.requests.length, roundsBefore, 'the stale Scope click started no new round')
  assert.ok(h.texts().includes('Scope: Directory ⌄'), 'the card still reads the live scope')
})

// ── E. Copy is the existing Client-local policy ──────────────────────────────

test('Alt+C copies the exact stored text, keeps the card open and states the outcome', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the page settled')
  h.key(DOWN)
  await h.painted(() => h.selected()[0]?.includes('beta two') === true, 'the selection moved')
  h.key(ALT_C)
  await h.painted(() => h.copies.length === 1, 'the copy settled')
  assert.deepEqual(h.copies, ['beta two about tern'], 'the raw content of the selected row')
  assert.equal(h.cardPainted(), true, 'Copy keeps the seat live')
  await h.painted(() => h.texts().some(text => text.includes('Copied the history entry')), 'the outcome notice painted')
  assert.equal(h.calls.submits, 0, 'a copy never became a submission')
  assert.equal(h.composer().text, '', 'and never wrote the draft')
})

test('a failed copy is stated as a failure, not as a success', async (t) => {
  const h = await mountHistoryPane(t, { copyOk: false })
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the page settled')
  const copy = h.ids(/-copy$/)[0]
  assert.ok(copy !== undefined, 'Copy all is one el button')
  assert.equal((wireNodes(h.pane).find(node => node.id === copy)?.p['attrs'] as Record<string, unknown> | undefined)?.['aria-disabled'],
    undefined, 'Copy is enabled while a settled row is selected')
  h.key(ALT_C)
  await h.painted(() => h.texts().some(text => text.includes('Failed to copy the history entry')), 'the failure stated')
  assert.equal(h.copies.length, 1, 'one write attempt')
  assert.equal(h.cardPainted(), true, 'a failed copy still keeps the seat live')
})

test('a Copy outcome whose captured scope went stale never announces itself onto the newer owner', async (t) => {
  let current = true
  let resolveCopy: ((copied: boolean) => void) | undefined
  const pane = installTspPane({ composerActions: true, historySearch: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects')
  const renderer = mountTspRenderer(session, {
    copyVisual: () => new Promise<boolean>(resolve => { resolveCopy = resolve }),
    requestExit: () => {},
    onFatal: (error) => { throw error },
  })
  t.after(() => renderer.dispose())
  const scripted = scriptSource(DEFAULT_ROWS)
  renderer.bindHistorySearch({
    source: scripted.source,
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => current }),
  })
  renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {},
    listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker: () => {},
    openModelQuick: () => {}, openSessionBrowser: () => {}, sessionBrowserAvailable: () => false,
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the composer frame', () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  const copyNotices = () => surfaceTexts(pane, 's1').filter(text => /Copied|Failed to copy the history/.test(text))
  pane.key(CTRL_R)
  await waitUntil('the card opened', () => surfaceTexts(pane, 's1').some(text => text === 'Results · 3 shown'))
  pane.key(ALT_C)
  await waitUntil('the copy started', () => resolveCopy !== undefined)
  assert.equal(copyNotices().length, 0, 'nothing announced before the settlement')
  current = false
  resolveCopy!(true)
  // reason: a refused settlement writes no frame, so the only observation is a
  // bounded window over the copy callback plus a later committed repaint.
  await settle(ABSENCE_WINDOW_MS)
  assert.equal(copyNotices().length, 0, 'the stale settlement stated nothing on the dock')
})

// ── F. Seat priority ─────────────────────────────────────────────────────────

test('an open card retires synchronously when a non-blocking Presenter takes the seat', async (t) => {
  const h = await mountHistoryPane(t, { modelPicker: true })
  h.key(CTRL_R)
  await h.painted(() => h.cardPainted(), 'the card is up')
  const requestsBefore = h.requests.length
  const opened = h.renderer.modelPresentation?.open({
    subject: { sessionId: 'ses_a', sessionless: false },
    isCurrent: () => true,
    apply: () => Promise.resolve({ outcome: 'committed' } as never),
    retry: () => {},
    runOwned: (_label: string, run: () => Promise<unknown>) => ({ promise: run(), settle: () => {} }),
    close: () => {},
  } as never)
  assert.ok(opened !== undefined, 'the model presenter opened through the production sweep')
  await h.painted(() => !h.cardPainted(), 'the sweep retired the card in the SAME synchronous stack')
  assert.equal(h.requests.length, requestsBefore, 'and its in-flight read went with it')
  assert.equal(h.calls.submits, 0, 'no hidden card wrote anything')
  h.key(ENTER)
  await h.observeAbsence()
  assert.equal(h.composer().text, '', 'a retired card never restores on the Presenter keys')
})

test('a Modal parks the SAME card with its query and selection and it returns when the form settles', async (t) => {
  const h = await mountHistoryPane(t, { nativeInteraction: true })
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('o')
  h.key('n')
  h.key('e')
  await h.painted(() => h.requests.at(-1)?.query === 'one', 'the typed round settled')
  const selectedBefore = h.selected()
  assert.equal(selectedBefore.length, 1, 'the filtered page has one selected row')

  let settled = false
  const outcome = h.renderer.interaction.showApprovalPrompt(
    { toolName: 'tool-a', reason: 'park check', arguments: '{}' }, true)
  void outcome.then(() => { settled = true })
  await h.painted(() => !h.cardPainted(), 'the modal took the seat')
  assert.equal(h.cardPainted(), false, 'a parked card paints no operable rows')
  assert.ok(h.texts().some(text => text.includes('park check')), 'the form itself is what the pane shows')

  h.key(ENTER)
  await h.observeAbsence()
  assert.equal(h.composer().text, '', 'the History restore did not fire under the Modal')
  assert.equal(h.calls.submits, 0, 'and Enter never became a submission')
  h.key(CTRL_R)
  await h.observeAbsence()
  assert.equal(h.cardPainted(), false, 'Ctrl+R does not reopen a parked card')

  h.key('y')
  await h.painted(() => settled, 'the approval settled')
  await h.painted(() => h.cardPainted(), 'the card came back')
  assert.equal(h.queryField()?.text, 'one', 'the SAME instance returned with its query')
  assert.deepEqual(h.selected(), selectedBefore, 'and its selection')
  assert.ok(h.ops('focus').at(-1)?.[1]?.endsWith('-query'), 'and the caret came back to it')
  assert.equal(h.composer().text, '', 'the parked card still wrote no draft')
})

test('a card whose captured Session scope stopped being current restores nothing and leaves the frame', async (t) => {
  let current = true
  const h = await mountHistoryPane(t, { isCurrent: () => current })
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the card is up while the captured scope is current')
  current = false
  h.renderer.display.beginSessionHydration()
  await h.painted(() => !h.cardPainted(), 'the publication commit withdrew the card')
  assert.equal(h.cardPainted(), false, 'the stale card left the frame')
  h.key(ENTER)
  await h.observeAbsence()
  assert.equal(h.composer().text, '', 'the stale restore wrote nothing')
  assert.equal(h.calls.submits, 0, 'and Enter did not degrade into a submission of an empty draft either')
})

test('a late answer for a retired round commits nothing even when the source ignored its abort', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.key('h')
  h.key('o')
  h.key('l')
  h.key('d')
  await h.painted(() => h.requests.at(-1)?.query === 'hold', 'the held round started')
  h.key(ESCAPE)
  await h.painted(() => !h.cardPainted(), 'the card closed')
  h.resolveHeld({
    results: [{
      id: 'ghost:0', content: 'ghost row from a retired round', cwd: '/work/alpha',
      ts: 1_800_000_000_000, sourceFile: 'ghost', sourceByteOffset: 0,
    }],
    exhausted: true,
  })
  await h.observeAbsence()
  assert.equal(h.cardPainted(), false, 'the retired card did not come back')
  assert.equal(h.texts().some(text => text.includes('ghost row')), false, 'and its rows were never painted')
  assert.equal(h.composer().text, '', 'nothing was restored from it either')
})

// ── G. States that must not lie ──────────────────────────────────────────────

test('a failed read states the failure with one Retry and is never dressed up as empty history', async (t) => {
  let fail = true
  const seen: string[] = []
  const pane = installTspPane({ composerActions: true, historySearch: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects')
  const renderer = mountTspRenderer(session, { copyVisual: async () => true, requestExit: () => {}, onFatal: e => { throw e } })
  t.after(() => renderer.dispose())
  renderer.bindHistorySearch({
    source: {
      search(request: HistorySearchRequest): Promise<HistorySearchPage> {
        seen.push(request.query)
        if (fail) return Promise.reject(new Error('simulated read failure'))
        return Promise.resolve({
          results: [{ id: 'r:0', content: `recovered ${request.query}`, cwd: '/work/alpha', ts: 1, sourceFile: 'r', sourceByteOffset: 0 }],
          exhausted: true,
        })
      },
    },
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => true }),
  })
  renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {},
    listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker: () => {},
    openModelQuick: () => {}, openSessionBrowser: () => {}, sessionBrowserAvailable: () => false,
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the composer frame', () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  const texts = () => surfaceTexts(pane, 's1')
  const ids = (match: RegExp) => wireNodes(pane).map(node => node.id).filter(id => match.test(id))

  pane.key(CTRL_R)
  await waitUntil('the failure painted', () => texts().includes('Could not search input history.'))
  assert.equal(texts().includes('No input history in this scope.'), false,
    'a failed read is never reported as an empty history')
  assert.equal(texts().some(text => text.startsWith('Results ·')), false, 'no match counter is claimed either')
  assert.equal(texts().filter(text => text === 'Could not search input history.').length, 1,
    'the failure is stated exactly once on the frame')
  assert.equal(ids(/-retry$/).length, 1, 'the failed state offers exactly one Retry')
  fail = false
  clickNodeById(pane, ids(/-retry$/)[0]!)
  await waitUntil('the retry re-read the current query', () => texts().some(text => text.includes('recovered')))
  assert.equal(texts().includes('Could not search input history.'), false, 'the failure row went away')
  assert.deepEqual(seen, ['', ''], 'Retry re-sent the CURRENT scope and query and nothing else')
})

test('an empty page and a non-exhaustive page each state their own truth', async (t) => {
  const empty = await mountHistoryPane(t, { rows: [] })
  empty.key(CTRL_R)
  await empty.painted(() => empty.texts().includes('No input history in this scope.'),
    'an exhausted empty page says so')
  empty.key('z')
  empty.key('z')
  empty.key('z')
  await empty.painted(() => empty.requests.at(-1)?.query === 'zzz', 'the filter round')
  await empty.painted(() => empty.texts().includes('No matching history.'), 'a query that exhausted the scan')
  await empty.dispose()

})

test('a non-exhaustive first page counts the SHOWN rows and names the remaining budget, never a total', async (t) => {
  // The scripted pane decodes ONE un-chunked APC frame (its hello `apc` is
  // 65536), so this page is bounded to what that pane can carry; the row CAP
  // the seat asks the source for is asserted separately below.
  const reads: HistorySearchRequest[] = []
  // The obligation is the source's OWN row cap (200): the seat must neither
  // auto-chase the continuation nor describe the shown page as a global total.
  const shown = HISTORY_SEARCH_RESULT_LIMIT
  const h = await mountHistoryPane(t, {
    binding: {
      source: {
        search: (request: HistorySearchRequest) => {
          reads.push(request)
          return Promise.resolve({
            results: Array.from({ length: shown }, (_unused, index) => ({
              id: `big.jsonl:${index}`,
              content: `scanned row ${index}`,
              cwd: '/work/alpha',
              ts: 1_700_000_000_000 + index,
              sourceFile: 'big.jsonl',
              sourceByteOffset: index,
            })),
            // `exhausted: false` with NO continuation is the honest double:
            // older history remains, and the seat must not auto-chase it.
            exhausted: false,
          })
        },
      },
      cwd: () => '/work/alpha',
      captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => true }),
    },
  })
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text === `Results · ${shown} shown · older history may remain`),
    'the counter names the SHOWN page and the remaining budget')
  assert.equal(reads.at(-1)?.limit, HISTORY_SEARCH_RESULT_LIMIT,
    'the source row cap was requested, never a scan count')
  assert.equal(reads.at(-1)?.query, '', 'for the current query')
  assert.equal(reads.length, 1, 'the first page is ONE read: the continuation is never auto-chased')
  assert.equal(h.ids(/-o\d+$/).length, shown, 'every row of the full page is a real painted cell')
  // A full page then walks: the deep row is reachable by paging, and each real
  // move revealed the row node of the CURRENT frame.
  const revealsBefore = h.ops('reveal').length
  for (let step = 0; step < 40; step += 1) h.key(DOWN)
  await h.painted(() => h.ops('reveal').length > revealsBefore + 30, 'the walk revealed each moved row')
  await h.painted(() => h.selected()[0]?.includes('scanned row 40') === true, 'the walk arrived')
  h.key(ENTER)
  await h.painted(() => h.composer().text.includes('scanned row 40'), 'and the deep row restored')
})

test('untrusted history text reaches the frame only as sanitized display while Copy keeps the raw bytes', async (t) => {
  const hostile = 'a\u001b]52;cOSC52PROBE\u0007b\u001b[31mc\r\u0000d'
  const h = await mountHistoryPane(t, { rows: [{ content: hostile, cwd: '/we/ird\u001b[1mpath' }] })
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the hostile row painted')
  const painted = JSON.stringify(h.texts())
  assert.equal(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(painted), false,
    `no control byte reached a painted cell: ${painted.slice(0, 240)}`)
  const wire = h.pane.output.text()
  assert.equal(wire.includes('OSC52PROBE'), false, 'the hostile copy payload never became an OSC 52 write')
  await h.key(ALT_C)
  await h.painted(() => h.copies.length === 1, 'the copy settled')
  assert.deepEqual(h.copies, [hostile], 'Copy still carries the EXACT stored bytes, control included')
})

test('a long entry stays fully readable in the Preview and is restored whole, never truncated', async (t) => {
  const long = `line one\n${'x'.repeat(4000)}\nline three`
  const h = await mountHistoryPane(t, { rows: [{ content: long }] })
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text.includes('line three')), 'the last source line is painted')
  assert.equal(h.texts().some(text => text.includes('… more')), false, 'nothing advertises a truncated preview')
  h.key(ENTER)
  await h.painted(() => h.composer().text !== '', 'the restore landed')
  assert.equal(h.composer().text, long, 'the whole original text restored, byte for byte')
})

// ── H. Untrusted source text can never reach a painted cell ────────────────

test('a hostile cwd and session id in the source row never reach painted text, title or aria', async (t) => {
  // A legacy or hand-edited JSONL row is UNTRUSTED text: the PiTui panel folds
  // its cwd and session id before painting them, and the TSP card must not be
  // the weaker of the two renderers.
  const hostileCwd = '/we/ird\u001b]52;c;QUVDNTJfRlJPTV9DV0Q\u0007path\u0008tail'
  const hostileSession = 'ses\u001b[31m_injected'
  const h = await mountHistoryPane(t, {
    rows: [{ content: 'a row with hostile metadata', cwd: hostileCwd, sessionId: hostileSession }],
  })
  h.key(CTRL_R)
  await h.painted(() => h.texts().some(text => text.includes('a row with hostile metadata')), 'the hostile row painted')
  // The RAW painted values are what the client receives: JSON.stringify would
  // escape a control byte into a literal \u001b sequence and hide the very
  // defect this case exists to catch. Each value is scanned ON ITS OWN — joining
  // them would inject the line break the predicate forbids.
  const control = (text: string): boolean => /[\u0000-\u0008\u0009\u000b-\u001f\u007f-\u009f]/u.test(text)
  const offenders = h.texts().filter(control)
  assert.deepEqual(offenders, [],
    `no control byte reached a painted cell: ${JSON.stringify(offenders).slice(0, 300)}`)
  const attrs = wireNodes(h.pane)
    .flatMap(node => [String(node.p.title ?? ''), String(node.p.aria ?? '')])
    .join('\n')
  assert.equal(attrs.includes('QUVDNTJfRlJPTV9DV0Q'), false, 'the hostile cwd never becomes an OSC 52 payload in a title/aria')
  assert.equal(/\u001b\]52;/.test(attrs), false, `no raw OSC sequence reached an attribute: ${JSON.stringify(attrs).slice(0, 240)}`)
  assert.equal(/\u001b\[31m/.test(attrs), false, 'the hostile session id never carries an SGR sequence into an attribute')
  await h.key(ALT_C)
  await h.painted(() => h.copies.length === 1, 'the copy settled')
  assert.deepEqual(h.copies, ['a row with hostile metadata'], 'the row CONTENT still copies byte-exact: sanitizing metadata never touched the payload')
})

test('a control byte typed into the query is projected to display text, never carried into the field or the source query', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  // The SDK decodes 0x01..0x1a to a ctrl+letter Key, so the only printable text
  // a query can receive is real text; a C1 byte arriving as key.text must still
  // be projected, and a bracketed paste must collapse to one line.
  h.pane.key('a\u001b[200~line-one\nline-two\u001b[201~')
  await h.painted(() => (h.queryField()?.text ?? '').includes('line-one'), 'the pasted text reached the query field')
  await h.painted(() => (h.queryField()?.text ?? '').includes('line-one'), 'the pasted text reached the query field')
  const field = h.queryField()
  assert.equal(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(field?.text ?? ''), false,
    `the query field carries no control byte: ${JSON.stringify(field)}`)
  assert.equal(field?.text.includes('\n'), false, 'a pasted line break never becomes a second query line')
  await h.painted(() => h.requests.length >= 2, 'the debounced round started')
  assert.equal(h.requests.at(-1)?.query.includes('\n'), false, 'and the source query stays one line')
})

test('a read that settles while a Modal parks the card keeps the SAME instance and its page', async (t) => {
  // The park window is exactly where the old code destroyed the card: the
  // mount's seat admission is false under a Modal, and the settlement read it.
  const h = await mountHistoryPane(t, { nativeInteraction: true })
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round started')
  h.holdNext()
  h.key('t')
  h.key('e')
  h.key('r')
  h.key('n')
  await h.painted(() => h.requests.at(-1)?.query === 'tern', 'the held round started')
  let settled = false
  const outcome = h.renderer.interaction.showApprovalPrompt(
    { toolName: 'tool-a', reason: 'park window', arguments: '{}' }, true)
  void outcome.then(() => { settled = true })
  await h.painted(() => !h.cardPainted(), 'the modal parked the card')
  // The read answers UNDER the modal.
  h.resolveHeld({
    results: [{ id: 'held:0', content: 'tern row answered under the modal', cwd: '/work/alpha',
      ts: 1_800_000_000_000, sessionId: 'ses_a', sourceFile: 'held', sourceByteOffset: 0 }],
    exhausted: true,
  })
  await h.observeAbsence()
  assert.equal(h.cardPainted(), false, 'a parked card still paints no operable rows')
  h.key('y')
  await h.painted(() => settled, 'the approval settled')
  await h.painted(() => h.cardPainted(), 'the SAME card came back')
  assert.deepEqual(h.queryField(), { text: 'tern', cursor: 4 }, 'with its query and caret intact')
  assert.ok(h.texts().some(text => text.includes('tern row answered under the modal')),
    'and the page that settled under the Modal is the page it shows')
  assert.equal(h.composer().text, '', 'the parked window wrote no draft')
})

test('a copy that settles while a Modal parks the card still states its outcome', async (t) => {
  // The window is a copy that STARTS while the card is open and ANSWERS under a
  // park: the clipboard write already happened, so dropping the notice is not
  // conservative — the user pressed Alt+C and got silence. A park changes none
  // of the four facts the outcome depends on (same card, same round, same row,
  // still-current scope), so it must still announce.
  let resolveCopy: ((copied: boolean) => void) | undefined
  const pane = installTspPane({ composerActions: true, historySearch: true, nativeInteraction: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects')
  const copied: string[] = []
  const renderer = mountTspRenderer(session, {
    copyVisual: (text) => { copied.push(text); return new Promise<boolean>(resolve => { resolveCopy = resolve }) },
    requestExit: () => {},
    onFatal: (error) => { throw error },
  })
  t.after(() => renderer.dispose())
  const scripted = scriptSource(DEFAULT_ROWS)
  renderer.bindHistorySearch({
    source: scripted.source,
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => true }),
  })
  renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {},
    listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker: () => {},
    openModelQuick: () => {}, openSessionBrowser: () => {}, sessionBrowserAvailable: () => false,
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the composer frame', () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  const notices = () => surfaceTexts(pane, 's1').filter(text => /Copied|Failed to copy the history/.test(text))
  pane.key(CTRL_R)
  await waitUntil('the page settled', () => surfaceTexts(pane, 's1').some(text => text === 'Results · 3 shown'))
  pane.key(ALT_C)
  await waitUntil('the copy call is in flight', () => copied.length === 1)
  // A tool approval arrives while the copy promise is still open.
  let settled = false
  const outcome = renderer.interaction.showApprovalPrompt(
    { toolName: 'tool-a', reason: 'copy settles under a park', arguments: '{}' }, true)
  void outcome.then(() => { settled = true })
  await waitUntil('the modal parked the card', () => !surfaceTexts(pane, 's1').includes('Input History'))
  resolveCopy?.(true)
  await waitUntil('the outcome is announced under the park', () => notices().includes('Copied the history entry'))
  assert.equal(surfaceTexts(pane, 's1').includes('Input History'), false,
    'and announcing it did not bring the parked card back')
  // The notice is a base-surface fact while the Modal layer is above it, so the
  // user-visible claim is made where the user can see it: after the form closes.
  pane.key('y')
  await waitUntil('the approval settled', () => settled)
  await waitUntil('the same card returned', () => surfaceTexts(pane, 's1').includes('Input History'))
  assert.ok(notices().includes('Copied the history entry'),
    'the outcome is still stated once the blocker is gone')
  assert.equal(wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'
    && String((node.p as { text?: string }).text ?? '') !== ''), false, 'a copy never writes the draft')
})

test('a retirement the settlement performs owns the frame it asks for too', async (t) => {
  // The fence and the commit share one failure owner: `retireDiscovered()` asks
  // the mount for the frame that removes the card, so if THAT frame throws the
  // error still reaches the fatal owner instead of escaping the chain the seat
  // started. This is the case that fails when the fence sits outside the `try`.
  const fatal: unknown[] = []
  const rejections: unknown[] = []
  let current = true
  let release: ((page: HistorySearchPage) => void) | undefined
  let frames = 0
  const seat = createTspHistorySearch({
    admitted: () => true,
    requestRender: () => {
      frames += 1
      // The open frame is allowed; the retirement frame the dead-scope fence
      // owes is the one that throws, exactly like a broken tty owner.
      if (frames > 1) throw new Error('simulated ViewError on the retirement frame')
    },
    setFocus: () => {},
    restoreToComposer: () => {},
    copyRaw: () => {},
    reveal: () => {},
    scroll: () => {},
    reportFatal: (error) => { fatal.push(error) },
  }, {
    source: {
      search: () => new Promise<HistorySearchPage>(resolve => { release = resolve }),
    },
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => current }),
  }, () => true)
  process.on('unhandledRejection', (reason) => { rejections.push(reason) })
  t.after(() => {
    process.removeAllListeners('unhandledRejection')
    seat.retire()
  })
  seat.open()
  current = false
  release?.({ results: [], exhausted: true })
  await settle(ABSENCE_WINDOW_MS)
  assert.equal(fatal.length, 1, 'the retirement frame\u2019s failure reached the fatal owner')
  assert.match(String((fatal[0] as Error)?.message ?? ''), /simulated ViewError on the retirement frame/)
  assert.deepEqual(rejections, [], 'and nothing escaped as an unhandled rejection')
  assert.equal(seat.renderState(), undefined, 'the card is gone regardless')
})

test('the seat routes a frame commit that throws in its OWN settlement to the fatal owner', async (t) => {
  // Isolated at the seat boundary: the mount's input loop would ALSO surface a
  // ViewError, so an end-to-end run cannot tell the two owners apart. Here the
  // only possible witness is the seat's own `reportFatal` port.
  const fatal: unknown[] = []
  let renders = 0
  const seat = createTspHistorySearch({
    admitted: () => true,
    requestRender: () => { renders += 1; if (renders > 1) throw new Error('simulated ViewError on the settled frame') },
    setFocus: () => {},
    restoreToComposer: () => {},
    copyRaw: () => {},
    reveal: () => {},
    scroll: () => {},
    reportFatal: (error) => { fatal.push(error) },
  }, {
    source: {
      search: () => Promise.resolve({
        results: [{ id: 'x:0', content: 'one settled row', cwd: '/work/alpha', ts: 1_700_000_000_000,
          sessionId: 'ses_a', sourceFile: 'x', sourceByteOffset: 0 }],
        exhausted: true,
      }),
    },
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => true }),
  }, () => true)
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  t.after(() => { process.off('unhandledRejection', onRejection); seat.retire() })
  seat.open()
  await settle(ABSENCE_WINDOW_MS)
  assert.equal(fatal.length, 1, 'the frame the settlement owed failed exactly once, and the seat reported it')
  assert.match(String((fatal[0] as Error)?.message ?? fatal[0] ?? ''), /simulated ViewError/,
    'the PRIMARY error reached the fatal owner')
  assert.deepEqual(rejections, [], 'and no unhandled rejection escaped the chain the seat started')
  assert.equal(seat.renderState()?.rows.length, 1, 'the page the source answered is still the seat state')
})

test('a read that answers after its captured scope died is refused by the settlement, which retires the round and aborts its controller', async (t) => {
  // Isolated at the seat boundary: no mount, no presentation guard, no outer
  // retirement. The scope authority goes stale while the read is in flight and
  // NOTHING else tells the seat about it, so the settlement's own captured-scope
  // re-check is the only thing that can refuse the page and retire the round.
  const fatal: unknown[] = []
  let current = true
  let release: ((page: HistorySearchPage) => void) | undefined
  const signals: Array<AbortSignal | undefined> = []
  const seat = createTspHistorySearch({
    admitted: () => true,
    requestRender: () => {},
    setFocus: () => {},
    restoreToComposer: () => {},
    copyRaw: () => {},
    reveal: () => {},
    scroll: () => {},
    reportFatal: (error) => { fatal.push(error) },
  }, {
    source: {
      search: (request: HistorySearchRequest) => {
        signals.push(request.signal)
        return new Promise<HistorySearchPage>(resolve => { release = resolve })
      },
    },
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => current }),
  }, () => true)
  seat.open()
  assert.equal(signals.length, 1, 'the open read started')
  // The scope dies with nobody telling the seat, then the page answers.
  current = false
  release?.({ results: [{ id: 'late:0', content: 'a page from the dead scope', cwd: '/work/alpha',
    ts: 1_700_000_000_000, sessionId: 'ses_a', sourceFile: 'late', sourceByteOffset: 0 }], exhausted: true })
  await settle(ABSENCE_WINDOW_MS)
  assert.equal(signals[0]?.aborted, true,
    'the settlement retired the round, and retirement aborts this read\u2019s controller')
  assert.deepEqual(fatal, [], 'refusing a dead scope is not a failure')
  assert.equal(seat.renderState(), undefined, 'the card is gone')
  assert.equal(seat.isOpen(), false, 'it owns no keys, no caret and no Composer seat')
  // The refused page must also not be carried into the next card.
  current = true
  seat.open()
  assert.equal(signals.length, 2, 'a reopened card starts its own read')
  assert.equal(seat.renderState()?.rows.length, 0, 'and nothing from the dead scope is in it')
})

test('the mount wires the seat\u2019s fatal port to its own fatal owner (end-to-end)', async (t) => {
  // This case proves the WIRING on the real SDK mount: an error the seat reports
  // reaches `onFatal`. It deliberately does NOT prove the seat owns the failure
  // (the SDK's own loop routes the same ViewError here too), which is the
  // seat-isolated case above's job.
  // The seat OWNS both settlement branches, so the only remaining failure is the
  // frame it owes. `surface.render` raises a ViewError; that PRIMARY error must
  // reach the runner's fatal lifecycle (the pane's tty owner is broken), never
  // an unhandled rejection on the chain the seat started and never a silent
  // "failed read" story.
  const pane = installTspPane({ composerActions: true, historySearch: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane connects')
  let fatal: unknown
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => true,
    requestExit: () => {},
    onFatal: (error) => { fatal = error },
  })
  t.after(() => renderer.dispose())
  const scripted = scriptSource(DEFAULT_ROWS)
  renderer.bindHistorySearch({
    source: scripted.source,
    cwd: () => '/work/alpha',
    captureScope: () => ({ sessionId: 'ses_a', isCurrent: () => true }),
  })
  renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {},
    listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker: () => {},
    openModelQuick: () => {}, openSessionBrowser: () => {}, sessionBrowserAvailable: () => false,
  })
  renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the composer frame', () => wireNodes(pane).some(node => node.id === 'dock.quiet-composer.composer'))
  const surface = session.surfaces[0]
  assert.ok(surface !== undefined, 'the mount opened its surface')
  const originalRender = surface.render.bind(surface)
  let trips = 0
  surface.render = (view: Parameters<typeof originalRender>[0]) => {
    // Fail ONLY the frame a settled read owes, so the case is about the
    // settlement's failure ownership, not about a broken mount.
    if (trips === 0) { trips += 1; throw new Error('simulated ViewError on the settled frame') }
    return originalRender(view)
  }
  const previousRejections: unknown[] = []
  const onRejection = (reason: unknown): void => { previousRejections.push(reason) }
  process.once('unhandledRejection', onRejection)
  pane.key(CTRL_R)
  await waitUntil('the fatal owner saw the settlement failure', () => fatal !== undefined, 10_000)
  await settle(ABSENCE_WINDOW_MS)
  process.off('unhandledRejection', onRejection)
  assert.match(String((fatal as Error)?.message ?? fatal ?? ''), /simulated ViewError/,
    'the PRIMARY error reached the fatal lifecycle')
  assert.deepEqual(previousRejections, [], 'and no unhandled rejection escaped the seat-owned chain')
  surface.render = originalRender
})

test('a row click and the arrow walk are refused while a newer round is in flight', async (t) => {
  // The page on screen belongs to the PREVIOUS query. Plan §5.2.2: a new round
  // clears the OLD page's operable identity, so a lagging pointer or an early
  // arrow can never select a row the user has already typed past.
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the settled page painted with a selection')
  const before = h.selected()[0] ?? ''
  h.holdNext()
  h.key('n')
  await h.painted(() => h.requests.at(-1)?.query === 'n', 'the newer round started')
  await h.painted(() => h.texts().some(text => text === 'Searching…'), 'and the header says Searching')
  const rowIds = h.ids(/-o\d+$/)
  assert.ok(rowIds.length > 0, 'the previous page is still PAINTED (visual continuity, not a blank shell)')
  h.click(rowIds[1] ?? rowIds[0])
  h.key(DOWN)
  await h.observeAbsence()
  assert.equal(h.selected()[0] ?? '', before, 'neither the click nor the arrow moved the selection')
  h.resolveHeld({ results: [], exhausted: true })
  await h.painted(() => h.texts().some(text => text === 'No matching history.'), 'the new page arrived')
})

test('a bracketed paste at a mid-query caret keeps the caret after the pasted run', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.requests.length === 1, 'the first round')
  h.pane.key('tern')
  await h.painted(() => h.queryField()?.text === 'tern', 'the query holds tern')
  h.key(LEFT)
  h.key(LEFT)
  h.key(LEFT)
  await h.painted(() => h.queryField()?.cursor === 1, 'the caret moved to index 1')
  h.pane.key('\u001b[200~XY\u001b[201~')
  await h.painted(() => h.queryField()?.text === 'tXYern', 'the paste landed at the caret')
  assert.deepEqual(h.queryField(), { text: 'tXYern', cursor: 3 },
    'the caret sits after the PASTED RUN, not at the end of the whole query')
})

test('a Composer focus event while the card owns the seat re-asserts the query caret', async (t) => {
  // The card does not cover the Composer, so a click there really does make the
  // client focus the editor node. The keyboard owner is still the card, so the
  // ONE focus decision must come back to the query instead of leaving the caret
  // in a field the seat will not type into.
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.queryField() !== undefined, 'the card opened with its query focused')
  const focusBefore = h.ops('focus').length
  h.pane.event({ ev: 'focus', sf: 's1', id: 'dock.quiet-composer.composer' })
  await h.painted(() => h.ops('focus').length > focusBefore, 'the focus decision was re-asserted')
  assert.ok(String(h.ops('focus').at(-1)?.[1] ?? '').endsWith('-query'),
    `and it went back to the query, not the Composer: ${JSON.stringify(h.ops('focus').at(-1))}`)
  h.key('x')
  await h.painted(() => (h.queryField()?.text ?? '').includes('x'), 'typing still edits the query')
  assert.equal(h.composer().text, '', 'and never the draft')
})

// ── H. The composer chrome stays honest while the card owns the seat ─────────

test('while the card owns the seat the composer Send is painted disabled and its click writes nothing', async (t) => {
  const h = await mountHistoryPane(t)
  h.key('draft')
  await h.painted(() => h.composer().text === 'draft', 'the draft reached the editor')
  h.key(CTRL_R)
  await h.painted(() => h.cardPainted(), 'the card opened')
  const send = wireNodes(h.pane).find(node => /composer-send/.test(node.id))
  assert.ok(send !== undefined, 'the ONE composer keeps its Send control visible')
  const attrs = send.p['attrs'] as Record<string, unknown> | undefined
  assert.equal(attrs?.['aria-disabled'], 'true', 'painted disabled while the card owns the seat')
  assert.equal(h.composer().text, 'draft', 'and the draft itself is still on the editor')
  h.click(send.id)
  await h.observeAbsence()
  assert.equal(h.calls.submits, 0, 'its click reached no submission behind the card')
  assert.equal(h.cardPainted(), true, 'and it did not close the card either')
})

test('the formal History-scope commits retire an open card and leave the composer alone', async (t) => {
  const h = await mountHistoryPane(t)
  h.key(CTRL_R)
  await h.painted(() => h.selected().length === 1, 'the card is up')
  const requestsBefore = h.requests.length
  h.renderer.display.beginInputHistoryScope({ sessionId: 'ses_b' } as never)
  assert.equal(h.cardPainted(), true, 'the seam is PURE STATE: it owes no frame of its own')
  h.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, {})
  await h.painted(() => !h.cardPainted(), 'the outer commit carries the frame with no card')
  assert.equal(h.requests.length, requestsBefore, 'the pure retire issued no new read')
  h.key(ENTER)
  await h.observeAbsence()
  assert.equal(h.composer().text, '', 'and the retired card restored nothing')
})
