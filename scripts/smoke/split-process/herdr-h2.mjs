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
    await sleep(1000)
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
    assert(states(clientLog).includes('working') || states(clientLog).includes('idle'),
      'H2 the Session A report must follow a real H1 state registration')
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
