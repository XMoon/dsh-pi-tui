/**
 * Model image-capability gating (plan M5, §12).
 *
 * The decision comes from the CURRENT live provider/model via
 * `ctx.llm.resolveModelInfo()` — never a cached agent-startup model, because
 * the TUI supports runtime model switching (/model). Semantics:
 * - `inputModalities` ABSENT (undefined): capability unknown — do NOT
 *   reject client-side; the harness admission remains the authority;
 * - explicitly present WITHOUT `'image'`: a declared text-only model —
 *   reject with an actionable error, never silently drop images (§12).
 * @module @xmoon76/dsh-pi-tui/image/capability
 */

import { ModelImageUnsupportedError } from './errors.ts'

/** Structural subset of `LlmResolvedModelInfo` (`@deepseek-ai/dsh-llm`). */
export interface ResolvedModelInfoLike {
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/** Structural subset of the `ctx.llm` service surface. */
export interface LlmLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfoLike>
}

/**
 * Whether a resolved model can accept image input: unknown metadata is
 * treated as capable (the harness still re-checks at admission).
 */
export function modelSupportsImages(info: ResolvedModelInfoLike): boolean {
  if (info.inputModalities === undefined) return true
  return info.inputModalities.includes('image')
}

/**
 * Gate one submission against the CURRENT model's image capability.
 * @param llm - the live `ctx.llm` service (structural).
 * @param provider - the current provider route id.
 * @param model - the current model id.
 * @throws ModelImageUnsupportedError for a declared text-only model;
 *   `resolveModelInfo` failures propagate (the submission path surfaces
 *   them as actionable notices).
 */
export async function assertModelSupportsImages(
  llm: LlmLike,
  provider: string,
  model: string,
): Promise<void> {
  const info = await llm.resolveModelInfo(provider, model)
  if (!modelSupportsImages(info)) {
    throw new ModelImageUnsupportedError(provider, model)
  }
}
