/**
 * The Host-owned accepted-input history search service (`piTuiHistorySearch`).
 *
 * It derives a disposable, profile-local SQLite index from the OFFICIAL rc.5
 * Session event log and serves TWO Owner-only private reads:
 *
 * ```text
 * search(request, signal)    -> bounded preview rows with a keyset cursor
 * readText(request, signal)  -> exact original text chunks by content hash
 * ```
 *
 * Authority and lifecycle:
 * - The official Session log is the only durable authority; the derived index
 *   is discardable and is always reconciled from official reads.
 * - Listeners are registered BEFORE the persisted enumeration, so an event
 *   accepted during the warmup window is buffered by `(sessionId, seq)` and
 *   merged after that Session's replay (no list→subscribe gap).
 * - The live buffer is bounded (events and text bytes); reaching the bound
 *   stops appending, marks the affected Sessions dirty and re-reads the
 *   official source instead of silently dropping history.
 * - Host readiness never waits for the cold replay: queries answer `loading`
 *   until the first complete pass, then `ready`/`incomplete`/`unavailable`.
 * - A non-Owner, an ended peer or an aborted invocation is refused before any
 *   official read or index query.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/history-search
 */

import { randomUUID } from 'node:crypto'
import { normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  HostAdmissionFold,
  type HostAdmissionEventLike,
  type HostAdmissionOccurrence,
} from '../../../domain/history/host-admission.ts'
import { diagFromEnv, type Diag } from '../../../runtime/process/diagnostics.ts'
import { runDetached } from '../../../runtime/process/tasks.ts'
import {
  PI_TUI_HISTORY_SEARCH_NAMESPACE,
  decodeHistorySearchCursor,
  encodeHistorySearchCursor,
  historyReadTextChunk,
  parseHistoryReadTextRequest,
  parseHistorySearchRequest,
  type HistoryReadTextResponse,
  type HistorySearchIncompleteReason,
  type HistorySearchResponse,
  type HistorySearchUnavailableReason,
} from '../../../runtime/remote/pi-tui-history-search-contract.ts'
import {
  HistorySearchIndex,
  HistorySearchIndexUnavailableError,
  contentSha256,
  sessionEventHash,
  sessionHeaderHash,
  type HistoryOccurrenceInput,
  type HistorySearchAfter,
  type HistorySessionCheckpointRow,
} from './history-search-index.ts'

/** The maximum number of buffered live events before a dirty re-read. */
export const HISTORY_SEARCH_MAX_PENDING_EVENTS = 4096

/** The maximum approximate buffered live text bytes before a dirty re-read. */
export const HISTORY_SEARCH_MAX_PENDING_BYTES = 16 * 1024 * 1024

/** The official cold-read batch bound. */
export const HISTORY_SEARCH_READ_BATCH = 256

/** The external-source verification cadence. */
export const HISTORY_SEARCH_VERIFICATION_INTERVAL_MS = 30_000

/** A structural official Session event. */
export interface HistorySearchEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** A structural official Session header (only the fields this service needs). */
export interface HistorySearchHeaderLike {
  readonly id: unknown
  readonly cwd?: string
}

/** A structural official persistence snapshot. */
export interface HistorySearchPersistenceSnapshotLike {
  readonly header: HistorySearchHeaderLike
  readonly eventCount?: number
  /** Opaque change token comparable only within one persistence instance. */
  readonly revision?: unknown
}

/** A structural official read handle. */
export interface HistorySearchReadHandleLike {
  readonly header: HistorySearchHeaderLike
  readonly inheritedEventCount: number
  read(
    offset?: number,
    length?: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly events: readonly HistorySearchEventLike[] }>
  close(): Promise<void>
}

/** A structural official observation lease. */
export interface HistorySearchObservationLike {
  readonly header: HistorySearchHeaderLike
  readonly inheritedEventCount: number
  readonly events: readonly HistorySearchEventLike[]
  [Symbol.dispose](): void
}

/** A structural official live-preferred Session record. */
export interface HistorySearchSessionRecordLike {
  readonly header: HistorySearchHeaderLike
  readonly live?: boolean
  readonly persisted?: boolean
}

/** The narrow official `sessionPersistence` face this service consumes. */
export interface HistorySearchPersistenceLike {
  /** Process-local service identity: revisions are only comparable within it. */
  readonly identity?: symbol
  /** Exact official lightweight observation of ONE Session; undefined means absent. */
  stat(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HistorySearchPersistenceSnapshotLike | undefined>
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly HistorySearchPersistenceSnapshotLike[]>
  open(
    id: string,
    access: 'read' | 'write',
    options?: { readonly signal?: AbortSignal },
  ): Promise<HistorySearchReadHandleLike>
}

/** The narrow official `sessionQuery` face this service consumes. */
export interface HistorySearchQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly HistorySearchSessionRecordLike[]>
  observeSession(
    id: string,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' },
  ): Promise<HistorySearchObservationLike>
}

/** The official profile facts the derived index path is anchored to. */
export interface HistorySearchProfileContextLike {
  readonly dir: string
}

export type PiTuiHistorySearchHostDeps = {
  /** Resolved per pass: a Host without the official services stays Ready and reports `unavailable`. */
  profileContext(): HistorySearchProfileContextLike | undefined
  sessionPersistence(): HistorySearchPersistenceLike | undefined
  sessionQuery(): HistorySearchQueryLike | undefined
}

type IndexState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'incomplete'; readonly reason: HistorySearchIncompleteReason }
  | { readonly kind: 'unavailable'; readonly reason: HistorySearchUnavailableReason }

/** One buffered live Session batch. */
interface PendingSession {
  readonly headerCwd?: string
  readonly inheritedEventCount: number
  readonly events: HostAdmissionEventLike[]
  bytes: number
}

/** One official Session identity resolved from the two official enumerations. */
interface OfficialSession {
  readonly header: HistorySearchHeaderLike
  readonly live: boolean
  readonly eventCount?: number
  readonly revision?: unknown
}

/** The two — and only two — production callers of the official enumeration. */
type HistorySearchInventoryPhase = 'cold_start' | 'periodic_verify'

/** One diagnostic pass outcome; derived from the real IndexState, never a second state machine. */
type HistorySearchPhaseOutcome = 'ready' | 'incomplete' | 'unavailable' | 'cancelled'

/** O(1) per-pass counters; diagnostics only, never business state. */
interface HistorySearchPhaseCounters {
  sessionsVisited: number
  replayAttempted: number
  replayCompleted: number
  replayElapsedMsTotal: number
  replayElapsedMsMax: number
}

/** O(1) disposal-verification counters; no Session id, content or path is retained. */
interface HistorySearchDisposalCounters {
  seen: number
  completed: number
  statCalls: number
  statNotFound: number
  proofProven: number
  proofInsufficient: number
  proofRollback: number
  proofUnreadable: number
  statElapsedMsTotal: number
  verifyElapsedMsTotal: number
}

/** One diagnostic duration, rounded to at most one decimal place. */
function roundMilliseconds(value: number): number {
  return Math.round(value * 10) / 10
}

/** Elapsed milliseconds since `startedAt`, rounded to at most one decimal place. */
function elapsedMilliseconds(startedAt: number): number {
  return roundMilliseconds(performance.now() - startedAt)
}

/** A contiguous gap in the observed Session sequence. */
class HistorySearchGapError extends Error {
  constructor(sessionId: string, expected: number, actual: number) {
    super(`history search: Session ${sessionId} has a sequence gap at ${String(expected)} (observed ${String(actual)})`)
    this.name = 'HistorySearchGapError'
  }
}

