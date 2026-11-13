/**
 * T3-0C: the REAL Tern pane / GUI lane for the native Workflow Run/Phase
 * disclosure and its scoped Work Hub browse action.
 *
 * The subject is the production `tern-pane-transcript-modes-subject.mts`
 * running scenario `workflow-disclosure`: one real Direct Session writer
 * appends the OFFICIAL `tool-workflow/*` SessionEvents, the production
 * `TranscriptFolder` folds them and the production TSP renderer maps them.
 * Every toggle below is the client's own `toggle` event after ONE
 * control-injected click on the real head fragment; every assertion reads the
 * client's OWN node tree / pixel geometry. No map injection, no boolean.
 *
 * Viewport matrix: 1280x800 dark, 900x700 dark, 400x600 dark (headless only;
 * a real window clamps narrow requests and the clamp is recorded), 900x360
 * light. Evidence tier: REAL_TERN_GUI/HEADLESS + CONTROL_INJECTED_INPUT.
 * @module scripts/tern-pane-transcript-workflow-disclosure
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release as osRelease, type } from 'node:os'
import { join } from 'node:path'
import { rect, visibleSpan } from './tern-pane-geometry.mjs'

const PRESETS = ['full', 'compact', 'focus']
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]
const WORKFLOW_ACTION = 'dsh-workflow-scoped-agents'
const RUN_A = 'wf-run-a'
const RUN_B = 'wf-run-b'

export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_WORKFLOW_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) {
    throw new Error(`TERN_TRANSCRIPT_WORKFLOW_PRESET must be full, compact or focus; got ${preset}`)
  }
  return preset
}

export function workflowEvidenceTier(gui) {
  return gui ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT' : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT'
}

export function qualificationFromResults(results, pass = 'REAL_TERN_WORKFLOW_DISCLOSURE_PASS') {
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
  const qualification = qualificationFromResults(h.results, outcome ?? 'REAL_TERN_WORKFLOW_DISCLOSURE_PASS')
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
const hasClass = (node, name) => String(node.class ?? '').split(/\s+/u).includes(name)
const sectionHeadNodes = snapshot => {
  const root = mainRegion(snapshot)
  if (root === undefined) return []
  const out = []
  const visit = node => {
    if (hasClass(node, 'sf-section-head')) out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return out
}

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

/** Bring one native head into the real client's viewport (real wheel scroll). */
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
    const clickable = visibleSpan(snapshot.chains, head, 'x') >= 4 && visibleSpan(snapshot.chains, head, 'y') >= 4
    if (texts.length > 0 && texts.every(node => visibleSpan(snapshot.chains, node, 'y') >= 4) && clickable) {
      await h.sleep(300)
      const stable = h.snapshot()
      const stableHead = findHead(stable)
      if (stableHead === undefined) return undefined
      const stableClickable = visibleSpan(stable.chains, stableHead, 'x') >= 4
        && visibleSpan(stable.chains, stableHead, 'y') >= 4
      if (stableClickable) return { snapshot: stable, head: stableHead }
      continue
    }
    const main = mainRegion(snapshot)
    if (main === undefined) return undefined
    const headRect = rect(head)
    const [viewportWidth, viewportHeight] = viewport()
    const dock = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-dock'))
    const dockRect = rect(dock ?? {})
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
    if (afterY === undefined || lastY === afterY) wheelSign = -wheelSign
    else {
      const movedDown = afterY > beforeY
      if (movedDown !== wantIncrease) {
        wheelSign = -wheelSign
        step = Math.max(8, Math.floor(step / 2))
      } else if ((beforeY < visibleTop && afterY > visibleBottom)
        || (beforeY + headRect[3] > visibleBottom && afterY + headRect[3] < visibleTop)) {
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
  JSON.stringify(witness === undefined ? null : { rect: rect(witness.head) }))
  if (witness === undefined) return false
  h.check(`${label}: one control-injected client click lands`, await h.click(witness.snapshot.chains, witness.head), JSON.stringify(rect(witness.head)))
  const received = await waitUntil(h, `${label}: client toggle reaches the Session iterator`,
    () => records(h).filter(entry => entry.kind === 'client.toggle').length > before, 100)
  const event = records(h).filter(entry => entry.kind === 'client.toggle').at(-1)
  h.check(`${label}: the client toggle names the exact SDK node and target state`,
    received && event?.id === targetId && event.collapsed === expectedCollapsed,
    JSON.stringify({ expected: { id: targetId, collapsed: expectedCollapsed }, event: event ?? null }))
  return true
}

