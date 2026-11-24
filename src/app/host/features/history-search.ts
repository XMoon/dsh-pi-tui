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
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { assertSessionHeadersCompatible } from '@deepseek-ai/dsh-session-query'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  HostAdmissionFold,
  type HostAdmissionEventLike,
  type HostAdmissionOccurrence,
} from '../../../domain/history/host-admission.ts'
import { diagFromEnv, type Diag } from '../../../runtime/process/diagnostics.ts'
import { runDetached, observeSettled } from '../../../runtime/process/tasks.ts'
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

/**
 * The exact immutable official Header facts `assertSessionHeadersCompatible`
 * reads. It is a structural view, NOT a local comparison: the official exported
 * check below is the only implementation of the compatibility rule.
 */
export interface HistorySearchSessionHeaderLike {
  readonly id: unknown
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: unknown
  readonly isSeeded: boolean
  readonly delegationDepth?: number
}

/**
 * The official package-root Header compatibility check over the structural
 * view consumed here (the same exported function `SessionCorpus` uses).
 */
const assertOfficialSessionHeadersCompatible = assertSessionHeadersCompatible as unknown as (
  live: HistorySearchSessionHeaderLike,
  persisted: HistorySearchSessionHeaderLike,
) => void

/** A structural official persistence snapshot. */
export interface HistorySearchPersistenceSnapshotLike {
  readonly header: HistorySearchSessionHeaderLike
  readonly eventCount?: number
  /** Opaque change token comparable only within one persistence instance. */
  readonly revision?: unknown
}

/** A structural official read handle. */
export interface HistorySearchReadHandleLike {
  readonly header: HistorySearchSessionHeaderLike
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
  readonly header: HistorySearchSessionHeaderLike
  readonly inheritedEventCount: number
  readonly events: readonly HistorySearchEventLike[]
  [Symbol.dispose](): void
}

/** The narrow official live `sessions` registry face this service consumes. */
export interface HistorySearchLiveSessionLike {
  readonly id: unknown
  readonly header: HistorySearchSessionHeaderLike
}

/**
 * The official live Session registry. `get` returns the EXACT live entry so a
 * candidate can prove its captured Session object is still current; `list` is
 * the authoritative live half of the logical corpus (never a Client roster).
 */
