/**
 * Shared, TOTAL error-observation helpers for every async boundary in the
 * TUI: the owned/detached entries (`detached.ts`), the lifecycle roots
 * (startup, exit, flush), the per-task callbacks and the diagnostics
 * formatter. One implementation, one behavior — no drift between modules.
 *
 * CONTRACT (deliberately scoped, honestly worded): the SYNC boundary is
 * total — observing any legal JavaScript value (a Proxy with a throwing
 * `getPrototypeOf` trap, a throwing `message` getter, a throwing
 * `toString`/`Symbol.toPrimitive`) can never make THIS code throw or
 * reject; every observation is protected and every fallback is a fixed
 * constant that never touches the value again. What is NOT guaranteed: an
 * observer (getter/trap/coercion) that, WHILE being observed, spawns its
 * OWN detached async work (e.g. `void Promise.reject(...)` inside
 * `toString`) — that rejection belongs to the observer, not to this
 * boundary, and no synchronous try/catch can intercept it. Callers must
 * not describe this module as a strict "any legal value, zero side
 * effects" guarantee.
 * @module @xmoon76/dsh-pi-tui/error-boundary
 */

/**
 * Describe an arbitrary thrown value as a string WITHOUT ever throwing:
 * `instanceof`, property reads and coercion are all inside the protection,
 * the fallbacks are FIXED constants that never touch the value again, and
 * a hostile Proxy/getter/`Symbol.toPrimitive` yields a stable placeholder
 * instead of escaping. (Best-effort beyond the sync boundary — see the
 * module contract.)
 */
export function safeErrorMessage(value: unknown): string {
  try {
    if (value instanceof Error) {
      try {
        const message = (value as Error).message
        return typeof message === 'string' ? message : '<error with non-string message>'
      } catch {
        return '<error with unreadable message>'
      }
    }
    return String(value)
  } catch {
    return '<unprintable error>'
  }
}