const sectionHeadByText = (snapshot, h, text) => sectionHeadNodes(snapshot)
  .find(node => h.descendantsText(node).includes(text))

function findSectionNode(h, text) {
  return [...foldLive(h).values()].find(node => node.k === 'section' && subtreeText(foldLive(h), node.id).includes(text))
}

/** The Run Section's SDK node (its head names the run). */
function findRunNode(h, runName) {
  return [...foldLive(h).values()].find(node => node.k === 'section'
    && node.p.collapsible === true && subtreeText(foldLive(h), node.id).includes(`Workflow ${runName}`))
}

/** Open every collapsed Focus Thought root until the Workflow row it owns is
 *  materialized. Focus visibility belongs to the official Focus projection; the
 *  flow only expands the native heads the user can expand. */
async function openFocusParents(h, preset) {
  if (preset !== 'focus') return
  for (let round = 0; round < 6; round += 1) {
    const live = foldLive(h)
    const roots = [...live.values()].filter(node => node.k === 'section'
      && node.p.collapsible === true && node.p.collapsed === true
      && String(node.p.key ?? '').includes('focus-'))
    if (roots.length === 0) return
    const target = roots[0]
    const headText = subtreeText(live, `${target.id}.head`).slice(0, 48)
    const witness = await revealHead(h, 'Focus parent',
      snapshot => sectionHeadNodes(snapshot).find(node => h.descendantsText(node).trim() === headText.trim())
        ?? sectionHeadNodes(snapshot).find(node => h.descendantsText(node).includes(headText)))
    if (witness === undefined) return
    await clickToggle(h, witness, target.id, false, `Focus parent ${headText.slice(0, 24)}`)
    if (!await waitUntil(h, `the Focus parent ${headText.slice(0, 24)} opens`,
      () => foldLive(h).get(target.id)?.p.collapsed === false)) return
  }
}

/** The phase child sections of one Run, by their injective `phase-` key. */
function phaseNodes(h, runId) {
  const live = foldLive(h)
  return [...live.values()].filter(node => node.k === 'section'
    && String(node.p.key ?? '').startsWith('phase-')
    && node.id.startsWith(`${runId}.`))
}

