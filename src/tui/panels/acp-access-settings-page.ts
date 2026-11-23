/**
 * The `/settings → Host → ACP access` page (PR-B): the ONE PiTui ACP control
 * surface.
 *
 * It is mounted as an EMBEDDED SPECIALIST PAGE inside the existing Settings
 * Workspace lease (the same body grant and physical last-row Action Bar as the
 * `Host · Web UI` page) — never a second alt-screen overlay, never a second
 * Settings screen, and never a `SettingsList`. `/acp` and the
 * `Host → ACP access` row reach the SAME page class through the SAME factory.
 *
 * Three authorities are painted side by side and are NEVER merged:
 *  - `Current Host` is the LIVE listener state of the running Split Host, read
 *    through the semantic `AcpAccessPort` and bound to the Connection
 *    generation it was read under. Every runtime action is qualified by a
 *    CURRENT observation (an extra live preflight before the single dispatch);
 *    a generation change revokes the actions, the confirmation and the pointer
 *    map, paints `Checking…` and re-reads;
 *  - `Next Host Start` is the persisted `pi-tui-acp-preferences.autoStart`
 *    profile value for the NEXT launch, read through the ConfigPort and written
 *    only by the existing revision-checked `commitSettingsWorkspaceField`
 *    `acp-autostart` writer. Toggling the running Host never changes it, and
 *    saving it never toggles the running Host;
 *  - `Client Setup` is a pure Client-local fact: the official CLI command is
 *    composed from the CURRENTLY PROVEN Profile identity captured once per
 *    open. Copying it never reaches the Host, reads no socket path and never
 *    runs the ACP stdio bridge.
 *
 * Authority is deliberately NOT here: the page owns only transient
 * presentation state (phase, cursor, scroll offset, staged candidate, the
 * last-painted pointer geometry). The Host controller stays the ONE runtime
 * writer and the `acp-autostart` settings writer stays the ONE preference
 * writer.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/acp-access-settings-page
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'
import type { AcpStartupPreferenceState } from '../../runtime/config-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { SettingsWorkspaceCommitOutcome, EmbeddedSpecialistPage } from './settings-workspace-panel.ts'

/** The page's own name (the Settings row label and the pane header). The
 *  breadcrumb is `Settings · Host · ACP access` because the owning row label
 *  already carries this identity. */
export const ACP_ACCESS_PAGE_TITLE = 'ACP access'

/**
 * The page's ONE transient phase. The runtime, preference and clipboard steps
 * are phases of THIS page instead of per-row shadow authorities: at most one
 * confirmation is painted at a time and only the phase decides what the body
 * and the Action Bar offer.
 *
 * `settled` is a presentation state (the last preference write's result is
 * painted); its action qualification is derived from the CURRENT observations
 * exactly like `ready`, never from the settlement itself.
 */
export type AcpAccessPagePhase =
  | 'loading'
  | 'ready'
  | 'confirm-disable'
  | 'choose-autostart'
  | 'confirm-save'
  | 'pending-runtime'
  | 'pending-config'
  | 'pending-copy'
  | 'settled'

/**
 * The CURRENT Host observation. `split-host-only` is a capability fact (the
 * Direct process owns no local ACP listener) and never becomes an action;
 * `checking` is the honest state while a read is in flight or a generation
 * change has revoked the previous fact.
 */
type HostObservation =
  | { readonly kind: 'checking' }
  | { readonly kind: 'split-host-only' }
  | { readonly kind: 'current'; readonly status: AcpAccessStatus; readonly generation: unknown }
  | { readonly kind: 'unreadable'; readonly message: string }

/** One settled write's painted result: the status WORD, its semantic tone and
 *  the explanation kept separate so only the word takes the token. */
interface OutcomeNote {
  readonly word: string
  readonly tone: 'success' | 'error' | 'warning' | 'muted'
  readonly detail?: string
}

