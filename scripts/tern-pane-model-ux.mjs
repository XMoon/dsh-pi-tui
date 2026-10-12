/**
 * The `/model` real-pane acceptance flow for the restructured native picker.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
 *
 * What headless cannot prove, and this run does: the client's own pointer hit
 * areas (the wide details card's HEAD and its nested BODY TEXT lines), the real
 * `select` / `activate` ordering a physical click produces, the footer BUTTONS'
 * containment in their own bar at both supported extremes, and that one real click
 * on the one write reaches the writer exactly once. Every containment claim goes
 * through the visibility oracle (a node's own rect is not a visibility proof).
 *
 * Artifacts (assertions.json, run.log, trees, PNGs, the flow and subject copies)
 * stay in the run directory the driver creates; nothing is deleted.
 * @module scripts/tern-pane-model-ux
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect, visibleSpan } from './tern-pane-geometry.mjs'

/** Every row the subject recorded, re-read on each call (it appends as it runs). */
const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const actionIds = (frame) => (frame.actions ?? []).map((action) => action.id).join(',')
const actionText = (frame) => (frame.actions ?? []).map((action) => String(action.label ?? '')).join(' | ')
/** The first visible node of one class inside another (or the snapshot root). */
const inside = (snap, parent, name) => (parent?.children ?? snap.nodes).find((node) => (node.class ?? '').split(' ').includes(name))
const box = (node) => rect(node).map((n) => Math.round(n * 10) / 10).join(',')

