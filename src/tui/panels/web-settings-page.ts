/**
 * The `/settings → Tools → Web Search / Fetch` page (C2-R4).
 *
 * This is the ONE Web provider configuration surface. It is mounted as an
 * EMBEDDED SPECIALIST PAGE inside the existing Settings Workspace lease (the
 * same body/chrome/Action Bar as the subagent allowlist picker) — never a
 * second alt-screen overlay and never the legacy `SettingsList`.
 *
 * Authority is deliberately NOT here:
 *  - the six displayed facts come from the command owner's LATEST authoritative
 *    Host read (`readFacts`): a pending read paints `Loading…`, an unreadable
 *    authority paints `Unavailable` with its reason, and a readable one paints
 *    the raw Host identity (a custom provider id stays verbatim, a stored count
 *    outside the four presets stays readable);
 *  - every write is ONE explicit Enter confirmation handed to the command
 *    owner's single FIFO (`commit`), whose verdict is `verified` /
 *    `not-saved` / `outcome-unknown` against a fresh read-back;
 *  - the endpoint draft is the EXISTING `WebEndpointPanel` (Input + explicit
 *    Enter Confirm + its own verdict vocabulary), not a cloned URL editor;
 *  - the DeepSeek API key is only displayed as the official credential
 *    REFERENCE. Configure/Clear hand a typed `ModelsInitialView` to the
 *    workspace root, which retires this page and mounts the existing Models
 *    page in the SAME lease. No secret ever reaches this component.
 *
 * The page owns ONLY transient presentation state: the list/detail cursor, the
 * highlighted candidate, the scroll offsets and the per-row write phase. All of
 * it dies with the page instance.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/web-settings-page
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { WebProviderSettings } from '../../runtime/config-port.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { ModelsInitialView } from './models-workspace-page.ts'
import type { EmbeddedSpecialistPage } from './settings-workspace-panel.ts'
import { WebEndpointPanel, WebWriteVerdictError, type WebPanelTaskRunner } from './web-provider-panels.ts'

/** The exact credential reference the official DeepSeek Search / Fetch API
 *  providers resolve (`apiKeyEnv`'s shipped default). Its VALUE never reaches
 *  this component: only presence/source and the reference name are painted. */
export const WEB_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
/** The page's own name (also the Settings row label and the breadcrumb tail). */
export const WEB_SETTINGS_PAGE_TITLE = 'Web Search / Fetch'

/**
 * The official search-provider candidates, in their frozen order. `id` is the
 * ONLY value ever written (`label` is presentation); a configured id outside
 * this table is a CUSTOM route: it is reported verbatim and is not selectable
 * here.
 */
export const WEB_SEARCH_PROVIDER_CANDIDATES = [
  { id: 'deepseek-official', label: 'Messages', default: true },
  { id: 'deepseek-search-api', label: 'DeepSeek Search API', default: false },
] as const

/** The official fetch-provider candidates (same identity contract). */
export const WEB_FETCH_PROVIDER_CANDIDATES = [
  { id: 'http', label: 'HTTP', default: true },
  { id: 'deepseek-fetch-api', label: 'DeepSeek Fetch API', default: false },
] as const

/** The four recommended result-count presets. The official `count` domain is
 *  1–50; a stored integer outside this list is still reported verbatim and is
 *  never rewritten by the page. */
export const WEB_SEARCH_COUNT_CANDIDATES = ['5', '10', '20', '50'] as const

/** The `sendOriginalQuestion` candidates. */
export const WEB_QUESTION_CANDIDATES = ['on', 'off'] as const

/** The five CONFIGURED fields (the credential row is the sixth, read-only
 *  reference row). */
export type WebSettingRowId =
  | 'web-search-provider'
  | 'web-fetch-provider'
  | 'web-search-count'
  | 'web-send-original-question'
  | 'web-search-endpoint'

/** The six row identities of this page, in the FROZEN order. */
export const WEB_SETTINGS_ROW_IDS = [
  'web-search-provider',
  'web-fetch-provider',
  'web-search-count',
  'web-send-original-question',
  'web-search-endpoint',
  'web-credential',
] as const
export type WebSettingsRowId = (typeof WEB_SETTINGS_ROW_IDS)[number]

/** The five configured rows as a membership guard for the legacy editor. */
export const WEB_SETTING_ROW_ID_SET: ReadonlySet<string> = new Set<WebSettingRowId>([
  'web-search-provider',
  'web-fetch-provider',
  'web-search-count',
  'web-send-original-question',
  'web-search-endpoint',
])

/** The latest authority facts the page renders. `pending` is a read in flight
 *  (or about to start): the page must never present a pre-open value as the
 *  current one. `unavailable` carries the REAL reason (backend/read failure). */
export type WebSettingsFacts =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly settings: WebProviderSettings }

/** The command owner's verdict for ONE confirmed write intent, decided against
 *  the newest authoritative read-back. `verified` means the Host really HOLDS
 *  the requested identity; `not-saved` means a readable authority keeps another
 *  value (it is reported); `outcome-unknown` means the result could not be
 *  attributed and the next fresh read owns the display. */
export type WebCommitResult =
  | { readonly kind: 'verified'; readonly actual: string }
  | { readonly kind: 'not-saved'; readonly reason: string; readonly actual?: string }
  | { readonly kind: 'outcome-unknown'; readonly reason: string }

/** One transient per-row write phase (presentation only; never a shadow value). */
export interface WebRowPhase {
  readonly kind: 'saving' | 'verified' | 'not-saved' | 'outcome-unknown'
  readonly reason?: string
}

/** The client-local capabilities and command-owner seams this page consumes. */
export interface WebSettingsPageIntents {
  /** The LATEST authoritative read state, read synchronously at render time. */
  readonly readFacts: () => WebSettingsFacts
  /** Why this page may not commit right now (backend non-current/unavailable).
   *  The page still paints the last read facts, but offers NO confirmable
   *  candidate, no endpoint draft and no credential action until it is writable
   *  again — the command queue would refuse every one of them. */
  readonly writableRefusal: () => string | undefined
  /** Whether the official credential store is mounted right now. */
  readonly credentialAvailable: () => boolean
  /** Queue ONE confirmed intent on the command owner's single Web FIFO. */
  readonly commit: (id: WebSettingRowId, requested: string) => Promise<WebCommitResult>
  /** Start a fresh authoritative Host read (`r` and page entry). */
  readonly refresh: () => void
  /** The root's narrow page-switch intent: retire this page and open the
   *  EXISTING Models page in the same lease. */
  readonly navigateToModels: (initial: ModelsInitialView) => void
  readonly requestRender: () => void
  /** The caller's owned task entry (never a bare promise). */
  readonly run: WebPanelTaskRunner
  /** The page's own close (Esc at the list root). Returns to the Tools row. */
  readonly done: () => void
}

type WebPageLayout = 'wide' | 'medium' | 'narrow'
type WebPageRegion = 'list' | 'detail'

/** One painted line of the Detail pane that may carry a pointer target. */
interface DetailLine {
  readonly text: string
  /** The candidate identity a Confirm would write (choice rows only). */
  readonly option?: string
  /** The credential action this line activates. */
  readonly action?: 'configure' | 'clear'
  /** A disabled action is painted but publishes NO hit target. */
  readonly enabled?: boolean
}

/** One painted pointer target, in PAGE-LOCAL cells (`y` excludes the Action
 *  Bar: the root's hit box only covers the body rows). */
