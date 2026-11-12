/**
 * T3-0B REAL-TERN card-disclosure flow.
 *
 * The SAME production Direct/TSP subject (`tern-pane-transcript-modes-subject.mts`,
 * scenario `card-disclosure`) runs inside a real `tern serve` pane (headless
 * lane) or a real Tern GUI window (same flow, GUI driver). The scenario
 * appends REAL official SessionEvents through the live Direct Session writer:
 * Command run/done (success, late error, done-only fragment), Compaction
 * start/summary/end (success, failure, fused manual `/compact`), real
 * tool/call + tool/result pairs for the folded Tool families, and real
 * injected Context sources (notice/recall/relay/unknown).
 *
 * This flow drives the native Section/Tool heads with control-injected
 * pointer/key input and asserts the SDK's own `toggle(sf,id,collapsed)` plus
 * the wire tree before/after. It never opens a card by injecting a boolean.
 *
 * Evidence tier: `REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT` or
 * `REAL_TERN_GUI + CONTROL_INJECTED_INPUT`. Physical OS input, IME, wheel and
 * the OS screen-reader bridge are NOT_VERIFIED.
 * @module scripts/tern-pane-transcript-card-disclosure
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release as osRelease, type } from 'node:os'
import { join } from 'node:path'
import { fullyVisible, rect, visibleBox, visibleSpan } from './tern-pane-geometry.mjs'

const PRESETS = ['full', 'compact', 'focus']
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]

export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_CARD_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) {
    throw new Error(`TERN_TRANSCRIPT_CARD_PRESET must be full, compact or focus; got ${preset}`)
  }
  return preset
}

export function isTargetToggle(event, id, collapsed) {
  return (event?.ev === 'toggle' || event?.kind === 'client.toggle')
    && event.id === id && event.collapsed === collapsed
}

export function cardDisclosureEvidenceTier(gui) {
  return gui ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT' : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT'
}

export function qualificationFromResults(results, pass = 'REAL_TERN_CARD_DISCLOSURE_PASS') {
  const checks = results.filter(result => result.informational !== true)
  return checks.length === 0 || results.some(result => result.ok !== true) ? 'FAILED_ASSERTIONS' : pass
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function writeLedger(h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
}

function finish(h, extra = {}) {
  const { qualification: outcome, ...metadata } = extra
  const qualification = qualificationFromResults(h.results, outcome ?? 'REAL_TERN_CARD_DISCLOSURE_PASS')
  const status = h.finish({
    ...metadata,
    ...(outcome === undefined || outcome === qualification ? {} : { qualificationDetail: outcome }),
    qualification,
  })
  if (status !== 0) process.exitCode = status
}

const records = h => readJsonl(join(h.root, 'events.jsonl'))
const wire = h => readJsonl(join(h.root, 'sdk-wire.jsonl'))

/** The CURRENT wire tree folded from the SDK's own `f` ops. */
function foldLive(h) {
  const nodes = new Map()
  const insert = node => {
    if (node === undefined || node === null || typeof node.id !== 'string') return
    const entry = nodes.get(node.id) ?? { id: node.id, k: node.k, p: {}, children: [] }
    entry.k = node.k
    entry.p = { ...entry.p, ...(node.p ?? {}) }
    entry.children = (node.c ?? []).map(child => child.id).filter(Boolean)
    nodes.set(node.id, entry)
    for (const child of node.c ?? []) insert(child)
  }
  const drop = id => {
    for (const key of [...nodes.keys()]) if (key === id || key.startsWith(`${id}.`)) nodes.delete(key)
  }
  for (const entry of wire(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') {
        drop(op[1])
        insert(op[4])
      } else if (op[0] === 'del') drop(op[1])
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          const next = { ...node.p }
          for (const [key, value] of Object.entries(op[2] ?? {})) {
            if (value === null) delete next[key]
            else next[key] = value
          }
          node.p = next
        }
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          node.p.text = op[2] === 'append'
            ? `${String(node.p.text ?? '')}${String(op[3] ?? '')}` : String(op[3] ?? '')
        }
      }
    }
  }
  return nodes
}

function subtreeText(nodes, id) {
  const out = []
  const visit = currentId => {
    const node = nodes.get(currentId)
    if (node === undefined) return
    if (typeof node.p.text === 'string') out.push(node.p.text)
    if (typeof node.p.head === 'string') out.push(node.p.head)
    for (const child of node.children) visit(child)
  }
  visit(id)
  return out.join(' ')
}

const mainRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const mainNodes = snapshot => {
  const root = mainRegion(snapshot)
  if (root === undefined) return []
  const out = []
  const visit = node => {
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return out.filter(node => rect(node)[2] > 0 || rect(node)[3] > 0)
}
const hasClass = (node, name) => String(node.class ?? '').split(/\s+/u).includes(name)
const sectionHeadNodes = snapshot => mainNodes(snapshot).filter(node => hasClass(node, 'sf-section-head'))
const toolHeadNodes = snapshot => mainNodes(snapshot).filter(node => hasClass(node, 'sf-tool-head'))

async function waitUntil(h, label, predicate, limit = 240) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  h.check(label, false, JSON.stringify({ visible: h.texts(h.snapshot()).slice(-14), ids: [...foldLive(h).keys()].slice(-14) }))
  return false
}

async function runCase(h, kind) {
  const seq = Number(readJson(join(h.root, 'case-seq.json'))?.seq ?? 0) + 1
  writeFileSync(join(h.root, 'case-seq.json'), `${JSON.stringify({ seq })}\n`)
  const target = join(h.root, 'case.json')
  writeFileSync(`${target}.tmp`, `${JSON.stringify({ seq, kind })}\n`)
  const { renameSync } = await import('node:fs')
  renameSync(`${target}.tmp`, target)
  const ok = await waitUntil(h, `the Direct subject completed ${kind}`, () => readJson(join(h.root, 'case-result.json'))?.seq === seq)
  const result = readJson(join(h.root, 'case-result.json'))
  h.check(`the subject handled ${kind}`, ok && result?.status === 'ok', JSON.stringify(result ?? null))
  return result
}

/** Bring one native head into the real client's viewport (real wheel scroll,
 *  never a synthetic coordinate claim). The wheel direction is learned from
 *  the client's own movement: a fixed assumption about dy sign produced an
 *  oscillating page-key loop on this build. */
async function revealHead(h, label, findHead) {
  const viewport = () => h.ctl('stats').viewport ?? [1280, 800]
  let wheelSign = 1
  let step = 80
  let lastY
  for (let attempt = 0; attempt < 26; attempt += 1) {
    const snapshot = h.snapshot()
    const head = findHead(snapshot)
    if (head === undefined) return undefined
    const texts = snapshot.nodes.filter(node => snapshot.chains.get(node)?.includes(head)
      && typeof node.text === 'string' && node.text !== '')
    const main = mainRegion(snapshot)
    const dock = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-dock'))
    const dockRect = rect(dock ?? {})
    const dockOverlap = texts.some(node => {
      if (dock === undefined) return false
      const box = visibleBox(snapshot.chains, node)
      return box.start.x < dockRect[0] + dockRect[2] && box.start.x + box.span.x > dockRect[0]
        && box.start.y < dockRect[1] + dockRect[3] && box.start.y + box.span.y > dockRect[1]
    })
    const bodyVisible = texts.length > 0 && texts.every(node => fullyVisible(snapshot.chains, node)) && !dockOverlap
    const clickable = visibleSpan(snapshot.chains, head, 'x') >= 4 && visibleSpan(snapshot.chains, head, 'y') >= 4
    if (bodyVisible && clickable) {
      // The client owns smooth scrolling: after a real scroll the next frame
      // can still be in flight, and clicking the stale coordinate would land
      // on whatever moved under it. Re-find the SAME head on a settled frame.
      await h.sleep(300)
      const stable = h.snapshot()
      const stableHead = findHead(stable)
      if (stableHead === undefined) return undefined
      const stableTexts = stable.nodes.filter(node => stable.chains.get(node)?.includes(stableHead)
        && typeof node.text === 'string' && node.text !== '')
      const stableVisible = stableTexts.length > 0 && stableTexts.every(node => fullyVisible(stable.chains, node))
      const stableClickable = visibleSpan(stable.chains, stableHead, 'x') >= 4
        && visibleSpan(stable.chains, stableHead, 'y') >= 4
      if (stableVisible && stableClickable) return { snapshot: stable, head: stableHead }
      continue
    }
    if (main === undefined) return undefined
    const mainRect = rect(main)
    const headRect = rect(head)
    // `sf-main` is the CONTENT box (it can sit entirely above the viewport
    // after the client follows the latest row), so its own rect is not a
    // pointer target. Use the real viewport and the Dock top instead.
    const [viewportWidth, viewportHeight] = viewport()
    const visibleTop = 24
    const visibleBottom = dock === undefined ? viewportHeight - 8 : dockRect[1] - 8
    const wantIncrease = headRect[1] < visibleTop
    const point = {
      x: Math.max(1, Math.min(viewportWidth - 1, viewportWidth / 2)),
      y: Math.max(visibleTop + 12, Math.min(visibleBottom - 12, (visibleTop + visibleBottom) / 2)),
    }
    const beforeY = headRect[1]
    h.send('move', point.x, point.y)
    h.send('wheel', 0, wheelSign * step)
    await h.sleep(160)
    const after = h.snapshot()
    const afterHead = findHead(after)
    const afterY = afterHead === undefined ? undefined : rect(afterHead)[1]
    if (afterY === undefined || lastY === afterY) {
      // A wheel dy sign that did not move the content: flip the learned sign.
      wheelSign = -wheelSign
    } else {
      const movedDown = afterY > beforeY
      if (movedDown !== wantIncrease) {
        wheelSign = -wheelSign
        step = Math.max(8, Math.floor(step / 2))
      } else if ((beforeY < visibleTop && afterY > visibleBottom)
        || (beforeY + headRect[3] > visibleBottom && afterY + headRect[3] < visibleTop)) {
        // The step jumped over the small viewport: halve it and come back.
        step = Math.max(8, Math.floor(step / 2))
      }
    }
    lastY = afterY
    h.measure(`${label} real wheel scroll`, JSON.stringify({
      point, sign: wheelSign, step, wantIncrease, beforeY, afterY,
      viewport: [viewportWidth, viewportHeight], visibleBottom, head: headRect,
    }))
  }
  const snapshot = h.snapshot()
  const head = findHead(snapshot)
  return head === undefined ? undefined : { snapshot, head }
}

