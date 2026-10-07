/**
 * Neutral display-preset vocabulary, persisted-state resolution and
 * availability (TS8-D split from the legacy root `src/display-preset.ts`).
 *
 * DisplayPreset is the one runtime vocabulary for presentation state. Every
 * preset whose projection exists in this build is available; the availability
 * gate exists so a future preset can never be claimed by another preset's
 * renderer before its own projection ships.
 *
 * The transcript materialization DISCLOSURE policy is terminal presentation
 * and lives in `src/tui/transcript/display-policy.ts` — this module owns no
 * renderer mechanics.
 * @module @xmoon76/dsh-pi-tui/domain/display/preset
 */

/** The complete display vocabulary. */
export type DisplayPreset = 'focus' | 'compact' | 'full'

/** The shared mutable display authority passed between the runner, prompt and UI. */
export interface DisplayState {
  preset: DisplayPreset
}

/** The outcome of attempting to apply one display preset to a surface. */
export type DisplayPresetApplyResult =
  | { readonly kind: 'applied'; readonly preset: DisplayPreset }
  | { readonly kind: 'unchanged'; readonly preset: DisplayPreset }
  | { readonly kind: 'unsupported'; readonly preset: DisplayPreset }

/** The persisted fields used by the one-time legacy migration. */
export interface PersistedDisplayInput {
  readonly displayPreset?: string
  readonly focusMode?: string
}

export type DisplayPresetResolutionSource =
  | 'canonical'
  | 'legacy-focus'
  | 'legacy-full'
  | 'invalid-canonical'

/** The resolved runtime preset and whether the canonical field needs writing. */
export interface DisplayPresetResolution {
  readonly preset: DisplayPreset
  readonly canonicalize: boolean
  readonly source: DisplayPresetResolutionSource
}

/** Whether a value is one of the complete display preset names. */
export function isDisplayPreset(value: unknown): value is DisplayPreset {
  return value === 'focus' || value === 'compact' || value === 'full'
}

/** Every preset whose projection exists in this build ships as available. */
export function isDisplayPresetAvailable(preset: DisplayPreset): boolean {
  return preset === 'focus' || preset === 'compact' || preset === 'full'
}

/** Whether a preset enables the model-facing Focus behavioral policy. The
 * neutral behavioral answer is exactly the preset identity — it must never
 * depend on the terminal disclosure policy. */
export function isFocusDisplayPreset(preset: DisplayPreset): boolean {
  return preset === 'focus'
}

/**
 * Resolve the canonical field before the legacy Focus field. Every recognized
 * preset (Compact included) is canonical as of PR3 and is never rewritten; an
 * unrecognized value falls back to Full.
 */
export function resolveDisplayPreset(input: PersistedDisplayInput): DisplayPresetResolution {
  if (input.displayPreset !== undefined) {
    if (isDisplayPreset(input.displayPreset)) {
      return { preset: input.displayPreset, canonicalize: false, source: 'canonical' }
    }
    return { preset: 'full', canonicalize: true, source: 'invalid-canonical' }
  }
  if (input.focusMode === 'on') {
    return { preset: 'focus', canonicalize: true, source: 'legacy-focus' }
  }
  return { preset: 'full', canonicalize: true, source: 'legacy-full' }
}
