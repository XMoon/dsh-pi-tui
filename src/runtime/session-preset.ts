/**
 * Canonicalize the one legacy persisted preset value that crossed the DSH
 * 0.1.2 restore boundary. This helper is deliberately pure: preset
 * registration and session projection ownership remain in their Direct
 * adapters, while callers that only handle persisted values can share the
 * narrow normalization rule without importing Host services.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/session-preset
 */

/**
 * Normalize only a persisted/session identity read. New writes must receive
 * the canonical `ptc` id from the caller and must never use this as a preset
 * registration or a second composition definition.
 */
export function normalizePersistedSessionPresetId(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  return value === 'code' ? 'ptc' : value
}