interface PageTarget {
  readonly kind: 'row' | 'option' | 'action'
  readonly id: string
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

interface PagePaint {
  readonly width: number
  readonly rows: number
  readonly bodyRows: number
  readonly targetRows: readonly PageTarget[]
}

/** The frozen responsive breakpoints of THIS page (not a project rule). */
function layoutForWidth(width: number): WebPageLayout {
  if (width >= 100) return 'wide'
  if (width >= 65) return 'medium'
  return 'narrow'
}

/** Pad/truncate one painted line to exactly `width` cells. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Paint a left and a right run on ONE row, both kept WHOLE: the right run is
 *  dropped when the two + one gap do not fit (a half fact is never painted). */
function composeRow(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  if (right === '') return fit(left, width)
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (leftWidth + rightWidth + 1 > width) return fit(left, width)
  return fit(left + ' '.repeat(width - leftWidth - rightWidth) + right, width)
}

/** The LONGEST wording that fits `width` WHOLE, or '' when none does. */
function wholeWording(preferred: string, width: number, shorter: readonly string[] = []): string {
  return [preferred, ...shorter].find(text => visibleWidth(text) <= width) ?? ''
}

/** The state WORD + ink of one transient phase (§4A.2 vocabulary). */
function phaseWord(phase: WebRowPhase): string {
  switch (phase.kind) {
    case 'saving': return color.textDim('Saving…')
    case 'verified': return color.success('Verified')
    case 'not-saved': return color.error('Not saved')
    case 'outcome-unknown': return color.warning('Outcome unknown')
  }
}

/**
 * The `/settings → Tools → Web Search / Fetch` page. It paints a short list of
 * the six frozen rows plus the selected row's Detail, keeps ONE active cursor,
 * and turns exactly one explicit Enter into a `commit` on the command owner's
 * FIFO.
 */
export class WebSettingsPage implements EmbeddedSpecialistPage {
  readonly title = WEB_SETTINGS_PAGE_TITLE
  focused = false

  private readonly intents: WebSettingsPageIntents
  /** The list cursor (index into {@link WEB_SETTINGS_ROW_IDS}). */
  private cursor = 0
  private region: WebPageRegion = 'list'
  /** The highlighted candidate of the selected choice row (presentation only). */
  private choiceIndex = 0
  /** The highlighted credential action. */
  private actionIndex = 0
  private listOffset = 0
  private detailOffset = 0
  private rowGrant = 8
  private readonly phases = new Map<WebSettingRowId, WebRowPhase>()
  private endpointPanel: { readonly panel: WebEndpointPanel } | undefined
  private disposed = false
  private revision = 0
  private paint: PagePaint | undefined
  /** The credential action the LAST COMMITTED frame painted as the ACTIVE
   *  cursor (Detail region only). Enter must target exactly this identity. It
   *  is updated ONLY while the real render runs: a non-render projection (the
   *  input-path rebase) must never advance it before the screen shows the new
   *  action. */
  private paintedCredentialAction: 'configure' | 'clear' | undefined
  /** True only inside the real `render()` call (not for input-path
   *  projections). */
  private painting = false
  private pressed: {
    readonly x: number
    readonly y: number
    readonly target: PageTarget | undefined
    readonly revision: number
    readonly width: number
    readonly rows: number
  } | undefined

  constructor(intents: WebSettingsPageIntents) {
    this.intents = intents
  }

  /** The root's row-budget seam: the granted lines INCLUDE the Action Bar. */
  setMaxRows(rows: number): void {
    this.rowGrant = Math.max(1, Math.floor(rows))
  }

  private bodyRows(): number {
    return Math.max(0, this.rowGrant - 1)
  }

  /** The last PAINTED width, else the current grant's width guess. Keyboard and
   *  pointer decisions always use the frame the user really sees. */
  private liveWidth(): number {
    return this.paint?.width ?? 0
  }

  private liveBodyRows(): number {
    return this.paint?.bodyRows ?? this.bodyRows()
  }

  /** One state change: bump the gesture revision and repaint. */
  private commitPresentation(change: () => void): void {
    change()
    this.revision += 1
    this.intents.requestRender()
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // The endpoint draft owns the keyboard: its Input + its own explicit Enter
    // Confirm + its own Esc cancel are the ONLY keys it understands.
    if (this.endpointPanel !== undefined) {
      // Readiness is re-proved BEFORE the key is forwarded: a backend that
      // turned stale while the draft was open must not accept a Confirm, and
      // the key that discovered it is not applied to the read-only surface.
      if (this.syncEndpointWritability()) {
        this.commitPresentation(() => {})
        return
      }
      this.endpointPanel.panel.focused = this.focused
      this.endpointPanel.panel.handleInput(data)
      return
    }
    if (matchesKey(data, 'escape')) {
      if (this.region === 'detail') {
        this.commitPresentation(() => { this.region = 'list' })
        return
      }
      this.intents.done()
      return
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.toggleRegion()
      return
    }
    if (data === 'r' || data === 'R') {
      this.intents.refresh()
      return
    }
    if (matchesKey(data, 'enter')) {
      if (this.region === 'list') this.openSelectedRow()
      else this.confirmSelected()
      return
    }
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(true)
    if (matchesKey(data, 'end')) return this.jump(false)
    // Everything else is inert inside this page: no key leaks to the hidden
    // editor, transcript or a host composer action.
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.endpointPanel?.panel.dispose()
    this.endpointPanel = undefined
    this.paint = undefined
    this.pressed = undefined
    this.phases.clear()
  }

  /** The page paints from the LIVE palette at render time: no cached ANSI. */
  invalidate(): void {}

  /** The two-column layout paints both regions; the narrow one paints ONE. */
  private paintsBothRegions(width: number, bodyRows: number): boolean {
    return bodyRows >= 2 && layoutForWidth(width) !== 'narrow'
  }

  /** Tab / Shift+Tab move the REAL visible focus only: at a width that paints
   *  one region there is no other visible region to own the keys. A focus move
   *  never writes. */
  private toggleRegion(): void {
    if (!this.paintsBothRegions(this.liveWidth(), this.liveBodyRows())) return
    this.commitPresentation(() => {
      this.region = this.region === 'list' ? 'detail' : 'list'
    })
  }

  /**
   * Move the LIST selection and converge the Detail state onto the NEW row in
   * the same transaction: its authoritative candidate index, its credential
   * action index and its viewport. Every row change (keyboard, wheel, click)
   * goes through here, so a stale index can never be confirmed against a row
   * the user just scrolled to (the wheel used to bypass this convergence).
   */
  private selectRowIndex(index: number): void {
    const next = Math.min(Math.max(0, index), WEB_SETTINGS_ROW_IDS.length - 1)
    if (next === this.cursor) return
    this.commitPresentation(() => {
      this.cursor = next
      this.syncDetailToRow(this.intents.readFacts())
    })
  }

  /** Point the Detail at the SELECTED row's real state: the authority's current
   *  candidate, the first selectable credential action, and a viewport that
   *  reveals them. Presentation only; no read and no write. */
  private syncDetailToRow(facts: WebSettingsFacts): void {
    this.detailOffset = 0
    this.choiceIndex = this.currentChoiceIndex(facts)
    this.actionIndex = 0
    this.reconcileCredentialCursor()
    this.rebaseDetailForChoice(this.choiceIndex)
    this.rebaseDetailForAction(this.actionIndex)
  }

  private move(delta: number): void {
    if (this.region === 'list') {
      this.selectRowIndex(this.cursor + delta)
      return
    }
    const values = this.choiceValues()
    if (values.length > 0) {
      const next = Math.min(Math.max(0, this.choiceIndex + delta), values.length - 1)
      if (next === this.choiceIndex) return
      this.commitPresentation(() => {
        this.choiceIndex = next
        // The moved highlight must be REALLY visible: the smallest rebase keeps
        // the new candidate inside the granted Detail viewport.
        this.rebaseDetailForChoice(next)
      })
      return
    }
    if (this.selectedRowId() === 'web-credential') {
      const actions = this.selectableCredentialActions()
      if (actions.length === 0) return
      const index = this.reconcileCredentialCursor()
      const next = Math.min(Math.max(0, index + delta), actions.length - 1)
      if (next === this.actionIndex) return
      this.commitPresentation(() => {
        this.actionIndex = next
        // The moved action must be REALLY visible before Enter can run it.
        this.rebaseDetailForAction(next)
      })
      return
    }
    // A read-only detail scrolls its own facts instead of moving an invisible
    // cursor.
    this.scrollDetail(delta)
  }

