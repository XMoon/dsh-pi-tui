/**
 * The `/settings → Host → Web UI` page (SUX-04): the ONE Web frontend surface.
 *
 * It is mounted as a real Detail TENANT inside the existing Settings Workspace
 * lease: the parent Categories/Rows stay painted and readable, the root keeps
 * the ONE physical last-row Action Bar and the ONE Esc target, and only this
 * page's body cells belong to the child. It is never a second alt-screen
 * overlay, never a second Settings screen. `/web` and the `Host → Web UI` row
 * reach the SAME page class through the SAME factory.
 *
 * Two authorities are painted as two separate reading groups and are NEVER
 * merged:
 *  - `Current Host` is the LIVE listener state of the running Split Host, read
 *    through the semantic `WebAccessPort` and bound to the Connection
 *    generation it was read under. Every Host action is qualified by a CURRENT
 *    observation; a generation change revokes the actions, the link and the
 *    pointer map, paints `Checking…` and re-reads;
 *  - `Next Host Start` is the persisted `pi-tui-web-preferences.autoStart`
 *    profile value for the NEXT launch, read through the ConfigPort and written
 *    only by the existing revision-checked `commitSettingsWorkspaceField`
 *    `web-autostart` writer. Toggling the running Host never changes it, and
 *    saving it never toggles the running Host.
 *
 * Admission is ONE local semantic fact: only an action whose complete verb,
 * candidate or confirmation row was really painted in the CURRENT frame may be
 * activated — by a pointer press/release at the painted cells, by the page's
 * bar span or by the keyboard. A whole-row blank/padding click only selects.
 * A confirmation is never admitted until its necessary risk/question copy was
 * completely painted in the SAME frame; a short grant paints only the safe
 * Cancel/Esc until the user scrolls or resizes to a sufficient grant.
 *
 * Authority is deliberately NOT here: the page owns only transient
 * presentation state (phase, cursor, scroll offset, staged candidate, the
 * last-painted pointer geometry). The authenticated launch URL is requested
 * ONLY by an explicit Open/Copy action, handed straight to the Client opener or
 * clipboard, and never painted, stored or logged; a credential-bearing failure
 * is converted to a fixed safe fact BEFORE it can reach the owned-task
 * diagnostic.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/web-ui-settings-page
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { WebAccessStatus } from '../../runtime/web-access-port.ts'
import type { WebStartupPreferenceState } from '../../runtime/config-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { SettingsWorkspaceCommitOutcome, EmbeddedSpecialistPage, SpecialistParentLeaveTarget } from './settings-workspace-panel.ts'

/** The page's own name (the Settings row label, the breadcrumb tail and the
 *  pane header). */
export const WEB_UI_PAGE_TITLE = 'Web UI'

/**
 * The page's ONE transient phase. The runtime and preference steps are
 * deliberately phases of THIS page instead of per-row shadow authorities: at
 * most one confirmation is painted at a time and only the phase decides what
 * the body and the Action Bar offer.
 *
 * `settled` is a presentation state (the last preference write's result is
 * painted); its action qualification is derived from the CURRENT observations
 * exactly like `ready`, never from the settlement itself.
 */
export type WebUiPagePhase =
  | 'loading'
  | 'ready'
  | 'confirm-disable'
  | 'choose-autostart'
  | 'confirm-save'
  | 'pending-runtime'
  | 'pending-config'
  | 'settled'

/**
 * The CURRENT Host observation. `split-host-only` is a capability fact (the
 * Direct process owns no Web frontend) and never becomes an action; `checking`
 * is the honest state while a read is in flight or a generation change has
 * revoked the previous fact.
 */
type HostObservation =
  | { readonly kind: 'checking' }
  | { readonly kind: 'split-host-only' }
  | { readonly kind: 'current'; readonly status: WebAccessStatus; readonly generation: unknown }
  | { readonly kind: 'unreadable'; readonly message: string }

/** One settled write's painted result: the status WORD, its semantic tone and
 *  the explanation kept separate so only the word takes the token. */
interface OutcomeNote {
  readonly word: string
  readonly tone: 'success' | 'error' | 'warning' | 'muted'
  readonly detail?: string
}

/** One focusable row of the current projection. `field` rows select on a row
 *  click and expose ONE explicit `Change…` action; `action` rows publish the
 *  complete business verb itself. */
interface RowSpec {
  readonly id: string
  readonly kind: 'action' | 'field'
  readonly label: string
  /** The row's own value / explanation column (a secondary fact). */
  readonly value?: string
  /** Whether `value` is a primary content fact or a secondary explanation. */
  readonly valueInk?: 'text' | 'dim'
  /** A whole state chip painted at the END of the row (`[current]`). */
  readonly chip?: string
  /** A trailing affordance (`· Change…`); dropped WHOLE when it cannot fit. */
  readonly affordance?: string
}

/** One painted body hit span, in this page's own columns. A `select` span only
 *  moves the cursor; an `action` span runs the row's explicit intent. */
interface BodyTarget {
  readonly kind: 'select' | 'action'
  readonly id: string
  readonly startCol: number
  readonly endCol: number
}

/** One painted body line plus the row it belongs to (when focusable) and its
 *  complete-span admission. */
interface ContentLine {
  readonly text: string
  readonly rowId?: string
  readonly targets?: readonly BodyTarget[]
  /** Necessary copy: a gated entry may only act while every line of this group
   *  is inside the SAME painted viewport. */
  readonly group?: 'copy'
  /** This line is the explicit accept entry: blank unless its copy group is
   *  complete in the same frame (and then its span is the ONLY accept grant). */
  readonly gatedBy?: 'copy'
}

/** The geometry the page publishes to the Settings root for ONE painted frame:
 *  its body grant, its bar spans and the semantic identity a pointer release is
 *  re-proved against. */
interface PagePaint {
  readonly width: number
  readonly rows: number
  readonly identity: string
  readonly targets: readonly { readonly kind: BodyTarget['kind']; readonly id: string; readonly row: number; readonly startCol: number; readonly endCol: number }[]
  readonly scrollStart: number
  readonly scrollEnd: number
  readonly maxOffset: number
}

/** One delegated Action Bar intent the page can receive from the root. */
type BarAction = 'refresh' | 'confirm' | 'select'
type BarSegment = ActionBarSegment & { readonly action?: BarAction; readonly escape?: boolean }

/**
 * The page-local keys. They are deliberately NOT rebindable app actions, so
 * the SAME constant supplies the handler and the painted key badge (design
 * language §7.1). `r`/`R` are both accepted because the badge spells `[R]`,
 * exactly like the existing Settings pages.
 */
const REFRESH_KEY = 'r'

/** The fixed label column. It fits the longest product label (`Start
 *  automatically`) and keeps every section's values in one column. */
const LABEL_COLUMN = 19
/** Two-cell content indent shared by every body line/continuation. */
const INDENT = '  '

/** The exact confirm sentence of the runtime write (never paraphrased). */
const DISABLE_QUESTION = 'Stop serving the Web UI? Existing browser credentials and sessions are not revoked.'
/** The next-start choice prompt and its frozen lifetime fact. */
const CHOOSE_PROMPT = 'Choose the value the next Host start applies:'
const NEXT_START_ONLY = 'Applies on the next Host start; the running Host is unchanged.'
/** The ONE fixed reason a credential-bearing hand-off failure may paint or
 *  diagnose: it never carries the URL, its query, an error message or a cause. */
const LINK_FAILURE_REASON = 'The access link could not be obtained or handed over.'

/** The `Serving` word + tone of one Host status (design language role 9). */
function servingWord(status: WebAccessStatus): { readonly text: string; readonly tone: 'success' | 'muted' | 'warning' | 'error' } {
  switch (status.state) {
    case 'enabled': return { text: 'Enabled', tone: 'success' }
    case 'disabled': return { text: 'Disabled', tone: 'muted' }
    case 'changing': return { text: 'Changing…', tone: 'warning' }
    case 'unavailable': return { text: 'Unavailable', tone: 'error' }
  }
}

/** The access fact of the CURRENT Host. Never a guessed address: only an
 *  enabled listener is stated with its real binding. */
function accessWord(status: WebAccessStatus): { readonly text: string; readonly tone: 'text' | 'dim' | 'error' } {
  switch (status.state) {
    case 'enabled': return { text: 'This machine · 127.0.0.1', tone: 'text' }
    case 'disabled': return { text: 'Not serving', tone: 'dim' }
    case 'changing': return { text: 'Changing…', tone: 'dim' }
    case 'unavailable': return { text: 'Unavailable', tone: 'error' }
  }
}

/** The preference's display value + provenance. `Off (default)` marks the
 *  schema default the USER layer does not declare; a never-read value is
 *  `Unavailable`, never a fabricated default. */
