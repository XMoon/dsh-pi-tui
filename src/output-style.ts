/** Model-facing communication policy, independent of transcript presentation. */
import type { SystemPromptLike } from './focus.ts'

export type OutputStyle = 'none' | 'checkpoint' | 'concise' | 'explanatory'

export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'checkpoint'

export interface OutputStyleState {
  style: OutputStyle
}

/** Settings documents are untrusted; missing or invalid values use Checkpoint. */
export function parseOutputStyle(value: unknown): OutputStyle {
  switch (value) {
    case 'none':
    case 'checkpoint':
    case 'concise':
    case 'explanatory':
      return value
    default:
      return DEFAULT_OUTPUT_STYLE
  }
}

const prompts: Record<OutputStyle, string> = {
  none: '',
  checkpoint: `# Output style: Checkpoint
Keep the user oriented with brief updates at meaningful milestones: an important finding is established, a meaningful phase completes, the direction materially changes, or a blocker or required user action appears. Do not narrate individual tool calls, file reads, commands, or edits, and do not add a mandatory sentence before the first tool call. Organize the outcome around established results and anything still pending. Follow the active surface's visibility rules; when intermediate text is hidden, put the user-needed checkpoint information in the final visible response.`,
  concise: `# Output style: Concise
Lead with the result, without a preamble or restating the request. Stay mostly silent during work, but surface blockers, required user action, and material facts. Keep narration minimal, not the thoroughness of the work. Never hide errors, warnings, or information needed for correctness. Provide full detail when the user explicitly requests it.`,
  explanatory: `# Output style: Explanatory
Explain important rationale and tradeoffs when useful: architecture, non-obvious behavior, design decisions, and why a relevant alternative was rejected. Put explanations where the user can see them under the active surface's visibility rules. Do not turn this into per-tool narration, a syntax tutorial, or generic verbosity.`,
}

/** Register once per agent; each assembly reads the live, caller-owned state. */
export function installOutputStylePrompt(systemPrompt: SystemPromptLike, state: OutputStyleState): () => void {
  return systemPrompt.section({
    name: 'tui:output-style',
    order: 80,
    text: () => prompts[state.style],
  })
}
