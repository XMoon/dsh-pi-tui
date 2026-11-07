/**
 * TSP canonical Full/Compact transcript mode qualification FLOW.
 *
 *   TERN_PANE_TRANSCRIPT_MODE=compact \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-modes.mjs
 *   TERN_PANE_TRANSCRIPT_MODE=full \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-modes.mjs
 *
 * ONE mode per run, each in its OWN fresh `tern serve --control` pane (no TTY
 * concurrency). The subject boots the PRODUCTION Direct application with the
 * mode coming from the real Runner `tuiConfig.displayPreset`; this flow imports
 * neither `transcriptView()` nor `mountTspRenderer()` and renders nothing.
 *
 * Every positive claim needs BOTH authorities in the same run: the SDK wire
 * (`sdk-wire.jsonl` — the one `o`, the `f` frames, the `ack`s, the folded live
 * node set) AND the real client tree/geometry/PNG. A `setTranscript` recorder
 * entry is never evidence that anything was painted.
 *
 * Compact additionally requires a REAL pointer click on the visible Activity
 * header to produce the client's own `toggle` event and reveal that Work's Tool
 * body; a synthetic injected event is never accepted as mouse evidence.
 * @module scripts/tern-pane-transcript-modes
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, platform, cpus, release, type } from 'node:os'
import { join } from 'node:path'
import { rect, visibleSpan, containedXY } from './tern-pane-geometry.mjs'

const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]
/** One top-level transcript row on the wire: `<scopePrefix>msg-<n>` under main. */
const ROW_ID = /^main\.s\d+-msg-\d+$/u
/** A Compact Activity root: `<scopePrefix>work-msg-<n>` under main. */
const WORK_ID = /^main\.s\d+-work-msg-\d+$/u

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const jsonl = path => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  : []
const records = h => jsonl(eventPath(h))
const wireRecords = h => jsonl(wirePath(h))
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined

const openedSurfaces = h => wireRecords(h)
  .filter(entry => entry.dir === 'out' && entry.verb === 'o')
  .map(entry => ({ id: entry.body?.id, mode: entry.body?.mode ?? 'inline' }))

/** The live SDK node set folded from every `f` frame (a deleted node is GONE). */
function foldLive (h) {
  const nodes = new Map()
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object' || typeof node.id !== 'string') return
    const entry = nodes.get(node.id) ?? { k: node.k, p: {}, childIds: [] }
    entry.k = node.k
    entry.p = { ...entry.p, ...(node.p ?? {}) }
    nodes.set(node.id, entry)
    for (const child of node.c ?? []) {
      visit(child)
      if (child && typeof child.id === 'string') entry.childIds.push(child.id)
    }
  }
  const drop = id => {
    for (const key of [...nodes.keys()]) if (key === id || key.startsWith(`${id}.`)) nodes.delete(key)
  }
  for (const entry of wireRecords(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') visit(op[4])
      else if (op[0] === 'del') drop(op[1])
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p = { ...node.p, ...(op[2] ?? {}) }
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          const previous = typeof node.p.text === 'string' ? node.p.text : ''
          node.p.text = op[2] === 'append' ? previous + String(op[3] ?? '') : String(op[3] ?? '')
        }
      }
    }
  }
  return nodes
}

const subtreeText = (live, id) => {
  const parts = []
  const walk = current => {
    const node = live.get(current)
    if (node === undefined) return
    if (typeof node.p.text === 'string') parts.push(node.p.text)
    if (typeof node.p.head === 'string') parts.push(node.p.head)
    for (const child of node.childIds) walk(child)
  }
  walk(id)
  return parts.join(' ')
}

const regionNode = (snap, name) => snap.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

/** The client's Main subtree only — the Dock composer repeats input bytes. */
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

function mainText (h, snapshot = h.snapshot()) {
  const main = regionNode(snapshot, 'sf-main')
  return main === undefined ? '' : h.descendantsText(main)
}

