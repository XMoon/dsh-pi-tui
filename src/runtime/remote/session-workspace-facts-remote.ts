/**
 * The Remote read-authority adapter (M5-U-A): the ONE Remote implementation of
 * `SessionWorkspaceFactsPort` over the SAME official Client session service,
 * generated `session` namespace, `workspace` namespace and Connection
 * generation every other Remote adapter shares.
 *
 * It never mounts, constructs or caches an official Client/Remote, never
 * retains or opens a Session, never refreshes or re-enumerates the Session
 * corpus (the caller's roster is the only one), and it carries no write method:
 * the reads are the official passive `session.state`, the cold-safe
 * `session.projections`, the official observable Session list and the official
 * reconnecting Workspace stream.
 *
 * Two activity paths share the SAME validators and the SAME
 * `deriveAttention` rule set:
 *
 * - `readActivity` is the EXACT precise sample: one fenced answer for an
 *   explicit roster, used by the qualification probe and focused reads.
 * - `observeActivity` is the per-open INCREMENTAL observation the Session
 *   Browser drives. It publishes the official running projection immediately,
 *   schedules bounded per-id exact reads (priority lane + background discovery
 *   lane, never an unbounded `Promise.all` over the corpus) and commits each
 *   measured row as it lands.
 *
 * Failure vocabulary (fixed by the U-A contract, no generic catch):
 *   - `remote-access/denied`                  -> `denied`
 *   - `gateway/invocation-unavailable`       -> `unavailable` (the optional read
 *                                              method is genuinely not registered)
 *   - network/Host/codec/timeout/anything else -> `unknown`
 *   - abort or Connection-generation replacement -> the WHOLE exact sample is
 *     discarded (abort / `SupersededReadError`), never published as current;
 *     an incremental observation revokes its positive facts instead.
 *
 * A `session.projections` null, `migration-required` (cache hints included),
 * or a missing `userQuestions` unit is an UNKNOWN answerable fact, never an
 * empty `active` list.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-workspace-facts-remote
 */

import { isRemoteCancellation, remoteFailureCode } from './write-failure.ts'
import { SupersededReadError } from '../read-error.ts'
import type { SessionSummary } from '../session-reader-port.ts'
import type {
  ActivityObservation,
  ActivityObservationSnapshot,
  FactState,
  SessionActivityFact,
  SessionPendingKind,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
  WorkspaceFollowMode,
  WorkspaceInvalidatedReason,
} from '../session-workspace-facts-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
  RemoteProjectionValues,
  RemoteSessionsReadSource,
} from './session-reader-remote.ts'
import type {
  RemoteWorkspaceFollowFrameLike,
  RemoteWorkspaceNamespaceLike,
  RemoteWorkspaceViewLike,
} from './session-lifecycle-remote.ts'

/** One official passive `session.state` answer subset (`SessionState`). */
export interface RemoteSessionStateLike {
  readonly running: boolean
  readonly pendingInput: readonly string[]
}

/** The official generated `session` namespace subset this adapter reads. */
export interface RemoteSessionFactsRemotes {
  readonly session: {
    state(
      request: { readonly sessionId: string },
      signal?: AbortSignal,
    ): Promise<{ readonly ok: true; readonly value: RemoteSessionStateLike } | { readonly ok: false; readonly error: unknown }>
    projections(
      request: { readonly sessionId: string },
      signal?: AbortSignal,
    ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }>
  }
}

/** One item of the official reconnecting Gateway `RemoteStream`. */
export interface RemoteStreamItemLike<Item> {
  /** Monotone physical generation number within this logical stream. */
  readonly generation: number
  readonly value: Item
  /** Cancellation lifetime of the generation that delivered this item. */
  readonly signal: AbortSignal
  /** Mark this generation's opening baseline as accepted. */
  accept(): void
}

/** The official Gateway stream factory's narrow structural face. */
export interface RemoteLogicalStreamLike<Item> extends AsyncIterable<RemoteStreamItemLike<Item>> {
  dispose(): Promise<void>
  /** Interrupt the current physical generation and immediately request a
   *  replacement. */
  restart(): void
}

/** The ONE official-stream source a `recovering` Workspace follow needs: the
 *  SAME `ClientRemote.$stream` receiver and the official same-installation
 *  `RemoteStreamCarrierError` constructor (never a foreign instance). */
export interface RemoteWorkspaceStreamSource {
  readonly stream: (options: {
    readonly name: string
    readonly open: (signal: AbortSignal) => AsyncIterable<RemoteWorkspaceFollowFrameLike>
    readonly ended: (accepted: boolean) => Error
    readonly carrierFailed?: (error: Error) => void
  }) => RemoteLogicalStreamLike<RemoteWorkspaceFollowFrameLike>
  /** The captured official Gateway module's OWN `RemoteStreamCarrierError`. */
  readonly carrierError: new (message: string, options?: ErrorOptions) => Error
}

/** The official forwarded `api-session/status` seat: the SAME method-bound
 *  `$on` the other adapters consume, narrowed to the ONE event this port
 *  observes. Two independent `$on` subscribers are allowed; the Client Session
 *  Manager keeps its own store and listener untouched. */
export interface RemoteSessionStatusEventsLike {
  (event: 'api-session/status', listener: (sessionId: string, running: boolean) => void): () => void
}

/** The one-source runtime face this adapter consumes. */
export interface RemoteSessionWorkspaceFactsSource {
  readonly sessions: RemoteSessionsReadSource
  readonly remote: {
    readonly session: RemoteSessionFactsRemotes['session']
    /** The SAME generated official `workspace` namespace the lifecycle reads. */
    readonly workspace: RemoteWorkspaceNamespaceLike
  }
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
  /** The official forwarded `api-session/status` seat (the SAME method-bound
   *  `$on` the other adapters consume). It is an OBSERVER: the Client Session
   *  Manager remains the one list/projection store. */
  readonly events: {
    readonly onSessionStatus: (listener: (sessionId: string, running: boolean) => void) => () => void
  }
  /** The official reconnecting stream for `recovering` Workspace follows. */
  readonly workspaceStream: RemoteWorkspaceStreamSource
  /** The Client domain's FIRST established Connection generation (captured at
   *  domain mount). `undefined` means this composition never proved an initial
   *  generation, so a `phase=ready` list can never be claimed as a fresh
   *  `running` baseline. */
  readonly initialGeneration: RemoteConnectionGeneration | undefined
}

/** The fixed per-Session passive-read concurrency of the EXACT sample. */
export const SESSION_FACTS_READ_CONCURRENCY = 6

/** The incremental observation's priority lane capacity: the reserved
 *  background discovery slot keeps at least one request available for ordinary
 *  unresolved rows, so a cold corpus never occupies the whole budget. */
export const ACTIVITY_PRIORITY_CONCURRENCY = 3
/** The background discovery lane capacity (one unary request). */
export const ACTIVITY_DISCOVERY_CONCURRENCY = 1
/** The hard ceiling of ACTUAL concurrent unary requests one observation may
 *  hold, across both lanes. */
export const ACTIVITY_READ_CAPACITY = ACTIVITY_PRIORITY_CONCURRENCY + ACTIVITY_DISCOVERY_CONCURRENCY
/** The single re-arm cadence of the active-row recheck: a running Session (or a
 *  locally eligible/observed-pending one) can receive a foreign Gateway pending
 *  request with NO global public event, so it keeps ONE bounded periodic sample
 *  while it stays active. Ordinary idle rows are never re-sampled. */
export const ACTIVITY_RECHECK_MS = 20_000

const PENDING_KINDS: readonly SessionPendingKind[] = ['question', 'approval', 'other']
const USER_QUESTIONS_PROJECTION_KEY = 'userQuestions'
const INBOX_PROJECTION_KEY = 'inbox'
const INBOX_LANES = ['next-step', 'next-turn'] as const

