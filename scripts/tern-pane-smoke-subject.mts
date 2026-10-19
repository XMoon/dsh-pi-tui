/**
 * The subject of the committed smoke flow: the smallest program that still
 * exercises the whole harness path — a real pane, a real button the SDK routes
 * clicks to, a key counter, and its own record of what actually arrived.
 *
 * It is launched by `tern-pane-smoke.mjs` through `harness.launch`, so it follows
 * the subject contract: read the run directory from `TERN_PANE_DIR`, record what
 * happened there (the flow reads it back as its positive control), and exit on
 * F10 so a run can shut its subject down.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-smoke-subject.mts
 * @module scripts/tern-pane-smoke-subject
 */
import { appendFileSync } from 'node:fs'
import { connect, html, ui, type TspEvent } from '@stencil-hq/tern'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

const session = await connect({ app: 'tern-pane-smoke', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'smoke' })

let clicks = 0
let keys = 0
function render(): void {
  surface.render({
    main: ui.col({ key: 'main' },
      ui.text('pane-smoke ready'),
      ui.text(`clicks=${clicks} keys=${keys}`),
      html.button({
        onClick: () => {
          clicks += 1
          note({ click: clicks })
          render()
        },
      }, 'Pick'),
    ),
  })
}

render()
note({ ready: true })

for await (const input of session) {
  if (input.type === 'key') {
    if (input.key.name === 'f10') break
    keys += 1
    note({ key: input.key.name })
    render()
    continue
  }
  const event = input.event as TspEvent
  if (event.ev === 'resize' && event.sf === surface.id) render()
}

note({ closed: true })
await surface.close({ keep: false })
await session.close()
