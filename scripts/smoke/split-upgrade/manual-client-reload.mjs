/**
 * `client-reload.production-command`: the production `/reload-client` command
 * over a real PTY, plus its destructive target-invalid round.
 *
 * The positive round owns two real PTY Clients on ONE old Host/Session: the
 * command must resolve the PROFILE-installed replacement, reexec the old Client
 * into a new OS PID running the new build, and keep the second Client's PID,
 * root fiber, generation, surface revision and Session untouched through the
 * held Turn. The second round removes the installed package through the official
 * `dsh plugin remove` transaction and proves the painted target-invalid refusal
 * keeps the live Host, Turn and registry/launch bytes.
 *
 * @module smoke/split-upgrade/manual-client-reload
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { installPlugin, isolatedEnvironment, runDsh } from '../../pi2dsh-compat-smoke.mjs'
import { hostSessionEvents, waitForHostSessionEvent, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { writeC1WorkFixture } from '../../lib/split-smoke-fixtures.mjs'
import { SplitSmokeWaitError } from '../../lib/split-smoke-diagnostics.mjs'
import {
  EXPECTED_PACKAGE_NAME,
  assert,
  assertDeepEqual,
  assertEqual,
  assertIdentityKept,
  assertNoSecret,
  assertNotEqual,
  alive,
  assertProfileClientPeers,
  c1WorkHadRelease,
  hostStatus,
  installSideBuild,
  killProcessGroup,
  productionBuildId,
  readJson,
  readProcessStarttime,
  safeIdentity,
  scopeDirOf,
  seatIsFree,
  sessionLogFiles,
  stopHostForCleanup,
  waitForAcceptedHandoff,
  waitForReloadNotice,
  waitForUpgradeC1WorkEvent,
  waitGone,
} from '../../lib/split-upgrade-support.mjs'

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** The minimal real PNG the attachment negative stages through `/image`. */
function writeReloadProbePng(path) {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(800, 16)
  bytes.writeUInt32BE(100, 20)
  writeFileSync(path, bytes, { mode: 0o600 })
}

/**
 * Wait until the REAL painted composer no longer contains `needle`. This is an
 * authoritative editor-state read (the same painter the user sees), so the U08
 * attachment negative never races a slow PTY with a fixed delay: the command is
 * submitted only after the placeholder is provably gone from the composer.
 */
async function waitForClearedComposer(client, needle, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const viewport = await client.viewport()
    const separators = []
    for (let index = 0; index < viewport.length; index += 1) {
      if (/^─+$/u.test(viewport[index].trim())) separators.push(index)
    }
    if (separators.length > 0) {
      // The input box is drawn between its top and bottom rule; use the
      // SECOND-TO-LAST rule so the footer rule below it is not mistaken for
      // the box top (the harness's own composer read).
      const top = separators.length >= 2 ? separators[separators.length - 2] : separators[separators.length - 1]
      const bottom = separators.length >= 2 ? separators[separators.length - 1] : viewport.length
      const composer = viewport.slice(top + 1, bottom).join('\n')
      if (composer.includes('❯') && !composer.includes(needle)) return
    }
    if (client.exited) {
      throw new SplitSmokeWaitError('PROCESS_EXITED', {
        code: 'PROCESS_EXITED_BEFORE_COMPOSER',
        waitLabel: label,
        processRole: client.role,
        process: client,
      })
    }
    await sleep(50)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'COMPOSER_CLEAR_TIMEOUT',
    waitLabel: label,
    processRole: client.role,
    elapsedMs: Date.now() - started,
    process: client,
  })
}

/**
 * Run both `/reload-client` rounds with ONE case-local process ownership
 * boundary. `failpoint` fires after the first round's old Host is Ready.
 */
export async function runManualClientReload(context) {
  const hosts = []
  const clients = []
  // Every context field MUST reach the round functions: the extracted rounds
  // create real `EntryProcess`/`SurfaceEntryProcess` instances, so a narrower
  // ad-hoc scope would turn them into free variables at run time.
  const scope = { ...context, hosts, clients }
  try {
    const userCommandReload = await runUserCommandReloadRound(scope)
    const userCommandReloadTargetInvalid = await runUnavailableTargetRound(scope)
    return { userCommandReload, userCommandReloadTargetInvalid }
  } finally {
    for (const client of clients) {
      try { await client.dispose?.() } catch { /* best effort */ }
    }
    for (const host of hosts) {
      await stopHostForCleanup(host).catch(() => undefined)
      killProcessGroup(host)
    }
  }
}