async function clickToggle(h, witness, targetId, expectedCollapsed, label) {
  const before = records(h).filter(entry => entry.kind === 'client.toggle').length
  h.check(`${label}: native head has a visible clickable fragment`, witness !== undefined
    && visibleSpan(witness.snapshot.chains, witness.head, 'x') >= 4
    && visibleSpan(witness.snapshot.chains, witness.head, 'y') >= 4,
  JSON.stringify(witness === undefined ? null : { rect: rect(witness.head), x: visibleSpan(witness.snapshot.chains, witness.head, 'x') }))
  if (witness === undefined) return false
  h.check(`${label}: one control-injected client click lands`, await h.click(witness.snapshot.chains, witness.head), JSON.stringify(rect(witness.head)))
  const received = await waitUntil(h, `${label}: client toggle reaches the Session iterator`,
    () => records(h).filter(entry => entry.kind === 'client.toggle').length > before, 100)
  const event = records(h).filter(entry => entry.kind === 'client.toggle').at(-1)
  h.check(`${label}: the client toggle names the exact SDK node and target state`,
    received && isTargetToggle(event, targetId, expectedCollapsed),
    JSON.stringify({ expected: { id: targetId, collapsed: expectedCollapsed }, event: event ?? null }))
  return true
}

const sectionByText = (snapshot, h, text) => sectionHeadNodes(snapshot)
  .find(node => h.descendantsText(node).includes(text))
const toolByText = (snapshot, h, text) => toolHeadNodes(snapshot)
  .find(node => h.descendantsText(node).includes(text))

function findSectionNode(h, text) {
  return [...foldLive(h).values()].find(node => node.k === 'section' && subtreeText(foldLive(h), node.id).includes(text))
}

function findToolNode(h, name) {
  return [...foldLive(h).values()].find(node => node.k === 'tool' && node.p.name === name)
}

function bodyPresent(h, node, bodyKey = 'body') {
  return foldLive(h).has(`${node.id}.${bodyKey}`)
}

/** Open the canonical pre-card parents so the synthetic turn's tool/context
 *  members are materialized. A collapsed section is matched by its OWN head
 *  text (several Activity spans exist), never by the shared word "Activity". */