/** One focusable row of the current projection. */
interface RowSpec {
  readonly id: string
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

/** One painted body line plus the row it belongs to (when focusable). */
interface ContentLine {
  readonly text: string
  readonly rowId?: string
}

/** The geometry the page publishes to the Settings root for ONE painted frame:
 *  its body grant, its bar spans and the semantic identity a pointer release is
 *  re-proved against. */
interface PagePaint {
  readonly width: number
  readonly rows: number
  readonly identity: string
  readonly targets: readonly { readonly id: string; readonly row: number; readonly startCol: number; readonly endCol: number }[]
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
/** The label column never shrinks below this: a shorter one identifies nothing. */
const MIN_LABEL_ROOM = 6

/** The exact confirm sentence of the runtime write (never paraphrased). */
const DISABLE_QUESTION = 'Disable the local ACP listener? All connected ACP clients will be disconnected. '
  + 'Host sessions, Agents and this TUI will keep running.'

/** The fixed Client Setup explanation lines. */
const SETUP_LEAD = 'Configure an ACP stdio command in your external client/IDE.'
const SETUP_ENABLE_FIRST = 'The Host listener must be enabled before the client can connect.'
const SETUP_VIEW_LIFETIME = 'Closing an ACP View detaches it; Host Sessions, Agents and TUI remain.'
/** Stated instead of the command when the official Profile identity is not
 *  proven: no guessed `pi-tui`, no argv/cwd/env derivation, no Copy target. */
const SETUP_NO_COMMAND = 'Client command unavailable · Profile identity not verified'

/**
 * POSIX shell quoting for the ONE copied client command: a profile name made
 * only of safe portable characters is emitted verbatim; anything else is
 * single-quoted with the POSIX `'\''` escape, so the printed and the copied
 * command are the same shell-correct token for a space, `$`, `;` or a quote.
 */
function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The ONE client connection command of this page: the installed public CLI
 * over the CURRENTLY PROVEN Profile. The SAME string is painted and copied (the
 * paint only sanitizes physical lines; it never truncates the payload).
 */
export function acpStdioCommand(profile: string): string {
  return `dsh --profile ${posixShellQuote(profile)} acp stdio`
}

export interface AcpAccessSettingsPageIntents {
  /** The backend locality: Direct owns no Split Host local ACP listener. */
  readonly backendKind: 'direct' | 'remote'
  /** ONE Host status read (the command owner's read authority). */
  readonly readStatus: () => Promise<AcpAccessStatus>
  /** ONE Host toggle, fenced to the generation the user's action was read
   *  under (a replaced Host never receives the old choice). */
  readonly setEnabled: (enabled: boolean, expectedGeneration?: unknown) => Promise<AcpAccessStatus>
  /** The persisted next-launch preference, or `undefined` when the profile
   *  section cannot be read at all. */
  readonly readPreference: () => AcpStartupPreferenceState | undefined
  /** The live Config readiness (`ready` is the only writable state). */
  readonly configReadiness: () => 'ready' | 'stale' | 'unavailable'
  /** The EXISTING revision-checked `acp-autostart` writer. A resolved write is
   *  not a read-back: the four official outcomes decide what is painted. */
  readonly commitAutostart: (value: 'On' | 'Off', revision: number) => Promise<SettingsWorkspaceCommitOutcome>
  /** The Client-local clipboard; resolves whether the command was copied. */
  readonly copyToClipboard: (text: string) => Promise<boolean>
  /** The OFFICIAL current Profile identity when this composition proves it,
   *  captured once per open. Absent = no Copy target and no guessed name. */
  readonly profileName: string | undefined
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

/** The `Listener` word + tone of one Host status (design language role 9). */
function listenerWord(status: AcpAccessStatus): { readonly text: string; readonly tone: 'success' | 'muted' | 'warning' | 'error' } {
  switch (status.state) {
    case 'enabled': return { text: 'Enabled', tone: 'success' }
    case 'disabled': return { text: 'Disabled', tone: 'muted' }
    case 'changing': return { text: 'Changing…', tone: 'warning' }
    case 'unavailable': return { text: 'Unavailable', tone: 'error' }
  }
}

/** The access fact of the CURRENT Host. Never a guessed socket path: only an
 *  enabled listener is stated with its real transport class. */
function accessWord(status: AcpAccessStatus): { readonly text: string; readonly tone: 'text' | 'dim' | 'error' } {
  switch (status.state) {
    case 'enabled': return { text: 'Local Unix socket · Same OS user', tone: 'text' }
    case 'disabled': return { text: 'Not listening', tone: 'dim' }
    case 'changing': return { text: 'Changing…', tone: 'dim' }
    case 'unavailable': return { text: 'Unavailable', tone: 'error' }
  }
}

/** The preference's display value + provenance. `Off (default)` marks the
 *  schema default the USER layer does not declare; a never-read value is
 *  `Unavailable`, never a fabricated default. */
function preferenceSummary(state: AcpStartupPreferenceState | undefined, readiness: 'ready' | 'stale' | 'unavailable'): string {
  if (readiness === 'unavailable' || state === undefined) return 'Unavailable'
  const value = state.autoStart ? 'On' : state.userOverridden ? 'Off' : 'Off (default)'
  return readiness === 'ready' ? value : `${value} · last known`
}

/** The frozen status word + explanation of one Config write settlement. */
function configOutcomeNote(outcome: SettingsWorkspaceCommitOutcome): OutcomeNote {
  switch (outcome.outcome) {
    case 'verified': return { word: 'Verified', tone: 'success' }
    case 'not-saved': return { word: 'Not saved', tone: 'error', ...(outcome.reason === undefined ? {} : { detail: outcome.reason }) }
    case 'unverified': return { word: 'Unverified', tone: 'warning', ...(outcome.reason === undefined ? {} : { detail: outcome.reason }) }
    case 'indeterminate': return { word: 'Outcome unconfirmed', tone: 'warning', ...(outcome.reason === undefined ? {} : { detail: outcome.reason }) }
  }
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

/** Paint one already-truncated value by its content role. */
function valueInk(ink: 'text' | 'dim' | 'error' | 'muted', text: string): string {
  if (ink === 'dim') return color.textDim(text)
  if (ink === 'error') return color.error(text)
  if (ink === 'muted') return color.textMuted(text)
  return color.text(text)
}

/**
 * The `Host · ACP access` page state machine. It paints and routes input only;
 * the two writers stay the command layer's existing owners.
 */
export class AcpAccessSettingsPage implements EmbeddedSpecialistPage {
  readonly title: string = ACP_ACCESS_PAGE_TITLE
  private readonly intents: AcpAccessSettingsPageIntents
  private disposed = false
  private _focused = false
  private rowGrant = 8
  private phase: AcpAccessPagePhase
  private host: HostObservation
  private preference: AcpStartupPreferenceState | undefined
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
  private selectedId: string | undefined
  private scrollOffset = 0
  private revealSelection = true
  private revision = 0
  private readSerial = 0
  /** The identity of the ONE admitted page task; a superseded settlement
   *  paints nothing. */
  private writeSerial = 0
  private awaitingPaint = true
  private paint: PagePaint | undefined
  private pressed: { readonly paint: PagePaint; readonly target: PagePaint['targets'][number] } | undefined
  private escapeSpan: { readonly startCol: number; readonly endCol: number } | undefined
  private barSpans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[] = []
  private readonly unsubscribe: () => void

  constructor(intents: AcpAccessSettingsPageIntents) {
    this.intents = intents
    this.preferenceReadiness = intents.configReadiness()
    this.preference = intents.readPreference()
    if (intents.backendKind === 'direct') {
      // The Direct process owns no local ACP listener: state the real missing
      // capability and never read a fake Host.
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revoke()
    this.paint = undefined
    this.unsubscribe()
  }

  /** Any state change retires the last frame's pointer grant and the pending
   *  press; the next real paint republishes both. */
  private revoke(): void {
    this.revision += 1
    this.awaitingPaint = true
    this.pressed = undefined
    this.escapeSpan = undefined
    this.barSpans = []
  }
  private changed(): void {
    if (this.disposed) return
    this.revoke()
    this.intents.requestRender()
  }

  /** The pointer/gesture identity: phase + selection + staged candidate +
   *  observations + semantic revision. A release must re-prove the SAME value. */
  gestureIdentity(): string {
    const preference = this.preference === undefined
      ? 'none'
      : `${this.preference.revision}:${this.preference.autoStart}:${this.preferenceReadiness}`
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
    this.intents.runOwned('acp access status read', async () => {
      let status: AcpAccessStatus | undefined
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

  private commitStatusRead(generation: unknown, status: AcpAccessStatus | undefined, failure: string | undefined): void {
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
      ? { kind: 'unreadable', message: failure ?? 'the Host ACP state could not be read' }
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
    if (this.phase === 'pending-runtime') {
      // The request belonged to the replaced Host: retire this page's right to
      // paint its result (its owner still settles and diagnoses) and state the
      // only honest outcome.
      this.writeSerial += 1
      this.runtimeOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: 'the Host changed while the request was running' }
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

  /**
   * ONE live observation of the persisted next-start preference and its Config
   * authority (never a Host ACP read). The readiness preference and the value
   * are captured TOGETHER and every projection/admission of this observation
   * derives from the SAME pair — the page never reads the authority twice in
   * one decision, so a painted `Unavailable` fact can never sit beside an
   * editable row (or a stale revision beside an edit grant).
   */
  private reconcilePreference(): void {
    this.preferenceReadiness = this.intents.configReadiness()
    this.preference = this.intents.readPreference()
    if (!this.preferenceEditable()) {
      // The authority is no longer current: revoke the staged step, zero writes.
      this.autostartCandidate = undefined
      this.autostartFence = undefined
      if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') {
        this.phase = 'ready'
        this.revealSelection = true
      }
    }
  }

  /** The staged next-start choice lost its decision fence: settle it visibly
   *  without writing and let the user review the CURRENT value. */
  private settleStaleAutostartChoice(): void {
    this.autostartCandidate = undefined
    this.autostartFence = undefined
    if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') {
      this.phase = 'settled'
      this.revealSelection = true
    }
    this.configOutcome = {
      word: 'Not saved',
      tone: 'error',
      detail: 'the configuration changed since this choice was opened; review the new value and confirm again',
    }
  }

  /** Whether the OBSERVATION captured by the current projection/admission may
   *  be edited: the authority must be `ready` and must expose a revision. Every
   *  caller reconciles first (projection, generation change, refresh, action,
   *  write admission), so this never re-reads the authority. */
  private preferenceEditable(): boolean {
    return this.preferenceReadiness === 'ready' && this.preference !== undefined
  }

  private hostCurrent(): { readonly status: AcpAccessStatus; readonly generation: unknown } | undefined {
    return this.host.kind === 'current' ? this.host : undefined
  }

  /** The ONE copyable client command of this page, or `undefined` when the
   *  official Profile identity is not proven (no guessed name, no host IO). */
  private clientCommand(): string | undefined {
    const profile = this.intents.profileName
    if (profile === undefined || profile.trim() === '') return undefined
    return acpStdioCommand(profile)
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

  private activateSelected(): void {
    if (this.selectedId !== undefined) this.activateRow(this.selectedId)
  }

  private activateRow(id: string): void {
    if (this.disposed) return
    // An action is admitted against a CURRENT Config observation, never against
    // the projection a previous frame captured.
    this.reconcilePreference()
    switch (id) {
      case 'copy': this.copyClientCommand(); return
      case 'enable': this.dispatchRuntime(true); return
      case 'disable':
        this.phase = 'confirm-disable'
        this.selectedId = 'confirm-disable'
        this.revealSelection = true
        this.changed()
        return
      case 'refresh': this.refreshAll(); return
      case 'autostart':
        if (!this.preferenceEditable() || this.preference === undefined) return
        // Stage the OPPOSITE of the persisted value: the row was activated to
        // change it, and the current candidate stays visible (marked below).
        // The revision is captured HERE, at choice entry, and travels with the
        // staged decision.
        this.phase = 'choose-autostart'
        this.autostartFence = this.preference.revision
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
        this.phase = 'ready'
        this.selectedId = 'autostart'
        this.changed()
        return
      default:
        // `pending-*`: the task keeps settling in its owner; only this page's
        // right to paint the result is revoked (the root disposes it).
        this.intents.done()
    }
  }

  /**
   * Copy ONE client connection command into the Client clipboard. It is NOT a
   * Host write: it reads no socket, starts no process and does not depend on
   * the listener being enabled. Only a `true` clipboard result is stated as
   * copied.
   */
  private copyClientCommand(): void {
    const command = this.clientCommand()
    if (command === undefined) return
    const serial = ++this.writeSerial
    this.phase = 'pending-copy'
    this.runtimeOutcome = undefined
    this.selectedId = undefined
    this.changed()
    this.intents.runOwned('acp access client command copy', async () => {
      let copied = false
      let failure: string | undefined
      try {
        copied = await this.intents.copyToClipboard(command)
      } catch (error) {
        failure = safeErrorMessage(error)
      }
      if (this.disposed || serial !== this.writeSerial) {
        this.intents.diagnose('acp access client command copy', {
          copied,
          ...(failure === undefined ? {} : { failure }),
        })
        return
      }
      this.runtimeOutcome = copied
        ? { word: 'Client command copied', tone: 'muted' }
        : { word: 'Clipboard unavailable', tone: 'error', ...(failure === undefined ? {} : { detail: failure }) }
      this.phase = 'ready'
      this.revealSelection = true
      this.changed()
    }, (error) => {
      if (this.disposed || serial !== this.writeSerial) return
      this.runtimeOutcome = { word: 'Clipboard unavailable', tone: 'error', detail: safeErrorMessage(error) }
      this.phase = 'ready'
      this.revealSelection = true
      this.changed()
    })
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
   * ONE runtime toggle, admitted exactly as the contract states: a CURRENT
   * painted observation, ONE live preflight read under the SAME generation,
   * then at most ONE `setEnabled(target, generation)` and ONE authoritative
   * read-back. A state that already reached the target, or that is changing or
   * unavailable, dispatches ZERO writes and states `Not changed`; a request
   * whose receipt/read-back is lost is `Outcome unconfirmed` and is never
   * retried.
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
    this.intents.runOwned(target ? 'acp access enable' : 'acp access disable', async () => {
      // ONE live preflight: the visible state must still admit this exact
      // action under the SAME generation the user acted on.
      let before: AcpAccessStatus | undefined
      let preflightFailure: string | undefined
      try {
        before = await this.intents.readStatus()
      } catch (error) {
        preflightFailure = safeErrorMessage(error)
      }
      const currentAfterPreflight = Object.is(generation, this.intents.currentGeneration())
      if (this.disposed || serial !== this.writeSerial) {
        this.intents.diagnose('acp access runtime write', {
          target,
          dispatched: false,
          phase: 'preflight',
          settled: currentAfterPreflight ? (before?.state ?? 'unknown') : 'host-changed',
          ...(preflightFailure === undefined ? {} : { preflightFailure }),
        })
        return
      }
      if (!currentAfterPreflight) {
        // ZERO writes were dispatched: this observation now belongs to a
        // replaced Host, so the request was never sent to the new one.
        this.commitPreDispatchRefusal(undefined, 'the Host changed while the request was being verified')
        return
      }
      if (before === undefined) {
        this.commitPreDispatchRefusal(undefined, `the Host ACP state could not be read before the request: ${preflightFailure ?? 'unknown error'}`)
        return
      }
      if (before.state === 'changing') {
        this.commitPreDispatchRefusal(before, 'an ACP listener change is already in progress')
        return
      }
      if (before.state === 'unavailable') {
        this.commitPreDispatchRefusal(before, 'the ACP listener is unavailable')
        return
      }
      if (before.state === (target ? 'enabled' : 'disabled')) {
        this.commitPreDispatchRefusal(before, `the listener already reports ${listenerWord(before).text}`)
        return
      }
      let failure: string | undefined
      try {
        await this.intents.setEnabled(target, generation)
      } catch (error) {
        failure = safeErrorMessage(error)
      }
      const sameGeneration = Object.is(generation, this.intents.currentGeneration())
      // ONE read-only re-check: it refreshes the visible fact but NEVER
      // attributes this request's outcome.
      let status: AcpAccessStatus | undefined
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
        this.intents.diagnose('acp access runtime write', {
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
      this.runtimeOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: safeErrorMessage(error) }
      this.phase = 'ready'
      this.revealSelection = true
      this.changed()
      this.startStatusRead()
    })
  }

  /** ZERO runtime writes were dispatched: state the real Host fact (when the
   *  preflight produced one) plus the clear `Not changed` word. */
  private commitPreDispatchRefusal(status: AcpAccessStatus | undefined, detail: string): void {
    if (status !== undefined) {
      this.host = { kind: 'current', status, generation: this.intents.currentGeneration() }
      this.runtimeOutcome = { word: 'Not changed', tone: 'muted', detail }
      this.phase = 'ready'
      this.revealSelection = true
      this.changed()
      return
    }
    this.host = { kind: 'checking' }
    this.runtimeOutcome = { word: 'Not changed', tone: 'muted', detail }
    this.phase = 'ready'
    this.revealSelection = true
    this.changed()
    this.startStatusRead()
  }

  private commitRuntimeSettlement(
    target: boolean,
    generation: unknown,
    failure: string | undefined,
    status: AcpAccessStatus | undefined,
    readFailure: string | undefined,
    stillCurrent: boolean,
  ): void {
    if (!stillCurrent) {
      this.host = { kind: 'checking' }
      this.runtimeOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: 'the Host changed while the request was running; its outcome cannot be attributed' }
      this.phase = 'ready'
      this.startStatusRead()
      this.changed()
      return
    }
    if (status === undefined) {
      this.host = { kind: 'unreadable', message: readFailure ?? 'the Host ACP state could not be re-read' }
      this.runtimeOutcome = failure === undefined
        ? { word: 'Outcome unconfirmed', tone: 'warning', detail: 'the request was sent but the Host state could not be re-read' }
        : { word: 'Outcome unconfirmed', tone: 'warning', detail: `${failure}; the Host state could not be re-read either` }
    } else {
      this.host = { kind: 'current', status, generation }
      if (failure !== undefined) {
        // A thrown request may still have been applied by the Host. The fresh
        // read refreshes the fact; it never proves this request's outcome.
        this.runtimeOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: `${failure}; the Host may have applied the request` }
      } else if (status.state === (target ? 'enabled' : 'disabled')) {
        this.runtimeOutcome = { word: 'Verified', tone: 'success' }
      } else if (status.state === 'changing') {
        this.runtimeOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: 'the Host is still applying the change' }
      } else {
        this.runtimeOutcome = {
          word: 'Not saved',
          tone: 'error',
          detail: `the request reported success, but the Host reads ${listenerWord(status).text.replace(/…$/u, '')}`,
        }
      }
    }
    this.phase = 'ready'
    this.revealSelection = true
    this.changed()
  }

  /**
   * The ONE next-launch preference write: the EXISTING revision-checked
   * `acp-autostart` writer, after an explicit second confirmation. It never
   * calls the runtime toggle and never guesses a default.
   */
  private dispatchConfig(): void {
    // Admit the write against the LIVE Config authority, never the cached
    // projection the confirmation was staged from.
    this.reconcilePreference()
    const candidate = this.autostartCandidate
    const state = this.preference
    const fence = this.autostartFence
    if (candidate === undefined || state === undefined || fence === undefined || !this.preferenceEditable()) return
    // The captured revision is the ONE revision this decision may submit; a
    // moved authority refuses the stale confirmation instead of CAS-rebasing
    // it onto the intervening write.
    if (state.revision !== fence) {
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
    this.intents.runOwned('acp access next launch preference', async () => {
      const outcome = await this.intents.commitAutostart(candidate ? 'On' : 'Off', revision)
      if (this.disposed || serial !== this.writeSerial) {
        this.intents.diagnose('acp access preference write', {
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
      this.configOutcome = { word: 'Outcome unconfirmed', tone: 'warning', detail: safeErrorMessage(error) }
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
    if (this.phase === 'pending-runtime' || this.phase === 'pending-config' || this.phase === 'pending-copy') return
    if (data === REFRESH_KEY || data === REFRESH_KEY.toUpperCase()) { this.refreshAll(); return }
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
   *  frame; the live page state re-proves it before the SAME keyboard sink. */
  activateBarSpan(id: string): void {
    if (this.disposed || this.awaitingPaint) return
    if (this.paint !== undefined && this.paint.identity !== this.gestureIdentity()) return
    const span = this.barSpans.find(candidate => candidate.id === id)
    if (span === undefined) return
    switch (span.action) {
      case 'refresh': this.refreshAll(); return
      case 'select': this.activateSelected(); return
      case 'confirm':
        // The bar's confirm names the PHASE's own confirmation, not whichever
        // row the cursor happens to rest on (the Cancel row is a sibling).
        if (this.phase === 'confirm-disable') this.dispatchRuntime(false)
        else if (this.phase === 'confirm-save') this.dispatchConfig()
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
    const target = paint.targets.find(target => target.row === event.y && event.x >= target.startCol && event.x < target.endCol)
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
      || pressed.target.id !== target.id || pressed.target.row !== target.row
      || pressed.target.startCol !== target.startCol || pressed.target.endCol !== target.endCol) {
      if (event.type === 'click') this.pressed = undefined
      return undefined
    }
    this.pressed = undefined
    // A click SELECTS the row it landed on first (the visible cursor must match
    // what the pointer acts on), then runs the SAME Enter sink.
    this.selectedId = target.id
    this.revealSelection = true
    this.revision += 1
    this.activateRow(target.id)
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
      case 'pending-copy':
        return []
      case 'confirm-disable':
        return [
          { id: 'confirm-disable', label: 'Disable ACP' },
          { id: 'cancel', label: 'Cancel' },
        ]
      case 'choose-autostart':
        return [
          { id: 'candidate-on', label: 'On', ...(this.preference?.autoStart === true ? { chip: '[current]' } : {}) },
          { id: 'candidate-off', label: 'Off', ...(this.preference?.autoStart === false ? { chip: '[current]' } : {}) },
        ]
      case 'confirm-save':
        return [
          { id: 'confirm-save', label: 'Confirm save' },
          { id: 'cancel', label: 'Cancel' },
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
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', label: 'Copy client command' })
          rows.push({ id: 'disable', label: 'Disable ACP…', value: 'Disconnects active ACP clients', valueInk: 'dim' })
          break
        case 'disabled':
          rows.push({ id: 'enable', label: 'Enable ACP' })
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', label: 'Copy client command' })
          break
        case 'changing':
        case 'unavailable':
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', label: 'Copy client command' })
          rows.push({ id: 'refresh', label: 'Refresh' })
          break
      }
    } else {
      // checking / unreadable / split-host-only: no Host action exists.
      if (this.clientCommand() !== undefined) rows.push({ id: 'copy', label: 'Copy client command' })
      rows.push({ id: 'refresh', label: 'Refresh' })
    }
    if (this.preferenceEditable()) {
      rows.push({
        id: 'autostart',
        label: 'Start automatically',
        value: preferenceSummary(this.preference, this.preferenceReadiness),
        valueInk: 'text',
        affordance: 'Change…',
      })
    }
    return rows
  }

  /** The first focus the page should land on for the CURRENT observations: the
   *  primary Host action (or the Copy when the enabled Host offers it), else
   *  the editable next-start preference, else Refresh. */
  private firstFocusId(): string | undefined {
    const rows = this.rowSpecs()
    const host = this.hostCurrent()
    const preferred = host === undefined
      ? undefined
      : host.status.state === 'enabled'
        ? (rows.some(row => row.id === 'copy') ? 'copy' : 'disable')
        : host.status.state === 'disabled'
          ? 'enable'
          : undefined
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

  /** One `Label   value` fact line (label ink = role 5). */
  private factLine(label: string, value: string, width: number): string {
    const room = Math.max(MIN_LABEL_ROOM, LABEL_COLUMN)
    const paintedLabel = truncateToWidth(label, room, '…', false)
    const padding = ' '.repeat(Math.max(0, room - visibleWidth(paintedLabel)))
    return `  ${color.textDim(paintedLabel)}${padding} ${value}`
  }

  /** One list row: `cursor + label + value + affordance + chip`. The whole row
   *  is the pointer target when it is focusable. */
  private listLine(row: RowSpec, width: number): string {
    const selected = this.selectedId === row.id
    const marker = selected ? color.primary('> ') : '  '
    const chipText = row.chip === undefined ? '' : `  ${row.chip}`
    const chipWidth = row.chip === undefined ? 0 : visibleWidth(chipText)
    const room = Math.max(MIN_LABEL_ROOM, LABEL_COLUMN - chipWidth)
    const label = truncateToWidth(row.label, room, '…', false)
    const paintedLabel = `${selected ? color.textStrong(label) : color.text(label)}${' '.repeat(Math.max(0, room - visibleWidth(label)))}`
    const tailRoom = Math.max(0, width - visibleWidth(marker) - room - 1 - chipWidth)
    // The affordance is painted WHOLE right after the value and dropped whole
    // when it cannot fit; it is never truncated into a different verb.
    const affordance = row.affordance === undefined ? undefined : `· ${row.affordance}`
    const affordanceWidth = affordance === undefined ? 0 : visibleWidth(affordance)
    const fitsAffordance = affordance !== undefined && row.value !== undefined && affordanceWidth + 1 <= tailRoom
    const reserved = fitsAffordance ? affordanceWidth + 1 : 0
    const value = row.value === undefined ? '' : truncateToWidth(row.value, Math.max(0, tailRoom - reserved), '…', false)
    const valueWidth = row.value === undefined ? 0 : visibleWidth(value)
    const paintedValue = row.value === undefined ? '' : valueInk(row.valueInk ?? 'text', value)
    const paintedAffordance = fitsAffordance ? ` ${color.primary(affordance!)}` : ''
    const padding = ' '.repeat(Math.max(0, tailRoom - valueWidth - reserved))
    return `${marker}${paintedLabel} ${paintedValue}${paintedAffordance}${padding}${chipText}`
  }

  /** One diagnostic sentence, wrapped to the pane width and painted whole. */
  private wrapped(text: string, ink: 'text' | 'dim' | 'error', width: number): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(line => ({
      text: valueInk(ink === 'error' ? 'error' : ink === 'text' ? 'text' : 'dim', line),
    }))
  }

  /** The current Host facts as painted `Listener` / `Access` values. */
  private hostFactLines(width: number): ContentLine[] {
    const lines: ContentLine[] = [{ text: color.textDim('Current Host') }]
    const host = this.hostCurrent()
    if (host === undefined) {
      const checking = this.host.kind === 'checking'
      const listener = this.host.kind === 'split-host-only'
        ? `${color.error('Unavailable')}${color.textDim(' · Split Host only')}`
        : checking ? color.textDim('Checking…') : color.error('Unavailable')
      const access = this.host.kind === 'split-host-only' || !checking
        ? color.error('Unavailable')
        : color.textDim('Checking…')
      lines.push({ text: this.factLine('Listener', listener, width) })
      lines.push({ text: this.factLine('Access', access, width) })
      if (this.host.kind === 'unreadable') lines.push(...this.wrapped(this.host.message, 'error', width))
      return lines
    }
    const listener = listenerWord(host.status)
    lines.push({ text: this.factLine('Listener', statusInk(listener.tone, listener.text), width) })
    const access = accessWord(host.status)
    lines.push({ text: this.factLine('Access', valueInk(access.tone === 'dim' ? 'dim' : access.tone === 'error' ? 'error' : 'text', access.text), width) })
    if (host.status.state === 'unavailable') lines.push(...this.wrapped(host.status.reason, 'error', width))
    return lines
  }

  /** The complete body projection (unpainted rows are already painted strings). */
  private content(width: number): ContentLine[] {
    const lines = this.hostFactLines(width)
    if (this.runtimeOutcome !== undefined) {
      // The runtime write's own result is painted beside the runtime facts: one
      // word carries the token, the explanation stays a separate line.
      lines.push({ text: this.factLine('Status', statusInk(this.runtimeOutcome.tone, this.runtimeOutcome.word), width) })
      if (this.runtimeOutcome.detail !== undefined) lines.push(...this.wrapped(this.runtimeOutcome.detail, 'dim', width))
    }
    if (this.phase === 'loading') {
      lines.push(...this.wrapped('Reading the Host ACP state…', 'dim', width))
      return lines
    }
    if (this.phase === 'pending-runtime' || this.phase === 'pending-config') {
      lines.push(...this.wrapped('Waiting for the answer…', 'dim', width))
      return lines
    }
    if (this.phase === 'pending-copy') {
      lines.push(...this.wrapped('Copying the client command…', 'dim', width))
      return lines
    }
    const rows = this.rowSpecs()
    if (this.phase === 'confirm-disable') {
      lines.push({ text: color.textDim('Actions') })
      lines.push(...this.wrapped(DISABLE_QUESTION, 'text', width))
      for (const row of rows) lines.push({ text: this.listLine(row, width), rowId: row.id })
      return lines
    }
    if (this.phase === 'choose-autostart') {
      lines.push({ text: color.textDim('Next Host Start') })
      lines.push(...this.wrapped('Choose the value the next Host start applies:', 'dim', width))
      for (const row of rows) lines.push({ text: this.listLine(row, width), rowId: row.id })
      lines.push(...this.wrapped('Applies on the next Host start; the running Host is unchanged.', 'dim', width))
      return lines
    }
    if (this.phase === 'confirm-save') {
      const candidate = this.autostartCandidate === true ? 'On' : 'Off'
      lines.push({ text: color.textDim('Next Host Start') })
      lines.push(...this.wrapped(`Save the next Host start preference as ${candidate}?`, 'text', width))
      for (const row of rows) lines.push({ text: this.listLine(row, width), rowId: row.id })
      return lines
    }
    const autostart = rows.find(row => row.id === 'autostart')
    lines.push({ text: color.textDim('Actions') })
    for (const row of rows) {
      if (row.id === 'autostart') break
      lines.push({ text: this.listLine(row, width), rowId: row.id })
    }
    lines.push({ text: color.textDim('Next Host Start') })
    if (autostart !== undefined) {
      lines.push({ text: this.listLine(autostart, width), rowId: autostart.id })
    } else {
      lines.push({
        text: this.factLine('Start automatically', color.textDim(preferenceSummary(this.preference, this.preferenceReadiness)), width),
      })
    }
    lines.push(...this.wrapped(
      this.preferenceEditable()
        ? 'Applies on the next Host start; the running Host is unchanged.'
        : this.preferenceReadiness === 'ready'
          ? 'No persisted preference is available to edit.'
          : `The Host configuration is ${this.preferenceReadiness}; the next-start preference is read-only.`,
      'dim',
      width,
    ))
    if (this.configOutcome !== undefined) {
      lines.push({ text: this.factLine('Status', statusInk(this.configOutcome.tone, this.configOutcome.word), width) })
      if (this.configOutcome.detail !== undefined) {
        lines.push(...this.wrapped(this.configOutcome.detail, this.configOutcome.tone === 'success' || this.configOutcome.tone === 'muted' ? 'dim' : 'error', width))
      }
    }
    lines.push({ text: color.textDim('Client Setup') })
    const command = this.clientCommand()
    lines.push(...this.wrapped(SETUP_LEAD, 'dim', width))
    lines.push(...(command === undefined
      ? this.wrapped(SETUP_NO_COMMAND, 'error', width)
      : this.wrapped(command, 'text', width)))
    lines.push(...this.wrapped(SETUP_ENABLE_FIRST, 'dim', width))
    lines.push(...this.wrapped(SETUP_VIEW_LIFETIME, 'dim', width))
    return lines
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    // The painted Config fact and the edit grant come from THIS frame's live
    // read, so a non-current authority can never survive as an affordance.
    this.reconcilePreference()
    this.ensureSelection()
    const bodyRows = this.bodyRows()
    const content = this.content(width)
    const selection = content.findIndex(line => line.rowId !== undefined && line.rowId === this.selectedId)
    const maxOffset = Math.max(0, content.length - bodyRows)
    let offset = Math.min(this.scrollOffset, maxOffset)
    if (this.revealSelection && bodyRows > 0 && selection >= 0) {
      if (selection < offset) offset = selection
      if (selection >= offset + bodyRows) offset = selection - bodyRows + 1
      this.revealSelection = false
    }
    this.scrollOffset = offset
    const lines: string[] = []
    const targets: PagePaint['targets'][number][] = []
    for (let index = 0; index < bodyRows; index += 1) {
      const line = content[offset + index]
      lines.push(fit(line?.text ?? '', width))
      if (line?.rowId !== undefined) targets.push({ id: line.rowId, row: index, startCol: 0, endCol: width })
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
    this.awaitingPaint = false
    return lines
  }

  private renderBar(width: number): {
    readonly text: string
    readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
    readonly spans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[]
  } {
    const segments: BarSegment[] = []
    switch (this.phase) {
      case 'loading':
      case 'pending-runtime':
      case 'pending-config':
      case 'pending-copy':
        break
      case 'confirm-disable':
        segments.push({ text: 'Confirm [Enter]', priority: 900, action: 'confirm' })
        break
      case 'choose-autostart':
        segments.push({ text: 'Select [Enter]', priority: 900, action: 'select' })
        break
      case 'confirm-save':
        segments.push({ text: 'Confirm save [Enter]', priority: 900, action: 'confirm' })
        break
      case 'ready':
      case 'settled':
        segments.push({ text: `Refresh [${REFRESH_KEY.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' })
        break
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
