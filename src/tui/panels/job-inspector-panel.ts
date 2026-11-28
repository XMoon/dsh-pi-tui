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

import {
  Text,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeyId,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { JOB_LOCAL_KEYS, formatHintKeys, formatKeyId } from '../keybindings/hints.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan, type ActionInkRole } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayLog } from '../presentation/terminal-text.ts'
import { color, taskStatusColor } from '../theme/runtime.ts'
import { JobCommandReader, type CommandPaintedBox } from './job-command-reader.ts'
import { JobOutputScrollView } from './job-output-scroll-view.ts'
import { JobOutputSearch, retentionEviction, type JobSearchRowAction, type JobSearchRowHitTarget } from './job-output-search.ts'
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
  readonly action: 'open-command' | 'open-output' | 'copy-command-all' | 'toggle-preview'
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
/** Multi-line Command preview budget bounds (UX plan §6.2). */
const PREVIEW_MIN_ROWS = 12
const PREVIEW_MIN_BODY_ROWS = 6
const PREVIEW_MAX_RATIO = 0.6
const PREVIEW_MIN_CAP = 2
/** The Job page step mirrors the alt screen's own page semantics (X page scroll). */
const PAGE_SCROLL_OVERLAP = 4

/** The fixed reading-tab names (compact uses the two-cell short forms). */
const TAB_OUTPUT = 'Output'
const TAB_COMMAND = 'Command'
const TAB_OUTPUT_SHORT = 'Out'
const TAB_COMMAND_SHORT = 'Cmd'

/** The Command page's EXACT-copy affordance. The bracketed key is derived from
 *  the fixed Job-local copy key so advertising it is truthful. */
const COMMAND_COPY_ALL = `Copy All [${formatKeyId(JOB_LOCAL_KEYS.copy)}]`
/** The Output page's EXACT-copy affordance on the Action Bar. */
const OUTPUT_COPY = `Copy Output [${formatKeyId(JOB_LOCAL_KEYS.copy)}]`
/** The Output page's passive preview Command copy affordance (no key badge:
 *  `c` on Output copies the retained output, not the command). */
const PREVIEW_COPY_COMMAND = 'Copy Command'
/** The Output paused Follow re-arm affordance. */
const RESUME_FOLLOW = `Resume [${formatKeyId('end')}]`

/** The Action Bar's pure browsing hint: the reserved physical page keys every
 *  long body can be scrolled with (plan §2.1). */
const PAGE_HINT = 'PgUp/PgDn'

/** How the Output page's Command summary / preview area is projected this frame. */
type JobPreviewMode = 'expanded' | 'collapsed' | 'compact' | 'none'

interface JobInspectorChromePlan {
  readonly compact: boolean
  readonly statusRows: number
  readonly metadataRows: number
  readonly summaryRows: number
  readonly previewMode: JobPreviewMode
  readonly previewRows: number
  readonly previewOverflowRows: number
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

/** The live inputs the ONE plan is derived from. */
interface JobInspectorChromeInputs {
  readonly width: number
  readonly rows: number
  readonly noticeLive: boolean
  readonly searchRequested: boolean
  readonly metadataAvailable: boolean
  readonly view: JobReadView
  readonly commandEligible: boolean
  readonly previewCollapsed: boolean
  readonly commandVisualRows: number
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
  let previewMode: JobPreviewMode = 'none'
  let previewRows = 0
  let previewOverflowRows = 0
  if (inputs.view === 'output' && inputs.commandEligible) {
    if (inputs.previewCollapsed) {
      previewMode = 'collapsed'
    } else {
      const cap = Math.max(0, Math.min(Math.floor(remaining * PREVIEW_MAX_RATIO), remaining - PREVIEW_MIN_BODY_ROWS))
      if (safeRows >= PREVIEW_MIN_ROWS && summaryRows === 1 && tabRows === 1 && cap >= PREVIEW_MIN_CAP && inputs.commandVisualRows > 0) {
        previewMode = 'expanded'
        previewRows = Math.min(inputs.commandVisualRows, cap)
        previewOverflowRows = inputs.commandVisualRows > cap ? inputs.commandVisualRows - (cap - 1) : 0
        remaining -= previewRows
      } else {
        previewMode = 'compact'
      }
    }
  }
  return {
    compact,
    statusRows,
    metadataRows,
    summaryRows,
    previewMode,
    previewRows,
    previewOverflowRows,
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
  /** The live physical column grant. A pointer gesture is revoked when the
   *  terminal geometry moved before the next paint, so the panel needs the
   *  LIVE width too (it never guesses it from a painted row). */
  readonly columns: () => number
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
  /** Whether a fixed Job-local key (`tab`, `f2`) is currently preempted by a
   *  higher-priority Host Exit direct binding or active leader prefix. When
   *  true, the key badge is omitted so the UI never advertises an unreachable
   *  shortcut while the mouse action stays live. */
  readonly isLocalKeyPreempted?: (key: KeyId) => boolean
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
 *  summary (with adaptive multi-line passive Command preview on Output, or the
 *  Command page's title and exact-copy button) and the reading tabs. It also
 *  reports the hit regions its LAST render produced, so a later click resolves
 *  against the frame the user actually saw rather than a re-measured live
 *  layout. */
class JobInspectorHeader implements Component {
  private view: JobInspectorView
  private mode: JobReadView = 'output'
  private commandAvailable = false
  private hitTargets: readonly JobHeaderHitTarget[] = []
  private headingCopyVisibleValue = false
  private readonly plan: (width: number) => JobInspectorChromePlan
  private readonly previewLines: (width: number, maxRows: number) => readonly string[]
  private readonly isSearchActive: () => boolean
  private readonly isLocalKeyPreempted: (key: KeyId) => boolean
  private readonly onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined

  constructor(
    view: JobInspectorView,
    plan: (width: number) => JobInspectorChromePlan,
    previewLines: (width: number, maxRows: number) => readonly string[],
    isSearchActive: () => boolean,
    isLocalKeyPreempted: (key: KeyId) => boolean,
    onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
  ) {
    this.view = view
    this.plan = plan
    this.previewLines = previewLines
    this.isSearchActive = isSearchActive
    this.isLocalKeyPreempted = isLocalKeyPreempted
    this.onMouse = onMouse
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

  /** Whether the Command page's heading painted the complete `Copy All [C]`
   *  button on the last render (used by the Action Bar to avoid duplicating
   *  Copy when the heading already owns it). */
  headingCopyVisible(): boolean {
    return this.headingCopyVisibleValue
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.onMouse(event)
  }

  private expandLabel(): string {
    return this.isLocalKeyPreempted(JOB_LOCAL_KEYS.switchPage)
      ? 'Expand'
      : `Expand [${formatKeyId(JOB_LOCAL_KEYS.switchPage)}]`
  }

  private togglePreviewLabel(collapsed: boolean): string {
    const verb = collapsed ? 'Show' : 'Hide'
    return this.isLocalKeyPreempted(JOB_LOCAL_KEYS.togglePreview)
      ? verb
      : `${verb} [${formatKeyId(JOB_LOCAL_KEYS.togglePreview)}]`
  }

  /** Build the heading row for expanded/collapsed Command Preview: `Command` on
   *  the left, complete priority-dropped actions on the right (omitted while
   *  Find owns input). */
  private previewHeadingLine(
    width: number,
    collapsed: boolean,
    searchActive: boolean,
  ): {
    readonly line: string
    readonly spans: readonly { readonly action: 'copy-command-all' | 'open-command' | 'toggle-preview'; readonly startCol: number; readonly endCol: number }[]
  } {
    const headingText = 'Command'
    const paintedHeading = color.textDim(headingText)
    const headingWidth = visibleWidth(headingText)
    if (searchActive || headingWidth >= width) {
      return { line: truncateToWidth(paintedHeading, width, '…', false), spans: [] }
    }
    interface ActionItem extends ActionBarSegment {
      readonly action: 'copy-command-all' | 'open-command' | 'toggle-preview'
    }
    const candidates: ActionItem[] = [
      { action: 'copy-command-all', text: PREVIEW_COPY_COMMAND, priority: 1 },
      { action: 'open-command', text: this.expandLabel(), priority: collapsed ? 2 : 3 },
      { action: 'toggle-preview', text: this.togglePreviewLabel(collapsed), priority: collapsed ? 3 : 2 },
    ]
    const budget = width - headingWidth - 1
    const layout = budget > 0 ? layoutActionBarRow(candidates, budget) : { text: '', spans: [], truncated: true }
    if (layout.truncated || layout.spans.length === 0) {
      return { line: paintedHeading, spans: [] }
    }
    const actionsWidth = layout.spans.at(-1)!.endCol
    const gap = width - headingWidth - actionsWidth
    const baseCol = headingWidth + gap
    const spans: { readonly action: 'copy-command-all' | 'open-command' | 'toggle-preview'; readonly startCol: number; readonly endCol: number }[] = []
    const paintedActions: string[] = []
    for (const span of layout.spans) {
      const source = candidates[span.inputIndex]!
      spans.push({ action: source.action, startCol: baseCol + span.startCol, endCol: baseCol + span.endCol })
      paintedActions.push(color.primary(span.text))
    }
    return {
      line: `${paintedHeading}${' '.repeat(gap)}${paintedActions.join(color.textMuted(ACTION_BAR_SEPARATOR))}`,
      spans,
    }
  }

  /**
   * Paint the header rows the CURRENT frame granted, in the locked order:
   * status title, optional metadata, the page's summary (plus passive Command
   * preview rows when expanded), the reading tabs. The hit map is derived from
   * the SAME painted strings, so a hidden or truncated affordance can never
   * keep a clickable region.
   */
  render(width: number): string[] {
    const plan = this.plan(width)
    const searchActive = this.isSearchActive()
    const raw: string[] = []
    const pending: JobHeaderHitTarget[] = []
    this.headingCopyVisibleValue = false
    if (plan.statusRows > 0) raw.push(this.statusLine(width))
    if (plan.metadataRows > 0) raw.push(this.metadataLine(width))
    if (plan.summaryRows > 0) {
      const row = raw.length
      if (this.mode === 'command') {
        const summary = this.summaryLine(width, searchActive)
        raw.push(summary.line)
        if (!searchActive && summary.span !== undefined) {
          this.headingCopyVisibleValue = true
          pending.push({
            row,
            startCol: summary.span.start,
            endCol: summary.span.end,
            action: 'copy-command-all',
            documentKey: this.documentKey(),
            view: 'command',
          })
        }
      } else if (this.commandAvailable && (plan.previewMode === 'expanded' || plan.previewMode === 'collapsed')) {
        const heading = this.previewHeadingLine(width, plan.previewMode === 'collapsed', searchActive)
        raw.push(heading.line)
        for (const span of heading.spans) {
          pending.push({
            row,
            startCol: span.startCol,
            endCol: span.endCol,
            action: span.action,
            documentKey: this.documentKey(),
            view: 'output',
          })
        }
        if (plan.previewMode === 'expanded' && plan.previewRows > 0) {
          const textRows = plan.previewOverflowRows > 0 ? plan.previewRows - 1 : plan.previewRows
          for (const line of this.previewLines(width, textRows)) {
            raw.push(line)
          }
          if (plan.previewOverflowRows > 0) {
            raw.push(truncateToWidth(color.textDim(`… ${plan.previewOverflowRows} more rows`), width, '…', false))
          }
        }
      } else {
        const summary = this.summaryLine(width, searchActive)
        raw.push(summary.line)
        if (this.commandAvailable && !searchActive && summary.span !== undefined) {
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
      // Only the OTHER page's COMPLETE painted tab is live, and only while Find
      // is inactive.
      if (!searchActive) {
        const other = this.mode === 'output' ? tabs.command : tabs.output
        const painted = visibleWidth(tabs.line) > width ? width - 1 : width
        if (other !== undefined && other.end <= painted) {
          pending.push({
            row,
            startCol: other.start,
            endCol: other.end,
            action: this.mode === 'output' ? 'open-command' : 'open-output',
            documentKey: this.documentKey(),
            view: this.mode,
          })
        }
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

  /** The summary row for compact Output summary, non-shell Label, or the
   *  Command page's `Full command` title with the exact-copy button. */
  private summaryLine(width: number, searchActive: boolean): {
    readonly line: string
    readonly leadEnd: number
    readonly span?: { readonly start: number; readonly end: number }
  } {
    if (this.mode === 'command') {
      const lead = color.textMuted(COMMAND_FULL_NOTE)
      if (searchActive) return { line: truncateToWidth(lead, width, '…', false), leadEnd: Math.min(width, visibleWidth(COMMAND_FULL_NOTE)) }
      return withTrailingAffordance(lead, color.primary(COMMAND_COPY_ALL), width)
    }
    const summary = `${COMMAND_KINDS.has(this.view.kind) ? 'Command' : 'Label'}  ${chromeText(this.view.label)}`
    const painted = color.textMuted(summary)
    if (!this.commandAvailable || searchActive) {
      return { line: truncateToWidth(painted, width, '…', false), leadEnd: Math.min(width, visibleWidth(summary)) }
    }
    return withTrailingAffordance(painted, color.primary(this.expandLabel()), width)
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
  private readonly onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined

  constructor(
    parts: (width: number) => { readonly note: string; readonly position?: string } | undefined,
    plan: (width: number) => JobInspectorChromePlan,
    onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
  ) {
    this.parts = parts
    this.plan = plan
    this.onMouse = onMouse
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.onMouse(event)
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
  /** Whether the Command header already painted `Copy All [C]` this frame. */
  readonly headingCopyVisible: boolean
}

/** The ONE Esc destination of the CURRENT read page/search state. A click on
 *  the painted Esc affordance replays exactly this through the panel's own key
 *  dispatch — never a second close/search state machine. */
type JobBarEscapeAction = 'leave-find' | 'output' | 'back'

/** Every clickable Action Bar intent. Stop stays keyboard-only (inert). */
type JobBarAction = 'resume-follow' | 'open-find' | 'copy-output' | 'copy-command-all' | 'escape'

/** One clickable segment of the LAST rendered Action Bar frame (bar-local cells). */
interface JobBarHitTarget {
  readonly action: JobBarAction
  readonly startCol: number
  readonly endCol: number
  readonly escapeAction?: JobBarEscapeAction
}

interface JobBarSegment extends ActionBarSegment {
  readonly action?: JobBarAction
  readonly role?: ActionInkRole
  readonly escapeAction?: JobBarEscapeAction
}

class JobInspectorActionBar implements Component {
  private readonly canStop: () => boolean
  private readonly facts: (width: number) => JobOutputStatusFacts | (JobCommandStatusFacts & { readonly command: true })
  private readonly isLocalKeyPreempted: (key: KeyId) => boolean
  private readonly onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined
  private hitTargets: readonly JobBarHitTarget[] = []

  constructor(
    canStop: () => boolean,
    facts: (width: number) => JobOutputStatusFacts | (JobCommandStatusFacts & { readonly command: true }),
    isLocalKeyPreempted: (key: KeyId) => boolean,
    onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
  ) {
    this.canStop = canStop
    this.facts = facts
    this.isLocalKeyPreempted = isLocalKeyPreempted
    this.onMouse = onMouse
  }

  /** The complete visible clickable Action Bar targets of the LAST render. */
  hits(): readonly JobBarHitTarget[] {
    return this.hitTargets
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.onMouse(event)
  }

  /** Paint the shared row: clickable segments carry the scoped Fullscreen dense
   *  Action Bar ink (`paintActionSpan`) while inert hints/facts/separators stay
   *  `textMuted`. Only complete, non-truncated segments publish hit targets. */
  private paint(segments: readonly JobBarSegment[], width: number): string[] {
    const layout = layoutActionBarRow(segments, width)
    const nextHits: JobBarHitTarget[] = []
    if (layout.truncated || layout.spans.length === 0) {
      this.hitTargets = []
      return [color.textMuted(layout.text)]
    }
    const painted = layout.spans.map(span => {
      const source = segments[span.inputIndex]
      if (source?.action === undefined) return color.textMuted(span.text)
      nextHits.push({
        action: source.action,
        startCol: span.startCol,
        endCol: span.endCol,
        ...(source.escapeAction === undefined ? {} : { escapeAction: source.escapeAction }),
      })
      return paintActionSpan(span.text, source.role ?? 'secondary')
    })
    this.hitTargets = nextHits
    const segmentWidth = layout.spans.reduce((sum, span) => sum + visibleWidth(span.text), 0)
      + Math.max(0, layout.spans.length - 1) * visibleWidth(ACTION_BAR_SEPARATOR)
    const padding = Math.max(0, visibleWidth(layout.text) - segmentWidth)
    return [painted.join(color.textMuted(ACTION_BAR_SEPARATOR)) + ' '.repeat(padding)]
  }

  render(width: number): string[] {
    const facts = this.facts(width)
    const escKey = formatKeyId('escape')
    const escapeAction: JobBarEscapeAction = facts.searchActive ? 'leave-find' : 'command' in facts ? 'output' : 'back'
    const escapeText = escapeAction === 'leave-find'
      ? `Leave find [${escKey}]`
      : escapeAction === 'output'
        ? `Output [${escKey}]`
        : `Back [${escKey}]`
    const pageHint = facts.bodyVisible && !facts.searchEditing
    const findSegment: JobBarSegment[] = !facts.searchEditing && facts.canFind
      ? [{
          text: facts.findHint === '' ? '/ find' : `${facts.findHint} find`,
          priority: 1.5,
          action: 'open-find',
          role: 'secondary',
        }]
      : []
    const position: JobBarSegment[] = facts.bodyVisible && facts.position.total > 0
      ? [{ text: `rows ${facts.position.start}-${facts.position.end}/${facts.position.total}`, priority: 2 }]
      : []
    if ('command' in facts) {
      const segments: JobBarSegment[] = []
      // Only show Copy All on the bar when the Command heading did not already
      // paint it (never duplicate the same copy control on one frame).
      if (!facts.searchActive && !facts.headingCopyVisible) {
        segments.push({ text: COMMAND_COPY_ALL, priority: 6, action: 'copy-command-all', role: 'secondary' })
      }
      if (!facts.readingFacts) {
        segments.push({ text: COMMAND_FULL_NOTE, priority: 5 })
        segments.push(...position)
      }
      segments.push(...findSegment)
      if (pageHint) segments.push({ text: PAGE_HINT, priority: 0.1 })
      segments.push({ text: escapeText, priority: 7, action: 'escape', role: 'secondary', escapeAction })
      return this.paint(segments, width)
    }
    const segments: JobBarSegment[] = []
    const stopKey = componentKeymap.keysFor('tasks.stop')[0]
    // Stop is keyboard-only by contract: inert hint, never a pointer target.
    if (!facts.searchActive && this.canStop() && stopKey !== undefined) {
      segments.push({ text: `${formatHintKeys(formatKeyId(stopKey))} stop`, priority: 6 })
    }
    if (!facts.readingFacts) {
      segments.push({ text: facts.follow ? 'Follow on' : 'Follow paused', priority: 5 })
    }
    if (!facts.follow && !facts.searchEditing) {
      const resumeText = this.isLocalKeyPreempted('end') ? 'Resume' : RESUME_FOLLOW
      segments.push({ text: resumeText, priority: 5.5, action: 'resume-follow', role: 'primary' })
    }
    if (facts.gap) segments.push({ text: '[GAP]', priority: 4 })
    if (!facts.readingFacts) {
      segments.push({ text: RETAINED_NOTE, priority: 3 })
      segments.push(...position)
    }
    segments.push(...findSegment)
    if (!facts.searchActive && facts.canCopyOutput) {
      segments.push({ text: OUTPUT_COPY, priority: 1, action: 'copy-output', role: 'secondary' })
    }
    if (pageHint) segments.push({ text: PAGE_HINT, priority: 0.1 })
    segments.push({ text: escapeText, priority: 7, action: 'escape', role: 'secondary', escapeAction })
    return this.paint(segments, width)
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
  private readonly onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined

  constructor(
    notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined,
    plan: (width: number) => JobInspectorChromePlan,
    onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
  ) {
    this.notice = notice
    this.plan = plan
    this.onMouse = onMouse
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.onMouse(event)
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

/** Compare two optional painted boxes for exact geometry equality. */
const samePaintedBox = (left: CommandPaintedBox | undefined, right: CommandPaintedBox | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

const clonePaintedBox = (box: CommandPaintedBox | undefined): CommandPaintedBox | undefined =>
  box === undefined ? undefined : { x: box.x, y: box.y, width: box.width, height: box.height }

/** The chrome geometry of ONE painted frame: the terminal grant, the painted
 *  header/search/bar boxes and the LIVE reading-viewport positions. A press
 *  records it, and the click accepts the gesture only while the LIVE grant
 *  still matches it, the CURRENT painted frame has the identical geometry and
 *  the viewports did not move. */
interface JobChromeFrame {
  readonly rows: number
  readonly columns: number
  readonly header: CommandPaintedBox | undefined
  readonly search: CommandPaintedBox | undefined
  readonly bar: CommandPaintedBox | undefined
  /** The Output page's viewport position at the press. */
  readonly scrollTop: number
  /** The Command page's viewport position at the press. */
  readonly commandScrollTop: number
  /** The semantic state identity that was ACTUALLY painted into this frame. */
  readonly semanticKey: string
}

type JobChromeOwner = 'header' | 'search' | 'facts' | 'notice' | 'bar'

/** The ONE pressed chrome gesture target and its press-time frame/state identity. */
type JobPressedGesture =
  | {
      readonly owner: 'header'
      readonly target: JobHeaderHitTarget
      readonly semanticKey: string
      readonly chrome: JobChromeFrame
    }
  | {
      readonly owner: 'search'
      readonly target: JobSearchRowHitTarget
      readonly semanticKey: string
      readonly chrome: JobChromeFrame
    }
  | {
      readonly owner: 'bar'
      readonly target: JobBarHitTarget
      readonly row: number
      readonly startCol: number
      readonly endCol: number
      readonly semanticKey: string
      readonly chrome: JobChromeFrame
    }

/**
 * The Job workspace root: a fixed typed header (with adaptive passive Command
 * preview), the one-epoch Find search row of the CURRENT page, ONE primary
 * ScrollView over the current body, the reading-facts row, the transient notice
 * row and the fixed bottom Action Bar. It is the `setLayoutRoot` root AND the
 * keyboard focus target, so `Esc`/`tasks.stop` arrive on its own
 * {@link handleInput} — and, while a Find is being edited, the SearchRow is the
 * physical focus target instead.
 */
export class JobInspectorPanel extends VStack {
  private readonly header: JobInspectorHeader
  private readonly body: Text
  private readonly search: JobOutputSearch
  private readonly scrollView: JobOutputScrollView
  private readonly commandReader: JobCommandReader
  /** The ONE reading-page and per-open preview-collapse state of this instance. */
  private readonly readState: { view: JobReadView; previewCollapsed: boolean }
  private readonly intents: JobInspectorPanelIntents
  /** One frame plan shared by every fixed child and rewritten once per render,
   *  plus the frame width, the live view the Action Bar reads and the viewport
   *  the position fact was last measured against. */
  private readonly chrome: {
    plan: JobInspectorChromePlan
    width: number
    view: JobInspectorView
    positionViewportHeight: number
    renderedSemanticKey: string
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
  /** The header/search/bar hit regions of the LAST PAINTED frame. */
  private paintedHeaderTargets: readonly JobHeaderHitTarget[] = []
  private paintedSearchTargets: readonly JobSearchRowHitTarget[] = []
  private paintedBarTargets: readonly JobBarHitTarget[] = []
  /** The pinned Action Bar instance (the SAME child mounted in the layout). */
  private readonly actionBar: JobInspectorActionBar
  /** The geometry and semantic identity of the LAST PAINTED frame. */
  private paintedChromeFrame: JobChromeFrame = {
    rows: -1,
    columns: -1,
    header: undefined,
    search: undefined,
    bar: undefined,
    scrollTop: 0,
    commandScrollTop: 0,
    semanticKey: '',
  }
  /** The ONE press-time target of the LAST chrome gesture. */
  private pressed: JobPressedGesture | undefined
  private disposed = false

  constructor(initial: JobInspectorState, intents: JobInspectorPanelIntents) {
    const view = deriveJobInspectorView(initial)
    const readState: { view: JobReadView; previewCollapsed: boolean } = { view: 'output', previewCollapsed: false }
    const holders: {
      commandReader?: JobCommandReader
      panel?: JobInspectorPanel
    } = {}
    const isLocalKeyPreempted = (key: KeyId): boolean => intents.isLocalKeyPreempted?.(key) ?? false
    const onChromeMouse = (owner: JobChromeOwner) =>
      (event: TuiMouseEvent): TuiMouseEventResult | undefined => holders.panel?.handleChromeMouse(owner, event)

    const chrome: {
      plan: JobInspectorChromePlan
      width: number
      view: JobInspectorView
      positionViewportHeight: number
      renderedSemanticKey: string
    } = {
      plan: planChrome({
        width: 0,
        rows: intents.rows(),
        noticeLive: intents.notice() !== undefined,
        searchRequested: false,
        metadataAvailable: metadataAvailable(view),
        view: 'output',
        commandEligible: commandEligible(view),
        previewCollapsed: false,
        commandVisualRows: 0,
      }),
      width: 0,
      view,
      positionViewportHeight: -1,
      renderedSemanticKey: '',
    }
    const plan = (width: number): JobInspectorChromePlan => {
      const activeSearchMode = readState.view === 'command'
        ? holders.commandReader?.search.mode ?? 'inactive'
        : search.mode
      const eligible = commandEligible(chrome.view)
      const commandVisualRows = readState.view === 'output' && eligible && !readState.previewCollapsed
        ? holders.commandReader?.previewRowCount(width) ?? 0
        : 0
      const next = planChrome({
        width,
        rows: intents.rows(),
        noticeLive: intents.notice() !== undefined,
        searchRequested: activeSearchMode !== 'inactive',
        metadataAvailable: metadataAvailable(chrome.view),
        view: readState.view,
        commandEligible: eligible,
        previewCollapsed: readState.previewCollapsed,
        commandVisualRows,
      })
      chrome.plan = next
      chrome.width = width
      chrome.renderedSemanticKey = holders.panel?.semanticKey() ?? ''
      return next
    }
    const header = new JobInspectorHeader(
      view,
      plan,
      (width, maxRows) => holders.commandReader?.previewLines(width, maxRows) ?? [],
      () => (readState.view === 'command'
        ? (holders.commandReader?.search.mode ?? 'inactive') !== 'inactive'
        : search.mode !== 'inactive'),
      isLocalKeyPreempted,
      onChromeMouse('header'),
    )
    const body = new Text('', 0, 0)
    body.setText(bodyText(view))
    const search = new JobOutputSearch(
      body,
      (width) => readState.view === 'output' && plan(width).searchRows === 1,
      'Find Output: ',
      { onMouse: onChromeMouse('search'), findHint: intents.findHint, isLocalKeyPreempted },
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
      onSearchMouse: onChromeMouse('search'),
      findHint: intents.findHint,
      isLocalKeyPreempted,
    })
    holders.commandReader = commandReader
    // The ONE gesture-boundary notification: any EFFECTIVE viewport move on
    // either reading page retires a pressed chrome gesture immediately (an
    // away-and-back scroll before the next paint must not revive it).
    scrollView.onViewportMoved = () => { this.pressed = undefined }
    commandReader.setViewportMovedCallback(() => { this.pressed = undefined })
    /** The reading facts of the CURRENT page: the page's disclosure plus the real
     *  measured viewport position, or undefined when the page shows none. */
    const readingFacts = (width: number): { readonly note: string; readonly position?: string } | undefined => {
      if (readState.view === 'command') {
        const position = positionFacts(commandReader.search, commandReader.scroll, width)
        return readingFactsParts(position.total > 0 ? '' : COMMAND_FULL_NOTE, position)
      }
      const followFact = scrollView.isFollowRequested ? 'Follow on' : 'Follow paused'
      return readingFactsParts(`${followFact} · ${RETAINED_NOTE}`, positionFacts(search, scrollView, width))
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
          headingCopyVisible: header.headingCopyVisible(),
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
        canCopyOutput: chrome.view.phase === 'observed' && chrome.view.retainedText !== '',
      }
    }, isLocalKeyPreempted, onChromeMouse('bar'))
    super([
      { component: header, shrink: 0 },
      { component: search.row, shrink: 0, visible: () => readState.view === 'output' },
      { component: commandReader.search.row, shrink: 0, visible: () => readState.view === 'command' },
      { component: scrollView, basis: 0, grow: 1, visible: () => readState.view === 'output' },
      { component: commandReader.scroll, basis: 0, grow: 1, visible: () => readState.view === 'command' },
      { component: new JobWorkspaceReadingFactsRow(readingFacts, plan, onChromeMouse('facts')), shrink: 0 },
      { component: new JobInspectorNoticeRow(intents.notice, plan, onChromeMouse('notice')), shrink: 0 },
      { component: bar, shrink: 0 },
    ])
    holders.panel = this
    this.header = header
    this.actionBar = bar
    this.body = body
    this.search = search
    this.scrollView = scrollView
    this.commandReader = commandReader
    this.readState = readState
    this.intents = intents
    this.chrome = chrome
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
    const previous = this.chrome.view
    const previousEligible = commandEligible(previous)
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
    this.search.setVisibleAnchor(this.scrollView.scrollTop)
    this.search.setSource(view.retainedText, searchable, selectionEviction)
    if (eligible) this.commandReader.setSource(view.label)
    else this.commandReader.clearSource()
    // Revoke any pressed chrome gesture when the live semantic identity diverged
    // from the pressed frame; benign Output appends that leave geometry,
    // viewport and painted target intact keep an in-flight gesture alive.
    if (this.pressed !== undefined && this.pressed.chrome.semanticKey !== this.semanticKey()) {
      this.pressed = undefined
    }
    if (nextView !== previousView) {
      this.intents.focusComponent(this)
    }
    this.invalidate()
    this.intents.requestRender()
  }

  /** The layout frame is committed and painted: consume the ONE pending search
   *  reveal of the CURRENT page against the real geometry, leave a search whose
   *  SearchRow this frame could no longer show, and commit the chrome hit maps
   *  and semantic identity the user can actually click. Never mutates the layout
   *  from `render()`. */
  onFramePainted(): void {
    if (this.disposed) return
    const headerBox = clonePaintedBox(this.intents.paintedBox(this.header))
    const activeSearch = this.readState.view === 'command' ? this.commandReader.search : this.search
    const searchBox = activeSearch.mode === 'inactive'
      ? undefined
      : clonePaintedBox(this.intents.paintedBox(activeSearch.row))
    const barBox = clonePaintedBox(this.intents.paintedBox(this.actionBar))
    this.paintedHeaderTargets = this.header.hits()
    this.paintedSearchTargets = activeSearch.mode === 'inactive' ? [] : activeSearch.rowHits()
    this.paintedBarTargets = this.actionBar.hits()
    this.paintedChromeFrame = {
      rows: this.intents.rows(),
      columns: this.intents.columns(),
      header: headerBox,
      search: searchBox,
      bar: barBox,
      scrollTop: this.scrollView.scrollTop,
      commandScrollTop: this.commandReader.scroll.scrollTop,
      semanticKey: this.chrome.renderedSemanticKey,
    }
    if (this.pressed !== undefined
      && (!this.chromeFrameCurrent(this.pressed.chrome) || !this.pressedTargetStillPainted(this.pressed))) {
      this.pressed = undefined
    }

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
    this.search.setVisibleAnchor(this.scrollView.scrollTop)
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
    if (this.chrome.positionViewportHeight !== this.scrollView.viewportHeight) {
      this.chrome.positionViewportHeight = this.scrollView.viewportHeight
      this.intents.requestRender()
    }
  }

  /**
   * The Job workspace's ONE input owner. `Esc`/`tasks.stop` are the B1-A
   * intents; Find, the search state machine, the strict-follow viewport keys and
   * the Job-local `Tab`/`F2`/`c` verbs are owned here. Every other key is inert:
   * the Job is read-only and never leaks into the background editor or transcript.
   */
  handleInput(data: string): void {
    if (this.disposed) return
    const command = this.readState.view === 'command'
    const search = command ? this.commandReader.search : this.search
    const scroll = command ? this.commandReader.scroll : this.scrollView
    if (search.mode === 'edit') {
      if (matchesKey(data, 'escape')) {
        this.exitSearch()
        return
      }
      if (matchesKey(data, 'enter')) {
        this.commitSearch()
        return
      }
      if (search.editKey(data)) {
        this.pressed = undefined
        this.intents.requestRender()
      }
      return
    }
    if (matchesKey(data, 'end')) {
      this.resumeFollowOrScrollEnd()
      return
    }
    if (matchesKey(data, 'home')) {
      scroll.scrollToStart()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, JOB_LOCAL_KEYS.switchPage)) {
      if (search.mode === 'inactive') {
        if (command) this.showOutput()
        else this.openCommand()
      }
      return
    }
    // `F2` is a RESERVED Job-local key (preview visibility toggle): consumed
    // BEFORE Find resolution so a Find remapped onto F2 never opens Find.
    if (matchesKey(data, JOB_LOCAL_KEYS.togglePreview)) {
      if (!command && search.mode === 'inactive' && commandEligible(this.chrome.view)) {
        this.togglePreview()
      }
      return
    }
    if (matchesKey(data, '/') || this.intents.isFindKey(data)) {
      this.openFind()
      return
    }
    if (matchesKey(data, 'escape')) {
      this.handleEscapeAction()
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
      if (matchesKey(data, 'n')) {
        this.stepSearch(1)
      } else if (matchesKey(data, 'shift+n')) {
        this.stepSearch(-1)
      }
      return
    }
    if (command) {
      if (matchesKey(data, JOB_LOCAL_KEYS.copy)) this.copyCommandAll()
      return
    }
    if (componentKeymap.matches(data, 'tasks.stop') && this.intents.canStop()) {
      this.intents.onStop()
      return
    }
    if (matchesKey(data, JOB_LOCAL_KEYS.copy)) this.copyOutput()
  }

  /** The painted header hit region at one screen cell, or undefined. */
  private headerTargetAt(x: number, y: number): JobHeaderHitTarget | undefined {
    const box = this.paintedChromeFrame.header
    if (box === undefined) return undefined
    const row = y - box.y
    const col = x - box.x
    return this.paintedHeaderTargets.find(target => target.row === row && col >= target.startCol && col < target.endCol)
  }

  /** The painted SearchRow hit region at one screen cell, or undefined. */
  private searchTargetAt(x: number, y: number): JobSearchRowHitTarget | undefined {
    const box = this.paintedChromeFrame.search
    if (box === undefined) return undefined
    const row = y - box.y
    const col = x - box.x
    return this.paintedSearchTargets.find(target => target.row === row && col >= target.startCol && col < target.endCol)
  }

  /** The painted Action Bar hit region at one screen cell, or undefined. */
  private barTargetAt(x: number, y: number): { readonly target: JobBarHitTarget; readonly row: number; readonly startCol: number; readonly endCol: number } | undefined {
    const box = this.paintedChromeFrame.bar
    if (box === undefined || y !== box.y) return undefined
    const col = x - box.x
    const hit = this.paintedBarTargets.find(target => col >= target.startCol && col < target.endCol)
    if (hit === undefined) return undefined
    return { target: hit, row: box.y, startCol: box.x + hit.startCol, endCol: box.x + hit.endCol }
  }

  /** Snapshot the LAST PAINTED chrome frame for one press. */
  private chromeFrame(): JobChromeFrame {
    const frame = this.paintedChromeFrame
    return {
      rows: frame.rows,
      columns: frame.columns,
      header: clonePaintedBox(frame.header),
      search: clonePaintedBox(frame.search),
      bar: clonePaintedBox(frame.bar),
      scrollTop: frame.scrollTop,
      commandScrollTop: frame.commandScrollTop,
      semanticKey: frame.semanticKey,
    }
  }

  /** Whether the gesture's painted frame is still the LIVE one (geometry + semantic identity). */
  private chromeFrameCurrent(chrome: JobChromeFrame): boolean {
    if (chrome.semanticKey === '' || this.semanticKey() !== chrome.semanticKey) return false
    if (this.intents.rows() !== chrome.rows || this.intents.columns() !== chrome.columns) return false
    if (this.scrollView.scrollTop !== chrome.scrollTop) return false
    if (this.commandReader.scroll.scrollTop !== chrome.commandScrollTop) return false
    const live = this.paintedChromeFrame
    if (live.semanticKey !== chrome.semanticKey) return false
    if (live.rows !== chrome.rows || live.columns !== chrome.columns) return false
    return samePaintedBox(live.header, chrome.header)
      && samePaintedBox(live.search, chrome.search)
      && samePaintedBox(live.bar, chrome.bar)
  }

  /** The exact semantic state identity a chrome frame was painted against.
   *  Benign Output log appends (non-empty → non-empty) preserve the same key so
   *  a live gesture is never needlessly broken; any state change that alters
   *  action admission or command source changes the key immediately. */
  private semanticKey(): string {
    const search = this.readState.view === 'command' ? this.commandReader.search : this.search
    return [
      this.chrome.view.jobId,
      this.chrome.view.kind,
      this.chrome.view.phase,
      this.chrome.view.label,
      this.chrome.view.retainedText !== '' ? '1' : '0',
      this.scrollView.isFollowRequested ? '1' : '0',
      commandEligible(this.chrome.view) ? '1' : '0',
      this.readState.view,
      this.readState.previewCollapsed ? '1' : '0',
      search.mode,
      search.query,
    ].join('\u0000')
  }

  /**
   * The ONE chrome pointer handler shared by all fixed chrome components
   * (Header, SearchRow, ReadingFactsRow, NoticeRow, ActionBar):
   * - wheel over chrome is always consumed (never bubbles into routeWheel);
   * - left press captures the gesture (even on inert/stale chrome, preventing
   *   native word-copy on buttons/labels) without requesting fork focus, and
   *   registers a pending action only when the LAST PAINTED frame's semantic
   *   identity and geometry match the LIVE state;
   * - drag retires any pending chrome action and returns undefined; release
   *   returns undefined (the fork handles captured press/drag/release and
   *   synthesizes click, while non-chrome-origin drags fall through to native
   *   Output selection);
   * - only a same-cell synthetic `click` with `clickCount === 1` and matching
   *   painted frame + semantic identity executes the semantic intent.
   */
  /** Shared target-identity comparator used both at frame commit (to retire a
   *  pressed gesture if its painted span vanished or moved between frames) and
   *  at click admission. */
  private sameHeaderTarget(candidate: JobHeaderHitTarget, expected: JobHeaderHitTarget): boolean {
    return candidate.action === expected.action
      && candidate.view === expected.view
      && candidate.documentKey === expected.documentKey
      && candidate.row === expected.row
      && candidate.startCol === expected.startCol
      && candidate.endCol === expected.endCol
  }

  private sameSearchTarget(candidate: JobSearchRowHitTarget, expected: JobSearchRowHitTarget): boolean {
    return candidate.action === expected.action
      && candidate.mode === expected.mode
      && candidate.query === expected.query
      && candidate.row === expected.row
      && candidate.startCol === expected.startCol
      && candidate.endCol === expected.endCol
  }

  private sameBarTarget(
    candidate: { readonly target: JobBarHitTarget; readonly row: number; readonly startCol: number; readonly endCol: number },
    expected: Extract<JobPressedGesture, { readonly owner: 'bar' }>,
  ): boolean {
    return candidate.target.action === expected.target.action
      && candidate.target.escapeAction === expected.target.escapeAction
      && candidate.row === expected.row
      && candidate.startCol === expected.startCol
      && candidate.endCol === expected.endCol
  }

  /** Whether the pressed target's exact painted span still exists in the latest
   *  committed target map (prevents A → vanish → C span ABA revival). */
  private pressedTargetStillPainted(pressed: JobPressedGesture): boolean {
    if (pressed.owner === 'header') {
      return this.paintedHeaderTargets.some(target => this.sameHeaderTarget(target, pressed.target))
    }
    if (pressed.owner === 'search') {
      return this.paintedSearchTargets.some(target => this.sameSearchTarget(target, pressed.target))
    }
    const box = this.paintedChromeFrame.bar
    if (box === undefined) return false
    return this.paintedBarTargets.some(hit => this.sameBarTarget(
      { target: hit, row: box.y, startCol: box.x + hit.startCol, endCol: box.x + hit.endCol },
      pressed,
    ))
  }

  private handleChromeMouse(owner: JobChromeOwner, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') return { handled: true, render: false }
    if (event.type === 'move') return undefined
    if (event.type === 'press') {
      if (event.button !== 'left') return undefined
      this.pressed = undefined
      const chrome = this.chromeFrame()
      if (this.chromeFrameCurrent(chrome)) {
        const semanticKey = chrome.semanticKey
        if (owner === 'header') {
          const target = this.headerTargetAt(event.screenX, event.screenY)
          if (target !== undefined) this.pressed = { owner: 'header', target, semanticKey, chrome }
        } else if (owner === 'search') {
          const target = this.searchTargetAt(event.screenX, event.screenY)
          if (target !== undefined) this.pressed = { owner: 'search', target, semanticKey, chrome }
        } else if (owner === 'bar') {
          const hit = this.barTargetAt(event.screenX, event.screenY)
          if (hit !== undefined) {
            this.pressed = {
              owner: 'bar',
              target: hit.target,
              row: hit.row,
              startCol: hit.startCol,
              endCol: hit.endCol,
              semanticKey,
              chrome,
            }
          }
        }
      }
      return { handled: true, capture: true, render: false }
    }
    if (event.type === 'drag') {
      this.pressed = undefined
      return undefined
    }
    if (event.type === 'release') {
      return undefined
    }
    if (event.type === 'click') {
      const pressed = this.pressed
      this.pressed = undefined
      if (pressed === undefined || pressed.owner !== owner) return { handled: true, render: false }
      if ((event.clickCount ?? 1) !== 1) return { handled: true, render: false }
      if (!this.chromeFrameCurrent(pressed.chrome) || this.semanticKey() !== pressed.semanticKey) {
        return { handled: true, render: false }
      }
      if (pressed.owner === 'header') {
        const target = this.headerTargetAt(event.screenX, event.screenY)
        if (target === undefined || !this.sameHeaderTarget(target, pressed.target)) {
          return { handled: true, render: false }
        }
        if (target.action === 'open-command') this.openCommand()
        else if (target.action === 'open-output') this.showOutput()
        else if (target.action === 'toggle-preview') this.togglePreview()
        else this.copyCommandAll()
        return { handled: true, render: false }
      }
      if (pressed.owner === 'search') {
        const target = this.searchTargetAt(event.screenX, event.screenY)
        if (target === undefined || !this.sameSearchTarget(target, pressed.target)) {
          return { handled: true, render: false }
        }
        this.dispatchSearchRowAction(target.action)
        return { handled: true, render: false }
      }
      const hit = this.barTargetAt(event.screenX, event.screenY)
      if (hit === undefined || !this.sameBarTarget(hit, pressed)) {
        return { handled: true, render: false }
      }
      this.dispatchBarAction(hit.target.action)
      return { handled: true, render: false }
    }
    return undefined
  }

  private dispatchSearchRowAction(action: JobSearchRowAction): void {
    if (action === 'search-commit') this.commitSearch()
    else if (action === 'search-prev') this.stepSearch(-1)
    else if (action === 'search-next') this.stepSearch(1)
    else this.openFind()
  }

  private dispatchBarAction(action: JobBarAction): void {
    if (action === 'resume-follow') this.resumeFollowOrScrollEnd()
    else if (action === 'open-find') this.openFind()
    else if (action === 'copy-output') this.copyOutput()
    else if (action === 'copy-command-all') this.copyCommandAll()
    else this.handleEscapeAction()
  }

  /** The terminal lost focus (FOCUS_OUT): revoke any in-flight chrome press
   *  and Command drag selection/edge timer. */
  onTerminalBlur(): void {
    if (this.disposed) return
    this.pressed = undefined
    if (this.commandReader.cancelSelection()) this.intents.requestRender()
  }

  /** Make updates and intents inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pressed = undefined
    this.commandReader.dispose()
    super.dispose()
  }

  /** Toggle the Output page's per-open Command preview visibility intent. */
  private togglePreview(): void {
    if (this.disposed || this.readState.view !== 'output' || !commandEligible(this.chrome.view)) return
    if (this.search.mode !== 'inactive') return
    this.readState.previewCollapsed = !this.readState.previewCollapsed
    this.pressed = undefined
    this.invalidate()
    this.intents.requestRender()
  }

  /** Commit EDIT → NAVIGATE on the current page's Find model. */
  private commitSearch(): void {
    const activeSearch = this.readState.view === 'command' ? this.commandReader.search : this.search
    if (activeSearch.mode !== 'edit') return
    this.pressed = undefined
    activeSearch.enterNavigate()
    this.intents.requestRender()
  }

  /** Step to the next/previous match in NAVIGATE mode. */
  private stepSearch(direction: -1 | 1): void {
    const activeSearch = this.readState.view === 'command' ? this.commandReader.search : this.search
    if (activeSearch.mode !== 'navigate') return
    this.pressed = undefined
    activeSearch.step(direction)
    this.intents.requestRender()
  }

  /** Shared `End` / `Resume [End]` semantic intent: exit NAVIGATE if active,
   *  then resume follow on Output or scroll to end on Command. */
  private resumeFollowOrScrollEnd(): void {
    const command = this.readState.view === 'command'
    const activeSearch = command ? this.commandReader.search : this.search
    if (activeSearch.mode === 'edit') return
    this.pressed = undefined
    if (activeSearch.mode === 'navigate') this.exitSearch()
    if (command) this.commandReader.scroll.scrollToEnd()
    else this.scrollView.resumeFollow()
    this.intents.requestRender()
  }

  /** Shared `Esc` semantic intent: Leave find → Output → Back. */
  private handleEscapeAction(): void {
    const command = this.readState.view === 'command'
    const activeSearch = command ? this.commandReader.search : this.search
    this.pressed = undefined
    if (activeSearch.mode !== 'inactive') {
      this.exitSearch()
      return
    }
    if (command) {
      this.showOutput()
      return
    }
    this.intents.onClose()
  }

  /** Open (or re-open) the CURRENT page's Job Find — the shared entry of the
   *  direct effective Find binding, the `/` alias, the Host leader completion,
   *  the Action Bar Find span and the SearchRow Edit action. */
  openFind(): void {
    if (this.disposed) return
    const eligible = commandEligible(this.chrome.view)
    if (!planChrome({
      width: this.chrome.width,
      rows: this.intents.rows(),
      noticeLive: this.intents.notice() !== undefined,
      searchRequested: true,
      metadataAvailable: metadataAvailable(this.chrome.view),
      view: this.readState.view,
      commandEligible: eligible,
      previewCollapsed: this.readState.previewCollapsed,
      commandVisualRows: this.readState.view === 'output' && eligible && !this.readState.previewCollapsed
        ? this.commandReader.previewRowCount(this.chrome.width)
        : 0,
    }).searchCapable) {
      return
    }
    this.pressed = undefined
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
   *  page's scroll, follow intent, preview collapse intent, query and viewport
   *  untouched. */
  private openCommand(): void {
    if (this.disposed || this.readState.view === 'command') return
    if (!commandEligible(this.chrome.view)) return
    this.search.exit()
    this.readState.view = 'command'
    this.header.setState(this.chrome.view, 'command', true)
    this.intents.setNativeCopyOnSelect(false)
    this.pressed = undefined
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }

  /** Return to the Output page: the Command Find drops its input ownership (its
   *  query survives), the selection and gesture are cancelled, and the Output
   *  viewport/follow/preview-collapse/query are exactly as the user left them. */
  private showOutput(): void {
    if (this.readState.view !== 'command') return
    this.commandReader.exitSearch()
    this.commandReader.cancelSelection()
    this.readState.view = 'output'
    this.header.setState(this.chrome.view, 'output', commandEligible(this.chrome.view))
    this.intents.setNativeCopyOnSelect(true)
    this.pressed = undefined
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }

  /** Copy the ORIGINAL observed shell command label verbatim (from Command
   *  page `c`/`Copy All [C]` or Output preview `Copy Command`). */
  private copyCommandAll(): void {
    if (this.disposed) return
    if (!commandEligible(this.chrome.view)) {
      this.intents.onCopy({ source: 'command-all', text: '', unavailable: 'command-unavailable' })
      return
    }
    this.intents.onCopy({ source: 'command-all', text: this.commandReader.source })
  }

  /** Copy the retained Output snapshot text verbatim. */
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
    this.pressed = undefined
    if (this.readState.view === 'command') this.commandReader.exitSearch()
    else this.search.exit()
    this.intents.focusComponent(this)
    this.intents.requestRender()
  }
}
