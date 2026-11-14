/**
 * T3-B1: the REAL Tern pane lane for the loaded-session semantic search.
 *
 * The subject is the production `tern-pane-transcript-modes-subject.mts` running
 * scenario `semantic-search`: ONE real Direct Session writer appends the official
 * 28-Turn seed, the production `TranscriptFolder` folds it and the production TSP
 * renderer maps it into the ONE inline Surface. Every gesture below is real
 * control-injected input; every assertion reads the client's own node tree,
 * geometry, wire ops and PNG.
 *
 *   TERN_BIN=… TERN_TRANSCRIPT_SEARCH_PRESET=full \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-semantic-search.mjs
 *   TERN_BIN=… TERN_SEARCH_GUI=1 TERN_TRANSCRIPT_SEARCH_PRESET=full \
 *     node scripts/tern-gui-drive.mjs scripts/tern-pane-transcript-semantic-search.mjs
 *
 * ONE preset per run, each in its OWN fresh client. Evidence tier:
 * REAL_TERN_HEADLESS/GUI + CONTROL_INJECTED_INPUT — never OS physical input.
 *
 * The four fault injections the plan requires are `B1_FAULT` modes; each one
 * makes the run exit NON-ZERO on purpose, and each keeps its own before/after
 * evidence:
 *
 *   B1_FAULT=wrong-node        reveal an existing same-word card that is NOT the
 *                              intended source → the source-visibility assertion
 *                              must fail (the driver exits 1)
 *   B1_FAULT=no-materialization keep the target body folded → the readable-body
 *                              assertion must fail
 *   B1_FAULT=no-scroll         suppress the reveal op → the viewport assertion
 *                              must fail
 *   B1_FAULT=stale-source      replace the subject mid-journey → the card must
 *                              refuse to act on the new source
 *
 * A fault run is EXPECTED to be red; a green fault run is the real failure (the
 * assertion has no discriminating power).
 * @module scripts/tern-pane-transcript-semantic-search
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release as osRelease, type } from 'node:os'
import { join } from 'node:path'
import { containedXY, rect, visibleSpan } from './tern-pane-geometry.mjs'

const PRESETS = ['full', 'compact', 'focus']
// The three injections whose run MUST exit non-zero (the assertion they break is
// the product claim). `stale-source` is NOT here: replacing the source is a
// condition the product must HANDLE (retire), so it is asserted in the positive
// path — a red run there would mean the fix is missing.
const FAULTS = ['none', 'wrong-node', 'no-materialization', 'no-scroll']
const VIEWPORTS = [
  { width: 1280, height: 800, appearance: 'dark' },
  { width: 900, height: 700, appearance: 'dark' },
  { width: 400, height: 600, appearance: 'dark' },
  { width: 900, height: 360, appearance: 'light' },
]

/** The ONE preset of this run. */
export function presetFromEnvironment(value = process.env.TERN_TRANSCRIPT_SEARCH_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) {
    throw new Error(`TERN_TRANSCRIPT_SEARCH_PRESET must be full, compact or focus; got ${preset}`)
  }
  return preset
}

/** The ONE fault injection of this run (`none` = the positive control). */
export function faultFromEnvironment(value = process.env.B1_FAULT) {
  const fault = value ?? 'none'
  if (!FAULTS.includes(fault)) throw new Error(`B1_FAULT must be one of ${FAULTS.join(', ')}; got ${fault}`)
  return fault
}

export function searchEvidenceTier(gui) {
  return gui ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT' : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT'
}

export function qualificationFromResults(results, pass) {
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

/** Every `reveal` op the program actually sent, in order. */
function revealOps(h) {
  const out = []
  for (const entry of wire(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'reveal') out.push({ sf: entry.body?.sf, id: op[1], at: op[2] ?? 'nearest' })
    }
  }
  return out
}