async function runUserCommandReloadRound(context) {
  const {
    EntryProcess, SurfaceEntryProcess,
    dsh, harnessDir, anchor, targetDshVersion, oldArtifact, newArtifact, workRoot,
    checkpoint, failpoint, registerIsolatedHome, hosts, clients,
  } = context
  const roundRoot = join(workRoot, 'u08')
  const home = join(roundRoot, 'home')
  const dshHome = join(roundRoot, 'dsh-home')
  const envWork = join(roundRoot, 'env')
  const fixtureDir = join(roundRoot, 'fixture')
  const c1WorkRoot = join(roundRoot, 'c1-work')
  const scratch = join(roundRoot, 'scratch')
  registerIsolatedHome(dshHome)
  for (const directory of [home, dshHome, envWork, fixtureDir, c1WorkRoot, scratch]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(envWork, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(envWork, home, dshHome, join(roundRoot, 'evidence.json'))
  
  // ── The old profile owns the real old installation (official install) ────
  const profileDir = join(dshHome, 'profiles', 'pi-tui')
  installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
  installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
  installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
  installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
  assertProfileClientPeers(profileDir, targetDshVersion, 'U08 old profile install')
  const profileOldPackage = realpathSync(join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME))
  const oldBuildId = productionBuildId(profileOldPackage, targetDshVersion)
  assert(oldArtifact.manifest.version === readJson(join(profileOldPackage, 'package.json')).version,
    'U08 the old profile install carries another package version')
  // The old Client keeps RUNNING across the in-place profile upgrade, so its
  // own real installation lives side-by-side (the SAME old artifact through an
  // official pnpm transaction — never a hand-written payload and never the
  // qualification target override).
  const sideOldPackage = installSideBuild(join(dshHome, 'profiles', 'u08-side-old'), oldArtifact.path, env, targetDshVersion)
  assertEqual(productionBuildId(sideOldPackage, targetDshVersion), oldBuildId,
    'U08 the side-by-side old installation produced another buildId')

  const work = writeC1WorkFixture(profileDir, fixtureDir)
  const releaseBarrier = join(roundRoot, 'long-turn.release')
  const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
  const hostBase = {
    ...base,
    env: {
      ...base.env,
      SPLIT_PROCESS_EXTRA_PATCH: work.patchPath,
      C1_SCENARIO: 'long-turn',
      C1_HOLD_LONG_TURN: releaseBarrier,
      C1_WORK_ROOT: c1WorkRoot,
    },
  }

  // ── Old Host (side-by-side old build) + connected old Client + held Turn ──
  const host = new EntryProcess('host-u08', join(sideOldPackage, 'dist', 'local-host.mjs'), hostBase)
  hosts.push(host)
  const hostReady = await host.waitFor(record => record.m4a0 === 'ready', 'U08 Host ready', 240_000)
  assertEqual(hostReady.localHost.buildId, oldBuildId, 'U08 Host did not publish the old production buildId')
  const hostIdentity = safeIdentity(hostReady.localHost)
  failpoint('client-reload.production-command.after-host-spawn')
  const scopeDir = scopeDirOf(dshHome, hostIdentity.scopeId)
  const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
  const launchBefore = readFileSync(join(scopeDir, 'launch.json'))

  const reloadOldClient = new SurfaceEntryProcess(join(sideOldPackage, 'dist', 'local-client.mjs'), {
    ...base,
    workDir: roundRoot,
  })
  clients.push(reloadOldClient)
  await reloadOldClient.waitFor(record => record.m4a0 === 'ready', 'U08 old Client ready', 240_000)
  const reloadOldClientReady = reloadOldClient.records.find(record => record.m4a0 === 'ready')
  const reloadOldClientPid = reloadOldClientReady?.pid
  assert(Number.isInteger(reloadOldClientPid), 'U08 old Client ready record has no business PID')
  const holdPrompt = 'u08-reload-client-hold'
  reloadOldClient.send(`${holdPrompt}\r`)
  await reloadOldClient.waitForScreen(holdPrompt, 'U08 old Client painted the admitted prompt', 120_000)
  const sessionStatus = await reloadOldClient.waitFor(
    record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
    'U08 old Client open Session',
    120_000,
  )
  const sessionId = sessionStatus.openSessionId
  const held = await waitForUpgradeC1WorkEvent(c1WorkRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'U08 Host Turn held')
  assertEqual(held.agentStatus, 'running', 'U08 Host Turn is not running while held')
  await reloadOldClient.waitFor(
    record => record.m4a0 === 'ready' && record.transport === 'connected',
    'U08 old Client connected transport',
    60_000,
  )
  assert(alive(reloadOldClientPid), 'U08 old Client is not a live process')
  assert(alive(hostIdentity.hostPid), 'U08 Host died while the old Client attached')

  const assertOldSurfaceKept = async (label) => {
    assert(alive(reloadOldClientPid), `${label}: the old Client PID died`)
    assertEqual(reloadOldClient.records.filter(record => record.m4r === 'handoff-requested').length, 0,
      `${label}: a reload request reached the process sink`)
    assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity, `${label}: Host identity`)
    assert(alive(hostIdentity.hostPid), `${label}: the Host died`)
    assert(!c1WorkHadRelease(c1WorkRoot), `${label}: the admitted Turn was released`)
    assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), `${label}: the registry bytes changed`)
    assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), `${label}: the launch bytes changed`)
  }

  // ── U08 negative 1: same installed build → already-current, no stop ──────
  checkpoint('U08/negative-already-current')
  // The record boundary is captured BEFORE the command: a refusal left by an
  // earlier action must never be attributed to this one.
  const alreadyCurrentFrom = reloadOldClient.records.length
  reloadOldClient.send('/reload-client\r')
  await waitForReloadNotice(reloadOldClient, 'Client reload skipped: this Client already runs the installed build.',
    'U08 already-current notice', alreadyCurrentFrom)
  await assertOldSurfaceKept('U08 already-current')

  // ── U08 negative 2: a staged, unreferenced image blocks the reload ───────
  checkpoint('U08/negative-attachments')
  const imagePath = join(roundRoot, 'u08-staged.png')
  writeReloadProbePng(imagePath)
  reloadOldClient.send(`/image ${imagePath}\r`)
  await reloadOldClient.waitForScreen('attached [image', 'U08 staged image notice', 120_000)
  // Remove the placeholder text ONLY: the staged image stays in the real draft
  // store (the pinned/unreferenced case the safety gate must not miss). The
  // removal is awaited through the REAL painted composer (an authoritative
  // editor state), never a fixed delay: a slow PTY could otherwise still hold
  // the placeholder when the command is submitted and the negative would become
  // a draft-text refusal instead.
  reloadOldClient.send('\x7f'.repeat(200))
  await waitForClearedComposer(reloadOldClient, '[image #', 'U08 staged placeholder cleared')
  const attachmentsFrom = reloadOldClient.records.length
  reloadOldClient.send('/reload-client\r')
  await waitForReloadNotice(reloadOldClient, 'Client reload blocked: remove or submit the staged attachments first.',
    'U08 attachments refusal', attachmentsFrom)
  await assertOldSurfaceKept('U08 attachments refusal')

  checkpoint('U08/upgrade-install')
  // ── The official in-place profile upgrade to the new candidate ───────────
  // The old Client keeps running from its own real old installation; the
  // production command must resolve the NEW profile package, WITHOUT the
  // qualification target override.
  installPlugin(dsh, newArtifact.path, harnessDir, env, false)
  assertProfileClientPeers(profileDir, targetDshVersion, 'U08 upgraded profile install')
  const profileNewPackage = realpathSync(join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME))
  const newBuildId = productionBuildId(profileNewPackage, targetDshVersion)
  assertEqual(readJson(join(profileNewPackage, 'package.json')).version, newArtifact.manifest.version)
  assertNotEqual(newBuildId, oldBuildId, 'U08 the official upgrade did not change the production buildId')

  // Close the old Client (its in-memory staged image dies with it) and attach a
  // fresh old-build Client to the SAME Host/Session for the positive command.
  reloadOldClient.send('/exit\r')
  const reloadOldClientExit = await reloadOldClient.waitForExit(120_000)
  assertEqual(reloadOldClientExit.code, 0, `U08 old Client exit was ${JSON.stringify(reloadOldClientExit)}`)
  await reloadOldClient.dispose()
  assert(alive(hostIdentity.hostPid), 'U08 Host died when the old Client exited')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U08 the admitted Turn was released by the old Client exit')
  const sessionLogsBeforeReload = sessionLogFiles(dshHome)

  const reloadClient = new SurfaceEntryProcess(join(sideOldPackage, 'dist', 'local-client.mjs'), {
    ...base,
    workDir: roundRoot,
    env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
  })
  clients.push(reloadClient)
  await reloadClient.waitFor(record => record.m4a0 === 'ready', 'U08 old-build reload Client ready', 240_000)
  const reloadClientReady = reloadClient.records.find(record => record.m4a0 === 'ready')
  const reloadClientPid = reloadClientReady?.pid
  assert(Number.isInteger(reloadClientPid), 'U08 old-build reload Client ready record has no business PID')
  await reloadClient.waitFor(
    record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
    'U08 old-build reload Client opened the running Session',
    120_000,
  )
  await reloadClient.waitForScreen(holdPrompt, 'U08 old-build reload Client painted the admitted prompt', 120_000)
  assertEqual(reloadClient.records.filter(record => record.m4r === 'handoff-requested').length, 0,
    'U08 reload Client reloaded before the user command')

  // ── U08 dual-TUI: the SECOND old-build Client keeps the SAME Session X ────
  // B is a real `dist/local-client.mjs` instance of the OLD installed build
  // (the side-by-side real installation the old Client already runs), on its
  // own `script(1)` wrapper/PTY and its own official Client Context. It joins
  // X through the real startup intent BEFORE A's `/reload-client` gesture, so
  // every replacement/exit/release below has an independent live witness.
  const peerClient = new SurfaceEntryProcess(join(sideOldPackage, 'dist', 'local-client.mjs'), {
    ...base,
    workDir: roundRoot,
    env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
  })
  clients.push(peerClient)
  const peerReady = await peerClient.waitFor(record => record.m4a0 === 'ready', 'U08 second old-build Client ready', 240_000)
  const peerPid = peerReady.pid
  assert(Number.isInteger(peerPid) && peerPid > 0, 'U08 the second old-build Client ready record has no business PID')
  assertNotEqual(peerPid, reloadClientPid, 'U08 the second old-build Client reuses the first Client PID')
  assertNotEqual(peerClient.child.pid, reloadClient.child.pid,
    'U08 the second old-build Client reuses the first script(1) wrapper')
  const peerStatus = await peerClient.waitFor(
    record => record.m4b2s === 'surface-status' && record.sessionOpen === true
      && record.openSessionId === sessionId && record.transport === 'connected'
      && record.surfaceMounted === true,
    'U08 second old-build Client retained the SAME Session X',
    120_000,
  )
  assertIdentityKept(peerStatus.host, hostIdentity, 'U08 second Client authenticated Host')
  await peerClient.waitForScreen(holdPrompt, 'U08 second old-build Client painted the admitted prompt', 120_000)
  const peerBoundary = peerClient.records.length
  const peerStatusBefore = peerClient.records.filter(record => record.m4b2s === 'surface-status').at(-1)
  assert(peerStatusBefore !== undefined, 'U08 the second old-build Client published no status boundary')
  /** The second Client is untouched by EVERYTHING the reexec does to A. */
  const assertPeerKept = (label) => {
    assert(alive(peerPid), `${label}: the second old-build Client died`)
    // Read the complete record tail first: the 25ms poller must not decide
    // this witness from a stale snapshot.
    peerClient.readRecords()
    for (const record of peerClient.records.slice(peerBoundary).filter(entry => entry.m4b2s === 'surface-status')) {
      assertEqual(record.pid, peerPid, `${label}: the second Client PID changed`)
      assertEqual(record.rootFiberUid, peerStatusBefore.rootFiberUid, `${label}: the second Client root fiber changed`)
      assertEqual(record.generationId, peerStatusBefore.generationId,
        `${label}: the second Client transport generation changed`)
      assertEqual(record.surfaceRevision, peerStatusBefore.surfaceRevision,
        `${label}: the second Client surface revision changed`)
      assertEqual(record.sessionOpen, true, `${label}: the second Client lost its open Session`)
      assertEqual(record.openSessionId, sessionId, `${label}: the second Client Session changed`)
      assertEqual(record.transport, 'connected', `${label}: the second Client transport disconnected`)
      assertEqual(record.surfaceMounted, true, `${label}: the second Client lost its mounted surface`)
      assertEqual(record.host?.instanceId, hostIdentity.instanceId, `${label}: the second Client Host instance changed`)
    }
    assert(peerClient.records.slice(peerBoundary).every(record => record.m4b2s !== 'client-closed'),
      `${label}: the second Client released its own resources`)
  }

  checkpoint('U08/dual-client-joined')

  checkpoint('U08/positive-reexec')
  // ── U08 positive: the PRODUCTION `/reload-client` command drives the SAME
  //    production reexec/handoff chain into the newly installed build ──────
  const reloadRequestFrom = reloadClient.records.length
  reloadClient.send('/reload-client\r')
  const reloadRequested = await waitForAcceptedHandoff(
    reloadClient, reloadClientPid, 'U08 production command accepted the reload', reloadRequestFrom,
  )
  assertEqual(reloadRequested.sessionId, sessionId, 'U08 the command captured another Session')
  assertEqual(reloadRequested.expectedHostInstanceId, hostIdentity.instanceId, 'U08 the command captured another Host')
  assertEqual(reloadRequested.targetBuildId, newBuildId, 'U08 the command resolved another target build')
  assertEqual(reloadRequested.targetBundleVersion, newArtifact.manifest.version,
    'U08 the command resolved another target bundle version')
  const reloadClientClosed = await reloadClient.waitFor(
    record => record.m4b2s === 'client-closed' && record.pid === reloadClientPid,
    'U08 old-build reload Client released every owned Client resource',
    120_000,
  )
  assertEqual(reloadClientClosed.sessionOpen, false, 'U08 reload Client still reported an open Session after its release')
  assertEqual(reloadClientClosed.surfaceMounted, false, 'U08 reload Client still reported a mounted surface after its release')
  assertDeepEqual(reloadClientClosed.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 },
    'U08 reload Client still owned Client services after its release')
  // The old Client completed its OWN release; the second Client is untouched
  // by that release and still holds the running Session X.
  assertPeerKept('U08 after the old Client released')
  await peerClient.waitForScreen(holdPrompt, 'U08 second Client still paints Session X after the release', 60_000)
  const replacementStarted = await reloadClient.waitFor(
    record => record.m4a0 === 'client-started' && record.pid !== reloadClientPid,
    'U08 the replacement Client started as a new OS process',
    120_000,
  )
  const replacementPid = replacementStarted.pid
  assert(Number.isInteger(replacementPid) && replacementPid !== reloadClientPid, 'U08 the replacement Client has no new OS PID')
  assert(alive(reloadClientPid), 'U08 the old Client parent exited before its replacement finished')
  const replacementAuth = await reloadClient.waitFor(
    record => record.m4a0 === 'host-authenticated' && record.pid === replacementPid,
    'U08 the replacement Client authenticated the SAME Host',
    180_000,
  )
  assertIdentityKept(replacementAuth.host, hostIdentity, 'U08 replacement Client authenticated Host')
  const replacementRestored = await reloadClient.waitFor(
    record => record.m4r === 'handoff-restored' && record.pid === replacementPid,
    'U08 the replacement Client restored the original Session',
    180_000,
  )
  assertEqual(replacementRestored.expectedHostInstanceId, hostIdentity.instanceId)
  assertEqual(replacementRestored.hostInstanceId, hostIdentity.instanceId)
  assertEqual(replacementRestored.sessionId, sessionId)
  assertEqual(replacementRestored.sessionOpen, true)
  assertEqual(replacementRestored.sessionHistoryOpen, true)
  assertEqual(replacementRestored.surfaceMounted, true)
  assertEqual(replacementRestored.transport, 'connected')
  assertEqual(replacementRestored.clientBuildId, newBuildId, 'U08 the replacement Client does not run the new build')
  assertNotEqual(replacementRestored.clientBuildId, oldBuildId, 'U08 the replacement Client re-ran the old build')
  const replacementReady = await reloadClient.waitFor(
    record => record.m4a0 === 'ready' && record.pid === replacementPid,
    'U08 the replacement Client ready',
    120_000,
  )
  assertEqual(replacementReady.transport, 'connected')
  assertEqual(replacementReady.host?.instanceId, hostIdentity.instanceId)
  assertEqual(replacementReady.sessionOpen, true)
  assertEqual(replacementReady.openSessionId, sessionId)
  await reloadClient.waitForScreen(holdPrompt, 'U08 the replacement surface painted the admitted prompt', 120_000)
  // A' is alive and restored the SAME Session/history — this does NOT claim it
  // observed the held Turn's later completion (the original Turn is still
  // held). The second Client must be completely untouched by the reexec.
  assertPeerKept('U08 after the replacement restored Session X')
  await peerClient.waitForScreen(holdPrompt, 'U08 second Client still paints Session X after the replacement', 60_000)
  assert(alive(hostIdentity.hostPid), 'U08 the Host died during the command reload')
  assert(readProcessStarttime(hostIdentity.hostPid) === hostIdentity.hostStarttime,
    'U08 the Host starttime changed during the command reload')
  assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity, 'U08 Host after the command reload')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U08 the command reload released the admitted Turn')
  assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
    'U08 the command reload mutated the registry')
  assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
    'U08 the command reload mutated the launch material')
  assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeReload,
    'U08 the command reload created a new Session log')
  const promptsAfterReload = (hostSessionEvents(dshHome, sessionId) ?? [])
    .filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && JSON.stringify(event.data?.content ?? []).includes(holdPrompt))
  assertEqual(promptsAfterReload.length, 1, 'U08 the command reload replayed or duplicated the admitted prompt')
  // A' restored the SAME Session/history, but the original Turn is STILL held:
  // the durable log has no settlement yet. A' being ready is not a claim that
  // it observed the held Turn's later completion.
  assert((hostSessionEvents(dshHome, sessionId) ?? []).every(event => event.type !== 'turn/end'),
    'U08 the replacement ready observed a turn/end before the original barrier release')

  const replacementExit = await (async () => {
    reloadClient.send('/exit\r')
    return await reloadClient.waitForExit(120_000)
  })()
  assertEqual(replacementExit.code, 0, `U08 replacement Client exit was ${JSON.stringify(replacementExit)}`)
  assert(await waitGone(replacementPid), 'U08 the replacement Client process did not exit')
  assert(await waitGone(reloadClientPid), 'U08 the old Client waiting parent did not exit')
  const replacementClosed = await reloadClient.waitFor(
    record => record.m4b2s === 'client-closed' && record.pid === replacementPid,
    'U08 the replacement Client released every owned Client resource',
    120_000,
  )
  assertEqual(replacementClosed.sessionOpen, false,
    'U08 the replacement Client still reported an open Session after its release')
  assertEqual(replacementClosed.surfaceMounted, false,
    'U08 the replacement Client still reported a mounted surface after its release')
  assertDeepEqual(replacementClosed.owners,
    { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 },
    'U08 the replacement Client still owned Client services after its release')
  assert(alive(hostIdentity.hostPid), 'U08 the Host died when the replacement Client exited')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U08 the admitted Turn was released by the Client exit')
  // The ORIGINAL Host Turn is STILL held: neither A's release nor A' exit may
  // cancel it, and the second Client still owns its own live Session X.
  assertPeerKept('U08 after the replacement exited with the original Turn still held')
  await peerClient.waitForScreen(holdPrompt,
    'U08 second Client still holds Session X after the replacement exit', 60_000)

  // Complete the admitted work and stop the Host through its own owner path.
  writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
  await waitForUpgradeC1WorkEvent(c1WorkRoot, event => event.kind === 'long-turn-released' && event.sessionId === sessionId, 'U08 Host Turn completes')
  await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'U08 Host turn/end')
  // The SECOND Client — alive through the whole cross-build A -> A' handoff
  // and A' exit — now reads the ORIGINAL Turn's Host settlement on its own
  // current PTY and writes the SAME Session again exactly once.
  await peerClient.waitForScreen('long-turn answer 1', 'U08 second Client read the original Turn settlement', 120_000)
  const peerPrompt = 'u08-b-after-reload'
  const peerWriteIndex = (hostSessionEvents(dshHome, sessionId) ?? []).length
  peerClient.send(peerPrompt)
  await peerClient.waitForComposerDraft(peerPrompt)
  peerClient.send('\r')
  await waitForHostSessionEventAfter(dshHome, sessionId, peerWriteIndex,
    event => event.type === 'user/message' && JSON.stringify(event.data?.content ?? []).includes(peerPrompt),
    'U08 second Client committed after the reload', 120_000)
  await waitForHostSessionEventAfter(dshHome, sessionId, peerWriteIndex,
    event => event.type === 'turn/end', 'U08 second Client Turn settled', 120_000)
  const peerPrompts = (hostSessionEvents(dshHome, sessionId) ?? [])
    .filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && JSON.stringify(event.data?.content ?? []).includes(peerPrompt))
  assertEqual(peerPrompts.length, 1, 'U08 the second Client prompt committed more than once')
  // The final scan covers the WHOLE post-release window too: the second
  // Client's identity/currentness must hold after its own write, not only at
  // the earlier handoff checkpoints.
  assertPeerKept('U08 after the second Client wrote the same Session')
  const peerExit = await (async () => {
    peerClient.send('/exit\r')
    return await peerClient.waitForExit(120_000)
  })()
  assertEqual(peerExit.code, 0, `U08 second Client exit was ${JSON.stringify(peerExit)}`)
  const peerClosed = await peerClient.waitFor(
    record => record.m4b2s === 'client-closed' && record.pid === peerPid,
    'U08 second Client released every owned Client resource',
    120_000,
  )
  assertEqual(peerClosed.sessionOpen, false, 'U08 the second Client still reported an open Session after its release')
  assertEqual(peerClosed.surfaceMounted, false, 'U08 the second Client still reported a mounted surface after its release')
  assertDeepEqual(peerClosed.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 },
    'U08 the second Client still owned Client services after its release')
  assert(await waitGone(peerPid), 'U08 the second old-build Client process did not exit')
  await peerClient.dispose()
  assert(alive(hostIdentity.hostPid), 'U08 the Host died when the second Client exited')
  assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity,
    'U08 Host after the second Client exit')
  host.child.stdin.end()
  assert(readProcessStarttime(hostIdentity.hostPid) === hostIdentity.hostStarttime,
    'U08 the Host stop target starttime no longer matches')
  process.kill(hostIdentity.hostPid, 'SIGTERM')
  const hostStop = await host.waitFor(record => record.m4a0 === 'stop-requested', 'U08 Host stop-requested', 60_000)
  assertEqual(hostStop.signal, 'SIGTERM')
  const hostCleanup = await host.waitFor(
    record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure',
    'U08 Host cleanup',
    120_000,
  )
  assertEqual(hostCleanup.m4a0, 'cleanup', `U08 Host cleanup was ${JSON.stringify(hostCleanup)}`)
  assertEqual(hostCleanup.status, 'completed')
  const hostExit = await host.waitForExit(120_000)
  assertEqual(hostExit.code, 0, `U08 Host stop exit was ${JSON.stringify(hostExit)}`)
  assert(await seatIsFree(`\0dsh-pi-tui-h-${hostIdentity.scopeId.slice(0, 40)}`), 'U08 the Host seat stayed owned')

  return {
    oldClientPid: reloadOldClientPid,
    reloadCommandClientPid: reloadClientPid,
    replacementClientPid: replacementPid,
    oldBuildId,
    newBuildId,
    newBundleVersion: newArtifact.manifest.version,
    oldBundleVersion: oldArtifact.manifest.version,
    productionTargetResolvedFromProfile: true,
    qualificationTargetOverrideUsed: false,
    alreadyCurrentRefused: true,
    alreadyCurrentKeptOldSurface: true,
    attachmentsRefused: true,
    attachmentsKeptOldSurface: true,
    handoffRequestedByUserCommand: true,
    oldClientOwnersReleased: true,
    replacementClientNewPid: replacementPid !== reloadClientPid,
    replacementClientNewBuild: replacementRestored.clientBuildId === newBuildId,
    hostIdentityKept: true,
    hostStarttimeKept: true,
    sessionId,
    sessionHistoryOpen: true,
    surfacePromptVisible: true,
    registryBytesUnchanged: true,
    launchBytesUnchanged: true,
    noNewSessionLog: true,
    promptNotReplayed: true,
    turnHeldAcrossReload: true,
    secondClientPid: peerPid,
    secondClientBuildId: oldBuildId,
    secondClientBoundaryRecords: peerBoundary,
    secondClientIdentityKept: true,
    secondClientSessionKept: true,
    secondClientReadOriginalTurn: true,
    secondClientIndependentWrite: true,
    secondClientOwnersReleased: true,
    replacementOwnersReleased: true,
    turnHeldWhileReplacementExited: true,
    exitCode: replacementExit.code,
    secondClientExitCode: peerExit.code,
    hostStopExitCode: hostExit.code,
  }
}

