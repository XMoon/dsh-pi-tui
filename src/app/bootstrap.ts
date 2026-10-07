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
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-token-meter'
import { selectBlankSessionPreset, sessionPresetOf } from '../runtime/direct/session-preset-direct.ts'
import { DirectTuiSettings, type SettingsFormsLike } from '../runtime/direct/tui-settings-direct.ts'
import type { DefaultModelServiceLike } from '../runtime/direct/model-selection-direct.ts'
import { rawSelectionFromRequestHeader } from '../domain/session/model-selection.ts'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
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
import { createUserShell } from './submission/user-shell.ts'
import { preparePrompt } from './submission/prepared-prompt.ts'
import { createSubmissionController, type LocalCommandHandler } from './submission/controller.ts'
import { createViewerRuntime, type ViewerChildSource, type ViewerRuntime } from './surface/viewer-runtime.ts'
import { createDirectChildViewSource } from './direct/child-view.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from '../tui/transcript/tool-presentation.ts'
import { createClientToolPresenter } from '../tool-presentation-client.ts'
import { parseProgressUpdates, parseResponseStyle, type ProgressUpdatesState, type ResponseStyleState } from '../communication-policy.ts'
import { parseGitAttributionMode, type GitAttributionState } from '../git-attribution.ts'
import { resolveDisplayPreset, type DisplayState } from '../domain/display/preset.ts'
import { guardedStreamWriter } from '../tui/notification/terminal-notifier.ts'
import { createTerminalNotificationPresentation } from '../tui/notification/runtime.ts'
import { sessionStatsFactsOf } from '../domain/status/stats.ts'
import { isAssistantTokenDelta } from '../domain/transcript/usage.ts'
import { projectedPlanActive, type PlanProjectionLike } from '../domain/status/derive-plan.ts'
import { migrateLegacySettings } from './bootstrap/legacy-settings-migration.ts'
import { color } from '../tui/theme/runtime.ts'
import type { TuiApp } from '../tui-app.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../extensions.ts'
import { type CommandRegistryLike, type TuiCommandRunner } from '../commands.ts'
import { diagFromEnv, dshHome, type Diag } from '../runtime/process/diagnostics.ts'
import { runDetached, runOwned } from '../runtime/process/tasks.ts'
import { FileHistorySearchSource } from '../client/history/search.ts'
import { safeErrorMessage } from '../runtime/process/errors.ts'
import { DraftImageStore } from '../client/media/image/draft-store.ts'
import { DraftFileStore } from '../client/media/attachment/file-draft.ts'
import { openExternalUrl } from '../client/url/open.ts'
import { createStartupStatus } from '../tui/startup/status.ts'
import { iconStyleOf } from '../domain/display/icons.ts'
import { checkImageLimits } from '../client/media/image/intake.ts'
import { ImageLoadError } from '../domain/media/errors.ts'
import type { ImageLimitsLike } from '../domain/media/types.ts'
import { consumeDraftAttachments } from '../client/media/draft-attachments.ts'
import type { DirectPrepareInputDeps } from './submission/direct-message-preparation.ts'
import { dshVersion } from '../client/launcher/version.ts'
import { createExitController } from './bootstrap/exit.ts'
import { type SessionRetirementReport } from '../app/session/owner-access.ts'
import { mergeDraft, refuseByTransitionFence, type SteerSubjectLike } from './submission/steer.ts'
import { createDirectApplicationRuntime, type DirectApplicationRuntime } from '../app/direct/runtime.ts'
import type { RemoteApplicationOverride, RemoteTransportLifetime } from '../app/application-runtime.ts'
import { selectApplicationRuntime } from './bootstrap/runtime-selection.ts'
import { createPresentationBridge } from './bootstrap/presentation-bridge.ts'
import { createTaskSource } from './bootstrap/task-source.ts'
import { installRuntimeEventWiring, installSessionEventWiring } from './bootstrap/event-wiring.ts'
import { createFatalLifecycle, createSurfaceLifecycle } from './bootstrap/lifecycle.ts'
import { createSessionStartupHelpers, quiesceResumedOwner } from './bootstrap/session-startup.ts'
import { createSessionOwnershipCore } from '../app/session/ownership-core.ts'
import { bindSessionRuntime } from '../app/session/runtime.ts'
import { createSessionScopeAuthority, type LiveSessionScope } from '../app/session/scope.ts'
import { bindSubmissionRuntime, type SubmissionRuntime } from '../app/submission/runtime.ts'
import type { SessionOwnerRef, SessionSubject } from '../app/session/subject.ts'
import { createSurfaceRuntime } from '../app/surface/runtime.ts'
import { createPluginManagerPanel } from '../tui/plugin-manager/panel.ts'
import { type SessionQueryLike } from '../runtime/direct/session-direct.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc } from '../runtime/config-port.ts'
import type { AssistantLiveInput } from '../runtime/assistant-stream-port.ts'
import { requireCreated, requireOpened, type SessionHandle } from '../runtime/session-lifecycle-port.ts'
import { listGlobalCommands, readSurfaceCatalog, type SurfaceCatalogContext, type SurfaceCommandsService } from '../runtime/direct/surface-catalog.ts'
import { commandSummaryOf, type SurfaceCatalogSnapshot } from '../domain/catalog/surface.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from './command/client-command-registry.ts'
import { composeRemoteSessionStats, composeRemoteLastAssistantText } from './remote/session-facts-compose.ts'
import { type HumanSkillCatalog } from '../domain/catalog/skill.ts'
import { dangerCommand } from '../command-policy.ts'
import { resolveInitialCatalog } from './direct/initial-catalog.ts'
import { subagentJobTranscriptId, taskRowSelectionDisposition, subagentJobViewHint } from '../task-presentation.ts'
import { queueTextOf } from '../app/surface/pending-presentation.ts'
import { bundleVersion, packageVersion } from '../client/launcher/version.ts'
import { resumeCommand } from '../client/launcher/profile.ts'
import { hostRunningProfile, type ProfileContextReadLike } from './bootstrap/profile.ts'

import type { Config } from './config/schema.ts'
import { composeDirectAgent, type DirectAgentComposition } from '../app/direct/composition.ts'

/**
 * The package entry re-exports the authoritative running-profile read through
 * this facade (`index -> facade -> helper`): `app/bootstrap/profile.ts` is a
 * composition helper, so the public root must not import it directly.
 */
export { hostRunningProfile, type ProfileContextReadLike } from './bootstrap/profile.ts'

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
  applyRunnerWithRuntime(ctx, config, undefined)
}

/**
 * The internal L6 composition entry (M3-4 PR2 plan §7.4): `applyRunner`
 * passes `override === undefined`, which keeps the frozen production
 * selection (`kind: 'direct'` through the seam — the source-locked form).
 * An internal/test caller may pass a pre-selected REMOTE application
 * runtime (the aggregate from `createRemoteApplicationRuntime`); the body
 * then selects Remote THROUGH THE SAME SEAM (no second construction path)
 * and consumes the aggregate's presentation source bundle. There is no
 * public/config/env selector: this parameter is reachable only from
 * process-internal composition code and tests.
 */
