/**
 * The `/model` real-pane acceptance flow for the restructured native picker and
 * its Model-Responsive / Reader revision.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
 *
 * What headless cannot prove, and this run does: the client's own preview MODE at
 * a given pane (the presenter reconstructs the pane width from `cols`/`cell`, and
 * only the real client says whether that pane really gets the SIDE column or the
 * preview under the list), the client's own pointer hit areas (the wide details
 * card's HEAD and its nested BODY TEXT lines, the Reader's Back row), the real
 * `select` / `activate` ordering a physical click produces, the footer BUTTONS'
 * containment in their own bar at both supported extremes, that the Reader's own
 * keyboard scroll really moves the CLIENT's viewport, and that one real click on
 * the one write reaches the writer exactly once. Every containment claim goes
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
const classesOf = (snap) => new Set(snap.nodes.flatMap((node) => (node.class ?? '').split(' ')).filter(Boolean))
const scrolls = (h) => records(h).filter((row) => row.nativeScroll).map((row) => row.nativeScroll)
/** The rendered text node whose value starts with `prefix` (the Reader's value
 *  nodes carry the WHOLE value, which is what the client wraps). */
const textStarting = (snap, prefix) => snap.nodes.find((node) => String(node.text ?? '').startsWith(prefix))
/**
 * Open the Overview's `View full model details ›` row by POINTER: the row is
 * first walked into the visible region (a clipped row has no clickable fragment),
 * then clicked - `Enter` would act on the list CURSOR, which an already-visible
 * row never moves.
 */
const openOverviewDetails = async (h) => {
  await pressUntilRow(h, 'View full model details')
  const snap = h.snapshot()
  const row = h.classNodes(snap, 'pk-row')
    .find((node) => h.descendantsText(node).includes('View full model details'))
  return row === undefined ? false : await h.click(snap.chains, row)
}

/**
 * One plan §7.2 matrix size on the CURRENT revision. It asserts the presenter's
 * claim against the client's OWN preview mode, the containment of what the client
 * paints, and — for a compact size — the Overview → Reader path that pane depends
 * on, so the matrix proves reachability rather than echoing the presenter.
 */
