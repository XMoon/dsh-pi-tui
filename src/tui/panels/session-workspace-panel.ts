/**
 * M5-U-D — the fullscreen PiTUI Session Workspace panel.
 *
 * ONE client-local component owns the whole Session Workspace surface: the
 * grouped browse list (`Needs attention` → `Working` → `Recent`), the complete
 * Workspace scope selector, the global content-search editor and its result
 * list, the read-only `Space` Transcript Reader, the responsive two-column layout, the
 * per-open selection/scroll anchors, the focus ring and the last-painted mouse
 * hit-map. It is the layout ROOT of the temporary workspace lease
 * (`TuiApp.openSessionWorkspace`), so every key arrives on its own
 * {@link SessionWorkspacePanel.handleInput} and every primary click arrives as
 * the fork's `onCellPress`/`onCellClick` pair.
 *
 * The panel owns NO read authority. `SessionBrowserReadOwner` owns every list,
 * projection and search generation and publishes its detached
 * `SessionBrowserReadSnapshot`; the official Workspace facts arrive through
 * one per-open `WorkspaceFactsHandle`; the official Activity sample and the
 * Client-root forwarded-answer eligibility arrive through
 * `SessionWorkspaceHandle.setActivityFacts`. The panel folds all three into a
 * disposable per-open projection and never reads a backend, never opens,
 * retains or answers a Session, never writes a Workspace and never derives an
 * answerability fact of its own: the classification lives in the ONE pure
 * `buildSessionWorkspaceView`.
 *
 * `Enter` produces ONE `onResume(sessionId)` intent; the read owner re-proves
 * the same row/currentness and the command layer owns the real switch. The
 * panel is UI-only and is disposed with the physical lease.
 * @module @xmoon76/dsh-pi-tui/tui/panels/session-workspace-panel
 */

import {
  CURSOR_MARKER,
  Input,
  Key,
  Markdown,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserNewSessionSettlement,
  SessionBrowserReadSnapshot,
  SessionBrowserRow,
  SessionBrowserSearchResult,
  SessionInspectorSelection,
} from '../../app/command/session-browser-presentation.ts'
import type {
  SessionActivityFact,
  SessionWorkspaceFact,
  WorkspaceFactsFrame,
} from '../../runtime/session-workspace-facts-port.ts'
import type { SessionMarkdownReadResult } from '../../runtime/session-markdown-port.ts'
import { isCancellation } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import {
  ACTION_BAR_SEPARATOR,
  layoutActionBarRow,
  renderActionBarRow,
  type ActionBarSegment,
} from '../presentation/action-bar.ts'
import { paintActionSpan, type ActionInkRole } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import {
  buildSessionWorkspaceView,
  currentWorkspaceOf,
  visibleWorkspaceBrowserRows,
  workspaceRowStatusLabel,
  type SessionWorkspacePriority,
  type SessionWorkspaceGroupView,
  type SessionWorkspaceRowFact,
  type SessionWorkspaceView,
} from '../presentation/session-workspace-view.ts'
import {
  ADD_DIRECTORY_ROW_ID,
  projectPiTuiWorkspaceTree,
  type PiTuiWorkspaceTreeRow,
} from '../presentation/session-workspace-tree.ts'
import {
  buildSessionInspectorView,
  type SessionInspectorFact,
  type SessionInspectorGroup,
  type SessionInspectorView,
} from '../presentation/session-inspector-view.ts'
import { SESSION_WORKSPACE_CHORDS } from '../keybindings/hints.ts'
import { color, HOST_MARKDOWN_OPTIONS, markdownTheme } from '../theme/runtime.ts'
import { formatSessionAge, sessionBrowserErrorNotice, shortSessionId, workspaceKey } from '../pickers/sessions.ts'
import type { HostDirectoryBrowsePort } from '../../runtime/host-directory-browse-port.ts'
import { hostDirectoryQuery } from '../../domain/file-completion/host-directory-query.ts'
import {
  HOST_DIRECTORY_SUGGESTION_LIMIT,
  HostDirectoryChooser,
  type HostDirectoryCandidate,
} from '../interaction/host-directory-chooser.ts'

/** The logical focus of one Session Workspace frame. `search` is the raw
 * global query editor; `search-results` is the Host+metadata result list;
 * `reader` is the full-width read-only committed-transcript Reader;
 * `inspector` is the full-width read-only Session Inspector page. */
export type SessionWorkspaceFocus = 'search' | 'list' | 'search-results' | 'reader' | 'inspector' | 'directory'

/** What the ONE PiTUI Session Workspace Presentation needs from `TuiApp`.
 *  Everything is read live; the panel never receives the app object. */
export interface SessionWorkspacePanelHost {
  readonly rows: () => number
  readonly columns: () => number
  readonly requestRender: () => void
  /** The app's ONE transient notice (a workspace paints it, never owns it). */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** The ONE raw-editor change entry; only a real text change reaches it. */
  readonly onQueryChange: (raw: string) => void
  /** ONE logical resume intent for the selected listed non-current row. The
   *  read owner re-proves eligibility; the panel never switches a Session. */
  readonly onResume: (sessionId: string) => void
  /** ONE explicit read of the official complete committed Markdown for an
   *  already painted Session id. This is the Reader's only IO seam. */
  readonly readMarkdown: (sessionId: string, signal: AbortSignal) => Promise<SessionMarkdownReadResult>
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: SessionBrowserNewSessionSettlement) => void) => void
  readonly onAddDirectory?: (path: string, settle: (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void) => void
  /** Session Workspace PR3: the ONE optional read-only Host directory browse
   *  seam. Absent = this composition has no Host browse capability, and the
   *  editor keeps its manual absolute-path verification only. */
  readonly onListDirectory?: HostDirectoryBrowsePort['list']
  /** Session Workspace PR2: report the ONE typed Session this committed frame
   *  really painted, with the actual Browse/Search provenance (never a
   *  folder/show-more/reader/directory target). */
  readonly onInspectorSelection?: (selection: SessionInspectorSelection | undefined) => void
  /** The user's own close gesture (Esc at the root list). */
  readonly onClose: () => void
}

export interface SessionWorkspacePanelOptions {
  /** `/sessions <query>` and `/search <query>` open the global editor; the
   * bare commands open the browse list. */
  readonly initialMode: 'browse' | 'search'
  /** The command edge's browse intent. */
  readonly initialBrowseScope: 'current' | 'all'
  readonly initialDirectoryChooser?: boolean
  /** The atomically captured current Session id of THIS open; never a live
   * re-read of the runner. */
  readonly currentSessionId: string | undefined
  readonly currentWorkspaceId?: string
  readonly initialDirectoryEntry?: boolean
  readonly initialDirectoryPath?: string
}

/** The ONE activity publication the panel receives: the accepted roster
 *  revision, the official sample and the Client-root eligibility read view. */
export interface SessionWorkspaceActivityFacts {
  readonly listRevision: number
  readonly facts: readonly SessionActivityFact[]
  /** `undefined` = this composition has NO official answer capability. */
  readonly answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
}

const EMPTY_SNAPSHOT: SessionBrowserReadSnapshot = {
  listState: 'loading',
  rows: [],
  query: '',
  resumePending: false,
  searchState: 'idle',
  searchResults: [],
  hasMore: false,
  listRevision: 0,
}

/** The two-column layout threshold (frozen by the PR3 product contract). */
const WIDE_MIN_COLUMNS = 80
const WIDE_MIN_ROWS = 12
/** The smallest left column and the smallest right Inspector column. */
const WIDE_LEFT_MIN_CELLS = 44
const WIDE_RIGHT_MIN_CELLS = 34
/** From this terminal width the right Inspector may paint two complete facts
 *  per row; below it every fact owns its own full-width label/value rows. */
const WIDE_TWO_FACT_MIN_COLUMNS = 120
/** The two plain cells that make a Session a CHILD of its Folder row. `> ` stays
 *  in the fixed tree gutter, so the bullet and the identity move together. */
const SESSION_TREE_INDENT = 2
/** The title cells a Folder or tagged Session row keeps before a secondary fact
 *  or a right-aligned status/count group may take the rest of the row. */
const MIN_TITLE_CELLS = 8
const GROUP_LABEL: Record<SessionWorkspacePriority, string> = {
  needs: 'Needs attention',
  working: 'Working',
  recent: 'Recent',
}

/** One Reader's complete official Markdown source must stay bounded. This is
 *  a UI retention policy, not a Host response limit. */
const SESSION_READER_MAX_SOURCE_CODE_UNITS = 4_194_304
/** One Reader's rendered physical-row budget at the current width. A larger
 *  document is a truthful `too-large` result, never a truncated transcript. */
const SESSION_READER_MAX_RENDERED_ROWS = 100_000
/** The retained UI diagnostic is a bounded summary; the full safe reason is
 *  already emitted by the command bridge's diagnostics channel. */
const SESSION_READER_MAX_ERROR_CODE_UNITS = 4_096
/** Error bodies are summarized to at most two body widths before wrapping, so
 *  a hostile 500 response never creates thousands of invisible styled rows. */
const SESSION_READER_ERROR_SUMMARY_LINES = 2

/** ONE explicit Reader state object. Its identity is the only async currentness
 *  token for the one official Markdown read it starts. */
interface SessionTranscriptReader {
  readonly sessionId: string
  readonly returnFocus: 'list' | 'search-results'
  readonly controller: AbortController
  state:
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly document: Markdown }
    | { readonly kind: 'none' }
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'too-large' }
    | { readonly kind: 'error'; readonly message: string }
  scrollRow: number
}

/** ONE full-width read-only Inspector reading of a painted typed Session row.
 *  Its identity is the same id+origin the list already reported; opening it
 *  never changes the selection, resumes a Session or starts a second read. */
interface SessionInspectorPage {
  readonly sessionId: string
  readonly origin: 'browse' | 'search'
  readonly returnFocus: 'list' | 'search-results'
  scrollRow: number
}

/** Truncate one rendered line to the pane width and pad it with plain spaces. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** One display-safe single physical row for a private `Input` render. The
 *  returned `safe` flag means the raw value was already display-safe, so the
 *  exact Input click-to-position contract can be used. */
interface SafeInputLine {
  readonly line: string
  readonly safe: boolean
}

function markerCount(line: string, marker: string): number {
  let count = 0
  for (let index = line.indexOf(marker); index >= 0; index = line.indexOf(marker, index + marker.length)) {
    count += 1
  }
  return count
}

/** The private start/end wrappers `renderFakeCursor()` uses, DERIVED from its
 *  public contract instead of duplicating the fork's protocol bytes. */
const FAKE_CURSOR_PROBE = renderFakeCursor('\u0000')
const FAKE_CURSOR_PROBE_INDEX = FAKE_CURSOR_PROBE.indexOf('\u0000')
const FAKE_CURSOR_START_MARKER = FAKE_CURSOR_PROBE.slice(0, FAKE_CURSOR_PROBE_INDEX)
const FAKE_CURSOR_END_MARKER = FAKE_CURSOR_PROBE.slice(FAKE_CURSOR_PROBE_INDEX + 1)

/**
 * Project one focused/unfocused `Input.render()` row through the plain
 * terminal policy. The Input's own hardware/fake cursor markers are
 * re-applied around SAFE text; every Host/user byte is projected as a plain
 * single row, so a legal Host path containing ESC/C1/LF cannot inject a
 * terminal sequence or break the row/hit-map. The raw Input value (the value
 * `Enter` submits) is never touched.
 *
 * A focused Input renders `before + CURSOR_MARKER + fakeCursor(at) + after`.
 * The fake cursor wraps exactly one grapheme, and the plain policy strips its
 * private markers, so the first safe grapheme after the hardware marker is the
 * caret cell. `safe` is true only when the raw VALUE itself needed no
 * projection, which is also the only case where the exact click-to-position
 * contract is used.
 */
function projectInputLine(rawLine: string, width: number, value: string): SafeInputLine {
  const safeValue = sanitizedPhysicalLine(value) === value
  if (markerCount(rawLine, CURSOR_MARKER) === 1
    && markerCount(rawLine, FAKE_CURSOR_START_MARKER) === 1
    && markerCount(rawLine, FAKE_CURSOR_END_MARKER) === 1) {
    const cursorAt = rawLine.indexOf(CURSOR_MARKER)
    const startAt = rawLine.indexOf(FAKE_CURSOR_START_MARKER)
    const endAt = rawLine.indexOf(FAKE_CURSOR_END_MARKER)
    if (cursorAt < startAt && startAt < endAt) {
      const before = rawLine.slice(0, cursorAt)
      const at = rawLine.slice(startAt + FAKE_CURSOR_START_MARKER.length, endAt)
      const after = rawLine.slice(endAt + FAKE_CURSOR_END_MARKER.length)
      const safeBefore = sanitizedPhysicalLine(before)
      const safeAt = sanitizedPhysicalLine(at) || ' '
      const safeAfter = sanitizedPhysicalLine(after)
      const rebuilt = `${safeBefore}${CURSOR_MARKER}${renderFakeCursor(safeAt)}${safeAfter}`
      if (visibleWidth(rebuilt) <= width) return { line: fit(rebuilt, width), safe: safeValue }
    }
  }
  // An unfocused row, a value that spoofed the app's own cursor markers, or a
  // projection that grew past the row budget: strip the app markers FIRST (the
  // plain policy would treat an APC marker as an unterminated string and eat
  // the rest of the row), then keep the safe single-line text and drop the
  // fake caret. A hostile value never gets an unsafe caret.
  const stripped = rawLine
    .replaceAll(CURSOR_MARKER, '')
    .replaceAll(FAKE_CURSOR_START_MARKER, '')
    .replaceAll(FAKE_CURSOR_END_MARKER, '')
  const safeLine = sanitizedPhysicalLine(stripped)
  return { line: fit(safeLine, width), safe: safeValue }
}

/** The minimum cells a row's IDENTITY (title, or the short id when untitled)
 *  owns before secondary meta may use the row: two same-cwd Sessions must stay
 *  distinguishable even in a narrow terminal. */
const MIN_IDENTITY_CELLS = 12

/**
 * Split one row into an identity column and a secondary column. The identity
 * gets its full width when short, otherwise at least {@link MIN_IDENTITY_CELLS}
 * and at most 60% of the available cells; a meta column that cannot fit a
 * two-cell gap plus one word is dropped entirely so the identity never collapses
 * to `…`.
 */
function rowColumns(titleWidth: number, width: number): { readonly identity: number; readonly meta: number } {
  const available = Math.max(1, width - 4)
  const identity = Math.min(
    available,
    Math.max(1, Math.min(titleWidth, Math.max(MIN_IDENTITY_CELLS, Math.floor(available * 0.6)))),
  )
  let meta = Math.max(0, available - identity)
  if (meta < 3) return { identity: available, meta: 0 }
  meta -= 2 // the two-cell gap between the columns
  return { identity, meta }
}

/** Compose the row IDENTITY: the stable short Session id always precedes the
 *  title (a title alone can repeat across Sessions whose id, cwd and age are
 *  otherwise identical). The id stays visible; the title uses the remaining
 *  identity cells and yields to the id, never the reverse. */
function identityText(shortId: string, title: string | undefined, selected: boolean): string {
  if (title === undefined || title === '') {
    // An untitled row's ID *is* its identity: it takes the normal text role and
    // the selected strong role, not the secondary dim role.
    return selected ? color.textStrong(shortId) : color.text(shortId)
  }
  const paintedTitle = selected ? color.textStrong(title) : color.text(title)
  return `${color.textDim(shortId)}  ${paintedTitle}`
}

/** The visible text width of the identity composition (title + stable id). */
function identityWidth(shortId: string, title: string | undefined): number {
  return title === undefined || title === '' ? visibleWidth(shortId) : visibleWidth(shortId) + 2 + visibleWidth(title)
}

/** Pad one already-truncated column to its exact cell budget. */
function padColumn(text: string, cells: number): string {
  const padding = cells - visibleWidth(text)
  return padding > 0 ? text + ' '.repeat(padding) : text
}

/** Right-align a trailing fact on one already-composed left label. */
function withTrailing(left: string, trailing: string, width: number): string {
  const room = width - visibleWidth(trailing)
  if (room <= 0) return truncateToWidth(left, width, '…', false)
  const clipped = truncateToWidth(left, room, '…', false)
  return `${clipped}${' '.repeat(Math.max(0, room - visibleWidth(clipped)))}${trailing}`
}

/** Keep the selected index inside its viewport with the smallest rebase. */
function rebaseOffset(offset: number, selected: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  let next = offset
  if (selected < next) next = selected
  if (selected >= next + viewport) next = selected - viewport + 1
  return Math.min(Math.max(0, next), Math.max(0, count - viewport))
}

/** The disposable per-open Workspace membership projection. It is never
 *  persisted and never crosses an open; `order` only decides the label order
 *  of KNOWN workspaces and never creates a member from `order` alone. */
interface WorkspaceProjection {
  readonly order: readonly string[]
  readonly byId: ReadonlyMap<string, SessionWorkspaceFact>
  /** Whether a valid official baseline was received and has not been lost. */
  readonly proven: boolean
}

const EMPTY_PROJECTION: WorkspaceProjection = { order: [], byId: new Map(), proven: false }

/** Fold ONE official follow frame. Unknown `order` ids are ignored; an
 *  `upsert` appends a genuinely new WorkspaceId. */
function foldWorkspaceFrame(projection: WorkspaceProjection, frame: WorkspaceFactsFrame): WorkspaceProjection {
  switch (frame.type) {
    case 'baseline':
    case 'replace': {
      const byId = new Map<string, SessionWorkspaceFact>()
      const order: string[] = []
      for (const item of frame.items) {
        if (!byId.has(item.workspaceId)) order.push(item.workspaceId)
        byId.set(item.workspaceId, item)
      }
      return { order, byId, proven: true }
    }
    case 'upsert': {
      const byId = new Map(projection.byId)
      byId.set(frame.workspace.workspaceId, frame.workspace)
      const order = projection.byId.has(frame.workspace.workspaceId)
        ? projection.order
        : [...projection.order, frame.workspace.workspaceId]
      return { order, byId, proven: projection.proven }
    }
    case 'remove': {
      if (!projection.byId.has(frame.workspaceId)) return projection
      const byId = new Map(projection.byId)
      byId.delete(frame.workspaceId)
      return { order: projection.order.filter((id) => id !== frame.workspaceId), byId, proven: projection.proven }
    }
    case 'order': {
      const known = frame.workspaceIds.filter((id) => projection.byId.has(id))
      const listed = new Set(known)
      return {
        order: [...known, ...projection.order.filter((id) => !listed.has(id))],
        byId: projection.byId,
        proven: projection.proven,
      }
    }
    case 'invalidated':
      // The current generation's membership is no longer proven: drop it now
      // and keep the panel's flat fallback until a fresh baseline arrives.
      return EMPTY_PROJECTION
  }
}

/** One clickable Action Bar verb of the LAST painted frame. Every id maps onto
 *  an EXISTING panel method; the bar never grows a second navigation state. */
type SessionBarAction = 'close' | 'open' | 'peek' | 'inspect' | 'results' | 'verify' | 'cancel' | 'activate-row'

/** A wheel-only viewport row. It carries no id/action and is never a click
 *  target; the panel routes it to the EXISTING selection or scroll method of
 *  its pane. */