/** A replaced Session identity or conflicting re-delivery of an observed seq. */
class HistorySearchConflictError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`history search: Session ${sessionId} diverged from its checkpoint (${detail})`)
    this.name = 'HistorySearchConflictError'
  }
}

/**
 * The service's ONE diagnostic adapter. `ctx.logger` has no human-visible
 * exporter in the Split Host, so an explicitly requested debug level ALSO
 * mirrors the same message to the repository's standard `Diag` file/stderr
 * sink. No second sink exists and nothing changes outside explicit debug.
 */
function loggerDiag(ctx: Context, debugSink: boolean): Diag {
  const logger = ctx.logger('pi-tui-history-search')
  const sink = debugSink ? diagFromEnv(process.env) : undefined
  const emit = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string, fields?: Record<string, unknown>): void => {
    logger[level](message, fields ?? {})
    sink?.[level](message, fields)
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    dispose: () => sink?.dispose(),
  }
}

/** Normalize one event-time cwd for storage/aggregation (never realpath). */
export function normalizeHistoryCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string' || cwd === '') return null
  return normalize(cwd)
}

/** Byte weight of one live event, counting REAL UTF-8 bytes. */
function approximateEventBytes(event: HostAdmissionEventLike): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    // An official Session event is JSON by contract; a value that cannot be
    // serialized breaks the bound itself. Charge the whole text budget so the
    // overflow path reconciles from the official source instead of silently
    // caching an unmeasurable payload.
    return HISTORY_SEARCH_MAX_PENDING_BYTES + 1
  }
}

function eventOf(value: unknown): HistorySearchEventLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  if (typeof record.type !== 'string') return undefined
  if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0) return undefined
  if (typeof record.time !== 'number' || !Number.isSafeInteger(record.time) || record.time < 0) return undefined
  return { type: record.type, seq: record.seq, time: record.time, data: record.data }
}

/**
 * Convert one OFFICIAL event batch structurally. A malformed element is a
 * source-contract breach: dropping it would advance the derived checkpoint past
 * an unobserved seq, so the batch fails closed instead.
 */
function eventsOf(value: unknown, sessionId: string): HistorySearchEventLike[] {
  if (!Array.isArray(value)) {
    throw new HistorySearchConflictError(sessionId, 'the official event batch is not an array')
  }
  const events: HistorySearchEventLike[] = []
  for (const candidate of value) {
    const event = eventOf(candidate)
    if (event === undefined) {
      throw new HistorySearchConflictError(sessionId, 'the official event batch contains a malformed event')
    }
    events.push(event)
  }
  return events
}

