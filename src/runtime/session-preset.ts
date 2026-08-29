/**
 * Helpers for the persisted/session preset identity boundary.
 *
 * `code` is a valid DSH preset id. The old pi-tui line also used it for the
 * preset now named `ptc`, so the read boundary may translate it only after the
 * current roster has established that no real `code` preset exists. The pure
 * normalizer preserves the value without a roster; the persisted resume
 * resolver drops an unresolved `code` when it has no roster capability.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/session-preset
 */

/**
 * Normalize one persisted/session identity against the currently visible
 * roster. A real `code` entry wins; only a roster that proves `code` absent can
 * apply the old pi-tui `code` → `ptc` compatibility mapping. New inputs and
 * writes must never call this helper.
 */
export function normalizePersistedSessionPresetId(
  value: string | null | undefined,
  availablePresetIds?: readonly string[],
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (value !== 'code' || availablePresetIds === undefined) return value
  if (availablePresetIds.includes('code')) return 'code'
  return availablePresetIds.includes('ptc') ? 'ptc' : undefined
}

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

async function resolveLegacyPtc(presets: PresetResolverLike): Promise<string | undefined> {
  try {
    return (await presets.resolve('ptc')).id
  } catch (error) {
    if (isUnknownPresetError(error, 'ptc')) return undefined
    throw error
  }
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

/**
 * Resolve one projection/header value for a cold persisted session. A batch
 * caller should supply `availablePresetIds` so every row shares one roster
 * read; a single-session caller may omit it and probe the live resolver once.
 * An absent resolver cannot prove that `code` is a valid custom preset, so the
 * value is omitted rather than returned as a resumable identity.
 */
export async function resolvePersistedSessionPresetId(
  value: string | undefined,
  availablePresetIds: readonly string[] | undefined,
  presets: PresetResolverLike | undefined,
): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (value !== 'code') return value
  if (availablePresetIds !== undefined) return normalizePersistedSessionPresetId(value, availablePresetIds)
  if (presets === undefined) return undefined
  try {
    return (await presets.resolve('code')).id
  } catch (error) {
    if (!isUnknownPresetError(error, 'code')) throw error
    return resolveLegacyPtc(presets)
  }
}
