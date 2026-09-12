/**
 * Read-only Task Center adapter over the official Client Session model.
 *
 * `ClientSessions` already owns catalog single-flight, reconnect refresh,
 * parent availability, child activity projection, and the per-session jobs
 * mirror. This module only asks that model for a settled snapshot and maps its
 * detached semantic facts; it does not call raw Remotes or recreate a store.
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

/** The Client catalog state retained by `ClientSessions`. */
export interface RemoteSubagentCatalog {
  readonly entries: readonly TaskSubagentEntry[]
  /** Optional in the official type while the first successful read is absent. */
  readonly parentAvailable?: boolean
  readonly state: 'loading' | 'ready' | 'error'
  readonly error: unknown
}

/** Status-only job facts retained in the Client Session list snapshot. */
export interface RemoteJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Structural subset of the official `ClientSessions` model used here. */
export interface RemoteTaskSessionsSource {
  readonly list: {
    getSnapshot(): {
      readonly subagentsByParent: Readonly<Record<string, RemoteSubagentCatalog>>
      readonly jobsBySession: Readonly<Record<string, readonly RemoteJob[]>>
    }
  }
  refreshSubagents(parentSessionId: string): Promise<void>
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

function detachChild(entry: TaskSubagentEntry): TaskSubagentEntry {
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
      activity: entry.activity,
      hasChildren: entry.hasChildren,
    })
}

function detachJob(job: RemoteJob): TaskJobEntry {
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

/** Read one settled direct-child catalog and its status-only jobs. */
export class RemoteTaskReader implements TaskReader {
  private readonly sessions: RemoteTaskSessionsSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemoteTaskSessionsSource,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.generation = generation
  }

  async readDirectChildren(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<TaskReadSnapshot | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined

    let settled: {
      readonly snapshot: ReturnType<RemoteTaskSessionsSource['list']['getSnapshot']>
      readonly catalog: RemoteSubagentCatalog
      readonly parentAvailable: boolean
    } | undefined
    while (settled === undefined) {
      signal?.throwIfAborted()
      if (!generationMatches(this.generation, capturedGeneration)) return undefined
      try {
        await this.sessions.refreshSubagents(parentSessionId)
      } catch (error) {
        signal?.throwIfAborted()
        if (!generationMatches(this.generation, capturedGeneration)) return undefined
        throw error
      }
      signal?.throwIfAborted()
      if (!generationMatches(this.generation, capturedGeneration)) return undefined

      const snapshot = this.sessions.list.getSnapshot()
      const catalog = snapshot.subagentsByParent[parentSessionId]
      if (catalog === undefined) return undefined
      if (catalog.state === 'error') throw catalog.error
      // ClientSessions may have already armed its trailing refresh before the
      // first promise resolves. Re-enter its official single-flight method
      // until the catalog it owns is settled; never read a loading snapshot as
      // an authoritative empty/result state.
      if (catalog.state === 'loading') continue
      const parentAvailable = catalog.parentAvailable
      if (parentAvailable === undefined) {
        throw new Error(`subagent catalog for ${parentSessionId} has no parent availability fact`)
      }
      settled = { snapshot, catalog, parentAvailable }
    }

    const { snapshot, catalog, parentAvailable } = settled
    if (!generationMatches(this.generation, capturedGeneration)) return undefined

    const children = Object.freeze(catalog.entries.map(detachChild))
    const jobs = Object.freeze((snapshot.jobsBySession[parentSessionId] ?? []).map(detachJob))
    if (!generationMatches(this.generation, capturedGeneration)) return undefined
    return Object.freeze({
      parentSessionId,
      parentAvailable,
      children,
      jobs,
    })
  }
}