type WheelZoneKind = 'wheel-browse' | 'wheel-results' | 'wheel-reader' | 'wheel-inspector'

/** One painted mouse target of the LAST frame. `xEnd` is inclusive and every
 *  range is the REAL painted cell range: a truncated/omitted target has none. */
interface HitRegion {
  readonly kind: 'tree-row' | 'folder-toggle' | 'result' | 'search' | 'search-hint' | 'bar-action' | 'directory-input' | 'directory-suggestion' | WheelZoneKind
  readonly id?: string
  readonly action?: SessionBarAction
  readonly xStart: number
  readonly xEnd: number
  readonly line: number
}

/** Whether one painted region is a wheel-only viewport row (never a click). */
function isWheelZone(kind: HitRegion['kind']): kind is WheelZoneKind {
  return kind === 'wheel-browse' || kind === 'wheel-results' || kind === 'wheel-reader' || kind === 'wheel-inspector'
}

/** One pane render: the painted lines plus the regions in pane coordinates. */
interface PaneRender {
  readonly lines: string[]
  readonly regions: readonly HitRegion[]
}

/** One physical Action Bar segment. A segment that carries an `action` is a
 *  clickable `Verb [Key]`; an action-less segment is an inert hint/fact that
 *  paints muted and never registers a hit region. */
type SessionBarSegment = ActionBarSegment & (
  | { readonly action: SessionBarAction; readonly ink: ActionInkRole }
  | { readonly action?: undefined; readonly ink?: undefined }
)

export class SessionWorkspacePanel implements Component {
  private readonly host: SessionWorkspacePanelHost
  private readonly options: SessionWorkspacePanelOptions
  private snapshot: SessionBrowserReadSnapshot = EMPTY_SNAPSHOT
  /** The one per-open Workspace membership projection (never persisted). */
  private workspaces: WorkspaceProjection = EMPTY_PROJECTION
  private workspaceRevisionSeen = -1
  private activityRevisionSeen = -1
  private workspaceError: string | undefined
  private nextCreateWorkspaceId: string | undefined
  private readonly workspaceExpanded = new Map<string, boolean>()
  private readonly workspaceHistoryLimit = new Map<string, number>()
  /** The LAST projected PiTUI tree (renderer-local, rebuilt from official facts). */
  private treeRowsCache: readonly PiTuiWorkspaceTreeRow[] = []

  /** The official Activity sample of ONE accepted roster revision. */
  private activity: readonly SessionActivityFact[] | undefined
  private answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
  private activityError: string | undefined
  /** The roster revision whose Activity sample was accepted OR failed last. */
  private activitySampleRevision = 0
  private defaultScope: 'current' | 'all'
  private focus: SessionWorkspaceFocus
  private searchMode: boolean
  /** The ONE typed browse selection. Every browse action derives its target by
   *  finding THIS id in the live projected rows; no second selected-* fact. */
  private selectedBrowseRowId: PiTuiWorkspaceTreeRow['id'] | undefined
  /** Whether the cursor was moved by the user. An automatic fallback may be
   *  replaced by the first official Folder once the baseline arrives; a real
   *  user selection is never stolen by a late baseline. */
  private browseSelectionUserOwned = false
  /** The search-results selection; never the browse selection. */
  private selectedSearchSessionId: string | undefined
  /** The browse selection and scroll anchor saved across one global search. */
  private searchReturn: { readonly rowId: PiTuiWorkspaceTreeRow['id'] | undefined; readonly treeScrollAnchorId: string | undefined } | undefined
  /** The physical viewport offset and the painted row id it points at. The id
   *  is the anchor that survives reorders/inserts; the offset falls back only
   *  when the anchored row is gone. */
  private treeScrollOffset = 0
  private treeScrollAnchorId: string | undefined
  private lastPaintedListRows = 1
  /** The row ids actually painted in the LAST frame of each mode. Activation
   *  is admitted against this set, never against the logical roster: a row the
   *  current height/status budget did not paint cannot be opened by a blind
   *  Enter. */
  private lastPaintedBrowseIds: string[] = []
  private lastPaintedTreeIds: string[] = []
  private lastPaintedResultIds: string[] = []
  /** The ordered groups of the last painted frame (the stable tie-break for
   *  rows whose official `updatedAt` collides). */
  private paintedGroups: readonly SessionWorkspaceGroupView[] = []
  /** The one raw search editor. Programmatic seeds are fenced by
   *  `applyingSeed`, so only a real text change reaches the read owner. */
  private readonly searchInput = new Input({ prompt: 'Search: ' })
  /** The ONE per-open inline Host-directory editor; `undefined` means the
   *  editor is closed. It owns the private Input, the Host home read and the
   *  latest prefix query generation. */
  private directoryChooser: HostDirectoryChooser | undefined
  private directorySubmitting = false
  /** Whether the CURRENT frame really painted the editable Host path line.
   *  A tiny frame can have no body room; Enter must then not submit. */
  private directoryEditorPainted = false
  /** The candidate paths the LAST frame really painted. Tab/click admission is
   *  checked against this exact set, never against the logical query result. */
  private paintedDirectorySuggestionPaths: string[] = []
  private lastDirectoryInputWidth = 0
  /** Whether the LAST painted Input row was already display-safe (exact click mapping). */
  private directoryInputDisplaySafe = true
  /** ONE pending Folder-New dispatch. The object identity is the per-operation
   *  currentness fence: only the settle callback for THIS object may unlock
   *  New. A notice, timer or roster diff is never a settlement channel. */
  private newSessionPending: { readonly workspaceId: string } | undefined
  private seedApplied = false
  private userEdited = false
  private applyingSeed = false
  private disposed = false
  /** Per-open dedupe for the one status message this panel owns. */
  private lastNotice: string | undefined
  private statusMessage: string | undefined
  /** Whether the inline editor's own status line reports an error. */
  private directoryStatusError = false
  /** The transient result-list scroll of THIS search, never a stored anchor. */
  private resultScroll = 0
  /** The ONE read-only `Space` Transcript Reader of a painted row. */
  private reader: SessionTranscriptReader | undefined
  /** The ONE full-width read-only Inspector reading; `undefined` = list mode. */
  private inspectorPage: SessionInspectorPage | undefined
  /** Whether THIS frame really painted the Inspector page's own identity/body.
   *  A frame too short to paint it reports no target and advertises no scroll. */
  private inspectorPagePainted = false
  /** Whether THIS page frame really painted at least one scrollable body row.
   *  Its identity alone must never advertise a Scroll/Page key that does nothing. */
  private inspectorScrollPainted = false
  /** The selected Session whose inline Inspector this frame really painted (the
   *  two-column right pane). Used only for presentation-only repaint admission. */
  private lastPaintedInlineInspectorSessionId: string | undefined
  /** The inline right Inspector's own scroll offset and the id it belongs to:
   *  switching id starts at the top, same-id refresh/resize clamps in place. */
  private inlineInspectorScroll = 0
  private inlineInspectorScrollId: string | undefined
  /** The per-open mouse gesture: one press identity, cleared by ANY content
   *  change of the last committed frame. */
  private pressed:
    | {
      readonly revision: number
      readonly kind: HitRegion['kind']
      readonly action: SessionBarAction | undefined
      readonly id: string | undefined
      readonly xStart: number
      readonly xEnd: number
      readonly line: number
      /** The LIVE terminal grant at press time. A resize before the next frame
       *  publishes revokes the gesture instead of replaying an old cell. */
      readonly rows: number
      readonly columns: number
    }
    | undefined
  /** The last frame this panel really painted, in panel-relative coordinates.
   *  The paint-time root grant is recorded beside the regions so a wheel that
   *  arrives at a terminal size this frame never covered is rejected. */
  private hitFrame: {
    readonly revision: number
    readonly regions: readonly HitRegion[]
    readonly rows: number
    readonly columns: number
  } = { revision: 0, regions: [], rows: 0, columns: 0 }
  /** Identifies the CONTENT of the last painted frame. The fork repaints the
   *  screen on the press half of a click, so a render counter would invalidate
   *  every genuine click; this revision advances only when the painted frame
   *  really changed (scroll, resize, scope, search, Activity, selection). */
  private frameRevision = 0
  private lastFrameSignature: string | undefined

  /** Commit ONE painted frame: its OWN content revision and its mouse hit map.
   *  Re-rendering identical content keeps the revision (a press-triggered
   *  repaint must not invalidate the gesture the user started). */
  private publishFrame(frame: string[], regions: readonly HitRegion[]): string[] {
    const signature = frame.join('\n')
    if (signature !== this.lastFrameSignature) {
      this.lastFrameSignature = signature
      this.frameRevision += 1
    }
    this.hitFrame = {
      revision: this.frameRevision,
      regions,
      rows: this.host.rows(),
      columns: this.host.columns(),
    }
    // PR2: report the ONE typed Session this frame really painted. The hit map
    // and the painted-id sets were committed above; the read owner owns the
    // debounce/dedup and never publishes from this render call.
    this.host.onInspectorSelection?.(this.inspectorTargetOfFrame())
    return frame
  }

  /** The exact typed Session target of the frame being published: a real
   *  painted main-Session row in Browse/Search results, or the SAME admitted
   *  id while its read-only Inspector identity page is really painted. Folder,
   *  Show more, New, Add, Reader, the inline directory editor, a page too short
   *  to paint its own body and any unpainted id are absent. */
  private inspectorTargetOfFrame(): SessionInspectorSelection | undefined {
    if (this.directoryEntryActive || this.focus === 'reader') return undefined
    if (this.focus === 'inspector') {
      const page = this.inspectorPage
      if (page === undefined || !this.inspectorPagePainted) return undefined
      const listed = page.origin === 'search'
        ? this.snapshot.searchResults.some(result => result.row.id === page.sessionId)
        : this.snapshot.rows.some(row => row.id === page.sessionId)
      return listed ? { sessionId: page.sessionId, origin: page.origin } : undefined
    }
    if (this.searchMode) {
      const selected = this.selectedSearchSessionId
      return selected !== undefined && this.lastPaintedResultIds.includes(selected)
        ? { sessionId: selected, origin: 'search' }
        : undefined
    }
    const selected = this.selectedBrowseSessionId()
    return selected !== undefined && this.lastPaintedBrowseIds.includes(selected)
      ? { sessionId: selected, origin: 'browse' }
      : undefined
  }
  /** The ONE view of the frame being painted (built once per render). */
  private paintView: SessionWorkspaceView | undefined

  constructor(host: SessionWorkspacePanelHost, options: SessionWorkspacePanelOptions) {
    this.host = host
    this.options = options
    this.nextCreateWorkspaceId = options.currentWorkspaceId
    this.defaultScope = options.initialBrowseScope
    // Search and the inline path editor are mutually exclusive presentations:
    // the editor owns the keyboard while it is open. Resolve the editor state
    // FIRST so an initial `search + directoryEntry` open cannot keep both.
    const initialDirectoryEntry = options.initialDirectoryEntry === true
    this.searchMode = options.initialMode === 'search' && !initialDirectoryEntry
    this.focus = initialDirectoryEntry ? 'directory' : this.searchMode ? 'search' : 'list'
    if (initialDirectoryEntry) this.openDirectoryChooser(options.initialDirectoryPath)
  }

  /** Whether this panel has been released. The lease handle checks its own
   *  record as well; this flag only stops local reactions after dispose. */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Ordinary snapshots refresh results and the roster. Only the one-shot
   *  `initialQuery` option may write the editor, and never after a real edit. */
  setSnapshot(snapshot: SessionBrowserReadSnapshot, options?: {
    readonly initialQuery?: string
    readonly inspectorOnly?: boolean
  }): void {
    if (this.disposed) return
    if (options?.inspectorOnly === true) {
      // Presentation-only data publication: never normalize the selection,
      // restart the editor/Activity revisions or advance any semantic target.
      // Repaint only when a real visible consumer (the inline Inspector or the
      // full-width page) may show this id's data — including a cleared/revoked
      // cut, so the previous id's numbers cannot linger on screen.
      this.snapshot = snapshot
      if (this.focus === 'inspector' || this.lastPaintedInlineInspectorSessionId !== undefined) this.host.requestRender()
      return
    }
    if (snapshot.listRevision !== this.activitySampleRevision) {
      // The roster was re-accepted: the previous sample belongs to the OLD
      // revision and may not be painted over the new one. An old positive
      // Pending is never a current answerability promise — the row falls back
      // to Unknown until THIS revision's sample is accepted.
      this.activity = undefined
      this.activityError = undefined
      this.activityRevisionSeen = -1
    }
    if (snapshot.workspace !== undefined && snapshot.workspace.revision !== this.workspaceRevisionSeen) {
      this.workspaceRevisionSeen = snapshot.workspace.revision
      const projection: WorkspaceProjection = {
        order: snapshot.workspace.facts.map(fact => fact.workspaceId),
        byId: new Map(snapshot.workspace.facts.map(fact => [fact.workspaceId, fact] as const)),
        proven: snapshot.workspace.baselineProven,
      }
      this.workspaces = projection
      this.workspaceError = snapshot.workspace.error
      this.activity = snapshot.workspace.activity
      this.activityError = snapshot.workspace.activityError
      this.answerEligibility = snapshot.workspace.answerEligibility
      this.activitySampleRevision = snapshot.workspace.activityRevision ?? 0
      this.recomputeWorkspaceScope()
    }
    const activitySnapshot = snapshot.workspace
    if (activitySnapshot !== undefined
      && activitySnapshot.activityRevision !== undefined
      && activitySnapshot.activityRosterRevision === snapshot.listRevision
      && activitySnapshot.activityRevision !== this.activityRevisionSeen) {
      this.activityRevisionSeen = activitySnapshot.activityRevision
      this.activity = activitySnapshot.activity
      this.activityError = activitySnapshot.activityError
      this.activitySampleRevision = snapshot.listRevision
    }
    // The Client-root answer eligibility is a LIVE gate, not a sample: every
    // publication carries its exact current value, and a revocation must drop
    // a Needs row in THIS frame even when the Activity revision did not move.
    if (activitySnapshot !== undefined) this.answerEligibility = activitySnapshot.answerEligibility
    this.snapshot = snapshot
    // An EMPTY seed is not a search: the bare `/sessions` command carries one
    // only because its command edge always passes a trimmed argument.
    if (options?.initialQuery !== undefined && options.initialQuery !== '' && !this.seedApplied && !this.userEdited) {
      this.seedApplied = true
      this.applyingSeed = true
      try {
        this.searchInput.setValue(options.initialQuery)
      } finally {
        this.applyingSeed = false
      }
      this.enterSearch('search')
    }
    this.ensureSelection()
    this.host.requestRender()
  }

  /** Publish ONE accepted official Activity sample for one roster revision.
   *  Every row STATUS and its group membership change IMMEDIATELY: a revoked
   *  answerability must never be painted as a live `Needs attention` row, not
   *  even for one frame. The cursor and the scroll anchor are preserved by
   *  Session id, so an Activity refresh never moves the selection to another
   *  Session. */
  setActivityFacts(input: SessionWorkspaceActivityFacts): void {
    if (this.disposed) return
    // A sample (including a re-published eligibility with its older facts) is
    // valid ONLY for the roster revision it was read from: a late publication
    // must never mix old facts into a newer list.
    if (input.listRevision !== this.snapshot.listRevision) return
    this.activity = input.facts
    this.answerEligibility = input.answerEligibility
    this.activityError = undefined
    this.activitySampleRevision = input.listRevision
    this.applyActivityChange()
  }

  /** A failed Activity sample: ONE visible nonfatal fact; the roster, the
   *  search and Reader stay usable and every activity fact becomes Unknown. */
  activityUnavailable(message: string): void {
    if (this.disposed) return
    this.activity = undefined
    this.activityError = message
    this.activitySampleRevision = this.snapshot.listRevision
    this.applyActivityChange()
  }

  /** Apply ONE official Workspace follow frame. Only the membership projection
   *  and the scope labels change; Session rows stay the read owner's. */
  updateWorkspaces(frame: WorkspaceFactsFrame): void {
    if (this.disposed) return
    this.workspaces = foldWorkspaceFrame(this.workspaces, frame)
    this.recomputeWorkspaceScope()
    this.ensureSelection()
    this.host.requestRender()
  }

  /** A failed/closed Workspace stream is ONE visible state; the Session list
   *  and search stay usable in All and no membership may be claimed. */
  workspaceUnavailable(message: string): void {
    if (this.disposed) return
    this.workspaceError = message
    this.workspaces = { order: [], byId: new Map(), proven: false }
    this.recomputeWorkspaceScope()
    // The stream failure IS the current scope fact. A one-time missing/lost
    // Current fallback that this same open set earlier is now superseded by
    // it; painting both would state two scope facts in one frame.
    if (this.lastNotice === 'current-workspace-unavailable' || this.lastNotice === 'current-workspace-lost') {
      this.lastNotice = undefined
      this.statusMessage = undefined
    }
    this.ensureSelection()
    this.host.requestRender()
  }

  invalidate(): void {
    // A live palette switch changes the Markdown theme's concrete SGR, while
    // Markdown.render caches its already-styled lines by source+width. Drop
    // that cache before the theme-driven repaint; a bare render is not enough.
    const reader = this.reader
    if (reader?.state.kind === 'ready') reader.state.document.invalidate()
    this.searchInput.invalidate()
  }

  dispose(): void {
    this.disposed = true
    const reader = this.reader
    this.reader = undefined
    reader?.controller.abort()
    this.pressed = undefined
    this.closeDirectoryChooser(false)
  }

  // ── Pure view ────────────────────────────────────────────────────────────

  private workspaceFacts(): readonly SessionWorkspaceFact[] {
    const facts: SessionWorkspaceFact[] = []
    for (const workspaceId of this.workspaces.order) {
      const fact = this.workspaces.byId.get(workspaceId)
      if (fact !== undefined) facts.push(fact)
    }
    return facts
  }

  /** The view of the frame being painted; falls back to a fresh build when a
   *  handler asks outside a paint. */
  private frameView(): SessionWorkspaceView {
    return this.paintView ?? this.view()
  }

  private view(priorIdOrder?: readonly string[]): SessionWorkspaceView {
    return buildSessionWorkspaceView({
      rows: this.snapshot.rows,
      activity: this.activity,
      answerEligibility: this.answerEligibility,
      workspaces: this.workspaceFacts(),
      workspaceBaselineProven: this.workspaces.proven,
      scope: { kind: 'all' },
      currentSessionId: this.options.currentSessionId,
      ...(this.options.currentSessionId === undefined && this.nextCreateWorkspaceId !== undefined
        ? { nextCreateWorkspaceId: this.nextCreateWorkspaceId }
        : {}),
      ...(priorIdOrder === undefined ? {} : { priorIdOrder }),
    })
  }

  /** The groups to paint: ALWAYS the live classification. An Activity update
   *  is a fact change, never a deferred animation. */
  private displayGroups(view: SessionWorkspaceView): readonly SessionWorkspaceGroupView[] {
    return view.groups
  }

  /** The ONE reaction to a new Activity sample or a lost eligibility: repaint
   *  the live facts and keep the cursor on its own Session id. */
  private applyActivityChange(): void {
    this.ensureSelection()
    this.host.requestRender()
  }