const matrixCell = async (h, size, expect) => {
  // Esc back to the model LIST — never PAST it (Esc on the list dismisses the
  // panel), so a panel that is somehow gone fails the check instead of cascading.
  for (let step = 0; step < 3 && frames(h).at(-1)?.title !== 'Models'; step += 1) {
    if (frames(h).at(-1)?.title === undefined) break
    await h.key('Escape', 700)
  }
  h.check(`${size.w}x${size.h}: the matrix cell starts on the model list (the panel is still open)`,
    frames(h).at(-1)?.title === 'Models', JSON.stringify(frames(h).at(-1)))
  await h.resize(size.w, size.h)
  await h.sleep(300)
  let snap = h.snapshot()
  let frame = frames(h).at(-1)
  const buttons = h.classNodes(snap, 'pk-btn')
  h.check(`${size.w}x${size.h}: the presenter asks for ${expect === 'wide' ? 'lg + side' : 'md + none'}`,
    expect === 'wide' ? frame?.size === 'lg' && frame?.preview === 'side' : frame?.size === 'md' && frame?.preview === 'none',
    JSON.stringify(frame))
  h.check(`${size.w}x${size.h}: the client paints ${expect === 'wide' ? 'the real SIDE column' : 'no preview region at all'}`,
    expect === 'wide'
      ? classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto') && h.classNodes(snap, 'sf-row').length === 4
      : !classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto') && h.classNodes(snap, 'sf-row').length === 0,
    [...classesOf(snap)].filter((name) => name.startsWith('pv-')).join(','))
  h.check(`${size.w}x${size.h}: every visible footer button is contained`,
    buttons.length > 0 && buttons.every((node) => containedXY(snap.chains, node)),
    buttons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))
  if (expect === 'wide') {
    const rows = h.classNodes(snap, 'sf-row')
    h.check(`${size.w}x${size.h}: every inline candidate is inside the column it is painted in`,
      rows.length === 4 && rows.every((node) => containedXY(snap.chains, node)),
      rows.map((node) => h.descendantsText(node)).join(' | '))
    h.capture(`matrix-${size.w}x${size.h}`, `the plan matrix: ${size.w}x${size.h} wide`)
    return
  }
  await h.key('Return', 900)
  snap = h.snapshot()
  frame = frames(h).filter((row) => row.title === 'Model overview').at(-1)
  const overviewButtons = h.classNodes(snap, 'pk-btn')
  h.check(`${size.w}x${size.h}: the compact list opens the Overview with Back + the one write`,
    frame !== undefined && actionIds(frame) === 'back,apply' && overviewButtons.length === 2
    && overviewButtons.every((node) => containedXY(snap.chains, node)),
    JSON.stringify(frame))
  // The effort section must start on the FIRST screen: the row ids come from the
  // frame's own wire order, so a candidate row is never confused with a summary
  // row that merely carries a similar label.
  const rowIds = (frame?.rows ?? []).map(String)
  const domRows = h.classNodes(snap, 'pk-row')
  const effortAt = rowIds.findIndex((id) => id === 'overview-effort')
  const paired = domRows.map((node, index) => ({ id: rowIds[index], node }))
  const candidateRows = paired.filter((entry) => String(entry.id).startsWith('effort:'))
  h.check(`${size.w}x${size.h}: the effort section head starts on the Overview's first screen`,
    effortAt >= 0 && paired[effortAt] !== undefined && containedXY(snap.chains, paired[effortAt].node),
    `${rowIds.join(',')} :: ${box(paired[effortAt]?.node)}`)
  h.check(`${size.w}x${size.h}: every candidate row the page paints is inside its region`,
    candidateRows.length >= 1 && candidateRows.every((entry) => containedXY(snap.chains, entry.node)),
    candidateRows.map((entry) => `${entry.id}@${box(entry.node)}`).join(' '))
  h.capture(`matrix-${size.w}x${size.h}`, `the plan matrix: ${size.w}x${size.h} compact Overview`)
  // Full details stays navigable from that Overview, and the Reader returns. The
  // row is walked into the visible region and then CLICKED: `Enter` acts on the
  // list CURSOR (still row 0 here), and an already-visible row would otherwise
  // never move it.
  const detailsClicked = await openOverviewDetails(h)
  h.check(`${size.w}x${size.h}: the Overview's details row opens the Reader by pointer`,
    detailsClicked && h.has(h.snapshot(), 'Full model details'),
    `clicked=${detailsClicked} :: ${h.texts(h.snapshot()).join(' | ')}`)
  await h.key('Escape', 900)
  h.check(`${size.w}x${size.h}: the Reader returns to the Overview it came from`,
    h.has(h.snapshot(), 'Model overview'), h.texts(h.snapshot()).join(' | '))
}

/** Walk the native list cursor with REAL Down keys until a row carrying `text` is
 *  on screen: a row below the fold must be reached the way a user reaches it,
 *  never assumed to be painted. The caller re-reads ONE snapshot afterwards (a
 *  node object belongs to the snapshot whose `chains` map it came from). */