  private page(delta: number): void {
    if (this.region === 'list') {
      const step = Math.max(1, this.listViewport(this.liveWidth(), this.liveBodyRows()))
      this.selectRowIndex(this.cursor + delta * step)
      return
    }
    this.scrollDetail(delta * Math.max(1, this.detailViewport(this.liveWidth(), this.liveBodyRows())))
  }

  private jump(start: boolean): void {
    if (this.region === 'list') {
      this.selectRowIndex(start ? 0 : WEB_SETTINGS_ROW_IDS.length - 1)
      return
    }
    const values = this.choiceValues()
    if (values.length > 0) {
      const next = start ? 0 : values.length - 1
      if (next === this.choiceIndex) return
      this.commitPresentation(() => {
        this.choiceIndex = next
        this.rebaseDetailForChoice(next)
      })
      return
    }
    this.commitPresentation(() => { this.detailOffset = start ? 0 : Number.MAX_SAFE_INTEGER })
  }

  private scrollDetail(delta: number): void {
    const width = this.liveWidth()
    const viewport = this.detailViewport(width, this.liveBodyRows())
    const projection = this.detailProjection(width, viewport)
    const next = Math.min(Math.max(0, this.detailOffset + delta), projection.maxOffset)
    if (next === this.detailOffset) return
    this.commitPresentation(() => { this.detailOffset = next })
  }

  /** Enter at the list: show the selected row's Detail. The endpoint row opens
   *  the EXISTING endpoint editor (only over a READABLE authority); every other
   *  row shows its facts/candidates read-only until an explicit Enter. */
  private openSelectedRow(): void {
    const rowId = this.selectedRowId()
    if (rowId === undefined) return
    const facts = this.intents.readFacts()
    if (rowId === 'web-search-endpoint' && facts.kind === 'ready'
      && this.intents.writableRefusal() === undefined) {
      this.openEndpointEditor(facts.settings.api.baseURL)
      return
    }
    this.commitPresentation(() => {
      this.region = 'detail'
      this.detailOffset = 0
      this.choiceIndex = this.currentChoiceIndex(facts)
      this.actionIndex = 0
      this.rebaseDetailForChoice(this.choiceIndex)
      this.rebaseDetailForAction(0)
    })
  }

  /** Enter in the Detail: confirm the highlighted candidate (choice rows) or
   *  activate one credential deeplink. Nothing else writes. */
  private confirmSelected(): void {
    const rowId = this.selectedRowId()
    if (rowId === undefined) return
    if (rowId === 'web-credential') {
      this.activateCredentialAction()
      return
    }
    const facts = this.intents.readFacts()
    // The endpoint row's ONE action is its explicit editor, reachable from the
    // LIST (Enter opens the Detail) and from the read-only Detail (Enter opens
    // the editor) — the bar never advertises a key that does nothing.
    if (rowId === 'web-search-endpoint') {
      if (facts.kind === 'ready' && this.intents.writableRefusal() === undefined) {
        this.openEndpointEditor(facts.settings.api.baseURL)
      }
      return
    }
    if (facts.kind !== 'ready') return
    const requested = this.choiceValues()[this.choiceIndex]
    if (requested === undefined) return
    // The candidate must be VISIBLE in this frame: an off-screen highlight is
    // never confirmed (the same rule the workspace's choice projection keeps).
    if (!this.paintedChoiceVisible(requested)) return
    this.confirmChoice(rowId, requested)
  }

  /** ONE explicit confirm → the command owner's FIFO → the painted verdict. The
   *  page never dispatches a second write for the same draft. */
  private confirmChoice(rowId: WebSettingRowId, requested: string): void {
    if (this.phases.get(rowId)?.kind === 'saving') return
    this.commitPresentation(() => {
      this.phases.set(rowId, { kind: 'saving' })
    })
    this.intents.run(`web settings ${rowId} write`, async () => {
      const result = await this.intents.commit(rowId, requested)
      if (this.disposed) return
      this.commitPresentation(() => {
        if (result.kind === 'verified') this.phases.set(rowId, { kind: 'verified' })
        else if (result.kind === 'not-saved') {
          this.phases.set(rowId, { kind: 'not-saved', ...result.reason === '' ? {} : { reason: result.reason } })
        } else this.phases.set(rowId, { kind: 'outcome-unknown', reason: result.reason })
      })
    })
  }

  /** Close the endpoint draft without a write (the backend stopped being
   *  writable, or the page is being retired). The draft never outlives its
   *  ability to be confirmed. */
  private closeEndpointDraft(): void {
    this.endpointPanel?.panel.dispose()
    this.endpointPanel = undefined
    this.region = 'detail'
    this.detailOffset = 0
    this.pressed = undefined
  }

  /** A draft whose Confirm can only be refused is a false affordance: when the
   *  backend turned non-current (or the credential/section disappeared), the
   *  draft closes with ZERO writes and the row's read-only Detail states why.
   *  Returns true when this call really closed a mounted draft. */
  private syncEndpointWritability(): boolean {
    if (this.endpointPanel === undefined) return false
    if (this.intents.writableRefusal() === undefined) return false
    this.closeEndpointDraft()
    return true
  }

  /** Mount the EXISTING endpoint editor for the row's current authority value. */
  private openEndpointEditor(current: string): void {
    const panel = new WebEndpointPanel((selected) => {
      if (this.endpointPanel?.panel !== panel) return
      this.endpointPanel = undefined
      if (selected !== undefined) this.phases.set('web-search-endpoint', { kind: 'verified' })
      this.commitPresentation(() => { this.region = 'list' })
    }, {
      current,
      save: async (url: string) => {
        const result = await this.intents.commit('web-search-endpoint', url)
        if (result.kind === 'verified') {
          this.phases.set('web-search-endpoint', { kind: 'verified' })
          return
        }
        this.phases.set('web-search-endpoint', { kind: result.kind, reason: result.reason })
        throw new WebWriteVerdictError(result.kind, result.reason)
      },
      requestRender: () => { if (!this.disposed) this.intents.requestRender() },
      run: (label, task) => this.intents.run(label, task),
    })
    panel.focused = this.focused
    this.endpointPanel = { panel }
    this.commitPresentation(() => {
      this.region = 'detail'
      this.detailOffset = 0
    })
  }

  // ── the six rows and their candidates ─────────────────────────────────────

  private selectedRowId(): WebSettingsRowId | undefined {
    return WEB_SETTINGS_ROW_IDS[this.cursor]
  }

  /** The CONFIGURED row behind the cursor (`undefined` for the credential row). */
  private selectedSettingId(): WebSettingRowId | undefined {
    const rowId = this.selectedRowId()
    return rowId === undefined || rowId === 'web-credential' ? undefined : rowId
  }

  /** The candidate identities the selected row may CONFIRM right now. A
   *  pending/unavailable authority, a custom provider route and the endpoint
   *  row (its own editor owns the write) offer NONE. */
  private choiceValues(): readonly string[] {
    const rowId = this.selectedSettingId()
    if (rowId === undefined || rowId === 'web-search-endpoint') return []
    const facts = this.intents.readFacts()
    if (facts.kind !== 'ready') return []
    if (this.intents.writableRefusal() !== undefined) return []
    switch (rowId) {
      case 'web-search-provider':
        return this.providerSelectable(facts.settings.searchProvider, WEB_SEARCH_PROVIDER_CANDIDATES)
          ? WEB_SEARCH_PROVIDER_CANDIDATES.map(candidate => candidate.id)
          : []
      case 'web-fetch-provider':
        return this.providerSelectable(facts.settings.fetchProvider, WEB_FETCH_PROVIDER_CANDIDATES)
          ? WEB_FETCH_PROVIDER_CANDIDATES.map(candidate => candidate.id)
          : []
      case 'web-search-count':
        return WEB_SEARCH_COUNT_CANDIDATES
      case 'web-send-original-question':
        return WEB_QUESTION_CANDIDATES
    }
  }

