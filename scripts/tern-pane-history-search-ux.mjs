/**
 * TSP I-E real-Tern UX evidence flow (8 cells: 4 geometries × 2 themes).
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-history-search-ux.mjs
 *     --out <fresh evidence directory>
 *
 * ONE production Direct/TSP composition runs inside a real headless
 * `tern serve --control` pane. The subject's OWN `events.jsonl` and
 * `sdk-wire.jsonl` record the production handler/writer/wire facts, while the
 * flow reads the real Tern node tree, layout and PNG. A `ctl key|click` reply
 * is NEVER treated alone as proof that input arrived: every positive claim is
 * read back from the SDK's own decoded `Key` (the subject's iterator witness),
 * the SDK wire fold, or the client tree.
 *
 * TWO authorities, always paired (this is the lane's core discipline):
 *  - the SDK's `TERN_TSP_RECORD` wire fold gives the LIVE node ids, the ONE
 *    composer's `text`/`cursor`, the query field's props and the
 *    `focus`/`reveal`/`scroll` ops the mount really issued;
 *  - the client's real tree gives the boxes, clipping and pixels — and, as
 *    `docs/guides/tern-gui-testing.md` records, it carries NO wire ids and NO
 *    custom `data-role`, so a custom surface is addressed there by its own
 *    visible text/tag, never by a role selector.
 *
 * Lane honesty:
 *  - input is GUI_CONTROL (`tern ctl key|type|click`), NOT physical OS input;
 *  - the real client's control channel maps Playwright `Control` to `meta:true`
 *    and `Meta`/`ControlOrMeta` to `ctrl:true` (measured below from the SDK's
 *    own decoded Key), so `Ctrl+R` is injected as `ControlOrMeta+r`;
 *  - GUI / PHYSICAL_OS / IME / desktop fonts / OS-clipboard WRITE /
 *    wheel-trackpad delivery are NOT_VERIFIED;
 *  - visibility goes through the geometry oracle (`containedXY`/`visibleSpan`,
 *    both axes, clipping ancestors) — a node rect alone never is;
 *  - a control command the client does not provide is a measurement /
 *    NOT_VERIFIED, never a pass;
 *  - one run directory per run; `assertions.json`, PNGs, trees and layouts are
 *    kept on success AND failure.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { index, rect, visibleSpan, containedXY } from './tern-pane-geometry.mjs'

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '900x700', width: 900, height: 700 },
  { name: '400x600', width: 400, height: 600 },
  { name: '900x360', width: 900, height: 360 },
]
const APPEARANCES = ['dark', 'light']
/** The real client's control channel swaps Playwright's `Control` and `Meta`:
 *  only `ControlOrMeta+r` (or `Meta+r`) arrives as `{name:'r', ctrl:true}` —
 *  asserted below from the SDK's OWN decoded Key, never assumed. */
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

/** The SDK's own wire recorder folded into the LIVE node set: an id the last
 *  frame deleted is gone, so a retired card can never satisfy a claim. */
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
      // The SDK's own op grammar is ['add', id, parentId, nextId, node]
      // (node_modules/@stencil-hq/tern/dist/reconcile.js), so the id being
      // (re)placed is op[1]. Re-adding a id replaces its subtree: the previous
      // children under it are gone from the client's view and must be gone
      // from the fold, or a retired card would stay "live" forever.
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
    if (/-query$/.test(id) && node.k === 'input') {
      return { id, text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
    }
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
/** The client tree addresses a custom surface by its OWN visible text and tag:
 *  the tree carries no wire ids and no `data-role` (measured; documented in the
 *  GUI guide). A claim about the card therefore names the text AND the live
 *  wire id, so neither authority can pass alone. */
const nodeWithText = (snap, text) => visibleNodes(snap).find(candidate => String(candidate.text ?? '') === text)
const buttonLabeled = (snap, h, label) => visibleNodes(snap).find(candidate => candidate.tag === 'button'
  && h.descendantsText(candidate).includes(label))
const cardInTree = snap => visibleNodes(snap).some(node => String(node.text ?? '') === 'Input History')
/**
 * Both authorities must agree: the seat's live wire surface AND the client's
 * current tree. One alone is never a pass (the fold could keep a card the
 * client dropped; the tree could lag a repaint).
 */
const cardOnScreen = h => {
  const snap = h.snapshot()
  return { live: cardLive(h), painted: cardInTree(snap), snap }
}
const editorNode = snap => visibleNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-editor'))
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
    events: records(h).slice(-6),
    texts: h.texts(h.snapshot()).slice(-16),
    cardLive: cardLive(h),
    query: queryField(h),
  }))
  return ok
}
/** Exactly ONE control-injected key. The driver's `key` is never retried, so a
 *  repeat cannot masquerade as an "exactly once" claim. */
