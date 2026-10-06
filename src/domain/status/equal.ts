/**
 * Structural equality for status sections (plain JSON-safe data). The
 * projection callers AND the store itself use it: the runner's derives and
 * the app's projections mint fresh objects on every call, so a
 * same-value refresh must never churn the store's revision, notify
 * listeners, or wake the command runner's refresh.
 * @module @xmoon76/dsh-pi-tui/status/equal
 */

/** Whether two plain-data values are deeply equal (undefined-safe). */
export function plainSectionEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!plainSectionEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}
