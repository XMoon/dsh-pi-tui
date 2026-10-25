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
 * DisplayState / presentation-preference readers. Every editable row (see
 * {@link SettingsWorkspaceWritableField}) is a request through the existing
 * `onCommit` intent; the writer behind that intent stays the ONE existing
 * authority of its field, so the panel never applies, persists or re-reads a
 * value itself. Every other setting keeps its existing read and
 * legacy-editor handoff behavior. Configuration rows expose no copy verb at all:
 * their `value` is read-only presentation, and there is no replacement copy
 * entry for a configuration field. About's `c`/`C` copy About's OWN facts
 * (runtime, Session identity, statistics, performance, Context) — never a
 * configuration row's value. Plugin Manager Diagnostics and the Models/Account
 * pages keep their own business copy.
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
import { formatKeyId } from '../keybindings/hints.ts'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import { pickWelcomeWhaleVariant, renderWelcomeWhaleLines, WELCOME_WHALE_WIDTH } from '../components/welcome-whale.ts'
import { aboutFactRows, serializeAboutStatus as serializeAboutStatusOf, type AboutFact, type AboutStatusView } from '../../domain/status/about.ts'
import type { ModelsInitialView, ModelsPageExit, ModelsWorkspacePage } from './models-workspace-page.ts'
import type { AccountInitialView, AccountWorkspacePage } from './account-workspace-page.ts'
import type { EmbeddedPluginPage, PluginWorkspaceView } from '../plugin-manager/workspace.ts'

/** The Settings categories. `About` is the default home of the workspace;
 * `Models`, `Account` and `Plugins` are direct content pages; the
 * configuration categories keep their three-level browse. `extensions` is the
 * ONE CONDITIONAL category: it is selectable only while the extension settings
 * registry has live rows (see {@link SettingsWorkspacePanel.currentCategoryOrder}). */
export type SettingsWorkspaceCategoryId =
  | 'about' | 'models' | 'account' | 'agent' | 'appearance' | 'conversation'
  | 'input-terminal' | 'tools' | 'plugins' | 'extensions'

/** The navigation level of the LEGACY configuration categories: `categories`
 *  (L0) → `rows` (L1) → `detail` (L2).
 *  This is the SAME state in every width — the layout only decides which
 *  panes of the current level are visible. */
export type SettingsWorkspacePage = 'categories' | 'rows' | 'detail'

/** The ONE navigation focus state of the workspace. The three legacy levels
 * plus `content`: the direct page (About/Models/Account/Plugins) that the category
 * rail previews and hands the keyboard to. */
export type SettingsWorkspaceFocus = SettingsWorkspacePage | 'content'

/** The categories whose RIGHT column is a real page instead of the legacy
 *  L0/L1/L2 configuration panes. `plugins` is the embedded Plugin Manager page:
 *  it paints inside this SAME workspace lease and shares its ONE chrome. */
export type SettingsWorkspaceDirectCategoryId = 'about' | 'models' | 'account' | 'plugins'

/** The stable identity of one readonly pilot row. The `*-settings-legacy` rows
 *  are the R0 TRANSITION launchers: each one names the exact existing-editor
 *  row it focuses and runs no write of its own. */
export type SettingsWorkspaceRowId =
  | 'theme'
  | 'icon-style'
  | 'display-preset'
  | 'expand'
  | 'thinking'
  | 'progress-updates'
  | 'response-style'
  | 'busy-enter'
  | 'git-attribution'
  | 'home-end-keys'
  | 'fullscreen'
  | 'wheel-scroll-lines'
  | 'notification-mode'
  | 'notification-method'
  | 'terminal-progress'
  | 'visual-tools'
  | 'web-settings'
  | 'approval'
  | 'default-permission'
  | 'subagent-model-allowlist'
  | 'subagent-model-selection'
  | 'local-shell-sandbox'
  | 'footer-settings-legacy'
  | 'input-terminal-settings-legacy'
  | 'extension-settings-legacy'

/** How current one row's value is, as the reader proved it. */
export type SettingsWorkspaceFreshness = 'runtime' | 'ready' | 'last-known' | 'unavailable' | 'read-error'

/**
 * The rows the workspace can edit. Each one has exactly ONE writer, and the
 * writers are of three kinds (they never merge):
 *  - a HOST-authority switch (`visual-tools`, the profile-wide built-in tool
 *    registration, revision-checked through its own Config section);
 *  - a TUI-settings-document preference applied live first and then persisted
 *    (`theme`, `display-preset`, `icon-style`, `progress-updates`,
 *    `response-style`);
 *  - a Client-local RUNTIME-ONLY disclosure state with NO document field and no
 *    persistence claim (`expand`, `thinking`).
 * Everything else in the workspace stays a readable row; a not-yet-migrated
 * setting stays behind its category's `existing settings editor` launcher.
 */
export type SettingsWorkspaceWritableField =
  | 'theme' | 'display-preset' | 'visual-tools'
  | 'icon-style' | 'expand' | 'thinking'
  | 'progress-updates' | 'response-style'
  | 'busy-enter' | 'git-attribution'
  | 'home-end-keys' | 'fullscreen' | 'wheel-scroll-lines'
  | 'notification-mode' | 'notification-method' | 'terminal-progress'
  | 'approval' | 'default-permission' | 'subagent-model-selection' | 'local-shell-sandbox'

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
  /** A SECOND live effect fact that is NOT the primary `Value`, painted as its
   *  own `Runtime` line. Only the session approval row needs it today: its
   *  `Value` already is a runtime fact (the captured session's override), while
   *  what the NEXT approval really consumes is the consumer's fallback when no
   *  override exists. Absent on every other row. */
  readonly runtimeEffect?: string
  /** The authority revision this candidate source was read at, when the row's
   *  write is revision-checked (the Host visual-tools switch). The commit
   *  request carries it back as the conflict fence, so an external edit between
   *  the read and the Confirm can never be silently overwritten. Rows whose
   *  writer is not revision-addressed omit it. */
  readonly revision?: number
}

/**
 * ONE row of the detached read projection. `summary` is the human-facing
 * display value, `value` the exact source value the authority answered (a
 * source-qualified theme id, a raw configured icon style, a runtime preset) —
 * never a re-derived display string. It is a read/presentation fact: a
 * configuration row has no copy verb, so `value` is never a clipboard payload.
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
  /** C2-R3: the ONE row that opens an embedded SPECIALIST page inside this same
   *  workspace body (the existing subagent allowlist picker). It is a
   *  presentation seam only — no document field, no writer, no second lease.
   *  A row without it never has a specialist page. */
  readonly specialist?: 'subagent-allowlist'
  /** Whether the row's specialist page may be opened RIGHT NOW. Absent = yes.
   *  A non-current authority (a stale/unavailable backend) paints the row and
   *  its last-known facts but offers no Manage action, because the page could
   *  only refuse every write. */
  readonly specialistAvailable?: boolean
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
  /** The revision the confirmed candidate was read at (revision-checked rows
   *  only): the writer submits it as its expected revision. */
  readonly revision?: number
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
  /** C2-R3: the ONE typed follow-up navigation a refusal may carry (the
   *  subagent toggle refused because the allowlist is empty points the user at
   *  the allowlist row). It is a one-shot UI instruction returned ONLY with a
   *  `not-saved` outcome; the panel applies it while this request is still the
   *  live one. It is not a second settings authority and it is never derived
   *  from the reason text. */
  readonly followUpRowId?: 'subagent-model-allowlist'
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
  /** The extension settings registry revision this snapshot was assembled at.
   *  It is a DERIVED presentation fact (the registry stays the authority), and
   *  it is what makes an `Extension` category member of the directory: a
   *  same-id replacement keeps the count while the revision moves, so the
   *  count alone can never prove a painted row is still current. */
  readonly extensionRevision?: number
  /** How many live extension settings rows existed at this revision. */
  readonly extensionCount?: number
}

/** The live extension settings DIRECTORY projection: the registry revision and
 *  the live row count, read synchronously and without any write. */
export interface SettingsWorkspaceExtensionDirectory {
  readonly revision: number
  readonly count: number
}

