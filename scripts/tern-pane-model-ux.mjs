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
 *    still flips `lg`/`md` on the measured 900px reconstruction;
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
const actionIds = (frame) => (frame?.actions ?? []).map((action) => action.id).join(',')
const actionLabels = (frame) => (frame?.actions ?? []).map((action) => String(action.label ?? '')).join(' | ')
const itemOf = (frame, id) => (frame?.items ?? []).find((item) => item.id === id)
const pickerNode = (snap) => snap.nodes.find((node) => (node.class ?? '').split(' ').includes('sf-picker'))
const pickerClasses = (snap) => (pickerNode(snap)?.class ?? '').split(' ').filter(Boolean)
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

/** One strip click by candidate LABEL: the chip is text-located, then clicked. */
const clickChip = async (h, label) => {
  const snap = h.snapshot()
  const chip = chipWithText(h, snap, label)
  if (chip === undefined || !containedXY(snap.chains, chip)) return false
  return await h.click(snap.chains, chip)
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
  const wide = panePx >= 900
  const classes = pickerClasses(snap)
  const modelName = itemOf(frame, frame?.selected)?.label

  h.measure(`${cellKey}: cols/cell.w/pane px`, JSON.stringify({ cols, cell, panePx }))
  h.check(`${cellKey}: the presenter claims ${wide ? 'lg' : 'md'} + preview none at ${panePx}px`,
    frame?.page === 'models' && frame?.size === (wide ? 'lg' : 'md') && frame?.preview === 'none',
    JSON.stringify({ page: frame?.page, size: frame?.size, preview: frame?.preview, cols, cell, panePx }))
  h.check(`${cellKey}: the client paints ${wide ? 'sz-lg' : 'sz-md'} + pv-none and never pv-below`,
    classes.includes(wide ? 'sz-lg' : 'sz-md') && classes.includes('pv-none') && !classes.includes('pv-below'),
    classes.join(' '))
  h.check(`${cellKey}: no preview region and no fact column are painted`,
    h.classNodes(snap, 'pk-pv').length === 0 && h.classNodes(snap, 'pk-fact').length === 0
    && (frame?.columns ?? undefined) === undefined && (frame?.items ?? []).every((item) => item.facts === undefined),
    `pk-pv=${h.classNodes(snap, 'pk-pv').length} pk-fact=${h.classNodes(snap, 'pk-fact').length} columns=${JSON.stringify(frame?.columns)}`)
  h.check(`${cellKey}: the catalogue paints no scope column`, scopeTokens(snap).length === 0
    && !(frame?.propKeys ?? []).includes('scopes'), `${scopeTokens(snap).join(',')} :: ${(frame?.propKeys ?? []).join(',')}`)

  const barButtons = buttons(h, snap)
  h.check(`${cellKey}: the footer is exactly Cancel + the one write, both contained`,
    barButtons.length === 2 && actionIds(frame) === 'close,apply' && (frame?.actions ?? []).filter((action) => action.id === 'apply').length === 1
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
  if (SECTION9.has(cellKey)) h.capture(`reader-${cellKey}`, `the ${cellKey} Reader top`)
  await h.key('Escape', 900)
  h.check(`${cellKey}: Esc returns the Reader to the catalogue`,
    lastFrame(h)?.page === 'models', JSON.stringify(lastFrame(h)?.page))
  return { metrics: { panePx, cols, cell, chipRows: stripRows, wide } }
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
    frame?.page === 'models' && frame?.title === 'Switch model' && frame?.subtitle === 'Tab: effort',
    JSON.stringify({ title: frame?.title, subtitle: frame?.subtitle }))
  h.check('boot: the catalogue asks for no preview region and paints none',
    frame?.size === 'lg' && frame?.preview === 'none' && !pickerClasses(snap).includes('pv-below')
    && h.classNodes(snap, 'pk-pv').length === 0,
    `${pickerClasses(snap).join(' ')} :: pk-pv=${h.classNodes(snap, 'pk-pv').length}`)
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
  h.check('boot: the default row carries the Default badge and never a fake current',
    defaulted !== undefined && subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'Default')
    && !subclass(defaulted, 'pk-badge').some((node) => String(node.text) === 'current'),
    defaulted === undefined ? 'no default row' : h.descendantsText(defaulted))
  h.check('boot: every model appears exactly once (one row per provider+model)',
    ['Alpha Model', 'Alpha Second', 'Beta Model'].every((label) => modelRows(h, snap).filter((node) => h.descendantsText(node).includes(label)).length === 1),
    modelRows(h, snap).map((node) => h.descendantsText(node)).join(' | '))
  const bootGroups = groupRows(h, snap)
  h.check('boot: the pinned Current / Default group is the FIRST group',
    bootGroups.length >= 1 && h.descendantsText(bootGroups[0]).includes('Current / Default'),
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
  h.check('the 900px reconstruction is the lg/md line at every one of the ten sizes',
    columnMetrics.every((entry) => entry.wide === (entry.panePx >= 900))
    && columnMetrics.some((entry) => entry.wide) && columnMetrics.some((entry) => !entry.wide),
    JSON.stringify(columnMetrics))

  // ------------------------------- claim 3: the strip zone, a click and the ONE write
  await toCatalogue(h)
  await h.resize(1280, 800)
  await h.key('Tab', 700)
  snap = h.snapshot()
  h.check('Tab reaches the strip and the sheet paints the native f-strip focus',
    lastFrame(h)?.focus === 'strip' && pickerClasses(snap).includes('f-strip'),
    `focus=${JSON.stringify(lastFrame(h)?.focus)} :: ${pickerClasses(snap).join(' ')}`)
  await h.key('Tab', 700)
  h.check('the next Tab reaches the action bar and marks the focused write',
    actionLabels(lastFrame(h)).includes('▸ Switch'), `${actionIds(lastFrame(h))} :: ${actionLabels(lastFrame(h))}`)
  await h.key('Escape', 700)   // back to the list zone

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

  // --------------------------------------- claim 4: a model with NO effort metadata
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
    frame?.subtitle === 'Tab: actions', JSON.stringify(frame?.subtitle))
  await h.key('Tab', 700)
  h.check('Tab skips the missing strip and reaches the bar in one step',
    actionLabels(lastFrame(h)).includes('▸ Switch') && lastFrame(h)?.focus !== 'strip',
    `${actionIds(lastFrame(h))} :: ${actionLabels(lastFrame(h))} focus=${JSON.stringify(lastFrame(h)?.focus)}`)

  // ------------------------------- claim 5: the 8-item widest-label strip edge
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
    h.check(`${cellKey}: the 8 widest-label candidates are all painted and contained (the strip wraps, not scrolls)`,
      wideStrip?.items?.length === 8 && wideChips.length === 8 && wideChips.every((node) => containedXY(snap.chains, node))
      && wideRows >= 2 && visibleSpan(snap.chains, stripNode(snap), 'y') > 0,
      `wire=${wideStrip?.items?.length} painted=${wideChips.length} rows=${wideRows} strip@${box(stripNode(snap))}`)
    h.measure(`${cellKey}: 8-item strip geometry`, JSON.stringify({
      strip: rect(stripNode(snap)), chipRows: wideRows, list: rect(h.classNodes(snap, 'pk-scroll')[0]), chips: wideChips.map((node) => box(node)),
    }))
    const writesBeforeEach = applies(h).length
    let allClickable = true
    for (let index = 0; index < 8; index += 1) {
      const label = `Effort ${index + 1} `
      const wireItem = (lastFrame(h)?.strip?.items ?? []).find((item) => String(item.label).startsWith(label))
      const before = stripEvents(h).length
      const clicked = await clickChip(h, label)
      const events = stripEvents(h).slice(before)
      const nowOn = onChips(h, h.snapshot())
      const ok = clicked && wireItem !== undefined && events.length === 1 && String(events[0].value) === String(wireItem.id)
        && nowOn.length === 1 && h.descendantsText(nowOn[0]).startsWith(label)
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
  const longOpened = await enterReader(h)
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
  h.measure('the client normalizes whitespace in its node dump', JSON.stringify(String(notice?.text)))
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
  const retryRow = rowWithText(h, snap, 'Retry failed providers')
  const retriesBefore = retries(h).length
  const appliesBeforeRetry = applies(h).length
  const retryClicked = retryRow === undefined ? false : await h.click(snap.chains, retryRow)
  h.check('one REAL click on the retry row reaches the retry spy exactly once and never the writer',
    retryClicked && retries(h).length === retriesBefore + 1 && applies(h).length === appliesBeforeRetry,
    `clicked=${retryClicked} retries=${retries(h).length} applies=${applies(h).length}`)

  // --------------------------------------------- claim 8: sessionless title/labels
  await h.key('s', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('the sessionless catalogue uses its own title, hint and honest write label',
    frame?.title === 'Choose default model' && frame?.subtitle === 'Tab: actions'
    && actionLabels(frame).includes('Save default') && actionIds(frame) === 'close,apply'
    && !h.classNodes(snap, 'pk-badge').some((node) => String(node.text) === 'current'),
    `${JSON.stringify(frame?.title)} :: ${actionIds(frame)} :: ${actionLabels(frame)}`)

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