  /** Whether the configured provider id is one of the official candidates this
   *  page may select. `undefined` = no explicit selection (the official default
   *  applies), which IS selectable; any other id is a CUSTOM route and offers
   *  no candidate at all. */
  private providerSelectable(
    current: string | undefined,
    candidates: readonly { readonly id: string }[],
  ): boolean {
    return current === undefined || candidates.some(candidate => candidate.id === current)
  }

  /** The highlighted candidate of the selected row, positioned on the value the
   *  authority already holds. */
  private currentChoiceIndex(facts: WebSettingsFacts): number {
    if (facts.kind !== 'ready') return 0
    const rowId = this.selectedSettingId()
    if (rowId === undefined) return 0
    const committed = this.committedIdentity(facts.settings, rowId)
    const index = this.choiceValues().findIndex(value => value === committed)
    return index < 0 ? 0 : index
  }

  /** The authority's RAW identity of one field (never a display label). */
  private committedIdentity(settings: WebProviderSettings, rowId: WebSettingRowId): string | undefined {
    switch (rowId) {
      case 'web-search-provider': return settings.searchProvider
      case 'web-fetch-provider': return settings.fetchProvider
      case 'web-search-count': return String(settings.api.count)
      case 'web-send-original-question': return settings.api.sendOriginalQuestion ? 'on' : 'off'
      case 'web-search-endpoint': return settings.api.baseURL
    }
  }

  private providerLabel(
    candidates: readonly { readonly id: string; readonly label: string }[],
    id: string | undefined,
  ): string | undefined {
    return id === undefined ? undefined : (candidates.find(candidate => candidate.id === id)?.label ?? id)
  }

  /** The LATEST real Host fact of one row (§1.4) — NEVER a transient verdict:
   *  the Detail's `Current:` line and the row's `[current]` decision read this. */
  private authorityValue(rowId: WebSettingsRowId, facts: WebSettingsFacts): string {
    if (facts.kind === 'pending') return 'Loading…'
    if (facts.kind === 'unavailable') return 'Unavailable'
    const settings = facts.settings
    switch (rowId) {
      case 'web-search-provider': {
        if (settings.searchProvider === undefined) return 'not selected · official default applies'
        return sanitizedPhysicalLine(this.providerLabel(WEB_SEARCH_PROVIDER_CANDIDATES, settings.searchProvider) ?? settings.searchProvider)
      }
      case 'web-fetch-provider': {
        if (settings.fetchProvider === undefined) return 'not selected · official default applies'
        return sanitizedPhysicalLine(this.providerLabel(WEB_FETCH_PROVIDER_CANDIDATES, settings.fetchProvider) ?? settings.fetchProvider)
      }
      case 'web-search-count': return String(settings.api.count)
      case 'web-send-original-question': return settings.api.sendOriginalQuestion ? 'on' : 'off'
      case 'web-search-endpoint': return sanitizedPhysicalLine(settings.api.baseURL)
      case 'web-credential': return this.credentialState(facts).value
    }
  }

  /** The credential row's presence/source fact (never the value). */
  private credentialState(facts: WebSettingsFacts): { readonly value: string; readonly configured: boolean; readonly available: boolean } {
    if (facts.kind === 'pending') return { value: 'Loading…', configured: false, available: false }
    if (facts.kind === 'unavailable') return { value: 'Unavailable', configured: false, available: false }
    if (!this.intents.credentialAvailable()) {
      return { value: 'Unavailable', configured: false, available: false }
    }
    const credential = facts.settings.credential
    if (!credential.configured) return { value: 'Not configured', configured: false, available: true }
    return {
      value: credential.source === undefined
        ? 'Configured'
        : `Configured · source: ${sanitizedPhysicalLine(credential.source)}`,
      configured: true,
      available: true,
    }
  }

  /** The credential actions the CURRENT facts may offer. Clear requires a fresh
   *  official `configured: true`; both require a readable authority and a
   *  mounted credential store. */
  private credentialActions(): readonly { readonly action: 'configure' | 'clear'; readonly label: string; readonly enabled: boolean }[] {
    const facts = this.intents.readFacts()
    if (facts.kind !== 'ready') return []
    if (this.intents.writableRefusal() !== undefined) return []
    const state = this.credentialState(facts)
    if (!state.available) return []
    return [
      { action: 'configure', label: 'Configure in Models…', enabled: true },
      { action: 'clear', label: 'Clear in Models…', enabled: state.configured },
    ]
  }

  /** The actions the cursor may really activate right now. A DISABLED action
   *  is painted as a fact (with its reason) but is never focusable: the bar can
   *  therefore never advertise an Enter that would silently do nothing. */
  private selectableCredentialActions(): readonly { readonly action: 'configure' | 'clear'; readonly label: string; readonly enabled: boolean }[] {
    return this.credentialActions().filter(action => action.enabled)
  }

  /**
   * Reconcile the credential cursor with the CURRENT selectable set. A fresh
   * read can shrink it under the user (an external clear removes Clear while
   * the cursor sits on it): the cursor is clamped onto a still-selectable
   * action and the Detail is re-revealed, so the painted cursor, the Action Bar
   * and the Enter target can never disagree. Called from render and from every
   * cursor/activation path.
   */
  private reconcileCredentialCursor(): number {
    const count = this.selectableCredentialActions().length
    if (count === 0) return 0
    const clamped = Math.min(Math.max(0, this.actionIndex), count - 1)
    if (clamped !== this.actionIndex) {
      this.actionIndex = clamped
      this.detailOffset = 0
    }
    return clamped
  }

  /** Hand the typed page-switch intent to the ROOT: Models (never `/login`
   *  text) owns the actual credential mutation.
   *
   *  The gesture must target the action the user really SAW. Enter uses the
   *  action the LAST frame painted as the active cursor; a mouse click passes
   *  the painted hit target's identity. A fresh read that invalidated that
   *  action (an external clear while the cursor sat on Clear) REFUSES this
   *  gesture and repaints first — the reconciled Configure is selected for the
   *  NEXT gesture, never activated by the stale one. */
  private activateCredentialAction(clicked?: 'configure' | 'clear'): void {
    const selectable = this.selectableCredentialActions()
    const index = clicked === undefined
      ? this.reconcileCredentialCursor()
      : selectable.findIndex(action => action.action === clicked)
    const action = selectable[index]
    if (action === undefined) {
      // The gesture's target no longer exists: only a repaint (never a
      // different action) may answer it.
      this.commitPresentation(() => {})
      return
    }
    const seen = clicked ?? this.paintedCredentialAction
    if (seen === undefined || seen !== action.action) {
      this.commitPresentation(() => {})
      return
    }
    if (!this.paintedActionVisible(action.action)) return
    const initial: ModelsInitialView = action.action === 'configure'
      ? { view: 'reference', ref: WEB_CREDENTIAL_REF, label: 'DeepSeek API Key' }
      : { view: 'logout', target: { kind: 'reference', ref: WEB_CREDENTIAL_REF, label: 'DeepSeek API Key' } }
    this.intents.navigateToModels(initial)
  }

  // ── layout ────────────────────────────────────────────────────────────────

  private listViewport(width: number, bodyRows: number): number {
    if (!this.paintsBothRegions(width, bodyRows)) return bodyRows
    if (layoutForWidth(width) === 'wide') return bodyRows
    // Medium: the list is granted the top share, never more than its six rows.
    return Math.min(WEB_SETTINGS_ROW_IDS.length, Math.max(1, Math.floor((bodyRows - 1) / 2)))
  }

