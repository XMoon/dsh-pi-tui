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
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
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
import { createModelSelectionOwner } from './command/model-selection.ts'
import { createViewerRuntime, type ViewerRuntime } from './surface/viewer-runtime.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from '../present.ts'
import { childOwnEvents, TranscriptFolder } from '../transcript.ts'
import { renderTranscriptMarkdown } from '../transcript.ts'
import { sessionArtifactFilename } from '../session-artifact-filename.ts'
import { isDirectoryPath, resolveClientDirectory, streamToFile, writeTextAtomically } from '../client-artifact-save.ts'
import type { SaveLocationResult } from '../save-location.ts'
import { completeDirectory } from '../file-completion/directory-completion.ts'
import { LocalFileSource } from '../file-completion/local-file-source.ts'
import { parseProgressUpdates, parseResponseStyle, type ProgressUpdatesState, type ResponseStyleState } from '../communication-policy.ts'
import { isFocusDisplayPreset, resolveDisplayPreset, type DisplayState } from '../display-preset.ts'
import { DISABLE_FOCUS_REPORTING } from '../notification/terminal-focus.ts'
import { guardedStreamWriter } from '../notification/terminal-notifier.ts'
import { computeStats } from '../stats.ts'
import { isAssistantTokenDelta } from '../token-usage.ts'
import { projectedPlanActive, type PlanProjectionLike } from '../status/derive-plan.ts'
import type { CompositionStatus, HostStatus, WorkspaceStatus } from '../status/types.ts'
import { migrateLegacySettings } from '../legacy-settings-migration.ts'
import { color } from '../theme.ts'
import { isEmptyAcceleratedViewerSubmit, type TuiApp, type TuiAppEvents } from '../tui-app.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../extensions.ts'
import { type ViewerAccess } from '../tasks-browser.ts'
import type { ComposerSubmitRequest } from '../tui-app.ts'
import { isIndeterminateSkillWrite, resolveComposerDelivery, registerTuiCommands, type CommandRegistryLike, type HostCommandClaim, type InitialCommandCatalog, type SubmitDelivery, type TuiCommandRunner } from '../commands.ts'
import { diagFromEnv, dshHome, type Diag } from '../diag.ts'
import { runDetached, runOwned, isCancellation, type OwnedTaskOptions } from '../detached.ts'
import { historyFilePath } from '../history.ts'
import { historySessionIdFor, persistAfterSession, persistHistoryRecord } from '../history-persist.ts'
import { FileHistorySearchSource } from '../history-search.ts'
import { safeErrorMessage } from '../error-boundary.ts'
import { DraftImageStore } from '../image/draft-store.ts'
import { DraftFileStore } from '../attachment/file-draft.ts'
import { ImageInputError } from '../image/errors.ts'
import { commandOnPath, createClipboardRunner, readClipboardImage, readClipboardText, type ClipboardEnvironment } from '../image/clipboard.ts'
import { openExternalUrl } from '../open-url.ts'
import { buildOsc52Sequence, copyToClipboard, type CopyEnvironment, type CopyExecutor } from '../clipboard.ts'
import { createStartupStatus } from '../startup-status.ts'
import { iconStyleOf } from '../icons.ts'
import { checkImageLimits } from '../image/intake.ts'
import { ImageLoadError } from '../image/errors.ts'
import { consumeDraftAttachments, draftHasAttachments, draftHasImages, pinDraftAttachments, prepareUserMessage, pruneUnreferencedDraftAttachments, type PrepareInputDeps } from '../image/submit.ts'
import { expandImagePlaceholders } from '../image/placeholder.ts'
import { expandAttachmentPlaceholders } from '../attachment/placeholder.ts'
import { draftHasFiles } from '../attachment/placeholder.ts'
import { runReservedSubmit } from '../image/submit-flow.ts'
import { dshVersion } from '../dsh-version.ts'
import { createExitController } from '../exit.ts'
import { type SessionRetirementReport } from '../app/session/owner-access.ts'
import { mergeDraft, refuseByTransitionFence, steerAll, sessionUnchanged, type SteerAgentLike } from '../steer.ts'
import { resolveSubagentSettleTarget, subagentPromptDisposition, viewerCanonicalizeScope, type SubagentPromptOutcome, type SubagentPromptReject, type SubagentViewerSubmitRequest } from '../subagent-viewer-submit.ts'
import { bindCommandRuntime } from '../app/command/runtime.ts'
import { createDirectApplicationRuntime } from '../app/direct/runtime.ts'
import { createSessionOwnershipCore } from '../app/session/ownership-core.ts'
import { bindSessionRuntime } from '../app/session/runtime.ts'
import { createSessionScopeAuthority, SessionScopeSupersededError, type LiveSessionScope, type SessionScope } from '../app/session/scope.ts'
import { bindSubmissionRuntime, deliverBusy, executeHostCommandSubmission, pullBackQueue, steer, submitShell, type SteerSubmissionAgent, type SteerSubmissionDeps, type SubmissionRuntime } from '../app/submission/runtime.ts'
import type { SessionOwnerRef, SessionSubject } from '../app/session/subject.ts'
import { createSurfaceRuntime } from '../app/surface/runtime.ts'
import { type SessionQueryLike } from '../runtime/direct/session-direct.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc } from '../runtime/config-port.ts'
import { SupersededReadError } from '../runtime/read-error.ts'
import type { AssistantLiveInput } from '../runtime/assistant-stream-port.ts'
import { requireCreated, requireOpened, type SessionHandle } from '../runtime/session-lifecycle-port.ts'
import type { HostCommandOutcome } from '../runtime/host-command-port.ts'
import { localShellSandboxPreferenceOf, shellCommandOf, shellModeOf, type ShellSubmitAgentLike } from '../shell-context.ts'
import { createBoundedOutput, createFileCapture, formatBytes, formatTruncation, SHELL_OUTPUT_DISK_CAP_BYTES } from '../bounded-output.ts'
import { parseShellWords } from '../shell-words.ts'
import { CatalogRefreshCoordinator, CoalescingRefreshGate, type CatalogRefreshOutcome, type CatalogRefreshRequest } from '../skill-catalog-refresh.ts'
import { commandSummaryOf, readSurfaceCatalog, type SurfaceCatalogContext, type SurfaceCatalogSnapshot } from '../surface-catalog.ts'
import { type HumanSkillCatalog } from '../skill-catalog.ts'
import { collectRewindCandidates, rewindPickerItem } from '../rewind.ts'
import { type RewindLiveIdentity } from '../session-fork.ts'
import { freshSubmitAckState, acceptSubmitAck, settleSubmitAck, type SubmitAckState, type SubmitPendingDetail } from '../submit-ack.ts'
import { PendingSubmissions, type PendingSubmissionPlacement } from '../pending-submission.ts'
import { DirectSubmissionPresentation, type SubmissionPresentationSource } from '../submission-presentation.ts'
import { SubmitLatencyTracker } from '../submit-latency.ts'
import type {} from '@deepseek-ai/dsh-token-meter'
import { SESSIONLESS_COMMANDS, LOCAL_COMMANDS, isBareCommandLine, commandIsLocalForAttachments, resolveSubmitDelivery, normalizeSkillInvocation, shouldConsumeAdvertisedMiss, isPlainExitPrompt, dangerCommand } from '../command-policy.ts'
import { interruptAgent } from '../interrupt.ts'
import { viewerActionCapability } from '../subagent-viewer.ts'
import { resolveInitialCatalog } from '../surface-catalog.ts'
import { subagentJobTranscriptId, taskRowSelectionDisposition, subagentJobViewHint } from '../task-presentation.ts'
import { queueInboxMessageOf, queueTextOf } from '../pending-presentation.ts'
import { bundleVersion, packageVersion } from '../dsh-version.ts'
import { compactingFromLog, workingFromLog } from '../compaction-presentation.ts'
import { hostRunningProfile, resumeCommand } from '../dsh-profile.ts'

import type { Config } from '../tui-config.ts'
import { composeDirectAgent, type DirectAgentComposition } from '../app/direct/composition.ts'

/** The launcher's bounded exit request; the TUI invokes it after keyboard
 * confirmation. */
interface AppExit {
  (code: number): void
}

/** Throttle for re-chaining a RUNNING local shell card's result to the
 * bounded tail (plan §5.1): the running preview refreshes at most this
 * often, so a high-throughput log cannot rebuild the view per chunk. */
