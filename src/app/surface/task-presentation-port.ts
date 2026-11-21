/**
 * The renderer-neutral Task Center PRESENTATION boundary (PR4 B3-A1).
 *
 * The Task Center's ONE business owner (`task-runtime.ts`) still decides what
 * is browsable: the catalog, the Job roster, the Question attention rows, the
 * refresh gate and the selection routing. This port only carries the
 * presentation SINK — the rows and chrome facts an already-owned snapshot has
 * to show. It is deliberately NOT a second capability truth: whether a
 * renderer presents a Task Center at all stays
 * `SurfaceDisplaySeam.supportsTaskCenter`.
 *
 * The PiTui implementation delegates to the mounted `TuiApp`; the TSP
 * implementation is the internal native Work Hub. No business write
 * (`readTask`, Job observation/Stop, subagent interrupt, Question answer) is
 * reachable through this port.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/task-presentation-port
 */

import type { TaskPanelItem } from './task-presentation.ts'
import type { TaskBrowserSummary } from './task-browser-runtime.ts'
import type { TeamBoardSnapshot } from '../../runtime/team-board-read-port.ts'

/** One read-only Team board member (Root + official subagent catalog rows). */
export interface TeamMemberPresentation {
  /** Stable row id (`member:<session id>`). */
  readonly value: string
  readonly id: string
  /** Durable member name: `lead` for the Root, else the official `path`
   *  (falling back to the child Session id when no complete path exists). */
  readonly name: string
  readonly activity: 'running' | 'inactive' | 'idle' | 'unknown'
  readonly kind: 'root' | 'subagent' | 'external'
  readonly depth: number
}

/**
 * The READ-ONLY Team page DTO. `snapshot` is the official `agentTeam`
 * projection read (tasks + enabled + failure/stale/unavailable cause);
 * `members` are the Root plus the already-read Subagent catalog rows. It is a
 * PRESENTATION fact only — no `onClaim`/`onStop`/`onAssign` exists.
 */
export interface TeamBrowserPresentation {
  readonly snapshot: TeamBoardSnapshot
  readonly members: readonly TeamMemberPresentation[]
}

/** A renderer-owned browser's PRESENTATIONAL handle; no business authority. */
export interface TaskBrowserPresentationHandle {
  close(): void
  setItems(items: readonly TaskPanelItem[], preferredValue?: string): void
  setRefreshState(state: 'loading' | 'ready' | 'stale', error?: string): void
  /** Replace the Team page DTO (PiTui only). `undefined` REVOKES the Team page
   *  (Root eligibility went unknown → not-root), returning the browser to
   *  Work-only. Optional so the TSP Work Hub handle need not implement it. */
  setTeamPage?(value: TeamBrowserPresentation | undefined): void
}

/** The already-decided opening facts of one Task Browser presentation. */
export interface TaskBrowserPresentationOpen {
  readonly header: string
  readonly mode: 'full'
  readonly openedFrom: 'command'
  readonly scope: 'all'
  readonly enableSearch: true
  readonly expandedIds: readonly string[]
  readonly collapsedIds: readonly string[]
  readonly preferredValue?: string
  readonly maxVisible: number
  readonly loading: boolean
  readonly groupLabels: true
  readonly onRefresh: () => void
  readonly onStop: (value: string) => void
  readonly onViewportExpose: (ids: readonly string[]) => void
  readonly onRetired: (reason: string) => void
  /** FR2: the READ-ONLY Team page DTO. Absent = Work-only (a Child, a
   * Workflow-scoped browser, a TSP Work Hub, or no Team board source). */
  readonly team?: TeamBrowserPresentation
  /** FR2: the physical pointer final admission for the tab/filter/Team page:
   *  the runtime synchronously confirms the captured subject / browser token /
   *  non-cleanup state. Absent = pointer admission is refused. */
  readonly interactionCurrent?: () => boolean
}

export interface TaskAgentBadge {
  readonly id: string
  readonly label: string
  readonly activity: 'running'
}

export interface TaskJobBadge {
  readonly id: string
  readonly label: string
  readonly status: string
  readonly kind: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/**
 * The ONE Task Center presentation sink. Every member commits a fact the Task
 * Runtime already derived; none of them reads a source, lists a catalog or
 * owns a lifecycle.
 */
export interface TaskCenterPresentationPort {
  openBrowser(
    items: readonly TaskPanelItem[],
    onSelect: (value: string) => 'close' | 'keep-open',
    onClose: () => void,
    options: TaskBrowserPresentationOpen,
  ): TaskBrowserPresentationHandle
  setQuickTaskItems(items: readonly TaskPanelItem[]): void
  setAgents(agents: readonly TaskAgentBadge[]): void
  setTasks(jobs: readonly TaskJobBadge[]): void
  setQuestionAttention(count: number): void
  setTaskSummary(summary: TaskBrowserSummary): void
}
