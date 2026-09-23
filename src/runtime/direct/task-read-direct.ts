/**
 * Direct reference reader for the M2 Task Center read shadow.
 *
 * This adapter only composes existing Host read services: the official direct
 * child listing, the Agent registry's live driver status, and the
 * SessionId-owned `jobs.list`. It never creates or activates an Agent and
 * never exposes a Host object in the detached result.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/task-read-direct
 */

import type {
  TaskJobEntry,
  TaskReader,
  TaskReadSnapshot,
  TaskSubagentEntry,
} from '../task-read-port.ts'

/** The only Agent fact needed to project Task Center activity. */
export interface DirectTaskAgent {
  readonly status?: string
}

/** Official Host read faces supplied by the Direct wiring or a smoke fixture. */
export interface DirectTaskReadSource {
  /** Resolve an already-live Agent; absence means the parent is unavailable. */
  agentFor(sessionId: string): DirectTaskAgent | undefined
  /** Official durable direct-child catalog. */
  readonly subagents: {
    listChildren(
      parentSessionId: string,
      signal?: AbortSignal,
    ): Promise<readonly TaskSubagentEntry[]>
  }
  /** Status-only job snapshots owned by the parent session (DSH 0.1.7
   * JobRegistry SessionId ownership). */
  readonly jobs: {
    list(caller: string): readonly TaskJobEntry[]
  }
}

function detachChild(
  entry: TaskSubagentEntry,
  source: DirectTaskReadSource,
): TaskSubagentEntry {
  if (entry.kind === 'diagnostic') {
    return Object.freeze({
      kind: 'diagnostic',
      id: entry.id,
      reason: entry.reason,
    })
  }
  return Object.freeze({
    kind: 'child',
    id: entry.id,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    mode: entry.mode,
    // The catalog's activity is Session-store presence. The current TUI row
    // contract uses the Agent registry's driver status instead.
    activity: source.agentFor(entry.id)?.status === 'running' ? 'running' : 'inactive',
    hasChildren: entry.hasChildren,
  })
}

function detachJob(job: TaskJobEntry): TaskJobEntry {
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

/** Read one live parent's direct-child catalog and status-only jobs. */
export class DirectTaskReader implements TaskReader {
  private readonly source: DirectTaskReadSource

  constructor(source: DirectTaskReadSource) {
    this.source = source
  }

  async readDirectChildren(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<TaskReadSnapshot | undefined> {
    signal?.throwIfAborted()
    const parent = this.source.agentFor(parentSessionId)
    if (parent === undefined) return undefined

    const entries = await this.source.subagents.listChildren(parentSessionId, signal)
    signal?.throwIfAborted()
    const currentParent = this.source.agentFor(parentSessionId)
    if (currentParent === undefined) return undefined
    const children = Object.freeze(entries.map(entry => detachChild(entry, this.source)))
    // Job ownership is the parent Session id (DSH 0.1.7 JobRegistry), not
    // the Agent object; `currentParent` above only fences availability.
    const jobs = Object.freeze(this.source.jobs.list(parentSessionId).map(detachJob))
    return Object.freeze({
      parentSessionId,
      parentAvailable: true,
      children,
      jobs,
    })
  }
}
