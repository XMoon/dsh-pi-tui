/**
 * The `/settings → Host → ACP access` page (SUX-05): the ONE PiTui ACP control
 * surface.
 *
 * It is mounted as a real Detail TENANT inside the existing Settings Workspace
 * lease: the parent Categories/Rows stay painted and readable, the Root keeps
 * the ONE physical last-row Action Bar and the ONE `Esc` target, and only this
 * page's Detail body cells belong to the child. It is never a second alt-screen
 * overlay, never a second Settings screen, and never a `SettingsList`. `/acp`
 * and the `Host → ACP access` row reach the SAME page class through the SAME
 * factory.
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
import type { SettingsWorkspaceCommitOutcome, EmbeddedSpecialistPage, SpecialistParentLeaveTarget } from './settings-workspace-panel.ts'

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
const DISABLE_QUESTION = 'Disable the local ACP listener? All connected ACP clients will be disconnected. '
  + 'Host sessions, Agents and this TUI will keep running.'
/** The next-start choice prompt and its frozen lifetime fact. */
const CHOOSE_PROMPT = 'Choose the value the next Host start applies:'
const NEXT_START_ONLY = 'Applies on the next Host start; the running Host is unchanged.'

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
  /** The EXISTING revision-and-generation checked `acp-autostart` writer. A
   *  resolved write is not a read-back: the four official outcomes decide what
   *  is painted. The captured Host settings generation travels with the write. */
  readonly commitAutostart: (value: 'On' | 'Off', revision: number, generation: object) => Promise<SettingsWorkspaceCommitOutcome>
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

/** Whether two preference observations are the SAME decision fact. The
 *  generation is compared by identity: a replacement Host can expose the same
 *  revision and value and still be a different authority. */
