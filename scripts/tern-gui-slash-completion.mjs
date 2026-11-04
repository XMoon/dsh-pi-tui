/**
 * TSP I-C §7.6 REAL GUI-WINDOW evidence lane: the first-line slash-command
 * completion popup on the PRODUCTION Direct/TSP composition.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-slash-completion.mjs \
 *     --out <fresh evidence directory>
 *
 * ONE production Direct composition runs inside a pane of a REAL Tern GUI
 * window on a real display: `createDirectTspFixture({externalTern:true})` boots
 * the shipped composition, so the mount, the stylesheet install, the mount
 * order, the display seam and the Quiet Composer path are the production ones,
 * and the candidate catalog arrives through the REAL command layer's single
 * commit point (the flow proves that from the recorded call sites instead of
 * assuming it). The subject's `events.jsonl` records the production facts (every
 * key the mount's own input loop pulled, every catalog commit, every composer
 * reducer call, the conditional completion write, every input handler call,
 * every settled Direct writer prompt); `sdk-wire.jsonl` carries the exact
 * `ui.editor` `text`/`cursor` props and the row `data-highlight`; the flow reads
 * the window's real node tree, layout and PNG for what the CLIENT paints. A
 * `ctl key` reply alone never proves a key arrived.
 *
 * EVIDENCE TIER (docs/guides/tern-gui-testing.md): `REAL_TERN_GUI` for the
 * window, its native chrome, its desktop font stack and its rendering, plus
 * `CONTROL_INJECTED_INPUT` for every key/click this flow sends. It is NOT
 * `OS_INPUT_VERIFIED`: `tern ctl key|commit|click` is the control channel, not
 * an OS input device, and no OS screen-reader bridge is consulted. Physical
 * keyboard, OS IME and an OS reader are NOT_VERIFIED (an operator-driven run
 * owns them).
 *
 * LANE HONESTY, applied literally:
 *  - the live-window appearance is a SAVED SETTING: `appearance dark` is a
 *    no-op here, so each dark cell sends `plugins run appearance:dark` ONCE
 *    through `send` (an action, never retried) and is proved with `state.theme`
 *    plus the capture's layout `theme`, never with the reply;
 *  - a REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow/short
 *    request. The clamp is REPORTED and asserted as reported; the popup facts
 *    are then measured against the size the window actually took, never
 *    against the size that was asked for;
 *  - VISIBILITY: the popup is an absolutely positioned child of the Composer
 *    shell that deliberately overflows the Dock region upward. The geometry
 *    oracle treats EVERY sized ancestor as a clip, so `containedXY`/`visibleSpan`
 *    against the full chain reports every row as clipped — that is the
 *    documented over-approximation, not the client's behaviour. The flow
 *    identifies the REAL clip chain (the popup's own scroller plus the
 *    ancestors that actually contain it) and asks `ctl pick` what the window
 *    really has at the row's centre; the PNG is the picture;
 *  - a path the client does not render is a `measure`, never a pass: the
 *    ≤3-plain-`ui.text` fallback (a pane without `el`+`styles`) is unreachable
 *    on this client (it negotiates both) and is reported NOT_VERIFIED;
 *  - soft-wrapped visual rows are NOT part of this milestone (the contract is
 *    hard-newline logical lines), so the long-candidate-line case records what
 *    the client really does with one long row instead of asserting parity;
 *  - if the window cannot keep the list visible or the caret operable at some
 *    size, that is a FAILED assertion in the ledger, not a reworded pass.
 * @module scripts/tern-gui-slash-completion
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect, visibleSpan, containedXY, visiblePoint } from './tern-pane-geometry.mjs'

const ROWS = ['oldest recall row', 'middle recall row', 'newest recall row']
const RECALL = [...ROWS].reverse()
const SESSION_A = 'session-slash-a'
const HINT = '↑↓ select · Tab/Enter complete · Esc close'
// The window clamps a size below its native minimum; those bands are reported
// as clamped and the popup is then judged at the size the window really took.
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '900x700', width: 900, height: 700 },
  { name: '400x600', width: 400, height: 600, optionalClamp: true },
  { name: '900x360', width: 900, height: 360, optionalClamp: true },
]
const APPEARANCES = ['light', 'dark']
/** The bounded window for this lane's ABSENCE claims (nothing to await). */
const ABSENCE_WINDOW_MS = 600

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const records = h => existsSync(eventPath(h))
  ? readFileSync(eventPath(h), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const wireRecords = h => existsSync(wirePath(h))
  ? readFileSync(wirePath(h), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const kindCount = (h, kind) => records(h).filter(entry => entry.kind === kind).length
const lastKind = (h, kind) => records(h).filter(entry => entry.kind === kind).at(-1)

/**
 * Fold the SDK's own wire recorder into the current node table. The client tree
 * carries no wire ids and no custom `data-role`, so this is the ONLY authority
 * for the exact `ui.editor` `text`/`cursor` props and for the row
 * `data-highlight` the presenter committed.
 */
const wireFold = h => {
  const nodes = new Map()
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object') return
    if (typeof node.id === 'string' && typeof node.k === 'string') nodes.set(node.id, { k: node.k, p: node.p ?? {} })
    for (const child of node.c ?? []) visit(child)
    for (const slot of ['head', 'end', 'foot']) {
      const value = node.p?.[slot]
      if (value && typeof value === 'object') visit(value)
    }
  }
  for (const line of wireRecords(h)) {
    if (line.dir !== 'out' || line.verb !== 'f') continue
    for (const op of line.body?.ops ?? []) {
      if (op[0] === 'add') visit(op[4])
      if (op[0] === 'del' && typeof op[1] === 'string') nodes.delete(op[1])
      // The pinned SDK `Op` shape is `['set', id, patch]`; a null patch value
      // removes the prop.
      if (op[0] === 'set' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: '', p: {} }
        const next = { ...previous.p }
        for (const [key, value] of Object.entries(op[2] ?? {})) {
          if (value === null) delete next[key]
          else next[key] = value
        }
        nodes.set(op[1], { k: previous.k, p: next })
      }
      if (op[0] === 'text' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: 'text', p: {} }
        const before = typeof previous.p.text === 'string' ? previous.p.text : ''
        nodes.set(op[1], {
          k: previous.k,
          p: { ...previous.p, text: op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '') },
        })
      }
    }
  }
  return nodes
}
const isComposerEditor = id => id === 'dock.quiet-composer.composer' || id === 'dock.composer'
/** A candidate ROW is the `el` button itself; its name/description are CHILD
 *  nodes addressed under it, so this filter never matches those. */
const isSlashRow = id => /\.slash-[^.]+$/u.test(id)
const wireEditor = h => {
  const entry = [...wireFold(h).entries()].filter(([id, node]) => node.k === 'editor' && isComposerEditor(id)).at(-1)
  const props = entry?.[1]?.p
  if (props === undefined || typeof props.text !== 'string') return undefined
  return { id: entry[0], text: props.text, cursor: typeof props.cursor === 'number' ? props.cursor : 0, attrs: props }
}
const wireSlashRows = h => [...wireFold(h).entries()]
  .filter(([id, node]) => node.k === 'el' && isSlashRow(id))
  .map(([id, node]) => ({
    id,
    highlighted: String(node.p?.attrs?.['data-highlight'] ?? '') === 'true',
    title: String(node.p?.title ?? ''),
  }))
const wireEditorCount = h => [...wireFold(h).entries()]
  .filter(([id, node]) => node.k === 'editor' && isComposerEditor(id)).length

