/**
 * TSP I-E REAL GUI-WINDOW evidence flow (the third lane of docs/guides/tern-gui-testing.md).
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs \
 *     scripts/tern-gui-history-search.mjs --out <fresh evidence directory>
 *
 * The SAME production Direct/TSP subject (`tern-pane-history-search-ux-subject.mts`,
 * i.e. the official Direct fixture + the real `mountTspRenderer` + the real
 * History seat) runs inside a REAL Tern GUI window on a real display. This lane
 * owns what only a real window can answer: the native OS chrome, the desktop
 * font stack, the live-window Appearance switch and the client's own rendering
 * of the History card.
 *
 * Evidence tier: `REAL_TERN_GUI` for the window and its rendering plus
 * `CONTROL_INJECTED_INPUT` for every key/click. It is NOT `OS_INPUT_VERIFIED`:
 * `tern ctl key|click` is not an OS input device, and no OS screen reader, IME
 * or desktop-clipboard write is exercised here. The headless lane
 * (`tern-pane-history-search-ux.mjs`) owns the narrow-width assertions, because
 * the real window enforces a native minimum width and clamps a 400px request —
 * a clamped band is recorded as a measurement here, never promoted to a pass.
 * @module scripts/tern-gui-history-search
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { index, rect, visibleSpan, containedXY } from './tern-pane-geometry.mjs'

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '900x700', width: 900, height: 700 },
  // The real window enforces a native minimum (measured 720px wide on this
  // build): these bands may clamp, and a clamp is a measurement.
  { name: '400x600', width: 400, height: 600, optionalClamp: true },
  { name: '900x360', width: 900, height: 360, optionalClamp: true },
]
const APPEARANCES = ['light', 'dark']
const CTRL_R = 'ControlOrMeta+r'
const CARD_ID = /(^|\.)history-card-\d+$/
const SEED_ROWS = ['oldest stored prompt', 'middle stored prompt about tern', 'newest stored prompt']

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const records = h => {
  const path = eventPath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}
const wireRecords = h => {
  const path = wirePath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}
const liveWire = h => {
  const nodes = new Map()
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object') return
    if (typeof node.id === 'string') nodes.set(node.id, { k: node.k, p: node.p ?? {} })
    for (const child of node.c ?? []) visit(child)
    for (const slot of ['head', 'end', 'foot']) {
      const value = node.p?.[slot]
      if (value && typeof value === 'object') visit(value)
    }
  }
  const dropSubtree = id => {
    for (const candidate of [...nodes.keys()]) {
      if (candidate === id || candidate.startsWith(`${id}.`)) nodes.delete(candidate)
    }
  }
  for (const line of wireRecords(h)) {
    if (line.dir !== 'out' || line.verb !== 'f') continue
    for (const op of line.body?.ops ?? []) {
      // The SDK grammar is ['add', id, parentId, nextId, node]; re-adding an id
      // replaces its subtree, so the fold must drop the stale children first.
      if (op[0] === 'add' && typeof op[1] === 'string') {
        dropSubtree(op[1])
        visit(op[4])
      } else if (op[0] === 'del' && typeof op[1] === 'string') dropSubtree(op[1])
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: undefined, p: {} }
        const next = { ...previous.p }
        for (const [key, value] of Object.entries(op[2] ?? {})) {
          if (value === null) delete next[key]
          else next[key] = value
        }
        nodes.set(op[1], { ...previous, p: next })
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: undefined, p: {} }
        const before = typeof previous.p.text === 'string' ? previous.p.text : ''
        nodes.set(op[1], { ...previous, p: { ...previous.p, text: op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '') } })
      }
    }
  }
  return nodes
}
const wireIds = (h, pattern) => [...liveWire(h).keys()].filter(id => pattern.test(id))
const cardLive = h => wireIds(h, CARD_ID).length > 0
const queryField = h => {
  for (const [id, node] of liveWire(h)) {
    if (/-query$/.test(id) && node.k === 'input') return { id, text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
  }
  return undefined
}
const composerOf = h => {
  for (const [id, node] of liveWire(h)) {
    if ((id === 'dock.quiet-composer.composer' || id === 'dock.composer') && node.k === 'editor') {
      return { id, text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    }
  }
  return undefined
}
const frameOps = (h, kind) => wireRecords(h)
  .filter(entry => entry.dir === 'out' && entry.verb === 'f')
  .flatMap(entry => (entry.body?.ops ?? []).filter(op => op[0] === kind))

const visibleNodes = snap => snap.nodes.filter(node => {
  const box = rect(node)
  return box[2] > 0 || box[3] > 0
})
const cardInTree = snap => visibleNodes(snap).some(node => String(node.text ?? '') === 'Input History')
const nodeWithText = (snap, text) => visibleNodes(snap).find(node => String(node.text ?? '') === text)
const buttonLabeled = (snap, h, label) => visibleNodes(snap).find(node => node.tag === 'button'
  && h.descendantsText(node).includes(label))
const editorNode = snap => visibleNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-editor'))
const caretNode = snap => visibleNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-caret'))
const mainNode = snap => visibleNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const dockNode = snap => visibleNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-dock'))

const waitUntil = async (h, label, predicate, { limit = 120, intervalMs = 250 } = {}) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
const requiredWait = async (h, label, predicate, options) => {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify({
    events: records(h).slice(-5),
    texts: h.texts(h.snapshot()).slice(-14),
    cardLive: cardLive(h),
    query: queryField(h),
  }))
  return ok
}
const safeKey = async (h, label, name, settleMs = 500) => {
  try {
    await h.key(name, settleMs)
    h.measure(label, JSON.stringify({ key: name, delivered: 'exactly once' }))
    return true
  } catch (error) {
    h.measure(`${label} NOT_VERIFIED`, `${String(error)} :: control channel does not provide this input`)
    return false
  }
}
const sdkKeys = h => records(h).filter(entry => entry.kind === 'sdk.key')
const writeLedger = (h, name, value) => {
  const path = join(h.root, name)
  writeFileSync(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined

/**
 * One GUI cell. The tree artifact the run captured for THIS cell is the
 * snapshot under test, so the assertion and the auditable PNG/tree can never
 * disagree; the live wire fold is the second authority for "this card is the
 * seat's current card".
 */
