/**
 * The QUESTIONNAIRE example plugin (Phase 5, plan §6): a multi-step
 * interactive form built on the Phase-4 imperative UI broker — the real
 * consumer proving the broker (select/confirm/input/notify). It registers
 * a local `/questionnaire` command that runs the form through the
 * Advanced facade.
 *
 * Tier usage (plan §6): Advanced only — the broker reuses the Host's own
 * picker/question/notify infrastructure; the plugin never touches raw
 * terminal bytes or private TUI objects.
 *
 * This plugin consumes ONLY the public package exports — exactly like an
 * external package (the examples smoke gates it against the packed
 * tarball).
 * @module dsh-pi-example-questionnaire
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type PiTuiExtensionService,
  type TuiLocalCommandHandler,
} from '@xmoon76/dsh-pi-tui/extensions'
import { advanced } from '@xmoon76/dsh-pi-tui/extensions/advanced'

export const name = 'dsh-pi-example-questionnaire'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return
  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('advanced.ui.interactive')) return
  const ui = advanced(service)

  // The multi-step form (plan §6: select → free text → confirm → notify).
  const runQuestionnaire: TuiLocalCommandHandler = async () => {
    // Step 1: select the topic.
    const topic = await ui.ui.select({
      items: [
        { value: 'bug', label: 'Bug report', description: 'Something is broken' },
        { value: 'feature', label: 'Feature request', description: 'Something new' },
        { value: 'question', label: 'Question', description: 'Just asking' },
      ],
      header: 'What is this about?',
      enableSearch: true,
    })
    if (topic === undefined) return { kind: 'success', text: 'questionnaire cancelled' }

    // Step 2: free-text details.
    const details = await ui.ui.input({ question: 'Describe it in one line:' })
    if (details === undefined) return { kind: 'success', text: 'questionnaire cancelled' }

    // Step 3: confirm the submission.
    const confirmed = await ui.ui.confirm({
      question: `Submit ${topic} report?`,
      detail: details,
      approveLabel: 'Submit',
      rejectLabel: 'Keep editing',
    })
    if (!confirmed) return { kind: 'success', text: 'questionnaire cancelled' }

    // Step 4: notify the outcome.
    ui.ui.notify(`questionnaire submitted: ${topic} — ${details}`, { type: 'info' })
    return { kind: 'success', text: `submitted ${topic}: ${details}` }
  }

  service.registerCommand({
    id: 'example-questionnaire',
    name: 'questionnaire',
    description: 'Run the Phase-5 questionnaire example (imperative UI broker).',
    execution: 'local',
    handler: runQuestionnaire,
  })
}
