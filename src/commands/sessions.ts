/**
 * Session-domain command definitions and their shared Session Browser helpers
 * (populated by the sessions extraction; the coordinator owns registration).
 * @module @xmoon76/dsh-pi-tui/commands/sessions
 */

/** Shorten a session id for read-only display rows, capped at 28 characters. */
export function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}