function samePreferenceObservation(
  a: AcpStartupPreferenceState | undefined,
  aReadiness: 'ready' | 'stale' | 'unavailable',
  b: AcpStartupPreferenceState | undefined,
  bReadiness: 'ready' | 'stale' | 'unavailable',
): boolean {
  if (aReadiness !== bReadiness) return false
  if (a === undefined || b === undefined) return a === b
  return a.autoStart === b.autoStart && a.revision === b.revision && Object.is(a.generation, b.generation)
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

/** Paint one already-truncated value by its content role. */
function valueInk(ink: 'text' | 'dim' | 'error' | 'warning' | 'muted', text: string): string {
  if (ink === 'dim') return color.textDim(text)
  if (ink === 'error') return color.error(text)
  if (ink === 'warning') return color.warning(text)
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
  /**
   * The Config settings-authority identity the staged choice was opened under.
   * The revision alone cannot prove the authority still belongs to the Host the
   * user was reading: a silent replacement (no rollover notification) keeps the
   * same revision while its Config mirror already belongs to another Host, so
   * the confirm compares BOTH captured facts.
   */
  private autostartGenerationFence: { readonly value: object } | undefined
  /** The preference observation the LAST painted frame actually admitted from:
   *  a silent Host replacement must not let a press on the old field establish
   *  a NEW choice from the newer fact without a fresh frame/user gesture. */
  private paintedPreference: {
    readonly readiness: 'ready' | 'stale' | 'unavailable'
    readonly autoStart: boolean
    readonly revision: number
    readonly generation: object | undefined
  } | undefined
  /** Bumped whenever the Config observation (authority identity included)
   *  changes, so every old painted pointer/gesture identity is revoked. */
  private preferenceEpoch = 0
  private selectedId: string | undefined
  private scrollOffset = 0
  private revealSelection = true
  private revision = 0
  private readSerial = 0
  /** The identity of the ONE admitted page task; a superseded settlement
   *  paints nothing. */
  private writeSerial = 0
  /**
   * The ACTUAL stage of the ONE pending runtime operation. `preflight` means
   * no Host mutation has been invoked yet (a Host replacement is a definitive
   * zero-write `Not changed`); `invoked` means `setEnabled` was really called
   * and its outcome is unknown until it settles. Invocation — not promise
   * fulfillment — is the dividing line: a rejected call may still have been
   * applied by the Host.
   */
  private runtimeStage: 'preflight' | 'invoked' | undefined
  private awaitingPaint = true
  private paint: PagePaint | undefined
  /** The actions whose COMPLETE span the last painted frame really published:
   *  the keyboard reads exactly this set, like the pointer does. */
  private paintedActions = new Set<string>()
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

  /**
   * The ONE user parent-leave query of the Detail tenant. The clean browse (or
   * a loaded page whose read is still in flight) leaves immediately; a staged
   * next-start choice, an open confirmation and a dispatched pending write keep
   * the page until the user's own local Cancel/Back. It never navigates, writes
   * or cancels an already dispatched write.
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
   *  observations + semantic revision. A release must re-prove the SAME value. */
  gestureIdentity(): string {
    const preference = this.preference === undefined
      ? 'none'
      : `${this.preference.revision}:${this.preference.autoStart}:${this.preferenceReadiness}`
    return `${this.phase}|${this.selectedId ?? ''}|${this.autostartCandidate === undefined ? '' : this.autostartCandidate ? 'on' : 'off'}|${this.host.kind}|${preference}|${this.preferenceEpoch}|${this.revision}`
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
   *  and re-reads the CURRENT Host. A runtime operation that had not invoked
   *  `setEnabled` yet is a DEFINITIVE zero-write `Not changed`; only an invoked
   *  call whose outcome is unknown is retired as unconfirmed. */
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
      // Retire this page's right to paint the old task's result (its owner
      // still settles and diagnoses). The stage decides the only honest word:
      // a preflight that never invoked the mutation wrote NOTHING.
      this.writeSerial += 1
      this.runtimeOutcome = this.runtimeStage === 'invoked'
        ? unconfirmedChange('The Host changed while the request was running.')
        : { word: 'Not changed', tone: 'muted', detail: 'the Host changed before the request was sent' }
      this.runtimeStage = undefined
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

  /** Drop a not-yet-dispatched next-start intent (phase, revision AND the
   *  generation fence it was opened under). */
  private retireStagedChoice(): void {
    this.autostartCandidate = undefined
    this.autostartFence = undefined
    this.autostartGenerationFence = undefined
    if (this.phase === 'choose-autostart' || this.phase === 'confirm-save') this.phase = 'ready'
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
    const previousReadiness = this.preferenceReadiness
    const previous = this.preference
    this.preferenceReadiness = this.intents.configReadiness()
    this.preference = this.intents.readPreference()
    if (!samePreferenceObservation(previous, previousReadiness, this.preference, this.preferenceReadiness)) {
      // The observation identity changed (value, revision, generation or
      // readiness). This is NOT a selection move: it must not force a reveal.
      // It only revokes every pointer/frame grant built from the old fact.
      this.preferenceEpoch += 1
    }
    if (!this.preferenceEditable()) {
      // The authority is no longer current: revoke the staged step, zero writes.
      this.retireStagedChoice()
    }
  }

  /** The staged next-start choice lost its decision fence: settle it visibly
   *  without writing and let the user review the CURRENT value. */
  private settleStaleAutostartChoice(): void {
    this.autostartCandidate = undefined
    this.autostartFence = undefined
    this.autostartGenerationFence = undefined
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
   *  be edited: the authority must be `ready` and must expose a revision. Every
   *  caller reconciles first (projection, generation change, refresh, action,
   *  write admission), so this never re-reads the authority. */
  private preferenceEditable(): boolean {
    return this.preferenceReadiness === 'ready'
      && this.preference !== undefined
      && this.preference.generation !== undefined
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
    // The ONE semantic admission shared by the body span, the bar span and the
    // keyboard: a row that is not completely painted/actionable right now can
    // never write or open a confirmation.
    if (!this.paintedActions.has(id)) return
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
      case 'autostart': {
        const painted = this.paintedPreference
        // The row was painted from ONE observation. If a silently replaced
        // authority already changed the live fact, this press must neither
        // stage a choice from the new value nor read as a successful activation:
        // revoke and require a fresh frame + explicit gesture.
        if (painted === undefined || this.preference === undefined || this.preference.generation === undefined
          || !this.preferenceEditable() || painted.readiness !== 'ready'
          || painted.revision !== this.preference.revision
          || !Object.is(painted.generation, this.preference.generation)) {
          this.revealSelection = true
          this.changed()
          return
        }
        // Stage the OPPOSITE of the persisted value: the row was activated to
        // change it, and the current candidate stays visible (marked below).
        // The revision AND the settings authority are captured HERE, at choice
        // entry, and travel with the staged decision to the writer boundary.
        this.phase = 'choose-autostart'
        this.autostartFence = this.preference.revision
        this.autostartGenerationFence = { value: this.preference.generation }
        this.autostartCandidate = this.preference.autoStart ? false : true
        this.selectedId = this.candidateId(this.autostartCandidate)
        this.revealSelection = true
        this.changed()
        return
      }
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
        this.autostartGenerationFence = undefined
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
   * unavailable, dispatches ZERO writes and states `Not changed`. The
   * preflight/`setEnabled` boundary decides the failure vocabulary: a Host
   * replacement BEFORE the invocation is a definitive zero-write
   * `Not changed`; once invoked, a lost receipt/read-back or a Host
   * replacement is `Could not confirm save` and is never retried.
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
    this.runtimeStage = 'preflight'
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
        // The preflight settles AFTER the page/request was retired: the Host
        // mutation was never invoked (the stage is still `preflight`).
        this.intents.diagnose('acp access runtime write', {
          target,
          invoked: false,
          stage: 'preflight',
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
      // From here on the mutation is INVOKED: a rejection may still have been
      // applied by the Host, so the outcome is classified conservatively.
      this.runtimeStage = 'invoked'
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
        // records what really happened so an invoked write is never silently
        // lost (no notice/overlay may be revived). `invoked` is the honest
        // fact; a fulfilled/rejected RPC is reported separately and never
        // treated as proof that the Host accepted the request.
        this.intents.diagnose('acp access runtime write', {
          target,
          invoked: true,
          stage: 'post-invoke',
          result: failure === undefined ? 'returned' : 'rejected',
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

  /** ZERO runtime writes were dispatched: state the real Host fact (when the
   *  preflight produced one) plus the clear `Not changed` word. */
  private commitPreDispatchRefusal(status: AcpAccessStatus | undefined, detail: string): void {
    this.runtimeStage = undefined
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
    this.runtimeStage = undefined
    if (!stillCurrent) {
      this.host = { kind: 'checking' }
      this.runtimeOutcome = unconfirmedChange('The Host changed while the request was running; its outcome cannot be attributed.')
      this.phase = 'ready'
      this.startStatusRead()
      this.changed()
      return
    }
    if (status === undefined) {
      this.host = { kind: 'unreadable', message: readFailure ?? 'the Host ACP state could not be re-read' }
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
        this.runtimeOutcome = { word: target ? 'ACP enabled' : 'ACP disabled', tone: 'success' }
      } else if (status.state === 'changing') {
        this.runtimeOutcome = unconfirmedChange('The Host is still applying the change.')
      } else {
        this.runtimeOutcome = {
          word: 'Requested state not reached',
          tone: 'warning',
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
    const generationFence = this.autostartGenerationFence
    if (candidate === undefined || state === undefined || fence === undefined
      || generationFence === undefined || !this.preferenceEditable()) return
    // The captured revision AND settings authority are the ONE decision this
    // submit may use; a moved authority refuses the stale confirmation instead
    // of CAS-rebasing it onto the intervening write, and a silently replaced
    // Host can never receive a choice derived from its predecessor.
    if (state.revision !== fence || state.generation === undefined
      || !Object.is(generationFence.value, state.generation)) {
      this.settleStaleAutostartChoice()
      this.changed()
      return
    }
    const revision = fence
    const generation = generationFence.value
    const serial = ++this.writeSerial
    this.phase = 'pending-config'
    this.configOutcome = undefined
    this.selectedId = undefined
    this.changed()
    this.intents.runOwned('acp access next launch preference', async () => {
      const outcome = await this.intents.commitAutostart(candidate ? 'On' : 'Off', revision, generation)
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
      this.autostartGenerationFence = undefined
      this.phase = 'settled'
      this.revealSelection = true
      this.changed()
    }, (error) => {
      if (this.disposed || serial !== this.writeSerial) return
      this.reconcilePreference()
      this.configOutcome = configOutcomeNote({ outcome: 'indeterminate', reason: safeErrorMessage(error) })
      this.autostartCandidate = undefined
      this.autostartFence = undefined
      this.autostartGenerationFence = undefined
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
      case 'pending-copy':
        return []
      case 'confirm-disable':
        return [
          { id: 'confirm-disable', kind: 'action', label: 'Disable ACP' },
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
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', kind: 'action', label: 'Copy client command' })
          rows.push({ id: 'disable', kind: 'action', label: 'Disable ACP…', value: 'Disconnects active ACP clients', valueInk: 'dim' })
          break
        case 'disabled':
          rows.push({ id: 'enable', kind: 'action', label: 'Enable ACP' })
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', kind: 'action', label: 'Copy client command' })
          break
        case 'changing':
        case 'unavailable':
          if (this.clientCommand() !== undefined) rows.push({ id: 'copy', kind: 'action', label: 'Copy client command' })
          break
      }
    } else if (this.clientCommand() !== undefined) {
      // checking / unreadable / split-host-only: no Host action exists, but the
      // Client-local Copy still depends only on the proven Profile.
      rows.push({ id: 'copy', kind: 'action', label: 'Copy client command' })
    }
    // A ready/settled page ALWAYS keeps its explicit Refresh body route: the
    // live listener can change under a same-generation external writer, and
    // `r`/the bar must not become a hidden no-op. The changing/unavailable/
    // Direct projections reach the SAME row through this push.
    if (!rows.some(row => row.id === 'refresh')) rows.push({ id: 'refresh', kind: 'action', label: 'Refresh' })
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
   *  primary Host action (or the Client-local Copy when no runtime toggle
   *  exists), else the editable next-start preference, else Refresh. */
  private firstFocusId(): string | undefined {
    const rows = this.rowSpecs()
    const host = this.hostCurrent()
    const hasCopy = rows.some(row => row.id === 'copy')
    const preferred = host === undefined
      // Direct / checking / unreadable: the proven Profile's Copy is the ONE
      // real action; without it the editable preference owns the focus.
      ? (hasCopy ? 'copy' : undefined)
      : host.status.state === 'enabled'
        ? (hasCopy ? 'copy' : 'disable')
        : host.status.state === 'disabled'
          ? 'enable'
          // changing / unavailable: no runtime toggle, but Copy still only
          // depends on the proven Profile.
          : (hasCopy ? 'copy' : undefined)
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

  /** One diagnostic/risk/question sentence, wrapped to the pane width and
   *  painted whole. Every physical line becomes a `copy` group member when
   *  asked: a gated accept only exists while the WHOLE sentence shares the
   *  painted viewport. */
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
   *  complete affordance/chip. Publishing is all-or-nothing per segment: blank
   *  and padding cells only select, never act. */
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

  /** The current Host facts as painted `Listener` / `Access` values. */
  private hostFactLines(width: number): ContentLine[] {
    const lines: ContentLine[] = [this.header('Current Host')]
    const host = this.hostCurrent()
    if (host === undefined) {
      const checking = this.host.kind === 'checking'
      const listener = this.host.kind === 'split-host-only'
        ? `${color.error('Unavailable')}${color.textDim(' · Split Host only')}`
        : checking ? color.textDim('Checking…') : color.error('Unavailable')
      lines.push(...this.factLines('Listener', listener, width))
      lines.push(...this.factLines(
        'Access',
        this.host.kind === 'split-host-only' || !checking ? color.error('Unavailable') : color.textDim('Checking…'),
        width,
      ))
      if (this.host.kind === 'unreadable') lines.push(...this.wrapped(this.host.message, 'error', width))
      return lines
    }
    const listener = listenerWord(host.status)
    lines.push(...this.factLines('Listener', statusInk(listener.tone, listener.text), width))
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
      // The runtime write's own result is painted beside the runtime facts: one
      // word carries the token, the explanation stays a separate line.
      lines.push(...this.factLines('Status', statusInk(this.runtimeOutcome.tone, this.runtimeOutcome.word), width))
      if (this.runtimeOutcome.detail !== undefined) {
        lines.push(...this.wrapped(this.runtimeOutcome.detail, this.runtimeOutcome.tone === 'error' ? 'error' : this.runtimeOutcome.tone === 'warning' ? 'warning' : 'dim', width))
      }
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
    lines.push(this.header('Client Setup'))
    const command = this.clientCommand()
    lines.push(...this.wrapped(SETUP_LEAD, 'dim', width))
    lines.push(...(command === undefined
      ? this.wrapped(SETUP_NO_COMMAND, 'error', width)
      : this.wrapped(command, 'text', width)))
    lines.push(...this.wrapped(SETUP_ENABLE_FIRST, 'dim', width))
    lines.push(...this.wrapped(SETUP_VIEW_LIFETIME, 'dim', width))
    return lines
  }

  /** The disable confirmation: the EXACT risk copy is the first thing on the
   *  page, and the accept row exists only while that whole copy shares the
   *  painted viewport. Cancel is never gated. */
  private confirmDisableContent(width: number): ContentLine[] {
    const copy = this.wrapped(DISABLE_QUESTION, 'text', width, 'copy')
    const accept = this.entryLines({ id: 'confirm-disable', kind: 'action', label: 'Disable ACP' }, width)
      .map(line => ({ ...line, gatedBy: 'copy' as const }))
    const cancel = this.entryLines({ id: 'cancel', kind: 'action', label: 'Cancel' }, width)
    return [...copy, ...accept, ...cancel]
  }

  /** The next-start candidate choice. Each complete candidate is its own
   *  explicit choice; its selection never dispatches a write. */
  private chooseContent(width: number): ContentLine[] {
    const lines = this.wrapped(CHOOSE_PROMPT, 'dim', width)
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
    this.paintedPreference = this.preference === undefined
      ? undefined
      : {
          readiness: this.preferenceReadiness,
          autoStart: this.preference.autoStart,
          revision: this.preference.revision,
          generation: this.preference.generation,
        }
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
      copy: 'Copy',
      enable: 'Enable',
      disable: 'Disable',
      autostart: 'Change',
    }
    switch (this.phase) {
      case 'loading':
      case 'pending-runtime':
      case 'pending-config':
      case 'pending-copy':
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
