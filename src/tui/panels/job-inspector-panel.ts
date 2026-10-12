/**
 * The selected-Job workspace presenter (Phase 3B / B1-A + B1-B): the typed
 * Header, the retained Output body with the Job's OWN strict follow owner and
 * Find model, the ONE optional SearchRow, a transient notice row and the pinned
 * bottom Action Bar of the Job fullscreen workspace. The notice row renders the
 * app's OWN live notice (the ONE notice authority) while the workspace owns the
 * terminal, so a Stop settlement stays visible where the user is looking — never
 * a second Stop state.
 *
 * The panel IS the layout root and the keyboard focus target of the ONE
 * short-lived `TuiAltScreen` a Job view opens (the opener calls
 * `setLayoutRoot(panel)`), so no proxy component sits outside the mounted
 * layout tree. It holds no durable fact: every `update(state)` replaces the
 * whole frozen projection and asks the owning surface for a repaint. It never
 * observes a Job, reads a backend, owns a timer, or decides open/close —
 * `Esc` and the `tasks.stop` component action are intents injected by the
 * opener, and the Job's own `label` is never rewritten for anything but the
 * displayed one-line summary.
 *
 * The typed INPUT contract (`JobInspectorState` + its opening row) belongs to
 * the application owner that constructs it (`app/surface/task-runtime`, like
 * `TaskBrowserViewState`); this module owns the pure DISPLAY projection
 * (`JobInspectorView` / `deriveJobInspectorView`) and the component.
 *
 * B1-B keeps ONE Job-local interaction authority per concern: the
 * {@link JobOutputScrollView} owns the strict follow intent, the
 * {@link JobOutputSearch} owns the query/index/reveal, and this panel owns only
 * the single per-frame chrome plan and the key dispatch between them.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-inspector-panel
 */

