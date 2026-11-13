/**
 * H2 Herdr Session identity on the REAL Split Host/Client pair.
 *
 * ```text
 * real Split Client (sessionless -> A -> /new -> B)
 *   -> official committed owner (SessionOwnershipCore scope invalidation)
 *   -> Client-local Herdr reporter
 *   -> executable fake Herdr CLI (one OS process per dispatch)
 * ```
 *
 * The case proves:
 * 1. a sessionless Remote Client reports NO `report-agent-session`; after a
 *    real `openC1Session()` the Client reports the full canonical id on the
 *    SAME queue AFTER its H1 `report-agent`, and never a resume argv;
 * 2. a real `/new` owner change reports the NEW id B; a late A never follows B;
 * 3. the real H1 RH-02 transport rollover (`SIGUSR1`, with the Host frozen by
 *    `SIGSTOP` so the loss window is deterministic) withdraws the Pane with an
 *    ordered `release-agent`, and only a NEW legal Host progress snapshot may
 *    re-register the CURRENT id B; the held Host Turns are never cancelled and
 *    the Host identity is unchanged;
 * 4. the Host process, given its own complete Herdr environment, still creates
 *    no reporter and writes nothing to its fake CLI log;
 * 5. every source / agent / Pane id / seq fact comes from the real spawned CLI
 *    argv, not from a log description.
 *
 * @module split-process/herdr-h2
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  assertClientHostFacts,
  lastSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The fake Herdr CLI: append ONE tab-separated line with the real argv. */
const FAKE_HERDR_CLI = `#!/bin/sh
{
  printf 'start\\t%s' "$PPID"
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$HERDR_FAKE_LOG"
`

/** One parsed fake-CLI invocation. */
/** @typedef {{ phase: string, ppid: number, argv: string[] }} HerdrInvocation */

/** @returns {HerdrInvocation[]} */
function readInvocations(logPath) {
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
  return lines.map((line) => {
    const [phase, rawPpid, ...argv] = line.split('\t')
    assert(phase === 'start' && rawPpid !== undefined, `H2 the fake Herdr CLI wrote a malformed line: ${JSON.stringify(line)}`)
    return { phase, ppid: Number(rawPpid), argv }
  })
}

/** The ordered H1 Pane facts ONLY: `report-agent` states and releases.
 *  `report-agent-session` is NOT a state (the H1 helper must stay unchanged). */
function states(logPath) {
  return readInvocations(logPath)
    .filter(({ argv }) => argv[1] === 'report-agent' || argv[1] === 'release-agent')
    .map(({ argv }) => {
      if (argv[1] === 'release-agent') return 'release'
      const index = argv.indexOf('--state')
      return index < 0 ? '(missing-state)' : argv[index + 1]
    })
}

/** The ordered Pane command kinds on this log (state | session | release). */
function startCommands(logPath) {
  return readInvocations(logPath).map(({ argv }) => {
    if (argv[1] === 'release-agent') return 'release'
    if (argv[1] === 'report-agent-session') return 'session'
    return 'state'
  })
}

/** Every H2 Session report, with its recovery argv parsed strictly after `--`. */
function sessionFacts(logPath) {
  return readInvocations(logPath)
    .filter(({ argv }) => argv[1] === 'report-agent-session')
    .map(({ argv }) => {
      const idIndex = argv.indexOf('--agent-session-id')
      assert(idIndex >= 0 && argv[idIndex + 1] !== undefined,
        `H2 a report-agent-session invocation carried no --agent-session-id: ${JSON.stringify(argv)}`)
      const separator = argv.indexOf('--')
      return {
        sessionId: argv[idIndex + 1],
        ...(separator < 0 ? {} : { resumeArgv: argv.slice(separator + 1) }),
        argv,
      }
    })
}

function argAfter(argv, flag) {
  const index = argv.indexOf(flag)
  assert(index >= 0 && argv[index + 1] !== undefined, `H2 missing ${flag} in ${JSON.stringify(argv)}`)
  return argv[index + 1]
}

