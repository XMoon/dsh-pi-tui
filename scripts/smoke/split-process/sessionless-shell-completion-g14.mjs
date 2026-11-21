/**
 * M6-1/G14 L5/L6: the REAL Host / REAL Split Client SESSIONLESS Shell
 * completion qualification.
 *
 * ONE real Host process and genuine Sessionless TUI Clients on independent
 * `script(1)` PTYs. Every Client selects a DIFFERENT officially registered
 * Host Workspace (the F5-B C1 fixture), has its own HOME/PATH/cwd, and drives
 * the REAL `!`/`!!` editor completion through the real PTY Tab:
 *
 *   G14-A  Client A's completion answers from the HOST environment of its
 *          selected Workspace: the Host-only command, the Host-only variable,
 *          the real `git` subcommand list and the Workspace path marker. The
 *          same-prefix Client PATH/HOME/cwd twins never appear. No Session.
 *   G14-B  Client B on a DIFFERENT Workspace answers with ITS marker only: the
 *          two Workspaces never cross candidates.
 *   G14-C  a real A→B→A Workspace switch through the production `/sessions`
 *          directory picker re-targets the completion to the CURRENT
 *          Workspace: the intermediate Workspace's marker is not offered
 *          after the switch back.
 *   G14-D  an unreadable Host Workspace paints NO candidate and the Client
 *          never falls back to its own same-prefix files.
 *   G14-E  a Sessionless Client whose Workspace proposal was REFUSED (unselected
 *          target) paints NO candidate at all.
 *
 * L6 boundary: the negative observables above are "no candidate painted, never
 * a Client-path fallback". The distinction between `unavailable` and an
 * authoritative empty `ok([])`, and the unselected ZERO-dispatch guarantee, are
 * contract facts proven by the L2 host-service and L3 Remote-adapter tests (a
 * `!` dropdown cannot paint that distinction); this case does not re-claim them.
 * The A→B→A witness proves the CURRENT-selection answer after a real keyboard
 * switch; the HELD in-flight answer fence (an old answer released after the
 * switch can never paint/apply) is proven by the discriminating L4 unit test,
 * because no production fault hook may delay a Host completion for a smoke.
 *
 * Nothing here creates a Session/Agent: the whole case runs with every Client
 * `sessionOpen === false`, an unchanged durable Host Session inventory and an
 * unchanged Host identity.
 *
 * @module split-process/sessionless-shell-completion-g14
 */

import { chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, lastSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { completeFromTui, waitForComposerMode, waitForComposerText } from './shell-tui-driving.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Every durable entry under the isolated Host Session store. Only a MISSING
 *  store is empty: any other read failure is a real error, never a silent []. */
function sessionInventory(dshHome) {
  const root = join(dshHome, 'sessions')
  try {
    return readdirSync(root, { recursive: true }).map(entry => String(entry)).sort()
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
}

/** Wait for the Welcome's CONFIRMED Host directory. The card paints the label
 *  and the long path on SEPARATE rows when the path does not fit the card's
 *  value column, so the wait matches the confirmed label row followed by the
 *  canonical path row (never `Checking`/`Proposed`/`unavailable`). */
async function waitForConfirmedDirectory(client, canonicalPath, label, timeoutMs = 120_000) {
  const started = Date.now()
  // The card paints the confirmed directory on ONE row when it fits the value
  // column, or WRAPS the path over several rows when it does not (the host
  // home/work root length and the whale variant both change the column). The
  // match therefore flattens the painted frame: box glyphs and whitespace are
  // removed so a wrapped path becomes contiguous again, while the confirmed
  // LABEL stays distinct from `Checking Host directory:` and the unavailable
  // state.
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  while (Date.now() - started < timeoutMs) {
    const rows = await client.viewport()
    // The Welcome is a side-by-side card: the whale art owns the left columns
    // and the FACTS column (label plus the value, wrapped by the card width)
    // starts at the label's column. Slicing each row from that exact column
    // keeps the whale's continuation-row art out of a wrapped path.
    const labelRow = rows.find(row => String(row).includes('Host directory:'))
    if (labelRow === undefined) {
      await sleep(50)
      continue
    }
    const factsStart = String(labelRow).indexOf('Host directory:')
    const flat = rows
      .map(row => {
        const text = String(row)
        return text.length > factsStart ? text.slice(factsStart) : ''
      })
      .join('')
      .replace(/[│╭╮╰╯─]/gu, '')
      .replace(/\s+/gu, '')
    if (!flat.includes('CheckingHostdirectory:')
      && !flat.includes('Hostdirectoryunavailable:')
      && flat.includes(flatPath)) return
    await sleep(50)
  }
  throw new SplitSmokeAssertionError(`${label}: the Welcome never confirmed ${canonicalPath} (got ${JSON.stringify((await client.viewport()).slice(0, 12))})`)
}

/** The absence window for a completion that must paint NOTHING. */
const ABSENCE_WINDOW_MS = 2_000

/**
 * The composed rows of the prompt box with box chrome normalized away. A
 * REFUSED Workspace proposal legitimately paints its own `[tui] … WARN` notice
 * on the prompt row; the draft-mode witness below therefore looks at the ROW
 * PREFIX (the mode glyph) instead of the strict empty-composer contract that
 * the selected-Workspace clients use.
 */
function promptRows(composer) {
  return (composer ?? '').split('\n')
    .map(line => line.replace(/[│┌┐└┘─]/gu, ' ').trim())
}

/** Wait until the FIRST prompt row starts with `prefix` (the mode glyph). */
async function waitForPromptRow(client, prefix, label, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = promptRows(await client.composerText())
    if (rows[0]?.startsWith(prefix) === true) return
    await sleep(50)
  }
  throw new SplitSmokeAssertionError(`${label}: the first prompt row never started with ${JSON.stringify(prefix)}: ${JSON.stringify(await client.composerText())}`)
}

/** Run the Sessionless Host Workspace Shell-completion qualification. */
export async function runSessionlessShellCompletionG14(context) {
  const { workDir, dshHome, installation, trace } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, dispose } = scene
  const hostHome = installation.home
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const alphaName = `g14-alpha-${unique}`
  const betaName = `g14-beta-${unique}`
  // The Workspaces live under the isolated Host account (the official
  // directory picker's root), so the A→B→A switch is drivable through the
  // real `/sessions` Add-directory editor without any test-only shortcut.
  const alphaDir = join(hostHome, alphaName)
  const betaDir = join(hostHome, betaName)
  const clientDirA = join(workDir, `g14-client-a-${unique}`)
  const clientDirB = join(workDir, `g14-client-b-${unique}`)
  const clientHomeA = join(workDir, `g14-home-a-${unique}`)
  const clientHomeB = join(workDir, `g14-home-b-${unique}`)
  const clientHomeC = join(workDir, `g14-home-c-${unique}`)
  const hostBin = join(workDir, `g14-host-bin-${unique}`)
  const clientBin = join(workDir, `g14-client-bin-${unique}`)
  const missingIntent = join(workDir, `g14-missing-${unique}`)
  const alphaMarker = `g14-alpha-marker-${unique}.txt`
  const betaMarker = `g14-beta-marker-${unique}.txt`
  const alphaClientTwin = `g14-alpha-client-${unique}.txt`
  const betaClientTwin = `g14-beta-client-${unique}.txt`
  const hostCommand = join(hostBin, 'g14-host-command')
  const clientCommand = join(clientBin, 'g14-client-command')
  const hostPath = `${hostBin}:/usr/bin:/bin`
  const clientPath = `${clientBin}:/usr/bin:/bin`
  const hostVariable = 'G14_HOST_VARIABLE_20261113'
  const clientVariable = 'G14_CLIENT_VARIABLE_20261113'
  for (const directory of [alphaDir, betaDir, clientDirA, clientDirB, clientHomeA, clientHomeB, clientHomeC, hostBin, clientBin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  assert(alphaDir !== betaDir && clientDirA !== clientDirB, 'G14 the two Workspace/Client fixtures are the same directory')
  writeFileSync(join(alphaDir, alphaMarker), 'G14_ALPHA_HOST\n', { mode: 0o600 })
  writeFileSync(join(betaDir, betaMarker), 'G14_BETA_HOST\n', { mode: 0o600 })
  // Same-prefix Client twins: if completion ever read the Client directory the
  // twin would be offered instead of the Host Workspace marker.
  writeFileSync(join(clientDirA, alphaClientTwin), 'G14_ALPHA_CLIENT\n', { mode: 0o600 })
  writeFileSync(join(clientDirB, betaClientTwin), 'G14_BETA_CLIENT\n', { mode: 0o600 })
  writeFileSync(hostCommand, '#!/bin/sh\nprintf "G14_HOST_COMMAND_20261113\\n"\n', { mode: 0o700 })
  writeFileSync(clientCommand, '#!/bin/sh\nprintf "G14_CLIENT_COMMAND_20261113\\n"\n', { mode: 0o700 })

  try {
    const { host, ready } = await startC1Host('unowned-job', 'G14', {
      HOME: hostHome,
      PATH: hostPath,
      [hostVariable]: 'host-value',
    })
    assert(ready.localHost?.hostPid > 0 && typeof ready.localHost?.hostStarttime === 'string',
      `G14 the Host Ready record carries no authenticated process identity: ${JSON.stringify(ready.localHost)}`)
    const hostIdentity = { pid: ready.pid, starttime: ready.localHost?.hostStarttime }
    const sessionsBefore = sessionInventory(dshHome)

    // ── G14-A: Client A answers from the HOST environment of Workspace A ────
    const { client: clientA, ready: readyA } = await startC1Client('G14 client A', {
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: alphaDir,
      HOME: clientHomeA,
      PATH: clientPath,
      [clientVariable]: 'client-poison',
    }, { cwd: clientDirA })
    assert(readyA.sessionOpen === false && readyA.surfaceMounted === true,
      `G14 alpha is not a mounted sessionless surface: ${JSON.stringify(readyA)}`)
    await waitForConfirmedDirectory(clientA, realpathSync(alphaDir), 'G14 alpha confirmed Host directory')
    const aView = (await clientA.viewport()).join('\n')
    assert(!aView.includes(betaMarker), 'G14 alpha painted the OTHER Workspace marker before any completion')

    await completeFromTui(clientA, '!g14-host-', 'g14-host-command', 'g14-client-command',
      'G14-A Host-only command')
    await completeFromTui(clientA, '!echo $G14_HOST_VAR', `$${hostVariable}`, `$${clientVariable}`,
      'G14-A Host-only variable')
    await completeFromTui(clientA, '!git che', 'checkout', clientVariable,
      'G14-A Host git subcommand')
    await completeFromTui(clientA, '!cat g14-alpha-', alphaMarker, alphaClientTwin,
      'G14-A Host Workspace path')
    // The `!!` local mode shares the SAME Host completion authority.
    await completeFromTui(clientA, '!!cat g14-alpha-', alphaMarker, alphaClientTwin,
      'G14-A Host Workspace path in !! mode')

    // ── G14-B: Client B on a DIFFERENT Workspace answers with ITS marker ────
    const { client: clientB, ready: readyB } = await startC1Client('G14 client B', {
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: betaDir,
      HOME: clientHomeB,
      PATH: clientPath,
      [clientVariable]: 'client-poison',
    }, { cwd: clientDirB })
    assert(readyB.sessionOpen === false && readyB.surfaceMounted === true,
      `G14 beta is not a mounted sessionless surface: ${JSON.stringify(readyB)}`)
    await waitForConfirmedDirectory(clientB, realpathSync(betaDir), 'G14 beta confirmed Host directory')
    const bView = (await clientB.viewport()).join('\n')
    assert(!bView.includes(alphaMarker), 'G14 beta painted the OTHER Workspace marker before any completion')
    await completeFromTui(clientB, '!cat g14-beta-', betaMarker, betaClientTwin,
      'G14-B beta Workspace path')
    const aAfter = (await clientA.viewport()).join('\n')
    assert(!aAfter.includes(betaMarker), 'G14 alpha leaked the beta Workspace marker')
    const bAfter = (await clientB.viewport()).join('\n')
    assert(!bAfter.includes(alphaMarker), 'G14 beta leaked the alpha Workspace marker')

    // ── G14-C: the real A→B→A Workspace switch through `/sessions` ──────────
    // Each switch registers/uses the Host path through the production
    // `/sessions` Add-directory editor (the ONE official Workspace resolve).
    // It never creates a Session.
    const switchWorkspace = async (client, name, label) => {
      client.send('/sessions\r')
      await client.waitForScreen('Sessions ·', `${label} Workspace tree`, 120_000)
      await client.waitForScreen('Add directory', `${label} Add directory row`, 60_000)
      client.send('\x1b[H')
      await sleep(150)
      client.send('\r')
      await client.waitForScreen('Host directory:', `${label} inline Host editor`, 60_000)
      await client.waitForScreen(hostHome, `${label} Host home prefill`, 60_000)
      client.send(name)
      await client.waitForScreen(`> ${name}/`, `${label} official Host Workspace candidate`, 60_000)
      client.send('\t')
      await client.waitForScreen(`${name}/`, `${label} accepted Host path`, 60_000)
      client.send('\r')
      await client.waitForScreen('Directory added:', `${label} registered directory fact`, 120_000)
      assert(lastSurfaceStatus(client)?.sessionOpen === false, `${label} Workspace switch created a Session`)
      client.send('\x1b')
      await client.waitForScreenGone('Sessions ·', `${label} Browser closes back to the Welcome`, 60_000)
    }
    await switchWorkspace(clientA, betaName, 'G14-C switch to beta')
    await completeFromTui(clientA, '!cat g14-beta-', betaMarker, alphaMarker,
      'G14-C beta completion after the switch')
    await switchWorkspace(clientA, alphaName, 'G14-C switch back to alpha')
    await completeFromTui(clientA, '!cat g14-alpha-', alphaMarker, betaMarker,
      'G14-C alpha completion after A→B→A')

    // ── G14-D: an unreadable Host Workspace is unavailable ───────────────────
    // The directory is made UNREADABLE instead of deleted: the shared-lane
    // profile must never be left with a registered path that no longer exists.
    chmodSync(betaDir, 0o000)
    await waitForComposerMode(clientB, 'prompt', 'G14-D beta prompt preparation')
    clientB.send('!')
    await waitForComposerMode(clientB, '!', 'G14-D beta shell-mode activation')
    clientB.send('cat g14-beta-')
    await waitForComposerText(clientB, 'cat g14-beta-', 'G14-D beta draft body')
    clientB.send('\t')
    await sleep(ABSENCE_WINDOW_MS)
    const goneFrame = (await clientB.viewport()).join('\n')
    assert(!goneFrame.includes(betaClientTwin),
      `G14 an unreadable Host Workspace fell back to a Client-only candidate:\n${goneFrame}`)
    assert(!(await clientB.composerText() ?? '').includes(betaMarker),
      'G14 an unreadable Host Workspace produced a stale uncached marker')
    clientB.send('\x15')
    await waitForComposerMode(clientB, '!', 'G14-D beta draft reset')
    clientB.send('\x1b')
    await waitForComposerMode(clientB, 'prompt', 'G14-D beta prompt mode')
    chmodSync(betaDir, 0o700)

    // ── G14-E: a refused Workspace proposal is unselected: NO candidate ─────
    const { client: clientC, ready: readyC } = await startC1Client('G14 client C', {
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: missingIntent,
      HOME: clientHomeC,
      PATH: clientPath,
      [clientVariable]: 'client-poison',
    }, { cwd: clientDirB })
    assert(readyC.sessionOpen === false && readyC.surfaceMounted === true,
      `G14 unselected client is not a mounted sessionless surface: ${JSON.stringify(readyC)}`)
    await clientC.waitForScreen('Host directory unavailable', 'G14-E refused Workspace proposal', 120_000)
    await waitForPromptRow(clientC, '❯', 'G14-E unselected prompt row')
    clientC.send('!')
    await waitForPromptRow(clientC, '!', 'G14-E unselected shell-mode row')
    clientC.send('g14-host-')
    await waitForComposerText(clientC, 'g14-host-', 'G14-E unselected draft body')
    clientC.send('\t')
    await sleep(ABSENCE_WINDOW_MS)
    const unselectedFrame = (await clientC.viewport()).join('\n')
    assert(!unselectedFrame.includes('g14-host-command'),
      `G14 an unselected scope served a Host candidate:\n${unselectedFrame}`)
    assert(!unselectedFrame.includes('g14-client-command'),
      'G14 an unselected scope fell back to a Client-only candidate')
    assert((await clientC.composerText() ?? '').includes('g14-host-'),
      'G14 an unselected Tab must leave the draft untouched')
    clientC.send('\x03')
    await exitC1Client(clientC, 'G14 unselected client C')

    // ── Zero Session/Agent and one unchanged Host across the whole case ─────
    for (const [client, name] of [[clientA, 'alpha'], [clientB, 'beta']]) {
      assert(lastSurfaceStatus(client)?.sessionOpen === false, `G14 Client ${name} opened a Session`)
    }
    const sessionsAfter = sessionInventory(dshHome)
    assert(JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore),
      `G14 the case created a durable Host Session: ${JSON.stringify(sessionsBefore)} -> ${JSON.stringify(sessionsAfter)}`)
    const hostAfter = await hostStatus(host)
    assert(hostAfter.pid === hostIdentity.pid && hostAfter.localHost?.hostStarttime === hostIdentity.starttime,
      `G14 the Host identity changed during the case: ${JSON.stringify({ before: hostIdentity, after: { pid: hostAfter.pid, starttime: hostAfter.localHost?.hostStarttime } })}`)
    await exitC1Client(clientA, 'G14 client A')
    await exitC1Client(clientB, 'G14 client B')
    trace('g14-sessionless-shell-completion', {
      candidate: context.candidateSha256,
      hostPid: ready.localHost?.hostPid,
      hostStarttime: ready.localHost?.hostStarttime,
      instanceId: ready.localHost?.instanceId,
      workspaces: { alpha: alphaName, beta: betaName },
      hostCommand: 'g14-host-command',
      clientCommand: 'g14-client-command absent from every candidate',
      hostVariable,
      clientVariable: `${clientVariable} absent from every candidate`,
      twoWorkspacesIsolated: true,
      workspaceSwitchRetargets: true,
      unreadableWorkspaceNoCandidate: true,
      unselectedNoCandidate: true,
      unavailableVsEmptyAndZeroDispatch: 'proven at L2/L3, not observable in the dropdown',
      heldLateAnswerFence: 'L4 discriminating unit test (no production fault hook)',
      sessionsCreated: sessionsAfter.length - sessionsBefore.length,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
