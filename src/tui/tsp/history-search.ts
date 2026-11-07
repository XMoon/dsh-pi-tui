/**
 * TSP I-E: the ONE short-lived `Ctrl+R` input-history search seat.
 *
 * It owns only the interaction state of the currently painted History card —
 * the query text/caret, the Scope, the settled first page, the selected result
 * identity, the Preview reading reset and the expanded presentation — and turns
 * a key or a click into ONE admitted intent. It owns NO history authority (the
 * single `HistorySearchSource` the composition root already built answers every
 * query), NO Session currentness (the one `captureHistoryScope()` pair taken
 * ONCE at open is the only currentness fact this seat ever reads), NO draft (the
 * ONE `TspComposer` writes text and caret, and only a verified restore ever
 * reaches it), NO clipboard policy (the existing Client-local copy callback owns
 * it) and NO SDK session: `surface.render`/`focus`/`scroll`/`reveal` stay with
 * the mount, which indexes the real wire ids out of its own committed frame.
 *
 * Every asynchronous settlement, every key and every click re-checks the whole
 * currentness set — the open serial, the query revision, the captured Session
 * scope and the mount's seat admission — never the abort signal alone, because
 * an answer can land after the user typed on, after a Session was published,
 * after a Modal took the seat, or after a Picker retired this one. A refused
 * settlement paints nothing, copies nothing and writes nothing.
 *
 * The card is ONE Dock presentation: opening never creates a `mode:'screen'`,
 * an overlay, a second composer, a second input loop or a second History.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/history-search
 */

import { View } from '@stencil-hq/tern'
import type { Key, Node, ScrollTo } from '@stencil-hq/tern'
import type { HistoryScope, HistorySearchResult } from '../../client/history/search.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS, HISTORY_SEARCH_RESULT_LIMIT } from '../../client/history/search.ts'
import type { TspHistorySearchBinding } from '../../app/surface/runtime.ts'
import type { HistoryOpenScope } from '../../tui-app.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplaySegment, sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { HISTORY_CHORDS } from '../keybindings/hints.ts'

/** The seat's own lifecycle: one card per open, parked under a Modal. */
export type TspHistorySearchPhase = 'closed' | 'open' | 'parked'

/** What the painted frame states about the in-flight search. */
export type TspHistorySearchStatus = 'searching' | 'ready' | 'failed'

/** The Scope labels the card shows (`Directory` is the `current` scope file). */
export type TspHistoryScopeLabel = 'Session' | 'Directory' | 'All'

/** One results-list move: one row or one page, clamped at both ends. */
export type TspHistoryBrowseStep = 'up' | 'down' | 'page-up' | 'page-down'

/** One admitted interaction. Every intent carries the OPEN serial and the query
 *  revision of the frame that minted it, so a lagging click or a key held
 *  across a re-render can only act on the rows the user actually saw; the
 *  identity it names is then re-checked against the settled rows of THIS frame. */
export type TspHistorySearchIntent =
  | { readonly kind: 'focus-query'; readonly serial: number; readonly revision: number }
  | { readonly kind: 'query'; readonly query: string; readonly cursor: number; readonly serial: number; readonly revision: number }
  | { readonly kind: 'scope'; readonly delta: -1 | 1; readonly serial: number; readonly revision: number }
  | { readonly kind: 'select'; readonly rowId: string; readonly serial: number; readonly revision: number }
  | { readonly kind: 'browse'; readonly step: TspHistoryBrowseStep; readonly serial: number; readonly revision: number }
  | { readonly kind: 'preview-scroll'; readonly to: ScrollTo; readonly serial: number; readonly revision: number }
  | { readonly kind: 'expand'; readonly serial: number; readonly revision: number }
  | { readonly kind: 'retry'; readonly serial: number; readonly revision: number }
  /** `selectedId` is the row the CELL WAS PAINTED FOR. Moving the highlight
   *  does not bump `queryRevision`, so serial+revision alone cannot tell a
   *  lagging click which selection the user was looking at; without this the
   *  stale button would act on the NEWER selection. Raw row identity never
   *  reaches a node key or attribute — it travels only inside this intent. */
  | { readonly kind: 'copy'; readonly selectedId: string | undefined; readonly serial: number; readonly revision: number }
  | { readonly kind: 'restore'; readonly selectedId: string | undefined; readonly serial: number; readonly revision: number }
  | { readonly kind: 'close'; readonly serial: number; readonly revision: number }

/** The painted row of the results list: one sanitized summary plus the short
 *  time/directory marks. The raw `content` NEVER enters a painted cell — the
 *  seat keeps it only for Copy and Restore. */
export interface TspHistorySearchRow {
  readonly id: string
  readonly key: string
  readonly summary: string
  readonly time: string
  readonly directory: string
  readonly selected: boolean
}

/** The Preview of the selected row: the FULL sanitized source (never a `…
 *  more` pretence) plus its honest metadata lines. */
export interface TspHistorySearchPreview {
  readonly text: string
  readonly directory: string
  readonly time: string
  readonly session: string
}

/** The render-time state the Dock view paints. `undefined` from
 *  {@link TspHistorySearchSeat.renderState} means: paint no card at all. */