/** Every invocation belongs to the declared Pane/source/agent and carries seq. */
function assertPaneOwnership(logPath, paneId) {
  for (const { argv } of readInvocations(logPath)) {
    assert(argv[0] === 'pane', `H2 unexpected subcommand ${JSON.stringify(argv)}`)
    assert(argv[2] === paneId, `H2 the Pane ${JSON.stringify(paneId)} log received ${JSON.stringify(argv)}`)
    assert(argAfter(argv, '--source') === 'dsh-pi-tui', `H2 wrong source in ${JSON.stringify(argv)}`)
    assert(argAfter(argv, '--agent') === 'dsh-pi-tui', `H2 wrong agent in ${JSON.stringify(argv)}`)
    assert(Number.isSafeInteger(Number(argAfter(argv, '--seq'))), `H2 no integer seq in ${JSON.stringify(argv)}`)
  }
}

/** Wait for a bounded predicate over the current fake-CLI log. */
async function waitForLog(logPath, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(readInvocations(logPath))) return
    if (Date.now() > deadline) {
      throw new SplitSmokeAssertionError(
        `H2 ${label} did not occur within ${String(timeoutMs)}ms; the log is:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(missing)'}`,
      )
    }
    await sleep(50)
  }
}

function herdrClientEnv(scriptPath, logPath, paneId) {
  return {
    HERDR_ENV: '1',
    HERDR_PANE_ID: paneId,
    HERDR_BIN_PATH: scriptPath,
    HERDR_SOCKET_PATH: join(logPath, '..', 'herdr-h2.sock'),
    HERDR_FAKE_LOG: logPath,
  }
}

