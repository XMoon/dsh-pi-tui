/**
 * The selected-Job workspace presenter (Phase 3B / B1-A + B1-B + B1-C + B1-D):
 * the typed Header (status title, optional metadata, the Command/Label summary,
 * the reading tabs), the retained Output body with the Job's OWN strict follow
 * owner and Find model, the mutually exclusive Command reading page, the ONE
 * optional SearchRow, the optional reading-facts row, a transient notice row and
 * the pinned bottom Action Bar of the Job fullscreen workspace. The notice row
 * renders the app's OWN live notice (the ONE notice authority) while the
 * workspace owns the terminal, so a Stop settlement stays visible where the user
 * is looking — never a second Stop state.
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
import { JOB_LOCAL_KEYS, formatHintKeys, formatKeyId } from '../keybindings/hints.ts'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayLog } from '../presentation/terminal-text.ts'
import { color, taskStatusColor } from '../theme/runtime.ts'
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
  readonly action: 'open-command' | 'open-output' | 'copy-command-all'
  readonly documentKey: string
  readonly view: JobReadView
}

/** Job kinds whose `label` is the shell command the Job was started with. */
const COMMAND_KINDS = new Set(['bash', 'pwsh'])

/** Below this width or row count the chrome collapses to its compact tab labels
 *  (plan §3.1: the SAME 80×10 boundary B1-B already owns). */
const COMPACT_WIDTH = 80
const COMPACT_ROWS = 10

/** The Action Bar's own row — the ONE chrome row that is NEVER budgeted away. */
const ACTION_BAR_ROWS = 1
/** The reading-facts row needs this much terminal before it may claim a row, and
 *  must leave this many body rows behind (plan §3.2 step 9). */
const FACTS_MIN_WIDTH = 100
const FACTS_MIN_ROWS = 12
const FACTS_MIN_BODY_ROWS = 6
/** The metadata row needs a standard frame and must leave this many body rows
 *  behind (plan §3.2 step 8). */
const METADATA_MIN_BODY_ROWS = 4
/** The Job page step mirrors the alt screen's own page semantics (X page scroll). */
const PAGE_SCROLL_OVERLAP = 4

/** The fixed reading-tab names (compact uses the two-cell short forms). */
const TAB_OUTPUT = 'Output'
const TAB_COMMAND = 'Command'
const TAB_OUTPUT_SHORT = 'Out'
const TAB_COMMAND_SHORT = 'Cmd'

/** The Command page's EXACT-copy affordance. The bracketed `C` is the fixed
 *  Job-local copy key, so advertising it is truthful. */
const COMMAND_COPY_ALL = 'Copy All [C]'

/** The Output page's Command entry affordance (only painted while a real shell
 *  Command is observed). */
const COMMAND_ENTRY = '↗ Command'

/** The Action Bar's pure browsing hint: the reserved physical page keys every
 *  long body can be scrolled with (plan §2.1). */
const PAGE_HINT = 'PgUp/PgDn'

/**
 * The ONE per-frame chrome plan of the workspace. Every fixed child derives its
 * row count from THIS plan — a single frame decision, never a per-child
 * `terminal.rows` budget — so no combination of a short terminal, a live search,
 * a live notice and optional metadata can ever push the Action Bar off the
 * screen or squeeze the last body row away.
 *
 * Grant order (plan B1-D §3.2): the pinned Action Bar and, from two rows, the
 * status title come first; from three rows one body row is reserved; the
 * SearchRow, the summary (Command/Label or Full command) and the reading tabs
 * follow in that order; then the transient notice, then the standard-size
 * metadata row and finally the reading-facts row. An optional row is granted
 * only while the frame still keeps its reserved body row, and the metadata /
 * reading-facts rows additionally require enough body rows left to remain worth
 * reading.
 */
interface JobInspectorChromePlan {
  readonly compact: boolean
  readonly statusRows: number
  readonly metadataRows: number
  readonly summaryRows: number
  readonly tabRows: number
  readonly searchRows: number
  /** Whether this frame COULD host a SearchRow at all, independent of whether a
   *  search is currently open (plan §3.2 step 4). */
  readonly searchCapable: boolean
  readonly noticeRows: number
  readonly readingFactsRows: number
  readonly actionRows: number
  readonly bodyRows: number
}

/** The live inputs the ONE plan is derived from: the terminal width, the live
 *  physical row grant, whether a notice is live, whether the ACTIVE page asks
 *  for its SearchRow, and whether the view carries real metadata worth a row. */
interface JobInspectorChromeInputs {
  readonly width: number
  readonly rows: number
  readonly noticeLive: boolean
  readonly searchRequested: boolean
  readonly metadataAvailable: boolean
}