import { Text, VStack, matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { formatKeyId } from '../keybindings/hints.ts'
import { color } from '../theme/runtime.ts'
import { JobOutputScrollView } from './job-output-scroll-view.ts'
import { JobOutputSearch, retentionEviction } from './job-output-search.ts'
import type { JobInspectorState } from '../../app/surface/task-runtime.ts'

/** The pure, non-authoritative display projection of the ONE captured state. */
export interface JobInspectorView {
  readonly jobId: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly retainedText: string
  readonly gapBefore: boolean
  readonly settled: boolean
  readonly observationError?: string
  readonly phase: 'connecting' | 'observed' | 'unavailable'
}

/** Job kinds whose `label` is the shell command the Job was started with. */
const COMMAND_KINDS = new Set(['bash', 'pwsh'])

/** Below this width or row count the header collapses to at most TWO rows
 *  (plan §5 A1: "below 80×10"). */
const COMPACT_WIDTH = 80
const COMPACT_ROWS = 10

/** The Action Bar's own row — the ONE chrome row that is NEVER budgeted away. */
const ACTION_BAR_ROWS = 1
/** The plan's compact-header contract (§5): below 80×10 the header collapses to
 *  at most TWO rows. */
const COMPACT_HEADER_MAX_ROWS = 2
/** The full header's bounded row count (status, progress, detail, facts, command). */
const FULL_HEADER_MAX_ROWS = 5
/** The Job page step mirrors the alt screen's own page semantics (X page scroll). */
const PAGE_SCROLL_OVERLAP = 4

/**
 * The ONE per-frame chrome plan of the workspace: the pinned Action Bar keeps
 * its row first, then the header (status + fact markers, then the Command/Label
 * summary, then the descriptive fact text), then the SearchRow, then the
 * transient notice. Every fixed child derives its row count from THIS plan — a
 * single frame decision, never a per-child `terminal.rows` budget — so no
 * combination of a short terminal, a live search and a live notice can ever push
 * the Action Bar off the screen or squeeze the last Output row away.
 */
interface JobInspectorChromePlan {
  readonly compact: boolean
  readonly headerRows: number
  readonly searchRows: number
  readonly noticeRows: number
}

/** Derive the chrome plan for the CURRENT frame: pure in the live row grant, the
 *  rendered width, whether a notice is live and whether a search row is asked
 *  for. Retention order: Action Bar, Header status row (from 2 rows), one Output
 *  row (from 3 rows), SearchRow (from 4 rows, taking the compact header's second
 *  row when that is what the budget needs), then the header's optional text
 *  rows, and only then the notice. */
const planChrome = (
  width: number,
  rows: number,
  noticeLive: boolean,
  searchRequested: boolean,
): JobInspectorChromePlan => {
  const safeRows = Math.max(1, Math.floor(rows))
  const compact = width < COMPACT_WIDTH || safeRows < COMPACT_ROWS
  const budget = Math.max(0, safeRows - ACTION_BAR_ROWS)
  const outputMin = budget >= 2 ? 1 : 0
  // A SearchRow needs a dedicated row beyond the header's status row and the
  // reserved Output row: four terminal rows is the product minimum (plan §6.1).
  // On exactly that floor the compact header gives up its second row, so the
  // locked `[Status, Search, Output, Action Bar]` frame survives.
  const searchRows = searchRequested && budget >= 3 ? 1 : 0
  const headerCap = compact ? COMPACT_HEADER_MAX_ROWS : FULL_HEADER_MAX_ROWS
  const headerMax = Math.max(
    Math.min(1, budget),
    Math.min(headerCap, budget - searchRows - outputMin),
  )
  // The notice yields to the Action Bar, the header's own row grant, the
  // SearchRow and at least one readable Output row; its INFORMATION state stays
  // the app's, never lost.
  const noticeRows = noticeLive && budget - searchRows - headerMax >= 2 ? 1 : 0
  const headerRows = Math.max(0, Math.min(headerMax, budget - searchRows - noticeRows))
  return { compact, headerRows, searchRows, noticeRows }
}

/** The retained-body placeholder of a phase with no `text` yet: three
 *  distinct statements, so "still connecting", "settled with nothing
 *  retained" and "the observation failed" can never be mistaken for each
 *  other. */
const BODY_CONNECTING = 'Waiting for retained output…'
const BODY_EMPTY = 'No retained output'
const BODY_UNAVAILABLE = 'Retained output unavailable'

/** The one line every phase shows at the physical bottom: the port's retained
 *  tail is a bounded preview, never the Job's full history. */
const RETAINED_NOTE = 'Retained preview · not full history'

/** The pure display fold of the ONE captured Job state. It answers exactly
 *  one question — what the user may see — and never re-derives authority: the
 *  observed snapshot (when present) is the ONLY source of Job metadata, and
 *  the opener row is a first-frame identity fallback. */
export function deriveJobInspectorView(state: JobInspectorState): JobInspectorView {
  const observed = state.observed
  if (observed !== undefined) {
    return {
      jobId: observed.jobId,
      kind: observed.kind,
      label: observed.label,
      status: observed.status,
      ...(observed.progress === undefined ? {} : { progress: observed.progress }),
      ...(observed.detail === undefined ? {} : { detail: observed.detail }),
      retainedText: observed.text,
      gapBefore: observed.gapBefore,
      settled: observed.settled,
      // A follow-stream error is NOT exclusive with a gap or a settlement:
      // the last good snapshot keeps its own facts (plan §4.2 rule 1).
      ...(observed.error === undefined ? {} : { observationError: observed.error }),
      phase: 'observed',
    }
  }
  if (state.observationError !== undefined) {
    // The port never opened a stream. Identity/status fall back to the row
    // this view was opened from, no retained output exists, and the reason
    // stays visible — never a fabricated "finished with no output".
    return {
      jobId: state.opening.jobId,
      kind: state.opening.kind,
      label: state.opening.label,
      status: state.opening.status,
      ...(state.opening.detail === undefined ? {} : { detail: state.opening.detail }),
      retainedText: '',
      gapBefore: false,
      settled: false,
      observationError: state.observationError,
      phase: 'unavailable',
    }
  }
  return {
    jobId: state.opening.jobId,
    kind: state.opening.kind,
    label: state.opening.label,
    status: state.opening.status,
    ...(state.opening.detail === undefined ? {} : { detail: state.opening.detail }),
    retainedText: '',
    gapBefore: false,
    settled: false,
    phase: 'connecting',
  }
}

/** The opener-injected intents. The panel owns no lifecycle of its own. */
export interface JobInspectorPanelIntents {
  /** The live physical row grant. The shell owns the terminal; the panel
   *  reads it per frame and never keeps a second `terminal.rows` copy. */
  readonly rows: () => number
  /** Repaint through the owning surface (the panel never paints itself). */
  readonly requestRender: () => void
  /** The app's LIVE transient notice (the ONE notice authority), read per frame.
   *  The workspace renders it on its OWN chrome row, so a Stop settlement stays
   *  visible without leaving the workspace — and no second notice state exists. */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** `Esc` — the opener's ONE close intent. */
  readonly onClose: () => void
  /** The live Stop capability (never a cached boolean). */
  readonly canStop: () => boolean
  /** The `tasks.stop` component action, dispatched only while `canStop()`. */
  readonly onStop: () => void
  /** Whether one raw key is the EFFECTIVE direct Find binding of the live keymap
   *  (`app.transcript.search`'s winning resolution). The Job scopes the BINDING
   *  to its own Output; it never shares Transcript data or the search overlay. */
  readonly isFindKey: (data: string) => boolean
  /** The effective Find hint of the Action Bar (direct keys / leader sequence;
   *  '' when Find is disabled or unbound). Never a fabricated `Ctrl+F`. */
  readonly findHint: () => string
  /** Move the physical keyboard focus between the panel root and the visible
   *  SearchRow (the opener's ONE screen owns it). */
  readonly focusComponent: (component: Component) => void
}

/** A raw `label`/`detail`/`error` is shown on ONE row: hard line breaks become
 *  spaces for DISPLAY only (the `View` keeps the original text). */
const oneLine = (text: string): string => text.replace(/\r?\n/g, ' ')

/** The bracketed fact markers of one view, in priority order: independent and
 *  co-visible, never a mutually exclusive status switch. */
const markerTokens = (view: JobInspectorView): string[] => [
  ...(view.gapBefore ? ['[GAP]'] : []),
  ...(view.observationError === undefined ? [] : ['[ERROR]']),
  ...(view.settled ? ['[SETTLED]'] : []),
]

/** The same markers as ONE row. */
const flagMarkers = (view: JobInspectorView): string => markerTokens(view).join(' ')

/** The DESCRIPTIVE facts of one view (the markers already say WHAT happened):
 *  the eviction note and the follow-stream error text. */
const flagTexts = (view: JobInspectorView): string => [
  ...(view.gapBefore ? ['Earlier output evicted'] : []),
  ...(view.observationError === undefined ? [] : [`error: ${oneLine(view.observationError)}`]),
].join('   ')

/** `${reserved}   ${flexText}` with the RESERVED head's room claimed FIRST, so a
 *  long flexible field is the ONLY thing a narrow row truncates. */
const withReservedHead = (reserved: string, flexText: string, width: number): string => {
  const room = width - visibleWidth(reserved) - 3
  return room >= 8 ? `${reserved}   ${truncateToWidth(flexText, room, '…')}` : reserved
}

/** `${prefix} · ${status}` with the STATUS's room claimed first, so a long Job
 *  identity can never push the status out of the row. */
const withReservedStatus = (prefix: string, status: string, width: number): string => {
  const room = width - visibleWidth(status) - 3
  return room >= 8 ? `${truncateToWidth(prefix, room, '…')} · ${status}` : status
}

/** The bounded typed header: Job identity, status, progress, the independent
 *  gap/error/settled facts, and the command-or-label identity. */
class JobInspectorHeader implements Component {
  private view: JobInspectorView
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(view: JobInspectorView, plan: (width: number) => JobInspectorChromePlan) {
    this.view = view
    this.plan = plan
  }

  setView(view: JobInspectorView): void {
    this.view = view
  }

  render(width: number): string[] {
    const view = this.view
    const { compact, headerRows } = this.plan(width)
    if (headerRows <= 0) return []
    const kind = COMMAND_KINDS.has(view.kind) ? 'Command' : 'Label'
    const identity = `Job ${view.jobId} · ${view.kind}`
    const command = `${kind}: ${oneLine(view.label)}`
    const lines: string[] = []
    if (compact) {
      // TWO rows at most, in PRIORITY order. Row one carries the STATUS and every
      // fact marker (never shortened); row two carries the Command/Label summary
      // the locked UI always shows, followed by the descriptive fact text while the
      // row still has room for it — so the summary can never be displaced by a
      // GAP/ERROR description, and the identity prefix is kept only when it fits
      // beside the status.
      let head = view.status
      for (const marker of markerTokens(view)) {
        if (visibleWidth(head) + visibleWidth(marker) + 1 <= width) head += ` ${marker}`
      }
      const withIdentity = `${identity} · ${head}`
      lines.push(visibleWidth(withIdentity) <= width ? withIdentity : head)
      const facts = flagTexts(view)
      lines.push(facts === '' ? command : `${command}   ${facts}`)
    } else {
      // The identity never pushes the status out of its row, and the markers
      // never push the (unbounded) fact text out of theirs.
      lines.push(withReservedStatus(identity, view.status, width))
      if (view.progress !== undefined) lines.push(`progress: ${oneLine(view.progress)}`)
      if (view.detail !== undefined) lines.push(`detail: ${oneLine(view.detail)}`)
      const markers = flagMarkers(view)
      if (markers !== '') {
        const facts = flagTexts(view)
        lines.push(facts === '' ? markers : withReservedHead(markers, facts, width))
      }
      lines.push(command)
    }
    return lines.slice(0, headerRows).map(line => truncateToWidth(line, width, '…', true))
  }

  invalidate(): void {
    // Nothing cached: the view is the only input and the layout frame caches
    // per frame.
  }
}

/** The retained Output body: the ONE `Text` wrapped by the Job search's pure
 *  decoration. The rendered row count and every visible width are preserved, so
 *  the viewport geometry and its hit map stay valid. */
class JobOutputBody implements Component {
  private readonly search: JobOutputSearch

  constructor(search: JobOutputSearch) {
    this.search = search
  }

  render(width: number): string[] {
    return this.search.bodyLines(width)
  }

  invalidate(): void {
    // The wrapped `Text` clears its own render cache on `setText`; decoration is
    // derived per frame and caches nothing here.
  }
}

/** The visible position/follow/find facts of the Action Bar. */
interface JobOutputStatusFacts {
  readonly follow: boolean
  readonly gap: boolean
  readonly findHint: string
  /** Whether a Find owns the ordinary keys this frame: the Stop segment is then
   *  NOT advertised, because the SearchRow consumes ordinary letters (EDIT) and
   *  keeps the Job output read-only in NAVIGATE (`tasks.stop` is inert there). */
  readonly searchActive: boolean
  /** Whether that Find is EDITING its query: `End` then belongs to the Input's
   *  line edit, so the bar must not promise `End resume` nor a Find re-entry. */
  readonly searchEditing: boolean
  readonly position: { readonly start: number; readonly end: number; readonly total: number }
}

/**
 * The pinned bottom Action Bar: `Esc back`, the effective `tasks.stop` hint
 * (only while Stop is live), the strict follow truth, `[GAP]`, the
 * retained-preview disclosure, the CURRENT retained viewport position and the
 * effective Find hint. Whole segments yield in priority order — never an
 * over-wide row, and the disclosure survives whenever the row can carry it.
 */
class JobInspectorActionBar implements Component {
  private readonly canStop: () => boolean
  private readonly facts: (width: number) => JobOutputStatusFacts

  constructor(canStop: () => boolean, facts: (width: number) => JobOutputStatusFacts) {
    this.canStop = canStop
    this.facts = facts
  }

  render(width: number): string[] {
    const facts = this.facts(width)
    // Retention priority: Esc, Stop, Follow, GAP, disclosure, position, Find.
    const segments: Array<{ text: string; priority: number; short?: string }> = []
    segments.push({ text: 'Esc back', priority: 7 })
    const stopKey = componentKeymap.keyHint('tasks.stop')
    if (!facts.searchActive && this.canStop() && stopKey !== '') {
      // B1-A's own compaction: when both effective Stop keys are advertised and
      // the row is tight, the primary key alone still names the real action.
      const primaryKey = componentKeymap.keysFor('tasks.stop')[0]
      const short = primaryKey === undefined ? undefined : `${formatKeyId(primaryKey)} stop`
      segments.push({ text: `${stopKey} stop`, ...(short === undefined || short === `${stopKey} stop` ? {} : { short }), priority: 6 })
    }
    segments.push(facts.follow
      ? { text: 'Follow ON', priority: 5 }
      : facts.searchEditing
        ? { text: 'Follow PAUSED', priority: 5 }
        : { text: 'Follow PAUSED · End resume', short: 'Follow PAUSED', priority: 5 })
    if (facts.gap) segments.push({ text: '[GAP]', priority: 4 })
    segments.push({ text: RETAINED_NOTE, priority: 3 })
    if (facts.position.total > 0) {
      segments.push({
        text: `rows ${facts.position.start}-${facts.position.end}/${facts.position.total}`,
        priority: 2,
      })
    }
    if (!facts.searchEditing) {
      segments.push({ text: facts.findHint === '' ? 'Find /' : `Find ${facts.findHint} /`, priority: 1 })
    }
    for (;;) {
      const line = segments.map(segment => segment.text).join(' | ')
      if (visibleWidth(line) <= width || segments.length <= 1) {
        return [truncateToWidth(line, width, '…', true)]
      }
      const shortenable = segments.find(segment => segment.short !== undefined && segment.text !== segment.short)
      if (shortenable !== undefined) {
        shortenable.text = shortenable.short!
        continue
      }
      let lowest = 0
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index]!.priority < segments[lowest]!.priority) lowest = index
      }
      segments.splice(lowest, 1)
    }
  }

  invalidate(): void {
    // Nothing cached.
  }
}

