/**
 * T2 Stage 4 / PR3 — SYNTHETIC CLIENT LOAD lane.
 *
 *   TERN_LOAD_CASE=plain-100-full TERN_BIN=<tern> \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-continuous-reading-load.mjs \
 *     --out <run>
 *
 * ONE case per run, in a FRESH real `tern serve` pane: the synthetic load
 * subject mounts one inline Surface and appends the canonical fixture through
 * the PRODUCTION projection (`TranscriptFolder` → descriptors →
 * `ContinuousMainJournal`). Every artifact this lane writes is marked
 * `CLIENT_STRESS_SYNTHETIC`: it proves the real client's document cost, and it
 * never claims to be the production Direct Writer path.
 *
 * What it records per case: cold attach + ACK, the actual first/middle/latest
 * wire ids, the client's own `stats`/`perf`, both processes' RSS, node counts and
 * frame bytes, a real scroll-up with a visible older marker, 30 appended tail
 * turns with steady-state timings, and a native return-to-live followed by one
 * more turn (continued follow). `settle` ops and any real `gone` events are
 * preserved as their own chronology; a `gone` is never fabricated.
 * @module scripts/tern-pane-continuous-reading-load
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, type as osType } from 'node:os'
import { join } from 'node:path'
import { containedXY, rect, visibleBox } from './tern-pane-geometry.mjs'
import {
  eventRecords,
  foldLive,
  goneEvents,
  mainIds,
  openedSurfaces,
  readJson,
  settleOps,
  wireRecords,
} from './support/tern-continuous-reading-observation.mjs'

const EVIDENCE_TIER = 'REAL_TERN_HEADLESS_CLIENT + SYNTHETIC_PROJECTION_INPUT'
const APPEND_TURNS = 30
const STEADY_TURNS = 30

const CASE = (() => {
  const raw = process.env.TERN_LOAD_CASE
  if (raw === undefined || raw === '') throw new Error('TERN_LOAD_CASE is required, e.g. mixed-1000-full')
  const match = raw.match(/^(plain|mixed)-(100|1000|5000)-(full|compact|focus)$/u)
  if (match === null) throw new Error(`TERN_LOAD_CASE must be <plain|mixed>-<100|1000|5000>-<full|compact|focus>, got ${raw}`)
  return { id: raw, payload: match[1], turns: Number(match[2]), preset: match[3] }
})()

const records = h => eventRecords(h.root)
const wire = h => wireRecords(h.root)
const live = h => foldLive(wire(h))

const mainRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const regionNode = (snapshot, name) => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))

async function waitUntil (h, label, predicate, { limit = 900, intervalMs = 200 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}

/** The visible fragment centre of the Main region. */
function mainPoint (h) {
  const snapshot = h.snapshot()
  const main = mainRegion(snapshot)
  if (main === undefined) return undefined
  const box = visibleBox(snapshot.chains, main)
  if (box.span.x < 8 || box.span.y < 8) return undefined
  return { x: Math.round(box.start.x + box.span.x / 2), y: Math.round(box.start.y + box.span.y / 2) }
}

/** The Main rows a marker is visible in, with their real clipping facts. */
function mainRows (h) {
  const snapshot = h.snapshot()
  const main = mainRegion(snapshot)
  if (main === undefined) return []
  const out = []
  const walk = node => {
    const box = rect(node)
    const text = String(node.text ?? '')
    if (text.trim() !== '' && (box[2] > 0 || box[3] > 0)) {
      out.push({ text, rect: box, containedXY: containedXY(snapshot.chains, node) })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(main)
  return out
}

const pct = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[at]
}

const rssOf = pid => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const kb = status.match(/^VmRSS:\s+(\d+) kB/mu)?.[1]
    return kb === undefined ? null : Number(kb) * 1024
  } catch {
    return null
  }
}

