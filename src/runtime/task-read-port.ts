/**
 * Detached read-only facts for the Task Center migration shadow.
 *
 * The port deliberately stops at one direct-child catalog and one session's job
 * status snapshots. The complete descendant tree remains an explicit upstream
 * gap until D5; this port never recreates that traversal in the TUI.
 * @module @xmoon76/dsh-pi-tui/runtime/task-read-port
 */

/** One direct-child subagent row from the official catalog. */
export type TaskSubagentEntry =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly label?: string
    readonly mode: 'one-shot' | 'continuable'
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: string
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/** Status-only facts from one official background-job snapshot. */
export interface TaskJobEntry {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Detached facts needed to compare the current Task Center read surface. */
export interface TaskReadSnapshot {
  readonly parentSessionId: string
  readonly parentAvailable: boolean
  readonly children: readonly TaskSubagentEntry[]
  readonly jobs: readonly TaskJobEntry[]
}

/** Read one direct-child catalog and its status-only jobs. */
export interface TaskReader {
  readDirectChildren(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<TaskReadSnapshot | undefined>
}