/** One active timed Question as the official `userQuestions` projection carries it. */
export interface ProjectedActiveQuestion {
  readonly callId: string
  readonly state: 'open' | 'continued'
  /** The official `AskUserQuestionItem[]` value, validated only to the plan-review intent. */
  readonly planReview: boolean
}

/** One readable timed-Question projection. `queuedReplyCallIds` is `undefined`
 *  when the inbox lane could not be read: an unreadable inbox cannot confirm
 *  that a `continued` call is still answerable. */
export type QuestionProjectionRead =
  | {
    readonly kind: 'known'
    readonly active: readonly ProjectedActiveQuestion[]
    readonly queuedReplyCallIds: ReadonlySet<string> | undefined
  }
  | { readonly kind: 'denied' | 'unavailable' | 'unknown' }

/** One readable passive Session state. */
export type PendingRead =
  | {
    readonly kind: 'known'
    readonly running: boolean
    readonly pendingKinds: readonly SessionPendingKind[]
  }
  | { readonly kind: 'denied' | 'unavailable' | 'unknown' }

/** The attention classification the port publishes for one sampled Session. */
export interface AttentionDerivation {
  readonly attention: SessionActivityFact['attention']
  readonly attentionSourceState: FactState
  readonly continuedQuestionCallIds: readonly string[] | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Classify one official read failure into the fixed read FactState. */
export function classifyReadFailure(error: unknown): 'denied' | 'unavailable' | 'unknown' {
  const code = remoteFailureCode(error)
  if (code === 'remote-access/denied') return 'denied'
  if (code === 'gateway/invocation-unavailable') return 'unavailable'
  return 'unknown'
}

/**
 * Validate one `session.state` answer. A shape the official contract cannot
 * produce is an unknown state, never an empty pending list.
 */
export function readPending(value: unknown): PendingRead {
  if (!isRecord(value)) return { kind: 'unknown' }
  if (typeof value.running !== 'boolean') return { kind: 'unknown' }
  if (!Array.isArray(value.pendingInput)) return { kind: 'unknown' }
  const pendingKinds: SessionPendingKind[] = []
  for (const kind of value.pendingInput) {
    if (typeof kind !== 'string' || !PENDING_KINDS.includes(kind as SessionPendingKind)) return { kind: 'unknown' }
    pendingKinds.push(kind as SessionPendingKind)
  }
  return { kind: 'known', running: value.running, pendingKinds }
}

/** One active question's `plan-review` tag: the ONLY identification the U-A
 *  contract allows (never a title, snippet, tool name or display text).
 *  `undefined` is a malformed official item: the tag is then NOT provable and
 *  the whole projection stays unknown instead of being read as "not plan-review". */
function isPlanReview(questions: unknown): boolean | undefined {
  if (!Array.isArray(questions)) return undefined
  for (const entry of questions) {
    if (!isRecord(entry)) return undefined
    const intent = entry.intent
    if (intent === undefined) continue
    if (!isRecord(intent)) return undefined
    if (intent.kind === 'plan-review') return true
  }
  return false
}

/** One inbox lane's `user-question-reply` call ids (the queued late answers). */
function queuedReplyCallIds(value: unknown): Set<string> | undefined {
  if (!isRecord(value)) return undefined
  const queued = new Set<string>()
  for (const lane of INBOX_LANES) {
    const messages = value[lane]
    if (!Array.isArray(messages)) return undefined
    for (const message of messages) {
      if (!isRecord(message)) return undefined
      const source = message.source
      if (!isRecord(source)) continue
      if (source.kind !== 'user-question-reply') continue
      if (typeof source.callId !== 'string') return undefined
      queued.add(source.callId)
    }
  }
  return queued
}

/**
 * Read the official `userQuestions` projection unit. The projection must be
 * `sequenced` (an exact event cut); `null`/`migration-required`/absent units
 * are unknown answerable facts.
 */
export function readQuestionProjection(value: unknown): QuestionProjectionRead {
  if (!isRecord(value)) return { kind: 'unknown' }
  if (value.kind !== 'sequenced') return { kind: 'unknown' }
  const values = value.values
  if (!isRecord(values)) return { kind: 'unknown' }
  if (!Object.prototype.hasOwnProperty.call(values, USER_QUESTIONS_PROJECTION_KEY)) return { kind: 'unknown' }
  const view = values[USER_QUESTIONS_PROJECTION_KEY]
  if (!isRecord(view) || !Array.isArray(view.active)) return { kind: 'unknown' }
  const active: ProjectedActiveQuestion[] = []
  for (const entry of view.active) {
    if (!isRecord(entry)) return { kind: 'unknown' }
    if (typeof entry.callId !== 'string' || entry.callId === '') return { kind: 'unknown' }
    if (entry.state !== 'open' && entry.state !== 'continued') return { kind: 'unknown' }
    if (!Array.isArray(entry.questions)) return { kind: 'unknown' }
    const planReview = isPlanReview(entry.questions)
    if (planReview === undefined) return { kind: 'unknown' }
    active.push({ callId: entry.callId, state: entry.state, planReview })
  }
  // The inbox unit is the only source that says a continued call already has
  // a queued reply; an absent or malformed unit is NOT "no queued reply".
  const queued = Object.prototype.hasOwnProperty.call(values, INBOX_PROJECTION_KEY)
    ? queuedReplyCallIds(values[INBOX_PROJECTION_KEY])
    : undefined
  return { kind: 'known', active, queuedReplyCallIds: queued }
}

/**
 * Derive the ONE attention classification from the two official sources.
 * Fixed rules (no degrees of freedom):
 *   1. an unreadable state is unknown;
 *   2. a pending approval is `approval`; a pending question is `plan-review`
 *      only when an active question carries the official `plan-review` intent,
 *      else `question`; a pending `other` is unknown — never a guessed kind;
 *   3. with no Gateway pending, `none` requires a `sequenced` question
 *      projection whose active records and inbox lane are readable and show no
 *      answerable call; an unreadable source is unknown;
 *   4. a still-answerable `continued` call keeps the Session as `question`
 *      (a real answerable fact wins over a pendingInput sample of `[]`);
 *   5. a timed `open` call with NO Gateway pending input is a genuine
 *      source conflict and fails closed to unknown.
 */
export function deriveAttention(
  pending: PendingRead,
  projection: QuestionProjectionRead,
): AttentionDerivation {
  const continuedQuestionCallIds = projection.kind === 'known' && projection.queuedReplyCallIds !== undefined
    ? projection.active
      .filter(entry => entry.state === 'continued' && !projection.queuedReplyCallIds!.has(entry.callId))
      .map(entry => entry.callId)
    : undefined

  if (pending.kind !== 'known') {
    return { attention: 'unknown', attentionSourceState: pending.kind, continuedQuestionCallIds }
  }
  const { pendingKinds } = pending
  if (pendingKinds.includes('approval')) {
    return { attention: 'approval', attentionSourceState: 'known', continuedQuestionCallIds }
  }
  if (pendingKinds.includes('question')) {
    // Only an `open` timed call can be the CURRENT forwarded question; a
    // `continued` entry is a different (already timed-out) interaction. The
    // plan-review intent is claimed only when EVERY such open candidate carries
    // it and none is already answered by a queued reply; an unreadable inbox
    // keeps the generic `question` label instead of guessing.
    let planReview = false
    if (projection.kind === 'known' && projection.queuedReplyCallIds !== undefined) {
      const openCandidates = projection.active.filter(entry =>
        entry.state === 'open' && !projection.queuedReplyCallIds!.has(entry.callId))
      planReview = openCandidates.length > 0 && openCandidates.every(entry => entry.planReview)
    }
    return {
      attention: planReview ? 'plan-review' : 'question',
      attentionSourceState: 'known',
      continuedQuestionCallIds,
    }
  }
  // `other` is a real pending request of a kind this read cannot classify.
  if (pendingKinds.includes('other')) {
    return { attention: 'unknown', attentionSourceState: 'unknown', continuedQuestionCallIds }
  }
  if (projection.kind !== 'known') {
    return { attention: 'unknown', attentionSourceState: projection.kind, continuedQuestionCallIds }
  }
  const queued = projection.queuedReplyCallIds
  if (queued === undefined) {
    // The active records cannot be confirmed answerable without the inbox.
    return { attention: 'unknown', attentionSourceState: 'unknown', continuedQuestionCallIds }
  }
  // Only a `continued` call is a late-answer candidate; `open` is a Gateway
  // pending clue and cannot stand in for one.
  const lateAnswers = projection.active.filter(entry => entry.state === 'continued' && !queued.has(entry.callId))
  if (lateAnswers.length > 0) {
    const planReview = lateAnswers.every(entry => entry.planReview)
    return {
      attention: planReview ? 'plan-review' : 'question',
      attentionSourceState: 'known',
      continuedQuestionCallIds,
    }
  }
  if (projection.active.some(entry => entry.state === 'open' && !queued.has(entry.callId))) {
    // A timed call still open while the Gateway reports no pending input.
    return { attention: 'unknown', attentionSourceState: 'unknown', continuedQuestionCallIds }
  }
  return { attention: 'none', attentionSourceState: 'known', continuedQuestionCallIds }
}

/** Run `work` over `items` with a fixed concurrency and stable result order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Project one official `WorkspaceView` into the detached U-A fact. */
function workspaceFactOf(view: RemoteWorkspaceViewLike): SessionWorkspaceFact {
  return {
    workspaceId: view.workspaceId,
    path: view.path,
    // A Host Workspace can exist without a display title (a fresh create);
    // the TUI fact carries display text, so an absent title is empty and the
    // projection applies its own ONE fallback label.
    title: view.title ?? '',
    sessionIds: view.sessionIds.map(String),
  }
}

/** Map one forwarded official frame; `archived`/`pinned` belong to no U-A fact. */
function workspaceFrameOf(frame: RemoteWorkspaceFollowFrameLike): WorkspaceFactsFrame | undefined {
  switch (frame.type) {
    case 'baseline':
    case 'replace':
      if (!Array.isArray(frame.value?.items)) {
        throw new Error('the Host Workspace frame carries no complete item list')
      }
      return { type: frame.type, items: frame.value.items.map(workspaceFactOf) }
    case 'upsert':
      if (frame.workspace === undefined) {
        throw new Error('the Host Workspace upsert carries no workspace')
      }
      return { type: 'upsert', workspace: workspaceFactOf(frame.workspace) }
    case 'remove':
      if (typeof frame.workspaceId !== 'string') {
        throw new Error('the Host Workspace remove carries no workspace id')
      }
      return { type: 'remove', workspaceId: frame.workspaceId }
    case 'order':
      if (!Array.isArray(frame.workspaceIds)) {
        throw new Error('the Host Workspace order carries no id list')
      }
      return { type: 'order', workspaceIds: frame.workspaceIds.map(String) }
    default:
      // `archived`/`pinned` are registry-global Session sets, not U-A Workspace
      // membership: they are ignored, never reinterpreted as a Workspace fact.
      return undefined
  }
}

/** The semantic identity of one official Session's relevant pending sources:
 *  the SCHEDULING witness only. It answers "did the relevant hint sources
 *  change since this row was read?" and never proves answerability. Unrelated
 *  projection churn (settled history, tokens, todos, title, retention) is
 *  deliberately absent so it cannot requeue Activity. */
export function relevantHintSignature(values: RemoteProjectionValues | undefined): string {
  return `${userQuestionsSignature(values?.userQuestions)}|${inboxSignature(values?.inbox)}`
}

function userQuestionsSignature(value: unknown): string {
  if (value === undefined) return 'absent'
  if (!isRecord(value)) return 'malformed'
  if (!Array.isArray(value.active)) return 'malformed'
  const entries: string[] = []
  for (const entry of value.active) {
    if (!isRecord(entry)) return 'malformed'
    if (typeof entry.callId !== 'string' || typeof entry.state !== 'string') return 'malformed'
    // Only the fields the classification reads: identity, timed state and the
    // plan-review intent identity.
    const intent = isRecord(entry.intent) && typeof entry.intent.kind === 'string' ? entry.intent.kind : '-'
    entries.push(`${entry.callId}:${entry.state}:${intent}`)
  }
  return `active(${entries.join(',')})`
}

function inboxSignature(value: unknown): string {
  if (value === undefined) return 'absent'
  if (!isRecord(value)) return 'malformed'
  const callIds: string[] = []
  for (const lane of INBOX_LANES) {
    const messages = value[lane]
    if (!Array.isArray(messages)) return 'malformed'
    for (const message of messages) {
      if (!isRecord(message)) return 'malformed'
      const source = message.source
      if (!isRecord(source)) continue
      if (source.kind !== 'user-question-reply') continue
      if (typeof source.callId !== 'string') return 'malformed'
      callIds.push(source.callId)
    }
  }
  // Lane membership is irrelevant to the answerable fact; the SET is the fact.
  return `queued(${callIds.sort().join(',')})`
}

/** The authority one row's `running` fact came from. The normal path is the
 *  official list/status store; only the recovery path may fall back to an exact
 *  `session.state` answer. */
type RunningSource = 'list' | 'status' | 'state'

/** One row's incremental observation state. */
interface ActivityRow {
  readonly sessionId: string
  /** Bumped whenever this row's relevant sources change; a read started under
   *  an older epoch can never commit. */
  epoch: number
  /** The official running fact. Proven only from a fresh list baseline, a
   *  current-generation status event or an exact current-generation state. */
  running: boolean | undefined
  /** Whether `running` currently has a current-generation proof. */
  runningProven: boolean
  /** Which authority proved it. */
  runningSource: RunningSource | undefined
  attention: SessionActivityFact['attention']
  attentionSourceState: FactState
  pendingKinds: readonly SessionPendingKind[] | undefined
  continuedQuestionCallIds: readonly string[] | undefined
  /** The hint witness this row was last measured against. */
  witness: string
  /** The epoch whose exact projection this observation already holds, if any
   *  (reused by the priority lane instead of a second `session.projections`). */
  exactProjection: { readonly epoch: number; readonly read: QuestionProjectionRead } | undefined
  /** This source revision's ONE discovery attempt (scheduling evidence only). */
  discovery: { readonly epoch: number; readonly witness: string; readonly negative: boolean } | undefined
  /** A discovery found a real active entry: promote this id to the priority
   *  lane as soon as the discovery read settles. */
  promote: boolean
}

/** The observation-level failure: the source generation is gone for good. */
class ObservationUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObservationUnavailableError'
  }
}