/** The app's live transient notice as ONE workspace chrome row: the row exists
 *  only while a notice is live (ZERO rows otherwise), so the pinned Action Bar
 *  always stays the last row. The wording/level come from the ONE notice
 *  authority (the app), never from a second Stop state. */
class JobInspectorNoticeRow implements Component {
  private readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(
    notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined,
    plan: (width: number) => JobInspectorChromePlan,
  ) {
    this.notice = notice
    this.plan = plan
  }

  render(width: number): string[] {
    const live = this.notice()
    if (live === undefined || this.plan(width).noticeRows === 0) return []
    const line = live.kind === 'info' ? color.textDim(`ℹ ${live.text}`) : color.error(`✗ ${live.text}`)
    return [truncateToWidth(line, width, '…', true)]
  }

  invalidate(): void {
    // Nothing cached: the notice is read live on every frame.
  }
}

/** The rendered body text of one view (the ScrollView's only child). */
const bodyText = (view: JobInspectorView): string => {
  if (view.phase === 'unavailable') return BODY_UNAVAILABLE
  if (view.phase === 'connecting') return BODY_CONNECTING
  return view.retainedText === '' ? BODY_EMPTY : view.retainedText
}

/** The current retained-preview viewport position — never a Job-history line
 *  number. A body-less phase (placeholder or empty retained text) reports
 *  `0/0`. */
