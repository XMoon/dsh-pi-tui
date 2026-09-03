/**
 * The runner's PERMISSION projection decision (review round 21/22): the
 * permission sent to the app must be EXPLICITLY undefined when the
 * permission-preset service or the live agent is unavailable — an
 * omitted field would keep the stale value in the legacy merge and
 * publish a stale permission to the extension snapshot. Pure module so
 * the runner-level regression is testable without importing the bundle
 * entry.
 * @module @xmoon76/dsh-pi-tui/status/derive-permission
 */

/** The permission-preset service surface (structural; alpha.4's
 * `current(session)` reads the session's own knob state). */
export interface PermissionServiceLike {
  current(session: unknown): string | undefined
}

/** The live agent's session surface (structural; the session object itself
 * is opaque here — the service owns how it reads it). */
export interface AgentSessionLike {
  session: unknown
}

/**
 * The permission value to pass as setStatus' permission field.
 * @param permission - the permission-preset service (undefined when absent).
 * @param agent - the live agent (undefined when absent).
 * @returns the current preset, or undefined (the clear signal).
 */
export function deriveRunnerPermission(
  permission: PermissionServiceLike | undefined,
  agent: AgentSessionLike | undefined,
): string | undefined {
  if (permission === undefined || agent === undefined) return undefined
  try {
    return permission.current(agent.session)
  } catch {
    // A throwing permission service must DEGRADE (undefined = clear the
    // stale fact), never interrupt the status refresh.
    return undefined
  }
}