function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export class PiTuiHistorySearchHostService extends TypertRemoteService {
  static readonly inject = ['typert']

  private readonly deps: PiTuiHistorySearchHostDeps
  private readonly lifecycle = new AbortController()
  private readonly diag: Diag
  /** Random per service instance: cursors never cross a Host service lifetime. */
  private readonly incarnation = randomUUID()
  private readonly liveSessions = new Map<string, { readonly headerCwd?: string; readonly inheritedEventCount: number }>()
  private readonly pending = new Map<string, PendingSession>()
  private readonly listenerDisposers: Array<() => void> = []
  private state: IndexState = { kind: 'loading' }
  private index: HistorySearchIndex | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private warmupSettled: Promise<void> = Promise.resolve()
  private writeTail: Promise<void> = Promise.resolve()
  private pendingEventCount = 0
  private pendingBytes = 0
  private verificationTimer: ReturnType<typeof setTimeout> | undefined
  /** Count of bounded-buffer overflows (internal lifecycle evidence). */
  private bufferOverflows = 0
  /** A drain is queued; subsequent live events coalesce into it. */
  private drainScheduled = false
  /** Number of drain tasks actually enqueued (internal lifecycle evidence). */
  private drainSchedules = 0
  /** Sticky index-failure latch: only a later successful write clears it. */
  private indexFaulted = false
  /** Last fully replayed persistence revision per Session (same-instance only). */
  private readonly verifiedRevisions = new Map<string, { readonly identity: symbol | undefined; readonly revision: unknown }>()
  /** Explicitly requested visible debug diagnostics; O(1) metrics stay unformatted otherwise. */
  private readonly diagnosticsEnabled: boolean
  /** O(1) disposal observation counters (diagnostics, never business state). */
  private readonly disposalCounters: HistorySearchDisposalCounters = {
    seen: 0,
    completed: 0,
    statCalls: 0,
    statNotFound: 0,
    proofProven: 0,
    proofInsufficient: 0,
    proofRollback: 0,
    proofUnreadable: 0,
    statElapsedMsTotal: 0,
    verifyElapsedMsTotal: 0,
  }

  constructor(ctx: Context, deps: PiTuiHistorySearchHostDeps) {
    super(ctx, PI_TUI_HISTORY_SEARCH_NAMESPACE)
    this.deps = deps
    this.diagnosticsEnabled = process.env.DSH_PI_TUI_LOG_LEVEL === 'debug'
    this.diag = loggerDiag(ctx, this.diagnosticsEnabled)
    // Subscribe BEFORE the official enumeration: the listener only captures a
    // bounded pending fact, never performs a full read in the event callback.
    this.listenerDisposers.push(ctx.on('session/event', (session, event) => {
      this.observeLiveEvent(session, event)
    }, { global: true }))
    this.listenerDisposers.push(ctx.on('session/created', (session) => {
      this.rememberLiveSession(session)
    }, { global: true }))
    this.listenerDisposers.push(ctx.on('session/disposed', (session) => {
      this.observeDisposedSession(session)
    }, { global: true }))
    ctx.effect(() => () => this.dispose(), 'pi-tui-history-search-service')
    const warmup = this.bootstrap()
    this.warmupSettled = warmup.then(() => undefined, () => undefined)
    runDetached('history search index bootstrap', () => warmup, { diag: this.diag })
  }

  /**
   * The private `search` Remote method. The Owner gate runs BEFORE request
   * parsing (pure) and again before the answer; every official/index read
   * happens between those checks.
   */
  async search(request: unknown, signal: AbortSignal): Promise<HistorySearchResponse> {
    const invocation = this.requireOwner(signal)
    const exact = parseHistorySearchRequest(request)
    const runSignal = this.liveSignal(signal, invocation)
    runSignal.throwIfAborted()
    if (this.disposed) return { kind: 'unavailable', reason: 'index-unavailable' }
    await this.awaitWrites(runSignal)
    runSignal.throwIfAborted()
    this.assertSameLiveInvocation(invocation)
    const stateAnswer = this.stateAnswer()
    if (stateAnswer !== undefined) return stateAnswer
    const index = this.requireIndex()
    const scopeId = exact.scope === 'session'
      ? exact.sessionId
      : exact.scope === 'directory'
        ? normalizeHistoryCwd(exact.cwd)
        : null
    let after: HistorySearchAfter | undefined
    if (exact.cursor !== undefined) {
      let cursor
      try {
        cursor = decodeHistorySearchCursor(exact.cursor)
      } catch {
        return { kind: 'stale', reason: 'cursor-stale' }
      }
      if (
        cursor.incarnation !== this.incarnation
        || cursor.revision !== this.revision
        || cursor.scope !== exact.scope
        || cursor.query !== exact.query
        || cursor.scopeId !== scopeId
      ) {
        return { kind: 'stale', reason: 'cursor-stale' }
      }
      after = cursor.after
    }
    const page = index.search({
      scope: exact.scope,
      ...(exact.scope === 'session' ? { sessionId: exact.sessionId } : {}),
      ...(exact.scope === 'directory' ? { cwd: scopeId as string } : {}),
      query: exact.query,
      limit: exact.limit,
      ...(after === undefined ? {} : { after }),
    })
    runSignal.throwIfAborted()
    this.assertSameLiveInvocation(invocation)
    const last = page.rows.at(-1)
    const nextCursor = page.hasMore && last !== undefined
      ? encodeHistorySearchCursor({
        v: 1,
        incarnation: this.incarnation,
        revision: this.revision,
        scope: exact.scope,
        query: exact.query,
        scopeId,
        after: {
          acceptedAt: last.acceptedAt,
          sessionId: last.sessionId,
          firstEventSeq: last.firstEventSeq,
          messageId: last.messageId,
        },
      })
      : null
    return {
      kind: 'ready',
      generation: `${this.incarnation}#${String(this.revision)}`,
      items: page.rows.map(row => ({
        sessionId: row.sessionId,
        messageId: row.messageId,
        firstEventSeq: row.firstEventSeq,
        acceptedAt: row.acceptedAt,
        effectiveCwd: row.effectiveCwd,
        preview: row.preview,
        contentLength: row.contentLength,
        contentSha256: row.contentSha256,
        hasNonText: row.hasNonText,
      })),
      nextCursor,
    }
  }

  /** The private `readText` Remote method: exact original text by content hash. */
  async readText(request: unknown, signal: AbortSignal): Promise<HistoryReadTextResponse> {
    const invocation = this.requireOwner(signal)
    const exact = parseHistoryReadTextRequest(request)
    const runSignal = this.liveSignal(signal, invocation)
    runSignal.throwIfAborted()
    if (this.disposed) return { kind: 'unavailable', reason: 'index-unavailable' }
    await this.awaitWrites(runSignal)
    runSignal.throwIfAborted()
    this.assertSameLiveInvocation(invocation)
    const stateAnswer = this.stateAnswer()
    if (stateAnswer !== undefined) return stateAnswer
    const index = this.requireIndex()
    const row = index.occurrence(exact.sessionId, exact.messageId)
    if (row === undefined) return { kind: 'unavailable', reason: 'not-found' }
    if (row.contentSha256 !== exact.contentSha256) return { kind: 'unavailable', reason: 'stale-content' }
    if (exact.offset > row.content.length) return { kind: 'unavailable', reason: 'stale-content' }
    const { chunk, nextOffset } = historyReadTextChunk(row.content, exact.offset, exact.limit)
    runSignal.throwIfAborted()
    this.assertSameLiveInvocation(invocation)
    return { kind: 'ready', chunk, nextOffset, contentLength: row.content.length }
  }

  /** Abort owned work, remove listeners, wait for the serial queue, close the DB. */
  /** Cursor generation: exactly the index's committed content revision. */
  private get revision(): number {
    return this.index?.revision ?? 0
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.lifecycle.abort()
    for (const remove of this.listenerDisposers) remove()
    this.listenerDisposers.length = 0
    if (this.verificationTimer !== undefined) {
      clearTimeout(this.verificationTimer)
      this.verificationTimer = undefined
    }
    this.disposal = (async () => {
      await this.warmupSettled
      await this.writeTail
      this.pending.clear()
      this.pendingEventCount = 0
      this.pendingBytes = 0
      this.liveSessions.clear()
      const index = this.index
      this.index = undefined
      index?.close()
      this.diag.dispose()
    })()
    return this.disposal
  }

  // ── live observation ─────────────────────────────────────────────────────

  private rememberLiveSession(session: unknown): void {
    if (this.disposed) return
    const record = session as { readonly id?: unknown; readonly header?: { readonly cwd?: string }; readonly inheritedEventCount?: number }
    if (record.id === undefined) return
    const sessionId = String(record.id)
    const inherited = typeof record.inheritedEventCount === 'number' && Number.isSafeInteger(record.inheritedEventCount)
      && record.inheritedEventCount >= 0
      ? record.inheritedEventCount
      : 0
    this.liveSessions.set(sessionId, { ...(record.header?.cwd === undefined ? {} : { headerCwd: record.header.cwd }), inheritedEventCount: inherited })
  }

  private observeLiveEvent(session: unknown, event: unknown): void {
    if (this.disposed) return
    // An unavailable index has no reconciliation path in this service
    // lifetime; buffering events would only delay the unavoidable overflow.
    if (this.state.kind === 'unavailable') return
    const record = session as { readonly id?: unknown; readonly header?: { readonly cwd?: string }; readonly inheritedEventCount?: number }
    if (record.id === undefined) return
    const sessionId = String(record.id)
    const parsed = eventOf(event)
    if (parsed === undefined) {
      // A committed live event that violates the structural contract cannot be
      // folded and must not be skipped: report the source as uncertain and
      // rebuild this Session from the official source.
      this.state = { kind: 'incomplete', reason: 'source-uncertain' }
      this.diag.warn('history search observed a malformed live event', { category: 'source-uncertain' })
      this.enqueueRebuild(sessionId)
      return
    }
    this.rememberLiveSession(session)
    const known = this.liveSessions.get(sessionId)
    const inherited = typeof record.inheritedEventCount === 'number' && Number.isSafeInteger(record.inheritedEventCount)
      && record.inheritedEventCount >= 0
      ? record.inheritedEventCount
      : known?.inheritedEventCount ?? 0
    const existing = this.pending.get(sessionId)
    const bytes = approximateEventBytes(parsed)
    if (existing === undefined) {
      this.pending.set(sessionId, {
        ...(record.header?.cwd === undefined ? {} : { headerCwd: record.header.cwd }),
        inheritedEventCount: inherited,
        events: [parsed],
        bytes,
      })
      this.pendingEventCount += 1
      this.pendingBytes += bytes
    } else {
      const duplicate = existing.events.find(candidate => candidate.seq === parsed.seq)
      if (duplicate !== undefined) {
        if (sessionEventHash(duplicate) === sessionEventHash(parsed)) return
        // Same sequence, different body: the buffered fact is no longer
        // trustworthy. Discard this Session's batch and rebuild it from the
        // official source instead of silently keeping either body.
        this.discardPendingSession(sessionId)
        this.state = { kind: 'incomplete', reason: 'reconciling' }
        this.diag.warn('history search observed a conflicting live sequence', { category: 'reconciling' })
        this.enqueueRebuild(sessionId)
        return
      }
      existing.events.push(parsed)
      existing.bytes += bytes
      this.pendingEventCount += 1
      this.pendingBytes += bytes
    }
    if (this.pendingEventCount > HISTORY_SEARCH_MAX_PENDING_EVENTS || this.pendingBytes > HISTORY_SEARCH_MAX_PENDING_BYTES) {
      this.handleOverflow()
      return
    }
    this.enqueueDrain()
  }

  /** Drop one buffered Session batch and keep the byte/event counters exact. */
  private discardPendingSession(sessionId: string): void {
    const pending = this.pending.get(sessionId)
    if (pending === undefined) return
    this.pending.delete(sessionId)
    this.pendingEventCount -= pending.events.length
    this.pendingBytes -= pending.bytes
  }

  /** Re-read one Session from the official source on the serial writer. */
  private enqueueRebuild(sessionId: string): void {
    this.enqueueWrite(async () => {
      const query = this.deps.sessionQuery()
      if (query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      await this.rebuildSession(sessionId, query)
      this.refreshCompleteness()
    })
  }

  private observeDisposedSession(session: unknown): void {
    if (this.disposed) return
    const record = session as { readonly id?: unknown }
    if (record.id === undefined) return
    const sessionId = String(record.id)
    this.liveSessions.delete(sessionId)
    this.enqueueWrite(async () => {
      // A disposed Session keeps its accepted rows: only the official durable
      // source can prove them, so re-verify before changing the checkpoint.
      await this.verifySessionAgainstPersistence(sessionId)
      this.recordCompletedDisposal()
    })
  }

  private handleOverflow(): void {
    this.bufferOverflows += 1
    const affected = [...this.pending.keys()]
    this.pending.clear()
    this.pendingEventCount = 0
    this.pendingBytes = 0
    if (this.state.kind !== 'unavailable') {
      this.state = { kind: 'incomplete', reason: 'resource-limit' }
    }
    this.diag.warn('history search live buffer reached its bound', { sessions: affected.length })
    this.enqueueWrite(async () => {
      const query = this.deps.sessionQuery()
      if (query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      for (const sessionId of affected) {
        await this.rebuildSession(sessionId, query)
      }
      this.refreshCompleteness()
    })
  }

  // ── serial write queue ───────────────────────────────────────────────────

  /**
   * Append one task to the ONE serial index writer. The returned tail never
   * rejects: failures are classified, mark the index incomplete and schedule a
   * reconcile, so a later query never inherits a poisoned queue.
   */
  private enqueueWrite(task: () => Promise<void>): void {
    const run = this.writeTail.then(task, task)
    this.writeTail = run.catch(error => {
      if (this.lifecycle.signal.aborted || this.disposed) return
      this.diag.warn('history search index write failed', { category: error instanceof Error ? error.name : 'unknown' })
      // Keep the index CLOSED until a later successful write proves it safe
      // again: a refresh that only re-reads must not promote an unsafe derived
      // store (for example a tampered sidecar) back to `ready`.
      this.indexFaulted = true
      if (this.state.kind !== 'unavailable') {
        this.state = { kind: 'incomplete', reason: 'source-read-failed' }
      }
    })
  }

  private enqueueDrain(): void {
    // A synchronous official batch may publish thousands of events before any
    // microtask runs. ONE queued drain reads the bounded pending map when it
    // starts; events that arrive while a drain is ACTIVE schedule the next
    // drain (the flag is already reset by then), so no event is stranded and
    // the Promise queue stays O(1) instead of O(events).
    if (this.drainScheduled) return
    this.drainScheduled = true
    this.drainSchedules += 1
    this.enqueueWrite(async () => {
      this.drainScheduled = false
      await this.drainPending()
    })
  }

  private async awaitWrites(signal: AbortSignal): Promise<void> {
    const tail = this.writeTail
    if (signal.aborted) throw signal.reason
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        try {
          signal.throwIfAborted()
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      tail.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private async drainPending(): Promise<void> {
    if (this.disposed || this.pending.size === 0) return
    if (this.state.kind === 'loading') return
    if (this.index === undefined) return
    const batches = new Map(this.pending)
    this.pending.clear()
    this.pendingEventCount = 0
    this.pendingBytes = 0
    const rebuild: string[] = []
    for (const [sessionId, batch] of batches) {
      if (this.lifecycle.signal.aborted) return
      const checkpoint = this.index.checkpointOf(sessionId)
      if (checkpoint === undefined || checkpoint.dirty) {
        rebuild.push(sessionId)
        continue
      }
      try {
        this.commitLiveBatch(sessionId, checkpoint, batch)
      } catch (error) {
        // The buffered events are already out of the queue: mark BEFORE
        // rethrowing so the periodic verification rebuilds this Session from
        // the official source instead of permanently skipping the batch.
        this.index.markSession({ sessionId, dirty: true })
        if (error instanceof HistorySearchGapError || error instanceof HistorySearchConflictError) {
          rebuild.push(sessionId)
          continue
        }
        throw error
      }
    }
    for (const sessionId of rebuild) {
      const query = this.deps.sessionQuery()
      if (query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      try {
        await this.rebuildSession(sessionId, query)
      } catch (error) {
        this.index.markSession({ sessionId, dirty: true })
        throw error
      }
    }
    this.refreshCompleteness()
  }

  private commitLiveBatch(sessionId: string, checkpoint: HistorySessionCheckpointRow, batch: PendingSession): void {
    if (batch.inheritedEventCount !== checkpoint.inheritedCut) {
      throw new HistorySearchConflictError(sessionId, 'the fork-inherited cut changed')
    }
    if (normalizeHistoryCwd(batch.headerCwd) !== checkpoint.headerCwd) {
      throw new HistorySearchConflictError(sessionId, 'the Session header directory changed')
    }
    const eventList = batch.events
      .filter(event => event.seq >= checkpoint.nextSeq)
      .sort((left, right) => left.seq - right.seq)
    // A re-delivered event that overlaps the committed tail must be the SAME
    // official event; a differing body means this Session object was replaced.
    if (checkpoint.lastEventHash !== null && checkpoint.nextSeq > 0) {
      const overlap = batch.events.find(event => event.seq === checkpoint.nextSeq - 1)
      if (overlap !== undefined && sessionEventHash(overlap) !== checkpoint.lastEventHash) {
        throw new HistorySearchConflictError(sessionId, 'the committed tail hash changed')
      }
    }
    const events = this.contiguousEvents(sessionId, checkpoint.nextSeq, eventList)
    if (events.length === 0) return
    this.writeBatch({
      sessionId,
      headerHash: checkpoint.headerHash,
      inheritedEventCount: checkpoint.inheritedCut,
      headerCwd: checkpoint.headerCwd,
      baseNextSeq: checkpoint.nextSeq,
      effectiveCwd: checkpoint.effectiveCwd,
      sourceState: checkpoint.sourceState,
      events,
    })
  }

  private contiguousEvents(sessionId: string, startSeq: number, events: readonly HostAdmissionEventLike[]): HostAdmissionEventLike[] {
    const accepted: HostAdmissionEventLike[] = []
    let expected = startSeq
    for (const event of events) {
      if (event.seq < expected) continue
      if (event.seq !== expected) throw new HistorySearchGapError(sessionId, expected, event.seq)
      accepted.push(event)
      expected += 1
    }
    return accepted
  }

  /**
   * Fold one contiguous event batch and commit its occurrence rows + the new
   * checkpoint in ONE index transaction. Returns the new effective cwd.
   */
  private writeBatch(input: {
    readonly sessionId: string
    readonly headerHash: string
    readonly inheritedEventCount: number
    readonly headerCwd: string | null
    readonly baseNextSeq: number
    readonly effectiveCwd: string | null
    readonly sourceState: 'persisted' | 'live'
    readonly events: readonly HostAdmissionEventLike[]
  }): { readonly effectiveCwd: string | null; readonly lastEventHash: string | null } {
    const index = this.requireIndex()
    // ONE shared monotonic contract for every replay path: the batch must be
    // the exact contiguous official sequence starting at the committed
    // checkpoint. A gap, duplicate or reordered element is a source breach and
    // must never advance the derived checkpoint past an unobserved seq.
    let expectedSeq = input.baseNextSeq
    for (const event of input.events) {
      if (event.seq !== expectedSeq) {
        throw new HistorySearchConflictError(
          input.sessionId,
          `expected seq ${String(expectedSeq)} but observed ${String(event.seq)}`,
        )
      }
      expectedSeq += 1
    }
    const initialCwd = input.effectiveCwd ?? input.headerCwd
    const fold = new HostAdmissionFold({
      sessionId: input.sessionId,
      ...(initialCwd === null ? {} : { headerCwd: initialCwd }),
      inheritedEventCount: input.inheritedEventCount,
      startSeq: input.baseNextSeq - 1,
    })
    fold.apply(input.events)
    const delta = fold.drainEvidence()
    const lastEvent = input.events.at(-1)
    const occurrences: HistoryOccurrenceInput[] = delta.occurrences.map((occurrence: HostAdmissionOccurrence) => ({
      messageId: occurrence.messageId,
      firstEventSeq: occurrence.firstEventSeq,
      acceptedAt: occurrence.acceptedAt,
      effectiveCwd: normalizeHistoryCwd(occurrence.cwd),
      content: occurrence.content,
      hasNonText: occurrence.hasNonText,
    }))
    const effectiveCwd = normalizeHistoryCwd(fold.currentCwd)
    const lastEventHash = lastEvent === undefined ? null : sessionEventHash(lastEvent)
    const nextSeq = expectedSeq
    index.commitBatch({
      sessionId: input.sessionId,
      headerHash: input.headerHash,
      inheritedCut: input.inheritedEventCount,
      baseNextSeq: input.baseNextSeq,
      nextSeq,
      headerCwd: normalizeHistoryCwd(input.headerCwd),
      effectiveCwd,
      lastEventHash,
      sourceState: input.sourceState,
      uncertainSourcesDelta: delta.unknownSourceCount + delta.invalidCwdCount,
      occurrences,
    })
    // A successful commit proves the private file set is usable again.
    this.indexFaulted = false
    return { effectiveCwd, lastEventHash }
  }

  // ── bootstrap / cold replay ──────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    const startedAt = performance.now()
    const counters: HistorySearchPhaseCounters = {
      sessionsVisited: 0,
      replayAttempted: 0,
      replayCompleted: 0,
      replayElapsedMsTotal: 0,
      replayElapsedMsMax: 0,
    }
    let outcome: HistorySearchPhaseOutcome = 'incomplete'
    try {
      const profile = this.deps.profileContext()
      const persistence = this.deps.sessionPersistence()
      const query = this.deps.sessionQuery()
      if (profile === undefined || persistence === undefined || query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        outcome = 'unavailable'
        return
      }
      let index: HistorySearchIndex
      try {
        index = HistorySearchIndex.open({ profileDir: profile.dir, signal: this.lifecycle.signal })
      } catch (error) {
        this.state = { kind: 'unavailable', reason: 'index-unavailable' }
        this.diag.warn('history search index unavailable', {
          category: error instanceof HistorySearchIndexUnavailableError ? 'unsafe-or-foreign' : 'open-failed',
        })
        outcome = 'unavailable'
        return
      }
      this.index = index
      await this.coldStart(persistence, query, counters)
      outcome = this.settledPhaseOutcome()
    } catch (error) {
      if (this.lifecycle.signal.aborted || this.disposed) return
      if (this.state.kind !== 'unavailable') {
        this.state = { kind: 'incomplete', reason: 'source-read-failed' }
      }
      this.diag.warn('history search bootstrap failed', { category: error instanceof Error ? error.name : 'unknown' })
    } finally {
      if (this.lifecycle.signal.aborted || this.disposed) outcome = 'cancelled'
      this.logPhaseEnd('history-search.bootstrap.end', outcome, startedAt, counters)
      this.scheduleVerification()
    }
  }

  private async coldStart(
    persistence: HistorySearchPersistenceLike,
    query: HistorySearchQueryLike,
    counters: HistorySearchPhaseCounters,
  ): Promise<void> {
    const signal = this.lifecycle.signal
    const official = await this.enumerateOfficialSessions(persistence, query, signal, 'cold_start')
    const index = this.requireIndex()
    index.deleteSessionsExcept(new Set(official.keys()))
    for (const [sessionId, record] of official) {
      counters.sessionsVisited += 1
      signal.throwIfAborted()
      // A checkpoint read from disk belongs to a PREVIOUS process. Its revision
      // is not comparable here and a tail hash alone cannot prove the prefix,
      // so cold start always rebuilds from the official source.
      if (index.checkpointOf(sessionId) !== undefined) index.resetSession(sessionId)
      await this.replayOfficialSession(sessionId, record, persistence, query, counters)
      this.rememberVerifiedRevision(sessionId, record, persistence)
      this.drainPendingSession(sessionId)
      await yieldEventLoop()
    }
    // Sessions born during the warmup window were buffered by the listener
    // before they could appear in the persisted enumeration.
    for (const sessionId of [...this.pending.keys()]) {
      if (this.index?.checkpointOf(sessionId) !== undefined) {
        this.drainPendingSession(sessionId)
        continue
      }
      counters.sessionsVisited += 1
      await this.rebuildSession(sessionId, query)
    }
    this.refreshCompleteness()
  }

  private async enumerateOfficialSessions(
    persistence: HistorySearchPersistenceLike,
    query: HistorySearchQueryLike,
    signal: AbortSignal,
    phase: HistorySearchInventoryPhase,
  ): Promise<Map<string, OfficialSession>> {
    const startedAt = performance.now()
    let outcome: 'ok' | 'error' | 'cancelled' = 'error'
    let directPersistenceListCalls = 0
    let queryListSessionsCalls = 0
    let persistedRows = 0
    let mergedRows = 0
    this.logDiagnostic('history-search.inventory.start', {
      phase,
      directPersistenceListCalls: 1,
      queryListSessionsCalls: 1,
    })
    try {
      directPersistenceListCalls += 1
      const snapshots = await persistence.list({ signal })
      queryListSessionsCalls += 1
      const records = await query.listSessions(signal)
      signal.throwIfAborted()
      const union = new Map<string, OfficialSession>()
      for (const snapshot of snapshots) {
        const sessionId = String(snapshot.header.id)
        union.set(sessionId, {
          header: snapshot.header,
          live: false,
          ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
          ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
        })
      }
      for (const record of records) {
        const sessionId = String(record.header.id)
        const existing = union.get(sessionId)
        union.set(sessionId, {
          header: record.header,
          live: record.live === true || existing?.live === true,
          ...(existing?.eventCount === undefined ? {} : { eventCount: existing.eventCount }),
          // sessionQuery.listSessions() has no persistence revision; the
          // persistence snapshot's revision must survive the union, otherwise the
          // equal-header/equal-count content-change check below loses its ONLY
          // authoritative unchanged fact.
          ...(existing?.revision === undefined ? {} : { revision: existing.revision }),
        })
      }
      persistedRows = snapshots.length
      mergedRows = union.size
      outcome = 'ok'
      return union
    } catch (error) {
      if (signal.aborted) outcome = 'cancelled'
      throw error
    } finally {
      this.logDiagnostic('history-search.inventory.end', {
        phase,
        outcome,
        elapsedMs: elapsedMilliseconds(startedAt),
        ...(outcome === 'ok' ? { persistedRows, mergedRows } : {}),
        directPersistenceListCalls,
        queryListSessionsCalls,
      })
    }
  }

  /** Replay one official Session from its persisted checkpoint (incremental or rebuild). */
  private async replayOfficialSession(
    sessionId: string,
    record: OfficialSession,
    persistence: HistorySearchPersistenceLike,
    query: HistorySearchQueryLike,
    counters: HistorySearchPhaseCounters,
  ): Promise<void> {
    counters.replayAttempted += 1
    const startedAt = performance.now()
    try {
      const signal = this.lifecycle.signal
      const headerHash = sessionHeaderHash(record.header)
      let checkpoint = this.index?.checkpointOf(sessionId)
      if (checkpoint !== undefined && checkpoint.headerHash !== headerHash) {
        this.index?.resetSession(sessionId)
        checkpoint = undefined
      }
      if (record.live) {
        const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal })
        try {
          const inherited = Number(observation.inheritedEventCount)
          const events = eventsOf(observation.events, sessionId)
          await this.replayEventList(sessionId, observation.header, inherited, events, checkpoint, 'live')
        } finally {
          observation[Symbol.dispose]()
        }
      } else {
        const handle = await persistence.open(sessionId, 'read', { signal })
        try {
          await this.replayHandle(sessionId, handle, checkpoint, record.eventCount)
        } finally {
          await handle.close()
        }
      }
      counters.replayCompleted += 1
    } finally {
      const elapsed = elapsedMilliseconds(startedAt)
      counters.replayElapsedMsTotal += elapsed
      counters.replayElapsedMsMax = Math.max(counters.replayElapsedMsMax, elapsed)
    }
  }

  private async replayHandle(
    sessionId: string,
    handle: HistorySearchReadHandleLike,
    checkpoint: HistorySessionCheckpointRow | undefined,
    expectedEventCount: number | undefined,
  ): Promise<void> {
    const signal = this.lifecycle.signal
    const headerHash = sessionHeaderHash(handle.header)
    const inherited = Number(handle.inheritedEventCount)
    const headerCwd = normalizeHistoryCwd(handle.header.cwd)
    let nextSeq = checkpoint?.nextSeq ?? 0
    let effectiveCwd = checkpoint?.effectiveCwd ?? headerCwd
    let lastEventHash = checkpoint?.lastEventHash ?? null
    if (checkpoint !== undefined && checkpoint.inheritedCut !== inherited) {
      this.index?.resetSession(sessionId)
      nextSeq = 0
      effectiveCwd = headerCwd
      lastEventHash = null
    }
    if (nextSeq > 0) {
      const tail = await handle.read(nextSeq - 1, 1, { signal })
      const tailEvent = tail.events[0]
      if (tailEvent === undefined || tailEvent.seq !== nextSeq - 1 || sessionEventHash(tailEvent) !== lastEventHash) {
        this.index?.resetSession(sessionId)
        nextSeq = 0
        effectiveCwd = headerCwd
        lastEventHash = null
      }
    }
    for (;;) {
      signal.throwIfAborted()
      const slice = await handle.read(nextSeq, HISTORY_SEARCH_READ_BATCH, { signal })
      const events = eventsOf(slice.events, sessionId)
      if (events.length === 0) break
      const result = this.writeBatch({
        sessionId,
        headerHash,
        inheritedEventCount: inherited,
        headerCwd,
        baseNextSeq: nextSeq,
        effectiveCwd,
        sourceState: 'persisted',
        events,
      })
      nextSeq = events[events.length - 1]!.seq + 1
      effectiveCwd = result.effectiveCwd
      lastEventHash = result.lastEventHash
      if (events.length < HISTORY_SEARCH_READ_BATCH) break
      await yieldEventLoop()
    }
    // A read that ends before the advertised durable count is a truncated
    // official tail, never a complete projection.
    if (expectedEventCount !== undefined && nextSeq !== expectedEventCount) {
      throw new HistorySearchConflictError(
        sessionId,
        `the official log ended at ${String(nextSeq)} before its advertised count ${String(expectedEventCount)}`,
      )
    }
  }

  private async replayEventList(
    sessionId: string,
    header: HistorySearchHeaderLike,
    inherited: number,
    events: readonly HistorySearchEventLike[],
    checkpoint: HistorySessionCheckpointRow | undefined,
    sourceState: 'persisted' | 'live',
  ): Promise<void> {
    const headerHash = sessionHeaderHash(header)
    const headerCwd = normalizeHistoryCwd(header.cwd)
    let nextSeq = checkpoint?.nextSeq ?? 0
    let effectiveCwd = checkpoint?.effectiveCwd ?? headerCwd
    let lastEventHash = checkpoint?.lastEventHash ?? null
    if (checkpoint !== undefined && checkpoint.inheritedCut !== inherited) {
      this.index?.resetSession(sessionId)
      nextSeq = 0
      effectiveCwd = headerCwd
      lastEventHash = null
    }
    if (nextSeq > 0) {
      const tail = events[nextSeq - 1]
      if (tail === undefined || tail.seq !== nextSeq - 1 || sessionEventHash(tail) !== lastEventHash) {
        this.index?.resetSession(sessionId)
        nextSeq = 0
        effectiveCwd = headerCwd
        lastEventHash = null
      }
    }
    for (;;) {
      this.lifecycle.signal.throwIfAborted()
      const slice = events.slice(nextSeq, nextSeq + HISTORY_SEARCH_READ_BATCH)
      if (slice.length === 0) break
      const result = this.writeBatch({
        sessionId,
        headerHash,
        inheritedEventCount: inherited,
        headerCwd,
        baseNextSeq: nextSeq,
        effectiveCwd,
        sourceState,
        events: slice,
      })
      nextSeq = slice[slice.length - 1]!.seq + 1
      effectiveCwd = result.effectiveCwd
      lastEventHash = result.lastEventHash
      if (slice.length < HISTORY_SEARCH_READ_BATCH) break
      await yieldEventLoop()
    }
    // A contiguous log starting at seq 0 must end exactly at its length.
    if (nextSeq !== events.length) {
      throw new HistorySearchConflictError(
        sessionId,
        `the official observation ended at ${String(nextSeq)} for ${String(events.length)} events`,
      )
    }
  }

  /** Rebuild one Session from a complete official observation (live preferred). */
  private async rebuildSession(sessionId: string, query: HistorySearchQueryLike): Promise<void> {
    const signal = this.lifecycle.signal
    const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal })
    try {
      const inherited = Number(observation.inheritedEventCount)
      const events = eventsOf(observation.events, sessionId)
      this.index?.resetSession(sessionId)
      await this.replayEventList(sessionId, observation.header, inherited, events, undefined, 'live')
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private drainPendingSession(sessionId: string): void {
    const batch = this.pending.get(sessionId)
    if (batch === undefined || this.index === undefined) return
    this.pending.delete(sessionId)
    this.pendingEventCount -= batch.events.length
    this.pendingBytes -= batch.bytes
    const checkpoint = this.index.checkpointOf(sessionId)
    if (checkpoint === undefined || checkpoint.dirty) return
    try {
      this.commitLiveBatch(sessionId, checkpoint, batch)
    } catch (error) {
      if (error instanceof HistorySearchGapError || error instanceof HistorySearchConflictError) {
        this.index.markSession({ sessionId, dirty: true })
        return
      }
      throw error
    }
  }

  // ── external-source verification ────────────────────────────────────────

  private scheduleVerification(): void {
    if (this.disposed || this.lifecycle.signal.aborted) return
    this.verificationTimer = setTimeout(() => {
      this.verificationTimer = undefined
      this.enqueueWrite(async () => {
        try {
          await this.verifySources()
        } finally {
          this.scheduleVerification()
        }
      })
    }, HISTORY_SEARCH_VERIFICATION_INTERVAL_MS)
    this.verificationTimer.unref?.()
  }

  private async verifySources(): Promise<void> {
    const startedAt = performance.now()
    const counters: HistorySearchPhaseCounters = {
      sessionsVisited: 0,
      replayAttempted: 0,
      replayCompleted: 0,
      replayElapsedMsTotal: 0,
      replayElapsedMsMax: 0,
    }
    let outcome: HistorySearchPhaseOutcome = 'incomplete'
    try {
      if (this.disposed || this.index === undefined) {
        outcome = this.settledPhaseOutcome()
        return
      }
      const persistence = this.deps.sessionPersistence()
      const query = this.deps.sessionQuery()
      if (persistence === undefined || query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        outcome = 'unavailable'
        return
      }
      const signal = this.lifecycle.signal
      const official = await this.enumerateOfficialSessions(persistence, query, signal, 'periodic_verify')
      const removed = this.index.deleteSessionsExcept(new Set(official.keys()))
      for (const sessionId of removed) this.verifiedRevisions.delete(sessionId)
      for (const [sessionId, record] of official) {
        counters.sessionsVisited += 1
        signal.throwIfAborted()
        let checkpoint = this.index.checkpointOf(sessionId)
        if (
          checkpoint !== undefined
          && checkpoint.sourceState === 'live'
          && !record.live
          && (checkpoint.dirty || checkpoint.uncertainSources > 0)
        ) {
          // Disposed provisional rows: never reset before the official durable
          // source proves the claimed prefix. A short source is append lag, not a
          // rollback; truncating it into `ready` would silently drop accepted rows.
          const proof = await this.proveDurablePrefix(sessionId, checkpoint, persistence)
          signal.throwIfAborted()
          if (proof === 'insufficient' || proof === 'unreadable') {
            this.index.markSession({ sessionId, dirty: true })
            this.state = {
              kind: 'incomplete',
              reason: proof === 'unreadable' ? 'source-read-failed' : 'reconciling',
            }
            continue
          }
          if (proof === 'rollback') {
            // Header/cut/tail explicitly replaced: the official source is the
            // authoritative rollback and a rebuild is safe.
            this.index.resetSession(sessionId)
            await this.replayOfficialSession(sessionId, record, persistence, query, counters)
            this.rememberVerifiedRevision(sessionId, record, persistence)
            continue
          }
          // The claimed prefix is present: settle the provisional marker, then
          // apply the normal revision rules below.
          this.index.markSession({ sessionId, sourceState: 'persisted', dirty: false })
          checkpoint = this.index.checkpointOf(sessionId)
          if (checkpoint === undefined) continue
        } else if (checkpoint === undefined || checkpoint.dirty || checkpoint.uncertainSources > 0) {
          // A dirty/uncertain checkpoint cannot prove its whole prefix from the
          // tail alone (a middle event may have been repaired), and an incremental
          // replay that finds no new tail events would never call writeBatch(),
          // leaving dirty set forever. Reconcile from official events instead.
          if (checkpoint !== undefined) this.index.resetSession(sessionId)
          await this.replayOfficialSession(sessionId, record, persistence, query, counters)
          this.rememberVerifiedRevision(sessionId, record, persistence)
          continue
        }
        if (checkpoint.headerHash !== sessionHeaderHash(record.header)) {
          this.index.resetSession(sessionId)
          await this.replayOfficialSession(sessionId, record, persistence, query, counters)
          this.rememberVerifiedRevision(sessionId, record, persistence)
          continue
        }
        if (!record.live && record.eventCount !== undefined && record.eventCount < checkpoint.nextSeq) {
          // A durable tail shrink is a rollback: rebuild from the official log.
          // A LIVE Session's persistence count may legitimately lag its accepted
          // events (append is not the durability barrier), so it is never read as
          // a shrink here.
          this.index.resetSession(sessionId)
          await this.replayOfficialSession(sessionId, record, persistence, query, counters)
          this.rememberVerifiedRevision(sessionId, record, persistence)
          continue
        }
        if (!record.live) {
          const unchanged = this.revisionUnchanged(sessionId, record, persistence)
          const extended = record.eventCount !== undefined && record.eventCount > checkpoint.nextSeq
          if (!unchanged || extended) {
            if (!unchanged) {
              // A changed or absent same-instance revision is NOT proof that the
              // old prefix survived a middle-of-log repair, even when the tail
              // event hash still matches. Rebuild this Session from official
              // events instead of trusting the stored checkpoint.
              this.index.resetSession(sessionId)
            }
            await this.replayOfficialSession(sessionId, record, persistence, query, counters)
            this.rememberVerifiedRevision(sessionId, record, persistence)
            continue
          }
        }
        if (checkpoint.sourceState === 'live' && !record.live && record.eventCount !== undefined && record.eventCount >= checkpoint.nextSeq) {
          this.index.markSession({ sessionId, sourceState: 'persisted' })
        }
      }
      this.drainAllPendingNow()
      this.refreshCompleteness()
      outcome = this.settledPhaseOutcome()
    } finally {
      if (this.lifecycle.signal.aborted || this.disposed) outcome = 'cancelled'
      this.logPhaseEnd('history-search.verify.end', outcome, startedAt, counters)
    }
  }

  private rememberVerifiedRevision(
    sessionId: string,
    record: OfficialSession,
    persistence: HistorySearchPersistenceLike,
  ): void {
    if (record.live) return
    this.verifiedRevisions.set(sessionId, { identity: persistence.identity, revision: record.revision })
  }

  private revisionUnchanged(
    sessionId: string,
    record: OfficialSession,
    persistence: HistorySearchPersistenceLike,
  ): boolean {
    const tracked = this.verifiedRevisions.get(sessionId)
    if (tracked === undefined) return false
    if (tracked.identity !== persistence.identity) return false
    // Without a revision on BOTH sides there is no authoritative "unchanged"
    // fact: re-read the official source instead of trusting an absent token.
    if (record.revision === undefined || tracked.revision === undefined) return false
    return tracked.revision === record.revision
  }

  private drainAllPendingNow(): void {
    if (this.pending.size === 0 || this.index === undefined) return
    const sessions = [...this.pending.keys()]
    for (const sessionId of sessions) {
      try {
        this.drainPendingSession(sessionId)
      } catch (error) {
        if (error instanceof HistorySearchGapError || error instanceof HistorySearchConflictError) {
          this.index.markSession({ sessionId, dirty: true })
          continue
        }
        throw error
      }
    }
  }

  /**
   * Read-only proof that the official durable log contains the exact prefix a
   * checkpoint claims. `insufficient` means the source is shorter/unreadable
   * (not a rollback); `rollback` means the identity/cut/tail explicitly differs.
   */
  private async proveDurablePrefix(
    sessionId: string,
    checkpoint: HistorySessionCheckpointRow,
    persistence: HistorySearchPersistenceLike,
  ): Promise<'proven' | 'insufficient' | 'rollback' | 'unreadable'> {
    const signal = this.lifecycle.signal
    let handle: HistorySearchReadHandleLike
    try {
      handle = await persistence.open(sessionId, 'read', { signal })
    } catch (error) {
      if (this.disposed || this.lifecycle.signal.aborted) throw error
      return 'unreadable'
    }
    try {
      if (
        sessionHeaderHash(handle.header) !== checkpoint.headerHash
        || Number(handle.inheritedEventCount) !== checkpoint.inheritedCut
      ) {
        return 'rollback'
      }
      if (checkpoint.nextSeq === 0) return 'proven'
      const tail = await handle.read(checkpoint.nextSeq - 1, 1, { signal })
      const event = tail.events[0]
      if (event === undefined) return 'insufficient'
      if (event.seq !== checkpoint.nextSeq - 1 || sessionEventHash(event) !== checkpoint.lastEventHash) {
        return 'rollback'
      }
      return 'proven'
    } catch (error) {
      if (this.disposed || this.lifecycle.signal.aborted) throw error
      return 'unreadable'
    } finally {
      await handle.close()
    }
  }

  private async verifySessionAgainstPersistence(sessionId: string): Promise<void> {
    const verifyStartedAt = performance.now()
    const counters = this.disposalCounters
    counters.seen += 1
    try {
      if (this.disposed || this.index === undefined) return
      const persistence = this.deps.sessionPersistence()
      if (persistence === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      // A Session without a derived checkpoint has nothing to prove: skip the
      // official read instead of observing a Session this index never held.
      const checkpoint = this.index.checkpointOf(sessionId)
      if (checkpoint === undefined) return
      const signal = this.lifecycle.signal
      counters.statCalls += 1
      const statStartedAt = performance.now()
      let snapshot: HistorySearchPersistenceSnapshotLike | undefined
      try {
        snapshot = await persistence.stat(sessionId, { signal })
      } finally {
        counters.statElapsedMsTotal += elapsedMilliseconds(statStartedAt)
      }
      if (snapshot === undefined) {
        counters.statNotFound += 1
        // Not durable: keep the speculative rows and report the honest state.
        this.state = { kind: 'incomplete', reason: 'source-uncertain' }
        this.index.markSession({ sessionId, dirty: true })
        return
      }
      if (checkpoint.headerHash !== sessionHeaderHash(snapshot.header)) {
        this.index.markSession({ sessionId, dirty: true })
        this.state = { kind: 'incomplete', reason: 'reconciling' }
        return
      }
      if (snapshot.eventCount !== undefined && snapshot.eventCount < checkpoint.nextSeq) {
        this.index.markSession({ sessionId, dirty: true })
        this.state = { kind: 'incomplete', reason: 'reconciling' }
        return
      }
      // rc.5 JSONL `stat()` does not always provide eventCount, so an absent
      // count is NOT proof that the live rows are durable. Prove the exact
      // prefix this checkpoint claims before it may become `persisted`.
      const proof = await this.proveDurablePrefix(sessionId, checkpoint, persistence)
      if (proof === 'proven') counters.proofProven += 1
      else if (proof === 'insufficient') counters.proofInsufficient += 1
      else if (proof === 'rollback') counters.proofRollback += 1
      else counters.proofUnreadable += 1
      if (this.disposed || this.lifecycle.signal.aborted) return
      if (proof === 'unreadable') {
        this.diag.warn('history search disposed-session proof failed', { category: 'unreadable-source' })
        this.index.markSession({ sessionId, dirty: true })
        this.state = { kind: 'incomplete', reason: 'source-read-failed' }
        return
      }
      if (proof !== 'proven') {
        // Short/unreadable prefix is append lag, not a rollback: keep the rows
        // and the provisional checkpoint and retry through the normal pass.
        this.index.markSession({ sessionId, dirty: true })
        this.state = { kind: 'incomplete', reason: 'reconciling' }
        return
      }
      this.index.markSession({ sessionId, sourceState: 'persisted', dirty: false })
      this.refreshCompleteness()
    } finally {
      counters.verifyElapsedMsTotal += elapsedMilliseconds(verifyStartedAt)
    }
  }

  /** Emit the bounded disposal aggregate after one COMPLETED verification. */
  private recordCompletedDisposal(): void {
    const counters = this.disposalCounters
    counters.completed += 1
    if (counters.completed !== 1 && counters.completed % 128 !== 0) return
    this.logDiagnostic('history-search.disposals', {
      seen: counters.seen,
      statCalls: counters.statCalls,
      statNotFound: counters.statNotFound,
      proofProven: counters.proofProven,
      proofInsufficient: counters.proofInsufficient,
      proofRollback: counters.proofRollback,
      proofUnreadable: counters.proofUnreadable,
      statElapsedMsTotal: roundMilliseconds(counters.statElapsedMsTotal),
      verifyElapsedMsTotal: roundMilliseconds(counters.verifyElapsedMsTotal),
    })
  }

  /** One debug-only diagnostic line; a no-op unless explicit debug logging is on. */
  private logDiagnostic(message: string, fields: Record<string, unknown>): void {
    if (!this.diagnosticsEnabled) return
    this.diag.debug(message, fields)
  }

  /** One pass summary; `outcome` is derived from the ONE real IndexState. */
  private logPhaseEnd(
    message: 'history-search.bootstrap.end' | 'history-search.verify.end',
    outcome: HistorySearchPhaseOutcome,
    startedAt: number,
    counters: HistorySearchPhaseCounters,
  ): void {
    this.logDiagnostic(message, {
      outcome,
      elapsedMs: elapsedMilliseconds(startedAt),
      sessionsVisited: counters.sessionsVisited,
      replayAttempted: counters.replayAttempted,
      replayCompleted: counters.replayCompleted,
      replayElapsedMsTotal: roundMilliseconds(counters.replayElapsedMsTotal),
      replayElapsedMsMax: roundMilliseconds(counters.replayElapsedMsMax),
    })
  }

  /** The diagnostic outcome of a pass that settled normally. */
  private settledPhaseOutcome(): HistorySearchPhaseOutcome {
    if (this.state.kind === 'ready') return 'ready'
    if (this.state.kind === 'unavailable') return 'unavailable'
    return 'incomplete'
  }

  private refreshCompleteness(): void {
    if (this.disposed || this.index === undefined) return
    if (this.indexFaulted) {
      this.state = { kind: 'incomplete', reason: 'source-read-failed' }
      return
    }
    const checkpoints = this.index.listSessions()
    if (checkpoints.some(checkpoint => checkpoint.dirty)) {
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      return
    }
    if (checkpoints.some(checkpoint => checkpoint.uncertainSources > 0)) {
      this.state = { kind: 'incomplete', reason: 'source-uncertain' }
      return
    }
    if (this.state.kind === 'loading' || this.state.kind === 'incomplete') {
      this.state = { kind: 'ready' }
    }
    // A live batch that arrived while the state was still `loading` may have
    // been skipped by its queued drain (the cold pass had not finished); once
    // the index is complete, drain that stranded buffer instead of waiting for
    // the next event or the next periodic verification.
    if (this.pending.size > 0) this.enqueueDrain()
  }

  // ── answer helpers ───────────────────────────────────────────────────────

  /**
   * The non-ready answer shared by both reads. `undefined` means the caller may
   * continue with the index read; the reason vocabularies are the intersection
   * both response unions accept (`index-unavailable`/`service-missing`).
   */
  private stateAnswer():
    | { readonly kind: 'loading' }
    | { readonly kind: 'incomplete'; readonly reason: HistorySearchIncompleteReason }
    | { readonly kind: 'unavailable'; readonly reason: 'index-unavailable' | 'service-missing' }
    | undefined {
    const state = this.state
    if (state.kind === 'ready') return undefined
    if (state.kind === 'loading') return { kind: 'loading' }
    if (state.kind === 'incomplete') return { kind: 'incomplete', reason: state.reason }
    return { kind: 'unavailable', reason: state.reason }
  }

  private requireIndex(): HistorySearchIndex {
    const index = this.index
    if (index === undefined) throw new Error('piTuiHistorySearch: the derived index is not open')
    return index
  }

  private requireOwner(signal: AbortSignal): RemoteInvocation {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiHistorySearch: Host accepted input history is restricted to the authenticated Owner peer')
    }
    return invocation
  }

  private liveSignal(signal: AbortSignal, invocation: RemoteInvocation): AbortSignal {
    return AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }

  private assertSameLiveInvocation(invocation: RemoteInvocation): void {
    if (this.ctx.invocation !== invocation || !this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiHistorySearch: the Owner invocation ended before the history answer')
    }
  }
}
