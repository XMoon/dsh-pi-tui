/** Model-facing communication policy, independent of transcript presentation.
 *
 * Two independent axes (the PR #166 follow-up split):
 * - `ProgressUpdates` owns the user-facing mid-turn update cadence;
 * - `ResponseStyle` owns the density / explanation depth of visible text.
 *
 * Neither axis is a display preset: `DisplayState` owns what the surface can
 * make visible, and the Focus preset suppresses the effective progress
 * section through the live provider without mutating the saved preference.
 * @module @xmoon76/dsh-pi-tui/communication-policy
 */

import { isFocusDisplayPreset, type DisplayState } from './display-preset.ts'
import type { SystemPromptLike } from './focus.ts'

export type ProgressUpdates = 'off' | 'milestones' | 'frequent'

export type ResponseStyle = 'default' | 'concise' | 'explanatory'

export const DEFAULT_PROGRESS_UPDATES: ProgressUpdates = 'milestones'

export const DEFAULT_RESPONSE_STYLE: ResponseStyle = 'default'

/** The system-prompt section names: TUI-private, never host/preset names. */
export const PROGRESS_UPDATES_SECTION_NAME = 'tui:progress-updates'
export const RESPONSE_STYLE_SECTION_NAME = 'tui:response-style'

/** The section orders: after the deployment persona/plan policy (0–50),
 * before the Focus section (90) and the tool guidance band (100–199). */
export const PROGRESS_UPDATES_SECTION_ORDER = 80
export const RESPONSE_STYLE_SECTION_ORDER = 81

export interface ProgressUpdatesState {
  mode: ProgressUpdates
}

export interface ResponseStyleState {
  style: ResponseStyle
}

/** Settings documents are untrusted; missing or invalid values use Milestones. */
export function parseProgressUpdates(value: unknown): ProgressUpdates {
  switch (value) {
    case 'off':
    case 'milestones':
    case 'frequent':
      return value
    default:
      return DEFAULT_PROGRESS_UPDATES
  }
}

/** Settings documents are untrusted; missing or invalid values use Default. */
export function parseResponseStyle(value: unknown): ResponseStyle {
  switch (value) {
    case 'default':
    case 'concise':
    case 'explanatory':
      return value
    default:
      return DEFAULT_RESPONSE_STYLE
  }
}

const progressPrompts: Record<ProgressUpdates, string> = {
  milestones: `# Progress updates: Milestones

Work quietly while a coherent phase is still in progress. Give a brief user-facing progress update only when a substantial phase has completed and the next phase is materially distinct, when the overall direction materially changes, or when required user input blocks further progress.

Do not report a partial finding merely because it was just discovered. If you are about to continue investigating the same question, continue working instead of reporting that partial conclusion.

Do not narrate individual tool calls, file reads, commands, or edits, and do not add a mandatory preamble before the first tool call.`,
  frequent: `# Progress updates: Frequent

For longer or multi-step work, keep the user actively informed with brief updates as meaningful findings become established and before moving into the next significant piece of work. An opening update is useful when the work will take multiple steps, but do not add one for a trivial action.

Group related actions together. Report what was established and what you are doing next; do not narrate individual tool calls, file reads, commands, or edits.`,
  off: `# Progress updates: Off

Do not provide progress narration while working. Continue through the task until you have a result to deliver, unless required user input or a blocker prevents further progress.

Do not add a preamble merely to announce upcoming tool use, and do not narrate individual tool calls, file reads, commands, or edits.`,
}

const responsePrompts: Record<ResponseStyle, string> = {
  default: '',
  concise: `# Response style: Concise

Keep user-visible responses compact and result-first. Avoid unnecessary preambles, restating the request, repeated conclusions, and nonessential explanation.

Preserve information needed for correctness, decisions, blockers, and user action. Give fuller detail when the user explicitly asks for it.`,
  explanatory: `# Response style: Explanatory

Explain relevant rationale, architecture, non-obvious behavior, and tradeoffs when they help the user understand the result or make a decision. When an alternative was materially relevant, explain why it was not chosen.

Prioritize explanations of why, constraints, and decisions over narration of the work performed. Do not add generic verbosity or turn the response into a syntax tutorial unless the user asks for one.`,
}

/** The Focus surface owns what can reach the user, so the progress section
 * reads BOTH live states: on Focus the effective progress text is empty
 * regardless of the saved cadence (which is never mutated). */
export function installProgressUpdatesPrompt(
  systemPrompt: SystemPromptLike,
  displayState: DisplayState,
  state: ProgressUpdatesState,
): () => void {
  return systemPrompt.section({
    name: PROGRESS_UPDATES_SECTION_NAME,
    order: PROGRESS_UPDATES_SECTION_ORDER,
    text: () => (isFocusDisplayPreset(displayState.preset) ? '' : progressPrompts[state.mode]),
  })
}

/** Register once per agent; each assembly reads the live, caller-owned state. */
export function installResponseStylePrompt(
  systemPrompt: SystemPromptLike,
  state: ResponseStyleState,
): () => void {
  return systemPrompt.section({
    name: RESPONSE_STYLE_SECTION_NAME,
    order: RESPONSE_STYLE_SECTION_ORDER,
    text: () => responsePrompts[state.style],
  })
}
