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
 * RH-02 (disconnect/reconnect): NOT claimed by this case. A real Split Client
 * does not expose a recoverable progress-watch failure without ending the whole
 * surface (the transport loss path tears the Client down), so the disconnect
 * half is qualified structurally by the reporter's `setQualified(false)`
 * contract (`HR-06`) and the Host reconnect half is `NOT_VERIFIED` here. The
 * case result records that scope instead of inventing evidence.
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
import { alive } from '../../lib/split-smoke-processes.mjs'
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
    const { client: longClient } = await startC1Client(
      `H1 long-turn Client ${unique}`,
      herdrClientEnv(scriptPath, longLog, longPane),
    )
    const longSessionId = await openC1Session(longClient, `herdr h1 long ${unique}`, `H1 long ${unique}`)
    await waitForStateSequence(longLog, ['working'], 'RH-01a working', 120_000)
    assert(states(longLog).at(-1) === 'working',
      'H1 a held real Host turn must not be reported as idle')
    writeFileSync(longBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEvent(dshHome, longSessionId, event => event.type === 'turn/end', `H1 long ${unique} turn/end`, 120_000)
    await waitForStateSequence(longLog, ['working', 'idle'], 'RH-01a idle after the turn', 120_000)
    assertPaneOwnership(longLog, longPane)
    assert(alive(longReady.pid), 'H1 the Host died during the long-turn scene')
    await exitC1Client(longClient, `H1 long Client ${unique}`)
    await waitForLog(longLog, () => lastIndex(longLog, 'release') === states(longLog).length - 1, 'RH-01a release on dispose', 60_000)
    trace('herdr-h1-rh01a', {
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: longReady.pid,
      sessionId: longSessionId,
      states: states(longLog),
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
    for (const host of [longHost, questionHost, multiHost]) {
      assert(host.exited === false, 'H1 a scene Host exited before its own stop')
    }

    trace('herdr-h1-rh02', {
      scope: 'STRUCTURAL_ONLY',
      reason: 'a real Split Client progress-watch failure is not recoverable without ending the surface; the disconnect half is covered by HR-06 and the reconnect half is NOT_VERIFIED',
    })
    return {
      status: 'PASS',
      rh01: 'REAL_SPLIT_PROCESS_L6',
      rh02: 'STRUCTURAL_ONLY',
      rh03: 'REAL_SPLIT_PROCESS_L6',
      hostReportedNothing: true,
    }
  } finally {
    await scene.dispose()
  }
}
