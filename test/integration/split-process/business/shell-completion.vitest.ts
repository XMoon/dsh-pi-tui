/**
 * Split-process business anchor: sessionless Host shell completion locality.
 *
 * One real Host started with `shellCompletionLocality: true` and three real
 * sessionless PTY Clients (distinct Client HOME/cwd and Supervisor-derived
 * Client twin bins/env). Proves `!` and `!!` completion answers from the
 * selected Host Workspace and Host environment without Client fallback,
 * retargets across real Workspace switches, and paints no candidate for an
 * unreadable Workspace or a refused Workspace proposal.
 */

import { accessSync, chmodSync, constants, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const HOST_COMMAND = 'workspace-command-host'
const CLIENT_COMMAND = 'workspace-command-client'
const HOST_VAR = 'WORKSPACE_COMPLETION_HOST'
const CLIENT_VAR = 'WORKSPACE_COMPLETION_CLIENT'
const ALPHA_FILE = 'workspace-path-alpha.txt'
const BETA_FILE = 'workspace-path-beta.txt'
const CLIENT_FILE = 'workspace-path-client.txt'

function splitFrame(frame: string): { composer: string; below: string } {
  const lines = frame.split('\n')
  const ruleIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) ruleIndices.push(index)
  }
  if (ruleIndices.length < 2) return { composer: '', below: '' }
  const top = ruleIndices.at(-2)!
  const bottom = ruleIndices.at(-1)!
  return {
    composer: lines.slice(top + 1, bottom).join('\n'),
    below: lines.slice(bottom + 1).join('\n'),
  }
}

function composerRows(frame: string): string[] {
  return splitFrame(frame).composer
    .split('\n')
    .map(line => line.replace(/[│┌┐└┘─]/gu, ' ').trim())
    .filter(Boolean)
}