const planChrome = (inputs: JobInspectorChromeInputs): JobInspectorChromePlan => {
  const safeRows = Math.max(1, Math.floor(inputs.rows))
  const compact = inputs.width < COMPACT_WIDTH || safeRows < COMPACT_ROWS
  let remaining = safeRows
  const actionRows = ACTION_BAR_ROWS
  remaining -= actionRows
  const statusRows = safeRows >= 2 ? 1 : 0
  remaining -= statusRows
  // From three rows the frame owes the CURRENT reading page at least one readable
  // row, and no optional row may take it (plan §3.2 step 3).
  const minBodyRows = safeRows >= 3 ? 1 : 0
  /** Whether the frame can host a SearchRow AT ALL (plan §3.2 step 4): the Find
   *  entry point and the Action Bar's Find hint must agree with THIS, so a frame
   *  that cannot show the row never advertises (nor opens) the search. */
  const searchCapable = safeRows >= 4 && remaining - 1 >= minBodyRows
  /** Grant ONE row when the frame is at least `minRows` tall, the condition
   *  holds and the reserved body row survives the grant. */
  const grant = (minRows: number, condition: boolean, minBody = minBodyRows): number => {
    if (!condition || safeRows < minRows || remaining - 1 < minBody) return 0
    remaining -= 1
    return 1
  }
  const searchRows = inputs.searchRequested && searchCapable ? grant(4, true) : 0
  const summaryRows = grant(5, true)
  const tabRows = grant(5, true)
  const noticeRows = grant(6, inputs.noticeLive)
  const metadataRows = grant(
    COMPACT_ROWS,
    !compact && inputs.metadataAvailable,
    Math.max(minBodyRows, METADATA_MIN_BODY_ROWS),
  )
  const readingFactsRows = grant(
    FACTS_MIN_ROWS,
    inputs.width >= FACTS_MIN_WIDTH,
    Math.max(minBodyRows, FACTS_MIN_BODY_ROWS),
  )
  return {
    compact,
    statusRows,
    metadataRows,
    summaryRows,
    tabRows,
    searchRows,
    searchCapable,
    noticeRows,
    readingFactsRows,
    actionRows,
    bodyRows: remaining,
  }
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
   *  shown — otherwise a rapid second click on `Copy All [C]` would be classified
   *  as a word selection and overwrite the just-copied command. The Output page
   *  keeps whatever the screen started with. */
  readonly setNativeCopyOnSelect: (enabled: boolean) => void
}

/** A raw `label`/`detail`/`error` is shown on ONE row: hard line breaks become
 *  spaces for DISPLAY only, and COMPLETE terminal escape sequences plus any
 *  remaining C0/C1 control byte are removed at this ONE workspace-chrome display
 *  boundary — the SAME projection guards the header rows AND the transient notice
 *  row, because both paint Host-supplied Job text (`label`, `detail`, `progress`,
 *  a stop settlement's label). The official raw bytes stay untouched in the
 *  `View`, the Command document and every copy payload. Styling is applied AFTER
 *  this projection, so the theme's own colors are never stripped with it. */
const chromeText = (text: string): string => sanitizedPhysicalLine(text)

/** The bracketed fact markers of one view, in priority order: independent and
 *  co-visible, never a mutually exclusive status switch. */
const markerTokens = (view: JobInspectorView): string[] => [
  ...(view.gapBefore ? ['[GAP]'] : []),
  ...(view.observationError === undefined ? [] : ['[ERROR]']),
  ...(view.settled ? ['[SETTLED]'] : []),
]

/** The theme colour of one fact marker (never colour alone: the bracketed
 *  token keeps the fact readable without it). */
const paintMarker = (marker: string): string =>
  marker === '[GAP]' ? color.warning(marker)
    : marker === '[ERROR]' ? color.error(marker)
      : color.textMuted(marker)

/** Whether the view carries real metadata worth the ONE metadata row (plan §3.2
 *  step 8): a progress, a detail, a follow-stream error or the retained-window
 *  eviction fact. Never inferred from a missing value, so an empty frame never
 *  grows a ghost blank row. */
const metadataAvailable = (view: JobInspectorView): boolean =>
  view.progress !== undefined || view.detail !== undefined || view.observationError !== undefined || view.gapBefore

/** The display word of one wire status (design language §4.1): Title Case, with
 *  the raw wire value as the fallback, so a future status renders as itself
 *  instead of a blank or a throw. */
const STATUS_WORDS: Record<string, string> = {
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Killed',
  timed_out: 'Timed out',
  lost: 'Lost',
}

/** The ONE status marker of the family (design language §4.1, D5+D7): `‣` is
 *  EAW neutral and one cell wide, and the same marker is used for EVERY status —
 *  no per-status glyph set. The WORD carries the state; the marker anchors it. */
