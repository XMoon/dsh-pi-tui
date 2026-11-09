import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release as osRelease, type } from 'node:os'
import { join } from 'node:path'
import { rect, visibleSpan } from './tern-pane-geometry.mjs'

const PINNED_TERN = 'tern 0.9.13 (8c6dfbd)'
const PINNED_TERN_SHA256 = 'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99'
const PRESETS = ['full', 'compact', 'focus']
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]

export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_DETAIL_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) throw new Error(`TERN_TRANSCRIPT_DETAIL_PRESET must be full, compact or focus; got ${preset}`)
  return preset
}

export function isPinnedTernBuild(version, sha256) {
  return version === PINNED_TERN && sha256 === PINNED_TERN_SHA256
}

export function isTargetToggle(event, id, collapsed) {
  return (event?.ev === 'toggle' || event?.kind === 'client.toggle')
    && event.id === id && event.collapsed === collapsed
}

export function innerDisclosureEvidenceTier(gui) {
  return gui ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT' : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT'
}

export function qualificationFromResults(results, pass = 'REAL_TERN_INNER_DISCLOSURE_PASS') {
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
  const qualification = qualificationFromResults(h.results, outcome ?? 'REAL_TERN_INNER_DISCLOSURE_PASS')
  const status = h.finish({
    ...metadata,
    ...(outcome === undefined || outcome === qualification ? {} : { qualificationDetail: outcome }),
    qualification,
  })
  if (status !== 0) process.exitCode = status
}

const records = h => readJsonl(join(h.root, 'events.jsonl'))
const wire = h => readJsonl(join(h.root, 'sdk-wire.jsonl'))

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
      if (op[0] === 'add') insert(op[4])
      else if (op[0] === 'del') drop(op[1])
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p = { ...node.p, ...(op[2] ?? {}) }
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p.text = op[2] === 'append'
          ? `${String(node.p.text ?? '')}${String(op[3] ?? '')}` : String(op[3] ?? '')
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
async function waitUntil(h, label, predicate, limit = 240) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  h.check(label, false, JSON.stringify({ visible: h.texts(h.snapshot()).slice(-12), ids: [...foldLive(h).keys()].slice(-12) }))
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

async function clickToggle(h, snapshot, node, targetId, expectedCollapsed, label) {
  const before = records(h).filter(entry => entry.kind === 'client.toggle').length
  const headerCandidates = node === undefined
    ? mainNodes(snapshot)
      .filter(entry => String(entry.class ?? '').split(/\s+/u).includes('sf-section-head'))
      .map(entry => ({ id: entry.id, text: h.descendantsText(entry), rect: rect(entry) }))
    : undefined
  h.check(`${label}: native header has a visible clickable fragment`, node !== undefined
    && visibleSpan(snapshot.chains, node, 'x') >= 4
    && visibleSpan(snapshot.chains, node, 'y') >= 4,
  JSON.stringify(node === undefined
    ? { headerCandidates }
    : { rect: rect(node), x: visibleSpan(snapshot.chains, node, 'x'), y: visibleSpan(snapshot.chains, node, 'y') }))
  if (node === undefined) return undefined
  h.check(`${label}: one control-injected client click lands`, await h.click(snapshot.chains, node), JSON.stringify(rect(node)))
  const received = await waitUntil(h, `${label}: client toggle reaches the existing Session iterator`,
    () => records(h).filter(entry => entry.kind === 'client.toggle').length > before, 100)
  const event = records(h).filter(entry => entry.kind === 'client.toggle').at(-1)
  h.check(`${label}: the client toggle names the exact SDK node and target state`, received
    && isTargetToggle(event, targetId, expectedCollapsed),
  JSON.stringify({ expected: { id: targetId, collapsed: expectedCollapsed }, event: event ?? null }))
  return event
}