/** Run the H2 Split Host/Client qualification. */
export async function runHerdrH2(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context)
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const scriptPath = join(workDir, `herdr-h2-fake-cli-${unique}.sh`)
  writeFileSync(scriptPath, FAKE_HERDR_CLI, { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  const hostLog = join(workDir, `herdr-h2-host-${unique}.log`)
  const clientLog = join(workDir, `herdr-h2-client-${unique}.log`)
  const holdBarrier = join(workDir, `herdr-h2-hold-${unique}.barrier`)
  const paneId = `herdr-h2-pane-${unique}`
  // The Host receives a complete, deliberately different Herdr environment:
  // a reporter there would bind a Pane the Host does not own, so this log MUST
  // stay empty for the whole case.
  const hostHerdrEnv = herdrClientEnv(scriptPath, hostLog, `host-must-never-report-${unique}`)
  const {
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
  } = scene
  try {
    const { host, ready: hostReady, workRoot } = await startC1Host(
      'long-turn',
      `herdr-h2-${unique}`,
      { ...hostHerdrEnv, C1_HOLD_LONG_TURN: holdBarrier },
    )
    const { client, ready: clientReady } = await startC1Client(
      `H2 Client ${unique}`,
      herdrClientEnv(scriptPath, clientLog, paneId),
    )

    // ── Sessionless: no Session report may exist ─────────────────────────────
    assert(clientReady.sessionOpen === false, 'H2 the Client must start sessionless')
    // The negative is anchored on a REAL fact, not on a time window: the Ready
    // record itself proves no Session was ever opened, so no Session command may
    // exist at this point. The positive A/B Sessions below prove the Client
    // would have reported one (the same log then carries them).
    assert(!client.records.some(record => record.m4b2s === 'surface-status' && record.sessionOpen === true),
      'H2 the Client opened a Session before the first prompt')
    assert(sessionFacts(clientLog).length === 0, 'H2 a sessionless Client reported a Session')

    // ── Session A: the real first prompt is held by the Host fixture ────────
    const sessionA = await openC1Session(client, `herdr h2 a ${unique}`, `H2 A ${unique}`)
    await waitForC1WorkEvent(
      workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionA,
      'H2 A Turn held',
    )
    await waitForLog(clientLog, () => sessionFacts(clientLog).some(fact => fact.sessionId === sessionA),
      'H2 the first canonical Session A')
    assert(sessionFacts(clientLog).every(fact => fact.resumeArgv === undefined),
      'H2 a Remote Client must never report a resume argv')
    // The registration order is a fact of the log: the first H1 state command
    // must precede the first Session command (Herdr rejects a Session report
    // before the Pane is held).
    const firstStateAt = startCommands(clientLog).indexOf('state')
    const firstSessionAt = startCommands(clientLog).indexOf('session')
    assert(firstStateAt >= 0 && firstSessionAt > firstStateAt,
      `H2 the Session report must follow the first state registration; the log is ${JSON.stringify(startCommands(clientLog))}`)
    assertPaneOwnership(clientLog, paneId)

    // ── A -> B through the real /new owner change ───────────────────────────
    const beforeNew = client.records.length
    client.send('/new\r')
    const onB = await client.waitFor(
      record => client.records.indexOf(record) >= beforeNew
        && record.m4b2s === 'surface-status'
        && record.sessionOpen === true
        && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionA,
      'H2 /new committed Session B',
      120_000,
    )
    const sessionB = onB.openSessionId
    await waitForLog(clientLog, () => sessionFacts(clientLog).some(fact => fact.sessionId === sessionB),
      'H2 the new owner Session B')
    const afterB = sessionFacts(clientLog)
    const bIndex = afterB.findIndex(fact => fact.sessionId === sessionB)
    assert(bIndex >= 0 && afterB.slice(bIndex).every(fact => fact.sessionId === sessionB),
      `H2 Session A must never arrive after B; the Session log is ${JSON.stringify(afterB.map(f => f.sessionId))}`)
    assert(afterB.every(fact => fact.resumeArgv === undefined),
      'H2 the Remote Split Client must never publish a resume command')

    // ── A REAL held Turn on the CURRENT Session B (the turn kept across loss) ─
    client.send(`herdr h2 b ${unique}\r`)
    await waitForC1WorkEvent(
      workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionB,
      'H2 B Turn held',
    )
    await waitForLog(clientLog, () => states(clientLog).at(-1) === 'working',
      'H2 B working', 120_000)
    const beforeLoss = lastSurfaceStatus(client)
    assert(typeof beforeLoss?.generationId === 'number', 'H2 the Client never observed an official transport generation')
    const hostBefore = beforeLoss.host
    const releasesBeforeLoss = states(clientLog).filter(state => state === 'release').length
    const sessionsBeforeLoss = sessionFacts(clientLog).length

    // ── The real RH-02 rollover: freeze the Host, then drop the real mux ────
    process.kill(hostReady.pid, 'SIGSTOP')
    let resumed = false
    const resumeHost = () => {
      if (resumed) return
      resumed = true
      process.kill(hostReady.pid, 'SIGCONT')
    }
    let rolled
    try {
      const rolloverBoundary = client.records.length
      client.signalBusiness('SIGUSR1')
      await client.waitFor(
        record => client.records.indexOf(record) >= rolloverBoundary
          && record.m4b2s === 'qualification' && record.op === 'drop-websocket',
        'H2 the qualification mux drop was injected',
        30_000,
      )
      await client.waitFor(
        record => client.records.indexOf(record) >= rolloverBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        'H2 the Client observed the official lost generation',
        60_000,
      )
      await waitForLog(clientLog,
        () => states(clientLog).filter(state => state === 'release').length > releasesBeforeLoss,
        'H2 the ordered release while the generation is still invalid', 60_000)
      assert(sessionFacts(clientLog).length === sessionsBeforeLoss,
        'H2 no Session may be reported while the Client lost its Host qualification')
      const lossWindow = lastSurfaceStatus(client)
      assert(lossWindow?.generationId === undefined && lossWindow.transport !== 'connected',
        `H2 the release must land before reconnect; the Client status was ${JSON.stringify(lossWindow)}`)
    } finally {
      resumeHost()
    }

    // ── Recovery: only the NEW generation's legal snapshot re-registers B ───
    rolled = await client.waitFor(
      record => record.m4b2s === 'surface-status'
        && typeof record.generationId === 'number'
        && record.generationId !== beforeLoss.generationId
        && record.transport === 'connected'
        && record.sessionOpen === true
        && record.openSessionId === sessionB
        && record.surfaceMounted === true,
      'H2 the Client reconnected on a NEW official generation with Session B current',
      120_000,
    )
    assert(rolled.pid === beforeLoss.pid && rolled.surfaceRevision === beforeLoss.surfaceRevision,
      'H2 the rollover must keep the same business PID and surface revision')
    assertClientHostFacts(rolled.host, hostBefore, 'H2 the same authenticated Host')
    assert(alive(hostReady.pid), 'H2 the Host died during the transport rollover')
    assert(!existsSync(holdBarrier), 'H2 the rollover released the held Host Turns')

    const releaseAt = states(clientLog).lastIndexOf('release')
    await waitForLog(clientLog, () => {
      const observed = states(clientLog)
      const requalifiedState = observed.indexOf('working', releaseAt + 1)
      const currentSessions = sessionFacts(clientLog)
      return requalifiedState >= 0
        && currentSessions.length > sessionsBeforeLoss
        && currentSessions.at(-1)?.sessionId === sessionB
    }, 'H2 the requalified working state and Session B on the NEW generation', 120_000)
    const afterRecovery = sessionFacts(clientLog)
    assert(afterRecovery.slice(sessionsBeforeLoss).every(fact => fact.sessionId === sessionB),
      `H2 only the CURRENT Session B may follow the release; the log is ${JSON.stringify(afterRecovery.map(f => f.sessionId))}`)

    // ── Release the held Turns and prove the Host never stopped them ────────
    writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEvent(dshHome, sessionA, event => event.type === 'turn/end', `H2 A ${unique} turn/end`, 120_000)
    await waitForHostSessionEvent(dshHome, sessionB, event => event.type === 'turn/end', `H2 B ${unique} turn/end`, 120_000)
    await waitForLog(clientLog, () => states(clientLog).at(-1) === 'idle', 'H2 idle after the B Turn', 120_000)
    assert(alive(hostReady.pid), 'H2 the Host died after the released Turns')

    // ── Client exit: one ordered release, no later Session, Host untouched ──
    const releasesBeforeExit = states(clientLog).filter(state => state === 'release').length
    await exitC1Client(client, `H2 Client ${unique}`)
    await waitForLog(clientLog,
      () => states(clientLog).filter(state => state === 'release').length === releasesBeforeExit + 1,
      'H2 the exit release', 60_000)
    assert(sessionFacts(clientLog).every(fact => fact.resumeArgv === undefined),
      'H2 a Remote Client may never save a resume command')
    assert(alive(hostReady.pid), 'H2 the Host died when the Client exited')
    await stopC1Host(host)

    assert(readInvocations(hostLog).length === 0,
      `H2 the Host process created a Pane reporter: ${JSON.stringify(readInvocations(hostLog))}`)
    trace('herdr-h2-session-publication', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: hostReady.pid,
      clientPid: clientReady.pid,
      sessionA,
      sessionB,
      states: states(clientLog),
      sessions: sessionFacts(clientLog).map(fact => fact.sessionId),
      hostReportedNothing: true,
    })

    return {
      status: 'PASS',
      rhH2Session: 'REAL_SPLIT_PROCESS_L6',
      hostReportedNothing: true,
      sessionA,
      sessionB,
      states: states(clientLog),
    }
  } finally {
    await scene.dispose()
  }
}

