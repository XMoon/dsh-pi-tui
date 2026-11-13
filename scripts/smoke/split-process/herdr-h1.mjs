/**
 * H1 Herdr Pane-state integration on the REAL Split Host/Client pair.
 *
 * ```text
 * real Host Agent state (long-turn / question scenarios)
 *   -> Host terminal-progress row -> real private wire
 *   -> real Split Client bootstrap -> Client-local Herdr reporter
 *   -> executable fake Herdr CLI (one OS process per dispatch)
 * ```
 *
 * RH-01 (positive): a held real Host turn reports `working`; releasing it
 * reports `idle`; a real Host Question reports `blocked`, the legal answer
 * returns `working`, and the completed turn reports `idle`.
 *
 * RH-03 (multi-client): two REAL Split Clients on ONE Host with two different
 * Herdr Pane environments each update only their own Pane id; one Client's exit
 * neither cancels the Host nor withdraws the other Pane.
 *
 * RH-02 (disconnect/reconnect): the qualification-only `SIGUSR1` mux drop
 * (the M5D-03 manual: the REAL physical transport is lost, the official
 * generation is invalidated, and a NEW generation re-adopts the exact Session
 * with the Client PID, surface revision and held Host turn untouched) is
 * applied to a real Split Client whose Host turn is held. The held turn must
 * NEVER be reported as `idle` (a lost transport is not an Agent completion);
 * an ordered `release-agent` withdraws the Pane while the transport is down,
 * and the re-adopted owner reports `working` again from the NEW generation's
 * authoritative snapshot before the turn settles to `idle`.
 *
 * The Host ALSO receives a Herdr environment pointing at its OWN fake CLI log:
 * the Host process must never create a reporter or spawn a Pane command. That
 * log must stay empty for the whole case.
 *
 * @module split-process/herdr-h1
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, lastSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The fake Herdr CLI: append ONE tab-separated line with the spawning process
 * id and the complete argv, then exit successfully. The argv is the evidence;
 * the script interprets no argument and writes nothing else.
 */
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
    assert(phase === 'start' && rawPpid !== undefined, `H1 the fake Herdr CLI wrote a malformed line: ${JSON.stringify(line)}`)
    return { phase, ppid: Number(rawPpid), argv }
  })
}

/** The ordered Pane facts one Client log observed. */
function states(logPath) {
  return readInvocations(logPath).map(({ argv }) => {
    if (argv[1] === 'release-agent') return 'release'
    const index = argv.indexOf('--state')
    return index < 0 ? '(missing-state)' : argv[index + 1]
  })
}

/** Wait for a bounded predicate over the current fake-CLI log. */
async function waitForLog(logPath, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(readInvocations(logPath))) return
    if (Date.now() > deadline) {
      throw new SplitSmokeAssertionError(
        `H1 ${label} did not occur within ${String(timeoutMs)}ms; the log is:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(missing)'}`,
      )
    }
    await sleep(50)
  }
}

/** Wait for the ordered state list to contain `sequence` as a subsequence. */
async function waitForStateSequence(logPath, sequence, label, timeoutMs = 120_000) {
  await waitForLog(logPath, () => {
    const observed = states(logPath)
    let cursor = 0
    for (const state of observed) {
      if (state === sequence[cursor]) cursor += 1
      if (cursor === sequence.length) return true
    }
    return false
  }, label, timeoutMs)
}

/** The index of the last occurrence of one state, or -1. */
function lastIndex(logPath, state) {
  const observed = states(logPath)
  let index = -1
  for (let cursor = 0; cursor < observed.length; cursor += 1) {
    if (observed[cursor] === state) index = cursor
  }
  return index
}

function herdrClientEnv(scriptPath, logPath, paneId) {
  return {
    HERDR_ENV: '1',
    HERDR_PANE_ID: paneId,
    HERDR_BIN_PATH: scriptPath,
    HERDR_SOCKET_PATH: join(logPath, '..', 'herdr.sock'),
    HERDR_FAKE_LOG: logPath,
  }
}

/** Every invocation on this log belongs to the declared Pane and source. */
function assertPaneOwnership(logPath, paneId) {
  for (const invocation of readInvocations(logPath)) {
    const { argv } = invocation
    assert(argv[0] === 'pane', `H1 unexpected subcommand ${JSON.stringify(argv)}`)
    assert(argv[2] === paneId, `H1 the Pane ${JSON.stringify(paneId)} log received ${JSON.stringify(argv)}`)
    assert(argv[3] === '--source' && argv[4] === 'dsh-pi-tui', `H1 wrong source in ${JSON.stringify(argv)}`)
    assert(argv[5] === '--agent' && argv[6] === 'dsh-pi-tui', `H1 wrong agent in ${JSON.stringify(argv)}`)
    assert(argv[argv.length - 2] === '--seq', `H1 a Pane command carried no seq: ${JSON.stringify(argv)}`)
  }
}

