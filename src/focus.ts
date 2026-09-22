/**
 * Focus Mode runtime state and the dynamic system-prompt policy.
 *
 * Focus Mode is a presentation + behavioral-policy feature: the session log
 * stays lossless and the TUI only PROJECTS turn-intermediate activity into a
 * live Thought block. This module reads the shared DisplayState for the
 * Focus behavioral policy; the projection itself lives in focus-activity.ts
 * and the TUI surface in tui-app.ts.
 *
 * The prompt section is installed once per composed agent through
 * {@link installFocusPrompt} and reads the shared state on every assembly,
 * so toggling Focus never re-composes the agent nor re-registers the section
 * — the next model step simply sees the new value.
 * @module @xmoon76/dsh-pi-tui/focus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from './diag.ts'
import { isFocusDisplayPreset, type DisplayState } from './display-preset.ts'

/** The system-prompt section name: TUI-private, never a host/preset name. */
export const FOCUS_SECTION_NAME = 'tui:focus-mode'

/** The section order: after the deployment persona/plan policy (0–50),
 * before the tool guidance band (100–199) — a stable behavioral policy. */
export const FOCUS_SECTION_ORDER = 90

/**
 * The model-facing Focus instruction (plan §4): the user only sees the final
 * text message of each response, so mid-turn narration is wasted and
 * everything the user needs must land in the final message. Questions and
 * background work are explicit exceptions to the old hidden-context assumption:
 * both need truthful, self-contained visible communication.
 */
export const FOCUS_MODE_PROMPT = `# Focus mode
The user has focus mode enabled. They only see your final text message in each response — not tool calls, tool results, or any text you write between tool calls. Intermediate assistant text is not visible. Put the information the user needs into the final visible message: the outcome, important findings, changes made, relevant decisions, and anything still pending. Summarize hidden work rather than replaying the full hidden process. Do not assume they saw earlier output.

When you need user input, approval, or a decision, assume the user did not see hidden reasoning, tool calls, tool results, or mid-turn narration. Make the question self-contained: state what input or decision is needed and include the minimum context required to answer it. Do not refer to hidden context with phrases such as "as above", "the issue I mentioned", "that plan", or "the previous result", and do not dump the full hidden process merely to reconstruct context.

Continue useful work while independent background work runs, and wait in the foreground only when the immediate next action depends on that result. Do not claim the user's requested work is fully complete while a required background result is unresolved. If the turn ends first, make the visible final text a checkpoint that states what remains pending and what has already been established; do not pretend the whole request is complete or promise that a later wake is guaranteed.`

/** The dsh-system-prompt service surface the focus section needs (structural
 * — the bundle never imports dsh-system-prompt as a dependency). */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

/**
 * Install the Focus prompt section on one agent scope, reading the shared
 * state at EVERY assembly (a provider, not a static snapshot). The section
 * is registered exactly once per composed agent; `/display` and `/focus`
 * mutate the shared DisplayState, so the next model step's system-prompt
 * assembly sees the new value without recreating the agent or the session.
 *
 * The section is deliberately NOT `complete` (it must never replace the
 * harness identity / persona / tool guidance) and is NOT dynamic context
 * (`systemPrompt.context`) — Focus is a stable behavioral policy, not a
 * runtime-context snapshot.
 *
 * A missing systemPrompt service degrades gracefully: the agent still runs
 * and the TUI projection still works; the absence is recorded in diagnostics.
 * @param agentCtx - the composed agent's scoped context.
 * @param displayState - the shared display state (the single source of truth).
 * @param diag - the diagnostics channel, when the caller has one.
 * @returns the exact Cordis effect disposer, when the service was available.
 */
export function installFocusPrompt(
  agentCtx: Context,
  displayState: DisplayState,
  diag?: Diag,
): (() => void) | undefined {
  const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt === undefined) {
    diag?.warn('focus prompt unavailable', { reason: 'systemPrompt service missing' })
    return undefined
  }
  try {
    return systemPrompt.section({
      name: FOCUS_SECTION_NAME,
      order: FOCUS_SECTION_ORDER,
      text: () => (isFocusDisplayPreset(displayState.preset) ? FOCUS_MODE_PROMPT : ''),
    })
  } catch (error) {
    // A throwing registration must not kill the TUI (the section registry
    // rejects duplicate names — a collision from another layer).
    diag?.warn('focus prompt registration failed', { error })
    return undefined
  }
}