const geometryCell = (h, appearance, viewport, captureId) => {
  const snap = index(readJson(join(h.root, `${captureId}.tree.json`)).tree ?? [])
  const state = h.ctl('state')
  const stats = h.ctl('stats')
  const title = nodeWithText(snap, 'Input History')
  const restore = buttonLabeled(snap, h, 'Restore to draft')
  const copy = buttonLabeled(snap, h, 'Copy all')
  const editor = editorNode(snap)
  const caret = caretNode(snap)
  const box = node => node === undefined ? undefined : rect(node)
  const contained = node => node === undefined ? false : containedXY(snap.chains, node)
  const spanY = node => node === undefined ? 0 : visibleSpan(snap.chains, node, 'y')
  const rows = visibleNodes(snap).filter(node => node.tag === 'button' && /stored prompt/.test(h.descendantsText(node)))
  const cell = {
    viewport: viewport.name,
    requested: [viewport.width, viewport.height],
    actualViewport: stats.viewport?.slice(0, 2),
    exactRequested: stats.viewport?.[0] === viewport.width && stats.viewport?.[1] === viewport.height,
    appearance,
    resolvedTheme: state.theme,
    cardLiveOnWire: cardLive(h),
    cardPaintedInTree: cardInTree(snap),
    cardWireId: wireIds(h, CARD_ID)[0] ?? null,
    title: { rect: box(title), containedXY: contained(title), spanY: spanY(title) },
    restore: { rect: box(restore), containedXY: contained(restore), spanY: spanY(restore) },
    copy: { rect: box(copy), containedXY: contained(copy), spanY: spanY(copy) },
    composer: { rect: box(editor), containedXY: contained(editor), spanY: spanY(editor) },
    caret: { rect: box(caret), containedXY: contained(caret), spanY: spanY(caret) },
    main: { rect: box(mainNode(snap)), containedXY: contained(mainNode(snap)) },
    dock: { rect: box(dockNode(snap)), containedXY: contained(dockNode(snap)) },
    completeRows: rows.filter(node => rect(node)[3] >= 20 && spanY(node) >= 20 && contained(node)).length,
    rowBoxes: rows.map(node => ({ rect: rect(node), visibleSpanY: spanY(node), contained: contained(node) })),
    draft: composerOf(h)?.text,
    queryText: queryField(h)?.text,
    png: join(h.root, 'shots', `${captureId}.png`),
    nodeTree: join(h.root, `${captureId}.tree.json`),
  }
  const coreVisible = cell.title.containedXY && cell.restore.containedXY && cell.composer.containedXY
    && cell.caret.containedXY === true && cell.cardLiveOnWire === true && cell.cardPaintedInTree === true
  if (viewport.optionalClamp && !cell.exactRequested) {
    // The window clamped the request: report the clamp honestly and measure.
    h.check(`${viewport.name} ${appearance}: the real window reports its native minimum-size clamp honestly`,
      cell.resolvedTheme === appearance && cell.actualViewport?.length === 2,
      JSON.stringify({ requested: cell.requested, actual: cell.actualViewport }))
    h.measure(`${viewport.name} ${appearance}: clamped card core measurement`, JSON.stringify({
      coreVisible, title: cell.title, restore: cell.restore, composer: cell.composer, completeRows: cell.completeRows,
    }))
  } else {
    h.check(`${viewport.name} ${appearance}: the real window took the viewport, resolved ${appearance}, and shows the card with its Restore, one complete row and the ONE composer`,
      cell.resolvedTheme === appearance && cell.exactRequested && coreVisible && cell.completeRows >= 1,
      JSON.stringify(cell))
  }
  return cell
}