const STATUS_MARKER = '‣'

/** The reading-facts text of the CURRENT page, split so the row can place the
 *  disclosure on the left and the real viewport position on the right. */
const readingFactsParts = (
  note: string,
  position: { readonly start: number; readonly end: number; readonly total: number },
): { readonly note: string; readonly position?: string } =>
  position.total > 0 ? { note, position: `rows ${position.start}-${position.end}/${position.total}` } : { note }

/** `${lead}${gap}${affordance}` with the affordance right-aligned on the row.
 *  Returns the painted line, the cell where the lead's own painted text ends and
 *  the affordance's exact cell span. `leadEnd` is a HIT range, so when the row had
 *  to truncate the lead the synthetic trailing `…` is excluded: it is the
 *  truncation marker, never a label cell (the same rule as the reading tabs).
 *
 *  The affordance YIELDS to its content (design language §8, last step): it is
 *  painted only while the WHOLE lead fits beside it, because a truncated
 *  affordance would cost the reader the very content it points at. When it
 *  yields, NO span is published — a dropped affordance must not leave a dead
 *  click region behind. */
const withTrailingAffordance = (
  lead: string,
  affordance: string,
  width: number,
): { readonly line: string; readonly leadEnd: number; readonly span?: { readonly start: number; readonly end: number } } => {
  const affordanceWidth = visibleWidth(affordance)
  const leadWidth = visibleWidth(lead)
  if (affordanceWidth >= width || leadWidth + 1 + affordanceWidth > width) {
    const truncated = leadWidth > width
    return {
      line: truncateToWidth(lead, width, '…', false),
      leadEnd: truncated ? Math.max(0, width - 1) : leadWidth,
    }
  }
  const room = width - affordanceWidth - 1
  const paintedLead = truncateToWidth(lead, room, '…', false)
  const paintedLeadWidth = visibleWidth(paintedLead)
  const leadEnd = leadWidth > room ? Math.max(0, paintedLeadWidth - 1) : paintedLeadWidth
  const gap = width - paintedLeadWidth - affordanceWidth
  const start = paintedLeadWidth + gap
  return {
    line: `${paintedLead}${' '.repeat(gap)}${affordance}`,
    leadEnd,
    span: { start, end: start + affordanceWidth },
  }
}

/** The ONE reading-tab row: the current page bracketed and emphasised, the other
 *  page plain (only while a real shell Command is available), the rest of the
 *  row a single themed rule. Reports the two labels' cell spans so the hit map
 *  names exactly the painted characters. */
const buildTabsRow = (
  mode: JobReadView,
  commandAvailable: boolean,
  compact: boolean,
  width: number,
): {
  readonly line: string
  readonly output: { readonly start: number; readonly end: number }
  readonly command?: { readonly start: number; readonly end: number }
} => {
  const outputLabel = compact ? TAB_OUTPUT_SHORT : TAB_OUTPUT
  const commandLabel = compact ? TAB_COMMAND_SHORT : TAB_COMMAND
  const outputText = mode === 'output' ? `[${outputLabel}]` : outputLabel
  const commandText = mode === 'command' ? `[${commandLabel}]` : commandLabel
  const paint = (text: string, selected: boolean): string =>
    selected ? color.textStrong(text, 'primary') : color.textDim(text)
  const output = { start: 0, end: visibleWidth(outputText) }
  const head = commandAvailable
    ? `${paint(outputText, mode === 'output')}  ${paint(commandText, mode === 'command')}`
    : paint(outputText, true)
  const command = commandAvailable ? { start: output.end + 2, end: output.end + 2 + visibleWidth(commandText) } : undefined
  const rule = width - visibleWidth(head) - 1
  return {
    line: rule > 0 ? `${head} ${color.border('─'.repeat(rule))}` : head,
    output,
    ...(command === undefined ? {} : { command }),
  }
}


