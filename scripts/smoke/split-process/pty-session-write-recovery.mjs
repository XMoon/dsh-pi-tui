/**
 * Real-surface qualification (T27-T43 + T61): ONE dedicated Host with the
 * test-only offline LLM row, driven by REAL `script(1)` surface Clients over
 * the authenticated transport.
 *
 * The case proves what only a physical surface can: the sessionless Welcome,
 * a real input -> official beginSubmission -> Host durable commit -> painted
 * answer round trip, a second concurrent Client on its own PTY with its own
 * Workspace, Session switch/resume, the writer/ACK-drop/serializer/HUP/signal
 * and stale-generation fences, private PiFile/terminal-progress business
 * reads, and the missing-Client-Domain refusal. `waitForHostSessionEventAfter`
 * keeps every durable claim anchored to an after-index, and T40 re-verifies
 * the original candidate bytes at the end.
 *
 * @module split-process/pty-session-write-recovery
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostSessionLogCount,
  hostUserTexts,
  sha16,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import {
  alive,
  assertClientHostFacts,
  lastSurfaceStatus,
  readJson,
  seatFree,
} from '../../lib/split-smoke-processes.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Drive the complete real-surface qualification on this run's installation.
 *
 * The case owns its Host and every surface Client; its `finally` disposes them
 * and its success path proves the owner-governed shutdown released the Host,
 * its registry and the kernel seat.
 */