const finish = (h, extra = {}) => {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  const ternBin = process.env.TERN_BIN ?? 'tern'
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern@0\.2\.0'/u.test(lock) ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  h.measure('tern version', ternVersion)
  h.measure('SDK lock/integrity', JSON.stringify({ pin: sdkPin, integrity }))
  h.check('the pinned SDK is @stencil-hq/tern 0.2.0 with a lock integrity',
    sdkPin === '0.2.0' && integrity.startsWith('sha512-'), `pin=${sdkPin} integrity=${integrity}`)

  const system = h.ctl('system')
  h.check('this lane is a REAL native window on a REAL display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  const size = await h.resize(1280, 800)
  h.measure('window resize', JSON.stringify(size))
  writeFileSync(join(h.root, 'case'), '')
  const subject = join(h.repo, 'scripts', 'tern-pane-history-search-ux-subject.mts')
  h.check('the production Direct/TSP subject launches inside a pane of the real window',
    await h.launch(subject, { ready: 'dsh-pi-tui' }))
  if (!await requiredWait(h, 'the official Direct fixture and the production renderer are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
      && records(h).some(entry => entry.kind === 'history.bind'
        && entry.hasSource === true && entry.hasCwd === true && entry.hasCapture === true), { limit: 240 })) {
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  h.measure('subject capabilities', JSON.stringify(subjectReady?.caps))
  writeLedger(h, 'environment.json', {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    workRoot: subjectReady?.workRoot,
    seededRows: subjectReady?.seededRows,
    nativeSystem: { displays: system.displays, title: system.title },
    lane: 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT',
  })

  // 1. Ctrl+R in the real window, proven by the SDK's own decoded Key.
  const keysBefore = sdkKeys(h).length
  const focusBefore = frameOps(h, 'focus').length
  await safeKey(h, 'Ctrl+R in the real window', CTRL_R, 600)
  const decoded = sdkKeys(h).slice(keysBefore).find(entry => entry.name === 'r' && entry.ctrl === true)
  h.check('the real window decoded the injected chord as Ctrl+R (ctrl:true)',
    decoded !== undefined, JSON.stringify({ injected: CTRL_R, arrived: decoded ?? null, recent: sdkKeys(h).slice(-3) }))
  if (!await requiredWait(h, 'the real window painted the History card and focused its query', () =>
    cardLive(h) && cardInTree(h.snapshot())
      && frameOps(h, 'focus').length > focusBefore
      && String(frameOps(h, 'focus').at(-1)?.[1] ?? '').endsWith('-query'), { limit: 120 })) {
    h.capture('01-open-failed-gui', 'the real window while the card did not open')
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  h.check('the real window renders the card title and a real result counter',
    h.texts(h.snapshot()).includes('Input History')
      && h.texts(h.snapshot()).some(text => /^Results · \d+ shown/u.test(text)),
    JSON.stringify(h.texts(h.snapshot()).slice(-16)))
  h.check('the ONE controlled composer is still the only editor on the frame',
    wireIds(h, /(^|\.)dock\.(quiet-composer\.)?composer$/).length === 1,
    JSON.stringify(wireIds(h, /composer$/)))
  h.capture('02-open-gui-1280x800-light', 'the Ctrl+R card in a real GUI window')

  // 2. Selection reveal FIRST, on the unfiltered multi-row page, then the
  //    query, the Scope cycle and the independent Preview scroll in the window.
  const revealsAtOpen = frameOps(h, 'reveal').length
  await safeKey(h, 'ArrowDown selects the next real row in the window', 'ArrowDown', 450)
  h.check('a real selection move issued a native reveal op on the wire',
    frameOps(h, 'reveal').length > revealsAtOpen,
    JSON.stringify({ before: revealsAtOpen, after: frameOps(h, 'reveal').length,
      last: frameOps(h, 'reveal').at(-1) }))
  for (const letter of 'tern') await safeKey(h, `type ${letter} in the window`, letter, 200)
  await requiredWait(h, 'the window query field carries the typed text', () =>
    (queryField(h)?.text ?? '') === 'tern', { limit: 90 })
  await safeKey(h, 'Tab cycles the Scope in the window', 'Tab', 450)
  await requiredWait(h, 'the Scope cycle reads through the bound source', () =>
    h.texts(h.snapshot()).some(text => text === 'Scope: Directory ⌄'), { limit: 90 })
  const scrollsBefore = frameOps(h, 'scroll').length
  await safeKey(h, 'Alt+Down scrolls the window Preview', 'Alt+ArrowDown', 450)
  h.check('the Preview container received a real native scroll op',
    frameOps(h, 'scroll').length > scrollsBefore
      && String(frameOps(h, 'scroll').at(-1)?.[1] ?? '').endsWith('-preview-scroll'),
    JSON.stringify(frameOps(h, 'scroll').slice(-2)))
  h.capture('03-query-scope-reveal-scroll-gui', 'real query, Scope, reveal and independent Preview scroll in the window')

  // 3. Restore is the only draft write; Esc is a seat cancel only.
  const restoreSnap = h.snapshot()
  const restoreTarget = buttonLabeled(restoreSnap, h, 'Restore to draft')
  const restoreClicked = restoreTarget !== undefined && containedXY(restoreSnap.chains, restoreTarget)
    ? await h.click(restoreSnap.chains, restoreTarget)
    : false
  h.check('a control-injected click on the visible Restore button reached the real handler',
    restoreClicked === true, JSON.stringify({ rect: restoreTarget === undefined ? null : rect(restoreTarget) }))
  if (!await requiredWait(h, 'the window composer holds the restored stored text', () =>
    (composerOf(h)?.text ?? '') !== '' && !cardInTree(h.snapshot()), { limit: 120 })) {
    finish(h, {})
    return
  }
  const restored = composerOf(h)
  h.check('the restored window draft is a real stored row and reached no submission sink',
    SEED_ROWS.some(row => restored?.text === row)
      && records(h).filter(entry => entry.kind === 'writer.prompt').length === 0
      && records(h).filter(entry => entry.kind === 'handler.submit').length === 0,
    JSON.stringify({ restored, submits: records(h).filter(entry => entry.kind === 'handler.submit').length }))
  await safeKey(h, 'Ctrl+R reopens the card in the window', CTRL_R, 500)
  await requiredWait(h, 'the card reopened in the window', () => cardInTree(h.snapshot()), { limit: 90 })
  const cancelsBefore = records(h).filter(entry => entry.kind === 'handler.cancel').length
  const beforeEsc = composerOf(h)
  await safeKey(h, 'Esc cancels only the card in the window', 'Escape', 450)
  await requiredWait(h, 'Esc closed the card in the window', () => !cardInTree(h.snapshot()), { limit: 90 })
  h.check('the window Esc cancel left the draft byte-exact and never interrupted the Agent',
    composerOf(h)?.text === beforeEsc?.text && composerOf(h)?.cursor === beforeEsc?.cursor
      && records(h).filter(entry => entry.kind === 'handler.cancel').length === cancelsBefore,
    JSON.stringify({ before: beforeEsc, after: composerOf(h) }))
  h.capture('04-restore-cancel-gui', 'the window composer after Restore, and after an Esc seat cancel')

  // 4. Four sizes × two live-window appearances.
  const cells = []
  for (const viewport of VIEWPORTS) {
    const resized = await h.resize(viewport.width, viewport.height)
    h.measure(`resize ${viewport.name}`, JSON.stringify(resized))
    for (const appearance of APPEARANCES) {
      // The harness `appearance` is a no-op in a live window: the switch goes
      // through the client's own plugin command.
      await h.send('plugins', 'run', `appearance:${appearance}`)
      await h.sleep(500)
      if (!cardInTree(h.snapshot())) await safeKey(h, `open card ${viewport.name} ${appearance}`, CTRL_R, 500)
      if (!await requiredWait(h, `the card is visible at ${viewport.name} ${appearance}`,
        () => cardInTree(h.snapshot()), { limit: 90 })) continue
      const id = h.capture(`cell-${viewport.name}-${appearance}`, `History search in the real window ${viewport.name} ${appearance}`)
      cells.push(geometryCell(h, appearance, viewport, id))
    }
  }
  await h.send('plugins', 'run', 'appearance:light')
  writeLedger(h, 'gui-cells.json', cells)
  h.check('every GUI cell produced a real PNG inside the run directory',
    cells.length > 0 && cells.every(cell => existsSync(cell.png)),
    JSON.stringify(cells.map(cell => ({ v: cell.viewport, a: cell.appearance, png: cell.png }))))
  const exactCells = cells.filter(cell => cell.exactRequested)
  h.check('the bands the window really took each show one complete row, Restore and the ONE composer',
    exactCells.length > 0 && exactCells.every(cell => cell.completeRows >= 1
      && cell.restore.containedXY && cell.composer.containedXY),
    JSON.stringify(exactCells.map(cell => ({ v: cell.viewport, a: cell.appearance, rows: cell.completeRows,
      restore: cell.restore.containedXY, composer: cell.composer.containedXY }))))

  writeLedger(h, 'gui-lane-ledger.json', {
    ternVersion,
    sdk: { pin: sdkPin, integrity },
    REAL_TERN_GUI: `${cells.length} cells on a real native window (displays ${JSON.stringify(system.displays)})`,
    CONTROL_INJECTED_INPUT: 'tern ctl key|click only',
    OS_PHYSICAL_INPUT: 'NOT_VERIFIED (no OS keyboard/mouse device run)',
    IME: 'NOT_VERIFIED',
    OS_SCREEN_READER: 'NOT_VERIFIED (no OS accessibility bridge in this lane)',
    OS_CLIPBOARD_WRITE: 'NOT_VERIFIED (the copy path is proven in the headless lane by the Client-local emission)',
    WHEEL_TRACKPAD: 'NOT_VERIFIED (no wheel delivery; the keyboard Alt+arrow path proved the native Preview scroll)',
    NARROW_WIDTH: 'the real window enforces a native minimum width; 400x600 is a headless-lane question (tern-pane-history-search-ux.mjs)',
    OWNER_G8_VISUAL: 'NOT_SIGNED (PNG/tree/layout evidence submitted for Owner visual acceptance)',
    keySpelling: 'ControlOrMeta+r → ctrl:true (asserted from the SDK decoded Key in this window too)',
  })
  h.measure('Owner G8 visual acceptance', 'NOT_SIGNED: real-window PNG evidence submitted')
  finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity }, cells: cells.length, ownerG8: 'NOT_SIGNED' })
}
