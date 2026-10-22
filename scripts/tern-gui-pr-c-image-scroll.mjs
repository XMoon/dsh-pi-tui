/**
 * The PR-C real-GUI OVERFLOW flow: what happens to a tool-result image in a
 * LONG transcript?
 *
 * The client virtualizes a long surface and shows its TAIL, so an image at the
 * top of a long transcript is out of view. The flow measures that half with
 * the client's own tree, and it DELIVERS the official SDK scroll op so the
 * other half is measured rather than assumed:
 *
 * - the image at the top is NOT in the client's tree while the tail is shown
 *   (the overflow fact);
 * - the official `scroll` op is delivered (the subject records the node it
 *   named) and the client's virtualized view is read back afterwards.
 *
 * The reachability of an EARLY image by scrolling back is the CLIENT's pane
 * scrollback (its wheel/scrollbar), and this lane's control commands do not
 * drive that path: the measured result of the official scroll op is reported
 * as a MEASUREMENT, and the reachability stays NOT_VERIFIED in the PR record
 * rather than being claimed here.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-pr-c-image-scroll.mjs
 *
 * A REAL WINDOW HAS A MINIMUM SIZE, so the flow uses a short but legal window;
 * the 400px pane of the headless lane is a headless question.
 * @module scripts/tern-gui-pr-c-image-scroll
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect } from './tern-pane-geometry.mjs'

/** The subject's own record (the positive control for the delivered input). */
function recorded(root) {
  return readFileSync(join(root, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export default async function (h) {
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  // A SHORT window: the overflow case is about a long transcript in a short
  // pane, not about a narrow one (the client clamps the width anyway).
  const size = await h.resize(900, 420)
  h.measure('the window size', JSON.stringify(size))

  const subject = join(h.repo, 'scripts', 'tern-gui-pr-c-image-scroll-subject.mts')
  const booted = await h.launch(subject, { ready: 'filler row 199' })
  h.check('the long transcript is painted inside a real Tern GUI pane', booted)
  if (!booted) {
    h.measure('the subject stderr', 'the subject did not paint')
    return
  }

  const tail = h.snapshot()
  h.check('the client shows the TAIL of the long transcript',
    h.has(tail, 'filler row 199'),
    h.texts(tail).slice(0, 2).join(' | '))
  h.check('the image at the top is NOT on screen (the client virtualizes the long surface)',
    tail.nodes.every((node) => node.tag !== 'img'),
    JSON.stringify(tail.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  h.capture('prc-gui-image-long-tail', 'the long transcript showing its tail; the image row is virtualized away')

  // The OFFICIAL scroll op, aimed at a node the client really knows.
  await h.key('a', 1200)
  const rows = recorded(h.root)
  const scrolled = rows.find((row) => row.scrolled === 'start')
  h.check('the official scroll op was DELIVERED to the client', scrolled !== undefined,
    JSON.stringify(rows))
  h.measure('the node the scroll op named', JSON.stringify(scrolled?.target ?? null))

  const after = h.snapshot()
  h.measure('the client view after the scroll op', JSON.stringify({
    imageOnScreen: after.nodes.some((node) => node.tag === 'img'),
    stillTheTail: h.has(after, 'filler row 199'),
  }))
  const image = after.nodes.find((node) => node.tag === 'img')
  if (image !== undefined) h.measure('the image box after the scroll op', JSON.stringify(rect(image)))
  h.capture('prc-gui-image-long-after-scroll', 'the client view after the official scroll op was delivered')
}
