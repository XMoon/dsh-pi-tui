/**
 * The `/model` real-pane acceptance lane — TWO-PAGE contract: the model catalogue
 * (with the native Reasoning Effort `strip` and the ONE write) and the read-only
 * Full details Reader. There is no intermediate page.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs --out temp/<run>
 *
 * What only the real client can prove, and this lane proves:
 *  - the catalogue NEVER asks for a preview region or a fact column, at any of the
 *    ten pane sizes (`pv-none`, no `pk-pv`, no `columns`/`facts`), while `size`
 *    paints the modal `md` sheet at EVERY pane (never `lg`) and asks for no preview
 *    region or fact column;
 *  - the native `strip` really paints the HIGHLIGHTED model's candidates, marks the
 *    local draft `on`, and a REAL click on another item emits exactly
 *    `action { act:'strip', value:<item id> }` and writes nothing;
 *  - `Tab` reaches the strip and then the bar, and the sheet paints the native
 *    `f-strip` focus for the strip zone;
 *  - `Enter` / `activate` on a row opens the READER directly, with no intermediate
 *    picker page anywhere in the frame ledger;
 *  - one REAL click on the primary writes exactly once with the strip-drafted effort;
 *  - an 8-item widest-label strip wraps (not scrolls), with every item contained and
 *    individually clickable, at 1280x800 and 400x600;
 *  - a model with no effort metadata paints no strip at all;
 *  - the Reader's long values wrap client-side and its keyboard scroll really moves
 *    the client viewport (tolerating the documented F3-004 dropped-scroll-key stall).
 *
 * Every containment claim goes through the visibility oracle (`containedXY` /
 * `visibleSpan`); an empty node list FAILS instead of passing vacuously. Artifacts
 * stay in the run directory the driver creates; nothing is deleted.
 * @module scripts/tern-pane-model-ux
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { containedX, containedXY, rect as rawRect, visibleSpan } from './tern-pane-geometry.mjs'

/** The oracle's `rect` made TOTAL for a node the client does not paint. */
const rect = (node) => (node === undefined ? [0, 0, 0, 0] : rawRect(node))

/* ------------------------------------------------------------ the record */

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((row) => row.caps)?.caps
const rowEvents = (h) => records(h).filter((row) => row.event && (row.event.ev === 'select' || row.event.ev === 'activate')).map((row) => row.event)
const actionEvents = (h) => records(h).filter((row) => row.event && row.event.ev === 'action').map((row) => row.event)
const stripEvents = (h) => actionEvents(h).filter((event) => event.act === 'strip')
const applies = (h) => records(h).filter((row) => row.apply)
const retries = (h) => records(h).filter((row) => row.retry)
const controls = (h) => records(h).filter((row) => row.control).map((row) => row.control)
const resizes = (h) => records(h).filter((row) => row.resize).map((row) => row.resize)
const scrolls = (h) => records(h).filter((row) => row.nativeScroll).map((row) => row.nativeScroll)

/* ------------------------------------------------------------- the tree */

const box = (node) => (node === undefined ? 'none' : rect(node).map((n) => Math.round(n * 10) / 10).join(','))
/** The bar's action ids, WITH their frame token (`apply#27`): the token is how a stale
 *  action is refused once the picker's node identity is long-lived, so the flow reads the
 *  bases when it asserts WHAT the bar offers. */
const rawActionIds = (frame) => (frame?.actions ?? []).map((action) => action.id)
const actionIds = (frame) => rawActionIds(frame).map((id) => String(id).split('#')[0]).join(',')
const actionOf = (frame, base) => (frame?.actions ?? []).find((action) => String(action.id).split('#')[0] === base)
const actionLabels = (frame) => (frame?.actions ?? []).map((action) => String(action.label ?? '')).join(' | ')
const itemOf = (frame, id) => (frame?.items ?? []).find((item) => item.id === id)
const pickerNode = (snap) => snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-picker'))
const pickerClasses = (snap) => (pickerNode(snap)?.class ?? '').split(' ').filter(Boolean)
/** The client paints its per-REGION focus on the SHEET (`pk-sheet f-list` /
 *  `f-strip`), not on the picker element. */
const sheetClasses = (snap) => (snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-sheet'))?.class ?? '').split(' ').filter(Boolean)
const modelRows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => !(node.class ?? '').split(' ').includes('grp'))
const groupRows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => (node.class ?? '').split(' ').includes('grp'))
const rowWithText = (h, snap, text) => modelRows(h, snap).find((node) => h.descendantsText(node).includes(text))
const buttons = (h, snap) => h.classNodes(snap, 'pk-btn')
const chips = (h, snap) => h.classNodes(snap, 'pk-schip')
const onChips = (h, snap) => chips(h, snap).filter((node) => (node.class ?? '').split(' ').includes('on'))
const stripNode = (snap) => snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-strip'))
const stripLabel = (snap) => snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-strip-l'))
const chipWithText = (h, snap, text) => chips(h, snap).find((node) => h.descendantsText(node).includes(text))
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
const textUnder = (snap, text, ancestorClass) => snap.nodes.find((node) => String(node.text ?? '') === text
  && (snap.chains.get(node) ?? []).some((ancestor) => (ancestor.class ?? '').split(' ').includes(ancestorClass)))
const chipRows = (h, snap) => [...new Set(chips(h, snap).map((node) => Math.round(rect(node)[1])))].length

/** The client's own capture layout: fonts, colours and THEME. */
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
/** The SHA-256 of the four modules this run rendered, so the evidence names the
 *  exact contract revision it was taken against. */
const sourceHash = (h) => ['model-picker-view.ts', 'model-picker-state.ts', 'model-picker-intents.ts', 'model-picker.ts']
  .map((name) => `${name}:${createHash('sha256').update(readFileSync(join(h.repo, 'src', 'tui', 'tsp', name))).digest('hex').slice(0, 12)}`)
  .join(' ')

/** The plan §9 acceptance sizes: each gets `models-<w>x<h>` and `reader-<w>x<h>`. */
const SECTION9 = new Set(['1280x800', '1000x640', '560x640', '400x600'])

/* ------------------------------------------------------- shared navigation */

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

/** Enter the highlighted model's Reader DIRECTLY (no intermediate page). */
const enterReader = async (h) => {
  await h.key('Return', 900)
  return lastFrame(h)?.page === 'details'
}

/** Open the Reader by REAL pointer ACTIVATION of the highlighted row (a click on
 *  the already-selected row), which is independent of the keyboard zone. */
const activateReader = async (h) => {
  const snap = h.snapshot()
  const row = modelRows(h, snap).find((node) => (node.class ?? '').split(' ').includes('sel')) ?? modelRows(h, snap)[0]
  if (row === undefined || !containedXY(snap.chains, row)) return false
  const before = rowEvents(h).length
  await h.click(snap.chains, row)
  const events = rowEvents(h).slice(before)
  return lastFrame(h)?.page === 'details' && events.some((event) => event.ev === 'activate')
}