async function runUnavailableTargetRound(context) {
  const {
    EntryProcess, SurfaceEntryProcess,
    dsh, harnessDir, anchor, targetDshVersion, oldArtifact, workRoot,
    checkpoint, failpoint, registerIsolatedHome, hosts, clients,
  } = context
  const roundRoot = join(workRoot, 'u08-target')
  const home = join(roundRoot, 'home')
  const dshHome = join(roundRoot, 'dsh-home')
  const envWork = join(roundRoot, 'env')
  const fixtureDir = join(roundRoot, 'fixture')
  const c1WorkRoot = join(roundRoot, 'c1-work')
  const scratch = join(roundRoot, 'scratch')
  registerIsolatedHome(dshHome)
  for (const directory of [home, dshHome, envWork, fixtureDir, c1WorkRoot, scratch]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(envWork, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(envWork, home, dshHome, join(roundRoot, 'evidence.json'))
  
  const profileDir = join(dshHome, 'profiles', 'pi-tui')
  installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
  installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
  installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
  installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
  assertProfileClientPeers(profileDir, targetDshVersion, 'U08 target-invalid profile install')
  const profilePackage = realpathSync(join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME))

  const work = writeC1WorkFixture(profileDir, fixtureDir)
  const releaseBarrier = join(roundRoot, 'long-turn.release')
  const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
  const hostBase = {
    ...base,
    env: {
      ...base.env,
      SPLIT_PROCESS_EXTRA_PATCH: work.patchPath,
      C1_SCENARIO: 'long-turn',
      C1_HOLD_LONG_TURN: releaseBarrier,
      C1_WORK_ROOT: c1WorkRoot,
    },
  }
  const host = new EntryProcess('host-u08-target', join(profilePackage, 'dist', 'local-host.mjs'), hostBase)
  hosts.push(host)
  const hostReady = await host.waitFor(record => record.m4a0 === 'ready', 'U08 target-invalid Host ready', 240_000)
  const hostIdentity = safeIdentity(hostReady.localHost)
  const scopeDir = scopeDirOf(dshHome, hostIdentity.scopeId)
  const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
  const launchBefore = readFileSync(join(scopeDir, 'launch.json'))

  const client = new SurfaceEntryProcess(join(profilePackage, 'dist', 'local-client.mjs'), { ...base, workDir: roundRoot })
  clients.push(client)
  await client.waitFor(record => record.m4a0 === 'ready', 'U08 target-invalid Client ready', 240_000)
  const clientPid = client.records.find(record => record.m4a0 === 'ready')?.pid
  assert(Number.isInteger(clientPid), 'U08 target-invalid Client ready record has no business PID')
  const holdPrompt = 'u08-target-invalid-hold'
  client.send(`${holdPrompt}\r`)
  await client.waitForScreen(holdPrompt, 'U08 target-invalid Client painted the admitted prompt', 120_000)
  const sessionStatus = await client.waitFor(
    record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
    'U08 target-invalid Client open Session',
    120_000,
  )
  const sessionId = sessionStatus.openSessionId
  await waitForUpgradeC1WorkEvent(c1WorkRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'U08 target-invalid Turn held')

  // The official DSH transaction removes the PROFILE-installed bundle while
  // the Client/Host runtimes (already loaded) keep their modules.
  const removal = runDsh(dsh, ['plugin', '--profile', 'pi-tui', 'remove', EXPECTED_PACKAGE_NAME], harnessDir, env)
  assertEqual(removal.status, 0, `U08 the official package removal failed: ${removal.stderr ?? ''}`)
  assert(!existsSync(join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)),
    'U08 the official removal left the installed package behind')
  checkpoint('U08/negative-target-invalid')
  const targetInvalidFrom = client.records.length
  client.send('/reload-client\r')
  await waitForReloadNotice(client, 'Client reload failed: the installed replacement Client is unavailable or incompatible.',
    'U08 target-invalid notice', targetInvalidFrom)
  assertEqual(client.records.filter(record => record.m4r === 'handoff-requested').length, 0,
    'U08 the target-invalid refusal reached the process stop sink')
  assert(alive(clientPid), 'U08 the target-invalid refusal killed the live Client')
  assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity, 'U08 Host after the target-invalid refusal')
  assert(alive(hostIdentity.hostPid), 'U08 the Host died on the target-invalid refusal')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U08 the target-invalid refusal released the admitted Turn')
  assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
    'U08 the target-invalid refusal mutated the registry')
  assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
    'U08 the target-invalid refusal mutated the launch material')

  // This round is destructive for its own profile: end it directly (a graceful
  // Host stop is not what this negative qualifies).
  await client.dispose().catch(() => undefined)
  killProcessGroup(host)
  await host.waitForExit(30_000).catch(() => undefined)

  return {
    installedTargetOfficiallyRemoved: true,
    targetInvalidRefused: true,
    targetInvalidKeptOldSurface: true,
    noReloadRequestReachedSink: true,
    clientAliveAfterRefusal: true,
    hostIdentityKept: true,
    hostAliveAfterRefusal: true,
    registryBytesUnchanged: true,
    launchBytesUnchanged: true,
    sessionId,
    turnHeldAcrossRefusal: true,
    qualificationTargetOverrideUsed: false,
  }
}
