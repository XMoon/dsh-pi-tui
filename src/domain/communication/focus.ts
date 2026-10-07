/**
 * Focus Mode's model-facing behavioral policy (TS8-F3).
 *
 * Focus Mode is a presentation + behavioral-policy feature: the session log
 * stays lossless and the TUI only PROJECTS turn-intermediate activity into a
 * live Thought block. The neutral domain owns the section identity and the
 * pure prompt text; the projection itself lives in
 * `tui/transcript/focus-projection.ts`, the TUI surface in `tui-app.ts`, and
 * the section registration in `app/direct/system-prompt.ts`.
 *
 * The registering owner reads the shared state on EVERY assembly, so toggling
 * Focus never re-composes the agent nor re-registers the section — the next
 * model step simply sees the new value.
 * @module @xmoon76/dsh-pi-tui/domain/communication/focus
 */

import { isFocusDisplayPreset, type DisplayState } from '../display/preset.ts'

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
The user has focus mode enabled. They only see your final text message in each response — not tool calls, tool results, or any text you write between tool calls. Intermediate assistant text is not visible. Progress-only intermediate assistant messages cannot reach the user on this surface, so continue working instead of generating them. Put the information the user needs into the final visible message: the outcome, important findings, changes made, relevant decisions, and anything still pending. Summarize hidden work rather than replaying the full hidden process. Do not assume they saw earlier output.

When you need user input, approval, or a decision, assume the user did not see hidden reasoning, tool calls, tool results, or mid-turn narration. Make the question self-contained: state what input or decision is needed and include the minimum context required to answer it. Do not refer to hidden context with phrases such as "as above", "the issue I mentioned", "that plan", or "the previous result", and do not dump the full hidden process merely to reconstruct context.

Continue useful work while independent background work runs, and wait in the foreground only when the immediate next action depends on that result. Do not claim the user's requested work is fully complete while a required background result is unresolved. If the turn ends first, make the visible final text a checkpoint that states what remains pending and what has already been established; do not pretend the whole request is complete or promise that a later wake is guaranteed.`

/**
 * The effective Focus section text for the live display state: the instruction
 * only while the Focus preset is active, else empty. The section is stable
 * behavioral policy — never `complete`, never dynamic context.
 */
export function focusPromptText(displayState: DisplayState): string {
  return isFocusDisplayPreset(displayState.preset) ? FOCUS_MODE_PROMPT : ''
}
