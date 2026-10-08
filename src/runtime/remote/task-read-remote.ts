/**
 * Read-only Task Center adapter over the published DSH 0.1.7-rc.2 Client model.
 *
 * Descendant membership and order come from a recursive walk of the official
 * Client Session projections (`projectionsBySession[id].values.subagentCatalog`)
 * mirroring the upstream `listDescendants` semantics: stable pre-order, exact
 * `parentId`/`depth`, branch diagnostics, and `hasChildren` from the child's
 * own catalog. Parent availability and per-child activity come from the
 * official Session list facts; the status-only job roster comes from the
 * official ClientJobs service through a retained `watchRows(sessionId)`
 * reference — the reader owns that watch for the session it last read and
 * releases it on switch/dispose. Listing never retains or opens a child
 * Session; the projection single-flight belongs to the official Client.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/task-read-remote
 */

import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'
import type {
  TaskJobEntry,
  TaskReader,
  TaskReadSnapshot,
  TaskSubagentEntry,
} from '../task-read-port.ts'

/**
 * Structural subset of the official `ClientSessions` (`ISessions`) model
 * used here: the Session list facts (parent availability, per-session
 * running) and the shared projection store, plus the explicit projection
 * read for cold/retry refresh. `ISessions` must satisfy this type.
 */
export interface RemoteTaskSessionsSource {
  readonly list: {
    getSnapshot(): {
      readonly byId: Readonly<Record<string, { readonly running: boolean } | undefined>>
      readonly projectionsBySession: Readonly<Record<string, {
        readonly values: Readonly<{ readonly subagentCatalog?: readonly RemoteSubagentCatalogEntry[] }>
        readonly state: 'idle' | 'loading' | 'ready' | 'error'
        readonly error: unknown
      } | undefined>>
    }
  }
  refreshProjections(sessionId: string): Promise<void>
}

/**
 * Structural subset of the official ClientJobs service (`IJobs`) used
 * here: the reference-counted roster watch and the status-only snapshot.
 * `IJobs` must satisfy this type.
 */
export interface RemoteTaskJobsSource {
  readonly state: {
    getSnapshot(): {
      readonly rows: Readonly<Record<string, readonly RemoteJobView[]>>
    }
  }
  watchRows(sessionId: string): () => void
}

/** One official client-safe catalog row
 * (`SubagentCatalogEntry`): identity and durable mode, no activity. */
export interface RemoteSubagentCatalogEntry {
  readonly id: string
  readonly createdAt: number
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly label?: string
}

/** The official client-safe job projection fields the Task Center rows read. */
export interface RemoteJobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

function detachDiagnostic(
  id: string,
  reason: 'corrupt' | 'unsupported' | 'unavailable',
  parentId: string,
  depth: number,
): TaskSubagentEntry {
  return Object.freeze({ kind: 'diagnostic', id, reason, parentId, depth })
}

function detachJob(job: RemoteJobView): TaskJobEntry {
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  })
}

interface CatalogPosition {
  readonly entry: RemoteSubagentCatalogEntry
  readonly parentId: string
  readonly depth: number
}

/**
 * Read the full descendant catalog, the parent availability fact, and the
 * status-only job roster of one session. The roster watch is retained across
 * reads for the SAME parent and switches atomically when the read targets
 * another session.
 */
export class RemoteTaskReader implements TaskReader {
  private readonly sessions: RemoteTaskSessionsSource
  private readonly jobs: RemoteTaskJobsSource
  private readonly generation: RemoteConnectionGenerationSource
  private releaseWatch: (() => void) | undefined
  private watchedSession: string | undefined
  /** Reader-local operation epoch (§6.9 stale-fencing): bumped by every
   * read start and by dispose, so a read superseded by a newer read (any
   * parent), a session switch, or reader disposal can never return its
   * snapshot — the connection generation fence alone cannot see those. */
  private operationEpoch = 0

  constructor(
    sessions: RemoteTaskSessionsSource,
    jobs: RemoteTaskJobsSource,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.jobs = jobs
    this.generation = generation
  }

  /** Release the retained roster watch and invalidate every in-flight
   * read; safe to call more than once. The reader itself stays usable — a
   * later read re-opens a watch under a fresh epoch. */
  dispose(): void {
    this.operationEpoch += 1
    // Only the CURRENT watch is released: an older release closure bound a
    // previous switch and must never tear down the successor watch.
    this.releaseWatch?.()
    this.releaseWatch = undefined
    this.watchedSession = undefined
  }