function positionFacts(
  search: JobOutputSearch,
  scrollView: JobOutputScrollView,
  width: number,
): { start: number; end: number; total: number } {
  const total = search.positionTotal(width)
  const viewportHeight = Math.max(0, scrollView.viewportHeight)
  if (total === 0 || viewportHeight === 0) return { start: 0, end: 0, total }
  const maxTop = Math.max(0, total - viewportHeight)
  const top = Math.min(Math.max(0, scrollView.scrollTop), maxTop)
  return { start: top + 1, end: Math.min(total, top + viewportHeight), total }
}

/**
 * The Job workspace root: a fixed typed header, the one-epoch Job Find search
 * row, ONE primary strict-follow `JobOutputScrollView` over the retained body,
 * the transient notice row and the fixed bottom Action Bar. It is the
 * `setLayoutRoot` root AND the keyboard focus target, so `Esc`/`tasks.stop`
 * arrive on its own {@link handleInput} — and, while a Find is being edited, the
 * SearchRow is the physical focus target instead.
 */
export class JobInspectorPanel extends VStack {
  private readonly header: JobInspectorHeader
  private readonly body: Text
  private readonly search: JobOutputSearch
  private readonly scrollView: JobOutputScrollView
  private readonly intents: JobInspectorPanelIntents
  /** One frame plan shared by every fixed child and rewritten once per render,
   *  plus the frame width, the live view the Action Bar reads and the viewport
   *  the position fact was last measured against. */
  private readonly chrome: {
    plan: JobInspectorChromePlan
    width: number
    view: JobInspectorView
    positionViewportHeight: number
  }
  /** The ONE anchor/selection baseline: the retained window that was actually
   *  DRAWN last (source text, width and rendered rows), plus the proven row
   *  eviction applied to it since. Every later snapshot is mapped against THIS
   *  baseline, so an undrawn intermediate window can neither destroy the anchor
   *  nor double-count an eviction. */
  private baselineText = ''
  private baselineWidth = 0
  private baselineLines: readonly string[] | undefined
  private baselineEviction = 0
  private disposed = false

