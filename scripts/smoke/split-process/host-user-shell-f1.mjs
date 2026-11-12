/** Real installed-tarball PTY qualification for the F1 Host Shell capability. */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { completeFromTui, completeMultilineFromTui, waitForComposerMode, waitForComposerText } from './shell-tui-driving.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, hostUserTexts, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Submit one Shell command through the REAL editor transitions. This helper
 * proves only that the Client admitted the command (prompt → shell mode →
 * local mode → body → Enter); it never waits for a painted result. Every
 * caller proves the authoritative settlement itself: a retained local card
 * for `!!` (and a retained cancelled `!` diagnostic) or this run's Host
 * Session `user/message` for a committed `!`.
 */
async function submitShellCommand(client, mode, command, label) {
  await waitForComposerMode(client, 'prompt', `${label} prompt preparation`)
  // `!`/`!!` are editor MODES, not text: send each key alone and wait for the
  // painted composer before the next byte, so a coalesced chunk can never
  // insert the prefix as literal draft text.
  client.send('!')
  await waitForComposerMode(client, '!', `${label} shell-mode activation`)
  if (mode === '!!') {
    client.send('!')
    await waitForComposerMode(client, '!!', `${label} shell-local activation`)
  }
  client.send(command)
  client.send('\r')
}

/**
 * The terminal outcome of THIS run's retained local Shell Card. The header
 * carries the run's unique starting marker, the next row is the `$ command`
 * row and the settlement is the SAME card's outcome row — never any `exit`
 * text painted by an earlier card. Only for `!!` and a cancelled `!`; a
 * committed `!` deletes its card and must be proven from the Host Session.
 */
