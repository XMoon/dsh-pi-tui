/**
 * T3-B1: the ONE renderer-local semantic-search seat.
 *
 * It owns only the interaction state of the currently painted Search card — the
 * query text and caret, the captured source token and revision, the Folder's
 * own matches projected to ONE target per representative card, the current
 * target, the monotonic open/query identities and the pending reveal — and turns
 * a key or a click into ONE admitted intent.
 *
 * It owns NO search authority: the ONE `TspTranscriptSemanticSearchBinding` the
 * surface hands to the mount answers every query from the LIVE selected
 * `TranscriptFolder` (whose `search()` stays the single corpus owner), resolves
 * one match to its current representative message and reports whether a source
 * token is still current. This seat keeps no index, no timer, no async read, no
 * Host port and no Composer state: the Composer is hidden by the DOCK, not by
 * this file, and its controller/draft/selection are never touched here.
 *
 * A snapshot that the binding refuses (released surface, hydration window,
 * replaced source) retires the seat instead of painting a stale result.
 *
 * Unlike the History seat there is no `parked` phase: B1's accepted product
 * contract is that a higher seat RETIRES the Search seat and closing it never
 * restores an old search.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/transcript-search
 */

import { View, type Key } from '@stencil-hq/tern'
import type { TranscriptSearchMatch, TranscriptSearchSource } from '../../domain/transcript/search.ts'
import { transcriptSearchMatchKey, transcriptSearchSourceKey } from '../../domain/transcript/search.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import type {
  TspTranscriptSemanticSearchBinding,
  TspTranscriptSemanticSearchSnapshot,
} from '../../app/surface/runtime.ts'
import type { TranscriptSearchCoverage } from '../../tui-app.ts'
import { sanitizeDisplaySegment } from '../presentation/terminal-text.ts'
import { TSP_SEARCH_CHORD, matchesKeyId } from '../keybindings/hints.ts'

/** The seat's own lifecycle: ONE card per open, retired by a higher seat. */
export type TspTranscriptSearchPhase = 'closed' | 'open'

/** One control of the seat's own focus ring. */
export type SearchFocusControl = 'query' | 'prev' | 'next' | 'close'

/** The ONE user-visible statement of a pane without the semantic-search plane. */
export const TSP_TRANSCRIPT_SEARCH_UNAVAILABLE = 'Session Search unavailable in this Tern pane.'

/** One navigation target: ONE representative card, however many raw hits it
 *  carries. `firstMatchIndex` is the raw index the target was minted from, so a
 *  refresh can re-derive the same card without inventing an identity. */
export interface TspTranscriptSearchTarget {
  /** The representative card id the Folder reported (`TranscriptSearchMatch.id`). */
  readonly representativeId: number
  /** The FIRST raw match of this card, kept for `resolve()`. */
  readonly match: TranscriptSearchMatch
  /** The number of raw hits this ONE card represents (navigation counts cards). */
  readonly hitCount: number
  /** The static source label of the card's first hit (a closed vocabulary). */
  readonly sourceLabel: string
}

/** What the Dock card paints. `undefined` from {@link TspTranscriptSearchSeat.renderState}
 *  means: paint no card at all. */
export interface TspTranscriptSearchRenderState {
  readonly serial: number
  readonly revision: number
  readonly query: string
  readonly queryCursor: number
  readonly queryKey: string
  readonly prevKey: string
  readonly nextKey: string
  readonly closeKey: string
  /** `N/M targets`, counted by representative CARD, never by raw hit. */
  readonly countLabel: string
  readonly header: string
  /** `Source-only · position unverified · <static kind>`, or the unavailable
   *  statement when the current target has no reachable card. */
  readonly sourceLabel: string
  /** Whether Prev/Next are operable (a real target exists and navigation is
   *  meaningful). Painted AND enforced by the seat. */
  readonly navigable: boolean
  readonly empty: string | undefined
}

/** One admitted interaction. Every intent carries the OPEN serial and the query
 *  revision of the frame that minted it, so a lagging click or a key held across
 *  a re-render can only act on the state the user actually saw. */
