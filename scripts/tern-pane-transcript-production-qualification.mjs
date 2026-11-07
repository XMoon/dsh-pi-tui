/**
 * TSP production Transcript Presenter Qualification FLOW.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-production-qualification.mjs
 *
 * ONE real `tern serve --control` pane runs the PRODUCTION Direct application
 * (`scripts/tern-pane-transcript-production-qualification-subject.mts`): the
 * official scripted Agent, the real `DirectSessionWriter`, the ONE
 * `TranscriptFolder`/`TranscriptWindowController`, the 50 ms repaint,
 * `SurfaceRuntime.repaintTarget()`, the mounted `TspRenderer.display.setTranscript`
 * and the same SDK `Surface.render({main,dock,layer})`. This flow imports
 * neither `transcriptView()` nor `mountTspRenderer()` and renders nothing itself.
 *
 * Two evidence chains, deliberately kept apart:
 *  - A (`G-TRANSCRIPT-WRITER-TO-MAIN`, `G-TRANSCRIPT-NODE-IDENTITY`,
 *    `G-TRANSCRIPT-READING-ANCHOR`, `G-TRANSCRIPT-SOURCE-SWITCH`): real input
 *    through the SDK key path to a visible Main row, plus the native reading
 *    anchor held while an ALREADY RUNNING held turn releases.
 *  - B (`G-TRANSCRIPT-HISTORY-PREPEND`, part of `G-TRANSCRIPT-REVEAL`): a
 *    TEST-ONLY re-window/reveal probe against the same already-mounted
 *    Presenter. It is `TEST_ONLY_REWINDOW` only. The application has no TSP
 *    Older/Newer/Latest user entry, so nothing here may be reported as
 *    `PRODUCT_TRANSCRIPT_NAVIGATION_PASS`.
 *
 * Every positive claim needs BOTH authorities in the same run: the SDK wire
 * (`sdk-wire.jsonl`: the one `o`, the `f` frames, the `ack`s, the folded live
 * node set, the client `error` event) AND the real client tree/geometry/PNG.
 * A `setTranscript` recorder entry is never evidence that anything was painted.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, platform, cpus, release, type } from 'node:os'
import { join } from 'node:path'
import { rect, visibleSpan, visibleBox, containedXY, index } from './tern-pane-geometry.mjs'

const ANSWER_TEXT = 'TRANSCRIPT-DIRECT-ANSWER-SETTLED'
const VIEWPORTS = [[900, 700], [400, 600], [900, 360], [1280, 800]]
const TOLERANCE_PX = 1
/** One top-level transcript card on the wire: `<scopePrefix>msg-<n>` under `main`. */
const ROW_ID = /^main\.s\d+-msg-\d+$/u

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const jsonl = path => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  : []
const records = h => jsonl(eventPath(h))
const wireRecords = h => jsonl(wirePath(h))
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined

/** The inline Surfaces the run opened. More than one breaks the whole contract. */
const openedSurfaces = h => wireRecords(h)
  .filter(entry => entry.dir === 'out' && entry.verb === 'o')
  .map(entry => ({ id: entry.body?.id, mode: entry.body?.mode ?? 'inline' }))

/**
 * The live SDK node set folded from every `f` frame. A node a later frame
 * deleted is GONE from this map, so "unmounted" and "scrolled out of view"
 * are different facts here — the distinction the plan requires for the
 * unknown-id negative control.
 */
function foldLive (h) {
  const nodes = new Map()
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object' || typeof node.id !== 'string') return
    const entry = nodes.get(node.id) ?? { k: node.k, p: {}, childIds: [] }
    entry.k = node.k
    entry.p = { ...entry.p, ...(node.p ?? {}) }
    entry.childIds = (node.c ?? []).map(child => child.id)
    for (const slot of ['head', 'end', 'foot']) {
      const value = node.p?.[slot]
      if (typeof value === 'string') {
        if (!entry.childIds.includes(value)) entry.childIds.push(value)
      } else if (value !== null && typeof value === 'object') visit(value)
    }
    nodes.set(node.id, entry)
    for (const child of node.c ?? []) visit(child)
  }
  const dropSubtree = id => {
    const doomed = new Set()
    const collect = current => {
      if (doomed.has(current)) return
      doomed.add(current)
      for (const child of nodes.get(current)?.childIds ?? []) collect(child)
    }
    collect(id)
    for (const doomedId of doomed) nodes.delete(doomedId)
  }
  for (const entry of wireRecords(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') {
        // Re-adding an id replaces its subtree: the old children leave first.
        const children = (op[4]?.c ?? []).map(child => child.id)
        dropSubtree(op[1])
        visit(op[4])
        const parent = nodes.get(op[2])
        if (parent !== undefined) {
          for (const child of children) if (!parent.childIds.includes(child)) parent.childIds.push(child)
        }
      } else if (op[0] === 'del') dropSubtree(op[1])
      else if (op[0] === 'set') {
        const previous = nodes.get(op[1])
        if (previous !== undefined) {
          const next = { ...previous.p }
          for (const [key, value] of Object.entries(op[2] ?? {})) {
            if (value === null) delete next[key]
            else next[key] = value
          }
          previous.p = next
        }
      } else if (op[0] === 'text') {
        const previous = nodes.get(op[1])
        if (previous !== undefined) {
          const before = typeof previous.p.text === 'string' ? previous.p.text : ''
          previous.p = { ...previous.p, text: op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '') }
        }
      }
    }
  }
  return nodes
}

function subtreeText (live, id, seen = new Set()) {
  if (seen.has(id)) return ''
  seen.add(id)
  const node = live.get(id)
  if (node === undefined) return ''
  const own = typeof node.p.text === 'string' ? node.p.text
    : typeof node.p.head === 'string' ? node.p.head : ''
  return [own, ...node.childIds.map(child => subtreeText(live, child, seen))].filter(Boolean).join(' ')
}

/** The ONE top-level Main card mounting the row that shows `text` (wire fact). */
function rowIdFor (h, text, live = foldLive(h)) {
  return [...live.keys()].find(id => ROW_ID.test(id) && subtreeText(live, id).includes(text))
}
const mountedRowTexts = (h, texts, live = foldLive(h)) => texts.filter(text => rowIdFor(h, text, live) !== undefined)

const answerCardsLive = h => [...foldLive(h).entries()]
  .filter(([id, node]) => id.startsWith('main.') && node.k === 'md' && String(node.p.text ?? '') === ANSWER_TEXT).length

const regionNode = (snap, name) => snap.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

/**
 * The client's Main subtree only. The Dock's composer can briefly repeat the
 * same bytes, so every geometry claim is scoped to `sf-main` — the plan's rule
 * that a Main claim is never satisfied by Dock text.
 */