/** The bounded typed header: the status title with its independent
 *  gap/error/settled markers, the optional real metadata, the Command-or-Label
 *  summary (or the Command page's title and exact-copy button) and the reading
 *  tabs. It also reports the hit regions its LAST render produced, so a later
 *  click resolves against the frame the user actually saw rather than a
 *  re-measured live layout. */
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

  /**
   * Paint the header rows the CURRENT frame granted, in the locked order:
   * status title, optional metadata, the page's summary, the reading tabs. The
   * returned array holds AT MOST `statusRows + metadataRows + summaryRows +
   * tabRows` rows (zero included), and the hit map is derived from the SAME
   * painted strings, so a hidden or truncated affordance can never keep a
   * clickable region.
   */
  render(width: number): string[] {
    const plan = this.plan(width)
    const raw: string[] = []
    const pending: JobHeaderHitTarget[] = []
    if (plan.statusRows > 0) raw.push(this.statusLine(width))
    if (plan.metadataRows > 0) raw.push(this.metadataLine(width))
    if (plan.summaryRows > 0) {
      const row = raw.length
      const summary = this.summaryLine(width)
      raw.push(summary.line)
      if (this.mode === 'command') {
        // The Command page's ONLY clickable chrome is the exact-copy button; the
        // `Full command` title itself is a label, not an action.
        if (summary.span !== undefined) {
          pending.push({
            row,
            startCol: summary.span.start,
            endCol: summary.span.end,
            action: 'copy-command-all',
            documentKey: this.documentKey(),
            view: 'command',
          })
        }
      } else if (this.commandAvailable) {
        // The summary text and the `↗ Command` entry are the SAME intent; the
        // padding between them stays inert (plan §4.1.1).
        if (summary.leadEnd > 0) {
          pending.push({
            row,
            startCol: 0,
            endCol: summary.leadEnd,
            action: 'open-command',
            documentKey: this.documentKey(),
            view: 'output',
          })
        }
        if (summary.span !== undefined) {
          pending.push({
            row,
            startCol: summary.span.start,
            endCol: summary.span.end,
            action: 'open-command',
            documentKey: this.documentKey(),
            view: 'output',
          })
        }
      }
    }
    if (plan.tabRows > 0) {
      const row = raw.length
      const tabs = buildTabsRow(this.mode, this.commandAvailable, plan.compact, width)
      raw.push(tabs.line)
      // Only the OTHER page's tab is live: the current page's bracketed label is
      // a status marker, not an action (plan §4.1.3/§4.1.4). The region is exactly
      // the painted LABEL cells: when the row is truncated, `truncateToWidth`
      // substitutes its last cell with an ellipsis that is NOT the label, so the
      // range stops before it — a tab the frame cut off keeps no live region.
      const other = this.mode === 'output' ? tabs.command : tabs.output
      const painted = visibleWidth(tabs.line) > width ? width - 1 : width
      if (other !== undefined && other.start < painted) {
        pending.push({
          row,
          startCol: other.start,
          endCol: Math.min(other.end, painted),
          action: this.mode === 'output' ? 'open-command' : 'open-output',
          documentKey: this.documentKey(),
          view: this.mode,
        })
      }
    }
    const painted = raw.map(line => truncateToWidth(line, width, '…', true))
    this.hitTargets = pending.filter(target => target.row < painted.length)
    return painted
  }

  /** The ONE status title row: the `Job` identity, then the status word with the
   *  ONE shared marker and the independent fact markers. The status group and its
   *  markers are laid out FIRST, so a long Job identity can only ever truncate
   *  itself (plan §2.1 / §3.1). */
  private statusLine(width: number): string {
    const view = this.view
    const paintStatus = taskStatusColor(view.status)
    let right = paintStatus(`${STATUS_MARKER} ${STATUS_WORDS[view.status] ?? chromeText(view.status)}`)
    for (const marker of markerTokens(view)) {
      if (visibleWidth(right) + visibleWidth(marker) + 1 <= width) right += ` ${paintMarker(marker)}`
    }
    // Identity (role 1) + trail (role 2): `Job · job-a · bash`.
    const identity = `${color.textStrong('Job')}${color.textDim(` · ${chromeText(view.jobId)} · ${chromeText(view.kind)}`)}`
    const room = width - visibleWidth(right) - 1
    if (room < 1) return truncateToWidth(right, width, '…', false)
    const lead = truncateToWidth(identity, room, '…', false)
    const gap = width - visibleWidth(lead) - visibleWidth(right)
    return `${lead}${' '.repeat(gap)}${right}`
  }

  /** The ONE metadata row: real progress/detail plus the descriptive fact text on
   *  one row. Progress and detail keep their own priority (progress first, detail
   *  the first thing to be hidden — plan §6.1), while the gap/error reasons claim
   *  at most HALF the row first, so an unbounded progress can never make the
   *  independent marker facts unreachable (plan §2.1). Every Host-supplied field
   *  crosses the chrome safety boundary BEFORE the theme styling. */
  private metadataLine(width: number): string {
    const view = this.view
    const meta: string[] = []
    if (view.progress !== undefined) meta.push(color.textDim(`Progress: ${chromeText(view.progress)}`))
    if (view.detail !== undefined) meta.push(color.textDim(`Detail: ${chromeText(view.detail)}`))
    const facts: string[] = []
    if (view.gapBefore) facts.push(color.textDim('Earlier output evicted'))
    if (view.observationError !== undefined) facts.push(color.error(`Error: ${chromeText(view.observationError)}`))
    const separator = color.textDim(' · ')
    /** ONE rule for BOTH groups, inside that group's own reserved budget: keep the
     *  complete higher-priority facts while they fit, drop a fact WHOLE when it does
     *  not, and allow only a LONE remaining fact to truncate (design language §4.2/§8
     *  — a half-stated fact is worse than an absent one, and a mid-word cut is never a
     *  disclosure). */
    const keepWhole = (group: readonly string[], room: number): string => {
      const kept: string[] = []
      for (const fact of group) {
        if (kept.length > 0 && visibleWidth([...kept, fact].join(separator)) > room) break
        kept.push(fact)
      }
      const text = kept.join(separator)
      // Nothing but the first fact fits: it is the group's higher-priority truth, so
      // it truncates rather than disappearing (`Progress:`/`Error:` may be long).
      return kept.length === 1 && visibleWidth(text) > room ? truncateToWidth(text, room, '…', false) : text
    }
    // The fact group keeps its reserved HALF (plan §2.1: an unbounded progress can
    // never make an independent marker fact unreachable).
    const budget = Math.max(0, Math.floor(width / 2))
    const factText = keepWhole(facts, budget)
    if (meta.length === 0) return factText === '' ? '' : truncateToWidth(factText, width, '…', false)
    const factRows = factText === '' ? 0 : Math.min(visibleWidth(factText), budget)
    const metaRoom = factRows === 0 ? width : Math.max(0, width - factRows - 3)
    const metaText = keepWhole(meta, metaRoom)
    if (factRows === 0) return metaText
    return `${metaText}${separator}${factText}`
  }

  /** The summary row of the CURRENT page: the Output page's Command/Label
   *  summary (with its `↗ Command` entry only while a real shell Command is
   *  observed), or the Command page's `Full command` title with the exact-copy
   *  button. */
  private summaryLine(width: number): {
    readonly line: string
    readonly leadEnd: number
    readonly span?: { readonly start: number; readonly end: number }
  } {
    if (this.mode === 'command') {
      return withTrailingAffordance(color.textMuted(COMMAND_FULL_NOTE), color.primary(COMMAND_COPY_ALL), width)
    }
    const summary = `${COMMAND_KINDS.has(this.view.kind) ? 'Command' : 'Label'}  ${chromeText(this.view.label)}`
    const painted = color.textMuted(summary)
    if (!this.commandAvailable) {
      return { line: truncateToWidth(painted, width, '…', false), leadEnd: Math.min(width, visibleWidth(summary)) }
    }
    return withTrailingAffordance(painted, color.primary(COMMAND_ENTRY), width)
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

/** The ONE reading-facts row of a standard frame: the current page's own
 *  disclosure on the LEFT and the real measured viewport position on the RIGHT.
 *  It renders ZERO rows whenever the frame grant is zero, so compact terminals
 *  keep the bounded disclosure on the Action Bar instead — the same fact is never
 *  advertised twice (plan §3.3), and it is never advertised as a complete
 *  history. A status line is never flanked by rules (design language §6.2, D6). */
class JobWorkspaceReadingFactsRow implements Component {
  private readonly parts: (width: number) => { readonly note: string; readonly position?: string } | undefined
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(parts: (width: number) => { readonly note: string; readonly position?: string } | undefined, plan: (width: number) => JobInspectorChromePlan) {
    this.parts = parts
    this.plan = plan
  }

  render(width: number): string[] {
    if (this.plan(width).readingFactsRows === 0) return []
    const parts = this.parts(width)
    if (parts === undefined) return []
    const positionText = parts.position
    const note = parts.note === '' ? undefined : color.textDim(parts.note)
    const position = positionText === undefined ? undefined : color.textMuted(positionText)
    // A GRANTED row is never left empty (the frame reserved it): a lone position
    // is right-aligned, a lone note is left-aligned and truncatable.
    if (note === undefined && position === undefined) return []
    if (note === undefined) {
      return [`${' '.repeat(Math.max(0, width - visibleWidth(positionText!)))}${position}`]
    }
    if (positionText === undefined) return [truncateToWidth(note, width, '…', true)]
    // The right-aligned position yields to the disclosure when both cannot fit,
    // and never cuts a word: the pair degrades to one joined, truncatable line.
    if (visibleWidth(parts.note) + 1 + visibleWidth(positionText) > width) {
      return [truncateToWidth(color.textDim(`${parts.note} · ${positionText}`), width, '…', true)]
    }
    const gap = width - visibleWidth(parts.note) - visibleWidth(positionText)
    return [`${note}${' '.repeat(gap)}${position}`]
  }

  invalidate(): void {
    // Nothing cached: the fact text is read live on every frame.
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
  /** Whether the frame granted the DEDICATED reading-facts row: the bar then
   *  drops the disclosure and position (never advertised twice — plan §3.3). */
  readonly readingFacts: boolean
  /** Whether this frame can open a Find at all (the SearchRow grant). */
  readonly canFind: boolean
  /** Whether the frame actually shows a body row: a browsing hint or a
   *  viewport position is never advertised for a body that is not painted. */
  readonly bodyVisible: boolean
  /** Whether `Tab` can switch the page away from the current one (on the Output
   *  page: whether the shell Command page exists at all). */
  readonly canSwitchPage: boolean
  /** Whether `C` can copy a non-empty retained Output this frame. */
  readonly canCopyOutput: boolean
}

/** The visible facts of the Command page's Action Bar. */
interface JobCommandStatusFacts {
  readonly findHint: string
  readonly searchActive: boolean
  readonly searchEditing: boolean
  readonly position: { readonly start: number; readonly end: number; readonly total: number }
  /** See {@link JobOutputStatusFacts.readingFacts}. */
  readonly readingFacts: boolean
  /** See {@link JobOutputStatusFacts.canFind}. */
  readonly canFind: boolean
  /** See {@link JobOutputStatusFacts.bodyVisible}. */
  readonly bodyVisible: boolean
}

/**
 * The pinned bottom Action Bar: `Esc` LAST, the effective `tasks.stop` primary key
 * (only while Stop is live), the strict follow truth, `[GAP]`, the retained/full
 * disclosure, the CURRENT viewport position and the effective Find key, plus the
 * Job-local read-only `Tab` page toggle / `c` copy verbs and a pure `PgUp/PgDn`
 * browsing hint. Whole segments yield in priority order — never an over-wide
 * row, and the disclosure survives whenever the row can carry it. Every segment
 * is gated on the LIVE frame: the Command page advertises no Stop and no Follow,
 * `C copy all` only while no Find owns the ordinary keys, the Find hint only
 * while the frame can host a SearchRow and the query is not being edited, and the
 * page hint only for a body row the keys really move. The whole row is painted
 * with the theme's dim token (plan §2.3).
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
    // Every segment names a key the workspace really accepts in THIS frame: a
    // Find whose SearchRow the frame cannot grant, or a page hint for a body
    // that is not painted (or belongs to the query input), stays unadvertised
    // (plan §1.2 MUST 5 / §2.1 / §4.2).
    const pageHint = facts.bodyVisible && !facts.searchEditing
    const findSegment: ActionBarSegment[] = !facts.searchEditing && facts.canFind
      // ONE key per action (design language §7.1): the live keymap's primary
      // binding, verb last. `/` is the Job-local alias and is advertised only when
      // the action has no live binding left to name.
      ? [{ text: facts.findHint === '' ? '/ find' : `${facts.findHint} find`, priority: 1 }]
      : []
    const position: ActionBarSegment[] = facts.bodyVisible && facts.position.total > 0
      ? [{ text: `rows ${facts.position.start}-${facts.position.end}/${facts.position.total}`, priority: 2 }]
      : []
    if ('command' in facts) {
      const segments: ActionBarSegment[] = []
      if (!facts.searchActive) {
        segments.push({ text: `${formatHintKeys(formatKeyId(JOB_LOCAL_KEYS.copy))} copy all`, priority: 6 })
        // The page toggle is advertised on BOTH pages: it is one symmetric key,
        // and switching back is the same action as switching forward.
        segments.push({ text: `${formatHintKeys(formatKeyId(JOB_LOCAL_KEYS.switchPage))} switch`, priority: 0.6 })
      }
      if (!facts.readingFacts) {
        segments.push({ text: COMMAND_FULL_NOTE, priority: 5 })
        segments.push(...position)
      }
      segments.push(...findSegment)
      if (pageHint) segments.push({ text: PAGE_HINT, priority: 0.1 })
      // `Esc` is the LAST segment (design language §7.2, D8) while keeping the
      // highest drop priority, so it is never the thing a tight row loses.
      segments.push({ text: 'Esc output', priority: 7 })
      return [color.textMuted(renderActionBarRow(segments, width))]
    }
    // Drop order: Stop, Follow, GAP, the disclosure and position, Find, then the
    // two B1-C verbs and finally the pure browsing hint (they are the ONLY
    // segments a tight row may drop before the pre-existing truth). `Esc` carries
    // the highest priority and is painted LAST.
    const segments: ActionBarSegment[] = []
    // ONE key per action (§7.1): the keymap's PRIMARY default. `componentKeymap
    // .keyHint` lists every default because the transcript search overlay's compact
    // hint must name each physical key (`esc/ctrl+c` close), so the BAR takes the
    // primary itself.
    const stopKey = componentKeymap.keysFor('tasks.stop')[0]
    if (!facts.searchActive && this.canStop() && stopKey !== undefined) {
      segments.push({ text: `${formatHintKeys(formatKeyId(stopKey))} stop`, priority: 6 })
    }
    segments.push(facts.follow
      ? { text: 'Follow on', priority: 5 }
      : facts.searchEditing
        ? { text: 'Follow paused', priority: 5 }
        : { text: 'Follow paused · End resume', short: 'Follow paused', priority: 5 })
    if (facts.gap) segments.push({ text: '[GAP]', priority: 4 })
    // The dedicated facts row already discloses the bounded preview and the real
    // viewport position: the bar must never advertise them twice (plan §3.3).
    if (!facts.readingFacts) {
      segments.push({ text: RETAINED_NOTE, priority: 3 })
      segments.push(...position)
    }
    segments.push(...findSegment)
    // Neither the page toggle nor the copy verb is advertised while a Job Find
    // owns the ordinary keys (both are inert in EDIT and NAVIGATE), nor when the
    // action itself cannot execute this frame. Both yield BEFORE every
    // pre-existing segment (B1-B's Follow/GAP/disclosure/position/Find truth is
    // unchanged), and their two DIFFERENT priorities make the drop order
    // deliberate rather than array-order-dependent: the page toggle outranks the
    // Output copy verb, so a row wide enough for one verb advertises the page.
    if (!facts.searchActive) {
      if (facts.canCopyOutput) segments.push({ text: `${formatHintKeys(formatKeyId(JOB_LOCAL_KEYS.copy))} copy output`, priority: 0.5 })
      if (facts.canSwitchPage) segments.push({ text: `${formatHintKeys(formatKeyId(JOB_LOCAL_KEYS.switchPage))} switch`, priority: 0.6 })
    }
    if (pageHint) segments.push({ text: PAGE_HINT, priority: 0.1 })
    segments.push({ text: 'Esc back', priority: 7 })
    // Role 13: hints are the WEAKEST readable ink so the bar never competes with
    // the output it describes.
    return [color.textMuted(renderActionBarRow(segments, width))]
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
    // The notice text is Host-supplied (a Stop settlement embeds the Job label),
    // so it crosses the SAME display boundary as the header BEFORE the theme's
    // own styling is applied.
    const text = chromeText(live.text)
    // Role 17: an info notice is the weakest readable ink (`textMuted`), an error
    // notice is `error`; the `ℹ`/`✗` prefixes are the glyph inventory's notice
    // prefixes (design language §4.4/§4.5).
    const line = live.kind === 'info' ? color.textMuted(`ℹ ${text}`) : color.error(`✗ ${text}`)
    return [truncateToWidth(line, width, '…', true)]
  }

  invalidate(): void {
    // Nothing cached: the notice is read live on every frame.
  }
}

/** The rendered body text of one view (the ScrollView's only child). The raw
 *  retained observation stays the source authority (retention, search source
 *  key and exact copy); only this terminal-bound projection is disposable. */
const bodyText = (view: JobInspectorView): string => {
  if (view.phase === 'unavailable') return BODY_UNAVAILABLE
  if (view.phase === 'connecting') return BODY_CONNECTING
  return view.retainedText === '' ? BODY_EMPTY : sanitizeDisplayLog(view.retainedText)
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
      plan: planChrome({
        width: 0,
        rows: intents.rows(),
        noticeLive: intents.notice() !== undefined,
        searchRequested: false,
        metadataAvailable: metadataAvailable(view),
      }),
      width: 0,
      view,
      positionViewportHeight: -1,
    }
    const plan = (width: number): JobInspectorChromePlan => {
      const activeSearchMode = readState.view === 'command'
        ? holders.commandReader?.search.mode ?? 'inactive'
        : search.mode
      const next = planChrome({
        width,
        rows: intents.rows(),
        noticeLive: intents.notice() !== undefined,
        searchRequested: activeSearchMode !== 'inactive',
        metadataAvailable: metadataAvailable(chrome.view),
      })
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
    /** The reading facts of the CURRENT page: the page's disclosure plus the real
     *  measured viewport position, or undefined when the page shows none. */
    const readingFacts = (width: number): { readonly note: string; readonly position?: string } | undefined => {
      if (readState.view === 'command') {
        const position = positionFacts(commandReader.search, commandReader.scroll, width)
        // The Command page's summary row already states `Full command`, so the
        // status line does not state it a second time (design language §7.3) — it
        // carries only the real position, and falls back to the note when there
        // is no position so the granted row is never empty.
        return readingFactsParts(position.total > 0 ? '' : COMMAND_FULL_NOTE, position)
      }
      return readingFactsParts(RETAINED_NOTE, positionFacts(search, scrollView, width))
    }
    const bar = new JobInspectorActionBar(intents.canStop, (width) => {
      const frame = plan(width)
      const factsRowShown = frame.readingFactsRows === 1
      const grants = { canFind: frame.searchCapable, bodyVisible: frame.bodyRows >= 1 }
      if (readState.view === 'command') {
        chrome.positionViewportHeight = commandReader.scroll.viewportHeight
        return {
          command: true,
          findHint: intents.findHint(),
          searchActive: commandReader.search.mode !== 'inactive',
          searchEditing: commandReader.search.mode === 'edit',
          position: positionFacts(commandReader.search, commandReader.scroll, width),
          readingFacts: factsRowShown,
          ...grants,
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
        readingFacts: factsRowShown,
        ...grants,
        canSwitchPage: commandEligible(chrome.view),
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
      // The reading-facts row and the transient notice row sit ABOVE the pinned
      // Action Bar and render zero rows when their grant is zero.
      { component: new JobWorkspaceReadingFactsRow(readingFacts, plan), shrink: 0 },
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
   * the Job-local `Tab`/`c` verbs are B1-B/B1-C's. Every other key is inert: the
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
    // `Tab` is a RESERVED Job key too (the workspace's own page toggle, the same
    // way Home/End are reserved). It is consumed HERE — unconditionally, BEFORE the
    // Find binding is resolved — so a Find remapped onto `Tab` can never reach
    // `openFind()` in ANY search state: EDIT returned above, and NAVIGATE would
    // otherwise re-enter EDIT through the branch below. Only the inactive state
    // performs the page switch; while a Find owns the ordinary keys `Tab` is a
    // consumed no-op, exactly like the reserved Home/End, and the Find hint drops
    // such a binding (tui-app's `findHint` filters it). Every OTHER Find binding
    // keeps its existing NAVIGATE re-entry.
    if (matchesKey(data, JOB_LOCAL_KEYS.switchPage)) {
      if (search.mode === 'inactive') {
        if (command) this.showOutput()
        else this.openCommand()
      }
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
      // `Tab`/`C`/Stop verbs are NOT reachable here.
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
      // Command is a pure reading page: the ONLY ordinary verb here is the original
      // Copy All (the page toggle is reserved and handled above).
      if (matchesKey(data, JOB_LOCAL_KEYS.copy)) this.copyCommandAll()
      return
    }
    // Stop keeps its existing precedence on the Output page (the fixed
    // `tasks.stop` branch runs BEFORE the B1-C read-only verbs).
    if (componentKeymap.matches(data, 'tasks.stop') && this.intents.canStop()) {
      this.intents.onStop()
      return
    }
    if (matchesKey(data, JOB_LOCAL_KEYS.copy)) this.copyOutput()
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
   *  the SAME painted target — same action, same page, same exact Command source
   *  and the SAME painted row/cell range — so a repaint between press and release
   *  (another Job, a narrowed button, a different header row) can never fire a
   *  ghost action. */
  onHeaderClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressedTarget
    this.pressedTarget = undefined
    const target = this.headerTargetAt(x, y)
    if (pressed === undefined || target === undefined) return
    if (target.action !== pressed.action || target.view !== pressed.view || target.documentKey !== pressed.documentKey) return
    if (target.row !== pressed.row || target.startCol !== pressed.startCol || target.endCol !== pressed.endCol) return
    if (target.action === 'open-command') this.openCommand()
    else if (target.action === 'open-output') this.showOutput()
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
    // Below four rows the frame cannot host a SearchRow at all, so Find cannot be
    // entered as a hidden editor: the request is consumed without changing any
    // state. The Action Bar reads the SAME capability, so the hint and the entry
    // point never disagree.
    if (!planChrome({
      width: this.chrome.width,
      rows: this.intents.rows(),
      noticeLive: this.intents.notice() !== undefined,
      searchRequested: true,
      metadataAvailable: metadataAvailable(this.chrome.view),
    }).searchCapable) {
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
   *  viewport/follow/query are exactly as the user left them. Repaints on its
   *  own, because a tab CLICK reaches this path without a key dispatch. */
  private showOutput(): void {
    if (this.readState.view !== 'command') return
    this.commandReader.exitSearch()
    this.commandReader.cancelSelection()
    this.readState.view = 'output'
    this.header.setState(this.chrome.view, 'output', commandEligible(this.chrome.view))
    this.intents.setNativeCopyOnSelect(true)
    this.pressedTarget = undefined
    this.intents.focusComponent(this)
    this.intents.requestRender()
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
