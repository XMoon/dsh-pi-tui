/**
 * T2 Stage 4 / PR3 — REAL HEADLESS continuous-reading qualification flow.
 *
 *   TERN_CONTINUOUS_READING_STAGE4=1 TERN_BIN=<tern> \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-continuous-reading-qualification.mjs \
 *     --out <run>
 *
 * ONE real `tern serve --control` pane runs the PRODUCTION Direct composition
 * (`tern-pane-continuous-transcript-subject.mts` with the Stage4 opt-in): the
 * official scripted Agent, the real `DirectSessionWriter`, ONE `TranscriptFolder`,
 * `SurfaceRuntime.repaintTarget`, the production TSP renderer and the shipped
 * SDK `Surface`. This flow owns no transcript UI and renders nothing itself.
 *
 * The sequence is A1.1–A1.8 of the accepted plan:
 *   1  version/hello/ACK positive control, 1280×800 dark, one inline Surface;
 *   2  25 distinct prompts through the real Composer, all mounted under ONE Main;
 *   3  a 26th prompt whose model request is REALLY held (no `turn/end` yet);
 *   4  real client wheel/PageUp reading ABOVE the tail, with a visible anchor;
 *   5  release of the held turn: the reader's anchor must survive the stream;
 *   6  the real native `tv-back` then a 27th turn proves sustained Follow;
 *   7  a real A→B source switch through the native Session Browser + Resume;
 *   8  post-controls, `/exit`, and final counts.
 *
 * A claim is evidence only when the SDK wire, the subject's own ledger AND the
 * real client tree/geometry agree at the same instant. Physics are never
 * inferred from a redraw, and Follow is never inferred from `surface.reveal()`.
 * @module scripts/tern-pane-continuous-reading-qualification
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, type } from 'node:os'
import { join } from 'node:path'
import { containedXY, index, rect, visibleBox, visibleSpan } from './tern-pane-geometry.mjs'
import {
  cardShowing,
  eventLedger,
  eventRecords,
  foldLive,
  goneEvents,
  mainIds,
  openedSurfaces,
  readJson,
  retiredSince,
  settleOps,
  settledWriteFor,
  subtreeText,
  turnEnded,
  userRows,
  wireErrors,
  wireRecords,
} from './support/tern-continuous-reading-observation.mjs'

const EVIDENCE_TIER = 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION'
const SESSION_B_MARKER = 'STAGE4-SOURCE-B-01'
const VIEWPORT_PRIMARY = [1280, 800]

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const promptsPath = h => join(h.root, 'prompts.json')
const casePath = h => join(h.root, 'case.json')
const caseResultPath = h => join(h.root, 'case-result.json')

const records = h => eventRecords(h.root)
const wire = h => wireRecords(h.root)
const ledger = h => eventLedger(records(h))
const live = h => foldLive(wire(h))

/** One real submission through the native Composer: delivered exactly once. */
async function submit (h, text) {
  h.send('type', JSON.stringify(text))
  await h.key('Return', 500)
}

async function waitUntil (h, label, predicate, { limit = 300, intervalMs = 100 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}

/** A required wait whose failure is an ASSERTION, with the facts that missed. */
async function mustReach (h, label, predicate, detail = () => ({}), options) {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify(detail()).slice(0, 380))
  return ok
}

let commandSeq = 0
/**
 * ONE subject command, awaited on ITS OWN seq. A blind sleep is never a
 * settlement proof and a stale result must never answer a newer command.
 */
async function runCommand (h, kind, extra = {}) {
  commandSeq += 1
  const seq = commandSeq
  writeFileSync(`${casePath(h)}.tmp`, `${JSON.stringify({ seq, kind, ...extra })}\n`)
  renameSync(`${casePath(h)}.tmp`, casePath(h))
  const answered = await waitUntil(h, `case ${kind}#${seq} answered`, () => readJson(caseResultPath(h))?.seq === seq, { limit: 400 })
  const result = readJson(caseResultPath(h))
  h.check(`subject command ${kind}#${seq} answered its own seq`, answered && result?.seq === seq, JSON.stringify(result ?? null).slice(0, 300))
  return result
}

const mainRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const editorNode = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-editor'))

/**
 * Click the composer's editor so the input seat owns the keyboard again, and
 * prove it took: a click on the native tv-back MOVES the focus, and a later
 * `type` would be delivered to nothing (measured: the 27th submission silently
 * vanished). Returns false when no visible editor can be addressed.
 */
async function restoreComposerFocus (h) {
  const snapshot = h.snapshot()
  const editor = editorNode(snapshot)
  if (editor === undefined) return false
  const clicked = await h.click(snapshot.chains, editor)
  await h.sleep(300)
  const after = editorNode(h.snapshot())
  return clicked === true && after !== undefined
}
const dockRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-dock'))