/**
 * The ONE per-open incremental Remote Activity observation.
 *
 * Scheduling is fixed (no knobs):
 *  - the roster commit publishes the official running projection immediately;
 *  - the priority lane (≤3 concurrent) reads the current Session, locally
 *    eligible rows, running rows and positive-hint candidates as exact
 *    state+projection pairs;
 *  - the background lane (1 reserved slot) performs ONE exact projection
 *    discovery per unresolved ordinary row and promotes any row that really
 *    holds an active/`continued` entry;
 *  - a row whose unchanged relevant sources already completed a successful
 *    discovery does not repeat it (completion receipt);
 *  - ONE re-armed 20s recheck keeps only active rows (running/eligible/observed
 *    pending) sampled, because the Gateway has no global public pending event;
 *  - every commit is fenced by the row epoch, the Connection generation and the
 *    caller's lifetime.
 */
class RemoteActivityObservation implements ActivityObservation {
  private readonly sessions: RemoteSessionsReadSource
  private readonly session: RemoteSessionFactsRemotes['session']
  private readonly generation: RemoteConnectionGenerationSource
  private readonly initialGeneration: RemoteConnectionGeneration | undefined
  private readonly listeners = new Set<() => void>()
  private readonly offs: Array<() => void> = []
  private readonly rows = new Map<string, ActivityRow>()
  private rosterOrder: readonly string[] = []
  private priorityIds: ReadonlySet<string> = new Set()
  private currentSessionId: string | undefined
  private capturedGeneration: RemoteConnectionGeneration | undefined
  private rosterRevision = 0
  private revision = 0
  private error: string | undefined
  private disposed = false
  private readonly priorityQueue: string[] = []
  private readonly discoveryQueue: string[] = []
  private readonly inflight = new Map<string, AbortController>()
  private activePriority = 0
  private activeDiscovery = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly abortCleanup: () => void

