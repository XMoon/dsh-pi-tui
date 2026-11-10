/** Real installed-tarball PTY qualification for the F1 Host Shell capability. */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, hostUserTexts, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function runShell(client, mode, command, marker, terminal, label) {
  client.send(mode)
  client.send(command)
  client.send('\r')
  // The marker also rides the painted COMMAND ROW, so a plain viewport wait
  // returns before the command's real output exists. Only output painted
  // OUTSIDE the composer proves the run produced it.
  await waitForScreenOutsideComposer(client, marker, `${label} output`, 60_000)
  try {
    await client.waitForScreen(terminal, `${label} terminal fact`, 60_000)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label} terminal fact ${terminal} was not painted: ${String(error)}; frameTail=${(await client.viewport()).slice(-18).join('\\n')}`)
  }
}

/** The composer rows with box chrome and padding normalized away. */
function composerRows(composer) {
  return composer?.split('\n')
    .map(line => line.replace(/[│┌┐└┘─]/gu, ' ').trim())
    .filter(Boolean) ?? []
}

/**
 * Wait for the AUTHORITATIVE empty composer of `mode`. This never types an
 * Escape: every transition before the wait is a product-owned input action,
 * so a timeout is a real state failure and no stray ESC is left queued for
 * the next completion's literal `!`.
 */
async function waitForComposerMode(client, mode, label, timeoutMs = 30_000) {
  const expected = mode === 'prompt' ? '❯' : mode
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = composerRows(await client.composerText())
    // The empty draft may paint a dim PLACEHOLDER hint after the prompt glyph
    // (observed as '❯ ………'). It is presentation-only, not draft text, so the
    // empty-mode witness strips trailing ellipsis/dot padding instead of
    // demanding a literally bare glyph row.
    // EMPTY-EDITOR witness: the mode glyph must be followed by NO draft text.
    // A connection banner / diagnostic line may share the composer box after a
    // transport drop; that presentation-only hint is the sole tolerated body.
    const first = rows[0] ?? ''
    const shellLocalIsNotContext = expected === '!' && first.startsWith('!!')
    if (!shellLocalIsNotContext && first.startsWith(expected)) {
      const body = first.slice(expected.length).replace(/[\s.…·]+$/u, '').trim()
      // Presentation-only hints: an empty body, a pure placeholder, or a
      // connection banner whose remaining text is still the banner itself.
      const hintOnly = body === ''
        || /^[…·]+$/u.test(body)
        || (/^\[connection\]/u.test(body) && /(?:connection lost|reconnect|retry)/iu.test(body))
      if (hintOnly) return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label} did not reach the empty ${mode} composer: ${JSON.stringify(await client.composerText())}`)
}

/** Wait until the CURRENT composer draft holds `text` (never the transcript). */
async function waitForComposerText(client, text, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await client.composerText() ?? '').includes(text)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label} did not reach the composer: ${JSON.stringify(await client.composerText())}`)
}

/**
 * Rows painted BELOW the composer box (after its bottom rule). The transcript
 * is above the box, so a candidate found here belongs ONLY to the completion
 * dropdown painted by the current Tab — never to old transcript text. The
 * footer shares this region but never carries a completion candidate.
 */
function belowComposerRows(viewport) {
  let bottom = -1
  for (let index = 0; index < viewport.length; index += 1) {
    if (/^─+$/u.test(viewport[index].trim())) bottom = index
  }
  return bottom === -1 ? [] : viewport.slice(bottom + 1)
}

/**
 * Wait for a marker that must appear OUTSIDE the composer. A marker string is
 * also part of the painted COMMAND ROW before submission, so a plain
 * waitForScreen() can match the draft instead of the command's real output.
 */
async function waitForScreenOutsideComposer(client, needle, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const viewport = await client.viewport()
    const composer = (await client.composerText()) ?? ''
    if (viewport.join('\n').includes(needle) && !composer.includes(needle)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label}: ${needle} never appeared outside the composer: ${JSON.stringify(await client.composerText())}`)
}

