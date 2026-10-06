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
import { SettingsList } from '@xmoon76/pi-tui'
import type { TuiApp } from '../../tui-app.ts'
import type { SessionScope } from '../../app/session/scope.ts'
import { TransitionInProgressError } from '../../session-operation-barrier.ts'
import { isCancellation, runOwned, type OwnedTaskOptions } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { ModelPicker, type ModelApplyOutcome } from '../../model-picker.ts'
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
  registerOne: RegisterOne
  recordCommandDraftDisposition: (commandId: string | undefined, disposition: 'restored' | 'suppressed') => void
}

export interface ModelCommandRegistrars {
  registerModel(): void
  registerYolo(): void
  registerPreset(): void
}

/**
 * Display copy for the four shipped agent presets, fixed in English — the
 * web surface's `BUILT_IN_PRESET_KEYS` mapping (`dsh-agent-preset-registry`
 * display helpers), TUI-side. The shipped declarations publish no `name`
 * (the official built-in classification), and their metadata language is
 * not ours to control: mapping the known ids keeps the picker English
 * regardless of what the declarations say; everything else renders the
 * declaration's own metadata. Names follow the upstream English locale.
 */
const BUILT_IN_PRESET_COPY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  },
  ptc: {
    name: 'PTC mode',
    description: 'All Standard mode capabilities, with tools exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'Minimal coding agent with a persistent shell.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
}

/** Whether one roster row is a SHIPPED preset under the official 0.1.7
 * classification: a known shipped id that publishes no `name` of its own.
 * A declaration that names itself — even with a shipped id — owns its
 * copy (the same rule as `isBuiltInPreset` upstream; kept local so the
 * display layer carries no runtime import). */
export function isBuiltInPresetRow(preset: {
  id: string
  name?: string
  description?: string
}): boolean {
  return preset.name === undefined && BUILT_IN_PRESET_COPY[preset.id] !== undefined
}

/** Resolve one roster row's display copy: the TUI's fixed English copy for
 * a shipped preset (official classification above), otherwise the preset's
 * own published metadata — a user-authored copy is never translated. */
export function presetDisplayText(preset: {
  id: string
  name?: string
  description?: string
}): { name: string; description?: string } {
  const builtIn = isBuiltInPresetRow(preset) ? BUILT_IN_PRESET_COPY[preset.id] : undefined
  if (builtIn !== undefined) return { name: builtIn.name, description: builtIn.description }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}

/**
 * Create the model/permission-preset registrars over the coordinator's
 * primitives. The factory only closes over its dependencies; it registers
 * nothing until one of the returned registrars is called at its frozen
 * position.
 */