  private detailViewport(width: number, bodyRows: number): number {
    if (!this.paintsBothRegions(width, bodyRows)) return bodyRows
    if (layoutForWidth(width) === 'wide') return bodyRows
    return Math.max(1, bodyRows - this.listViewport(width, bodyRows))
  }

  private listColumnWidth(width: number): number {
    return Math.min(34, Math.max(1, width))
  }

  private detailWidth(width: number): number {
    if (!this.paintsBothRegions(width, this.bodyRows())) return width
    if (layoutForWidth(width) !== 'wide') return width
    return Math.max(1, width - this.listColumnWidth(width) - 2)
  }

  /** Keep the cursor inside the list viewport with the smallest rebase. */
  private rebaseList(viewport: number): number {
    const max = Math.max(0, WEB_SETTINGS_ROW_IDS.length - viewport)
    let next = this.listOffset
    if (this.cursor < next) next = this.cursor
    if (this.cursor >= next + viewport) next = this.cursor - viewport + 1
    return Math.min(Math.max(0, next), max)
  }

  /** Keep the Detail scroll on the highlighted candidate (smallest rebase). */
  private rebaseDetailForChoice(choiceIndex: number): void {
    const width = this.liveWidth()
    const viewport = this.detailViewport(width, this.liveBodyRows())
    const projection = this.detailProjection(width, viewport)
    const requested = this.choiceValues()[choiceIndex]
    if (requested === undefined) return
    const entry = projection.optionLines.find(line => line.value === requested)
    if (entry === undefined) return
    const max = projection.maxOffset
    let next = this.detailOffset
    if (entry.line < next) next = entry.line
    if (entry.line >= next + viewport) next = entry.line - viewport + 1
    this.detailOffset = Math.min(Math.max(0, next), max)
  }

  /** Keep the Detail scroll on the highlighted credential action. */
  private rebaseDetailForAction(actionIndex: number): void {
    const width = this.liveWidth()
    const viewport = this.detailViewport(width, this.liveBodyRows())
    const projection = this.detailProjection(width, viewport)
    const action = this.selectableCredentialActions()[actionIndex]?.action
    if (action === undefined) return
    const entry = projection.actionLines.find(line => line.value === action)
    if (entry === undefined) return
    let next = this.detailOffset
    if (entry.line < next) next = entry.line
    if (entry.line >= next + viewport) next = entry.line - viewport + 1
    this.detailOffset = Math.min(Math.max(0, next), projection.maxOffset)
  }

  /** Whether the highlighted credential action is really on screen. */
  private paintedActionVisible(action: string): boolean {
    const width = this.liveWidth()
    const viewport = this.detailViewport(width, this.liveBodyRows())
    const projection = this.detailProjection(width, viewport)
    const entry = projection.actionLines.find(line => line.value === action)
    if (entry === undefined) return false
    const offset = Math.min(Math.max(0, this.detailOffset), projection.maxOffset)
    return entry.line >= offset && entry.line < offset + viewport
  }

  /** Whether the highlighted candidate line is INSIDE the painted Detail
   *  viewport: an off-screen highlight may never be confirmed by Enter. */
  private paintedChoiceVisible(value: string): boolean {
    const width = this.liveWidth()
    const viewport = this.detailViewport(width, this.liveBodyRows())
    const projection = this.detailProjection(width, viewport)
    const entry = projection.optionLines.find(line => line.value === value)
    if (entry === undefined) return false
    const offset = Math.min(Math.max(0, this.detailOffset), projection.maxOffset)
    return entry.line >= offset && entry.line < offset + viewport
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    this.painting = true
    try {
      return this.renderFrame(width)
    } finally {
      this.painting = false
    }
  }

  private renderFrame(width: number): string[] {
    // A backend that turned non-current closes an open endpoint draft FIRST:
    // the frame never paints a Confirm the writer must refuse.
    this.syncEndpointWritability()
    // A fresh read can invalidate the credential cursor before this frame: clamp
    // it FIRST so the painted cursor, the bar and the Enter target agree.
    if (this.endpointPanel === undefined && this.selectedRowId() === 'web-credential') {
      this.reconcileCredentialCursor()
    }
    const grant = this.rowGrant
    const bodyRows = this.bodyRows()
    const facts = this.intents.readFacts()
    const targets: PageTarget[] = []
    const lines: string[] = []
    if (this.endpointPanel !== undefined) {
      const panel = this.endpointPanel.panel
      panel.focused = this.focused
      panel.setMaxRows(grant)
      const painted = panel.render(width)
      // The panel's OWN last line is its semantic hint: it becomes this page's
      // ONE physical Action Bar, exactly like a direct page's bar.
      const body = painted.slice(0, Math.max(0, painted.length - 1))
      for (let index = 0; index < bodyRows; index += 1) lines.push(fit(body[index] ?? '', width))
      lines.push(fit(painted[painted.length - 1] ?? '', width))
      this.paint = { width, rows: grant, bodyRows, targetRows: [] }
      return lines
    }
    const both = this.paintsBothRegions(width, bodyRows)
    if (both && layoutForWidth(width) === 'wide') {
      const listWidth = this.listColumnWidth(width)
      const detailWidth = this.detailWidth(width)
      const list = this.renderList(facts, listWidth, bodyRows)
      const detail = this.renderDetail(facts, detailWidth, bodyRows)
      for (let index = 0; index < bodyRows; index += 1) {
        lines.push(composeRow(list.lines[index] ?? '', detail.lines[index] ?? '', width))
      }
      targets.push(...list.targets)
      for (const target of detail.targets) targets.push({ ...target, startCol: target.startCol + listWidth + 2 })
    } else if (both) {
      const listRows = this.listViewport(width, bodyRows)
      const detailRows = this.detailViewport(width, bodyRows)
      const list = this.renderList(facts, width, listRows)
      const detail = this.renderDetail(facts, width, detailRows)
      for (let index = 0; index < listRows; index += 1) lines.push(fit(list.lines[index] ?? '', width))
      for (let index = 0; index < detailRows; index += 1) lines.push(fit(detail.lines[index] ?? '', width))
      targets.push(...list.targets)
      for (const target of detail.targets) targets.push({ ...target, row: target.row + listRows })
    } else if (this.region === 'list') {
      const list = this.renderList(facts, width, bodyRows)
      lines.push(...list.lines.map(line => fit(line, width)))
      targets.push(...list.targets)
    } else {
      const detail = this.renderDetail(facts, width, bodyRows)
      lines.push(...detail.lines.map(line => fit(line, width)))
      targets.push(...detail.targets)
    }
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(fit(this.actionBar(width, bodyRows), width))
    this.paint = { width, rows: grant, bodyRows, targetRows: targets }
    return lines.slice(0, grant)
  }

  /** The pane-header line the root paints inside the shared body grant. The
   *  two-column projection names BOTH columns; exactly one is the active
   *  device (§4.5) — the focused region's. */
  paneHeader(width: number): string {
    if (this.endpointPanel !== undefined) {
      return this.focused
        ? color.textStrong('[Search / Fetch API Endpoint]', 'primary')
        : color.textDim('Search / Fetch API Endpoint')
    }
    if (!this.paintsBothRegions(width, this.bodyRows())) {
      return this.focused
        ? color.textStrong(`[${WEB_SETTINGS_PAGE_TITLE}]`, 'primary')
        : color.textDim(WEB_SETTINGS_PAGE_TITLE)
    }
    const listActive = this.region === 'list'
    const left = listActive ? color.textStrong(`[${WEB_SETTINGS_PAGE_TITLE}]`, 'primary') : color.textDim(WEB_SETTINGS_PAGE_TITLE)
    const right = listActive ? color.textDim('Current / Detail') : color.textStrong('[Current / Detail]', 'primary')
    return composeRow(left, right, width)
  }