  private ensureWatch(parentSessionId: string): void {
    if (this.watchedSession === parentSessionId && this.releaseWatch !== undefined) return
    const previous = this.releaseWatch
    // Acquire the successor FIRST, then release the predecessor: a watch
    // gap would drop the roster between the two calls (the official
    // release is also entry-bound, so releasing after the acquire can
    // never tear the new stream down). The predecessor stays tracked until
    // the successor exists, so a synchronous acquire failure — defensive
    // structural hardening; the adapter must not depend on an acquisition
    // never throwing — cannot orphan a lease this reader still owns.
    const successor = this.jobs.watchRows(parentSessionId)
    this.releaseWatch = successor
    this.watchedSession = parentSessionId
    previous?.()
  }

  /** §6.9 fencing: this read is current only while no newer read/dispose
   * bumped the epoch AND the Connection generation it captured is live. */
  private isCurrent(
    capturedGeneration: RemoteConnectionGeneration,
    epoch: number,
  ): boolean {
    return this.operationEpoch === epoch
      && generationMatches(this.generation, capturedGeneration)
  }

  /**
   * Read one session's settled durable catalog. A missing, idle, or loading
   * projection is NEVER an authoritative empty membership, so the read
   * re-enters the official single-flight `refreshProjections` until the
   * projection settles. Two settled failure shapes are handled explicitly:
   *
   * - `state === 'error'`: the official `refreshProjections` is the released
   *   RETRY face (it short-circuits only on a settled `ready`), so this read
   *   re-enters it ONCE before giving up — otherwise one transient failure would
   *   turn every later read (including the Task Center's own retry) into a
   *   permanent failure;
   * - `state === 'ready'` WITHOUT `subagentCatalog`: the official Client clears
   *   the projection store and still settles `ready` when `session.projections`
   *   answers a null/missing Session, so this is a REAL read failure — exactly
   *   the one upstream `listChildren` reports as
   *   `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`. It must never read as an
   *   authoritative empty catalog (root) or as a normal inactive child (branch).
   *
   * Returns `undefined` when this read was superseded or the Connection
   * generation changed.
   */
  private async readCatalog(
    sessionId: string,
    capturedGeneration: RemoteConnectionGeneration,
    epoch: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly RemoteSubagentCatalogEntry[] | undefined> {
    let retriedOnError = false
    for (;;) {
      signal?.throwIfAborted()
      if (!this.isCurrent(capturedGeneration, epoch)) return undefined
      const snapshot = this.sessions.list.getSnapshot()
      const projection = snapshot.projectionsBySession[sessionId]
      const state = projection === undefined
        ? 'loading'
        : projection.state === 'idle'
          ? projection.values.subagentCatalog === undefined ? 'loading' : 'ready'
          : projection.state
      if (state === 'error') {
        if (retriedOnError) throw projection?.error
        retriedOnError = true
        try {
          await this.sessions.refreshProjections(sessionId)
        } catch (error) {
          signal?.throwIfAborted()
          if (!this.isCurrent(capturedGeneration, epoch)) return undefined
          throw error
        }
        continue
      }
      if (state === 'loading') {
        try {
          await this.sessions.refreshProjections(sessionId)
        } catch (error) {
          signal?.throwIfAborted()
          if (!this.isCurrent(capturedGeneration, epoch)) return undefined
          throw error
        }
        continue
      }
      const entries = projection!.values.subagentCatalog
      if (entries === undefined) {
        throw new Error(`the subagentCatalog projection is unavailable for Session ${sessionId}`)
      }
      return entries
    }
  }

  async readDescendants(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<TaskReadSnapshot | undefined> {
    signal?.throwIfAborted()
    // This read's epoch: any later read or dispose bumps past it, and every
    // check below then discards THIS read (§6.9: supersession fencing).
    const epoch = ++this.operationEpoch
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined

    // The roster watch must be open before the rows are read; the first
    // frame may still be in flight (rows absent), which reads as an empty
    // roster until the stream delivers.
    this.ensureWatch(parentSessionId)

    // The ROOT catalog is read first and a root failure throws: a root
    // projection error is never converted to an authoritative empty tree.
    const rootEntries = await this.readCatalog(parentSessionId, capturedGeneration, epoch, signal)
    if (rootEntries === undefined) return undefined

    const stack: CatalogPosition[] = rootEntries
      .map(entry => ({ entry, parentId: parentSessionId, depth: 1 }))
      .reverse()
    const visited = new Set<string>([parentSessionId])
    const descendants: TaskSubagentEntry[] = []
    for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
      signal?.throwIfAborted()
      if (!this.isCurrent(capturedGeneration, epoch)) return undefined
      const { entry, parentId, depth } = position
      if (visited.has(entry.id)) continue
      visited.add(entry.id)
      // The child's OWN catalog settles `hasChildren` and drives recursion. Its
      // failure stops ONLY this branch and becomes a diagnostic (see the catch
      // below): the branch-isolation policy is the owner-ruled Remote contract, and
      // only a real caller cancellation propagates.
      let children: readonly RemoteSubagentCatalogEntry[] | undefined
      try {
        children = await this.readCatalog(entry.id, capturedGeneration, epoch, signal)
      } catch (error) {
        // A caller cancellation propagates; it is never a branch diagnostic.
        signal?.throwIfAborted()
        if (!this.isCurrent(capturedGeneration, epoch)) return undefined
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        // BRANCH-LOCAL DEGRADATION (M3-5 PR2 owner ruling): every shape of "this
        // child's catalog cannot be read" — the missing-Session `ready` baseline
        // (see `readCatalog`), a `session/projections-unavailable` projection
        // failure, and any foreign wire failure — degrades to a branch-scoped
        // diagnostic whose siblings stay visible. This is the OWNER-CHOSEN product
        // contract for the Remote surface (one unreadable child catalog must not
        // erase the whole descendant tree); it is NOT a claim of behaviour parity
        // with the current upstream implementation, and the tension is recorded on
        // BOTH sides: the current Host `listDescendants()` re-throws
        // `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` (a whole-traversal abort), while
        // the Web mapper keeps `ready` but falls back to
        // `entries = (values.subagentCatalog ?? [])` and therefore renders the
        // ready/key-absent shape as a KNOWN LEAF (`isKnownLeaf` = `ready &&
        // entries.length === 0`). Only the error/loading shapes are expandable and
        // retryable there. Caller cancellation is the ONE exception (handled above).
        //
        // CARRIER LIMIT (recorded, not papered over): the rc.2 Client collapses the
        // Host `null` (missing Session) and a non-null baseline that omits
        // `subagentCatalog` into the SAME `ready + key absent` state, so exact
        // failure-scope parity with the Host rethrow is NOT representable, and its
        // provenance MUST NOT be inferred from Session-list membership, catalog
        // presence, messages, logs or any other authority. This failure SCOPE is
        // user-visible: on the Direct special case the whole Task read fails, while
        // the Remote surface degrades one branch and keeps its siblings. Corrupt /
        // source-conflicting SessionQuery failures likewise collapse to
        // `gateway/internal`, so `corrupt` is never inferred from shape: the
        // representable answer is `unavailable`.
        descendants.push(detachDiagnostic(
          entry.id,
          code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_SOURCE_CONFLICT'
            ? 'corrupt' : 'unavailable',
          parentId,
          depth,
        ))
        continue
      }
      if (children === undefined) return undefined
      if (entry.mode === 'unknown') {
        // An unclassified child stays non-interactive, but its readable
        // catalog is still traversed.
        descendants.push(detachDiagnostic(entry.id, 'unsupported', parentId, depth))
      } else {
        descendants.push(Object.freeze({
          kind: 'child',
          id: entry.id,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          mode: entry.mode,
          activity: this.sessions.list.getSnapshot().byId[entry.id]?.running === true
            ? 'running' : 'inactive',
          hasChildren: children.length > 0,
          parentId,
          depth,
        }))
      }
      // Catalog event order defines siblings; the stack visits the first one next.
      for (const child of [...children].reverse()) {
        stack.push({ entry: child, parentId: entry.id, depth: depth + 1 })
      }
    }

    if (!this.isCurrent(capturedGeneration, epoch)) return undefined

    const snapshot = this.sessions.list.getSnapshot()
    // Membership and availability are separate authorities: parent
    // availability is the official Session list fact, never inferred from
    // catalog presence. `byId` covers every session the Client knows to
    // exist — Host catalog rows PLUS locally retained subagent fallbacks —
    // which is the availability fact this reader wants: a parent that is
    // itself a subagent is omitted from the ordinary Host list (`ids`)
    // while still existing, so `ids`-only membership would understate. It
    // is knowledge that the session exists, not that it is running.
    const parentAvailable = snapshot.byId[parentSessionId] !== undefined
    const jobs = Object.freeze((this.jobs.state.getSnapshot().rows[parentSessionId] ?? []).map(detachJob))
    if (!this.isCurrent(capturedGeneration, epoch)) return undefined
    return Object.freeze({
      parentSessionId,
      parentAvailable,
      descendants: Object.freeze(descendants),
      jobs,
    })
  }
}
