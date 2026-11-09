import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, type } from 'node:os'
import { join } from 'node:path'
import { rect, visibleSpan } from './tern-pane-geometry.mjs'

const IS_GUI = process.env.TERN_FOCUS_GUI === '1'
const SCENARIO = process.env.TERN_FOCUS_CASE ?? 'svg'
const PINNED_TERN = 'tern 0.9.13 (8c6dfbd)'
const PINNED_TERN_SHA256 = 'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99'
if (SCENARIO !== 'svg' && SCENARIO !== 'image' && SCENARIO !== 'question') throw new Error(`unknown Focus Tern case ${SCENARIO}`)
export function focusEvidenceTier(isGui) {
  return `${isGui ? 'REAL_TERN_GUI' : 'REAL_TERN_HEADLESS'} + CONTROL_INJECTED_INPUT + official Direct application`
}
export function isPinnedFocusClient(version, sha256) {
  return version === PINNED_TERN && sha256 === PINNED_TERN_SHA256
}
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]

function jsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const records = h => jsonl(join(h.root, 'events.jsonl')).filter(row => row.scenario === SCENARIO)
const wire = h => jsonl(join(h.root, 'sdk-wire.jsonl'))
const blobWrites = h => wire(h).filter(row => row.dir === 'out' && row.verb === 'b')
const liveNodes = h => {
  const nodes = new Map()
  const add = node => {
    const current = nodes.get(node.id) ?? { k: node.k, p: {}, children: [] }
    current.k = node.k
    current.p = { ...current.p, ...(node.p ?? {}) }
    nodes.set(node.id, current)
    for (const child of node.c ?? []) {
      add(child)
      current.children.push(child.id)
    }
  }
  const drop = id => {
    for (const key of [...nodes.keys()]) if (key === id || key.startsWith(`${id}.`)) nodes.delete(key)
  }
  for (const entry of wire(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') add(op[4])
      else if (op[0] === 'del') drop(op[1])
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p = { ...node.p, ...(op[2] ?? {}) }
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p.text = op[2] === 'append'
          ? `${String(node.p.text ?? '')}${String(op[3] ?? '')}`
          : String(op[3] ?? '')
      }
    }
  }
  return nodes
}
const subtreeText = (nodes, id) => {
  const out = []
  const visit = key => {
    const node = nodes.get(key)
    if (node === undefined) return
    if (typeof node.p.text === 'string') out.push(node.p.text)
    for (const child of node.children) visit(child)
  }
  visit(id)
  return out.join(' ')
}
const eventRows = h => records(h).filter(row => row.kind === 'client.toggle')
const mainRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const mainNodes = snapshot => {
  const main = mainRegion(snapshot)
  if (main === undefined) return []
  const out = []
  const visit = node => {
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(main)
  return out
}
const rootIds = live => [...live.entries()]
  .filter(([id, node]) => id.startsWith('main.') && node.k === 'section' && node.p.collapsible === true && String(node.p.key ?? '').includes('-focus-'))
  .map(([id]) => id)
const workIds = (live, rootId) => [...live.entries()]
  .filter(([id, node]) => id.startsWith(`${rootId}.`) && node.k === 'section' && node.p.collapsible === true && String(node.p.key ?? '').includes('-work-'))
  .map(([id]) => id)
const visibleSectionHead = (snapshot, h, identity) => mainNodes(snapshot)
  .find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
    && h.descendantsText(node).includes(identity))

