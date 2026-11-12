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

export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_DETAIL_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) throw new Error(`TERN_TRANSCRIPT_DETAIL_PRESET must be full, compact or focus; got ${preset}`)
  return preset
}

export function scenarioFromEnvironment(value = process.env.TERN_TRANSCRIPT_DETAIL_SCENARIO) {
  const scenario = value ?? 'inner-disclosure'
  if (scenario !== 'inner-disclosure' && scenario !== 'ptc-error-note') {
    throw new Error(`TERN_TRANSCRIPT_DETAIL_SCENARIO must be inner-disclosure or ptc-error-note; got ${scenario}`)
  }
  return scenario
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
const isSectionHead = node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
/** The member Sections the CURRENT wire tree nests under one Cluster id. */
function contextMemberNodes(h, clusterId) {
  // The incremental journal adds a member with an explicit parent/insert ref;
  // it does not re-send the parent's child list, so membership follows the
  // deterministic SDK id ancestry, never a stale folded `children` array.
  const keyNumber = node => Number(/\d+$/u.exec(String(node.p?.key ?? ''))?.[0] ?? Number.NaN)
  return [...foldLive(h).values()].filter(node => node.k === 'section'
    && typeof node.id === 'string' && node.id.startsWith(`${clusterId}.`)
    && String(node.p?.head ?? '').includes(' · ambient'))
    .sort((left, right) => keyNumber(left) - keyNumber(right))
}
const memberBodyPresent = (h, member) => foldLive(h).has(`${member.id}.body`)
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

async function revealInnerHeader(h, label, findHeader) {
  let snapshot
  let header
  let textNodes = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    snapshot = h.snapshot()
    header = findHeader(snapshot)
    if (header === undefined) return undefined
    textNodes = snapshot.nodes.filter(node => snapshot.chains.get(node)?.includes(header)
      && typeof node.text === 'string' && node.text !== '')
    const dock = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-dock'))
    const dockRect = rect(dock ?? {})
    const bodyVisible = textNodes.length > 0 && textNodes.every(node => fullyVisible(snapshot.chains, node))
    const textOverlapsDock = textNodes.some(node => {
      const box = visibleBox(snapshot.chains, node)
      return dock !== undefined
        && box.start.x < dockRect[0] + dockRect[2] && box.start.x + box.span.x > dockRect[0]
        && box.start.y < dockRect[1] + dockRect[3] && box.start.y + box.span.y > dockRect[1]
    })
    const headClickable = visibleSpan(snapshot.chains, header, 'x') >= 4
      && visibleSpan(snapshot.chains, header, 'y') >= 4
    if (bodyVisible && headClickable && !textOverlapsDock) return { snapshot, header, textNodes }

    const main = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
    if (main === undefined) return undefined
    const mainRect = rect(main)
    const headerRect = rect(header)
    const clippedText = textNodes.find(node => !fullyVisible(snapshot.chains, node))
    const clippedRect = clippedText === undefined ? headerRect : rect(clippedText)
    const clippedBox = visibleBox(snapshot.chains, clippedText ?? header)
    const clippedAtTop = clippedBox.start.y > clippedRect[1] + 0.5
    const clippedAtBottom = clippedBox.start.y + clippedBox.span.y < clippedRect[1] + clippedRect[3] - 0.5
    if (textOverlapsDock) {
      const neededUp = Math.max(...textNodes.map(node => rect(node)[1] + rect(node)[3] - dockRect[1]))
      const scrollPoint = { x: mainRect[0] + mainRect[2] / 2, y: mainRect[1] + mainRect[3] / 2 }
      const amount = Math.min(180, Math.max(18, Math.ceil(neededUp + 6)))
      h.send('move', scrollPoint.x, scrollPoint.y)
      h.send('wheel', 0, amount)
      h.measure(`${label} real Main scroll target`, JSON.stringify({ scrollPoint, direction: 'up', amount, main: mainRect, dock: dockRect, target: clippedRect }))
    } else if (clippedAtTop || clippedAtBottom) {
      const key = clippedAtTop ? 'PageUp' : 'PageDown'
      await h.key(key, 250)
      h.measure(`${label} client viewport scroll key`, JSON.stringify({ key, header: headerRect, clipped: clippedBox }))
    } else {
      const scrollPoint = { x: mainRect[0] + mainRect[2] / 2, y: mainRect[1] + mainRect[3] / 2 }
      h.send('move', scrollPoint.x, scrollPoint.y)
      h.send('wheel', 0, clippedRect[1] < mainRect[1] + mainRect[3] / 2 ? 160 : -160)
      h.measure(`${label} real Main scroll target`, JSON.stringify({ scrollPoint, direction: 'nearest', main: mainRect, dock: dockRect, target: clippedRect }))
    }
    await h.sleep(120)
  }
  snapshot = h.snapshot()
  header = findHeader(snapshot)
  if (header === undefined) return undefined
  textNodes = snapshot.nodes.filter(node => snapshot.chains.get(node)?.includes(header)
    && typeof node.text === 'string' && node.text !== '')
  return { snapshot, header, textNodes }
}

