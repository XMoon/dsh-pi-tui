/**
 * SubmissionController (A5b-4, plan §A5b-4): the ONE owner of the user-input
 * workflow — the submit FIFO turn, the local submit acknowledgement + latency
 * timeline, the client-local submission echoes, the submission draft restore,
 * the session/command dispatch and the Alt+Up queue pull-back.
 *
 * Writer authority is UNCHANGED: the semantic write still enters through
 * `SubmissionRuntime` + `SessionRuntime.withWriter` + the Backend ports. This
 * file owns no barrier, transition gate or retry authority — it supplies the
 * semantic hooks the submission runtime drives.
 *
 * The command authority comes from the A5b-3 command owner (`deps.command`);
 * the raw Host command registry is a narrow injected plane. The module is
 * deliberately neutral: the exact Agent type is a generic parameter and every
 * Host/Cordis read arrives as a narrow capability.
 * @module @xmoon76/dsh-pi-tui/app/submission/controller
 */

import { randomUUID } from 'node:crypto'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { draftHasFiles, expandAttachmentPlaceholders } from '../../attachment/placeholder.ts'
import type { DraftFileStore } from '../../attachment/file-draft.ts'
import { formatBytes } from '../../bounded-output.ts'
import type { Diag } from '../../diag.ts'
import { runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { ImageInputError } from '../../image/errors.ts'
import { runReservedSubmit } from '../../image/submit-flow.ts'
import type { DraftImageStore } from '../../image/draft-store.ts'
import { consumeDraftAttachments, draftHasAttachments, draftHasImages, pinDraftAttachments, prepareUserMessage, type PrepareInputDeps } from '../../image/submit.ts'
import { expandImagePlaceholders } from '../../image/placeholder.ts'
import { classifyCommandLine, isBareCommandLine, isLocalCommandLine, isPlainExitPrompt, LOCAL_COMMANDS, resolveSubmitDelivery, SESSIONLESS_COMMANDS, shouldConsumeAdvertisedMiss, type CommandLineClassification } from '../../command-policy.ts'
import { isIndeterminateSkillWrite, type HostCommandClaim, type SubmitDelivery } from '../../commands.ts'
import type { ClientCommandRegistry } from '../command/client-command-registry.ts'
import type { TuiLocalCommandHandler } from '../../extension/public-types.ts'
import { PendingSubmissions, type PendingSubmissionPlacement } from '../../pending-submission.ts'
import { queueInboxMessageOf } from '../../pending-presentation.ts'
import type { HostCommandExecution, HostCommandOutcome, HostCommandPort } from '../../runtime/host-command-port.ts'
import type { HostFilePort } from '../../runtime/host-file-port.ts'
import type { PendingInputReader } from '../../runtime/pending-input-reader-port.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import { shellCommandOf } from '../../shell-context.ts'
import type { TuiSettingsDoc } from '../../runtime/config-port.ts'
import { freshSubmitAckState, acceptSubmitAck, settleSubmitAck, type SubmitAckState, type SubmitPendingDetail } from '../../submit-ack.ts'
import { SubmitLatencyTracker, type SubmitLatencyPhase } from '../../submit-latency.ts'
import { DirectSubmissionPresentation, type SubmissionPresentationSource } from '../../submission-presentation.ts'
import { mergeDraft, refuseByTransitionFence } from '../../steer.ts'
import type { ComposerSubmitRequest, TuiApp } from '../../tui-app.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../session/scope.ts'
import type { SessionSubject } from '../session/subject.ts'
import { deliverBusy, executeHostCommandSubmission, pullBackQueue, steer, type PendingQueueRecall, type PromptSubmission, type SteerSubmissionAgent, type SteerSubmissionDeps } from '../submission/runtime.ts'

/** The minimal exact-Agent surface the submission path reads. */
export interface SubmissionAgentLike {
  readonly status: string
  readonly session: { readonly id: string }
  readonly options: { readonly provider?: string; readonly model?: string }
}

/** One local command invocation as the bridge handlers receive it. */
export type LocalCommandInvocation = Parameters<TuiLocalCommandHandler>[0]
/** One normalized local command handler (bridge or command-service). */
export type LocalCommandHandler = (invocation: LocalCommandInvocation) => ReturnType<TuiLocalCommandHandler>

/** The raw Host command-registry plane (the composition root maps the
 *  official service; this owner never imports it). Direct-only after PR4
 *  §1.3: a TUI-owned command line NEVER routes through the Host executor on
 *  the Remote branch — the Client registry owns that execution — so the
 *  plane is supplied ONLY where a real Direct Agent exists. */
export interface SubmissionCommandPlane<ExactAgent> {
  /** Whether the composition provides a command service at all. */
  available(): boolean
  /** Execute one TUI-owned command line in-process (Direct compatibility:
   *  the exact Direct Agent the line was captured against). */
  execute(agent: ExactAgent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<HostCommandExecution | undefined>
  /** The command-service fallback handler for one local command name. */
  findHandler(name: string): LocalCommandHandler | undefined
}

/** The A5b-3 command authority seams the submission path consumes. */
export interface SubmissionCommandAuthority {
  wasAdvertisedClaim(name: string): boolean
  /** The ADVERTISED union claim view (completion/advertised-miss semantics).
   *  NOT a routing authority — routing uses {@link hostOriginClaimOf}. */
  hostClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** PR5 v2 §1C-4: the GENUINE Host-origin line authority (this TUI's own
   *  Direct compatibility mirrors excluded; Client synthesis never
   *  overwrites it). Every routing decision consumes THIS. */
  hostOriginClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** §D3 precedence: whether a GENUINE HOST-ORIGIN command resolves the
   *  name (the claim-set union also carries this surface's own Client
   *  registrations, so it cannot discriminate Host authority). */
  hostCatalogResolves(name: string): boolean
  /** §1C-6: the LIVE Client registry's exact-line claim — the ONLY TUI
   *  ownership source the classification may read (bare token, or an argued
   *  line when the definition declares an `input` descriptor). */
  clientClaimsLine(parsed: { name: string; rawInput?: string } | undefined): boolean
  isSkillWrapperName(name: string): boolean
  isSkillInvocation(parsed: { name: string } | undefined, text: string): boolean
  withCommandDelivery<T>(delivery: SubmitDelivery, run: () => T): T
  takeCommandDraftDisposition(commandId?: string): 'restored' | 'suppressed' | undefined
  /** The Client-owned command registry (PR4 §1.3): the TUI_BUILTIN route's
   *  execution owner on the Remote branch (Direct keeps the in-process
   *  command service for its unchanged dispatch surface). */
  clientCommands: ClientCommandRegistry
}

/** The narrow client command-bridge read surface. */
export interface SubmissionExtensionsDeps {
  findContribution(name: string): { readonly sessionless: boolean } | undefined
  handlerFor(name: string): TuiLocalCommandHandler | undefined
  commandIdFor(name: string): string | undefined
  isLocal(name: string, staticLocal: ReadonlySet<string>): boolean
  recordHealthRef(slot: string, id: string): unknown
  recordError(ref: unknown, error: unknown): void
  clearError(ref: unknown): void
}

/** The narrow capabilities the submission controller consumes. */
export interface SubmissionControllerDeps<ExactAgent extends SubmissionAgentLike> {
  /** The mounted app (editor, notifications, submit-pending row). */
  readonly app: () => TuiApp
  readonly diag: Diag
  /** The runner lifetime signal (a disposed gesture never restores/notifies). */
  readonly signal: AbortSignal
  readonly isCleanedUp: () => boolean
  /** The cordis logger sink (the composition root owns the try/catch). */
  readonly logError: (message: string) => void
  /** The exact live Agent of the current owner, or undefined. */
  readonly liveAgent: () => ExactAgent | undefined
  /** The ownership core (generation + subject fence + transition read). */
  readonly ownership: {
    generation(): number
    captureSubject(): SessionSubject | undefined
    /** A transition is queued or already holds the barrier (pull-back gate). */
    transitionPending(): boolean
  }
  /** The session-scope authority (live-scope capture + currentness fence). */
  readonly scope: {
    captureLive(): LiveSessionScope | undefined
    isCurrent(scope: LiveSessionScope): boolean
    requireLive(): LiveSessionScope
  }
  /** The bound session runtime seams the submission path drives. */
  readonly session: {
    ensureSession(): Promise<void>
    beginCommandSettlement(): void
    abortCommandSettlement(): void
    settleCommandSettlement(): void
    trackSettlementWork(work: Promise<unknown>): void
  }
  /** The bound submission runtime (the SOLE writer/admission owner). */
  readonly submissionRuntime: {
    withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
    submitPrompt(submission: PromptSubmission): Promise<void>
    deferQueueRecall(recall: PendingQueueRecall): void
  }
  /** The A5b-3 command authority owner. */
  readonly command: SubmissionCommandAuthority
  /** The raw command-registry plane. */
  readonly commandPlane: SubmissionCommandPlane<ExactAgent>
  /** The selected backend kind (PR4 §1.3): 'direct' keeps the in-process
   *  command-service dispatch surface for TUI-owned lines; any other value
   *  routes them through the Client registry. */
  readonly backendKind: 'direct' | 'remote'
  /** The semantic backend port slices the submission path reads. */
  readonly backend: {
    readonly hostFile: HostFilePort
    readonly pendingInputReader: PendingInputReader
    readonly sessionWriter: SessionWriter
    readonly hostCommand: HostCommandPort
  }
  /**
   * The INJECTED submission-presentation source (M3-4 PR2): the official
   * `SessionSnapshot.pendingSubmissions` read on the Remote branch. Absent
   * on Direct — the controller then wires its own ledger (the unchanged
   * Direct optimistic identity).
   */
  readonly submissionPresentation?: SubmissionPresentationSource
  /** The per-TUI draft stores. */
  readonly drafts: {
    readonly images: DraftImageStore
    readonly files: DraftFileStore
  }
  /** The status owner seam (the history cwd read). */
  readonly status: { sessionCwd(): string }
  /** The mounted-surface pending-input refresh. */
  readonly surface: { refreshPendingInput(): void }
  /** The input-history owner seams (the owner's write policy + the
   *  deferred-start ordering gate). */
  readonly history: {
    persist(record: { readonly text: string; readonly sessionId: string | undefined; readonly hasAttachments: boolean; readonly timestamp: number }): void
    persistAfterSession(resolveSession: () => Promise<string | undefined>, persist: (sessionId: string | undefined) => void): Promise<void>
  }
  /** The subagent viewer guard. */
  readonly viewer: { isViewing(): boolean }
  /** The client command-bridge read surface. */
  readonly extensions: SubmissionExtensionsDeps
  /** The client artifact-save owner. */
  readonly artifacts: { start(name: 'export' | 'transcript', agent: ExactAgent): void }
  /** The user-shell owner (the run/inspect seam). */
  readonly shell: {
    run(text: string, ackToken: number | undefined): void
    interrupt(): void
  }
  /** The live model-selection read (the outgoing message's provider/model). */
  readonly model: {
    readonly selected: { readonly current: { readonly provider: string; readonly model: string } | undefined }
  }
  /** The image submission services (read at construction, like the old site). */
  readonly image: {
    attachments(): PrepareInputDeps['attachments']
    llm(): PrepareInputDeps['llm']
  }
  /** The Direct TUI-settings facade (read live). */
  readonly tuiSettings: { get(): TuiSettingsDoc } | undefined
  /** The exact owner-subject currentness fence. */
  readonly captureMatches: (subject: SessionSubject | undefined) => boolean
  /** The transport-forked prepare seam (M3-4 PR3 §10/§12): absent keeps the
   * Direct prepareUserMessage pipeline; a Remote selection injects the SAME
   * PreparedPrompt path the plain-prompt flow uses, so steer and prompt share
   * one preparation authority per transport (never a Direct UserMessage into
   * the Remote serializer). */
  readonly prepareTransport?: (text: string, requestId: string) => Promise<unknown>
  /** The owner-resolved per-Agent prompt admission window. */
  readonly direct: {
    withPromptAdmission<T>(agent: ExactAgent, hasImages: boolean, task: () => Promise<T>): Promise<T>
  }
  /** The ONE exit orchestration. */
  readonly requestExit: () => void
  /** Whether the captured agent has an active plan (the bare /plan toggle). */
  readonly isPlanActive: (agent: ExactAgent) => boolean
}

/** The submission controller as the rest of the application consumes it. */
export interface SubmissionController {
  /** Submit one user input end to end. */
  submit(text: string, request?: ComposerSubmitRequest): void
  /** Steer one draft into the running turn.
   *  `consumeDraft: true` makes THIS owner clear the editor after snapshotting
   *  the persist facts; the caller leaves it unset when it already consumed the
   *  draft (TuiApp's own Ctrl+S clears and notifies before calling `onSteer`,
   *  so a second clear here would notify/revision twice). */
  steer(text: string, options?: { readonly consumeDraft?: boolean }): void
  /** Alt+Up: pull every queued occurrence back into the editor draft. */
  dequeue(): void
  /** Abort the local shell and interrupt the live Agent (Esc / cancel). */
  abortLocalShell(): void
  /**
   * The owner's writer SECTION for an external owner that already knows its
   * exact owner (the local shell / the subagent-delivery adapter): capture the
   * live scope at the SAME synchronous admission point and enter through the
   * submission runtime's writer, so the operation barrier keeps exactly ONE
   * admission owner. A stale capture refuses with `SessionScopeSupersededError`.
   */
  withWriterSection<T>(task: () => Promise<T>): Promise<T>
  /** Settle the local submit-ack row (token-scoped when given). */
  settleLocalSubmitAck(reason: string, options?: { token?: number; terminal?: boolean }): void
  /** Reset the submission latency timeline (a dead submission's baseline). */
  resetSubmitLatency(): void
  /** Drop every client-local submission echo (a session swap). */
  clearPending(): void
  /** Record one latency phase for the diagnostic channel. */
  markLatency(sessionId: string | undefined, phase: SubmitLatencyPhase): void
  /** Correlate one authoritative durable occurrence by request id. */
  observeDurable(rpcId: string): void
  /** The client-local presentation echoes for one session. */
  snapshotEchoes(sessionId: string | undefined): readonly import('../../submission-presentation.ts').SubmissionPresentationItem[] | undefined
  /** The image submission deps the command runner consumes. */
  prepareDeps(): PrepareInputDeps
  /** Publish one local submission echo. The composition root resolves the
   *  exact Agent and reports the facts; the OWNER derives the placement. */
  beginLocalSubmission(input: {
    readonly requestId: string
    readonly text: string
    readonly mode: 'queue' | 'steer'
    readonly running: boolean
    readonly sessionId: string | undefined
    readonly generation: number
    readonly ackToken: number
  }): void
  /** Remove one local submission echo on a known terminal exit. */
  settleLocalSubmission(requestId: string | undefined): void
  /** Start the latency dispatch mark for one session. */
  markDispatch(sessionId: string | undefined): void
  /** Prepare the outgoing message (image/file admission + canonicalization). */
  prepareMessage(text: string, requestId: string): Promise<unknown>
}

/** Create the submission/input controller (plan §A5b-4). */
export function createSubmissionController<ExactAgent extends SubmissionAgentLike>(
  deps: SubmissionControllerDeps<ExactAgent>,
): SubmissionController {
  /**
   * The busy/steer and shell-submit writer admission (A3-4, A5b-6): external
   * owners receive a writer SECTION, not the raw barrier. It captures the live
   * scope at the SAME synchronous admission point and enters through
   * `SubmissionRuntime.withWriter`, so the operation barrier has exactly ONE
   * admission owner and a stale capture refuses with
   * `SessionScopeSupersededError`.
   */
  const withWriterSection = <T>(task: () => Promise<T>): Promise<T> => {
    const scope = deps.scope.captureLive()
    if (scope === undefined) return Promise.reject(new SessionScopeSupersededError())
    return deps.submissionRuntime.withWriter(scope, task)
  }

  /** The display text of one client-local submission echo: the draft text
   * with its attachment placeholders expanded to compact markers, so an
   * attachment-only submission is never an empty pending row. The SAME
   * expansion decides the foldability fact: a submission carrying any
   * attachment marker is not text-only and must render in full. */
  
  const localEcho = (text: string): { text: string; foldableText: boolean } => {
    const parts: string[] = []
    let foldableText = true
    for (const segment of expandAttachmentPlaceholders(text, deps.drafts.images, deps.drafts.files)) {
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
    // The caller's classification of THIS LINE (PR5 v2 §1C-7): a Client
    // command (TUI or extension) refuses staged attachments; a genuine
    // Host command follows the HOST descriptor's own `attachments`
    // declaration carried by the classification; skills and ordinary
    // submissions are multimodal. Never re-derived from the advertised
    // union here (review R6-3: the union lets a same-name Client
    // descriptor overwrite the winning Host declaration).
    classification: CommandLineClassification,
  ): string | undefined => {
    if (!draftHasAttachments(draft, deps.drafts.images, deps.drafts.files)) return undefined
    // §1C-4/§3 (review R7-2): the classification is the ONLY input. A parallel
    // `isSkillInvocation` predicate must not outrank the Host precedence — an
    // argued `/skill <name>` whose name a GENUINE Host command owns (or a live
    // wrapper whose name a later scoped Host command owns) is a `host-command`
    // and follows the HOST descriptor's declaration. A real skill invocation
    // classifies as `skill-invocation` and falls through to the multimodal
    // return at the end, exactly as before.
    if (classification.kind === 'client-command') {
      return 'Attachments cannot be included in a user-shell command.'
    }
    if (classification.kind === 'host-command') {
      if (classification.attachments !== true) {
        return `/${parsed.name} does not accept attachments; remove them first`
      }
      if (draftHasFiles(draft, deps.drafts.images, deps.drafts.files)) {
        return `/${parsed.name} cannot receive file attachments in this client; remove them first`
      }
    }
    return undefined
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
  const commandSubmitAttachments = (draft: string) => expandImagePlaceholders(draft, deps.drafts.images)
    .flatMap(segment => segment.type === 'image' ? [segment.image] : [])
    .map(image => ({
      type: 'image' as const,
      mediaType: image.mediaType,
      data: Buffer.from(image.bytes).toString('base64'),
      ...(image.name === undefined ? {} : { name: image.name }),
    }))

  /** The official `beginSubmission` placement for one local echo. */
  const submissionPlacement = (mode: 'queue' | 'steer', running: boolean): PendingSubmissionPlacement =>
    running ? (mode === 'steer' ? 'steering' : 'queued') : 'transcript'

  /** Error sink for a failed session creation: restore the draft and
   * surface the reason instead of silently dropping the submission. The
   * classification diagnostics are owned by runOwned (label + session +
   * error); this sink only restores the editor and notifies the user.
   * (Cancellation never reaches here: runOwned routes it to onCancel.) */
  
  const failSubmission = (draft: string) => (error: unknown): void => {
    if (deps.signal.aborted) return
    // Correctness side effect FIRST: restore the draft (the editor was
    // cleared before submit) — the error text is best-effort afterwards,
    // so a hostile value can never prevent the user's input from coming
    // back. (The classification diagnostics are owned by runOwned.)
    deps.app().setEditorText(mergeDraft(deps.app().getDraft(), draft))
    const message = safeErrorMessage(error)
    // Image intake/admission/capability failures are THEIR OWN actionable
    // errors ("Current model ... does not support image input") — wrapping
    // them in "could not start a session" misleads when a session already
    // exists (review finding).
    if (error instanceof ImageInputError) {
      deps.app().notify(message, 'error')
      return
    }
    try {
      deps.logError(`tui-runner: session creation failed: ${message}`)
    } catch {
      // The cordis logger must not block the notice.
    }
    deps.app().notify(`could not start a session: ${message}`, 'error')
  }

  const restoreSubmissionDraft = (draft: string): void => {
    if (deps.signal.aborted) return
    deps.app().setEditorText(mergeDraft(deps.app().getDraft(), draft))
  }

  // ── Local submit acknowledgement + latency timeline (submit-ack.ts /
  // submit-latency.ts) ── the immediate "Submitting…" / "Queued…" row
  // between the editor clearing and the FIRST authoritative DSH event,
  // and the T0-T5 phase timings for the diag channel. The window is real
  // even without any per-submit persistence check: session create, image
  // admission
  // and the host pre-step all delay `user/message`.
  
  const localSubmitAck: SubmitAckState = freshSubmitAckState()

  const submitLatencyTracker = new SubmitLatencyTracker({ sink: deps.diag })

  /**
   * Client-local submission echoes (D2.1 follow-up): the presentation-only
   * bridge between the editor clearing and the authoritative inbox/durable
   * occurrence. Keyed by the request id minted before the first async
   * preparation await and persisted on the Direct user-message source as
   * `rpcId`, so the handoff correlates by identity — never by text.
   */
  
  const pendingSubmissions = new PendingSubmissions()

  /**
   * The client-local presentation source the queue/transcript handoff reads
   * (D2.2 → M3-4 PR2): Direct wires the ledger above; a Remote selection
   * injects the official `SessionSnapshot.pendingSubmissions` source
   * (`RemoteSubmissionPresentation`) so the two optimistic identities never
   * run together. The pending-presentation join stays the ONE UI join.
   */
  const submissionPresentation: SubmissionPresentationSource = deps.submissionPresentation
    ?? new DirectSubmissionPresentation(pendingSubmissions)

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
    const detail: SubmitPendingDetail = deps.liveAgent()?.status === 'running' ? 'queued' : 'submit'
    const token = acceptSubmitAck(localSubmitAck, { detail, now: Date.now() })
    submitLatencyTracker.accept(deps.liveAgent()?.session.id)
    deps.app().setSubmitPending(detail)
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
    if (deps.isCleanedUp()) return
    if (options.token !== undefined && options.token !== localSubmitAck.epoch) {
      deps.diag.debug('submit ack terminal settle superseded', { reason, token: options.token, current: localSubmitAck.epoch })
      return
    }
    const elapsed = settleSubmitAck(localSubmitAck, { now: Date.now() })
    if (options.terminal === true) submitLatencyTracker.reset()
    if (elapsed === undefined) return
    deps.diag.debug('submit ack settled', { reason, elapsed: `${elapsed}ms` })
    deps.app().setSubmitPending(undefined)
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
  
  const installLocalEcho = (
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
    deps.surface.refreshPendingInput()
    if (placement !== 'transcript') settleLocalSubmitAck('local pending echo', { token: ackToken })
  }

  /** Remove one local submission echo on a known terminal exit. */
  
  const settleLocalSubmission = (requestId: string | undefined): void => {
    if (requestId === undefined) return
    pendingSubmissions.settle(requestId)
    deps.surface.refreshPendingInput()
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
    if (deps.signal.aborted) return
    // NOTE: the pending submit ack is settled by the CALLER with its own
    // gesture token (an untokenized settle here would let one
    // workflow's failure clear a newer gesture's row).
    const message = safeErrorMessage(error)
    if (error instanceof ImageInputError) {
      deps.app().notify(message, 'error')
      return
    }
    try {
      deps.logError(`tui-runner: submission failed: ${message}`)
    } catch {
      // The cordis logger must not block the notice.
    }
    // A followup/steer against an EXISTING session is not a session
    // creation failure — "could not start a session" would mislead
    // (review finding).
    const prefix = deps.liveAgent() === undefined ? 'could not start a session' : 'submission failed'
    deps.app().notify(`${prefix}: ${message}`, 'error')
  }

  /** The image submission surface (plan §13): the live attachment/llm
   * services + the CURRENT provider/model, re-read at submit time (the
   * TUI supports runtime model switching — never a startup snapshot). */
  
  const submitDeps: PrepareInputDeps = {
    attachments: deps.image.attachments(),
    get fileStore() { return deps.drafts.files },
    signal: deps.signal,
    llm: deps.image.llm(),
    // The `@`-mention send seam (M1.10 → M3-3A official semantics): the
    // submitted text stays LITERAL — the Host's FILE_REFERENCE_PROMPT owns
    // relative-path resolution — and the seam routes through the port so a
    // future official carrier (if one ever exists) lands in one place.
    canonicalizeMentions: (text) => deps.backend.hostFile.canonicalizeMentions({ kind: 'session', sessionId: deps.liveAgent()?.session.id ?? '' }, text),
    sessionCwd: () => deps.status.sessionCwd(),
    currentModel: () => {
      // The AUTHORITATIVE model for the next step is the mutable
      // selection's `current` (/model writes it; prompt assembly reads
      // it) — never `agentNow().options`, which holds the agent's launch
      // configuration and does not move on /model (review finding 1).
      const current = deps.model.selected.current
      if (current !== undefined) return { provider: current.provider, model: current.model }
      // No selection assembled yet (pre-/model or a sessionless start):
      // fall back to the agent's launch options as the best known pair.
      const agent = deps.liveAgent()
      if (agent === undefined) return undefined
      // (Renamed local: `model` is the model-selection owner in this scope.)
      const { provider, model: launchModel } = agent.options
      return provider === undefined || launchModel === undefined ? undefined : { provider, model: launchModel }
    },
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
    const submittedAgent = deps.liveAgent()
    const submittedGeneration = deps.ownership.generation()
    const submittedSubject = deps.ownership.captureSubject()
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
      && deps.command.wasAdvertisedClaim(parsedAtSubmit.name) === true
    // The host catalog's view of the line at SUBMIT time, captured before any
    // session creation: a line it already knew to be a NON-invocation (an
    // argued line of an execute-kind command) stays one — no later catalog
    // change may turn it into an invocation except the final catalog
    // actually CLAIMING it.
    const submitOriginClaim = parsedAtSubmit === undefined ? undefined : deps.command.hostOriginClaimOf(parsedAtSubmit)
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
      || (submitOriginClaim?.claimed !== true
        // §D3 line authority (round 4) + §1C-4 (review R7-1): the submit-time
        // echo gate reads the GENUINE Host-origin claim above and the SAME
        // NAME-authority primitive as the delivery gate below
        // (`isLocalCommandLine` with `hostCatalogResolves`, which answers the
        // origin map's NAME ownership): a genuine Host name is never a
        // TUI-local line, while a TUI built-in's own Client registration is
        // never Host territory.
        // `/export foo` is an ordinary submission and gets its immediate
        // echo like every prompt, instead of silently vanishing behind a
        // blocked FIFO turn. Skill invocations keep their own exclusion.
        // §1C-6 (whole-PR F4): the TUI term is the LIVE Client registry's
        // exact-line claim — the static name list never answers ownership.
        // §1C-4 keeps a genuine Host NAME out of the TUI family.
        && !(deps.command.hostCatalogResolves(parsedAtSubmit.name) === false
          && deps.command.clientClaimsLine(parsedAtSubmit))
        // §1C-5 (whole-PR F2): the skill exclusion applies only where the line
        // is NOT a genuine Host-origin name. A Host name that does not claim
        // this argued line is an ORDINARY submission, so a live wrapper
        // sharing its name must not deny it the immediate echo.
        && !(deps.command.isSkillInvocation(parsedAtSubmit, text)
          && deps.command.hostCatalogResolves(parsedAtSubmit.name) === false))
    // Install the echo NOW for a known ordinary prompt on an existing
    // session — before the FIFO turn and the asynchronous admission. A
    // deferred start installs after the session materializes, below.
    let localEchoInstalled = false
    if (ordinaryPromptAtSubmit && submittedAgent !== undefined && !deps.isCleanedUp()) {
      installLocalEcho(
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
      && deps.extensions.findContribution(parsedAtSubmit.name) !== undefined
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
    // §D3 ORDER: the AUTHORITATIVE HOST CATALOG is consulted FIRST — a
    // resolved Host name owns the line even when a TUI built-in or a skill
    // wrapper shares it (e.g. the frozen rc.2 Web-only Host `/export`
    // colliding with the TUI's Client `/export`). §1C-4 (review R7-1): the
    // discriminator is the GENUINE Host-origin LINE claim — the effective
    // winner with this surface's mirrors excluded — never the advertised
    // union, which a same-name Client descriptor can overwrite (a genuine
    // Host leading-input `/export` next to the TUI's execute-kind Client
    // `/export` reads `claimed:false` from the union and would be wrongly
    // handed to the ordinary-submission route).
    // §1C-5 (whole-PR F1): the SUBMIT-TIME non-invocation is STICKY. A name the
    // genuine Host origin resolved but did NOT claim on this line was an
    // ordinary submission when it was submitted; a later catalog disappearance
    // (a deferred, session-scoped re-resolution, or a definition that went
    // away) must not hand it to a same-name static TUI route or a live skill
    // wrapper. Only a FINAL genuine claim may turn it back into a command.
    const effectiveOriginClaim = (parsed: { name: string; rawInput?: string } | undefined) => {
      if (parsed === undefined) return undefined
      const finalClaim = deps.command.hostOriginClaimOf(parsed)
      if (finalClaim?.claimed === true) return finalClaim
      return submitOriginClaim?.claimed === false ? submitOriginClaim : finalClaim
    }
    const commandPlaneOwnsLine = (): boolean => {
      if (parsedAtSubmit === undefined) return true
      const originClaim = effectiveOriginClaim(parsedAtSubmit)
      if (originClaim !== undefined) return originClaim.claimed !== false
      // §1C-5 NAMESPACE ORDER: a LIVE skill wrapper owns its own slash line
      // BEFORE the Client-registration terms — the wrapper's handler turns
      // `/name args` into loadSkill, and the wrapper's own Client registration
      // (an `execute`-shaped definition without `input`) must not disqualify it.
      if (deps.command.isSkillWrapperName(parsedAtSubmit.name) === true) return true
      // §1C-6 (whole-PR F4): a LIVE Client definition that does not claim THIS
      // line (an argued line of a definition without an `input` descriptor)
      // owns nothing — the line is an ordinary submission, exactly like the
      // argued line of an execute-kind Host command.
      if (deps.command.clientClaimsLine(parsedAtSubmit)) return true
      if (deps.command.clientCommands.get(parsedAtSubmit.name) !== undefined) return false
      // The final catalog resolves nothing at all: the plane decides (a
      // session-scoped command the standing view cannot see).
      return submitOriginClaim?.claimed !== false
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
    const tag = `${text.slice(0, 14)}:${submitRequestId.slice(0, 8)}`
    const submitTurn = takeSubmitTurn()
    runOwned('submit', () => runReservedSubmit({
      reserve: (t) => {
        try {
          const releasePin = pinDraftAttachments(t, deps.drafts.images, deps.drafts.files)
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
        if (deps.isCleanedUp()) return
        // The deferred-start gate (history-persist.ts): the history row
        // is written AFTER the session exists, with the FINAL session
        // id — the first prompt of a deferred start creates the session
        // inside resolveSession, and a row written before creation would
        // carry no sessionId and vanish from the Ctrl+R `Current
        // session` scope. A resolution that REJECTS (session creation
        // failed) persists nothing — the submission never reached a
        // session; a resolution that resolves undefined (sessionless)
        // persists a row without a sessionId.
        await deps.history.persistAfterSession(
          async () => {
            if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) return undefined
            await deps.session.ensureSession()
            if (deps.isCleanedUp()) return undefined
            return deps.liveAgent()?.session.id
          },
          (sessionId) => {
            if (deps.isCleanedUp()) return
            if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) return
            persistHistory(sessionId)
          },
        )
        if (deps.isCleanedUp()) return
        const agent = deps.liveAgent()
        if (agent === undefined) {
          // Nothing can be written (degraded resolve after a successful
          // creation): the wait ends here with NO write — the pending
          // row must not outlive the submission.
          settleLocalSubmission(submitRequestId)
          settleLocalSubmitAck('submit resolved without an agent', { token: submitAckToken, terminal: true })
          return
        }
        // PR4 §1.3: the REAL-Direct-Agent discriminator for the TUI_BUILTIN
        // route. On Remote `liveAgent()` is the transport-neutral structural
        // projection `{status, session:{id}}`; on Direct it is the in-process
        // Agent. A cheap structural marker separates them: the Direct Agent
        // always carries its mutable `status` string AND an `inbox`-bearing
        // object graph — the projection never does. The Client registry
        // executes the Remote branch (never `ctx.commands.execute` on the
        // projection).
        const directAgent = 'inbox' in (agent as object) ? (agent as ExactAgent) : undefined
        if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) {
          const merged = mergeDraft(deps.app().getDraft(), text)
          deps.app().setEditorText(merged)
          settleLocalSubmission(submitRequestId)
          settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
          deps.app().notify(merged === text
            ? 'the session changed while waiting for submission — try again'
            : 'the draft changed while waiting for submission — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
      // Capture THIS agent's session identity so the write below can
      // never target a session a switch already left behind (the async
      // admission below yields). ONE atomic scope capture: the same record
      // fences the write and admits it through `SessionRuntime.withWriter`.
      const generation = deps.ownership.generation()
      const scope = deps.scope.captureLive()
      if (scope === undefined) throw new Error('a resolved live submission must carry a live session scope')
      // TOCTOU re-validation: the session must still be the exact one the
      // identity was captured from, or the submission is aborted for a
      // retry against the new session.
      if (!deps.scope.isCurrent(scope)) {
        const merged = mergeDraft(deps.app().getDraft(), text)
        deps.app().setEditorText(merged)
        settleLocalSubmission(submitRequestId)
        settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
        deps.app().notify(merged === text
          ? 'the session changed while sending — try again'
          : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
        return
      }
      // From here on the CAPTURED agent is used — never the mutable
      // agentNow(): writing through a re-read closure variable could
      // target a session the identity check did not see (a switch
      // between the check and the write).
      // PR4 §1.3: the command-dispatch window exists on BOTH branches —
      // Direct through the in-process service, Remote through the Client
      // registry + HostCommandPort. `commandPlane.available()` therefore no
      // longer gates the window: the Remote branch supplies its own
      // always-available execution owners.
      {
        // Bare `/plan` toggles: when plan mode is already active it exits
        // instead of re-entering (the official command needs `/plan off`).
        const parsed = parseCommand(text)
        const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
          && deps.isPlanActive(agent) === true
          ? '/plan off'
          : text
        // The HostCommandPort submission + the agent-facing fallback live in
        // the submission runtime; the runner supplies the command-plane and
        // TUI hooks.
        executeHostCommandSubmission({
          isDisposed: () => deps.isCleanedUp(),
          notify: (message, kind) => {
            if (deps.isCleanedUp()) return
            deps.app().notify(message, kind)
          },
          loggerError: (message) => {
            try {
              deps.logError(message)
            } catch {
              // The cordis logger must not block the user notice.
            }
          },
          readDraft: () => deps.app().getDraft(),
          mergeDraftIntoEditor: (value) => {
            const merged = mergeDraft(deps.app().getDraft(), value)
            deps.app().setEditorText(merged)
            return merged === value
          },
          restoreSubmissionDraft: (value) => restoreSubmissionDraft(value),
          consumeDraftAttachments: (value) => consumeDraftAttachments(value, deps.drafts.images, deps.drafts.files),
          draftHasAttachments: (value) => draftHasAttachments(value, deps.drafts.images, deps.drafts.files),
          pinDraftAttachments: (value) => pinDraftAttachments(value, deps.drafts.images, deps.drafts.files),
          settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
          settleSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
          notifySubmissionFailure: (error) => notifySubmissionFailure(error),
          isScopeCurrent: (value) => deps.scope.isCurrent(value),
          refuseByTransitionFence: (value) => refuseByTransitionFence(
            value,
            () => deps.app().getDraft(),
            (t) => deps.app().setEditorText(t),
            (m, k) => deps.app().notify(m, k),
          ),
          // DEFERRED AUTHORITY (§1C-8): re-run the SAME classifier against
          // the FINAL catalog BEFORE the command plane runs, and re-apply
          // the attachment policy from that final classification (the
          // dynamic contribution term stays STICKY to the submit-time
          // route, exactly as the sticky-rules note in §1C-8 records).
          //
          // §1C-5 (review R6-4): the facts come from ONE helper so the
          // deferred sites can never drift from the submit-time decision —
          // in particular the skill-invocation FIRST rule (an argued
          // `/skill <name>` is never absorbed into a Client command by the
          // BARE picker's LOCAL_COMMANDS membership) and the wrapper-outranks-
          // contribution precedence.
          lateAttachmentRefusal: () => {
            if (parsed === undefined) return undefined
            const finalSkillInvocation = deps.command.isSkillInvocation(parsed, text)
            const finalClassification = classifyCommandLine({
              // §1C-5 (whole-PR F1): the sticky submit-time non-invocation
              // survives a final-catalog disappearance.
              hostOriginClaim: effectiveOriginClaim(parsed),
              // §1C-5 (review R6-4): the skill-invocation rule comes FIRST —
              // a Client registration must never absorb an argued
              // `/skill <name>` into a Client command. §1C-6 (whole-PR F4):
              // the TUI term is the LIVE Client registry claim plus the
              // BARE-line contribution, never a static name list.
              tuiCommand: !finalSkillInvocation
                && (deps.command.clientClaimsLine(parsed)
                  || (isBareCommandLine(parsed) && deps.extensions.isLocal(parsed.name, LOCAL_COMMANDS) === true)),
              // The wrapper-outranks-contribution precedence (§1C-5).
              extensionCommand: clientLocalAtSubmit && !finalSkillInvocation
                && isBareCommandLine(parsed)
                && deps.command.isSkillWrapperName(parsed.name) !== true
                && deps.extensions.findContribution(parsed.name) !== undefined,
              skillInvocation: finalSkillInvocation,
            })
            return attachmentRefusal(parsed, text, finalClassification)
          },
          commandSubmitAttachments: (value) => commandSubmitAttachments(value),
          isTuiOwnedCommand: () => parsedAtSubmit !== undefined
            // §1C-7: the TUI-owned route is the classifier's client-command
            // (tui) family evaluated against the FINAL catalog — a genuine
            // Host-origin name (mirrors excluded) disqualifies it first.
            // (Distinct question from the line classification: a skill
            // invocation is agent-facing INPUT yet its handler still lives in
            // the TUI's own registry, so the skill/wrapper terms stay OUT of
            // this predicate.)
            && classifyCommandLine({
              // §1C-5 (whole-PR F1): the sticky submit-time non-invocation.
              hostOriginClaim: effectiveOriginClaim(parsedAtSubmit),
              // §1C-6 (whole-PR F4): the LIVE Client registry claim.
              tuiCommand: deps.command.clientClaimsLine(parsedAtSubmit)
                || deps.command.isSkillWrapperName(parsedAtSubmit.name) === true,
              extensionCommand: false,
              skillInvocation: false,
            }).kind === 'client-command',
          commandPlaneOwnsLine,
          submittedHostClaim: () => parsedAtSubmit === undefined ? undefined : deps.command.hostOriginClaimOf(parsedAtSubmit),
          commandSignal: () => deps.signal,
          invokeCommandPlane: ({ toggled: commandLine, commandPlaneLine, tuiOwnedCommand, submittedAttachments, signal: commandSignal }) =>
            deps.command.withCommandDelivery(delivery, () => {
              if (!commandPlaneLine || parsedAtSubmit === undefined) {
                return Promise.resolve({ kind: 'committed', matched: false } as HostCommandOutcome)
              }
              if (tuiOwnedCommand) {
                // PR4 §1.3 — the explicit TUI_BUILTIN/SKILL_WRAPPER route.
                // A REAL Direct Agent (the branch where the in-process
                // command service owns the dispatch surface) keeps the
                // existing executor path unchanged; the Remote structural
                // projection executes through the CLIENT registry — the
                // projected agent must never reach `ctx.commands.execute`.
                if (directAgent !== undefined) {
                  return deps.commandPlane.execute(directAgent, commandLine, submittedAttachments, commandSignal).then((execution: HostCommandExecution | undefined) => {
                    return execution === undefined
                      ? { kind: 'committed', matched: false } as const
                      : { kind: 'committed', matched: true, execution } as const
                  })
                }
                return deps.command.clientCommands.execute({ line: commandLine, signal: commandSignal }).then((execution) => {
                  return execution === undefined
                    ? { kind: 'committed', matched: false } as const
                    : { kind: 'committed', matched: true, execution } as const
                })
              }
              // The HOST route: the HostCommandPort submission enters the
              // barrier through the submission runtime (the M3 insertion
              // point).
              return deps.submissionRuntime.withWriter(scope, () => deps.backend.hostCommand.execute({
                sessionId: agent.session.id,
                line: commandLine,
                attachments: submittedAttachments,
                signal: commandSignal,
              }))
            }),
          beginCommandSettlement: () => deps.session.beginCommandSettlement(),
          abortCommandSettlement: () => deps.session.abortCommandSettlement(),
          settleCommandSettlement: () => deps.session.settleCommandSettlement(),
          trackSettlementWork: (work) => deps.session.trackSettlementWork(work),
          captureCommandHealthRef: () => {
            // RE-CAPTURE at invocation time: the runOwned factory runs
            // SYNCHRONOUSLY right before execute().
            const liveCommandId = parsedAtSubmit === undefined
              ? undefined
              : deps.extensions.commandIdFor(parsedAtSubmit.name)
            return liveCommandId === undefined
              ? undefined
              : deps.extensions.recordHealthRef('command', liveCommandId)
          },
          clearCommandHealthError: (ref) =>
            deps.extensions.clearError(ref as { slot: string; id: string; owner: string }),
          recordCommandHealthError: (ref, error) =>
            deps.extensions.recordError(ref as { slot: string; id: string; owner: string }, error),
          readCommandDraftDisposition: (commandId) => deps.command.takeCommandDraftDisposition(commandId),
          shouldConsumeAdvertisedMiss,
          isIndeterminateSkillWrite: (error) => isIndeterminateSkillWrite(error),
          startArtifactSave: (name) => deps.artifacts.start(name, agent),
          submitPrompt: (submission) => deps.submissionRuntime.submitPrompt(submission),
          commandSessionId: () => agent.session.id,
          markTurnTransferred: () => { submitTurnTransferred = true },
          diag: deps.diag,
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
      },
      restore: (t) => restoreSubmissionDraft(t),
    }, text), {
      diag: deps.diag,
      sessionId: () => deps.liveAgent()?.session.id,
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
    // an unscoped row (`undefined`; Current directory / All directories),
    // while a local command submitted inside a live session scopes its row
    // to that session like every other local command (/status).
    sessionId: string | undefined,
  ): void => {
    // M5: a plugin-declared local command with a bridge handler routes
    // to the bridge FIRST (its rawInput is passed verbatim — never
    // re-parsed or rewritten, the skill rawInput regression gate); the
    // CLIENT command registry is the core-commands fallback (PR4 §1.5);
    // the Direct commands service is the LAST fallback and exists only on
    // the Direct branch (a Remote sessionless command must never reach a
    // Host `findHandler` for a TUI callback).
    const bridgeHandler = deps.extensions.handlerFor(parsed.name)
    const bridgeCommandId = deps.extensions.commandIdFor(parsed.name)
    // Captured at INVOCATION START (same generation fence as the
    // session command path).
    const bridgeCommandRef = bridgeCommandId === undefined
      ? undefined
      : deps.extensions.recordHealthRef('command', bridgeCommandId)
    // §1C-6 SINK INVARIANT: the same exact-line admission the registry's
    // `execute` enforces — an argued line of a definition WITHOUT an `input`
    // descriptor is not an invocation, so it falls through instead of running
    // a handler that never claimed the line.
    const clientHandler = deps.command.clientClaimsLine(parsed)
      ? deps.command.clientCommands.get(parsed.name)
      : undefined
    const planeHandler = clientHandler === undefined && deps.backendKind === 'direct'
      ? deps.commandPlane.findHandler(parsed.name)
      : undefined
    if (bridgeHandler === undefined && clientHandler === undefined && planeHandler === undefined) {
      // The "sessionless" command is actually unknown: it falls back to
      // a session dispatch — the history row goes through the
      // deferred-start gate (persist AFTER the session exists, with the
      // final session id), never a sessionless write here.
      dispatchViaSession(text, persistHistory, delivery)
      return
    }
    const invocation = {
      commandId: `cmd-local-${randomUUID()}`,
      agent: undefined as unknown as ExactAgent,
      rawInput: parsed.rawInput,
      signal: deps.signal,
    } as LocalCommandInvocation
    const handler = (bridgeHandler ?? (clientHandler !== undefined
      ? (invocation: LocalCommandInvocation) => clientHandler.handler(invocation as never)
      : planeHandler!)) as LocalCommandHandler
    if (handler === undefined) {
      dispatchViaSession(text, persistHistory, delivery)
      return
    }
    // A truly local command: the handler runs in-process, so no session is
    // needed for the EXECUTION. The row follows the call site's identity
    // (sessionless commands write an unscoped row; a local command inside
    // a live session carries that session id).
    persistHistory(sessionId)
    // An owned workflow: the result decides the notify, the failure lands
    // in diagnostics — runOwned (AGENTS.md), never a bare void. The
    // handler may be a SYNC implementation, so the factory must run inside
    // runOwned (a sync throw would otherwise escape before the entry).
    runOwned('local command', () => handler(invocation), {
      diag: deps.diag,
      sessionId: () => deps.liveAgent()?.session.id,
      onResult: (result) => {
        if (deps.isCleanedUp()) return
        if (result !== undefined && result.kind === 'error') {
          if (bridgeCommandRef !== undefined) deps.extensions.recordError(bridgeCommandRef, new Error(result.text))
          deps.app().notify(result.text)
        } else if (bridgeCommandRef !== undefined) {
          deps.extensions.clearError(bridgeCommandRef)
        }
      },
      onError: (error) => {
        if (deps.isCleanedUp()) return
        if (bridgeCommandRef !== undefined) deps.extensions.recordError(bridgeCommandRef, error)
        const message = safeErrorMessage(error)
        try {
          deps.logError(`tui-runner: local command failed: ${message}`)
        } catch {
          // The cordis logger must not block the user notice.
        }
        deps.app().notify(message, 'error')
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
    const steerDeps: SteerSubmissionDeps = {
      isDisposed: () => deps.isCleanedUp(),
      isViewing: () => deps.viewer.isViewing(),
      currentAgent: () => deps.liveAgent() as unknown as SteerSubmissionAgent | undefined,
      currentGeneration: () => deps.ownership.generation(),
      captureOwnerToken: () => deps.ownership.captureSubject(),
      isOwnerTokenCurrent: (token) => deps.captureMatches(token as SessionSubject | undefined),
      readPendingInput: (sessionId) => deps.backend.pendingInputReader.snapshot(sessionId),
      draftHasAttachments: (value) => draftHasAttachments(value, deps.drafts.images, deps.drafts.files),
      draftHasImages: (value) => draftHasImages(value, deps.drafts.images),
      clearSettledLocalMessages: () => deps.app().clearSettledLocalMessages(),
      mergeDraftIntoEditor: (value) => {
        const merged = mergeDraft(deps.app().getDraft(), value)
        deps.app().setEditorText(merged)
        return merged === value
      },
      notify: (message, kind) => {
        if (deps.isCleanedUp()) return
        deps.app().notify(message, kind)
      },
      acceptSubmitAck: () => acceptLocalSubmitAck(),
      settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
      settleSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
      beginLocalSteerEcho: ({ requestId, text: echoText, running, sessionId, generation, ackToken }) => {
        installLocalEcho(
          requestId,
          echoText,
          submissionPlacement(running ? 'steer' : 'queue', running),
          sessionId,
          generation,
          ackToken,
        )
      },
      takeSubmitTurn,
      pinDraftAttachments: (value) => pinDraftAttachments(value, deps.drafts.images, deps.drafts.files),
      persistAfterSession: deps.history.persistAfterSession,
      ensureSession: () => deps.session.ensureSession(),
      withPromptAdmission: (agent, hasImages, task) =>
        deps.direct.withPromptAdmission(agent as unknown as ExactAgent, hasImages, task),
      prepareMessage: (value, requestId) => prepareMessage(value, requestId),
      markDispatch: (sessionId) => submitLatencyTracker.mark(sessionId, 'dispatch'),
      restoreSubmissionDraft: (value) => restoreSubmissionDraft(value),
      notifySubmissionFailure: (error) => notifySubmissionFailure(error),
      consumeDraftAttachments: (value) => consumeDraftAttachments(value, deps.drafts.images, deps.drafts.files),
      writerSection: withWriterSection,
      pendingInputReader: deps.backend.pendingInputReader,
      writer: deps.backend.sessionWriter,
      diag: deps.diag,
    }
    if (onlyDraft) deliverBusy(steerDeps, { text, persistHistory })
    else steer(steerDeps, { text, persistHistory })
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
    const historyTs = Date.now()
    const historyHasAttachments = draftHasAttachments(text, deps.drafts.images, deps.drafts.files)
    return (sessionId: string | undefined): void => {
      deps.history.persist({ text, sessionId, hasAttachments: historyHasAttachments, timestamp: historyTs })
    }
  }

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
    if (text.trim() === '' && !draftHasAttachments(text, deps.drafts.images, deps.drafts.files)) return
    // Plain `exit` quits (shell muscle memory): the exact trimmed word
    // intercepts BEFORE any session creation or submission, so typing
    // `exit` with a deferred start never births a session. `/exit` remains
    // the command form; any other prompt still goes to the model.
    if (isPlainExitPrompt(text)) {
      deps.requestExit()
      return
    }
    // The subagent viewer is READ-ONLY: submitting while viewing would
    // silently send to the PARENT session. Refuse with a notice instead.
    if (deps.viewer.isViewing()) {
      deps.app().setEditorText(mergeDraft(deps.app().getDraft(), text))
      deps.app().notify('viewing a subagent — Esc returns before submitting', 'info')
      return
    }
    // A fresh submission dismisses settled local cards (completed `!`/`!!`
    // runs): the card is a live view, not a record — the transcript row
    // (context runs) or the next input takes over. Running cards survive
    // so a live stream is never dismissed by a concurrent submit.
    deps.app().clearSettledLocalMessages()
    // Persist the submitted line to the LIVE session's cwd input-history
    // file (kimi-style JSONL under $DSH_HOME/user-history — never the
    // settings document). Consecutive repeats are skipped like shell
    // history; a failed write is user-recoverable: notify instead of
    // dropping it. `!` shell lines persist verbatim so ↑ recall re-runs
    // the shell branch.
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
    const historyHasAttachments = draftHasAttachments(text, deps.drafts.images, deps.drafts.files)
    /**
     * Persist the submitted line under the given session identity. The
     * sessionId is a PARAMETER, resolved at the CALL SITE — the
     * deferred-start gate (history-persist.ts): an agent-facing
     * submission passes the FINAL session id AFTER the session exists
     * (the first prompt of a deferred start creates the session; a row
     * written before creation would carry no sessionId and vanish from
     * the Ctrl+R `Current session` scope). Sessionless submissions pass
     * undefined and stay visible in `Current directory` / `All
     * directories`. The trim/dedupe and the cwd/file resolution are the
     * input-history owner's write policy.
     */
    const persistHistory = (sessionId: string | undefined): void => {
      deps.history.persist({ text, sessionId, hasAttachments: historyHasAttachments, timestamp: historyTs })
    }
    // `!` runs the command on the Host and submits the completed
    // command+output to the session (kimi parity); `!!` runs on the Host
    // with the SAME execution locality but zero Session/model write (pi's
    // excluded-from-context escape hatch). `!!` is Session-EXCLUDED, never
    // sessionless (shell amendment M3-4 PR3): with no current Session the
    // gesture ensures one first and executes in that Session's Host
    // workspace, persisting the history row under that Session identity.
    if (text.startsWith('!')) {
      // A user-shell line is a UI control with NO attachment delivery path
      // (the shell owner neither admits nor consumes drafts): a staged
      // attachment must never become shell arguments, and the success path
      // must never consume it. Refuse and hand the draft (placeholder
      // intact) back, exactly like a local command.
      if (draftHasAttachments(text, deps.drafts.images, deps.drafts.files)) {
        deps.app().setEditorText(mergeDraft(deps.app().getDraft(), text))
        deps.app().notify('Attachments cannot be included in a user-shell command.', 'error')
        return
      }
      if (shellCommandOf(text) === '') {
        // A bare `!`/`!!` (no command) is a no-op — sessionless.
        persistHistory(undefined)
        return
      }
      // Local submit acknowledgement (plan D), armed AT THE GESTURE —
      // BEFORE ensureSession: a deferred/slow session create is part
      // of the no-feedback window this row exists to cover. The TOKEN
      // rides into the shell flow: its terminal exits settle only while
      // THIS gesture is still the newest one. Both modes arm it: a
      // sessionless `!!` also creates its execution Session now.
      const shellAckToken = acceptLocalSubmitAck()
      // An owned workflow: the session creation failure restores the draft
      // (failSubmission) — runOwned (AGENTS.md), never a bare void. The
      // history row is written AFTER the session exists (the
      // deferred-start gate), so a `!`/`!!` line that creates the session
      // carries its id.
      runOwned('user shell', () => deps.session.ensureSession().then(() => {
        persistHistory(deps.liveAgent()?.session.id)
        deps.shell.run(text, shellAckToken)
      }), {
        diag: deps.diag,
        sessionId: () => deps.liveAgent()?.session.id,
        onError: (error) => {
          // The session create failed: nothing will be written — the
          // ack row armed at the gesture is TERMINAL here (plan D).
          settleLocalSubmitAck('session creation failed', { token: shellAckToken, terminal: true })
          failSubmission(text)(error)
        },
        onCancel: () => {
          if (deps.isCleanedUp()) return
          // NOT wrapped in runReservedSubmit: nothing restores the draft
          // here, so a cancelled ensureSession would silently lose the
          // submitted text — merge it back first (no error notice: a
          // cancellation is not a failure), then end the ack row
          // terminally.
          deps.app().setEditorText(mergeDraft(deps.app().getDraft(), text))
          settleLocalSubmitAck('user shell cancelled', { token: shellAckToken, terminal: true })
        },
      })
      return
    }
    // A sessionless slash command runs locally BEFORE any session exists:
    // typing /exit, /settings, /help, ... must not create one (deferred
    // start). Everything else — session-backed commands, core commands
    // like /plan, and plain prompts — creates the session lazily. M5: a
    // plugin-declared sessionless command (CommandBridge) joins the set.
    const parsed = parseCommand(text)
    // PR5 v2 §1C-5/§1C-7: ONE semantic classification drives every sibling
    // gate below (attachment policy, busy delivery, early echo, the
    // namespace order, the deferred re-checks). Its Host term is the
    // GENUINE Host-origin claim (§1C-4 `hostOriginClaimOf`: this TUI's own
    // Direct compatibility mirrors are excluded, so a successfully mirrored
    // /status still classifies CLIENT_COMMAND — the PR4 regression class),
    // its Client terms come from the LIVE sources (the Client registry
    // seam, the extension contribution of a bare line, the skill-wrapper
    // state), never from a reconstructed name list.
    // §1C-5 line semantics FIRST (review R6-4): an argued `/skill <name>
    // ...` and a live dynamic wrapper are SKILL invocations — the static
    // LOCAL_COMMANDS membership of `skill` (the BARE picker) must never
    // absorb the argued form into a Client command.
    const skillInvocation = deps.command.isSkillInvocation(parsed, text)
    const classification = classifyCommandLine({
      hostOriginClaim: parsed === undefined ? undefined : deps.command.hostOriginClaimOf(parsed),
      // §1C-6 source fidelity (whole-PR F4): the TUI term is the LIVE Client
      // registry's EXACT-LINE claim — a registered definition owns the bare
      // token, and an argued line only when it declares an `input` descriptor
      // (the official `matchEnter` semantics). The static name list is not an
      // ownership source, and only a line that is NOT a skill invocation is a
      // Client command.
      tuiCommand: parsed !== undefined
        && !skillInvocation
        && deps.command.clientClaimsLine(parsed),
      // A live skill wrapper outranks a same-name extension contribution
      // (the wrapper route wins everywhere) — the extension term excludes
      // wrapper names.
      extensionCommand: parsed !== undefined
        && !skillInvocation
        && isBareCommandLine(parsed)
        && deps.command.isSkillWrapperName(parsed.name) !== true
        && deps.extensions.findContribution(parsed.name) !== undefined,
      skillInvocation,
    })
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
      // §1C-7: the attachment gate consumes the SAME classification — a
      // Client command (TUI or extension) refuses staged attachments, a
      // Host command follows the HOST descriptor's own declaration, skill
      // invocations and ordinary submissions stay multimodal.
      const refusal = attachmentRefusal(parsed, text, classification)
      if (refusal !== undefined) {
        deps.app().setEditorText(mergeDraft(deps.app().getDraft(), text))
        deps.app().notify(refusal, 'error')
        return
      }
    }
    // §1C-7 (whole-PR F4/F5): the sessionless LOCAL route consumes the ONE
    // classification — the TUI client-command family — instead of re-judging a
    // name against `SESSIONLESS_COMMANDS` alone. A genuine Host name whose
    // execute-kind descriptor does not claim the ARGUED form classifies as
    // ordinary-submission and must never be pulled back into the local surface.
    const isSessionless = parsed !== undefined
      && classification.kind === 'client-command'
      && classification.source === 'tui'
      && SESSIONLESS_COMMANDS.has(parsed.name)
    // §1C-7: the delivery gate consumes the SAME classification — every
    // Client command (TUI or extension) takes the local-command placeholder
    // (never steer), skill invocations and ordinary submissions follow the
    // busy queue/steer policy, Host commands ride the command path. A Host
    // -origin name that does not claim this line is an ORDINARY submission
    // (hostNameReserved), so an argued `/export foo` keeps the ordinary
    // prompt policy everywhere.
    const tuiLocalLine = classification.kind === 'client-command'
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
      : resolveSubmitDelivery(parsed, deps.liveAgent()?.status === 'running', request, deps.tuiSettings?.get().busyEnter, tuiLocalLine)
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
    if (classification.kind === 'host-command') {
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
    // §1C-7: the contribution gate consumes the SAME classification — only
    // the classifier's client-command(extension) family routes here (a
    // genuine Host-origin name, claimed or merely reserved, and a live
    // skill wrapper already outranked it inside the classifier; a TUI-owned
    // registration is the TUI branch below, never this one).
    const contribution = parsed === undefined
      || !(classification.kind === 'client-command' && classification.source === 'extension')
      ? undefined
      : deps.extensions.findContribution(parsed.name)
    if (parsed !== undefined && contribution !== undefined) {
      if (contribution.sessionless) {
        runLocalCommand(parsed, text, persistHistory, delivery, undefined)
        return
      }
      if (deps.liveAgent() !== undefined) {
        runLocalCommand(parsed, text, persistHistory, delivery, deps.liveAgent()?.session.id)
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
        reserve: (draft) => pinDraftAttachments(draft, deps.drafts.images, deps.drafts.files),
        run: async () => {
          await deps.session.ensureSession()
          if (deps.isCleanedUp() || deps.liveAgent() === undefined) return
          // AUTHORITY RE-CHECK after the session exists (§1C-8): the
          // deferred start commits a session whose scoped catalog the
          // standing view could not see, and the skill catalog may load with
          // it. The SAME origin-aware classifier is re-run against the FINAL
          // catalog: a genuine Host-origin NAME (mirrors excluded) or a TUI
          // skill wrapper outranks the contribution decided before the
          // session existed. The delivery resolved before the session
          // existed, so it is a queue-mode submission: `dispatchViaSession`
          // delivers the line itself.
          if (deps.command.hostCatalogResolves(parsed.name) || deps.command.isSkillWrapperName(parsed.name) === true) {
            dispatchViaSession(text, persistHistory, delivery)
            return
          }
          // IDENTITY + GENERATION FENCE: the client handler runs only while
          // the EXACT registration the user submitted is still live. A
          // dispose + reload (HMR) is a NEW bridge record — possibly under
          // the same owner/id — and a vanished name must never fall through
          // `runLocalCommand`'s name-only lookup (which would either run
          // the new generation's handler or deliver the line to the MODEL).
          if (deps.extensions.findContribution(parsed.name) !== submitted) {
            deps.app().notify(`/${parsed.name} is no longer available — the draft was restored, submit it again`, 'error')
            restoreSubmissionDraft(text)
            return
          }
          runLocalCommand(parsed, text, persistHistory, delivery, deps.liveAgent()?.session.id)
        },
        restore: (draft) => restoreSubmissionDraft(draft),
      }, text), {
        diag: deps.diag,
        sessionId: () => deps.liveAgent()?.session.id,
        onError: (error) => {
          if (deps.isCleanedUp()) return
          // The flow restored the editor BEFORE the reservation released;
          // this sink only notifies (never a second restore).
          deps.app().notify(safeErrorMessage(error), 'error')
        },
      })
      return
    }
    // 3. A recognized TUI-owned sessionless command: its history row is
    // sessionless — it must NEVER appear in Current session, whether or not
    // a session exists. Without a live agent it runs locally (and creates
    // none); with a live agent it dispatches through the session's command
    // service, but the persist closure still supplies undefined.
    // §1C-7: the sessionless LOCAL route (see `isSessionless`: the TUI
    // client-command family, LIVE-registry-derived, intersected with the
    // sessionless name set). Its delivery stays `queue`, so falling through can
    // never steer it.
    if (parsed !== undefined && isSessionless) {
      if (deps.liveAgent() === undefined) {
        runLocalCommand(parsed, text, persistHistory, delivery, undefined)
      } else {
        dispatchViaSession(text, () => persistHistory(undefined), delivery)
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
      // §1C-5 (whole-PR F2): the skill-delivery route consumes the semantic
      // family, never the raw predicate alone. A genuine Host name that does
      // NOT claim this argued line is an ORDINARY submission, so it takes the
      // ordinary steer path even while a live skill wrapper shares its name.
      const skillLine = deps.command.isSkillInvocation(parsed, text)
        && (parsed === undefined || deps.command.hostCatalogResolves(parsed.name) === false)
      if (skillLine) {
        dispatchViaSession(text, persistHistory, delivery)
        return
      }
      steerNow(text, true, persistHistory)
      return
    }
    dispatchViaSession(text, persistHistory, delivery)
  }

  const dequeue = (): void => {
      // Alt+↑: on the main surface, run the TUI-only recall-all extension:
      // remove every semantic `queued` occurrence and pull its content back
      // into the editor draft. The gesture is disabled in every viewer so it
      // cannot mutate a hidden main or child queue. The submission runtime
      // owns the ordered removal + recalled-draft settlement; the runner
      // supplies the narrow queue/TUI hooks.
      pullBackQueue({
        isDisposed: () => deps.isCleanedUp(),
        isViewing: () => deps.viewer.isViewing(),
        currentAgent: () => deps.liveAgent(),
        captureOwnerToken: () => deps.ownership.captureSubject(),
        isOwnerTokenCurrent: (token) => deps.captureMatches(token as SessionSubject | undefined),
        requireLiveScope: deps.scope.requireLive,
        readPullableQueue: (sessionId) => {
          const pending = deps.backend.pendingInputReader.snapshot(sessionId)
          if (pending === undefined) return undefined
          return pending.items
            .filter(item => item.placement === 'queued')
            .map(queueInboxMessageOf)
        },
        isTransitionPending: () => deps.ownership.transitionPending(),
        withWriter: (scope, task) => deps.submissionRuntime.withWriter(scope, task),
        updateQueue: (sessionId, messageId, operation) =>
          deps.backend.sessionWriter.updateQueue(sessionId, messageId, operation),
        deferQueueRecall: (recall) => deps.submissionRuntime.deferQueueRecall(recall),
        stageRecalledImage: (attachment) => {
          const ref = attachment as import('../../image/admission.ts').ImageAttachmentRefLike
          const draft = deps.drafts.images.add({
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
          const ref = attachment as import('../../attachment/file-admission.ts').FileAttachmentRefLike
          const draft = deps.drafts.files.add({
            name: ref.name,
            byteLength: ref.bytes,
            source: { type: 'recalled', ref },
          })
          return { id: draft.id, placeholder: draft.placeholder }
        },
        discardStagedDraft: (kind, id) => {
          if (kind === 'image') deps.drafts.images.remove(id)
          else deps.drafts.files.remove(id)
        },
        pinRecalledDrafts: (text) => pinDraftAttachments(text, deps.drafts.images, deps.drafts.files),
        readDraft: () => deps.app().getDraft(),
        writeDraft: (text) => deps.app().setDraft(text),
        notify: (message, kind) => deps.app().notify(message, kind),
        refreshPendingInput: () => deps.surface.refreshPendingInput(),
        diag: deps.diag,
      })
    }


  const submit = (text: string, request: ComposerSubmitRequest = 'enter'): void => dispatchUserInput(text, request)
  /**
   * The surface steer entry (Ctrl+S / steer-draft): snapshot the persist facts
   * BEFORE the draft is consumed, then steer the draft only (explicitly queued
   * messages stay queued until an empty-draft sweep).
   */
  const steerDraft = (text: string, options?: { readonly consumeDraft?: boolean }): void => {
    const persist = makeSteerPersist(text)
    // The editor is cleared ONLY when the caller asks this owner to consume the
    // draft — and only AFTER the persist facts are snapshotted (timestamp +
    // attachment state), which is the order the steered-history row relies on.
    // TuiApp's own Ctrl+S path already cleared and notified before `onSteer`, so
    // clearing again there would only add a second editor revision/render.
    if (options?.consumeDraft === true) deps.app().setDraft('')
    steerNow(text, false, persist)
  }
  /** Abort the local shell + interrupt the live Agent (Esc / cancel-activity). */
  const abortLocalShell = (): void => deps.shell.interrupt()
  /** Prepare one outgoing message through the shared image/draft pipeline. */
  const prepareMessage = (text: string, requestId: string): Promise<unknown> =>
    deps.prepareTransport !== undefined
      ? deps.prepareTransport(text, requestId)
      : prepareUserMessage(text, deps.drafts.images, submitDeps, { requestId })

  return {
    submit,
    steer: steerDraft,
    dequeue,
    abortLocalShell,
    withWriterSection,
    settleLocalSubmitAck: (reason, options) => settleLocalSubmitAck(reason, options),
    resetSubmitLatency: () => submitLatencyTracker.reset(),
    clearPending: () => pendingSubmissions.clear(),
    markLatency: (sessionId, phase) => { submitLatencyTracker.mark(sessionId, phase) },
    observeDurable: (rpcId) => pendingSubmissions.observeDurable(rpcId),
    snapshotEchoes: (sessionId) => submissionPresentation.snapshot(sessionId),
    prepareDeps: () => submitDeps,
    beginLocalSubmission: ({ requestId, text, mode, running, sessionId, generation, ackToken }) =>
      installLocalEcho(requestId, text, submissionPlacement(mode, running), sessionId, generation, ackToken),
    settleLocalSubmission: (requestId) => settleLocalSubmission(requestId),
    markDispatch: (sessionId) => { submitLatencyTracker.mark(sessionId, 'dispatch') },
    prepareMessage,
  }
}
