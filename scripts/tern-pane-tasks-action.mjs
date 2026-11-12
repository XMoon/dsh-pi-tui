/**
 * Mouse PR4 real-client evidence flow: the first-party Tasks status segment as
 * a clickable native control.
 *
 * One run = one case (the harness allows one subject per pane):
 *
 *   TERN_PANE_CASE=action node scripts/tern-pane-drive.mjs scripts/tern-pane-tasks-action.mjs
 *     The badge the production projection emits carries `.sf-act`; a REAL control
 *     click on its still-visible fragment reaches the ONE bound `/tasks` entry
 *     exactly once, and a click on an ADJACENT status-only segment reaches
 *     nothing (the negative control).
 *
 *   TERN_PANE_CASE=inert node scripts/tern-pane-drive.mjs scripts/tern-pane-tasks-action.mjs
 *     The SAME fixture with the entry unavailable: the identical badge paints
 *     without `.sf-act` and clicking its fragment opens nothing (A/B control).
 *
 * The flow records facts (boxes, clipping, classes, the subject's own record and
 * PNGs); it does not decide product acceptance.
 * @module scripts/tern-pane-tasks-action
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleBox } from './tern-pane-geometry.mjs'

const CASE = process.env.TERN_PANE_CASE ?? 'action'

/** Every `sf-seg` node of the real tree (the client's own class). */
const segNodes = (snap) => snap.nodes.filter((node) => String(node.class ?? '').split(/\s+/).includes('sf-seg'))

/** One seg's own painted text. */
const segText = (h, node) => h.descendantsText(node)

/** The attention badge among the painted segments (its `n/Nj` figure). */
const attentionBadge = (h, snap) => segNodes(snap)
  .find((node) => /^\s*\[.*j\]/.test(segText(h, node)) || segText(h, node).includes('/') && segText(h, node).includes('j'))

/** Every record the subject wrote, in order (its own positive control). */
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
  await h.resize(400, 600)
  const subject = join(h.repo, 'scripts', 'tern-pane-tasks-action-subject.mts')
  // The subject reads the case from the run directory (the launcher forwards no
  // environment): write it BEFORE the launch.
  writeFileSync(join(h.root, 'case'), CASE)

  const booted = await h.launch(subject, { ready: `tasks-action ${CASE}` })
  h.check(`the production renderer boots (${CASE})`, booted)

  const snap = h.snapshot()
  const painted = segNodes(snap).map((node) => `${String(node.class)}:${segText(h, node)}`).join(' | ')
  h.measure('painted segments', painted)
  const badge = attentionBadge(h, snap)
  h.check('the production projection painted the attention badge', badge !== undefined, painted)
  if (badge === undefined) return

  const classes = String(badge.class ?? '').split(/\s+/)
  const box = visibleBox(snap.chains, badge)
  h.measure('badge classes and visible fragment', JSON.stringify({ classes, box, text: segText(h, badge) }))
  h.check('the badge fragment survives clipping on both axes', box.span.x > 0 && box.span.y > 0,
    JSON.stringify(box))
  h.capture(`tasks-${CASE}-400x600`, `the ${CASE} badge before any click`)

  if (CASE === 'action') {
    h.check('the badge carries the native action affordance (.sf-act)', classes.includes('sf-act'),
      JSON.stringify({ classes, text: segText(h, badge) }))

    // The negative control: a real, ADJACENT status-only segment.
    const side = segNodes(snap).filter((node) => node !== badge && !String(node.class ?? '').includes('sf-act'))
    h.measure('adjacent status-only segments', JSON.stringify(side.map((node) => segText(h, node))))
    if (side[0] !== undefined) {
      const before = opens(h)
      const clickedInert = await h.click(snap.chains, side[0])
      h.check('a click on an adjacent status-only segment opens nothing', clickedInert && opens(h) === before,
        `clicked=${clickedInert} opens=${before}->${opens(h)}`)
    }

    const clicked = await h.click(snap.chains, badge)
    h.check('a REAL control click on the visible badge fragment reaches the ONE /tasks entry',
      clicked && opens(h) === 1, `clicked=${clicked} opens=${opens(h)}`)
    await h.sleep(250) // window: a duplicate dispatch would land here
    h.check('the click produced exactly ONE business open', opens(h) === 1, `opens=${opens(h)}`)
    h.capture('tasks-action-after-click', 'after one real control click')

    // Split-pane width: the same segment keeps its action while it survives.
    await h.resize(300, 600)
    await h.sleep(250)
    const narrowSnap = h.snapshot()
    const narrow = attentionBadge(h, narrowSnap)
    const narrowBox = narrow === undefined ? undefined : visibleBox(narrowSnap.chains, narrow)
    h.measure('split-pane badge', JSON.stringify(narrow === undefined
      ? { present: false }
      : { classes: String(narrow.class ?? ''), box: narrowBox }))
    h.capture('tasks-action-300x600', 'the split-pane layout')
    if (narrow !== undefined && narrowBox.span.x > 0 && narrowBox.span.y > 0) {
      const before = opens(h)
      const narrowClicked = await h.click(narrowSnap.chains, narrow)
      h.check('a click in the split pane still reaches the entry exactly once',
        narrowClicked && opens(h) === before + 1, `clicked=${narrowClicked} opens=${before}->${opens(h)}`)
    } else {
      h.measure('split-pane badge not fully reachable', 'recorded, never claimed as a pass')
    }

    // Narrow pane (the plan's 44-60 column band): record what the CLIENT really
    // did. A dropped or clipped badge is a measurement, never a claimed click.
    await h.resize(60, 600)
    await h.sleep(250)
    const narrowPx = h.snapshot()
    const tiny = attentionBadge(h, narrowPx)
    const tinyBox = tiny === undefined ? undefined : visibleBox(narrowPx.chains, tiny)
    h.measure('narrow pane badge', JSON.stringify(tiny === undefined
      ? { present: false, painted: segNodes(narrowPx).map((node) => segText(h, node)) }
      : { classes: String(tiny.class ?? ''), box: tinyBox }))
    h.capture('tasks-action-60x600', 'the narrow-pane layout')
    if (tiny !== undefined && tinyBox.span.x > 0 && tinyBox.span.y > 0) {
      const before = opens(h)
      const tinyClicked = await h.click(narrowPx.chains, tiny)
      h.check('a click in the narrow pane still reaches the entry exactly once',
        tinyClicked && opens(h) === before + 1, `clicked=${tinyClicked} opens=${before}->${opens(h)}`)
    }

    // Short window: the dock can be pushed below the fold. Record visibility.
    await h.resize(400, 240)
    await h.sleep(250)
    const shortPx = h.snapshot()
    const short = attentionBadge(h, shortPx)
    h.measure('short-window badge', JSON.stringify(short === undefined
      ? { present: false }
      : { classes: String(short.class ?? ''), box: visibleBox(shortPx.chains, short) }))
    h.capture('tasks-action-400x240', 'the short-window layout')
    return
  }

  // ── inert: the same fixture, no registered entry ────────────────────────
  h.check('without the entry the badge carries NO action affordance',
    !classes.includes('sf-act'), JSON.stringify({ classes, text: segText(h, badge) }))
  const before = opens(h)
  const clicked = await h.click(snap.chains, badge)
  h.check('clicking the inert badge opens nothing', clicked && opens(h) === before,
    `clicked=${clicked} opens=${before}->${opens(h)}`)
  await h.sleep(250)
  h.check('the inert badge stays a no-op after the frame settles', opens(h) === before, `opens=${opens(h)}`)
  h.capture('tasks-inert-after-click', 'the inert badge after a real click')
}