/**
 * H3 abrupt lifecycle: the ONE independent forced-process-exit qualification.
 *
 * Two sub-scenes, each with its own scope/pid/Pane/fake-CLI log, both built on
 * the SAME real `createC1Scene` Host/Client lifecycle as the H2 case above:
 *
 * 1. H3-S1 — a real SIGKILL on Pane A's OS PID. The killed process can never
 *    run its own release; the Host keeps the held Turn, and Pane B (attached
 *    to the same Session) keeps receiving the Host's facts, is never released
 *    by A's death, and later exits with exactly ONE ordered release.
 * 2. H3-S2 — a real SIGKILL on the Host OS PID (not the H2 frozen-Host mux
 *    dropout). The stale generation must lose its business qualification: the
 *    surviving Client fail-closes with the ordered reporter release and never
 *    re-registers the stale generation, or the Client exits by itself and the
 *    real Herdr Pane shell fallback owns the external cleanup. Re-entry
 *    happens ONLY through the existing Host/Client launch entries.
 *
 * ```text
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   built actual DSH distribution; real Linux Host OS PID;
 *   authenticated official Split Client OS PID(s);
 *   real Session owner/Agent/Turn, generation and real event stream;
 *   actual Client-local Herdr reporter spawning real OS child processes;
 *   actual SIGKILL target process and kernel exit observation.
 * TEST STAND-INS / SUBSTITUTIONS:
 *   executable fake Herdr CLI logs argv/exit; no real Herdr socket/server/UI;
 *   deterministic held-turn barrier; isolated DSH_HOME/profile/workspace.
 * DELIBERATELY ABSENT:
 *   public Split attach CLI, Herdr App, Tern TSP,
 *   true Herdr shell fallback, real Herdr named session restore.
 * ```
 */
