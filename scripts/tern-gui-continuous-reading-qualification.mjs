/**
 * T2 Stage 4 / PR3 — REAL GUI continuous-reading qualification flow.
 *
 *   TERN_CONTINUOUS_READING_STAGE4=1 TERN_BIN=<tern> DISPLAY=:0 \
 *     node scripts/tern-gui-drive.mjs scripts/tern-gui-continuous-reading-qualification.mjs \
 *     --out <run>
 *
 * The SAME real Direct subject and the SAME 27 Session-A prompts / reading /
 * Follow sequence as the headless flow, but inside a REAL Tern GUI WINDOW. It
 * deliberately does NOT run the headless-only A→B source-switch subscene, so the
 * captured geometry is comparable across the fixed 4 × 2 matrix.
 *
 * What this lane adds over the headless one, and what it does not:
 *   - REAL WINDOW: the native window, the desktop font stack, the real client's
 *     rendering, and the client's own `a11y` tree;
 *   - the pointer/key events stay `CONTROL_INJECTED_INPUT` through `tern ctl`;
 *   - a client PNG is copied out of the client's own shot directory per capture;
 *   - OS physical input and an OS screen reader remain `NOT_VERIFIED`.
 *
 * The appearance switch is the LIVE one (`plugins run appearance:dark|light`, sent
 * once), never the headless `appearance` command, which is a no-op in a window.
 * @module scripts/tern-gui-continuous-reading-qualification
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect, visibleBox } from './tern-pane-geometry.mjs'
import {
  cardShowing,
  eventLedger,
  eventRecords,
  foldLive,
  openedSurfaces,
  readJson,
  settledWriteFor,
  turnEnded,
  wireRecords,
} from './support/tern-continuous-reading-observation.mjs'

const EVIDENCE_TIER = 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION'

/** The fixed matrix: 4 requested geometries × 2 appearances. */
const MATRIX = [
  { requested: [1280, 800], observation: 'Main + one Dock/Composer, readable User/Assistant, clear native tv-back at historic position' },
  { requested: [900, 700], observation: 'typical split-window hierarchy, overflow and low-contrast / CJK readability' },
  { requested: [400, 600], observation: 'actual width may clamp; record requested + actual, never call a clamped 400x600 a pass' },
  { requested: [900, 360], observation: 'known short-height clipping; record the exact Main/Dock overlap or absence' },
]
const APPEARANCES = ['light', 'dark']

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const promptsPath = h => join(h.root, 'prompts.json')

const records = h => eventRecords(h.root)
const wire = h => wireRecords(h.root)
const ledger = h => eventLedger(records(h))
const live = h => foldLive(wire(h))

async function submit (h, text) {
  h.send('type', JSON.stringify(text))
  await h.key('Return', 500)
}

async function waitUntil (h, label, predicate, { limit = 300, intervalMs = 150 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}

async function mustReach (h, label, predicate, detail = () => ({}), options) {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify(detail()).slice(0, 380))
  return ok
}

const regionNode = (snapshot, name) => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

/**
 * Click the composer's editor so the input seat owns the keyboard again, and
 * prove it took: a click on the native tv-back MOVES the focus, and the keys a
 * submission needs would otherwise be delivered to nothing (measured in both
 * lanes). One snapshot provides both the node and the chains.
 */
async function restoreComposerFocus (h) {
  const snapshot = h.snapshot()
  const editor = regionNode(snapshot, 'sf-editor')
  if (editor === undefined) return false
  const clicked = await h.click(snapshot.chains, editor)
  await h.sleep(300)
  return clicked === true && regionNode(h.snapshot(), 'sf-editor') !== undefined
}

