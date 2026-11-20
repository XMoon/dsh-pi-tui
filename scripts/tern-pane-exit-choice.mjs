/**
 * M6 UX PR1 real-client evidence flow: the production TSP Exit Choice as three
 * native buttons in a real Tern pane.
 *
 *   TERN_BIN=<tern> node scripts/tern-pane-drive.mjs scripts/tern-pane-exit-choice.mjs
 *
 * What only the real client can prove, and this lane proves:
 *  - the modal overlay, its title/risk copy and the three native `ui.button`
 *    actions are really painted and each fragment survives clipping;
 *  - ONE real control click on EACH current-epoch button reaches the ONE model
 *    callback exactly once, in order — including the NON-default Stop/Stay rows
 *    (a focus-then-confirm list would need a second click and is a FAIL);
 *  - the subject's own record is the positive control (a repaint alone is not
 *    a business selection).
 *
 * Artifacts stay in the run directory the driver creates; nothing is deleted.
 * @module scripts/tern-pane-exit-choice
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleBox } from './tern-pane-geometry.mjs'

function records(h) {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n')
      .filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const selections = (h) => records(h).filter((row) => row.selection !== undefined).map((row) => row.selection)

/** One painted native button whose own text contains `text`. */
const buttonWith = (h, snap, text) => snap.nodes.find((node) =>
  node.tag === 'button' && h.descendantsText(node).includes(text))

export default async function (h) {
  await h.resize(400, 600)
  const subject = join(h.repo, 'scripts', 'tern-pane-exit-choice-subject.mts')
  const booted = await h.launch(subject, { ready: 'Disconnect from dsh-pi-tui' })
  h.check('the production renderer boots with the Exit Choice in a real pane', booted)

  let snap = h.snapshot()
  h.check('the overlay title is painted', h.has(snap, 'Disconnect from dsh-pi-tui'), h.texts(snap).join(' | '))
  h.check('the risk line is painted', h.has(snap, 'The current session is still working.'), h.texts(snap).join(' | '))
  const buttons = snap.nodes.filter((node) => node.tag === 'button')
  h.measure('native button count and texts',
    JSON.stringify(buttons.map((node) => h.descendantsText(node))))
  const optionLabels = ['Keep working and disconnect', 'Stop current work and disconnect', 'Stay in the TUI']
  const paintedOptions = optionLabels.filter((text) => buttonWith(h, snap, text) !== undefined)
  h.check('all three option buttons are painted', paintedOptions.length === 3,
    `${paintedOptions.length}/3 :: ${JSON.stringify(buttons.map((node) => h.descendantsText(node)))}`)
  h.capture('exit-choice-open-400x600', 'the real Tern client paints the production Exit Choice')

  const expected = [
    ['Keep working and disconnect', 'keep-and-disconnect'],
    ['Stop current work and disconnect', 'stop-and-disconnect'],
    ['Stay in the TUI', 'stay'],
  ]
  for (const [text, option] of expected) {
    snap = h.snapshot()
    const button = buttonWith(h, snap, text)
    h.check(`the ${option} button is painted`, button !== undefined, h.texts(snap).join(' | '))
    if (button === undefined) return
    const box = visibleBox(snap.chains, button)
    h.measure(`${option} visible fragment`, JSON.stringify(box))
    h.check(`the ${option} button fragment survives clipping on both axes`,
      box.span.x > 0 && box.span.y > 0, JSON.stringify(box))
    const before = selections(h).length
    const clicked = await h.click(snap.chains, button)
    h.check(`ONE real click on ${option} reaches the ONE model callback`,
      clicked && selections(h).length === before + 1 && selections(h)[before] === option,
      `clicked=${clicked} selections=${JSON.stringify(selections(h))}`)
    h.capture(`exit-choice-${option}`, `after one real click on ${option}`)
    await h.sleep(400) // the subject reopens the next fresh overlay
  }

  h.check('all three real buttons selected exactly once, in order',
    JSON.stringify(selections(h)) === JSON.stringify(['keep-and-disconnect', 'stop-and-disconnect', 'stay']),
    JSON.stringify(selections(h)))
  h.check('the subject completed its three-choice sequence',
    records(h).some((row) => row.complete === true), JSON.stringify(records(h)))
}