export type TspTranscriptSearchIntent =
  | { readonly kind: 'focus-query'; readonly serial: number; readonly revision: number }
  | { readonly kind: 'next'; readonly serial: number; readonly revision: number }
  | { readonly kind: 'previous'; readonly serial: number; readonly revision: number }
  | { readonly kind: 'close'; readonly serial: number; readonly revision: number }

export interface TspTranscriptSearchPorts {
  /** The mount's seat admission: no Modal/Reader/higher Presenter, no hydration
   *  window, no disposal, the input is bound and the pane can paint the card. */
  admitted(): boolean
  /** Commit one frame for a seat-only change. */
  requestRender(): void
  /**
   * Re-evaluate the ONE focus owner after a committed frame. With `control` the
   * call is the seat's own Tab cycle: the mount focuses THAT control's real wire
   * id directly (the query takes the hardware caret; a button focus is the
   * client's to grant or decline — the ring position is tracked either way).
   */
  setFocus(control?: SearchFocusControl): void
  /**
   * Request the native card reveal for the CURRENT target. The mount owns the
   * canonical owner derivation and the attached-id check; it must re-check the
   * source, the serial and the revision before sending any op, and it answers
   * whether a reveal was actually requested.
   */
  requestReveal(): boolean
  /**
   * The seat's navigation identity moved: the card opened, its query changed or
   * the user stepped to another target. The mount re-derives its TEMPORARY
   * disclosure grants for the new target and rebuilds the Main frame it owns —
   * this is the ONE place a search grant is ever granted.
   */
  navigationChanged(): void
  /** The renderer's fatal route (a frame commit threw). */
  reportFatal(error: unknown): void
}

/** The seat interface the renderer composes into its key/event/focus routes. */
export interface TspTranscriptSearchSeat {
  /** Whether the card currently owns the keyboard. */
  isOpen(): boolean
  /** Open ONE card: capture the current snapshot (empty query = zero targets). */
  open(): void
  /** `false` when this pane cannot present the card at all. */
  supported(): boolean
  /** The ONE keyboard owner while the card is the current seat. */
  handleKey(key: Key): boolean
  /** The ONE entry point for an intent a click minted. */
  handleIntent(intent: TspTranscriptSearchIntent): void
  /** Withdraw the card and its grants WITHOUT touching the Composer. */
  retire(): void
  /** The render-time projection (`undefined` = paint no card). */
  renderState(): TspTranscriptSearchRenderState | undefined
  /** The current target's canonical representative message, or `undefined`. */
  currentMessage(): TranscriptMessage | undefined
  /** The wire id of the field that owns the hardware caret, if indexed. */
  desiredFocusId(): string | undefined
  /** The wire id of ONE control of the ring, or `undefined` when unindexed. */
  controlFocusId(control: SearchFocusControl): string | undefined
  /** Index the committed frame: map this card's node keys to real wire ids. */
  indexFrame(dockRoot: import('@stencil-hq/tern').Node): void
  /** Re-run the current query after an official revision change. */
  refresh(): void
  /** The current target identity (for the renderer's grant projection). */
  currentTarget(): TspTranscriptSearchTarget | undefined
  /** Whether the current target has a reachable card in the CURRENT pane. */
  currentReachable(): boolean
  /** The seat's own diagnostics for the qualification ledger. */
  diagnosticsForTest(): {
    readonly opens: number
    readonly queries: number
    readonly snapshots: number
    readonly reveals: number
    readonly refreshes: number
    readonly retired: number
  }
}

/** The static label of one semantic source: a CLOSED vocabulary, so no query
 *  text, tool body, path, URL or token can ever reach a painted cell. */
export function transcriptSearchSourceLabel(source: TranscriptSearchSource): string {
  switch (source.kind) {
    case 'message': return 'Message'
    case 'tool-field': return source.field === 'result' ? 'Tool result'
      : source.field === 'args' ? 'Tool arguments' : 'Tool name'
    case 'command-field': return source.field === 'outcome' ? 'Command outcome'
      : source.field === 'args' ? 'Command arguments' : 'Command name'
    case 'subcall-field': return source.field === 'result' ? 'Sub-call result'
      : source.field === 'args' ? 'Sub-call arguments' : 'Sub-call name'
    case 'workflow-run': return source.field === 'status' ? 'Workflow status' : 'Workflow run'
    case 'workflow-phase': return 'Workflow phase'
    case 'workflow-member': return source.field === 'status' ? 'Workflow member status' : 'Workflow member'
    case 'assistant-deliverable': return source.field === 'path' ? 'Deliverable path' : 'Deliverable'
  }
}

