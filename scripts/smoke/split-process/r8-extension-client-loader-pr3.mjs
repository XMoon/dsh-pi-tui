/**
 * R8-E Client-local `./tui` loader lifecycle — real Split qualification.
 *
 * ONE isolated profile with genuinely `npm pack`ed third-party fixtures (two
 * opted-in UI-only packages plus one plain Host negative control), directed
 * through the official `dsh plugin` command. ONE real Host process and TWO
 * independent real surface Clients then prove:
 *
 * - each Client mounts BOTH external `./tui` packages through the production
 *   Client-local owner and the EXISTING official Loader;
 * - both clients paint each package's distinct Footer contribution and each
 *   client's slash command runs its own package handler exactly once;
 * - the plain DSH Host package's `./tui` module is never mounted by PiTui;
 * - Client A exits without changing the Host identity or removing Client B's
 *   Footer/Command capability.
 *
 * @module split-process/r8-extension-client-loader-pr3
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { installPlugin, runDsh } from '../../lib/dsh-smoke-harness.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { chunk } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'r8-extension-config')
const PROFILE = 'pi-tui'
const FIXTURES = ['a', 'b', 'dual', 'plain']
const SENTINEL_ENV = 'R8_EXTENSION_CONFIG_SENTINEL'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Copy one R8 fixture, declare the current candidate peer and `npm pack` it. */
function packFixture(name, candidateVersion, workDir) {
  const directory = join(workDir, 'fixtures', name)
  cpSync(join(FIXTURE_ROOT, name), directory, { recursive: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.peerDependencies = { '@xmoon76/dsh-pi-tui': `^${candidateVersion}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', workDir], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert(packed.status === 0, `npm pack failed for fixture ${name}: ${packed.stderr ?? ''}`)
  return join(workDir, JSON.parse(packed.stdout)[0].filename)
}

function sentinelRecords(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** Bounded qualification wait over a real file the fixtures write. */
async function waitForSentinel(path, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = sentinelRecords(path).find(predicate)
    if (record !== undefined) return record
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label}: the fixture sentinel did not record the expected event`)
}

export async function runClientExtensionLoaderPr3(context) {
  const { trace, installation } = context
  const scene = createC1Scene(context)
  const workDir = join(context.workDir, 'r8-extension-client-loader-pr3')
  mkdirSync(workDir, { recursive: true })
  const sentinel = join(workDir, 'sentinel.jsonl')
  const sourceNames = Object.fromEntries(FIXTURES.map(name => [
    name,
    readJson(join(FIXTURE_ROOT, name, 'package.json')).name,
  ]))
  let host
  let clientA
  let clientB
  let reloadClient
  const installed = []
  try {
    const tarballs = Object.fromEntries(FIXTURES.map(name => [
      name,
      packFixture(name, installation.manifest.version, workDir),
    ]))
    // B before A (install-order independence), plain as the native negative.
    for (const name of ['b', 'a', 'dual', 'plain']) {
      installPlugin(installation.dshInvocation, tarballs[name], context.workDir, installation.env)
      installed.push(sourceNames[name])
    }

    const longTurnBarrier = join(workDir, 'long-turn.release')
    const startedHost = await scene.startC1Host('long-turn', 'R8-E client-loader Host', {
      [SENTINEL_ENV]: sentinel,
      C1_HOLD_LONG_TURN: longTurnBarrier,
    })
    host = startedHost.host
    const hostIdentity = await scene.hostIdentityFacts(host)

    const startedA = await scene.startC1Client('R8-E client-loader Client A', {
      [SENTINEL_ENV]: sentinel,
      SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PROBE: '1',
      SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PACKAGES: JSON.stringify({ a: sourceNames.a, b: sourceNames.b }),
      SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
    })
    clientA = startedA.client
    const startedB = await scene.startC1Client('R8-E client-loader Client B', {
      [SENTINEL_ENV]: sentinel,
    })
    clientB = startedB.client
    assert(startedA.ready.pid !== startedB.ready.pid, 'the two surface Clients must be independent OS processes')

    // P3-05/P3-06: the official Plugin Manager disables package A's trusted
    // Config row; the Client revision removes only A's entry and re-enabling
    // creates a NEW Fiber while B stays active. The probe record is produced
    // by the production Client activation/refresh path, not a test copy.
    const lifecycleProbe = clientA.records.find(record => record.op === 'client-extension-loader-probe')
    assert(lifecycleProbe !== undefined,
      `the Client emitted no client-extension-loader probe record: ${JSON.stringify(clientA.records.slice(-12))}`)
    assert(lifecycleProbe.initialA === 'active' && lifecycleProbe.initialB === 'active',
      `both packages must start ACTIVE: ${JSON.stringify(lifecycleProbe)}`)
    assert(lifecycleProbe.afterDisableA !== 'active' && lifecycleProbe.afterDisableB === 'active',
      `disabling A's carrier row must remove only A: ${JSON.stringify(lifecycleProbe)}`)
    assert(lifecycleProbe.afterEnableA === 'active' && lifecycleProbe.afterEnableB === 'active',
      `re-enabling A must restore A while B stays active: ${JSON.stringify(lifecycleProbe)}`)
    // P3-07: a REAL byte change on the installed packed package becomes
    // reload-required while the old entry stays active; B is unaffected and
    // restoring the bytes returns A to active without a re-import.
    assert(lifecycleProbe.afterBytesA === 'reload-required' && lifecycleProbe.afterBytesB === 'active',
      `changed ./tui bytes must be reload-required, never ACTIVE: ${JSON.stringify(lifecycleProbe)}`)
    assert(lifecycleProbe.afterRestoreA === 'active',
      `restoring the packed bytes must return A to active: ${JSON.stringify(lifecycleProbe)}`)
    const appliesA = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply'
      && record.package === sourceNames.a && record.pid === startedA.ready.pid).length
    assert(appliesA >= 2, `same-bytes re-enable must create a NEW Fiber (A apply count ${String(appliesA)})`)
    // P3-02: each package's real `apply` received its OWN effective Config
    // document (the fixture's isolated profile defaults), never a shared or
    // wrapped `{data:...}` value.
    const applied = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply' && record.pid === startedA.ready.pid)
    assert(applied.find(record => record.package === sourceNames.a)?.config === JSON.stringify({ label: 'alpha', limit: 3 }),
      `A must apply its own effective Config: ${JSON.stringify(applied)}`)
    assert(applied.find(record => record.package === sourceNames.b)?.config === JSON.stringify({ label: 'bravo', limit: 7 }),
      `B must apply its own effective Config: ${JSON.stringify(applied)}`)

    // P3-03/P3-14: each real Client paints BOTH packages' Footer contribution.
    await clientA.waitForScreen('R8-A-LIVE', 'Client A fixture A footer', 120_000)
    await clientA.waitForScreen('R8-B-LIVE', 'Client A fixture B footer', 120_000)
    await clientA.waitForScreen('R8-DUAL-LIVE', 'Client A Dual footer', 120_000)
    await clientB.waitForScreen('R8-A-LIVE', 'Client B fixture A footer', 120_000)
    await clientB.waitForScreen('R8-B-LIVE', 'Client B fixture B footer', 120_000)
    await clientB.waitForScreen('R8-DUAL-LIVE', 'Client B Dual footer', 120_000)

    // P3-04: each real slash input runs the CURRENT Client's package handler.
    clientA.send('/r8-a\r')
    await waitForSentinel(sentinel, record => record.event === 'command-call'
      && record.package === sourceNames.a && record.pid === startedA.ready.pid, 'Client A /r8-a command')
    clientB.send('/r8-b\r')
    await waitForSentinel(sentinel, record => record.event === 'command-call'
      && record.package === sourceNames.b && record.pid === startedB.ready.pid, 'Client B /r8-b command')
    clientA.send('/r8-dual\r')
    await waitForSentinel(sentinel, record => record.event === 'command-call'
      && record.package === sourceNames.dual && record.pid === startedA.ready.pid, 'Client A /r8-dual command')

    // P3-10: the plain Host package's `./tui` module was imported only by its
    // own Host row (plain-tui-import), never applied as a PiTui Client entry.
    assert(
      !sentinelRecords(sentinel).some(record => record.event === 'tui-apply' && record.package === sourceNames.plain),
      'the plain non-opted-in package must never be applied as a PiTui Client extension',
    )

    // P3-09: a REAL import failure and a REAL apply failure on package A
    // affect only that Client's A entry; the Client still mounts and B's
    // Footer/Command stay live.
    for (const [fault, label] of [['a-import', 'import'], ['a-apply', 'apply']]) {
      const faulted = await scene.startC1Client(`R8-E client-loader A ${label} fault`, {
        [SENTINEL_ENV]: sentinel,
        R8_EXTENSION_CLIENT_FAULT: fault,
      })
      await faulted.client.waitForScreen('R8-B-LIVE', `R8-E client-loader B paint (${label} fault)`, 120_000)
      const frame = (await faulted.client.viewport()).join('\n')
      assert(!frame.includes('R8-A-LIVE') && frame.includes('R8-B-LIVE'),
        `A ${label} failure must leave A absent and B painted: ${JSON.stringify(frame.slice(-300))}`)
      faulted.client.send('/r8-b\r')
      await waitForSentinel(sentinel, record => record.event === 'command-call'
        && record.package === sourceNames.b && record.pid === faulted.ready.pid, `faulted Client /r8-b (${label})`)
      await scene.exitC1Client(faulted.client, `R8-E client-loader A ${label} fault Client`)
    }

    // P3-12: a REAL same-PID surface HMR retires and remounts the Client UI
    // revision; the old external entries are disposed first and the new
    // revision mounts fresh ones (the fixture apply count grows, no duplicate
    // Footer/Command remains).
    const appliesBeforeHmr = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply'
      && record.package === sourceNames.a && record.pid === startedA.ready.pid).length
    clientA.signalBusiness('SIGUSR2')
    const hmrReady = await clientA.waitFor(
      record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
      'Client A HMR ready',
      180_000,
    )
    await clientA.waitForScreen('R8-A-LIVE', 'Client A footer after HMR', 120_000)
    const appliesAfterHmr = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply'
      && record.package === sourceNames.a && record.pid === startedA.ready.pid).length
    assert(hmrReady.revision !== undefined && appliesAfterHmr > appliesBeforeHmr,
      `HMR must re-create the external entries on the new revision (applies ${String(appliesBeforeHmr)} -> ${String(appliesAfterHmr)})`)

    // P3-11/RFL-001 root cause B: a dedicated real Client imports v1,
    // replaces the on-disk ESM bytes with v2, then drives a REAL same-PID
    // surface revision. Node's ESM cache still holds v1; the new revision must
    // not import/apply A again (no phantom contribution) while B/Dual remain.
    const changedHmrClient = await scene.startC1Client('R8-E client-loader changed-bytes HMR Client', {
      [SENTINEL_ENV]: sentinel,
      SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
    })
    const changedHmrPid = changedHmrClient.ready.pid
    await changedHmrClient.client.waitForScreen('R8-A-LIVE', 'changed-HMR Client A footer', 120_000)
    const changedHmrFixtureA = join(installation.profileDir, 'node_modules', sourceNames.a, 'dist', 'tui.mjs')
    const changedHmrOriginalA = readFileSync(changedHmrFixtureA)
    const aApplyBeforeChangedHmr = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply'
      && record.package === sourceNames.a && record.pid === changedHmrPid).length
    try {
      writeFileSync(changedHmrFixtureA, changedHmrOriginalA.toString('utf8').replace('R8-A-LIVE', 'R8-A-NEW'))
      changedHmrClient.client.signalBusiness('SIGUSR2')
      await changedHmrClient.client.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
        'changed-bytes HMR ready',
        180_000,
      )
      const aApplyAfterChangedHmr = sentinelRecords(sentinel).filter(record => record.event === 'tui-apply'
        && record.package === sourceNames.a && record.pid === changedHmrPid).length
      assert(aApplyAfterChangedHmr === aApplyBeforeChangedHmr,
        'same-PID changed-bytes HMR must not import/apply A into the new revision (no phantom contribution)')
    } finally {
      writeFileSync(changedHmrFixtureA, changedHmrOriginalA)
    }
    await scene.exitC1Client(changedHmrClient.client, 'R8-E client-loader changed-bytes HMR Client')

    // RFL-006: a real connected surface must receive an actionable notice
    // when changed bytes make the package reload-required. The probe runs
    // after the physical surface is ready, so the REAL notification seam is
    // live rather than asserting only the internal observation Map.
    const noticeClient = await scene.startC1Client('R8-E client-loader reload notice Client', {
      [SENTINEL_ENV]: sentinel,
      SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_NOTICE_PROBE: '1',
      SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PACKAGES: JSON.stringify({ a: sourceNames.a, b: sourceNames.b }),
    })
    const noticeRecord = await noticeClient.client.waitFor(
      record => record.op === 'client-extension-reload-notice-probe',
      'client-extension reload notice probe',
      120_000,
    )
    assert(noticeRecord.phaseA === 'reload-required' && noticeRecord.phaseB === 'active',
      `reload notice probe must observe A reload-required and B active: ${JSON.stringify(noticeRecord)}`)
    await noticeClient.client.waitForScreen('Client reload required: /reload-client', 'real reload-required notice', 120_000)
    await scene.exitC1Client(noticeClient.client, 'R8-E client-loader reload notice Client')

    // P3-13: one REAL Host accepted Turn is held by the scripted Host model;
    // Client A exits while that Turn is in flight and Client B must observe
    // its normal settlement afterwards. This is Host work, not a Client ACK.
    await scene.openC1Session(clientB, 'R8 PR3 held turn', 'R8-E client-loader Client B')
    await waitForC1WorkEvent(
      startedHost.workRoot,
      event => event.kind === 'long-turn-held',
      'R8-E client-loader held Host Turn',
    )

    // P3-08/P3-13: Client A exits; the held Host Turn still settles on Client
    // B, whose own Footer and command path remain live, and the Host identity
    // is not replaced by a Client lifecycle event.
    await scene.exitC1Client(clientA, 'R8-E client-loader Client A')
    clientA = undefined
    writeFileSync(longTurnBarrier, 'release\n')
    await clientB.waitForScreen('long-turn answer', 'Client B held Host Turn settlement', 120_000)
    await clientB.waitForScreen('R8-A-LIVE', 'Client B footer after Client A exit', 120_000)
    clientB.send('/r8-a\r')
    await waitForSentinel(sentinel, record => record.event === 'command-call'
      && record.package === sourceNames.a && record.pid === startedB.ready.pid, 'Client B /r8-a after Client A exit')
    const hostAfter = await scene.hostIdentityFacts(host)
    assert(hostAfter.instanceId === hostIdentity.instanceId && hostAfter.hostPid === hostIdentity.hostPid,
      'Client A exit must not replace the Host process identity')

    // P3-07 second half: the SAME installed package now carries changed
    // `./tui` bytes. A NEW Client PID must load the new bytes through the real
    // `/reload-client` reexec; the old running entry stays ACTIVE until then.
    const fixtureA = join(installation.profileDir, 'node_modules', sourceNames.a, 'dist', 'tui.mjs')
    const originalFixtureA = readFileSync(fixtureA)
    const driftChunk = chunk(installation.profilePackage, 'client-bootstrap-')
    const driftChunkBytes = readFileSync(driftChunk)
    try {
      const reloadStarted = await scene.startC1Client('R8-E client-loader reload Client', {
        [SENTINEL_ENV]: sentinel,
        SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PROBE: '1',
        SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PACKAGES: JSON.stringify({ a: sourceNames.a, b: sourceNames.b }),
        SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_KEEP_BYTES: '1',
      })
      reloadClient = reloadStarted.client
      const reloadProbe = reloadClient.records.find(record => record.op === 'client-extension-loader-probe')
      assert(reloadProbe?.afterBytesA === 'reload-required' && reloadProbe?.bytesKept === true,
        `the reload Client must observe reload-required before reexec: ${JSON.stringify(reloadProbe)}`)
      writeFileSync(driftChunk, `${readFileSync(driftChunk, 'utf8')}\n// R8 PR-3 /reload-client qualification drift\n`)
      const oldPid = reloadStarted.ready.pid
      reloadClient.send('/reload-client\r')
      const reloaded = await reloadClient.waitFor(record => record.m4a0 === 'ready' && record.pid !== oldPid,
        'R8-E client-loader new-PID /reload-client', 180_000)
      assert(reloaded.pid !== oldPid, 'the real /reload-client must produce a new Client business PID')
      await reloadClient.waitForScreen('R8-A-NEW', 'the new Client PID loads changed ./tui bytes', 120_000)
    } finally {
      writeFileSync(fixtureA, originalFixtureA)
      writeFileSync(driftChunk, driftChunkBytes)
    }
    if (reloadClient !== undefined) {
      await scene.exitC1Client(reloadClient, 'R8-E client-loader reload Client')
      reloadClient = undefined
    }

    trace('r8epr3.client-loader', {
      hostPid: hostIdentity.hostPid,
      clientA: startedA.ready.pid,
      clientB: startedB.ready.pid,
      packages: [sourceNames.a, sourceNames.b, sourceNames.dual],
      plainNegative: true,
    })
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: hostIdentity.hostPid,
      clientPidA: startedA.ready.pid,
      clientPidB: startedB.ready.pid,
      packageA: sourceNames.a,
      packageB: sourceNames.b,
      packageDual: sourceNames.dual,
      footerA: true,
      footerB: true,
      footerDual: true,
      commandA: true,
      commandB: true,
      commandDual: true,
      clientAExitKeptB: true,
      hostIdentityKept: true,
      heldHostTurnSettled: true,
    }
  } finally {
    try { if (reloadClient !== undefined) await scene.exitC1Client(reloadClient, 'R8-E client-loader reload Client') } catch { /* process backstop */ }
    try { if (clientA !== undefined) await scene.exitC1Client(clientA, 'R8-E client-loader Client A') } catch { /* process backstop */ }
    try { if (clientB !== undefined) await scene.exitC1Client(clientB, 'R8-E client-loader Client B') } catch { /* process backstop */ }
    try { if (host !== undefined) await scene.stopC1Host(host) } catch { /* process backstop */ }
    try { await scene.dispose() } catch { /* process backstop */ }
    for (const name of installed.reverse()) {
      const removal = runDsh(installation.dshInvocation, ['plugin', '--profile', PROFILE, 'remove', name], context.workDir, installation.env)
      assert(removal.status === 0, `removing fixture ${name} from the shared qualification profile failed: ${removal.stderr ?? ''}`)
    }
  }
}