const nodeClass = node => String(node?.class ?? '').split(/\s+/u).filter(Boolean)
const hasClass = (node, token) => nodeClass(node).includes(token)
const visibleNodes = snap => snap.nodes.filter(node => {
  const box = rect(node)
  return box[2] > 0 || box[3] > 0
})
const editorNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-editor'))
const editorTextNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-ed-text'))
const caretNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-caret'))
const dockNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-dock'))
const mainNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-main'))
const statusNodes = snap => visibleNodes(snap).filter(node => hasClass(node, 'sf-status'))
const sendNode = snap => visibleNodes(snap).find(node => node.tag === 'button'
  && ['↑', 'Send', 'Stop'].includes(String(node.text ?? '')))
const pickerNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-picker'))
const overlayNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-overlay'))
/** The client tree carries no wire ids and no custom `data-role`, so a
 *  candidate row is identified by the row's own `title`, which the presenter
 *  sets (`/name — description`) and the client echoes. */
const slashRows = snap => visibleNodes(snap).filter(node => node.tag === 'button'
  // The SDK paints a candidate row as an `sf-el` button. A GUI window's own tab
  // button can carry a "/abs/path  Ctrl+Shift+1" title: that is window chrome,
  // never a candidate row (measured in the GUI lane).
  && hasClass(node, 'sf-el') && String(node.title ?? '').startsWith('/'))
const slashHintNode = snap => visibleNodes(snap).find(node => String(node.text ?? '') === HINT)
const chainOf = (snap, node) => snap.chains.get(node) ?? []
const parentOf = (snap, node) => {
  const chain = chainOf(snap, node)
  return chain.length < 2 ? undefined : chain[chain.length - 2]
}
const menuNodeOf = (snap, rows) => rows.length === 0 ? undefined : parentOf(snap, rows[0])
const rowName = row => String(row.title ?? '').split(' — ')[0]
const rowPaint = (h, row) => String(h.descendantsText(row))

const containsBox = (outer, inner, slack = 0.5) => outer !== undefined && inner !== undefined
  && outer[2] > 0 && inner[2] > 0
  && inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack
  && inner[0] + inner[2] <= outer[0] + outer[2] + slack
  && inner[1] + inner[3] <= outer[1] + outer[3] + slack
const boxIntersects = (a, b) => a !== undefined && b !== undefined
  && a[2] > 0 && b[2] > 0
  && a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
  && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
const centreOf = box => ({ x: Math.round(box[0] + box[2] / 2), y: Math.round(box[1] + box[3] / 2) })

/** `ctl pick` — what the client REALLY has at a point. */
const pickAt = (h, point, label) => {
  try {
    const reply = h.ctl('pick', point.x, point.y)
    if (reply === undefined || reply.ok === false || typeof reply.path !== 'string') {
      h.measure(`pick ${label} NOT_VERIFIED`, JSON.stringify(reply))
      return undefined
    }
    return { ...reply, at: point, label }
  } catch (error) {
    h.measure(`pick ${label} NOT_VERIFIED`, `${String(error)} :: the control channel refused the read`)
    return undefined
  }
}

/** One candidate row's full dossier: the oracle numbers (kept, because the
 *  guide's rule is that they exist and are reported), the REAL clip chain, and
 *  the client's own hit test at the row centre.
 *
 *  A row counts as SHOWN when the part that must survive — the command NAME the
 *  user is about to accept — lies inside every real clip and the client's own
 *  hit test at the row centre returns the row's subtree. Whether the whole row
 *  box (its description included) fits inside the popup is reported separately
 *  as `boxOverflowsRealClips`, because that is exactly what the long-candidate
 *  line case has to record instead of asserting. */
const rowDossier = (h, snap, row, menuBox, pickIt) => {
  const box = rect(row)
  const chain = chainOf(snap, row).slice(0, -1)
  // The real clip chain: the popup's own scroller (the documented CSS clip) and
  // every ancestor that actually contains the popup. The ancestors that do NOT
  // contain it are the ones the popup intentionally overflows (the Composer
  // shell and the Dock region), and the oracle counts them — which is why
  // `oracleContainedXY` is false for every row while the PNG shows them painted.
  const realClips = chain.filter(node => menuBox === undefined || containsBox(rect(node), menuBox))
  const inside = target => realClips.every(node => containsBox(rect(node), target))
  const nameSpan = (row.children ?? []).find(node => /^\s*›?\/[^\s]/u.test(String(node.text ?? '')))
  const nameBox = nameSpan === undefined ? box : rect(nameSpan)
  // The SAME geometry oracle (`visibleSpan`/`containedXY` from
  // tern-pane-geometry.mjs), applied to the REAL clip chain instead of every
  // sized ancestor, reports how much of the leading command NAME survives. The
  // full-chain numbers are kept in `oracleSpanY`/`oracleContainedXY` above: the
  // guide's over-approximation is a fact, not something this lane hides.
  const nameNode = { rect: nameBox, children: [] }
  const realChains = new Map([[nameNode, [...realClips, nameNode]]])
  const nameVisibleSpanX = visibleSpan(realChains, nameNode, 'x')
  const nameVisibleSpanY = visibleSpan(realChains, nameNode, 'y')
  const nameContainedXY = containedXY(realChains, nameNode)
  const hit = pickIt === false || box[2] <= 0 || box[3] <= 0
    ? undefined
    : pickAt(h, centreOf(box), `row ${rowName(row)}`)
  const hitOwnSubtree = hit === undefined ? false : containsBox(box, hit.rect ?? [0, 0, 0, 0])
  // Does the row stay inside the popup's OWN frame? The production stylesheet
  // gives the menu `left:12/right:12` and the description `text-overflow:
  // ellipsis`, so a row whose box runs past the menu's right edge means the
  // client painted the text OUTSIDE its own popup frame. That is a claim, not a
  // footnote, so it is reported as its own field.
  const escapesMenuX = menuBox === undefined ? null
    : box[0] + box[2] > menuBox[0] + menuBox[2] + 0.5
  return {
    name: rowName(row),
    paint: rowPaint(h, row),
    highlighted: rowPaint(h, row).startsWith('›'),
    rect: box,
    nameRect: nameBox,
    oracleContainedXY: containedXY(snap.chains, row),
    oracleSpanY: visibleSpan(snap.chains, row, 'y'),
    realClipChain: realClips.map(node => `${node.tag}.${nodeClass(node)[0] ?? ''}`),
    nameVisibleSpanX,
    nameVisibleSpanY,
    nameContainedXY,
    boxInsideRealClips: inside(box),
    nameInsideRealClips: inside(nameBox),
    boxOverflowsRealClips: !inside(box),
    escapesMenuX,
    pickPath: hit?.path ?? null,
    pickRect: hit?.rect ?? null,
    hitOwnSubtree,
    shown: box[2] > 0 && box[3] > 0 && inside(nameBox) && nameContainedXY
      && nameVisibleSpanX > 4 && nameVisibleSpanY > 4 && hitOwnSubtree,
  }
}

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
  h.check(label, ok, ok ? '' : JSON.stringify({ events: records(h).slice(-8), texts: h.texts(h.snapshot()).slice(-20) }))
  return ok
}
const editorFacts = h => {
  const snap = h.snapshot()
  const editor = editorNode(snap)
  const caret = caretNode(snap)
  const wire = wireEditor(h)
  return {
    text: wire?.text ?? String(editorTextNode(snap)?.text ?? ''),
    cursor: wire?.cursor,
    wireId: wire?.id,
    wireAvailable: wire !== undefined,
    focused: editor !== undefined && hasClass(editor, 'focused'),
    editorRect: editor === undefined ? undefined : rect(editor),
    caretRect: caret === undefined ? undefined : rect(caret),
    caretX: caret === undefined ? undefined : rect(caret)[0],
    caretY: caret === undefined ? undefined : rect(caret)[1],
  }
}
const checkDraft = (h, label, expected) => {
  const actual = editorFacts(h)
  h.check(label, actual.text === expected, JSON.stringify({ expected, actual }))
  return actual
}
/** The real-key route first (closest to typing); the control `commit` text
 *  insert is the proven fallback, and which one delivered is a recorded fact. */
