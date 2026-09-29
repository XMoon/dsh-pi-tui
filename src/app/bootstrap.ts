/**
 * The application composition root (plan §22/§23): the ONE place that reads
 * the process/Cordis startup prerequisites, creates the runner lifetime
 * controller and diagnostics, resolves the Host services, and connects the
 * application owners — Direct application runtime, session ownership/runtime,
 * submission runtime, the mounted surface runtime and the command facade —
 * then owns startup failure and teardown.
 *
 * It is composition, never a business domain: the algorithms, state machines
 * and presentation folds live in their owners (`app/direct`, `app/session`,
 * `app/submission`, `app/command`, `app/surface`) and the top-level
 * presentation modules. M3 starts here: replacing the Direct creation seam
 * below is a composition change, not a rewrite of those owners.
 *
 * The package entry calls {@link applyRunner} and keeps the Cordis contract,
 * so the dependency direction stays one-way (`index -> app/bootstrap`).
 * @module @xmoon76/dsh-pi-tui/app/bootstrap
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { selectBlankSessionPreset, sessionPresetOf } from '../runtime/direct/session-preset-direct.ts'
import { DirectTuiSettings, type SettingsFormsLike } from '../runtime/direct/tui-settings-direct.ts'
import type { DefaultModelServiceLike } from '../runtime/direct/model-selection-direct.ts'
import { rawSelectionFromRequestHeader } from '../model-selection.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-jobs'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-credentials'
import { TUI_STARTUP_SERVICE } from '../startup.ts'
import { createSessionPresentation } from './surface/session-presentation.ts'
import { createStatusRuntime } from './surface/status-runtime.ts'
import { createInputHistory } from './surface/input-history.ts'
import { createSettingsRuntime } from './surface/settings-runtime.ts'
import { createApplicationEvents, type ApplicationEventsOwner } from './surface/application-events.ts'
import { createClientActions } from './surface/client-actions.ts'
import { createModelSelectionOwner } from './command/model-selection.ts'
import { createCommandSurface, type CommandSurface } from './command/surface.ts'
import { createArtifactSaveOwner } from './command/artifacts.ts'
import { createLocalShell, type LocalShellCapability } from './submission/local-shell.ts'
import { createSubmissionController, type LocalCommandHandler } from './submission/controller.ts'
import { createViewerRuntime, type ViewerRuntime } from './surface/viewer-runtime.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from '../present.ts'
import { parseProgressUpdates, parseResponseStyle, type ProgressUpdatesState, type ResponseStyleState } from '../communication-policy.ts'
import { parseGitAttributionMode, type GitAttributionState } from '../git-attribution.ts'
import { resolveDisplayPreset, type DisplayState } from '../display-preset.ts'
import { DISABLE_FOCUS_REPORTING } from '../notification/terminal-focus.ts'
import { guardedStreamWriter } from '../notification/terminal-notifier.ts'
import { computeStats } from '../stats.ts'
import { isAssistantTokenDelta } from '../token-usage.ts'
import { projectedPlanActive, type PlanProjectionLike } from '../status/derive-plan.ts'
import { migrateLegacySettings } from '../legacy-settings-migration.ts'
import { color } from '../theme.ts'
import type { TuiApp } from '../tui-app.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../extensions.ts'
import { type CommandRegistryLike, type TuiCommandRunner } from '../commands.ts'
import { diagFromEnv, dshHome, type Diag } from '../diag.ts'
import { runDetached, runOwned, type OwnedTaskOptions } from '../detached.ts'
import { FileHistorySearchSource } from '../history-search.ts'
import { safeErrorMessage } from '../error-boundary.ts'
import { DraftImageStore } from '../image/draft-store.ts'
import { DraftFileStore } from '../attachment/file-draft.ts'
import { openExternalUrl } from '../open-url.ts'
import { createStartupStatus } from '../startup-status.ts'
import { iconStyleOf } from '../icons.ts'
import { checkImageLimits } from '../image/intake.ts'
import { ImageLoadError } from '../image/errors.ts'
import { consumeDraftAttachments, type PrepareInputDeps } from '../image/submit.ts'
import { dshVersion } from '../dsh-version.ts'
import { createExitController } from '../exit.ts'
import { type SessionRetirementReport } from '../app/session/owner-access.ts'
import { mergeDraft, refuseByTransitionFence, type SteerAgentLike } from '../steer.ts'
import { createDirectApplicationRuntime } from '../app/direct/runtime.ts'
import { createSessionOwnershipCore } from '../app/session/ownership-core.ts'
import { bindSessionRuntime } from '../app/session/runtime.ts'
import { createSessionScopeAuthority, type LiveSessionScope } from '../app/session/scope.ts'
import { bindSubmissionRuntime, type SubmissionRuntime } from '../app/submission/runtime.ts'
import type { SessionOwnerRef, SessionSubject } from '../app/session/subject.ts'
import { createSurfaceRuntime } from '../app/surface/runtime.ts'
import { type SessionQueryLike } from '../runtime/direct/session-direct.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc } from '../runtime/config-port.ts'
import type { AssistantLiveInput } from '../runtime/assistant-stream-port.ts'
import { requireCreated, requireOpened, type SessionHandle } from '../runtime/session-lifecycle-port.ts'
import { commandSummaryOf, type SurfaceCatalogContext, type SurfaceCatalogSnapshot } from '../surface-catalog.ts'
import { type HumanSkillCatalog } from '../skill-catalog.ts'
import type {} from '@deepseek-ai/dsh-token-meter'
import { dangerCommand } from '../command-policy.ts'
import { resolveInitialCatalog } from '../surface-catalog.ts'
import { subagentJobTranscriptId, taskRowSelectionDisposition, subagentJobViewHint } from '../task-presentation.ts'
import { queueTextOf } from '../pending-presentation.ts'
import { bundleVersion, packageVersion } from '../dsh-version.ts'
import { workingFromLog } from '../compaction-presentation.ts'
import { hostRunningProfile, resumeCommand } from '../dsh-profile.ts'

import type { Config } from '../tui-config.ts'
import { composeDirectAgent, type DirectAgentComposition } from '../app/direct/composition.ts'

/** The launcher's bounded exit request; the TUI invokes it after keyboard
 * confirmation. */
interface AppExit {
  (code: number): void
}

/** Read the official `RemoteError` code off a refused preset switch. */
function presetErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

