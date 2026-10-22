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
 * DisplayState / presentation-preference readers. Theme and Display commits are
 * requests through the existing `onCommit` intent; all other settings retain
 * their existing read, copy and legacy-editor handoff behavior.
 * @module @xmoon76/dsh-pi-tui/tui/panels/settings-workspace-panel
 */

import {
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import { pickWelcomeWhaleVariant, renderWelcomeWhaleLines, WELCOME_WHALE_WIDTH } from '../components/welcome-whale.ts'
import type { ModelsInitialView, ModelsPageExit, ModelsWorkspacePage } from './models-workspace-page.ts'
import type { AccountInitialView, AccountWorkspacePage } from './account-workspace-page.ts'

/** The frozen Settings categories, in the visible order. `About` is the
 * default home of the workspace; `Models` and `Account` are direct content
 * pages (like Plugins); the four configuration categories keep their existing
 * behavior. */
export type SettingsWorkspaceCategoryId =
  | 'about' | 'models' | 'account' | 'appearance' | 'display' | 'plugins' | 'other'

/** The navigation level of the LEGACY configuration categories: `categories`
 *  (L0) → `rows` (L1) → `detail` (L2).
 *  This is the SAME state in every width — the layout only decides which
 *  panes of the current level are visible. */
export type SettingsWorkspacePage = 'categories' | 'rows' | 'detail'

/** The ONE navigation focus state of the workspace. The three legacy levels
 * plus `content`: the direct page (About/Models/Account) that the category
 * rail previews and hands the keyboard to. */
export type SettingsWorkspaceFocus = SettingsWorkspacePage | 'content'

/** The categories whose RIGHT column is a real page instead of the legacy
 *  L0/L1/L2 configuration panes. */
export type SettingsWorkspaceDirectCategoryId = 'about' | 'models' | 'account'

/** The stable identity of one readonly pilot row. */
export type SettingsWorkspaceRowId =
  | 'theme'
  | 'icon-style'
  | 'display-preset'
  | 'thinking'
  | 'legacy-settings'
  | 'web-settings'

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
  /** The legacy-editor row an `open-legacy` action must focus (the Settings
   *  workspace deeplink, S2/PR-B §3.3). Absent = the editor opens at its top. */
  readonly legacyTargetId?: string
  /** Present ONLY on the writable pilot rows (B2-B). A row without it is never
   *  editable, whatever its action. */
  readonly edit?: SettingsWorkspaceEdit
}

/** The facts an authority OTHER than the settings document can change for one
 *  row between two snapshot reads (the Web launcher row's Host facts). */