export default async function (h) {
  // ---------------------------------------------------------------- wide shell
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-model-ux-subject.mts')
  const booted = await h.launch(subject, { ready: 'Models' })
  h.check('the production model picker boots inside a real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return

  let snap = h.snapshot()
  h.check('the wide shell renders the models page with its subject', h.has(snap, 'Models') && h.has(snap, 'Session model'))
  h.check('the wide shell asks for the native side preview', h.classNodes(snap, 'pv-side').length > 0)

  const head = h.classNodes(snap, 'sf-card-head')[0]
  h.check('the wide details card head carries its open-details affordance',
    head !== undefined && h.descendantsText(head).includes('›'), head === undefined ? 'no sf-card-head' : h.descendantsText(head))
  const barButtons = h.classNodes(snap, 'pk-btn')
  h.check('the wide model-list footer renders exactly Cancel + the one write', barButtons.length === 2,
    barButtons.map((node) => h.descendantsText(node)).join(' | '))
  h.check('every wide footer button is fully inside its bar',
    barButtons.every((node) => containedXY(snap.chains, node)),
    barButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))
  // Three advertised efforts plus the provider-default sentinel (`effortChoicesOf`
  // adds it when a model declares efforts but no concrete default), so FOUR rows.
  const effortRows = h.classNodes(snap, 'sf-row')
  h.check('every inline Reasoning Effort row is rendered in the wide column',
    effortRows.length === 4
    && ['Default', 'e1', 'e2', 'e3'].every((label) => h.texts(snap).includes(label)),
    `${effortRows.length} row(s): ${effortRows.map((node) => h.descendantsText(node)).join(' | ')}`)
  h.measure('wide footer bar', box(h.classNodes(snap, 'pk-bar')[0] ?? {}))

  // A2: the pointer paths a headless test cannot prove.
  const headClicked = await h.click(snap.chains, head)
  h.check('a REAL pointer click on the card HEAD opens the read-only page',
    headClicked && h.has(h.snapshot(), 'Full model details'), `clicked=${headClicked} :: ${h.texts(h.snapshot()).join(' | ')}`)
  h.check('the read-only page renders Back alone', h.classNodes(h.snapshot(), 'pk-btn').length === 1,
    h.classNodes(h.snapshot(), 'pk-btn').map((node) => h.descendantsText(node)).join(' | '))
  h.capture('lg-details-readonly-1280x800', 'the card head opened the read-only Full details page')

  await h.key('Escape', 800)
  h.check('Escape returns to the model list', h.has(h.snapshot(), 'Models'))

  snap = h.snapshot()
  const body = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-card-body'))
  const bodyLine = inside(snap, body, 'sf-text')
  h.check('the details card body carries nested text lines', bodyLine !== undefined,
    body === undefined ? 'no sf-card-body' : (body.children ?? []).length + ' child(ren)')
  const bodyClicked = bodyLine === undefined ? false : await h.click(snap.chains, bodyLine)
  h.check('a REAL pointer click on a card BODY TEXT line opens the read-only page',
    bodyClicked && h.has(h.snapshot(), 'Full model details'),
    `clicked=${bodyClicked} :: ${h.texts(h.snapshot()).join(' | ')}`)
  await h.key('Escape', 800)

  // A3: the real select / activate ordering.
  snap = h.snapshot()
  const rows = h.classNodes(snap, 'pk-row').filter((node) => !(node.class ?? '').includes('grp'))
  h.check('the model list renders its rows', rows.length === 2, `${rows.length} row(s)`)
  const other = rows.find((node) => !(node.class ?? '').includes('sel'))
  const selectClicked = other === undefined ? false : await h.click(snap.chains, other)
  const sawSelect = records(h).some((row) => row.event?.ev === 'select' && String(row.event.item).includes('m2'))
  h.check('a REAL click on a not-selected row sends select and highlights it',
    selectClicked && sawSelect, JSON.stringify(records(h).filter((row) => row.event).slice(-3)))
  const selected = h.snapshot()
  const sameRow = h.classNodes(selected, 'pk-row').find((node) => (node.class ?? '').includes('sel'))
  const activateClicked = sameRow === undefined ? false : await h.click(selected.chains, sameRow)
  const sawActivate = records(h).some((row) => row.event?.ev === 'activate')
  h.check('clicking the already-selected row sends activate (never a page change)',
    activateClicked && sawActivate && h.has(h.snapshot(), 'Models'),
    JSON.stringify(records(h).filter((row) => row.event).slice(-3)))
  h.check('no browse click wrote anything', records(h).filter((row) => row.apply).length === 0)

  // A4: the compact/Overview footers and their containment at the 400px floor.
  // Park the highlight on the FIRST model so the write payload below is deterministic.
  snap = h.snapshot()
  const first = h.classNodes(snap, 'pk-row').filter((node) => !(node.class ?? '').includes('grp'))
    .find((node) => h.descendantsText(node).includes('Budget Model'))
  h.check('the first model row is back in the list', first !== undefined && await h.click(snap.chains, first),
    h.texts(h.snapshot()).join(' | '))
  await h.resize(400, 600)
  const compact = frames(h).find((frame) => frame.title === 'Models' && actionIds(frame) === 'close')
  h.check('the compact model list offers Cancel alone (no write)', compact !== undefined,
    frames(h).map((frame) => `${frame.title}:${actionIds(frame)}`).join(' | '))
  await h.key('Return', 900)
  const overview = h.snapshot()
  h.check('Enter opens the model overview at 400x600', h.has(overview, 'Model overview'))
  const overviewFrame = frames(h).filter((frame) => frame.title === 'Model overview').at(-1)
  h.check('the overview footer is Back + the one write (no Cancel)', overviewFrame !== undefined && actionIds(overviewFrame) === 'back,apply',
    JSON.stringify(overviewFrame))
  const overviewButtons = h.classNodes(overview, 'pk-btn')
  h.check('every overview footer button is fully inside its bar',
    overviewButtons.length === 2 && overviewButtons.every((node) => containedXY(overview.chains, node)),
    overviewButtons.map((node) => `${h.descendantsText(node)}@${box(node)} span=${visibleSpan(overview.chains, node)}`).join(' '))
  h.measure('overview footer bar', box(h.classNodes(overview, 'pk-bar')[0] ?? {}))
  h.capture('md-overview-400x600', 'the frozen two-entry footer at the 400px floor')

  const primary = overviewButtons.find((node) => (node.class ?? '').includes('primary'))
  const before = records(h).filter((row) => row.apply).length
  const primaryClicked = primary === undefined ? false : await h.click(overview.chains, primary)
  const applied = records(h).filter((row) => row.apply)
  h.check('one REAL click on the write reaches the writer exactly once',
    primaryClicked && applied.length === before + 1 && applied.at(-1).apply.selection.model === 'm',
    `clicked=${primaryClicked} applies=${JSON.stringify(applied)}`)
  h.check('the admitted write renders Close + a disabled Selecting…',
    frames(h).some((frame) => actionIds(frame) === 'close,apply' && actionText(frame).includes('Selecting…')),
    frames(h).map((frame) => `${frame.title}:${actionIds(frame)}:${actionText(frame)}`).join(' | '))
  h.check('the refusal leaves the overview usable with its buttons restored',
    frames(h).at(-1)?.title === 'Model overview' && actionIds(frames(h).at(-1)) === 'back,apply',
    JSON.stringify(frames(h).at(-1)))

  // The BOUNDED wide column: one card, and pointer and key must agree on where it goes.
  await h.key('Escape', 800)   // a content page leaves with Back/Esc; the page is kept across a resize
  await h.resize(1280, 800)
  await h.key('2', 900)
  snap = h.snapshot()
  h.check('the bounded column offers the one "Open model & effort" entry',
    h.classNodes(snap, 'sf-head').some((node) => h.descendantsText(node).includes('Open model & effort')),
    h.texts(snap).join(' | '))
  h.check('the bounded column renders no inline effort rows', h.classNodes(snap, 'sf-row').length === 0,
    `${h.classNodes(snap, 'sf-row').length} row(s)`)
  const boundedBody = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-card-body'))
  const boundedLine = inside(snap, boundedBody, 'sf-text')
  const boundedClicked = boundedLine === undefined ? false : await h.click(snap.chains, boundedLine)
  h.check('a REAL click on the bounded card body opens the model overview',
    boundedClicked && h.has(h.snapshot(), 'Model overview'), `clicked=${boundedClicked}`)
  h.capture('lg-bounded-card-1280x800', 'the bounded column entry opened the model overview')
  await h.key('Escape', 800)
  await h.key('Tab', 700)
  await h.key('Return', 900)
  h.check('the bounded card Enter opens the same page the pointer opened',
    h.has(h.snapshot(), 'Model overview'), h.texts(h.snapshot()).join(' | '))
  h.capture('lg-bounded-keyboard-1280x800', 'the bounded card Enter opened the model overview')

  h.measure('frames rendered', String(frames(h).length))
  h.measure('events the subject received', JSON.stringify(records(h).filter((row) => row.event).map((row) => row.event.ev + (row.event.item === undefined ? '' : `:${row.event.item}`))))
}