function mainNodes (snapshot) {
  const main = regionNode(snapshot, 'sf-main')
  if (main === undefined) return []
  const out = []
  const walk = node => {
    out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(main)
  return out.filter(node => rect(node)[2] > 0 || rect(node)[3] > 0)
}

/** The Main-region fragment that physically shows `text`, with its real box. */
function clientRow (snapshot, text) {
  const node = mainNodes(snapshot).find(candidate => String(candidate.text ?? '').includes(text))
  if (node === undefined) return undefined
  return {
    y: rect(node)[1],
    height: rect(node)[3],
    rect: rect(node),
    containedXY: containedXY(snapshot.chains, node),
    visibleSpanY: visibleSpan(snapshot.chains, node, 'y'),
  }
}

/** Main-region text only: the Dock composer repeats input and must not pass. */
function mainText (h, snapshot = h.snapshot()) {
  const main = regionNode(snapshot, 'sf-main')
  return main === undefined ? '' : h.descendantsText(main)
}
const mainShows = (h, text) => mainText(h).includes(text)

async function waitUntil (h, label, predicate, { limit = 200, intervalMs = 100 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
async function requiredWait (h, label, predicate, options) {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify({
    events: records(h).slice(-4),
    mainText: mainText(h).slice(0, 160),
    liveRowIds: [...foldLive(h).keys()].filter(id => ROW_ID.test(id)).slice(0, 8),
  }).slice(0, 380))
  return ok
}

/** The highest frame sequence the SDK has actually written at this instant. */
const latestFrameSeq = h => {
  const frames = wireRecords(h).filter(entry => entry.dir === 'out' && entry.verb === 'f')
  return frames.at(-1)?.body?.s ?? null
}

/** `marker + frame seq + capture id` recorded AT the capture instant: the
 *  Session switch legitimately retires source A's rows later, so a historical
 *  correlation must never be recomputed from the final live wire fold. */
function frameCorrelation (h, captureId, marker) {
  const live = foldLive(h)
  const rowIds = [...live.keys()].filter(id => ROW_ID.test(id) && subtreeText(live, id).includes(marker))
  return {
    capture: captureId, marker,
    frameSeq: latestFrameSeq(h),
    rowId: rowIds[0] ?? null,
    wire: wirePath(h),
    tree: join(h.root, `${captureId}.tree.json`),
    png: join(h.root, 'shots', 'serve', `${captureId}.png`),
    layout: join(h.root, 'shots', 'serve', `${captureId}.layout.json`),
  }
}

/** Every capture id this flow issues, so the evidence gate cannot check only
 *  the four viewport cells and pass with a missing/corrupt earlier artifact. */
function allCaptureIds (h) {
  const ids = []
  for (const line of readFileSync(join(h.root, 'run.log'), 'utf8').split('\n')) {
    const match = line.match(/^SHOT (\S+) ::/u)
    if (match !== null) ids.push(match[1])
  }
  return ids
}

const settledWrites = h => records(h).filter(entry => entry.kind === 'producer.writer.settled')
const modelCalls = h => records(h).filter(entry => entry.kind === 'producer.model.calls').at(-1)?.calls ?? 0
const commits = (h, origin) => records(h)
  .filter(entry => entry.kind === 'display.setTranscript' && (origin === undefined || entry.origin === origin))
const sdkErrors = h => records(h).filter(entry => entry.kind === 'sdk.error')

let caseSeq = 0
/**
 * ONE Subject command, awaited on ITS OWN seq. A blind sleep is never a
 * settlement proof, and a stale result must never answer a newer command.
 */
async function runCase (h, kind, extra = {}) {
  caseSeq += 1
  const seq = caseSeq
  const commandPath = join(h.root, 'case.json')
  const resultPath = join(h.root, 'case-result.json')
  writeFileSync(`${commandPath}.tmp`, `${JSON.stringify({ seq, kind, ...extra })}\n`)
  renameSync(`${commandPath}.tmp`, commandPath)
  if (!await waitUntil(h, `case ${kind}#${seq} answered`, () => readJson(resultPath)?.seq === seq, { limit: 400 })) {
    h.check(`subject command ${kind}#${seq} answered`, false, JSON.stringify(readJson(resultPath) ?? null))
    return undefined
  }
  const result = readJson(resultPath)
  h.check(`subject command ${kind}#${seq} completed`, result.status === 'ok', JSON.stringify(result).slice(0, 300))
  if (result.status !== 'ok') return result
  h.measure(`subject command ${kind}#${seq}`, JSON.stringify(result).slice(0, 300))
  return result
}

/** One real submission through the native Composer: injected exactly once. */
async function submit (h, text) {
  h.send('type', JSON.stringify(text))
  await h.key('Return', 500)
}

function finish (h, extra = {}) {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

function writeLedger (h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}

/** marker -> { mounted(wire id), client row } for the SAME instant's snapshot. */
function rowMap (h, texts, snapshot = h.snapshot()) {
  const live = foldLive(h)
  const out = {}
  for (const text of texts) out[text] = { id: rowIdFor(h, text, live), row: clientRow(snapshot, text) }
  return out
}

export default async function (h) {
  const ternBin = process.env.TERN_BIN ?? 'tern'
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern@0\.2\.0'/u.test(lock) ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  const manifest = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  // `mise.toml` derives the CLI pin from the Agent package's devDependency:
  // there is no `@deepseek-ai/dsh` package entry in this repository.
  const dshPin = manifest.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = manifest.devDependencies?.['@deepseek-ai/dsh-session']
  const dshMode = readJson(join(h.repo, 'test', 'compat', 'dsh-mode.json'))?.mode ?? 'UNVERIFIED'
  const ternBytes = readFileSync(ternBin)
  const ternSha256 = createHash('sha256').update(ternBytes).digest('hex')
  const host = {
    os: `${type()} ${release()}`, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model ?? 'UNVERIFIED', cores: cpus().length,
  }
  const extra = { tern: ternVersion, sdk: { pin: sdkPin, integrity }, dsh: { pin: dshPin, mode: dshMode } }
  h.check('G-TRANSCRIPT-EVIDENCE: the exact the agent harness npm baseline is resolved from this repository and matched by the Session package',
    dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin && dshMode === 'npm',
    JSON.stringify({ dshPin, dshSessionPin, dshMode }))

  // ─────────────────── group 1: baseline and bootstrap ───────────────────
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-transcript-production-qualification-subject.mts')
  h.check('the production Direct/TSP subject launches in the real Tern pane', await h.launch(subject))
  if (!await requiredWait(h, 'the official Direct fixture and the production renderer are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'surface.inline.opened')
    && h.classNodes(h.snapshot(), 'sf-region').length > 0, { limit: 300 })) {
    finish(h, extra)
    return
  }

  const hello = wireRecords(h).find(entry => entry.dir === 'in' && entry.verb === 'r' && entry.body?.r === 'hello')
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  writeLedger(h, 'environment.json', {
    tern: ternVersion,
    ternBinary: { path: ternBin, sha256: ternSha256, bytes: ternBytes.length },
    ternTopology: 'one headless tern serve --control pane, ONE inline TSP Surface, main/dock/layer regions',
    host,
    sdk: { pin: sdkPin, integrity },
    dsh: { mode: dshMode, cliPin: dshPin, agentPin: dshPin, sessionPin: dshSessionPin },
    hello: {
      ver: hello?.body?.ver, term: hello?.body?.term, kinds: hello?.body?.kinds,
      features: hello?.body?.features, credits: hello?.body?.credits, cell: hello?.body?.cell, dark: hello?.body?.dark,
    },
    workRoot: subjectReady?.workRoot,
    sessions: { a: subjectReady?.sessionA, b: subjectReady?.sessionB },
    viewport: h.ctl('stats').viewport,
    input: 'CONTROL_INJECTED (tern ctl type|key), each delivered exactly once and never retried',
    rendererOptIn: 'DSH_PI_TUI_RENDERER=tsp through the official Direct fixture (externalTern); PiTui stays the product default',
  })
  h.check('the real client reports its own handshake for THIS run (no copied investigation caps)',
    hello?.body?.ver === '0.9.12' && Array.isArray(hello?.body?.kinds) && hello.body.kinds.length > 0
      && typeof hello?.body?.credits === 'number',
    JSON.stringify({ ver: hello?.body?.ver, kinds: hello?.body?.kinds?.length, credits: hello?.body?.credits }))
  h.check('the pane negotiated the dock and styles capabilities this Presenter uses',
    ['dock', 'styles'].every(feature => (hello?.body?.features ?? []).includes(feature)),
    JSON.stringify(hello?.body?.features))
  h.check('the run opened exactly ONE production inline Surface',
    openedSurfaces(h).length === 1 && openedSurfaces(h)[0].mode === 'inline', JSON.stringify(openedSurfaces(h)))
  const ackEvents = h => wireRecords(h).filter(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack')
  h.check('G-TRANSCRIPT-EVIDENCE: the SDK wire has real client frame acknowledgements for the ONE production Surface',
    ackEvents(h).length > 0 && ackEvents(h).every(entry => entry.body?.sf === openedSurfaces(h)[0]?.id),
    JSON.stringify({ ackCount: ackEvents(h).length, surface: openedSurfaces(h)[0]?.id }))
  h.check('the client paints the three production regions',
    ['sf-main', 'sf-dock', 'sf-layer'].every(name => regionNode(h.snapshot(), name) !== undefined),
    JSON.stringify(['sf-main', 'sf-dock', 'sf-layer'].map(name => regionNode(h.snapshot(), name)?.rect)))

  // The prompts are read from the Subject's own controlled manifest: this flow
  // never keeps a second prompt definition.
  const testInput = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const aPrompts = testInput.prompts.filter(prompt => prompt.session === testInput.sessions.a)
  const bPrompt = testInput.prompts.find(prompt => prompt.session === testInput.sessions.b)
  const markers = aPrompts.map(prompt => prompt.marker)

  h.check('before the first submission the Writer settled nothing and no answer exists in Main',
    settledWrites(h).length === 0 && !mainShows(h, ANSWER_TEXT) && answerCardsLive(h) === 0,
    JSON.stringify({ settled: settledWrites(h).length, answerCardsLive: answerCardsLive(h), mainText: mainText(h).slice(0, 120) }))
  h.capture('transcript-empty-main-before-submit', 'the empty first screen: an empty Main is not a submission')

  // Eight real submissions. Each one must reach the Writer, issue a model
  // call and appear in Main (marker AND a NEW answer card) before the next is
  // allowed in, so the ordering of the chain is never assumed.
  const turns = []
  let tailAfterTurn7
  for (const prompt of aPrompts.slice(0, 8)) {
    const settledBefore = settledWrites(h).length
    const callsBefore = modelCalls(h)
    const answersBefore = answerCardsLive(h)
    if (prompt.ordinal === 8) {
      // Save the tail position AFTER turn 7 settled (the natural-follow pair
      // later compares turn 7 against turn 8; no ninth prompt is invented).
      const snapshot = h.snapshot()
      tailAfterTurn7 = { rows: rowMap(h, [markers[5], markers[6]], snapshot), main: rect(regionNode(snapshot, 'sf-main') ?? {}) }
      writeLedger(h, 'tail-after-turn-7.json', tailAfterTurn7)
    }
    await submit(h, prompt.text)
    const settledOk = await waitUntil(h, `writer settled #${prompt.ordinal}`, () =>
      settledWrites(h).length === settledBefore + 1 && settledWrites(h).at(-1)?.marker === prompt.marker
      && settledWrites(h).at(-1)?.outcomeKind === 'committed', { limit: 300 })
    h.check(`submission #${prompt.ordinal} reached exactly one committed Writer settlement`, settledOk,
      JSON.stringify({ before: settledBefore, after: settledWrites(h).length, last: settledWrites(h).at(-1) }))
    if (!settledOk) { finish(h, extra); return }
    const callOk = await waitUntil(h, `model call after #${prompt.ordinal}`, () => modelCalls(h) > callsBefore, { limit: 300 })
    h.check(`submission #${prompt.ordinal} issued a real scripted-Agent model call`, callOk,
      JSON.stringify({ callsBefore, calls: modelCalls(h) }))
    const mainOk = await waitUntil(h, `Main shows #${prompt.ordinal}`, () =>
      mainShows(h, prompt.marker) && answerCardsLive(h) === answersBefore + 1, { limit: 300 })
    h.check(`G-TRANSCRIPT-WRITER-TO-MAIN #${prompt.ordinal}: Main really shows the user row and the settled answer (Dock echo is never the witness)`,
      mainOk, JSON.stringify({ marker: prompt.marker, answerCardsLive: answerCardsLive(h), main: mainText(h).slice(-160) }))
    if (!mainOk) { finish(h, extra); return }
    turns.push({
      ordinal: prompt.ordinal, marker: prompt.marker,
      settled: settledWrites(h).at(-1), commit: commits(h, 'production').at(-1),
      answerCardsLive: answerCardsLive(h), rowId: rowIdFor(h, prompt.marker),
    })
  }
  const mainShot = h.capture('transcript-main-direct-1280x800-dark', 'eight real Direct turns in the production TSP Main')
  const frameCorrelations = [frameCorrelation(h, mainShot, markers[7])]
  writeLedger(h, 'source-decision-sink-production.json', {
    chain: 'CONTROL_INJECTED type+Return -> SDK key -> SubmissionController -> DirectSessionWriter -> SessionEvent + AssistantLiveInput -> one Folder + 50ms repaint -> repaintTarget -> display.setTranscript(origin=production) -> SDK f frame -> Tern client Main',
    turns,
    frames: wireRecords(h).filter(entry => entry.dir === 'out' && entry.verb === 'f').length,
    acks: wireRecords(h).filter(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack').length,
    capture: mainShot,
  })
  h.check('G-TRANSCRIPT-WRITER-TO-MAIN: all eight submissions produced a production commit, a distinct answer card and a distinct wire row id',
    turns.length === 8 && turns.every(turn => turn.commit?.origin === 'production'
      && turn.commit.sourceSeq === turns[0].commit.sourceSeq && typeof turn.rowId === 'string')
      && new Set(turns.map(turn => turn.rowId)).size === 8
      && turns.at(-1).answerCardsLive === 8,
    JSON.stringify(turns.map(turn => ({ ordinal: turn.ordinal, rowId: turn.rowId, messageCount: turn.commit?.messageCount, lastTurn: turn.commit?.lastTurn }))))

  // ─────────── group 2: native tail follow, then reading while streaming ───────────
  const snapshot8 = h.snapshot()
  const after8 = rowMap(h, [markers[6], markers[7]], snapshot8)
  const newestVisible = after8[markers[7]]?.row?.containedXY === true
  const olderMovedUp = (tailAfterTurn7?.rows?.[markers[6]]?.row?.y ?? -1) > (after8[markers[6]]?.row?.y ?? -1)
  writeLedger(h, 'tail-after-turn-8.json', { rows: after8, main: rect(regionNode(snapshot8, 'sf-main') ?? {}) })
  h.check('NATIVE TAIL FOLLOW (from the real turn-7 to turn-8 append only): the newest row stayed inside the visible Main while the older row moved up',
    tailAfterTurn7 !== undefined && newestVisible === true && olderMovedUp === true,
    JSON.stringify({ before: tailAfterTurn7?.rows?.[markers[6]], after: after8[markers[6]], newest: after8[markers[7]] }))
  h.measure('NATIVE TAIL FOLLOW scope', 'no reveal-node and no project-* command was used for this pair')

  // Node identity for the SAME production source across eight real streaming
  // and settle commits: one source seq, one card per message, no re-scope.
  const productionCommits = commits(h, 'production')
  const sourceSeqs = [...new Set(productionCommits.map(commit => commit.sourceSeq))]
  const identityPairs = turns.map(turn => ({
    ordinal: turn.ordinal, marker: turn.marker,
    capturedId: turn.rowId, currentId: rowIdFor(h, turn.marker),
    same: turn.rowId !== undefined && turn.rowId === rowIdFor(h, turn.marker),
  }))
  h.check('G-TRANSCRIPT-NODE-IDENTITY: the eight real streaming/settle commits stayed in one presentation scope and every captured row id is still the SAME wire id',
    sourceSeqs.length === 1 && mountedRowTexts(h, markers.slice(0, 8)).length === 8
      && identityPairs.every(pair => pair.same) && new Set(identityPairs.map(pair => pair.currentId)).size === 8,
    JSON.stringify({ sourceSeqs, identityPairs }))

  // A held turn is an ALREADY RUNNING Agent turn: the reader scrolls back, then
  // that same turn releases. A new own submission would legitimately re-tail.
  const heldPrompt = aPrompts[8]
  await runCase(h, 'hold-next-model')
  const heldAnswersBefore = answerCardsLive(h)
  const heldSettledBefore = settledWrites(h).length
  await submit(h, heldPrompt.text)
  const heldSettled = await waitUntil(h, `held submission ${heldPrompt.marker} committed`, () =>
    settledWrites(h).length === heldSettledBefore + 1 && settledWrites(h).at(-1)?.marker === heldPrompt.marker, { limit: 300 })
  h.check('G-TRANSCRIPT-READING-ANCHOR: the held submission reached the real Writer while its model stream stayed held',
    heldSettled, JSON.stringify({ settled: settledWrites(h).at(-1) }))
  if (!heldSettled) { finish(h, extra); return }
  const heldMounted = await waitUntil(h, 'the held input row mounted in Main', () =>
    mainShows(h, heldPrompt.marker) && rowIdFor(h, heldPrompt.marker) !== undefined, { limit: 300 })
  h.check('G-TRANSCRIPT-READING-ANCHOR: Main shows the held user row and NO new answer while the stream is held',
    heldMounted && answerCardsLive(h) === heldAnswersBefore,
    JSON.stringify({ answerCardsLive: answerCardsLive(h), heldAnswerCardsBefore: heldAnswersBefore }))
  if (!heldMounted) { finish(h, extra); return }

  await h.key('PageUp', 900)
  const pageUpSnapshot = h.snapshot()
  const olderVisible = markers.slice(0, 8).filter(text => clientRow(pageUpSnapshot, text)?.containedXY === true)
  const tailAfterPageUp = clientRow(pageUpSnapshot, heldPrompt.marker)
  writeLedger(h, 'pageup-geometry.json', {
    main: rect(regionNode(pageUpSnapshot, 'sf-main') ?? {}),
    olderVisible, tailRow: tailAfterPageUp,
    rows: rowMap(h, [...olderVisible, heldPrompt.marker], pageUpSnapshot),
  })
  if (olderVisible.length < 2 || tailAfterPageUp?.containedXY !== false) {
    h.check('G-TRANSCRIPT-READING-ANCHOR: PageUp made the real client leave the tail and show at least two older rows',
      false, JSON.stringify({ olderVisible, tailAfterPageUp }))
    h.capture('transcript-pageup-stayed-at-tail', 'the client did not leave the tail: the anchor comparison is not runnable')
    finish(h, extra)
    return
  }
  h.check('G-TRANSCRIPT-READING-ANCHOR: PageUp made the real client leave the tail and show at least two older rows',
    true, JSON.stringify({ olderVisible: olderVisible.slice(0, 4), tailAfterPageUp }))

  const anchorTexts = olderVisible.slice(0, 3)
  const beforeRelease = rowMap(h, anchorTexts)
  const beforeReleaseShot = h.capture('transcript-reading-old-before-release', 'the reader parked on older rows while the held turn still runs')
  frameCorrelations.push(frameCorrelation(h, beforeReleaseShot, anchorTexts[0]))
  const releaseResult = await runCase(h, 'release-model')
  h.check('G-TRANSCRIPT-READING-ANCHOR: the release-model command really released the ONE held model promise',
    releaseResult?.released === true && releaseResult?.armed === false,
    JSON.stringify(releaseResult))
  const released = await waitUntil(h, 'the held Agent stream really produced its answer', () =>
    answerCardsLive(h) === heldAnswersBefore + 1, { limit: 400 })
  const releaseCommit = commits(h, 'production').at(-1)
  h.check('G-TRANSCRIPT-READING-ANCHOR: the released turn streamed through the SAME production source and commit chain',
    released && releaseCommit?.origin === 'production' && releaseCommit?.sourceSeq === sourceSeqs[0],
    JSON.stringify({ released, answerCardsLive: answerCardsLive(h), releaseCommit }))
  const afterRelease = rowMap(h, anchorTexts)
  const deltas = anchorTexts.map(text => ({
    text,
    beforeY: beforeRelease[text]?.row?.y,
    afterY: afterRelease[text]?.row?.y,
    delta: Math.abs((afterRelease[text]?.row?.y ?? Number.NaN) - (beforeRelease[text]?.row?.y ?? Number.NaN)),
    beforeId: beforeRelease[text]?.id,
    afterId: afterRelease[text]?.id,
  }))
  const afterReleaseShot = h.snapshot()
  const tailRowAfterRelease = clientRow(afterReleaseShot, heldPrompt.marker)
  writeLedger(h, 'reading-anchor.json', {
    beforeReleaseShot, before: beforeRelease, after: afterRelease, deltas,
    tailRowAfterRelease,
    productionCommitsDuringRelease: commits(h, 'production').slice(-4),
  })
  h.check(`G-TRANSCRIPT-READING-ANCHOR: every overlap row kept its wire id and its physical position within ${TOLERANCE_PX} CSS px while the released answer streamed`,
    deltas.length >= 2 && deltas.every(entry => entry.beforeId !== undefined && entry.beforeId === entry.afterId
      && Number.isFinite(entry.delta) && entry.delta <= TOLERANCE_PX),
    JSON.stringify(deltas))
  h.check('G-TRANSCRIPT-READING-ANCHOR: the held user row is still mounted but the reader was not dragged down to the new reply',
    rowIdFor(h, heldPrompt.marker) !== undefined && tailRowAfterRelease !== undefined
      && tailRowAfterRelease.containedXY === false && tailRowAfterRelease.visibleSpanY === 0,
    JSON.stringify({ tailRowAfterRelease, heldRowId: rowIdFor(h, heldPrompt.marker) }))
  h.capture('transcript-stream-while-reading-old', 'the released answer streamed while the older rows stayed put')

  // ─────── group 3: TEST-ONLY re-window and Reveal against the same Presenter ───────
  const sourceSeqBeforeRewindow = commits(h, 'production').at(-1)?.sourceSeq
  const fullMessages = commits(h, 'production').at(-1)?.messageCount
  const submittedMarkers = turns.map(turn => turn.marker)
  const heldMarker = records(h).find(entry => entry.kind === 'producer.writer.settled' && entry.marker === aPrompts[8].marker)?.marker
  // Capture every row id BEFORE any unmounting: the stale id used later is a
  // real SDK id read off this run's wire, never a guessed `msg-N` index.
  const idsBeforeTail = rowMap(h, [...submittedMarkers, heldMarker])
  const mountedBeforeTail = Object.entries(idsBeforeTail).filter(([, entry]) => entry.id !== undefined).map(([, entry]) => entry.id)
  const tailResult = await runCase(h, 'project-tail-window')
  const idsAfterTail = rowMap(h, [...submittedMarkers, heldMarker])
  const dropped = Object.entries(idsAfterTail).filter(([marker, entry]) => idsBeforeTail[marker]?.id !== undefined && entry.id === undefined)
  const overlap = Object.entries(idsAfterTail).filter(([, entry]) => entry.id !== undefined)
  h.check('TEST_ONLY_REWINDOW: the tail window unmounted older rows in the SDK node set (an absent wire id, not a clipped viewport) and kept at least two real rows mounted',
    tailResult?.status === 'ok' && dropped.length >= 1 && overlap.length >= 2
      && overlap.every(entry => mountedBeforeTail.includes(entry[1].id)),
    JSON.stringify({ dropped: dropped.map(entry => entry[0]), overlap: overlap.map(entry => entry[0]), tailResult }))
  if (tailResult?.status !== 'ok' || dropped.length < 1 || overlap.length < 2) { finish(h, extra); return }

  const revealText = overlap[0][0]
  const revealId = overlap[0][1].id
  h.check('the Reveal target id came from this run SDK wire, never from a text or index guess',
    typeof revealId === 'string' && ROW_ID.test(revealId), JSON.stringify({ revealId, revealText }))
  const revealedBefore = clientRow(h.snapshot(), revealText)
  await runCase(h, 'reveal-node', { nodeId: revealId })
  const revealMoved = await waitUntil(h, 'the revealed row became fully visible', () =>
    clientRow(h.snapshot(), revealText)?.containedXY === true, { limit: 150 })
  const revealedAfter = clientRow(h.snapshot(), revealText)
  const secondOverlapText = overlap[1][0]
  const secondOverlap = clientRow(h.snapshot(), secondOverlapText)
  writeLedger(h, 'reveal-mounted.json', { revealId, revealText, revealedBefore, revealedAfter, secondOverlap })
  h.check('G-TRANSCRIPT-REVEAL: revealing a MOUNTED id put that row inside the client viewport and left a second overlap row fully visible',
    revealMoved && revealedAfter?.containedXY === true
      && secondOverlap !== undefined && secondOverlap.containedXY === true,
    JSON.stringify({ revealMoved, revealedAfter, secondOverlap }))
  h.capture('transcript-reveal-mounted-tail-window', 'the tail window after a native reveal of a mounted id')

  // Put the whole old prefix back into the SAME already-mounted Presenter.
  const overlapPair = [revealText, secondOverlapText]
  const beforePrefix = rowMap(h, overlapPair)
  const prefixBeforeShot = h.capture('transcript-prefix-before', 'the tail window immediately before the full prefix returns')
  frameCorrelations.push(frameCorrelation(h, prefixBeforeShot, revealText))
  const fullResult = await runCase(h, 'project-full-window')
  const prefixSnapshot = h.snapshot()
  const afterPrefix = rowMap(h, overlapPair, prefixSnapshot)
  const restoredOlder = dropped.slice(0, 2).map(entry => ({ text: entry[0], id: rowIdFor(h, entry[0]), row: clientRow(prefixSnapshot, entry[0]) }))
  const overlapShifts = overlapPair.map(text => ({
    text,
    beforeY: beforePrefix[text]?.row?.y,
    afterY: afterPrefix[text]?.row?.y,
    delta: Math.abs((afterPrefix[text]?.row?.y ?? Number.NaN) - (beforePrefix[text]?.row?.y ?? Number.NaN)),
    sameId: beforePrefix[text]?.id === afterPrefix[text]?.id && afterPrefix[text]?.id !== undefined,
    afterContained: afterPrefix[text]?.row?.containedXY === true,
  }))
  const lastCommit = commits(h).at(-1)
  writeLedger(h, 'prefix-prepend.json', {
    prefixBeforeShot, before: beforePrefix, after: afterPrefix, overlapShifts, restoredOlder, fullResult,
    sourceSeqBefore: sourceSeqBeforeRewindow, sourceSeqAfter: lastCommit?.sourceSeq, origin: lastCommit?.origin,
  })
  h.check('G-TRANSCRIPT-HISTORY-PREPEND: the full prefix came back to the SAME source and the SAME mounted Presenter',
    fullResult?.status === 'ok' && fullResult.sourceSeq === sourceSeqBeforeRewindow
      && lastCommit?.origin === 'subject-probe' && lastCommit?.sourceSeq === sourceSeqBeforeRewindow
      && (fullResult.messageCount ?? 0) >= (fullMessages ?? 0),
    JSON.stringify({ fullResult, lastCommit, fullMessages }))
  h.check(`G-TRANSCRIPT-HISTORY-PREPEND: BOTH overlap rows kept their SDK node ids, stayed fully visible and kept their physical position within ${TOLERANCE_PX} CSS px`,
    overlapShifts.length === 2 && overlapShifts.every(entry => entry.sameId && entry.afterContained
      && Number.isFinite(entry.delta) && entry.delta <= TOLERANCE_PX),
    JSON.stringify({ before: beforePrefix, after: afterPrefix, overlapShifts }))
  h.check('G-TRANSCRIPT-HISTORY-PREPEND: the restored older rows sit physically IN FRONT of the overlap row in the same document',
    restoredOlder.length >= 2 && restoredOlder.every(entry => typeof entry.id === 'string' && entry.row !== undefined
      && entry.row.y < (afterPrefix[revealText]?.row?.y ?? -1)),
    JSON.stringify({ restoredOlder, overlap: afterPrefix[revealText] }))
  h.capture('transcript-prefix-after', 'the full prefix re-mounted on the same production Main')

  // The negative control: an id the SECOND tail window unmounted must be
  // refused by the client, and the refusal must resurrect nothing.
  const staleText = dropped[0][0]
  const staleId = idsBeforeTail[staleText]?.id
  await runCase(h, 'project-tail-window')
  const secondTailOk = await waitUntil(h, 'the second tail window unmounted the old prefix again', () =>
    rowIdFor(h, staleText) === undefined, { limit: 150 })
  const staleRowAfterSecondTail = clientRow(h.snapshot(), staleText)
  h.check('G-TRANSCRIPT-REVEAL: the id captured from the full window is genuinely absent from the SDK node set now',
    secondTailOk && typeof staleId === 'string' && foldLive(h).has(staleId) === false
      && staleRowAfterSecondTail === undefined,
    JSON.stringify({ staleId, secondTailOk, stillMounted: rowIdFor(h, staleText), staleRowAfterSecondTail }))
  const errorsBefore = sdkErrors(h).length
  await runCase(h, 'reveal-node', { nodeId: staleId })
  const refused = await waitUntil(h, 'the client answered the unmounted reveal with its own protocol error', () =>
    sdkErrors(h).length > errorsBefore, { limit: 150 })
  const newErrors = sdkErrors(h).slice(errorsBefore)
  h.check('G-TRANSCRIPT-REVEAL: revealing an UNMOUNTED id fails with the real client unknown-id error',
    refused && newErrors.some(entry => /unknown id/iu.test(String(entry.msg))), JSON.stringify({ refused, newErrors }))
  h.check('G-TRANSCRIPT-REVEAL: the refused reveal resurrected no row, switched no source and stayed non-fatal',
    rowIdFor(h, staleText) === undefined && commits(h).at(-1)?.sourceSeq === sourceSeqBeforeRewindow
      && records(h).some(entry => entry.kind === 'fixture.ready') && !records(h).some(entry => entry.kind === 'app.exit'),
    JSON.stringify({ stale: rowIdFor(h, staleText), lastCommit: commits(h).at(-1), newErrors }))
  h.capture('transcript-stale-reveal-refused', 'the refused reveal of an unmounted id: the old row stayed gone')

  await runCase(h, 'project-full-window')
  const remounted = await waitUntil(h, 'the previously unmounted id came back', () => rowIdFor(h, staleText) !== undefined, { limit: 150 })
  h.check('G-TRANSCRIPT-REVEAL: the SAME id mounted again, exactly once, with no duplicate business node',
    remounted && rowIdFor(h, staleText) === staleId
      && [...foldLive(h).keys()].filter(id => ROW_ID.test(id) && subtreeText(foldLive(h), id).includes(staleText)).length === 1,
    JSON.stringify({ staleId, now: rowIdFor(h, staleText) }))
  const staleBeforeReveal = clientRow(h.snapshot(), staleText)
  await runCase(h, 'reveal-node', { nodeId: staleId })
  const remountedVisible = await waitUntil(h, 'the re-mounted id became visible through reveal', () =>
    clientRow(h.snapshot(), staleText)?.containedXY === true, { limit: 150 })
  writeLedger(h, 'reveal-stale-and-restored.json', {
    staleId, staleText,
    mountedTailReveal: { text: revealText, before: revealedBefore, after: revealedAfter },
    staleRowAfterSecondTail: staleRowAfterSecondTail ?? null,
    staleRowBeforeRemountReveal: staleBeforeReveal,
    staleRowAfterRemountReveal: clientRow(h.snapshot(), staleText),
    errors: sdkErrors(h),
  })
  h.check('G-TRANSCRIPT-REVEAL: revealing the re-mounted id makes it physically visible at a real client position',
    remountedVisible, JSON.stringify({ before: staleBeforeReveal, after: clientRow(h.snapshot(), staleText) }))
  h.measure('LATEST_FOLLOW', 'NOT_IMPLEMENTED / NOT_PROVEN: reveal(tail) is not a Follow re-arm and this run added no user Latest/Back-to-bottom entry')

  // ─────────── group 4: the real Session source replacement through the native Browser ───────────
  await runCase(h, 'project-full-window')
  await submit(h, '/sessions')
  if (!await requiredWait(h, 'the native Session Browser opens over the production Main', () =>
    h.classNodes(h.snapshot(), 'sf-picker').length === 1
    && h.classNodes(h.snapshot(), 'pk-row').filter(node => !String(node.class ?? '').split(/\s+/u).includes('grp')).length >= 2,
  { limit: 200 })) {
    finish(h, extra)
    return
  }
  const browserSnapshot = h.snapshot()
  const rowForSession = sessionId => browserSnapshot.nodes.find(node => node.id === `pk-session:${sessionId}`)
  const currentRow = rowForSession(testInput.sessions.a)
  const targetRow = rowForSession(testInput.sessions.b)
  h.check('the real Browser lists both fixed Sessions as separate native option rows (A is the Current one)',
    currentRow !== undefined && targetRow !== undefined && currentRow.id !== targetRow.id
      && String(currentRow.class ?? '').split(/\s+/u).includes('cur'),
    JSON.stringify({ a: { id: currentRow?.id, class: currentRow?.class }, b: { id: targetRow?.id, class: targetRow?.class } }))
  h.capture('transcript-sessions-browser-1280x800', 'the native Browser over the production A Main')
  const selected = targetRow !== undefined && await h.click(browserSnapshot.chains, targetRow)
  if (!await requiredWait(h, 'selecting B enabled the primary Resume and started no switch', () => {
    const snap = h.snapshot()
    const resume = h.classNodes(snap, 'pk-btn').find(node => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
    const tokens = resume === undefined ? [] : String(resume.class ?? '').split(/\s+/u)
    return selected === true && tokens.includes('primary') && !tokens.includes('off')
      && !records(h).some(entry => entry.kind === 'agents.resume.start' && entry.sessionId === testInput.sessions.b)
  }, { limit: 200 })) {
    finish(h, extra)
    return
  }
  const resumeSnapshot = h.snapshot()
  const resumeButton = h.classNodes(resumeSnapshot, 'pk-btn').find(node => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
  const productionBeforeSwitch = commits(h, 'production').length
  // Start the timer BEFORE the one irreversible click, so the reported settle
  // and commit durations include the control-injected Resume delivery.
  const switchStartedAt = Date.now()
  const resumeClicked = resumeButton !== undefined && await h.click(resumeSnapshot.chains, resumeButton)
  h.check('the user clicked the native Resume button once', resumeClicked === true,
    JSON.stringify({ resumeClicked, rect: resumeButton === undefined ? null : rect(resumeButton) }))
  // The official transition is timed, not assumed: the real `agents.resume(B)`
  // settle and the incoming source's own commit are separate observable facts,
  // and the switch is measurably slow in this environment.
  const resumeSettled = resumeClicked && await waitUntil(h, 'the official agents.resume(B) settled', () =>
    records(h).some(entry => entry.kind === 'agents.resume.settled' && entry.sessionId === testInput.sessions.b),
  { limit: 1200 })
  const resumeSettledAt = Date.now()
  h.check('the official agents.resume(B) settled', resumeSettled, JSON.stringify({ resumeSettled }))
  // The witness is a production commit carrying a source identity the old
  // source never produced — not a commit count, which a fast switch could
  // already satisfy before the baseline is read.
  const incomingCommitted = resumeSettled && await waitUntil(h, 'the incoming source produced its own production commit', () =>
    commits(h, 'production').some(commit => commit.sourceSeq !== sourceSeqBeforeRewindow),
  { limit: 1200 })
  const switchTimings = {
    resumeSettledMs: resumeSettledAt - switchStartedAt,
    incomingCommitMs: Date.now() - switchStartedAt,
    productionCommitsBeforeSwitch: productionBeforeSwitch,
    aSourceSeq: sourceSeqBeforeRewindow,
    bSourceSeq: commits(h, 'production').at(-1)?.sourceSeq,
  }
  writeLedger(h, 'session-switch-timing.json', switchTimings)
  if (!incomingCommitted) { finish(h, extra); return }
  const bCommit = commits(h, 'production').at(-1)
  const bSeq = bCommit?.sourceSeq
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: the projection source identity really changed (object identity, not a Session label)',
    typeof sourceSeqBeforeRewindow === 'number' && typeof bSeq === 'number' && sourceSeqBeforeRewindow !== bSeq,
    JSON.stringify({ aSeq: sourceSeqBeforeRewindow, bSeq, bCommit }))
  if (!await requiredWait(h, 'the Browser retired once B became the owner', () =>
    h.classNodes(h.snapshot(), 'sf-picker').length === 0, { limit: 200 })) {
    finish(h, extra)
    return
  }
  const aLeftMain = await waitUntil(h, 'A rows left the incoming Main', () =>
    mountedRowTexts(h, [...markers.slice(0, 8), heldPrompt.marker]).length === 0, { limit: 200 })
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: every A marker is unmounted from the incoming source Main', aLeftMain,
    JSON.stringify({ stillMounted: mountedRowTexts(h, [...markers.slice(0, 8), heldPrompt.marker]), main: mainText(h).slice(0, 160) }))
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: the switch reused the ONE production Surface (no second inline document)',
    openedSurfaces(h).length === 1, JSON.stringify(openedSurfaces(h)))

  const settledBeforeB = settledWrites(h).length
  await submit(h, bPrompt.text)
  const bSettled = await waitUntil(h, 'the B submission settled under Session B and mounted in Main', () =>
    settledWrites(h).length === settledBeforeB + 1 && settledWrites(h).at(-1)?.sessionId === testInput.sessions.b
    && settledWrites(h).at(-1)?.marker === bPrompt.marker && mainShows(h, bPrompt.marker), { limit: 300 })
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: B submission produced a real settled write and a new B wire row', bSettled,
    JSON.stringify({ bSettled, last: settledWrites(h).at(-1), bRowId: rowIdFor(h, bPrompt.marker) }))
  const bRowId = rowIdFor(h, bPrompt.marker)
  const errorsBeforeStale = sdkErrors(h).length
  await runCase(h, 'reveal-node', { nodeId: staleId })
  const staleRefused = await waitUntil(h, 'the old A id is refused under source B', () =>
    sdkErrors(h).length > errorsBeforeStale, { limit: 150 })
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: revealing an old-source id is refused while no A content comes back',
    staleRefused && sdkErrors(h).slice(errorsBeforeStale).some(entry => /unknown id/iu.test(String(entry.msg)))
      && !mainShows(h, markers[0]) && rowIdFor(h, markers[0]) === undefined,
    JSON.stringify({ errors: sdkErrors(h).slice(errorsBeforeStale), aVisible: mainShows(h, markers[0]) }))
  await runCase(h, 'reveal-node', { nodeId: bRowId })
  const bRevealed = await waitUntil(h, 'the current B row is reachable through reveal', () =>
    clientRow(h.snapshot(), bPrompt.marker)?.containedXY === true, { limit: 150 })
  h.check('G-TRANSCRIPT-SOURCE-SWITCH: the current B node id reveals successfully', bRevealed,
    JSON.stringify({ bRowId, row: clientRow(h.snapshot(), bPrompt.marker) }))
  h.capture('transcript-source-B-stale-reveal-refused', 'source B live: the stale A id refused, the current B row revealed')

  // ─────────── group 5: real client responsiveness on the still-live B Presenter ───────────
  const cells = []
  for (const [width, height] of VIEWPORTS) {
    await h.resize(width, height)
    const appearance = width === 900 && height === 360 ? 'light' : 'dark'
    await h.send('appearance', appearance)
    await h.sleep(400)
    const viewport = h.ctl('stats').viewport
    const id = h.capture(`transcript-viewport-${width}x${height}-${appearance}`, `responsive cell ${width}x${height} ${appearance}`)
    if (width === 900 && height === 700) frameCorrelations.push(frameCorrelation(h, id, bPrompt.marker))
    const snap = index(readJson(join(h.root, `${id}.tree.json`))?.tree ?? [])
    const layout = readJson(join(h.root, 'shots', 'serve', `${id}.layout.json`))
    const main = regionNode(snap, 'sf-main')
    const dock = regionNode(snap, 'sf-dock')
    const bRow = clientRow(snap, bPrompt.marker)
    // The inline Main is the CLIENT's scrolled document: its box legitimately
    // extends past the viewport top while the reader is not at the document
    // start, so "the whole region is contained" is NOT the product claim. The
    // load-bearing claims are a real visible intersection inside the pane with
    // no horizontal clipping, no Main/Dock overlap, and the CURRENT row fully
    // visible above the Dock.
    const mainBox = main === undefined ? { span: { x: 0, y: 0 }, rect: [0, 0, 0, 0], start: { x: 0, y: 0 } }
      : visibleBox(snap.chains, main)
    const cell = {
      size: [width, height], appearance, capture: id, png: join(h.root, 'shots', 'serve', `${id}.png`),
      viewport, layoutTheme: layout?.theme, stateTheme: h.ctl('state').theme,
      mainBox: main === undefined ? null : rect(main), dockBox: dock === undefined ? null : rect(dock),
      mainSpanY: mainBox.span?.y ?? 0, mainSpanX: mainBox.span?.x ?? 0, mainWidth: mainBox.rect?.[2] ?? 0,
      mainOverlapsDock: main !== undefined && dock !== undefined
        ? mainBox.start.y + mainBox.span.y > rect(dock)[1] + 0.5 : true,
      dockContained: dock !== undefined && containedXY(snap.chains, dock),
      bRow: bRow ?? null,
      bRowAboveDock: bRow !== undefined && dock !== undefined && bRow.rect[1] + bRow.height <= rect(dock)[1] + 0.5,
      bMountedInMain: mainText(h, snap).includes(bPrompt.marker),
    }
    cells.push(cell)
    h.check(`G-TRANSCRIPT-VIEWPORT ${width}x${height} ${appearance}: the client really took the viewport and the requested appearance`,
      viewport?.[0] === width && viewport?.[1] === height && cell.layoutTheme === appearance && cell.stateTheme === appearance,
      JSON.stringify(cell))
    h.check(`G-TRANSCRIPT-VIEWPORT ${width}x${height} ${appearance}: native Main keeps a real unclipped intersection inside the pane, the Composer Dock is fully contained, Main never overlaps the Dock, and the current B row is fully visible above it`,
      cell.mainSpanY >= 33 && cell.mainSpanX >= cell.mainWidth - 0.5 && cell.dockContained === true
        && cell.mainOverlapsDock === false && cell.bMountedInMain === true
        && bRow !== undefined && bRow.containedXY === true && cell.bRowAboveDock === true,
      JSON.stringify(cell))
  }
  writeLedger(h, 'viewport-cells.json', cells)
  await h.send('appearance', 'dark')
  h.measure('G-TRANSCRIPT-VIEWPORT scope', 'headless client appearance only: NOT a physical OS GUI window and NOT Owner G8 visual acceptance')

  // ─────────── ordered teardown ───────────
  await submit(h, '/exit')
  const settledExit = await waitUntil(h, 'the production fixture settled before Tern exited', () =>
    records(h).some(entry => entry.kind === 'fixture.settled'), { limit: 300 })
  h.check('teardown: the fixture settled and the Subject process ended after the ordered exit', settledExit
    && records(h).some(entry => entry.kind === 'process.exit'), JSON.stringify(records(h).slice(-4)))

  // The evidence claim is made over the artifacts THIS run already wrote. The
  // two ledgers the flow itself produces are written last: `lane-ledger.json`
  // right below and `assertions.json` by the driver's final `h.finish()`, so
  // neither is asserted here; the ordered teardown is asserted instead through
  // the Subject's own `fixture.settled` record above.
  const evidenceFiles = {
    events: eventPath(h), wire: wirePath(h), prompts: join(h.root, 'prompts.json'),
    caseResult: join(h.root, 'case-result.json'), runLog: join(h.root, 'run.log'),
    subjectCopy: join(h.root, 'subject.mts'), flowCopy: join(h.root, 'flow.mjs'),
    environment: join(h.root, 'environment.json'),
    productionChain: join(h.root, 'source-decision-sink-production.json'),
    anchor: join(h.root, 'reading-anchor.json'),
    prepend: join(h.root, 'prefix-prepend.json'),
    revealMounted: join(h.root, 'reveal-mounted.json'),
    revealStale: join(h.root, 'reveal-stale-and-restored.json'),
    switchTiming: join(h.root, 'session-switch-timing.json'),
    viewportCells: join(h.root, 'viewport-cells.json'),
    tailTurn7: join(h.root, 'tail-after-turn-7.json'),
    tailTurn8: join(h.root, 'tail-after-turn-8.json'),
    pageUp: join(h.root, 'pageup-geometry.json'),
  }
  const missing = Object.entries(evidenceFiles).filter(([, path]) => !existsSync(path)).map(entry => entry[0])
  const captureIds = allCaptureIds(h)
  const captureEvidence = captureIds.map(capture => {
    const tree = join(h.root, `${capture}.tree.json`)
    const png = join(h.root, 'shots', 'serve', `${capture}.png`)
    const layout = join(h.root, 'shots', 'serve', `${capture}.layout.json`)
    return {
      capture,
      tree: existsSync(tree), png: existsSync(png), layout: existsSync(layout),
      treeBytes: existsSync(tree) ? readFileSync(tree).length : 0,
      pngBytes: existsSync(png) ? readFileSync(png).length : 0,
      layoutBytes: existsSync(layout) ? readFileSync(layout).length : 0,
    }
  })
  // Every capture must be a DISTINCT step id (`NN-<name>`), so a duplicated or
  // missing SHOT line can never be compensated by another capture's artifacts.
  const uniqueCaptureIds = new Set(captureIds).size === captureIds.length
  const distinctSteps = new Set(captureIds.map(capture => capture.split('-')[0])).size === captureIds.length
  // Explicit marker + frame sequence + screenshot id correlations, each one
  // sampled at its own capture instant (see frameCorrelations below).
  writeLedger(h, 'frame-correlations.json', frameCorrelations)
  writeLedger(h, 'lane-ledger.json', {
    tern: ternVersion, ternSha256,
    sdk: { pin: sdkPin, integrity },
    dsh: { mode: dshMode, cliPin: dshPin, agentPin: dshPin, sessionPin: dshSessionPin },
    host,
    PRODUCTION_DIRECT_MAIN: 'G-TRANSCRIPT-WRITER-TO-MAIN',
    PRESENTER_TEST_REWINDOW: 'TEST_ONLY_REWINDOW: a Subject command channel, never a user Older/Newer/Latest entry',
    PRODUCT_USER_PAGING: 'NOT_IMPLEMENTED',
    PROGRAMMATIC_LATEST_REARMS_FOLLOW: 'NOT_PROVEN',
    PHYSICAL_GUI_G8: 'NOT_VERIFIED (headless tern serve with control-injected input)',
    inputMode: 'CONTROL_INJECTED, each delivered exactly once and never retried',
    verifyRelease: 'NOT_RUN on this lane: the narrow and product lanes in this run directory are the required checks for the two new scripts; no stage-final release claim is made',
    evidence: {
      ...evidenceFiles, productionCommits: commits(h, 'production').length,
      probeCommits: commits(h, 'subject-probe').length, sdkErrors: sdkErrors(h).length,
      captures: captureIds, frameCorrelations,
    },
  })
  h.check('G-TRANSCRIPT-EVIDENCE: exactly the fourteen distinct captures this flow issues each have a non-empty tree, PNG and layout, and every required ledger/event/wire file exists',
    missing.length === 0 && captureIds.length === 14 && uniqueCaptureIds && distinctSteps
      && captureEvidence.every(entry => entry.tree && entry.png && entry.layout
        && entry.treeBytes > 0 && entry.pngBytes > 0 && entry.layoutBytes > 0),
    JSON.stringify({ missing, uniqueCaptureIds, distinctSteps, captureEvidence }))
  h.check('G-TRANSCRIPT-EVIDENCE: each named marker is correlated with one live SDK row id, the current wire frame sequence and its own screenshot id',
    frameCorrelations.length === 4 && frameCorrelations.every(entry => typeof entry.rowId === 'string'
      && ROW_ID.test(entry.rowId) && typeof entry.frameSeq === 'number'
      && existsSync(entry.png) && existsSync(entry.tree)),
    JSON.stringify(frameCorrelations))
  finish(h, {
    ...extra,
    sessions: testInput.sessions,
    productionCommits: commits(h, 'production').length,
    probeCommits: commits(h, 'subject-probe').length,
    sdkErrors: sdkErrors(h).length,
    viewportCells: cells.length,
  })
}
