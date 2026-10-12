/**
 * The committed smoke flow: the whole harness path in one run — boot the server,
 * launch a subject in a real pane, send REAL input, assert on the REAL node tree,
 * read the subject's own record back, and leave auditable artifacts.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-smoke.mjs
 *
 * It is the worked example for writing your own flow, and the check that the
 * driver still works end to end after a change. Everything it asserts is about
 * the instrument, not about a `/model` or `/preset` surface.
 * @module scripts/tern-pane-smoke
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default async function (h) {
  await h.resize(400, 600)
  const subject = join(h.repo, 'scripts', 'tern-pane-smoke-subject.mts')
  const booted = await h.launch(subject, { ready: 'pane-smoke ready' })
  h.check('the subject boots inside a real Tern pane', booted)

  let snap = h.snapshot()
  h.check('the tree carries the subject text', h.has(snap, 'pane-smoke ready'), h.texts(snap).join(' | '))
  h.check('the counters start at zero', h.has(snap, 'clicks=0 keys=0'), h.texts(snap).join(' | '))

  const button = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).includes('Pick'))
  h.check('the Pick button is in the tree', button !== undefined,
    JSON.stringify(h.classNodes(snap, 'pk-btn').length))
  if (button === undefined) return

  const clicked = await h.click(snap.chains, button)
  h.check('a REAL pointer click on the visible fragment runs the handler',
    clicked && h.has(h.snapshot(), 'clicks=1'), `clicked=${clicked} :: ${h.texts(h.snapshot()).join(' | ')}`)

  await h.key('a', 700)
  h.check('a REAL key reaches the subject loop', h.has(h.snapshot(), 'keys=1'), h.texts(h.snapshot()).join(' | '))

  // The subject's own record is the positive control: it proves exactly one click
  // and one key ARRIVED, which a redraw on its own cannot.
  const recorded = readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  h.check('the subject recorded exactly one click and one key',
    recorded.filter((row) => row.click !== undefined).length === 1
    && recorded.filter((row) => row.key === 'a').length === 1,
    JSON.stringify(recorded))

  h.measure('viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
  h.capture('smoke-400x600', 'after one real click and one real key')
}
