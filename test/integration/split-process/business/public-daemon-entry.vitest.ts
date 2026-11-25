/**
 * Split-process public-entry business anchor.
 *
 * The ONLY evidence here is the REAL installed `dsh --profile …` CLI under a
 * native PTY, the product's own foreground Client, the detached public Host it
 * authenticates, the durable Session records and the public daemon management
 * commands. Nothing pre-starts a Host, injects an internal Client role or
 * reaches a private record sink: a public Client legitimately has none.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const linuxOnly = process.platform === 'linux'

async function frameText(launch: PublicDaemonLaunch): Promise<string> {
  return await launch.text()
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
  expect(exit.text, `${label}: the daemon detach line`).toContain('Disconnected from dsh-pi-tui (daemon client).')
  await launch.close()
  return exit
}

test.skipIf(!linuxOnly)('keeps the default Direct launch independent of the split backend', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    launch = await scene.startPublicDaemon({ label: 'direct-default', cols: 120, rows: 36 })
    expect(launch.ready, 'the default Direct launch reached a usable surface').toBe(true)
    expect(launch.host, 'a Direct launch owns no split Host').toBeNull()
    expect(launch.client, 'a Direct launch owns no split Client').toBeNull()
    expect(existsSync(join(scene.scopeDir, 'instance.json')),
      'a Direct launch published no split Host registry').toBe(false)
    await launch.type('direct default')
    await waitForFrame(launch, 'direct default', 'default Direct composer accepts input')
    await launch.press('Ctrl+U')
    await launch.submit('/exit')
    const exit = await launch.waitForExit(60_000)
    expect(exit.code, 'the default Direct CLI exit code').toBe(0)
    expect(exit.signal).toBe(null)
    await launch.close()
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
          'the default Direct test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the default Direct test cleanup failed')
    }
  }
})

test.skipIf(!linuxOnly)('refuses illegal public backend inputs before creating a split Host', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    for (const [label, backend] of [['refuse-wire-local', 'wire-local'], ['refuse-empty-env', '']] as const) {
      const before = await scene.sessionIds()
      launch = await scene.startPublicDaemon({ label, backend })
      expect(launch.refused, `${label}: the invalid backend was accepted`).toBe(true)
      expect(launch.exit, `${label}: the invalid backend produced a real exit`).not.toBeNull()
      expect(launch.exit?.code, `${label}: the invalid backend exit code`).not.toBe(0)
      expect(launch.host, `${label}: the invalid backend started a Host`).toBeNull()
      expect(launch.client, `${label}: the invalid backend started a Client`).toBeNull()
      expect(existsSync(join(scene.scopeDir, 'instance.json')),
        `${label}: the invalid backend published a Host registry`).toBe(false)
      expect(await scene.sessionIds(), `${label}: the invalid backend created a Session`).toEqual(before)
      await launch.close()
    }

    const headless = await scene.runPublicDaemonHeadless({ label: 'refuse-headless', backend: 'daemon' })
    expect(headless.exit.code, 'the non-TTY daemon launch exit code').not.toBe(0)
    expect(headless.text, `the non-TTY daemon refusal text (${headless.text})`).toMatch(/daemon|TTY|interactive/iu)
    expect(existsSync(join(scene.scopeDir, 'instance.json')),
      'the non-TTY daemon launch published no Host registry').toBe(false)

    const beforeMutual = await scene.sessionIds()
    launch = await scene.startPublicDaemon({
      label: 'refuse-session-and-continue',
      backend: 'daemon',
      args: {
        session: 'session-00000000-0000-0000-0000-000000000000',
        continue: true,
      },
    })
    expect(launch.refused, '--session and -c together must be refused by the product').toBe(true)
    expect(launch.exit?.code, 'the mutually exclusive launch exit code').not.toBe(0)
    expect(launch.host, 'the mutually exclusive launch started a Host').toBeNull()
    expect(existsSync(join(scene.scopeDir, 'instance.json')),
      'the mutually exclusive launch published a Host registry').toBe(false)
    expect(await scene.sessionIds(), 'the mutually exclusive launch created a Session').toEqual(beforeMutual)
    await launch.close()
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
          'the refusal test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the refusal test cleanup failed')
    }
  }
})

test.skipIf(!linuxOnly)('resumes a durable public Session through --session and -c without another Session', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let testError: unknown
  try {
    const seed = await scene.startPublicDaemon({ label: 'session-seed', backend: 'daemon' })
    launches.push(seed)
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await browser.press('Escape')
      await sleep(300)
      const frame = await browser.text()
      if (frame.includes('❯') && !frame.includes('Close [Esc]')) break
    }
    await waitForFrame(browser, '❯', 'the Session browser returned to the chat')
    expect([...(await scene.sessionIds())].sort(), 'the Session browser created no Session').toEqual(expectedSessions)
    await exitPublicLaunch(browser, 'public session browser')

    const continued = await scene.startPublicDaemon({
      label: 'session-continue',
      backend: 'daemon',
      args: { continue: true },
    })
    launches.push(continued)
    await waitForFrame(continued, 'public session seed', '-c resumed the same workspace history')
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

test.skipIf(!linuxOnly)('applies --preset minimal to the first public Session header', async () => {
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

test.skipIf(!linuxOnly)('keeps the surviving public peer and its Session after the other Client leaves', async () => {
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

    await first.signalCli()
    let cliGoneAt: number | undefined
    let clientGoneAt: number | undefined
    const started = Date.now()
    for (;;) {
      const state = await first.kernelState()
      if (cliGoneAt === undefined && (state.cliState === 'gone' || state.cliState === 'reused')) {
        cliGoneAt = Date.now()
      }
      if (clientGoneAt === undefined && (state.clientState === 'gone' || state.clientState === 'reused')) {
        clientGoneAt = Date.now()
      }
      if (cliGoneAt !== undefined && clientGoneAt !== undefined) break
      if (Date.now() - started >= 120_000) {
        throw new Error(`the TERM'd public CLI/Client did not reach terminal facts: ${JSON.stringify(state)}`)
      }
      await sleep(50)
    }
    expect(clientGoneAt, 'the foreground Client exits no later than its CLI settles').toBeLessThanOrEqual(cliGoneAt)
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
    await waitForFrame(second, 'stub answer', 'the surviving peer painted the new answer')

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

test.skipIf(!linuxOnly)('pins the public alias resume command and replays it against the live Host', async () => {
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

    const peer = await scene.startPublicDaemon({
      label: 'alias-peer',
      backend: 'daemon',
      alias,
      args: { session: sessionId },
    })
    launches.push(peer)
    await waitForFrame(peer, 'alias resume seed', 'the alias peer opened the same history')
    expect(peer.host?.instanceId).toBe(owner.host?.instanceId)

    const exit = await exitPublicLaunch(owner, 'alias owner')
    expect(exit.text).toContain('Disconnected from dsh-pi-tui (daemon client).')
    expect(exit.text).toContain('The daemon Host was not stopped by this action.')
    expect(exit.text).toContain(`dsh --profile ${alias} --session ${sessionId}`)
    expect(exit.text).toContain('DSH_PI_TUI_BACKEND=daemon ')
    expect(exit.text).toContain(`dsh --profile ${alias} daemon status`)
    expect(exit.text).toContain(`dsh --profile ${alias} daemon logs`)
    expect(exit.text).toContain(`dsh --profile ${alias} daemon stop`)
    expect((await peer.kernelState()).clientState, 'the peer Client is live before the replay').toBe('alive')

    const replay = await scene.startPublicDaemon({
      label: 'alias-resume-replay',
      alias,
      replayCommand: capturedResume,
    })
    launches.push(replay)
    await waitForFrame(replay, 'alias resume seed', 'the replayed resume command opened the exact history')
    expect(replay.host?.instanceId).toBe(owner.host?.instanceId)
    expect((await peer.kernelState()).clientState, 'the peer Client stays live during the replay').toBe('alive')
    await exitPublicLaunch(replay, 'alias replay')
    expect((await peer.kernelState()).clientState, 'the peer Client stays live after the replay').toBe('alive')
    await exitPublicLaunch(peer, 'alias peer')
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
          'the public alias/replay test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public alias/replay test cleanup failed')
    }
  }
})

test.skipIf(!linuxOnly)('starts one real public daemon Client and Host from the installed CLI', async () => {
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

    const stillRunning = await launch.daemonStatus()
    expect(stillRunning.fields.host, 'the Host survives the Client /exit').toBe('ready')

    await exitPublicLaunch(launch, 'public cold launch')
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

const ownershipRefusalProbe = process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-ownership-refused'

test.skipIf(!linuxOnly || !ownershipRefusalProbe)(
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


test.skipIf(!linuxOnly)('__debug_settings_frames', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  try {
    launch = await scene.startPublicDaemon({ label: 'debug-settings', backend: 'daemon' })
    await waitForFrame(launch, '❯', 'debug composer')
    await launch.submit('/settings')
    await sleep(1200)
    await launch.press('Down')
    await launch.press('Enter')
    await sleep(800)
    console.log(`DEBUG_SETTINGS_HOST\n${(await launch.text()).slice(-2600)}`)
    await launch.press('Enter')
    await sleep(600)
    console.log(`DEBUG_SETTINGS_EDIT_0\n${(await launch.text()).slice(-2600)}`)
    await launch.press('Down')
    await sleep(350)
    console.log(`DEBUG_SETTINGS_EDIT_1\n${(await launch.text()).slice(-2600)}`)
    await launch.press('Enter')
    await sleep(600)
    console.log(`DEBUG_SETTINGS_EDIT_2\n${(await launch.text()).slice(-2600)}`)
    await launch.press('Enter')
    await sleep(1500)
    console.log(`DEBUG_SETTINGS_EDIT_3\n${(await launch.text()).slice(-2600)}`)
    await sleep(1500)
    console.log(`DEBUG_SETTINGS_EDIT_4\n${(await launch.text()).slice(-2600)}`)
  } finally {
    if (launch !== undefined && !launch.closed) await launch.reclaim().catch(() => undefined)
    await scene.dispose().catch(() => undefined)
  }
})