  /** Re-derive the ONE Current Workspace notice after each official frame. */
  private recomputeWorkspaceScope(): void {
    if (!this.workspaces.proven) return
    const current = currentWorkspaceOf(this.workspaceFacts(), this.options.currentSessionId)
    if (current !== undefined) {
      if (this.lastNotice === 'current-workspace-unavailable' || this.lastNotice === 'current-workspace-lost') {
        this.lastNotice = undefined
        this.statusMessage = undefined
      }
      return
    }
    if (this.options.currentSessionId !== undefined && this.defaultScope === 'current') {
      this.notifyOnce('current-workspace-unavailable', 'Current workspace unavailable — showing all workspaces')
      this.defaultScope = 'all'
    }
  }
  private officialWorkspaceIds(): ReadonlySet<string> {
    return new Set(this.workspaces.byId.keys())
  }

  /** The ONE projected PiTUI tree of this frame: the shared visible official
   *  rows plus only the action rows this open can really reach. */
  private treeRows(view: SessionWorkspaceView = this.view()): readonly PiTuiWorkspaceTreeRow[] {
    const selected = this.treeRowsCache.find(row => row.id === this.selectedBrowseRowId)
    const selectedSessionId = selected?.kind === 'session' ? selected.sessionId : undefined
    const base = visibleWorkspaceBrowserRows(view, {
      expanded: this.workspaceExpanded,
      historyLimit: this.workspaceHistoryLimit,
    }, selectedSessionId, this.options.currentSessionId)
    const rows = projectPiTuiWorkspaceTree(base, this.officialWorkspaceIds(), {
      mode: this.options.initialDirectoryChooser === true ? 'choose-directory' : 'browse',
      canAddDirectory: this.host.onAddDirectory !== undefined,
      canNewSession: this.host.onNewSession !== undefined,
    })
    this.treeRowsCache = rows
    return rows
  }

  private treeRowById(id: string | undefined): PiTuiWorkspaceTreeRow | undefined {
    return id === undefined ? undefined : this.treeRowsCache.find(row => row.id === id)
  }

  private selectedBrowseRow(): PiTuiWorkspaceTreeRow | undefined {
    return this.treeRowById(this.selectedBrowseRowId)
  }

  private selectedBrowseSessionId(): string | undefined {
    const row = this.selectedBrowseRow()
    return row?.kind === 'session' ? row.sessionId : undefined
  }

  private folderRowOf(row: PiTuiWorkspaceTreeRow): PiTuiWorkspaceTreeRow | undefined {
    if (row.kind === 'folder') return row
    if (row.kind === 'addDirectory') return undefined
    return this.treeRowsCache.find(candidate => candidate.kind === 'folder' && candidate.workspaceId === row.workspaceId)
  }

  /** The initial selection from the CURRENT official facts only. */
  private initialBrowseRowId(
    rows: readonly PiTuiWorkspaceTreeRow[],
    view: SessionWorkspaceView,
  ): PiTuiWorkspaceTreeRow['id'] | undefined {
    if (this.options.currentSessionId !== undefined) {
      const current = rows.find(row => row.kind === 'session' && row.sessionId === this.options.currentSessionId)
      if (current !== undefined) return current.id
    }
    const currentFolder = view.currentWorkspaceId === undefined
      ? undefined
      : rows.find(row => row.kind === 'folder' && row.workspaceId === view.currentWorkspaceId)
    if (currentFolder !== undefined) return currentFolder.id
    const nextFolder = view.nextCreateWorkspaceId === undefined
      ? undefined
      : rows.find(row => row.kind === 'folder' && row.workspaceId === view.nextCreateWorkspaceId)
    if (nextFolder !== undefined) return nextFolder.id
    const firstFolder = rows.find(row => row.kind === 'folder')
    if (firstFolder !== undefined) return firstFolder.id
    const add = rows.find(row => row.kind === 'addDirectory')
    if (add !== undefined) return add.id
    return rows[0]?.id
  }

  /** The nearest surviving Folder to a row that disappeared, preferring the
   *  row that used to FOLLOW it (the original visual position). */
  private nearestFolderId(
    previous: readonly PiTuiWorkspaceTreeRow[],
    removedIndex: number,
    rows: readonly PiTuiWorkspaceTreeRow[],
  ): PiTuiWorkspaceTreeRow['id'] | undefined {
    const ids = new Set(rows.map(row => row.id))
    for (let index = removedIndex; index < previous.length; index += 1) {
      const candidate = previous[index]
      if (candidate?.kind === 'folder' && ids.has(candidate.id)) return candidate.id
    }
    for (let index = Math.min(removedIndex, previous.length - 1); index >= 0; index -= 1) {
      const candidate = previous[index]
      if (candidate?.kind === 'folder' && ids.has(candidate.id)) return candidate.id
    }
    return undefined
  }

  /** Keep a surviving typed selection; only a selection that left the visible
   *  tree is re-anchored (a late projection never resets the cursor). */
  private ensureSelection(): void {
    const view = this.view()
    const resultIds = this.snapshot.searchResults.map(result => result.row.id)
    // A Reader pins its OWN Session id. If that Session is no longer listed (a
    // roster refresh, a search change or another Client removing it), the
    // Reader exits to its previous focus and aborts the one read; it must never
    // silently show — or switch to — whatever row the selection re-anchored to.
    if (this.reader !== undefined && !(this.searchMode ? resultIds : view.listIds).includes(this.reader.sessionId)) {
      const returnFocus = this.reader.returnFocus
      this.reader.controller.abort()
      this.reader = undefined
      if (this.focus === 'reader') this.focus = returnFocus
      this.host.requestRender()
    }
    // The full-width Inspector page pins the SAME admitted id. If it leaves the
    // accepted roster/search state, leave the page and run the normal selection
    // fallback — never keep reading a vanished target and never silently swap
    // the page to whatever row the fallback selects.
    const inspectorPage = this.inspectorPage
    if (inspectorPage !== undefined
      && !(inspectorPage.origin === 'search' ? resultIds : view.listIds).includes(inspectorPage.sessionId)) {
      this.inspectorPage = undefined
      if (this.focus === 'inspector') this.focus = inspectorPage.returnFocus
    }
    if (this.searchMode) {
      // The visible rows ARE the Host+metadata results; the browse selection
      // and anchor stay untouched until the user leaves the search.
      if (resultIds.length === 0) {
        this.selectedSearchSessionId = undefined
        return
      }
      if (!resultIds.includes(this.selectedSearchSessionId ?? '')) this.selectedSearchSessionId = resultIds[0]!
      return
    }
    const previous = this.treeRowsCache
    const previousSelection = this.selectedBrowseRowId
    const rows = this.treeRows(view)
    if (rows.some(row => row.id === previousSelection)) {
      // An AUTOMATIC fallback (loading frame / flat pre-baseline roster) yields
      // to the preferred CURRENT Session / next-create / first official Folder
      // once the real tree arrives. A cursor the USER moved is never stolen by
      // a late projection or baseline.
      if (!this.browseSelectionUserOwned) {
        this.selectedBrowseRowId = this.initialBrowseRowId(rows, view)
      }
      return
    }
    let nextId: PiTuiWorkspaceTreeRow['id'] | undefined
    if (previousSelection !== undefined) {
      const previousIndex = previous.findIndex(row => row.id === previousSelection)
      const previousRow = previousIndex < 0 ? undefined : previous[previousIndex]
      const parent = previousRow === undefined ? undefined : this.folderRowOf(previousRow)
      if (parent !== undefined && rows.some(row => row.id === parent.id)) nextId = parent.id
      else if (previousIndex >= 0) nextId = this.nearestFolderId(previous, previousIndex, rows)
    }
    this.selectedBrowseRowId = nextId ?? this.initialBrowseRowId(rows, view)
  }

  private notifyOnce(key: string, message: string): void {
    if (this.lastNotice === key) return
    this.lastNotice = key
    this.statusMessage = message
  }

