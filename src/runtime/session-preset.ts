/**
 * Helpers for the persisted/session preset identity boundary.
 *
 * `code` is a valid DSH preset id. The session projection/history boundary
 * consumes the DSH V3 value as-is; only the omitted settings default retains a
 * narrow legacy fallback for older TUI configuration.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/session-preset
 */

/** The small roster resolver shape shared by Direct adapters. */
export interface PresetResolverLike<T extends { readonly id: string } = { readonly id: string }> {
  readonly defaultId?: string
  resolve(id?: string): Promise<T>
}

/** Identify DSH's stable unknown-id failure without importing its error class. */
function isUnknownPresetError(error: unknown, id: string): boolean {
  if (typeof error === 'object' && error !== null && (error as { presetId?: unknown }).presetId === id) return true
  return error instanceof Error && error.message.includes(`preset "${id}" not found`)
}

/**
 * Resolve a requested preset without confusing a persisted legacy default with
 * a real user preset. Explicit ids are always ordinary new input: an explicit
 * `code` is resolved as `code` and its unknown-id error is preserved. Only an
 * omitted default whose stored value is `code` gets the old-data fallback.
 */
export async function resolvePresetRequest<T extends { readonly id: string }>(
  presets: PresetResolverLike<T>,
  requestedId?: string,
): Promise<T> {
  if (requestedId !== undefined || presets.defaultId !== 'code') return presets.resolve(requestedId)
  try {
    return await presets.resolve('code')
  } catch (error) {
    if (!isUnknownPresetError(error, 'code')) throw error
    return presets.resolve('ptc')
  }
}