/** Group the Folder's occurrence-level matches into ONE target per
 *  representative card, preserving the Folder's own display order. */
export function groupTranscriptSearchTargets(
  matches: readonly TranscriptSearchMatch[],
): TspTranscriptSearchTarget[] {
  const byRepresentative = new Map<number, { first: TranscriptSearchMatch; count: number }>()
  const order: number[] = []
  for (const match of matches) {
    const known = byRepresentative.get(match.id)
    if (known === undefined) {
      byRepresentative.set(match.id, { first: match, count: 1 })
      order.push(match.id)
    } else {
      known.count += 1
    }
  }
  return order.map((id) => {
    const entry = byRepresentative.get(id)!
    return {
      representativeId: id,
      match: entry.first,
      hitCount: entry.count,
      sourceLabel: transcriptSearchSourceLabel(entry.first.source),
    }
  })
}

/** The grapheme boundaries of the query text (CJK/emoji/combining safe); the
 *  offsets are UTF-16 code units, the unit the field's caret counts in. */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const graphemeBounds = (text: string): number[] =>
  [...segmenter.segment(text)].map((entry) => entry.index).concat(text.length)

/** The next query/caret for one editing key, or `undefined` when the key is not
 *  an edit. The ONE source of truth for the local query: the Composer draft and
 *  its caret never enter it.
 *
 *  MEASURED on the pinned client (B1-0): the client delivers no native
 *  `EditEvent`, so the seat's own key route owns every printable key — exactly
 *  the model the production Composer already uses. */
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
  // A real bracketed paste is ordinary query TEXT here: the query is a one-line
  // filter, so every line break the paste carried projects to a space and no
  // pasted-path or image intake is ever armed by it.
  if (key.name === 'paste') {
    const inserted = sanitizeDisplaySegment(key.text ?? '')
    const next = `${query.slice(0, cursor)}${inserted}${query.slice(cursor)}`
    const raw = cursor + inserted.length
    return { query: next, cursor: graphemeBounds(next).find(index => index >= raw) ?? next.length }
  }
  if (key.text === undefined) return undefined
  const inserted = sanitizeDisplaySegment(key.text)
  const typed = query.slice(0, cursor) + inserted
  const raw = cursor + inserted.length
  return {
    query: typed + query.slice(cursor),
    cursor: graphemeBounds(typed).find((index) => index >= raw) ?? typed.length,
  }
}

/** The ONE bounded state of one open card. Nothing here survives a retire. */
interface SearchSeatState {
  phase: TspTranscriptSearchPhase
  /** Strictly increasing per OPEN: an older open's frame is never a successor. */
  readonly openSerial: number
  /** The opaque source token the card was opened against. */
  readonly source: object
  /** The subject identity captured with the source (for the static header). */
  readonly subjectKind: 'main' | 'viewed-child'
  /** The query text currently installed in the field. */
  query: string
  /** The text the CURRENT `matches` were actually searched with (refinement
   *  input for the next round; never the field's live text). */
  queried: string
  queryCursor: number
  /** Bumped by every query round: the frame/intent fence's half. */
  queryRevision: number
  /** The Folder revision the CURRENT matches were computed on. */
  lastRevision: number
  matches: readonly TranscriptSearchMatch[]
  targets: readonly TspTranscriptSearchTarget[]
  current: number
  coverage: TranscriptSearchCoverage
  /** The target the mount still owes a reveal for (a real navigation only). */
  pendingReveal: boolean
  /** Whether a reveal was attempted for the CURRENT target at all. */
  revealAttempted: boolean
  /** Whether that attempt actually requested a reveal (the card is reachable). */
  reachable: boolean
  /** The control of the seat's own focus ring the caret is on. */
  focusControl: SearchFocusControl
  retired: boolean
}

