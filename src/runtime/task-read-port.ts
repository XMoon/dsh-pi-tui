/**
 * Detached read-only facts for the Task Center migration shadow.
 *
 * The port represents the real Task Center dataset: the root session's full
 * descendant catalog in stable DFS pre-order plus its status-only job roster.
 * Descendant membership, order, `parentId`, and `depth` come from the parent
 * `subagentCatalog` projections (the official `listDescendants` traversal);
 * `activity` is the current runtime fact, never catalog presence.
 * @module @xmoon76/dsh-pi-tui/runtime/task-read-port
 */

/**
 * One descendant row from the official recursive catalog traversal: a
 * classified child or a branch diagnostic. `parentId`/`depth` are the
 * traversal edge facts; direct children of the requested root carry
 * `depth: 1`.
 */
export type TaskSubagentEntry =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly label?: string
    readonly mode: 'one-shot' | 'continuable'
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
    readonly parentId: string
    readonly depth: number
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: string
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parentId: string
    readonly depth: number
  }

/** Status-only facts from one official JobRegistry snapshot (the roster
 * may include foreground shell work while it is still registered). */
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
  readonly descendants: readonly TaskSubagentEntry[]
  readonly jobs: readonly TaskJobEntry[]
}

/** Read the full descendant catalog and the root's status-only jobs. */
export interface TaskReader {
  /** Full descendant catalog (stable DFS pre-order) + the root session's
   * status-only job roster. */
  readDescendants(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<TaskReadSnapshot | undefined>
}