  /** A choice row's Action Bar: `Enter confirm` only while the highlighted
   *  candidate is inside THIS render's Detail viewport (the same gate the
   *  dispatch uses), so a resize can never advertise a Confirm it will drop. */
  private choiceActionBar(width: number, bodyRows: number): string {
    // A dispatched write owns the row: the bar states it and never advertises a
    // Confirm that `confirmChoice()` would silently drop.
    const rowId = this.selectedSettingId()
    if (rowId !== undefined && this.phases.get(rowId)?.kind === 'saving') {
      return wholeWording('Saving… · Esc back', width, ['Esc back'])
    }
    const requested = this.choiceValues()[this.choiceIndex]
    if (requested === undefined) return wholeWording('r refresh · Esc back', width, ['Esc back'])
    const viewport = this.detailViewport(width, bodyRows)
    const projection = this.detailProjection(width, viewport)
    const entry = projection.optionLines.find(line => line.value === requested)
    const offset = Math.min(Math.max(0, this.detailOffset), projection.maxOffset)
    const visible = entry !== undefined && entry.line >= offset && entry.line < offset + viewport
    if (!visible) return wholeWording('r refresh · Esc back', width, ['Esc back'])
    return wholeWording(
      '↑/↓ choose · Enter confirm · Esc back',
      width,
      ['Enter confirm · Esc back', 'Enter · Esc', 'Esc back'],
    )
  }

  /** The credential row's Action Bar. It advertises the Models deeplink ONLY
   *  while the reconciled cursor owns a selectable action that is really inside
   *  the CURRENT render's Detail viewport — an off-screen or disabled target is
   *  never described as an available Enter. `bodyRows` is THIS frame's grant,
   *  never the previously painted one (a resize can shrink the grant before
   *  `this.paint` is updated). */
  private credentialActionBar(width: number, bodyRows: number): string {
    const active = this.selectableCredentialActions()[this.reconcileCredentialCursor()]
    if (active === undefined) return wholeWording('r refresh · Esc back', width, ['Esc back'])
    const viewport = this.detailViewport(width, bodyRows)
    const projection = this.detailProjection(width, viewport)
    const entry = projection.actionLines.find(line => line.value === active.action)
    const offset = Math.min(Math.max(0, this.detailOffset), projection.maxOffset)
    const visible = entry !== undefined && entry.line >= offset && entry.line < offset + viewport
    if (!visible) return wholeWording('r refresh · Esc back', width, ['Esc back'])
    return wholeWording(
      '↑/↓ choose · Enter open in Models · Esc back',
      width,
      ['Enter open in Models · Esc back', 'Enter · Esc', 'Esc back'],
    )
  }

  /** The ONE physical Action Bar line. Whole segments only: a hint that does
   *  not fit is dropped, never cut into half a word. It is painted with the
   *  hint role (§3.2 role 12), so its first cell is always real ink. */
  private actionBar(width: number, bodyRows: number): string {
    const rowId = this.selectedRowId()
    const hint = this.region === 'list'
      ? wholeWording(
          '↑/↓ choose · Enter open · r refresh · Esc Tools',
          width,
          ['↑/↓ · Enter open · r refresh · Esc', '↑/↓ · Enter · Esc', 'Esc'],
        )
      : rowId === 'web-credential'
        ? this.credentialActionBar(width, bodyRows)
        : rowId === 'web-search-endpoint'
          ? this.intents.readFacts().kind === 'ready'
            && this.intents.writableRefusal() === undefined
            ? wholeWording(
                'Enter edit endpoint · Esc back',
                width,
                ['Enter edit · Esc back', 'Esc back'],
              )
            : wholeWording('r refresh · Esc back', width, ['Esc back'])
          // No confirmable candidate (a pending/unreadable authority or a custom
          // provider route) means NO Confirm affordance: the bar advertises only
          // what the frame really offers, and a candidate cropped out of THIS
          // frame's Detail viewport is not confirmable either (Enter is refused
          // by the same painted-visibility gate).
          : this.choiceActionBar(width, bodyRows)
    return hint === '' ? '' : color.textMuted(hint)
  }

  private renderList(
    facts: WebSettingsFacts,
    width: number,
    viewport: number,
  ): { readonly lines: string[]; readonly targets: PageTarget[] } {
    if (viewport <= 0) return { lines: [], targets: [] }
    const offset = this.rebaseList(viewport)
    this.listOffset = offset
    const lines: string[] = []
    const targets: PageTarget[] = []
    for (let index = 0; index < viewport; index += 1) {
      const rowId = WEB_SETTINGS_ROW_IDS[offset + index]
      if (rowId === undefined) {
        lines.push(fit('', width))
        continue
      }
      lines.push(this.listRow(rowId, facts, width))
      targets.push({ kind: 'row', id: rowId, row: index, startCol: 0, endCol: width })
    }
    return { lines, targets }
  }

  /** ONE list row: the cursor, the frozen label and the CURRENT value. The
   *  label keeps its head cells (truncated with `…`), the value takes what is
   *  left. A transient STATE word replaces the value while the row is writing
   *  and is NEVER truncated: the label yields instead (design language §4.5),
   *  because a cut state word is a different claim. */
  private listRow(rowId: WebSettingsRowId, facts: WebSettingsFacts, width: number): string {
    const selected = rowId === this.selectedRowId()
    const cursor = selected ? (this.region === 'list' ? color.primary('> ') : color.textMuted('> ')) : '  '
    const phase = rowId === 'web-credential' ? undefined : this.phases.get(rowId)
    const phaseWordText = phase === undefined || phase.kind === 'verified'
      ? undefined
      : phase.kind === 'saving' ? 'Saving…' : phase.kind === 'not-saved' ? 'Not saved' : 'Outcome unknown'
    const labelOf = (room: number): string => {
      const label = truncateToWidth(this.rowLabel(rowId), Math.max(1, room), '…', false)
      return selected ? color.textStrong(label) : color.text(label)
    }
    if (phaseWordText !== undefined) {
      const wordCells = visibleWidth(phaseWordText)
      const label = labelOf(width - 2 - wordCells - 1)
      const lead = `${cursor}${label}`
      const gap = Math.max(1, width - visibleWidth(lead) - wordCells)
      const ink = phase?.kind === 'not-saved' ? color.error(phaseWordText)
        : phase?.kind === 'outcome-unknown' ? color.warning(phaseWordText) : color.textDim(phaseWordText)
      return fit(`${lead}${' '.repeat(gap)}${ink}`, width)
    }
    const label = this.rowLabel(rowId)
    const lead = truncateToWidth(`${cursor}${selected ? color.textStrong(label) : color.text(label)}`, width, '…', false)
    const leadWidth = visibleWidth(lead)
    const valueRoom = Math.max(0, width - leadWidth - 1)
    if (valueRoom < 1) return fit(lead, width)
    const paintedValue = truncateToWidth(sanitizedPhysicalLine(this.authorityValue(rowId, facts)), valueRoom, '…', false)
    const gap = Math.max(1, width - leadWidth - visibleWidth(paintedValue))
    return fit(`${lead}${' '.repeat(gap)}${color.textMuted(paintedValue)}`, width)
  }

  private rowLabel(rowId: WebSettingsRowId): string {
    switch (rowId) {
      case 'web-search-provider': return 'Web Search Provider'
      case 'web-fetch-provider': return 'Web Fetch Provider'
      case 'web-search-count': return 'Search API Result Count'
      case 'web-send-original-question': return 'Share Original Question'
      case 'web-search-endpoint': return 'Search / Fetch API Endpoint'
      case 'web-credential': return 'DeepSeek API Key'
    }
  }

  // ── the Detail projection ─────────────────────────────────────────────────

