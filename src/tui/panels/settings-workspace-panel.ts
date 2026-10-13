/**
 * Phase 3B / B2-A — the fullscreen Settings workspace panel.
 *
 * ONE client-local component owns the whole read-only Settings surface: the
 * three-level `categories → rows → detail` navigation shared by EVERY width,
 * the responsive projection that only decides how many panes of the current
 * level are visible (wide three columns, medium two, narrow one), the per-open
 * selection and scroll state, and the last-painted mouse hit map.
 * It is the layout ROOT of the temporary Settings alt screen
 * (`TuiApp.openSettingsWorkspace`), so every key arrives on its own
 * {@link SettingsWorkspacePanel.handleInput} and every click on the alt
 * screen's `onCellPress`/`onCellClick` is re-proved against the cells this
 * component actually painted.
 *
 * The panel owns NO configuration authority: its rows are a detached read
 * projection assembled by the `/settings` command from the existing ConfigPort /
 * DisplayState / presentation-preference readers, and the only verbs it exposes
 * are navigate, refresh (re-read the same authority), copy the exact source
 * value and hand off to the existing legacy settings editor. B2-A never writes.
 * @module @xmoon76/dsh-pi-tui/tui/panels/settings-workspace-panel
 */

import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'

/** The three frozen B2-A categories. */
export type SettingsWorkspaceCategoryId = 'appearance' | 'display' | 'other'

/** The navigation level: `categories` (L0) → `rows` (L1) → `detail` (L2).
 *  This is the SAME state in every width — the layout only decides which
 *  panes of the current level are visible. */
export type SettingsWorkspacePage = 'categories' | 'rows' | 'detail'

/** The stable identity of one readonly pilot row. */
export type SettingsWorkspaceRowId =
  | 'theme'
  | 'icon-style'
  | 'display-preset'
  | 'thinking'
  | 'legacy-settings'

/** How current one row's value is, as the reader proved it. */
export type SettingsWorkspaceFreshness = 'runtime' | 'ready' | 'last-known' | 'unavailable' | 'read-error'

/**
 * The two pilot rows Phase 3B / B2-B makes truly editable. Nothing else in the
 * workspace is writable: `icon-style` and `thinking` stay readable rows and the
 * complete editor stays behind `legacy-settings`.
 */
export type SettingsWorkspaceWritableField = 'theme' | 'display-preset'

/** One selectable candidate of a writable row. `value` is the EXACT identity
 *  that gets applied and persisted (a source-qualified theme id, a display
 *  preset); `label` is presentation only and is never round-tripped back. */
export interface SettingsWorkspaceEditOption {
  readonly value: string
  readonly label: string
  /** Whether the candidate's source is live RIGHT NOW: a gone plugin or file is
   *  still listed (the row must not lie about the stored value) but can never be
   *  confirmed into a commit. */
  readonly available: boolean
  /** Whether this value is the one the authoritative read just returned. */
  readonly current: boolean
}

/**
 * The write channel of ONE writable row: the candidate source plus the two
 * facts the Detail must keep distinguishable — the live RUNTIME fact and the
 * PERSISTED document fact. Both are detached display strings; the authority
 * behind them stays the ConfigPort / the runtime state owner.
 */
export interface SettingsWorkspaceEdit {
  readonly field: SettingsWorkspaceWritableField
  readonly options: readonly SettingsWorkspaceEditOption[]
  /** Which fact the row's primary `Value`/`summary` expresses; the Detail names
   *  the OTHER one explicitly so runtime and persistence are never conflated. */
  readonly primary: 'runtime' | 'persisted'
  /** The live runtime fact (the applied palette name / the live preset). */
  readonly runtime: string
  /** The persisted document fact AS THE READ PROVED IT: the stored value, `not
   *  set` when the readable document carries no value, or an explicit
   *  `unknown — …` when there was no document to read. The panel never guesses
   *  which of those it is. */
  readonly persisted: string
}

/**
 * ONE row of the detached read projection. `summary` is the human-facing
 * display value, `value` is the exact source value the user copies (a
 * source-qualified theme id, a raw configured icon style, a runtime preset) —
 * never a re-derived display string.
 */
export interface SettingsWorkspaceRow {
  readonly id: SettingsWorkspaceRowId
  readonly category: SettingsWorkspaceCategoryId
  readonly label: string
  readonly summary: string
  readonly value?: string
  readonly scope: string
  readonly freshness: SettingsWorkspaceFreshness
  readonly description: string
  readonly action: 'inspect' | 'open-legacy'
  /** Present ONLY on the writable pilot rows (B2-B). A row without it is never
   *  editable, whatever its action. */
  readonly edit?: SettingsWorkspaceEdit
}

/** One commit the user explicitly confirmed in the L2 choice. */
export interface SettingsWorkspaceCommitRequest {
  readonly field: SettingsWorkspaceWritableField
  readonly value: string
}

/**
 * The REAL outcome of one commit, as the authority proved it. `verified` is
 * earned only by a completed mutation plus an authoritative re-read that agrees;
 * `not-saved` is a write the authority REFUTED (it is current and does not carry
 * the value); `unverified` is a write that returned success while the
 * authoritative readback could not complete; `indeterminate` is a rejected write
 * whose outcome the backend cannot attribute — the authority already carries the
 * requested value, or could not be read — so neither acceptance nor refusal may be
 * claimed about THIS commit. The runtime fact may have been applied in every
 * non-`verified` case and is reported separately.
 */
export interface SettingsWorkspaceCommitOutcome {
  readonly outcome: 'verified' | 'not-saved' | 'unverified' | 'indeterminate'
  readonly reason?: string
}

/** The snapshot one open/refresh reads from the live authorities. */
export interface SettingsWorkspaceSnapshot {
  readonly configReadiness: 'ready' | 'stale' | 'unavailable'
  readonly rows: readonly SettingsWorkspaceRow[]
  readonly capturedAt: number
  readonly readIssue?: string
}

/** The read-only projection the app supplies (no shadow store, no watch). */
export interface SettingsWorkspaceSource {
  readSnapshot(): SettingsWorkspaceSnapshot
}

/** The client-local capabilities the panel consumes. */
export interface SettingsWorkspacePanelIntents {
  /** The live terminal row budget (the panel never reads the terminal itself). */
  readonly rows: () => number
  /** The live terminal column budget (the projection's width). */
  readonly columns: () => number
  readonly requestRender: () => void
  /** The ONE app-owned transient notice (never a second notice store). */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** Esc/Backspace from the outermost level (`categories`); every layout
   *  steps one level back before it can close. */
  readonly onClose: () => void
  /** The compatibility bridge: open the existing complete settings editor. */
  readonly onOpenLegacy: () => void
  /** Copy the exact captured source value through the app's clipboard owner. */
  readonly onCopy: (text: string) => void
  /**
   * The ONE owned write channel of a writable row. The app dispatches it
   * through its `runOwned` task entry and calls `settle` exactly once with the
   * REAL outcome (possibly synchronously — the panel commits the pending phase
   * before it hands the request over); the panel only presents it.
   */
  readonly onCommit?: (
    request: SettingsWorkspaceCommitRequest,
    settle: (outcome: SettingsWorkspaceCommitOutcome) => void,
  ) => void
}

/**
 * The transient per-open editing phase. This is PRESENTATION state only: the
 * durable authority stays the ConfigPort, and no phase ever outlives the panel.
 */
type SettingsWorkspaceEditPhase =
  | { readonly kind: 'browsing' }
  | { readonly kind: 'choosing'; readonly field: SettingsWorkspaceWritableField; readonly candidate: string; readonly index: number }
  | { readonly kind: 'pending'; readonly field: SettingsWorkspaceWritableField; readonly requestId: number; readonly attempted: string }
  | {
      readonly kind: 'settled'
      readonly field: SettingsWorkspaceWritableField
      readonly requestId: number
      readonly attempted: string
      readonly outcome: SettingsWorkspaceCommitOutcome['outcome']
      readonly reason?: string
    }

type SettingsLayout = 'wide' | 'medium' | 'narrow'

interface SettingsChromePlan {
  readonly width: number
  readonly rows: number
  readonly layout: SettingsLayout
  readonly headerRows: number
  readonly metaRows: number
  readonly ruleRows: number
  readonly noticeRows: number
  readonly actionRows: number
  readonly bodyRows: number
}