  // ── Input ───────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.directoryEntryActive) {
      this.handleDirectoryInput(data)
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.handleEscape()
      return
    }
    if (this.focus === 'search') {
      this.handleSearchInput(data)
      return
    }
    if (this.focus === 'reader') {
      this.handleReaderInput(data)
      return
    }
    if (this.focus === 'inspector') {
      this.handleInspectorInput(data)
      return
    }
    if (this.focus === 'search-results') {
      this.handleResultsInput(data)
      return
    }
    this.handleListInput(data)
    this.host.requestRender()
  }

  private handleEscape(): void {
    if (this.focus === 'inspector') {
      this.closeInspector()
      return
    }
    if (this.focus === 'reader') {
      this.closeReader()
      return
    }
    if (this.focus === 'search-results') {
      this.focus = 'search'
      this.host.requestRender()
      return
    }
    if (this.searchMode) {
      this.leaveSearch()
      return
    }
    this.host.onClose()
  }

  /** `Space` opens the ONE full-width Reader of the selected PAINTED Session row only. */
  private openReader(): void {
    if (this.focus !== 'list' && this.focus !== 'search-results') return
    if (this.snapshot.resumePending) return
    const target = this.focus === 'search-results' ? this.selectedSearchSessionId : this.selectedBrowseSessionId()
    if (target === undefined) return
    const painted = this.focus === 'search-results' ? this.lastPaintedResultIds : this.lastPaintedBrowseIds
    if (!painted.includes(target)) return
    const reader: SessionTranscriptReader = {
      sessionId: target,
      returnFocus: this.focus === 'search-results' ? 'search-results' : 'list',
      controller: new AbortController(),
      state: { kind: 'loading' },
      scrollRow: 0,
    }
    this.reader = reader
    this.focus = 'reader'
    this.host.requestRender()
    // A reentrant close during the paint request owns the newer state: the
    // captured Reader is already invalid and must never start its read.
    if (this.reader !== reader || reader.controller.signal.aborted || this.disposed) return
    let pending: Promise<SessionMarkdownReadResult>
    try {
      pending = this.host.readMarkdown(reader.sessionId, reader.controller.signal)
    } catch (error) {
      this.failReader(reader, error)
      return
    }
    pending.then(
      result => this.settleReader(reader, result),
      error => this.failReader(reader, error),
    ).catch(error => this.failReader(reader, error))
  }

  private closeReader(requestRender = true): void {
    const reader = this.reader
    if (reader === undefined) return
    this.reader = undefined
    this.focus = reader.returnFocus
    reader.controller.abort()
    if (requestRender && !this.disposed) this.host.requestRender()
  }

  /** The ONE async currentness fence of the captured Reader object. */
  private readerCurrent(reader: SessionTranscriptReader): boolean {
    if (this.disposed || this.reader !== reader || reader.controller.signal.aborted) return false
    const listed = this.searchMode
      ? this.snapshot.searchResults.map(result => result.row.id)
      : this.view().listIds
    return listed.includes(reader.sessionId)
  }

  private settleReader(reader: SessionTranscriptReader, result: SessionMarkdownReadResult): void {
    if (!this.readerCurrent(reader)) return
    if (result.kind === 'ready') {
      if (result.markdown.length > SESSION_READER_MAX_SOURCE_CODE_UNITS) {
        reader.state = { kind: 'too-large' }
        this.host.requestRender()
        return
      }
      const safe = sanitizeDisplayText(result.markdown)
      reader.state = {
        kind: 'ready',
        document: new Markdown(safe, 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS),
      }
      reader.scrollRow = 0
    } else {
      reader.state = { kind: result.kind }
    }
    this.host.requestRender()
  }

  private failReader(reader: SessionTranscriptReader, error: unknown): void {
    if (!this.readerCurrent(reader)) return
    if (isCancellation(error)) return
    const message = sanitizedPhysicalLine(safeErrorMessage(error))
    reader.state = {
      kind: 'error',
      message: message.length <= SESSION_READER_MAX_ERROR_CODE_UNITS
        ? message
        : `${message.slice(0, SESSION_READER_MAX_ERROR_CODE_UNITS)}…`,
    }
    this.host.requestRender()
  }

  private handleReaderInput(data: string): void {
    const reader = this.reader
    if (reader === undefined) return
    if (matchesKey(data, Key.up)) return this.scrollReader(-1)
    if (matchesKey(data, Key.down)) return this.scrollReader(1)
    if (matchesKey(data, Key.pageUp)) return this.scrollReader(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.scrollReader(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) {
      reader.scrollRow = 0
      return this.host.requestRender()
    }
    if (matchesKey(data, Key.end)) {
      reader.scrollRow = Number.MAX_SAFE_INTEGER
      return this.host.requestRender()
    }
    if (data === ' ' || matchesKey(data, Key.space)) return this.closeReader()
    // Enter is deliberately inert: this surface never resumes, returns or
    // changes the Session from inside the Reader.
  }

  private scrollReader(delta: number): void {
    const reader = this.reader
    if (reader === undefined) return
    reader.scrollRow = Math.max(0, reader.scrollRow + delta)
    this.host.requestRender()
  }

  /** `F2`/the painted Inspect verb opens the ONE read-only Inspector page for
   *  the SAME typed Session row the list already reported. It changes no
   *  selection, starts no read of its own and never resumes a Session. */
  private openInspector(): void {
    if (this.focus !== 'list' && this.focus !== 'search-results') return
    if (this.snapshot.resumePending || this.newSessionPending !== undefined) return
    const target = this.focus === 'search-results' ? this.selectedSearchSessionId : this.selectedBrowseSessionId()
    if (target === undefined) return
    const painted = this.focus === 'search-results' ? this.lastPaintedResultIds : this.lastPaintedBrowseIds
    if (!painted.includes(target)) return
    const page: SessionInspectorPage = {
      sessionId: target,
      origin: this.searchMode ? 'search' : 'browse',
      returnFocus: this.focus === 'search-results' ? 'search-results' : 'list',
      scrollRow: 0,
    }
    this.inspectorPage = page
    this.focus = 'inspector'
    this.host.requestRender()
  }

  private closeInspector(): void {
    const page = this.inspectorPage
    if (page === undefined) return
    this.inspectorPage = undefined
    this.focus = page.returnFocus
    this.host.requestRender()
  }

  /** The Inspector page scrolls its OWN reading body. Enter/Space/F2 are inert:
   *  this page never resumes, returns or writes a Session. */
  private handleInspectorInput(data: string): void {
    const page = this.inspectorPage
    if (page === undefined) return
    if (matchesKey(data, Key.up)) return this.scrollInspectorPage(-1)
    if (matchesKey(data, Key.down)) return this.scrollInspectorPage(1)
    if (matchesKey(data, Key.pageUp)) return this.scrollInspectorPage(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.scrollInspectorPage(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) {
      page.scrollRow = 0
      return this.host.requestRender()
    }
    if (matchesKey(data, Key.end)) {
      page.scrollRow = Number.MAX_SAFE_INTEGER
      return this.host.requestRender()
    }
  }

  private scrollInspectorPage(delta: number): void {
    const page = this.inspectorPage
    if (page === undefined) return
    page.scrollRow = Math.max(0, page.scrollRow + delta)
    this.host.requestRender()
  }

  /** Open the ONE per-open inline Host-directory editor. The initial recovery
   *  path and the user's Add row/mouse entry all share this same entry. */
  private openDirectoryChooser(initialPath?: string): void {
    if (this.directoryChooser !== undefined) return
    this.directoryChooser = new HostDirectoryChooser({
      list: this.host.onListDirectory,
      onChange: () => {
        if (!this.disposed) this.host.requestRender()
      },
    }, initialPath)
    this.focus = 'directory'
    this.directoryChooser.begin()
    this.host.requestRender()
  }

  /** Release the editor and its Host reads. An owner-origin close (a
   *  registered path / the whole panel lease) passes `false` to avoid a paint
   *  request for a surface that is already retiring. */
  private closeDirectoryChooser(requestRender = true): void {
    const chooser = this.directoryChooser
    if (chooser === undefined) return
    this.directoryChooser = undefined
    chooser.dispose()
    this.statusMessage = undefined
    this.directoryStatusError = false
    this.paintedDirectorySuggestionPaths = []
    this.directoryEditorPainted = false
    this.focus = 'list'
    if (requestRender && !this.disposed) this.host.requestRender()
  }

  /** The editor is OPEN exactly when its ONE controller exists. */
  private get directoryEntryActive(): boolean {
    return this.directoryChooser !== undefined
  }

  private handleDirectoryInput(data: string): void {
    const chooser = this.directoryChooser
    if (chooser === undefined || this.directorySubmitting) return
    if (matchesKey(data, Key.escape)) {
      // The FIRST Esc only hides a genuinely painted suggestion block; the
      // second (or the first when nothing was painted) returns to the tree.
      if (this.paintedDirectorySuggestionPaths.length > 0) {
        chooser.hideSuggestions()
        this.host.requestRender()
        return
      }
      this.closeDirectoryChooser()
      return
    }
    if (matchesKey(data, Key.shift(Key.tab))) return
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      // Arrow selection is admitted ONLY against candidates this frame really
      // painted; a logical query result on an unpainted tiny frame is inert.
      if (this.paintedDirectorySuggestionPaths.length === 0) return
      chooser.handleInput(data)
      this.host.requestRender()
      return
    }
    if (matchesKey(data, Key.tab)) {
      const snapshot = chooser.snapshot()
      const selected = snapshot.candidates[snapshot.selectedIndex]
      if (selected === undefined) return
      if (!this.paintedDirectorySuggestionPaths.includes(selected.path)) return
      this.statusMessage = undefined
      this.directoryStatusError = false
      chooser.acceptPaintedCandidate(selected.path)
      this.host.requestRender()
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.handleDirectorySubmit()
      return
    }
    const before = chooser.input.getValue()
    chooser.handleInput(data)
    if (chooser.input.getValue() !== before) {
      this.statusMessage = undefined
      this.directoryStatusError = false
      this.host.requestRender()
    }
  }

  private handleDirectorySubmit(): void {
    if (this.directorySubmitting) return
    // Submit only a path this frame really painted: on a frame too short for
    // the input row, Enter must not verify an unseen/prefilled path.
    if (!this.directoryEditorPainted) return
    const chooser = this.directoryChooser
    if (chooser === undefined) return
    const onAddDirectory = this.host.onAddDirectory
    if (onAddDirectory === undefined) return
    // The value is submitted VERBATIM: a meaningful trailing space/segment is
    // never trimmed into another path. Only empty and a shape that is
    // definitely non-absolute for the KNOWN Host dialect are refused here;
    // while the Host dialect is unknown the Host resolve remains the judge.
    const raw = chooser.input.getValue()
    if (raw.trim() === '') {
      this.statusMessage = 'Enter an absolute Host path.'
      this.directoryStatusError = true
      this.host.requestRender()
      return
    }
    const snapshot = chooser.snapshot()
    if (snapshot.hostHome !== undefined) {
      const query = hostDirectoryQuery(raw, snapshot.hostHome)
      if (query.kind === 'invalid') {
        this.statusMessage = query.reason
        this.directoryStatusError = true
        this.host.requestRender()
        return
      }
      if (query.kind === 'empty') return
    }
    chooser.hideSuggestions()
    this.directorySubmitting = true
    this.statusMessage = undefined
    this.directoryStatusError = false
    this.host.requestRender()
    onAddDirectory(raw, (outcome) => {
      if (this.disposed) return
      this.directorySubmitting = false
      if (outcome.kind === 'registered') {
        this.nextCreateWorkspaceId = outcome.workspaceId
        if (this.options.initialDirectoryChooser === true) {
          this.closeDirectoryChooser(false)
          this.host.onClose()
          return
        }
        this.closeDirectoryChooser(false)
        this.statusMessage = `Directory added: ${outcome.path}`
        this.directoryStatusError = false
      } else {
        // A Host refusal keeps the raw value editable; the chooser was hidden
        // for the pending verification and a real edit queries again.
        this.statusMessage = outcome.message
        this.directoryStatusError = true
      }
      this.host.requestRender()
    })
  }

  private chooserMode(): boolean {
    return this.options.initialDirectoryChooser === true
  }

  /** The ONE Folder-New dispatch: ONE per-operation pending object, settled
   *  only by that operation's own owner callback. A late callback from an
   *  earlier operation/open can never unlock a newer one. */
  private startNewSession(workspaceId: string): void {
    if (this.newSessionPending !== undefined) return
    const pending = { workspaceId }
    this.newSessionPending = pending
    this.host.onNewSession?.(workspaceId, (_outcome) => {
      if (this.disposed) return
      if (this.newSessionPending !== pending) return
      this.newSessionPending = undefined
      this.host.requestRender()
    })
  }

  private handleListInput(data: string): void {
    const rows = this.treeRows()
    if (matchesKey(data, Key.up)) return this.moveBrowseSelection(-1)
    if (matchesKey(data, Key.down)) return this.moveBrowseSelection(1)
    if (matchesKey(data, Key.pageUp)) return this.moveBrowseSelection(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.moveBrowseSelection(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) return this.selectBrowseIndex(0)
    if (matchesKey(data, Key.end)) return this.selectBrowseIndex(rows.length - 1)
    if (matchesKey(data, Key.tab)) return this.jumpWorkspace(1)
    if (matchesKey(data, Key.shift(Key.tab))) return this.jumpWorkspace(-1)
    if (matchesKey(data, Key.right)) return this.expandSelectedFolder()
    if (matchesKey(data, Key.left)) return this.collapseOrParent()
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) return this.activateSelectedBrowseRow()
    if (matchesKey(data, SESSION_WORKSPACE_CHORDS.inspect.keys[0])) {
      this.openInspector()
      return
    }
    if (data === ' ' || matchesKey(data, Key.space)) {
      this.openReader()
      return
    }
    if (data === '/') {
      this.enterSearch('search')
      return
    }
    if (data.length > 0 && !/[\x00-\x1f\x7f]/u.test(data) && !data.includes('\x1b')) {
      this.enterSearch('search')
      this.searchInput.setValue(data)
      this.host.onQueryChange(data)
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      // The safe two-Enter contract: the first Enter only moves focus to the
      // first REAL result; a second Enter from the result list is the resume.
      if (this.snapshot.searchResults.length > 0) {
        this.selectedSearchSessionId = this.snapshot.searchResults[0]!.row.id
        this.focus = 'search-results'
        this.host.requestRender()
      }
      return
    }
    if (matchesKey(data, Key.down)) {
      if (this.snapshot.searchResults.length > 0) {
        this.selectedSearchSessionId = this.snapshot.searchResults[0]!.row.id
        this.focus = 'search-results'
        this.host.requestRender()
      }
      return
    }
    if (matchesKey(data, Key.tab)) {
      // An active query keeps Tab INSIDE the global search (input → results):
      // a browse tab can never hide the Host's global hits. An empty query is
      // the plain browse focus ring, so Tab returns to the Session List.
      if (this.searchInput.getValue() !== '' && this.snapshot.searchResults.length > 0) {
        this.selectedSearchSessionId = this.snapshot.searchResults[0]!.row.id
        this.focus = 'search-results'
        this.host.requestRender()
      } else if (this.searchInput.getValue() === '') {
        this.leaveSearch()
      }
      return
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.leaveSearch()
      return
    }
    const before = this.searchInput.getValue()
    this.searchInput.handleInput(data)
    const after = this.searchInput.getValue()
    if (after === before || this.applyingSeed) return
    this.userEdited = true
    this.host.onQueryChange(after)
  }

  private handleResultsInput(data: string): void {
    const rows = this.snapshot.searchResults
    if (matchesKey(data, Key.up)) return this.moveSelection(-1)
    if (matchesKey(data, Key.down)) return this.moveSelection(1)
    if (matchesKey(data, Key.pageUp)) return this.moveSelection(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.moveSelection(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) return this.selectIndex(0)
    if (matchesKey(data, Key.end)) return this.selectIndex(rows.length - 1)
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      // Search results are flat Session rows: a Folder/Show-more selection
      // that belongs to the browse tree (kept as the browse selection while the
      // user searches) can never absorb the result-list Enter.
      this.resumeSelected()
      return
    }
    if (data === ' ' || matchesKey(data, Key.space)) {
      this.openReader()
      return
    }
    if (matchesKey(data, SESSION_WORKSPACE_CHORDS.inspect.keys[0])) {
      this.openInspector()
      return
    }
    if (matchesKey(data, Key.backspace)) {
      this.focus = 'search'
      this.host.requestRender()
      return
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) {
      this.focus = 'search'
      this.host.requestRender()
    }
  }

  private moveBrowseSelection(delta: number): void {
    const rows = this.treeRows()
    if (rows.length === 0) return
    this.browseSelectionUserOwned = true
    const current = rows.findIndex(row => row.id === this.selectedBrowseRowId)
    const next = Math.min(Math.max(0, (current < 0 ? 0 : current) + delta), rows.length - 1)
    this.selectedBrowseRowId = rows[next]!.id
    this.host.requestRender()
  }

  private selectBrowseIndex(index: number): void {
    const rows = this.treeRows()
    if (rows.length === 0) return
    this.browseSelectionUserOwned = true
    this.selectedBrowseRowId = rows[Math.min(Math.max(0, index), rows.length - 1)]!.id
    this.host.requestRender()
  }

  /** Tab/Shift+Tab: ONE step between Folder TITLES, skipping their children. */
  private jumpWorkspace(direction: 1 | -1): void {
    const rows = this.treeRows()
    const folders = rows.filter((row): row is Extract<PiTuiWorkspaceTreeRow, { kind: 'folder' }> => row.kind === 'folder')
    if (folders.length === 0) return
    this.browseSelectionUserOwned = true
    const selected = this.selectedBrowseRow()
    let index = -1
    if (selected?.kind === 'folder') {
      index = folders.findIndex(folder => folder.id === selected.id)
    } else if (selected !== undefined && selected.kind !== 'addDirectory') {
      index = folders.findIndex(folder => folder.workspaceId === selected.workspaceId)
    }
    if (index < 0) {
      this.selectedBrowseRowId = (direction > 0 ? folders[0]! : folders[folders.length - 1]!).id
    } else {
      this.selectedBrowseRowId = folders[(index + direction + folders.length) % folders.length]!.id
    }
    this.host.requestRender()
  }

  /** Right: expand a collapsed Folder, or enter its first visible child. */
  private expandSelectedFolder(): void {
    const row = this.selectedBrowseRow()
    if (row?.kind !== 'folder') return
    this.browseSelectionUserOwned = true
    if (!row.expanded) {
      this.toggleWorkspace(row.workspaceId)
      return
    }
    const rows = this.treeRows()
    const index = rows.findIndex(candidate => candidate.id === row.id)
    const next = index < 0 ? undefined : rows[index + 1]
    if (next === undefined || next.kind === 'folder') return
    this.selectedBrowseRowId = next.id
    this.host.requestRender()
  }

  /** Left: focus the parent Folder of a child row, or collapse an expanded Folder. */
  private collapseOrParent(): void {
    const row = this.selectedBrowseRow()
    if (row === undefined) return
    this.browseSelectionUserOwned = true
    if (row.kind === 'folder') {
      if (row.expanded) this.toggleWorkspace(row.workspaceId)
      return
    }
    if (row.kind === 'addDirectory') return
    const parent = this.treeRows().find(candidate => candidate.kind === 'folder' && candidate.workspaceId === row.workspaceId)
    if (parent === undefined) return
    this.selectedBrowseRowId = parent.id
    this.host.requestRender()
  }

  private activateSelectedBrowseRow(): void {
    const row = this.selectedBrowseRow()
    if (row === undefined) return
    this.browseSelectionUserOwned = true
    if (!this.lastPaintedTreeIds.includes(row.id)) return
    switch (row.kind) {
      case 'folder':
        if (this.chooserMode() && this.options.currentSessionId === undefined && this.workspaces.byId.has(row.workspaceId)) {
          const workspace = this.workspaces.byId.get(row.workspaceId)!
          // Commit the local selection BEFORE the callback: an owner that closes
          // this panel synchronously must not be overwritten afterwards.
          this.selectedBrowseRowId = row.id
          this.host.onUseDirectory?.(workspace.workspaceId, workspace.path)
          this.host.onClose()
          return
        }
        this.toggleWorkspace(row.workspaceId)
        return
      case 'newSession':
        this.startNewSession(row.workspaceId)
        return
      case 'addDirectory':
        this.openDirectoryChooser()
        return
      case 'showMore':
        this.revealMore(row.workspaceId)
        return
      case 'session':
        this.resumeSelected()
        return
    }
  }

  private toggleWorkspace(workspaceId: string): void {
    this.browseSelectionUserOwned = true
    const folder = this.treeRows().find(row => row.kind === 'folder' && row.workspaceId === workspaceId)
    if (folder?.kind !== 'folder') return
    const expanded = !folder.expanded
    this.workspaceExpanded.set(workspaceId, expanded)
    if (expanded && !this.workspaceHistoryLimit.has(workspaceId)) {
      const view = this.view()
      const isPriority = workspaceId === view.currentWorkspaceId || workspaceId === view.nextCreateWorkspaceId
      this.workspaceHistoryLimit.set(workspaceId, isPriority ? 8 : 5)
    }
    this.selectedBrowseRowId = folder.id
    this.host.requestRender()
  }

  private revealMore(workspaceId: string): void {
    this.browseSelectionUserOwned = true
    const folder = this.treeRows().find(row => row.kind === 'folder' && row.workspaceId === workspaceId)
    const wasExpanded = folder?.kind === 'folder' && folder.expanded
    this.workspaceExpanded.set(workspaceId, true)
    if (!wasExpanded) {
      // Not reachable from the painted tree (Show more only exists on an
      // expanded Folder), but keep the historical one-shot expansion semantics
      // for a direct caller: reveal the shared manual five and stay on More.
      this.workspaceHistoryLimit.set(workspaceId, 5)
      this.selectedBrowseRowId = `more:${workspaceId}`
      this.ensureSelection()
      this.host.requestRender()
      return
    }
    const view = this.view()
    const orderedRecentIds = view.groups
      .find(group => group.workspaceId === workspaceId)?.ids
      .filter(id => view.rowsById.get(id)?.priority === 'recent') ?? []
    const old = this.effectiveHistoryLimit(view, workspaceId)
    const batch = Math.max(5, this.lastPaintedListRows)
    const target = Math.min(orderedRecentIds.length, old + batch)
    const oldTreeIds = new Set(this.treeRows(view).map(row => row.id))
    this.workspaceHistoryLimit.set(workspaceId, target)
    // `Show more` reveals a whole painted list page. Put the typed cursor on the
    // FIRST Session this activation really added: a row the old tree already
    // forced visible (Current/selected) is not a new reveal.
    const newlyPainted = orderedRecentIds.slice(old, target)
      .find(id => !oldTreeIds.has(`session:${id}`))
    this.selectedBrowseRowId = newlyPainted === undefined
      ? (target < orderedRecentIds.length ? `more:${workspaceId}` : `workspace:${workspaceId}`)
      : `session:${newlyPainted}`
    // Keep the old scroll anchor: the NEXT render rebases it to make the new
    // selection visible instead of jumping to the end of the list.
    this.ensureSelection()
    this.host.requestRender()
  }

  private moveSelection(delta: number): void {
    const rows = this.snapshot.searchResults.map(result => result.row.id)
    if (rows.length === 0) return
    const current = rows.findIndex(rowId => rowId === this.selectedSearchSessionId)
    const next = Math.min(Math.max(0, (current < 0 ? 0 : current) + delta), rows.length - 1)
    this.selectIndex(next)
  }

  private selectIndex(index: number): void {
    const rows = this.snapshot.searchResults.map(result => result.row.id)
    if (rows.length === 0) return
    const clamped = Math.min(Math.max(0, index), rows.length - 1)
    this.selectedSearchSessionId = rows[clamped]!
    this.host.requestRender()
  }

  private resumeSelected(): void {
    // Reader Enter is inert. Only the two list surfaces can reach the guarded
    // Open/Return admission, and only through a row this frame really painted.
    if (this.focus !== 'list' && this.focus !== 'search-results') return
    if (this.snapshot.resumePending) return
    const target = this.searchMode
      ? this.selectedSearchSessionId
      : this.selectedBrowseSessionId()
    if (target === undefined) return
    const listed = this.searchMode
      ? this.snapshot.searchResults.map(result => result.row.id)
      : this.view().listIds
    if (!listed.includes(target)) return
    const painted = this.searchMode ? this.lastPaintedResultIds : this.lastPaintedBrowseIds
    if (!painted.includes(target)) return
    // Activating the Session this Browser was opened from returns to it: the
    // Browser closes and the Session, draft, turn and writer stay untouched.
    // This is the SAME guarded admission as a Resume, decided only after the
    // listed/painted gates, and it never emits a Resume intent.
    if (target === this.options.currentSessionId) {
      this.host.onClose()
      return
    }
    this.host.onResume(target)
  }

  // ── Search / selector ───────────────────────────────────────────────────

  private enterSearch(focus: 'search' | 'search-results'): void {
    // The inline Host path editor and the global search are NEVER concurrent:
    // the editor owns the keyboard until Enter/Cancel settles it.
    if (this.directoryEntryActive) return
    if (!this.searchMode) {
      this.searchReturn = { rowId: this.selectedBrowseRowId, treeScrollAnchorId: this.treeScrollAnchorId }
    }
    this.searchMode = true
    this.focus = focus
    this.ensureSelection()
    this.host.requestRender()
  }

  private leaveSearch(): void {
    this.searchMode = false
    this.focus = 'list'
    this.selectedBrowseRowId = this.searchReturn?.rowId
    this.treeScrollAnchorId = this.searchReturn?.treeScrollAnchorId
    this.searchReturn = undefined
    this.ensureSelection()
    this.host.requestRender()
  }

  // ── Mouse (last painted frame only) ─────────────────────────────────────

  private regionAt(x: number, y: number): HitRegion | undefined {
    for (const region of this.hitFrame.regions) {
      if (region.line !== y) continue
      if (x >= region.xStart && x <= region.xEnd) return region
    }
    return undefined
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    const region = this.regionAt(x, y)
    // A wheel-only viewport row is inert for the click path: a press on its
    // blank cells behaves like the previously unpainted background (no press).
    this.pressed = region === undefined || isWheelZone(region.kind)
      ? undefined
      : {
        revision: this.hitFrame.revision,
        kind: region.kind,
        action: region.action,
        id: region.id,
        xStart: region.xStart,
        xEnd: region.xEnd,
        line: region.line,
        rows: this.host.rows(),
        columns: this.host.columns(),
      }
    // Click-to-position on the input this frame really painted. The panel
    // stays the keyboard owner; only the private Input's cursor moves.
    if (region?.kind === 'directory-input' && this.directoryInputDisplaySafe
      && this.directoryChooser !== undefined && !this.directorySubmitting) {
      this.directoryChooser.input.handleMouse({
        type: 'press',
        button: 'left',
        x,
        y: 0,
        screenX: x,
        screenY: y,
        width: this.lastDirectoryInputWidth,
        height: 1,
        shift: false,
        alt: false,
        ctrl: false,
      })
      this.host.requestRender()
    }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressed
    this.pressed = undefined
    if (pressed === undefined) return
    // The frame the user pressed must still be the frame at the release: a
    // scroll/resize/scope/search/Activity/content change between the two halves
    // drops the gesture instead of activating a target that appeared later.
    // A resize that has NOT repainted yet leaves the previous frame revision in
    // place, so the LIVE grant is re-proved too: an old physical cell can never
    // replay a bar action after the terminal moved.
    if (this.host.rows() !== pressed.rows || this.host.columns() !== pressed.columns) return
    if (pressed.revision !== this.hitFrame.revision) return
    const region = this.regionAt(x, y)
    if (region === undefined
      || region.kind !== pressed.kind
      || region.action !== pressed.action
      || region.id !== pressed.id
      || region.xStart !== pressed.xStart
      || region.xEnd !== pressed.xEnd
      || region.line !== pressed.line) return
    this.activateRegion(region)
  }

  /** The ONE wheel-only target the LAST painted frame published under this
   *  cell. A click region that shares the cell is never a wheel source. */
  private wheelZoneAt(x: number, y: number): HitRegion | undefined {
    for (const region of this.hitFrame.regions) {
      if (region.line !== y || !isWheelZone(region.kind)) continue
      if (x >= region.xStart && x <= region.xEnd) return region
    }
    return undefined
  }

  /** Consume every wheel that reaches this leased screen and route only a
   *  valid last-painted pane row onto the pane's EXISTING selection/scroll
   *  method. Primary clicks keep their own `onCellPress`/`onCellClick` pair. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || event.type !== 'wheel') return undefined
    // Every wheel belongs to this leased surface: it is never left to the
    // background Transcript's `routeWheel`, even when it hits no scroll pane.
    const consumed: TuiMouseEventResult = { handled: true, render: false }
    const frame = this.hitFrame
    // Act only on the frame the user really sees: a resize that has not
    // repainted yet, or an event grant that is not this frame's root box,
    // leaves the old hit map inert.
    if (this.host.rows() !== frame.rows
      || this.host.columns() !== frame.columns
      || event.height !== frame.rows
      || event.width !== frame.columns) return consumed
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return consumed
    const zone = this.wheelZoneAt(event.x, event.y)
    if (zone === undefined) return consumed
    switch (zone.kind) {
      case 'wheel-browse':
        if (this.focus !== 'list' || this.searchMode || this.directoryEntryActive) return consumed
        this.pressed = undefined
        this.moveBrowseSelection(delta)
        return consumed
      case 'wheel-results':
        if (!this.searchMode || this.directoryEntryActive
          || (this.focus !== 'search' && this.focus !== 'search-results')) return consumed
        this.pressed = undefined
        this.focus = 'search-results'
        this.moveSelection(delta)
        return consumed
      case 'wheel-reader':
        if (this.focus !== 'reader' || this.reader === undefined || this.reader.state.kind !== 'ready') return consumed
        this.pressed = undefined
        this.scrollReader(delta)
        return consumed
      case 'wheel-inspector':
        this.pressed = undefined
        if (this.focus === 'inspector' && this.inspectorPage !== undefined) this.scrollInspectorPage(delta)
        // The inline Inspector never steals the list's keyboard focus: the wheel
        // scrolls only its own painted body while the typed selection stays put.
        else if (this.focus === 'list' || this.focus === 'search-results') this.scrollInlineInspector(delta)
        return consumed
    }
  }

  private activateRegion(region: HitRegion): void {
    // The inline path editor owns the WHOLE interaction while it is open:
    // a mouse press on a tree row must not start a second operation (New,
    // Add, More, Folder) behind it. While the editor owns the interaction only
    // its OWN input/suggestion targets and the ONE bar's verify/cancel verbs
    // reach their handlers; the verbs stay inert while the Host verification
    // pends.
    if (this.directoryEntryActive) {
      if (this.directorySubmitting) return
      switch (region.kind) {
        case 'directory-input':
          // Cursor positioning already happened on the press half.
          return
        case 'directory-suggestion': {
          if (region.id === undefined) return
          const chooser = this.directoryChooser
          if (chooser === undefined) return
          // Only the candidate this frame really painted may act; its identity
          // is the official full Host path, never a display name/row index.
          if (!this.paintedDirectorySuggestionPaths.includes(region.id)) return
          this.statusMessage = undefined
          this.directoryStatusError = false
          chooser.acceptPaintedCandidate(region.id)
          this.host.requestRender()
          return
        }
        case 'bar-action':
          // The painted Esc verb is the SAME two-layer ladder the key follows:
          // hide a visible suggestion block first, otherwise leave the editor.
          if (region.action === 'verify') this.handleDirectorySubmit()
          else if (region.action === 'cancel') this.handleDirectoryInput('\x1b')
          return
        default:
          return
      }
    }
    switch (region.kind) {
      case 'bar-action': {
        // The bar only re-enters the EXISTING keyboard/currentness path; it
        // never calls a Host intent or writes navigation state directly.
        switch (region.action) {
          case 'close': return this.handleEscape()
          case 'open': return this.resumeSelected()
          case 'peek': return this.openReader()
          case 'inspect': return this.openInspector()
          case 'results': return this.handleSearchInput('\r') // the keyboard Enter byte, same entry
          case 'verify': return this.handleDirectorySubmit()
          case 'cancel': return this.closeDirectoryChooser()
          case 'activate-row': return this.activateSelectedBrowseRow()
        }
        return
      }
      case 'folder-toggle': {
        if (region.id === undefined) return
        this.browseSelectionUserOwned = true
        this.selectedBrowseRowId = `workspace:${region.id}`
        this.toggleWorkspace(region.id)
        return
      }
      case 'tree-row': {
        if (region.id === undefined) return
        this.browseSelectionUserOwned = true
        this.selectedBrowseRowId = region.id
        const row = this.selectedBrowseRow()
        if (row === undefined) return
        // A Session click only selects; Enter is the guarded Resume verb. An
        // explicit New / Add / More click IS its named action, executed only
        // after the selection was committed.
        if (row.kind === 'newSession') this.startNewSession(row.workspaceId)
        else if (row.kind === 'addDirectory') this.openDirectoryChooser()
        else if (row.kind === 'showMore') this.revealMore(row.workspaceId)
        else if (row.kind === 'folder') {
          // The Sessionless Welcome chooses an existing official Workspace; every
          // ordinary Browse Folder title/blank click (and only once) is the same
          // toggle the disclosure and the keyboard Folder verb run.
          if (this.chooserMode() && this.options.currentSessionId === undefined) {
            if (!this.workspaces.byId.has(row.workspaceId)) return
            const workspace = this.workspaces.byId.get(row.workspaceId)!
            this.host.onUseDirectory?.(workspace.workspaceId, workspace.path)
            this.host.onClose()
            return
          }
          this.toggleWorkspace(row.workspaceId)
          return
        }
        break
      }
      case 'result': {
        if (region.id === undefined) return
        this.selectedSearchSessionId = region.id
        this.focus = 'search-results'
        break
      }
      case 'search': {
        this.focus = 'search'
        break
      }
      case 'search-hint': {
        if (this.directoryEntryActive) return
        this.enterSearch('search')
        return
      }
    }
    this.host.requestRender()
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    // Every frame re-establishes which ids are really visible and WHICH CELLS
    // they own: a resize, a status row or a result update can remove the
    // selected row entirely.
    this.lastPaintedBrowseIds = []
    this.lastPaintedTreeIds = []
    this.lastPaintedResultIds = []
    this.lastPaintedInlineInspectorSessionId = undefined
    this.inspectorPagePainted = false
    this.inspectorScrollPainted = false
    this.directoryEditorPainted = false
    this.paintedDirectorySuggestionPaths = []
    this.directoryInputDisplaySafe = true
    const view = this.view(this.paintedGroups.flatMap(group => group.ids))
    this.paintedGroups = view.groups
    this.paintView = view
    const height = Math.max(0, this.host.rows())
    if (height === 0) return this.publishFrame([], [])
    // Refresh the projected tree BEFORE the header/action bar so both state
    // the CURRENT selection's real target.
    this.treeRows(view)
    const header = this.renderHeader(width)
    if (height === 1) return this.publishFrame([header.line], header.regions)
    if (height === 2) {
      // No body row exists: the action bar is built from the EMPTY painted set,
      // so it can never advertise an unpainted activation. It still owns the
      // physical second row, and only the segments really painted there get a
      // hit region.
      const actionBar = this.renderActionBar(width)
      return this.publishFrame(
        [header.line, actionBar.line],
        [...header.regions, ...actionBar.regions.map(region => ({ ...region, line: 1 }))],
      )
    }
    if (height === 3) {
      const body = this.renderBody(width, 1)
      // The footer is built AFTER the body: it only advertises actions the
      // frame really painted/admits.
      const actionBar = this.renderActionBar(width)
      const bodyLine = body.lines[0] ?? this.renderStatusLines(width)[0] ?? ''
      const regions = body.regions
        .filter(region => region.line === 0)
        .map(region => ({ ...region, line: 1 }))
      // Header 0, body 1, the ONE physical Action Bar 2.
      regions.push(...actionBar.regions.map(region => ({ ...region, line: 2 })))
      this.paintView = undefined
      return this.publishFrame([header.line, bodyLine, actionBar.line], regions)
    }
    if (this.focus === 'reader' && height < 6) {
      // A 4/5-row Reader keeps one real body row and the physical Back row. The
      // context line is the first thing to yield so the body is never hidden.
      const lines: string[] = [header.line]
      if (height >= 5) lines.push(this.renderReaderContext(width))
      lines.push(color.border('─'.repeat(Math.max(1, width))))
      const bodyTop = lines.length
      const bodyBudget = Math.max(0, height - lines.length - 1)
      const body = this.renderBody(width, bodyBudget)
      const actionBar = this.renderActionBar(width)
      for (let index = 0; index < bodyBudget; index += 1) lines.push(fit(body.lines[index] ?? '', width))
      const regions = body.regions
        .filter(region => region.line < bodyBudget)
        .map(region => ({ ...region, line: region.line + bodyTop }))
      const barLine = lines.length
      lines.push(actionBar.line)
      regions.push(...actionBar.regions.map(region => ({ ...region, line: barLine })))
      this.paintView = undefined
      return this.publishFrame(lines.slice(0, height), regions)
    }
    const lines: string[] = [header.line]
    const regions: HitRegion[] = [...header.regions]
    // The global search keeps its context line; a plain Browse frame has ONE
    // header and never repeats the Current Session or an All-workspaces scope.
    if (this.focus === 'reader') lines.push(this.renderReaderContext(width))
    else if (this.searchMode) lines.push(this.renderSearchContext(width))
    lines.push(color.border('─'.repeat(Math.max(1, width))))
    // A 4/5-row terminal keeps ONE header line and ONE body row so the Esc row
    // never disappears; from 6 rows both rules fit.
    const bottomLines = height >= 6 ? 2 : 1
    const bodyBudget = Math.max(0, height - lines.length - bottomLines)
    const bodyTop = lines.length
    const body = this.renderBody(width, bodyBudget)
    const actionBar = this.renderActionBar(width)
    for (let index = 0; index < bodyBudget; index += 1) {
      lines.push(fit(body.lines[index] ?? '', width))
    }
    for (const region of body.regions) {
      if (region.line >= bodyBudget) continue
      regions.push({ ...region, line: region.line + bodyTop })
    }
    if (height >= 6) lines.push(color.border('─'.repeat(Math.max(1, width))))
    // The ONE physical last row owns the bar's real painted spans.
    const barLine = lines.length
    lines.push(actionBar.line)
    regions.push(...actionBar.regions.map(region => ({ ...region, line: barLine })))
    this.paintView = undefined
    return this.publishFrame(lines.slice(0, height), regions)
  }

  private renderHeader(width: number): { readonly line: string; readonly regions: readonly HitRegion[] } {
    if (this.focus === 'inspector') {
      // The full-width read-only Inspector names the SAME target it reads and
      // never advertises a second / Search entry behind that page.
      const shortId = this.inspectorPage === undefined
        ? ''
        : ` · ${sanitizedPhysicalLine(shortSessionId(this.inspectorPage.sessionId))}`
      return { line: fit(`${color.textStrong('Session Inspector')}${color.textMuted(shortId)}`, width), regions: [] }
    }
    const title = this.chooserMode() ? 'Choose workspace' : 'Sessions'
    const left = `${color.textStrong(title)}${color.textMuted(` · ${this.snapshot.rows.length}`)}`
    if (this.directoryEntryActive || this.focus === 'reader') {
      // The inline path editor and the Reader each own the keyboard: no visible
      // or clickable / Search target may enter another presentation behind them.
      return { line: fit(left, width), regions: [] }
    }
    const trailing = color.textMuted('/ Search')
    const line = withTrailing(left, trailing, width)
    const regions: HitRegion[] = []
    if (width > visibleWidth(trailing)) {
      regions.push({ kind: 'search-hint', xStart: width - visibleWidth(trailing), xEnd: width - 1, line: 0 })
    }
    return { line, regions }
  }

  /** The fixed Search context row. Its right-hand status is the ONE place the
   *  routine search health is stated, so a loading/unavailable/ready update
   *  never inserts or removes a body row. `Metadata only` observes the CURRENT
   *  UI capability (it is not proof that the user disabled an index, and a
   *  normal Host disconnect can reach it); only a real provider failure is
   *  `Search failed` and it still keeps its own diagnostic status line. */
  private renderSearchContext(width: number): string {
    const snapshot = this.snapshot
    let trailing: string
    if (snapshot.searchState === 'error') {
      trailing = color.error('Search failed')
    } else if (snapshot.searchState === 'unavailable') {
      trailing = color.textMuted('Metadata only')
    } else if (snapshot.searchState === 'loading') {
      trailing = color.textMuted('Searching content…')
    } else if (snapshot.searchState === 'ready' && snapshot.hasMore) {
      trailing = color.textMuted('Refine for more')
    } else {
      trailing = color.textMuted('Esc back')
    }
    const left = color.textDim('Search all workspaces')
    // The status is a complete phrase, never a half word: when both regions
    // cannot fit, keep the left identity and drop the right status entirely.
    if (visibleWidth(left) + 1 + visibleWidth(trailing) > width) {
      return truncateToWidth(left, width, '…', false)
    }
    return withTrailing(left, trailing, width)
  }

  /** The Reader's fixed second line: identity, provenance and read-only scope.
   *  A narrow frame drops WHOLE trailing facts before it slices a word. */
  private renderReaderContext(width: number): string {
    const reader = this.reader
    const identity = sanitizedPhysicalLine(
      reader === undefined ? 'Transcript' : `Transcript · ${shortSessionId(reader.sessionId)}`,
    )
    const full = `${identity} · Committed · Read-only`
    const withReadOnly = `${identity} · Read-only`
    const text = visibleWidth(full) <= width
      ? full
      : visibleWidth(withReadOnly) <= width
        ? withReadOnly
        : visibleWidth(identity) <= width
          ? identity
          : full
    return fit(color.textDim(truncateToWidth(text, width, '…', false)), width)
  }

  /** Compose one body frame: single column, or the wide two-column layout. */
  private renderBody(width: number, budget: number): PaneRender {
    if (budget <= 0) return { lines: [], regions: [] }
    // The Reader and the full-width Inspector page own the WHOLE real body
    // width in every layout: no Browse column, right pane or local action row.
    if (this.focus === 'reader') return this.renderReaderPane(width, budget)
    if (this.focus === 'inspector') return this.renderInspectorPage(width, budget)
    // The inline Host directory editor owns the keyboard and its status/error
    // lines: it keeps the FULL body width instead of being squeezed into the
    // list column. It is a transient editor, not the two-column Browse reading.
    if (this.directoryEntryActive) return this.renderSingleColumn(width, budget)
    if (this.host.rows() < WIDE_MIN_ROWS || width < WIDE_MIN_COLUMNS) {
      return this.renderSingleColumn(width, budget)
    }
    const leftWidth = Math.min(
      Math.max(WIDE_LEFT_MIN_CELLS, Math.floor(width * 0.55)),
      width - 2 - WIDE_RIGHT_MIN_CELLS,
    )
    const rightWidth = width - leftWidth - 2
    if (rightWidth < WIDE_RIGHT_MIN_CELLS) return this.renderSingleColumn(width, budget)
    // The wide layout's FRAME-LEVEL facts (the search editor and the
    // status/error lines) span the whole frame: a long Host refusal must never
    // be truncated to the list column and hand the user half an error.
    const head: string[] = []
    const headRegions: HitRegion[] = []
    if (this.searchMode) {
      this.searchInput.focused = this.focus === 'search'
      head.push(fit(this.searchInput.render(width)[0] ?? '', width))
      headRegions.push({ kind: 'search', xStart: 0, xEnd: Math.max(0, width - 1), line: 0 })
    }
    head.push(...this.renderStatusLines(width))
    const paneBudget = budget - head.length
    // Two columns need a real Inspector identity line plus at least one fact
    // row; a frame squeezed by status lines keeps the plain list.
    if (paneBudget < 2) return this.renderSingleColumn(width, budget)
    const left = this.searchMode
      ? this.renderSearchPane(leftWidth, paneBudget, false)
      : this.renderListPane(leftWidth, paneBudget, false)
    const right = this.renderPreviewPane(rightWidth, paneBudget, width)
    const lines: string[] = [...head]
    const regions: HitRegion[] = [...headRegions, ...left.regions].map(region => ({
      ...region,
      line: region.line + head.length,
    }))
    for (const region of right.regions) {
      regions.push({
        ...region,
        xStart: region.xStart + leftWidth + 2,
        xEnd: region.xEnd + leftWidth + 2,
        line: region.line + head.length,
      })
    }
    for (let index = 0; index < paneBudget; index += 1) {
      const leftLine = left.lines[index] ?? ''
      const rightLine = right.lines[index] ?? ''
      lines.push(`${fit(leftLine, leftWidth)}  ${fit(rightLine, rightWidth)}`)
    }
    return { lines: lines.slice(0, budget), regions }
  }

  private renderSingleColumn(width: number, budget: number): PaneRender {
    if (this.focus === 'reader') return this.renderReaderPane(width, budget)
    return this.searchMode
      ? this.renderSearchPane(width, budget, true)
      : this.renderListPane(width, budget, true)
  }

  /** The ordinary-history watermark a group paints NOW: this open's manual or
   *  automatically raised value, otherwise the shared default (Current/Next
   *  eight, every other Workspace zero). */
  private effectiveHistoryLimit(view: SessionWorkspaceView, workspaceId: string): number {
    return this.workspaceHistoryLimit.get(workspaceId)
      ?? (workspaceId === view.currentWorkspaceId || workspaceId === view.nextCreateWorkspaceId ? 8 : 0)
  }

  /**
   * Spend the REAL free rows of this ORDINARY Browse frame on ordinary history
   * of the groups that are already expanded. The Sessionless `Choose workspace`
   * chooser never calls this: it selects an existing Workspace, so its spare
   * height must not fill with unrelated Session rows. ONE step raises ONE group
   * by one row and is charged the rows it really adds: a Session the shared
   * projection already forces visible (the selected/current one) costs nothing,
   * and finishing a group also drops its `Show more` row. Rounds fill
   * Current/Next first and then rotate the other expanded Folders in official
   * order, so one large Workspace cannot take the whole spare of its siblings.
   * Nothing here expands a collapsed Folder, lowers a watermark, persists state
   * or issues IO: the grown tree is re-projected against the real budget and
   * only then written into the ONE `workspaceHistoryLimit` map (monotone, per
   * open). A cursor the grown tree no longer paints re-anchors through the
   * existing fallback in the same frame, so no invisible target ever survives a
   * growth.
   */
  private growWorkspaceHistory(view: SessionWorkspaceView, listCapacity: number): void {
    if (listCapacity < 1) return
    const base = this.treeRows(view)
    if (base.length >= listCapacity) return
    const selected = base.find(row => row.id === this.selectedBrowseRowId)
    const selectedSessionId = selected?.kind === 'session' ? selected.sessionId : undefined
    const expanded = new Set<string>()
    for (const row of base) {
      if (row.kind === 'folder' && row.expanded) expanded.add(row.workspaceId)
    }
    const recentIds = new Map<string, readonly string[]>()
    for (const group of view.groups) {
      if (!expanded.has(group.workspaceId)) continue
      // Only an already drained watermark skips the roster filter; the real
      // recent count is the ONE growth ceiling, never a fixed automatic cap.
      const ids = group.ids.filter(id => view.rowsById.get(id)?.priority === 'recent')
      if (this.effectiveHistoryLimit(view, group.workspaceId) < ids.length) {
        recentIds.set(group.workspaceId, ids)
      }
    }
    // Current then Next (deduped); every other expanded Folder keeps the
    // official group order.
    const priority: string[] = []
    for (const workspaceId of [view.currentWorkspaceId, view.nextCreateWorkspaceId]) {
      if (workspaceId !== undefined && expanded.has(workspaceId) && !priority.includes(workspaceId)) priority.push(workspaceId)
    }
    const others = view.groups
      .map(group => group.workspaceId)
      .filter(workspaceId => !priority.includes(workspaceId))
    // Frame-local scratch: the ONE watermark map is written only after the real
    // projection proved that the whole tree still fits this frame.
    const trial = new Map<string, number>()
    let free = listCapacity - base.length
    const step = (workspaceId: string): boolean => {
      const ids = recentIds.get(workspaceId)
      if (ids === undefined) return false
      const limit = trial.get(workspaceId) ?? this.effectiveHistoryLimit(view, workspaceId)
      if (limit >= ids.length) return false
      const forced = ids[limit] === this.options.currentSessionId || ids[limit] === selectedSessionId
      const removesMore = limit + 1 === ids.length
      const delta = (forced ? 0 : 1) - (removesMore ? 1 : 0)
      if (delta > free) return false
      trial.set(workspaceId, limit + 1)
      free -= delta
      return true
    }
    for (;;) {
      let grew = false
      for (const workspaceId of priority) if (step(workspaceId)) grew = true
      if (grew) continue
      for (const workspaceId of others) if (step(workspaceId)) grew = true
      if (!grew) break
    }
    if (trial.size === 0) return
    const limits = new Map(this.workspaceHistoryLimit)
    for (const [workspaceId, limit] of trial) limits.set(workspaceId, limit)
    const finalRows = projectPiTuiWorkspaceTree(
      visibleWorkspaceBrowserRows(view, { expanded: this.workspaceExpanded, historyLimit: limits }, selectedSessionId, this.options.currentSessionId),
      this.officialWorkspaceIds(),
      {
        mode: this.options.initialDirectoryChooser === true ? 'choose-directory' : 'browse',
        canAddDirectory: this.host.onAddDirectory !== undefined,
        canNewSession: this.host.onNewSession !== undefined,
      },
    )
    if (finalRows.length > listCapacity) return
    for (const [workspaceId, limit] of trial) {
      this.workspaceHistoryLimit.set(workspaceId, Math.max(this.workspaceHistoryLimit.get(workspaceId) ?? 0, limit))
    }
    // A growth can exhaust the very `Show more` row the cursor sits on. Re-anchor
    // in THIS frame through the existing fallback (its parent Folder, then the
    // nearest survivor) instead of leaving a selection no painted row can own.
    if (!finalRows.some(row => row.id === this.selectedBrowseRowId)) this.ensureSelection()
  }

  /** The wheel-only rows of ONE pane viewport. They are appended to the SAME
   *  hit map AFTER every click target, so the click priority of a painted row,
   *  result, bar or editor target is unchanged. */
  private wheelZoneRegions(kind: WheelZoneKind, from: number, to: number, width: number): HitRegion[] {
    const regions: HitRegion[] = []
    const xEnd = Math.max(0, width - 1)
    for (let line = from; line < to; line += 1) {
      regions.push({ kind, xStart: 0, xEnd, line })
    }
    return regions
  }

  private renderListPane(width: number, budget: number, chrome: boolean): PaneRender {
    const view = this.frameView()
    // The ONE automatic watermark growth happens HERE, on the ORDINARY Browse
    // list, before this frame's rows are decided: the Sessionless Choose
    // workspace chooser, Search, Reader and the Host editor never move it, and the
    // wide layout already charged its global status lines against the pane
    // budget (so only the single column pays `chrome`).
    if (!this.searchMode && !this.chooserMode() && this.focus === 'list' && !this.directoryEntryActive && !this.disposed && this.workspaces.proven) {
      const listCapacity = Math.max(0, budget - (chrome ? this.renderStatusLines(width).length : 0))
      this.growWorkspaceHistory(view, listCapacity)
    }
    const rows = this.treeRows(view)
    const lines: string[] = []
    const regions: HitRegion[] = []
    // While the inline path editor is open it owns the frame's error/status
    // facts: the generic list statuses must not squeeze the Add row and the
    // input off a short frame.
    if (chrome && !this.directoryEntryActive) lines.push(...this.renderStatusLines(width))
    if (lines.length >= budget) return { lines: lines.slice(0, budget), regions }
    // The real list viewport starts after the painted status rows: only these
    // body rows (painted items and their trailing blank) accept the wheel.
    const listTop = lines.length
    const editorActive = this.directoryEntryActive
    const addIndex = rows.findIndex(row => row.kind === 'addDirectory')
    if (editorActive) {
      const remaining = budget - lines.length
      // A tiny frame prefers the ACTUAL editable path line over the decorative
      // root Add row: the user must never press Enter on an unseen path.
      if (remaining === 1) {
        this.paintDirectoryInputLine(width, lines, regions)
        this.lastPaintedListRows = 1
        return { lines: lines.slice(0, budget), regions }
      }
      // Without a root Add row (non-production composition) still paint the
      // editor directly instead of leaving it invisible but submit-capable.
      if (addIndex < 0 && remaining > 0) {
        this.paintDirectoryEditor(width, budget, lines, regions)
        this.lastPaintedListRows = 1
        return { lines: lines.slice(0, budget), regions }
      }
    }
    let offset: number
    if (editorActive && addIndex >= 0) {
      // The inline path editor stays directly under the root Add row.
      offset = addIndex
    } else {
      const capacity = Math.max(1, budget - lines.length)
      const anchorIndex = this.treeScrollAnchorId === undefined ? -1 : rows.findIndex(row => row.id === this.treeScrollAnchorId)
      const base = anchorIndex >= 0 ? anchorIndex : this.treeScrollOffset
      const selectedIndex = rows.findIndex(row => row.id === this.selectedBrowseRowId)
      offset = rebaseOffset(base, selectedIndex, rows.length, capacity)
    }
    offset = Math.min(Math.max(0, offset), Math.max(0, rows.length - 1))
    const visibleRows = rows.slice(offset)
    let painted = 0
    for (const entry of visibleRows) {
      if (lines.length >= budget) break
      if (!this.paintTreeRow(entry, width, lines, regions)) continue
      painted += 1
      if (entry.kind === 'addDirectory' && editorActive) {
        this.paintDirectoryEditor(width, budget, lines, regions)
      }
    }
    this.treeScrollOffset = offset
    this.treeScrollAnchorId = visibleRows[0]?.id ?? this.treeScrollAnchorId
    this.lastPaintedListRows = Math.max(1, painted)
    // The inline Host-directory editor owns the body while it is open: its
    // rows are never a wheel sink. Otherwise the WHOLE painted list viewport
    // (painted item rows and its trailing blank) is the wheel target.
    if (!editorActive && rows.length > 0) {
      regions.push(...this.wheelZoneRegions('wheel-browse', listTop, budget, width))
    }
    return { lines: lines.slice(0, budget), regions }
  }

  /** Paint ONE visible tree row and its REAL cell regions. */
  private paintTreeRow(
    entry: PiTuiWorkspaceTreeRow,
    width: number,
    lines: string[],
    regions: HitRegion[],
  ): boolean {
    const line = lines.length
    const selected = this.selectedBrowseRowId === entry.id
    const marker = selected ? color.primary('> ') : '  '
    if (entry.kind === 'addDirectory') {
      lines.push(fit(`${marker}${selected ? color.textStrong('Add directory') : color.text('Add directory')}`, width))
      regions.push({ kind: 'tree-row', id: entry.id, xStart: 0, xEnd: Math.max(0, width - 1), line })
      this.lastPaintedTreeIds.push(entry.id)
      return true
    }
    if (entry.kind === 'folder') {
      const disclosure = entry.expanded ? color.textDim('▾ ') : color.textDim('▸ ')
      const label = sanitizedPhysicalLine(`${entry.title} · ${entry.total}`)
      const suffix = entry.current ? ' · Current' : entry.next ? ' · Next' : ''
      // Trustworthy Needs/Working counts are an independent right-hand fact
      // group, so a long title can never hide a non-zero count. Zero counts are
      // not facts worth displacing the Folder identity: a healthy 0/0 Folder
      // omits the whole group, and a mixed positive/zero row drops the zero
      // segment before the otherwise-fitting label is truncated.
      const countParts: ReadonlyArray<{ readonly text: string; readonly paint: (text: string) => string; readonly nonzero: boolean }> = [
        { text: `${entry.needs} Needs`, paint: entry.needs > 0 ? color.warning : color.textMuted, nonzero: entry.needs > 0 },
        { text: `${entry.working} Working`, paint: entry.working > 0 ? color.primary : color.textMuted, nonzero: entry.working > 0 },
      ]
      const paintCounts = (parts: readonly typeof countParts[number][]): string =>
        parts.map(part => part.paint(part.text)).join(color.textMuted(' · '))
      const bothCounts = paintCounts(countParts)
      const nonzeroCounts = paintCounts(countParts.filter(part => part.nonzero))
      const available = Math.max(1, width - 4)
      const identity = `${label}${suffix}`
      // Show the zero-bearing pair only when the complete identity still fits;
      // otherwise a non-zero-only group wins before the label loses its tail.
      const counts = nonzeroCounts === ''
        ? ''
        : visibleWidth(bothCounts) + 2 + visibleWidth(identity) <= available
          ? bothCounts
          : nonzeroCounts
      const identityBudget = Math.max(0, available - (counts === '' ? 0 : visibleWidth(counts) + 2))
      // Current/Next is a Folder identity fact: reserve it whole before the
      // mutable title/total tail yields on a narrow row.
      const suffixWidth = visibleWidth(suffix)
      const suffixText = suffixWidth <= identityBudget ? color.textMuted(suffix) : ''
      const labelBudget = Math.max(0, identityBudget - visibleWidth(suffixText))
      const paintedLabel = truncateToWidth(label, labelBudget, '…', false)
      const paintedIdentity = `${selected ? color.textStrong(paintedLabel) : color.text(paintedLabel)}${suffixText}`
      lines.push(fit(
        `${marker}${disclosure}${padColumn(paintedIdentity, identityBudget)}${counts === '' ? '' : `  ${counts}`}`,
        width,
      ))
      // The disclosure owns its two cells; a click on the label only selects.
      if (width > 2) regions.push({ kind: 'folder-toggle', id: entry.workspaceId, xStart: 2, xEnd: Math.min(width - 1, 3), line })
      regions.push({ kind: 'tree-row', id: entry.id, xStart: 0, xEnd: Math.max(0, width - 1), line })
      this.lastPaintedTreeIds.push(entry.id)
      return true
    }
    if (entry.kind === 'newSession') {
      lines.push(fit(`${marker}  ${color.textMuted('+ ')}${selected ? color.textStrong('New session') : color.text('New session')}`, width))
      regions.push({ kind: 'tree-row', id: entry.id, xStart: 0, xEnd: Math.max(0, width - 1), line })
      this.lastPaintedTreeIds.push(entry.id)
      return true
    }
    if (entry.kind === 'showMore') {
      const label = `Show more sessions · ${entry.remaining} remaining`
      lines.push(fit(`${marker}    ${selected ? color.textStrong(label) : color.textMuted(label)}`, width))
      regions.push({ kind: 'tree-row', id: entry.id, xStart: 0, xEnd: Math.max(0, width - 1), line })
      this.lastPaintedTreeIds.push(entry.id)
      return true
    }
    const row = this.snapshot.rows.find(candidate => candidate.id === entry.sessionId)
    const fact = this.frameView().rowsById.get(entry.sessionId)
    if (row === undefined || fact === undefined) return false
    lines.push(this.browseRowLine(row, fact, selected, width))
    regions.push({ kind: 'tree-row', id: entry.id, xStart: 0, xEnd: Math.max(0, width - 1), line })
    this.lastPaintedBrowseIds.push(entry.sessionId)
    this.lastPaintedTreeIds.push(entry.id)
    return true
  }

  /** Paint the editable Host path line exactly once for this frame. */
  private paintDirectoryInputLine(width: number, lines: string[], regions: HitRegion[]): void {
    const chooser = this.directoryChooser
    if (chooser === undefined) return
    chooser.input.focused = !this.directorySubmitting
    const row = lines.length
    const projected = projectInputLine(chooser.input.render(width)[0] ?? '', width, chooser.input.getValue())
    this.directoryInputDisplaySafe = projected.safe
    lines.push(projected.line)
    this.directoryEditorPainted = true
    this.lastDirectoryInputWidth = width
    regions.push({ kind: 'directory-input', xStart: 0, xEnd: Math.max(0, width - 1), line: row })
  }

  /**
   * The inline Host editor block: the real Input, the Host home/prefix
   * suggestion state, up to eight bounded candidate rows and the verbs this
   * frame can really execute. Every row is admission-checked against what was
   * physically painted; a dropped row is never a Tab/mouse target.
   */
  private paintDirectoryEditor(width: number, budget: number, lines: string[], regions: HitRegion[]): void {
    const chooser = this.directoryChooser
    if (chooser === undefined || lines.length >= budget) return
    this.paintDirectoryInputLine(width, lines, regions)
    if (lines.length >= budget) return
    if (this.directorySubmitting) {
      lines.push(color.textMuted(fit('Verifying directory…', width)))
      return
    }
    const snapshot = chooser.snapshot()
    const notices = this.directoryStatusExtras()
    let remaining = budget - lines.length
    if (remaining <= 0) return
    if (snapshot.status !== 'ready' || snapshot.hidden) {
      const message = snapshot.message
        ?? (snapshot.status === 'loading' ? 'Reading Host directories…' : undefined)
      if (message !== undefined) {
        const paint = snapshot.status === 'failed' || snapshot.status === 'unavailable' || snapshot.status === 'error'
          ? color.error
          : color.textMuted
        lines.push(paint(fit(sanitizedPhysicalLine(message), width)))
        remaining -= 1
      }
      this.paintDirectoryStatus(width, lines, notices, remaining)
      return
    }
    const truncatedLine = 'Directory listing truncated; type a more specific path'
    if (snapshot.totalMatches === 0) {
      const empty = snapshot.listingEntryCount === 0
        ? 'No child directories'
        : 'No matching child directories'
      lines.push(color.textMuted(fit(empty, width)))
      remaining -= 1
      if (snapshot.truncated && remaining > 0) {
        lines.push(color.warning(fit(truncatedLine, width)))
        remaining -= 1
      }
      this.paintDirectoryStatus(width, lines, notices, remaining)
      return
    }
    const hasExtras = notices.length > 0 || snapshot.truncated
    const reserveHint = remaining >= 3 && !hasExtras ? 1 : 0
    const candidateBudget = Math.max(1, remaining - reserveHint)
    const showHeader = candidateBudget >= (snapshot.truncated ? 3 : 2)
    const headerCost = showHeader ? 1 : 0
    const reserveTruncated = snapshot.truncated && candidateBudget - headerCost >= 2 ? 1 : 0
    const candidateRows = Math.max(1, Math.min(
      HOST_DIRECTORY_SUGGESTION_LIMIT,
      snapshot.totalMatches,
      candidateBudget - headerCost - reserveTruncated,
    ))
    if (showHeader) {
      lines.push(color.textMuted(fit('Suggestions (Host)', width)))
      remaining -= 1
    }
    const candidates = chooser.visibleSuggestions(candidateRows)
    const view = chooser.snapshot()
    for (let index = 0; index < candidates.length && lines.length < budget; index += 1) {
      const candidate = candidates[index]!
      const selected = index === view.selectedIndex
      const marker = selected ? color.primary('> ') : '  '
      const text = `${sanitizedPhysicalLine(candidate.name)}${view.separator!}`
      const painted = selected
        ? color.textStrong(text)
        : candidate.hidden ? color.textDim(text) : color.text(text)
      const row = lines.length
      lines.push(fit(`  ${marker}${painted}`, width))
      this.paintedDirectorySuggestionPaths.push(candidate.path)
      regions.push({ kind: 'directory-suggestion', id: candidate.path, xStart: 0, xEnd: Math.max(0, width - 1), line: row })
    }
    remaining = budget - lines.length
    if (snapshot.truncated && remaining > 0) {
      lines.push(color.warning(fit(truncatedLine, width)))
      remaining -= 1
    }
    this.paintDirectoryStatus(width, lines, notices, remaining)
  }

  /** The real status/notice rows beside the editor. The VERBS live on the ONE
   *  physical Action Bar, so this paints no second action row and registers no
   *  confirm/cancel region: a status line is never a clickable affordance. */
  private paintDirectoryStatus(
    width: number,
    lines: string[],
    extras: ReadonlyArray<{ readonly text: string; readonly error: boolean }>,
    remaining: number,
  ): void {
    for (const extra of extras) {
      if (remaining <= 0) return
      const paint = extra.error ? color.error : color.textMuted
      lines.push(paint(fit(sanitizedPhysicalLine(extra.text), width)))
      remaining -= 1
    }
  }

  /** The real status/notice lines this editor owns beside its verbs. A Host
   *  refusal of THIS verification and the app-owned failure that led here are
   *  both real facts; the notice is deduped only against the same text. */
  private directoryStatusExtras(): Array<{ readonly text: string; readonly error: boolean }> {
    const lines: Array<{ readonly text: string; readonly error: boolean }> = []
    if (this.statusMessage !== undefined) lines.push({ text: this.statusMessage, error: this.directoryStatusError })
    const notice = this.host.notice()
    if (notice !== undefined
      && (this.statusMessage === undefined || notice.text !== sanitizedPhysicalLine(this.statusMessage))) {
      lines.push({ text: notice.text, error: notice.kind === 'error' })
    }
    return lines
  }

  private renderSearchPane(width: number, budget: number, chrome: boolean): PaneRender {
    const lines: string[] = []
    const regions: HitRegion[] = []
    if (chrome) {
      this.searchInput.focused = this.focus === 'search'
      const inputLine = fit(this.searchInput.render(width)[0] ?? '', width)
      regions.push({ kind: 'search', xStart: 0, xEnd: Math.max(0, width - 1), line: 0 })
      lines.push(inputLine)
      lines.push(...this.renderStatusLines(width))
    }
    const rowBudget = budget - lines.length
    if (rowBudget <= 0) return { lines: lines.slice(0, budget), regions }
    this.lastPaintedListRows = Math.max(1, rowBudget)
    const rows = this.snapshot.searchResults
    if (rows.length === 0) {
      // ONE inert fact row, never a fake `result` target. It states exactly the
      // current stage: roster pending/unavailable/empty, typing not started,
      // content still pending, or the metadata-only/complete no-match result.
      const listState = this.snapshot.listState
      let emptyText: string
      if (listState === 'loading') {
        emptyText = 'Loading sessions…'
      } else if (listState === 'error' || listState === 'unavailable') {
        emptyText = 'Session list unavailable'
      } else if (listState === 'empty') {
        emptyText = 'No readable sessions'
      } else if (this.searchInput.getValue().trim() === '') {
        emptyText = 'Type to search sessions and messages'
      } else if (this.snapshot.searchState === 'loading') {
        emptyText = 'Searching message content…'
      } else if (this.snapshot.searchState === 'unavailable' || this.snapshot.searchState === 'error') {
        emptyText = 'No metadata matches'
      } else if (this.snapshot.searchState === 'ready') {
        emptyText = 'No matching sessions'
      } else {
        emptyText = 'Type to search sessions and messages'
      }
      lines.push(fit(truncateToWidth(color.textDim(sanitizedPhysicalLine(emptyText)), width, '…', false), width))
      return { lines: lines.slice(0, budget), regions }
    }
    // The wheel viewport is the real RESULT list: the Search Input and status
    // rows are above it and are never a wheel sink.
    const resultsTop = lines.length
    const selectedIndex = Math.max(0, rows.findIndex(result => result.row.id === this.selectedSearchSessionId))
    this.resultScroll = rebaseOffset(this.resultScroll, selectedIndex, rows.length, rowBudget)
    const visible = rows.slice(this.resultScroll, this.resultScroll + rowBudget)
    for (const result of visible) {
      if (lines.length >= budget) break
      regions.push({ kind: 'result', id: result.row.id, xStart: 0, xEnd: Math.max(0, width - 1), line: lines.length })
      this.lastPaintedResultIds.push(result.row.id)
      lines.push(this.searchRowLine(result, result.row.id === this.selectedSearchSessionId, width))
    }
    regions.push(...this.wheelZoneRegions('wheel-results', resultsTop, budget, width))
    return { lines: lines.slice(0, budget), regions }
  }

  /** The wide layout's right-hand read-only Inspector of the TYPED Session. */
  private renderPreviewPane(width: number, budget: number, terminalWidth: number): PaneRender {
    const lines: string[] = []
    if (this.searchMode) {
      const result = this.selectedSearchSessionId === undefined
        ? undefined
        : this.snapshot.searchResults.find(candidate => candidate.row.id === this.selectedSearchSessionId)
      if (result === undefined) {
        lines.push(color.textMuted('No result selected'))
        return { lines: lines.slice(0, budget), regions: [] }
      }
      const row = result.row
      // Keep the accepted Host hit's provenance beside the SAME Inspector read:
      // the excerpt is display-only and never starts another read.
      const provenance: string[] = [`${color.textDim('Match: ')}${color.text(result.source)}`]
      if (result.snippet !== undefined) {
        provenance.push(color.textDim('Excerpt:'))
        const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(result.snippet), width)
        for (let index = 0; index < Math.min(3, wrapped.length); index += 1) {
          const excerptLine = index === 2 && wrapped.length > 3
            ? `${truncateToWidth(wrapped[index]!, Math.max(0, width - 1), '', false)}…`
            : truncateToWidth(wrapped[index]!, width, '…', false)
          provenance.push(color.text(excerptLine))
        }
      }
      // Keep at most the provenance plus the fixed Inspector identity; a tiny
      // pane never slices the excerpt into an unreadable fragment first.
      const reserve = Math.min(provenance.length, Math.max(0, budget - 2))
      const inspector = this.renderInspectorPaneLines(
        row.id,
        'search',
        width,
        Math.max(1, budget - reserve),
        terminalWidth,
        false,
      )
      return {
        lines: [...inspector.lines, ...provenance].slice(0, budget),
        regions: inspector.regions,
      }
    }
    const row = this.selectedBrowseRow()
    if (row === undefined) {
      lines.push(color.textMuted('No row selected'))
      return { lines: lines.slice(0, budget), regions: [] }
    }
    switch (row.kind) {
      case 'folder': {
        const official = this.workspaces.byId.has(row.workspaceId)
        lines.push(color.textStrong(truncateToWidth(sanitizedPhysicalLine(row.title), width, '…', false)))
        if (row.path !== '' && official) {
          lines.push(color.textDim(truncateToWidth(`Path: ${sanitizedPhysicalLine(row.path)}`, width, '…', false)))
        }
        lines.push(color.textDim(truncateToWidth(`Sessions: ${row.total}`, width, '…', false)))
        lines.push(color.textDim(truncateToWidth(`Needs attention: ${row.needs}`, width, '…', false)))
        lines.push(color.textDim(truncateToWidth(`Working: ${row.working}`, width, '…', false)))
        if (row.current) lines.push(color.textMuted(truncateToWidth('Current Workspace', width, '…', false)))
        if (row.next) lines.push(color.textMuted(truncateToWidth('Next session destination', width, '…', false)))
        if (!official) {
          lines.push(color.textMuted(truncateToWidth('Synthetic group · not an official Workspace', width, '…', false)))
          lines.push(color.textMuted(truncateToWidth('New session is unavailable here', width, '…', false)))
        } else if (this.chooserMode() && this.options.currentSessionId === undefined) {
          lines.push(color.textMuted(truncateToWidth('Enter Choose workspace · Right expands', width, '…', false)))
        } else {
          lines.push(color.textMuted(truncateToWidth(`Enter ${row.expanded ? 'Collapse' : 'Expand'} · Right expands`, width, '…', false)))
        }
        return { lines: lines.slice(0, budget), regions: [] }
      }
      case 'newSession': {
        const workspace = this.workspaces.byId.get(row.workspaceId)
        lines.push(color.textStrong(truncateToWidth(sanitizedPhysicalLine(workspace?.title ?? 'Workspace'), width, '…', false)))
        if (workspace !== undefined) {
          lines.push(color.textDim(truncateToWidth(`Path: ${sanitizedPhysicalLine(workspace.path)}`, width, '…', false)))
        }
        lines.push(color.textMuted(truncateToWidth('Create a fresh session in this Workspace', width, '…', false)))
        lines.push(color.textMuted(truncateToWidth(
          this.newSessionPending === undefined ? 'Enter New session' : 'Starting session…',
          width, '…', false,
        )))
        return { lines: lines.slice(0, budget), regions: [] }
      }
      case 'addDirectory': {
        lines.push(color.textStrong('Add directory'))
        const chooser = this.directoryChooser
        if (chooser !== undefined) {
          const snapshot = chooser.snapshot()
          lines.push(color.textMuted(truncateToWidth('Host directories · read only', width, '…', false)))
          if (snapshot.hostHome !== undefined) {
            lines.push(color.textDim(truncateToWidth(`Host home: ${sanitizedPhysicalLine(snapshot.hostHome)}`, width, '…', false)))
          }
          if (this.directorySubmitting) {
            lines.push(color.textMuted(truncateToWidth('Verifying directory…', width, '…', false)))
          } else if (this.directoryEditorPainted) {
            // The Preview promises the SAME Esc step the body and the Action
            // Bar already paint: candidates first fold, then the editor closes.
            const escape = this.paintedDirectorySuggestionPaths.length > 0
              ? 'Esc Hide suggestions'
              : 'Esc Cancel'
            lines.push(color.textMuted(truncateToWidth(`Enter Verify directory · ${escape}`, width, '…', false)))
          }
        } else {
          lines.push(color.textMuted(truncateToWidth('Register an existing directory on the Host', width, '…', false)))
          lines.push(color.textMuted(truncateToWidth('No directory has been verified yet', width, '…', false)))
          lines.push(color.textMuted(truncateToWidth('Enter Add directory', width, '…', false)))
        }
        return { lines: lines.slice(0, budget), regions: [] }
      }
      case 'showMore': {
        lines.push(color.textStrong('Show more sessions'))
        lines.push(color.textDim(truncateToWidth(`${row.remaining} more history rows`, width, '…', false)))
        lines.push(color.textMuted(truncateToWidth('Enter reveals the next batch', width, '…', false)))
        return { lines: lines.slice(0, budget), regions: [] }
      }
      case 'session': {
        return this.renderInspectorPaneLines(row.sessionId, 'browse', width, budget, terminalWidth, true)
      }
    }
  }

  /** The shared display view of ONE admitted Inspector target. The row comes
   *  from the SAME accepted Browse roster/Search results the selection uses, and
   *  a cut for another id is never presented as this target's data. */
  private inspectorViewFor(sessionId: string, origin: 'browse' | 'search'): SessionInspectorView | undefined {
    const result = origin === 'search'
      ? this.snapshot.searchResults.find(candidate => candidate.row.id === sessionId)
      : undefined
    const row = result?.row
      ?? (origin === 'browse' ? this.snapshot.rows.find(candidate => candidate.id === sessionId) : undefined)
    if (row === undefined) return undefined
    return buildSessionInspectorView({
      row,
      fact: this.frameView().rowsById.get(sessionId),
      inspector: this.snapshot.inspector?.sessionId === sessionId ? this.snapshot.inspector : undefined,
      workspaces: this.workspaceFacts(),
      workspaceBaselineProven: this.workspaces.proven,
      currentSessionId: this.options.currentSessionId,
      ...(result === undefined || result.snippet === undefined
        ? {}
        : { excerpt: { source: result.source, snippet: result.snippet } }),
    })
  }

  /** The ONE fixed status sentence of a loading/refreshing/failed Inspector. */
  private inspectorNotice(view: SessionInspectorView, width: number): string {
    const text = truncateToWidth(view.notice, width, '…', false)
    return view.state === 'error' ? color.error(text) : color.textMuted(text)
  }

  /** Paint one fact block: its muted label then the complete wrapped value. */
  private inspectorFactBlock(fact: SessionInspectorFact, width: number): string[] {
    const label = truncateToWidth(fact.label, Math.max(1, width - 2), '…', false)
    const labelCells = visibleWidth(label)
    const valueWidth = Math.max(1, width - labelCells - 1)
    const wrapped = wrapTextWithAnsi(fact.value, valueWidth)
    if (wrapped.length === 0) return [fit(color.textMuted(label), width)]
    return wrapped.map((line, index) => index === 0
      ? fit(`${color.textMuted(label)} ${color.text(line)}`, width)
      : fit(`${' '.repeat(labelCells + 1)}${color.text(line)}`, width))
  }

  /** Paint a group's facts one per row, or two COMPLETE facts side by side when
   *  both fit their half untouched; a fact that must wrap takes the full width. */
  private inspectorFactLines(
    facts: readonly SessionInspectorFact[],
    width: number,
    twoPerRow: boolean,
  ): string[] {
    if (!twoPerRow) return facts.flatMap(fact => this.inspectorFactBlock(fact, width))
    const lines: string[] = []
    const half = Math.max(1, Math.floor((width - 3) / 2))
    for (let index = 0; index < facts.length; index += 2) {
      const first = facts[index]!
      const second = facts[index + 1]
      if (second === undefined) {
        lines.push(...this.inspectorFactBlock(first, width))
        continue
      }
      const left = this.inspectorFactBlock(first, half)
      const right = this.inspectorFactBlock(second, half)
      if (left.length === 1 && right.length === 1) {
        lines.push(`${padColumn(left[0]!, half)}   ${right[0]!}`)
        continue
      }
      lines.push(...this.inspectorFactBlock(first, width))
      lines.push(...this.inspectorFactBlock(second, width))
    }
    return lines
  }

  /** The complete reading lines of the shared Inspector groups. */
  private inspectorGroupLines(
    groups: readonly SessionInspectorGroup[],
    width: number,
    twoPerRow: boolean,
    includeExcerpt: boolean,
  ): string[] {
    const lines: string[] = []
    for (const group of groups) {
      if (group.id === 'excerpt' && !includeExcerpt) continue
      lines.push(color.textMuted(truncateToWidth(group.head, width, '…', false)))
      if (group.prose === true) {
        for (const fact of group.facts) {
          lines.push(color.textDim(truncateToWidth(fact.label, width, '…', false)))
          for (const line of wrapTextWithAnsi(fact.value, Math.max(1, width))) {
            lines.push(color.text(truncateToWidth(line, width, '…', false)))
          }
        }
        continue
      }
      lines.push(...this.inspectorFactLines(group.facts, width, twoPerRow))
    }
    return lines
  }

  /** The inline right-pane Inspector: a FIXED identity/status region plus the
   *  scrollable fact groups. The list keeps keyboard focus; the wheel scrolls
   *  only this painted body. */
  private renderInspectorPaneLines(
    sessionId: string,
    origin: 'browse' | 'search',
    width: number,
    budget: number,
    terminalWidth: number,
    includeExcerpt: boolean,
  ): PaneRender {
    const view = this.inspectorViewFor(sessionId, origin)
    if (view === undefined) {
      return { lines: [color.textMuted(fit('Session unavailable', width))].slice(0, budget), regions: [] }
    }
    const fixed = [
      fit(color.textStrong(truncateToWidth(view.title, width, '…', false)), width),
      fit(color.textDim(truncateToWidth(`${view.shortId} · ${view.stateLabel}`, width, '…', false)), width),
      ...(view.notice === '' ? [] : [fit(this.inspectorNotice(view, width), width)]),
    ]
    const bodyBudget = Math.max(0, budget - fixed.length)
    const all = bodyBudget <= 0
      ? []
      : this.inspectorGroupLines(view.groups, width, terminalWidth >= WIDE_TWO_FACT_MIN_COLUMNS, includeExcerpt)
    if (this.inlineInspectorScrollId !== sessionId) {
      this.inlineInspectorScrollId = sessionId
      this.inlineInspectorScroll = 0
    }
    const maxScroll = Math.max(0, all.length - bodyBudget)
    this.inlineInspectorScroll = Math.min(Math.max(0, this.inlineInspectorScroll), maxScroll)
    const body = all.slice(this.inlineInspectorScroll, this.inlineInspectorScroll + bodyBudget)
    this.lastPaintedInlineInspectorSessionId = sessionId
    const regions: HitRegion[] = body.length === 0
      ? []
      : this.wheelZoneRegions('wheel-inspector', fixed.length, fixed.length + body.length, width)
    return { lines: [...fixed, ...body].slice(0, budget), regions }
  }

  /** The full-width Inspector page: fixed identity/status lines and the ONE
   *  scrollable reading body. The header/action bar stay the shared surface. */
  private renderInspectorPage(width: number, budget: number): PaneRender {
    const page = this.inspectorPage
    if (page === undefined || budget <= 0) return { lines: [], regions: [] }
    const view = this.inspectorViewFor(page.sessionId, page.origin)
    if (view === undefined) {
      return { lines: [color.textMuted(fit('Session unavailable', width))].slice(0, budget), regions: [] }
    }
    const suffix = ` · ${view.stateLabel}`
    const titleBudget = Math.max(1, width - visibleWidth(suffix))
    const identity = `${color.textStrong(truncateToWidth(view.title, titleBudget, '…', false))}${color.textMuted(truncateToWidth(suffix, width, '…', false))}`
    // The full-width page is the complete identity reading: the complete
    // official Host id wraps onto real rows instead of being silently cut. The
    // inline pane keeps the short id.
    const idPrefix = 'ID '
    const idIndent = ' '.repeat(visibleWidth(idPrefix))
    const idLines = wrapTextWithAnsi(view.fullId, Math.max(1, width - visibleWidth(idPrefix)))
    const fixed = [
      fit(identity, width),
      ...idLines.map((line, index) => fit(
        `${index === 0 ? color.textDim(idPrefix) : idIndent}${color.text(line)}`,
        width,
      )),
      ...(view.notice === '' ? [] : [fit(this.inspectorNotice(view, width), width)]),
    ]
    // The page's real object identity is painted: from here its body target is
    // reportable. A 0/1-row frame never reaches this method.
    this.inspectorPagePainted = true
    const bodyBudget = Math.max(0, budget - fixed.length)
    const all = bodyBudget <= 0
      ? []
      : this.inspectorGroupLines(view.groups, width, width >= WIDE_TWO_FACT_MIN_COLUMNS, true)
    const maxScroll = Math.max(0, all.length - bodyBudget)
    page.scrollRow = Math.min(Math.max(0, page.scrollRow), maxScroll)
    const body = all.slice(page.scrollRow, page.scrollRow + bodyBudget)
    this.lastPaintedListRows = Math.max(1, body.length)
    this.inspectorScrollPainted = body.length > 0
    const regions: HitRegion[] = body.length === 0
      ? []
      : this.wheelZoneRegions('wheel-inspector', fixed.length, fixed.length + body.length, width)
    return { lines: [...fixed, ...body].slice(0, budget), regions }
  }

  private scrollInlineInspector(delta: number): void {
    const sessionId = this.lastPaintedInlineInspectorSessionId
    if (sessionId === undefined) return
    if (this.inlineInspectorScrollId !== sessionId) {
      this.inlineInspectorScrollId = sessionId
      this.inlineInspectorScroll = 0
    }
    this.inlineInspectorScroll = Math.max(0, this.inlineInspectorScroll + delta)
    this.host.requestRender()
  }

  /** The Reader's ONE scrollable body. The global Action Bar is the only exit
   *  affordance; the body owns no local action row. Only a `ready` document
   *  registers a wheel target, and only for the physical rows it really paints. */
  private renderReaderPane(width: number, budget: number): PaneRender {
    if (budget <= 0) return { lines: [], regions: [] }
    const reader = this.reader
    if (reader === undefined) {
      return { lines: [color.textMuted(fit('Transcript closed', width))].slice(0, budget), regions: [] }
    }
    if (reader.state.kind !== 'ready') {
      this.lastPaintedListRows = 1
      return { lines: this.readerStatusLines(reader.state, width, budget), regions: [] }
    }
    let all: string[]
    try {
      all = reader.state.document.render(width)
    } catch (error) {
      reader.state = { kind: 'error', message: sanitizedPhysicalLine(safeErrorMessage(error)) }
      return this.renderReaderPane(width, budget)
    }
    if (all.length > SESSION_READER_MAX_RENDERED_ROWS) {
      reader.state = { kind: 'too-large' }
      return this.renderReaderPane(width, budget)
    }
    const viewport = Math.max(1, Math.min(budget, Math.max(1, all.length)))
    const maxScroll = Math.max(0, all.length - viewport)
    reader.scrollRow = Math.min(Math.max(0, reader.scrollRow), maxScroll)
    const lines = all.slice(reader.scrollRow, reader.scrollRow + viewport)
    // Page keys and the wheel use the REAL painted body height: a short document
    // never pages past its own last row and a full one never skips a row.
    this.lastPaintedListRows = Math.max(1, lines.length)
    return {
      lines: lines.slice(0, budget),
      regions: this.wheelZoneRegions('wheel-reader', 0, lines.length, width),
    }
  }

  private readerStatusLines(
    state: Exclude<SessionTranscriptReader['state'], { readonly kind: 'ready' }>,
    width: number,
    budget: number,
  ): string[] {
    const wrap = (text: string, paint: (line: string) => string): string[] =>
      wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(paint)
    switch (state.kind) {
      case 'loading':
        return wrap('Reading committed transcript…', color.textDim).slice(0, budget)
      case 'none':
        return wrap('No committed transcript found for this Session.', color.textDim).slice(0, budget)
      case 'unavailable':
        return wrap('Committed transcript unavailable.', color.textDim).slice(0, budget)
      case 'too-large':
        return [
          ...wrap('Transcript too large to display here. No content was truncated.', color.error),
          ...(budget >= 2
            ? wrap('Open the Session explicitly before using /transcript to save it.', color.textMuted)
            : []),
        ].slice(0, budget)
      case 'error': {
        // Bound the projected summary BEFORE wrapping. A non-official HTTP 500
        // can carry a very long body; wrapping it in full would mint thousands
        // of invisible styled rows only to slice them away.
        const summary = truncateToWidth(
          `Transcript read failed: ${state.message}`,
          Math.max(1, width * SESSION_READER_ERROR_SUMMARY_LINES),
          '…',
          false,
        )
        return wrapTextWithAnsi(summary, Math.max(1, width)).map(color.error).slice(0, budget)
      }
    }
  }

  /** The ONE truthful status text of one classified row. */
  private statusLabel(fact: SessionWorkspaceRowFact): string {
    return workspaceRowStatusLabel(fact)
  }

  /** The compact row's fixed status group. `workspaceRowStatusLabel` stays the
   *  ONE wording authority; only the verbose `Pending · not actionable here`
   *  phrase is shortened here. */
  private browseStatusParts(fact: SessionWorkspaceRowFact): { readonly primary: string; readonly secondary?: string } | undefined {
    const label = this.statusLabel(fact)
    if (label === '') return undefined
    if (label === 'Pending · not actionable here') {
      return { primary: color.textDim('‣ Pending unverified') }
    }
    const [primaryWord = '', secondaryWord] = label.split(' · ')
    if (fact.priority === 'needs') {
      return {
        primary: color.warning(`‣ ${primaryWord}`),
        ...(secondaryWord === undefined ? {} : { secondary: color.primary(secondaryWord) }),
      }
    }
    return { primary: color.primary(`‣ ${label}`) }
  }

  private browseRowLine(row: SessionBrowserRow, fact: SessionWorkspaceRowFact, selected: boolean, width: number): string {
    const current = row.id === this.options.currentSessionId
    const marker = selected ? color.primary('> ') : '  '
    const currentMark = current ? color.success('● ') : ''
    const shortId = sanitizedPhysicalLine(shortSessionId(row.id))
    const title = row.title === undefined ? undefined : sanitizedPhysicalLine(row.title)
    // A Session is painted as a CHILD of its Folder: the fixed `> ` gutter stays
    // in the tree root column while the bullet, the identity and the status all
    // start two cells further right.
    const status = this.browseStatusParts(fact)
    if (status === undefined) {
      const meta = [
        color.textMuted(formatSessionAge(row.updatedAt)),
        color.textDim(workspaceKey(row.cwd)),
      ].join(color.textMuted(' · '))
      const columns = rowColumns(identityWidth(shortId, title), Math.max(1, width - SESSION_TREE_INDENT))
      const label = truncateToWidth(identityText(shortId, title, selected), columns.identity, '…', false)
      const secondary = columns.meta > 0 ? truncateToWidth(meta, columns.meta, '…', false) : ''
      return fit(
        `${marker}${' '.repeat(SESSION_TREE_INDENT)}${currentMark}${padColumn(label, columns.identity)}${secondary === '' ? '' : `  ${secondary}`}`,
        width,
      )
    }
    // The status group is reserved WHOLE at the right edge before the identity
    // is laid out: full key state > short id > title prefix > age > cwd. The
    // `Working` secondary segment is dropped whole first on a narrow row.
    const primaryWidth = visibleWidth(status.primary)
    // The assembled status group joins its secondary word with the real
    // three-cell ` · ` separator, not a two-cell guess.
    const secondaryWidth = status.secondary === undefined ? 0 : 3 + visibleWidth(status.secondary)
    const fixed = 2 + SESSION_TREE_INDENT + (current ? 2 : 0)
    const contentWidth = Math.max(1, width - fixed)
    const idWidth = visibleWidth(shortId)
    const minimumIdentity = idWidth + 2 + Math.min(visibleWidth(title ?? ''), MIN_TITLE_CELLS)
    const useSecondary = status.secondary !== undefined
      && primaryWidth + secondaryWidth + 2 + minimumIdentity <= contentWidth
    const statusText = useSecondary
      ? `${status.primary}${color.textMuted(' · ')}${status.secondary}`
      : status.primary
    const identityBudget = Math.max(0, contentWidth - visibleWidth(statusText) - 2)
    const identity = identityText(shortId, title, selected)
    let left = truncateToWidth(identity, identityBudget, '…', false)
    // Age/cwd are inline secondary facts (no status marker). Each whole fact is
    // added only when the complete identity already fits and the row still has
    // room for it; the title never shrinks to make room for them.
    if (visibleWidth(identity) <= identityBudget) {
      const facts = [
        color.textMuted(formatSessionAge(row.updatedAt)),
        color.textDim(workspaceKey(row.cwd)),
      ]
      let room = identityBudget - visibleWidth(identity)
      for (const factText of facts) {
        const cost = 3 + visibleWidth(factText)
        if (cost > room) continue
        left = `${left}${color.textMuted(' · ')}${factText}`
        room -= cost
      }
    }
    return fit(
      `${marker}${' '.repeat(SESSION_TREE_INDENT)}${currentMark}${padColumn(left, identityBudget)}  ${statusText}`,
      width,
    )
  }

  private searchRowLine(result: SessionBrowserSearchResult, selected: boolean, width: number): string {
    const row = result.row
    const current = row.id === this.options.currentSessionId
    const marker = selected ? color.primary('> ') : '  '
    const currentMark = current ? color.success('● ') : ''
    const shortId = sanitizedPhysicalLine(shortSessionId(row.id))
    const title = row.title === undefined ? undefined : sanitizedPhysicalLine(row.title)
    // The full source word is projected as-is: a metadata row never borrows a
    // content tone, and a content/both row keeps the official `Content`/`Both`.
    const source = result.source
    if (result.snippet === undefined) {
      const meta = [
        color.textMuted(`${source} · ${formatSessionAge(row.updatedAt)}`),
        color.textDim(workspaceKey(row.cwd)),
      ].join(color.textMuted(' · '))
      const columns = rowColumns(identityWidth(shortId, title), width)
      const label = truncateToWidth(identityText(shortId, title, selected), columns.identity, '…', false)
      const secondary = columns.meta > 0 ? truncateToWidth(meta, columns.meta, '…', false) : ''
      return fit(
        `${marker}${currentMark}${padColumn(label, columns.identity)}${secondary === '' ? '' : `  ${secondary}`}`,
        width,
      )
    }

    // A Host excerpt outranks age/cwd. Preserve the stable short id, a
    // recognisable title prefix, the WHOLE source word, then as much of the
    // terminal-cell-safe excerpt as the row can hold; a title tail is the only
    // lower-priority claimant. A source that cannot fit whole is omitted whole.
    const snippet = sanitizedPhysicalLine(result.snippet)
    const contentWidth = Math.max(0, width - visibleWidth(marker) - visibleWidth(currentMark))
    const idWidth = visibleWidth(shortId)
    if (contentWidth <= idWidth) {
      return fit(`${marker}${currentMark}${truncateToWidth(color.textDim(shortId), contentWidth, '', false)}`, width)
    }
    const titleWidth = title === undefined ? 0 : visibleWidth(title)
    let titleCells = titleWidth === 0 ? 0 : Math.min(MIN_TITLE_CELLS, titleWidth, Math.max(1, contentWidth - idWidth - 2))
    const paintTitle = (cells: number): string => {
      if (cells <= 0 || title === undefined) return ''
      const prefix = truncateToWidth(title, cells, '…', false)
      return `  ${selected ? color.textStrong(prefix) : color.text(prefix)}`
    }
    let remaining = contentWidth - idWidth - (titleCells === 0 ? 0 : 2 + titleCells)
    const sourceWidth = visibleWidth(source)
    let sourceSegment = ''
    let excerptCells = 0
    if (remaining >= 2 + sourceWidth + 3 + 2 + 1) {
      sourceSegment = `  ${color.textDim(source)}${color.textMuted(' · ')}`
      remaining -= 2 + sourceWidth + 3
      excerptCells = Math.max(0, remaining - 2)
    } else if (remaining >= 2 + 2 + 1) {
      sourceSegment = '  '
      remaining -= 2
      excerptCells = Math.max(0, remaining - 2)
    }
    if (excerptCells >= visibleWidth(snippet) && titleCells > 0 && titleWidth > titleCells) {
      const extra = Math.min(excerptCells - visibleWidth(snippet), titleWidth - titleCells)
      titleCells += extra
      excerptCells -= extra
    }
    let line = `${marker}${currentMark}${color.textDim(shortId)}${paintTitle(titleCells)}${sourceSegment}`
    if (excerptCells > 0) {
      line += color.textMuted(`…${truncateToWidth(snippet, excerptCells, '', false)}…`)
    }
    return fit(line, width)
  }

  /** The ONE status projection shared by every mode. Never a fabricated
   *  Session, never a false "no persisted sessions" claim and never a stale
   *  freshness claim. */
  private renderStatusLines(width: number): string[] {
    const lines: string[] = []
    const snapshot = this.snapshot
    /** Raw projected status texts painted by THIS frame (dedupe key). */
    const paintedStatuses = new Set<string>()
    const push = (text: string, kind: 'muted' | 'error' = 'muted'): void => {
      // A Host/extension notice is arbitrary bytes: it must cross the SAME
      // one-physical-row projection the title/cwd/snippet do before it paints.
      const line = sanitizedPhysicalLine(text)
      paintedStatuses.add(line)
      lines.push(kind === 'error'
        ? color.error(truncateToWidth(line, width, '…', false))
        : color.textMuted(truncateToWidth(line, width, '…', false)))
    }
    if (snapshot.resumePending) push('Opening session…')
    if (this.newSessionPending !== undefined) push('Starting session…')
    if (this.statusMessage !== undefined) push(this.statusMessage)
    if (snapshot.listState === 'error') {
      // A real roster failure keeps its diagnostic reason even in Search; the
      // search pane states the one non-interactive "session list unavailable"
      // fact. Routine loading/unavailable/empty are owned by the Search empty
      // state below, so they are never duplicated as a second status row.
      push(`session listing failed: ${sanitizedPhysicalLine(snapshot.listError ?? 'unknown error')}`, 'error')
    } else if (!this.searchMode && snapshot.listState === 'unavailable') {
      push('session persistence unavailable')
    } else if (!this.searchMode && snapshot.listState === 'empty') {
      push('No readable sessions')
    } else if (!this.searchMode && snapshot.listState === 'loading') {
      push('Loading sessions…')
    }
    if (snapshot.refreshError !== undefined) {
      push(`session list refresh failed: ${sanitizedPhysicalLine(snapshot.refreshError)}`)
    }
    if (this.activityError !== undefined) {
      push(`Activity unavailable: ${sanitizedPhysicalLine(this.activityError)}`)
    }
    if (this.workspaceError !== undefined) push(this.workspaceError)
    if (this.searchMode && snapshot.searchState === 'error') {
      // Routine loading/unavailable/hasMore health belongs to the fixed Search
      // context row above the body; only a real failure keeps a diagnostic row.
      push(sessionBrowserErrorNotice('search', snapshot.searchError ?? 'unknown error'), 'error')
    }
    if (snapshot.projectionError !== undefined) {
      push(sessionBrowserErrorNotice('projection', snapshot.projectionError))
    }
    // The app's ONE transient notice (a failed/indeterminate interactive switch,
    // a clipboard or settings notice). It is painted LAST and only when the
    // same fact is not already an above status line: one visible exit per fact
    // in this frame, never a global notice plus a panel duplicate.
    const notice = this.host.notice()
    if (notice !== undefined && !paintedStatuses.has(sanitizedPhysicalLine(notice.text))) {
      push(notice.text, notice.kind === 'error' ? 'error' : 'muted')
    }
    return lines
  }

  /** Paint the ONE physical Action Bar from the shared layout. Hit geometry is
   *  the UNPAINTED `layoutActionBarRow` span (half-open), converted to this
   *  panel's inclusive `xEnd`; separators, padding and a truncated row are
   *  always inert. Returned regions carry the synthetic row 0; each `render()`
   *  branch remaps them to the row really painted. */
  private renderActionBar(width: number): { readonly line: string; readonly regions: readonly HitRegion[] } {
    const segments = this.actionBarSegments()
    if (segments.length === 0) {
      return { line: color.textMuted(renderActionBarRow(segments, width)), regions: [] }
    }
    const layout = layoutActionBarRow(segments, width)
    // One surviving segment that still cannot fit is truncated with the
    // ellipsis and yields NO span: it is a fact, never a target.
    if (layout.truncated) return { line: color.textMuted(layout.text), regions: [] }
    const parts: string[] = []
    const regions: HitRegion[] = []
    layout.spans.forEach((span, index) => {
      if (index > 0) parts.push(color.textMuted(ACTION_BAR_SEPARATOR))
      const segment = segments[span.inputIndex]!
      if (segment.action === undefined) {
        parts.push(color.textMuted(span.text))
        return
      }
      parts.push(paintActionSpan(span.text, segment.ink))
      regions.push({
        kind: 'bar-action',
        action: segment.action,
        xStart: span.startCol,
        xEnd: span.endCol - 1,
        line: 0,
      })
    })
    const line = parts.join('')
    // Colours never change the visible width; pad to the historical row width
    // so `visibleWidth(line)` is the UNPAINTED layout width (≤ width).
    const padding = visibleWidth(layout.text) - visibleWidth(line)
    return { line: padding > 0 ? `${line}${' '.repeat(padding)}` : line, regions }
  }

  /** The ONE current Enter verb of the selected typed row. A row whose body
   *  click already runs the action keeps its historical keyboard-only hint
   *  (`Enter New session`) in the bar instead of a second button-style
   *  affordance; folder/session rows are the ones the bar may execute. */
  private enterAction(row: PiTuiWorkspaceTreeRow): {
    readonly text: string
    readonly short: string
    readonly hint: string
  } {
    switch (row.kind) {
      case 'folder':
        if (this.chooserMode() && this.options.currentSessionId === undefined && this.workspaces.byId.has(row.workspaceId)) {
          return { text: 'Choose [Enter]', short: 'Choose', hint: 'Enter Choose workspace' }
        }
        return row.expanded
          ? { text: 'Collapse [Enter]', short: 'Collapse', hint: 'Enter Collapse' }
          : { text: 'Expand [Enter]', short: 'Expand', hint: 'Enter Expand' }
      case 'newSession':
        return { text: 'Enter New session', short: 'New', hint: 'Enter New session' }
      case 'addDirectory':
        return { text: 'Enter Add directory', short: 'Add', hint: 'Enter Add directory' }
      case 'showMore':
        return { text: 'Enter More sessions', short: 'More', hint: 'Enter More sessions' }
      case 'session':
        return row.sessionId === this.options.currentSessionId
          ? { text: 'Return [Enter]', short: 'Return', hint: 'Enter Return' }
          : { text: 'Open [Enter]', short: 'Open', hint: 'Enter Open' }
    }
  }

  private actionBarSegments(): SessionBarSegment[] {
    if (this.directoryEntryActive) {
      if (this.directorySubmitting) return [{ text: 'Verifying directory…', priority: 9, short: 'Verifying' }]
      const candidatesPainted = this.paintedDirectorySuggestionPaths.length
      const segments: SessionBarSegment[] = []
      if (candidatesPainted > 0) {
        // Keyboard-only hints: the candidate rows already own the click and
        // Tab/arrows are not pointer actions.
        segments.push({ text: 'Tab Complete', priority: 6, short: 'Tab' })
        if (candidatesPainted > 1) segments.push({ text: '↑↓ Choose', priority: 5, short: '↑↓' })
        if (this.directoryEditorPainted) {
          segments.push({ text: 'Verify [Enter]', priority: 7, short: 'Verify', action: 'verify', ink: 'primary' })
        }
        // The first Esc step this frame really promises: fold the suggestions
        // (the same ladder the key follows).
        segments.push({ text: 'Hide suggestions [Esc]', priority: 9, short: 'Hide', action: 'cancel', ink: 'secondary' })
        return segments
      }
      if (this.directoryEditorPainted) {
        segments.push({ text: 'Verify [Enter]', priority: 7, short: 'Verify', action: 'verify', ink: 'primary' })
      }
      segments.push({ text: 'Cancel [Esc]', priority: 9, short: 'Cancel', action: 'cancel', ink: 'secondary' })
      return segments
    }
    if (this.focus === 'inspector') {
      // The full-width Inspector keeps the ONE real Back verb and advertises
      // scroll keys only when it really painted its reading body.
      const segments: SessionBarSegment[] = []
      if (this.inspectorScrollPainted) {
        segments.push({ text: 'Up/Down scroll', priority: 6, short: 'Scroll' })
        segments.push({ text: 'PgUp/PgDn page', priority: 5, short: 'Page' })
      }
      segments.push({ text: 'Back [Esc]', priority: 9, short: 'Back', action: 'close', ink: 'secondary' })
      return segments
    }
    if (this.focus === 'reader') {
      // Reader Enter is not an action. Only ready content advertises its
      // scroll keys; every Reader state keeps the ONE real Back verb.
      const segments: SessionBarSegment[] = []
      if (this.reader?.state.kind === 'ready') {
        segments.push({ text: 'Up/Down scroll', priority: 6, short: 'Scroll' })
        segments.push({ text: 'PgUp/PgDn page', priority: 5, short: 'Page' })
      }
      segments.push({ text: 'Back [Esc]', priority: 9, short: 'Back', action: 'close', ink: 'secondary' })
      return segments
    }
    if (this.focus === 'search-results') {
      const painted = new Set(this.lastPaintedResultIds)
      const selectedPainted = this.selectedSearchSessionId !== undefined && painted.has(this.selectedSearchSessionId)
      const segments: SessionBarSegment[] = []
      if (painted.size >= 2) segments.push({ text: 'Up/Down move', priority: 6, short: 'Move' })
      if (selectedPainted && !this.snapshot.resumePending) {
        // The second Enter on a result is the one explicit resume; on the
        // Session this Browser was opened from it returns instead.
        if (this.selectedSearchSessionId === this.options.currentSessionId) {
          segments.push({ text: 'Return [Enter]', priority: 8, short: 'Return', action: 'open', ink: 'secondary' })
        } else {
          segments.push({ text: 'Open [Enter]', priority: 8, short: 'Open', action: 'open', ink: 'primary' })
        }
        segments.push({ text: 'Read [Space]', priority: 8, short: 'Read', action: 'peek', ink: 'secondary' })
        segments.push({ text: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, priority: 8, short: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, action: 'inspect', ink: 'secondary' })
      }
      segments.push({ text: 'Back [Esc]', priority: 9, short: 'Back', action: 'close', ink: 'secondary' })
      return segments
    }
    if (this.focus === 'search') {
      const segments: SessionBarSegment[] = []
      if (this.snapshot.searchResults.length > 0) {
        segments.push({ text: 'Results [Enter]', priority: 5, short: 'Results', action: 'results', ink: 'primary' })
      }
      segments.push({ text: 'Back [Esc]', priority: 9, short: 'Back', action: 'close', ink: 'secondary' })
      return segments
    }
    if (this.newSessionPending !== undefined) {
      return [
        { text: 'Starting session…', priority: 9, short: 'Starting' },
        { text: '/ search', priority: 5, short: '/' },
        { text: 'Close [Esc]', priority: 9, short: 'Esc', action: 'close', ink: 'secondary' },
      ]
    }
    // Browse: advertise ONLY what the painted frame can really execute.
    const painted = new Set(this.lastPaintedTreeIds)
    const paintedRows = this.treeRowsCache.filter(row => painted.has(row.id))
    const selected = this.selectedBrowseRow()
    const selectedPainted = selected !== undefined && painted.has(selected.id)
    const paintedFolders = paintedRows.filter(row => row.kind === 'folder').length
    const folderCount = this.treeRowsCache.filter(row => row.kind === 'folder').length
    const segments: SessionBarSegment[] = []
    if (paintedFolders > 0 && folderCount >= 2) {
      segments.push({ text: `${SESSION_WORKSPACE_CHORDS.folderCycle.label} Workspace`, priority: 3, short: 'Tab' })
    }
    if (paintedRows.length >= 2) segments.push({ text: 'Up/Down move', priority: 6, short: 'Move' })
    if (selected !== undefined && selectedPainted
      && !(selected.kind === 'session' && this.snapshot.resumePending)) {
      if (selected.kind === 'session' && selected.sessionId === this.options.currentSessionId) {
        // Enter on the opened Session returns to it. The bar advertises that
        // real action (secondary navigation ink) and keeps the read-only Reader
        // plus the SAME read-only Inspector page.
        const enter = this.enterAction(selected)
        segments.push({ text: enter.text, priority: 8, short: enter.short, action: 'activate-row', ink: 'secondary' })
        segments.push({ text: 'Read [Space]', priority: 8, short: 'Read', action: 'peek', ink: 'secondary' })
        segments.push({ text: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, priority: 8, short: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, action: 'inspect', ink: 'secondary' })
      } else if (selected.kind === 'folder' || selected.kind === 'session') {
        const enter = this.enterAction(selected)
        segments.push({ text: enter.text, priority: 7, short: enter.short, action: 'activate-row', ink: 'primary' })
        if (selected.kind === 'session') {
          segments.push({ text: 'Read [Space]', priority: 8, short: 'Read', action: 'peek', ink: 'secondary' })
          segments.push({ text: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, priority: 8, short: `Inspect [${SESSION_WORKSPACE_CHORDS.inspect.label}]`, action: 'inspect', ink: 'secondary' })
        }
      } else {
        // New / Add / More: the painted ROOT ROW already runs that explicit
        // action, so the bar keeps only its historical keyboard hint (key-first
        // syntax, never a button-style affordance) and registers no second
        // intent for the same action (§8.2).
        const enter = this.enterAction(selected)
        segments.push({ text: enter.hint, priority: 7, short: enter.short })
      }
    }
    segments.push({ text: '/ search', priority: 5, short: '/' })
    segments.push({ text: 'Close [Esc]', priority: 9, short: 'Close', action: 'close', ink: 'secondary' })
    return segments
  }
}