function preferenceSummary(state: WebStartupPreferenceState | undefined, readiness: 'ready' | 'stale' | 'unavailable'): string {
  if (readiness === 'unavailable' || state === undefined) return 'Unavailable'
  const value = state.autoStart ? 'On' : state.userOverridden ? 'Off' : 'Off (default)'
  return readiness === 'ready' ? value : `${value} · last known`
}

/** The frozen user feedback of one Config write settlement. A verified write is
 *  a short `Saved`; a proven refusal keeps its reason; an accepted write the
 *  page cannot attribute is NEVER a failure claim. */
function configOutcomeNote(outcome: SettingsWorkspaceCommitOutcome): OutcomeNote {
  switch (outcome.outcome) {
    case 'verified': return { word: 'Saved', tone: 'success' }
    case 'not-saved': return { word: 'Could not save', tone: 'error', ...(outcome.reason === undefined ? {} : { detail: outcome.reason }) }
    case 'unverified':
    case 'indeterminate': {
      const recovery = 'The change may have been saved. Refresh and check.'
      return {
        word: 'Could not confirm save',
        tone: 'warning',
        detail: outcome.reason === undefined ? recovery : `${recovery} ${outcome.reason}`,
      }
    }
  }
}

/** A dispatched RUNTIME change whose settlement cannot be attributed. It is
 *  never a `Saved`/`Not saved` claim: the Host may have applied it. */
