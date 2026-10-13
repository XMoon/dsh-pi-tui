/**
 * The `/model` real-pane acceptance lane for the LIST-FIRST catalogue, its
 * Overview and its read-only Reader — asserted against the real Tern client with
 * real pointer clicks and real keys.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs --out temp/<run>
 *
 * What only the real client can prove, and this lane proves: the client's own
 * preview MODE for the pane width the presenter reconstructs from `cols`/`cell`
 * (`pv-below` vs `pv-none`), the client's own pointer hit areas (a model row, an
 * effort candidate, the one write, the retry row, the Reader's Back row), the real
 * `select` / `activate` ordering a physical click produces, the containment of the
 * footer buttons and the rows at every supported size, that the Reader's keyboard
 * scroll really moves the CLIENT's viewport, that a failed read is painted as the
 * Reader's own leading line while its scroll and Back still work, and that one
 * real click on the one write reaches the writer exactly once.
 *
 * Every containment claim goes through the visibility oracle (`containedXY` /
 * `visibleSpan`); a node's own rect is never a visibility proof, and an empty node
 * list FAILS instead of passing vacuously. Artifacts stay in the run directory the
 * driver creates; nothing is deleted.
 * @module scripts/tern-pane-model-ux
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { containedX, containedXY, rect as rawRect, visibleSpan } from './tern-pane-geometry.mjs'

/** The oracle's `rect` made TOTAL for a node the client does not paint: the
 *  negative case (an auto-hidden column, a virtualised row, an absent value
 *  node) must FAIL its own assertion, never throw the whole flow. */
const rect = (node) => (node === undefined ? [0, 0, 0, 0] : rawRect(node))

/* ------------------------------------------------------------ the record */

/** Every row the subject recorded, re-read on each call (it appends as it runs). */
const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((row) => row.caps)?.caps
const rowEvents = (h) => records(h).filter((row) => row.event && (row.event.ev === 'select' || row.event.ev === 'activate')).map((row) => row.event)
const actionEvents = (h) => records(h).filter((row) => row.event && row.event.ev === 'action').map((row) => row.event)
const applies = (h) => records(h).filter((row) => row.apply)
const retries = (h) => records(h).filter((row) => row.retry)
const controls = (h) => records(h).filter((row) => row.control).map((row) => row.control)
const resizes = (h) => records(h).filter((row) => row.resize).map((row) => row.resize)
const scrolls = (h) => records(h).filter((row) => row.nativeScroll).map((row) => row.nativeScroll)

/* ------------------------------------------------------------- the tree */