const LOCAL_SHELL_TAIL_FLUSH_MS = 200

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
    /**
     * The busy/steer and shell-submit writer admission (A3-4): the helper
     * modules receive a writer SECTION, not the raw barrier. It captures the
     * live scope at the SAME synchronous admission point and enters through
     * `SubmissionRuntime.withWriter`, so the operation barrier has exactly ONE
     * admission owner and a stale capture refuses with
     * `SessionScopeSupersededError`.
     */
    const submissionWriterSection = <T>(task: () => Promise<T>): Promise<T> => {
      const scope = sessionScope.captureLive()
      if (scope === undefined) return Promise.reject(new SessionScopeSupersededError())
      return submissionRuntime.withWriter(scope, task)
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
    // the single `liveAgent` / `viewedQueueAgent` mutable truth (A2 relocates
    // that authority into `app/session`).
    let viewedQueueAgent: {
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly agent: Agent
    } | undefined
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
        composeDirectAgent(ctx, installSelection, presetId, displayState, diag, progressUpdatesState, responseStyleState),
      getViewedQueueAgent: () => viewedQueueAgent,
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
        settleLocalSubmitAck: (reason) => settleLocalSubmitAck(reason),
        resetSubmitLatency: () => submitLatencyTracker.reset(),
        setCompletionOwner: (identity) => surface.setCompletionOwner(identity),
        initLiveSession: (owner) => {
          const agent = directAgentOfOwner(owner)
          if (agent === undefined) throw new Error('initLiveSession requires a Direct owner attachment')
          return presentation.initLiveSession(agent)
        },
        refreshLiveCatalog: (owner) => {
          const agent = directAgentOfOwner(owner)
          if (agent === undefined) throw new Error('refreshLiveCatalog requires a Direct owner attachment')
          return refreshLiveCatalog(agent)
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
      commands: { register: () => registerCommands({ snapshot: initialSnapshot, skills: initialSkills }) },
      submission: { clearPending: () => pendingSubmissions.clear() },
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


    // Abort handle for the currently running `!` shell command.
    let localShellController: AbortController | undefined
    /** Stop the captured live Agent through the SessionWriter seam. The
     * operation barrier keeps the async outcome inside the same session
     * ownership window as other TUI writes. */
    const interruptLiveAgent = (): void => {
      if (cleanedUp) return
      localShellController?.abort()
      const agent = agentNow()
      if (agent === undefined) return
      const generation = ownership.generation()
      // The scope-bound writer admission (A3-4): interrupt is NOT a submission
      // write, so its business ownership stays here — only the admission moves
      // through SessionRuntime.withWriter.
      runOwned('agent interrupt', () => sessionRuntime.withWriter(
        requireLiveScope(),
        () => interruptAgent(agent, backend.sessionWriter),
      ), {
        diag,
        sessionId: () => agentNow()?.session.id,
        onResult: (outcome) => {
          if (cleanedUp || !sessionUnchanged({ agent, generation }, agentNow(), ownership.generation())) return
          if (outcome.kind === 'committed' || outcome.kind === 'cancelled') return
          const message = outcome.kind === 'rejected'
            ? outcome.error.message
            : outcome.kind === 'unsupported'
              ? outcome.reason
              : outcome.kind === 'indeterminate'
                ? 'session cancellation result is indeterminate — do not retry automatically'
                : 'session cancellation was cancelled'
          app.notify(message, 'error')
        },
        onError: (error) => {
          if (cleanedUp || !sessionUnchanged({ agent, generation }, agentNow(), ownership.generation())) return
          app.notify(safeErrorMessage(error), 'error')
        },
      })
    }
    // 0600 temp files holding FULL local-shell output (for truncated runs);
    // removed at TUI exit (default), never on their own.
    const shellTempFiles = new Set<string>()
    // M2: the plugin keybinding-sync unsubscribe slot is A4-5 surface-owned
    // (`surface.bindPluginKeybinds` / `surface.dispose`); the runner no longer
    // holds it.
    // The catalog refresh coordinator: the ONE post-mount refresh owner
    // (first session, switches, /preset, /reload). Declared here (before
    // cleanup) for the same TDZ guard — cleanup disposes it, and a
    // mid-startup HMR unload must never reference it while it is still in
    // the temporal dead zone; it is assigned during command registration.
    let catalogCoordinator: CatalogRefreshCoordinator | undefined
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
      catalogCoordinator?.dispose()
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
      localShellController?.abort()
      for (const file of shellTempFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          // Best effort.
        }
      }
      shellTempFiles.clear()
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

    /**
     * Run a `!` shell command. `!` (context mode) runs the command and then
     * submits the completed command+output to the session as an ordinary
     * user message (kimi parity: the model sees both on the next
     * turn; the result wakes a turn but is never steered into a running
     * one); `!!` (local mode) runs purely off-session — the card is the
     * only record (pi's excluded-from-context escape hatch).
     */
    const runLocalShell = (text: string, ackToken: number | undefined): void => {
      if (cleanedUp) return
      const includeInContext = shellModeOf(text) === 'context'
      const command = shellCommandOf(text)
      if (command === '') return
      // NOTE: the context-mode submit ack is armed AT THE GESTURE in
      // dispatchUserInput (before ensureSession) — NEVER here, or the T0
      // baseline would rebase after the session create. `ackToken` scopes
      // every terminal settle below to THIS gesture: a newer submission
      // (bumped epoch) makes them no-ops.
      const shellTerminalAck = (reason: string): void => {
        if (ackToken === undefined) return
        settleLocalSubmitAck(reason, { token: ackToken, terminal: true })
      }
      // The generation the run STARTED under: a session switch while the
      // command runs must not post the output into the new session (the
      // switch already cleared the card; the notify explains what happened).
      // switch already cleared the card; the notify explains what happened).
      const generationAtRun = ownership.generation()
      localShellController?.abort()
      localShellController = new AbortController()
      const localSignal = localShellController.signal
      // The card reference this run owns: settling by identity keeps a
      // settled old run from overwriting a newer run's card (updateLastLocal
      // Message would hit whatever card is newest at settle time). The
      // reference is RE-CHAINED on every in-flight tail update (the array
      // element is replaced, so the old reference would no longer index).
      let card = app.pushLocalMessage({
        kind: 'tool',
        turn: Number.POSITIVE_INFINITY,
        name: 'shell',
        args: command,
        result: '',
        status: 'running',
      })
      /** Release the controller only when it still guards THIS run. */
      const releaseController = (): void => {
        if (localShellController?.signal === localSignal) localShellController = undefined
      }
      /**
       * Submit the completed run to the session (context mode only):
       * re-validate → followup. Accepted clears the settled card — the
       * transcript's user row becomes the record. The submission runtime owns
       * the ordered write, its outcome settlement and the card dismissal; the
       * runner supplies the narrow TUI hooks.
       */
      const submitResult = (result: string): void => {
        submitShell({
          command,
          result,
          generationAtRun,
          isDisposed: () => cleanedUp,
          currentGeneration: () => ownership.generation(),
          currentSessionId: () => agentNow()?.session.id,
          currentAgent: () => agentNow() as unknown as ShellSubmitAgentLike | undefined,
          terminalAck: shellTerminalAck,
          clearSettledLocalMessages: () => app.clearSettledLocalMessages(),
          notify: (message, kind) => {
            if (cleanedUp) return
            app.notify(message, kind)
          },
          markDispatch: (sessionId) => submitLatencyTracker.mark(sessionId, 'dispatch'),
          writerSection: submissionWriterSection,
          writer: backend.sessionWriter,
          createMessage: (text) => createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
          diag,
        })
      }
      // A settled latch: `error` and `close` can both fire (a spawn failure
      // usually closes with a non-zero code), and the card must settle
      // EXACTLY once — the first event wins.
      let settled = false
      const settle = (result: string, status: 'ok' | 'error'): void => {
        if (cleanedUp || settled) return
        settled = true
        app.updateLocalMessage(card, {
          kind: 'tool',
          turn: Number.POSITIVE_INFINITY,
          name: 'shell',
          args: command,
          result,
          status,
        })
        // Context mode submits every settled outcome except an abort (the
        // run was cancelled; the partial output is noise). An aborted run
        // is also TERMINAL for the submit acknowledgement (plan D exit
        // enumeration): the aborted gate suppresses submitResult, so the
        // pending row would otherwise outlive the gesture forever.
        //
        // EVERY settle caller funnels through HERE — including the
        // synchronous `shell.resolve`/`spawn` catches and the child
        // `error` handler — so no additional ack settle is needed at
        // those sites: a non-abort failure continues into submitResult →
        // submitShellResult, whose onResult/onError/onCancel sinks end
        // the ack (or the authoritative event does), and an abort ends
        // it through the gate below. Adding token settles at the catch
        // sites instead would pre-clear the row and break the "ack
        // survives until the authoritative event" contract.
        if (includeInContext && localSignal.aborted) {
          shellTerminalAck('shell run aborted')
        }
        if (includeInContext && !localSignal.aborted) submitResult(result)
      }
      const sandboxPreference = localShellSandboxPreferenceOf(tuiSettings?.get())
      const shell = sandboxPreference === 'sandbox' ? ctx.get('shell') : undefined
      if (shell === undefined && sandboxPreference === 'sandbox') {
        // The user explicitly opted into the sandbox but the composition
        // provides no shell capability: running unsandboxed SILENTLY would
        // violate the preference, so the downgrade is surfaced every time.
        app.notify('local shell sandbox unavailable in this composition — running unsandboxed', 'error')
      }
      if (shell !== undefined) {
        // The dsh shell capability (sandbox policy + DSH env) when the
        // composition provides it AND the local-shell sandbox preference
        // opts in ('sandbox'); completion-based like the spawn fallback.
        // The default ('bypass') runs user-typed commands through the plain
        // spawn path below — pi/kimi parity: the sandbox guards the model's
        // autonomous commands, not commands the user typed and chose to run.
        // A synchronous resolve throw must not escape with the ack row
        // armed: settle the card (and the terminal ack) exactly like a
        // failed run (plan D exit enumeration).
        let spec: ReturnType<typeof shell.resolve>
        try {
          spec = shell.resolve({ command, workdir: status.sessionCwd(), signal: localSignal })
        } catch (error) {
          releaseController()
          settle(`failed: ${safeErrorMessage(error)}`, 'error')
          return
        }
        // An owned workflow: the RESULT settles the UI card, so the settle
        // logic stays in onResult and the cancellation/failure semantics
        // stay per-task (runOwned — AGENTS.md); the classification
        // diagnostics (cancellation → debug, failure → error) are recorded
        // by runOwned itself. DSH 0.1.7 execute/result contract: execute()
        // publishes the handle after preparation (throwing on preparation
        // failure or caller cancellation before the process exists) and
        // result() is the foreground projection — nonzero exits, timeout
        // kills, and abort kills RESOLVE with a descriptive result, and
        // only infrastructure failures reject. The dsh shell may still
        // reject an abort with a plain Error, so the task-local classifier
        // routes it to onCancel instead of a false ERROR line. Never a
        // bare void.
        runOwned('local shell', async () => {
          const execution = await shell.execute(spec)
          return execution.result()
        }, {
          diag,
          sessionId: () => agentNow()?.session.id,
          isCancellation: () => localSignal.aborted,
          onResult: (result) => {
            releaseController()
            if (localSignal.aborted) {
              settle('aborted', 'error')
              return
            }
            const output = [result.stdout.text.trim(), result.stderr.text.trim()].filter(Boolean).join('\n')
            const exit = result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? '?'}`
            settle(output === '' ? exit : `${output}\n[${exit}]`, result.exitCode === 0 ? 'ok' : 'error')
          },
          onCancel: (error) => {
            // An abort-triggered rejection is a cancellation: settle the
            // card as aborted like the resolved path does. runOwned routes
            // cancellations EXCLUSIVELY here — a cancellation-shaped
            // rejection WITHOUT the signal aborted skips the aborted gate
            // inside settle(), so the ack row must be settled terminally
            // HERE too (idempotent with it).
            releaseController()
            settle('aborted', 'error')
            if (includeInContext && !localSignal.aborted) {
              shellTerminalAck('shell run cancelled')
            }
            void error
          },
          onError: (error) => {
            releaseController()
            const message = safeErrorMessage(error)
            settle(`failed: ${message}`, 'error')
            // A sandbox execution failure does NOT run submitResult (only
            // onResult does), so this exit is terminal for the ack row:
            // nothing will be written — the pending row must end here
            // (plan D exit enumeration). An abort settles through the
            // unified aborted gate above instead.
            if (includeInContext && !localSignal.aborted) {
              shellTerminalAck('shell sandbox run failed')
            }
          },
        })
        return
      }
      // A synchronous spawn throw must not escape with the ack row armed:
      // settle the card (and the terminal ack) exactly like a failed run
      // (plan D exit enumeration).
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, { cwd: status.sessionCwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      } catch (error) {
        releaseController()
        settle(`failed: ${safeErrorMessage(error)}`, 'error')
        return
      }
      // Bounded capture: the card keeps only the TAIL (byte- and line-
      // capped, unterminated output included); the FULL output is streamed
      // to a 0600 temp file (disk-capped) so a truncated run still leaves
      // the complete transcript available. Untruncated runs delete the file
      // on close; the files that remain are removed at TUI exit (cleanup).
      const bounded = createBoundedOutput()
      const fullPath = join(tmpdir(), `dsh-pi-tui-shell-${process.pid}-${randomUUID()}.log`)
      const full = createFileCapture(fullPath, SHELL_OUTPUT_DISK_CAP_BYTES)
      if (full.active) shellTempFiles.add(fullPath)
      // ONE StringDecoder PER stream: stdout and stderr are independent
      // byte streams, so a character split across them would interleave
      // and corrupt — each stream's decoder buffers only its own partial
      // sequences and decodes across that stream's chunk boundaries.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      // In-flight tail refresh (plan §5.1): the running card's result is
      // re-chained to the bounded TAIL on a throttle, so a streaming log
      // previews its newest rows instead of an empty body. The throttle
      // keeps high-throughput output from rebuilding the whole view per
      // chunk; settle/close clears the timer (dispose contract).
      let tailTimer: NodeJS.Timeout | undefined
      const clearTailTimer = (): void => {
        if (tailTimer !== undefined) {
          clearTimeout(tailTimer)
          tailTimer = undefined
        }
      }
      const scheduleTailFlush = (): void => {
        if (cleanedUp || tailTimer !== undefined) return
        tailTimer = setTimeout(() => {
          tailTimer = undefined
          if (cleanedUp) return
          card = app.updateLocalMessage(card, {
            kind: 'tool',
            turn: Number.POSITIVE_INFINITY,
            name: 'shell',
            args: command,
            result: bounded.tail,
            status: 'running',
          })
        }, LOCAL_SHELL_TAIL_FLUSH_MS)
      }
      const onData = (decoder: StringDecoder, chunk: Buffer): void => {
        if (cleanedUp) return
        // The wire byte count rides along: an incomplete multi-byte
        // sequence buffered by the decoder produces no text yet, but its
        // bytes are real and must count toward the totals.
        bounded.append(decoder.write(chunk), chunk.length)
        full.append(chunk)
        scheduleTailFlush()
      }
      child.stdout?.on('data', (chunk) => onData(stdoutDecoder, chunk))
      child.stderr?.on('data', (chunk) => onData(stderrDecoder, chunk))
      localSignal.addEventListener('abort', () => child.kill(), { once: true })
      child.on('error', (error) => {
        releaseController()
        clearTailTimer()
        // A spawn failure leaves nothing worth keeping: drop the capture.
        full.dispose()
        shellTempFiles.delete(fullPath)
        if (cleanedUp) return
        settle(`failed: ${error.message}`, 'error')
      })
      child.on('close', (code, childSignal) => {
        releaseController()
        clearTailTimer()
        if (cleanedUp) {
          full.dispose()
          shellTempFiles.delete(fullPath)
          return
        }
        // Flush each decoder's remaining partial sequence. An incomplete
        // trailing multi-byte character surfaces as U+FFFD from end() — it
        // is shown as-is (the bytes were real); its wire bytes were already
        // counted by append's wireBytes, so pass 0 to avoid double counting.
        for (const decoder of [stdoutDecoder, stderrDecoder]) {
          const tail = decoder.end()
          if (tail !== '') bounded.append(tail, 0)
        }
        if (localSignal.aborted) {
          // The run was cancelled: the partial capture is noise, delete it.
          full.dispose()
          shellTempFiles.delete(fullPath)
          settle('aborted', 'error')
          return
        }
        if (bounded.truncated) {
          // Keep the full-output file for a truncated run — but only when
          // the capture is actually alive (creation/write failures are
          // never advertised, and a disk-capped file says so).
          if (full.exists) {
            full.close()
          } else {
            full.dispose()
            shellTempFiles.delete(fullPath)
          }
          const output = bounded.tail.trim()
          const lines: string[] = []
          if (output !== '') lines.push(output)
          lines.push(formatTruncation(bounded))
          if (full.exists) {
            lines.push(full.truncated
              ? `full output (disk capture truncated at ${formatBytes(SHELL_OUTPUT_DISK_CAP_BYTES)}): ${fullPath}`
              : `full output: ${fullPath}`)
          }
          const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
          lines.push(`[${exit}]`)
          settle(lines.join('\n'), code === 0 ? 'ok' : 'error')
        } else {
          // Untruncated output: no reason to keep a user-invisible temp
          // file around until TUI exit.
          full.dispose()
          shellTempFiles.delete(fullPath)
          const output = bounded.tail.trim()
          const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
          settle(output === '' ? exit : `${output}\n[${exit}]`, code === 0 ? 'ok' : 'error')
        }
      })
    }
    /** The display text of one client-local submission echo: the draft text
     * with its attachment placeholders expanded to compact markers, so an
     * attachment-only submission is never an empty pending row. The SAME
     * expansion decides the foldability fact: a submission carrying any
     * attachment marker is not text-only and must render in full. */
    const localEcho = (text: string): { text: string; foldableText: boolean } => {
      const parts: string[] = []
      let foldableText = true
      for (const segment of expandAttachmentPlaceholders(text, draftImages, draftFiles)) {
        if (segment.type === 'text') parts.push(segment.text)
        else if (segment.type === 'image') {
          foldableText = false
          parts.push(`🖼️ ${segment.image.name ?? 'image'}`)
        } else {
          foldableText = false
          parts.push(`📄 ${segment.file.name} · ${formatBytes(segment.file.byteLength)}`)
        }
      }
      return { text: parts.join(' '), foldableText }
    }
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
      publishQueueAuthority: (authority) => { viewedQueueAgent = authority },
      refreshStatus: () => status.refresh(),
      restoreMainTranscriptAnchor: () => presentation.restoreMainTranscriptAnchor(),
    })
    viewerRef = viewer
    /** Error sink for a failed session creation: restore the draft and
     * surface the reason instead of silently dropping the submission. The
     * classification diagnostics are owned by runOwned (label + session +
     * error); this sink only restores the editor and notifies the user.
     * (Cancellation never reaches here: runOwned routes it to onCancel.) */
    const failSubmission = (draft: string) => (error: unknown): void => {
      if (lifecycleController.signal.aborted) return
      // Correctness side effect FIRST: restore the draft (the editor was
      // cleared before submit) — the error text is best-effort afterwards,
      // so a hostile value can never prevent the user's input from coming
      // back. (The classification diagnostics are owned by runOwned.)
      app.setEditorText(mergeDraft(app.getDraft(), draft))
      const message = safeErrorMessage(error)
      // Image intake/admission/capability failures are THEIR OWN actionable
      // errors ("Current model ... does not support image input") — wrapping
      // them in "could not start a session" misleads when a session already
      // exists (review finding).
      if (error instanceof ImageInputError) {
        app.notify(message, 'error')
        return
      }
      try {
        ctx.logger.error(`tui-runner: session creation failed: ${message}`)
      } catch {
        // The cordis logger must not block the notice.
      }
      app.notify(`could not start a session: ${message}`, 'error')
    }
    /**
     * Restore the submitted text into the editor after a failed submission
     * (review finding: the restore MUST run BEFORE the reservation pin
     * releases — the restored placeholders must keep their backing drafts
     * against concurrent attach-time prunes). Correctness side effect
     * first; never throws.
     */
    /**
     * The COMPOSER-side attachment policy for one parsed line (DSH web
     * parity): returns the refusal text, or undefined when the line may carry
     * the staged attachments.
     * - a TUI/core local command and a client contribution are UI controls —
     *   refused;
     * - an explicit `/skill <name> ...` invocation and a LIVE skill wrapper
     *   are agent-facing — loadSkill delivers them and their attachments to
     *   the model (never classified as a command);
     * - a line the HOST catalog CLAIMS accepts attachments ONLY when the
     *   claiming descriptor declares `input.attachments` (upstream refuses
     *   otherwise before dispatch). The claim is LINE-level: an argued line
     *   of an execute-kind command is no invocation at all (it falls back to
     *   the ordinary submission) and keeps its attachments;
     * - a declared command still refuses a FILE attachment: the host expects
     *   an upload receipt, which this client has no seam to produce (fail
     *   closed rather than silently drop the file).
     * The host executor re-enforces the declaration at admission.
     */
    const attachmentRefusal = (
      parsed: { name: string; rawInput?: string },
      draft: string,
      // Whether THIS LINE is a local command line — the dispatch's ONE
      // classification (`commandIsLocalForAttachments`), computed by the
      // caller because it must be re-readable against the FINAL catalog for a
      // deferred start.
      isLocal: boolean,
      // The ONE skill-invocation predicate (`isSkillInvocation`: an explicit
      // `/skill <name> ...` or a live skill wrapper) — TUI-owned agent-facing
      // input that loadSkill owns. It is supplied rather than re-derived: the
      // predicate applies the argued-`/skill` short-circuit, and WITHOUT it
      // the line would fall into the HOST branch below (`/skill` is itself a
      // registered TUI command) and be refused as a non-declaring command.
      skillInvocation: boolean,
    ): string | undefined => {
      if (!draftHasAttachments(draft, draftImages, draftFiles)) return undefined
      if (skillInvocation) return undefined
      if (!isLocal) {
        const claim = hostClaimOf?.(parsed)
        if (claim?.claimed === true) {
          if (claim.attachments !== true) {
            return `/${parsed.name} does not accept attachments; remove them first`
          }
          if (draftHasFiles(draft, draftImages, draftFiles)) {
            return `/${parsed.name} cannot receive file attachments in this client; remove them first`
          }
        }
        return undefined
      }
      return 'Attachments cannot be included in a local command.'
    }
    /** The encoded images ONE command invocation carries (DSH
     * `CommandSubmitAttachment`): the draft store holds the exact bytes, and
     * the host admits them through its own store at execute time. Only a
     * declared host command reaches this builder — an undeclared command and
     * any file attachment are refused before dispatch. A RECALLED image
     * carries no local bytes (it is already durable): the wire has no
     * ref-based variant, so the host's admission rejects the empty payload
     * and the command settles as an error — the draft and its attachments
     * are kept for correction (never silently dropped). */
    const commandSubmitAttachments = (draft: string) => expandImagePlaceholders(draft, draftImages)
      .flatMap(segment => segment.type === 'image' ? [segment.image] : [])
      .map(image => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: Buffer.from(image.bytes).toString('base64'),
        ...(image.name === undefined ? {} : { name: image.name }),
      }))
    const restoreSubmissionDraft = (draft: string): void => {
      if (lifecycleController.signal.aborted) return
      app.setEditorText(mergeDraft(app.getDraft(), draft))
    }
    // ── Local submit acknowledgement + latency timeline (submit-ack.ts /
    // submit-latency.ts) ── the immediate "Submitting…" / "Queued…" row
    // between the editor clearing and the FIRST authoritative DSH event,
    // and the T0-T5 phase timings for the diag channel. The window is real
    // even without any per-submit persistence check: session create, image
    // admission
    // and the host pre-step all delay `user/message`.
    const localSubmitAck: SubmitAckState = freshSubmitAckState()
    const submitLatencyTracker = new SubmitLatencyTracker({ sink: diag })
    /**
     * Client-local submission echoes (D2.1 follow-up): the presentation-only
     * bridge between the editor clearing and the authoritative inbox/durable
     * occurrence. Keyed by the request id minted before the first async
     * preparation await and persisted on the Direct user-message source as
     * `rpcId`, so the handoff correlates by identity — never by text.
     */
    const pendingSubmissions = new PendingSubmissions()
    /**
     * The client-local presentation source the queue/transcript handoff reads.
     * Production Direct wires the ledger above. D2.2 has NO production Remote
     * backend, so this runner intentionally has no substitution point; the
     * experimental Remote assembly (tests/smoke) composes
     * `RemoteSubmissionPresentation` directly. A complete Remote backend (M3)
     * is what would inject the official `SessionSnapshot.pendingSubmissions`
     * source here instead of running two optimistic identities (D2.2 §21/§22).
     */
    const submissionPresentation: SubmissionPresentationSource = new DirectSubmissionPresentation(pendingSubmissions)
    /** The official `beginSubmission` placement for one local echo. */
    const submissionPlacement = (mode: 'queue' | 'steer', running: boolean): PendingSubmissionPlacement =>
      running ? (mode === 'steer' ? 'steering' : 'queued') : 'transcript'
    /**
     * Accept one submission: show the pending row NOW (Submit/Queued by
     * the agent's live status) and start the latency timeline. Returns
     * the gesture's EPOCH TOKEN: the enclosing workflow's terminal exits
     * (failure / stale / fence / cancel / command routing) must settle
     * with THIS token — the settle is ignored once a newer gesture has
     * superseded it, so an older submission dying late can never clear
     * the newer row (or reset its latency timeline).
     */
    const acceptLocalSubmitAck = (): number => {
      const detail: SubmitPendingDetail = agentNow()?.status === 'running' ? 'queued' : 'submit'
      const token = acceptSubmitAck(localSubmitAck, { detail, now: Date.now() })
      submitLatencyTracker.accept(agentNow()?.session.id)
      app.setSubmitPending(detail)
      return token
     }
    /**
     * Settle the pending row: clears it when something is pending and
     * records the wait duration at debug level. Called from the
     * authoritative event branches, the failure sinks and the refusal
     * paths — idempotent everywhere.
     *
     * - TOKEN settles (`{ token }`): a submission's OWN terminal exit
     *   (failure / stale / fence / cancel / no-agent / command routing).
     *   Ignored when a newer gesture superseded the token — an older
     *   submission dying late must never clear the newer row nor reset
     *   its latency timeline.
     * - TOKENLESS settles: authoritative session events (coalescing) and
     *   the session-switch commit (the old row dies unconditionally).
     *
     * `terminal: true` additionally RESETS the latency timeline: a dead
     * submission's baseline must not be populated by unrelated later
     * events; the next real submission arms a fresh T0.
     */
    const settleLocalSubmitAck = (reason: string, options: { token?: number; terminal?: boolean } = {}): void => {
      if (cleanedUp) return
      if (options.token !== undefined && options.token !== localSubmitAck.epoch) {
        diag.debug('submit ack terminal settle superseded', { reason, token: options.token, current: localSubmitAck.epoch })
        return
      }
      const elapsed = settleSubmitAck(localSubmitAck, { now: Date.now() })
      if (options.terminal === true) submitLatencyTracker.reset()
      if (elapsed === undefined) return
      diag.debug('submit ack settled', { reason, elapsed: `${elapsed}ms` })
      app.setSubmitPending(undefined)
    }
    /**
     * Register one local submission echo and publish it immediately, so an
     * accepted submission is never visually silent between the editor clearing
     * and its authoritative occurrence.
     *
     * A RUNNING placement (queued/steering) settles this gesture's generic
     * working-row label: the echo now carries the accepted content, and the
     * generic `Queued…` label would both duplicate the pending row and
     * mislabel a running steer. An IDLE (transcript) placement keeps the
     * generic `Submitting…` bridge — it is the pre-session/first-event
     * feedback and the durable row replaces it.
     */
    const beginLocalSubmission = (
      requestId: string,
      text: string,
      placement: PendingSubmissionPlacement,
      sessionId: string | undefined,
      generation: number,
      ackToken: number,
    ): void => {
      const echo = localEcho(text)
      pendingSubmissions.begin({
        requestId,
        placement,
        text: echo.text,
        foldableText: echo.foldableText,
        createdAt: Date.now(),
        ...(sessionId === undefined ? {} : { sessionId }),
        generation,
      })
      surface.refreshPendingInput()
      if (placement !== 'transcript') settleLocalSubmitAck('local pending echo', { token: ackToken })
    }
    /** Remove one local submission echo on a known terminal exit. */
    const settleLocalSubmission = (requestId: string | undefined): void => {
      if (requestId === undefined) return
      pendingSubmissions.settle(requestId)
      surface.refreshPendingInput()
    }
    /**
     * Notify one submission failure WITHOUT restoring (the task's catch
     * already restored; restoring twice would re-merge the draft). Image
     * intake/admission/capability failures are THEIR OWN actionable errors
     * ("Current model ... does not support image input") — wrapping them in
     * "could not start a session" misleads when a session already exists.
     * Diagnostics are owned by runOwned.
     */
    const notifySubmissionFailure = (error: unknown): void => {
      if (lifecycleController.signal.aborted) return
      // NOTE: the pending submit ack is settled by the CALLER with its own
      // gesture token (an untokenized settle here would let one
      // workflow's failure clear a newer gesture's row).
      const message = safeErrorMessage(error)
      if (error instanceof ImageInputError) {
        app.notify(message, 'error')
        return
      }
      try {
        ctx.logger.error(`tui-runner: submission failed: ${message}`)
      } catch {
        // The cordis logger must not block the notice.
      }
      // A followup/steer against an EXISTING session is not a session
      // creation failure — "could not start a session" would mislead
      // (review finding).
      const prefix = agentNow() === undefined ? 'could not start a session' : 'submission failed'
      app.notify(`${prefix}: ${message}`, 'error')
    }
    /** The image submission surface (plan §13): the live attachment/llm
     * services + the CURRENT provider/model, re-read at submit time (the
     * TUI supports runtime model switching — never a startup snapshot). */
    const submitDeps: PrepareInputDeps = {
      attachments: ctx.get('attachments') as PrepareInputDeps['attachments'],
      get fileStore() { return draftFiles },
      signal,
      llm: ctx.get('llm') as PrepareInputDeps['llm'],
      // Send-time `@`-file canonicalization through the Host-file port
      // (migration M1.10): the live session's workspace is the scope.
      canonicalizeMentions: (text) => backend.hostFile.canonicalizeMentions({ kind: 'session', sessionId: agentNow()?.session.id ?? '' }, text),
      sessionCwd: () => status.sessionCwd(),
      currentModel: () => {
        // The AUTHORITATIVE model for the next step is the mutable
        // selection's `current` (/model writes it; prompt assembly reads
        // it) — never `agentNow().options`, which holds the agent's launch
        // configuration and does not move on /model (review finding 1).
        const current = model.selected.current
        if (current !== undefined) return { provider: current.provider, model: current.model }
        // No selection assembled yet (pre-/model or a sessionless start):
        // fall back to the agent's launch options as the best known pair.
        const agent = agentNow()
        if (agent === undefined) return undefined
        // (Renamed local: `model` is the model-selection owner in this scope.)
        const { provider, model: launchModel } = agent.options
        return provider === undefined || launchModel === undefined ? undefined : { provider, model: launchModel }
      },
    }
    // ── Pre-Stage-D export convergence: the post-command-success artifact
    // save workflows. The save NEVER starts inside the command handler —
    // it starts here, after `commands.execute()` resolved (command/done
    // durable), from the CAPTURED originating Agent/Session identity (never
    // a later `liveAgent` read). The Client-local Save Location prompt, the
    // fixed filename, the collision handling and the local sink are shared
    // by /export (archive) and /transcript (Markdown).
    const artifactInFlight = new Set<string>()
    /** A user-facing artifact failure with a STABLE message (never a raw
     * Host path from an upstream exception). */
    class ArtifactSaveFailure extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'ArtifactSaveFailure'
      }
    }
    /** The Client-local directory completion source (the shared engine). */
    const localFileSource = new LocalFileSource()
    /** One artifact save workflow outcome. */
    type ArtifactSaveOutcome =
      | { readonly kind: 'saved'; readonly path: string }
      | { readonly kind: 'cancelled' }
    const saveArtifact = async (
      name: 'export' | 'transcript',
      agent: Agent,
    ): Promise<ArtifactSaveOutcome> => {
      const sessionId = agent.session.id
      const filename = sessionArtifactFilename(sessionId, name === 'export' ? 'archive' : 'transcript')
      let result: SaveLocationResult
      try {
        result = await app.askSaveLocation({
          title: name === 'export' ? 'Save session archive' : 'Save readable transcript',
          filename,
          initialDirectory: './',
        }, {
          // Save Location is CLIENT-local filesystem UI: resolution, validation
          // and completion all run against the Client process cwd — never the
          // Host/session cwd, and never a Host call.
          resolveDirectory: (input) => resolveClientDirectory(input, cwd),
          isDirectory: (path) => isDirectoryPath(path),
          targetExists: (directory, filename) => {
            try {
              // lstatSync: a dangling symlink is a real directory entry and
              // must surface the collision confirmation too (the sink's
              // commit guard uses the same non-following check).
              lstatSync(join(directory, filename))
              return true
            } catch {
              return false
            }
          },
          complete: (raw, completionSignal) => completeDirectory(raw, cwd, localFileSource, completionSignal),
        }, signal)
      } catch (error) {
        // A REFUSAL (a duplicate prompt, or an active Host question/approval)
        // is a real user-visible failure — never a silent cancellation: the
        // runOwned onCancel path emits no notice, so a second concurrent
        // artifact save would silently disappear. The signal-abort path stays
        // a cancellation (the task-local predicate classifies it).
        if (isCancellation(error) && !signal.aborted) {
          throw new ArtifactSaveFailure(safeErrorMessage(error))
        }
        throw error
      }
      if (cleanedUp) return { kind: 'cancelled' }
      if (result.kind === 'cancelled') return { kind: 'cancelled' }
      const target = join(result.directory, filename)
      if (name === 'export') {
        const opened = await backend.sessionArchive.open(sessionId, signal)
        if (cleanedUp) return { kind: 'cancelled' }
        if (opened.kind === 'unavailable') throw new ArtifactSaveFailure('Session archive export is unavailable.')
        if (opened.kind === 'none') throw new ArtifactSaveFailure('Session was not found.')
        const path = await streamToFile(target, opened.artifact.stream, signal, result.overwrite)
        if (cleanedUp) return { kind: 'cancelled' }
        return { kind: 'saved', path }
      }
      // /transcript: render from the CAPTURED originating Session after the
      // command lifecycle settled — never `liveAgent` at delayed settle time.
      if (cleanedUp) return { kind: 'cancelled' }
      const markdown = renderTranscriptMarkdown(agent.session)
      const path = await writeTextAtomically(target, markdown, signal, result.overwrite)
      if (cleanedUp) return { kind: 'cancelled' }
      return { kind: 'saved', path }
    }
    const startArtifactSave = (name: 'export' | 'transcript', agent: Agent): void => {
      if (cleanedUp) return
      const sessionId = agent.session.id
      const key = `${name}:${sessionId}`
      // A narrow Client-local in-flight key: two simultaneous writes for the
      // same logical artifact/session must never race the fixed filename.
      if (artifactInFlight.has(key)) {
        app.notify('this artifact is already being saved', 'error')
        return
      }
      artifactInFlight.add(key)
      runOwned(`artifact save: ${name}`, () => saveArtifact(name, agent).finally(() => {
        artifactInFlight.delete(key)
      }), {
        diag,
        sessionId: () => sessionId,
        isCancellation: () => signal.aborted,
        onResult: (outcome) => {
          if (cleanedUp) return
          if (outcome.kind === 'saved') app.notify(`saved to ${outcome.path}`, 'info')
        },
        onError: (error) => {
          if (cleanedUp) return
          // The detailed diagnostic (including any Host path inside an
          // upstream exception) stays in the runOwned diag path; the user
          // sees a stable artifact-level message.
          const message = error instanceof ArtifactSaveFailure
            ? error.message
            : (name === 'export' ? 'session archive export failed' : 'transcript export failed')
          app.notify(message, 'error')
        },
        onCancel: () => {
          // A cancelled save (surface dispose / runner abort) needs no
          // user notice; the temp cleanup is owned by the sink.
        },
      })
    }
    // Every accepted user submission takes one FIFO turn before async
    // preparation. The turn is released only after its semantic write settles,
    // so a later gesture cannot overtake an earlier canonicalization.
    let submitSerialTail: Promise<void> = Promise.resolve()
    const takeSubmitTurn = (): { wait: Promise<void>; release: () => void } => {
      const wait = submitSerialTail
      let releaseTail!: () => void
      const turn = new Promise<void>(resolve => { releaseTail = resolve })
      submitSerialTail = turn
      let released = false
      return {
        wait,
        release: () => {
          if (released) return
          released = true
          releaseTail()
        },
      }
    }
    /** The session-backed dispatch: create the session lazily (the first
     * user input is the deferred trigger), then execute a registered slash
     * command or follow up.
     * @param delivery - the delivery mode the submit boundary resolved for
     *   this submission; bound for the command execution so a TUI-owned
     *   skill handler accepts it instead of re-deriving it. */
    const dispatchViaSession = (text: string, persistHistory: (sessionId: string | undefined) => void, delivery: SubmitDelivery): void => {
      // Admission identity is captured synchronously, before this gesture
      // waits behind an earlier submit. A later session must never inherit
      // an old submission merely because the FIFO turn became available.
      const submittedAgent = agentNow()
      const submittedGeneration = ownership.generation()
      const submittedSubject = ownership.captureSubject()
      let submitTurnTransferred = false
      // Local submit acknowledgement (plan D): the row appears NOW —
      // before any session create / admission / command work — because
      // this gesture owns no user-visible feedback until the first
      // authoritative event lands. The TOKEN arms every terminal exit of
      // THIS workflow: a newer gesture supersedes them.
      const submitAckToken = acceptLocalSubmitAck()
      // The local submission echo's correlation identity, minted BEFORE the
      // first asynchronous preparation/admission await. It is only persisted
      // (as the Direct user-message `source.rpcId`) when this line becomes an
      // ordinary human prompt — never for a Host command that consumes it.
      const submitRequestId = randomUUID()
      const parsedAtSubmit = parseCommand(text)
      // The advertised NAME claim, captured BEFORE any session creation: a
      // refresh may have revoked it since (the completion generation the user
      // saw is the one that promised the command), and a probed command the
      // real session then lacks must be consumed with an explicit error —
      // never a plain model message. It is only consumed for a line the
      // command plane actually OWNS at invocation time (`planeAdvertised`).
      const wasAdvertisedAtSubmit = parsedAtSubmit !== undefined
        && wasAdvertisedClaim?.(parsedAtSubmit.name) === true
      // The host catalog's view of the line at SUBMIT time, captured before any
      // session creation: a line it already knew to be a NON-invocation (an
      // argued line of an execute-kind command) stays one — no later catalog
      // change may turn it into an invocation except the final catalog
      // actually CLAIMING it.
      const submitView = parsedAtSubmit === undefined ? undefined : hostClaimOf?.(parsedAtSubmit)
      // Whether this line is an ordinary agent-facing prompt (never a Host
      // command, a TUI-local control, or a skill invocation) at submit time.
      // Such a line installs its local echo SYNCHRONOUSLY, before the FIFO
      // turn and any admission await: a second queued submission must not be
      // textually invisible merely because an earlier one is still blocked in
      // canonicalization. A line the FINAL catalog only later claims as a
      // command is consumed through the command paths below, which settle the
      // echo.
      //
      // Skill invocations (`/skill <name> ...` and per-skill wrappers) are
      // EXCLUDED: their delivery is owned by the TUI skill handler, which
      // prepares and writes the message WITHOUT the submit request identity
      // (the correlation contract cannot be completed here), so a local echo
      // would neither dedupe against nor retire on their authoritative
      // occurrence. They keep their existing command feedback.
      const ordinaryPromptAtSubmit = parsedAtSubmit === undefined
        || (submitView?.claimed !== true
          && !LOCAL_COMMANDS.has(parsedAtSubmit.name)
          && isSkillWrapperName?.(parsedAtSubmit.name) !== true)
      // Install the echo NOW for a known ordinary prompt on an existing
      // session — before the FIFO turn and the asynchronous admission. A
      // deferred start installs after the session materializes, below.
      let localEchoInstalled = false
      if (ordinaryPromptAtSubmit && submittedAgent !== undefined && !cleanedUp) {
        beginLocalSubmission(
          submitRequestId,
          text,
          submissionPlacement('queue', submittedAgent.status === 'running'),
          submittedAgent.session.id,
          submittedGeneration,
          submitAckToken,
        )
        localEchoInstalled = true
      }
      // The CLIENT-LOCAL eligibility of the submitted line, captured with the
      // routing decision (before any session creation): only a line whose
      // initial route was a LIVE client contribution keeps the client-local
      // attachment classification under the final authority. A contribution
      // claims the BARE token only (DSH `matchEnter`), and a contribution that
      // appears LATER never turns a generic line into a UI control — this route
      // never runs the new handler anyway, so the line is an ordinary
      // submission.
      const clientLocalAtSubmit = parsedAtSubmit !== undefined
        && isBareCommandLine(parsedAtSubmit)
        && extensionService?.commands.find(parsedAtSubmit.name) !== undefined
      // Whether the command plane OWNS the submitted line, asked against the
      // LIVE catalog at INVOCATION time (after ensureSession: a deferred start
      // commits a session-scoped catalog the standing view could not see, and
      // the descriptor of a resolved name may differ there — in either
      // direction). The plane owns a TUI-owned route (a local command, or a
      // live skill wrapper whose `/name args` line the plane's own handler
      // turns into loadSkill) and every line the FINAL catalog CLAIMS. It does
      // NOT own an argued line of an execute-kind host command: upstream
      // `matchEnter` makes it an ordinary submission, and the host registry
      // resolves by NAME, so asking it would run the command anyway.
      const commandPlaneOwnsLine = (): boolean => {
        if (parsedAtSubmit === undefined) return true
        if (LOCAL_COMMANDS.has(parsedAtSubmit.name)) return true
        if (isSkillWrapperName?.(parsedAtSubmit.name) === true) return true
        const finalView = hostClaimOf?.(parsedAtSubmit)
        // A resolved final catalog answers for itself (claimed = the plane
        // runs the command; unclaimed = an ordinary submission).
        if (finalView !== undefined) return finalView.claimed
        // The final catalog does not resolve the name at all: the plane decides
        // (a session-scoped command the standing view cannot see) — UNLESS the
        // line was ALREADY a known non-invocation when it was submitted, which
        // no disappearance can turn into an invocation.
        return submitView?.claimed !== false
      }
      // Assigned inside the runOwned factory (invocation-time capture).
      let commandHealthRef: { slot: string; id: string; owner: string } | undefined
      // The health ref is NOT captured here: the submit-time identity can
      // be stale after the async ensureSession phase below (an HMR
      // reload in between means the REAL invocation runs the NEW owner's
      // command). It is re-captured inside the runOwned factory,
      // immediately before execute() — see below (the review's P2).
      // Whether the submission reached the plane AS AN ADVERTISED COMMAND
      // INVOCATION: the submit-time advertised claim AND the plane's final
      // ownership of the line (resolved in the factory below). The
      // advertised-miss gate may consume only a line the plane actually
      // owned — an argued line of an execute-kind command is an ordinary
      // submission even when its name was advertised.
      let planeAdvertised = false
      // An owned workflow: the chain's outcome drives the editor draft, the
      // notices and the queue — runOwned (AGENTS.md), never a bare void.
      // Reserve the referenced drafts SYNCHRONOUSLY, in the SAME call stack
      // that left the editor (review finding): sessionRuntime.ensureSession() on a
      // deferred start is async (create/compose/resume), and the editor is
      // already cleared — an attach-time prune during session creation must
      // not delete the images this submission is about to admit. No await
      // may precede the reservation.
      // The submit-flow core owns the ordering contract (reserve →
      // run → failure-restore-before-release → release), shared with the
      // integration tests — never hand-rolled per path.
      // The FIFO turn is taken HERE, after every synchronous admission step. A
      // throw before this point must not strand the tail (no turn was taken),
      // and no other submission can interleave during the synchronous setup
      // above, so the ordering contract is unchanged.
      const submitTurn = takeSubmitTurn()
      runOwned('submit', () => runReservedSubmit({
        reserve: (t) => {
          try {
            const releasePin = pinDraftAttachments(t, draftImages, draftFiles)
            return () => {
              try {
                releasePin()
              } finally {
                if (!submitTurnTransferred) submitTurn.release()
              }
            }
          } catch (error) {
            submitTurn.release()
            throw error
          }
        },
        run: async () => {
          await submitTurn.wait
          if (cleanedUp) return
          // The deferred-start gate (history-persist.ts): the history row
          // is written AFTER the session exists, with the FINAL session
          // id — the first prompt of a deferred start creates the session
          // inside resolveSession, and a row written before creation would
          // carry no sessionId and vanish from the Ctrl+R `Current
          // session` scope. A resolution that REJECTS (session creation
          // failed) persists nothing — the submission never reached a
          // session; a resolution that resolves undefined (sessionless)
          // persists a row without a sessionId.
          await persistAfterSession(
            async () => {
              if (submittedAgent !== undefined && !captureMatches(submittedSubject)) return undefined
              await sessionRuntime.ensureSession()
              if (cleanedUp) return undefined
              return agentNow()?.session.id
            },
            (sessionId) => {
              if (cleanedUp) return
              if (submittedAgent !== undefined && !captureMatches(submittedSubject)) return
              persistHistory(sessionId)
            },
          )
          if (cleanedUp) return
          const agent = agentNow()
          if (agent === undefined) {
            // Nothing can be written (degraded resolve after a successful
            // creation): the wait ends here with NO write — the pending
            // row must not outlive the submission.
            settleLocalSubmission(submitRequestId)
            settleLocalSubmitAck('submit resolved without an agent', { token: submitAckToken, terminal: true })
            return
          }
          if (submittedAgent !== undefined && !captureMatches(submittedSubject)) {
            const merged = mergeDraft(app.getDraft(), text)
            app.setEditorText(merged)
            settleLocalSubmission(submitRequestId)
            settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
            app.notify(merged === text
              ? 'the session changed while waiting for submission — try again'
              : 'the draft changed while waiting for submission — review it before submitting again (the earlier text was preserved below)', 'error')
            return
          }
        // Capture THIS agent's session identity so the write below can
        // never target a session a switch already left behind (the async
        // admission below yields). ONE atomic scope capture: the same record
        // fences the write and admits it through `SessionRuntime.withWriter`.
        const generation = ownership.generation()
        const scope = sessionScope.captureLive()
        if (scope === undefined) throw new Error('a resolved live submission must carry a live session scope')
        // TOCTOU re-validation: the session must still be the exact one the
        // identity was captured from, or the submission is aborted for a
        // retry against the new session.
        if (!sessionScope.isCurrent(scope)) {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          settleLocalSubmission(submitRequestId)
          settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
          app.notify(merged === text
            ? 'the session changed while sending — try again'
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
        // From here on the CAPTURED agent is used — never the mutable
        // agentNow(): writing through a re-read closure variable could
        // target a session the identity check did not see (a switch
        // between the check and the write).
        const commands = ctx.get('commands')
        if (commands !== undefined) {
          // Bare `/plan` toggles: when plan mode is already active it exits
          // instead of re-entering (the official command needs `/plan off`).
          const parsed = parseCommand(text)
          const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
            && projectedPlanActive(ctx.get('sessionProjections') as PlanProjectionLike | undefined, agent.session) === true
            ? '/plan off'
            : text
          // The HostCommandPort submission + the agent-facing fallback live in
          // the submission runtime; the runner supplies the command-plane and
          // TUI hooks.
          executeHostCommandSubmission({
            isDisposed: () => cleanedUp,
            notify: (message, kind) => {
              if (cleanedUp) return
              app.notify(message, kind)
            },
            loggerError: (message) => {
              try {
                ctx.logger.error(message)
              } catch {
                // The cordis logger must not block the user notice.
              }
            },
            readDraft: () => app.getDraft(),
            mergeDraftIntoEditor: (value) => {
              const merged = mergeDraft(app.getDraft(), value)
              app.setEditorText(merged)
              return merged === value
            },
            restoreSubmissionDraft: (value) => restoreSubmissionDraft(value),
            consumeDraftAttachments: (value) => consumeDraftAttachments(value, draftImages, draftFiles),
            draftHasAttachments: (value) => draftHasAttachments(value, draftImages, draftFiles),
            pinDraftAttachments: (value) => pinDraftAttachments(value, draftImages, draftFiles),
            settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
            settleSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
            notifySubmissionFailure: (error) => notifySubmissionFailure(error),
            isScopeCurrent: (value) => sessionScope.isCurrent(value),
            refuseByTransitionFence: (value) => refuseByTransitionFence(
              value,
              () => app.getDraft(),
              (t) => app.setEditorText(t),
              (m, k) => app.notify(m, k),
            ),
            // DEFERRED AUTHORITY: re-apply the attachment policy against the
            // FINAL catalog BEFORE the command plane runs.
            lateAttachmentRefusal: () => {
              if (parsed === undefined) return undefined
              return attachmentRefusal(
                parsed,
                text,
                commandIsLocalForAttachments(
                  parsed,
                  isSkillWrapperName,
                  // The dynamic (client contribution) term is STICKY to the
                  // submit-time route.
                  n => clientLocalAtSubmit && (extensionService?.commands.isLocal(n, LOCAL_COMMANDS) ?? false),
                  // STICKY SUBMIT-TIME AUTHORITY: once the host catalog RESOLVED
                  // this name, the name is host territory for the lifetime of the
                  // submission.
                  line => hostClaimOf?.(line) ?? submitView,
                ),
                isSkillInvocation(parsed, text),
              )
            },
            commandSubmitAttachments: (value) => commandSubmitAttachments(value),
            isTuiOwnedCommand: () => parsedAtSubmit !== undefined
              && (LOCAL_COMMANDS.has(parsedAtSubmit.name) || isSkillWrapperName?.(parsedAtSubmit.name) === true),
            commandPlaneOwnsLine,
            submittedHostClaim: () => parsedAtSubmit === undefined ? undefined : hostClaimOf?.(parsedAtSubmit),
            commandSignal: () => signal,
            invokeCommandPlane: ({ toggled: commandLine, commandPlaneLine, tuiOwnedCommand, submittedAttachments, signal: commandSignal }) =>
              withCommandDelivery(delivery, () => {
                if (!commandPlaneLine || parsedAtSubmit === undefined) {
                  return Promise.resolve({ kind: 'committed', matched: false } as HostCommandOutcome)
                }
                if (tuiOwnedCommand) {
                  // TUI-local commands and skill wrappers retain their existing
                  // in-process command service path; HostCommandPort is only
                  // for a line already selected as Host-owned.
                  return commands.execute(agent as Agent, commandLine, submittedAttachments as Parameters<typeof commands.execute>[2], commandSignal).then(execution => {
                    return execution === undefined
                      ? { kind: 'committed', matched: false } as const
                      : { kind: 'committed', matched: true, execution } as const
                  })
                }
                // The HostCommandPort submission enters the barrier through
                // the submission runtime (the M3 insertion point).
                return submissionRuntime.withWriter(scope, () => backend.hostCommand.execute({
                  sessionId: agent.session.id,
                  line: commandLine,
                  attachments: submittedAttachments,
                  signal: commandSignal,
                }))
              }),
            beginCommandSettlement: () => sessionRuntime.beginCommandSettlement(),
            abortCommandSettlement: () => sessionRuntime.abortCommandSettlement(),
            settleCommandSettlement: () => sessionRuntime.settleCommandSettlement(),
            trackSettlementWork: (work) => sessionRuntime.trackSettlementWork(work),
            captureCommandHealthRef: () => {
              // RE-CAPTURE at invocation time: the runOwned factory runs
              // SYNCHRONOUSLY right before execute().
              const liveCommandId = parsedAtSubmit === undefined || extensionService === undefined
                ? undefined
                : extensionService.commands.idFor(parsedAtSubmit.name)
              return liveCommandId === undefined
                ? undefined
                : extensionService?._recordRegistryHealthRef('command', liveCommandId)
            },
            clearCommandHealthError: (ref) =>
              extensionService?._clearRegistryError(ref as { slot: string; id: string; owner: string }),
            recordCommandHealthError: (ref, error) =>
              extensionService?._recordRegistryError(ref as { slot: string; id: string; owner: string }, error),
            readCommandDraftDisposition: (commandId) => takeCommandDraftDisposition?.(commandId),
            shouldConsumeAdvertisedMiss,
            isIndeterminateSkillWrite: (error) => isIndeterminateSkillWrite(error),
            startArtifactSave: (name) => startArtifactSave(name, agent),
            submitPrompt: (submission) => submissionRuntime.submitPrompt(submission),
            commandSessionId: () => agent.session.id,
            markTurnTransferred: () => { submitTurnTransferred = true },
            diag,
          }, {
            text,
            toggled,
            scope,
            submitRequestId,
            submitAckToken,
            generation,
            localEchoInstalled,
            wasAdvertisedAtSubmit,
            parsedName: parsedAtSubmit?.name,
            submitTurn,
          })
          return
        }
        // No commands service: direct follow-up on the CAPTURED agent (see
        // the note above — never a re-read closure variable). Images ride
        // the same prepared message as every other path (§13). The submission
        // runtime owns the ordered writer admission (transition drain +
        // per-Agent image window) and its terminal ack/echo settlement.
        await submissionRuntime.submitPrompt({
          text,
          scope,
          requestId: submitRequestId,
          ackToken: submitAckToken,
          generation,
          echoInstalled: localEchoInstalled,
        })
        },
        restore: (t) => restoreSubmissionDraft(t),
      }, text), {
        diag,
        sessionId: () => agentNow()?.session.id,
        // The flow restored the editor; this sink settles the gesture's
        // ack (token-scoped) and only notifies.
        onError: (error) => {
          settleLocalSubmission(submitRequestId)
          settleLocalSubmitAck('failure', { token: submitAckToken, terminal: true })
          notifySubmissionFailure(error)
        },
        // runOwned routes cancellations EXCLUSIVELY to onCancel: a
        // cancelled deferred create / image admission / barrier write
        // bypasses onError, so the ack row armed at the gesture must be
        // terminated HERE (the flow already restored the draft — plan D
        // exit enumeration).
        onCancel: () => {
          settleLocalSubmission(submitRequestId)
          settleLocalSubmitAck('submit cancelled', { token: submitAckToken, terminal: true })
        },
      })
    }
    /**
     * Run a LOCAL slash command in-process, with or without a live session.
     * The route is chosen by the caller: a sessionless command (no session
     * is created, its history row stays sessionless — Current directory /
     * All directories, never Current session) or a plugin-declared local
     * command whose contribution owns a bridge handler (it runs locally even
     * inside a live session, and its row follows the command's OWN
     * sessionless classification via `historyKind`). The handler comes from
     * the bridge FIRST (rawInput verbatim), then from the commands service's
     * global layer (in-process lookup with no agent is safe: it reads the
     * global layer only). A command with neither falls back to the session
     * dispatch, which reports unknown commands as messages.
     */
    const runLocalCommand = (
      parsed: { name: string; rawInput: string },
      text: string,
      persistHistory: (sessionId: string | undefined) => void,
      delivery: SubmitDelivery,
      // The history identity of THIS call site: a sessionless command writes
      // an unscoped row (Current directory / All directories), while a local
      // command submitted inside a live session scopes its row to that
      // session like every other local command (/status).
      historyKind: 'agent-facing' | 'sessionless',
    ): void => {
      // M5: a plugin-declared local command with a bridge handler routes
      // to the bridge FIRST (its rawInput is passed verbatim — never
      // re-parsed or rewritten, the skill rawInput regression gate); the
      // commands service is the fallback for core commands.
      const bridgeHandler = extensionService?.commands.handlerFor(parsed.name)
      const bridgeCommandId = extensionService?.commands.idFor(parsed.name)
      // Captured at INVOCATION START (same generation fence as the
      // session command path).
      const bridgeCommandRef = bridgeCommandId === undefined || extensionService === undefined
        ? undefined
        : extensionService._recordRegistryHealthRef('command', bridgeCommandId)
      const commands = ctx.get('commands')
      const definition = commands?.find(undefined as unknown as Agent, parsed.name)
      if (bridgeHandler === undefined && (commands === undefined || definition === undefined)) {
        // The "sessionless" command is actually unknown: it falls back to
        // a session dispatch — the history row goes through the
        // deferred-start gate (persist AFTER the session exists, with the
        // final session id), never a sessionless write here.
        dispatchViaSession(text, persistHistory, delivery)
        return
      }
      const invocation = {
        commandId: `cmd-local-${randomUUID()}`,
        agent: undefined as unknown as Agent,
        rawInput: parsed.rawInput,
        signal,
      } as CommandInvocation
      const handler = bridgeHandler ?? definition?.handler
      if (handler === undefined) {
        dispatchViaSession(text, persistHistory, delivery)
        return
      }
      // A truly local command: the handler runs in-process, so no session is
      // needed for the EXECUTION. The row follows the call site's identity
      // (sessionless commands write an unscoped row; a local command inside
      // a live session carries that session id).
      persistHistory(historySessionIdFor(historyKind, agentNow()?.session.id))
      // An owned workflow: the result decides the notify, the failure lands
      // in diagnostics — runOwned (AGENTS.md), never a bare void. The
      // handler may be a SYNC implementation, so the factory must run inside
      // runOwned (a sync throw would otherwise escape before the entry).
      runOwned('local command', () => handler(invocation), {
        diag,
        sessionId: () => agentNow()?.session.id,
        onResult: (result) => {
          if (cleanedUp) return
          if (result !== undefined && result.kind === 'error') {
            if (bridgeCommandRef !== undefined) extensionService?._recordRegistryError(bridgeCommandRef, new Error(result.text))
            app.notify(result.text)
          } else if (bridgeCommandRef !== undefined) {
            extensionService?._clearRegistryError(bridgeCommandRef)
          }
        },
        onError: (error) => {
          if (cleanedUp) return
          if (bridgeCommandRef !== undefined) extensionService?._recordRegistryError(bridgeCommandRef, error)
          const message = safeErrorMessage(error)
          try {
            ctx.logger.error(`tui-runner: local command failed: ${message}`)
          } catch {
            // The cordis logger must not block the user notice.
          }
          app.notify(message, 'error')
        },
      })
    }
    /**
     * Steer into the running turn with re-validation. Shared by
     * Ctrl+S's empty-draft queue sweep and the separate draft prompt, and the
     * busy-Enter preference — Enter while the agent is running with
     * busyEnter=steer steers the DRAFT ONLY (web busyEnter parity): explicitly
     * queued messages stay queued until an empty-draft Ctrl+S sweep, because
     * already-steered input cannot be pulled back.
     * @param text - the submitted draft ('' allowed for Ctrl+S).
     * @param onlyDraft - busy-Enter mode: never read or remove the queue.
     * @param persistHistory - the call site's persist closure (with its
     * submission-time snapshot). Invoked AFTER the session exists with the
     * FINAL session id — the deferred-start gate: Ctrl+S on a deferred
     * start creates the session inside this flow, and a row written
     * before creation would carry no sessionId and vanish from the Ctrl+R
     * `Current session` scope. Absent, the steer persists nothing.
     */
    // Preparation is asynchronous (mention canonicalization can await), so
    // admission must take the shared FIFO turn rather than letting a later
    // gesture deliver first.
    const steerNow = (text: string, onlyDraft = false, persistHistory?: (sessionId: string | undefined) => void): void => {
      // The submission runtime owns the gesture's pre-flight gate, FIFO turn,
      // deferred-start persist, admission window and terminal ack/echo/consume
      // settlement; the runner supplies the narrow TUI hooks.
      const deps: SteerSubmissionDeps = {
        isDisposed: () => cleanedUp,
        isViewing: () => viewer.isViewing(),
        currentAgent: () => agentNow() as unknown as SteerSubmissionAgent | undefined,
        currentGeneration: () => ownership.generation(),
        captureOwnerToken: () => ownership.captureSubject(),
        isOwnerTokenCurrent: (token) => captureMatches(token as SessionSubject | undefined),
        readPendingInput: (sessionId) => backend.pendingInputReader.snapshot(sessionId),
        draftHasAttachments: (value) => draftHasAttachments(value, draftImages, draftFiles),
        draftHasImages: (value) => draftHasImages(value, draftImages),
        clearSettledLocalMessages: () => app.clearSettledLocalMessages(),
        mergeDraftIntoEditor: (value) => {
          const merged = mergeDraft(app.getDraft(), value)
          app.setEditorText(merged)
          return merged === value
        },
        notify: (message, kind) => {
          if (cleanedUp) return
          app.notify(message, kind)
        },
        acceptSubmitAck: () => acceptLocalSubmitAck(),
        settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
        settleSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
        beginLocalSteerEcho: ({ requestId, text: echoText, running, sessionId, generation, ackToken }) => {
          beginLocalSubmission(
            requestId,
            echoText,
            submissionPlacement(running ? 'steer' : 'queue', running),
            sessionId,
            generation,
            ackToken,
          )
        },
        takeSubmitTurn,
        pinDraftAttachments: (value) => pinDraftAttachments(value, draftImages, draftFiles),
        persistAfterSession,
        ensureSession: () => sessionRuntime.ensureSession(),
        withPromptAdmission: (agent, hasImages, task) =>
          directRuntime.withPromptAdmission(agent as unknown as Agent, hasImages, task),
        prepareMessage: (value, requestId) => prepareUserMessage(value, draftImages, submitDeps, { requestId }),
        markDispatch: (sessionId) => submitLatencyTracker.mark(sessionId, 'dispatch'),
        restoreSubmissionDraft: (value) => restoreSubmissionDraft(value),
        notifySubmissionFailure: (error) => notifySubmissionFailure(error),
        consumeDraftAttachments: (value) => consumeDraftAttachments(value, draftImages, draftFiles),
        writerSection: submissionWriterSection,
        pendingInputReader: backend.pendingInputReader,
        writer: backend.sessionWriter,
        diag,
      }
      if (onlyDraft) deliverBusy(deps, { text, persistHistory })
      else steer(deps, { text, persistHistory })
    }
    /**
     * Build the steer-persist closure for a draft (Ctrl+S, the
     * steer-draft extension action, busy-Enter steer): the submission-time
     * facts — the ts (the row must record the USER's steer time, not the
     * post-creation write time) and the image check (the editor is
     * cleared right after and the steer flow consumes the staged images
     * on success, so a late check would wrongly persist the placeholder
     * text) — are snapshotted NOW. The returned closure writes the row
     * under the session id the steer gate resolved (the FINAL id after
     * session creation on a deferred start). An empty draft (Ctrl+S with
     * only a queue) persists nothing — the queued messages were already
     * persisted when originally submitted.
     */
    const makeSteerPersist = (text: string): ((sessionId: string | undefined) => void) => {
      const trimmed = text.trim()
      const historyTs = Date.now()
      const historyHasAttachments = draftHasAttachments(text, draftImages, draftFiles)
      return (sessionId: string | undefined): void => {
        if (trimmed === '' || trimmed === history.lastContent() || historyHasAttachments) return
        const historyCwd = status.sessionCwd()
        const file = historyFilePath(dshHome(process.env), historyCwd)
        runDetached('input history write', () => {
          const written = persistHistoryRecord({
            content: trimmed,
            cwd: historyCwd,
            sessionId: historySessionIdFor('agent-facing', sessionId),
            ts: historyTs,
            lastContent: history.lastContent(),
            hasAttachments: historyHasAttachments,
            file,
          })
          if (written) history.setLastContent(trimmed)
        }, {
          diag,
          notify: (message) => {
              if (cleanedUp) return
              app.notify(message, 'error')
            },
          recoverable: () => true,
        })
      }
    }
    /**
     * Whether one submission is a TUI-owned skill invocation: a LIVE skill
     * wrapper, or the explicit `/skill <name>` form. Skill delivery belongs
     * to loadSkill in BOTH modes — it builds the normalized `/name` line,
     * steers or queues it with the resolved mode, and injects the body
     * whenever the host's dsh-tool-skill pre-step does not (a composition
     * without that loader). A bare steered line would silently skip the
     * skill body, and a missing skill registry is reported there too.
     * @param parsed - the parsed slash command, undefined for a plain prompt.
     * @param text - the submitted line.
     */
    const isSkillInvocation = (parsed: { name: string } | undefined, text: string): boolean =>
      parsed !== undefined && (parsed.name === 'skill'
        ? normalizeSkillInvocation(text) !== undefined
        : isSkillWrapperName?.(parsed.name) === true)
    /**
     * Dispatch one user submission end to end: the viewer guard, the input-
     * history persistence, `!` local shells, sessionless commands, the
     * busy-Enter policy, and the session dispatch. The delivery mode is
     * resolved ONCE below (web ComposerSubmissionPolicy parity — the
     * accelerated chord is the OPPOSITE of the preference, and the explicit
     * queue action is a fixed queue).
     * @param text - the submitted draft.
     * @param request - the request the submission was raised by.
     */
    const dispatchUserInput = (text: string, request: ComposerSubmitRequest = 'enter'): void => {
      // P0 (empty-submission semantics): an EMPTY serialized wire form is
      // a silent no-op — no history write, no session creation, no
      // followup/steer, no attachment admission, no queue mutation. Judged on
      // the wire form ONCE here: the editor onSubmit path already
      // swallowed `''`, but plugin-extension submissions (submitDraft via
      // the semantic action) and any future caller must not bypass it.
      // A bare `!` / `!!` shell mode serializes to a non-empty wire form
      // (handle below at the shell branches), and an attachment-bearing draft
      // is non-empty too (the placeholder markers are part of the text —
      // draftHasAttachments).
      if (text.trim() === '' && !draftHasAttachments(text, draftImages, draftFiles)) return
      // Plain `exit` quits (shell muscle memory): the exact trimmed word
      // intercepts BEFORE any session creation or submission, so typing
      // `exit` with a deferred start never births a session. `/exit` remains
      // the command form; any other prompt still goes to the model.
      if (isPlainExitPrompt(text)) {
        requestExit()
        return
      }
      // The subagent viewer is READ-ONLY: submitting while viewing would
      // silently send to the PARENT session. Refuse with a notice instead.
      if (viewer.isViewing()) {
        app.setEditorText(mergeDraft(app.getDraft(), text))
        app.notify('viewing a subagent — Esc returns before submitting', 'info')
        return
      }
      // A fresh submission dismisses settled local cards (completed `!`/`!!`
      // runs): the card is a live view, not a record — the transcript row
      // (context runs) or the next input takes over. Running cards survive
      // so a live stream is never dismissed by a concurrent submit.
      app.clearSettledLocalMessages()
      // Persist the submitted line to the LIVE session's cwd input-history
      // file (kimi-style JSONL under $DSH_HOME/user-history — never the
      // settings document). Consecutive repeats are skipped like shell
      // history; a failed write is user-recoverable: notify instead of
      // dropping it. `!` shell lines persist verbatim so ↑ recall re-runs
      // the shell branch.
      const trimmed = text.trim()
      // Submission-time facts snapshotted BEFORE any async work: the
      // timestamp (the row must record the USER's submission time, not the
      // disk-write time — an agent-facing write lands after session
      // creation) and the attachment check (an attachment-bearing submission is NOT
      // persisted to the plain-text history: the placeholder dies with its
      // draft on consumeDraftAttachments, so an ↑ recall would re-send the
      // placeholder as ORDINARY TEXT — the attachment would silently vanish
      // from the model input (review finding 3). A late check would miss
      // the already-consumed attachment. Structured attachment history (text +
      // refs, recalled on recall) is a post-v1 extension.)
      const historyTs = Date.now()
      const historyHasAttachments = draftHasAttachments(text, draftImages, draftFiles)
      /**
       * Persist the submitted line under the given session identity. The
       * sessionId is a PARAMETER, resolved at the CALL SITE — the
       * deferred-start gate (history-persist.ts): an agent-facing
       * submission passes the FINAL session id AFTER the session exists
       * (the first prompt of a deferred start creates the session; a row
       * written before creation would carry no sessionId and vanish from
       * the Ctrl+R `Current session` scope). Sessionless submissions pass
       * undefined and stay visible in `Current directory` / `All
       * directories`. The cwd is resolved at PERSIST time so the row
       * lands in the session's cwd file with a `cwd` field that agrees
       * with the file hash.
       */
      const persistHistory = (sessionId: string | undefined): void => {
        const historyCwd = status.sessionCwd()
        const file = historyFilePath(dshHome(process.env), historyCwd)
        runDetached('input history write', () => {
          const written = persistHistoryRecord({
            content: trimmed,
            cwd: historyCwd,
            sessionId,
            ts: historyTs,
            lastContent: history.lastContent(),
            hasAttachments: historyHasAttachments,
            file,
          })
          if (written) history.setLastContent(trimmed)
        }, {
          diag,
          notify: (message) => {
              if (cleanedUp) return
              app.notify(message, 'error')
            },
          recoverable: () => true,
        })
      }
      // `!` runs the command and submits the completed command+output to
      // the session (kimi parity); `!!` runs purely locally with no session
      // write (pi's excluded-from-context escape hatch). A local `!!` needs
      // no session at all; the contextual `!` creates the session first
      // (the FIRST user message is the deferred trigger).
      if (text.startsWith('!')) {
        // A local shell line is a UI control with NO attachment delivery path
        // (`runLocalShell` neither admits nor consumes drafts): a staged
        // attachment must never become shell arguments, and the success path
        // must never consume it. Refuse and hand the draft (placeholder
        // intact) back, exactly like a local command.
        if (draftHasAttachments(text, draftImages, draftFiles)) {
          app.setEditorText(mergeDraft(app.getDraft(), text))
          app.notify('Attachments cannot be included in a local command.', 'error')
          return
        }
        if (text.startsWith('!!')) {
          // `!!` runs purely locally with NO session write (pi's
          // excluded-from-context escape hatch) — the row is sessionless
          // (Current directory / All directories, never Current session).
          persistHistory(historySessionIdFor('sessionless', agentNow()?.session.id))
          runLocalShell(text, undefined)
        } else if (shellCommandOf(text) !== '') {
          // Local submit acknowledgement (plan D), armed AT THE GESTURE —
          // BEFORE ensureSession: a deferred/slow session create is part
          // of the no-feedback window this row exists to cover. The
          // runLocalShell-side accept was moved here so the T0 baseline
          // is never rebased by the shell wiring. The TOKEN rides into
          // the shell flow: its terminal exits settle only while THIS
          // gesture is still the newest one.
          const shellAckToken = acceptLocalSubmitAck()
          // An owned workflow: the session creation failure restores the
          // draft (failSubmission) — runOwned (AGENTS.md), never a bare
          // void. The history row is written AFTER the session exists
          // (the deferred-start gate), so a `!` line that creates the
          // session carries its id.
          runOwned('contextual shell', () => sessionRuntime.ensureSession().then(() => {
            persistHistory(historySessionIdFor('agent-facing', agentNow()?.session.id))
            runLocalShell(text, shellAckToken)
          }), {
            diag,
            sessionId: () => agentNow()?.session.id,
            onError: (error) => {
              // The session create failed: nothing will be written — the
              // ack row armed at the gesture is TERMINAL here (plan D).
              settleLocalSubmitAck('session creation failed', { token: shellAckToken, terminal: true })
              failSubmission(text)(error)
            },
            onCancel: () => {
              if (cleanedUp) return
              // NOT wrapped in runReservedSubmit: nothing restores the
              // draft here, so a cancelled ensureSession would silently
              // lose the submitted text — merge it back first (no error
              // notice: a cancellation is not a failure), then end the
              // ack row terminally.
              app.setEditorText(mergeDraft(app.getDraft(), text))
              settleLocalSubmitAck('contextual shell cancelled', { token: shellAckToken, terminal: true })
            },
          })
        } else {
          // A bare `!` (no command) is a no-op — sessionless.
          persistHistory(historySessionIdFor('sessionless', agentNow()?.session.id))
        }
        return
      }
      // A sessionless slash command runs locally BEFORE any session exists:
      // typing /exit, /settings, /help, ... must not create one (deferred
      // start). Everything else — session-backed commands, core commands
      // like /plan, and plain prompts — creates the session lazily. M5: a
      // plugin-declared sessionless command (CommandBridge) joins the set.
      const parsed = parseCommand(text)
      // The CURRENT host catalog's view of THIS LINE, asked ONCE for the
      // synchronous routing decisions below (the deferred resolution asks
      // again, against the catalog the session committed). A name the
      // catalog RESOLVES is host territory even when it does not claim this
      // line: `/compact extra` is an ordinary submission, never a same-named
      // client contribution's.
      const hostView = parsed === undefined ? undefined : hostClaimOf?.(parsed)
      // Command semantics matrix (plan §19.3): slash commands are not LLM
      // prompts — an image-bearing command line is REJECTED explicitly
      // (never a silent drop, never a stray placeholder sent to the model).
      // The draft comes back so the user can re-attach after choosing a
      // plain prompt. LOCAL commands only: agent-facing invocations —
      // plain prompts AND per-skill slash lines, including `/skill <name>
      // [image #N ...]` (`skill` is local only as the bare picker; with
      // arguments it is a loadSkill agent prompt — review finding).
      // The line's attachment classification against the CURRENT catalog.
      // Every local classification refuses NOW: a contribution claims the BARE
      // token only (DSH `matchEnter`), and a bare line can never reference a
      // draft, so there is no attachment to carry across a deferred window —
      // an argued line of a contribution name is an ordinary submission, with
      // its attachments.
      if (parsed !== undefined) {
        const refusal = attachmentRefusal(
          parsed,
          text,
          commandIsLocalForAttachments(
            parsed,
            isSkillWrapperName,
            n => extensionService?.commands.isLocal(n, LOCAL_COMMANDS) ?? false,
            hostClaimOf,
          ),
          isSkillInvocation(parsed, text),
        )
        if (refusal !== undefined) {
          app.setEditorText(mergeDraft(app.getDraft(), text))
          app.notify(refusal, 'error')
          return
        }
      }
      const isSessionless = parsed !== undefined && SESSIONLESS_COMMANDS.has(parsed.name)
      // The submission's effective delivery mode — resolved ONCE, here at
      // the boundary (web ComposerSubmissionPolicy parity, DSH
      // 0.1.6): an idle agent queues, plain Enter takes the
      // preference, the accelerated chord takes its OPPOSITE, and the
      // explicit queue action always queues. The resolved mode rides into
      // the command plane (dispatchViaSession → withDelivery → the TUI skill
      // delivery), which never re-derives it from the persisted preference —
      // a one-shot gesture does not survive in settings. Commands that own
      // their own busy semantics (Host commands, client commands) ignore it.
      const delivery: SubmitDelivery = request === 'explicit-queue'
        ? 'queue'
        : resolveSubmitDelivery(parsed, agentNow()?.status === 'running', request, tuiSettings?.get().busyEnter)
      // NAMESPACE ORDER (DSH client command contribution parity):
      //   1. host command claim (the closed host catalog always wins);
      //   2. client command contribution (client-owned behavior);
      //   3. TUI-owned sessionless command;
      //   4. agent-facing input (steer / prompt).
      //
      // 1. HOST AUTHORITY: a line the CURRENT effective host catalog CLAIMS
      // is a host command — a client contribution can never shadow it
      // (upstream: candidate synthesis fails loud, never shadows; the host
      // handler decides the busy outcome). The claim belongs to the LINE, not
      // to the name: a `leadingInput` descriptor claims its argued line
      // (`/goal ship`), an execute-kind one claims the bare token only, so
      // `/compact extra` is an ordinary submission (upstream `matchEnter`
      // parity). TUI-owned LOCAL_COMMANDS execute through their own surface
      // and are excluded here; a TUI skill wrapper is agent-facing input
      // (also excluded from the claim). A claimed command the real session
      // then lacks is consumed by the advertised-miss gate inside
      // dispatchViaSession — never a plain model message.
      if (parsed !== undefined
        && !LOCAL_COMMANDS.has(parsed.name)
        && hostView?.claimed === true) {
        dispatchViaSession(text, persistHistory, delivery)
        return
      }
      // 2. CLIENT-OWNED command contribution: its behavior lives entirely on
      // the client, so it executes locally and never steers — the namespace
      // decision is NOT the generic sessionless branch's to make. A
      // contribution is a slash-MENU entry, so it claims the BARE `/name`
      // token only (DSH `matchEnter`: `if (!bare) return undefined`): an argued
      // line (`/deploy explain`) is an ordinary submission, and the handler
      // never runs for it. A name the host catalog RESOLVES is host territory
      // in both states, so a contribution never runs for such a line either.
      // `sessionless` decides whether it may run before a session exists:
      // true runs immediately (no session is created); false (default)
      // resolves/creates the session FIRST — the host command surface is
      // session-keyed — and then runs the handler. A LIVE skill wrapper is
      // TUI-owned agent-facing input and outranks a contribution of the same
      // name (the contribution may have been registered before the skill
      // catalog loaded).
      const contribution = parsed === undefined
        || !isBareCommandLine(parsed)
        || isSkillWrapperName?.(parsed.name) === true
        // A name the host catalog RESOLVES is host territory even when it does
        // not claim THIS line: the line is an ordinary submission, so a
        // same-named contribution — reachable only in the failed-source
        // collision state — never runs for it.
        || hostView !== undefined
        ? undefined
        : extensionService?.commands.find(parsed.name)
      if (parsed !== undefined && contribution !== undefined) {
        if (contribution.sessionless) {
          runLocalCommand(parsed, text, persistHistory, delivery, 'sessionless')
          return
        }
        if (agentNow() !== undefined) {
          runLocalCommand(parsed, text, persistHistory, delivery, 'agent-facing')
          return
        }
        // The captured contribution is a PROVISIONAL authority: it is bound
        // here so the post-await resolution can never run a generation the
        // user did not submit (see the fence inside).
        const submitted = contribution
        runOwned('client command session', () => runReservedSubmit({
          // The submit-flow core's ordering contract. A contribution is only
          // ever invoked by its BARE token, so the line references no drafts
          // and this reservation pins nothing — it stays because the failure
          // path (restore the draft when the session cannot be created) is the
          // shared one. No await may precede it.
          reserve: (draft) => pinDraftAttachments(draft, draftImages, draftFiles),
          run: async () => {
            await sessionRuntime.ensureSession()
            if (cleanedUp || agentNow() === undefined) return
            // AUTHORITY RE-CHECK after the session exists: the deferred start
            // commits a session whose scoped catalog the standing view could
            // not see, and the skill catalog may load with it. A live HOST
            // claim FOR THIS LINE or a TUI skill wrapper outranks the
            // contribution that was decided before the session existed. (A host
            // name can only CLAIM this bare line: the argued lines a catalog
            // resolves without claiming are ordinary submissions and never
            // reach this branch.) The delivery resolved before the session
            // existed, so it is a queue-mode submission: `dispatchViaSession`
            // delivers the line itself.
            if (hostClaimOf?.(parsed) !== undefined || isSkillWrapperName?.(parsed.name) === true) {
              dispatchViaSession(text, persistHistory, delivery)
              return
            }
            // IDENTITY + GENERATION FENCE: the client handler runs only while
            // the EXACT registration the user submitted is still live. A
            // dispose + reload (HMR) is a NEW bridge record — possibly under
            // the same owner/id — and a vanished name must never fall through
            // `runLocalCommand`'s name-only lookup (which would either run
            // the new generation's handler or deliver the line to the MODEL).
            if (extensionService?.commands.find(parsed.name) !== submitted) {
              app.notify(`/${parsed.name} is no longer available — the draft was restored, submit it again`, 'error')
              restoreSubmissionDraft(text)
              return
            }
            runLocalCommand(parsed, text, persistHistory, delivery, 'agent-facing')
          },
          restore: (draft) => restoreSubmissionDraft(draft),
        }, text), {
          diag,
          sessionId: () => agentNow()?.session.id,
          onError: (error) => {
            if (cleanedUp) return
            // The flow restored the editor BEFORE the reservation released;
            // this sink only notifies (never a second restore).
            app.notify(safeErrorMessage(error), 'error')
          },
        })
        return
      }
      // 3. A recognized TUI-owned sessionless command: its history row is
      // sessionless — it must NEVER appear in Current session, whether or not
      // a session exists. Without a live agent it runs locally (and creates
      // none); with a live agent it dispatches through the session's command
      // service, but the persist closure still supplies undefined.
      if (parsed !== undefined && isSessionless) {
        if (agentNow() === undefined) {
          runLocalCommand(parsed, text, persistHistory, delivery, 'sessionless')
        } else {
          dispatchViaSession(text, () => persistHistory(historySessionIdFor('sessionless', agentNow()?.session.id)), delivery)
        }
        return
      }
      // Busy-Enter policy (web parity): agent-facing input steers into the
      // running turn under the resolved 'steer' mode — plain prompts AND
      // non-local commands. The per-skill slash commands steer as the
      // `/name` line the host's pre-step listener (dsh-tool-skill)
      // recognizes — exactly like the web's `session.prompt`, which has no
      // command-execution wire for skills. TUI-owned LOCAL commands
      // (/status, /settings, ...) always execute directly; plugin-declared
      // local commands (M5 CommandBridge) join the same set; `!` shells and
      // sessionless commands returned before this gate.
      if (delivery === 'steer') {
        // Skill delivery belongs to loadSkill in BOTH modes: it builds the
        // NORMALIZED `/<name> <args>` line (the harness gesture recognizes
        // the skill's own slash name — the raw `/skill <name>` form would
        // never match, review finding 2), steers it with this delivery, and
        // injects the body when the host's pre-step listener does not.
        // Image placeholders ride the line untouched; the history row is
        // written by the dispatch AFTER the session exists (the
        // deferred-start gate), with the FINAL session id.
        if (isSkillInvocation(parsed, text)) {
          dispatchViaSession(text, persistHistory, delivery)
          return
        }
        steerNow(text, true, persistHistory)
        return
      }
      dispatchViaSession(text, persistHistory, delivery)
    }
    // M3 runner wiring (F-1): when the extension host service is mounted,
    // the TUI surface attaches a SurfaceHost over its ledger — extensions
    // (including the first-party builtins) render into the chrome. Without
    // the service the surface runs exactly as before (host fallbacks). A4-5:
    // the host and its generation-leased theme-unload hook are surface-owned;
    // the runner only resolves the service (it never becomes a service
    // locator inside `app/surface`).
    extensionService = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof extensionService
    if (extensionService !== undefined) surface.attachExtensionHost(extensionService)
    /** The clipboard bridge (plan M3): a bounded execFile runner with a
     * generous buffer (clipboard payloads can be multi-MB); `input` is
     * piped to the child's stdin (issue #7 — the copy helpers read their
     * payload from stdin). */
    const runClipboardCommand = createClipboardRunner()
    const clipboardEnv: ClipboardEnvironment = {
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      // PATH-aware helper detection — a bare existsSync only checks the
      // CWD and would declare installed wl-paste/xclip "missing" (review
      // finding).
      exists: (command) => commandOnPath(command, process.env.PATH, process.platform),
    }
    /** Issue #7: the copy policy's executor — the same bounded execFile
     * runner as the paste probe, with the text payload piped to stdin. */
    const runCopyCommand: CopyExecutor = (command, args, input) =>
      runClipboardCommand(command, args, { timeoutMs: 2000, input }).then(result => ({ code: result.code }))
    /** Issue #7: the copy policy's platform facts — the paste probe's
     * environment plus the OSC 52 best-effort sink (a TTY-gated write;
     * inside tmux the sequence rides a DCS passthrough so the terminal
     * behind tmux receives it — kimi-code convention). */
    const copyEnv: CopyEnvironment = {
      platform: clipboardEnv.platform,
      env: clipboardEnv.env,
      exists: clipboardEnv.exists,
      isTTY: () => process.stdout.isTTY === true,
      writeOsc52: (text) => process.stdout.write(buildOsc52Sequence(text, (process.env.TMUX ?? '').length > 0)),
    }
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
    const surfaceEvents: TuiAppEvents = {
      // ONE submission entry: the request (the Enter gesture, the
      // accelerated chord, or the explicit queue action) rides along — the
      // boundary resolves its delivery mode.
      onSubmit: (text, request) => dispatchUserInput(text, request),
      // The image-only submit gate (plan §11.1): an empty-text draft with
      // staged images is a real submission.
      isImageDraft: () => draftHasImages(app.getDraft(), draftImages),
      // The in-process EDITOR history must never recall a multimodal line
      // after its drafts were consumed — the placeholders would re-send as
      // plain text (the persisted JSONL history has the same guard; review
      // finding: the memory side was missing it).
      shouldRememberInput: (text) => !draftHasAttachments(text, draftImages, draftFiles),
      // Ctrl+V (plan M3): probe the clipboard ONCE per paste — an image
      // lands as a draft placeholder, plain text as an editor insert,
      // unsupported/empty silently (a text paste must never error).
      onClipboardPaste: () => {
        // The clipboard probe is ASYNC: capture the session identity and
        // discard the result if the user switched sessions meanwhile — a
        // late paste must never stage into the NEW session's draft
        // (round-5 finding 2).
        const pasteGeneration = ownership.generation()
        runOwned('clipboard paste', () => readClipboardImage(runClipboardCommand, clipboardEnv).then((result) => {
          if (cleanedUp || ownership.generation() !== pasteGeneration) return
          if (result.kind === 'image') {
            // Attach-time prune (review finding 2): placeholders deleted or
            // Ctrl+C-cleared since the last attach must not hold their
            // bytes until the store fills up.
            pruneUnreferencedDraftAttachments(app.getDraft(), draftImages, draftFiles)
            const limits = ctx.get('attachments')?.imageLimits
            if (limits !== undefined) {
              checkImageLimits(
                { mediaType: result.mediaType, width: result.width, height: result.height },
                result.bytes.byteLength,
                limits as Parameters<typeof checkImageLimits>[2],
              )
            }
            const draft = draftImages.add({
              bytes: result.bytes,
              mediaType: result.mediaType,
              width: result.width,
              height: result.height,
              source: { type: 'clipboard' },
            })
            app.insertIntoEditor(`${draft.placeholder} `)
            app.notify(`attached ${draft.placeholder} — Enter to send`)
          } else if (result.kind === 'text' && result.text !== '') {
            app.insertIntoEditor(result.text)
          }
        }), {
          diag,
          sessionId: () => agentNow()?.session.id,
          onError: (error) => {
            if (cleanedUp) return
            app.notify(safeErrorMessage(error), 'error')
          },
        })
      },
      // The owned-task entry for UI-layer one-shot flows (the external
      // editor): runOwned with the runner's diag pre-attached.
      runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
        runOwned(label, task, { ...options, diag, sessionId: () => agentNow()?.session.id })
      },
      onExit: () => {
        // Keyboard exit requests route through the SAME exit orchestration as
        // /exit and /quit (createExitController above): latch once, dispose
        // the Client surface, resume hint, process exit — the Direct
        // owned-session retirement runs inside the appExit disposal.
        requestExit()
      },
      onCancel: () => {
        // Esc cancel: abort a running `!` shell command, then interrupt the
        // live agent (busy: one Esc fires this directly; idle: double-Esc).
        // interruptAgent PRESERVES the pending queue (web Stop parity) — an
        // interrupt stops the current thinking, never the queued input.
        interruptLiveAgent()
      },
      // Conversation rewind: the TuiApp fires this only when IDLE with an
      // EMPTY editor and a fast second Esc (busy stays a cancel; overlays,
      // autocomplete and replacement editors keep their own Esc). The SAME
      // surface as `/rewind` — one implementation, two entries.
      onRewind: () => openRewindPicker(),
      // M6: execute a plugin keybinding's SEMANTIC action through the
      // host's own paths (plan §2.2 — the host never lets a plugin bypass
      // submission/session safety).
      onExtensionAction: (action) => {
        if (cleanedUp) return
        // VIEWER CAPABILITY GATE: while a subagent viewer is open (either
        // mode), semantic actions with PARENT-session side effects are
        // blocked — the viewer's input must never interrupt/steer/queue/
        // reconfigure the parent (a plugin keybinding reaching this runner
        // is the ONLY path that could, since the raw-key viewer guard
        // already consumes the parent chords). submit-draft/queue-draft
        // route to the CHILD through the viewer-aware submitDraft (a
        // one-shot viewer hard-rejects them), toggle-fullscreen is
        // surface-local; every other action is consumed as a no-op.
        if (viewer.isViewing() && !viewerActionCapability(action, { mode: viewer.read()!.mode })) {
          return
        }
        switch (action) {
          case 'submit-draft': {
            // Host-owned submit path: history + notify clear + draft
            // clear, exactly like a normal Enter (round-1 P2).
            app.submitDraft('enter')
            break
          }
          case 'queue-draft': {
            // The PUBLIC queue action: an explicit delivery command, never a
            // gesture — it queues regardless of the busy-Enter preference
            // (the accelerated CHORD is the preference's opposite, see
            // ComposerSubmitRequest).
            app.submitDraft('explicit-queue')
            break
          }
          case 'steer-draft': {
            const text = app.getDraft()
            // The steered draft is an agent-facing submission: the
            // snapshot (ts + image check) happens BEFORE the draft is
            // cleared, and the row is written inside steerNow AFTER the
            // session exists (the deferred-start gate) with the FINAL
            // session id.
            const persist = makeSteerPersist(text)
            app.setDraft('')
            steerNow(text, false, persist)
            break
          }
          case 'cancel-activity': {
            interruptLiveAgent()
            break
          }
          case 'open-search': {
            app.startTranscriptSearch()
            break
          }
          case 'toggle-fullscreen': {
            app.setFullscreen(!app.isFullscreen())
            break
          }
          case 'cycle-permission': {
            const agent = agentNow()
            if (agent === undefined) break
            const permission = ctx.get('permissionPresets')
            if (permission === undefined) break
            const names = permission.names
            if (names.length === 0) break
            const current = (permission as { current(session: unknown): string }).current(agent.session)
            const index = names.indexOf(current)
            const next = names[(index + 1) % names.length] ?? names[0]
            if (next === undefined || next === current) break
            permission.set(agent.session, next)
            app.notify(next === 'danger-full-access'
              ? `⚠ ${next} — no approvals`
              : `permission: ${next}`,
            next === 'danger-full-access' ? 'error' : 'info')
            status.refresh()
            break
          }
        }
      },
      onSteer: (text) => {
        // Ctrl+S: the steered draft is an agent-facing submission — the
        // snapshot happens now, and the row is written inside steerNow
        // AFTER the session exists (the deferred-start gate) with the
        // FINAL session id.
        steerNow(text, false, makeSteerPersist(text))
      },
      onExtensionError: ({ slot, id, error }) => {
        try {
          const ref = extensionService?._recordRegistryHealthRef(slot, id)
          if (ref !== undefined) extensionService?._recordRegistryError(ref, error)
        } catch {}
      },
      onExtensionRecovered: ({ slot, id }) => {
        try {
          const ref = extensionService?._recordRegistryHealthRef(slot, id)
          if (ref !== undefined) extensionService?._clearRegistryError(ref)
        } catch {}
      },
      // The session presentation title changed (advanced ui.host.setTitle,
      // session/title events — the app fires it for EVERY setSessionTitle):
      // the terminal window title policy follows, so a rename/regenerate
      // refreshes the OSC title immediately.
      onTitleChanged: () => {
        if (cleanedUp) return
        status.refreshTerminalTitle()
      },
      // Terminal focus reports (CSI ? 1004): the completion-notification
      // focus tracker observes them. The report is consumed host-side in
      // regular mode and passes through in fullscreen (the viewport
      // listener owns FOCUS_OUT's selection cleanup), so the tracker
      // only records state.
      onTerminalFocus: (focused) => {
        surface.handleTerminalFocus(focused)
      },
      // Any REAL input (not a focus report) proves the user is operating
      // the terminal: restore the tracker to 'focused' (a missed FOCUS_IN
      // must never leave an 'unfocused' tracker that would falsely notify
      // while the user watches).
      onUserInput: () => {
        surface.noteUserInput()
      },
      // Phase 4: the advanced host-state setTheme for a NON-built-in name
      // (a registered plugin theme). The runner resolves the palette
      // through the theme registry; unknown names are a no-op; a throwing
      // palette is recorded in the theme health slot. The path is
      // NAME-addressed (the documented Phase-4 contract), so the runner
      // maps the NAME to its SOURCE-QUALIFIED selectable value FIRST
      // (the review's P2: the value is what gets applied, persisted and
      // health-tracked — a bare name can never be a selection identity).
      onAdvancedSetTheme: (name) => {
        const selectable = extensionService?.themes.selectableValueForName(name)
        if (selectable === undefined) return
        const palette = extensionService?.themes.paletteForSelectable(selectable)
        if (palette === undefined) return
        // VALUE-addressed (the unified theme protocol).
        const themeRef = extensionService?._recordRegistryHealthRef('theme', selectable)
        try {
          app.applyPluginPalette(selectable, palette)
          if (themeRef !== undefined) extensionService?._clearRegistryError(themeRef)
        } catch (error) {
          if (themeRef !== undefined) extensionService?._recordRegistryError(themeRef, error)
          app.notify(`theme ${name} failed: ${safeErrorMessage(error)}`, 'error')
        }
      },
      openExternalEditor: async (draft) => {
        // $VISUAL/$EDITOR may carry arguments (`code --wait`, `vim -f`):
        // parse with a real shell-word parser, never a plain split.
        const words = parseShellWords(process.env.VISUAL ?? process.env.EDITOR ?? 'vi')
        const [editor, ...editorArgs] = words
        if (editor === undefined) throw new Error('empty editor command')
        const file = join(tmpdir(), `dsh-pi-tui-${process.pid}-${randomUUID()}.md`)
        writeFileSync(file, draft, { mode: 0o600 })
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(editor, [...editorArgs, file], { stdio: 'inherit' })
            // A settled latch: `error` and `close` can both fire; the first
            // outcome wins, exactly like the local-shell cards.
            let settled = false
            const finish = (error?: Error): void => {
              if (settled) return
              settled = true
              if (error !== undefined) reject(error)
              else resolve()
            }
            child.on('error', (error) => finish(error))
            child.on('close', (code, childSignal) => {
              // Only a successful editor run may produce the draft: a
              // non-zero exit or a signal kill means the file is whatever
              // the editor left behind, not a deliberate edit.
              if (code === 0) {
                finish()
              } else if (childSignal !== null) {
                finish(new Error(`${editor} was killed by signal ${childSignal}`))
              } else {
                finish(new Error(`${editor} exited with code ${code}`))
              }
            })
          })
          // Read ONLY after the editor finished successfully (close, code 0).
          return readFileSync(file, 'utf8')
        } finally {
          // Cleanup runs on EVERY path, including a failed read.
          rmSync(file, { force: true })
        }
      },
      // The transcript navigation callbacks (MoveOlder/TurnOlder/TurnNewer/
      // MoveNewer/JumpLatest) are surface-owned wiring (A4-8, plan §17); the
      // surface overlays them in `SurfaceRuntime.start`.
      onFullscreenChange: (fullscreen) => {
        const settingsDoc = tuiSettings
        if (settingsForms !== undefined) {
          runDetached('settings fullscreen write', () => serializeTuiSettingsMutation(
             settingsDoc,
             () => settingsDoc.replace({ ...settingsDoc.get(), footerCustomItems: settings.userFooterItemsForSave(), fullscreen: fullscreen ? 'on' : 'off' }),
            ), {
            diag,
            notify: (message) => {
              if (cleanedUp) return
              app.notify(message, 'error')
            },
            recoverable: () => true,
          })
        }
      },
      // The Ctrl+R search presentation callbacks (Open/Query/Next/Prev/Close)
      // are surface-owned wiring (A4-8, plan §17); the surface overlays them
      // in `SurfaceRuntime.start`. The matching/index algorithm stays in
      // transcript.ts and the stepping policy in search-overlay.ts.
      // P7d: a single Esc with no overlay up exits the subagent viewer
      // instead of arming the double-Esc cancel.
      onSingleEscape: () => viewer.exitView(),
      // Shift+Tab: cycle the permission preset through the composed table
      // (read-only → workspace-write → danger-full-access). The switch goes
      // through the official service (sandbox + approval + preset log in one
      // call, no transcript card), with a red warning only on the no-approval
      // preset (plain switches notify in the dim info style) and an immediate
      // footer refresh.
      onCyclePermission: () => {
        const agent = agentNow()
        if (agent === undefined) return
        const permission = ctx.get('permissionPresets')
        if (permission === undefined) return
        const names = permission.names
        if (names.length === 0) return
        const current = (permission as { current(session: unknown): string }).current(agent.session)
        const index = names.indexOf(current)
        const next = names[(index + 1) % names.length] ?? names[0]
        if (next === undefined || next === current) return
        permission.set(agent.session, next)
        app.notify(next === 'danger-full-access'
          ? `⚠ ${next} — no approvals`
          : `permission: ${next}`,
        next === 'danger-full-access' ? 'error' : 'info')
        status.refresh()
      },
      // Alt+↑: on the main surface, run the TUI-only recall-all extension:
      // remove every semantic `queued` occurrence and pull its content back
      // into the editor draft. The gesture is disabled in every viewer so it
      // cannot mutate a hidden main or child queue.
      onDequeue: () => {
        // Alt+↑: on the main surface, run the TUI-only recall-all extension:
        // remove every semantic `queued` occurrence and pull its content back
        // into the editor draft. The gesture is disabled in every viewer so it
        // cannot mutate a hidden main or child queue. The submission runtime
        // owns the ordered removal + recalled-draft settlement; the runner
        // supplies the narrow queue/TUI hooks.
        pullBackQueue({
          isDisposed: () => cleanedUp,
          isViewing: () => viewer.isViewing(),
          currentAgent: () => agentNow(),
          captureOwnerToken: () => ownership.captureSubject(),
          isOwnerTokenCurrent: (token) => captureMatches(token as SessionSubject | undefined),
          requireLiveScope,
          readPullableQueue: (sessionId) => {
            const pending = backend.pendingInputReader.snapshot(sessionId)
            if (pending === undefined) return undefined
            return pending.items
              .filter(item => item.placement === 'queued')
              .map(queueInboxMessageOf)
          },
          isTransitionPending: () => ownership.gate.pending || ownership.barrier.inTransition,
          withWriter: (scope, task) => submissionRuntime.withWriter(scope, task),
          updateQueue: (sessionId, messageId, operation) =>
            backend.sessionWriter.updateQueue(sessionId, messageId, operation),
          deferQueueRecall: (recall) => submissionRuntime.deferQueueRecall(recall),
          stageRecalledImage: (attachment) => {
            const ref = attachment as import('../image/admission.ts').ImageAttachmentRefLike
            const draft = draftImages.add({
              mediaType: ref.mediaType,
              width: ref.width,
              height: ref.height,
              ...(ref.name !== undefined ? { name: ref.name } : {}),
              source: { type: 'recalled' },
              recalledRef: ref,
            })
            return { id: draft.id, placeholder: draft.placeholder }
          },
          stageRecalledFile: (attachment) => {
            const ref = attachment as import('../attachment/file-admission.ts').FileAttachmentRefLike
            const draft = draftFiles.add({
              name: ref.name,
              byteLength: ref.bytes,
              source: { type: 'recalled', ref },
            })
            return { id: draft.id, placeholder: draft.placeholder }
          },
          discardStagedDraft: (kind, id) => {
            if (kind === 'image') draftImages.remove(id)
            else draftFiles.remove(id)
          },
          pinRecalledDrafts: (text) => pinDraftAttachments(text, draftImages, draftFiles),
          readDraft: () => app.getDraft(),
          writeDraft: (text) => app.setDraft(text),
          notify: (message, kind) => app.notify(message, kind),
          refreshPendingInput: () => surface.refreshPendingInput(),
          diag,
        })
      },
      // ↓ with an empty editor: the Quick Tasks browser. Task Center
      // merges the JobRegistry roster with the subagent descendant
      // catalog. The JobRegistry may include provisional foreground shell
      // work while it is running; if DSH removes that record after the
      // foreground result is collected, the row leaves the Task Center
      // with the registry (the Transcript tool card is the foreground
      // history authority), while handed-out background jobs that remain
      // in jobs.list() stay available in TRACKED after settlement. Job
      // rows (shell + background one-shot subagent jobs) are status-only:
      // the bash output read cursor belongs to the
      // model's job_output and a subagent job record carries no child
      // session id, so Enter opens the status viewer (never the output).
      // Subagent rows (live children from the subagent registry) deliver no
      // result to the parent, so Enter opens the child transcript directly:
      // continuable children always, and one-shot children while RUNNING (a
      // foreground delegation is the parent's pending tool call, so the
      // trigger would otherwise look dead). A running BACKGROUND one-shot
      // appears twice — its job row and its child row — because the two
      // records have no cross-reference to dedup; the viewable child row is
      // the more useful one. The children half enriches asynchronously:
      // listChildren may read persistence for cold children, so the picker
      // opens on the jobs half and setItems merges the rest in.
      //
      // The SAME browser is the `/tasks` surface (runner.openTasksBrowser):
      // the merged list + search is the single command-side entry, with
      // row-level `S` = confirmed Stop on capable rows (kimi's stop-on-row
      // pattern; the old /subagents SettingsList-submenu panel is gone).
      onOpenTasks: () => surface.openTasksBrowser('quick'),
      // A submit gesture in an INTERACTIVE (continuable) subagent viewer:
      // resolve queue/steer delivery, then deliver the human prompt through
      // the OFFICIAL ctx.subagents.prompt control
      // API — the child inbox (a distinct FIFO turn: enqueue while
      // running, wake while waiting, cold resume when absent), with Host
      // authority over the exact live parent and official user
      // provenance/requestId. NEVER `subagents.sendMessage` (the
      // Agent-authored Steer path) and never the parent's
      // submit/steer/queue path. The app already cleared the child draft;
      // a rejection restores it (merged) into the child's own draft slot.
      onSubagentSubmit: (submit) => {
        if (cleanedUp) return
        const viewerGeneration = app.getViewerGeneration()
        // The viewer editor's text becomes the prompt's content parts at
        // the client boundary (text today; image parts join with the
        // viewer's image intake). Resolve the Web composer policy against
        // the CHILD's activity; the parent status is irrelevant while
        // viewing.
        const delivery = submit.gesture === 'explicit-queue'
          ? 'queue'
          : resolveComposerDelivery(
            viewer.read()?.id === submit.childSessionId
              && viewer.read()?.parentSessionId === submit.parentSessionId
              && viewer.read()?.activity === 'running',
            submit.gesture,
            tuiSettings?.get().busyEnter,
          )
        // Empty accelerated input is the child-scoped Ctrl+S steer-all
        // gesture. It must operate on the live child inbox, never call the
        // ordinary human prompt API, and never manufacture an empty prompt.
        const viewerTarget = viewer.read()
        if (isEmptyAcceleratedViewerSubmit(submit.text, submit.gesture)) {
          if (viewerTarget === undefined
            || viewerTarget.id !== submit.childSessionId
            || viewerTarget.parentSessionId !== submit.parentSessionId
            || viewerTarget.mode !== 'continuable'
            || viewerTarget.access !== 'interactive-direct-child') return
          const childViewerGeneration = viewerGeneration
          let childDraftRestored = false
          const restoreChildDraft = (text: string): boolean => {
            if (text === '' || childDraftRestored) return true
            childDraftRestored = true
            const current = viewer.read()
            if (!cleanedUp
              && app.getViewerGeneration() === childViewerGeneration
              && current?.id === submit.childSessionId
              && current.parentSessionId === submit.parentSessionId
              && current.mode === 'continuable'
              && current.access === 'interactive-direct-child'
              && ownership.currentSessionId() === submit.parentSessionId) {
              const merged = mergeDraft(app.getDraft(), text)
              app.setEditorText(merged)
              return merged === text
            }
            if (!cleanedUp) app.restoreSubagentDraft(submit.childSessionId, text)
            return false
          }
          runOwned('subagent queue steer', () => steerAll({
            currentAgent: () => {
              const current = directRuntime.queueAgentFor(submit.childSessionId)
              return current === undefined ? undefined : current as unknown as SteerAgentLike
            },
            currentGeneration: () => app.getViewerGeneration(),
            notify: (message, kind) => {
              if (cleanedUp || app.getViewerGeneration() !== childViewerGeneration) return
              const read = viewer.read()
              if (read?.id !== submit.childSessionId || read.parentSessionId !== submit.parentSessionId) return
              app.notify(message, kind)
            },
            restoreDraft: restoreChildDraft,
            createDraft: () => ({}),
            staleNotice: () => 'the child viewer changed while steering — try again',
            mergedNotice: () => 'the child viewer changed while steering — try again',
            fence: () => cleanedUp || app.getViewerGeneration() !== childViewerGeneration,
            fenceNotice: () => 'the child viewer changed while steering — try again',
            pendingInputReader: backend.pendingInputReader,
            writer: backend.sessionWriter,
            writerSection: submissionWriterSection,
          }, submit.text, { draftHasPayload: false }), {
            diag,
            sessionId: () => directRuntime.queueAgentFor(submit.childSessionId)?.session.id,
            onError: (error) => {
              restoreChildDraft(submit.text)
              if (cleanedUp || app.getViewerGeneration() !== childViewerGeneration) return
              app.notify(safeErrorMessage(error), 'error')
            },
          })
          return
        }
        const request: SubagentViewerSubmitRequest = {
          parentSessionId: submit.parentSessionId,
          childSessionId: submit.childSessionId,
          delivery,
          content: [{ type: 'text', text: submit.text }],
        }
        const promptViewerAbort = viewer.followUpSignal()
        const promptViewerCwd = viewer.read()?.cwd
        runOwned('subagent prompt', () => backend.subagent.prompt(request, {
          // The caller signal owns lookup/materialization/admission only
          // until inbox acceptance (the official prompt contract): a TUI
          // cleanup / exit, OR the viewer session ending (Esc / child
          // switch / session swap — viewerSessionAbort) cancels a send
          // that has NOT been accepted yet; once accepted the child owns
          // the message and no restore happens. Never a dropped controller
          // whose signal can never fire.
          makeSignal: () => promptViewerAbort === undefined
            ? lifecycleController.signal
            : AbortSignal.any([lifecycleController.signal, promptViewerAbort]),
          // Same `@`-file mention canonicalization as the main session's
          // submissions (the editor keeps `@src/foo.ts`, the child model
          // receives the absolute path). The scope is the VIEWED CHILD's
          // workspace when the viewer knows it (the child may have been
          // born in another directory — canonicalizing against the parent
          // cwd would rewrite the child's mentions to the wrong tree);
          // an unknown cold-child cwd falls back to the live parent.
          canonicalizeText: (text) => backend.hostFile.canonicalizeMentions(
            viewerCanonicalizeScope(promptViewerCwd, request.parentSessionId),
            text,
          ),
        }), {
          diag,
          sessionId: () => agentNow()?.session.id,
          onResult: (outcome) => viewer.settleSubmit(request, submit.text, outcome, viewerGeneration),
          onError: (error) => viewer.settleSubmit(
            request,
            submit.text,
            { kind: 'rejected', reason: { kind: 'error', message: safeErrorMessage(error) } },
            viewerGeneration,
          ),
        })
      },
    }
    // A4: mount through the surface owner. The surface builds the surface-local
    // option wiring (image loader, history-search binding, clipboard/link
    // capabilities, extension registries + input routes, resize/workflow hooks)
    // from these narrow injected capabilities and owns the mounted TuiApp from
    // here on.
    surface.start({
      events: surfaceEvents,
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
      copySelection: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
      // Fullscreen OSC 8 link clicks + the Windows right-click paste: the alt
      // screen's mouse capture swallows both native behaviors, so the host
      // opens http/https links itself and reads the clipboard through the same
      // platform-aware policy as the image paste probe.
      openExternalUrl: (url) => openExternalUrl(url),
      readClipboardText: () => readClipboardText(runClipboardCommand, clipboardEnv),
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
    surface.attachSurfaceSeams({ refreshCommandCompletions: () => refreshCommandCompletions?.() })
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
      submissionEchoes: (sessionId) => submissionPresentation.snapshot(sessionId),
      queueTextOf: content => queueTextOf(content as readonly import('@deepseek-ai/dsh-llm').ContentBlock[]),
      exitView: () => { viewer.exitView() },
      refreshStatusCheap: () => status.refresh(),
      refreshStatusAndWelcome: () => {
        status.refresh()
        status.updateWelcomeCard()
      },
      applyGoalChange: (event) => status.applyGoalChange(event),
      sessionTitleOf: (event) => foldSessionTitle([event])?.title,
      settleLocalSubmitAck: (reason) => settleLocalSubmitAck(reason),
      markSubmitLatency: (sessionId, phase) => { submitLatencyTracker.mark(sessionId, phase) },
      observeDurableSubmission: (rpcId) => pendingSubmissions.observeDurable(rpcId),
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
          submitLatencyTracker.mark(sessionId, 'assistant.first')
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
    // The last SUCCESSFUL jobs read, FENCED to the session identity: a
    // transient registry failure must keep the retained Job rows, but a
    // switched-in session must never inherit the old session's rows.
    let jobSnapshot: { key: string; rows: ReturnType<NonNullable<typeof jobs>['list']> } | undefined
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
        listDescendants: () => {
          const sessionId = agentNow()?.session.id
          return sessionId === undefined ? Promise.resolve([]) : subagents.listDescendants(sessionId)
        },
        // The merged rows re-read the CURRENT jobs snapshot at every commit,
        // so a job settlement repaints an open browser too.
        readJobs: () => {
          const sessionId = ownership.currentSessionId()
          if (jobs === undefined || sessionId === undefined) return []
          const key = `${ownership.generation()}:${sessionId}`
          try {
            const rows = jobs.list(SessionId(sessionId))
            jobSnapshot = { key, rows }
            return rows
          } catch {
            // The registry read is best-effort: a failed read is NOT an
            // authoritative empty catalog. Returning the last successful
            // snapshot preserves the retained Job rows — but ONLY for the same
            // session identity, so a switched-in session never inherits the
            // old session's rows.
            return jobSnapshot?.key === key ? jobSnapshot.rows : []
          }
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
    // The TUI-owned slash commands live on the commands service's global
    // layer, which needs no agent — register them up front so the whole
    // surface (including Tab completion) works before the first session
    // exists. Session-backed handlers call runner.ensureSession() first;
    // `refreshSkills` rebuilds the agent-scoped per-skill commands once a
    // session becomes live.
    let commandsRegistered = false
    /** The claim test installed by registerTuiCommands: is a slash name
     * advertised by the CURRENT completion list? The dispatch captures it
     * BEFORE any session creation (see dispatchViaSession). */
    let wasAdvertisedClaim: ((name: string) => boolean) | undefined
    /** The claim test installed by registerTuiCommands: does the CURRENT
     * effective host catalog claim THIS LINE (and does the claiming
     * descriptor declare `input.attachments`)? The dispatch consults it
     * BEFORE the busy queue/steer policy and for every attachment decision
     * (PR115-fix problem 1). */
    let hostClaimOf: ((parsed: { name: string; rawInput?: string }) => HostCommandClaim | undefined) | undefined
    /** The skill-wrapper test installed by registerTuiCommands: is a slash
     * name a LIVE TUI-owned skill wrapper? The steer path consults it to
     * decide whether a composition without the host skill-body loader must
     * deliver through loadSkill instead of steering a bare line. */
    let isSkillWrapperName: ((name: string) => boolean) | undefined
    /** The completion re-synthesis installed by registerTuiCommands: a late
     * CLIENT command contribution must join the `/` menu without waiting for
     * a session refresh (the extension-invalidate hook calls it). */
    let refreshCommandCompletions: (() => void) | undefined
    /** The delivery binding installed by registerTuiCommands: bind one
     * submission's resolved queue/steer mode for the synchronous window that
     * launches a command execution (the TUI skill handlers consume it).
     * Before the command surface is wired nothing can consume a binding, so
     * the unwired default simply runs the launch. */
    let withCommandDelivery = <T>(_delivery: SubmitDelivery, run: () => T): T => run()
    /** Consume TUI-local command draft dispositions after DSH normalizes the
     * public CommandResult. A missing id is used only for a thrown command
     * execution, which cannot return its generated id to this sink. */
    let takeCommandDraftDisposition: ((commandId?: string) => 'restored' | 'suppressed' | undefined) | undefined
    /** The catalog refresh coordinator: the ONE post-mount refresh owner
     * (first session, switches, /preset, /reload). Built inside
     * registerCommands once the surface hooks exist. (Declared before
     * cleanup — see the hoisted slot above.) */
    let catalogRefreshRequest: ((request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>) | undefined
    /** `skills/change` coalescing: bursts of invalidation notifications cost
     * at most two reads, and the follow-up re-read observes the CURRENT
     * ownership (live agent vs standing preset). */
    let skillsChangeSubscribed = false
    const skillsChangeGate = new CoalescingRefreshGate(() => {
      runOwned('skills/change refresh', async () => {
        const refresh = catalogRefreshRequest
        if (refresh === undefined) return undefined
        const target = agentNow() === undefined
          ? { kind: 'preset', presetId: pendingPreset ?? launchPreset } as const
          : { kind: 'agent', key: ownership.generation() } as const
        return refresh({
          source: 'invalidation',
          target,
          ...target.kind === 'agent' ? { agent: agentNow() } : {},
        })
      }, {
        diag,
        sessionId: () => agentNow()?.session.id,
        onResult: (outcome) => {
          // NOTIFY BEFORE settled(): if app.notify throws, runOwned routes
          // to onError, whose settled() is then the ONLY settle — a dirty
          // follow-up cannot be double-settled (a second settle would clear
          // the follow-up's in-flight flag while it is still running).
          if (outcome !== undefined && outcome.kind === 'applied' && outcome.notice !== undefined) {
            app.notify(outcome.notice, 'error')
          }
          skillsChangeGate.settled()
        },
        onCancel: () => { skillsChangeGate.settled() },
        onError: (error) => {
          skillsChangeGate.settled()
          app.notify(`skill catalog refresh failed: ${safeErrorMessage(error)}`, 'error')
        },
      })
    })
    /** Subscribe to the dsh-skill invalidation notification once, through
     * the catalog capability (migration M1.8). The event carries no
     * scope or cwd, so the refresh target follows the CURRENT ownership; an
     * unavailable or throwing subscription degrades to no subscription —
     * owner switches and /reload still refresh. The flag is set only after
     * a successful subscribe, so a throwing subscribe can retry on a later
     * registration attempt. */
    const subscribeSkillsChangeEvents = (): void => {
      if (skillsChangeSubscribed) return
      try {
        backend.catalog.skills.onSkillsChange(() => skillsChangeGate.notify())
        skillsChangeSubscribed = true
      } catch (error) {
        diag.warn('skills/change subscription unavailable', { error: safeErrorMessage(error) })
      }
    }
    /**
     * The conversation rewind picker (the ONE entry shared by the idle
     * empty-editor double-Esc and `/rewind` — plan §22). Lists the completed
     * user turns of the live session; a selection dispatches the semantic Host fork with the candidate's predecessor boundary
     * as an OWNED task with
     * the navigation identity gates. Sessionless (deferred start) it notifies
     * and never creates a session.
     */
    function openRewindPicker(): void {
      const source = agentNow()
      if (source === undefined) {
        app.notify('no conversation to rewind', 'info')
        return
      }
      // Rewind only from an EMPTY editor: the restored prompt must be a
      // deliberate, clean draft — never merged into (or over) the user's
      // current draft. The `/rewind` command gets the same guard, so both
      // entries can never drop staged input (plan §30).
      if (app.getDraft().trim() !== '') {
        app.notify('clear the current draft before rewinding', 'info')
        return
      }
      const candidates = collectRewindCandidates(source.session.snapshotEvents())
      if (candidates.length === 0) {
        app.notify('no completed user turn to rewind', 'info')
        return
      }
      // Capture the picker-open identity, not only the Session id. A switch
      // away and back to the same id must still supersede the old candidate.
      const sourceId = source.session.id
      const pickerIdentity: RewindLiveIdentity = {
        sessionId: sourceId,
        generation: ownership.generation(),
        navigationEpoch: ownership.navigationEpoch(),
      }
      app.openPicker(
        candidates.map(rewindPickerItem),
        (value) => {
          const candidate = candidates.find(item => String(item.turnStartSeq) === value)
          if (candidate === undefined) return
          let adopted = false
          runOwned('conversation rewind', () => sessionRuntime.forkSession(
            sourceId,
            candidate.forkAtSeq,
            () => {
              adopted = true
              app.setDraft(candidate.editorText)
            },
            pickerIdentity,
          ), {
            diag,
            sessionId: () => sourceId,
            onResult: (outcome) => {
              if (outcome.kind === 'success' && adopted) {
                if (candidate.hasNonTextContent) {
                  app.notify(`rewound to turn ${candidate.turn}; original non-text content was not re-staged — review it before sending`, 'error')
                } else {
                  app.notify(`rewound to turn ${candidate.turn}`, 'info')
                }
                return
              }
              if (outcome.kind === 'error') {
                if (outcome.text === 'the session changed before fork dispatch') {
                  app.notify('session changed — rewind cancelled', 'info')
                } else {
                  app.notify(outcome.text, 'error')
                }
              }
            },
            onError: (error) => {
              app.notify(safeErrorMessage(error), 'error')
            },
          })
        },
        () => {},
        {
          header: 'Rewind conversation · workspace unchanged',
          enableSearch: true,
          noMatchText: 'No matching turn',
          width: 72,
          maxHeight: 24,
          showHint: true,
        },
      )
    }
    /**
     * The exact Direct attachment of a scope, validated in ONE synchronous
     * admission step: a stale scope throws `SupersededReadError` (never
     * retargets to the current owner), a sessionless scope has no live read,
     * and a current live scope that cannot resolve its matching Direct
     * attachment breaks an internal invariant loudly.
     */
    const agentForLiveScope = (scope: SessionScope): Agent => {
      if (!sessionScope.isCurrent(scope)) {
        throw new SupersededReadError('the session changed before the read')
      }
      const sessionId = scope.sessionId
      if (sessionId === undefined) throw new Error('a live read requires a Session scope')
      const agent = agentNow()
      if (agent === undefined || agent.session.id !== sessionId) {
        throw new Error('a current live scope must resolve its exact Direct owner')
      }
      return agent
    }
    /**
     * The exact Direct attachment of an already-fenced live session id: the
     * command runtime's synchronous `liveSessionId` fence proved the scope
     * current in the SAME stack, so this only resolves the attachment and
     * asserts the exact-owner invariant loudly.
     */
    const attachmentForSession = (sessionId: string): Agent => {
      const agent = agentNow()
      if (agent === undefined || agent.session.id !== sessionId) {
        throw new Error('a current live scope must resolve its exact Direct owner')
      }
      return agent
    }
    /**
     * The BOUND semantic command runtime (A3-5): it owns the scope/currentness
     * fence and the facade shapes; every Direct fact is injected here as a
     * narrow surface hook, and the Host skill catalog reads go through the
     * semantic capability. The runner keeps the Direct composition and the
     * presentation dependency bag.
     */
    const commandRuntime = bindCommandRuntime({
      scope: sessionScope,
      session: {
        ensureSession: () => sessionRuntime.ensureSession(),
        withWriter: (scope, task) => sessionRuntime.withWriter(scope, task),
      },
      skills: backend.catalog.skills,
      surface: {
        listScopedCommands: () => {
          const commands = ctx.get('commands') as CommandRegistryLike | undefined
          if (commands === undefined) throw new Error('commands service unavailable')
          return commands.list(agentNow()).map(commandSummaryOf)
        },
        sessionRunning: (sessionId) => attachmentForSession(sessionId).status === 'running',
        sessionRouting: (sessionId) => {
          const agent = attachmentForSession(sessionId)
          // `provider`/`model` are OPTIONAL in the DSH AgentOptions contract and
          // the Direct composition may leave them unset: their absence is real
          // semantic optionality, never an invariant break.
          return {
            provider: agent.options.provider,
            model: agent.options.model,
            cwd: agent.session.header.cwd ?? cwd,
          }
        },
        approvalOverride: (sessionId) => {
          attachmentForSession(sessionId)
          return backend.config.permissions.approvalOverrideOf(sessionId)
        },
        sessionStats: (sessionId) => computeStats(attachmentForSession(sessionId).session.snapshotEvents()),
        lastAssistantText: (sessionId) => {
          const session = attachmentForSession(sessionId).session
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
        refreshLiveCatalog: async (sessionId, source) => {
          // SYNC admission: the exact Direct owner is captured HERE, before the
          // read awaits (§10.2).
          const agent = attachmentForSession(sessionId)
          const refresh = catalogRefreshRequest
          if (refresh === undefined) return { kind: 'failed', error: 'catalog refresh unavailable' }
          return refresh({ source, target: { kind: 'agent', key: ownership.generation() }, agent })
        },
        refreshStandingCatalog: (presetId, source) => {
          const refresh = catalogRefreshRequest
          return refresh === undefined
            ? Promise.resolve({ kind: 'failed', error: 'catalog refresh unavailable' })
            : refresh({ source, target: { kind: 'preset', presetId } })
        },
        promptAdmission: (sessionId, line, task) => {
          // The caller already holds this scope's writer section, so this
          // synchronous read of the CURRENT Direct attachment IS the scope's
          // exact Agent (§10.1); a transition cannot swap it here.
          const agent = attachmentForSession(sessionId)
          return directRuntime.withPromptAdmission(agent, draftHasImages(line, draftImages), async () => task())
        },
      },
    })
    const runner: TuiCommandRunner = {
      ctx,
      app,
      diag,
      get currentSessionId() { return ownership.currentSessionId() },
      // The A3-5 semantic command runtime (scope/currentness, scoped catalog,
      // skill execution, stats/read, catalog refresh, prompt admission and the
      // writer exposure) — the runner delegates these members to it.
      ...commandRuntime,
      // Completion-notification preference setters (the /settings panel
      // writes): the controller applies the parsed value immediately and
      // the panel persists the raw string through the config port.
      setNotificationMode: (mode) => surface.setNotificationMode(mode),
      setNotificationMethod: (method) => surface.setNotificationMethod(method),
      ensureSession: () => sessionRuntime.ensureSession(),
      get selected() { return model.selected },
      // Legacy/display facade: the newest SESSIONLESS `/model` intent (pending
      // or unresolved) falling back to the persisted global default. A fresh
      // create never seeds from it — the Direct adapter captures the persisted
      // Host default at admission.
      defaultSelection: () => model.defaultIntent.intent ?? model.currentDefault(),
      get defaultIntent() { return model.defaultIntent.intent },
      get defaultIntentRecord() { return model.defaultIntent.record },
      get defaultIntentOutcome() { return model.defaultIntent.outcome },
      awaitPendingDefaultWrite: (signal) => model.awaitPendingDefaultWrite(signal),
      trackDefaultWrite: (write) => model.trackDefaultWrite(write),
      setModelSelectionPending: (selection, token, status) => model.setPending(selection, token, status),
      reconcileDefaultIntent: (persisted) => model.reconcileDefaultIntent(persisted),
      setDefaultIntent: (next) => model.setDefaultIntent(next),
      settleIntent: (id, outcome) => model.settleIntent(id, outcome),
      get tuiSettings() { return tuiSettings as unknown as TuiCommandRunner['tuiSettings'] },
      // /new and /fork create through the session lifecycle port (semantic
      // requests — the Direct adapter resolves the preset composition).
      agents: lifecycleAgents,
// M2: apply the persisted footer mode + layout (shared by /settings,
      // /reload and the startup path).
      applyFooterSettings: (doc, saved) => settings.applyFooterSettings(doc, saved),
      // The session READ port (migration M1.3): /sessions, /resume, /search,
      // the title batches, the context measurement and the export read go
      // through the port, never ctx directly.
      sessionReader: backend.sessionReader,
      // PR D2: the /status explicit force — measure NOW through the
      // coordinator (mark dirty + semantic reader), repaint the footer
      // cheaply, and return the fresh (or last-good) value for the panel.
      // Panel and footer share ONE cached measurement: no duplicate reads
      // against the coordinator's cache, no stale footer after an explicit
      // status (round-8 finding).
      forceContextMeasurement: () => status.forceContextMeasurement(),
      // The session WRITE port (D2.1): ordinary prompts, Ctrl+S batch
      // delivery, exact queue removal, cancel and title ops go through the port.
      sessionWriter: backend.sessionWriter,
      // The interaction port (migration M1.6): approval/question authority.
      interaction: backend.interaction,
      // The catalog port (migration M1.8): models/providers, presets and
      // skills — commands read Host catalogs through semantic DTOs.
      catalog: backend.catalog,
      // The config port (migration M1.9): settings, provider profiles,
      // credentials, authorization, permissions and the preset default.
      config: backend.config,
      // The Host-file port (migration M1.10): `@`-mention discovery and
      // send-time canonicalization against the Host filesystem.
      hostFile: backend.hostFile,
      // The minimal commands registry for the TUI's OWN registrations
      // (migration M1.11) — the runner assembly dependency, never a Host
      // capability exposed to command handlers.
      commandRegistry: ctx.get('commands') as import('../commands.ts').CommandRegistryLike | undefined,
      cwd,
      imageStore: draftImages,
      fileStore: draftFiles,
      // Issue #7: `/copy` uses the SAME shared user-clipboard delivery
      // policy as the fullscreen selection (see copySelection above).
      copyToClipboard: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
      // The deployment image policy, re-read dynamically so a runtime
      // reconfiguration is picked up (plan §10.1: never a cached copy).
      imageLimits: () => ctx.get('attachments')?.imageLimits as import('../image/intake.ts').ImageLimitsLike | undefined,
      insertIntoEditor: (text) => app.insertIntoEditor(text),
      // The shared prepared-input pipeline (skills build their message
      // through this — review finding 4).
      prepareDraftMessage: (text) => prepareUserMessage(text, draftImages, submitDeps),
      // M5: the extension registries (commands/themes/settings/autocomplete/
      // keybindings), when the extension service is mounted. The /settings
      // and /theme pickers read them; undefined degrades to the host-only
      // panel.
      get extensions() {
        return extensionService === undefined ? undefined : {
          commands: extensionService.commands,
          themes: extensionService.themes,
          settings: extensionService.settings,
          autocomplete: extensionService.autocomplete,
          keybindings: extensionService.keybindings,
          renderers: extensionService.renderers,
          editors: extensionService.editors,
          api: () => extensionService.api(),
          // P1-08: the live contribution-health snapshot (failed/shadowed
          // states + lastError across every registry incl. renderers).
          health: () => extensionService._ledger().healthSnapshot(),
        }
      },
      recordExtensionError: (ref, error) => extensionService?._recordRegistryError(ref, error),
      clearExtensionError: (ref) => extensionService?._clearRegistryError(ref),
      /** The live session's workspace cwd (header), falling back to the
       * process cwd before any session exists; the footer/welcome/
       * completions/history follow it so a session switch updates the
       * whole surface. */
      sessionCwd: () => status.sessionCwd(),
      signal,
      progressUpdatesState,
      responseStyleState,
      /** Canonical display surface: /display and /focus compatibility both
       * read and mutate the shared DisplayState through one setter. */
      displayPreset: () => displayState.preset,
      setDisplayPreset: (preset) => settings.setDisplayPreset(preset),
      /** @deprecated Focus compatibility facade. */
      focusEnabled: () => isFocusDisplayPreset(displayState.preset),
      setFocusMode: (enabled) => { settings.setDisplayPreset(enabled ? 'focus' : 'full') },
      get pendingPreset() { return pendingPreset },
      set pendingPreset(id: string | undefined) { pendingPreset = id },
      /** The effective preset id for COLD (sessionless) reads: the run-local
       * pending override ahead of the launch-time --preset (the SAME
       * precedence ensureSession uses); undefined = the saved/default
       * preset applies. */
      get effectivePresetId() { return pendingPreset ?? launchPreset },
      applyPermissionPreset: async (scope, presetId, presetSignal) => {
        // A stale scope BEFORE the dispatch proves nothing ran: report `refused`.
        if (!sessionScope.isCurrent(scope)) return { ownership: 'refused' as const }
        agentForLiveScope(scope)
        const outcome = await backend.config.permissions.applyPermissionPreset(scope.sessionId, presetId, presetSignal)
        // The operation WAS dispatched. Losing the surface after the fact must NOT
        // erase what the port settled (`src/runtime/write-outcome.ts`: ownership and
        // settlement are independent axes) — the caller may not claim "not applied".
        if (!sessionScope.isCurrent(scope)) return { ownership: 'superseded' as const, outcome }
        return { ownership: 'current' as const, outcome }
      },
      setSessionApprovalPolicy: (scope, value) => {
        // Same contract for the synchronous write: validate, then dispatch in
        // the SAME stack — the exact owner, never `sessionId` re-resolved later.
        if (!sessionScope.isCurrent(scope)) return 'superseded' as const
        agentForLiveScope(scope)
        backend.interaction.setApprovalPolicy(scope.sessionId, value)
        return 'applied' as const
      },
      switchSession: (sessionId) => sessionRuntime.switchSession(sessionId),
      forkSession: (sourceSessionId) => sessionRuntime.forkSession(sourceSessionId),
      transitionTo: (steps) => sessionRuntime.transitionTo(steps),
      currentPreset,
      sessionBlank,
      // PR D2: the command surface's generic refresh is UI-only (a
      // measurement-triggering command uses refreshContextMeasurement or
      // the /status port call directly).
      refreshStatus: () => status.refresh(),
      updateWelcomeCard: () => status.updateWelcomeCard(),
      openJobView: (jobId) => surface.openJobView(jobId),
      // The zero-arg runner callback (commands.ts) is the `/tasks` surface:
      // it opens the FULL browser explicitly.
      openTasksBrowser: () => surface.openTasksBrowser('full'),
      openRewindPicker,
      // `/plugins` opens the profile-wide Plugin Manager panel (P1-A). It is
      // NOT session-owned: it never creates or switches a Session.
      openPluginManager: () => pluginManager.open(),
      createPluginManagerSubmenu: (done) => pluginManager.submenu(done),
      // The attachment-intake UX fence: the ONE production reader of the
      // transition gate. Staging an attachment while a transition is in flight
      // (quiesce → commit) would inject a draft into a session about to be
      // retired. Semantic session writes never read this flag — they admit
      // through the operation barrier (SessionRuntime.withWriter).
      sessionTransitionPending: () => ownership.gate.busy,
      // The single-writer session-transition gate: ordinary /new and
      // command-side switches run create AND commit inside one exclusive
      // section via this seam. Host fork dispatch is outside this FIFO;
      // forked-child adoption and rewind navigation use their own gated
      // adoption path.
      withSessionTransition: <T>(task: () => Promise<T> | T) =>
        ownership.gate.run(() => ownership.barrier.runTransition(async () => {
          try {
            return await task()
          } finally {
            // A command may fail during preflight before it calls
            // transitionTo; do not leave a deferred recall unresolved.
            submissionRuntime.settleQueueRecalls(false)
          }
        })),
      enterView: (childId: SessionId, label: string | undefined, mode: 'one-shot' | 'continuable', parentSessionId: SessionId, activity: 'running' | 'inactive') =>
        viewer.enterView(childId, label, mode, parentSessionId, activity),
      requestExit,
      exit,
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
          runner.withPromptAdmission(scope, line, task),
        isDisposed: () => cleanedUp,
        isScopeCurrent: (scope) => sessionScope.isCurrent(scope),
        mergeDraftIntoEditor: (text) => {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          return merged === text
        },
        consumeDraftAttachments: (text) => consumeDraftAttachments(text, draftImages, draftFiles),
        markDispatch: (sessionId) => submitLatencyTracker.mark(sessionId, 'dispatch'),
        beginLocalSubmission: ({ requestId, text, scope, generation, ackToken }) => {
          const agent = agentForLiveScope(scope)
          beginLocalSubmission(
            requestId,
            text,
            submissionPlacement('queue', agent.status === 'running'),
            agent.session.id,
            generation,
            ackToken,
          )
        },
        settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
        settleSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
        notify: (message, kind) => app.notify(message, kind),
        refuseByTransitionFence: (text) => refuseByTransitionFence(
          text,
          () => app.getDraft(),
          (t) => app.setEditorText(t),
          (m, k) => app.notify(m, k),
        ),
        prepareMessage: (text, requestId) => prepareUserMessage(text, draftImages, submitDeps, { requestId }),
        prompt: (sessionId, message) => backend.sessionWriter.prompt(sessionId, message, 'queue'),
      },
    })
    const registerCommands = (initial?: InitialCommandCatalog): void => {
      if (commandsRegistered) return
      const commands = ctx.get('commands')
      if (commands === undefined) return
      commandsRegistered = true
      try {
        const installed = registerTuiCommands(runner, initial)
        wasAdvertisedClaim = installed.wasAdvertised
        hostClaimOf = installed.hostClaimOf
        isSkillWrapperName = installed.isSkillWrapper
        refreshCommandCompletions = installed.refreshCommandCompletions
        withCommandDelivery = installed.withDelivery
        takeCommandDraftDisposition = installed.takeCommandDraftDisposition
        // The coordinator's surface hooks point INTO the command surface;
        // the command runtime's refresh facades (and the switch/first-session
        // path) route every post-mount refresh through `catalogRefreshRequest`.
        catalogCoordinator = new CatalogRefreshCoordinator({
          readAgent: (agent, readSignal) => readSurfaceCatalog(agent, readSignal, ctx as unknown as SurfaceCatalogContext),
          // The sessionless (preset) target reads the STANDING skill catalog
          // through the catalog capability (migration M1.8) — the
          // capability-gated cold path (standing key → global → degraded
          // global with a notice), never an Agent probe: probes emit
          // durable session events in this deployment (see
          // docs/surface-catalog.md).
          readStanding: (presetId, readSignal) =>
            backend.catalog.skills.standing(presetId, process.cwd(), readSignal),
          installSnapshot: (next) => installed.installSnapshot(next),
          enterCatalogTransition: () => installed.enterTransition(),
        }, lifecycleController.signal, diag)
        catalogRefreshRequest = (request) => catalogCoordinator!.refresh(request)
        subscribeSkillsChangeEvents()
      } catch (error) {
        // A failed registration must not lock the surface forever (a locked
        // flag would leave every later command resolving to a plain message
        // silently): reset the flag for a later retry and surface the
        // failure visibly instead of swallowing it.
        commandsRegistered = false
        const message = safeErrorMessage(error)
        ctx.logger.error(`tui-runner: command registration failed: ${message}`)
        diag.error('command registration failed', { error: message })
        app.notify(`command registration failed: ${message}`, 'error')
      }
    }
    /** Await one live-owner catalog refresh through the coordinator (the
     * first deferred create and every session switch): the refresh attempt
     * settles before the caller continues, and its outcome is an outcome —
     * provider issues degrade fields, failures warn, the submission or the
     * switch proceeds either way. */
    const refreshLiveCatalog = async (agent: Agent): Promise<void> => {
      const refresh = catalogRefreshRequest
      if (refresh === undefined) return
      await refresh({
        source: 'live-session',
        target: { kind: 'agent', key: ownership.generation() },
        agent,
      })
    }
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
    registerCommands({ snapshot: initialSnapshot, skills: initialSkills })
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