  constructor(source: RemoteSessionWorkspaceFactsSource, signal: AbortSignal) {
    // An observation may open while the Client is disconnected (the Browser
    // still opens with its latest-known/flat fallback): it publishes the roster
    // with every fact unknown and adopts the first REAL generation when it
    // appears. It never invents an idle or empty fact in the meantime.
    const captured = source.connection.generation.getSnapshot()
    this.sessions = source.sessions
    this.session = source.remote.session
    this.generation = source.connection.generation
    this.initialGeneration = source.initialGeneration
    this.capturedGeneration = captured
    this.offs.push(this.sessions.list.subscribe(() => { this.onListChanged() }))
    this.offs.push(this.generation.subscribe(() => { this.onGenerationChanged() }))
    this.offs.push(source.events.onSessionStatus((sessionId, running) => {
      this.onStatusEvent(sessionId, running)
    }))
    const onAbort = (): void => { this.dispose() }
    signal.addEventListener('abort', onAbort, { once: true })
    this.abortCleanup = () => { signal.removeEventListener('abort', onAbort) }
  }

  // ── public observation face ────────────────────────────────────────────────

  setRoster(
    rows: readonly SessionSummary[],
    rosterRevision: number,
    currentSessionId: string | undefined,
  ): void {
    if (this.disposed) return
    // Commit identity/epoch state BEFORE any listener runs: a callback that
    // reads the snapshot must see the new roster, never a half-applied one.
    this.rosterRevision = rosterRevision
    this.currentSessionId = currentSessionId
    const authorized = rows.filter(row => row.origin !== 'subagent').map(row => row.id)
    const listed = new Set(authorized)
    for (const [id, row] of this.rows) {
      if (listed.has(id)) continue
      // A removed id loses EVERY fact and every queued/in-flight read at once.
      this.rows.delete(id)
      this.inflight.get(id)?.abort(new Error('the Session left the roster'))
      this.inflight.delete(id)
    }
    for (const id of authorized) {
      if (!this.rows.has(id)) this.rows.set(id, this.freshRow(id))
    }
    this.rosterOrder = authorized
    // The official running projection is published in the SAME roster frame.
    this.refreshRunningFromList()
    this.pruneQueues()
    this.revision += 1
    this.emit()
    this.scheduleRosterWork()
    this.pump()
  }

  setPriorityIds(ids: ReadonlySet<string>): void {
    if (this.disposed) return
    const previous = this.priorityIds
    this.priorityIds = new Set(ids)
    const changed = new Set<string>()
    for (const id of this.priorityIds) if (!previous.has(id)) changed.add(id)
    for (const id of previous) if (!this.priorityIds.has(id)) changed.add(id)
    if (changed.size === 0) return
    // Eligibility is a SCHEDULING hint: a newly eligible or newly revoked id is
    // re-read so its exact pending fact is current. The renderer's answer gate
    // already repaints the frame itself; this only refreshes the Host fact.
    for (const id of changed) {
      if (!this.rows.has(id)) continue
      this.schedulePriority(id, { front: true })
    }
    this.pump()
  }

