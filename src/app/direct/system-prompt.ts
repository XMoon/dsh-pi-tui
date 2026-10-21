/**
 * The Direct Host system-prompt installation owner (TS8-F3): the ONLY module
 * that composes `ctx.get('systemPrompt')` and registers the TUI-owned
 * system-prompt sections. It installs every TUI-owned communication section —
 * progress updates, response style, git attribution and Focus — reading the
 * pure prompt text from `domain/communication/**` on every assembly, so a live
 * state change is seen by the next model step without re-composition.
 *
 * Direct-only by construction (the `dsh-system-prompt` service lookup), so it
 * lives under `app/direct`. A missing service degrades gracefully: the Agent
 * still runs and the absence is recorded in diagnostics. The section registry
 * owns the returned disposers' lifetime with the agent scope (as before);
 * registration failures on the Focus section are contained and recorded.
 * @module @xmoon76/dsh-pi-tui/app/direct/system-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { DisplayState } from '../../domain/display/preset.ts'
import {
  PROGRESS_UPDATES_SECTION_NAME,
  PROGRESS_UPDATES_SECTION_ORDER,
  RESPONSE_STYLE_SECTION_NAME,
  RESPONSE_STYLE_SECTION_ORDER,
  progressUpdatesPromptText,
  responseStylePromptText,
  type ProgressUpdatesState,
  type ResponseStyleState,
} from '../../domain/communication/policy.ts'
import { FOCUS_SECTION_NAME, FOCUS_SECTION_ORDER, focusPromptText } from '../../domain/communication/focus.ts'
import {
  GIT_ATTRIBUTION_SECTION_NAME,
  GIT_ATTRIBUTION_SECTION_ORDER,
  gitAttributionPromptText,
  type GitAttributionState,
} from '../../domain/communication/git-attribution.ts'

/** The dsh-system-prompt service surface the sections need (structural — the
 * bundle never imports dsh-system-prompt as a dependency). */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

/** The live states one agent composition installs sections from. Every state
 * is caller-owned and read on every assembly (a provider, not a snapshot). */
export interface DirectSystemPromptSections {
  readonly displayState?: DisplayState
  readonly diag?: Diag
  readonly progressUpdatesState?: ProgressUpdatesState
  readonly responseStyleState?: ResponseStyleState
  readonly gitAttributionState?: GitAttributionState
}

/** Register the progress-updates section. Its effective text reads the live
 * display state too (Focus suppresses it) without mutating the saved cadence. */
export function installProgressUpdatesPrompt(
  systemPrompt: SystemPromptLike,
  displayState: DisplayState,
  state: ProgressUpdatesState,
): () => void {
  return systemPrompt.section({
    name: PROGRESS_UPDATES_SECTION_NAME,
    order: PROGRESS_UPDATES_SECTION_ORDER,
    text: () => progressUpdatesPromptText(displayState, state),
  })
}

/** Register the response-style section; each assembly reads the live state. */
export function installResponseStylePrompt(systemPrompt: SystemPromptLike, state: ResponseStyleState): () => void {
  return systemPrompt.section({
    name: RESPONSE_STYLE_SECTION_NAME,
    order: RESPONSE_STYLE_SECTION_ORDER,
    text: () => responseStylePromptText(state),
  })
}

/** Register the git-attribution section (Agent guidance only: one prompt
 * section, no Git-level enforcement — the prompt-based migration plan). */
export function installGitAttributionPrompt(systemPrompt: SystemPromptLike, state: GitAttributionState): () => void {
  return systemPrompt.section({
    name: GIT_ATTRIBUTION_SECTION_NAME,
    order: GIT_ATTRIBUTION_SECTION_ORDER,
    text: () => gitAttributionPromptText(state),
  })
}

/**
 * Register the Focus section (a provider, not a static snapshot). It is
 * deliberately NOT `complete` (it must never replace the harness
 * identity/persona/tool guidance) and NOT dynamic context: Focus is a stable
 * behavioral policy, not a runtime-context snapshot.
 */
export function installFocusPrompt(systemPrompt: SystemPromptLike, displayState: DisplayState): () => void {
  return systemPrompt.section({
    name: FOCUS_SECTION_NAME,
    order: FOCUS_SECTION_ORDER,
    text: () => focusPromptText(displayState),
  })
}

/**
 * Install the TUI-owned system-prompt sections on one agent scope. The
 * systemPrompt service is resolved ONCE per composition; each registered
 * section's `text` provider reads the live state at every assembly. When
 * nothing is configured, no service read happens at all (no spurious
 * diagnostic).
 * @param agentCtx - the composed agent's scoped context.
 * @param sections - the caller-owned live states.
 * @returns the registration disposers in registration order (the agent scope
 * owns their lifetime; a caller that ignores them keeps the previous
 * agent-scoped behavior).
 */
export function installDirectTuiSystemPromptSections(agentCtx: Context, sections: DirectSystemPromptSections): readonly (() => void)[] {
  const disposers: (() => void)[] = []
  const { displayState, diag, progressUpdatesState, responseStyleState, gitAttributionState } = sections
  const needsCommunication = progressUpdatesState !== undefined
    || responseStyleState !== undefined
    || gitAttributionState !== undefined
  if (!needsCommunication && displayState === undefined) return disposers
  const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt === undefined) {
    if (needsCommunication) diag?.warn('communication policy prompt unavailable', { reason: 'systemPrompt service missing' })
    if (displayState !== undefined) diag?.warn('focus prompt unavailable', { reason: 'systemPrompt service missing' })
    return disposers
  }
  if (needsCommunication) {
    if (progressUpdatesState !== undefined && displayState !== undefined) {
      disposers.push(installProgressUpdatesPrompt(systemPrompt, displayState, progressUpdatesState))
    } else if (progressUpdatesState !== undefined) {
      diag?.warn('progress updates prompt unavailable', { reason: 'display state missing' })
    }
    if (responseStyleState !== undefined) disposers.push(installResponseStylePrompt(systemPrompt, responseStyleState))
    if (gitAttributionState !== undefined) disposers.push(installGitAttributionPrompt(systemPrompt, gitAttributionState))
  }
  if (displayState !== undefined) {
    try {
      disposers.push(installFocusPrompt(systemPrompt, displayState))
    } catch (error) {
      // A throwing registration must not kill the TUI (the section registry
      // rejects duplicate names — a collision from another layer).
      diag?.warn('focus prompt registration failed', { error })
    }
  }
  return disposers
}