  /** The full Detail pane of the selected row, as scrollable lines plus the
   *  candidates they carry. The caller paints a viewport of it. */
  private detailProjection(width: number, viewport: number): {
    readonly lines: readonly DetailLine[]
    readonly optionLines: readonly { readonly value: string; readonly line: number }[]
    readonly actionLines: readonly { readonly value: string; readonly line: number }[]
    readonly maxOffset: number
  } {
    const lines = this.detailLines(width, this.intents.readFacts())
    const optionLines = lines.flatMap((line, index) =>
      line.option === undefined ? [] : [{ value: line.option, line: index }])
    const actionLines = lines.flatMap((line, index) =>
      line.action === undefined || line.enabled !== true ? [] : [{ value: line.action, line: index }])
    return { lines, optionLines, actionLines, maxOffset: Math.max(0, lines.length - viewport) }
  }

  private detailLines(width: number, facts: WebSettingsFacts): DetailLine[] {
    const rowId = this.selectedRowId()
    if (rowId === undefined) return []
    if (rowId === 'web-credential') return this.credentialDetail(width, facts)
    const lines: DetailLine[] = this.currentFactLines(rowId, facts, width)
    const phase = this.phases.get(rowId)
    if (phase !== undefined) lines.push(...this.phaseLines(phase, width))
    const values = this.choiceValues()
    if (values.length > 0) {
      lines.push({ text: '' })
      const committed = facts.kind === 'ready' ? this.committedIdentity(facts.settings, rowId) : undefined
      for (const [index, value] of values.entries()) lines.push(this.optionLine(rowId, value, index, committed, width))
      lines.push({ text: '' })
    }
    lines.push(...this.rowNotes(rowId, facts, width).map(text => ({ text })))
    return lines
  }

  /** The row's `Current:` fact. EVERY Host-origin value is wrapped (a long
   *  custom provider id, a long URL, a long credential source) so the Detail
   *  can scroll to the whole value instead of claiming a truncated tail is the
   *  stored fact; short values still paint exactly one line. */
  private currentFactLines(rowId: WebSettingRowId, facts: WebSettingsFacts, width: number): DetailLine[] {
    const value = this.authorityValue(rowId, facts)
    const head = 'Current: '
    const headWidth = visibleWidth(head)
    const valueLines = (raw: string): DetailLine[] => {
      const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(raw), Math.max(1, width - headWidth))
      if (wrapped.length === 0) return [{ text: color.textMuted(head) }]
      return wrapped.map((chunk, index) => ({
        text: index === 0
          ? `${color.textMuted(head)}${color.text(chunk)}`
          : `${' '.repeat(headWidth)}${color.text(chunk)}`,
      }))
    }
    if (facts.kind === 'unavailable') {
      return [
        ...valueLines(value),
        // `facts.reason` is HOST-origin text: sanitize at the display boundary
        // (no raw ANSI/VT/CR/LF can ever reach the terminal) before wrapping.
        ...wrapTextWithAnsi(sanitizedPhysicalLine(facts.reason), Math.max(1, width)).map(text => ({ text: color.textDim(text) })),
      ]
    }
    const refusal = this.intents.writableRefusal()
    if (refusal !== undefined) {
      return [
        ...valueLines(value),
        ...wrapTextWithAnsi(refusal, Math.max(1, width)).map(text => ({ text: color.warning(text) })),
      ]
    }
    return valueLines(value)
  }

  /** ONE candidate line. The active cursor is `primary` only while the Detail
   *  region really owns the keyboard; the `[current]` chip is painted only on a
   *  candidate that matches the LATEST authoritative read. */
  private optionLine(
    rowId: WebSettingRowId,
    value: string,
    index: number,
    committed: string | undefined,
    width: number,
  ): DetailLine {
    const selected = index === this.choiceIndex
    const marker = selected ? (this.region === 'detail' ? color.primary('› ') : color.textDim('› ')) : '  '
    const label = this.optionLabel(rowId, value)
    const note = this.optionNote(rowId, value)
    let text = `${marker}${selected ? color.textStrong(label) : color.text(label)}`
    if (note !== '' && visibleWidth(`${text} · ${note}`) <= width) text += color.textDim(` · ${note}`)
    if (committed === value && visibleWidth(`${text} [current]`) <= width) text += ` ${color.textMuted('[current]')}`
    return { text, option: value }
  }

  private optionLabel(rowId: WebSettingRowId, value: string): string {
    switch (rowId) {
      case 'web-search-provider': return WEB_SEARCH_PROVIDER_CANDIDATES.find(candidate => candidate.id === value)?.label ?? value
      case 'web-fetch-provider': return WEB_FETCH_PROVIDER_CANDIDATES.find(candidate => candidate.id === value)?.label ?? value
      default: return value
    }
  }

  private optionNote(rowId: WebSettingRowId, value: string): string {
    switch (rowId) {
      case 'web-search-provider':
        return value === 'deepseek-official' ? 'built-in default' : 'opt-in · separately billed'
      case 'web-fetch-provider':
        return value === 'http' ? 'anonymous default' : 'opt-in · separately billed'
      case 'web-search-count':
        return value === '10' ? 'packed default' : ''
      case 'web-send-original-question':
        return value === 'on' ? 'packed default' : ''
      default: return ''
    }
  }

  /** The row's static explanation, wrapped to the Detail column. These are the
   *  durable product facts (defaults, billing, payload boundary, endpoint
   *  trust) this page freezes; they are never derived from the request. */
  private rowNotes(rowId: WebSettingRowId, facts: WebSettingsFacts, width: number): string[] {
    const notes: string[] = []
    switch (rowId) {
      case 'web-search-provider': {
        const custom = facts.kind === 'ready'
          && !this.providerSelectable(facts.settings.searchProvider, WEB_SEARCH_PROVIDER_CANDIDATES)
        notes.push(custom
          ? 'The configured search provider is a CUSTOM route: it is displayed as-is and is not selectable here. '
            + 'The official candidates are Messages and DeepSeek Search API.'
          : 'Messages is the official default and does not call the billed Search API. '
            + 'DeepSeek Search API is opt-in and separately billed: a Messages plan does not guarantee coverage. '
            + 'The choice applies to the NEXT search. No write happens without an explicit Enter.')
        break
      }
      case 'web-fetch-provider': {
        const custom = facts.kind === 'ready'
          && !this.providerSelectable(facts.settings.fetchProvider, WEB_FETCH_PROVIDER_CANDIDATES)
        notes.push(custom
          ? 'The configured fetch provider is a CUSTOM route: it is displayed as-is and is not selectable here. '
            + 'The official candidates are HTTP and DeepSeek Fetch API.'
          : 'HTTP is the official anonymous default. DeepSeek Fetch API is opt-in and separately billed: '
            + 'a Messages plan does not guarantee coverage. The choice applies to the NEXT fetch.')
        break
      }
      case 'web-search-count':
        notes.push('Results requested per DeepSeek Search API call. The official limit is 1 through 50; '
          + 'a stored value outside these presets stays exactly as the Host reports it, and a smaller per-request bound still wins. '
          + 'The count applies to the NEXT search.')
        break
      case 'web-send-original-question':
        notes.push('On (packed default for the DeepSeek Search API): each call also sends up to 128 characters of the '
          + 'triggering human question as ori_question — never the full history or the system prompt. Off: never sent. '
          + 'Only the DeepSeek Search API uses this field; a running operation is unchanged.')
        break
      case 'web-search-endpoint':
        notes.push('The API base the DeepSeek Search and Fetch APIs call; /search and /fetch are appended automatically. '
          + 'Enter opens the endpoint editor and nothing is written until its explicit Confirm. '
          + 'Changing it sends the DeepSeek API credential and the query to that target: confirm only a trusted HTTPS base — '
          + 'the URL shape is checked, not the host\'s trust.')
        notes.push('Official base: https://api.deepseek.com/v1/tools')
        break
    }
    if (notes.length === 0) return []
    return ['', ...notes.flatMap(note => wrapTextWithAnsi(note, Math.max(1, width)))]
  }

