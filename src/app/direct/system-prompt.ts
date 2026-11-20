/**
 * The Direct Host system-prompt installation owner (TS8-F3): the ONLY module
 * that composes `ctx.get('systemPrompt')` and registers the TUI-owned
 * system-prompt sections on the Direct branch. It installs every TUI-owned
 * communication section — progress updates, response style, git attribution
 * and Focus — reading the pure prompt text from `domain/communication/**` on
 * every assembly, so a live state change is seen by the next model step
 * without re-composition.
 *
 * M6 PR-C C2: the section names, orders, texts and the per-Turn policy live in
 * ONE shared neutral owner (`app/agent/prompt-sections.ts` +
 * `app/agent/turn-policy.ts`) that the Split Host installs through the same
 * functions, so Direct/Host assembled text cannot drift. This module keeps
 * ONLY the Direct-specific composition: the structural `ctx.get('systemPrompt')`
 * lookup, the graceful degradation diagnostics, and the per-section public
 * installers the existing tests and the public `composeAgent` surface use.
 *
 * Direct-only by construction (the `dsh-system-prompt` service lookup), so it
 * lives under `app/direct`. A missing service degrades gracefully: the Agent
 * still runs and the absence is recorded in diagnostics.
 *
 * @module @xmoon76/dsh-pi-tui/app/direct/system-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { DisplayState } from '../../domain/display/preset.ts'
import type {
  ProgressUpdatesState,
  ResponseStyleState,
} from '../../domain/communication/policy.ts'
import type { GitAttributionState } from '../../domain/communication/git-attribution.ts'
import {
  installFocusSection,
  installGitAttributionSection,
  installProgressUpdatesSection,
  installResponseStyleSection,
  liveDisplayTurnPolicy,
  type SystemPromptLike,
  type TuiPromptTurnPolicy,
} from '../agent/prompt-sections.ts'

export type { SystemPromptLike } from '../agent/prompt-sections.ts'

/** The live states one agent composition installs sections from. Every state
 * is caller-owned and read on every assembly (a provider, not a snapshot). */
export interface DirectSystemPromptSections {
  readonly displayState?: DisplayState
  readonly diag?: Diag
  readonly progressUpdatesState?: ProgressUpdatesState
  readonly responseStyleState?: ResponseStyleState
  readonly gitAttributionState?: GitAttributionState
  /**
   * The per-Turn policy. Absent = the pre-C2 live-display semantics: the
   * display state is evaluated live and every Turn is eligible (the public
   * `composeAgent` helper and the section unit tests). A Split/Direct Host
   * Agent supplies the frozen latch instead.
   */
  readonly turnPolicy?: TuiPromptTurnPolicy
}

/** Register the progress-updates section. Its effective text reads the live
 * display state too (Focus suppresses it) without mutating the saved cadence. */
export function installProgressUpdatesPrompt(
  systemPrompt: SystemPromptLike,
  displayState: DisplayState,
  state: ProgressUpdatesState,
): () => void {
  return installProgressUpdatesSection(systemPrompt, liveDisplayTurnPolicy(displayState), state)
}

/** Register the response-style section; each assembly reads the live state. */
export function installResponseStylePrompt(systemPrompt: SystemPromptLike, state: ResponseStyleState): () => void {
  return installResponseStyleSection(
    systemPrompt,
    { currentTurn: () => ({ eligible: true, focus: false }) },
    state,
  )
}

/** Register the git-attribution section (Agent guidance only: one prompt
 * section, no Git-level enforcement — the prompt-based migration plan). */
export function installGitAttributionPrompt(systemPrompt: SystemPromptLike, state: GitAttributionState): () => void {
  return installGitAttributionSection(
    systemPrompt,
    { currentTurn: () => ({ eligible: true, focus: false }) },
    state,
  )
}

/**
 * Register the Focus section (a provider, not a static snapshot). It is
 * deliberately NOT `complete` (it must never replace the harness
 * identity/persona/tool guidance) and NOT dynamic context: Focus is a stable
 * behavioral policy, not a runtime-context snapshot.
 */
export function installFocusPrompt(systemPrompt: SystemPromptLike, displayState: DisplayState): () => void {
  return installFocusSection(systemPrompt, liveDisplayTurnPolicy(displayState))
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
  const turn = sections.turnPolicy
  if (needsCommunication) {
    if (progressUpdatesState !== undefined && (turn !== undefined || displayState !== undefined)) {
      disposers.push(turn === undefined
        ? installProgressUpdatesPrompt(systemPrompt, displayState!, progressUpdatesState)
        : installProgressUpdatesSection(systemPrompt, turn, progressUpdatesState))
    } else if (progressUpdatesState !== undefined) {
      diag?.warn('progress updates prompt unavailable', { reason: 'display state missing' })
    }
    if (responseStyleState !== undefined) {
      disposers.push(turn === undefined
        ? installResponseStylePrompt(systemPrompt, responseStyleState)
        : installResponseStyleSection(systemPrompt, turn, responseStyleState))
    }
    if (gitAttributionState !== undefined) {
      disposers.push(turn === undefined
        ? installGitAttributionPrompt(systemPrompt, gitAttributionState)
        : installGitAttributionSection(systemPrompt, turn, gitAttributionState))
    }
  }
  if (displayState !== undefined) {
    try {
      disposers.push(turn === undefined
        ? installFocusPrompt(systemPrompt, displayState)
        : installFocusSection(systemPrompt, turn))
    } catch (error) {
      // A throwing registration must not kill the TUI (the section registry
      // rejects duplicate names — a collision from another layer).
      diag?.warn('focus prompt registration failed', { error })
    }
  }
  return disposers
}