export interface HistorySearchSessionsLike {
  list(): readonly HistorySearchLiveSessionLike[]
  get(id: string): HistorySearchLiveSessionLike | undefined
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
  /** The existing Host `sessions` registry; the live half of the official corpus. */
  sessions(): HistorySearchSessionsLike | undefined
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

/** One official Session identity resolved from one persistence listing + live registry. */
interface OfficialSession {
  readonly header: HistorySearchSessionHeaderLike
  readonly live: boolean
  /** The exact live entry observed with this enumeration (undefined when persisted-only). */
  readonly liveObject?: HistorySearchLiveSessionLike
  readonly eventCount?: number
  readonly revision?: unknown
}

/**
 * One in-flight official read candidate's source/identity/checkpoint witness.
 *
 * It exists ONLY while that candidate is reading; it is never a second durable
 * business fact and never outlives the candidate.
 */
interface HistoryCandidateWitness {
  readonly sessionId: string
  readonly persistence: HistorySearchPersistenceLike
  readonly persistenceIdentity: unknown
  readonly sessions: HistorySearchSessionsLike
  readonly sessionsIdentity: unknown
  /** The exact live entry captured before the read (undefined when not live). */
  readonly liveObject: HistorySearchLiveSessionLike | undefined
  /** The checkpoint this candidate expects right now (undefined = no row). */
  expected: HistorySessionCheckpointRow | undefined
  invalidated: boolean
}

/** The serial writer's settled receipt: it never rejects. */
type WriteReceipt = 'committed' | 'failed'

/** One fenced short commit against an in-flight candidate's witness. */
type CandidateCommit = 'committed' | 'stale' | 'failed'

/** One official replay attempt's settled outcome. */
type ReplayOutcome = 'complete' | 'stale' | 'failed'

/** One registered per-Session official repair and the fact it owns. */
interface HistorySessionRepairFlight {
  readonly promise: Promise<void>
  readonly kind: 'rebuild' | 'disposal'
}

/** O(1) serial-writer aggregate counters; diagnostics only, never business state. */
interface HistoryWriterCounters {
  committed: number
  failed: number
  busyMsTotal: number
  busyMsMax: number
  awaitWritesMsTotal: number
  awaitWritesMsMax: number
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

/**
 * `ctx.reflect.get` returns a fresh traceable proxy per call; the Cordis
 * `symbols.original` value is the process-local service identity.
 */
function serviceIdentity(value: object): object {
  return (value as { readonly [symbols.original]?: object })[symbols.original] ?? value
}

/**
 * Exact checkpoint equality for an in-flight candidate fence: every identity and
 * progress field is compared, never just `nextSeq`.
 */
function sameCheckpoint(
  current: HistorySessionCheckpointRow | undefined,
  expected: HistorySessionCheckpointRow | undefined,
): boolean {
  if (current === undefined || expected === undefined) return current === expected
  return current.sessionId === expected.sessionId
    && current.headerHash === expected.headerHash
    && current.inheritedCut === expected.inheritedCut
    && current.nextSeq === expected.nextSeq
    && current.lastEventHash === expected.lastEventHash
    && current.headerCwd === expected.headerCwd
    && current.effectiveCwd === expected.effectiveCwd
    && current.dirty === expected.dirty
    && current.sourceState === expected.sourceState
    && current.uncertainSources === expected.uncertainSources
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
  /** The ONE active full-corpus pass (never more than one). */
  private fullMaintenanceFlight: Promise<void> | undefined
  private maintenanceRunning = false
  /** At most ONE in-flight official repair per exact Session id. */
  private readonly sessionRepairFlights = new Map<string, HistorySessionRepairFlight>()
  /** A disposal proof requested while another same-id repair is in flight. */
  private readonly disposalRequests = new Set<string>()
  /** A rebuild requested while another same-id repair is in flight (coalesced). */
  private readonly rebuildRequests = new Set<string>()
  /**
   * Accepted live batches retained because the official source cannot prove
   * them yet (dirty/absent checkpoint, gap, or a short durable prefix). They are
   * the only copy of those accepted events and must never be discarded on a
   * short source; the index stays incomplete until the official source covers
   * them. Held ids are excluded from the automatic drain loop to avoid a spin.
   */
  private readonly heldPending = new Set<string>()
  /**
   * Highest accepted seq evicted from the live buffer by the HARD memory bound.
   * Evicting is unavoidable once the bound is crossed, but it is never silent:
   * the exact seq is recorded and the index stays incomplete/resource-limit
   * until a committed replay covers it. Content recovery comes from the official
   * durable source.
   */
  private readonly droppedAccepted = new Map<string, number>()
  /** Active read candidates by exact Session id (source/identity/checkpoint witness). */
  private readonly activeCandidates = new Map<string, Set<HistoryCandidateWitness>>()
  /**
   * Sessions whose committed index content is not yet proven complete. It is
   * the phase barrier that keeps an interrupted/multi-batch repair from being
   * promoted to `ready`; entries are removed only by a proven completion.
   */
  private readonly reconcilePending = new Set<string>()
  /** The first cold pass has not settled yet: queries stay a truthful `loading`. */
  /** `booting` only while the first cold pass is still running; `unproven` is truthful incomplete. */
  private coverage: 'booting' | 'unproven' | 'proven' = 'booting'
  /**
   * ONE round-local completeness/ownership record. `expected` is present only
   * while first/full coverage is unproven; a proven periodic round uses it only
   * as the destructive barrier. `settled` is the round's per-ID proof; the
   * round finishes only when every expected ID and deletion settled and no
   * accepted-payload/repair obligation remains.
   */
  private coverageRound: {
    readonly expected: Set<string> | undefined
    readonly settled: Set<string>
    deletionsSettled: boolean
    invalidating: boolean
    /** The full official-ID traversal of THIS round has finished. */
    traversed: boolean
  } | undefined
  /** A pass or repair failed to read the official source; a later full pass clears it. */
  private sourceFaulted = false
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
  /** O(1) serial-writer aggregates (diagnostics, never business state). */
  private readonly writerCounters: HistoryWriterCounters = {
    committed: 0,
    failed: 0,
    busyMsTotal: 0,
    busyMsMax: 0,
    awaitWritesMsTotal: 0,
    awaitWritesMsMax: 0,
  }
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
    // bounded pending fact and invalidates same-Session candidates in the SAME
    // synchronous stack, never performs a full read in the event callback.
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

  /** Abort owned work, withdraw listeners, join every owned flight, close the DB. */
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
      // Cancel first, then join every promise this service registered, and
      // only then drain the serial writer and close the ONE database handle.
      await this.warmupSettled
      await this.joinMaintenance()
      await this.writeTail
      this.pending.clear()
      this.pendingEventCount = 0
      this.pendingBytes = 0
      this.liveSessions.clear()
      this.activeCandidates.clear()
      this.reconcilePending.clear()
      this.sessionRepairFlights.clear()
      this.disposalRequests.clear()
      this.rebuildRequests.clear()
      this.heldPending.clear()
      this.droppedAccepted.clear()
      const index = this.index
      this.index = undefined
      index?.close()
      this.diag.dispose()
    })()
    return this.disposal
  }

  /** Settle every already-registered full/repair flight (never starts new work). */
  private async joinMaintenance(): Promise<void> {
    for (;;) {
      const flights: Promise<void>[] = []
      if (this.fullMaintenanceFlight !== undefined) flights.push(this.fullMaintenanceFlight)
      for (const flight of this.sessionRepairFlights.values()) flights.push(flight.promise)
      if (flights.length === 0) return
      await Promise.allSettled(flights)
    }
  }

  /** Cursor generation: exactly the index's committed content revision. */
  private get revision(): number {
    return this.index?.revision ?? 0
  }

  // ── candidate witness (source/identity/checkpoint fence) ────────────────

  private createWitness(
    sessionId: string,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    expected: HistorySessionCheckpointRow | undefined,
    enforcedLiveObject?: HistorySearchLiveSessionLike,
    enforceLiveObject = false,
  ): HistoryCandidateWitness {
    const witness: HistoryCandidateWitness = {
      sessionId,
      persistence,
      persistenceIdentity: serviceIdentity(persistence),
      sessions,
      sessionsIdentity: serviceIdentity(sessions),
      liveObject: enforceLiveObject ? enforcedLiveObject : sessions.get(sessionId),
      expected,
      invalidated: false,
    }
    const active = this.activeCandidates.get(sessionId)
    if (active === undefined) this.activeCandidates.set(sessionId, new Set([witness]))
    else active.add(witness)
    return witness
  }

  private releaseWitness(witness: HistoryCandidateWitness): void {
    const active = this.activeCandidates.get(witness.sessionId)
    if (active === undefined) return
    active.delete(witness)
    if (active.size === 0) this.activeCandidates.delete(witness.sessionId)
  }

  /** In the SAME synchronous listener stack: invalidate every same-id candidate. */
  private invalidateCandidates(sessionId: string): void {
    const active = this.activeCandidates.get(sessionId)
    if (active === undefined) return
    for (const witness of active) witness.invalidated = true
  }

  /**
   * Re-read the live source facts a candidate captured; a commit may only
   * happen while the SAME service instances, live object, no buffered accepted
   * event and the exact expected checkpoint still hold.
   */
  private isCandidateCurrent(witness: HistoryCandidateWitness): boolean {
    if (witness.invalidated || this.disposed || this.lifecycle.signal.aborted) return false
    const persistence = this.deps.sessionPersistence()
    if (persistence === undefined || serviceIdentity(persistence) !== witness.persistenceIdentity) return false
    const sessions = this.deps.sessions()
    if (sessions === undefined || serviceIdentity(sessions) !== witness.sessionsIdentity) return false
    if (this.pending.has(witness.sessionId) && !this.heldPending.has(witness.sessionId)) return false
    if (witness.sessions.get(witness.sessionId) !== witness.liveObject) return false
    return sameCheckpoint(this.index?.checkpointOf(witness.sessionId), witness.expected)
  }

  /** Run one SHORT index mutation behind the candidate fence. */
  private async commitWitness(witness: HistoryCandidateWitness, action: () => void): Promise<CandidateCommit> {
    let stale = false
    const receipt = await this.enqueueWrite(() => {
      if (!this.isCandidateCurrent(witness)) {
        stale = true
        return
      }
      action()
    })
    if (receipt === 'failed') return 'failed'
    return stale ? 'stale' : 'committed'
  }

  /**
   * Mark one Session for a later official reconcile without touching its rows.
   * A failed classification already keeps the index incomplete; this marker is
   * best-effort bookkeeping of the same fact.
   */
  private async markSessionDirty(sessionId: string): Promise<void> {
    await this.enqueueWrite(() => {
      if (this.index === undefined) return
      if (this.index.checkpointOf(sessionId) === undefined) return
      this.index.markSession({ sessionId, dirty: true })
    })
  }

  // ── live observation ─────────────────────────────────────────────────────

  private rememberLiveSession(session: unknown): void {
    if (this.disposed) return
    const record = session as { readonly id?: unknown; readonly header?: { readonly cwd?: string }; readonly inheritedEventCount?: number }
    if (record.id === undefined) return
    const sessionId = String(record.id)
    // A creation/replacement makes any same-id official read candidate stale in
    // this same synchronous stack, before the new fact is remembered.
    this.invalidateCandidates(sessionId)
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
    // FIRST invalidate every same-id candidate: an event accepted before this
    // listener returned must never be overwritten by a pre-event read.
    this.invalidateCandidates(sessionId)
    const parsed = eventOf(event)
    if (parsed === undefined) {
      // A committed live event that violates the structural contract cannot be
      // folded and must not be skipped: report the source as uncertain and
      // rebuild this Session from the official source.
      this.diag.warn('history search observed a malformed live event', { category: 'source-uncertain' })
      this.markReconcileNeeded('source-uncertain')
      this.scheduleSessionRepair(sessionId, 'rebuild')
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
        this.diag.warn('history search observed a conflicting live sequence', { category: 'reconciling' })
        this.markReconcileNeeded('reconciling')
        this.scheduleSessionRepair(sessionId, 'rebuild')
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
    // A new accepted event may fill the gap a held batch is waiting for; let
    // the bounded drain retry it. If the gap persists it is re-held.
    this.heldPending.delete(sessionId)
    this.enqueueDrain()
  }

  /** Drop one buffered Session batch and keep the byte/event counters exact. */
  private discardPendingSession(sessionId: string): void {
    this.heldPending.delete(sessionId)
    const pending = this.pending.get(sessionId)
    if (pending === undefined) return
    this.pending.delete(sessionId)
    this.pendingEventCount -= pending.events.length
    this.pendingBytes -= pending.bytes
  }

  private observeDisposedSession(session: unknown): void {
    if (this.disposed) return
    const record = session as { readonly id?: unknown }
    if (record.id === undefined) return
    const sessionId = String(record.id)
    this.invalidateCandidates(sessionId)
    this.liveSessions.delete(sessionId)
    // A Session without a derived checkpoint has nothing to prove: skip the
    // official read instead of observing a Session this index never held.
    if (this.index?.checkpointOf(sessionId) === undefined) return
    // A disposed Session keeps its accepted rows: only the official durable
    // source can prove them, so re-verify before changing the checkpoint.
    this.scheduleSessionRepair(sessionId, 'disposal')
  }

  /**
   * Record the highest accepted seq of a discarded overflow batch. This is the
   * ONE unresolved-coverage obligation shared by ordinary and held eviction:
   * the payload may be gone, but the index cannot claim ready until a committed
   * official replay has passed this seq. A newer discard only raises it.
   */
  private recordDroppedCoverage(sessionId: string, batch: PendingSession): void {
    if (batch.events.length === 0) return
    const lastSeq = batch.events.reduce((max, event) => Math.max(max, event.seq), -1)
    if (lastSeq < 0) return
    this.droppedAccepted.set(sessionId, Math.max(this.droppedAccepted.get(sessionId) ?? -1, lastSeq))
  }

  private handleOverflow(): void {
    this.bufferOverflows += 1
    const ordinary = [...this.pending.keys()].filter(sessionId => !this.heldPending.has(sessionId))
    // Ordinary overflow is NOT a durability guarantee: record the same
    // unresolved coverage obligation before freeing the payload.
    for (const sessionId of ordinary) {
      const batch = this.pending.get(sessionId)
      if (batch !== undefined) this.recordDroppedCoverage(sessionId, batch)
      this.discardPendingSession(sessionId)
    }
    // Held batches are the only in-memory copy of accepted events the official
    // source may still be too short to prove, so keep them while the retained
    // set is within the HARD bound (an unrelated burst must not evict them).
    // A held Session that is itself over the bound must still be evicted: the
    // bound is finite; the shared coverage obligation keeps the barrier.
    const evicted: string[] = []
    if (this.pendingEventCount > HISTORY_SEARCH_MAX_PENDING_EVENTS || this.pendingBytes > HISTORY_SEARCH_MAX_PENDING_BYTES) {
      for (const [sessionId, batch] of [...this.pending.entries()]) {
        if (!this.heldPending.has(sessionId)) continue
        this.recordDroppedCoverage(sessionId, batch)
        evicted.push(sessionId)
        this.discardPendingSession(sessionId)
        if (this.pendingEventCount <= HISTORY_SEARCH_MAX_PENDING_EVENTS && this.pendingBytes <= HISTORY_SEARCH_MAX_PENDING_BYTES) break
      }
    }
    this.markReconcileNeeded('resource-limit')
    this.diag.warn('history search live buffer reached its bound', {
      sessions: ordinary.length,
      heldEvicted: evicted.length,
    })
    // Merge the affected ids into the per-id repair map: no writer callback
    // awaits an official read, and different ids make progress independently.
    for (const sessionId of ordinary) this.scheduleSessionRepair(sessionId, 'rebuild')
    for (const sessionId of evicted) this.scheduleSessionRepair(sessionId, 'rebuild')
  }

  // ── maintenance ownership (full pass + per-Session repairs) ─────────────

  /**
   * Register at most ONE official repair per exact Session id. The repair runs
   * OUTSIDE the serial writer and its own short commits are witness-fenced. A
   * disposal proof requested behind an active rebuild is chained afterwards.
   */
  private scheduleSessionRepair(sessionId: string, kind: 'rebuild' | 'disposal'): void {
    if (this.disposed || this.lifecycle.signal.aborted) return
    this.reconcilePending.add(sessionId)
    this.markReconcileNeeded('reconciling')
    // Coalesce intent even while a same-id flight is active: a newer event can
    // invalidate the in-flight observation, so the follow-up must not be lost.
    if (kind === 'disposal') this.disposalRequests.add(sessionId)
    else this.rebuildRequests.add(sessionId)
    if (this.sessionRepairFlights.has(sessionId)) return
    const effectiveKind: 'rebuild' | 'disposal' = this.disposalRequests.delete(sessionId)
      ? 'disposal'
      : this.rebuildRequests.delete(sessionId) ? 'rebuild' : kind
    const flight = this.runSessionRepair(sessionId, effectiveKind)
    this.sessionRepairFlights.set(sessionId, { promise: flight, kind: effectiveKind })
    runDetached('history search Session repair', () => flight, { diag: this.diag })
    observeSettled(flight, () => {
      const registered = this.sessionRepairFlights.get(sessionId)
      if (registered?.promise === flight) this.sessionRepairFlights.delete(sessionId)
      if (this.disposed || this.lifecycle.signal.aborted) return
      // Disposal is the stronger obligation; the coalesced rebuild (if any)
      // follows it on the next settlement.
      if (this.disposalRequests.delete(sessionId)) {
        this.scheduleSessionRepair(sessionId, 'disposal')
        return
      }
      if (this.rebuildRequests.delete(sessionId)) {
        this.scheduleSessionRepair(sessionId, 'rebuild')
        return
      }
      this.finishCoverageRound()
      if (this.pending.size > 0) this.enqueueDrain()
      this.refreshCompleteness()
    })
  }

  /**
   * ONE per-ID destructive owner: the full pass claims the ID in the existing
   * repair-flight map, so a point repair requested during the full candidate is
   * coalesced and starts only after the release. The terminal witness remains
   * the second, non-substitutable fence.
   */
  private async withFullSessionOwnership<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    for (;;) {
      const active = this.sessionRepairFlights.get(sessionId)
      if (active === undefined) break
      await active.promise.then(() => undefined, () => undefined)
    }
    const claim = Promise.resolve()
    this.sessionRepairFlights.set(sessionId, { promise: claim, kind: 'rebuild' })
    try {
      return await work()
    } finally {
      const registered = this.sessionRepairFlights.get(sessionId)
      if (registered?.promise === claim) this.sessionRepairFlights.delete(sessionId)
      if (this.disposalRequests.delete(sessionId)) this.scheduleSessionRepair(sessionId, 'disposal')
      else if (this.rebuildRequests.delete(sessionId)) this.scheduleSessionRepair(sessionId, 'rebuild')
    }
  }

  /**
   * Rebuild one now-persisted-only Session from the complete official durable
   * snapshot under the same-instance revision fence. Used by rebuild repairs and
   * by disposal repairs whose checkpoint is dirty/uncertain.
   */
  private async rebuildFromPersistence(
    sessionId: string,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    query: HistorySearchQueryLike,
  ): Promise<ReplayOutcome> {
    const signal = this.lifecycle.signal
    const snapshot = await persistence.stat(sessionId, { signal })
    signal.throwIfAborted()
    if (snapshot === undefined) return 'stale'
    // A source shorter than (or unprovable about) the committed checkpoint is
    // append lag, not a rollback: never reset accepted rows from it. Keep the
    // rows/pending and stay incomplete until the official source advances.
    const checkpoint = this.index?.checkpointOf(sessionId)
    if (checkpoint !== undefined) {
      if (snapshot.eventCount !== undefined) {
        if (snapshot.eventCount < checkpoint.nextSeq) return 'stale'
      } else {
        // rc.5 JSONL `stat()`/`list()` omit eventCount. Prove the checkpoint's
        // own durable tail through an authoritative official read: a short or
        // unreadable source keeps the rows/incomplete, while a proven prefix
        // makes the full replay safe (that replay re-reads the complete source
        // and same-instance revision-proves the result).
        const proof = await this.proveDurablePrefix(sessionId, checkpoint, persistence)
        if (proof !== 'proven') return 'stale'
      }
    }
    const record: OfficialSession = {
      header: structuredClone(snapshot.header),
      live: false,
      ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
      ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
    }
    return this.replayOfficialSession(
      sessionId,
      record,
      persistence,
      sessions,
      query,
      this.emptyPhaseCounters(),
      { rebuild: true },
    )
  }

  private async runSessionRepair(sessionId: string, kind: 'rebuild' | 'disposal'): Promise<void> {
    try {
      if (this.disposed || this.index === undefined) return
      const persistence = this.deps.sessionPersistence()
      const sessions = this.deps.sessions()
      const query = this.deps.sessionQuery()
      if (persistence === undefined || sessions === undefined || query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      if (kind === 'disposal') {
        if (this.index.checkpointOf(sessionId) === undefined) return
        await this.verifySessionAgainstPersistence(sessionId)
        this.recordCompletedDisposal()
        return
      }
      const live = sessions.get(sessionId)
      if (live !== undefined) {
        await this.rebuildLiveSession(sessionId, persistence, sessions, query)
        return
      }
      // A rebuild obligation is NOT a disposal prefix proof: read and replay
      // the complete official durable source, including accepted events beyond
      // the old checkpoint. A prefix proof would clear `dirty` while omitting
      // exactly those events.
      await this.rebuildFromPersistence(sessionId, persistence, sessions, query)
    } catch (error) {
      if (this.lifecycle.signal.aborted || this.disposed) return
      this.sourceFaulted = true
      this.markReconcileNeeded('source-read-failed')
      await this.markSessionDirty(sessionId)
      throw error
    }
  }

  // ── serial write queue ───────────────────────────────────────────────────

  /**
   * Append one SHORT task to the ONE serial index writer. The returned receipt
   * never rejects: a failure is classified, marks the index incomplete and
   * settles as `failed` so a maintenance chain stops instead of claiming it
   * completed; a later query never inherits a poisoned queue.
   */
  private enqueueWrite(task: () => void | Promise<void>): Promise<WriteReceipt> {
    const run = this.writeTail.then(
      () => this.runMeasuredWrite(task),
      () => this.runMeasuredWrite(task),
    )
    const settled = run.then(
      () => {
        this.writerCounters.committed += 1
        return 'committed' as const
      },
      error => {
        if (this.lifecycle.signal.aborted || this.disposed) return 'failed' as const
        this.writerCounters.failed += 1
        this.diag.warn('history search index write failed', { category: error instanceof Error ? error.name : 'unknown' })
        // Keep the index CLOSED until a later successful write proves it safe
        // again: a refresh that only re-reads must not promote an unsafe derived
        // store (for example a tampered sidecar) back to `ready`.
        this.indexFaulted = true
        this.markReconcileNeeded('source-read-failed')
        return 'failed' as const
      },
    )
    this.writeTail = settled.then(() => undefined)
    return settled
  }

  /** Measure ONLY the writer task (never the queue wait) for O(1) diagnostics. */
  private async runMeasuredWrite(task: () => void | Promise<void>): Promise<void> {
    const startedAt = performance.now()
    try {
      await task()
    } finally {
      const elapsed = performance.now() - startedAt
      this.writerCounters.busyMsTotal += elapsed
      this.writerCounters.busyMsMax = Math.max(this.writerCounters.busyMsMax, elapsed)
    }
  }

  private enqueueDrain(): void {
    // A synchronous official burst may publish thousands of events. ONE queued
    // step commits at most ONE Session's next <=256-event chunk; a remaining
    // backlog schedules the next step after this writer turn. The queue stays
    // O(1) and no single writer task grows with the burst size.
    if (this.drainScheduled) return
    this.drainScheduled = true
    this.drainSchedules += 1
    this.enqueueWrite(() => {
      this.drainPendingStep()
    })
  }

  /** Await the writer tail captured at query admission (short commits only). */
  private async awaitWrites(signal: AbortSignal): Promise<void> {
    const startedAt = performance.now()
    const tail = this.writeTail
    try {
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
    } finally {
      const elapsed = performance.now() - startedAt
      this.writerCounters.awaitWritesMsTotal += elapsed
      this.writerCounters.awaitWritesMsMax = Math.max(this.writerCounters.awaitWritesMsMax, elapsed)
    }
  }

  /** One bounded live-commit step: ONE Session, at most ONE read-batch chunk. */
  private drainOnePendingSession(): void {
    if (this.disposed || this.pending.size === 0) return
    if (this.state.kind === 'loading') return
    if (this.index === undefined) return
    // Prefer an ordinary batch; a held batch is retried only by an explicit
    // event/pass, never by the automatic drain loop (which would spin on a gap).
    let selected: [string, PendingSession] | undefined
    for (const entry of this.pending.entries()) {
      if (!this.heldPending.has(entry[0])) {
        selected = entry
        break
      }
    }
    if (selected === undefined) return
    const [sessionId, batch] = selected
    this.pending.delete(sessionId)
    this.pendingEventCount -= batch.events.length
    this.pendingBytes -= batch.bytes
    const checkpoint = this.index.checkpointOf(sessionId)
    if (checkpoint === undefined || checkpoint.dirty) {
      this.restoreHeldBatch(sessionId, batch)
      this.reconcilePending.add(sessionId)
      this.scheduleSessionRepair(sessionId, 'rebuild')
      return
    }
    try {
      const remaining = this.commitLiveBatch(sessionId, checkpoint, batch)
      if (remaining.length > 0) this.restorePendingSession(sessionId, batch, remaining)
    } catch (error) {
      // A gap/burst prefix is not a rollback: the accepted batch is the only
      // copy until the official source advances, so retain it as held.
      this.index.markSession({ sessionId, dirty: true })
      if (error instanceof HistorySearchGapError) {
        this.restoreHeldBatch(sessionId, batch)
        this.reconcilePending.add(sessionId)
        this.scheduleSessionRepair(sessionId, 'rebuild')
        return
      }
      if (error instanceof HistorySearchConflictError) {
        // A replaced/repaired source is authoritative; the repair re-reads it.
        this.reconcilePending.add(sessionId)
        this.scheduleSessionRepair(sessionId, 'rebuild')
        return
      }
      // A DB failure must not silently drop accepted events either.
      this.restoreHeldBatch(sessionId, batch)
      throw error
    }
    // A completed ordinary drain is a terminal owner of the round's accepted
    // work too; a finished traversal must not wait for the periodic timer.
    this.finishCoverageRound()
  }

  private drainPendingStep(): void {
    this.drainScheduled = false
    if (this.disposed) return
    if (this.state.kind === 'loading') return
    this.drainOnePendingSession()
    if (this.hasUnheldPending()) this.enqueueDrain()
    this.refreshCompleteness()
  }

  private hasUnheldPending(): boolean {
    for (const sessionId of this.pending.keys()) {
      if (!this.heldPending.has(sessionId)) return true
    }
    return false
  }

  /** Put a batch back and mark it held (its accepted events stay preserved). */
  private restoreHeldBatch(sessionId: string, batch: PendingSession): void {
    this.pending.set(sessionId, batch)
    this.pendingEventCount += batch.events.length
    this.pendingBytes += batch.bytes
    this.heldPending.add(sessionId)
  }

  /**
   * Drop a held batch only once the committed checkpoint proves it (its last
   * seq is strictly inside the checkpoint). A short source keeps both the batch
   * and the incomplete barrier; a later event/pass retries.
   */
  private settleHeldBatch(sessionId: string): void {
    if (!this.heldPending.has(sessionId)) return
    const batch = this.pending.get(sessionId)
    if (batch === undefined) {
      this.heldPending.delete(sessionId)
      return
    }
    const lastSeq = batch.events.reduce((max, event) => Math.max(max, event.seq), -1)
    const checkpoint = this.index?.checkpointOf(sessionId)
    if (checkpoint === undefined || checkpoint.nextSeq <= lastSeq) return
    this.pending.delete(sessionId)
    this.pendingEventCount -= batch.events.length
    this.pendingBytes -= batch.bytes
    this.heldPending.delete(sessionId)
  }

  /**
   * Cover an evicted accepted tail ONLY after a complete replay has passed its
   * final same-instance currentness proof. The checkpoint coverage check remains
   * necessary (a short source can complete without reaching the watermark), but
   * it is never sufficient by itself.
   */
  private settleDroppedCoverage(sessionId: string): void {
    const lastSeq = this.droppedAccepted.get(sessionId)
    if (lastSeq === undefined) return
    const checkpoint = this.index?.checkpointOf(sessionId)
    if (checkpoint === undefined || checkpoint.nextSeq <= lastSeq) return
    this.droppedAccepted.delete(sessionId)
  }

  /** Re-add the ordered remainder without losing the exact byte/event counters. */
  private restorePendingSession(
    sessionId: string,
    batch: PendingSession,
    events: readonly HostAdmissionEventLike[],
  ): void {
    if (events.length === 0) return
    const bytes = events.reduce((sum, event) => sum + approximateEventBytes(event), 0)
    this.pending.set(sessionId, { ...batch, events: [...events], bytes })
    this.pendingEventCount += events.length
    this.pendingBytes += bytes
  }

  /** Commit at most one bounded chunk; return the contiguous events left over. */
  private commitLiveBatch(
    sessionId: string,
    checkpoint: HistorySessionCheckpointRow,
    batch: PendingSession,
  ): HostAdmissionEventLike[] {
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
    if (events.length === 0) return []
    // The SAME fixed read-batch bound as every official replay: a live burst
    // must never become one unbounded synchronous SQL/fold transaction.
    const head = events.slice(0, HISTORY_SEARCH_READ_BATCH)
    this.writeBatch({
      sessionId,
      headerHash: checkpoint.headerHash,
      inheritedEventCount: checkpoint.inheritedCut,
      headerCwd: checkpoint.headerCwd,
      baseNextSeq: checkpoint.nextSeq,
      effectiveCwd: checkpoint.effectiveCwd,
      sourceState: checkpoint.sourceState,
      events: head,
    })
    return events.slice(HISTORY_SEARCH_READ_BATCH)
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
  }, witness?: HistoryCandidateWitness): { readonly effectiveCwd: string | null; readonly lastEventHash: string | null } {
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
    const uncertainSourcesDelta = delta.unknownSourceCount + delta.invalidCwdCount
    const previousUncertainSources = witness?.expected?.uncertainSources ?? 0
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
      uncertainSourcesDelta,
      occurrences,
    })
    if (witness !== undefined) {
      // The maintenance chain's next async read must compare against the
      // checkpoint THIS commit produced, including its exact uncertain count.
      witness.expected = {
        sessionId: input.sessionId,
        headerCwd: normalizeHistoryCwd(input.headerCwd),
        inheritedCut: input.inheritedEventCount,
        nextSeq,
        effectiveCwd,
        lastEventHash,
        headerHash: input.headerHash,
        sourceState: input.sourceState,
        uncertainSources: previousUncertainSources + uncertainSourcesDelta,
        dirty: false,
      }
    }
    // A successful commit proves the private file set is usable again.
    this.indexFaulted = false
    return { effectiveCwd, lastEventHash }
  }

  // ── bootstrap / cold replay ──────────────────────────────────────────────

  private emptyPhaseCounters(): HistorySearchPhaseCounters {
    return {
      sessionsVisited: 0,
      replayAttempted: 0,
      replayCompleted: 0,
      replayElapsedMsTotal: 0,
      replayElapsedMsMax: 0,
    }
  }

  private async bootstrap(): Promise<void> {
    const startedAt = performance.now()
    const counters = this.emptyPhaseCounters()
    const writerBefore = { ...this.writerCounters }
    let outcome: HistorySearchPhaseOutcome = 'incomplete'
    let coverageComplete = false
    try {
      const profile = this.deps.profileContext()
      const persistence = this.deps.sessionPersistence()
      const sessions = this.deps.sessions()
      const query = this.deps.sessionQuery()
      if (profile === undefined || persistence === undefined || sessions === undefined || query === undefined) {
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
      coverageComplete = await this.coldStart(persistence, sessions, query, counters)
      if (coverageComplete) this.sourceFaulted = false
    } catch (error) {
      if (!this.lifecycle.signal.aborted && !this.disposed) {
        this.sourceFaulted = true
        this.markReconcileNeeded('source-read-failed')
        this.diag.warn('history search bootstrap failed', { category: error instanceof Error ? error.name : 'unknown' })
      }
    } finally {
      // A failed/partial first pass never establishes initial coverage. A later
      // completed full pass (or the round's point repairs) may.
      if (this.coverage === 'booting') this.coverage = coverageComplete ? 'proven' : 'unproven'
      if (this.lifecycle.signal.aborted || this.disposed) {
        outcome = 'cancelled'
      } else {
        if (this.pending.size > 0) this.enqueueDrain()
        this.refreshCompleteness()
        outcome = this.settledPhaseOutcome()
      }
      this.logPhaseEnd('history-search.bootstrap.end', outcome, startedAt, counters)
      this.logWriterAggregate('cold_start', writerBefore)
      this.scheduleVerification()
    }
  }

  private async coldStart(
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    query: HistorySearchQueryLike,
    counters: HistorySearchPhaseCounters,
  ): Promise<boolean> {
    const signal = this.lifecycle.signal
    // Capture the deletion cut BEFORE the persisted roster is sampled. A
    // Session created later in this round is not a deletion candidate even if
    // the old roster and the live registry both omit it.
    const deletionCut = this.deletionCut()
    const official = await this.enumerateOfficialSessions(persistence, sessions, signal, 'cold_start')
    this.beginCoverageRound(official)
    this.markRoundInvalidating()
    const deletion = await this.reconcileRemovedSessions(official, persistence, sessions, deletionCut)
    if (deletion === 'failed') return false
    if (this.coverageRound !== undefined) this.coverageRound.deletionsSettled = deletion === 'complete'
    for (const [sessionId, record] of official) {
      counters.sessionsVisited += 1
      signal.throwIfAborted()
      // A checkpoint read from disk belongs to a PREVIOUS process. Its revision
      // is not comparable here and a tail hash alone cannot prove the prefix,
      // so cold start always rebuilds from the official source.
      const outcome = await this.withFullSessionOwnership(sessionId, () =>
        this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true }))
      // A failed source/write aborts coverage. A stale/pending handoff is an
      // ordinary accepted-work obligation owned by the point repair; keep
      // traversing the remaining authoritative IDs.
      if (outcome === 'failed') return false
      if (outcome === 'complete') this.settleRoundSession(sessionId)
      // The pending live batch is a SHORT commit: it must use the ONE serial
      // writer and settle before the cold pass continues.
      const drained = await this.enqueueWrite(() => {
        this.drainPendingSession(sessionId)
      })
      if (drained !== 'committed') return false
      await yieldEventLoop()
    }
    if (this.coverageRound !== undefined) this.coverageRound.traversed = true
    // Sessions born during the warmup window were buffered by the listener
    // before they could appear in the persisted enumeration.
    for (const sessionId of [...this.pending.keys()]) {
      if (this.index?.checkpointOf(sessionId) !== undefined) {
        const drained = await this.enqueueWrite(() => {
          this.drainPendingSession(sessionId)
        })
        if (drained !== 'committed') return false
        continue
      }
      counters.sessionsVisited += 1
      const outcome = await this.withFullSessionOwnership(sessionId, () =>
        this.rebuildLiveSession(sessionId, persistence, sessions, query))
      if (outcome === 'failed') return false
      if (outcome === 'complete') this.settleRoundSession(sessionId)
    }
    this.finishCoverageRound()
    this.refreshCompleteness()
    return this.coverage === 'proven'
  }

  /**
   * ONE official persisted snapshot + the official live `sessions` registry.
   * The persisted listing is read exactly once per pass; live headers win after
   * the official compatibility check (never a second corpus listing).
   */
  private async enumerateOfficialSessions(
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    signal: AbortSignal,
    phase: HistorySearchInventoryPhase,
  ): Promise<Map<string, OfficialSession>> {
    const startedAt = performance.now()
    let outcome: 'ok' | 'error' | 'cancelled' = 'error'
    let directPersistenceListCalls = 0
    const queryListSessionsCalls = 0
    let persistedRows = 0
    let mergedRows = 0
    let liveSessionsObserved = 0
    this.logDiagnostic('history-search.inventory.start', {
      phase,
      directPersistenceListCalls,
      queryListSessionsCalls,
      liveSessionsObserved,
    })
    try {
      directPersistenceListCalls += 1
      const snapshots = await persistence.list({ signal })
      signal.throwIfAborted()
      const union = new Map<string, OfficialSession>()
      for (const snapshot of snapshots) {
        const sessionId = String(snapshot.header.id)
        union.set(sessionId, {
          // Detached read-only view: the official list result is not retained.
          header: structuredClone(snapshot.header),
          live: false,
          ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
          ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
        })
      }
      // The live registry is SYNCHRONOUS: it never triggers a second listing.
      for (const session of sessions.list()) {
        liveSessionsObserved += 1
        const sessionId = String(session.id)
        const existing = union.get(sessionId)
        if (existing !== undefined) {
          // The SAME official check `SessionCorpus.listSessions()` applies.
          assertOfficialSessionHeadersCompatible(session.header, existing.header)
        }
        union.set(sessionId, {
          header: structuredClone(session.header),
          live: true,
          liveObject: session,
          // The persisted snapshot's durable facts survive the live precedence:
          // an unchanged-revision check must never lose its only official token.
          ...(existing?.eventCount === undefined ? {} : { eventCount: existing.eventCount }),
          ...(existing?.revision === undefined ? {} : { revision: existing.revision }),
        })
      }
      signal.throwIfAborted()
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
        ...(outcome === 'ok' ? { liveSessionsObserved } : {}),
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
    sessions: HistorySearchSessionsLike,
    query: HistorySearchQueryLike,
    counters: HistorySearchPhaseCounters,
    options: { readonly rebuild: boolean },
  ): Promise<ReplayOutcome> {
    counters.replayAttempted += 1
    const startedAt = performance.now()
    this.reconcilePending.add(sessionId)
    this.markReconcileNeeded('reconciling')
    const signal = this.lifecycle.signal
    const witness = this.createWitness(
      sessionId,
      persistence,
      sessions,
      this.index?.checkpointOf(sessionId),
      record.liveObject,
      true,
    )
    try {
      // The enumeration's exact live identity must still describe the SAME
      // source; a replacement here is stale, never merged blindly.
      if (sessions.get(sessionId) !== record.liveObject) return 'stale'
      if (options.rebuild && witness.expected !== undefined) {
        const reset = await this.resetWitness(witness)
        if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
      }
      if (witness.expected !== undefined && witness.expected.headerHash !== sessionHeaderHash(record.header)) {
        const reset = await this.resetWitness(witness)
        if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
      }
      let outcome: ReplayOutcome
      if (record.live) {
        const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal })
        try {
          const inherited = Number(observation.inheritedEventCount)
          const events = eventsOf(observation.events, sessionId)
          outcome = await this.replayEventList(sessionId, observation.header, inherited, events, witness, false)
        } finally {
          observation[Symbol.dispose]()
        }
      } else {
        const handle = await persistence.open(sessionId, 'read', { signal })
        try {
          outcome = await this.replayHandle(sessionId, handle, witness, record.eventCount)
        } finally {
          await handle.close()
        }
        // The same-instance revision must still name the SAME source after the
        // read; a missing/changed token keeps this round incomplete.
        if (outcome === 'complete') outcome = await this.proveCurrentSource(sessionId, record, persistence)
      }
      if (outcome === 'complete') {
        // Terminal success is a candidate-fenced short commit: the held batch,
        // evicted coverage, verified revision and repair barrier settle together
        // only while THIS replay's expected checkpoint and live identity still
        // hold. A superseding same-ID candidate makes this stale and must never
        // clear the newer candidate's obligation.
        const terminal = await this.commitWitness(witness, () => {
          this.settleHeldBatch(sessionId)
          this.settleDroppedCoverage(sessionId)
          this.rememberVerifiedRevision(sessionId, record, persistence)
          this.reconcilePending.delete(sessionId)
          this.settleRoundSession(sessionId)
        })
        if (terminal === 'committed') {
          counters.replayCompleted += 1
          return 'complete'
        }
        if (terminal === 'stale') {
          // A newer same-ID candidate/write superseded this terminal. Keep its
          // obligation and re-arm a coalesced repair; never settle by id.
          this.scheduleSessionRepair(sessionId, 'rebuild')
        }
        return terminal
      }
      await this.markSessionDirty(sessionId)
      return outcome
    } finally {
      this.releaseWitness(witness)
      const elapsed = elapsedMilliseconds(startedAt)
      counters.replayElapsedMsTotal += elapsed
      counters.replayElapsedMsMax = Math.max(counters.replayElapsedMsMax, elapsed)
    }
  }

  /** Drop one candidate's derived rows, still behind its own witness fence. */
  private async resetWitness(witness: HistoryCandidateWitness): Promise<CandidateCommit> {
    return this.commitWitness(witness, () => {
      this.requireIndex().resetSession(witness.sessionId)
      witness.expected = undefined
    })
  }

  /** Same-instance revision re-check after a cold read (`stat` on the same instance). */
  private async proveCurrentSource(
    sessionId: string,
    record: OfficialSession,
    persistence: HistorySearchPersistenceLike,
  ): Promise<ReplayOutcome> {
    if (record.revision === undefined) return 'stale'
    const snapshot = await persistence.stat(sessionId, { signal: this.lifecycle.signal })
    this.lifecycle.signal.throwIfAborted()
    if (snapshot === undefined || snapshot.revision === undefined) return 'stale'
    if (snapshot.revision !== record.revision) return 'stale'
    return 'complete'
  }

  /** A read slice must be the exact contiguous official sequence (source breach otherwise). */
  private assertContiguousSlice(sessionId: string, startSeq: number, events: readonly HistorySearchEventLike[]): void {
    let expected = startSeq
    for (const event of events) {
      if (event.seq !== expected) {
        throw new HistorySearchConflictError(
          sessionId,
          `expected seq ${String(expected)} but observed ${String(event.seq)}`,
        )
      }
      expected += 1
    }
  }

  private async replayHandle(
    sessionId: string,
    handle: HistorySearchReadHandleLike,
    witness: HistoryCandidateWitness,
    expectedEventCount: number | undefined,
  ): Promise<ReplayOutcome> {
    const signal = this.lifecycle.signal
    const headerHash = sessionHeaderHash(handle.header)
    const inherited = Number(handle.inheritedEventCount)
    const headerCwd = normalizeHistoryCwd(handle.header.cwd)
    const checkpoint = witness.expected
    let nextSeq = checkpoint?.nextSeq ?? 0
    let effectiveCwd = checkpoint?.effectiveCwd ?? headerCwd
    let lastEventHash = checkpoint?.lastEventHash ?? null
    if (checkpoint !== undefined && checkpoint.inheritedCut !== inherited) {
      const reset = await this.resetWitness(witness)
      if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
      nextSeq = 0
      effectiveCwd = headerCwd
      lastEventHash = null
    }
    if (nextSeq > 0) {
      signal.throwIfAborted()
      const tail = await handle.read(nextSeq - 1, 1, { signal })
      const tailEvent = tail.events[0]
      if (tailEvent === undefined || tailEvent.seq !== nextSeq - 1 || sessionEventHash(tailEvent) !== lastEventHash) {
        const reset = await this.resetWitness(witness)
        if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
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
      this.assertContiguousSlice(sessionId, nextSeq, events)
      const receipt = await this.commitWitness(witness, () => {
        const result = this.writeBatch({
          sessionId,
          headerHash,
          inheritedEventCount: inherited,
          headerCwd,
          baseNextSeq: nextSeq,
          effectiveCwd,
          sourceState: 'persisted',
          events,
        }, witness)
        nextSeq = events[events.length - 1]!.seq + 1
        effectiveCwd = result.effectiveCwd
        lastEventHash = result.lastEventHash
      })
      if (receipt !== 'committed') return receipt === 'failed' ? 'failed' : 'stale'
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
    return 'complete'
  }

  private async replayEventList(
    sessionId: string,
    header: HistorySearchSessionHeaderLike,
    inherited: number,
    events: readonly HistorySearchEventLike[],
    witness: HistoryCandidateWitness,
    rebuild: boolean,
  ): Promise<ReplayOutcome> {
    const signal = this.lifecycle.signal
    const headerHash = sessionHeaderHash(header)
    const headerCwd = normalizeHistoryCwd(header.cwd)
    if (rebuild && witness.expected !== undefined) {
      const reset = await this.resetWitness(witness)
      if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
    }
    const checkpoint = witness.expected
    let nextSeq = checkpoint?.nextSeq ?? 0
    let effectiveCwd = checkpoint?.effectiveCwd ?? headerCwd
    let lastEventHash = checkpoint?.lastEventHash ?? null
    if (checkpoint !== undefined && (checkpoint.inheritedCut !== inherited || checkpoint.headerHash !== headerHash)) {
      const reset = await this.resetWitness(witness)
      if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
      nextSeq = 0
      effectiveCwd = headerCwd
      lastEventHash = null
    }
    if (nextSeq > 0) {
      const tail = events[nextSeq - 1]
      if (tail === undefined || tail.seq !== nextSeq - 1 || sessionEventHash(tail) !== lastEventHash) {
        const reset = await this.resetWitness(witness)
        if (reset !== 'committed') return reset === 'failed' ? 'failed' : 'stale'
        nextSeq = 0
        effectiveCwd = headerCwd
        lastEventHash = null
      }
    }
    for (;;) {
      signal.throwIfAborted()
      const slice = events.slice(nextSeq, nextSeq + HISTORY_SEARCH_READ_BATCH)
      if (slice.length === 0) break
      this.assertContiguousSlice(sessionId, nextSeq, slice)
      const receipt = await this.commitWitness(witness, () => {
        const result = this.writeBatch({
          sessionId,
          headerHash,
          inheritedEventCount: inherited,
          headerCwd,
          baseNextSeq: nextSeq,
          effectiveCwd,
          sourceState: 'live',
          events: slice,
        }, witness)
        nextSeq = slice[slice.length - 1]!.seq + 1
        effectiveCwd = result.effectiveCwd
        lastEventHash = result.lastEventHash
      })
      if (receipt !== 'committed') return receipt === 'failed' ? 'failed' : 'stale'
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
    return 'complete'
  }

  /** Rebuild one Session from a complete official observation (live preferred). */
  private async rebuildLiveSession(
    sessionId: string,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    query: HistorySearchQueryLike,
  ): Promise<ReplayOutcome> {
    const signal = this.lifecycle.signal
    this.reconcilePending.add(sessionId)
    this.markReconcileNeeded('reconciling')
    const witness = this.createWitness(sessionId, persistence, sessions, this.index?.checkpointOf(sessionId))
    try {
      const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal })
      try {
        const inherited = Number(observation.inheritedEventCount)
        const events = eventsOf(observation.events, sessionId)
        const outcome = await this.replayEventList(sessionId, observation.header, inherited, events, witness, true)
        if (outcome !== 'complete') {
          await this.markSessionDirty(sessionId)
          return outcome
        }
        const terminal = await this.commitWitness(witness, () => {
          this.settleHeldBatch(sessionId)
          this.settleDroppedCoverage(sessionId)
          this.reconcilePending.delete(sessionId)
          this.settleRoundSession(sessionId)
        })
        if (terminal === 'stale') this.scheduleSessionRepair(sessionId, 'rebuild')
        return terminal === 'committed' ? 'complete' : terminal
      } finally {
        observation[Symbol.dispose]()
      }
    } finally {
      this.releaseWitness(witness)
    }
  }

  private drainPendingSession(sessionId: string): void {
    const batch = this.pending.get(sessionId)
    if (batch === undefined || this.index === undefined) return
    this.pending.delete(sessionId)
    this.pendingEventCount -= batch.events.length
    this.pendingBytes -= batch.bytes
    const checkpoint = this.index.checkpointOf(sessionId)
    if (checkpoint === undefined || checkpoint.dirty) {
      this.restoreHeldBatch(sessionId, batch)
      this.reconcilePending.add(sessionId)
      this.scheduleSessionRepair(sessionId, 'rebuild')
      return
    }
    try {
      const remaining = this.commitLiveBatch(sessionId, checkpoint, batch)
      if (remaining.length > 0) {
        this.restorePendingSession(sessionId, batch, remaining)
        this.enqueueDrain()
      }
    } catch (error) {
      this.index.markSession({ sessionId, dirty: true })
      if (error instanceof HistorySearchGapError) {
        this.restoreHeldBatch(sessionId, batch)
        this.reconcilePending.add(sessionId)
        this.scheduleSessionRepair(sessionId, 'rebuild')
        return
      }
      if (error instanceof HistorySearchConflictError) {
        this.reconcilePending.add(sessionId)
        this.scheduleSessionRepair(sessionId, 'rebuild')
        return
      }
      this.restoreHeldBatch(sessionId, batch)
      throw error
    }
    this.finishCoverageRound()
  }

  // ── external-source verification ────────────────────────────────────────

  private scheduleVerification(): void {
    if (this.disposed || this.lifecycle.signal.aborted) return
    if (this.verificationTimer !== undefined) return
    this.verificationTimer = setTimeout(() => {
      this.verificationTimer = undefined
      this.startFullMaintenance()
    }, HISTORY_SEARCH_VERIFICATION_INTERVAL_MS)
    this.verificationTimer.unref?.()
  }

  /** Queue ONE full maintenance round; the next timer starts after it settles. */
  private startFullMaintenance(): void {
    if (this.disposed || this.lifecycle.signal.aborted) return
    if (this.maintenanceRunning || this.fullMaintenanceFlight !== undefined) {
      this.scheduleVerification()
      return
    }
    const flight = this.verifySources()
    this.fullMaintenanceFlight = flight
    runDetached('history search periodic verification', () => flight, { diag: this.diag })
    observeSettled(flight, () => {
      if (this.fullMaintenanceFlight === flight) this.fullMaintenanceFlight = undefined
      this.scheduleVerification()
      this.refreshCompleteness()
    })
  }

  private async verifySources(): Promise<void> {
    if (this.maintenanceRunning) {
      if (this.fullMaintenanceFlight !== undefined) await this.fullMaintenanceFlight
      return
    }
    this.maintenanceRunning = true
    const startedAt = performance.now()
    const counters = this.emptyPhaseCounters()
    const writerBefore = { ...this.writerCounters }
    let outcome: HistorySearchPhaseOutcome = 'incomplete'
    try {
      if (this.disposed || this.index === undefined) {
        outcome = this.settledPhaseOutcome()
        return
      }
      const persistence = this.deps.sessionPersistence()
      const sessions = this.deps.sessions()
      const query = this.deps.sessionQuery()
      if (persistence === undefined || sessions === undefined || query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        outcome = 'unavailable'
        return
      }
      const signal = this.lifecycle.signal
      const deletionCut = this.deletionCut()
      const official = await this.enumerateOfficialSessions(persistence, sessions, signal, 'periodic_verify')
      this.beginCoverageRound(official)
      const deletion = await this.reconcileRemovedSessions(official, persistence, sessions, deletionCut)
      if (deletion === 'failed') {
        outcome = 'incomplete'
        return
      }
      if (this.coverageRound !== undefined) this.coverageRound.deletionsSettled = deletion === 'complete'
      for (const [sessionId, record] of official) {
        counters.sessionsVisited += 1
        signal.throwIfAborted()
        // Full and point work never independently own the same id: an active
        // repair is awaited, then this round claims the id in the single-flight
        // map. A repair requested during the claim is coalesced to the release.
        const result = await this.withFullSessionOwnership(sessionId, () =>
          this.reconcileOfficialSession(sessionId, record, persistence, sessions, query, counters))
        if (result === 'failed') {
          outcome = 'incomplete'
          return
        }
        if (result === 'complete') this.settleRoundSession(sessionId)
        else this.markRoundInvalidating()
      }
      if (this.coverageRound !== undefined) this.coverageRound.traversed = true
      // Accepted live events that arrived during the pass merge in order BEFORE
      // the completeness decision. Each writer turn commits at most one bounded
      // chunk, so this wait never hides an unbounded live burst behind one task.
      let drained: WriteReceipt = 'committed'
      while (this.pending.size > 0) {
        const pendingEventsBefore = this.pendingEventCount
        drained = await this.enqueueWrite(() => {
          this.drainOnePendingSession()
        })
        if (drained === 'failed') break
        // A loading/closed edge can refuse to drain; never spin this pass.
        if (this.pendingEventCount === pendingEventsBefore) break
      }
      if (drained !== 'committed') this.markRoundInvalidating()
      // A Session replaced during the pass may not have been re-read (no new
      // event): re-validate the EXACT enumerated live identity for every record
      // before this pass is allowed to publish ready.
      for (const sessionId of this.staleOfficialIdentities(official, sessions)) {
        this.markRoundInvalidating()
        this.reconcilePending.add(sessionId)
        this.markReconcileNeeded('reconciling')
      }
      this.dropSettledReconcilePending(official)
      // A healthy completed pass clears the transient source fault BEFORE the
      // round proof; the coverage fact must not be denied by the fault it just
      // proved stale.
      if (drained === 'committed') this.sourceFaulted = false
      this.finishCoverageRound()
      this.refreshCompleteness()
      outcome = this.settledPhaseOutcome()
    } catch (error) {
      if (!this.lifecycle.signal.aborted && !this.disposed) {
        this.sourceFaulted = true
        this.markReconcileNeeded('source-read-failed')
        this.diag.warn('history search verification failed', { category: error instanceof Error ? error.name : 'unknown' })
      }
      throw error
    } finally {
      this.maintenanceRunning = false
      if (this.lifecycle.signal.aborted || this.disposed) outcome = 'cancelled'
      this.logPhaseEnd('history-search.verify.end', outcome, startedAt, counters)
      this.logWriterAggregate('periodic_verify', writerBefore)
    }
  }

  /** Apply the frozen per-Session reconciliation rules with SHORT index commits only. */
  private async reconcileOfficialSession(
    sessionId: string,
    record: OfficialSession,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    query: HistorySearchQueryLike,
    counters: HistorySearchPhaseCounters,
  ): Promise<ReplayOutcome> {
    const signal = this.lifecycle.signal
    // First/full coverage has NOT been established. A clean on-disk checkpoint
    // from another incarnation (or an earlier aborted pass) plus a matching live
    // object cannot prove this Host observed the complete current source; DSH
    // seed events do not republish on session/event. Force an authoritative
    // current-incarnation rebuild for every unproven ID.
    if (this.coverage !== 'proven') {
      this.markRoundInvalidating()
      return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
    }
    let checkpoint = this.index?.checkpointOf(sessionId)
    if (
      checkpoint !== undefined
      && checkpoint.sourceState === 'live'
      && !record.live
      && (checkpoint.dirty || checkpoint.uncertainSources > 0)
    ) {
      // Disposed provisional rows: never reset before the official durable
      // source proves the claimed prefix. A short source is append lag, not a
      // rollback; truncating it into `ready` would silently drop accepted rows.
      this.markRoundInvalidating()
      const proof = await this.proveDurablePrefix(sessionId, checkpoint, persistence)
      signal.throwIfAborted()
      if (proof === 'insufficient' || proof === 'unreadable') {
        this.reconcilePending.add(sessionId)
        await this.markSessionDirty(sessionId)
        this.markReconcileNeeded(proof === 'unreadable' ? 'source-read-failed' : 'reconciling')
        return 'stale'
      }
      if (proof === 'rollback') {
        // Header/cut/tail explicitly replaced: the official source is the
        // authoritative rollback and a rebuild is safe.
        return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
      }
      // The claimed prefix is present: settle the provisional marker, then
      // apply the normal revision rules below.
      const settled = await this.commitCheckpointMarker(sessionId, persistence, sessions, checkpoint, {
        sourceState: 'persisted',
        dirty: false,
      })
      if (settled !== 'committed') {
        this.reconcilePending.add(sessionId)
        return settled === 'failed' ? 'failed' : 'stale'
      }
      checkpoint = this.index?.checkpointOf(sessionId)
      if (checkpoint === undefined) {
        this.reconcilePending.add(sessionId)
        return 'stale'
      }
    } else if (checkpoint === undefined || checkpoint.dirty || checkpoint.uncertainSources > 0) {
      // A dirty/uncertain checkpoint cannot prove its whole prefix from the tail
      // alone (a middle event may have been repaired), and an incremental replay
      // that finds no new tail events would never call writeBatch(), leaving
      // dirty set forever. Reconcile from official events instead.
      this.markRoundInvalidating()
      return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
    }
    if (checkpoint.headerHash !== sessionHeaderHash(record.header)) {
      this.markRoundInvalidating()
      return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
    }
    const droppedCoverage = this.droppedAccepted.get(sessionId)
    if (droppedCoverage !== undefined && checkpoint.nextSeq <= droppedCoverage) {
      // An overflow evicted accepted facts at or above this checkpoint. The
      // no-read live path cannot prove them, and a pending veto no longer
      // exists once the payload was freed. Force an authoritative read: observe
      // the live source, or fully replay the persisted source. The shared
      // watermark stays until the committed checkpoint passes it.
      this.markRoundInvalidating()
      if (record.live) return this.rebuildLiveSession(sessionId, persistence, sessions, query)
      return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
    }
    if (!record.live && record.eventCount !== undefined && record.eventCount < checkpoint.nextSeq) {
      // A durable tail shrink is a rollback: rebuild from the official log. A
      // LIVE Session's persistence count may legitimately lag its accepted
      // events (append is not the durability barrier), so it is never read as a
      // shrink here.
      this.markRoundInvalidating()
      return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: true })
    }
    if (!record.live) {
      const unchanged = this.revisionUnchanged(sessionId, record, persistence)
      const extended = record.eventCount !== undefined && record.eventCount > checkpoint.nextSeq
      if (!unchanged || extended) {
        // A changed or absent same-instance revision is NOT proof that the old
        // prefix survived a middle-of-log repair, even when the tail event hash
        // still matches. Rebuild from official events instead of trusting it.
        this.markRoundInvalidating()
        return this.replayOfficialSession(sessionId, record, persistence, sessions, query, counters, { rebuild: !unchanged })
      }
    }
    if (checkpoint.sourceState === 'live' && !record.live && record.eventCount !== undefined && record.eventCount >= checkpoint.nextSeq) {
      this.markRoundInvalidating()
      const settled = await this.commitCheckpointMarker(sessionId, persistence, sessions, checkpoint, { sourceState: 'persisted' })
      if (settled !== 'committed') {
        this.reconcilePending.add(sessionId)
        return settled === 'failed' ? 'failed' : 'stale'
      }
    }
    // The no-read path publishes the previous verified epoch. It is only current
    // while the SAME enumerated live object (or its absence) and no buffered
    // accepted event still hold: a post-enumeration same-ID replacement must
    // keep the index incomplete, never inherit a stale ready claim.
    if (this.pending.has(sessionId)) {
      // The buffered accepted facts are the obligation. The bounded drain owns
      // their terminal settlement; manufacturing a separate reconcile barrier
      // here would leave no point flight to release it after the final chunk.
      this.markReconcileNeeded('reconciling')
      return 'stale'
    }
    if (sessions.get(sessionId) !== record.liveObject) {
      this.reconcilePending.add(sessionId)
      this.markReconcileNeeded('reconciling')
      return 'stale'
    }
    this.reconcilePending.delete(sessionId)
    this.settleRoundSession(sessionId)
    return 'complete'
  }

  /** One short checkpoint-marker mutation behind the candidate witness fence. */
  private async commitCheckpointMarker(
    sessionId: string,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    expected: HistorySessionCheckpointRow,
    marker: { readonly dirty?: boolean; readonly sourceState?: 'persisted' | 'live' },
  ): Promise<CandidateCommit> {
    const witness = this.createWitness(sessionId, persistence, sessions, expected)
    try {
      return await this.commitWitness(witness, () => {
        this.requireIndex().markSession({ sessionId, ...marker })
      })
    } finally {
      this.releaseWitness(witness)
    }
  }

  /**
   * Delete derived Sessions absent from the authoritative roster, one guarded
   * short write each: a new live object, a buffered accepted event, a new
   * maintenance candidate or a moved checkpoint refuses the deletion.
   */
  /** Snapshot the deletion candidates before the persisted roster is sampled. */
  private deletionCut(): Map<string, HistorySessionCheckpointRow> {
    const cut = new Map<string, HistorySessionCheckpointRow>()
    for (const checkpoint of this.index?.listSessions() ?? []) cut.set(checkpoint.sessionId, checkpoint)
    return cut
  }

  private async reconcileRemovedSessions(
    official: ReadonlyMap<string, OfficialSession>,
    persistence: HistorySearchPersistenceLike,
    sessions: HistorySearchSessionsLike,
    deletionCut: ReadonlyMap<string, HistorySessionCheckpointRow>,
  ): Promise<ReplayOutcome> {
    if (this.index === undefined) return 'complete'
    let allApplied = true
    // Delete only round-local candidates: the witness below is bound to the
    // checkpoint captured BEFORE the roster read, so a Session created or
    // changed during the scan can never pass this deletion fence.
    for (const checkpoint of deletionCut.values()) {
      const sessionId = checkpoint.sessionId
      if (official.has(sessionId)) continue
      this.markRoundInvalidating()
      const witness = this.createWitness(sessionId, persistence, sessions, checkpoint)
      try {
        let stale = false
        const receipt = await this.enqueueWrite(() => {
          // A live entry, a buffered accepted event, an evicted-but-uncovered
          // accepted tail, an active same-id repair or a moved checkpoint
          // refuses this derived deletion outright. A stale roster snapshot is
          // not proof that the accepted facts are gone; only a committed
          // official replay may cover the watermark.
          if (
            !this.isCandidateCurrent(witness)
            || this.sessionRepairFlights.has(sessionId)
            || this.pending.has(sessionId)
            || this.droppedAccepted.has(sessionId)
          ) {
            stale = true
            return
          }
          if (witness.sessions.get(sessionId) !== undefined) {
            stale = true
            return
          }
          this.requireIndex().deleteSession(sessionId)
          // The official roster no longer owns this session; an accepted batch
          // must not keep a deleted session's barrier alive forever. (No batch
          // can reach here now: pending vetoes deletion above.)
          this.discardPendingSession(sessionId)
          this.droppedAccepted.delete(sessionId)
        })
        if (receipt === 'failed') return 'failed'
        if (stale) {
          allApplied = false
          this.reconcilePending.add(sessionId)
          this.markReconcileNeeded('reconciling')
          continue
        }
        this.verifiedRevisions.delete(sessionId)
        this.reconcilePending.delete(sessionId)
      } finally {
        this.releaseWitness(witness)
      }
    }
    return allApplied ? 'complete' : 'stale'
  }

  /** Official records whose exact enumerated live source identity no longer holds. */
  private staleOfficialIdentities(
    official: ReadonlyMap<string, OfficialSession>,
    sessions: HistorySearchSessionsLike,
  ): string[] {
    const stale: string[] = []
    for (const [sessionId, record] of official) {
      if (this.pending.has(sessionId) || sessions.get(sessionId) !== record.liveObject) stale.push(sessionId)
    }
    return stale
  }

  /** IDs that are neither official nor derivable no longer keep the barrier up. */
  private dropSettledReconcilePending(official: ReadonlyMap<string, OfficialSession>): void {
    for (const sessionId of [...this.reconcilePending]) {
      if (official.has(sessionId)) continue
      if (this.sessionRepairFlights.has(sessionId)) continue
      if (this.index?.checkpointOf(sessionId) !== undefined) continue
      this.reconcilePending.delete(sessionId)
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
      const sessions = this.deps.sessions()
      const query = this.deps.sessionQuery()
      if (persistence === undefined || sessions === undefined || query === undefined) {
        this.state = { kind: 'unavailable', reason: 'service-missing' }
        return
      }
      // A Session without a derived checkpoint has nothing to prove: skip the
      // official read instead of observing a Session this index never held.
      const checkpoint = this.index.checkpointOf(sessionId)
      if (checkpoint === undefined) return
      if (checkpoint.dirty || checkpoint.uncertainSources > 0) {
        // The prefix proof below only proves the ALREADY INDEXED rows. A dirty
        // or uncertain checkpoint has accepted events beyond that prefix, so a
        // disposal/repair must replay the complete official source instead of
        // settling `dirty=false` and publishing `ready` with missing history.
        await this.rebuildFromPersistence(sessionId, persistence, sessions, query)
        return
      }
      const witness = this.createWitness(sessionId, persistence, sessions, checkpoint)
      try {
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
          this.markReconcileNeeded('source-uncertain')
          await this.markWitnessDirty(witness)
          return
        }
        if (checkpoint.headerHash !== sessionHeaderHash(snapshot.header)) {
          this.markReconcileNeeded('reconciling')
          await this.markWitnessDirty(witness)
          return
        }
        if (snapshot.eventCount !== undefined && snapshot.eventCount < checkpoint.nextSeq) {
          this.markReconcileNeeded('reconciling')
          await this.markWitnessDirty(witness)
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
          this.markReconcileNeeded('source-read-failed')
          await this.markWitnessDirty(witness)
          return
        }
        if (proof !== 'proven') {
          // Short/unreadable prefix is append lag, not a rollback: keep the rows
          // and the provisional checkpoint and retry through the normal pass.
          this.markReconcileNeeded('reconciling')
          await this.markWitnessDirty(witness)
          return
        }
        const settled = await this.commitWitness(witness, () => {
          this.requireIndex().markSession({ sessionId, sourceState: 'persisted', dirty: false })
        })
        if (settled !== 'committed') {
          this.reconcilePending.add(sessionId)
          this.markReconcileNeeded('reconciling')
          return
        }
        this.reconcilePending.delete(sessionId)
        this.settleRoundSession(sessionId)
        this.finishCoverageRound()
        this.refreshCompleteness()
      } finally {
        this.releaseWitness(witness)
      }
    } finally {
      counters.verifyElapsedMsTotal += elapsedMilliseconds(verifyStartedAt)
    }
  }

  /** Best-effort dirty marker behind the candidate's own witness fence. */
  private async markWitnessDirty(witness: HistoryCandidateWitness): Promise<void> {
    const settled = await this.commitWitness(witness, () => {
      this.requireIndex().markSession({ sessionId: witness.sessionId, dirty: true })
    })
    if (settled !== 'committed') this.reconcilePending.add(witness.sessionId)
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

  /** O(1) serial-writer aggregate for ONE pass (never per Session or per row). */
  private logWriterAggregate(
    phase: HistorySearchInventoryPhase,
    before: HistoryWriterCounters,
  ): void {
    this.logDiagnostic('history-search.writer', {
      phase,
      writerCommitted: this.writerCounters.committed - before.committed,
      writerFailed: this.writerCounters.failed - before.failed,
      writerBusyMsTotal: roundMilliseconds(this.writerCounters.busyMsTotal - before.busyMsTotal),
      writerBusyMsMaxObserved: roundMilliseconds(this.writerCounters.busyMsMax),
      awaitWritesMsTotal: roundMilliseconds(this.writerCounters.awaitWritesMsTotal - before.awaitWritesMsTotal),
      awaitWritesMsMaxObserved: roundMilliseconds(this.writerCounters.awaitWritesMsMax),
    })
  }

  private beginCoverageRound(official: ReadonlyMap<string, OfficialSession>): void {
    const previous = this.coverageRound
    this.coverageRound = {
      expected: this.coverage === 'proven' ? undefined : new Set(official.keys()),
      settled: new Set(),
      deletionsSettled: false,
      // An unresolved destructive obligation survives a new round; only a
      // complete same-round proof may release it.
      invalidating: previous?.invalidating ?? false,
      traversed: false,
    }
  }

  /** The round's first known destructive publication holds the incomplete barrier. */
  private markRoundInvalidating(): void {
    const round = this.coverageRound
    if (round === undefined) return
    if (round.invalidating) return
    round.invalidating = true
    // Publish the downgrade immediately; the Owner read must not observe a
    // ready state between two destructive commits of the same round.
    this.markReconcileNeeded('reconciling')
  }

  private settleRoundSession(sessionId: string): void {
    if (this.coverageRound?.expected?.has(sessionId) === true) {
      this.coverageRound.settled.add(sessionId)
    }
  }

  private finishCoverageRound(): void {
    const round = this.coverageRound
    if (round === undefined) return
    if (!round.traversed) return
    if (!round.deletionsSettled) return
    if (round.expected !== undefined && round.expected.size !== round.settled.size) return
    if (this.sourceFaulted || this.indexFaulted) return
    if (this.reconcilePending.size > 0 || this.pending.size > 0 || this.droppedAccepted.size > 0) return
    if (this.sessionRepairFlights.size > 0) return
    this.coverageRound = undefined
    this.coverage = 'proven'
    this.refreshCompleteness()
  }

  /** The diagnostic outcome of a pass that settled normally. */
  private settledPhaseOutcome(): HistorySearchPhaseOutcome {
    if (this.state.kind === 'ready') return 'ready'
    if (this.state.kind === 'unavailable') return 'unavailable'
    return 'incomplete'
  }

  /** Truthful immediate downgrade; never overrides a definite `unavailable`. */
  private markReconcileNeeded(reason: HistorySearchIncompleteReason = 'reconciling'): void {
    if (this.state.kind === 'unavailable') return
    if (this.state.kind === 'loading' && this.coverage === 'booting') return
    this.state = { kind: 'incomplete', reason }
  }

  /**
   * Derive the ONE public completeness state from the committed index, the
   * outstanding repair barrier and the sticky fault latches. A pass that is
   * still in its first cold replay stays `loading`; an interrupted repair can
   * never be observed as `ready`.
   */
  private refreshCompleteness(): void {
    if (this.disposed || this.index === undefined) return
    if (this.state.kind === 'unavailable') return
    if (this.coverage === 'booting') {
      this.state = { kind: 'loading' }
      return
    }
    if (this.sourceFaulted || this.indexFaulted) {
      this.state = { kind: 'incomplete', reason: 'source-read-failed' }
      return
    }
    if (this.droppedAccepted.size > 0) {
      // A committed SQLite checkpoint is not, by itself, proof that the
      // official source is current: a live batch commit can advance it while
      // the final source proof is still pending or has failed. The obligation
      // is cleared only by settleDroppedCoverage() after a successful complete
      // replay with its final same-instance currentness proof.
      this.state = { kind: 'incomplete', reason: 'resource-limit' }
      return
    }
    if (this.reconcilePending.size > 0) {
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      // A startup/pass handoff may have left ordinary accepted events whose
      // repair was refused during loading. Schedule the bounded drain now;
      // never wait for another event or the 30 s timer.
      if (this.hasUnheldPending()) this.enqueueDrain()
      return
    }
    if (this.pending.size > 0) {
      // Accepted live events are not yet fully committed: a ready answer would
      // omit history the Owner already accepted. Move ordinary pending work;
      // a held batch waits for an explicit event/pass (never a self-spin).
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      if (this.hasUnheldPending()) this.enqueueDrain()
      return
    }
    const incomplete = this.index.incompleteReason()
    if (incomplete === 'dirty') {
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      return
    }
    if (incomplete === 'uncertain') {
      this.state = { kind: 'incomplete', reason: 'source-uncertain' }
      return
    }
    // A round that began a known destructive publication holds the barrier
    // through all of its remaining work. A subsequent read-only round does not
    // clear an unresolved prior obligation; only a complete same-round proof.
    if (this.coverageRound?.invalidating === true) {
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      return
    }
    // Failure/partial first coverage is not a ready state, and a point repair
    // of one Session cannot prove an unvisited/failed rest of the roster.
    if (this.coverage !== 'proven') {
      this.state = { kind: 'incomplete', reason: 'reconciling' }
      return
    }
    if (this.state.kind === 'loading' || this.state.kind === 'incomplete') {
      this.state = { kind: 'ready' }
    }
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