interface PaneBox {
  /** Absolute panel column of the pane. */
  readonly x: number
  readonly width: number
  /** Absolute panel row of the pane's first CONTENT line. */
  readonly contentTop: number
  readonly contentRows: number
  /** The scrollable extent measured at paint. */
  readonly maxOffset: number
}

interface PaneBoxes {
  categories?: PaneBox
  rows?: PaneBox
  detail?: PaneBox
}

/** One pane the current frame actually paints: its level and absolute geometry.
 *  Hidden panes of the two-pane medium projection simply have no entry. */
interface PaneLayout {
  readonly page: SettingsWorkspacePage
  readonly x: number
  readonly width: number
}

interface HitTarget {
  readonly kind: 'category' | 'row' | 'copy' | 'legacy' | 'pane' | 'change' | 'retry' | 'option' | 'confirm' | 'cancel'
  /** The stable identity: a category id, a row id, the pane name, a candidate
   *  value or the button verb. */
  readonly id: string
  /** Absolute panel row of the painted cell. */
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

/** One painted Detail action. A button publishes a hit target ONLY when the
 *  frame really painted it inside the pane width. */
interface DetailButton {
  readonly verb: 'change' | 'retry' | 'copy' | 'legacy' | 'confirm' | 'cancel'
  readonly text: string
  /** The candidate a confirm/cancel acts on (undefined for the other verbs). */
  readonly value?: string
}

interface DetailProjection {
  readonly lines: readonly string[]
  readonly content: readonly string[]
  readonly viewport: number
  readonly buttons: readonly { readonly button: DetailButton; readonly startCol: number }[]
  /** The candidate rows the choice projection really painted, as offsets inside
   *  the granted viewport: only these may publish an `option` hit target. */
  readonly optionRows: readonly { readonly value: string; readonly line: number; readonly endCol: number }[]
}

const CATEGORY_ORDER: readonly SettingsWorkspaceCategoryId[] = ['appearance', 'display', 'other']

const CATEGORY_LABELS: Record<SettingsWorkspaceCategoryId, string> = {
  appearance: 'Appearance',
  display: 'Display',
  other: 'Other settings',
}

const WIDE_CATEGORY_WIDTH = 22
const WIDE_ROWS_WIDTH = 42
/** The medium projection's leading categories column (L0 only). */
const MEDIUM_CATEGORY_WIDTH = 22
/** The medium projection's leading rows column (L1/L2). */
const MEDIUM_ROWS_WIDTH = 40
const COLUMN_GAP = 2

/** The minimum column count of the two-column (medium) projection. */
export const SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS = 76
/** The minimum column count of the three-column (wide) projection. */
const WIDE_MIN_COLUMNS = 108

/** The frozen responsive breakpoints of THIS component (not a project rule). */
function layoutForWidth(width: number): SettingsLayout {
  if (width >= WIDE_MIN_COLUMNS) return 'wide'
  if (width >= SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS) return 'medium'
  return 'narrow'
}

/**
 * The ONE per-frame row allocation, in the frozen §4.4 priority order: the
 * Action Bar and the Header are granted first, then the BODY keeps at least one
 * real row (from three terminal rows on), then the optional notice (rows>=6,
 * body>=2 after it) and freshness/scope metadata (rows>=8, body>=3 after it).
 * The decorative rules are LAST: they are granted only when the body would still
 * keep three real rows, so decoration never crowds out readable content.
 */
function planSettingsChrome(width: number, rows: number, noticeLive: boolean): SettingsChromePlan {
  const safeRows = Math.max(1, Math.floor(rows))
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  // Rows the body could use once the mandatory chrome is granted.
  const base = Math.max(0, safeRows - headerRows - actionRows)
  // §4.4: the notice keeps the body at two rows; the metadata keeps it at three.
  const noticeRows = safeRows >= 6 && noticeLive && base - 1 >= 2 ? 1 : 0
  const metaRows = safeRows >= 8 && base - noticeRows - 1 >= 3 ? 1 : 0
  const bodyWithoutRules = base - noticeRows - metaRows
  const ruleRows = bodyWithoutRules >= 5 ? 2 : 0
  const bodyRows = Math.max(0, bodyWithoutRules - ruleRows)
  return {
    width,
    rows: safeRows,
    layout: layoutForWidth(width),
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    actionRows,
    bodyRows,
  }
}

/** Truncate one rendered line to the pane width and pad it with plain spaces. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Pad a body projection to its granted viewport so the frame never under-paints. */
function padBody(lines: string[], viewport: number, width: number): string[] {
  while (lines.length < viewport) lines.push(fit('', width))
  return lines.slice(0, viewport)
}

/** Keep the selected index inside its viewport with the smallest rebase. */
function rebaseOffset(offset: number, selected: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  let next = offset
  if (selected < next) next = selected
  if (selected >= next + viewport) next = selected - viewport + 1
  const max = Math.max(0, count - viewport)
  return Math.min(Math.max(0, next), max)
}

/** Clamp a user-authored scroll offset without pulling the selection back. */
function clampOffset(offset: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  return Math.min(Math.max(0, offset), Math.max(0, count - viewport))
}

/**
 * The Detail display projection of arbitrary source text: complete terminal
 * sequences and unknown control bytes are stripped (the display boundary), but
 * the MEANINGFUL whitespace controls are made visible as `\n` / `\r` / `\t`,
 * other controls as `\xNN`, and a literal backslash as `\\`. The projection is
 * therefore AMBIGUITY-FREE — a raw newline and a literal `\n` can never render
 * identically — while the raw copy source stays the untouched DTO value.
 */
function escapedPhysicalLine(text: string): string {
  const stripped = stripTerminalSequences(text)
  let out = ''
  for (const character of stripped) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\\') out += '\\\\'
    else if (character === '\n') out += '\\n'
    else if (character === '\r') out += '\\r'
    else if (character === '\t') out += '\\t'
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += character
  }
  return out
}

function freshnessText(
  row: SettingsWorkspaceRow,
  readiness: SettingsWorkspaceSnapshot['configReadiness'],
): string {
  switch (row.freshness) {
    case 'runtime':
      return 'Runtime now · live Client state'
    case 'ready':
      return 'Ready · on-open snapshot'
    case 'last-known':
      return readiness === 'unavailable'
        ? 'Last-known value · backend unavailable'
        : 'Last-known value · reconnecting'
    case 'unavailable':
      return 'Unavailable — no authoritative config document'
    case 'read-error':
      return 'Read error — the configuration document could not be read'
  }
}

/**
 * The Settings workspace component. Constructed per open with the live read
 * source; `dispose()` only retires local interaction state (there are no
 * timers or listeners to release).
 */
export class SettingsWorkspacePanel implements Component {
  private snapshot: SettingsWorkspaceSnapshot
  private categoryId: SettingsWorkspaceCategoryId = 'appearance'
  private rowId: SettingsWorkspaceRowId
  /** The ONE navigation level, shared by every width; a new open always starts
   *  on L0 so the first Enter/Esc means the same thing at any terminal size. */
  private focus: SettingsWorkspacePage = 'categories'
  private categoryOffset = 0
  private rowOffset = 0
  private detailOffset = 0
  private paintedTargets: readonly HitTarget[] = []
  private paintedPanes: PaneBoxes = {}
  private paintedViewport = 1
  /** The state version a press must still match at release: every navigation,
   *  refresh or focus change bumps it, so a gesture that spans a data or page
   *  change is refused instead of acting on the newer snapshot. */
  private revision = 0
  private pressedGesture: {
    readonly target: HitTarget
    readonly revision: number
    readonly focus: SettingsWorkspacePage
    readonly categoryId: SettingsWorkspaceCategoryId
    /** The LIVE terminal geometry at press time. A resize is a gesture boundary
     *  by itself: the repaint that bumps {@link revision} is only SCHEDULED by
     *  the resize, so a release arriving before it must still be refused. */
    readonly columns: number
    readonly rows: number
  } | undefined
  /** The last selection index AND viewport height each list was rebased
   *  against: the wheel may scroll a list so its selection leaves the viewport,
   *  so only a SELECTION or VIEWPORT change (never a plain repaint) may pull it
   *  back — while a real shrink must reveal the selection again. */
  private lastCategoryIndex = -1
  private lastRowIndex = -1
  private lastCategoryViewport = -1
  private lastRowViewport = -1
  /** The last painted geometry: a terminal resize between a press and its
   *  release must refuse the gesture even when the target's own geometry is
   *  unchanged (the plan's "sizes changed ⇒ reject"). */
  private lastRenderWidth = -1
  private lastRenderRows = -1
  private chrome: SettingsChromePlan | undefined
  private disposed = false
  /** The ONE transient editing phase of THIS open workspace (presentation
   *  only; the durable authority stays the ConfigPort). */
  private editPhase: SettingsWorkspaceEditPhase = { kind: 'browsing' }
  /** The per-open commit identity: a settlement that does not match the live
   *  request is refused (a superseded or post-close result can never repaint). */
  private editRequestId = 0
  /** The candidate viewport offset of the choice projection. */
  private choiceOffset = 0
  /** The candidate index/viewport/WIDTH the choice list was last rebased against. */
  private lastChoiceIndex = -1
  private lastChoiceViewport = -1
  private lastChoiceWidth = -1
  private readonly source: SettingsWorkspaceSource
  private readonly intents: SettingsWorkspacePanelIntents

