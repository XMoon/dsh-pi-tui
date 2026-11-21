/**
 * M6 UX PR1 real-client subject: the PRODUCTION TSP Exit Choice overlay.
 *
 * It mounts the shipped `mountTspRenderer`, binds the production input
 * contract, and opens the SAME `exitChoiceAsking('daemon-busy', ...)` model the
 * coordinator presents. Every painted node — the modal overlay, the row titles
 * and the three native `ui.button` actions — therefore comes from the
 * production `TspInteractionSeat`; the flow only drives real client input and
 * reads this subject's own record of the ONE selection callback.
 *
 * After each selection it reopens the same choice (three times) so the flow can
 * prove each real button on its own, including the one-click non-default path.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-exit-choice-subject.mts
 * @module scripts/tern-pane-exit-choice-subject
 */
import { appendFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { exitChoiceAsking, type ExitChoiceOption } from '../src/app/surface/exit-choice.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

const session = await connect({ app: 'exit-choice-evidence', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')

let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason })
    await renderer.dispose()
  })()
  return closing
}

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { void shutdown('exit-requested') },
})

renderer.bindInput({
  exit: () => { void shutdown('input-exit') },
  cancel: () => {},
  submit: () => {},
  steer: () => {},
  pasteMedia: () => {},
  pastedPath: () => {},
  admitPastedPathDelivery: () => true,
  shouldRememberInput: () => true,
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker: () => {},
  openModelQuick: () => {},
  openSessionBrowser: () => {},
  sessionBrowserAvailable: () => false,
  openTasksBrowserUi: () => {},
  tasksBrowserUiAvailable: () => false,
})

let selections = 0
function openChoice(): void {
  renderer.exitChoice.open(exitChoiceAsking('daemon-busy', (option: ExitChoiceOption) => {
    note({ selection: option, index: selections })
    selections += 1
    renderer.exitChoice.close()
    if (selections < 3) {
      // A fresh overlay identity/epoch for the next real click.
      setTimeout(openChoice, 250)
    } else {
      note({ complete: true })
    }
  }, () => {
    note({ dismissed: true })
    renderer.exitChoice.close()
  }))
}

openChoice()
note({ ready: true })

await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