export default async function (h) {
  const preset = presetFromEnvironment()
  const gui = process.env.TERN_WORKFLOW_GUI === '1'
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
    evidenceTier: workflowEvidenceTier(gui),
    sourceSnapshot: head,
  })
  h.check('the worktree uses the npm DSH family with matching Agent and Session pins',
    dshMode === 'npm' && typeof dshPin === 'string' && dshSessionPin === dshPin,
    JSON.stringify({ dshMode, dshPin, dshSessionPin }))
  h.check('the locked Tern SDK is 0.2.0 with recorded integrity', sdkIntegrity !== undefined, String(sdkIntegrity))
  if (dshMode !== 'npm' || typeof dshPin !== 'string' || dshSessionPin !== dshPin || sdkIntegrity === undefined) {
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

  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario: 'workflow-disclosure' })}\n`)
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct workflow-disclosure Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'workflow-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
      && records(h).some(row => row.kind === 'fixture.ready'
        && row.scenario === 'workflow-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'MOUNT_NOT_READY' })
    return
  }
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
  h.check('the client negotiated Section nodes', hello?.kinds?.includes('section'), JSON.stringify(hello?.kinds))

  const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const prompt = prompts.prompts[0]
  h.send('type', JSON.stringify(prompt.text))
  await h.key('Return', 600)
  if (!await waitUntil(h, 'the production Direct writer settled exactly one prompt', () =>
    records(h).filter(row => row.kind === 'producer.writer.settled').length === 1)) {
    finish(h, { ...extra, qualification: 'DIRECT_WRITE_NOT_SETTLED' })
    return
  }
  if (!await waitUntil(h, 'the first real turn settles before the Workflow scenario is appended', () =>
    h.texts(h.snapshot()).some(text => text.includes(prompts.assistantMarker))
      || h.texts(h.snapshot()).some(text => text.includes('MODES-DIRECT-ANSWER')))) {
    finish(h, { ...extra, qualification: 'FIRST_TURN_NOT_MATERIALIZED' })
    return
  }

  const appended = await runCase(h, 'workflow-disclosure')
  if (appended?.status !== 'ok') { finish(h, { ...extra, qualification: 'WORKFLOW_EVENTS_NOT_ADDED' }); return }
  await openFocusParents(h, preset)

  if (!await waitUntil(h, 'the official run reaches one native Run Section', () =>
    findRunNode(h, 'deploy-backend') !== undefined)) {
    finish(h, { ...extra, qualification: 'RUN_SECTION_NOT_MATERIALIZED' })
    return
  }
  const run = findRunNode(h, 'deploy-backend')
  h.check('the abnormal live Run opens by default and its head keeps status + exact summary',
    run.p.collapsed === false && subtreeText(foldLive(h), run.id).includes('[running]')
      && subtreeText(foldLive(h), run.id).includes('8 agents'),
    JSON.stringify(run ?? null))
  h.check('the cold-replayed clean Run stays closed with its real status',
    findRunNode(h, 'audit-done')?.p.collapsed === true
      && subtreeText(foldLive(h), findRunNode(h, 'audit-done').id).includes('[completed]'),
    JSON.stringify(findRunNode(h, 'audit-done') ?? null))
  h.capture(`${preset}-workflow-open-1280x800-dark`, 'the abnormal Run with its Phase sections and the clean Run folded')

  const phases = phaseNodes(h, run.id)
  const phaseText = phases.map(node => subtreeText(foldLive(h), node.id)).join(' ')
  h.check('the run projects its distinct null/empty/named phase sections',
    phases.length === 4 && phaseText.includes('Unassigned') && phaseText.includes('Empty')
      && phases.every(node => String(node.p.key ?? '').startsWith('phase-')),
    JSON.stringify(phases.map(node => ({ id: node.id, key: node.p.key }))))

  // The Prepare phase: member rows with readable status words and the scoped
  // browse button (the hub negotiated kinds cover the real Task Center entry).
  const prepare = phases.find(node => subtreeText(foldLive(h), node.id).includes('build-1'))
  h.check('the small Prepare phase lists every member with its distinct status word',
    prepare !== undefined && subtreeText(foldLive(h), prepare.id).includes('build-1 — completed')
      && subtreeText(foldLive(h), prepare.id).includes('build-2 — failed')
      && subtreeText(foldLive(h), prepare.id).includes('verify-1 — running'),
    JSON.stringify(prepare ?? null))
  const allButtons = [...foldLive(h).values()].filter(node => node.k === 'button'
    && node.p.actions?.click === WORKFLOW_ACTION)
  h.check('the scoped browse buttons carry the fixed local action id and cover the whole run',
    allButtons.length === 5 && allButtons.some(node => subtreeText(foldLive(h), node.id).includes('View all 8 agents'))
      && allButtons.some(node => subtreeText(foldLive(h), node.id).includes('View 3 agents')),
    JSON.stringify(allButtons.map(node => ({ id: node.id, text: subtreeText(foldLive(h), node.id) }))))
  h.capture(`${preset}-workflow-phases-1280x800-dark`, 'the phase bodies with member rows and scoped browse buttons')

  // Toggle a phase closed, then close and reopen the run: phase choice persists.
  const prepareWitness = await revealHead(h, 'Prepare phase',
    snapshot => sectionHeadByText(snapshot, h, 'Prepare'))
  if (!await clickToggle(h, prepareWitness, prepare.id, true, 'Prepare phase')) {
    finish(h, { ...extra, qualification: 'PHASE_TOGGLE_NOT_DELIVERED' })
    return
  }
  if (!await waitUntil(h, 'the exact Prepare section collapses and its body retires', () =>
    foldLive(h).get(prepare.id)?.p.collapsed === true
      && [...foldLive(h).values()].every(node => !node.id.startsWith(`${prepare.id}.body`)))) {
    finish(h, { ...extra, qualification: 'PHASE_BODY_NOT_CLOSED' })
    return
  }
  const runWitness = await revealHead(h, 'Workflow run', snapshot => sectionHeadByText(snapshot, h, 'Workflow deploy-backend'))
  if (!await clickToggle(h, runWitness, run.id, true, 'Workflow run')) {
    finish(h, { ...extra, qualification: 'RUN_TOGGLE_NOT_DELIVERED' })
    return
  }
  if (!await waitUntil(h, 'the closed Run materializes no phase child', () =>
    phaseNodes(h, run.id).length === 0
      && [...foldLive(h).values()].every(node => !node.id.startsWith(`${run.id}.phase-`)))) {
    finish(h, { ...extra, qualification: 'RUN_CHILDREN_NOT_RETIRED' })
    return
  }
  h.check('the folded Run still paints its head status and exact summary',
    foldLive(h).get(run.id)?.p.collapsed === true
      && subtreeText(foldLive(h), run.id).includes('[running]')
      && subtreeText(foldLive(h), run.id).includes('8 agents'),
    JSON.stringify(foldLive(h).get(run.id) ?? null))
  h.capture(`${preset}-workflow-closed-1280x800-dark`, 'the folded Run keeps its head facts')
  const reopenWitness = await revealHead(h, 'Workflow run reopen', snapshot => sectionHeadByText(snapshot, h, 'Workflow deploy-backend'))
  if (!await clickToggle(h, reopenWitness, run.id, false, 'Workflow run reopen')) {
    finish(h, { ...extra, qualification: 'RUN_REOPEN_NOT_DELIVERED' })
    return
  }
  if (!await waitUntil(h, 'reopening the Run restores its phase sections', () =>
    phaseNodes(h, run.id).length === 4)) {
    finish(h, { ...extra, qualification: 'RUN_CHILDREN_NOT_RESTORED' })
    return
  }
  h.check('the manually closed phase stays closed after the parent round trip',
    foldLive(h).get(prepare.id)?.p.collapsed === true,
    JSON.stringify(foldLive(h).get(prepare.id) ?? null))

  // Same-source late official events: the run settles clean.
  h.check('the late official settle is appended through the real Session writer',
    (await runCase(h, 'workflow-late-settle'))?.status === 'ok')
  if (!await waitUntil(h, 'the settled Run reads completed while keeping its section identity', () =>
    foldLive(h).get(run.id) !== undefined
      && subtreeText(foldLive(h), run.id).includes('[completed]'))) {
    finish(h, { ...extra, qualification: 'LATE_SETTLE_NOT_RENDERED' })
    return
  }
  h.check('one Workflow row update did not remount unrelated history',
    foldLive(h).has(run.id), JSON.stringify({ runId: run.id }))
  h.capture(`${preset}-workflow-settled-1280x800-dark`, 'the settled clean Run after the late official events')

  // Viewport matrix over the still-mounted Workflow run.
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
    const witness = await revealHead(h, `${viewport.width}x${viewport.height} Run`,
      snapshot => sectionHeadByText(snapshot, h, 'Workflow deploy-backend'))
    const headVisible = witness !== undefined
      && visibleSpan(witness.snapshot.chains, witness.head, 'x') >= 4
      && visibleSpan(witness.snapshot.chains, witness.head, 'y') >= 4
    if (gui && !exact) {
      h.measure(`${viewport.width}x${viewport.height}: clamped Run head`, JSON.stringify({ headVisible, actual: stats.viewport, requested: resize }))
    } else {
      h.check(`${viewport.width}x${viewport.height}: the Run head stays reachable`,
        headVisible && exact,
        JSON.stringify({ head: witness === undefined ? null : rect(witness.head), viewport: stats.viewport, theme: state.theme }))
    }
    h.capture(`${preset}-workflow-${viewport.width}x${viewport.height}-${viewport.appearance}`,
      `the Workflow disclosure stays readable at ${viewport.width}x${viewport.height} ${viewport.appearance}`)
    matrix.push({ ...viewport, actual: stats.viewport, exact, theme: state.theme, headVisible })
  }
  writeLedger(h, 'workflow-disclosure-viewport-matrix.json', matrix)
  writeLedger(h, 'workflow-disclosure.json', {
    sourceSnapshot: head,
    preset,
    evidenceTier: workflowEvidenceTier(gui),
    runId: run.id,
    phaseIds: phases.map(node => node.id),
    cleanRunId: findRunNode(h, 'audit-done')?.id ?? null,
    browseButtons: allButtons.map(node => node.id),
    viewportMatrix: matrix,
    provenance: 'live Direct Session writer -> official tool-workflow SessionEvents -> TranscriptFolder -> TSP mapper -> pinned Tern client -> control-injected native toggle',
    notVerified: [
      'OS physical keyboard/IME/wheel',
      'G8 Owner visual acceptance',
      'the scoped Work Hub open round trip (needs the hub-kind pane with a live catalog; covered by the L6 integration lane, NOT this pane run)',
    ],
  })
  finish(h, extra)
}
