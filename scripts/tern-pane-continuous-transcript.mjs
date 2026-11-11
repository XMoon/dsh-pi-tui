import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, type } from 'node:os'
import { join } from 'node:path'
import { containedXY, rect } from './tern-pane-geometry.mjs'

const OUT = h => h.root
const eventPath = h => join(OUT(h), 'events.jsonl')
const wirePath = h => join(OUT(h), 'sdk-wire.jsonl')
const promptsPath = h => join(OUT(h), 'prompts.json')
const readJsonl = path => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const records = h => readJsonl(eventPath(h))
const wireRecords = h => readJsonl(wirePath(h))

function foldLive(h) {
  const nodes = new Map()
  const remove = id => {
    const node = nodes.get(id)
    for (const child of node?.childIds ?? []) remove(child)
    nodes.delete(id)
  }
  const add = (node, parentId) => {
    if (node === undefined || node === null || typeof node.id !== 'string') return
    const childIds = (node.c ?? []).map(child => child.id).filter(id => typeof id === 'string')
    nodes.set(node.id, { id: node.id, k: node.k, p: { ...(node.p ?? {}) }, childIds, parentId })
    for (const child of node.c ?? []) add(child, node.id)
  }
  for (const entry of wireRecords(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') {
        remove(op[1])
        add(op[4], op[2])
        const parent = nodes.get(op[2])
        for (const child of (op[4]?.c ?? []).map(node => node.id)) {
          if (parent !== undefined && !parent.childIds.includes(child)) parent.childIds.push(child)
        }
      } else if (op[0] === 'del') {
        remove(op[1])
      } else if (op[0] === 'set') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          for (const [key, value] of Object.entries(op[2] ?? {})) {
            if (value === null) delete node.p[key]
            else node.p[key] = value
          }
        }
      } else if (op[0] === 'text') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          const before = typeof node.p.text === 'string' ? node.p.text : ''
          node.p.text = op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '')
        }
      }
    }
  }
  return nodes
}

function subtreeText(live, id, visited = new Set()) {
  if (visited.has(id)) return ''
  visited.add(id)
  const node = live.get(id)
  if (node === undefined) return ''
  const own = typeof node.p.text === 'string' ? node.p.text
    : typeof node.p.head === 'string' ? node.p.head : ''
  return [own, ...node.childIds.map(child => subtreeText(live, child, visited))].filter(Boolean).join(' ')
}

const userRows = live => [...live.values()].filter(node => node.id.startsWith('main.')
  && node.k === 'message' && node.p.role === 'dsh.transcript.user')
const rowIdFor = (live, marker) => userRows(live).find(node => subtreeText(live, node.id).includes(marker))?.id
const openedSurfaces = h => wireRecords(h)
  .filter(entry => entry.dir === 'out' && entry.verb === 'o')
  .map(entry => ({ id: entry.body?.id, mode: entry.body?.mode ?? 'inline' }))
const acknowledgements = h => wireRecords(h)
  .filter(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'ack')
const hello = h => wireRecords(h)
  .find(entry => entry.dir === 'in' && entry.verb === 'r' && entry.body?.r === 'hello')