const inputChannel = { kind: 'UNSET' }
const typeText = async (h, text) => {
  const before = editorFacts(h)
  try {
    await h.key(text, 350)
    const after = editorFacts(h)
    if (after.text === before.text + text) {
      if (inputChannel.kind === 'UNSET') {
        inputChannel.kind = 'ctl key'
        h.measure('text input channel', `ctl key ${JSON.stringify(text)} inserted the text (GUI_CONTROL, control-injected)`)
      }
      return after
    }
  } catch (error) {
    h.measure(`ctl key ${JSON.stringify(text)} refused`, String(error))
  }
  h.send('commit', JSON.stringify(text))
  await h.sleep(400)
  const after = editorFacts(h)
  if (inputChannel.kind === 'UNSET') {
    inputChannel.kind = 'ctl commit'
    h.measure('text input channel', `ctl key ${JSON.stringify(text)} did NOT insert; the control \`commit\` path did (GUI_CONTROL, control-injected)`)
  }
  return after
}
const caseCount = h => records(h).filter(entry => entry.kind === 'case.received').length
const sendCase = async (h, command) => {
  const ordinal = caseCount(h)
  const full = `${command} ${ordinal}`
  writeFileSync(join(h.root, 'case'), `${full}\n`)
  const done = await requiredWait(h, `subject handled case ${command}`, () =>
    records(h).some(entry => (entry.kind === 'case.done' || entry.kind === 'case.failed') && entry.command === full),
    { limit: 120 })
  if (!done) return undefined
  const result = records(h).filter(entry => entry.kind === 'case.done' && entry.command === full).at(-1)
    ?? records(h).filter(entry => entry.kind === 'case.failed' && entry.command === full).at(-1)
  if (result?.error !== undefined) h.check(`case ${command} reported no error`, false, JSON.stringify(result))
  return result
}
/** Clear through the production composer port, then query `/` for real. */
const querySlash = async (h, label, { pick = true } = {}) => {
  await sendCase(h, 'clear')
  const typed = await typeText(h, '/')
  const painted = await waitUntil(h, `${label}: the candidate list painted`, () => slashRows(h.snapshot()).length > 0,
    { limit: 40, intervalMs: 150 })
  const snap = h.snapshot()
  const rows = slashRows(snap)
  return { typed, painted, snap, rows, menu: menuNodeOf(snap, rows) }
}
const writeLedger = (h, name, value) => {
  const path = join(h.root, name)
  writeFileSync(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
/** The GUI client writes its layout next to the PNG in THIS run's own
 *  `client-shots` directory; the driver copies only the PNG into `shots/`. */
const layoutOf = (h, captureId, out) => readJson(join(out, 'client-shots', 'live', `${captureId}.layout.json`))
const finish = (h, extra = {}) => {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  const out = h.root
  const subject = join(h.repo, 'scripts', 'tern-gui-slash-completion-subject.mts')
  const ternBin = process.env.TERN_BIN ?? 'tern'
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern':\s*\n\s*specifier: 0\.2\.0\s*\n\s*version: 0\.2\.0/u.test(lock)
    ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  h.measure('tern version', ternVersion)
  h.measure('SDK lock/integrity', JSON.stringify({ pin: sdkPin, integrity }))
  h.check('the pinned SDK is @stencil-hq/tern 0.2.0 with a lock integrity',
    sdkPin === '0.2.0' && integrity.startsWith('sha512-'), `pin=${sdkPin} integrity=${integrity}`)

  const system = h.ctl('system')
  h.check('the lane is running in a real native window on a real display',
    (system?.displays ?? []).length > 0 && typeof system?.title === 'string',
    JSON.stringify({ title: system?.title, displays: system?.displays }))

  const bootSize = await h.resize(1280, 800)
  h.measure('boot resize', JSON.stringify(bootSize))
  writeFileSync(join(out, 'case'), '')
  h.check('the production Direct/TSP subject launches in a pane of the real GUI window',
    await h.launch(subject, { ready: 'dsh-pi-tui' }))
  if (!await requiredWait(h, 'the official Direct fixture, the production renderer, the real catalog commit and the recall seed are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'renderer.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'catalog.install' && entry.count > 0)
    && records(h).some(entry => entry.kind === 'seam.resetInputHistory'
      && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
      && (entry.owner === SESSION_A || entry.owner === undefined))
    && h.classNodes(h.snapshot(), 'sf-region').length > 0,
    { limit: 240 })) {
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  const productionInstall = records(h).find(entry => entry.kind === 'catalog.install'
    && entry.count > 0 && entry.callSites.some(line => /src[/\\]commands\.(ts|mjs)/u.test(line)))
  const seamReset = records(h).find(entry => entry.kind === 'seam.resetInputHistory'
    && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
    && (entry.owner === SESSION_A || entry.owner === undefined))
  const catalog = productionInstall?.names ?? []
  h.measure('recall boot seed', JSON.stringify({
    owner: seamReset?.owner ?? null,
    policy: 'the subject seeds the production JSONL store; the flow accepts either the sessionless boot seed or the Session A hydration reseed, both through display.resetInputHistory',
  }))
  h.measure('subject capabilities', JSON.stringify(subjectReady?.caps))
  h.check('the shipped SDK capabilities cover the TSP editor, pickers, el and styles',
    ['editor', 'picker', 'overlay', 'input', 'el'].every(kind => subjectReady?.caps?.kinds?.includes(kind))
    && ['styles', 'flow', 'dock'].every(feature => subjectReady?.caps?.features?.includes(feature)),
    JSON.stringify(subjectReady?.caps))
  h.check('three newest-first history rows were committed through the production display seam',
    seamReset?.entries?.length === 3 && JSON.stringify(seamReset.entries) === JSON.stringify(RECALL)
    && seamReset?.newestFirst === true, JSON.stringify(seamReset))
  h.check('the slash catalog arrived through the mount install port from the real command layer',
    productionInstall !== undefined && catalog.length > 0, JSON.stringify(productionInstall))
  writeLedger(h, 'environment.json', {
    ternVersion, sdkPin, integrity, caps: subjectReady?.caps, seamReset, productionInstall,
    catalogCount: catalog.length, catalog,
  })
  h.capture('00-empty-composer-1280x800-light', 'the production Direct composer before any query')

  // ── 1. The natural `/` query paints the list and changes NOTHING else ─────
  const submitsAtStart = kindCount(h, 'handler.submit')
  const promptsAtStart = kindCount(h, 'writer.prompt')
  const writesAtStart = kindCount(h, 'composer.applyCompletionEdit')
  checkDraft(h, 'the composer starts empty', '')
  const natural = await querySlash(h, 'natural / query')
  h.check('the natural `/` query reached the composer as a real draft change',
    natural.typed.text === '/' && natural.typed.cursor === 1 && natural.painted,
    JSON.stringify({ typed: natural.typed, painted: natural.painted }))
  const naturalRows = slashRows(natural.snap)
  const naturalNames = naturalRows.map(row => rowName(row))
  const naturalWireRows = wireSlashRows(h)
  const highlightedNodes = naturalRows.filter(row => rowPaint(h, row).startsWith('›'))
  h.check('the popup paints at most six candidate rows plus one hint row',
    naturalRows.length > 0 && naturalRows.length <= 6 && slashHintNode(natural.snap) !== undefined,
    JSON.stringify({ rows: naturalRows.length, hint: slashHintNode(natural.snap) === undefined ? null : rect(slashHintNode(natural.snap)) }))
  h.check('the painted rows are the installed catalog, in provider order, with no second list',
    naturalNames.every(name => catalog.includes(name.slice(1))) && naturalNames.length === naturalWireRows.length,
    JSON.stringify({ painted: naturalNames, catalog: catalog.slice(0, 8), wireRows: naturalWireRows.length }))
  h.check('the default highlight is the FIRST row and exactly one row carries it',
    highlightedNodes.length === 1 && naturalWireRows.filter(row => row.highlighted).length === 1
    && rowPaint(h, highlightedNodes[0]) === rowPaint(h, naturalRows[0]),
    JSON.stringify({ painted: naturalRows.map(row => rowPaint(h, row)).map(text => text.slice(0, 24)), wireHighlight: naturalWireRows.filter(row => row.highlighted).length }))
  const afterPaint = editorFacts(h)
  h.check('painting the list leaves the editor `text`/`cursor` props exactly what the user typed',
    afterPaint.text === '/' && afterPaint.cursor === 1, JSON.stringify({ typed: natural.typed, afterPaint }))
  h.check('painting the list wrote nothing and submitted nothing',
    kindCount(h, 'composer.applyCompletionEdit') === writesAtStart
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ writes: kindCount(h, 'composer.applyCompletionEdit'), submits: kindCount(h, 'handler.submit') }))
  h.check('the popup never adds a second composer input',
    wireEditorCount(h) === 1, JSON.stringify({ editors: wireEditorCount(h) }))
  h.measure('the popup overflow vs the oracle', JSON.stringify({
    menuRect: natural.menu === undefined ? undefined : rect(natural.menu),
    dockRect: dockNode(natural.snap) === undefined ? undefined : rect(dockNode(natural.snap)),
    row0Oracle: { containedXY: containedXY(natural.snap.chains, naturalRows[0]), spanY: visibleSpan(natural.snap.chains, naturalRows[0], 'y') },
    note: 'the list is an absolutely positioned child of the Composer shell that overflows the Dock region upward by design; the oracle treats every sized ancestor as a clip, so these numbers are the documented over-approximation, and ctl pick + the PNG are the client authority',
  }))
  safeLayersMeasure(h)
  h.capture('01-slash-popup-1280x800-light', 'the natural `/` query, default highlight on the first row')
  writeLedger(h, 'natural-query.json', {
    catalogCount: catalog.length, painted: naturalNames,
    paint: naturalRows.map(row => rowPaint(h, row)), wireRows: naturalWireRows,
    hintRect: slashHintNode(natural.snap) === undefined ? undefined : rect(slashHintNode(natural.snap)),
    menuRect: natural.menu === undefined ? undefined : rect(natural.menu),
    before: natural.typed, afterPaint,
  })

  // ── 2. ↑/↓ and Tab/Shift+Tab walk the list; the draft never moves ─────────
  const walk = []
  for (const step of ['ArrowDown', 'ArrowUp', 'ArrowUp', 'Tab', 'Shift+Tab']) {
    const keysBefore = kindCount(h, 'composer.applyKey')
    const arrivalsBefore = kindCount(h, 'key.arrived')
    const draft = editorFacts(h)
    await h.key(step, 450)
    const after = editorFacts(h)
    const snap = h.snapshot()
    const rows = slashRows(snap)
    const lit = rows.filter(row => rowPaint(h, row).startsWith('›'))
    const index = lit.length === 0 ? -1 : rows.indexOf(lit[0])
    walk.push({ step, highlightIndex: index, painted: rows.length, totalCatalog: catalog.length })
    h.check(`${step} walks the open list, never edits the draft and never reaches the composer reducer`,
      lit.length === 1 && index >= 0 && rows.length === naturalRows.length
      && after.text === '/' && after.cursor === 1
      && kindCount(h, 'composer.applyKey') === keysBefore
      && kindCount(h, 'key.arrived') === arrivalsBefore + 1,
      JSON.stringify({ step, index, rows: rows.length, draft, after, applyKeys: kindCount(h, 'composer.applyKey') }))
  }
  h.check('walking wraps past the ends of the list (↑ from the first row reaches the last)',
    walk.some(entry => entry.highlightIndex === naturalRows.length - 1) && walk.some(entry => entry.highlightIndex === 0),
    JSON.stringify(walk))
  h.check('no walk gesture wrote the draft or submitted anything',
    kindCount(h, 'composer.applyCompletionEdit') === writesAtStart
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ writes: kindCount(h, 'composer.applyCompletionEdit'), submits: kindCount(h, 'handler.submit') }))
  h.capture('02-slash-walk-1280x800-light', 'the highlight walked by real ArrowDown/ArrowUp/Tab/Shift+Tab')
  writeLedger(h, 'arrow-walk.json', { painted: naturalNames, totalCatalog: catalog.length, walk })

  // ── 3. A plain Enter completes the name and is NOT a submission ───────────
  await querySlash(h, 'enter case reopen')
  const enterTarget = rowName(slashRows(h.snapshot())[0])
  const enterKeys = kindCount(h, 'composer.applyKey')
  await h.key('Enter', 600)
  const completed = editorFacts(h)
  const writeRecord = lastKind(h, 'composer.applyCompletionEdit')
  const afterEnterRows = slashRows(h.snapshot())
  h.check('a plain Enter writes ONLY the command name into the composer',
    completed.text === `${enterTarget} ` && completed.cursor === completed.text.length,
    JSON.stringify({ expected: `${enterTarget} `, completed }))
  h.check('the accept is the composer ONE conditional completion write, and it was accepted',
    writeRecord?.accepted === true && writeRecord?.next?.text === `${enterTarget} `
    && kindCount(h, 'composer.applyCompletionEdit') === writesAtStart + 1, JSON.stringify(writeRecord))
  h.check('the accepted frame carries no stale candidate list',
    afterEnterRows.length === 0, JSON.stringify({ rows: afterEnterRows.map(row => rowName(row)) }))
  h.check('a plain Enter on a highlighted candidate is never a submission',
    kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ submits: kindCount(h, 'handler.submit'), prompts: kindCount(h, 'writer.prompt'), writeRecord }))
  h.check('the Enter the list consumed never re-entered the composer reducer',
    kindCount(h, 'composer.applyKey') === enterKeys, JSON.stringify({ enterKeys, now: kindCount(h, 'composer.applyKey') }))
  h.capture('03-slash-enter-completed-1280x800-light', `the composer holds ${JSON.stringify(completed.text)} after the list-consuming Enter`)
  // ── 4. A control-injected click completes the row it names, once ─────────
  const clicked = await querySlash(h, 'click case')
  const clickTarget = clicked.rows[1] ?? clicked.rows[0]
  const clickKeys = kindCount(h, 'composer.applyKey')
  const writesBeforeClick = kindCount(h, 'composer.applyCompletionEdit')
  const eventsBefore = kindCount(h, 'client.event')
  const clickedName = rowName(clickTarget)
  const point = centreOf(rect(clickTarget))
  await h.clickAt(point.x, point.y, 900)
  const clickDraft = editorFacts(h)
  const clickWrite = lastKind(h, 'composer.applyCompletionEdit')
  const clientEvents = records(h).filter(entry => entry.kind === 'client.event')
  h.measure('the client events around a control-injected click', JSON.stringify({
    before: eventsBefore, after: kindCount(h, 'client.event'), events: clientEvents.slice(-4),
    note: 'MEASURED against the pinned SDK: Session dispatches a node\'s own handler inside the CLIENT (surface.dispatch -> onClick) and does NOT forward a handled action to the program input loop, so the click\'s positive control is the mount\'s ONE conditional completion write below, not an event the loop never sees',
  }))
  h.check('a control-injected click on a visible candidate row completes THAT row and submits nothing',
    clickDraft.text === `${clickedName} ` && clickDraft.cursor === clickDraft.text.length
    && clickWrite?.accepted === true && clickWrite?.next?.text === `${clickedName} `
    && kindCount(h, 'composer.applyCompletionEdit') === writesBeforeClick + 1
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart
    && kindCount(h, 'composer.applyKey') === clickKeys,
    JSON.stringify({ point, clickedName, clickDraft, clickWrite, submits: kindCount(h, 'handler.submit') }))
  h.capture('04-slash-row-click-1280x800-light', `the row at ${JSON.stringify(point)} completed by a control-injected click`)
  writeLedger(h, 'row-click.json', { point, clickedName, clickDraft, clickWrite })
  // The click moved the client's focus to the row's button; the lane continues
  // with keys, so the composer seat must be back in focus — proven, not assumed.
  const editorPoint = centreOf(rect(editorNode(h.snapshot())))
  await h.clickAt(editorPoint.x, editorPoint.y, 700)
  h.check('a control-injected click back into the editor restores the composer focus the keys need',
    editorFacts(h).focused, JSON.stringify({ editorPoint, after: editorFacts(h) }))

  // ── 5. Escape closes ONLY the list; the next Escape reaches cancel ───────
  const reopened = await querySlash(h, 'escape case')
  h.check('the list is open for the Escape case', reopened.rows.length > 0 && reopened.typed.text === '/',
    JSON.stringify({ typed: reopened.typed, rows: reopened.rows.length }))
  const cancelsBefore = kindCount(h, 'handler.cancel')
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  const escapedDraft = editorFacts(h)
  h.check('Escape with the list open closes the list and leaves the draft untouched',
    slashRows(h.snapshot()).length === 0 && escapedDraft.text === '/' && escapedDraft.cursor === 1,
    JSON.stringify({ escapedDraft }))
  h.check('Escape with the list open records NO cancel',
    kindCount(h, 'handler.cancel') === cancelsBefore,
    JSON.stringify({ before: cancelsBefore, after: kindCount(h, 'handler.cancel') }))
  await h.key('Escape', 500)
  await h.sleep(300)
  h.check('Escape with the list closed still reaches the existing cancel owner exactly once',
    kindCount(h, 'handler.cancel') === cancelsBefore + 1,
    JSON.stringify({ before: cancelsBefore, after: kindCount(h, 'handler.cancel') }))
  const afterCancels = editorFacts(h)
  h.check('the cancel-route Escape did not edit the draft', afterCancels.text === '/', JSON.stringify(afterCancels))
  h.capture('05-escape-closes-list-1280x800-light', 'the list closed by Escape, the draft untouched')
  writeLedger(h, 'escape-cancel.json', { cancelsBefore, cancelsAfter: kindCount(h, 'handler.cancel'), escapedDraft, afterCancels })

  // ── 6. With the list closed, ↑ is still the I-B history recall ───────────
  const seed = await sendCase(h, 'recall-seed')
  const seededReset = lastKind(h, 'seam.resetInputHistory')
  h.check('the recall rows were re-seeded through the production display seam',
    seed?.seeded === true && JSON.stringify(seededReset?.entries) === JSON.stringify(RECALL)
    && seededReset?.owner === SESSION_A, JSON.stringify({ seed, seededReset }))
  const recallQuery = await querySlash(h, 'recall case')
  h.check('the recall case starts with the list open', recallQuery.rows.length > 0, JSON.stringify(recallQuery.typed))
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  h.check('the recall case continues with the list CLOSED', slashRows(h.snapshot()).length === 0, '')
  await h.key('ArrowUp', 450)
  const lineHome = editorFacts(h)
  h.check('with the list closed the first ↑ is still the I-B line-home move, not a recall',
    lineHome.text === '/' && lineHome.cursor === 0 && slashRows(h.snapshot()).length === 0, JSON.stringify(lineHome))
  await h.key('ArrowUp', 450)
  const recalled = editorFacts(h)
  h.check('with the list closed the next ↑ performs the I-B history recall',
    recalled.text === RECALL[0] && slashRows(h.snapshot()).length === 0, JSON.stringify({ expected: RECALL[0], recalled }))
  await h.key('ArrowDown', 450)
  const restoredDraft = editorFacts(h)
  h.check('↓ leaving the recall restores the exact draft the browse replaced',
    restoredDraft.text === '/', JSON.stringify(restoredDraft))
  h.capture('06-slash-closed-arrow-recall-1280x800-light', 'the I-B recall still owns ↑ once the candidate list is closed')
  writeLedger(h, 'recall-after-close.json', { seed, seededReset, lineHome, recalled, restoredDraft })

  // ── 7. A catalog re-install withdraws a removed command ──────────────────
  const beforeWithdraw = await querySlash(h, 'withdraw case')
  const beforeNames = beforeWithdraw.rows.map(row => rowName(row))
  h.check('the withdrawal case starts from a multi-row real catalog', beforeNames.length >= 2, JSON.stringify(beforeNames))
  const reduce = await sendCase(h, 'catalog-reduce')
  const withdrawn = reduce?.withdrawn ?? ''
  await h.sleep(ABSENCE_WINDOW_MS)
  const withdrawnRows = slashRows(h.snapshot())
  h.check('a catalog re-commit withdraws the current list at once',
    reduce?.committed === true && withdrawnRows.length === 0, JSON.stringify({ reduce, rows: withdrawnRows.length }))
  h.check('the re-commit names the command it withdrew and that command was the row the popup showed',
    withdrawn !== '' && beforeNames[0] === `/${withdrawn}`, JSON.stringify({ reduce, beforeNames, withdrawn }))
  const afterWithdraw = await querySlash(h, 'withdraw case requery')
  const afterNames = afterWithdraw.rows.map(row => rowName(row))
  h.check('the next query shows only the new source: the withdrawn command is gone',
    withdrawn !== '' && afterNames.length > 0 && !afterNames.includes(`/${withdrawn}`) && afterNames[0] === beforeNames[1],
    JSON.stringify({ beforeNames, afterNames, withdrawn }))
  const withdrawalDraft = editorFacts(h)
  h.check('the withdrawal and the re-query never wrote the draft and never submitted',
    withdrawalDraft.text === '/' && kindCount(h, 'handler.submit') === submitsAtStart, JSON.stringify(withdrawalDraft))
  const restore = await sendCase(h, 'catalog-restore')
  await h.sleep(300)
  h.check('the production catalog is re-committed through the same mount port, byte-identical names',
    restore?.committed === true && JSON.stringify(restore.names) === JSON.stringify(catalog), JSON.stringify(restore))
  h.capture('07-catalog-withdrawal-1280x800-light', `after the re-commit that withdrew ${JSON.stringify(withdrawn)}`)
  writeLedger(h, 'catalog-withdrawal.json', { beforeNames, reduce, afterNames, restore })

  // ── 8. A higher composer control takes the keys; the list is gone ────────
  const opened = await querySlash(h, 'higher seat')
  // Captured AFTER the query: the `/` keystroke itself is one composer reducer
  // call, and the claim below is that the MENU'S keys add no further one.
  const seatBefore = editorFacts(h)
  const seatApplyKeys = kindCount(h, 'composer.applyKey')
  h.check('the slash list is open before the higher control takes the keys',
    opened.rows.length > 0, JSON.stringify(opened.typed))
  // The Permission trigger is measured first: an absent roster is a composition
  // fact, and this lane must not claim a control it cannot really open.
  const permissionTrigger = h.snapshot().nodes.find(node => node.tag === 'button'
    && String(node.title ?? '').startsWith('Permission'))
  h.measure('the Permission trigger in this composition', JSON.stringify({
    present: permissionTrigger !== undefined, title: permissionTrigger?.title ?? null,
    roster: records(h).filter(entry => entry.kind === 'handler.permissionOptions').at(-1)?.roster ?? 'handler absent',
    verdict: permissionTrigger !== undefined && !String(permissionTrigger.title ?? '').includes('not selectable')
      ? 'interactive' : 'NOT interactive in this composition: the higher control used below is the production Model/Effort quick menu',
  }))
  const seatOpen = await sendCase(h, 'seat-open')
  const menuOpened = await waitUntil(h, 'the production quick menu owns the keys', () => {
    const snap = h.snapshot()
    return pickerNode(snap) !== undefined || overlayNode(snap) !== undefined
      || h.texts(snap).some(text => String(text).includes('All models & details') || String(text).includes('Scripted Model'))
  }, { limit: 40, intervalMs: 150 })
  const menuSnap = h.snapshot()
  h.check('the production quick menu became visible and the slash list is gone',
    menuOpened && seatOpen?.opened === true && slashRows(menuSnap).length === 0 && slashHintNode(menuSnap) === undefined,
    JSON.stringify({ seatOpen, slashRows: slashRows(menuSnap).length, hint: slashHintNode(menuSnap) === undefined ? null : rect(slashHintNode(menuSnap)) }))
  for (const step of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter']) {
    await h.key(step, 450)
    const after = editorFacts(h)
    h.check(`${step} while the quick menu owns the keys reaches neither the composer nor a submit, and no list comes back`,
      after.text === seatBefore.text && after.cursor === seatBefore.cursor
      && kindCount(h, 'composer.applyKey') === seatApplyKeys
      && kindCount(h, 'handler.submit') === submitsAtStart && slashRows(h.snapshot()).length === 0,
      JSON.stringify({ step, seatBefore, after, applyKeys: kindCount(h, 'composer.applyKey') }))
  }
  h.capture('08-higher-seat-1280x800-light', 'the quick menu owns the keys; the slash list is gone')
  await h.key('Escape', 500)
  await sendCase(h, 'seat-close')
  const afterSeat = editorFacts(h)
  h.check('the composer draft and caret survive the higher control exactly',
    afterSeat.text === seatBefore.text && afterSeat.cursor === seatBefore.cursor, JSON.stringify({ seatBefore, afterSeat }))
  const reacquired = await querySlash(h, 'seat released requery')
  h.check('after the higher control closes, the slash seat is admitted again',
    reacquired.rows.length > 0, JSON.stringify({ rows: reacquired.rows.length }))
  writeLedger(h, 'higher-seat.json', { seatBefore, seatOpen, afterSeat, rowsAfterRelease: reacquired.rows.length })

  // ── 9. The exact product sequence on a SAFE scripted catalog ─────────────
  // A plain Enter on the highlighted candidate writes ONLY the command name;
  // the NEXT Enter is the real submit. Both are real control-injected keys; the
  // business submit count is read back from the subject's OWN events.jsonl.
  // The catalog is scripted to a command the Direct runner does not execute, so
  // the submit has no command side effect that could move the later cases.
  const single = await sendCase(h, 'catalog-single')
  h.check('the scripted single-command catalog committed through the mount install port',
    single?.committed === true && JSON.stringify(single.names) === JSON.stringify(['evidence-probe']), JSON.stringify(single))
  // The single-candidate Tab branch first: it also writes ONLY the name and
  // never submits. It is re-queried below for the exact plain-Enter sequence.
  const tabQuery = await querySlash(h, 'single candidate tab')
  h.check('the single-candidate Tab case starts from exactly one highlighted row',
    tabQuery.rows.length === 1 && rowPaint(h, tabQuery.rows[0]).startsWith('›'),
    JSON.stringify(tabQuery.rows.map(row => rowName(row))))
  const tabWrites = kindCount(h, 'composer.applyCompletionEdit')
  const tabSubmitAtStart = kindCount(h, 'handler.submit')
  await h.key('Tab', 600)
  const tabbed = editorFacts(h)
  h.check('with one candidate a Tab writes ONLY the command name and submits nothing',
    tabbed.text === '/evidence-probe ' && tabbed.cursor === tabbed.text.length
    && kindCount(h, 'composer.applyCompletionEdit') === tabWrites + 1
    && kindCount(h, 'handler.submit') === tabSubmitAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ tabbed, writes: kindCount(h, 'composer.applyCompletionEdit') }))
  writeLedger(h, 'single-candidate-tab.json', {
    tabbed, tabSubmitAtStart, submitsAfter: kindCount(h, 'handler.submit'),
  })
  const singleQuery = await querySlash(h, 'plain enter candidate')
  h.check('a single-candidate query paints exactly one row with the default highlight',
    singleQuery.rows.length === 1 && rowName(singleQuery.rows[0]) === '/evidence-probe'
    && rowPaint(h, singleQuery.rows[0]).startsWith('›'),
    JSON.stringify({ painted: singleQuery.rows.map(row => rowName(row)) }))
  const plainWrites = kindCount(h, 'composer.applyCompletionEdit')
  const plainSubmitAtStart = kindCount(h, 'handler.submit')
  const plainPromptsAtStart = kindCount(h, 'writer.prompt')
  await h.key('Enter', 600)
  const plainCompleted = editorFacts(h)
  const plainWrite = lastKind(h, 'composer.applyCompletionEdit')
  h.check('a plain Enter changes ONLY the composer text/caret (the completed name), and the recorded business submit count stays 0',
    plainCompleted.text === '/evidence-probe ' && plainCompleted.cursor === plainCompleted.text.length
    && plainWrite?.accepted === true && kindCount(h, 'composer.applyCompletionEdit') === plainWrites + 1
    && kindCount(h, 'handler.submit') === plainSubmitAtStart && kindCount(h, 'writer.prompt') === plainPromptsAtStart,
    JSON.stringify({ plainCompleted, plainWrite, submits: kindCount(h, 'handler.submit') }))
  await h.key('Enter', 1500)
  const handedOver = await requiredWait(h, 'the NEXT Enter hands the draft to the application submit owner exactly once', () =>
    kindCount(h, 'handler.submit') === plainSubmitAtStart + 1, { limit: 60 })
  const submitRecord = lastKind(h, 'handler.submit')
  h.check('the NEXT Enter submits exactly once',
    handedOver && submitRecord?.text === '/evidence-probe ' && String(submitRecord?.request) === 'enter'
    && kindCount(h, 'handler.submit') === plainSubmitAtStart + 1,
    JSON.stringify({ submitRecord, plainSubmitAtStart, submits: kindCount(h, 'handler.submit') }))
  h.measure('what the application did with the submitted line', JSON.stringify({
    writerPromptDelta: kindCount(h, 'writer.prompt') - plainPromptsAtStart,
    lastPrompt: records(h).filter(entry => entry.kind === 'writer.prompt').at(-1)?.message?.content ?? null,
  }))
  h.capture('09-next-enter-submits-1280x800-light', 'the real submit that follows the plain completing Enter')
  writeLedger(h, 'plain-enter-next-enter-submits.json', {
    single, plainCompleted, plainWrite, submitRecord,
    submitsBefore: plainSubmitAtStart, submitsAfter: kindCount(h, 'handler.submit'),
    promptsBefore: plainPromptsAtStart, promptsAfter: kindCount(h, 'writer.prompt'),
  })

  // ── 10. A long candidate line: what the client REALLY does (measure) ─────
  const restore1 = await sendCase(h, 'catalog-restore')
  h.check('the production catalog is restored before the long-line case',
    restore1?.committed === true, JSON.stringify(restore1))
  const longCase = await sendCase(h, 'catalog-long')
  const longQuery = await querySlash(h, 'long candidate')
  const longMenuBox = longQuery.menu === undefined ? undefined : rect(longQuery.menu)
  const longRows = longQuery.rows.map(row => rowDossier(h, longQuery.snap, row, longMenuBox, true))
  h.measure('long candidate line', JSON.stringify({
    names: longCase?.names ?? null, longName: longCase?.longName ?? null,
    menuRect: longMenuBox, editorRect: rect(editorNode(longQuery.snap)),
    rows: longRows.map(row => ({ name: row.name, rect: row.rect, paintLength: row.paint.length, shown: row.shown, pickPath: row.pickPath })),
    verdict: 'soft-wrapped visual rows are NOT implemented by this milestone (the contract is hard-newline logical lines); this records how the client painted one long row',
  }))
  h.capture('10-long-candidate-line-1280x800-light', 'one scripted very long candidate row')
  writeLedger(h, 'long-candidate-line.json', {
    longCase, menuRect: longMenuBox, rows: longRows,
    softWrap: 'NOT_IMPLEMENTED_THIS_MILESTONE: recorded, not asserted',
  })
  await sendCase(h, 'catalog-restore')
  h.measure('the bare (no el + no styles) ≤3 plain ui.text fallback',
    'NOT_VERIFIED: this client negotiates both `el` and `styles`, so the mount always takes the Quiet Composer branch and the fallback is unreachable on a real pane. The fallback is owned by test/tui/tern-tsp-slash-completion.test.ts (SDK mount).')

  // ── 11. Eight real appearance/geometry cells with the list OPEN ──────────
  const cells = []
  for (const viewport of VIEWPORTS) {
    const sized = await h.resize(viewport.width, viewport.height)
    h.measure(`${viewport.name}: the window took`, JSON.stringify(sized))
    for (const appearance of APPEARANCES) {
      // The live-window switch is the `appearance:dark|light` KEY ACTION, sent
      // ONCE with `send` (the harness `appearance` command is a no-op here).
      await h.send('plugins', 'run', `appearance:${appearance}`)
      await h.sleep(400)
      const queried = await querySlash(h, `cell ${viewport.name} ${appearance}`, { pick: false })
      const clip = clipReport(h)
      const id = h.capture(`cell-${viewport.name}-${appearance}`, `slash completion UX ${viewport.name} ${appearance}`)
      const snap = h.snapshot()
      const rows = slashRows(snap)
      const menu = menuNodeOf(snap, rows)
      const menuBox = menu === undefined ? undefined : rect(menu)
      const rowDossiers = rows.map(row => rowDossier(h, snap, row, menuBox, true))
      const shownRows = rowDossiers.filter(row => row.shown)
      const litIndex = rowDossiers.findIndex(row => row.highlighted)
      const editor = editorNode(snap)
      const caret = caretNode(snap)
      const send = sendNode(snap)
      const statuses = statusNodes(snap)
      const dock = dockNode(snap)
      const main = mainNode(snap)
      const state = h.ctl('state')
      const stats = h.ctl('stats')
      const layout = layoutOf(h, id, out)
      const editorHit = pickAt(h, centreOf(rect(editor)), `editor @${viewport.name}/${appearance}`)
      const sendHit = send === undefined ? undefined : pickAt(h, centreOf(rect(send)), `send @${viewport.name}/${appearance}`)
      const cell = {
        viewport: viewport.name,
        requested: [viewport.width, viewport.height],
        actualViewport: stats.viewport?.slice(0, 2),
        exactRequested: stats.viewport?.[0] === viewport.width && stats.viewport?.[1] === viewport.height,
        windowResizeReport: sized,
        appearance,
        resolvedTheme: state.theme,
        layoutTheme: layout?.theme,
        clip,
        main: { rect: main === undefined ? undefined : rect(main) },
        dock: { rect: dock === undefined ? undefined : rect(dock) },
        menu: { rect: menuBox, oracleSpanY: menu === undefined ? 0 : visibleSpan(snap.chains, menu, 'y') },
        rowsPainted: rows.length,
        rowsVisible: shownRows.length,
        rows: rowDossiers,
        highlightedIndex: litIndex,
        highlighted: rowDossiers[litIndex] ?? null,
        hint: slashHintNode(snap) === undefined ? null : {
          rect: rect(slashHintNode(snap)),
          insideMenu: containsBox(menuBox, rect(slashHintNode(snap))),
        },
        caret: {
          rect: caret === undefined ? undefined : rect(caret),
          insideEditor: caret === undefined || editor === undefined ? false : containsBox(rect(editor), rect(caret)),
          focused: editor !== undefined && hasClass(editor, 'focused'),
        },
        editor: {
          rect: rect(editor),
          focused: editor !== undefined && hasClass(editor, 'focused'),
          hitOwnSubtree: editorHit === undefined ? false : containsBox(rect(editor), editorHit.rect ?? [0, 0, 0, 0]),
          hitInMenu: editorHit === undefined ? false : containsBox(menuBox, editorHit.rect ?? [0, 0, 0, 0]),
        },
        send: {
          rect: send === undefined ? undefined : rect(send),
          hitOwnSubtree: sendHit === undefined ? false : containsBox(rect(send), sendHit.rect ?? [0, 0, 0, 0]),
          coveredByMenu: send === undefined ? null : boxIntersects(menuBox, rect(send)),
        },
        footer: {
          count: statuses.length,
          rects: statuses.map(node => rect(node)),
          coveredByMenu: statuses.map(node => boxIntersects(menuBox, rect(node))),
        },
        png: join(out, 'shots', `${id}.png`),
        nodeTree: join(out, `${id}.tree.json`),
        layout: join(out, 'client-shots', 'live', `${id}.layout.json`),
      }
      // The caret's OPERABILITY is proven by a real key at this size, after the
      // capture: the list retires, the composer reducer sees the key and the
      // UTF-16 caret moves to the line start.
      const keysBefore = kindCount(h, 'composer.applyKey')
      await h.key('ArrowLeft', 450)
      const moved = editorFacts(h)
      cell.caretOperable = moved.cursor === 0 && kindCount(h, 'composer.applyKey') === keysBefore + 1
      // A real window has a native minimum size. The clamp is asserted as
      // REPORTED (the driver's own result and the client's viewport agree); the
      // popup/operability claims then apply to the size the window really took.
      const sizeClaim = viewport.optionalClamp && !cell.exactRequested
        ? sized.clamped === true && JSON.stringify(sized.viewport?.slice(0, 2)) === JSON.stringify(cell.actualViewport)
        : cell.exactRequested
      h.check(`${viewport.name} ${appearance}: the window resolved ${appearance}, ${viewport.optionalClamp && !cell.exactRequested ? 'reported its minimum-size clamp honestly' : 'took the viewport'}, and keeps the list, the caret, the Composer, Send and the Footer visible, operable and uncovered`,
        cell.resolvedTheme === appearance && cell.layoutTheme === appearance
        && sizeClaim
        && queried.painted && rows.length > 0 && shownRows.length > 0
        && litIndex === 0 && rowDossiers[0]?.shown === true
        && cell.editor.focused && cell.editor.hitOwnSubtree && cell.editor.hitInMenu === false
        && cell.caret.rect !== undefined && cell.caret.insideEditor && cell.caretOperable
        && cell.send.rect !== undefined && cell.send.hitOwnSubtree && cell.send.coveredByMenu === false
        && cell.footer.count > 0 && cell.footer.coveredByMenu.every(covered => covered === false)
        && cell.dock.rect !== undefined && cell.main.rect !== undefined,
        JSON.stringify({
          theme: [cell.resolvedTheme, cell.layoutTheme], viewport: cell.actualViewport,
          rowsPainted: cell.rowsPainted, rowsVisible: cell.rowsVisible,
          highlighted: cell.highlighted, caret: cell.caret, caretOperable: cell.caretOperable,
          editor: cell.editor, send: cell.send, footer: cell.footer, menu: cell.menu,
        }))
      // Six rows is the Owner-ratified ceiling and the client reports no pane
      // height, so at the shortest matrix cell the popup box is shorter than its
      // own window and a painted row falls below it. The Owner accepted that
      // clipping; the testing guide forbids turning a path the client does not
      // render into a pass, so the clipped rows are recorded as a MEASUREMENT
      // below, while what must still be true stays a hard assertion: the row the
      // popup offers first — the one the user is about to accept — is visible.
      const clipped = rowDossiers.filter(row => row.shown !== true)
      h.check(`${viewport.name} ${appearance}: the candidate the popup offers first (the default highlight) is VISIBLE in the popup (geometry oracle: nameContainedXY + visibleSpan + ctl pick)`,
        rowDossiers.length > 0 && rowDossiers[0].shown === true,
        JSON.stringify({
          first: rowDossiers[0] && {
            name: rowDossiers[0].name, shown: rowDossiers[0].shown,
            nameContainedXY: rowDossiers[0].nameContainedXY,
            nameVisibleSpanY: rowDossiers[0].nameVisibleSpanY,
            oracleSpanY: rowDossiers[0].oracleSpanY, hitOwnSubtree: rowDossiers[0].hitOwnSubtree,
          },
          clipped: clipped.map(row => row.name),
        }))
      if (clipped.length > 0) {
        h.measure(`${viewport.name} ${appearance}: KNOWN LIMITATION the Owner accepted — ${clipped.length}/${rowDossiers.length} painted rows fall below the popup box (six-row ceiling, no pane-height capability)`,
          JSON.stringify({
            menuRect: cell.menu, rowsPainted: cell.rowsPainted, rowsVisible: cell.rowsVisible,
            clipped: clipped.map(row => ({ name: row.name, rect: row.rect, oracleSpanY: row.oracleSpanY })),
          }))
      }
      h.check(`${viewport.name} ${appearance}: the client keeps every candidate ROW inside the popup's own frame (no text painted outside the anchored list)`,
        rowDossiers.length > 0 && rowDossiers.every(row => row.escapesMenuX === false),
        JSON.stringify(rowDossiers.map(row => ({ name: row.name, rect: row.rect, escapesMenuX: row.escapesMenuX }))))
      h.measure(`${viewport.name} ${appearance}: MAIN/DOCK/menu sizes, visible rows ${cell.rowsVisible}/${cell.rowsPainted}`,
        JSON.stringify({ main: cell.main.rect, dock: cell.dock.rect, menu: cell.menu, rows: cell.rows.map(row => ({ name: row.name, rect: row.rect, shown: row.shown })) }))
      cells.push(cell)
    }
  }
  // Return to the light saved setting through the same live-window action.
  await h.send('plugins', 'run', 'appearance:light')
  await h.resize(1280, 800)
  writeLedger(h, 'geometry-cells.json', cells)

  // ── 12. Source→sink ledger and the honest lane boundaries ────────────────
  const keyCommands = readFileSync(join(out, 'run.log'), 'utf8').split('\n')
    .filter(line => line.startsWith('SEND ok ["key"') || line.startsWith('SEND ok ["commit"') || line.startsWith('SEND ok ["click"'))
  writeLedger(h, 'key-events.jsonl', keyCommands.join('\n'))
  const laneLedger = {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    catalog: { count: catalog.length, names: catalog, provenanceCallSites: productionInstall?.callSites ?? null },
    inputChannel: inputChannel.kind,
    CLIENT_INTERACTIVE: 'REAL_TERN_GUI window + CONTROL_INJECTED_INPUT; production Direct composition in a pane; native window, node tree/layout/PNG/wire/events read back',
    GUI_PHYSICAL_OS: 'REAL_TERN_GUI window rendering verified; OS physical keyboard / IME / OS screen-reader bridge NOT_VERIFIED',
    inputMode: 'CONTROL_INJECTED_INPUT (tern ctl key|commit|click|plugins run appearance:dark|light); never OS_INPUT_VERIFIED',
    appearanceSwitch: 'the live-window appearance is a SAVED SETTING: plugins run appearance:dark|light, sent ONCE with send; proved by state.theme + the capture layout theme, never by the reply',
    visibilityMethod: 'the popup intentionally overflows its Dock ancestor; the oracle numbers are reported, the REAL clip chain is the popup scroller plus the ancestors that contain it, and ctl pick + the PNG decide what the client shows; ctl layers is measured per cell',
    softWrap: 'KNOWN_DIFFERENCE: the contract is hard-newline logical lines; a long candidate line is RECORDED, not asserted',
    bareFallback: 'NOT_VERIFIED: this client negotiates el+styles, so the ≤3 plain ui.text branch is unreachable on a real pane',
    NOT_VERIFIED: [
      'OS physical keyboard / OS IME / OS screen-reader bridge',
      'a pane without el+styles (the ≤3 plain ui.text fallback)',
      'soft-wrapped visual rows',
      'the full Host /sessions Resume transition (the seat-priority case uses the production quick-menu port with a scripted roster)',
    ],
    counts: {
      keysArrived: kindCount(h, 'key.arrived'),
      composerApplyKey: kindCount(h, 'composer.applyKey'),
      completionWrites: kindCount(h, 'composer.applyCompletionEdit'),
      catalogCommits: kindCount(h, 'catalog.install'),
      handlerSubmit: kindCount(h, 'handler.submit'),
      handlerCancel: kindCount(h, 'handler.cancel'),
      writerPrompt: kindCount(h, 'writer.prompt'),
      controlInputs: keyCommands.length,
    },
    assertions: join(out, 'assertions.json'),
  }
  writeLedger(h, 'lane-ledger.json', laneLedger)
  h.measure('CONTROL_INJECTED_INPUT vs physical OS input', laneLedger.inputMode)
  h.measure('REAL_TERN_GUI verdict', laneLedger.CLIENT_INTERACTIVE)
  h.measure('live-window appearance switch', laneLedger.appearanceSwitch)
  h.measure('visibility method', laneLedger.visibilityMethod)
  h.measure('soft-wrap known difference', laneLedger.softWrap)
  await h.key('F10', 800)
  const shutDown = await waitUntil(h, 'the subject recorded its own F10 shutdown', () =>
    records(h).some(entry => entry.kind === 'fixture.settled' || entry.kind === 'process.exit'), { limit: 40, intervalMs: 250 })
  h.check('the subject shut itself down on F10 and recorded it', shutDown,
    JSON.stringify({ exit: records(h).filter(entry => entry.kind === 'process.exit' || entry.kind === 'fixture.settled').at(-1) }))
  finish(h, {
    tern: ternVersion,
    sdk: { pin: sdkPin, integrity, caps: subjectReady?.caps },
    catalog: { count: catalog.length, names: catalog },
    cells,
    inputChannel: laneLedger.inputChannel,
    CLIENT_INTERACTIVE: 'REAL_TERN_GUI_CONTROL',
    GUI_PHYSICAL_OS: 'REAL_WINDOW_VERIFIED_OS_INPUT_NOT_VERIFIED',
    evidenceTier: 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT, not OS_INPUT_VERIFIED',
    appearanceSwitch: laneLedger.appearanceSwitch,
    softWrap: 'KNOWN_DIFFERENCE_HARD_LOGICAL_LINES_ONLY',
    bareFallback: 'NOT_VERIFIED_EL_AND_STYLES_NEGOTIATED',
    visibilityMethod: laneLedger.visibilityMethod,
  })
}

/** `ctl layers` is the guide's authority for the real clip; record what this
 *  build actually reports instead of assuming it answers. */
function safeLayersMeasure (h) {
  try {
    const layers = h.ctl('layers')
    h.measure('ctl layers', JSON.stringify({ keys: Object.keys(layers), count: layers?.count, reported: (layers?.layers ?? []).length }).slice(0, 400))
  } catch (error) {
    h.measure('ctl layers NOT_VERIFIED', String(error))
  }
}
/** The per-cell clip report: the layers read plus the geometry-derived chain. */
function clipReport (h) {
  try {
    const layers = h.ctl('layers')
    return { layersAvailable: true, count: layers?.count ?? 0, reported: (layers?.layers ?? []).length }
  } catch (error) {
    return { layersAvailable: false, reason: String(error) }
  }
}