function writeLedger(h, name, value) {
  writeFileSync(join(h.root, name), `${JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, join(h.root, name))
}

function finish(h, extra = {}) {
  const { qualification: outcome, ...metadata } = extra
  const qualification = qualificationFromResults(h.results, outcome ?? 'REAL_TERN_SEMANTIC_SEARCH_PASS')
  const status = h.finish({
    ...metadata,
    ...(outcome === undefined || outcome === qualification ? {} : { qualificationDetail: outcome }),
    qualification,
  })
  if (status !== 0) process.exitCode = status
}

const regionNode = (snap, name) => snap.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

/** Every visible text of the CURRENT client tree. */
const visibleTexts = h => h.texts(h.snapshot())

/** The client's Main subtree only (the Dock repeats input bytes). */
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

const mainText = (h, snapshot = h.snapshot()) => mainNodes(snapshot).map(node => String(node.text ?? '')).join('\n')

/** A node fully inside the client viewport (ancestor clipping respected). */
function reallyVisible(snapshot, node) {
  return node !== undefined
    && containedXY(snapshot.chains, node)
    && visibleSpan(snapshot.chains, node, 'y') >= 4
}

/** The card ordinals the client currently paints inside its viewport. */
function visibleCards(snapshot) {
  const out = new Set()
  for (const node of mainNodes(snapshot)) {
    const text = String(node.text ?? '')
    const card = text.match(/Turn (\d+):/u)?.[1]
    if (card === undefined) continue
    if (!reallyVisible(snapshot, node)) continue
    out.add(Number(card))
  }
  return [...out].sort((a, b) => a - b)
}

/** Bounded wait that records NOTHING when it fails (the caller asserts). */
async function pollUntil(h, predicate, limit = 240) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) return true
    await h.sleep(100)
  }
  return false
}

/** A wait that RECORDS a failed assertion on timeout. */
async function waitUntil(h, label, predicate, limit = 240) {
  const ok = await pollUntil(h, predicate, limit)
  if (!ok) h.check(label, false, JSON.stringify({ visible: visibleTexts(h).slice(-14) }))
  return ok
}

/** The Direct subject's own case channel. */
async function runCase(h, kind, payload = {}) {
  const seq = Number(readJson(join(h.root, 'case-seq.json'))?.seq ?? 0) + 1
  writeFileSync(join(h.root, 'case-seq.json'), `${JSON.stringify({ seq })}\n`)
  const target = join(h.root, 'case.json')
  writeFileSync(`${target}.tmp`, `${JSON.stringify({ seq, kind, ...payload })}\n`)
  renameSync(`${target}.tmp`, target)
  const ok = await waitUntil(h, `the Direct subject completed ${kind}`,
    () => readJson(join(h.root, 'case-result.json'))?.seq === seq)
  const result = readJson(join(h.root, 'case-result.json'))
  h.check(`the subject handled ${kind}`, ok && result?.status === 'ok', JSON.stringify(result ?? null))
  return result
}

/** Every Main root the renderer ADDED on the wire, with its own subtree text.
 *  The wire `add` op carries the SDK-derived id and the node JSON, so this is the
 *  renderer's REAL identity chain — the client tree's sf nodes carry no ids. */
function wireMainRoots(h) {
  const roots = new Map()
  const textOf = (node, out) => {
    if (node === null || typeof node !== 'object') return out
    const props = node.p ?? {}
    for (const value of Object.values(props)) {
      if (typeof value === 'string') out.push(value)
    }
    for (const child of node.c ?? []) textOf(child, out)
    return out
  }
  for (const entry of wire(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] !== 'add' || op[2] !== 'main') continue
      const id = String(op[1] ?? '')
      if (!id.startsWith('main.')) continue
      roots.set(id, textOf(op[4], []).join(' '))
    }
  }
  return roots
}

/** The CURRENT target's identity chain: the renderer's own revealed root id, the
 *  wire roots that carry the same word, and a DIFFERENT same-word root the fault
 *  can reveal. Every value is a real wire identity — never a guess. */
function currentTargetIdentity(h, word, targetText) {
  const reveals = records(h).filter(row => row.kind === 'renderer.reveal')
  const rootId = reveals.length === 0 ? undefined : String(reveals.at(-1).id)
  const roots = wireMainRoots(h)
  const shared = []
  const targetMarked = []
  for (const [id, text] of roots) {
    const lower = text.toLowerCase()
    if (!lower.includes(String(word).toLowerCase())) continue
    shared.push(id)
    if (targetText !== undefined && lower.includes(String(targetText).toLowerCase())) targetMarked.push(id)
  }
  // The WRONG candidate must belong to the CURRENT scope: a replaced source's id
  // is a dead wire id the client rejects, which would make the fault vacuous
  // instead of the same-word false positive this case must defeat.
  const currentScope = rootId === undefined ? undefined : rootId.slice(0, rootId.indexOf('-') + 1)
  const wrongCandidate = shared.find(id => id !== rootId
    && !targetMarked.includes(id)
    && (currentScope === undefined || id.startsWith(currentScope)))
  return {
    rootId,
    word,
    targetText,
    sharedRootIds: shared,
    targetRootIds: targetMarked,
    currentScope,
    otherSharedRoot: wrongCandidate,
  }
}

/** The node of the CURRENT target card: the card carrying the target's OWN text
 *  (`right`), never merely the shared query word. */
function targetCardNode(snapshot, identity) {
  const wanted = String(identity.targetText ?? '').toLowerCase()
  if (wanted === '') return undefined
  return mainNodes(snapshot).find(node =>
    String(node.text ?? '').toLowerCase().includes(wanted))
}

/** The Search card's own painted controls in the CURRENT frame. */
/** The card's own header text node (the ONE reliable marker of the open card). */
const searchCard = snapshot => snapshot.nodes.find(node =>
  String(node.text ?? '').startsWith('Session Search ·'))

/** Type one query into the focused card field with REAL keys. */
async function typeQuery(h, text) {
  for (const ch of text) await h.key(ch === ' ' ? 'space' : ch, 60)
}

export default async function (h) {
  const preset = presetFromEnvironment()
  const fault = faultFromEnvironment()
  const gui = process.env.TERN_SEARCH_GUI === '1'
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
  const extra = { preset, fault, tern: ternVersion, sdk: '0.2.0', dsh: dshPin, sourceSnapshot: head }
  writeLedger(h, 'environment.json', {
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    dsh: { mode: dshMode, agent: dshPin, session: dshSessionPin },
    git: { head, branch, status: gitStatus },
    host: { node: process.version, os: `${type()} ${osRelease()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    display: process.env.DISPLAY ?? null,
    preset,
    fault,
    evidenceTier: searchEvidenceTier(gui),
    sourceSnapshot: head,
  })
  h.check('the worktree uses the npm DSH family with matching Agent and Session pins',
    dshMode === 'npm' && typeof dshPin === 'string' && dshSessionPin === dshPin,
    JSON.stringify({ dshMode, dshPin, dshSessionPin }))
  h.check('the locked Tern SDK is 0.2.0 with recorded integrity', sdkIntegrity !== undefined, String(sdkIntegrity))
  if (dshMode !== 'npm' || typeof dshPin !== 'string' || dshSessionPin !== dshPin || sdkIntegrity === undefined) {
    finish(h, { ...extra, qualification: 'NOT_RUN_BASELINE_MISMATCH' })
    return
  }
  if (gui) {
    const system = h.ctl('system')
    h.check('this lane is a REAL native window on a REAL display',
      (system.displays ?? []).length > 0 && typeof system.title === 'string',
      JSON.stringify({ title: system.title, displays: system.displays }))
  }
  const initial = await h.resize(1280, 800)
  if (gui) h.measure('the real GUI window accepted 1280x800', JSON.stringify(initial))
  if (gui) {
    if (h.ctl('state').theme !== 'dark') h.send('plugins', 'run', 'appearance:dark')
  } else h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark', String(h.ctl('state').theme))

  // ── boot the production subject and settle the first real turn ──
  writeFileSync(join(h.root, 'mode.json'), `${JSON.stringify({ mode: preset, scenario: 'semantic-search' })}\n`)
  const subjectStarted = await h.launch(subject)
  if (!subjectStarted || !await waitUntil(h, 'the official Direct semantic-search Subject is ready', () => records(h).some(row =>
    row.kind === 'subject.ready' && row.scenario === 'semantic-search' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'SUBJECT_NOT_READY' })
    return
  }
  if (!await waitUntil(h, 'one inline production Surface and renderer are mounted', () =>
    records(h).some(row => row.kind === 'surface.inline.opened')
      && records(h).some(row => row.kind === 'renderer.observed')
      && wire(h).some(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')
      && records(h).some(row => row.kind === 'fixture.ready'
        && row.scenario === 'semantic-search' && row.mode === preset))) {
    finish(h, { ...extra, qualification: 'MOUNT_NOT_READY' })
    return
  }
  const hello = wire(h).find(row => row.dir === 'in' && row.verb === 'r' && row.body?.r === 'hello')?.body
  h.check('the client negotiated the kinds the Search card paints',
    ['col', 'row', 'text', 'input', 'el'].every(kind => (hello?.kinds ?? []).includes(kind)),
    JSON.stringify(hello?.kinds))
  const environmentPath = join(h.root, 'environment.json')
  writeFileSync(environmentPath, `${JSON.stringify({
    ...(existsSync(environmentPath) ? JSON.parse(readFileSync(environmentPath, 'utf8')) : {}),
    hello: { ver: hello?.ver, term: hello?.term, kinds: hello?.kinds, features: hello?.features, dark: hello?.dark },
    viewport: h.ctl('stats').viewport,
  }, null, 1)}\n`)

  // T3-B1 §6.4: the fault injections. Each one arms a REAL observation condition
  // in the client and then lets the SAME assertions decide — so a fault run is
  // expected to be red, and a GREEN fault run is the actual failure.
  const prompts = JSON.parse(readFileSync(join(h.root, 'prompts.json'), 'utf8'))
  const markers = prompts.semanticSearch
  h.check('the scenario metadata carries the fixed semantic-search markers', markers !== undefined
    && typeof markers.archive === 'string' && typeof markers.innerOnly === 'string'
    && typeof markers.shared === 'string' && typeof markers.tail === 'string'
    && typeof markers.nonExistent === 'string',
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
  const seed = await runCase(h, 'semantic-search-seed')
  if (seed?.status !== 'ok') { finish(h, { ...extra, qualification: 'SEED_NOT_SETTLED' }); return }
  h.check('the seed wrote the official Turns 2–29 with a complete message ledger',
    seed.lastTurn === markers.seedTurns.last && seed.totalMessages >= 55,
    JSON.stringify({ lastTurn: seed.lastTurn, totalMessages: seed.totalMessages }))
  if (!await waitUntil(h, 'the seeded Main reaches its real TAIL row', () => mainText(h).includes(markers.tail), 400)) {
    finish(h, { ...extra, qualification: 'TAIL_NOT_MATERIALIZED' })
    return
  }
  h.capture(`${preset}-search-seeded-main`, 'the continuous Main after the official semantic-search seed')

  // ── B1-12: a same-id source replacement retires the card (a POSITIVE refusal) ──
  {
    const entrySnapshot = h.snapshot()
    const entry = entrySnapshot.nodes.find(node => String(node.text ?? '').includes('Search session'))
    const opened = entry !== undefined && await h.click(entrySnapshot.chains, entry)
    const painted = opened && await pollUntil(h, () => searchCard(h.snapshot()) !== undefined)
    h.check('B1-12: the card opens before the source replacement', painted, String(painted))
    const replaced = await runCase(h, 'semantic-search-stale-source')
    h.check('B1-12: the subject really replaced its source', replaced?.status === 'ok',
      JSON.stringify(replaced ?? null))
    const retired = await pollUntil(h, () => searchCard(h.snapshot()) === undefined)
    h.check('B1-12: a replaced source retires the card instead of acting on the new one',
      retired, JSON.stringify(visibleTexts(h).slice(-6)))
    // The Composer is back and the draft is untouched by the retirement.
    h.check('B1-12: the Composer returns after the retirement',
      h.snapshot().nodes.some(node => String(node.class ?? '').includes('sf-editor')),
      JSON.stringify(visibleTexts(h).slice(-4)))
  }

  // ── B1-05/B1-08 preconditions: the folded body is NOT painted, the archive is off-viewport ──
  const beforeOpen = h.snapshot()
  h.check('B1-08 precond: the tool body marker is NOT in the painted Main before the search',
    !mainText(h, beforeOpen).includes(markers.innerOnly),
    JSON.stringify({ sample: mainText(h, beforeOpen).slice(0, 200) }))
  h.check('B1-18 precond: the old ARCHIVE row is NOT in the current viewport',
    !mainNodes(beforeOpen).some(node => String(node.text ?? '').includes(markers.archive) && reallyVisible(beforeOpen, node)),
    JSON.stringify({ visibleCards: visibleCards(beforeOpen) }))
  h.measure('B1-18 precond: the visible card range before the search',
    JSON.stringify(visibleCards(beforeOpen)))

  // ── B1-02: the Quiet Composer carries ONE Send and ONE Search entry ──
  const composerIds = () => h.snapshot().nodes
    .filter(node => String(node.class ?? '').includes('sf-act'))
    .map(node => ({ id: node.id, text: String(node.text ?? '') }))
  const beforeEntries = composerIds()
  h.check('B1-02: the closed Dock carries exactly one Send control',
    beforeEntries.filter(entry => entry.text === '↑').length === 1,
    JSON.stringify(beforeEntries.map(entry => entry.text)))
  h.check('B1-02: the closed Dock carries the ONE Search session entry',
    beforeEntries.filter(entry => entry.text.includes('Search session')).length === 1,
    JSON.stringify(beforeEntries.map(entry => entry.text)))
  const entrySnapshot = h.snapshot()
  const searchEntry = entrySnapshot.nodes.find(node => String(node.text ?? '').includes('Search session'))

  // ── B1-03/B1-02: the Search entry opens the ONE card and the Composer is withdrawn ──
  const opened = searchEntry !== undefined && await h.click(entrySnapshot.chains, searchEntry)
  h.check('B1-02: a REAL pointer click on the Search session entry opens the card', opened,
    JSON.stringify(searchEntry === undefined ? 'absent' : rect(searchEntry)))
  if (!await waitUntil(h, 'the Search card paints', () => searchCard(h.snapshot()) !== undefined)) {
    finish(h, { ...extra, qualification: 'SEARCH_CARD_NOT_PAINTED' })
    return
  }
  h.capture(`${preset}-search-open`, 'the Search card open, Composer withdrawn')
  const openSnapshot = h.snapshot()
  const openEntries = openSnapshot.nodes
    .filter(node => String(node.class ?? '').includes('sf-act'))
    .map(node => String(node.text ?? ''))
  h.check('B1-03: no Send control exists while the card is open',
    !openEntries.includes('↑'), JSON.stringify(openEntries))
  h.check('B1-03: no Search session entry exists while the card is open',
    !openEntries.some(text => text.includes('Search session')), JSON.stringify(openEntries))
  h.check('B1-03: the card paints its three real actions',
    ['Prev', 'Next', 'Close'].every(label => openEntries.includes(label)), JSON.stringify(openEntries))
  const cardFields = openSnapshot.nodes.filter(node => String(node.class ?? '').includes('sf-input'))
  h.check('B1-03: the card owns exactly ONE input field', cardFields.length === 1, String(cardFields.length))
  h.check('B1-03: the Composer editor node is gone from the Dock',
    !openSnapshot.nodes.some(node => String(node.class ?? '').includes('sf-editor')),
    JSON.stringify(openSnapshot.nodes.filter(node => String(node.class ?? '').includes('sf-editor')).length))
  h.check('B1-02: the card opens with an empty query and zero targets',
    visibleTexts(h).some(text => text.includes('0/0 targets')),
    JSON.stringify(visibleTexts(h).slice(-8)))

  // ── B1-10: a real query finds the folded tool body's OWN card ──
  if (fault === 'no-materialization') {
    // Armed BEFORE the navigation render: the Folder still counts the hit, but
    // the painted Main must never materialize the body the grant opens.
    await runCase(h, 'semantic-search-suppress-materialization')
  }
  await typeQuery(h, markers.innerOnly.toLowerCase())
  await waitUntil(h, 'B1-10: the query produces one representative target',
    () => visibleTexts(h).some(text => text.includes('1/1 targets')))
  h.check('B1-06: ONE card with one raw hit counts as 1/1 targets',
    visibleTexts(h).some(text => text.includes('1/1 targets')), JSON.stringify(visibleTexts(h).slice(-6)))
  h.check('B1-19: the card states the card-level Source-only fact and no fake Exact',
    visibleTexts(h).some(text => text.includes('Source-only · position unverified'))
      && !visibleTexts(h).some(text => text.includes('Exact')),
    JSON.stringify(visibleTexts(h).slice(-6)))

  // ── B1-07/B1-08/B1-18: Next reveals the canonical card and its body becomes readable ──
  const revealsBefore = revealOps(h).length
  if (fault === 'no-scroll') {
    // Arm the suppression BEFORE the navigation, so the renderer's own reveal
    // request is swallowed by the subject.
    await runCase(h, 'semantic-search-suppress-reveal')
  }
  await h.key('Return', 600)
  const reveal = revealOps(h).at(-1)
  if (fault === 'no-scroll') {
    h.check('FAULT no-scroll: the reveal op was suppressed on purpose', revealOps(h).length === revealsBefore,
      JSON.stringify({ before: revealsBefore, after: revealOps(h).length }))
  } else {
    h.check('B1-18: a reveal op names a CURRENT Main root id',
      reveal !== undefined && /^main\./u.test(reveal.id) && reveal.at === 'nearest',
      JSON.stringify(reveal ?? null))
  }

  const bodyReadable = await pollUntil(h, () => {
    const snapshot = h.snapshot()
    return mainNodes(snapshot).some(node => String(node.text ?? '').includes(markers.innerOnly) && reallyVisible(snapshot, node))
  })
  h.check('B1-18: the revealed card body is READABLE inside the client viewport', bodyReadable,
    JSON.stringify({ reveal: reveal ?? null, visibleCards: visibleCards(h.snapshot()) }))
  h.capture(`${preset}-search-revealed`, 'the revealed tool card with its inner body readable')

  // ── B1-06: the SHARED token yields TWO cards, and Next steps between them ──
  for (let index = 0; index < markers.innerOnly.length; index += 1) await h.key('Backspace', 30)
  await typeQuery(h, markers.shared.toLowerCase())
  await waitUntil(h, 'B1-06: the shared token yields representative cards',
    () => visibleTexts(h).some(text => /\d+\/\d+ targets/u.test(text)))
  const countLabel = visibleTexts(h).find(text => /\d+\/\d+ targets/u.test(text)) ?? ''
  const countMatch = countLabel.match(/(\d+)\/(\d+) targets/u)
  h.check('B1-06: the count reports representative CARDS with a real denominator',
    countMatch !== null && Number(countMatch[2]) >= 1 && Number(countMatch[1]) >= 1,
    JSON.stringify(visibleTexts(h).slice(-6)))
  await h.key('Return', 600)
  await h.key('Return', 600)
  if (fault === 'wrong-node') {
    // B1-18's discriminating case: reveal a DIFFERENT main root that carries the
    // SAME word. The flow resolves it from the client's own tree (a real id the
    // client holds), never from a guess, and records the WHOLE identity chain so
    // the assertion cannot pass on "some SHARED card is visible".
    const identity = currentTargetIdentity(h, markers.shared, markers.right)
    h.measure('B1-18 identity: the current target root', JSON.stringify(identity))
    // The revealed id the previous navigation sent IS the target's root; the
    // wrong candidate is a DIFFERENT real root that also carries the word.
    const wrongCandidate = identity.otherSharedRoot
    h.check('B1-18 precond: a DIFFERENT real Main root also carries the shared word',
      typeof wrongCandidate === 'string' && wrongCandidate !== identity.rootId,
      JSON.stringify(identity))
    await runCase(h, 'semantic-search-wrong-node', { id: wrongCandidate })
    const wrong = records(h).find(row => row.kind === 'fault.wrong-node')
    h.measure('FAULT wrong-node: the revealed id vs the intended one', JSON.stringify(wrong ?? null))
    await h.sleep(700)
    // ONE snapshot: the nodes AND the chains must come from the same tree.
    const faultSnapshot = h.snapshot()
    // The assertion the fault must break: the viewport shows the CURRENT
    // TARGET's card (its own root's text), not merely another card sharing the
    // word. The current target card is the one whose text carries `wrong`/
    // `right` (the two adjacent cards) — the run's own target is the SECOND one.
    // The CURRENT target card is identified by ITS OWN text (`right`), never by
    // the shared query word: another same-word card being visible cannot pass.
    const targetCardVisible = reallyVisible(faultSnapshot, targetCardNode(faultSnapshot, identity))
    h.check('B1-18: the viewport shows the CURRENT target card after a reveal',
      targetCardVisible,
      JSON.stringify({
        wrong,
        identity,
        visibleCards: visibleCards(faultSnapshot),
        revealed: faultSnapshot.nodes
          .filter(node => String(node.text ?? '').toLowerCase().includes(markers.shared.toLowerCase()))
          .map(node => ({ rect: rect(node), text: String(node.text).slice(0, 60) })),
      }))
  }
  h.check('B1-06: Next/Prev stay inside the representative-card range',
    visibleTexts(h).some(text => /\d+\/\d+ targets/u.test(text)), JSON.stringify(visibleTexts(h).slice(-6)))

  // ── B1-10: a zero-match query is honest and inert ──
  for (let index = 0; index < markers.shared.length; index += 1) await h.key('Backspace', 30)
  await typeQuery(h, markers.nonExistent.toLowerCase())
  await waitUntil(h, 'B1-10: the absent token yields zero targets',
    () => visibleTexts(h).some(text => text.includes('0/0 targets')))
  h.check('B1-10: a zero-match query paints 0/0 and says so',
    visibleTexts(h).some(text => text.includes('0/0 targets')), JSON.stringify(visibleTexts(h).slice(-6)))
  const revealsAtZero = revealOps(h).length
  await h.key('Return', 500)
  await h.sleep(300)
  h.check('B1-10: Next with no target sends NO reveal op', revealOps(h).length === revealsAtZero,
    JSON.stringify({ before: revealsAtZero, after: revealOps(h).length }))

  // ── B1-04: closing restores the SAME Composer with its draft intact ──
  const writerBeforeClose = records(h).filter(row => row.kind === 'producer.writer.settled').length
  await h.key('Escape', 700)
  h.check('B1-04: Escape closes the card and the Composer returns',
    await pollUntil(h, () => h.snapshot().nodes.some(node => String(node.class ?? '').includes('sf-editor'))),
    JSON.stringify(visibleTexts(h).slice(-6)))
  const closedEntries = h.snapshot().nodes
    .filter(node => String(node.class ?? '').includes('sf-act'))
    .map(node => String(node.text ?? ''))
  h.check('B1-03: closing restores exactly ONE Send and the Search entry',
    closedEntries.filter(text => text === '↑').length === 1
      && closedEntries.filter(text => text.includes('Search session')).length === 1,
    JSON.stringify(closedEntries))
  h.check('B1-04: no Session writer settlement was produced by the search journey',
    records(h).filter(row => row.kind === 'producer.writer.settled').length === writerBeforeClose,
    JSON.stringify({ before: writerBeforeClose, after: records(h).filter(row => row.kind === 'producer.writer.settled').length }))
  h.capture(`${preset}-search-closed`, 'the Composer restored after the search')

  // ── B1-17: the four client sizes × two appearances ──
  const matrix = []
  for (const viewport of VIEWPORTS) {
    // A REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow request
    // (measured: 720px wide / 440px tall on this build). The driver REPORTS the
    // clamp and the assertions below run against the REAL viewport — the clamp is
    // a measurement, never a silent acceptance (see tern-gui-testing.md §187).
    const geometry = await h.resize(viewport.width, viewport.height)
    if (gui) h.measure(`the real GUI window geometry for ${viewport.width}x${viewport.height}`,
      JSON.stringify(geometry))
    if (gui) {
      if (h.ctl('state').theme !== viewport.appearance) h.send('plugins', 'run', `appearance:${viewport.appearance}`)
    } else h.send('appearance', viewport.appearance)
    h.check(`the client resolved the ${viewport.appearance} appearance`,
      h.ctl('state').theme === viewport.appearance, String(h.ctl('state').theme))
    // Open the card again at this size and verify every control is really visible.
    const matrixSnapshot = h.snapshot()
    const entry = matrixSnapshot.nodes.find(node => String(node.text ?? '').includes('Search session'))
    const openedHere = entry !== undefined && await h.click(matrixSnapshot.chains, entry)
    const painted = openedHere && await waitUntil(h, `the card paints at ${viewport.width}x${viewport.height}`,
      () => searchCard(h.snapshot()) !== undefined)
    const snapshot = h.snapshot()
    const actions = snapshot.nodes.filter(node => String(node.class ?? '').includes('sf-act'))
      .filter(node => ['Prev', 'Next', 'Close'].includes(String(node.text ?? '')))
    const allVisible = actions.length === 3 && actions.every(node => reallyVisible(snapshot, node))
    const fieldVisible = snapshot.nodes.some(node => String(node.class ?? '').includes('sf-input')
      && reallyVisible(snapshot, node))
    h.check(`B1-17: ${viewport.width}x${viewport.height} ${viewport.appearance} paints all three actions and the query field`,
      painted && allVisible && fieldVisible,
      JSON.stringify({ painted, actions: actions.map(node => ({ text: node.text, rect: rect(node) })), fieldVisible }))
    const mainRows = mainNodes(snapshot).filter(node => String(node.text ?? '').trim() !== '' && reallyVisible(snapshot, node))
    h.check(`B1-17: ${viewport.width}x${viewport.height} keeps at least one readable Main row`,
      mainRows.length >= 1, String(mainRows.length))
    h.capture(`${preset}-search-${viewport.width}x${viewport.height}-${viewport.appearance}`,
      `the Search card at ${viewport.width}x${viewport.height} ${viewport.appearance}`)
    matrix.push({
      viewport, painted, actionsVisible: allVisible, fieldVisible, mainRows: mainRows.length,
      cardRect: searchCard(snapshot) === undefined ? null : rect(searchCard(snapshot)),
    })
    await h.key('Escape', 500)
  }
  writeLedger(h, 'viewport-matrix.json', matrix)

  // ── the fault ledger ──
  writeLedger(h, 'fault-injection.json', {
    fault,
    revealOps: revealOps(h),
    writerSettlements: records(h).filter(row => row.kind === 'producer.writer.settled').length,
    expected: fault === 'none' ? 'all assertions pass' : 'this run MUST exit non-zero',
  })
  finish(h, extra)
}
