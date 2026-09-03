/**
 * Activity status derivation (plan §4.8): the run phase is a PURE derive
 * over the machine facts with a fixed precedence — waiting-approval >
 * waiting-question > applying-compaction > compacting > working > idle.
 * The footer never re-derives it. `busy` stays the machine-behavior fact
 * the Esc/cancel path reads; it is NOT the same as `phase`.
 * @module @xmoon76/dsh-pi-tui/status/derive-activity
 */

import type { ActivityStatus, RunPhase } from './types.ts'

/** The raw machine facts the phase derives from. */
export interface ActivityFacts {
  readonly working: boolean
  readonly compacting: boolean
  readonly applyingCompaction: boolean
  readonly approvalOpen: boolean
  readonly questionOpen: boolean
}

/** The fixed phase precedence (plan §4.8). */
export function deriveActivityPhase(facts: ActivityFacts): RunPhase {
  if (facts.approvalOpen) return 'waiting-approval'
  if (facts.questionOpen) return 'waiting-question'
  if (facts.applyingCompaction) return 'applying-compaction'
  if (facts.compacting) return 'compacting'
  if (facts.working) return 'working'
  return 'idle'
}

/** Assemble the full activity section from the machine facts. */
export function deriveActivityStatus(
  facts: ActivityFacts,
  busy: boolean,
  counts: {
    queuedCount: number
    taskCount: number
    childAgentCount: number
    taskTotalCount?: number
    childAgentTotalCount?: number
    failedTaskCount?: number
    todoCount: number
  },
): ActivityStatus {
  return {
    phase: deriveActivityPhase(facts),
    busy,
    queuedCount: counts.queuedCount,
    taskCount: counts.taskCount,
    childAgentCount: counts.childAgentCount,
    ...(counts.taskTotalCount === undefined ? {} : { taskTotalCount: counts.taskTotalCount }),
    ...(counts.childAgentTotalCount === undefined ? {} : { childAgentTotalCount: counts.childAgentTotalCount }),
    ...(counts.failedTaskCount === undefined ? {} : { failedTaskCount: counts.failedTaskCount }),
    todoCount: counts.todoCount,
  }
}