function mainNodes (snapshot) {
  const main = regionNode(snapshot, 'sf-main')
  if (main === undefined) return []
  const out = []
  const walk = node => {
    out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(main)
  return out
}

function mainRow (snapshot, text) {
  const node = mainNodes(snapshot).find(candidate => String(candidate.text ?? '').includes(text))
  if (node === undefined) return undefined
  return { text: String(node.text ?? ''), rect: rect(node), containedXY: containedXY(snapshot.chains, node) }
}

/** Every readable text node inside one named region, with real boxes. */
function regionRows (snapshot, name) {
  const region = regionNode(snapshot, name)
  if (region === undefined) return []
  const out = []
  const walk = node => {
    const box = rect(node)
    const text = String(node.text ?? '')
    if (text !== '' && (box[2] > 0 || box[3] > 0)) out.push({ text, rect: box, containedXY: containedXY(snapshot.chains, node) })
    for (const child of node.children ?? []) walk(child)
  }
  walk(region)
  return out
}

function writeJson (h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  return path
}

export default async function (h) {
  // ─────────────────────────── the real window ───────────────────────────
  const system = h.ctl('system')
  h.check('A3: the run has a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))
  const a11y = h.ctl('a11y')
  h.check('A3: the client exposes its own accessibility tree (not an OS screen reader)',
    a11y !== undefined && a11y.ok !== false,
    JSON.stringify(a11y ?? null).slice(0, 240))
  h.measure('A3: OS screen-reader bridge', 'NOT_VERIFIED (client tree only)')
  h.measure('A3: OS physical input', 'NOT_VERIFIED (control-injected pointer/key only)')

  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary file for this GUI lane')
  }
  if (process.env.TERN_CONTINUOUS_READING_STAGE4 !== '1') {
    throw new Error('this flow requires TERN_CONTINUOUS_READING_STAGE4=1 (the Stage4 subject scenario)')
  }

  const first = await h.resize(1280, 800)
  h.check('A3: the real window took the 1280x800 content size', first.clamped === false,
    JSON.stringify(first))

  // MEASURED: a pane command does not inherit the window's environment, so the
  // env flag alone cannot reach the subject. The scenario file is written into
  // the run directory BEFORE launch; the subject requires EITHER signal.
  writeFileSync(join(h.root, 'stage4.scenario'), `${JSON.stringify({
    schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.scenario.v1', heldOrdinal: 26, mode: 'gui',
  })}\n`)
  const subject = join(h.repo, 'scripts/tern-pane-continuous-transcript-subject.mts')
  // No tree-text ready marker here: the subject's readiness is the fact it
  // records in its own ledger plus the one inline Surface (polled below). A
  // literal `ready` search would pass textually on unrelated chrome.
  const booted = await h.launch(subject)
  h.check('A3: the production subject boots inside a real Tern GUI pane', booted)
  if (!booted) {
    const stderr = join(h.root, 'subject.err')
    h.measure('A3: subject stderr', existsSync(stderr) ? readFileSync(stderr, 'utf8').slice(0, 600) : 'no stderr file')
    h.finish({ evidenceTier: EVIDENCE_TIER, verdict: 'REAL_GUI_ENV_BLOCKED' })
    return
  }

  const testInput = JSON.parse(readFileSync(promptsPath(h), 'utf8'))
  const sessionA = testInput.sessionId
  const prompts = testInput.prompts ?? []
  const ready = await mustReach(h, 'A3: the GUI pane mounted the one inline Surface with its three regions', () =>
    records(h).some(entry => entry.kind === 'subject.ready')
      && openedSurfaces(wire(h)).length === 1
      && ['sf-main', 'sf-dock', 'sf-layer'].every(name => regionNode(h.snapshot(), name) !== undefined),
  () => ({ surfaces: openedSurfaces(wire(h)), nodes: h.snapshot().nodes.length }), { limit: 400 })
  if (!ready) { h.finish({ evidenceTier: EVIDENCE_TIER, verdict: 'REAL_GUI_ENV_BLOCKED' }); return }

  // ─────────────────────────── the same 27-turn business flow ───────────────────────────
  for (const prompt of prompts.slice(0, 25)) {
    const writesBefore = ledger(h).writes.length
    await submit(h, prompt.text)
    const ok = await waitUntil(h, `the Direct Writer settles ${prompt.marker}`,
      () => ledger(h).writes.length === writesBefore + 1
        && ledger(h).writes.at(-1)?.marker === prompt.marker
        && turnEnded(ledger(h).turnEnds, sessionA, prompt.ordinal))
    h.check(`A3: ${prompt.marker} reaches one committed Direct write and its official turn/end`, ok,
      JSON.stringify(ledger(h).writes.at(-1) ?? null))
    if (!ok) { h.finish({ evidenceTier: EVIDENCE_TIER, turns: prompt.ordinal }); return }
  }
  h.check('A3: all 25 User rows are mounted in the one continuous Main',
    [...live(h).keys()].filter(id => id.startsWith('main.')).length >= 25,
    JSON.stringify({ mains: [...live(h).keys()].filter(id => id.startsWith('main.')).length }))
  const capture25 = h.capture('gui-25-turns-1280x800-initial',
    'the real GUI window after 25 sequential Composer submissions')

  // The 26th turn is REALLY held, exactly as in the headless lane.
  const prompt26 = prompts[25]
  const prompt27 = prompts[26]
  await submit(h, prompt26.text)
  const held = await mustReach(h, 'A3: the 26th Direct write committed and its real model request is parked',
    () => settledWriteFor(ledger(h).writes, prompt26.marker) !== undefined
      && ledger(h).holdStarted.length === 1
      && !turnEnded(ledger(h).turnEnds, sessionA, 26),
  () => ({ writes: ledger(h).writes.at(-1) ?? null, hold: ledger(h).holdStarted }), { limit: 500 })
  if (!held) { h.finish({ evidenceTier: EVIDENCE_TIER }); return }

  // Read above the tail with a real wheel at a point inside Main.
  // The node and the chains MUST come from one snapshot: the oracle keys chains
  // by node identity and fails closed on a mixed pair.
  const wheelSnapshot = h.snapshot()
  const main = regionNode(wheelSnapshot, 'sf-main')
  const mainBox = main === undefined ? undefined : visibleBox(wheelSnapshot.chains, main)
  const wheelPoint = mainBox === undefined || mainBox.span.x < 8 || mainBox.span.y < 8
    ? undefined
    : { x: Math.round(mainBox.start.x + mainBox.span.x / 2), y: Math.round(mainBox.start.y + mainBox.span.y / 2) }
  h.check('A3: the clipped Main exposes a real interior pointer target', wheelPoint !== undefined, JSON.stringify(wheelPoint))
  if (wheelPoint === undefined) { h.finish({ evidenceTier: EVIDENCE_TIER }); return }
  h.send('move', wheelPoint.x, wheelPoint.y)
  await h.sleep(400)
  const beforeWheel = ['PR1-TERN-01', 'PR1-TERN-05', 'PR1-TERN-13', 'PR1-TERN-25']
    .filter(marker => mainRow(h.snapshot(), marker)?.containedXY === true)
  h.send('wheel', 0, -640)
  await h.sleep(900)
  const afterWheel = ['PR1-TERN-01', 'PR1-TERN-05', 'PR1-TERN-13', 'PR1-TERN-25']
    .filter(marker => mainRow(h.snapshot(), marker)?.containedXY === true)
  h.check('A3: one real wheel over Main moves the visible older rows',
    afterWheel.join() !== beforeWheel.join() || afterWheel.some(marker => !beforeWheel.includes(marker)),
    JSON.stringify({ before: beforeWheel, after: afterWheel }))
  const captureReading = h.capture('gui-reading-held-26',
    'the reader above the tail while turn 26 is still held')

  // Release through the subject's command channel, then prove the anchor survived.
  const caseSeq = (readJson(join(h.root, 'case.json'))?.seq ?? 0) + 1
  writeFileSync(join(h.root, 'case.json'), `${JSON.stringify({ seq: caseSeq, kind: 'release-held-26' })}\n`)
  const released = await mustReach(h, 'A3: the held 26th turn released and ended officially',
    () => readJson(join(h.root, 'case-result.json'))?.seq === caseSeq
      && turnEnded(ledger(h).turnEnds, sessionA, 26),
    () => ({ result: readJson(join(h.root, 'case-result.json')), turns: ledger(h).turnEnds.slice(-2) }), { limit: 600 })
  if (!released) { h.finish({ evidenceTier: EVIDENCE_TIER }); return }
  await h.sleep(1200)
  const readableNow = prompts.slice(0, 26).map(prompt => prompt.marker)
    .filter(marker => mainRow(h.snapshot(), marker)?.containedXY === true)
  const anchorMarker = readableNow[0]
  h.check('A3: a real older anchor stayed visible after the stream released',
    anchorMarker !== undefined && anchorMarker !== 'PR1-TERN-25',
    JSON.stringify({ readableNow, anchorMarker }))
  const captureAfter = h.capture('gui-reading-after-stream', 'the anchor preserved after the held turn streamed')

  // Native tv-back, then the 27th turn for sustained Follow.
  const backSnapshot = h.snapshot()
  const back = backSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-back'))
  h.check('A3: a visible native tv-back control exists while reading history',
    back !== undefined && containedXY(backSnapshot.chains, back),
    JSON.stringify({ found: back !== undefined, rect: back === undefined ? null : rect(back) }))
  if (back === undefined) {
    h.measure('NATIVE_FOLLOW_NOT_PROVEN', 'no visible tv-back under the proven scrolled GUI state')
    h.finish({ evidenceTier: EVIDENCE_TIER, verdict: 'NATIVE_FOLLOW_NOT_PROVEN' })
    return
  }
  const clicked = await h.click(backSnapshot.chains, back)
  h.check('A3: the visible tv-back accepts one control-injected click', clicked)
  const tail = await mustReach(h, 'A3: tv-back returns the window to the latest tail',
    () => mainRow(h.snapshot(), prompt26.marker)?.containedXY === true,
    () => ({ row: mainRow(h.snapshot(), prompt26.marker) }), { limit: 250 })
  if (!tail) { h.finish({ evidenceTier: EVIDENCE_TIER }); return }
  h.check('A3: a control-injected click back into the composer editor restores the input seat',
    await restoreComposerFocus(h), JSON.stringify({ editor: regionNode(h.snapshot(), 'sf-editor') !== undefined }))
  await submit(h, prompt27.text)
  const followed = await mustReach(h, 'A3: the 27th turn is followed WITHOUT any reveal/scroll',
    () => turnEnded(ledger(h).turnEnds, sessionA, 27)
      && ledger(h).reveals.length === 0,
    () => ({ turns: ledger(h).turnEnds.slice(-2), reveals: ledger(h).reveals }), { limit: 600 })
  await h.sleep(1000)
  h.check('A3: the 27th turn is visible at the live tail (sustained Follow)',
    followed && mainRow(h.snapshot(), prompt27.marker)?.containedXY === true,
    JSON.stringify({ row27: mainRow(h.snapshot(), prompt27.marker) }))
  const captureFollow = h.capture('gui-follow-27', 'the 27th turn followed natively after tv-back')

  // ─────────────────────────── the fixed 4 × 2 GUI matrix ───────────────────────────
  const cells = []
  for (const cell of MATRIX) {
    for (const appearance of APPEARANCES) {
      const size = await h.resize(cell.requested[0], cell.requested[1])
      // The LIVE appearance switch. Sent once; `appearance dark` is a no-op here.
      h.send('plugins', 'run', `appearance:${appearance}`)
      await h.sleep(700)
      const state = h.ctl('state')
      h.check(`A3: ${cell.requested.join('x')} ${appearance} resolved the live appearance`,
        state.theme === appearance, JSON.stringify({ theme: state.theme, reply: 'state' }))
      const snapshot = h.snapshot()
      const mainRegionNode = regionNode(snapshot, 'sf-main')
      const dockRegionNode = regionNode(snapshot, 'sf-dock')
      const backNode = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-back'))
      const mainBoxNow = mainRegionNode === undefined ? undefined : visibleBox(snapshot.chains, mainRegionNode)
      const dockBox = dockRegionNode === undefined ? undefined : rect(dockRegionNode)
      const readable = regionRows(snapshot, 'sf-main')
        .filter(row => row.containedXY === true && row.text.trim() !== '')
        .slice(0, 6)
      // The input seat is the dock's editor node, not merely "some dock text":
      // a status row alone must not pass an editable-composer claim.
      const editor = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-editor'))
      const editorBox = editor === undefined ? undefined : rect(editor)
      const composerVisible = editor !== undefined && editorBox !== undefined
        && editorBox[2] > 0 && editorBox[3] > 0
        && containedXY(snapshot.chains, editor)
      const capture = h.capture(
        `gui-${cell.requested[0]}x${cell.requested[1]}-${appearance}`,
        `${cell.requested.join('x')} ${appearance}: ${cell.observation}`,
      )
      cells.push({
        requested: cell.requested,
        actual: size.viewport,
        clamped: size.clamped,
        appearance,
        resolvedTheme: state.theme,
        mainVisible: mainBoxNow === undefined ? null : { start: mainBoxNow.start, span: mainBoxNow.span },
        dock: dockBox ?? null,
        mainDockOverlap: mainBoxNow !== undefined && dockBox !== undefined
          ? Math.max(0, (mainBoxNow.start.y + mainBoxNow.span.y) - dockBox[1])
          : null,
        readableRows: readable.length,
        readableSample: readable.slice(0, 2).map(row => row.text.slice(0, 40)),
        composerVisible,
        editor: editorBox ?? null,
        tvBack: backNode === undefined
          ? 'ABSENT'
          : { visible: containedXY(snapshot.chains, backNode), rect: rect(backNode) },
        capture,
        a11yNodes: h.ctl('a11y')?.nodes?.length ?? null,
        observation: cell.observation,
      })
      h.check(`A3: ${cell.requested.join('x')} ${appearance} paints readable Main content`, readable.length > 0,
        JSON.stringify({ rows: readable.length, main: mainBoxNow?.span ?? null }))
      h.check(`A3: ${cell.requested.join('x')} ${appearance} keeps the Composer visible and editable`,
        composerVisible, JSON.stringify({ dock: dockBox ?? null }))
    }
  }

  // The requested-vs-actual clamp must be visible, never silently applied.
  const clamped = cells.filter(cell => cell.clamped)
  h.measure('A3: GUI size requests clamped by the real window',
    JSON.stringify(clamped.map(cell => ({ requested: cell.requested, actual: cell.actual }))))

  writeJson(h, 'gui-cells.json', { schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.gui-cells.v1', cells, evidenceTier: EVIDENCE_TIER })
  h.check('A3: the fixed matrix covered 4 geometries × 2 appearances',
    cells.length === 8 && new Set(cells.map(cell => `${cell.requested.join('x')}-${cell.appearance}`)).size === 8,
    JSON.stringify(cells.map(cell => `${cell.requested.join('x')}-${cell.appearance}`)))

  await h.key('F10', 500)
  h.finish({
    evidenceTier: EVIDENCE_TIER,
    qualification: h.results.every(result => result.ok === true) ? 'GUI_READING_PASS' : 'FAILED_ASSERTIONS',
    sessionA,
    captures: [capture25, captureReading, captureAfter, captureFollow, ...cells.map(cell => cell.capture)],
    cells: cells.length,
    knownLimits: [
      'OS physical input (mouse wheel / PageUp / IME) is NOT_VERIFIED: input is CONTROL_INJECTED through tern ctl',
      'the client a11y tree is not an OS screen-reader bridge',
      'the headless-only A→B source-switch subscene is deliberately not run here',
    ],
    physicalGui: 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT',
  })
}