let commandSeq = 0
async function runCommand (h, kind, extra = {}) {
  commandSeq += 1
  const seq = commandSeq
  const path = join(h.root, 'case.json')
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ seq, kind, ...extra })}\n`)
  const { renameSync } = await import('node:fs')
  renameSync(`${path}.tmp`, path)
  const answered = await waitUntil(h, `case ${kind}#${seq} answered`,
    () => readJson(join(h.root, 'case-result.json'))?.seq === seq, { limit: 1200, intervalMs: 250 })
  const result = readJson(join(h.root, 'case-result.json'))
  h.check(`the synthetic subject answered ${kind}#${seq}`, answered && result?.status === 'ok',
    JSON.stringify(result ?? null).slice(0, 300))
  return result
}

export default async function (h) {
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the pinned Tern binary file for this load lane')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const ternSha256 = createHash('sha256').update(readFileSync(ternBin)).digest('hex')
  // The serve child's own RSS: `stats` carries no pid, so the process is
  // resolved by the control socket it serves (a real OS fact, read-only).
  const clientPid = (() => {
    try {
      const out = execFileSync('pgrep', ['-f', `tern serve --control ${join(h.root, 'tern.sock')}`], { encoding: 'utf8' })
      return Number(out.trim().split('\n')[0]) || null
    } catch {
      return null
    }
  })()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  const host = { os: `${osType()} ${release()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, cores: cpus().length }

  // The case is written BEFORE launch: the pane does not inherit our env, so a
  // file in the run directory is the only reliable input channel (measured).
  writeFileSync(join(h.root, 'load-case.json'), `${JSON.stringify({
    caseId: CASE.id, payload: CASE.payload, turns: CASE.turns, preset: CASE.preset,
  })}\n`)

  await h.resize(1280, 800)
  h.send('appearance', 'dark')
  h.check('A4: the client resolves the dark appearance', h.ctl('state').theme === 'dark')

  const subject = join(h.repo, 'scripts/tern-pane-continuous-reading-load-subject.mts')
  const coldStart = Date.now()
  const launched = await h.launch(subject)
  const ready = await waitUntil(h, 'the synthetic subject folded its history and attached the Main',
    () => records(h).some(entry => entry.kind === 'load.ready'), { limit: 1200, intervalMs: 250 })
  const coldSettled = await waitUntil(h, 'the client acknowledged the cold Main',
    () => wire(h).some(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack'), { limit: 300 })
  const readyRecord = records(h).find(entry => entry.kind === 'load.ready')
  h.check('A4: one inline Surface is attached with a real ACK', launched && ready && coldSettled
    && openedSurfaces(wire(h)).length === 1, JSON.stringify({ launched, ready, coldSettled, surfaces: openedSurfaces(wire(h)) }))
  if (!launched || !ready) {
    h.finish({ evidenceTier: EVIDENCE_TIER, caseId: CASE.id, verdict: 'QUALIFICATION_BLOCKED' })
    return
  }

  const liveIds = mainIds(live(h))
  const firstWireId = liveIds[0] ?? null
  const middleWireId = liveIds[Math.floor(liveIds.length / 2)] ?? null
  const latestWireId = liveIds.at(-1) ?? null
  h.check('A4: the Main carries the whole fixture as ONE continuous document',
    liveIds.length >= CASE.turns, JSON.stringify({ cards: liveIds.length, turns: CASE.turns }))
  h.check('A4: first/middle/latest card ids are distinct and real',
    firstWireId !== null && middleWireId !== null && latestWireId !== null
      && new Set([firstWireId, middleWireId, latestWireId]).size === 3,
    JSON.stringify({ firstWireId, middleWireId, latestWireId }))
  h.check('A4: the projection did not append a synthetic "Earlier turns" summary',
    ![...live(h).values()].some(node => String(node.p?.text ?? '').includes('Earlier turns')))

  // The client's own document cost.
  const statsCold = h.ctl('stats')
  // `perf on|mark` restart/observe the collection: delivered ONCE, never retried.
  h.send('perf', 'on')
  h.send('perf', 'mark')
  await h.sleep(400)
  const perf = h.ctl('perf', 'since')
  const rssClient = rssOf(clientPid) ?? null
  h.measure('A4: client document cost', JSON.stringify({
    nodes: statsCold.nodes, frames: statsCold.frames, viewport: statsCold.viewport,
    gpuFrameData: statsCold.gpu?.root?.frameData ?? null, gpuTotal: statsCold.gpu?.root?.total ?? null,
    perf: perf?.ok === false ? perf : { frames: perf?.frames ?? null, cpu: perf?.cpu ?? null },
    rssClientBytes: rssClient,
    subject: { foldMs: readyRecord?.foldMs ?? null, cold: readyRecord?.cold ?? null, rss: readyRecord?.rss ?? null, heapUsed: readyRecord?.heapUsed ?? null },
    driverRss: process.memoryUsage().rss,
    coldAttachMs: Date.now() - coldStart,
  }))

  // ── a real scroll-up must reach an older visible row ──
  const point = mainPoint(h)
  h.check('A4: the continuous document exposes a real interior pointer target', point !== undefined, JSON.stringify(point))
  if (point === undefined) { h.finish({ evidenceTier: EVIDENCE_TIER, caseId: CASE.id }); return }
  h.send('move', point.x, point.y)
  await h.sleep(300)
  const beforeScroll = mainRows(h).filter(row => row.containedXY)
  h.send('wheel', 0, -900)
  await h.sleep(900)
  const afterScroll = mainRows(h).filter(row => row.containedXY)
  h.check('A4: one real wheel scroll reaches older content that was outside the viewport',
    afterScroll.length > 0 && JSON.stringify(afterScroll.slice(0, 4)) !== JSON.stringify(beforeScroll.slice(0, 4)),
    JSON.stringify({ before: beforeScroll.slice(0, 2), after: afterScroll.slice(0, 2) }))

  // ── 30 appended tail turns: steady-state timing, then follow ──
  const appendResult = await runCommand(h, 'append-tail', { turns: APPEND_TURNS })
  if (appendResult === undefined) { h.finish({ evidenceTier: EVIDENCE_TIER, caseId: CASE.id }); return }
  const steady = (appendResult.samples ?? []).map(sample => sample.totalMs)
  const appended = appendResult.appended === APPEND_TURNS
  h.check('A4: 30 deterministic tail turns committed through the same production journal',
    appended && steady.length === APPEND_TURNS, JSON.stringify({ appended, samples: steady.length }))
  h.measure('A4: steady-state append timing', JSON.stringify({
    count: steady.length,
    p50: pct(steady, 50), p95: pct(steady, 95), max: Math.max(...steady),
    heapUsed: appendResult.heapUsed, rss: appendResult.rss,
  }))

  // Native return to live: scroll far down, then append ONE more turn and prove
  // the new tail is reachable without any reveal operation.
  await h.key('End', 700)
  await h.sleep(400)
  const followResult = await runCommand(h, 'append-tail', { turns: 1 })
  const followTurn = followResult?.lastTailTurn
  const followed = await waitUntil(h, 'the followed tail turn is visible after return-to-live',
    () => {
      const rows = mainRows(h).filter(row => row.containedXY)
      return rows.some(row => row.text.includes(`LOAD-TAIL-${String(followTurn).padStart(6, '0')}`))
    }, { limit: 300, intervalMs: 200 })
  h.measure('A4: continued follow after native return-to-live', JSON.stringify({
    followTurn, followed,
    visibleTail: mainRows(h).filter(row => row.containedXY).slice(-3).map(row => row.text.slice(0, 60)),
  }))

  // ── settle/gone chronology, never inferred from absence ──
  const settles = settleOps(wire(h))
  const gone = goneEvents(wire(h))
  const goneIds = new Set(gone.flatMap(entry => entry.ids))
  // A `gone` id must never receive a later `set`/`text`; a real stamp change may
  // re-add the whole root. Check the actual op stream after each gone frame.
  const offending = []
  for (const entry of wire(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if ((op[0] === 'set' || op[0] === 'text') && goneIds.has(op[1])) offending.push({ op, frame: entry.body?.s ?? null })
    }
  }
  h.check('A4: no settle/text op ever targeted an id the client reported gone',
    offending.length === 0, JSON.stringify(offending.slice(0, 3)))
  h.measure('A4: retention chronology', JSON.stringify({
    settleOps: settles.length,
    goneFrames: gone.length,
    goneIds: [...goneIds].slice(0, 8),
    goneDisposition: gone.length === 0 ? 'GONE_NOT_OBSERVED_AT_THIS_LOAD' : 'GONE_OBSERVED',
    journalRetired: records(h).filter(entry => entry.kind === 'load.gone').map(entry => ({ frame: entry.frame, retired: entry.retired })),
  }))

  const captures = []
  if (CASE.id === 'mixed-5000-full') {
    // The plan's extra geometry cell for the worst case.
    h.send('appearance', 'light')
    await h.resize(900, 360)
    await h.sleep(700)
    captures.push(h.capture('load-5000-full-900x360-light', 'CLIENT_STRESS_SYNTHETIC worst-case short viewport'))
    const shortMain = mainRegion(h.snapshot())
    const shortDock = regionNode(h.snapshot(), 'sf-dock')
    h.measure('A4: 5000-turn Main/Dock geometry at 900x360', JSON.stringify({
      main: shortMain === undefined ? null : rect(shortMain), dock: shortDock === undefined ? null : rect(shortDock),
    }))
    h.send('appearance', 'dark')
    await h.resize(1280, 800)
    await h.sleep(700)
  }
  captures.push(h.capture(`load-${CASE.id}-client`, `CLIENT_STRESS_SYNTHETIC ${CASE.id}`))

  const finalStats = h.ctl('stats')
  const ledger = {
    schema: 'dsh-pi-tui.tsp.t2.stage4.pr3.client-load-case.v1',
    caseId: CASE.id, payload: CASE.payload, turns: CASE.turns, preset: CASE.preset,
    evidenceTier: EVIDENCE_TIER,
    tern: { bin: ternBin, version: ternVersion, sha256: ternSha256 },
    sdk: { pin: '0.2.0', integrity: sdkIntegrity },
    host,
    ids: { firstWireId, middleWireId, latestWireId, cards: liveIds.length },
    cold: {
      attachMs: Date.now() - coldStart, foldMs: readyRecord?.foldMs ?? null, commit: readyRecord?.cold ?? null,
      nodes: statsCold.nodes, frames: statsCold.frames, viewport: statsCold.viewport,
      subjectRss: readyRecord?.rss ?? null, subjectHeapUsed: readyRecord?.heapUsed ?? null,
    },
    steady: { appended: appendResult.appended, p50: pct(steady, 50), p95: pct(steady, 95), max: Math.max(...steady), samples: steady },
    follow: { followTurn, followed },
    retention: { settleOps: settles.length, goneFrames: gone.length, goneIds: [...goneIds], disposition: gone.length === 0 ? 'GONE_NOT_OBSERVED_AT_THIS_LOAD' : 'GONE_OBSERVED' },
    final: { nodes: finalStats.nodes, frames: finalStats.frames, rssClientBytes: rssOf(clientPid) ?? null, clientPid, driverRss: process.memoryUsage().rss },
    captures,
    limitation: 'SYNTHETIC PROJECTION INPUT: no Host Session claim, no Direct Writer. This is a real-client document-cost lane, not production E2E.',
  }
  writeFileSync(join(h.root, 'load-case-result.json'), `${JSON.stringify(ledger, null, 1)}\n`)

  h.send('key', 'f10')
  await h.sleep(500)
  h.finish({
    evidenceTier: EVIDENCE_TIER,
    caseId: CASE.id,
    qualification: h.results.every(result => result.ok === true) ? 'CLIENT_LOAD_PASS' : 'FAILED_ASSERTIONS',
    loadCase: ledger,
  })
}
