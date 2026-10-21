/**
 * Official Git attribution as an Agent PROMPT policy (issue #185).
 *
 * One dynamic system-prompt section instructs the composed Agent to add the
 * official dsh-pi-tui trailer when it creates Git commits. There is NO
 * Git-level enforcement: no hooks, no command detection, no repository
 * probing — the accepted tradeoff is prompt compliance over hard
 * enforcement (the prompt-based migration plan §0/§25).
 *
 * `product-model` uses DSH's own `{{provider}}`/`{{model}}` prompt
 * variables (owned by `installModelSelection()` per step), so a model
 * switch changes the NEXT assembly with no listener, cache, or
 * re-registration. The neutral domain owns the mode/parse policy and the pure
 * text; the section registration lives in `app/direct/system-prompt.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/communication/git-attribution
 */

export type GitAttributionMode = 'off' | 'product' | 'product-model'

export const DEFAULT_GIT_ATTRIBUTION_MODE: GitAttributionMode = 'off'

/** The system-prompt section name: TUI-private, never a host/preset name. */
export const GIT_ATTRIBUTION_SECTION_NAME = 'tui:git-attribution'

/** After tui:progress-updates (80) / tui:response-style (81), before
 * tui:focus-mode (90). */
export const GIT_ATTRIBUTION_SECTION_ORDER = 82

/** The official product identity (a product constant, never configurable). */
const PRODUCT_NAME = '@xmoon76/dsh-pi-tui'
const PRODUCT_EMAIL = 'dsh-pi-tui@xmoon.org'

export interface GitAttributionState {
  mode: GitAttributionMode
}

/** Settings values are untrusted; missing or invalid values stay Off. */
export function parseGitAttributionMode(value: unknown): GitAttributionMode {
  switch (value) {
    case 'off':
    case 'product':
    case 'product-model':
      return value
    default:
      return DEFAULT_GIT_ATTRIBUTION_MODE
  }
}

const attributionPrompts: Record<GitAttributionMode, string> = {
  off: '',
  product: `# Git attribution

When you create a Git commit for work performed through dsh-pi-tui, include the following Git trailer exactly once:

Co-Authored-By: ${PRODUCT_NAME} <${PRODUCT_EMAIL}>

Preserve existing commit trailers. When amending a commit that already contains this exact trailer, do not add a duplicate.`,
  'product-model': `# Git attribution

When you create a Git commit for work performed through dsh-pi-tui, include the following Git trailers exactly once:

Co-Authored-By: ${PRODUCT_NAME} <${PRODUCT_EMAIL}>
Assisted-By: {{provider}}/{{model}}

Preserve existing commit trailers. When amending a commit that already contains either exact trailer, do not add a duplicate.`,
}

/** The effective attribution section text for the live mode. */
export function gitAttributionPromptText(state: GitAttributionState): string {
  return attributionPrompts[state.mode]
}