async function waitForFrame(
  client: SplitProcessClient,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForConfirmedDirectory(
  client: SplitProcessClient,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  await waitForFrame(client, frame => {
    const rows = frame.split('\n')
    const labelRow = rows.find(row => row.includes('Host directory:'))
    if (labelRow === undefined) return false
    const factsStart = labelRow.indexOf('Host directory:')
    const flat = rows
      .map(row => (row.length > factsStart ? row.slice(factsStart) : ''))
      .join('')
      .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
      .replace(/\s+/gu, '')
    return !flat.includes('CheckingHostdirectory:')
      && !flat.includes('Hostdirectoryunavailable:')
      && flat.includes(flatPath)
  }, label, timeoutMs)
}

async function waitForEmptyMode(
  client: SplitProcessClient,
  mode: 'prompt' | '!' | '!!',
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const glyph = mode === 'prompt' ? '❯' : mode
  await waitForFrame(client, frame => {
    const first = composerRows(frame)[0] ?? ''
    if (glyph === '!' && first.startsWith('!!')) return false
    if (!first.startsWith(glyph)) return false
    const body = first.slice(glyph.length).replace(/[\s.…·]+$/u, '').trim()
    return body === '' || /^[…·]+$/u.test(body)
  }, label, timeoutMs)
}

async function waitForModeRow(
  client: SplitProcessClient,
  glyph: '❯' | '!' | '!!',
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForFrame(client, frame => {
    const first = composerRows(frame)[0] ?? ''
    if (glyph === '!' && first.startsWith('!!')) return false
    return first.startsWith(glyph)
  }, label, timeoutMs)
}

async function selectHostWorkspace(
  client: SplitProcessClient,
  hostHome: string,
  dirName: string,
  canonicalDir: string,
  label: string,
): Promise<void> {
  await waitForEmptyMode(client, 'prompt', `${label}: empty prompt before /sessions`)
  await client.type('/sessions')
  await waitForFrame(client, frame => splitFrame(frame).composer.includes('/sessions'), `${label}: typed /sessions`)
  await client.press('Enter')
  await waitForFrame(client, frame => frame.includes('Sessions ·') && frame.includes('Add directory'), `${label}: Workspace tree`)
  await client.press('Home')
  await waitForFrame(
    client,
    frame => frame.split('\n').some(line => line.includes('>') && line.includes('Add directory')),
    `${label}: selected Add directory row`,
  )
  await client.press('Enter')
  await waitForFrame(
    client,
    frame => frame.includes('Host directory:') && frame.includes(hostHome),
    `${label}: inline Host editor prefill`,
  )
  await client.type(dirName)
  await waitForFrame(client, frame => frame.includes(`> ${dirName}/`), `${label}: Host directory candidate`)
  await client.press('Tab')
  await waitForFrame(client, frame => frame.includes(`${dirName}/`), `${label}: accepted Host directory path`)
  await client.press('Enter')
  await waitForFrame(client, frame => frame.includes('Directory added:'), `${label}: registered Host directory`)
  await client.press('Escape')
  await waitForFrame(client, frame => !frame.includes('Sessions ·'), `${label}: closed Browser`)
  await waitForConfirmedDirectory(client, canonicalDir, `${label}: Welcome confirmed Host directory`)
}

/**
 * Drive one real `!`/`!!` completion and return the measured latency from Tab
 * to visible offer so negative absence windows are anchored to real timings.
 */
async function completeShellInput(
  client: SplitProcessClient,
  mode: '!' | '!!',
  body: string,
  expected: string,
  forbidden: readonly string[],
  label: string,
): Promise<number> {
  await waitForEmptyMode(client, 'prompt', `${label}: empty prompt`)
  await client.type(mode)
  await waitForEmptyMode(client, mode, `${label}: painted ${mode} mode`)
  await client.type(body)
  await waitForFrame(client, frame => splitFrame(frame).composer.includes(body), `${label}: painted draft body`)

  const before = splitFrame(await client.text())
  expect(before.composer, `${label}: candidate already in composer before Tab`).not.toContain(expected)
  expect(before.below, `${label}: candidate already below composer before Tab`).not.toContain(expected)

  const tabStartedAt = Date.now()
  await client.press('Tab')

  let offered: 'applied' | 'menu' | undefined
  let offeredFrame = { composer: '', below: '' }
  const deadline = tabStartedAt + 30_000
  while (Date.now() < deadline) {
    const parts = splitFrame(await client.text())
    if (parts.composer.includes(expected)) {
      offered = 'applied'
      offeredFrame = parts
      break
    }
    if (parts.below.includes(expected)) {
      offered = 'menu'
      offeredFrame = parts
      break
    }
    await sleep(50)
  }
  expect(offered, `${label}: Tab did not produce ${expected}`).toBeDefined()
  const latencyMs = Date.now() - tabStartedAt

  for (const blocked of forbidden) {
    expect(offeredFrame.composer, `${label}: forbidden ${blocked} in composer`).not.toContain(blocked)
    expect(offeredFrame.below, `${label}: forbidden ${blocked} in completion menu`).not.toContain(blocked)
  }

  if (offered === 'menu') {
    const draftBeforeAccept = offeredFrame.composer
    await client.press('Tab')
    await waitForFrame(client, frame => {
      const parts = splitFrame(frame)
      return parts.composer !== draftBeforeAccept && !parts.below.includes(expected)
    }, `${label}: dropdown Tab acceptance`, 30_000)
    const afterAccept = splitFrame(await client.text())
    for (const blocked of forbidden) {
      expect(afterAccept.composer, `${label}: accepted draft leaked ${blocked}`).not.toContain(blocked)
    }
  }

  await client.press('Ctrl+U')
  await waitForEmptyMode(client, mode, `${label}: cleared shell draft`)
  await client.press('Escape')
  await waitForEmptyMode(client, 'prompt', `${label}: returned to prompt mode`)
  return latencyMs
}

test('completes sessionless shell inputs from the selected Host Workspace without Client fallback', async () => {
  const scene = await createSplitProcessScene()
  let betaDir: string | undefined
  let betaModeRestricted = false
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const alphaName = 'workspace-alpha'
    const betaName = 'workspace-beta'
    const alphaDir = join(canonicalHostHome, alphaName)
    betaDir = join(canonicalHostHome, betaName)
    mkdirSync(alphaDir, { recursive: true, mode: 0o700 })
    mkdirSync(betaDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(alphaDir, ALPHA_FILE), 'alpha\n', { mode: 0o600 })
    writeFileSync(join(betaDir, BETA_FILE), 'beta\n', { mode: 0o600 })
    const canonicalAlpha = realpathSync(alphaDir)
    const canonicalBeta = realpathSync(betaDir)

    const clientDirs = (name: string): { home: string; cwd: string; canonicalCwd: string } => {
      const home = join(scene.workDir, `${name}-home`)
      const cwd = join(scene.workDir, `${name}-cwd`)
      mkdirSync(home, { recursive: true, mode: 0o700 })
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
      writeFileSync(join(cwd, CLIENT_FILE), 'client-twin\n', { mode: 0o600 })
      return { home, cwd, canonicalCwd: realpathSync(cwd) }
    }
    const dirA = clientDirs('shell-client-a')
    const dirB = clientDirs('shell-client-b')
    const dirC = clientDirs('shell-client-c')
    expect(dirA.canonicalCwd).not.toBe(canonicalAlpha)
    expect(dirB.canonicalCwd).not.toBe(canonicalBeta)

    const host = await scene.startHost({ shellCompletionLocality: true })
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const clientA = await scene.startClient({ label: 'shell-client-a', cwd: dirA.cwd, home: dirA.home })
    const clientB = await scene.startClient({ label: 'shell-client-b', cwd: dirB.cwd, home: dirB.home })
    const clientC = await scene.startClient({
      label: 'shell-client-c',
      cwd: dirC.cwd,
      home: dirC.home,
      invalidWorkspacePath: true,
    })

    for (const client of [clientA, clientB, clientC]) {
      expect(client.ready.transport).toBe('connected')
      expect(client.ready.surfaceMounted).toBe(true)
      expect(client.ready.sessionOpen).toBe(false)
      expect(client.ready.hostPid).toBe(hostPid)
      expect(client.ready.instanceId).toBe(hostInstanceId)
    }
    expect(new Set([clientA.ready.businessPid, clientB.ready.businessPid, clientC.ready.businessPid]).size).toBe(3)

    // Initial mount settles on each Client's own launch directory (not alpha/beta),
    // while Client C stays refused/unselected.
    await waitForConfirmedDirectory(clientA, dirA.canonicalCwd, 'client A initial auto-confirmed directory')
    await waitForConfirmedDirectory(clientB, dirB.canonicalCwd, 'client B initial auto-confirmed directory')
    await waitForFrame(clientC, frame => frame.includes('Host directory unavailable'), 'client C refused Workspace proposal')

    // Explicitly select Host alpha on A and Host beta on B via `/sessions` -> `Add directory`
    await selectHostWorkspace(clientA, canonicalHostHome, alphaName, canonicalAlpha, 'client A select alpha')
    await selectHostWorkspace(clientB, canonicalHostHome, betaName, canonicalBeta, 'client B select beta')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()

    // 1. Client A on alpha: Host command, Host env var, git subcommand, `!` and `!!` workspace paths
    const latencies: number[] = []
    latencies.push(await completeShellInput(
      clientA, '!', 'workspace-command-', HOST_COMMAND, [CLIENT_COMMAND], 'client A Host-only command',
    ))
    latencies.push(await completeShellInput(
      clientA, '!', 'echo $WORKSPACE_COMPLETION_', `$${HOST_VAR}`, [`$${CLIENT_VAR}`], 'client A Host-only variable',
    ))
    latencies.push(await completeShellInput(
      clientA, '!', 'git che', 'checkout', [CLIENT_VAR, CLIENT_COMMAND], 'client A git subcommand',
    ))
    latencies.push(await completeShellInput(
      clientA, '!', 'cat workspace-path-', ALPHA_FILE, [BETA_FILE, CLIENT_FILE], 'client A ! alpha path',
    ))
    latencies.push(await completeShellInput(
      clientA, '!!', 'cat workspace-path-', ALPHA_FILE, [BETA_FILE, CLIENT_FILE], 'client A !! alpha path',
    ))

    // 2. Client B on beta sees only beta; Client A switches alpha -> beta -> alpha
    latencies.push(await completeShellInput(
      clientB, '!', 'cat workspace-path-', BETA_FILE, [ALPHA_FILE, CLIENT_FILE], 'client B ! beta path',
    ))

    await selectHostWorkspace(clientA, canonicalHostHome, betaName, canonicalBeta, 'client A switch to beta')
    latencies.push(await completeShellInput(
      clientA, '!', 'cat workspace-path-', BETA_FILE, [ALPHA_FILE, CLIENT_FILE], 'client A after switch to beta',
    ))
    await selectHostWorkspace(clientA, canonicalHostHome, alphaName, canonicalAlpha, 'client A switch back to alpha')
    latencies.push(await completeShellInput(
      clientA, '!', 'cat workspace-path-', ALPHA_FILE, [BETA_FILE, CLIENT_FILE], 'client A after switch back to alpha',
    ))

    // Bounded negative window: covers the Host subprocess completion bound (2000ms)
    // plus measured end-to-end PTY completion latency on this run.
    const negativeWindowMs = Math.max(2_500, Math.max(...latencies) * 3)

    // 3. Unreadable Host Workspace negative on Client B (non-root uid required)
    expect(process.getuid?.(), 'unreadable directory negative requires a non-root uid').not.toBe(0)
    chmodSync(betaDir, 0o000)
    betaModeRestricted = true
    let accessDenied = false
    try {
      accessSync(betaDir, constants.R_OK | constants.X_OK)
    } catch {
      accessDenied = true
    }
    expect(accessDenied, 'chmod(000) must deny R_OK|X_OK for the current non-root uid').toBe(true)

    await waitForEmptyMode(clientB, 'prompt', 'client B prompt before unreadable negative')
    await clientB.type('!')
    await waitForEmptyMode(clientB, '!', 'client B shell mode before unreadable negative')
    await clientB.type('cat workspace-path-')
    await waitForFrame(clientB, frame => splitFrame(frame).composer.includes('cat workspace-path-'), 'client B unreadable draft')
    await clientB.press('Tab')
    // Wait for the bounded observation window anchored to Host completion latency.
    await sleep(negativeWindowMs)
    const unreadableParts = splitFrame(await clientB.text())
    expect(unreadableParts.composer).toContain('cat workspace-path-')
    expect(unreadableParts.composer).not.toContain(BETA_FILE)
    expect(unreadableParts.composer).not.toContain(CLIENT_FILE)
    expect(unreadableParts.below).not.toContain(BETA_FILE)
    expect(unreadableParts.below).not.toContain(CLIENT_FILE)
    await clientB.press('Ctrl+U')
    await waitForEmptyMode(clientB, '!', 'client B clear unreadable draft')
    await clientB.press('Escape')
    await waitForEmptyMode(clientB, 'prompt', 'client B return to prompt after unreadable negative')

    chmodSync(betaDir, 0o700)
    betaModeRestricted = false
    await completeShellInput(
      clientB, '!', 'cat workspace-path-', BETA_FILE, [ALPHA_FILE, CLIENT_FILE], 'client B restored beta path',
    )

    // 4. Refused/unselected Client C negative: no Host or Client candidate
    await waitForModeRow(clientC, '❯', 'client C prompt row')
    await clientC.type('!')
    await waitForModeRow(clientC, '!', 'client C shell mode row')
    await clientC.type('workspace-command-')
    await waitForFrame(clientC, frame => splitFrame(frame).composer.includes('workspace-command-'), 'client C refused draft')
    await clientC.press('Tab')
    // Wait for the bounded observation window anchored to Host completion latency.
    await sleep(negativeWindowMs)
    const refusedParts = splitFrame(await clientC.text())
    expect(refusedParts.composer).toContain('workspace-command-')
    expect(refusedParts.composer).not.toContain(HOST_COMMAND)
    expect(refusedParts.composer).not.toContain(CLIENT_COMMAND)
    expect(refusedParts.below).not.toContain(HOST_COMMAND)
    expect(refusedParts.below).not.toContain(CLIENT_COMMAND)
    await clientC.press('Ctrl+C')
    await waitForModeRow(clientC, '❯', 'client C cleared back to prompt')

    // 5. Zero Sessions created across the whole run; same Host identity survives
    for (const client of [clientA, clientB, clientC]) {
      const opened = client.readRecords()
        .filter(record => record?.m4b2s === 'surface-status')
        .some(record => record.sessionOpen === true)
      expect(opened, `${client.label} must remain sessionless`).toBe(false)
    }
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)

    await clientC.exitGracefully()
    await clientB.exitGracefully()
    await clientA.exitGracefully()
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost?.hostPid).toBe(hostPid)
    expect(hostAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    if (betaModeRestricted && betaDir !== undefined) {
      try {
        chmodSync(betaDir, 0o700)
      } catch (chmodError) {
        cleanupErrors.push(chmodError instanceof Error ? chmodError : new Error(String(chmodError)))
      }
    }
    try {
      await scene.dispose()
    } catch (disposeError) {
      cleanupErrors.push(disposeError instanceof Error ? disposeError : new Error(String(disposeError)))
    }
    if (cleanupErrors.length > 0) {
      if (primary !== undefined) {
        throw new AggregateError([primary, ...cleanupErrors], 'shell-completion failed and cleanup also failed')
      }
      throw new AggregateError(cleanupErrors, 'shell-completion passed but cleanup failed')
    }
  }
})
