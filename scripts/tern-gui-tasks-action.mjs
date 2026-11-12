/**
 * Mouse PR4 REAL GUI evidence flow: the first-party Tasks status segment in a
 * real Tern WINDOW (native OS chrome, desktop font stack, control-injected
 * pointer).
 *
 *   TERN_PANE_CASE=action DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-tasks-action.mjs
 *   TERN_PANE_CASE=inert  DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-tasks-action.mjs
 *
 * It runs the SAME production subject as the headless lane
 * (`scripts/tern-pane-tasks-action-subject.mts` → the shipped
 * `mountTspRenderer`), so the UI under test is identical; only the client
 * presentation differs. It records:
 *
 *   - the real window and its clamped minimum size,
 *   - the badge's box and the client's own `.sf-act` hover affordance under a
 *     control-injected pointer move,
 *   - the live-window appearance switch (`plugins run appearance:dark`, ONCE)
 *     proved with `state.theme`, plus the light/dark PNGs,
 *   - a real control-injected click → exactly ONE business open, and an
 *     adjacent status-only segment → none,
 *   - the narrowest window the client allows and whether the badge survives it.
 *
 * Input stays CONTROL_INJECTED_INPUT; physical OS input and an OS screen reader
 * are NOT_VERIFIED here.
 * @module scripts/tern-gui-tasks-action
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleBox } from './tern-pane-geometry.mjs'

const CASE = process.env.TERN_PANE_CASE ?? 'action'

const segNodes = (snap) => snap.nodes.filter((node) => String(node.class ?? '').split(/\s+/).includes('sf-seg'))
const segText = (h, node) => h.descendantsText(node)
const attentionBadge = (h, snap) => segNodes(snap)
  .find((node) => segText(h, node).includes('/') && segText(h, node).includes('j'))

function records(h) {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n')
      .filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const opens = (h) => records(h).filter((row) => row.tasksOpen !== undefined).length

export default async function (h) {
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  const size = await h.resize(1280, 800)
  h.measure('window size', JSON.stringify(size))

  writeFileSync(join(h.root, 'case'), CASE)
  const booted = await h.launch(join(h.repo, 'scripts', 'tern-pane-tasks-action-subject.mts'),
    { ready: `tasks-action ${CASE}` })
  h.check(`the production subject boots in a real GUI pane (${CASE})`, booted)
  if (!booted) {
    h.measure('subject stderr', readFileSync(join(h.root, 'subject.err'), 'utf8').slice(0, 600))
    return
  }

  const snap = h.snapshot()
  const painted = segNodes(snap).map((node) => `${String(node.class)}:${segText(h, node)}`).join(' | ')
  h.measure('painted segments', painted)
  const badge = attentionBadge(h, snap)
  h.check('the real window painted the attention badge', badge !== undefined, painted)
  if (badge === undefined) return

  const classes = String(badge.class ?? '').split(/\s+/)
  const box = visibleBox(snap.chains, badge)
  h.measure('badge classes and visible fragment', JSON.stringify({ classes, box, text: segText(h, badge) }))
  h.check('the badge fragment is visible in the real window on both axes',
    box.span.x > 0 && box.span.y > 0, JSON.stringify(box))

  // HOVER: a control-injected pointer move on the real window.
  const hovered = await h.hover(snap.chains, badge)
  h.check('a control-injected pointer move really reaches the badge',
    hovered.moved === true, JSON.stringify({ hovered, classes }))
  const hoverSnap = h.snapshot()
  const hoveredBadge = attentionBadge(h, hoverSnap)
  h.measure('badge after hover', JSON.stringify({
    classes: String(hoveredBadge?.class ?? ''),
    text: hoveredBadge === undefined ? undefined : segText(h, hoveredBadge),
  }))
  h.capture(`tasks-gui-${CASE}-light`, `the ${CASE} badge after a real pointer move (light)`)

  // The live-window appearance switch: the KEY ACTION, sent ONCE.
  await h.send('plugins', 'run', 'appearance:dark')
  await h.sleep(500)
  const darkState = h.ctl('state')
  h.check('the live window switched to the dark appearance', darkState.theme === 'dark',
    JSON.stringify({ theme: darkState.theme }))
  h.capture(`tasks-gui-${CASE}-dark`, `the ${CASE} badge in the dark appearance`)
  await h.send('plugins', 'run', 'appearance:light')
  await h.sleep(500)
  h.check('the live window switched back to light', h.ctl('state').theme === 'light',
    JSON.stringify({ theme: h.ctl('state').theme }))

  if (CASE === 'action') {
    h.check('the badge carries the native action affordance (.sf-act)', classes.includes('sf-act'),
      JSON.stringify({ classes, text: segText(h, badge) }))

    // Negative control: an ADJACENT status-only segment.
    const side = segNodes(snap).filter((node) => node !== badge && !String(node.class ?? '').includes('sf-act'))
    h.measure('adjacent status-only segments', JSON.stringify(side.map((node) => segText(h, node))))
    if (side[0] !== undefined) {
      const before = opens(h)
      const clickedInert = await h.click(snap.chains, side[0])
      h.check('a real click on an adjacent status-only segment opens nothing',
        clickedInert && opens(h) === before, `clicked=${clickedInert} opens=${before}->${opens(h)}`)
    }

    const clicked = await h.click(snap.chains, badge)
    h.check('a REAL control-injected click on the badge opens the ONE /tasks entry',
      clicked && opens(h) === 1, `clicked=${clicked} opens=${opens(h)}`)
    await h.sleep(400) // window: a duplicate dispatch would land here
    h.check('the click produced exactly ONE business open', opens(h) === 1, `opens=${opens(h)}`)
    h.capture(`tasks-gui-${CASE}-after-click`, 'the real window after one control-injected click')

    // The narrowest window the client allows.
    const narrow = await h.resize(720, 600)
    h.measure('narrow window size', JSON.stringify(narrow))
    await h.sleep(300)
    const narrowSnap = h.snapshot()
    const narrowBadge = attentionBadge(h, narrowSnap)
    h.measure('narrow badge', JSON.stringify(narrowBadge === undefined
      ? { present: false }
      : { classes: String(narrowBadge.class ?? ''), box: visibleBox(narrowSnap.chains, narrowBadge) }))
    h.capture(`tasks-gui-${CASE}-narrow`, 'the narrowest real window')
    if (narrowBadge !== undefined) {
      const narrowBox = visibleBox(narrowSnap.chains, narrowBadge)
      if (narrowBox.span.x > 0 && narrowBox.span.y > 0) {
        const before = opens(h)
        const narrowClicked = await h.click(narrowSnap.chains, narrowBadge)
        h.check('a click in the narrow real window still reaches the entry exactly once',
          narrowClicked && opens(h) === before + 1, `clicked=${narrowClicked} opens=${before}->${opens(h)}`)
      }
    }
    return
  }

  // ── inert: the same fixture, no registered entry ────────────────────────
  h.check('without the entry the badge carries NO action affordance',
    !classes.includes('sf-act'), JSON.stringify({ classes, text: segText(h, badge) }))
  const before = opens(h)
  const clicked = await h.click(snap.chains, badge)
  h.check('a real click on the inert badge opens nothing', clicked && opens(h) === before,
    `clicked=${clicked} opens=${before}->${opens(h)}`)
  await h.sleep(400)
  h.check('the inert badge stays a no-op after the frame settles', opens(h) === before, `opens=${opens(h)}`)
  h.capture(`tasks-gui-${CASE}-after-click`, 'the inert badge after a real click')
}
