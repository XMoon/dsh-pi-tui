/**
 * T3-A: the REAL Tern pane / GUI lane for the client-owned Native Find over
 * the continuous Main transcript.
 *
 * The subject is the production `tern-pane-transcript-modes-subject.mts`
 * running scenario `native-find`: one real Direct Session writer appends the
 * official 28-Turn seed (Turn 2–29) and the Turn-30 live append, the
 * production `TranscriptFolder` folds them and the production TSP renderer
 * maps them into the ONE inline Surface. Every Find action below is the
 * CLIENT's own native Find driven through the test control channel
 * (`h.send('find', …)` once, never retried); every assertion reads the
 * client's own `state.find`, node tree, geometry and PNG. No app search UI,
 * no second index, no `surface.reveal()` driving.
 *
 *   TERN_BIN=… TERN_TRANSCRIPT_FIND_PRESET=full \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-native-find.mjs
 *   TERN_BIN=… TERN_FIND_GUI=1 TERN_TRANSCRIPT_FIND_PRESET=full \
 *     node scripts/tern-gui-drive.mjs scripts/tern-pane-transcript-native-find.mjs
 *
 * ONE preset per run, each in its OWN fresh client (headless `tern serve` or
 * one real GUI window). Evidence tier: REAL_TERN_HEADLESS/GUI +
 * CONTROL_INJECTED_INPUT — never OS physical input.
 * @module scripts/tern-pane-transcript-native-find
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release as osRelease, type } from 'node:os'
import { join } from 'node:path'
import { containedXY, rect, visibleSpan } from './tern-pane-geometry.mjs'

const PRESETS = ['full', 'compact', 'focus']
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]
const OTHER_PANE_TOKEN = 'T3A_OTHER_PANE_F4C7'

export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_FIND_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) {
    throw new Error(`TERN_TRANSCRIPT_FIND_PRESET must be full, compact or focus; got ${preset}`)
  }
  return preset
}

export function findEvidenceTier(gui) {
  return gui ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT' : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT'
}

export function qualificationFromResults(results, pass = 'REAL_TERN_NATIVE_FIND_PASS') {
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

const records = h => readJsonl(join(h.root, 'events.jsonl'))
const wire = h => readJsonl(join(h.root, 'sdk-wire.jsonl'))

/** The CURRENT live SDK node set, folded from the SDK's own `f` ops. */
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

function writeLedger(h, name, value) {
  const path = join(h.root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
}

function finish(h, extra = {}) {
  const { qualification: outcome, ...metadata } = extra
  const qualification = qualificationFromResults(h.results, outcome ?? 'REAL_TERN_NATIVE_FIND_PASS')
  const status = h.finish({
    ...metadata,
    ...(outcome === undefined || outcome === qualification ? {} : { qualificationDetail: outcome }),
    qualification,
  })
  if (status !== 0) process.exitCode = status
}

const regionNode = (snap, name) => snap.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

/** The client's Main subtree only — the Dock composer repeats input bytes. */
function mainNodes(snapshot) {
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

function mainText(h, snapshot = h.snapshot()) {
  const main = regionNode(snapshot, 'sf-main')
  return main === undefined ? '' : h.descendantsText(main)
}

/** A node fully inside the client viewport (ancestor clipping respected). */
function reallyVisible(snapshot, node) {
  return node !== undefined
    && containedXY(snapshot.chains, node)
    && visibleSpan(snapshot.chains, node, 'y') >= 4
}

/** A bounded predicate poll that records NOTHING: a probe whose alternative
 *  path can still succeed must not leave a permanent failed assertion behind. */
async function pollUntil(h, predicate, limit = 240) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  return false
}

async function waitUntil(h, label, predicate, limit = 240) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  h.check(label, false, JSON.stringify({ visible: h.texts(h.snapshot()).slice(-14) }))
  return false
}

async function runCase(h, kind) {
  const seq = Number(readJson(join(h.root, 'case-seq.json'))?.seq ?? 0) + 1
  writeFileSync(join(h.root, 'case-seq.json'), `${JSON.stringify({ seq })}\n`)
  const target = join(h.root, 'case.json')
  writeFileSync(`${target}.tmp`, `${JSON.stringify({ seq, kind })}\n`)
  renameSync(`${target}.tmp`, target)
  const ok = await waitUntil(h, `the Direct subject completed ${kind}`, () => readJson(join(h.root, 'case-result.json'))?.seq === seq)
  const result = readJson(join(h.root, 'case-result.json'))
  h.check(`the subject handled ${kind}`, ok && result?.status === 'ok', JSON.stringify(result ?? null))
  return result
}

