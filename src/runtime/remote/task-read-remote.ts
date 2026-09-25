/**
 * Read-only Task Center adapter over the published DSH 0.1.7-rc.2 Client model.
 *
 * Child membership comes from the official Client Session projections
 * (`projectionsBySession[parentId].values.subagentCatalog`), parent
 * availability from the official Session list facts, and the status-only
 * job roster from the official ClientJobs service through a retained
 * `watchRows(sessionId)` reference — the reader owns that watch for the
 * session it last read and releases it on switch/dispose. This module
 * never calls raw Remotes, opens a Session, or recreates a store; the
 * projection single-flight belongs to the official Client.
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

/** One official client-safe direct-child discovery row
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

function detachChild(
  entry: TaskSubagentEntry,
  activity: 'running' | 'inactive',
): TaskSubagentEntry {
  return entry.kind === 'diagnostic'
    ? Object.freeze({
      kind: 'diagnostic',
      id: entry.id,
      reason: entry.reason,
    })
    : Object.freeze({
      kind: 'child',
      id: entry.id,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      mode: entry.mode,
      activity,
      // Neither official read face exposes a descendant fact: the Direct
      // listChildren entries (SubagentCatalogEntry) carry none, and a
      // client-side "child's own projection is loaded and non-empty"
      // derivation would be load-dependent — diverging from Direct and
      // flipping under projection cache pressure. Both readers report
      // `false` (no known children); expandability belongs to the Task
      // Browser's own descendant navigation, not this read face.
      hasChildren: false,
    })
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

/**
 * Read one settled direct-child catalog, the parent availability fact, and
 * the status-only job roster of one session. The roster watch is retained
 * across reads for the SAME parent and switches atomically when the read
 * targets another session.
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
    this.releaseWatch = undefined
    this.watchedSession = undefined
    // Acquire the successor FIRST, then release the predecessor: a watch
    // gap would drop the roster between the two calls (the official
    // release is also entry-bound, so releasing after the acquire can
    // never tear the new stream down).
    this.releaseWatch = this.jobs.watchRows(parentSessionId)
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

  async readDirectChildren(
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

    let settled: {
      readonly entries: readonly RemoteSubagentCatalogEntry[]
    } | undefined
    while (settled === undefined) {
      signal?.throwIfAborted()
      if (!this.isCurrent(capturedGeneration, epoch)) return undefined
      const snapshot = this.sessions.list.getSnapshot()
      const projection = snapshot.projectionsBySession[parentSessionId]
      const state = projection === undefined
        ? 'loading'
        : projection.state === 'idle'
          ? projection.values.subagentCatalog === undefined ? 'loading' : 'ready'
          : projection.state
      if (state === 'error') throw projection?.error
      // The official Client owns the projection single-flight; re-enter
      // its explicit read until the projection is settled. A missing,
      // idle, or loading projection is NEVER an authoritative empty
      // membership.
      if (state === 'loading') {
        try {
          await this.sessions.refreshProjections(parentSessionId)
        } catch (error) {
          signal?.throwIfAborted()
          if (!this.isCurrent(capturedGeneration, epoch)) return undefined
          throw error
        }
        continue
      }
      settled = { entries: projection!.values.subagentCatalog ?? [] }
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
    const children = Object.freeze(settled.entries.map(entry => detachChild(
      {
        kind: 'child',
        id: entry.id,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        // The port's mode vocabulary is the two known modes; an official
        // 'unknown' catalog row maps to the READ-ONLY presentation (never
        // offer follow-up interaction for an unclassified child).
        mode: entry.mode === 'unknown' ? 'one-shot' : entry.mode,
        activity: 'inactive',
        // Neither official read face exposes a descendant fact: the Direct
        // listChildren entries (SubagentCatalogEntry) carry none, and a
        // client-side "child's own projection is loaded and non-empty"
        // derivation would be load-dependent — diverging from Direct and
        // flipping under projection cache pressure. Both readers report
        // `false` (no known children); expandability belongs to the Task
        // Browser's own descendant navigation, not this read face.
        hasChildren: false,
      },
      snapshot.byId[entry.id]?.running === true ? 'running' : 'inactive',
    )))
    const jobs = Object.freeze((this.jobs.state.getSnapshot().rows[parentSessionId] ?? []).map(detachJob))
    if (!this.isCurrent(capturedGeneration, epoch)) return undefined
    return Object.freeze({
      parentSessionId,
      parentAvailable,
      children,
      jobs,
    })
  }
}