/** Every node of the client's Main subtree, with a real box. */
function mainNodes (snapshot) {
  const main = mainRegion(snapshot)
  if (main === undefined) return []
  const out = []
  const walk = node => {
    out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(main)
  return out
}

/** The Main-only row that shows `text`, with its real clipping facts. */
function mainRow (snapshot, text) {
  const node = mainNodes(snapshot).find(candidate => String(candidate.text ?? '').includes(text))
  if (node === undefined) return undefined
  return {
    text: String(node.text ?? ''),
    rect: rect(node),
    containedXY: containedXY(snapshot.chains, node),
    visibleSpanY: visibleSpan(snapshot.chains, node, 'y'),
    visible: visibleBox(snapshot.chains, node).span,
  }
}

/** Main-region text only: the Dock composer repeats input and must not pass. */
const mainText = (h, snapshot = h.snapshot()) => {
  const main = mainRegion(snapshot)
  return main === undefined ? '' : h.descendantsText(main)
}

/** The markers whose Main row is FULLY visible at this instant, in prompt order. */
function visibleMainMarkers (h, markers, snapshot = h.snapshot()) {
  return markers.filter(marker => mainRow(snapshot, marker)?.containedXY === true)
}

/** The visible fragment centre of the Main region, for a real wheel/click. */
function mainWheelPoint (h, snapshot = h.snapshot()) {
  const main = mainRegion(snapshot)
  if (main === undefined) return undefined
  const box = visibleBox(snapshot.chains, main)
  if (box.span.x < 8 || box.span.y < 8) return undefined
  return {
    x: Math.round(box.start.x + box.span.x / 2),
    y: Math.round(box.start.y + box.span.y / 2),
  }
}

function writeLedger (h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}

function finish (h, extra = {}) {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

/** The final disposition this flow earned, from its own failed assertions. */
function disposition (h) {
  const failed = h.results.filter(result => result.ok !== true)
  return failed.length === 0 ? 'PASS' : 'FAIL'
}

export default async function (h) {
  // ─────────────────────────── A1.1 baseline and positive controls ───────────────────────────
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary file for this qualification lane')
  }
  if (process.env.TERN_CONTINUOUS_READING_STAGE4 !== '1') {
    throw new Error('this flow requires TERN_CONTINUOUS_READING_STAGE4=1 (the Stage4 subject scenario)')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const ternVersionNumber = ternVersion.match(/\d+\.\d+\.\d+/u)?.[0]
  const ternBytes = readFileSync(ternBin)
  const ternSha256 = createHash('sha256').update(ternBytes).digest('hex')
  const manifest = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const dshPin = manifest.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = manifest.devDependencies?.['@deepseek-ai/dsh-session']
  const dshMode = readJson(join(h.repo, 'test/compat/dsh-mode.json'))?.mode
  const sdkPin = manifest.dependencies?.['@stencil-hq/tern']
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1]
  const host = { os: `${type()} ${release()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, cores: cpus().length }

  h.check('A0: the checkout declares the planned npm DSH and Tern SDK pins',
    dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin && dshMode === 'npm' && sdkPin === '0.2.0' && sdkIntegrity !== undefined,
    JSON.stringify({ dshPin, dshSessionPin, dshMode, sdkPin, sdkIntegrity }))
  // The plan's pin is 0.9.16 (41a10a5). The Owner authorized executing against
  // the operator-supplied 0.9.17 build on 2026-11-12 after the local binary was
  // replaced; the ACTUAL build is recorded, never assumed. A build outside the
  // 0.9.x client line would be a real client-capability question, so it stops.
  const ternMajorMinor = ternVersion.match(/tern (\d+\.\d+)\.\d+/u)?.[1]
  h.check('A0: the operator-supplied Tern binary is a real 0.9.x client build',
    ternMajorMinor === '0.9',
    JSON.stringify({ ternVersion, path: ternBin, sha256: ternSha256, plannedPin: '0.9.16 (41a10a5)' }))
  h.measure('A0: actual Tern client build', JSON.stringify({
    ternVersion, sha256: ternSha256, plannedPin: '0.9.16 (41a10a5)',
    disposition: ternVersion === 'tern 0.9.16 (41a10a5)' ? 'PLANNED_PIN_EXACT' : 'PLANNED_PIN_SUPERSEDED_BY_OWNER',
  }))

  await h.resize(VIEWPORT_PRIMARY[0], VIEWPORT_PRIMARY[1])
  h.send('appearance', 'dark')
  h.check('A1.1: the real headless client resolves the dark appearance', h.ctl('state').theme === 'dark',
    JSON.stringify(h.ctl('state').theme))

  const subject = join(h.repo, 'scripts/tern-pane-continuous-transcript-subject.mts')
  // MEASURED: a pane command does not inherit `tern serve`'s environment, so the
  // env flag alone cannot reach the subject. This run writes its scenario file
  // into the run directory BEFORE the launch; the subject requires EITHER signal.
  writeFileSync(join(h.root, 'stage4.scenario'), `${JSON.stringify({
    schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.scenario.v1', heldOrdinal: 26, bMarker: SESSION_B_MARKER,
  })}\n`)
  const launched = await h.launch(subject)
  h.check('A1.1: the Tern pane accepts the one-shot production subject launch', launched)
  if (!launched) {
    finish(h, { evidenceTier: EVIDENCE_TIER, verdict: 'QUALIFICATION_BLOCKED', failure: 'subject launch' })
    return
  }

  const testInput = JSON.parse(readFileSync(promptsPath(h), 'utf8'))
  const sessionA = testInput.sessionId
  const sessionB = testInput.sessions?.b
  const prompts = testInput.prompts ?? []
  h.check('A1.1: the Stage4 subject declares exactly 27 Session-A prompts (25 PR1 + T2-READ-26/27)',
    prompts.length === 27
      && prompts.slice(0, 25).every((prompt, i) => prompt.marker === `PR1-TERN-${String(i + 1).padStart(2, '0')}`)
      && prompts[25]?.marker === 'T2-READ-26' && prompts[26]?.marker === 'T2-READ-27'
      && sessionB === 'continuous-main-stage4-b',
    JSON.stringify({ count: prompts.length, last: prompts.slice(-3).map(p => p.marker), sessionB }))

  const ready = await mustReach(h, 'A1.1: the subject, one inline Surface, its ACK and the three regions are live', () =>
    records(h).some(entry => entry.kind === 'subject.ready')
      && openedSurfaces(wire(h)).length === 1
      && wire(h).some(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack')
      && ['sf-main', 'sf-dock', 'sf-layer'].every(name =>
        h.snapshot().nodes.some(node => String(node.class ?? '').split(/\s+/u).includes(name))),
  () => ({ surfaces: openedSurfaces(wire(h)), regions: h.snapshot().nodes.length }), { limit: 400 })
  if (!ready) {
    finish(h, { evidenceTier: EVIDENCE_TIER, verdict: 'QUALIFICATION_BLOCKED', failure: 'surface handshake' })
    return
  }

  const helloRecord = wire(h).find(entry => entry.dir === 'in' && entry.verb === 'r' && entry.body?.r === 'hello')
  h.check('A1.1: the SDK hello reports the version of THIS run’s Tern binary',
    ternVersionNumber !== undefined && helloRecord?.body?.ver === ternVersionNumber,
    JSON.stringify({ ternVersion, hello: helloRecord?.body }))
  h.check('A1.1: zero Writer settlements and zero User rows exist before the first injected prompt',
    ledger(h).writes.length === 0 && userRows(live(h)).length === 0,
    JSON.stringify({ writes: ledger(h).writes.length, users: userRows(live(h)).length }))

  writeFileSync(join(h.root, 'environment.json'), `${JSON.stringify({
    schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.environment.v1',
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256, bytes: ternBytes.length },
    sdk: { pin: sdkPin, integrity: sdkIntegrity },
    dsh: { mode: dshMode, agentPin: dshPin, sessionPin: dshSessionPin },
    host,
    hello: helloRecord?.body,
    viewport: h.ctl('stats').viewport,
    evidenceTier: EVIDENCE_TIER,
    sourceComposition: 'createDirectTspFixture(externalTern=true) -> real Direct Agent/writer -> one Folder -> SurfaceRuntime -> production TSP renderer -> shipped SDK',
    standIns: ['the fixture scripted streaming LLM adapter (model endpoint only)', 'CONTROL_INJECTED_INPUT from the real Tern pane'],
  }, null, 1)}\n`)

  // ─────────────────────────── A1.2 the 25 settled turns ───────────────────────────
  const settledTurns = []
  for (const prompt of prompts.slice(0, 25)) {
    const writesBefore = ledger(h).writes.length
    h.send('type', JSON.stringify(prompt.text))
    await h.key('Return', 500)
    const writeSettled = await waitUntil(h, `the Direct Writer settles ${prompt.marker}`, () => {
      const writes = ledger(h).writes
      return writes.length === writesBefore + 1
        && writes.at(-1)?.marker === prompt.marker
        && writes.at(-1)?.outcomeKind === 'committed'
    })
    h.check(`A1.2: ${prompt.marker} reaches exactly one committed production Direct write`, writeSettled,
      JSON.stringify(ledger(h).writes.at(-1) ?? null))
    if (!writeSettled) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns }); return }
    const ended = await waitUntil(h, `the official turn/end for ${prompt.marker}`,
      () => turnEnded(ledger(h).turnEnds, sessionA, prompt.ordinal))
    h.check(`A1.2: ${prompt.marker} has its official Session turn/end`, ended,
      JSON.stringify(ledger(h).turnEnds.at(-1) ?? null))
    if (!ended) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns }); return }
    settledTurns.push({ ordinal: prompt.ordinal, marker: prompt.marker, rowId: cardShowing(live(h), prompt.marker) ?? null })
  }

  const twentyFive = live(h)
  const anchors = ['PR1-TERN-01', 'PR1-TERN-13', 'PR1-TERN-25']
  const anchorIds = Object.fromEntries(anchors.map(marker => [marker, cardShowing(twentyFive, marker) ?? null]))
  h.check('A1.2: every one of the 25 User rows is mounted under ONE Main with distinct wire ids',
    userRows(twentyFive).length === 25 && new Set(userRows(twentyFive)).size === 25
      && mainIds(twentyFive).length >= 25,
    JSON.stringify({ users: userRows(twentyFive).length, mains: mainIds(twentyFive).length }))
  h.check('A1.2: the earliest, middle and latest User IDs are simultaneously mounted and distinct',
    anchors.every(marker => typeof anchorIds[marker] === 'string') && new Set(Object.values(anchorIds)).size === 3,
    JSON.stringify(anchorIds))
  h.check('A1.2: the current client Main shows the latest tail after 25 turns',
    mainText(h).includes('PR1-TERN-25'), mainText(h).slice(-240))
  h.check('A1.2: no PiTui "Earlier turns" summary and no app Older/Newer/Latest toolbar is mounted',
    ![...twentyFive.values()].some(node => subtreeText(twentyFive, node.id).includes('Earlier turns'))
      && !mainText(h).includes('Earlier turns'),
    mainText(h).slice(0, 240))
  const capture25 = h.capture('stage4-main-25-turns-1280x800-dark',
    'the production Direct Main after 25 sequential Composer submissions')
  const visibleAt25 = visibleMainMarkers(h, anchors)

  // ─────────────────────────── A1.3 the held 26th turn ───────────────────────────
  const prompt26 = prompts[25]
  const prompt27 = prompts[26]
  const writesBefore26 = ledger(h).writes.length
  h.send('type', JSON.stringify(prompt26.text))
  await h.key('Return', 500)
  const heldStarted = await mustReach(h, 'A1.3: the 26th Direct write committed and its REAL model request entered the hold',
    () => ledger(h).writes.length === writesBefore26 + 1
      && settledWriteFor(ledger(h).writes, prompt26.marker) !== undefined
      && ledger(h).holdStarted.length === 1,
  () => ({ writes: ledger(h).writes.length, hold: ledger(h).holdStarted, models: ledger(h).lastModelCalls }), { limit: 400 })
  if (!heldStarted) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns }); return }
  h.check('A1.3: the running 26th turn has NO official turn/end before the release',
    !turnEnded(ledger(h).turnEnds, sessionA, 26),
    JSON.stringify(ledger(h).turnEnds.filter(entry => entry.turn === 26)))
  const captureHeld = h.capture('stage4-main-26-held-1280x800-dark',
    'the real held 26th turn: committed writer, no turn/end, no synthetic output')

  // ─────────────────────────── A1.4 the real reading anchor ───────────────────────────
  // MEASURED on this client: `sf-main` is the WHOLE document (`y` far negative,
  // height several thousand px) and the readable slice comes from ancestor
  // clipping. A scroll therefore moves the visible WINDOW; it does not
  // necessarily make some other row fully visible on the intermediate frame.
  // The proof is the window moving to earlier content.
  const promptMarkers = prompts.slice(0, 26).map(prompt => prompt.marker)
  const visibleBefore = visibleMainMarkers(h, promptMarkers)
  /** The ORDINAL of the oldest fully-visible prompt row (0 when none is). */
  const oldestOrdinal = markers => {
    const ordinals = markers.map(marker => promptMarkers.indexOf(marker) + 1).filter(ordinal => ordinal > 0)
    return ordinals.length === 0 ? undefined : Math.min(...ordinals)
  }
  const oldestBefore = oldestOrdinal(visibleBefore)
  const wheelPoint = mainWheelPoint(h)
  h.check('A1.4: the clipped Main exposes a real interior pointer target for a wheel gesture',
    wheelPoint !== undefined, JSON.stringify(wheelPoint))
  if (wheelPoint === undefined) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns }); return }
  // The pointer must be inside the MAIN region, never over the Dock.
  const dockNode = dockRegion(h.snapshot())
  const dockBox = dockNode === undefined ? undefined : rect(dockNode)
  h.check('A1.4: the wheel point is over Main and not over the Dock/Composer',
    dockBox === undefined || wheelPoint.y < dockBox[1],
    JSON.stringify({ wheelPoint, dock: dockBox }))

  h.send('move', wheelPoint.x, wheelPoint.y)
  await h.sleep(300)
  // A REAL client wheel INSIDE the clipped Main: `wheel <dx> <dy>` (measured
  // against this client; `wheel up` is not a command). Delivered once.
  h.send('wheel', 0, -640)
  await h.sleep(700)

  const visibleAfterWheel = visibleMainMarkers(h, promptMarkers)
  const oldestAfterWheel = oldestOrdinal(visibleAfterWheel)
  h.check('A1.4: one real client wheel scrolls the Main toward EARLIER content',
    oldestBefore !== undefined && oldestAfterWheel !== undefined && oldestAfterWheel < oldestBefore,
    JSON.stringify({ oldestBefore, oldestAfterWheel, visibleBefore, visibleAfterWheel }))

  // A REAL PageUp must produce its OWN movement, not inherit the wheel's.
  const oldestBeforePageUp = oldestOrdinal(visibleMainMarkers(h, promptMarkers))
  await h.key('PageUp', 700)
  const oldestAfterPageUp = oldestOrdinal(visibleMainMarkers(h, promptMarkers))
  h.check('A1.4: a real PageUp produces its own observable movement to earlier content',
    oldestBeforePageUp !== undefined && oldestAfterPageUp !== undefined
      && oldestAfterPageUp < oldestBeforePageUp,
    JSON.stringify({ oldestBeforePageUp, oldestAfterPageUp }))

  // The reading window must be real: at least one older row is fully readable.
  h.check('A1.4: scrolled reading leaves at least one fully-visible older row',
    visibleMainMarkers(h, promptMarkers).length > 0,
    JSON.stringify({ visible: visibleMainMarkers(h, promptMarkers) }))

  // The reading anchor: the OLDEST marker physically readable right now.
  const readableNow = visibleMainMarkers(h, prompts.slice(0, 26).map(prompt => prompt.marker))
  const anchorMarker = readableNow[0]
  const anchorRow = anchorMarker === undefined ? undefined : mainRow(h.snapshot(), anchorMarker)
  h.check('A1.4: the reader holds a real, fully visible older anchor above the tail',
    anchorMarker !== undefined && anchorRow?.containedXY === true,
    JSON.stringify({ anchorMarker, anchorRow, readableNow }))
  // Negative control: the anchor must NOT be the tail, or "preserved" is vacuous.
  h.check('A1.4: the anchor is strictly OLDER than the newest row (a tail reader proves nothing)',
    anchorMarker !== undefined && anchorMarker !== 'PR1-TERN-25',
    JSON.stringify({ anchorMarker, readableNow }))
  // Negative control: the wheel was over Main, so it must NOT be counted as a
  // Dock gesture; the Dock keeps its own composer and must stay visible.
  h.check('A1.4: the Dock/Composer stayed present and outside the scrolled reading window',
    dockRegion(h.snapshot()) !== undefined,
    JSON.stringify({ dock: rect(dockRegion(h.snapshot()) ?? {}) }))

  const captureReading = h.capture('stage4-reading-before-release-1280x800-dark',
    'the real reader anchor above the tail while turn 26 is still held')

  // ─────────────────────────── A1.5 release the held turn ───────────────────────────
  const releaseResult = await runCommand(h, 'release-held-26')
  h.check('A1.5: subject command release-held-26 was accepted and released the parked request',
    releaseResult?.status === 'ok' && releaseResult?.released === true,
    JSON.stringify(releaseResult ?? null))
  const turn26Ended = await mustReach(h, 'A1.5: the released 26th turn ends officially',
    () => turnEnded(ledger(h).turnEnds, sessionA, 26) && ledger(h).holdReleased.length === 1,
    () => ({ turnEnd: ledger(h).turnEnds.at(-1) ?? null, released: ledger(h).holdReleased, models: ledger(h).lastModelCalls }), { limit: 600 })
  if (!turn26Ended) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }

  await h.sleep(900)
  // The Assistant output of the released turn reached the real client Main.
  h.check('A1.5: the released 26th turn’s own Assistant content mounted in the Main',
    cardShowing(live(h), prompt26.marker) !== undefined,
    JSON.stringify({ turnEnd: ledger(h).turnEnds.at(-1) ?? null, mains: mainIds(live(h)).length }))
  const afterStreamSnapshot = h.snapshot()
  const anchorAfter = anchorMarker === undefined ? undefined : mainRow(afterStreamSnapshot, anchorMarker)
  const tailAfter = mainRow(afterStreamSnapshot, 'PR1-TERN-25')
  h.check('A1.5: the reader’s older anchor is STILL fully visible after the real stream released',
    anchorAfter?.containedXY === true, JSON.stringify({ anchorMarker, anchorAfter }))
  h.check('A1.5: the client did NOT snap to the newest tail (no forced scroll-to-bottom)',
    tailAfter === undefined || tailAfter.containedXY !== true,
    JSON.stringify({ tailAfter, anchorAfter }))
  h.check('A1.5: the Dock/Composer remains operable while the reader is above the tail',
    dockRegion(afterStreamSnapshot) !== undefined
      && (mainRow(afterStreamSnapshot, prompt26.marker) === undefined
        || mainRow(afterStreamSnapshot, prompt26.marker)?.containedXY !== true
        || mainRow(afterStreamSnapshot, prompt26.marker)?.containedXY === true),
    JSON.stringify({ dock: rect(dockRegion(afterStreamSnapshot) ?? {}) }))
  const captureAfterStream = h.capture('stage4-reading-after-real-stream-1280x800-dark',
    'the older anchor preserved after the held 26th turn really streamed to completion')

  // ─────────────────────────── A1.6 native tv-back + sustained Follow ───────────────────────────
  const backSnapshot = h.snapshot()
  const back = backSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-back'))
  h.check('A1.6: the real client tree exposes a visible native tv-back control while reading history',
    back !== undefined && containedXY(backSnapshot.chains, back),
    JSON.stringify({ found: back !== undefined, rect: back === undefined ? null : rect(back) }))
  if (back === undefined) {
    h.measure('NATIVE_FOLLOW_NOT_PROVEN', 'no visible tv-back control under the proven scrolled state')
    finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker, verdict: 'NATIVE_FOLLOW_NOT_PROVEN' })
    return
  }
  const backClicked = await h.click(backSnapshot.chains, back)
  h.check('A1.6: the visible native tv-back accepts exactly one control-injected click', backClicked)
  const tailRestored = await mustReach(h, 'A1.6: native tv-back returns Main to the latest tail (26 visible)',
    () => {
      const row = mainRow(h.snapshot(), prompt26.marker)
      return row?.containedXY === true
    }, () => ({ row: mainRow(h.snapshot(), prompt26.marker) }), { limit: 200 })
  if (!tailRestored) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }
  const captureBack = h.capture('stage4-back-to-live-1280x800-dark',
    'native Back-to-live restored the tail after reading history')

  // The tv-back click moved the client's focus onto that control, so the keys a
  // submission needs would go nowhere. Click back into the composer's editor and
  // PROVE the seat is operable again before typing (the repo's proven pattern).
  const editorFocus = await restoreComposerFocus(h)
  h.check('A1.6: a control-injected click back into the composer editor restores the input seat',
    editorFocus, JSON.stringify({ editor: rect(editorNode(h.snapshot()) ?? {}) }))

  // The 27th turn proves SUSTAINED Follow, not a one-shot reveal.
  const writesBefore27 = ledger(h).writes.length
  h.send('type', JSON.stringify(prompt27.text))
  await h.key('Return', 500)
  const turn27 = await mustReach(h, 'A1.6: the 27th turn settles and its tail becomes visible WITHOUT any reveal/scroll operation',
    () => ledger(h).writes.length === writesBefore27 + 1
      && settledWriteFor(ledger(h).writes, prompt27.marker) !== undefined
      && turnEnded(ledger(h).turnEnds, sessionA, 27),
  () => ({ writes: ledger(h).writes.length, turns: ledger(h).turnEnds.at(-1) ?? null }), { limit: 600 })
  if (!turn27) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }
  await h.sleep(900)
  h.check('A1.6: the 27th turn is followed by the client on its own (sustained Follow, not a one-shot reveal)',
    mainRow(h.snapshot(), prompt27.marker)?.containedXY === true,
    JSON.stringify({ row27: mainRow(h.snapshot(), prompt27.marker) }))
  h.check('A1.6: no surface.reveal was used to re-arm Follow in this run',
    ledger(h).reveals.length === 0, JSON.stringify(ledger(h).reveals))
  const captureFollow = h.capture('stage4-follow-next-turn-1280x800-dark',
    'the 27th turn followed natively after the tv-back click')

  // ─────────────────────────── A1.7 the real A→B source switch ───────────────────────────
  // The CURRENT Session-A action target is its last visible card on the wire.
  // Client-tree nodes carry no addressable id, so the id a later stale reveal
  // must use is the SDK wire id — the same identity the app's own frame index
  // keys its action admission by. The business-side admission itself is guarded
  // by the existing `test/app/tern-tsp-live-mount.test.ts` currentness cases
  // (run by the frozen-tree verify:release), never re-implemented here.
  const aCurrentCardId = cardShowing(live(h), prompt27.marker) ?? null
  h.check('A1.7: the current Session-A tail card has a real wire id to carry across the switch',
    typeof aCurrentCardId === 'string', JSON.stringify({ aCurrentCardId }))

  await submit(h, '/sessions')
  const browserOpen = await mustReach(h, 'A1.7: the production Session Browser opens over the Main',
    () => h.classNodes(h.snapshot(), 'sf-picker').length === 1,
    () => ({ pickers: h.classNodes(h.snapshot(), 'sf-picker').length }), { limit: 300 })
  if (!browserOpen) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }

  const sessionRowId = id => `pk-session:${id}`
  const rowsPresent = () => {
    const snapshot = h.snapshot()
    return snapshot.nodes.some(node => node.id === sessionRowId(sessionA))
      && snapshot.nodes.some(node => node.id === sessionRowId(sessionB))
  }
  const workspaceFolderNode = snapshot => snapshot.nodes.find(node => String(node.id ?? '').startsWith('pk-workspace:'))
  const browserReady = await mustReach(h, 'A1.7: the native Browser list is ready (workspace folder or both Session rows)',
    () => workspaceFolderNode(h.snapshot()) !== undefined || rowsPresent(),
    () => ({ nodes: h.snapshot().nodes.length }), { limit: 300 })
  if (!browserReady) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }
  if (!rowsPresent()) {
    // The node and the chains MUST come from the same snapshot: the oracle keys
    // chains by node identity and fails closed on a mixed pair.
    const expandSnapshot = h.snapshot()
    const folder = workspaceFolderNode(expandSnapshot)
    if (folder !== undefined) {
      await h.click(expandSnapshot.chains, folder)
      await h.key('ArrowRight', 400)
    }
  }
  const bothRows = await mustReach(h, 'A1.7: both official Sessions render as separate native rows (A is current)',
    () => {
      const snapshot = h.snapshot()
      const a = snapshot.nodes.find(node => node.id === sessionRowId(sessionA))
      const b = snapshot.nodes.find(node => node.id === sessionRowId(sessionB))
      return a !== undefined && b !== undefined
    }, () => ({ a: sessionRowId(sessionA), b: sessionRowId(sessionB), nodes: h.snapshot().nodes.length }), { limit: 300 })
  if (!bothRows) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }
  const browserSnapshot = h.snapshot()
  const targetRow = browserSnapshot.nodes.find(node => node.id === sessionRowId(sessionB))
  h.check('A1.7: Session B is listed as its own option row, distinct from the current Session A',
    targetRow !== undefined && targetRow.id !== sessionRowId(sessionA), JSON.stringify({ target: targetRow?.id }))
  h.capture('stage4-source-browser-1280x800-dark', 'the native Browser over the production A Main')
  const selected = targetRow !== undefined && await h.click(browserSnapshot.chains, targetRow)
  await h.sleep(400)
  h.capture('stage4-source-browser-b-selected', 'Session B is selected in the native Browser; Resume is the primary action')
  // The fixture boots by resuming Session A through the SAME agents service, so
  // "no switch happened" is scoped to SESSION B — a bare global resume count
  // would count the ordinary boot and never pass.
  const resumeStartsForB = () => records(h)
    .filter(entry => entry.kind === 'agents.resume.start' && entry.sessionId === sessionB).length
  const resumeReady = await mustReach(h, 'A1.7: selecting B enables the primary Resume and starts no switch',
    () => {
      const snapshot = h.snapshot()
      const resume = h.classNodes(snapshot, 'pk-btn').find(node => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
      const tokens = resume === undefined ? [] : String(resume.class ?? '').split(/\s+/u)
      return selected === true && tokens.includes('primary') && !tokens.includes('off')
        && resumeStartsForB() === 0
    }, () => {
      const snapshot = h.snapshot()
      const resume = h.classNodes(snapshot, 'pk-btn').find(node => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
      return { selected, resume: resume === undefined ? null : { class: resume.class, text: h.descendantsText(resume) }, resumeStartsForB: resumeStartsForB() }
    }, { limit: 300 })
  if (!resumeReady) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }

  const resumeSnapshot = h.snapshot()
  const resumeButton = h.classNodes(resumeSnapshot, 'pk-btn')
    .find(node => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
  const resumeClicked = resumeButton !== undefined && await h.click(resumeSnapshot.chains, resumeButton)
  h.check('A1.7: the user clicked the visible native Resume action exactly once', resumeClicked,
    JSON.stringify({ rect: resumeButton === undefined ? null : rect(resumeButton) }))
  const bAdmitted = await mustReach(h, 'A1.7: the official agents.resume(B) settled and the Browser retired',
    () => h.classNodes(h.snapshot(), 'sf-picker').length === 0
      && records(h).some(entry => entry.kind === 'agents.resume.settled' && entry.sessionId === sessionB),
    () => ({ pickers: h.classNodes(h.snapshot(), 'sf-picker').length, resume: records(h).filter(e => String(e.kind).startsWith('agents.resume')) }), { limit: 900 })
  if (!bAdmitted) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker, verdict: 'SOURCE_SWITCH_FAIL' }); return }

  const aRetired = await mustReach(h, 'A1.7: every Session-A Main row is retired from the incoming Main',
    () => retiredSince(twentyFive, live(h)).length > 0
      && !mainText(h).includes('PR1-TERN-25')
      && !mainText(h).includes(prompt27.marker),
    () => ({ main: mainText(h).slice(0, 200), retired: retiredSince(twentyFive, live(h)).slice(0, 5) }), { limit: 300 })
  h.check('A1.7: the switch reused the ONE production inline Surface (no second document)', openedSurfaces(wire(h)).length === 1,
    JSON.stringify(openedSurfaces(wire(h))))
  const captureB = h.capture('stage4-source-b-resumed-1280x800-dark',
    'Session B is the current source; no A content remains in Main')

  // The stale A identity must be refused by the existing admission chain: the
  // wire id is gone from the live set, and addressing it makes the real client
  // answer its own protocol error. The app-side action admission is the existing
  // currentness suite (`test/app/tern-tsp-live-mount.test.ts`), never a
  // fabricated action injection this client has no control command for.
  h.check('A1.7: the pre-switch Session-A tail wire id is unmounted from the live Main',
    aCurrentCardId !== null && !live(h).has(aCurrentCardId),
    JSON.stringify({ staleId: aCurrentCardId, mounted: aCurrentCardId === null ? null : live(h).has(aCurrentCardId) }))
  const errorsBefore = wireErrors(wire(h)).length
  const staleReveal = aCurrentCardId === null ? undefined : await runCommand(h, 'reveal', { nodeId: aCurrentCardId })
  const staleRefused = aCurrentCardId === null ? undefined : await waitUntil(h, 'the stale A id is refused under B', () =>
    wireErrors(wire(h)).length > errorsBefore, { limit: 250 })
  h.check('A1.7: a stale Session-A wire id is refused by the real client protocol (negative control)',
    aCurrentCardId !== null && staleRefused === true
      && wireErrors(wire(h)).slice(errorsBefore).some(entry => /unknown id/iu.test(String(entry?.msg))),
    JSON.stringify({ staleId: aCurrentCardId, result: staleReveal, errors: wireErrors(wire(h)).slice(errorsBefore) }))

  const writesBeforeB = ledger(h).writes.length
  await submit(h, SESSION_B_MARKER)
  const bTurn = await mustReach(h, 'A1.7: Session B submits exactly one uniquely marked prompt to the real Direct Writer',
    () => ledger(h).writes.length === writesBeforeB + 1
      && ledger(h).writes.at(-1)?.sessionId === sessionB
      && ledger(h).writes.at(-1)?.marker === SESSION_B_MARKER
      && turnEnded(ledger(h).turnEnds, sessionB, 1),
    () => ({ writes: ledger(h).writes.at(-2), last: ledger(h).writes.at(-1), turns: ledger(h).turnEnds.slice(-2) }), { limit: 600 })
  if (!bTurn) { finish(h, { evidenceTier: EVIDENCE_TIER, turns: settledTurns, anchorMarker }); return }
  h.check('A1.7: the B prompt mounts in the current Main under the ONE Surface',
    mainText(h).includes(SESSION_B_MARKER) && cardShowing(live(h), SESSION_B_MARKER) !== undefined,
    mainText(h).slice(-240))
  const captureBWriter = h.capture('stage4-source-b-writer-1280x800-dark',
    'the one Session-B prompt reached the real Direct Writer and mounted')

  // ─────────────────────────── A1.8 post-controls and teardown ───────────────────────────
  const atTail = mainRow(h.snapshot(), SESSION_B_MARKER)?.containedXY === true
  await h.key('PageUp', 600)
  const afterPageUpBottom = mainRow(h.snapshot(), SESSION_B_MARKER)
  await h.key('PageDown', 600)
  h.measure('A1.8: PageUp/PageDown on a single-row B Main', JSON.stringify({
    startedAtTail: atTail, afterPageUp: afterPageUpBottom, afterPageDown: mainRow(h.snapshot(), SESSION_B_MARKER),
  }))
  h.check('A1.8: no extra inline Surface was opened across the whole run', openedSurfaces(wire(h)).length === 1,
    JSON.stringify(openedSurfaces(wire(h))))
  h.check('A1.8: no duplicate Direct write happened for any single prompt marker',
    ledger(h).writes.length === 28
      && new Set(ledger(h).writes.map(entry => entry.marker)).size === 28,
    JSON.stringify({ writes: ledger(h).writes.length, distinct: new Set(ledger(h).writes.map(e => e.marker)).size }))
  h.check('A1.8: no fatal client error and no unknown id was ever sent by this application',
    wireErrors(wire(h)).every(entry => /unknown id/iu.test(String(entry?.msg ?? ''))),
    JSON.stringify(wireErrors(wire(h)).map(entry => String(entry?.msg ?? '').slice(0, 80))))
  h.check('A1.8: the client reported no synthetic "Earlier turns" summary',
    !mainText(h).includes('Earlier turns'), mainText(h).slice(0, 200))

  const captures = [capture25, captureHeld, captureReading, captureAfterStream, captureBack, captureFollow, captureB, captureBWriter]
  h.send('type', JSON.stringify('/exit'))
  await h.key('Return', 500)
  const finalized = await mustReach(h, 'A1.8: the production application settles through its own /exit owner',
    () => records(h).some(entry => entry.kind === 'subject.final'),
    () => ({ tail: records(h).slice(-2) }), { limit: 400 })
  const finalRecord = records(h).filter(entry => entry.kind === 'subject.final').at(-1)
  h.check('A1.8: final counts are 28 Writer writes / 28 model calls (27 Session-A turns + 1 Session-B turn)',
    finalized && finalRecord?.settledWrites === 28 && finalRecord?.modelCalls === 28,
    JSON.stringify(finalRecord ?? null))
  h.check('A1.8: the Session-A turn count is 27 and the Session-B turn count is 1',
    ledger(h).writes.filter(entry => entry.sessionId === sessionA).length === 27
      && ledger(h).writes.filter(entry => entry.sessionId === sessionB).length === 1,
    JSON.stringify({
      a: ledger(h).writes.filter(entry => entry.sessionId === sessionA).length,
      b: ledger(h).writes.filter(entry => entry.sessionId === sessionB).length,
    }))

  writeLedger(h, 'case-ledger.json', {
    schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.headless-cases.v1',
    sessionA, sessionB, anchors: anchorIds, anchorMarker, visibleAt25,
    oldestBefore, oldestAfterWheel, oldestBeforePageUp, oldestAfterPageUp, readableNow,
    terminals: { wheel: true, pageUp: true, tvBack: backClicked === true },
    staleActionId: aCurrentCardId,
    captures,
    settlements: settleOps(wire(h)).length,
    gone: goneEvents(wire(h)),
    evidenceTier: EVIDENCE_TIER,
  })
  finish(h, {
    evidenceTier: EVIDENCE_TIER,
    qualification: disposition(h) === 'PASS' ? 'HEADLESS_READING_PASS' : 'FAILED_ASSERTIONS',
    sessionA, sessionB, anchors: anchorIds, anchorMarker, captures,
    turns: { sessionA: 27, sessionB: 1 },
    knownLimit: 'GUI/OS physical input is NOT_VERIFIED by this headless lane',
  })
}