async function openCardParents(h, preset) {
  if (preset === 'full') return
  for (let round = 0; round < 6; round += 1) {
    const live = foldLive(h)
    const candidates = [...live.values()].filter(node => node.k === 'section'
      && node.p.collapsible === true && node.p.collapsed === true
      && (preset === 'focus'
        ? String(node.p.key).includes('focus-') || String(node.p.key).includes('work-')
        : String(node.p.key).includes('work-')))
    if (candidates.length === 0) return
    // Focus roots first, then the LAST Work span the synthetic turn added.
    const root = candidates.find(node => String(node.p.key).includes('focus-'))
    const target = root ?? candidates.at(-1)
    const headNode = live.get(`${target.id}.head`)
    const headText = subtreeText(live, headNode?.id ?? target.id)
    const marker = headText.slice(0, 64)
    const witness = await revealHead(h, `${preset} parent`,
      snapshot => sectionHeadNodes(snapshot).find(node => h.descendantsText(node).includes(marker)))
    if (witness === undefined) return
    await clickToggle(h, witness, target.id, false, `${preset} parent ${marker.slice(0, 24)}`)
    const opened = await waitUntil(h, `${preset} parent ${marker.slice(0, 24)} opens`,
      () => foldLive(h).get(target.id)?.p.collapsed === false)
    if (!opened) return
  }
}

