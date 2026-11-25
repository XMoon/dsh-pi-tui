import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, type } from 'node:os'
import { join } from 'node:path'
import { ancestorsOf, rect, visibleBox, visibleSpan } from './tern-pane-geometry.mjs'

const IS_GUI = process.env.TERN_FOCUS_GUI === '1'
const SCENARIO = process.env.TERN_FOCUS_CASE ?? 'svg'
if (SCENARIO !== 'svg' && SCENARIO !== 'image' && SCENARIO !== 'question' && SCENARIO !== 'command') throw new Error(`unknown Focus Tern case ${SCENARIO}`)
export function focusEvidenceTier(isGui) {
  return `${isGui ? 'REAL_TERN_GUI' : 'REAL_TERN_HEADLESS'} + CONTROL_INJECTED_INPUT + official Direct application`
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
/** The final Assistant materializes either as a native card or as the role
 *  container the client assigns to a plain assistant row. */
const isAssistantRow = node => node.k === 'card'
  || String(node.p?.role ?? '').startsWith('dsh.transcript.assistant')
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
  // No version pin: the client keeps upgrading. Verify the handshake reports the
  // version of the binary THIS run actually uses, not a hardcoded literal.
  const ternVerNum = ternVersion.match(/\d+\.\d+\.\d+/u)?.[0]
  const ternSha256 = createHash('sha256').update(readFileSync(ternBin)).digest('hex')
  const packageJson = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const dshMode = JSON.parse(readFileSync(join(h.repo, 'test/compat/dsh-mode.json'), 'utf8')).mode
  const dshPin = packageJson.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = packageJson.devDependencies?.['@deepseek-ai/dsh-session']
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1]
  const extra = { tern: ternVersion, sdk: '0.2.0', dsh: dshPin }
  // The lane follows the checkout's own frozen DSH pin instead of hardcoding
  // one release: a version bump must not turn this qualification lane red.
  h.check('the worktree uses its tracked DSH npm runtime',
    typeof dshPin === 'string' && dshPin !== '' && dshSessionPin === dshPin && dshMode === 'npm',
    JSON.stringify({ dshPin, dshSessionPin, dshMode }))
  h.check('the lockfile carries the pinned Tern SDK integrity', sdkIntegrity !== undefined, String(sdkIntegrity))
  h.measure('the Tern client binary identity for this run', JSON.stringify({ version: ternVersion, sha256: ternSha256 }))

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
  if (!await waitFor(h, 'the Direct subject records its own running fixture',
    () => records(h).some(row => row.kind === 'fixture.ready'))) {
    finish(h, extra)
    return
  }
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
  h.check('the real client negotiated the expected protocol version', ternVerNum !== undefined && hello?.body?.ver === ternVerNum, JSON.stringify(hello?.body ?? null))
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
  /** Command scenario: the Work A header text at the proof instant. */
  let commandWorkAHeadText
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
  } else if (SCENARIO === 'command') {
    // Phase 1 — the command is durable while the SAME Turn has no continuation
    // yet: it stays a standalone row and the Turn keeps its ONE summary.
    if (!await waitFor(h, 'the real mid-Turn command lands before the second Work begins', () => {
      const rows = records(h)
      const roots = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'command.injected')
        && rows.some(row => row.kind === 'subject.model-step.held' && row.stepIndex === 1)
        && rows.some(row => row.kind === 'display.commit' && row.messageKinds.includes('command') && !row.finalPresent)
        && roots.length === 1
        && liveNodes(h).get(roots[0])?.p.collapsed === true
        && !h.texts(h.snapshot()).includes(promptInfo.assistantMarker)
    })) {
      finish(h, extra)
      return
    }
    // The fold record precedes the client repaint: wait for the REAL native
    // head to land before taking the geometry snapshot (a stale frame is not
    // evidence that the command card is absent).
    if (!await waitFor(h, 'the unbridged command row reaches the native client tree', () =>
      mainNodes(h.snapshot()).some(node =>
        String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && h.descendantsText(node).includes('/model switch')))) {
      finish(h, extra)
      return
    }
    const topLevelIndex = (snapshot, predicate) => mainNodes(snapshot).findIndex(predicate)
    const headWithText = (snapshot, text) => mainNodes(snapshot).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head') && h.descendantsText(node).includes(text))
    const trailingSnap = h.snapshot()
    const trailingRootIndex = topLevelIndex(trailingSnap, node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('Working'))
    const trailingCommandIndex = topLevelIndex(trailingSnap, node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('/model switch'))
    h.check('the unbridged mid-Turn command stays the ONE standalone control row',
      trailingCommandIndex >= 0, JSON.stringify(mainNodes(trailingSnap).map(node => ({ class: node.class, text: h.descendantsText(node) }))))
    h.check('the unbridged command still sits after the ONE summary in collapsed chronology',
      trailingRootIndex >= 0 && trailingCommandIndex > trailingRootIndex,
      JSON.stringify({ trailingRootIndex, trailingCommandIndex }))
    h.check('one logical Turn summary exists while the command is unbridged', rootIds(liveNodes(h)).length === 1)
    h.capture('focus-command-trailing-1280x800-dark',
      'the same Turn has the command at its raw tail before any continuation is evidenced')

    // The command card owns its OWN disclosure, independent of the Turn root.
    // A genuinely foldable outcome proves the client-native detail toggle (not
    // a fixture-injected flag).
    const commandHeadIn = snapshot => snapshot.nodes.find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('/model switch'))
    const commandDetailVisible = () => h.texts(h.snapshot()).some(line => line.includes('COMMAND-DETAIL-MARKER'))
    const toggleCommandDetail = async (label) => {
      const snapshot = h.snapshot()
      const head = commandHeadIn(snapshot)
      const clicked = head !== undefined && await h.click(snapshot.chains, head)
      h.check(label, clicked)
      return clicked
    }
    if (!await toggleCommandDetail('the standalone command detail toggles through the real client pointer')) {
      finish(h, extra)
      return
    }
    if (!await waitFor(h, 'the command detail body appears after the client toggle', commandDetailVisible)) {
      finish(h, extra)
      return
    }
    h.check('the standalone command detail toggle never opens a second Focus summary',
      rootIds(liveNodes(h)).length === 1, JSON.stringify(rootIds(liveNodes(h))))
    h.capture('focus-command-detail-collapsed-1280x800-dark',
      'the standalone command card owns its own native detail disclosure')

    // Phase 2 — a real same-Turn continuation (the second Tool call) lands: the
    // command is bridged and reflows ahead of the one collapsed summary.
    writeFileSync(join(h.root, 'release-tool-step.json'), `${JSON.stringify({ release: true })}\n`)
    if (!await waitFor(h, 'the second registered Tool executes after the command', () => {
      const rows = records(h)
      const roots = rootIds(liveNodes(h))
      return rows.some(row => row.kind === 'subject.tool-b.completed')
        && rows.some(row => row.kind === 'display.commit'
          && row.messageKinds.filter(kind => kind === 'tool').length === 2
          && row.messageKinds.includes('command') && !row.finalPresent)
        && liveNodes(h).get(roots[0])?.p.collapsed === true
        && !h.texts(h.snapshot()).includes(promptInfo.assistantMarker)
    })) {
      finish(h, extra)
      return
    }
    const topLevelIndexIn = (snapshot, text) => topLevelIndex(snapshot, node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head') && h.descendantsText(node).includes(text))
    // The native frame follows the display commit; wait for the reflowed order
    // before capturing. A baseline checkout never satisfies it and still keeps
    // the pre-fix frame as the before witness.
    const reflowed = await waitFor(h, 'the bridged command reflows ahead of the summary in the painted frame',
      () => {
        const snapshot = h.snapshot()
        const rootIndex = topLevelIndexIn(snapshot, 'Working')
        const commandIndex = topLevelIndexIn(snapshot, '/model switch')
        return rootIndex >= 0 && commandIndex >= 0 && commandIndex < rootIndex
      }, 120)
    const bridgedSnap = h.snapshot()
    const bridgedRootIndex = topLevelIndexIn(bridgedSnap, 'Working')
    const bridgedCommandIndex = topLevelIndexIn(bridgedSnap, '/model switch')
    // Capture BEFORE the cardinality assertion: this frame is the before/after
    // witness a baseline checkout can also produce (two summaries there).
    h.capture('focus-command-bridged-collapsed-1280x800-dark',
      'the continuation bridged the command ahead of the collapsed summary')
    const bridgedRootIds = rootIds(liveNodes(h))
    h.check('the bridged command reflows ahead of the ONE summary',
      reflowed && bridgedCommandIndex >= 0 && bridgedRootIndex >= 0 && bridgedCommandIndex < bridgedRootIndex,
      JSON.stringify({ reflowed, bridgedRootIndex, bridgedCommandIndex }))
    h.check('the bridged command never mints a second Focus summary', bridgedRootIds.length === 1,
      JSON.stringify(bridgedRootIds))
    if (bridgedRootIds.length !== 1) {
      finish(h, extra)
      return
    }

    // The reflowed command keeps its own disclosure operable and independent of
    // the one summary.
    if (!commandDetailVisible()) {
      if (!await toggleCommandDetail('the bridged command detail toggles after the reflow')) {
        finish(h, extra)
        return
      }
      if (!await waitFor(h, 'the bridged command detail body appears after the reflow toggle', commandDetailVisible)) {
        finish(h, extra)
        return
      }
    }
    h.check('the bridged command detail never opens a second Focus summary',
      rootIds(liveNodes(h)).length === 1, JSON.stringify(rootIds(liveNodes(h))))

    // Phase 3 — opening the one root keeps the command physically between the
    // two canonical Work runs and independent of their disclosure.
    const rootIdForCommand = rootIds(liveNodes(h))[0]
    const collapsedSnap = h.snapshot()
    const collapsedHead = headWithText(collapsedSnap, 'Working')
    const beforeOpen = eventRows(h).length
    h.check('the one Focus root opens through its real header with the bridged command',
      collapsedHead !== undefined && await h.click(collapsedSnap.chains, collapsedHead))
    if (!await waitFor(h, 'the client-generated open event for the command Turn', () => eventRows(h).length > beforeOpen)) {
      finish(h, extra)
      return
    }
    if (!await waitFor(h, 'the expanded Turn materializes its command and two Works', () => {
      const live = liveNodes(h)
      const parents = new Map()
      for (const entry of wire(h)) {
        if (entry.dir !== 'out' || entry.verb !== 'f') continue
        for (const op of entry.body?.ops ?? []) {
          if (op[0] === 'add' && typeof op[2] === 'string') parents.set(String(op[1]), op[2])
        }
      }
      const commandIds = [...live.entries()].filter(([id, node]) => (node.k === 'section' || node.k === 'card')
        && parents.get(id) === rootIdForCommand
        && subtreeText(live, id).includes('/model switch')).map(([id]) => id)
      const works = workIds(live, rootIdForCommand)
      return commandIds.length === 1 && works.length >= 2
        && parents.get(commandIds[0]) === rootIdForCommand
        && works.every(work => commandIds[0] !== work && !commandIds[0].startsWith(`${work}.`))
    })) {
      finish(h, extra)
      return
    }
    const expandedNodes = liveNodes(h)
    const expandedParents = new Map()
    for (const entry of wire(h)) {
      if (entry.dir !== 'out' || entry.verb !== 'f') continue
      for (const op of entry.body?.ops ?? []) {
        if (op[0] === 'add' && typeof op[2] === 'string') expandedParents.set(String(op[1]), op[2])
      }
    }
    const expandedCommand = [...expandedNodes.entries()].filter(([id, node]) => (node.k === 'section' || node.k === 'card')
      && expandedParents.get(id) === rootIdForCommand
      && subtreeText(expandedNodes, id).includes('/model switch'))
    const worksAfterOpen = workIds(expandedNodes, rootIdForCommand)
    h.check('the bridged command never hides the two canonical Work runs', worksAfterOpen.length === 2,
      JSON.stringify(worksAfterOpen))
    // ABSOLUTE lifetime fact on the REAL client tree: Work A is the Process run
    // BEFORE the command, so its displayed Activity duration must be exactly the
    // official command-run boundary minus the first real member — never the
    // member settle, and never a later Work/turn event.
    const lifetimeRows = records(h)
    const workACall = lifetimeRows.find(row => row.kind === 'subject.work-a-call')
    const commandInjected = lifetimeRows.find(row => row.kind === 'command.injected')
    const expectedWorkASeconds = typeof workACall?.time === 'number' && typeof commandInjected?.time === 'number'
      ? Math.floor((commandInjected.time - workACall.time) / 1000)
      : undefined
    const workAHead = mainNodes(h.snapshot()).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).startsWith('Activity')
      && h.descendantsText(node).includes('focus_command_a'))
    commandWorkAHeadText = workAHead === undefined ? undefined : h.descendantsText(workAHead)
    h.check('the seeded Work A Activity header carries a proven duration', workAHead !== undefined
      && expectedWorkASeconds !== undefined && commandWorkAHeadText.includes(`· ${expectedWorkASeconds}s ·`),
      JSON.stringify({ expectedWorkASeconds, head: commandWorkAHeadText ?? null }))
    await h.sleep(1_200)
    const workAAfterAdvance = mainNodes(h.snapshot()).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).startsWith('Activity')
      && h.descendantsText(node).includes('focus_command_a'))
    h.check('the closed Work A duration never grows as time advances',
      workAAfterAdvance !== undefined && h.descendantsText(workAAfterAdvance) === commandWorkAHeadText,
      JSON.stringify({ before: commandWorkAHeadText ?? null, after: workAAfterAdvance === undefined ? null : h.descendantsText(workAAfterAdvance) }))
    // The complete skill-catalog replacement is a Work A member (never a
    // standalone boundary): its body is unreachable while Work A is collapsed.
    const catalogMarker = 'TERN-CATALOG-BODY-MARKER'
    const catalogVisible = () => h.texts(h.snapshot()).some(line => line.includes(catalogMarker))
    const catalogInjectedRow = records(h).find(row => row.kind === 'catalog.injected')
    h.check('the complete catalog update is a durable same-turn source row',
      catalogInjectedRow !== undefined, JSON.stringify(catalogInjectedRow ?? null))
    h.check('the fixture clock keeps the catalog point strictly before the command boundary',
      typeof catalogInjectedRow?.time === 'number' && typeof commandInjected?.time === 'number'
        && catalogInjectedRow.time < commandInjected.time,
      JSON.stringify({ catalog: catalogInjectedRow?.time, command: commandInjected?.time }))
    h.check('the catalog body is folded while Work A is collapsed', !catalogVisible())

    const workACatalogHead = snapshot => mainNodes(snapshot).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).startsWith('Activity')
      && h.descendantsText(node).includes('focus_command_a'))
    const catalogHeadIn = snapshot => mainNodes(snapshot).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).trim() === 'skill-catalog')
    const nextToggle = before => eventRows(h).length > before ? eventRows(h).at(-1) : undefined
    const scrollNodeIntoMain = async (find) => {
      // The client owns smooth scrolling. Use its real viewport/dock geometry
      // and feed back on the actually observed movement instead of guessing a
      // direction from PageUp/PageDown page granularity.
      const viewport = () => h.ctl('stats').viewport ?? [1280, 800]
      let wheelSign = 1
      let step = 80
      let lastY
      for (let attempt = 0; attempt < 26; attempt += 1) {
        const snapshot = h.snapshot()
        const node = find(snapshot)
        if (node === undefined) return undefined
        const box = visibleBox(snapshot.chains, node)
        const dock = snapshot.nodes.find(candidate => String(candidate.class ?? '').split(/\s+/u).includes('tv-dock'))
        const dockTop = dock === undefined ? viewport()[1] - 8 : rect(dock)[1]
        const visibleTop = 24
        const visibleBottom = Math.max(visibleTop + 8, dockTop - 8)
        const clickable = box.span.x >= 4 && box.span.y >= 4
          && box.start.y >= visibleTop && box.start.y + box.span.y <= visibleBottom
        if (clickable) return { snapshot, node, box, dockTop, attempts: attempt }
        const nodeRect = rect(node)
        const wantIncrease = nodeRect[1] < visibleTop
        const point = {
          x: Math.max(1, Math.min(viewport()[0] - 1, viewport()[0] / 2)),
          y: Math.max(visibleTop + 12, Math.min(visibleBottom - 12, (visibleTop + visibleBottom) / 2)),
        }
        const beforeY = nodeRect[1]
        h.send('move', point.x, point.y)
        h.send('wheel', 0, wheelSign * step)
        const after = h.snapshot()
        const afterNode = find(after)
        const afterY = afterNode === undefined ? undefined : rect(afterNode)[1]
        if (afterY === undefined || lastY === afterY) {
          wheelSign = -wheelSign
        } else {
          const movedDown = afterY > beforeY
          if (movedDown !== wantIncrease) {
            wheelSign = -wheelSign
            step = Math.max(8, Math.floor(step / 2))
          } else if ((beforeY < visibleTop && afterY > visibleBottom)
            || (beforeY + nodeRect[3] > visibleBottom && afterY + nodeRect[3] < visibleTop)) {
            step = Math.max(8, Math.floor(step / 2))
          }
        }
        lastY = afterY
      }
      return undefined
    }

    const workAOpenSnap = h.snapshot()
    const workAHeadForCatalog = workACatalogHead(workAOpenSnap)
    const workACatalogId = workIds(liveNodes(h), rootIdForCommand)
      .find(id => subtreeText(liveNodes(h), id).includes('focus_command_a'))
    h.check('the seeded catalog journey resolves the exact native Work A id',
      typeof workACatalogId === 'string' && workAHeadForCatalog !== undefined,
      JSON.stringify({ workACatalogId: workACatalogId ?? null }))
    h.check('Work A opens through its real native header pointer',
      workAHeadForCatalog !== undefined && await h.click(workAOpenSnap.chains, workAHeadForCatalog),
      JSON.stringify(workAHeadForCatalog === undefined ? null : h.descendantsText(workAHeadForCatalog)))
    if (!await waitFor(h, 'the Work A header reports its own open state',
      () => workAHeadForCatalog !== undefined
        && liveNodes(h).get(workACatalogId ?? '')?.p.collapsed === false)) {
      finish(h, extra)
      return
    }
    // The catalog head is now visible, but its own body is still hidden: Work A
    // opening must never reveal a member behind its own card disclosure.
    h.check('opening Work A exposes the catalog card but not its body', !catalogVisible())
    const catalogOpenSnap = h.snapshot()
    const catalogHead = catalogHeadIn(catalogOpenSnap)
    h.check('the carried catalog exposes its own native header',
      catalogHead !== undefined,
      JSON.stringify(catalogHead === undefined ? null : { text: h.descendantsText(catalogHead) }))
    if (catalogHead === undefined) {
      finish(h, extra)
      return
    }
    const beforeCatalogOpen = eventRows(h).length
    h.check('the catalog Section opens through its own native header pointer',
      await h.click(catalogOpenSnap.chains, catalogHead),
      JSON.stringify({ head: h.descendantsText(catalogHead) }))
    if (!await waitFor(h, 'the catalog body appears after its own native toggle', catalogVisible)) {
      finish(h, extra)
      return
    }
    const catalogOpenEvent = nextToggle(beforeCatalogOpen)
    const catalogSectionId = catalogOpenEvent?.id
    const catalogOpenLive = catalogSectionId === undefined ? undefined : liveNodes(h).get(catalogSectionId)
    h.check('the catalog toggle addresses the exact Section id and reports collapsed=false',
      typeof catalogSectionId === 'string' && catalogOpenEvent?.collapsed === false
        && catalogOpenLive?.k === 'section' && catalogOpenLive.p.head === 'skill-catalog',
      JSON.stringify({ event: catalogOpenEvent ?? null, section: catalogOpenLive?.p ?? null }))
    if (typeof catalogSectionId !== 'string') {
      finish(h, extra)
      return
    }
    h.check('the exact catalog Section is open in the native tree',
      catalogOpenLive !== undefined && catalogOpenLive.p.collapsed === false,
      JSON.stringify(catalogOpenLive?.p ?? null))
    const catalogOpenStateSnap = h.snapshot()
    const catalogBodyNode = mainNodes(catalogOpenStateSnap).find(node =>
      String(node.text ?? '').includes(catalogMarker))
    const catalogBodySpan = catalogBodyNode === undefined ? { x: 0, y: 0 } : {
      x: visibleSpan(catalogOpenStateSnap.chains, catalogBodyNode, 'x'),
      y: visibleSpan(catalogOpenStateSnap.chains, catalogBodyNode, 'y'),
    }
    h.check('the opened catalog body has visible fragments on both axes at 1280x800',
      catalogBodySpan.x >= 4 && catalogBodySpan.y >= 4,
      JSON.stringify({ catalogBodySpan, rect: rect(catalogBodyNode ?? {}) }))
    const catalogBodyIds = [...liveNodes(h).entries()]
      .filter(([id]) => subtreeText(liveNodes(h), id).includes(catalogMarker))
      .map(([id]) => id)
    h.check('the catalog body belongs to Work A, not the Turn root or a synthetic container',
      typeof workACatalogId === 'string'
        && catalogBodyIds.some(id => id.startsWith(`${workACatalogId}.`)),
      JSON.stringify({ workACatalogId, catalogBodyIds }))
    h.check('opening Work A never mints a second Focus summary', rootIds(liveNodes(h)).length === 1,
      JSON.stringify(rootIds(liveNodes(h))))
    h.capture('focus-command-catalog-work-a-open-1280x800-dark',
      'Work A opens through the native header and restores the carried complete catalog body')

    const catalogCloseSnap = h.snapshot()
    const catalogCloseHead = catalogHeadIn(catalogCloseSnap)
    const beforeCatalogClose = eventRows(h).length
    h.check('the SAME catalog Section closes through its exact native header',
      catalogCloseHead !== undefined && await h.click(catalogCloseSnap.chains, catalogCloseHead),
      JSON.stringify({ catalogSectionId, head: catalogCloseHead?.id ?? null }))
    if (!await waitFor(h, 'the catalog body disappears after the same exact toggle', () => !catalogVisible())) {
      finish(h, extra)
      return
    }
    const catalogCloseEvent = nextToggle(beforeCatalogClose)
    h.check('the closing toggle addresses the same Section id and reports collapsed=true',
      catalogCloseEvent?.id === catalogSectionId && catalogCloseEvent.collapsed === true,
      JSON.stringify(catalogCloseEvent ?? null))
    const catalogClosedLive = liveNodes(h).get(catalogSectionId)
    h.check('the exact catalog Section is closed in the native tree',
      catalogClosedLive !== undefined && catalogClosedLive.p.collapsed === true,
      JSON.stringify(catalogClosedLive?.p ?? null))
    h.check('closing the catalog Section keeps the one Root and both canonical Works intact',
      liveNodes(h).get(rootIdForCommand)?.p.collapsed === false
        && workIds(liveNodes(h), rootIdForCommand).length === 2,
      JSON.stringify({ root: liveNodes(h).get(rootIdForCommand)?.p.collapsed }))

    const closeWorkASnap = h.snapshot()
    const closeWorkAHead = workACatalogHead(closeWorkASnap)
    h.check('Work A closes through the same real native header pointer',
      closeWorkAHead !== undefined && await h.click(closeWorkASnap.chains, closeWorkAHead))
    if (!await waitFor(h, 'the catalog body stays folded with Work A closed', () => !catalogVisible())) {
      finish(h, extra)
      return
    }
    h.check('closing Work A keeps the one Root open and both canonical Works intact',
      liveNodes(h).get(rootIdForCommand)?.p.collapsed === false
        && workIds(liveNodes(h), rootIdForCommand).length === 2,
      JSON.stringify({ root: liveNodes(h).get(rootIdForCommand)?.p.collapsed }))

    // The SAME catalog journey at the narrow/short sizes: real resize, real
    // native header click, exact Section toggle, body two-axis visibility and
    // clipping ancestors; no new sleeps or relaxed geometry thresholds.
    const catalogViewports = [{ width: 400, height: 600, appearance: 'dark' }, { width: 900, height: 360, appearance: 'light' }]
    for (const viewport of catalogViewports) {
      await h.resize(viewport.width, viewport.height)
      h.send('appearance', viewport.appearance)
      if (!await waitFor(h, `the client resolves ${viewport.appearance} at ${viewport.width}x${viewport.height}`,
        () => h.ctl('state').theme === viewport.appearance)) {
        finish(h, extra)
        return
      }
      // Restore the open root at this viewport, then scroll its Work A header
      // into the normal Main viewport before clicking.
      const narrowWork = await scrollNodeIntoMain(workACatalogHead)
      if (narrowWork === undefined) {
        h.check(`Work A is reachable through normal scrolling at ${viewport.width}x${viewport.height}`, false, 'unreachable')
        finish(h, extra)
        return
      }
      h.check(`Work A is reachable through normal scrolling at ${viewport.width}x${viewport.height}`,
        true, JSON.stringify({ rect: rect(narrowWork.node), box: narrowWork.box, dockTop: narrowWork.dockTop }))
      const beforeNarrowWorkOpen = eventRows(h).length
      h.check(`Work A opens at ${viewport.width}x${viewport.height}`,
        await h.click(narrowWork.snapshot.chains, narrowWork.node))
      if (!await waitFor(h, `Work A reports open at ${viewport.width}x${viewport.height}`,
        () => liveNodes(h).get(workACatalogId ?? '')?.p.collapsed === false)) {
        finish(h, extra)
        return
      }
      h.check(`the Work A toggle addresses the exact Work id at ${viewport.width}x${viewport.height}`,
        eventRows(h).length > beforeNarrowWorkOpen
          && eventRows(h).at(-1)?.id === workACatalogId && eventRows(h).at(-1)?.collapsed === false,
        JSON.stringify(eventRows(h).at(-1) ?? null))
      h.check(`the catalog body stays hidden before its own toggle at ${viewport.width}x${viewport.height}`, !catalogVisible())
      const narrowCatalog = await scrollNodeIntoMain(catalogHeadIn)
      h.check(`the catalog header is reachable through normal scrolling at ${viewport.width}x${viewport.height}`,
        narrowCatalog !== undefined,
        JSON.stringify(narrowCatalog === undefined ? null : { rect: rect(narrowCatalog.node), box: narrowCatalog.box, dockTop: narrowCatalog.dockTop }))
      if (narrowCatalog === undefined) {
        finish(h, extra)
        return
      }
      const narrowCatalogSnap = narrowCatalog.snapshot
      const narrowCatalogHead = narrowCatalog.node
      h.check(`the exact catalog Section id stays attached at ${viewport.width}x${viewport.height}`,
        liveNodes(h).get(catalogSectionId)?.k === 'section',
        JSON.stringify({ expected: catalogSectionId, section: liveNodes(h).get(catalogSectionId)?.p ?? null }))
      const beforeNarrowOpen = eventRows(h).length
      h.check(`the catalog Section opens at ${viewport.width}x${viewport.height}`,
        await h.click(narrowCatalogSnap.chains, narrowCatalogHead))
      if (!await waitFor(h, `the catalog body appears at ${viewport.width}x${viewport.height}`, catalogVisible)) {
        finish(h, extra)
        return
      }
      const narrowOpenEvent = nextToggle(beforeNarrowOpen)
      h.check(`the narrow catalog toggle keeps the exact Section id at ${viewport.width}x${viewport.height}`,
        narrowOpenEvent?.id === catalogSectionId && narrowOpenEvent.collapsed === false,
        JSON.stringify(narrowOpenEvent ?? null))
      const narrowOpenSnap = h.snapshot()
      const narrowBody = mainNodes(narrowOpenSnap).find(node => String(node.text ?? '').includes(catalogMarker))
      const narrowSpan = narrowBody === undefined ? { x: 0, y: 0 } : {
        x: visibleSpan(narrowOpenSnap.chains, narrowBody, 'x'),
        y: visibleSpan(narrowOpenSnap.chains, narrowBody, 'y'),
      }
      const clippingAncestors = narrowBody === undefined
        ? []
        : ancestorsOf(narrowOpenSnap.chains, narrowBody)
          .map(node => ({ id: node.id, class: node.class, rect: rect(node) }))
      h.check(`the opened catalog body has visible fragments on both axes at ${viewport.width}x${viewport.height}`,
        narrowSpan.x >= 4 && narrowSpan.y >= 4,
        JSON.stringify({ narrowSpan, body: rect(narrowBody ?? {}), clippingAncestors }))
      h.capture(`focus-command-catalog-${viewport.width}x${viewport.height}-${viewport.appearance}`,
        'the carried complete catalog opens by its exact native Section at the narrow/short viewport')
      const narrowCloseSnap = h.snapshot()
      const narrowCloseHead = catalogHeadIn(narrowCloseSnap)
      const beforeNarrowClose = eventRows(h).length
      h.check(`the same catalog Section closes at ${viewport.width}x${viewport.height}`,
        narrowCloseHead !== undefined && await h.click(narrowCloseSnap.chains, narrowCloseHead))
      if (!await waitFor(h, `the catalog body folds again at ${viewport.width}x${viewport.height}`, () => !catalogVisible())) {
        finish(h, extra)
        return
      }
      const narrowCloseEvent = nextToggle(beforeNarrowClose)
      h.check(`the narrow closing toggle keeps the exact Section id at ${viewport.width}x${viewport.height}`,
        narrowCloseEvent?.id === catalogSectionId && narrowCloseEvent.collapsed === true,
        JSON.stringify(narrowCloseEvent ?? null))
      const narrowWorkClose = await scrollNodeIntoMain(workACatalogHead)
      h.check(`Work A closes again at ${viewport.width}x${viewport.height}`,
        narrowWorkClose !== undefined && await h.click(narrowWorkClose.snapshot.chains, narrowWorkClose.node))
      await waitFor(h, `Work A reports closed at ${viewport.width}x${viewport.height}`,
        () => liveNodes(h).get(workACatalogId ?? '')?.p.collapsed === true)
    }
    await h.resize(1280, 800)
    h.send('appearance', 'dark')
    if (!await waitFor(h, 'the client restores dark at 1280x800', () => h.ctl('state').theme === 'dark')) {
      finish(h, extra)
      return
    }
    const commandId = expandedCommand[0]?.[0]
    h.check('the command is a top-level Root child, never wrapped by a Work container',
      commandId !== undefined && !worksAfterOpen.some(work => commandId.startsWith(`${work}.`)))
    const frameAddOrder = []
    for (const entry of wire(h)) {
      if (entry.dir !== 'out' || entry.verb !== 'f') continue
      for (const op of entry.body?.ops ?? []) {
        if (op[0] === 'add' && typeof op[2] === 'string' && op[2] === rootIdForCommand) frameAddOrder.push(String(op[1]))
      }
    }
    const commandOrder = commandId === undefined ? -1 : frameAddOrder.indexOf(commandId)
    const workOrders = worksAfterOpen.map(work => frameAddOrder.indexOf(work)).sort((left, right) => left - right)
    h.check('the command keeps its exact A -> command -> B position in the open Turn',
      commandOrder >= 0 && workOrders.length === 2 && commandOrder > workOrders[0] && commandOrder < workOrders[1],
      JSON.stringify({ frameAddOrder, commandOrder, workOrders }))
    h.capture('focus-command-expanded-1280x800-dark',
      'the same Turn opened: Work A, the independent command row, then Work B')

    // The command's OWN detail still toggles while the root is open: closing it
    // must neither collapse the root nor disturb the two Work runs.
    if (!await toggleCommandDetail('the expanded root keeps the command detail independently operable')) {
      finish(h, extra)
      return
    }
    if (!await waitFor(h, 'the command detail closes while the root stays open',
      () => !commandDetailVisible())) {
      finish(h, extra)
      return
    }
    h.check('the command detail toggle never closes the one open root',
      liveNodes(h).get(rootIdForCommand)?.p.collapsed === false
        && workIds(liveNodes(h), rootIdForCommand).length === 2,
      JSON.stringify({ root: liveNodes(h).get(rootIdForCommand)?.p.collapsed }))

    const closeSnap = h.snapshot()
    const closeHead = headWithText(closeSnap, 'Working')
    const beforeCloseCommand = eventRows(h).length
    h.check('the opened command Turn closes through the same header',
      closeHead !== undefined && await h.click(closeSnap.chains, closeHead))
    if (!await waitFor(h, 'the client-generated close event for the command Turn',
      () => eventRows(h).length > beforeCloseCommand && eventRows(h).at(-1)?.collapsed === true)) {
      finish(h, extra)
      return
    }
    if (!await waitFor(h, 'the closed command Turn returns one visible standalone control row', () => {
      const live = liveNodes(h)
      const roots = rootIds(live)
      const parents = new Map()
      for (const entry of wire(h)) {
        if (entry.dir !== 'out' || entry.verb !== 'f') continue
        for (const op of entry.body?.ops ?? []) {
          if (op[0] === 'add' && typeof op[2] === 'string') parents.set(String(op[1]), op[2])
        }
      }
      return roots.length === 1
        && [...live.entries()].some(([id, node]) => (node.k === 'section' || node.k === 'card')
          && parents.get(id) === 'main'
          && subtreeText(live, id).includes('/model switch'))
    })) {
      finish(h, extra)
      return
    }

    // After the root closes, the command is standalone again and still owns its
    // own detail disclosure: toggling it never reopens/collapses the root.
    if (!commandDetailVisible()) {
      if (!await toggleCommandDetail('the standalone command detail toggles after the root closes')) {
        finish(h, extra)
        return
      }
      if (!await waitFor(h, 'the command detail body appears after the root closes', commandDetailVisible)) {
        finish(h, extra)
        return
      }
    }
    h.check('the closed root stays closed while the command detail toggles',
      rootIds(liveNodes(h)).length === 1
        && liveNodes(h).get(rootIds(liveNodes(h))[0])?.p.collapsed === true,
      JSON.stringify({ roots: rootIds(liveNodes(h)), root: liveNodes(h).get(rootIds(liveNodes(h))[0])?.p }))
    h.capture('focus-command-detail-after-close-1280x800-dark',
      'the command detail stays independent of the closed Focus root')
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
    const maskedSnapshot = h.snapshot()
    const maskedRootHead = visibleSectionHead(maskedSnapshot, h, 'Waiting for input')
    const dim = maskedSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-ov-dim'))
    const rootBox = maskedRootHead === undefined ? [0, 0, 0, 0] : rect(maskedRootHead)
    const dimBox = dim === undefined ? [0, 0, 0, 0] : rect(dim)
    const headerPoint = [rootBox[0] + rootBox[2] / 2, rootBox[1] + rootBox[3] / 2]
    const rootPointMaskedByModal = maskedRootHead !== undefined && dim !== undefined
      && headerPoint[0] >= dimBox[0] && headerPoint[0] <= dimBox[0] + dimBox[2]
      && headerPoint[1] >= dimBox[1] && headerPoint[1] <= dimBox[1] + dimBox[3]
    h.check('the official Ask User dim layer covers the current Focus Root pointer target', rootPointMaskedByModal,
      JSON.stringify({ root: rootBox, dim: dimBox, headerPoint }))
    h.check('the underlying Focus Root remains closed before the masked pointer attempt', rootId !== undefined
      && liveNodes(h).get(rootId)?.p.collapsed === true, JSON.stringify(rootId === undefined ? null : liveNodes(h).get(rootId)?.p))
    const beforeMaskedRootClick = eventRows(h).length
    h.check('a real client pointer can target the visible native Focus head behind the modal', maskedRootHead !== undefined
      && await h.click(maskedSnapshot.chains, maskedRootHead),
      JSON.stringify(maskedRootHead === undefined ? null : { text: h.descendantsText(maskedRootHead), rect: rect(maskedRootHead) }))
    h.check('the masked pointer produces no Focus Root toggle event and leaves it closed', eventRows(h).length === beforeMaskedRootClick
      && rootId !== undefined && liveNodes(h).get(rootId)?.p.collapsed === true,
      JSON.stringify({ events: eventRows(h).slice(beforeMaskedRootClick), root: rootId === undefined ? undefined : liveNodes(h).get(rootId)?.p }))
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
    const visibleHeaders = snapshot.nodes
      .filter(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head'))
      .map(node => ({ node, visible: visibleBox(snapshot.chains, node) }))
      .filter(entry => entry.visible.span.x >= 4 && entry.visible.span.y >= 4)
    const dock = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-dock'))
    const dockRect = rect(dock ?? {})
    const dockOverlaps = visibleHeaders.filter(({ visible }) => {
      const left = visible.start.x
      const top = visible.start.y
      const right = left + visible.span.x
      const bottom = top + visible.span.y
      return dock !== undefined && left < dockRect[0] + dockRect[2] && right > dockRect[0]
        && top < dockRect[1] + dockRect[3] && bottom > dockRect[1]
    }).map(({ node, visible }) => ({ text: h.descendantsText(node), rect: visible.rect, start: visible.start, span: visible.span }))
    h.check(`visible Focus and inner Section headers do not overlap Dock/Composer at ${viewport.width}x${viewport.height}`,
      dock !== undefined && dockOverlaps.length === 0,
      JSON.stringify({ dock: dockRect, headers: visibleHeaders.map(({ node, visible }) => ({
        text: h.descendantsText(node), rect: visible.rect, start: visible.start, span: visible.span,
      })), overlaps: dockOverlaps }))
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
  const expectedWorkCount = SCENARIO === 'question' ? 0 : SCENARIO === 'svg' || SCENARIO === 'command' ? 2 : 1
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
      : SCENARIO === 'command'
        ? nestedWorks.find(id => subtreeText(live, id).includes('focus_command_a'))
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
      : SCENARIO === 'command'
        ? mainNodes(workSnap).find(node => String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
          && h.descendantsText(node).startsWith('Activity') && h.descendantsText(node).includes('focus_command_a'))
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
        const childToolsAppeared = await waitFor(h, 'the opened Work materializes its own Tool row',
          () => [...liveNodes(h).entries()].some(([id, node]) => id.startsWith(`${workId}.`) && node.k === 'tool'))
        live = liveNodes(h)
        const childTools = [...live.entries()].filter(([id, node]) => id.startsWith(`${workId}.`) && node.k === 'tool')
        h.check('opening this Work materializes its own registered Tool', childToolsAppeared && childTools.length === 1,
          JSON.stringify(childTools.map(([id]) => id)))
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
    return [...nodes.entries()].some(([id, node]) => isAssistantRow(node)
      && !id.startsWith(`${rootId}.`)
      && subtreeText(nodes, id).includes(promptInfo.assistantMarker))
  }, 400)) {
    finish(h, extra)
    return
  }
  live = liveNodes(h)
  const finalCards = [...live.entries()].filter(([id, node]) => isAssistantRow(node)
    && !id.startsWith(`${rootId}.`)
    && subtreeText(live, id).includes(promptInfo.assistantMarker))
  h.check('official turn/end publishes one final Assistant outside the Focus root', finalCards.length === 1, JSON.stringify(finalCards.map(([id]) => id)))
  h.check('the subject recorded an authoritative completed activity after release',
    records(h).some(row => row.kind === 'display.commit' && row.completedTurns.includes(1) && row.finalPresent))
  if (SCENARIO === 'command') {
    // The seeded standalone maintenance card after the closed turn: it must be
    // one top-level native row AFTER the official final, own its detail toggle,
    // and never mint a Focus root or re-open the real Turn.
    if (!await waitFor(h, 'the standalone compaction card lands after the official final', () => {
      if (!records(h).some(row => row.kind === 'standalone.injected')) return false
      // Require the REAL main-region head, not only the dock echo: the dock
      // notification paints the failure title before the transcript commit.
      return mainNodes(h.snapshot()).some(node =>
        String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
        && h.descendantsText(node).includes('Compaction failed'))
    })) {
      finish(h, extra)
      return
    }
    const standaloneSnap = h.snapshot()
    const standaloneNodes = mainNodes(standaloneSnap)
    const standaloneHeadOf = snapshot => mainNodes(snapshot).find(node =>
      String(node.class ?? '').split(/\s+/u).includes('sf-section-head')
      && h.descendantsText(node).includes('Compaction failed'))
    const compactionHead = standaloneHeadOf(standaloneSnap)
    const finalTrailingRow = standaloneNodes.find(node =>
      typeof node.text === 'string' && node.text.includes(promptInfo.assistantMarker))
    h.check('the standalone compaction keeps its real position after the final Assistant',
      compactionHead !== undefined && finalTrailingRow !== undefined
        && standaloneNodes.indexOf(compactionHead) > standaloneNodes.indexOf(finalTrailingRow),
      JSON.stringify({ compaction: compactionHead === undefined ? null : h.descendantsText(compactionHead),
        final: finalTrailingRow === undefined ? null : h.descendantsText(finalTrailingRow) }))
    const rootIdBeforeStandalone = rootIds(liveNodes(h))[0]
    const rootCollapsedBefore = liveNodes(h).get(rootIdBeforeStandalone)?.p.collapsed
    h.check('the standalone compaction never mints a second Focus root', rootIds(liveNodes(h)).length === 1,
      JSON.stringify(rootIds(liveNodes(h))))
    const marker = 'STANDALONE-DETAIL-MARKER'
    const standaloneDetailVisible = () => h.texts(h.snapshot()).some(line => line.includes(marker))
    // The DOM snapshot carries no SDK ids; the LIVE wire tree does. The exact
    // top-level standalone Section is the one whose subtree holds the failure
    // title but not the summary-body marker while collapsed.
    const standaloneSectionIdOfLive = (nodes) => [...nodes.entries()].find(([id, node]) =>
      id.startsWith('main.') && node.k === 'section' && node.p.collapsible === true
      && subtreeText(nodes, id).includes('Compaction failed'))?.[0]
    const liveBeforeStandalone = liveNodes(h)
    const sectionBeforeId = standaloneSectionIdOfLive(liveBeforeStandalone)
    const sectionBefore = sectionBeforeId === undefined ? undefined : liveBeforeStandalone.get(sectionBeforeId)
    // R1-02 PRECONDITION: the body-only marker is really hidden in the collapsed
    // card (it lives only in the summary body; neither the head preview nor the
    // dock failure echo paints it), and the exact section is a closed Section
    // before any pointer input.
    h.check('the collapsed standalone head does not paint the body-only detail',
      !standaloneDetailVisible(), JSON.stringify({ section: sectionBeforeId ?? null }))
    h.check('the standalone compaction starts as its own collapsed native section',
      sectionBefore !== undefined && sectionBefore.p.collapsed === true,
      JSON.stringify({ section: sectionBeforeId ?? null, collapsed: sectionBefore?.p.collapsed }))
    // R1-02: UNCONDITIONAL real-header click. The previous conditional skip let
    // a head-preview text match masquerade as an opened body.
    const openTogglesBefore = eventRows(h).length
    h.check('the standalone compaction head opens through the real client pointer',
      compactionHead !== undefined && await h.click(standaloneSnap.chains, compactionHead))
    if (!await waitFor(h, 'the standalone detail body appears after the client toggle', standaloneDetailVisible)) {
      finish(h, extra)
      return
    }
    const openToggle = eventRows(h).slice(openTogglesBefore).at(-1)
    h.check('the open toggle addresses exactly the standalone section, never the Focus root',
      openToggle !== undefined && openToggle.id === sectionBeforeId && openToggle.collapsed === false,
      JSON.stringify({ toggle: openToggle ?? null, section: sectionBeforeId ?? null, root: rootIdBeforeStandalone }))
    if (!await waitFor(h, 'the opened section body reaches the live wire tree', () => {
      const live = liveNodes(h)
      return sectionBeforeId !== undefined && [...live.entries()].some(([id, node]) =>
        id.startsWith(`${sectionBeforeId}.`) && String(node.p.text ?? '').includes(marker))
    })) {
      finish(h, extra)
      return
    }
    h.check('the opened detail body belongs to that exact section',
      sectionBeforeId !== undefined && [...liveNodes(h).entries()].some(([id, node]) =>
        id.startsWith(`${sectionBeforeId}.`) && String(node.p.text ?? '').includes(marker)),
      JSON.stringify({ section: sectionBeforeId ?? null }))
    h.check('the standalone detail opens without changing the one real root state',
      rootIds(liveNodes(h)).length === 1
        && liveNodes(h).get(rootIdBeforeStandalone)?.p.collapsed === rootCollapsedBefore,
      JSON.stringify({ roots: rootIds(liveNodes(h)), collapsed: liveNodes(h).get(rootIdBeforeStandalone)?.p.collapsed }))
    h.capture('focus-standalone-compaction-open-1280x800-dark',
      'the standalone compaction after the closed turn owns an independent native detail')
    // R1-02: close it again through the same real header and prove the exact
    // section (not the root) toggled back.
    const closeSnap = h.snapshot()
    const closeHead = standaloneHeadOf(closeSnap)
    const closeTogglesBefore = eventRows(h).length
    h.check('the standalone compaction head closes through the same real pointer',
      closeHead !== undefined && await h.click(closeSnap.chains, closeHead))
    if (!await waitFor(h, 'the standalone detail body retracts after the close toggle',
      () => !standaloneDetailVisible())) {
      finish(h, extra)
      return
    }
    const closeToggle = eventRows(h).slice(closeTogglesBefore).at(-1)
    h.check('the close toggle addresses exactly the standalone section',
      closeToggle !== undefined && closeToggle.id === sectionBeforeId && closeToggle.collapsed === true,
      JSON.stringify({ toggle: closeToggle ?? null, section: sectionBeforeId ?? null }))
    h.check('closing the standalone detail leaves the one real root state unchanged',
      rootIds(liveNodes(h)).length === 1
        && liveNodes(h).get(rootIdBeforeStandalone)?.p.collapsed === rootCollapsedBefore,
      JSON.stringify({ roots: rootIds(liveNodes(h)), collapsed: liveNodes(h).get(rootIdBeforeStandalone)?.p.collapsed }))

    // R1-02 §13.3: qualify the SAME card at the targeted narrow width and short
    // height with real clipping observation — never reusing the earlier generic
    // Focus screenshots as standalone-card evidence.
    for (const viewport of [
      { width: 400, height: 600, appearance: 'dark' },
      { width: 900, height: 360, appearance: 'light' },
    ]) {
      const resized = await h.resize(viewport.width, viewport.height)
      if (IS_GUI) h.check('the GUI window remains at the supported content size', resized.clamped === false, JSON.stringify(resized))
      h.send('appearance', viewport.appearance)
      const label = `${viewport.width}x${viewport.height}`
      const closedSnap = h.snapshot()
      const closedHead = standaloneHeadOf(closedSnap)
      const closedSpan = closedHead === undefined ? { x: 0, y: 0 } : {
        x: visibleSpan(closedSnap.chains, closedHead, 'x'),
        y: visibleSpan(closedSnap.chains, closedHead, 'y'),
      }
      h.check(`the standalone compaction header survives clipping at ${label}`,
        closedHead !== undefined && closedSpan.x >= 4 && closedSpan.y >= 4,
        JSON.stringify({ span: closedSpan, rect: closedHead === undefined ? null : rect(closedHead) }))
      h.capture(`focus-standalone-compaction-collapsed-${label}-${viewport.appearance}`,
        `collapsed standalone compaction at ${label}`)
      const narrowOpenBefore = eventRows(h).length
      h.check(`the standalone header opens at ${label}`,
        closedHead !== undefined && await h.click(closedSnap.chains, closedHead))
      if (!await waitFor(h, `the standalone detail opens at ${label}`, standaloneDetailVisible)) {
        finish(h, extra)
        return
      }
      const openSnap = h.snapshot()
      // The DOM tree carries no semantic `k`: measure the ACTUAL text node
      // that paints the marker and its surviving clipped span.
      const bodyNode = openSnap.nodes.find(node =>
        String(node.text ?? '').includes(marker) && rect(node)[3] > 0)
      const bodySpan = bodyNode === undefined ? 0 : visibleSpan(openSnap.chains, bodyNode, 'y')
      h.check(`the opened standalone body is actually readable at ${label}`,
        bodyNode !== undefined && bodySpan >= 4,
        JSON.stringify({ body: bodyNode === undefined ? null : rect(bodyNode), visibleY: bodySpan }))
      const narrowToggle = eventRows(h).slice(narrowOpenBefore).at(-1)
      h.check(`the ${label} pointer addresses exactly the standalone section`,
        narrowToggle !== undefined && narrowToggle.id === sectionBeforeId && narrowToggle.collapsed === false,
        JSON.stringify({ toggle: narrowToggle ?? null, section: sectionBeforeId ?? null }))
      h.capture(`focus-standalone-compaction-open-${label}-${viewport.appearance}`,
        `open standalone compaction detail at ${label}`)
      const narrowCloseSnap = h.snapshot()
      const narrowCloseHead = standaloneHeadOf(narrowCloseSnap)
      h.check(`the standalone header closes again at ${label}`,
        narrowCloseHead !== undefined && await h.click(narrowCloseSnap.chains, narrowCloseHead))
      if (!await waitFor(h, `the standalone detail closes at ${label}`,
        () => !standaloneDetailVisible())) {
        finish(h, extra)
        return
      }
    }
    await h.resize(1280, 800)
    h.send('appearance', 'dark')
  }
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
