/**
 * The goal badge fold (status derives): the active goal text a session log
 * implies, read structurally so no Host session type enters the presentation
 * layer.
 * @module @xmoon76/dsh-pi-tui/status/derive-goal
 */

/**
 * The active goal badge text from the session log, or undefined. The latest
 * `goal/change` wins; a clear or completed goal hides the badge.
 * @param events - the session log.
 * @returns e.g. `goal ● fix the build`, or undefined.
 */
export function foldGoal(events: readonly { readonly type: string; readonly data: unknown }[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'goal/change') continue
    // Structural read of the log's goal/change payload (never a Host type import).
    const data = event.data as {
      readonly operation: string
      readonly goal: { readonly phase: string; readonly objective: string }
    }
    if (data.operation === 'clear') return undefined
    const goal = data.goal
    if (goal.phase === 'complete') return undefined
    const mark = goal.phase === 'active' ? '●' : goal.phase === 'paused' ? '‖' : '◌'
    const objective = goal.objective.length > 24 ? `${goal.objective.slice(0, 24)}…` : goal.objective
    return `goal ${mark} ${objective}`
  }
  return undefined
}
