/**
 * The Remote read-authority adapter (M5-U-A): the ONE Remote implementation of
 * `SessionWorkspaceFactsPort` over the SAME official Client session service,
 * generated `session` namespace, `workspace` namespace and Connection
 * generation every other Remote adapter shares.
 *
 * It never mounts, constructs or caches an official Client/Remote, never
 * retains or opens a Session, never refreshes or re-enumerates the Session
 * corpus (the caller's `SessionReader.list()` roster is the only one), and it
 * carries no write method: the two reads are the official passive
 * `session.state` and the cold-safe `session.projections`.
 *
 * Failure vocabulary (fixed by the U-A contract, no generic catch):
 *   - `remote-access/denied`                  -> `denied`
 *   - `gateway/invocation-unavailable`       -> `unavailable` (the optional read
 *                                              method is genuinely not registered)
 *   - network/Host/codec/timeout/anything else -> `unknown`
 *   - abort or Connection-generation replacement -> the WHOLE sample is
 *     discarded (abort / `SupersededReadError`), never published as current.
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
  FactState,
  SessionActivityFact,
  SessionPendingKind,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
} from '../session-workspace-facts-port.ts'
import type {
  RemoteConnectionGenerationSource,
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

/** The one-source runtime face this adapter consumes. */
export interface RemoteSessionWorkspaceFactsSource {
  readonly sessions: RemoteSessionsReadSource
  readonly remote: {
    readonly session: RemoteSessionFactsRemotes['session']
    /** The SAME generated official `workspace` namespace the lifecycle reads. */
    readonly workspace: RemoteWorkspaceNamespaceLike
  }
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

/** The fixed per-Session passive-read concurrency (backpressure, never Top-N). */
export const SESSION_FACTS_READ_CONCURRENCY = 6

const PENDING_KINDS: readonly SessionPendingKind[] = ['question', 'approval', 'other']
const USER_QUESTIONS_PROJECTION_KEY = 'userQuestions'
const INBOX_PROJECTION_KEY = 'inbox'

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
  for (const lane of [value['next-step'], value['next-turn']]) {
    if (!Array.isArray(lane)) return undefined
    for (const message of lane) {
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

/** Resolve one list-row `running` against the passive Host state without
 *  choosing between two disagreeing official facts. */
function combineRunning(listed: boolean | undefined, stated: boolean | undefined): boolean | undefined {
  if (listed === undefined) return stated
  if (stated === undefined) return listed
  return listed === stated ? listed : undefined
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

/**
 * One per-open Remote Workspace observation. Every generation starts with
 * exactly one baseline; an increment that is not preceded by a baseline, a
 * generation replacement or a malformed frame ends this open generation
 * instead of publishing an empty or stale Workspace set.
 */
class RemoteWorkspaceFactsHandle implements WorkspaceFactsHandle {
  private readonly stream: AsyncIterable<RemoteWorkspaceFollowFrameLike> & { dispose(): void }
  private readonly generation: RemoteConnectionGenerationSource
  private readonly capturedGeneration: NonNullable<ReturnType<RemoteConnectionGenerationSource['getSnapshot']>>
  private disposed = false

  constructor(
    source: RemoteSessionWorkspaceFactsSource,
    signal: AbortSignal | undefined,
  ) {
    signal?.throwIfAborted()
    const captured = source.connection.generation.getSnapshot()
    if (captured === undefined) {
      throw new SupersededReadError('the Host Workspace stream requires a current Connection generation')
    }
    this.capturedGeneration = captured
    this.generation = source.connection.generation
    this.stream = source.remote.workspace.follow(signal)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stream.dispose()
  }

  private requireCurrent(): void {
    const current = this.generation.getSnapshot()
    if (current === undefined || !Object.is(current, this.capturedGeneration)) {
      throw new SupersededReadError('the Host Workspace generation was replaced while following')
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WorkspaceFactsFrame> {
    let baselined = false
    try {
      for await (const frame of this.stream) {
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
      this.requireCurrent()
      if (!baselined) throw new Error('the Host Workspace stream ended before its baseline')
    } finally {
      this.dispose()
    }
  }
}

/** The Remote read-authority adapter over the ONE shared Client runtime. */
export class RemoteSessionWorkspaceFacts implements SessionWorkspaceFactsPort {
  private readonly sessions: RemoteSessionsReadSource
  private readonly remote: RemoteSessionFactsRemotes & { readonly workspace: RemoteWorkspaceNamespaceLike }
  private readonly generation: RemoteConnectionGenerationSource

  constructor(source: RemoteSessionWorkspaceFactsSource) {
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
          this.readState(row.id, captured, signal),
          this.readProjections(row.id, captured, signal),
        ])
        this.fence(captured, signal)
        // A missing ready list snapshot is not "idle": the list row is the
        // official running source, so an unavailable snapshot leaves running
        // to the verified passive state instead of guessing.
        const listRunning = byId?.[row.id]?.running
        const derivation = deriveAttention(pending, projection)
        return {
          sessionId: row.id,
          running: combineRunning(listRunning, pending.kind === 'known' ? pending.running : undefined),
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

  /** One passive `session.state` read: no retain, no open, no Agent creation. */
  private async readState(
    sessionId: string,
    captured: NonNullable<ReturnType<RemoteConnectionGenerationSource['getSnapshot']>>,
    signal: AbortSignal | undefined,
  ): Promise<PendingRead> {
    this.fence(captured, signal)
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['state']>>
    try {
      result = await this.remote.session.state({ sessionId }, signal)
    } catch (error) {
      this.fence(captured, signal)
      // A caller/transport cancellation is a failed sample, never a zero fact;
      // the outer fence/abort already decided whether this generation is over.
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    this.fence(captured, signal)
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readPending(result.value)
  }

  /** One cold-safe `session.projections` read: no retain, no open, no Agent. */
  private async readProjections(
    sessionId: string,
    captured: NonNullable<ReturnType<RemoteConnectionGenerationSource['getSnapshot']>>,
    signal: AbortSignal | undefined,
  ): Promise<QuestionProjectionRead> {
    this.fence(captured, signal)
    let result: Awaited<ReturnType<RemoteSessionFactsRemotes['session']['projections']>>
    try {
      result = await this.remote.session.projections({ sessionId }, signal)
    } catch (error) {
      this.fence(captured, signal)
      if (isRemoteCancellation(error)) return { kind: 'unknown' }
      return { kind: classifyReadFailure(error) }
    }
    this.fence(captured, signal)
    if (!result.ok) return { kind: classifyReadFailure(result.error) }
    return readQuestionProjection(result.value)
  }

  followWorkspaces(signal?: AbortSignal): WorkspaceFactsHandle {
    return new RemoteWorkspaceFactsHandle({
      sessions: this.sessions,
      remote: this.remote,
      connection: { generation: this.generation },
    }, signal)
  }
}