export default async function (h) {
  const preset = presetFromEnvironment()
  const scenario = scenarioFromEnvironment()
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
  const extra = { preset, scenario, tern: ternVersion, sdk: '0.2.0', dsh: dshPin }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const subject = join(repo, 'scripts', 'tern-pane-transcript-modes-subject.mts')
  writeLedger(h, 'environment.json', {
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    host: { node: process.version, os: `${type()} ${osRelease()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    display: process.env.DISPLAY ?? null,
    preset,
    scenario,
    evidenceTier: innerDisclosureEvidenceTier(gui),
    sourceSnapshot: head,
  })

  h.check('the worktree uses npm DSH 0.2.2-rc.1 for Agent and Session',
    dshMode === 'npm' && dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin,
    JSON.stringify({ dshMode, dshPin, dshSessionPin }))
  h.check('the locked Tern SDK is 0.2.0 with recorded integrity', sdkIntegrity !== undefined,
    String(sdkIntegrity))
  h.measure('the Tern client binary identity for this run', JSON.stringify({ version: ternVersion, sha256: ternSha256 }))
  if (dshMode !== 'npm' || dshPin !== '0.2.2-rc.1' || dshSessionPin !== dshPin
    || sdkIntegrity === undefined) {
    finish(h, { ...extra, codeEvidenceOnly: true, qualification: 'NOT_RUN_BASELINE_MISMATCH' })
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

  if (scenario === 'ptc-error-note') {
    writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario })}\n`)
    const subjectStarted = await h.launch(subject)
    if (!subjectStarted || !await waitUntil(h, 'the official Direct PTC error-note Subject is ready', () => records(h).some(row =>
      row.kind === 'subject.ready' && row.scenario === scenario && row.mode === preset))) {
      finish(h, { ...extra, qualification: 'PTC_SUBJECT_NOT_READY' })
      return
    }
    if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
      records(h).some(row => row.kind === 'surface.inline.opened')
        && records(h).some(row => row.kind === 'renderer.observed')
        && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello'))) {
      finish(h, { ...extra, qualification: 'PTC_MOUNT_NOT_READY' })
      return
    }
    const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
    h.check('the pinned client negotiated native Tool nodes', hello?.kinds?.includes('tool'), JSON.stringify(hello?.kinds))
    const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
    const prompt = prompts.prompts[0]
    h.check('the PTC qualification marker is absent before the submit gesture', !h.texts(h.snapshot()).some(text => text.includes(prompt.marker)))
    h.send('type', JSON.stringify(prompt.text))
    await h.key('Return', 600)
    if (!await waitUntil(h, 'the actual Direct PTC root call and bash dispatch settle', () => {
      const observed = records(h).some(row => row.kind === 'producer.writer.settled')
      const live = foldLive(h)
      return observed && [...live.values()].some(node => node.k === 'tool' && node.p.name === 'run_code')
    }, 480)) {
      finish(h, { ...extra, qualification: 'PTC_FAILURE_NOT_RENDERED' })
      return
    }
    const observation = await runCase(h, 'observe-ptc-failure')
    h.check('the real Direct Folder recorded one successful-lifecycle PTC settle with nonzero exit', observation?.status === 'ok', JSON.stringify(observation?.facts ?? null))
    if (observation?.status !== 'ok') { finish(h, { ...extra, qualification: 'PTC_EVENTS_NOT_QUALIFIED' }); return }
    const facts = observation.facts
    const rootCallId = facts.rootCall.callId
    const subCallId = facts.childStart.subCallId
    h.check('the production run_code parent returns a concise curated result separate from the long Bash dispatch',
      typeof facts.parentOutput === 'string' && facts.parentOutput.length < 256
        && !facts.parentOutput.includes('PTC_BUILD_OUTPUT_'), JSON.stringify(facts.parentOutput))
    h.check('the real PTC output has long ordinary text and an official exit-code-2 tail',
      facts.output.startsWith('PTC_BUILD_OUTPUT_') && facts.output.endsWith('\n[exit code: 2]')
        && facts.childSettle.isError === false,
      JSON.stringify({ outputStart: facts.output.slice(0, 36), outputLength: facts.output.length,
        outputEnd: facts.output.slice(-32), isError: facts.childSettle.isError }))
    let live = foldLive(h)
    const root = [...live.values()].find(node => node.k === 'tool' && node.p.name === 'run_code')
    h.check('the current SDK tree contains the one production PTC parent Tool', root !== undefined, JSON.stringify(root ?? null))
    if (root === undefined) { finish(h, { ...extra, qualification: 'PTC_PARENT_NOT_FOUND' }); return }
    h.check('the production PTC parent starts collapsed and does not materialize its bash child',
      root.p.collapsible === true && root.p.collapsed === true
        && ![...live.values()].some(node => node.k === 'tool' && node.p.name === 'bash'),
      JSON.stringify(root.p))
    h.measure('current Tern nodes under the PTC parent before its disclosure opens', JSON.stringify(h.snapshot().nodes
      .filter(node => typeof node.id === 'string' && (node.id === root.id || node.id.startsWith(`${root.id}.`)))
      .map(node => ({ id: node.id, class: node.class, text: node.text, rect: node.rect }))))
    h.capture(`${preset}-ptc-parent-closed-before-scroll-1280x800-dark`,
      'current client tree around the real collapsed run_code parent before attempting to reveal its header')
    const parentWitness = await revealInnerHeader(h, 'PTC parent Tool', snapshot => snapshot.nodes.find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
        && h.descendantsText(node).includes('Qualify PTC note')))
    h.check('the current PTC parent Tool header is revealed and fully visible', parentWitness !== undefined
      && parentWitness.header !== undefined
      && parentWitness.textNodes.length > 0
      && parentWitness.textNodes.every(node => fullyVisible(parentWitness.snapshot.chains, node)),
      JSON.stringify(parentWitness?.header === undefined ? null : {
        text: h.descendantsText(parentWitness.header), rect: rect(parentWitness.header),
        textNodes: parentWitness.textNodes.map(node => ({ text: node.text, visible: visibleBox(parentWitness.snapshot.chains, node) })),
      }))
    if (parentWitness === undefined || parentWitness.header === undefined) {
      finish(h, { ...extra, qualification: 'PTC_PARENT_HEADER_NOT_VISIBLE' }); return
    }
    h.capture(`${preset}-ptc-parent-closed-1280x800-dark`, 'the real run_code parent is visibly closed before its nested bash child is admitted')
    await clickToggle(h, parentWitness.snapshot, parentWitness.header, root.id, false, 'PTC parent Tool')
    if (!await waitUntil(h, 'opening the exact PTC parent materializes its bash child', () =>
      foldLive(h).get(root.id)?.p.collapsed === false
        && [...foldLive(h).values()].some(node => node.k === 'tool' && node.p.name === 'bash'
          && typeof node.id === 'string' && node.id.endsWith(`.sub-${subCallId}`)))) {
      finish(h, { ...extra, qualification: 'PTC_CHILD_NOT_MATERIALIZED' }); return
    }
     live = foldLive(h)
     const child = [...live.values()].find(node => node.k === 'tool' && node.p.name === 'bash'
       && typeof node.id === 'string' && node.id.endsWith(`.sub-${subCallId}`))
     h.check('the exact current SDK tree contains the production PTC bash child', child !== undefined, JSON.stringify(child ?? null))
     if (child === undefined) { finish(h, { ...extra, qualification: 'PTC_CHILD_NOT_FOUND' }); return }
     h.check('the bash child is independently collapsed and displays the derived error',
       child.p.collapsible === true && child.p.collapsed === true && child.p.status === 'error', JSON.stringify(child.p))
     h.check('the collapsed PTC note preserves exit code 2 in a 48-character marker budget',
       typeof child.p.note === 'string' && child.p.note.includes('[exit code: 2]') && child.p.note.length <= 48,
       JSON.stringify({ id: child.id, status: child.p.status, note: child.p.note, length: child.p.note?.length }))
     h.check('the complete child result is not materialized while its disclosure remains closed', !live.has(`${child.id}.result`))
     const childHeaderCandidates = snapshot => mainNodes(snapshot)
       .filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head'))
       .map(node => ({ text: h.descendantsText(node), rect: rect(node) }))
     h.measure('current client Tool headers after the exact parent opens', JSON.stringify(childHeaderCandidates(h.snapshot())))
     const childHeadWitness = await revealInnerHeader(h, 'collapsed PTC bash error', snapshot => snapshot.nodes.find(node =>
       String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
         && h.descendantsText(node).includes('Bash')
         && h.descendantsText(node).includes('[exit code: 2]')))
    const childSnapshot = childHeadWitness?.snapshot
    const childHead = childHeadWitness?.header
    const noteTextNode = childHeadWitness?.textNodes.find(node => String(node.text).includes('[exit code: 2]'))
    h.check('the failed PTC child header is revealed and its complete note is client-visible', childSnapshot !== undefined
      && childHead !== undefined && noteTextNode !== undefined
      && fullyVisible(childSnapshot.chains, noteTextNode)
      && visibleSpan(childSnapshot.chains, childHead, 'x') >= 4
      && visibleSpan(childSnapshot.chains, childHead, 'y') >= 4,
      JSON.stringify({ childHead: childHead === undefined ? null : { text: h.descendantsText(childHead), rect: rect(childHead) },
        note: noteTextNode === undefined ? null : { text: noteTextNode.text, rect: rect(noteTextNode), visible: visibleBox(childSnapshot.chains, noteTextNode) } }))
    if (childSnapshot === undefined || childHead === undefined || noteTextNode === undefined) {
      finish(h, { ...extra, qualification: 'PTC_CHILD_NOTE_NOT_VISIBLE' }); return
    }
    h.capture(`${preset}-ptc-error-note-closed-1280x800-dark`,
      'the real Folder PTC bash child is failed and independently collapsed; its bounded exit-code note is painted while its result body is absent')
    const noteTree = childSnapshot.nodes.map(node => ({ text: node.text, class: node.class, rect: node.rect }))
    writeLedger(h, 'ptc-error-note-client-tree.json', {
      sourceSnapshot: head, preset, rootId: root.id, childId: child.id,
      displayStatus: child.p.status, note: child.p.note,
      bodyAbsent: !live.has(`${child.id}.result`), sessionFacts: facts, noteTree,
    })
    const ptcViewportEvidence = [{ width: 1280, height: 800, appearance: 'dark', header: childHeadWitness.header, note: noteTextNode }]
    for (const viewport of [
      { width: 900, height: 360, appearance: 'light' },
      { width: 400, height: 600, appearance: 'dark' },
    ]) {
      await h.resize(viewport.width, viewport.height)
      if (!gui) h.send('appearance', viewport.appearance)
      h.check(`the PTC note client uses ${viewport.width}x${viewport.height} ${viewport.appearance}`,
        JSON.stringify(h.ctl('stats').viewport?.slice(0, 2)) === JSON.stringify([viewport.width, viewport.height])
          && (gui || h.ctl('state').theme === viewport.appearance),
        JSON.stringify({ viewport: h.ctl('stats').viewport, theme: h.ctl('state').theme }))
      const witness = await revealInnerHeader(h, `${viewport.width}x${viewport.height} collapsed PTC bash error`, snapshot =>
        snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
          && h.descendantsText(node).includes('Bash') && h.descendantsText(node).includes('[exit code: 2]')))
      const noteNode = witness?.textNodes.find(node => String(node.text).includes('[exit code: 2]'))
      const currentChild = foldLive(h).get(child.id)
      h.check(`the PTC exit note is completely visible and the full body remains closed at ${viewport.width}x${viewport.height}`,
        witness !== undefined && witness.header !== undefined && noteNode !== undefined
          && currentChild?.p.status === 'error' && currentChild.p.collapsed === true
          && !foldLive(h).has(`${child.id}.result`)
          && witness.textNodes.every(node => fullyVisible(witness.snapshot.chains, node))
          && visibleSpan(witness.snapshot.chains, witness.header, 'x') >= 4
          && visibleSpan(witness.snapshot.chains, witness.header, 'y') >= 4,
        JSON.stringify({ child: currentChild,
          header: witness?.header === undefined ? null : { text: h.descendantsText(witness.header), rect: rect(witness.header) },
          note: noteNode === undefined ? null : { text: noteNode.text, rect: rect(noteNode), visible: visibleBox(witness.snapshot.chains, noteNode) } }))
      if (witness === undefined || witness.header === undefined || noteNode === undefined) {
        finish(h, { ...extra, qualification: `PTC_NOTE_NOT_VISIBLE_${viewport.width}x${viewport.height}` }); return
      }
      const captureName = `${preset}-ptc-error-note-closed-${viewport.width}x${viewport.height}-${viewport.appearance}`
      h.capture(captureName, `the official PTC bash child error marker is visible in the collapsed Tern header at ${viewport.width}x${viewport.height} ${viewport.appearance}`)
      ptcViewportEvidence.push({ width: viewport.width, height: viewport.height, appearance: viewport.appearance,
        header: witness.header, note: noteNode })
    }
    writeLedger(h, 'ptc-error-note-viewport-matrix.json', ptcViewportEvidence.map(entry => ({
      width: entry.width, height: entry.height, appearance: entry.appearance,
      header: entry.header, note: entry.note,
    })))
    writeLedger(h, 'ptc-error-note-evidence.json', {
      sourceSnapshot: head, preset, viewport: h.ctl('stats').viewport, theme: h.ctl('state').theme,
      sdk: { pin: '0.2.0', integrity: sdkIntegrity }, dsh: { mode: dshMode, pin: dshPin },
      provenance: 'real Direct writer -> real run_code Agent tool call -> official PTC executor -> official bash tool binding -> test-controlled shell result -> durable tool/ptc-dispatch-start + tool/ptc-dispatch -> TranscriptFolder/subCallDisplay -> TSP ui.tool -> pinned Tern tree and PNG',
      qualificationStandIns: ['the model stream uses a deterministic scripted tool call', 'the PTC runtime test adapter invokes the official tools.bash binding without interpreting source code', 'the shell provider returns deterministic long stdout and exit code 2; no OS process is spawned'],
      rootId: root.id, childId: child.id, displayStatus: child.p.status,
      note: child.p.note, sourceOutput: facts.output, isError: facts.childSettle.isError,
      bodyAbsent: !live.has(`${child.id}.result`),
      viewportMatrix: [
        { width: 1280, height: 800, appearance: 'dark' },
        { width: 900, height: 360, appearance: 'light' },
        { width: 400, height: 600, appearance: 'dark' },
      ],
      evidenceTier: innerDisclosureEvidenceTier(gui),
      notVerified: ['OS physical keyboard/IME/wheel', 'G8 Owner visual signature'],
    })
    finish(h, { ...extra, qualification: qualificationFromResults(h.results) })
    return
  }

  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario })}\n`)
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct inner-disclosure Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'inner-disclosure' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
      && records(h).some(row => row.kind === 'fixture.ready'
        && row.scenario === 'inner-disclosure' && row.mode === preset))) {
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
  let liveThinkingId
  let liveWorkId
  if (!await waitUntil(h, 'the real Direct Agent is holding its second reasoning delta', () =>
    records(h).some(row => row.kind === 'subject.reasoning.second-held' && row.step === 0 && row.deltaIndex === 1))) {
    finish(h, { ...extra, qualification: 'SECOND_REASONING_NOT_HELD' })
    return
  }
  let live = foldLive(h)
  if (preset === 'full' || preset === 'compact') {
    live = foldLive(h)
    if (preset === 'compact') {
      const currentWork = [...live.values()].find(node => node.k === 'section' && String(node.p.key).includes('work-'))
      h.check('Compact materializes its current Work before the live Thinking member', currentWork !== undefined,
        JSON.stringify(currentWork ?? null))
      if (currentWork === undefined) { finish(h, { ...extra, qualification: 'LIVE_WORK_NOT_MATERIALIZED' }); return }
      liveWorkId = currentWork.id
      if (currentWork.p.collapsed === true) {
        const workSnapshot = h.snapshot()
        const workHead = mainNodes(workSnapshot).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
          && (h.descendantsText(node).includes('Activity') || h.descendantsText(node).includes('Thought')))
        await clickToggle(h, workSnapshot, workHead, liveWorkId, false, 'live Compact Work')
        if (!await waitUntil(h, 'the current Compact Work opens before its live Thinking row is targeted', () =>
          foldLive(h).get(liveWorkId)?.p.collapsed === false)) {
          finish(h, { ...extra, qualification: 'LIVE_WORK_NOT_OPEN' })
          return
        }
      }
      live = foldLive(h)
    }
    if (!await waitUntil(h, 'the first live reasoning prefix reaches the exact native Thinking Section', () =>
      [...foldLive(h).values()].some(node => node.k === 'section'
        && /^(?:s\d+-)?msg-\d+$/u.test(String(node.p.key))
        && subtreeText(foldLive(h), node.id).includes('checking the first row')))) {
      finish(h, { ...extra, qualification: 'FIRST_REASONING_NOT_MATERIALIZED' })
      return
    }
    const liveThinking = [...live.values()].find(node => node.k === 'section'
      && /^(?:s\d+-)?msg-\d+$/u.test(String(node.p.key))
      && subtreeText(live, node.id).includes('checking the first row'))
    h.check('the live reasoning prefix has an exact canonical Thinking row in the current pane', liveThinking !== undefined,
      JSON.stringify(liveThinking ?? null))
    if (liveThinking === undefined) { finish(h, { ...extra, qualification: 'LIVE_THINKING_NOT_MATERIALIZED' }); return }
    liveThinkingId = liveThinking.id
    h.check('the exact current Thinking owner starts independently collapsed',
      liveThinking.p.collapsible === true && liveThinking.p.collapsed === true, JSON.stringify(liveThinking.p))
    const liveThinkingSnapshot = h.snapshot()
    const liveThinkingHead = mainNodes(liveThinkingSnapshot).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('checking the first row'))
    await clickToggle(h, liveThinkingSnapshot, liveThinkingHead, liveThinkingId, false, 'live Thinking')
    if (!await waitUntil(h, 'the exact Thinking body opens before the next official reasoning delta', () => {
      const now = foldLive(h)
      const body = now.get(`${liveThinkingId}.body`)
      return now.get(liveThinkingId)?.p.collapsed === false
        && typeof body?.p.text === 'string'
        && body.p.text.includes('checking the first row')
    })) {
      finish(h, { ...extra, qualification: 'LIVE_THINKING_BODY_NOT_OPEN' })
      return
    }
    const firstBody = foldLive(h).get(`${liveThinkingId}.body`)
    h.check('the first live source chunk is visible in the open body while the second chunk is still held',
      typeof firstBody?.p.text === 'string' && firstBody.p.text.includes('checking the first row')
        && firstBody.p.stream === true,
      JSON.stringify(firstBody ?? null))
    h.check('no durable Tool node exists while only the reasoning prefix is live',
      ![...foldLive(h).values()].some(node => node.k === 'tool'))
    const releaseReasoning = await runCase(h, 'release-reasoning')
    h.check('the real Direct Subject released the official second reasoning delta from its barrier',
      releaseReasoning?.status === 'ok', JSON.stringify(releaseReasoning ?? null))
    if (!await waitUntil(h, 'the same open real-client Thinking body advances to the second source chunk', () => {
      const current = foldLive(h)
      const body = current.get(`${liveThinkingId}.body`)
      return current.get(liveThinkingId)?.p.collapsed === false
        && typeof body?.p.text === 'string'
        && body.p.text.includes('latest reasoning line')
    })) {
      finish(h, { ...extra, qualification: 'LIVE_THINKING_SECOND_DELTA_NOT_VISIBLE' })
      return
    }
    live = foldLive(h)
    const advancedBody = live.get(`${liveThinkingId}.body`)
    h.check('the same real SDK Section id remains open and its body follows both live reasoning chunks',
      live.get(liveThinkingId)?.p.collapsed === false
        && typeof advancedBody?.p.text === 'string'
        && advancedBody.p.text.includes('checking the first row\nlatest reasoning line')
        && advancedBody.p.stream === true,
      JSON.stringify({ id: liveThinkingId, section: live.get(liveThinkingId), body: advancedBody }))
    h.capture(`${preset}-thinking-open-after-live-delta-1280x800-dark`,
      'the native Tern body opened after the first real Direct reasoning chunk and advanced on the held second chunk')
  } else {
    const releaseReasoning = await runCase(h, 'release-reasoning')
    h.check('the real Direct Subject released the Focus reasoning gate before Preparing',
      releaseReasoning?.status === 'ok', JSON.stringify(releaseReasoning ?? null))
  }
  if (!await waitUntil(h, 'the production Direct stream reached transient Preparing', () =>
    h.texts(h.snapshot()).some(text => text.includes('Preparing')))) {
    finish(h, { ...extra, qualification: 'PREPARING_NOT_VISIBLE' })
    return
  }
  live = foldLive(h)
  let rootId
  let workId = liveWorkId
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
  const thinkingAlreadyOpenForLiveDelta = liveThinkingId === reasoningId
  h.check(thinkingAlreadyOpenForLiveDelta
    ? 'the real Tern already materialized this same Thinking body before the second live source chunk'
    : 'collapsed Thinking has no body node in the official SDK wire tree',
  thinkingAlreadyOpenForLiveDelta ? rootBefore.has(closedBodyId) : !rootBefore.has(closedBodyId))

  const currentThinking = live.get(reasoningId)
  h.check('the already-authorized current Thinking has the exact canonical SDK id', currentThinking !== undefined && currentThinking.k === 'section')
  const currentThinkingHead = h.snapshot()
  const visibleThinkingHead = mainNodes(currentThinkingHead).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
    && h.descendantsText(node).includes('latest reasoning line'))
  if (thinkingAlreadyOpenForLiveDelta) {
    h.check('same-source reasoning projection retained the live-open Section and body after the latest chunk',
      currentThinking?.p.collapsed === false && rootBefore.get(closedBodyId)?.p.text?.includes('latest reasoning line') === true,
      JSON.stringify({ section: currentThinking, body: rootBefore.get(closedBodyId) }))
  } else {
    h.check('the collapsed Thinking summary is physically visible before its body opens', visibleThinkingHead !== undefined
      && visibleSpan(currentThinkingHead.chains, visibleThinkingHead, 'x') >= 4 && visibleSpan(currentThinkingHead.chains, visibleThinkingHead, 'y') >= 4,
    JSON.stringify(visibleThinkingHead === undefined ? null : { rect: rect(visibleThinkingHead), x: visibleSpan(currentThinkingHead.chains, visibleThinkingHead, 'x'), y: visibleSpan(currentThinkingHead.chains, visibleThinkingHead, 'y') }))
    h.capture(`${preset}-thinking-closed-1280x800-dark`, 'the exact Thinking body remains absent before its native header opens')
    await clickToggle(h, currentThinkingHead, visibleThinkingHead, reasoningId, false, 'Thinking')
    if (!await waitUntil(h, 'the opened Thinking body is materialized', () => foldLive(h).has(`${reasoningId}.body`))) {
      finish(h, { ...extra, qualification: 'THINKING_BODY_NOT_OPEN' })
      return
    }
  }
  writeLedger(h, 'thinking-toggle.json', { id: reasoningId,
    event: records(h).filter(row => row.kind === 'client.toggle').findLast(row => row.id === reasoningId),
    body: foldLive(h).get(`${reasoningId}.body`), liveOpenedBeforeSecondChunk: thinkingAlreadyOpenForLiveDelta })
  h.capture(`${preset}-thinking-open-1280x800-dark`, 'the same canonical Thinking Section is open in the real Tern client')

  const contextResult = await runCase(h, 'append-context')
  h.check('two official same-turn snapshot Context events were appended for the open Direct turn', contextResult?.status === 'ok', JSON.stringify(contextResult ?? null))
  let cluster
  const contextOwnerIds = []
  const contextMemberIds = []
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
    const clusterHeadText = snapshot => mainNodes(snapshot).find(node => isSectionHead(node)
      && h.descendantsText(node).includes('inner-context-0')
      && h.descendantsText(node).includes('inner-context-1'))
    const contextSnap = h.snapshot()
    const contextHead = clusterHeadText(contextSnap)
    h.capture(`${preset}-context-cluster-closed-1280x800-dark`, 'the canonical Cluster body remains absent before its native header opens')
    await clickToggle(h, contextSnap, contextHead, cluster.id, false, 'Context Cluster')
    if (!await waitUntil(h, 'the Cluster member Sections enter the current wire tree', () =>
      contextMemberNodes(h, cluster.id).length === 2)) {
      finish(h, { ...extra, qualification: 'CONTEXT_MEMBERS_NOT_MATERIALIZED' })
      return
    }
    let contextMembers = contextMemberNodes(h, cluster.id)
    h.check('opening the canonical Cluster shows both eligible member Sections independently collapsed',
      contextMembers.length === 2
        && contextMembers.every(member => member.p.collapsible === true && member.p.collapsed === true)
        && contextMembers.every(member => !memberBodyPresent(h, member)),
      JSON.stringify(contextMembers.map(member => ({ id: member.id, p: member.p }))))
    h.capture(`${preset}-context-members-closed-1280x800-dark`,
      'the canonical Cluster exposes two independently collapsed native member headers and no body')

    const memberHeader = async (member, label) => {
      const witness = await revealInnerHeader(h, label, snapshot => mainNodes(snapshot).find(node =>
        isSectionHead(node) && h.descendantsText(node).includes(String(member.p.head))))
      return witness
    }
    const openMember = async (member, label) => {
      const witness = await memberHeader(member, label)
      await clickToggle(h, witness.snapshot, witness.header, member.id, false, label)
      if (!await waitUntil(h, `${label} materializes only its own body`, () => memberBodyPresent(h, member))) {
        finish(h, { ...extra, qualification: 'CONTEXT_MEMBER_BODY_NOT_OPEN' })
        return false
      }
      return true
    }
    const memberA = contextMembers[0]
    const memberB = contextMembers[1]
    if (!await openMember(memberA, 'Context member A')) return
    h.check('opening member A does not open its sibling or leak the other payload',
      memberBodyPresent(h, memberA) && !memberBodyPresent(h, memberB)
        && !h.texts(h.snapshot()).some(text => text.includes('second native context detail')),
      JSON.stringify({ A: memberA.p, B: memberB.p }))
    if (!await openMember(memberB, 'Context member B')) return
    h.check('member B opens independently with its own exact node id',
      memberBodyPresent(h, memberA) && memberBodyPresent(h, memberB)
        && h.texts(h.snapshot()).some(text => text.includes('first native context detail'))
        && h.texts(h.snapshot()).some(text => text.includes('continuous context detail'))
        && h.texts(h.snapshot()).some(text => text.includes('second native context detail')))
    h.capture(`${preset}-context-members-open-1280x800-dark`,
      'both member bodies are readable after their own native disclosure opens')

    const closeMember = async (member, label) => {
      const witness = await memberHeader(member, label)
      await clickToggle(h, witness.snapshot, witness.header, member.id, true, label)
      if (!await waitUntil(h, `${label} retires only its own body`, () => !memberBodyPresent(h, member))) {
        finish(h, { ...extra, qualification: 'CONTEXT_MEMBER_BODY_NOT_CLOSED' })
        return false
      }
      return true
    }
    if (!await closeMember(memberA, 'Context member A')) return
    h.check('closing member A keeps the sibling body open and the Cluster untouched',
      !memberBodyPresent(h, memberA) && memberBodyPresent(h, memberB)
        && foldLive(h).get(cluster.id)?.p.collapsed === false,
      JSON.stringify({ cluster: foldLive(h).get(cluster.id)?.p, A: foldLive(h).get(memberA.id)?.p, B: foldLive(h).get(memberB.id)?.p }))

    const closeCluster = async () => {
      const witness = await revealInnerHeader(h, 'Context Cluster close', snapshot => clusterHeadText(snapshot))
      await clickToggle(h, witness.snapshot, witness.header, cluster.id, true, 'Context Cluster close')
      return await waitUntil(h, 'the closed Cluster retires both member nodes', () =>
        contextMemberNodes(h, cluster.id).length === 0)
    }
    if (!await closeCluster()) { finish(h, { ...extra, qualification: 'CONTEXT_CLUSTER_NOT_CLOSED' }); return }
    const reopenCluster = async () => {
      const witness = await revealInnerHeader(h, 'Context Cluster reopen', snapshot => clusterHeadText(snapshot))
      await clickToggle(h, witness.snapshot, witness.header, cluster.id, false, 'Context Cluster reopen')
      return await waitUntil(h, 'the reopened Cluster restores both member nodes', () =>
        contextMemberNodes(h, cluster.id).length === 2)
    }
    if (!await reopenCluster()) { finish(h, { ...extra, qualification: 'CONTEXT_CLUSTER_NOT_REOPENED' }); return }
    contextMembers = contextMemberNodes(h, cluster.id)
    const restoredA = contextMembers.find(member => member.id === memberA.id)
    const restoredB = contextMembers.find(member => member.id === memberB.id)
    h.check('closing and reopening the Cluster restores each member manual state',
      restoredA?.p.collapsed === true && !memberBodyPresent(h, restoredA)
        && restoredB?.p.collapsed === false && memberBodyPresent(h, restoredB),
      JSON.stringify({ A: restoredA?.p, B: restoredB?.p }))
    contextMemberIds.push(restoredA.id, restoredB.id)
    h.capture(`${preset}-context-members-restored-1280x800-dark`,
      'the reopened canonical Cluster restores member B open and member A closed')
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
    const focusClusterHead = snapshot => mainNodes(snapshot).find(node => isSectionHead(node)
      && h.descendantsText(node).includes('inner-context-0')
      && h.descendantsText(node).includes('inner-context-1'))
    const clickFocusCluster = async (collapsed, label) => {
      const snap = h.snapshot()
      await clickToggle(h, snap, focusClusterHead(snap), cluster.id, collapsed, label)
      return await waitUntil(h, label, () => collapsed
        ? contextMemberNodes(h, cluster.id).length === 0
        : contextMemberNodes(h, cluster.id).length === 2)
    }
    if (!await clickFocusCluster(false, 'settled Focus Context Cluster')) {
      finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_MEMBERS_NOT_MATERIALIZED' })
      return
    }
    let focusMembers = contextMemberNodes(h, cluster.id)
    h.check('the settled Focus members inherit the same message owners already opened as rows',
      focusMembers.length === 2
        && focusMembers.every(member => member.p.collapsible === true && member.p.collapsed === false)
        && focusMembers.every(member => memberBodyPresent(h, member)),
      JSON.stringify(focusMembers.map(member => ({ id: member.id, p: member.p }))))
    h.capture('focus-settled-context-members-open-1280x800-dark',
      'settled Focus members show the persisted shared owner preference, not a second state')
    const focusMemberA = focusMembers[0]
    const witnessA = await revealInnerHeader(h, 'settled Focus Context member A', snapshot => mainNodes(snapshot).find(node =>
      isSectionHead(node) && h.descendantsText(node).includes(String(focusMemberA.p.head))))
    await clickToggle(h, witnessA.snapshot, witnessA.header, focusMemberA.id, true, 'settled Focus Context member A')
    if (!await waitUntil(h, 'settled member A closes while member B keeps its body', () =>
      !memberBodyPresent(h, focusMemberA) && memberBodyPresent(h, focusMembers[1]))) {
      finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_MEMBER_NOT_CLOSED' })
      return
    }
    if (!await clickFocusCluster(true, 'settled Focus Context Cluster close')) {
      finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_CLUSTER_NOT_CLOSED' })
      return
    }
    if (!await clickFocusCluster(false, 'settled Focus Context Cluster reopen')) {
      finish(h, { ...extra, qualification: 'FOCUS_SETTLED_CONTEXT_CLUSTER_NOT_REOPENED' })
      return
    }
    focusMembers = contextMemberNodes(h, cluster.id)
    const reopenedFocusA = focusMembers.find(member => member.id === focusMemberA.id)
    const reopenedFocusB = focusMembers.find(member => member.id === focusMembers[1].id)
    h.check('closing and reopening the settled Cluster restores each Focus member owner',
      reopenedFocusA?.p.collapsed === true && !memberBodyPresent(h, reopenedFocusA)
        && reopenedFocusB?.p.collapsed === false && memberBodyPresent(h, reopenedFocusB),
      JSON.stringify({ A: reopenedFocusA?.p, B: reopenedFocusB?.p }))
    contextMemberIds.push(reopenedFocusA.id, reopenedFocusB.id)
    h.capture('focus-settled-context-members-restored-1280x800-dark',
      'the reopened settled Focus Cluster restores member B open and member A closed')
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
  // Full/Compact open both members through their own native headers. Focus
  // proves the SAME message owner was already toggled as a standalone Row, so
  // one member-header toggle is the member-level proof (the other member kept
  // that owner's state).
  const memberToggleIdentity = contextMemberIds.length === 2
    && (preset === 'focus'
      ? contextMemberIds.some(id => toggles.some(row => row.id === id))
      : contextMemberIds.every(id => toggles.some(row => row.id === id)))
  h.check(`client toggle ledger contains the exact Thinking, Tool, ${preset === 'focus' ? 'Context Row' : 'Context Cluster'} and Context member ids`,
    toggles.some(row => row.id === reasoningId)
      && tool !== undefined && toggles.some(row => row.id === tool.id)
      && contextToggleIdentity && memberToggleIdentity,
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
  // A retained Context row may legitimately move from a standalone Cluster into
  // a Work-nested one (its node ancestry, and therefore its id, changes while
  // the message OBJECT — the disclosure owner — stays the same).
  const retainedMembers = retainedCluster === undefined ? [] : contextMemberNodes(h, retainedCluster.id)
  const retainedMember = label => retainedMembers.find(member => String(member.p?.head ?? '').startsWith(label))
  const retainedMemberState = (label, collapsed) => {
    const member = retainedMember(label)
    if (member === undefined) return false
    return member.p.collapsed === collapsed
      && (collapsed ? !live.has(`${member.id}.body`) : live.has(`${member.id}.body`))
  }
  const memberStatesRemain = retainedMemberState('inner-context-0', true)
    && retainedMemberState('inner-context-1', false)
  h.check('same-source repaint preserves the opened Tool and canonical Context disclosure facts',
    tool !== undefined && live.get(tool.id)?.p['collapsed'] === false && contextOwnersRemainOpen && memberStatesRemain,
    JSON.stringify({ members: retainedMembers.map(member => ({ id: member.id, head: member.p.head,
      collapsed: member.p.collapsed, body: live.has(`${member.id}.body`) })) }))

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

    const innerHeaders = [
      {
        name: 'thinking',
        find: tree => mainNodes(tree).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
          && h.descendantsText(node).includes('Thinking') && h.descendantsText(node).includes('latest reasoning line')),
      },
      {
        name: 'tool',
        find: tree => mainNodes(tree).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
          && h.descendantsText(node).includes('job_list')),
      },
      {
        name: 'context',
        find: tree => mainNodes(tree).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
          && (h.descendantsText(node).includes('inner-context-0') || h.descendantsText(node).includes('runtime-context'))),
      },
      {
        name: 'context-member',
        find: tree => mainNodes(tree).find(node => isSectionHead(node)
          && h.descendantsText(node).includes('inner-context-0 · ambient')),
      },
    ]
    const innerGeometry = {}
    for (const target of innerHeaders) {
      const witness = await revealInnerHeader(h, target.name, target.find)
      const geometrySnapshot = witness?.snapshot
      const header = witness?.header
      const textNodes = witness?.textNodes ?? []
      const textsFullyVisible = textNodes.length > 0
        && textNodes.every(node => fullyVisible(geometrySnapshot.chains, node))
      const clickableFragment = header !== undefined
        && visibleSpan(geometrySnapshot.chains, header, 'x') >= 4
        && visibleSpan(geometrySnapshot.chains, header, 'y') >= 4
      const currentDock = geometrySnapshot?.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-dock'))
      const dockRect = rect(currentDock ?? {})
      const overlap = textNodes.filter(node => {
        const box = visibleBox(geometrySnapshot.chains, node)
        return currentDock !== undefined
          && box.start.x < dockRect[0] + dockRect[2] && box.start.x + box.span.x > dockRect[0]
          && box.start.y < dockRect[1] + dockRect[3] && box.start.y + box.span.y > dockRect[1]
      }).map(node => ({ text: node.text, rect: rect(node), visible: visibleBox(geometrySnapshot.chains, node) }))
      const clearOfDock = currentDock !== undefined && overlap.length === 0
      h.check(`${target.name} inner header text is fully visible and separate from Dock at ${viewport.width}x${viewport.height}`,
        textsFullyVisible && clickableFragment && clearOfDock,
        JSON.stringify({ header: header === undefined ? null : h.descendantsText(header),
          headerRect: header === undefined ? null : rect(header),
          textNodes: textNodes.map(node => ({ text: node.text, rect: rect(node), visible: visibleBox(geometrySnapshot.chains, node) })),
          dock: currentDock === undefined ? null : dockRect, overlap }))
      if (header !== undefined) {
        h.capture(`${preset}-${viewport.width}x${viewport.height}-${target.name}-header`,
          `fully visible native ${target.name} disclosure header, separated from the Dock and Composer`)
      }
      innerGeometry[target.name] = { fullyVisible: textsFullyVisible, clickable: clickableFragment, dockOverlapCount: overlap.length }
    }

    const dockSnapshot = h.snapshot()
    const completeDock = dockSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-dock'))
    const composer = dockSnapshot.nodes.find(node => node.role === 'textbox'
      && String(node.class ?? '').split(/\s+/u).includes('sf-editor'))
    const sendButton = dockSnapshot.nodes.find(node => node.tag === 'button'
      && String(node.title ?? '').includes('Type a message to send'))
    const dockComposerComplete = completeDock !== undefined && composer !== undefined && sendButton !== undefined
      && fullyVisible(dockSnapshot.chains, completeDock)
      && fullyVisible(dockSnapshot.chains, composer)
      && fullyVisible(dockSnapshot.chains, sendButton)
    h.check(`Dock, Composer and Send action are fully inside the viewport at ${viewport.width}x${viewport.height}`,
      dockComposerComplete,
      JSON.stringify({ dock: completeDock === undefined ? null : { rect: rect(completeDock), visible: visibleBox(dockSnapshot.chains, completeDock) },
        composer: composer === undefined ? null : { rect: rect(composer), fullyVisible: fullyVisible(dockSnapshot.chains, composer) },
        send: sendButton === undefined ? null : { rect: rect(sendButton), fullyVisible: fullyVisible(dockSnapshot.chains, sendButton) } }))
    const capture = h.capture(`${preset}-${viewport.width}x${viewport.height}-${viewport.appearance}`, 'open native Thinking, Tool and Context disclosures')
    matrix.push({ requested: [viewport.width, viewport.height], actual: h.ctl('stats').viewport, theme, capture,
      sectionHeaders: fragments, innerGeometry, dockComposerComplete })
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
    contextMembers: (retainedCluster === undefined ? [] : contextMemberNodes(h, retainedCluster.id)).map(member => ({
      id: member.id,
      head: member.p.head,
      collapsed: member.p.collapsed,
      bodyPresent: foldLive(h).has(`${member.id}.body`),
    })),
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
