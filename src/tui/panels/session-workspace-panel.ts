/**
 * M5-U-D — the fullscreen PiTUI Session Workspace panel.
 *
 * ONE client-local component owns the whole Session Workspace surface: the
 * grouped browse list (`Needs attention` → `Working` → `Recent`), the complete
 * Workspace scope selector, the global content-search editor and its result
 * list, the read-only `Space` Peek, the responsive two-column layout, the
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
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@xmoon76/pi-tui'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserNewSessionSettlement,
  SessionBrowserReadSnapshot,
  SessionBrowserRow,
  SessionBrowserSearchResult,
} from '../../app/command/session-browser-presentation.ts'
import type {
  SessionActivityFact,
  SessionWorkspaceFact,
  WorkspaceFactsFrame,
} from '../../runtime/session-workspace-facts-port.ts'
import { renderActionBarRow } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import {
  buildSessionWorkspaceView,
  currentWorkspaceOf,
  SESSION_PENDING_LABEL,
  SESSION_SOURCE_LABEL,
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
import { SESSION_WORKSPACE_CHORDS } from '../keybindings/hints.ts'
import { color } from '../theme/runtime.ts'
import { formatSessionAge, sessionBrowserErrorNotice, shortSessionId, workspaceKey } from '../pickers/sessions.ts'

/** The logical focus of one Session Workspace frame. `search` is the raw
 * global query editor; `search-results` is the Host+metadata result list;
 * `peek` is the read-only `Space` detail of the selected row. */