export interface SettingsWorkspaceRowFacts {
  readonly summary: string
  readonly freshness: SettingsWorkspaceFreshness
  readonly description: string
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

/** The row's commit status as the Detail pane paints it: the status WORD, its
 *  semantic tone and the explanation kept separate, so only the word takes the
 *  token (design language §3.2 / role 9). */
interface SettingsCommitStatus {
  readonly word: string
  readonly reason: string
  readonly tone: 'success' | 'error' | 'warning' | 'muted'
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
  /** Invoked when the user asks for a refresh (`r`): the OWNER starts the
   *  asynchronous authority read and refreshes this generation when it
   *  settles (S2/PR-B §B3.4). The panel itself never reads Host facts. */
  onRefresh?(): void
}

/** The client-local capabilities the panel consumes. */
export interface SettingsWorkspacePanelIntents {
  /**
   * The two version facts the `About` page shows. They are read ONCE per
   * workspace open on the Client side: `tui` is the bundle's own version and
   * `dsh` the installed Harness version (undefined = unreadable). Neither is
   * a Host fact and neither is derived from the other.
   */
  readonly aboutVersionFacts: {
    readonly tui: string
    readonly dsh: string | undefined
  }
  /**
   * The Plugins category is a DIRECT page entry, not an empty Rows level: the
   * app owner builds the ONE PluginManagerWorkspacePanel lazily and returns it.
   * `done` is the page's normal close path (it returns to Settings); an external
   * teardown disposes the returned component instead and never calls `done`.
   */
  readonly onOpenPlugins?: (done: () => void) => Component | undefined
  /** The lazily built Models direct page (the Settings category keeps the
   * same screen lease). `openAccount` switches this workspace to the Account
   * page when the Models list's account entry is activated. */
  readonly createModelsPage?: (
    initial: ModelsInitialView,
    openAccount: () => void,
  ) => SettingsAuthPage | undefined
  /** The lazily built Account direct page. */
  readonly createAccountPage?: (initial: AccountInitialView) => SettingsAuthPage | undefined
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
  /** The compatibility bridge: open the existing complete settings editor,
   *  focused on the row the destination asked for (absent = its top). */
  readonly onOpenLegacy: (targetId?: string) => void
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

interface PaintedRegion {
  /** Absolute panel row of the region's first painted line. */
  readonly top: number
  readonly rows: number
  readonly maxOffset: number
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
  /** The two independent scroll regions of an inline choice, when present. */
  readonly factRegion?: PaintedRegion
  readonly optionRegion?: PaintedRegion
}

interface PaneBoxes {
  categories?: PaneBox
  rows?: PaneBox
  detail?: PaneBox
}

/** The common page surface the Models and Account direct pages expose to this
 * workspace root. The root owns the screen/lease and the category rail; the
 * page owns its body, its action bar and its last-painted hit map. */
export interface SettingsAuthPage extends Component {
  setBodyHeight(rows: number): void
  handleInput(data: string): 'handled' | 'exit' | 'open-account'
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined
  onCellPress?(x: number, y: number): void
  onCellClick?(x: number, y: number): 'handled' | 'exit' | 'open-account' | void
  /** Revoke one in-flight press when another owner claims the gesture. */
  cancelPointer?(): void
  /** True while a Host mutation must settle on this page: the workspace root
   *  must not dispose it from USER navigation (category rail / Back / deep
   *  link). Blocking-owner teardown still bypasses this guard. */
  pendingMutation?(): boolean
  /** Whether a bare Left may yield from the page ROOT to the Settings
   *  categories. It never admits an exit during a child modal, an auth flow
   *  or a pending mutation, and it never reads the Host or changes business
   *  state: it only answers "may the root claim this Left?". */
  canYieldFocusToNavigation?(): boolean
  invalidate(): void
  dispose(): void
}

/** One pane the current frame actually paints: its level and absolute geometry.
 *  Hidden panes of the two-pane medium projection simply have no entry. */
interface PaneLayout {
  readonly page: SettingsWorkspacePage
  readonly x: number
  readonly width: number
}

interface HitTarget {
  readonly kind: 'category' | 'row' | 'plugin-launch' | 'copy' | 'legacy' | 'pane' | 'change' | 'retry' | 'option' | 'confirm' | 'cancel'
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
  /** The identity the painted button acts on: the candidate it commits, or the
   *  selected row it belongs to. It is the painted hit target's id. */
  readonly id: string
}

interface DetailRegionProjection {
  readonly lineStart: number
  readonly rows: number
  readonly maxOffset: number
}

interface DetailProjection {
  readonly lines: readonly string[]
  readonly content: readonly string[]
  readonly viewport: number
  readonly buttons: readonly { readonly button: DetailButton; readonly startCol: number }[]
  /** The candidate rows the choice projection really painted, as offsets inside
   *  the granted viewport: only these may publish an `option` hit target. */
  readonly optionRows: readonly { readonly value: string; readonly line: number; readonly endCol: number }[]
  readonly factRegion?: DetailRegionProjection
  readonly optionRegion?: DetailRegionProjection
  /** Whether this frame paints the selected candidate's identity-bearing head. */
  readonly confirmCandidateVisible: boolean
}

const CATEGORY_ORDER: readonly SettingsWorkspaceCategoryId[] = [
  'about', 'models', 'account', 'appearance', 'display', 'plugins', 'other',
]

const CATEGORY_LABELS: Record<SettingsWorkspaceCategoryId, string> = {
  about: 'About',
  models: 'Models',
  account: 'Account',
  appearance: 'Appearance',
  display: 'Display',
  plugins: 'Plugins',
  other: 'Other settings',
}

/** The categories whose right column is a REAL page (About, Models, Account)
 * instead of the legacy L0/L1/L2 configuration panes. */
const DIRECT_CATEGORIES: readonly SettingsWorkspaceDirectCategoryId[] = ['about', 'models', 'account']

/** Whether one category is a direct content page. */
function isDirectCategory(category: SettingsWorkspaceCategoryId): category is SettingsWorkspaceDirectCategoryId {
  return (DIRECT_CATEGORIES as readonly SettingsWorkspaceCategoryId[]).includes(category)
}

/** The typed guard for a painted category id (a hit target never casts). */
function isCategoryId(id: string): id is SettingsWorkspaceCategoryId {
  return (CATEGORY_ORDER as readonly string[]).includes(id)
}

/** The typed guard for a painted legacy pane id (a hit target never casts). */
function isWorkspacePage(id: string): id is SettingsWorkspacePage {
  return id === 'categories' || id === 'rows' || id === 'detail'
}

/** The typed guard for a painted row id (a hit target never casts). */
function isWorkspaceRowId(id: string): id is SettingsWorkspaceRowId {
  return id === 'theme'
    || id === 'icon-style'
    || id === 'display-preset'
    || id === 'thinking'
    || id === 'legacy-settings'
    || id === 'web-settings'
}

const WIDE_CATEGORY_WIDTH = 22
const WIDE_ROWS_WIDTH = 42
/** The medium projection's leading categories column (L0 only). */
const MEDIUM_CATEGORY_WIDTH = 22
/** The medium projection's leading rows column (L1/L2). */
const MEDIUM_ROWS_WIDTH = 40
const COLUMN_GAP = 2

/**
 * The Settings workspace's own FIXED keys. They are surface-local, own no
 * keymap action and are therefore NOT rebindable (design language §7.1): the
 * handler and the Action Bar hint read the SAME constant, so the advertised key
 * can never drift from the accepted one. Making them rebindable would land with
 * the keybinding contract, and the hint would then switch to `componentKeymap`.
 */
const SETTINGS_LOCAL_KEYS = { refresh: 'r', copy: 'c' } as const
const CHOICE_CONFIRM_HINT: ActionBarSegment = { text: 'Enter confirm', priority: 7 }
const CHOICE_BACK_HINT: ActionBarSegment = { text: 'Esc back', short: 'Esc', priority: 8 }

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
 *
 * `rules` is the number of decorative boundaries the projection spends: the
 * legacy three-level projection draws a rule above AND below its body, while
 * the direct projection draws only the upper one — its lower boundary is the
 * content page's own action bar, which must stay the physical last row.
 */
function planSettingsChrome(
  width: number,
  rows: number,
  noticeLive: boolean,
  choosing = false,
  rules = 2,
): SettingsChromePlan {
  const safeRows = Math.max(1, Math.floor(rows))
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  // Rows the body could use once the mandatory chrome is granted.
  const base = Math.max(0, safeRows - headerRows - actionRows)
  // §4.4: the notice keeps the body at two rows; the metadata keeps it at three.
  const noticeRows = safeRows >= 6 && noticeLive && base - 1 >= 2 ? 1 : 0
  const metaRows = !choosing && safeRows >= 8 && base - noticeRows - 1 >= 3 ? 1 : 0
  const bodyWithoutRules = base - noticeRows - metaRows
  const ruleRows = !choosing && bodyWithoutRules >= 5 ? rules : 0
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
  /** The ONE selected category. `About` is the default home of the workspace. */
  private categoryId: SettingsWorkspaceCategoryId = 'about'
  /** The selected row of the LEGACY configuration categories; a direct page
   *  (About/Models/Account) has no row at all. */
  private rowId: SettingsWorkspaceRowId | undefined
  /** The ONE navigation focus state: the three legacy levels plus the direct
   *  page content. A new open starts on the category rail (or on the About
   *  content in a narrow terminal, which has no room for a rail). */
  private focus: SettingsWorkspaceFocus = 'categories'
  private categoryOffset = 0
  private rowOffset = 0
  private detailOffset = 0
  /** The About page's own scroll offset (presentation only: it never carries
   *  business state and it survives a switch away from About). */
  private aboutOffset = 0
  /** The About page's scrollable extent at the last paint. */
  private aboutScrollExtent = 0
  /** The whale variant of THIS open's About page: picked once per open, like
   *  the Welcome card picks one per process. */
  private readonly aboutWhaleVariant = pickWelcomeWhaleVariant()
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
    readonly focus: SettingsWorkspaceFocus
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
  /** Facts from the current painted projection, used to grant choice actions. */
  private paintedChoiceCandidateVisible = false
  private paintedEnterConfirm = false
  private paintedChoiceCopy = false
  private paintedChoiceNavigation = false
  private paintedChoiceFactScroll = false
  private paintedRevision = -1
  private chrome: SettingsChromePlan | undefined
  private disposed = false
  /** The ONE transient editing phase of THIS open workspace (presentation
   *  only; the durable authority stays the ConfigPort). */
  private editPhase: SettingsWorkspaceEditPhase = { kind: 'browsing' }
  /** The per-open commit identity: a settlement that does not match the live
   *  request is refused (a superseded or post-close result can never repaint). */
  private editRequestId = 0
  /** The lazily built Plugin Manager page currently hosting this screen. */
  private pluginPage: (Component & {
    focused?: boolean
    dispose?(): void
    onCellPress?(x: number, y: number): void
    onCellClick?(x: number, y: number): void
    handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined
  }) | undefined
  /** The candidate viewport offset of the choice projection. */
  private choiceOffset = 0
  /** The candidate index/viewport/WIDTH the choice list was last rebased against. */
  private lastChoiceIndex = -1
  private lastChoiceViewport = -1
  private lastChoiceWidth = -1
  private readonly source: SettingsWorkspaceSource
  private readonly intents: SettingsWorkspacePanelIntents
  /** The active Models/Account direct page (at most one). */
  private authPage: SettingsAuthPage | undefined
  private authPageCategory: 'models' | 'account' | undefined
  /** The last painted content area (panel coordinates) for mouse translation.
   *  It covers the About page and the direct pages alike: the root owns ONE
   *  content box and ONE press map for the whole right column. */
  private paintedContentBox: { readonly x: number; readonly top: number; readonly width: number; readonly rows: number } | undefined
  /** The root-level identity of one press inside the content area: a resize or
   *  a root state change between press and release refuses the gesture even
   *  when the page has not repainted yet. */
  private contentPressed: {
    readonly x: number
    readonly y: number
    readonly columns: number
    readonly rows: number
    readonly revision: number
  } | undefined

  constructor(
    source: SettingsWorkspaceSource,
    intents: SettingsWorkspacePanelIntents,
    /** The re-entry selection (S2/PR-B §B3.4): the Web Settings launch restores
     *  this Workspace with its own row focused, never the default category. */
    options?: {
      readonly initialRowId?: SettingsWorkspaceRowId
      readonly initialCategory?: SettingsWorkspaceCategoryId
      readonly initialModelsView?: ModelsInitialView
      readonly initialAccountView?: AccountInitialView
    },
  ) {
    this.source = source
    this.intents = intents
    this.snapshot = source.readSnapshot()
    this.rowId = this.firstRowOf(this.categoryId)
    if (options?.initialRowId !== undefined) {
      const target = this.snapshot.rows.find(row => row.id === options.initialRowId)
      if (target !== undefined) {
        this.categoryId = target.category
        this.rowId = target.id
        this.focus = 'rows'
      }
    } else if (options?.initialCategory !== undefined) {
      this.categoryId = options.initialCategory
      this.focus = 'categories'
    } else if (options?.initialModelsView !== undefined) {
      // A Models deeplink IS the Models category.
      this.categoryId = 'models'
      this.focus = 'categories'
    } else if (options?.initialAccountView !== undefined) {
      // An Account deeplink IS the Account category.
      this.categoryId = 'account'
      this.focus = 'categories'
    }
    if (options?.initialModelsView !== undefined) this.mountModelsPage(options.initialModelsView)
    else if (options?.initialAccountView !== undefined) this.mountAccountPage(options.initialAccountView)
    else if (options?.initialRowId === undefined && options?.initialCategory === undefined) {
      // The About default: a narrow terminal has no room for a rail AND a
      // content column, so the About content owns the first frame there.
      if (layoutForWidth(this.intents.columns()) === 'narrow') this.focus = 'content'
    }
    // A deeplink owns the CONTENT focus: its page is the whole answer.
    if (options?.initialModelsView !== undefined || options?.initialAccountView !== undefined) {
      this.focus = 'content'
    }
  }

  /**
   * Mount the Models direct page. The page instance is the OWNER of its view,
   * draft and watch; the root only mounts it once and disposes it when the
   * category really changes.
   */
  private mountModelsPage(initial: ModelsInitialView): void {
    if (this.authPageCategory === 'models') return
    if (this.authPageCategory !== undefined) this.closeAuthPage()
    const page = this.intents.createModelsPage?.(initial, () => this.switchToAccountContent())
    if (page === undefined) return
    // The factory may run a synchronous callback that already changed the
    // selection: a page built for a superseded selection must never be
    // mounted (it would start a second Host watch for a page nobody sees).
    if (this.disposed || this.categoryId !== 'models') {
      page.dispose()
      return
    }
    this.authPage = page
    this.authPageCategory = 'models'
  }

  /** Mount the Account direct page. */
  private mountAccountPage(initial: AccountInitialView): void {
    if (this.authPageCategory === 'account') return
    if (this.authPageCategory !== undefined) this.closeAuthPage()
    const page = this.intents.createAccountPage?.(initial)
    if (page === undefined) return
    if (this.disposed || this.categoryId !== 'account') {
      page.dispose()
      return
    }
    this.authPage = page
    this.authPageCategory = 'account'
  }

  /**
   * The Models page's account row asks the root to switch to the Account
   * content. The switch is IDEMPOTENT: a second request for the same category
   * never builds a second page and never starts a second Host watch.
   */
  private switchToAccountContent(): void {
    if (this.authPageHasPendingMutation()) return
    if (this.categoryId === 'account' && this.authPageCategory === 'account') {
      this.focus = 'content'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    this.selectCategory('account', 'content')
  }

  private syncAuthPageBody(): void {
    const page = this.authPage
    if (page === undefined) return
    const plan = planSettingsChrome(
      this.intents.columns(),
      this.intents.rows(),
      this.intents.notice() !== undefined,
      false,
      1,
    )
    page.setBodyHeight(Math.max(1, plan.bodyRows + plan.actionRows))
  }

  private authPageHasPendingMutation(): boolean {
    return this.authPage?.pendingMutation?.() === true
  }

  /** Close the direct page for USER navigation only when no Host mutation is
   *  still owned by it. */
  private closeAuthPageForNavigation(): boolean {
    if (this.authPageHasPendingMutation()) return false
    this.closeAuthPage()
    return true
  }

  private closeAuthPage(): void {
    const page = this.authPage
    this.authPage = undefined
    this.authPageCategory = undefined
    this.paintedContentBox = undefined
    this.contentPressed = undefined
    page?.dispose()
  }

  /** Repaint ONE row with facts an authority changed BETWEEN snapshot reads
   *  (S2/PR-B §B3.4): the Web read cycle changed only its OWN row, so the TUI
   *  settings document is NOT read again — a workspace surface keeps its ONE
   *  guarded document read (B2-A). The CALLER owns the facts; the panel stores
   *  no authority of its own. */
  refreshRow(rowId: SettingsWorkspaceRowId, facts: SettingsWorkspaceRowFacts): void {
    if (this.disposed) return
    const index = this.snapshot.rows.findIndex(row => row.id === rowId)
    if (index < 0) return
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.map((row, at) => at === index ? { ...row, ...facts } : row),
    }
    this.bumpRevision()
    this.intents.requestRender()
  }

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.pluginPage !== undefined) return this.pluginPage.render(width)
    const liveRows = this.intents.rows()
    // A terminal resize is a gesture boundary: a press recorded against the old
    // geometry must not resolve against the new one, even when the target's own
    // cells did not move (the plan's "sizes changed ⇒ reject").
    if (this.lastRenderWidth >= 0 && (this.lastRenderWidth !== width || this.lastRenderRows !== liveRows)) {
      this.bumpRevision()
    }
    this.lastRenderWidth = width
    this.lastRenderRows = liveRows
    const choosing = this.choiceField() !== undefined
    const direct = this.paintsDirectPage(width)
    const plan = planSettingsChrome(
      width,
      liveRows,
      this.intents.notice() !== undefined,
      choosing,
      direct ? 1 : 2,
    )
    this.chrome = plan
    this.paintedChoiceCandidateVisible = false
    this.paintedEnterConfirm = false
    this.paintedChoiceCopy = false
    this.paintedChoiceNavigation = false
    this.paintedChoiceFactScroll = false
    if (direct) return this.renderDirectPage(plan)
    // The legacy projection paints no content column: the content box and its
    // press map belong to the direct layout alone.
    this.paintedContentBox = undefined
    const lines: string[] = []
    const targets: HitTarget[] = []
    const panes: PaneBoxes = {}
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows >= 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    const bodyTop = plan.headerRows + plan.metaRows + (plan.ruleRows >= 1 ? 1 : 0)
    if (plan.bodyRows > 0) lines.push(...this.renderBody(plan, bodyTop, targets, panes))
    this.paintedPanes = panes
    if (plan.ruleRows >= 2) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    if (plan.actionRows === 1) lines.push(this.renderActionBar(plan))
    this.paintedTargets = targets
    this.paintedPanes = panes
    this.paintedRevision = this.revision
    return lines.slice(0, plan.rows)
  }