export function applyRunner(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit') as AppExit | undefined
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const startup = ctx.get(TUI_STARTUP_SERVICE)
  if (startup === undefined) return
  // The semantic backend (server/client migration M1): the TUI consumes
  // Host domains through narrow ports, never ctx.* directly. Direct is the
  // only backend today; remote/wire adapters join in later milestones
  // behind the SAME port interfaces.
  // Process diagnostics: stderr + a log file under $DSH_HOME/logs. The cordis
  // logger has no exporter in this process, so it is NOT the troubleshooting
  // channel — diag is (see diag.ts).
  const diag: Diag = diagFromEnv(process.env)
  // The patch row carries a static config; the real session id comes from the
  // startup service (no `!!js` expression, so loader hot-reloads cannot race
  // the service's availability while evaluating the row).
  const sessionId = config.sessionId !== undefined && config.sessionId !== '' ? config.sessionId : startup.sessionId
  // Lifecycle cancellation: ONE controller owned by the runner fiber. It is
  // aborted by user exit, by the ctx.effect cleanup (loader hot-reload
  // unloads the row), and by startup failure. Every long-running load shares
  // its signal; per-action cancellation rides child controllers (the local
  // shell) or generation checks (menu latches).
  const lifecycleController = new AbortController()
  // Register cancellation before entering the fire-and-forget startup root:
  // loader/HMR disposal can happen before the full TUI cleanup effect exists.
  // This disposer owns the runner lifetime signal ONLY — diag stays open so
  // the Direct owned-session retirement (which runs in the fiber disposer,
  // in PARALLEL with this disposer under Cordis unload) can record its
  // diagnostics; diag is closed by retireOwnedSession / the pre-mount abort
  // path / the fatal catch (all idempotent).
  ctx.effect(() => () => {
    lifecycleController.abort()
  }, 'tui-runner lifecycle cancellation')

  // The guarded notification writer is hoisted to the RUNNER scope: both
  // the startup body and the terminal-total fatal catch (which lives
  // OUTSIDE the IIFE) must be able to disable terminal focus reporting —
  // a startup failure after the TUI mount must never leak CSI ? 1004
  // into the shell. The guarded writer swallows broken-stream async
  // errors; every use is additionally wrapped for synchronous throws.
  const notificationWriter = guardedStreamWriter(process.stdout)
  // A process-wide guarded stderr writer for user-visible warnings: the
  // error listener swallows async stream errors (EPIPE when the terminal
  // closed — a plain try/catch around write() cannot see those), and every
  // use is additionally wrapped for synchronous throws. A warning must
  // never crash the host, even during shutdown.
  const stderrWarningWriter = guardedStreamWriter(process.stderr)
  const safeTerminalWarning = (message: string): void => {
    try {
      stderrWarningWriter.write(message)
    } catch {
      // A throwing stderr write must not break the retirement.
    }
  }

  // Pre-mount startup status: ONE instance for the whole pre-mount barrier,
  // created in the RUNNER scope BEFORE the async startup root because the
  // FIRST thing the surface waits on is the Host Loader settling — the
  // global readiness barrier below. A stalled optional row (an MCP server
  // whose initial connect or `tools/list` never answers) otherwise leaves a
  // blank terminal that reads as a dead TUI. Pure presentation: it owns no
  // lifecycle state, never starts timers, and every teardown path (abort
  // signal, resume failure, success-before-mount, fatal catch) clears it —
  // see src/startup-status.ts. The later `Resuming session…` /
  // `Preparing conversation…` stages reuse THIS object.
  const startupStatus = createStartupStatus(config.startupStatusOutput ?? {
    isTTY: process.stdout.isTTY === true,
    write: (text) => process.stdout.write(text),
  })
  lifecycleController.signal.addEventListener('abort', () => startupStatus.clear(), { once: true })

  // The Direct owner slots are hoisted to the RUNNER scope (outside the
  // startup IIFE) so the terminal-total fatal catch can see whether a
  // Direct owner exists; the memoized retirement coordinator itself stays
  // inside the IIFE (it needs the transition gate / barrier / sessions)
  // and is exposed to the fatal catch through a ref assigned once the
  // coordinator is defined. The fatal catch treats an unassigned slot as
  // "no owner".
  let retireOwnedSessionRef: (() => Promise<SessionRetirementReport>) | undefined
  /**
   * Whether a current Direct owner (agent + handle) exists, for the fatal catch
   * below. The ownership core lives INSIDE the async root, so the catch reads it
   * through this ref (the same visibility the old outer
   * `liveAgent`/`liveHandle` declarations had).
   */
  let currentOwnerPresentRef: (() => boolean) | undefined

  const startRunner = async (): Promise<void> => {
    // The TUI required surface is committed to running: synchronous init
    // succeeded and this async root is established, so the startup row's
    // readiness handshake must not report a missing surface. A later failure
    // in this root is owned by its own catch below.
    startup.markSurfaceMounted?.()
    // Loader siblings mount concurrently. Await the complete application before
    // creating an Agent so its scoped tools and adapters are not half-composed.
    // The wait is unbounded and must stay unbounded (no TUI timeout, no
    // skipping a pending row, no half-composed Agent): the only thing this
    // layer owes the user is that the wait is VISIBLE.
    startupStatus.show('Starting DSH…')
    try {
      await ctx.get('loader')?.await()
    } finally {
      // The barrier owns the terminal row only while it is waiting: release it
      // on EVERY exit, including a rejected Loader. Leaving it up would let the
      // fatal log land on the same row (`Starting DSH…[tui] … ERROR fatal …`)
      // and the later clear would then erase part of that error line — a TTY
      // shares one cursor between stdout and stderr.
      startupStatus.clear()
    }
    if (lifecycleController.signal.aborted) {
      // Pre-mount unload before any Agent existed: nothing to retire; close
      // the diagnostics handle (the early cancellation disposer no longer
      // owns it — see the effect registration above).
      diag.dispose()
      return
    }
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessions = ctx.get('sessions')
    // Early process shutdown can dispose the tree while settlement is pending.
    if (agents === undefined || defaultModel === undefined || sessions === undefined) {
      diag.dispose()
      return
    }
    // The transition gate / operation barrier are declared BEFORE the
    // first Agent can exist so the retirement coordinator below (and the
    // fatal catch through retireOwnedSessionRef) is installed before any
    // owner is created: a startup failure after the resume must join the
    // SAME memoized retirement, never a second direct teardown that could
    // race the DSH agent-loop owner disposer.
    const ownership = createSessionOwnershipCore({
      isSurfaceDisposed: () => cleanedUp,
      resetForGeneration: () => presentation.resetForGeneration(),
    })
    // The A3 command/submission scope authority (plan A3 §1.1): ONE synchronous
    // capture of `{ owner subject, generation, sessionId }`, so no consumer can
    // rebuild an identity from separate reads. A sessionless capture is
    // meaningful: it pins "no owner + this generation" and fails once the first
    // Session is created (including the publish-before-bump window).
    const sessionScope = createSessionScopeAuthority({
      current: () => {
        const subject = ownership.captureSubject()
        if (subject === undefined) {
          return { subject: undefined, sessionId: undefined, generation: ownership.generation() }
        }
        const sessionId = ownership.currentSessionId()
        if (sessionId === undefined) throw new Error('a live ownership subject must carry a session id')
        return { subject, sessionId, generation: ownership.generation() }
      },
      isSubjectCurrent: (subject) => ownership.isSubjectCurrent(subject),
    })
    // The BOUND submission runtime (A3 §4.1/§4.3): it owns the plain-prompt
    // write orchestration and the deferred queue-recall state. It is BOUND
    // after the runner facade below (its surface reads the runner and the
    // SessionRuntime writer); the session runtime's settlement seam reaches it
    // through this closure, which only runs once a transition starts (after
    // binding).
    let submissionRuntime!: SubmissionRuntime
    /** The synchronous live-scope capture for a site whose owner is already
     *  known (its `agentNow()` guard ran) — a missing owner is an invariant
     *  break, never a silent no-op. */
    const requireLiveScope = (): LiveSessionScope => {
      const scope = sessionScope.captureLive()
      if (scope === undefined) throw new Error('a live owner must carry a live session scope')
      return scope
    }
    // The abort-aware quiesce mechanism lives in the Direct owner retirement;
    // the runner only decides WHEN to quiesce.

    // Persisted TUI preferences: the `tui-app` plugin's profile-owned
    // volatile Config references are the ONE runtime authority (DSH 0.1.7
    // PR A) — the Direct facade unwraps them into the settings document the
    // runner surface already consumes, and converts whole-document
    // get→modify→replace cycles into path-scoped SettingsForms mutations.
    // The legacy settings.yaml(.imported) migration runs FIRST — before any
    // display/progress/response/notification startup state resolution and
    // before any agent compose/resume — so the first model prompt assembly
    // already sees the migrated Focus/display state (plan §8.4: this
    // barrier is P0). Reads always work off the plugin references; without
    // the Settings service there is no persistence surface, and a write
    // attempt fails explicitly instead of silently skipping.
    const settingsForms = ctx.get('settings') as SettingsFormsLike | undefined
    const tuiSettings = new DirectTuiSettings(config, settingsForms)
    // The TUI ships its own /settings surface: keep the Settings service's
    // auto-generated page off this entry (it would also expose the internal
    // legacy-migration marker). The optional-inject child names the tui-app
    // fiber the presentation policy belongs to; the TUI runs without the
    // Settings service mounted.
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    await migrateLegacySettings({
      home: (ctx.get('profileContext') as { readonly home: string } | undefined)?.home ?? dshHome(process.env),
      forms: settingsForms,
      resolvePreset: async (id) => {
        const presets = ctx.get('agentPresets') as { resolve(id?: string): Promise<{ broken?: string }> } | undefined
        if (presets === undefined) throw new Error('agent presets unavailable in this deployment')
        // §8.8: the current registry validates BOTH existence and
        // usability — a declared-but-broken preset is not a valid legacy
        // default (the official resolve returns it carrying `broken`).
        const resolved = await presets.resolve(id)
        if (resolved.broken !== undefined) {
          throw Object.assign(new Error(resolved.broken), { code: 'agent-preset/invalid' })
        }
      },
      migrationMarker: config.legacySettingsMigrationVersion,
      diag,
    })
    // Resolve the canonical display state before the first compose/resume so
    // the first model prompt and the first transcript frame agree.
    const persistedTuiSettings = tuiSettings?.get() as unknown as TuiSettingsDoc | undefined
    const displayResolution = resolveDisplayPreset({
      displayPreset: persistedTuiSettings?.displayPreset,
    })
    const displayState: DisplayState = { preset: displayResolution.preset }
    // Two independent live authorities, resolved before the first compose.
    const progressUpdatesState: ProgressUpdatesState = { mode: parseProgressUpdates(persistedTuiSettings?.progressUpdates) }
    const responseStyleState: ResponseStyleState = { style: parseResponseStyle(persistedTuiSettings?.responseStyle) }
    // Git attribution is Agent guidance only (one prompt section, no Git
    // enforcement): the live holder is resolved before the first compose and
    // the section reads it on every assembly.
    const gitAttributionState: GitAttributionState = { mode: parseGitAttributionMode(persistedTuiSettings?.gitAttribution) }

    // Completion notifications (plan: Client/TUI presentation capability —
    // settled detection, focus detection, terminal output and settings parsing
    // stay separate modules, never a blob in the runner). A4-4: the notification
    // controller, the focus tracker and the terminal notifier are surface-owned;
    // the runner feeds the exact owner identity, the authoritative
    // `agent/status` runtime fact and the focus/user-input reports through the
    // surface, and reads/writes the notification settings through it. The
    // guarded writer stays hoisted with the runner scope so the terminal-total
    // fatal catch (outside the startup IIFE) can disable focus reporting too.

    // A4: the mounted surface's ONE application owner. It owns the concrete
    // surface state (the opening journal + the unified status projection store,
    // the footer's single input) and the notification/focus presentation from
    // here on; `start()` below performs the mount once the startup composition
    // has resolved the surface capabilities. The mounted TuiApp is created and
    // released by this owner alone. Declared BEFORE the resume commit: the A2
    // commit seams reset the completion owner during startup, before the mount.
    const surface = createSurfaceRuntime<SessionEvent>({
      tuiVersion: bundleVersion(),
      notificationWriter,
      notificationMode: tuiSettings?.get().notificationMode,
      notificationMethod: tuiSettings?.get().notificationMethod,
    })

    // The live Agent is declared before the TUI-facing facade so every read
    // after a transition follows the current Session rather than a startup
    // snapshot. It remains undefined for deferred-start surfaces.
    //
    // The Direct application runtime owns the Direct-only composition: the ONE
    // per-Agent model-selection owner shared with the picker, the Direct
    // resolvers, the semantic Backend, and the Direct assistant-stream install.
    // It reads the live session authority through getters, so this runner keeps
    // the single `liveAgent` mutable truth (A2 relocates that authority into
    // `app/session`). The viewed-queue authority is VIEWER-owned (A5b-6): the
    // Direct queue resolver reads it through the late-bound `viewerRef` getter.
    const directRuntime = createDirectApplicationRuntime({
      ctx,
      diag,
      tuiSettings,
      defaultModel: defaultModel as unknown as DefaultModelServiceLike,
      // The Direct owner pool is built and owned inside the Direct runtime; it
      // reads the ONE ownership-core release ledger through these two seams.
      waitForRelease: ownership.waitForOwnerRelease,
      currentOwner: () => ownership.owner(),
      isLifecycleAborted: () => lifecycleController.signal.aborted,
      // Behavior preserved: the same `composeDirectAgent` wiring, now with the
      // runtime's Agent-scoped model-selection install.
      compose: (installSelection, presetId) =>
        composeDirectAgent(ctx, installSelection, presetId, displayState, diag, progressUpdatesState, responseStyleState, gitAttributionState),
      getViewedQueueAgent: () => viewerRef?.viewedQueueAuthority(),
    })
    /**
     * The Direct attachment of the CURRENT owner (A2 transitional projection):
     * a DERIVED read of the ownership core through the Direct registry, never a
     * stored second current-agent truth. Direct DATA/OPERATION reads only —
     * identity/currentness goes through the ownership subject.
     */
    const agentNow = (): Agent | undefined => directRuntime.owners.currentDirectAttachment()
    /** The Direct owner handle of the CURRENT owner (retirement/teardown only). */
    const handleNow = (): AgentHandle | undefined => {
      const owner = ownership.owner()
      return owner === undefined ? undefined : directRuntime.owners.handleOf(owner) as AgentHandle | undefined
    }
    currentOwnerPresentRef = (): boolean => ownership.owner() !== undefined && handleNow() !== undefined
    /**
     * Whether the ownership subject captured at ADMISSION is still the CURRENT
     * one (exact owner + generation). `captureSubject()` is undefined for a
     * sessionless capture, which must match a still-sessionless slot.
     */
    const captureMatches = (subject: SessionSubject | undefined): boolean =>
      subject === undefined ? ownership.owner() === undefined : ownership.isSubjectCurrent(subject)
    /**
     * Whether one exact Direct Agent object IS the current owner: the ownership
     * core is the identity authority, the registry resolves its attachment.
     */
    const isCurrentOwnerAgent = (candidate: Agent): boolean => {
      const owner = ownership.owner()
      return owner !== undefined && directRuntime.owners.attachmentOf(owner)?.agent === candidate
    }
    /**
     * The Direct attachment of one opaque owner: the runner IS the Direct
     * composition root, and the session layer only ever hands it an `OwnerRef`.
     */
    const directAgentOfOwner = (owner: SessionOwnerRef): Agent | undefined =>
      directRuntime.owners.attachmentOf(owner)?.agent
    /**
     * The BOUND session runtime (A2 plan §1.1 phase 3): the session layer owns
     * the session orchestration; the runner supplies the surface operations, the
     * user-facing reporting and the in-flight-work view (the ledgers move into
     * the runtime with the fork / command-settlement flows in 3b-3 / 3b-5).
     */
    // A5b-3: the model-selection owner (sessionless default intent + write
    // barrier + the in-flight "selecting" marker + the TUI-only selection
    // facade). Constructed before the session runtime, whose deps read the
    // write barrier.
    const model = createModelSelectionOwner<ModelSelection>({
      liveAgent: () => agentNow(),
      generation: () => ownership.generation(),
      currentDefault: () => defaultModel.currentSelection() as ModelSelection | undefined,
      currentOf: (agent) => directRuntime.modelSelections.current(agent as Agent),
      setCurrentOf: (agent, next) => directRuntime.modelSelections.setCurrent(agent as Agent, next),
    })
    const sessionRuntime = bindSessionRuntime(ownership, {
      owners: directRuntime.owners,
      retirement: directRuntime.retirement,
      lifecycle: directRuntime.backend.sessionLifecycle,
      lifecycleSignal: lifecycleController.signal,
      surface: {
        warnRetirement: (report) => {
          // The SEMANTIC outcome decides the wording; the backend's phase labels
          // are printed only as diagnostics.
          const durabilityFailure = report.durabilityFailure
          if (durabilityFailure !== undefined) {
            safeTerminalWarning(`\n${color.textDim('Warning:')} session flush failed during retirement (${durabilityFailure.error}) — the latest events may not be persisted\n`)
          } else {
            const phases = report.failures.map(failure => failure.phase).join(', ')
            safeTerminalWarning(`\n${color.textDim('Warning:')} session retirement failed during ${phases}\n`)
          }
        },
        warnRetirementSkipped: (reason) => {
          safeTerminalWarning(`\n${color.textDim('Warning:')} session retirement was skipped (${reason}) — the session may not have been closed cleanly\n`)
        },
        isSurfaceDisposed: () => cleanedUp,
        beginOpening: (sessionId) => surface.openingJournal.begin(sessionId),
        clearOpening: (token) => surface.openingJournal.clear(token as object),
        settlePendingQueueRecalls: (committed) => submissionRuntime.settleQueueRecalls(committed),
        settleLocalSubmitAck: (reason) => submission.settleLocalSubmitAck(reason),
        resetSubmitLatency: () => submission.resetSubmitLatency(),
        setCompletionOwner: (identity) => surface.setCompletionOwner(identity),
        initLiveSession: (owner) => {
          const agent = directAgentOfOwner(owner)
          // M3-2 staging: an owner without a Direct attachment is a Remote
          // generation whose presentation provider arrives with the M3-4
          // Remote composition. This runner performs no Direct surface work
          // for it (the ownership handoff itself is already complete).
          if (agent === undefined) return Promise.resolve()
          return presentation.initLiveSession(agent)
        },
        refreshLiveCatalog: (owner) => {
          const agent = directAgentOfOwner(owner)
          // M3-2 staging: see initLiveSession — no Direct catalog work exists
          // for a Remote-owned generation yet.
          if (agent === undefined) return Promise.resolve()
          return command.refreshLiveCatalog(agent)
        },
        reportSwitch: (from, to) => {
          const agent = directAgentOfOwner(to)
          diag.info('switch ok', {
            from: from ?? '(none)',
            to: agent?.session.id,
            seq: agent === undefined ? undefined : Number(agent.session.seq),
          })
        },
        clearUnpinnedDrafts: () => {
          draftImages.clearUnpinned()
          draftFiles.clearUnpinned()
        },
        reportSwitchFailure: (sessionId, message) => {
          ctx.logger.warn(`tui-runner: switch to ${sessionId} failed: ${message}`)
          diag.error('switch failed', { session: sessionId, error: message })
        },
        launchComposition: () => launchComposition(),
        setResumeFailure: (failure) => { resumeFailure = failure },
        reportFirstSessionCreateFailure: (message) => {
          ctx.logger.warn(`tui-runner: failed to create the first session: ${message}`)
          diag.warn('first session creation failed', { error: message })
          resumeFailure = `could not create the first session: ${message}`
        },
        notifyResumeFailure: () => {
          if (resumeFailure !== undefined) {
            app.notify(resumeFailure, 'error')
            resumeFailure = undefined
          }
        },
        awaitPendingDefaultWrite: (signal) => model.awaitPendingDefaultWrite(signal),
        newSessionId: () => String(SessionId(`session-${randomUUID()}`)),
        sessionCreateCwd: () => process.cwd(),
        currentOpening: () => surface.openingJournal.current(),
        resetOpening: () => surface.openingJournal.reset(),
      },
      isScopeCurrent: (scope) => sessionScope.isCurrent(scope),
      diag,
    })
    // The fatal startup catch reaches the ONE memoized retirement through this
    // ref (assigned only once the runtime exists; an earlier fatal error has no
    // owner to retire).
    retireOwnedSessionRef = sessionRuntime.retireOwnedSession
    // The semantic backend (server/client migration): the TUI consumes
    // Host domains through narrow ports, never ctx.* directly. Direct is the
    // only backend today; remote/wire adapters join in later milestones
    // behind the SAME port interfaces. The adapter assembly is owned by
    // `runtime/direct/backend-direct.ts`; this runner only consumes it.
    const backend = directRuntime.backend
    // A5b-2: the settings owner (footer settings + USER-layer trust, the
    // display-preset mutation/persistence, user keybindings and the boot
    // display/theme application).
    const settings = createSettingsRuntime({
      surface,
      // Late-bound: the runner lifetime signal and the status owner are
      // declared later in the composition; both are read only when the boot
      // steps below actually apply settings.
      get signal() { return lifecycleController.signal },
      tuiSettings,
      settingsForms,
      backend,
      diag,
      isCleanedUp: () => cleanedUp,
      status: { refresh: () => status.refresh() },
      extensions: () => extensionService,
    })
    /** Resolve one preset composition through the runtime's model-selection install. */
    const compose = (presetId?: string): Promise<DirectAgentComposition> => directRuntime.compose(presetId)

    // Migrate legacy/invalid display settings without delaying composition or
    // changing the initial frame. The canonical field always wins at boot;
    // this best-effort write only makes the chosen runtime value durable.
    if (displayResolution.canonicalize && settingsForms !== undefined) {
      runDetached('display preset migration', () => serializeTuiSettingsMutation(
        tuiSettings,
        () => tuiSettings.replace({
          ...tuiSettings.get(),
          footerCustomItems: settings.userFooterItemsForSave(),
          displayPreset: displayState.preset,
        }),
      ), { diag })
    }

    // Launch-time preset entry: `--preset` wins over $DSH_PI_TUI_PRESET, and
    // both fall back to the saved default (the registry's merged policy)
    // when absent. A fresh session starts on it; a
    // resumed BLANK session may still be re-composed onto it; a resumed
    // started session keeps its recorded preset (warned, never overridden).
    const launchPreset = startup.presetId ?? (process.env.DSH_PI_TUI_PRESET?.trim() || undefined)
    // Run-local preset override chosen with /preset before any session
    // exists (deferred start): the next session composes on it, ahead of
    // launchPreset and the saved default — the web's "applies to sessions
    // you start from now on" model scoped to this process. It stays until
    // changed or the TUI exits; sessions that already exist ignore it
    // (their composition is fixed).
    let pendingPreset: string | undefined
    diag.info('boot', {
      pid: process.pid,
      dsh: dshVersion() ?? 'unknown',
      bundle: packageVersion(),
      cwd: process.cwd(),
      session: sessionId ?? '(deferred)',
      preset: launchPreset ?? 'default',
      // Host capability check (plan stage K): the services the TUI surface
      // consumes. Each one degrades locally when absent (presets → default
      // composition, commands → plain
      // messages, shell → spawn fallback), so this line is diagnostic, not
      // a mount gate — the TUI never fails to mount without explanation.
      services: [
        'sessionPersistence', 'agents', 'commands', 'tools', 'shell', 'llm',
        'settings', 'skills', 'userQuestions', 'approval', 'permissionPresets',
      ].filter(name => ctx.get(name as never) !== undefined).join(','),
    })
    /** Resolve the launch composition, falling back to the default on an unknown id. */
    const launchComposition = async (): Promise<{ composition: DirectAgentComposition; failure?: string }> => {
      try {
        return { composition: await compose(pendingPreset ?? launchPreset) }
      } catch (error) {
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: launch preset unavailable: ${message}`)
        diag.warn('preset unavailable', { preset: launchPreset ?? 'default', error: message })
        return {
          composition: await compose(),
          failure: `preset "${launchPreset}" unavailable; started with the default`,
        }
      }
    }

    // A failed --session resume leaves the surface sessionless (the next
    // input creates a new session); the failure is surfaced as a notify
    // line. The DSH SessionWriteLease (kernel flock) is the ONLY
    // cross-process writer authority — the TUI's physical owner.lock /
    // lease / cooling stack is removed legacy.
    let resumeFailure: string | undefined
    // The explicit-resume stage reuses the RUNNER-scope `startupStatus`
    // created before the Loader barrier (see the top of applyRunner): the
    // status object is already armed with the abort clear, and the
    // `Starting DSH…` line was cleared as soon as the Loader settled.
    let handle: SessionHandle | undefined
    // The cancellation branch below belongs only to the pre-publication
    // lifecycle await. Once resume resolves, its creation-only signal no
    // longer owns the returned handle (DSH contract).
    let resumeResolved = false
    if (sessionId !== undefined) {
      // The explicit-resume path is the ONLY pre-mount wait worth
      // explaining: deferred / sessionless starts have nothing to resume.
      startupStatus.show('Resuming session…')
      try {
        if (lifecycleController.signal.aborted) {
          // No owner exists yet and the full fiber disposer is not
          // registered: close the diagnostics handle (idempotent).
          diag.dispose()
          return
        }
        // The Direct adapter resolves the recorded preset and the Host
        // default activation fallback internally from the official
        // observation seam; the cross-backend open request carries only the
        // Session identity.
        handle = requireOpened(await backend.sessionLifecycle.open({
          sessionId: String(sessionId),
          signal: lifecycleController.signal,
        }))
        resumeResolved = true
        // Suspend the pre-mount status before ANY ordinary log output
        // (uniform rule): the status owns the current terminal line, and
        // a logger/diag write on a TTY shares the cursor — the status
        // must be cleared first so the log line is clean and the later
        // clear can never erase the wrong line. The 'Preparing
        // conversation…' stage re-arms it.
        startupStatus.clear()
        // The ACTUAL resumed composition, read from the LIVE projection AFTER
        // open — never a second pre-open observation. The `--preset` override
        // decision and the diagnostic therefore cannot disagree with what the
        // adapter actually mounted.
        const recorded = sessionPresetOf(ctx, (handle.direct!.agent as Agent).session)
        diag.info('resume ok', {
          session: sessionId,
          seq: Number((handle.direct!.agent as Agent).session.seq),
          preset: recorded ?? 'default',
        })
        // A launch-time preset may still apply while the session is blank;
        // the Host owns the blank check and refuses a started Session with
        // `agent-preset/locked`.
        if (launchPreset !== undefined && launchPreset !== recorded) {
          try {
            await selectBlankSessionPreset(ctx, handle.direct!.agent, launchPreset)
          } catch (error) {
            startupStatus.clear()
            if (presetErrorCode(error) === 'agent-preset/locked') {
              const message = `session ${sessionId} has started; its agent preset ${recorded} is fixed, ignoring --preset ${launchPreset}`
              ctx.logger.warn(`tui-runner: ${message}`)
              diag.warn('preset ignored on resume', { session: sessionId, preset: launchPreset })
            } else {
              const message = `--preset ${launchPreset} not applied on resume: ${safeErrorMessage(error)}`
              ctx.logger.warn(`tui-runner: ${message}`)
              diag.warn('preset not applied on resume', { session: sessionId, preset: launchPreset, error: safeErrorMessage(error) })
            }
          }
        }
      } catch (error) {
        if (lifecycleController.signal.aborted && !resumeResolved) {
          startupStatus.clear()
          diag.debug('startup resume cancelled', { session: sessionId })
          // No owner was published and the full fiber disposer is not
          // registered: close the diagnostics handle (idempotent).
          diag.dispose()
          return
        }
        // Suspend the pre-mount status BEFORE the failure logs: the
        // status owns the current terminal line, and the logger/diag
        // writes below share the TTY cursor — without this clear the
        // warning would interleave with the status and the later
        // mount-time clear would erase the wrong line.
        startupStatus.clear()
        // A rejected resume (e.g. the DSH SessionWriteLease's
        // SessionAlreadyOwnedError) leaves the session untouched: no pin,
        // no fallback — the surface starts sessionless and the next user
        // input creates a new session; the failure is surfaced as a
        // notify line.
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${message}`)
        diag.error('resume failed', { session: sessionId, error: message })
        resumeFailure = /already owned/i.test(message)
          ? `session ${sessionId} is already owned by another DSH writer/process`
          : `session ${sessionId} could not be resumed: ${message}`
      }
    } else {
      // Deferred session creation: without --session the TUI opens with NO
      // session at all — zero agent, zero log, zero persistence — and the
      // first user message creates it (see ensureSession below).
    }
    // The startup-resume publication ORDER is fixed by `runResumeCommit`
    // (A2 plan §4D) inside the runtime: publish owner → completion → pre-mount
    // quiesce. The publication itself stays SYNCHRONOUS; a sessionless
    // (deferred) startup has nothing to quiesce and must not gain a microtask
    // yield here.
    const resumeQuiesce = sessionRuntime.publishResumedOwner(handle, (owner) => {
      // The resume transaction succeeded; the remaining pre-mount wait is
      // the conversation preparation (whenIdle + the catalog ready
      // barrier) — the second status stage replaces the first in place
      // and STAYS until the barrier completes (the catalog prefetch can
      // take seconds; a cleared line would read as a hang again).
      startupStatus.show('Preparing conversation…')
      // The pre-mount whenIdle does NOT observe the lifecycle signal, and
      // the full surface disposer is not registered yet (the pre-mount
      // abort path below has not been reached) — an early HMR/app disposal
      // would otherwise leave this await hanging forever and the
      // just-created owner would never be retired. Cancel the agent on
      // abort so whenIdle settles, then the pre-mount abort path below
      // retires the owner.
      return directRuntime.retirement.whenIdleOrAbort(owner, lifecycleController.signal)
    })
    if (resumeQuiesce !== undefined) await resumeQuiesce
    // Surface catalog resolution BEFORE the TUI mounts (the ready barrier):
    // a resumed agent prefetches its effective catalog (a live read emits no
    // session events); the deferred start reads the cold HUMAN SKILL catalog
    // through the effective preset's STANDING SCOPE — no Agent, no session,
    // no turn, no durable artifact. `initialSnapshot` is undefined for the
    // deferred start; `initialSkills` carries the cold catalog; `surfaceNotice`
    // carries the one-shot degradation message on any failure.
    let initialSnapshot: SurfaceCatalogSnapshot | undefined
    let initialSkills: HumanSkillCatalog | undefined
    let surfaceNotice: string | undefined
    {
      // The effective preset for the cold standing read — the SAME
      // precedence ensureSession uses (pendingPreset → launch → default).
      // A failing launch preset falls back to the default inside
      // launchComposition; a fully broken roster must not block startup —
      // the cold read then uses the deployment default (and degrades
      // inside resolveColdSkillTarget if that is broken too), and
      // ensureSession surfaces the preset failure on the first input.
      let effectivePresetId: string | undefined
      if (agentNow() === undefined) {
        // Only a deferred/fresh start resolves the LAUNCH preset. A live
        // resumed agent already runs its recorded composition, so resolving
        // `--preset` here would spuriously degrade a healthy resume when the
        // launch preset is invalid (the catalog read uses the live projection).
        try {
          const launched = await launchComposition()
          if (launched.failure !== undefined) resumeFailure = launched.failure
          effectivePresetId = launched.composition.agentPreset
        } catch (error) {
          // Suspend the status before the log. The "fresh start stays silent"
          // contract holds on this failure path; ensureSession surfaces the
          // preset failure on the first input.
          startupStatus.clear()
          diag.warn('preset resolution failed at startup', { error: safeErrorMessage(error) })
        }
      }
      const resolution = await resolveInitialCatalog({
        liveAgent: agentNow(),
        presetId: effectivePresetId,
        signal: lifecycleController.signal,
        ctx: ctx as unknown as SurfaceCatalogContext,
        diag,
        // The catalog read may emit its own failure warn: suspend the
        // status right before it (the barrier itself keeps the status
        // on screen).
        onLog: () => startupStatus.clear(),
      })
      initialSnapshot = resolution.snapshot
      initialSkills = resolution.skills
      surfaceNotice = resolution.notice
    }
    /** The preset the live agent runs on, when the deployment composes one. */
    const currentPreset = (): string | undefined => {
      const agent = agentNow()
      if (agent === undefined) return undefined
      const presets = ctx.get('agentPresets') as {
        composedPreset?: (agentCtx: unknown) => unknown
      } | undefined
      if (typeof presets?.composedPreset === 'function') {
        try {
          const composed = presets.composedPreset(agent.ctx)
          if (typeof composed === 'string') return composed
        } catch {
          // During teardown, fall back to the DSH projection read below.
        }
      }
      return sessionPresetOf(ctx, agent.session)
    }
    /** The Host turn-boundary authority's blank state for the live Session —
     *  the SAME projection the official `agentPresets.select` re-check reads.
     *  Never derived from the TUI transcript. */
    const sessionBlank = (): boolean | undefined => {
      const agent = agentNow()
      if (agent === undefined) return undefined
      // The Host-authoritative blank read lives BEHIND the semantic Session
      // reader port (v2 §0.6): the runner no longer knows the Direct
      // projection name or the turn-boundary reducer.
      return backend.sessionReader.blank(agent.session.id)
    }
    // A5b-1: the live-session presentation owner (main transcript/stats folds,
    // the main presentation target, the generation reset and the ONE cold
    // hydration path) is constructed here, where its folds used to live.
    // `viewerRef` is the late-binding seam for the generation reset: the
    // presentation owner owns the reset ORDER, the viewer owner owns its own
    // teardown.
    let viewerRef: ViewerRuntime<SessionEvent, Agent> | undefined
    const presentation = createSessionPresentation<SessionEvent>({
      surface,
      diag,
      isCleanedUp: () => cleanedUp,
      folds: { title: (events) => foldSessionTitle(events)?.title },
      direct: {
        installModelSelection: (agent) => { directRuntime.modelSelections.installForAgent(agent as Agent) },
        assistantStreamBaselineFor: (agent) => assistantStreamBaselineFor(agent as Agent),
        planActive: (agent) => projectedPlanActive(
          ctx.get('sessionProjections') as PlanProjectionLike | undefined,
          (agent as unknown as Agent).session,
        ) ?? false,
      },
      status: {
        setGoalText: (text) => status.setGoal(text),
        refresh: () => status.refresh(),
        refreshTerminalTitle: () => status.refreshTerminalTitle(),
        updateWelcomeCard: () => status.updateWelcomeCard(),
        scheduleInitialMeasurement: (agent) => status.scheduleInitialMeasurement(agent.session.id),
      },
      history: {
        rememberCwd: (cwd) => history.rememberCwd(cwd),
        currentCwd: () => status.sessionCwd(),
        records: (cwd) => history.records(cwd),
        setLastContent: (content) => history.setLastContent(content),
      },
      commands: { register: () => command.register({ snapshot: initialSnapshot, skills: initialSkills }) },
      submission: { clearPending: () => submission.clearPending() },
      viewer: {
        resetAutoPop: () => viewerRef?.resetAutoPop(),
        teardownForSessionSwap: () => viewerRef?.teardownForSessionSwap(),
      },
    })

    /** The transition gate protects ordinary session surface changes — `/new`,
     * `/sessions` switch/open and first-session creation — from interleaving.
     * Fork dispatch is intentionally outside this destructive queue: Host
     * publication may outlive local navigation, while the visible adoption and
     * old-owner retirement use a short gated handoff.
     * @see SessionTransitionGate */
    // (The transition gate and operation barrier are constructed BEFORE the
    // first Agent can exist — see the hoisted declarations above — so the
    // retirement coordinator is fully wired before any owner is created.)

    /** The ordinary session-transition transaction. Its canonical ordering
     * lives in `runTransitionTo` (src/transition.ts — unit-tested): quiesce and
     * flush the old owner, run caller preflight, create/open the child, commit
     * the visible handle synchronously, then retire the old Direct owner and
     * refresh the child surface. Published children are never treated as if
     * they did not exist, and callers use this only inside the gate. */

/** Extract the live in-process agent from a transition next value: the
 * Direct SessionHandle carries it via direct.agent; an AgentHandle IS the
 * agent handle. A Remote handle carries no Direct agent: it carries exactly one
 * Client generation reference (`SessionHandle.client`), which a composing
 * Remote runner WILL release through `clientOwnerOf()`. This Direct runner does
 * not take that owner over yet — the Remote caller-side handoff is deferred to
 * Remote production composition (M2+/M3). */
// transition agent/handle extraction lives in runtime/session-lifecycle-port.ts
// (ownerHandleOf / directAgentOf) so the runner AND the contract tests share
// the exact extraction the transition commit uses.


    // Footer state: model label, cwd, git branch, turn/step counters, and
    // the stats line (LLM timing, tokens, context pressure).
    const cwd = process.cwd()
    // A5b-5: the client-local platform policy (clipboard + external editor).
    // Client-local by contract (no Host port); constructed before the command
    // owner because that owner consumes the copy policy.
    const clientActions = createClientActions()
    // A5b-5: the TuiApp application-event owner. Declared here (before the
    // command owner and the mount) so the command owner's `/rewind` seam can
    // reach it late-bound and the mount below can hand its adapter over. It is
    // ASSIGNED once every owner it depends on exists, before `surface.start`.
    let applicationEvents: ApplicationEventsOwner
    // A5b-3b-2: the command authority/state machine + the TuiCommandRunner
    // facade owner. Constructed before the surface cleanup closure can run; the
    // runner facade is built later, after the semantic command runtime binds.
    // Every owner below is read live (getter/closure), so this site's order is
    // irrelevant and no capability can go stale.
    // Explicit annotation: the Direct seams below read the owner back
    // (late-bound through `command`), so the initializer cannot drive inference.
    const command: CommandSurface<ModelSelection, Agent> = createCommandSurface<ModelSelection, SessionId, Agent>({
      ctx,
      diag,
      signal: lifecycleController.signal,
      app: () => app,
      liveAgent: () => agentNow(),
      sessionScope,
      ownership,
      transition: {
        pending: () => ownership.gate.busy,
        run: <T>(task: () => Promise<T> | T): Promise<T> =>
          ownership.gate.run(() => ownership.barrier.runTransition(async () => task())),
      },
      commandsRegistry: () => ctx.get('commands'),
      catalog: backend.catalog,
      toCatalogAgent: (agent) => agent,
      presets: {
        launch: launchPreset,
        pending: () => pendingPreset,
        setPending: (id) => { pendingPreset = id },
        current: () => currentPreset(),
        blank: () => sessionBlank(),
      },
      clientCwd: cwd,
      surface: {
        setNotificationMode: (mode) => surface.setNotificationMode(mode),
        setNotificationMethod: (method) => surface.setNotificationMethod(method),
        openJobView: (jobId) => surface.openJobView(jobId),
        openTasksBrowser: (viewMode) => surface.openTasksBrowser(viewMode),
      },
      backend: {
        sessionReader: backend.sessionReader,
        sessionWriter: backend.sessionWriter,
        interaction: backend.interaction,
        catalog: backend.catalog,
        config: backend.config,
        hostFile: backend.hostFile,
      },
      session: {
        ensureSession: () => sessionRuntime.ensureSession(),
        withWriter: (scope, task) => sessionRuntime.withWriter(scope, task),
        switchSession: (sessionId) => sessionRuntime.switchSession(sessionId),
        forkSession: (sourceSessionId) => sessionRuntime.forkSession(sourceSessionId),
        transitionTo: (steps) => sessionRuntime.transitionTo(steps),
      },
      status: {
        forceContextMeasurement: () => status.forceContextMeasurement(),
        sessionCwd: () => status.sessionCwd(),
        refresh: () => status.refresh(),
        updateWelcomeCard: () => status.updateWelcomeCard(),
      },
      settings: {
        applyFooterSettings: (doc, saved) => settings.applyFooterSettings(doc, saved),
        setDisplayPreset: (preset) => settings.setDisplayPreset(preset),
      },
      model,
      viewer: {
        enterView: (childId, label, mode, parentSessionId, activity) =>
          viewer.enterView(childId, label, mode, parentSessionId, activity),
      },
      drafts: {
        get images() { return draftImages },
        get files() { return draftFiles },
      },
      extensions: {
        current: () => {
          const service = extensionService
          return service === undefined ? undefined : {
            commands: service.commands,
            themes: service.themes,
            settings: service.settings,
            autocomplete: service.autocomplete,
            keybindings: service.keybindings,
            renderers: service.renderers,
            editors: service.editors,
            api: () => service.api(),
            health: () => service._ledger().healthSnapshot(),
          }
        },
        recordError: (ref, error) => extensionService?._recordRegistryError(ref, error),
        clearError: (ref) => extensionService?._clearRegistryError(ref),
      },
      pluginManager: {
        open: () => pluginManager.open(),
        submenu: (done) => pluginManager.submenu(done),
      },
      client: {
        get runCopyCommand() { return clientActions.runCopyCommand },
        get copyEnv() { return clientActions.copyEnv },
      },
      submission: {
        prepareDeps: () => submission.prepareDeps(),
        settleQueueRecalls: (committed) => submissionRuntime.settleQueueRecalls(committed),
      },
      promptState: { progressUpdates: progressUpdatesState, responseStyle: responseStyleState, gitAttribution: gitAttributionState },
      tuiSettings,
      displayState,
      get agents() { return lifecycleAgents },
      imageLimits: () => ctx.get('attachments')?.imageLimits as import('../image/intake.ts').ImageLimitsLike | undefined,
      openRewindPicker: () => applicationEvents.openRewindPicker(),
      requestExit: () => requestExit(),
      exit,
      // A5b-3: the narrow Direct seams the (command-owned) runtime binding
      // needs. They stay here because they read the in-process Host session log
      // and the Host command registry.
      direct: {
        listScopedCommands: () => {
          const commands = ctx.get('commands') as CommandRegistryLike | undefined
          if (commands === undefined) throw new Error('commands service unavailable')
          return commands.list(agentNow()).map(commandSummaryOf)
        },
        sessionStats: (sessionId) => computeStats(command.attachmentForSession(sessionId).session.snapshotEvents()),
        lastAssistantText: (sessionId) => {
          const session = command.attachmentForSession(sessionId).session
          // Single-event lookup: walk BACKWARDS with eventAt (alpha.4) — never
          // materialize the whole log for one message.
          for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
            const event = session.eventAt(SessionSeq(seq))
            if (event?.type !== 'assistant/message') continue
            return event.data.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
          }
          return undefined
        },
        promptAdmission: (agent, hasImages, task) => directRuntime.withPromptAdmission(agent, hasImages, async () => task()),
      },
      surfaceCatalogContext: ctx as unknown as SurfaceCatalogContext,
      logError: (message) => ctx.logger.error(message),
    })
    // A5b-2: the surface status owner (footer/status derivation, the context
    // measurement cache and its deferred initial measure). The Direct facts and
    // the official Host service values arrive as narrow capabilities; the
    // viewer owner is late-bound (it is constructed after the presentation).
    const status = createStatusRuntime({
      surface,
      isCleanedUp: () => cleanedUp,
      liveAgent: () => agentNow(),
      generation: () => ownership.generation(),
      currentSessionId: () => ownership.currentSessionId(),
      measureContext: (sessionId) => backend.sessionReader.measureContext(sessionId),
      model: {
        selection: () => model.selected.current,
        currentOf: (agent) => model.currentOf(agent),
        defaultSelection: () => model.currentDefault(),
        marker: () => model.currentMarker(),
        preset: () => currentPreset(),
      },
      host: () => ({
        permissionPresets: ctx.get('permissionPresets'),
        sandboxPolicy: ctx.get('sandboxPolicy'),
        approval: ctx.get('approval'),
        planMode: ctx.get('planMode'),
        sessionProjections: ctx.get('sessionProjections'),
      }),
      presentation: { mainStats: () => presentation.mainStats() },
      viewer: { read: () => viewerRef?.read() },
      clientCwd: cwd,
    })
    // A5b-2: the client-local input-history owner (known cwds, the canonical
    // last row and the per-session recall projection). Constructed before the
    // mount; it only touches the app inside `activateBootRecall`.
    const history = createInputHistory({
      surface: { get app() { return app } },
      clientCwd: cwd,
      sessionCwd: () => status.sessionCwd(),
      diag,
      isCleanedUp: () => cleanedUp,
    })

    // Surface lifetime fence: every callback below can outlive the TUI
    // surface, so the guard is initialized before any refresh callback exists.
    let cleanedUp = false

    let app: TuiApp
    // The extension service + surface host (M3 wiring); declared here so
    // the cleanup closure can detach them.
    let extensionService: (PiTuiExtensionService & {
      /** The CONCRETE registries (the runner's dispatch/pickers need the
       * full read methods — handlerFor, isSessionless, etc. — beyond the
       * public narrow views). */
      readonly commands: import('../command-bridge.ts').CommandBridge
      readonly themes: import('../theme-registry.ts').ThemeRegistry
      readonly autocomplete: import('../autocomplete-registry.ts').AutocompleteRegistry
      readonly settings: import('../settings-registry.ts').SettingsRegistry
      readonly keybindings: import('../keybinding-registry.ts').KeybindingRegistry
      readonly renderers: import('../renderer-registry.ts').RendererRegistry
      readonly editors: import('../editor-registry.ts').EditorRegistry
      _ledger(): import('../extension/internal/ledger.ts').ExtensionLedger
      /** INTERNAL owner → owning Loader entry id projection (P1-A1.4). */
      _ownerEntryIds(): ReadonlyMap<string, string>
      // The REF protocol: capture the identity at INVOCATION START and
      // report settlements against the captured ref — never the live
      // registry (an HMR reload may replace the id with a new owner by
      // settle time; the review's P2 generation fence). This shape is the
      // authoritative bridge protocol — keep it in sync with the
      // service's implementations.
      // Theme-unload notification (the selected-plugin-theme fallback):
      // called with the SOURCE-QUALIFIED selectable value (+ display
      // name) of every theme that unloads. Returns the GENERATION-LEASED
      // release (the review's P2: an old runner's cleanup must never
      // clear a newer generation's hook).
      setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
      _recordRegistryHealthRef(slot: string, id: string): { slot: string; id: string; owner: string } | undefined
      _recordRegistryError(ref: { slot: string; id: string; owner: string }, error: unknown): void
      _clearRegistryError(ref: { slot: string; id: string; owner: string }): void
      attachSurface(bridge: { subscribe(listener: (state: never) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string, requestRender?: (force?: boolean) => void): void
      detachSurface(surfaceId?: string): void
      // Phase 2: the ADVANCED seam (the `extensions/advanced` facade's
      // internal surface — the runner wires the app's input path and the
      // interactive-overlay/editor-control seams through it).
      _advancedInputRoute(data: string): 'consumed' | 'passed'
      setAdvancedOverlayMount(
        surfaceId: string,
        mount: (component: import('../extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('../extension/public-types.ts').TuiOverlayOptions) => import('../extension/advanced-types.ts').AdvancedOverlayLease,
      ): void
      setAdvancedEditorSeam(surfaceId: string, controls: import('../extension/advanced-types.ts').AdvancedEditorControls): void
      // Phase 4: the ADVANCED imperative-UI + host-state seams.
      setAdvancedUiSeam(
        surfaceId: string,
        ui: {
          select(options: import('../extension/advanced-types.ts').AdvancedSelectOptions): Promise<string | undefined>
          confirm(options: import('../extension/advanced-types.ts').AdvancedConfirmOptions): Promise<boolean>
          input(options: import('../extension/advanced-types.ts').AdvancedInputOptions): Promise<string | undefined>
          notify(message: string, options?: import('../extension/advanced-types.ts').AdvancedNotifyOptions): void
          custom(factory: (host: import('../extension/advanced-types.ts').AdvancedCustomHost) => import('../extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('../extension/public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
        },
      ): void
      setAdvancedHostSeam(surfaceId: string, state: import('../extension/advanced-types.ts').AdvancedHostState): void
      // Phase 3: the UNSTABLE seam (the `extensions/unstable` facade's
      // internal surface — the runner wires the raw input route, the
      // fail-safe release and the low-level surface seam through it).
      _unstableInputRoute(data: string, surfaceId: string): import('../extension/internal/unstable-input.ts').UnstableRawRouteResult
      _unstableInputsLive(): boolean
      _unstableInputsRevision(): number
      _unstableEmergencyRelease(): void
      setUnstableSurfaceSeam(surfaceId: string, handle: import('../extension/unstable-types.ts').UnstableSurfaceHandle): void
    }) | undefined
    // The extension surface host and the generation-LEASED theme-unload hook
    // release are A4-5 surface-owned resources (`surface.attachExtensionHost` /
    // `surface.dispose`); the runner no longer holds their slots.
    // Tool-card presentation bridge: the Web's render intents resolved from
    // the LIVE tool registry as the agent sees it (scoped lookup), so the
    // rendered card matches the definition that actually executed. The scope
    // must be the AGENT OBJECT — the agent's scope layer is keyed by it
    // (createScope(loopCtx, this)), exactly like the host apiproxy's
    // ctx.tools.get(name, ctx.agents.get(session.id)). Passing the agent's
    // CONTEXT instead misses the agent layer entirely: presentCall/
    // presentResult would return no views and every card would fall back to
    // raw text (read still works via its envelope fallback, edit loses its
    // diff). The registry is read through ctx.get: property access
    // (ctx.tools) trips cordis's inject guard, and an absent registry must
    // degrade to generic cards rather than fail the render.
    const tools = ctx.get('tools') as { get(name: string, scope?: object): ToolDefinitionLike | undefined } | undefined
    const present = toolPresenterFrom(name => {
      const agent = agentNow()
      if (agent === undefined) return undefined
      return tools?.get(name, agent)
    })
    // Stable signal snapshot of the runner-owned lifecycle controller.
    const signal = lifecycleController.signal
    // Draft stores are Client-local UI state. Image bytes are bounded in
    // memory; generic files retain metadata/fingerprints only and stream at
    // submit time.
    const draftImages = new DraftImageStore()
    const draftFiles = new DraftFileStore()
    // All command/fork/rewind lifecycle calls share this composition-root
    // bridge so no child-creation path can bypass the runner lifetime.
    const lifecycleAgents: TuiCommandRunner['agents'] = {
      create: async (options) => requireCreated(await backend.sessionLifecycle.create({ ...options, signal })),
      open: async (options) => requireOpened(await backend.sessionLifecycle.open({ ...options, signal })),
    }
    // A5b-4: the local shell owner (`!` / `!!` + the shared live-Agent
    // interrupt). Constructed BEFORE the surface cleanup closure can run; its
    // submission acknowledgement seams are late-bound (the controller is
    // built below).
    const localShell = createLocalShell<Agent>({
      app: () => app,
      diag,
      isCleanedUp: () => cleanedUp,
      liveAgent: () => agentNow(),
      ownership: { generation: () => ownership.generation() },
      session: { withWriter: (scope, task) => sessionRuntime.withWriter(scope, task) },
      requireLiveScope,
      writerSection: (task) => submission.withWriterSection(task),
      writer: backend.sessionWriter,
      status: { sessionCwd: () => status.sessionCwd() },
      tuiSettings,
      resolveShell: () => ctx.get('shell') as unknown as LocalShellCapability | undefined,
      submission: {
        settleAck: (reason, options) => submission.settleLocalSubmitAck(reason, options),
        markDispatch: (sessionId) => submission.markDispatch(sessionId),
      },
    })

    // Idempotent CLIENT-SURFACE teardown: abort lifecycle loads, stop the
    // TUI. Shared by /exit, the effect cleanup, and the startup-failure
    // path. The Direct owned-session retirement is a SEPARATE step
    // (retireOwnedSession below) that runs after the surface stops — diag
    // stays open until the retirement diagnostics are recorded.
    const disposeSurface = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      // Fence the completion-notification controller (surface-owned, A4-4):
      // after teardown a late `agent/status` idle from the old live agent must
      // never emit a notification into a dead surface (the identity fence drops
      // every event once the live id is undefined).
      surface.setCompletionOwner(undefined)
      // Disable terminal focus reporting FIRST — before any throwable
      // teardown step — so the mode can never leak into the shell even
      // when a later teardown operation throws (idempotent: a startup
      // failure that never enabled it writes a harmless no-op).
      surface.disableFocusReporting()
      // The DSH SessionWriteLease (kernel flock) is the only cross-process
      // writer authority: a clean TUI exit needs no TUI-side lock
      // bookkeeping — the lease is released by the DSH session teardown
      // (the TUI's physical owner.lock / lease / cooling stack is removed
      // legacy).
      lifecycleController.abort()
      draftImages.clear()
      draftFiles.clear()
      // Abort any in-flight catalog refresh: its late result must never
      // register commands or repaint after the app is gone.
      command.disposeCatalog()
      // Release the Plugin Manager install-event subscription at its original
      // EARLY position (a late install event must never notify/repaint a dying
      // surface). The subscription is surface-owned (A4-5).
      surface.disposePluginManager()
      // PR D2: cancel the deferred initial context measure — a stale
      // callback must never measure/repaint into the disposed surface.
      status.cancelDeferred()
      // M5: release the footer command surface BEFORE the app dies — a
      // late status-store notification must not refresh into a disposed
      // surface. The lifecycle abort above already disposes an armed
      // runner through its own abort listener; the explicit unsubscribe +
      // dispose keeps the release symmetric with the arm path and also
      // covers the teardown-before-arm window (both idempotent).
      settings.disposeFooterCommand()
      localShell.dispose()
      // TuiApp.dispose() hides overlays without invoking their user cancel
      // callbacks. The Task Center / Job viewer resources are surface-owned
      // (A4-6) and released in their original order: the jobs-event
      // subscription first (no Job listener may refresh a dying surface), then
      // the selected-Job observation, then the browser handle/token.
      surface.disposeJobEvents()
      surface.disposeJobObservation()
      surface.disposeTaskBrowser()
      // The mounted TuiApp, the plugin keybinding sync, the theme-unload hook
      // and the extension surface bridge are released by their surface owner
      // (A4): the runner steps around this call release only what the runner
      // still owns.
      surface.dispose()
      // NOTE: diag.dispose() is NOT here — the Direct owned-session
      // retirement (retireOwnedSession) records its diagnostics first and
      // closes diag last (see below).
    }
    // The ONE exit orchestration, shared by every exit entry (the exit keys,
    // /exit, /quit): latch once → dispose/restore the Client surface →
    // synchronously pre-cancel the exact current Direct owner → resume-hint
    // policy → request appExit. A later request while one is in flight is a
    // no-op (createExitController latches), so a command plus a key can never
    // double-cleanup or double-exit. Only the FIRST cancel is brought forward;
    // the full retirement (idle → descendants → flush → dispose) is still NOT
    // awaited here — it runs inside the application-tree disposal that appExit
    // starts, under the DSH process-shutdown watchdog (see docs/concurrency.md).
    const { requestExit } = createExitController({
      diag,
      cleanup: disposeSurface,
      prepareRetirement: sessionRuntime.preCancelOwnedSession,
      hint: (message) => process.stdout.write(`\n${message}\n`),
      resumeHint: () => {
        // The Host's profileContext names the profile for EVERY launch form,
        // including the positional `dsh <name>` (see hostRunningProfile): the
        // argv scrape alone would answer the pi-tui fallback there and hand the
        // user a resume command for the wrong profile.
        const resume = resumeCommand(hostRunningProfile(ctx), agentNow()?.session.id ?? '')
        return resume === undefined ? undefined : `${color.textDim('To resume this session:')} ${resume}`
      },
      exit,
    })
    // A pre-mount unload can happen during the initial resume/catalog awaits;
    // never register a full effect on the already-disposed fiber or fall into
    // the fatal startup path.
    if (lifecycleController.signal.aborted) {
      startupStatus.clear()
      // A pre-mount unload AFTER the resume succeeded: the fiber disposer
      // below was never registered, so retire the Direct owner here before
      // returning (the transition gate / barrier / retirement helper are
      // all defined by this point — the resume that produced the live
      // agent ran after them). Without a live owner there is nothing to
      // retire; close the diagnostics handle either way (idempotent).
      if (ownership.owner() !== undefined || directRuntime.hasParkedOwners() || sessionRuntime.hasPendingForks()) {
        await sessionRuntime.retireOwnedSession()
      } else {
        diag.dispose()
      }
      return
    }
    // Stop the TUI when this fiber is disposed (a loader hot-reload unloads
    // the row; the reloaded row starts its own instance in the same process).
    // The disposer is ASYNC: the fiber unload awaits it (Cordis contract), so
    // an HMR unload retires the Direct owned session exactly like an
    // interactive exit — surface cleanup first, then the Host retirement.
    // A throwing surface step must NEVER skip the retirement: the surface
    // teardown is protected, the error is recorded (diag is still open —
    // retireOwnedSession closes it last), and the retirement promise is
    // always returned.
    const registerRunnerDisposal = (): void => {
      ctx.effect(function* () {
        yield () => {
          try {
            disposeSurface()
          } catch (error) {
            try {
              diag.error('surface dispose failed', { error: safeErrorMessage(error) })
            } catch {
              // No lower sink.
            }
          }
          return sessionRuntime.retireOwnedSession()
        }
      })
    }
    registerRunnerDisposal()
    // The Direct stream adapter keeps active prefixes for Agents that were not
    // being displayed yet; enterView replays this exact-agent baseline before
    // mounting the child surface.
    let assistantStreamBaselineFor: (agent: object) => readonly AssistantLiveInput[] = () => []
    // A5b-1: the subagent viewer owner. The exact-Agent facts stay in the
    // composition root (the Direct registry + the assistant-stream install) and
    // reach the viewer through these narrow capabilities.
    const viewer = createViewerRuntime<SessionEvent, Agent>({
      surface,
      isCleanedUp: () => cleanedUp,
      currentSessionId: () => ownership.currentSessionId(),
      liveParentSessionId: () => agentNow()?.session.id,
      childSession: (childId) => sessions.get(SessionId(childId)),
      observeChild: (childId) => {
        const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
        if (query?.observeSession === undefined) return undefined
        return query.observeSession(SessionId(childId), { projectionMode: 'none' })
      },
      childAgent: (childId) => agents.get(SessionId(childId)),
      assistantStreamBaselineFor: (agent) => assistantStreamBaselineFor(agent),
      refreshStatus: () => status.refresh(),
      restoreMainTranscriptAnchor: () => presentation.restoreMainTranscriptAnchor(),
    })
    viewerRef = viewer
    // A5b-4: the submission/input controller — the submit FIFO turn, the local
    // submit acknowledgement + latency timeline, the client-local echoes, the
    // session/command dispatch and the Alt+Up pull-back. Writer authority stays
    // in SubmissionRuntime + SessionRuntime.withWriter; this owner only
    // supplies the semantic hooks.
    const submission = createSubmissionController<Agent>({
      app: () => app,
      diag,
      signal,
      isCleanedUp: () => cleanedUp,
      logError: (message) => {
        try {
          ctx.logger.error(message)
        } catch {
          // The cordis logger must not block the notice.
        }
      },
      liveAgent: () => agentNow(),
      ownership: {
        generation: () => ownership.generation(),
        captureSubject: () => ownership.captureSubject(),
        transitionPending: () => ownership.gate.pending || ownership.barrier.inTransition,
      },
      scope: {
        captureLive: () => sessionScope.captureLive(),
        isCurrent: (scope) => sessionScope.isCurrent(scope),
        requireLive: requireLiveScope,
      },
      session: {
        ensureSession: () => sessionRuntime.ensureSession(),
        beginCommandSettlement: () => sessionRuntime.beginCommandSettlement(),
        abortCommandSettlement: () => sessionRuntime.abortCommandSettlement(),
        settleCommandSettlement: () => sessionRuntime.settleCommandSettlement(),
        trackSettlementWork: (work) => sessionRuntime.trackSettlementWork(work),
      },
      submissionRuntime: {
        withWriter: (scope, task) => submissionRuntime.withWriter(scope, task),
        submitPrompt: (promptSubmission) => submissionRuntime.submitPrompt(promptSubmission),
        deferQueueRecall: (recall) => submissionRuntime.deferQueueRecall(recall),
      },
      command,
      commandPlane: {
        available: () => ctx.get('commands') !== undefined,
        execute: (agent, line, attachments, commandSignal) => {
          const service = ctx.get('commands')
          if (service === undefined) return Promise.resolve(undefined)
          return service.execute(agent as Agent, line, attachments as Parameters<typeof service.execute>[2], commandSignal)
        },
        findHandler: (name) => {
          const service = ctx.get('commands')
          const definition = service?.find(undefined as unknown as Agent, name)
          return definition?.handler as unknown as LocalCommandHandler | undefined
        },
      },
      backend: {
        hostFile: backend.hostFile,
        pendingInputReader: backend.pendingInputReader,
        sessionWriter: backend.sessionWriter,
        hostCommand: backend.hostCommand,
      },
      drafts: {
        get images() { return draftImages },
        get files() { return draftFiles },
      },
      status: { sessionCwd: () => status.sessionCwd() },
      surface: { refreshPendingInput: () => surface.refreshPendingInput() },
      history: {
        persist: (record) => history.persist(record),
        persistAfterSession: (resolveSession, persist) => history.persistAfterSession(resolveSession, persist),
      },
      viewer: { isViewing: () => viewer.isViewing() },
      extensions: {
        findContribution: (name) => extensionService?.commands.find(name),
        handlerFor: (name) => extensionService?.commands.handlerFor(name),
        commandIdFor: (name) => extensionService?.commands.idFor(name),
        isLocal: (name, staticLocal) => extensionService?.commands.isLocal(name, staticLocal) ?? false,
        recordHealthRef: (slot, id) => extensionService?._recordRegistryHealthRef(slot, id),
        recordError: (ref, error) => extensionService?._recordRegistryError(ref as { slot: string; id: string; owner: string }, error),
        clearError: (ref) => extensionService?._clearRegistryError(ref as { slot: string; id: string; owner: string }),
      },
      artifacts: { start: (name, agent) => artifacts.start(name, agent) },
      shell: {
        run: (text, ackToken) => localShell.run(text, ackToken),
        interrupt: () => localShell.interrupt(),
      },
      model: { selected: { get current() { return model.selected.current } } },
      image: {
        attachments: () => ctx.get('attachments') as PrepareInputDeps['attachments'],
        llm: () => ctx.get('llm') as PrepareInputDeps['llm'],
      },
      tuiSettings,
      captureMatches,
      direct: {
        withPromptAdmission: (agent, hasImages, task) => directRuntime.withPromptAdmission(agent as Agent, hasImages, task),
      },
      requestExit,
      isPlanActive: (agent) => projectedPlanActive(ctx.get('sessionProjections') as PlanProjectionLike | undefined, (agent as Agent).session) === true,
    })

    // A5b-3c: the client-local artifact-save workflow (`/export` +
    // `/transcript`), including its in-flight dedupe set and save-location
    // dialog. Consumed by the session dispatch below.
    const artifacts = createArtifactSaveOwner<Agent>({
      app: () => app,
      isCleanedUp: () => cleanedUp,
      signal,
      diag,
      sessionArchive: backend.sessionArchive,
      clientCwd: cwd,
    })
    // M3 runner wiring (F-1): when the extension host service is mounted,
    // the TUI surface attaches a SurfaceHost over its ledger — extensions
    // (including the first-party builtins) render into the chrome. Without
    // the service the surface runs exactly as before (host fallbacks). A4-5:
    // the host and its generation-leased theme-unload hook are surface-owned;
    // the runner only resolves the service (it never becomes a service
    // locator inside `app/surface`).
    extensionService = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof extensionService
    if (extensionService !== undefined) surface.attachExtensionHost(extensionService)
    // The TUI is about to mount: the pre-mount status line must be gone
    // before the first frame (no stale scrollback line after mount).
    if (lifecycleController.signal.aborted) return
    startupStatus.clear()
    // ── Plugin Manager (P1-A) ──────────────────────────────────────────────
    // ONE controller/panel for both entries (`/plugins` and
    // `/settings → Plugins`). A4-5: the controller, the token-owned host
    // registry and both entries are surface-owned; the runner resolves only the
    // semantic plugin-manager port and holds the returned entries for its
    // command layer.
    const pluginManager = surface.attachPluginManager({ port: backend.pluginManager, diag })
    // A4: the application input contract owned by the session/submission/
    // command layers. The surface owner (`surface.start` below) owns the mount
    // and the surface-local option wiring; the runner hands this table in
    // unchanged.
    // A5b-5: the application-event owner (the COMPLETE TuiAppEvents adapter).
    // Built from the A5b owner objects plus the narrow runner lifetime
    // callbacks and the rewind/subagent Host-port groups that have no narrower
    // owner today; the mount below receives the produced adapter.
    applicationEvents = createApplicationEvents({
      submission,
      viewer,
      surface,
      status,
      settings,
      client: clientActions,
      drafts: { get images() { return draftImages }, get files() { return draftFiles } },
      imageLimits: () => ctx.get('attachments')?.imageLimits as Parameters<typeof checkImageLimits>[2] | undefined,
      rewind: {
        forkSession: (sourceSessionId, atSeq, onAdopted, pickerIdentity) =>
          sessionRuntime.forkSession(sourceSessionId, atSeq, onAdopted, pickerIdentity),
      },
      // The subagent viewer's Host delivery ports (the viewer STATE stays in
      // the A5b-1 viewer owner). These are the Direct parent resolution and
      // the Backend prompt/writer/host-file ports; the composition root only
      // forwards them.
      subagentDelivery: {
        queueAgentFor: (childId) => directRuntime.queueAgentFor(childId) as unknown as SteerAgentLike | undefined,
        pendingInputReader: backend.pendingInputReader,
        writer: backend.sessionWriter,
        writerSection: (task) => submission.withWriterSection(task),
        subagent: backend.subagent,
        hostFile: backend.hostFile,
      },
      // The few runner lifetime/identity callbacks (diag pre-attached once).
      lifecycle: {
        runOwned: (label, task, options) => runOwned(label, task, {
          ...options,
          diag,
          sessionId: options?.sessionId ?? (() => agentNow()?.session.id),
        }),
        isCleanedUp: () => cleanedUp,
        requestExit,
        liveAgent: () => agentNow(),
        generation: () => ownership.generation(),
        currentSessionId: () => ownership.currentSessionId(),
        navigationEpoch: () => ownership.navigationEpoch(),
        signal: () => lifecycleController.signal,
      },
    })
    // A4: mount through the surface owner. The surface builds the surface-local
    // option wiring (image loader, history-search binding, clipboard/link
    // capabilities, extension registries + input routes, resize/workflow hooks)
    // from these narrow injected capabilities and owns the mounted TuiApp from
    // here on.
    surface.start({
      events: applicationEvents.events,
      workspaceRoot: cwd,
      // The structural icon palette: read ONCE at startup from the persisted
      // document; runtime switches go through app.setIconStyle (the /settings
      // write path) — never a deep settings read per render.
      iconStyle: iconStyleOf(tuiSettings?.get().iconStyle),
      displayState,
      // Ctrl+R input-history search: the runner owns the IO (the file-backed
      // source + the known-cwd identity map), the surface owns the panel
      // lifecycle (plan §27 — TuiApp never touches the filesystem).
      historySearchSource: new FileHistorySearchSource({
        dshHome: dshHome(process.env),
        // A RESOLVER, not a snapshot: the all-scope search must see the
        // newest known cwds (sessions created/switched after startup).
        knownCwds: () => history.knownCwds(),
      }),
      // The durable-image read (plan M8/M10): history images resolve through
      // `ctx.attachments.readImage` only — never the draft store. The read
      // callback is a late-bound service access (AGENTS.md: never a bare
      // property read of a non-injected service).
      readImage: (ref) => {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          throw new ImageLoadError('Image attachments are unavailable in this deployment.')
        }
        return attachments.readImage(ref as never) as Promise<{ ref: unknown; data: Uint8Array }>
      },
      present,
      sessionCwd: () => status.sessionCwd(),
      // The session scope's identity — a GETTER like the cwd: a session switch
      // must make the next Ctrl+R search the NEW session (the panel captures it
      // once at open time).
      sessionId: () => agentNow()?.session.id,
      // M5: a material width change refreshes the command surface (the runner
      // coalesces to its interval).
      onTerminalResize: () => settings.requestFooterCommandRefresh(),
      // Issue #7: the fullscreen drag selection and `/copy` are the SAME user
      // copy intent and share ONE clipboard policy. That policy delivers
      // through two independent legs (terminal-client OSC 52 + native/helper
      // compatibility) and never lets a host helper success suppress the OSC 52
      // leg — otherwise a remote host helper would strand the copy in the
      // remote clipboard.
      copySelection: (text) => clientActions.copySelection(text),
      // Fullscreen OSC 8 link clicks + the Windows right-click paste: the alt
      // screen's mouse capture swallows both native behaviors, so the host
      // opens http/https links itself and reads the clipboard through the same
      // platform-aware policy as the image paste probe.
      openExternalUrl: (url) => openExternalUrl(url),
      readClipboardText: () => clientActions.readClipboardText(),
    })
    // The mounted surface is now live; the runner borrows the reference (the
    // surface owner keeps the lifetime).
    app = surface.app
    settings.applySafeKeybindingsMode()
    settings.applyUserKeybindings()
    // M3: the user keybindings reload seam is EXPLICIT — `/keybindings
    // reload` re-reads the settings document and re-validates/rebuilds the
    // keymap (plan §12/§16). There is deliberately NO automatic settings
    // watch here: a `watch(callback)` would be a Direct-only dependency —
    // the TuiSettingsConfig port is get/replace only, a future Remote
    // adapter cannot map a callback across the process boundary, and the
    // migration rule forbids callbacks across the wire (see
    // docs/client-server-migration.md). A settings edit takes effect after
    // `/keybindings reload`; the fail-soft parser above keeps the keymap's
    // last-known-good state on any read/parse error.
    // M2: the plugin contributions compile into the effective keymap at the
    // LOWEST priority (a Host action always wins). A4-5: the sync and its
    // registry subscription are surface-owned (`surface.bindPluginKeybinds`);
    // the surface syncs on every invalidation (the manager skips unchanged
    // rules, so the rebuild is cheap) and releases the subscription with the
    // surface teardown.
    surface.bindPluginKeybinds()

    // The Task Browser opener, the browser-scope reset and the Workflow card
    // action sink are A4-6 surface-owned (`surface.openTasksBrowser` /
    // `surface.resetTasks` / the surface-internal workflow handler wired as the
    // app's `onWorkflowAction`); the runner only forwards the `/tasks` entry
    // below.
    // M3: attach the extension host to the mounted surface chrome once per
    // generation (F-1): the header/dock/footer merge extension content, and the
    // service's capability set + state bridge become live. A4-5: the whole
    // attach composition is surface-owned; the runner supplies only the
    // late-bound command-completion refresh (a client command contribution may
    // join the `/` menu after mount).
    surface.attachSurfaceSeams({ refreshCommandCompletions: () => command.refreshCompletions() })
    // (new installs default to 'on' — alt screen by default): boot applies
    // it FIRST so the alt screen owns the terminal input handler before any
    // theme query below targets "the active screen" — a query sent while the
    // main screen still owned input would have its reply swallowed by the
    // alt screen's OSC 11 consumer and time out, silently disabling `auto`.
    // Focus Mode's TUI projection is a persisted visual preference like
    // Home/End/fullscreen/theme: the app must reflect the RESTORED state
    // before the first frame — otherwise the system prompt would tell the
    // model the user cannot see the process while the UI still shows it in
    // full (review blocker: the two halves of Focus would split).
    // The app already receives the shared displayState at construction, so the
    // first mounted frame cannot flash a different preset.
    // Terminal focus reporting (CSI ? 1004) for the completion
    // notification policy: enabled at TUI mount, disabled in cleanup so
    // the mode never leaks into the shell after exit. The app already
    // passes the ESC[I/ESC[O reports through to the surface's tracker
    // (A4-4). The guarded writer swallows a broken-stream error; a
    // synchronous throw is contained so a dead stdout can never fail the
    // TUI mount.
    surface.enableFocusReporting()
    // A5b-2: the RESTORED display preferences (Home/End, wheel, fullscreen,
    // theme) are applied by their owner at this SAME startup position — before
    // the first frame and after the alt screen owns input.
    settings.applyBootDisplay()
    settings.applyFooterSettings()
    // The retired per-cwd input history (which used to live inside the old
    // settings namespace) is deliberately NOT migrated in PR A (plan §8.5):
    // it stays in the read-only legacy settings.yaml(.imported); the JSONL
    // history store remains the sole live history authority.
    // Input history is loaded PER SESSION by initLiveSession (keyed on the
    // live session's cwd), never once at boot: a session switch to another
    // workspace must replace the recall history, not keep the old one. With
    // a DEFERRED start no session exists yet, so initLiveSession has not
    // run: seed the recall history from the LAUNCH cwd now, so ↑ works
    // immediately in a fresh window (the per-session reseed replaces it
    // when the first session is born).
    history.activateBootRecall()
    // Fresh/deferred startup title: no session yet — cwd identity only.
    status.refreshTerminalTitle()
    surface.attachEventRouting({
      isCleanedUp: () => cleanedUp,
      isAttachedSession: (session) => {
        const attachedSession = sessions.get(SessionId(session.id))
        return attachedSession === undefined || attachedSession === session
      },
      currentSessionId: () => ownership.currentSessionId(),
      hasLiveAgent: () => agentNow() !== undefined,
      completionOwnerId: () => {
        const owner = ownership.owner()
        return owner === undefined ? undefined : directRuntime.owners.completionIdentity(owner)
      },
      // Direct bookkeeping (plan §16): model-selection observation, the
      // request-header consume, the call-args cache, the pending-subagent feed
      // and the viewed-child settle map all stay runner-owned.
      observeMainEvent: (sessionId, event) => {
        const runtimeAgent = agents.get(SessionId(sessionId)) as Agent | undefined
        let settledViewChildId: string | undefined
        let refreshAgents = false
        const selectionEvent = event as unknown as { type?: unknown; data?: unknown }
        if (selectionEvent.type === 'model/selection') {
          if (runtimeAgent !== undefined) directRuntime.modelSelections.observeSelectionEvent(runtimeAgent, selectionEvent)
        } else if (event.type === 'request/header' && runtimeAgent !== undefined) {
          const data = event.data as unknown
          const header = typeof data === 'object' && data !== null
            ? (data as { header?: unknown }).header
            : undefined
          const raw = rawSelectionFromRequestHeader(header)
          if (raw !== undefined) {
            directRuntime.modelSelections.consumeSelection(runtimeAgent, raw.provider, raw.model, raw.reasoningEffort)
          }
        }
        if (event.type === 'tool/call') {
          presentation.setToolArgs(event.data.callId, typeof event.data.arguments === 'string'
            ? event.data.arguments
            : JSON.stringify(event.data.arguments))
          if (typeof event.data.name === 'string' && event.data.name.startsWith('subagent')) {
            // The subagent-refresh DECISION is surface-owned (A4-7 P2): report
            // the presentation intent; `routeSessionEvent` performs the
            // refresh. The intent is recorded at the ORIGINAL position (before
            // the description parse/push); the refresh schedules async catalog
            // work and reads no state this bookkeeping mutates, so the
            // observable order is unchanged.
            refreshAgents = true
            let description = ''
            try {
              const parsed = JSON.parse(event.data.arguments)
              if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { description?: unknown }).description === 'string') {
                description = (parsed as { description: string }).description
              }
            } catch {
              // A non-JSON arguments payload carries no matchable description.
            }
            viewer.noteSubagentCall(event.data.callId, description)
          }
        } else if (event.type === 'tool/result') {
          // Session V4: the durable tool-role message owns the call identity
          // directly (no user-role wrapper to unwrap).
          const callId = event.data.message.toolCallId
          presentation.deleteToolArgs(callId)
          settledViewChildId = viewer.settleSubagentCall(callId)
        }
        return { settledViewChildId, refreshAgents }
      },
      // The opening viewer's buffer stays runner-owned (`openingViewer` /
      // `viewerOpen`); the surface owns the decision to route into it.
      appendOpeningViewerEvent: (sessionId, event) => {
        return viewer.appendOpeningEvent(sessionId, event)
      },
      main: () => presentation.main,
      viewedChildId: () => viewer.read()?.id,
      viewedChild: () => viewer.presentation(),
      mainFolder: () => presentation.mainFolder(),
      viewedChildFolder: () => viewer.read()!.folder,
      // A4-4 pending-input capabilities: the semantic subject + snapshot read,
      // the client-local submission echoes and the text projection. The
      // presentation join/own-input/viewport policy is surface-owned.
      pendingSubjectId: () => viewer.pendingSubjectId(),
      pendingSnapshot: (sessionId) => backend.pendingInputReader.snapshot(sessionId),
      submissionEchoes: (sessionId) => submission.snapshotEchoes(sessionId),
      queueTextOf: content => queueTextOf(content as readonly import('@deepseek-ai/dsh-llm').ContentBlock[]),
      exitView: () => { viewer.exitView() },
      refreshStatusCheap: () => status.refresh(),
      refreshStatusAndWelcome: () => {
        status.refresh()
        status.updateWelcomeCard()
      },
      applyGoalChange: (event) => status.applyGoalChange(event),
      sessionTitleOf: (event) => foldSessionTitle([event])?.title,
      settleLocalSubmitAck: (reason) => submission.settleLocalSubmitAck(reason),
      markSubmitLatency: (sessionId, phase) => { submission.markLatency(sessionId, phase) },
      observeDurableSubmission: (rpcId) => submission.observeDurable(rpcId),
      markContextDirty: () => status.markContextDirty(),
      refreshContextMeasurement: (reason) => status.refreshContextMeasurement(reason),
      // Bound late: these helpers are declared AFTER the startup calls that
      // read the routing source (they only run from the live event firehose).
      currentWorkingFromLog: () => currentWorkingFromLog(),
      flushTurn: () => flushTurn(),
      // The assistant-stream routing's exact-Agent facts (never a Direct import
      // in the surface).
      registeredAgentIs: (sessionId, agent) => directRuntime.registeredAgentFor(sessionId) === agent,
      isCurrentOwnerAgent: (agent) => isCurrentOwnerAgent(agent as Agent),
      viewedChildAgent: () => viewer.viewedChildAgent(),
      setViewedChildAgent: (agent) => viewer.setViewedChildAgent(agent as Agent),
      setViewedQueueAgent: (agent) => viewer.setViewedQueueAgent(agent as Agent),
      agentForSession: (sessionId) => agents.get(SessionId(sessionId)),
      applyViewedChildAssistantInput: (input) => viewer.applyAssistantInput(input),
      applyMainAssistantInput: (input, sessionId) => {
        presentation.applyAssistantInput(input)
        if (input.kind === 'chunk' && isAssistantTokenDelta(input.chunk)) {
          submission.markLatency(sessionId, 'assistant.first')
        }
      },
    })
    // A4-6: the Task Browser + Job viewer wiring is surface-owned. The runner
    // injects the narrow production capability the surface needs (plan §15.2):
    // the live session id, the ownership-subject fence, the jobs registry reads,
    // the subagent `TaskBrowserRuntime` hooks, the child viewer + the
    // writer-admitted interrupt, the selected-Job observation port and the root
    // row-disposition helpers. No new Backend port and no second task model.
    const jobs = ctx.get('jobs')
    const subagents = ctx.get('subagents')
    surface.attachTasks({
      sessionId: () => agentNow()?.session.id,
      captureSubject: () => ownership.captureSubject(),
      subjectMatches: (subject) => captureMatches(subject),
      // The viewer target carries the row's OWN parent; only a direct child
      // falls back to the live main session (already resolved in the surface).
      // `depth` is the nested-authority input the viewer owner turns into the
      // read-only `readonly-nested` access; it is the optional 6th parameter
      // `TaskSurfaceSource.enterView` declares, so it must be forwarded — never
      // defaulted at the composition seam.
      enterView: (childId: string, label: string | undefined, mode: 'one-shot' | 'continuable', parentSessionId: string, activity: 'running' | 'inactive', depth?: number) =>
        viewer.enterView(childId, label, mode, parentSessionId, activity, depth),
      // The scope-bound writer admission (A3-4) stays in the runner: the
      // Task-Center subagent interrupt is not a submission write, so only its
      // admission moves through SessionRuntime.withWriter.
      interruptSubagent: (parentSessionId, childSessionId) =>
        sessionRuntime.withWriter(requireLiveScope(), () => backend.subagent.interrupt({
          parentSessionId: parentSessionId as SessionId,
          childSessionId: childSessionId as SessionId,
          mode: 'continuable',
        })),
      rowSelectionDisposition: taskRowSelectionDisposition,
      subagentJobTranscriptId,
      subagentJobViewHint,
      jobObservation: backend.jobObservation,
      jobs: jobs === undefined ? undefined : {
        // Job ownership is the Session id (DSH 0.1.7 JobRegistry); the caller
        // may be omitted (the unowned-only view) when no session is live.
        list: (sessionId) => jobs.list(sessionId as SessionId | undefined),
        subscribe: (listener) => jobs.events.subscribe({ owners: 'scope' }, listener),
        get: (jobId, sessionId) => jobs.get(jobId as JobId, sessionId as SessionId),
        kill: (jobId, sessionId, reason) => jobs.kill(jobId as JobId, sessionId as SessionId, reason),
      },
      agents: subagents === undefined ? undefined : {
        // The session fence key: generation + session id, captured when a
        // refresh starts and re-checked after the async listing.
        currentKey: () => {
          const sessionId = ownership.currentSessionId()
          return cleanedUp || sessionId === undefined ? undefined : `${ownership.generation()}:${sessionId}`
        },
        // The Task-Center owner derives the jobs-read session id from this
        // injected core read; the retention fence itself is owner-side.
        currentSessionId: () => ownership.currentSessionId(),
        listDescendants: () => {
          const sessionId = agentNow()?.session.id
          return sessionId === undefined ? Promise.resolve([]) : subagents.listDescendants(sessionId)
        },
        // The LIVE runtime fact, read at COMMIT time: the Agent registry,
        // never the catalog's store-presence activity.
        agentStatusOf: (childId) => agents?.get(childId as SessionId)?.status,
      },
    }, {
      diag,
      isCleanedUp: () => cleanedUp,
    })
    surface.refreshPendingInput()
    // A5b-3: the semantic command runtime binding AND the facade assembly are
    // command-owned; the composition root only triggers the wiring step.
    command.attachRuntime()
    /**
     * Bind the submission runtime (A3-3). Its surface is the runner's narrow
     * hooks; every write it performs enters through `SessionRuntime.withWriter`
     * and the owner-resolved prompt admission, so the writer-first contract and
     * the per-Agent image window are unchanged.
     */
    submissionRuntime = bindSubmissionRuntime({
      surface: {
        withWriter: <T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T> =>
          sessionRuntime.withWriter(scope, task),
        withPromptAdmission: <T>(scope: LiveSessionScope, line: string, task: () => Promise<T>): Promise<T> =>
          command.runner().withPromptAdmission(scope, line, task),
        isDisposed: () => cleanedUp,
        isScopeCurrent: (scope) => sessionScope.isCurrent(scope),
        mergeDraftIntoEditor: (text) => {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          return merged === text
        },
        consumeDraftAttachments: (text) => consumeDraftAttachments(text, draftImages, draftFiles),
        markDispatch: (sessionId) => submission.markDispatch(sessionId),
        beginLocalSubmission: ({ requestId, text, scope, generation, ackToken }) => {
          const agent = command.agentForLiveScope(scope)
          submission.beginLocalSubmission({
            requestId,
            text,
            mode: 'queue',
            running: agent.status === 'running',
            sessionId: agent.session.id,
            generation,
            ackToken,
          })
        },
        settleLocalSubmission: (requestId) => submission.settleLocalSubmission(requestId),
        settleSubmitAck: (reason, options) => submission.settleLocalSubmitAck(reason, options),
        notify: (message, kind) => app.notify(message, kind),
        refuseByTransitionFence: (text) => refuseByTransitionFence(
          text,
          () => app.getDraft(),
          (t) => app.setEditorText(t),
          (m, k) => app.notify(m, k),
        ),
        prepareMessage: (text, requestId) => submission.prepareMessage(text, requestId),
        prompt: (sessionId, message) => backend.sessionWriter.prompt(sessionId, message, 'queue'),
      },
    })
    // The startup surface: a resumed session initializes everything; the
    // deferred path shows the pre-session invitation until the first message.
    const startupAgent = agentNow()
    if (startupAgent !== undefined) {
      // The initial owner's catalog was prefetched before mount: no
      // duplicate refresh.
      await presentation.initLiveSession(startupAgent)
    } else {
      app.setWelcomeIdle(true)
      status.refresh()
      status.refreshTerminalTitle()
    }
    // Command registration is sessionless: it must run on BOTH startup
    // surfaces (resume path registers inside initLiveSession; the deferred
    // path registers here so /exit /settings /help work before any message).
    // The pre-mount snapshot installs SYNCHRONOUSLY inside registration —
    // the first terminal input cannot arrive before this call stack unwinds.
    command.register({ snapshot: initialSnapshot, skills: initialSkills })
    if (surfaceNotice !== undefined) {
      app.notify(surfaceNotice, 'error')
      surfaceNotice = undefined
    }
    if (resumeFailure !== undefined) {
      app.notify(resumeFailure, 'error')
      resumeFailure = undefined
    }
    // A4-7 (plan §16): the presentation event routing is SURFACE-owned. The
    // routing source (and its main/viewed-child presentation targets) are
    // attached EARLIER, before `surface.attachTasks` and the startup
    // `surface.refreshPendingInput()` calls, because the A4-4/A4-8 surface
    // methods read the source during startup.
    /** The compaction settle's log-end working read: the runner owns the
     *  live-session log read; the surface only decides WHEN the settle
     *  re-measures. */
    const currentWorkingFromLog = (): boolean => {
      const agent = agentNow()
      return agent === undefined ? false : workingFromLog(agent.session.snapshotEvents())
    }
    /** Persist one completed turn (Direct/domain persistence stays runner-owned). */
    const flushTurn = (): void => {
      const agent = agentNow()
      if (agent === undefined) return
      const flushed = agent.session
      runDetached('turn flush', () => sessions.flush(flushed), {
        diag,
        sessionId: () => flushed.id,
        notify: (message) => app.notify(
          `session persistence failed: ${message} — the session log was removed externally; this session can no longer be persisted (restart to recover)`,
          'error',
        ),
        recoverable: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
      })
    }
    ctx.on('session/event', (session, event) => surface.routeSessionEvent(session, event))
    // Session v2 live assistant streams: the TRANSIENT plane
    // (`agent/assistant-stream` frames mapped through the neutral port).
    // Live model output never rides the durable log; the runner routes the
    // neutral input by session id — the main folder/stats/previews for the
    // live agent, the viewer's own folder/stats/previews for a viewed
    // child — and stamps the first-token latency. The identity fence
    // re-reads the live surface so a stale stream from a retired agent
    // never reaches the presentation.
    const assistantStreamHandle = directRuntime.installAssistantStream({
      // A4-7 (plan §16): the routing bodies are surface-owned. The Direct
      // INSTALL stays Direct-owned; the surface exposes the neutral entry
      // points for the identity fence and the per-target fold + repaint.
      isCurrentAgent: (agent) => surface.isCurrentAssistantAgent(agent),
      onInput: (input) => surface.applyAssistantInput(input),
    })
    assistantStreamBaselineFor = assistantStreamHandle.baselineFor
    lifecycleController.signal.addEventListener('abort', assistantStreamHandle, { once: true })
    // Subagent lifecycle events drive the continuable-children half of the
    // dock badge (they never register jobs). The events are scoped by the
    // delegating parent, but an UNTAGGED listener (this runner) receives
    // every agent-scoped event — including nested descendants' — so no
    // reachability caveat applies; the tool/call fallback stays as a
    // redundant safety net. These are CATALOG events: membership/tree may
    // have changed, so they re-list (A4-7 surface routing).
    ctx.on('subagent/start', () => surface.routeSubagentLifecycle())
    ctx.on('subagent/end', () => surface.routeSubagentLifecycle())
    // `agent/status` is the LIVE runtime channel: a child's driver transition
    // (running ↔ idle) repaints the task browser and the badge WITHOUT a
    // re-listing (membership changes come only from the lifecycle events, and
    // `listDescendants().activity` is store-presence, never execution state).
    // The MAIN agent's transitions feed the completion-notification controller
    // (the authoritative settled boundary — running → idle on the SAME live
    // agent; children never notify). A4-7: the membership gate, the
    // completion-controller feed and the pending-input microtasks are
    // surface-owned (`surface.routeAgentStatus`); the completion-identity
    // provider stays here.
    ctx.on('agent/status', ({ agent, status }) => surface.routeAgentStatus(agent.id, status))
    // Provider-topology and credential events refresh the footer model row
    // and the welcome card: a /login /logout /add-provider (or an external
    // settings.yaml / .credentials.yaml edit) changes the live provider /
    // model surface, and the status line must not keep showing a stale
    // selection. All three events are capability-optional: an absent llm /
    // settings / credentials service never mounts them, and a throwing
    // listener is contained by the event bus (the refresh is best-effort).
    // A4-7: the refresh routing (the cleanup fence, the namespace filter and
    // the refresh coordination) is surface-owned; the registrations and the
    // credential subscription disposal stay runner-owned.
    ctx.on('llm/adapters-updated', () => surface.routeProviderRefresh())
    ctx.on('settings/document-updated', (ns) => surface.routeSettingsRefresh(ns))
    // The credential event wiring is the config port's (migration M1.9):
    // reference- and record-updated both change the same surface. The
    // subscription is DISPOSED on teardown — a remount/HMR must never
    // accumulate duplicate Host listeners (review finding).
    const disposeCredentialSubscription = backend.config.credentials.onChanged(() => surface.routeProviderRefresh())
    lifecycleController.signal.addEventListener('abort', disposeCredentialSubscription, { once: true })
    // Plan, busy, title, compaction, and todo bootstrap state are installed by
    // initLiveSession together with the two hydrated projections. Keeping all
    // session-owned bootstrap work there avoids a second full-log scan on
    // resume and also makes session switches restore the same state.

    // The approval/question presentation providers are A4-7 surface-owned
    // (`surface.attachInteraction`, plan §13.3/§16). The runner injects only
    // the narrow presentation inputs: the paired tool-call argument lookup
    // (the surface never reads the session-event feed) and the pure
    // dangerous-command predicate.
    surface.attachInteraction(backend.interaction, {
      lookupCallArgs: (callId) => presentation.toolArgs(callId),
      dangerCommand,
    })
  }

  /**
   * Terminal-total final catch of the startup lifecycle root: error
   * observation, logging, abort, dispose and exit are each individually
   * protected, so a hostile rejection or a throwing dependency can never skip
   * the teardown or leak a rejection from this discarded chain.
   */
  const handleStartupFailure = async (error: unknown): Promise<void> => {
    const message = safeErrorMessage(error)
    // Release the shared terminal row BEFORE the first log line. The pre-mount
    // status owns the current row, and a TTY shares one cursor between stdout
    // and stderr: logging first would append the failure to `Starting DSH…`
    // (or `Resuming session…`/`Preparing conversation…`), and the abort
    // listener's later clear would then erase part of that error line. This is
    // the same "clear the status, then write the log" rule the resume-failure
    // path already follows; here it also covers a body failure that threw
    // before its own stage cleanup ran.
    // Contained like every other step of this terminal root: the status writer
    // is an injected output seam with NO never-throws contract (and the Loader
    // barrier's own `finally` clear can land here too), so a throwing clear must
    // not reject this discarded `.catch` chain — that would skip the logs, the
    // abort, the owner retirement and `exit(1)`.
    try {
      startupStatus.clear()
    } catch {
      // A broken status stream must not block the teardown.
    }
    try {
      ctx.logger.error(`tui-runner: ${message}`)
    } catch {
      // The cordis logger must not block the teardown.
    }
    try {
      diag.error('fatal', { error: message })
    } catch {
      // A throwing diagnostics channel must not block the teardown.
    }
    // Startup failure: cancel every in-flight lifecycle load, then tear
    // down. (The runner-internal cleanup() never ran — the body threw.)
    // The pre-mount status line has already been cleared above; the lifecycle
    // abort listener's clear is idempotent.
    // Terminal focus reporting (CSI ? 1004) may already be enabled when
    // the body threw AFTER the TUI mount — disable it here so the mode
    // never leaks into the shell on the startup-failure path either
    // (idempotent when the mount never ran; the guarded writer swallows
    // broken-stream errors, a synchronous throw is contained).
    try {
      notificationWriter.write(DISABLE_FOCUS_REPORTING)
    } catch {
      // The stream may already be gone during the fatal path.
    }
    try {
      lifecycleController.abort()
    } catch {
      // The abort must not block dispose/exit.
    }
    // A startup failure AFTER the Direct owner was created (the resume
    // succeeded, then a later initialization threw) must still retire the
    // owned session — the SAME memoized teardown the fiber disposer uses.
    // The wait is BOUNDED: a busy LLM could hang the retirement's whenIdle,
    // and the fatal exit must never wait unboundedly in front of appExit
    // (the same constraint as the interactive exit). When the fiber
    // disposer is registered, the appExit disposal below joins the same
    // memoized promise under the DSH process-shutdown watchdog; when it is
    // NOT registered (a pre-mount failure), this bounded wait is the only
    // window the retirement gets before the process exits — the bound is
    // generous because the retirement is cancel-first and a healthy
    // teardown settles in milliseconds. diag is closed by the
    // retirement's own finalizer (or by the no-owner branch below).
    try {
      if (currentOwnerPresentRef?.() === true) {
        const retirement = retireOwnedSessionRef?.()
        if (retirement !== undefined) {
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              retirement,
              new Promise<void>(resolve => { timer = setTimeout(resolve, 2000) }),
            ])
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        } else {
          // Defensive only: the coordinator is defined BEFORE any owner can
          // exist (see the hoisted declaration), so an owner without a
          // coordinator is unreachable. Close diag and exit.
          diag.dispose()
        }
      } else {
        diag.dispose()
      }
    } catch {
      // TDZ (startup failed before the live-owner declarations ran — no
      // owner existed then either) or a synchronous retirement failure:
      // never block the fatal exit.
      try {
        diag.dispose()
      } catch {
        // The dispose must not block the process exit.
      }
    }
    try {
      exit(1)
    } catch {
      // The last step; there is no lower sink.
    }
  }

  void startRunner().catch(handleStartupFailure) // allowlist: startup lifecycle root — see AGENTS.md
}