  constructor(source: SettingsWorkspaceSource, intents: SettingsWorkspacePanelIntents) {
    this.source = source
    this.intents = intents
    this.snapshot = source.readSnapshot()
    this.rowId = this.firstRowOf(this.categoryId)
  }

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const liveRows = this.intents.rows()
    // A terminal resize is a gesture boundary: a press recorded against the old
    // geometry must not resolve against the new one, even when the target's own
    // cells did not move (the plan's "sizes changed ⇒ reject").
    if (this.lastRenderWidth >= 0 && (this.lastRenderWidth !== width || this.lastRenderRows !== liveRows)) {
      this.bumpRevision()
    }
    this.lastRenderWidth = width
    this.lastRenderRows = liveRows
    const plan = planSettingsChrome(width, liveRows, this.intents.notice() !== undefined)
    this.chrome = plan
    const lines: string[] = []
    const targets: HitTarget[] = []
    const panes: PaneBoxes = {}
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows >= 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    const bodyTop = plan.headerRows + plan.metaRows + (plan.ruleRows >= 1 ? 1 : 0)
    if (plan.bodyRows > 0) lines.push(...this.renderBody(plan, bodyTop, targets, panes))
    if (plan.ruleRows >= 2) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    if (plan.actionRows === 1) lines.push(this.renderActionBar(plan))
    this.paintedTargets = targets
    this.paintedPanes = panes
    return lines.slice(0, plan.rows)
  }

  invalidate(): void {}

  /** The ONE level breadcrumb, identical in every layout: `Categories` →
   *  `<Category> · Rows` → `<Category> / <Row label>`. It paints no hit target:
   *  the header is no longer a category focus owner or switch. */
  private renderHeader(plan: SettingsChromePlan): string[] {
    const row = this.selectedRow()
    const breadcrumb = this.focus === 'categories'
      ? 'Categories'
      : this.focus === 'rows'
        ? `${CATEGORY_LABELS[this.categoryId]} · Rows`
        : `${CATEGORY_LABELS[this.categoryId]} / ${row?.label ?? '—'}`
    const title = `SETTINGS · ${breadcrumb}`
    const lead = `${color.primary('SETTINGS')}${color.textMuted(title.slice('SETTINGS'.length))}`
    // The header states which rows the workspace can really change. The narrow
    // projection is width-starved: the breadcrumb keeps the whole line there
    // instead of ceding cells to a badge it can still show at 76+ columns.
    const editable = this.snapshot.rows.reduce((count, row) => count + (row.edit === undefined ? 0 : 1), 0)
    const right = editable === 0 || plan.layout === 'narrow'
      ? ''
      : `${editable} editable ${editable === 1 ? 'row' : 'rows'}`
    return [composeEdge(lead, right === '' ? '' : color.textMuted(right), plan.width)]
  }

  private renderMetadata(plan: SettingsChromePlan): string {
    const row = this.selectedRow()
    const scope = row?.scope ?? 'TUI preferences'
    const captured = new Date(this.snapshot.capturedAt)
    const hh = String(captured.getHours()).padStart(2, '0')
    const mm = String(captured.getMinutes()).padStart(2, '0')
    const text = `Scope: ${scope}  ·  Refreshed ${hh}:${mm} / Config ${this.snapshot.configReadiness.toUpperCase()}`
    return fit(color.textMuted(sanitizedPhysicalLine(text)), plan.width)
  }

  private renderNotice(plan: SettingsChromePlan): string {
    const notice = this.intents.notice()
    if (notice === undefined) return fit('', plan.width)
    const text = sanitizedPhysicalLine(notice.text)
    return fit(notice.kind === 'error' ? color.error(text) : color.textDim(text), plan.width)
  }

  private renderBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    if (plan.layout === 'narrow') return this.renderNarrowBody(plan, bodyTop, targets, panes)
    return this.renderColumnBody(plan, bodyTop, targets, panes)
  }

  /** The panes the CURRENT navigation level projects at this width: wide paints
   *  all three, medium paints the current level's list plus its adjacent pane,
   *  narrow paints the current level alone. Hidden panes are neither painted nor
   *  addressable, and no second "visible window" state is stored. */
  private visiblePaneLayout(plan: SettingsChromePlan): readonly PaneLayout[] {
    if (plan.layout === 'wide') {
      const rowsX = WIDE_CATEGORY_WIDTH + COLUMN_GAP
      const detailX = rowsX + WIDE_ROWS_WIDTH + COLUMN_GAP
      return [
        { page: 'categories', x: 0, width: WIDE_CATEGORY_WIDTH },
        { page: 'rows', x: rowsX, width: WIDE_ROWS_WIDTH },
        { page: 'detail', x: detailX, width: Math.max(1, plan.width - detailX) },
      ]
    }
    // Medium L0 is `categories | rows`; L1/L2 are `rows | detail`. The leading
    // pane therefore has a different width per level, and every row line is laid
    // out against the pane it is REALLY painted in.
    const lead: PaneLayout = this.focus === 'categories'
      ? { page: 'categories', x: 0, width: MEDIUM_CATEGORY_WIDTH }
      : { page: 'rows', x: 0, width: MEDIUM_ROWS_WIDTH }
    const trailX = lead.width + COLUMN_GAP
    const trail: PaneLayout = this.focus === 'categories'
      ? { page: 'rows', x: trailX, width: Math.max(1, plan.width - trailX) }
      : { page: 'detail', x: trailX, width: Math.max(1, plan.width - trailX) }
    return [lead, trail]
  }

  private renderColumnBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    // The shared pane-header line is a grant of its own: below two body rows it
    // would consume the ONLY body row, so the real content wins and the header
    // is dropped (the Action Bar still names the current pane).
    const showPaneHeader = plan.bodyRows >= 2
    const contentTop = bodyTop + (showPaneHeader ? 1 : 0)
    const contentRows = Math.max(0, plan.bodyRows - (showPaneHeader ? 1 : 0))
    this.paintedViewport = Math.max(1, contentRows)
    const layout = this.visiblePaneLayout(plan)

    // ONLY the visible panes are projected: a hidden pane can never publish a
    // hit target, own the wheel or rebase a scroll it is not showing.
    const paneLines = new Map<SettingsWorkspacePage, readonly string[]>()
    const itemHits: HitTarget[] = []
    let detailProjection: DetailProjection | undefined
    for (const pane of layout) {
      if (pane.page === 'categories') {
        const selected = CATEGORY_ORDER.indexOf(this.categoryId)
        if (selected !== this.lastCategoryIndex || contentRows !== this.lastCategoryViewport) {
          this.categoryOffset = rebaseOffset(this.categoryOffset, selected, CATEGORY_ORDER.length, contentRows)
          this.lastCategoryIndex = selected
          this.lastCategoryViewport = contentRows
        } else {
          this.categoryOffset = clampOffset(this.categoryOffset, CATEGORY_ORDER.length, contentRows)
        }
        const visible = CATEGORY_ORDER.slice(this.categoryOffset, this.categoryOffset + contentRows)
        for (let i = 0; i < visible.length; i += 1) {
          itemHits.push({ kind: 'category', id: visible[i]!, row: contentTop + i, startCol: pane.x, endCol: pane.x + pane.width })
        }
        paneLines.set('categories', visible.map(id => this.categoryLine(id)))
        continue
      }
      if (pane.page === 'rows') {
        const rows = this.currentRows()
        const selected = this.indexOfRow(rows)
        if (selected !== this.lastRowIndex || contentRows !== this.lastRowViewport) {
          this.rowOffset = rebaseOffset(this.rowOffset, selected, rows.length, contentRows)
          this.lastRowIndex = selected
          this.lastRowViewport = contentRows
        } else {
          this.rowOffset = clampOffset(this.rowOffset, rows.length, contentRows)
        }
        const visible = rows.slice(this.rowOffset, this.rowOffset + contentRows)
        for (let i = 0; i < visible.length; i += 1) {
          const row = visible[i]!
          itemHits.push({ kind: 'row', id: row.id, row: contentTop + i, startCol: pane.x, endCol: pane.x + pane.width })
        }
        // The summary truncates against the pane width this list is ACTUALLY
        // painted in; medium L0 and L1 give the same list different widths.
        paneLines.set('rows', visible.map(row => this.rowLine(row, pane.width)))
        continue
      }
      const detail = this.detailLines(pane.width, contentRows)
      detailProjection = detail
      const buttonRow = contentTop + Math.max(0, contentRows - 1)
      for (const painted of detail.buttons) {
        itemHits.push({
          kind: painted.button.verb,
          id: painted.button.value ?? this.rowId,
          row: buttonRow,
          startCol: pane.x + painted.startCol,
          endCol: pane.x + painted.startCol + visibleWidth(painted.button.text),
        })
      }
      // The candidate rows publish LAST so a click on a candidate resolves to the
      // candidate, not to the pane fallback the loop below adds.
      for (const option of detail.optionRows) {
        itemHits.push({ kind: 'option', id: option.value, row: contentTop + option.line, startCol: pane.x, endCol: pane.x + option.endCol })
      }
      paneLines.set('detail', detail.lines)
    }

    for (const pane of layout) {
      let maxOffset = Math.max(0, CATEGORY_ORDER.length - contentRows)
      if (pane.page === 'rows') maxOffset = Math.max(0, this.currentRows().length - contentRows)
      else if (pane.page === 'detail') {
        maxOffset = detailProjection === undefined ? 0 : Math.max(0, detailProjection.content.length - detailProjection.viewport)
      }
      panes[pane.page] = { x: pane.x, width: pane.width, contentTop, contentRows, maxOffset }
    }
    // Real item targets precede the pane fallback so a click resolves to the row.
    targets.push(...itemHits)
    // The pane fallback must cover the pane's WHOLE painted area (every content
    // row), so a click anywhere in a visible column can take that column's focus.
    for (const pane of layout) {
      for (let i = 0; i < contentRows; i += 1) {
        targets.push({ kind: 'pane', id: pane.page, row: contentTop + i, startCol: pane.x, endCol: pane.x + pane.width })
      }
    }

    const out: string[] = []
    if (showPaneHeader) {
      const head = layout.map((pane) => {
        const title = pane.page === 'categories'
          ? `CATEGORIES (${CATEGORY_ORDER.length})`
          : pane.page === 'rows'
            ? `SETTINGS (${this.currentRows().length})`
            : 'DETAILS'
        return fit(this.paneHeader(title, this.focus === pane.page), pane.width)
      })
      out.push(head.join(' '.repeat(COLUMN_GAP)))
    }
    for (let i = 0; i < contentRows; i += 1) {
      out.push(layout.map(pane => fit((paneLines.get(pane.page) ?? [])[i] ?? '', pane.width)).join(' '.repeat(COLUMN_GAP)))
    }
    return out
  }

  private renderNarrowBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    const width = plan.width
    const viewport = plan.bodyRows
    this.paintedViewport = Math.max(1, viewport)
    const out: string[] = []
    if (this.focus === 'categories') {
      const selectedIndex = CATEGORY_ORDER.indexOf(this.categoryId)
      if (selectedIndex !== this.lastCategoryIndex || viewport !== this.lastCategoryViewport) {
        this.categoryOffset = rebaseOffset(this.categoryOffset, selectedIndex, CATEGORY_ORDER.length, viewport)
        this.lastCategoryIndex = selectedIndex
        this.lastCategoryViewport = viewport
      } else {
        this.categoryOffset = clampOffset(this.categoryOffset, CATEGORY_ORDER.length, viewport)
      }
      const visible = CATEGORY_ORDER.slice(this.categoryOffset, this.categoryOffset + viewport)
      panes.categories = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, CATEGORY_ORDER.length - viewport) }
      for (let i = 0; i < visible.length; i += 1) {
        const id = visible[i]!
        targets.push({ kind: 'category', id, row: bodyTop + i, startCol: 0, endCol: width })
        out.push(fit(this.categoryLine(id), width))
      }
      return padBody(out, viewport, width)
    }
    if (this.focus === 'rows') {
      const rows = this.currentRows()
      const selectedIndex = this.indexOfRow(rows)
      if (selectedIndex !== this.lastRowIndex || viewport !== this.lastRowViewport) {
        this.rowOffset = rebaseOffset(this.rowOffset, selectedIndex, rows.length, viewport)
        this.lastRowIndex = selectedIndex
        this.lastRowViewport = viewport
      } else {
        this.rowOffset = clampOffset(this.rowOffset, rows.length, viewport)
      }
      const visible = rows.slice(this.rowOffset, this.rowOffset + viewport)
      panes.rows = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, rows.length - viewport) }
      for (let i = 0; i < visible.length; i += 1) {
        const row = visible[i]!
        targets.push({ kind: 'row', id: row.id, row: bodyTop + i, startCol: 0, endCol: width })
        out.push(fit(this.rowLine(row, width), width))
      }
      return padBody(out, viewport, width)
    }
    const detail = this.detailLines(width, viewport)
    panes.detail = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, detail.content.length - detail.viewport) }
    const buttonRow = bodyTop + Math.max(0, viewport - 1)
    for (const painted of detail.buttons) {
      targets.push({
        kind: painted.button.verb,
        id: painted.button.value ?? this.rowId,
        row: buttonRow,
        startCol: painted.startCol,
        endCol: painted.startCol + visibleWidth(painted.button.text),
      })
    }
    for (const option of detail.optionRows) {
      targets.push({ kind: 'option', id: option.value, row: bodyTop + option.line, startCol: 0, endCol: option.endCol })
    }
    for (let i = 0; i < viewport; i += 1) out.push(fit(detail.lines[i] ?? '', width))
    return out
  }

  private paneHeader(text: string, focused: boolean): string {
    const marked = focused ? `[${text}]` : text
    return focused ? color.borderFocus(marked) : color.textMuted(marked)
  }

  private categoryLine(id: SettingsWorkspaceCategoryId | undefined): string {
    if (id === undefined) return ''
    const selected = id === this.categoryId
    const marker = selected ? '> ' : '  '
    const text = `${marker}${CATEGORY_LABELS[id]}`
    return selected ? color.textStrong(text) : color.text(text)
  }

  private rowLine(row: SettingsWorkspaceRow | undefined, width: number): string {
    if (row === undefined) return ''
    const selected = row.id === this.rowId
    const marker = selected ? '> ' : '  '
    // The configured NAME is measured UNPADDED and owns its cells first (the
    // frozen hierarchy: the name stays identifiable, the list SUMMARY is what
    // truncates). Only a name that alone fills the pane drops the summary; the
    // remainder is then handed to the (truncatable) value, right-aligned.
    const lead = truncateToWidth(`${marker}${sanitizedPhysicalLine(row.label)}`, width, '…', false)
    const leadCells = visibleWidth(lead)
    const summaryCellRoom = Math.max(0, width - leadCells - 1)
    const value = summaryCellRoom >= 1
      ? truncateToWidth(sanitizedPhysicalLine(row.summary), summaryCellRoom, '…', false)
      : ''
    const gap = Math.max(1, width - leadCells - visibleWidth(value))
    const painted = lead + ' '.repeat(gap) + value
    return selected ? color.textStrong(painted) : color.text(painted)
  }

  /**
   * The detail pane projection: the scrollable content plus the pinned action
   * row. The pinned row costs one viewport row when both exist; a viewport too
   * short for it paints NO button, so no button is addressable either. Every
   * button that does not fit inside the pane width WHOLE is dropped with its
   * hit target — a half-painted action is never clickable.
   */
  private detailLines(width: number, viewport: number): DetailProjection {
    const row = this.selectedRow()
    const includeTitle = this.currentLayout() !== 'narrow'
    const buttons = row === undefined ? [] : this.detailButtons(row)
    const pinned = buttons.length > 0 && viewport >= 2 ? 1 : 0
    const scrollViewport = Math.max(0, viewport - pinned)
    if (this.choiceField() !== undefined && row?.edit !== undefined) {
      return this.choiceLines(row, width, scrollViewport, pinned, buttons)
    }
    const content = row === undefined ? [] : this.detailContent(row, width, includeTitle)
    const offset = Math.min(Math.max(0, this.detailOffset), Math.max(0, content.length - scrollViewport))
    this.detailOffset = offset
    const lines: string[] = []
    for (let i = 0; i < scrollViewport; i += 1) lines.push(content[offset + i] ?? '')
    const painted = pinned === 1 ? this.layoutButtons(width, buttons) : { text: '', painted: [] }
    if (pinned === 1) {
      // A row without a write channel says so instead of looking editable: the
      // complete editor stays one `Other settings` handoff away. The decoration
      // is dropped WHOLE when it does not fit — a half-cut note would read as a
      // different statement.
      const note = buttons.some(button => button.verb === 'legacy')
        ? 'opens the existing complete settings editor'
        : row !== undefined && row.edit === undefined && row.action === 'inspect'
          ? 'read-only here · Other settings edits this row'
          : ''
      const decorated = note === '' || painted.text === '' ? painted.text : `${painted.text}  ${color.textMuted(note)}`
      lines.push(fit(visibleWidth(decorated) <= width ? decorated : painted.text, width))
    }
    return { lines, content, viewport: scrollViewport, buttons: painted.painted, optionRows: [] }
  }

  /**
   * The L2 choice projection. The HEADING is pinned whenever at least one
   * candidate fits beside it (a candidate list whose subject scrolled away could
   * not be confirmed knowingly); only the candidates scroll, and a long or CJK
   * candidate label WRAPS instead of being truncated — while choosing, the list
   * is the only place the candidate identity is visible. On a one-row body the
   * heading is dropped rather than hiding the candidates.
   */
  private choiceLines(
    row: SettingsWorkspaceRow,
    width: number,
    scrollViewport: number,
    pinned: number,
    buttons: readonly DetailButton[],
  ): DetailProjection {
    const options = row.edit?.options ?? []
    const headingRows = scrollViewport >= 2 ? 1 : 0
    const listViewport = Math.max(0, scrollViewport - headingRows)
    const blocks = this.choiceBlocks(row, width)
    const flattened = blocks.flat()
    const offset = this.rebaseChoice(blocks, listViewport, width)
    // Every content line is composed UNPADDED (the frame's own composition pass
    // is the only fit), exactly like the category/row lines.
    const content: string[] = []
    if (headingRows === 1) content.push(color.textStrong(`Choose ${row.label}`))
    for (let i = 0; i < listViewport; i += 1) content.push(flattened[offset + i] ?? '')
    const lines = [...content]
    const painted = pinned === 1 ? this.layoutButtons(width, buttons) : { text: '', painted: [] }
    if (pinned === 1) lines.push(painted.text)
    const optionRows: { value: string; line: number; endCol: number }[] = []
    let cursor = 0
    for (const [index, block] of blocks.entries()) {
      const start = cursor
      cursor += block.length
      const option = options[index]
      if (option === undefined) continue
      for (let line = Math.max(start, offset); line < Math.min(cursor, offset + listViewport); line += 1) {
        optionRows.push({ value: option.value, line: headingRows + line - offset, endCol: width })
      }
    }
    // `content` is the CANDIDATE list the wheel and the rebase both scroll (the
    // pinned heading is not scrollable content and the action row is not content
    // at all), so `maxOffset` is the real candidate extent.
    return { lines, content: flattened, viewport: listViewport, buttons: painted.painted, optionRows }
  }

  /** One painted candidate, wrapped to the pane width: the first line carries the
   *  highlight marker, continuation lines the same two-cell indent. The VALUE is
   *  the identity; the source state is stated rather than implied. */
  private choiceBlocks(row: SettingsWorkspaceRow, width: number): string[][] {
    const phase = this.editPhase
    const options = row.edit?.options ?? []
    if (options.length === 0) {
      // No candidate source at all: the choice states it instead of painting an
      // empty list with a confirm button.
      return [[color.error('No candidate is available for this setting right now.')]]
    }
    return options.map((option, index) => {
      const selected = phase.kind === 'choosing' && index === phase.index
      const marker = selected ? '> ' : '  '
      const marks = [option.current ? '← current' : '', option.available ? '' : 'unavailable'].filter(Boolean).join(' · ')
      const body = `${sanitizedPhysicalLine(option.label)}${marks === '' ? '' : `  [${marks}]`}`
      const chunks = wrapTextWithAnsi(body, Math.max(1, width - 2))
      const rows = chunks.length === 0 ? [''] : chunks
      return rows.map((chunk, line) => {
        const text = `${line === 0 ? marker : '  '}${chunk}`
        return selected ? color.textStrong(text) : color.text(text)
      })
    })
  }

  /** The writable field the panel is CHOOSING for, or undefined in every other
   *  phase. The choice projection replaces the browse detail only for the row
   *  that owns the phase; any row change cancels it (see {@link resetChoice}). */
  private choiceField(): SettingsWorkspaceWritableField | undefined {
    return this.editPhase.kind === 'choosing' ? this.editPhase.field : undefined
  }

  /** Keep the highlighted candidate REVEALED: only a CANDIDATE, VIEWPORT or LAYOUT WIDTH
   *  change may pull the list back (a wheel may scroll it so the highlight leaves the
   *  viewport — a plain repaint must never fight that, while a real shrink or a narrower
   *  pane that re-flows the wrapped candidates must reveal the highlight again). A multi-line candidate reveals as a whole when it
   *  fits; when it is TALLER than the viewport its HEAD is revealed, never a
   *  marker-less continuation tail — the identity must be visible before a confirm. */
  private rebaseChoice(blocks: readonly (readonly string[])[], viewport: number, width: number): number {
    const phase = this.editPhase
    if (phase.kind !== 'choosing') return 0
    let total = 0
    const starts: number[] = []
    for (const block of blocks) {
      starts.push(total)
      total += block.length
    }
    const index = Math.min(Math.max(0, phase.index), Math.max(0, blocks.length - 1))
    const start = starts[index] ?? 0
    const end = start + (blocks[index]?.length ?? 1)
    if (index !== this.lastChoiceIndex || viewport !== this.lastChoiceViewport || width !== this.lastChoiceWidth) {
      let next = this.choiceOffset
      if (end - start > viewport) {
        // Taller than the granted list rows: the HEAD (marker + label prefix) is
        // what identifies the candidate, so the tail must never be what is shown.
        next = start
      } else {
        if (start < next) next = start
        if (end > next + viewport) next = Math.max(start, end - viewport)
      }
      this.choiceOffset = clampOffset(next, total, viewport)
      this.lastChoiceIndex = index
      this.lastChoiceViewport = viewport
      this.lastChoiceWidth = width
    } else {
      this.choiceOffset = clampOffset(this.choiceOffset, total, viewport)
    }
    return this.choiceOffset
  }

  /** The actions the pinned row may paint for this row in the CURRENT phase.
   *  A pending commit disables the edit verbs (ONE commit at a time) and a
   *  non-writable row only ever offers copy/legacy. */
  private detailButtons(row: SettingsWorkspaceRow): readonly DetailButton[] {
    const phase = this.editPhase
    if (phase.kind === 'choosing') {
      return [
        { verb: 'confirm', text: '[Confirm]', value: phase.candidate },
        { verb: 'cancel', text: '[Cancel]' },
      ]
    }
    const buttons: DetailButton[] = []
    const edit = row.edit
    if (edit !== undefined && phase.kind !== 'pending') {
      buttons.push({ verb: 'change', text: '[Change…]' })
      if (phase.kind === 'settled' && phase.field === edit.field && phase.outcome !== 'verified') {
        buttons.push({ verb: 'retry', text: '[Retry save]', value: phase.attempted })
      }
    }
    if (row.value !== undefined) buttons.push({ verb: 'copy', text: '[Copy value]' })
    else if (row.action === 'open-legacy') buttons.push({ verb: 'legacy', text: '[Open existing settings…]' })
    return buttons
  }

  /** Paint the pinned action row, dropping every button that cannot fit WHOLE:
   *  the returned column ranges are the hit targets of what is really painted.
   *  The result is UNPADDED — the caller composes it with its decoration and
   *  fits the row exactly once. */
  private layoutButtons(
    width: number,
    buttons: readonly DetailButton[],
  ): { readonly text: string; readonly painted: readonly { readonly button: DetailButton; readonly startCol: number }[] } {
    let paint = ''
    let cells = 0
    const painted: { button: DetailButton; startCol: number }[] = []
    for (const button of buttons) {
      const gap = paint === '' ? 0 : 2
      const buttonCells = visibleWidth(button.text)
      if (cells + gap + buttonCells > width) break
      paint += ' '.repeat(gap) + color.accent(button.text)
      painted.push({ button, startCol: cells + gap })
      cells += gap + buttonCells
    }
    return { text: paint, painted }
  }

  /** The commit status of the row's own field, as the last settlement reported
   *  it. Only the row that owns the phase shows it — never a global banner. */
  private editStatus(field: SettingsWorkspaceWritableField): string | undefined {
    const phase = this.editPhase
    if (phase.kind === 'pending' && phase.field === field) return 'Saving… · the Host has not confirmed yet'
    if (phase.kind !== 'settled' || phase.field !== field) return undefined
    if (phase.outcome === 'verified') return 'Verified · the authoritative read agrees'
    if (phase.outcome === 'not-saved') return `Not saved · ${phase.reason ?? 'the write was refused'}`
    if (phase.outcome === 'indeterminate') return `Outcome unknown · ${phase.reason ?? 'the write could not be attributed'}`
    return `Commit accepted · verification unavailable${phase.reason === undefined ? '' : ` · ${phase.reason}`}`
  }

  private detailContent(row: SettingsWorkspaceRow, width: number, includeTitle: boolean): string[] {
    const labelWidth = width >= 26 ? 12 : 8
    const bodyWidth = Math.max(1, width - labelWidth)
    const lines: string[] = []
    if (includeTitle) lines.push(color.textStrong(sanitizedPhysicalLine(row.label)))
    const field = (label: string, value: string): void => {
      const head = fit(color.textDim(label), labelWidth)
      const wrapped = wrapTextWithAnsi(escapedPhysicalLine(value), bodyWidth)
      const parts = wrapped.length === 0 ? [''] : wrapped
      lines.push(head + parts[0]!)
      for (const extra of parts.slice(1)) lines.push(' '.repeat(labelWidth) + extra)
    }
    field('Value', row.summary)
    if (row.value !== undefined && row.value !== row.summary) field('Source', row.value)
    const edit = row.edit
    if (edit !== undefined) {
      // The two facts are NEVER conflated: which one `Value` expresses is stated
      // by the reader (`primary`), and the OTHER one is named explicitly.
      if (edit.primary === 'persisted') field('Runtime', edit.runtime)
      else field('Persisted', edit.persisted)
      const status = this.editStatus(edit.field)
      if (status !== undefined) field('Status', status)
    }
    field('Scope', row.scope)
    field('Freshness', freshnessText(row, this.snapshot.configReadiness))
    field('Description', row.description)
    if (row.freshness === 'read-error' && this.snapshot.readIssue !== undefined) field('Issue', this.snapshot.readIssue)
    return lines
  }

  private renderActionBar(plan: SettingsChromePlan): string {
    const row = this.selectedRow()
    const copyable = row?.value !== undefined
    // The ONE Esc semantics of the unified hierarchy: L0 closes, every inner
    // level steps back, and an open L2 choice cancels first. Below the body floor
    // every navigation/clipboard action is refused, so only this Esc/back hint is
    // still honest.
    const back = this.focus === 'categories' ? 'Esc close' : 'Esc back'
    if (this.bodyFloor() < 1) return fit(color.textDim(back), plan.width)
    if (this.choiceField() !== undefined) {
      return fit(color.textDim('Esc cancel | ↑↓ select | Enter confirm'), plan.width)
    }
    if (this.editPhase.kind === 'pending') {
      return fit(color.textDim(`${back} | Saving… · one write at a time`), plan.width)
    }
    let hints: string
    if (this.focus === 'categories') {
      hints = `${back} | ↑↓ select | Enter open`
    } else if (this.focus === 'rows') {
      hints = `${back} | ↑↓ select | Enter details | R refresh`
    } else {
      const editable = row?.edit !== undefined
      hints = [
        back,
        '↑↓/Pg keys scroll',
        editable ? 'Enter change' : '',
        'R refresh',
        copyable ? 'C copy value' : '',
      ].filter(Boolean).join(' | ')
    }
    return fit(color.textDim(hints), plan.width)
  }

  // ── state helpers ────────────────────────────────────────────────────────

  private currentRows(): readonly SettingsWorkspaceRow[] {
    return this.snapshot.rows.filter(row => row.category === this.categoryId)
  }

  private firstRowOf(category: SettingsWorkspaceCategoryId): SettingsWorkspaceRowId {
    const rows = this.snapshot.rows.filter(row => row.category === category)
    return rows[0]?.id ?? this.snapshot.rows[0]?.id ?? 'theme'
  }

  private indexOfRow(rows: readonly SettingsWorkspaceRow[]): number {
    const index = rows.findIndex(row => row.id === this.rowId)
    return index < 0 ? 0 : index
  }

  private selectedRow(): SettingsWorkspaceRow | undefined {
    return this.snapshot.rows.find(row => row.id === this.rowId)
  }

  /**
   * Re-read the live facts WITHOUT touching the navigation, the commit phase or the
   * scroll. The runtime owner calls this whenever the runtime fact changes (an applied
   * palette, a cleared plugin-theme record, a new display preset): the projection is a
   * PULL snapshot, so a runtime value the writer applied before its write settled must
   * still reach the Detail — otherwise a pending (or slow, or failed) commit would keep
   * claiming the previous runtime value as the live one.
   */
  rereadFacts(): void {
    if (this.disposed) return
    this.snapshot = this.source.readSnapshot()
    // A live candidate source can change UNDER an open choice (a contribution
    // unloading re-numbers the rows). The chosen candidate is an IDENTITY, so the
    // phase is re-anchored on its VALUE: the highlight and the confirm keep naming the
    // same candidate, and a candidate whose source is gone drops the choice instead of
    // painting a confirm that can no longer dispatch it.
    const phase = this.editPhase
    if (phase.kind === 'choosing') {
      const options = this.snapshot.rows.find(row => row.edit?.field === phase.field)?.edit?.options ?? []
      const index = options.findIndex(option => option.value === phase.candidate)
      if (index < 0) this.editPhase = { kind: 'browsing' }
      else if (index !== phase.index) {
        this.editPhase = { kind: 'choosing', field: phase.field, candidate: phase.candidate, index }
      }
    }
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Re-read the same authorities; keep the stable selection when it survives. */
  private refresh(): void {
    const next = this.source.readSnapshot()
    this.snapshot = next
    if (next.rows.every(row => row.id !== this.rowId)) this.rowId = this.firstRowOf(this.categoryId)
    this.detailOffset = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Every navigation/focus/refresh change bumps the state version a pending
   *  press must still match at release. */
  private bumpRevision(): void {
    this.revision += 1
  }

  /** The per-frame body floor at the LIVE terminal height: below it every
   *  navigation/clipboard action is hidden and therefore inert. Only the row
   *  allocation matters here, and that is a pure function of the height (the
   *  width only chooses the projection). */
  private bodyFloor(): number {
    return planSettingsChrome(this.projectionWidth(), this.intents.rows(), this.intents.notice() !== undefined).bodyRows
  }

  /** The projection width: the last painted frame's, else the LIVE terminal
   *  width — a key may arrive before the first paint, and the layout it belongs
   *  to must never be guessed from a missing frame. */
  private projectionWidth(): number {
    return this.chrome?.width ?? this.intents.columns()
  }

  /** The current projection (see {@link projectionWidth}). */
  private currentLayout(): SettingsLayout {
    return layoutForWidth(this.projectionWidth())
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) return this.goBack()
    // Below the body floor the frame grants no body row: every navigation and
    // clipboard action is invisible, so only the Esc/back semantics survive
    // (never a hidden action the user cannot see). The floor is computed from
    // the LIVE height — a key may arrive BEFORE the first paint, and reading the
    // last render's plan would then swallow it.
    if (this.bodyFloor() < 1) return
    // The L2 choice is a transient phase of the SAME detail level: while it is
    // live only candidate navigation and the explicit confirm act, so no key can
    // reach a hidden editor action or a second commit.
    if (this.choiceField() !== undefined) {
      if (matchesKey(data, 'up')) return this.moveChoice(-1)
      if (matchesKey(data, 'down')) return this.moveChoice(1)
      if (matchesKey(data, 'pageUp')) return this.moveChoice(-Math.max(1, this.paintedViewport))
      if (matchesKey(data, 'pageDown')) return this.moveChoice(Math.max(1, this.paintedViewport))
      if (matchesKey(data, 'home')) return this.setChoice(0)
      if (matchesKey(data, 'end')) return this.setChoice(this.choiceCount() - 1)
      if (matchesKey(data, 'enter')) return this.confirmChoice()
      return
    }
    // The level is the ONLY navigation state: `↑↓` act on the current level and
    // `Enter` advances one level. `Tab`/`Shift+Tab` and `←`/`→` are deliberately
    // ignored — no focus cycle and no category switch — so they can neither
    // change the level nor reach the hidden editor.
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(-1)
    if (matchesKey(data, 'end')) return this.jump(1)
    if (matchesKey(data, 'enter')) return this.confirm()
    if (data === 'r' || data === 'R') return this.refresh()
    if (data === 'c' || data === 'C') return this.copy()
    // Everything else is inert inside the workspace: no key ever leaks to the
    // hidden editor, transcript or a host composer action.
  }

  /** Esc/Backspace: step one level back in EVERY layout; only L0 closes. The
   *  frame before the first paint resolves the same way, because the level (not
   *  the projection) is the state. An open L2 choice cancels FIRST — Esc in an
   *  edit never leaves the workspace and never writes. */
  private goBack(): void {
    if (this.choiceField() !== undefined) {
      this.resetChoice()
      this.intents.requestRender()
      return
    }
    if (this.focus === 'detail') {
      this.focus = 'rows'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (this.focus === 'rows') {
      this.focus = 'categories'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    this.intents.onClose()
  }

  private move(delta: number): void {
    if (this.focus === 'detail') return this.scroll(delta)
    if (this.focus === 'categories') return this.moveCategory(delta)
    this.moveRow(delta)
  }

  private page(delta: number): void {
    const step = this.paintedViewport
    if (this.focus === 'detail') return this.scroll(delta * step)
    if (this.focus === 'categories') return this.moveCategory(delta * step)
    this.moveRow(delta * step)
  }

  private jump(direction: 1 | -1): void {
    if (this.focus === 'detail') {
      this.detailOffset = direction < 0 ? 0 : Number.MAX_SAFE_INTEGER
      this.intents.requestRender()
      return
    }
    if (this.focus === 'categories') {
      this.selectCategory(CATEGORY_ORDER[direction < 0 ? 0 : CATEGORY_ORDER.length - 1]!)
      return
    }
    const rows = this.currentRows()
    if (rows.length === 0) return
    this.selectRow(rows[direction < 0 ? 0 : rows.length - 1]!.id)
  }

  private moveCategory(delta: number): void {
    const index = CATEGORY_ORDER.indexOf(this.categoryId)
    const next = Math.min(Math.max(0, index + delta), CATEGORY_ORDER.length - 1)
    this.selectCategory(CATEGORY_ORDER[next]!)
  }

  private selectCategory(category: SettingsWorkspaceCategoryId): void {
    if (category !== this.categoryId) {
      this.resetChoice()
      this.categoryId = category
      this.rowId = this.firstRowOf(category)
      this.rowOffset = 0
      this.detailOffset = 0
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private moveRow(delta: number): void {
    const rows = this.currentRows()
    if (rows.length === 0) return
    const index = this.indexOfRow(rows)
    const next = Math.min(Math.max(0, index + delta), rows.length - 1)
    this.selectRow(rows[next]!.id)
  }

  private selectRow(id: SettingsWorkspaceRowId): void {
    if (id !== this.rowId) {
      this.resetChoice()
      this.rowId = id
      this.detailOffset = 0
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private scroll(delta: number): void {
    const max = this.paintedPanes.detail?.maxOffset ?? 0
    this.detailOffset = Math.min(Math.max(0, this.detailOffset + delta), max)
    this.intents.requestRender()
  }

  private confirm(): void {
    if (this.focus === 'detail') {
      // Enter in the L2 browse detail is the ONE way into the edit phase, and
      // only a row that really carries a write channel can open one. Everywhere
      // else it stays navigation.
      return this.beginChoice()
    }
    if (this.focus === 'categories') {
      this.focus = 'rows'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const row = this.selectedRow()
    if (row?.action === 'open-legacy') {
      this.intents.onOpenLegacy()
      return
    }
    this.focus = 'detail'
    this.bumpRevision()
    this.intents.requestRender()
  }

  // ── the L2 edit phase (transient presentation; the write stays owned by the
  //    command through `onCommit`) ───────────────────────────────────────────

  /** Drop the choice phase without any write (Esc, a row/category change or a
   *  resize-driven replacement). Pending/settled phases survive: their write is
   *  already owned by the app. */
  private resetChoice(): void {
    if (this.editPhase.kind !== 'choosing') return
    this.editPhase = { kind: 'browsing' }
    this.choiceOffset = 0
    this.bumpRevision()
  }

  private choiceCount(): number {
    return this.selectedRow()?.edit?.options.length ?? 0
  }

  private moveChoice(delta: number): void {
    const phase = this.editPhase
    if (phase.kind !== 'choosing') return
    this.setChoice(phase.index + delta)
  }

  /** Move the highlighted candidate. The candidate is PRESENTATION only until
   *  an explicit confirm: nothing is applied or written here. */
  private setChoice(index: number): void {
    const phase = this.editPhase
    const edit = this.selectedRow()?.edit
    if (phase.kind !== 'choosing' || edit === undefined) return
    const next = Math.min(Math.max(0, index), Math.max(0, edit.options.length - 1))
    const option = edit.options[next]
    if (option === undefined || next === phase.index) return
    this.editPhase = { kind: 'choosing', field: phase.field, candidate: option.value, index: next }
    // The candidate change is a state version: a press recorded against the
    // previous candidate (or its confirm button) is refused at release.
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Enter / a click on a painted `[Change…]`: enter the choice phase, after
   *  re-reading the candidate source so a contribution that unloaded since the
   *  open is no longer offered. */
  private beginChoice(): void {
    const row = this.selectedRow()
    const edit = row?.edit
    if (row === undefined || edit === undefined) return
    // ONE commit at a time: a pending write owns the row, so a second confirm can
    // never be started (and the frame paints no Change/Confirm target either).
    if (this.editPhase.kind === 'pending') return
    this.refresh()
    const fresh = this.selectedRow()
    if (fresh?.id !== row.id) return
    const options = fresh.edit?.options ?? []
    if (options.length === 0) return
    const current = options.findIndex(option => option.current)
    const index = current >= 0 ? current : 0
    this.resetChoice()
    this.editPhase = { kind: 'choosing', field: fresh.edit!.field, candidate: options[index]!.value, index }
    this.choiceOffset = 0
    // The rebase sentinels are the LAST computed layout, not a fact about this choice:
    // leaving them set would make the first paint of a new choice take the no-rebase
    // branch, so re-entering the choice for a candidate below the fold would highlight it
    // out of view (and a confirm would commit an identity the user cannot see).
    this.lastChoiceIndex = -1
    this.lastChoiceViewport = -1
    this.lastChoiceWidth = -1
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Enter / a click on `[Confirm]`: dispatch the highlighted candidate through
   *  the app-owned write channel. An unavailable source is refused here — a
   *  candidate whose plugin/file is gone is never written. */
  private confirmChoice(): void {
    const phase = this.editPhase
    const edit = this.selectedRow()?.edit
    if (phase.kind !== 'choosing' || edit === undefined || edit.field !== phase.field) return
    const option = edit.options.find(candidate => candidate.value === phase.candidate)
    if (option === undefined) {
      // The source vanished between the paint and the confirm: report it instead of
      // returning silently (a painted button that does nothing is a false affordance).
      this.settle(phase.field, phase.candidate, {
        outcome: 'not-saved',
        reason: 'the selected source is no longer available',
      })
      return
    }
    if (!option.available) {
      this.settle(phase.field, phase.candidate, { outcome: 'not-saved', reason: 'the selected source is no longer available' })
      return
    }
    this.dispatch(phase.field, phase.candidate)
  }

  /** `[Retry save]`: re-dispatch the FAILED attempt's value, re-proving that its
   *  source is still live. The retry is a NEW commit identity, so a late
   *  settlement of the first attempt can never overwrite its result. */
  private retryCommit(value: string): void {
    const phase = this.editPhase
    const edit = this.selectedRow()?.edit
    if (phase.kind !== 'settled' || edit === undefined || edit.field !== phase.field) return
    const option = edit.options.find(candidate => candidate.value === value)
    if (option === undefined || !option.available) {
      this.settle(phase.field, value, { outcome: 'not-saved', reason: 'the selected source is no longer available' })
      return
    }
    this.dispatch(phase.field, value)
  }

  /** The ONE dispatch: commit the pending phase, then hand the request to the
   *  app-owned write channel with THIS open's request identity. */
  private dispatch(field: SettingsWorkspaceWritableField, value: string): void {
    const onCommit = this.intents.onCommit
    const requestId = this.editRequestId + 1
    this.editRequestId = requestId
    if (onCommit === undefined) {
      this.settle(field, value, { outcome: 'not-saved', reason: 'the settings writer is unavailable' })
      return
    }
    this.editPhase = { kind: 'pending', field, requestId, attempted: value }
    this.choiceOffset = 0
    this.bumpRevision()
    this.intents.requestRender()
    onCommit({ field, value }, outcome => this.settlePending(requestId, outcome))
  }

  /** The settlement of the LIVE pending commit. A settlement that does not
   *  match the live request (a superseded retry, a closed workspace) is dropped:
   *  a late result can never repaint a surface the user already left. */
  private settlePending(requestId: number, outcome: SettingsWorkspaceCommitOutcome): void {
    if (this.disposed) return
    const phase = this.editPhase
    if (phase.kind !== 'pending' || phase.requestId !== requestId) return
    this.settle(phase.field, phase.attempted, outcome)
  }

  /** Record a settled outcome and re-read the authorities: the Detail then shows
   *  the values the write REALLY produced, never the attempted ones. */
  private settle(field: SettingsWorkspaceWritableField, attempted: string, outcome: SettingsWorkspaceCommitOutcome): void {
    this.editPhase = {
      kind: 'settled',
      field,
      requestId: this.editRequestId + 1,
      attempted,
      outcome: outcome.outcome,
      ...outcome.reason === undefined ? {} : { reason: outcome.reason },
    }
    this.editRequestId += 1
    this.choiceOffset = 0
    this.refresh()
  }

  /** The keyboard Copy verb: only the Detail view may copy (a hidden action is
   *  never executed), and the exact source value is the payload. */
  private copy(): void {
    if (this.focus !== 'detail') return
    this.copySelected()
  }

  /** The mouse Copy verb: the painted button IS the action, independent of
   *  which pane owns the keyboard focus. */
  private copySelected(): void {
    const row = this.selectedRow()
    if (row?.value === undefined) return
    this.intents.onCopy(row.value)
  }

  // ── mouse ────────────────────────────────────────────────────────────────

  /** Wheel only: the pane under the pointer scrolls; everything else falls
   *  through to the alt screen's `onCellPress`/`onCellClick` identity path. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    const pane = this.paneAt(event.x, event.y)
    if (pane === undefined) return undefined
    if (pane === 'detail') {
      if (this.choiceField() === undefined) this.scroll(delta)
      else this.scrollChoice(delta)
    }
    else if (pane === 'rows') this.scrollRows(delta)
    else this.scrollCategories(delta)
    return { handled: true }
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    const target = this.targetAt(x, y)
    this.pressedGesture = target === undefined
      ? undefined
      : {
          target,
          revision: this.revision,
          focus: this.focus,
          categoryId: this.categoryId,
          columns: this.intents.columns(),
          rows: this.intents.rows(),
        }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressedGesture
    this.pressedGesture = undefined
    const target = this.targetAt(x, y)
    if (pressed === undefined || target === undefined) return
    // The gesture must still resolve to the SAME painted target AND the same
    // state version/level/category/terminal geometry: a refresh, a selection
    // change, a page switch, a category change OR a resize — including one whose
    // repaint has not run yet — refuses the click rather than acting on the
    // newer state.
    if (
      this.revision !== pressed.revision ||
      this.focus !== pressed.focus ||
      this.categoryId !== pressed.categoryId ||
      this.intents.columns() !== pressed.columns ||
      this.intents.rows() !== pressed.rows ||
      target.kind !== pressed.target.kind ||
      target.id !== pressed.target.id ||
      target.row !== pressed.target.row ||
      target.startCol !== pressed.target.startCol ||
      target.endCol !== pressed.target.endCol
    ) {
      return
    }
    this.activate(target)
  }

  private activate(target: HitTarget): void {
    switch (target.kind) {
      case 'category':
        // A real item click takes ITS column's keyboard focus (the §5
        // "click the corresponding column" contract) and selects the item; only
        // Enter advances the level, so a single click never opens the detail.
        this.selectCategory(target.id as SettingsWorkspaceCategoryId)
        this.takeColumnFocus('categories')
        return
      case 'row': {
        this.selectRow(target.id as SettingsWorkspaceRowId)
        // The row's `open-legacy` action is the ONE navigation verb (never an
        // edit) and the painted row IS its target, exactly like Enter.
        if (this.selectedRow()?.action === 'open-legacy') {
          this.intents.onOpenLegacy()
          return
        }
        this.takeColumnFocus('rows')
        return
      }
      case 'copy':
        this.takeColumnFocus('detail')
        this.copySelected()
        return
      case 'legacy':
        this.takeColumnFocus('detail')
        this.intents.onOpenLegacy()
        return
      case 'change':
        this.takeColumnFocus('detail')
        this.beginChoice()
        return
      case 'retry':
        this.takeColumnFocus('detail')
        this.retryCommit(target.id)
        return
      case 'option': {
        const edit = this.selectedRow()?.edit
        const index = edit?.options.findIndex(option => option.value === target.id) ?? -1
        if (index < 0) return
        this.takeColumnFocus('detail')
        this.setChoice(index)
        return
      }
      case 'confirm':
        // The painted Confirm belonged to the candidate in its ID: a newer
        // candidate has already bumped the revision and refused this click, and
        // the id check is the second, independent proof.
        if (this.editPhase.kind === 'choosing' && this.editPhase.candidate !== target.id) return
        this.takeColumnFocus('detail')
        this.confirmChoice()
        return
      case 'cancel':
        this.takeColumnFocus('detail')
        this.resetChoice()
        this.intents.requestRender()
        return
      case 'pane':
        this.takeColumnFocus(target.id as SettingsWorkspacePage)
        return
    }
  }

  /** Make one column the keyboard owner (no-op when it already is). */
  private takeColumnFocus(page: SettingsWorkspacePage): void {
    if (this.focus === page) return
    this.focus = page
    this.bumpRevision()
    this.intents.requestRender()
  }

  private scrollRows(delta: number): void {
    const pane = this.paintedPanes.rows
    if (pane === undefined) return
    this.rowOffset = Math.min(Math.max(0, this.rowOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  /** The wheel in the choice phase scrolls the CANDIDATE list (the browse detail
   *  scroll is not the live projection there). */
  private scrollChoice(delta: number): void {
    const pane = this.paintedPanes.detail
    if (pane === undefined) return
    this.choiceOffset = Math.min(Math.max(0, this.choiceOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  private scrollCategories(delta: number): void {
    const pane = this.paintedPanes.categories
    if (pane === undefined) return
    this.categoryOffset = Math.min(Math.max(0, this.categoryOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  private paneAt(x: number, y: number): SettingsWorkspacePage | undefined {
    const panes = this.paintedPanes
    const hit = (pane: PaneBox | undefined): boolean =>
      pane !== undefined && y >= pane.contentTop && y < pane.contentTop + pane.contentRows && x >= pane.x && x < pane.x + pane.width
    if (hit(panes.detail)) return 'detail'
    if (hit(panes.rows)) return 'rows'
    if (hit(panes.categories)) return 'categories'
    return undefined
  }

  private targetAt(x: number, y: number): HitTarget | undefined {
    return this.paintedTargets.find(target => target.row === y && x >= target.startCol && x < target.endCol)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // The edit phase dies with the panel: a settlement that arrives after the
    // teardown finds no live request and can never repaint a newer surface.
    this.editPhase = { kind: 'browsing' }
    this.editRequestId += 1
    this.pressedGesture = undefined
    this.paintedTargets = []
    this.paintedPanes = {}
  }
}

/** Compose a themed left region and a themed right region on one row. */
function composeEdge(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  const rightWidth = visibleWidth(right)
  if (rightWidth === 0) return fit(left, width)
  if (rightWidth + 2 > width) return fit(left, width)
  const room = width - rightWidth - 1
  const lead = truncateToWidth(left, room, '…', false)
  const gap = width - visibleWidth(lead) - rightWidth
  return lead + ' '.repeat(Math.max(1, gap)) + right
}