async function waitFor(h, label, predicate, limit = 300) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  h.check(label, false, `timed out; text=${h.texts(h.snapshot()).join(' | ').slice(0, 500)}`)
  return false
}
async function submit(h, text) {
  h.send('type', JSON.stringify(text))
  await h.key('Return', 600)
}
function writeLedger(h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
}
function finish(h, extra) {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary for this qualification')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const ternSha256 = createHash('sha256').update(readFileSync(ternBin)).digest('hex')
  const packageJson = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const dshMode = JSON.parse(readFileSync(join(h.repo, 'test/compat/dsh-mode.json'), 'utf8')).mode
  const dshPin = packageJson.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = packageJson.devDependencies?.['@deepseek-ai/dsh-session']
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1]
  const extra = { tern: ternVersion, sdk: '0.2.0', dsh: dshPin }
  h.check('the worktree uses the plan-pinned DSH npm runtime',
    dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin && dshMode === 'npm',
    JSON.stringify({ dshPin, dshSessionPin, dshMode }))
  h.check('the lockfile carries the pinned Tern SDK integrity', sdkIntegrity !== undefined, String(sdkIntegrity))
  if (!isPinnedFocusClient(ternVersion, ternSha256)) {
    h.check('the requested Tern client binary is exactly 0.9.13 (8c6dfbd) with the plan-pinned SHA-256', false,
      JSON.stringify({ expectedVersion: PINNED_TERN, actualVersion: ternVersion, expectedSha256: PINNED_TERN_SHA256, actualSha256: ternSha256 }))
    finish(h, extra)
    return
  }
  h.check('the requested Tern client binary is exactly 0.9.13 (8c6dfbd) with the plan-pinned SHA-256', true,
    JSON.stringify({ version: ternVersion, sha256: ternSha256 }))

  if (IS_GUI) {
    const system = h.ctl('system')
    h.check('the Focus qualification runs in a real Tern GUI window on a display',
      (system.displays ?? []).length > 0 && typeof system.title === 'string',
      JSON.stringify({ title: system.title, displays: system.displays }))
  }
  const initialSize = await h.resize(1280, 800)
  if (IS_GUI) h.check('the GUI window took the requested qualification viewport', initialSize.clamped === false, JSON.stringify(initialSize))
  if (IS_GUI) {
    const initialTheme = h.ctl('state').theme
    if (initialTheme !== 'dark') h.send('plugins', 'run', 'appearance:dark')
    h.check('Tern GUI saved and resolved dark appearance', h.ctl('state').theme === 'dark', h.ctl('state').theme)
  } else {
    h.send('appearance', 'dark')
    h.check('Tern resolved the initial dark appearance', h.ctl('state').theme === 'dark', h.ctl('state').theme)
  }
  const subject = join(h.repo, 'scripts', 'tern-pane-focus-turns-subject.mts')
  writeFileSync(join(h.root, 'focus-scenario.json'), `${JSON.stringify({ name: SCENARIO })}\n`)
  const launchResponse = await h.launch(subject)
  h.measure('subject launcher response', JSON.stringify(launchResponse))
  if (!await waitFor(h, 'the production Direct subject reports readiness in its own event ledger', () =>
    records(h).some(row => row.kind === 'subject.ready'))) {
    finish(h, extra)
    return
  }
  h.check('the Direct subject records its own running fixture', records(h).some(row => row.kind === 'fixture.ready'))
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
  const promptInfo = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const manifest = {
    tern: ternVersion,
    ternBinary: { path: ternBin, sha256: ternSha256, bytes: readFileSync(ternBin).length },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    host: { os: `${type()} ${release()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    hello: { version: hello?.body?.ver, kinds: hello?.body?.kinds, features: hello?.body?.features, cell: hello?.body?.cell },
    input: IS_GUI ? 'CONTROL_INJECTED_INPUT in a real Tern GUI window; not OS_INPUT_VERIFIED' : 'CONTROL_INJECTED_INPUT via pinned Tern client; not OS_INPUT_VERIFIED',
    notVerified: ['physical GUI/OS input/IME/wheel', 'Owner G8 visual signature'],
  }
  writeLedger(h, 'environment.json', manifest)
  h.check('the real client negotiated the expected protocol version', hello?.body?.ver === '0.9.13', JSON.stringify(hello?.body ?? null))
  h.check(`the subject configured the canonical Focus preset for ${SCENARIO}`, records(h).some(row => row.kind === 'fixture.ready' && row.modeAuthority?.includes('displayPreset=focus')),
    JSON.stringify(records(h).find(row => row.kind === 'fixture.ready')))
  h.check('exactly one official inline Surface opened', wire(h).filter(row => row.dir === 'out' && row.verb === 'o').length === 1)
  if (!Array.isArray(hello?.body?.kinds) || !hello.body.kinds.includes('section') || !hello.body.kinds.includes('col')) {
    h.check('the pinned client negotiates native sections and column headers', false, JSON.stringify(hello?.body ?? null))
    finish(h, extra)
    return
  }
  await submit(h, promptInfo.prompt)
  if (!await waitFor(h, 'the production prompt write settles', () => records(h).some(row => row.kind === 'writer.settled' && row.count === 1))) {
    finish(h, extra)
    return
  }
  if (SCENARIO === 'svg') {
    if (!await waitFor(h, 'the real registered Tool A is executing inside canonical Work A', () => {
      const rows = records(h)
      const roots = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'fixture.tool-a-registered')
        && rows.some(row => row.kind === 'subject.tool-a.started')
        && rows.some(row => row.kind === 'display.commit' && row.messageKinds.includes('tool') && !row.finalPresent)
        && roots.length === 1
        && liveNodes(h).get(roots[0])?.p.collapsed === true
        && h.texts(h.snapshot()).some(text => text.includes('focus_qualification_a'))
    })) {
      finish(h, extra)
      return
    }
    const steerText = promptInfo.steer
    h.check('the real Direct subject advertises the busy-steer test input', typeof steerText === 'string', JSON.stringify(promptInfo))
    if (typeof steerText !== 'string') {
      finish(h, extra)
      return
    }
    h.capture('focus-work-a-during-tool-steer-1280x800-dark', 'registered Work A Tool is executing before the official steer')
    await submit(h, steerText)
    if (!await waitFor(h, 'the production Direct writer accepts one busy Enter steer while Tool A is executing', () =>
      records(h).some(row => row.kind === 'writer.settled' && row.count === 2 && row.mode === 'steer'))) {
      finish(h, extra)
      return
    }
    writeFileSync(join(h.root, 'release-tool-a.json'), `${JSON.stringify({ release: true })}\n`)
    if (!await waitFor(h, 'Tool A completes and Agent claims the steer before starting its next model step', () => {
      const rows = records(h)
      const commits = rows.filter(row => row.kind === 'display.commit')
      const rootIdsNow = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'subject.tool-a.released')
        && rows.some(row => row.kind === 'subject.tool-a.completed')
        && rows.some(row => row.kind === 'subject.model-step.held' && row.stepIndex === 1)
        && commits.some(row => row.userTexts?.includes(steerText))
        && rootIdsNow.length === 1
        && liveNodes(h).get(rootIdsNow[0])?.p.collapsed === true
    })) {
      finish(h, extra)
      return
    }
    writeFileSync(join(h.root, 'release-tool-step.json'), `${JSON.stringify({ release: true })}\n`)
    if (!await waitFor(h, 'the real SVG Tool call is streaming arguments before a durable Work B exists', () =>
      records(h).some(row => row.kind === 'subject.tool-arguments.held' && row.callId === 'focus-real-svg-b'))) {
      finish(h, extra)
      return
    }
    const argumentNodes = liveNodes(h)
    const argumentRootId = rootIds(argumentNodes)[0]
    h.check('the original Focus Root remains closed while the next Tool arguments stream',
      argumentRootId !== undefined && argumentNodes.get(argumentRootId)?.p.collapsed === true)
    h.capture('focus-ownerless-preparing-root-closed-1280x800-dark', 'Tool B arguments are pending with only the earlier durable Work')
    const collapsedPreparingSnapshot = h.snapshot()
    const preparingHead = visibleSectionHead(collapsedPreparingSnapshot, h, 'Working')
    h.check('the collapsed Root previews pending Tool B arguments',
      preparingHead !== undefined && h.descendantsText(preparingHead).includes('Preparing SVG'))
    if (preparingHead === undefined) {
      finish(h, extra)
      return
    }
    const beforePreparingOpen = eventRows(h).length
    h.check('the collapsed Root opens by the real pointer path for the ownerless Preparing case',
      await h.click(collapsedPreparingSnapshot.chains, preparingHead))
    if (!await waitFor(h, 'the ownerless Preparing Root toggle is reported by Tern', () => eventRows(h).length > beforePreparingOpen)) {
      finish(h, extra)
      return
    }
    const preparingRootEvent = eventRows(h).at(-1)
    h.check('the ownerless Preparing open targets the exact current Root',
      preparingRootEvent?.id === argumentRootId && preparingRootEvent.collapsed === false, JSON.stringify(preparingRootEvent))
    const preparingNodes = liveNodes(h)
    const oldWorks = workIds(preparingNodes, argumentRootId)
    h.check('the streamed Tool arguments have not fabricated a new Work span', oldWorks.length === 1, JSON.stringify(oldWorks))
    const ownerlessRows = [...preparingNodes.entries()].filter(([id, node]) => id.startsWith(`${argumentRootId}.`)
      && node.k === 'row' && subtreeText(preparingNodes, id).includes('Preparing SVG'))
    const preparingRowId = ownerlessRows[0]?.[0]
    const preparingAdd = wire(h).flatMap(frame => frame.dir === 'out' && frame.verb === 'f'
      ? frame.body?.ops ?? []
      : []).findLast(op => op[0] === 'add' && op[1] === preparingRowId)
    const rootOwnsPreparing = preparingAdd?.[2] === argumentRootId
    h.check('the new Preparing remains one ordinary Root child beside Work A',
      ownerlessRows.length === 1 && rootOwnsPreparing,
      JSON.stringify({ ownerlessRows: ownerlessRows.map(([id]) => id), actualFrameParent: preparingAdd?.[2] }))
    h.check('the earlier Work A does not adopt the new Preparing preview',
      oldWorks.every(id => !subtreeText(preparingNodes, id).includes('Preparing')))
    h.capture('focus-ownerless-preparing-root-row-1280x800-dark', 'pending Tool B is an ordinary Root child and Work A remains unchanged')
    const beforePreparingClose = eventRows(h).length
    const openPreparingSnapshot = h.snapshot()
    const openRootHead = visibleSectionHead(openPreparingSnapshot, h, 'Working')
    h.check('the same Focus Root offers its close target', openRootHead !== undefined)
    h.check('the Focus Root closes after the ownerless Preparing read', openRootHead !== undefined
      && await h.click(openPreparingSnapshot.chains, openRootHead))
    if (!await waitFor(h, 'the ownerless Preparing Root closes through its real target state', () =>
      eventRows(h).length > beforePreparingClose && eventRows(h).at(-1)?.id === argumentRootId
        && eventRows(h).at(-1)?.collapsed === true)) {
      finish(h, extra)
      return
    }
    writeFileSync(join(h.root, 'release-tool-arguments.json'), `${JSON.stringify({ release: true })}\n`)
    if (!await waitFor(h, 'the streamed Tool B arguments resume after the Root row was verified', () =>
      records(h).some(row => row.kind === 'subject.tool-arguments.released' && row.callId === 'focus-real-svg-b'))) {
      finish(h, extra)
      return
    }
    if (!await waitFor(h, 'the SVG request and final model-stream barrier settle after the claimed steer', () => {
      const commits = records(h).filter(row => row.kind === 'display.commit')
      return records(h).some(row => row.kind === 'subject.model-step.released' && row.stepIndex === 1)
        && records(h).some(row => row.kind === 'model.stream.held')
        && commits.some(row => row.userTexts?.includes(steerText)
          && row.messageKinds.filter(kind => kind === 'tool').length === 2 && !row.finalPresent)
        && !h.texts(h.snapshot()).includes(promptInfo.assistantMarker)
    })) {
      finish(h, extra)
      return
    }
    h.check('the accepted steer is a durable Folder user row between the two Tool steps', records(h)
      .filter(row => row.kind === 'display.commit').some(row => row.userTexts?.includes(steerText)))
    h.capture('focus-work-a-steer-work-b-held-1280x800-dark', 'the same real Turn has Tool A, accepted steer, SVG Tool B and a held final')
  } else if (SCENARIO === 'image') {
    if (!await waitFor(h, 'the registered raster Tool result reaches Focus while the final model stream is held', () => {
      const rows = records(h)
      const roots = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'fixture.image-tool-registered')
        && rows.some(row => row.kind === 'model.stream.held')
        && rows.some(row => row.kind === 'display.commit' && row.messageKinds.includes('tool') && !row.finalPresent)
        && roots.length === 1
        && liveNodes(h).get(roots[0])?.p.collapsed === true
        && !h.texts(h.snapshot()).includes(promptInfo.assistantMarker)
    })) {
      finish(h, extra)
      return
    }
  } else {
    if (!await waitFor(h, 'the official Ask User tool reaches its user-wait phase', () => {
      const rows = records(h)
      const roots = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'status.commit' && row.phase === 'waiting-question')
        && rows.some(row => row.kind === 'display.commit' && row.messageKinds.includes('tool') && !row.finalPresent)
        && roots.length === 1
        && liveNodes(h).get(roots[0])?.p.collapsed === true
        && h.texts(h.snapshot()).includes('Continue after the Focus turn?')
    })) {
      finish(h, extra)
      return
    }
  }
  const heldNodes = liveNodes(h)
  const rootId = rootIds(heldNodes)[0]
  const heldRoot = heldNodes.get(rootId)
  h.check('the live Direct Turn paints one collapsed native Focus root', rootIds(heldNodes).length === 1 && heldRoot?.p.collapsed === true,
    JSON.stringify({ scenario: SCENARIO, rootId, root: heldRoot?.p }))
  h.check('the final answer is absent before the official turn/end', !h.texts(h.snapshot()).includes(promptInfo.assistantMarker))
  h.check('the collapsed root does not materialize hidden Tool rows', ![...heldNodes.keys()].some(id => id.startsWith(`${rootId}.`) && heldNodes.get(id)?.k === 'tool'))
  if (SCENARIO === 'image') {
    h.check('the real durable image was saved before display demand', records(h).some(row => row.kind === 'attachment.saved'))
    h.check('a collapsed Focus root performs no AttachmentStore read or image blob send',
      !records(h).some(row => row.kind === 'attachment.read') && blobWrites(h).length === 0,
      JSON.stringify({ reads: records(h).filter(row => row.kind === 'attachment.read'), blobs: blobWrites(h).length }))
  }
  h.capture(`focus-${SCENARIO}-collapsed-1280x800-dark`, 'the official Direct Focus Turn is live before its final answer')
  if (SCENARIO === 'question') {
    const waiting = records(h).filter(row => row.kind === 'status.commit').at(-1)
    const waitingHead = visibleSectionHead(h.snapshot(), h, 'Waiting for input')
    h.check('the official waiting-question phase projects into the Focus root',
      waiting?.phase === 'waiting-question' && waitingHead !== undefined,
      JSON.stringify({ phase: waiting?.phase, rootText: waitingHead === undefined ? undefined : h.descendantsText(waitingHead) }))
  }

  if (SCENARIO === 'question') {
    const waitingPhase = records(h).filter(row => row.kind === 'status.commit' && row.phase === 'waiting-question').at(-1)
    h.check('the subject observed the official user-wait phase from StatusReader', waitingPhase !== undefined, JSON.stringify(waitingPhase ?? null))
    const waitingRoot = visibleSectionHead(h.snapshot(), h, 'Waiting for input')
    h.check('the waiting phase is projected into the Focus root head', waitingRoot !== undefined,
      JSON.stringify(waitingRoot === undefined ? null : h.descendantsText(waitingRoot)))
    h.capture('focus-waiting-question-1280x800-dark', 'official ask_user_question owns the modal seat while Focus Main reflects waiting')

    const questionSnapshot = h.snapshot()
    const continueChoice = questionSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('q-choice')
      && h.descendantsText(node).includes('Continue'))
    h.check('the official Ask User choice is visible in the real client tree', continueChoice !== undefined,
      JSON.stringify(questionSnapshot.nodes.filter(node => String(node.class ?? '').includes('q-choice')).map(node => h.descendantsText(node))))
    if (continueChoice === undefined) {
      finish(h, extra)
      return
    }
    h.check('the Continue choice accepts a real pointer click', await h.click(questionSnapshot.chains, continueChoice),
      JSON.stringify({ text: h.descendantsText(continueChoice), rect: rect(continueChoice) }))
    const reviewSnapshot = h.snapshot()
    const reviewButton = reviewSnapshot.nodes.find(node => node.tag === 'button' && h.descendantsText(node).trim() === 'Review answers')
    h.check('the review action is reachable after choosing Continue', reviewButton !== undefined)
    if (reviewButton === undefined) {
      finish(h, extra)
      return
    }
    h.check('the Review answers action lands', await h.click(reviewSnapshot.chains, reviewButton))
    const submitSnapshot = h.snapshot()
    const submitButton = submitSnapshot.nodes.find(node => node.tag === 'button' && h.descendantsText(node).includes('Submit answers'))
    h.check('the answer review exposes its real Submit answers action', submitButton !== undefined,
      JSON.stringify(submitSnapshot.nodes.filter(node => node.tag === 'button').map(node => h.descendantsText(node))))
    if (submitButton === undefined) {
      finish(h, extra)
      return
    }
    h.check('the Submit answers action lands', await h.click(submitSnapshot.chains, submitButton))
    if (!await waitFor(h, 'the answered question starts the held final model stream', () =>
      records(h).some(row => row.kind === 'model.stream.held')
        && records(h).some(row => row.kind === 'status.commit' && row.phase === 'working')
        && !h.texts(h.snapshot()).includes(promptInfo.assistantMarker))) {
      finish(h, extra)
      return
    }
    const resumedHead = visibleSectionHead(h.snapshot(), h, 'Working')
    h.check('the answer returns Focus Main to Working before the final is released', resumedHead !== undefined,
      JSON.stringify(resumedHead === undefined ? null : h.descendantsText(resumedHead)))
    h.capture('focus-resumed-before-final-1280x800-dark', 'the official question settled; the second Agent stream remains held')
  }

  const matrix = []
  const viewports = IS_GUI || SCENARIO === 'question' ? [VIEWPORTS[0]] : VIEWPORTS
  for (const viewport of viewports) {
    const resized = await h.resize(viewport.width, viewport.height)
    if (IS_GUI) h.check('the GUI window remains at the supported content size', resized.clamped === false, JSON.stringify(resized))
    if (IS_GUI) {
      const beforeTheme = h.ctl('state').theme
      if (beforeTheme !== viewport.appearance) h.send('plugins', 'run', `appearance:${viewport.appearance}`)
    } else {
      h.send('appearance', viewport.appearance)
    }
    const theme = h.ctl('state').theme
    h.check(`the client resolves ${viewport.appearance} at ${viewport.width}x${viewport.height}`, theme === viewport.appearance, String(theme))
    const snapshot = h.snapshot()
    const rootNode = visibleSectionHead(snapshot, h, 'Working')
    const capture = h.capture(`focus-${viewport.width}x${viewport.height}-${viewport.appearance}`, 'collapsed native Focus root in the real Tern pane')
    const span = rootNode === undefined ? { x: 0, y: 0 } : {
      x: visibleSpan(snapshot.chains, rootNode, 'x'),
      y: visibleSpan(snapshot.chains, rootNode, 'y'),
    }
    const visible = span.x >= 4 && span.y >= 4
    h.check(`a Focus root header fragment is visible at ${viewport.width}x${viewport.height}`, visible,
      JSON.stringify(rootNode === undefined ? null : { rect: rect(rootNode), span }))
    matrix.push({ viewport: [viewport.width, viewport.height], appearance: theme, capture, root: rootId, span, visible })
  }
  writeLedger(h, 'viewport-matrix.json', matrix)
  if (!IS_GUI) {
    await h.resize(1280, 800)
    h.send('appearance', 'dark')
  }

  const mainSnap = h.snapshot()
  const rootHead = visibleSectionHead(mainSnap, h, 'Working')
  h.check('the native Focus header is present in the client Main tree', rootHead !== undefined, rootId)
  if (rootHead === undefined) {
    finish(h, extra)
    return
  }
  const headSpan = {
    x: visibleSpan(mainSnap.chains, rootHead, 'x'),
    y: visibleSpan(mainSnap.chains, rootHead, 'y'),
  }
  const headVisible = headSpan.x >= 4 && headSpan.y >= 4
  h.check('a visible Focus root header fragment survives Main ancestor clipping', headVisible,
    JSON.stringify({ rect: rect(rootHead), headSpan }))
  const togglesBefore = eventRows(h).length
  const clicked = await h.click(mainSnap.chains, rootHead)
  h.check('a real pointer click on the visible native Focus header lands', clicked)
  if (!await waitFor(h, 'the client-generated Focus root toggle event', () => eventRows(h).length > togglesBefore)) {
    finish(h, extra)
    return
  }
  let toggles = eventRows(h)
  const openRootEvent = toggles.at(-1)
  h.check('the native client reports the exact Focus root and open target',
    openRootEvent?.id === rootId && openRootEvent?.collapsed === false, JSON.stringify(openRootEvent))
  let live = liveNodes(h)
  const nestedWorks = workIds(live, rootId)
  const expectedWorkCount = SCENARIO === 'question' ? 0 : SCENARIO === 'svg' ? 2 : 1
  h.check('the Focus root materializes the exact canonical Work occurrence count', nestedWorks.length === expectedWorkCount,
    JSON.stringify({ scenario: SCENARIO, nestedWorks }))
  h.check('each newly materialized Work is independently collapsed', nestedWorks.every(id => live.get(id)?.p.collapsed === true))
  if (SCENARIO === 'svg') {
    if (!await waitFor(h, 'the expanded client tree exposes both Work headers and the official steer row', () => {
      const flat = mainNodes(h.snapshot())
      const heads = flat.filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head'))
      return heads.some(node => h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('focus_qualification_a'))
        && heads.some(node => h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('dsh_pi_tui_svg'))
        && flat.some(node => node.text === promptInfo.steer)
    })) {
      finish(h, extra)
      return
    }
    const flat = mainNodes(h.snapshot())
    const workAIndex = flat.findIndex(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('focus_qualification_a'))
    const steerIndex = flat.findIndex(node => node.text === promptInfo.steer)
    const workBIndex = flat.findIndex(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('dsh_pi_tui_svg'))
    h.check('the real expanded Root reads Tool A → official steer → SVG Work B',
      workAIndex >= 0 && steerIndex > workAIndex && workBIndex > steerIndex,
      JSON.stringify({ workAIndex, steerIndex, workBIndex }))
  }
  if (SCENARIO !== 'question') {
    h.check('opening only the root still hides canonical Work Tool members',
      ![...live.keys()].some(id => id.startsWith(`${rootId}.`) && live.get(id)?.k === 'tool'))
    if (SCENARIO === 'image') {
      h.check('opening Root while Work stays closed performs no AttachmentStore read or blob send',
        !records(h).some(row => row.kind === 'attachment.read') && blobWrites(h).length === 0)
    }
  } else {
    h.check('the settled Ask User interaction remains a native Tool row inside the open Focus root',
      [...live.entries()].some(([id, node]) => id.startsWith(`${rootId}.`) && node.k === 'tool'))
  }
  h.capture('focus-expanded-root-1280x800-dark', 'the native Focus root is open and canonical Work remains closed')

  if (nestedWorks.length > 0) {
    const workId = SCENARIO === 'svg'
      ? nestedWorks.find(id => subtreeText(live, id).includes('dsh_pi_tui_svg'))
      : nestedWorks[0]
    h.check('the SVG scenario identifies Work B from its real Tool-derived Activity head',
      workId !== undefined,
      JSON.stringify(nestedWorks.map(id => ({ id, text: subtreeText(live, id) }))))
    if (workId === undefined) {
      finish(h, extra)
      return
    }
    if (SCENARIO === 'svg') {
      h.check('the distinct Work A remains closed before targeting Work B',
        nestedWorks.length === 2 && nestedWorks.some(id => id !== workId && live.get(id)?.p.collapsed === true))
    }
    const workSnap = h.snapshot()
    const workHead = SCENARIO === 'svg'
      ? mainNodes(workSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('dsh_pi_tui_svg'))
      : visibleSectionHead(workSnap, h, 'Activity')
    h.check('the targeted nested Work head exists in the real client tree', workHead !== undefined,
      JSON.stringify({
        workId,
        heads: mainNodes(workSnap)
          .filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head'))
          .map(node => h.descendantsText(node)),
      }))
    if (workHead !== undefined) {
      if (SCENARIO === 'image') {
        h.check('the real Tool image remains unread while its Work is closed',
          !records(h).some(row => row.kind === 'attachment.read') && blobWrites(h).length === 0,
          JSON.stringify({ reads: records(h).filter(row => row.kind === 'attachment.read'), blobs: blobWrites(h).length }))
      }
      const beforeWorkToggle = eventRows(h).length
      const workClick = await h.click(workSnap.chains, workHead)
      h.check('the Work header accepts a real pointer click', workClick)
      if (await waitFor(h, 'the client-generated Work toggle', () => eventRows(h).length > beforeWorkToggle)) {
        toggles = eventRows(h)
        const event = toggles.at(-1)
        h.check('the native client reports the exact Work id and open target',
          event?.id === workId && event?.collapsed === false, JSON.stringify(event))
        live = liveNodes(h)
        if (SCENARIO === 'svg') {
          h.check('opening Work B leaves the distinct Work A closed',
            nestedWorks.filter(id => id !== workId).every(id => live.get(id)?.p.collapsed === true),
            JSON.stringify(nestedWorks.map(id => ({ id, collapsed: live.get(id)?.p.collapsed }))))
        }
        const childTools = [...live.entries()].filter(([id, node]) => id.startsWith(`${workId}.`) && node.k === 'tool')
        h.check('opening this Work materializes its own registered Tool', childTools.length === 1)
        if (SCENARIO === 'svg' && childTools.length === 1) {
          const svgTool = childTools[0]
          h.check('the SVG Tool has an independent native disclosure', svgTool[1].p.collapsible === true && svgTool[1].p.collapsed === true,
            JSON.stringify(svgTool[1].p))
          h.check('opening Work alone sends no SVG blob', blobWrites(h).length === 0)
          const toolSnap = h.snapshot()
          const toolHead = mainNodes(toolSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
            && h.descendantsText(node).includes('Focus Evidence'))
          h.check('the real SVG Tool header is a visible native pointer target', toolHead !== undefined,
            JSON.stringify(mainNodes(toolSnap).filter(node => String(node.class ?? '').includes('sf-tool')).map(node => ({ class: node.class, text: h.descendantsText(node) }))))
          if (toolHead !== undefined) {
            const beforeToolToggle = eventRows(h).length
            h.check('the SVG Tool click lands', await h.click(toolSnap.chains, toolHead))
            if (!await waitFor(h, 'the SVG Tool blob demand', () => blobWrites(h).length === 1
              && [...liveNodes(h).entries()].some(([id, node]) => id.startsWith(`${svgTool[0]}.`) && node.k === 'image'))) {
              finish(h, extra)
              return
            }
            const event = eventRows(h).slice(beforeToolToggle).at(-1)
            h.check('the client toggle addresses exactly the SVG Tool node', event?.id === svgTool[0] && event.collapsed === false, JSON.stringify(event ?? null))
            h.check('opening the exact Tool sends one blob and paints its image', blobWrites(h).length === 1
              && [...liveNodes(h).entries()].some(([id, node]) => id.startsWith(`${svgTool[0]}.`) && node.k === 'image'))
          }
        } else if (SCENARIO === 'image' && childTools.length === 1) {
          const imageTool = childTools[0]
          h.check('the real durable Tool keeps image detail independently collapsed after Work opens',
            imageTool[1].p.collapsible === true && imageTool[1].p.collapsed === true, JSON.stringify(imageTool[1].p))
          h.check('opening Work alone still performs no AttachmentStore read or blob send',
            !records(h).some(row => row.kind === 'attachment.read') && blobWrites(h).length === 0,
            JSON.stringify({ reads: records(h).filter(row => row.kind === 'attachment.read'), blobs: blobWrites(h).length }))
          const saved = records(h).find(row => row.kind === 'attachment.saved')
          h.check('the registered Tool result contains the admitted durable image identity', typeof saved?.attachmentId === 'string', JSON.stringify(saved ?? null))
          const toolSnap = h.snapshot()
          const imageToolHead = mainNodes(toolSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-tool-head')
            && h.descendantsText(node).includes('focus_read_image'))
          h.check('the closed raster Tool has a visible native detail header after Work opens', imageToolHead !== undefined,
            JSON.stringify(mainNodes(toolSnap).filter(node => String(node.class ?? '').includes('sf-tool')).map(node => ({ id: node.id, text: h.descendantsText(node), rect: rect(node) }))))
          const beforeImageToolToggle = eventRows(h).length
          h.check('the raster Tool header opens through its native real client pointer', imageToolHead !== undefined
            && await h.click(toolSnap.chains, imageToolHead))
          if (!await waitFor(h, 'the exact Tool detail toggle releases one authorized image read and native blob', () => {
            const events = eventRows(h).slice(beforeImageToolToggle)
            const reads = records(h).filter(row => row.kind === 'attachment.read')
            const nodes = liveNodes(h)
            return events.some(row => row.id === imageTool[0] && row.collapsed === false)
              && reads.length === 1
              && reads[0]?.attachmentId === saved?.attachmentId
              && blobWrites(h).length === 1
              && blobWrites(h)[0]?.params?.mime === 'image/png'
              && [...nodes.entries()].some(([id, node]) => id.startsWith(`${imageTool[0]}.`) && node.k === 'image' && typeof node.p.blob === 'string')
          })) {
            finish(h, extra)
            return
          }
          const reads = records(h).filter(row => row.kind === 'attachment.read')
          live = liveNodes(h)
          h.check('the exact stored attachment is read once only after its Tool disclosure opens',
            reads.length === 1 && reads[0]?.attachmentId === saved?.attachmentId, JSON.stringify(reads))
          h.check('the real Tern pane receives one PNG blob and a native image node under the Tool',
            blobWrites(h).length === 1 && blobWrites(h)[0]?.params?.mime === 'image/png'
              && [...live.entries()].some(([id, node]) => id.startsWith(`${imageTool[0]}.`) && node.k === 'image' && typeof node.p.blob === 'string'),
            JSON.stringify({ blobs: blobWrites(h).map(row => row.params), imageNodes: [...live.entries()].filter(([id, node]) => id.startsWith(`${imageTool[0]}.`) && node.k === 'image') }))
        }
      }
    }
  }

  const currentSnap = h.snapshot()
  const currentRootHead = visibleSectionHead(currentSnap, h, 'Working')
  h.check('the Focus root header remains available for a close click', currentRootHead !== undefined)
  if (currentRootHead !== undefined) {
    const beforeClose = eventRows(h).length
    h.check('the root close click lands on its real header', await h.click(currentSnap.chains, currentRootHead))
    if (await waitFor(h, 'the client-generated root close event', () => eventRows(h).length > beforeClose)) {
      const event = eventRows(h).at(-1)
      h.check('the client reports the closed target for the same root', event?.id === rootId && event?.collapsed === true, JSON.stringify(event))
      await waitFor(h, 'the Work children retire with the closed root', () => workIds(liveNodes(h), rootId).length === 0)
    }
  }
  const reopenedBefore = eventRows(h).length
  const reopenSnap = h.snapshot()
  const reopenedHead = visibleSectionHead(reopenSnap, h, 'Working')
  if (reopenedHead !== undefined) {
    h.check('the root reopens by pointer through the same native head', await h.click(reopenSnap.chains, reopenedHead))
    await waitFor(h, 'the native root re-open event', () => eventRows(h).length > reopenedBefore)
    live = liveNodes(h)
    h.check('re-opening the root returns its Work to the initial collapsed state',
      workIds(live, rootId).every(id => live.get(id)?.p.collapsed === true), JSON.stringify(workIds(live, rootId)))
  }

  const keyboardBefore = eventRows(h).length
  const keyboardTarget = visibleSectionHead(h.snapshot(), h, 'Working')
  h.check('the current Focus root still has a native keyboard target node', keyboardTarget !== undefined)
  await h.key('Enter', 700)
  const keyboardEvents = eventRows(h).slice(keyboardBefore)
  const keyboardEvent = keyboardEvents.at(-1)
  if (keyboardEvents.length > 0) {
    h.check('native keyboard activation addresses the current Focus root',
      keyboardEvent?.id === rootId && typeof keyboardEvent.collapsed === 'boolean', JSON.stringify(keyboardEvent))
  } else {
    h.measure('keyboard activation qualification', JSON.stringify({
      status: 'NOT_VERIFIED_UPSTREAM',
      attempted: true,
      reason: 'the pinned client produced no SessionInput.toggle after Enter on the current native Section head',
      surface: IS_GUI ? 'REAL_TERN_GUI' : 'REAL_TERN_HEADLESS',
    }))
  }

  writeFileSync(join(h.root, 'release-stream.json'), `${JSON.stringify({ release: true })}\n`)
  if (!await waitFor(h, 'the subject released its held real Agent stream', () => records(h).some(row => row.kind === 'subject.stream.released'))) {
    finish(h, extra)
    return
  }
  if (SCENARIO === 'question') {
    if (!await waitFor(h, 'the final Assistant is committed while its official turn/end is withheld', () => {
      const commits = records(h).filter(row => row.kind === 'display.commit')
      const finalBeforeEnd = commits.some(row => row.finalPresent && !row.completedTurns.includes(1))
      return records(h).some(row => row.kind === 'turn.end.deferred') && finalBeforeEnd
    })) {
      finish(h, extra)
      return
    }
    const preEndCommit = records(h).filter(row => row.kind === 'display.commit' && row.finalPresent).at(-1)
    const preEndText = h.texts(h.snapshot())
    const finalHeld = preEndCommit !== undefined && !preEndCommit.completedTurns.includes(1)
      && !preEndText.includes(promptInfo.assistantMarker)
    h.check('the official final is held out of Main before turn/end despite its committed Session message',
      finalHeld,
      JSON.stringify({ preEndCommit, assistantMarker: promptInfo.assistantMarker, clientText: preEndText }))
    h.capture('focus-final-held-before-turn-end-1280x800-dark', 'official Assistant final is durable, but Main waits for turn/end')
    writeFileSync(join(h.root, 'release-turn-end.json'), `${JSON.stringify({ release: true })}\n`)
    if (!await waitFor(h, 'the same official turn/end event is committed after the holdback assertion', () => records(h).some(row => row.kind === 'turn.end.released'))) {
      finish(h, extra)
      return
    }
  }
  if (!await waitFor(h, 'the official Direct final row is present in the SDK Main tree', () => {
    const nodes = liveNodes(h)
    return [...nodes.entries()].some(([id, node]) => node.k === 'card'
      && !id.startsWith(`${rootId}.`)
      && subtreeText(nodes, id).includes(promptInfo.assistantMarker))
  }, 400)) {
    finish(h, extra)
    return
  }
  live = liveNodes(h)
  const finalCards = [...live.entries()].filter(([id, node]) => node.k === 'card'
    && !id.startsWith(`${rootId}.`)
    && subtreeText(live, id).includes(promptInfo.assistantMarker))
  h.check('official turn/end publishes one final Assistant outside the Focus root', finalCards.length === 1, JSON.stringify(finalCards.map(([id]) => id)))
  h.check('the subject recorded an authoritative completed activity after release',
    records(h).some(row => row.kind === 'display.commit' && row.completedTurns.includes(1) && row.finalPresent))
  if (SCENARIO === 'svg') {
    const short = await h.resize(900, 360)
    h.send('appearance', 'light')
    if (!await waitFor(h, 'the live short Main exposes the final marker in its actual viewport', () =>
      mainNodes(h.snapshot()).some(node => String(node.text ?? '').includes(promptInfo.assistantMarker)))) {
      const failedSnapshot = h.snapshot()
      const textNodes = mainNodes(failedSnapshot).filter(node => typeof node.text === 'string')
      h.measure('short Main final text candidates', JSON.stringify(textNodes.filter(node =>
        String(node.text).includes('official Tool-A-to-SVG') || String(node.text).includes('Detail')
        || String(node.text).includes(promptInfo.assistantMarker)).map(node => ({
        text: String(node.text).slice(-220), rect: rect(node), span: visibleSpan(failedSnapshot.chains, node, 'y'),
      }))))
      h.measure('short Main visible text tail', JSON.stringify(h.texts(failedSnapshot).slice(-12)))
      h.measure('wire final card suffix', JSON.stringify(finalCards.map(([id]) => subtreeText(liveNodes(h), id).slice(-240))))
      finish(h, extra)
      return
    }
    const atTail = h.snapshot()
    const finalTextNode = mainNodes(atTail).find(node => String(node.text ?? '').includes(promptInfo.assistantMarker))
    const initialFinalSpan = finalTextNode === undefined ? 0 : visibleSpan(atTail.chains, finalTextNode, 'y')
    h.check('the final text marker belongs to a real Assistant text node in Main', finalTextNode !== undefined)
    const shortCapture = h.capture('focus-short-final-at-tail-900x360-light', 'short Main showing the completed final tail before PageUp')
    h.check('the completed final tail marker is visible in the short Main viewport', initialFinalSpan >= 4,
      JSON.stringify({ short, shortCapture, initialFinalSpan, finalNode: rect(finalTextNode) }))
    await h.key('PageUp', 900)
    const older = h.snapshot()
    const finalAfterPageUp = mainNodes(older).find(node => String(node.text ?? '').includes(promptInfo.assistantMarker))
    const finalSpanAfterPageUp = finalAfterPageUp === undefined ? 0 : visibleSpan(older.chains, finalAfterPageUp, 'y')
    h.check('short-height PageUp can leave the completed final and return to earlier chronology',
      finalSpanAfterPageUp < 4,
      JSON.stringify({ initialFinalSpan, finalSpanAfterPageUp, finalNode: rect(finalAfterPageUp ?? {}) }))
    await h.key('PageDown', 900)
    const tail = h.snapshot()
    const finalAtTail = mainNodes(tail).find(node => String(node.text ?? '').includes(promptInfo.assistantMarker))
    const finalAtTailSpan = finalAtTail === undefined ? 0 : visibleSpan(tail.chains, finalAtTail, 'y')
    h.check('native PageDown returns the same final Assistant to the visible Main tail', finalAtTailSpan >= 4,
      JSON.stringify({ finalAtTailSpan, finalNode: rect(finalAtTail ?? {}) }))
    h.capture('focus-short-final-restored-900x360-light', 'the official final is readable again after native PageDown')
  }
  writeLedger(h, 'focus-evidence.json', {
    tern: ternVersion,
    rootId,
    nativeToggles: eventRows(h),
    directCommits: records(h).filter(row => row.kind === 'display.commit'),
    matrix,
    finalCardIds: finalCards.map(([id]) => id),
    keyboard: {
      status: keyboardEvents.length > 0 ? 'VERIFIED_BY_PINNED_CLIENT' : 'NOT_VERIFIED_UPSTREAM',
      attempted: true,
      events: keyboardEvents,
    },
    evidenceTier: focusEvidenceTier(IS_GUI),
    notVerified: manifest.notVerified,
  })

  await submit(h, '/exit')
  await waitFor(h, 'the Direct application exit', () => records(h).some(row => row.kind === 'app.exit'), 300)
  await waitFor(h, 'the Direct Subject naturally releases its owned watchers and reaches beforeExit',
    () => records(h).some(row => row.kind === 'subject.beforeExit'), 100)
  finish(h, extra)
}
