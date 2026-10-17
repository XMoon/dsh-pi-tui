/**
 * Built-in command definitions for the model/permission-preset domain
 * (/model, /yolo, /preset) plus the shipped-preset display copy.
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position and owns catalog/provenance/disposal state.
 * The /model operation/surface tokens and the /preset operation token live
 * here because they are per-registration-lifetime ownership state of these
 * handlers.
 * @module @xmoon76/dsh-pi-tui/tui/commands/models
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { TuiApp } from '../../tui-app.ts'
import type { SessionScope } from '../../app/session/scope.ts'
import { TransitionInProgressError } from '../../app/session/operation-barrier.ts'
import { isCancellation, runOwned, type OwnedTaskOptions } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { ModelApplyOutcome, ModelPresentation } from '../../app/command/model-presentation.ts'
import type {
  PresetApplyOutcome,
  PresetDefaultOutcome,
  PresetPresentation,
} from '../../app/command/preset-presentation.ts'
import { pituiModelPresentation } from '../pickers/model-presentation-pitui.ts'
import { pituiPresetPresentation } from '../pickers/preset-presentation-pitui.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { OperationResult } from '../../runtime/write-outcome.ts'
import type { RegisterOne, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the model/preset commands consume. */
type ModelCommandRunner = Pick<
  TuiCommandRunner,
  | 'captureLiveSessionScope'
  | 'captureSessionScope'
  | 'catalog'
  | 'config'
  | 'currentPreset'
  | 'currentSessionId'
  | 'defaultIntentRecord'
  | 'diag'
  | 'effectivePresetId'
  | 'isSessionScopeCurrent'
  | 'applyPermissionPreset'
  | 'pendingPreset'
  | 'requireLiveSessionScope'
  | 'reconcileDefaultIntent'
  | 'refreshSessionCatalog'
  | 'refreshStandingCatalog'
  | 'refreshStatus'
  | 'sessionBlank'
  | 'setDefaultIntent'
  | 'setModelSelectionPending'
  | 'settleIntent'
  | 'signal'
  | 'trackDefaultWrite'
  | 'updateWelcomeCard'
  | 'withSessionTransition'
  | 'withWriter'
>

export interface ModelCommandDeps {
  runner: ModelCommandRunner
  app: TuiApp
  modelPresentation?: ModelPresentation
  presetPresentation?: PresetPresentation
  registerOne: RegisterOne
  recordCommandDraftDisposition: (commandId: string | undefined, disposition: 'restored' | 'suppressed') => void
  /**
   * PR4-B2-A: the TSP-only CONFIRMED-SUCCESS notice (a no-op beside a PiTui
   * command card). Refusal/cancellation/indeterminate outcomes keep their
   * existing owners, so no outcome is reported twice.
   */
  notifyOutcome: (text: string, kind?: 'info' | 'error') => void
}

export interface ModelCommandRegistrars {
  registerModel(): void
  registerYolo(): void
  registerPreset(): void
}

/**
 * Create the model/permission-preset registrars over the coordinator's
 * primitives. The factory only closes over its dependencies; it registers
 * nothing until one of the returned registrars is called at its frozen
 * position.
 */