function unconfirmedChange(detail: string): OutcomeNote {
  return { word: 'Could not confirm change', tone: 'warning', detail: `${detail} Refresh and check.` }
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const line = truncateToWidth(text, Math.max(0, width), '…', false)
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

/** The ink of one status word, per design language §3.2 role 9. */
function statusInk(tone: 'success' | 'error' | 'warning' | 'muted', text: string): string {
  if (tone === 'success') return color.success(text)
  if (tone === 'error') return color.error(text)
  if (tone === 'warning') return color.warning(text)
  return color.textMuted(text)
}

/** Paint one already-sanitized value by its content role. */
function valueInk(ink: 'text' | 'dim' | 'error' | 'warning' | 'muted', text: string): string {
  if (ink === 'dim') return color.textDim(text)
  if (ink === 'error') return color.error(text)
  if (ink === 'warning') return color.warning(text)
  if (ink === 'muted') return color.textMuted(text)
  return color.text(text)
}

/**
 * The `Host · Web UI` page state machine. It paints and routes input only; the
 * two writers stay the command layer's existing owners.
 */
export class WebUiSettingsPage implements EmbeddedSpecialistPage {
  readonly title: string = WEB_UI_PAGE_TITLE
  private readonly intents: WebUiSettingsPageIntents
  private disposed = false
  private _focused = false
  private rowGrant = 8
  private phase: WebUiPagePhase
  private host: HostObservation
  private preference: WebStartupPreferenceState | undefined
  private preferenceReadiness: 'ready' | 'stale' | 'unavailable'
  private runtimeOutcome: OutcomeNote | undefined
  private configOutcome: OutcomeNote | undefined
  /** The staged next-launch candidate; presentation only, never a write. */
  private autostartCandidate: boolean | undefined
  /**
   * The revision the staged next-start choice was OPENED at. It is the decision
   * fence, never a parameter refreshed at commit time: a same-generation
   * external write that moved the revision refuses the old confirmation
   * instead of silently rebasing the CAS onto the newer revision.
   */
  private autostartFence: number | undefined
  /**
   * The opaque Config authority the staged choice was opened against — the
   * SAME observation that admitted the gesture. A replacement Host can expose
   * the same revision and value; only this object identity (never a string or
   * the Web runtime generation) proves the decision still addresses the
   * authority it was made under.
   */
  private autostartGeneration: object | undefined
  /** Monotonic serial of the last admitted Config observation. It changes on
   *  ANY identity/revision/value/readiness movement, so a frame painted under
   *  a silently replaced authority can never admit a gesture against the new
   *  one without a fresh frame. */
  private preferenceSerial = 0
  /** The observation serial the LAST painted frame published. */
  private paintedPreferenceSerial = -1
  private selectedId: string | undefined
  private scrollOffset = 0
  private revealSelection = true
  private revision = 0
  private readSerial = 0
  /** The identity of the ONE admitted write; a superseded settlement paints
   *  nothing. */
  private writeSerial = 0
  private awaitingPaint = true
  private paint: PagePaint | undefined
  /** The actions whose COMPLETE span the last painted frame really published:
   *  the keyboard reads exactly this set, like the pointer does. */
  private paintedActions = new Set<string>()
  private pressed: { readonly paint: PagePaint; readonly target: PagePaint['targets'][number] } | undefined
  private escapeSpan: { readonly startCol: number; readonly endCol: number } | undefined
  private barSpans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[] = []
  private readonly unsubscribe: () => void

  constructor(intents: WebUiSettingsPageIntents) {
    this.intents = intents
    this.preferenceReadiness = intents.configReadiness()
    this.preference = intents.readPreference()
    if (intents.backendKind === 'direct') {
      // The Direct process owns no Split Host Web frontend: state the real
      // missing capability and never read a fake Host.
      this.host = { kind: 'split-host-only' }
      this.phase = 'ready'
    } else {
      this.host = { kind: 'checking' }
      this.phase = 'loading'
    }
    this.unsubscribe = intents.subscribeGeneration(() => { this.onGenerationChanged() })
    if (this.host.kind === 'checking') this.startStatusRead()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    if (value === this._focused) return
    this._focused = value
    // Focus is part of the pointer/gesture identity: a press armed while the
    // page held the keyboard must not survive losing it.
    this.revoke()
  }

  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.rowGrant) return
    this.rowGrant = next
    this.revealSelection = true
    this.revoke()
  }

  grantAwaitingPaint(): boolean { return this.awaitingPaint }
  pointerFrameCurrent(): boolean {
    return !this.awaitingPaint && this.paint !== undefined && this.paint.identity === this.gestureIdentity()
  }
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined { return this.escapeSpan }
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] {
    return this.barSpans
  }
  invalidate(): void {}

  /**
   * The ONE user parent-leave query of the Detail tenant. The two authorities
   * are independent and asynchronous, so a clean browse (or a loaded page whose
   * read is still in flight) leaves immediately; a staged next-start choice, an
   * open confirmation and a dispatched pending write keep the page until the
   * user's own local Cancel/Back. It never navigates, writes or cancels an
   * already dispatched write.
   */
  requestParentLeave(_target: SpecialistParentLeaveTarget, _leave: () => void): 'allow' | 'refuse' {
    if (this.disposed) return 'refuse'
    return this.phase === 'ready' || this.phase === 'settled' || this.phase === 'loading' ? 'allow' : 'refuse'
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revoke()
    this.paint = undefined
    this.unsubscribe()
  }

  /** Any state change retires the last frame's pointer grant, its action
   *  admission and the pending press; the next real paint republishes them. */
  private revoke(): void {
    this.revision += 1
    this.awaitingPaint = true
    this.pressed = undefined
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedActions.clear()
  }
  private changed(): void {
    if (this.disposed) return
    this.revoke()
    this.intents.requestRender()
  }

  /** The pointer/gesture identity: phase + selection + staged candidate +
   *  observations + semantic revision. A release must re-prove the SAME value.
   *  The Config observation contributes its monotonic serial (the generation
   *  object is compared by identity elsewhere and never stringified), so a
   *  silent same-revision Host replacement revokes the previous frame's hit
   *  map and keyboard admission. */
  gestureIdentity(): string {
    const preference = this.preference === undefined
      ? 'none'
      : `${this.preferenceSerial}:${this.preference.revision}:${this.preference.autoStart}:${this.preferenceReadiness}:${this.preference.generation === undefined ? 'no-generation' : 'current'}`
    return `${this.phase}|${this.selectedId ?? ''}|${this.autostartCandidate === undefined ? '' : this.autostartCandidate ? 'on' : 'off'}|${this.host.kind}|${preference}|${this.revision}`
  }

  // ── observations ──────────────────────────────────────────────────────────

  /** ONE Host status read. The settlement is committed only while the LIVE
   *  Connection generation is still the one sampled before dispatch: a reply
   *  that belongs to a replaced Host is never painted as the current fact and
   *  never qualifies an action. */
  private startStatusRead(): void {
    if (this.disposed || this.host.kind === 'split-host-only') return
    const serial = ++this.readSerial
    const generation = this.intents.currentGeneration()
    this.intents.runOwned('web ui status read', async () => {
      let status: WebAccessStatus | undefined
      let failure: string | undefined
      try {
        status = await this.intents.readStatus()
      } catch (error) {
        failure = safeErrorMessage(error)
      }
      if (this.disposed || serial !== this.readSerial) return
      this.commitStatusRead(generation, status, failure)
    }, (error) => {
      if (this.disposed || serial !== this.readSerial) return
      this.commitStatusRead(generation, undefined, safeErrorMessage(error))
    })
  }

  private commitStatusRead(generation: unknown, status: WebAccessStatus | undefined, failure: string | undefined): void {
    const live = this.intents.currentGeneration()
    if (generation === undefined && live === undefined) {
      // The read was dispatched while the Client was DISCONNECTED and it still
      // is: there is no generation to compare, so this is NOT a superseded
      // reply — its own failure is the current fact. Settle to Unreadable with
      // a Refresh instead of an endless `Checking…`/`Reading…` frame; a real
      // reconnection still drives its own authoritative re-read through the
      // generation subscription.
      this.host = { kind: 'unreadable', message: failure ?? 'the Host connection is unavailable' }
      this.settleReadPhase()
      return
    }
    if (generation === undefined || !Object.is(generation, live)) {
      // The observation belongs to a Host that is no longer current. Revoke it
      // and let the generation subscription's own re-read speak for the new
      // Host (a settled stale read never re-arms an action).
      this.host = { kind: 'checking' }
      this.settleReadPhase()
      return
    }
    this.host = failure !== undefined || status === undefined
      ? { kind: 'unreadable', message: failure ?? 'the Host Web state could not be read' }
      : { kind: 'current', status, generation }
    this.settleReadPhase()
  }

  /** Every settled status read leaves the `loading` phase. A frame that waited
   *  for a reply must offer the honest state — or `Checking…` plus Refresh
   *  while a generation-driven re-read is pending — never an endless
   *  `Reading…`; a confirmation derived from a non-current observation is
   *  revoked here too. */
  private settleReadPhase(): void {
    if (this.phase === 'loading') this.phase = 'ready'
    if (this.phase === 'confirm-disable' && this.host.kind !== 'current') this.phase = 'ready'
    this.changed()
  }

  /** A Connection generation change revokes every Host-derived fact and action
   *  and re-reads the CURRENT Host. A dispatched runtime write keeps settling
   *  in its own owner; its UI presentation is retired as unconfirmed here. */
  private onGenerationChanged(): void {
    if (this.disposed || this.host.kind === 'split-host-only') return
    this.readSerial += 1
    this.host = { kind: 'checking' }
    // Every ACTUAL rollover retires a local staged preference intent, even
    // when the new Config mirror happens to expose the SAME revision: the
    // decision was made against the old Host's authority. A dispatched write
    // (`pending-*`) is never cancelled or replayed here — its own owner settles
    // and diagnoses it.
    this.retireStagedChoice()
    if (this.phase === 'pending-runtime') {
      // The request belonged to the replaced Host: retire this page's right to
      // paint its result (its owner still settles and diagnoses) and state the
      // only honest outcome.
      this.writeSerial += 1
      this.runtimeOutcome = unconfirmedChange('The Host changed while the request was running.')
      this.phase = 'ready'
    } else if (this.phase === 'confirm-disable' || this.phase === 'loading' || this.phase === 'settled') {
      this.phase = 'ready'
    }
    // The SAME rollover invalidates the Remote Config mirror: re-read the
    // next-start preference from the live authority and revoke a staged step
    // whose authority is no longer current.
    this.reconcilePreference()
    this.changed()
    this.startStatusRead()
  }

  /** Drop a not-yet-dispatched next-start intent (phase and decision fence). */
  private retireStagedChoice(): void {
    this.autostartCandidate = undefined
    this.autostartFence = undefined
    this.autostartGeneration = undefined
    if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') this.phase = 'ready'
  }

  /**
   * ONE live observation of the persisted next-start preference and its Config
   * authority (never a Host Web read). The readiness preference, the value and
   * the opaque Host generation are captured TOGETHER and every
   * projection/admission of this observation derives from the SAME tuple — the
   * page never reads the authority twice in one decision, so a painted
   * `Unavailable` fact can never sit beside an editable row (or a stale
   * revision/generation beside an edit grant).
   *
   * The Remote Config mirror invalidates on the same Connection generation
   * rollover the page observes. When the captured authority is not current the
   * staged preference step is revoked here (zero writes) and the painted fact
   * degrades to `Unavailable`/`last known` from THIS observation. A REPLACED
   * authority retires a staged decision even when it exposes the same revision
   * and value.
   */
  private reconcilePreference(): void {
    const readiness = this.intents.configReadiness()
    const next = this.intents.readPreference()
    const previous = this.preference
    if (
      this.preferenceReadiness !== readiness
      || previous === undefined !== (next === undefined)
      || (previous !== undefined && next !== undefined
        && (previous.autoStart !== next.autoStart
          || previous.revision !== next.revision
          || !Object.is(previous.generation, next.generation)))
    ) {
      this.preferenceSerial += 1
    }
    this.preferenceReadiness = readiness
    this.preference = next
    // A staged decision whose captured Host authority was replaced (same
    // revision/value or not) is no longer this page's intent.
    if (this.autostartGeneration !== undefined
      && (next === undefined || next.generation === undefined || !Object.is(next.generation, this.autostartGeneration))) {
      this.retireStagedChoice()
    }
    if (!this.preferenceEditable()) {
      // The authority is no longer current: revoke the staged step, zero writes.
      this.autostartCandidate = undefined
      this.autostartFence = undefined
      this.autostartGeneration = undefined
      if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') {
        this.phase = 'ready'
        this.revealSelection = true
      }
      return
    }
  }

  /** The staged next-start choice lost its decision fence: settle it visibly
   *  without writing and let the user review the CURRENT value. */
  private settleStaleAutostartChoice(): void {
    this.autostartCandidate = undefined
    this.autostartFence = undefined
    this.autostartGeneration = undefined
    if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') {
      this.phase = 'settled'
      this.revealSelection = true
    }
    this.configOutcome = {
      word: 'Could not save',
      tone: 'error',
      detail: 'the configuration changed since this choice was opened; review the new value and confirm again',
    }
  }

  /** Whether the OBSERVATION captured by the current projection/admission may
   *  be edited: the authority must be `ready` and must expose both a revision
   *  and a CURRENT Host authority generation. Every caller reconciles first
   *  (projection, generation change, refresh, action, write admission), so this
   *  never re-reads the authority. */
  private preferenceEditable(): boolean {
    return this.preferenceReadiness === 'ready'
      && this.preference !== undefined
      && this.preference.generation !== undefined
  }

  private hostCurrent(): { readonly status: WebAccessStatus; readonly generation: unknown } | undefined {
    return this.host.kind === 'current' ? this.host : undefined
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private move(delta: number): void {
    const rows = this.rowSpecs()
    if (rows.length === 0) return
    const current = rows.findIndex(row => row.id === this.selectedId)
    const index = current < 0 ? 0 : (current + delta + rows.length) % rows.length
    this.selectedId = rows[index]!.id
    this.revealSelection = true
    this.changed()
  }

  private scroll(delta: number): void {
    const max = this.paint?.maxOffset ?? 0
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset + delta), max)
    this.revealSelection = false
    this.changed()
  }

  /** The keyboard's ONE Enter sink: only an action whose complete span the LAST
   *  painted frame really published may run. */
  private activateSelected(): void {
    const id = this.selectedId
    if (id !== undefined) this.activateRow(id)
  }

  private activateRow(id: string): void {
    if (this.disposed) return
    // The ONE semantic admission shared by the body span, the bar span and the
    // keyboard: a row that is not completely painted/actionable right now can
    // never write or open a confirmation.
    if (!this.paintedActions.has(id)) return
    // An action is admitted against a CURRENT Config observation, never against
    // the projection a previous frame captured.
    this.reconcilePreference()
    // The painted `Change…` belonged to the observation THAT frame drew. A
    // silent replacement (same revision/value) or any observed movement since
    // then must not re-bind the old gesture to the new authority: the stale
    // affordance is revoked and the next frame requires a fresh gesture.
    if (id === 'autostart' && this.paintedPreferenceSerial !== this.preferenceSerial) {
      this.changed()
      return
    }
    switch (id) {
      case 'open': this.openBrowser(); return
      case 'copy': this.copyLink(); return
      case 'enable': this.dispatchRuntime(true); return
      case 'disable':
        this.phase = 'confirm-disable'
        this.selectedId = 'confirm-disable'
        this.revealSelection = true
        this.changed()
        return
      case 'refresh': this.refreshAll(); return
      case 'autostart':
        if (!this.preferenceEditable() || this.preference === undefined || this.preference.generation === undefined) return
        // Stage the OPPOSITE of the persisted value: the row was activated to
        // change it, and the current candidate stays visible (marked below).
        // The revision and the SAME observation's Host generation are captured
        // HERE, at choice entry, and travel with the staged decision.
        this.phase = 'choose-autostart'
        this.autostartFence = this.preference.revision
        this.autostartGeneration = this.preference.generation
        this.autostartCandidate = this.preference.autoStart ? false : true
        this.selectedId = this.candidateId(this.autostartCandidate)
        this.revealSelection = true
        this.changed()
        return
      case 'candidate-on': this.stageCandidate(true); return
      case 'candidate-off': this.stageCandidate(false); return
      case 'confirm-disable': this.dispatchRuntime(false); return
      case 'confirm-save': this.dispatchConfig(); return
      case 'cancel': this.cancelPhase(); return
      default: return
    }
  }

  private candidateId(candidate: boolean): string {
    return candidate ? 'candidate-on' : 'candidate-off'
  }

  private stageCandidate(candidate: boolean): void {
    if (!this.preferenceEditable()) return
    this.autostartCandidate = candidate
    this.phase = 'confirm-save'
    this.selectedId = 'confirm-save'
    this.revealSelection = true
    this.changed()
  }

  /** The page's Esc ladder: a confirmation is cancelled before the page is
   *  left, and a staged candidate is dropped without a write. A dispatched
   *  write is NEVER cancelled: leaving only retires this page's paint right. */
  private cancelPhase(): void {
    switch (this.phase) {
      case 'confirm-disable':
        this.phase = 'ready'
        this.selectedId = 'disable'
        this.changed()
        return
      case 'confirm-save':
        this.phase = 'choose-autostart'
        this.selectedId = this.autostartCandidate === undefined ? 'candidate-on' : this.candidateId(this.autostartCandidate)
        this.changed()
        return
      case 'choose-autostart':
        this.autostartCandidate = undefined
        this.autostartFence = undefined
        this.autostartGeneration = undefined
        this.phase = 'ready'
        this.selectedId = 'autostart'
        this.changed()
        return
      default:
        // `pending-*`: the write keeps settling in its owner; only this page's
        // right to paint the result is revoked (the root disposes it).
        this.intents.done()
    }
  }

  private openBrowser(): void {
    const host = this.hostCurrent()
    if (host === undefined || host.status.state !== 'enabled') return
    const generation = host.generation
    this.runtimeOutcome = undefined
    this.intents.runOwned('web ui open browser', async () => {
      let url: string
      try {
        url = (await this.intents.getAuthenticatedUrl(generation)).url
      } catch {
        // The request may carry the launch URL/error text: it is converted to
        // the fixed no-secret fact HERE, before the owned-task diagnostic or
        // any painted cell can observe it.
        this.reportLinkFailure('open')
        return
      }
      if (this.disposed) return
      // The URL belongs to the Host that produced it: a replacement between the
      // reply and the sink revokes it BEFORE it can reach the Client opener.
      if (!Object.is(generation, this.intents.currentGeneration())) {
        this.refuseReplacedLink('open', generation)
        return
      }
      // The Client-local opener is the ONLY consumer of the launch URL: it is
      // never painted, stored or logged. Success only claims the request, and
      // only when an opener really exists.
      let requested: boolean
      try {
        requested = this.intents.openUrl(url)
      } catch {
        this.reportLinkFailure('open')
        return
      }
      this.runtimeOutcome = requested
        ? { word: 'Browser open requested', tone: 'muted' }
        : { word: 'Browser opener unavailable', tone: 'error' }
      this.changed()
    }, () => { this.reportLinkFailure('open') })
  }

  private copyLink(): void {
    const host = this.hostCurrent()
    if (host === undefined || host.status.state !== 'enabled') return
    const generation = host.generation
    this.runtimeOutcome = undefined
    this.intents.runOwned('web ui copy link', async () => {
      let url: string
      try {
        url = (await this.intents.getAuthenticatedUrl(generation)).url
      } catch {
        this.reportLinkFailure('copy')
        return
      }
      if (this.disposed) return
      // Same sink fence as Open: an old Host's token never reaches the
      // clipboard of the replacement Host's session.
      if (!Object.is(generation, this.intents.currentGeneration())) {
        this.refuseReplacedLink('copy', generation)
        return
      }
      let copied: boolean
      try {
        copied = await this.intents.copyToClipboard(url)
      } catch {
        this.reportLinkFailure('copy')
        return
      }
      if (this.disposed) return
      this.runtimeOutcome = copied
        ? { word: 'Link copied', tone: 'muted' }
        : { word: 'Clipboard unavailable', tone: 'error' }
      this.changed()
    }, () => { this.reportLinkFailure('copy') })
  }

  /** The ONE credential-safe failure projection: the fixed word + fixed
   *  reason. The original error, its cause and the URL never reach the UI or
   *  the owned-task diagnostic. */
  private reportLinkFailure(kind: 'open' | 'copy'): void {
    if (this.disposed) return
    this.runtimeOutcome = {
      word: kind === 'open' ? 'Open failed' : 'Clipboard unavailable',
      tone: 'error',
      detail: LINK_FAILURE_REASON,
    }
    this.changed()
  }

  /** An official URL produced by a REPLACED Host is dropped, never handed to
   *  the Client opener/clipboard. The generation subscription has ALREADY
   *  revoked the observation and started the ONE re-read, so this only paints
   *  the cancelled hand-off; only a source that never notified leaves the old
   *  observation in place, and that one is revoked here. */
  private refuseReplacedLink(kind: 'open' | 'copy', generation: unknown): void {
    if (this.host.kind === 'current' && Object.is(this.host.generation, generation)) {
      this.readSerial += 1
      this.host = { kind: 'checking' }
      this.startStatusRead()
    }
    this.runtimeOutcome = {
      word: kind === 'open' ? 'Open failed' : 'Clipboard unavailable',
      tone: 'error',
      detail: 'the Host changed before the link was handed over',
    }
    this.changed()
  }

  /** Re-read the eligible authorities. It never writes and never enables a
   *  confirm. */
  private refreshAll(): void {
    if (this.phase !== 'ready' && this.phase !== 'settled') return
    this.reconcilePreference()
    if (this.host.kind !== 'split-host-only') {
      this.host = { kind: 'checking' }
      this.changed()
      this.startStatusRead()
      return
    }
    this.changed()
  }

  /**
   * ONE runtime toggle. The action is qualified by the generation the CURRENT
   * status was read under: a replaced Host receives no request at all, and a
   * request that MAY have been applied is painted `Could not confirm change` — it
   * is never retried and never attributed from the fresh read.
   */
  private dispatchRuntime(target: boolean): void {
    const host = this.hostCurrent()
    if (host === undefined) return
    if (host.status.state !== 'enabled' && host.status.state !== 'disabled') return
    const generation = host.generation
    if (!Object.is(generation, this.intents.currentGeneration())) {
      // Zero Host dispatch: the observation that produced the user's action is
      // no longer the current Host.
      this.runtimeOutcome = { word: 'Not changed', tone: 'muted', detail: 'the Host changed before the request was sent' }
      this.host = { kind: 'checking' }
      this.phase = 'ready'
      this.changed()
      this.startStatusRead()
      return
    }
    const serial = ++this.writeSerial
    this.phase = 'pending-runtime'
    this.runtimeOutcome = undefined
    this.selectedId = undefined
    this.changed()
    this.intents.runOwned(target ? 'web ui enable' : 'web ui disable', async () => {
      let failure: string | undefined
      try {
        await this.intents.setEnabled(target, generation)
      } catch (error) {
        failure = safeErrorMessage(error)
      }
      const sameGeneration = Object.is(generation, this.intents.currentGeneration())
      // ONE read-only re-check: it refreshes the visible fact but NEVER
      // attributes this request's outcome.
      let status: WebAccessStatus | undefined
      let readFailure: string | undefined
      try {
        status = await this.intents.readStatus()
      } catch (error) {
        readFailure = safeErrorMessage(error)
      }
      const stillCurrent = sameGeneration && Object.is(generation, this.intents.currentGeneration())
      if (this.disposed || serial !== this.writeSerial) {
        // The page that started the write is gone: the WRITE OWNER still
        // records the real outcome so a dispatched write is never silently
        // lost (no notice/overlay may be revived).
        this.intents.diagnose('web ui runtime write', {
          target,
          dispatched: failure === undefined,
          ...(failure === undefined ? {} : { failure }),
          settled: stillCurrent ? (status?.state ?? 'unknown') : 'host-changed',
          ...(readFailure === undefined ? {} : { readFailure }),
        })
        return
      }
      this.commitRuntimeSettlement(target, generation, failure, status, readFailure, stillCurrent)
    }, (error) => {
      if (this.disposed || serial !== this.writeSerial) return
      this.runtimeOutcome = unconfirmedChange(safeErrorMessage(error))
      this.phase = 'ready'
      this.revealSelection = true
      this.changed()
      this.startStatusRead()
    })
  }

  private commitRuntimeSettlement(
    target: boolean,
    generation: unknown,
    failure: string | undefined,
    status: WebAccessStatus | undefined,
    readFailure: string | undefined,
    stillCurrent: boolean,
  ): void {
    if (!stillCurrent) {
      this.host = { kind: 'checking' }
      this.runtimeOutcome = unconfirmedChange('The Host changed while the request was running; its outcome cannot be attributed.')
      this.phase = 'ready'
      this.startStatusRead()
      this.changed()
      return
    }
    if (status === undefined) {
      this.host = { kind: 'unreadable', message: readFailure ?? 'the Host Web state could not be re-read' }
      this.runtimeOutcome = failure === undefined
        ? unconfirmedChange('The request was sent, but the Host state could not be re-read.')
        : unconfirmedChange(`${failure}; the Host state could not be re-read either.`)
    } else {
      this.host = { kind: 'current', status, generation }
      if (failure !== undefined) {
        // A thrown request may still have been applied by the Host. The fresh
        // read refreshes the fact; it never proves this request's outcome.
        this.runtimeOutcome = unconfirmedChange(`${failure}; the Host may have applied the request.`)
      } else if (status.state === (target ? 'enabled' : 'disabled')) {
        this.runtimeOutcome = { word: target ? 'Web enabled' : 'Web disabled', tone: 'success' }
      } else if (status.state === 'changing') {
        this.runtimeOutcome = unconfirmedChange('The Host is still applying the change.')
      } else {
        this.runtimeOutcome = {
          word: 'Requested state not reached',
          tone: 'warning',
          detail: `the request reported success, but the Host reads ${servingWord(status).text.replace(/…$/u, '')}`,
        }
      }
    }
    this.phase = 'ready'
    this.revealSelection = true
    this.changed()
  }

  /**
   * The ONE next-launch preference write: the EXISTING revision-checked
   * `web-autostart` writer, after an explicit second confirmation. It never
   * calls the runtime toggle and never guesses a default.
   */
  private dispatchConfig(): void {
    // Admit the write against the LIVE Config authority, never the cached
    // projection the confirmation was staged from.
    this.reconcilePreference()
    const candidate = this.autostartCandidate
    const state = this.preference
    const fence = this.autostartFence
    const generation = this.autostartGeneration
    if (candidate === undefined || state === undefined || fence === undefined || generation === undefined
      || !this.preferenceEditable()) return
    // The captured revision AND the captured Host generation are the ONE
    // decision fence this confirmation may submit. A moved revision OR a
    // replaced authority (even with the same revision/value) refuses the stale
    // confirmation instead of CAS-rebasing it onto the new Host.
    if (state.revision !== fence || state.generation === undefined || !Object.is(state.generation, generation)) {
      this.settleStaleAutostartChoice()
      this.changed()
      return
    }
    const revision = fence
    const serial = ++this.writeSerial
    this.phase = 'pending-config'
    this.configOutcome = undefined
    this.selectedId = undefined
    this.changed()
    this.intents.runOwned('web ui next launch preference', async () => {
      const outcome = await this.intents.commitAutostart(candidate ? 'On' : 'Off', revision, generation)
      if (this.disposed || serial !== this.writeSerial) {
        this.intents.diagnose('web ui preference write', {
          value: candidate ? 'On' : 'Off',
          revision,
          outcome: outcome.outcome,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        })
        return
      }
      // The persisted fact is re-read from the SAME authority the writer
      // verified; the settlement is never applied optimistically.
      this.reconcilePreference()
      this.configOutcome = configOutcomeNote(outcome)
      this.autostartCandidate = undefined
      this.autostartFence = undefined
      this.phase = 'settled'
      this.revealSelection = true
      this.changed()
    }, (error) => {
      if (this.disposed || serial !== this.writeSerial) return
      this.reconcilePreference()
      this.configOutcome = configOutcomeNote({ outcome: 'indeterminate', reason: safeErrorMessage(error) })
      this.autostartCandidate = undefined
      this.autostartFence = undefined
      this.phase = 'settled'
      this.revealSelection = true
      this.changed()
    })
  }

  // ── input ─────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    // Every real key starts a new semantic frame: a bar press that began before
    // it can never complete against the state this key changes.
    this.revision += 1
    this.pressed = undefined
    if (matchesKey(data, 'escape')) { this.cancelPhase(); return }
    if (this.phase === 'pending-runtime' || this.phase === 'pending-config') return
    if (data === REFRESH_KEY || data === REFRESH_KEY.toUpperCase()) {
      // The refresh shortcut has the SAME admission as its painted row: a row
      // the current grant does not paint publishes no action at all.
      if (this.paintedActions.has('refresh')) this.refreshAll()
      return
    }
    if (matchesKey(data, 'up')) { this.move(-1); return }
    if (matchesKey(data, 'down')) { this.move(1); return }
    if (matchesKey(data, 'pageUp')) { this.scroll(-Math.max(1, this.bodyRows() - 2)); return }
    if (matchesKey(data, 'pageDown')) { this.scroll(Math.max(1, this.bodyRows() - 2)); return }
    if (matchesKey(data, 'home')) { this.scroll(-Number.MAX_SAFE_INTEGER); return }
    if (matchesKey(data, 'end')) { this.scroll(Number.MAX_SAFE_INTEGER); return }
    if (matchesKey(data, 'enter')) { this.activateSelected(); return }
    // Everything else is inert inside this page: no key leaks to the hidden
    // editor, the transcript or a Host composer action.
  }

  /** Invoke one delegated Action Bar intent. The id came from the LAST painted
   *  frame; the live page re-proves the semantic admission before the SAME
   *  keyboard sink. */
  activateBarSpan(id: string): void {
    if (this.disposed || this.awaitingPaint) return
    if (this.paint !== undefined && this.paint.identity !== this.gestureIdentity()) return
    const span = this.barSpans.find(candidate => candidate.id === id)
    if (span === undefined) return
    switch (span.action) {
      case 'refresh': if (this.paintedActions.has('refresh')) this.refreshAll(); return
      case 'select': this.activateSelected(); return
      case 'confirm':
        // The bar's confirm names the PHASE's own confirmation, never whichever
        // row the cursor happens to rest on: the Cancel row is a sibling and
        // never advertises an Enter confirm.
        if (this.phase === 'confirm-disable') {
          if (this.paintedActions.has('confirm-disable')) this.dispatchRuntime(false)
        } else if (this.phase === 'confirm-save') {
          if (this.paintedActions.has('confirm-save')) this.dispatchConfig()
        }
        return
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const pressed = this.pressed
    // Only a NEW press or a wheel retires the previous gesture. A release may
    // arrive through more than one screen event around a Root body grant.
    if (event.type === 'press' || event.type === 'wheel') this.pressed = undefined
    const paint = this.paint
    const sizeOnlyDuplicate = event.type === 'click' && paint !== undefined
      && event.width === paint.width && event.height !== paint.rows && event.height !== paint.rows - 1
    if (this.disposed || this.awaitingPaint || paint === undefined || paint.identity !== this.gestureIdentity()
      || event.width !== paint.width || (event.height !== paint.rows && event.height !== paint.rows - 1)
      || event.y < 0 || event.y >= paint.rows - 1) {
      if (event.type === 'click' && !sizeOnlyDuplicate) this.pressed = undefined
      return undefined
    }
    if (event.type === 'wheel') {
      if (event.y < paint.scrollStart || event.y >= paint.scrollEnd || !event.wheelDelta) return undefined
      this.scroll(event.wheelDelta < 0 ? -1 : 1)
      return { handled: true }
    }
    // A complete ACTION span wins over the row's select-only surface: blank and
    // padding cells can only move the cursor, never write.
    const target = paint.targets.find(candidate => candidate.kind === 'action'
      && candidate.row === event.y && event.x >= candidate.startCol && event.x < candidate.endCol)
      ?? paint.targets.find(candidate => candidate.kind === 'select'
        && candidate.row === event.y && event.x >= candidate.startCol && event.x < candidate.endCol)
    if (target === undefined || event.button !== 'left') {
      if (event.type === 'click') this.pressed = undefined
      return undefined
    }
    if (event.type === 'press') {
      this.pressed = { paint, target }
      return { handled: true }
    }
    if (event.type !== 'click' || pressed === undefined
      || pressed.paint.identity !== paint.identity || pressed.paint.width !== paint.width || pressed.paint.rows !== paint.rows
      || pressed.target.kind !== target.kind || pressed.target.id !== target.id || pressed.target.row !== target.row
      || pressed.target.startCol !== target.startCol || pressed.target.endCol !== target.endCol) {
      if (event.type === 'click') this.pressed = undefined
      return undefined
    }
    this.pressed = undefined
    // A click always SELECTS the row it landed on first (the visible cursor
    // must match what the pointer acts on); only a complete action span runs
    // the row's explicit intent.
    this.selectedId = target.id
    this.revealSelection = true
    this.revision += 1
    if (target.kind === 'action') this.activateRow(target.id)
    this.intents.requestRender()
    return { handled: true }
  }

  // ── projection ────────────────────────────────────────────────────────────

  private bodyRows(): number {
    return Math.max(0, this.rowGrant - 1)
  }

  /** The focusable rows the current phase paints, in keyboard order. */
  private rowSpecs(): readonly RowSpec[] {
    switch (this.phase) {
      case 'loading':
      case 'pending-runtime':
      case 'pending-config':
        return []
      case 'confirm-disable':
        return [
          { id: 'confirm-disable', kind: 'action', label: 'Disable Web' },
          { id: 'cancel', kind: 'action', label: 'Cancel' },
        ]
      case 'choose-autostart':
        return [
          { id: 'candidate-on', kind: 'action', label: 'On', ...(this.preference?.autoStart === true ? { chip: '[current]' } : {}) },
          { id: 'candidate-off', kind: 'action', label: 'Off', ...(this.preference?.autoStart === false ? { chip: '[current]' } : {}) },
        ]
      case 'confirm-save':
        return [
          { id: 'confirm-save', kind: 'action', label: 'Confirm save' },
          { id: 'cancel', kind: 'action', label: 'Cancel' },
        ]
      case 'ready':
      case 'settled':
        break
    }
    const rows: RowSpec[] = []
    const host = this.hostCurrent()
    if (host !== undefined) {
      switch (host.status.state) {
        case 'enabled':
          rows.push(
            { id: 'open', kind: 'action', label: 'Open in browser' },
            { id: 'copy', kind: 'action', label: 'Copy access link', value: 'Contains a sign-in token', valueInk: 'dim' },
            { id: 'disable', kind: 'action', label: 'Disable Web…', value: 'Stops serving; does not revoke access', valueInk: 'dim' },
          )
          break
        case 'disabled':
          rows.push({ id: 'enable', kind: 'action', label: 'Enable Web' })
          break
        case 'changing':
        case 'unavailable':
          rows.push({ id: 'refresh', kind: 'action', label: 'Refresh' })
          break
      }
    } else {
      // checking / unreadable / split-host-only: no Host action exists.
      rows.push({ id: 'refresh', kind: 'action', label: 'Refresh' })
    }
    // A normal enabled/disabled Host still needs the page's explicit Refresh:
    // the live listener can change under a same-generation external writer, and
    // `r`/the bar must not become a hidden no-op. The row is the SAME existing
    // `refreshAll` action and the SAME painted admission as every other verb;
    // the changing/unavailable/Direct projections already publish exactly one.
    if (!rows.some(row => row.id === 'refresh')) {
      rows.push({ id: 'refresh', kind: 'action', label: 'Refresh' })
    }
    if (this.preferenceEditable()) {
      rows.push({
        id: 'autostart',
        kind: 'field',
        label: 'Start automatically',
        value: preferenceSummary(this.preference, this.preferenceReadiness),
        valueInk: 'text',
        affordance: 'Change…',
      })
    }
    return rows
  }

  /** The first focus the page should land on for the CURRENT observations: the
   *  primary Host action, else the editable next-start preference, else
   *  Refresh. */
  private firstFocusId(): string | undefined {
    const rows = this.rowSpecs()
    const host = this.hostCurrent()
    const preferred = host === undefined
      ? undefined
      : host.status.state === 'enabled' ? 'open' : host.status.state === 'disabled' ? 'enable' : undefined
    if (preferred !== undefined && rows.some(row => row.id === preferred)) return preferred
    if (rows.some(row => row.id === 'autostart')) return 'autostart'
    return rows[0]?.id
  }

  private ensureSelection(): void {
    const rows = this.rowSpecs()
    if (this.selectedId !== undefined && rows.some(row => row.id === this.selectedId)) return
    const next = this.firstFocusId()
    if (next !== this.selectedId) this.revealSelection = true
    this.selectedId = next
  }

  /** One section heading (role 2/5). */
  private header(label: string): ContentLine {
    return { text: color.textDim(label) }
  }

  /** A diagnostic/risk/question sentence, wrapped to the pane width and painted
   *  whole. Every physical line becomes a `copy` group member when asked. */
  private wrapped(text: string, ink: 'text' | 'dim' | 'error' | 'warning', width: number, group?: 'copy'): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(line => ({
      text: valueInk(ink, line),
      ...(group === undefined ? {} : { group }),
    }))
  }

  /** One `Label   value` fact. A value that does not fit the real cells is
   *  WRAPPED (never truncated into a different writable-looking value): the
   *  complete label and the complete value are always preserved. */
  private factLines(label: string, paintedValue: string, width: number): ContentLine[] {
    const indentCells = INDENT.length
    const labelRoom = Math.max(1, Math.min(LABEL_COLUMN, width - indentCells - 1))
    const labelCells = visibleWidth(label)
    if (labelCells > labelRoom) {
      // The identity does not fit its column: paint it complete on its own
      // line(s), then the value below.
      const lines: ContentLine[] = wrapTextWithAnsi(color.textDim(sanitizedPhysicalLine(label)), Math.max(1, width))
        .map(text => ({ text }))
      for (const line of wrapTextWithAnsi(paintedValue, Math.max(1, width - indentCells))) {
        lines.push({ text: `${INDENT}${line}` })
      }
      return lines
    }
    const valueRoom = width - indentCells - labelRoom - 1
    const labelPad = ' '.repeat(labelRoom - labelCells)
    const paintedLabel = `${INDENT}${color.textDim(label)}${labelPad} `
    if (valueRoom >= 1) {
      const valueLines = wrapTextWithAnsi(paintedValue, valueRoom)
      const lines: ContentLine[] = [{ text: `${paintedLabel}${valueLines[0] ?? ''}` }]
      const contPrefix = ' '.repeat(indentCells + labelRoom + 1)
      for (const line of valueLines.slice(1)) lines.push({ text: `${contPrefix}${line}` })
      return lines
    }
    const lines: ContentLine[] = [{ text: `${INDENT}${color.textDim(label)}` }]
    for (const line of wrapTextWithAnsi(paintedValue, Math.max(1, width - indentCells))) {
      lines.push({ text: `${INDENT}${line}` })
    }
    return lines
  }

  /** One focusable row: cursor + complete verb + optional wrapped value +
   *  complete affordance/chip. Publishing is all-or-nothing per segment. */
  private entryLines(row: RowSpec, width: number): ContentLine[] {
    const selected = this.selectedId === row.id
    const markerCells = 2
    const marker = selected ? color.primary('> ') : '  '
    const verb = sanitizedPhysicalLine(row.label)
    const verbCells = visibleWidth(verb)
    // A partial verb is never painted: the row is simply absent from this
    // frame (and therefore from the keyboard admission too).
    if (markerCells + verbCells > width) return []
    const labelRoom = Math.max(verbCells, Math.min(LABEL_COLUMN, Math.max(1, width - markerCells - 1)))
    const padToLabel = ' '.repeat(labelRoom - verbCells)
    const paintedLabel = selected ? color.textStrong(verb) : color.text(verb)
    const chipText = row.chip === undefined ? '' : `  ${row.chip}`
    const chipCells = visibleWidth(chipText)
    const paintedValue = row.value === undefined ? '' : valueInk(row.valueInk ?? 'text', sanitizedPhysicalLine(row.value))
    const valueCells = row.value === undefined ? 0 : visibleWidth(row.value)
    const affordance = row.affordance === undefined ? '' : row.affordance
    const affordanceCells = visibleWidth(affordance)
    const selectTarget = (): BodyTarget => ({ kind: 'select', id: row.id, startCol: 0, endCol: width })
    const verbActionStart = markerCells
    const verbActionEnd = markerCells + verbCells

    if (row.value === undefined) {
      // Business verb / candidate row: the complete label (+ whole chip) is
      // the action span.
      if (markerCells + verbCells + chipCells > width) {
        if (chipCells > 0) {
          const line = `${marker}${paintedLabel}`
          return [{ text: line, rowId: row.id, targets: [selectTarget(), { kind: 'action', id: row.id, startCol: verbActionStart, endCol: verbActionEnd }] }]
        }
        return []
      }
      const chipPainted = chipCells === 0 ? '' : color.textMuted(chipText)
      return [{
        text: `${marker}${paintedLabel}${chipPainted}`,
        rowId: row.id,
        targets: [selectTarget(), { kind: 'action', id: row.id, startCol: verbActionStart, endCol: verbActionEnd + chipCells }],
      }]
    }

    const valueRoom = width - markerCells - labelRoom - 1
    const singleValueCells = markerCells + labelRoom + 1 + valueCells
    const affordanceSuffixCells = affordanceCells === 0 ? 0 : 3 + affordanceCells
    // 1. The whole row (verb + value + ` · Change…`) on ONE line.
    if (valueRoom >= 1 && singleValueCells + affordanceSuffixCells <= width) {
      const affordanceStart = singleValueCells + 3
      const actionTarget: BodyTarget | undefined = affordanceCells === 0
        ? { kind: 'action', id: row.id, startCol: verbActionStart, endCol: verbActionEnd }
        : { kind: 'action', id: row.id, startCol: affordanceStart, endCol: affordanceStart + affordanceCells }
      return [{
        text: `${marker}${paintedLabel}${padToLabel} ${paintedValue}${affordanceCells === 0 ? '' : ` · ${color.primary(affordance)}`}`,
        rowId: row.id,
        targets: actionTarget === undefined ? [selectTarget()] : [selectTarget(), actionTarget],
      }]
    }
    // 2. The verb + value on ONE line, the explicit affordance on its own
    //    continuation line (a complete verb never changes meaning).
    if (valueRoom >= 1 && singleValueCells <= width) {
      const lines: ContentLine[] = [{
        text: `${marker}${paintedLabel}${padToLabel} ${paintedValue}`,
        rowId: row.id,
        targets: [selectTarget(), ...(affordanceCells === 0
          ? [{ kind: 'action', id: row.id, startCol: verbActionStart, endCol: verbActionEnd } satisfies BodyTarget]
          : [])],
      }]
      if (affordanceCells > 0) {
        if (INDENT.length + affordanceCells > width) return lines
        lines.push({
          text: `${INDENT}${color.primary(affordance)}`,
          rowId: row.id,
          targets: [selectTarget(), { kind: 'action', id: row.id, startCol: INDENT.length, endCol: INDENT.length + affordanceCells }],
        })
      }
      return lines
    }
    // 3. The value itself must wrap below the complete verb. Only the FIRST
    //    line carries the verb's action span; continuation cells never publish
    //    an action at the verb's old columns.
    const lines: ContentLine[] = [{
      text: `${marker}${paintedLabel}`,
      rowId: row.id,
      targets: [selectTarget(), ...(affordanceCells === 0
        ? [{ kind: 'action', id: row.id, startCol: verbActionStart, endCol: verbActionEnd } satisfies BodyTarget]
        : [])],
    }]
    const valueLines = wrapTextWithAnsi(paintedValue, Math.max(1, width - INDENT.length))
    for (const [index, line] of valueLines.entries()) {
      const isLast = index === valueLines.length - 1
      const paintedLine = `${INDENT}${line}`
      const canJoinAffordance = isLast && affordanceCells > 0
        && visibleWidth(paintedLine) + 3 + affordanceCells <= width
      if (canJoinAffordance) {
        const affordanceStart = visibleWidth(paintedLine) + 3
        lines.push({
          text: `${paintedLine} · ${color.primary(affordance)}`,
          rowId: row.id,
          targets: [selectTarget(), { kind: 'action', id: row.id, startCol: affordanceStart, endCol: affordanceStart + affordanceCells }],
        })
      } else {
        lines.push({ text: paintedLine, rowId: row.id, targets: [selectTarget()] })
      }
    }
    if (affordanceCells > 0 && !lines.some(line => line.targets?.some(target => target.kind === 'action'))) {
      if (INDENT.length + affordanceCells <= width) {
        lines.push({
          text: `${INDENT}${color.primary(affordance)}`,
          rowId: row.id,
          targets: [selectTarget(), { kind: 'action', id: row.id, startCol: INDENT.length, endCol: INDENT.length + affordanceCells }],
        })
      }
    }
    return lines
  }

  /** The current Host facts as painted `Serving` / `Access` values. */
  private hostFactLines(width: number): ContentLine[] {
    const lines: ContentLine[] = [this.header('Current Host')]
    const host = this.hostCurrent()
    if (host === undefined) {
      const checking = this.host.kind === 'checking'
      const serving = this.host.kind === 'split-host-only'
        ? `${color.error('Unavailable')}${color.textDim(' · Split Host only')}`
        : checking ? color.textDim('Checking…') : color.error('Unavailable')
      lines.push(...this.factLines('Serving', serving, width))
      lines.push(...this.factLines(
        'Access',
        this.host.kind === 'split-host-only' || !checking ? color.error('Unavailable') : color.textDim('Checking…'),
        width,
      ))
      if (this.host.kind === 'unreadable') lines.push(...this.wrapped(this.host.message, 'error', width))
      return lines
    }
    const serving = servingWord(host.status)
    lines.push(...this.factLines('Serving', statusInk(serving.tone, serving.text), width))
    const access = accessWord(host.status)
    lines.push(...this.factLines(
      'Access',
      valueInk(access.tone === 'dim' ? 'dim' : access.tone === 'error' ? 'error' : 'text', access.text),
      width,
    ))
    if (host.status.state === 'unavailable') lines.push(...this.wrapped(host.status.reason, 'error', width))
    return lines
  }

  /** The complete body projection; every painted row carries its own spans. */
  private content(width: number): ContentLine[] {
    switch (this.phase) {
      case 'confirm-disable': return this.confirmDisableContent(width)
      case 'choose-autostart': return this.chooseContent(width)
      case 'confirm-save': return this.confirmSaveContent(width)
      default: return this.browseContent(width)
    }
  }

  private browseContent(width: number): ContentLine[] {
    const lines = this.hostFactLines(width)
    if (this.runtimeOutcome !== undefined) {
      lines.push(...this.factLines('Status', statusInk(this.runtimeOutcome.tone, this.runtimeOutcome.word), width))
      if (this.runtimeOutcome.detail !== undefined) {
        lines.push(...this.wrapped(this.runtimeOutcome.detail, this.runtimeOutcome.tone === 'error' ? 'error' : this.runtimeOutcome.tone === 'warning' ? 'warning' : 'dim', width))
      }
    }
    if (this.phase === 'loading') {
      lines.push(...this.wrapped('Reading the Host Web state…', 'dim', width))
      return lines
    }
    if (this.phase === 'pending-runtime' || this.phase === 'pending-config') {
      lines.push(...this.wrapped('Waiting for the answer…', 'dim', width))
      return lines
    }
    const rows = this.rowSpecs()
    const runtimeRows = rows.filter(row => row.kind === 'action')
    const fieldRow = rows.find(row => row.kind === 'field')
    if (runtimeRows.length > 0) {
      lines.push(this.header('Actions'))
      for (const row of runtimeRows) lines.push(...this.entryLines(row, width))
    }
    lines.push(this.header('Next Host Start'))
    if (fieldRow !== undefined) {
      lines.push(...this.entryLines(fieldRow, width))
    } else {
      lines.push(...this.factLines('Start automatically', color.textDim(preferenceSummary(this.preference, this.preferenceReadiness)), width))
    }
    lines.push(...this.wrapped(
      this.preferenceEditable()
        ? NEXT_START_ONLY
        : this.preferenceReadiness === 'ready'
          ? 'No persisted preference is available to edit.'
          : `The Host configuration is ${this.preferenceReadiness}; the next-start preference is read-only.`,
      'dim',
      width,
    ))
    if (this.configOutcome !== undefined) {
      lines.push(...this.factLines('Status', statusInk(this.configOutcome.tone, this.configOutcome.word), width))
      if (this.configOutcome.detail !== undefined) {
        lines.push(...this.wrapped(
          this.configOutcome.detail,
          this.configOutcome.tone === 'success' || this.configOutcome.tone === 'muted' ? 'dim'
            : this.configOutcome.tone === 'warning' ? 'warning' : 'error',
          width,
        ))
      }
    }
    return lines
  }

  /** The disable confirmation: the EXACT risk copy is the first thing on the
   *  page, and the accept row exists only while that whole copy shares the
   *  painted viewport. Cancel is never gated. */
  private confirmDisableContent(width: number): ContentLine[] {
    const copy = this.wrapped(DISABLE_QUESTION, 'text', width, 'copy')
    const accept = this.entryLines({ id: 'confirm-disable', kind: 'action', label: 'Disable Web' }, width)
      .map(line => ({ ...line, gatedBy: 'copy' as const }))
    const cancel = this.entryLines({ id: 'cancel', kind: 'action', label: 'Cancel' }, width)
    return [...copy, ...accept, ...cancel]
  }

  /** The next-start candidate choice. Each complete candidate is its own
   *  explicit choice; its selection never dispatches a write. */
  private chooseContent(width: number): ContentLine[] {
    const lines: ContentLine[] = this.wrapped(CHOOSE_PROMPT, 'dim', width)
    for (const row of this.rowSpecs()) lines.push(...this.entryLines(row, width))
    lines.push(...this.wrapped(NEXT_START_ONLY, 'dim', width))
    return lines
  }

  /** The save confirmation: the question AND the next-start-only lifetime fact
   *  must both be complete in the same frame as the accept row. */
  private confirmSaveContent(width: number): ContentLine[] {
    const candidate = this.autostartCandidate === true ? 'On' : 'Off'
    const copy = [
      ...this.wrapped(`Save the next Host start preference as ${candidate}?`, 'text', width, 'copy'),
      ...this.wrapped(NEXT_START_ONLY, 'dim', width, 'copy'),
    ]
    const accept = this.entryLines({ id: 'confirm-save', kind: 'action', label: 'Confirm save' }, width)
      .map(line => ({ ...line, gatedBy: 'copy' as const }))
    const cancel = this.entryLines({ id: 'cancel', kind: 'action', label: 'Cancel' }, width)
    return [...copy, ...accept, ...cancel]
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    // The painted Config fact and the edit grant come from THIS frame's live
    // read, so a non-current authority can never survive as an affordance.
    this.reconcilePreference()
    this.ensureSelection()
    const bodyRows = this.bodyRows()
    const content = this.content(width)
    const selectedLines: number[] = []
    content.forEach((line, index) => { if (line.rowId !== undefined && line.rowId === this.selectedId) selectedLines.push(index) })
    const maxOffset = Math.max(0, content.length - bodyRows)
    let offset = Math.min(this.scrollOffset, maxOffset)
    if (this.revealSelection && bodyRows > 0 && selectedLines.length > 0) {
      const start = selectedLines[0]!
      const end = selectedLines[selectedLines.length - 1]!
      if (start < offset) offset = start
      if (end >= offset + bodyRows) offset = end - bodyRows + 1
      if (start < offset) offset = start
    }
    offset = Math.min(Math.max(0, offset), maxOffset)
    this.scrollOffset = offset
    // The necessary-copy groups are judged against the FINAL physical viewport:
    // a gated entry whose copy is scrolled out is painted BLANK and publishes
    // no target — the same fact gates the keyboard and the bar.
    const visible = new Set<number>()
    for (let index = 0; index < bodyRows; index += 1) visible.add(offset + index)
    const groups = new Map<string, number[]>()
    content.forEach((line, index) => {
      if (line.group === undefined) return
      const list = groups.get(line.group) ?? []
      list.push(index)
      groups.set(line.group, list)
    })
    const groupComplete = (group: 'copy'): boolean => (groups.get(group) ?? []).every(index => visible.has(index))
    const lines: string[] = []
    const targets: PagePaint['targets'][number][] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedActions.clear()
    for (let index = 0; index < bodyRows; index += 1) {
      const line = content[offset + index]
      const blanked = line?.gatedBy !== undefined && !groupComplete(line.gatedBy)
      lines.push(fit(blanked ? '' : line?.text ?? '', width))
      if (line !== undefined && !blanked) {
        for (const target of line.targets ?? []) {
          targets.push({ kind: target.kind, id: target.id, row: index, startCol: target.startCol, endCol: target.endCol })
          if (target.kind === 'action') this.paintedActions.add(target.id)
        }
      }
    }
    while (lines.length < bodyRows) lines.push(fit('', width))
    const bar = this.renderBar(width)
    lines.push(bar.text)
    this.escapeSpan = bar.escapeSpan
    this.barSpans = bar.spans
    this.paint = {
      width,
      rows: this.rowGrant,
      identity: this.gestureIdentity(),
      targets,
      scrollStart: 0,
      scrollEnd: bodyRows,
      maxOffset,
    }
    this.paintedPreferenceSerial = this.preferenceSerial
    this.awaitingPaint = false
    return lines
  }

  /** The physical last row. Only actions admitted by THIS frame are painted;
   *  `Esc` is always last and always complete. */
  private renderBar(width: number): {
    readonly text: string
    readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
    readonly spans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[]
  } {
    const segments: BarSegment[] = []
    const barVerb: Record<string, string> = {
      open: 'Open',
      copy: 'Copy',
      enable: 'Enable',
      disable: 'Disable',
      autostart: 'Change',
    }
    switch (this.phase) {
      case 'loading':
      case 'pending-runtime':
      case 'pending-config':
        break
      case 'confirm-disable':
        if (this.selectedId === 'confirm-disable' && this.paintedActions.has('confirm-disable')) {
          segments.push({ text: 'Confirm [Enter]', priority: 900, action: 'confirm' })
        }
        break
      case 'choose-autostart':
        if (this.selectedId !== undefined && this.paintedActions.has(this.selectedId)) {
          segments.push({ text: 'Select [Enter]', priority: 900, action: 'select' })
        }
        break
      case 'confirm-save':
        if (this.selectedId === 'confirm-save' && this.paintedActions.has('confirm-save')) {
          segments.push({ text: 'Confirm save [Enter]', priority: 900, action: 'confirm' })
        }
        break
      case 'ready':
      case 'settled': {
        const selected = this.selectedId
        const verb = selected === undefined ? undefined : barVerb[selected]
        if (verb !== undefined && this.paintedActions.has(selected!)) {
          segments.push({ text: `${verb} [Enter]`, priority: 900, action: 'select' })
        }
        if (this.paintedActions.has('refresh')) {
          segments.push({ text: `Refresh [${REFRESH_KEY.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' })
        }
        break
      }
    }
    segments.push({
      text: this.phase === 'confirm-disable' || this.phase === 'choose-autostart' || this.phase === 'confirm-save' ? 'Cancel [Esc]' : 'Back [Esc]',
      priority: 1000,
      escape: true,
    })
    const layout = layoutActionBarRow(segments, width)
    if (layout.truncated) return { text: fit(color.textMuted(layout.text), width), spans: [] }
    const painted: string[] = []
    const spans: { id: string; action: BarAction; startCol: number; endCol: number }[] = []
    let escapeSpan: { readonly startCol: number; readonly endCol: number } | undefined
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]!
      painted.push(paintActionSpan(span.text, segment.action === 'confirm' || segment.action === 'select' ? 'primary' : 'secondary'))
      if (segment.escape) escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.action !== undefined) spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
    }
    return { text: fit(painted.join(ACTION_BAR_SEPARATOR), width), ...(escapeSpan === undefined ? {} : { escapeSpan }), spans }
  }
}

export interface WebUiSettingsPageIntents {
  /** The backend locality: Direct owns no Split Host Web frontend. */
  readonly backendKind: 'direct' | 'remote'
  /** ONE Host status read (the command owner's read authority). */
  readonly readStatus: () => Promise<WebAccessStatus>
  /** ONE Host toggle, fenced to the generation the user's action was read
   *  under (a replaced Host never receives the old choice). */
  readonly setEnabled: (enabled: boolean, expectedGeneration?: unknown) => Promise<WebAccessStatus>
  /** ONE official launch URL, fenced to the generation the state was read
   *  under; only an explicit Open/Copy asks for it. */
  readonly getAuthenticatedUrl: (expectedGeneration?: unknown) => Promise<{ readonly url: string }>
  /** The Client-local OS opener (the Host never runs a browser opener).
   *  `false` = this composition has no opener, so nothing was requested. */
  readonly openUrl: (url: string) => boolean
  /** The Client-local clipboard; resolves whether the URL was copied. */
  readonly copyToClipboard: (text: string) => Promise<boolean>
  /** The persisted next-launch preference, or `undefined` when the profile
   *  section cannot be read at all. A last-known value carries an `undefined`
   *  generation and is therefore displayable but never writable. */
  readonly readPreference: () => WebStartupPreferenceState | undefined
  /** The live Config readiness (`ready` is the only writable state). */
  readonly configReadiness: () => 'ready' | 'stale' | 'unavailable'
  /** The EXISTING revision-and-generation-checked `web-autostart` writer. A
   *  resolved write is not a read-back: the four official outcomes decide what
   *  is painted. The captured Host generation travels with the request so a
   *  replaced authority is refused even when the revision/value match. */
  readonly commitAutostart: (
    value: 'On' | 'Off',
    revision: number,
    generation: object,
  ) => Promise<SettingsWorkspaceCommitOutcome>
  /** The opaque current Connection generation (object identity). */
  readonly currentGeneration: () => unknown
  /** Observe Connection generation changes (Direct is a no-op). */
  readonly subscribeGeneration: (listener: () => void) => () => void
  /** The owned-task entry (the runner's diagnostics pre-attached). A write it
   *  dispatches keeps settling in its own owner after this page is gone. */
  readonly runOwned: (label: string, task: () => Promise<void>, onError: (error: unknown) => void) => void
  /** The write OWNER's diagnostics: a dispatched write that no longer has a
   *  live page is still diagnosed instead of silently lost. */
  readonly diagnose: (label: string, detail: Record<string, unknown>) => void
  readonly requestRender: () => void
  /** Leave the page (the root keeps Settings and returns to `Host · Rows`). */
  readonly done: () => void
}