const pressUntilRow = async (h, text, tries = 14) => {
  for (let step = 0; step < tries; step += 1) {
    const snap = h.snapshot()
    const found = h.classNodes(snap, 'pk-row').find((node) => h.descendantsText(node).includes(text))
    // A row that is merely PRESENT can still be clipped by the list scroller, so
    // the walk stops only where the row really survives inside it.
    if (found !== undefined && containedXY(snap.chains, found)) return
    await h.key('Down', 300)
  }
}

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
  h.check('the wide pane really gets the SIDE column, not the below-list fallback',
    classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto'),
    [...classesOf(snap)].filter((name) => name.startsWith('pv-')).join(','))
  h.check('the modeled layout it asked for is the wide one',
    frames(h).at(-1)?.size === 'lg' && frames(h).at(-1)?.preview === 'side',
    JSON.stringify(frames(h).at(-1)))

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
  // The client keeps the side column only while it really fits the list; the rows
  // must be inside the region the user can see (a node's rect is not a proof).
  h.check('every inline effort row is covered by the region it is painted in',
    effortRows.every((node) => containedXY(snap.chains, node)),
    effortRows.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))
  h.measure('wide footer bar', box(h.classNodes(snap, 'pk-bar')[0] ?? {}))

  h.capture('lg-models-1280x800', 'the wide three-column shell: scopes, list, full details card, inline effort rows')

  // ------------------------------------ the MEASURED side-preview boundary
  // 1020px is 127 columns at the pane's 8px cell: the client's sheet has not
  // reached its own breakpoint, so the preview would be painted UNDER the list and
  // the inline effort rows would be clipped out of the visible region. The
  // presenter must not claim the wide shell there at all.
  await h.resize(1020, 640)
  await h.sleep(300)
  snap = h.snapshot()
  const belowFrame = frames(h).at(-1)
  h.check('a 1020px pane is NOT claimed as wide (the client would paint below the list)',
    belowFrame?.size === 'md' && belowFrame?.preview === 'none', JSON.stringify(belowFrame))
  h.check('and the client really paints no preview region there',
    !classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto') && h.classNodes(snap, 'sf-row').length === 0,
    [...classesOf(snap)].filter((name) => name.startsWith('pv-')).join(','))
  h.capture('md-models-1020x640', 'the medium split: compact picker, no preview, no inline candidate')

  // 1040px is the boundary pane itself. The presenter reconstructs the pane width
  // from `cols` * the cell width, and that reconstruction UNDER-estimates by the
  // client's own chrome (measured: 1040px -> 129 * 8 = 1032px), so the boundary
  // pane still goes compact. That is the safe direction, and it is measured here
  // rather than assumed.
  await h.resize(1040, 640)
  await h.sleep(300)
  const boundaryFrame = frames(h).at(-1)
  h.measure('the 1040px boundary pane still goes compact (one cell of safety margin)',
    JSON.stringify({ frame: boundaryFrame, cols: records(h).filter((row) => row.resize).at(-1)?.resize }))
  h.check('the boundary pane is not claimed as wide either',
    boundaryFrame?.size === 'md' && boundaryFrame?.preview === 'none', JSON.stringify(boundaryFrame))

  // One cell further out the client's sheet is really past its breakpoint, so the
  // SIDE column is real and every advertised candidate is inside it.
  await h.resize(1050, 700)
  await h.sleep(300)
  snap = h.snapshot()
  const sideFrame = frames(h).at(-1)
  h.check('a 1050px pane IS claimed as wide and gets the real side column',
    sideFrame?.size === 'lg' && sideFrame?.preview === 'side'
    && classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto'),
    `${JSON.stringify(sideFrame)} :: ${[...classesOf(snap)].filter((name) => name.startsWith('pv-')).join(',')}`)
  const sideRows = h.classNodes(snap, 'sf-row')
  h.check('and every advertised candidate is really visible inside it',
    sideRows.length === 4 && sideRows.every((node) => containedXY(snap.chains, node)),
    `${sideRows.length} row(s): ${sideRows.map((node) => h.descendantsText(node)).join(' | ')}`)
  h.capture('lg-models-1050x700', 'the first pane whose sheet passes the client breakpoint: the side column is real')

  // Back to the documented normal wide pane for the interaction paths below. A
  // snapshot belongs to the pane it was taken in, so it is re-read here: a click
  // is delivered in CURRENT pane coordinates.
  await h.resize(1280, 800)
  await h.sleep(300)
  snap = h.snapshot()

  // A2: the pointer paths a headless test cannot prove.
  const headClicked = await h.click(snap.chains, h.classNodes(snap, 'sf-card-head')[0])
  h.check('a REAL pointer click on the card HEAD opens the read-only Reader',
    headClicked && h.has(h.snapshot(), 'Full model details'), `clicked=${headClicked} :: ${h.texts(h.snapshot()).join(' | ')}`)
  h.check('the Reader REPLACES the picker: no action bar and no picker rows at all',
    h.classNodes(h.snapshot(), 'pk-btn').length === 0 && h.classNodes(h.snapshot(), 'pk-row').length === 0,
    h.classNodes(h.snapshot(), 'pk-btn').map((node) => h.descendantsText(node)).join(' | '))
  h.capture('lg-reader-1040x640', 'the card head opened the read-only Reader')

  await h.key('Escape', 800)
  h.check('Escape returns to the model list', h.has(h.snapshot(), 'Models'))

  snap = h.snapshot()
  const body = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-card-body'))
  const bodyLine = inside(snap, body, 'sf-text')
  h.check('the details card body carries nested text lines', bodyLine !== undefined,
    body === undefined ? 'no sf-card-body' : (body.children ?? []).length + ' child(ren)')
  const bodyClicked = bodyLine === undefined ? false : await h.click(snap.chains, bodyLine)
  h.check('a REAL pointer click on a card BODY TEXT line opens the read-only Reader',
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
  await h.sleep(300)
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
  // The Overview's OWN priority: the effort section and every advertised candidate
  // come before the details entry and the remaining configured facts.
  const overviewTexts = h.texts(overview)
  h.check('the Overview leads with the model then the effort candidates',
    overviewTexts.indexOf('Model') >= 0
    && overviewTexts.indexOf('Reasoning effort') > overviewTexts.indexOf('Model')
    && ['e1', 'e2', 'e3', 'Default'].every((label) => overviewTexts.includes(label))
    && overviewTexts.indexOf('View full model details ›') > overviewTexts.indexOf('e3'),
    overviewTexts.join(' | '))
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

  // ------------------------------- the user's ordinary SPLIT pane (~1000px wide)
  // The reported defect: at this pane the old rule asked for the side column, the
  // client painted the preview below the list, and the effort entry was invisible.
  // The compact path must reach every candidate and the one write instead.
  await h.key('Escape', 800)
  await h.resize(1000, 640)
  await h.sleep(300)
  snap = h.snapshot()
  h.check('the ~1000px split pane is a COMPACT picker with no preview at all',
    h.has(snap, 'Models') && !classesOf(snap).has('pv-side') && !classesOf(snap).has('pv-below-auto')
    && frames(h).at(-1)?.size === 'md',
    `${JSON.stringify(frames(h).at(-1))} :: ${[...classesOf(snap)].filter((name) => name.startsWith('pv-')).join(',')}`)
  h.check('and its list offers no write (the Overview owns it)', actionIds(frames(h).at(-1)) === 'close',
    JSON.stringify(frames(h).at(-1)))
  await h.key('Return', 900)
  const splitOverview = h.snapshot()
  h.check('Enter opens the model Overview at the split pane', h.has(splitOverview, 'Model overview'))
  const splitFrame = frames(h).filter((frame) => frame.title === 'Model overview').at(-1)
  h.check('the Overview carries Back + the one write',
    actionIds(splitFrame) === 'back,apply', JSON.stringify(splitFrame))
  const splitButtons = h.classNodes(splitOverview, 'pk-btn')
  h.check('its footer buttons are contained at the split pane',
    splitButtons.length === 2 && splitButtons.every((node) => containedXY(splitOverview.chains, node)),
    splitButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))
  h.check('every advertised effort candidate is reachable in the first screen',
    ['e1', 'e2', 'e3', 'Default'].every((label) => h.texts(splitOverview).includes(label)),
    h.texts(splitOverview).join(' | '))
  h.capture('md-overview-1000x640', 'the reported split pane: the candidate is in the Overview, not in a hidden preview')

  // ------------------------------- the plan's §7.2 matrix on THIS revision
  // The four sizes the plan names that the sections above do not already cover,
  // each driven end to end (presenter claim → client's real preview mode →
  // containment → the Overview → Reader path) rather than inferred from a Gate A
  // calibration taken with an older presenter.
  for (const cell of [
    { w: 1100, h: 640, expect: 'wide' },
    { w: 1280, h: 600, expect: 'wide' },
    { w: 900, h: 640, expect: 'compact' },
    { w: 560, h: 640, expect: 'compact' },
  ]) {
    await matrixCell(h, cell, cell.expect)
  }

  // ------------------------------------------------------------- the Reader
  // A model whose identity and description cannot be read from a one-line row:
  // the Reader must carry the COMPLETE values, the app must be able to drive the
  // native scroll container, and Back must return to the real origin.
  for (let step = 0; step < 3 && frames(h).at(-1)?.title !== 'Models'; step += 1) {
    if (frames(h).at(-1)?.title === undefined) break
    await h.key('Escape', 700)
  }
  h.check('the model list is the page again before the Reader section',
    frames(h).at(-1)?.title === 'Models', JSON.stringify(frames(h).at(-1)))
  await h.resize(1280, 800)
  await h.sleep(200)
  await h.key('3', 900)
  snap = h.snapshot()
  h.check('the long-value fixture keeps the wide shell', frames(h).at(-1)?.size === 'lg',
    JSON.stringify(frames(h).at(-1)))
  h.capture('lg-long-model-1280x800', 'the long-identity model in the wide shell')
  const longHead = h.classNodes(snap, 'sf-card-head')[0]
  const longOpened = longHead === undefined ? false : await h.click(snap.chains, longHead)
  h.check('the long model opens its Reader', longOpened && h.has(h.snapshot(), 'Full model details'),
    `clicked=${longOpened}`)
  snap = h.snapshot()
  const readerBody = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-ov-body'))
  h.check('the Reader renders a native overlay body', readerBody !== undefined, box(readerBody))
  // The client's own node dump caps a text node at 200 characters, so the tree can
  // never be the proof that a long value is complete (the WIRE value is asserted
  // by the headless suite). What the real pane proves is the SHAPE and the
  // REACHABILITY: ONE value node, wrapped by the client into many lines, with its
  // tail reachable through the app-driven native scroll.
  const description = textStarting(snap, 'Long description')
  const valueNodes = snap.nodes.filter((node) => String(node.text ?? '').startsWith('Long description'))
  h.check('the Reader carries the long description as ONE client-wrapped value',
    description !== undefined
    && valueNodes.length === 1
    && String(description.text).includes('中文描述')
    && String(description.text).includes('🚀')
    && rect(description)[3] > 200,
    JSON.stringify({
      nodes: valueNodes.length,
      dumped: String(description?.text ?? '').length,
      rect: box(description),
      note: 'the dump caps one node at 200 chars; the client wrapped it into many lines',
    }))
  const backRow = snap.nodes.find((node) => h.descendantsText(node) === 'Back')
  h.check('the Reader renders its own visible Back row', backRow !== undefined && h.classNodes(snap, 'sf-row').length > 0,
    box(backRow))
  const unbroken = snap.nodes.find((node) => String(node.text ?? '').startsWith('provider/WWWW'))
  h.check('an unbroken 180-glyph identifier reaches the client whole',
    unbroken !== undefined && String(unbroken.text).includes('very-high'),
    unbroken === undefined ? 'no identifier node' : box(unbroken))
  h.capture('lg-reader-long-1280x800', 'the Reader with the complete long values')

  // The app owns the keyboard: the Reader's keys must move the CLIENT's viewport.
  // (`Down`/`Up`/`Home`/`End` are the names this client's control channel really
  // delivers; `PageDown` is accepted there but silently produces no key, so the
  // page keys are proved at the byte level by the headless suite and the same
  // scroll op is proved END-TO-END here.)
  const beforeScroll = rect(description ?? {}).map((n) => Math.round(n))
  await h.key('Down', 700)
  h.check('a line key reaches the app as a native line scroll',
    scrolls(h).at(-1)?.to === 'line-down', JSON.stringify(scrolls(h).slice(-2)))
  await h.key('End', 800)
  h.check('End reaches the app as a native scroll to the end',
    scrolls(h).at(-1)?.to === 'end', JSON.stringify(scrolls(h).slice(-2)))
  snap = h.snapshot()
  const afterScroll = rect(textStarting(snap, 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('the CLIENT really scrolled: the same value node moved up by more than half its height',
    afterScroll[1] < beforeScroll[1] - 0.5 * beforeScroll[3], `${beforeScroll} -> ${afterScroll}`)
  h.capture('lg-reader-scrolled-end-1280x800', 'after End: the viewport really moved to the tail')
  // §7.2 wants the long value read at the TOP, the MIDDLE and the TAIL. The app
  // owns the keyboard and this client's control channel drops `PageDown`, so the
  // middle is reached with real line keys; the value node's own y is the proof it
  // moved, and the capture is the human check of what is visible there.
  await h.key('Home', 800)   // the middle is walked INTO from the top: at the tail,
  // a line-down key is a no-op because the viewport is already at the end.
  for (let step = 0; step < 24; step += 1) await h.key('Down', 90)
  const middleScroll = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('the long value can be read in the MIDDLE, between the top and the tail',
    middleScroll[1] < beforeScroll[1] - 20 && middleScroll[1] > afterScroll[1] + 20,
    `${beforeScroll} -> ${middleScroll} -> ${afterScroll}`)
  h.capture('lg-reader-middle-1280x800', 'the middle of the long value, reached with real line keys')
  await h.key('Home', 800)
  const homeScroll = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('Home brings the Reader back to the top of the value',
    homeScroll[1] > afterScroll[1], `${afterScroll} -> ${homeScroll}`)

  // A KEYBOARD-path back: Esc is the same intent as the visible row.
  await h.key('Escape', 900)
  h.check('Escape leaves the Reader for the model list', h.has(h.snapshot(), 'Models') && !h.has(h.snapshot(), 'Full model details'))
  // A REAL pointer click on the visible Back row returns as well.
  const reopenSnap = h.snapshot()
  const reopened = h.classNodes(reopenSnap, 'sf-card-head')[0]
  if (reopened !== undefined) await h.click(reopenSnap.chains, reopened)
  h.check('the Reader reopens', h.has(h.snapshot(), 'Full model details'))
  snap = h.snapshot()
  const backNow = snap.nodes.filter((node) => h.descendantsText(node) === 'Back').at(-1)
  const backClicked = backNow === undefined ? false : await h.click(snap.chains, backNow)
  h.check('a REAL click on the visible Back row returns to the model list',
    backClicked && h.has(h.snapshot(), 'Models'), `clicked=${backClicked}`)

  // A FAILED re-read ON the Reader, driven in the real pane through the subject's
  // own phase control: the failure must be reported as the page's Status fact while
  // the page keeps its content, its scroll keys really move the CLIENT's viewport,
  // and its visible Back row still returns to the model list.
  await h.key('3', 700)   // re-arm the fixture (the panel is ready again)
  const failedSnap = h.snapshot()
  const failedHead = h.classNodes(failedSnap, 'sf-card-head')[0]
  const failedOpened = failedHead === undefined ? false : await h.click(failedSnap.chains, failedHead)
  h.check('the Reader reopens for the failed-read phase check',
    failedOpened && h.has(h.snapshot(), 'Full model details'), `clicked=${failedOpened}`)
  await h.key('e', 700)
  const failedStatus = 'catalog is unreachable\r\nsecond line\r\n\r\nfourth line'
  const statusSnap = h.snapshot()
  const statusNode = statusSnap.nodes.find((node) => String(node.text ?? '').startsWith('catalog is unreachable'))
  h.check('a failed re-read is reported as the Reader own Status fact on the pane',
    h.has(statusSnap, 'catalog is unreachable'), h.texts(statusSnap).slice(-6).join(' | '))
  // The plan's LF/CRLF row. This client's node DUMP normalizes whitespace runs
  // (measured below), so the dump can never carry the proof: the proof is the
  // RENDERED line count — the message has three breaks (`\r\n`, `\r\n`, blank
  // `\r\n`), so it must occupy FOUR native lines instead of one collapsed line.
  // A one-line value of the SAME page measures the Reader's line height for us
  // (the client's tree exposes DOM ids only for a few nodes, so this is found by
  // its text).
  const lineHeight = rect(statusSnap.nodes.find((node) => String(node.text ?? '') === 'Long Model') ?? {})[3]
  h.check('and the client renders every LF/CRLF/blank-line break as its own line',
    statusNode !== undefined && lineHeight > 0 && rect(statusNode)[3] >= 3.5 * lineHeight,
    `${box(statusNode)} against a ${lineHeight}px line (a collapsed value is one line)`)
  h.measure('the client normalizes whitespace in its node dump', JSON.stringify(String(statusNode?.text)))
  const failedBefore = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  await h.key('End', 900)
  const failedAfter = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('the Reader still scrolls with the CLIENT moving while the read has failed',
    failedAfter[1] < failedBefore[1] - 50, `${failedBefore} -> ${failedAfter}`)
  // The `Back` row is the FIRST row of the scrollable body, so it travels with the
  // content: after scrolling to the tail the way back is `Home` (or `Esc`), and the
  // row is then clickable again — it is never a dead control while the read fails.
  await h.key('Home', 800)
  const failedBackSnap = h.snapshot()
  const failedBack = failedBackSnap.nodes.filter((node) => h.descendantsText(node) === 'Back').at(-1)
  const failedBackClicked = failedBack === undefined ? false : await h.click(failedBackSnap.chains, failedBack)
  h.check('its visible Back row returns to the model list while the read has failed',
    failedBackClicked && h.has(h.snapshot(), 'Models'), `clicked=${failedBackClicked}`)
  await h.key('3', 700)   // ready again for the sections below

  // A SHORT pane: the Reader must still open and still scroll to the tail.
  await h.resize(1000, 400)
  await h.sleep(300)
  await h.key('Return', 900)
  snap = h.snapshot()
  h.check('the split pane opens the Overview for the long model', h.has(snap, 'Model overview'))
  // The Overview's configured facts are one-line summaries: a long value must not
  // wrap into a stack of rows and push every candidate off the screen. The
  // measured single-row height is 36px here, so 40px is an upper bound with slack.
  const longRows = h.classNodes(snap, 'pk-row')
  h.check('every Overview row stays ONE native line for the long-value model',
    longRows.length > 0 && longRows.every((node) => rect(node)[3] <= 40),
    longRows.map((node) => `${h.descendantsText(node).slice(0, 20)}@${box(node)}`).join(' '))
  const shortOpened = await openOverviewDetails(h)
  h.check('the Overview details row opens the Reader in a short pane',
    shortOpened && h.has(h.snapshot(), 'Full model details'),
    `clicked=${shortOpened} :: ${h.texts(h.snapshot()).join(' | ')}`)
  const shortBefore = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  await h.key('End', 900)
  const shortAfter = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('the short-pane Reader still scrolls to the tail with the keyboard',
    shortAfter[1] < shortBefore[1] - 50, `${shortBefore} -> ${shortAfter}`)
  h.capture('md-reader-short-1000x400', 'the Reader in a short split pane, scrolled to the tail')

  // The plan's short WIDE pane: the Reader's truncation is recovered by scrolling
  // there too (the same rule as the short split pane above).
  for (let step = 0; step < 3 && frames(h).at(-1)?.title !== 'Models'; step += 1) await h.key('Escape', 700)
  await h.resize(1280, 600)
  await h.sleep(300)
  h.check('the short wide pane still claims the wide shell and keeps the candidates inline',
    frames(h).at(-1)?.size === 'lg' && h.classNodes(h.snapshot(), 'sf-row').length === 4,
    JSON.stringify(frames(h).at(-1)))
  const shortWideHead = h.classNodes(h.snapshot(), 'sf-card-head')[0]
  const shortWideOpened = shortWideHead === undefined ? false : await h.click(h.snapshot().chains, shortWideHead)
  h.check('the short wide card opens the Reader', shortWideOpened && h.has(h.snapshot(), 'Full model details'),
    `clicked=${shortWideOpened}`)
  const shortWideBefore = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  await h.key('End', 900)
  const shortWideAfter = rect(textStarting(h.snapshot(), 'Long description') ?? {}).map((n) => Math.round(n))
  h.check('the short wide Reader scrolls to the tail with the keyboard',
    shortWideAfter[1] < shortWideBefore[1] - 50, `${shortWideBefore} -> ${shortWideAfter}`)
  await h.key('Escape', 900)
  h.check('and its Back/Esc returns to the model list', h.has(h.snapshot(), 'Models'))

  // The BOUNDED wide column: one card, and pointer and key must agree on where it goes.
  // Back to the model LIST: the Reader returned to the Overview it was entered
  // from (its real origin), so the Overview's own Esc is one more step.
  for (let step = 0; step < 3 && frames(h).at(-1)?.title !== 'Models'; step += 1) await h.key('Escape', 700)
  h.check('the model list is the page again before the bounded-column section',
    frames(h).at(-1)?.title === 'Models', JSON.stringify(frames(h).at(-1)))
  await h.resize(1280, 800)
  await h.sleep(200)
  await h.key('2', 900)
  snap = h.snapshot()
  h.check('the bounded column offers the one "Open model & effort" entry',
    h.classNodes(snap, 'sf-head').some((node) => h.descendantsText(node).includes('Open model & effort')),
    h.texts(snap).join(' | '))
  h.check('the bounded column renders no inline effort rows', h.classNodes(snap, 'sf-row').length === 0,
    `${h.classNodes(snap, 'sf-row').length} row(s)`)
  h.capture('lg-bounded-column-1280x800', 'the bounded column itself, before any navigation')
  const boundedBody = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-card-body'))
  const boundedLine = inside(snap, boundedBody, 'sf-text')
  const boundedClicked = boundedLine === undefined ? false : await h.click(snap.chains, boundedLine)
  h.check('a REAL click on the bounded card body opens the model overview',
    boundedClicked && h.has(h.snapshot(), 'Model overview'), `clicked=${boundedClicked}`)
  h.capture('lg-bounded-overview-1280x800', 'the bounded column entry opened the model overview')
  await h.key('Escape', 800)
  await h.key('Tab', 700)
  await h.key('Return', 900)
  h.check('the bounded card Enter opens the same page the pointer opened',
    h.has(h.snapshot(), 'Model overview'), h.texts(h.snapshot()).join(' | '))
  h.capture('lg-bounded-keyboard-1280x800', 'the bounded card Enter opened the same model overview')

  // The harness's own input capability, MEASURED instead of assumed: this lane can
  // inject keys and clicks, and this client's control channel exposes no
  // pointer/wheel input at all (every shape below is rejected). That is why the
  // plan's "pointer scroll of the overlay body" item is an OWNER exemption rather
  // than a PASS, and the probe is part of the lane so the claim stays reproducible.
  const acceptedWheelShapes = []
  for (const shape of [['wheel', 400, 200, -3], ['scroll', 400, 200, -3], ['mouse', 'wheel', 400, 200, -3]]) {
    try {
      h.send(...shape)
      acceptedWheelShapes.push(shape.join(' '))
    } catch {
      // Rejected: the measured outcome on this client, recorded below.
    }
  }
  h.measure('pointer/wheel control shapes this client accepted', JSON.stringify(acceptedWheelShapes))
  h.measure('frames rendered', String(frames(h).length))
  h.measure('native scroll ops the app asked for', JSON.stringify(scrolls(h)))
  h.measure('events the subject received', JSON.stringify(records(h).filter((row) => row.event).map((row) => row.event.ev + (row.event.item === undefined ? '' : `:${row.event.item}`))))
}