/** The Main-region fragment that physically shows `text`, with its real box. */
function clientRow (snapshot, text) {
  const node = mainNodes(snapshot).find(candidate => String(candidate.text ?? '').includes(text))
  if (node === undefined) return undefined
  return { node, rect: rect(node), containedXY: containedXY(snapshot.chains, node), visibleSpanY: visibleSpan(snapshot.chains, node, 'y') }
}

async function waitUntil (h, label, predicate, { limit = 250, intervalMs = 100 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
async function requiredWait (h, label, predicate, options) {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify({ mainText: mainText(h).slice(0, 160), liveIds: [...foldLive(h).keys()].slice(0, 8) }).slice(0, 380))
  return ok
}

const latestFrameSeq = h => wireRecords(h).filter(entry => entry.dir === 'out' && entry.verb === 'f').at(-1)?.body?.s ?? null
const ackEvents = h => wireRecords(h).filter(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack')

function finish (h, extra = {}) {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}
function writeLedger (h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
}

let caseSeq = 0
async function runCase (h, kind) {
  caseSeq += 1
  const seq = caseSeq
  const path = join(h.root, 'case.json')
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ seq, kind })}\n`)
  renameSync(`${path}.tmp`, path)
  const ok = await waitUntil(h, `subject case ${kind} #${seq}`, () => readJson(join(h.root, 'case-result.json'))?.seq === seq)
  const result = readJson(join(h.root, 'case-result.json'))
  h.check(`the subject handled the ${kind} command`, ok && result?.status === 'ok', JSON.stringify(result ?? null).slice(0, 300))
  return result
}

/** ONE control-injected submit: type the prompt, then a single Return. */
async function submit (h, text) {
  h.send('type', JSON.stringify(text))
  await h.key('Return', 600)
}