export function createModelCommands(deps: ModelCommandDeps): ModelCommandRegistrars {
  const { runner, app, registerOne, recordCommandDraftDisposition } = deps
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

  const registerModel = (): void => {
    registerOne({
      name: 'model',
      description: 'Switch the model (and reasoning effort) for this session; before a session exists, change the default when supported',
      handler: async () => {
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
              app.notify(`model default save: ${detail}`, 'error')
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
              app.notify(`model selection save: ${safeErrorMessage(error)}`, 'error')
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
          if (outcome.kind === 'rejected') app.notify(`model selection: ${outcome.error.message}`, 'error')
          else if (outcome.kind === 'indeterminate') app.notify('model selection is indeterminate — the display reconciles from the Session; do not retry', 'error')
          else if (outcome.kind === 'unsupported') app.notify(`model selection unsupported: ${outcome.reason}`, 'error')
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
        // The picker's `close` closure needs the mounted overlay's closer; it is
        // assigned right after the picker is constructed and only ever invoked
        // later (a user Esc/settlement), never during construction.
        let closer: () => void = () => {}
        const picker = new ModelPicker({
          // The picker owns presentation only: brand the effort id here so the
          // official session/global-default write semantics stay untouched.
          apply: (next) => apply(next.reasoningEffort === undefined
            ? { provider: next.provider, model: next.model }
            : { provider: next.provider, model: next.model, reasoningEffort: ReasoningEffortId(next.reasoningEffort) }),
          requestRender: () => app.requestRender(),
          // Close only while this surface still owns the picker slot; a superseded
          // panel must never tear down the newer one.
          close: () => { if (surfaceToken === modelSurfaceToken) closer() },
          // The owned-task entry for the semantic write: runOwned with the
          // runner's diag pre-attached (AGENTS.md — never a bare void).
          runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
            runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.currentSessionId })
          },
        })
        closer = app.openModelPicker(picker)
        // ONE owned Host-generation directory read hydrates the SAME already
        // mounted picker IN PLACE (never a second overlay). openModelPicker
        // supersedes any previous /model picker surface.
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
            if (surfaceToken === modelSurfaceToken && !picker.isDisposed()) closer()
          },
          onResult: (directory) => {
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
            const sessionless = runner.currentSessionId === undefined
            picker.setDirectory({
              directory,
              // PR5 (plan §3.3): a live Session's current value comes from the
              // TRANSPORT-NEUTRAL semantic read `ModelCatalog.sessionSelection`
              // (Direct: the live Agent's selection owner; Remote: the official
              // `modelSelection` projection of the retained binding) — never
              // the Direct-oriented `selected.current` facade, which answers
              // `undefined` on the Remote branch. A sessionless surface
              // highlights the directory default and never fabricates a
              // `current` model.
              current: sessionless
                ? directory.default
                : models.sessionSelection(runner.currentSessionId),
              sessionless,
            })
          },
          onError: (error) => {
            if (surfaceToken !== modelSurfaceToken) return
            if (!ownerCurrent()) {
              if (!picker.isDisposed()) closer()
              return
            }
            if (picker.isDisposed()) return
            picker.setLoadError(safeErrorMessage(error))
          },
        })
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
        // The live composition is the runner's own read (Direct ownership);
        // the roster catalog the command surface needs is the port's. Every
        // session-dependent decision re-fences against the captured scope at
        // its own operation boundary so an await cannot apply a stale Session.
        const displayedDefault = async (): Promise<string | undefined> =>
          runner.config.presetDefault.get() ?? presets.defaultId()
        const presetErrorText = (error: unknown): string => safeErrorMessage(error)
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
          // The saved default only affects sessions created from now on. A
          // standing catalog refresh follows ONLY when no higher-precedence
          // override (run-local pending or launch-time --preset) masks the
          // new default — the masked case must not re-read a preset the next
          // session will not compose on.
          try {
            // Validate before writing settings. `code` is legal when the current
            // DSH roster contains a custom preset with that id; an unknown code
            // remains an ordinary unknown-preset failure and is never aliased.
            await presets.resolve(rest, runner.signal)
            await runner.config.presetDefault.set(rest)
          } catch (error) {
            return { kind: 'error', text: presetErrorText(error) }
          }
          if (runner.effectivePresetId === undefined) {
            const outcome = await runner.refreshStandingCatalog(rest, 'preset')
            if (outcome.kind === 'applied' && outcome.notice !== undefined) app.notify(outcome.notice, 'error')
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
            if (outcome.kind === 'applied' && outcome.notice !== undefined) app.notify(outcome.notice, 'error')
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
        const pickPreset = async (id: string, owner?: SessionScope): Promise<void> => {
          let outcome: Awaited<ReturnType<typeof applyPresetSelection>>
          try {
            outcome = await applyPresetSelection(id, owner)
          } catch (error) {
            app.notify(presetErrorText(error), 'error')
            return
          }
          if (outcome.kind === 'pending') {
            app.notify(`new sessions will start on preset ${outcome.preset}`, 'info')
          } else if (outcome.kind === 'switched') {
            app.notify(`session preset switched to ${outcome.preset}`, 'info')
          } else if (outcome.kind === 'superseded') {
            // A newer pick owns the surface: the notice would only describe an
            // already-superseded switch.
          } else if (outcome.kind === 'locked') {
            app.notify(lockedPresetMessage(outcome.sessionId), 'error')
          } else if (outcome.kind === 'indeterminate') {
            app.notify(`${outcome.message} — the displayed preset reconciles from the Session; do not retry`, 'error')
          } else {
            app.notify(outcome.message, 'error')
          }
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
              app.notify(message, 'error')
              return { kind: 'error', text: message }
            }
            if (outcome.kind === 'indeterminate') {
              // True indeterminate: the Host may have committed the switch, so
              // restoring the typed command would arm an implicit retry. Suppress
              // it; a KNOWN rejection (writer-held included) settles through
              // `outcome.kind === 'rejected'` below and is restored.
              recordCommandDraftDisposition(invocation.commandId, 'suppressed')
              const message = `${outcome.message} — the displayed preset reconciles from the Session; do not retry`
              app.notify(message, 'error')
              return { kind: 'error', text: message }
            }
            app.notify(outcome.message, 'error')
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
        let roster
        try {
          roster = await presets.roster(runner.signal)
        } catch (error) {
          // A superseded/aborted read no longer owns the surface: stay silent
          // instead of surfacing a stale roster failure (v2 §0.2.3/§0.3.1).
          if (error instanceof SupersededReadError || !pickerOwnerCurrent() || runner.signal.aborted) {
            return { kind: 'success' }
          }
          throw error
        }
        if (!pickerOwnerCurrent()) return { kind: 'success' }
        if (roster.presets.length === 0) return { kind: 'success', text: 'no agent presets configured' }
        const defaultId = roster.defaultId ?? await displayedDefault()
        // Re-check AFTER the displayedDefault await too: a Session switch during
        // it must not mix the old roster/default with the new Session's state.
        if (!pickerOwnerCurrent()) return { kind: 'success' }
        // Re-read the live preset AFTER the awaits: never mark a stale `current`.
        const current = runner.currentPreset()
        // A started conversation's history was produced under its preset's
        // tools: offer no selectable roster — say why instead (the typed
        // /preset <id> path above refuses the same way). Blankness comes from
        // the Host turn-boundary authority, never from the TUI transcript; an
        // unknown blank state opens the picker and lets the Host be the final
        // authority. Fence BEFORE the notify/openSettings UI mutation.
        if (!pickerOwnerCurrent()) return { kind: 'success' }
        if (runner.sessionBlank() === false) {
          const message = `preset switching is only available in a new session — session "${pickerScope.sessionId}" has already started; its preset is fixed (use /new for a fresh session, or /preset default <id> for future sessions)`
          app.notify(message, 'error')
          return { kind: 'error', text: message }
        }
        const close = app.openSettings(
          roster.presets.map(preset => {
            const display = presetDisplayText(preset)
            return {
              id: preset.id,
              label: `${display.name} (${preset.id})`,
              description: [
                display.description,
                isBuiltInPresetRow(preset) ? 'system' : 'user',
                preset.id === defaultId ? 'default' : undefined,
                preset.id === current ? '← current' : undefined,
                preset.broken,
              ].filter(Boolean).join(' · '),
              currentValue: '',
              // The values entry makes SettingsList.activateItem fire
              // onChange on Enter/Space (rows without values or a submenu
              // are inert) — one key confirms the switch while the selected
              // row's description still renders in full below the list.
              values: [preset.id],
            }
          }),
          (id) => {
            close()
            // The picker's selection is an async result-consuming flow: the
            // outcome drives the notices — runOwned (AGENTS.md), never a bare
            // void; cancellation (a torn-down TUI) is debug-only.
            runOwned('preset pick', () => pickPreset(id, pickerScope), {
              diag: runner.diag,
              sessionId: () => runner.currentSessionId,
              onError: (error) => app.notify(`preset selection failed: ${safeErrorMessage(error)}`, 'error'),
            })
          },
          () => {},
        )
        return { kind: 'success' }
      },
    })
  }

  return { registerModel, registerYolo, registerPreset }
}