const mainRegion = snapshot => snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('sf-main'))
const mainText = h => {
  const main = mainRegion(h.snapshot())
  return main === undefined ? '' : h.descendantsText(main)
}
const clientRow = (h, marker) => {
  const snapshot = h.snapshot()
  const main = mainRegion(snapshot)
  if (main === undefined) return undefined
  const descendants = []
  const visit = node => {
    descendants.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(main)
  const node = descendants.find(candidate => String(candidate.text ?? '').includes(marker))
  if (node === undefined) return undefined
  return { node, rect: rect(node), containedXY: containedXY(snapshot.chains, node) }
}

async function waitUntil(h, label, predicate, { limit = 300, intervalMs = 100 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}

function finish(h, extra = {}) {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

function atomicJson(path, value) {
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`)
  renameSync(temp, path)
}

export default async function (h) {
  const ternBin = process.env.TERN_BIN
  if (ternBin === undefined || ternBin === '' || !existsSync(ternBin)) {
    throw new Error('TERN_BIN must name the Tern binary for this qualification lane')
  }
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const ternVersionNumber = ternVersion.match(/\d+\.\d+\.\d+/u)?.[0]
  const ternBytes = readFileSync(ternBin)
  const ternSha256 = createHash('sha256').update(ternBytes).digest('hex')
  const manifest = JSON.parse(readFileSync(join(h.repo, 'package.json'), 'utf8'))
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const dshPin = manifest.devDependencies?.['@deepseek-ai/dsh-agent']
  const dshSessionPin = manifest.devDependencies?.['@deepseek-ai/dsh-session']
  const dshMode = JSON.parse(readFileSync(join(h.repo, 'test/compat/dsh-mode.json'), 'utf8')).mode
  const sdkPin = manifest.dependencies?.['@stencil-hq/tern']
  const sdkIntegrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1]
  const host = { os: `${type()} ${release()}`, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, cores: cpus().length }
  h.check('the checkout declares the planned npm DSH and Tern SDK pins',
    dshPin === '0.2.2-rc.1' && dshSessionPin === dshPin && dshMode === 'npm' && sdkPin === '0.2.0'
      && sdkIntegrity !== undefined,
    JSON.stringify({ dshPin, dshSessionPin, dshMode, sdkPin, sdkIntegrity }))

  await h.resize(1280, 800)
  h.send('appearance', 'dark')
  h.check('the headless client resolves dark appearance', h.ctl('state').theme === 'dark')
  const subject = join(h.repo, 'scripts/tern-pane-continuous-transcript-subject.mts')
  const launched = await h.launch(subject)
  h.check('the Tern pane accepts the one-shot production subject launch', launched)
  if (!launched) {
    finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION' })
    return
  }

  const testInput = JSON.parse(readFileSync(promptsPath(h), 'utf8'))
  const prompts = testInput.prompts
  const markers = prompts.map(prompt => prompt.marker)
  const started = await waitUntil(h, 'the subject and production inline Surface are ready', () =>
    records(h).some(entry => entry.kind === 'subject.ready' && entry.sessionId === testInput.sessionId)
      && openedSurfaces(h).length === 1
      && acknowledgements(h).length > 0
      && ['sf-main', 'sf-dock', 'sf-layer'].every(name =>
        h.snapshot().nodes.some(node => String(node.class ?? '').split(/\s+/u).includes(name))),
  { limit: 300 })
  h.check('the real SDK handshake opened and acknowledged one production inline Surface',
    started && openedSurfaces(h).length === 1 && openedSurfaces(h)[0]?.mode === 'inline'
      && acknowledgements(h).every(entry => entry.body?.sf === openedSurfaces(h)[0]?.id),
    JSON.stringify({ opened: openedSurfaces(h), acks: acknowledgements(h).length }))
  if (!started) {
    finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION' })
    return
  }
  const helloRecord = hello(h)
  h.check('the SDK hello reports the version of this run’s Tern binary',
    ternVersionNumber !== undefined && helloRecord?.body?.ver === ternVersionNumber,
    JSON.stringify({ ternVersion, hello: helloRecord?.body }))
  writeFileSync(join(h.root, 'environment.json'), `${JSON.stringify({
    tern: { path: ternBin, version: ternVersion, sha256: ternSha256, bytes: ternBytes.length },
    sdk: { pin: sdkPin, integrity: sdkIntegrity },
    dsh: { mode: dshMode, agentPin: dshPin, sessionPin: dshSessionPin },
    host,
    hello: helloRecord?.body,
    viewport: h.ctl('stats').viewport,
    evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION',
  }, null, 1)}\n`)

  h.check('the subject provides exactly PR1-TERN-01 through PR1-TERN-25',
    prompts.length === 25 && prompts.every((prompt, index) =>
      prompt.ordinal === index + 1 && prompt.marker === `PR1-TERN-${String(index + 1).padStart(2, '0')}`),
    JSON.stringify(markers))
  h.check('no Writer submission or answer exists before the first injected prompt',
    records(h).filter(entry => entry.kind === 'writer.settled').length === 0
      && userRows(foldLive(h)).length === 0,
    JSON.stringify({ writers: records(h).filter(entry => entry.kind === 'writer.settled').length, users: userRows(foldLive(h)).length }))

  const turns = []
  for (const prompt of prompts) {
    const writerCountBefore = records(h).filter(entry => entry.kind === 'writer.settled').length
    const modelCallsBefore = records(h).filter(entry => entry.kind === 'model.calls').at(-1)?.calls ?? 0
    h.send('type', JSON.stringify(prompt.text))
    await h.key('Return', 500)

    const writerSettled = await waitUntil(h, `the Direct Writer settles ${prompt.marker}`, () => {
      const writes = records(h).filter(entry => entry.kind === 'writer.settled')
      return writes.length === writerCountBefore + 1
        && writes.at(-1)?.marker === prompt.marker
        && writes.at(-1)?.outcomeKind === 'committed'
    })
    h.check(`${prompt.marker} reaches one committed production Direct Writer call`, writerSettled,
      JSON.stringify(records(h).filter(entry => entry.kind === 'writer.settled').at(-1)))
    if (!writerSettled) {
      finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION', turns })
      return
    }

    const turnEnded = await waitUntil(h, `the official turn/end for ${prompt.marker}`, () =>
      records(h).some(entry => entry.kind === 'session.event' && entry.eventType === 'turn/end'
        && entry.turn === prompt.ordinal))
    h.check(`${prompt.marker} has its official Session turn/end`, turnEnded,
      JSON.stringify(records(h).filter(entry => entry.kind === 'session.event'
        && entry.eventType === 'turn/end').at(-1)))
    if (!turnEnded) {
      finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION', turns })
      return
    }

    const wireMounted = await waitUntil(h, `the current live Main mounts ${prompt.marker}`, () => {
      const live = foldLive(h)
      return rowIdFor(live, prompt.marker) !== undefined
        && userRows(live).filter(node => subtreeText(live, node.id).includes(prompt.marker)).length === 1
    })
    const clientMounted = mainText(h).includes(prompt.marker)
    h.check(`${prompt.marker} is in the folded live SDK Main wire`, wireMounted,
      JSON.stringify({ liveUsers: userRows(foldLive(h)).length, rowId: rowIdFor(foldLive(h), prompt.marker) }))
    h.check(`${prompt.marker} is in the current real Tern Client Main tree`, clientMounted,
      mainText(h).slice(-240))
    const modelCalled = await waitUntil(h, `the scripted Agent serves ${prompt.marker}`, () =>
      (records(h).filter(entry => entry.kind === 'model.calls').at(-1)?.calls ?? 0) > modelCallsBefore)
    h.check(`${prompt.marker} reaches the official Agent model request`, modelCalled,
      JSON.stringify(records(h).filter(entry => entry.kind === 'model.calls').at(-1)))
    if (!wireMounted || !clientMounted || !modelCalled) {
      finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION', turns })
      return
    }
    turns.push({ ordinal: prompt.ordinal, marker: prompt.marker, rowId: rowIdFor(foldLive(h), prompt.marker), clientTree: true })
  }

  const live = foldLive(h)
  const mountedUsers = userRows(live)
  const anchors = ['PR1-TERN-01', 'PR1-TERN-13', 'PR1-TERN-25']
  const anchorIds = Object.fromEntries(anchors.map(marker => [marker, rowIdFor(live, marker) ?? null]))
  h.check('the folded live SDK wire contains all 25 distinct User nodes in the single Main',
    mountedUsers.length === 25 && new Set(mountedUsers.map(node => node.id)).size === 25,
    JSON.stringify({ count: mountedUsers.length, ids: anchors.map(marker => anchorIds[marker]) }))
  h.check('the earliest, middle and latest User IDs are simultaneously mounted and distinct',
    anchors.every(marker => typeof anchorIds[marker] === 'string')
      && new Set(Object.values(anchorIds)).size === 3,
    JSON.stringify(anchorIds))
  const finalClientMarkers = anchors.filter(marker => mainText(h).includes(marker))
  h.check('the current Client Main tree holds the latest tail viewport after 25 turns',
    mainText(h).includes('PR1-TERN-25'), JSON.stringify({ finalClientMarkers, main: mainText(h).slice(-500) }))
  h.measure('real Client viewport virtualization', JSON.stringify({
    wireMountedAnchors: anchorIds,
    clientTreeAnchorsAtFinalTail: finalClientMarkers,
    clientTreeAnchorsObservedAtTheirTurn: turns.filter(turn => turn.clientTree).map(turn => turn.marker),
  }))
  h.check('TSP wire contains no PiTui Earlier turns summary',
    ![...live.values()].some(node => subtreeText(live, node.id).includes('Earlier turns')))

  const mainCapture = h.capture('continuous-main-25-turns-1280x800-dark',
    'the production Direct Main after 25 sequential Composer submissions')
  const earliestId = anchorIds['PR1-TERN-01']
  if (typeof earliestId !== 'string') {
    finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION', turns, anchorIds })
    return
  }
  const revealSeq = 1
  atomicJson(join(h.root, 'case.json'), { seq: revealSeq, kind: 'reveal', nodeId: earliestId })
  const revealSettled = await waitUntil(h, 'the same production Surface receives the wire-derived reveal id', () =>
    records(h).some(entry => entry.kind === 'client.reveal.requested' && entry.seq === revealSeq
      && entry.nodeId === earliestId && entry.surfaceId === openedSurfaces(h)[0]?.id))
  h.check('the mounted earliest SDK node is addressed by its actual wire id on the existing Surface',
    revealSettled,
    JSON.stringify(records(h).filter(entry => entry.kind === 'client.reveal.requested').at(-1)))
  if (!revealSettled) {
    finish(h, { evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION', turns, anchorIds })
    return
  }
  const revealedRow = await waitUntil(h, 'the real Client tree reflects the reveal of the earliest mounted node', () =>
    clientRow(h, 'PR1-TERN-01')?.containedXY === true)
  h.check('the real Client can reveal the earliest still-mounted User node', revealedRow,
    JSON.stringify(clientRow(h, 'PR1-TERN-01') ?? null))
  const revealCapture = h.capture('continuous-main-earliest-revealed',
    'the earliest mounted User addressed by its actual SDK wire id')

  const backSnapshot = h.snapshot()
  const back = backSnapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-back'))
  if (back !== undefined && containedXY(backSnapshot.chains, back)) {
    const clicked = await h.click(backSnapshot.chains, back)
    h.check('the visible native Back-to-live control accepts one control-injected click', clicked)
    if (clicked) {
      const liveTailRestored = await waitUntil(h, 'the native Back-to-live control returns Main to its latest tail', () =>
        clientRow(h, 'PR1-TERN-25')?.containedXY === true)
      h.check('native Back-to-live restores the latest tail after reveal', liveTailRestored,
        JSON.stringify(clientRow(h, 'PR1-TERN-25') ?? null))
    }
  } else {
    h.measure('NATIVE_BACK_TO_LIVE_NOT_EXERCISED', 'the real Client tree exposed no visible tv-back control after reveal')
  }

  await h.resize(400, 600)
  h.send('appearance', 'dark')
  h.check('400x600 Client appearance is dark', h.ctl('state').theme === 'dark')
  const narrowDarkCapture = h.capture('continuous-main-400x600-dark', 'the unchanged TSP presentation at 400x600 dark')

  await h.resize(900, 360)
  h.send('appearance', 'light')
  h.check('900x360 Client appearance is light', h.ctl('state').theme === 'light')
  const shortLightCapture = h.capture('continuous-main-900x360-light', 'the known short light viewport; no styling change is part of PR1')
  h.measure('known 900x360 light viewport result', JSON.stringify({
    capture: shortLightCapture,
    earlyUser: clientRow(h, 'PR1-TERN-01') ?? null,
    main: rect(mainRegion(h.snapshot()) ?? {}),
    disposition: 'recorded as-is; PR1 does not claim to fix the known clipping',
  }))

  const captures = [mainCapture, revealCapture, narrowDarkCapture, shortLightCapture]
  h.send('type', JSON.stringify('/exit'))
  await h.key('Return', 500)
  const subjectFinal = await waitUntil(h, 'the production application settles through its /exit owner', () =>
    records(h).some(entry => entry.kind === 'subject.final'))
  const finalRecord = records(h).filter(entry => entry.kind === 'subject.final').at(-1)
  h.check('the production Direct fixture settles after the real-pane sequence',
    subjectFinal && finalRecord?.settledWrites === 25 && finalRecord?.modelCalls === 25,
    JSON.stringify(finalRecord ?? null))
  finish(h, {
    evidenceTier: 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + OFFICIAL_DIRECT_APPLICATION',
    sessionId: testInput.sessionId,
    turnCount: turns.length,
    anchorIds,
    captures,
    known900x360Light: 'recorded; not claimed fixed or passed',
    physicalGui: 'NOT_VERIFIED by this headless lane',
  })
}
