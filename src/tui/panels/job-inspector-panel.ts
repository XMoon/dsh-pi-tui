/**
 * The selected-Job workspace presenter (Phase 3B / B1-A + B1-B + B1-C): the
 * typed Header, the retained Output body with the Job's OWN strict follow owner
 * and Find model, the mutually exclusive Command reading page, the ONE optional
 * SearchRow, a transient notice row and the pinned bottom Action Bar of the Job
 * fullscreen workspace. The notice row renders the app's OWN live notice (the
 * ONE notice authority) while the workspace owns the terminal, so a Stop
 * settlement stays visible where the user is looking — never a second Stop
 * state.
 *
 * The panel IS the layout root and the keyboard focus target of the ONE
 * short-lived `TuiAltScreen` a Job view opens (the opener calls
 * `setLayoutRoot(panel)`), so no proxy component sits outside the mounted
 * layout tree. It holds no durable fact: every `update(state)` replaces the
 * whole frozen projection and asks the owning surface for a repaint. It never
 * observes a Job, reads a backend, owns a timer, or decides open/close —
 * `Esc` and the `tasks.stop` component action are intents injected by the
 * opener, and the Job's own `label` is never rewritten for anything but the
 * displayed one-line summary and the B1-C Command document.
 *
 * The typed INPUT contract (`JobInspectorState` + its opening row) belongs to
 * the application owner that constructs it (`app/surface/task-runtime`, like
 * `TaskBrowserViewState`); this module owns the pure DISPLAY projection
 * (`JobInspectorView` / `deriveJobInspectorView`) and the component.
 *
 * ONE Job-local interaction authority per concern: the
 * {@link JobOutputScrollView} owns the strict Output follow intent, the Output
 * {@link JobOutputSearch} owns its query/index/reveal, the
 * {@link JobCommandReader} owns the Command viewport / original-text selection /
 * Command Find, and this panel owns only the single per-frame chrome plan, the
 * `activeReadView` switch and the key dispatch between them. Both bodies stay
 * constructed for the WHOLE panel lifetime and are made mutually invisible by
 * the layout's own `visible` entries — the Output page can therefore never lose
 * its follow intent, anchor or query by visiting the Command page.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-inspector-panel
 */