  /**
   * Whether the current category/level paints the DIRECT layout (the category
   * rail plus one real content page) instead of the legacy L0/L1/L2 panes.
   * A narrow terminal keeps the single-column category list: it has no room
   * for a rail AND a content column, so the list stays the only projection
   * until the user enters a page.
   */
  private paintsDirectPage(width: number): boolean {
    if (!isDirectCategory(this.categoryId)) return false
    return !(layoutForWidth(width) === 'narrow' && this.focus === 'categories')
  }

  /**
   * Render the direct content page (About, Models, Account) inside the
   * workspace chrome: the category rail stays visible on wide/medium; the
   * content owns the rest of the screen, INCLUDING the single physical action
   * bar on the last row.
   */
  private renderDirectPage(plan: SettingsChromePlan): string[] {
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows >= 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    const bodyTop = plan.headerRows + plan.metaRows + (plan.ruleRows >= 1 ? 1 : 0) + plan.noticeRows
    const narrow = plan.layout === 'narrow'
    const categoryWidth = narrow ? 0 : plan.layout === 'wide' ? WIDE_CATEGORY_WIDTH : MEDIUM_CATEGORY_WIDTH
    const contentX = narrow ? 0 : categoryWidth + COLUMN_GAP
    const contentWidth = Math.max(1, plan.width - contentX)
    const contentRows = Math.max(1, plan.bodyRows + plan.actionRows)
    const contentColumn = this.renderContentColumn(contentWidth, contentRows)
    const visible = narrow ? [] : this.visibleCategories(contentRows)
    for (let index = 0; index < contentRows; index += 1) {
      const content = fit(contentColumn[index] ?? '', contentWidth)
      if (narrow) {
        lines.push(content)
        continue
      }
      const id = visible[index]
      const rail = fit(id === undefined ? '' : this.categoryLine(id), categoryWidth)
      lines.push(`${rail}${' '.repeat(COLUMN_GAP)}${content}`)
      if (id !== undefined) {
        targets.push({ kind: 'category', id, row: bodyTop + index, startCol: 0, endCol: categoryWidth })
      }
    }
    this.paintedContentBox = { x: contentX, top: bodyTop, width: contentWidth, rows: contentRows }
    this.paintedPanes = {
      categories: narrow ? undefined : {
        x: 0,
        width: categoryWidth,
        contentTop: bodyTop,
        contentRows: Math.min(CATEGORY_ORDER.length, contentRows),
        maxOffset: Math.max(0, CATEGORY_ORDER.length - contentRows),
      },
    }
    this.paintedTargets = targets
    this.paintedRevision = this.revision
    return lines.slice(0, plan.rows)
  }

  /**
   * The content column of the direct layout. The real page owns its own lines
   * (its last line is its action bar); the About page is a root-owned
   * read-only projection with the root's own action bar. The single physical
   * action bar is ALWAYS the last row: the navigation focus replaces the
   * page's hint line, the content focus keeps it.
   */
  private renderContentColumn(width: number, rows: number): string[] {
    const page = this.authPage
    if (page !== undefined) {
      page.setBodyHeight(rows)
      const column = page.render(width).slice(0, rows)
      while (column.length < rows) column.push(fit('', width))
      if (this.focus === 'categories') {
        column[rows - 1] = fit(this.renderNavigationActionBar(width), width)
      }
      return column
    }
    const aboutRows = Math.max(0, rows - 1)
    // The About projection belongs to the About category alone: a direct page
    // that is not mounted paints no content of its own.
    const about = this.categoryId === 'about' && aboutRows > 0
      ? this.renderAboutContent(width, aboutRows)
      : []
    const bar = this.focus === 'categories'
      ? this.renderNavigationActionBar(width)
      : this.renderAboutActionBar(width)
    const padded = [...about]
    while (padded.length < aboutRows) padded.push(fit('', width))
    return [...padded.slice(0, aboutRows), fit(bar, width)]
  }

  /**
   * The category rail's visible window. The rail scrolls with the selection
   * (and with the wheel), so a SHORT terminal can still reach the last
   * category and hit the RIGHT id. The rail and the legacy categories pane
   * share ONE offset and ONE rebase rule.
   */
  private visibleCategories(viewport: number): readonly SettingsWorkspaceCategoryId[] {
    const selected = CATEGORY_ORDER.indexOf(this.categoryId)
    if (selected !== this.lastCategoryIndex || viewport !== this.lastCategoryViewport) {
      this.categoryOffset = rebaseOffset(this.categoryOffset, selected, CATEGORY_ORDER.length, viewport)
      this.lastCategoryIndex = selected
      this.lastCategoryViewport = viewport
    } else {
      this.categoryOffset = clampOffset(this.categoryOffset, CATEGORY_ORDER.length, viewport)
    }
    return CATEGORY_ORDER.slice(this.categoryOffset, this.categoryOffset + viewport)
  }

  /**
   * The About projection: the SHARED whale (the Welcome card's own pattern
   * and brand gradient) plus the two package versions. It is a read-only
   * projection: no row, no field, no write, and no session.
   */
  private renderAboutContent(width: number, rows: number): string[] {
    const facts = this.intents.aboutVersionFacts
    const lines: string[] = []
    if (rows >= 9 && width >= WELCOME_WHALE_WIDTH) {
      lines.push(...renderWelcomeWhaleLines(this.aboutWhaleVariant))
      lines.push('')
      lines.push(color.textStrong('dsh-pi-tui'))
    } else {
      lines.push(color.textStrong('🐋 dsh-pi-tui'))
    }
    lines.push(`${color.textDim('TUI  ')}${color.text(sanitizedPhysicalLine(facts.tui))}`)
    lines.push(`${color.textDim('DSH  ')}${color.text(sanitizedPhysicalLine(facts.dsh ?? 'Unknown'))}`)
    this.aboutScrollExtent = Math.max(0, lines.length - rows)
    const offset = clampOffset(this.aboutOffset, lines.length, rows)
    this.aboutOffset = offset
    return lines.slice(offset, offset + rows)
  }

  /**
   * The navigation action bar: the category rail owns the keyboard, so the
   * bar advertises the rail's own keys — never the content page's. Below the
   * body floor every navigation target is invisible, so only the Esc
   * semantics survive.
   */
  private renderNavigationActionBar(width: number): string {
    if (this.bodyFloor() < 1) return color.textMuted('Esc close')
    return color.textMuted(renderActionBarRow(this.navigationActionBarSegments(), width))
  }

  /** The About page's own action bar: it scrolls and it returns to the
   *  category rail — it never closes the workspace. */
  private renderAboutActionBar(width: number): string {
    if (this.bodyFloor() < 1) return color.textMuted('Esc back')
    return color.textMuted(renderActionBarRow([
      ...(this.aboutScrollExtent > 0 ? [{ text: 'Up/Down scroll', priority: 4 }] : []),
      { text: 'Esc back', priority: 8 },
    ], width))
  }

  /** The category rail's own hints. A direct category hands the keyboard to
   *  its content page; a legacy category steps one level deeper. */
  private navigationActionBarSegments(): ActionBarSegment[] {
    if (isDirectCategory(this.categoryId)) {
      return [
        { text: 'Up/Down navigate', priority: 4 },
        { text: 'Enter/Right focus', priority: 6 },
        { text: 'Esc close', priority: 8 },
      ]
    }
    return [
      { text: 'Up/Down select', priority: 4 },
      { text: 'Right open', priority: 6 },
      { text: 'Enter open', priority: 5 },
      { text: 'Esc close', priority: 8 },
    ]
  }

  invalidate(): void {
    this.pluginPage?.invalidate?.()
    this.authPage?.invalidate()
  }

  /** The ONE level breadcrumb, identical in every layout: `Categories` →
   *  `<Category> · Rows` → `<Category> · <Row label>` (one ` · ` join for every
   *  trail segment, design language §4.2). It names the owner that currently
   *  receives the keyboard: the rail, the direct content page or a legacy
   *  level. It paints no hit target: the header is no longer a category focus
   *  owner or switch. */
  private renderHeader(plan: SettingsChromePlan): string[] {
    const row = this.selectedRow()
    const breadcrumb = this.focus === 'categories'
      ? 'Categories'
      : this.focus === 'content'
        ? CATEGORY_LABELS[this.categoryId]
        : this.focus === 'rows'
          ? `${CATEGORY_LABELS[this.categoryId]} · Rows`
          : `${CATEGORY_LABELS[this.categoryId]} · ${row?.label ?? '—'}`
    // Identity is BOLD textStrong and the trail is textDim (roles 1 + 2): the
    // brand word is not `primary`, because primary means active/actionable and
    // already paints the cursor, the focused label and every affordance.
    const title = `Settings · ${breadcrumb}`
    const lead = `${color.textStrong('Settings')}${color.textDim(title.slice('Settings'.length))}`
    // The header states which rows the workspace can really change. The narrow
    // projection is width-starved: the breadcrumb keeps the whole line there
    // instead of ceding cells to a badge it can still show at 76+ columns.
    const editable = this.snapshot.rows.reduce((count, row) => count + (row.edit === undefined ? 0 : 1), 0)
    const right = editable === 0 || plan.layout === 'narrow'
      ? ''
      : `${editable} editable ${editable === 1 ? 'row' : 'rows'}`
    return [composeEdge(lead, right === '' ? '' : color.textMuted(right), plan.width)]
  }