export function createTspTranscriptSearch(
  ports: TspTranscriptSearchPorts,
  binding: TspTranscriptSemanticSearchBinding | undefined,
  nativeSupported: () => boolean,
): TspTranscriptSearchSeat {
  let state: SearchSeatState | undefined
  let openSerial = 0
  /** This frame's node-key → wire-id map, resolved from the SDK's own ids. */
  let frameIds = new Map<string, string>()
  const diagnostics = { opens: 0, queries: 0, snapshots: 0, reveals: 0, refreshes: 0, retired: 0 }

  const queryKeyOf = (serial: number): string => `ss${serial}-query`
  const actionKeyOf = (owner: SearchSeatState, token: string): string =>
    `ss${owner.openSerial}-r${owner.queryRevision}-${token}`

  /** This exact card, open, admitted, and still on the source it captured. */
  const operable = (owner: SearchSeatState): boolean => {
    if (state !== owner || owner.retired) return false
    if (owner.phase !== 'open') return false
    if (!ports.admitted()) return false
    return binding?.current(owner.source) === true
  }

  /** Commit local state FIRST, then ask the mount for ONE frame. */
  const change = (owner: SearchSeatState): void => {
    if (state !== owner || owner.retired || owner.phase !== 'open') return
    ports.requestRender()
  }

  const retire = (): void => {
    const owner = state
    if (owner === undefined) return
    state = undefined
    owner.retired = true
    frameIds = new Map()
    diagnostics.retired += 1
    // The temporary disclosure grants die with the card: the Composer and the
    // user's own disclosure preferences are restored by the SAME frame that
    // re-materializes the Composer.
    ports.navigationChanged()
  }

  /**
   * T3-B1 refresh: the official setTranscript commit of the SAME source calls
   * this. An unchanged Folder revision is a NO-OP (never a re-scan of history);
   * a real revision change re-queries the current query and keeps the current
   * representative card when it still exists.
   */
  const refreshFromRevision = (): void => {
    const owner = state
    if (owner === undefined || owner.retired || owner.phase !== 'open') return
    if (binding === undefined) return
    if (binding.current(owner.source) !== true) {
      retireDiscovered()
      return
    }
    const revision = binding.revision(owner.source)
    if (revision === undefined || revision === owner.lastRevision) return
    diagnostics.refreshes += 1
    owner.queryRevision += 1
    // NO refinement here: the Folder revision moved, so the previous matches can
    // never satisfy the Folder's own revision check — asking for a full scan
    // directly is the honest form of the same answer.
    query(owner)
    change(owner)
  }

  /** The retire that DISCOVERED the death (a refused snapshot, a dead source)
   *  rather than the one an outer lifecycle commit performed. */
  const retireDiscovered = (): void => {
    if (state === undefined) return
    retire()
    ports.requestRender()
    ports.setFocus()
  }

  /** Apply ONE snapshot to the card. Returns false when the binding refused it
   *  (the subject moved or the surface is gone), which retires the card. */
  const applySnapshot = (owner: SearchSeatState, snapshot: TspTranscriptSemanticSearchSnapshot | undefined): boolean => {
    if (snapshot === undefined) return false
    if (snapshot.source !== owner.source) return false
    diagnostics.snapshots += 1
    const previousRepresentative = owner.targets[owner.current]?.representativeId
    // The empty query is the frozen `0 targets` state: the card never claims
    // hits before the user has typed a query, whatever a binding answers.
    const matches = owner.query === '' ? [] : snapshot.matches
    owner.matches = matches
    owner.targets = groupTranscriptSearchTargets(matches)
    owner.coverage = snapshot.coverage
    owner.lastRevision = snapshot.revision
    // The same representative card keeps the selection while it still exists;
    // a vanished card falls back to the FIRST navigable target, never an
    // invented one, and an empty result leaves no current target at all.
    const recovered = previousRepresentative === undefined
      ? -1
      : owner.targets.findIndex((target) => target.representativeId === previousRepresentative)
    owner.current = recovered >= 0 ? recovered : (owner.targets.length === 0 ? -1 : 0)
    return true
  }

  /** Run the current query against the CURRENT source. The refinement offered
   *  to the Folder is the PREVIOUS round's own identity, and the binding applies
   *  it only when it still names this source; the Folder validates the prefix
   *  and the revision itself. */
  const query = (owner: SearchSeatState, refinementRevision?: number): void => {
    if (binding === undefined) return
    const snapshot = binding.snapshot(owner.query, refinementRevision === undefined ? undefined : {
      previousQuery: owner.queried,
      previousMatches: owner.matches,
      revision: refinementRevision,
      source: owner.source,
    })
    if (!applySnapshot(owner, snapshot)) {
      retireDiscovered()
      return
    }
    owner.queried = owner.query
    // The previous reveal/grants belong to the OLD result set: a new query never
    // re-uses them.
    owner.pendingReveal = false
    owner.revealAttempted = false
    owner.reachable = false
    // A new result set is a new navigation identity: the previous target's
    // temporary grants must not linger on a card the user is no longer on.
    ports.navigationChanged()
  }

  /** Start one query round: bump the revision FIRST so any intent or frame of
   *  the previous round is refused by identity. */
  const schedule = (owner: SearchSeatState): void => {
    owner.queryRevision += 1
    diagnostics.queries += 1
    // The refinement's `revision` is the FOLDER revision the current matches
    // were computed on (the Folder rejects anything else and falls back to a
    // full scan), never this seat's own fence counter.
    query(owner, owner.lastRevision)
    change(owner)
  }

  /** Step to an adjacent target (wrapping), then owe ONE reveal. */
  const step = (owner: SearchSeatState, delta: 1 | -1): void => {
    if (owner.targets.length === 0) return
    if (owner.current < 0) {
      owner.current = 0
    } else {
      owner.current = (owner.current + delta + owner.targets.length) % owner.targets.length
    }
    owner.pendingReveal = true
    owner.revealAttempted = false
    owner.reachable = false
    // ONE explicit navigation: the new target's grants are derived before the
    // frame that reveals it.
    ports.navigationChanged()
    change(owner)
    // The reveal is requested by the frame commit that paints the new target,
    // so the canonical owner is derived from the CURRENT Main tree, never from
    // the target alone (see `indexFrame`).
    ports.requestRender()
  }

  const act = (intent: TspTranscriptSearchIntent): void => {
    const owner = state
    if (owner === undefined || owner.retired) return
    if (intent.serial !== owner.openSerial || intent.revision !== owner.queryRevision) return
    if (!operable(owner)) return
    switch (intent.kind) {
      case 'focus-query':
        ports.setFocus()
        return
      case 'next':
        step(owner, 1)
        return
      case 'previous':
        step(owner, -1)
        return
      case 'close':
        retire()
        ports.requestRender()
        ports.setFocus()
        return
      default:
        return
    }
  }

  /** The keyboard route. While the card owns the seat EVERY key is consumed
   *  here, so a stray letter, Ctrl+V, Ctrl+D or a visual chord can never reach
   *  the hidden Composer reducer, the paste intake or another owner. */
  const handleKey = (key: Key): boolean => {
    const owner = state
    if (owner === undefined || owner.retired || owner.phase !== 'open') return false
    if (!ports.admitted() || binding?.current(owner.source) !== true) {
      retireDiscovered()
      return false
    }
    const serial = owner.openSerial
    const revision = owner.queryRevision
    if (key.name === 'escape') { act({ kind: 'close', serial, revision }); return true }
    // `Ctrl+C` is NOT this seat's cancel: it must reach the original upper-level
    // interrupt/cancel owner exactly once. The card retires FIRST — the query,
    // the target and the temporary grants die with it — and the SAME key then
    // falls through the ladder unchanged.
    if (key.ctrl === true && key.name === 'c' && key.alt !== true && key.meta !== true) {
      retire()
      ports.requestRender()
      ports.setFocus()
      return false
    }
    // A second entry chord focuses the query and keeps the current card.
    if (matchesKeyId(key, TSP_SEARCH_CHORD)) {
      act({ kind: 'focus-query', serial, revision })
      return true
    }
    // Every other modified key is CONSUMED here: `Ctrl+V` must never reach the
    // paste-media intake, `Ctrl+D` must never reach the composer's exit gesture,
    // and a visual chord must never run behind the card the user is looking at.
    if (key.ctrl === true || key.meta === true) return true
    // `Shift+Enter` steps BACKWARD and must be matched before the plain Enter
    // (the frozen keyboard journey: Enter/Shift+Enter cycle the card targets).
    if (key.name === 'enter') {
      act(key.shift === true ? { kind: 'previous', serial, revision } : { kind: 'next', serial, revision })
      return true
    }
    // `Tab`/`Shift+Tab` cycle the seat's OWN focus ring (Query → Prev → Next →
    // Close) and never reach the hidden Composer (the frozen contract).
    if (key.name === 'tab') {
      const ring: SearchFocusControl[] = ['query', 'prev', 'next', 'close']
      const at = ring.indexOf(owner.focusControl)
      owner.focusControl = ring[(at + (key.shift === true ? ring.length - 1 : 1)) % ring.length]!
      ports.setFocus(owner.focusControl)
      return true
    }
    const edited = editQuery(owner.query, owner.queryCursor, key)
    if (edited === undefined) return true
    owner.query = edited.query
    owner.queryCursor = edited.cursor
    schedule(owner)
    return true
  }

  const renderState = (): TspTranscriptSearchRenderState | undefined => {
    const owner = state
    if (owner === undefined || owner.retired) return undefined
    if (owner.phase !== 'open' || !ports.admitted()) return undefined
    if (binding?.current(owner.source) !== true) return undefined
    const total = owner.targets.length
    const position = owner.current < 0 ? 0 : owner.current + 1
    const target = owner.current < 0 ? undefined : owner.targets[owner.current]
    return {
      serial: owner.openSerial,
      revision: owner.queryRevision,
      query: owner.query,
      queryCursor: owner.queryCursor,
      queryKey: queryKeyOf(owner.openSerial),
      prevKey: actionKeyOf(owner, 'prev'),
      nextKey: actionKeyOf(owner, 'next'),
      closeKey: actionKeyOf(owner, 'close'),
      countLabel: `${position}/${total} targets`,
      header: headerLabel(owner.coverage),
      // The static source kind is the ONLY content the label carries; the
      // position claim is always the card-level one.
      // Before any navigation the card has earned only the card-level claim; a
      // PROVEN-unreachable target (a reveal was requested and the current pane
      // has no attached card for it) is the one case that says `Unavailable`.
      sourceLabel: target === undefined
        ? 'Source-only · position unverified · no current target'
        : owner.revealAttempted && !owner.reachable
          ? `Unavailable in current pane · ${target.sourceLabel}`
          : `Source-only · position unverified · ${target.sourceLabel}`,
      navigable: total > 0,
      empty: owner.query.trim() === ''
        ? 'Type to search the loaded session.'
        : total === 0 ? 'No matches in the loaded session.' : undefined,
    }
  }

  const indexFrame = (dockRoot: import('@stencil-hq/tern').Node): void => {
    frameIds = new Map()
    const owner = state
    if (owner === undefined || owner.retired || owner.phase !== 'open') return
    const root = View.from({ dock: dockRoot }).regions[1]
    if (root === undefined) return
    const wanted = new Set<string>([
      queryKeyOf(owner.openSerial),
      actionKeyOf(owner, 'prev'),
      actionKeyOf(owner, 'next'),
      actionKeyOf(owner, 'close'),
    ])
    const visit = (tree: NonNullable<typeof root>): void => {
      const key = tree.props['key']
      if (typeof key === 'string' && wanted.has(key)) frameIds.set(key, tree.id)
      for (const child of tree.children) visit(child)
    }
    visit(root)
    // A real navigation owes ONE reveal of the CURRENT target, requested only
    // after the frame that paints it was committed.
    if (owner.pendingReveal) {
      owner.pendingReveal = false
      const requested = ports.requestReveal()
      owner.revealAttempted = true
      owner.reachable = requested
      if (requested) diagnostics.reveals += 1
      // The label the card paints depends on the reveal result.
      ports.requestRender()
    }
  }

  return {
    isOpen: () => {
      const owner = state
      if (owner === undefined || owner.retired || owner.phase !== 'open') return false
      if (binding?.current(owner.source) !== true) return false
      return ports.admitted()
    },
    supported: () => binding !== undefined && nativeSupported(),
    handleKey,
    handleIntent: (intent) => { act(intent) },
    open: () => {
      const current = binding
      if (current === undefined) {
        // No capability means no card: the caller's entry already stated the
        // truth, and the frame that withdraws any stale card is still owed.
        ports.requestRender()
        return
      }
      // ONE instance only: an older card is withdrawn before the new one
      // captures anything, so no older intent can act on it.
      retire()
      const snapshot = current.snapshot('')
      if (snapshot === undefined) {
        // No committed subject to search: the card never opens rather than
        // painting an empty result that would read as "no matches".
        ports.requestRender()
        return
      }
      const owner: SearchSeatState = {
        phase: 'open',
        openSerial: ++openSerial,
        source: snapshot.source,
        subjectKind: snapshot.subjectKind,
        query: '',
        queried: '',
        queryCursor: 0,
        lastRevision: snapshot.revision,
        queryRevision: 0,
        matches: [],
        targets: [],
        current: -1,
        coverage: snapshot.coverage,
        pendingReveal: false,
        revealAttempted: false,
        reachable: false,
        focusControl: 'query',
        retired: false,
      }
      state = owner
      diagnostics.opens += 1
      // Opening is the first navigation epoch of this card.
      ports.navigationChanged()
      if (!applySnapshot(owner, snapshot)) {
        retireDiscovered()
        return
      }
      change(owner)
      ports.setFocus()
    },
    retire,
    renderState,
    indexFrame,
    currentMessage: () => {
      const owner = state
      if (owner === undefined || owner.retired) return undefined
      const target = owner.current < 0 ? undefined : owner.targets[owner.current]
      if (target === undefined) return undefined
      if (binding === undefined) return undefined
      return binding.resolve(owner.source, target.match)
    },
    currentTarget: () => {
      const owner = state
      if (owner === undefined || owner.retired) return undefined
      return owner.current < 0 ? undefined : owner.targets[owner.current]
    },
    currentReachable: () => {
      const owner = state
      if (owner === undefined || owner.retired) return false
      return owner.reachable
    },
    desiredFocusId: () => {
      const owner = state
      if (owner === undefined || owner.retired || owner.phase !== 'open') return undefined
      // The caret follows THE RING: after a Tab the ladder must not pull it back
      // to the query on the next commit. ONE fact serves both the Tab cycle and
      // the post-commit focus (the same mapping, never a second copy).
      return frameIds.get(owner.focusControl === 'query'
        ? queryKeyOf(owner.openSerial)
        : actionKeyOf(owner, owner.focusControl))
    },
    controlFocusId: (control) => {
      const owner = state
      if (owner === undefined || owner.retired || owner.phase !== 'open') return undefined
      return frameIds.get(control === 'query'
        ? queryKeyOf(owner.openSerial)
        : actionKeyOf(owner, control))
    },
    refresh: refreshFromRevision,
    diagnosticsForTest: () => ({ ...diagnostics }),
  }
}

/** The static coverage label. `Entire` is claimed ONLY for a complete log; a
 *  Remote subject with more history says so instead. */
function headerLabel(coverage: TranscriptSearchCoverage): string {
  switch (coverage) {
    case 'entire-session': return 'Session Search · Full semantic · Entire'
    case 'loaded-history-with-more': return 'Session Search · Full semantic · Loaded · Older not searched'
    case 'loaded-history': return 'Session Search · Full semantic · Loaded'
  }
}

/** The ONE stable identity of a target, used by the renderer's grant epoch. */
export function transcriptSearchTargetKey(target: TspTranscriptSearchTarget): string {
  return transcriptSearchMatchKey(target.match)
}

/** The stable string identity of one semantic source (re-exported for the
 *  renderer's temporary-grant projection). */
export { transcriptSearchSourceKey }