export default async function (h) {
  const preset = presetFromEnvironment()
  const gui = process.env.TERN_INNER_DISCLOSURE_GUI === '1'
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
  const extra = { preset, tern: ternVersion, sdk: '0.2.0', dsh: dshPin }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  writeLedger(h, 'environment.json', {
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    host: { node: process.version, os: `${type()} ${osRelease()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    display: process.env.DISPLAY ?? null,
    preset,
    evidenceTier: innerDisclosureEvidenceTier(gui),
    sourceSnapshot: head,
  })

  h.check('the worktree uses npm DSH 0.2.2-rc.1 for Agent and Session',
    dshMode === 'npm' && dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin,
    JSON.stringify({ dshMode, dshPin, dshSessionPin }))
  h.check('the locked Tern SDK is 0.2.0 with recorded integrity', sdkIntegrity !== undefined,
    String(sdkIntegrity))
  h.check('the Tern executable is the plan-pinned 0.9.13 (8c6dfbd) binary SHA-256',
    isPinnedTernBuild(ternVersion, ternSha256),
    JSON.stringify({
      expectedVersion: PINNED_TERN,
      actualVersion: ternVersion,
      expectedSha256: PINNED_TERN_SHA256,
      actualSha256: ternSha256,
    }))
  if (dshMode !== 'npm' || dshPin !== '0.2.2-rc.1' || dshSessionPin !== dshPin
    || sdkIntegrity === undefined || ternVersion !== PINNED_TERN || ternSha256 !== PINNED_TERN_SHA256) {
    finish(h, { ...extra, codeEvidenceOnly: true, qualification: 'NOT_RUN_PIN_MISMATCH' })
    return
  }

  if (gui) {
    const system = h.ctl('system')
    h.check('the client is a real GUI window on the current display',
      (system.displays ?? []).length > 0 && typeof system.title === 'string',
      JSON.stringify({ title: system.title, displays: system.displays }))
  }
  const initialResize = await h.resize(1280, 800)
  if (gui) h.check('the real GUI window accepted 1280x800 without clamp', initialResize.clamped === false, JSON.stringify(initialResize))
  if (gui) {
    if (h.ctl('state').theme !== 'dark') h.send('plugins', 'run', 'appearance:dark')
  } else h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark', String(h.ctl('state').theme))

  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario: 'inner-disclosure' })}\n`)
  const subject = join(repo, 'scripts', 'tern-pane-transcript-modes-subject.mts')
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct inner-disclosure Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'inner-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello'))) {
    finish(h, { ...extra, qualification: 'MOUNT_NOT_READY' })
    return
  }
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
  h.check('the client negotiated Section and Tool nodes', hello?.kinds?.includes('section') && hello?.kinds?.includes('tool'), JSON.stringify(hello?.kinds))
  h.check('the Direct subject configured the selected canonical preset', records(h).some(row => row.kind === 'fixture.ready'
    && row.scenario === 'inner-disclosure' && row.mode === preset), JSON.stringify(records(h).find(row => row.kind === 'fixture.ready')))

  const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const prompt = prompts.prompts[0]
  h.check('the deterministic prompt marker is absent before the submit gesture', !h.texts(h.snapshot()).some(text => text.includes(prompt.marker)))
  h.send('type', JSON.stringify(prompt.text))
  await h.key('Return', 600)
  if (!await waitUntil(h, 'the production Direct writer settled exactly one prompt', () =>
    records(h).filter(row => row.kind === 'producer.writer.settled').length === 1)) {
    finish(h, { ...extra, qualification: 'DIRECT_WRITE_NOT_SETTLED' })
    return
  }
  if (!await waitUntil(h, 'the production Direct stream reached transient Preparing', () =>
    h.texts(h.snapshot()).some(text => text.includes('Preparing')))) {
    finish(h, { ...extra, qualification: 'PREPARING_NOT_VISIBLE' })
    return
  }
  let live = foldLive(h)
  let rootId
  let workId
  if (preset === 'focus') {
    const root = [...live.values()].find(node => node.k === 'section' && String(node.p['key']).includes('focus-'))
    h.check('Focus has exactly one current canonical root', root !== undefined)
    if (root === undefined) { finish(h, { ...extra, qualification: 'FOCUS_ROOT_NOT_FOUND' }); return }
    rootId = root.id
    if (root.p['collapsed'] === true) {
      const snap = h.snapshot()
      const head = mainNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && h.descendantsText(node).includes('Working'))
      await clickToggle(h, snap, head, rootId, false, 'Focus root')
      if (!await waitUntil(h, 'the exact Focus root opens before its Work is observed', () => foldLive(h).get(rootId)?.p['collapsed'] === false)) {
        finish(h, { ...extra, qualification: 'FOCUS_ROOT_NOT_OPEN' })
        return
      }
    }
  }

  live = foldLive(h)
  if (preset !== 'full') {
    const work = [...live.values()].find(node => node.k === 'section' && String(node.p['key']).includes('work-'))
    h.check(`${preset} has its canonical Work only after its parent opens`, work !== undefined)
    if (work === undefined) { finish(h, { ...extra, qualification: 'WORK_NOT_MATERIALIZED' }); return }
    workId = work.id
    if (work.p['collapsed'] === true) {
      const snap = h.snapshot()
      const head = mainNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && (h.descendantsText(node).includes('Activity')
          || preset === 'compact' && h.descendantsText(node).includes('Thought')))
      await clickToggle(h, snap, head, workId, false, `${preset} Work`)
      if (!await waitUntil(h, 'the exact Work opens before its inner members are observed', () => foldLive(h).get(workId)?.p['collapsed'] === false)) {
        finish(h, { ...extra, qualification: 'WORK_NOT_OPEN' })
        return
      }
    }
  }

  live = foldLive(h)
  const rootBefore = live
  const reasoningNode = [...live.values()].find(node => node.k === 'section' && subtreeText(live, node.id).includes('latest reasoning line'))
  h.check('the official Direct stream produced a bounded native Thinking Section after its canonical parents opened', reasoningNode !== undefined,
    JSON.stringify(reasoningNode ?? null))
  if (reasoningNode === undefined) {
    finish(h, { ...extra, qualification: 'THINKING_NOT_MATERIALIZED' })
    return
  }
  const reasoningId = reasoningNode.id
  const headSnapshot = h.snapshot()
  const thinkHead = mainNodes(headSnapshot).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
    && h.descendantsText(node).includes('latest reasoning line'))
  h.check('the collapsed Thinking summary is physically visible before its body opens', thinkHead !== undefined
    && visibleSpan(headSnapshot.chains, thinkHead, 'x') >= 4 && visibleSpan(headSnapshot.chains, thinkHead, 'y') >= 4,
  JSON.stringify(thinkHead === undefined ? null : { rect: rect(thinkHead), x: visibleSpan(headSnapshot.chains, thinkHead, 'x'), y: visibleSpan(headSnapshot.chains, thinkHead, 'y') }))
  const closedBodyId = `${reasoningId}.body`
  h.check('collapsed Thinking has no body node in the official SDK wire tree', !rootBefore.has(closedBodyId))

  const currentThinking = live.get(reasoningId)
  h.check('opening ancestors preserves the same Thinking SDK id', currentThinking !== undefined && currentThinking.k === 'section')
  const currentThinkingHead = h.snapshot()
  const visibleThinkingHead = mainNodes(currentThinkingHead).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
    && h.descendantsText(node).includes('latest reasoning line'))
  h.capture(`${preset}-thinking-closed-1280x800-dark`, 'the exact Thinking body remains absent before its native header opens')
  await clickToggle(h, currentThinkingHead, visibleThinkingHead, reasoningId, false, 'Thinking')
  if (!await waitUntil(h, 'the opened Thinking body is materialized', () => foldLive(h).has(`${reasoningId}.body`))) {
    finish(h, { ...extra, qualification: 'THINKING_BODY_NOT_OPEN' })
    return
  }
  writeLedger(h, 'thinking-toggle.json', { id: reasoningId, event: records(h).filter(row => row.kind === 'client.toggle').at(-1), body: foldLive(h).get(`${reasoningId}.body`) })
  h.capture(`${preset}-thinking-open-1280x800-dark`, 'the same canonical Thinking Section opened through a real client pointer toggle')

  const contextResult = await runCase(h, 'append-context')
  h.check('two official same-turn snapshot Context events were appended for the open Direct turn', contextResult?.status === 'ok', JSON.stringify(contextResult ?? null))
  let cluster
  const contextOwnerIds = []
  let focusContextRowsPreservedDuringStreaming = false
  if (preset === 'focus') {
    if (!await waitUntil(h, 'both canonical Focus Context Rows reach the current Root', () =>
      [...foldLive(h).values()].filter(node => node.k === 'section'
        && node.id.startsWith(`${rootId}.`)
        && String(node.p['head'] ?? '').startsWith('inner-context-')).length === 2)) {
      finish(h, { ...extra, qualification: 'FOCUS_CONTEXT_ROWS_NOT_MATERIALIZED' })
      return
    }
    live = foldLive(h)
    const rows = [...live.values()].filter(node => node.k === 'section'
      && node.id.startsWith(`${rootId}.`)
      && String(node.p['head'] ?? '').startsWith('inner-context-'))
      .sort((left, right) => String(left.p['head']).localeCompare(String(right.p['head'])))
    h.check('Focus keeps both surfaced Snapshot Context Rows under its canonical Root', rows.length === 2,
      JSON.stringify(rows.map(node => ({ id: node.id, parent: node.id.slice(0, node.id.lastIndexOf('.')), collapsed: node.p['collapsed'] }))))
    if (rows.length !== 2) { finish(h, { ...extra, qualification: 'FOCUS_CONTEXT_ROWS_NOT_MATERIALIZED' }); return }
    h.capture('focus-context-rows-closed-1280x800-dark', 'both exact Focus Context Row bodies are absent before native row disclosure')
    for (let index = 0; index < rows.length; index += 1) {
      const contextRow = rows[index]
      contextOwnerIds.push(contextRow.id)
      h.check(`Focus Snapshot Context Row ${index + 1} starts independently collapsed`, contextRow.p['collapsible'] === true && contextRow.p['collapsed'] === true)
      const snap = h.snapshot()
      const snapshotHeads = mainNodes(snap).filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && h.descendantsText(node).includes(`inner-context-${index}`))
      const head = snapshotHeads[0]
      await clickToggle(h, snap, head, contextRow.id, false, `Focus Context Row ${index + 1}`)
      if (!await waitUntil(h, `Focus Context Row ${index + 1} materializes only its own body`, () =>
        foldLive(h).has(`${contextRow.id}.body`))) {
        finish(h, { ...extra, qualification: 'FOCUS_CONTEXT_ROW_BODY_NOT_OPEN' })
        return
      }
      h.check(`Focus Context Row ${index + 1} shows its official producer payload`,
        h.texts(h.snapshot()).some(text => text.includes(index === 0 ? 'first native context detail' : 'second native context detail')))
    }
    h.capture('focus-context-rows-open-1280x800-dark', 'both exact Focus Context Rows were opened through their native Section headers')
    await runCase(h, 'reproject')
    live = foldLive(h)
    focusContextRowsPreservedDuringStreaming = contextOwnerIds.length === 2
      && contextOwnerIds.every(id => live.get(id)?.p['collapsed'] === false)
    h.check('same-source Focus repaint preserves both expanded Context Row owners during the live turn',
      focusContextRowsPreservedDuringStreaming,
      JSON.stringify(contextOwnerIds.map(id => ({ id, node: live.get(id) }))))
  } else {
    if (!await waitUntil(h, 'the canonical Context Cluster Section reaches the current Main', () =>
      [...foldLive(h).values()].some(node => node.k === 'section' && String(node.p['key']).includes('ctx-')))) {
      finish(h, { ...extra, qualification: 'CONTEXT_CLUSTER_NOT_MATERIALIZED' })
      return
    }
    live = foldLive(h)
    const clusters = [...live.values()].filter(node => node.k === 'section' && String(node.p['key']).includes('ctx-'))
    cluster = clusters.at(-1)
    h.check('the current Context Cluster is independently collapsed', cluster?.p['collapsed'] === true, JSON.stringify(cluster?.p))
    const contextSnap = h.snapshot()
    const contextHead = mainNodes(contextSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('inner-context'))
    h.capture(`${preset}-context-cluster-closed-1280x800-dark`, 'the canonical Cluster body remains absent before its native header opens')
    await clickToggle(h, contextSnap, contextHead, cluster.id, false, 'Context Cluster')
    if (!await waitUntil(h, 'the Context Cluster members enter the current wire tree', () =>
      h.texts(h.snapshot()).some(text => text.includes('first native context detail'))
        || [...foldLive(h).values()].some(node => node.p['text'] === 'first native context detail'))) {
      finish(h, { ...extra, qualification: 'CONTEXT_BODY_NOT_OPEN' })
      return
    }
    h.check('both Context member payloads are readable only after their canonical cluster opens',
      h.texts(h.snapshot()).some(text => text.includes('first native context detail'))
        && h.texts(h.snapshot()).some(text => text.includes('second native context detail')))
    h.capture(`${preset}-context-open-1280x800-dark`, 'the canonical same-turn Cluster exposes both producer rows once')
  }

  const toolBefore = [...foldLive(h).values()].find(node => node.k === 'tool' && node.p['name'] === 'job_list')
  h.check('the durable tool-call has not yet replaced Preparing', toolBefore === undefined)
  const release = await runCase(h, 'release-tool-arguments')
  h.check('the production Agent stream released its held argument block', release?.status === 'ok', JSON.stringify(release ?? null))
  let toolWorkId = workId
  if (preset !== 'full') {
    if (!await waitUntil(h, 'the canonical Activity summary for the durable job_list call reaches Main', () =>
      [...foldLive(h).values()].some(node => node.k === 'section' && String(node.p['key']).includes('work-')
        && subtreeText(foldLive(h), node.id).includes('job_list')))) {
      finish(h, { ...extra, qualification: 'TOOL_WORK_NOT_MATERIALIZED' })
      return
    }
    live = foldLive(h)
    const toolWork = [...live.values()].find(node => node.k === 'section' && String(node.p['key']).includes('work-')
      && subtreeText(live, node.id).includes('job_list'))
    h.check('the durable call has one canonical Work owner to open', toolWork !== undefined)
    if (toolWork === undefined) { finish(h, { ...extra, qualification: 'TOOL_WORK_NOT_MATERIALIZED' }); return }
    toolWorkId = toolWork.id
    if (toolWork.p['collapsed'] === true) {
      const snap = h.snapshot()
      const head = mainNodes(snap).find(node => {
        if (!String(node.class ?? '').split(/\s+/u).includes('sf-section-head')) return false
        const text = h.descendantsText(node)
        return text.includes('job_list')
          && (text.includes('Activity') || preset === 'compact' && text.includes('Thought'))
      })
      await clickToggle(h, snap, head, toolWorkId, false, `${preset} durable Tool Work`)
      if (!await waitUntil(h, 'the durable Tool Work opens before its Tool is observed', () => foldLive(h).get(toolWorkId)?.p['collapsed'] === false)) {
        finish(h, { ...extra, qualification: 'TOOL_WORK_NOT_OPEN' })
        return
      }
    }
  }
  if (!await waitUntil(h, 'the one durable native Tool replaces transient Preparing', () =>
    [...foldLive(h).values()].some(node => node.k === 'tool' && node.p['name'] === 'job_list'))) {
    finish(h, { ...extra, qualification: 'DURABLE_TOOL_NOT_MATERIALIZED' })
    return
  }
  if (preset === 'focus') {
    live = foldLive(h)
    const settledClusters = [...live.values()].filter(node => node.k === 'section' && String(node.p['key']).includes('ctx-'))
    cluster = settledClusters.at(-1)
    h.check('settled Focus materializes the same Context members in its canonical Work Cluster', cluster !== undefined, JSON.stringify(settledClusters))
    if (cluster === undefined) { finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_CLUSTER_NOT_MATERIALIZED' }); return }
    h.check('the settled Focus Context Cluster starts independently collapsed', cluster.p['collapsible'] === true && cluster.p['collapsed'] === true)
    const snap = h.snapshot()
    const head = mainNodes(snap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('inner-context-0'))
    await clickToggle(h, snap, head, cluster.id, false, 'settled Focus Context Cluster')
    if (!await waitUntil(h, 'settled Focus Context Cluster materializes both source rows', () =>
      h.texts(h.snapshot()).some(text => text.includes('first native context detail'))
        && h.texts(h.snapshot()).some(text => text.includes('second native context detail')))) {
      finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_BODY_NOT_OPEN' })
      return
    }
  }
  live = foldLive(h)
  const durableTools = [...live.values()].filter(node => node.k === 'tool' && node.p['name'] === 'job_list')
  h.check('exactly one durable Tool owns the completed call', durableTools.length === 1, JSON.stringify(durableTools.map(node => node.id)))
  const tool = durableTools[0]
  h.check('the durable Tool remains independently collapsed', tool?.p['collapsible'] === true && tool?.p['collapsed'] === true, JSON.stringify(tool?.p))
  h.check('Thinking key remains stable across the durable Tool commit', live.has(reasoningId) && live.get(reasoningId)?.p['collapsed'] === false)
  const toolSnap = h.snapshot()
  const toolHead = mainNodes(toolSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
    && h.descendantsText(node).includes('job_list'))
  h.capture(`${preset}-tool-closed-1280x800-dark`, 'the ordinary Tool detail body remains absent before its native header opens')
  await clickToggle(h, toolSnap, toolHead, tool.id, false, 'ordinary Tool')
  if (!await waitUntil(h, 'the Tool body materializes after its own disclosure opens', () =>
    [...foldLive(h).values()].some(node => node.id.startsWith(`${tool?.id}.`) && node.id.includes('.result')))) {
    finish(h, { ...extra, qualification: 'TOOL_BODY_NOT_OPEN' })
    return
  }
  h.capture(`${preset}-tool-open-1280x800-dark`, 'the ordinary Tool details opened independently of the Work/Thought')

  const toggles = records(h).filter(row => row.kind === 'client.toggle')
  const contextToggleIdentity = preset === 'focus'
    ? contextOwnerIds.length === 2 && contextOwnerIds.every(id => toggles.some(row => row.id === id))
    : cluster !== undefined && toggles.some(row => row.id === cluster.id)
  h.check(`client toggle ledger contains the exact Thinking, Tool and ${preset === 'focus' ? 'Context Row' : 'Context Cluster'} ids`,
    toggles.some(row => row.id === reasoningId)
      && tool !== undefined && toggles.some(row => row.id === tool.id)
      && contextToggleIdentity,
    JSON.stringify(toggles))
  await runCase(h, 'reproject')
  live = foldLive(h)
  h.check('same-source repaint preserves stable Thinking identity and manual expansion',
    live.has(reasoningId) && live.get(reasoningId)?.p['collapsed'] === false)
  h.check('same-source repaint preserves the Work owner that contains the durable Tool',
    toolWorkId === undefined || live.get(toolWorkId)?.p['collapsed'] === false)
  const retainedCluster = cluster === undefined
    ? undefined
    : [...live.values()].find(node => node.k === 'section' && node.p['key'] === cluster.p['key'])
  const contextOwnersRemainOpen = preset === 'focus'
    ? focusContextRowsPreservedDuringStreaming && cluster !== undefined && retainedCluster?.p['collapsed'] === false
    : cluster !== undefined && retainedCluster?.p['collapsed'] === false
  h.check('same-source repaint preserves the opened Tool and canonical Context disclosure facts',
    tool !== undefined && live.get(tool.id)?.p['collapsed'] === false && contextOwnersRemainOpen)

  const matrix = []
  const viewports = gui ? [VIEWPORTS[0]] : VIEWPORTS
  for (const viewport of viewports) {
    const resized = await h.resize(viewport.width, viewport.height)
    if (gui) h.check('the real GUI window accepted the measured viewport without clamp', resized.clamped === false, JSON.stringify(resized))
    if (gui) {
      if (h.ctl('state').theme !== viewport.appearance) h.send('plugins', 'run', `appearance:${viewport.appearance}`)
    } else h.send('appearance', viewport.appearance)
    const theme = h.ctl('state').theme
    h.check(`the client resolved ${viewport.appearance} at ${viewport.width}x${viewport.height}`, theme === viewport.appearance, String(theme))
    let snap = h.snapshot()
    let sectionHeads = mainNodes(snap).filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head'))
    let fragments = sectionHeads.map(node => ({ text: h.descendantsText(node), x: visibleSpan(snap.chains, node, 'x'), y: visibleSpan(snap.chains, node, 'y') }))
    if (!fragments.some(item => item.x >= 4 && item.y >= 4)) {
      await h.key('PageUp', 900)
      snap = h.snapshot()
      sectionHeads = mainNodes(snap).filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head'))
      fragments = sectionHeads.map(node => ({ text: h.descendantsText(node), x: visibleSpan(snap.chains, node, 'x'), y: visibleSpan(snap.chains, node, 'y') }))
      if (viewport.width === 900 && viewport.height === 360) {
        h.check('native PageUp reveals a reachable disclosure header at short height',
          fragments.some(item => item.x >= 4 && item.y >= 4), JSON.stringify(fragments))
      }
    }
    h.check(`at least one native disclosure header is reachable at ${viewport.width}x${viewport.height}`,
      fragments.some(item => item.x >= 4 && item.y >= 4), JSON.stringify(fragments))
    h.measure(`all disclosure header fragments at ${viewport.width}x${viewport.height}`, JSON.stringify(fragments))
    const dock = snap.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-dock'))
    h.check(`the Dock remains in the measured client tree at ${viewport.width}x${viewport.height}`, dock !== undefined && rect(dock)[3] > 0,
      JSON.stringify(dock === undefined ? null : rect(dock)))
    const capture = h.capture(`${preset}-${viewport.width}x${viewport.height}-${viewport.appearance}`, 'open native Thinking, Tool and Context disclosures')
    matrix.push({ requested: [viewport.width, viewport.height], actual: h.ctl('stats').viewport, theme, capture, sectionHeaders: fragments })
  }
  writeLedger(h, 'viewport-matrix.json', matrix)
  writeLedger(h, 'inner-disclosure-evidence.json', {
    snapshot: head,
    preset,
    tern: { version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, pin: dshPin },
    provenance: 'official Direct writer -> Agent stream -> TranscriptFolder -> SurfaceRuntime -> current SDK View -> Tern client tree/events',
    root: rootId ?? null,
    work: toolWorkId ?? workId ?? null,
    initialStreamingWork: workId ?? null,
    thinking: reasoningId,
    tool: tool?.id ?? null,
    cluster: retainedCluster?.id ?? cluster?.id ?? null,
    initialContextCluster: cluster?.id ?? null,
    contextRows: contextOwnerIds,
    clientToggles: toggles,
    evidenceTier: innerDisclosureEvidenceTier(gui),
    notVerified: ['OS physical keyboard/IME/wheel', 'OS dark appearance', 'G8 Owner visual signature'],
  })
  finish(h, {
    ...extra,
    sourceSnapshot: head,
    qualification: qualificationFromResults(h.results),
  })
}