export async function runHerdrH3(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context)
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const scriptPath = join(workDir, `herdr-h3-fake-cli-${unique}.sh`)
  writeFileSync(scriptPath, FAKE_HERDR_CLI, { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  const {
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    awaitSceneSeatFree,
  } = scene
  try {
    // ── H3-S1: Client SIGKILL — the Host and the other Pane are untouched ───
    const s1Hold = join(workDir, `herdr-h3-s1-hold-${unique}.barrier`)
    const s1HostLog = join(workDir, `herdr-h3-s1-host-${unique}.log`)
    // The Host receives a complete, deliberately different Herdr environment:
    // its fake log MUST stay empty for the whole case (a Host never owns a
    // Pane reporter).
    const s1HostEnv = herdrClientEnv(scriptPath, s1HostLog, `host-must-never-report-s1-${unique}`)
    const { host: s1Host, ready: s1Ready, workRoot: s1WorkRoot } = await startC1Host(
      'long-turn',
      `herdr-h3-s1-${unique}`,
      { ...s1HostEnv, C1_HOLD_LONG_TURN: s1Hold },
    )
    const paneA = `herdr-h3-pane-a-${unique}`
    const paneB = `herdr-h3-pane-b-${unique}`
    const logA = join(workDir, `herdr-h3-client-a-${unique}.log`)
    const logB = join(workDir, `herdr-h3-client-b-${unique}.log`)
    const { client: clientA, ready: clientAReady } = await startC1Client(
      `H3 Pane A ${unique}`,
      herdrClientEnv(scriptPath, logA, paneA),
    )
    const sessionA = await openC1Session(clientA, `herdr h3 a ${unique}`, `H3 A ${unique}`)
    await waitForC1WorkEvent(
      s1WorkRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionA,
      `H3 A ${unique} Turn held`,
    )
    await waitForLog(logA, () => states(logA).at(-1) === 'working', `H3 A ${unique} working`)
    // Pane B attaches to the SAME running Session: its opening snapshot is the
    // Host's running truth, so Pane B starts at working, never a fake idle.
    const { client: clientB, ready: clientBReady } = await startC1Client(
      `H3 Pane B ${unique}`,
      { ...herdrClientEnv(scriptPath, logB, paneB), SPLIT_PROCESS_CLIENT_SESSION: sessionA },
    )
    await clientB.waitFor(
      record => record.m4b2s === 'surface-status' && record.transport === 'connected'
        && record.sessionOpen === true && record.openSessionId === sessionA,
      `H3 B ${unique} opened the same Session from the Host snapshot`,
      120_000,
    )
    await waitForLog(logB, () => states(logB).at(-1) === 'working', `H3 B ${unique} opening working`)
    assert(clientAReady.pid !== clientBReady.pid, 'H3 the two Clients must be distinct OS processes')

    // The abrupt exit: SIGKILL Pane A's real OS process. The killed process
    // CANNOT run its own dispose, and no assertion may pretend a release.
    const pidA = clientAReady.pid
    const bReleasesBeforeKill = states(logB).filter(state => state === 'release').length
    process.kill(pidA, 'SIGKILL')
    const exitA = await clientA.waitForExit(60_000)
    assert(exitA.signal === 'SIGKILL' || exitA.code === 137,
      `H3 Pane A was not SIGKILLed: ${JSON.stringify(exitA)}`)
    // The negative controls: the Host and Pane B keep their authority.
    assert(alive(s1Ready.pid), 'H3 the Host died with the SIGKILLed Pane A')
    const bStatusAfterKill = lastSurfaceStatus(clientB)
    assert(bStatusAfterKill?.transport === 'connected' && typeof bStatusAfterKill?.generationId === 'number',
      `H3 Pane B lost its Host connection when Pane A crashed: ${JSON.stringify(bStatusAfterKill)}`)
    await waitForLog(logB, () => states(logB).at(-1) === 'working', `H3 B ${unique} still working after A died`)
    assertPaneOwnership(logB, paneB)
    assert(states(logB).filter(state => state === 'release').length === bReleasesBeforeKill,
      'H3 Pane B must not be released because Pane A died')

    // The held Turn belongs to the Host: releasing the barrier finishes it and
    // Pane B (not the dead Pane A) observes the real turn/end. The fixture
    // records `long-turn-released` ONLY after the barrier is observed, so this
    // event is the decisive proof that the Host kept the Turn alive across the
    // Client crash instead of cancelling it.
    writeFileSync(s1Hold, 'release\n', { mode: 0o600 })
    await waitForC1WorkEvent(
      s1WorkRoot,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionA,
      `H3 A ${unique} Turn released by the Host after the barrier`,
    )
    await waitForHostSessionEvent(dshHome, sessionA, event => event.type === 'turn/end', `H3 A ${unique} turn/end`)
    await waitForLog(logB, () => states(logB).at(-1) === 'idle', `H3 B ${unique} idle after the held Turn`)
    // A late in-flight CLI of the killed Pane A may finish by itself; it must
    // never be mistaken for the release the killed process cannot send.
    assert(states(logA).every(state => state !== 'release'),
      `H3 the SIGKILLed Pane A reported a release: ${JSON.stringify(states(logA))}`)
    // Pane B's own normal exit releases exactly Pane B once.
    await exitC1Client(clientB, `H3 Pane B ${unique}`)
    await waitForLog(logB,
      () => states(logB).filter(state => state === 'release').length === bReleasesBeforeKill + 1,
      `H3 B ${unique} exit release`, 60_000)
    assert(alive(s1Ready.pid), 'H3 the Host died when Pane B exited')
    await stopC1Host(s1Host)
    assert(readInvocations(s1HostLog).length === 0,
      `H3 the S1 Host process created a Pane reporter: ${JSON.stringify(readInvocations(s1HostLog))}`)
    trace('herdr-h3-client-crash', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: s1Ready.pid,
      paneA: { pid: pidA, pane: paneA, states: states(logA) },
      paneB: { pid: clientBReady.pid, pane: paneB, states: states(logB) },
      sessionA,
      hostReportedNothing: true,
    })

    // ── H3-S2: Host SIGKILL — stale authority must not survive ─────────────
    const s2Hold = join(workDir, `herdr-h3-s2-hold-${unique}.barrier`)
    const s2HostLog = join(workDir, `herdr-h3-s2-host-${unique}.log`)
    const s2HostEnv = herdrClientEnv(scriptPath, s2HostLog, `host-must-never-report-s2-${unique}`)
    const { host: s2Host, ready: s2Ready, workRoot: s2WorkRoot } = await startC1Host(
      'long-turn',
      `herdr-h3-s2-${unique}`,
      { ...s2HostEnv, C1_HOLD_LONG_TURN: s2Hold },
    )
    const paneC = `herdr-h3-pane-c-${unique}`
    const logC = join(workDir, `herdr-h3-client-c-${unique}.log`)
    const { client: clientC } = await startC1Client(
      `H3 Pane C ${unique}`,
      herdrClientEnv(scriptPath, logC, paneC),
    )
    const sessionC = await openC1Session(clientC, `herdr h3 c ${unique}`, `H3 C ${unique}`)
    await waitForC1WorkEvent(
      s2WorkRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionC,
      `H3 C ${unique} Turn held`,
    )
    await waitForLog(logC, () => states(logC).at(-1) === 'working', `H3 C ${unique} working`)
    const staleStatus = lastSurfaceStatus(clientC)
    assert(staleStatus?.transport === 'connected' && typeof staleStatus?.generationId === 'number',
      `H3 C ${unique} never held an authenticated Host generation: ${JSON.stringify(staleStatus)}`)
    const oldHostPid = s2Ready.pid
    // The record boundary belongs BEFORE the abrupt exit: the Client reacts to
    // the dead Host within milliseconds, so a boundary taken after the SIGKILL
    // can already contain the very loss record it is meant to find. The same
    // pre-kill baseline anchors the fail-close release: a release that already
    // existed while the Host was connected must never satisfy the stale one.
    const lossBoundary = clientC.records.length
    const cReleasesBeforeKill = states(logC).filter(state => state === 'release').length

    // The abrupt Host death: a real SIGKILL on the Host OS process, observed
    // to termination — never the H2 frozen-Host mux dropout.
    process.kill(oldHostPid, 'SIGKILL')
    const hostExit = await s2Host.waitForExit(60_000)
    assert(hostExit.signal === 'SIGKILL' || hostExit.code === 137,
      `H3 the Host was not SIGKILLed: ${JSON.stringify(hostExit)}`)
    assert(!alive(oldHostPid), 'H3 the old Host process survived its SIGKILL')

    // The stale generation loses its business qualification. The ONE hard
    // contract "stale authority must not keep reporting" has two real
    // observable process outcomes, and the case accepts exactly these two:
    // a) the surviving Client fail-closes with the ordered reporter release
    //    and never re-registers the stale generation;
    // b) the Client exits by itself (recorded, never fabricated) and the real
    //    Herdr Pane shell fallback owns the external cleanup.
    let clientSurvived = true
    try {
      await clientC.waitFor(
        record => clientC.records.indexOf(record) >= lossBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        `H3 C ${unique} observed the dead Host generation`,
        90_000,
      )
    } catch (error) {
      if (!clientC.exited) throw error
      clientSurvived = false
    }
    if (clientSurvived) {
      await waitForLog(logC,
        () => states(logC).filter(state => state === 'release').length > cReleasesBeforeKill,
        `H3 C ${unique} released its Pane on the stale generation`, 90_000)
    } else {
      const clientExit = await clientC.waitForExit(30_000)
      trace('herdr-h3-host-crash-client-exit', {
        scope: 'REAL_SPLIT_PROCESS_L6',
        oldHostPid,
        clientExit: { code: clientExit.code, signal: clientExit.signal },
      })
    }
    // The stale authority must not keep reporting. The Client cannot reach a
    // dead Host, so within this bounded observation window no new Pane fact
    // and no requalified connection may appear (a bounded negative, not an
    // impossibility claim).
    const staleDeadline = Date.now() + 15_000
    while (Date.now() < staleDeadline && !clientC.exited) {
      if (clientSurvived) {
        const commands = startCommands(logC)
        const lastRelease = commands.lastIndexOf('release')
        assert(lastRelease >= 0 && commands.slice(lastRelease).every(kind => kind === 'release'),
          `H3 a new Pane fact followed the stale release: ${JSON.stringify(commands)}`)
      }
      assert(clientC.records.every((record, index) => index < lossBoundary
          || !(record.m4b2s === 'surface-status' && record.transport === 'connected')),
        'H3 the stale Client requalified against a dead Host')
      await sleep(250)
    }
    assertPaneOwnership(logC, paneC)

    // Re-enter ONLY through the existing launch entries: a NEW Host generation
    // and a NEW Client Pane, each proving its own authenticated identity
    // before any report. Nothing is guessed from the old instance.json or the
    // old Client snapshot.
    await awaitSceneSeatFree(30_000)
    const s2bHold = join(workDir, `herdr-h3-s2b-hold-${unique}.barrier`)
    const { host: s2bHost, ready: s2bReady, workRoot: s2bWorkRoot } = await startC1Host(
      'long-turn',
      `herdr-h3-s2b-${unique}`,
      { ...s2HostEnv, C1_HOLD_LONG_TURN: s2bHold },
    )
    assert(s2bReady.pid !== oldHostPid, 'H3 the re-entry Host reused the dead Host OS PID')
    const paneD = `herdr-h3-pane-d-${unique}`
    const logD = join(workDir, `herdr-h3-client-d-${unique}.log`)
    const { client: clientD, ready: clientDReady } = await startC1Client(
      `H3 Pane D ${unique}`,
      herdrClientEnv(scriptPath, logD, paneD),
    )
    const sessionD = await openC1Session(clientD, `herdr h3 d ${unique}`, `H3 D ${unique}`)
    await waitForC1WorkEvent(
      s2bWorkRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionD,
      `H3 D ${unique} Turn held`,
    )
    await waitForLog(logD, () => states(logD).at(-1) === 'working', `H3 D ${unique} working`)
    await waitForLog(logD, () => sessionFacts(logD).some(fact => fact.sessionId === sessionD),
      `H3 D ${unique} canonical Session`)
    const dStatus = lastSurfaceStatus(clientD)
    assert(dStatus?.transport === 'connected' && typeof dStatus?.generationId === 'number',
      `H3 D ${unique} reported without an authenticated generation: ${JSON.stringify(dStatus)}`)
    assert(sessionFacts(logD).every(fact => fact.resumeArgv === undefined),
      'H3 the re-entry Split Client must never publish a resume argv')
    writeFileSync(s2bHold, 'release\n', { mode: 0o600 })
    await waitForHostSessionEvent(dshHome, sessionD, event => event.type === 'turn/end', `H3 D ${unique} turn/end`)
    await waitForLog(logD, () => states(logD).at(-1) === 'idle', `H3 D ${unique} idle after the held Turn`)
    assertPaneOwnership(logD, paneD)
    await exitC1Client(clientD, `H3 Pane D ${unique}`)
    await stopC1Host(s2bHost)
    assert(readInvocations(s2HostLog).length === 0,
      `H3 the S2 Host processes created a Pane reporter: ${JSON.stringify(readInvocations(s2HostLog))}`)
    trace('herdr-h3-host-crash', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      oldHostPid,
      newHostPid: s2bReady.pid,
      clientSurvived,
      sessionC,
      sessionD,
      paneD: { pid: clientDReady.pid, pane: paneD, states: states(logD) },
      hostReportedNothing: true,
    })

    return {
      status: 'PASS',
      rhH3ClientCrash: 'REAL_SPLIT_PROCESS_L6',
      rhH3HostCrash: 'REAL_SPLIT_PROCESS_L6',
      hostReportedNothing: true,
    }
  } finally {
    await scene.dispose()
  }
}