export interface TspHistorySearchRenderState {
  readonly serial: number
  readonly revision: number
  readonly scope: TspHistoryScopeLabel
  readonly scopeKey: string
  readonly expandKey: string
  readonly closeKey: string
  readonly queryKey: string
  readonly query: string
  readonly queryCursor: number
  readonly status: TspHistorySearchStatus
  readonly expanded: boolean
  /** The row the action cells were painted against (see the Copy/Restore
   *  intents); `undefined` when nothing is selected. */
  readonly selectedId: string | undefined
  readonly resultsKey: string
  readonly previewKey: string
  readonly header: string
  readonly rows: readonly TspHistorySearchRow[]
  readonly empty: string | undefined
  readonly failure: string | undefined
  readonly preview: TspHistorySearchPreview | undefined
  readonly hint: string
  readonly copyLabel: string
  readonly copyKey: string
  readonly restoreLabel: string
  readonly restoreKey: string
  readonly retryLabel: string
  readonly retryKey: string
  readonly actionsEnabled: boolean
}

export interface TspHistorySearchPorts {
  /** The mount's seat admission: no Modal, no temporary Reader, no higher
   *  Presenter, no hydration window, no disposal, and the input is bound. A
   *  seat that is not admitted neither keeps a card painted nor consumes a key. */
  admitted(): boolean
  /** Commit one frame for a seat-only change (the composer's own `onChanged`
   *  sink carries every text change, so this never doubles a render). */
  requestRender(): void
  /** Re-evaluate the ONE focus owner after a committed frame. */
  setFocus(): void
  /** The ONE Composer write: the exact stored content as one whole-document
   *  replacement. Only ever called AFTER this seat retired itself. */
  restoreToComposer(raw: string): void
  /** The existing Client-local copy callback plus the settlement fence: the
   *  outcome notice may only land while `live()` still answers true. */
  copyRaw(raw: string, live: () => boolean): void
  /** Reveal one settled row inside the results scroll container. */
  reveal(id: string): void
  /** Scroll the Preview's own container. */
  scroll(id: string, to: ScrollTo): void
  /**
   * The mount's FATAL owner. A settlement branch that throws (the frame commit
   * it owes can throw: `surface.render` raises a `ViewError`) is a broken tty
   * owner, not a silent cancel: the PRIMARY error reaches the runner's fatal
   * lifecycle instead of becoming an unhandled rejection on the chain this seat
   * started. Nothing here swallows, retries or falls back.
   */
  reportFatal(error: unknown): void
  /**
   * The fatal owner itself threw while handling `error`. This is the terminal
   * path, so the only honest act left is to STATE it (the renderer's own
   * `logError` route) rather than let the chain that started this settlement
   * end up as an unhandled rejection. Nothing here retries or recovers.
   */
  reportSecondaryFailure(primary: unknown, secondary: unknown): void
}

export interface TspHistorySearchSeat {
  /** Whether the card currently owns the keyboard (open, not parked). */
  isOpen(): boolean
  /**
   * Whether the SAME card instance is still a LIVE seat occupant, including a
   * Modal park. This is a different fact from {@link isOpen}: while a Modal owns
   * the keys the card is parked, not closed, and its Compose Seat must stay
   * withheld from any asynchronous Composer intake that started before the
   * park. An Async read settled during the park must NEVER be allowed to write
   * the draft just because the keyboard owner changed.
   * `false` once the card retired or its captured Session scope died.
   */
  holdsSeat(): boolean
  /** The ONE keyboard owner while the card is the current seat. `true` = the
   *  key was consumed here and never reached the Composer reducer. */
  handleKey(key: Key): boolean
  /** The ONE entry point for an intent a click minted. */
  handleIntent(intent: TspHistorySearchIntent): void
  /** Open one card: capture the Session scope and the cwd EXACTLY once, then
   *  start the first empty-query search immediately. Only ever called after
   *  {@link supported} answered true. */
  open(): void
  /** `false` when this pane cannot present the card at all (no bound source or
   *  a pane that never negotiated the kinds/features the card really paints). */
  supported(): boolean
  /** Mirror the mount's current blocker into this seat: park while a Modal owns
   *  the keys (the SAME instance keeps its query/rows/selection), come back when
   *  it settles, and retire for good when the captured scope died meanwhile.
   *  `true` = the card became operable again, so the caller's frame shows it. */
  syncBlocker(blocked: boolean): boolean
  /** Withdraw the card and every in-flight read WITHOUT touching the Composer. */
  retire(): void
  /** The render-time projection (`undefined` = paint no card). */
  renderState(): TspHistorySearchRenderState | undefined
  /** Index the frame the SDK just committed: map this seat's node keys to the
   *  real wire ids, then perform the reveal/scroll a keyboard move actually owed. */
  indexFrame(dockRoot: Node): void
  /** The wire id of the node that owns the hardware caret, or `undefined` when
   *  this seat owns no native caret. */
  desiredFocusId(): string | undefined
}

/** The ONE user-visible statement of a pane that cannot present the card. The
 *  mount consumes `Ctrl+R` and states this instead of painting a reduced
 *  second-tier UI or letting the key fall through as a literal `r`. */
export const TSP_HISTORY_SEARCH_UNAVAILABLE = 'Input history search is unavailable in this Tern pane.'

/** The ONE user-visible statement of a failed read, and of a pane that cannot
 *  present the card. Both are stated instead of painting a misleading page. */
export const HISTORY_SEARCH_FAILURE = 'Could not search input history.'

/** The page step of the results navigation (the `↑↓` / `PgUp`/`PgDn` pair). The
 *  native scroll container grants the real height, so this is a paging step and
 *  never a claim about how many rows the pane shows. */
const HISTORY_SEARCH_PAGE_ROWS = 6

/** The Scope ring in the frozen `Session → Directory → All → Session` order. A
 *  card opened with no live Session identity never offers `Session` — a Session
 *  Scope without an identity is always empty, so advertising it would lie. */