export function createModelCommands(deps: ModelCommandDeps): ModelCommandRegistrars {
  const { runner, app, registerOne, recordCommandDraftDisposition, notifyOutcome } = deps
  const { signal } = runner

  /**
   * The TUI-owned `/preset` command IDENTITY — the official
   * discovery/presentation identity (0.1.6 `definitionId`), never an
   * authorization fact.
   */
  const TUI_PRESET_COMMAND_DEFINITION_ID = CommandDefinitionId('@xmoon76/dsh-pi-tui/preset')

  // Operation ownership for `/model` (shared across handler invocations): a
  // newer selection supersedes an older one's pending-marker clear and error
  // notice even on the SAME Session generation (v2 §0.2.5).
  let modelOperationToken = 0
  // PRESENTATION ownership for `/model`: a newer invocation supersedes the
  // previous (loading or loaded) panel. It is DISTINCT from
  // modelOperationToken (which owns the WRITE): the surface token decides
  // which picker is allowed to hydrate/repaint/close.
  let modelSurfaceToken = 0

  // `/preset` IS TUI-owned: the base composes no roster and registers no
  // preset command, so this cannot collide (P5.7 lesson, positive case).
  //
  // Sessionless by design (deferred start): typing /preset before any
  // session exists used to CREATE one (dispatchViaSession calls
  // ensureSession() for anything outside SESSIONLESS_COMMANDS), and the
  // roster's rows were inert — SettingsList only fires onChange for rows
  // with values or a submenu, and /preset rows had neither, so the switch
  // the picker promised was impossible. The handler captures a
  // sessionless-capable scope and never creates a session itself.
  // Operation ownership for `/preset` is SHARED across handler invocations: a
  // newer pick supersedes an older one's notification/repaint even on the SAME
  // Session generation.
  let presetOperationToken = 0
  // PRESENTATION ownership for `/preset`: a newer invocation supersedes the
  // previous (loading or loaded) panel, exactly like `/model`'s surface token.
  // It is DISTINCT from `presetOperationToken` (which owns the WRITE): the
  // surface token decides which picker is allowed to hydrate/repaint/close.
  let presetSurfaceToken = 0

  const registerModel = (): void => {
    registerOne({
      name: 'model',
      description: 'Switch the model (and reasoning effort) for this session; before a session exists, change the default when supported',
      handler: async () => {
        const presentation = deps.modelPresentation ?? pituiModelPresentation(app)
        const models = runner.catalog.models
        if (!models.available()) return { kind: 'error', text: 'model service unavailable' }
        // The picker belongs to the Session that opened it: capture BOTH the
        // generation and the identity before the catalog read, then bail
        // silently if either moved (v2 §0.2.5/§0.3.1) — never hydrate a picker
        // with another Session's catalog.
        const scope = runner.captureSessionScope()
        // The SAME synchronous capture for the live write path: a live picker's
        // model write enters the writer section through the exact owner scope,
        // never a bare session id re-resolved after an await.
        const liveScope = runner.captureLiveSessionScope()
        const ownerCurrent = (): boolean => runner.isSessionScopeCurrent(scope)
        /** Commit a selection (model, optional effort) and resolve with its
         *  semantic settlement so the picker stays truthful: a rejected write
         *  keeps the picker usable, a committed/indeterminate one dismisses. */
        const apply = async (next: NonNullable<TuiCommandRunner['defaultIntent']>): Promise<ModelApplyOutcome> => {
          // This operation owns its footer pending marker and notices; a newer
          // selection invalidates that ownership even on the same generation.
          const token = ++modelOperationToken
          // The submitted value must belong to the Session (generation + identity)
          // that OPENED the picker: a switch after the overlay opened must never
          // apply the old operation to the new Session (v2 §0.2.5/§0.3.1).
          if (!runner.isSessionScopeCurrent(scope)) {
            return 'superseded'
          }
          // The captured scope's session id is the admission identity for the
          // write below (the fence above already proved it current).
          const liveSessionId = scope.sessionId
          if (liveSessionId === undefined) {
            // Before a Session exists, `/model` is a global-default intent. It
            // must not create a Session, but it becomes the dynamic creation
            // fallback and is persisted as the global default. The intent is
            // TRANSIENT: a committed save clears it (the next /new reads the
            // persisted default dynamically), a failed save walks the operation
            // ancestry back to the nearest still-pending operation. The save is
            // AWAITED so the picker reports a truthful settlement (a failed or
            // unsupported default write keeps the picker usable).
            runner.setDefaultIntent(next)
            const intentId = runner.defaultIntentRecord?.id
            // The sessionless footer marker is DERIVED from the tracker (see the
            // runner), so recording the intent is enough to show `(selecting…)`.
            runner.refreshStatus()
            runner.updateWelcomeCard()
            // Track the raw write so a fresh create can await its settle before
            // dispatching (the Direct adapter reads the persisted Host default).
            const write = models.saveDefaultSelection(next)
            runner.trackDefaultWrite(write)
            const outcome = await write
            // Settle the transient intent BEFORE the ownership check: a stale
            // operation must never leak a pending tracker entry (which a later
            // failure of the newer op would resurrect as an active ancestor).
            if (intentId !== undefined) {
              runner.settleIntent(intentId, outcome.kind === 'committed'
                ? 'committed'
                : outcome.kind === 'indeterminate' ? 'unresolved' : 'failed')
            }
            // A newer `/model` — or a Session that appeared while the write was in
            // flight — owns the surface: no repaint/notice for a stale operation.
            if (token !== modelOperationToken) return 'superseded'
            if (!runner.isSessionScopeCurrent(scope)) {
              return 'superseded'
            }
            if (outcome.kind !== 'committed') {
              runner.refreshStatus()
              runner.updateWelcomeCard()
              const detail = outcome.kind === 'rejected'
                ? outcome.error.message
                : outcome.kind === 'indeterminate'
                  ? `${outcome.error.message} — the default may still land; reopen /model to reconcile`
                  : outcome.kind === 'unsupported'
                    ? outcome.reason
                    : 'the default model save was cancelled'
              presentation.notify(`model default save: ${detail}`, 'error')
              // An unsupported backend and a proven refusal keep the picker
              // usable; an indeterminate settle dismisses with the notice.
              return outcome.kind
            }
            runner.refreshStatus()
            runner.updateWelcomeCard()
            return 'committed'
          }
          // A live Session model write is NOT a sessionless global-default intent:
          // the official `session.selectModel` best-effort default save is a Host
          // side effect, so the runner's DefaultIntentTracker is reserved for the
          // sessionless path only. Here the Session write settlement plus the
          // pending marker are the whole owned state.
          // The picker-open subject; re-fenced after EVERY await.
          const ownerLost = (): boolean => !runner.isSessionScopeCurrent(scope)
          // The live picker's ONE captured owner scope (the same synchronous
          // capture as `scope`, which was live because `liveSessionId` is).
          if (liveScope === undefined) return 'superseded'
          runner.setModelSelectionPending(next, token)
          let result: Awaited<ReturnType<typeof models.selectSessionModel>>
          try {
            // The whole semantic write runs inside the writer barrier: a
            // transition that started first refuses it before dispatch, and a
            // transition that starts after must wait for it (plan §11.1).
            result = await runner.withWriter(
              liveScope,
              () => models.selectSessionModel(liveSessionId, next, runner.signal),
            )
          } catch (error) {
            // A refused/aborted writer never crossed admission.
            // A newer `/model` owns the marker and the notices.
            if (token !== modelOperationToken) return 'superseded'
            // The subject moved while the write was in flight (writer release vs
            // transition commit): this operation no longer owns the surface, so it
            // makes NO close/open decision and emits no notice (v2 §0.3.1).
            if (ownerLost()) return 'superseded'
            runner.setModelSelectionPending(undefined, token)
            // A transition fence is a proven pre-dispatch refusal; the write
            // may still be retried, so it must not surface as a failure.
            if (!(error instanceof TransitionInProgressError)) {
              presentation.notify(`model selection save: ${safeErrorMessage(error)}`, 'error')
            }
            runner.refreshStatus()
            runner.updateWelcomeCard()
            return error instanceof TransitionInProgressError ? 'cancelled' : 'indeterminate'
          }
          const outcome = result.outcome
          // A newer `/model` owns the footer marker and the notices (v2 §0.2.5).
          if (token !== modelOperationToken) return 'superseded'
          // Ownership is superseded either by the port's own fence OR by the
          // subject moving while the write was in flight. Both mean this result no
          // longer owns the overlay or the footer marker: v2 §0.3.1 requires NO
          // close/open decision, NO repaint (even clearing the in-flight marker
          // repaints a surface this operation no longer owns), and NO stale notice.
          if (ownerLost() || result.ownership === 'superseded') return 'superseded'
          runner.setModelSelectionPending(undefined, token)
          if (outcome.kind === 'rejected') presentation.notify(`model selection: ${outcome.error.message}`, 'error')
          else if (outcome.kind === 'indeterminate') presentation.notify('model selection is indeterminate — the display reconciles from the Session; do not retry', 'error')
          else if (outcome.kind === 'unsupported') presentation.notify(`model selection unsupported: ${outcome.reason}`, 'error')
          // The authoritative Session projection decides the display in
          // every case: a rejected/indeterminate outcome never paints the
          // requested choice as committed.
          runner.refreshStatus()
          runner.updateWelcomeCard()
          return outcome.kind
        }
        // A newer `/model` owns the SURFACE: bump the presentation token and
        // mount the loading panel IMMEDIATELY. The directory read runs as owned
        // background work, so the user gets instant feedback and may type a
        // query while it loads.
        const surfaceToken = ++modelSurfaceToken
        // The write subject is captured BEFORE the first read (v2 §4.1/UX-D15)
        // and is fixed for the panel's whole life: the read never re-derives the
        // subject from a later, possibly different Session.
        const subject = { sessionless: runner.currentSessionId === undefined }
        // ONE directory-read owner for the FIRST read and every Retry. The
        // single `reading` latch is the read epoch: a retry while a read is in
        // flight is refused (RETRY LOADING admits no second read), and a
        // settled response can only belong to the latest token+scope read.
        let reading = false
        const picker = presentation.open({
          subject,
          isCurrent: () => surfaceToken === modelSurfaceToken && ownerCurrent(),
          retry: () => loadOnce(),
          // The picker owns presentation only: brand the effort id here so the
          // official session/global-default write semantics stay untouched.
          apply: (next) => apply(next.reasoningEffort === undefined
            ? { provider: next.provider, model: next.model }
            : { provider: next.provider, model: next.model, reasoningEffort: ReasoningEffortId(next.reasoningEffort) }),
          // The owned-task entry for the semantic write: runOwned with the
          // runner's diag pre-attached (AGENTS.md — never a bare void).
          runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
            runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.currentSessionId })
          },
        })
        const closer = () => { if (surfaceToken === modelSurfaceToken) picker.close() }
        /** Read (or re-read) the directory through the original owner. Never a
         *  second catalog read: the same `loadDirectory`, scope, signal, token
         *  and supersession semantics serve the first read and every Retry. */
        const loadOnce = (): void => {
          if (surfaceToken !== modelSurfaceToken || picker.isDisposed() || reading) return
          reading = true
          picker.setLoading()
          runOwned('model directory', () => models.loadDirectory(runner.signal), {
            diag: runner.diag,
            sessionId: () => runner.currentSessionId,
            // An abort or a typed read supersession is a cancellation, not a
            // failure: the port honors the signal / connection generation, so a
            // rejection that races either must land in the debug channel, never an
            // ERROR diagnostic.
            isCancellation: (error) => picker.isDisposed()
              || surfaceToken !== modelSurfaceToken
              || runner.signal.aborted
              || error instanceof SupersededReadError,
            // A cancelled read (abort / typed supersession) leaves NO trustworthy
            // catalog: close THIS loading panel silently rather than leaving it
            // stuck on Loading… forever. Never close a newer surface (the token
            // guard) and never a panel the user already closed.
            onCancel: () => {
              reading = false
              if (surfaceToken === modelSurfaceToken && !picker.isDisposed()) closer()
            },
            onResult: (directory) => {
              reading = false
              // A newer `/model` owns the surface now.
              if (surfaceToken !== modelSurfaceToken) return
              if (!ownerCurrent()) {
                // The Session moved while loading: this panel belongs to the old
                // subject — close it silently (no hydrate, no notice).
                if (!picker.isDisposed()) closer()
                return
              }
              if (picker.isDisposed()) return
              // An authoritative Host read reconciles a lingering UNRESOLVED
              // sessionless default intent (v2 §0.3.2) — the read is the truth.
              runner.reconcileDefaultIntent(directory.default)
              const sessionId = runner.currentSessionId
              picker.setDirectory({
                directory,
                // PR5 (plan §3.3): a live Session's current value comes from the
                // TRANSPORT-NEUTRAL semantic read `ModelCatalog.sessionSelection`
                // (Direct: the live Agent's selection owner; Remote: the official
                // `modelSelection` projection of the retained binding) — never
                // the Direct-oriented `selected.current` facade, which answers
                // `undefined` on the Remote branch. A sessionless surface
                // highlights the directory default and never fabricates a
                // `current` model. The SUBJECT is the one captured at open: the
                // scope fence above already proved it did not move.
                current: subject.sessionless || sessionId === undefined
                  ? directory.default
                  : models.sessionSelection(sessionId),
              })
            },
            onError: (error) => {
              reading = false
              if (surfaceToken !== modelSurfaceToken) return
              if (!ownerCurrent()) {
                if (!picker.isDisposed()) closer()
                return
              }
              if (picker.isDisposed()) return
              picker.setLoadError(safeErrorMessage(error))
            },
          })
        }
        loadOnce()
        return { kind: 'success' }
      },
    })
  }

  const registerYolo = (): void => {
    registerOne({
      name: 'yolo',
      description: 'Switch to danger-full-access (alias of /permission danger-full-access)',
      handler: async () => {
        const scope = await runner.requireLiveSessionScope()
        // The permission switch is a CONFIG semantic operation (migration
        // M1.9): the Direct adapter still executes the OFFICIAL command line
        // (sandbox + live approval writer + the injected policy-change model
        // message + the preset log) — the raw commands service never crosses
        // into the command surface.
        const outcome = await runner.applyPermissionPreset(scope, 'danger-full-access', signal)
        // PR4-B2-A: every terminal branch keeps its ORIGINAL message — a
        // refused/superseded/unavailable/indeterminate result is never upgraded
        // to success and never triggers an automatic retry. Only the CONFIRMED
        // apply is supplemented below through the TSP-only outcome notice; the
        // error branches keep their existing owner (the Direct command card)
        // and add no second Dock line.
        if (outcome.ownership === 'refused') {
          return { kind: 'error', text: 'the session changed before the permission preset could be applied — try again' }
        }
        if (outcome.ownership === 'superseded') {
          // The operation WAS dispatched (and may already have applied to the
          // previous owner): never claim it did not run and never invite a blind
          // retry — this preset disables approvals, and the retry would target the
          // replacement owner.
          return {
            kind: 'error',
            text: 'the session changed after the permission operation was dispatched — do not retry blindly',
          }
        }
        if (outcome.outcome.kind === 'unavailable') {
          return { kind: 'error', text: outcome.outcome.cause === 'commands'
            ? 'commands service unavailable'
            : '/permission unavailable (permission presets not composed)' }
        }
        if (outcome.outcome.kind === 'indeterminate') {
          // §6.3: dispatched but unobservable — never claim failure, never
          // invite a retry (this preset disables approvals).
          return {
            kind: 'error',
            text: 'the permission switch was dispatched but its result is unknown — check the footer before relying on it; do not retry blindly',
          }
        }
        notifyOutcome('danger-full-access — approvals off')
        return { kind: 'success', text: 'danger-full-access — approvals off' }
      },
    })
  }

  const registerPreset = (): void => {
    registerOne({
      name: 'preset',
      definitionId: TUI_PRESET_COMMAND_DEFINITION_ID,
      description: 'Show or switch the session agent preset',
      input: { hint: '[status|<id>|default [<id>]]' },
      handler: async (invocation) => {
        const presets = runner.catalog.presets
        if (!presets.available()) {
          return { kind: 'error', text: 'agent presets unavailable in this deployment' }
        }
        // The ONE presentation seam: the native TSP preset picker when the
        // mounted renderer installed one, otherwise the original PiTui overlay.
        // It is resolved per invocation and never dereferences an `app` on the
        // TSP branch (no `TuiApp` exists there; the post-classification
        // capability admission refuses `/preset` before this handler).
        const native = deps.presetPresentation
        const presentation = native ?? pituiPresetPresentation(app)
        const notify = presentation.notify
        // EVERY `/preset` invocation owns the presentation surface: a newer one
        // retires whatever panel the previous invocation opened, while an
        // already-admitted Host write still settles through its own owner. The
        // bare `/preset` below reuses this one token for its whole panel life.
        const surfaceToken = ++presetSurfaceToken
        /**
         * A notice is owned by BOTH markers: the operation token fences the
         * WRITE's settlement (inside `applyPresetSelection`) and this fences the
         * DISPLAY. A newer `/preset` invocation takes a new surface token, so an
         * operation it did not start can never write a line onto its panel or
         * dock — while the already-admitted Host write still settles through its
         * own owner (closing a panel never cancels a write).
         */
        const notifyOwned = (text: string, kind: 'info' | 'error'): void => {
          if (surfaceToken === presetSurfaceToken) notify(text, kind)
        }
        // The live composition is the runner's own read (Direct ownership);
        // the roster catalog the command surface needs is the port's. Every
        // session-dependent decision re-fences against the captured scope at
        // its own operation boundary so an await cannot apply a stale Session.
        const displayedDefault = async (): Promise<string | undefined> =>
          runner.config.presetDefault.get() ?? presets.defaultId()
        const presetErrorText = (error: unknown): string => safeErrorMessage(error)
        /**
         * The ONE new-session-default writer: the typed `/preset default <id>`
         * verb and the picker's `Set as default for new sessions` row call THIS
         * function, so the validate/config-write/standing-refresh contract is
         * never duplicated. It persists the default for FUTURE sessions only;
         * the current Session, the run-local pending preset and the live catalog
         * are untouched.
         */
        const setPresetDefault = async (id: string): Promise<void> => {
          // Validate before writing settings. `code` is legal when the current
          // DSH roster contains a custom preset with that id; an unknown code
          // remains an ordinary unknown-preset failure and is never aliased.
          await presets.resolve(id, runner.signal)
          await runner.config.presetDefault.set(id)
          // The saved default only affects sessions created from now on. A
          // standing catalog refresh follows ONLY when no higher-precedence
          // override (run-local pending or launch-time --preset) masks the
          // new default — the masked case must not re-read a preset the next
          // session will not compose on.
          if (runner.effectivePresetId === undefined) {
            const outcome = await runner.refreshStandingCatalog(id, 'preset')
            if (outcome.kind === 'applied' && outcome.notice !== undefined) notifyOwned(outcome.notice, 'error')
          }
        }
        const matched = invocation.rawInput.trim().match(/^(\S+)(?:\s+(.*))?$/)
        const verb = matched?.[1] ?? ''
        const rest = matched?.[2]?.trim() ?? ''
        if (verb === 'status') {
          // Re-read the live preset at use time: the roster await above must not
          // let a stale capture describe the current Session.
          return { kind: 'success', text: `preset: ${runner.currentPreset() ?? 'none'} · default: ${await displayedDefault()}` }
        }
        if (verb === 'default') {
          if (!runner.config.presetDefault.available()) return { kind: 'error', text: 'settings service unavailable' }
          if (rest === '') {
            return { kind: 'success', text: `default preset: ${await displayedDefault()}` }
          }
          try {
            await setPresetDefault(rest)
          } catch (error) {
            return { kind: 'error', text: presetErrorText(error) }
          }
          return { kind: 'success', text: `default preset set: ${rest}` }
        }
        // Selecting swaps the composition; only a blank session may do so — a
        // started conversation's history was produced under its preset's tools.
        // The Host owns the blank check, the recompose transaction and the
        // durable `agent-preset/selected` commit (official `agentPresets.select`);
        // the TUI transition gate only prevents local interleaving with /new,
        // /fork, rewind or a Session switch. With no session at all the choice
        // lands on the run-local pending preset the next session composes on
        // (nothing is created here).
        // Operation ownership for `/preset` (shared across invocations, declared
        // beside the registration): a newer pick supersedes an older one's
        // notification/repaint even on the SAME Session generation.
        const applyPresetSelection = async (id: string, pickerOwner?: SessionScope):
          Promise<
            | { kind: 'pending'; preset: string }
            | { kind: 'switched'; preset: string }
            | { kind: 'superseded' }
            | { kind: 'locked'; sessionId: string }
            | { kind: 'rejected'; message: string }
            | { kind: 'indeterminate'; message: string }
          > => {
          const token = ++presetOperationToken
          // The semantic subject is captured ONCE, when the operation starts: a
          // picker passes the scope it was opened on; the typed verb path captures
          // the CURRENT subject here. Every await below re-fences it, so the
          // subject can never drift onto a Session that appeared later.
          const owner = pickerOwner ?? runner.captureSessionScope()
          const ownerCurrent = (): boolean => runner.isSessionScopeCurrent(owner)
          try {
          const sessionId = owner.sessionId
          if (sessionId === undefined) {
            const resolved = await presets.resolve(id, runner.signal)
            // A roster that vanished between the availability check and the
            // resolve is a hard failure (the old compose path threw too) —
            // never a "preset undefined" success.
            if (resolved.id === undefined) throw new Error('agent presets unavailable in this deployment')
            // A Session (or a newer pick) appeared while the resolve awaited: the
            // sessionless subject is gone — superseded, never staged onto the
            // now-live surface (v2 §0.2.5).
            if (token !== presetOperationToken) return { kind: 'superseded' }
            if (!ownerCurrent()) return { kind: 'superseded' }
            runner.pendingPreset = resolved.id
            // The sessionless catalog follows the choice through the STANDING
            // scope of the new preset (no Agent, no session — composition
            // probes are disabled in this deployment, see
            // docs/surface-catalog.md). A failed read degrades inside the
            // coordinator: the choice itself still applies.
            const outcome = await runner.refreshStandingCatalog(resolved.id, 'preset')
            if (token !== presetOperationToken) return { kind: 'superseded' }
            if (!ownerCurrent()) return { kind: 'superseded' }
            if (outcome.kind === 'applied' && outcome.notice !== undefined) notifyOwned(outcome.notice, 'error')
            return { kind: 'pending', preset: resolved.id }
          }
          // The live-session preset swap runs INSIDE the session-transition
          // gate: the official recompose + `agent-preset/selected` append must
          // never interleave with a concurrent /new, /fork, rewind or switch.
          // The subject is revalidated INSIDE the gate, so a transition during
          // the roster read can never switch the OLD Session (Direct) or dispatch
          // a stale id (Remote).
          const result = await runner.withSessionTransition(() => {
            if (!ownerCurrent()) {
              // The subject changed before dispatch: nothing was sent, and this
              // operation no longer owns the surface — superseded, never a
              // user-visible rejection (§0.2.1).
              return Promise.resolve<OperationResult<{ readonly preset: string }>>({
                ownership: 'superseded',
                outcome: { kind: 'cancelled' },
              })
            }
            return presets.selectSessionPreset(sessionId, id, runner.signal)
          })
          // Fence BEFORE classification: if the subject or operation ownership
          // moved while the Host transition was in flight, this operation no
          // longer owns the surface — it must not surface a stale rejection or
          // notice (v2 §0.2.5/§0.3.1).
          if (token !== presetOperationToken) return { kind: 'superseded' }
          if (!ownerCurrent()) return { kind: 'superseded' }
          // A superseded operation owns nothing: no notice, no repaint.
          if (result.ownership === 'superseded') return { kind: 'superseded' }
          const outcome = result.outcome
          if (outcome.kind === 'rejected') {
            if (outcome.error.code === 'agent-preset/locked') return { kind: 'locked', sessionId }
            return { kind: 'rejected', message: outcome.error.message }
          }
          if (outcome.kind === 'indeterminate') {
            return { kind: 'indeterminate', message: outcome.error.message }
          }
          if (outcome.kind !== 'committed') {
            return { kind: 'rejected', message: 'preset switch was cancelled' }
          }
          // The still-blank session's agent layer changed: refresh the live
          // catalog for the SAME owner (no transition — the old scoped
          // previews are being replaced by the new composition's). A late
          // commit from a replaced surface must not repaint it.
          const refreshed = await runner.refreshSessionCatalog(owner, 'preset')
          // Fence after the refresh await: a newer operation or a moved subject
          // owns the surface, and a superseded refresh must not repaint.
          if (token !== presetOperationToken) return { kind: 'superseded' }
          if (!ownerCurrent()) return { kind: 'superseded' }
          if (refreshed.kind !== 'superseded') runner.updateWelcomeCard()
          return { kind: 'switched', preset: outcome.value.preset }
          } catch (error) {
            // A newer `/preset` operation — or a superseded/aborted read — owns
            // the surface: an error from this stale operation must not surface a
            // stale notice (v2 §0.2.1/§0.2.3).
            if (token !== presetOperationToken) return { kind: 'superseded' }
            if (error instanceof SupersededReadError || !ownerCurrent() || runner.signal.aborted) {
              return { kind: 'superseded' }
            }
            throw error
          }
        }
        const lockedPresetMessage = (sessionId: string): string =>
          `session "${sessionId}" has already started; its agent preset is fixed — preset switching is only available in a new session`
        /**
         * The picker's explicit `Use`: the ORIGINAL session-preset write plus the
         * ORIGINAL outcome notices, resolved with the semantic settlement so the
         * presenter stays truthful — a rejected/locked write keeps the picker
         * usable, a pending/switched/indeterminate one dismisses it.
         */
        const pickPreset = async (id: string, owner?: SessionScope): Promise<PresetApplyOutcome> => {
          let outcome: Awaited<ReturnType<typeof applyPresetSelection>>
          try {
            outcome = await applyPresetSelection(id, owner)
          } catch (error) {
            const message = presetErrorText(error)
            notifyOwned(message, 'error')
            return { kind: 'rejected', message }
          }
          if (outcome.kind === 'pending') {
            notifyOwned(`new sessions will start on preset ${outcome.preset}`, 'info')
          } else if (outcome.kind === 'switched') {
            notifyOwned(`session preset switched to ${outcome.preset}`, 'info')
          } else if (outcome.kind === 'superseded') {
            // A newer pick owns the surface: the notice would only describe an
            // already-superseded switch.
          } else if (outcome.kind === 'locked') {
            notifyOwned(lockedPresetMessage(outcome.sessionId), 'error')
          } else if (outcome.kind === 'indeterminate') {
            notifyOwned(`${outcome.message} — the displayed preset reconciles from the Session; do not retry`, 'error')
          } else {
            notifyOwned(outcome.message, 'error')
          }
          return outcome
        }
        if (verb !== '') {
          try {
            const outcome = await applyPresetSelection(verb)
            if (outcome.kind === 'pending') {
              return { kind: 'success', text: `new sessions will start on preset ${outcome.preset}` }
            }
            if (outcome.kind === 'switched') {
              return { kind: 'success', text: `session preset switched to ${outcome.preset}` }
            }
            if (outcome.kind === 'superseded') {
              // v2 §0.2.1: a superseded operation owns nothing — no notice, no
              // repaint, no close decision, and no success text.
              return { kind: 'success' }
            }
            if (outcome.kind === 'locked') {
              const message = lockedPresetMessage(outcome.sessionId)
              notifyOwned(message, 'error')
              return { kind: 'error', text: message }
            }
            if (outcome.kind === 'indeterminate') {
              // True indeterminate: the Host may have committed the switch, so
              // restoring the typed command would arm an implicit retry. Suppress
              // it; a KNOWN rejection (writer-held included) settles through
              // `outcome.kind === 'rejected'` below and is restored.
              recordCommandDraftDisposition(invocation.commandId, 'suppressed')
              const message = `${outcome.message} — the displayed preset reconciles from the Session; do not retry`
              notifyOwned(message, 'error')
              return { kind: 'error', text: message }
            }
            notifyOwned(outcome.message, 'error')
            return { kind: 'error', text: outcome.message }
          } catch (error) {
            return { kind: 'error', text: presetErrorText(error) }
          }
        }
        // The picker belongs to the EXACT Session that opened it (the captured
        // scope pins the owner and the session id — a sessionless capture
        // included): a switch during the roster read must not paint the old
        // current preset (or the old blankness) onto the new Session's picker.
        const pickerScope = runner.captureSessionScope()
        const pickerOwnerCurrent = (): boolean => runner.isSessionScopeCurrent(pickerScope)
        // A started conversation's history was produced under its preset's
        // tools: `Use preset` is impossible, so no selectable picker opens at
        // all (the typed /preset <id> path above refuses the same way and keeps
        // its message). Blankness comes from the Host turn-boundary authority,
        // never from the TUI transcript; an unknown blank state opens the
        // picker and lets the Host be the final authority.
        if (pickerScope.sessionId !== undefined && runner.sessionBlank() === false) {
          const message = `preset switching is only available in a new session — session "${pickerScope.sessionId}" has already started; its preset is fixed (use /new for a fresh session, or /preset default <id> for future sessions)`
          notifyOwned(message, 'error')
          return { kind: 'error', text: message }
        }
        // The surface token was taken at the top of this invocation. The NATIVE
        // picker mounts its loading panel IMMEDIATELY and runs the roster read as
        // owned background work, so the user gets instant feedback and may type a
        // query while it loads. The PiTui adapter keeps its ORIGINAL settlement:
        // the read is awaited inside this handler, so its own success text, its
        // thrown read failure and the command path's draft disposition are
        // unchanged.
        // The write subject is captured BEFORE the first read and is fixed for
        // the panel's whole life: the read never re-derives the subject from a
        // later, possibly different Session.
        const subject = { sessionless: pickerScope.sessionId === undefined }
        // ONE roster-read owner for the FIRST read and every Retry. The single
        // `reading` latch is the read epoch: a retry while a read is in flight
        // is refused, and a settled response can only belong to the latest
        // token+scope read.
        let reading = false
        const picker = presentation.open({
          subject,
          isCurrent: () => surfaceToken === presetSurfaceToken && pickerOwnerCurrent(),
          retry: () => loadOnce(),
          apply: (id) => pickPreset(id, pickerScope),
          setDefault: (id) => savePresetDefault(id),
          // The owned-task entry for the semantic writes: runOwned with the
          // runner's diag pre-attached (AGENTS.md — never a bare void).
          runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
            runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.currentSessionId })
          },
        })
        const closer = () => { if (surfaceToken === presetSurfaceToken) picker.close() }
        /**
         * The picker's explicit `Set as default for new sessions` row: the SAME writer the
         * typed `/preset default <id>` verb calls. The settings write raises
         * instead of returning a `WriteOutcome`, so a failure is reported as
         * `unconfirmed` — never as a proven rollback, and never retried.
         */
        const savePresetDefault = async (id: string): Promise<PresetDefaultOutcome> => {
          if (!runner.config.presetDefault.available()) {
            return { kind: 'unconfirmed', message: 'settings service unavailable' }
          }
          try {
            await setPresetDefault(id)
          } catch (error) {
            // A newer `/preset` owns the surface: its notice describes a
            // different invocation.
            if (surfaceToken !== presetSurfaceToken) return { kind: 'superseded' }
            const message = presetErrorText(error)
            notifyOwned(`default preset save: ${message}`, 'error')
            return { kind: 'unconfirmed', message }
          }
          if (surfaceToken !== presetSurfaceToken) return { kind: 'superseded' }
          notifyOwned(`new-session default set: ${id} — changes new sessions only; the current session is unchanged`, 'info')
          return { kind: 'saved', preset: id }
        }
        /** Read (or re-read) the roster through the original owner. Never a
         *  second catalog read: the same scope, signal, token and supersession
         *  semantics serve the first read and every Retry. */
        const loadOnce = (): void => {
          if (surfaceToken !== presetSurfaceToken || picker.isDisposed() || reading) return
          reading = true
          picker.setLoading()
          runOwned('preset roster', async () => {
            const roster = await presets.roster(runner.signal)
            // The effective default needs BOTH the roster and the config
            // read; the caller paints nothing until the fence below re-proves
            // the subject.
            return { roster, defaultId: roster.defaultId ?? await displayedDefault() }
          }, {
            diag: runner.diag,
            sessionId: () => runner.currentSessionId,
            // An abort or a typed read supersession is a cancellation, not a
            // failure: the port honors the signal / connection generation, so a
            // rejection that races either must land in the debug channel, never
            // an ERROR diagnostic.
            isCancellation: (error) => picker.isDisposed()
              || surfaceToken !== presetSurfaceToken
              || runner.signal.aborted
              || error instanceof SupersededReadError,
            // A cancelled read (abort / typed supersession) leaves NO
            // trustworthy roster: close THIS loading panel silently rather than
            // leaving it stuck on Loading… forever. Never close a newer surface
            // (the token guard) and never a panel the user already closed.
            onCancel: () => {
              reading = false
              if (surfaceToken === presetSurfaceToken && !picker.isDisposed()) closer()
            },
            onResult: (read) => {
              reading = false
              // A newer `/preset` owns the surface now.
              if (surfaceToken !== presetSurfaceToken) return
              if (!pickerOwnerCurrent()) {
                // The Session moved while loading: this panel belongs to the old
                // subject — close it silently (no hydrate, no notice).
                if (!picker.isDisposed()) closer()
                return
              }
              if (picker.isDisposed()) return
              // Re-read the live facts AFTER the awaits: never mark a stale
              // `current`, a stale pending or a stale default. The SUBJECT is
              // the one captured at open — the fence above proved it did not
              // move — so a sessionless panel never fabricates a Current and a
              // live panel never invents a Next-session pending.
              picker.setRoster({
                roster: read.roster,
                currentId: subject.sessionless ? undefined : runner.currentPreset(),
                pendingId: subject.sessionless ? runner.pendingPreset : undefined,
                defaultId: read.defaultId,
                canSetDefault: runner.config.presetDefault.available(),
              })
            },
            onError: (error) => {
              reading = false
              if (surfaceToken !== presetSurfaceToken) return
              if (!pickerOwnerCurrent()) {
                if (!picker.isDisposed()) closer()
                return
              }
              if (picker.isDisposed()) return
              picker.setLoadError(safeErrorMessage(error))
            },
          })
        }
        if (native !== undefined) {
          // The native TSP path: the panel is already mounted in its loading
          // state and the ONE read owner hydrates it in the background.
          loadOnce()
          return { kind: 'success' }
        }
        // ── the PiTui path: the ORIGINAL command settlement ──
        // The same read owner (`presets.roster` under the captured scope and
        // signal) is awaited here, so the handler keeps its own result: the
        // frozen empty-roster text, and a real read failure rethrown to the
        // command path (which owns the failure notice and the draft restore).
        try {
          const roster = await presets.roster(runner.signal)
          if (!pickerOwnerCurrent()) {
            picker.close()
            return { kind: 'success' }
          }
          if (roster.presets.length === 0) {
            picker.close()
            return { kind: 'success', text: 'no agent presets configured' }
          }
          const defaultId = roster.defaultId ?? await displayedDefault()
          // Re-check AFTER the displayedDefault await too: a Session switch during
          // it must not mix the old roster/default with the new Session's state.
          if (!pickerOwnerCurrent()) {
            picker.close()
            return { kind: 'success' }
          }
          picker.setRoster({
            roster,
            currentId: subject.sessionless ? undefined : runner.currentPreset(),
            pendingId: subject.sessionless ? runner.pendingPreset : undefined,
            defaultId,
            canSetDefault: runner.config.presetDefault.available(),
          })
          return { kind: 'success' }
        } catch (error) {
          picker.close()
          // A superseded/aborted read no longer owns the surface: stay silent
          // instead of surfacing a stale roster failure (v2 §0.2.3/§0.3.1).
          if (error instanceof SupersededReadError || !pickerOwnerCurrent() || runner.signal.aborted) {
            return { kind: 'success' }
          }
          throw error
        }
      },
    })
  }

  return { registerModel, registerYolo, registerPreset }
}