  getSnapshot(): ActivityObservationSnapshot {
    const facts: SessionActivityFact[] = []
    for (const id of this.rosterOrder) {
      const row = this.rows.get(id)
      if (row === undefined) continue
      facts.push({
        sessionId: id,
        running: row.running,
        pendingKinds: row.pendingKinds,
        continuedQuestionCallIds: row.continuedQuestionCallIds,
        attention: row.attention,
        attentionSourceState: row.attentionSourceState,
      })
    }
    return {
      rosterRevision: this.rosterRevision,
      revision: this.revision,
      facts,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return (): void => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    // Mark disposed BEFORE any callback/abort can re-enter.
    this.disposed = true
    this.clearTimer()
    for (const controller of this.inflight.values()) controller.abort(new Error('the Session activity observation was disposed'))
    this.inflight.clear()
    this.priorityQueue.length = 0
    this.discoveryQueue.length = 0
    for (const off of this.offs.splice(0)) off()
    this.abortCleanup()
    this.rows.clear()
    this.listeners.clear()
  }

  // ── official-source observation ────────────────────────────────────────────

  /** Re-derive every authorized row's running fact from the official list.
   *  Only the INITIAL Connection generation's list is a fresh baseline: a later
   *  `phase=ready` list is the latest-known roster, not proof of current Host
   *  status, so it never revives a positive this generation did not prove. */
  private refreshRunningFromList(): void {
    if (!this.isInitialGeneration()) return
    const listed = this.sessions.list.getSnapshot()
    if (listed.phase !== 'ready') return
    for (const [id, row] of this.rows) {
      const entry = listed.byId[id]
      if (entry === undefined) continue
      row.running = entry.running
      row.runningProven = true
      row.runningSource = 'list'
    }
  }

  private isInitialGeneration(): boolean {
    const current = this.generation.getSnapshot()
    return this.initialGeneration !== undefined && current !== undefined
      && Object.is(this.initialGeneration, current)
  }

  /** The relevant hint values of one authorized id: the full shared store view
   *  when it carries the keys, else the list row's summary values. */
  private hintValuesOf(id: string): RemoteProjectionValues | undefined {
    const listed = this.sessions.list.getSnapshot()
    if (listed.phase !== 'ready') return undefined
    const store = listed.projectionsBySession[id]?.values
    if (store !== undefined
      && (Object.prototype.hasOwnProperty.call(store, USER_QUESTIONS_PROJECTION_KEY)
        || Object.prototype.hasOwnProperty.call(store, INBOX_PROJECTION_KEY))) {
      return store
    }
    return listed.byId[id]?.projectionValues
  }

  private witnessOf(id: string): string {
    return relevantHintSignature(this.hintValuesOf(id))
  }

  /** One official list notification: only the rows whose RELEVANT semantics
   *  changed (running or the pending hint witness) are invalidated. */
  private onListChanged(): void {
    if (this.disposed) return
    const listed = this.sessions.list.getSnapshot()
    if (listed.phase !== 'ready') return
    const baseline = this.isInitialGeneration()
    let changed = false
    for (const [id, row] of this.rows) {
      const entry = listed.byId[id]
      const witness = this.witnessOf(id)
      const runningChanged = baseline && entry !== undefined && row.running !== entry.running
        ? this.applyProvenRunning(row, entry.running, 'list')
        : false
      if (runningChanged) {
        changed = true
        this.invalidateRow(row)
        this.scheduleAfterRelevantChange(row)
        continue
      }
      if (witness !== row.witness) {
        row.witness = witness
        changed = true
        this.invalidateRow(row)
        this.scheduleAfterRelevantChange(row)
      }
    }
    if (!changed) return
    this.revision += 1
    this.emit()
    this.pump()
  }

  /** One current-generation official Agent status event. It is the recovery
   *  path's currentness proof (the list store replays the same fact, but a
   *  replayed list can also be the pre-reconnect snapshot). */
  private onStatusEvent(sessionId: string, running: boolean): void {
    if (this.disposed) return
    // The forwarded event carries no generation identity. Accept it only while
    // this observation has ADOPTED the live generation: during a loss or a
    // replacement the revocation path owns the facts, and a late event of the
    // previous pump can never re-prove running on the new generation.
    const live = this.generation.getSnapshot()
    if (live === undefined || this.capturedGeneration === undefined || !Object.is(live, this.capturedGeneration)) return
    const row = this.rows.get(String(sessionId))
    if (row === undefined) return
    if (!this.applyProvenRunning(row, running, 'status')) return
    this.invalidateRow(row)
    this.scheduleAfterRelevantChange(row)
    this.revision += 1
    this.emit()
    this.pump()
  }

  /** Set one row's proven running fact. Returns whether it changed. */
  private applyProvenRunning(row: ActivityRow, running: boolean, source: RunningSource): boolean {
    if (row.runningProven && row.runningSource === source && row.running === running) return false
    row.running = running
    row.runningProven = true
    row.runningSource = source
    return true
  }

  /** The exact state sample may establish `running` ONLY when the official
   *  list/status authority has not proven it for this generation (the recovery
   *  path); a normal list/status fact is never overwritten by the sample. */
  private applyPendingRunning(row: ActivityRow, pending: PendingRead): boolean {
    if (pending.kind !== 'known') return false
    if (row.runningProven && row.runningSource !== 'state') return false
    return this.applyProvenRunning(row, pending.running, 'state')
  }

  /** A Connection generation change revokes EVERY positive fact of the old
   *  generation and restarts the one-per-generation discovery. A missing
   *  generation (disconnected) is the SAME revocation without a discovery: no
   *  row may keep a Working/Needs fact that the old generation proved. */
  private onGenerationChanged(): void {
    if (this.disposed) return
    const current = this.generation.getSnapshot()
    if (current === undefined) {
      this.revokeGeneration()
      return
    }
    if (Object.is(current, this.capturedGeneration)) return
    this.capturedGeneration = current
    for (const controller of this.inflight.values()) controller.abort(new Error('the Connection generation was replaced'))
    this.inflight.clear()
    this.priorityQueue.length = 0
    this.discoveryQueue.length = 0
    this.clearTimer()
    for (const row of this.rows.values()) {
      row.epoch += 1
      row.running = undefined
      row.runningProven = false
      row.runningSource = undefined
      row.witness = this.witnessOf(row.sessionId)
      row.exactProjection = undefined
      row.discovery = undefined
      this.resetAttention(row)
    }
    this.refreshRunningFromList()
    this.error = undefined
    this.revision += 1
    this.emit()
    // Exactly ONE discovery pass for the new generation: no old proof is
    // reused, and no same-generation retry ever starts.
    this.scheduleRosterWork()
    this.pump()
  }

  /** Revoke every proven fact without ending the observation: the caller keeps
   *  its last-known roster and the next real generation re-proves what it can. */
  private revokeGeneration(): void {
    for (const controller of this.inflight.values()) controller.abort(new Error('the Connection generation was lost'))
    this.inflight.clear()
    this.priorityQueue.length = 0
    this.discoveryQueue.length = 0
    this.clearTimer()
    let changed = false
    for (const row of this.rows.values()) {
      row.epoch += 1
      row.running = undefined
      row.runningProven = false
      row.runningSource = undefined
      row.exactProjection = undefined
      row.discovery = undefined
      if (this.resetAttention(row)) changed = true
    }
    if (!changed) return
    this.revision += 1
    this.emit()
  }

  // ── row state ──────────────────────────────────────────────────────────────

  private freshRow(sessionId: string): ActivityRow {
    return {
      sessionId,
      epoch: 0,
      running: undefined,
      runningProven: false,
      runningSource: undefined,
      attention: 'unknown',
      attentionSourceState: 'unknown',
      pendingKinds: undefined,
      continuedQuestionCallIds: undefined,
      witness: this.witnessOf(sessionId),
      exactProjection: undefined,
      discovery: undefined,
      promote: false,
    }
  }

  /** Drop every measured fact of one row: a changed relevant source can never
   *  keep painting the OLD sample (a revoked Needs must leave the same frame).
   *  Returns whether anything actually changed. */
  private invalidateRow(row: ActivityRow): boolean {
    row.epoch += 1
    row.exactProjection = undefined
    row.discovery = undefined
    row.promote = false
    return this.resetAttention(row)
  }

  /** Record the reason a discovery could not measure the row: `denied` /
   *  `unavailable` stay the truthful fact state, never `none` and never a
   *  plain `unknown` that hides a real denial. */
  private setUnmeasuredAttention(row: ActivityRow, state: FactState): void {
    const changed = row.attention !== 'unknown'
      || row.attentionSourceState !== state
      || row.pendingKinds !== undefined
      || row.continuedQuestionCallIds !== undefined
    row.attention = 'unknown'
    row.attentionSourceState = state
    row.pendingKinds = undefined
    row.continuedQuestionCallIds = undefined
    if (changed) this.bumpRow()
  }

  private resetAttention(row: ActivityRow): boolean {
    const changed = row.attention !== 'unknown'
      || row.attentionSourceState !== 'unknown'
      || row.pendingKinds !== undefined
      || row.continuedQuestionCallIds !== undefined
    row.attention = 'unknown'
    row.attentionSourceState = 'unknown'
    row.pendingKinds = undefined
    row.continuedQuestionCallIds = undefined
    return changed
  }

  /** Schedule the fixed post-change work of one invalidated row. */
  private scheduleAfterRelevantChange(row: ActivityRow): void {
    if (this.rowIsCandidate(row)) {
      this.schedulePriority(row.sessionId, { front: true })
      return
    }
    if (this.discoverySettled(row)) return
    this.scheduleDiscovery(row.sessionId)
  }

  /** Whether one row currently belongs to the priority lane: the open Session,
   *  a locally eligible row, a running row, or a row whose official hint
   *  carries an active/queued pending clue. */
  private rowIsCandidate(row: ActivityRow): boolean {
    if (row.sessionId === this.currentSessionId) return true
    if (this.priorityIds.has(row.sessionId)) return true
    if (row.running === true) return true
    return this.hintIsCandidate(this.hintValuesOf(row.sessionId))
  }

  private hintIsCandidate(values: RemoteProjectionValues | undefined): boolean {
    if (values === undefined) return false
    const questions = userQuestionsSignature(values.userQuestions)
    if (questions.startsWith('active(') && questions !== 'active()') return true
    const inbox = inboxSignature(values.inbox)
    return inbox.startsWith('queued(') && inbox !== 'queued()'
  }

  /** Whether this row's CURRENT source revision already had its one discovery
   *  attempt. A failed/denied/malformed attempt counts too: it prevents an
   *  immediate retry storm, and only a real source invalidation, an explicit
   *  reopen or a Connection change schedules another one. The result is
   *  scheduling evidence ONLY — it is never consulted by the answer gate or
   *  the Writer. */
  private discoverySettled(row: ActivityRow): boolean {
    return row.discovery !== undefined
      && row.discovery.epoch === row.epoch
      && row.discovery.witness === row.witness
  }

  // ── scheduling ─────────────────────────────────────────────────────────────

  private scheduleRosterWork(): void {
    // The current Session and locally eligible rows are priority work; every
    // other authorized id is one-time background discovery in roster order.
    for (const id of this.rosterOrder) {
      const row = this.rows.get(id)
      if (row === undefined) continue
      if (this.rowIsCandidate(row)) {
        this.schedulePriority(id)
        continue
      }
      if (this.discoverySettled(row)) continue
      this.scheduleDiscovery(id)
    }
  }

  private schedulePriority(sessionId: string, options: { readonly front?: boolean } = {}): void {
    if (this.disposed || !this.rows.has(sessionId)) return
    if (this.inflight.has(sessionId)) return
    const discoveryIndex = this.discoveryQueue.indexOf(sessionId)
    if (discoveryIndex >= 0) this.discoveryQueue.splice(discoveryIndex, 1)
    const priorityIndex = this.priorityQueue.indexOf(sessionId)
    if (priorityIndex >= 0) this.priorityQueue.splice(priorityIndex, 1)
    if (options.front === true) this.priorityQueue.unshift(sessionId)
    else this.priorityQueue.push(sessionId)
  }

  private scheduleDiscovery(sessionId: string): void {
    if (this.disposed || !this.rows.has(sessionId)) return
    if (this.inflight.has(sessionId) || this.priorityQueue.includes(sessionId) || this.discoveryQueue.includes(sessionId)) return
    this.discoveryQueue.push(sessionId)
  }

  private pruneQueues(): void {
    const authorize = (id: string): boolean => this.rows.has(id)
    for (let index = this.priorityQueue.length - 1; index >= 0; index -= 1) {
      if (!authorize(this.priorityQueue[index])) this.priorityQueue.splice(index, 1)
    }
    for (let index = this.discoveryQueue.length - 1; index >= 0; index -= 1) {
      if (!authorize(this.discoveryQueue[index])) this.discoveryQueue.splice(index, 1)
    }
  }

  /** Start work up to the FIXED capacity. The discovery lane keeps its one
   *  reserved slot whenever background work exists; the priority lane may use
   *  the spare slot only when there is none. */
  private pump(): void {
    if (this.disposed || this.error !== undefined) return
    for (;;) {
      const total = this.activePriority + this.activeDiscovery
      if (total >= ACTIVITY_READ_CAPACITY) return
      const discoveryPending = this.discoveryQueue.length > 0
      const priorityLimit = discoveryPending ? ACTIVITY_PRIORITY_CONCURRENCY : ACTIVITY_READ_CAPACITY
      if (this.priorityQueue.length > 0 && this.activePriority < priorityLimit) {
        const sessionId = this.priorityQueue.shift()!
        this.startPriority(sessionId)
        continue
      }
      if (discoveryPending && this.activeDiscovery < ACTIVITY_DISCOVERY_CONCURRENCY) {
        const sessionId = this.discoveryQueue.shift()!
        this.startDiscovery(sessionId)
        continue
      }
      return
    }
  }

  private startPriority(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (row === undefined) return
    const controller = new AbortController()
    this.inflight.set(sessionId, controller)
    this.activePriority += 1
    const epoch = row.epoch
    const generation = this.capturedGeneration
    if (generation === undefined) {
      this.finishWork(sessionId, 'priority')
      return
    }
    this.track((async () => {
      try {
        const pending = await this.readState(sessionId, controller.signal)
        if (!this.committable(sessionId, epoch, generation)) return
        const reused = row.exactProjection?.epoch === epoch ? row.exactProjection.read : undefined
        const projection = reused ?? await this.readProjections(sessionId, controller.signal)
        if (!this.committable(sessionId, epoch, generation)) return
        row.exactProjection = { epoch, read: projection }
        row.discovery = { epoch, witness: row.witness, negative: this.isNegativeDiscovery(projection) }
        this.commitPair(row, epoch, pending, projection)
      } finally {
        this.finishWork(sessionId, 'priority')
      }
    })())
  }

  private startDiscovery(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (row === undefined) return
    const controller = new AbortController()
    this.inflight.set(sessionId, controller)
    this.activeDiscovery += 1
    const epoch = row.epoch
    const generation = this.capturedGeneration
    if (generation === undefined) {
      this.finishWork(sessionId, 'discovery')
      return
    }
    this.track((async () => {
      try {
        const projection = await this.readProjections(sessionId, controller.signal)
        if (!this.committable(sessionId, epoch, generation)) return
        row.exactProjection = { epoch, read: projection }
        if (projection.kind === 'known' && projection.active.length > 0) {
          // A real active entry promotes this id to the priority lane once this
          // read settles (a second concurrent sample would be a duplicate); the
          // exact projection response is reused, never re-fetched.
          row.promote = true
          row.discovery = { epoch, witness: row.witness, negative: false }
          return
        }
        // An ordinary row that proved no active entry has NOT proven "no
        // pending": without a Gateway state sample the attention fact stays
        // unknown. Publishing a `none` here would fabricate an absence.
        this.setUnmeasuredAttention(row, projection.kind)
        row.discovery = { epoch, witness: row.witness, negative: this.isNegativeDiscovery(projection) }
      } finally {
        this.finishWork(sessionId, 'discovery')
      }

    })())
  }

  private finishWork(sessionId: string, lane: 'priority' | 'discovery'): void {
    this.inflight.delete(sessionId)
    if (lane === 'priority') this.activePriority -= 1
    else this.activeDiscovery -= 1
    if (this.disposed) return
    const row = this.rows.get(sessionId)
    if (row?.promote === true) {
      row.promote = false
      this.schedulePriority(sessionId, { front: true })
    }
    this.pump()
    if (this.priorityQueue.length === 0 && this.activePriority === 0) this.armRecheck()
  }

  /** Commit one exact state+projection pair onto the current row epoch. */
  private commitPair(row: ActivityRow, epoch: number, pending: PendingRead, projection: QuestionProjectionRead): void {
    if (row.epoch !== epoch) return
    const runningChanged = this.applyPendingRunning(row, pending)
    const derivation = deriveAttention(pending, projection)
    const next: SessionActivityFact = {
      sessionId: row.sessionId,
      running: row.running,
      pendingKinds: pending.kind === 'known' ? pending.pendingKinds : undefined,
      continuedQuestionCallIds: derivation.continuedQuestionCallIds,
      attention: derivation.attention,
      attentionSourceState: derivation.attentionSourceState,
    }
    const changed = runningChanged
      || row.attention !== next.attention
      || row.attentionSourceState !== next.attentionSourceState
      || row.pendingKinds !== next.pendingKinds
      || row.continuedQuestionCallIds !== next.continuedQuestionCallIds
    row.attention = next.attention
    row.attentionSourceState = next.attentionSourceState
    row.pendingKinds = next.pendingKinds
    row.continuedQuestionCallIds = next.continuedQuestionCallIds
    if (changed) this.bumpRow()
  }

  /** The completion receipt's positive meaning: an exact, readable
   *  `userQuestions.active` + a readable inbox lane proved NO active entry.
   *  Denied/unavailable/migration/malformed reads are never a successful
   *  negative discovery. */
  private isNegativeDiscovery(projection: QuestionProjectionRead): boolean {
    return projection.kind === 'known'
      && projection.queuedReplyCallIds !== undefined
      && projection.active.length === 0
  }

  /** Whether a read started for this row/epoch/generation may still commit. */
  private committable(sessionId: string, epoch: number, generation: RemoteConnectionGeneration): boolean {
    if (this.disposed || this.capturedGeneration === undefined) return false
    const row = this.rows.get(sessionId)
    if (row === undefined || row.epoch !== epoch) return false
    const current = this.generation.getSnapshot()
    return current !== undefined && Object.is(current, generation) && Object.is(current, this.capturedGeneration)
  }

  private bumpRow(): void {
    if (this.disposed) return
    this.revision += 1
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Start ONE owned read. Every host failure is already classified per row
   *  inside the read helpers, so a rejection here is an unexpected adapter
   *  failure: it becomes the observation's visible error instead of being
   *  swallowed (the port is UI-neutral and has no diagnostics channel). */
  private track(pending: Promise<void>): void {
    pending.then(undefined, (error: unknown) => {
      if (this.disposed) return
      this.error = `Session activity is unavailable: ${error instanceof Error ? error.message : String(error)}`
      this.revision += 1
      this.emit()
    })
  }

  // ── the one single re-armed active-row recheck ─────────────────────────────

  private activeRowIds(): string[] {
    const ids: string[] = []
    for (const id of this.rosterOrder) {
      const row = this.rows.get(id)
      if (row === undefined) continue
      if (this.rowIsActive(row)) ids.push(id)
    }
    return ids
  }

  /** Whether one row still has a CURRENT active trigger.
   *
   *  A measured fact (`none` included) is never a trigger by itself: after the
   *  eligibility/running/hint reason that kept a row active is gone, it leaves
   *  the recheck set instead of being sampled every 20 s forever. A real
   *  pending/continued observation IS an active trigger, and so is a still
   *  positive official hint. */
  private rowIsActive(row: ActivityRow): boolean {
    if (row.running === true) return true
    if (row.sessionId === this.currentSessionId) return true
    if (this.priorityIds.has(row.sessionId)) return true
    if (row.attention === 'question' || row.attention === 'approval' || row.attention === 'plan-review') return true
    if ((row.continuedQuestionCallIds?.length ?? 0) > 0) return true
    return this.hintIsCandidate(this.hintValuesOf(row.sessionId))
  }

  /** Arm the ONE recheck only while at least one active row exists. Ordinary
   *  idle rows are never periodically sampled. */
  private armRecheck(): void {
    if (this.disposed || this.error !== undefined || this.timer !== undefined) return
    const active = this.activeRowIds()
    if (active.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.disposed || this.error !== undefined) return
      // Re-derive the active set at FIRE time: the eligibility/running/hint
      // reason that armed this timer may be gone by now, and a measured `none`
      // is never a trigger.
      const current = this.activeRowIds()
      if (current.length === 0) return
      for (const id of current) this.schedulePriority(id)
      this.pump()
    }, ACTIVITY_RECHECK_MS)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  // ── the two official reads ─────────────────────────────────────────────────

  /** One passive `session.state` read: no retain, no open, no Agent creation. */
  private async readState(sessionId: string, signal: AbortSignal): Promise<PendingRead> {
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['state']>>
    try {
      result = await this.session.state({ sessionId }, signal)
    } catch (error) {
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readPending(result.value)
  }

  /** One cold-safe `session.projections` read: no retain, no open, no Agent. */
  private async readProjections(sessionId: string, signal: AbortSignal): Promise<QuestionProjectionRead> {
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['projections']>>
    try {
      result = await this.session.projections({ sessionId }, signal)
    } catch (error) {
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readQuestionProjection(result.value)
  }
}

/**
 * One per-open Remote Workspace observation.
 *
 * `single-generation` keeps the historical one-shot contract: every official
 * item and every generation change is validated against the captured
 * Connection generation, and the observation ends instead of stitching a new
 * generation's membership onto an old one.
 *
 * `recovering` drives the SAME official reconnecting Gateway stream
 * (`ClientRemote.$stream`): a physical carrier loss only INVALIDATES the current
 * membership (`invalidated` frame) and the stream opens a new physical
 * generation whose fresh baseline restores it in the same handle. A terminal
 * (non-carrier) failure ends this handle; the caller may open ONE new logical
 * handle after a NEW Connection generation, never on the same one.
 */
class RemoteWorkspaceFactsHandle implements WorkspaceFactsHandle {
  private readonly workspace: RemoteWorkspaceNamespaceLike
  private readonly callerSignal: AbortSignal | undefined
  private readonly mode: WorkspaceFollowMode
  private readonly officialStream: RemoteWorkspaceStreamSource | undefined
  private readonly generation: RemoteConnectionGenerationSource
  private capturedGeneration: RemoteConnectionGeneration
  /** The `single-generation` raw official follow (opened exactly once). */
  private raw: (AsyncIterable<RemoteWorkspaceFollowFrameLike> & { dispose(): void }) | undefined
  private logical: RemoteLogicalStreamLike<RemoteWorkspaceFollowFrameLike> | undefined
  private readonly generationOff: (() => void) | undefined
  private readonly invalidations: WorkspaceInvalidatedReason[] = []
  private wake: (() => void) | undefined
  private disposed = false

  constructor(
    source: RemoteSessionWorkspaceFactsSource,
    signal: AbortSignal | undefined,
    mode: WorkspaceFollowMode,
  ) {
    signal?.throwIfAborted()
    const captured = source.connection.generation.getSnapshot()
    if (captured === undefined) {
      throw new SupersededReadError('the Host Workspace stream requires a current Connection generation')
    }
    this.workspace = source.remote.workspace
    this.callerSignal = signal
    this.mode = mode
    this.capturedGeneration = captured
    this.generation = source.connection.generation
    this.officialStream = mode === 'recovering' ? source.workspaceStream : undefined
    if (mode === 'single-generation') {
      this.raw = this.workspace.follow(signal)
    } else {
      // The generation subscription only records "the old membership is no
      // longer proven"; it never restarts the stream on its own.
      this.generationOff = this.generation.subscribe(() => {
        this.noteGenerationChange()
      })
    }
  }

  /** The captured Connection generation is the observation's identity; a
   *  replacement makes this baseline unusable for a paired roster read. */
  isCurrent(): boolean {
    if (this.disposed) return false
    return Object.is(this.generation.getSnapshot(), this.capturedGeneration)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.wake?.()
    this.wake = undefined
    this.invalidations.length = 0
    this.generationOff?.()
    const logical = this.logical
    this.logical = undefined
    if (logical !== undefined) {
      // The SDK's async quiescence is INITIATED here and observed: the port's
      // dispose is synchronous, but the returned promise must not float.
      logical.dispose().then(undefined, () => {})
    }
    this.raw?.dispose()
    this.raw = undefined
  }

  private requireCurrent(): void {
    const current = this.generation.getSnapshot()
    if (current === undefined || !Object.is(current, this.capturedGeneration)) {
      throw new SupersededReadError('the Host Workspace generation was replaced while following')
    }
  }

  /** Record one reason the current membership stopped being proven. */
  private noteInvalidation(reason: WorkspaceInvalidatedReason): void {
    if (this.disposed) return
    if (this.invalidations.length > 0 && this.invalidations[this.invalidations.length - 1] === reason) return
    this.invalidations.push(reason)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  private noteGenerationChange(): void {
    if (this.disposed) return
    const current = this.generation.getSnapshot()
    if (current === undefined || Object.is(current, this.capturedGeneration)) return
    this.capturedGeneration = current
    this.noteInvalidation('replaced')
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WorkspaceFactsFrame> {
    try {
      if (this.mode === 'single-generation') yield* this.singleGeneration()
      else yield* this.recovering()
    } finally {
      this.dispose()
    }
  }

  /** The historical one-shot contract (never widened by the recovering mode). */
  private async *singleGeneration(): AsyncGenerator<WorkspaceFactsFrame> {
    const raw = this.raw
    if (raw === undefined) throw new Error('the Host Workspace stream is unavailable')
    let baselined = false
    try {
      for await (const frame of raw) {
        this.requireCurrent()
        const mapped = workspaceFrameOf(frame)
        if (!baselined) {
          if (mapped?.type !== 'baseline') {
            throw new Error('the Host Workspace stream did not begin with a baseline')
          }
          baselined = true
        }
        if (mapped !== undefined) yield mapped
      }
    } finally {
      raw.dispose()
      this.raw = undefined
    }
    this.requireCurrent()
    if (!baselined) throw new Error('the Host Workspace stream ended before its baseline')
  }

  /** The official reconnecting-stream contract. */
  private async *recovering(): AsyncGenerator<WorkspaceFactsFrame> {
    const official = this.officialStream
    if (official === undefined) throw new Error('the Host Workspace stream source is unavailable')
    for (;;) {
      // A terminal stream failure ends the handle truthfully: the current
      // membership is NOT silently kept and no same-generation retry starts.
      // One replacement Connection generation may open ONE new logical handle
      // (the caller owns that rebind).
      yield* this.generationStream(official)
      if (this.disposed) return
      yield* this.drainInvalidations()
      throw new Error('the Host Workspace stream ended without a terminal result')
    }
  }

  /** Drain the invalidations recorded by the callbacks. */
  private *drainInvalidations(): Generator<WorkspaceFactsFrame> {
    while (this.invalidations.length > 0) {
      const reason = this.invalidations.shift()!
      yield { type: 'invalidated', reason }
    }
  }

  /** Consume ONE logical `$stream` lifecycle, yielding official frames and the
   *  carrier invalidations recorded while waiting for the next item. */
  private async *generationStream(official: RemoteWorkspaceStreamSource): AsyncGenerator<WorkspaceFactsFrame> {
    const logical = official.stream({
      name: 'Session Workspace membership',
      open: signal => this.workspace.follow(signal),
      // Upstream's exact classification: an accepted baseline that then ends is
      // a carrier loss (the Gateway retries); an end BEFORE the opening
      // baseline is a real protocol/availability failure.
      ended: accepted => accepted
        ? new official.carrierError('Session Workspace membership stream ended without a terminal result')
        : new Error('Session Workspace membership stream ended before its opening baseline'),
      carrierFailed: () => { this.noteInvalidation('reconnecting') },
    })
    this.logical = logical
    const iterator = logical[Symbol.asyncIterator]()
    let pending: Promise<IteratorResult<RemoteStreamItemLike<RemoteWorkspaceFollowFrameLike>>> | undefined
    let acceptedGeneration: number | undefined
    try {
      for (;;) {
        pending ??= iterator.next()
        // An invalidation recorded by a callback must reach the consumer
        // IMMEDIATELY, not only when the next physical item arrives.
        if (this.invalidations.length > 0) {
          yield* this.drainInvalidations()
          continue
        }
        const raced = await Promise.race([
          pending.then((result): { readonly kind: 'item'; readonly result: IteratorResult<RemoteStreamItemLike<RemoteWorkspaceFollowFrameLike>> } => ({ kind: 'item', result })),
          new Promise<{ readonly kind: 'wake' }>((resolve) => { this.wake = () => resolve({ kind: 'wake' }) }),
        ])
        this.wake = undefined
        if (raced.kind === 'wake') continue
        pending = undefined
        if (raced.result.done === true) return
        const item = raced.result.value
        if (this.disposed) return
        // A physical generation whose own signal was aborted can never be
        // applied: it belongs to a replaced carrier generation.
        if (item.signal.aborted) continue
        const current = this.generation.getSnapshot()
        if (current === undefined) continue
        if (!Object.is(current, this.capturedGeneration)) {
          this.capturedGeneration = current
          this.noteInvalidation('replaced')
          // The new Connection generation must open with its own fresh
          // baseline. The item in hand may BE that baseline (a replacement does
          // not always deliver one stale item first), so it is processed after
          // the invalidation — never dropped. A stale DELTA of the replaced
          // physical generation is already skipped above by its aborted signal.
          acceptedGeneration = undefined
        }
        yield* this.drainInvalidations()
        const frame = workspaceFrameOf(item.value)
        if (item.generation !== acceptedGeneration) {
          // A new PHYSICAL generation must open with exactly one fresh
          // baseline, validated before it is accepted.
          if (frame?.type !== 'baseline') {
            throw new Error('the Host Workspace stream did not begin with a baseline')
          }
          item.accept()
          acceptedGeneration = item.generation
          yield frame
          continue
        }
        if (frame !== undefined) yield frame
      }
    } finally {
      this.logical = undefined
      await logical.dispose()
    }
  }
}

/** The Remote read-authority adapter over the ONE shared Client runtime. */
export class RemoteSessionWorkspaceFacts implements SessionWorkspaceFactsPort {
  private readonly source: RemoteSessionWorkspaceFactsSource
  private readonly sessions: RemoteSessionsReadSource
  private readonly remote: RemoteSessionFactsRemotes & { readonly workspace: RemoteWorkspaceNamespaceLike }
  private readonly generation: RemoteConnectionGenerationSource

  constructor(source: RemoteSessionWorkspaceFactsSource) {
    this.source = source
    this.sessions = source.sessions
    this.remote = source.remote
    this.generation = source.connection.generation
  }

  private fence(
    captured: NonNullable<ReturnType<RemoteConnectionGenerationSource['getSnapshot']>>,
    signal: AbortSignal | undefined,
  ): void {
    signal?.throwIfAborted()
    const current = this.generation.getSnapshot()
    if (current === undefined || !Object.is(current, captured)) {
      throw new SupersededReadError('the Connection generation was replaced during the Session facts read')
    }
  }

  /** The EXACT precise sample for an explicit roster (the qualification probe
   *  and focused reads). It keeps the per-row Unknown/Denied retention and the
   *  whole-sample generation fence; the Browser drives `observeActivity`
   *  instead. */
  async readActivity(
    rows: readonly SessionSummary[],
    signal?: AbortSignal,
  ): Promise<readonly SessionActivityFact[]> {
    signal?.throwIfAborted()
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new SupersededReadError('the Session facts read requires a current Connection generation')
    }
    // The caller's roster is the ONLY corpus: a subagent child and any extra id
    // never enter the roster, and no row is added or dropped here.
    const listed = this.sessions.list.getSnapshot()
    const byId = listed.phase === 'ready' ? listed.byId : undefined
    const authorized = rows.filter(row => row.origin !== 'subagent')

    const facts = await mapWithConcurrency(
      authorized,
      SESSION_FACTS_READ_CONCURRENCY,
      async (row): Promise<SessionActivityFact> => {
        this.fence(captured, signal)
        const [pending, projection] = await Promise.all([
          this.readState(row.id, signal),
          this.readProjections(row.id, signal),
        ])
        this.fence(captured, signal)
        // The official list row OWNS the normal running fact: the Client
        // Session Manager applies the Host status mutations to it. The passive
        // state answers ONLY when the list cannot (a pending/absent list); it
        // is never compared with an arbitrarily older list cut.
        const derivation = deriveAttention(pending, projection)
        return {
          sessionId: row.id,
          running: byId?.[row.id]?.running ?? (pending.kind === 'known' ? pending.running : undefined),
          pendingKinds: pending.kind === 'known' ? pending.pendingKinds : undefined,
          continuedQuestionCallIds: derivation.continuedQuestionCallIds,
          attention: derivation.attention,
          attentionSourceState: derivation.attentionSourceState,
        }
      },
    )
    this.fence(captured, signal)
    return facts
  }

  observeActivity(signal: AbortSignal): ActivityObservation {
    signal.throwIfAborted()
    return new RemoteActivityObservation(this.source, signal)
  }

  /** One passive `session.state` read: no retain, no open, no Agent creation. */
  private async readState(sessionId: string, signal: AbortSignal | undefined): Promise<PendingRead> {
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['state']>>
    try {
      result = await this.remote.session.state({ sessionId }, signal)
    } catch (error) {
      // A caller/transport cancellation is a failed sample, never a zero fact;
      // the outer fence/abort already decided whether this generation is over.
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readPending(result.value)
  }

  /** One cold-safe `session.projections` read: no retain, no open, no Agent. */
  private async readProjections(sessionId: string, signal: AbortSignal | undefined): Promise<QuestionProjectionRead> {
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['projections']>>
    try {
      result = await this.remote.session.projections({ sessionId }, signal)
    } catch (error) {
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readQuestionProjection(result.value)
  }

  followWorkspaces(signal?: AbortSignal, mode: WorkspaceFollowMode = 'single-generation'): WorkspaceFactsHandle {
    return new RemoteWorkspaceFactsHandle(this.source, signal, mode)
  }

  observeConnectionGeneration(listener: () => void): () => void {
    return this.generation.subscribe(listener)
  }
}