import { Text, VStack, matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { formatKeyId } from '../keybindings/hints.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import { JobCommandReader, type CommandPaintedBox } from './job-command-reader.ts'
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

/** The two mutually exclusive READING pages of ONE Job workspace. */
export type JobReadView = 'output' | 'command'

/** The three copy sources of the workspace (plan §1.2). */
export type JobCopySource = 'output' | 'command-all' | 'command-selection'

/** Why ONE copy intent has no payload (plan §3). The workspace never guesses:
 *  it names the exact source state, and the app answers with the fixed notice
 *  instead of a clipboard write. */
export type JobCopyUnavailable = 'output-empty' | 'output-unavailable' | 'command-unavailable'

/** ONE copy intent: the payload is captured SYNCHRONOUSLY by the panel, so the
 *  app's asynchronous clipboard settlement never recomputes it from newer
 *  state. `unavailable` is set INSTEAD of a payload when the intent cannot
 *  execute: the app then writes nothing and reports the named reason. */
export interface JobCopyRequest {
  readonly source: JobCopySource
  readonly text: string
  readonly unavailable?: JobCopyUnavailable
}

/** One clickable region of the LAST PAINTED header frame. `row` is relative to
 *  the header's own first painted row; `documentKey` identifies the exact
 *  Command source the target belonged to. */
export interface JobHeaderHitTarget {
  readonly row: number
  readonly startCol: number
  readonly endCol: number
  readonly action: 'open-command' | 'copy-command-all'
  readonly documentKey: string
  readonly view: JobReadView
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

/** The Command page's reader/identity row. `COMMAND_READER_PREFIX` is the part
 *  before the interactive Copy All affordance, so the hit map can name exactly
 *  the cells the user can click. */
const COMMAND_READER_PREFIX = 'Command reader · '
const COMMAND_COPY_ALL = '[Copy All]'
const COMMAND_READER_ROW = `${COMMAND_READER_PREFIX}${COMMAND_COPY_ALL}`

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

/** The Command page's counterpart disclosure: the reader shows the ORIGINAL
 *  command, not a preview of it (plan §5.2). */
const COMMAND_FULL_NOTE = 'Full command'

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
  /** ONE copy intent with its SYNCHRONOUSLY captured payload. The app executes
   *  it through the existing Client-local clipboard capability; the panel never
   *  writes a clipboard itself. */
  readonly onCopy: (request: JobCopyRequest) => void
  /** The LAST PAINTED rect of a mounted component (the alt screen's X054
   *  read-only geometry query at the frame-painted boundary), or undefined when
   *  it is not part of that frame. */
  readonly paintedBox: (component: Component) => CommandPaintedBox | undefined
  /** Whether one raw key is the EFFECTIVE direct Find binding of the live keymap
   *  (`app.transcript.search`'s winning resolution). The Job scopes the BINDING
   *  to its own page; it never shares Transcript data or the search overlay. */
  readonly isFindKey: (data: string) => boolean
  /** The effective Find hint of the Action Bar (direct keys / leader sequence;
   *  '' when Find is disabled or unbound). Never a fabricated `Ctrl+F`. */
  readonly findHint: () => string
  /** Move the physical keyboard focus between the panel root and the visible
   *  SearchRow (the opener's ONE screen owns it). */
  readonly focusComponent: (component: Component) => void
  /** Whether the fork's OWN copy-on-select may run on this screen (the opener
   *  owns the screen's real setting). The Command page owns an EXACT copy
   *  affordance, so the native word/line selection copy is suspended while it is
   *  shown — otherwise a rapid second click on `[Copy All]` would be classified
   *  as a word selection and overwrite the just-copied command. The Output page
   *  keeps whatever the screen started with. */
  readonly setNativeCopyOnSelect: (enabled: boolean) => void
}

/** A raw `label`/`detail`/`error` is shown on ONE row: hard line breaks become
 *  spaces for DISPLAY only, and COMPLETE terminal escape sequences plus any
 *  remaining C0/C1 control byte are removed at this ONE display boundary: the
 *  official raw `label`/`detail`/`progress` stay untouched in the `View`, the
 *  Command document and every copy payload. */
const headerText = (text: string): string => sanitizedPhysicalLine(text)

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
  ...(view.observationError === undefined ? [] : [`error: ${headerText(view.observationError)}`]),
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
 *  gap/error/settled facts, the command-or-label identity, and — on the Command
 *  page — the reader row with its Copy All affordance. It also reports the hit
 *  regions its LAST render produced, so a later click resolves against the frame
 *  the user actually saw rather than a re-measured live layout. */
class JobInspectorHeader implements Component {
  private view: JobInspectorView
  private mode: JobReadView = 'output'
  private commandAvailable = false
  private hitTargets: readonly JobHeaderHitTarget[] = []
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(view: JobInspectorView, plan: (width: number) => JobInspectorChromePlan) {
    this.view = view
    this.plan = plan
  }

  setState(view: JobInspectorView, mode: JobReadView, commandAvailable: boolean): void {
    this.view = view
    this.mode = mode
    this.commandAvailable = commandAvailable
  }

  /** The hit targets of the LAST rendered frame (empty when the frame showed
   *  no clickable Command affordance). */
  hits(): readonly JobHeaderHitTarget[] {
    return this.hitTargets
  }

  render(width: number): string[] {
    return this.mode === 'command' ? this.renderCommand(width) : this.renderOutput(width)
  }

  /** The B1-A/B Output header, unchanged, plus the one clickable region the
   *  B1-C Command summary adds while a shell Command is actually observed. */
  private renderOutput(width: number): string[] {
    const view = this.view
    const { compact, headerRows } = this.plan(width)
    if (headerRows <= 0) {
      this.hitTargets = []
      return []
    }
    const kind = COMMAND_KINDS.has(view.kind) ? 'Command' : 'Label'
    const identity = headerText(`Job ${view.jobId} · ${view.kind}`)
    const command = `${kind}: ${headerText(view.label)}`
    const lines: string[] = []
    if (compact) {
      // TWO rows at most, in PRIORITY order. Row one carries the STATUS and every
      // fact marker (never shortened); row two carries the Command/Label summary
      // the locked UI always shows, followed by the descriptive fact text while the
      // row still has room for it — so the summary can never be displaced by a
      // GAP/ERROR description, and the identity prefix is kept only when it fits
      // beside the status.
      let head = headerText(view.status)
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
      lines.push(withReservedStatus(identity, headerText(view.status), width))
      if (view.progress !== undefined) lines.push(`progress: ${headerText(view.progress)}`)
      if (view.detail !== undefined) lines.push(`detail: ${headerText(view.detail)}`)
      const markers = flagMarkers(view)
      if (markers !== '') {
        const facts = flagTexts(view)
        lines.push(facts === '' ? markers : withReservedHead(markers, facts, width))
      }
      lines.push(command)
    }
    // The Command summary is the LAST rendered row of both layouts: its hit map
    // must describe the truncated text the frame really painted.
    const commandRow = lines.length - 1
    const truncated = lines.slice(0, headerRows).map(line => truncateToWidth(line, width, '…', true))
    this.hitTargets = this.observedTarget(commandRow, command, truncated, width)
    return truncated
  }

  /** The Command page header: the same status/marker truth, the descriptive
   *  rows while the frame can still show the reader row, and then the reader row
   *  with its Copy All affordance. */
  private renderCommand(width: number): string[] {
    const view = this.view
    const { headerRows } = this.plan(width)
    if (headerRows <= 0) {
      this.hitTargets = []
      return []
    }
    const identity = headerText(`Job ${view.jobId} · ${view.kind}`)
    // The markers are appended to the status row when they fit, because the
    // Command page reserves its last row for the reader identity: a finger/ERROR
    // fact must never be the price of the Copy All affordance.
    let head = headerText(view.status)
    for (const marker of markerTokens(view)) {
      if (visibleWidth(head) + visibleWidth(marker) + 1 <= width) head += ` ${marker}`
    }
    const withIdentity = `${identity} · ${head}`
    const middle: string[] = []
    if (view.progress !== undefined) middle.push(`progress: ${headerText(view.progress)}`)
    if (view.detail !== undefined) middle.push(`detail: ${headerText(view.detail)}`)
    const markers = flagMarkers(view)
    if (markers !== '') {
      const facts = flagTexts(view)
      middle.push(facts === '' ? markers : withReservedHead(markers, facts, width))
    }
    const readerRow = COMMAND_READER_ROW
    const lines = [visibleWidth(withIdentity) <= width ? withIdentity : head]
    if (headerRows >= 2) {
      lines.push(...middle.slice(0, headerRows - 2))
      lines.push(readerRow)
    }
    const truncated = lines.slice(0, headerRows).map(line => truncateToWidth(line, width, '…', true))
    const row = truncated.length - 1
    // The clickable region is exactly the PAINTED BUTTON, never the blank
    // padding `truncateToWidth(..., true)` appends to the row: a click on the
    // header's trailing space must not write the clipboard.
    const buttonEnd = visibleWidth(COMMAND_READER_PREFIX) + visibleWidth(COMMAND_COPY_ALL)
    this.hitTargets = truncated.length >= 2 && visibleWidth(readerRow) <= width
      ? [{
          row,
          startCol: visibleWidth(COMMAND_READER_PREFIX),
          endCol: buttonEnd,
          action: 'copy-command-all',
          documentKey: this.documentKey(),
          view: 'command',
        }]
      : []
    return truncated
  }

  /** The Command summary hit region of the Output page, only while a shell
   *  Command is really observed AND the painted row survived the truncation.
   *  The region is the `Command: …` / `Label: …` summary ITSELF: neither the
   *  GAP/ERROR fact text that shares the compact row nor the blank padding
   *  `truncateToWidth(..., true)` appends may become clickable. */
  private observedTarget(
    commandRow: number,
    summary: string,
    truncated: readonly string[],
    width: number,
  ): JobHeaderHitTarget[] {
    if (!this.commandAvailable) return []
    if (truncated[commandRow] === undefined) return []
    const summaryWidth = Math.min(width, visibleWidth(summary))
    if (summaryWidth === 0) return []
    return [{
      row: commandRow,
      startCol: 0,
      endCol: summaryWidth,
      action: 'open-command',
      documentKey: this.documentKey(),
      view: 'output',
    }]
  }

  /** The exact Command source identity a hit target belongs to. */
  private documentKey(): string {
    return `${this.view.kind}\u0000${this.view.label}`
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

/** One Action Bar segment: `short` is the compaction this segment accepts when
 *  the row is tight, `priority` the order it is DROPPED in (lower goes first). */
interface JobActionBarSegment {
  text: string
  priority: number
  short?: string
}

/** Lay out one Action Bar row: compact shortenable segments first, then drop
 *  the lowest-priority segment until the row fits (never the last one). */
function renderActionBarRow(segments: JobActionBarSegment[], width: number): string {
  for (;;) {
    const line = segments.map(segment => segment.text).join(' | ')
    if (visibleWidth(line) <= width || segments.length <= 1) {
      return truncateToWidth(line, width, '…', true)
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
  /** Whether `v` can open the shell Command page this frame. */
  readonly canViewCommand: boolean
  /** Whether `C` can copy a non-empty retained Output this frame. */
  readonly canCopyOutput: boolean
}

/** The visible facts of the Command page's Action Bar. */
interface JobCommandStatusFacts {
  readonly findHint: string
  readonly searchActive: boolean
  readonly searchEditing: boolean
  readonly position: { readonly start: number; readonly end: number; readonly total: number }
}

/**
 * The pinned bottom Action Bar: `Esc`, the effective `tasks.stop` hint (only
 * while Stop is live), the strict follow truth, `[GAP]`, the retained/full
 * disclosure, the CURRENT viewport position and the effective Find hint, plus
 * the Job-local read-only `V command` / `C copy` verbs. Whole segments yield in
 * priority order — never an over-wide row, and the disclosure survives whenever
 * the row can carry it. The Command page advertises ONLY what it can do: no
 * Stop, no Follow, `C copy all` only while no Find owns the ordinary keys.
 */
class JobInspectorActionBar implements Component {
  private readonly canStop: () => boolean
  private readonly facts: (width: number) => JobOutputStatusFacts | (JobCommandStatusFacts & { readonly command: true })

  constructor(
    canStop: () => boolean,
    facts: (width: number) => JobOutputStatusFacts | (JobCommandStatusFacts & { readonly command: true }),
  ) {
    this.canStop = canStop
    this.facts = facts
  }

  render(width: number): string[] {
    const facts = this.facts(width)
    if ('command' in facts) {
      const segments: JobActionBarSegment[] = []
      segments.push({ text: 'Esc output', priority: 7 })
      if (!facts.searchActive) segments.push({ text: 'C copy all', priority: 6 })
      segments.push({ text: COMMAND_FULL_NOTE, priority: 5 })
      if (facts.position.total > 0) {
        segments.push({
          text: `rows ${facts.position.start}-${facts.position.end}/${facts.position.total}`,
          priority: 2,
        })
      }
      if (!facts.searchEditing) {
        segments.push({ text: facts.findHint === '' ? 'Find /' : `Find ${facts.findHint} /`, priority: 1 })
      }
      return [renderActionBarRow(segments, width)]
    }
    // Retention priority: Esc, Stop, Follow, GAP, disclosure, position, Find,
    // then the two B1-C verbs (they are the ONLY segments a tight row may drop
    // before the pre-existing truth).
    const segments: JobActionBarSegment[] = []
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
    // Neither verb is advertised while a Job Find owns the ordinary keys
    // (`v`/`C` are inert in EDIT and NAVIGATE), nor when the action itself
    // cannot execute this frame. Both yield BEFORE every pre-existing segment
    // (B1-B's Follow/GAP/disclosure/position/Find truth is unchanged), and their
    // two DIFFERENT priorities make the drop order deliberate rather than
    // array-order-dependent: the Command entry outranks the Output copy verb, so
    // a row wide enough for one verb advertises the read-only page entry.
    if (!facts.searchActive) {
      if (facts.canCopyOutput) segments.push({ text: 'C copy output', priority: 0.5 })
      if (facts.canViewCommand) segments.push({ text: 'V command', priority: 0.6 })
    }
    return [renderActionBarRow(segments, width)]
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

/** Whether the observed snapshot really is a shell Command the reader may show
 *  and copy (plan §1.1: never inferred from an opening row or a shell-looking
 *  label). */
const commandEligible = (view: JobInspectorView): boolean =>
  view.phase === 'observed' && COMMAND_KINDS.has(view.kind) && view.label !== ''

/** The current retained-preview viewport position — never a Job-history line
 *  number. A body-less phase (placeholder or empty retained text) reports
 *  `0/0`. */
function positionFacts(
  search: JobOutputSearch,
  scrollView: { readonly viewportHeight: number; readonly scrollTop: number },
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
 * The Job workspace root: a fixed typed header, the one-epoch Find search row
 * of the CURRENT page, ONE primary ScrollView over the current body, the
 * transient notice row and the fixed bottom Action Bar. It is the
 * `setLayoutRoot` root AND the keyboard focus target, so `Esc`/`tasks.stop`
 * arrive on its own {@link handleInput} — and, while a Find is being edited, the
 * SearchRow is the physical focus target instead.
 */
export class JobInspectorPanel extends VStack {
  private readonly header: JobInspectorHeader
  private readonly body: Text
  private readonly search: JobOutputSearch
  private readonly scrollView: JobOutputScrollView
  private readonly commandReader: JobCommandReader
  /** The ONE reading-page owner of this instance. Mutated only through the
   *  guarded transitions below, so the layout's `visible` entries always agree
   *  with the key routing. */
  private readonly readState: { view: JobReadView }
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
  /** The header's hit regions of the LAST PAINTED frame, the header's painted
   *  top row and the press-time target a same-cell click must re-prove. */
  private paintedTargets: readonly JobHeaderHitTarget[] = []
  private headerTop = 0
  private pressedTarget: JobHeaderHitTarget | undefined
  private disposed = false

  constructor(initial: JobInspectorState, intents: JobInspectorPanelIntents) {
    const view = deriveJobInspectorView(initial)
    const readState: { view: JobReadView } = { view: 'output' }
    /** The Command reader is built AFTER the chrome plan closure (the plan asks
     *  the ACTIVE page for its Find state) — the holder breaks that cycle
     *  without ever reading an unset value, because the plan runs only during a
     *  render. */
    const holders: { commandReader?: JobCommandReader } = {}
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
      const activeSearchMode = readState.view === 'command'
        ? holders.commandReader?.search.mode ?? 'inactive'
        : search.mode
      const next = planChrome(
        width,
        intents.rows(),
        intents.notice() !== undefined,
        activeSearchMode !== 'inactive',
      )
      chrome.plan = next
      chrome.width = width
      return next
    }
    const header = new JobInspectorHeader(view, plan)
    const body = new Text('', 0, 0)
    body.setText(bodyText(view))
    const search = new JobOutputSearch(
      body,
      (width) => readState.view === 'output' && plan(width).searchRows === 1,
    )
    const scrollView = new JobOutputScrollView(new JobOutputBody(search), {
      follow: 'end',
      primary: true,
      scrollbar: 'auto',
    })
    const commandReader = new JobCommandReader({
      requestRender: intents.requestRender,
      paintedBox: intents.paintedBox,
      onCopy: (text) => intents.onCopy({ source: 'command-selection', text }),
      searchRowVisible: (width) => readState.view === 'command' && plan(width).searchRows === 1,
    })
    holders.commandReader = commandReader
    const bar = new JobInspectorActionBar(intents.canStop, (width) => {
      if (readState.view === 'command') {
        chrome.positionViewportHeight = commandReader.scroll.viewportHeight
        return {
          command: true,
          findHint: intents.findHint(),
          searchActive: commandReader.search.mode !== 'inactive',
          searchEditing: commandReader.search.mode === 'edit',
          position: positionFacts(commandReader.search, commandReader.scroll, width),
        }
      }
      chrome.positionViewportHeight = scrollView.viewportHeight
      return {
        follow: scrollView.isFollowRequested,
        gap: chrome.view.gapBefore,
        findHint: intents.findHint(),
        searchActive: search.mode !== 'inactive',
        searchEditing: search.mode === 'edit',
        position: positionFacts(search, scrollView, width),
        canViewCommand: commandEligible(chrome.view),
        canCopyOutput: chrome.view.phase === 'observed' && chrome.view.retainedText !== '',
      }
    })
    super([
      // Every fixed child renders AT MOST the rows the plan granted it (zero
      // included), so the pinned Action Bar can never be pushed off the screen;
      // the current body absorbs whatever remains and may reach zero rows.
      // The two bodies and their SearchRows are mounted ONCE and made mutually
      // invisible, so neither loses its scroll/follow/query state on a switch.
      { component: header, shrink: 0 },
      { component: search.row, shrink: 0, visible: () => readState.view === 'output' },
      { component: commandReader.search.row, shrink: 0, visible: () => readState.view === 'command' },
      { component: scrollView, basis: 0, grow: 1, visible: () => readState.view === 'output' },
      { component: commandReader.scroll, basis: 0, grow: 1, visible: () => readState.view === 'command' },
      // The transient notice row sits ABOVE the pinned Action Bar and renders
      // zero rows when nothing is live or the budget is too short.
      { component: new JobInspectorNoticeRow(intents.notice, plan), shrink: 0 },
      { component: bar, shrink: 0 },
    ])
    this.header = header
    this.body = body
    this.search = search
    this.scrollView = scrollView
    this.commandReader = commandReader
    this.readState = readState
    this.intents = intents
    this.chrome = chrome
    // The opener may ALREADY carry an observed snapshot (an observation port is
    // allowed to emit its first snapshot synchronously inside `open()`), so the
    // searchable source and the position fact are seeded from the initial state
    // exactly like the body text — never left empty until a later push.
    this.search.setSource(view.retainedText, view.phase === 'observed' && view.retainedText !== '')
    this.header.setState(view, 'output', commandEligible(view))
    if (commandEligible(view)) this.commandReader.setSource(view.label)
  }

  /** Replace the whole frozen projection with the latest captured state and
   *  ask the owning surface for one repaint. Inert after dispose(). While the
   *  user is PAUSED, a changed bounded retained window rebases the visible top
   *  row onto provable surviving content instead of jumping to the tail. */
  update(state: JobInspectorState): void {
    if (this.disposed) return
    const view = deriveJobInspectorView(state)
    const searchable = view.phase === 'observed' && view.retainedText !== ''
    const eligible = commandEligible(view)
    // A lost Command eligibility returns to the ONLY readable page: the Command
    // reader must never be left as a hidden focus/gesture owner.
    const previousView = this.readState.view
    const nextView: JobReadView = previousView === 'command' && !eligible ? 'output' : previousView
    if (nextView !== previousView) {
      this.commandReader.exitSearch()
      this.commandReader.cancelSelection()
    }
    this.readState.view = nextView
    this.header.setState(view, nextView, eligible)
    if (nextView !== previousView) this.intents.setNativeCopyOnSelect(nextView === 'output')
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
    // The Command document follows the SAME observed label authority; a changed
    // label drops the old selection offsets, and a lost eligibility returns the
    // ONLY page that can still be read.
    if (eligible) this.commandReader.setSource(view.label)
    else this.commandReader.clearSource()
    if (nextView !== previousView) {
      // The header/action bar project the SAME reading page as the key routing.
      this.pressedTarget = undefined
      this.intents.focusComponent(this)
    }
    this.invalidate()
    this.intents.requestRender()
  }

  /** The layout frame is committed and painted: consume the ONE pending search
   *  reveal of the CURRENT page against the real geometry, leave a search whose
   *  SearchRow this frame could no longer show, and commit the header hit map
   *  the user can actually click. Never mutates the layout from `render()`. */
  onFramePainted(): void {
    if (this.disposed) return
    // The painted header frame is the ONE identity a later click resolves
    // against: its rows and the clickable regions its last render produced.
    this.headerTop = this.intents.paintedBox(this.header)?.y ?? 0
    this.paintedTargets = this.header.hits()
    if (this.readState.view === 'command') {
      if (this.commandReader.search.mode !== 'inactive' && this.chrome.plan.searchRows === 0) {
        this.exitSearch()
        return
      }
      const target = this.commandReader.search.consumeReveal(
        this.commandReader.scroll.scrollTop,
        this.commandReader.scroll.viewportHeight,
        this.chrome.width,
      )
      if (target !== undefined) {
        this.commandReader.scroll.scrollTo(target)
        this.intents.requestRender()
      }
      if (this.chrome.positionViewportHeight !== this.commandReader.scroll.viewportHeight) {
        this.chrome.positionViewportHeight = this.commandReader.scroll.viewportHeight
        this.intents.requestRender()
      }
      return
    }
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

  /**
   * The Job workspace's ONE input owner. `Esc`/`tasks.stop` are the B1-A
   * intents; Find, the search state machine, the strict-follow viewport keys and
   * the Job-local `v`/`C` verbs are B1-B/B1-C's. Every other key is inert: the
   * Job is read-only and never leaks into the background editor or transcript.
   */
  handleInput(data: string): void {
    if (this.disposed) return
    const command = this.readState.view === 'command'
    const search = command ? this.commandReader.search : this.search
    const scroll = command ? this.commandReader.scroll : this.scrollView
    if (search.mode === 'edit') {
      // EDIT: the SearchRow's real Input owns line editing; Enter and Esc are the
      // Job search's own mode seams, never a Job submit, a copy or a close.
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
    // never shadow the ONLY follow re-arm (End on Output) / the viewport ends.
    // The Action Bar's Find hint drops such a reserved binding, and `/` stays
    // the always-available Job-local Find alias.
    if (matchesKey(data, 'end')) {
      // On Output, physical End is the ONLY follow re-arm; a live result view is
      // left through the ONE exit path (physical focus returns to the panel) so
      // the tail is not locked by a stale selection. On Command there is no
      // follow: End is the document's own last row.
      if (search.mode === 'navigate') this.exitSearch()
      if (command) this.commandReader.scroll.scrollToEnd()
      else this.scrollView.resumeFollow()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'home')) {
      scroll.scrollToStart()
      this.intents.requestRender()
      return
    }
    // `/` is the Job-local alias and the effective Find binding is scoped to the
    // Job: both open EDIT on the CURRENT reading page and never reach the
    // Transcript search.
    if (matchesKey(data, '/') || this.intents.isFindKey(data)) {
      this.openFind()
      return
    }
    if (matchesKey(data, 'escape')) {
      if (search.mode === 'navigate') {
        this.exitSearch()
        return
      }
      if (command) {
        // Command is a page of the SAME workspace: Esc returns to Output and
        // never closes the workspace or releases the observer.
        this.showOutput()
        this.intents.requestRender()
        return
      }
      this.intents.onClose()
      return
    }
    if (matchesKey(data, 'pageUp')) {
      scroll.scrollBy(-Math.max(1, scroll.viewportHeight - PAGE_SCROLL_OVERLAP))
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'pageDown')) {
      scroll.scrollBy(Math.max(1, scroll.viewportHeight - PAGE_SCROLL_OVERLAP))
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'up')) {
      scroll.scrollBy(-1)
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      scroll.scrollBy(1)
      this.intents.requestRender()
      return
    }
    // Ctrl+Home / Ctrl+End are the fork viewport-request aliases: pure browsing,
    // so they pause and never re-arm follow.
    if (matchesKey(data, 'ctrl+home')) {
      scroll.scrollToStart()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'ctrl+end')) {
      scroll.scrollToEnd()
      this.intents.requestRender()
      return
    }
    if (search.mode === 'navigate') {
      // NAVIGATE: only the result navigation keys act; ordinary printing is
      // inert — the Job is read-only and never leaks into the editor, and the
      // `v`/`C`/Stop verbs are NOT reachable here.
      if (matchesKey(data, 'n')) {
        search.step(1)
        this.intents.requestRender()
      } else if (matchesKey(data, 'shift+n')) {
        search.step(-1)
        this.intents.requestRender()
      }
      return
    }
    if (command) {
      // Command is a pure reading page: the ONLY ordinary verb is the original
      // Copy All, and Stop is never reachable from here.
      if (matchesKey(data, 'shift+c')) this.copyCommandAll()
      return
    }
    // Stop keeps its existing precedence on the Output page (the fixed
    // `tasks.stop` branch runs BEFORE the B1-C read-only verbs).
    if (componentKeymap.matches(data, 'tasks.stop') && this.intents.canStop()) {
      this.intents.onStop()
      return
    }
    if (matchesKey(data, 'v')) {
      this.openCommand()
      return
    }
    if (matchesKey(data, 'shift+c')) this.copyOutput()
  }

  /** The painted header hit region at one screen cell, or undefined. */
  private headerTargetAt(x: number, y: number): JobHeaderHitTarget | undefined {
    const row = y - this.headerTop
    return this.paintedTargets.find(target => target.row === row && x >= target.startCol && x < target.endCol)
  }

  /** The PRESS half of a same-cell click: remember the target the user pressed,
   *  without acting. */
  onHeaderPress(x: number, y: number): void {
    if (this.disposed) return
    this.pressedTarget = this.headerTargetAt(x, y)
  }

  /** The RELEASE half: the click acts only when the SAME cell still resolves to
   *  the SAME painted target — same action, same page and same exact Command
   *  source — so a repaint between press and release (another Job, a narrowed
   *  button, a different header row) can never fire a ghost action. */
  onHeaderClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressedTarget
    this.pressedTarget = undefined
    const target = this.headerTargetAt(x, y)
    if (pressed === undefined || target === undefined) return
    if (target.action !== pressed.action || target.view !== pressed.view || target.documentKey !== pressed.documentKey) return
    if (target.action === 'open-command') this.openCommand()
    else this.copyCommandAll()
  }

  /** The terminal lost focus (FOCUS_OUT): an in-flight Command drag can never
   *  receive its release, so its selection and its temporary edge timer are
   *  released now (plan §4.2 rules for blur/teardown). */
  onTerminalBlur(): void {
    if (this.disposed) return
    if (this.commandReader.cancelSelection()) this.intents.requestRender()
  }

  /** Make updates and intents inert. The owned children (the body texts, the
   *  ScrollViews, the SearchRows) are released by the inherited container chain;
   *  the Command reader's own gesture timer is released explicitly. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.commandReader.dispose()
    super.dispose()
  }

  /** Open (or re-open) the CURRENT page's Job Find — the shared entry of the
   *  direct effective Find binding, the `/` alias and the Host leader
   *  completion. Below four rows the frame grants no SearchRow, so the request
   *  changes no state. */
  openFind(): void {
    if (this.disposed) return
    // Below four rows the frame grants no SearchRow, so Find cannot be entered as
    // a hidden editor: the request is consumed without changing any state.
    if (planChrome(this.chrome.width, this.intents.rows(), this.intents.notice() !== undefined, true).searchRows === 0) {
      return
    }
    if (this.readState.view === 'command') {
      this.commandReader.openFind()
      this.intents.focusComponent(this.commandReader.search.row)
      this.intents.requestRender()
      return
    }
    this.search.openFind(this.scrollView.scrollTop)
    // Opening Find is browsing: follow never survives it.
    this.scrollView.pauseFollow()
    this.intents.focusComponent(this.search.row)
    this.intents.requestRender()
  }

  /** Show the Command page of the SAME workspace/observer, leaving the Output
   *  page's scroll, follow intent, query and viewport untouched. */
  private openCommand(): void {
    if (this.disposed || this.readState.view === 'command') return
    if (!commandEligible(this.chrome.view)) return
    // The Output Find gives up its input OWNERSHIP only (the query is kept for
    // the next open); the Output viewport/follow intent is never touched.
    this.search.exit()
    this.readState.view = 'command'
    this.header.setState(this.chrome.view, 'command', true)
    // The Command page's exact copy must not race the fork's word selection.
    this.intents.setNativeCopyOnSelect(false)
    this.pressedTarget = undefined
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }

  /** Return to the Output page: the Command Find drops its input ownership (its
   *  query survives), the selection and gesture are cancelled, and the Output
   *  viewport/follow/query are exactly as the user left them. */
  private showOutput(): void {
    if (this.readState.view !== 'command') return
    this.commandReader.exitSearch()
    this.commandReader.cancelSelection()
    this.readState.view = 'output'
    this.header.setState(this.chrome.view, 'output', commandEligible(this.chrome.view))
    this.intents.setNativeCopyOnSelect(true)
    this.pressedTarget = undefined
    this.intents.focusComponent(this)
  }

  /** `C` on the Command page: the ORIGINAL observed label, captured now. An
   *  ineligible Command (a lost-eligibility race: the page switches back on the
   *  next frame) reports its own reason instead of failing silently. */
  private copyCommandAll(): void {
    if (this.disposed) return
    if (!commandEligible(this.chrome.view)) {
      this.intents.onCopy({ source: 'command-all', text: '', unavailable: 'command-unavailable' })
      return
    }
    this.intents.onCopy({ source: 'command-all', text: this.commandReader.source })
  }

  /** `C` on the Output page: the retained snapshot text, captured now, with no
   *  trim/strip/replace shaping of any kind. A phase with no observed snapshot
   *  and an observed-but-empty body report DIFFERENT reasons (plan §3), so the
   *  user learns which state they are looking at instead of a generic silence. */
  private copyOutput(): void {
    const view = this.chrome.view
    if (view.phase !== 'observed') {
      this.intents.onCopy({ source: 'output', text: '', unavailable: 'output-unavailable' })
      return
    }
    if (view.retainedText === '') {
      this.intents.onCopy({ source: 'output', text: '', unavailable: 'output-empty' })
      return
    }
    this.intents.onCopy({ source: 'output', text: view.retainedText })
  }

  private exitSearch(): void {
    if (this.readState.view === 'command') this.commandReader.exitSearch()
    else this.search.exit()
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }
}