const SCOPE_RING: readonly { readonly scope: HistoryScope; readonly label: TspHistoryScopeLabel }[] = [
  { scope: 'session', label: 'Session' },
  { scope: 'current', label: 'Directory' },
  { scope: 'all', label: 'All' },
]

const SCOPE_LABELS: Readonly<Record<HistoryScope, TspHistoryScopeLabel>> = {
  session: 'Session',
  current: 'Directory',
  all: 'All',
}

/** The grapheme boundaries of the query text (CJK/emoji/combining safe); the
 *  offsets are UTF-16 code units, the unit the field's caret counts in. */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const graphemeBounds = (text: string): number[] =>
  [...segmenter.segment(text)].map((entry) => entry.index).concat(text.length)

/** The one-line summary of a result: its first line, sanitized for display. */
function rowSummary(content: string): string {
  const first = content.split('\n')[0] ?? ''
  return sanitizedPhysicalLine(first.trim())
}

/**
 * The shortest distinctive cwd suffix (parent + name), display-only.
 *
 * The file's own `cwd` is UNTRUSTED text (a legacy or hand-edited JSONL row), so
 * it goes through the same one-line projection the PiTui panel applies before a
 * cwd or a Session id reaches a painted cell: no control byte or escape sequence
 * can reach a node's `text`, `title` or `aria`. The raw bytes stay in the Seat
 * for Copy and Restore, which is the only place they are ever needed exact.
 */
function shortCwd(cwd: string): string {
  const safe = sanitizedPhysicalLine(cwd)
  const parts = safe.split('/').filter((part) => part !== '')
  return parts.length >= 2 ? parts.slice(-2).join('/') : safe
}

/** The row's short time mark, newest-look. A legacy row has no timestamp and is
 *  never given a fabricated one: its mark is simply ABSENT (the Preview states
 *  the explicit `Time unknown`), so no ambiguous-width glyph is introduced into
 *  this new surface. */
