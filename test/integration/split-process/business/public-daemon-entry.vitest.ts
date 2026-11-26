/**
 * Split-process public-entry business anchor.
 *
 * The ONLY evidence here is the REAL installed `dsh --profile …` CLI under a
 * native PTY, the product's own foreground Client, the detached public Host it
 * authenticates, the durable Session records and the public daemon management
 * commands. Nothing pre-starts a Host, injects an internal Client role or
 * reaches a private record sink: a public Client legitimately has none.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

async function frameText(launch: PublicDaemonLaunch): Promise<string> {
  return await launch.text()
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function waitForFrame(
  launch: PublicDaemonLaunch,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await frameText(launch).catch(() => '')
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForFrameMatch(
  launch: PublicDaemonLaunch,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await frameText(launch).catch(() => '')
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never matched; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function exitPublicLaunch(
  launch: PublicDaemonLaunch,
  label: string,
): Promise<{ code: number | null; signal: string | null; text: string }> {
  await launch.submit('/exit')
  const started = Date.now()
  let exit: { code: number | null; signal: string | null; text: string }
  for (;;) {
    const state = await launch.state()
    if (state.exited) {
      exit = await launch.waitForExit(5_000)
      break
    }
    const frame = await launch.text()
    if (frame.includes('Keep working and disconnect')) {
      await launch.press('Enter')
    }
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: /exit did not reach a terminal fact; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(100)
  }
  expect(exit.code, `${label}: the public CLI exit code`).toBe(0)
  expect(exit.signal, `${label}: the public CLI exit signal`).toBe(null)
  if (launch.client !== null) {
    expect(exit.text, `${label}: the daemon detach line`).toContain('Disconnected from dsh-pi-tui (daemon client).')
  }
  await launch.close()
  return exit
}

test('starts one real public daemon Client and Host from the installed CLI', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    launch = await scene.startPublicDaemon({
      label: 'cold',
      backend: 'daemon',
      cols: 140,
      rows: 40,
      loaderDump: true,
    })
    expect(launch.ready, 'the public daemon launch reached a usable surface').toBe(true)
    expect(launch.refused).toBe(false)
    expect(launch.cli, 'the real public CLI identity').not.toBeNull()
    expect(launch.client, 'the real foreground Client identity').not.toBeNull()
    expect(launch.host, 'the detached public Host identity').not.toBeNull()
    await waitForFrame(launch, '❯', 'public daemon composer')
    await scene.publicDaemonParallelReady(launch)
    await scene.publicDaemonParallelRelease()

    const rows = launch.loaderRows
    expect(rows, 'the parent daemon Loader dump').not.toBeNull()
    const byId = new Map((rows ?? []).map(row => [row.id, row]))
    const rowOf = (id: string) => byId.get(`include:${id}`) ?? byId.get(id)
    for (const id of [
      'session', 'session-persistence-jsonl', 'storage-json', 'jobs', 'typert-gateway',
      'remote-access', 'deepseek-account', 'authorization', 'credentials', 'workspace',
      'job-controller', 'webserver', 'pi-tui-extension-host', 'pi-tui-builtins',
      'pi-tui-performance-host', 'workspace-files', 'tui-app', 'workspace-controller',
      'directory-picker', 'pi-tui-schedule', 'pi-tui-direct-connection',
      'pi-tui-direct-file-upload', 'pi-tui-direct-session-controller',
    ]) {
      const row = rowOf(id)
      expect(row, `the real parent Loader row ${id} (actual ids: ${[...byId.keys()].join(',')})`).toBeDefined()
      expect(row?.disabled, `the second Host authority row ${id} is disabled`).toBe(true)
    }
    for (const id of ['timer', 'llm', 'tools']) {
      const row = rowOf(id)
      if (row !== undefined) expect(row.disabled, `the stateless Loader row ${id} is not disabled`).not.toBe(true)
    }
    expect(new Set(rows?.map(row => row.id)).size, 'the Loader dump has unique row ids').toBe(rows?.length)

    const status = await launch.daemonStatus()
    expect(status.exit.code, 'public daemon status exit code').toBe(0)
    expect(status.exit.signal).toBe(null)
    expect(status.fields.host, `public daemon status host (${JSON.stringify(status.fields)})`).toBe('ready')
    expect(status.fields.manager).toBe('process')
    expect(status.fields.unit).toBe('none')
    expect(status.fields['unit-state']).toBe('not-found')
    expect(status.fields.compatibility).toBe('compatible')
    expect(status.fields['user-manager'], `public daemon user-manager (${JSON.stringify(status.fields)})`).toBe('not-checked')
    expect(launch.host?.schema, 'the real published Host identity schema').toBe(process.platform === 'darwin' ? 2 : 1)
    expect(launch.hostAttempt, 'the launch projected its real Host attempt').not.toBeNull()
    expect(launch.hostAttempt?.winner).toBe(true)
    expect(launch.hostAttempt?.published).toBe(true)

    const before = new Set(await scene.sessionIds())
    await launch.submit('public cold start')
    const sessionId = await scene.waitForNewSessionId(before, 'public cold Session')
    const header = await scene.waitForHostSessionHeader(sessionId, 'public cold Session header')
    expect(header.type, 'the durable Session header').toBe('session')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('public cold start'),
      'public cold user prompt')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'public cold assistant answer')
    await waitForFrame(launch, 'stub answer', 'public cold painted answer')

    const beforeExitHost = await launch.kernelState()
    await exitPublicLaunch(launch, 'public cold launch')
    const afterExitHost = await launch.kernelState()
    expect(afterExitHost.hostPid, 'the same Host PID survives the Client /exit').toBe(beforeExitHost.hostPid)
    expect(afterExitHost.hostState, 'the captured Host kernel identity survives the Client /exit').toBe('alive')
    const stillRunning = await launch.daemonStatus()
    expect(stillRunning.fields.host, 'the Host survives the Client /exit').toBe('ready')

    await launch.stopHost()
    const stopped = await launch.daemonStatus()
    expect(stopped.fields.host, `public daemon host after stop (${JSON.stringify(stopped.fields)})`).toBe('stopped')
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    if (launch !== undefined) {
      try {
        if (!launch.closed) await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the public daemon business test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public daemon business test cleanup failed')
    }
  }
})

test('two cold public daemon launches converge on one authenticated Host', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const pair = await scene.startPublicDaemonColdPair({
      launches: [{ label: 'cold-pair-a', backend: 'daemon', cols: 140, rows: 40 }, { label: 'cold-pair-b', backend: 'daemon', cols: 120, rows: 36 }],
    })
    launches.push(...pair.launches)
    expect(pair.winner.published, 'the resolved winner is published').toBe(true)
    expect(pair.winner.winner, 'the resolved Host is the unique winner').toBe(true)
    expect(pair.winner.instanceId, 'the winner is authenticated with an instance').toBeTruthy()
    for (const launch of pair.launches) {
      expect(launch.ready, `${launch.label}: reached a real usable surface`).toBe(true)
      expect(launch.refused).toBe(false)
      expect(launch.host?.pid, `${launch.label}: shares the published winner`).toBe(pair.winner.pid)
      expect(launch.host?.birth).toBe(pair.winner.birth)
      expect(launch.host?.instanceId).toBe(pair.winner.instanceId)
      expect(launch.hostAttempt, `${launch.label}: captured a real Host attempt`).not.toBeNull()
      expect(launch.hostAttempt?.attemptByLaunchId).toBe(launch.launchId)
      expect(launch.registryAbsentBefore, `${launch.label}: strict registry ENOENT before its live attempt capture`).toBe(true)
      expect(launch.registryAbsentAfter, `${launch.label}: strict registry ENOENT after its live attempt capture`).toBe(true)
      await waitForFrame(launch, '❯', `${launch.label} composer`)
    }
    const attempts = pair.launches.map(launch => launch.hostAttempt)
    const attemptKeys = attempts.map(attempt => `${String(attempt?.pid)}:${String(attempt?.birth)}`)
    expect(new Set(attemptKeys).size, `two distinct real Host attempts (${JSON.stringify(attemptKeys)})`).toBe(2)
    const cttyDevices = pair.launches.map(launch => launch.shellTty?.platform === 'darwin'
      ? launch.shellTty.eTdev
      : launch.shellTty?.ttyNr)
    expect(new Set(cttyDevices).size, `two distinct controlling-terminal devices (${JSON.stringify(cttyDevices)})`).toBe(2)
    expect(cttyDevices.every(device => typeof device === 'number' && device > 0 && device !== 0xffffffff)).toBe(true)
    expect(attempts.filter(attempt => attempt?.winner === true)).toHaveLength(1)
    const contender = attempts.find(attempt => attempt?.winner !== true)
    expect(contender, 'one real contender attempt').toBeDefined()
    expect(contender?.published).toBe(false)
    expect(contender?.settled, 'the unpublished contender settled naturally').toBe(true)
    expect(contender?.terminalOutcome).toBe('candidate-exited')

    await pair.launches[0].type('pair-a')
    await waitForFrame(pair.launches[0], 'pair-a', 'pair A input')
    await pair.launches[0].press('Ctrl+U')
    await pair.launches[1].type('pair-b')
    await waitForFrame(pair.launches[1], 'pair-b', 'pair B input')
    await pair.launches[1].press('Ctrl+U')

    const hostPid = pair.winner.pid
    const hostBirth = pair.winner.birth
    await exitPublicLaunch(pair.launches[0], 'cold pair launch A')
    const survivor = await pair.launches[1].kernelState()
    expect(survivor.hostPid, 'the surviving Client keeps the same Host').toBe(hostPid)
    expect(survivor.hostState, 'the Host survives the first Client exit').toBe('alive')
    expect(survivor.clientState, 'the second Client stays live').toBe('alive')
    await pair.launches[1].type('pair-b-after-a')
    await waitForFrame(pair.launches[1], 'pair-b-after-a', 'pair B remains usable after A exits')
    await pair.launches[1].press('Ctrl+U')

    const before = new Set(await scene.sessionIds())
    await pair.launches[1].submit('cold pair convergence')
    const sessionId = await scene.waitForNewSessionId(before, 'cold pair Session')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'cold pair answer')
    expect([...(await scene.sessionIds())].sort(), 'the pair created exactly one Session')
      .toEqual([...before, sessionId].sort())
    await exitPublicLaunch(pair.launches[1], 'cold pair launch B')
    const after = await pair.launches[1].kernelState()
    expect(after.hostPid).toBe(hostPid)
    expect(after.hostState, 'the Host survives the last Client exit').toBe('alive')
    expect(after.hostInstanceId).toBe(pair.winner.instanceId)
    const status = await pair.launches[1].daemonStatus()
    expect(status.fields.host, `the Host stays ready before the one stop (${JSON.stringify(status.fields)})`).toBe('ready')
    const stopped = await pair.launches[1].stopHost()
    expect(stopped.reclaimed).toBe(true)
    expect(stopped.normalStop).toBe(true)
    expect(stopped.birth).toBe(hostBirth)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the cold-pair test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the cold-pair test cleanup failed')
    }
  }
})

test.skipIf(process.env.SPLIT_VITEST_PUBLIC_AUTHORITY_CONTROL !== '1')(
  'rejects unproven native public process observations',
  async () => {
    const scene = await createSplitProcessScene()
    try {
      const facts = await scene.runPublicAuthorityControl()
      expect(facts.platform).toBe(process.platform)
      expect(facts.negative.wrongBirth).toBe('birth-mismatch')
      expect(facts.negative.wrongEntry).toBe('canonical-entry-mismatch')
      expect(facts.negative.wrongHome).toBe('dsh-home-mismatch')
      expect(facts.negative.wrongProfile).toBe('split-process-profile-mismatch')
      expect(facts.negative.wrongAnchor).toBe('split-process-dsh-anchor-mismatch')
      expect(facts.negative.wrongTty).toBe('tty-mismatch')
      expect(facts.negative.missingEnv).toBe('env-missing')
      expect(facts.negative.duplicateEnv).toBe('DUPLICATE_ENV_KEY')
      expect(facts.negative.malformedEnv).toBe('MALFORMED_ENV_ITEM')
      expect(facts.negative.goneChild).toBe('gone')
      expect(facts.negative.unknownRead).toMatch(/unknown/iu)
      expect(facts.registry.present).toBe('present')
      expect(facts.registry.absent).toBe('absent')
      expect(facts.registry.unknown).toBe('unknown')
      expect(facts.enumeration.after.count).toBeGreaterThan(facts.enumeration.before.count)
      expect(facts.signalAdmission.positive).toBe('passed')
      expect(facts.signalAdmission.wrongBirth).toMatch(/birth|replaced/iu)
      expect(facts.signalAdmission.gone).toMatch(/gone/iu)
      expect(facts.signalAdmission.signalsSent).toBe(0)
      expect(facts.cleanup.helpersTerminal).toBe(true)
      expect(facts.cleanup.terminationProblems).toEqual([])
      expect(facts.sentinel.after).toBe(facts.sentinel.birth)
      expect(facts.cleanup.sentinelGone).toBe(true)
      expect(facts.cleanup.leaked).toBe(0)
      expect(facts.cleanup.unknown).toBe(0)
      expect(facts.cleanup.unregistered).toEqual([])
      expect(facts.cleanup.closeErrors).toEqual([])
      if (process.platform === 'darwin') {
        expect(facts.probe.bsdBytes).toBe(136)
        expect(facts.probe.procargs.querySize).toBe(facts.probe.procargs.used)
        expect(facts.probe.procargs.used).toBeGreaterThan(0)
      }
    } finally {
      await scene.dispose()
    }
  },
)

const ownershipRefusalProbe = process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-ownership-refused'

test('keeps the default Direct launch independent of the split backend', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    // Cold default Direct must be proven with no existing split Host/Client.
    const sessionsAtStart = [...await scene.sessionIds()].sort()
    const coldScopeBefore = await scene.publicScopeState()
    expect(coldScopeBefore.registry).toBe('absent')
    expect(coldScopeBefore.launch).toBe('absent')
    expect(coldScopeBefore.hosts).toEqual([])
    const cold = await scene.startPublicDaemon({ label: 'direct-cold-default', cols: 120, rows: 36 })
    launches.push(cold)
    expect(cold.ready, 'the cold default Direct launch reached a usable surface').toBe(true)
    expect(cold.backend, 'the cold launch really followed the persisted default').toBeNull()
    expect(cold.host, 'a cold Direct launch owns no split Host').toBeNull()
    expect(cold.client, 'a cold Direct launch owns no split Client').toBeNull()
    expect(cold.hostAttempt, 'a cold Direct launch captured no Host attempt').toBeNull()
    const coldScopeDuring = await scene.publicScopeState()
    expect(coldScopeDuring.registry, 'a cold Direct launch published no split registry').toBe('absent')
    expect(coldScopeDuring.launch, 'a cold Direct launch published no split launch material').toBe('absent')
    expect(coldScopeDuring.hosts, 'a cold Direct launch owns no split Host').toEqual([])
    await waitForFrame(cold, '❯', 'the cold Direct composer')
    await cold.type('cold direct')
    await waitForFrame(cold, 'cold direct', 'the cold Direct composer accepts input')
    await cold.press('Ctrl+U')
    await cold.submit('/exit')
    const coldExit = await cold.waitForExit(60_000)
    expect(coldExit.code, 'the cold Direct CLI exit code').toBe(0)
    expect(coldExit.signal).toBe(null)
    await cold.close()
    const coldScopeAfter = await scene.publicScopeState()
    expect(coldScopeAfter.registry, 'the cold Direct exit left no split registry').toBe('absent')
    expect(coldScopeAfter.launch, 'the cold Direct exit left no split launch material').toBe('absent')
    expect(coldScopeAfter.hosts, 'the cold Direct exit left no split Host').toEqual([])
    expect([...(await scene.sessionIds())].sort(), 'the cold Direct launch created no Session').toEqual(sessionsAtStart)

    const peer = await scene.startPublicDaemon({ label: 'direct-warm-host', backend: 'daemon' })
    launches.push(peer)
    await waitForFrame(peer, '❯', 'the warm peer composer')
    expect(peer.host, 'the warm peer owns a real Host').not.toBeNull()
    expect(peer.client, 'the warm peer owns a real Client').not.toBeNull()
    const peerBefore = await peer.kernelState()
    expect(peerBefore.hostBirth).toMatch(/^(?:linux|darwin):/u)
    const instanceBefore = peer.host?.instanceId
    const registryBefore = fileDigest(join(scene.scopeDir, 'instance.json'))
    const launchBefore = fileDigest(join(scene.scopeDir, 'launch.json'))
    const sessionsBeforeWarmDirect = [...await scene.sessionIds()].sort()

    const launch = await scene.startPublicDaemon({ label: 'direct-warm-default', cols: 120, rows: 36 })
    launches.push(launch)
    expect(launch.ready, 'the warm default Direct launch reached a usable surface').toBe(true)
    expect(launch.backend, 'the warm launch really followed the persisted default, not an env selector').toBeNull()
    expect(launch.host, 'a Direct launch owns no split Host').toBeNull()
    expect(launch.client, 'a Direct launch owns no split Client').toBeNull()
    expect(launch.hostAttempt, 'a Direct launch captured no Host attempt').toBeNull()
    const peerDuring = await peer.kernelState()
    expect(peerDuring.hostPid, 'the warm Host was not replaced by the Direct launch').toBe(peerBefore.hostPid)
    expect(peerDuring.hostBirth, 'the warm Host birth was not replaced by the Direct launch').toBe(peerBefore.hostBirth)
    expect(peerDuring.hostInstanceId).toBe(instanceBefore)
    expect(peerDuring.clientState, 'the warm Client stays live during the Direct launch').toBe('alive')
    await launch.type('direct default')
    await waitForFrame(launch, 'direct default', 'default Direct composer accepts input')
    await launch.press('Ctrl+U')
    await launch.submit('/exit')
    const exit = await launch.waitForExit(60_000)
    expect(exit.code, 'the default Direct CLI exit code').toBe(0)
    expect(exit.signal).toBe(null)
    await launch.close()
    const warmDirectScope = await scene.publicScopeState()
    expect(warmDirectScope.registry, 'the warm Direct launch retained the sole registry').toBe('present')
    expect(warmDirectScope.launch, 'the warm Direct launch retained the sole launch').toBe('present')
    expect(warmDirectScope.hosts, 'the warm Direct close left exactly the established peer Host').toEqual([
      { pid: peerBefore.hostPid, birth: peerBefore.hostBirth },
    ])
    const peerAfter = await peer.kernelState()
    expect(peerAfter.hostPid, 'the Direct exit did not stop the warm Host').toBe(peerBefore.hostPid)
    expect(peerAfter.hostBirth, 'the Direct exit did not replace the warm Host birth').toBe(peerBefore.hostBirth)
    expect(peerAfter.hostState).toBe('alive')
    expect(fileDigest(join(scene.scopeDir, 'instance.json')), 'the Direct launch changed no split registry content').toBe(registryBefore)
    expect(fileDigest(join(scene.scopeDir, 'launch.json')), 'the Direct launch changed no split launch content').toBe(launchBefore)
    expect([...(await scene.sessionIds())].sort(), 'the warm Direct launch created no Session').toEqual(sessionsBeforeWarmDirect)
    expect(peerAfter.clientState, 'the warm peer is still usable after the Direct exit').toBe('alive')
    await peer.type('warm-peer-after-direct')
    await waitForFrame(peer, 'warm-peer-after-direct', 'the warm peer accepts input after the Direct exit')
    await peer.press('Ctrl+U')
    await exitPublicLaunch(peer, 'warm peer')
    await peer.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the default Direct test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the default Direct test cleanup failed')
    }
  }
})

test('refuses illegal public backend inputs before creating a split Host', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    for (const [label, backend] of [['refuse-wire-local', 'wire-local'], ['refuse-empty-env', '']] as const) {
      const before = await scene.sessionIds()
      launch = await scene.startPublicDaemon({ label, backend })
      launches.push(launch)
      expect(launch.refused, `${label}: the invalid backend was accepted`).toBe(true)
      expect(launch.exit, `${label}: the invalid backend produced a real exit`).not.toBeNull()
      expect(launch.exit?.signal, `${label}: the invalid backend must exit normally`).toBeNull()
      expect(typeof launch.exit?.code, `${label}: the invalid backend exit code type`).toBe('number')
      expect(launch.exit?.code, `${label}: the invalid backend exit code`).toBeGreaterThan(0)
      const refusalText = await launch.text({ full: true })
      expect(refusalText, `${label}: the actual backend diagnostic (${refusalText})`).toMatch(
        label === 'refuse-wire-local' ? /wire-local|invalid.*backend|backend.*invalid/iu : /DSH_PI_TUI_BACKEND|invalid|empty/iu,
      )
      expect(launch.host, `${label}: the invalid backend started a Host`).toBeNull()
      expect(launch.client, `${label}: the invalid backend started a Client`).toBeNull()
      expect(existsSync(join(scene.scopeDir, 'instance.json')),
        `${label}: the invalid backend published a Host registry`).toBe(false)
      expect(await scene.sessionIds(), `${label}: the invalid backend created a Session`).toEqual(before)
      await launch.close()
    }

    const sessionsBeforeHeadless = [...await scene.sessionIds()].sort()
    const headless = await scene.runPublicDaemonHeadless({ label: 'refuse-headless', backend: 'daemon' })
    expect(headless.exit.signal, 'the non-TTY daemon launch must exit normally').toBeNull()
    expect(typeof headless.exit.code, 'the non-TTY daemon launch exit code type').toBe('number')
    expect(headless.exit.code, 'the non-TTY daemon launch exit code').toBeGreaterThan(0)
    expect(headless.text, `the non-TTY daemon refusal text (${headless.text})`).toMatch(
      /not a (?:TTY|terminal)|non-interactive|requires (?:an? )?(?:TTY|terminal)|interactive terminal/iu,
    )
    const headlessScope = await scene.publicScopeState()
    expect(headlessScope.registry, 'the non-TTY daemon launch published no Host registry').toBe('absent')
    expect(headlessScope.launch, 'the non-TTY daemon launch published no launch material').toBe('absent')
    expect(headlessScope.hosts, 'the non-TTY daemon launch owned no Host').toEqual([])
    expect([...(await scene.sessionIds())].sort(), 'the non-TTY daemon launch created no Session').toEqual(sessionsBeforeHeadless)

    const beforeMutual = await scene.sessionIds()
    launch = await scene.startPublicDaemon({
      label: 'refuse-session-and-continue',
      backend: 'daemon',
      args: {
        session: 'session-00000000-0000-0000-0000-000000000000',
        continue: true,
      },
    })
    launches.push(launch)
    expect(launch.refused, '--session and -c together must be refused by the product').toBe(true)
    expect(launch.exit?.signal, 'the mutually exclusive launch must exit normally').toBeNull()
    expect(typeof launch.exit?.code, 'the mutually exclusive launch exit code type').toBe('number')
    expect(launch.exit?.code, 'the mutually exclusive launch exit code').toBeGreaterThan(0)
    const mutualText = await launch.text({ full: true })
    expect(mutualText, `the actual mutual-exclusion diagnostic (${mutualText})`).toMatch(
      /--session.*(?:-c|--continue)|(?:-c|--continue).*--session|mutually exclusive/iu,
    )
    expect(launch.host, 'the mutually exclusive launch started a Host').toBeNull()
    expect(existsSync(join(scene.scopeDir, 'instance.json')),
      'the mutually exclusive launch published a Host registry').toBe(false)
    expect(await scene.sessionIds(), 'the mutually exclusive launch created a Session').toEqual(beforeMutual)
    await launch.close()

    // Warm control: a real authenticated Host/Client is already live, so the
    // same true non-TTY daemon command must refuse without changing it.
    const peer = await scene.startPublicDaemon({ label: 'refuse-warm-host', backend: 'daemon' })
    launches.push(peer)
    await waitForFrame(peer, '❯', 'the warm refusal peer composer')
    const warmBefore = await peer.kernelState()
    expect(warmBefore.hostState).toBe('alive')
    expect(warmBefore.clientState).toBe('alive')
    const warmRegistry = fileDigest(join(scene.scopeDir, 'instance.json'))
    const warmLaunch = fileDigest(join(scene.scopeDir, 'launch.json'))
    const warmSessions = [...await scene.sessionIds()].sort()
    const warmHeadless = await scene.runPublicDaemonHeadless({ label: 'refuse-headless-warm', backend: 'daemon' })
    expect(warmHeadless.exit.signal, 'the warm non-TTY daemon launch must exit normally').toBeNull()
    expect(warmHeadless.exit.code, 'the warm non-TTY daemon launch exit code').toBeGreaterThan(0)
    expect(warmHeadless.text, `the warm non-TTY refusal text (${warmHeadless.text})`).toMatch(
      /not a (?:TTY|terminal)|non-interactive|requires (?:an? )?(?:TTY|terminal)|interactive terminal/iu,
    )
    const warmAfter = await peer.kernelState()
    expect(warmAfter.hostPid, 'the warm non-TTY refusal did not replace the Host').toBe(warmBefore.hostPid)
    expect(warmAfter.hostBirth, 'the warm non-TTY refusal did not replace the Host birth').toBe(warmBefore.hostBirth)
    const warmRefusalScope = await scene.publicScopeState()
    expect(warmRefusalScope.registry).toBe('present')
    expect(warmRefusalScope.launch).toBe('present')
    expect(warmRefusalScope.hosts, 'the warm non-TTY refusal left exactly the established peer Host').toEqual([
      { pid: warmBefore.hostPid, birth: warmBefore.hostBirth },
    ])
    expect(warmAfter.hostInstanceId).toBe(warmBefore.hostInstanceId)
    expect(warmAfter.clientPid, 'the warm non-TTY refusal did not replace the Client').toBe(warmBefore.clientPid)
    expect(warmAfter.hostState).toBe('alive')
    expect(warmAfter.clientState).toBe('alive')
    expect(fileDigest(join(scene.scopeDir, 'instance.json')), 'the warm non-TTY refusal changed no registry').toBe(warmRegistry)
    expect(fileDigest(join(scene.scopeDir, 'launch.json')), 'the warm non-TTY refusal changed no launch material').toBe(warmLaunch)
    expect([...(await scene.sessionIds())].sort(), 'the warm non-TTY refusal created no Session').toEqual(warmSessions)
    await peer.type('warm-refusal-peer')
    await waitForFrame(peer, 'warm-refusal-peer', 'the warm peer stays usable after the refusal')
    await peer.press('Ctrl+U')
    await exitPublicLaunch(peer, 'warm refusal peer')
    await peer.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const handle of [...launches].reverse()) {
      if (handle.closed) continue
      try {
        await handle.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the refusal test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the refusal test cleanup failed')
    }
  }
})

test('resumes a durable public Session through --session and -c without another Session', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const seed = await scene.startPublicDaemon({ label: 'session-seed', backend: 'daemon' })
    launches.push(seed)
    const seedHost = seed.host
    await waitForFrame(seed, '❯', 'public session seed composer')
    const before = new Set(await scene.sessionIds())
    await seed.submit('public session seed')
    const sessionId = await scene.waitForNewSessionId(before, 'public session seed')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'public session seed answer')
    const seedEvents = scene.sessionEvents(sessionId)?.length ?? 0
    expect(seedEvents, 'the seeded Session recorded its turn').toBeGreaterThan(0)
    await exitPublicLaunch(seed, 'public session seed launch')
    const expectedSessions = [...before, sessionId].sort()

    const full = await scene.startPublicDaemon({
      label: 'session-full-id',
      backend: 'daemon',
      args: { session: sessionId },
    })
    launches.push(full)
    await waitForFrame(full, 'public session seed', '--session full id history')
    expect(full.host?.instanceId, '--session full id reused the authenticated Host').toBe(seedHost?.instanceId)
    expect(full.host?.pid).toBe(seedHost?.pid)
    expect([...(await scene.sessionIds())].sort(), '--session full id created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(full, 'public session full id')

    const prefix = sessionId.slice(0, 'session-'.length + 8)
    const prefixed = await scene.startPublicDaemon({
      label: 'session-unique-prefix',
      backend: 'daemon',
      args: { session: prefix },
    })
    launches.push(prefixed)
    await waitForFrame(prefixed, 'public session seed', '--session unique prefix resumed the exact history')
    expect(prefixed.host?.instanceId, 'the unique prefix reused the authenticated Host').toBe(seedHost?.instanceId)
    expect(prefixed.host?.pid).toBe(seedHost?.pid)
    expect([...(await scene.sessionIds())].sort(), 'the unique prefix created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(prefixed, 'public session unique prefix')

    // A non-unique query really keeps the Session Browser open; Escape is the
    // product's real dismissal and must not resume a Session or create one.
    const browser = await scene.startPublicDaemon({
      label: 'session-browser',
      backend: 'daemon',
      args: { session: 'session-' },
      surface: 'workspace',
    })
    launches.push(browser)
    const browserFrame = await browser.text()
    expect(browserFrame, `the real Session Browser frame (${browserFrame})`).toContain('Sessions · 1')
    expect(browserFrame, `the real Session Browser workspace row (${browserFrame})`).toContain('pi-tui')
    // Real Escape dismissal, with no blind sleeps: each step waits for the
    // actual browser composer or the next advertised Back/Close layer.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await browser.text()
      await browser.press('Escape')
      let frame: string
      try {
        frame = await waitForFrameMatch(browser,
          value => value !== before
            && (value.includes('❯') || value.includes('Close [Esc]') || value.includes('Back [Esc]')),
          'the Session Browser processed Escape', 10_000)
      } catch {
        continue
      }
      if (frame.includes('❯') && !frame.includes('Close [Esc]')) break
    }
    await waitForFrame(browser, '❯', 'the Session Browser returned to a usable composer after Esc')
    expect([...(await scene.sessionIds())].sort(), 'the Session browser created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(browser, 'public session browser')

    // Separate browser path for the exact seeded target: a non-unique query
    // keeps the browser open; the first Enter focuses the exact result and the
    // second opens it. The chat frame names the full Session id/history.
    const browserTarget = await scene.startPublicDaemon({
      label: 'session-browser-target',
      backend: 'daemon',
      args: { session: 'session-' },
      surface: 'workspace',
    })
    launches.push(browserTarget)
    await waitForFrame(browserTarget, 'Workspace & dates', 'the Session Browser painted the workspace result')
    await browserTarget.press('Enter')
    await waitForFrame(browserTarget, 'Open [Enter]', 'the Session Browser selected the exact result')
    await browserTarget.press('Enter')
    await waitForFrame(browserTarget, prefix, 'the Session Browser opened the exact seeded target')
    await waitForFrame(browserTarget, 'public session seed', 'the Session Browser opened the exact target history')
    await waitForFrame(browserTarget, '❯', 'the Session Browser opened a usable composer')
    expect([...(await scene.sessionIds())].sort(), 'the exact target browser created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(browserTarget, 'public session browser target')

    const continued = await scene.startPublicDaemon({
      label: 'session-continue',
      backend: 'daemon',
      args: { continue: true },
    })
    launches.push(continued)
    await waitForFrame(continued, 'public session seed', '-c resumed the same workspace history')
    expect(continued.host?.instanceId, '-c reused the authenticated Host').toBe(seedHost?.instanceId)
    expect(continued.host?.pid).toBe(seedHost?.pid)
    expect([...(await scene.sessionIds())].sort(), '-c created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(continued, 'public session continue')
    await continued.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the public Session test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public Session test cleanup failed')
    }
  }
})

test('applies --preset minimal to the first public Session header', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const minimal = await scene.startPublicDaemon({
      label: 'preset-minimal',
      backend: 'daemon',
      args: { preset: 'minimal' },
    })
    launches.push(minimal)
    await waitForFrame(minimal, '❯', 'minimal preset composer')
    const beforeMinimal = new Set(await scene.sessionIds())
    await minimal.submit('minimal preset prompt')
    const minimalSession = await scene.waitForNewSessionId(beforeMinimal, 'minimal preset Session')
    const minimalHeader = await scene.waitForHostSessionHeader(minimalSession, 'minimal preset header')
    const minimalHeaderText = JSON.stringify(minimalHeader)
    expect(minimalHeaderText, `the durable minimal header (${minimalHeaderText})`).toContain('"agentPreset":"minimal"')
    await scene.waitForSessionEvent(minimalSession, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'minimal preset answer')
    expect([...(await scene.sessionIds())].sort(), 'the minimal launch created exactly one Session')
      .toEqual([...beforeMinimal, minimalSession].sort())
    await exitPublicLaunch(minimal, 'minimal preset launch')

    const standard = await scene.startPublicDaemon({ label: 'preset-default', backend: 'daemon' })
    launches.push(standard)
    await waitForFrame(standard, '❯', 'default preset composer')
    const beforeStandard = new Set(await scene.sessionIds())
    await standard.submit('default preset prompt')
    const standardSession = await scene.waitForNewSessionId(beforeStandard, 'default preset Session')
    const standardHeader = await scene.waitForHostSessionHeader(standardSession, 'default preset header')
    const standardHeaderText = JSON.stringify(standardHeader)
    expect(standardHeaderText, `the durable default header (${standardHeaderText})`).toContain('"agentPreset":"standard"')
    await scene.waitForSessionEvent(standardSession, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'default preset answer')
    expect([...(await scene.sessionIds())].sort(), 'the default launch created exactly one Session')
      .toEqual([...beforeStandard, standardSession].sort())
    await exitPublicLaunch(standard, 'default preset launch')
    await standard.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the preset test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the preset test cleanup failed')
    }
  }
})

test('keeps the surviving public peer and its Session after the other Client leaves', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const first = await scene.startPublicDaemon({ label: 'peer-first', backend: 'daemon' })
    launches.push(first)
    await waitForFrame(first, '❯', 'first peer composer')
    const before = new Set(await scene.sessionIds())
    await first.submit('peer session seed')
    const sessionId = await scene.waitForNewSessionId(before, 'peer Session')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'peer seed answer')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 'peer seed turn end')
    const seededEvents = scene.sessionEvents(sessionId) ?? []
    const seededTurns = seededEvents
      .filter(event => event.type === 'turn/end')
      .map(event => Number(event.data?.turn))
      .filter(Number.isInteger)
    const lastTurn = seededTurns.length === 0 ? 1 : Math.max(...seededTurns)
    const expectedSessions = [...before, sessionId].sort()

    const second = await scene.startPublicDaemon({
      label: 'peer-second',
      backend: 'daemon',
      args: { session: sessionId },
    })
    launches.push(second)
    await waitForFrame(second, 'peer session seed', 'the second peer opened the same Session')
    expect(second.host?.instanceId, 'both public Clients authenticate one Host').toBe(first.host?.instanceId)
    expect(second.host?.pid).toBe(first.host?.pid)
    expect((await second.kernelState()).hostState, 'the shared Host is live').toBe('alive')

    const term = await first.signalCli()
    // The Supervisor owns the strict order oracle: it samples the real kernel
    // identities immediately after TERM and refuses a same-sample or CLI-first
    // outcome itself. The Worker only consumes the recorded outcome.
    expect(term.outcome.clientTerminalWhileCliLive,
      `the real Client must be terminal while the exact CLI birth is live: ${JSON.stringify(term.outcome)}`).toBe(true)
    expect(term.outcome.order).toBe('client-terminal-while-cli-live')
    expect(term.outcome.sameSampleGone).toBe(false)
    expect(term.outcome.cliLiveBirthAtClientTerminal).toBe(first.cli?.birth)
    expect(term.outcome.clientGoneAt, 'a real Client terminal timestamp').not.toBeNull()
    expect(term.outcome.cliGoneAt, 'a real CLI terminal timestamp').not.toBeNull()
    const afterTerm = await first.kernelState()
    expect(['gone', 'reused']).toContain(afterTerm.cliState)
    expect(['gone', 'reused']).toContain(afterTerm.clientState)
    const surviving = await second.kernelState()
    expect(surviving.hostState, 'the Host survives the peer CLI TERM').toBe('alive')
    expect(surviving.clientState, 'the surviving Client stays live').toBe('alive')
    expect(surviving.hostInstanceId).toBe(first.host?.instanceId)
    await first.reclaim()
    await waitForFrame(second, 'peer session seed', 'the surviving peer keeps the Session history')

    const eventBoundary = (scene.sessionEvents(sessionId) ?? []).length
    await second.submit('peer survives the detach')
    await scene.waitForSessionEvent(sessionId, eventBoundary,
      event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('peer survives the detach'),
      'the surviving peer committed exactly one user prompt')
    await scene.waitForSessionEvent(sessionId, eventBoundary,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'the surviving peer completed the new Turn')
    await scene.waitForSessionEvent(sessionId, eventBoundary,
      event => event.type === 'turn/end' && event.data?.turn === lastTurn + 1,
      'the surviving peer settled the next Turn')
    await waitForFrame(second, 'peer survives the detach', 'the surviving peer painted the new prompt')
    await waitForFrameMatch(second, frame => {
      const promptAt = frame.lastIndexOf('peer survives the detach')
      const answerAt = frame.lastIndexOf('stub answer')
      return promptAt >= 0 && answerAt > promptAt
    }, 'the surviving peer painted the new answer below the new prompt')

    const newEvents = (scene.sessionEvents(sessionId) ?? []).slice(eventBoundary)
    expect(newEvents.filter(event => event.type === 'user/message'
      && JSON.stringify(event.data ?? {}).includes('peer survives the detach')),
    'the new prompt is committed exactly once').toHaveLength(1)
    expect(newEvents.filter(event => event.type === 'turn/start' && event.data?.turn === lastTurn + 1),
      'the new Turn starts exactly once').toHaveLength(1)
    expect(newEvents.filter(event => event.type === 'turn/end' && event.data?.turn === lastTurn + 1),
      'the new Turn ends exactly once').toHaveLength(1)
    expect([...(await scene.sessionIds())].sort(), 'the peer turn created no other Session').toEqual(expectedSessions)

    await exitPublicLaunch(second, 'surviving peer')
    await second.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the public peer test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public peer test cleanup failed')
    }
  }
})

test('pins the public alias resume command and replays it against the live Host', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  const alias = 'public-alias'
  let testError: unknown
  try {
    const owner = await scene.startPublicDaemon({
      label: 'alias-owner',
      backend: 'daemon',
      alias,
      herdr: true,
    })
    launches.push(owner)
    await waitForFrame(owner, '❯', 'alias owner composer')
    const before = new Set(await scene.sessionIds())
    await owner.submit('alias resume seed')
    const sessionId = await scene.waitForNewSessionId(before, 'alias Session')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'alias seed answer')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 'alias seed turn end')

    let invocations = owner.readHerdrInvocations()
    const herdStarted = Date.now()
    while (!invocations.some(invocation => invocation.argv[1] === 'report-agent-session')
      && Date.now() - herdStarted < 60_000) {
      await sleep(100)
      invocations = owner.readHerdrInvocations()
    }
    expect(invocations.length, `the controlled Herdr fake received invocations: ${JSON.stringify(invocations)}`).toBeGreaterThan(0)
    for (const invocation of invocations) {
      expect(invocation.ppid, 'the Herdr reporter runs inside the real public Client').toBe(owner.client?.pid)
      expect(invocation.argv[0]).toBe('pane')
      expect(['report-agent', 'report-agent-session', 'release-agent']).toContain(invocation.argv[1])
      expect(invocation.argv[2]).toBe(owner.herdr?.paneId)
      const sourceAt = invocation.argv.indexOf('--source')
      const agentAt = invocation.argv.indexOf('--agent')
      expect(invocation.argv[sourceAt + 1]).toBe('dsh-pi-tui')
      expect(invocation.argv[agentAt + 1]).toBe('dsh-pi-tui')
    }
    const seqs = invocations.map((invocation) => Number(invocation.argv[invocation.argv.indexOf('--seq') + 1]))
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index], 'Herdr seq is strictly increasing').toBeGreaterThan(seqs[index - 1] as number)
    }
    const stateIndex = invocations.findIndex(invocation => invocation.argv[1] === 'report-agent')
    const sessionIndex = invocations.findIndex(invocation => invocation.argv[1] === 'report-agent-session')
    expect(stateIndex, 'a real state report was sent').toBeGreaterThanOrEqual(0)
    expect(sessionIndex, 'a real Session report was sent').toBeGreaterThan(stateIndex)
    const sessionArgs = invocations[sessionIndex]!.argv
    expect(sessionArgs[sessionArgs.indexOf('--agent-session-id') + 1]).toBe(sessionId)
    const resumeAt = sessionArgs.indexOf('--')
    expect(resumeAt).toBeGreaterThan(0)
    const capturedResume = sessionArgs.slice(resumeAt + 1)
    expect(capturedResume).toEqual([
      'env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', alias, '--session', sessionId,
    ])

    // Replay the captured reporter argv while the ORIGINAL reporting Client is
    // still live. The owner may only exit after that replay has completed, so
    // the detach text is read from the same Client that produced the argv.
    const replay = await scene.startPublicDaemon({
      label: 'alias-resume-replay',
      alias,
      replayCommand: capturedResume,
    })
    launches.push(replay)
    await waitForFrame(replay, 'alias resume seed', 'the replayed resume command opened the exact history')
    expect(replay.host?.instanceId).toBe(owner.host?.instanceId)
    expect((await owner.kernelState()).clientState, 'the original reporter Client is live during replay').toBe('alive')
    await exitPublicLaunch(replay, 'alias replay')
    expect((await owner.kernelState()).clientState, 'the original reporter Client stays live after replay').toBe('alive')

    const exit = await exitPublicLaunch(owner, 'alias owner')
    expect(exit.text).toContain('Disconnected from dsh-pi-tui (daemon client).')
    expect(exit.text).toContain('The daemon Host was not stopped by this action.')
    expect(exit.text).toContain(`dsh --profile ${alias} --session ${sessionId}`)
    expect(exit.text).toContain('DSH_PI_TUI_BACKEND=daemon ')
    expect(exit.text).toContain(`dsh --profile ${alias} daemon status`)
    expect(exit.text).toContain(`dsh --profile ${alias} daemon logs`)
    expect(exit.text).toContain(`dsh --profile ${alias} daemon stop`)
    await owner.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the public alias/replay test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public alias/replay test cleanup failed')
    }
  }
})

test('persists the public daemon preference for the next launch without restarting the current Host', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const current = await scene.startPublicDaemon({ label: 'settings-current', backend: 'daemon' })
    launches.push(current)
    await waitForFrame(current, '❯', 'settings current composer')
    const before = await current.kernelState()
    const beforeStatus = await current.daemonStatus()
    expect(beforeStatus.fields.host).toBe('ready')

    await current.submit('/settings')
    await waitForFrame(current, 'Settings · Categories', 'Settings categories')
    await current.press('Down')
    await current.press('Enter')
    await waitForFrame(current, 'Settings · Host · Rows', 'Settings Host rows')
    await waitForFrame(current, '> Backend', 'the Backend row is focused')
    await current.press('Enter')
    await waitForFrame(current, 'Choose value', 'the Backend value chooser')
    await current.press('Down')
    // Wait for the actual focus transition before committing. Under a loaded
    // concurrent runner the key can otherwise arrive before the chooser has
    // applied the Down transition, leaving the chooser open.
    await waitForFrame(current, '> Daemon', 'the Daemon candidate focused')
    await current.press('Enter')
    // The optional OS-supervision prompt is a real platform representation on
    // macOS; Linux may write the preference directly. The transient
    // "Status Verified" row is not the durable fact: the authoritative Value
    // readback, the next-launch scope and the later real launch are.
    await waitForFrameMatch(current,
      frame => frame.includes('Value       Daemon') || frame.includes('> Not now'),
      'the authoritative backend readback or optional supervision prompt')
    const installFrame = await current.text()
    if (installFrame.includes('> Not now')) await current.press('Enter')
    await waitForFrame(current, 'Value       Daemon', 'the authoritative backend readback')
    await waitForFrame(current, 'Applies on next launch; current TUI/Host remains', 'the next-launch-only statement')
    await waitForFrame(current, 'Current launch: daemon (environment override)', 'the current launch override fact')

    const after = await current.kernelState()
    expect(after.hostPid, 'the current Host process was not restarted').toBe(before.hostPid)
    expect(after.clientPid, 'the current Client process was not restarted').toBe(before.clientPid)
    expect(after.hostState).toBe('alive')
    expect(after.clientState).toBe('alive')
    expect((await current.daemonStatus()).fields.host).toBe('ready')

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const frame = await current.text()
      if (frame.includes('❯') && !frame.includes('Settings')) break
      await current.press('Escape')
      await sleep(250)
    }
    await waitForFrame(current, '❯', 'Settings closed back to the chat')
    await exitPublicLaunch(current, 'settings current launch')
    await current.stopHost()

    const persisted = await scene.startPublicDaemon({ label: 'settings-persisted-daemon' })
    launches.push(persisted)
    expect(persisted.client, 'the saved Daemon preference starts a real Client without env').not.toBeNull()
    expect(persisted.host, 'the saved Daemon preference starts/attaches a real Host without env').not.toBeNull()
    await waitForFrame(persisted, '❯', 'the persisted daemon composer')
    expect((await persisted.daemonStatus()).fields.host).toBe('ready')
    await exitPublicLaunch(persisted, 'persisted daemon launch')
    await persisted.stopHost()

    const directOverride = await scene.startPublicDaemon({ label: 'settings-env-direct', backend: 'direct' })
    launches.push(directOverride)
    expect(directOverride.host, 'the Direct env override starts no Host').toBeNull()
    expect(directOverride.client, 'the Direct env override starts no Client').toBeNull()
    await waitForFrame(directOverride, '❯', 'the Direct env override composer')
    await exitPublicLaunch(directOverride, 'Direct env override')

    const persistedAgain = await scene.startPublicDaemon({ label: 'settings-persisted-daemon-again' })
    launches.push(persistedAgain)
    expect(persistedAgain.client, 'the Direct env override did not rewrite the saved Daemon preference').not.toBeNull()
    expect(persistedAgain.host, 'the persisted preference still starts a daemon Host').not.toBeNull()
    await waitForFrame(persistedAgain, '❯', 'the persisted daemon composer after the Direct override')
    await exitPublicLaunch(persistedAgain, 'persisted daemon after Direct')
    await persistedAgain.stopHost()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the Settings persistence test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the Settings persistence test cleanup failed')
    }
  }
})

test.skipIf(!ownershipRefusalProbe)(
  'refuses an unproven public Host ownership signal and compensates truthfully',
  async () => {
    const scene = await createSplitProcessScene()
    const launch = await scene.startPublicDaemon({
      label: 'ownership-refusal',
      backend: 'daemon',
    })
    expect(launch.ready).toBe(true)
    expect(launch.host).not.toBeNull()
    await scene.report('public-daemon-ownership-refused-ready', {
      workerPid: process.pid,
      launchId: launch.launchId,
      hostPid: launch.host?.pid,
      hostBirth: launch.host?.birth,
      instanceId: launch.host?.instanceId,
      cliPid: launch.cli?.pid,
      clientPid: launch.client?.pid,
    })
    // The external probe kills this Worker after it observed the live public
    // launch. Reaching this timer without a kill means the probe failed.
    await new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('public-daemon-ownership-refused: no external Worker kill arrived')), 180_000)
    })
  },
)
