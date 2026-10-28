/**
 * The committed GUI smoke flow: the whole GUI harness path in one run — boot a
 * real GUI WINDOW on a real display, launch a subject in one of its panes, send
 * a control-injected pointer click and a control-injected key, read the
 * subject's own record back, and leave auditable artifacts.
 *
 *   node scripts/tern-gui-drive.mjs scripts/tern-gui-smoke.mjs
 *
 * It is the GUI twin of `scripts/tern-pane-smoke.mjs`, and it is the worked
 * example for writing your own GUI flow. Everything it asserts is about the
 * INSTRUMENT (the GUI lane works), not about any `/model` or `/preset` surface.
 *
 * It also proves the GUI window is a real native window on a real display and
 * that the control-injected pointer/key path reaches the client. The `a11y`
 * tree is the client's tree; physical input and an OS screen reader are not
 * exercised. The theme switch is not exercised by this smoke.
 *
 * @module scripts/tern-gui-smoke
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read the subject's own event ledger — the positive control for the injected input. */
function recorded(root) {
  return readFileSync(join(root, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export default async function (h) {
  // The window must be a real native window on a real display.
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  // A REAL WINDOW HAS A MINIMUM SIZE: the client clamps the request (measured:
  // 720px wide on this build), so the flow asks for a size the window can
  // actually take and REPORTS the clamp instead of failing on it.
  const size = await h.resize(1280, 800)
  h.check('the window took the requested content size', size.clamped === false,
    `requested=${JSON.stringify(size.requested)} actual=${JSON.stringify(size.viewport)}`)
  h.measure('the window minimum size', JSON.stringify(size))
  const subject = join(h.repo, 'scripts', 'tern-gui-smoke-subject.mts')
  const booted = await h.launch(subject, { ready: 'gui-smoke ready' })
  h.check('the subject boots inside a real Tern GUI pane', booted)
  if (!booted) {
    h.measure('the subject stderr', readFileSync(join(h.root, 'subject.err'), 'utf8').slice(0, 600))
    return
  }

  const snap = h.snapshot()
  h.check('the tree carries the subject text', h.has(snap, 'gui-smoke ready'),
    h.texts(snap).join(' | '))
  h.check('the counters start at zero', h.has(snap, 'clicks=0 keys=0'),
    h.texts(snap).join(' | '))

  const button = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).includes('Pick'))
  h.check('the Pick button is in the tree', button !== undefined,
    JSON.stringify(h.classNodes(snap, 'pk-btn').length))
  if (button === undefined) return

  // A control-injected pointer click on the real window.
  const clicked = await h.click(snap.chains, button)
  h.check('a control-injected pointer click on the visible fragment runs the handler',
    clicked && h.has(h.snapshot(), 'clicks=1'),
    `clicked=${clicked} :: ${h.texts(h.snapshot()).join(' | ')}`)

  // A control-injected key.
  await h.key('a', 700)
  h.check('a control-injected key reaches the subject loop', h.has(h.snapshot(), 'keys=1'),
    h.texts(h.snapshot()).join(' | '))

  // The subject's own record is the positive control: it proves exactly one
  // click and one key ARRIVED, which a redraw on its own cannot.
  const rows = recorded(h.root)
  h.check('the subject recorded exactly one click and one key',
    rows.filter((row) => row.click !== undefined).length === 1
    && rows.filter((row) => row.key === 'a').length === 1,
    JSON.stringify(rows))

  // The control-injected pointer moves. The same command works headlessly;
  // this lane proves it on the real window. The node and its chains come from
  // the SAME snapshot: the geometry oracle indexes by node identity, so a chain
  // from another snapshot is empty.
  const hoverSnap = h.snapshot()
  const hoverTarget = hoverSnap.nodes.find((node) => node.tag === 'button')
  if (hoverTarget !== undefined) {
    const moved = await h.hover(hoverSnap.chains, hoverTarget)
    h.check('the control-injected pointer moves to the node it was sent to', moved?.moved === true,
      JSON.stringify(moved ?? null))
  }

  // The client's accessibility tree; no OS screen reader is exercised.
  const a11y = h.ctl('a11y')
  const roles = new Set()
  const walk = (node) => {
    if (node.role) roles.add(node.role)
    for (const child of node.children ?? []) walk(child)
  }
  if (a11y) walk(a11y)
  h.check('the client exposes its accessibility tree', roles.size > 0,
    JSON.stringify([...roles].slice(0, 10)))
  h.measure('the accessibility roles', JSON.stringify([...roles].sort().slice(0, 20)))

  h.measure('the viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
  h.capture('gui-smoke', 'after one real click, one real key and one real hover')
}
