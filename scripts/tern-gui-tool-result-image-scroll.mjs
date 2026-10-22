/**
 * The real-GUI lane for a LONG tool-result transcript: is the image REACHABLE in a
 * LONG transcript?
 *
 * The client virtualizes a long surface and shows its TAIL, so an image at the
 * top of a long transcript is out of view. This lane proves both halves with
 * the CLIENT'S OWN paths, in a real window:
 *
 * - the OVERFLOW half: the image at the top is NOT in the client's tree while
 *   the tail is shown (the client virtualizes the long surface);
 * - the REACHABILITY half: the client's own find-in-scrollback (the same path
 *   a user's Ctrl+F takes) scrolls the viewport back to the early row, and the
 *   image IS on screen again.
 *
 * The OFFICIAL SDK scroll op is measured, not claimed: the subject records
 * that it INVOKED the op (that is an invocation, never a client receipt), and
 * the client's response to it is read back afterwards.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-tool-result-image-scroll.mjs
 *
 * A REAL WINDOW HAS A MINIMUM SIZE, so the flow uses a short but legal window;
 * the 400px pane of the headless lane is a headless question.
 * @module scripts/tern-gui-tool-result-image-scroll
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

  const subject = join(h.repo, 'scripts', 'tern-gui-tool-result-image-scroll-subject.mts')
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

  // The OFFICIAL SDK scroll op. The subject's record proves the INVOCATION
  // (never a client receipt), and the client's response is read back.
  await h.key('a', 1200)
  const rows = recorded(h.root)
  const invoked = rows.find((row) => row.scrolled === 'start')
  h.check('the subject INVOKED the official scroll op', invoked !== undefined,
    JSON.stringify(rows))
  h.measure('the node the scroll op named', JSON.stringify(invoked?.target ?? null))
  const afterScroll = h.snapshot()
  h.measure('the client view after the scroll op was invoked', JSON.stringify({
    imageOnScreen: afterScroll.nodes.some((node) => node.tag === 'img'),
    stillTheTail: h.has(afterScroll, 'filler row 199'),
  }))

  // The CLIENT'S OWN way back to the early content: its find-in-scrollback
  // (the user's Ctrl+F path) scrolls the viewport to the match.
  const found = h.ctl('find', 'screenshot')
  h.measure('the client find reply', JSON.stringify(found ?? null))
  await h.sleep(1200)
  const back = h.snapshot()
  const image = back.nodes.find((node) => node.tag === 'img')
  h.check('the client scrolled BACK to the early content and the image is on screen again',
    image !== undefined,
    JSON.stringify(back.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  h.check('the identity line is on screen again with it', h.has(back, '[IMAGE] shot.png'),
    h.texts(back).slice(0, 4).join(' | '))
  if (image !== undefined) h.measure('the image box after the scroll back', JSON.stringify(rect(image)))
  h.capture('prc-gui-image-long-head', 'the same long transcript scrolled back to the image row')
}