  /** The diagnostic line (roles 11 + 12). Trailing facts drop WHOLE before any
   *  truncation (a half fact is a lie), and the readiness word carries its own
   *  ink: the calm default is `textMuted`, a stale document is `warning` and an
   *  unavailable one is `error` (design language §3.2 corrections). */
  private renderMetadata(plan: SettingsChromePlan): string {
    const row = this.authPage !== undefined ? undefined : this.selectedRow()
    const scope = this.categoryId === 'about'
      ? 'About'
      : this.authPageCategory === 'models'
        ? 'Host provider & credential configuration'
        : this.authPageCategory === 'account'
          ? 'DeepSeek Account · Host'
          : row?.scope ?? 'TUI preferences'
    const captured = new Date(this.snapshot.capturedAt)
    const hh = String(captured.getHours()).padStart(2, '0')
    const mm = String(captured.getMinutes()).padStart(2, '0')
    const readiness = this.snapshot.configReadiness
    const word = readiness === 'ready' ? 'Ready' : readiness === 'stale' ? 'Stale' : 'Unavailable'
    const paint = readiness === 'ready' ? color.textMuted : readiness === 'stale' ? color.warning : color.error
    const facts = [
      `Scope: ${sanitizedPhysicalLine(scope)}`,
      `Refreshed ${hh}:${mm}`,
      `Config ${word}`,
    ]
    const kept: string[] = []
    for (const fact of facts) {
      if (kept.length > 0 && visibleWidth([...kept, fact].join(' · ')) > plan.width) break
      kept.push(fact)
    }
    const separator = color.textMuted(' · ')
    const painted = kept.map((fact, index) => {
      if (index !== kept.length - 1 || kept.length !== facts.length) return color.textMuted(fact)
      // The FIELD NAME stays `textMuted`; only the status word takes the tone,
      // so a stale or unavailable backend does not paint `Config` in warning red.
      const name = 'Config '
      return `${color.textMuted(name)}${paint(fact.slice(name.length))}`
    }).join(separator)
    return fit(painted, plan.width)
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
    // The shared pane-header line is a grant of its own: keep it whenever one
    // real content row remains, including during choice editing. With only one
    // body row it would replace the candidate/content line, so the header yields.
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
        const visible = this.visibleCategories(contentRows)
        for (let i = 0; i < visible.length; i += 1) {
          itemHits.push({ kind: 'category', id: visible[i]!, row: contentTop + i, startCol: pane.x, endCol: pane.x + pane.width })
        }
        paneLines.set('categories', visible.map(id => this.categoryLine(id)))
        continue
      }
      if (pane.page === 'rows') {
        if (this.categoryId === 'plugins') {
          // S4-D2 / D2-0: the Plugins category paints ONE UI-only direct-page
          // affordance instead of a fabricated Settings row. It is not part of
          // the snapshot, owns no row id/writable field and publishes the hit
          // target of exactly the cells this pane really painted.
          if (contentRows > 0) {
            itemHits.push({
              kind: 'plugin-launch',
              id: 'plugins',
              row: contentTop,
              startCol: pane.x,
              endCol: pane.x + pane.width,
            })
            paneLines.set('rows', [this.pluginLaunchLine(pane.width)])
          }
          continue
        }
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
      this.paintedChoiceCandidateVisible = detail.confirmCandidateVisible
      const buttonRow = contentTop + Math.max(0, contentRows - 1)
      for (const painted of detail.buttons) {
        itemHits.push({
          kind: painted.button.verb,
          id: painted.button.id,
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
      if (pane.page === 'rows') maxOffset = Math.max(0, this.rowsPaneCount() - contentRows)
      else if (pane.page === 'detail') {
        maxOffset = detailProjection === undefined ? 0 : Math.max(0, detailProjection.content.length - detailProjection.viewport)
      }
      const projection = pane.page === 'detail' ? detailProjection : undefined
      panes[pane.page] = {
        x: pane.x,
        width: pane.width,
        contentTop,
        contentRows,
        maxOffset,
        ...(projection?.factRegion === undefined ? {} : {
          factRegion: {
            top: contentTop + projection.factRegion.lineStart,
            rows: projection.factRegion.rows,
            maxOffset: projection.factRegion.maxOffset,
          },
        }),
        ...(projection?.optionRegion === undefined ? {} : {
          optionRegion: {
            top: contentTop + projection.optionRegion.lineStart,
            rows: projection.optionRegion.rows,
            maxOffset: projection.optionRegion.maxOffset,
          },
        }),
      }
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
          ? `Categories (${CATEGORY_ORDER.length})`
          : pane.page === 'rows'
            ? `Rows (${this.rowsPaneCount()})`
            : 'Details'
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
      const visible = this.visibleCategories(viewport)
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
    this.paintedChoiceCandidateVisible = detail.confirmCandidateVisible
    panes.detail = {
      x: 0,
      width,
      contentTop: bodyTop,
      contentRows: viewport,
      maxOffset: Math.max(0, detail.content.length - detail.viewport),
      ...(detail.factRegion === undefined ? {} : {
        factRegion: {
          top: bodyTop + detail.factRegion.lineStart,
          rows: detail.factRegion.rows,
          maxOffset: detail.factRegion.maxOffset,
        },
      }),
      ...(detail.optionRegion === undefined ? {} : {
        optionRegion: {
          top: bodyTop + detail.optionRegion.lineStart,
          rows: detail.optionRegion.rows,
          maxOffset: detail.optionRegion.maxOffset,
        },
      }),
    }
    const buttonRow = bodyTop + Math.max(0, viewport - 1)
    for (const painted of detail.buttons) {
      targets.push({
        kind: painted.button.verb,
        id: painted.button.id,
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

  /** The active device (role 7): the focused pane's label is bracketed and bold
   *  `primary` — the SAME device the Job workspace's active tab paints. An
   *  unfocused pane label is plain `textDim` (role 5). `borderFocus` is NOT an
   *  ordinary-focus colour; it belongs to approvals. */
  private paneHeader(text: string, focused: boolean): string {
    return focused ? color.textStrong(`[${text}]`, 'primary') : color.textDim(text)
  }

  private categoryLine(id: SettingsWorkspaceCategoryId | undefined): string {
    if (id === undefined) return ''
    const selected = id === this.categoryId
    const marker = selected ? color.primary('> ') : '  '
    const label = CATEGORY_LABELS[id]
    // Cursor glyph = role 6 (`primary`), the selected row's own text = role 8
    // (bold textStrong): two anchors, one meaning each.
    return `${marker}${selected ? color.textStrong(label) : color.text(label)}`
  }

  private rowLine(row: SettingsWorkspaceRow | undefined, width: number): string {
    if (row === undefined) return ''
    const selected = row.id === this.rowId
    const cursor = selected ? '> ' : '  '
    // The configured NAME is measured UNPADDED and owns its cells first (the
    // frozen hierarchy: the name stays identifiable, the list SUMMARY is what
    // truncates). Only a name that alone fills the pane drops the summary; the
    // remainder is then handed to the (truncatable) value, right-aligned.
    const lead = truncateToWidth(`${cursor}${sanitizedPhysicalLine(row.label)}`, width, '…', false)
    const leadCells = visibleWidth(lead)
    const summaryCellRoom = Math.max(0, width - leadCells - 1)
    const value = summaryCellRoom >= 1
      ? truncateToWidth(sanitizedPhysicalLine(row.summary), summaryCellRoom, '…', false)
      : ''
    const gap = Math.max(1, width - leadCells - visibleWidth(value))
    const pad = ' '.repeat(gap)
    // The cursor is the row's FIRST two cells whenever they survive truncation.
    const cursorText = leadCells >= 2 ? lead.slice(0, 2) : ''
    const rest = lead.slice(cursorText.length)
    if (selected) {
      // Role 8: the selected row is ONE emphasised run (label + value).
      return `${color.primary(cursorText)}${color.textStrong(`${rest}${pad}${value}`)}`
    }
    // Role 3/4: content in `text`, the secondary summary column in `textDim`.
    return `${cursorText}${color.text(`${rest}${pad}`)}${color.textDim(value)}`
  }

  /**
   * The Detail projection: browse keeps its original single scroll region; an
   * open choice composes the same facts above the candidate list with independent
   * scroll extents for each region.
   */
  private detailLines(width: number, viewport: number): DetailProjection {
    const row = this.selectedRow()
    if (this.choiceField() !== undefined && row?.edit !== undefined) {
      return this.choiceLines(row, width, viewport)
    }
    const includeTitle = this.currentLayout() !== 'narrow'
    const buttons = row === undefined ? [] : this.detailButtons(row)
    const pinned = buttons.length > 0 && viewport >= 2 ? 1 : 0
    const scrollViewport = Math.max(0, viewport - pinned)
    const directPage = this.categoryId === 'plugins'
      ? 'Plugin Manager'
      : this.categoryId === 'models'
        ? 'Models'
        : this.categoryId === 'account'
          ? 'Account'
          : 'this page'
    const content = row === undefined
      ? [color.textDim(`This category is a direct page entry. Press Enter or Right to open ${directPage}.`)]
      : this.detailContent(row, width, includeTitle)
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
    return { lines, content, viewport: scrollViewport, buttons: painted.painted, optionRows: [], confirmCandidateVisible: false }
  }

  /** Compose facts, optional heading, candidate viewport and pinned buttons.
   *  Long identities may reclaim only the approved optional rows. */
  private choiceLines(row: SettingsWorkspaceRow, width: number, viewport: number): DetailProjection {
    const actionRows = viewport >= 2 ? 1 : 0
    const scrollableRows = Math.max(0, viewport - actionRows)
    const options = row.edit?.options ?? []
    const blocks = this.choiceBlocks(row, width)
    const flattened = blocks.flat()
    const phase = this.editPhase
    const selectedOption = phase.kind === 'choosing' ? options[phase.index] : undefined
    const identityRows = selectedOption === undefined
      ? 0
      : wrapTextWithAnsi(escapedPhysicalLine(selectedOption.value), Math.max(1, width - 2)).length
    let factRows = scrollableRows >= 6 ? 3 : scrollableRows >= 4 ? 2 : scrollableRows >= 2 ? 1 : 0
    let headingRows = scrollableRows - factRows >= 2 ? 1 : 0
    let optionViewport = Math.max(0, scrollableRows - factRows - headingRows)
    if (identityRows > optionViewport) {
      // Keep the original split by default. A long selected identity first
      // reclaims the optional heading, then facts only down to the old Value row;
      // confirmation still requires the entire raw identity to fit in the result.
      const previousFactRows = this.paintedPanes.detail?.factRegion?.rows ?? 0
      const previousOptionRows = this.paintedPanes.detail?.optionRegion?.rows ?? 0
      headingRows = 0
      optionViewport = Math.max(0, scrollableRows - factRows)
      if (identityRows > optionViewport && factRows > 1) {
        factRows = Math.max(1, scrollableRows - identityRows)
        optionViewport = Math.max(0, scrollableRows - factRows)
      }
      if (previousFactRows !== factRows || previousOptionRows !== optionViewport) this.detailOffset = 0
    }
    const factContent = this.detailContent(row, width, false, true)
    const factMaxOffset = Math.max(0, factContent.length - factRows)
    this.detailOffset = Math.min(Math.max(0, this.detailOffset), factMaxOffset)
    const visibleFacts: string[] = []
    for (let i = 0; i < factRows; i += 1) visibleFacts.push(factContent[this.detailOffset + i] ?? '')

    const optionOffset = this.rebaseChoice(blocks, optionViewport, width)
    const lines = [...visibleFacts]
    if (headingRows === 1) lines.push(color.textStrong('Choose value'))
    for (let i = 0; i < optionViewport; i += 1) lines.push(flattened[optionOffset + i] ?? '')

    let selectedStart = -1
    let cursor = 0
    for (const [index, block] of blocks.entries()) {
      if (phase.kind === 'choosing' && index === phase.index) selectedStart = cursor
      cursor += block.length
    }
    const confirmCandidateVisible = optionViewport > 0
      && selectedStart >= optionOffset
      && selectedStart + identityRows <= optionOffset + optionViewport
    const confirmActionVisible = confirmCandidateVisible
      && this.paintedViewport >= 3
      && renderActionBarRow(
        [CHOICE_CONFIRM_HINT, CHOICE_BACK_HINT],
        this.chrome?.width ?? width,
      ).includes(CHOICE_CONFIRM_HINT.text)
    const actionButtons = actionRows === 1 && factRows > 0 && optionViewport > 0
      ? this.detailButtons(row).filter(button => button.verb !== 'confirm' || confirmActionVisible)
      : []
    const painted = actionRows === 1 ? this.layoutButtons(width, actionButtons) : { text: '', painted: [] }
    if (actionRows === 1) lines.push(painted.text)

    const optionRows: { value: string; line: number; endCol: number }[] = []
    let start = 0
    for (const [index, block] of blocks.entries()) {
      const end = start + block.length
      const option = options[index]
      if (option !== undefined) {
        for (let line = Math.max(start, optionOffset); line < Math.min(end, optionOffset + optionViewport); line += 1) {
          optionRows.push({ value: option.value, line: factRows + headingRows + line - optionOffset, endCol: width })
        }
      }
      start = end
    }
    return {
      lines,
      content: factContent,
      viewport: factRows,
      buttons: painted.painted,
      optionRows,
      ...(factRows === 0 ? {} : {
        factRegion: { lineStart: 0, rows: factRows, maxOffset: factMaxOffset },
      }),
      ...(optionViewport === 0 ? {} : {
        optionRegion: {
          lineStart: factRows + headingRows,
          rows: optionViewport,
          maxOffset: Math.max(0, flattened.length - optionViewport),
        },
      }),
      confirmCandidateVisible,
    }
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
      // State chips (design language §4.5): ONE lowercase chip per boolean
      // state — `[current]` is the neutral `textMuted` chip, `[unavailable]` is
      // a problem state and takes `warning`. The chips keep their OWN ink, which
      // is why the row is composed as spans instead of one painted string.
      const chips: string[] = []
      if (option.current) chips.push(color.textMuted('[current]'))
      if (!option.available) chips.push(color.warning('[unavailable]'))
      const identity = escapedPhysicalLine(option.value)
      const label = sanitizedPhysicalLine(option.label)
      const body = `${identity}${label === identity ? '' : ` (${label})`}${chips.length === 0 ? '' : `  ${chips.join(' ')}`}`
      const chunks = wrapTextWithAnsi(body, Math.max(1, width - 2))
      const rows = chunks.length === 0 ? [''] : chunks
      return rows.map((chunk, line) => {
        const cursor = line === 0 && selected ? color.primary('> ') : '  '
        return `${cursor}${selected ? color.textStrong(chunk) : color.text(chunk)}`
      })
    })
  }

  /** The writable field the panel is CHOOSING for, or undefined in every other
   *  phase. While choosing, facts and candidates share the selected row's Detail
   *  pane; leaving that level cancels the transient choice. */
  private choiceField(): SettingsWorkspaceWritableField | undefined {
    return this.editPhase.kind === 'choosing' ? this.editPhase.field : undefined
  }

  /** Keep the highlighted candidate REVEALED: only a CANDIDATE, VIEWPORT or LAYOUT WIDTH
   *  change may pull the list back (a wheel may scroll it so the highlight leaves the
   *  viewport — a plain repaint must never fight that, while a real shrink or a narrower
   *  pane that re-flows the wrapped candidates must reveal the highlight again). A multi-line candidate reveals as a whole when it
   *  fits; when it is TALLER than the viewport its HEAD is revealed, never a
   *  marker-less continuation tail. Confirm stays unavailable until every wrapped
   *  line of the raw value identity is inside the painted option viewport. */
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
   *  non-writable row only ever offers copy/legacy.
   *
   *  A verb label never wears brackets (design language §4.5): `Verb [Key]` when
   *  the affordance has a key, `Verb` for a click-only action, `Verb…` when it
   *  opens a further step. */
  private detailButtons(row: SettingsWorkspaceRow): readonly DetailButton[] {
    const phase = this.editPhase
    if (phase.kind === 'choosing') {
      return [
        { verb: 'confirm', text: 'Confirm', id: phase.candidate },
        { verb: 'cancel', text: 'Cancel', id: row.id },
      ]
    }
    const buttons: DetailButton[] = []
    const edit = row.edit
    if (edit !== undefined && edit.options.length > 0 && phase.kind !== 'pending') {
      buttons.push({ verb: 'change', text: 'Change…', id: row.id })
      if (phase.kind === 'settled' && phase.field === edit.field && phase.outcome !== 'verified') {
        buttons.push({ verb: 'retry', text: 'Retry save', id: phase.attempted })
      }
    }
    if (row.value !== undefined) buttons.push({ verb: 'copy', text: `Copy value [${SETTINGS_LOCAL_KEYS.copy.toUpperCase()}]`, id: row.id })
    else if (row.action === 'open-legacy') buttons.push({ verb: 'legacy', text: 'Open existing settings…', id: row.id })
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
      paint += ' '.repeat(gap) + color.primary(button.text)
      painted.push({ button, startCol: cells + gap })
      cells += gap + buttonCells
    }
    return { text: paint, painted }
  }

  /** The commit status of the row's own field, as the last settlement reported
   *  it. Only the row that owns the phase shows it — never a global banner.
   *  The WORD and its tone are separate from the explanation so the pane can
   *  paint only the word with the semantic token (design language §3.2): a
   *  refused write must not look like a verified one. */
  private editStatus(field: SettingsWorkspaceWritableField): SettingsCommitStatus | undefined {
    const phase = this.editPhase
    if (phase.kind === 'pending' && phase.field === field) {
      return { word: 'Saving…', reason: 'the Host has not confirmed yet', tone: 'muted' }
    }
    if (phase.kind !== 'settled' || phase.field !== field) return undefined
    if (phase.outcome === 'verified') return { word: 'Verified', reason: 'the authoritative read agrees', tone: 'success' }
    if (phase.outcome === 'not-saved') return { word: 'Not saved', reason: phase.reason ?? 'the write was refused', tone: 'error' }
    if (phase.outcome === 'indeterminate') {
      return { word: 'Outcome unknown', reason: phase.reason ?? 'the write could not be attributed', tone: 'warning' }
    }
    return {
      word: 'Commit accepted',
      reason: `verification unavailable${phase.reason === undefined ? '' : ` · ${phase.reason}`}`,
      tone: 'warning',
    }
  }

  private detailContent(row: SettingsWorkspaceRow, width: number, includeTitle: boolean, inlineChoice = false): string[] {
    const labelWidth = width >= 26 ? 12 : 8
    const bodyWidth = Math.max(1, width - labelWidth)
    const lines: string[] = []
    const fullFacts: string[] = []
    if (includeTitle) lines.push(color.textStrong(sanitizedPhysicalLine(row.label)))
    // Roles 3/4/5: labels are textDim, the PRIMARY field's value is `text` and
    // every secondary fact's value is one step weaker (`textDim`).
    const field = (
      label: string,
      value: string,
      ink: (text: string) => string = color.textDim,
      compact = false,
    ): void => {
      const head = fit(color.textDim(label), labelWidth)
      const escaped = escapedPhysicalLine(value)
      if (compact) {
        const clipped = truncateToWidth(escaped, bodyWidth, '…', false)
        lines.push(head + ink(clipped))
        if (visibleWidth(escaped) > bodyWidth) {
          const fullLabel = `Full ${label.toLowerCase()}`
          const fullHead = fit(color.textDim(fullLabel), labelWidth)
          const wrapped = wrapTextWithAnsi(escaped, bodyWidth)
          const parts = wrapped.length === 0 ? [''] : wrapped
          fullFacts.push(fullHead + ink(parts[0]!))
          for (const extra of parts.slice(1)) fullFacts.push(' '.repeat(labelWidth) + ink(extra))
        }
        return
      }
      const wrapped = wrapTextWithAnsi(escaped, bodyWidth)
      const parts = wrapped.length === 0 ? [''] : wrapped
      lines.push(head + ink(parts[0]!))
      for (const extra of parts.slice(1)) lines.push(' '.repeat(labelWidth) + ink(extra))
    }
    /** Role 9: the status WORD carries the semantic token and the explanation
     *  stays one step weaker. The two are painted as SEPARATE SPANS before
     *  wrapping — `wrapTextWithAnsi` closes a span at a line end and re-opens it
     *  on the next line, so a status word that wraps on a very narrow pane keeps
     *  its tone on EVERY character. */
    const statusField = (label: string, word: string, reason: string | undefined, paint: (text: string) => string): void => {
      const head = fit(color.textDim(label), labelWidth)
      const body = reason === undefined
        ? paint(word)
        : `${paint(escapedPhysicalLine(word))}${color.textDim(` · ${escapedPhysicalLine(reason)}`)}`
      const wrapped = wrapTextWithAnsi(body, bodyWidth)
      const parts = wrapped.length === 0 ? [''] : wrapped
      lines.push(head + parts[0]!)
      for (const extra of parts.slice(1)) lines.push(' '.repeat(labelWidth) + extra)
    }
    const edit = row.edit
    if (inlineChoice) {
      // Keep the first two authoritative facts in the initial viewport; full
      // source text is appended to this same scrollable projection only when the
      // compact line actually had to truncate it.
      field('Value', row.summary, color.text, true)
      if (edit !== undefined) {
        if (edit.primary === 'persisted') field('Runtime', edit.runtime, color.textDim, true)
        else field('Persisted', edit.persisted, color.textDim, true)
      }
      lines.push(...fullFacts)
    } else {
      field('Value', row.summary, color.text)
    }
    if (row.value !== undefined && row.value !== row.summary) field('Source', row.value)
    if (edit !== undefined) {
      if (!inlineChoice) {
        if (edit.primary === 'persisted') field('Runtime', edit.runtime)
        else field('Persisted', edit.persisted)
      }
      const status = this.editStatus(edit.field)
      if (status !== undefined) {
        const paint = status.tone === 'success' ? color.success
          : status.tone === 'error' ? color.error
            : status.tone === 'warning' ? color.warning
              : color.textDim
        statusField('Status', status.word, status.reason, paint)
      }
      if (edit.options.length === 0) field('Choice', 'No candidate is available for this setting right now.')
    }
    field('Scope', row.scope)
    field('Freshness', freshnessText(row, this.snapshot.configReadiness))
    field('Description', row.description)
    if (row.freshness === 'read-error' && this.snapshot.readIssue !== undefined) field('Issue', this.snapshot.readIssue)
    return lines
  }

  /** The pinned Action Bar (design language §7): the surface's own actions
   *  first and `Esc` LAST, while `Esc` keeps the highest drop priority. Whole
   *  segments are dropped by priority through the shared row layout, so a hint
   *  is never cut mid-word. */
  private renderActionBar(plan: SettingsChromePlan): string {
    const row = this.selectedRow()
    const copyable = row?.value !== undefined
    const back = this.focus === 'categories' ? 'Esc close' : 'Esc back'
    if (this.bodyFloor() < 1) return fit(color.textMuted(back), plan.width)
    let segments: ActionBarSegment[]
    let choiceFactScrollAvailable = false
    if (this.choiceField() !== undefined) {
      const detail = this.paintedPanes.detail
      const canNavigate = (detail?.optionRegion?.rows ?? 0) > 0 && this.paintedViewport >= 3
      const canReadFacts = (detail?.factRegion?.maxOffset ?? 0) > 0 && this.paintedViewport >= 3
      choiceFactScrollAvailable = canReadFacts
      segments = [
        ...canNavigate ? [{ text: 'Up/Down choose', short: 'Up/Down', priority: 5 }] : [],
        ...canReadFacts ? [{ text: 'PgUp/PgDn details', priority: 4 }] : [],
        ...this.paintedChoiceCandidateVisible && this.paintedViewport >= 3
          ? [CHOICE_CONFIRM_HINT]
          : [],
        ...copyable && this.paintedViewport >= 3 ? [{
          text: `${SETTINGS_LOCAL_KEYS.copy} copy value`,
          short: `${SETTINGS_LOCAL_KEYS.copy} copy`,
          priority: 4,
        }] : [],
        CHOICE_BACK_HINT,
      ]
    } else if (this.editPhase.kind === 'pending') {
      const detailScroll = (this.paintedPanes.detail?.maxOffset ?? 0) > 0
      segments = [
        { text: 'Saving… · one write at a time', priority: 3 },
        ...(this.focus === 'categories' ? [
          { text: 'Up/Down select', priority: 4 },
          { text: 'Right open', priority: 6 },
          { text: 'Enter open', priority: 5 },
        ] : []),
        ...(this.focus === 'rows' ? [
          { text: 'Up/Down select', priority: 4 },
          { text: 'Left back', priority: 7 },
          { text: 'Right details', priority: 6 },
          { text: 'Enter details', priority: 5 },
        ] : []),
        ...(this.focus === 'detail' && detailScroll ? [
          { text: 'Up/Down scroll', priority: 4 },
          { text: 'PgUp/PgDn details', priority: 3 },
          { text: 'Left back', priority: 7 },
        ] : this.focus === 'detail' ? [{ text: 'Left back', priority: 7 }] : []),
        { text: back, priority: 8 },
      ]
    } else if (this.focus === 'categories') {
      segments = this.navigationActionBarSegments()
    } else if (this.focus === 'rows') {
      const rowAction = row?.action === 'open-legacy' ? 'open' : row?.edit === undefined || row.edit.options.length === 0 ? 'details' : 'choose'
      segments = [
        { text: 'Up/Down select', priority: 4 },
        { text: 'Left back', priority: 7 },
        { text: `Right ${rowAction}`, priority: 6 },
        { text: `Enter ${rowAction}`, priority: 5 },
        { text: `${SETTINGS_LOCAL_KEYS.refresh} refresh`, priority: 2 },
        { text: back, priority: 8 },
      ]
    } else {
      const editable = row?.edit !== undefined && row.edit.options.length > 0
      const detailScroll = (this.paintedPanes.detail?.maxOffset ?? 0) > 0
      segments = [
        ...(editable ? [{ text: 'Enter choose', priority: 6 }] : []),
        ...(detailScroll ? [{ text: 'Up/Down scroll', priority: 4 }] : []),
        ...(detailScroll ? [{ text: 'PgUp/PgDn details', priority: 3 }] : []),
        { text: `${SETTINGS_LOCAL_KEYS.refresh} refresh`, priority: 2 },
        ...(copyable ? [{ text: `${SETTINGS_LOCAL_KEYS.copy} copy value`, priority: 1 }] : []),
        { text: 'Left back', priority: 7 },
        { text: back, priority: 8 },
      ]
    }
    // Role 13: hints are the WEAKEST readable ink (`textMuted`), one step below
    // the diagnostic line, so the bar never competes with content. The shared
    // row layout already padded/truncated to the pane width.
    const rendered = renderActionBarRow(segments, plan.width)
    const choosing = this.choiceField() !== undefined
    this.paintedChoiceNavigation = choosing && rendered.includes('Up/Down')
    this.paintedChoiceFactScroll = choosing && choiceFactScrollAvailable
    this.paintedEnterConfirm = choosing && rendered.includes(CHOICE_CONFIRM_HINT.text)
    this.paintedChoiceCopy = choosing && rendered.includes(`${SETTINGS_LOCAL_KEYS.copy} copy`)
    return color.textMuted(rendered)
  }

  // ── state helpers ────────────────────────────────────────────────────────

  private currentRows(): readonly SettingsWorkspaceRow[] {
    return this.snapshot.rows.filter(row => row.category === this.categoryId)
  }

  /** The count the Rows pane header states: the ONE visible direct-page
   *  affordance for Plugins, the real snapshot rows for every other category.
   *  It counts painted rows, never Host settings rows. */
  private rowsPaneCount(): number {
    return this.categoryId === 'plugins' ? 1 : this.currentRows().length
  }

  /** The UI-only Plugins entry affordance (S4-D2 / D2-0): a plain action name
   *  with a weak `Enter / Right` hint, deliberately WITHOUT the `> ` selection
   *  cursor — L0 keeps exactly one active signal, and this row is never a
   *  configurable Settings row. The hint drops WHOLE when it cannot fit. */
  private pluginLaunchLine(width: number): string {
    const label = `  ${color.textStrong('Open Plugin Manager')}`
    const hint = 'Enter / Right'
    const room = width - visibleWidth(label)
    const painted = room >= hint.length + 2
      ? `${label}  ${color.textMuted(hint)}`
      : label
    return fit(painted, width)
  }

  /** The first row of ONE legacy configuration category. A direct page
   *  (About/Models/Account) has NO row: the panel never borrows another
   *  category's row for it. */
  private firstRowOf(category: SettingsWorkspaceCategoryId): SettingsWorkspaceRowId | undefined {
    return this.snapshot.rows.find(row => row.category === category)?.id
  }

  private indexOfRow(rows: readonly SettingsWorkspaceRow[]): number {
    const index = rows.findIndex(row => row.id === this.rowId)
    return index < 0 ? 0 : index
  }

  private selectedRow(): SettingsWorkspaceRow | undefined {
    const row = this.snapshot.rows.find(candidate => candidate.id === this.rowId)
    // The Plugins category is a DIRECT page entry (no Rows level): a row of a
    // different category must never leak into its Detail preview.
    return row !== undefined && row.category === this.categoryId ? row : undefined
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
  private refresh(requestRender = true): void {
    const next = this.source.readSnapshot()
    this.snapshot = next
    if (next.rows.every(row => row.id !== this.rowId)) this.rowId = this.firstRowOf(this.categoryId)
    this.detailOffset = 0
    this.bumpRevision()
    if (requestRender) this.intents.requestRender()
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
    const width = this.projectionWidth()
    return planSettingsChrome(
      width,
      this.intents.rows(),
      this.intents.notice() !== undefined,
      this.choiceField() !== undefined,
      this.paintsDirectPage(width) ? 1 : 2,
    ).bodyRows
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

  // ── the inline Plugin Manager page (S4-D1) ────────────────────────────────

  /**
   * Enter the ONE Plugin Manager page INSIDE this already-leased workspace.
   * The page owns paint/keys/mouse while open; this panel keeps its L0/L1/L2
   * selection and scroll state and restores it on return.
   */
  private openPluginsPage(): void {
    if (this.pluginPage !== undefined || this.disposed) return
    const page = this.intents.onOpenPlugins?.(() => this.leavePluginsPage())
    if (page === undefined) return
    if ('focused' in page) (page as Component & { focused?: boolean }).focused = true
    this.pluginPage = page
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** The page's NORMAL close path: drop the page and land on L0 with Plugins
   * selected. The page itself already released its Host claim. */
  private leavePluginsPage(): void {
    const page = this.pluginPage
    if (page === undefined) return
    this.pluginPage = undefined
    if ('focused' in page) (page as Component & { focused?: boolean }).focused = false
    page.dispose?.()
    this.categoryId = 'plugins'
    this.focus = 'categories'
    this.bumpRevision()
    this.intents.requestRender()
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.pluginPage !== undefined) {
      this.pluginPage.handleInput?.(data)
      return
    }
    // The CONTENT focus belongs to the direct page: the root never forwards a
    // navigation key to it, and the page never receives a key the root owns.
    if (this.focus === 'content') {
      this.handleContentInput(data)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) return this.goBack()
    // Below the body floor every navigation/action target is invisible; only the
    // lifecycle/back key remains available. Read the live geometry because input
    // may arrive before a resize-triggered frame has painted.
    if (this.bodyFloor() < 1) return
    const copyKeyPressed = matchesKey(data, SETTINGS_LOCAL_KEYS.copy)
      || matchesKey(data, Key.shift(SETTINGS_LOCAL_KEYS.copy))
    if (matchesKey(data, 'left')) {
      if (this.focus !== 'categories') this.goBack()
      return
    }
    if (matchesKey(data, 'right')) {
      if (this.choiceField() === undefined && this.focus !== 'detail') this.confirm()
      return
    }
    // Choosing remains a transient phase of L2: candidate navigation requires
    // its complete Action Bar hint. Fact paging follows the painted fact region's
    // scroll extent, even when its optional hint is dropped for width.
    if (this.choiceField() !== undefined) {
      const paintedGeometryIsCurrent = this.lastRenderWidth === this.intents.columns()
        && this.lastRenderRows === this.intents.rows()
      if (matchesKey(data, 'up')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceNavigation) this.moveChoice(-1)
        return
      }
      if (matchesKey(data, 'down')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceNavigation) this.moveChoice(1)
        return
      }
      if (matchesKey(data, 'pageUp')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceFactScroll) this.page(-1)
        return
      }
      if (matchesKey(data, 'pageDown')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceFactScroll) this.page(1)
        return
      }
      if (matchesKey(data, 'home')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceNavigation) this.setChoice(0)
        return
      }
      if (matchesKey(data, 'end')) {
        if (paintedGeometryIsCurrent && this.paintedChoiceNavigation) this.setChoice(this.choiceCount() - 1)
        return
      }
      if (matchesKey(data, 'enter')) return this.confirmChoice('keyboard')
      if (copyKeyPressed
        && this.paintedChoiceCopy
        && this.lastRenderWidth === this.intents.columns()
        && this.lastRenderRows === this.intents.rows()) return this.copy()
      return
    }
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(-1)
    if (matchesKey(data, 'end')) return this.jump(1)
    if (matchesKey(data, 'enter')) return this.confirm()
    if (data === SETTINGS_LOCAL_KEYS.refresh || data === SETTINGS_LOCAL_KEYS.refresh.toUpperCase()) {
      this.refresh()
      this.source.onRefresh?.()
      return
    }
    if (copyKeyPressed) return this.copy()
    // Everything else is inert inside the workspace: no key leaks to the hidden
    // editor, transcript or a host composer action.
  }

  /**
   * The CONTENT focus: the direct page owns the keyboard. The About page is
   * read-only (it scrolls and it goes back); a real page owns every other key
   * and reports its own exit.
   */
  private handleContentInput(data: string): void {
    const page = this.authPage
    if (page === undefined) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'backspace') || matchesKey(data, 'left')) {
        this.returnToNavigation()
        return
      }
      if (matchesKey(data, 'up')) return this.scrollAbout(-1)
      if (matchesKey(data, 'down')) return this.scrollAbout(1)
      if (matchesKey(data, 'pageUp')) return this.scrollAbout(-this.aboutPageStep())
      if (matchesKey(data, 'pageDown')) return this.scrollAbout(this.aboutPageStep())
      if (matchesKey(data, 'home')) return this.setAboutOffset(0)
      if (matchesKey(data, 'end')) return this.setAboutOffset(Number.MAX_SAFE_INTEGER)
      // Everything else is inert: the About page is a read-only projection.
      return
    }
    // A bare Left may be claimed by the root ONLY when the page can safely
    // yield the focus. It is never turned into an Esc and never bypasses a
    // child modal, an auth flow or a pending mutation.
    if (matchesKey(data, 'left') && page.canYieldFocusToNavigation?.() === true) {
      this.returnToNavigation()
      return
    }
    // Recompute the live page budget BEFORE forwarding input: a resize can
    // arrive before its repaint frame, and Enter must not submit a form whose
    // confirm rows are no longer visible.
    this.syncAuthPageBody()
    const result = page.handleInput(data)
    if (result === 'exit') {
      this.returnToNavigation()
      return
    }
    if (result === 'open-account') {
      // The child already asked the root to switch (through the idempotent
      // `switchToAccountContent`); the root only confirms the target and never
      // builds a second page.
      if (this.categoryId === 'account' && this.authPageCategory === 'account') this.focus = 'content'
    }
  }

  /** The About page's own scroll step (presentation only). */
  private aboutPageStep(): number {
    return Math.max(1, this.paintedContentBox?.rows ?? 1)
  }

  private scrollAbout(delta: number): void {
    const next = Math.min(Math.max(0, this.aboutOffset + delta), this.aboutScrollExtent)
    if (next === this.aboutOffset) return
    this.aboutOffset = next
    this.bumpRevision()
    this.intents.requestRender()
  }

  private setAboutOffset(offset: number): void {
    const next = Math.min(Math.max(0, offset), this.aboutScrollExtent)
    if (next === this.aboutOffset) return
    this.aboutOffset = next
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * Return the keyboard to the category rail. The direct page KEEPS its
   * instance, its view, its draft and its watch: only a real category change
   * or a real close disposes it.
   */
  private returnToNavigation(): void {
    if (this.focus === 'categories') return
    this.focus = 'categories'
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * Select ONE category. The category is the ONLY selection state: the right
   * column follows it immediately (a direct page is mounted at once, the About
   * projection is painted by the root), and the keyboard stays on the rail.
   */
  private selectCategory(category: SettingsWorkspaceCategoryId, focus: SettingsWorkspaceFocus = 'categories'): void {
    const changed = category !== this.categoryId
    // A Host mutation owns the page: user navigation may not abandon it.
    if (changed && this.authPageHasPendingMutation()) return
    if (changed) {
      if (this.authPageCategory !== undefined && this.authPageCategory !== category) this.closeAuthPage()
      this.categoryId = category
      this.rowId = isDirectCategory(category) ? undefined : this.firstRowOf(category)
      this.rowOffset = 0
      this.detailOffset = 0
      this.resetChoice()
    }
    this.focus = focus
    // The direct page is mounted only when its content column is PAINTED: a
    // narrow terminal that still shows the category list has no right column,
    // and browsing an invisible category must not start a Host watch.
    if (this.paintsDirectContent()) {
      if (category === 'models') this.mountModelsPage({ view: 'list' })
      else if (category === 'account') this.mountAccountPage({ view: 'page' })
    }
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * Whether the direct content column is painted right now. Wide and medium
   * always paint it beside the category rail; a narrow terminal paints it only
   * while the content owns the focus.
   */
  private paintsDirectContent(): boolean {
    if (layoutForWidth(this.intents.columns()) !== 'narrow') return true
    return this.focus === 'content'
  }

  /**
   * Hand the keyboard to the direct page. The page is REUSED: an already
   * mounted page is never rebuilt and never re-reads the Host.
   */
  private enterContent(): void {
    const category = this.categoryId
    if (category === 'models') this.mountModelsPage({ view: 'list' })
    else if (category === 'account') this.mountAccountPage({ view: 'page' })
    this.focus = 'content'
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Esc/Backspace: choosing cancels straight back to L1; otherwise step one
   *  level back in every layout. Only L0 Esc/Backspace closes the workspace. */
  private goBack(): void {
    if (this.focus === 'detail') {
      this.leaveDetailTo('rows')
      return
    }
    if (this.focus === 'rows') {
      this.leaveDetailTo('categories')
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
    const factRows = this.paintedPanes.detail?.factRegion?.rows
    const step = this.focus === 'detail' && this.choiceField() !== undefined
      ? Math.max(1, factRows ?? 1)
      : this.paintedViewport
    if (this.focus === 'detail') return this.scroll(delta * step)
    if (this.focus === 'categories') return this.moveCategory(delta * step)
    this.moveRow(delta * step)
  }

  private jump(direction: 1 | -1): void {
    if (this.focus === 'detail') {
      this.detailOffset = direction < 0 ? 0 : Number.MAX_SAFE_INTEGER
      this.bumpRevision()
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

  private moveRow(delta: number): void {
    const rows = this.currentRows()
    if (rows.length === 0) return
    const index = this.indexOfRow(rows)
    const next = Math.min(Math.max(0, index + delta), rows.length - 1)
    this.selectRow(rows[next]!.id)
  }

  private selectRow(id: SettingsWorkspaceRowId, focus?: SettingsWorkspaceFocus): void {
    const changedRow = id !== this.rowId
    const targetFocus = focus ?? (this.choiceField() === undefined ? this.focus : 'rows')
    if (changedRow || targetFocus !== this.focus || (this.choiceField() !== undefined && targetFocus !== 'detail')) {
      this.leaveDetailTo(targetFocus, () => {
        if (!changedRow) return
        this.rowId = id
        this.detailOffset = 0
      })
      return
    }
    this.intents.requestRender()
  }

  private scroll(delta: number): void {
    const max = this.paintedPanes.detail?.maxOffset ?? 0
    const next = Math.min(Math.max(0, this.detailOffset + delta), max)
    if (next !== this.detailOffset) {
      this.detailOffset = next
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private confirm(): void {
    if (this.focus === 'detail') {
      if (this.choiceField() !== undefined) return this.confirmChoice('keyboard')
      return this.beginChoice()
    }
    if (this.focus === 'categories') {
      if (this.categoryId === 'plugins') {
        this.openPluginsPage()
        return
      }
      if (isDirectCategory(this.categoryId)) {
        this.enterContent()
        return
      }
      this.leaveDetailTo('rows')
      return
    }
    this.enterDetail()
  }

  /** Enter the one Detail level. Writable rows start choosing in the same
   *  transition; focus is committed before the candidate source is re-read. */
  private enterDetail(): void {
    const row = this.selectedRow()
    if (row?.action === 'open-legacy') {
      this.intents.onOpenLegacy(row.legacyTargetId)
      return
    }
    if (this.focus === 'detail') return
    this.focus = 'detail'
    this.bumpRevision()
    if (row?.edit !== undefined && this.editPhase.kind !== 'pending') {
      this.beginChoice()
      return
    }
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

  /** Enter the choice phase after re-reading the source so a contribution that
   *  unloaded since the last frame is no longer offered. */
  private beginChoice(): void {
    const row = this.selectedRow()
    if (row?.edit === undefined || this.editPhase.kind === 'pending') return
    if (this.focus !== 'detail') return
    this.refresh(false)
    const fresh = this.selectedRow()
    const options = fresh?.id === row.id ? fresh.edit?.options ?? [] : []
    if (fresh?.id !== row.id || fresh.edit === undefined || options.length === 0) {
      this.intents.requestRender()
      return
    }
    const current = options.findIndex(option => option.current)
    const index = current >= 0 ? current : 0
    this.resetChoice()
    this.editPhase = { kind: 'choosing', field: fresh.edit.field, candidate: options[index]!.value, index }
    this.choiceOffset = 0
    // These are layout sentinels, not authority: a new choice must reveal its
    // selected candidate on the first painted option frame.
    this.lastChoiceIndex = -1
    this.lastChoiceViewport = -1
    this.lastChoiceWidth = -1
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Enter / a click on `[Confirm]`: dispatch only when the complete candidate
   *  and both painted confirmation affordances are present in the current frame.
   *  A scrolled-away identity is revealed on the first keyboard press. */
  private confirmChoice(source: 'keyboard' | 'button'): void {
    const phase = this.editPhase
    const edit = this.selectedRow()?.edit
    if (phase.kind !== 'choosing' || edit === undefined || edit.field !== phase.field) return
    if (
      this.paintedRevision !== this.revision ||
      this.lastRenderWidth !== this.intents.columns() ||
      this.lastRenderRows !== this.intents.rows()
    ) return
    if (!this.paintedChoiceCandidateVisible) {
      if (source === 'keyboard') {
        this.lastChoiceIndex = -1
        this.bumpRevision()
        this.intents.requestRender()
      }
      return
    }
    if (!this.paintedEnterConfirm) return
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

  /** The keyboard Copy verb is Detail-local and carries the exact source value.
   *  While choosing, the caller additionally requires the painted Copy hint. */
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
    if (this.pluginPage !== undefined) return this.pluginPage.handleMouse?.(event)
    const inContent = this.contentAt(event.x, event.y)
    if (this.authPage !== undefined && inContent) {
      return this.authPage.handleMouse?.(this.translateMouseEvent(event))
    }
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    // The About page is the root's own read-only projection: its wheel scrolls
    // the projection, never a hidden pane.
    if (inContent && this.authPage === undefined) {
      this.scrollAbout(delta)
      return { handled: true }
    }
    const pane = this.paneAt(event.x, event.y)
    if (pane === undefined) return undefined
    if (pane === 'detail') {
      if (this.choiceField() === undefined) this.scroll(delta)
      else {
        const region = this.detailRegionAt(event.x, event.y)
        if (region === 'facts') this.scroll(delta)
        else if (region === 'options') this.scrollChoice(delta)
      }
    }
    else if (pane === 'rows') this.scrollRows(delta)
    else this.scrollCategories(delta)
    return { handled: true }
  }

  /** Whether one panel cell belongs to the painted content column. */
  private contentAt(x: number, y: number): boolean {
    const box = this.paintedContentBox
    if (box === undefined) return false
    return x >= box.x && x < box.x + box.width && y >= box.top && y < box.top + box.rows
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    // A new press always supersedes the other owner's press state.
    this.pressedGesture = undefined
    this.contentPressed = undefined
    if (this.pluginPage !== undefined) {
      this.pluginPage.onCellPress?.(x, y)
      return
    }
    if (this.authPage !== undefined) {
      this.syncAuthPageBody()
      this.contentPressed = undefined
      const box = this.paintedContentBox
      if (box !== undefined && x >= box.x && x < box.x + box.width && y >= box.top && y < box.top + box.rows) {
        this.contentPressed = {
          x,
          y,
          columns: this.intents.columns(),
          rows: this.intents.rows(),
          revision: this.revision,
        }
        this.authPage.onCellPress?.(x - box.x, y - box.top)
        return
      }
      // A click on the category rail falls through to the root's own hit map;
      // the page's own press must not survive that ownership change.
      this.authPage.cancelPointer?.()
    }
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
    if (this.pluginPage !== undefined) {
      this.pressedGesture = undefined
      this.contentPressed = undefined
      this.pluginPage.onCellClick?.(x, y)
      return
    }
    if (this.authPage !== undefined) {
      this.syncAuthPageBody()
      const box = this.paintedContentBox
      if (box !== undefined && x >= box.x && x < box.x + box.width && y >= box.top && y < box.top + box.rows) {
        // A release inside the content consumes the gesture: any root press from
        // before it is stale and must never fire the category rail.
        this.pressedGesture = undefined
        const pressed = this.contentPressed
        this.contentPressed = undefined
        if (pressed === undefined
          || pressed.columns !== this.intents.columns()
          || pressed.rows !== this.intents.rows()
          || pressed.revision !== this.revision) return
        // The press is proven: the content owns the keyboard from now on, and
        // the page runs its OWN action. The root's revision only moves after
        // the page has run, so the consumed press is not refused.
        this.focus = 'content'
        const result = this.authPage.onCellClick?.(x - box.x, y - box.top)
        if (result === 'exit') {
          this.returnToNavigation()
          return
        }
        if (result === 'open-account') {
          // The child already asked the root to switch (through the idempotent
          // `switchToAccountContent`); the root never builds a second page.
          if (this.categoryId === 'account' && this.authPageCategory === 'account') this.focus = 'content'
        }
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      // A wheel/click on the category rail keeps the root's identity path; the
      // pressed gesture below was recorded by the root's own onCellPress.
      this.contentPressed = undefined
      this.authPage.cancelPointer?.()
    }
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
      case 'category': {
        if (target.id === 'plugins' && this.categoryId === 'plugins') {
          this.openPluginsPage()
          return
        }
        if (!isCategoryId(target.id)) return
        this.selectCategory(target.id, 'categories')
        return
      }
      case 'plugin-launch':
        // The painted affordance is the SAME direct entry Enter/Right take: no
        // L1 transition, no row selection and no second page factory.
        this.openPluginsPage()
        return
      case 'row': {
        if (!isWorkspaceRowId(target.id)) return
        this.selectRow(target.id, 'rows')
        // The row's `open-legacy` action is the ONE navigation verb (never an
        // edit) and the painted row IS its target, exactly like Enter.
        const legacyRow = this.selectedRow()
        if (legacyRow?.action === 'open-legacy') this.intents.onOpenLegacy(legacyRow.legacyTargetId)
        return
      }
      case 'copy':
        this.takeColumnFocus('detail')
        this.copySelected()
        return
      case 'legacy': {
        this.takeColumnFocus('detail')
        // The Detail bar belongs to the SELECTED row: its own deeplink target
        // travels with the action (absent = the editor's top).
        const legacyDetailRow = this.selectedRow()
        this.intents.onOpenLegacy(legacyDetailRow?.action === 'open-legacy' ? legacyDetailRow.legacyTargetId : undefined)
        return
      }
      case 'change':
        if (this.focus === 'detail') this.beginChoice()
        else this.enterDetail()
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
        this.confirmChoice('button')
        return
      case 'cancel':
        this.leaveDetailTo('rows')
        return
      case 'pane': {
        if (!isWorkspacePage(target.id)) return
        const page = target.id
        // The Plugins category has NO L1/L2 of its own: its Rows and Details
        // columns are the direct-page description only, so the pane fallback
        // must never fabricate a level the keyboard cannot return from. Other
        // categories keep their normal column focus.
        if (this.categoryId === 'plugins' && page !== 'categories') return
        if (page === 'detail' && this.focus !== 'detail') this.enterDetail()
        else this.takeColumnFocus(page)
        return
      }
    }
  }

  /** Commit a leave-L2 transition, its atomic selection change, and choice
   *  cancellation at one revision boundary. */
  private leaveDetailTo(page: SettingsWorkspaceFocus, update?: () => void): void {
    const cancelChoice = this.choiceField() !== undefined && page !== 'detail'
    if (this.focus === page && !cancelChoice && update === undefined) return
    if (cancelChoice) this.resetChoice()
    update?.()
    this.focus = page
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Make one column the keyboard owner (no-op when it already is). */
  private takeColumnFocus(page: SettingsWorkspaceFocus): void {
    this.leaveDetailTo(page)
  }

  private scrollRows(delta: number): void {
    const pane = this.paintedPanes.rows
    if (pane === undefined) return
    this.rowOffset = Math.min(Math.max(0, this.rowOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  /** The wheel over the candidate region scrolls only its painted extent. */
  private scrollChoice(delta: number): void {
    const region = this.paintedPanes.detail?.optionRegion
    if (region === undefined) return
    const next = Math.min(Math.max(0, this.choiceOffset + delta), region.maxOffset)
    if (next !== this.choiceOffset) {
      this.choiceOffset = next
      this.bumpRevision()
    }
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

  private detailRegionAt(x: number, y: number): 'facts' | 'options' | undefined {
    const pane = this.paintedPanes.detail
    if (pane === undefined || x < pane.x || x >= pane.x + pane.width) return undefined
    const inRegion = (region: PaintedRegion | undefined): boolean =>
      region !== undefined && y >= region.top && y < region.top + region.rows
    if (inRegion(pane.factRegion)) return 'facts'
    if (inRegion(pane.optionRegion)) return 'options'
    return undefined
  }

  private targetAt(x: number, y: number): HitTarget | undefined {
    return this.paintedTargets.find(target => target.row === y && x >= target.startCol && x < target.endCol)
  }

  /** Translate one panel-global mouse event into the page-local coordinates its
   * last-painted hit map uses. */
  private translateMouseEvent(event: TuiMouseEvent): TuiMouseEvent {
    const box = this.paintedContentBox
    if (box === undefined) return event
    return {
      ...event,
      x: event.x - box.x,
      y: event.y - box.top,
      screenX: event.screenX - box.x,
      screenY: event.screenY - box.top,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeAuthPage()
    // An external Settings teardown releases the hosted Plugin page's owner
    // exactly once; its own normal close path never runs for this case.
    const page = this.pluginPage
    this.pluginPage = undefined
    if (page !== undefined) {
      if ('focused' in page) (page as Component & { focused?: boolean }).focused = false
      page.dispose?.()
    }
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
