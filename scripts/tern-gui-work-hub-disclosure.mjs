/**
 * PR3 REAL GUI flow: the native Work Hub retained-Job disclosure in a real Tern
 * WINDOW (native chrome + desktop font stack), driven through the control
 * endpoint.
 *
 *   TERN_PANE_CASE=full DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-work-hub-disclosure.mjs
 *
 * It uses the SAME production subject as the headless lane
 * (`scripts/tern-pane-work-hub-disclosure-subject.mts`). Input is
 * CONTROL_INJECTED_INPUT: physical OS input, IME and the OS accessibility
 * bridge are NOT_VERIFIED here.
 * @module scripts/tern-gui-work-hub-disclosure
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleBox } from './tern-pane-geometry.mjs'

const CASE = process.env.TERN_PANE_CASE ?? 'full'
const buttons = (h, snap) => h.classNodes(snap, 'pk-btn')
const buttonText = (h, node) => h.descendantsText(node).trim()
const button = (h, snap, fragment) => buttons(h, snap).find((node) => buttonText(h, node).includes(fragment))
const rows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => !String(node.class ?? '').split(' ').includes('grp'))
const rowWithText = (h, snap, text) => rows(h, snap).find((node) => h.descendantsText(node).includes(text))
const span = (snap, node) => visibleBox(snap.chains, node).span
const contained = (snap, node) => node !== undefined && span(snap, node).x > 0 && span(snap, node).y > 0
const paintedBar = (h, snap) => buttons(h, snap).map((node) => `${buttonText(h, node)}@${JSON.stringify(span(snap, node))}`).join(' | ')
const records = (h) => {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function waitForButton(h, fragment) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const snap = h.snapshot()
    if (button(h, snap, fragment) !== undefined) return snap
    await h.sleep(200)
  }
  return undefined
}

export default async function (h) {
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  const size = await h.resize(1280, 800)
  h.measure('window size', JSON.stringify(size))
  writeFileSync(join(h.root, 'case'), CASE)
  const booted = await h.launch(join(h.repo, 'scripts', 'tern-pane-work-hub-disclosure-subject.mts'), { ready: 'Work Hub' })
  h.check(`the production Work Hub boots in the real GUI pane (${CASE})`, booted)
  if (!booted) {
    h.measure('subject stderr', readFileSync(join(h.root, 'subject.err'), 'utf8').slice(0, 600))
    return
  }

  let snap = h.snapshot()
  h.measure('painted action bar', paintedBar(h, snap))
  h.check('the real window paints Close + Show + View details', buttons(h, snap).length === 3
    && button(h, snap, 'Close') !== undefined && button(h, snap, 'Show') !== undefined
    && button(h, snap, 'View details') !== undefined, paintedBar(h, snap))
  h.check('all three actions are visible in the real window', buttons(h, snap).every((node) => contained(snap, node)),
    paintedBar(h, snap))
  const show = button(h, snap, 'Show')
  if (show !== undefined) {
    const hovered = await h.hover(snap.chains, show)
    h.measure('control-injected hover on the Show action', JSON.stringify(hovered))
  }
  h.capture(`work-hub-gui-${CASE}-light`, 'the real window in the light appearance')

  await h.send('plugins', 'run', 'appearance:dark')
  await h.sleep(500)
  h.check('the live window switched to the dark appearance', h.ctl('state').theme === 'dark',
    JSON.stringify({ theme: h.ctl('state').theme }))
  h.capture(`work-hub-gui-${CASE}-dark`, 'the real window in the dark appearance')
  await h.send('plugins', 'run', 'appearance:light')
  await h.sleep(500)
  h.check('the live window switched back to light', h.ctl('state').theme === 'light')

  // Keyboard Alt+J through the control-injected text path.
  h.send('type', '\u001bj')
  const altExpanded = await waitForButton(h, 'Hide')
  h.check('control-injected Alt+J expands the history in the real window', altExpanded !== undefined,
    paintedBar(h, altExpanded ?? h.snapshot()))
  h.send('type', '\u001bj')
  await waitForButton(h, 'Show')

  snap = h.snapshot()
  const showButton = button(h, snap, 'Show')
  if (showButton !== undefined) {
    const clicked = await h.click(snap.chains, showButton)
    const expanded = await waitForButton(h, 'Hide')
    h.check('a control-injected click on Show reveals the retained history', clicked && expanded !== undefined,
      JSON.stringify(records(h).slice(-6)))
    const first = rowWithText(h, expanded ?? h.snapshot(), 'bash · old lint')
    h.check('the first retained Job is visible in the real window', contained(expanded ?? h.snapshot(), first),
      JSON.stringify(first === undefined ? { present: false } : visibleBox((expanded ?? h.snapshot()).chains, first)))
    h.capture(`work-hub-gui-${CASE}-expanded`, 'the real window after Show')
  }
  const a11y = h.ctl('a11y')
  h.measure('client accessibility tree', JSON.stringify(a11y).slice(0, 400))
  h.check('the client accessibility tree exposes the native action bar', JSON.stringify(a11y).includes('Show')
    || JSON.stringify(a11y).includes('Hide'), JSON.stringify(a11y).slice(0, 400))

  const narrow = await h.resize(720, 600)
  h.measure('narrowest window size', JSON.stringify(narrow))
  await h.sleep(400)
  const narrowSnap = h.snapshot()
  h.measure('narrow-window action bar', paintedBar(h, narrowSnap))
  h.check('the narrowest real window still paints Close and the disclosure', button(h, narrowSnap, 'Close') !== undefined
    && button(h, narrowSnap, 'Hide') !== undefined, paintedBar(h, narrowSnap))
  h.capture(`work-hub-gui-${CASE}-narrow`, 'the narrowest real window')

  const close = button(h, h.snapshot(), 'Close')
  if (close !== undefined) {
    const closeSnap = h.snapshot()
    await h.click(closeSnap.chains, close)
    h.check('the native Close still dismisses the Hub in the real window',
      records(h).some((row) => row.retired !== undefined))
  }
}