export default async function (h) {
  const preset = presetFromEnvironment()
  const gui = process.env.TERN_CARD_DISCLOSURE_GUI === '1'
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary for this qualification')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const ternSha256 = createHash('sha256').update(readFileSync(ternBin)).digest('hex')
  const repo = h.repo
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const lock = readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8')
  const dshMode = JSON.parse(readFileSync(join(repo, 'test/compat/dsh-mode.json'), 'utf8')).mode
  const dshPin = manifest.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = manifest.devDependencies?.['@deepseek-ai/dsh-session']
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1]
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const subject = join(repo, 'scripts', 'tern-pane-transcript-modes-subject.mts')
  const extra = { preset, tern: ternVersion, sdk: '0.2.0', dsh: dshPin, sourceSnapshot: head }
  writeLedger(h, 'environment.json', {
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    host: { node: process.version, os: `${type()} ${osRelease()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    display: process.env.DISPLAY ?? null,
    preset,
    evidenceTier: cardDisclosureEvidenceTier(gui),
    sourceSnapshot: head,
  })
  h.check('the worktree uses npm DSH 0.2.2-rc.1 for Agent and Session',
    dshMode === 'npm' && dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin,
    JSON.stringify({ dshMode, dshPin, dshSessionPin }))
  h.check('the locked Tern SDK is 0.2.0 with recorded integrity', sdkIntegrity !== undefined, String(sdkIntegrity))
  if (dshMode !== 'npm' || dshPin !== '0.2.2-rc.1' || dshSessionPin !== dshPin || sdkIntegrity === undefined) {
    finish(h, { ...extra, codeEvidenceOnly: true, qualification: 'NOT_RUN_BASELINE_MISMATCH' })
    return
  }
  if (gui) {
    const system = h.ctl('system')
    h.check('this lane is a REAL native window on a REAL display',
      (system.displays ?? []).length > 0 && typeof system.title === 'string',
      JSON.stringify({ title: system.title, displays: system.displays }))
  }
  const initial = await h.resize(1280, 800)
  if (gui) h.check('the real GUI window accepted 1280x800 without clamp', initial.clamped === false, JSON.stringify(initial))
  if (gui) {
    if (h.ctl('state').theme !== 'dark') h.send('plugins', 'run', 'appearance:dark')
  } else h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark', String(h.ctl('state').theme))

  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario: 'card-disclosure' })}\n`)
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct card-disclosure Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'card-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
      && records(h).some(row => row.kind === 'fixture.ready'
        && row.scenario === 'card-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'MOUNT_NOT_READY' })
    return
  }
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
  h.check('the client negotiated Section and Tool nodes',
    hello?.kinds?.includes('section') && hello?.kinds?.includes('tool'), JSON.stringify(hello?.kinds))

  const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const prompt = prompts.prompts[0]
  h.check('the deterministic prompt marker is absent before the submit gesture',
    !h.texts(h.snapshot()).some(text => text.includes(prompt.marker)))
  h.send('type', JSON.stringify(prompt.text))
  await h.key('Return', 600)
  if (!await waitUntil(h, 'the production Direct writer settled exactly one prompt', () =>
    records(h).filter(row => row.kind === 'producer.writer.settled').length === 1)) {
    finish(h, { ...extra, qualification: 'DIRECT_WRITE_NOT_SETTLED' })
    return
  }
  if (!await waitUntil(h, 'the first real turn settles before the card scenario is appended', () =>
    h.texts(h.snapshot()).some(text => text.includes(prompts.assistantMarker)))) {
    finish(h, { ...extra, qualification: 'FIRST_TURN_NOT_MATERIALIZED' })
    return
  }
  const appended = await runCase(h, 'card-disclosure')
  if (appended?.status !== 'ok') { finish(h, { ...extra, qualification: 'CARD_EVENTS_NOT_ADDED' }); return }

  // The first Command Section is the canonical settled success.
  if (!await waitUntil(h, 'the routed Command Section reaches the current Main', () =>
    [...foldLive(h).values()].some(node => node.k === 'section' && subtreeText(foldLive(h), node.id).includes('/status --short')))) {
    finish(h, { ...extra, qualification: 'COMMAND_NOT_MATERIALIZED' })
    return
  }
  const command = findSectionNode(h, '/status --short')
  h.check('the settled Command starts independently collapsed with its bounded preview',
    command?.p.collapsible === true && command.p.collapsed === true
      && subtreeText(foldLive(h), command.id).includes('session healthy')
      && !foldLive(h).has(`${command.id}.body`),
    JSON.stringify(command ?? null))
  const commandWitness = await revealHead(h, 'settled Command', snapshot => sectionByText(snapshot, h, '/status --short'))
  h.capture(`${preset}-command-closed-1280x800-dark`, 'the real routed Command Section while closed')
  await clickToggle(h, commandWitness, command.id, false, 'settled Command')
  if (!await waitUntil(h, 'the exact Command body materializes', () => {
    const body = foldLive(h).get(`${command.id}.body`)
    return body !== undefined && subtreeText(foldLive(h), body.id).includes('session healthy')
  })) {
    finish(h, { ...extra, qualification: 'COMMAND_BODY_NOT_OPEN' })
    return
  }
  h.capture(`${preset}-command-open-1280x800-dark`, 'the same Command Section with its complete result body')
  await runCase(h, 'reproject')
  h.check('same-source reproject keeps the open Command owner and body',
    foldLive(h).get(command.id)?.p.collapsed === false && foldLive(h).has(`${command.id}.body`),
    JSON.stringify(foldLive(h).get(command.id) ?? null))
  await clickToggle(h, await revealHead(h, 'settled Command close', snapshot => sectionByText(snapshot, h, '/status --short')),
    command.id, true, 'settled Command close')
  if (!await waitUntil(h, 'closing the exact Command retires only its body', () => !foldLive(h).has(`${command.id}.body`))) {
    finish(h, { ...extra, qualification: 'COMMAND_BODY_NOT_CLOSED' })
    return
  }

  // The running Command is a static card; a late error turns it into a
  // Section with the failure reason in its bounded preview.
  if (!await waitUntil(h, 'the running Command stays a static card', () =>
    [...foldLive(h).values()].some(node => node.k === 'card' && subtreeText(foldLive(h), node.id).includes('/deploy production')))) {
    finish(h, { ...extra, qualification: 'RUNNING_COMMAND_NOT_STATIC' })
    return
  }
  const running = [...foldLive(h).values()].find(node => node.k === 'card'
    && subtreeText(foldLive(h), node.id).includes('/deploy production'))
  h.check('the running Command paints Running and no dead disclosure',
    running?.p.collapsible === undefined && subtreeText(foldLive(h), running.id).includes('Running'),
    JSON.stringify(running ?? null))
  h.capture(`${preset}-command-running-static-1280x800-dark`, 'the detail-less running Command static card')
  h.check('the late error settle is appended through the real Session writer', (await runCase(h, 'late-command-error'))?.status === 'ok')
  if (!await waitUntil(h, 'the same transcript row becomes a failed Command Section', () =>
    [...foldLive(h).values()].some(node => node.k === 'section'
      && subtreeText(foldLive(h), node.id).includes('/deploy production')
      && subtreeText(foldLive(h), node.id).includes('Error')))) {
    finish(h, { ...extra, qualification: 'LATE_COMMAND_ERROR_NOT_RENDERED' })
    return
  }
  const lateError = [...foldLive(h).values()].find(node => node.k === 'section'
    && subtreeText(foldLive(h), node.id).includes('/deploy production'))
  h.check('the failed Command keeps its reason readable while collapsed',
    subtreeText(foldLive(h), lateError.id).includes('deployment failed: permission denied')
      && lateError.p.collapsed === true && !foldLive(h).has(`${lateError.id}.body`),
    JSON.stringify(lateError ?? null))
  await clickToggle(h, await revealHead(h, 'failed Command',
    snapshot => sectionByText(snapshot, h, '/deploy production')), lateError.id, false, 'failed Command')
  if (!await waitUntil(h, 'the failed Command exposes its complete result', () =>
    foldLive(h).has(`${lateError.id}.body`))) {
    finish(h, { ...extra, qualification: 'FAILED_COMMAND_BODY_NOT_OPEN' })
    return
  }

  // Compaction: one settled success, one plain failure, one fused manual owner.
  if (!await waitUntil(h, 'the routed Compaction cards reach the Main', () =>
    [...foldLive(h).values()].some(node => node.k === 'section'
      && subtreeText(foldLive(h), node.id).includes('Context compacted'))
      && [...foldLive(h).values()].some(node => node.k === 'section'
        && subtreeText(foldLive(h), node.id).includes('Compaction failed')))) {
    finish(h, { ...extra, qualification: 'COMPACTION_NOT_MATERIALIZED' })
    return
  }
  const compaction = findSectionNode(h, 'Context compacted')
  h.check('the settled Compaction shows its counts and keeps the summary closed',
    subtreeText(foldLive(h), compaction.id).includes('Compacted 3 history items (~42 tokens)')
      && compaction.p.collapsed === true && !foldLive(h).has(`${compaction.id}.body`),
    JSON.stringify(compaction ?? null))
  await clickToggle(h, await revealHead(h, 'settled Compaction', snapshot => sectionByText(snapshot, h, 'Context compacted')),
    compaction.id, false, 'settled Compaction')
  if (!await waitUntil(h, 'the exact Compaction summary opens', () =>
    foldLive(h).has(`${compaction.id}.body`))) {
    finish(h, { ...extra, qualification: 'COMPACTION_BODY_NOT_OPEN' })
    return
  }
  h.capture(`${preset}-compaction-open-1280x800-dark`, 'the routed Compaction summary in the real client')
  const failed = [...foldLive(h).values()].find(node => node.k === 'section'
    && subtreeText(foldLive(h), node.id).includes('Compaction failed')
    && subtreeText(foldLive(h), node.id).includes('summarizer failed'))
  h.check('the failed Compaction keeps its producer reason readable while closed',
    failed !== undefined && failed.p.collapsed === true
      && subtreeText(foldLive(h), failed.id).includes('summarizer failed: upstream timeout after 120s'),
    JSON.stringify(failed ?? null))
  const manual = [...foldLive(h).values()].find(node => node.k === 'section'
    && subtreeText(foldLive(h), node.id).includes('/compact'))
  h.check('the fused manual /compact has exactly ONE visible Compaction owner',
    manual !== undefined && manual.p.collapsed === true
      && [...foldLive(h).values()].filter(node => node.k === 'section'
        && subtreeText(foldLive(h), node.id).includes('/compact')).length === 1,
    JSON.stringify(manual ?? null))
  h.check('the fused manual failure is recognized from the command error kind, not its empty text',
    manual !== undefined && subtreeText(foldLive(h), manual.id).includes('Compaction failed')
      && subtreeText(foldLive(h), manual.id).includes('Error'),
    JSON.stringify(manual ?? null))

  // Tool cards and standalone Context forms live under the preset parents.
  await openCardParents(h, preset)
  if (!await waitUntil(h, 'the routed Tool rows enter the current client tree', () =>
    [...foldLive(h).values()].some(node => node.k === 'tool' && node.p.name === 'read'))) {
    finish(h, { ...extra, qualification: 'TOOL_ROWS_NOT_MATERIALIZED' })
    return
  }
  const toolNotes = Object.fromEntries(['read', 'write', 'skill', 'read_image', 'update_goal', 'ask_user_question',
    'schedule_list', 'present_visual', 'bash', 'mystery_tool'].map(name => {
    const nodes = [...foldLive(h).values()].filter(node => node.k === 'tool' && node.p.name === name)
    return [name, nodes.map(node => node.p.note ?? null)]
  }))
  h.check('the folded Tool notes are the trusted one-line summaries',
    toolNotes.read.includes('2 lines')
      && toolNotes.read.some(note => typeof note === 'string' && note.startsWith('ENOENT'))
      && toolNotes.write[0] === 'Updated'
      && toolNotes.skill[0] === '2 lines of instructions'
      && toolNotes.read_image[0] === 'PNG image, 800x600 px, 1234 bytes'
      && toolNotes.update_goal[0] === 'phase active · revision 3 · 2/6 rounds'
      && toolNotes.ask_user_question[0] === '1/2 answered'
      && toolNotes.schedule_list[0] === 'no scheduled tasks'
      && toolNotes.present_visual[0] === 'Published 1 visual.'
      && toolNotes.bash[0] === 'line one'
      && toolNotes.mystery_tool.includes('human summary line')
      && toolNotes.mystery_tool.includes(null)
      && !JSON.stringify(toolNotes).includes('visual-published-v1')
      && !JSON.stringify(toolNotes).includes('"machine"'),
    JSON.stringify(toolNotes))
  const readTool = [...foldLive(h).values()].find(node => node.k === 'tool'
    && node.p.name === 'read' && node.p.note === '2 lines')
  h.check('the folded read Tool starts closed without its result body',
    readTool !== undefined && readTool.p.collapsed === true && !foldLive(h).has(`${readTool.id}.result`))
  await clickToggle(h, await revealHead(h, 'read Tool', snapshot => toolHeadNodes(snapshot).find(node => {
    const text = h.descendantsText(node)
    return text.includes('Read') && text.includes('src/example.ts')
  })), readTool.id, false, 'read Tool')
  if (!await waitUntil(h, 'the exact read Tool body materializes', () => foldLive(h).has(`${readTool.id}.result`))) {
    finish(h, { ...extra, qualification: 'TOOL_BODY_NOT_OPEN' })
    return
  }
  h.check('the opened read Tool renders the real envelope body',
    subtreeText(foldLive(h), `${readTool.id}.result`).includes('<path>src/example.ts</path>'),
    JSON.stringify(foldLive(h).get(`${readTool.id}.result`) ?? null))
  h.capture(`${preset}-tool-open-1280x800-dark`, 'the real read Tool body after its exact native toggle')

  for (const [label, text] of [
    ['Notice summary', 'Agent completed'],
    ['Recall identity', 'Session recall · prior session'],
    ['long Relay', 'Agent message · agent-long'],
    ['short Relay', 'Agent message · agent-short'],
    ['unknown Context', 'unknown context stays readable'],
  ]) {
    const node = [...foldLive(h).values()].find(entry => entry.k === 'section' && subtreeText(foldLive(h), entry.id).includes(text))
      ?? [...foldLive(h).values()].find(entry => entry.k === 'card' && subtreeText(foldLive(h), entry.id).includes(text))
    h.check(`the ${label} is materialized in the real client`, node !== undefined, JSON.stringify(node ?? null))
    if (node === undefined) { finish(h, { ...extra, qualification: 'CONTEXT_ROW_NOT_MATERIALIZED' }); return }
  }
  const notice = [...foldLive(h).values()].find(entry => entry.k === 'section'
    && subtreeText(foldLive(h), entry.id).includes('Agent completed'))
  h.check('the Notice keeps its complete multi-line producer summary in the native header',
    subtreeText(foldLive(h), notice.id).includes('第二行摘要') && notice.p.collapsed === true
      && !foldLive(h).has(`${notice.id}.body`),
    JSON.stringify(notice ?? null))
  const longRelay = [...foldLive(h).values()].find(entry => entry.k === 'section'
    && subtreeText(foldLive(h), entry.id).includes('Agent message · agent-long'))
  h.check('the long Relay shows First/Last preview and keeps the body closed',
    subtreeText(foldLive(h), longRelay.id).includes('First: relay line 1')
      && subtreeText(foldLive(h), longRelay.id).includes('Last: relay line 12')
      && longRelay.p.collapsed === true,
    JSON.stringify(longRelay ?? null))
  await clickToggle(h, await revealHead(h, 'long Relay', snapshot => sectionByText(snapshot, h, 'Agent message · agent-long')),
    longRelay.id, false, 'long Relay')
  if (!await waitUntil(h, 'the exact long Relay body opens', () => foldLive(h).has(`${longRelay.id}.body`))) {
    finish(h, { ...extra, qualification: 'RELAY_BODY_NOT_OPEN' })
    return
  }
  const shortRelay = [...foldLive(h).values()].find(entry => entry.k === 'card'
    && subtreeText(foldLive(h), entry.id).includes('relayed short body'))
  h.check('the short Relay stays directly readable with the official sender',
    shortRelay?.p.collapsible === undefined
      && subtreeText(foldLive(h), shortRelay.id).includes('Agent message · agent-short'),
    JSON.stringify(shortRelay ?? null))

  // Viewport matrix: the same native heads remain reachable and the details
  // stay scrollable; a clamped GUI request is a measurement, not a pass.
  const matrix = []
  for (const viewport of VIEWPORTS) {
    const resize = await h.resize(viewport.width, viewport.height)
    if (gui) {
      if (h.ctl('state').theme !== viewport.appearance) {
        h.send('plugins', 'run', viewport.appearance === 'light' ? 'appearance:light' : 'appearance:dark')
        await waitUntil(h, `${viewport.appearance} live-window appearance`, () => h.ctl('state').theme === viewport.appearance, 60)
      }
    } else h.send('appearance', viewport.appearance)
    const state = h.ctl('state')
    const stats = h.ctl('stats')
    const exact = stats.viewport?.[0] === viewport.width && stats.viewport?.[1] === viewport.height
    if (viewportsNeedAppearance(viewport, gui)) {
      h.check(`${viewport.width}x${viewport.height} uses ${viewport.appearance}`,
        state.theme === viewport.appearance, JSON.stringify({ viewport: stats.viewport, theme: state.theme }))
    }
    if (viewport.width === 1280 && viewport.height === 800) {
      matrix.push({ ...viewport, actual: stats.viewport, exact, theme: state.theme, capture: 'already captured' })
      continue
    }
    const witness = await revealHead(h, `${viewport.width}x${viewport.height} Command`,
      snapshot => sectionByText(snapshot, h, '/status --short'))
    const headVisible = witness !== undefined
      && visibleSpan(witness.snapshot.chains, witness.head, 'x') >= 4
      && visibleSpan(witness.snapshot.chains, witness.head, 'y') >= 4
    if (gui && !exact) {
      h.check(`${viewport.width}x${viewport.height}: the real window reports its clamp honestly`,
        state.theme === viewport.appearance || viewport.appearance === 'dark', JSON.stringify({ requested: resize, actual: stats.viewport }))
      h.measure(`${viewport.width}x${viewport.height}: clamped Command head`, JSON.stringify({ headVisible, actual: stats.viewport }))
    } else {
      h.check(`${viewport.width}x${viewport.height}: the Command head is reachable and the Dock keeps its seat`,
        headVisible && stats.viewport?.[0] === viewport.width && stats.viewport?.[1] === viewport.height,
        JSON.stringify({ head: witness === undefined ? null : rect(witness.head), viewport: stats.viewport, theme: state.theme }))
    }
    h.capture(`${preset}-command-${viewport.width}x${viewport.height}-${viewport.appearance}`,
      `the card disclosure stays readable at ${viewport.width}x${viewport.height} ${viewport.appearance}`)
    matrix.push({ ...viewport, actual: stats.viewport, exact, theme: state.theme, headVisible })
  }
  writeLedger(h, 'card-disclosure-viewport-matrix.json', matrix)
  writeLedger(h, 'card-disclosure.json', {
    sourceSnapshot: head,
    preset,
    evidenceTier: cardDisclosureEvidenceTier(gui),
    commandId: command.id,
    lateCommandId: lateError.id,
    compactionId: compaction.id,
    manualCompactionId: manual.id,
    readToolId: readTool.id,
    longRelayId: longRelay.id,
    toolNotes,
    viewportMatrix: matrix,
    provenance: 'live Direct Session writer -> official SessionEvents -> TranscriptFolder -> TSP mapper -> pinned Tern client -> control-injected native toggle',
    notVerified: ['OS physical keyboard/IME/wheel', 'G8 Owner visual acceptance', 'same-content Before/After baseline from the pre-change SHA'],
  })
  finish(h, extra)
}

function viewportsNeedAppearance(viewport, gui) {
  return !gui && viewport.appearance === 'light'
}