const box = (node) => (node === undefined ? 'none' : rect(node).map((n) => Math.round(n * 10) / 10).join(','))
const actionIds = (frame) => (frame?.actions ?? []).map((action) => action.id).join(',')
const actionLabels = (frame) => (frame?.actions ?? []).map((action) => String(action.label ?? '')).join(' | ')
const pickerNode = (snap) => snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-picker'))
const pickerClasses = (snap) => (pickerNode(snap)?.class ?? '').split(' ').filter(Boolean)
const modelRows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => !(node.class ?? '').split(' ').includes('grp'))
const groupRows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => (node.class ?? '').split(' ').includes('grp'))
const rowWithText = (h, snap, text) => modelRows(h, snap).find((node) => h.descendantsText(node).includes(text))
const groupWithText = (h, snap, text) => groupRows(h, snap).find((node) => h.descendantsText(node).includes(text))
const buttons = (h, snap) => h.classNodes(snap, 'pk-btn')
const subclass = (node, name) => {
  const out = []
  const walk = (n) => {
    if ((n.class ?? '').split(' ').includes(name)) out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  if (node !== undefined) walk(node)
  return out
}
const markText = (h, node) => subclass(node, 'pk-mark').map((n) => String(n.text ?? '')).join('')
const scopeTokens = (snap) => [...new Set(snap.nodes.flatMap((node) => (node.class ?? '').split(' ')).filter((token) => /scope/i.test(token)))]
const textStarting = (snap, prefix) => snap.nodes.find((node) => String(node.text ?? '').startsWith(prefix))
const textExactly = (snap, text) => snap.nodes.find((node) => String(node.text ?? '') === text)
/** A text node with EXACTLY `text` inside an ancestor of class `ancestorClass`
 *  (the Reader's overlay HEAD and its body VALUE can share a string but not a
 *  line height, so the one-line control must be the body value). */
const textUnder = (snap, text, ancestorClass) => snap.nodes.find((node) => String(node.text ?? '') === text
  && (snap.chains.get(node) ?? []).some((ancestor) => (ancestor.class ?? '').split(' ').includes(ancestorClass)))
const itemOf = (frame, id) => (frame?.items ?? []).find((item) => item.id === id)
const FACT_COLUMN = JSON.stringify([{ id: 'effort', head: 'Effort', format: 'text', priority: 1, min: 6 }])
/** The plan §9 acceptance sizes: each one gets a `models` / `overview` / `reader`
 *  PNG (12 captures) in the matrix pass. */
const SECTION9 = new Set(['1280x800', '1000x640', '560x640', '400x600'])
/** The SHA-256 of the four source modules this run rendered, so the evidence
 *  names the exact contract revision it was taken against. */
const sourceHash = (h) => ['model-picker-view.ts', 'model-picker-state.ts', 'model-picker-intents.ts', 'model-picker.ts']
  .map((name) => `${name}:${createHash('sha256').update(readFileSync(join(h.repo, 'src', 'tui', 'tsp', name))).digest('hex').slice(0, 12)}`)
  .join(' ')
/** The client's own capture layout: its resolved fonts, colours and THEME. */
const layoutOf = (h, shotId) => JSON.parse(readFileSync(join(h.root, 'shots', 'serve', `${shotId}.layout.json`), 'utf8'))
const elementAt = (h, shotId, needle) => {
  const layout = layoutOf(h, shotId)
  const element = layout.elements.find((entry) => String(entry.path).includes(needle))
  return element === undefined ? undefined : { ...element, theme: layout.theme }
}
const themeOf = (h, shotId) => layoutOf(h, shotId).theme
const fontAt = (h, shotId, needle) => {
  const element = elementAt(h, shotId, needle)
  return element === undefined
    ? undefined
    : { path: element.path, fontFamily: element.fontFamily, fontSize: element.fontSize, theme: element.theme }
}

/* ------------------------------------------------------- shared navigations */

/** Walk Esc back to the catalogue, NEVER past it (Esc on the catalogue dismisses
 *  the panel), so a lost panel fails the next claim instead of cascading. */
const toCatalogue = async (h) => {
  for (let step = 0; step < 6; step += 1) {
    const frame = lastFrame(h)
    if (frame === undefined || frame.page === 'models') return true
    await h.key('Escape', 800)
  }
  return lastFrame(h)?.page === 'models'
}

/** Enter the highlighted model's Overview with a real Enter. */
const enterOverview = async (h) => {
  await h.key('Return', 900)
  return lastFrame(h)?.page === 'overview'
}

/** Click the Overview's `View full model details ›` row with a real pointer. On a
 *  SHORT pane the row can be below the Overview's own list fold, so the cursor is
 *  walked onto it with real line keys first (the client scrolls it into view);
 *  a row that is already visible is clicked immediately. */
const openReaderByPointer = async (h, maxSteps = 8) => {
  for (let step = 0; step <= maxSteps; step += 1) {
    const snap = h.snapshot()
    const row = rowWithText(h, snap, 'View full model details')
    if (row !== undefined && containedXY(snap.chains, row)) return await h.click(snap.chains, row)
    await h.key('Down', 220)
  }
  return false
}

/**
 * One plan §3.3 matrix size on the list-first revision. It asserts the presenter's
 * claim against the client's OWN classes, the containment of what the client
 * paints, and — for a narrow pane — the Overview path that pane depends on, so the
 * matrix proves reachability instead of echoing the presenter. `cols`/`cell.w` are
 * recorded for every size.
 */
const matrixCell = async (h, size) => {
  await toCatalogue(h)
  await h.resize(size.w, size.h)
  const snap = h.snapshot()
  const frame = lastFrame(h)
  const resize = resizes(h).at(-1)
  const cols = resize?.cols
  const cell = resize?.cell?.w
  const panePx = cols * cell
  const wide = panePx >= 900
  h.measure(`${size.w}x${size.h}: cols/cell.w/pane px`, JSON.stringify({ cols, cell, panePx }))
  h.check(`${size.w}x${size.h}: the presenter claims ${wide ? 'lg + preview below' : 'md + preview none'} at ${panePx}px`,
    frame?.page === 'models' && frame?.size === (wide ? 'lg' : 'md') && frame?.preview === (wide ? 'below' : 'none'),
    JSON.stringify({ page: frame?.page, size: frame?.size, preview: frame?.preview, cols, cell, panePx }))
  const classes = pickerClasses(snap)
  h.check(`${size.w}x${size.h}: the client's own classes agree (${wide ? 'sz-lg pv-below' : 'sz-md pv-none'})`,
    wide
      ? classes.includes('sz-lg') && classes.includes('pv-below') && !classes.includes('pv-none')
      : classes.includes('sz-md') && classes.includes('pv-none') && !classes.includes('pv-below'),
    classes.join(' '))
  const preview = h.classNodes(snap, 'pk-pv')
  h.check(`${size.w}x${size.h}: the client paints ${wide ? 'the real below-list preview' : 'no preview region at all'}`,
    wide ? preview.length === 1 && containedXY(snap.chains, preview[0]) : preview.length === 0,
    `pk-pv=${preview.length}${preview[0] === undefined ? '' : `@${box(preview[0])}`}`)
  const barButtons = buttons(h, snap)
  h.check(`${size.w}x${size.h}: the footer is exactly Cancel + the one write, both contained`,
    barButtons.length === 2 && actionIds(frame) === 'close,apply' && (frame?.actions ?? []).filter((action) => action.id === 'apply').length === 1
    && barButtons.every((node) => containedXY(snap.chains, node)),
    `${barButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' ')} :: ${actionIds(frame)}`)
  const rows = modelRows(h, snap)
  const scroller = h.classNodes(snap, 'pk-scroll')[0]
  // A list that must scroll at a SHORT pane legitimately clips the rows below its
  // fold (the plan's short-height rule: the native list scrolls on its own and
  // keeps the selected row). This therefore asserts what the contract really
  // requires — the list region and its FIRST row are fully usable — and records
  // every partially visible row with its exact visible span instead of counting it
  // as contained. The rows below the fold are PROVED reachable with real line keys
  // immediately below, and the count of clipped rows is a measurement, never a
  // silent pass.
  const rowSpans = (snapshot) => modelRows(h, snapshot).map(
    (node) => `${h.descendantsText(node).slice(0, 24)}@${box(node)} yspan=${visibleSpan(snapshot.chains, node, 'y').toFixed(1)}`,
  )
  const clippedRows = rows.filter((node) => !containedXY(snap.chains, node))
  h.check(`${size.w}x${size.h}: the catalogue's first model row is fully contained in its list region`,
    rows.length > 0 && containedXY(snap.chains, rows[0]),
    `scroller@${box(scroller)} :: ${rowSpans(snap).join(' | ')}`)
  if (clippedRows.length > 0) {
    h.measure(`${size.w}x${size.h}: model rows clipped by the list fold at this SHORT pane`,
      clippedRows.map((node) => `${h.descendantsText(node).slice(0, 24)}@${box(node)} yspan=${visibleSpan(snap.chains, node, 'y').toFixed(1)}`).join(' | '))
  }
  h.check(`${size.w}x${size.h}: the catalogue paints no scope column`, scopeTokens(snap).length === 0
    && !(frame?.propKeys ?? []).includes('scopes'), `${scopeTokens(snap).join(',')} :: ${(frame?.propKeys ?? []).join(',')}`)
  // The ONE optional fact COLUMN. The wire declares it on every catalogue width;
  // the client paints it from 560px up and auto-hides it at 400x600 (measured),
  // and it paints on the FIRST group row as the table head.
  const narrowest = size.w === 400 && size.h === 600
  const factSlots = h.classNodes(snap, 'pk-facts')
  const headerItem = h.classNodes(snap, 'pk-fact').find((node) => (node.class ?? '').split(' ').includes('pk-fh'))
  const firstGroup = groupRows(h, snap)[0]
  h.check(`${size.w}x${size.h}: the wire declares the ONE effort column at every width`,
    JSON.stringify(frame?.columns) === FACT_COLUMN, JSON.stringify(frame?.columns))
  h.check(`${size.w}x${size.h}: the client really paints the Effort header (auto-hidden at 400x600)`,
    narrowest
      ? factSlots.length === 0 && headerItem === undefined
      : headerItem !== undefined && String(headerItem.text) === 'Effort' && containedXY(snap.chains, headerItem),
    `slots=${factSlots.length} header=${headerItem === undefined ? 'none' : String(headerItem.text)}`)
  h.check(`${size.w}x${size.h}: the Effort header sits on the FIRST group row`,
    narrowest
      ? firstGroup !== undefined && subclass(firstGroup, 'pk-fact').length === 0
      : firstGroup !== undefined && subclass(firstGroup, 'pk-fact').some((node) => String(node.text) === 'Effort'),
    firstGroup === undefined ? 'no group row' : h.descendantsText(firstGroup))
  const metrics = {
    labelWidth: rect(subclass(rowWithText(h, snap, 'Alpha Model'), 'pk-label')[0])[2],
    factsWidth: rect(factSlots[0])[2],
    textWidth: rect(h.classNodes(snap, 'pk-txt')[0])[2],
  }
  if (!narrowest) {
    h.measure(`${size.w}x${size.h}: model-name / fact-column / text widths`, JSON.stringify(metrics))
  }
  // Reachability: the list's own line keys really walk to the LAST model row (the
  // client scrolls the highlighted row into view), and the cursor is then walked
  // back to the first row so the rest of the cell describes the same model.
  let downSteps = 0
  let reachedLastRow = false
  for (let step = 0; step < 12 && !reachedLastRow; step += 1) {
    await h.key('Down', 200)
    downSteps += 1
    const walked = h.snapshot()
    const lastRow = modelRows(h, walked).at(-1)
    reachedLastRow = lastRow !== undefined && containedXY(walked.chains, lastRow)
  }
  const walkedLast = modelRows(h, h.snapshot()).at(-1)
  h.check(`${size.w}x${size.h}: the list's own line keys reach the LAST model row`,
    reachedLastRow && walkedLast !== undefined,
    `steps=${downSteps} :: ${walkedLast === undefined ? 'no row' : `${h.descendantsText(walkedLast).slice(0, 24)}@${box(walkedLast)}`}`)
  for (let step = 0; step < downSteps; step += 1) await h.key('Up', 120)
  const cellKey = `${size.w}x${size.h}`
  const captured = narrowest
    ? h.capture(`models-${cellKey}`, `the ${cellKey} catalogue: same rows, same one write, no preview`)
    : size.w === 900 && size.h === 400
      ? h.capture(`models-${cellKey}`, 'the short 900x400 catalogue: the list is squeezed before the summary line')
      : SECTION9.has(cellKey)
        ? h.capture(`models-${cellKey}`, `the ${cellKey} catalogue (plan §9)`)
        : undefined
  // ---- Overview at EVERY size, not only the narrow branch: Enter must open it,
  // the effort head and the FIRST candidate must be contained, every advertised
  // candidate must be LISTED, the LAST must be reachable with real line keys and
  // Esc must return. (This preserves the short-900x400 rule the reviewer fixed:
  // clipped candidates are recorded as measurements, never counted as contained.)
  const opened = await enterOverview(h)
  const overview = h.snapshot()
  const overviewFrame = lastFrame(h)
  const overviewIds = (overviewFrame?.items ?? []).map((item) => String(item.id))
  const candidateIds = overviewIds.filter((id) => id.startsWith('effort:'))
  const modelName = itemOf(frame, frame?.selected)?.label
  const modelId = itemOf(frame, frame?.selected)?.title
  // The page's TITLE cannot carry the identity on a narrow pane (the client
  // ellipsizes the caption and paints no subtitle at 400/560px — measured), so the
  // model the page configures must be visible as the FIRST main-list ROW at EVERY
  // width. A full `title` PROP is not proof: the ROW itself is asserted painted.
  const identityWire = (overviewFrame?.items ?? []).filter((item) => String(item.id) === 'overview-model')
  const identityRow = rowWithText(h, overview, String(modelName))
  const firstDomRow = modelRows(h, overview)[0]
  h.check(`${cellKey}: the Overview leads with the model's identity row (overview-model)`,
    identityWire.length === 1 && overviewIds[0] === 'overview-model'
    && identityWire[0].label === modelName && identityWire[0].title === modelId,
    JSON.stringify({ order: overviewIds, identity: identityWire[0], expected: { label: modelName, title: modelId } }))
  h.check(`${cellKey}: the identity row is PAINTED as the first main-list row, carrying the model name`,
    identityRow !== undefined && containedXY(overview.chains, identityRow)
    && firstDomRow !== undefined && h.descendantsText(firstDomRow).includes(String(modelName)),
    `identity@${box(identityRow)} firstRow=${firstDomRow === undefined ? 'none' : h.descendantsText(firstDomRow).slice(0, 44)}`)
  const head = rowWithText(h, overview, 'Reasoning effort')
  h.check(`${cellKey}: Enter opens the Overview under the short page title`,
    opened && overviewFrame?.page === 'overview' && overviewFrame?.title === 'Model overview', JSON.stringify(overviewFrame))
  h.check(`${cellKey}: the Reasoning effort head is on the Overview's first screen`,
    head !== undefined && containedXY(overview.chains, head), head === undefined ? 'no head row' : box(head))
  const domRows = modelRows(h, overview)
  const paired = domRows.map((node, index) => ({ id: overviewIds[index], node }))
  const candidates = paired.filter((entry) => String(entry.id).startsWith('effort:'))
  // The short-pane rule again: the Overview's own list scrolls, so the contract
  // requires the head and the FIRST candidate on the first screen and every
  // candidate to be LISTED and reachable — a candidate below the fold is
  // measured, not counted as contained.
  const clippedCandidates = candidates.filter((entry) => !containedXY(overview.chains, entry.node))
  h.check(`${cellKey}: the effort head and the FIRST candidate are contained on the first screen`,
    candidates.length > 0 && containedXY(overview.chains, candidates[0].node),
    `${candidateIds.length} advertised, ${candidates.length} painted: ${candidates.map((entry) => `${entry.id}@${box(entry.node)} yspan=${visibleSpan(overview.chains, entry.node, 'y').toFixed(1)}`).join(' ')}`)
  // The WIRE must carry every advertised candidate on every pane. How many of them
  // are PAINTED AT ONCE is the client's own virtualisation: on a TALL pane all four
  // are mounted, while the short 900x400 pane mounts only the rows inside its
  // scrollport (the rest scroll in — proved right below). So the painted count is
  // an ASSERTION on every pane tall enough to show them and a MEASUREMENT, never a
  // silent pass, on the one measured short pane.
  const shortPane = size.h < 600
  h.check(`${cellKey}: the Overview's main list carries all ${candidateIds.length} advertised candidates`,
    candidateIds.length === 4 && (!shortPane || candidates.length > 0)
    && (shortPane || candidates.length === candidateIds.length),
    `${candidateIds.length} advertised, ${candidates.length} painted${shortPane ? ' (short pane)' : ''}`)
  if (shortPane) {
    h.measure(`${cellKey}: candidates the short Overview paints at once`,
      `${candidates.length}/${candidateIds.length}`)
  }
  if (clippedCandidates.length > 0) {
    h.measure(`${cellKey}: candidates clipped by the Overview's own fold at this SHORT pane`,
      clippedCandidates.map((entry) => `${entry.id}@${box(entry.node)} yspan=${visibleSpan(overview.chains, entry.node, 'y').toFixed(1)}`).join(' '))
  }
  if (candidates.length < candidateIds.length) {
    h.measure(`${cellKey}: candidates the short Overview paints at once`, `${candidates.length}/${candidateIds.length}`)
  }
  if (SECTION9.has(cellKey)) h.capture(`overview-${cellKey}`, `the ${cellKey} Overview: identity row + every advertised candidate (plan §9)`)
  // Reachability bounds the first-screen finding: the Overview's own list really
  // scrolls with real line keys, so a candidate below the fold is still reachable.
  let candidateDowns = 0
  let candidateReached = false
  while (candidateDowns < 8 && !candidateReached) {
    const walkedNow = h.snapshot()
    const highNow = rowWithText(h, walkedNow, 'High')
    candidateReached = highNow !== undefined && containedXY(walkedNow.chains, highNow)
    if (!candidateReached) {
      await h.key('Down', 250)
      candidateDowns += 1
    }
  }
  const walked = h.snapshot()
  const last = rowWithText(h, walked, 'High')
  h.check(`${cellKey}: the LAST effort candidate is reachable with real line keys`,
    last !== undefined && containedXY(walked.chains, last),
    `steps=${candidateDowns} :: ${last === undefined ? 'no High row' : box(last)}`)
  // ---- The Reader from that Overview, by a REAL pointer click (every size).
  const readerOpened = await openReaderByPointer(h)
  const readerSnap = h.snapshot()
  h.check(`${cellKey}: the details row opens the Reader by a real pointer click`,
    readerOpened && lastFrame(h)?.page === 'details', `opened=${readerOpened} :: ${JSON.stringify(lastFrame(h)?.page)}`)
  h.check(`${cellKey}: the Reader REPLACES the picker (no picker, no footer buttons)`,
    h.classNodes(readerSnap, 'sf-picker').length === 0 && h.classNodes(readerSnap, 'pk-btn').length === 0,
    `sf-picker=${h.classNodes(readerSnap, 'sf-picker').length} pk-btn=${h.classNodes(readerSnap, 'pk-btn').length}`)
  h.check(`${cellKey}: the Reader overlay head is the MODEL NAME`,
    modelName !== undefined && lastFrame(h)?.head === modelName,
    `${JSON.stringify(lastFrame(h)?.head)} expected ${JSON.stringify(modelName)}`)
  const readerBack = h.classNodes(readerSnap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')
  const readerHead = textExactly(readerSnap, 'Identity')
  h.check(`${cellKey}: the Reader's visible Back row and first group head are contained`,
    readerBack !== undefined && containedXY(readerSnap.chains, readerBack)
    && readerHead !== undefined && containedXY(readerSnap.chains, readerHead),
    `Back@${box(readerBack)} Identity@${box(readerHead)}`)
  if (SECTION9.has(cellKey)) h.capture(`reader-${cellKey}`, `the ${cellKey} Reader top (plan §9)`)
  await h.key('Escape', 900)
  const returned = h.snapshot()
  const returnedIdentity = rowWithText(h, returned, String(modelName))
  // The Overview keeps the list's scroll position across the Reader round trip, so
  // at a SHORT pane the identity row can sit above the fold: the return is proved
  // by the page/title and by the identity row still being in the list (its exact
  // span is recorded), not by it being on screen again.
  h.check(`${cellKey}: Esc returns the Reader to the Overview it came from, identity row in the list`,
    lastFrame(h)?.page === 'overview' && lastFrame(h)?.title === 'Model overview'
    && returnedIdentity !== undefined,
    JSON.stringify({ page: lastFrame(h)?.page, title: lastFrame(h)?.title, identity: box(returnedIdentity), yspan: visibleSpan(returned.chains, returnedIdentity, 'y').toFixed(1) }))
  await h.key('Escape', 900)
  h.check(`${cellKey}: Esc returns the Overview to the catalogue`, lastFrame(h)?.page === 'models', JSON.stringify(lastFrame(h)))
  return { captured, metrics, narrowest, width: size.w }
}

/* ------------------------------------------------------------------- flow */

export default async function (h) {
  // ------------------------------------------------- claim 1: boot at 1280x800
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-model-ux-subject.mts')
  const booted = await h.launch(subject, { ready: 'Switch model' })
  h.check('the production list-first model picker boots inside a real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return

  let snap = h.snapshot()
  let frame = lastFrame(h)
  const bootShot = h.capture('catalogue-1280x800', 'the wide list-first catalogue with its below-list summary')
  h.check('boot: the presenter paints the list-first catalogue under its live title',
    frame?.page === 'models' && frame?.title === 'Switch model', JSON.stringify(frame))
  h.check('boot: the catalogue subtitle is the ONE hint',
    frame?.subtitle === 'Enter: effort & details' && h.has(snap, 'Enter: effort & details'),
    `${JSON.stringify(frame?.subtitle)} :: ${h.texts(snap).slice(0, 8).join(' | ')}`)
  const bootClasses = pickerClasses(snap)
  h.check('boot: the client really paints sz-lg + pv-below (never pv-hide / pv-none)',
    bootClasses.includes('sz-lg') && bootClasses.includes('pv-below') && !bootClasses.includes('pv-hide') && !bootClasses.includes('pv-none'),
    bootClasses.join(' '))
  h.check('boot: the presenter asks for lg + preview below', frame?.size === 'lg' && frame?.preview === 'below',
    JSON.stringify({ size: frame?.size, preview: frame?.preview }))
  // The below-list summary is the HIGHLIGHTED model's real read-only facts.
  const preview = h.classNodes(snap, 'pk-pv')
  const kv = h.classNodes(snap, 'sf-kv')[0]
  h.check('boot: the below-list summary is painted and contained',
    preview.length === 1 && containedXY(snap.chains, preview[0]) && kv !== undefined,
    `pk-pv=${preview.length}@${box(preview[0])}`)
  const expectedSummary = JSON.stringify([
    { k: 'Provider', v: 'Alpha Provider' },
    { k: 'Draft effort', v: 'Medium' },
    { k: 'Selection', v: 'current' },
  ])
  h.check('boot: the summary is a kv node whose items are the HIGHLIGHTED model\'s real facts',
    JSON.stringify(frame?.summary) === expectedSummary, `${JSON.stringify(frame?.summary)} expected ${expectedSummary}`)
  h.check('boot: the client paints those summary facts',
    kv !== undefined && ['Provider', 'Alpha Provider', 'Draft effort', 'Medium', 'Selection', 'current'].every((text) => h.descendantsText(kv).includes(text)),
    kv === undefined ? 'no sf-kv' : h.descendantsText(kv))
  // The picked row: provider mark, real badges; one row per (provider, model).
  const picked = rowWithText(h, snap, 'Alpha Model')
  const defaulted = rowWithText(h, snap, 'Beta Model')
  h.check('boot: the picked model row carries its provider mark and its real current badge',
    picked !== undefined && markText(h, picked) === 'AP'
    && subclass(picked, 'pk-badge').some((node) => String(node.text) === 'current'),
    picked === undefined ? 'no picked row' : `${markText(h, picked)} :: ${h.descendantsText(picked)}`)
  h.check('boot: the default row carries the Default badge and never a fake current',
    defaulted !== undefined && subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'Default')
    && !subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'current'),
    defaulted === undefined ? 'no default row' : h.descendantsText(defaulted))
  h.check('boot: every model appears exactly once (one row per provider+model)',
    ['Alpha Model', 'Alpha Second', 'Beta Model'].every((label) => modelRows(h, snap).filter((node) => h.descendantsText(node).includes(label)).length === 1),
    modelRows(h, snap).map((node) => h.descendantsText(node)).join(' | '))
  // The ONE optional fact column, fed with the already-seeded draft on the wire
  // and painted by the client in the model's own row.
  const currentRowId = JSON.stringify(['alpha', 'm-alpha'])
  const noEffortRowId = JSON.stringify(['alpha', 'm-alpha2'])
  const defaultRowId = JSON.stringify(['beta', 'm-beta'])
  h.check('boot: the catalogue declares the ONE effort column (models page only)',
    JSON.stringify(frame?.columns) === FACT_COLUMN, JSON.stringify(frame?.columns))
  h.check('boot: the model advertising efforts carries its drafted effort LABEL as its fact',
    itemOf(frame, currentRowId)?.facts?.effort === 'Medium', JSON.stringify(itemOf(frame, currentRowId)?.facts))
  h.check('boot: a model with NO effort metadata carries no facts at all',
    itemOf(frame, noEffortRowId)?.facts === undefined && itemOf(frame, defaultRowId)?.facts === undefined,
    `${JSON.stringify(itemOf(frame, noEffortRowId)?.facts)} / ${JSON.stringify(itemOf(frame, defaultRowId)?.facts)}`)
  const bootFactHeader = h.classNodes(snap, 'pk-fact').find((node) => (node.class ?? '').split(' ').includes('pk-fh'))
  h.check('boot: the client paints the Effort header and the drafted fact, both contained',
    bootFactHeader !== undefined && String(bootFactHeader.text) === 'Effort' && containedXY(snap.chains, bootFactHeader)
    && subclass(picked, 'pk-fact').some((node) => String(node.text) === 'Medium')
    && subclass(defaulted, 'pk-fact').length === 0,
    `header=${bootFactHeader === undefined ? 'none' : box(bootFactHeader)} picked=${subclass(picked, 'pk-fact').map((node) => String(node.text)).join(',')} default=${subclass(defaulted, 'pk-fact').length}`)
  const bootGroups = groupRows(h, snap)
  h.check('boot: the pinned Current / Default group is the FIRST group',
    bootGroups.length >= 1 && h.descendantsText(bootGroups[0]).includes('Current / Default'),
    bootGroups.map((node) => h.descendantsText(node)).join(' | '))
  const bootButtons = buttons(h, snap)
  h.check('boot: the footer is exactly Cancel + the one write, both contained',
    bootButtons.length === 2 && actionIds(frame) === 'close,apply' && actionLabels(frame).includes('Cancel') && actionLabels(frame).includes('Switch')
    && bootButtons.every((node) => containedXY(snap.chains, node)),
    `${bootButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' ')} :: ${actionIds(frame)}`)
  h.check('boot: no scope column anywhere (client classes or presenter props)',
    scopeTokens(snap).length === 0 && !(frame?.propKeys ?? []).includes('scopes'),
    `${scopeTokens(snap).join(',')} :: ${(frame?.propKeys ?? []).join(',')}`)

  // --------------------------------------------- claim 2: the full size matrix
  let narrowShot
  const columnMetrics = []
  for (const size of [
    { w: 400, h: 600 }, { w: 560, h: 640 }, { w: 900, h: 400 }, { w: 1000, h: 640 },
    { w: 1020, h: 640 }, { w: 1040, h: 640 }, { w: 1050, h: 700 }, { w: 1100, h: 640 },
    { w: 1280, h: 600 }, { w: 1280, h: 800 },
  ]) {
    const cell = await matrixCell(h, size)
    if (cell.captured !== undefined && size.w === 400 && size.h === 600) narrowShot = cell.captured
    columnMetrics.push({ size: `${size.w}x${size.h}`, painted: !cell.narrowest, ...cell.metrics })
  }
  // The measured column budget: the client gives the fact column a FIXED slot
  // while the model NAME keeps its own intrinsic width, at every painted size.
  const labelWidths = [...new Set(columnMetrics.map((entry) => entry.labelWidth))]
  const factsWidths = [...new Set(columnMetrics.filter((entry) => entry.painted).map((entry) => entry.factsWidth))]
  h.check('the fact column is a FIXED client budget across every painted size',
    factsWidths.length === 1 && factsWidths[0] > 0,
    JSON.stringify(columnMetrics))
  h.check('the model NAME keeps its intrinsic width at every size (even with the column hidden)',
    labelWidths.length === 1 && labelWidths[0] > 0,
    JSON.stringify(columnMetrics))

  // --------------------------------------- claim 3: row events by REAL pointer
  h.check('row events: the matrix left the pane on the catalogue', await toCatalogue(h) && lastFrame(h)?.page === 'models',
    JSON.stringify(lastFrame(h)))
  await h.resize(1280, 800)
  snap = h.snapshot()
  const otherRow = rowWithText(h, snap, 'Alpha Second')
  const eventsBefore = rowEvents(h).length
  const appliedBefore = applies(h).length
  const selected = otherRow === undefined ? false : await h.click(snap.chains, otherRow)
  const selectEvents = rowEvents(h).slice(eventsBefore)
  h.check('one REAL pointer click on a NON-highlighted row emits select and only moves the highlight',
    selected && selectEvents.length === 1 && selectEvents[0].ev === 'select'
    && selectEvents[0].item === JSON.stringify(['alpha', 'm-alpha2'])
    && lastFrame(h)?.page === 'models' && lastFrame(h)?.selected === JSON.stringify(['alpha', 'm-alpha2'])
    && applies(h).length === appliedBefore,
    `${JSON.stringify(selectEvents)} :: selected=${JSON.stringify(lastFrame(h)?.selected)}`)
  snap = h.snapshot()
  const sameRow = rowWithText(h, snap, 'Alpha Second')
  const activateBefore = rowEvents(h).length
  const activated = sameRow === undefined ? false : await h.click(snap.chains, sameRow)
  const activateEvents = rowEvents(h).slice(activateBefore)
  const activatedOverview = lastFrame(h)
  h.check('one REAL pointer click on the HIGHLIGHTED row emits activate and enters THAT model\'s Overview',
    activated && activateEvents.length === 1 && activateEvents[0].ev === 'activate'
    && activateEvents[0].item === JSON.stringify(['alpha', 'm-alpha2'])
    && activatedOverview?.page === 'overview' && activatedOverview?.title === 'Model overview'
    && (activatedOverview?.items ?? [])[0]?.id === 'overview-model'
    && (activatedOverview?.items ?? [])[0]?.label === 'Alpha Second',
    `${JSON.stringify(activateEvents)} :: ${JSON.stringify({ page: activatedOverview?.page, first: (activatedOverview?.items ?? [])[0] })}`)
  h.measure('the raw select/activate events of claim 3', JSON.stringify([...selectEvents, ...activateEvents]))

  // ------------------------------------------------------------ claim 4: Overview
  await toCatalogue(h)
  await h.key('Up', 400)   // from Alpha Second back onto the current model
  h.check('the catalogue cursor moved onto the current model with a real key',
    lastFrame(h)?.selected === JSON.stringify(['alpha', 'm-alpha']), JSON.stringify(lastFrame(h)?.selected))
  const overviewOpened = await enterOverview(h)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('Enter opens the highlighted model\'s Overview under its short page title',
    overviewOpened && frame?.title === 'Model overview',
    JSON.stringify({ page: frame?.page, title: frame?.title }))
  h.check('the Overview subtitle is the model\'s provider · current',
    frame?.subtitle === 'Alpha Provider · current', JSON.stringify(frame?.subtitle))
  const claimIdentity = (frame?.items ?? []).find((item) => String(item.id) === 'overview-model')
  const claimIdentityRow = rowWithText(h, snap, 'Alpha Model')
  h.check('the Overview leads with the model identity row: name as label, complete id as title',
    (frame?.items ?? [])[0]?.id === 'overview-model'
    && claimIdentity?.label === 'Alpha Model' && claimIdentity?.title === 'm-alpha'
    && claimIdentityRow !== undefined && containedXY(snap.chains, claimIdentityRow),
    JSON.stringify({ first: (frame?.items ?? [])[0], row: box(claimIdentityRow) }))
  h.check('the Overview then leads into Reasoning effort, every candidate, then the details entry',
    (frame?.items ?? [])[1]?.label === 'Reasoning effort'
    && (frame?.items ?? []).at(-1)?.label === 'View full model details ›'
    && ['Default', 'Low', 'Medium', 'High'].every((label) => (frame?.items ?? []).some((item) => item.label === label)),
    JSON.stringify((frame?.items ?? []).map((item) => `${item.id}:${item.label}`)))
  h.check('the Overview declares NO effort column, so its rows paint no fact cell',
    (frame?.columns ?? []).length === 0 && h.classNodes(snap, 'pk-fact').length === 0,
    `columns=${JSON.stringify(frame?.columns)} pk-fact=${h.classNodes(snap, 'pk-fact').length}`)
  const overviewButtons = buttons(h, snap)
  h.check('the Overview footer is Back + the one write, both contained',
    overviewButtons.length === 2 && actionIds(frame) === 'back,apply' && overviewButtons.every((node) => containedXY(snap.chains, node)),
    `${overviewButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' ')} :: ${actionIds(frame)}`)
  const overviewShot = h.capture('overview-effort-1280x800', 'the model Overview with every advertised effort candidate (claim 4)')

  const highRow = rowWithText(h, snap, 'High')
  const writesBefore = applies(h).length
  const draftEventsBefore = rowEvents(h).length
  const drafted = highRow === undefined ? false : await h.click(snap.chains, highRow)
  const draftEvents = rowEvents(h).slice(draftEventsBefore)
  h.check('one REAL pointer click on an effort row drafts it with zero writes',
    drafted && draftEvents.some((event) => event.ev === 'select' && event.item === 'effort:high') && applies(h).length === writesBefore,
    `${JSON.stringify(draftEvents)} :: applies=${applies(h).length}`)
  const draftedSnap = h.snapshot()
  const highNow = rowWithText(h, draftedSnap, 'High')
  const mediumNow = rowWithText(h, draftedSnap, 'Medium')
  h.check('the draft mark really moved to the clicked candidate (● there, ○ before)',
    highNow !== undefined && markText(h, highNow).includes('●') && mediumNow !== undefined && markText(h, mediumNow).includes('○'),
    `High=${highNow === undefined ? '?' : markText(h, highNow)} Medium=${mediumNow === undefined ? '?' : markText(h, mediumNow)}`)

  const readerOpened = await openReaderByPointer(h)
  h.check('a REAL pointer click on the details entry enters the Reader',
    readerOpened && lastFrame(h)?.page === 'details', JSON.stringify({ opened: readerOpened, page: lastFrame(h)?.page }))
  h.check('the Reader REPLACES the picker and its head is the MODEL NAME',
    h.classNodes(h.snapshot(), 'pk-btn').length === 0 && h.has(h.snapshot(), 'Alpha Model') && lastFrame(h)?.head === 'Alpha Model',
    `buttons=${h.classNodes(h.snapshot(), 'pk-btn').length} head=${JSON.stringify(lastFrame(h)?.head)}`)
  await h.key('Escape', 900)
  h.check('Esc returns from the Reader to the Overview it came from',
    lastFrame(h)?.page === 'overview' && lastFrame(h)?.title === 'Model overview'
    && (lastFrame(h)?.items ?? [])[0]?.id === 'overview-model'
    && (lastFrame(h)?.items ?? [])[0]?.label === 'Alpha Model', JSON.stringify(lastFrame(h)))

  snap = h.snapshot()
  const primary = buttons(h, snap).find((node) => (node.class ?? '').split(' ').includes('primary'))
  const writeBefore = applies(h).length
  const primaryClicked = primary === undefined ? false : await h.click(snap.chains, primary)
  const applied = applies(h)
  h.check('one REAL click on the primary writes EXACTLY once with the drafted effort',
    primaryClicked && applied.length === writeBefore + 1
    && applied.at(-1).apply.selection.provider === 'alpha' && applied.at(-1).apply.selection.model === 'm-alpha'
    && applied.at(-1).apply.selection.reasoningEffort === 'high',
    `clicked=${primaryClicked} applies=${JSON.stringify(applied)}`)
  h.check('the admitted write renders its pending footer',
    frames(h).some((entry) => (entry.actions ?? []).some((action) => action.id === 'apply' && action.label === 'Selecting…')),
    frames(h).slice(-4).map((entry) => `${entry.title}:${actionIds(entry)}:${actionLabels(entry)}`).join(' | '))
  // An admitted write refuses every page operation, so its bar renders Close + the
  // disabled write and NO clickable Back: every frame that really carried the
  // pending state is checked, not just whichever one a snapshot happens to catch.
  const pendingFrames = frames(h).filter(
    (entry) => (entry.actions ?? []).some((action) => action.id === 'apply' && action.label === 'Selecting…'),
  )
  h.check('every pending Overview frame offers no clickable Back',
    pendingFrames.length > 0
    && pendingFrames.every((entry) => (entry.actions ?? []).every((action) => action.id !== 'back')),
    pendingFrames.map((entry) => actionIds(entry)).join(' | '))
  // The (refused) write settles back to the page's own Back, which then returns.
  let backRestored = false
  for (let step = 0; step < 20 && !backRestored; step += 1) {
    await h.sleep(150)
    backRestored = (lastFrame(h)?.actions ?? []).some((action) => action.id === 'back')
  }
  h.check('the settled Overview restores its Back', backRestored, JSON.stringify(lastFrame(h)?.actions))
  snap = h.snapshot()
  const backButton = buttons(h, snap).find((node) => h.descendantsText(node) === 'Back')
  const backClicked = backButton === undefined ? false : await h.click(snap.chains, backButton)
  h.check('the Overview Back returns to the catalogue',
    backClicked && lastFrame(h)?.page === 'models', `clicked=${backClicked} :: ${JSON.stringify(lastFrame(h)?.page)}`)
  h.check('the catalogue fact column reflects the draft changed on the Overview',
    itemOf(lastFrame(h), currentRowId)?.facts?.effort === 'High',
    JSON.stringify(itemOf(lastFrame(h), currentRowId)?.facts))

  // --------------------------------------------------------------- claim 5: Reader
  await toCatalogue(h)
  await h.key('3', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('the long-value fixture is a live catalogue with exactly the long model',
    frame?.page === 'models' && (frame?.items ?? []).length === 1 && String((frame?.items ?? [])[0]?.title).startsWith('provider/WWWW'),
    JSON.stringify((frame?.items ?? []).map((item) => item.title)))
  await enterOverview(h)
  h.check('the long model\'s Overview opens under the short page title with its identity row painted',
    lastFrame(h)?.page === 'overview' && lastFrame(h)?.title === 'Model overview'
    && rowWithText(h, h.snapshot(), 'Long Model') !== undefined,
    JSON.stringify({ page: lastFrame(h)?.page, title: lastFrame(h)?.title }))
  const longReaderOpened = await openReaderByPointer(h)
  h.check('the long model\'s Reader opens from the Overview', longReaderOpened && lastFrame(h)?.page === 'details',
    `opened=${longReaderOpened} :: ${JSON.stringify(lastFrame(h)?.page)}`)
  snap = h.snapshot()
  h.check('the Reader head is the long model NAME', lastFrame(h)?.head === 'Long Model', JSON.stringify(lastFrame(h)?.head))
  const idNodes = snap.nodes.filter((node) => String(node.text ?? '').startsWith('provider/WWWW'))
  const descriptionNodes = snap.nodes.filter((node) => String(node.text ?? '').startsWith('Long description'))
  h.check('the long unbroken id arrives as ONE client-wrapped node carrying the complete value',
    idNodes.length === 1 && String(idNodes[0].text).includes('very-high'), `${idNodes.length} node(s)`)
  h.check('the multi-line description arrives as ONE client-wrapped node',
    descriptionNodes.length === 1 && String(descriptionNodes[0].text).includes('中文描述') && String(descriptionNodes[0].text).includes('🚀'),
    `${descriptionNodes.length} node(s)`)
  const control = textUnder(snap, 'Long Model', 'sf-ov-body')
  const lineHeight = rect(control)[3]
  h.check('the client really wraps both long values into many lines (measured against a one-line control)',
    lineHeight > 0 && rect(idNodes[0])[3] >= 2 * lineHeight && rect(descriptionNodes[0])[3] >= 4 * lineHeight,
    `line=${lineHeight} id=${box(idNodes[0])} description=${box(descriptionNodes[0])}`)
  h.measure('the long-value line counts (height / single-line control)',
    JSON.stringify({ lineHeight, idLines: rect(idNodes[0])[3] / lineHeight, descriptionLines: rect(descriptionNodes[0])[3] / lineHeight }))
  const readerShot = h.capture('reader-top-1280x800', 'the Reader at the top: complete long id and description')

  const readerY = () => rect(textStarting(h.snapshot(), 'Long description'))[1]
  const topY = readerY()
  await h.key('Down', 700)
  const downY = readerY()
  h.check('a real Down key really moves the CLIENT viewport',
    scrolls(h).at(-1)?.to === 'line-down' && downY < topY, `${topY} -> ${downY} :: ${JSON.stringify(scrolls(h).slice(-2))}`)
  await h.key('End', 800)
  const endY = readerY()
  h.check('a real End key really moves the CLIENT viewport to the tail',
    scrolls(h).at(-1)?.to === 'end' && endY < downY, `${downY} -> ${endY}`)
  h.capture('reader-tail-1280x800', 'the Reader at the tail: the long description read to its end')
  await h.key('Escape', 900)
  h.check('Esc returns the Reader to its origin Overview (identity row visible)',
    lastFrame(h)?.page === 'overview' && lastFrame(h)?.title === 'Model overview'
    && rowWithText(h, h.snapshot(), 'Long Model') !== undefined, JSON.stringify(lastFrame(h)))
  const reopened = await openReaderByPointer(h)
  snap = h.snapshot()
  const backRow = h.classNodes(snap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')
  const backRowClicked = backRow === undefined ? false : await h.click(snap.chains, backRow)
  h.check('the visible Back row returns to the Overview as well',
    reopened && backRowClicked && lastFrame(h)?.page === 'overview',
    `reopened=${reopened} clicked=${backRowClicked} :: ${JSON.stringify(lastFrame(h)?.page)}`)

  // ------------------------------------------------- claim 6: the failed-read phase
  const failedOpened = await openReaderByPointer(h)
  h.check('the Reader reopens for the failed-read phase control', failedOpened && lastFrame(h)?.page === 'details', `opened=${failedOpened}`)
  await h.key('e', 800)
  h.check('the subject\'s e control reported a failed read while the Reader stays open',
    controls(h).at(-1) === 'load-error' && lastFrame(h)?.page === 'details', `${JSON.stringify(controls(h).slice(-2))} :: ${lastFrame(h)?.page}`)
  snap = h.snapshot()
  const notice = textStarting(snap, 'catalog is unreachable')
  const identityHead = textExactly(snap, 'Identity')
  h.check('the failure appears as its own LEADING line on the Reader',
    notice !== undefined && identityHead !== undefined && containedX(snap.chains, notice) && rect(notice)[1] < rect(identityHead)[1],
    `notice@${box(notice)} identity@${box(identityHead)}`)
  const failedControl = textUnder(snap, 'Long Model', 'sf-ov-body')
  const failedLineHeight = rect(failedControl)[3]
  const failedLines = failedLineHeight > 0 ? rect(notice)[3] / failedLineHeight : 0
  h.check('the CRLF / LF / blank-line message renders FOUR native lines (not one collapsed line)',
    failedLineHeight > 0 && Math.abs(failedLines - 4) < 0.25,
    `lines=${failedLines} notice=${box(notice)} line=${failedLineHeight}`)
  h.measure('the client normalizes whitespace in its node dump', JSON.stringify(String(notice?.text)))
  const failedTopY = readerY()
  await h.key('End', 800)
  const failedEndY = readerY()
  h.check('the Reader still scrolls with the CLIENT moving while the read has failed',
    failedEndY < failedTopY - 50, `${failedTopY} -> ${failedEndY}`)
  await h.key('Home', 800)
  snap = h.snapshot()
  const failedBack = h.classNodes(snap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')
  const failedBackClicked = failedBack === undefined ? false : await h.click(snap.chains, failedBack)
  h.check('its visible Back row returns to the Overview while the read has failed',
    failedBackClicked && lastFrame(h)?.page === 'overview', `clicked=${failedBackClicked} :: ${JSON.stringify(lastFrame(h)?.page)}`)
  await h.key('3', 800)   // re-arm the fixture: the phase is ready again
  const escOpened = await openReaderByPointer(h)
  await h.key('e', 800)
  h.check('the Reader is failed again for the Esc check', escOpened && lastFrame(h)?.page === 'details' && controls(h).at(-1) === 'load-error',
    `${escOpened} :: ${lastFrame(h)?.page}`)
  await h.key('Escape', 900)
  h.check('Esc still returns to the Overview while the read has failed',
    lastFrame(h)?.page === 'overview', JSON.stringify(lastFrame(h)?.page))
  await h.key('3', 800)   // ready again for the sections below

  // ---------------------------------------------------- claim 7: partial failure
  await toCatalogue(h)
  await h.key('4', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  const order = frame?.order ?? []
  const unavailableAt = order.findIndex((entry) => entry !== null && typeof entry === 'object' && entry.label === 'Unavailable providers')
  h.check('the partial catalogue appends the Unavailable providers group with inert failure rows + the ONE retry row',
    unavailableAt >= 0 && Number(order[unavailableAt].count) === 2
    && String(order[unavailableAt + 1]).startsWith('failure:') && order[unavailableAt + 2] === 'retry-failed',
    JSON.stringify(order))
  const unavailableGroup = groupWithText(h, snap, 'Unavailable providers')
  const retryRow = rowWithText(h, snap, 'Retry failed providers')
  h.check('the client paints the Unavailable providers group head and the retry row, both contained',
    unavailableGroup !== undefined && containedXY(snap.chains, unavailableGroup)
    && retryRow !== undefined && containedXY(snap.chains, retryRow),
    `group@${box(unavailableGroup)} retry@${box(retryRow)}`)
  const retriesBefore = retries(h).length
  const appliesBeforeRetry = applies(h).length
  const retryClicked = retryRow === undefined ? false : await h.click(snap.chains, retryRow)
  h.check('one REAL pointer click on the retry row reaches the retry spy exactly once and never the writer',
    retryClicked && retries(h).length === retriesBefore + 1 && applies(h).length === appliesBeforeRetry,
    `clicked=${retryClicked} retries=${retries(h).length} applies=${applies(h).length}`)

  // ----------------------- extras: 8-effort Overview, sessionless title/primary
  await h.key('2', 900)
  const wideOverview = await enterOverview(h)
  const wideFrame = lastFrame(h)
  h.check('the 8-effort model opens its Overview with all 9 candidates on the wire',
    wideOverview && (wideFrame?.items ?? []).filter((item) => String(item.id).startsWith('effort:')).length === 9,
    `${(wideFrame?.items ?? []).length} items`)
  for (let step = 0; step < 9; step += 1) await h.key('Down', 200)
  snap = h.snapshot()
  const lastEffort = modelRows(h, snap).find((node) => h.descendantsText(node).includes(`Effort 8 ${'W'.repeat(8)}`))
  h.check('the LAST of the 8 widest-glyph effort labels is reachable with real line keys',
    lastEffort !== undefined && containedXY(snap.chains, lastEffort), lastEffort === undefined ? 'not painted' : box(lastEffort))
  await h.key('Escape', 900)

  // ------------------- the dark-theme capability probe (MEASUREMENT, never a PASS)
  // The plan's §8 "Native rendering" row wants the same font in dark AND light,
  // "at least dark verifiable". The client's control channel ACCEPTS `theme dark`
  // (measured), but the client's own capture layout still resolves the LIGHT
  // theme and its computed colours are unchanged, so a real dark render is NOT
  // reachable through this channel and stays NOT_VERIFIED. The probe is kept in
  // the lane so the negative result stays reproducible.
  await h.key('1', 900)
  await toCatalogue(h)
  await h.resize(1280, 800)
  let themeAccepted = false
  try {
    h.send('theme', 'dark')
    themeAccepted = true
  } catch {
    themeAccepted = false
  }
  await h.sleep(500)
  const themeProbe = h.capture('theme-probe-1280x800', 'after requesting `theme dark`: evidence of what the control channel really renders')
  h.measure('the client `theme dark` control result (accepted but the render stays light)',
    JSON.stringify({ accepted: themeAccepted, layoutTheme: themeOf(h, themeProbe), capsDark: caps(h)?.dark }))
  h.measure('the light label font, for the dark/light font comparison the plan asks for',
    JSON.stringify(fontAt(h, bootShot, 'pk-label')))
  if (themeAccepted) {
    h.send('theme', 'light')
    await h.sleep(400)
  }

  // ----------------------- extras: sessionless title/primary
  await h.key('s', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('the sessionless panel uses its own title and never claims a Current',
    frame?.title === 'Choose default model' && h.has(snap, 'Choose default model')
    && !h.classNodes(snap, 'pk-badge').some((node) => String(node.text) === 'current'),
    `${JSON.stringify(frame?.title)} :: badges=${h.classNodes(snap, 'pk-badge').map((node) => String(node.text)).join(',')}`)
  h.check('the sessionless footer carries the honest Save default write',
    actionLabels(frame).includes('Save default') && actionIds(frame) === 'close,apply',
    `${actionIds(frame)} :: ${actionLabels(frame)}`)

  // ------------------------------------- claim 8: measured capability + ledger
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

  const clientCaps = caps(h)
  h.measure('the client capability set', JSON.stringify(clientCaps))
  h.measure('the client version', JSON.stringify(clientCaps?.ver))
  h.measure('the client boot theme capability (caps.dark)', JSON.stringify(clientCaps?.dark))
  h.measure('the catalogue label font', JSON.stringify(fontAt(h, bootShot, 'pk-label')))
  h.measure('the catalogue summary font', JSON.stringify(fontAt(h, bootShot, 'sf-kv')))
  h.measure('the Reader title font', JSON.stringify(fontAt(h, readerShot, 'sf-ov-title')))
  h.measure('the dark-theme probe layout (the client keeps rendering LIGHT; dark stays NOT_VERIFIED)',
    JSON.stringify({ layoutTheme: themeOf(h, themeProbe) }))
  h.measure('the resolved fonts per size (from the capture layouts)', JSON.stringify({
    boot: fontAt(h, bootShot, 'sf-picker'),
    narrow: narrowShot === undefined ? undefined : fontAt(h, narrowShot, 'sf-picker'),
  }))
  h.measure('every size\'s cols/cell.w as the subject received it', JSON.stringify(resizes(h)))
  h.measure('the measured model-name / fact-column budget per size', JSON.stringify(columnMetrics))
  h.measure('the source revision this run rendered (sha256 prefix per module)', sourceHash(h))
  h.measure('frames rendered', String(frames(h).length))
  h.measure('native scroll ops the app asked for', JSON.stringify(scrolls(h)))
  h.measure('raw row events the subject received', JSON.stringify(rowEvents(h)))
  h.measure('raw action events the subject received', JSON.stringify(actionEvents(h)))
  h.measure('writes that reached the subject writer', JSON.stringify(applies(h).map((row) => row.apply.selection)))
  h.measure('retries that reached the subject read owner', String(retries(h).length))
  h.measure('the visible catalogue rows at boot (containment oracle)', pickerClasses(h.snapshot()).join(' '))
  h.measure('the summary region visible span at boot', visibleSpan(h.snapshot().chains, h.classNodes(h.snapshot(), 'pk-pv')[0] ?? {}).toFixed(1))
}