  constructor(initial: JobInspectorState, intents: JobInspectorPanelIntents) {
    const view = deriveJobInspectorView(initial)
    /** The ONE per-frame chrome plan. The fullscreen layout engine renders this
     *  panel's children through its layout node, so the plan is derived at each
     *  fixed child's render boundary from the SAME live inputs and recorded
     *  here; every child of one frame therefore agrees, and the last committed
     *  plan/width are what the frame-painted boundary reads. */
    const chrome: {
      plan: JobInspectorChromePlan
      width: number
      view: JobInspectorView
      /** The viewport height the Action Bar's position was measured against in
       *  the LAST render pass (the layout commits the real viewport only after
       *  every fixed child is measured, so the first frame must self-correct). */
      positionViewportHeight: number
    } = {
      plan: planChrome(0, intents.rows(), intents.notice() !== undefined, false),
      width: 0,
      view,
      positionViewportHeight: -1,
    }
    const plan = (width: number): JobInspectorChromePlan => {
      const next = planChrome(
        width,
        intents.rows(),
        intents.notice() !== undefined,
        search.mode !== 'inactive',
      )
      chrome.plan = next
      chrome.width = width
      return next
    }
    const header = new JobInspectorHeader(view, plan)
    const body = new Text('', 0, 0)
    body.setText(bodyText(view))
    const search = new JobOutputSearch(body, (width) => plan(width).searchRows === 1)
    const scrollView = new JobOutputScrollView(new JobOutputBody(search), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    })
    const bar = new JobInspectorActionBar(intents.canStop, (width) => {
      chrome.positionViewportHeight = scrollView.viewportHeight
      return {
        follow: scrollView.isFollowRequested,
        gap: chrome.view.gapBefore,
        findHint: intents.findHint(),
        searchActive: search.mode !== 'inactive',
        searchEditing: search.mode === 'edit',
        position: positionFacts(search, scrollView, width),
      }
    })
    super([
      // Every fixed child renders AT MOST the rows the plan granted it (zero
      // included), so the pinned Action Bar can never be pushed off the screen;
      // the Output absorbs whatever remains and may reach zero rows.
      { component: header, shrink: 0 },
      { component: search.row, shrink: 0 },
      { component: scrollView, basis: 0, grow: 1 },
      // The transient notice row sits ABOVE the pinned Action Bar and renders
      // zero rows when nothing is live or the budget is too short.
      { component: new JobInspectorNoticeRow(intents.notice, plan), shrink: 0 },
      { component: bar, shrink: 0 },
    ])
    this.header = header
    this.body = body
    this.search = search
    this.scrollView = scrollView
    this.intents = intents
    this.chrome = chrome
    // The opener may ALREADY carry an observed snapshot (an observation port is
    // allowed to emit its first snapshot synchronously inside `open()`), so the
    // searchable source and the position fact are seeded from the initial state
    // exactly like the body text — never left empty until a later push.
    this.search.setSource(view.retainedText, view.phase === 'observed' && view.retainedText !== '')
  }

  /** Replace the whole frozen projection with the latest captured state and
   *  ask the owning surface for one repaint. Inert after dispose(). While the
   *  user is PAUSED, a changed bounded retained window rebases the visible top
   *  row onto provable surviving content instead of jumping to the tail. */
  update(state: JobInspectorState): void {
    if (this.disposed) return
    const view = deriveJobInspectorView(state)
    const searchable = view.phase === 'observed' && view.retainedText !== ''
    this.header.setView(view)
    this.chrome.view = view
    this.body.setText(bodyText(view))
    let selectionEviction: number | undefined
    if (!this.scrollView.isFollowRequested && searchable
      && this.baselineLines !== undefined && this.baselineWidth > 0
      && this.baselineText !== view.retainedText) {
      // The newest window against the LAST DRAWN one: every undrawn snapshot in
      // between is skipped without destroying the baseline, so the visible row
      // is preserved by the TOTAL proven eviction (never re-applied twice).
      const eviction = retentionEviction({
        previousText: this.baselineText,
        nextText: view.retainedText,
        previousRenderedLines: this.baselineLines,
        nextRenderedLines: this.body.render(this.baselineWidth),
      })
      if (eviction !== undefined) {
        this.scrollView.rebaseTo(this.scrollView.scrollTop + this.baselineEviction - eviction)
        selectionEviction = eviction - this.baselineEviction
        this.baselineEviction = eviction
      }
    }
    // The anchor the next frame paints is the ANCHOR REBASE result, so a lost
    // current match can fall back to a match provable from what the user sees.
    this.search.setVisibleAnchor(this.scrollView.scrollTop)
    this.search.setSource(view.retainedText, searchable, selectionEviction)
    this.invalidate()
    this.intents.requestRender()
  }

  /** The layout frame is committed and painted: consume the ONE pending search
   *  reveal against the real geometry, and leave a search whose SearchRow this
   *  frame could no longer show. Never mutates the layout from `render()`. */
  onFramePainted(): void {
    if (this.disposed) return
    // The viewport this frame ACTUALLY painted is the ONE visible anchor a lost
    // search hit falls back to: a plain scroll (arrow/wheel) that never touches
    // the Job output must still move it, or a later resize would re-select from
    // a stale position.
    this.search.setVisibleAnchor(this.scrollView.scrollTop)
    // The frame is committed: the window it painted becomes the ONE baseline
    // every later snapshot is mapped against. A placeholder phase has no
    // baseline at all.
    const painted = this.search.renderedEpoch()
    if (painted === undefined) {
      this.baselineLines = undefined
      this.baselineWidth = 0
      this.baselineEviction = 0
    } else if (painted.text !== this.baselineText || painted.width !== this.baselineWidth) {
      this.baselineText = painted.text
      this.baselineWidth = painted.width
      this.baselineLines = painted.lines
      this.baselineEviction = 0
    }
    if (this.search.mode !== 'inactive' && this.chrome.plan.searchRows === 0) {
      this.exitSearch()
      return
    }
    const target = this.search.consumeReveal(
      this.scrollView.scrollTop,
      this.scrollView.viewportHeight,
      this.chrome.width,
    )
    if (target !== undefined) {
      this.scrollView.scrollTo(target)
      this.intents.requestRender()
    }
    // The fixed chrome is measured BEFORE the layout commits this frame's real
    // viewport, so a frame whose position fact was derived from a stale viewport
    // repaints ONCE with the committed geometry and keeps the Action Bar's
    // `rows a-b/N` truthful from the first visible frame — no second geometry
    // authority, and the guard converges after one extra frame.
    if (this.chrome.positionViewportHeight !== this.scrollView.viewportHeight) {
      this.chrome.positionViewportHeight = this.scrollView.viewportHeight
      this.intents.requestRender()
    }
  }

  /** The Job workspace's ONE input owner. `Esc`/`tasks.stop` are the B1-A
   *  intents; Find, the search state machine and the strict-follow viewport keys
   *  are B1-B's. Every other key is inert: the Job is read-only and never leaks
   *  into the background editor or transcript. */
  handleInput(data: string): void {
    if (this.disposed) return
    const search = this.search
    if (search.mode === 'edit') {
      // EDIT: the SearchRow's real Input owns line editing; Enter and Esc are the
      // Job search's own mode seams, never a Job submit or close.
      if (matchesKey(data, 'escape')) {
        this.exitSearch()
        return
      }
      if (matchesKey(data, 'enter')) {
        search.enterNavigate()
        this.intents.requestRender()
        return
      }
      if (search.editKey(data)) this.intents.requestRender()
      return
    }
    // Physical End/Home are the Job's RESERVED viewport keys (plan §5.1): the
    // owner handles them FIRST so a Find binding remapped onto one of them can
    // never shadow the ONLY follow re-arm (End) or the retained-preview top
    // (Home). The Action Bar's Find hint drops such a reserved binding, and `/`
    // stays the always-available Job-local Find alias.
    if (matchesKey(data, 'end')) {
      // Physical End is the ONLY follow re-arm; a live result view is left
      // through the ONE exit path (physical focus returns to the panel) so the
      // tail is not locked by a stale selection.
      if (search.mode === 'navigate') this.exitSearch()
      this.scrollView.resumeFollow()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'home')) {
      this.scrollView.scrollToStart()
      this.intents.requestRender()
      return
    }
    // `/` is the Job-local alias and the effective Find binding is scoped to the
    // Job: both open EDIT here and never reach the Transcript search.
    if (matchesKey(data, '/') || this.intents.isFindKey(data)) {
      this.openFind()
      return
    }
    if (matchesKey(data, 'escape')) {
      // Only a non-searching Esc is the B1-A close intent.
      if (search.mode === 'navigate') {
        this.exitSearch()
        return
      }
      this.intents.onClose()
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight - PAGE_SCROLL_OVERLAP))
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight - PAGE_SCROLL_OVERLAP))
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'up')) {
      this.scrollView.scrollBy(-1)
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.scrollView.scrollBy(1)
      this.intents.requestRender()
      return
    }
    // Ctrl+Home / Ctrl+End are the fork viewport-request aliases: pure browsing,
    // so they pause and never re-arm follow.
    if (matchesKey(data, 'ctrl+home')) {
      this.scrollView.scrollToStart()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'ctrl+end')) {
      this.scrollView.scrollToEnd()
      this.intents.requestRender()
      return
    }
    if (search.mode === 'navigate') {
      // NAVIGATE: only the result navigation keys act; ordinary printing is
      // inert — the Job is read-only and never leaks into the editor.
      if (matchesKey(data, 'n')) {
        search.step(1)
        this.intents.requestRender()
      } else if (matchesKey(data, 'shift+n')) {
        search.step(-1)
        this.intents.requestRender()
      }
      return
    }
    if (componentKeymap.matches(data, 'tasks.stop') && this.intents.canStop()) this.intents.onStop()
  }

  /** Make updates and intents inert. The owned children (the body text, the
   *  ScrollView, the SearchRow) are released by the inherited container chain. */
  dispose(): void {
    this.disposed = true
    super.dispose()
  }

  /** Open (or re-open) the Job Find — the shared entry of the direct effective
   *  Find binding, the `/` alias and the Host leader completion. Below four rows
   *  the frame grants no SearchRow, so the request changes no state. */
  openFind(): void {
    if (this.disposed) return
    // Below four rows the frame grants no SearchRow, so Find cannot be entered as
    // a hidden editor: the request is consumed without changing any state.
    if (planChrome(this.chrome.width, this.intents.rows(), this.intents.notice() !== undefined, true).searchRows === 0) {
      return
    }
    this.search.openFind(this.scrollView.scrollTop)
    // Opening Find is browsing: follow never survives it.
    this.scrollView.pauseFollow()
    this.intents.focusComponent(this.search.row)
    this.intents.requestRender()
  }

  private exitSearch(): void {
    this.search.exit()
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }
}