/** The read-only projection the app supplies (no shadow store, no watch). */
export interface SettingsWorkspaceSource {
  readSnapshot(): SettingsWorkspaceSnapshot
  /**
   * The LIVE extension settings directory (`SettingsRegistry.snapshot()`), read
   * synchronously before every input/mouse/render decision. It only reports the
   * in-process registry's own `{revision,count}`; it never re-reads the TUI
   * document, never writes and never becomes a second registry. Absent in
   * compositions that carry no extension settings at all.
   */
  readonly extensionDirectory?: () => SettingsWorkspaceExtensionDirectory
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
   * C3: the lazily built per-open About status owner. Present = the About
   * page renders its snapshot (`aboutFactRows`) with the full fact
   * navigation/copy keyboard; absent = the legacy two-version About. The
   * controller is constructed by the command layer per workspace open; the
   * panel only reads and subscribes.
   */
  readonly aboutStatusSource?: () => import('../../app/command/about-status.ts').AboutStatusController
  /** C3: one semantic About entry (exactly one scoped snapshot refresh). */
  readonly onAboutEnter?: () => void
  /** C3: the About page left (pending About updates become no-ops). */
  readonly onAboutLeave?: () => void
  /**
   * The Plugins category is a DIRECT page entry, not an empty Rows level: the
   * app owner builds the ONE embedded Plugin Manager page lazily and returns
   * it. `onYieldNavigation` is THIS root's navigation yield: the page reports
   * the intent (Esc/Left/Shift+Tab at its list root) and the root commits the
   * focus change; it never closes the page by itself.
   */
  readonly onOpenPlugins?: (onYieldNavigation: () => void) => EmbeddedPluginPage | undefined
  /** The lazily built Models direct page (the Settings category keeps the
   * same screen lease). `openAccount` switches this workspace to the Account
   * page when the Models list's account entry is activated. */
  readonly createModelsPage?: (
    initial: ModelsInitialView,
    openAccount: () => void,
  ) => SettingsAuthPage | undefined
  /** The lazily built Account direct page. */
  readonly createAccountPage?: (initial: AccountInitialView) => SettingsAuthPage | undefined
  /**
   * C2-R3: the ONE embedded specialist page factory, activated ONLY by an
   * explicit Manage/Enter on a row that carries `specialist`. It returns the
   * EXISTING subagent allowlist picker instance, which is mounted in this
   * workspace's body under the SAME screen lease (no second alt-screen, no
   * legacy editor). `done` returns to the Agent rows; `onAuthoritativeChange`
   * asks the root for a fresh snapshot of that row.
   */
  readonly createSubagentAllowlistPicker?: (
    done: () => void,
    onAuthoritativeChange: () => void,
  ) => EmbeddedSpecialistPage | undefined
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
  /** The pane header is reserved INSIDE `bodyRows` (0/1), never as a second
   *  physical grant: it exists only on a multi-column frame that can still
   *  leave one real content row. */
  readonly paneHeaderRows: 0 | 1
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

/** The absolute panel cells of ONE painted direct-page content column. */
interface ContentBox {
  readonly x: number
  readonly top: number
  readonly width: number
  readonly rows: number
}

/** Whether two content boxes describe the SAME painted cells. */
function sameContentBox(left: ContentBox | undefined, right: ContentBox | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.x === right.x
    && left.top === right.top
    && left.width === right.width
    && left.rows === right.rows
}

/** Whether one terminal cell belongs to the painted content column. */
function contentBoxContains(box: ContentBox, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.top && y < box.top + box.rows
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

/** The ONE embedded specialist page surface (C2-R3). It is the EXISTING
 *  subagent allowlist picker: the workspace root owns the screen/lease and
 *  gives it the body grant, exactly like the Models/Account pages, but it has
 *  no exit verb of its own — its `Esc` is the picker's own close, which returns
 *  to the Agent rows through the factory's `done` callback. */
export interface EmbeddedSpecialistPage extends Component {
  handleInput(data: string): void
  /** The bounded row budget the body grant really gives it. */
  setMaxRows(rows: number): void
  focused: boolean
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
  readonly kind: 'category' | 'row' | 'legacy' | 'pane' | 'change' | 'retry' | 'manage' | 'option' | 'confirm' | 'cancel' | 'about-action'
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
  readonly verb: 'change' | 'retry' | 'manage' | 'legacy' | 'confirm' | 'cancel'
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

/** The NINE category ids that always exist, in their visible order. `extensions`
 *  is deliberately NOT a member: it is the ONE conditional category, appended
 *  by {@link SettingsWorkspacePanel.currentCategoryOrder} only while the
 *  extension settings registry has live rows. This is the ONE fixed order
 *  every projection, keyboard path and hit map reads. */
const FIXED_CATEGORY_ORDER = [
  'about', 'models', 'account', 'agent', 'appearance',
  'conversation', 'input-terminal', 'tools', 'plugins',
] as const satisfies readonly SettingsWorkspaceCategoryId[]

const CATEGORY_LABELS: Record<SettingsWorkspaceCategoryId, string> = {
  about: 'About',
  models: 'Models',
  account: 'Account',
  agent: 'Agent',
  appearance: 'Appearance',
  conversation: 'Conversation',
  'input-terminal': 'Input & Terminal',
  tools: 'Tools',
  plugins: 'Plugins',
  extensions: 'Extensions',
}

/** Whether one category is a direct content page. */
function isDirectCategory(category: SettingsWorkspaceCategoryId): category is SettingsWorkspaceDirectCategoryId {
  return category === 'about' || category === 'models' || category === 'account' || category === 'plugins'
}

/** The typed guard for a painted category id. It answers only "is this a
 *  category id at all"; whether the id is SELECTABLE right now is decided by
 *  {@link SettingsWorkspacePanel.isSelectableCategory} against the LIVE
 *  directory, because `extensions` is conditional. */
function isCategoryId(id: string): id is SettingsWorkspaceCategoryId {
  return id === 'extensions' || (FIXED_CATEGORY_ORDER as readonly string[]).includes(id)
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
    || id === 'expand'
    || id === 'thinking'
    || id === 'progress-updates'
    || id === 'response-style'
    || id === 'busy-enter'
    || id === 'git-attribution'
    || id === 'home-end-keys'
    || id === 'fullscreen'
    || id === 'wheel-scroll-lines'
    || id === 'notification-mode'
    || id === 'notification-method'
    || id === 'terminal-progress'
    || id === 'visual-tools'
    || id === 'web-settings'
    || id === 'approval'
    || id === 'default-permission'
    || id === 'subagent-model-allowlist'
    || id === 'subagent-model-selection'
    || id === 'local-shell-sandbox'
    || id === 'footer-settings-legacy'
    || id === 'input-terminal-settings-legacy'
    || id === 'extension-settings-legacy'
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
/** The Settings workspace's fixed region-key labels: this leased screen owns
 *  them (they are not remappable Host actions), so the labels come from the
 *  key-label authority instead of a hand-written chord spelling. */
const SETTINGS_REGION_LABELS = {
  forward: formatKeyId(Key.tab),
  backward: formatKeyId(Key.shift(Key.tab)),
} as const
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
 * The decorative rule is LAST: it is granted only when the body would still
 * keep three real rows, so decoration never crowds out readable content.
 *
 * Every projection paints at most ONE rule, above its body. The pane header is
 * not an extra grant: `paneHeaderRows` is reserved INSIDE `bodyRows`, so a
 * multi-column frame spends its first body row on the header and leaves
 * `bodyRows - paneHeaderRows` real content rows.
 */
function planSettingsChrome(
  width: number,
  rows: number,
  noticeLive: boolean,
  choosing = false,
): SettingsChromePlan {
  const safeRows = Math.max(1, Math.floor(rows))
  const layout = layoutForWidth(width)
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  // Rows the body could use once the mandatory chrome is granted.
  const base = Math.max(0, safeRows - headerRows - actionRows)
  // §4.4: the notice keeps the body at two rows; the metadata keeps it at three.
  const noticeRows = safeRows >= 6 && noticeLive && base - 1 >= 2 ? 1 : 0
  const metaRows = !choosing && safeRows >= 8 && base - noticeRows - 1 >= 3 ? 1 : 0
  const bodyWithoutRules = base - noticeRows - metaRows
  const ruleRows = !choosing && bodyWithoutRules >= 5 ? 1 : 0
  const bodyRows = Math.max(0, bodyWithoutRules - ruleRows)
  const paneHeaderRows: 0 | 1 = layout !== 'narrow' && bodyRows >= 2 ? 1 : 0
  return {
    width,
    rows: safeRows,
    layout,
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    paneHeaderRows,
    actionRows,
    bodyRows,
  }
}

/** Whether two chrome plans allocate the SAME rows. The pointer hit maps of
 *  every projection derive from this allocation alone, so a repaint that keeps
 *  it is benign for a pending press while ANY change is a gesture boundary. */
function sameChromeRows(left: SettingsChromePlan | undefined, right: SettingsChromePlan): boolean {
  return left !== undefined
    && left.width === right.width
    && left.rows === right.rows
    && left.headerRows === right.headerRows
    && left.metaRows === right.metaRows
    && left.ruleRows === right.ruleRows
    && left.noticeRows === right.noticeRows
    && left.paneHeaderRows === right.paneHeaderRows
    && left.actionRows === right.actionRows
    && left.bodyRows === right.bodyRows
}

/** The physical projection of ONE chrome plan: `bodyTop` is the first granted
 *  body row, a granted pane header occupies it, and `contentRows` are the real
 *  content rows left below. Every root-level paint and hit decision derives
 *  from these values, so the direct and legacy projections cannot drift. */
function chromeGeometry(plan: SettingsChromePlan): {
  readonly bodyTop: number
  readonly contentTop: number
  readonly contentRows: number
} {
  const bodyTop = plan.headerRows + plan.metaRows + plan.ruleRows + plan.noticeRows
  return {
    bodyTop,
    contentTop: bodyTop + plan.paneHeaderRows,
    contentRows: Math.max(0, plan.bodyRows - plan.paneHeaderRows),
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
   *  (About/Models/Account/Plugins) has no row at all. */
  private rowId: SettingsWorkspaceRowId | undefined
  /** The extension settings registry revision/count the LIVE directory was last
   *  observed at. It is the currentness fence of the conditional `Extensions`
   *  category: a same-id re-registration keeps the COUNT and moves only the
   *  revision, so a count comparison alone can never prove the painted row is
   *  still current. */
  private directoryRevision = 0
  private directoryCount = 0
  /** The category order of the CURRENT directory (the fixed nine, plus
   *  `extensions` while the registry has live rows). Rebuilt only when the
   *  directory really changes. */
  private effectiveCategoryOrder: readonly SettingsWorkspaceCategoryId[] = FIXED_CATEGORY_ORDER
  /** Set by a directory change and cleared only by a COMPLETED frame that was
   *  composed against the still-current directory. While set, no key other
   *  than Esc and no pointer/wheel gesture may dispatch. */
  private directoryAwaitingPaint = false
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
  /**
   * C3: the About page's SELECTED SEMANTIC FACT (the row the `↑/↓`/`c`
   * keyboard operates on), skipped past section headers and the whale. It is
   * an id, never a physical row: a resize rewraps rows but keeps the fact.
   */
  private aboutSelectedFactId: string | undefined
  /** Whether the keyboard selection is on the About `Refresh context` action
   *  instead of a fact. Enter only fires the action while this is true AND the
   *  action is in the painted viewport; an ordinary fact is inert. */
  private aboutActionSelected = false
  /** The fact rows painted by the LAST About frame (the selection and copy
   *  operate on THIS captured revision's ids). */
  private paintedAboutFacts: readonly AboutFact[] = []
  /** The whale+header physical rows painted above the first fact row in the
   *  last frame (selection reveal subtracts them). */
  private paintedAboutHeaderRows = 0
  /** The C3 About controller subscription of THIS open (acquired lazily on
   *  the first About paint; released in dispose). */
  private aboutUnsubscribe: (() => void) | undefined
  /** The About ACTION targets collected by the LAST content render, in
   *  COLUMN rows (translated to panel rows by the direct-page painter):
   *  `copy-all` and `refresh`. Ordinary fact rows publish no target. */
  private paintedAboutTargets: readonly { readonly columnRow: number; readonly id: string; readonly startCol: number; readonly endCol: number }[] = []
  /** The exact IMMUTABLE About view the last frame painted. A copy gesture is
   *  refused unless this is still the controller's current snapshot: every
   *  publication allocates a new view, so OBJECT IDENTITY (not the epoch)
   *  distinguishes Loading from Ready inside one read — the epoch is shared by
   *  both publications, and an epoch check would copy an unpainted Ready
   *  snapshot from a frame that still shows Loading. */
  private paintedAboutView: AboutStatusView | undefined
  /** The ids the LAST completed About frame really painted in-view (the
   *  NON-consuming keyboard-activation record — `takePaintedAboutTargets`
   *  empties the click-target list, never this). */
  private paintedAboutActionIds: ReadonlySet<string> = new Set()
  /** The facts whose physical row span INTERSECTED the last painted viewport.
   *  This is the ONLY grant for the keyboard `c`: a fact that scrolled out of
   *  the frame has no value the user is reading, so `c` is inert for it. */
  private paintedAboutVisibleFactIds: ReadonlySet<string> = new Set()
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
    /** The hosted child page's own state identity at press time. The page can
     *  change its view/target set from a KEY the root forwards without moving
     *  the root's projection or content box (Details -> List at a wide width),
     *  so the root revision alone cannot fence that gesture. */
    readonly childIdentity: string
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
  /** The lazily built embedded Plugin Manager page (ONE instance per open,
   *  kept across Categories/content focus changes until the category really
   *  changes or this workspace is disposed). */
  private pluginPage: EmbeddedPluginPage | undefined
  /** The candidate viewport offset of the choice projection. */
  private choiceOffset = 0
  /** The candidate index/viewport/WIDTH the choice list was last rebased against. */
  private lastChoiceIndex = -1
  private lastChoiceViewport = -1
  private lastChoiceWidth = -1
  private readonly source: SettingsWorkspaceSource
  private readonly intents: SettingsWorkspacePanelIntents
  /** C2-R3: the ONE transient embedded specialist page (the existing subagent
   *  allowlist picker). It exists only between an explicit Manage/Enter on its
   *  row and the picker's own `done`/this workspace's teardown; it never
   *  survives a category change, and it owns no settings authority. */
  private specialistPage: EmbeddedSpecialistPage | undefined
  private specialistRow: SettingsWorkspaceRowId | undefined
  /** The panel cells the LAST specialist frame granted the picker, and the
   *  press identity a release must still match. */
  private paintedSpecialistBox: ContentBox | undefined
  private specialistPressed: {
    readonly x: number
    readonly y: number
    readonly columns: number
    readonly rows: number
    readonly revision: number
    readonly box: ContentBox
  } | undefined
  /** The active Models/Account direct page (at most one). */
  private authPage: SettingsAuthPage | undefined
  private authPageCategory: 'models' | 'account' | undefined
  /** The last painted content area (panel coordinates) for mouse translation.
   *  It covers the About page and the direct pages alike: the root owns ONE
   *  content box and ONE press map for the whole right column. */
  private paintedContentBox: ContentBox | undefined
  /** The root-level identity of one press inside the content area: a resize, a
   *  root state change OR a chrome change that moves the content box (an App
   *  notice) between press and release refuses the gesture even when the page
   *  has not repainted yet. */
  private contentPressed: {
    readonly x: number
    readonly y: number
    readonly columns: number
    readonly rows: number
    readonly revision: number
    /** The content box the press was admitted against. */
    readonly box: ContentBox
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
    this.initializeDirectory(this.snapshot)
    this.rowId = this.firstRowOf(this.categoryId)
    if (options?.initialRowId !== undefined) {
      const target = this.snapshot.rows.find(row => row.id === options.initialRowId)
      if (target !== undefined) {
        this.categoryId = target.category
        this.rowId = target.id
        this.focus = 'rows'
      }
    } else if (options?.initialCategory !== undefined) {
      if (this.isSelectableCategory(options.initialCategory)) {
        this.categoryId = options.initialCategory
        // The `/plugins` deep link lands with the keyboard on the Plugin List
        // (not on the rail): its ONE Settings lease paints the page on the first
        // real frame and starts on the list, never on a resumed install.
        this.focus = options.initialCategory === 'plugins' ? 'content' : 'categories'
      } else {
        // A stale internal request for the CONDITIONAL category (the registry
        // lost its rows before this open) never paints an empty Extensions
        // page: it falls back to the stable first-party neighbour.
        this.categoryId = 'plugins'
        this.focus = 'categories'
      }
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
    // C3: subscribe THIS panel to the per-open About owner. The subscription
    // only schedules a repaint (the panel never reads during it); the
    // semantic `enter()` is the command layer's explicit post-mount hook.
    if (this.intents.aboutStatusSource !== undefined) {
      const controller = this.intents.aboutStatusSource()
      this.aboutUnsubscribe = controller.subscribe(() => {
        if (this.disposed) return
        this.bumpRevision()
        this.intents.requestRender()
      })
    }
  }

  // ── the conditional extension-settings directory ─────────────────────────

  /**
   * Seed the directory from the CONSTRUCTOR snapshot. A source without
   * `extensionDirectory` (unit tests, historical compositions) contributes
   * only what its snapshot really stated, so no Extensions category is invented.
   */
  private initializeDirectory(snapshot: SettingsWorkspaceSnapshot): void {
    this.directoryRevision = snapshot.extensionRevision ?? 0
    this.directoryCount = snapshot.extensionCount ?? 0
    this.effectiveCategoryOrder = this.directoryCount > 0
      ? [...FIXED_CATEGORY_ORDER, 'extensions']
      : FIXED_CATEGORY_ORDER
  }

  /** The LIVE directory the source reports right now. Without a directory
   *  source the constructor snapshot stays the (static) answer. */
  private liveDirectory(): SettingsWorkspaceExtensionDirectory {
    const directory = this.source.extensionDirectory
    if (directory === undefined) {
      return { revision: this.directoryRevision, count: this.directoryCount }
    }
    return directory()
  }

  /** The category order of the CURRENT directory: the nine fixed ids, plus
   *  `extensions` while the extension settings registry has live rows. */
  private currentCategoryOrder(): readonly SettingsWorkspaceCategoryId[] {
    return this.effectiveCategoryOrder
  }

  /** Whether one category is SELECTABLE in the CURRENT directory. `extensions`
   *  is a type member but only a directory member while the registry has live
   *  rows; a painted id of a spent frame is never selectable. */
  private isSelectableCategory(category: SettingsWorkspaceCategoryId): boolean {
    return this.currentCategoryOrder().includes(category)
  }

  /**
   * Reconcile the conditional `Extensions` directory with the live registry
   * BEFORE any input/mouse/render decision dispatches. It is a synchronous
   * in-process projection (the registry is the authority), so an equal
   * `{revision,count}` costs one comparison and changes nothing.
   *
   * A real change is a pointer/keyboard boundary: the pressed gesture and the
   * last-painted hit map are revoked, the snapshot is re-read, the selected row
   * is re-anchored on a live row of its category, and the frame is fenced until
   * a paint composed against the CURRENT directory completes.
   */
  private syncExtensionDirectory(): boolean {
    const live = this.liveDirectory()
    if (live.revision === this.directoryRevision && live.count === this.directoryCount) return false
    const next = this.source.readSnapshot()
    this.snapshot = next
    // The frame is planned from the SNAPSHOT (its rows and its directory are
    // one read): adopting the live count here would paint a directory whose
    // rows the re-read did not describe.
    this.applyDirectory(next.extensionRevision ?? 0, next.extensionCount ?? 0)
    this.bumpRevision()
    this.intents.requestRender()
    return true
  }

  /** Commit one directory generation: the order, the revoked grants and the
   *  selection repair of the CURRENT snapshot.
   *
   *  A registry change invalidates the PAINTED FRAME — never a business state
   *  the change did not touch. The frame fence is unconditional; the selection
   *  and the transient edit are repaired only where they really stopped being
   *  valid. An unrelated `setValue()`/register/unload therefore keeps an open
   *  candidate choice and the user's scroll position. */
  private applyDirectory(revision: number, count: number): void {
    this.directoryRevision = revision
    this.directoryCount = count
    this.effectiveCategoryOrder = count > 0
      ? [...FIXED_CATEGORY_ORDER, 'extensions']
      : FIXED_CATEGORY_ORDER
    // The old frame's grants die with the directory change: a press recorded
    // against the previous registry generation can never complete against a
    // same-shaped target of the new one.
    this.cancelPointerOwners()
    this.paintedTargets = []
    this.directoryAwaitingPaint = true
    // The rail's rebase caches are LAYOUT sentinels, not cursors: a changed
    // directory length must re-reveal the selection on the next paint.
    this.lastCategoryIndex = -1
    this.lastCategoryViewport = -1
    let selectionInvalid = false
    if (!this.isSelectableCategory(this.categoryId)) {
      // The registry emptied under the selected Extensions category: the ONE
      // stable first-party neighbour takes the selection, the rail takes the
      // keyboard, and NOTHING is installed/enabled/removed by this recovery.
      this.categoryId = 'plugins'
      this.focus = 'categories'
      selectionInvalid = true
    }
    // The selected row must still exist in the CURRENT snapshot. A row that a
    // re-registered owner dropped is never kept by id alone.
    if (!this.snapshot.rows.some(row => row.id === this.rowId && row.category === this.categoryId)) {
      this.rowId = this.firstRowOf(this.categoryId)
      selectionInvalid = true
    }
    if (selectionInvalid) {
      // The selection itself changed: the transient edit and both list offsets
      // belonged to it. A pending/settled write is app-owned and is never
      // touched here.
      this.resetChoice()
      this.rowOffset = 0
      this.detailOffset = 0
      return
    }
    // The selection survived: only the candidate IDENTITIES may have moved (a
    // contribution list can grow or shrink under an open choice). Re-anchor the
    // choice on its VALUE and leave the scroll positions alone.
    this.reanchorChoice()
  }

  /** Keep the open candidate choice on the SAME candidate identity after a
   *  source re-read: a candidate whose source is gone drops the choice instead
   *  of painting a confirm that can no longer dispatch it; a moved candidate
   *  keeps its highlight. A non-choosing phase is untouched. */
  private reanchorChoice(): void {
    const phase = this.editPhase
    if (phase.kind !== 'choosing') return
    const options = this.snapshot.rows.find(row => row.edit?.field === phase.field)?.edit?.options ?? []
    const index = options.findIndex(option => option.value === phase.candidate)
    if (index < 0) this.editPhase = { kind: 'browsing' }
    else if (index !== phase.index) {
      this.editPhase = { kind: 'choosing', field: phase.field, candidate: phase.candidate, index }
    }
  }

  /** Adopt a freshly read snapshot WITHOUT re-reading it. A snapshot source
   *  without a live directory keeps the constructor's directory (a historical
   *  composition has no registry to observe). */
  private adoptSnapshot(next: SettingsWorkspaceSnapshot): void {
    this.snapshot = next
    if (this.source.extensionDirectory === undefined) return
    const revision = next.extensionRevision ?? this.directoryRevision
    const count = next.extensionCount ?? this.directoryCount
    if (revision === this.directoryRevision && count === this.directoryCount) return
    this.applyDirectory(revision, count)
    this.bumpRevision()
  }

  /** Publish (or keep withholding) the directory grant of the frame just
   *  painted. The frame counts as composed against the CURRENT registry only if
   *  the directory did not move while it was being rendered — a registration
   *  that lands inside a render callback makes THIS frame stale, so it keeps the
   *  fence and schedules the next one. */
  private settleDirectoryFence(painted: SettingsWorkspaceExtensionDirectory): void {
    if (!this.directoryAwaitingPaint) return
    const live = this.liveDirectory()
    if (live.revision !== painted.revision || live.count !== painted.count) {
      this.intents.requestRender()
      return
    }
    this.directoryAwaitingPaint = false
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
      this.choiceField() !== undefined,
    )
    // The child is rendered into the body grant + the ONE physical action row:
    // its own pinned bar is the semantic source of the root bar, and its body
    // must match what renderContentColumn really paints.
    page.setBodyHeight(Math.max(1, chromeGeometry(plan).contentRows + plan.actionRows))
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
    // The conditional `Extensions` directory is reconciled BEFORE the chrome is
    // planned: a frame must never be composed against a membership the input
    // and pointer fences already consider stale.
    this.syncExtensionDirectory()
    const paintedDirectory: SettingsWorkspaceExtensionDirectory = {
      revision: this.directoryRevision,
      count: this.directoryCount,
    }
    const lines = this.paintFrame(width)
    this.settleDirectoryFence(paintedDirectory)
    return lines
  }

  /** Compose ONE complete frame (the caller owns the directory sync/fence). */
  private paintFrame(width: number): string[] {
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
    )
    // A paint whose ROW ALLOCATION really changed is the same gesture boundary
    // as an unrepainted chrome change: the previous frame's press identity no
    // longer describes this frame, even when the pressed target's own cells
    // happen to be identical (an App notice can take the rule row while leaving
    // contentTop/contentRows untouched). A benign repaint with the same
    // allocation keeps the pending press.
    if (!sameChromeRows(this.chrome, plan)) {
      this.bumpRevision()
      this.cancelPointerOwners()
    }
    this.chrome = plan
    // Snapshot what THIS frame really shows, so the root can tell whether a later
    // focus/layout change has painted yet (narrow paints one region at a time).
    this.paintedLayout = plan.layout
    this.paintedFocus = this.focus
    this.paintedChoiceCandidateVisible = false
    this.paintedEnterConfirm = false
    this.paintedChoiceNavigation = false
    this.paintedChoiceFactScroll = false
    if (direct) {
      // The content column is on screen: the SELECTED page must exist. A page
      // the rail selected without creating it is created now — once, and only
      // on a frame that really paints at least one content row (an invisible
      // column never starts a Host page/read).
      const contentVisible = chromeGeometry(plan).contentRows > 0
      if (contentVisible && !this.directContentPainted) this.ensureDirectPageMounted()
      this.directContentPainted = contentVisible
      // The Plugin Manager projects its OWN responsive column set inside this
      // workspace; every other direct category keeps the shared rail + content
      // projection.
      return this.categoryId === 'plugins' ? this.renderPluginDirectPage(plan) : this.renderDirectPage(plan)
    }
    // The legacy projection paints no content column: the content box and its
    // press map belong to the direct layout alone.
    this.directContentPainted = false
    this.paintedContentBox = undefined
    // C2-R3: the embedded specialist page (the existing subagent allowlist
    // picker) owns the WHOLE body of this same workspace: it is not a direct
    // category, so it must be decided before the legacy panes project. While
    // it is mounted its hit map is the picker's own last-painted geometry and
    // the rows/detail panes publish nothing.
    if (this.specialistPage !== undefined) return this.renderSpecialistPage(plan)
    const lines: string[] = []
    const targets: HitTarget[] = []
    const panes: PaneBoxes = {}
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows === 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    if (plan.bodyRows > 0) lines.push(...this.renderBody(plan, chromeGeometry(plan).bodyTop, targets, panes))
    this.paintedPanes = panes
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
   * Whether the last painted frame showed the direct content column. The
   * column's APPEARANCE is the moment the selected page must exist: a narrow
   * rail that selected a category without creating the (then invisible) page
   * needs it created as soon as the column is really on screen.
   */
  private directContentPainted = false

  /**
   * Create the selected direct page when its content column is about to be
   * painted and the page does not exist yet. It runs on the layout TRANSITION
   * only: a mounted page is never rebuilt, and a category the user merely
   * browsed in a narrow rail never starts a Host watch before its column is
   * on screen.
   */
  private ensureDirectPageMounted(): void {
    if (this.categoryId === 'plugins') {
      this.ensurePluginPageMounted()
      return
    }
    if (this.authPageCategory === this.categoryId) return
    if (this.categoryId === 'models') this.mountModelsPage({ view: 'list' })
    else if (this.categoryId === 'account') this.mountAccountPage({ view: 'page' })
  }

  /**
   * Render the direct content page (About, Models, Account, Plugins) inside the
   * workspace chrome: the category rail stays visible on wide/medium, the
   * pane header states who owns the keyboard, and the content owns the rest of
   * the body. The ONE physical action bar is always the last row, starting at
   * X=0 exactly like the legacy bar.
   */
  private renderDirectPage(plan: SettingsChromePlan): string[] {
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows === 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    const narrow = plan.layout === 'narrow'
    const categoryWidth = narrow ? 0 : plan.layout === 'wide' ? WIDE_CATEGORY_WIDTH : MEDIUM_CATEGORY_WIDTH
    const contentX = narrow ? 0 : categoryWidth + COLUMN_GAP
    const contentWidth = Math.max(1, plan.width - contentX)
    const geometry = chromeGeometry(plan)
    if (plan.paneHeaderRows === 1) {
      lines.push(this.renderDirectPaneHeader(categoryWidth, contentWidth))
    }
    const contentTop = geometry.contentTop
    const contentRows = geometry.contentRows
    // The child is laid out for its body PLUS its own pinned last-row bar. The
    // root then keeps the body rows and moves that already-generated hint to
    // the frame's physical last row instead of letting the child own it.
    const childHeight = contentRows + plan.actionRows
    const contentColumn = this.renderContentColumn(contentWidth, childHeight)
    const semanticBar = contentColumn[childHeight - 1] ?? ''
    // C3: the About page's own painted targets (field Copy / Copy All /
    // Refresh rows), collected during the content render in COLUMN coordinates.
    const aboutTargets = this.takePaintedAboutTargets()
    const visible = narrow ? [] : this.visibleCategories(contentRows)
    for (let index = 0; index < contentRows; index += 1) {
      const content = fit(contentColumn[index] ?? '', contentWidth)
      if (narrow) {
        lines.push(content)
      } else {
        const id = visible[index]
        const rail = fit(id === undefined ? '' : this.categoryLine(id), categoryWidth)
        lines.push(`${rail}${' '.repeat(COLUMN_GAP)}${content}`)
        if (id !== undefined) {
          targets.push({ kind: 'category', id, row: contentTop + index, startCol: 0, endCol: categoryWidth })
        }
      }
      // The About targets translate from COLUMN rows to panel rows. A PAINTED
      // About button is clickable regardless of which pane owns the keyboard
      // (plan §2.1: mouse targets are the last-painted cells, keyboard focus
      // is a separate axis — the rail keeps its keys while the visible
      // Copy All/Refresh stay clickable). EVERY target on the row registers
      // (the action row paints Refresh AND Copy All side by side).
      for (const columnTarget of aboutTargets.filter(target => target.columnRow === index)) {
        targets.push({
          kind: 'about-action',
          id: columnTarget.id,
          row: contentTop + index,
          startCol: contentX + columnTarget.startCol,
          endCol: contentX + columnTarget.endCol,
        })
      }
    }
    // The ONE physical last-row bar: the rail's own semantics while the rail
    // owns the keyboard, else the semantic hint the child page generated. It
    // starts at X=0 and spans the whole frame; the child chose its segments
    // against the content width it really paints.
    const bar = this.focus === 'categories' ? this.renderNavigationActionBar(plan.width) : semanticBar
    lines.push(fit(bar, plan.width))
    this.paintedContentBox = { x: contentX, top: contentTop, width: contentWidth, rows: contentRows }
    const categories = this.currentCategoryOrder()
    this.paintedPanes = {
      categories: narrow ? undefined : {
        x: 0,
        width: categoryWidth,
        contentTop,
        contentRows: Math.min(categories.length, contentRows),
        maxOffset: Math.max(0, categories.length - contentRows),
      },
    }
    this.paintedTargets = targets
    this.paintedRevision = this.revision
    return lines.slice(0, plan.rows)
  }

  /** The direct layout's pane header: the category rail on the left and the
   *  selected content page on the right, using the SAME `[Label]` active device
   *  as the legacy pane headers. Display-only: it publishes no hit target and
   *  owns no focus. */
  private renderDirectPaneHeader(categoryWidth: number, contentWidth: number): string {
    const left = fit(this.paneHeader(`Categories (${this.currentCategoryOrder().length})`, this.focus === 'categories'), categoryWidth)
    const right = fit(this.paneHeader(CATEGORY_LABELS[this.categoryId], this.focus !== 'categories'), contentWidth)
    return `${left}${' '.repeat(COLUMN_GAP)}${right}`
  }

  /**
   * The content column of the direct layout. The real page owns its own lines
   * (its last line is its semantic action hint); the About page is a root-owned
   * read-only projection with the root's own semantic bar. The root moves that
   * last line to the physical last row and paints only the body here.
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
    const order = this.currentCategoryOrder()
    const selected = order.indexOf(this.categoryId)
    if (selected !== this.lastCategoryIndex || viewport !== this.lastCategoryViewport) {
      this.categoryOffset = rebaseOffset(this.categoryOffset, selected, order.length, viewport)
      this.lastCategoryIndex = selected
      this.lastCategoryViewport = viewport
    } else {
      this.categoryOffset = clampOffset(this.categoryOffset, order.length, viewport)
    }
    return order.slice(this.categoryOffset, this.categoryOffset + viewport)
  }

  /**
   * The About projection: the SHARED whale (the Welcome card's own pattern
   * and brand gradient) plus the C3 semantic fact rows when a per-open
   * controller exists — otherwise the legacy two-version rows. The render is
   * PURE: it reads the controller's CURRENT immutable snapshot and paints it;
   * it never calls enter(), refresh(), a stats reader or the coordinator.
   */
  private renderAboutContent(width: number, rows: number): string[] {
    const facts = this.intents.aboutVersionFacts
    const lines: string[] = []
    let headerRows: number
    if (rows >= 9 && width >= WELCOME_WHALE_WIDTH) {
      lines.push(...renderWelcomeWhaleLines(this.aboutWhaleVariant))
      lines.push('')
      lines.push(color.textStrong('dsh-pi-tui'))
      headerRows = lines.length
    } else {
      lines.push(color.textStrong('🐋 dsh-pi-tui'))
      headerRows = lines.length
    }
    const controller = this.intents.aboutStatusSource?.()
    if (controller === undefined) {
      // Legacy two-version About (no per-open controller composed).
      lines.push(...this.aboutFactRows('TUI  ', facts.tui, width))
      lines.push(...this.aboutFactRows('DSH  ', facts.dsh ?? 'Unknown', width))
      this.paintedAboutFacts = []
      this.paintedAboutView = undefined
      this.paintedAboutVisibleFactIds = new Set()
      this.aboutActionSelected = false
      this.paintedAboutHeaderRows = 0
      this.aboutScrollExtent = Math.max(0, lines.length - rows)
      const offset = clampOffset(this.aboutOffset, lines.length, rows)
      this.aboutOffset = offset
      return lines.slice(offset, offset + rows)
    }
    // C3: the semantic fact rows of the CURRENT captured view. One captured
    // revision supplies every displayed string; copy reads THE SAME captured
    // view (bound below), never a re-read at copy time.
    const capturedView = controller.snapshotView()
    const aboutFacts = aboutFactRows(capturedView)
    const selectedId = this.rebaseAboutSelection(aboutFacts)
    const live = capturedView.session.kind !== 'none'
    // A sessionless view hides the Session-only Refresh action: the action
    // cannot stay selected without a painted action to select.
    if (!live) this.aboutActionSelected = false
    // A selected Refresh action costs the 2-cell cursor; the action row drops
    // whole segments from the END (Copy All first), so the selected action is
    // valid only while the cursor + its whole label fit. Clear an invalid
    // selection BEFORE the fact rows paint, so a boundary width never frames
    // "no selection at all".
    const refreshText = `Refresh context [${SETTINGS_LOCAL_KEYS.refresh.toUpperCase()}]`
    if (this.aboutActionSelected && visibleWidth(refreshText) > Math.max(1, width - 2)) {
      this.aboutActionSelected = false
    }
    const bodyWidth = Math.max(1, width - 2)
    const rowCounts = new Map<string, number>()
    const body: string[] = []
    // The physical first row of every fact group in COLUMN coordinates (the
    // header rows scroll with the facts). The viewport slice below turns these
    // spans into the keyboard copy grant.
    const factStarts = new Map<string, number>()
    for (const fact of aboutFacts) {
      // One semantic fact = one wrapped physical row group. The label owns its
      // column; the value wraps below it and is never truncated. A fact paints
      // NO per-row affordance: `c` copies the selected visible fact and the bar
      // advertises that key (Settings About copy contract).
      const head = color.textDim(`${fact.label}  `)
      const selected = !this.aboutActionSelected && fact.id === selectedId
      // Cursor glyph = role 6 (`primary`), the selected row's text = role 8
      // (bold textStrong) — the same anchors the category rail uses.
      const marker = selected ? color.primary('> ') : '  '
      const bodyText = selected
        ? color.textStrong(sanitizedPhysicalLine(fact.displayValue))
        : color.text(sanitizedPhysicalLine(fact.displayValue))
      const parts = wrapTextWithAnsi(bodyText, Math.max(1, bodyWidth - visibleWidth(marker) - visibleWidth(head)))
      const wrapped = parts.length === 0 ? [''] : parts
      rowCounts.set(fact.id, wrapped.length)
      factStarts.set(fact.id, headerRows + body.length)
      wrapped.forEach((part, index) => {
        body.push(index === 0 ? `${marker}${head}${part}` : `${' '.repeat(visibleWidth(marker) + visibleWidth(head))}${part}`)
      })
    }
    this.paintedAboutFacts = aboutFacts
    this.paintedAboutFactRows = rowCounts
    this.paintedAboutHeaderRows = headerRows
    // The ACTION row: the fixed logical `Refresh context` + `Copy All`
    // affordances, painted as REAL targets (clicks run the same intents as
    // the keyboard). Per plan §2.1: the Session-only Refresh is HIDDEN while
    // sessionless, and the row degrades as WHOLE SEGMENTS (the action-bar
    // rule) — a target exists only for a segment that survived the width.
    // The target's `columnRow` is the ABSOLUTE column row; the painter only
    // registers it when that row landed inside the painted viewport.
    const actionSegments: { readonly id: string; readonly text: string }[] = [
      ...(live ? [{ id: 'about:refresh', text: refreshText }] : []),
      { id: 'about:copy-all', text: `Copy All [${SETTINGS_LOCAL_KEYS.copy.toUpperCase()}]` },
    ]
    const actions: { readonly columnRow: number; readonly id: string; readonly startCol: number; readonly endCol: number }[] = []
    const placeActions = (available: number, shift: number): string =>
      this.aboutActionBarSegments(actionSegments, available, (id: string, startCol: number, endCol: number) => {
        actions.push({ columnRow: headerRows + body.length, id, startCol: startCol + shift, endCol: endCol + shift })
      })
    const actionSelected = this.aboutActionSelected && live
    let actionRow = placeActions(actionSelected ? Math.max(1, width - 2) : width, actionSelected ? 2 : 0)
    if (actionSelected && !actions.some(target => target.id === 'about:refresh')) {
      // The selected Refresh segment did not survive the width: it cannot be
      // the selected action. Fall back to the fact selection and rebuild the
      // row WITHOUT a dangling cursor.
      this.aboutActionSelected = false
      actions.length = 0
      actionRow = placeActions(width, 0)
    }
    if (this.aboutActionSelected) actionRow = color.primary('> ') + actionRow
    body.push(actionRow)
    // ONE physical column: the whale/header rows + the fact rows (+ actions).
    // The offset scrolls THIS list; the header scrolls away with the facts.
    const column = [...lines, ...body]
    this.paintedAboutFacts = aboutFacts
    this.aboutScrollExtent = Math.max(0, column.length - rows)
    const offset = clampOffset(this.aboutOffset, column.length, rows)
    this.aboutOffset = offset
    // Drop targets whose absolute row the viewport slice cut off (they are
    // NOT painted; a click there is blank space and must never copy). The
    // consumed targets are VIEWPORT-relative and bound to THE VIEW OBJECT the
    // paint came from: a publication that supersedes this view invalidates
    // the whole target set at once (revoked by the painted-view identity
    // check). The epoch alone cannot prove the paint is current: Loading and
    // Ready share one epoch.
    this.paintedAboutView = capturedView
    // The NON-consuming record of what the frame painted (the Enter/keyboard
    // activation reads this AFTER the painter consumed the target list).
    this.paintedAboutActionIds = new Set(actions
      .filter(target => target.columnRow >= offset && target.columnRow < offset + rows)
      .map(target => target.id))
    this.paintedAboutTargets = actions
      .filter(target => target.columnRow >= offset && target.columnRow < offset + rows)
      .map(target => ({ ...target, columnRow: target.columnRow - offset }))
    // The ONE keyboard copy grant of THIS paint: a fact whose physical row span
    // INTERSECTS the viewport (a partially visible fact is visible). A fact that
    // scrolled out of the frame is not copyable — `c` never emits a value the
    // frame does not show.
    const visibleFactIds = new Set<string>()
    for (const fact of aboutFacts) {
      const start = factStarts.get(fact.id)
      if (start === undefined) continue
      const end = start + (rowCounts.get(fact.id) ?? 1)
      if (end > offset && start < offset + rows) visibleFactIds.add(fact.id)
    }
    this.paintedAboutVisibleFactIds = visibleFactIds
    return column.slice(offset, offset + rows)
  }

  /**
   * Lay out the About ACTION row with WHOLE-SEGMENT degradation (the shared
   * action-bar rule): segments are dropped from the END until the row fits;
   * a surviving segment's painted cells are reported through `onPlaced` so
   * its hit target covers exactly the painted cells. A single remaining
   * segment that still cannot fit paints nothing clickable (the keyboard
   * shortcuts stay reachable — the plan's narrow rule).
   */
  private aboutActionBarSegments(
    segments: readonly { readonly id: string; readonly text: string }[],
    width: number,
    onPlaced: (id: string, startCol: number, endCol: number) => void,
  ): string {
    // PURE placement first (no side effects): drop whole segments from the
    // END until the row fits; only the FINAL placement list is painted and
    // reported — a dropped segment never leaves a ghost hitbox.
    let kept = [...segments]
    const measure = (list: readonly { readonly id: string; readonly text: string }[]): number =>
      list.reduce((total, segment) => total + visibleWidth(segment.text) + 2, 0) - (list.length > 0 ? 2 : 0)
    while (kept.length > 1 && measure(kept) > width) kept.pop()
    if (measure(kept) > width) {
      // One segment left and it cannot fit: paint it truncated WITHOUT any
      // clickable identity (keyboard remains the affordance).
      const single = kept[0]!
      return truncateToWidth(color.textMuted(single.text), width, '…', true)
    }
    const parts: string[] = []
    let col = 0
    for (const segment of kept) {
      const start = col
      // The affordance token (design language §7.1 role 14): the painted
      // actionable segments are `primary`, matching the legacy Detail
      // buttons.
      parts.push(color.primary(segment.text))
      col += visibleWidth(segment.text)
      onPlaced(segment.id, start, col)
      parts.push('  ')
      col += 2
    }
    return parts.join('').trimEnd()
  }

  /** The About targets the LAST content render painted (consumed by the
   *  direct-page painter exactly once per frame). */
  private takePaintedAboutTargets(): readonly { readonly columnRow: number; readonly id: string; readonly startCol: number; readonly endCol: number }[] {
    const targets = this.paintedAboutTargets
    this.paintedAboutTargets = []
    return targets
  }

  /**
   * One version fact as PHYSICAL rows. A version value is never truncated: it
   * wraps onto the next row (the label keeps its column) so the whole fact
   * stays readable by scrolling the About page.
   */
  private aboutFactRows(label: string, value: string, width: number): string[] {
    const head = color.textDim(label)
    const body = color.text(sanitizedPhysicalLine(value))
    const bodyWidth = Math.max(1, width - visibleWidth(head))
    const parts = wrapTextWithAnsi(body, bodyWidth)
    const rows = parts.length === 0 ? [''] : parts
    return rows.map((part, index) =>
      index === 0 ? head + part : ' '.repeat(visibleWidth(head)) + part)
  }

  // ── C3: the About semantic-fact keyboard/copy group ──────────────────────

  /** Whether the C3 About fact model is active (a controller + painted rows). */
  private aboutSelected(): boolean {
    return this.intents.aboutStatusSource !== undefined
  }

  /** The controller, or `undefined` (no About fact model composed). */
  private aboutController(): import('../../app/command/about-status.ts').AboutStatusController | undefined {
    return this.intents.aboutStatusSource?.()
  }

  /** Rebase the selected fact id onto the CURRENT painted rows: keep the id
   *  while its row survives, otherwise select the first fact. Returns the
   *  effective id (or `undefined` when no facts exist). */
  private rebaseAboutSelection(facts: readonly AboutFact[]): string | undefined {
    if (facts.length === 0) {
      this.aboutSelectedFactId = undefined
      this.aboutActionSelected = false
      return undefined
    }
    if (this.aboutSelectedFactId === undefined || !facts.some(fact => fact.id === this.aboutSelectedFactId)) {
      this.aboutSelectedFactId = facts[0]!.id
      this.aboutActionSelected = false
    }
    return this.aboutSelectedFactId
  }

  /** Move the About selection by one row. The ends clamp like every other
   *  Settings list; ↓ past the LAST fact enters the painted `Refresh context`
   *  action (only while it is really in the viewport), and ↑ returns to the
   *  last fact. Enter is only accepted on that explicitly selected action. */
  private moveAboutSelection(delta: number): void {
    const facts = this.paintedAboutFacts
    if (facts.length === 0) return
    if (this.aboutActionSelected) {
      if (delta < 0) {
        this.aboutActionSelected = false
        this.bumpRevision()
        this.intents.requestRender()
      }
      return
    }
    const index = facts.findIndex(fact => fact.id === this.aboutSelectedFactId)
    const current = index === -1 ? 0 : index
    if (delta > 0 && current === facts.length - 1 && this.aboutRefreshActionInView()) {
      this.aboutActionSelected = true
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const next = Math.min(Math.max(0, current + delta), facts.length - 1)
    this.selectAboutFact(facts[next]!.id)
  }

  /** PgUp/PgDn: scroll a screen AND move the selection by the same step. */
  private pageAboutSelection(step: number): void {
    const facts = this.paintedAboutFacts
    if (facts.length === 0) return
    // Paging always lands on a FACT: drop an action selection before the
    // nearest-fact computation.
    this.aboutActionSelected = false
    const rows = Math.max(1, Math.floor(Math.abs(step)))
    const direction = Math.sign(step)
    // Scroll the PHYSICAL painted rows one screen, then select the NEAREST
    // fact in the new viewport (plan §2.1): the fact whose first painted row
    // is fully/partially inside the post-scroll viewport.
    const nextOffset = Math.min(
      Math.max(0, this.aboutOffset + direction * rows),
      this.aboutScrollExtent,
    )
    if (nextOffset !== this.aboutOffset) {
      this.aboutOffset = nextOffset
    }
    // The painted rows of the fact groups (absolute column rows) after the
    // scroll: header + the wrapped spans BEFORE each fact.
    let row = this.paintedAboutHeaderRows
    let bestIndex = -1
    let bestDistance = Number.MAX_SAFE_INTEGER
    for (let index = 0; index < facts.length; index += 1) {
      const span = this.lastAboutFactRowCount(facts[index]!.id)
      const start = row
      const end = row + span
      row = end
      const inViewport = end > this.aboutOffset && start < this.aboutOffset + this.aboutPageStep()
      if (!inViewport) continue
      const anchor = start >= this.aboutOffset ? start : this.aboutOffset
      const distance = Math.abs(anchor - this.aboutOffset)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }
    // THE RENDER GUARANTEE: the physical offset may have moved even when the
    // nearest fact is still the selected one (a long wrapped fact spans the
    // viewport) — the input dispatch never schedules a repaint itself, so a
    // same-id selection must still bump + render whenever the offset moved.
    const targetId = facts[bestIndex === -1 ? 0 : bestIndex]!.id
    if (targetId === this.aboutSelectedFactId) {
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    this.selectAboutFact(targetId)
  }
  private selectAboutFactByIndex(index: number): void {
    const facts = this.paintedAboutFacts
    if (facts.length === 0) return
    const clamped = Math.min(Math.max(0, index), facts.length - 1)
    this.selectAboutFact(facts[clamped]!.id)
  }

  /** Commit one fact selection: reveal its physical row group. */
  private selectAboutFact(id: string): void {
    if (this.aboutSelectedFactId === id && !this.aboutActionSelected) return
    this.aboutActionSelected = false
    this.aboutSelectedFactId = id
    this.revealAboutFact(id)
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Scroll the painted offset so the selected fact's FIRST row is visible. */
  private revealAboutFact(id: string): void {
    const facts = this.paintedAboutFacts
    const index = facts.findIndex(fact => fact.id === id)
    if (index === -1) return
    // The painted row of the fact's first physical line: header rows + the
    // wrapped groups before it. The wrap counts come from the LAST paint.
    let row = this.paintedAboutHeaderRows
    for (let at = 0; at < index; at += 1) row += this.lastAboutFactRowCount(facts[at]!.id)
    if (row < this.aboutOffset) this.aboutOffset = row
    else if (row >= this.aboutOffset + this.aboutPageStep()) this.aboutOffset = row - this.aboutPageStep() + 1
  }

  /** The wrapped physical row count of one fact at the last paint (best
   *  effort from the painted width: reveal only needs an approximation that
   *  stays inside the same viewport). */
  private lastAboutFactRowCount(id: string): number {
    return this.paintedAboutFactRows.get(id) ?? 1
  }

  /** The per-fact physical row counts painted by the LAST frame. */
  private paintedAboutFactRows = new Map<string, number>()

  /** The controller ONLY when its current snapshot is still the exact view
   *  this panel painted: a publication between the paint and the gesture
   *  revokes the painted facts/targets (the gesture is refused, never
   *  retargeted). Object identity, not the epoch: one read publishes Loading
   *  and then Ready under the SAME epoch, so an epoch check would hand a
   *  gesture a view the terminal never painted. */
  private paintedAboutController(): import('../../app/command/about-status.ts').AboutStatusController | undefined {
    const controller = this.aboutController()
    if (controller === undefined || this.paintedAboutView === undefined) return undefined
    if (controller.snapshotView() !== this.paintedAboutView) return undefined
    return controller
  }

  /** Whether the frame the About copy grant came from is still the live frame:
   *  the terminal geometry and the root chrome must not have moved since the
   *  paint (an unrepainted resize/notice means the cells on screen are not the
   *  frame the grant was derived from). */
  private aboutFrameIsCurrent(): boolean {
    return !this.terminalGeometryStale() && !this.chromeGeometryStale()
  }

  /** `c`: copy the SELECTED fact's RAW copy value from THE VIEW THIS PANEL
   *  PAINTED (never the painted ANSI string, never a re-read, never a newer
   *  revision that has not been painted yet). Inert unless the selection is a
   *  fact (the Refresh action is not one), that fact was really painted inside
   *  the last viewport, and no state change has superseded that frame. */
  private copyAboutFact(): void {
    if (this.aboutActionSelected) return
    if (this.paintedRevision !== this.revision) return
    if (!this.aboutFrameIsCurrent()) return
    const id = this.aboutSelectedFactId
    if (id === undefined || !this.paintedAboutVisibleFactIds.has(id)) return
    if (this.paintedAboutController() === undefined) return
    const fact = this.paintedAboutFacts.find(row => row.id === id)
    if (fact === undefined) return
    this.intents.onCopy(fact.copyValue)
  }
  /** `C` / Copy All: serialize THE VIEW THIS PANEL PAINTED (the stable Copy
   *  All contract, all defined facts even when offscreen; a publication
   *  between paint and gesture refuses the copy). It is deliberately NOT gated
   *  on the painted `Copy All` badge or on the fact selection: a narrow frame
   *  may drop that segment while `C` stays the reachable shortcut for the whole
   *  report that IS on screen. */
  private copyAboutAll(): void {
    const painted = this.paintedAboutView
    if (painted === undefined || this.paintedAboutController() === undefined) return
    this.intents.onCopy(serializeAboutStatusOf(painted))
  }

  /** `r` / the Refresh action: ONE About-scoped refresh (never the Web
   *  settings async read, never the coordinator directly). */
  private aboutRefresh(): void {
    this.aboutController()?.refresh()
  }

  /** Whether the painted `Refresh context` action is in the CURRENT viewport.
   *  Both the ↓-past-the-last-fact selection and the Enter activation require
   *  this; a painted-id record is NON-consuming (the click-target list is
   *  consumed per frame). */
  private aboutRefreshActionInView(): boolean {
    return this.paintedAboutActionIds.has('about:refresh')
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
   *  category rail — it never closes the workspace. With the C3 fact model the
   *  bar advertises the keys the CURRENT frame really honours: `c copy fact`
   *  only for a selected fact that is on screen, `C copy all` only while the
   *  painted About view is still the controller's current snapshot. Below the
   *  body floor every navigation target is invisible, so only Esc survives. */
  private renderAboutActionBar(width: number): string {
    if (this.bodyFloor() < 1) return color.textMuted('Esc back')
    const about = this.categoryId === 'about' && this.paintedAboutController() !== undefined
    const factCopyable = about
      && !this.aboutActionSelected
      && this.aboutSelectedFactId !== undefined
      && this.paintedAboutVisibleFactIds.has(this.aboutSelectedFactId)
    return color.textMuted(renderActionBarRow([
      ...(this.aboutScrollExtent > 0 ? [{ text: 'Up/Down scroll', priority: 4 }] : []),
      ...(factCopyable ? [{ text: `${SETTINGS_LOCAL_KEYS.copy} copy fact`, priority: 3 }] : []),
      ...(about ? [{ text: `${SETTINGS_LOCAL_KEYS.copy.toUpperCase()} copy all`, priority: 2 }] : []),
      ...(this.aboutSelected() ? [{ text: `${SETTINGS_LOCAL_KEYS.refresh} refresh`, priority: 5 }] : []),
      ...this.regionActionBarHints('focus', true),
      { text: 'Esc back', priority: 8 },
    ], width))
  }

  /**
   * The region-navigation hints of the root bars (plan §4.1.5). They are
   * low-priority, whole-segment-droppable advertisements of the keys that
   * really work in THIS focus and layout: a narrow frame has no second region,
   * a Plugin category is owned by the Plugin Manager, and a choice/pending
   * phase does not advertise a key it ignores.
   */
  private regionActionBarHints(forward: 'focus' | 'panes', backward: boolean): ActionBarSegment[] {
    if (layoutForWidth(this.intents.columns()) === 'narrow') return []
    // Priority 0 is the LOWEST drop priority in the workspace: on a tight
    // bar the region keys always yield first, so they can never crowd out an
    // existing semantic action hint (`c copy fact`, `C copy all`, `r refresh`)
    // or a navigation hint.
    return [
      { text: `${SETTINGS_REGION_LABELS.forward} ${forward === 'focus' ? 'focus' : 'panes'}`, priority: 0 },
      ...(backward ? [{ text: `${SETTINGS_REGION_LABELS.backward} back`, priority: 0 }] : []),
    ]
  }

  /** The category rail's own hints. A direct category hands the keyboard to
   *  its content page; a legacy category steps one level deeper. */
  private navigationActionBarSegments(): ActionBarSegment[] {
    // The rail can be re-focused while a legacy write is still pending (the
    // workspace deliberately allows browsing during a pending write), and the
    // root's region key is a no-op in that phase. An active choice owns the
    // keys too: neither may be advertised as usable.
    const regionKeyUsable = this.choiceField() === undefined && this.editPhase.kind !== 'pending'
    if (isDirectCategory(this.categoryId)) {
      return [
        { text: 'Up/Down navigate', priority: 4 },
        { text: 'Enter/Right focus', priority: 6 },
        ...(regionKeyUsable ? this.regionActionBarHints('focus', false) : []),
        { text: 'Esc close', priority: 8 },
      ]
    }
    return [
      { text: 'Up/Down select', priority: 4 },
      { text: 'Right open', priority: 6 },
      { text: 'Enter open', priority: 5 },
      ...(regionKeyUsable && this.currentRows().length > 0 ? this.regionActionBarHints('panes', false) : []),
      { text: 'Esc close', priority: 8 },
    ]
  }

  invalidate(): void {
    this.pluginPage?.invalidate?.()
    this.specialistPage?.invalidate?.()
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
    const breadcrumb = this.specialistPage !== undefined
      // C2-R3: the embedded specialist page is a SUB-VIEW of the row that
      // opened it, never a category and never a second screen owner.
      ? `${CATEGORY_LABELS[this.categoryId]} · ${row?.label ?? '—'} · Allowed models`
      : this.focus === 'categories'
        ? 'Categories'
        : this.focus === 'content'
          ? (this.categoryId === 'plugins' && this.pluginPage !== undefined
              ? this.pluginBreadcrumb(this.pluginPage.currentView())
              : CATEGORY_LABELS[this.categoryId])
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
    const row = this.authPage !== undefined || this.pluginPage !== undefined ? undefined : this.selectedRow()
    const scope = this.categoryId === 'about'
      ? 'About'
      : this.categoryId === 'plugins'
        ? 'Host plugins & TUI extensions'
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
    // The shared pane-header line is the planner's own grant INSIDE the body:
    // it exists only while one real content row remains, including during
    // choice editing. With a single body row it would replace the
    // candidate/content line, so the planner withholds it.
    const showPaneHeader = plan.paneHeaderRows === 1
    const contentTop = bodyTop + plan.paneHeaderRows
    const contentRows = chromeGeometry(plan).contentRows
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
        // A category whose rows are ALL unavailable states that instead of
        // painting an unexplained blank list (the category itself is fixed).
        paneLines.set('rows', rows.length === 0
          ? [this.emptyRowsLine(pane.width)]
          : visible.map(row => this.rowLine(row, pane.width)))
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

    const categoryCount = this.currentCategoryOrder().length
    for (const pane of layout) {
      let maxOffset = Math.max(0, categoryCount - contentRows)
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
          ? `Categories (${categoryCount})`
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
      panes.categories = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, this.currentCategoryOrder().length - viewport) }
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
      // A category whose rows are ALL unavailable states that instead of
      // painting an unexplained blank list (the category itself is fixed).
      if (rows.length === 0) out.push(fit(this.emptyRowsLine(width), width))
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

  /**
   * The statement of an all-unavailable category, in the LONGEST wording that
   * fits WHOLE. It is never truncated (a half-cut sentence reads as a different
   * claim), and a pane too narrow for even the shortest wording still says
   * nothing rather than something false.
   */
  private emptyRowsLine(width: number): string {
    const wordings = [
      'No setting is available in this category right now.',
      'No setting is available.',
      'None available.',
    ]
    const fitting = wordings.find(text => visibleWidth(text) <= width)
    return fitting === undefined ? '' : color.textDim(fitting)
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
    // A row without a write channel says so instead of looking editable: this
    // category's own transition launcher opens the existing complete settings
    // editor. The note is NOT a button and grants nothing: it keeps its own
    // pinned row when the row has no action left to carry it (the Legacy Copy
    // verb is retired). The decoration is dropped WHOLE when it does not fit —
    // a half-cut note would read as a different statement.
    const note = buttons.some(button => button.verb === 'legacy')
      ? 'opens the existing complete settings editor'
      // A specialist row whose page is refused right now (a non-current
      // authority) must state WHAT is refused instead of pointing at the legacy
      // editor, which no longer owns this field at all.
      : row?.specialist !== undefined && row.specialistAvailable === false
        ? 'not editable while the backend is not current'
        : row !== undefined && row.edit === undefined && row.action === 'inspect'
          // A migrated field has no legacy editor owner: the note must not send
          // the user to an editor that cannot change it.
          ? 'read-only here · no candidate is available right now'
          : ''
    const noteAloneFits = buttons.length === 0 && note !== '' && visibleWidth(note) <= width
    const pinned = (buttons.length > 0 || noteAloneFits) && viewport >= 2 ? 1 : 0
    const scrollViewport = Math.max(0, viewport - pinned)
    const directPage = this.categoryId === 'models'
      ? 'Models'
      : this.categoryId === 'account'
        ? 'Account'
        : 'this page'
    const content = row === undefined
      // Two DIFFERENT absences: a direct category has no Rows level at all, while
      // a configuration category whose rows are all unavailable has no
      // SELECTABLE row (never "press Enter to open a page" — it has none).
      ? [isDirectCategory(this.categoryId)
          ? color.textDim(`This category is a direct page entry. Press Enter or Right to open ${directPage}.`)
          : color.textDim('No setting is available in this category right now.')]
      : this.detailContent(row, width, includeTitle)
    const offset = Math.min(Math.max(0, this.detailOffset), Math.max(0, content.length - scrollViewport))
    this.detailOffset = offset
    const lines: string[] = []
    for (let i = 0; i < scrollViewport; i += 1) lines.push(content[offset + i] ?? '')
    const painted = pinned === 1 ? this.layoutButtons(width, buttons) : { text: '', painted: [] }
    if (pinned === 1) {
      // The note rides beside the painted buttons when it fits WHOLE, and keeps
      // the row alone when the row has no action left. A half-cut note would
      // read as a different statement, so the whole decoration is dropped then.
      const noteInk = note === '' ? '' : color.textMuted(note)
      const decorated = painted.text === '' ? noteInk : noteInk === '' ? painted.text : `${painted.text}  ${noteInk}`
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

  /**
   * The actions the pinned row may paint for this row in the CURRENT phase.
   *  A pending commit disables the edit verbs (ONE commit at a time) and a
   *  non-writable row offers only its legacy handoff.
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
    // C2-R3: the ONE explicit specialist entry (the subagent allowlist). It is
    // an alias for the row's own Enter/Right, and it exists only while the row
    // really carries the specialist page AND has not been refused availability.
    if (row.specialist === 'subagent-allowlist'
      && row.specialistAvailable !== false
      && this.intents.createSubagentAllowlistPicker !== undefined) {
      buttons.push({ verb: 'manage', text: 'Manage allowed models…', id: row.id })
    }
    if (row.action === 'open-legacy') buttons.push({ verb: 'legacy', text: 'Open existing settings…', id: row.id })
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
        if (edit.runtimeEffect !== undefined) field('Runtime', edit.runtimeEffect, color.textDim, true)
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
        if (edit.runtimeEffect !== undefined) field('Runtime', edit.runtimeEffect)
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
        ...(this.currentRows().length > 0 ? this.regionActionBarHints('panes', true) : []),
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
        { text: 'Left back', priority: 7 },
        ...(this.currentRows().length > 0 ? this.regionActionBarHints('panes', true) : []),
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
    return color.textMuted(rendered)
  }

  // ── state helpers ────────────────────────────────────────────────────────

  private currentRows(): readonly SettingsWorkspaceRow[] {
    return this.snapshot.rows.filter(row => row.category === this.categoryId)
  }

  /** The count the Rows pane header states: the real snapshot rows of the
   *  selected legacy configuration category. */
  private rowsPaneCount(): number {
    return this.currentRows().length
  }

  /** The first row of ONE legacy configuration category. A direct page
   *  (About/Models/Account/Plugins) has NO row: the panel never borrows another
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
    this.adoptSnapshot(this.source.readSnapshot())
    // A live candidate source can change UNDER an open choice (a contribution
    // unloading re-numbers the rows). The chosen candidate is an IDENTITY, so the
    // phase is re-anchored on its VALUE: the highlight and the confirm keep naming the
    // same candidate, and a candidate whose source is gone drops the choice instead of
    // painting a confirm that can no longer dispatch it.
    this.reanchorChoice()
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Re-read the same authorities; keep the stable selection when it survives. */
  private refresh(requestRender = true): void {
    const next = this.source.readSnapshot()
    this.adoptSnapshot(next)
    if (!next.rows.some(row => row.id === this.rowId && row.category === this.categoryId)) {
      this.rowId = this.firstRowOf(this.categoryId)
    }
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
   *  width only chooses the projection). The grant includes the pane header
   *  when present; the planner withholds that header unless a real content row
   *  remains, so a floor below 1 is also exactly "no real content row". */
  private bodyFloor(): number {
    const width = this.projectionWidth()
    return planSettingsChrome(
      width,
      this.intents.rows(),
      this.intents.notice() !== undefined,
      this.choiceField() !== undefined,
    ).bodyRows
  }

  /** The projection width: the last painted frame's, else the LIVE terminal
   *  width — a key may arrive before the first paint, and the layout it belongs
   *  to must never be guessed from a missing frame. */
  private projectionWidth(): number {
    return this.chrome?.width ?? this.intents.columns()
  }

  /** The layout the last painted frame used (recorded beside `chrome`). */
  private paintedLayout: SettingsLayout | undefined
  /** The focus the last painted frame was produced under. A narrow frame paints
   *  ONE region, so a focus transfer changes what it shows even when the row plan
   *  is identical. */
  private paintedFocus: SettingsWorkspaceFocus | undefined

  /** Whether the ROOT's own destination frame has not painted yet. This covers
   *  the case the page-owned query cannot: at narrow widths a yield leaves no
   *  page grant to arm, yet the Categories frame has not been painted either. */
  private rootProjectionAwaitingPaint(): boolean {
    // Scope: ONLY the embedded plugin page. It is the one direct page whose keys
    // the ROOT also intercepts (Shift+Tab) and whose yield swaps the narrow
    // projection; About/Models/Account own their gates and re-render synchronously,
    // and fencing them broke legitimate drill-down paths.
    if (this.categoryId !== 'plugins') return false
    if (this.paintedLayout === undefined) return false
    // BOTH directions of the narrow focus swap leave the painted frame behind:
    // content -> rail (the Categories frame has not painted) and rail -> content
    // (the page's grant may be unchanged, but the painted frame still shows the
    // rail). Until the destination frame paints, the root refuses the keys it
    // would otherwise dispatch into the new focus.
    return this.paintedFocus !== this.focus
  }


  /** Whether the live terminal geometry has outrun the last painted frame. The
   *  child grant value can stay identical across two heights (8→7 rows keeps
   *  the same body budget), so the root owns this per-terminal-frame fence. */
  private terminalGeometryStale(): boolean {
    return this.lastRenderWidth >= 0
      && (this.lastRenderWidth !== this.intents.columns() || this.lastRenderRows !== this.intents.rows())
  }

  /**
   * Whether the LIVE root chrome would paint a different row allocation than the
   * last painted frame. The App notice is a chrome input that moves/shrinks the
   * rail, the legacy panes, the direct content box AND the child grant without
   * changing the terminal size, so no pointer gesture may resolve against the
   * previous frame's hit maps until that frame repaints.
   */
  private chromeGeometryStale(): boolean {
    const painted = this.chrome
    if (painted === undefined) return true
    const live = planSettingsChrome(
      this.intents.columns(),
      this.intents.rows(),
      this.intents.notice() !== undefined,
      this.choiceField() !== undefined,
    )
    return !sameChromeRows(painted, live)
  }

  /** The current projection (see {@link projectionWidth}). */
  private currentLayout(): SettingsLayout {
    return layoutForWidth(this.projectionWidth())
  }

  // ── the embedded specialist page (C2-R3) ──────────────────────────────────

  /**
   * Mount the ONE embedded specialist page for a row that carries
   * `specialist` (the existing subagent allowlist picker). The factory runs
   * only on an explicit Manage/Enter; a category change, the picker's own
   * `done` (Esc) or this workspace's teardown retires the instance exactly
   * once. The panel never reads or writes the settings section itself.
   */
  private openSpecialist(row: SettingsWorkspaceRow): void {
    if (row.specialist !== 'subagent-allowlist') return
    // A row whose page is refused right now never starts Host or catalog IO.
    if (row.specialistAvailable === false) return
    if (this.specialistPage !== undefined) return
    // A grant that cannot paint a candidate row never starts the picker: a
    // toggle the user cannot see is not admissible.
    if (this.bodyFloor() < 2) return
    const page = this.intents.createSubagentAllowlistPicker?.(
      () => { this.closeSpecialist() },
      () => { this.refreshSpecialistSummary() },
    )
    if (page === undefined) return
    // The factory may run a synchronous callback that already changed the
    // workspace (a stale request): a page built for a superseded state must not
    // be mounted.
    if (this.disposed || this.categoryId !== row.category || this.rowId !== row.id) {
      page.dispose()
      return
    }
    this.specialistPage = page
    this.specialistRow = row.id
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Retire the embedded specialist page. A write it already dispatched keeps
   *  settling in its own owner; nothing here can revive the page. */
  private closeSpecialist(): void {
    const page = this.specialistPage
    if (page === undefined) return
    this.specialistPage = undefined
    this.specialistRow = undefined
    page.focused = false
    page.dispose()
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.specialistPressed = undefined
    // The row summary is re-read from the OFFICIAL section on the way back: the
    // frame the user returns to never shows the pre-write summary.
    this.snapshot = this.source.readSnapshot()
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * The picker settled ONE of its writes: re-read the snapshot the rows project
   * from, so the Agent row summary follows the official section.
   *
   * A write that settles AFTER the user closed the picker still refreshes the
   * facts of the workspace the user is now looking at — the page instance is
   * spent, but the workspace is not. This refreshes the ROW FACTS only: it
   * never re-mounts a picker, never moves the row/focus selection and never
   * touches a closed screen.
   */
  private refreshSpecialistSummary(): void {
    if (this.disposed) return
    this.snapshot = this.source.readSnapshot()
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * Paint the embedded specialist page inside the SHARED Settings chrome: the
   * root keeps the ONE Header/Metadata/rule/notice and the ONE physical
   * last-row Action Bar; the picker contributes its business body and its own
   * semantic hint line, which becomes that last row exactly like a direct
   * page's bar. Its hit map is exclusively the picker's own last-painted
   * geometry — the rows/detail panes behind it publish nothing.
   */
  private renderSpecialistPage(plan: SettingsChromePlan): string[] {
    const lines: string[] = []
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows === 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    const geometry = chromeGeometry(plan)
    if (plan.paneHeaderRows === 1) lines.push(fit(this.paneHeader('Subagent allowed models', true), plan.width))
    const page = this.specialistPage
    const contentRows = geometry.contentRows
    // The picker is granted the body rows PLUS the one physical action row: its
    // own row-budgeted render already carries its semantic hint as the LAST
    // line, which becomes this frame's bar exactly like a direct page's.
    const childRows = Math.max(1, contentRows + plan.actionRows)
    let child: readonly string[] = []
    if (page !== undefined) {
      page.focused = true
      page.setMaxRows(childRows)
      child = page.render(plan.width).slice(0, childRows)
    }
    // The picker's LOCAL last line is its semantic hint: it becomes this
    // frame's ONE physical last-row Action Bar, exactly like a direct page's.
    const body = child.slice(0, Math.max(0, child.length - 1))
    for (let index = 0; index < contentRows; index += 1) lines.push(fit(body[index] ?? '', plan.width))
    lines.push(fit(child[child.length - 1] ?? '', plan.width))
    // The page's OWN painted cells are the only pointer grant of this frame: the
    // rows/detail panes behind it publish nothing, so a click can never leak
    // through to a hidden column.
    // The picker is granted the full frame width and its own rows start at the
    // first body line, so a page-local cell is `event - {0, contentTop}`.
    this.paintedSpecialistBox = page === undefined
      ? undefined
      : { x: 0, top: geometry.contentTop, width: plan.width, rows: contentRows }
    this.paintedTargets = []
    this.paintedPanes = {}
    this.paintedContentBox = undefined
    this.paintedRevision = this.revision
    return lines.slice(0, plan.rows)
  }

  // ── the embedded Plugin Manager page (PR2) ────────────────────────────────

  /**
   * §3.1: the FIXED projection of the plugin page inside this workspace. Pure
   * layout: it reads the real width, the root focus and the page's current
   * view only — never Controller/business state.
   */
  private pluginProjection(
    plan: SettingsChromePlan,
    view: PluginWorkspaceView,
    focus: SettingsWorkspaceFocus,
  ): {
    readonly showCategories: boolean
    readonly contentX: number
    readonly contentWidth: number
    readonly allowDual: boolean
  } {
    const width = plan.width
    // A business page (install/confirm/diagnostics) owns the FULL width: its
    // risk text and actions are never squeezed beside the Categories rail.
    if (view === 'install' || view === 'confirm' || view === 'diagnostics') {
      return { showCategories: false, contentX: 0, contentWidth: Math.max(1, width), allowDual: false }
    }
    if (width >= 120) {
      // `Categories(22) · List · Details preview`: the rail always stays.
      const contentX = WIDE_CATEGORY_WIDTH + COLUMN_GAP
      return { showCategories: true, contentX, contentWidth: Math.max(1, width - contentX), allowDual: true }
    }
    if (width >= SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS) {
      // 76..119: the adjacent pair moves with the owning focus.
      if (focus === 'categories') {
        const contentX = MEDIUM_CATEGORY_WIDTH + COLUMN_GAP
        return { showCategories: true, contentX, contentWidth: Math.max(1, width - contentX), allowDual: false }
      }
      return { showCategories: false, contentX: 0, contentWidth: Math.max(1, width), allowDual: true }
    }
    // Narrow: ONE column. The root paints the Categories list alone until the
    // content takes the keyboard, so the page is never mounted there.
    return { showCategories: false, contentX: 0, contentWidth: Math.max(1, width), allowDual: false }
  }

  /** The local viewport the plugin page is granted for THIS frame. */
  private pluginViewport(plan: SettingsChromePlan, view: PluginWorkspaceView): import('../plugin-manager/workspace.ts').PluginContentViewport {
    const projection = this.pluginProjection(plan, view, this.focus)
    const rows = Math.max(1, chromeGeometry(plan).contentRows + plan.actionRows)
    return { width: projection.contentWidth, rows, allowDual: projection.allowDual }
  }

  /**
   * Create the ONE plugin page when its content column is about to be painted
   * (the lazy policy Models/Account share). A narrow rail that merely SELECTED
   * the category mounts nothing and reads no inventory.
   */
  private ensurePluginPageMounted(): void {
    if (this.pluginPage !== undefined || this.disposed) return
    const page = this.intents.onOpenPlugins?.(() => this.yieldPluginNavigation())
    if (page === undefined) return
    this.pluginPage = page
    this.bumpRevision()
  }

  /**
   * Drop the page and release its Host claim exactly once. Only a REAL category
   * change or a Settings teardown reaches here; a focus yield never does.
   */
  private closePluginPage(): void {
    const page = this.pluginPage
    if (page === undefined) return
    this.pluginPage = undefined
    page.focused = false
    page.cancelPointer()
    this.paintedContentBox = undefined
    this.contentPressed = undefined
    this.pressedGesture = undefined
    page.dispose()
  }

  private pluginPageHasPendingMutation(): boolean {
    return this.pluginPage?.pendingMutation() === true
  }

  /**
   * Whether a category change / close may abandon the plugin page right now.
   * The Controller's mutation guard is authoritative; Details/Confirm/Install
   * own their own Esc gradient and are never discarded from a rail click.
   */
  private pluginBlocksLeave(): boolean {
    const page = this.pluginPage
    if (page === undefined) return false
    if (page.pendingMutation()) return true
    return page.currentView() !== 'list'
  }

  /**
   * Hand the keyboard back to the Categories rail WITHOUT closing the page:
   * the page keeps its instance, query/selection/scroll and the Controller
   * keeps its install request id. Only the untouched List root may yield.
   */
  private yieldPluginNavigation(): void {
    const page = this.pluginPage
    if (page === undefined) return
    if (!page.canYieldFocusToNavigation()) return
    page.focused = false
    page.cancelPointer()
    this.focus = 'categories'
    // §4.2: the yield changes the direct page's projection at 76..119 columns.
    // Install the new grant NOW so the page's own pending-grant query reports the
    // unpainted window instead of waiting for the next forwarded key.
    this.syncPluginFrame()
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * Recompute the plugin page's grant from the LIVE chrome (width, height, App
   * notice) and return the content box the CURRENT chrome paints. Mouse input
   * calls this BEFORE translating a cell: a grant installed by the keyboard path
   * (or a chrome change) may have moved the box while the painted frame is still
   * the old one, and a press recorded against it could release on a different
   * action.
   */
  private syncPluginFrame(): ContentBox | undefined {
    const page = this.pluginPage
    if (page === undefined) return undefined
    const columns = this.intents.columns()
    // A narrow rail that does not paint the content column has no content box
    // (and no grant to refresh): its page is not on screen at all.
    if (!this.paintsDirectPage(columns)) return undefined
    const view = page.currentView()
    const plan = planSettingsChrome(columns, this.intents.rows(), this.intents.notice() !== undefined)
    page.setViewport(this.pluginViewport(plan, view))
    page.focused = this.focus === 'content'
    const projection = this.pluginProjection(plan, view, this.focus)
    const geometry = chromeGeometry(plan)
    return { x: projection.contentX, top: geometry.contentTop, width: projection.contentWidth, rows: geometry.contentRows }
  }

  /**
   * Paint the plugin category inside the SHARED Settings chrome: the root draws
   * the one Header/Metadata/Rule/Notice, the ONE shared pane header and the ONE
   * physical last-row bar; the page contributes only its business body.
   */
  private renderPluginDirectPage(plan: SettingsChromePlan): string[] {
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows === 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    const geometry = chromeGeometry(plan)
    const page = this.pluginPage
    if (page === undefined) {
      // No composition seam supplied the page: paint an honest empty content
      // column instead of a fabricated plugin list.
      for (let index = 0; index < geometry.contentRows; index += 1) {
        lines.push(fit(index === 0 ? color.textDim('The Plugin Manager is unavailable in this composition.') : '', plan.width))
      }
      lines.push(fit(this.focus === 'categories' ? this.renderNavigationActionBar(plan.width) : color.textMuted('Esc back'), plan.width))
      this.paintedTargets = []
      this.paintedPanes = {}
      this.paintedContentBox = undefined
      this.paintedRevision = this.revision
      return lines.slice(0, plan.rows)
    }
    const view = page.currentView()
    const projection = this.pluginProjection(plan, view, this.focus)
    const childRows = Math.max(1, geometry.contentRows + plan.actionRows)
    page.setViewport({ width: projection.contentWidth, rows: childRows, allowDual: projection.allowDual })
    page.focused = this.focus === 'content'
    const child = page.render(projection.contentWidth)
    const layout = page.contentLayout()
    const contentTop = geometry.contentTop
    const contentRows = geometry.contentRows
    if (plan.paneHeaderRows === 1) lines.push(this.renderPluginPaneHeader(plan, projection, layout, view))
    const visible = projection.showCategories ? this.visibleCategories(contentRows) : []
    for (let index = 0; index < contentRows; index += 1) {
      const content = fit(child[index] ?? '', projection.contentWidth)
      if (!projection.showCategories) {
        lines.push(content)
        continue
      }
      const id = visible[index]
      const rail = fit(id === undefined ? '' : this.categoryLine(id), WIDE_CATEGORY_WIDTH)
      lines.push(`${rail}${' '.repeat(COLUMN_GAP)}${content}`)
      if (id !== undefined) {
        targets.push({ kind: 'category', id, row: contentTop + index, startCol: 0, endCol: WIDE_CATEGORY_WIDTH })
      }
    }
    // The page's semantic bar is its LOCAL last row; while the rail owns the
    // keyboard the root's navigation bar takes the physical last row instead.
    const bar = this.focus === 'categories' ? this.renderNavigationActionBar(plan.width) : (child[childRows - 1] ?? '')
    lines.push(fit(bar, plan.width))
    this.paintedContentBox = { x: projection.contentX, top: contentTop, width: projection.contentWidth, rows: contentRows }
    const categories = this.currentCategoryOrder()
    this.paintedPanes = projection.showCategories
      ? {
          categories: {
            x: 0,
            width: WIDE_CATEGORY_WIDTH,
            contentTop,
            contentRows: Math.min(categories.length, contentRows),
            maxOffset: Math.max(0, categories.length - contentRows),
          },
        }
      : {}
    this.paintedTargets = targets
    this.paintedRevision = this.revision
    return lines.slice(0, plan.rows)
  }

  /**
   * The ONE shared pane header of a plugin frame: the Categories label plus,
   * with the EXACT split the page just painted, the `Plugins` / `Details`
   * identity labels. Display-only (no hit target, no focus of its own) and the
   * same height as every other direct page.
   */
  /** The plugin page's own trail inside the shared Header breadcrumb. */
  private pluginBreadcrumb(view: PluginWorkspaceView): string {
    switch (view) {
      case 'details': return 'Plugins · Details'
      case 'install': return 'Plugins · Install'
      case 'confirm': return 'Plugins · Confirm'
      case 'diagnostics': return 'Plugins · Diagnostics'
      default: return 'Plugins'
    }
  }

  private renderPluginPaneHeader(
    plan: SettingsChromePlan,
    projection: { readonly showCategories: boolean; readonly contentWidth: number },
    layout: { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number },
    view: PluginWorkspaceView,
  ): string {
    const parts: string[] = []
    if (projection.showCategories) {
      parts.push(fit(this.paneHeader(`Categories (${this.currentCategoryOrder().length})`, this.focus === 'categories'), WIDE_CATEGORY_WIDTH))
      parts.push(' '.repeat(COLUMN_GAP))
    }
    if (layout.dual) {
      const contentOwnsKeys = this.focus === 'content'
      parts.push(fit(this.paneHeader('Plugins', contentOwnsKeys && view === 'list'), layout.leftWidth))
      parts.push(' '.repeat(COLUMN_GAP))
      parts.push(fit(this.paneHeader('Details', contentOwnsKeys && view === 'details'), layout.rightWidth))
    } else {
      parts.push(fit(this.paneHeader(this.pluginPaneLabel(view), this.focus === 'content'), projection.contentWidth))
    }
    return parts.join('')
  }

  /** The one label of a non-dual plugin content column. */
  private pluginPaneLabel(view: PluginWorkspaceView): string {
    switch (view) {
      case 'details': return 'Details'
      case 'install': return 'Plugins · Install'
      case 'confirm': return 'Plugins · Confirm'
      case 'diagnostics': return 'Plugins · Diagnostics'
      default: return 'Plugins'
    }
  }

  /**
   * The plugin content focus. The embedded page owns its local keys; the root
   * only intercepts the ONE cross-region key (Shift+Tab from the untouched List
   * root) and never answers for a page that is not mounted.
   */
  private handlePluginContentInput(data: string): void {
    const page = this.pluginPage
    if (page === undefined) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'backspace') || matchesKey(data, 'left')) this.returnToNavigation()
      return
    }
    if (layoutForWidth(this.intents.columns()) !== 'narrow'
      && matchesKey(data, 'shift+tab')
      && page.canYieldFocusToNavigation()) {
      // §4.2: the root intercepts this key itself, so it must apply the SAME rule
      // the page applies to the keys it forwards — while a changed grant awaits
      // its paint, only the real Esc may act.
      if (page.grantAwaitingPaint()) return
      this.yieldPluginNavigation()
      return
    }
    this.syncPluginFrame()
    page.handleInput(data)
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    // The conditional directory is a fail-closed boundary of its own: a changed
    // registry membership revokes the painted grants BEFORE any dispatch, and
    // the event that DISCOVERED the change never navigates with it. Until a
    // frame composed against the CURRENT registry paints, only the real Esc
    // acts (a navigation back, never an activation of a spent row).
    this.syncExtensionDirectory()
    // The only action admitted in this window is the real Esc: it runs the
    // CURRENT state's legitimate return (the page's own back, one level back or
    // the close) through the SAME dispatch a painted frame uses, and can never
    // activate a row or category of the spent frame.
    if (this.directoryAwaitingPaint && !matchesKey(data, 'escape')) return
    // A terminal resize is a fail-closed boundary for EVERY Settings pane even
    // when the effective child grant value is unchanged (8→7 rows keeps the
    // same body budget): the previous frame's physical last row can already be
    // outside the new viewport while its action/copy/navigation authorization is
    // still live. Only the back keys may pass until the resize frame paints.
    if (this.terminalGeometryStale() && !matchesKey(data, 'escape')) return
    // C2-R3: the embedded specialist page owns the keyboard while it is
    // mounted. Its own Esc closes IT (never the workspace, never a category)
    // through the factory's `done`; the root intercepts nothing else.
    if (this.specialistPage !== undefined) {
      this.specialistPage.handleInput(data)
      return
    }
    // The CONTENT focus belongs to the direct page: the root never forwards a
    // navigation key to it, and the page never receives a key the root owns.
    if (this.focus === 'content') {
      // §4.2: a narrow focus transfer into the content may leave the painted frame
      // showing the rail. Until the content frame paints, only the real Esc may act.
      if (this.rootProjectionAwaitingPaint() && !matchesKey(data, 'escape')) return
      this.handleContentInput(data)
      return
    }
    if (matchesKey(data, 'escape')) return this.goBack()
    // §4.2 admits only the REAL Esc while the destination frame is stale (Backspace
    // is not a portable back key), so it must not act in that window.
    if (matchesKey(data, 'backspace')) {
      if (this.rootProjectionAwaitingPaint() || this.pluginPage?.grantAwaitingPaint() === true) return
      return this.goBack()
    }
    // Below the body floor every navigation/action target is invisible; only the
    // lifecycle/back key remains available. Read the live geometry because input
    // may arrive before a resize-triggered frame has painted.
    if (this.bodyFloor() < 1) return
    // §4.2 covers the ROOT's own destination frame too: at narrow widths a yield
    // leaves no page grant to arm, yet the Categories frame has not painted.
    if (this.rootProjectionAwaitingPaint()) return
    // §4.2: while the plugin page still awaits the paint for a grant the ROOT
    // installed (a yield out of the content changes the projection at 76..119),
    // a rail key must not move or activate a category the new frame does not show
    // yet. Only the back keys above are admitted. The page is the ONE owner of
    // that state, so the root asks it instead of duplicating the rule.
    if (this.categoryId === 'plugins' && this.pluginPage?.grantAwaitingPaint() === true) return
    // Tab / Shift+Tab re-focus the ONE navigation owner (plan §2.2). The key is
    // matched semantically, so legacy `\t` and every protocol's Tab byte agree.
    const tabForward = matchesKey(data, 'tab')
    const tabBackward = matchesKey(data, 'shift+tab')
    if (tabForward || tabBackward) {
      this.jumpRegion(tabForward)
      return
    }
    const shiftCopyPressed = matchesKey(data, Key.shift(SETTINGS_LOCAL_KEYS.copy))
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
      // `r` on the rail refreshes the ROW SOURCES of the selected category:
      // while the About page is the selected content, `r` refreshes ABOUT
      // (its own semantic refresh — never the legacy Web settings read).
      if (this.categoryId === 'about' && this.intents.aboutStatusSource !== undefined) {
        this.aboutRefresh()
        return
      }
      this.refresh()
      this.source.onRefresh?.()
      return
    }
    if (shiftCopyPressed) {
      // Shift+C with About selected on the rail = the About Copy All (plan
      // §2.1); lowercase `c` stays inert (no Legacy row copy exists).
      if (this.categoryId === 'about'
        && this.intents.aboutStatusSource !== undefined) {
        this.copyAboutAll()
      }
      return
    }
    // Everything else is inert inside the workspace: no key leaks to the hidden
    // editor, transcript or a host composer action.
  }

  /**
   * Tab / Shift+Tab re-focus ONE region without activating anything (frozen
   * plan §2.2): a direct category only hands the keyboard to its already
   * mounted content page, and a legacy category re-focuses one of its three
   * panes. The workspace's ONE `focus` state remains the only owner; no page,
   * row, action, writer or Host read is started here.
   */
  private jumpRegion(forward: boolean): void {
    // A narrow terminal paints one region at a time: cross-region Tab would
    // move the keyboard to an invisible pane, so the existing Enter/Right (in)
    // and Esc/Left (back) navigation stays the only way in and out.
    if (layoutForWidth(this.intents.columns()) === 'narrow') return
    // A transient choice or an in-flight write owns the keys it can complete:
    // Tab must never become a way around either guard.
    if (this.choiceField() !== undefined || this.editPhase.kind === 'pending') return
    if (isDirectCategory(this.categoryId)) {
      // A direct page has no second region to cycle to: forward Tab enters the
      // content (the page is reused, never rebuilt) and the reverse key stays
      // inert. The page then owns Tab locally.
      if (forward) this.enterContent()
      return
    }
    if (this.currentRows().length === 0) return
    const next: SettingsWorkspaceFocus = this.focus === 'categories'
      ? (forward ? 'rows' : 'detail')
      : this.focus === 'rows'
        ? (forward ? 'detail' : 'categories')
        : (forward ? 'categories' : 'rows')
    // The existing focus transaction bumps the press revision (a pointer press
    // recorded under the previous focus can never activate a target under the
    // new one). It never calls `enterDetail()`/`confirm()`: focusing the Detail
    // pane must not open a choice.
    this.leaveDetailTo(next)
  }

  /**
   * The CONTENT focus: the direct page owns the keyboard. The About page is
   * read-only (it scrolls and it goes back); a real page owns every other key
   * and reports its own exit.
   */
  private handleContentInput(data: string): void {
    const page = this.authPage
    // Below the body floor NO body action is visible: the frame paints only the
    // truthful Esc bar. Only Esc may reach a page, because a page can bind
    // other back-looking keys to a HIDDEN edit (the Models catalog filter binds
    // Backspace to its query) or to a hidden body action (the embedded Plugin
    // page's `/`, `i`, `r`, filter and diagnostics keys). Dropping them here
    // prevents an invisible body from changing page state, reading the Host or
    // running an action, while Esc keeps its real modal cancel/back meaning.
    // The child repeats this floor against its OWN grant (a page notice row can
    // lower it below the root's): the root gate is the first one, not the only.
    if (this.bodyFloor() < 1 && !matchesKey(data, 'escape')) return
    // The plugin page owns its own body-floor policy: every frame it paints
    // advertises only the actions it really admits, so the root forwards its
    // keys unchanged (it never makes a painted hint a no-op).
    if (this.categoryId === 'plugins') {
      this.handlePluginContentInput(data)
      return
    }
    // Tab / Shift+Tab leave a READ-ONLY direct region on a wide/medium frame:
    // About has no page key of its own, and a real page may only yield when its
    // own confirmation/pending state allows it. A narrow terminal has no second
    // region, so the existing Esc/Left path stays in charge there. Models is
    // NOT intercepted: the page owns both region keys and switches its body and
    // action sections itself.
    if (layoutForWidth(this.intents.columns()) !== 'narrow'
      && this.bodyFloor() >= 1
      && (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab'))) {
      if (this.categoryId === 'about') return this.returnToNavigation()
      if (this.categoryId === 'account') {
        if (page?.canYieldFocusToNavigation?.() === true) this.returnToNavigation()
        return
      }
    }
    if (page === undefined) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'backspace') || matchesKey(data, 'left')) {
        this.returnToNavigation()
        return
      }
      if (matchesKey(data, 'up')) return this.aboutSelected() ? this.moveAboutSelection(-1) : this.scrollAbout(-1)
      if (matchesKey(data, 'down')) return this.aboutSelected() ? this.moveAboutSelection(1) : this.scrollAbout(1)
      if (matchesKey(data, 'pageUp')) {
        return this.aboutSelected() ? this.pageAboutSelection(-this.aboutPageStep()) : this.scrollAbout(-this.aboutPageStep())
      }
      if (matchesKey(data, 'pageDown')) {
        return this.aboutSelected() ? this.pageAboutSelection(this.aboutPageStep()) : this.scrollAbout(this.aboutPageStep())
      }
      if (matchesKey(data, 'home')) return this.aboutSelected() ? this.selectAboutFactByIndex(0) : this.setAboutOffset(0)
      if (matchesKey(data, 'end')) return this.aboutSelected() ? this.selectAboutFactByIndex(Number.MAX_SAFE_INTEGER) : this.setAboutOffset(Number.MAX_SAFE_INTEGER)
      if (matchesKey(data, SETTINGS_LOCAL_KEYS.copy)) {
        // Lowercase `c` acts ONLY when a fact is selected (content focus):
        // with the keyboard on the rail it is inert (the plan's rail rule).
        if (this.aboutSelected()) this.copyAboutFact()
        return
      }
      if (matchesKey(data, Key.shift(SETTINGS_LOCAL_KEYS.copy))) {
        this.copyAboutAll()
        return
      }
      if (matchesKey(data, SETTINGS_LOCAL_KEYS.refresh)) {
        this.aboutRefresh()
        return
      }
      // Enter is the ACTION key of the SELECTED `Refresh context` action only
      // — an ordinary fact is inert (the plan's frozen keymap). Selection is
      // explicit (↓ past the last fact while the action is in view); mere
      // viewport presence never authorizes a refresh.
      if (matchesKey(data, 'enter')) {
        if (this.aboutActionSelected && this.aboutRefreshActionInView()) this.aboutRefresh()
        return
      }
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
   * or a real close disposes it. A page that owns an in-flight Host operation
   * keeps the keyboard: the rail may not become a way around the page's own
   * refusal (its Back action reports the same exit the keyboard does).
   */
  private returnToNavigation(): void {
    if (this.focus === 'categories') return
    if (this.authPageHasPendingMutation()) return
    if (this.pluginPageHasPendingMutation()) return
    // The plugin page KEEPS its instance and state: only its input focus and
    // any in-flight pointer gesture are released here.
    if (this.pluginPage !== undefined) {
      this.pluginPage.focused = false
      this.pluginPage.cancelPointer()
    }
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
    // A category id that is not a member of the CURRENT directory can never be
    // selected — a painted id of a spent frame or a stale deep link included.
    if (!this.isSelectableCategory(category)) return
    const changed = category !== this.categoryId
    // A Host mutation owns the page: user navigation may not abandon it. The
    // gate covers the MOUSE switch too: the keyboard may never leave a page
    // whose Host operation is still in flight, so the rail can never become a
    // way around the page's own refusal (and around the workspace close).
    if (this.authPageHasPendingMutation() && (changed || focus !== 'content')) return
    // A category change abandons the plugin page; it is refused while the page
    // owns a mutation or a Details/Confirm/Install sub-state (the page's own Esc
    // gradient must run first). Re-selecting the ALREADY selected Plugins entry
    // is a focus transfer to the rail: it is admitted only when the page really
    // yields (never during an edit, a hidden sub-view or a mutation), or the
    // next Esc would skip the page's own gradient and close Settings.
    if (this.pluginPage !== undefined) {
      if (changed) {
        if (this.pluginBlocksLeave()) return
      } else if (focus !== 'content' && !this.pluginPage.canYieldFocusToNavigation()) {
        return
      }
    }
    if (changed) {
      if (this.specialistPage !== undefined) this.closeSpecialist()
      if (this.authPageCategory !== undefined && this.authPageCategory !== category) this.closeAuthPage()
      if (this.categoryId === 'plugins' && category !== 'plugins') this.closePluginPage()
      // C3: an About→other-category change is one semantic About leave.
      if (this.categoryId === 'about' && category !== 'about') this.intents.onAboutLeave?.()
      this.categoryId = category
      this.rowId = isDirectCategory(category) ? undefined : this.firstRowOf(category)
      this.rowOffset = 0
      this.detailOffset = 0
      this.resetChoice()
    }
    // C3: selecting About on the rail (keyboard OR mouse) is a semantic About
    // entry ONLY when the About content is actually painted NOW: on a wide/
    // medium layout the right column starts painting About facts and its copy
    // affordances at once, so the scoped snapshot refresh is admitted on the
    // category change. On a NARROW terminal the category list is the only
    // projection (paintsDirectContent() is false) — nothing About is visible,
    // so the entry waits for the content to take the focus (enterContent /
    // the content-focus click), whose own hook admits exactly one read.
    if (category === 'about' && changed && this.paintsDirectContent()) this.intents.onAboutEnter?.()
    this.focus = focus
    // The direct page is mounted only when its content column is PAINTED: a
    // narrow terminal that still shows the category list has no right column,
    // and browsing an invisible category must not start a Host watch.
    if (this.paintsDirectContent()) {
      if (category === 'models') this.mountModelsPage({ view: 'list' })
      else if (category === 'account') this.mountAccountPage({ view: 'page' })
      else if (category === 'plugins') this.ensurePluginPageMounted()
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
    else if (category === 'plugins') this.ensurePluginPageMounted()
    // C3: re-entering About from another category (Enter/Right on the rail,
    // or a click) is one semantic About entry — exactly one scoped refresh.
    if (category === 'about') this.intents.onAboutEnter?.()
    this.focus = 'content'
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Esc/Backspace: choosing cancels straight back to L1; otherwise step one
   *  level back in every layout. Only L0 Esc/Backspace closes the workspace.
   *  A Host mutation owns the page: the workspace must not close (and the page
   *  must not be disposed) under an operation that is still in flight. */
  private goBack(): void {
    if (this.focus === 'detail') {
      this.leaveDetailTo('rows')
      return
    }
    if (this.focus === 'rows') {
      this.leaveDetailTo('categories')
      return
    }
    if (this.authPageHasPendingMutation()) return
    if (this.pluginPageHasPendingMutation()) return
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
      const order = this.currentCategoryOrder()
      this.selectCategory(order[direction < 0 ? 0 : order.length - 1]!)
      return
    }
    const rows = this.currentRows()
    if (rows.length === 0) return
    this.selectRow(rows[direction < 0 ? 0 : rows.length - 1]!.id)
  }

  private moveCategory(delta: number): void {
    const order = this.currentCategoryOrder()
    const index = order.indexOf(this.categoryId)
    const next = Math.min(Math.max(0, index + delta), order.length - 1)
    this.selectCategory(order[next]!)
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
    if (changedRow && this.specialistPage !== undefined) this.closeSpecialist()
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
      // C2-R3: the specialist row's ONLY action is its embedded page. It is
      // reachable from the Detail's painted Manage button/Enter too, never only
      // from the Rows level.
      const row = this.selectedRow()
      if (row?.specialist !== undefined) {
        this.openSpecialist(row)
        return
      }
      return this.beginChoice()
    }
    if (this.focus === 'categories') {
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
    // C2-R3: the specialist row has no L2 choice of its own — its ONE action
    // mounts the embedded page in this same lease.
    if (row?.specialist !== undefined) {
      this.focus = 'detail'
      this.bumpRevision()
      this.openSpecialist(row)
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
    this.dispatch(phase.field, phase.candidate, edit.revision)
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
    this.dispatch(phase.field, value, edit.revision)
  }

  /** The ONE dispatch: commit the pending phase, then hand the request to the
   *  app-owned write channel with THIS open's request identity. `revision` is
   *  the revision-checked row's decision fence (absent for the TUI-document
   *  writers, whose own serialization/diff path owns its concurrency rule). */
  private dispatch(field: SettingsWorkspaceWritableField, value: string, revision?: number): void {
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
    onCommit(
      { field, value, ...revision === undefined ? {} : { revision } },
      outcome => this.settlePending(requestId, outcome),
    )
  }

  /** The settlement of the LIVE pending commit. A settlement that does not
   *  match the live request (a superseded retry, a closed workspace) is dropped:
   *  a late result can never repaint a surface the user already left. */
  private settlePending(requestId: number, outcome: SettingsWorkspaceCommitOutcome): void {
    if (this.disposed) return
    const phase = this.editPhase
    if (phase.kind !== 'pending' || phase.requestId !== requestId) return
    this.settle(phase.field, phase.attempted, outcome)
    // C2-R3: the ONE typed follow-up a refusal may carry. It is applied only
    // after the settlement is committed above and only while this request is
    // still the live one, so a late or superseded result can never move the
    // user. Navigation only — never a write.
    const followUp = outcome.followUpRowId
    if (followUp === undefined || outcome.outcome !== 'not-saved') return
    const current = this.editPhase
    if (current.kind !== 'settled' || current.attempted !== phase.attempted) return
    if (!this.snapshot.rows.some(row => row.id === followUp && row.category === this.categoryId)) return
    this.selectRow(followUp, 'rows')
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

  // ── mouse ────────────────────────────────────────────────────────────────

  /**
   * Revoke EVERY pending pointer owner of this workspace: the root's category
   * and content presses plus both direct pages' own presses. A gesture that may
   * no longer resolve against the current frame is dropped whole — a stale
   * wheel must not leave a press alive that its own release could complete
   * against the NEXT frame's identical-looking geometry.
   */
  private cancelPointerOwners(): void {
    this.pressedGesture = undefined
    this.contentPressed = undefined
    this.specialistPressed = undefined
    this.authPage?.cancelPointer?.()
    this.pluginPage?.cancelPointer()
  }

  /** Wheel only: the pane under the pointer scrolls; everything else falls
   *  through to the alt screen's `onCellPress`/`onCellClick` identity path. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    // The extension-settings DIRECTORY is re-proved before a wheel may resolve
    // against any painted box: a registry membership change revokes every grant
    // of the previous frame (independently of whether a cell happens to match).
    this.syncExtensionDirectory()
    if (this.directoryAwaitingPaint) {
      this.cancelPointerOwners()
      return undefined
    }
    // A resize that has not repainted makes every painted pane box stale: a
    // wheel over the old geometry could scroll a pane the new frame does not
    // paint at that cell.
    if (this.terminalGeometryStale()) {
      this.cancelPointerOwners()
      return undefined
    }
    // A focus transfer that changes the Plugins projection leaves the previous
    // frame on screen: a wheel over the old rail must not scroll a pane the next
    // frame does not paint there (§4.2, same boundary as the keyboard gate).
    if (this.rootProjectionAwaitingPaint()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return undefined
    }
    // An App notice (or any chrome change) moves/shrinks EVERY painted hit
    // region — rail, legacy panes, direct content box and child grant — not only
    // the plugin child. Until the frame repaints, no wheel may resolve against
    // the previous geometry. The refused wheel also revokes any pending press:
    // a repaint can restore an identical-looking target whose later release
    // would otherwise complete a gesture from the previous frame.
    if (this.chromeGeometryStale()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return undefined
    }
    if (this.specialistPage !== undefined) {
      const box = this.paintedSpecialistBox
      if (box === undefined || !contentBoxContains(box, event.x, event.y)) return undefined
      return this.specialistPage.handleMouse?.({
        ...event,
        x: event.x - box.x,
        y: event.y - box.top,
        screenX: event.screenX - box.x,
        screenY: event.screenY - box.top,
      })
    }
    if (this.categoryId === 'plugins') {
      const page = this.pluginPage
      const live = page === undefined ? undefined : this.syncPluginFrame()
      const painted = this.paintedContentBox
      // The LIVE chrome must still paint the box the last frame painted: an
      // App notice or a focus transfer can move/shrink the content column
      // WITHOUT a terminal resize, and the wheel must never scroll a pane at a
      // cell the next frame paints differently. When they disagree, fail closed
      // and repaint.
      const current = sameContentBox(live, painted)
      if (live !== undefined && !current) this.intents.requestRender()
      if (page !== undefined && live !== undefined && current && contentBoxContains(live, event.x, event.y)) {
        return page.handleMouse(this.translateMouseEvent(event))
      }
      // A wheel over the content of a stale frame is consumed: nothing may
      // scroll an unmapped row, and the pending repaint restores the mapping.
      if (painted !== undefined && contentBoxContains(painted, event.x, event.y)) return { handled: true }
      if (event.type !== 'wheel') return undefined
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      // Only the Categories rail is a scroll owner outside the plugin content.
      if (this.paneAt(event.x, event.y) !== 'categories') return undefined
      this.scrollCategories(delta)
      return { handled: true }
    }
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

  /**
   * The hosted child page's own state identity: which sub-view it shows and
   * whether it owns a pending pointer/mutation. A key the root forwards can
   * change it without touching the root's projection, so every recorded root
   * gesture carries it and a release must still match.
   */
  private childGestureIdentity(): string {
    const page = this.pluginPage
    if (page === undefined) return 'none'
    // `liveIdentity()` is the child-side authority: it carries the page's
    // monotonic semantic generation (a change that REVERTS inside the gesture),
    // the Controller's monotonic transition count (an asynchronous phase round
    // trip), the install editor's field values, and the semantic state/grant/
    // Controller facts. Because it is a VALUE, a repaint that only catches up with
    // facts already live before the press stays comparable. The view/mutation/
    // yield triple is appended for readable failures; it is already implied.
    return `${page.liveIdentity()}:${page.currentView()}:${page.pendingMutation() ? 'pending' : 'idle'}:${page.canYieldFocusToNavigation() ? 'yield' : 'hold'}`
  }

  /** Whether one panel cell belongs to the painted content column. */
  private contentAt(x: number, y: number): boolean {
    const box = this.paintedContentBox
    return box !== undefined && contentBoxContains(box, x, y)
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    // A directory change invalidates the WHOLE painted hit map, not just the
    // cells that happen to move: the press is refused and the release may never
    // resurrect a target of the previous registry generation.
    this.syncExtensionDirectory()
    if (this.directoryAwaitingPaint) {
      this.cancelPointerOwners()
      return
    }
    // The pointer boxes still describe the previous terminal frame. Refuse the
    // press entirely and revoke every pending pointer owner; the release must
    // not resurrect an old hit at a cell the new layout paints differently.
    if (this.terminalGeometryStale()) {
      this.cancelPointerOwners()
      return
    }
    // The live chrome can move EVERY painted hit region (rail, panes, direct box)
    // between the App notice and its repaint. Refuse the whole gesture instead of
    // resolving it against the previous frame's maps.
    if (this.chromeGeometryStale()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return
    }
    // Same boundary for the focus transfer: the rail cells still on screen belong
    // to the previous frame and must not receive a NEW gesture.
    if (this.rootProjectionAwaitingPaint()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return
    }
    // A new press always supersedes the other owner's press state.
    this.pressedGesture = undefined
    this.contentPressed = undefined
    if (this.specialistPage !== undefined) {
      const box = this.paintedSpecialistBox
      this.specialistPressed = undefined
      if (box === undefined || !contentBoxContains(box, x, y)) return
      this.specialistPressed = {
        x,
        y,
        columns: this.intents.columns(),
        rows: this.intents.rows(),
        revision: this.revision,
        box,
      }
      this.specialistPage.handleMouse?.({
        type: 'press',
        button: 'left',
        x: x - box.x,
        y: y - box.top,
        screenX: x,
        screenY: y,
        width: box.width,
        height: box.rows,
        shift: false,
        alt: false,
        ctrl: false,
      })
      return
    }
    if (this.categoryId === 'plugins') {
      const page = this.pluginPage
      const live = page === undefined ? undefined : this.syncPluginFrame()
      const painted = this.paintedContentBox
      // Admit the press ONLY while the LIVE chrome paints the same box the last
      // frame painted: a notice/focus change that moved the column after the
      // paint must not record a press the page would release on a different
      // action.
      const current = sameContentBox(live, painted)
      if (live !== undefined && !current) this.intents.requestRender()
      if (page !== undefined && live !== undefined && current && contentBoxContains(live, x, y)) {
        this.contentPressed = {
          x,
          y,
          columns: this.intents.columns(),
          rows: this.intents.rows(),
          revision: this.revision,
          box: live,
        }
        page.onCellPress(x - live.x, y - live.top)
        return
      }
      // A press inside the content of a stale frame is refused outright (it is
      // never recorded as a category gesture either): its release must not
      // dispatch anything.
      if (painted !== undefined && contentBoxContains(painted, x, y)) {
        page?.cancelPointer()
        return
      }
      page?.cancelPointer()
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
            childIdentity: this.childGestureIdentity(),
          }
      return
    }
    if (this.authPage !== undefined) {
      this.syncAuthPageBody()
      this.contentPressed = undefined
      const box = this.paintedContentBox
      if (box !== undefined && contentBoxContains(box, x, y)) {
        this.contentPressed = {
          x,
          y,
          columns: this.intents.columns(),
          rows: this.intents.rows(),
          revision: this.revision,
          box,
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
          childIdentity: this.childGestureIdentity(),
        }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    // The same directory fence on release: a gesture that began before a
    // registration/unload/dispose can never complete against the new directory.
    this.syncExtensionDirectory()
    if (this.directoryAwaitingPaint) {
      this.cancelPointerOwners()
      return
    }
    if (this.terminalGeometryStale()) {
      this.cancelPointerOwners()
      return
    }
    // A release in the unrepainted chrome window must resolve against neither
    // the old content box nor the old rail/pane hit map.
    if (this.chromeGeometryStale()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return
    }
    // A release in an unrepainted focus-transfer window is the same: the rail
    // cells on screen belong to the previous frame.
    if (this.rootProjectionAwaitingPaint()) {
      this.cancelPointerOwners()
      this.intents.requestRender()
      return
    }
    if (this.specialistPage !== undefined) {
      const pressed = this.specialistPressed
      this.specialistPressed = undefined
      const box = this.paintedSpecialistBox
      if (pressed === undefined || box === undefined) return
      // A release must resolve against the SAME painted cells under the SAME
      // root state: a resize, a scroll, a snapshot refresh or a picker-driven
      // repaint between press and release refuses the gesture.
      if (pressed.columns !== this.intents.columns()
        || pressed.rows !== this.intents.rows()
        || pressed.revision !== this.revision
        || !sameContentBox(pressed.box, box)
        || !contentBoxContains(box, x, y)) return
      this.specialistPage.handleMouse?.({
        type: 'click',
        button: 'left',
        x: x - box.x,
        y: y - box.top,
        screenX: x,
        screenY: y,
        width: box.width,
        height: box.rows,
        shift: false,
        alt: false,
        ctrl: false,
      })
      return
    }
    if (this.categoryId === 'plugins') {
      const page = this.pluginPage
      const live = page === undefined ? undefined : this.syncPluginFrame()
      const painted = this.paintedContentBox
      const current = sameContentBox(live, painted)
      if (live !== undefined && !current) this.intents.requestRender()
      if (page !== undefined && live !== undefined && current && contentBoxContains(live, x, y)) {
        // A release inside the content consumes the gesture: any root press from
        // before it is stale and must never fire the category rail.
        this.pressedGesture = undefined
        const pressed = this.contentPressed
        this.contentPressed = undefined
        // The release must resolve against the SAME box the press was admitted
        // against: a chrome change (App notice) that moved the column refuses the
        // old gesture instead of running another row's action.
        if (pressed === undefined
          || pressed.columns !== this.intents.columns()
          || pressed.rows !== this.intents.rows()
          || pressed.revision !== this.revision
          || !sameContentBox(pressed.box, live)) return
        // The press is proven and the content owns the keyboard from now on;
        // the page runs its OWN painted action against the grant it really
        // painted. The new projection is installed by the NEXT paint, so a
        // preview click that moves the rail out of the way is never refused by
        // a viewport the page did not paint. Its painted action set was created
        // while only the preview was on screen, so a preview click can
        // select/focus but never dispatch a Detail-only mutation.
        this.focus = 'content'
        page.onCellClick(x - live.x, y - live.top)
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      // A release over the content of a frame whose LIVE box moved is consumed
      // and refused (the press was refused too, or the chrome moved in between).
      if (painted !== undefined && contentBoxContains(painted, x, y)) {
        this.contentPressed = undefined
        this.pressedGesture = undefined
        page?.cancelPointer()
        return
      }
      this.contentPressed = undefined
      page?.cancelPointer()
      const pressed = this.pressedGesture
      this.pressedGesture = undefined
      const target = this.targetAt(x, y)
      if (pressed === undefined || target === undefined) return
      if (
        this.revision !== pressed.revision
        || this.focus !== pressed.focus
        || this.categoryId !== pressed.categoryId
        || this.intents.columns() !== pressed.columns
        || this.intents.rows() !== pressed.rows
        || this.childGestureIdentity() !== pressed.childIdentity
        || target.kind !== pressed.target.kind
        || target.id !== pressed.target.id
        || target.row !== pressed.target.row
        || target.startCol !== pressed.target.startCol
        || target.endCol !== pressed.target.endCol
      ) {
        return
      }
      this.activate(target)
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
      this.childGestureIdentity() !== pressed.childIdentity ||
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
        if (!isCategoryId(target.id)) return
        // `isCategoryId` only proves the id is a category at all; the painted
        // target must still be a member of the directory this frame drew.
        this.selectCategory(target.id, 'categories')
        return
      }
      case 'row': {
        if (!isWorkspaceRowId(target.id)) return
        this.selectRow(target.id, 'rows')
        // The row's `open-legacy` action is the ONE navigation verb (never an
        // edit) and the painted row IS its target, exactly like Enter.
        const legacyRow = this.selectedRow()
        if (legacyRow?.action === 'open-legacy') this.intents.onOpenLegacy(legacyRow.legacyTargetId)
        return
      }
      case 'about-action': {
        // The painted About affordance IS the action, exactly like the
        // keyboard: a stale release never reaches here (the revision/geometry
        // gate above already refused it), and the copy verbs bind to THE
        // VIEW THIS PANEL PAINTED (fenced by the painted-view identity inside
        // the copy methods: a newer same-epoch publication is refused). An
        // ordinary fact row publishes no target, so a click on the value text
        // falls through to its pane and copies nothing.
        if (target.id === 'about:copy-all') this.copyAboutAll()
        else if (target.id === 'about:refresh') this.aboutRefresh()
        return
      }
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
      case 'manage': {
        this.takeColumnFocus('detail')
        const row = this.selectedRow()
        if (row?.id === target.id) this.openSpecialist(row)
        return
      }
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
    // The C3 About subscription dies with the panel: a publication that
    // arrives after the teardown can never repaint a newer surface.
    this.aboutUnsubscribe?.()
    this.aboutUnsubscribe = undefined
    this.closeAuthPage()
    // C2-R3: the embedded specialist page dies with the workspace; a write it
    // already dispatched settles in its own owner and can never revive it.
    this.specialistPage?.dispose()
    this.specialistPage = undefined
    this.specialistRow = undefined
    this.paintedSpecialistBox = undefined
    this.specialistPressed = undefined
    // An external Settings teardown releases the hosted Plugin page's owner
    // exactly once; a focus yield never reaches this path.
    this.closePluginPage()
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
