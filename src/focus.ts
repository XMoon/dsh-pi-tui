/**
 * Focus Mode runtime state and the dynamic system-prompt policy.
 *
 * Focus Mode is a presentation + behavioral-policy feature: the session log
 * stays lossless and the TUI only PROJECTS turn-intermediate activity into a
 * live Thought block. This module owns the ONE authoritative runtime state
 * (`FocusState.enabled`) and the prompt section text; the projection itself
 * lives in focus-activity.ts and the TUI surface in tui-app.ts.
 *
 * The prompt section is installed once per composed agent through
 * {@link installFocusPrompt} and reads the shared state on every assembly,
 * so toggling Focus never re-composes the agent nor re-registers the section
 * — the next model step simply sees the new value.
 * @module @xmoon76/dsh-pi-tui/focus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from './diag.ts'

/** The single authoritative Focus runtime state (plan §5). */
export interface FocusState {
  enabled: boolean
}

/** The system-prompt section name: TUI-private, never a host/preset name. */
export const FOCUS_SECTION_NAME = 'tui:focus-mode'

/** The section order: after the deployment persona/plan policy (0–50),
 * before the tool guidance band (100–199) — a stable behavioral policy. */
export const FOCUS_SECTION_ORDER = 90

/**
 * The model-facing Focus instruction (plan §4): the user only sees the final
 * text message of each response, so mid-turn narration is wasted and
 * everything the user needs must land in the final message.
 */
export const FOCUS_MODE_PROMPT = `# Focus mode
The user has focus mode enabled. They only see your final text message in each response — not tool calls, tool results, or any text you write between tool calls. Anything you say mid-turn is not seen, so don't narrate progress between tool calls. Put everything the user needs into your final message: what you investigated, what you found, what you changed, decisions you made, and what's next. Do not assume they saw earlier output.`

/**
 * Defensive normalization of the persisted `focusMode` value: anything that
 * is not exactly `'on'` restores to `'off'` (an invalid persisted value must
 * never crash the runner or flip Focus on).
 * @param value - the persisted settings value, undefined when absent.
 */
export function focusModeOf(value: string | undefined): 'on' | 'off' {
  return value === 'on' ? 'on' : 'off'
}

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
 * is registered exactly once per composed agent; `/focus on|off` only flips
 * `focusState.enabled`, so the next model step's system-prompt assembly sees
 * the new value without recreating the agent or the session.
 *
 * The section is deliberately NOT `complete` (it must never replace the
 * harness identity / persona / tool guidance) and is NOT dynamic context
 * (`systemPrompt.context`) — Focus is a stable behavioral policy, not a
 * runtime-context snapshot.
 *
 * A missing systemPrompt service degrades gracefully: the agent still runs
 * and the TUI projection still works; the absence is recorded in diagnostics.
 * @param agentCtx - the composed agent's scoped context.
 * @param focusState - the shared runtime state (the single source of truth).
 * @param diag - the diagnostics channel, when the caller has one.
 * @returns the exact Cordis effect disposer, when the service was available.
 */
export function installFocusPrompt(
  agentCtx: Context,
  focusState: FocusState,
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
      text: () => (focusState.enabled ? FOCUS_MODE_PROMPT : ''),
    })
  } catch (error) {
    // A throwing registration must not kill the TUI (the section registry
    // rejects duplicate names — a collision from another layer).
    diag?.warn('focus prompt registration failed', { error })
    return undefined
  }
}