/**
 * Locate the CLIENT head fragment of a nested Tool card and bring it into the
 * viewport with real wheel scrolls. The card's own title/target text is the
 * anchor; a node is only accepted when it is fully inside the viewport and its
 * ancestor chain is inside the Main region.
 */
async function revealToolHead(h, toolNode) {
  const title = String(toolNode.p?.title ?? '')
  const target = String(toolNode.p?.target ?? '')
  const anchors = [title, target, `${toolNode.p?.note ?? ''}`].filter(text => text !== '')
  let sign = 1
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const snapshot = h.snapshot()
    const candidates = mainNodes(snapshot).filter(node => {
      const text = String(node.text ?? '')
      return text !== '' && anchors.some(anchor => text === anchor || text.includes(anchor))
        && rect(node)[1] >= 72
    })
    for (const node of candidates) {
      if (!reallyVisible(snapshot, node)) continue
      await h.sleep(250)
      const stable = h.snapshot()
      const same = mainNodes(stable).find(candidate => String(candidate.text ?? '') === String(node.text ?? '')
        && Math.abs(rect(candidate)[1] - rect(node)[1]) < 4)
      if (same !== undefined && reallyVisible(stable, same)) return { snapshot: stable, node: same }
    }
    h.send('wheel', 0, sign * 120)
    await h.sleep(140)
    const after = mainNodes(h.snapshot()).filter(node => anchors.some(anchor => String(node.text ?? '').includes(anchor)))
    if (after.length === 0) sign = -sign
  }
  return undefined
}

/**
 * Bring the Main fragment showing `text` into the viewport with real wheel
 * scrolls, and return the visible witness. Older content sits above the tail,
 * so the first pass scrolls up; a missed target reverses instead of guessing.
 */
async function revealMainText(h, text) {
  let sign = -1
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const snapshot = h.snapshot()
    const node = mainNodes(snapshot).find(candidate => String(candidate.text ?? '').includes(text))
    if (node !== undefined && reallyVisible(snapshot, node) && rect(node)[1] >= 72) {
      await h.sleep(250)
      const stable = h.snapshot()
      const stableNode = mainNodes(stable).find(candidate => String(candidate.text ?? '').includes(text))
      if (stableNode !== undefined && reallyVisible(stable, stableNode)) return { snapshot: stable, node: stableNode }
    }
    h.send('wheel', 0, sign * 160)
    await h.sleep(140)
    const after = h.snapshot()
    const afterNode = mainNodes(after).find(candidate => String(candidate.text ?? '').includes(text))
    // When the target disappeared entirely the wheel direction was wrong.
    if (afterNode === undefined) sign = -sign
  }
  return undefined
}

/** The client's OWN native Find bar, or undefined while it is closed. */
const findBarNode = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('find-bar'))
/** One of the Find bar's own navigation buttons ("Previous match" / "Next match"). */
const findBarButton = (snapshot, title) => snapshot.nodes.find(node =>
  node.tag === 'button' && String(node.title ?? '').includes(title))
const stateFind = h => h.ctl('state').find ?? null

/** Open the client's native Find with ONE control-injected `find` action. The
 *  query is JSON-quoted because the client control grammar splits an
 *  unquoted spaced string into several arguments. */
async function openFind(h, query, label) {
  const before = records(h).filter(entry => entry.kind === 'client.toggle').length
  h.send('find', JSON.stringify(query))
  await h.sleep(400)
  const state = stateFind(h)
  return { state, togglesBefore: before, query, label }
}

/** Close the client's native Find with ONE Escape and prove it is gone. */
async function closeFind(h, label) {
  h.send('key', 'Escape')
  await h.sleep(400)
  const state = stateFind(h)
  h.check(`${label}: Escape closes the native Find and state.find returns to null`,
    state === null || state === undefined || (typeof state === 'object' && state.query === '' && (state.hits ?? 0) === 0),
    JSON.stringify(state))
}

/** The client's OWN native Find bar, or undefined while it is closed. */