function shortTime(ts: number | null, now: number): string {
  if (ts === null) return ''
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

/** The Preview's honest absolute time, or the explicit unknown state. */
function previewTime(ts: number | null): string {
  if (ts === null) return 'Time unknown'
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The next query/caret for one editing key, or `undefined` when the key is not
 * an edit. ONE source of truth for the local query: the Composer draft and its
 * caret never enter it. */
function editQuery(
  query: string,
  cursor: number,
  key: Key,
): { readonly query: string; readonly cursor: number } | undefined {
  const bounds = graphemeBounds(query)
  if (key.name === 'backspace') {
    const start = bounds.filter((index) => index < cursor).at(-1) ?? 0
    return { query: query.slice(0, start) + query.slice(cursor), cursor: start }
  }
  if (key.name === 'delete') {
    const end = bounds.find((index) => index > cursor) ?? query.length
    return { query: query.slice(0, cursor) + query.slice(end), cursor }
  }
  if (key.name === 'left') {
    return { query, cursor: bounds.filter((index) => index < cursor).at(-1) ?? 0 }
  }
  if (key.name === 'right') {
    return { query, cursor: bounds.find((index) => index > cursor) ?? query.length }
  }
  if (key.name === 'home') return { query, cursor: 0 }
  if (key.name === 'end') return { query, cursor: query.length }
  // A real bracketed paste is ordinary query TEXT here: the History query is a
  // one-line filter, so every line break the paste carried projects to a space,
  // and no pasted-path or image intake is ever armed by it.
  if (key.name === 'paste') {
    const inserted = sanitizeDisplaySegment(key.text ?? '')
    const next = `${query.slice(0, cursor)}${inserted}${query.slice(cursor)}`
    const raw = cursor + inserted.length
    // The caret stays at the END OF THE PASTED RUN, not at the end of the
    // whole query: a mid-caret paste must not teleport the reader's caret.
    return { query: next, cursor: graphemeBounds(next).find(index => index >= raw) ?? next.length }
  }
  if (key.text === undefined) return undefined
  // A printable key is query TEXT, and the History query is a one-line filter:
  // the same projection the paste branch applies, so no control byte or line
  // break can be carried into the painted field or the source query.
  const inserted = sanitizeDisplaySegment(key.text)
  const typed = query.slice(0, cursor) + inserted
  const raw = cursor + inserted.length
  return {
    query: typed + query.slice(cursor),
    cursor: graphemeBounds(typed).find((index) => index >= raw) ?? typed.length,
  }
}

/** The bounded state of ONE card. Nothing here survives a retire, and none of
 *  it is a durable fact: the history file and the Session stay their owners. */
interface HistorySeatState {
  phase: TspHistorySearchPhase
  /** Strictly increasing per OPEN, so a frame or a request of an older open is
   *  never the successor of a newer one. */
  readonly openSerial: number
  /** The ONE atomic capture taken at open: identity AND currentness pair. */
  readonly scopeCapture: HistoryOpenScope
  /** The cwd this card searches against — captured ONCE at open. */
  readonly openCwd: string
  /** Whether a live Session identity existed at open. */
  readonly scopeAvailable: boolean
  scope: HistoryScope
  query: string
  /** The query caret in UTF-16 units, always a grapheme boundary. */
  queryCursor: number
  /** Bumped by every query/scope/Retry round; the async fence's half. */
  queryRevision: number
  status: TspHistorySearchStatus
  rows: readonly HistorySearchResult[]
  selectedId: string | undefined
  exhausted: boolean
  expanded: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  /** Set when the selection MOVED: only a real move may re-scroll the list. */
  revealPending: boolean
  /** Set when a DIFFERENT row became selected: its Preview starts at the top. */
  previewResetPending: boolean
  retired: boolean
}

/** One in-flight read, with the identity its answer must match. */
interface PendingSearch {
  readonly serial: number
  readonly revision: number
  readonly scope: HistoryScope
  readonly query: string
  readonly controller: AbortController
}

export function createTspHistorySearch(
  ports: TspHistorySearchPorts,
  binding: TspHistorySearchBinding | undefined,
  nativeSupported: () => boolean,
): TspHistorySearchSeat {
  /** The live card, or `undefined` while the seat is closed. ONE instance. */
  let state: HistorySeatState | undefined
  /** Monotonic per-open identity (never a Session generation). */
  let openSerial = 0
  /** This frame's node-key → wire-id map, resolved from the SDK's own id
   *  assignment. A key the frame did not paint stays absent, so focus, reveal
   *  and scroll can only ever name a node that is really on the wire. */
  let frameIds = new Map<string, string>()
  /** The read currently owned by this card, if any. */
  let pending: PendingSearch | undefined

  const queryKeyOf = (serial: number): string => `h${serial}-query`
  /** A non-interactive container key: serial plus a role token only. A key that
   *  changed per frame would `del` + `add` the scroll container and drop the
   *  reader's position on every repaint. */
  const containerKeyOf = (serial: number, token: string): string => `h${serial}-${token}`
  /** The key of one OPERABLE cell: serial + query revision + paint token. The
   *  revision is what rejects a lagging pointer before this seat ever sees it:
   *  the SDK dispatches an event by the id of the view it LAST rendered, so an
   *  id of an older frame is simply not in the current view. No raw source file
   *  path and no result identity ever reaches an HTML key. */
  const actionKeyOf = (owner: HistorySeatState, token: string): string =>
    `h${owner.openSerial}-r${owner.queryRevision}-${token}`

  /** An action cell whose meaning depends on WHICH row is highlighted: the
   *  selected row's position joins the key, so a repaint that moved the
   *  selection retires the old cell's identity along with it. */
  const selectionActionKeyOf = (owner: HistorySeatState, token: string): string => {
    const index = owner.rows.findIndex((row) => row.id === owner.selectedId)
    return `h${owner.openSerial}-r${owner.queryRevision}-s${index}-${token}`
  }

  /** The state half of every ACTING entry: this exact card, open, admitted by
   *  the mount, and still on the Session scope captured at open. A parked card
   *  answers `false`, so a Modal always owns the keys meanwhile. */
  const operable = (owner: HistorySeatState): boolean => {
    if (state !== owner || owner.retired) return false
    if (owner.phase !== 'open') return false
    if (!ports.admitted()) return false
    return owner.scopeCapture.isCurrent()
  }

  const clearTimer = (owner: HistorySeatState): void => {
    if (owner.timer !== undefined) clearTimeout(owner.timer)
    owner.timer = undefined
  }

  /** Abandon the in-flight read. Its answer stays fenced by its identity even
   *  when the source ignores the abort. */
  const abandonPending = (): void => {
    const inFlight = pending
    pending = undefined
    inFlight?.controller.abort()
  }

  /** Commit local state FIRST, then ask the mount for ONE frame, so a
   *  re-entrant callback always sees the frame that already reflects it. */
  const change = (owner: HistorySeatState): void => {
    if (state !== owner || owner.retired || owner.phase !== 'open') return
    ports.requestRender()
  }

  const retire = (): void => {
    const owner = state
    if (owner === undefined) return
    state = undefined
    owner.retired = true
    clearTimer(owner)
    abandonPending()
    frameIds = new Map()
  }

  /**
   * The retire that DISCOVERED the death (a late settlement, a stale acting
   * entry) rather than the one an outer commit performed: nothing else owes a
   * frame, so the card a user can still see must actually leave the frame. A
   * formal lifecycle commit calls plain {@link retire} and carries its own
   * repaint, exactly like the composer and completion seats.
   */
  const retireDiscovered = (): void => {
    if (state === undefined) return
    retire()
    ports.requestRender()
  }

  const runSearch = (owner: HistorySeatState, request: PendingSearch): void => {
    const source = binding?.source
    if (source === undefined) return
    pending = request
    const cwd = owner.openCwd
    const sessionId = owner.scopeCapture.sessionId
    // The seat is the ONE owner of this read's settlement: BOTH branches are
    // handled here (a fulfilment commits or refuses, a rejection states the
    // failure), so nothing travels unhandled and no second owner exists — the
    // same shape as the mounted renderer's own input loop.
    void source.search({ // allowlist: the seat's own two-branch settlement
      scope: request.scope,
      cwd,
      sessionId,
      query: request.query,
      limit: HISTORY_SEARCH_RESULT_LIMIT,
      signal: request.controller.signal,
    }).then((page) => {
      // The full currentness set — not the signal: an answer that lands after a
      // newer round, another open, a Session change or a higher seat is dropped.
      if (state !== owner || owner.retired || pending !== request) return
      if (request.serial !== owner.openSerial || request.revision !== owner.queryRevision) return
      // Identity + the captured Session scope. The mount's seat admission is
      // deliberately NOT read here: a Modal PARKS this card and makes admission
      // false, and a parked card must keep its committed rows so `resume()`
      // shows the SAME query, selection and page (the plan's TRANSIENT state) —
      // reading admission here was the bug that destroyed the card.
      // The captured scope IS re-checked here, INSIDE the frame-owning `try`:
      // retirement itself asks the mount for the frame that removes the card,
      // so a fence placed before the `try` would let that frame's failure
      // escape as an unhandled rejection instead of reaching the fatal owner.
      try {
        if (owner.scopeCapture.isCurrent() === false) {
          // The page is refused and the round is retired, which aborts this
          // read's controller: a source that still holds the signal stops
          // scanning. (The abort is a no-op for a source that already settled,
          // so the refusal is the claim, not the stopping.)
          retireDiscovered()
          return
        }
        pending = undefined
        const previous = owner.selectedId
        owner.rows = page.results
        owner.exhausted = page.exhausted
        owner.status = 'ready'
        // The same query keeps its selection while the row still exists; a
        // replaced page falls back to the first settled row, never an invented one.
        const survives = previous !== undefined && page.results.some((row) => row.id === previous)
        owner.selectedId = survives ? previous : page.results[0]?.id
        if (!survives && previous !== undefined) {
          owner.previewResetPending = true
          owner.revealPending = true
        }
        // A parked card records its settled rows but owes no interactive frame;
        // `resume()` paints them in the next one.
        if (owner.phase === 'open') change(owner)
      } catch (error) {
        // The page WAS consumed; only the frame it owed failed. The error is the
        // renderer's fatal path, never a second "failed read" story. A fatal
        // owner that itself throws is handled exactly the way the renderer's
        // other settlement owners handle it (the visible-Reader close): the
        // PRIMARY error stays routed, the secondary is stated, and nothing is
        // left to become an unhandled rejection on this chain.
        try {
          ports.reportFatal(error)
        } catch (secondary) {
          ports.reportSecondaryFailure(error, secondary)
        }
      }
    }, () => {
      if (state !== owner || owner.retired || pending !== request) return
      if (request.serial !== owner.openSerial || request.revision !== owner.queryRevision) return
      // The same fence, in the same frame-owning `try`, as the fulfilment
      // branch: a parked card records its failure and states it on resume, and
      // a dead scope retires the round without letting the retirement frame's
      // own failure escape.
      try {
        if (owner.scopeCapture.isCurrent() === false) {
          retireDiscovered()
          return
        }
        pending = undefined
        // A failed read is a FAILED read: never an empty page dressed up as "no
        // matches", and the user's own draft was never touched by it.
        owner.status = 'failed'
        owner.rows = []
        owner.selectedId = undefined
        owner.exhausted = false
        if (owner.phase === 'open') change(owner)
      } catch (error) {
        try {
          ports.reportFatal(error)
        } catch (secondary) {
          ports.reportSecondaryFailure(error, secondary)
        }
      }
    })
  }

  /** Start one search round. `immediate` is the empty-query first read at open
   *  and the explicit Retry (neither waits behind the debounce); every later
   *  text or Scope change debounces. */
  const schedule = (owner: HistorySeatState, immediate: boolean): void => {
    if (binding === undefined) return
    owner.queryRevision += 1
    abandonPending()
    clearTimer(owner)
    // The previous page stops being operable the instant this round starts.
    owner.status = 'searching'
    const start = (): void => {
      clearTimer(owner)
      if (state !== owner || owner.retired) return
      runSearch(owner, {
        serial: owner.openSerial,
        revision: owner.queryRevision,
        scope: owner.scope,
        query: owner.query,
        controller: new AbortController(),
      })
    }
    if (immediate) start()
    else owner.timer = setTimeout(start, HISTORY_SEARCH_DEBOUNCE_MS)
    change(owner)
  }

  /** The Scope ring THIS card offers. */
  const scopeRing = (owner: HistorySeatState): HistoryScope[] =>
    SCOPE_RING.filter((entry) => owner.scopeAvailable || entry.scope !== 'session').map((entry) => entry.scope)

  const browse = (owner: HistorySeatState, step: TspHistoryBrowseStep): void => {
    // The same operable-identity rule as a row click: while a newer round is in
    // flight the painted page belongs to the PREVIOUS query, so the keyboard
    // must not walk rows that are about to be replaced.
    if (owner.status !== 'ready') return
    const rows = owner.rows
    if (rows.length === 0) return
    const at = Math.max(0, rows.findIndex((row) => row.id === owner.selectedId))
    const size = step === 'page-up' || step === 'page-down' ? HISTORY_SEARCH_PAGE_ROWS : 1
    const delta = step === 'up' || step === 'page-up' ? -size : size
    // Clamped at both ends (never a wrap), so the reader stops where the page does.
    const target = Math.min(rows.length - 1, Math.max(0, at + delta))
    const moved = rows[target]!
    if (moved.id === owner.selectedId) return
    owner.selectedId = moved.id
    owner.previewResetPending = true
    owner.revealPending = true
    change(owner)
  }

  /** The pointer's own selection fence. A Copy/Restore cell was painted against
   *  ONE highlighted row, and moving that highlight changes neither the card's
   *  serial nor its query revision, so serial+revision alone cannot tell a
   *  lagging click which selection the user was looking at. A stale gesture is
   *  refused unless the row it was PAINTED for is still the selected one — it
   *  must never borrow the newer selection's business action. The keyboard
   *  route mints its intent from the live selection, so it always matches. */
  const selectionStillPainted = (
    owner: HistorySeatState,
    intent: Extract<TspHistorySearchIntent, { readonly kind: 'copy' } | { readonly kind: 'restore' }>,
  ): boolean => intent.selectedId !== undefined && intent.selectedId === owner.selectedId

  /** The row a Restore or Copy may act on: settled, current, and one of THIS
   *  frame's real rows — never a row a newer query already replaced. */
  const settledSelected = (owner: HistorySeatState): HistorySearchResult | undefined => {
    if (owner.status !== 'ready') return undefined
    const id = owner.selectedId
    if (id === undefined) return undefined
    return owner.rows.find((row) => row.id === id)
  }

  /** The ONE admission point for every intent, keyboard or pointer. It runs
   *  BEFORE any mutation: a stale frame, another card, a higher seat or a moved
   *  Session can never change this one. */
  const act = (intent: TspHistorySearchIntent): void => {
    const owner = state
    if (owner === undefined || owner.retired) return
    if (intent.serial !== owner.openSerial || intent.revision !== owner.queryRevision) return
    if (!operable(owner)) return
    switch (intent.kind) {
      case 'focus-query': {
        // A second `Ctrl+R` keeps the ONE instance with its query, selection and
        // Preview anchor exactly as they are; it only takes the caret back.
        ports.setFocus()
        return
      }
      case 'query': {
        owner.query = intent.query
        owner.queryCursor = intent.cursor
        schedule(owner, false)
        return
      }
      case 'scope': {
        const ring = scopeRing(owner)
        const at = Math.max(0, ring.indexOf(owner.scope))
        owner.scope = ring[(at + intent.delta + ring.length) % ring.length]!
        // The query string survives the switch; the rows belong to the Scope, so
        // the settled page is re-queried rather than re-labelled.
        schedule(owner, false)
        return
      }
      case 'select': {
        // A newer round is in flight: the rows still on screen belong to the
        // PREVIOUS query, so they are visible but no longer operable. Accepting
        // a click here would let a lagging pointer select a row the user has
        // already typed past.
        if (owner.status !== 'ready') return
        const row = owner.rows.find((candidate) => candidate.id === intent.rowId)
        if (row === undefined || row.id === owner.selectedId) return
        owner.selectedId = row.id
        owner.previewResetPending = true
        change(owner)
        return
      }
      case 'browse': {
        browse(owner, intent.step)
        return
      }
      case 'preview-scroll': {
        const id = frameIds.get(containerKeyOf(owner.openSerial, 'preview-scroll'))
        if (id !== undefined) ports.scroll(id, intent.to)
        return
      }
      case 'expand': {
        // The SAME card's visible-height preference only: query, selection and
        // Preview anchor all stay exactly where the reader left them.
        owner.expanded = !owner.expanded
        change(owner)
        return
      }
      case 'retry': {
        if (owner.status !== 'failed') return
        schedule(owner, true)
        return
      }
      case 'copy': {
        if (!selectionStillPainted(owner, intent)) return
        const row = settledSelected(owner)
        if (row === undefined) return
        // The RAW stored content is captured at admission and never re-read from
        // a painted cell. The fence is this card's own identity, so a late
        // success never announces itself onto a newer Session or a replaced card.
        const raw = row.content
        const rowId = row.id
        const serial = owner.openSerial
        const revision = owner.queryRevision
        ports.copyRaw(raw, () => {
          const live = state
          // Plan §5.2.7: the copy's outcome is announced while the SAME card,
          // the SAME round and the SAME row are still the seat's, and the
          // captured scope is still current. A Modal PARK is not a loss of any
          // of those four facts, so the notice survives the park instead of
          // silently dropping a copy the clipboard already performed. Every
          // real loss of the card — a Presenter, hydration, a publication, a
          // disposal — retires it, and `retired`/`state` catch all of them;
          // reading the mount's admission here would re-create the park bug.
          return live !== undefined
            && !live.retired
            && (live.phase === 'open' || live.phase === 'parked')
            && live.openSerial === serial
            && live.queryRevision === revision
            && live.selectedId === rowId
            && live.scopeCapture.isCurrent()
        })
        return
      }
      case 'restore': {
        if (!selectionStillPainted(owner, intent)) return
        const row = settledSelected(owner)
        if (row === undefined) return
        const raw = row.content
        // CLOSE FIRST: the card, its timer and its click identity are gone
        // BEFORE the Composer mutation and the single frame it commits, so a
        // re-entrant render can never paint the buttons of a card that already
        // accepted, and one gesture can never restore twice.
        retire()
        ports.restoreToComposer(raw)
        return
      }
      case 'close': {
        // Esc, Ctrl+C inside History, and the `×` button all end here: the card
        // retires and the Composer keeps its draft, caret, leases and mode,
        // because nothing below touches it.
        retire()
        ports.requestRender()
        ports.setFocus()
        return
      }
      default:
        return
    }
  }

  /** The keyboard route. While the card owns the seat EVERY key is consumed
   *  here, so a stray letter, `Ctrl+V`, `Alt+Q`, `Ctrl+D` or a visual chord can
   *  never reach the Composer reducer, the paste intake or another owner. */
  const handleKey = (key: Key): boolean => {
    const owner = state
    if (owner === undefined || owner.retired || owner.phase !== 'open') return false
    if (!ports.admitted() || !owner.scopeCapture.isCurrent()) {
      retireDiscovered()
      return false
    }
    const intent = keyIntent(owner, key)
    if (intent !== undefined) act(intent)
    return true
  }

  const keyIntent = (owner: HistorySeatState, key: Key): TspHistorySearchIntent | undefined => {
    const serial = owner.openSerial
    const revision = owner.queryRevision
    if (key.name === 'escape') return { kind: 'close', serial, revision }
    // `Ctrl+C` INSIDE History is this seat's own cancel: closing the card never
    // interrupts the Agent (the mount routes it here, before its cancel owner).
    if (key.ctrl === true && key.name === 'c' && !key.alt && !key.meta && !key.shift) {
      return { kind: 'close', serial, revision }
    }
    if (key.ctrl === true && key.name === 'r' && !key.alt && !key.meta) {
      return { kind: 'focus-query', serial, revision }
    }
    if (key.alt === true && key.ctrl !== true && key.meta !== true) {
      if (key.name === 'c' && !key.shift) return { kind: 'copy', selectedId: owner.selectedId, serial, revision }
      const previewStep: ScrollTo | undefined = key.name === 'up' ? 'line-up'
        : key.name === 'down' ? 'line-down'
          : key.name === 'page_up' ? 'page-up'
            : key.name === 'page_down' ? 'page-down'
              : key.name === 'home' ? 'start'
                : key.name === 'end' ? 'end'
                  : undefined
      if (previewStep !== undefined) return { kind: 'preview-scroll', to: previewStep, serial, revision }
      return undefined
    }
    if (key.ctrl === true || key.meta === true) return undefined
    if (key.name === 'tab') return { kind: 'scope', delta: key.shift === true ? -1 : 1, serial, revision }
    if (key.name === 'f2') return { kind: 'expand', serial, revision }
    if (key.name === 'enter') return { kind: 'restore', selectedId: owner.selectedId, serial, revision }
    if (key.name === 'up') return { kind: 'browse', step: 'up', serial, revision }
    if (key.name === 'down') return { kind: 'browse', step: 'down', serial, revision }
    if (key.name === 'page_up') return { kind: 'browse', step: 'page-up', serial, revision }
    if (key.name === 'page_down') return { kind: 'browse', step: 'page-down', serial, revision }
    if (key.shift === true) return undefined
    const edited = editQuery(owner.query, owner.queryCursor, key)
    if (edited !== undefined) return { kind: 'query', query: edited.query, cursor: edited.cursor, serial, revision }
    return undefined
  }

  const renderState = (): TspHistorySearchRenderState | undefined => {
    const owner = state
    if (owner === undefined || owner.retired) return undefined
    // A parked card, or a mount that no longer admits it, paints NO card: a
    // hidden-but-clickable History is exactly the forbidden state.
    if (owner.phase !== 'open' || !ports.admitted() || !owner.scopeCapture.isCurrent()) return undefined
    const rows = owner.rows
    const now = Date.now()
    const painted: TspHistorySearchRow[] = rows.map((row, index) => ({
      id: row.id,
      key: actionKeyOf(owner, `o${index}`),
      summary: rowSummary(row.content),
      time: shortTime(row.ts, now),
      directory: row.cwd === null ? '' : shortCwd(row.cwd),
      selected: row.id === owner.selectedId,
    }))
    const selected = settledSelected(owner)
    // The header states ONE thing per state: a round in flight says so, a
    // FAILED read says FAILED (never a zero match count that would dress a
    // broken read up as an empty history), and a settled page counts the rows
    // this frame actually shows.
    const header = owner.status === 'searching'
      ? 'Searching…'
      : owner.status === 'failed'
        ? HISTORY_SEARCH_FAILURE
        : `Results · ${painted.length} shown${owner.exhausted ? '' : ' · older history may remain'}`
    const empty = owner.status === 'ready' && painted.length === 0
      ? owner.query === ''
        ? 'No input history in this scope.'
        : owner.exhausted
          ? 'No matching history.'
          : 'No matches in the scanned history.'
      : undefined
    const preview = selected === undefined ? undefined : {
      text: sanitizeDisplayText(selected.content),
      directory: `Directory: ${selected.cwd === null ? 'unknown' : sanitizedPhysicalLine(selected.cwd)}`,
      time: `Time: ${previewTime(selected.ts)}`,
      session: `Session: ${selected.sessionId === undefined ? 'unknown' : sanitizedPhysicalLine(selected.sessionId)}`,
    }
    return {
      serial: owner.openSerial,
      revision: owner.queryRevision,
      scope: SCOPE_LABELS[owner.scope],
      scopeKey: actionKeyOf(owner, 'scope'),
      expandKey: actionKeyOf(owner, 'expand'),
      closeKey: actionKeyOf(owner, 'close'),
      queryKey: queryKeyOf(owner.openSerial),
      query: owner.query,
      queryCursor: owner.queryCursor,
      status: owner.status,
      expanded: owner.expanded,
      selectedId: owner.selectedId,
      resultsKey: containerKeyOf(owner.openSerial, 'results-scroll'),
      previewKey: containerKeyOf(owner.openSerial, 'preview-scroll'),
      header,
      rows: painted,
      empty,
      failure: owner.status === 'failed' ? HISTORY_SEARCH_FAILURE : undefined,
      preview,
      hint: `${HISTORY_CHORDS.scope.label} scope · ${HISTORY_CHORDS.results.label} select`
        + ` · ${HISTORY_CHORDS.preview.label} preview · ${HISTORY_CHORDS.copy.label} copy`
        + ` · ${HISTORY_CHORDS.expand.label} ${owner.expanded ? 'collapse' : 'expand'}`
        + ` · ${HISTORY_CHORDS.accept.label} restore · ${HISTORY_CHORDS.cancel.label} cancel`,
      copyLabel: `Copy all · ${HISTORY_CHORDS.copy.label}`,
      // The two ACTING verbs are keyed by the selection they were painted for.
      // Moving the highlight changes neither the card serial nor the query
      // revision, so without this the Restore/Copy node id would survive the
      // move and a lagging click would be dispatched to the CURRENT selection
      // — the closure can refuse nothing, because by then the intent is minted
      // from the newer state. A changed id is what the SDK's own stale-frame
      // refusal acts on. The token is the row's POSITION, never its raw source
      // identity, so no file path or result id reaches an HTML key.
      copyKey: selectionActionKeyOf(owner, 'copy'),
      restoreLabel: `Restore to draft · ${HISTORY_CHORDS.accept.label}`,
      restoreKey: selectionActionKeyOf(owner, 'restore'),
      retryLabel: 'Retry',
      retryKey: actionKeyOf(owner, 'retry'),
      actionsEnabled: selected !== undefined,
    }
  }

  const indexFrame = (dockRoot: Node): void => {
    frameIds = new Map()
    const owner = state
    if (owner === undefined || owner.retired || owner.phase !== 'open') return
    const root = View.from({ dock: dockRoot }).regions.find((region) => region !== undefined)
    if (root === undefined) return
    const wanted = new Set<string>([
      queryKeyOf(owner.openSerial),
      containerKeyOf(owner.openSerial, 'results-scroll'),
      containerKeyOf(owner.openSerial, 'preview-scroll'),
    ])
    owner.rows.forEach((_, index) => wanted.add(actionKeyOf(owner, `o${index}`)))
    const visit = (tree: NonNullable<typeof root>): void => {
      const key = tree.props['key']
      if (typeof key === 'string' && wanted.has(key)) frameIds.set(key, tree.id)
      for (const child of tree.children) visit(child)
    }
    visit(root)
    // The row the keyboard moved onto is revealed inside the frame the SDK just
    // committed, so the selection is never left outside the visible list.
    if (owner.revealPending) {
      owner.revealPending = false
      const at = owner.rows.findIndex((row) => row.id === owner.selectedId)
      const id = at < 0 ? undefined : frameIds.get(actionKeyOf(owner, `o${at}`))
      if (id !== undefined) ports.reveal(id)
    }
    // A different selected row starts its Preview at the top; the reading
    // position within the row it stays on is the client's own.
    if (owner.previewResetPending) {
      owner.previewResetPending = false
      const id = frameIds.get(containerKeyOf(owner.openSerial, 'preview-scroll'))
      if (id !== undefined) ports.scroll(id, 'start')
    }
  }

  return {
    isOpen: () => {
      const owner = state
      if (owner === undefined || owner.retired || owner.phase !== 'open') return false
      // A card whose captured Session scope died owns NOTHING: not the keys,
      // not the caret, and not the Composer's disabled state. Its retirement
      // frame is owed by the next entry that touches it.
      if (!owner.scopeCapture.isCurrent()) return false
      return ports.admitted()
    },
    holdsSeat: () => {
      const owner = state
      // Parked counts: the card is still the SAME instance with its query,
      // selection and in-flight read, and it comes back when the last blocker
      // settles. A dead captured scope means it will never return, so the
      // Compose Seat is no longer withheld by it.
      return owner !== undefined && !owner.retired
        && (owner.phase === 'open' || owner.phase === 'parked')
        && owner.scopeCapture.isCurrent()
    },
    // Supported = this mount received the ONE History bundle and the pane
    // negotiated what the card actually paints. `binding === undefined` IS the
    // "no bound source" case: the bundle's `source` member is typed
    // `OptionCapability<'historySearchSource'>` = `NonNullable<…>`, so a bound
    // bundle always carries a real source and no second guard is needed.
    supported: () => binding !== undefined && nativeSupported(),
    handleKey,
    handleIntent: (intent) => { act(intent) },
    open: () => {
      const bundle = binding
      if (bundle === undefined) return
      // One instance only: an older card is withdrawn before the new one
      // captures anything, so no older request, key or click can act on it.
      retire()
      const scopeCapture = bundle.captureScope()
      const scope: HistoryScope = scopeCapture.sessionId === undefined ? 'current' : 'session'
      const owner: HistorySeatState = {
        phase: 'open',
        openSerial: ++openSerial,
        scopeCapture,
        openCwd: bundle.cwd(),
        scopeAvailable: scopeCapture.sessionId !== undefined,
        scope,
        query: '',
        queryCursor: 0,
        queryRevision: 0,
        status: 'searching',
        rows: [],
        selectedId: undefined,
        exhausted: false,
        expanded: false,
        timer: undefined,
        revealPending: false,
        previewResetPending: false,
        retired: false,
      }
      state = owner
      // The empty query browses recent history and reads NOW — the debounce only
      // delays later file reads, never the first frame's search.
      schedule(owner, true)
      ports.setFocus()
    },
    syncBlocker: (blocked: boolean) => {
      const owner = state
      if (owner === undefined || owner.retired) return false
      if (blocked) {
        if (owner.phase !== 'open') return false
        // Parked, NOT closed: the query, rows, selection and the in-flight read
        // survive; the caret and every pending pointer gesture go, so nothing
        // the user cannot see can ever act.
        owner.phase = 'parked'
        owner.revealPending = false
        owner.previewResetPending = false
        frameIds = new Map()
        return false
      }
      if (owner.phase !== 'parked') return false
      // The last blocker settled: the SAME instance comes back, unless the
      // captured Session scope died meanwhile — then it never returns.
      if (!owner.scopeCapture.isCurrent()) {
        retire()
        return false
      }
      owner.phase = 'open'
      return true
    },
    retire,
    renderState,
    indexFrame,
    desiredFocusId: () => {
      const owner = state
      if (owner === undefined || owner.retired || owner.phase !== 'open') return undefined
      return frameIds.get(queryKeyOf(owner.openSerial))
    },
  }
}