const safeKey = async (h, label, name, settleMs = 450) => {
  try {
    await h.key(name, settleMs)
    h.measure(label, JSON.stringify({ key: name, delivered: 'exactly once' }))
    return true
  } catch (error) {
    h.measure(`${label} NOT_VERIFIED`, `${String(error)} :: control channel does not provide this input`)
    return false
  }
}
/** The SDK's own decoded Key is the positive control for a chord. */
const sdkKeys = h => records(h).filter(entry => entry.kind === 'sdk.key')
const arrivedAs = (h, from, name, modifier) => sdkKeys(h).slice(from)
  .find(entry => entry.name === name && entry[modifier] === true)
const writeLedger = (h, name, value) => {
  const path = join(h.root, name)
  writeFileSync(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
const layoutOf = (h, captureId) => readJson(join(h.root, 'shots', 'serve', `${captureId}.layout.json`))

/** One geometry cell: real client boxes + clipping proof + PNG + tree +
 *  layout theme, PLUS the live wire identity of the same card. */
const geometryCell = (h, appearance, viewport, captureId) => {
  // The capture's own tree file is the snapshot under test: the assertion and
  // the auditable artifact can then never disagree.
  const snap = index(readJson(join(h.root, `${captureId}.tree.json`)).tree ?? [])
  const state = h.ctl('state')
  const stats = h.ctl('stats')
  const layout = layoutOf(h, captureId)
  // Every node below and `snap.chains` come from the SAME indexed tree: the
  // geometry oracle refuses a node that tree never indexed.
  const title = nodeWithText(snap, 'Input History')
  const restore = buttonLabeled(snap, h, 'Restore to draft')
  const copy = buttonLabeled(snap, h, 'Copy all')
  const editor = editorNode(snap)
  const box = node => node === undefined ? undefined : rect(node)
  const contained = (chains, node) => node === undefined ? false : containedXY(chains, node)
  const spanY = (chains, node) => node === undefined ? 0 : visibleSpan(chains, node, 'y')
  const cell = {
    viewport: viewport.name,
    requested: [viewport.width, viewport.height],
    actualViewport: stats.viewport?.slice(0, 2),
    appearance,
    resolvedTheme: state.theme,
    layoutTheme: layout?.theme,
    cardLiveOnWire: cardLive(h),
    cardPaintedInTree: cardInTree(snap),
    cardWireId: wireIds(h, CARD_ID)[0] ?? null,
    title: { rect: box(title), containedXY: contained(snap.chains, title), spanY: spanY(snap.chains, title) },
    restore: { rect: box(restore), containedXY: contained(snap.chains, restore), spanY: spanY(snap.chains, restore) },
    copy: { rect: box(copy), containedXY: contained(snap.chains, copy), spanY: spanY(snap.chains, copy) },
    composer: { rect: box(editor), containedXY: contained(snap.chains, editor), spanY: spanY(snap.chains, editor) },
    // Real result rows: `sf-act` buttons inside the card whose own box survives
    // the card's clipping at full row height (the type scale gives 28px rows).
    rowBoxes: visibleNodes(snap).filter(node => node.tag === 'button'
      && /stored prompt/.test(h.descendantsText(node))).map(node => {
      const own = rect(node)
      return { rect: own, visibleSpanY: visibleSpan(snap.chains, node, 'y'), contained: containedXY(snap.chains, node) }
    }),
    completeRows: visibleNodes(snap).filter(node => node.tag === 'button'
      && /stored prompt/.test(h.descendantsText(node))
      && rect(node)[3] >= 20 && visibleSpan(snap.chains, node, 'y') >= 20
      && containedXY(snap.chains, node)).length,
    main: { rect: box(mainNode(snap)), containedXY: contained(snap.chains, mainNode(snap)) },
    dock: { rect: box(dockNode(snap)), containedXY: contained(snap.chains, dockNode(snap)) },
    focus: state.focus ?? null,
    draft: composerOf(h)?.text,
    queryText: queryField(h)?.text,
    texts: h.texts(snap).slice(-20),
  }
  h.check(`cell ${viewport.name} ${appearance}: the real client resolved the requested appearance`,
    cell.resolvedTheme === appearance && cell.layoutTheme === appearance, JSON.stringify(cell))
  h.check(`cell ${viewport.name} ${appearance}: the card is ONE live surface with its title, Restore and the ONE composer inside the client's clipping ancestors`,
    cell.cardLiveOnWire === true && cell.cardPaintedInTree === true && cell.title.containedXY === true
      && cell.restore.containedXY === true && cell.composer.containedXY === true,
    JSON.stringify({ card: cell.cardWireId, title: cell.title, restore: cell.restore, composer: cell.composer }))
  return cell
}

const finish = (h, extra = {}) => {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  const out = h.root
  const subject = join(h.repo, 'scripts', 'tern-pane-history-search-ux-subject.mts')
  const ternBin = process.env.TERN_BIN ?? 'tern'
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern@0\.2\.0'/u.test(lock) ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  h.measure('tern version', ternVersion)
  h.measure('SDK lock/integrity', JSON.stringify({ pin: sdkPin, integrity }))
  h.check('the pinned SDK is @stencil-hq/tern 0.2.0 with a lock integrity',
    sdkPin === '0.2.0' && integrity.startsWith('sha512-'), `pin=${sdkPin} integrity=${integrity}`)

  await h.resize(1280, 800)
  writeFileSync(join(out, 'case'), '')
  h.check('the production Direct/TSP subject launches in the real Tern pane',
    await h.launch(subject, { ready: 'dsh-pi-tui' }))
  if (!await requiredWait(h, 'the official Direct fixture and the production renderer are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'history.bind'
      && entry.hasSource === true && entry.hasCwd === true && entry.hasCapture === true)
    && records(h).some(entry => entry.kind === 'renderer.bindInput')
    && h.classNodes(h.snapshot(), 'sf-region').length > 0, { limit: 240 })) {
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  const bind = records(h).find(entry => entry.kind === 'history.bind')
  h.measure('subject capabilities', JSON.stringify(subjectReady?.caps))
  h.check('the real client negotiated the exact kinds and features this card paints',
    ['col', 'row', 'text', 'input', 'el', 'scroll'].every(kind => subjectReady?.caps?.kinds?.includes(kind))
      && ['styles', 'scroll'].every(feature => subjectReady?.caps?.features?.includes(feature)),
    JSON.stringify({ kinds: subjectReady?.caps?.kinds, features: subjectReady?.caps?.features }))
  h.check('the ONE production History binding reached the production renderer mount',
    bind?.hasSource === true && bind?.hasCwd === true && bind?.hasCapture === true, JSON.stringify(bind))
  writeLedger(h, 'environment.json', {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    workRoot: subjectReady?.workRoot,
    clientCwd: subjectReady?.clientCwd,
    historyFiles: subjectReady?.historyFiles,
    seededRows: subjectReady?.seededRows,
    keySpellingFact: 'ctl key Control+r arrives as meta:true; ControlOrMeta+r arrives as ctrl:true (asserted from the SDK decoded Key below)',
  })

  // 1. The chord, proven by the SDK's OWN decoded Key.
  const keysBefore = sdkKeys(h).length
  const focusBefore = frameOps(h, 'focus').length
  h.check('the user pressed Ctrl+R exactly once in the real pane', await safeKey(h, 'ctrl+r key', CTRL_R, 450))
  const decoded = arrivedAs(h, keysBefore, 'r', 'ctrl')
  h.check('the real client decoded the injected chord as Ctrl+R (ctrl:true)',
    decoded !== undefined, JSON.stringify({ injected: CTRL_R, arrived: decoded ?? null, recent: sdkKeys(h).slice(-3) }))
  if (!await requiredWait(h, 'the real client painted the History card and focused its query', () =>
    cardOnScreen(h).live && cardOnScreen(h).painted
      && h.texts(h.snapshot()).some(text => /^Results · \d+ shown/u.test(text))
      && frameOps(h, 'focus').length > focusBefore
      && String(frameOps(h, 'focus').at(-1)?.[1] ?? '').endsWith('-query')
      && composerOf(h) !== undefined, { limit: 120 })) {
    h.capture('01-open-failed-1280x800', 'the real pane while the card did not open')
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  h.check('the ONE controlled composer stays the only editor on the frame',
    wireIds(h, /(^|\.)dock\.(quiet-composer\.)?composer$/).length === 1,
    JSON.stringify(wireIds(h, /composer$/)))
  h.check('the real JSONL store answered: the counter states the SHOWN first page',
    h.texts(h.snapshot()).some(text => /^Results · \d+ shown/u.test(text)),
    JSON.stringify(h.texts(h.snapshot()).slice(-24)))
  const openId = h.capture('02-open-1280x800-dark', 'Ctrl+R card with real query focus over the real JSONL rows')
  const openedSurfaces = wireRecords(h).filter(entry => entry.dir === 'out' && entry.verb === 'o')
  h.check('the card is one Dock surface, never a second SDK surface',
    openedSurfaces.length === 1, JSON.stringify({ openedSurfaces: openedSurfaces.length, layout: Object.keys(layoutOf(h, openId) ?? {}) }))

  // 2. Selection reveal first (the unfiltered page has several rows), then the
  //    query, the Scope cycle and the independent Preview scroll — each proven
  //    by the SDK wire, never by a ctl reply.
  const revealsAtOpen = frameOps(h, 'reveal').length
  await safeKey(h, 'Down selects the next real row', 'ArrowDown', 400)
  h.check('a real selection move issued a native reveal op on the wire',
    frameOps(h, 'reveal').length > revealsAtOpen,
    JSON.stringify({ before: revealsAtOpen, after: frameOps(h, 'reveal').length,
      last: frameOps(h, 'reveal').at(-1) }))
  for (const letter of 'tern') await safeKey(h, `type ${letter} into the real query`, letter, 160)
  await requiredWait(h, 'the real ui.input query carries the typed text and refiltered', () =>
    (queryField(h)?.text ?? '').includes('tern'), { limit: 90 })
  h.check('the query field is the official ui.input with the app-owned caret',
    (queryField(h)?.text ?? '') === 'tern' && queryField(h)?.cursor === 4, JSON.stringify(queryField(h)))
  await safeKey(h, 'Tab cycles the Scope', 'Tab', 400)
  await requiredWait(h, 'the Scope cycle re-read through the bound source', () =>
    h.texts(h.snapshot()).some(text => text === 'Scope: Directory ⌄'), { limit: 90 })
  const scrollsBefore = frameOps(h, 'scroll').length
  await safeKey(h, 'Alt+Down scrolls the real Preview container', 'Alt+ArrowDown', 400)
  h.check('the Preview container received a real native scroll op, not a list move',
    frameOps(h, 'scroll').length > scrollsBefore
      && String(frameOps(h, 'scroll').at(-1)?.[1] ?? '').endsWith('-preview-scroll')
      && String(frameOps(h, 'scroll').at(-1)?.[2] ?? '') === 'line-down',
    JSON.stringify(frameOps(h, 'scroll').slice(-3)))
  h.capture('03-query-scope-reveal-scroll', 'real query, Scope cycle, selection reveal and independent Preview scroll')

  // 3. Copy: the control-injected click is proven by the Client-local emission;
  //    the OS clipboard WRITE stays NOT_VERIFIED (no ACK exists).
  const copySnap = h.snapshot()
  const copyTarget = buttonLabeled(copySnap, h, 'Copy all')
  const copyPointVisible = copyTarget !== undefined && containedXY(copySnap.chains, copyTarget)
  const copyClicked = copyPointVisible ? await h.click(copySnap.chains, copyTarget) : false
  h.check('a control-injected click on the visible Copy all button reached the real handler',
    copyClicked === true, JSON.stringify({ copyPointVisible, rect: copyTarget === undefined ? null : rect(copyTarget) }))
  h.measure('OS clipboard write', 'NOT_VERIFIED: the control channel proves the click and the Client-local copy call, never a desktop clipboard write')

  // 4. Restore is the only draft write; the real Session writer is untouched.
  const promptsBefore = records(h).filter(entry => entry.kind === 'writer.prompt').length
  const restoreSnap = h.snapshot()
  const restoreTarget = buttonLabeled(restoreSnap, h, 'Restore to draft')
  const restorePointVisible = restoreTarget !== undefined && containedXY(restoreSnap.chains, restoreTarget)
  const restoreClicked = restorePointVisible ? await h.click(restoreSnap.chains, restoreTarget) : false
  h.check('a control-injected click on the visible Restore to draft button reached the real handler',
    restoreClicked === true, JSON.stringify({ restorePointVisible, rect: restoreTarget === undefined ? null : rect(restoreTarget) }))
  if (!await requiredWait(h, 'the ONE composer holds the restored stored text and the card is gone', () =>
    (composerOf(h)?.text ?? '') !== '' && !cardOnScreen(h).painted, { limit: 120 })) return finish(h, {})
  const restored = composerOf(h)
  h.check('the restored draft is a real stored row and reached no submission sink',
    SEED_ROWS.some(row => restored?.text === row)
      && records(h).filter(entry => entry.kind === 'writer.prompt').length === promptsBefore
      && records(h).filter(entry => entry.kind === 'handler.submit').length === 0,
    JSON.stringify({ restored, promptsBefore, writerPrompts: records(h).filter(entry => entry.kind === 'writer.prompt').length }))
  h.capture('04-restore-1280x800', 'the real ONE composer after a control-injected Restore, card closed')

  // 5. Esc is a seat cancel only: the draft and caret survive, Cancel is 0.
  await safeKey(h, 'Ctrl+R reopens one card', CTRL_R, 450)
  await requiredWait(h, 'the card reopened in the real pane', () => cardOnScreen(h).painted, { limit: 90 })
  const cancelsBefore = records(h).filter(entry => entry.kind === 'handler.cancel').length
  const draftBeforeCancel = composerOf(h)
  await safeKey(h, 'Esc cancels only the card', 'Escape', 400)
  await requiredWait(h, 'Esc closed the card in the real pane', () => !cardOnScreen(h).painted, { limit: 90 })
  h.check('the real Esc cancel left the draft byte-exact and never interrupted the Agent',
    composerOf(h)?.text === draftBeforeCancel?.text && composerOf(h)?.cursor === draftBeforeCancel?.cursor
      && records(h).filter(entry => entry.kind === 'handler.cancel').length === cancelsBefore,
    JSON.stringify({ before: draftBeforeCancel, after: composerOf(h),
      cancels: records(h).filter(entry => entry.kind === 'handler.cancel').length }))
  h.capture('05-cancel-1280x800', 'real Esc cancel: card gone, draft and caret intact')

  // 6. Eight real appearance/geometry cells.
  const cells = []
  for (const viewport of VIEWPORTS) {
    await h.resize(viewport.width, viewport.height)
    for (const appearance of APPEARANCES) {
      await h.send('appearance', appearance)
      await h.sleep(400)
      if (!cardOnScreen(h).painted) await safeKey(h, `open card ${viewport.name} ${appearance}`, CTRL_R, 450)
      if (!await requiredWait(h, `the card is visible at ${viewport.name} ${appearance}`,
        () => cardOnScreen(h).painted, { limit: 90 })) continue
      const id = h.capture(`cell-${viewport.name}-${appearance}`, `History search ${viewport.name} ${appearance}`)
      cells.push(geometryCell(h, appearance, viewport, id))
    }
  }
  await h.send('appearance', 'light')
  writeLedger(h, 'geometry-cells.json', cells)
  h.check('every produced cell resolved BOTH theme authorities for the appearance it names',
    cells.length > 0 && cells.every(cell => cell.layoutTheme === cell.appearance && cell.resolvedTheme === cell.appearance),
    JSON.stringify(cells.map(cell => ({ v: cell.viewport, a: cell.appearance, theme: cell.resolvedTheme, layout: cell.layoutTheme }))))

  // 7. The short/narrow bands the plan requires, asserted only where the client
  //    really reached the size; a clamp is a measurement, never a pass.
  const reached = cells.map(cell => ({ viewport: cell.viewport, requested: cell.requested, actual: cell.actualViewport }))
  writeLedger(h, 'viewport-reality.json', reached)
  const shortCells = cells.filter(cell => cell.viewport === '900x360')
  h.check('900x360 keeps query, Restore and the ONE composer visible in BOTH appearances',
    shortCells.length === 2 && shortCells.every(cell =>
      cell.title.containedXY && cell.restore.containedXY && cell.composer.containedXY),
    JSON.stringify(shortCells.map(cell => ({ a: cell.appearance, restore: cell.restore, composer: cell.composer }))))
  // The frozen short-pane rule is "at least ONE COMPLETE result row", which is a
  // pixel-height claim about a real row, not a node-existence claim.
  h.check('900x360 paints at least one COMPLETE result row (a full row box, not a clipped sliver)',
    shortCells.length === 2 && shortCells.every(cell => (cell.completeRows ?? 0) >= 1),
    JSON.stringify(shortCells.map(cell => ({ a: cell.appearance, completeRows: cell.completeRows,
      rowBoxes: cell.rowBoxes }))))
  const narrowCells = cells.filter(cell => cell.viewport === '400x600')
  if (narrowCells.length === 2) {
    h.check('400x600 keeps the secondary Copy all reachable in BOTH appearances',
      narrowCells.every(cell => cell.copy.containedXY),
      JSON.stringify(narrowCells.map(cell => ({ a: cell.appearance, copy: cell.copy }))))
  } else {
    h.measure('400x600 cells', 'NOT_REACHED by the client at this build; recorded as a measurement, never a pass')
  }

  // 8. The honest source→decision→sink ledger and the lane boundaries.
  writeLedger(h, 'source-decision-sink.json', {
    source: 'real $DSH_HOME/user-history v2 JSONL through the production FileHistorySearchSource',
    decision: 'the open-time captureHistoryScope pair + Scope ring + the settled first page + the selected row identity',
    sink: 'the ONE controlled composer (restore), the existing Client-local copy policy (copy), and NO Session writer prompt',
    bind,
    render: records(h).find(entry => entry.kind === 'renderer.observed'),
    writerPrompts: records(h).filter(entry => entry.kind === 'writer.prompt').length,
    submits: records(h).filter(entry => entry.kind === 'handler.submit').length,
    cancels: records(h).filter(entry => entry.kind === 'handler.cancel').length,
    decodedKeys: sdkKeys(h),
    restoredDraft: restored,
    focusOps: frameOps(h, 'focus').slice(-6),
    revealOps: frameOps(h, 'reveal').slice(-6),
    scrollOps: frameOps(h, 'scroll').slice(-6),
  })
  writeLedger(h, 'lane-ledger.json', {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    CLIENT_INTERACTIVE: 'HEADLESS real Tern pane, GUI_CONTROL lane; production Direct composition; tree/layout/PNG/wire/events read back',
    GUI_PHYSICAL_OS: 'NOT_VERIFIED (no GUI window or physical OS input run in this lane)',
    IME: 'NOT_VERIFIED',
    DESKTOP_FONTS: 'NOT_VERIFIED (headless software raster; the GUI lane owns the real window/font stack)',
    OS_CLIPBOARD_WRITE: 'NOT_VERIFIED (only the control click and the Client-local copy call are proven)',
    WHEEL_TRACKPAD: 'NOT_VERIFIED (the control channel provides no wheel; the keyboard Alt+arrow path proved the native Preview scroll)',
    OWNER_G8_VISUAL: 'NOT_SIGNED (PNG/layout evidence submitted for Owner visual acceptance)',
    inputMode: 'GUI_CONTROL (tern ctl key|type|click), each delivered exactly once and never retried',
    appearance: 'dark + light resolved through ctl appearance, proven by ctl state and the capture layout theme',
    keySpelling: 'ControlOrMeta+r → ctrl:true (measured); Control+r → meta:true',
  })
  h.measure('Owner G8 visual acceptance', 'NOT_SIGNED: PNG/layout evidence submitted, no subjective looks-good claim')
  finish(h, {
    tern: ternVersion,
    sdk: { pin: sdkPin, integrity },
    cells: cells.length,
    ownerG8: 'NOT_SIGNED',
  })
}