export async function runPtySessionWriteRecovery(context) {
  const {
    EntryProcess,
    SurfaceEntryProcess,
    entries,
    base,
    workDir,
    dshHome,
    installation,
    tarball,
    candidateSha256,
    targetDshVersion,
    trace,
    failpoint,
    mode,
  } = context
  const { anchor, home, profileDir } = installation
  const clientWorkspaceA = join(workDir, 'ws2-client-workspace-A')
  const clientWorkspaceC = join(workDir, 'ws2-client-workspace-C')
  // T09: the SECOND concurrently admitted real Surface Client gets its OWN
  // launch directory (B), so its Host Workspace is a different registered
  // path. Never reuse the WS-2 sequential Client C workspace: that would
  // change the persisted membership the later C scenario proves.
  const m5aWorkspaceB = join(workDir, 'm5a-client-workspace-B')
  mkdirSync(clientWorkspaceA, { recursive: true })
  mkdirSync(clientWorkspaceC, { recursive: true })
  mkdirSync(m5aWorkspaceB, { recursive: true })
  const canonicalClientWorkspaceA = realpathSync(clientWorkspaceA)
  const canonicalClientWorkspaceC = realpathSync(clientWorkspaceC)
  const canonicalM5aWorkspaceB = realpathSync(m5aWorkspaceB)
  // The SAME-NAMED marker in the Host Profile B carries different content: the
  // Host read must answer A's marker, never B's.
  writeFileSync(join(clientWorkspaceA, 'ws2-host-marker.txt'), 'client-workspace-A\n', { mode: 0o600 })
  writeFileSync(join(profileDir, 'ws2-host-marker.txt'), 'host-profile-B\n', { mode: 0o600 })
  writeFileSync(join(clientWorkspaceA, 't36notes.md'), 'private file reference\n', { mode: 0o600 })
  mkdirSync(join(clientWorkspaceA, 'dist'), { recursive: true })
  writeFileSync(join(clientWorkspaceA, 'dist', 't36only-scoped.js'), 'x\n', { mode: 0o600 })
  // The `~/` shorthand must expand to the HOST's home — the isolated home in
  // this lane, never the operator's. One known file there turns the absolute
  // answer into a real sink instead of a vacuous "some absolute path".
  writeFileSync(join(home, 't36home-note.md'), 'private home reference\n', { mode: 0o600 })
  const surfaceHost = new EntryProcess('host', entries.host, base)
  const surfaceHostReady = await surfaceHost.waitFor(record => record.m4a0 === 'ready', 'T27 surface Host ready', 180_000)
  const surfaceHostPid = surfaceHostReady.pid
  const surfaceHostFacts = surfaceHostReady.localHost
  assert(surfaceHostReady.entries?.some(entry => entry.id === 'm4b2s-stub-llm' && entry.state === 'active') === true,
    'T30 the test-only offline Host LLM row is not active')
  assert(surfaceHostReady.localHost?.hostPid === surfaceHostPid, 'T27 Host ready PID mismatch')
  const surfaceClients = []
  let surfaceHostClosed = false
  let sessionA
  let sessionB

  // §4.3: the scope address is READ from THIS case's own first real Ready
  // record, never carried forward from another scenario.
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', surfaceHostReady.localHost.scopeId)
  try {
    // The lane's own fail-after control: this case's single Hook fires INSIDE the
    // case-owned try, so the finally below (not only the runner backstop) must
    // dispose every surface and shut this Host down on that failure path.
    failpoint('surface.pty-session-write-recovery.after-host-spawn')
    // T27/T28: ONE real surface over the SAME authenticated connection; sessionless
    // Welcome painted on the real pty, no JSON on the terminal.
    const c1 = new SurfaceEntryProcess(entries.client, {
      ...base,
      // WS-2: the REAL Client launch directory (A), distinct from the Host
      // Profile cwd (B) the Host process itself was started in.
      cwd: clientWorkspaceA,
      workDir,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1' },
    })
    surfaceClients.push(c1)
    const c1Ready = await c1.waitFor(record => record.m4a0 === 'ready', 'T27 surface Client ready', 180_000)
    assert(c1Ready.processRole === 'client', 'T27 surface Client role mismatch')
    assert(c1Ready.pid !== surfaceHostPid, 'T27 the surface Client and the Host must be distinct OS PIDs')
    assert(c1Ready.surfaceMounted === true, 'T27 the physical surface did not mount')
    assert(c1Ready.sessionOpen === false, 'T28 a sessionless surface must not claim an open Session')
    assert(c1Ready.transport === 'connected' && c1Ready.sessionsListPhase === 'ready',
      'T27 the official Client Session list is not ready')
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      assert(c1Ready.owners?.[owner] === 1, `T27 expected exactly one ${owner} owner`)
    }
    assert(c1Ready.privateNamespaces === 2, 'T27 expected exactly the two private pi-tui namespaces')
    assertClientHostFacts(c1Ready.host, surfaceHostFacts, 'T27 surface Client')
    await c1.waitForScreen('type a message to start a session', 'T28 sessionless Welcome')
    trace('t27-t28', {
      hostPid: c1Ready.host.hostPid,
      clientPid: c1Ready.pid,
      sessionOpen: false,
      owners: c1Ready.owners,
      privateNamespaces: c1Ready.privateNamespaces,
      welcome: 'painted',
    })

    // T29/T30: real input -> official beginSubmission -> Host commit ->
    // durable readback -> retained presentation (the stub answer is produced
    // by the Host's official LLM adapter, never by a Client fake).
    c1.send('session a\r')
    const openedA = await c1.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
      'T29 Session open',
      120_000,
    )
    assert(typeof openedA.openSessionId === 'string' && openedA.openSessionId.startsWith('session-'),
      'T29 no official Session id was opened')
    sessionA = openedA.openSessionId
    await c1.waitForScreen('session a', 'T29 user message')
    await c1.waitForScreen('stub answer', 'T30 assistant answer')
    // T30's durable half: the Host's authoritative session log must carry
    // exactly ONE accepted human write and the assistant message; the painted
    // echo alone is not accepted-write evidence.
    const durableA = await (async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const events = hostSessionEvents(dshHome, sessionA)
        if (events !== undefined) {
          const users = hostUserTexts(events).filter(message => message === 'session a').length
          const assistant = hostAssistantHasText(events, 'stub answer')
          if (users === 1 && assistant) return { users, assistant }
        }
        await sleep(100)
      }
      return undefined
    })()
    assert(durableA !== undefined,
      'T30 the Host durable log did not carry exactly one accepted "session a" write and its assistant message')
    // WS-2: the durable Host header cwd is the Host canonical form of the
    // Client launch directory — never the Host Profile the Host process runs in.
    const headerA = await waitForHostSessionHeader(dshHome, sessionA, 'T29 durable Host header')
    assert(headerA.cwd === canonicalClientWorkspaceA,
      `T29 the durable Session cwd must be the Host canonical launch directory: ${String(headerA.cwd)} != ${canonicalClientWorkspaceA}`)
    trace('t29-t30', {
      sessionId: sessionA,
      userMessage: 'painted',
      assistant: 'painted',
      hostUserMessages: durableA.users,
      hostAssistant: durableA.assistant,
      durableCwd: headerA.cwd,
      hostProfileCwd: realpathSync(profileDir),
      clientLaunchCwd: canonicalClientWorkspaceA,
    })

    // T09 (M5-A): a SECOND real Surface Client starts on its OWN PTY while A
    // is still live and connected. Both carry two different business PIDs,
    // mount their own surface and authenticate THE SAME Host Singleton
    // (same hostPid/starttime/instanceId/buildId). B opens its OWN Session in
    // its OWN Host Workspace; A's Session, durable log and painted transcript
    // stay untouched. B then exits normally and A keeps going (proved by the
    // T31 navigation below). `surface` holds no profile-global Client seat;
    // the qualification-only seat is proved separately by T09Q.
    const m5aClientB = new SurfaceEntryProcess(entries.client, {
      ...base,
      cwd: m5aWorkspaceB,
      workDir,
      env: base.env,
    })
    surfaceClients.push(m5aClientB)
    const m5aClientBReady = await m5aClientB.waitFor(
      record => record.m4a0 === 'ready',
      'T09 second surface Client ready',
      180_000,
    )
    assert(m5aClientBReady.processRole === 'client', 'T09 the second surface Client role mismatch')
    assert(m5aClientBReady.surfaceMounted === true, 'T09 Client B did not mount its own physical surface')
    assert(m5aClientBReady.transport === 'connected', `T09 Client B transport is ${JSON.stringify(m5aClientBReady.transport)}`)
    assert(m5aClientBReady.activeWrappers === 1, `T09 Client B owns ${String(m5aClientBReady.activeWrappers)} transport wrappers`)
    assert(m5aClientBReady.liveSockets === 1, `T09 Client B owns ${String(m5aClientBReady.liveSockets)} mux sockets`)
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      assert(m5aClientBReady.owners?.[owner] === 1, `T09 Client B expected exactly one ${owner} owner`)
    }
    assertClientHostFacts(m5aClientBReady.host, surfaceHostFacts, 'T09 Client B')
    // A must still be a live process while B is admitted. A's CURRENT owner,
    // transport and identity facts are asserted from a fresh authoritative
    // `surface-status` produced below (after B has its own open Session);
    // the initial ready snapshot is never used as proof of current ownership.
    assert(typeof c1Ready.pid === 'number' && typeof m5aClientBReady.pid === 'number'
      && c1Ready.pid !== m5aClientBReady.pid,
      'T09 the two surface Clients must be two different business PIDs')
    assert(c1Ready.pid !== surfaceHostPid && m5aClientBReady.pid !== surfaceHostPid,
      'T09 a surface Client business PID collided with the Host PID')
    assert(alive(c1Ready.pid), 'T09 Client A was not alive when B became ready')
    assert(alive(m5aClientBReady.pid), 'T09 Client B was not a live business process after ready')
    await m5aClientB.waitForScreen('type a message to start a session', 'T09 Client B sessionless Welcome')
    m5aClientB.send('m5a client b\r')
    const openedM5aB = await m5aClientB.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
      'T09 Client B Session open',
      120_000,
    )
    const sessionM5aB = openedM5aB.openSessionId
    assert(typeof sessionM5aB === 'string' && sessionM5aB.startsWith('session-'),
      'T09 Client B opened no official Session')
    assert(sessionM5aB !== sessionA, 'T09 Client B must open its OWN Session, never A\'s')
    await m5aClientB.waitForScreen('m5a client b', 'T09 Client B user message painted')
    await m5aClientB.waitForScreen('stub answer', 'T09 Client B assistant answer painted')
    const durableM5aB = await (async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const events = hostSessionEvents(dshHome, sessionM5aB)
        if (events !== undefined) {
          const users = hostUserTexts(events).filter(message => message === 'm5a client b').length
          const assistant = hostAssistantHasText(events, 'stub answer')
          if (users === 1 && assistant) return { users, assistant, events }
        }
        await sleep(100)
      }
      return undefined
    })()
    assert(durableM5aB !== undefined,
      'T09 the Host durable log did not carry exactly one accepted "m5a client b" write and its assistant message')
    const headerM5aB = await waitForHostSessionHeader(dshHome, sessionM5aB, 'T09 durable Host header B')
    assert(headerM5aB.cwd === canonicalM5aWorkspaceB,
      `T09 Client B's durable Session cwd must be the Host canonical B workspace: ${String(headerM5aB.cwd)} != ${canonicalM5aWorkspaceB}`)
    // Cross-session isolation in BOTH directions, on the durable logs and on
    // the painted frames: a shared Host PID must never leak one Session's
    // human text into the other.
    const durableAAfterB = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostUserTexts(durableAAfterB).every(text => text !== 'm5a client b'),
      'T09 Client A\'s Host durable log carried B\'s private user text')
    assert(hostUserTexts(durableM5aB.events).every(text => text !== 'session a'),
      'T09 Client B\'s Host durable log carried A\'s private user text')
    assert(hostUserTexts(durableAAfterB).filter(text => text === 'session a').length === 1,
      'T09 Client A\'s accepted write changed while B was admitted')
    assert((await waitForHostSessionHeader(dshHome, sessionA, 'T09 A header after B')).cwd === canonicalClientWorkspaceA,
      'T09 Client B changed A\'s durable Session Workspace')
    await c1.waitForScreen('session a', 'T09 Client A kept its own painted transcript')
    assert(!(await c1.viewport()).join('\n').includes('m5a client b'),
      'T09 Client A painted Client B\'s private text')
    assert(!(await m5aClientB.viewport()).join('\n').includes('session a'),
      'T09 Client B painted Client A\'s private transcript')
    assert(alive(c1Ready.pid), 'T09 Client A died while B was admitted')
    assert(alive(surfaceHostPid), 'T09 the Host died while both surface Clients were admitted')

    // A's CURRENT facts (identity, one owner per official service, one
    // wrapper/socket, connected + mounted) must be proved on a record emitted
    // AFTER B was admitted, not on A's initial ready snapshot. A frozen
    // `surface` entry owns its tty and deliberately has no B1 JSON control
    // channel, so there is no on-demand status read; a status projection is
    // emitted only when an official status key changes. Drive A's own real
    // navigation (a disposable Session with no user message, in A's Host
    // Workspace) and read the next authoritative `surface-status`: first for
    // leaving Session A, then for returning to it. The assertion below is
    // "the next surface-status after B was ready while B is still alive", not
    // an atomic snapshot of B's ready instant.
    const aStaleStatus = lastSurfaceStatus(c1)
    assert(aStaleStatus?.sessionOpen === true && aStaleStatus.openSessionId === sessionA
      && aStaleStatus.transport === 'connected',
    'T09 Client A has no connected Session A status before its status refresh')
    c1.send('/new\r')
    const aTemporaryStatus = await c1.waitFor(
      record => record.m4b2s === 'surface-status'
        && record.sessionOpen === true
        && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionA,
      'T09 Client A current status via a disposable Session',
      120_000,
    )
    const temporaryASessionId = aTemporaryStatus.openSessionId
    assert(temporaryASessionId !== sessionM5aB,
      'T09 Client A must never open Client B\'s Session')
    const aStatusBoundary = c1.records.length
    c1.send(`/resume ${sessionA}\r`)
    const currentA = await c1.waitFor(
      record => c1.records.indexOf(record) >= aStatusBoundary
        && record.m4b2s === 'surface-status'
        && record.sessionOpen === true
        && record.openSessionId === sessionA
        && record.transport === 'connected',
      'T09 Client A current status restored to Session A',
      120_000,
    )
    assertClientHostFacts(currentA.host, surfaceHostFacts, 'T09 Client A current')
    assert(currentA.transport === 'connected', `T09 Client A current transport is ${JSON.stringify(currentA.transport)}`)
    assert(currentA.surfaceMounted === true, 'T09 Client A current surface is not mounted')
    assert(currentA.activeWrappers === 1, `T09 Client A currently owns ${String(currentA.activeWrappers)} wrapper(s)`)
    assert(currentA.liveSockets === 1, `T09 Client A currently owns ${String(currentA.liveSockets)} socket(s)`)
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      assert(currentA.owners?.[owner] === 1, `T09 Client A currently owns ${owner} ${String(currentA.owners?.[owner])}`)
    }
    assert(alive(c1Ready.pid), 'T09 Client A died during its own status refresh')
    // A's own navigation must not touch the concurrently admitted Client B.
    const currentB = lastSurfaceStatus(m5aClientB)
    assert(alive(m5aClientBReady.pid), 'T09 Client B died when A navigated Sessions')
    assert(currentB?.transport === 'connected' && currentB?.openSessionId === sessionM5aB,
      'T09 Client B lost its own Session/transport when A navigated')
    await m5aClientB.waitForScreen('m5a client b', 'T09 Client B kept its own transcript')
    await c1.waitForScreen('session a', 'T09 Client A restored its own transcript')
    // Evidence limitation: the disposable navigation leaves ONE Session in
    // A's Host Workspace that receives no user message or turn (the Host
    // persists only its creation record); A's durable Session A
    // header/content stay unchanged (re-asserted below after B exits).

    // B exits NORMALLY while A keeps running: only B's own Client resources
    // are released; A, the Host identity and the registry/launch material
    // stay. A's continued navigation is the next real T31 action.
    m5aClientB.send('/exit\r')
    const m5aClientBExit = await m5aClientB.waitForExit(60_000)
    assert(m5aClientBExit.code === 0, `T09 Client B normal exit was ${JSON.stringify(m5aClientBExit)}`)
    const m5aClientBClosed = await m5aClientB.waitFor(
      record => record.m4b2s === 'client-closed',
      'T09 Client B client-closed',
      30_000,
    )
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      assert(m5aClientBClosed.owners?.[owner] === 0, `T09 Client B left ${owner} alive after its normal exit`)
    }
    assert(m5aClientBClosed.sessionOpen === false && m5aClientBClosed.surfaceMounted === false,
      'T09 Client B still claimed an open surface/Session after its normal exit')
    assert(m5aClientBClosed.activeWrappers === 0 && m5aClientBClosed.liveSockets === 0,
      'T09 Client B still owned transport wrappers/sockets after its normal exit')
    await m5aClientB.dispose()
    assert(alive(c1Ready.pid), 'T09 Client A died when Client B exited')
    assert(alive(surfaceHostPid), 'T09 the Host died when Client B exited')
    const registryAfterM5aB = readJson(join(scopeDir, 'instance.json'))
    assert(registryAfterM5aB.instanceId === surfaceHostFacts.instanceId,
      'T09 the Host instance changed when Client B exited')
    assert(registryAfterM5aB.buildId === surfaceHostFacts.buildId,
      'T09 the Host build changed when Client B exited')
    await c1.waitForScreen('session a', 'T09 Client A survived B\'s exit')
    assert(!(await c1.viewport()).join('\n').includes('m5a client b'),
      'T09 Client A painted Client B\'s private text after B exited')
    trace('t09', {
      hostPid: surfaceHostPid,
      hostInstanceId: surfaceHostFacts.instanceId,
      clientAPid: c1Ready.pid,
      clientBPid: m5aClientBReady.pid,
      sessionIdA: sessionA,
      sessionIdB: sessionM5aB,
      workspaceADigest: sha16(canonicalClientWorkspaceA),
      workspaceBDigest: sha16(canonicalM5aWorkspaceB),
      distinctBusinessPids: c1Ready.pid !== m5aClientBReady.pid,
      bothReadyConcurrently: true,
      clientACurrentStatusAfterB: true,
      clientACurrentOwners: currentA.owners,
      clientACurrentWrappers: currentA.activeWrappers,
      clientACurrentSockets: currentA.liveSockets,
      clientBNormalExit: m5aClientBExit.code,
      clientBClosed: true,
      clientAKept: true,
      hostIdentityKept: true,
    })

    // T31: Session switch A -> B -> A, each with retained-window hydration.
    // Each wait is bounded to the records appended AFTER its own command:
    // an earlier Session-A status must never satisfy a later switch.
    const t31NewBoundary = c1.records.length
    c1.send('/new\r')
    const openedB = await c1.waitFor(
      record => c1.records.indexOf(record) >= t31NewBoundary
        && record.m4b2s === 'surface-status'
        && record.sessionOpen === true
        && record.openSessionId !== sessionA,
      'T31 new Session',
      120_000,
    )
    sessionB = openedB.openSessionId
    assert(sessionB !== sessionA, 'T31 /new did not open a different Session')
    c1.send('session b\r')
    await c1.waitForScreen('session b', 'T31 Session B user message')
    await c1.waitForScreen('stub answer', 'T31 Session B assistant answer')
    const t31BackToABoundary = c1.records.length
    c1.send(`/resume ${sessionA}\r`)
    await c1.waitFor(
      record => c1.records.indexOf(record) >= t31BackToABoundary
        && record.m4b2s === 'surface-status'
        && record.openSessionId === sessionA,
      'T31 switch back to A',
      120_000,
    )
    await c1.waitForScreen('session a', 'T31 Session A re-hydration')
    const t31ToBBoundary = c1.records.length
    c1.send(`/resume ${sessionB}\r`)
    await c1.waitFor(
      record => c1.records.indexOf(record) >= t31ToBBoundary
        && record.m4b2s === 'surface-status'
        && record.openSessionId === sessionB,
      'T31 switch to B',
      120_000,
    )
    await c1.waitForScreen('session b', 'T31 Session B re-hydration')
    const t31FinalABoundary = c1.records.length
    c1.send(`/resume ${sessionA}\r`)
    await c1.waitFor(
      record => c1.records.indexOf(record) >= t31FinalABoundary
        && record.m4b2s === 'surface-status'
        && record.openSessionId === sessionA,
      'T31 switch A -> B -> A',
      120_000,
    )
    await c1.waitForScreen('session a', 'T31 final Session A hydration')
    // WS-2: `/new` created B in the CAPTURED Session's Host Workspace (A), not
    // in the Client launch directory of some other process.
    const headerB = await waitForHostSessionHeader(dshHome, sessionB, 'T31 durable Host header')
    assert(headerB.cwd === canonicalClientWorkspaceA,
      `T31 the /new Session cwd must be the captured Host Workspace: ${String(headerB.cwd)} != ${canonicalClientWorkspaceA}`)
    trace('t31', { first: sessionA, second: sessionB, switches: 'A->B->A', durableCwd: headerB.cwd })

    // T36: the private PiFile + terminal-progress RPCs through the ALREADY
    // mounted Domain namespaces on the SAME Client Context (no second
    // contribution, no Host service).
    c1.signalBusiness('SIGUSR2')
    const privateProof = await c1.waitFor(
      record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
      'T36 private RPC proof',
      60_000,
    )
    assert(privateProof.error === undefined, `T36 private RPC proof failed: ${JSON.stringify(privateProof)}`)
    assert(privateProof.fileOk === true, 'T36 the private PiFile RPC did not succeed')
    assert(typeof privateProof.fileKind === 'string', 'T36 the private PiFile RPC returned no business kind')
    assert(privateProof.terminalKind === 'snapshot', 'T36 the terminal-progress watch did not open with a snapshot')
    assert(privateProof.owners?.sessions === 1 && privateProof.privateNamespaces === 2,
      'T36 the private proof observed a duplicate/absent Domain owner')
    // Migrated from the retired built-bundle smoke: the private endpoint's
    // Host workspace semantics over the REAL authenticated split wire.
    assert(privateProof.bareOfficial === true,
      `T36 the bare query did not reach the official Host provider (observed ${String(privateProof.bareCount)} items)`)
    assert(privateProof.officialEmpty === true,
      `T36 an authoritative official [] did not stay empty (ok=${String(privateProof.emptyOk)} kind=${String(privateProof.emptyKind)})`)
    assert(privateProof.officialExcludesDist === true,
      `T36 the official bare route did not authoritatively exclude dist/ (kind ${String(privateProof.officialExcludesDistKind)})`)
    assert(privateProof.scopedOk === true && privateProof.scopedHostScanner === true,
      `T36 the explicit-path scope did not reach the Host scanner (observed ${String(privateProof.scopedCount)} items)`)
    assert(privateProof.homeAbsolute === true,
      'T36 the HOME shorthand did not answer absolute Host paths')
    // WS-2: the Host Workspace authority behind the SAME Session, read through
    // the official Client namespace and the Host's own file read.
    assert(privateProof.workspaceMatchesClientCwd === true,
      'T36 the Session Workspace path is not the Client launch directory')
    assert(privateProof.workspacePathDigest === sha16(canonicalClientWorkspaceA),
      `T36 the Session Workspace path digest is not A: ${String(privateProof.workspacePathDigest)}`)
    assert(Array.isArray(privateProof.workspaceSessionDigests)
      && privateProof.workspaceSessionDigests.includes(sha16(sessionA))
      && privateProof.workspaceSessionDigests.includes(sha16(sessionB)),
    'T36 both /new Sessions must belong to the SAME Host Workspace')
    assert(privateProof.workspaceListCwdDigest === sha16(canonicalClientWorkspaceA),
      'T36 the Host list-row cwd digest is not the Workspace path')
    // The official page read joins lines, so the expected text carries no
    // trailing newline.
    assert(privateProof.workspaceMarkerText === 'client-workspace-A',
      `T36 the Host file read did not return THIS Workspace's marker: ${JSON.stringify(privateProof.workspaceMarkerText)}`)
    trace('t36', {
      sessionId: privateProof.sessionId,
      fileOk: privateProof.fileOk,
      fileKind: privateProof.fileKind,
      bareOfficial: privateProof.bareOfficial,
      officialEmpty: privateProof.officialEmpty,
      scopedHostScanner: privateProof.scopedHostScanner,
      homeAbsolute: privateProof.homeAbsolute,
      terminalKind: privateProof.terminalKind,
      owners: privateProof.owners,
    })

    // T32/T38: normal surface exit releases every Client-owned resource and
    // leaves the Host PID/instance/build untouched.
    c1.send('/exit\r')
    const c1Exit = await c1.waitForExit(60_000)
    assert(c1Exit.code === 0, `T32 surface Client exit was ${JSON.stringify(c1Exit)}`)
    await c1.waitFor(record => record.m4b2s === 'client-closed', 'T38 client-closed record', 30_000)
    const closed = c1.records.find(record => record.m4b2s === 'client-closed')
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      assert(closed.owners?.[owner] === 0, `T38 ${owner} survived the Client exit`)
    }
    assert(closed.sessionOpen === false && closed.surfaceMounted === false,
      'T38 the Client still claims an open surface/Session after exit')
    assert(closed.activeWrappers === 0 && closed.liveSockets === 0,
      'T38 the Client still owns transport wrappers/sockets after exit')
    assert(alive(surfaceHostPid), 'T32 the Host died on the normal surface exit')
    const registryAfterExit = readJson(join(scopeDir, 'instance.json'))
    assert(registryAfterExit.instanceId === surfaceHostFacts.instanceId, 'T32 the Host instance changed on the Client exit')
    assert(registryAfterExit.buildId === surfaceHostFacts.buildId, 'T32 the Host build changed on the Client exit')
    trace('t32-t38', {
      clientExit: c1Exit.code,
      hostPid: surfaceHostPid,
      hostInstanceId: surfaceHostFacts.instanceId,
      owners: closed.owners,
      wrappers: closed.activeWrappers,
      sockets: closed.liveSockets,
    })
    await c1.dispose()

    // WS-2: a SECOND, SEQUENTIAL real Client whose launch directory (C) is
    // separate from A selects its OWN Host Workspace under the SAME Host
    // PID/instance. This sequential Client-C scenario keeps its original
    // position after c1 exited; the concurrent same-Host positive is T09.
    const ws2ClientC = new SurfaceEntryProcess(entries.client, {
      ...base,
      cwd: clientWorkspaceC,
      workDir,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1' },
    })
    surfaceClients.push(ws2ClientC)
    const ws2ClientCReady = await ws2ClientC.waitFor(record => record.m4a0 === 'ready', 'WS2 second Client ready', 180_000)
    assert(ws2ClientCReady.processRole === 'client', 'WS2 second Client role mismatch')
    assert(ws2ClientCReady.pid !== surfaceHostPid, 'WS2 the second Client must be its own OS process')
    assert(ws2ClientCReady.host.hostPid === surfaceHostFacts.hostPid, 'WS2 the second Client must reach the SAME Host PID')
    assert(ws2ClientCReady.host.instanceId === surfaceHostFacts.instanceId, 'WS2 the second Client must reach the SAME Host instance')
    ws2ClientC.send('ws2 session c\r')
    const ws2ClientCOpened = await ws2ClientC.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
      'WS2 session C open',
      120_000,
    )
    const sessionC = ws2ClientCOpened.openSessionId
    assert(typeof sessionC === 'string' && sessionC.startsWith('session-'), 'WS2 session C has no official Session id')
    await ws2ClientC.waitForScreen('ws2 session c', 'WS2 session C user message')
    const headerC = await waitForHostSessionHeader(dshHome, sessionC, 'WS2 durable C header')
    assert(headerC.cwd === canonicalClientWorkspaceC,
      `WS2 session C header cwd must be the Host canonical C path: ${String(headerC.cwd)} != ${canonicalClientWorkspaceC}`)
    ws2ClientC.signalBusiness('SIGUSR2')
    const ws2ClientCProof = await ws2ClientC.waitFor(
      record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
      'WS2 second Client workspace proof',
      60_000,
    )
    assert(ws2ClientCProof.workspaceMatchesClientCwd === true,
      'WS2 the C Session Workspace path is not the C Client launch directory')
    assert(ws2ClientCProof.workspacePathDigest === sha16(canonicalClientWorkspaceC),
      `WS2 the C Session Workspace path digest is not C: ${String(ws2ClientCProof.workspacePathDigest)}`)
    assert(Array.isArray(ws2ClientCProof.workspaceSessionDigests)
      && ws2ClientCProof.workspaceSessionDigests.includes(sha16(sessionC)),
    'WS2 the C Session is missing from its own Host Workspace membership')
    // A's marker is NOT readable from C's Session: the Host file authority is
    // the Session's OWN Workspace, never a global "current directory".
    assert(ws2ClientCProof.workspaceMarkerText === undefined,
      `WS2 the C Session must not read A's Workspace marker: ${JSON.stringify(ws2ClientCProof.workspaceMarkerText)}`)
    // No cross-Client reassignment: A/B keep their own durable Workspace.
    const headerAAfterC = await waitForHostSessionHeader(dshHome, sessionA, 'WS2 A header after C')
    const headerBAfterC = await waitForHostSessionHeader(dshHome, sessionB, 'WS2 B header after C')
    assert(headerAAfterC.cwd === canonicalClientWorkspaceA, 'WS2 a second Client changed A\'s durable Workspace')
    assert(headerBAfterC.cwd === canonicalClientWorkspaceA, 'WS2 a second Client changed B\'s durable Workspace')
    // WS2-02 (cross-Workspace): this Client's launch cwd is C, but after
    // resuming Session A (Workspace A) a `/new` must create the fresh Session
    // in A's Host Workspace — never in the Client launch directory C. This is
    // the real-wire witness the same-cwd case cannot provide.
    ws2ClientC.send(`/resume ${sessionA}\r`)
    await ws2ClientC.waitFor(
      record => record.m4b2s === 'surface-status' && record.openSessionId === sessionA,
      'WS2 resume A from Client C',
      120_000,
    )
    await ws2ClientC.waitForScreen('session a', 'WS2 resumed A history in Client C', 120_000)
    ws2ClientC.send('/new\r')
    const ws2CrossOpened = await ws2ClientC.waitFor(
      record => record.m4b2s === 'surface-status'
        && record.sessionOpen === true
        && record.openSessionId !== sessionA
        && record.openSessionId !== sessionC,
      'WS2 cross-Workspace /new Session',
      120_000,
    )
    const sessionD = ws2CrossOpened.openSessionId
    assert(typeof sessionD === 'string' && sessionD.startsWith('session-'), 'WS2 cross-Workspace /new has no Session id')
    const headerD = await waitForHostSessionHeader(dshHome, sessionD, 'WS2 durable D header')
    assert(headerD.cwd === canonicalClientWorkspaceA,
      `WS2 /new from Session A must create in A's Host Workspace, not the Client launch cwd: ${String(headerD.cwd)} != ${canonicalClientWorkspaceA}`)
    ws2ClientC.signalBusiness('SIGUSR2')
    const ws2CrossProof = await ws2ClientC.waitFor(
      record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof' && record.sessionId === sessionD,
      'WS2 cross-Workspace /new workspace proof',
      60_000,
    )
    assert(ws2CrossProof.workspacePathDigest === sha16(canonicalClientWorkspaceA),
      `WS2 the /new Session Workspace is not A: ${String(ws2CrossProof.workspacePathDigest)}`)
    assert(ws2CrossProof.workspaceMatchesClientCwd === false,
      'WS2 the /new Session Workspace must not be the Client launch directory C')
    assert(ws2CrossProof.workspaceListCwdDigest === sha16(canonicalClientWorkspaceA),
      'WS2 the /new Session list-row cwd digest is not A')
    assert(ws2CrossProof.workspaceMarkerText === 'client-workspace-A',
      'WS2 the /new Session Host file read must reach A\'s marker')
    const ws2Rows = Array.isArray(ws2CrossProof.workspaceRows) ? ws2CrossProof.workspaceRows : []
    const ws2RowA = ws2Rows.find(row => row.pathDigest === sha16(canonicalClientWorkspaceA))
    const ws2RowC = ws2Rows.find(row => row.pathDigest === sha16(canonicalClientWorkspaceC))
    assert(ws2RowA !== undefined && Array.isArray(ws2RowA.sessionDigests)
      && ws2RowA.sessionDigests.includes(sha16(sessionA))
      && ws2RowA.sessionDigests.includes(sha16(sessionD)),
    'WS2 the /new Session must join A\'s Host Workspace membership')
    assert(ws2RowC !== undefined && Array.isArray(ws2RowC.sessionDigests)
      && ws2RowC.sessionDigests.includes(sha16(sessionC)),
    'WS2 the earlier Client-C Session must stay in Workspace C')
    assert((await waitForHostSessionHeader(dshHome, sessionC, 'WS2 durable C header after /new')).cwd === canonicalClientWorkspaceC,
      'WS2 the cross-Workspace /new changed Session C\'s durable Workspace')
    ws2ClientC.send('/exit\r')
    const ws2ClientCExit = await ws2ClientC.waitForExit(60_000)
    assert(ws2ClientCExit.code === 0, `WS2 second Client exit was ${JSON.stringify(ws2ClientCExit)}`)
    await ws2ClientC.dispose()
    assert(alive(surfaceHostPid), 'WS2 the Host died on the second Client exit')
    trace('ws2-second-client', {
      hostPid: surfaceHostPid,
      clientPid: ws2ClientCReady.pid,
      sessionId: sessionC,
      workspacePathDigest: ws2ClientCProof.workspacePathDigest,
      clientLaunchCwd: canonicalClientWorkspaceC,
      aWorkspaceKept: headerAAfterC.cwd,
      markerIsolated: true,
      crossWorkspaceNew: true,
      crossWorkspaceSessionId: sessionD,
      crossWorkspaceCwd: canonicalClientWorkspaceA,
    })

    // WS-2 negative control: an invalid Host path proposal refuses BEFORE any
    // Session create, surfaces a meaningful failure, and leaves the Host alive.
    // The injection uses the SAME `initialWorkspaceIntent` seam (a path, never
    // a pre-validated WorkspaceId).
    const sessionLogsBefore = hostSessionLogCount(dshHome)
    const ws2InvalidClient = new SurfaceEntryProcess(entries.client, {
      ...base,
      cwd: clientWorkspaceA,
      workDir,
      env: {
        ...base.env,
        SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: join(workDir, 'ws2-invalid-host-path'),
      },
    })
    surfaceClients.push(ws2InvalidClient)
    const ws2InvalidClientReady = await ws2InvalidClient.waitFor(record => record.m4a0 === 'ready', 'WS2 negative Client ready', 180_000)
    assert(ws2InvalidClientReady.sessionOpen === false, 'WS2 the negative Client must start sessionless')
    ws2InvalidClient.send('ws2 invalid path probe\r')
    await ws2InvalidClient.waitForScreen('could not start a session', 'WS2 negative failure notice')
    assert(!ws2InvalidClient.records.some(record => record.m4b2s === 'surface-status' && record.sessionOpen === true),
      'WS2 the invalid Host path must never open/create a Session')
    assert(hostSessionLogCount(dshHome) === sessionLogsBefore,
      'WS2 the invalid Host path created a durable Host Session')
    assert(alive(surfaceHostPid), 'WS2 the Host died on the invalid path refusal')
    assert(readJson(join(scopeDir, 'instance.json')).instanceId === surfaceHostFacts.instanceId,
      'WS2 the Host instance changed on the invalid path refusal')
    // The failed first-session submission RESTORED the draft into the editor,
    // so a typed `/exit` would be appended to it and submitted as ordinary
    // text. Use the same admitted business stop the T41/T66 witnesses use.
    ws2InvalidClient.signalBusiness('SIGTERM')
    const ws2InvalidClientExit = await ws2InvalidClient.waitForExit(60_000)
    assert(ws2InvalidClientExit.code === 0 && ws2InvalidClientExit.signal === null,
      `WS2 negative Client stop was ${JSON.stringify(ws2InvalidClientExit)}`)
    await ws2InvalidClient.dispose()
    trace('ws2-invalid-path', {
      sessionOpen: false,
      hostSessionLogs: sessionLogsBefore,
      hostAlive: true,
    })

    // T41/T42: a SIGTERM during the assembly must be owned by ONE coordinator:
    // no ready, no duplicate cleanup, the same Host immediately usable by a
    // fresh surface Client, and the Host untouched. Two deterministic stages
    // are held: after the Domain readiness and after the runner fiber
    // mount/before surface ready.
    for (const [stage, traceName] of [['domain', 't41'], ['surface', 't42']]) {
      const barrier = join(workDir, `${traceName}-assembly-barrier`)
      rmSync(barrier, { force: true })
      const stopping = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: `${stage}@${barrier}`,
        },
      })
      surfaceClients.push(stopping)
      const held = await stopping.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'assembly-hold' && record.stage === stage,
        `${traceName} ${stage} assembly hold`,
        180_000,
      )
      stopping.signalBusiness('SIGTERM')
      // Ordering, not sleep: the barrier must be released only AFTER the
      // Client ADMITTED the signal (its own `signal` record). Signalling and
      // releasing back-to-back races the OS signal delivery against the
      // hold's 20ms poll — the assembly could legally finish and publish a
      // real `ready` before the signal was ever admitted, which is a
      // different (correct) outcome than this case's claim. T59 uses the
      // same admitted-signal gate for its mid-HMR stop.
      await stopping.waitFor(
        record => record.m4a0 === 'signal' && record.signal === 'SIGTERM',
        `${traceName} ${stage} stop signal admitted`,
        30_000,
      )
      writeFileSync(barrier, 'release\n', { mode: 0o600 })
      const stopped = await stopping.waitForExit(60_000)
      assert(stopped.code === 0, `${traceName} ${stage} stop exit was ${JSON.stringify(stopped)}`)
      assert(!stopping.records.some(record => record.m4a0 === 'ready'),
        `${traceName} ${stage} stop still published a ready surface`)
      assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'),
        `${traceName} ${stage} stop reported a duplicate/failed cleanup`)
      await stopping.dispose()
      // A NEW surface Client mounts immediately over the SAME Host: `surface`
      // holds no profile-global Client seat to release or reuse.
      const reusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      surfaceClients.push(reusable)
      const reusableReady = await reusable.waitFor(record => record.m4a0 === 'ready', `${traceName} reusable Client ready`, 180_000)
      assert(reusableReady.surfaceMounted === true, `${traceName} the reusable Client did not mount`)
      assert(alive(surfaceHostPid), `${traceName} the Host died on the startup stop`)
      const reusableInstance = readJson(join(scopeDir, 'instance.json'))
      assert(reusableInstance.instanceId === surfaceHostFacts.instanceId,
        `${traceName} the Host instance changed on the startup stop`)
      reusable.send('/exit\r')
      const reusableExit = await reusable.waitForExit(60_000)
      assert(reusableExit.code === 0, `${traceName} reusable Client exit was ${JSON.stringify(reusableExit)}`)
      await reusable.dispose()
      trace(traceName, {
        stage,
        heldAt: held.stage,
        readyEmitted: false,
        cleanupFailures: 0,
        clientReusable: true,
        hostAlive: true,
      })
    }

    // T41-gate: a SIGTERM while the REAL Cordis Loader gate is still pending
    // must enter the ONE stop coordinator before any Gateway start. The
    // process must exit cleanly, leave no fake ready and keep the Host alive;
    // the same Host then accepts a fresh Client.
    {
      const gateBarrier = join(workDir, 't41-gate-barrier')
      rmSync(gateBarrier, { force: true })
      const gateStopping = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE: gateBarrier },
      })
      surfaceClients.push(gateStopping)
      const gateHeld = await gateStopping.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'startup-gate-hold' && record.stage === 'loader-gate',
        'T41-gate loader gate hold',
        180_000,
      )
      gateStopping.signalBusiness('SIGTERM')
      writeFileSync(gateBarrier, 'release\n', { mode: 0o600 })
      const gateExit = await gateStopping.waitForExit(60_000)
      assert(gateExit.code === 0, `T41-gate stop exit was ${JSON.stringify(gateExit)}`)
      assert(!gateStopping.records.some(record => record.m4a0 === 'ready'),
        'T41-gate stop still published a ready surface')
      assert(!gateStopping.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T41-gate stop reported a cleanup failure')
      assert(!gateStopping.records.some(record => record.m4a0 === 'transport-ready'),
        'T41-gate stop allowed transport readiness after the signal')
      await gateStopping.dispose()
      assert(alive(surfaceHostPid), 'T41-gate the Host died on the gate stop')
      const gateReusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      surfaceClients.push(gateReusable)
      const gateReusableReady = await gateReusable.waitFor(record => record.m4a0 === 'ready', 'T41-gate reusable Client ready', 180_000)
      assert(gateReusableReady.surfaceMounted === true, 'T41-gate the reusable Client did not mount')
      gateReusable.send('/exit\r')
      const gateReusableExit = await gateReusable.waitForExit(60_000)
      assert(gateReusableExit.code === 0, `T41-gate reusable Client exit was ${JSON.stringify(gateReusableExit)}`)
      await gateReusable.dispose()
      trace('t41-gate', {
        heldAt: gateHeld.stage,
        readyEmitted: false,
        transportReady: false,
        cleanupFailures: 0,
        clientReusable: true,
        hostAlive: true,
      })
    }

    // T43: a signal in the PRE-STARTUP assignment window (after the lazy
    // client-bootstrap import, before `startupPromise` exists) must wait for
    // the ONE startup gate and never dispose the root underneath a late
    // `startLocalClient` call.
    const preStartBarrier = join(workDir, 't43-pre-start-barrier')
    rmSync(preStartBarrier, { force: true })
    const preStart = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: {
        ...base.env,
        SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START: preStartBarrier,
      },
    })
    surfaceClients.push(preStart)
    await preStart.waitFor(
      record => record.m4a0 === 'qualification' && record.op === 'before-start-hold',
      'T43 pre-startup assignment hold',
      180_000,
    )
    preStart.signalBusiness('SIGTERM')
    writeFileSync(preStartBarrier, 'release\n', { mode: 0o600 })
    const preStartExit = await preStart.waitForExit(60_000)
    assert(preStartExit.code === 0, `T43 pre-startup stop exit was ${JSON.stringify(preStartExit)}`)
    assert(!preStart.records.some(record => record.m4a0 === 'ready'),
      'T43 pre-startup stop still published a ready surface')
    assert(!preStart.records.some(record => record.m4a0 === 'cleanup-failure'),
      'T43 pre-startup stop reported a duplicate/failed cleanup')
    await preStart.dispose()
    const afterPreStart = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    surfaceClients.push(afterPreStart)
    const afterPreStartReady = await afterPreStart.waitFor(record => record.m4a0 === 'ready', 'T43 reusable Client ready', 180_000)
    assert(afterPreStartReady.surfaceMounted === true, 'T43 the reusable Client did not mount')
    assert(alive(surfaceHostPid), 'T43 the Host died on the pre-startup stop')
    const afterPreStartInstance = readJson(join(scopeDir, 'instance.json'))
    assert(afterPreStartInstance.instanceId === surfaceHostFacts.instanceId,
      'T43 the Host instance changed on the pre-startup stop')
    afterPreStart.send('/exit\r')
    const afterPreStartExit = await afterPreStart.waitForExit(60_000)
    assert(afterPreStartExit.code === 0, `T43 reusable Client exit was ${JSON.stringify(afterPreStartExit)}`)
    await afterPreStart.dispose()
    trace('t43', {
      stage: 'pre-startup-assignment',
      readyEmitted: false,
      cleanupFailures: 0,
      clientReusable: true,
      hostAlive: true,
    })

    // T34: close the writer's pre-dispatch admission while a REAL
    // serialization barrier holds the write. The writer must return
    // not-dispatched, the draft must return to the composer, and the Host must
    // never see the prompt. The signal only closes the SAME admission gate the
    // surface-stop path owns; the surface stays mounted so the draft is visible.
    const holdBarrier = join(workDir, 't34-serializer-barrier')
    rmSync(holdBarrier, { force: true })
    const cHold = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: {
        ...base.env,
        SPLIT_PROCESS_CLIENT_SESSION: sessionA,
        SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: holdBarrier,
      },
    })
    surfaceClients.push(cHold)
    const cHoldReady = await cHold.waitFor(record => record.m4a0 === 'ready', 'T34 hold Client ready', 180_000)
    assert(cHoldReady.sessionOpen === true && cHoldReady.openSessionId === sessionA,
      'T34 the hold Client did not open the retained Session')
    cHold.send('holdme\r')
    await cHold.waitForScreen('holdme', 'T34 pending echo', 60_000)
    cHold.signalBusiness('SIGUSR2')
    await cHold.waitFor(
      record => record.m4b2s === 'qualification' && record.op === 'stop-surface-admission',
      'T34 admission stop',
      30_000,
    )
    writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
    await cHold.waitForComposerDraft('holdme', 60_000)
    // The writer settled BEFORE dispatch (the admission record and the
    // restored composer draft are both observed). One bounded observation
    // window then proves the Host received nothing; a real dispatch would
    // persist immediately.
    await sleep(1_000)
    const holdEvents = hostSessionEvents(dshHome, sessionA)
    assert(holdEvents !== undefined, 'T34 no Host Session log is readable')
    assert(hostUserTexts(holdEvents).filter(message => message === 'holdme').length === 0,
      'T34 the refused pre-dispatch write still reached the Host')
    cHold.signalBusiness('SIGTERM')
    const holdExit = await cHold.waitForExit(60_000)
    assert(holdExit.code === 0, `T34 hold Client exit was ${JSON.stringify(holdExit)}`)
    await cHold.dispose()
    trace('t34', { preDispatch: 'not dispatched', hostWrites: 0, draft: 'restored' })

    // T35: the Host receives and commits ONE prompt, but the response ACK is
    // dropped after the write. The Client must report the write as
    // indeterminate (never committed), never replay it, and the NEXT Client
    // must reconcile from the Host's durable log.
    const c4 = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: {
        ...base.env,
        SPLIT_PROCESS_CLIENT_SESSION: sessionA,
        SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1',
      },
    })
    surfaceClients.push(c4)
    const c4Ready = await c4.waitFor(record => record.m4a0 === 'ready', 'T35 ACK-drop Client ready', 180_000)
    assert(c4Ready.sessionOpen === true && c4Ready.openSessionId === sessionA,
      'T35 the ACK-drop Client did not open the retained Session')
    c4.send('ackdrop\r')
    await c4.waitForScreen('indeterminate', 'T35 indeterminate notice', 120_000)
    const committedAckdrop = async (expected) => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const events = hostSessionEvents(dshHome, sessionA)
        if (events !== undefined) {
          const count = hostUserTexts(events).filter(message => message === 'ackdrop').length
          if (count >= expected) return count
        }
        await sleep(100)
      }
      return undefined
    }
    const hostCommits = await committedAckdrop(1)
    assert(hostCommits === 1,
      `T35 expected exactly ONE Host-committed ackdrop message, got ${String(hostCommits)}`)
    c4.signalBusiness('SIGTERM')
    const c4Exit = await c4.waitForExit(60_000)
    assert(c4Exit.code === 0, `T35 ACK-drop Client exit was ${JSON.stringify(c4Exit)}`)
    await c4.dispose()

    const c5 = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
    })
    surfaceClients.push(c5)
    const c5Ready = await c5.waitFor(record => record.m4a0 === 'ready', 'T35 reconciliation Client ready', 180_000)
    assert(c5Ready.sessionOpen === true && c5Ready.openSessionId === sessionA,
      'T35 the reconciliation Client did not open the retained Session')
    await c5.waitForScreen('ackdrop', 'T35 reconciled Host log')
    await sleep(500)
    const reconciledEvents = hostSessionEvents(dshHome, sessionA)
    assert(reconciledEvents !== undefined, 'T35 no persisted Host Session log is readable')
    assert(hostUserTexts(reconciledEvents).filter(message => message === 'ackdrop').length === 1,
      'T35 the next Client replayed the indeterminate prompt instead of reconciling the Host log')
    c5.send('/exit\r')
    const c5Exit = await c5.waitForExit(60_000)
    assert(c5Exit.code === 0, `T35 reconciliation Client exit was ${JSON.stringify(c5Exit)}`)
    await c5.dispose()
    assert(alive(surfaceHostPid), 'T35 the Host died on the ACK-drop flow')
    trace('t35', { hostCommits: 1, indeterminate: 'painted', replayed: false, reconcile: 'Host log' })

    // T29 resume + T33 SIGKILL survival: a NEW Client reads the committed
    // Session; killing it leaves the same Host instance alive; a THIRD Client
    // reads the SAME committed data again.
    const c2 = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
    })
    surfaceClients.push(c2)
    const c2Ready = await c2.waitFor(record => record.m4a0 === 'ready', 'T29 resume Client ready', 180_000)
    assert(c2Ready.sessionOpen === true && c2Ready.openSessionId === sessionA,
      'T29 the explicit --session resume did not open the exact retained Session')
    await c2.waitForScreen('session a', 'T29 retained user message')
    await c2.waitForScreen('stub answer', 'T30 retained assistant answer')
    assertClientHostFacts(c2Ready.host, surfaceHostFacts, 'T29 C2')
    const c2Pid = c2Ready.pid
    c2.signalBusiness('SIGKILL')
    for (let attempt = 0; attempt < 200 && alive(c2Pid); attempt += 1) await sleep(25)
    assert(!alive(c2Pid), 'T33 the surface Client survived SIGKILL')
    assert(alive(surfaceHostPid), 'T33 the Host died on Client SIGKILL')
    await c2.dispose()

    const c3 = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
    })
    surfaceClients.push(c3)
    const c3Ready = await c3.waitFor(record => record.m4a0 === 'ready', 'T33 post-kill Client ready', 180_000)
    assert(c3Ready.sessionOpen === true && c3Ready.openSessionId === sessionA,
      'T33 the post-SIGKILL Client did not re-open the committed Session')
    await c3.waitForScreen('session a', 'T33 committed readback after SIGKILL')
    assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T33 C3')
    trace('t33', { killedClient: c2Pid, resumedClient: c3Ready.pid, hostAlive: true, sessionId: sessionA })

    // T37: one physical mux drop -> official generation rollover -> the
    // retained main view is re-adopted and the transcript re-hydrates.
    const generationBefore = c3Ready.generationId
    c3.signalBusiness('SIGUSR1')
    const rolled = await c3.waitFor(
      record => record.m4b2s === 'surface-status'
        && typeof record.generationId === 'number'
        && record.generationId !== generationBefore
        && record.sessionOpen === true,
      'T37 connection generation rollover',
      120_000,
    )
    assert(rolled.openSessionId === sessionA, 'T37 the rollover lost the retained Session')
    await c3.waitForScreen('session a', 'T37 retained transcript after reconnect')
    assert(alive(surfaceHostPid), 'T37 the Host died on the mux rollover')
    assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T37 C3')
    trace('t37', { generationBefore, generationAfter: rolled.generationId, sessionOpen: true, hostAlive: true })

    c3.send('/exit\r')
    const c3Exit = await c3.waitForExit(60_000)
    assert(c3Exit.code === 0, `T37 surface Client exit was ${JSON.stringify(c3Exit)}`)
    assert(alive(surfaceHostPid), 'T37 the Host died on the Client exit')
    await c3.dispose()

    // T61: ONE write parked in the REAL prompt serializer while the official
    // Connection generation is replaced by a physical mux drop. The stale
    // captured generation must not dispatch (Host durable log: zero
    // occurrences, no `indeterminate` notice), the draft returns exactly once,
    // and a NEW write on the rolled-over generation must commit exactly once —
    // the fence refuses the superseded write without poisoning the carrier.
    {
      const barrier = join(workDir, 't61-serializer-barrier')
      rmSync(barrier, { force: true })
      const staleToken = 't61-stale-generation'
      const liveToken = 't61-live-generation'
      const stalePriors = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
        .filter(text => text === staleToken).length
      assert(stalePriors === 0, 'T61 the stale token already exists in the Host durable log')
      const parked = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionA,
          SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: barrier,
        },
      })
      surfaceClients.push(parked)
      const parkedReady = await parked.waitFor(record => record.m4a0 === 'ready', 'T61 parked Client ready', 180_000)
      assert(parkedReady.sessionOpen === true && parkedReady.openSessionId === sessionA,
        'T61 the parked Client did not open the retained Session')
      const generationBefore = parkedReady.generationId
      assert(typeof generationBefore === 'number', 'T61 the Client never observed an official transport generation')
      parked.send(`${staleToken}\r`)
      // The write really reached the serializer (not merely "Enter was sent").
      const heldAt = await parked.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'serialize-held',
        'T61 serializer armed',
        60_000,
      )
      assert(Number.isInteger(heldAt.revision), 'T61 the serializer hold did not name the pinned revision')
      // ONE physical mux drop: the official Connection replaces the generation
      // while the write is still parked.
      parked.signalBusiness('SIGUSR1')
      const rolledOver = await parked.waitFor(
        record => record.m4b2s === 'surface-status'
          && typeof record.generationId === 'number'
          && record.generationId !== generationBefore
          && record.sessionOpen === true
          && record.openSessionId === sessionA,
        'T61 generation rollover',
        120_000,
      )
      assert(alive(surfaceHostPid), 'T61 the Host died on the mux rollover')
      assertClientHostFacts(rolledOver.host, surfaceHostFacts, 'T61 after rollover')
      writeFileSync(barrier, 'release\n', { mode: 0o600 })
      await parked.waitForComposerDraft(staleToken, 60_000)
      // The restored draft IS the writer's own settlement: the outcome is final
      // before the composer paints it, so no observation window is needed here.
      assert(!(await parked.viewport()).join('\n').includes('indeterminate'),
        'T61 the not-dispatched write was reported as indeterminate')
      // Restored EXACTLY once: the composer holds the token once, not twice.
      const restoredComposer = await parked.composerText()
      assert(restoredComposer !== undefined, 'T61 the composer disappeared after the refusal')
      const restoredOccurrences = restoredComposer.split(staleToken).length - 1
      assert(restoredOccurrences === 1,
        `T61 the draft was restored ${String(restoredOccurrences)} times, expected exactly once`)
      // Same Client process, CURRENT generation: a fresh prompt must commit.
      await parked.clearComposerDraft(staleToken)
      // Watermark: this Session already carries earlier turns from this lane, so a
      // bare `turn/end` wait could match HISTORY. Every fact below must be a NEW
      // durable event, i.e. one with an index at or after this snapshot.
      const beforeLive = (hostSessionEvents(dshHome, sessionA) ?? []).length
      parked.send(`${liveToken}\r`)
      const liveCommit = await (async () => {
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const texts = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
          const count = texts.filter(text => text === liveToken).length
          if (count >= 1) return count
          await sleep(100)
        }
        return 0
      })()
      assert(liveCommit >= 1, 'T61 the new generation never committed its write')
      // Ordering witness, not a timer: the new generation's turn ENDS after the
      // stale refusal, and the Host durable log still carries zero stale
      // writes — a dispatched superseded write would be ordered before it.
      const liveTurnEnd = await waitForHostSessionEventAfter(
        dshHome,
        sessionA,
        beforeLive,
        event => event.type === 'turn/end',
        'T61 new-generation turn/end',
        120_000,
      )
      assert(liveTurnEnd !== undefined, 'T61 the new generation wrote no turn/end at all')
      // EXACTLY-ONCE is a property of the FINAL durable state, never of the first
      // observation: a duplicate commit that lands after the first sighting would
      // otherwise pass unnoticed. The whole Session log is re-read here, after the
      // new Turn has ENDED, and every count is asserted on that read.
      const finalEvents = hostSessionEvents(dshHome, sessionA) ?? []
      const finalLive = hostUserTexts(finalEvents).filter(text => text === liveToken).length
      assert(finalLive === 1,
        `T61 the new generation committed ${String(finalLive)} times, expected exactly 1`)
      const afterLive = finalEvents.slice(beforeLive)
      const liveStarts = afterLive.filter(event => event.type === 'turn/start').length
      const liveEnds = afterLive.filter(event => event.type === 'turn/end').length
      assert(liveStarts === 1,
        `T61 the new generation started ${String(liveStarts)} Turns, expected exactly 1`)
      assert(liveEnds === 1,
        `T61 the new generation ended ${String(liveEnds)} Turns, expected exactly 1`)
      assert(hostUserTexts(finalEvents).filter(text => text === staleToken).length === 0,
        'T61 the superseded write was dispatched or replayed')
      await parked.waitForScreen('stub answer', 'T61 new-generation answer')
      assert(alive(surfaceHostPid), 'T61 the Host died on the new-generation write')
      // The surface section predates the C1 helpers, so this case uses the
      // same inline exit idiom as T29/T31/T33/T37 above.
      parked.send('/exit\r')
      const parkedExit = await parked.waitForExit(60_000)
      assert(parkedExit.code === 0 && parkedExit.signal === null,
        `T61 parked Client exit was ${JSON.stringify(parkedExit)}`)
      await parked.dispose()
      trace('t61', {
        oldGeneration: generationBefore,
        newGeneration: rolledOver.generationId,
        source: 'real-websocket-drop',
        staleWrite: 'not-dispatched',
        oldHostWrites: 0,
        newHostWrites: 1,
        draftRestoredOnce: true,
        hostIdentityKept: true,
      })
    }

    // T39: a missing official Client Domain module means NO surface ready;
    // the failure is loud and the Host stays alive. (The Host-side missing
    // Session row is T26b and still runs above.)
    const sessionControllerClient = createRequire(anchor).resolve('@deepseek-ai/dsh-api-session-controller/client')
    renameSync(sessionControllerClient, `${sessionControllerClient}.missing`)
    let missingDomain
    try {
      missingDomain = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      surfaceClients.push(missingDomain)
      const failure = await missingDomain.waitFor(record => record.m4a0 === 'failure', 'T39 missing Client Domain module', 120_000)
      assert(!missingDomain.records.some(record => record.m4a0 === 'ready'),
        'T39 a missing official Client Domain module still emitted ready')
      assert(missingDomain.records.find(record => record.m4a0 === 'ready') === undefined,
        'T39 a missing official Client Domain module published a surface')
      assert(/Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT|not found/iu.test(JSON.stringify(failure)),
        `T39 unexpected missing-module error: ${JSON.stringify(failure.error ?? failure)}`)
      assert(alive(surfaceHostPid), 'T39 the missing Client Domain module killed the Host')
      trace('t39', { readyEmitted: false, failure: 'module-missing', hostAlive: true })
    } finally {
      renameSync(`${sessionControllerClient}.missing`, sessionControllerClient)
      await missingDomain?.dispose()
    }

    await surfaceHost.shutdown()
    surfaceHostClosed = true
    assert(!alive(surfaceHostPid), 'T40 the surface Host survived its owner-governed shutdown')
    assert(!existsSync(join(scopeDir, 'instance.json')), 'T40 the Host registry survived its owner-governed shutdown')
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'T40 the candidate artifact changed during qualification')
    trace('t40', {
      candidate: basename(tarball),
      sha256: candidateSha256,
      dshVersion: targetDshVersion,
      // The inventory claim belongs to a FULL run: a selected surface case never
      // executes T01-T26 or the Direct `--help` positive, so it must not report
      // them as passed. The event name and the full-mode fields stay compatible.
      ...(mode === 'full'
        ? {
            directHelp: 'pass',
            t01t26: 'pass (T26a row-disabled + real artifact-absent; T26b official row; T26 no-cookie)',
          }
        : {}),
      surface: 'T27-T39 + T41/T42/T43 pass',
    })
  } finally {
    for (const client of surfaceClients) await client.dispose()
    if (!surfaceHostClosed) {
      try { await surfaceHost.shutdown() } catch { /* the runner backstop owns leftovers */ }
    }
  }
  // T40 cleanup proof: the owner-governed shutdown released the kernel seat. The
  // finally owns the failure path and the runner owns the abort backstop.
  await seatFree(`\0dsh-pi-tui-h-${surfaceHostReady.localHost.scopeId.slice(0, 40)}`, 10_000)
  trace('t40-seat-free', { hostSeat: 'free', registryRemoved: true })
}