/** Run the H1 Split Host/Client qualification. */
export async function runHerdrH1(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context)
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const scriptPath = join(workDir, `herdr-fake-cli-${unique}.sh`)
  writeFileSync(scriptPath, FAKE_HERDR_CLI, { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  const hostLog = join(workDir, `herdr-host-${unique}.log`)
  const longLog = join(workDir, `herdr-long-${unique}.log`)
  const questionLog = join(workDir, `herdr-question-${unique}.log`)
  const multiC1Log = join(workDir, `herdr-multi-c1-${unique}.log`)
  const multiC2Log = join(workDir, `herdr-multi-c2-${unique}.log`)
  // The Host receives a complete, deliberately DIFFERENT Herdr environment:
  // creating a reporter in the long-lived multi-Pane Host would bind a Pane it
  // does not own, so this log proves the Host never spawns a Pane command.
  const hostHerdrEnv = {
    ...herdrClientEnv(scriptPath, hostLog, `host-must-never-report-${unique}`),
  }
  const {
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
  } = scene
  try {
    // ── RH-01a: a held REAL Host turn: working -> idle ─────────────────────
    const longBarrier = join(workDir, `herdr-long-turn-${unique}.barrier`)
    const { host: longHost, ready: longReady } = await startC1Host('long-turn', `herdr-h1-long-${unique}`, {
      ...hostHerdrEnv,
      C1_HOLD_LONG_TURN: longBarrier,
    })
    const longPane = `herdr-pane-long-${unique}`
    const { client: longClient, ready: longClientReady } = await startC1Client(
      `H1 long-turn Client ${unique}`,
      herdrClientEnv(scriptPath, longLog, longPane),
    )
    const longSessionId = await openC1Session(longClient, `herdr h1 long ${unique}`, `H1 long ${unique}`)
    await waitForStateSequence(longLog, ['working'], 'RH-01a working', 120_000)
    assert(states(longLog).at(-1) === 'working',
      'H1 a held real Host turn must not be reported as idle')
    /** The complete Pane fact list BEFORE the transport loss: the mount idle
     *  and the held turn's working. Only facts added AFTER this prefix may be
     *  judged by RH-02; the initial mount idle is a legal earlier fact. */
    const beforeRolloverStates = states(longLog)

    // ── RH-02 inside the SAME held turn: the real transport rollover ───────
    // The M5D-03 manual, applied to this Client: SIGUSR1 drops the REAL mux
    // socket; the official generation is invalidated and a NEW generation
    // re-adopts the exact Session with the PID/surface revision untouched.
    const aBefore = lastSurfaceStatus(longClient)
    assert(typeof aBefore?.generationId === 'number',
      'RH-02 the Client never observed an official transport generation')
    const rolloverBoundary = longClient.records.length
    // F6: freeze the Host BEFORE the drop. The Client's own socket termination
    // still loses the generation locally, but the official Connection loop can
    // no longer form the replacement generation, so the loss window below is
    // deterministic instead of racing a fast reconnect.
    process.kill(longReady.pid, 'SIGSTOP')
    let resumed = false
    const resumeHost = () => {
      if (resumed) return
      resumed = true
      process.kill(longReady.pid, 'SIGCONT')
    }
    try {
      longClient.signalBusiness('SIGUSR1')
      await longClient.waitFor(
        record => longClient.records.indexOf(record) >= rolloverBoundary
          && record.m4b2s === 'qualification' && record.op === 'drop-websocket',
        'RH-02 the qualification mux drop was injected',
        30_000,
      )
      await longClient.waitFor(
        record => longClient.records.indexOf(record) >= rolloverBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        'RH-02 the Client observed the official lost generation',
        60_000,
      )
      // While the generation is INVALID and no replacement has been accepted,
      // the Pane must already be withdrawn: an extended outage never keeps a
      // stale working/blocked registration.
      await waitForLog(longLog, () => lastIndex(longLog, 'release') !== -1,
        'RH-02 ordered release while the generation is still invalid', 60_000)
      const lossWindow = lastSurfaceStatus(longClient)
      assert(lossWindow?.generationId === undefined && lossWindow?.transport !== 'connected',
        `RH-02 the release must land before reconnect; the Client status was ${JSON.stringify(lossWindow)}`)
    } finally {
      resumeHost()
    }
    const lossStates = states(longLog)
    const releaseAt = lossStates.lastIndexOf('release', lossStates.length - 1)
    // The window under judgment ends at the ordered release. A later
    // requalified `working` (the NEW generation's opening snapshot) may already
    // be in the log by the time this read runs; it is not a lost-transport fact.
    const addedDuringLoss = lossStates.slice(beforeRolloverStates.length, releaseAt)
    assert(releaseAt >= beforeRolloverStates.length && !addedDuringLoss.includes('idle'),
      `RH-02 a lost Remote transport must withdraw the Pane without a fabricated idle; the Pane saw ${JSON.stringify(lossStates)}`)
    const rolled = await longClient.waitFor(
      record => longClient.records.indexOf(record) >= rolloverBoundary
        && record.m4b2s === 'surface-status'
        && typeof record.generationId === 'number'
        && record.generationId !== aBefore.generationId
        && record.transport === 'connected'
        && record.sessionOpen === true
        && record.openSessionId === longSessionId
        && record.surfaceMounted === true,
      'RH-02 the Client reconnected on a NEW official generation with the Session current',
      120_000,
    )
    assert(rolled.pid === aBefore.pid && rolled.surfaceRevision === aBefore.surfaceRevision,
      'RH-02 the rollover must keep the same business PID and surface revision')
    assert(rolled.host?.hostPid === aBefore.host?.hostPid
      && rolled.host?.scopeId === aBefore.host?.scopeId,
      'RH-02 the rollover must stay on the SAME authenticated Host')
    assert(alive(longReady.pid), 'H1 the Host died during the transport rollover')
    assert(!existsSync(longBarrier), 'RH-02 the rollover released the held Host turn')
    // The NEW generation's authoritative snapshot re-registers the Pane with
    // the still-current `working` fact (`release` is not a state), so the Pane
    // must observe working AFTER the ordered release and BEFORE any idle.
    await waitForLog(longLog, () => {
      const observed = states(longLog)
      const release = observed.lastIndexOf('release')
      if (release < 0) return false
      const requalified = observed.indexOf('working', release + 1)
      const idled = observed.indexOf('idle', release + 1)
      return requalified >= 0 && (idled < 0 || requalified < idled)
    }, 'RH-02 requalified working on the new generation', 120_000)

    writeFileSync(longBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEvent(dshHome, longSessionId, event => event.type === 'turn/end', `H1 long ${unique} turn/end`, 120_000)
    await waitForStateSequence(longLog, ['working', 'release', 'working', 'idle'],
      'RH-02 working -> release -> working -> idle across the real generation rollover', 120_000)
    await waitForStateSequence(longLog, ['working', 'idle'], 'RH-01a idle after the turn', 120_000)
    assertPaneOwnership(longLog, longPane)
    assert(alive(longReady.pid), 'H1 the Host died during the long-turn scene')
    await exitC1Client(longClient, `H1 long Client ${unique}`)
    await waitForLog(longLog, () => lastIndex(longLog, 'release') === states(longLog).length - 1, 'RH-01a release on dispose', 60_000)
    // The Host seat is exclusive: release this scene's Host before the next
    // independent Host starts (otherwise the second Host reports host-seat-conflict).
    await stopC1Host(longHost)
    trace('herdr-h1-rh01a', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: longReady.pid,
      sessionId: longSessionId,
      states: states(longLog),
    })
    trace('herdr-h1-rh02', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      generationBefore: aBefore.generationId,
      generationAfter: rolled.generationId,
      clientPid: longClientReady.pid,
      surfaceRevisionKept: true,
      holdBarrierUntouched: !existsSync(longBarrier),
      noIdleDuringLoss: true,
    })

    // ── RH-01b: a REAL Agent Question: blocked -> working -> idle ──────────
    const { host: questionHost, ready: questionReady } = await startC1Host(
      'question',
      `herdr-h1-question-${unique}`,
      hostHerdrEnv,
    )
    const questionPane = `herdr-pane-question-${unique}`
    const { client: questionClient } = await startC1Client(
      `H1 question Client ${unique}`,
      herdrClientEnv(scriptPath, questionLog, questionPane),
    )
    const questionSessionId = await openC1Session(questionClient, `herdr h1 question ${unique}`, `H1 question ${unique}`)
    await waitForHostSessionEvent(
      dshHome,
      questionSessionId,
      event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
      `H1 question ${unique} tool/call`,
      120_000,
    )
    await questionClient.waitForScreen('[1] Proceed', `H1 question ${unique} modal`, 120_000)
    await waitForStateSequence(questionLog, ['blocked'], 'RH-01b blocked', 120_000)
    questionClient.send('1')
    await questionClient.waitForScreen('Review your answer before submit', `H1 question ${unique} review`, 30_000)
    questionClient.send('\r')
    await waitForHostSessionEvent(dshHome, questionSessionId, event => event.type === 'turn/end', `H1 question ${unique} turn/end`, 120_000)
    await waitForStateSequence(questionLog, ['blocked', 'working', 'idle'], 'RH-01b working then idle', 120_000)
    assertPaneOwnership(questionLog, questionPane)
    assert(alive(questionReady.pid), 'H1 the Host died during the question scene')
    await exitC1Client(questionClient, `H1 question Client ${unique}`)
    await stopC1Host(questionHost)
    trace('herdr-h1-rh01b', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: questionReady.pid,
      sessionId: questionSessionId,
      states: states(questionLog),
    })

    // ── RH-03: two REAL Clients, two Pane environments, ONE Host ───────────
    const multiBarrier = join(workDir, `herdr-multi-turn-${unique}.barrier`)
    const { host: multiHost, ready: multiReady } = await startC1Host('long-turn', `herdr-h1-multi-${unique}`, {
      ...hostHerdrEnv,
      C1_HOLD_LONG_TURN: multiBarrier,
    })
    const c1Pane = `herdr-pane-multi-c1-${unique}`
    const c2Pane = `herdr-pane-multi-c2-${unique}`
    const { client: multiC1, ready: multiC1Ready } = await startC1Client(
      `H1 multi C1 ${unique}`,
      herdrClientEnv(scriptPath, multiC1Log, c1Pane),
    )
    const multiSessionId = await openC1Session(multiC1, `herdr h1 multi ${unique}`, `H1 multi ${unique}`)
    await waitForStateSequence(multiC1Log, ['working'], 'RH-03 C1 working', 120_000)
    const { client: multiC2, ready: multiC2Ready } = await startC1Client(
      `H1 multi C2 ${unique}`,
      {
        ...herdrClientEnv(scriptPath, multiC2Log, c2Pane),
        SPLIT_PROCESS_CLIENT_SESSION: multiSessionId,
      },
    )
    // C2 attaches to the SAME running Host Session: its opening snapshot is the
    // Host's running truth, so its own Pane starts at working, not a fake idle.
    await waitForStateSequence(multiC2Log, ['working'], 'RH-03 C2 opening working', 120_000)
    assertPaneOwnership(multiC1Log, c1Pane)
    assertPaneOwnership(multiC2Log, c2Pane)
    await exitC1Client(multiC1, `H1 multi C1 ${unique}`)
    await waitForLog(multiC1Log, () => lastIndex(multiC1Log, 'release') === states(multiC1Log).length - 1, 'RH-03 C1 release', 60_000)
    assert(states(multiC2Log).includes('release') === false,
      'H1 C1 disposal must not withdraw the OTHER Pane')
    assert(alive(multiReady.pid), 'H1 the Host died when the first Client exited')
    writeFileSync(multiBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEvent(dshHome, multiSessionId, event => event.type === 'turn/end', `H1 multi ${unique} turn/end`, 120_000)
    await waitForStateSequence(multiC2Log, ['working', 'idle'], 'RH-03 C2 still receives Host facts', 120_000)
    await exitC1Client(multiC2, `H1 multi C2 ${unique}`)
    await waitForLog(multiC2Log, () => states(multiC2Log).filter(state => state === 'release').length === 1, 'RH-03 C2 release', 60_000)
    assert(states(multiC1Log).filter(state => state === 'release').length === 1,
      'H1 each Client releases exactly its own Pane once')
    trace('herdr-h1-rh03', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: multiReady.pid,
      sessionId: multiSessionId,
      c1: { pid: multiC1Ready.pid, pane: c1Pane, states: states(multiC1Log) },
      c2: { pid: multiC2Ready.pid, pane: c2Pane, states: states(multiC2Log) },
    })

    // ── The Split Host never creates a reporter ────────────────────────────
    assert(readInvocations(hostLog).length === 0,
      `H1 the Host process created a Pane reporter: ${JSON.stringify(readInvocations(hostLog))}`)
    assert(alive(multiReady.pid), 'H1 the multi-client Host died before its own stop')
    await stopC1Host(multiHost)

    return {
      status: 'PASS',
      rh01: 'REAL_SPLIT_PROCESS_L6',
      rh02: 'REAL_SPLIT_PROCESS_L6',
      rh03: 'REAL_SPLIT_PROCESS_L6',
      hostReportedNothing: true,
    }
  } finally {
    await scene.dispose()
  }
}