export function applyRunnerWithRuntime(
  ctx: Context,
  config: Config,
  override: RemoteApplicationOverride | undefined,
): void {
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
  // channel — diag is (see runtime/process/diagnostics.ts).
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
  // The composition zone selects the concrete terminal notification
  // presentation (TS5 §14.3); the application surface consumes the structural
  // port and keeps the completion lifecycle.
  const notificationPresentation = createTerminalNotificationPresentation({ writer: notificationWriter })
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
  // see src/tui/startup/status.ts. The later `Resuming session…` /
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
   * The selected runtime's transport disposer for the terminal-total fatal
   * catch (outside the startup IIFE); assigned once the selection seam ran.
   * Direct is a no-op, so on today's production path this is only ever the
   * inert slot.
   */
  let disposeSelectedTransportRef: (() => Promise<void>) | undefined
  /**
   * The shared surface-cleanup authority for the terminal-total fatal catch
   * (M3-6 PR3 plan D3): assigned immediately after `disposeSurface` is created
   * and before any later startup operation can fail with surface ownership
   * live. An undefined ref means the startup root never reached the surface
   * owner, so the pre-surface fatal path keeps its own minimal focus/abort
   * safety instead of fabricating a mounted-surface cleanup.
   */
  let disposeSurfaceRef: (() => void) | undefined

  /**
   * The terminal-total fatal catch (TS2 §11): the orchestration is owned by
   * `app/bootstrap/lifecycle.ts`; the three late-bound owner refs above stay
   * owned by this composition root and are read through getters, so a failure
   * before an owner exists keeps its minimal focus/abort safety.
   */
  const fatalLifecycle = createFatalLifecycle({
    diag,
    clearStartupStatus: () => startupStatus.clear(),
    logFatal: (message) => { ctx.logger.error(`tui-runner: ${message}`) },
    writeOutput: (text) => { notificationWriter.write(text) },
    abortLifecycle: () => lifecycleController.abort(),
    surfaceCleanup: () => disposeSurfaceRef,
    retireOwnedSession: () => retireOwnedSessionRef,
    disposeSelectedTransport: () => disposeSelectedTransportRef,
    exit,
  })

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
      resetForGeneration: () => {
        presentation.resetForGeneration()
        // M3-4 PR4 §6.4: a session-generation bump RETIRES the old
        // subject's status sections (the session-lifecycle owner's
        // explicit reset — the ONLY writer that may clear them). The new
        // owner's projections re-derive access/composition/collaboration
        // from their own authorities, so the old permission preset can
        // never survive an identity change.
        surface.resetSubjectStatus()
      },
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
      notificationPresentation,
      notificationMode: tuiSettings?.get().notificationMode,
      notificationMethod: tuiSettings?.get().notificationMethod,
      terminalProgress: tuiSettings?.get().terminalProgress,
      // TS4 §10: the composition zone selects the CONCRETE Plugin Manager panel
      // implementation; the application surface owner consumes only the injected
      // factory and never imports `tui/**` itself.
      createPluginManagerPanel,
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
    //
    // M3-4 PR1: the construction itself lives INSIDE the selection seam's
    // Direct factory, so a Remote selection constructs NO Direct graph (plan
    // §10.2). Direct-only consumers below read it through the lazy
    // `directRuntime()` accessor; on the Direct branch the factory has already
    // run, so the accessor never constructs twice.
    let constructedDirectRuntime: DirectApplicationRuntime | undefined
    const createDirectRuntime = (): DirectApplicationRuntime => {
      if (constructedDirectRuntime === undefined) {
        throw new Error('tui-runner: the Direct application runtime is only available on the Direct selection')
      }
      return constructedDirectRuntime
    }
    /**
     * The Direct-only accessor, total on BOTH branches (M3-4 PR2): the
     * Remote selection constructs no Direct graph, so every Direct-shaped
     * read below resolves `undefined` and its Remote equivalent (the
     * `remoteSources` bundle) supplies the fact. A loud throw here would
     * make the whole composition unreachable on Remote; the branch checks
     * stay explicit at each consumer instead.
     */
    const directRuntime: () => DirectApplicationRuntime | undefined =
      override === undefined ? createDirectRuntime : (): undefined => undefined
    const createDirectApplication = (): DirectApplicationRuntime => {
      constructedDirectRuntime = createDirectApplicationRuntime({
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
      return constructedDirectRuntime
    }
    // M3-4 PR1: the internal application runtime-selection seam. The selected
    // core is the ONE common input the transport-neutral session runtime
    // consumes (`owners`/`retirement`/`backend`); Direct-only helpers stay
    // behind `directRuntime()`. Normal package `apply()` stays Direct: there
    // is no CLI option, config field, env var, cordis.patch row or public
    // root export that selects Remote — the seam above is the sole
    // product-level Remote construction owner (through
    // `runtime/backend-loader.ts`), and only internal/test M3-4 paths hand it
    // a Remote composition input. The Direct factory runs INSIDE the seam, so
    // a Remote selection constructs no Direct graph at all (plan §10.2).
    const selectedRuntime = await selectApplicationRuntime({
      kind: 'direct',
      createDirect: createDirectApplication,
      remote: undefined,
      // M3-4 PR2 internal L6 composition: a pre-built Remote aggregate's
      // selected core (the production path stays Direct — `apply` passes no
      // override, so this stays `undefined` in every product boot).
      ...(override === undefined ? {} : { preselected: override.selected }),
    })
    /**
     * The Remote-branch application presentation sources (M3-4 PR2): the
     * reader/echo-source/ingress/status-facts bundle from the SAME aggregate
     * the selection adopted. Undefined on the Direct branch; every
     * Direct-shaped read below checks the selected kind before touching it.
     */
    const remoteSources = override === undefined ? undefined : override.presentation
    /**
     * The lazy Direct-only accessor: the Direct helpers below read the ONE
     * Direct runtime the selection seam constructed. On the Direct branch
     * (the only branch bootstrap selects in PR1) it is already constructed.
     */
    /**
     * The selected runtime's transport disposer, hoisted so every teardown
     * path (the fiber disposer, the pre-mount abort, the fatal catch) can
     * reach it AFTER the session retirement completes. Direct is a no-op; a
     * future selected Remote transport disposes adapters -> Client -> Host
     * fibers, never the current Session (that stays `app/session` ownership).
     */
    const disposeSelectedTransport = (): Promise<void> => selectedRuntime.disposeTransport()
    disposeSelectedTransportRef = disposeSelectedTransport
    /**
     * D12 (TS8-C): the Direct Host image policy is read ONLY on the Direct
     * backend. Remote Client intake receives `undefined` and therefore uses its
     * own safety/resident limits; the exact Session's official `imageLimits`
     * projection is re-applied later by the Remote serializer before the Host
     * `session/prompt`, which remains the final admission authority.
     */
    const directImageLimits = (): ImageLimitsLike | undefined =>
      selectedRuntime.kind === 'direct'
        ? ctx.get('attachments')?.imageLimits as ImageLimitsLike | undefined
        : undefined
    /**
     * The Direct attachment of the CURRENT owner (A2 transitional projection):
     * a DERIVED read of the ownership core through the Direct registry, never a
     * stored second current-agent truth. Direct DATA/OPERATION reads only —
     * identity/currentness goes through the ownership subject.
     */
    const agentNow = (): Agent | undefined => directRuntime()?.owners.currentDirectAttachment()

    /**
     * The application presentation bridge (TS2 §8): the branch-selection glue
     * connecting the selected runtime + the existing Direct presentation reader
     * + the existing Remote source bundle to the narrow reads this root
     * consumes. It owns NO presentation semantics (no fold, no search, no
     * viewport, no status derivation).
     */
    const presentationBridge = createPresentationBridge({
      remoteSources,
      currentSessionId: () => ownership.currentSessionId(),
      currentDirectAgent: () => agentNow(),
      assistantStreamBaselineFor: (agent) => assistantStreamBaselineFor(agent),
      directSessionFor: (sessionId) => command.attachmentForSession(sessionId).session,
    })
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
      return owner !== undefined && directRuntime()?.owners.attachmentOf(owner)?.agent === candidate
    }
    /**
     * The Direct attachment of one opaque owner: the runner IS the Direct
     * composition root, and the session layer only ever hands it an `OwnerRef`.
     */
    const directAgentOfOwner = (owner: SessionOwnerRef): Agent | undefined =>
      directRuntime()?.owners.attachmentOf(owner)?.agent
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
      currentOf: (agent) => directRuntime()?.modelSelections.current(agent as Agent),
      setCurrentOf: (agent, next) => directRuntime()?.modelSelections.setCurrent(agent as Agent, next),
    })
    const sessionRuntime = bindSessionRuntime(ownership, {
      // M3-4 PR1: the common session-runtime inputs come from the selected
      // application runtime core (today always the Direct objects — the
      // selection seam above keeps the exact same instances).
      owners: selectedRuntime.owners,
      retirement: selectedRuntime.retirement,
      lifecycle: selectedRuntime.backend.sessionLifecycle,
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
          if (agent === undefined) {
            // M3-4 PR2: a Remote-owned generation initializes its whole
            // presentation through the semantic reader window + the live
            // ingress — never a Direct Agent read. Absent remote sources
            // (a non-Remote selection without a Direct attachment) stay the
            // M3-2 staging no-op.
            if (remoteSources === undefined) return Promise.resolve()
            const sessionId = selectedRuntime.owners.sessionId(owner)
            return initRemoteLiveSurface(sessionId)
          }
          return presentation.initLiveSession(agent)
        },
        refreshLiveCatalog: (owner) => {
          const agent = directAgentOfOwner(owner)
          // PR4 §2.2: the Remote branch refreshes the catalog through the
          // command source keyed by the committed session id (the coordinator
          // target wraps it; no Direct Agent exists to resolve).
          if (agent === undefined) {
            const sessionId = selectedRuntime.owners.sessionId(owner)
            return sessionId === undefined
              ? Promise.resolve()
              : command.refreshLiveCatalogById(sessionId)
          }
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
    // Host domains through narrow ports, never ctx.* directly. The selected
    // application runtime core supplies the backend (today always the Direct
    // assembly owned by `runtime/direct/backend-direct.ts`); this runner only
    // consumes it.
    const backend = selectedRuntime.backend
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
    const compose = (presetId?: string): Promise<DirectAgentComposition> => {
      const runtime = directRuntime()
      if (runtime === undefined) throw new Error('tui-runner: preset composition is Direct-only (the Remote branch composes through the official create path)')
      return runtime.compose(presetId)
    }

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
    // Session startup/resume/create composition helpers (TS2 §13): the
    // branch-neutral launch intent/composition, the preset reads, the blank
    // read and the Remote working-fold memo are owned by
    // `app/bootstrap/session-startup.ts`; this root injects only the narrow
    // readbacks (every `ctx.get(...)` Host resolution stays here).
    const {
      launchComposition,
      currentPreset,
      sessionBlank,
      currentWorkingFromLog,
      seedWorkingFold,
      invalidateWorkingFold,
    } = createSessionStartupHelpers({
      isRemote: remoteSources !== undefined,
      pendingPresetId: () => pendingPreset,
      launchPresetId: () => launchPreset,
      resolvePresetRoster: () => ctx.get('agentPresets') as { resolve(id?: string): Promise<{ broken?: string }> } | undefined,
      warn: (message) => { ctx.logger.warn(message) },
      diag,
      composeDirect: compose,
      currentAgent: () => agentNow(),
      composedPresetRoster: () => ctx.get('agentPresets') as { composedPreset?: (agentCtx: unknown) => unknown } | undefined,
      recordedPresetOf: (session) => sessionPresetOf(ctx, session as Parameters<typeof sessionPresetOf>[1]),
      currentSessionId: () => ownership.currentSessionId(),
      sessionPresetProjectionOf: (id) => backend.sessionReader.sessionStatus(id)?.preset,
      sessionBlankOf: (id) => backend.sessionReader.blank(id),
      generation: () => ownership.generation(),
      remoteSources,
    })

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
        // adapter actually mounted. On the Remote branch there is no Direct
        // Agent: the recorded preset reads the official `agentPreset`
        // projection through the semantic SessionReader, and the launch
        // preset applies through `PresetCatalog.selectSessionPreset` while
        // the session is blank (M3-4 PR5 §3.5; the Host owns the
        // `agent-preset/locked` refusal for a started Session).
        const resumedDirectAgent = handle.direct === undefined ? undefined : (handle.direct.agent as Agent | undefined)
        if (resumedDirectAgent !== undefined) {
          const recorded = sessionPresetOf(ctx, resumedDirectAgent.session)
          diag.info('resume ok', {
            session: sessionId,
            seq: Number(resumedDirectAgent.session.seq),
            preset: recorded ?? 'default',
          })
          // A launch-time preset may still apply while the session is blank;
          // the Host owns the blank check and refuses a started Session with
          // `agent-preset/locked`.
          if (launchPreset !== undefined && launchPreset !== recorded) {
            try {
              await selectBlankSessionPreset(ctx, resumedDirectAgent, launchPreset)
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
        } else {
          // Remote resume (M3-4 PR5 §3.5): the official `agentPreset`
          // projection is the recorded-preset authority. The launch-preset
          // write is expressed through the SAME semantic
          // `PresetCatalog.selectSessionPreset` port the /preset command
          // uses — the Host owns blankness and the `agent-preset/locked`
          // refusal; a started Session keeps its recorded preset and warns.
          const sessionIdText = String(sessionId)
          const recorded = backend.sessionReader.sessionStatus(sessionIdText)?.preset
          if (launchPreset !== undefined && launchPreset !== recorded) {
            const outcome = await backend.catalog.presets.selectSessionPreset(
              sessionIdText,
              launchPreset,
              lifecycleController.signal,
            )
            startupStatus.clear()
            const settled = outcome.outcome
            if (settled.kind === 'committed') {
              if (outcome.ownership === 'current') {
                // The authoritative projection becomes the display truth (the
                // projection channel repaints the footer/welcome).
                diag.info('preset applied on remote resume', { session: sessionIdText, preset: launchPreset })
              } else {
                // committed + superseded: the write landed Host-side but this
                // startup no longer owns the visible subject — no stale
                // success mutation, and never a retry.
                diag.warn('preset applied on remote resume superseded', { session: sessionIdText, preset: launchPreset })
              }
            } else if (settled.kind === 'rejected' && settled.error.code === 'agent-preset/locked') {
              const message = `session ${sessionIdText} has started; its agent preset ${recorded ?? 'default'} is fixed, ignoring --preset ${launchPreset}`
              ctx.logger.warn(`tui-runner: ${message}`)
              diag.warn('preset ignored on remote resume', { session: sessionIdText, preset: launchPreset })
            } else if (settled.kind === 'rejected') {
              ctx.logger.warn(`tui-runner: --preset ${launchPreset} not applied on resume: ${settled.error.message}`)
              diag.warn('preset not applied on remote resume', { session: sessionIdText, preset: launchPreset, error: settled.error.message })
            } else if (settled.kind === 'cancelled') {
              // Honor startup cancellation: the abort path below owns the
              // unwind; a cancelled preset write is not an error.
              diag.debug('preset write cancelled on remote resume', { session: sessionIdText, preset: launchPreset })
            } else if (settled.kind === 'indeterminate') {
              ctx.logger.warn(`tui-runner: --preset ${launchPreset} result on resume is indeterminate; not retrying`)
              diag.warn('preset write indeterminate on remote resume', { session: sessionIdText, preset: launchPreset, error: settled.error.message })
            } else {
              // unsupported: this frozen Remote composition advertises
              // selectSessionPreset — an unsupported answer is a contract
              // failure, surfaced truthfully (never retried, never
              // translated into `locked`).
              ctx.logger.warn(`tui-runner: --preset ${launchPreset} not applied on resume: ${settled.reason}`)
              diag.warn('preset write unsupported on remote resume', { session: sessionIdText, preset: launchPreset, reason: settled.reason })
            }
          }
          diag.info('resume ok', {
            session: sessionId,
            preset: backend.sessionReader.sessionStatus(sessionIdText)?.preset ?? recorded ?? 'default',
          })
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
    const resumeQuiesce = quiesceResumedOwner<SessionOwnerRef>(handle, {
      publishResumedOwner: (handle, preMountQuiesce) => sessionRuntime.publishResumedOwner(handle, preMountQuiesce),
      showPreparingStage: () => startupStatus.show('Preparing conversation…'),
      whenIdleOrAbort: (owner, signal) => selectedRuntime.retirement.whenIdleOrAbort(owner, signal),
      signal: lifecycleController.signal,
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
    // A5b-1: the live-session presentation owner (main transcript/stats folds,
    // the main presentation target, the generation reset and the ONE cold
    // hydration path) is constructed here, where its folds used to live.
    // `viewerRef` is the late-binding seam for the generation reset: the
    // presentation owner owns the reset ORDER, the viewer owner owns its own
    // teardown.
    let viewerRef: ViewerRuntime<SessionEvent> | undefined
    const presentation = createSessionPresentation<SessionEvent>({
      surface,
      diag,
      isCleanedUp: () => cleanedUp,
      refreshStatusCheap: () => status.refresh(),
      folds: { title: (events) => foldSessionTitle(events)?.title },
      direct: {
        installModelSelection: (agent) => { directRuntime()?.modelSelections.installForAgent(agent as Agent) },
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
        refreshTerminalCwd: () => status.refreshTerminalCwd(),
        updateWelcomeCard: () => status.updateWelcomeCard(),
        scheduleInitialMeasurement: (sessionId) => status.scheduleInitialMeasurement(sessionId),
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
      // M3-4 PR2: the Remote-branch presentation reads — the semantic reader
      // window (bounded coverage, official hasMore/loadingOlder), the exact
      // binding's official `running` bit, and the `plan` projection read.
      // Absent on Direct (the `direct` bundle above is the Direct source).
      ...(remoteSources === undefined ? {} : {
        remote: {
          read: (sessionId) => remoteSources.presentationReader.read(sessionId, lifecycleController.signal),
          running: (sessionId) => presentationBridge.remoteRunningOf(sessionId),
          plan: (sessionId) => remoteSources.sessionFacts.plan(sessionId)?.active,
          // The §6.5 visible-commit fence (EXACT GENERATION, never
          // sessionId alone): the token is captured before the reader
          // await; every owner commit — switch/new/fork/resume, INCLUDING a
          // same-id binding rollover — bumps the ownership generation, so a
          // committed replacement always invalidates an in-flight hydrate.
          captureGeneration: () => ownership.generation(),
          isStillCurrent: (sessionId, generation) =>
            ownership.currentSessionId() === sessionId && ownership.generation() === generation,
          // The REMOTE TRANSPORT half of the §6.5 fence (Connection
          // generation + exact binding object): a transport rollover without
          // a TUI owner commit still invalidates a pending visible commit.
          captureTransportToken: (sessionId) => remoteSources.sessionFacts.captureTransportToken(sessionId),
          isTransportTokenCurrent: (sessionId, token) =>
            remoteSources.sessionFacts.isTransportTokenCurrent(sessionId, token),
          // The official CURRENT-VALUE facts a bounded window cannot own. A
          // field is included ONLY when its projection answered: an absent
          // field means "unavailable" (the owner falls back to the window
          // fold), while a legal `null` goal/todos is a real answer.
          facts: (sessionId) => {
            const status = remoteSources.sessionFacts.sessionStatus(sessionId)
            // TOTAL: an unretained/unanswered session yields an EMPTY fact set,
            // and the owner then OMITS those facts instead of folding them from
            // the bounded window (a recent window is not a current value).
            if (status === undefined) return {}
            return {
              ...status.cwd === undefined ? {} : { cwd: status.cwd },
              ...status.title === undefined ? {} : { title: status.title },
              ...'goal' in status ? { goal: status.goal } : {},
              ...status.todos === undefined ? {} : { todos: status.todos },
            }
          },
        },
      }),
    })

    /**
     * The Remote branch's live ingress handle for the CURRENT session
     * (M3-4 PR2): re-created on every owner commit; disposed on rollover.
     * Identity is the exact binding object + Connection generation inside
     * the ingress itself — this slot only owns the handle's lifetime.
     */
    let remoteIngressHandle: ReturnType<RemoteApplicationOverride['presentation']['liveIngress']['subscribe']> | undefined
    /** The last-known Remote working fold for the CURRENT session's
     *  ownership generation AND the transport token it was captured under
     *  (the reader window's boundary proof; refreshed asynchronously by
     *  currentWorkingFromLog, seeded by the cold hydrate). Every read
     *  validates owner generation+session AND the token: a switch/new/fork
     *  or a same-owner Connection/binding rollover voids the entry. */
    /** The session id one Remote `loadOlder` extension is in flight for (the
     *  history boundary seam coalesces repeated gestures for the SAME subject
     *  into one official page; another subject pages independently). */
    let remoteHistoryLoadingFor: string | undefined
    const disposeRemoteIngress = (): void => {
      remoteIngressHandle?.dispose()
      remoteIngressHandle = undefined
    }
    lifecycleController.signal.addEventListener('abort', disposeRemoteIngress, { once: true })

    /**
     * Initialize the WHOLE Remote live surface for one session: hydrate
     * through the reader (the owner was proven current by the caller's
     * commit order), then subscribe the official eventSource ingress. The
     * ingress routes durable events through the SAME surface event routing
     * and transient chunks through the SAME assistant-input entry the
     * Direct branch uses — one canonical pipeline, two ingress owners.
     */
    const initRemoteLiveSurface = async (sessionId: string): Promise<void> => {
      if (remoteSources === undefined || cleanedUp) return
      disposeRemoteIngress()
      // §6.5 lifecycle fence (subscribe side): the token is captured BEFORE
      // the hydrate await; a superseded owner (switch/new/fork or a same-id
      // rollover — every commit shape bumps the generation) must not install
      // its ingress over the newer owner's surface.
      const initGeneration = ownership.generation()
      const hydrate = await presentation.initLiveRemoteSession(sessionId)
      if (cleanedUp) return
      if (ownership.currentSessionId() !== sessionId || ownership.generation() !== initGeneration) return
      // An uncommitted hydrate (fence-dropped inside the presentation owner)
      // means this init lost the race — its revision is undefined and its
      // subscription would resurrect the stale window: abort here.
      if (hydrate === undefined) return
      // Seed the compaction working-fold cache from the PROVEN cold-hydrate
      // fold (no first-use gap: the first settle reads the authoritative
      // complete-window answer, never the bare running bit).
      // Stamp the fold with the token the HYDRATE was fenced under (carried
      // on the outcome) — NOT a fresh capture here: a transport rollover
      // between the hydrate's inner check and this seed must leave the entry
      // non-current, so every later read misses it.
      seedWorkingFold({
        generation: initGeneration,
        sessionId,
        transportToken: hydrate.transportToken,
        fold: hydrate.working,
        proven: hydrate.proven,
      })
      remoteIngressHandle = remoteSources.liveIngress.subscribe(sessionId, {
        onDurableEvent: (id, event) => {
          surface.routeSessionEvent({ id }, event as SessionEvent)
        },
        onLiveInput: (input) => {
          // Defense in depth: the ingress fences by exact binding + Connection
          // generation, and the handle is disposed on every rollover; a
          // residual stale input (session no longer current) must not reach
          // the presentation.
          if (input.sessionId !== ownership.currentSessionId()) return
          if (input.kind === 'chunk' && isAssistantTokenDelta(input.chunk)) {
            submission.markLatency(input.sessionId, 'assistant.first')
          }
          surface.applyAssistantInput(input)
        },
        onSessionSnapshotChanged: (id) => {
          // An official snapshot change (e.g. a beginSubmission echo or a
          // running flip) re-joins the pending pane from the official
          // sources — the same refresh the Direct event routing performs.
          if (id !== ownership.currentSessionId() || cleanedUp) return
          surface.refreshPendingInput()
        },
        onProjectionsChanged: (id) => {
          // The official projection faces carry current values the Session
          // snapshot NEVER does (the Session snapshot has no projection
          // values): a model/preset/title/goal/todos/usage/context change made
          // by the Host or another Client must reach this surface now, not at
          // the next unrelated refresh. Re-apply the projection-owned facts and
          // refresh the status/welcome from the official sources.
          if (id !== ownership.currentSessionId() || cleanedUp) return
          presentation.applySessionCurrentFacts(id)
          status.refresh()
          status.updateWelcomeCard()
        },
        onWindowReplaced: (id) => {
          // Reconnect/gap repair: the official new window is authoritative —
          // re-run the full Remote hydration for the CURRENT session only
          // (a replaced owner must not repaint through this subscription).
          // The old window's working-fold proof is VOID: drop the cache now
          // (initRemoteLiveSurface re-seeds it from the NEW window's fold).
          if (ownership.currentSessionId() !== id || cleanedUp) return
          invalidateWorkingFold()
          runDetached('remote window re-hydration', () => initRemoteLiveSurface(id), {
            diag,
            sessionId: () => id,
          })
        },
        onWindowPrepended: (id) => {
          // F10 (round 4): an official `loadOlder` page joined the window
          // front — whoever requested it (keyboard extension, /status facts
          // composition, copy paging). Re-fold the transcript/stats
          // presentation from the widened window for the CURRENT session
          // only; `rehydrateFromWindow` owns the generation/transport fences
          // and re-derives the footer status from the new fold.
          if (ownership.currentSessionId() !== id || cleanedUp) return
          runDetached('remote window front re-hydration', () => presentation.rehydrateFromWindow(id), {
            diag,
            sessionId: () => id,
          })
        },
      }, hydrate.revision)
    }

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
     * lives in `runTransitionTo` (app/session/transition.ts — unit-tested): quiesce and
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
      // PR4 §1.2: the Host-registry dependency is RETIRED on the Remote
      // branch — the TUI's OWN definitions register into the Client command
      // registry there; the Host `ctx.commands` stays metadata-only
      // (RemoteSurfaceAuthorityReader + HostCommandPort own its reads).
      commandsRegistry: () => remoteSources === undefined ? ctx.get('commands') : undefined,
      // PR4 review round: the SAME transport-aware prompt preparation the
      // ordinary submission uses (Remote needs the serializer's
      // PreparedPrompt; the skill-gesture delivery rides it).
      ...(remoteSources === undefined ? {} : {
        prepareTransportMessage: (text: string, requestId: string) => prepareRemotePrompt(text, requestId),
      }),
      clientCommands: createClientCommandRegistry(parseCommand),
      // PR4 §2.1/§2.2: the Remote branch's command authority read + the
      // official Session facts the command runtime consumes (running,
      // routing). Absent on Direct (the direct seams own that branch).
      ...(remoteSources === undefined ? {} : {
        remoteCommandSource: {
          read: (sessionId, signal) => remoteSources.commandSource.read(sessionId, signal),
          readCommands: (sessionId, signal) => remoteSources.commandSource.readCommands(sessionId, signal),
          captureTransportToken: (sessionId) => remoteSources.commandSource.captureTransportToken(sessionId),
          isTransportTokenCurrent: (sessionId, token) => remoteSources.commandSource.isTransportTokenCurrent(sessionId, token),
          // M3-6 PR2 §13.2: the SAME official generation observable, exposed
          // to the CommandSurface as the reconnect invalidation hint.
          connectionGeneration: () => remoteSources.commandSource.connectionGeneration(),
          subscribeConnectionGeneration: (listener: () => void) =>
            remoteSources.commandSource.subscribeConnectionGeneration(listener),
        },
        remoteFacts: {
          running: (sessionId) => remoteSources.sessionFacts.running(sessionId),
          sessionStatus: (sessionId) => remoteSources.sessionFacts.sessionStatus(sessionId),
        },
      }),
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
      // PR5 (plan §3.2): the /status panel reads the presentation-owned
      // recent-performance availability beside the composed stats (Remote
      // only — Direct's complete-log fold is authoritative by construction).
      ...(remoteSources === undefined ? {} : {
        recentPerformanceAvailable: () => presentation.mainRecentPerformanceAvailable(),
      }),
      surface: {
        setNotificationMode: (mode) => surface.setNotificationMode(mode),
        setNotificationMethod: (method) => surface.setNotificationMethod(method),
        setTerminalProgressMode: (mode) => surface.setTerminalProgressMode(mode),
        openJobView: (jobId) => surface.openJobView(jobId),
        openTasksBrowser: (viewMode) => surface.openTasksBrowser(viewMode),
      },
      backend: {
        kind: selectedRuntime.kind,
        sessionReader: backend.sessionReader,
        sessionWriter: backend.sessionWriter,
        interaction: backend.interaction,
        catalog: backend.catalog,
        config: backend.config,
        hostFile: backend.hostFile,
        // Shell amendment (M3-4 PR3): Host-shell completion facts exist only
        // where the TUI process IS the Host (Direct). Remote has no qualified
        // shell carrier, so it must show no shell-specific suggestions.
        hostShellCompletion: selectedRuntime.kind === 'direct',
        // The readable-transcript business capability (PR4 round 5): the
        // Markdown renderer reads the whole in-process Session event
        // history — Direct only until a transport-neutral whole-history
        // seam exists. Deliberately NOT derived from the commands-registry
        // compatibility mirror (its retirement is owned by M8).
        transcriptExportAvailable: selectedRuntime.kind === 'direct',
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
      imageLimits: () => directImageLimits(),
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
        sessionStats: (sessionId, signal) => remoteSources === undefined
          ? Promise.resolve(sessionStatsFactsOf(presentationBridge.directSessionStats(sessionId)))
          : composeRemoteSessionStats({
            sessionId,
            reader: remoteSources.presentationReader,
            fence: presentationBridge.remoteTransportFenceOf(sessionId),
            facts: {
              sessionStats: presentationBridge.sessionStatsProjectionOf(sessionId),
              usage: remoteSources.sessionFacts.sessionStatus(sessionId)?.usage,
              contextWindow: remoteSources.sessionFacts.sessionStatus(sessionId)?.context?.contextWindow,
            },
            signal,
          }),
        lastAssistantText: (sessionId, signal) => remoteSources === undefined
          ? Promise.resolve(presentationBridge.directLastAssistantText(sessionId))
          : composeRemoteLastAssistantText({
            sessionId,
            reader: remoteSources.presentationReader,
            fence: presentationBridge.remoteTransportFenceOf(sessionId),
            signal,
          }),
        promptAdmission: (agent, hasImages, task) => {
          const runtime = directRuntime()
          if (runtime === undefined) return Promise.resolve(task())
          return runtime.withPromptAdmission(agent, hasImages, async () => task())
        },
        // M3-4 PR3 (§10.2): on the Remote branch the Direct-Agent admission
        // hook is RETIRED — scope/writer admission stays in
        // SessionRuntime.withWriter, Client preflight stays Client-local, and
        // Host business admission happens inside the official Session write
        // path. The hook therefore never resolves a Direct attachment there.
        ...(remoteSources === undefined ? {} : {
          promptAdmission: <T>(_agent: unknown, _hasImages: boolean, task: () => Promise<T> | T): Promise<T> =>
            Promise.resolve(task()) as Promise<T>,
        }),
      },
      // TS8-E: the narrow Direct catalog capability. The Direct catalog context
      // and the in-process `commands.list(undefined)` convention are captured
      // ONCE here and adapted into neutral-DTO operations, so the application
      // command owner never imports a `runtime/direct/**` path. Absent on the
      // Remote branch (its read goes through the generation-fenced source).
      ...(remoteSources === undefined ? {
        directCatalog: {
          readSurfaceCatalog: (agent: Agent, signal: AbortSignal) =>
            readSurfaceCatalog(
              agent as unknown as Parameters<typeof readSurfaceCatalog>[0],
              signal,
              ctx as unknown as SurfaceCatalogContext,
            ),
          listGlobalCommands: () => {
            const commands = ctx.get('commands') as SurfaceCommandsService | undefined
            if (commands === undefined) return []
            return listGlobalCommands(commands).map(commandSummaryOf)
          },
        },
      } : {}),
      logError: (message) => ctx.logger.error(message),
    })
    // A5b-2: the surface status owner (footer/status derivation, the context
    // measurement cache and its deferred initial measure). The Direct facts and
    // the official Host service values arrive as narrow capabilities; the
    // viewer owner is late-bound (it is constructed after the presentation).
    const status = createStatusRuntime({
      surface,
      diag,
      isCleanedUp: () => cleanedUp,
      liveAgent: () => agentNow(),
      // PR4 §6.2/§6.3: the permission-cycle authority — the projection's
      // committed value, the ConfigPort catalog, and the ConfigPort write.
      // Provided on BOTH branches (the semantic is shared); a composition
      // without a live preset catalog degrades to a no-op cycle.
      permissionCycle: {
        captureLiveScope: () => sessionScope.captureLive(),
        isScopeCurrent: (scope) => sessionScope.isCurrent(scope),
        // §6.3 transport fence: captured in the SAME synchronous admission
        // step as the scope. Direct reads `undefined` (no transport
        // identity); Remote captures the Connection generation + exact
        // binding so a same-id rollover during the apply reads stale.
        captureTransportToken: () => {
          if (remoteSources === undefined) return undefined
          const sessionId = ownership.currentSessionId()
          return sessionId === undefined
            ? undefined
            : remoteSources.sessionFacts.captureTransportToken(sessionId)
        },
        isTransportTokenCurrent: (token) => token === undefined
          ? true
          : remoteSources !== undefined && remoteSources.sessionFacts.isTransportTokenCurrent(ownership.currentSessionId() ?? '', token),
        currentPermission: () => {
          const sessionId = ownership.currentSessionId()
          if (sessionId === undefined) return undefined
          return backend.sessionReader.sessionStatus(sessionId)?.permission
        },
        presetNames: () => [...backend.config.permissions.presetNames()],
        apply: (sessionId, presetId, signal) =>
          backend.config.permissions.applyPermissionPreset(sessionId, presetId, signal),
      },
      generation: () => ownership.generation(),
      currentSessionId: () => ownership.currentSessionId(),
      measureContext: (sessionId) => backend.sessionReader.measureContext(sessionId),
      // M3-5 PR1 §9.2: the ONE shared Session-scoped status read, bound to
      // the semantic `SessionReader.sessionStatus` port on BOTH branches (on
      // Remote this is the same function the branch facts used to expose).
      // The subject id is ALWAYS explicit: selection belongs to StatusRuntime.
      sessionStatus: (sessionId) => backend.sessionReader.sessionStatus(sessionId),
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
      presentation: {
        mainStats: () => presentation.mainStats(),
        // PR5 (plan §3.2): the presentation-owned recent-performance
        // availability authority (one bit beside the fold, committed in the
        // same fenced hydrate).
        mainRecentPerformanceAvailable: () => presentation.mainRecentPerformanceAvailable(),
      },
      viewer: { read: () => viewerRef?.read() },
      clientCwd: cwd,
      // M3-4 PR2: the Remote-ONLY official Session facts (the plan wire view).
      // The SessionStatus read is the shared `sessionStatus` capability above.
      ...(remoteSources === undefined ? {} : {
        remote: {
          plan: (sessionId) => sessionId === undefined ? undefined : remoteSources.sessionFacts.plan(sessionId),
        },
      }),
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
    /**
     * The stable display-subject lifetime tokens for image reads (M3-5 PR2): one
     * slot for the MAIN presentation (keyed by owner generation + session id) and
     * one for the VIEWED CHILD (keyed by viewer generation + child id). Each slot
     * returns the SAME object while its lifetime is unchanged, so the loader's
     * identity-keyed scope survives a child visit and is replaced only when that
     * exact lifetime ends.
     */
    let imageScopeMain: { readonly key: string; readonly sessionId: string; readonly transportToken: RemoteTransportLifetime | undefined } | undefined
    let imageScopeChild: { readonly key: string; readonly sessionId: string; readonly transportToken: RemoteTransportLifetime | undefined } | undefined
    // The extension service + surface host (M3 wiring); declared here so
    // the cleanup closure can detach them.
    let extensionService: (PiTuiExtensionService & {
      /** The CONCRETE registries (the runner's dispatch/pickers need the
       * full read methods — handlerFor, isSessionless, etc. — beyond the
       * public narrow views). */
      readonly commands: import('../extension/internal/command-bridge.ts').CommandBridge
      readonly themes: import('../extension/internal/theme-registry.ts').ThemeRegistry
      readonly autocomplete: import('../extension/internal/autocomplete-registry.ts').AutocompleteRegistry
      readonly settings: import('../extension/internal/settings-registry.ts').SettingsRegistry
      readonly keybindings: import('../extension/internal/keybinding-registry.ts').KeybindingRegistry
      readonly renderers: import('../extension/internal/renderer-registry.ts').RendererRegistry
      readonly editors: import('../extension/internal/editor-registry.ts').EditorRegistry
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
    // PR4 §5.2 (review F7): the Host registry lookup itself is DIRECT-ONLY —
    // resolved lazily inside the Direct branch's lookup, never on the Remote
    // path (Step 5 forbids a Remote bootstrap tools lookup; the guard
    // asserts the lookup sits behind the branch discriminator).
    const present = remoteSources === undefined
      ? toolPresenterFrom(name => {
        const agent = agentNow()
        if (agent === undefined) return undefined
        const tools = ctx.get('tools') as { get(name: string, scope?: object): ToolDefinitionLike | undefined } | undefined
        return tools?.get(name, agent)
      })
      : createClientToolPresenter()
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
    // A5b-4 + shell amendment (M3-4 PR3): the user-shell owner (`!` / `!!` +
    // the shared live-Agent interrupt). Execution is Host-owned behind the
    // branch-selected Host adapter: Direct runs in-process (spawn behind
    // adapter ownership; the sandbox policy runs the dsh shell executor and
    // fails closed when absent); Remote is the truthful-unavailable adapter
    // (CARRIER_GAP at rc.2 — zero Client spawn, zero ctx.shell escape).
    // Constructed BEFORE the surface cleanup closure can run; its submission
    // acknowledgement seams are late-bound (the controller is built below).
    // Both Host user-shell adapters are served by the selected BACKEND
    // (Direct in-process / Remote truthful-unavailable) — the composition
    // root holds neither a static Remote edge nor direct spawn ownership
    // (M3-4 PR3 shell amendment; the frozen selection-boundary contract).
    const userShellPort = backend.hostUserShell
    const localShell = createUserShell<Agent>({
      app: () => app,
      diag,
      isCleanedUp: () => cleanedUp,
      liveAgent: () => agentNow(),
      ownership: { generation: () => ownership.generation() },
      session: { withWriter: (scope, task) => sessionRuntime.withWriter(scope, task) },
      requireLiveScope,
      captureLiveScope: () => sessionScope.captureLive(),
      writerSection: (task) => submission.withWriterSection(task),
      writer: backend.sessionWriter,
      status: { sessionCwd: () => status.sessionCwd() },
      tuiSettings,
      shell: userShellPort,
      submission: {
        settleAck: (reason, options) => submission.settleLocalSubmitAck(reason, options),
        markDispatch: (sessionId) => submission.markDispatch(sessionId),
      },
    })

    // The ONE idempotent client-surface teardown + fiber disposer (TS2
    // §11/§12): the orchestration is owned by `app/bootstrap/lifecycle.ts`;
    // every released resource is an already-owned callback. The frozen §12
    // relative order is preserved inside that module.
    const surfaceLifecycle = createSurfaceLifecycle({
      diag,
      isCleanedUp: () => cleanedUp,
      markCleanedUp: () => { cleanedUp = true },
      surface,
      abortLifecycle: () => lifecycleController.abort(),
      disposeViewer: () => viewerRef?.dispose(),
      clearDraftImages: () => draftImages.clear(),
      clearDraftFiles: () => draftFiles.clear(),
      disposeCommandCatalog: () => command.disposeCatalog(),
      cancelDeferredStatus: () => status.cancelDeferred(),
      disposeFooterCommand: () => settings.disposeFooterCommand(),
      disposeLocalShell: () => localShell.dispose(),
      retireOwnedSession: sessionRuntime.retireOwnedSession,
      disposeSelectedTransport,
      registerDisposal: (dispose) => { ctx.effect(function* () { yield dispose }) },
    })
    // The terminal-total fatal catch reaches the SAME surface cleanup authority
    // through this ref (M3-6 PR3 D3), assigned now — before `surface.start`
    // and any later startup operation can fail with the surface owner live.
    disposeSurfaceRef = surfaceLifecycle.disposeSurface
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
      cleanup: surfaceLifecycle.disposeSurface,
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
      if (ownership.owner() !== undefined || directRuntime()?.hasParkedOwners() === true || sessionRuntime.hasPendingForks()) {
        await sessionRuntime.retireOwnedSession()
      } else {
        diag.dispose()
      }
      // M3-4 PR1: the selected transport disposes after the session
      // retirement on this pre-mount path too (Direct: no-op).
      await disposeSelectedTransport()
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
    surfaceLifecycle.registerRunnerDisposal()
    // The Direct stream adapter keeps active prefixes for Agents that were not
    // being displayed yet; enterView replays this exact-agent baseline before
    // mounting the child surface.
    let assistantStreamBaselineFor: (agent: object) => readonly AssistantLiveInput[] = () => []
    // A5b-1: the subagent viewer owner. The ONE ViewerRuntime keeps its state
    // machine; only its injected child-view SOURCE is backend-selected — the
    // Direct in-process read (live/cold Session + Agent registry + live
    // assistant baseline) or the Remote retained `tuiChildView` reference with
    // the shared presentation reader/ingress. The Direct source is constructed
    // ONLY on the Direct branch (it would otherwise bind never-called
    // in-process reads on Remote).
    const childView: ViewerChildSource<SessionEvent> = remoteSources === undefined
      ? createDirectChildViewSource<SessionEvent>({
        childSession: (childId) => sessions.get(SessionId(childId)),
        observeChild: (childId) => {
          const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
          if (query?.observeSession === undefined) return undefined
          return query.observeSession(SessionId(childId), { projectionMode: 'none' })
        },
        childAgent: (childId) => agents.get(SessionId(childId)),
        assistantStreamBaselineFor: (agent) => assistantStreamBaselineFor(agent),
      })
      : remoteSources.childView as unknown as ViewerChildSource<SessionEvent>
    const viewer = createViewerRuntime<SessionEvent>({
      surface,
      isCleanedUp: () => cleanedUp,
      currentSessionId: () => ownership.currentSessionId(),
      // Remote branch: the live pending subject is the CURRENT owner's
      // session (no Direct Agent exists to name it).
      liveParentSessionId: () => agentNow()?.session.id ?? (remoteSources !== undefined ? ownership.currentSessionId() : undefined),
      childView,
      refreshStatus: () => status.refresh(),
      restoreMainTranscriptAnchor: () => presentation.restoreMainTranscriptAnchor(),
      runDetached: (label, task) => runDetached(label, task, {
        diag,
        sessionId: () => ownership.currentSessionId(),
      }),
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
      // Transport-neutral live-session facts (M3-4 PR3 §11): the Direct
      // branch reads the exact Agent; the Remote branch projects the CURRENT
      // owner's session id + official running bit — the controller consumes
      // only { session.id, status }, never a Direct Agent identity.
      liveAgent: () => agentNow() ?? (presentationBridge.remoteLiveSessionFacts() as Agent | undefined),
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
      backendKind: selectedRuntime.kind,
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
      // M3-4 PR2: the Remote branch reads its optimistic echoes from the
      // official `SessionSnapshot.pendingSubmissions` (the ONE optimistic
      // identity there); Direct keeps its ledger (no second TUI identity).
      ...(remoteSources === undefined ? {} : { submissionPresentation: remoteSources.submissionPresentation }),
      // M3-4 PR3 (§12): steer shares the plain prompt's per-transport
      // preparation authority — the Remote branch produces the SAME
      // PreparedPrompt (a Direct UserMessage would be refused by the
      // production Remote serializer's preflight).
      ...(remoteSources === undefined ? {} : { prepareTransport: (text: string, requestId: string) => prepareRemotePrompt(text, requestId) }),
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
        // D12 (TS8-C): the Direct Host attachment/model services are injected
        // ONLY on the Direct backend. The Remote submission path goes through
        // `prepareTransport`/PreparedPrompt and must never call
        // `ctx.attachments.saveImages` or `ctx.llm.resolveModelInfo`.
        attachments: () => selectedRuntime.kind === 'direct'
          ? ctx.get('attachments') as DirectPrepareInputDeps['attachments']
          : undefined,
        llm: () => selectedRuntime.kind === 'direct'
          ? ctx.get('llm') as DirectPrepareInputDeps['llm']
          : undefined,
      },
      tuiSettings,
      captureMatches,
      direct: {
        withPromptAdmission: (agent, hasImages, task) => {
          const runtime = directRuntime()
          if (runtime === undefined) return Promise.resolve(task())
          return runtime.withPromptAdmission(agent as Agent, hasImages, task)
        },
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
    // M3-6 PR1: the branch discriminator is `override === undefined` — the
    // SAME internal Remote composition discriminator the presentation
    // sources use. Direct resolves the existing Host/profile service; Remote
    // consumes the aggregate's SELECTED Client-local service through the
    // override and NEVER evaluates the Host lookup as its extension
    // authority (no `??` fallback in either direction).
    extensionService = override === undefined
      ? ctx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof extensionService
      : override.extensionService as typeof extensionService
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
      imageLimits: () => directImageLimits() as Parameters<typeof checkImageLimits>[2] | undefined,
      rewind: {
        // PR4 §4: the whole-log picker authority + the loadThrough detail
        // read, both behind the semantic SessionReader port (Direct reads
        // the Host projection / the full-log adapter; Remote reads the
        // exact retained binding's projection + the official jump loop).
        // §4.1: the picker authority is the semantic read — ONE contract on
        // both branches. (The Direct adapter owns its §18.4 compatibility
        // fallback internally; this owner never branches.)
        turnOutline: (sessionId) => backend.sessionReader.turnOutline(sessionId),
        loadThrough: async (sessionId, seq, signal) => {
          const snapshot = await presentationBridge.loadThrough(sessionId, seq, signal)
          return snapshot === undefined ? undefined : snapshot.durableEvents
        },
        // §2.2/§16: the transport identity is captured ONCE at picker open
        // (Direct reads `undefined`); the post-await check only COMPARES that
        // frozen token, so a same-id binding rollover while the picker was
        // open invalidates the pending selection — it can never re-capture
        // the replacement binding as current.
        captureSelectionIdentity: (sessionId) => remoteSources === undefined
          ? undefined
          : remoteSources.sessionFacts.captureTransportToken(sessionId),
        isSelectionCurrent: (sessionId, identity) => identity === undefined
          ? true
          : remoteSources !== undefined
            && remoteSources.sessionFacts.isTransportTokenCurrent(sessionId, identity),
        forkSession: (sourceSessionId, atSeq, onAdopted, pickerIdentity) =>
          sessionRuntime.forkSession(sourceSessionId, atSeq, onAdopted, pickerIdentity),
        // PR5 v2 §3C: the navigation-currency check the final rewind
        // settlement consults (the runtime's own identity authority).
        isNavigationCurrent: (expected) => sessionRuntime.isNavigationCurrent(expected),
      },
      // The subagent viewer's delivery ports (the viewer STATE stays in the
      // A5b-1 viewer owner). The queue subject is transport-neutral: Direct
      // resolves the exact live child Agent; Remote reads the viewer's own
      // published writer-subject token (the write itself goes through the
      // backend-selected PendingInputReader/SessionWriter by child id).
      subagentDelivery: {
        queueSubjectFor: (childId) => {
          if (remoteSources !== undefined) {
            const authority = viewer.viewedQueueAuthority()
            return authority !== undefined && authority.childSessionId === childId
              ? authority.subject
              : undefined
          }
          return directRuntime()?.queueAgentFor(childId) as unknown as SteerSubjectLike | undefined
        },
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
        // PR4 §4: the application-event owner's live-agent face is
        // transport-neutral — the Remote branch has no Direct Agent, so the
        // identity falls back to the CURRENT owner's session id (the rewind
        // owner consumes only session.id since §4.1).
        liveAgent: () => {
          const agent = agentNow()
          if (agent !== undefined) return agent
          const sessionId = remoteSources === undefined ? undefined : ownership.currentSessionId()
          return sessionId === undefined ? undefined : { session: { id: sessionId } }
        },
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
      //
      // M3-5 PR2 Step 9: the read AUTHORITY belongs to the attachment ref's OWNING
      // presentation, not to whichever Session is on screen when the read runs. The
      // renderer samples this scope ONCE per thumbnail construction, the component
      // keeps it immutably, and the image loader keys the bytes/in-flight/error
      // state AND its subscribers by it. On Remote the read then borrows the exact
      // retained binding of THAT Session. A mount without the seam fails closed
      // instead of late-selecting a subject. Direct keeps its in-process
      // `ctx.attachments.readImage`.
      //
      // The token is a display-subject LIFETIME, not the bare session id: the
      // official Client authorizes `session/attachment` per Session and a same-id
      // binding rollover is a NEW generation, so reusing one session id would let a
      // child's image ride the parent's authorization or inherit a retired
      // generation's entry. A plain re-render of the SAME lifetime reuses the same
      // token object.
      imageScope: () => {
        const child = viewer.read()
        const sessionId = child?.id ?? ownership.currentSessionId()
        if (sessionId === undefined) return undefined
        // ONE stable token per LIFETIME slot (main / viewed child). Comparing
        // against a single "previous" token would RE-MINT the main token after
        // every child visit (same key, new object), and because the loader keys
        // object scopes by identity that would silently drop the main
        // presentation's cached bytes/failures/subscribers on each viewer round
        // trip. The two slots are naturally bounded — a lifetime is identified by
        // its owner/viewer generation, and a replaced generation mints a new one.
        if (child === undefined) {
          const key = `main:${ownership.generation()}:${sessionId}`
          if (imageScopeMain !== undefined && imageScopeMain.key === key) return imageScopeMain
          // The transport token (Connection generation + EXACT binding identity) is
          // captured HERE, once per lifetime, and travels with the scope: the read
          // re-checks it before touching any Session, so a retired presentation can
          // never borrow a successor binding for the same Session id.
          imageScopeMain = {
            key,
            sessionId,
            transportToken: remoteSources?.sessionFacts.captureTransportToken(sessionId) as
              RemoteTransportLifetime | undefined,
          }
          return imageScopeMain
        }
        const key = `child:${app.getViewerGeneration()}:${sessionId}`
        if (imageScopeChild !== undefined && imageScopeChild.key === key) return imageScopeChild
        imageScopeChild = {
          key,
          sessionId,
          // The capture is the composition root's structural read of the official
          // transport identity (Connection generation + exact binding object).
          transportToken: remoteSources?.sessionFacts.captureTransportToken(sessionId) as
            RemoteTransportLifetime | undefined,
        }
        return imageScopeChild
      },
      readImage: (ref, context) => {
        if (remoteSources !== undefined) {
          const subject = context as
            { readonly sessionId?: unknown; readonly transportToken?: unknown } | undefined
          if (subject === undefined || typeof subject !== 'object' || typeof subject.sessionId !== 'string') {
            throw new ImageLoadError(
              'The image request carries no presentation scope — the Remote image read requires the owning presentation\'s subject.',
            )
          }
          if (subject.transportToken === undefined || typeof subject.transportToken !== 'object') {
            throw new ImageLoadError(
              'The image request carries no presentation lifetime — the Remote image read requires the exact binding the owning presentation was authorized under.',
            )
          }
          return remoteSources.attachments.readDurableImage(
            subject.sessionId,
            ref.attachmentId,
            subject.transportToken as RemoteTransportLifetime,
          )
        }
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
      // once at open time). PR5 v2 §2.12: the SELECTED OWNERSHIP authority is
      // the source (transport-neutral — a Remote session has no Direct agent),
      // never `agentNow()`.
      sessionId: () => ownership.currentSessionId(),
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
      // Headless-test seam (M3-4 PR3 image L6): the live image draft store.
      // Production paths never read it.
      draftImageStoreForTest: draftImages,
      // Fullscreen OSC 8 link clicks + the Windows right-click paste: the alt
      // screen's mouse capture swallows both native behaviors, so the host
      // opens http/https links itself and reads the clipboard through the same
      // platform-aware policy as the image paste probe.
      openExternalUrl: (url) => openExternalUrl(url),
      readClipboardText: () => clientActions.readClipboardText(),
      // TS8-E: the composition zone reads the live terminal palette here and
      // injects the image fallback colour, so `app/surface/**` never imports a
      // `tui/theme/**` path.
      imageFallbackColor: color.textDim,
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
    // Fresh/deferred startup title: no session yet — cwd identity only. The
    // terminal-local cwd is published alongside it (OSC 7; no-op off Tern).
    status.refreshTerminalTitle()
    status.refreshTerminalCwd()
    surface.attachEventRouting({
      isCleanedUp: () => cleanedUp,
      isAttachedSession: (session) => {
        // Remote branch: the routed session object carries only the id, and
        // the "attached" fence is the CURRENT owner identity (the ownership
        // core already fenced the ingress subscription to the exact binding
        // generation — the routing-side fence keeps the same owner truth;
        // an opening target's PRE-COMMIT events never reach this routing
        // because the ingress subscribes only after the owner commit).
        // M3-5 PR2: the VIEWED CHILD is routed through the same surface path
        // (the child ingress publishes into `routeSessionEvent`), so the fence
        // must admit the exact child currently mounted by the ONE viewer.
        if (remoteSources !== undefined) {
          return ownership.currentSessionId() === session.id
            || viewer.read()?.id === session.id
        }
        const attachedSession = sessions.get(SessionId(session.id))
        return attachedSession === undefined || attachedSession === session
      },
      currentSessionId: () => ownership.currentSessionId(),
      hasLiveAgent: () => remoteSources !== undefined
        ? ownership.currentSessionId() !== undefined
        : agentNow() !== undefined,
      completionOwnerId: () => {
        const owner = ownership.owner()
        return owner === undefined ? undefined : directRuntime()?.owners.completionIdentity(owner)
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
          if (runtimeAgent !== undefined) directRuntime()?.modelSelections.observeSelectionEvent(runtimeAgent, selectionEvent)
        } else if (event.type === 'request/header' && runtimeAgent !== undefined) {
          const data = event.data as unknown
          const header = typeof data === 'object' && data !== null
            ? (data as { header?: unknown }).header
            : undefined
          const raw = rawSelectionFromRequestHeader(header)
          if (raw !== undefined) {
            directRuntime()?.modelSelections.consumeSelection(runtimeAgent, raw.provider, raw.model, raw.reasoningEffort)
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
      // M3-4 PR2 / M3-5 PR2 Step 7: the Remote bounded-window history
      // extension targets the ACTIVE DISPLAY SUBJECT — the viewed child
      // Session while its viewer is mounted, else the main Session. Direct
      // returns false (its fold already holds the complete log).
      extendLoadedHistory: () => {
        if (remoteSources === undefined) return false
        const viewedChildId = viewer.read()?.id
        const sessionId = viewedChildId ?? ownership.currentSessionId()
        if (sessionId === undefined || cleanedUp) return false
        // The in-flight latch is SUBJECT-scoped: a page still loading for the
        // PREVIOUS subject must not swallow the new subject's first PageUp
        // (each subject owns its own official paging operation). A child page
        // that settles after the viewer switched/exited is dropped.
        if (remoteHistoryLoadingFor === sessionId) return true
        remoteHistoryLoadingFor = sessionId
        runOwned('remote loadOlder', async () => {
          try {
            if (viewedChildId !== undefined) {
              const child = viewer.read()
              if (child === undefined || child.id !== sessionId) return
              // The viewer owns the child's presentation: page the child's
              // exact retained generation and re-fold THAT window.
              await viewer.extendViewedChildHistory()
              return
            }
            const before = await remoteSources.presentationReader.read(sessionId)
            if (before === undefined || !before.hasMore || before.loadingOlder) return
            const snapshot = await remoteSources.presentationReader.loadOlder(sessionId, lifecycleController.signal)
            if (snapshot === undefined) return
            if (ownership.currentSessionId() !== sessionId || cleanedUp) return
            await presentation.rehydrateFromWindow(sessionId)
          } finally {
            if (remoteHistoryLoadingFor === sessionId) remoteHistoryLoadingFor = undefined
          }
        }, { diag, sessionId: () => sessionId })
        return true
      },
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
      registeredAgentIs: (sessionId, agent) => directRuntime()?.registeredAgentFor(sessionId) === agent,
      isCurrentOwnerAgent: (agent) => isCurrentOwnerAgent(agent as Agent),
      viewedChildAgent: () => viewer.viewedChildAgent(),
      setViewedChildAgent: (agent) => viewer.setViewedChildAgent(agent),
      setViewedQueueAgent: (agent) => viewer.setViewedQueueAgent(agent),
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
    const jobs = remoteSources === undefined ? ctx.get('jobs') : undefined
    const subagents = remoteSources === undefined ? ctx.get('subagents') : undefined
    // The selected Task read source: the branch composition lives in
    // `app/bootstrap/task-source.ts` (TS2 §9); the Host service lookups above
    // stay HERE and the helper receives the already-resolved narrow values.
    const taskSource = createTaskSource({
      remoteSources,
      subagents: subagents === undefined ? undefined : {
        listDescendants: (sessionId, signal) => subagents.listDescendants(sessionId as SessionId, signal),
      },
      jobs: jobs === undefined ? undefined : {
        list: (caller) => jobs.list(caller as SessionId) ?? [],
      },
      agents: { get: (sessionId) => agents.get(SessionId(sessionId)) },
      currentSessionId: () => ownership.currentSessionId(),
      generation: () => ownership.generation(),
      isCleanedUp: () => cleanedUp,
      currentDirectSessionId: () => agentNow()?.session.id,
    })
    surface.attachTasks({
      // The Task Center's owner session id is the TRANSPORT-NEUTRAL ownership
      // read: the Direct live Agent's session, or (Remote) the current owner
      // session — no Direct attachment is required to open /tasks or to read
      // the roster on the Remote branch.
      sessionId: () => agentNow()?.session.id ?? ownership.currentSessionId(),
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
      // The roster feed ONLY on both backends: the selected-Job detail and
      // Stop come from `backend.jobObservation` (M3-5 PR3), so this capability
      // never carries a registry get/kill. Direct reads the Host registry;
      // Remote reads the official Client Jobs model under the task reader's
      // retained root watch.
      jobs: remoteSources === undefined
        ? jobs === undefined ? undefined : {
          // Job ownership is the Session id (DSH 0.1.7 JobRegistry); the caller
          // may be omitted (the unowned-only view) when no session is live.
          list: (sessionId) => jobs.list(sessionId as SessionId | undefined),
          subscribe: (listener) => jobs.events.subscribe({ owners: 'scope' }, listener),
        }
        : {
          list: (sessionId) => sessionId === undefined ? [] : remoteSources.task.jobs(sessionId),
          // The official Jobs model is one observable: any snapshot change is a
          // roster/status invalidation hint (the authoritative answer is always
          // the next semantic read).
          subscribe: (listener) => remoteSources.task.subscribeJobs(() => listener({ type: 'state' })),
        },
      taskRead: taskSource.taskRead,
    }, {
      diag,
      isCleanedUp: () => cleanedUp,
    })
    if (remoteSources !== undefined) {
      // M3-5 PR2 Step 2/§D3: the Remote Task Center invalidation is
      // observable-driven — the official Session list (catalog membership and
      // the per-session running fact) and the official Jobs state (roster
      // changes) feed the EXISTING coalesced refresh gate. No timer, no poll.
      //
      // The Jobs half is subscribed EXACTLY ONCE, through the surface's own
      // `TaskSurfaceJobs.subscribe` (which the runner maps onto the official Jobs
      // state and which routes a roster/status change to `refreshTasks()` +
      // `refreshAgents()`). A second direct subscription here would deliver the
      // SAME change twice: the second entry would mark the in-flight catalog
      // refresh dirty and force a trailing traversal for one state change.
      const disposeTaskSessions = remoteSources.task.subscribeSessions(() => surface.refreshAgents())
      lifecycleController.signal.addEventListener('abort', () => {
        disposeTaskSessions()
      }, { once: true })
    }
    surface.refreshPendingInput()
    // A5b-3: the semantic command runtime binding AND the facade assembly are
    // command-owned; the composition root only triggers the wiring step.
    command.attachRuntime()
    /**
     * The Remote prepareMessage (M3-4 PR3 Step 7): the REMOTE application
     * preparation builder. The Direct/Remote builder selection happens HERE at
     * the application layer — `submission.prepareMessage()` creates the Direct
     * `UserMessage` (`direct-message-preparation.ts`), while this
     * `preparePrompt()` snapshots the drafts into the immutable `PreparedPrompt`
     * — and the two share only the mention canonicalization and the strict
     * combined placeholder-expansion semantics. The Remote serializer then owns
     * just the Remote preflight/encoding/wire mapping over the official Client
     * contract; the draft semantic layer is never branched by transport.
     */
    const prepareRemotePrompt = async (text: string, requestId: string): Promise<unknown> => {
      // Mention canonicalization must match the Direct pipeline exactly: route
      // through the same Host-file port seam.
      const canonical = await backend.hostFile.canonicalizeMentions(
        { kind: 'session', sessionId: ownership.currentSessionId() ?? '' },
        text,
      )
      const sessionId = ownership.currentSessionId()
      if (sessionId === undefined) throw new Error('a Remote submission requires a live session scope')
      return preparePrompt(sessionId, canonical, { images: draftImages, files: draftFiles }, requestId)
    }
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
          // M3-4 PR3: the echo's running fact is transport-neutral — the
          // Remote branch reads the CURRENT owner's session id + official
          // running bit through the same projection the controller uses;
          // the exact-Direct-owner resolution stays Direct-only.
          const agent = remoteSources === undefined
            ? command.agentForLiveScope(scope)
            : presentationBridge.liveSessionFactsFor(scope)
          if (agent === undefined) return
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
        prepareMessage: (text, requestId) => remoteSources === undefined
          // Direct: the Direct UserMessage preparation runs the Host
          // attachment admission inline (app/submission/direct-message-preparation.ts).
          ? submission.prepareMessage(text, requestId)
          // Remote (M3-4 PR3): the Remote application builder snapshots the
          // drafts into the immutable PreparedPrompt; the Remote serializer
          // then performs the preflight/encoding/wire mapping over the official
          // Client contract. Both branches share canonicalization + strict
          // placeholder semantics, not one preparation authority.
          : prepareRemotePrompt(text, requestId),
        prompt: (sessionId, message) => backend.sessionWriter.prompt(sessionId, message, 'queue'),
      },
    })
    // The startup surface: a resumed session initializes everything; the
    // deferred path shows the pre-session invitation until the first message.
    const startupAgent = agentNow()
    if (remoteSources !== undefined) {
      // M3-4 PR2: the startup resume published a Remote owner — initialize
      // its whole presentation through the reader window + live ingress
      // (the deferred/sessionless branch stays below otherwise).
      const startupSessionId = ownership.currentSessionId()
      if (startupSessionId !== undefined) await initRemoteLiveSurface(startupSessionId)
    } else if (startupAgent !== undefined) {
      // The initial owner's catalog was prefetched before mount: no
      // duplicate refresh.
      await presentation.initLiveSession(startupAgent)
    } else {
      app.setWelcomeIdle(true)
      status.refresh()
      status.refreshTerminalTitle()
      status.refreshTerminalCwd()
    }
    // Command registration is sessionless: it must run on BOTH startup
    // surfaces (resume path registers inside initLiveSession; the deferred
    // path registers here so /exit /settings /help work before any message).
    // The pre-mount snapshot installs SYNCHRONOUSLY inside registration —
    // the first terminal input cannot arrive before this call stack unwinds.
    command.register({ snapshot: initialSnapshot, skills: initialSkills })
    // PR4 §2.2: the DIRECT branch's Host command catalog arrives through the
    // pre-mount prefetch above; the REMOTE branch has no Direct agent to
    // prefetch, so a RESUMED session installs its authoritative Host catalog
    // through the command source now (before the first input). Without this
    // the Host claims are unknown and a same-named Client contribution would
    // shadow a real Host command — the exact §D3 violation.
    if (remoteSources !== undefined) {
      const resumedSessionId = ownership.currentSessionId()
      if (resumedSessionId !== undefined) {
        try {
          await command.refreshLiveCatalogById(resumedSessionId)
        } catch (error) {
          // The coordinator owns degradation (last-good/notice); a failed
          // install must not block the mount.
          diag.warn('remote startup catalog refresh failed', { error: safeErrorMessage(error) })
        }
      }
    }
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
    /** Persist one completed turn. Direct keeps its durability hint; the
     *  Remote branch is a DELIBERATE no-op (plan §7.9: no public Client
     *  flush verb exists — the Host owns durability; never a hidden Host
     *  `sessions.flush` fallback). */
    const flushTurn = (): void => {
      if (remoteSources !== undefined) return
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
    // The six application-level Host subscriptions (TS2 §10): installation is
    // owned by `app/bootstrap/event-wiring.ts`; each handler stays a thin
    // delegation into the surface-owned routing methods. The Direct-only
    // durable/runtime channels and the capability-optional refresh
    // subscriptions keep their existing branch split.
    // FROZEN STARTUP ORDER: the registration is TWO phases because the baseline
    // interleaved them with the Direct live-assistant-stream acquire — phase 1
    // (`session/event`) here, phase 2 (the other five) AFTER the stream install
    // and its abort binding. A throwing stream install must therefore leave
    // exactly the listeners the baseline had installed.
    installSessionEventWiring({ ctx, direct: remoteSources === undefined, surface })
    // Session v2 live assistant streams: the TRANSIENT plane
    // (`agent/assistant-stream` frames mapped through the neutral port).
    // Live model output never rides the durable log; the runner routes the
    // neutral input by session id — the main folder/stats/previews for the
    // live agent, the viewer's own folder/stats/previews for a viewed
    // child — and stamps the first-token latency. The identity fence
    // re-reads the live surface so a stale stream from a retired agent
    // never reaches the presentation.
    // M3-4 PR2: the live assistant ingress is BRANCH-SPECIFIC. Direct keeps
    // the process-local `agent/assistant-stream` install (A4-7: the routing
    // bodies are surface-owned, the Direct install stays Direct-owned); the
    // Remote branch subscribes the official eventSource through the
    // presentation-source ingress (identity = the exact binding object +
    // Connection generation, never an Agent object — plan §7.6).
    // Direct keeps its install unconditionally-shaped; the Remote branch
    // reaches this line with `directRuntime()` undefined and skips it (the
    // eventSource ingress owns its live assistant plane instead).
    const directAssistantRuntime = directRuntime()
    if (directAssistantRuntime !== undefined) {
      const assistantStreamHandle = directAssistantRuntime.installAssistantStream({
        isCurrentAgent: (agent) => surface.isCurrentAssistantAgent(agent),
        onInput: (input) => surface.applyAssistantInput(input),
      })
      assistantStreamBaselineFor = assistantStreamHandle.baselineFor
      lifecycleController.signal.addEventListener('abort', assistantStreamHandle, { once: true })
    }
    // Phase 2 of the frozen startup order (see the phase-1 comment above): the
    // remaining five application-level Host subscriptions are installed AFTER
    // the Direct assistant-stream acquire and its abort binding, exactly where
    // the baseline registered them.
    installRuntimeEventWiring({ ctx, direct: remoteSources === undefined, surface })
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

  void startRunner().catch(fatalLifecycle.handleStartupFailure) // allowlist: startup lifecycle root — see AGENTS.md
}