export default async function (h) {
  const mode = process.env.TERN_PANE_TRANSCRIPT_MODE
  if (mode !== 'full' && mode !== 'compact') throw new Error('TERN_PANE_TRANSCRIPT_MODE must be exactly full or compact')
  // The harness launcher forwards only TERN_PANE_DIR, so the selected mode is
  // handed to the subject through its OWN run directory (one mode per run).
  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode })}\n`)
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary file for this qualification lane')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern@0\.2\.0'/u.test(lock) ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  const manifest = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  const dshPin = manifest.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = manifest.devDependencies?.['@deepseek-ai/dsh-session']
  const dshMode = readJson(join(h.repo, 'test', 'compat', 'dsh-mode.json'))?.mode ?? 'UNVERIFIED'
  const ternBytes = readFileSync(ternBin)
  const ternSha256 = createHash('sha256').update(ternBytes).digest('hex')
  const extra = { mode, tern: ternVersion, sdk: { pin: sdkPin, integrity }, dsh: { pin: dshPin, mode: dshMode } }

  h.check('the exact DSH npm baseline is resolved from this repository and matched by the Session package',
    dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin && dshMode === 'npm', JSON.stringify({ dshPin, dshSessionPin, dshMode }))

  // ── baseline and bootstrap ──
  await h.resize(1280, 800)
  h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance for the baseline', h.ctl('state').theme === 'dark')
  const subject = join(h.repo, 'scripts', 'tern-pane-transcript-modes-subject.mts')
  h.check('the production Direct/TSP subject launches in the real Tern pane', await h.launch(subject))
  if (!await requiredWait(h, 'the official Direct fixture and the production renderer are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true && entry.mode === mode)
    && records(h).some(entry => entry.kind === 'surface.inline.opened')
    && h.classNodes(h.snapshot(), 'sf-region').length > 0, { limit: 400 })) {
    finish(h, extra)
    return
  }

  const hello = wireRecords(h).find(entry => entry.dir === 'in' && entry.verb === 'r' && entry.body?.r === 'hello')
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  writeLedger(h, 'environment.json', {
    mode,
    tern: ternVersion,
    ternBinary: { path: ternBin, sha256: ternSha256, bytes: ternBytes.length },
    ternTopology: 'one headless tern serve --control pane, ONE inline TSP Surface, main/dock/layer regions',
    host: { os: `${type()} ${release()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'UNVERIFIED', cores: cpus().length },
    sdk: { pin: sdkPin, integrity },
    dsh: { mode: dshMode, cliPin: dshPin, agentPin: dshPin, sessionPin: dshSessionPin },
    hello: {
      ver: hello?.body?.ver, term: hello?.body?.term, kinds: hello?.body?.kinds,
      features: hello?.body?.features, credits: hello?.body?.credits, cell: hello?.body?.cell, dark: hello?.body?.dark,
    },
    workRoot: subjectReady?.workRoot,
    session: subjectReady?.session,
    viewport: h.ctl('stats').viewport,
    input: 'CONTROL_INJECTED (tern ctl type|key|click), each delivered exactly once and never retried',
    rendererOptIn: 'DSH_PI_TUI_RENDERER=tsp through the official Direct fixture (externalTern); PiTui stays the product default',
    modeAuthority: 'tuiConfig.displayPreset -> resolveDisplayPreset -> the ONE DisplayState -> productionTspConnector -> mountTspRenderer',
    notVerified: ['physical GUI window / OS chrome / desktop font stack', 'OS clipboard, IME, wheel/trackpad', 'Owner G8 visual acceptance', 'FOCUS_TSP_NOT_YET_IMPLEMENTED'],
  })
  h.check('the real client reports its own handshake for THIS run', hello?.body?.ver === '0.9.12' && Array.isArray(hello?.body?.kinds), JSON.stringify({ ver: hello?.body?.ver, kinds: hello?.body?.kinds?.length }))
  h.check('the run opened exactly ONE production inline Surface', openedSurfaces(h).length === 1 && openedSurfaces(h)[0].mode === 'inline', JSON.stringify(openedSurfaces(h)))
  h.check('the client paints the three production regions', ['sf-main', 'sf-dock', 'sf-layer'].every(name => regionNode(h.snapshot(), name) !== undefined))

  // ── the real submit: composer → writer → Agent turn → real Tool → Main ──
  const testInput = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  h.check('the subject mode and this flow mode are the same run', testInput.mode === mode, JSON.stringify({ subject: testInput.mode, flow: mode }))
  const prompt = testInput.prompts[0].text
  const marker = testInput.prompts[0].marker
  const answerMarker = testInput.assistantMarker

  const settledBefore = records(h).filter(entry => entry.kind === 'producer.writer.settled').length
  h.check('no prompt was written before the gesture', settledBefore === 0, String(settledBefore))
  h.check('the answer text is absent before the submit', !mainText(h).includes(answerMarker))
  await submit(h, prompt)
  if (!await requiredWait(h, 'the real Direct writer settled exactly one prompt', () =>
    records(h).filter(entry => entry.kind === 'producer.writer.settled').length === 1, { limit: 400 })) {
    finish(h, extra)
    return
  }
  const settled = records(h).find(entry => entry.kind === 'producer.writer.settled')
  h.check('the settled write is the production queue outcome', settled?.outcomeKind === 'committed' && settled?.mode === 'queue', JSON.stringify(settled))
  if (!await requiredWait(h, 'the scripted assistant answer reached the real client Main', () => mainText(h).includes(answerMarker), { limit: 400 })) {
    finish(h, extra)
    return
  }
  h.check('the SDK acknowledged the production frames', ackEvents(h).length > 0 && ackEvents(h).every(entry => entry.body?.sf === openedSurfaces(h)[0]?.id), JSON.stringify({ acks: ackEvents(h).length }))
  h.check('no client protocol error was reported for this run', !records(h).some(entry => entry.kind === 'sdk.error'), JSON.stringify(records(h).filter(entry => entry.kind === 'sdk.error')))

  let live = foldLive(h)
  const userRows = [...live.keys()].filter(id => ROW_ID.test(id) && subtreeText(live, id).includes(marker))
  h.check('the submitted prompt is a real top-level Main row on the wire', userRows.length === 1, JSON.stringify(userRows))
  const answerRows = [...live.keys()].filter(id => ROW_ID.test(id) && subtreeText(live, id).includes(answerMarker))
  h.check('the assistant answer is its own top-level Main row', answerRows.length >= 1, JSON.stringify(answerRows))
  const promptRow = clientRow(h.snapshot(), marker)
  h.check('the prompt row is really visible inside the Main region (ancestor clipping)', promptRow?.containedXY === true, JSON.stringify(promptRow?.rect ?? null))
  const answerRow = clientRow(h.snapshot(), answerMarker)
  h.check('the answer row is really visible inside the Main region', answerRow?.containedXY === true, JSON.stringify(answerRow?.rect ?? null))
  h.measure('frame correlation at the settled answer', JSON.stringify({ frameSeq: latestFrameSeq(h), userRows, answerRows }))

  const workIds = [...live.keys()].filter(id => WORK_ID.test(id))
  const toolIds = [...live.entries()].filter(([, node]) => node.k === 'tool').map(([id]) => id)

  if (mode === 'compact') {
    // ── Compact: one native Activity per canonical Work, collapsed by default ──
    h.check('Compact produced at least one native collapsible Activity root', workIds.length >= 1, JSON.stringify(workIds))
    h.check('every Activity root is collapsible and collapsed by default',
      workIds.every(id => live.get(id)?.p.collapsible === true && live.get(id)?.p.collapsed === true),
      JSON.stringify(workIds.map(id => ({ id, p: live.get(id)?.p }))))
    h.check('a collapsed Activity builds NO Tool node on the wire', toolIds.length === 0, JSON.stringify(toolIds))
    const headerText = subtreeText(live, workIds[0])
    h.check('the Activity header reports the real span action stats', /Activity|Thought/u.test(headerText) && /job_list ×1/u.test(headerText), headerText)
    h.check('the Activity header paints no fabricated zero duration or token count', !/\b0s\b/u.test(headerText) && !/tokens?/iu.test(headerText), headerText)
    const headerSnap = h.snapshot()
    const clientHeader = mainNodes(headerSnap).find(node => /Activity|Thought/u.test(String(node.text ?? '')))
    h.check('the Activity header is really visible in the client Main', clientHeader !== undefined && containedXY(headerSnap.chains, clientHeader), JSON.stringify(clientHeader?.rect ?? null))
    h.check('the assistant answer stays OUTSIDE the Activity in the client Main', mainText(h).includes(answerMarker))
    const collapsedShot = h.capture(`compact-collapsed-1280x800-dark`, 'the settled Compact turn with its collapsed Activity')

    // ── the REAL pointer toggle: click the visible header, read the client event ──
    const togglesBefore = records(h).filter(entry => entry.kind === 'client.toggle').length
    const snap = h.snapshot()
    const target = mainNodes(snap).find(node => /Activity|Thought/u.test(String(node.text ?? '')))
    h.check('a real visible Activity header fragment exists to click', target !== undefined)
    if (target !== undefined) {
      const clicked = await h.click(snap.chains, target)
      h.check('the control-injected pointer click landed on the visible header fragment', clicked)
      const gotToggle = await requiredWait(h, 'the real client sent its own toggle event for the Activity', () =>
        records(h).filter(entry => entry.kind === 'client.toggle').length > togglesBefore, { limit: 200 })
      const toggle = records(h).filter(entry => entry.kind === 'client.toggle').at(-1)
      h.check('the client toggle addresses the current Activity node and asks to expand',
        gotToggle && toggle?.id === workIds[0] && toggle?.collapsed === false, JSON.stringify(toggle ?? null))
      if (!await requiredWait(h, 'the expanded Work Tool body reaches the wire', () =>
        [...foldLive(h).entries()].some(([, node]) => node.k === 'tool'), { limit: 200 })) {
        finish(h, extra)
        return
      }
      live = foldLive(h)
      const expandedToolIds = [...live.entries()].filter(([, node]) => node.k === 'tool').map(([id]) => id)
      h.check('the revealed Tool node is a CHILD of the clicked Activity', expandedToolIds.some(id => id.startsWith(`${workIds[0]}.`)), JSON.stringify(expandedToolIds))
      h.check('the Activity root now reports expanded', live.get(workIds[0])?.p.collapsed === false, JSON.stringify(live.get(workIds[0])?.p))
      const bodyText = subtreeText(live, workIds[0])
      h.check('the expanded Activity shows its own real Tool identity', /job_list|List background jobs/iu.test(bodyText), bodyText.slice(0, 240))
      h.check('the independent Assistant answer is still readable after expansion', mainText(h).includes(answerMarker))
      h.capture('compact-expanded-1280x800-dark', 'the same Activity opened by a real pointer click')

      // ── click again: the same Work collapses, the Tool body retires ──
      const snap2 = h.snapshot()
      const target2 = mainNodes(snap2).find(node => /Activity|Thought/u.test(String(node.text ?? '')))
      h.check('the expanded header is still a visible click target', target2 !== undefined)
      if (target2 !== undefined) {
        const togglesBeforeCollapse = records(h).filter(entry => entry.kind === 'client.toggle').length
        h.check('the second real click landed', await h.click(snap2.chains, target2))
        await requiredWait(h, 'the client sent the collapse toggle', () =>
          records(h).filter(entry => entry.kind === 'client.toggle').length > togglesBeforeCollapse, { limit: 200 })
        const collapseToggle = records(h).filter(entry => entry.kind === 'client.toggle').at(-1)
        h.check('the collapse toggle reports the collapsed target state', collapseToggle?.collapsed === true, JSON.stringify(collapseToggle ?? null))
        await requiredWait(h, 'the collapsed Work retires its Tool node', () =>
          ![...foldLive(h).entries()].some(([, node]) => node.k === 'tool'), { limit: 200 })
        h.check('the Activity root is collapsed again', foldLive(h).get(workIds[0])?.p.collapsed === true)
        h.check('the Assistant answer survives the collapse', mainText(h).includes(answerMarker))
        h.capture('compact-recollapsed-1280x800-dark', 'the same Work collapsed again by a real pointer click')
      }
    }
    writeLedger(h, 'work-toggle.json', {
      workIds,
      toggles: records(h).filter(entry => entry.kind === 'client.toggle'),
      collapsedCapture: collapsedShot,
      input: 'CONTROL_INJECTED pointer click on the visible native section header; no synthetic toggle event was injected',
    })
  } else {
    // ── Full: no Work/Activity chrome, the real Tool row stays flat ──
    h.check('Full paints NO Work/Activity container on the wire', workIds.length === 0, JSON.stringify(workIds))
    h.check('Full keeps the real Tool row in the reading flow', toolIds.length >= 1, JSON.stringify(toolIds))
    h.check('the Tool row is a top-level scoped Main node, not a Work child',
      toolIds.every(id => ROW_ID.test(id)), JSON.stringify(toolIds))
    h.check('no collapsible Activity section exists in Full',
      ![...live.values()].some(node => node.k === 'section' && node.p.collapsible === true))
    h.check('the client Main shows no Activity/Thought header', !/Activity ·|Thought ·/u.test(mainText(h)), mainText(h).slice(0, 200))
    h.check('the real Tool identity is readable in the client Main', /job_list|List background jobs/iu.test(mainText(h)), mainText(h).slice(0, 240))
    h.check('the independent Assistant answer is readable in Full', mainText(h).includes(answerMarker))
    h.capture('full-flat-1280x800-dark', 'the settled Full turn with flat native Tool and Assistant rows')
  }

  // ── a second FORMAL commit through the same Presenter keeps the mode ──
  await runCase(h, 'reproject')
  await requiredWait(h, 'the re-projected frame reaches the client', () => latestFrameSeq(h) !== null, { limit: 200 })
  live = foldLive(h)
  if (mode === 'compact') {
    h.check('the re-projected Compact frame still owns its Activity root', [...live.keys()].some(id => WORK_ID.test(id)))
  } else {
    h.check('the re-projected Full frame still has no Activity root', ![...live.keys()].some(id => WORK_ID.test(id)))
  }
  h.check('the re-projected frame keeps the Assistant answer', mainText(h).includes(answerMarker))

  // ── the viewport × appearance matrix ──
  const matrix = []
  for (const viewport of VIEWPORTS) {
    await h.resize(viewport.width, viewport.height)
    h.send('appearance', viewport.appearance)
    const theme = h.ctl('state').theme
    h.check(`the client resolved the ${viewport.appearance} appearance at ${viewport.width}x${viewport.height}`, theme === viewport.appearance, String(theme))
    const id = h.capture(`modes-${mode}-${viewport.width}x${viewport.height}-${viewport.appearance}`, `${mode} transcript at ${viewport.width}x${viewport.height} in ${viewport.appearance}`)
    const snapshot = h.snapshot()
    const answer = clientRow(snapshot, answerMarker)
    const composer = regionNode(snapshot, 'sf-dock')
    h.check(`the Dock/Composer still exists at ${viewport.width}x${viewport.height}`, composer !== undefined && rect(composer)[3] > 0, JSON.stringify(composer?.rect ?? null))
    const entry = {
      id, viewport: [viewport.width, viewport.height], appearance: viewport.appearance, theme,
      actualViewport: h.ctl('stats').viewport,
      answer: answer === undefined ? null : { rect: answer.rect, containedXY: answer.containedXY, visibleSpanY: answer.visibleSpanY },
      mainRect: regionNode(snapshot, 'sf-main')?.rect ?? null,
    }
    matrix.push(entry)
    // The answer may legitimately scroll out of a short window; that is a
    // MEASUREMENT, never a silently relaxed assertion.
    if (answer !== undefined) h.measure(`answer visibility at ${viewport.width}x${viewport.height}`, JSON.stringify(entry.answer))
    else h.measure(`answer not in the tree at ${viewport.width}x${viewport.height}`, 'the client scrolled it out; the Main region and Dock are still measured')
  }
  writeLedger(h, 'viewport-matrix.json', matrix)

  // ── ordered teardown and evidence completeness ──
  await submit(h, '/exit')
  await requiredWait(h, 'the production application exited through its own owner', () =>
    records(h).some(entry => entry.kind === 'app.exit') || records(h).some(entry => entry.kind === 'fixture.settled'), { limit: 300 })
  const captures = matrix.map(entry => entry.id)
  for (const id of captures) {
    const tree = existsSync(join(h.root, `${id}.tree.json`))
    const png = existsSync(join(h.root, 'shots', 'serve', `${id}.png`))
    const layoutPath = join(h.root, 'shots', 'serve', `${id}.layout.json`)
    const layout = existsSync(layoutPath) ? readJson(layoutPath) : undefined
    h.check(`capture ${id} kept a non-empty tree, PNG and resolved theme`,
      tree && png && readFileSync(join(h.root, `${id}.tree.json`), 'utf8').length > 20
      && layout !== undefined && ['light', 'dark'].includes(layout.theme),
      JSON.stringify({ tree, png, theme: layout?.theme }))
  }
  writeLedger(h, 'mode-evidence.json', {
    mode,
    frameSeq: latestFrameSeq(h),
    ackCount: ackEvents(h).length,
    surfaces: openedSurfaces(h),
    workIds: [...foldLive(h).keys()].filter(id => WORK_ID.test(id)),
    clientToggles: records(h).filter(entry => entry.kind === 'client.toggle'),
    commits: records(h).filter(entry => entry.kind === 'display.setTranscript').length,
    notVerified: ['physical GUI / OS input / IME / clipboard', 'Owner G8', 'Focus TSP projection'],
  })
  finish(h, extra)
}