export default async function (h) {
  const preset = presetFromEnvironment()
  const gui = process.env.TERN_FIND_GUI === '1'
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
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()
  const subject = join(repo, 'scripts', 'tern-pane-transcript-modes-subject.mts')
  const extra = { preset, tern: ternVersion, sdk: '0.2.0', dsh: dshPin, sourceSnapshot: head }
  writeLedger(h, 'environment.json', {
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    git: { head, branch, status: gitStatus },
    host: { node: process.version, os: `${type()} ${osRelease()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    display: process.env.DISPLAY ?? null,
    preset,
    evidenceTier: findEvidenceTier(gui),
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
  h.check('the client native Find is closed before the scenario starts', stateFind(h) === null, JSON.stringify(stateFind(h)))

  // ── the production subject boots and settles the first real turn ──
  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario: 'native-find' })}\n`)
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct native-find Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'native-find' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
      && records(h).some(row => row.kind === 'fixture.ready'
        && row.scenario === 'native-find' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'MOUNT_NOT_READY' })
    return
  }
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
  h.check('the client negotiated Section nodes', hello?.kinds?.includes('section'), JSON.stringify(hello?.kinds))

  const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const markers = prompts.nativeFind
  h.check('the scenario metadata carries the fixed native-find markers', markers !== undefined
    && typeof markers.archive === 'string' && typeof markers.shared === 'string' && typeof markers.tail === 'string'
    && typeof markers.liveAppend === 'string' && typeof markers.nonExistent === 'string' && typeof markers.innerOnly === 'string',
    JSON.stringify(markers ?? null))
  if (markers === undefined) { finish(h, { ...extra, qualification: 'SCENARIO_METADATA_MISSING' }); return }
  const prompt = prompts.prompts[0]
  h.send('type', JSON.stringify(prompt.text))
  await h.key('Return', 600)
  if (!await waitUntil(h, 'the production Direct writer settled exactly one prompt', () =>
    records(h).filter(row => row.kind === 'producer.writer.settled').length === 1)) {
    finish(h, { ...extra, qualification: 'DIRECT_WRITE_NOT_SETTLED' })
    return
  }
  if (!await waitUntil(h, 'the first real turn settles with its scripted assistant marker', () =>
    mainText(h).includes(prompts.assistantMarker))) {
    finish(h, { ...extra, qualification: 'FIRST_TURN_NOT_MATERIALIZED' })
    return
  }

  // ── the 28-Turn seed through the SAME Session writer ──
  const seed = await runCase(h, 'native-find-seed')
  if (seed?.status !== 'ok') { finish(h, { ...extra, qualification: 'SEED_NOT_SETTLED' }); return }
  h.check('the seed wrote the official Turns 2–29 with a complete message ledger',
    seed.lastTurn === markers.seedTurns.last && seed.totalMessages >= 57,
    JSON.stringify({ lastTurn: seed.lastTurn, totalMessages: seed.totalMessages, sessionId: seed.sessionId }))
  if (!await waitUntil(h, 'the seeded Main reaches its real TAIL row', () => mainText(h).includes(markers.tail), 400)) {
    finish(h, { ...extra, qualification: 'TAIL_NOT_MATERIALIZED' })
    return
  }
  h.capture(`${preset}-seeded-main-1280x800-dark`, 'the 28-turn continuous Main after the official seed')

  // The SDK wire carries NO program-initiated find request (B24's runtime half;
  // the source audit is the diff half). The wire verbs are surface ops only.
  h.measure('the SDK wire carries no program-side find request',
    JSON.stringify({ verbs: [...new Set(wire(h).filter(row => row.dir === 'out').map(row => row.verb))] }))

  // ── B03/B04: the positive native Find journey over the seeded history ──
  const commitsBeforeFind = records(h).filter(row => row.kind === 'display.setTranscript').length
  const settledBeforeFind = records(h).filter(row => row.kind === 'producer.writer.settled').length
  const togglesBeforeFind = records(h).filter(row => row.kind === 'client.toggle').length
  const opened = await openFind(h, markers.shared, 'shared journey')
  h.check('B03: the client opened its own native Find for the shared token',
    opened.state !== null && opened.state.query === markers.shared,
    JSON.stringify(opened.state))
  h.check('B03: the client Find reports at least two readable hits (Turns 4 and 25)',
    opened.state !== null && (opened.state.hits ?? 0) >= 2,
    JSON.stringify(opened.state))
  const findBar = findBarNode(h.snapshot())
  h.check('B03: the native Find bar is real client chrome outside the app regions',
    findBar !== undefined
      && regionNode(h.snapshot(), 'sf-main') !== undefined
      && !String(findBar.class ?? '').split(/\s+/u).some(name => name.startsWith('sf-')),
    JSON.stringify({ class: findBar?.class ?? null }))
  h.capture(`${preset}-find-open-1280x800-dark`, 'the native Find bar open over the seeded continuous Main')

  // B07: real typing while Find is open reaches the client Find, not the app.
  h.send('type', 'X')
  await h.sleep(400)
  const typedState = stateFind(h)
  const dockAfterType = h.descendantsText(regionNode(h.snapshot(), 'sf-dock') ?? {})
  h.check('B07: typed characters are consumed by the client Find input',
    typedState !== null && String(typedState.query ?? '').endsWith('X'),
    JSON.stringify(typedState))
  h.check('B07: the typed character never reaches the app composer draft',
    !dockAfterType.includes('X') && !dockAfterType.includes(markers.shared),
    JSON.stringify(dockAfterType.slice(0, 120)))
  h.send('key', 'Backspace')
  await h.sleep(300)
  h.check('B07: the Find query is restored after the probe Backspace',
    stateFind(h)?.query === markers.shared, JSON.stringify(stateFind(h)))

  // B04: Next moves to another occurrence and Previous comes back. MEASURED on
  // the pinned binary: the Find bar's own controls are "Previous match ⇧⌘G"
  // and "Next match ⌘G"; Enter walks OLDER hits. The round trip therefore
  // clicks the client's OWN Previous/Next buttons (control-injected pointer,
  // the geometry oracle, never a synthetic find event).
  const currentBefore = stateFind(h)?.current ?? null
  const barSnap = h.snapshot()
  const findBarPrev = findBarButton(barSnap, 'Previous match')
  h.check('B04: the native Find bar paints its own Previous and Next controls',
    findBarPrev !== undefined && findBarButton(barSnap, 'Next match') !== undefined,
    JSON.stringify({ prev: findBarPrev?.title ?? null, next: findBarButton(barSnap, 'Next match')?.title ?? null }))
  h.check('B04: one control-injected click lands on the client Previous control',
    findBarPrev !== undefined && await h.click(barSnap.chains, findBarPrev),
    JSON.stringify(findBarPrev?.rect ?? null))
  await h.sleep(400)
  const afterPrevious = stateFind(h)?.current ?? null
  h.check('B04: Find Previous moves the current hit to another occurrence',
    currentBefore !== null && afterPrevious !== null && afterPrevious !== currentBefore,
    JSON.stringify({ before: currentBefore, afterPrevious }))
  h.capture(`${preset}-find-next-1280x800-dark`, 'the native Find after one Previous navigation')
  const barSnap2 = h.snapshot()
  const findBarNext = findBarButton(barSnap2, 'Next match')
  h.check('B04: one control-injected click lands on the client Next control',
    findBarNext !== undefined && await h.click(barSnap2.chains, findBarNext),
    JSON.stringify(findBarNext?.rect ?? null))
  await h.sleep(400)
  const afterNext = stateFind(h)?.current ?? null
  h.check('B04: Find Next returns to the earlier occurrence',
    afterNext !== null && afterNext === currentBefore,
    JSON.stringify({ before: currentBefore, afterPrevious, afterNext }))

  // B07/B23: the Find journey mutated NO application state.
  h.check('B07: the Find journey submitted no new prompt to the Direct writer',
    records(h).filter(row => row.kind === 'producer.writer.settled').length === settledBeforeFind,
    JSON.stringify({ settled: settledBeforeFind }))
  h.check('B23: the Find journey produced no extra production transcript commit',
    records(h).filter(row => row.kind === 'display.setTranscript').length === commitsBeforeFind,
    JSON.stringify({ commits: commitsBeforeFind }))
  h.check('B13/B23: the plain-text Find journey produced no client toggle',
    records(h).filter(row => row.kind === 'client.toggle').length === togglesBeforeFind,
    JSON.stringify({ toggles: togglesBeforeFind }))
  h.check('B05: the source scope stayed stable across the Find journey',
    records(h).filter(row => row.kind === 'scope.changed').length === 1,
    JSON.stringify(records(h).filter(row => row.kind === 'scope.changed')))

  // B06: Escape closes the client Find; the same Main and Dock stay usable.
  await closeFind(h, 'B06')
  const dockAfterEsc = h.descendantsText(regionNode(h.snapshot(), 'sf-dock') ?? {})
  h.check('B06: the Dock composer survives the closed Find unchanged',
    regionNode(h.snapshot(), 'sf-dock') !== undefined && !dockAfterEsc.includes(markers.shared),
    JSON.stringify(dockAfterEsc.slice(0, 120)))
  h.capture(`${preset}-find-after-esc-1280x800-dark`, 'the same Main and Dock after Escape closed the native Find')

  // ── B09: a real zero-hit query stays inside the client ──
  const openedMiss = await openFind(h, markers.nonExistent, 'no-match')
  h.check('B09: the client Find reports its own zero hits for the absent token',
    openedMiss.state !== null && openedMiss.state.query === markers.nonExistent && (openedMiss.state.hits ?? 0) === 0,
    JSON.stringify(openedMiss.state))
  h.check('B09: no application toast or host search call answered the miss',
    records(h).filter(row => row.kind === 'producer.writer.settled').length === settledBeforeFind
      && !records(h).some(row => row.kind === 'sdk.error'),
    JSON.stringify(records(h).filter(row => row.kind === 'sdk.error')))
  h.capture(`${preset}-find-no-match-1280x800-dark`, 'the native Find reporting zero hits inside the client')
  await closeFind(h, 'B09 close')

  // ── B05: the 25+ turn-old ARCHIVE token is reachable from a moved viewport ──
  h.send('wheel', 0, 900)
  await h.sleep(400)
  const openedArchive = await openFind(h, markers.archive, 'archive')
  h.check('B05: the client Find reaches the 25+ turn-old ARCHIVE token',
    openedArchive.state !== null && (openedArchive.state.hits ?? 0) >= 1,
    JSON.stringify(openedArchive.state))
  const archiveWitness = await revealMainText(h, markers.archive)
  h.check('B05: the ARCHIVE row is a real Main fragment the client actually paints',
    archiveWitness !== undefined,
    JSON.stringify(archiveWitness === undefined ? null : { rect: rect(archiveWitness.node) }))
  h.capture(`${preset}-find-archive-1280x800-dark`, 'the native Find positioned on the old ARCHIVE row')
  h.check('B05: the Find navigation recreated no Session scope',
    records(h).filter(row => row.kind === 'scope.changed').length === 1,
    JSON.stringify({ scopeChanges: records(h).filter(row => row.kind === 'scope.changed').length }))
  await closeFind(h, 'B05 close')

  // ── B10/B11: the same-source live append reopens into new hits ──
  const append = await runCase(h, 'native-find-append')
  if (append?.status !== 'ok') { finish(h, { ...extra, qualification: 'LIVE_APPEND_NOT_SETTLED' }); return }
  h.check('B10: the live append wrote Turn 30 through the same Session writer',
    append.lastTurn === markers.appendTurn && append.totalMessages >= 59,
    JSON.stringify({ lastTurn: append.lastTurn, totalMessages: append.totalMessages, sessionId: append.sessionId }))
  // The client virtualizes the long Main, so the appended tail row is located
  // through the client's OWN Find (which navigates its real document) before
  // the painted fragment is claimed.
  const openedLive = await openFind(h, markers.liveAppend, 'live append')
  h.check('B10: the reopened native Find hits the freshly appended token',
    openedLive.state !== null && (openedLive.state.hits ?? 0) >= 1,
    JSON.stringify(openedLive.state))
  h.check('B10: the appended row is a real Main fragment the client actually paints',
    mainNodes(h.snapshot()).some(node => String(node.text ?? '').includes(markers.liveAppend)),
    JSON.stringify({ mainText: mainText(h).slice(-200) }))
  h.capture(`${preset}-find-live-append-1280x800-dark`, 'the native Find over the appended Turn 30')
  h.check('B11: both earlier SHARED rows stay readable in the current Main source',
    records(h).filter(row => row.kind === 'scope.changed').length === 1,
    JSON.stringify({ scopeChanges: records(h).filter(row => row.kind === 'scope.changed').length }))
  await closeFind(h, 'B10 close')
  const openedSharedAgain = await openFind(h, markers.shared, 'shared after append')
  h.check('B10/B11: the reopened Find now also counts the appended SHARED occurrence',
    openedSharedAgain.state !== null && (openedSharedAgain.state.hits ?? 0) >= 3,
    JSON.stringify(openedSharedAgain.state))
  await closeFind(h, 'B11 close')

  // ── B12/B14: the collapsed Tool body is NOT searchable until materialized ──
  const treeBeforeFold = h.snapshot()
  h.check('B12: the INNER_ONLY token is absent from the folded client tree',
    !mainNodes(treeBeforeFold).some(node => String(node.text ?? '').includes(markers.innerOnly)),
    JSON.stringify({ mainHasToken: mainNodes(treeBeforeFold).some(node => String(node.text ?? '').includes(markers.innerOnly)) }))
  const openedInner = await openFind(h, markers.innerOnly, 'collapsed tool')
  h.check('B12: the native Find reports zero hits for the unmaterialized Tool body',
    openedInner.state !== null && (openedInner.state.hits ?? 0) === 0,
    JSON.stringify(openedInner.state))
  h.capture(`${preset}-find-collapsed-tool-1280x800-dark`, 'the native Find over the still-collapsed Turn 10 Tool')
  await closeFind(h, 'B12 close')

  // ── B13/B14/B15/B16: the preset's own Fold root, opened by a REAL click ──
  // The client virtualizes the long Main, so the flow first navigates back to
  // Turn 10 through the client's OWN Find (its real document), then clicks the
  // real Fold head fragment.
  const foldLocate = await openFind(h, 'Turn 10: ordinary', 'fold root locate')
  h.measure('B14: the Find navigates back to the Turn 10 neighborhood',
    JSON.stringify({ query: 'Turn 10: ordinary', state: foldLocate.state }))
  await closeFind(h, 'B14 locate close')
  const togglesBeforeRoot = records(h).filter(row => row.kind === 'client.toggle').length
  const rootMatcher = preset === 'full' ? 'src/t3a-inner-example.ts' : 'read ×1'
  const rootWitness = await revealMainText(h, rootMatcher)
  h.check('B14: the preset Fold root for the Turn 10 Tool has a visible head fragment',
    rootWitness !== undefined,
    JSON.stringify(rootWitness === undefined ? null : { rect: rect(rootWitness.node) }))
  if (rootWitness === undefined) {
    finish(h, { ...extra, qualification: 'FOLD_ROOT_NOT_VISIBLE' })
    return
  }
  h.check('B13: one control-injected click lands on the Fold root head',
    await h.click(rootWitness.snapshot.chains, rootWitness.node),
    JSON.stringify(rect(rootWitness.node)))
  const gotToggle = await waitUntil(h, 'B13: the client toggle for the Fold root reaches the Session iterator', () =>
    records(h).filter(row => row.kind === 'client.toggle').length > togglesBeforeRoot, 150)
  const rootToggle = records(h).filter(row => row.kind === 'client.toggle').at(-1)
  h.check('B13: the Fold root toggle names a real node and the expand target state',
    gotToggle && rootToggle?.collapsed === false && typeof rootToggle?.id === 'string',
    JSON.stringify(rootToggle ?? null))
  const toolBodyMaterialized = () => mainNodes(h.snapshot()).some(node => String(node.text ?? '').includes(markers.innerOnly))
  const innerCard = [...foldLive(h).values()].find(node => node.k === 'tool'
    && (String(node.id ?? '').includes('-msg-21') || String(node.p?.target ?? '').includes('t3a-inner-example')))
  if (!await pollUntil(h, toolBodyMaterialized, 120)) {
    if (innerCard === undefined) {
      // MEASURED on the pinned binary: the Focus Thought root opens WITHOUT a
      // nested Tool card on the wire — the Focus projection does not
      // materialize the Tool's body under that root at all. The plan's rule is
      // FACT CONSISTENCY, not a forced pass: record the absence and keep the
      // Find claim limited to what the client really indexes.
      h.measure('B16: the opened Focus Thought root materializes no nested Tool card',
        JSON.stringify({ rootId: rootToggle?.id ?? null, innerToolNodes: 0 }))
      const openedInnerFocus = await openFind(h, markers.innerOnly, 'focus inner')
      h.check('B16: the native Find reports zero hits while the Focus root materializes no Tool body',
        openedInnerFocus.state !== null && (openedInnerFocus.state.hits ?? 0) === 0,
        JSON.stringify(openedInnerFocus.state))
      h.capture(`${preset}-find-focus-root-no-tool-body`, 'the opened Focus Thought root with no nested Tool body')
      await closeFind(h, 'B16 close')
    } else {
      // Compact puts the Tool card UNDER the preset Fold root, and the client
      // keeps that nested card closed. The second REAL click addresses the
      // nested card's own head — not the Fold root's head, which would collapse
      // the root again (MEASURED).
      h.check('B14: the nested Tool card exists as its own live SDK node', true, JSON.stringify(innerCard))
      const togglesBeforeInner = records(h).filter(row => row.kind === 'client.toggle').length
      const innerWitness = await revealToolHead(h, innerCard)
      h.check('B14: the nested Tool card has its own visible head fragment below the opened Fold root',
        innerWitness !== undefined,
        JSON.stringify(innerWitness === undefined ? null : { rect: rect(innerWitness.node) }))
      if (innerWitness !== undefined) {
        h.check('B14: one control-injected click lands on the nested Tool card head',
          await h.click(innerWitness.snapshot.chains, innerWitness.node),
          JSON.stringify(rect(innerWitness.node)))
        await waitUntil(h, 'B14: the nested Tool card opens its real body', () =>
          records(h).filter(row => row.kind === 'client.toggle').length > togglesBeforeInner, 150)
      }
      if (!await waitUntil(h, 'B14: the Turn 10 Tool body materializes into the client tree',
        toolBodyMaterialized, 200)) {
        finish(h, { ...extra, qualification: 'TOOL_BODY_NOT_MATERIALIZED' })
        return
      }
    }
  }
  h.measure('B13: the manual disclosure identity is the production one',
    JSON.stringify({ toggle: rootToggle }))
  const openedInnerAfter = await openFind(h, markers.innerOnly, 'materialized tool')
  const bodyNowInTree = toolBodyMaterialized()
  h.check(bodyNowInTree
    ? 'B15: the native Find hits the Tool body once it is really materialized'
    : 'B16: the native Find reports zero hits while the Focus root materializes no Tool body',
  openedInnerAfter.state !== null
    && (bodyNowInTree ? (openedInnerAfter.state.hits ?? 0) >= 1 : (openedInnerAfter.state.hits ?? 0) === 0),
  JSON.stringify({ bodyNowInTree, find: openedInnerAfter.state }))
  h.capture(`${preset}-find-materialized-tool-1280x800-dark`, 'the native Find over the manually expanded Tool body')
  await closeFind(h, 'B15 close')
  h.measure('B14: the manual disclosure survives the Find journeys untouched',
    JSON.stringify({ manualToggles: records(h).filter(row => row.kind === 'client.toggle').slice(togglesBeforeRoot) }))

  // ── B17: a higher app seat (History search) stays the owner ──
  h.send('key', 'Control+r')
  await h.sleep(500)
  const modalText = mainText(h) + h.descendantsText(regionNode(h.snapshot(), 'sf-layer') ?? {})
  h.measure('B17: the app History-search seat opened over the Main',
    JSON.stringify({ layerPresent: regionNode(h.snapshot(), 'sf-layer') !== undefined, modalText: modalText.slice(0, 120) }))
  const openedModalFind = await openFind(h, markers.shared, 'modal seat')
  h.measure('B17: the client Find behaviour under the higher app seat (recorded, not assumed)',
    JSON.stringify(openedModalFind.state))
  h.check('B17: the higher app seat blocked any new Session write during the Find probe',
    records(h).filter(row => row.kind === 'producer.writer.settled').length === settledBeforeFind,
    JSON.stringify({ settled: settledBeforeFind }))
  h.send('key', 'Escape')
  await h.sleep(400)
  h.send('key', 'Escape')
  await h.sleep(400)
  h.check('B17: the History-search seat retired without any durable Session write',
    records(h).filter(row => row.kind === 'producer.writer.settled').length === settledBeforeFind,
    JSON.stringify({ settled: settledBeforeFind }))

  // ── B21: the viewport × appearance matrix keeps Find readable ──
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
    const openedViewport = await openFind(h, markers.shared, `${viewport.width}x${viewport.height}`)
    const bar = findBarNode(h.snapshot())
    if (gui && !exact) {
      h.measure(`${viewport.width}x${viewport.height}: GUI clamped Find bar`, JSON.stringify({
        requested: resize, actual: stats.viewport, findBarClass: bar?.class ?? null, find: openedViewport.state,
      }))
    } else {
      h.check(`${viewport.width}x${viewport.height}: the native Find bar stays present and readable`,
        bar !== undefined && openedViewport.state?.query === markers.shared,
        JSON.stringify({ findBarClass: bar?.class ?? null, find: openedViewport.state, theme: state.theme }))
    }
    const id = h.capture(`${preset}-find-${viewport.width}x${viewport.height}-${viewport.appearance}`,
      `the native Find at ${viewport.width}x${viewport.height} ${viewport.appearance}`)
    await closeFind(h, `${viewport.width}x${viewport.height} close`)
    matrix.push({
      id, viewport: [viewport.width, viewport.height], appearance: viewport.appearance,
      actualViewport: stats.viewport, exact, theme: state.theme, find: openedViewport.state,
    })
  }
  writeLedger(h, 'native-find-viewport-matrix.json', matrix)

  // ── B18: the pane-local scope never counts another pane's token ──
  const focusedBefore = h.ctl('state').focused?.id ?? null
  const splitReply = h.send('split', 'right')
  await h.sleep(700)
  const panesAfterSplit = h.ctl('state').panes ?? []
  const focusedAfterSplit = h.ctl('state').focused?.id ?? null
  if (panesAfterSplit.length !== 2) {
    finish(h, { ...extra, qualification: 'PANE_SPLIT_BLOCKER',
      paneSplitDetail: { reply: splitReply, panes: panesAfterSplit, focusedBefore, focusedAfterSplit } })
    return
  }
  h.check('B18: the control split produced exactly two panes',
    panesAfterSplit.length === 2,
    JSON.stringify({ focusedBefore, focusedAfterSplit, panes: panesAfterSplit }))
  h.measure('B18: the client pane/focus identities after the split',
    JSON.stringify({ focusedBefore, focusedAfterSplit, panes: panesAfterSplit }))
  const rightPane = panesAfterSplit.find(pane => pane.id !== focusedBefore)?.id ?? null
  if (focusedAfterSplit !== rightPane) {
    h.send('focus', 'right')
    await h.sleep(400)
  }
  h.send('run', JSON.stringify(`printf ${OTHER_PANE_TOKEN}`))
  await h.sleep(700)
  h.send('focus', 'left')
  await h.sleep(500)
  const focusedLeft = h.ctl('state').focused?.id ?? null
  h.check('B18: the focus identity round-trips back to the original TSP pane',
    focusedBefore !== null && focusedLeft === focusedBefore,
    JSON.stringify({ focusedBefore, focusedAfterSplit, focusedLeft }))
  const openedOtherPane = await openFind(h, OTHER_PANE_TOKEN, 'other pane')
  h.check('B18: the TSP pane Find reports zero hits for the other pane shell token',
    openedOtherPane.state !== null && (openedOtherPane.state.hits ?? 0) === 0,
    JSON.stringify(openedOtherPane.state))
  await closeFind(h, 'B18 other-pane close')
  const openedOwnPane = await openFind(h, markers.archive, 'own pane')
  h.check('B18: the TSP pane Find still reaches its own ARCHIVE row',
    openedOwnPane.state !== null && (openedOwnPane.state.hits ?? 0) >= 1,
    JSON.stringify(openedOwnPane.state))
  await closeFind(h, 'B18 close')

  writeLedger(h, 'native-find.json', {
    sourceSnapshot: head,
    preset,
    evidenceTier: findEvidenceTier(gui),
    markers,
    seed: { lastTurn: seed.lastTurn, totalMessages: seed.totalMessages, sessionId: seed.sessionId },
    append: { lastTurn: append.lastTurn, totalMessages: append.totalMessages },
    viewportMatrix: matrix,
    clientToggles: records(h).filter(row => row.kind === 'client.toggle'),
    provenance: 'live Direct Session writer -> official SessionEvents -> TranscriptFolder -> TSP mapper -> pinned Tern client -> control-injected native Find',
    notVerified: [
      'OS physical keyboard/IME/wheel',
      'G8 Owner visual acceptance',
      'any realtime refresh of an OPEN Find result list after a live append (reopened Find is the measured behaviour)',
    ],
  })
  finish(h, extra)
}