export type SessionWorkspaceFocus = 'search' | 'list' | 'search-results' | 'peek' | 'directory'

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
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: SessionBrowserNewSessionSettlement) => void) => void
  readonly onAddDirectory?: (path: string, settle: (outcome: import('../../app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void) => void
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

/** The two-column layout threshold (frozen by the U-D product contract). */
const WIDE_MIN_COLUMNS = 112
const WIDE_MIN_ROWS = 12
/** The smallest left column of the two-column layout. */
const WIDE_LEFT_MIN_CELLS = 44
const GROUP_LABEL: Record<SessionWorkspacePriority, string> = {
  needs: 'Needs attention',
  working: 'Working',
  recent: 'Recent',
}

/** Truncate one rendered line to the pane width and pad it with plain spaces. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
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
  }
}

/** One painted mouse target of the LAST frame. `xEnd` is inclusive and every
 *  range is the REAL painted cell range: a truncated/omitted target has none. */
interface HitRegion {
  readonly kind: 'tree-row' | 'folder-toggle' | 'result' | 'search' | 'search-hint' | 'peek-back' | 'directory-confirm' | 'directory-cancel'
  readonly id?: string
  readonly xStart: number
  readonly xEnd: number
  readonly line: number
}

/** One pane render: the painted lines plus the regions in pane coordinates. */
interface PaneRender {
  readonly lines: string[]
  readonly regions: readonly HitRegion[]
}

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
  private readonly directoryInput = new Input({ prompt: 'Host directory: ' })
  private directoryEntryActive = false
  private directorySubmitting = false
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
  /** The transient result-list scroll of THIS search, never a stored anchor. */
  private resultScroll = 0
  /** The read-only `Space` Peek of one painted row. */
  private peek: { readonly sessionId: string; readonly returnFocus: 'list' | 'search-results'; scrollRow: number } | undefined
  /** The per-open mouse gesture: one press identity, cleared by ANY content
   *  change of the last committed frame. */
  private pressed:
    | {
      readonly revision: number
      readonly kind: HitRegion['kind']
      readonly id: string | undefined
      readonly xStart: number
      readonly xEnd: number
    }
    | undefined
  /** The last frame this panel really painted, in panel-relative coordinates. */
  private hitFrame: { readonly revision: number; readonly regions: readonly HitRegion[] } = { revision: 0, regions: [] }
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
    this.hitFrame = { revision: this.frameRevision, regions }
    return frame
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
    this.directoryEntryActive = options.initialDirectoryEntry === true
    this.searchMode = options.initialMode === 'search' && !this.directoryEntryActive
    if (options.initialDirectoryPath !== undefined) this.directoryInput.setValue(options.initialDirectoryPath)
    this.focus = this.directoryEntryActive ? 'directory' : this.searchMode ? 'search' : 'list'
  }

  /** Whether this panel has been released. The lease handle checks its own
   *  record as well; this flag only stops local reactions after dispose. */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Ordinary snapshots refresh results and the roster. Only the one-shot
   *  `initialQuery` option may write the editor, and never after a real edit. */
  setSnapshot(snapshot: SessionBrowserReadSnapshot, options?: { readonly initialQuery?: string }): void {
    if (this.disposed) return
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
      this.answerEligibility = activitySnapshot.answerEligibility
      this.activitySampleRevision = snapshot.listRevision
    }
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
   *  search and Peek stay usable and every activity fact becomes Unknown. */
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
    this.searchInput.invalidate()
  }

  dispose(): void {
    this.disposed = true
    this.pressed = undefined
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
    // A Peek pins its OWN Session id. If that Session is no longer listed (a
    // roster refresh, a scope/search change or another Client removing it), the
    // Peek exits to its previous focus; it must never silently show — or switch
    // to — whatever row the selection re-anchored to.
    if (this.peek !== undefined && !(this.searchMode ? resultIds : view.listIds).includes(this.peek.sessionId)) {
      const returnFocus = this.peek.returnFocus
      this.peek = undefined
      if (this.focus === 'peek') this.focus = returnFocus
      this.host.requestRender()
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
    if (this.focus === 'peek') {
      this.handlePeekInput(data)
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
    if (this.focus === 'peek') {
      this.closePeek()
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

  /** `Space` opens the read-only Peek of the selected PAINTED Session row only. */
  private openPeek(): void {
    if (this.focus !== 'list' && this.focus !== 'search-results') return
    if (this.snapshot.resumePending) return
    const target = this.focus === 'search-results' ? this.selectedSearchSessionId : this.selectedBrowseSessionId()
    if (target === undefined) return
    const painted = this.focus === 'search-results' ? this.lastPaintedResultIds : this.lastPaintedBrowseIds
    if (!painted.includes(target)) return
    this.peek = {
      sessionId: target,
      returnFocus: this.focus === 'search-results' ? 'search-results' : 'list',
      scrollRow: 0,
    }
    this.focus = 'peek'
    this.host.requestRender()
  }

  private closePeek(): void {
    const peek = this.peek
    this.focus = peek?.returnFocus ?? (this.searchMode ? 'search-results' : 'list')
    this.peek = undefined
    this.host.requestRender()
  }

  private handlePeekInput(data: string): void {
    const peek = this.peek
    if (peek === undefined) return
    if (matchesKey(data, Key.up)) return this.scrollPeek(-1)
    if (matchesKey(data, Key.down)) return this.scrollPeek(1)
    if (matchesKey(data, Key.pageUp)) return this.scrollPeek(-Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.pageDown)) return this.scrollPeek(Math.max(1, this.lastPaintedListRows - 1))
    if (matchesKey(data, Key.home)) {
      peek.scrollRow = 0
      return this.host.requestRender()
    }
    if (matchesKey(data, Key.end)) {
      peek.scrollRow = Number.MAX_SAFE_INTEGER
      return this.host.requestRender()
    }
    if (data === ' ' || matchesKey(data, Key.space)) return this.closePeek()
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.resumeSelected()
      return
    }
  }

  private scrollPeek(delta: number): void {
    const peek = this.peek
    if (peek === undefined) return
    peek.scrollRow = Math.max(0, peek.scrollRow + delta)
    this.host.requestRender()
  }

  private handleDirectoryInput(data: string): void {
    if (this.directorySubmitting) return
    if (matchesKey(data, Key.escape)) {
      this.handleDirectoryCancel()
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.handleDirectorySubmit()
      return
    }
    const before = this.directoryInput.getValue()
    this.directoryInput.handleInput(data)
    if (this.directoryInput.getValue() !== before) {
      this.statusMessage = undefined
      this.host.requestRender()
    }
  }

  private handleDirectoryCancel(): void {
    if (this.directorySubmitting) return
    this.directoryEntryActive = false
    this.directoryInput.focused = false
    this.directoryInput.setValue('')
    this.statusMessage = undefined
    this.focus = 'list'
    this.host.requestRender()
  }

  private handleDirectorySubmit(): void {
    if (this.directorySubmitting) return
    const path = this.directoryInput.getValue().trim()
    if (!path.startsWith('/')) {
      this.statusMessage = 'Enter an absolute Host path beginning with /.'
      this.host.requestRender()
      return
    }
    this.directorySubmitting = true
    this.statusMessage = undefined
    this.host.requestRender()
    this.host.onAddDirectory?.(path, (outcome) => {
      if (this.disposed) return
      this.directorySubmitting = false
      if (outcome.kind === 'registered') {
        this.nextCreateWorkspaceId = outcome.workspaceId
        if (this.options.initialDirectoryChooser === true) {
          this.host.onClose()
          return
        }
        this.directoryEntryActive = false
        this.directoryInput.focused = false
        this.focus = 'list'
        this.statusMessage = `Directory added: ${outcome.path}`
      } else {
        this.statusMessage = outcome.message
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
    if (data === ' ' || matchesKey(data, Key.space)) {
      this.openPeek()
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
      this.openPeek()
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
        this.directoryEntryActive = true
        this.focus = 'directory'
        this.directoryInput.focused = true
        this.host.requestRender()
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
      this.workspaceHistoryLimit.set(workspaceId, 5)
    } else {
      const view = this.view()
      const current = this.workspaceHistoryLimit.get(workspaceId)
        ?? (workspaceId === view.currentWorkspaceId || workspaceId === view.nextCreateWorkspaceId ? 8 : 0)
      this.workspaceHistoryLimit.set(workspaceId, current + 5)
    }
    // Keep the cursor on the reveal target; only an exhausted watermark that
    // really disappeared re-anchors on its parent Folder.
    this.selectedBrowseRowId = `more:${workspaceId}`
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
    if (this.snapshot.resumePending) return
    // The Peek RESUMES ITS OWN pinned Session, never whatever row the list
    // selection re-anchored to after a refresh. Outside Peek a scope/membership
    // change can hide the previously selected row, and a short/status-squeezed
    // frame can paint no rows at all: only the set this frame really painted may
    // be opened.
    const target = this.focus === 'peek'
      ? this.peek?.sessionId
      : this.searchMode
        ? this.selectedSearchSessionId
        : this.selectedBrowseSessionId()
    if (target === undefined || target === this.options.currentSessionId) return
    const listed = this.searchMode
      ? this.snapshot.searchResults.map(result => result.row.id)
      : this.view().listIds
    if (!listed.includes(target)) return
    const painted = this.focus === 'peek'
      ? [target]
      : this.searchMode ? this.lastPaintedResultIds : this.lastPaintedBrowseIds
    if (!painted.includes(target)) return
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
    this.pressed = region === undefined
      ? undefined
      : {
        revision: this.hitFrame.revision,
        kind: region.kind,
        id: region.id,
        xStart: region.xStart,
        xEnd: region.xEnd,
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
    if (pressed.revision !== this.hitFrame.revision) return
    const region = this.regionAt(x, y)
    if (region === undefined
      || region.kind !== pressed.kind
      || region.id !== pressed.id
      || region.xStart !== pressed.xStart
      || region.xEnd !== pressed.xEnd) return
    this.activateRegion(region)
  }

  private activateRegion(region: HitRegion): void {
    switch (region.kind) {
      case 'directory-confirm':
        this.handleDirectorySubmit()
        return
      case 'directory-cancel':
        this.handleDirectoryCancel()
        return
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
        else if (row.kind === 'addDirectory') {
          this.directoryEntryActive = true
          this.focus = 'directory'
          this.directoryInput.focused = true
        } else if (row.kind === 'showMore') this.revealMore(row.workspaceId)
        else if (row.kind === 'folder' && this.chooserMode() && this.options.currentSessionId === undefined) {
          if (!this.workspaces.byId.has(row.workspaceId)) return
          const workspace = this.workspaces.byId.get(row.workspaceId)!
          this.host.onUseDirectory?.(workspace.workspaceId, workspace.path)
          this.host.onClose()
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
      case 'peek-back': {
        this.closePeek()
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
      // so it can never advertise an unpainted activation.
      return this.publishFrame([header.line, this.renderActionBar(width)], header.regions)
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
      this.paintView = undefined
      return this.publishFrame([header.line, bodyLine, actionBar], regions)
    }
    const lines: string[] = [header.line]
    const regions: HitRegion[] = [...header.regions]
    // The global search keeps its context line; a plain Browse frame has ONE
    // header and never repeats the Current Session or an All-workspaces scope.
    if (this.searchMode) lines.push(this.renderSearchContext(width))
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
    lines.push(actionBar)
    this.paintView = undefined
    return this.publishFrame(lines.slice(0, height), regions)
  }

  private renderHeader(width: number): { readonly line: string; readonly regions: readonly HitRegion[] } {
    const title = this.chooserMode() ? 'Choose workspace' : 'Sessions'
    const left = `${color.textStrong(title)}${color.textMuted(` · ${this.snapshot.rows.length}`)}`
    if (this.directoryEntryActive) {
      // The inline path editor owns the keyboard: no visible or clickable
      // / Search target may enter a search presentation behind it.
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

  private renderSearchContext(width: number): string {
    return withTrailing(color.textDim('Search all workspaces'), color.textMuted('Esc back'), width)
  }

  /** Compose one body frame: single column, or the wide two-column layout. */
  private renderBody(width: number, budget: number): PaneRender {
    if (budget <= 0) return { lines: [], regions: [] }
    if (this.host.rows() < WIDE_MIN_ROWS || width < WIDE_MIN_COLUMNS) {
      return this.renderSingleColumn(width, budget)
    }
    const leftWidth = Math.min(
      Math.max(WIDE_LEFT_MIN_CELLS, Math.floor(width * 0.55)),
      width - 2 - 20,
    )
    const rightWidth = width - leftWidth - 2
    if (rightWidth < 20) return this.renderSingleColumn(width, budget)
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
    if (paneBudget <= 0) return { lines: head.slice(0, budget), regions: headRegions }
    const left = this.searchMode
      ? this.renderSearchPane(leftWidth, paneBudget, false)
      : this.renderListPane(leftWidth, paneBudget, false)
    const right = this.focus === 'peek'
      ? this.renderPeekPane(rightWidth, paneBudget)
      : this.renderPreviewPane(rightWidth, paneBudget)
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
    if (this.focus === 'peek') return this.renderPeekPane(width, budget)
    return this.searchMode
      ? this.renderSearchPane(width, budget, true)
      : this.renderListPane(width, budget, true)
  }

  private renderListPane(width: number, budget: number, chrome: boolean): PaneRender {
    const view = this.frameView()
    const rows = this.treeRows(view)
    const lines: string[] = []
    const regions: HitRegion[] = []
    // While the inline path editor is open it owns the frame's error/status
    // facts: the generic list statuses must not squeeze the Add row and the
    // input off a short frame.
    if (chrome && !this.directoryEntryActive) lines.push(...this.renderStatusLines(width))
    if (lines.length >= budget) return { lines: lines.slice(0, budget), regions }
    const editorActive = this.directoryEntryActive
    const addIndex = rows.findIndex(row => row.kind === 'addDirectory')
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
      const suffix = `${entry.current ? ' · Current' : entry.next ? ' · Next' : ''}${entry.needs + entry.working > 0
        ? ` · ${entry.needs} Needs · ${entry.working} Working`
        : ''}`
      const label = sanitizedPhysicalLine(`${entry.title} · ${entry.total}`)
      lines.push(fit(`${marker}${disclosure}${selected ? color.textStrong(label) : color.text(label)}${color.textMuted(suffix)}`, width))
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

  /** The inline Host path editor, painted directly under the root Add row. */
  private paintDirectoryEditor(width: number, budget: number, lines: string[], regions: HitRegion[]): void {
    if (lines.length >= budget) return
    this.directoryInput.focused = !this.directorySubmitting
    lines.push(fit(this.directoryInput.render(width)[0] ?? '', width))
    if (lines.length >= budget) return
    if (this.directorySubmitting) {
      lines.push(color.textMuted(fit('Verifying directory…', width)))
      return
    }
    // A verb label never wears brackets (design language §4.5): the key is
    // the badge, the action stays a plain verb.
    const confirmText = 'Verify directory'
    const cancelText = 'Cancel'
    const actionLine = `${color.primary(confirmText)} ${color.primary('[Enter]')}${color.textMuted(' · ')}${color.text(cancelText)} ${color.primary('[Esc]')}`
    const actionRow = lines.length
    lines.push(fit(actionLine, width))
    if (width >= visibleWidth(confirmText)) {
      regions.push({ kind: 'directory-confirm', xStart: 0, xEnd: visibleWidth(confirmText) - 1, line: actionRow })
    }
    const cancelStart = visibleWidth(`${confirmText} [Enter]`) + visibleWidth(' · ')
    if (width > cancelStart) {
      regions.push({ kind: 'directory-cancel', xStart: cancelStart, xEnd: Math.min(width - 1, cancelStart + visibleWidth(cancelText) - 1), line: actionRow })
    }
    if (this.statusMessage !== undefined && lines.length < budget) {
      lines.push(color.textMuted(fit(this.statusMessage, width)))
    }
    // The app-owned failure notice that led here (a refused first session)
    // must stay visible INSIDE the path editor; otherwise auto-opening the
    // chooser would hide the only explanation the user gets.
    const notice = this.host.notice()
    if (notice !== undefined
      && notice.text !== sanitizedPhysicalLine(this.statusMessage ?? '')
      && lines.length < budget) {
      const painted = notice.kind === 'error' ? color.error : color.textMuted
      lines.push(painted(fit(notice.text, width)))
    }
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
    if (rows.length === 0) return { lines: lines.slice(0, budget), regions }
    const selectedIndex = Math.max(0, rows.findIndex(result => result.row.id === this.selectedSearchSessionId))
    this.resultScroll = rebaseOffset(this.resultScroll, selectedIndex, rows.length, rowBudget)
    const visible = rows.slice(this.resultScroll, this.resultScroll + rowBudget)
    for (const result of visible) {
      if (lines.length >= budget) break
      regions.push({ kind: 'result', id: result.row.id, xStart: 0, xEnd: Math.max(0, width - 1), line: lines.length })
      this.lastPaintedResultIds.push(result.row.id)
      lines.push(this.searchRowLine(result, result.row.id === this.selectedSearchSessionId, width))
    }
    return { lines: lines.slice(0, budget), regions }
  }

  /** The wide layout's right-hand read-only preview of the TYPED selection. */
  private renderPreviewPane(width: number, budget: number): PaneRender {
    const lines: string[] = []
    if (this.searchMode) {
      const row = this.selectedSearchSessionId === undefined ? undefined : this.rowById(this.selectedSearchSessionId)
      if (row === undefined) {
        lines.push(color.textMuted('No result selected'))
        return { lines: lines.slice(0, budget), regions: [] }
      }
      return { lines: this.sessionPreviewLines(row, this.frameView().rowsById.get(row.id), width).slice(0, budget), regions: [] }
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
        lines.push(color.textMuted(truncateToWidth('Register an existing directory on the Host', width, '…', false)))
        if (this.directoryEntryActive) {
          lines.push(color.textMuted(truncateToWidth(
            this.directorySubmitting ? 'Verifying directory…' : 'Editing the Host path',
            width, '…', false,
          )))
          lines.push(color.textMuted(truncateToWidth('Enter Verify directory · Esc Cancel', width, '…', false)))
        } else {
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
        const sessionRow = this.rowById(row.sessionId)
        if (sessionRow === undefined) {
          lines.push(color.textMuted('Session unavailable'))
          return { lines: lines.slice(0, budget), regions: [] }
        }
        return {
          lines: this.sessionPreviewLines(sessionRow, this.frameView().rowsById.get(row.sessionId), width).slice(0, budget),
          regions: [],
        }
      }
    }
  }

  /** The existing read-only Session preview (one typed Session row). */
  private sessionPreviewLines(
    row: SessionBrowserRow,
    fact: SessionWorkspaceRowFact | undefined,
    width: number,
  ): string[] {
    return [
      color.textStrong(truncateToWidth(sanitizedPhysicalLine(row.title ?? shortSessionId(row.id)), width, '…', false)),
      color.textDim(truncateToWidth(sanitizedPhysicalLine(shortSessionId(row.id)), width, '…', false)),
      color.textMuted(truncateToWidth(fact === undefined ? 'Activity unknown' : this.statusLabel(fact), width, '…', false)),
      color.textDim(truncateToWidth(`Workspace: ${this.membershipLabel(fact)}`, width, '…', false)),
      color.textDim(truncateToWidth(`Updated: ${formatSessionAge(row.updatedAt)}`, width, '…', false)),
      ...(this.snapshot.resumePending
        ? []
        : [color.textMuted(truncateToWidth('Space for read-only details', width, '…', false))]),
    ]
  }

  /** The read-only Peek body: ONE scrollable plain-text column. */
  private renderPeekPane(width: number, budget: number): PaneRender {
    const peek = this.peek
    // The Peek body is pinned to its OWN Session id: a roster refresh that
    // re-anchors the list selection must never swap the visible detail.
    const row = peek === undefined ? undefined : this.rowById(peek.sessionId)
    if (peek === undefined || row === undefined) {
      return { lines: [color.textMuted('Peek closed')].slice(0, budget), regions: [] }
    }
    const fact = this.frameView().rowsById.get(row.id)
    const all = this.peekLines(row, fact, width)
    const maxScroll = Math.max(0, all.length - Math.max(1, budget - 1))
    peek.scrollRow = Math.min(Math.max(0, peek.scrollRow), maxScroll)
    const lines = all.slice(peek.scrollRow, peek.scrollRow + Math.max(1, budget - 1))
    const regions: HitRegion[] = []
    // The ONE back affordance is the last physical row of the pane.
    const openable = peek.sessionId !== this.options.currentSessionId && !this.snapshot.resumePending
    const backText = openable
      ? 'Esc back · Space close · Enter open'
      : 'Esc back · Space close'
    const back = color.textMuted(fit(backText, width))
    regions.push({ kind: 'peek-back', xStart: 0, xEnd: Math.max(0, width - 1), line: Math.min(lines.length, budget - 1) })
    lines.push(back)
    return { lines: lines.slice(0, budget), regions }
  }

  private peekLines(
    row: SessionBrowserRow,
    fact: SessionWorkspaceRowFact | undefined,
    width: number,
  ): string[] {
    const line = (label: string, value: string, kind: 'text' | 'dim' | 'muted' = 'text'): string => {
      const painted = `${color.textDim(`${label}:`)} ${kind === 'text' ? color.text(value) : kind === 'dim' ? color.textDim(value) : color.textMuted(value)}`
      return fit(painted, width)
    }
    const lines: string[] = []
    const title = row.title === undefined || row.title === '' ? '(untitled)' : sanitizedPhysicalLine(row.title)
    lines.push(color.textStrong(truncateToWidth(`Peek · ${sanitizedPhysicalLine(shortSessionId(row.id))}`, width, '…', false)))
    lines.push(line('Title', title))
    lines.push(line('Session ID', sanitizedPhysicalLine(row.id), 'dim'))
    lines.push(line('Workspace', this.membershipLabel(fact)))
    lines.push(line('cwd', row.cwd === undefined ? 'Unknown' : sanitizedPhysicalLine(row.cwd), 'dim'))
    lines.push(line('Preset', row.preset === undefined ? 'Unknown' : sanitizedPhysicalLine(row.preset)))
    lines.push(line('Updated', formatSessionAge(row.updatedAt), 'dim'))
    lines.push(line('Running', fact?.running === true ? 'Yes' : fact?.running === false ? 'No' : 'Unknown'))
    lines.push(line('Pending', fact === undefined ? 'Unknown' : SESSION_PENDING_LABEL[fact.pending]))
    lines.push(line('Source', fact === undefined ? 'unknown' : SESSION_SOURCE_LABEL[fact.source], 'dim'))
    const snippet = this.searchMode
      ? this.snapshot.searchResults.find(result => result.row.id === row.id)?.snippet
      : undefined
    if (snippet !== undefined) lines.push(line('Content hit', `…${sanitizedPhysicalLine(snippet)}…`, 'dim'))
    if (row.id !== this.options.currentSessionId && !this.snapshot.resumePending) {
      lines.push(color.textMuted(fit('Open: Enter (switch session, re-proved by the read owner)', width)))
    }
    return lines
  }

  private rowById(sessionId: string): SessionBrowserRow | undefined {
    return this.snapshot.rows.find(row => row.id === sessionId)
      ?? this.snapshot.searchResults.find(result => result.row.id === sessionId)?.row
  }

  /** The ONE truthful status text of one classified row. */
  private statusLabel(fact: SessionWorkspaceRowFact): string {
    return workspaceRowStatusLabel(fact)
  }

  private membershipLabel(fact: SessionWorkspaceRowFact | undefined): string {
    if (fact === undefined) return 'Unknown'
    switch (fact.membership.kind) {
      case 'unknown':
        return 'Unknown'
      case 'unassigned':
        return 'Unassigned'
      case 'ambiguous':
        return `Ambiguous (${fact.membership.workspaceIds.map(id => sanitizedPhysicalLine(id)).join(', ')})`
      case 'assigned':
        // The official Workspace id is the authoritative identity; the Host
        // title is display text that may repeat or be empty. Peek/preview keep
        // the FULL sanitized id so the read-only identity is unambiguous.
        return fact.membership.workspaceIds
          .map(id => {
            const title = sanitizedPhysicalLine(this.workspaces.byId.get(id)?.title ?? '')
            return `${title === '' ? 'Workspace' : title} (${sanitizedPhysicalLine(id)})`
          })
          .join(' · ')
    }
  }

  private browseRowLine(row: SessionBrowserRow, fact: SessionWorkspaceRowFact, selected: boolean, width: number): string {
    const current = row.id === this.options.currentSessionId
    const marker = selected ? color.primary('> ') : '  '
    const currentMark = current ? color.success('● ') : ''
    const shortId = sanitizedPhysicalLine(shortSessionId(row.id))
    const title = row.title === undefined ? undefined : sanitizedPhysicalLine(row.title)
    const status = this.statusLabel(fact)
    const paintedStatus = fact.priority === 'needs' || fact.pending === 'unverified'
      ? color.textStrong(status)
      : color.textMuted(status)
    const meta = [
      status === '' ? undefined : paintedStatus,
      color.textMuted(formatSessionAge(row.updatedAt)),
      color.textDim(workspaceKey(row.cwd)),
    ].filter((part): part is string => part !== undefined).join(color.textMuted(' · '))
    const columns = rowColumns(identityWidth(shortId, title), width)
    const label = truncateToWidth(identityText(shortId, title, selected), columns.identity, '…', false)
    const secondary = columns.meta > 0 ? truncateToWidth(meta, columns.meta, '…', false) : ''
    return fit(
      `${marker}${currentMark}${padColumn(label, columns.identity)}${secondary === '' ? '' : `  ${secondary}`}`,
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
    const source = result.source === 'Both' ? 'metadata+content' : result.source.toLowerCase()
    const meta = [
      color.textMuted(`${source} · ${formatSessionAge(row.updatedAt)}`),
      color.textDim(workspaceKey(row.cwd)),
    ].join(color.textMuted(' · '))
    const snippet = result.snippet === undefined ? '' : ` · …${sanitizedPhysicalLine(result.snippet)}…`
    const columns = rowColumns(identityWidth(shortId, title), width)
    const label = truncateToWidth(identityText(shortId, title, selected), columns.identity, '…', false)
    const secondary = columns.meta > 0 ? truncateToWidth(`${meta}${snippet}`, columns.meta, '…', false) : ''
    return fit(
      `${marker}${currentMark}${padColumn(label, columns.identity)}${secondary === '' ? '' : `  ${secondary}`}`,
      width,
    )
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
      push(`session listing failed: ${sanitizedPhysicalLine(snapshot.listError ?? 'unknown error')}`, 'error')
    } else if (snapshot.listState === 'unavailable') {
      push('session persistence unavailable')
    } else if (snapshot.listState === 'empty') {
      push('No readable sessions')
    } else if (snapshot.listState === 'loading') {
      push('Loading sessions…')
    }
    if (snapshot.refreshError !== undefined) {
      push(`session list refresh failed: ${sanitizedPhysicalLine(snapshot.refreshError)}`)
    }
    if (this.activityError !== undefined) {
      push(`Activity unavailable: ${sanitizedPhysicalLine(this.activityError)}`)
    }
    if (this.workspaceError !== undefined) push(this.workspaceError)
    if (this.searchMode) {
      if (snapshot.searchState === 'loading') {
        push('Searching sessions…')
      } else if (snapshot.searchState === 'unavailable') {
        push('content search unavailable')
      } else if (snapshot.searchState === 'error') {
        push(sessionBrowserErrorNotice('search', snapshot.searchError ?? 'unknown error'), 'error')
      }
      if (snapshot.hasMore) push('More content matches exist — refine the search.')
    }
    if (snapshot.projectionError !== undefined) {
      push(sessionBrowserErrorNotice('projection', snapshot.projectionError))
    }
    // The transient freshness fact paints LAST among the panel's own statuses:
    // a short frame must never spend its budget on "still reading" while a real
    // error line goes unpainted.
    if (this.activityError === undefined && snapshot.listRevision > this.activitySampleRevision) {
      push('Reading session activity…')
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

  private renderActionBar(width: number): string {
    const segments = this.actionBarSegments()
    return color.textMuted(renderActionBarRow(segments, width))
  }

  /** The ONE current Enter verb of the selected typed row. */
  private enterAction(row: PiTuiWorkspaceTreeRow): { readonly text: string; readonly short: string } {
    switch (row.kind) {
      case 'folder':
        if (this.chooserMode() && this.options.currentSessionId === undefined && this.workspaces.byId.has(row.workspaceId)) {
          return { text: 'Enter Choose workspace', short: 'Choose' }
        }
        return row.expanded ? { text: 'Enter Collapse', short: 'Collapse' } : { text: 'Enter Expand', short: 'Expand' }
      case 'newSession':
        return { text: 'Enter New session', short: 'New' }
      case 'addDirectory':
        return { text: 'Enter Add directory', short: 'Add' }
      case 'showMore':
        return { text: 'Enter More sessions', short: 'More' }
      case 'session':
        return { text: 'Enter Open', short: 'Open' }
    }
  }

  private actionBarSegments(): { text: string; priority: number; short?: string }[] {
    if (this.directoryEntryActive) {
      return this.directorySubmitting
        ? [{ text: 'Verifying directory', priority: 9, short: 'Verifying' }]
        : [
            { text: 'Enter Verify directory', priority: 7, short: 'Verify' },
            { text: 'Esc Cancel', priority: 9, short: 'Cancel' },
          ]
    }
    if (this.focus === 'peek') {
      const openable = this.peek?.sessionId !== this.options.currentSessionId && !this.snapshot.resumePending
      return [
        { text: 'Up/Down scroll', priority: 6, short: 'Scroll' },
        ...(openable ? [{ text: 'Enter open', priority: 7, short: 'Open' }] : []),
        { text: 'Space close', priority: 5, short: 'Space' },
        { text: 'Esc back', priority: 9, short: 'Esc' },
      ]
    }
    if (this.focus === 'search-results') {
      const painted = new Set(this.lastPaintedResultIds)
      const selectedPainted = this.selectedSearchSessionId !== undefined && painted.has(this.selectedSearchSessionId)
      const segments: { text: string; priority: number; short?: string }[] = []
      if (painted.size >= 2) segments.push({ text: 'Up/Down move', priority: 6, short: 'Move' })
      if (selectedPainted && !this.snapshot.resumePending) {
        segments.push({ text: 'Space peek', priority: 4, short: 'Peek' })
        // The opened Session is a legal search hit, but Enter on it is the
        // same deliberate no-op as in the browse tree.
        if (this.selectedSearchSessionId !== this.options.currentSessionId) {
          segments.push({ text: 'Enter open', priority: 7, short: 'Open' })
        }
      }
      segments.push({ text: 'Esc back', priority: 9, short: 'Esc' })
      return segments
    }
    if (this.focus === 'search') {
      return [
        ...(this.snapshot.searchResults.length > 0
          ? [{ text: 'Enter results', priority: 5, short: 'Results' }]
          : []),
        { text: 'Esc back', priority: 9, short: 'Esc' },
      ]
    }
    if (this.newSessionPending !== undefined) {
      return [
        { text: 'Starting session…', priority: 9, short: 'Starting' },
        { text: '/ search', priority: 5, short: '/' },
        { text: 'Esc close', priority: 9, short: 'Esc' },
      ]
    }
    // Browse: advertise ONLY what the painted frame can really execute.
    const painted = new Set(this.lastPaintedTreeIds)
    const paintedRows = this.treeRowsCache.filter(row => painted.has(row.id))
    const selected = this.selectedBrowseRow()
    const selectedPainted = selected !== undefined && painted.has(selected.id)
    const paintedFolders = paintedRows.filter(row => row.kind === 'folder').length
    const folderCount = this.treeRowsCache.filter(row => row.kind === 'folder').length
    const segments: { text: string; priority: number; short?: string }[] = []
    if (paintedFolders > 0 && folderCount >= 2) {
      segments.push({ text: `${SESSION_WORKSPACE_CHORDS.folderCycle.label} Workspace`, priority: 3, short: 'Tab' })
    }
    if (paintedRows.length >= 2) segments.push({ text: 'Up/Down move', priority: 6, short: 'Move' })
    if (selected !== undefined && selectedPainted
      && !(selected.kind === 'session' && this.snapshot.resumePending)) {
      if (selected.kind === 'session' && selected.sessionId === this.options.currentSessionId) {
        // Enter on the opened Session is a deliberate no-op: advertise only
        // the read-only Peek it really supports.
        segments.push({ text: 'Space peek', priority: 4, short: 'Peek' })
      } else {
        const enter = this.enterAction(selected)
        segments.push({ text: enter.text, priority: 7, short: enter.short })
        if (selected.kind === 'session') segments.push({ text: 'Space peek', priority: 4, short: 'Peek' })
      }
    }
    segments.push({ text: '/ search', priority: 5, short: '/' })
    segments.push({ text: 'Esc close', priority: 9, short: 'Esc' })
    return segments
  }
}