async function waitForLocalShellSettled(client, uniqueMarker, expectedOutcome, label) {
  try {
    await waitForCondition(async () => {
      const lines = await client.viewport()
      const indexes = lines.flatMap((line, index) => line.includes('Shell') && line.includes(uniqueMarker) ? [index] : [])
      if (indexes.length !== 1) return false
      const index = indexes[0]
      return lines[index + 1]?.includes('$ ') === true
        && lines[index + 2]?.includes(expectedOutcome) === true
    }, `${label} settled local Shell Card`, 30_000)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label} local Shell Card never settled as ${expectedOutcome}: ${String(error)}; frameTail=${(await client.viewport()).slice(-18).join('\\n')}`)
  }
}

/**
 * Expand the settled local Shell Card through the REAL Ctrl+O transcript
 * action and assert its retained body facts. Only for `!!`; a committed `!`
 * keeps its result in the Host Session instead. The folded state is restored
 * on both the pass and the failure path.
 */
async function assertExpandedLocalShellFacts(client, expectedFacts, label) {
  client.send('\x0f')
  try {
    await waitForCondition(async () => {
      const frame = (await client.viewport()).join('\n')
      return expectedFacts.every(fact => frame.includes(fact))
    }, `${label} expanded Shell facts`, 30_000)
    const frame = (await client.viewport()).join('\n')
    for (const fact of expectedFacts) {
      assert(frame.includes(fact), `${label} expanded fact missing ${fact}: ${frame}`)
    }
  } finally {
    client.send('\x0f')
  }
}






export async function runHostUserShellF1(context) {
  const { workDir, dshHome, trace, failpoint } = context
  const scene = createC1Scene(context, { shellPolicyPatches: true })
  const sessionId = 'm6-f1-host-user-shell-session'
  const otherSessionId = 'm6-f1-host-user-shell-other-session'
  const hostDir = join(workDir, 'f1-host-workspace')
  const clientDir = join(workDir, 'f1-client-cwd')
  const clientDirB = join(workDir, 'f1-client-cwd-b')
  const hostBin = join(workDir, 'f1-host-bin')
  const clientBin = join(workDir, 'f1-client-bin')
  const hostHome = join(workDir, 'f1-host-home')
  const clientHome = join(workDir, 'f1-client-home')
  const clientHomeB = join(workDir, 'f1-client-home-b')
  const workRoot = scene.c1WorkRoot('host-user-shell')
  const probeId = String(process.pid)
  const bypassOutside = join(process.cwd(), `.f1-host-shell-bypass-outside-session-${probeId}`)
  const deniedPath = join(process.cwd(), `.f1-host-shell-sandbox-denied-${probeId}`)
  const bypassMarker = 'F1_BYPASS_OUTSIDE_WORKSPACE_20261109'
  let bypassProbeOwned = false
  assert(!existsSync(bypassOutside) && !existsSync(deniedPath), 'F1 worktree-root bypass/sandbox probes must start absent')
  for (const directory of [hostDir, clientDir, clientDirB, hostBin, clientBin, hostHome, clientHome, clientHomeB]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const canonicalHostDir = realpathSync(hostDir)
  const canonicalClientDir = realpathSync(clientDir)
  const hostPath = `${hostBin}:/usr/bin:/bin`
  const clientPath = `${clientBin}:/usr/bin:/bin`
  const hostCommand = join(hostBin, 'f1-host-command')
  const clientCommand = join(clientBin, 'f1-client-command')
  writeFileSync(join(hostDir, 'host-only.txt'), 'F1_HOST_FILE_20261109\n', { mode: 0o600 })
  writeFileSync(join(clientDir, 'host-only.txt'), 'F1_CLIENT_POISON_20261109\n', { mode: 0o600 })
  writeFileSync(join(hostDir, 'host-path-only.txt'), 'F1_HOST_PATH_FILE\n', { mode: 0o600 })
  writeFileSync(join(clientDir, 'client-only.txt'), 'F1_CLIENT_PATH_FILE\n', { mode: 0o600 })
  writeFileSync(hostCommand, '#!/bin/sh\nprintf "F1_HOST_COMMAND_20261109\\n"\n', { mode: 0o700 })
  writeFileSync(clientCommand, '#!/bin/sh\nprintf "F1_CLIENT_COMMAND_20261109\\n"\n', { mode: 0o700 })
  chmodSync(hostCommand, 0o700)
  chmodSync(clientCommand, 0o700)

  try {
    const { host, ready, workRoot: hostWorkRoot } = await scene.startC1Host('f1-shell', 'f1-host-shell', {
      C1_F1_SESSION_ID: sessionId,
      C1_F1_SESSION_CWD: canonicalHostDir,
      C1_F1_OTHER_SESSION_ID: otherSessionId,
      C1_F1_SETTINGS_NAMESPACE: 'split-host-pi-tui-runtime',
      SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.bypassPatchPath,
      HOME: hostHome,
      PATH: hostPath,
      F1_HOST_VARIABLE_20261109: 'host-value',
    }, workRoot)
    failpoint('surface.host-user-shell-f1.after-host-ready')
    const seeded = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'f1-host-session-created' && event.sessionId === sessionId,
      'F1 Host-seeded live Session',
    )
    assert(seeded.cwd === canonicalHostDir, 'F1 Session effective cwd must be the distinct Host workspace')
    const otherSeeded = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'f1-host-other-session-created' && event.sessionId === otherSessionId,
      'F1 second Host-seeded live Session',
    )
    assert(otherSeeded.cwd === canonicalHostDir, 'F1 second Session must use the Host workspace too')
    assert(ready.localHost?.instanceId !== undefined, 'F1 smoke must name the installed Host instance')

    const { client: clientA } = await scene.startC1Client('f1-shell-client-a', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionId,
      HOME: clientHome,
      PATH: clientPath,
      F1_CLIENT_VARIABLE_20261109: 'client-poison',
    }, { cwd: clientDir })
    const statusA = await clientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'F1 Client A attached to the Host Session',
      120_000,
    )
    assert(statusA.sessionOpen && statusA.openSessionId === sessionId, 'F1 Client A did not attach to the pre-existing Host Session')
    const initialEvents = hostSessionEvents(dshHome, sessionId) ?? []
    const hostMarker = 'F1_HOST_EXECUTION_20261109'
    const hostFacts = `printf 'F1_HOST_%s_20261109\\n' EXECUTION; printf 'CWD=%s\\nHOME=%s\\nPATH=%s\\nF1_HOST_VARIABLE=%s\\n' "$PWD" "$HOME" "$PATH" "$F1_HOST_VARIABLE_20261109"; cat host-only.txt; f1-host-command`
    await submitShellCommand(clientA, '!', hostFacts, 'F1 bypass !')
    await waitForHostSessionEventAfter(dshHome, sessionId, initialEvents.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(hostMarker),
      'F1 ! Host result Session write', 15_000)
    await clientA.waitForScreen('f1-shell answer', 'F1 Host result follow-up', 30_000)
    const bypassPolicy = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'f1-host-effective-shell-policy' && event.agentId === sessionId,
      'F1 effective bypass policy source',
    )
    assert(bypassPolicy.localShellSandbox === 'bypass',
      `the Host profile's effective first-run policy must be bypass; Settings namespaces=${JSON.stringify(bypassPolicy.settingsNamespaces)}`)
    const afterBangEvents = hostSessionEvents(dshHome, sessionId) ?? []
    const afterBang = hostUserTexts(afterBangEvents)
    const bangResultRows = afterBang.filter(text => text.includes(hostMarker))
    assert(bangResultRows.length === 1, '! writes the drained Host result to the exact Session once')
    const bangResult = bangResultRows[0] ?? ''
    assert(bangResult.includes('[exit 0]'), '! Session result carries the real Host terminal outcome')
    assert(bangResult.includes(hostMarker) && bangResult.includes(canonicalHostDir), '! result came from the exact Host Session cwd')
    assert(bangResult.includes(hostHome) && bangResult.includes(hostPath) && bangResult.includes('F1_HOST_VARIABLE=host-value'),
      '! result contains the real Host HOME/PATH and Host-only variable')
    assert(!bangResult.includes(clientHome) && !bangResult.includes(clientPath), '! result contains no Client HOME/PATH')
    assert(bangResult.includes('F1_HOST_FILE_20261109') && !bangResult.includes('F1_CLIENT_POISON_20261109'),
      'same-named Host/Client files resolve only in the Host Session cwd')
    assert(bangResult.includes('F1_HOST_COMMAND_20261109') && !bangResult.includes('F1_CLIENT_COMMAND_20261109'),
      'the bypass command resolved from Host PATH, not Client PATH')

    const localMarker = 'F1_CARD_ONLY_20261109'
    const beforeBangBang = afterBangEvents.length
    await submitShellCommand(clientA, '!!', `printf '${localMarker}\\n'; pwd; printf 'HOME=%s\\n' "$HOME"`, 'F1 bypass !!')
    await waitForLocalShellSettled(clientA, localMarker, '[exit 0]', 'F1 bypass !!')
    const afterBangBangEvents = hostSessionEvents(dshHome, sessionId) ?? []
    assert(afterBangBangEvents.length === beforeBangBang, '!! has no Session or model write')
    assert(!hostUserTexts(afterBangBangEvents).some(text => text.includes(localMarker)), '!! output remains only on its card')
    await submitShellCommand(clientA, '!', `printf 'F1_BYPASS_%s_20261109\\n' OUTSIDE_WORKSPACE; printf 'F1_BYPASS_%s_20261109\\n' OUTSIDE_WORKSPACE > ${shellQuote(bypassOutside)}`,
      'F1 explicit Host bypass policy')
    const bypassEvent = await waitForHostSessionEventAfter(dshHome, sessionId, afterBangBangEvents.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(bypassMarker),
      'F1 bypass outside-workspace result Session write')
    const bypassText = hostUserTexts([bypassEvent])[0] ?? ''
    assert(bypassText.includes(bypassMarker) && bypassText.includes('[exit 0]'),
      'the outside-workspace ! result is committed to the Session with its terminal outcome')
    assert(readFileSync(bypassOutside, 'utf8') === `${bypassMarker}\n`, 'Host bypass writes to the worktree-root sibling outside its Session workspace')
    bypassProbeOwned = true
    const beforeSignal = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    const signalMarker = 'F1_SIGTERM_20261109'
    await submitShellCommand(clientA, '!!', `printf '${signalMarker}\\n'; kill -TERM "$BASHPID"`, 'F1 signal outcome')
    await waitForLocalShellSettled(clientA, signalMarker, '[signal SIGTERM]', 'F1 signal outcome')
    const afterSignal = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    assert(afterSignal.length === beforeSignal.length, 'signal outcome from !! adds no Session/model write')

    const beforeNonzero = hostSessionEvents(dshHome, sessionId) ?? []
    const nonzeroMarker = 'F1_EXIT_7_20261109'
    await submitShellCommand(clientA, '!', `printf 'F1_EXIT_%s_20261109\\n' 7; exit 7`, 'F1 nonzero exit')
    const nonzeroEvent = await waitForHostSessionEventAfter(dshHome, sessionId, beforeNonzero.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(nonzeroMarker),
      'F1 nonzero Host result Session write')
    const nonzeroText = hostUserTexts([nonzeroEvent])[0] ?? ''
    assert(nonzeroText.includes(nonzeroMarker) && nonzeroText.includes('[exit 7]'),
      'the nonzero ! result is committed to the Session with its exact exit code')
    await clientA.waitForScreen('f1-shell answer', 'F1 nonzero Host result follow-up', 30_000)

    // Raw Bash semantics: the official one-shot executor runs
    // `bash -c <command>` verbatim, so `$!`, `wait`, background exit status
    // and stdout/stderr FDs behave exactly as in Bash. A stderr-rewriting
    // wrapper would change them.
    const rawMarker = 'F1_RAW_BASH_20261110'
    const rawCommand = [
      `printf '${rawMarker}\\n'`,
      'sleep 0.05 & p=$!',
      'wait "$p"',
      `printf 'F1_WAIT_STATUS=%s\\n' "$?"`,
      'case $p in ""|*[!0-9]*) printf "F1_WAIT_%s=%s\\n" PID invalid ;; *) printf "F1_WAIT_%s=%s\\n" PID numeric ;; esac',
      '(exit 7) & q=$!',
      'wait "$q"',
      `printf 'F1_WAIT_BG=%s\\n' "$?"`,
      '(sleep 5) & k=$!',
      'kill -TERM "$k"',
      'wait "$k"',
      `printf 'F1_WAIT_SIG=%s\\n' "$?"`,
      `printf 'F1_STREAM_%s_20261110\\n' OUT`,
      `printf 'F1_STREAM_%s_20261110\\n' ERR >&2`,
    ].join('; ')
    await submitShellCommand(clientA, '!!', rawCommand, 'F1 raw Bash $!/wait/FD semantics')
    await waitForLocalShellSettled(clientA, rawMarker, '[exit 0]', 'F1 raw Bash $!/wait/FD semantics')
    // The folded card paints only the terminal outcome; the retained stdout,
    // stderr and exit facts live in the card body. Expand the settled card
    // through the real transcript action, assert every fact, then restore the
    // folded state for the remaining cases.
    await assertExpandedLocalShellFacts(clientA, [
      'F1_WAIT_STATUS=0',
      'F1_WAIT_PID=numeric',
      'F1_WAIT_BG=7',
      'F1_WAIT_SIG=143',
      'F1_STREAM_OUT_20261110',
      'F1_STREAM_ERR_20261110',
    ], 'F1 raw Bash')
    await waitForLocalShellSettled(clientA, rawMarker, '[exit 0]', 'F1 raw Bash folded restoration')


    const { client: clientB } = await scene.startC1Client('f1-shell-client-b', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionId,
      HOME: clientHomeB,
      PATH: clientPath,
      F1_CLIENT_VARIABLE_20261109: 'client-poison',
    }, { cwd: clientDirB })
    const statusB = await clientB.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'F1 Client B attached to the same Host Session',
      120_000,
    )
    assert(statusB.sessionOpen && statusB.openSessionId === sessionId, 'F1 Client B did not attach to the same Host Session')

    // Completion is exercised through the real PTY Tab consumer. The
    // candidates below exist only in the Host environment or Host authority.
    await completeFromTui(clientB, '!f1-host-', 'f1-host-command', 'f1-client-command', 'F1 Host command completion')
    await completeFromTui(clientB, '!echo $F1_HOST_VAR', '$F1_HOST_VARIABLE_20261109', '$F1_CLIENT_VARIABLE_20261109', 'F1 Host variable completion')
    await completeFromTui(clientB, '!git che', 'checkout', 'client-only.txt', 'F1 Host git subcommand completion')
    await completeFromTui(clientB, '!cat host-path-', 'host-path-only.txt', 'client-only.txt', 'F1 Host path completion')
    // MULTILINE Shell: `!`/`!!` are editor modes, so a later command line is
    // Shell too and must complete from the SAME Host authority.
    await completeMultilineFromTui(clientB, '!', ['echo first', 'echo second', 'git che'],
      'checkout', 'client-only.txt', 'F1 multiline third-line git subcommand')
    await completeMultilineFromTui(clientB, '!!', ['echo first', 'f1-host-'],
      'f1-host-command', 'f1-client-command', 'F1 multiline second-line Host command')
    await completeMultilineFromTui(clientB, '!', ['echo first', 'echo $F1_HOST_VAR'],
      '$F1_HOST_VARIABLE_20261109', '$F1_CLIENT_VARIABLE_20261109', 'F1 multiline second-line Host variable')
    await completeMultilineFromTui(clientB, '!', ['echo first', 'cat host-path-'],
      'host-path-only.txt', 'client-only.txt', 'F1 multiline second-line Host path')

    const scopeStartFile = join(hostDir, 'f1-scope-run-started.txt')
    const scopePidFile = join(hostDir, 'f1-scope-run-bash-pid.txt')
    const scopeReleaseFile = join(hostDir, 'f1-scope-run-release.txt')
    const scopeFinishFile = join(hostDir, 'f1-scope-run-finished.txt')
    const scopeStartedMarker = 'F1_SCOPE_A_STARTED_20261109'
    const scopeFinishedMarker = 'F1_SCOPE_A_FINISHED_20261109'
    assert(!existsSync(scopeStartFile) && !existsSync(scopeReleaseFile) && !existsSync(scopeFinishFile),
      'F1 scope-switch barrier files start absent')
    const beforeScopeA = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    const beforeScopeB = hostUserTexts(hostSessionEvents(dshHome, otherSessionId) ?? [])
    let scopeReleaseWritten = false
    let scopeShellPid
    try {
      await waitForComposerMode(clientA, 'prompt', 'F1 scope-switch prompt preparation')
      clientA.send('!')
      await waitForComposerMode(clientA, '!', 'F1 scope-switch shell-mode activation')
      clientA.send(`printf '%s\\n' "${'$'}BASHPID" > ${shellQuote(scopePidFile)}; touch ${shellQuote(scopeStartFile)}; printf '${scopeStartedMarker}\\n'; while [ ! -f ${shellQuote(scopeReleaseFile)} ]; do sleep 0.05; done; printf '${scopeFinishedMarker}\\n'; touch ${shellQuote(scopeFinishFile)}`)
      // The command's own pid file (awaited below) is the authoritative start
      // fact; the composer seat can be scrolled out of the captured viewport,
      // so its draft text is not a reliable witness here.
      clientA.send('\r')
      // The run's own barrier files are the authoritative start fact. The
      // captured viewport can no longer show the marker on a long transcript.
      await waitForCondition(() => existsSync(scopeStartFile) && existsSync(scopePidFile)
        && readFileSync(scopePidFile, 'utf8').trim() !== '',
      'F1 Shell captured Session A and started on Host', 30_000)
      scopeShellPid = Number(readFileSync(scopePidFile, 'utf8').trim())
      assert(Number.isInteger(scopeShellPid) && scopeShellPid > 0, 'F1 scope-switch probe recorded its Host Bash pid')
      assert(existsSync(scopeStartFile), 'the Host Session A Shell is running before the navigation')
      clientA.send(`/resume ${otherSessionId}\r`)
      const switched = await clientA.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === otherSessionId,
        'F1 Client A commits Session B while its Shell is still running',
        60_000,
      )
      assert(switched.openSessionId === otherSessionId, 'the live Client selection changed from Session A to Session B')
      writeFileSync(scopeReleaseFile, 'release\\n', { mode: 0o600 })
      scopeReleaseWritten = true
      await waitForCondition(() => existsSync(scopeFinishFile),
        'F1 Host Session A Shell crosses its release barrier and terminates', 30_000)
      try {
        await clientA.waitForScreen('the session changed while the command ran — the output was not submitted',
          'F1 stale Shell result is refused after the Session switch', 30_000)
      } catch (error) {
        throw new SplitSmokeAssertionError(`F1 captured-A shell produced no visible stale-result refusal: ${String(error)}; frameTail=${(await clientA.viewport()).slice(-16).join('\\n')}`)
      }
    } finally {
      if (!scopeReleaseWritten) writeFileSync(scopeReleaseFile, 'release\\n', { mode: 0o600 })
    }
    for (let attempt = 0; attempt < 200 && alive(scopeShellPid); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(!alive(scopeShellPid), "the scope-switch Shell's official process range is quiescent")
    assert(existsSync(scopeFinishFile), 'the Host Shell crossed the explicit release barrier and completed')
    const afterScopeA = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    const afterScopeB = hostUserTexts(hostSessionEvents(dshHome, otherSessionId) ?? [])
    assert(afterScopeA.length === beforeScopeA.length && !afterScopeA.some(text => text.includes(scopeFinishedMarker)),
      'the stale Shell result is not written back to its original Session after the scope changes')
    assert(afterScopeB.length === beforeScopeB.length && !afterScopeB.some(text => text.includes(scopeFinishedMarker)),
      'the stale Shell result is never retargeted into the newly selected Session')

    // The remaining probes act on Session A, so return Client A to it.
    const returnStatusBaseline = clientA.records.filter(record => record.m4b2s === 'surface-status').length
    clientA.send(`/resume ${sessionId}\r`)
    // `/resume <id>` opens the Session Browser, so a bare `waitFor` can match
    // the historical Session-A status record from the INITIAL attach and let
    // this case type into the still-open Browser search. Require a NEW status
    // record from THIS resume, and wait for the restored regular prompt (the
    // Browser closed) before touching the editor.
    await waitForCondition(() => clientA.records
      .filter(record => record.m4b2s === 'surface-status')
      .slice(returnStatusBaseline)
      .some(record => record.sessionOpen === true && record.openSessionId === sessionId),
    'F1 Client A returns to Session A after the scope switch', 60_000)
    await waitForComposerMode(clientA, 'prompt', 'F1 Client A prompt restored after the resume')
    // A session commit repaints the seat; prove the editor accepts input again
    // with a harmless round trip instead of assuming the painted glyph is live.
    clientA.send('x')
    await waitForComposerText(clientA, 'x', 'F1 Client A editor accepts input after the resume')
    clientA.send('\x7f')
    await waitForComposerMode(clientA, 'prompt', 'F1 Client A prompt restored after the resume round trip')

    // Start a confirmed Remote user-shell command, then drop only Client A's
    // real Gateway mux socket after its first output reaches the PTY. The
    // process writes a one-byte Host side-effect before sleep and a second
    // marker only if the old managed range is not cleaned up.
    const disconnectCounter = join(hostDir, 'f1-disconnect-run-count.txt')
    const disconnectPidPath = join(hostDir, 'f1-disconnect-shell-pid.txt')
    const disconnectFinish = join(hostDir, 'f1-disconnect-command-finished.txt')
    const disconnectMarker = 'F1_DISCONNECT_STARTED_20261109'
    const disconnectGeneration = clientA.records.filter(record => record.m4b2s === 'surface-status')
      .at(-1)?.generationId
    assert(typeof disconnectGeneration === 'number', 'F1 Client A must report its live Gateway generation')
    // Submit through the SAME observable composer transitions the completion
    // cases use: a bare mode key, then the body, then Enter. Back-to-back
    // writes can fuse keys on the PTY decoder, so each step is proven by the
    // painted composer before the next byte is sent.
    await waitForComposerMode(clientA, 'prompt', 'F1 disconnect prompt preparation')
    // Two SEPARATE `!` writes, each proven by its painted mode: a fused `!!`
    // write can be lost/dropped right after a session commit settles.
    clientA.send('!')
    await waitForComposerMode(clientA, '!', 'F1 disconnect shell-context activation')
    clientA.send('!')
    await waitForComposerMode(clientA, '!!', 'F1 disconnect shell-local activation')
    // The marker is printed FIRST so it rides the folded card's header (the
    // header truncates the command to one row), which lets the case locate
    // THIS run's card after the transport drop. The pid file is the
    // authoritative "the Host command really started" fact.
    const disconnectCommand = `printf '${disconnectMarker}\\n'; printf x >> ${shellQuote(disconnectCounter)}; printf '%s\\n' "$BASHPID" > ${shellQuote(disconnectPidPath)}; sleep 30; printf finished > ${shellQuote(disconnectFinish)}`
    clientA.send(disconnectCommand)
    await waitForComposerText(clientA, 'printf x', 'F1 disconnect command draft')
    clientA.send('\r')
    await waitForCondition(() => existsSync(disconnectPidPath) && readFileSync(disconnectPidPath, 'utf8').trim() !== '',
      'F1 disconnect probe recorded its Host pid', 30_000)
    const shellPid = Number(readFileSync(disconnectPidPath, 'utf8').trim())
    assert(Number.isInteger(shellPid) && shellPid > 0, 'F1 disconnect probe recorded the Host Bash pid')
    clientA.signalBusiness('SIGUSR1')
    // The reconnected surface first has to be AUTHENTICATED: the status line
    // legitimately shows `connection lost, retry #N` and a `connecting`
    // transitional record while the transport is still re-establishing. Only
    // the CONNECTED record with a NEW numeric generation is that proof.
    await clientA.waitFor(record => record.m4b2s === 'surface-status'
      && record.transport === 'connected'
      && typeof record.generationId === 'number'
      && record.generationId !== disconnectGeneration
      && record.sessionOpen === true
      && record.openSessionId === sessionId,
    'F1 Client A authenticated reconnect generation', 120_000)
    // The settled local card keeps the full unknown-outcome diagnostic in its
    // retained body; the folded row paints only the first line. Prove THIS
    // run's card settled, then expand it through the real Ctrl+O action.
    await waitForLocalShellSettled(clientA, disconnectMarker, 'Host shell execution', 'F1 started-stream disconnect outcome')
    await assertExpandedLocalShellFacts(clientA, [
      'The command may have executed — do not retry automatically',
    ], 'F1 one-shot unknown-outcome warning')
    await waitForLocalShellSettled(clientA, disconnectMarker, 'Host shell execution', 'F1 disconnect outcome folded restoration')
    for (let attempt = 0; attempt < 200 && alive(shellPid); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(!alive(shellPid), 'Host managed shell range terminates after the real Gateway disconnect')
    assert(readFileSync(disconnectCounter, 'utf8') === 'x', 'the started command was invoked exactly once across reconnect')
    assert(!existsSync(disconnectFinish), 'the disconnected Host process was terminated before its delayed completion side effect')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    assert(readFileSync(disconnectCounter, 'utf8') === 'x', 'the Client never replayed an indeterminate shell command')

    // Two Host runs share the Session but not their cancellation lifetime. Esc
    // on A must not terminate B's independently managed process range.
    const childMarker = 'F1_CANCELLED_CHILD_DONE_20261109'
    const cancelFile = join(hostDir, 'cancelled-child-finished.txt')
    const cancelAStarted = join(hostDir, 'f1-client-a-cancel-started.txt')
    const cancelBStarted = join(hostDir, 'f1-client-b-cancel-started.txt')
    assert(!existsSync(cancelFile) && !existsSync(cancelAStarted) && !existsSync(cancelBStarted),
      'F1 cancellation barrier files start absent')
    const beforeClientBRuns = hostSessionEvents(dshHome, sessionId) ?? []
    await waitForComposerMode(clientA, 'prompt', 'F1 cancel prompt preparation')
    clientA.send('!')
    await waitForComposerMode(clientA, '!', 'F1 cancel shell-mode activation')
    clientA.send(`printf 'F1_CLIENT_A_RUNNING_20261109\\n'; touch ${shellQuote(cancelAStarted)}; sleep 30; touch ${shellQuote(cancelFile)}; printf '${childMarker}\\n'`)
    await waitForComposerText(clientA, 'F1_CLIENT_A_RUNNING_20261109', 'F1 cancel command draft')
    clientA.send('\r')
    await waitForComposerMode(clientB, 'prompt', 'F1 independent Client B prompt preparation')
    clientB.send('!')
    await waitForComposerMode(clientB, '!', 'F1 independent Client B shell-mode activation')
    clientB.send(`printf 'F1_CLIENT_B_RUNNING_20261109\\n' >&2; touch ${shellQuote(cancelBStarted)}; sleep 2; printf 'F1_CLIENT_B_%s_20261109\\n' SURVIVED; printf 'F1_CLIENT_B_%s_20261109\\n' STDERR >&2`)
    await waitForComposerText(clientB, 'F1_CLIENT_B_RUNNING_20261109', 'F1 independent Client B command draft')
    clientB.send('\r')
    // The two local cards only prove both Clients ADMITTED their commands. The
    // Host-side started files prove both one-shot runs really began before Esc,
    // so the cancellation cannot race a not-yet-started Host command.
    await waitForCondition(() => existsSync(cancelAStarted) && existsSync(cancelBStarted),
      'F1 both independent Host shells started', 30_000)
    clientA.send('\x1b')
    await waitForLocalShellSettled(clientA, 'F1_CLIENT_A_RUNNING_20261109', 'aborted', 'F1 Client A Host run cancellation')
    const clientBEvent = await waitForHostSessionEventAfter(dshHome, sessionId, beforeClientBRuns.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes('F1_CLIENT_B_SURVIVED_20261109'),
      'F1 Client B Session write')
    const clientBText = hostUserTexts([clientBEvent])[0] ?? ''
    assert(clientBText.includes('F1_CLIENT_B_SURVIVED_20261109')
      && clientBText.includes('[stderr]')
      && clientBText.includes('F1_CLIENT_B_STDERR_20261109')
      && clientBText.includes('[exit 0]'),
    'Client B ! result is committed with its stdout, stderr and terminal outcome')
    assert(hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(text => text.includes('F1_CLIENT_B_SURVIVED_20261109')).length === 1,
    'Client B ! result is written exactly once')
    await clientB.waitForScreen('f1-shell answer', 'F1 Client B Host result follow-up', 30_000)
    assert(!existsSync(cancelFile), 'cancelling Client A must terminate its command tree before the side effect')


    // Bounded one-shot output: both streams exceed the executor's in-memory
    // cap, so the Host must keep explicit tails, mark truncation truthfully,
    // name the Host-local spill files, and write only that bounded text to
    // the exact Session.
    const truncBegin = 'F1_TRUNC_BEGIN_20261110'
    const truncTail = 'F1_TRUNC_TAIL_20261110'
    const truncStderrTail = 'F1_TRUNC_STDERR_TAIL_20261110'
    const truncCommand = [
      "printf 'F1_TRUNC_%s\\n' BEGIN_20261110",
      "for ((i=0;i<512;i++)); do printf '%200s\\n' ''; done",
      "for ((i=0;i<400;i++)); do printf '%200s\\n' '' >&2; done",
      `printf 'F1_TRUNC_%s_20261110\\n' TAIL`,
      `printf 'F1_TRUNC_%s_20261110\\n' STDERR_TAIL >&2`,
    ].join('; ')
    const beforeTrunc = hostSessionEvents(dshHome, sessionId) ?? []
    // A committed `!` deletes its local card, so the visible frame is not an
    // authority for its content. This run's unique truncated tail in the Host
    // Session user/message is the only evidence that the bounded result landed.
    await submitShellCommand(clientB, '!', truncCommand, 'F1 bounded truncated output')
    await waitForHostSessionEventAfter(dshHome, sessionId, beforeTrunc.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(truncTail),
      'F1 bounded truncated result Session write')
    const truncWrites = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(text => text.includes(truncTail))
    assert(truncWrites.length === 1, '! writes the bounded truncated result exactly once')
    const truncText = truncWrites[0] ?? ''
    assert(truncText.includes('stdout truncated') && truncText.includes('stderr truncated'),
      'the Session text explicitly represents both stream truncations')
    assert(truncText.includes(truncTail) && truncText.includes(truncStderrTail),
      'the Session text retains the bounded stdout and stderr tails')
    assert(truncText.includes('Host-local'), 'the Session text names the spill file as a Host-local fact')
    assert(!truncText.includes(truncBegin),
      'the bounded Session text keeps the tail, not the untruncated beginning')
    assert(Buffer.byteLength(truncText, 'utf8') < 200 * 1024,
      `the Session text stays bounded (got ${Buffer.byteLength(truncText, 'utf8')} bytes)`)
    const truncExitIndex = truncText.lastIndexOf('[exit 0]')
    assert(truncExitIndex > truncText.indexOf('stdout truncated')
      && truncExitIndex > truncText.indexOf('stderr truncated'),
      'the truncation markers must precede the Session message terminal outcome')
    await clientB.waitForScreen('f1-shell answer', 'F1 bounded truncated result follow-up', 30_000)
    assert(existsSync(join(hostDir, 'host-only.txt')), 'the F1 Host workspace survived the bounded run')

    await scene.exitC1Client(clientA, 'F1 bypass Host Client A')
    await scene.exitC1Client(clientB, 'F1 bypass Host Client B')
    await scene.stopC1Host(host)
    await scene.awaitSceneSeatFree()

    const sandboxSessionId = 'm6-f1-host-user-shell-sandbox-session'
    const sandboxWorkRoot = scene.c1WorkRoot('host-user-shell-sandbox')
    const sandboxHostEnv = {
      C1_F1_SESSION_ID: sandboxSessionId,
      C1_F1_SESSION_CWD: canonicalHostDir,
      C1_F1_SETTINGS_NAMESPACE: 'split-host-pi-tui-runtime',
      SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.sandboxPatchPath,
      HOME: hostHome,
      PATH: hostPath,
      F1_HOST_VARIABLE_20261109: 'host-value',
    }
    const { host: sandboxHost, ready: sandboxReady, workRoot: sandboxHostWorkRoot } =
      await scene.startC1Host('f1-shell', 'f1-host-shell-sandbox', sandboxHostEnv, sandboxWorkRoot)
    const sandboxSeed = await waitForC1WorkEvent(
      sandboxHostWorkRoot,
      event => event.kind === 'f1-host-session-created' && event.sessionId === sandboxSessionId,
      'F1 sandbox Host-seeded live Session',
    )
    assert(sandboxSeed.cwd === canonicalHostDir, 'sandbox Host must retain its exact fresh Session cwd')
    const { client: sandboxClient } = await scene.startC1Client('f1-shell-client-sandbox', {
      SPLIT_PROCESS_CLIENT_SESSION: sandboxSessionId,
      HOME: clientHome,
      PATH: clientPath,
      F1_CLIENT_VARIABLE_20261109: 'client-poison',
    }, { cwd: clientDir })
    const sandboxStatus = await sandboxClient.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sandboxSessionId,
      'F1 sandbox Client attached to the fresh sandbox Host Session',
      120_000,
    )
    assert(sandboxStatus.sessionOpen && sandboxStatus.openSessionId === sandboxSessionId,
      'the sandbox phase must attach to its fresh Host Session')

    const allowedPath = join(hostDir, 'f1-sandbox-allowed.txt')
    assert(!existsSync(allowedPath) && !existsSync(deniedPath), 'sandbox allow/deny targets start absent')
    assert(existsSync(bypassOutside), 'the sibling directory is writable in the positive bypass phase')
    const beforeSandboxAllow = hostUserTexts(hostSessionEvents(dshHome, sandboxSessionId) ?? [])
    const sandboxAllow = 'F1_SANDBOX_ALLOW_20261109'
    await submitShellCommand(sandboxClient, '!', `touch ${shellQuote(allowedPath)}; printf 'F1_SANDBOX_%s_20261109\\n' ALLOW`,
      'F1 explicit Host sandbox policy')
    const sandboxAllowEvent = await waitForHostSessionEventAfter(dshHome, sandboxSessionId, beforeSandboxAllow.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(sandboxAllow),
      'F1 sandbox allow Session write')
    const sandboxAllowText = hostUserTexts([sandboxAllowEvent])[0] ?? ''
    assert(sandboxAllowText.includes(sandboxAllow) && sandboxAllowText.includes('[exit 0]'),
      'the sandbox allow ! result is committed to the Session with its terminal outcome')
    await sandboxClient.waitForScreen('f1-shell answer', 'F1 sandbox allow Host follow-up', 30_000)
    const sandboxPolicy = await waitForC1WorkEvent(
      sandboxHostWorkRoot,
      event => event.kind === 'f1-host-effective-shell-policy' && event.agentId === sandboxSessionId,
      'F1 effective sandbox policy source',
    )
    assert(sandboxPolicy.localShellSandbox === 'sandbox',
      `the Host profile's effective second-run policy must be sandbox; Settings namespaces=${JSON.stringify(sandboxPolicy.settingsNamespaces)}`)
    assert(existsSync(allowedPath), 'full Host sandbox allows writes under the exact Session workspace')

    const beforeSandboxDeny = hostUserTexts(hostSessionEvents(dshHome, sandboxSessionId) ?? [])
    const sandboxDeny = 'F1_SANDBOX_DENY_ATTEMPT_20261109'
    assert(!existsSync(deniedPath), 'the sandbox confinement target remains absent before the denied write')
    await submitShellCommand(sandboxClient, '!!', `printf '${sandboxDeny}\\n'; touch ${shellQuote(deniedPath)}`,
      'F1 sandbox outside-workspace denial')
    await waitForLocalShellSettled(sandboxClient, sandboxDeny, '[exit 1]', 'F1 sandbox outside-workspace denial')
    // The folded card only paints the terminal outcome; the denial
    // classification and the attempted command live in the retained body.
    await assertExpandedLocalShellFacts(sandboxClient, [sandboxDeny, 'sandbox denied', '[exit 1]'],
      'F1 sandbox outside-workspace denial')
    await waitForLocalShellSettled(sandboxClient, sandboxDeny, '[exit 1]', 'F1 sandbox denial folded restoration')
    const afterSandboxDeny = hostUserTexts(hostSessionEvents(dshHome, sandboxSessionId) ?? [])
    assert(afterSandboxDeny.length === beforeSandboxDeny.length, 'the sandbox denial !! card adds no Session/model write')
    assert(!existsSync(deniedPath), 'Host sandbox blocked a write to the positively writable worktree-root sibling')

    const finalEvents = hostSessionEvents(dshHome, sessionId) ?? []
    const finalUserMessages = [
      ...hostUserTexts(finalEvents),
      ...hostUserTexts(hostSessionEvents(dshHome, sandboxSessionId) ?? []),
    ]
    const expectedShellResults = [hostMarker, bypassMarker, nonzeroMarker, sandboxAllow, 'F1_CLIENT_B_SURVIVED_20261109', truncTail]
    for (const marker of expectedShellResults) {
      assert(finalUserMessages.filter(text => text.includes(marker)).length === 1,
        `! writes its captured result to the exact Session once for ${marker}`)
    }
    assert(!finalUserMessages.some(text => text.includes(sandboxDeny)), 'sandbox denial uses !! and adds no model context')
    assert(!finalUserMessages.some(text => text.includes(signalMarker)), '!! signal outcomes add no model context')
    assert(!finalUserMessages.some(text => text.includes(disconnectMarker)), 'an indeterminate one-shot outcome is never replayed into the Session')
    assert(!finalUserMessages.some(text => text.includes(localMarker)), '!! has no durable Shell result')
    assert(!finalUserMessages.some(text => text.includes(rawMarker)), 'the raw Bash !! adds no durable Shell result')
    assert(!finalUserMessages.some(text => text.includes(childMarker)), 'cancelled Client A has no durable partial result')
    trace('m6-f1-host-user-shell', {
      tarball: context.tarball,
      candidateSha256: context.candidateSha256,
      hostInstances: [
        { policy: 'bypass', instanceId: ready.localHost.instanceId, pid: ready.localHost.hostPid },
        { policy: 'sandbox', instanceId: sandboxReady.localHost.instanceId, pid: sandboxReady.localHost.hostPid },
      ],
      sessionId,
      hostCwd: canonicalHostDir,
      clientCwd: canonicalClientDir,
      clientBCwd: realpathSync(clientDirB),
      hostHome,
      clientHome,
      hostPath,
      clientPath,
      hostCommand: 'F1_HOST_COMMAND_20261109',
      clientCommand: 'F1_CLIENT_COMMAND_20261109 absent from results and suggestions',
      policies: {
        bypassOutsideWorkspaceWrite: existsSync(bypassOutside),
        sandboxAllowedWorkspaceWrite: existsSync(allowedPath),
        sandboxDeniedOutsideWorkspaceWrite: existsSync(deniedPath),
        sandboxDenialMode: '!!/card-only',
      },
      independentClients: { clientA: 'cancelled', clientB: 'settled' },
      shellResultWrites: expectedShellResults.length,
      bangBangWrites: afterBangBangEvents.length - beforeBangBang,
      oneShot: {
        boundedSessionTextBytes: Buffer.byteLength(truncText, 'utf8'),
        stdoutTruncated: truncText.includes('stdout truncated'),
        stderrTruncated: truncText.includes('stderr truncated'),
        tailRetained: truncText.includes(truncTail),
        beginningDropped: !truncText.includes(truncBegin),
        rawBash: { wait: true, backgroundExit: true, signalWait: true, fdSplit: true },
      },
      result: 'PASS',
    })
    return { status: 'PASS', sessionId }
  } finally {
    try {
      await scene.dispose()
    } finally {
      if (bypassProbeOwned && existsSync(bypassOutside)
        && readFileSync(bypassOutside, 'utf8') === `${bypassMarker}\n`) {
        unlinkSync(bypassOutside)
      }
      if (existsSync(deniedPath)) unlinkSync(deniedPath)
    }
  }
}