  /** The state word plus its reason, wrapped so a long Host failure text is
   *  wholly readable (scrollable) instead of being truncated mid-sentence. */
  private phaseLines(phase: WebRowPhase, width: number): DetailLine[] {
    const word = phaseWord(phase)
    if (phase.reason === undefined || phase.reason === '') return [{ text: word }]
    const separator = ' · '
    const headWidth = visibleWidth(word) + visibleWidth(separator)
    const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(phase.reason), Math.max(1, width - headWidth))
    if (wrapped.length === 0) return [{ text: word }]
    return wrapped.map((chunk, index) => ({
      text: index === 0
        ? `${word}${color.textDim(separator)}${color.textDim(chunk)}`
        : `${' '.repeat(headWidth)}${color.textDim(chunk)}`,
    }))
  }

  private credentialDetail(width: number, facts: WebSettingsFacts): DetailLine[] {
    const state = this.credentialState(facts)
    const stateHead = 'State: '
    const stateWrapped = wrapTextWithAnsi(sanitizedPhysicalLine(state.value), Math.max(1, width - visibleWidth(stateHead)))
    const lines: DetailLine[] = [
      { text: color.textMuted(`Reference: ${WEB_CREDENTIAL_REF}`) },
      ...stateWrapped.map((chunk, index) => ({
        text: index === 0
          ? `${color.textMuted(stateHead)}${color.text(chunk)}`
          : `${' '.repeat(visibleWidth(stateHead))}${color.text(chunk)}`,
      })),
    ]
    const actions = this.credentialActions()
    if (actions.length === 0 && facts.kind === 'ready') {
      const refusal = this.intents.writableRefusal()
      if (refusal !== undefined) {
        lines.push(...wrapTextWithAnsi(refusal, Math.max(1, width)).map(text => ({ text: color.warning(text) })))
      } else {
        lines.push({ text: color.textDim('The official credential store is unavailable; no credential action is offered here.') })
      }
    }
    const activeIndex = this.reconcileCredentialCursor()
    if (this.painting) this.paintedCredentialAction = undefined
    let selectable = -1
    for (const action of actions) {
      if (action.enabled) selectable += 1
      // A disabled action is a painted FACT: no cursor, no hit target, and the
      // bar never advertises it (only `selectableCredentialActions()` drive the
      // cursor and the Enter affordance).
      if (!action.enabled) {
        lines.push({
          text: `${color.textMuted(truncateToWidth(`  ${action.label}`, Math.max(1, width), '…', false))}${color.textDim(' (unavailable)')}`,
        })
        continue
      }
      const active = selectable === activeIndex
      if (active && this.region === 'detail' && this.painting) this.paintedCredentialAction = action.action
      const marker = active ? (this.region === 'detail' ? color.primary('› ') : color.textDim('› ')) : '  '
      const label = `${marker}${active && this.region === 'detail' ? color.textStrong(action.label) : action.label}`
      lines.push({ text: truncateToWidth(label, Math.max(1, width), '…', false), action: action.action, enabled: true })
    }
    lines.push({ text: '' })
    for (const note of wrapTextWithAnsi(
      `The key is stored as the official credential reference "${WEB_CREDENTIAL_REF}"; its value is never shown here. `
        + 'Models owns the masked input and the clear confirmation, in this same Settings workspace.',
      Math.max(1, width),
    )) {
      lines.push({ text: color.textDim(note) })
    }
    return lines
  }

  private renderDetail(
    facts: WebSettingsFacts,
    width: number,
    viewport: number,
  ): { readonly lines: string[]; readonly targets: PageTarget[]; readonly maxOffset: number } {
    if (viewport <= 0) return { lines: [], targets: [], maxOffset: 0 }
    const projection = this.detailProjection(width, viewport)
    const offset = Math.min(Math.max(0, this.detailOffset), projection.maxOffset)
    this.detailOffset = offset
    const lines: string[] = []
    const targets: PageTarget[] = []
    for (let index = 0; index < viewport; index += 1) {
      const line = projection.lines[offset + index]
      if (line === undefined) {
        lines.push(fit('', width))
        continue
      }
      lines.push(fit(line.text, width))
      if (line.option !== undefined) {
        targets.push({ kind: 'option', id: line.option, row: index, startCol: 0, endCol: width })
      } else if (line.action !== undefined && line.enabled === true) {
        targets.push({ kind: 'action', id: line.action, row: index, startCol: 0, endCol: width })
      }
    }
    return { lines, targets, maxOffset: projection.maxOffset }
  }

  // ── mouse: the page's OWN last-painted hit map + press identity ───────────

  private targetAt(x: number, y: number): PageTarget | undefined {
    return this.paint?.targetRows.find(target => target.row === y && x >= target.startCol && x < target.endCol)
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (this.endpointPanel !== undefined) {
      // The endpoint draft owns its own editing semantics; this page publishes
      // no pointer grant inside it.
      return event.type === 'wheel' ? { handled: true } : undefined
    }
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      const width = this.liveWidth()
      const bodyRows = this.liveBodyRows()
      if (this.paintsBothRegions(width, bodyRows)) {
        // The COLUMN under the pointer owns the wheel, independently of which
        // region currently owns the keyboard.
        const listOwns = layoutForWidth(width) === 'wide'
          ? event.x < this.listColumnWidth(width)
          : event.y < this.listViewport(width, bodyRows)
        if (listOwns) this.scrollList(delta)
        else this.scrollDetail(delta)
        return { handled: true }
      }
      if (this.region === 'list') this.scrollList(delta)
      else this.scrollDetail(delta)
      return { handled: true }
    }
    if (event.type === 'press') {
      this.pressed = {
        x: event.x,
        y: event.y,
        target: this.targetAt(event.x, event.y),
        revision: this.revision,
        width: this.paint?.width ?? 0,
        rows: this.paint?.rows ?? 0,
      }
      return undefined
    }
    // click
    const pressed = this.pressed
    this.pressed = undefined
    if (pressed === undefined || pressed.target === undefined) return undefined
    if (pressed.revision !== this.revision) return undefined
    if (pressed.width !== (this.paint?.width ?? 0) || pressed.rows !== (this.paint?.rows ?? 0)) return undefined
    const target = this.targetAt(event.x, event.y)
    if (target === undefined) return undefined
    if (target.kind !== pressed.target.kind || target.id !== pressed.target.id || target.row !== pressed.target.row) return undefined
    this.activateTarget(target)
    return undefined
  }

  /** The wheel over the list scrolls the list by moving the SELECTION: the
   *  render-time rebase then reveals it, so the wheel's effect can never be
   *  undone by the cursor-visibility fence (and the active cursor stays
   *  visible, never a ghost action on a scrolled-out row). */
  private scrollList(delta: number): void {
    this.selectRowIndex(this.cursor + delta)
  }

  private activateTarget(target: PageTarget): void {
    if (target.kind === 'row') {
      const index = WEB_SETTINGS_ROW_IDS.indexOf(target.id as WebSettingsRowId)
      if (index < 0) return
      // Selecting a row is presentation only; activating it opens the SAME
      // Detail the keyboard's Enter opens.
      this.selectRowIndex(index)
      this.openSelectedRow()
      return
    }
    if (target.kind === 'option') {
      const index = this.choiceValues().indexOf(target.id)
      if (index < 0) return
      this.commitPresentation(() => { this.choiceIndex = index })
      return
    }
    // A mouse activation carries the PAINTED target identity: the same
    // seen-action fence as Enter (a stale Clear target is refused, not
    // redirected onto the reconciled Configure).
    this.activateCredentialAction(target.id as 'configure' | 'clear')
  }
}