async function completeFromTui(client, input, candidate, forbidden, label) {
  const mode = input.startsWith('!!') ? '!!' : '!'
  const body = input.slice(mode.length)
  await waitForComposerMode(client, 'prompt', `${label} prompt preparation`)
  // `!` is editor STATE, not text: send it alone and wait for the painted
  // shell prompt before the body, so a coalesced chunk can never insert the
  // prefix as literal draft text.
  client.send(mode)
  await waitForComposerMode(client, mode, `${label} shell-mode activation`)
  client.send(body)
  // The body must be the CURRENT draft before Tab: this both proves the text
  // landed and guarantees the Tab is a separate input event.
  await waitForComposerText(client, body, `${label} draft body`)
  // Baseline the pre-Tab frame. A candidate already present above the box
  // (the transcript already holds earlier Host command names/results) must
  // never be mistaken for this Tab's suggestion.
  const beforeFrame = await client.viewport()
  const beforeComposer = (await client.composerText()) ?? ''
  assert(!beforeComposer.includes(candidate), `${label} candidate was already in the draft before Tab`)
  assert(!belowComposerRows(beforeFrame).join('\n').includes(candidate),
    `${label} candidate was already below the composer before Tab`)
  client.send('\t')
  // Tab has exactly two user-visible outcomes:
  //   applied -> a single candidate is applied in place: the draft gains the
  //              candidate plus the shell completion's trailing space;
  //   menu    -> several candidates open a dropdown painted BELOW the box.
  // Only those two CURRENT-frame facts count; a transcript match does not.
  const deadline = Date.now() + 30_000
  let offered
  let offeredDraft = ''
  while (Date.now() < deadline) {
    const viewport = await client.viewport()
    const draft = client.composerOf(viewport) ?? ''
    if (draft.includes(candidate)) {
      offered = 'applied'
      offeredDraft = draft
      break
    }
    if (belowComposerRows(viewport).join('\n').includes(candidate)) {
      offered = 'menu'
      offeredDraft = draft
      break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (offered === undefined) {
    throw new SplitSmokeAssertionError(`${label} did not produce ${candidate} in the current completion UI: frameTail=${(await client.viewport()).slice(-12).join('\\n')}; composer=${JSON.stringify(await client.composerText())}`)
  }
  // The same CURRENT completion surface must never offer the Client candidate.
  const offeredBelow = belowComposerRows(await client.viewport()).join('\n')
  assert(!offeredDraft.includes(forbidden) && !offeredBelow.includes(forbidden),
    `${label} leaked a Client-only suggestion into the current completion UI: composer=${JSON.stringify(offeredDraft)}; below=${JSON.stringify(offeredBelow)}`)
  if (offered === 'menu') {
    // The dropdown needs a SECOND Tab: the fork applies the SELECTED row and
    // closes the dropdown in the same painted state. Require BOTH the draft
    // to change and the candidate row to disappear; a fenced/rejected apply
    // leaves the old menu painted and must fail, never "succeed" from it.
    const draftBeforeAccept = offeredDraft
    client.send('\t')
    const acceptDeadline = Date.now() + 30_000
    let accepted = false
    while (Date.now() < acceptDeadline) {
      const viewport = await client.viewport()
      const draft = client.composerOf(viewport) ?? ''
      const stillOffered = belowComposerRows(viewport).join('\n').includes(candidate)
      if (draft !== draftBeforeAccept && !stillOffered) {
        accepted = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(accepted, `${label} dropdown acceptance did not commit a new draft and close the menu: composer=${JSON.stringify(await client.composerText())}`)
    const acceptedDraft = (await client.composerText()) ?? ''
    assert(!acceptedDraft.includes(forbidden), `${label} accepted draft leaked a Client-only suggestion: ${JSON.stringify(acceptedDraft)}`)
  }
  // Reset the shell draft through the editor's OWN action
  // (tui.editor.deleteToLineStart / Ctrl+U). No backspace length arithmetic
  // and no replayed Escape: a shell completion's trailing space or a quoted
  // path can never desync the cleanup.
  client.send('\x15')
  await waitForComposerMode(client, mode, `${label} draft reset`)
  // ONE consumed Escape on the empty shell body steps the mode back to the
  // prompt. The empty-composer wait above proves the body was gone, and the
  // prompt wait below proves the Escape was consumed before any later `!`.
  client.send('\x1b')
  await waitForComposerMode(client, 'prompt', `${label} return to prompt mode`)
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
    const hostFacts = `printf '${hostMarker}\\n'; printf 'CWD=%s\\nHOME=%s\\nPATH=%s\\nF1_HOST_VARIABLE=%s\\n' "$PWD" "$HOME" "$PATH" "$F1_HOST_VARIABLE_20261109"; cat host-only.txt; f1-host-command`
    await runShell(clientA, '!', hostFacts, hostMarker, 'exit 0', 'F1 bypass !')
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
    await runShell(clientA, '!!', `printf '${localMarker}\\n'; pwd; printf 'HOME=%s\\n' "$HOME"`, localMarker, 'exit 0', 'F1 bypass !!')
    const afterBangBangEvents = hostSessionEvents(dshHome, sessionId) ?? []
    assert(afterBangBangEvents.length === beforeBangBang, '!! has no Session or model write')
    assert(!hostUserTexts(afterBangBangEvents).some(text => text.includes(localMarker)), '!! output remains only on its card')
    await runShell(clientA, '!', `printf '${bypassMarker}\\n'; printf '${bypassMarker}\\n' > ${shellQuote(bypassOutside)}`,
      bypassMarker, 'exit 0', 'F1 explicit Host bypass policy')
    assert(readFileSync(bypassOutside, 'utf8') === `${bypassMarker}\n`, 'Host bypass writes to the worktree-root sibling outside its Session workspace')
    bypassProbeOwned = true
    await waitForHostSessionEventAfter(dshHome, sessionId, afterBangBangEvents.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(bypassMarker),
      'F1 bypass outside-workspace result Session write')
    const beforeSignal = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    const signalMarker = 'F1_SIGTERM_20261109'
    await runShell(clientA, '!!', `printf '${signalMarker}\\n'; kill -TERM "$BASHPID"`, signalMarker, 'signal SIGTERM', 'F1 signal outcome')
    const afterSignal = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
    assert(afterSignal.length === beforeSignal.length, 'signal outcome from !! adds no Session/model write')

    const beforeNonzero = hostSessionEvents(dshHome, sessionId) ?? []
    const nonzeroMarker = 'F1_EXIT_7_20261109'
    await runShell(clientA, '!', `printf '${nonzeroMarker}\\n'; exit 7`, nonzeroMarker, 'exit 7', 'F1 nonzero exit')
    await waitForHostSessionEventAfter(dshHome, sessionId, beforeNonzero.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(nonzeroMarker),
      'F1 nonzero Host result Session write')
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
      'case $p in ""|*[!0-9]*) printf "F1_WAIT_PID=invalid\\n" ;; *) printf "F1_WAIT_PID=numeric\\n" ;; esac',
      '(exit 7) & q=$!',
      'wait "$q"',
      `printf 'F1_WAIT_BG=%s\\n' "$?"`,
      '(sleep 5) & k=$!',
      'kill -TERM "$k"',
      'wait "$k"',
      `printf 'F1_WAIT_SIG=%s\\n' "$?"`,
      `printf 'F1_STREAM_OUT_20261110\\n'`,
      `printf 'F1_STREAM_ERR_20261110\\n' >&2`,
    ].join('; ')
    await runShell(clientA, '!!', rawCommand, rawMarker, 'exit 0', 'F1 raw Bash $!/wait/FD semantics')
    // The LAST fact printed by the command is the settle witness: waiting for
    // it (not for the command-row marker) proves every earlier fact rendered.
    await waitForCondition(async () => (await clientA.viewport()).join('\\n').includes('F1_STREAM_ERR_20261110'),
      'F1 raw Bash last stream fact', 30_000)
    const rawFrame = (await clientA.viewport()).join('\\n')
    for (const fact of [
      'F1_WAIT_STATUS=0',
      'F1_WAIT_PID=numeric',
      'F1_WAIT_BG=7',
      'F1_WAIT_SIG=143',
      'F1_STREAM_OUT_20261110',
      'F1_STREAM_ERR_20261110',
    ]) {
      assert(rawFrame.includes(fact), `F1 raw Bash fact ${fact} is missing: ${rawFrame}`)
    }


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
    clientA.send(`/resume ${sessionId}\r`)
    await clientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'F1 Client A returns to Session A after the scope switch',
      60_000,
    )
    // A session commit repaints the seat; prove the editor accepts input again
    // with a harmless round trip instead of assuming the painted glyph is live.
    clientA.send('x')
    await waitForComposerText(clientA, 'x', 'F1 Client A editor accepts input after the resume')
    clientA.send('\x7f')
    await waitForComposerMode(clientA, 'prompt', 'F1 Client A prompt restored after the resume')

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
    const disconnectCommand = `printf x >> ${shellQuote(disconnectCounter)}; printf '%s\\n' "$BASHPID" > ${shellQuote(disconnectPidPath)}; printf '${disconnectMarker}\\n'; sleep 30; printf finished > ${shellQuote(disconnectFinish)}`
    clientA.send(disconnectCommand)
    await waitForComposerText(clientA, 'printf x', 'F1 disconnect command draft')
    clientA.send('\r')
    // The marker string also rides the painted COMMAND ROW (and can wrap, so a
    // literal viewport scan is not reliable evidence). The pid file the command
    // writes BEFORE its marker is the authoritative "the Host command really
    // started" fact; wait for it before reading.
    await waitForCondition(() => existsSync(disconnectPidPath) && readFileSync(disconnectPidPath, 'utf8').trim() !== '',
      'F1 disconnect probe recorded its Host pid', 30_000)
    const shellPid = Number(readFileSync(disconnectPidPath, 'utf8').trim())
    assert(Number.isInteger(shellPid) && shellPid > 0, 'F1 disconnect probe recorded the Host Bash pid')
    clientA.signalBusiness('SIGUSR1')
    // The reconnected surface first has to be AUTHENTICATED: the status line
    // legitimately shows `connection lost, retry #N` (and a transitional
    // aborted card) while the transport is still re-establishing. Only after
    // the new generation is live can the run's indeterminate outcome be
    // presented, so that fact is awaited FIRST and the warning second.
    await clientA.waitFor(record => record.m4b2s === 'surface-status'
      && record.generationId !== disconnectGeneration
      && record.sessionOpen === true
      && record.openSessionId === sessionId,
    'F1 Client A authenticated reconnect generation', 120_000)
    try {
      await clientA.waitForScreen('do not retry automatically', 'F1 one-shot unknown-outcome warning', 30_000)
    } catch (error) {
      throw new SplitSmokeAssertionError(`F1 started-stream disconnect had no visible no-retry outcome: ${String(error)}; frameTail=${(await clientA.viewport()).slice(-18).join('\\n')}; latestStatus=${JSON.stringify(clientA.records.filter(record => record.m4b2s === 'surface-status').at(-1) ?? null)}`)
    }
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
    const beforeClientBRuns = hostSessionEvents(dshHome, sessionId) ?? []
    await waitForComposerMode(clientA, 'prompt', 'F1 cancel prompt preparation')
    clientA.send('!')
    await waitForComposerMode(clientA, '!', 'F1 cancel shell-mode activation')
    clientA.send(`printf 'F1_CLIENT_A_RUNNING_20261109\\n'; sleep 30; touch ${shellQuote(cancelFile)}; printf '${childMarker}\\n'`)
    await waitForComposerText(clientA, 'F1_CLIENT_A_RUNNING_20261109', 'F1 cancel command draft')
    clientA.send('\r')
    await waitForScreenOutsideComposer(clientA, 'F1_CLIENT_A_RUNNING_20261109', 'F1 Client A active Host run')
    await waitForComposerMode(clientB, 'prompt', 'F1 independent Client B prompt preparation')
    clientB.send('!')
    await waitForComposerMode(clientB, '!', 'F1 independent Client B shell-mode activation')
    clientB.send("printf 'F1_CLIENT_B_RUNNING_20261109\\n' >&2; sleep 2; printf 'F1_CLIENT_B_SURVIVED_20261109\\n'; printf 'F1_CLIENT_B_STDERR_20261109\\n' >&2")
    await waitForComposerText(clientB, 'F1_CLIENT_B_RUNNING_20261109', 'F1 independent Client B command draft')
    clientB.send('\r')
    await waitForScreenOutsideComposer(clientB, 'F1_CLIENT_B_RUNNING_20261109', 'F1 Client B independent Host run')
    clientA.send('\x1b')
    await clientA.waitForScreen('aborted', 'F1 Client A Host run cancellation', 30_000)
    await clientB.waitForScreen('F1_CLIENT_B_SURVIVED_20261109', 'F1 Client B remains unaffected', 30_000)
    await clientB.waitForScreen('F1_CLIENT_B_STDERR_20261109', 'F1 Client B stderr is captured by the official collector', 30_000)
    await clientB.waitForScreen('exit 0', 'F1 Client B Host run terminal fact', 30_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, beforeClientBRuns.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes('F1_CLIENT_B_SURVIVED_20261109'),
      'F1 Client B Session write')
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
      `printf '${truncTail}\\n'`,
      `printf '${truncStderrTail}\\n' >&2`,
    ].join('; ')
    const beforeTrunc = hostSessionEvents(dshHome, sessionId) ?? []
    // Do NOT use the generic runShell() terminal wait here: it waits for
    // `exit 0`, which every earlier `!`/`!!` card in this transcript already
    // paints. That wait can return on a STALE row, so the frame read next may
    // belong to a transitional or previous card. This run's unique truncation
    // text and its Session write are the only authority that the card settled.
    clientB.send('!')
    clientB.send(truncCommand)
    clientB.send('\r')
    await clientB.waitForScreen(truncStderrTail, 'F1 bounded truncated output', 60_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, beforeTrunc.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(truncTail),
      'F1 bounded truncated result Session write')
    await waitForCondition(async () => {
      const frame = (await clientB.viewport()).join('\\n')
      return frame.includes('stdout truncated') && frame.includes('stderr truncated')
    }, 'F1 settled truncated card markers', 30_000)
    const truncFrame = (await clientB.viewport()).join('\\n')
    assert(truncFrame.includes('stdout truncated') && truncFrame.includes('stderr truncated'),
      `the settled card must mark both truncated streams truthfully: ${truncFrame}`)
    const truncExitIndex = truncFrame.lastIndexOf('[exit 0]')
    assert(truncExitIndex > truncFrame.indexOf('stdout truncated')
      && truncExitIndex > truncFrame.indexOf('stderr truncated'),
      `the truncation markers must precede the card's exit marker: ${truncFrame}`)
    const truncWrites = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
      .filter(text => text.includes(truncTail))
    assert(truncWrites.length === 1, '! writes the bounded truncated result exactly once')
    const truncText = truncWrites[0] ?? ''
    assert(truncText.includes('stdout truncated') && truncText.includes('stderr truncated'),
      'the Session text explicitly represents both stream truncations')
    assert(truncText.includes('Host-local'), 'the Session text names the spill file as a Host-local fact')
    assert(!truncText.includes(truncBegin),
      'the bounded Session text keeps the tail, not the untruncated beginning')
    assert(Buffer.byteLength(truncText, 'utf8') < 200 * 1024,
      `the Session text stays bounded (got ${Buffer.byteLength(truncText, 'utf8')} bytes)`)
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
    await runShell(sandboxClient, '!', `touch ${shellQuote(allowedPath)}; printf '${sandboxAllow}\\n'`, sandboxAllow, 'exit 0', 'F1 explicit Host sandbox policy')
    await waitForHostSessionEventAfter(dshHome, sandboxSessionId, beforeSandboxAllow.length,
      event => event.type === 'user/message' && JSON.stringify(event).includes(sandboxAllow),
      'F1 sandbox allow Session write')
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
    await runShell(sandboxClient, '!!', `printf '${sandboxDeny}\\n'; touch ${shellQuote(deniedPath)}`,
      sandboxDeny, 'exit 1', 'F1 sandbox outside-workspace denial')
    const denialFrame = (await sandboxClient.viewport()).join('\\n')
    assert(denialFrame.includes(sandboxDeny) && denialFrame.includes('sandbox denied') && denialFrame.includes('exit 1'),
      `the Host sandbox must present its real denied-write classification and command result: ${(await sandboxClient.viewport()).slice(-18).join('\\n')}`)
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