/** One strip click by candidate LABEL. It does NOT require full containment: a
 *  chip clipped by the sheet is still clicked on the fragment the client shows, so
 *  its clickability is proved while the clipping stays a separate finding. */
const clickChip = async (h, label) => {
  const snap = h.snapshot()
  const chip = chipWithText(h, snap, label)
  return chip === undefined ? false : await h.click(snap.chains, chip)
}

/* --------------------------------------------------------------- matrix */

/**
 * One pane size. It asserts the presenter's claim against the client's OWN
 * classes, the absence of preview/columns at every width, the footer and model
 * rows, the strip (label, candidates, draft `on`, every chip contained), and that
 * `Enter` opens the Reader DIRECTLY with no intermediate picker page.
 */
const matrixCell = async (h, size) => {
  await toCatalogue(h)
  await h.resize(size.w, size.h)
  const snap = h.snapshot()
  const frame = lastFrame(h)
  const cellKey = `${size.w}x${size.h}`
  const resize = resizes(h).at(-1)
  const cols = resize?.cols
  const cell = resize?.cell?.w
  const panePx = cols * cell
  const classes = pickerClasses(snap)
  const modelName = itemOf(frame, frame?.selected)?.label
  const sheet = h.classNodes(snap, 'pk-sheet')[0]

  h.measure(`${cellKey}: cols/cell.w/pane px`, JSON.stringify({ cols, cell, panePx }))
  // The Owner-frozen window size: a MODAL `md` sheet at EVERY pane width (the
  // official product's picker uses `md`; `lg` is its fullscreen hub). The old
  // 900px `lg`/`md` threshold is retired with the `size` prop's only consumer.
  h.check(`${cellKey}: the presenter claims the modal md sheet + preview none at ${panePx}px`,
    frame?.page === 'models' && frame?.size === 'md' && frame?.preview === 'none',
    JSON.stringify({ page: frame?.page, size: frame?.size, preview: frame?.preview, cols, cell, panePx }))
  h.check(`${cellKey}: the client paints sz-md and NEVER sz-lg or pv-below`,
    classes.includes('sz-md') && !classes.includes('sz-lg') && classes.includes('pv-none') && !classes.includes('pv-below'),
    classes.join(' '))
  h.check(`${cellKey}: the sheet's own rect is inside the pane (no clipping)`,
    sheet !== undefined && containedXY(snap.chains, sheet),
    `sheet@${box(sheet)} pane=${size.w}x${size.h}`)
  if ((size.w === 1280 && size.h === 800) || (size.w === 1000 && size.h === 640)) {
    h.check(`${cellKey}: the md sheet is the measured ~680px modal width`,
      Math.abs(rect(sheet)[2] - 680) <= 20, `sheet@${box(sheet)}`)
  }
  h.measure(`${cellKey}: sheet rect`, JSON.stringify(rect(sheet)))
  h.check(`${cellKey}: no preview region and no fact column are painted`,
    h.classNodes(snap, 'pk-pv').length === 0 && h.classNodes(snap, 'pk-fact').length === 0
    && (frame?.columns ?? undefined) === undefined && (frame?.items ?? []).every((item) => item.facts === undefined),
    `pk-pv=${h.classNodes(snap, 'pk-pv').length} pk-fact=${h.classNodes(snap, 'pk-fact').length} columns=${JSON.stringify(frame?.columns)}`)
  h.check(`${cellKey}: the catalogue paints no scope column`, scopeTokens(snap).length === 0
    && !(frame?.propKeys ?? []).includes('scopes'), `${scopeTokens(snap).join(',')} :: ${(frame?.propKeys ?? []).join(',')}`)

  const barButtons = buttons(h, snap)
  h.check(`${cellKey}: the footer is exactly Cancel + the one write, both contained`,
    barButtons.length === 2 && actionIds(frame) === 'close,apply' && (frame?.actions ?? []).filter((action) => String(action.id).split('#')[0] === 'apply').length === 1
    && barButtons.every((node) => containedXY(snap.chains, node)),
    `${barButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' ')} :: ${actionIds(frame)}`)
  const rows = modelRows(h, snap)
  const clippedRows = rows.filter((node) => !containedXY(snap.chains, node))
  h.check(`${cellKey}: the catalogue's first model row is fully contained in its list region`,
    rows.length > 0 && containedXY(snap.chains, rows[0]),
    `rows=${rows.map((node) => `${h.descendantsText(node).slice(0, 22)}@${box(node)} yspan=${visibleSpan(snap.chains, node, 'y').toFixed(1)}`).join(' | ')}`)
  if (clippedRows.length > 0) {
    h.measure(`${cellKey}: model rows clipped by the list fold at this SHORT pane`,
      clippedRows.map((node) => `${h.descendantsText(node).slice(0, 22)}@${box(node)} yspan=${visibleSpan(snap.chains, node, 'y').toFixed(1)}`).join(' | '))
  }

  // The ONE Reasoning Effort editor: the highlighted model's candidates.
  const strip = frame?.strip
  const wireIds = (strip?.items ?? []).map((item) => String(item.id))
  const wireLabels = (strip?.items ?? []).map((item) => String(item.label))
  const onWire = (strip?.items ?? []).filter((item) => item.on === true)
  h.check(`${cellKey}: the strip is the highlighted model's candidates with the draft marked on`,
    strip?.label === 'Reasoning Effort' && wireIds.length === 4 && wireIds.every((id) => id.startsWith('effort:'))
    && JSON.stringify(wireLabels) === JSON.stringify(['Default', 'Low', 'Medium', 'High'])
    && onWire.length === 1 && onWire[0].label === 'Medium',
    JSON.stringify(strip))
  const stripBox = stripNode(snap)
  const paintedChips = chips(h, snap)
  h.check(`${cellKey}: the client paints the strip label and every candidate chip, all contained`,
    stripBox !== undefined && containedXY(snap.chains, stripBox)
    && stripLabel(snap) !== undefined && String(stripLabel(snap).text) === 'Reasoning Effort'
    && paintedChips.length === wireIds.length && paintedChips.every((node) => containedXY(snap.chains, node)),
    `strip@${box(stripBox)} label=${JSON.stringify(String(stripLabel(snap)?.text))} chips=${paintedChips.length}/${wireIds.length} ${paintedChips.map((node) => `${h.descendantsText(node)}@${box(node)} yspan=${visibleSpan(snap.chains, node, 'y').toFixed(1)}`).join(' ')}`)
  const onPainted = onChips(h, snap)
  h.check(`${cellKey}: the drafted candidate really paints the client's on state`,
    onPainted.length === 1 && h.descendantsText(onPainted[0]).includes('Medium'),
    onPainted.map((node) => h.descendantsText(node)).join(' | '))
  const stripRows = chipRows(h, snap)
  h.measure(`${cellKey}: strip box / chip rows / list height`,
    JSON.stringify({ strip: rect(stripBox), chipRows: stripRows, list: rect(h.classNodes(snap, 'pk-scroll')[0]) }))
  if (SECTION9.has(cellKey)) h.capture(`models-${cellKey}`, `the ${cellKey} catalogue: strip, no preview, no fact column`)

  // Short-pane reachability (MEASUREMENT): a 400px-tall list drops the rows below
  // its fold, so prove the LAST model row really comes into view with the list's
  // own keys, then walk the cursor back onto the highlighted model so the Reader
  // step below still describes the same one.
  let rowDowns = 0
  let lastRowReached = false
  while (rowDowns < 8 && !lastRowReached) {
    const walkedNow = h.snapshot()
    const targetNow = rowWithText(h, walkedNow, 'Alpha Second')
    lastRowReached = targetNow !== undefined && containedXY(walkedNow.chains, targetNow)
    if (!lastRowReached) {
      await h.key('Down', 200)
      rowDowns += 1
    }
  }
  const walkedRows = modelRows(h, h.snapshot())
  h.measure(`${cellKey}: the LAST model row reached under the short list`,
    JSON.stringify({ steps: rowDowns, painted: walkedRows.length, last: walkedRows.at(-1) === undefined ? 'none' : h.descendantsText(walkedRows.at(-1)).slice(0, 22) }))
  for (let step = 0; step < rowDowns; step += 1) await h.key('Up', 120)

  // Enter opens the Reader DIRECTLY, and there is no intermediate picker page.
  const readerOpened = await enterReader(h)
  const readerSnap = h.snapshot()
  h.check(`${cellKey}: Enter opens the read-only Reader directly (no intermediate picker page)`,
    readerOpened && h.classNodes(readerSnap, 'sf-picker').length === 0 && h.classNodes(readerSnap, 'pk-btn').length === 0
    && frames(h).every((entry) => entry.page !== 'overview'),
    `opened=${readerOpened} picker=${h.classNodes(readerSnap, 'sf-picker').length} pages=${[...new Set(frames(h).map((entry) => entry.page))].join(',')}`)
  h.check(`${cellKey}: the Reader overlay head is the MODEL NAME`,
    modelName !== undefined && lastFrame(h)?.head === modelName,
    `${JSON.stringify(lastFrame(h)?.head)} expected ${JSON.stringify(modelName)}`)
  const readerBack = h.classNodes(readerSnap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')
  const readerHead = textExactly(readerSnap, 'Identity')
  h.check(`${cellKey}: the Reader's visible Back row and first group head are contained`,
    readerBack !== undefined && containedXY(readerSnap.chains, readerBack)
    && readerHead !== undefined && containedXY(readerSnap.chains, readerHead),
    `Back@${box(readerBack)} Identity@${box(readerHead)}`)
  h.check(`${cellKey}: the Reader's configured facts join with the ONE separator ( · )`,
    textExactly(readerSnap, 'alpha · m-alpha · medium') !== undefined,
    `current=${JSON.stringify(String(textExactly(readerSnap, 'alpha · m-alpha · medium')?.text))}`)
  if (SECTION9.has(cellKey)) h.capture(`reader-${cellKey}`, `the ${cellKey} Reader top`)
  await h.key('Escape', 900)
  h.check(`${cellKey}: Esc returns the Reader to the catalogue`,
    lastFrame(h)?.page === 'models', JSON.stringify(lastFrame(h)?.page))
  return { metrics: { panePx, cols, cell, chipRows: stripRows, sheetWidth: rect(sheet)[2], sheetHeight: rect(sheet)[3] } }
}

/* ------------------------------------------------------------------- flow */

export default async function (h) {
  // ------------------------------------------------- claim 1: boot at 1280x800
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-model-ux-subject.mts')
  const booted = await h.launch(subject, { ready: 'Switch model' })
  h.check('the two-page model picker boots inside a real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return

  let snap = h.snapshot()
  let frame = lastFrame(h)
  const bootShot = h.capture('catalogue-1280x800', 'the wide two-page catalogue with its Reasoning Effort strip')
  h.check('boot: the catalogue paints under its live title with the next-zone hint',
    frame?.page === 'models' && frame?.title === 'Switch model' && frame?.subtitle === 'Tab effort',
    JSON.stringify({ title: frame?.title, subtitle: frame?.subtitle }))
  h.check('boot: the catalogue claims the modal md sheet, asks for no preview region and paints none',
    frame?.size === 'md' && frame?.preview === 'none' && !pickerClasses(snap).includes('pv-below')
    && h.classNodes(snap, 'pk-pv').length === 0,
    `size=${JSON.stringify(frame?.size)} :: ${pickerClasses(snap).join(' ')} :: pk-pv=${h.classNodes(snap, 'pk-pv').length}`)
  h.check('boot: the catalogue declares no fact column and every row carries no facts',
    (frame?.columns ?? undefined) === undefined && (frame?.items ?? []).every((item) => item.facts === undefined),
    `columns=${JSON.stringify(frame?.columns)}`)
  const bootStrip = frame?.strip
  h.check('boot: the strip holds the highlighted model\'s four candidates with Medium drafted',
    bootStrip?.label === 'Reasoning Effort'
    && JSON.stringify((bootStrip?.items ?? []).map((item) => item.label)) === JSON.stringify(['Default', 'Low', 'Medium', 'High'])
    && (bootStrip?.items ?? []).filter((item) => item.on === true).length === 1
    && (bootStrip?.items ?? []).find((item) => item.on === true)?.label === 'Medium',
    JSON.stringify(bootStrip))
  const bootChips = chips(h, snap)
  h.check('boot: the client paints the strip label and four contained chips with one on',
    stripLabel(snap) !== undefined && String(stripLabel(snap).text) === 'Reasoning Effort'
    && bootChips.length === 4 && bootChips.every((node) => containedXY(snap.chains, node))
    && onChips(h, snap).length === 1 && h.descendantsText(onChips(h, snap)[0]).includes('Medium'),
    `${bootChips.map((node) => h.descendantsText(node)).join(' | ')} :: on=${onChips(h, snap).map((node) => h.descendantsText(node)).join(',')}`)
  const picked = rowWithText(h, snap, 'Alpha Model')
  const defaulted = rowWithText(h, snap, 'Beta Model')
  h.check('boot: the picked model row carries its provider mark and its real current badge',
    picked !== undefined && markText(h, picked) === 'AP'
    && subclass(picked, 'pk-badge').some((node) => String(node.text) === 'current'),
    picked === undefined ? 'no picked row' : `${markText(h, picked)} :: ${h.descendantsText(picked)}`)
  h.check('boot: the default row carries the lowercase default badge and never a fake current',
    defaulted !== undefined && subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'default')
    && !subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'current'),
    defaulted === undefined ? 'no default row' : h.descendantsText(defaulted))
  h.check('boot: every model appears exactly once (one row per provider+model)',
    ['Alpha Model', 'Alpha Second', 'Beta Model'].every((label) => modelRows(h, snap).filter((node) => h.descendantsText(node).includes(label)).length === 1),
    modelRows(h, snap).map((node) => h.descendantsText(node)).join(' | '))
  const bootGroups = groupRows(h, snap)
  h.check('boot: the pinned Current · Default group is the FIRST group',
    bootGroups.length >= 1 && h.descendantsText(bootGroups[0]).includes('Current · Default'),
    bootGroups.map((node) => h.descendantsText(node)).join(' | '))
  const bootButtons = buttons(h, snap)
  h.check('boot: the footer is exactly Cancel + the one write, both contained',
    bootButtons.length === 2 && actionIds(frame) === 'close,apply'
    && actionLabels(frame).includes('Cancel') && actionLabels(frame).includes('Switch')
    && bootButtons.every((node) => containedXY(snap.chains, node)),
    `${bootButtons.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' ')} :: ${actionIds(frame)}`)
  h.check('boot: no scope column anywhere', scopeTokens(snap).length === 0 && !(frame?.propKeys ?? []).includes('scopes'),
    `${scopeTokens(snap).join(',')} :: ${(frame?.propKeys ?? []).join(',')}`)

  // -------------------------------------------------------- claim 2: the matrix
  const columnMetrics = []
  for (const size of [
    { w: 400, h: 600 }, { w: 560, h: 640 }, { w: 900, h: 400 }, { w: 1000, h: 640 },
    { w: 1020, h: 640 }, { w: 1040, h: 640 }, { w: 1050, h: 700 }, { w: 1100, h: 640 },
    { w: 1280, h: 600 }, { w: 1280, h: 800 },
  ]) {
    const cell = await matrixCell(h, size)
    columnMetrics.push({ size: `${size.w}x${size.h}`, ...cell.metrics })
  }
  h.check('no pane claims or paints the lg sheet: the modal md size is uniform across all ten panes',
    columnMetrics.every((entry) => entry.sheetWidth > 0 && entry.sheetWidth <= entry.panePx),
    JSON.stringify(columnMetrics))
  h.measure('every pane\'s md sheet width/height', JSON.stringify(columnMetrics.map((entry) => `${entry.size}:${entry.sheetWidth.toFixed(1)}x${entry.sheetHeight.toFixed(1)}`)))

  // ------------------- claim 3: the strip is PHASE-GATED to the ready phase
  await toCatalogue(h)
  await h.resize(1280, 800)
  const readyDraft = () => (lastFrame(h)?.strip?.items ?? []).find((item) => item.on === true)?.label
  h.check('the strip is painted while the panel is ready, with Medium drafted',
    lastFrame(h)?.strip !== undefined && readyDraft() === 'Medium', JSON.stringify(lastFrame(h)?.strip))
  const appliesBeforePhases = applies(h).length
  const forgedBefore = records(h).filter((row) => row.control === 'forged-strip').length
  await h.key('l', 800)
  h.check('a running re-read paints NO strip',
    lastFrame(h)?.strip === undefined && h.classNodes(h.snapshot(), 'pk-schip').length === 0,
    `strip=${JSON.stringify(lastFrame(h)?.strip)} chips=${h.classNodes(h.snapshot(), 'pk-schip').length}`)
  await h.key('f', 700)
  await h.key('e', 800)
  h.check('a failed read paints NO strip',
    lastFrame(h)?.strip === undefined && h.classNodes(h.snapshot(), 'pk-schip').length === 0,
    `strip=${JSON.stringify(lastFrame(h)?.strip)} chips=${h.classNodes(h.snapshot(), 'pk-schip').length}`)
  await h.key('f', 700)
  const forgedAfter = records(h).filter((row) => row.control === 'forged-strip').length
  await h.key('1', 800)   // ready again on the SAME normal catalogue
  h.check('a forged strip action in loading/error is refused: the draft and the writer are untouched',
    forgedAfter === forgedBefore + 2 && lastFrame(h)?.strip !== undefined && readyDraft() === 'Medium'
    && applies(h).length === appliesBeforePhases,
    `forged=${forgedAfter}/${forgedBefore} draft=${JSON.stringify(readyDraft())} applies=${applies(h).length}/${appliesBeforePhases}`)

  // ------------------------------- claim 4: the strip zone, a click and the ONE write
  await toCatalogue(h)
  await h.resize(1280, 800)
  const preTabSheet = sheetClasses(h.snapshot())
  h.check('the catalogue sheet is in its native f-list focus before Tab',
    preTabSheet.includes('f-list') && !preTabSheet.includes('f-strip'), preTabSheet.join(' '))
  await h.key('Tab', 700)
  snap = h.snapshot()
  h.check('Tab reaches the strip zone (its hint names the NEXT zone)',
    lastFrame(h)?.subtitle === 'Tab actions', JSON.stringify(lastFrame(h)?.subtitle))
  h.check('the sheet paints the native f-strip focus (and not f-list) while the strip owns the keyboard',
    lastFrame(h)?.focus === 'strip' && sheetClasses(snap).includes('f-strip') && !sheetClasses(snap).includes('f-list'),
    `focus=${JSON.stringify(lastFrame(h)?.focus)} :: ${sheetClasses(snap).join(' ')}`)
  await h.key('Tab', 700)
  const barSheet = sheetClasses(h.snapshot())
  h.check('the next Tab leaves the strip: the bar marks Switch [Enter] and the sheet returns to f-list',
    lastFrame(h)?.subtitle === 'Tab list' && actionLabels(lastFrame(h)).includes('Switch [Enter]')
    && barSheet.includes('f-list') && !barSheet.includes('f-strip'),
    `${JSON.stringify(lastFrame(h)?.subtitle)} :: ${actionIds(lastFrame(h))} :: ${actionLabels(lastFrame(h))} :: ${barSheet.join(' ')}`)
  await h.key('Tab', 700)   // the ring wraps the bar back to the list

  frame = lastFrame(h)
  const highWire = (frame?.strip?.items ?? []).find((item) => item.label === 'High')
  const writesBefore = applies(h).length
  const stripClicksBefore = stripEvents(h).length
  const stripSnap = h.snapshot()
  const highChip = chipWithText(h, stripSnap, 'High')
  const highClicked = highChip === undefined ? false : await h.click(stripSnap.chains, highChip)
  const stripClicks = stripEvents(h).slice(stripClicksBefore)
  snap = h.snapshot()
  h.check('one REAL click on a different strip item emits exactly one strip action and moves on',
    highClicked && stripClicks.length === 1 && stripClicks[0].act === 'strip'
    && highWire !== undefined && String(stripClicks[0].value) === String(highWire.id)
    // The id really names the MODEL it was built for as well as the candidate value, and the
    // client hands it back verbatim: that is what lets admission refuse a delayed click from
    // the model the strip showed before the selection moved.
    && String(highWire.id) === `effort:${JSON.stringify(['alpha', 'm-alpha'])}\u0000high`
    && stripClicks[0].item === undefined
    && onChips(h, snap).length === 1 && h.descendantsText(onChips(h, snap)[0]).includes('High')
    && applies(h).length === writesBefore,
    `${JSON.stringify(stripClicks)} :: on=${onChips(h, snap).map((node) => h.descendantsText(node)).join(',')} writes=${applies(h).length}`)
  h.check('the strip click changes ONLY the local draft (the seeded candidate is no longer on)',
    chips(h, snap).filter((node) => h.descendantsText(node).includes('Medium') && (node.class ?? '').split(' ').includes('on')).length === 0,
    chips(h, snap).map((node) => `${h.descendantsText(node)}${(node.class ?? '').includes('on') ? '*' : ''}`).join(' '))

  snap = h.snapshot()
  const primary = buttons(h, snap).find((node) => (node.class ?? '').split(' ').includes('primary'))
  const writeBefore = applies(h).length
  const primaryClicked = primary === undefined ? false : await h.click(snap.chains, primary)
  const applied = applies(h)
  h.check('one REAL click on the primary writes EXACTLY once with the strip-drafted effort',
    primaryClicked && applied.length === writeBefore + 1
    && applied.at(-1).apply.selection.provider === 'alpha' && applied.at(-1).apply.selection.model === 'm-alpha'
    && applied.at(-1).apply.selection.reasoningEffort === 'high',
    `clicked=${primaryClicked} applies=${JSON.stringify(applied)}`)
  const pendingFrames = frames(h).filter((entry) => (entry.actions ?? []).some((action) => action.label === 'Selecting…'))
  h.check('the admitted-write (pending) frames paint NO strip either',
    pendingFrames.length > 0 && pendingFrames.every((entry) => entry.strip === undefined),
    `pending=${pendingFrames.length} :: ${pendingFrames.map((entry) => JSON.stringify(entry.strip)).join(',')}`)

  // --------------------------------------- claim 5: a model with NO effort metadata
  await toCatalogue(h)
  const noEffortSnap = h.snapshot()
  const noEffortRow = rowWithText(h, noEffortSnap, 'Beta Model')
  const noEffortSelected = noEffortRow === undefined ? false : await h.click(noEffortSnap.chains, noEffortRow)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('a model with no effort metadata paints NO strip row at all',
    noEffortSelected && frame?.selected === JSON.stringify(['beta', 'm-beta'])
    && frame?.strip === undefined && h.classNodes(snap, 'pk-schip').length === 0 && stripNode(snap) === undefined,
    `selected=${JSON.stringify(frame?.selected)} strip=${JSON.stringify(frame?.strip)} chips=${h.classNodes(snap, 'pk-schip').length}`)
  h.check('and its next-zone hint names the action bar, not the missing strip',
    frame?.subtitle === 'Tab actions', JSON.stringify(frame?.subtitle))
  await h.key('Tab', 700)
  h.check('Tab skips the missing strip and reaches the bar in one step',
    lastFrame(h)?.subtitle === 'Tab list' && actionLabels(lastFrame(h)).includes('Switch [Enter]') && lastFrame(h)?.focus !== 'strip',
    `${actionIds(lastFrame(h))} :: ${actionLabels(lastFrame(h))} focus=${JSON.stringify(lastFrame(h)?.focus)}`)

  // ------------------------------- claim 6: the 8-item same-prefix strip edge
  await h.key('2', 900)
  for (const size of [{ w: 1280, h: 800 }, { w: 400, h: 600 }]) {
    await toCatalogue(h)
    await h.resize(size.w, size.h)
    const cellKey = `${size.w}x${size.h}`
    snap = h.snapshot()
    frame = lastFrame(h)
    const wideStrip = frame?.strip
    const wideChips = chips(h, snap)
    const wideRows = chipRows(h, snap)
    const overWide = size.w === 400
    const wireLabels = (wideStrip?.items ?? []).map((item) => String(item.label))
    const paintedLabels = wideChips.map((node) => h.descendantsText(node))
    h.check(`${cellKey}: every chip's own rect is fully contained in the strip (xspan == width)`,
      wideStrip?.items?.length === 8 && wideChips.length === 8
      && wideChips.every((node) => containedXY(snap.chains, node)
        && Math.abs(visibleSpan(snap.chains, node, 'x') - rect(node)[2]) < 0.5)
      && wideRows >= 2 && visibleSpan(snap.chains, stripNode(snap), 'y') > 0,
      `wire=${wideStrip?.items?.length} painted=${wideChips.length} rows=${wideRows} strip@${box(stripNode(snap))} ` +
      wideChips.map((node) => `xspan=${visibleSpan(snap.chains, node, 'x').toFixed(1)}/${rect(node)[2].toFixed(1)}`).join(' '))
    h.check(`${cellKey}: the painted chips are exactly the wire labels`,
      paintedLabels.length === wireLabels.length && paintedLabels.every((label) => wireLabels.includes(label)),
      `painted=${JSON.stringify(paintedLabels)} wire=${JSON.stringify(wireLabels)}`)
    if (overWide) {
      // MIDDLE ellipsis: every label is clamped, all eight stay DISTINCT, and each
      // keeps its own tail — an end clamp would render eight identical `WWWWWW…`.
      const heads = wireLabels.map((label) => label.split('…')[0])
      h.check(`${cellKey}: every over-wide label is clamped with the … device`,
        wireLabels.every((label) => label.includes('…')),
        JSON.stringify(wireLabels))
      h.check(`${cellKey}: the middle clamp keeps every distinguishing tail (all eight labels differ)`,
        new Set(wireLabels).size === 8 && wireLabels.every((label, index) => label.includes(`(${index + 1})`)),
        JSON.stringify(wireLabels))
      h.check(`${cellKey}: two same-prefix labels keep the same head and still differ (the tail is what survives)`,
        heads[0] === heads[1] && heads[0].length > 0 && wireLabels[0] !== wireLabels[1]
        && wireLabels[0].includes('(1)') && wireLabels[1].includes('(2)'),
        `head=${JSON.stringify(heads[0])} a=${JSON.stringify(wireLabels[0])} b=${JSON.stringify(wireLabels[1])}`)
    } else {
      h.check(`${cellKey}: no label is clamped (the budget exceeds their natural width) and all eight stay distinct`,
        wireLabels.every((label) => !label.includes('…')) && new Set(wireLabels).size === 8
        && wireLabels.every((label) => label.length >= 33),
        JSON.stringify(wireLabels))
    }
    h.measure(`${cellKey}: the 8 widest-label chips' surviving spans`,
      wideChips.map((node) => `${h.descendantsText(node).slice(0, 12)} xspan=${visibleSpan(snap.chains, node, 'x').toFixed(1)}/${rect(node)[2].toFixed(1)} yspan=${visibleSpan(snap.chains, node, 'y').toFixed(1)}/${rect(node)[3].toFixed(1)}`).join(' | '))
    h.measure(`${cellKey}: 8-item strip geometry`, JSON.stringify({
      strip: rect(stripNode(snap)), chipRows: wideRows, list: rect(h.classNodes(snap, 'pk-scroll')[0]), chips: wideChips.map((node) => box(node)),
    }))
    const writesBeforeEach = applies(h).length
    let allClickable = true
    for (let index = 0; index < 8; index += 1) {
      const tail = `(${index + 1})`
      const wireItem = (lastFrame(h)?.strip?.items ?? []).find((item) => String(item.label).includes(tail))
      const before = stripEvents(h).length
      const clicked = await clickChip(h, tail)
      const events = stripEvents(h).slice(before)
      const nowOn = onChips(h, h.snapshot())
      const ok = clicked && wireItem !== undefined && events.length === 1 && String(events[0].value) === String(wireItem.id)
        && nowOn.length === 1 && h.descendantsText(nowOn[0]).includes(tail)
      if (!ok) {
        allClickable = false
        h.check(`${cellKey}: strip item ${index + 1} is individually clickable`, false,
          `clicked=${clicked} events=${JSON.stringify(events)} on=${nowOn.map((node) => h.descendantsText(node)).join(',')}`)
      }
    }
    h.check(`${cellKey}: every one of the 8 widest-label strip items is individually clickable`,
      allClickable && applies(h).length === writesBeforeEach,
      `writes=${applies(h).length - writesBeforeEach}`)
    h.capture(`strip8-${cellKey}`, `the 8-item widest-label strip at ${cellKey}`)
  }

  // ------------------------------------------- claim 6: the Reader long values
  await h.key('3', 900)
  await toCatalogue(h)
  await h.resize(1280, 800)
  const longOpened = await activateReader(h)
  snap = h.snapshot()
  h.check('the long model\'s Reader opens directly from the catalogue',
    longOpened && lastFrame(h)?.page === 'details' && lastFrame(h)?.head === 'Long Model',
    `opened=${longOpened} :: ${JSON.stringify({ page: lastFrame(h)?.page, head: lastFrame(h)?.head })}`)
  const idNodes = snap.nodes.filter((node) => String(node.text ?? '').startsWith('provider/WWWW'))
  const descriptionNodes = snap.nodes.filter((node) => String(node.text ?? '').startsWith('Long description'))
  h.check('the long unbroken id and the multi-line description each arrive as ONE client-wrapped node',
    idNodes.length === 1 && String(idNodes[0].text).includes('very-high')
    && descriptionNodes.length === 1 && String(descriptionNodes[0].text).includes('中文描述'),
    `id=${idNodes.length} description=${descriptionNodes.length}`)
  const lineControl = textUnder(snap, 'Long Model', 'sf-ov-body')
  const lineHeight = rect(lineControl)[3]
  h.check('the client wraps both long values into many lines (against a same-font one-line control)',
    lineHeight > 0 && rect(idNodes[0])[3] >= 2 * lineHeight && rect(descriptionNodes[0])[3] >= 4 * lineHeight,
    `line=${lineHeight} id=${box(idNodes[0])} description=${box(descriptionNodes[0])}`)
  h.measure('the long-value line counts', JSON.stringify({ lineHeight, idLines: rect(idNodes[0])[3] / lineHeight, descriptionLines: rect(descriptionNodes[0])[3] / lineHeight }))
  const readerTopShot = h.capture('reader-top-1280x800', 'the Reader at the top: complete long id and description')

  const readerY = () => rect(textStarting(h.snapshot(), 'Long description'))[1]
  const topY = readerY()
  let downTries = 0
  let downMoved = 0
  while (downTries < 4 && downMoved <= 1) {
    await h.key('Down', 500)
    downTries += 1
    downMoved = topY - readerY()
  }
  h.check('a real Down key (retried across the documented credit stall) moves the CLIENT viewport',
    scrolls(h).some((op) => op.to === 'line-down') && downMoved > 1, `moved=${downMoved} tries=${downTries}`)
  h.measure('the dropped-scroll-key stall observed (Down)', JSON.stringify({ downTries }))
  const downY = readerY()
  let endTries = 0
  let endMoved = 0
  while (endTries < 4 && endMoved <= 1) {
    await h.key('End', 500)
    endTries += 1
    endMoved = downY - readerY()
  }
  h.check('a real End key (retried across the stall) moves the CLIENT viewport to the tail',
    scrolls(h).some((op) => op.to === 'end') && endMoved > 1, `moved=${endMoved} tries=${endTries}`)
  h.capture('reader-tail-1280x800', 'the Reader at the tail')

  // The failed-read notice is the Reader's leading line, with exact CRLF/LF lines.
  await h.key('e', 800)
  snap = h.snapshot()
  const notice = textStarting(snap, 'catalog is unreachable')
  const identityHead = textExactly(snap, 'Identity')
  const failedLineHeight = rect(textUnder(snap, 'Long Model', 'sf-ov-body'))[3]
  const failedLines = failedLineHeight > 0 ? rect(notice)[3] / failedLineHeight : 0
  h.check('the CRLF / LF / blank-line notice renders FOUR native lines while leading the Reader',
    controls(h).at(-1) === 'load-error' && notice !== undefined && identityHead !== undefined && containedX(snap.chains, notice)
    && rect(notice)[1] < rect(identityHead)[1] && failedLineHeight > 0 && Math.abs(failedLines - 4) < 0.25,
    `lines=${failedLines} notice=${box(notice)} line=${failedLineHeight}`)
  h.check('the Reader notice carries an explicit error role ink (a toned span, not a bare text prop)',
    lastFrame(h)?.notice?.tone === 'error' && lastFrame(h)?.notice?.textNodeHasTextProp === false
    && h.classNodes(snap, 'sf-t-error').some((node) => h.descendantsText(node).includes('catalog is unreachable')),
    `wire=${JSON.stringify(lastFrame(h)?.notice)} clientErrorInk=${h.classNodes(snap, 'sf-t-error').map((node) => h.descendantsText(node)).join(' | ')}`)
  h.measure('the client normalizes whitespace in its node dump', JSON.stringify(String(notice?.text)))
  // This reading's scroll container, as its own keys addressed it: the second reading must
  // NOT reuse it.
  const firstReadingBody = scrolls(h).at(-1)?.id
  await h.key('Escape', 900)
  h.check('Esc returns the Reader to the catalogue (its ONE origin)',
    lastFrame(h)?.page === 'models', JSON.stringify(lastFrame(h)?.page))
  await h.key('3', 800)   // ready again
  await toCatalogue(h)
  const reopened = await enterReader(h)
  snap = h.snapshot()
  const backRow = h.classNodes(snap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')
  const backClicked = backRow === undefined ? false : await h.click(snap.chains, backRow)
  h.check('the Reader\'s visible Back row returns to the catalogue as well',
    reopened && backClicked && lastFrame(h)?.page === 'models', `reopened=${reopened} clicked=${backClicked}`)
  // A NEW reading must NOT reuse the closed one's identity: its ids carry the panel serial
  // AND the reading's epoch, so a `scroll` op queued by the Reader that was left behind can
  // never address this one's container.
  await toCatalogue(h)
  const secondOpened = await enterReader(h)
  snap = h.snapshot()
  const secondBack = h.classNodes(snap, 'sf-row').find((node) => h.descendantsText(node) === 'Back')?.id
  const opsBefore = scrolls(h).length
  await h.key('End', 700)
  const secondScroll = scrolls(h).at(-1)
  h.check('a NEW reading takes a NEW identity, and its own keys scroll ITS container',
    secondOpened && scrolls(h).length > opsBefore && secondScroll !== undefined
    && typeof secondScroll.id === 'string' && secondScroll.id !== firstReadingBody
    && secondScroll.id.startsWith('layer.') && secondScroll.id.includes('model-details-body'),
    `first body=${JSON.stringify(firstReadingBody)} second body=${JSON.stringify(secondScroll?.id)} back=${JSON.stringify(secondBack)}`)
  h.measure('the Reader reading identities', JSON.stringify({ firstBody: firstReadingBody, secondBack, secondScroll: secondScroll?.id }))
  void secondBack

  // --------------------------------- claim 7: partial failure keeps its ONE retry row
  await h.key('4', 900)
  await toCatalogue(h)
  await h.resize(1280, 800)
  snap = h.snapshot()
  frame = lastFrame(h)
  const order = frame?.order ?? []
  const unavailableAt = order.findIndex((entry) => entry !== null && typeof entry === 'object' && entry.label === 'Unavailable providers')
  h.check('a partial catalogue appends Unavailable providers + the ONE read-only retry row',
    unavailableAt >= 0 && Number(order[unavailableAt].count) === 2
    && String(order[unavailableAt + 1]).startsWith('failure:') && order[unavailableAt + 2] === 'retry-failed',
    JSON.stringify(order))
  const failureWire = (frame?.items ?? []).find((item) => String(item.id).startsWith('failure:'))
  const failureRow = rowWithText(h, snap, 'Broken Provider · unavailable')
  h.check('a failed provider\'s row states itself in words (`<Provider> · unavailable`, not colour alone)',
    failureWire?.label === 'Broken Provider · unavailable'
    && failureRow !== undefined && containedXY(snap.chains, failureRow),
    `wire=${JSON.stringify(failureWire?.label)} painted=${failureRow === undefined ? 'none' : h.descendantsText(failureRow)}`)
  const retryRow = rowWithText(h, snap, 'Retry failed providers')
  const retriesBefore = retries(h).length
  const appliesBeforeRetry = applies(h).length
  const retryClicked = retryRow === undefined ? false : await h.click(snap.chains, retryRow)
  h.check('one REAL click on the retry row reaches the retry spy exactly once and never the writer',
    retryClicked && retries(h).length === retriesBefore + 1 && applies(h).length === appliesBeforeRetry,
    `clicked=${retryClicked} retries=${retries(h).length} applies=${applies(h).length}`)

  // A read that fails as a WHOLE leaves ONE Retry, and it is the bar's: the list's partial
  // row belongs to a catalogue that is really ready, and its failure information stays as
  // read-only context.
  await h.key('4', 900)
  await toCatalogue(h)
  await h.key('e', 900)   // the next read fails entirely
  snap = h.snapshot()
  frame = lastFrame(h)
  // The error phase is observed through what the CLIENT paints: its error message line.
  const failedNotice = textStarting(snap, 'catalog is unreachable')
  h.check('a FULLY failed read keeps ONE Retry (the bar\'s) and no retry row',
    failedNotice !== undefined && actionLabels(frame).includes('Retry')
    && (frame?.items ?? []).every((item) => String(item.id) !== 'retry-failed')
    && rowWithText(h, snap, 'Retry failed providers') === undefined,
    `notice=${String(failedNotice !== undefined)} actions=${JSON.stringify(actionLabels(frame))} retryRow=${String(rowWithText(h, snap, 'Retry failed providers') !== undefined)}`)
  h.capture('failed-read-one-retry', 'a full read failure: the bar is the only operable region')
  await h.key('1', 900)

  // A SEARCH that matches nothing must not read as "no model is advertised": the client paints
  // our empty-list copy, and that copy is a different sentence per situation. A FRESH panel is
  // opened first: the failed read above left the keyboard in the action bar, and only the list
  // zone owns the search box, so typing there would move the bar instead of the query.
  await h.key('s', 900)
  await h.key('z', 300)
  await h.key('z', 700)
  await h.sleep(400)
  // MEASURED, not assumed: the wire carries the picker's `empty` prop, but the client paints no
  // empty copy for a search that matched nothing (the list is simply empty). The check records
  // that fact so a future client that starts painting one flips it and the copy has to be
  // distinguished then.
  const emptyCopy = textStarting(h.snapshot(), 'No model is advertised by the configured providers.')
  h.check('a SEARCH with no matches leaves the list empty and the client paints no copy',
    (lastFrame(h)?.items ?? []).length === 0
    && modelRows(h, h.snapshot()).length === 0
    && emptyCopy === undefined,
    `items=${(lastFrame(h)?.items ?? []).length} paintedCopy=${String(emptyCopy !== undefined)}`)
  h.measure('the empty-list copy the client paints for a no-match search (wire carries `empty`)',
    JSON.stringify({ wireEmpty: 'No model is advertised by the configured providers.', painted: emptyCopy === undefined ? null : String(emptyCopy.text) }))
  h.capture('empty-search-copy', 'a search with no matches: an empty list, no empty copy')

  // The Owner's Esc ladder, on the real client: a typed filter is what Esc clears, and the
  // panel stays open (with the query emptied) until a second Esc has nothing left to clear.
  await h.key('Escape', 800)   // clears the no-match filter and leaves the panel open
  h.check('Esc cleared that filter and left the panel open',
    lastFrame(h)?.query === '' && lastFrame(h)?.page === 'models',
    `query=${JSON.stringify(lastFrame(h)?.query)} page=${JSON.stringify(lastFrame(h)?.page)}`)
  await h.key('s', 900)   // a fresh panel again, so the search box is the one the keys reach
  await h.key('a', 400)
  await h.key('l', 700)   // a filter that still matches the catalogue
  frame = lastFrame(h)
  const filteredQuery = frame?.query
  await h.key('Escape', 800)
  h.check('Esc clears a typed filter and leaves the panel open',
    filteredQuery !== '' && filteredQuery !== undefined && lastFrame(h)?.page === 'models' && lastFrame(h)?.query === '',
    `before=${JSON.stringify(filteredQuery)} after=${JSON.stringify(lastFrame(h)?.query)} page=${JSON.stringify(lastFrame(h)?.page)}`)
  await h.key('Escape', 800)
  await h.sleep(300)
  h.check('and the next Esc closes it (the client paints no sheet at all)',
    pickerNode(h.snapshot()) === undefined,
    `pickerNodes=${h.classNodes(h.snapshot(), 'sf-picker').length}`)

  // --------------------------------------------- claim 8: sessionless title/labels
  await h.key('s', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('the sessionless catalogue uses its own title, hint and honest write label',
    frame?.title === 'Choose default model' && frame?.subtitle === 'Tab actions'
    && actionLabels(frame).includes('Save default') && actionIds(frame) === 'close,apply'
    && !h.classNodes(snap, 'pk-badge').some((node) => String(node.text) === 'current'),
    `${JSON.stringify(frame?.title)} :: ${actionIds(frame)} :: ${actionLabels(frame)}`)

  // ---------------- a row click reclaims the keyboard from the strip ----------------
  // The reviewer's transition gap: with the keyboard in the strip (a user clicked a candidate
  // there), a MOUSE click on another model must hand the keys back to the list — otherwise the
  // next ↑/↓ keeps drafting the PREVIOUS model's effort while the highlight silently sits on
  // the clicked one.
  {
    // Fixture 5: BOTH models advertise the same candidates — the case that tells the zone
    // reclaim apart from `normalize()`'s "the strip is gone" reset.
    await h.key('5', 900)
    // Leave the Reader if an earlier section left it open; in the catalogue Esc would CLOSE
    // the panel, so the page is checked first.
    if (lastFrame(h)?.page !== 'models') await h.key('Escape', 800)
    await h.sleep(300)
    // A KNOWN state. Fixture 5 keeps the previous selection (beta), so clicking Alpha's row is
    // a plain `select`; clicking an ALREADY highlighted row would ACTIVATE and open the Reader
    // instead, which is exactly the confusion this check must not have.
    const alphaRow = modelRows(h, h.snapshot()).find((node) => h.descendantsText(node).includes('Alpha Model'))
    const alphaClicked = alphaRow === undefined ? false : await h.click(h.snapshot().chains, alphaRow)
    await h.sleep(400)
    h.check('the twin catalogue is drivable: a real click highlights Alpha as a plain SELECT',
      alphaClicked && lastFrame(h)?.page === 'models' && lastFrame(h)?.selected === JSON.stringify(['alpha', 'm-alpha']),
      `clicked=${alphaClicked} page=${JSON.stringify(lastFrame(h)?.page)} selected=${JSON.stringify(lastFrame(h)?.selected)}`)
    const chip = chipWithText(h, h.snapshot(), 'High')
    const chipClicked = chip === undefined ? false : await h.click(h.snapshot().chains, chip)
    await h.sleep(400)
    h.check('clicking a candidate puts the keyboard on the STRIP',
      chipClicked && lastFrame(h)?.focus === 'strip' && lastFrame(h)?.page === 'models',
      `clicked=${chipClicked} focus=${JSON.stringify(lastFrame(h)?.focus)} subtitle=${JSON.stringify(lastFrame(h)?.subtitle)}`)
    // Beta is NOT the highlighted model now, so this real click is a `select` too.
    const betaRow = modelRows(h, h.snapshot()).find((node) => h.descendantsText(node).includes('Beta Model'))
    const rowClicked = betaRow === undefined ? false : await h.click(h.snapshot().chains, betaRow)
    await h.sleep(400)
    h.check('a MOUSE click on another EFFORT-bearing model hands the keys back to the list',
      rowClicked && lastFrame(h)?.page === 'models' && lastFrame(h)?.selected === JSON.stringify(['beta', 'm-beta'])
      && lastFrame(h)?.focus === 'list' && lastFrame(h)?.subtitle === 'Tab effort',
      `focus=${JSON.stringify(lastFrame(h)?.focus)} subtitle=${JSON.stringify(lastFrame(h)?.subtitle)} selected=${JSON.stringify(lastFrame(h)?.selected)}`)
    const selBefore = lastFrame(h)?.selected
    await h.key('Down', 500)
    // The decisive pair: the ROW cursor moved (so the keys are the list's), and the strip now
    // shows the NEWLY highlighted model's own draft — not the previous model's, which is what
    // a still-strip zone would have edited.
    const onAfter = String((lastFrame(h)?.strip?.items ?? []).find((item) => item.on === true)?.id ?? '')
    h.check("and the next ↓ walks the LIST, not the previous model's draft",
      lastFrame(h)?.page === 'models' && lastFrame(h)?.selected !== selBefore
      && onAfter.includes(`effort:${String(lastFrame(h)?.selected)}\u0000`),
      `selected=${JSON.stringify(lastFrame(h)?.selected)} was=${JSON.stringify(selBefore)} on=${JSON.stringify(onAfter)}`)
  }

  // ------------------ the node identity a REAL click must not change (in place) ------
  // The reported defect: a click on a model lower in the list moved the whole viewport,
  // because the picker's node key carried the frame revision, so the SDK diffed del+add
  // and the client REMOUNTED the list (a freshly mounted list brings its selected row into
  // view). A node whose identity is long-lived cannot remount, so the picker's own wire id
  // survives the click that changes the selection. The forty-row, scrolled-list case lives
  // in `scripts/tern-pane-scroll-probe.mjs`, whose fixture is long enough to scroll.
  {
    const before = h.snapshot()
    const selBefore = (lastFrame(h)?.selected ?? null)
    // The REAL wire id the SDK gave the picker's node this frame, recorded by the subject
    // from its own view tree: the identity the client keys its DOM on.
    const idBefore = lastFrame(h)?.pickerId
    const row = modelRows(h, before)
      .find((node) => !(node.class ?? '').split(' ').includes('sel') && containedXY(before.chains, node))
    const clicked = row === undefined ? false : await h.click(before.chains, row)
    await h.sleep(200)
    const after = h.snapshot()
    const idAfter = lastFrame(h)?.pickerId
    h.check('the picker keeps ONE node identity across a real selection click (no remount)',
      typeof idBefore === 'string' && clicked && idAfter === idBefore,
      `before=${JSON.stringify(idBefore)} after=${JSON.stringify(idAfter)} clicked=${clicked} selectedBefore=${JSON.stringify(selBefore)} selectedAfter=${JSON.stringify(lastFrame(h)?.selected ?? null)}`)
    h.measure('the rows the click left on screen', JSON.stringify(modelRows(h, after).map((node) => `${h.descendantsText(node).slice(0, 12)}@${Math.round(rect(node)[1])}${(node.class ?? '').includes('sel') ? '[SEL]' : ''}`)))
  }

  // ------------------------------------- claim 9: measured capability + ledger
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
  h.measure('the captured theme', JSON.stringify(themeOf(h, bootShot)))
  h.measure('the catalogue label font', JSON.stringify(fontAt(h, bootShot, 'pk-label')))
  h.measure('the strip chip font', JSON.stringify(fontAt(h, bootShot, 'pk-schip')))
  h.measure('the Reader title font', JSON.stringify(fontAt(h, readerTopShot, 'sf-ov-title')))
  h.measure('every size\'s cols/cell.w as the subject received it', JSON.stringify(resizes(h)))
  h.measure('the per-size strip/list geometry', JSON.stringify(columnMetrics))
  h.measure('the source revision this run rendered (sha256 prefix per module)', sourceHash(h))
  h.measure('frames rendered', String(frames(h).length))
  h.measure('native scroll ops the app asked for', JSON.stringify(scrolls(h)))
  h.measure('raw row events the subject received', JSON.stringify(rowEvents(h)))
  h.measure('raw action events the subject received', JSON.stringify(actionEvents(h)))
  h.measure('writes that reached the subject writer', JSON.stringify(applies(h).map((row) => row.apply.selection)))
  h.measure('retries that reached the subject read owner', String(retries(h).length))
  h.measure('every frame page observed (two pages only)', JSON.stringify([...new Set(frames(h).map((entry) => entry.page))]))
}
